import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { GlobResult, GrepHit, GrepSummary, StatResult } from "../backend/types";
import { getFileReadCache } from "../edit/file-read-cache";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import type { Theme } from "../modes/theme/theme";
import searchDescription from "../prompts/tools/search.md" with { type: "text" };
import { DEFAULT_MAX_COLUMN, type TruncationResult, truncateHead } from "../session/streaming-output";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { formatGroupedFiles } from "./grouped-file-output";
import { formatMatchLine } from "./match-line-format";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import {
	combineSearchGlobs,
	formatPathRelativeToCwd,
	hasGlobPathChars,
	normalizePathLikeInput,
	parseSearchPath,
	resolveExplicitSearchPaths,
	resolveToCwd,
} from "./path-utils";
import {
	formatCodeFrameLine,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const searchSchema = Type.Object({
	pattern: Type.String({ description: "regex pattern", examples: ["function\\s+\\w+", "TODO"] }),
	paths: Type.Array(Type.String({ description: "file, directory, glob, or internal URL to search" }), {
		minItems: 1,
		description: "files, directories, globs, or internal URLs to search",
		examples: [["src/"], ["src/foo.ts"], ["src/**/*.ts"], ["src/", "packages/"]],
	}),
	i: Type.Optional(Type.Boolean({ description: "case-insensitive search", default: false })),
	gitignore: Type.Optional(Type.Boolean({ description: "respect gitignore", default: true })),
	skip: Type.Optional(Type.Number({ description: "matches to skip", default: 0 })),
});

export type SearchToolInput = Static<typeof searchSchema>;

export const DEFAULT_MATCH_LIMIT = 100;

export interface SearchToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	resultLimitReached?: number;
	linesTruncated?: boolean;
	meta?: OutputMeta;
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	truncated?: boolean;
	error?: string;
	/** Pre-formatted text for the user-visible TUI render. Mirrors the model-facing
	 * `result.text` lines but uses a `│` gutter and `*` to mark match lines (vs space for
	 * context). The TUI uses this directly so it never parses model-facing hashline anchors. */
	displayContent?: string;
	/** User-supplied paths whose base directory was missing on the active backend. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

type SearchParams = Static<typeof searchSchema>;

interface SearchMatchLine {
	lineNumber: number;
	line: string;
	isMatch: boolean;
	truncated?: boolean;
}

interface SearchMatch {
	path: string;
	lineNumber: number;
	line: string;
	lines: SearchMatchLine[];
}

interface SearchExecutionResult {
	matches: SearchMatch[];
	limitReached: boolean;
}

function isGrepLineTruncated(hit: GrepHit): boolean {
	if (!("truncated" in hit)) {
		return false;
	}
	return hit.truncated === true;
}

type TaggedGrepSummary = GrepSummary & { type: "summary" };

function isTaggedGrepSummary(value: unknown): value is TaggedGrepSummary {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	return "type" in value && value.type === "summary";
}

function isLegacyGrepSummary(value: unknown): value is GrepSummary {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	return !("type" in value) && "limitReached" in value;
}

function getGrepLimitReached(value: unknown): boolean {
	if (!isTaggedGrepSummary(value) && !isLegacyGrepSummary(value)) {
		return false;
	}
	return value.limitReached === true;
}

function normalizeContextLines(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.floor(value));
}

function isPathNotFoundError(error: unknown): boolean {
	return isEnoent(error) || (error instanceof Error && /(?:Path not found|ENOENT|not found)/i.test(error.message));
}

interface SearchInputProbe {
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

function createSearchInputProbe(rawPath: string, cwd: string, suffixGlob?: string): SearchInputProbe {
	const parsedPath = parseSearchPath(rawPath);
	const absoluteBasePath = resolveToCwd(parsedPath.basePath, cwd);
	const globPattern = parsedPath.glob ? combineSearchGlobs(parsedPath.glob, suffixGlob) : suffixGlob;
	return {
		raw: rawPath,
		absoluteBasePath,
		glob: globPattern ? new Bun.Glob(normalizeProbePath(globPattern)) : undefined,
		matched: false,
	};
}

function markSearchProbeMatches(probes: SearchInputProbe[], entries: Array<{ path: string }>, cwd: string): void {
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

export class SearchTool implements AgentTool<typeof searchSchema, SearchToolDetails> {
	readonly name = "search";
	readonly label = "Search";
	readonly loadMode = "discoverable";
	readonly summary = "Search file contents using ripgrep (fast text search)";
	readonly description: string;
	readonly parameters = searchSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		const displayMode = resolveFileDisplayMode(session);
		this.description = prompt.render(searchDescription, {
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
		});
	}

	async execute(
		_toolCallId: string,
		params: SearchParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolDetails>> {
		const { pattern, paths, i, gitignore, skip } = params;

		return untilAborted(signal, async () => {
			const normalizedPattern = pattern.trim();
			if (!normalizedPattern) {
				throw new ToolError("Pattern must not be empty");
			}

			const normalizedSkip = skip === undefined ? 0 : Number.isFinite(skip) ? Math.floor(skip) : Number.NaN;
			if (normalizedSkip < 0 || !Number.isFinite(normalizedSkip)) {
				throw new ToolError("Skip must be a non-negative number");
			}
			const normalizedContextBefore = normalizeContextLines(this.session.settings.get("search.contextBefore"));
			const normalizedContextAfter = normalizeContextLines(this.session.settings.get("search.contextAfter"));
			const ignoreCase = i ?? false;
			const useGitignore = gitignore ?? true;
			const patternHasNewline = normalizedPattern.includes("\n") || normalizedPattern.includes("\\n");
			const effectiveMultiline = patternHasNewline;

			const formatScopePath = (targetPath: string): string => formatPathRelativeToCwd(targetPath, this.session.cwd);
			let searchPath: string;
			let scopePath: string;
			let exactFilePaths: string[] | undefined;
			let multiTargets: Array<{ basePath: string; glob?: string }> | undefined;
			let globFilter: string | undefined;
			const rawPaths = paths.map(normalizePathLikeInput);
			if (rawPaths.some(rawPath => rawPath.length === 0)) {
				throw new ToolError("`paths` must contain non-empty paths or globs");
			}
			const internalRouter = InternalUrlRouter.instance();
			const resolvedPathInputs: string[] = [];
			// Absolute filesystem paths whose source is immutable (e.g. artifact://,
			// pi://, skill://). Hashline anchors are suppressed for these on a
			// per-file basis, leaving editable mixed-in files untouched.
			const immutableSourcePaths = new Set<string>();
			for (const rawPath of rawPaths) {
				if (!internalRouter.canHandle(rawPath)) {
					resolvedPathInputs.push(rawPath);
					continue;
				}
				if (hasGlobPathChars(rawPath)) {
					throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPath}`);
				}
				const resource = await internalRouter.resolve(rawPath);
				if (!resource.sourcePath) {
					throw new ToolError(`Cannot search internal URL without a backing file: ${rawPath}`);
				}
				if (resource.immutable) {
					immutableSourcePaths.add(path.resolve(resource.sourcePath));
				}
				resolvedPathInputs.push(resource.sourcePath);
			}
			const baseDisplayMode = resolveFileDisplayMode(this.session);
			const immutableDisplayMode = resolveFileDisplayMode(this.session, { immutable: true });
			const backend = this.session.backend;
			// Tolerate missing entries in a multi-path call after the backend glob
			// primitive has had a chance to resolve each input. Single missing paths
			// keep the original ENOENT semantics.
			const uniqueResolvedPathInputs = [...new Set(resolvedPathInputs)];
			const isMultiPathInput = uniqueResolvedPathInputs.length > 1;
			let missingPaths: string[] = [];
			const searchInputProbes = isMultiPathInput
				? uniqueResolvedPathInputs.map(inputPath => createSearchInputProbe(inputPath, this.session.cwd, globFilter))
				: [];
			const statCache = new Map<string, StatResult | null>();
			const statInputBase = async (targetPath: string): Promise<StatResult | null> => {
				const cacheKey = path.resolve(targetPath);
				if (statCache.has(cacheKey)) return statCache.get(cacheKey) ?? null;
				try {
					const stat = await backend.fs.stat(targetPath, { signal, followSymlinks: true });
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
			const collectMissingSearchPaths = async (): Promise<string[]> => {
				const missing: string[] = [];
				for (const probe of searchInputProbes) {
					if (probe.matched) continue;
					const stat = await statInputBase(probe.absoluteBasePath);
					if (!stat) missing.push(probe.raw);
				}
				return missing;
			};
			if (uniqueResolvedPathInputs.length === 1) {
				const parsedPath = parseSearchPath(uniqueResolvedPathInputs[0] ?? ".");
				searchPath = resolveToCwd(parsedPath.basePath, this.session.cwd);
				globFilter = parsedPath.glob;
				scopePath = formatScopePath(searchPath);
			} else {
				const multiSearchPath = await resolveExplicitSearchPaths(
					uniqueResolvedPathInputs,
					this.session.cwd,
					globFilter,
				);
				if (!multiSearchPath) {
					throw new ToolError("`paths` must contain at least one path or glob");
				}
				searchPath = multiSearchPath.basePath;
				exactFilePaths = multiSearchPath.exactFilePaths;
				multiTargets = multiSearchPath.targets;
				globFilter = exactFilePaths || multiTargets ? undefined : multiSearchPath.glob;
				scopePath = multiSearchPath.scopePath;
			}
			let isDirectory = true;
			if (!isMultiPathInput) {
				try {
					const stat = await backend.fs.stat(searchPath, { signal });
					if (!stat.exists) {
						throw new ToolError(`Path not found: ${scopePath}`);
					}
					isDirectory = stat.kind === "dir";
				} catch {
					throw new ToolError(`Path not found: ${scopePath}`);
				}
			}

			const effectiveLimit = DEFAULT_MATCH_LIMIT;
			const internalLimit = Math.min(effectiveLimit * 5, 2000);
			const streamMaxMatches = exactFilePaths ? undefined : normalizedSkip + internalLimit;

			const grepPlans: Array<{ path: string; allowed?: Set<string> }> = [];
			const grepPlanMap = new Map<string, { path: string; allowed?: Set<string> }>();
			const addGrepPlan = (targetPath: string, allowedPath?: string) => {
				const existing = grepPlanMap.get(targetPath);
				if (existing) {
					if (allowedPath === undefined) {
						existing.allowed = undefined;
					} else if (existing.allowed) {
						existing.allowed.add(allowedPath);
					}
					return;
				}
				const plan = {
					path: targetPath,
					allowed: allowedPath === undefined ? undefined : new Set([allowedPath]),
				};
				grepPlanMap.set(targetPath, plan);
				grepPlans.push(plan);
			};
			let result: SearchExecutionResult;
			try {
				const expandGlobPlans = async (basePath: string, pattern: string) => {
					const globRequest: Parameters<typeof backend.fs.glob>[0] & { gitignore?: boolean } = {
						patterns: [pattern],
						paths: [basePath],
						includeHidden: true,
						types: ["file"],
						gitignore: useGitignore,
						signal,
					};
					let globResult: GlobResult;
					try {
						globResult = await backend.fs.glob(globRequest);
					} catch (error) {
						if (!isMultiPathInput || !isPathNotFoundError(error)) {
							throw error;
						}
						globResult = { entries: [], truncated: false };
					}
					markSearchProbeMatches(searchInputProbes, globResult.entries, this.session.cwd);
					for (const entry of globResult.entries) {
						addGrepPlan(basePath, path.resolve(this.session.cwd, entry.path));
					}
					return globResult.entries;
				};
				if (exactFilePaths) {
					for (const filePath of exactFilePaths) {
						addGrepPlan(path.dirname(filePath), filePath);
					}
				} else if (multiTargets) {
					for (const target of multiTargets) {
						if (target.glob) {
							await expandGlobPlans(target.basePath, target.glob);
							continue;
						}
						addGrepPlan(target.basePath);
					}
				} else if (globFilter) {
					await expandGlobPlans(searchPath, globFilter);
				} else if (isDirectory) {
					addGrepPlan(searchPath);
				} else {
					addGrepPlan(path.dirname(searchPath), searchPath);
				}

				const createLine = (hit: GrepHit): SearchMatchLine => ({
					lineNumber: hit.line,
					line: hit.text,
					isMatch: hit.kind === "match",
					truncated: isGrepLineTruncated(hit),
				});
				const matches: SearchMatch[] = [];
				let limitReached = false;
				let seenMatches = 0;
				let currentMatch: SearchMatch | undefined;
				let pendingBefore: SearchMatchLine[] = [];
				let pendingAfter: SearchMatchLine[] = [];

				const pushMatch = (match: SearchMatch) => {
					seenMatches += 1;
					if (seenMatches <= normalizedSkip) {
						return;
					}
					if (!exactFilePaths && matches.length >= internalLimit) {
						return;
					}
					matches.push(match);
				};

				const flushCurrentMatch = () => {
					if (!currentMatch) {
						pendingBefore = [];
						pendingAfter = [];
						return;
					}
					currentMatch.lines.push(...pendingAfter.slice(0, normalizedContextAfter));
					pushMatch(currentMatch);
					currentMatch = undefined;
					pendingBefore = [];
					pendingAfter = [];
				};

				const handleHit = (hit: GrepHit, absolutePath: string) => {
					const matchPath = path.relative(searchPath, absolutePath).replace(/\\/g, "/");
					const line = createLine(hit);
					if (line.isMatch) {
						if (currentMatch) {
							if (currentMatch.path === matchPath) {
								const beforeCount =
									normalizedContextBefore > 0 ? Math.min(normalizedContextBefore, pendingAfter.length) : 0;
								const splitIndex = pendingAfter.length - beforeCount;
								currentMatch.lines.push(...pendingAfter.slice(0, Math.min(splitIndex, normalizedContextAfter)));
								pendingBefore = beforeCount > 0 ? pendingAfter.slice(splitIndex) : [];
								pushMatch(currentMatch);
							} else {
								flushCurrentMatch();
							}
						}
						const beforeLines = normalizedContextBefore > 0 ? pendingBefore.slice(-normalizedContextBefore) : [];
						currentMatch = {
							path: matchPath,
							lineNumber: line.lineNumber,
							line: line.line,
							lines: [...beforeLines, line],
						};
						pendingBefore = [];
						pendingAfter = [];
						return;
					}

					if (currentMatch && currentMatch.path === matchPath) {
						pendingAfter.push(line);
						return;
					}
					if (currentMatch) {
						flushCurrentMatch();
					}
					pendingBefore.push(line);
					if (normalizedContextBefore === 0) {
						pendingBefore = [];
					} else if (pendingBefore.length > normalizedContextBefore) {
						pendingBefore = pendingBefore.slice(-normalizedContextBefore);
					}
				};

				for (const plan of grepPlans) {
					const remainingMatches =
						exactFilePaths || streamMaxMatches === undefined ? undefined : streamMaxMatches - seenMatches;
					if (remainingMatches !== undefined && remainingMatches <= 0) {
						break;
					}
					const grepRequest = {
						pattern: normalizedPattern,
						paths: [plan.path],
						ignoreCase,
						gitignore: useGitignore,
						multiline: effectiveMultiline,
						contextBefore: normalizedContextBefore,
						contextAfter: normalizedContextAfter,
						maxMatches: remainingMatches,
						signal,
					};
					try {
						const grepStream = backend.fs.grep(grepRequest)[Symbol.asyncIterator]();
						while (true) {
							const next = await grepStream.next();
							if (next.done) {
								limitReached = limitReached || getGrepLimitReached(next.value);
								break;
							}
							signal?.throwIfAborted();
							const hit = next.value;
							const absolutePath = path.isAbsolute(hit.path)
								? hit.path
								: path.resolve(this.session.cwd, hit.path);
							markSearchProbeMatches(searchInputProbes, [{ path: absolutePath }], this.session.cwd);
							if (plan.allowed && !plan.allowed.has(absolutePath)) {
								continue;
							}
							handleHit(hit, absolutePath);
						}
					} catch (error) {
						if (!isMultiPathInput || !isPathNotFoundError(error)) {
							throw error;
						}
					}
					flushCurrentMatch();
				}
				if (isMultiPathInput) {
					missingPaths = await collectMissingSearchPaths();
					if (missingPaths.length === searchInputProbes.length) {
						throw new ToolError(`Path not found: ${missingPaths.join(", ")}`);
					}
				}

				result = {
					matches,
					limitReached,
				};
			} catch (err) {
				if (err instanceof Error && err.message.startsWith("regex parse error")) {
					throw new ToolError(err.message);
				}
				throw err;
			}

			const formatPath = (filePath: string): string =>
				formatResultPath(filePath, isDirectory, searchPath, this.session.cwd);

			// Build output
			const roundRobinSelect = (matches: SearchMatch[], limit: number): SearchMatch[] => {
				if (matches.length <= limit) return matches;
				const fileOrder: string[] = [];
				const byFile = new Map<string, SearchMatch[]>();
				for (const match of matches) {
					if (!byFile.has(match.path)) {
						fileOrder.push(match.path);
						byFile.set(match.path, []);
					}
					byFile.get(match.path)!.push(match);
				}
				const selected: SearchMatch[] = [];
				const indices = new Map<string, number>(fileOrder.map(file => [file, 0]));
				while (selected.length < limit) {
					let anyAdded = false;
					for (const file of fileOrder) {
						if (selected.length >= limit) break;
						const fileMatches = byFile.get(file)!;
						const idx = indices.get(file)!;
						if (idx < fileMatches.length) {
							selected.push(fileMatches[idx]);
							indices.set(file, idx + 1);
							anyAdded = true;
						}
					}
					if (!anyAdded) break;
				}
				return selected;
			};
			const selectedMatches = isDirectory
				? roundRobinSelect(result.matches, effectiveLimit)
				: result.matches.slice(0, effectiveLimit);
			const matchLimitReached = result.matches.length > effectiveLimit;
			const nextSkip = normalizedSkip + selectedMatches.length;
			const limitMessage = `Result limit reached; narrow paths or use skip=${nextSkip}.`;
			const { record: recordFile, list: fileList } = createFileRecorder();
			const fileMatchCounts = new Map<string, number>();
			const missingPathsNote =
				missingPaths.length > 0 ? `Skipped missing paths: ${missingPaths.join(", ")}` : undefined;
			if (selectedMatches.length === 0) {
				const details: SearchToolDetails = {
					scopePath,
					matchCount: 0,
					fileCount: 0,
					files: [],
					truncated: false,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
				};
				const text = missingPathsNote ? `No matches found\n${missingPathsNote}` : "No matches found";
				return toolResult(details).text(text).done();
			}
			const outputLines: string[] = [];
			let linesTruncated = false;
			const matchesByFile = new Map<string, SearchMatch[]>();
			for (const match of selectedMatches) {
				const relativePath = formatPath(match.path);
				recordFile(relativePath);
				if (!matchesByFile.has(relativePath)) {
					matchesByFile.set(relativePath, []);
				}
				matchesByFile.get(relativePath)!.push(match);
			}
			const displayLines: string[] = [];
			const renderMatchesForFile = (relativePath: string): { model: string[]; display: string[] } => {
				const modelOut: string[] = [];
				const displayOut: string[] = [];
				const fileMatches = matchesByFile.get(relativePath) ?? [];
				const absoluteFilePath = path.resolve(this.session.cwd, relativePath);
				const useHashLines = immutableSourcePaths.has(absoluteFilePath)
					? immutableDisplayMode.hashLines
					: baseDisplayMode.hashLines;
				const lineNumberWidth = fileMatches.reduce((width, match) => {
					for (const entry of match.lines) {
						width = Math.max(width, String(entry.lineNumber).length);
					}
					return width;
				}, 0);
				const cacheEntries: Array<readonly [number, string]> = [];
				for (const match of fileMatches) {
					const pushLine = (lineNumber: number, line: string, isMatch: boolean, truncated?: boolean) => {
						if (truncated) {
							linesTruncated = true;
						}
						modelOut.push(formatMatchLine(lineNumber, line, isMatch, { useHashLines }));
						displayOut.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, lineNumberWidth));
						cacheEntries.push([lineNumber, line] as const);
					};
					for (const entry of match.lines) {
						pushLine(entry.lineNumber, entry.line, entry.isMatch, entry.truncated);
					}
					fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
				}
				if (cacheEntries.length > 0) {
					getFileReadCache(this.session).recordSparse(path.resolve(searchPath, relativePath), cacheEntries);
				}
				return { model: modelOut, display: displayOut };
			};
			if (isDirectory) {
				const grouped = formatGroupedFiles(fileList, relativePath => {
					const rendered = renderMatchesForFile(relativePath);
					return {
						modelLines: rendered.model,
						displayLines: rendered.display,
						skip: rendered.model.length === 0,
					};
				});
				outputLines.push(...grouped.model);
				displayLines.push(...grouped.display);
			} else {
				for (const relativePath of fileList) {
					const rendered = renderMatchesForFile(relativePath);
					outputLines.push(...rendered.model);
					displayLines.push(...rendered.display);
				}
			}
			if (matchLimitReached || result.limitReached) {
				outputLines.push("", limitMessage);
			}
			if (missingPathsNote) {
				outputLines.push("", missingPathsNote);
			}
			const rawOutput = outputLines.join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			const output = truncation.content;
			const truncated = Boolean(matchLimitReached || result.limitReached || truncation.truncated || linesTruncated);
			const details: SearchToolDetails = {
				scopePath,
				matchCount: selectedMatches.length,
				fileCount: fileList.length,
				files: fileList,
				fileMatches: fileList.map(path => ({
					path,
					count: fileMatchCounts.get(path) ?? 0,
				})),
				truncated,
				matchLimitReached: matchLimitReached ? effectiveLimit : undefined,
				resultLimitReached: result.limitReached ? internalLimit : undefined,
				displayContent: displayLines.join("\n"),
				missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
			};
			if (truncation.truncated) details.truncation = truncation;
			if (linesTruncated) details.linesTruncated = true;
			const resultBuilder = toolResult(details)
				.text(output)
				.limits({ columnMax: linesTruncated ? DEFAULT_MAX_COLUMN : undefined });
			if (truncation.truncated) {
				resultBuilder.truncation(truncation, { direction: "head" });
			}
			return resultBuilder.done();
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface SearchRenderArgs {
	pattern: string;
	paths?: string[];
	i?: boolean;
	gitignore?: boolean;
	skip?: number;
}

const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const searchToolRenderer = {
	inline: true,
	renderCall(args: SearchRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.paths?.length) meta.push(`in ${args.paths.join(", ")}`);
		if (args.i) meta.push("case:insensitive");
		if (args.gitignore === false) meta.push("gitignore:false");
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Search", description: args.pattern || "?", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: SearchRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;

		if (!hasDetailedData) {
			const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text;
			if (!textContent || textContent === "No matches found") {
				return new Text(formatEmptyMessage("No matches found", uiTheme), 0, 0);
			}
			const lines = textContent.split("\n").filter(line => line.trim() !== "");
			const description = args?.pattern ?? undefined;
			const header = renderStatusLine(
				{ icon: "success", title: "Search", description, meta: [formatCount("item", lines.length)] },
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
							maxCollapsed: COLLAPSED_TEXT_LIMIT,
							maxCollapsedLines: COLLAPSED_TEXT_LIMIT,
							itemType: "item",
							renderItem: line => uiTheme.fg("toolOutput", line),
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

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(
			details?.truncated || truncation || limits?.matchLimit || limits?.resultLimit || limits?.columnTruncated,
		);

		const missingPathsList = details?.missingPaths ?? [];
		const missingNote =
			missingPathsList.length > 0
				? uiTheme.fg("warning", `skipped missing: ${missingPathsList.join(", ")}`)
				: undefined;

		if (matchCount === 0) {
			const header = renderStatusLine(
				{ icon: "warning", title: "Search", description: args?.pattern, meta: ["0 matches"] },
				uiTheme,
			);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 0, 0);
		}

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const description = args?.pattern ?? undefined;
		const header = renderStatusLine(
			{ icon: truncated ? "warning" : "success", title: "Search", description, meta },
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const rawLines = textContent.split("\n");
		const hasSeparators = rawLines.some(line => line.trim().length === 0);
		const matchGroups: string[][] = [];
		if (hasSeparators) {
			let current: string[] = [];
			for (const line of rawLines) {
				if (line.trim().length === 0) {
					if (current.length > 0) {
						matchGroups.push(current);
						current = [];
					}
					continue;
				}
				current.push(line);
			}
			if (current.length > 0) matchGroups.push(current);
		} else {
			const nonEmpty = rawLines.filter(line => line.trim().length > 0);
			if (nonEmpty.length > 0) {
				matchGroups.push(nonEmpty);
			}
		}

		const renderedMatchLimit = details?.matchLimitReached ?? limits?.matchLimit?.reached;
		const renderedResultLimit = details?.resultLimitReached ?? limits?.resultLimit?.reached;
		const truncationReasons: string[] = [];
		if (renderedMatchLimit) truncationReasons.push(`first ${renderedMatchLimit} matches`);
		if (renderedResultLimit) truncationReasons.push(`first ${renderedResultLimit} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		if (limits?.columnTruncated) truncationReasons.push(`line length ${limits.columnTruncated.maxColumn}`);
		if (truncation?.artifactId) truncationReasons.push(formatFullOutputReference(truncation.artifactId));

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
				const collapsedMatchLineBudget = Math.max(COLLAPSED_TEXT_LIMIT - extraLines.length, 0);
				const matchLines = renderTreeList(
					{
						items: matchGroups,
						expanded,
						maxCollapsed: matchGroups.length,
						maxCollapsedLines: collapsedMatchLineBudget,
						itemType: "match",
						renderItem: group =>
							group.map(line => {
								if (line.startsWith("## ")) return uiTheme.fg("dim", line);
								if (line.startsWith("# ")) return uiTheme.fg("accent", line);
								return uiTheme.fg("toolOutput", line);
							}),
					},
					uiTheme,
				);
				const result = [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
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
