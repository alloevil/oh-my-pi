/**
 * Request-path degradation guards — the pure detection logic behind the
 * session health ledger's inline producers, plus the compact formatting
 * consumed by the status-line `health` segment and the session-end sentinel.
 *
 * Everything here is deterministic, allocation-light, and synchronous: the
 * callers sit on the prompt/rebuild hot path (see `SessionTools` and
 * `AgentSession`), so no I/O and no model calls. Wiring (when to observe,
 * which ledger) stays with the callers; this module only decides *whether*
 * something is a finding and how it renders.
 */

import type { HealthCounts, HealthFinding, HealthFindingInput, HealthLedger } from "./ledger";

/** Stable rule ids for the inline request-path guards. */
export const HEALTH_RULES = {
	promptSizeJump: "prompt-size-jump",
	duplicateDeviceRoutes: "duplicate-device-routes",
	silentModelSwitch: "silent-model-switch",
} as const;

/**
 * Record `input` on the ledger. The first time a rule reaches warn severity
 * its message is queued on the ledger for deferred notice delivery (the
 * session drains the queue at the next turn boundary, so the notice lands
 * beside the latest message instead of wherever the guard happened to fire).
 * Later refreshes of the same rule stay silent — the finding keeps
 * accumulating occurrences via `upsert`.
 */
export function recordHealthFinding(ledger: HealthLedger, input: HealthFindingInput): HealthFinding {
	const previous = ledger.findings().find(finding => finding.rule === input.rule);
	const wasWarn = previous?.severity === "warn";
	const finding = ledger.upsert(input);
	if (!wasWarn && finding.severity === "warn") ledger.queueNotice(finding.message);
	return finding;
}

// ═══════════════════════════════════════════════════════════════════════════
// prompt-size-jump
// ═══════════════════════════════════════════════════════════════════════════

/** Relative size change between consecutive rebuilds that trips the guard (strictly greater). */
export const PROMPT_SIZE_JUMP_RATIO = 0.25;

export interface PromptSizeJump {
	previousChars: number;
	currentChars: number;
	/** `|current - previous| / previous`. */
	ratio: number;
	direction: "grew" | "shrank";
}

/**
 * Flag a system-prompt rebuild whose total size moved more than `threshold`
 * relative to the previous rebuild. The first observation (no baseline) never
 * fires; neither does a change of exactly `threshold`.
 */
