import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { Backend, StatResult } from "../backend";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import findDescription from "../prompts/tools/find.md" with { type: "text" };
import { type TruncationResult, truncateHead } from "../session/streaming-output";
import {
	Ellipsis,
	Hasher,
	type RenderCache,
	renderFileList,
	renderStatusLine,
	renderTreeList,
	truncateToWidth,
} from "../tui";
import type { ToolSession } from ".";
import { applyListLimit } from "./list-limit";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import {
	formatPathRelativeToCwd,
	normalizePathLikeInput,
	parseFindPattern,
	resolveExplicitFindPatterns,
	resolveToCwd,
} from "./path-utils";
import { formatCount, formatEmptyMessage, formatErrorMessage, PREVIEW_LIMITS } from "./render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const findSchema = Type.Object({
	paths: Type.Array(Type.String({ description: "glob including search path" }), {
		minItems: 1,
		description: "globs including search paths",
		examples: [["src/**/*.ts"], ["lib/*.json"], ["apps/", "packages/"], ["*.ts"]],
	}),
	hidden: Type.Optional(Type.Boolean({ description: "include hidden files", default: true })),
	limit: Type.Optional(Type.Number({ description: "max results", default: 1000 })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;
const GLOB_TIMEOUT_MS = 5000;

const ROOT_SCOPE_UPDATE_INTERVAL = 100;
type StatWithLinkKind = StatResult & { linkKind?: "symlink" };
export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
	/** User-supplied paths whose base directory was missing on the active backend. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (e.g., SSH).
 */
export interface FindOperationCallOptions {
	hidden: boolean;
	gitignore: boolean;
	ignore: string[];
	limit: number;
	signal: AbortSignal;
}

export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string, options: { signal: AbortSignal }) => Promise<boolean> | boolean;
	/** Optional stat for distinguishing files vs directories. */
	stat?: (
		absolutePath: string,
		options: { signal: AbortSignal },
	) => Promise<{ isFile(): boolean; isDirectory(): boolean }> | { isFile(): boolean; isDirectory(): boolean };
	/** Find files matching glob pattern. Returns relative paths or absolute paths within cwd scope. */
	glob: (pattern: string, cwd: string, options: FindOperationCallOptions) => Promise<string[]> | string[];
}

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem + rg */
	operations?: FindOperations;
}

interface FindInputProbe {
	raw: string;
	absoluteBasePath: string;
	glob?: Bun.Glob;
	matched: boolean;
}

function normalizeProbePath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function relativePathWithin(basePath: string, filePath: string): string | undefined {
	const relative = path.relative(basePath, filePath);
	if (relative === "") return ".";
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return undefined;
	}
	return normalizeProbePath(relative);
}

function createFindInputProbe(rawPattern: string, cwd: string): FindInputProbe {
	const parsedPattern = parseFindPattern(rawPattern);
	return {
		raw: rawPattern,
		absoluteBasePath: resolveToCwd(parsedPattern.basePath, cwd),
		glob: parsedPattern.hasGlob ? new Bun.Glob(normalizeProbePath(parsedPattern.globPattern)) : undefined,
		matched: false,
	};
}

function markFindProbeMatches(probes: FindInputProbe[], entries: Array<{ path: string }>, cwd: string): void {
	if (probes.length === 0 || entries.length === 0) return;
	for (const entry of entries) {
		const absoluteEntryPath = path.isAbsolute(entry.path) ? entry.path : path.resolve(cwd, entry.path);
		for (const probe of probes) {
			if (probe.matched) continue;
			const relative = relativePathWithin(probe.absoluteBasePath, absoluteEntryPath);
			if (relative === undefined) continue;
			if (!probe.glob || probe.glob.match(relative === "." ? path.basename(absoluteEntryPath) : relative)) {
				probe.matched = true;
			}
		}
	}
}

