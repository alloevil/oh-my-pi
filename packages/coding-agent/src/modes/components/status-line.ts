import * as fs from "node:fs";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatCount } from "@oh-my-pi/pi-utils";
import type { Backend, ShellBackend } from "../../backend";
import { settings } from "../../config/settings";
import type { StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { calculatePromptTokens } from "../../session/compaction/compaction";
import * as git from "../../utils/git";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../utils/session-color";
import { sanitizeStatusText } from "../shared";
import {
	canReuseCachedPr,
	createPrCacheContext,
	isSamePrCacheContext,
	type PrCacheContext,
} from "./status-line/git-utils";
import { getPreset } from "./status-line/presets";
import { renderSegment, type SegmentContext } from "./status-line/segments";
import { getSeparator } from "./status-line/separators";
import { calculateTokensPerSecond } from "./status-line/token-rate";

function getBackendFromTool(tool: AgentTool | undefined, seen = new Set<AgentTool>()): Backend | undefined {
	if (!tool || seen.has(tool)) return undefined;
	seen.add(tool);
	const session = (tool as { session?: { backend: Backend } }).session;
	if (session) return session.backend;
	const wrappedTool = (tool as { tool?: AgentTool }).tool;
	return getBackendFromTool(wrappedTool, seen);
}

export interface StatusLineSegmentOptions {
	model?: { showThinkingLevel?: boolean };
	path?: { abbreviate?: boolean; maxLength?: number; stripWorkPrefix?: boolean };
	git?: { showBranch?: boolean; showStaged?: boolean; showUnstaged?: boolean; showUntracked?: boolean };
	time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export interface StatusLineSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	showHookStatus?: boolean;
	sessionAccent?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Rendering Helpers
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

export class StatusLineComponent implements Component {
	#settings: StatusLineSettings = {};
	#cachedBranch: string | null | undefined = undefined;
	#cachedBranchRepoId: string | null | undefined = undefined;
	#gitWatcher: fs.FSWatcher | null = null;
	#onBranchChange: (() => void) | null = null;
	#autoCompactEnabled: boolean = true;
	#hookStatuses: Map<string, string> = new Map();
	#subagentCount: number = 0;
	#sessionStartTime: number = Date.now();
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#loopModeStatus: { enabled: boolean } | null = null;

	// Git status caching (1s TTL)
	#cachedGitStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	#gitStatusLastFetch = 0;
	#gitStatusInFlight = false;
	#branchLastFetch = 0;
	#branchInFlight = false;

	// PR lookup caching (invalidated on branch/repo context changes)
	#cachedPr: { number: number; url: string } | null | undefined = undefined;
	#cachedPrContext: PrCacheContext | undefined = undefined;
	#prLookupInFlight = false;
	#defaultBranch?: string;
	#defaultBranchRepoId: string | null | undefined = undefined;
	#lastTokensPerSecond: number | null = null;
	#lastTokensPerSecondTimestamp: number | null = null;
	#connectedSession: boolean;
	#cachedShellBackend: ShellBackend | undefined = undefined;

	constructor(private readonly session: AgentSession) {
		this.#connectedSession = this.session.sessionManager.getConnectedSessionContext() !== undefined;
		this.#settings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			segmentOptions: settings.getGroup("statusLine").segmentOptions,
			sessionAccent: settings.get("statusLine.sessionAccent"),
		};
	}

	updateSettings(settings: StatusLineSettings): void {
		this.#settings = settings;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	setSubagentCount(count: number): void {
		this.#subagentCount = count;
	}

	setSessionStartTime(time: number): void {
		this.#sessionStartTime = time;
	}

	setPlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#planModeStatus = status ?? null;
	}

	setLoopModeStatus(status: { enabled: boolean } | undefined): void {
		this.#loopModeStatus = status ?? null;
	}

	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#hookStatuses.delete(key);
		} else {
			this.#hookStatuses.set(key, text);
		}
	}

	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	#setupGitWatcher(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}

		if (this.#isConnectedSession()) return;

		const gitHeadPath = git.repo.resolveSync(this.#executionCwd())?.headPath ?? null;
		if (!gitHeadPath) return;

		try {
			this.#gitWatcher = fs.watch(gitHeadPath, () => {
				this.#invalidateGitCaches();
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			});
		} catch {
			this.#invalidateGitCaches();
		}
	}

	dispose(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}
	}

	invalidate(): void {
		this.#invalidateGitCaches();
	}

	#invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedPrContext = undefined;
		this.#defaultBranch = undefined;
		this.#defaultBranchRepoId = undefined;
		this.#branchLastFetch = 0;
	}

	#executionCwd(): string {
		return this.session.sessionManager.getCwd();
	}

	#isConnectedSession(): boolean {
		return this.#connectedSession;
	}

	#shellBackend(): ShellBackend | undefined {
		if (this.#cachedShellBackend) return this.#cachedShellBackend;
		for (const name of this.session.getAllToolNames()) {
			const backend = getBackendFromTool(this.session.getToolByName(name));
			if (backend?.shell) {
				this.#cachedShellBackend = backend.shell;
				return backend.shell;
			}
		}
		return undefined;
	}

	#gitOptions(): git.GitShellOptions | undefined {
		if (!this.#isConnectedSession()) return undefined;
		const shell = this.#shellBackend();
		return shell ? { shell } : undefined;
	}

	#getLocalBranch(): string | null {
		const head = git.head.resolveSync(this.#executionCwd());
		const gitHeadPath = head?.headPath ?? null;
		if (this.#cachedBranch !== undefined && this.#cachedBranchRepoId === gitHeadPath) {
			return this.#cachedBranch;
		}

		this.#cachedBranchRepoId = gitHeadPath;
		if (!head) {
			this.#cachedBranch = null;
			return null;
		}

		this.#cachedBranch = head.kind === "ref" ? (head.branchName ?? head.ref) : "detached";

		return this.#cachedBranch ?? null;
	}

	#getAsyncBranch(): string | null {
		const options = this.#gitOptions();
		if (!options) {
			this.#cachedBranch = null;
			this.#cachedBranchRepoId = null;
			this.#branchLastFetch = Date.now();
			return null;
		}

		const staleBranch = this.#cachedBranch ?? null;
		if (this.#branchInFlight || Date.now() - this.#branchLastFetch < 1000) {
			return staleBranch;
		}

		this.#branchInFlight = true;
		const cwd = this.#executionCwd();

		(async () => {
			try {
				const head = await git.head.resolve(cwd, options);
				if (this.#executionCwd() !== cwd) return;
				this.#cachedBranchRepoId = head?.headPath ?? null;
				this.#cachedBranch = head ? (head.kind === "ref" ? (head.branchName ?? head.ref) : "detached") : null;
			} catch {
				if (this.#executionCwd() !== cwd) return;
				this.#cachedBranch = null;
				this.#cachedBranchRepoId = null;
			} finally {
				if (this.#executionCwd() === cwd) {
					this.#branchLastFetch = Date.now();
					this.#branchInFlight = false;
					if (this.#onBranchChange) {
						this.#onBranchChange();
					}
				} else {
					this.#branchInFlight = false;
				}
			}
		})();

		return staleBranch;
	}

	#getCurrentBranch(): string | null {
		return this.#isConnectedSession() ? this.#getAsyncBranch() : this.#getLocalBranch();
	}

	#isDefaultBranch(branch: string): boolean {
		const repoId = this.#cachedBranchRepoId ?? null;
		if (this.#defaultBranchRepoId !== repoId) {
			this.#defaultBranchRepoId = repoId;
			this.#defaultBranch = undefined;
		}
		if (this.#defaultBranch === undefined) {
			this.#defaultBranch = "main";
			const cwd = this.#executionCwd();
			const options = this.#gitOptions();
			if (this.#isConnectedSession() && !options) return branch === this.#defaultBranch;
			(async () => {
				try {
					const resolved = await git.branch.default(cwd, options);
					if (this.#executionCwd() !== cwd || this.#defaultBranchRepoId !== repoId) return;
					if (resolved) {
						this.#defaultBranch = resolved;
						if (this.#onBranchChange) {
							this.#onBranchChange();
						}
					}
				} catch {
					// Keep the optimistic "main" default.
				}
			})();
		}
		return branch === this.#defaultBranch;
	}

	#getGitStatus(): { staged: number; unstaged: number; untracked: number } | null {
		if (this.#gitStatusInFlight || Date.now() - this.#gitStatusLastFetch < 1000) {
			return this.#cachedGitStatus;
		}

		this.#gitStatusInFlight = true;
		const cwd = this.#executionCwd();
		const options = this.#gitOptions();
		if (this.#isConnectedSession() && !options) {
			this.#cachedGitStatus = null;
			this.#gitStatusLastFetch = Date.now();
			this.#gitStatusInFlight = false;
			return null;
		}

		(async () => {
			try {
				this.#cachedGitStatus = await git.status.summary(cwd, options);
			} catch {
				this.#cachedGitStatus = null;
			} finally {
				if (this.#executionCwd() === cwd) {
					this.#gitStatusLastFetch = Date.now();
				}
				this.#gitStatusInFlight = false;
			}
		})();

		return this.#cachedGitStatus;
	}

	#lookupPr(): { number: number; url: string } | null {
		const branch = this.#getCurrentBranch();
		const currentContext = branch ? createPrCacheContext(branch, this.#cachedBranchRepoId ?? null) : null;

		if (canReuseCachedPr(this.#cachedPr, this.#cachedPrContext, currentContext)) {
			return this.#cachedPr ?? null;
		}

		const stalePr = this.#cachedPr;

		// Don't look up if no branch, detached HEAD, default branch, or already in flight
		if (!branch || branch === "detached" || this.#isDefaultBranch(branch) || this.#prLookupInFlight) {
			return stalePr ?? null;
		}

		this.#prLookupInFlight = true;
		const lookupContext = currentContext;
		const cwd = this.#executionCwd();
		const options = this.#gitOptions();
		if (this.#isConnectedSession() && !options) {
			this.#prLookupInFlight = false;
			return stalePr ?? null;
		}

		// Fire async lookup, keep stale value visible until resolved
		(async () => {
			// Helper: only write cache if branch/repo context hasn't changed since launch
			const setCachedPr = (value: { number: number; url: string } | null) => {
				const latestBranch = this.#getCurrentBranch();
				const latestContext = latestBranch
					? createPrCacheContext(latestBranch, this.#cachedBranchRepoId ?? null)
					: undefined;
				if (lookupContext && isSamePrCacheContext(latestContext, lookupContext)) {
					this.#cachedPr = value;
					this.#cachedPrContext = lookupContext;
				}
			};
			try {
				// Requires `gh repo set-default` to be configured; fails gracefully if not
				const result = await git.github.run(cwd, ["pr", "view", "--json", "number,url"], undefined, options);
				if (result.exitCode !== 0) {
					setCachedPr(null);
					return;
				}
				const pr = JSON.parse(result.stdout) as { number: number; url: string };
				if (typeof pr.number === "number") {
					setCachedPr({ number: pr.number, url: pr.url });
				} else {
					setCachedPr(null);
				}
			} catch {
				setCachedPr(null);
			} finally {
				this.#prLookupInFlight = false;
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			}
		})();

		return stalePr ?? null;
	}

	#getTokensPerSecond(): number | null {
		let lastAssistantTimestamp: number | null = null;
		for (let i = this.session.state.messages.length - 1; i >= 0; i--) {
			const message = this.session.state.messages[i];
			if (message?.role === "assistant") {
				lastAssistantTimestamp = message.timestamp;
				break;
			}
		}

		if (lastAssistantTimestamp === null) {
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondTimestamp = null;
			return null;
		}

		const rate = calculateTokensPerSecond(this.session.state.messages, this.session.isStreaming);
		if (rate !== null) {
			this.#lastTokensPerSecond = rate;
			this.#lastTokensPerSecondTimestamp = lastAssistantTimestamp;
			return rate;
		}

		if (this.#lastTokensPerSecondTimestamp === lastAssistantTimestamp) {
			return this.#lastTokensPerSecond;
		}

		return null;
	}

	#buildSegmentContext(width: number): SegmentContext {
		const state = this.session.state;

		// Get usage statistics
		const aggregateUsageStats = this.session.sessionManager?.getUsageStatistics() ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
		};
		const usageStats = {
			...aggregateUsageStats,
			tokensPerSecond: this.#getTokensPerSecond(),
		};

		// Get context percentage
		const lastAssistantMessage = state.messages
			.slice()
			.reverse()
			.find(m => m.role === "assistant" && m.stopReason !== "aborted") as AssistantMessage | undefined;

		const contextTokens = lastAssistantMessage ? calculatePromptTokens(lastAssistantMessage.usage) : 0;
		const contextWindow = state.model?.contextWindow || 0;
		const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

		return {
			session: this.session,
			width,
			options: this.#resolveSettings().segmentOptions ?? {},
			planMode: this.#planModeStatus,
			loopMode: this.#loopModeStatus,
			usageStats,
			contextPercent,
			contextWindow,
			autoCompactEnabled: this.#autoCompactEnabled,
			subagentCount: this.#subagentCount,
			sessionStartTime: this.#sessionStartTime,
			git: {
				branch: this.#getCurrentBranch(),
				status: this.#getGitStatus(),
				pr: this.#lookupPr(),
			},
		};
	}

	#resolveSettings(): Required<
		Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "separator" | "segmentOptions">
	> &
		StatusLineSettings {
		const preset = this.#settings.preset ?? "default";
		const presetDef = getPreset(preset);
		const useCustomSegments = preset === "custom";
		const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};

		for (const [segment, options] of Object.entries(presetDef.segmentOptions ?? {})) {
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
		}

		for (const [segment, options] of Object.entries(this.#settings.segmentOptions ?? {})) {
			const current = mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] ?? {};
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = {
				...(current as Record<string, unknown>),
				...(options as Record<string, unknown>),
			};
		}

		const leftSegments = useCustomSegments
			? (this.#settings.leftSegments ?? presetDef.leftSegments)
			: presetDef.leftSegments;
		const rightSegments = useCustomSegments
			? (this.#settings.rightSegments ?? presetDef.rightSegments)
			: presetDef.rightSegments;

		return {
			...this.#settings,
			leftSegments,
			rightSegments,
			separator: this.#settings.separator ?? presetDef.separator,
			segmentOptions: mergedSegmentOptions,
		};
	}

	#buildStatusLine(width: number): string {
		const ctx = this.#buildSegmentContext(width);
		const effectiveSettings = this.#resolveSettings();
		const separatorDef = getSeparator(effectiveSettings.separator ?? "powerline-thin", theme);

		const bgAnsi = theme.getBgAnsi("statusLineBg");
		const fgAnsi = theme.getFgAnsi("text");
		const sepAnsi = theme.getFgAnsi("statusLineSep");

		// Collect visible segment contents
		const leftParts: string[] = [];
		const leftSegIds: StatusLineSegmentId[] = [];
		for (const segId of effectiveSettings.leftSegments) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				leftParts.push(rendered.content);
				leftSegIds.push(segId);
			}
		}

		const rightParts: string[] = [];
		for (const segId of effectiveSettings.rightSegments) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				rightParts.push(rendered.content);
			}
		}

		const runningBackgroundJobs = this.session.getAsyncJobSnapshot()?.running.length ?? 0;
		if (runningBackgroundJobs > 0) {
			const icon = theme.icon.agents ? `${theme.icon.agents} ` : "";
			const label = `${formatCount("job", runningBackgroundJobs)} running`;
			rightParts.push(theme.fg("statusLineSubagents", `${icon}${label}`));
		}
		const topFillWidth = Math.max(0, width);
		const left = [...leftParts];
		const right = [...rightParts];

		const leftSepWidth = visibleWidth(separatorDef.left);
		const rightSepWidth = visibleWidth(separatorDef.right);
		const leftCapWidth = separatorDef.endCaps ? visibleWidth(separatorDef.endCaps.right) : 0;
		const rightCapWidth = separatorDef.endCaps ? visibleWidth(separatorDef.endCaps.left) : 0;

		const groupWidth = (parts: string[], capWidth: number, sepWidth: number): number => {
			if (parts.length === 0) return 0;
			const partsWidth = parts.reduce((sum, part) => sum + visibleWidth(part), 0);
			const sepTotal = Math.max(0, parts.length - 1) * (sepWidth + 2);
			return partsWidth + sepTotal + 2 + capWidth;
		};

		let leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
		let rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
		const totalWidth = () => leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);

		if (topFillWidth > 0) {
			while (totalWidth() > topFillWidth && right.length > 0) {
				right.pop();
				rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
			}
			// Shrink path before dropping left segments — path is the only elastic segment
			const pathIdx = leftSegIds.indexOf("path");
			if (pathIdx >= 0 && totalWidth() > topFillWidth) {
				const overflow = totalWidth() - topFillWidth;
				const currentPathVW = visibleWidth(left[pathIdx]);
				const minPathVW = 8; // icon + ellipsis + a few chars
				const shrinkable = currentPathVW - minPathVW;
				if (shrinkable > 0) {
					const shrinkBy = Math.min(shrinkable, overflow);
					const currentMaxLen = ctx.options.path?.maxLength ?? 40;
					let newMaxLen = Math.max(4, Math.min(currentMaxLen, currentPathVW) - shrinkBy);
					const pathCtx = (maxLen: number): SegmentContext => ({
						...ctx,
						options: { ...ctx.options, path: { ...ctx.options.path, maxLength: maxLen } },
					});
					let reRendered = renderSegment("path", pathCtx(newMaxLen));
					if (reRendered.visible && reRendered.content) {
						// maxLength governs path text, not icon prefix; iterate to compensate
						for (let i = 0; i < 8; i++) {
							const saved = currentPathVW - visibleWidth(reRendered.content);
							if (saved >= shrinkBy) break;
							const nextMaxLen = Math.max(4, newMaxLen - (shrinkBy - saved));
							if (nextMaxLen >= newMaxLen) break; // no progress or hit floor
							newMaxLen = nextMaxLen;
							const adjusted = renderSegment("path", pathCtx(newMaxLen));
							if (!adjusted.visible || !adjusted.content) break;
							reRendered = adjusted;
						}
						left[pathIdx] = reRendered.content;
						leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
					}
				}
			}
			while (totalWidth() > topFillWidth && left.length > 0) {
				left.pop();
				leftSegIds.pop();
				leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
			}
		}

		const renderGroup = (parts: string[], direction: "left" | "right"): string => {
			if (parts.length === 0) return "";
			const sep = direction === "left" ? separatorDef.left : separatorDef.right;
			const cap = separatorDef.endCaps
				? direction === "left"
					? separatorDef.endCaps.right
					: separatorDef.endCaps.left
				: "";
			const capPrefix = separatorDef.endCaps?.useBgAsFg ? bgAnsi.replace("\x1b[48;", "\x1b[38;") : bgAnsi + sepAnsi;
			const capText = cap ? `${capPrefix}${cap}\x1b[0m` : "";

			let content = bgAnsi + fgAnsi;
			content += ` ${parts.join(` ${sepAnsi}${sep}${fgAnsi} `)} `;
			content += "\x1b[0m";

			if (capText) {
				return direction === "right" ? capText + content : content + capText;
			}
			return content;
		};

		const leftGroup = renderGroup(left, "left");
		const rightGroup = renderGroup(right, "right");
		if (!leftGroup && !rightGroup) return "";

		if (topFillWidth === 0 || left.length === 0 || right.length === 0) {
			return leftGroup + (leftGroup && rightGroup ? " " : "") + rightGroup;
		}

		leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
		rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
		const gapWidth = Math.max(1, topFillWidth - leftWidth - rightWidth);
		const sessionName =
			effectiveSettings.sessionAccent !== false ? this.session.sessionManager?.getSessionName() : undefined;
		const accentHex = sessionName ? getSessionAccentHex(sessionName) : undefined;
		const gapColor = getSessionAccentAnsi(accentHex) ?? theme.getFgAnsi("border");
		const gapFill = `${gapColor}${theme.boxRound.horizontal.repeat(gapWidth)}\x1b[39m`;
		return leftGroup + gapFill + rightGroup;
	}

	getTopBorder(width: number): { content: string; width: number } {
		const content = this.#buildStatusLine(width);
		return {
			content,
			width: visibleWidth(content),
		};
	}

	render(width: number): string[] {
		// Only render hook statuses - main status is in editor's top border
		const showHooks = this.#settings.showHookStatus ?? true;
		if (!showHooks || this.#hookStatuses.size === 0) {
			return [];
		}

		const sortedStatuses = Array.from(this.#hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const hookLine = sortedStatuses.join(" ");
		return [truncateToWidth(hookLine, width)];
	}
}
