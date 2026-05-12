import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { SummaryResult } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { type ImageMetadata, parseImageMetadata, prompt, readImageMetadata, untilAborted } from "@oh-my-pi/pi-utils";
import { RwpError } from "@oh-my-pi/rwp-client";
import { type Static, Type } from "@sinclair/typebox";
import type { AstSummary, Backend, ReadAstOptions, ReadLinesOptions, ReadLinesResult } from "../backend";
import { getFileReadCache } from "../edit/file-read-cache";
import { isNotebookPath, readEditableNotebookText, readEditableNotebookTextFromBytes } from "../edit/notebook";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { formatHashLine, formatHashLines, formatLineHash, HL_BODY_SEP } from "../hashline/hash";
import { InternalUrlRouter } from "../internal-urls";
import { parseInternalUrl } from "../internal-urls/parse";
import type { InternalUrl } from "../internal-urls/types";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import readDescription from "../prompts/tools/read.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	noTruncResult,
	type TruncationResult,
	truncateHead,
	truncateHeadBytes,
} from "../session/streaming-output";
import { renderCodeCell, renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import { convertBufferWithMarkit, convertFileWithMarkit, type MarkitConversionResult } from "../utils/markit";
import { buildBackendDirectoryTree, buildDirectoryTree, type DirectoryTree } from "../workspace-tree";
import { type ArchiveReader, openArchive, parseArchivePathCandidates } from "./archive-reader";
import {
	executeReadUrl,
	isReadableUrlPath,
	loadReadUrlCacheEntry,
	parseReadUrlTarget,
	type ReadUrlToolDetails,
	renderReadUrlCall,
	renderReadUrlResult,
} from "./fetch";
import { applyListLimit } from "./list-limit";
import { formatFullOutputReference, formatStyledTruncationWarning, type OutputMeta } from "./output-meta";
import { expandPath, formatPathRelativeToCwd, resolveReadPath, splitPathAndSel } from "./path-utils";
import { formatBytes, shortenPath, wrapBrackets } from "./render-utils";
import {
	isSqliteFile,
	parseSqlitePathCandidates,
	parseSqliteSelector,
	renderRow,
	renderSchema,
	renderTable,
	renderTableList,
} from "./sqlite-reader";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

// Document types converted to markdown via markit.
const CONVERTIBLE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".rtf", ".epub"]);

const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_LINES = 20_000;
const PROSE_SUMMARY_EXTENSIONS = new Set([".md", ".txt"]);
const SQLITE_COMMENT_OR_TERMINATOR_ERROR =
	"SQLite where clause cannot contain comments, semicolons, or multiple statements";

const SQLITE_FORBIDDEN_WHERE_KEYWORDS = new Set([
	"limit",
	"offset",
	"union",
	"intersect",
	"except",
	"attach",
	"detach",
	"pragma",
	"vacuum",
]);

const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

type SupportedImageMime = ImageMetadata extends { mimeType: infer M } ? M : never;

function isSupportedImageMime(mimeType: string): mimeType is SupportedImageMime {
	return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType);
}

function prependLineNumbers(text: string, startNum: number): string {
	const textLines = text.split("\n");
	return textLines.map((line, i) => `${startNum + i}|${line}`).join("\n");
}

function formatTextWithMode(
	text: string,
	startNum: number,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatHashLines(text, startNum);
	if (shouldAddLineNumbers) return prependLineNumbers(text, startNum);
	return text;
}
function eolString(eol: ReadLinesResult["eol"]): string {
	switch (eol) {
		case "CRLF":
			return "\r\n";
		case "CR":
			return "\r";
		default:
			return "\n";
	}
}

function readLinesResultToText(result: ReadLinesResult): string {
	const lines = [...result.lines];
	if (result.bom && result.startLine === 1 && lines[0] !== undefined) {
		lines[0] = `\uFEFF${lines[0]}`;
	}
	return lines.join(eolString(result.eol));
}

function mapAstSummary(summary: AstSummary): SummaryResult {
	return {
		language: summary.language ?? undefined,
		parsed: summary.parsed,
		elided: summary.elided,
		totalLines: summary.total_lines,
		segments: summary.segments.map(segment => ({
			kind: segment.kind,
			startLine: segment.start_line,
			endLine: segment.end_line,
			text: segment.text ?? undefined,
		})),
	};
}

const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

/**
 * Decide whether the kept lines surrounding an elided range collapse to a
 * single brace-pair line in the rendered summary. Returns true when the head
 * line ends with `{` / `(` / `[` and the tail line is the matching closer
 * (optionally followed by terminating punctuation like `;`, `,`, or further
 * closers — e.g. `};`, `})`, `]);`).
 */
function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

function formatSingleLine(
	line: number,
	text: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatHashLine(line, text);
	if (shouldAddLineNumbers) return `${line}|${text}`;
	return text;
}

function formatMergedBraceLine(
	startLine: number,
	endLine: number,
	headText: string,
	tailText: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): { model: string; display: string } {
	const merged = `${headText.trimEnd()} .. ${tailText.trim()}`;
	if (shouldAddHashLines) {
		const start = formatLineHash(startLine, headText);
		const end = formatLineHash(endLine, tailText);
		return { model: `${start}-${end}${HL_BODY_SEP}${merged}`, display: merged };
	}
	if (shouldAddLineNumbers) {
		return { model: `${startLine}-${endLine}|${merged}`, display: merged };
	}
	return { model: merged, display: merged };
}

function countTextLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split(/\r\n|\n|\r/);
	return text.endsWith("\n") || text.endsWith("\r") ? lines.length - 1 : lines.length;
}

function formatResultPath(filePath: string, cwd: string): string {
	return formatPathRelativeToCwd(filePath, cwd);
}

function sanitizePathInMessage(message: string, filePath: string, cwd: string): string {
	return message.replaceAll(filePath, formatResultPath(filePath, cwd));
}

type ReadLinesOptionsWithSourceLimits = ReadLinesOptions & {
	maxLines?: number;
	maxBytes?: number;
};

type ReadLinesResultWithSourceMeta = ReadLinesResult & {
	truncated?: boolean;
};

function getReadLinesTotalLines(result: ReadLinesResult): number | undefined {
	return typeof result.totalLines === "number" ? result.totalLines : undefined;
}
function formatBeyondEndOfFileMessage(lineNumber: number, totalFileLines: number): string {
	const suggestion =
		totalFileLines === 0
			? "The file is empty."
			: `Use :1 to read from the start, or :${totalFileLines} to read the last line.`;
	return `Line ${lineNumber} is beyond end of file (${totalFileLines} lines total). ${suggestion}`;
}

function isReadLinesSourceTruncated(result: ReadLinesResult): boolean {
	return (result as ReadLinesResultWithSourceMeta).truncated === true;
}

/**
 * Number of unanchored context lines to include before/after a user-requested
 * range. Anchor-stale failures are heavily concentrated on edits whose anchors
 * land just outside the most recent read window — a few lines of pre-anchored
 * context covers off-by-one anchor selection without much cost.
 */
const RANGE_CONTEXT_LINES = 3;

/**
 * Expand a [start, end) range with ±RANGE_CONTEXT_LINES context lines on the
 * sides where the user actually constrained the range. A start of 0 (no
 * explicit offset) does not get leading context — that's already an open-ended
 * read from the top.
 */
function expandRangeWithContext(
	requestedStart: number,
	requestedEnd: number,
	totalLines: number,
	expandStart: boolean,
	expandEnd: boolean,
): { startLine: number; endLine: number } {
	return {
		startLine: expandStart ? Math.max(0, requestedStart - RANGE_CONTEXT_LINES) : requestedStart,
		endLine: expandEnd ? Math.min(totalLines, requestedEnd + RANGE_CONTEXT_LINES) : requestedEnd,
	};
}

// Maximum image file size (20MB) - larger images will be rejected to prevent OOM during serialization
const MAX_IMAGE_SIZE = MAX_IMAGE_INPUT_BYTES;
const IMAGE_METADATA_HEADER_BYTES = 256 * 1024;
const GLOB_TIMEOUT_MS = 5000;

function resolveBackendReadPath(filePath: string, cwd: string, backend: Backend): string {
	if (backend.kind === "local") return resolveReadPath(filePath, cwd);
	if (/^\/+$/u.test(filePath)) return cwd;
	if (path.isAbsolute(filePath)) return filePath;
	return path.resolve(cwd, filePath);
}

async function readImageMetadataFromBackend(
	absolutePath: string,
	backend: Backend,
	signal?: AbortSignal,
): Promise<ImageMetadata | null> {
	if (backend.kind === "local") {
		return readImageMetadata(absolutePath);
	}

	const header = await backend.fs.readBlob(absolutePath, {
		range: { start: 0, end: IMAGE_METADATA_HEADER_BYTES - 1 },
		signal,
	});
	return parseImageMetadata(header.bytes);
}