function isPathNotFoundError(error: unknown): boolean {
	return isEnoent(error) || (error instanceof Error && /(?:Path not found|ENOENT|not found)/i.test(error.message));
}

export class FindTool implements AgentTool<typeof findSchema, FindToolDetails> {
	readonly name = "find";
	readonly summary = "Find files and directories matching a glob pattern";
	readonly loadMode = "discoverable";
	readonly label = "Find";
	readonly description: string;
	readonly parameters = findSchema;
	readonly strict = true;

	readonly #customOps?: FindOperations;

	constructor(
		private readonly session: ToolSession,
		options?: FindToolOptions,
	) {
		this.#customOps = options?.operations;
		this.description = prompt.render(findDescription);
	}

	async execute(
		_toolCallId: string,
		params: Static<typeof findSchema>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<FindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<FindToolDetails>> {
		const { paths, limit, hidden } = params;

		return untilAborted(signal, async () => {
			const formatScopePath = (targetPath: string): string => formatPathRelativeToCwd(targetPath, this.session.cwd);
			const normalizedPatterns = paths.map(input => normalizePathLikeInput(input).replace(/\\/g, "/"));
			if (normalizedPatterns.some(pattern => pattern.length === 0)) {
				throw new ToolError("`paths` must contain non-empty globs or paths");
			}
			const backend: Backend = this.session.backend;
			const getBackend = (): Backend => backend;

			// Tolerate missing entries in a multi-path call after the backend glob
			// primitive has resolved the inputs. Single missing paths keep the original
			// ENOENT semantics — the user explicitly asked about that one path, so
			// silent empty results would be misleading.
			const isMultiPatternInput = normalizedPatterns.length > 1 && !this.#customOps;
			let missingPaths: string[] = [];
			const findInputProbes = isMultiPatternInput
				? normalizedPatterns.map(pattern => createFindInputProbe(pattern, this.session.cwd))
				: [];

			const multiPattern =
				normalizedPatterns.length > 1
					? await resolveExplicitFindPatterns(normalizedPatterns, this.session.cwd)
					: undefined;
			const parsedPattern = multiPattern ? null : parseFindPattern(normalizedPatterns[0] ?? ".");
			const hasGlob = multiPattern ? true : (parsedPattern?.hasGlob ?? false);
			const globPattern = multiPattern?.globPattern ?? parsedPattern?.globPattern ?? "**/*";
			const searchPath = resolveToCwd(multiPattern?.basePath ?? parsedPattern?.basePath ?? ".", this.session.cwd);
			const scopePath = multiPattern?.scopePath ?? formatScopePath(searchPath);

			if (searchPath === "/") {
				throw new ToolError("Searching from root directory '/' is not allowed");
			}
			const rawLimit = limit ?? DEFAULT_LIMIT;
			const effectiveLimit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : Number.NaN;
			if (!Number.isFinite(effectiveLimit) || effectiveLimit <= 0) {
				throw new ToolError("Limit must be a positive number");
			}
			const includeHidden = hidden ?? true;
			const timeoutSignal = AbortSignal.timeout(GLOB_TIMEOUT_MS);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const timeoutSeconds = Math.max(1, Math.round(GLOB_TIMEOUT_MS / 1000));
			const runDelegatedOp = async <T>(operation: (delegateSignal: AbortSignal) => Promise<T>): Promise<T> => {
				throwIfAborted(signal);
				const controller = new AbortController();
				return await new Promise<T>((resolve, reject) => {
					let settled = false;
					const finish = (callback: () => void): void => {
						if (settled) {
							return;
						}
						settled = true;
						cleanup();
						callback();
					};
					const onAbort = (): void => {
						controller.abort(signal?.reason);
						finish(() => reject(new ToolAbortError()));
					};
					const timeoutId = setTimeout(() => {
						controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
						finish(() => reject(new ToolError(`find timed out after ${timeoutSeconds}s`)));
					}, GLOB_TIMEOUT_MS);
					const cleanup = (): void => {
						clearTimeout(timeoutId);
						signal?.removeEventListener("abort", onAbort);
					};

					signal?.addEventListener("abort", onAbort, { once: true });
					void Promise.resolve()
						.then(() => operation(controller.signal))
						.then(
							value => finish(() => resolve(value)),
							error => finish(() => reject(error)),
						);
				});
			};
			const formatMatchPath = (
				matchPath: string,
				fileType?: "file" | "dir" | "symlink" | "other",
				basePath = searchPath,
			): string => {
				const hadTrailingSlash = matchPath.endsWith("/") || matchPath.endsWith("\\");
				const absolutePath = path.isAbsolute(matchPath) ? matchPath : path.resolve(basePath, matchPath);
				return formatPathRelativeToCwd(absolutePath, this.session.cwd, {
					trailingSlash: fileType === "dir" || hadTrailingSlash,
				});
			};
			const rootRelativeSearchPath = path.relative(this.session.cwd, searchPath).replaceAll("\\", "/") || ".";
			const normalizedRequestedRoot = path.normalize(rootRelativeSearchPath);
			const normalizeScopedEntryPath = (entryPath: string): string | null => {
				if (path.isAbsolute(entryPath)) {
					return null;
				}

				const normalizedEntryPath = path.normalize(entryPath);
				if (normalizedEntryPath === ".." || normalizedEntryPath.startsWith(`..${path.sep}`)) {
					return null;
				}

				return normalizedEntryPath === "" ? "." : normalizedEntryPath;
			};
			const isWithinRequestedRoot = (entryPath: string): boolean => {
				const normalizedEntryPath = normalizeScopedEntryPath(entryPath);
				if (!normalizedEntryPath) {
					return false;
				}

				if (normalizedRequestedRoot === ".") {
					return true;
				}

				return (
					normalizedEntryPath === normalizedRequestedRoot ||
					normalizedEntryPath.startsWith(`${normalizedRequestedRoot}${path.sep}`)
				);
			};

			let lastPartialResultCount = 0;
			const emitPartialResults = (files: string[], force = false): void => {
				if (!onUpdate || files.length === 0) {
					return;
				}

				const shouldEmit = force
					? files.length !== lastPartialResultCount
					: files.length - lastPartialResultCount >= ROOT_SCOPE_UPDATE_INTERVAL;
				if (!shouldEmit) {
					return;
				}

				lastPartialResultCount = files.length;
				onUpdate({
					content: [{ type: "text", text: files.join("\n") }],
					details: {
						scopePath,
						fileCount: files.length,
						files: [...files],
						truncated: false,
						missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
					},
				});
			};

			const getMissingPathsNote = (): string | undefined =>
				missingPaths.length > 0 ? `Skipped missing paths: ${missingPaths.join(", ")}` : undefined;

			const buildResult = (files: string[], sourceTruncated = false): AgentToolResult<FindToolDetails> => {
				const missingPathsNote = getMissingPathsNote();
				if (files.length === 0) {
					const details: FindToolDetails = {
						scopePath,
						fileCount: 0,
						files: [],
						truncated: sourceTruncated,
						missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
					};
					const text = missingPathsNote
						? `No files found matching pattern\n${missingPathsNote}`
						: "No files found matching pattern";
					return toolResult(details).text(text).done();
				}

				const listLimit = applyListLimit(files, { limit: effectiveLimit });
				const limited = listLimit.items;
				const limitMeta = listLimit.meta;
				const baseOutput = limited.join("\n");
				const rawOutput = missingPathsNote ? `${baseOutput}\n\n${missingPathsNote}` : baseOutput;
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

				const details: FindToolDetails = {
					scopePath,
					fileCount: limited.length,
					files: limited,
					truncated: Boolean(sourceTruncated || limitMeta.resultLimit || truncation.truncated),
					resultLimitReached: limitMeta.resultLimit?.reached,
					truncation: truncation.truncated ? truncation : undefined,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
				};

				const resultBuilder = toolResult(details)
					.text(truncation.content)
					.limits({ resultLimit: limitMeta.resultLimit?.reached });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}

				return resultBuilder.done();
			};

			const customOps = this.#customOps;
			if (customOps?.glob) {
				if (
					!(await runDelegatedOp(delegateSignal =>
						Promise.resolve(customOps.exists(searchPath, { signal: delegateSignal })),
					))
				) {
					throw new ToolError(`Path not found: ${scopePath}`);
				}

				if (!hasGlob && customOps.stat) {
					const stat = await runDelegatedOp(delegateSignal =>
						Promise.resolve(customOps.stat?.(searchPath, { signal: delegateSignal })),
					);
					if (stat?.isFile()) {
						return buildResult([scopePath]);
					}
				}

				const results = await runDelegatedOp(delegateSignal =>
					Promise.resolve(
						customOps.glob(globPattern, searchPath, {
							hidden: includeHidden,
							gitignore: true,
							ignore: ["**/node_modules/**", "**/.git/**"],
							limit: effectiveLimit,
							signal: delegateSignal,
						}),
					),
				);
				const relativized = results
					.map(matchPath => {
						const absolutePath = path.isAbsolute(matchPath) ? matchPath : path.resolve(searchPath, matchPath);
						return path.relative(this.session.cwd, absolutePath);
					})
					.filter(relativePath => isWithinRequestedRoot(relativePath))
					.map(relativePath => formatMatchPath(relativePath, undefined, this.session.cwd));

				return buildResult(relativized);
			}

			const activeBackend = getBackend();
			const statWithFollow = async (targetPath: string, followSymlinks = false): Promise<StatWithLinkKind> => {
				return activeBackend.fs.stat(targetPath, { signal, followSymlinks }) as Promise<StatWithLinkKind>;
			};
			const statCache = new Map<string, StatWithLinkKind | null>();
			const statInputBase = async (targetPath: string): Promise<StatWithLinkKind | null> => {
				const cacheKey = path.resolve(targetPath);
				if (statCache.has(cacheKey)) return statCache.get(cacheKey) ?? null;
				try {
					const stat = await statWithFollow(targetPath, true);
					const cached = stat.exists ? stat : null;
					statCache.set(cacheKey, cached);
					return cached;
				} catch (err) {
					if (isEnoent(err)) {
						statCache.set(cacheKey, null);
						return null;
					}
					throw err;
				}
			};
			const collectMissingFindPaths = async (): Promise<string[]> => {
				const missing: string[] = [];
				for (const probe of findInputProbes) {
					if (probe.matched) continue;
					const stat = await statInputBase(probe.absoluteBasePath);
					if (!stat) missing.push(probe.raw);
				}
				return missing;
			};

			if (!multiPattern) {
				const searchStat = await statInputBase(searchPath);
				if (!searchStat) {
					throw new ToolError(`Path not found: ${scopePath}`);
				}

				if (!hasGlob && searchStat.kind === "file") {
					return buildResult([scopePath]);
				}
				if (searchStat.kind !== "dir") {
					throw new ToolError(`Path is not a directory: ${scopePath}`);
				}
			}

			let entries: Array<{ path: string; type: "file" | "dir" | "symlink" | "other" }>;
			let sourceTruncated = false;
			try {
				// backend.fs.glob currently resolves a full GlobResult rather than
				// streaming matches incrementally, so partial updates are emitted while
				// formatting the completed entry list below.
				const result = await untilAborted(combinedSignal, () =>
					backend.fs.glob({
						patterns: [globPattern],
						paths: [rootRelativeSearchPath],
						includeHidden,
						types: ["file"],
						limit: effectiveLimit,
						signal: combinedSignal,
					}),
				);
				const leakedEntries = result.entries.filter(entry => !isWithinRequestedRoot(entry.path));
				entries =
					leakedEntries.length === 0
						? result.entries
						: result.entries.filter(entry => isWithinRequestedRoot(entry.path));
				markFindProbeMatches(findInputProbes, entries, this.session.cwd);
				if (multiPattern) {
					missingPaths = await collectMissingFindPaths();
					if (missingPaths.length === findInputProbes.length) {
						throw new ToolError(`Path not found: ${missingPaths.join(", ")}`);
					}
				}
				sourceTruncated = result.truncated || leakedEntries.length > 0;
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					if (timeoutSignal.aborted && !signal?.aborted) {
						const timeoutSeconds = Math.max(1, Math.round(GLOB_TIMEOUT_MS / 1000));
						throw new ToolError(`find timed out after ${timeoutSeconds}s`);
					}
					throw new ToolAbortError();
				}
				if (multiPattern && isPathNotFoundError(error)) {
					entries = [];
					missingPaths = await collectMissingFindPaths();
					if (missingPaths.length === findInputProbes.length) {
						throw new ToolError(`Path not found: ${missingPaths.join(", ")}`);
					}
				} else {
					throw error;
				}
			}

			const relativized: string[] = [];
			for (const entry of entries) {
				throwIfAborted(signal);
				relativized.push(formatMatchPath(entry.path, entry.type, this.session.cwd));
				emitPartialResults(relativized);
			}
			emitPartialResults(relativized, true);

			return buildResult(relativized, sourceTruncated);
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface FindRenderArgs {
	paths?: string[];
	limit?: number;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

export const findToolRenderer = {
	inline: true,
	renderCall(args: FindRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Find", description: args.paths?.join(", ") || "*", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FindToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: FindRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage("No files found", uiTheme), 0, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					icon: "success",
					title: "Find",
					description: args?.paths?.join(", "),
					meta: [formatCount("file", lines.length)],
				},
				uiTheme,
			);
			let cached: RenderCache | undefined;
			return {
				render(width: number): string[] {
					const { expanded } = options;
					const key = new Hasher().bool(expanded).u32(width).digest();
					if (cached?.key === key) return cached.lines;
					const listLines = renderTreeList(
						{
							items: lines,
							expanded,
							maxCollapsed: COLLAPSED_LIST_LIMIT,
							itemType: "file",
							renderItem: line => uiTheme.fg("accent", line),
						},
						uiTheme,
					);
					const result = [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
					cached = { key, lines: result };
					return result;
				},
				invalidate() {
					cached = undefined;
				},
			};
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		const files = details?.files ?? [];

		const missingPaths = details?.missingPaths ?? [];
		const missingNote =
			missingPaths.length > 0 ? uiTheme.fg("warning", `skipped missing: ${missingPaths.join(", ")}`) : undefined;

		if (fileCount === 0) {
			const header = renderStatusLine(
				{ icon: "warning", title: "Find", description: args?.paths?.join(", "), meta: ["0 files"] },
				uiTheme,
			);
			const lines = [header, formatEmptyMessage("No files found", uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 0, 0);
		}
		const meta: string[] = [formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const header = renderStatusLine(
			{ icon: truncated ? "warning" : "success", title: "Find", description: args?.paths?.join(", "), meta },
			uiTheme,
		);

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) truncationReasons.push(`limit ${details.resultLimitReached} results`);
		if (limits?.resultLimit) truncationReasons.push(`limit ${limits.resultLimit.reached} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}
		if (missingNote) extraLines.push(missingNote);

		let cached: RenderCache | undefined;
		return {
			render(width: number): string[] {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;
				const fileLines = renderFileList(
					{
						files: files.map(entry => ({ path: entry, isDirectory: entry.endsWith("/") })),
						expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
					},
					uiTheme,
				);
				const result = [header, ...fileLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				cached = { key, lines: result };
				return result;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