export function detectPromptSizeJump(
	previousChars: number | undefined,
	currentChars: number,
	threshold: number = PROMPT_SIZE_JUMP_RATIO,
): PromptSizeJump | null {
	if (previousChars === undefined || previousChars <= 0) return null;
	const ratio = Math.abs(currentChars - previousChars) / previousChars;
	if (ratio <= threshold) return null;
	return {
		previousChars,
		currentChars,
		ratio,
		direction: currentChars > previousChars ? "grew" : "shrank",
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// duplicate-device-routes
// ═══════════════════════════════════════════════════════════════════════════

/** Minimal structural view of a mounted MCP route (see `collectMountedMCPToolRoutes`). */
export interface DeviceRoute {
	/** Mounted `xd://` device name. */
	readonly name: string;
	readonly mcpServerName: string;
	readonly mcpToolName: string;
}

export interface DuplicateDeviceRoutes {
	/**
	 * `identity`: two device names alias the same `server/tool` pair.
	 * `tool-name`: the same original tool name is mounted from different servers.
	 */
	kind: "identity" | "tool-name";
	/** `server/tool` for identity collisions, the bare tool name for cross-server ones. */
	key: string;
	/** Colliding mounted device names in catalog order. */
	names: string[];
}

/**
 * Detect aliased or ambiguous mounted MCP routes. Identity collisions (same
 * server + tool under two device names) are reported once and do not
 * additionally count toward the cross-server tool-name check.
 */
export function detectDuplicateDeviceRoutes(routes: Iterable<DeviceRoute>): DuplicateDeviceRoutes[] {
	const byIdentity = new Map<string, { key: string; names: Set<string> }>();
	const byToolName = new Map<string, { servers: Set<string>; names: Set<string> }>();
	for (const route of routes) {
		const identityKey = `${route.mcpServerName}\u0000${route.mcpToolName}`;
		let identity = byIdentity.get(identityKey);
		if (!identity) {
			identity = { key: `${route.mcpServerName}/${route.mcpToolName}`, names: new Set() };
			byIdentity.set(identityKey, identity);
		}
		identity.names.add(route.name);

		let toolName = byToolName.get(route.mcpToolName);
		if (!toolName) {
			toolName = { servers: new Set(), names: new Set() };
			byToolName.set(route.mcpToolName, toolName);
		}
		toolName.servers.add(route.mcpServerName);
		toolName.names.add(route.name);
	}

	const duplicates: DuplicateDeviceRoutes[] = [];
	for (const identity of byIdentity.values()) {
		if (identity.names.size < 2) continue;
		duplicates.push({ kind: "identity", key: identity.key, names: [...identity.names] });
	}
	for (const [tool, group] of byToolName) {
		if (group.servers.size < 2) continue;
		duplicates.push({ kind: "tool-name", key: tool, names: [...group.names] });
	}
	return duplicates;
}

// ═══════════════════════════════════════════════════════════════════════════
// silent-model-switch
// ═══════════════════════════════════════════════════════════════════════════

export interface ModelIdentity {
	readonly provider: string;
	readonly id: string;
}

export interface SilentModelSwitch {
	/** `provider/id` the session is configured with. */
	configured: string;
	/** `provider/id` that actually produced the assistant message. */
	answered: string;
}

export function formatModelIdentity(model: ModelIdentity): string {
	return `${model.provider}/${model.id}`;
}

/**
 * True when the two ids differ only by a date-stamped snapshot suffix
 * (`gpt-4o` vs `gpt-4o-2024-08-06`). A non-date suffix (`gpt-5` vs
 * `gpt-5-mini`) is NOT an alias — that is exactly the downgrade this guard
 * exists to catch.
 */
function isSnapshotAlias(a: string, b: string): boolean {
	if (a.length === b.length) return false;
	const [short, long] = a.length < b.length ? [a, b] : [b, a];
	return long.startsWith(`${short}-`) && /^\d{4}/.test(long.slice(short.length + 1));
}

/**
 * Flag an assistant turn answered by a model other than the session's
 * configured one, unless a visible model change landed during the turn
 * (configured identity at turn start differs from configured identity now).
 */
export function detectSilentModelSwitch(
	configuredAtTurnStart: ModelIdentity | undefined,
	configured: ModelIdentity | undefined,
	answered: ModelIdentity | undefined,
): SilentModelSwitch | null {
	if (!configuredAtTurnStart || !configured || !answered?.id) return null;
	// The configured model moved mid-turn — that change was user-visible
	// (recorded as a model_change entry), so the mismatch is not silent.
	if (formatModelIdentity(configuredAtTurnStart) !== formatModelIdentity(configured)) return null;
	if (
		configured.provider === answered.provider &&
		(configured.id === answered.id || isSnapshotAlias(configured.id, answered.id))
	) {
		return null;
	}
	return { configured: formatModelIdentity(configured), answered: formatModelIdentity(answered) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Compact rendering (status-line badge, session-end sentinel)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compact status-bar badge: `⚠N` when any warn finding exists, `·N` for
 * info-only ledgers, and a quiet `✓` heartbeat when the ledger is empty —
 * distinguishing "healthy" from "monitor not running" (a missing ledger
 * renders nothing at the segment level).
 */
export function formatHealthBadge(counts: HealthCounts): string {
	if (counts.warn > 0) return `⚠${counts.warn}`;
	if (counts.info > 0) return `·${counts.info}`;
	return "✓";
}

/** One-line session-end summary; `null` when there is nothing to warn about. */
export function formatSessionEndHealthSummary(counts: HealthCounts): string | null {
	if (counts.warn === 0) return null;
	const noun = counts.warn === 1 ? "warning" : "warnings";
	return `health: ${counts.warn} ${noun} — run omp doctor for details`;
}

/**
 * Full findings report for the `/health` command: one line per finding
 * (warn first, then by recency), with occurrence counts and structured
 * details rendered compactly. Empty ledger reports the healthy heartbeat.
 */
export function formatHealthFindingsReport(findings: readonly HealthFinding[]): string {
	if (findings.length === 0) return "✓ no health findings this session";
	const ordered = [...findings].sort((a, b) =>
		a.severity === b.severity ? b.timestamp - a.timestamp : a.severity === "warn" ? -1 : 1,
	);
	const lines = ordered.map(finding => {
		const glyph = finding.severity === "warn" ? "⚠" : "·";
		const times = finding.occurrences > 1 ? ` ×${finding.occurrences}` : "";
		const details =
			finding.details && Object.keys(finding.details).length > 0 ? `\n    ${JSON.stringify(finding.details)}` : "";
		return `${glyph} ${finding.rule}${times} — ${finding.message}${details}`;
	});
	return lines.join("\n");
}