async function readEditableNotebookTextFromBackend(
	absolutePath: string,
	displayPath: string,
	backend: Backend,
	signal?: AbortSignal,
): Promise<string> {
	if (backend.kind === "local") {
		return readEditableNotebookText(absolutePath, displayPath);
	}

	const blob = await backend.fs.readBlob(absolutePath, { signal });
	return readEditableNotebookTextFromBytes(blob.bytes, displayPath);
}

async function convertDocumentFromBackend(
	absolutePath: string,
	extension: string,
	backend: Backend,
	signal?: AbortSignal,
): Promise<MarkitConversionResult> {
	if (backend.kind === "local") {
		return convertFileWithMarkit(absolutePath, signal);
	}

	const blob = await backend.fs.readBlob(absolutePath, { signal });
	return convertBufferWithMarkit(blob.bytes, extension, signal);
}

function isNotFoundError(error: unknown): boolean {
	if (error instanceof RwpError) {
		return error.code === "not-found";
	}
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: string }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Attempt to resolve a non-existent path by finding a unique suffix match within the workspace.
 * Uses a glob suffix pattern so the native engine handles matching directly.
 * Returns null when 0 or >1 candidates match (ambiguous = no auto-resolution).
 */
async function findUniqueSuffixMatch(
	rawPath: string,
	cwd: string,
	backend: Backend,
	signal?: AbortSignal,
): Promise<{ absolutePath: string; displayPath: string } | null> {
	const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (!normalized) return null;

	const timeoutSignal = AbortSignal.timeout(GLOB_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let matches: string[];
	let truncated = false;
	try {
		const result = await untilAborted(combinedSignal, () =>
			backend.fs.glob({
				patterns: [`**/${normalized}`],
				paths: [cwd],
				limit: 1,
				includeHidden: false,
				signal: combinedSignal,
			}),
		);
		truncated = result.truncated;
		matches = result.entries.map(entry => entry.path);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			if (!signal?.aborted) return null;
			throw new ToolAbortError();
		}
		return null;
	}
	if (truncated || matches.length !== 1) return null;

	return {
		absolutePath: path.resolve(cwd, matches[0]),
		displayPath: matches[0],
	};
}

function quoteSqliteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqliteStringLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function findSqliteWhereClauseViolation(where: string): string | null {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let keywordViolation: string | null = null;
	const lower = where.toLowerCase();

	for (let index = 0; index < where.length; index++) {
		const char = where[index]!;
		const next = where[index + 1];
		if (inSingleQuote) {
			if (char === "'" && next === "'") {
				index++;
				continue;
			}
			if (char === "'") inSingleQuote = false;
			continue;
		}
		if (inDoubleQuote) {
			if (char === '"' && next === '"') {
				index++;
				continue;
			}
			if (char === '"') inDoubleQuote = false;
			continue;
		}
		if (char === "'") {
			inSingleQuote = true;
			continue;
		}
		if (char === '"') {
			inDoubleQuote = true;
			continue;
		}
		if (char === ";") return SQLITE_COMMENT_OR_TERMINATOR_ERROR;
		if ((char === "-" && next === "-") || (char === "/" && next === "*") || (char === "*" && next === "/")) {
			return SQLITE_COMMENT_OR_TERMINATOR_ERROR;
		}

		for (const keyword of SQLITE_FORBIDDEN_WHERE_KEYWORDS) {
			if (!lower.startsWith(keyword, index)) continue;
			const before = index === 0 ? "" : lower[index - 1]!;
			const afterIndex = index + keyword.length;
			const after = afterIndex >= lower.length ? "" : lower[afterIndex]!;
			if (!/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after)) {
				keywordViolation = `SQLite where clause cannot contain '${keyword.toUpperCase()}'`;
			}
		}
	}

	return keywordViolation;
}

function validateSqliteWhereClause(where: string | undefined): string | undefined {
	if (!where) return undefined;
	const trimmed = where.trim();
	if (!trimmed) return undefined;
	const violation = findSqliteWhereClauseViolation(trimmed);
	if (violation) {
		throw new ToolError(violation);
	}
	return trimmed;
}

function assertSupportedMime(mimeType: string): asserts mimeType is SupportedImageMime {
	if (isSupportedImageMime(mimeType)) {
		return;
	}
	throw new ToolError(`Unsupported image MIME type '${mimeType}'`);
}

function decodeUtf8Text(bytes: Uint8Array): string | null {
	for (const byte of bytes) {
		if (byte === 0) return null;
	}

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function prependSuffixResolutionNotice(text: string, suffixResolution?: { from: string; to: string }): string {
	if (!suffixResolution) return text;

	const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
	return text ? `${notice}\n${text}` : notice;
}

const readSchema = Type.Object({
	path: Type.String({
		description: 'path or url; append :<sel> for line ranges or raw mode (e.g. "src/foo.ts:50-100")',
		examples: ["src/foo.ts", "src/foo.ts:50-100", "https://example.com/:1-40"],
	}),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	kind?: "file" | "url";
	truncation?: TruncationResult;
	isDirectory?: boolean;
	resolvedPath?: string;
	suffixResolution?: { from: string; to: string };
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: string[];
	meta?: OutputMeta;
	/** Raw text + start line for user-visible TUI rendering, set when content is text-like.
	 * Mirrors the same lines the model receives but without hashline/line-number prefixes,
	 * so the TUI can render the file content with its own gutter without re-parsing the formatted text. */
	displayContent?: { text: string; startLine: number };
	summary?: { lines: number; elidedSpans: number };
}

type ReadParams = ReadToolInput;

/** Parsed representation of a path-embedded selector. */
type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "lines"; startLine: number; endLine: number | undefined; raw?: boolean };

const LINE_RANGE_RE = /^L?(\d+)(?:([-+])L?(\d+))?$/i;

/** Returns true when the selector requested verbatim/raw output (alone or combined with a range). */
function isRawSelector(parsed: ParsedSelector): boolean {
	return parsed.kind === "raw" || (parsed.kind === "lines" && parsed.raw === true);
}

function parseLineRangeChunk(sel: string): { startLine: number; endLine: number | undefined } | null {
	const lineMatch = LINE_RANGE_RE.exec(sel);
	if (!lineMatch) return null;
	const rawStart = Number.parseInt(lineMatch[1]!, 10);
	if (rawStart < 1) {
		throw new ToolError("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	}
	const sep = lineMatch[2];
	const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
	let rawEnd: number | undefined;
	if (sep === "+") {
		if (rhs === undefined || rhs < 1) {
			throw new ToolError(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
		}
		rawEnd = rawStart + rhs - 1;
	} else if (sep === "-") {
		if (rhs === undefined || rhs < rawStart) {
			throw new ToolError(`Invalid range ${rawStart}-${rhs ?? 0}: end must be >= start.`);
		}
		rawEnd = rhs;
	}
	return { startLine: rawStart, endLine: rawEnd };
}

function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };

	// Compound selector: `1-50:raw` or `raw:1-50`. Split into chunks and accept
	// any combination of one line range and the literal `raw`.
	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length === 2) {
			const [a, b] = chunks as [string, string];
			const aIsRaw = a.toLowerCase() === "raw";
			const bIsRaw = b.toLowerCase() === "raw";
			const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
			const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
			if (rangeChunk !== null && rawChunk !== null) {
				const range = parseLineRangeChunk(rangeChunk);
				if (range) {
					return { kind: "lines", startLine: range.startLine, endLine: range.endLine, raw: true };
				}
			}
		}
		// Unrecognized compound — fall through (sqlite/archive/url consume their own colon syntax).
		return { kind: "none" };
	}

	if (sel.toLowerCase() === "raw") return { kind: "raw" };
	const range = parseLineRangeChunk(sel);
	if (range) {
		return { kind: "lines", startLine: range.startLine, endLine: range.endLine };
	}
	// Unrecognized selectors fall through; sqlite/archive/url readers consume their own colon syntax.
	return { kind: "none" };
}

/** Convert a line-range selector to the offset/limit pair used by internal pagination. */
function selToOffsetLimit(parsed: ParsedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const limit = parsed.endLine !== undefined ? parsed.endLine - parsed.startLine + 1 : undefined;
		return { offset: parsed.startLine, limit };
	}
	return {};
}

interface ResolvedArchiveReadPath {
	absolutePath: string;
	archiveSubPath: string;
	suffixResolution?: { from: string; to: string };
}

interface ResolvedSqliteReadPath {
	absolutePath: string;
	sqliteSubPath: string;
	queryString: string;
	suffixResolution?: { from: string; to: string };
}

/**
 * Read tool implementation.
 *
 * Reads files with support for images, converted documents (via markit), and text.
 * Directories return a formatted listing with modification times.
 */
