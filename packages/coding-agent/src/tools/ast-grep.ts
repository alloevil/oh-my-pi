import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { AstFindMatch } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { Backend, GrepAstHit, StatResult } from "../backend";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import type { Theme } from "../modes/theme/theme";
import astGrepDescription from "../prompts/tools/ast-grep.md" with { type: "text" };
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { formatGroupedFiles } from "./grouped-file-output";
import { formatMatchLine } from "./match-line-format";
import type { OutputMeta } from "./output-meta";
import {
	formatPathRelativeToCwd,
	hasGlobPathChars,
	normalizePathLikeInput,
	parseSearchPath,
	resolveExplicitSearchPaths,
	resolveToCwd,
} from "./path-utils";
import {
	dedupeParseErrors,
	formatCodeFrameLine,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatParseErrors,
	PARSE_ERRORS_LIMIT,
	PREVIEW_LIMITS,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const astGrepSchema = Type.Object({
	pat: Type.String({ description: "ast pattern", examples: ["console.log($$$)"] }),
	paths: Type.Array(Type.String({ description: "file, directory, glob, or internal URL to search" }), {
		minItems: 1,
		description: "files, directories, globs, or internal URLs to search",
		examples: [["src/"], ["src/foo.ts"], ["src/**/*.ts"], ["src/", "packages/"]],
	}),
	skip: Type.Optional(Type.Number({ description: "matches to skip", default: 0 })),
	limit: Type.Optional(Type.Number({ description: "maximum matches to return", default: 50 })),
	language: Type.Optional(Type.String({ description: "language override for AST parsing" })),
	strictness: Type.Optional(
		Type.Union([Type.Literal("smart"), Type.Literal("relaxed"), Type.Literal("strict")], {
			description: "AST matching strictness",
		}),
	),
});

type AstGrepStrictness = "smart" | "relaxed" | "strict";

type GrepAstParseError = string | { file?: string; message: string };

interface GrepAstBackendResult {
	parseErrors?: GrepAstParseError[];
	filesSearched?: number;
	limitReached?: boolean;
}

type GrepAstHitWithColumns = GrepAstHit & {
	column: number;
	endColumn: number;
};

type GrepAstBackendIterator = AsyncIterator<GrepAstHitWithColumns, GrepAstBackendResult, undefined>;

type GrepAstBackendRequest = Parameters<Backend["edit"]["grepAst"]>[0] & {
	strictness?: AstGrepStrictness;
};
function mapGrepAstHit(hit: GrepAstHitWithColumns): AstFindMatch {
	return {
		path: hit.file,
		text: hit.matched,
		byteStart: 0,
		byteEnd: Buffer.byteLength(hit.matched, "utf8"),
		startLine: hit.range.start,
		startColumn: hit.column,
		endLine: hit.range.end,
		endColumn: hit.endColumn,
		metaVariables: Object.keys(hit.meta).length > 0 ? hit.meta : undefined,
	};
}
function normalizeGlobPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function joinBackendPath(basePath: string, glob: string | undefined, cwd: string): string {
	const relativeBase = normalizeGlobPath(path.relative(cwd, basePath)) || ".";
	if (!glob) {
		return relativeBase;
	}
	const normalizedGlob = normalizeGlobPath(glob).replace(/^\/+/, "");
	if (relativeBase === ".") {
		return normalizedGlob;
	}
	return `${relativeBase.replace(/\/+$/, "")}/${normalizedGlob}`;
}

function joinBackendUnknownKindPath(basePath: string, cwd: string): string {
	const relativeBase = normalizeGlobPath(path.relative(cwd, basePath)) || ".";
	if (relativeBase === ".") return "**/*";
	const normalizedBase = relativeBase.replace(/\/+$/, "");
	return `{${normalizedBase},${normalizedBase}/**/*}`;
}

async function collectMissingAstGrepInputs(
	backend: Backend,
	pathInputs: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<string[]> {
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
	const missing: string[] = [];
	await Promise.all(
		pathInputs.map(async inputPath => {
			const parsedPath = parseSearchPath(inputPath);
			const absoluteBasePath = resolveToCwd(parsedPath.basePath, cwd);
			const stat = await statInputBase(absoluteBasePath);
			if (!stat) missing.push(inputPath);
		}),
	);
	return pathInputs.filter(inputPath => missing.includes(inputPath));
}

async function runBackendAstGrep(
	backend: Backend,
	options: {
		pattern: string;
		paths: string[];
		language?: string;
		strictness?: AstGrepStrictness;
		skip: number;
		limit: number;
		signal?: AbortSignal;
	},
): Promise<{
	matches: AstFindMatch[];
	totalMatches: number;
	filesWithMatches: number;
	filesSearched: number;
	limitReached: boolean;
	truncated: boolean;
	parseErrors?: GrepAstParseError[];
}> {
	const observedMatches: AstFindMatch[] = [];
	const filesWithMatches = new Set<string>();
	const maxObservedMatches = options.skip + options.limit + 1;
	let totalMatches = 0;
	let truncated = false;
	let finalResult: GrepAstBackendResult = {};
	const iterator = backend.edit
		.grepAst({
			pattern: options.pattern,
			paths: options.paths,
			language: options.language,
			strictness: options.strictness,
			limit: maxObservedMatches,
			signal: options.signal,
		} as GrepAstBackendRequest)
		[Symbol.asyncIterator]() as GrepAstBackendIterator;
	while (true) {
		const next = await iterator.next();
		if (next.done) {
			finalResult = next.value ?? {};
			break;
		}
		totalMatches += 1;
		filesWithMatches.add(next.value.file);
		observedMatches.push(mapGrepAstHit(next.value));
		if (totalMatches >= maxObservedMatches) {
			const done = await iterator.next();
			if (done.done) {
				finalResult = done.value ?? {};
			} else {
				truncated = true;
				if (typeof iterator.return === "function") {
					await iterator.return(undefined);
				}
			}
			break;
		}
	}
	observedMatches.sort((left, right) => {
		const pathCmp = left.path.localeCompare(right.path);
		if (pathCmp !== 0) return pathCmp;
		if (left.startLine !== right.startLine) return left.startLine - right.startLine;
		if (left.startColumn !== right.startColumn) return left.startColumn - right.startColumn;
		if (left.byteStart !== right.byteStart) return left.byteStart - right.byteStart;
		return left.byteEnd - right.byteEnd;
	});
	const matches = observedMatches.slice(options.skip, options.skip + options.limit);
	return {
		matches,
		totalMatches,
		filesWithMatches: filesWithMatches.size,
		filesSearched: finalResult.filesSearched ?? 0,
		limitReached: totalMatches > options.skip + options.limit,
		truncated: truncated || finalResult.limitReached === true,
		parseErrors: finalResult.parseErrors,
	};
}

export interface AstGrepToolDetails {
	matchCount: number;
	fileCount: number;
	filesSearched: number;
	limitReached: boolean;
	truncated: boolean;
	parseErrors?: string[];
	scopePath?: string;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * a `│` gutter and `*` to mark match lines. The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
	missingPaths?: string[];
}
function formatAstGrepCount(label: string, count: number, truncated: boolean): string {
	return truncated ? `at least ${formatCount(label, count)}` : formatCount(label, count);
}

export class AstGrepTool implements AgentTool<typeof astGrepSchema, AstGrepToolDetails> {
	readonly name = "ast_grep";
	readonly label = "AST Grep";
	readonly summary = "Search code with AST patterns (structural grep)";
	readonly description: string;
	readonly parameters = astGrepSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(astGrepDescription);
	}

	async execute(
		_toolCallId: string,
		params: Static<typeof astGrepSchema>,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AstGrepToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AstGrepToolDetails>> {
		return untilAborted(signal, async () => {
			const pattern = params.pat.trim();
			if (pattern.length === 0) {
				throw new ToolError("`pat` must be a non-empty pattern");
			}

			const skip = params.skip === undefined ? 0 : Math.floor(params.skip);
			if (!Number.isFinite(skip) || skip < 0) {
				throw new ToolError("skip must be a non-negative number");
			}
			const formatScopePath = (targetPath: string): string => formatPathRelativeToCwd(targetPath, this.session.cwd);
			let searchPath: string;
			let scopePath: string;
			let globFilter: string | undefined;

			let multiTargets: Array<{ basePath: string; glob?: string }> | undefined;
			const rawPaths = params.paths.map(normalizePathLikeInput);
			if (rawPaths.some(rawPath => rawPath.length === 0)) {
				throw new ToolError("`paths` must contain non-empty paths or globs");
			}
			const internalRouter = InternalUrlRouter.instance();
			const resolvedPathInputs: string[] = [];
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
					throw new ToolError(`Cannot search internal URL without backing file: ${rawPath}`);
				}
				resolvedPathInputs.push(resource.sourcePath);
			}
			const backend = this.session.backend;
			const uniqueResolvedPathInputs = [...new Set(resolvedPathInputs)];
			const isMultiPathInput = uniqueResolvedPathInputs.length > 1;
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
				globFilter = multiSearchPath.targets ? undefined : multiSearchPath.glob;
				multiTargets = multiSearchPath.targets;

				scopePath = multiSearchPath.scopePath;
			}

			const resolvedSearchPath = searchPath;
			scopePath = scopePath ?? formatScopePath(resolvedSearchPath);
			let isDirectory = true;
			if (!isMultiPathInput) {
				const searchPathStat = await backend.fs.stat(resolvedSearchPath, { signal });
				if (searchPathStat.exists === false) {
					throw new ToolError(`Path not found: ${scopePath}`);
				}
				isDirectory = searchPathStat.kind === "dir";
			}

			let backendPaths: string[];
			if (multiTargets && multiTargets.length > 0) {
				backendPaths = [];
				for (const target of multiTargets) {
					if (target.glob) {
						backendPaths.push(joinBackendPath(target.basePath, target.glob, this.session.cwd));
					} else {
						backendPaths.push(joinBackendUnknownKindPath(target.basePath, this.session.cwd));
					}
				}
			} else {
				const singleGlob = !globFilter && isDirectory ? "**/*" : globFilter;
				backendPaths = [joinBackendPath(resolvedSearchPath, singleGlob, this.session.cwd)];
			}

			const DEFAULT_AST_LIMIT = 50;
			const limit = params.limit === undefined ? DEFAULT_AST_LIMIT : Math.floor(params.limit);
			if (!Number.isFinite(limit) || limit <= 0) {
				throw new ToolError("limit must be a positive number");
			}
			const result = await runBackendAstGrep(backend, {
				pattern,
				paths: backendPaths,
				skip,
				limit,
				language: params.language,
				strictness: params.strictness,
				signal,
			});
			let missingPaths: string[] = [];
			if (isMultiPathInput) {
				missingPaths = await collectMissingAstGrepInputs(
					backend,
					uniqueResolvedPathInputs,
					this.session.cwd,
					signal,
				);
			}
			if (missingPaths.length === uniqueResolvedPathInputs.length) {
				throw new ToolError(`Path not found: ${missingPaths.join(", ")}`);
			}
			const missingPathsNote =
				missingPaths.length > 0 ? `Skipped missing paths: ${missingPaths.join(", ")}` : undefined;

			const normalizedParseErrors = (result.parseErrors ?? []).map(error => {
				if (typeof error === "string") {
					return error;
				}
				return error.file ? `${error.file}: ${error.message}` : error.message;
			});
			const dedupedParseErrors = dedupeParseErrors(normalizedParseErrors);
			const formatPath = (filePath: string): string =>
				formatResultPath(filePath, isDirectory, resolvedSearchPath, this.session.cwd);

			const { record: recordFile, list: fileList } = createFileRecorder();
			const fileMatchCounts = new Map<string, number>();
			const matchesByFile = new Map<string, AstFindMatch[]>();
			for (const match of result.matches) {
				const relativePath = formatPath(match.path);
				recordFile(relativePath);
				if (!matchesByFile.has(relativePath)) {
					matchesByFile.set(relativePath, []);
				}
				matchesByFile.get(relativePath)!.push(match);
			}

			const baseDetails: AstGrepToolDetails = {
				matchCount: result.totalMatches,
				fileCount: result.filesWithMatches,
				filesSearched: result.filesSearched,
				limitReached: result.limitReached,
				truncated: result.truncated,
				...(dedupedParseErrors.length > 0 ? { parseErrors: dedupedParseErrors } : {}),
				scopePath,
				files: fileList,
				fileMatches: [],
				missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
			};

			if (result.matches.length === 0) {
				const noMatchMessage = dedupedParseErrors.length
					? "No matches found. Parse issues mean the query may be mis-scoped; narrow `paths` before concluding absence."
					: "No matches found";
				const parseMessage = dedupedParseErrors.length
					? `\n${formatParseErrors(dedupedParseErrors).join("\n")}`
					: "";
				const missingMessage = missingPathsNote ? `\n${missingPathsNote}` : "";
				return toolResult(baseDetails).text(`${noMatchMessage}${parseMessage}${missingMessage}`).done();
			}

			const useHashLines = resolveFileDisplayMode(this.session).hashLines;
			const outputLines: string[] = [];
			const displayLines: string[] = [];
			const renderMatchesForFile = (relativePath: string): { model: string[]; display: string[] } => {
				const modelOut: string[] = [];
				const displayOut: string[] = [];
				const fileMatches = matchesByFile.get(relativePath) ?? [];
				const lineNumberWidth = fileMatches.reduce((width, match) => {
					const lineCount = match.text.split("\n").length;
					const endLine = match.startLine + lineCount - 1;
					return Math.max(width, String(match.startLine).length, String(endLine).length);
				}, 0);
				for (const match of fileMatches) {
					const matchLines = match.text.split("\n");
					for (let index = 0; index < matchLines.length; index++) {
						const lineNumber = match.startLine + index;
						const isMatch = index === 0;
						const line = matchLines[index] ?? "";
						modelOut.push(formatMatchLine(lineNumber, line, isMatch, { useHashLines }));
						displayOut.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, lineNumberWidth));
					}
					if (match.metaVariables && Object.keys(match.metaVariables).length > 0) {
						const serializedMeta = Object.entries(match.metaVariables)
							.sort(([left], [right]) => left.localeCompare(right))
							.map(([key, value]) => `${key}=${value}`)
							.join(", ");
						modelOut.push(`  meta: ${serializedMeta}`);
						displayOut.push(`  meta: ${serializedMeta}`);
					}
					fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
				}
				return { model: modelOut, display: displayOut };
			};

			if (isDirectory) {
				const grouped = formatGroupedFiles(fileList, relativePath => {
					const rendered = renderMatchesForFile(relativePath);
					return { modelLines: rendered.model, displayLines: rendered.display };
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

			const details: AstGrepToolDetails = {
				...baseDetails,
				fileMatches: fileList.map(filePath => ({
					path: filePath,
					count: fileMatchCounts.get(filePath) ?? 0,
				})),
				displayContent: displayLines.join("\n"),
			};
			if (result.limitReached) {
				outputLines.push("", "Result limit reached; narrow paths or increase limit.");
			}
			if (dedupedParseErrors.length) {
				outputLines.push("", ...formatParseErrors(dedupedParseErrors));
			}
			if (missingPathsNote) {
				outputLines.push("", missingPathsNote);
			}

			return toolResult(details).text(outputLines.join("\n")).done();
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface AstGrepRenderArgs {
	pat?: string;
	paths?: string[];
	skip?: number;
	limit?: number;
}

const COLLAPSED_MATCH_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const astGrepToolRenderer = {
	inline: true,
	renderCall(args: AstGrepRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.paths?.length) meta.push(`in ${args.paths.join(", ")}`);
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const description = args.pat ?? "?";
		const text = renderStatusLine({ icon: "pending", title: "AST Grep", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstGrepToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AstGrepRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const truncated = details?.truncated ?? false;

		if (matchCount === 0) {
			const description = args?.pat;
			const meta = ["0 matches"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			const header = renderStatusLine({ icon: "warning", title: "AST Grep", description, meta }, uiTheme);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (details?.missingPaths?.length) {
				lines.push(uiTheme.fg("warning", `skipped missing: ${details.missingPaths.join(", ")}`));
			}
			if (details?.parseErrors?.length) {
				lines.push(uiTheme.fg("warning", "Query may be mis-scoped; narrow `paths` before concluding absence"));
				const capped = details.parseErrors.slice(0, PARSE_ERRORS_LIMIT);
				for (const err of capped) {
					lines.push(uiTheme.fg("warning", `  - ${err}`));
				}
				if (details.parseErrors.length > PARSE_ERRORS_LIMIT) {
					lines.push(uiTheme.fg("dim", `  … ${details.parseErrors.length - PARSE_ERRORS_LIMIT} more`));
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		}

		const summaryParts = [
			formatAstGrepCount("match", matchCount, truncated),
			formatAstGrepCount("file", fileCount, truncated),
		];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		meta.push(`searched ${filesSearched}`);
		if (truncated) meta.push(uiTheme.fg("warning", "limit reached"));
		const description = args?.pat;
		const header = renderStatusLine(
			{ icon: truncated ? "warning" : "success", title: "AST Grep", description, meta },
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const rawLines = textContent.split("\n");
		const hasSeparators = rawLines.some(line => line.trim().length === 0);
		const allGroups: string[][] = [];
		if (hasSeparators) {
			let current: string[] = [];
			for (const line of rawLines) {
				if (line.trim().length === 0) {
					if (current.length > 0) {
						allGroups.push(current);
						current = [];
					}
					continue;
				}
				current.push(line);
			}
			if (current.length > 0) allGroups.push(current);
		} else {
			const nonEmpty = rawLines.filter(line => line.trim().length > 0);
			if (nonEmpty.length > 0) {
				allGroups.push(nonEmpty);
			}
		}
		const matchGroups = allGroups.filter(
			group => !group[0]?.startsWith("Result limit reached") && !group[0]?.startsWith("Parse issues:"),
		);

		const extraLines: string[] = [];
		if (truncated) {
			extraLines.push(
				uiTheme.fg("warning", "limit reached; totals shown are lower bounds; narrow paths or increase limit"),
			);
		}
		if (details?.parseErrors?.length) {
			const total = details.parseErrors.length;
			const label =
				total > PARSE_ERRORS_LIMIT
					? `${PARSE_ERRORS_LIMIT} / ${total} parse issues`
					: `${total} parse issue${total !== 1 ? "s" : ""}`;
			extraLines.push(uiTheme.fg("warning", label));
		}
		if (details?.missingPaths?.length) {
			extraLines.push(uiTheme.fg("warning", `skipped missing: ${details.missingPaths.join(", ")}`));
		}

		let cached: RenderCache | undefined;
		return {
			render(width: number): string[] {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;
				const matchLines = renderTreeList(
					{
						items: matchGroups,
						expanded,
						maxCollapsed: matchGroups.length,
						maxCollapsedLines: COLLAPSED_MATCH_LIMIT,
						itemType: "match",
						renderItem: group =>
							group.map(line => {
								if (line.startsWith("## ")) return uiTheme.fg("dim", line);
								if (line.startsWith("# ")) return uiTheme.fg("accent", line);
								if (line.startsWith("  meta:")) return uiTheme.fg("dim", line);
								return uiTheme.fg("toolOutput", line);
							}),
					},
					uiTheme,
				);
				const rendered = [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				cached = { key, lines: rendered };
				return rendered;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