export class ReadTool implements AgentTool<typeof readSchema, ReadToolDetails> {
	readonly name = "read";
	readonly label = "Read";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters = readSchema;
	readonly nonAbortable = true;
	readonly strict = true;

	readonly #autoResizeImages: boolean;
	readonly #defaultLimit: number;
	readonly #inspectImageEnabled: boolean;

	constructor(private readonly session: ToolSession) {
		const displayMode = resolveFileDisplayMode(session);
		this.#autoResizeImages = session.settings.get("images.autoResize");
		this.#defaultLimit = Math.max(
			1,
			Math.min(session.settings.get("read.defaultLimit") ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES),
		);
		this.#inspectImageEnabled = session.settings.get("inspect_image.enabled");
		this.description = prompt.render(readDescription, {
			DEFAULT_LIMIT: String(this.#defaultLimit),
			DEFAULT_MAX_LINES: String(DEFAULT_MAX_LINES),
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
		});
	}

	async #resolveArchiveReadPath(readPath: string, signal?: AbortSignal): Promise<ResolvedArchiveReadPath | null> {
		const backend = this.session.backend;
		const candidates = parseArchivePathCandidates(readPath);
		for (const candidate of candidates) {
			let absolutePath = resolveBackendReadPath(candidate.archivePath, this.session.cwd, backend);
			let suffixResolution: { from: string; to: string } | undefined;

			try {
				const stat = await backend.fs.stat(absolutePath, { signal });
				if (stat.kind === "dir") continue;
				return {
					absolutePath,
					archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
					suffixResolution,
				};
			} catch (error) {
				if (!isNotFoundError(error)) continue;

				const suffixMatch = await findUniqueSuffixMatch(candidate.archivePath, this.session.cwd, backend, signal);
				if (!suffixMatch) continue;

				try {
					const retryStat = await backend.fs.stat(suffixMatch.absolutePath, { signal });
					if (retryStat.kind === "dir") continue;

					absolutePath = suffixMatch.absolutePath;
					suffixResolution = { from: candidate.archivePath, to: suffixMatch.displayPath };
					return {
						absolutePath,
						archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
						suffixResolution,
					};
				} catch (retryError) {
					if (!isNotFoundError(retryError)) {
						throw retryError;
					}
				}
			}
		}

		return null;
	}

	async #resolveSqliteReadPath(readPath: string, signal?: AbortSignal): Promise<ResolvedSqliteReadPath | null> {
		const backend = this.session.backend;
		const candidates = parseSqlitePathCandidates(readPath);
		const sqliteProbeCache = new Map<string, Promise<boolean>>();
		const isSqlitePath = (candidatePath: string): Promise<boolean> => {
			let probe = sqliteProbeCache.get(candidatePath);
			if (!probe) {
				probe = isSqliteFile(candidatePath, backend);
				sqliteProbeCache.set(candidatePath, probe);
			}
			return probe;
		};
		for (const candidate of candidates) {
			let absolutePath = resolveBackendReadPath(candidate.sqlitePath, this.session.cwd, backend);
			let suffixResolution: { from: string; to: string } | undefined;

			try {
				const stat = await backend.fs.stat(absolutePath, { signal });
				if (stat.kind !== "file") continue;
				if (!(await isSqlitePath(absolutePath))) continue;

				return {
					absolutePath,
					sqliteSubPath: candidate.subPath,
					queryString: candidate.queryString,
					suffixResolution,
				};
			} catch (error) {
				if (!isNotFoundError(error)) continue;

				const suffixMatch = await findUniqueSuffixMatch(candidate.sqlitePath, this.session.cwd, backend, signal);
				if (!suffixMatch) continue;

				try {
					const retryStat = await backend.fs.stat(suffixMatch.absolutePath, { signal });
					if (retryStat.kind !== "file") continue;
					if (!(await isSqlitePath(suffixMatch.absolutePath))) continue;

					absolutePath = suffixMatch.absolutePath;
					suffixResolution = { from: candidate.sqlitePath, to: suffixMatch.displayPath };
					return {
						absolutePath,
						sqliteSubPath: candidate.subPath,
						queryString: candidate.queryString,
						suffixResolution,
					};
				} catch (retryError) {
					if (!isNotFoundError(retryError)) {
						throw retryError;
					}
				}
			}
		}

		return null;
	}

	#buildInMemoryTextResult(
		text: string,
		offset: number | undefined,
		limit: number | undefined,
		options: {
			details?: ReadToolDetails;
			sourcePath?: string;
			sourceUrl?: string;
			sourceInternal?: string;
			entityLabel: string;
			ignoreResultLimits?: boolean;
			raw?: boolean;
			immutable?: boolean;
		},
	): AgentToolResult<ReadToolDetails> {
		const displayMode = resolveFileDisplayMode(this.session, { raw: options.raw, immutable: options.immutable });
		const details = options.details ?? {};
		const allLines = text.split("\n");
		const totalLines = allLines.length;
		// User-requested 0-indexed range start. Lines BEFORE this are leading
		// context (added below if offset is explicit).
		const requestedStart = offset ? Math.max(0, offset - 1) : 0;
		const ignoreResultLimits = options.ignoreResultLimits ?? false;
		const requestedEnd =
			limit !== undefined && !ignoreResultLimits
				? Math.min(requestedStart + limit, allLines.length)
				: allLines.length;
		// Expand only on sides the user actually constrained: leading context
		// when offset>1, trailing context when a finite limit was set.
		const expanded = expandRangeWithContext(
			requestedStart,
			requestedEnd,
			allLines.length,
			offset !== undefined && offset > 1,
			limit !== undefined && !ignoreResultLimits,
		);
		const startLine = expanded.startLine;
		const endLineExpanded = expanded.endLine;
		const startLineDisplay = startLine + 1;

		const resultBuilder = toolResult(details);
		if (options.sourcePath) {
			resultBuilder.sourcePath(options.sourcePath);
		}
		if (options.sourceUrl) {
			resultBuilder.sourceUrl(options.sourceUrl);
		}
		if (options.sourceInternal) {
			resultBuilder.sourceInternal(options.sourceInternal);
		}

		if (requestedStart >= allLines.length) {
			const suggestion =
				allLines.length === 0
					? `The ${options.entityLabel} is empty.`
					: `Use :1 to read from the start, or :${allLines.length} to read the last line.`;
			return resultBuilder
				.text(
					`Line ${requestedStart + 1} is beyond end of ${options.entityLabel} (${allLines.length} lines total). ${suggestion}`,
				)
				.done();
		}

		const endLine = endLineExpanded;
		const selectedContent = allLines.slice(startLine, endLine).join("\n");
		const userLimitedLines = limit !== undefined && !ignoreResultLimits ? endLine - startLine : undefined;
		const truncation = ignoreResultLimits ? noTruncResult(selectedContent) : truncateHead(selectedContent);

		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
		const formatText = (content: string, startNum: number): string => {
			details.displayContent = { text: content, startLine: startNum };
			return formatTextWithMode(content, startNum, shouldAddHashLines, shouldAddLineNumbers);
		};

		let outputText: string;
		let truncationInfo:
			| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
			| undefined;

		if (truncation.firstLineExceedsLimit) {
			const firstLine = allLines[startLine] ?? "";
			const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
			const snippet = truncateHeadBytes(firstLine, DEFAULT_MAX_BYTES);

			if (shouldAddHashLines) {
				outputText = `[Line ${startLineDisplay} is ${formatBytes(
					firstLineBytes,
				)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`;
			} else {
				outputText = formatText(snippet.text, startLineDisplay);
			}

			if (snippet.text.length === 0) {
				outputText = `[Line ${startLineDisplay} is ${formatBytes(
					firstLineBytes,
				)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Unable to display a valid UTF-8 snippet.]`;
			}

			details.truncation = truncation;
			truncationInfo = {
				result: truncation,
				options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
			};
		} else if (truncation.truncated) {
			outputText = formatText(truncation.content, startLineDisplay);
			details.truncation = truncation;
			truncationInfo = {
				result: truncation,
				options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
			};
		} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
			const remaining = allLines.length - (startLine + userLimitedLines);
			const nextOffset = startLine + userLimitedLines + 1;

			outputText = formatText(selectedContent, startLineDisplay);
			outputText += `\n\n[${remaining} more lines in ${options.entityLabel}. Use :${nextOffset} to continue]`;
		} else {
			outputText = formatText(truncation.content, startLineDisplay);
		}

		resultBuilder.text(outputText);
		if (truncationInfo) {
			resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
		}
		return resultBuilder.done();
	}

	async #readArchiveDirectory(
		archive: ArchiveReader,
		archivePath: string,
		subPath: string,
		limit: number | undefined,
		details: ReadToolDetails,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const DEFAULT_LIMIT = 500;
		const effectiveLimit = limit ?? DEFAULT_LIMIT;
		const entries = archive.listDirectory(subPath);

		const listLimit = applyListLimit(entries, { limit: effectiveLimit });
		const limitedEntries = listLimit.items;
		const limitMeta = listLimit.meta;

		const results: string[] = [];
		for (const entry of limitedEntries) {
			throwIfAborted(signal);
			if (entry.isDirectory) {
				results.push(`${entry.name}/`);
				continue;
			}

			const sizeSuffix = entry.size > 0 ? ` (${formatBytes(entry.size)})` : "";
			results.push(`${entry.name}${sizeSuffix}`);
		}

		const output = results.length > 0 ? results.join("\n") : "(empty archive directory)";
		const text = prependSuffixResolutionNotice(output, details.suffixResolution);
		const truncation = truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER });
		const directoryDetails: ReadToolDetails = { ...details, isDirectory: true };
		const resultBuilder = toolResult<ReadToolDetails>(directoryDetails).text(truncation.content);
		resultBuilder.sourcePath(formatResultPath(archivePath, this.session.cwd)).limits({
			resultLimit: limitMeta.resultLimit?.reached,
		});
		if (truncation.truncated) {
			directoryDetails.truncation = truncation;
			resultBuilder.truncation(truncation, { direction: "head" });
		}
		return resultBuilder.done();
	}

	async #readArchive(
		readPath: string,
		offset: number | undefined,
		limit: number | undefined,
		resolvedArchivePath: ResolvedArchiveReadPath,
		signal?: AbortSignal,
		options?: { raw?: boolean },
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);
		const archive = await openArchive(resolvedArchivePath.absolutePath, this.session, signal);
		throwIfAborted(signal);

		const displayArchivePath = formatResultPath(resolvedArchivePath.absolutePath, this.session.cwd);
		const details: ReadToolDetails = {
			resolvedPath: displayArchivePath,
			suffixResolution: resolvedArchivePath.suffixResolution,
		};

		const node = archive.getNode(resolvedArchivePath.archiveSubPath);
		if (!node) {
			throw new ToolError(`Path '${readPath}' not found inside archive`);
		}

		if (node.isDirectory) {
			return this.#readArchiveDirectory(
				archive,
				resolvedArchivePath.absolutePath,
				resolvedArchivePath.archiveSubPath,
				limit,
				details,
				signal,
			);
		}

		const entry = await archive.readFile(resolvedArchivePath.archiveSubPath);
		const text = decodeUtf8Text(entry.bytes);
		if (text === null) {
			return toolResult<ReadToolDetails>(details)
				.text(
					prependSuffixResolutionNotice(
						`[Cannot read binary archive entry '${entry.path}' (${formatBytes(entry.size)})]`,
						resolvedArchivePath.suffixResolution,
					),
				)
				.sourcePath(displayArchivePath)
				.done();
		}

		const result = this.#buildInMemoryTextResult(text, offset, limit, {
			details,
			sourcePath: displayArchivePath,
			entityLabel: "archive entry",
			raw: options?.raw,
		});
		const firstText = result.content.find((content): content is TextContent => content.type === "text");
		if (firstText) {
			firstText.text = prependSuffixResolutionNotice(firstText.text, resolvedArchivePath.suffixResolution);
		}
		return result;
	}

	async #readSqlite(
		resolvedSqlitePath: ResolvedSqliteReadPath,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);

		const selectorInput = {
			subPath: resolvedSqlitePath.sqliteSubPath,
			queryString: resolvedSqlitePath.queryString,
		};
		const selector = parseSqliteSelector(selectorInput.subPath, selectorInput.queryString);
		const displaySqlitePath = formatResultPath(resolvedSqlitePath.absolutePath, this.session.cwd);
		const details: ReadToolDetails = {
			resolvedPath: displaySqlitePath,
			suffixResolution: resolvedSqlitePath.suffixResolution,
		};
		const backend = this.session.backend;

		try {
			switch (selector.kind) {
				case "list": {
					const listResult = await backend.sqlite.read({
						path: resolvedSqlitePath.absolutePath,
						signal,
					});
					if (!("tables" in listResult)) {
						throw new ToolError("SQLite table listing returned rows instead of tables");
					}
					const listLimit = applyListLimit(
						listResult.tables.map(table => ({ name: table.name, rowCount: table.row_count })),
						{ limit: 500 },
					);
					const output = prependSuffixResolutionNotice(
						renderTableList(listLimit.items),
						resolvedSqlitePath.suffixResolution,
					);
					const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
					details.truncation = truncation.truncated ? truncation : undefined;
					const resultBuilder = toolResult<ReadToolDetails>(details)
						.text(truncation.content)
						.sourcePath(displaySqlitePath)
						.limits({ resultLimit: listLimit.meta.resultLimit?.reached });
					if (truncation.truncated) {
						resultBuilder.truncation(truncation, { direction: "head" });
					}
					return resultBuilder.done();
				}
				case "schema": {
					const sampleRows = await backend.sqlite.read({
						path: resolvedSqlitePath.absolutePath,
						table: selector.table,
						limit: selector.sampleLimit,
						offset: 0,
						signal,
					});
					if ("tables" in sampleRows) {
						throw new ToolError("SQLite schema lookup returned table listing");
					}
					const schemaSqlResult = await backend.sqlite.read({
						path: resolvedSqlitePath.absolutePath,
						q: `SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name = ${quoteSqliteStringLiteral(selector.table)} LIMIT 1`,
						signal,
					});
					if ("tables" in schemaSqlResult) {
						throw new ToolError("SQLite schema query returned table listing");
					}
					const createSql = schemaSqlResult.rows[0]?.sql;
					if (typeof createSql !== "string" || createSql.length === 0) {
						throw new ToolError(`SQLite table '${selector.table}' not found`);
					}
					const countResult = await backend.sqlite.read({
						path: resolvedSqlitePath.absolutePath,
						q: `SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(selector.table)}`,
						signal,
					});
					if ("tables" in countResult) {
						throw new ToolError("SQLite count query returned table listing");
					}
					const totalCountValue = countResult.rows[0]?.count;
					const totalCount = typeof totalCountValue === "number" ? totalCountValue : Number(totalCountValue ?? 0);
					let output = renderSchema(createSql, {
						columns: sampleRows.columns.map(column => column.name),
						rows: sampleRows.rows,
					});
					if (sampleRows.rows.length < totalCount) {
						const remaining = totalCount - sampleRows.rows.length;
						output += `\n[${remaining} more rows; append :${selector.table}?limit=20&offset=${sampleRows.rows.length} to the database path to continue]`;
					}
					return toolResult<ReadToolDetails>(details)
						.text(prependSuffixResolutionNotice(output, resolvedSqlitePath.suffixResolution))
						.sourcePath(displaySqlitePath)
						.done();
				}
				case "row": {
					const rowResult = await backend.sqlite.read({
						path: resolvedSqlitePath.absolutePath,
						table: selector.table,
						key: selector.key,
						signal,
					});
					if ("tables" in rowResult) {
						throw new ToolError("SQLite row lookup returned table listing");
					}
					const row = rowResult.rows[0];
					if (!row) {
						return toolResult<ReadToolDetails>(details)
							.text(
								prependSuffixResolutionNotice(
									`No row found in table '${selector.table}' for key '${selector.key}'.`,
									resolvedSqlitePath.suffixResolution,
								),
							)
							.sourcePath(displaySqlitePath)
							.done();
					}
					return toolResult<ReadToolDetails>(details)
						.text(prependSuffixResolutionNotice(renderRow(row), resolvedSqlitePath.suffixResolution))
						.sourcePath(displaySqlitePath)
						.done();
				}
				case "query": {
					const validatedWhere = validateSqliteWhereClause(selector.where);
					const page = await backend.sqlite.read({
						path: resolvedSqlitePath.absolutePath,
						table: selector.table,
						where: validatedWhere,
						order: selector.order,
						limit: selector.limit,
						offset: selector.offset,
						signal,
					});
					if ("tables" in page) {
						throw new ToolError("SQLite table query returned table listing");
					}
					const whereClause = validatedWhere ? ` WHERE ${validatedWhere}` : "";
					const countResult = await backend.sqlite.read({
						path: resolvedSqlitePath.absolutePath,
						q: `SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(selector.table)}${whereClause}`,
						signal,
					});
					if ("tables" in countResult) {
						throw new ToolError("SQLite count query returned table listing");
					}
					const totalCountValue = countResult.rows[0]?.count;
					const totalCount = typeof totalCountValue === "number" ? totalCountValue : Number(totalCountValue ?? 0);
					return toolResult<ReadToolDetails>(details)
						.text(
							prependSuffixResolutionNotice(
								renderTable(
									page.columns.map(column => column.name),
									page.rows,
									{
										totalCount,
										offset: selector.offset,
										limit: selector.limit,
										table: selector.table,
										dbPath: displaySqlitePath,
									},
								),
								resolvedSqlitePath.suffixResolution,
							),
						)
						.sourcePath(displaySqlitePath)
						.done();
				}
				case "raw": {
					const result = await backend.sqlite.read({
						path: resolvedSqlitePath.absolutePath,
						q: selector.sql,
						signal,
					});
					if ("tables" in result) {
						throw new ToolError("SQLite raw query returned table listing");
					}
					return toolResult<ReadToolDetails>(details)
						.text(
							prependSuffixResolutionNotice(
								renderTable(
									result.columns.map(column => column.name),
									result.rows,
									{
										totalCount: result.rows.length,
										offset: 0,
										limit: result.rows.length || DEFAULT_MAX_LINES,
										table: "query",
										dbPath: displaySqlitePath,
									},
								),
								resolvedSqlitePath.suffixResolution,
							),
						)
						.sourcePath(displaySqlitePath)
						.done();
				}
			}

			throw new ToolError("Unsupported SQLite selector");
		} catch (error) {
			if (error instanceof ToolError) {
				throw error;
			}
			throw new ToolError(
				`SQLite read failed for ${displaySqlitePath}: ${sanitizePathInMessage(
					error instanceof Error ? error.message : String(error),
					resolvedSqlitePath.absolutePath,
					this.session.cwd,
				)}`,
			);
		}
	}

	async #trySummarize(absolutePath: string, fileSize: number, signal?: AbortSignal): Promise<SummaryResult | null> {
		if (fileSize > MAX_SUMMARY_BYTES) return null;

		const backend = this.session.backend;
		const minBodyLines = this.session.settings.get("read.summarize.minBodyLines");
		const minCommentLines = this.session.settings.get("read.summarize.minCommentLines");
		const readAstOptions: ReadAstOptions = {
			language: getLanguageFromPath(absolutePath),
			signal,
			minBodyLines,
			minCommentLines,
		};
		throwIfAborted(signal);
		const summaryProbe = await backend.fs.readLines(absolutePath, {
			encoding: "utf-8",
			maxLines: MAX_SUMMARY_LINES + 1,
			signal,
		});
		throwIfAborted(signal);
		const totalLines = getReadLinesTotalLines(summaryProbe) ?? summaryProbe.lines.length;
		if (totalLines > MAX_SUMMARY_LINES || isReadLinesSourceTruncated(summaryProbe)) return null;

		return mapAstSummary(await backend.fs.readAst(absolutePath, readAstOptions));
	}

	#renderSummary(summary: SummaryResult): {
		text: string;
		displayText: string;
		elidedSpans: number;
	} {
		const displayMode = resolveFileDisplayMode(this.session);
		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

		// Flatten segments into per-line units so we can merge a kept-head /
		// elided / kept-tail sandwich into a single brace-pair line when the
		// boundary lines look like `… {` and `}` (or matching variants).
		type Unit =
			| { kind: "line"; line: number; text: string }
			| { kind: "elided"; startLine: number; endLine: number }
			| {
					kind: "merged";
					startLine: number;
					endLine: number;
					headText: string;
					tailText: string;
			  };

		const raw: Unit[] = [];
		for (const segment of summary.segments) {
			if (segment.kind === "elided") {
				raw.push({ kind: "elided", startLine: segment.startLine, endLine: segment.endLine });
				continue;
			}
			const text = segment.text ?? "";
			if (text.length === 0) continue;
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				raw.push({ kind: "line", line: segment.startLine + i, text: lines[i] });
			}
		}

		const units: Unit[] = [];
		let i = 0;
		while (i < raw.length) {
			const cur = raw[i];
			if (cur.kind === "elided") {
				const prev = units.length > 0 ? units[units.length - 1] : null;
				const next = i + 1 < raw.length ? raw[i + 1] : null;
				if (prev?.kind === "line" && next?.kind === "line" && canMergeBracePair(prev.text, next.text)) {
					units.pop();
					units.push({
						kind: "merged",
						startLine: prev.line,
						endLine: next.line,
						headText: prev.text,
						tailText: next.text,
					});
					i += 2;
					continue;
				}
			}
			units.push(cur);
			i++;
		}

		const modelParts: string[] = [];
		const displayParts: string[] = [];
		let elidedSpans = 0;
		for (const unit of units) {
			if (unit.kind === "elided") {
				modelParts.push("...");
				displayParts.push("...");
				elidedSpans++;
				continue;
			}
			if (unit.kind === "merged") {
				const formatted = formatMergedBraceLine(
					unit.startLine,
					unit.endLine,
					unit.headText,
					unit.tailText,
					shouldAddHashLines,
					shouldAddLineNumbers,
				);
				modelParts.push(formatted.model);
				displayParts.push(formatted.display);
				elidedSpans++;
				continue;
			}
			modelParts.push(formatSingleLine(unit.line, unit.text, shouldAddHashLines, shouldAddLineNumbers));
			displayParts.push(unit.text);
		}

		return { text: modelParts.join("\n"), displayText: displayParts.join("\n"), elidedSpans };
	}

	async execute(
		_toolCallId: string,
		params: ReadParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ReadToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<ReadToolDetails>> {
		let { path: readPath } = params;
		if (readPath.startsWith("file://")) {
			readPath = expandPath(readPath);
		}
		const displayMode = resolveFileDisplayMode(this.session);

		const parsedUrlTarget = parseReadUrlTarget(readPath);
		if (parsedUrlTarget) {
			if (!this.session.settings.get("fetch.enabled")) {
				throw new ToolError("URL reads are disabled by settings.");
			}
			if (parsedUrlTarget.offset !== undefined || parsedUrlTarget.limit !== undefined) {
				const cached = await loadReadUrlCacheEntry(
					this.session,
					{ path: parsedUrlTarget.path, raw: parsedUrlTarget.raw },
					signal,
					{
						ensureArtifact: true,
						preferCached: true,
					},
				);
				return this.#buildInMemoryTextResult(cached.output, parsedUrlTarget.offset, parsedUrlTarget.limit, {
					details: { ...cached.details },
					sourceUrl: cached.details.finalUrl,
					entityLabel: "URL output",
					immutable: true,
				});
			}
			return executeReadUrl(this.session, { path: parsedUrlTarget.path, raw: parsedUrlTarget.raw }, signal);
		}

		// Handle internal URLs (agent://, artifact://, memory://, skill://, rule://, local://, mcp://)
		const internalTarget = splitPathAndSel(readPath);
		const internalRouter = InternalUrlRouter.instance();
		if (internalRouter.canHandle(internalTarget.path)) {
			const parsed = parseSel(internalTarget.sel);
			const { offset, limit } = selToOffsetLimit(parsed);
			return this.#handleInternalUrl(internalTarget.path, offset, limit, { raw: isRawSelector(parsed) });
		}

		const archivePath = await this.#resolveArchiveReadPath(readPath, signal);
		if (archivePath) {
			const archiveSubPath = splitPathAndSel(archivePath.archiveSubPath);
			const archiveParsed = parseSel(archiveSubPath.sel);
			const { offset, limit } = selToOffsetLimit(archiveParsed);
			return this.#readArchive(
				readPath,
				offset,
				limit,
				{ ...archivePath, archiveSubPath: archiveSubPath.path },
				signal,
				{ raw: isRawSelector(archiveParsed) },
			);
		}

		const sqlitePath = await this.#resolveSqliteReadPath(readPath, signal);
		if (sqlitePath) {
			return this.#readSqlite(sqlitePath, signal);
		}
		const backend = this.session.backend;

		const localTarget = splitPathAndSel(readPath);
		const localReadPath = localTarget.path;
		const parsed = parseSel(localTarget.sel);

		let absolutePath = resolveBackendReadPath(localReadPath, this.session.cwd, backend);
		let suffixResolution: { from: string; to: string } | undefined;

		let isDirectory = false;
		let fileSize = 0;
		try {
			const stat = await backend.fs.stat(absolutePath, { signal });
			fileSize = stat.size;
			isDirectory = stat.kind === "dir";
		} catch (error) {
			if (isNotFoundError(error)) {
				const suffixMatch = await findUniqueSuffixMatch(localReadPath, this.session.cwd, backend, signal);
				if (suffixMatch) {
					try {
						const retryStat = await backend.fs.stat(suffixMatch.absolutePath, { signal });
						absolutePath = suffixMatch.absolutePath;
						fileSize = retryStat.size;
						isDirectory = retryStat.kind === "dir";
						suffixResolution = { from: localReadPath, to: suffixMatch.displayPath };
					} catch {
						// Suffix match candidate no longer stats — fall through to error path
					}
				}

				if (!suffixResolution) {
					throw new ToolError(`Path '${localReadPath}' not found`);
				}
			} else {
				throw error;
			}
		}

		const displayPath = formatResultPath(absolutePath, this.session.cwd);
		if (isDirectory) {
			const dirResult = await this.#readDirectory(absolutePath, selToOffsetLimit(parsed).limit, signal);
			if (suffixResolution) {
				dirResult.details ??= {};
				dirResult.details.suffixResolution = suffixResolution;
			}
			return dirResult;
		}

		const imageMetadata = await readImageMetadataFromBackend(absolutePath, backend, signal);
		const mimeType = imageMetadata?.mimeType;
		const ext = path.extname(absolutePath).toLowerCase();
		const _hasEditTool = this.session.hasEditTool ?? true;
		const _language = getLanguageFromPath(absolutePath);
		const shouldConvertWithMarkit = CONVERTIBLE_EXTENSIONS.has(ext);
		// Read the file based on type
		let content: Array<TextContent | ImageContent> | undefined;
		let details: ReadToolDetails = {};
		let sourcePath: string | undefined;
		let truncationInfo:
			| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
			| undefined;

		if (mimeType) {
			assertSupportedMime(mimeType);
			if (this.#inspectImageEnabled) {
				const metadata = imageMetadata;
				const outputMime = metadata?.mimeType ?? mimeType;
				const outputBytes = fileSize;
				const metadataLines = [
					"Image metadata:",
					`- MIME: ${outputMime}`,
					`- Bytes: ${outputBytes} (${formatBytes(outputBytes)})`,
					metadata?.width !== undefined && metadata.height !== undefined
						? `- Dimensions: ${metadata.width}x${metadata.height}`
						: "- Dimensions: unknown",
					metadata?.channels !== undefined ? `- Channels: ${metadata.channels}` : "- Channels: unknown",
					metadata?.hasAlpha === true
						? "- Alpha: yes"
						: metadata?.hasAlpha === false
							? "- Alpha: no"
							: "- Alpha: unknown",
					"",
					`If you want to analyze the image, call inspect_image with path="${formatPathRelativeToCwd(
						absolutePath,
						this.session.cwd,
					)}" and a question describing what to inspect and the desired output format.`,
				];
				content = [{ type: "text", text: metadataLines.join("\n") }];
				details = {};
				sourcePath = displayPath;
			} else {
				if (fileSize > MAX_IMAGE_SIZE) {
					const sizeStr = formatBytes(fileSize);
					const maxStr = formatBytes(MAX_IMAGE_SIZE);
					throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
				}
				const blob = await backend.fs.readBlob(absolutePath, { signal });

				let image = {
					type: "image",
					data: Buffer.from(blob.bytes).toString("base64"),
					mimeType,
				} satisfies ImageContent;
				let textNote = `Read image file [${mimeType}]`;

				if (this.#autoResizeImages) {
					try {
						const resized = await resizeImage(image);
						const narrowedMime = resized.mimeType;
						assertSupportedMime(narrowedMime);
						image = {
							type: "image",
							data: Buffer.from(resized.buffer).toString("base64"),
							mimeType: narrowedMime,
						};
						const dimensionNote = formatDimensionNote(resized);
						if (dimensionNote) {
							textNote += `\n${dimensionNote}`;
						}
					} catch {
						// keep original image when resize fails
					}
				}

				content = [{ type: "text", text: textNote }, image];
				details = {};
				sourcePath = displayPath;
			}
		} else if (isNotebookPath(absolutePath) && !isRawSelector(parsed)) {
			const { offset, limit } = selToOffsetLimit(parsed);
			return this.#buildInMemoryTextResult(
				await readEditableNotebookTextFromBackend(absolutePath, localReadPath, backend, signal),
				offset,
				limit,
				{
					details: { resolvedPath: displayPath },
					sourcePath: displayPath,
					entityLabel: "notebook",
				},
			);
		} else if (shouldConvertWithMarkit) {
			// Convert document via markit.
			const result = await convertDocumentFromBackend(absolutePath, ext, backend, signal);
			if (result.ok) {
				// Apply truncation to converted content
				const truncation = truncateHead(result.content);
				const outputText = truncation.content;

				details = { truncation };
				sourcePath = displayPath;
				truncationInfo = { result: truncation, options: { direction: "head", startLine: 1 } };

				content = [{ type: "text", text: outputText }];
			} else if (result.error) {
				content = [{ type: "text", text: `[Cannot read ${ext} file: ${result.error || "conversion failed"}]` }];
			} else {
				content = [{ type: "text", text: `[Cannot read ${ext} file: conversion failed]` }];
			}
		} else {
			if (
				parsed.kind === "none" &&
				this.session.settings.get("read.summarize.enabled") &&
				(this.session.settings.get("read.summarize.prose") || !PROSE_SUMMARY_EXTENSIONS.has(ext))
			) {
				const summary = await this.#trySummarize(absolutePath, fileSize, signal);
				if (summary?.parsed && summary.elided) {
					const renderedSummary = this.#renderSummary(summary);
					details = {
						displayContent: { text: renderedSummary.displayText, startLine: 1 },
						summary: {
							lines: countTextLines(renderedSummary.text),
							elidedSpans: renderedSummary.elidedSpans,
						},
					};

					sourcePath = displayPath;
					content = [{ type: "text", text: renderedSummary.text }];
				}
			}

			if (!content) {
				// Raw text or line-range mode
				const { offset, limit } = selToOffsetLimit(parsed);
				if (parsed.kind === "lines") {
					const requestedStart = Math.max(0, parsed.startLine - 1);
					const leadingContext = parsed.startLine > 1 ? Math.min(requestedStart, RANGE_CONTEXT_LINES) : 0;
					const trailingContext = RANGE_CONTEXT_LINES;
					const startLine = requestedStart - leadingContext;
					const effectiveLimit = limit ?? this.#defaultLimit;
					const maxLinesToCollect = Math.min(effectiveLimit + leadingContext + trailingContext, DEFAULT_MAX_LINES);
					const maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512);
					const fileRead = await backend.fs.readLines(absolutePath, {
						encoding: "utf-8",
						range: {
							start: startLine + 1,
							end: startLine + maxLinesToCollect + 1,
						},
						signal,
					});
					if (fileRead.lines.length === 0) {
						const totalFileLines = getReadLinesTotalLines(fileRead);
						const message =
							totalFileLines === undefined
								? `Line ${requestedStart + 1} is beyond end of file.`
								: formatBeyondEndOfFileMessage(requestedStart + 1, totalFileLines);
						return toolResult<ReadToolDetails>({ resolvedPath: displayPath, suffixResolution })
							.text(message)
							.done();
					}

					const hasMoreLines = fileRead.lines.length > maxLinesToCollect;
					const visibleLines = hasMoreLines ? fileRead.lines.slice(0, maxLinesToCollect) : fileRead.lines;
					const selectedContentFull = visibleLines.join("\n");
					const truncatedSelection = truncateHead(selectedContentFull, {
						maxLines: maxLinesToCollect,
						maxBytes: maxBytesForRead,
					});
					const collectedLines =
						truncatedSelection.content.length === 0 ? [] : truncatedSelection.content.split("\n");
					const collectedBytes = truncatedSelection.outputBytes;
					const stoppedByByteLimit = truncatedSelection.truncatedBy === "bytes";
					const firstLineText = visibleLines[0] ?? "";
					const firstLineByteLength = Buffer.byteLength(firstLineText, "utf-8");
					const firstLinePreview =
						truncatedSelection.firstLineExceedsLimit && firstLineText.length > 0
							? truncateHeadBytes(firstLineText, maxBytesForRead)
							: undefined;
					const truncation: TruncationResult = {
						content: collectedLines.join("\n"),
						truncated: stoppedByByteLimit,
						truncatedBy: stoppedByByteLimit ? "bytes" : undefined,
						totalLines: visibleLines.length,
						totalBytes: Buffer.byteLength(selectedContentFull, "utf-8"),
						outputLines: collectedLines.length,
						outputBytes: collectedBytes,
						lastLinePartial: false,
						firstLineExceedsLimit: firstLineByteLength > maxBytesForRead,
					};

					if (collectedLines.length > 0 && !truncation.firstLineExceedsLimit) {
						getFileReadCache(this.session).recordContiguous(absolutePath, fileRead.startLine, collectedLines);
					}

					const isRawMode = isRawSelector(parsed);
					const shouldAddHashLines = !isRawMode && displayMode.hashLines;
					const shouldAddLineNumbers = isRawMode ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
					let capturedDisplayContent: { text: string; startLine: number } | undefined;
					const formatText = (text: string, startNum: number): string => {
						capturedDisplayContent = { text, startLine: startNum };
						return formatTextWithMode(text, startNum, shouldAddHashLines, shouldAddLineNumbers);
					};

					let outputText: string;
					if (truncation.firstLineExceedsLimit) {
						const snippet = firstLinePreview ?? { text: "", bytes: 0 };
						if (shouldAddHashLines) {
							outputText = `[Line ${fileRead.startLine} is ${formatBytes(
								firstLineByteLength,
							)}, exceeds ${formatBytes(maxBytesForRead)} limit. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`;
						} else {
							outputText = formatText(snippet.text, fileRead.startLine);
						}
						if (snippet.text.length === 0) {
							outputText = `[Line ${fileRead.startLine} is ${formatBytes(
								firstLineByteLength,
							)}, exceeds ${formatBytes(maxBytesForRead)} limit. Unable to display a valid UTF-8 snippet.]`;
						}
						details = { truncation };
						sourcePath = displayPath;
						truncationInfo = {
							result: truncation,
							options: { direction: "head", startLine: fileRead.startLine },
						};
					} else {
						outputText = formatText(truncation.content, fileRead.startLine);
						if (truncation.truncated) {
							details = { truncation };
							sourcePath = displayPath;
							truncationInfo = {
								result: truncation,
								options: { direction: "head", startLine: fileRead.startLine },
							};
						} else {
							details = {};
							sourcePath = displayPath;
						}
						if (hasMoreLines) {
							const nextOffset = fileRead.startLine + visibleLines.length;
							outputText += `\n\n[More lines in file. Use :${nextOffset} to continue]`;
						}
					}

					if (capturedDisplayContent) {
						details.displayContent = capturedDisplayContent;
					}

					content = [{ type: "text", text: outputText }];
				} else {
					const readLinesOptions: ReadLinesOptionsWithSourceLimits = {
						encoding: "utf-8",
						maxLines: DEFAULT_MAX_LINES,
						maxBytes: DEFAULT_MAX_BYTES,
						signal,
					};
					let fileRead = await backend.fs.readLines(absolutePath, readLinesOptions);
					let sourceTruncated = isReadLinesSourceTruncated(fileRead);
					let sourceWindowStart = 0;
					let allLinesText = readLinesResultToText(fileRead);
					let allLines = allLinesText.split(/\r\n|\n|\r/);
					const requestedStart = offset ? Math.max(0, offset - 1) : 0;

					if (offset !== undefined && sourceTruncated && requestedStart >= allLines.length) {
						fileRead = await backend.fs.readLines(absolutePath, {
							encoding: "utf-8",
							range: {
								start: offset,
								end: offset + DEFAULT_MAX_LINES - 1,
							},
							signal,
						});
						sourceTruncated = isReadLinesSourceTruncated(fileRead);
						sourceWindowStart = requestedStart;
						allLinesText = readLinesResultToText(fileRead);
						allLines = allLinesText.split(/\r\n|\n|\r/);
					}

					const expandStart = offset !== undefined && offset > 1;
					const expandEnd = limit !== undefined;
					const leadingContext =
						expandStart && sourceWindowStart === 0 ? Math.min(requestedStart, RANGE_CONTEXT_LINES) : 0;
					const trailingContext = expandEnd ? RANGE_CONTEXT_LINES : 0;
					const startLine = requestedStart - leadingContext;
					const startLineDisplay = startLine + 1;
					const sliceStartIndex = startLine - sourceWindowStart;

					const DEFAULT_LIMIT = this.#defaultLimit;
					const effectiveLimit = limit ?? DEFAULT_LIMIT;
					const maxLinesToCollect = Math.min(effectiveLimit + leadingContext + trailingContext, DEFAULT_MAX_LINES);
					const maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512);
					const totalFileLines = getReadLinesTotalLines(fileRead);
					const inferredTotalFileLines =
						totalFileLines ?? (sourceTruncated ? undefined : sourceWindowStart + allLines.length);

					if (inferredTotalFileLines !== undefined && requestedStart >= inferredTotalFileLines) {
						return toolResult<ReadToolDetails>({ resolvedPath: displayPath, suffixResolution })
							.text(formatBeyondEndOfFileMessage(requestedStart + 1, inferredTotalFileLines))
							.done();
					}

					const selectedContentFull = allLines.slice(sliceStartIndex).join("\n");
					const truncatedSelection = truncateHead(selectedContentFull, {
						maxLines: maxLinesToCollect,
						maxBytes: maxBytesForRead,
					});
					const collectedLines =
						truncatedSelection.content.length === 0 ? [] : truncatedSelection.content.split("\n");
					const collectedBytes = truncatedSelection.outputBytes;
					const stoppedByByteLimit = truncatedSelection.truncatedBy === "bytes";
					const firstLineText = allLines[sliceStartIndex] ?? "";
					const firstLineByteLength = Buffer.byteLength(firstLineText, "utf-8");
					const firstLinePreview =
						truncatedSelection.firstLineExceedsLimit && firstLineText.length > 0
							? truncateHeadBytes(firstLineText, maxBytesForRead)
							: undefined;

					const selectedContent = collectedLines.join("\n");
					const userLimitedLines = collectedLines.length;
					const totalSelectedLines =
						inferredTotalFileLines === undefined
							? Math.max(0, allLines.length - sliceStartIndex)
							: inferredTotalFileLines - startLine;
					const totalSelectedBytes =
						selectedContentFull.length === 0 ? 0 : Buffer.byteLength(selectedContentFull, "utf-8");
					const wasTruncated = sourceTruncated || collectedLines.length < totalSelectedLines || stoppedByByteLimit;
					const firstLineExceedsLimit = firstLineByteLength > maxBytesForRead;
					const nextOffset = startLine + userLimitedLines + 1;

					const truncation: TruncationResult = {
						content: selectedContent,
						truncated: wasTruncated,
						truncatedBy: stoppedByByteLimit ? "bytes" : wasTruncated ? "lines" : undefined,
						totalLines: totalSelectedLines,
						totalBytes: totalSelectedBytes,
						outputLines: collectedLines.length,
						outputBytes: collectedBytes,
						lastLinePartial: false,
						firstLineExceedsLimit,
					};

					if (collectedLines.length > 0 && !firstLineExceedsLimit) {
						getFileReadCache(this.session).recordContiguous(absolutePath, startLineDisplay, collectedLines);
					}

					const isRawMode = isRawSelector(parsed);
					const shouldAddHashLines = !isRawMode && displayMode.hashLines;
					const shouldAddLineNumbers = isRawMode ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
					let capturedDisplayContent: { text: string; startLine: number } | undefined;
					const formatText = (text: string, startNum: number): string => {
						capturedDisplayContent = { text, startLine: startNum };
						return formatTextWithMode(text, startNum, shouldAddHashLines, shouldAddLineNumbers);
					};

					let outputText: string;
					if (truncation.firstLineExceedsLimit) {
						const snippet = firstLinePreview ?? { text: "", bytes: 0 };
						if (shouldAddHashLines) {
							outputText = `[Line ${startLineDisplay} is ${formatBytes(
								firstLineByteLength,
							)}, exceeds ${formatBytes(maxBytesForRead)} limit. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`;
						} else {
							outputText = formatText(snippet.text, startLineDisplay);
						}
						if (snippet.text.length === 0) {
							outputText = `[Line ${startLineDisplay} is ${formatBytes(
								firstLineByteLength,
							)}, exceeds ${formatBytes(maxBytesForRead)} limit. Unable to display a valid UTF-8 snippet.]`;
						}
						details = { truncation };
						sourcePath = displayPath;
						truncationInfo = {
							result: truncation,
							options: { direction: "head", startLine: startLineDisplay, totalFileLines },
						};
					} else if (truncation.truncated) {
						outputText = formatText(truncation.content, startLineDisplay);
						if (sourceTruncated) {
							outputText += `\n\n[More lines in file. Use :${nextOffset} to continue]`;
						}
						details = { truncation };
						sourcePath = displayPath;
						truncationInfo = {
							result: truncation,
							options: { direction: "head", startLine: startLineDisplay, totalFileLines },
						};
					} else if (totalFileLines !== undefined && startLine + userLimitedLines < totalFileLines) {
						const remaining = totalFileLines - (startLine + userLimitedLines);
						outputText = formatText(truncation.content, startLineDisplay);
						outputText += `\n\n[${remaining} more lines in file. Use :${nextOffset} to continue]`;
						details = {};
						sourcePath = displayPath;
					} else {
						outputText = formatText(truncation.content, startLineDisplay);
						details = {};
						sourcePath = displayPath;
					}

					if (capturedDisplayContent) {
						details.displayContent = capturedDisplayContent;
					}

					content = [{ type: "text", text: outputText }];
				}
			}
		}

		const contentBlocks = content ?? [];
		if (suffixResolution) {
			details.suffixResolution = suffixResolution;
			// Inline resolution notice into first text block so the model sees the actual path
			const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
			const firstText = contentBlocks.find((c): c is TextContent => c.type === "text");
			if (firstText) {
				firstText.text = `${notice}\n${firstText.text}`;
			} else {
				content = [{ type: "text", text: notice }, ...contentBlocks];
			}
		}
		const resultBuilder = toolResult(details).content(content ?? []);
		if (sourcePath) {
			resultBuilder.sourcePath(sourcePath);
		}
		if (truncationInfo) {
			resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
		}
		return resultBuilder.done();
	}

	/**
	 * Handle internal URLs (agent://, artifact://, memory://, skill://, rule://, local://, mcp://).
	 * Supports pagination via offset/limit but rejects them when query extraction is used.
	 */
	async #handleInternalUrl(
		url: string,
		offset?: number,
		limit?: number,
		options?: { raw?: boolean },
	): Promise<AgentToolResult<ReadToolDetails>> {
		const internalRouter = InternalUrlRouter.instance();

		// Check if URL has query extraction (agent:// only).
		// Use parseInternalUrl which handles colons in host (namespaced skills).
		let parsed: InternalUrl;
		try {
			parsed = parseInternalUrl(url);
		} catch (e) {
			throw new ToolError(e instanceof Error ? e.message : String(e));
		}
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		let hasExtraction = false;
		if (scheme === "agent") {
			const hasPathExtraction = parsed.pathname && parsed.pathname !== "/" && parsed.pathname !== "";
			const queryParam = parsed.searchParams.get("q");
			const hasQueryExtraction = queryParam !== null && queryParam !== "";
			hasExtraction = hasPathExtraction || hasQueryExtraction;
		}

		// Reject offset/limit with query extraction
		if (hasExtraction && (offset !== undefined || limit !== undefined)) {
			throw new ToolError("Cannot combine query extraction with offset/limit");
		}

		// Resolve the internal URL
		const resource = await internalRouter.resolve(url);
		const details: ReadToolDetails = { resolvedPath: resource.sourcePath };

		// If extraction was used, return directly (no pagination)
		if (hasExtraction) {
			return toolResult(details).text(resource.content).sourceInternal(url).done();
		}

		return this.#buildInMemoryTextResult(resource.content, offset, limit, {
			details,
			sourcePath: resource.sourcePath,
			sourceInternal: url,
			entityLabel: "resource",
			ignoreResultLimits: scheme === "skill",
			immutable: resource.immutable,
			raw: options?.raw,
		});
	}

	/** Read directory contents as a formatted listing */
	async #readDirectory(
		absolutePath: string,
		limit: number | undefined,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const READ_DIRECTORY_MAX_DEPTH = 2;
		const READ_DIRECTORY_CHILD_LIMIT = 12;

		throwIfAborted(signal);
		let tree: DirectoryTree;
		try {
			const backend = this.session.backend;
			tree =
				backend.kind === "local"
					? await buildDirectoryTree(absolutePath, {
							maxDepth: READ_DIRECTORY_MAX_DEPTH,
							perDirLimit: READ_DIRECTORY_CHILD_LIMIT,
							rootLimit: null,
							lineCap: limit ?? null,
						})
					: await buildBackendDirectoryTree(absolutePath, backend.fs, {
							cwd: this.session.cwd,
							maxDepth: READ_DIRECTORY_MAX_DEPTH,
							perDirLimit: READ_DIRECTORY_CHILD_LIMIT,
							rootLimit: null,
							lineCap: limit ?? null,
							signal,
						});
		} catch (error) {
			const message = sanitizePathInMessage(
				error instanceof Error ? error.message : String(error),
				absolutePath,
				this.session.cwd,
			);
			throw new ToolError(`Cannot read directory: ${message}`);
		}
		throwIfAborted(signal);

		const output = tree.totalLines <= 1 ? "(empty directory)" : tree.rendered;
		const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
		const displayPath = formatResultPath(tree.rootPath, this.session.cwd);
		const details: ReadToolDetails = {
			isDirectory: true,
			resolvedPath: displayPath,
		};

		const resultBuilder = toolResult(details).text(truncation.content).sourcePath(displayPath);
		if (tree.truncated) {
			resultBuilder.limits({ resultLimit: 1 });
		}
		if (truncation.truncated) {
			resultBuilder.truncation(truncation, { direction: "head" });
			details.truncation = truncation;
		}

		return resultBuilder.done();
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface ReadRenderArgs {
	path?: string;
	file_path?: string;
	sel?: string;
	// Legacy fields from old schema — tolerated for in-flight tool calls during transition
	offset?: number;
	limit?: number;
	raw?: boolean;
}

export const readToolRenderer = {
	renderCall(args: ReadRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		if (isReadableUrlPath(args.file_path || args.path || "")) {
			return renderReadUrlCall(args, _options, uiTheme);
		}

		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const offset = args.offset;
		const limit = args.limit;

		let pathDisplay = filePath || "…";
		if (offset !== undefined || limit !== undefined) {
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			pathDisplay += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}

		const text = renderStatusLine({ icon: "pending", title: "Read", description: pathDisplay }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ReadToolDetails },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: ReadRenderArgs,
	): Component {
		const urlDetails = result.details as ReadUrlToolDetails | undefined;
		if (urlDetails?.kind === "url" || isReadableUrlPath(args?.file_path || args?.path || "")) {
			return renderReadUrlResult(
				result as { content: Array<{ type: string; text?: string }>; details?: ReadUrlToolDetails },
				_options,
				uiTheme,
			);
		}

		const details = result.details;
		const rawText = result.content?.find(c => c.type === "text")?.text ?? "";
		// Prefer structured `displayContent` from details when available so the TUI
		// shows clean file content (no model-only hashline anchors) without parsing the formatted text.
		const contentText = details?.displayContent?.text ?? rawText;
		const imageContent = result.content?.find(c => c.type === "image");
		const rawPath = args?.file_path || args?.path || "";
		const filePath = shortenPath(rawPath);
		const lang = getLanguageFromPath(rawPath);

		const warningLines: string[] = [];
		const truncation = details?.meta?.truncation;
		const fallback = details?.truncation;
		if (details?.resolvedPath) {
			warningLines.push(uiTheme.fg("dim", wrapBrackets(`Resolved path: ${details.resolvedPath}`, uiTheme)));
		}
		if (truncation) {
			if (fallback?.firstLineExceedsLimit) {
				let warning = `First line exceeds ${formatBytes(fallback.outputBytes ?? fallback.totalBytes)} limit`;
				if (truncation.artifactId) {
					warning += `. ${formatFullOutputReference(truncation.artifactId)}`;
				}
				warningLines.push(uiTheme.fg("warning", wrapBrackets(warning, uiTheme)));
			} else {
				const warning = formatStyledTruncationWarning(details?.meta, uiTheme);
				if (warning) warningLines.push(warning);
			}
		}

		if (imageContent) {
			const suffix = details?.suffixResolution;
			const displayPath = suffix ? shortenPath(suffix.to) : filePath || rawPath || "image";
			const correction = suffix ? ` ${uiTheme.fg("dim", `(corrected from ${shortenPath(suffix.from)})`)}` : "";
			const header = renderStatusLine(
				{ icon: suffix ? "warning" : "success", title: "Read", description: `${displayPath}${correction}` },
				uiTheme,
			);
			const detailLines = contentText ? contentText.split("\n").map(line => uiTheme.fg("toolOutput", line)) : [];
			const lines = [...detailLines, ...warningLines];
			const outputBlock = new CachedOutputBlock();
			return {
				render: (width: number) =>
					outputBlock.render(
						{
							header,
							state: "success",
							sections: [
								{
									label: uiTheme.fg("toolTitle", "Details"),
									lines: lines.length > 0 ? lines : [uiTheme.fg("dim", "(image)")],
								},
							],
							width,
						},
						uiTheme,
					),
				invalidate: () => outputBlock.invalidate(),
			};
		}

		const suffix = details?.suffixResolution;
		const displayPath = suffix ? shortenPath(suffix.to) : filePath;
		const correction = suffix ? ` ${uiTheme.fg("dim", `(corrected from ${shortenPath(suffix.from)})`)}` : "";
		let title = displayPath ? `Read ${displayPath}${correction}` : "Read";
		if (args?.offset !== undefined || args?.limit !== undefined) {
			const startLine = args.offset ?? 1;
			const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
			title += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}
		if (details?.summary) {
			title += ` (summary: ${details.summary.elidedSpans} elided span${details.summary.elidedSpans === 1 ? "" : "s"})`;
		}
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		return {
			render: (width: number) => {
				if (cachedLines && cachedWidth === width) return cachedLines;
				cachedLines = renderCodeCell(
					{
						code: contentText,
						language: lang,
						title,
						status: "complete",
						output: warningLines.length > 0 ? warningLines.join("\n") : undefined,
						expanded: true,
						width,
					},
					uiTheme,
				);
				cachedWidth = width;
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
