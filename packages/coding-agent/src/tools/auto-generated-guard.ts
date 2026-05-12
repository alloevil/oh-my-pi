/**
 * Auto-generated file detection guard.
 *
 * Prevents editing of files that appear to be automatically generated
 * by code generation tools (protoc, sqlc, buf, swagger, etc.).
 */
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { LRUCache } from "lru-cache/raw";
import type { Backend } from "../backend";
import { LocalBackend } from "../backend/local-backend";
import { settings } from "../config/settings";
import { ToolError } from "./tool-errors";

/**
 * Number of bytes to read from the start of a file for auto-generated detection.
 */
const CHECK_BYTE_COUNT = 1024;
const HEADER_LINE_LIMIT = 40;

const KNOWN_GENERATOR_PATTERN =
	"(?:protoc(?:-gen-[\\w-]+)?|sqlc|buf|swagger(?:-codegen)?|openapi(?:-generator)?|grpc-gateway|mockery|stringer|easyjson|deepcopy-gen|defaulter-gen|conversion-gen|client-gen|lister-gen|informer-gen|kysely-codegen|napi-rs)";

/**
 * Strong marker patterns for generated-file headers.
 *
 * Keep these strict: broad patterns like /auto-generated/ cause false positives
 * in normal hand-written files (including this guard implementation itself).
 */
const AUTO_GENERATED_HEADER_MARKERS: readonly RegExp[] = [
	/@generated\b/i,
	/\bcode\s+generated\s+by\s+[a-z0-9_.-]+/i,
	/\bthis\s+file\s+was\s+automatically\s+generated\b/i,
	new RegExp(`\\bgenerated\\s+by\\s+${KNOWN_GENERATOR_PATTERN}\\b`, "i"),
];

type CommentStyle = "slash" | "hash" | "sql" | "html";

const COMMENT_STYLES_BY_EXTENSION = new Map<string, readonly CommentStyle[]>([
	[".c", ["slash"]],
	[".cc", ["slash"]],
	[".cpp", ["slash"]],
	[".cs", ["slash"]],
	[".dart", ["slash"]],
	[".go", ["slash"]],
	[".h", ["slash"]],
	[".hpp", ["slash"]],
	[".java", ["slash"]],
	[".js", ["slash"]],
	[".jsx", ["slash"]],
	[".kt", ["slash"]],
	[".kts", ["slash"]],
	[".mjs", ["slash"]],
	[".cjs", ["slash"]],
	[".php", ["slash"]],
	[".rs", ["slash"]],
	[".scala", ["slash"]],
	[".swift", ["slash"]],
	[".ts", ["slash"]],
	[".tsx", ["slash"]],
	[".py", ["hash"]],
	[".rb", ["hash"]],
	[".sh", ["hash"]],
	[".bash", ["hash"]],
	[".zsh", ["hash"]],
	[".yml", ["hash"]],
	[".yaml", ["hash"]],
	[".toml", ["hash"]],
	[".ini", ["hash"]],
	[".cfg", ["hash"]],
	[".conf", ["hash"]],
	[".env", ["hash"]],
	[".pl", ["hash"]],
	[".r", ["hash"]],
	[".sql", ["sql"]],
	[".html", ["html"]],
	[".htm", ["html"]],
	[".xml", ["html"]],
	[".svg", ["html"]],
	[".xhtml", ["html"]],
]);

const COMMENT_STYLES_BY_BASENAME = new Map<string, readonly CommentStyle[]>([
	["dockerfile", ["hash"]],
	["makefile", ["hash"]],
	["justfile", ["hash"]],
]);

/**
 * File name patterns that strongly indicate auto-generated files.
 * These are checked against the file name (not content).
 */
const AUTO_GENERATED_FILENAME_PATTERNS = [
	/^zz_generated\./,
	/\.pb\.(go|cc|h|c|js|ts)$/,
	/_pb2\.py$/,
	/_pb2_grpc\.py$/,
	/\.gen\.(go|ts|js|py)$/,
	/^generated\.(go|ts|js|py)$/,
	/\.swagger\.json$/,
	/\.openapi\.json$/,
	/\.mock\.(go|ts)$/,
	/\.mocks?\.(go|ts|js)$/,
];

function stripBom(content: string): string {
	if (content.charCodeAt(0) === 0xfeff) {
		return content.slice(1);
	}
	return content;
}

function getCommentStylesForPath(filePath: string): readonly CommentStyle[] {
	const normalizedPath = filePath.toLowerCase();
	const fileName = path.basename(normalizedPath);
	const stylesByName = COMMENT_STYLES_BY_BASENAME.get(fileName);
	if (stylesByName) return stylesByName;

	const ext = path.extname(fileName);
	const stylesByExt = COMMENT_STYLES_BY_EXTENSION.get(ext);
	return stylesByExt ?? [];
}

function extractLeadingHeaderCommentText(content: string, commentStyles: readonly CommentStyle[]): string {
	if (commentStyles.length === 0) return "";

	const includeSlash = commentStyles.includes("slash");
	const includeHash = commentStyles.includes("hash");
	const includeSql = commentStyles.includes("sql");
	const includeHtml = commentStyles.includes("html");

	const lines = stripBom(content).split(/\r?\n/);
	const headerLines: string[] = [];
	let started = false;
	let inSlashBlock = false;
	let inHtmlBlock = false;

	for (let lineIndex = 0; lineIndex < lines.length && lineIndex < HEADER_LINE_LIMIT; lineIndex += 1) {
		const trimmed = lines[lineIndex]?.trim() ?? "";
		if (lineIndex === 0 && trimmed.startsWith("#!")) {
			continue;
		}

		if (inSlashBlock) {
			headerLines.push(trimmed);
			if (trimmed.includes("*/")) inSlashBlock = false;
			continue;
		}

		if (inHtmlBlock) {
			headerLines.push(trimmed);
			if (trimmed.includes("-->")) inHtmlBlock = false;
			continue;
		}

		if (trimmed.length === 0) {
			if (started) headerLines.push("");
			continue;
		}

		if (includeSlash && trimmed.startsWith("//")) {
			started = true;
			headerLines.push(trimmed);
			continue;
		}

		if (includeSlash && trimmed.startsWith("/*")) {
			started = true;
			headerLines.push(trimmed);
			if (!trimmed.includes("*/")) {
				inSlashBlock = true;
			}
			continue;
		}

		if (includeHash && trimmed.startsWith("#")) {
			started = true;
			headerLines.push(trimmed);
			continue;
		}

		if (includeSql && trimmed.startsWith("--")) {
			started = true;
			headerLines.push(trimmed);
			continue;
		}

		if (includeHtml && trimmed.startsWith("<!--")) {
			started = true;
			headerLines.push(trimmed);
			if (!trimmed.includes("-->")) {
				inHtmlBlock = true;
			}
			continue;
		}

		if (started) break;
		break;
	}

	return headerLines.join("\n");
}

/**
 * Check if a file name indicates it might be auto-generated.
 * This is a quick pre-check before reading file content.
 */
function isAutoGeneratedFileName(filePath: string): boolean {
	const fileName = filePath.split("/").pop() ?? "";
	return AUTO_GENERATED_FILENAME_PATTERNS.some(pattern => pattern.test(fileName));
}

/**
 * Check if leading header comments contain auto-generated markers.
 * Returns the matched marker text if found, undefined otherwise.
 */
function detectAutoGeneratedMarker(content: string, filePath: string): string | undefined {
	const commentStyles = getCommentStylesForPath(filePath);
	const headerCommentText = extractLeadingHeaderCommentText(content, commentStyles);
	if (!headerCommentText) return undefined;

	for (const markerPattern of AUTO_GENERATED_HEADER_MARKERS) {
		const match = markerPattern.exec(headerCommentText);
		if (match?.[0]) return match[0];
	}

	return undefined;
}

/**
 * Build the error message for an auto-generated file.
 */
function buildAutoGeneratedError(displayPath: string, detected: string): ToolError {
	return new ToolError(
		`Cannot modify auto-generated file: ${displayPath}\n\n` +
			`This file appears to be automatically generated (detected marker: "${detected}").\n` +
			`Auto-generated files should not be edited directly. Instead:\n` +
			`1. Find the source file or generator configuration\n` +
			`2. Make changes to the source\n` +
			`3. Regenerate the file`,
	);
}

interface CachedMarker {
	marker?: string;
}
const autoGeneratedMaps = new WeakMap<Backend, LRUCache<string, CachedMarker>>();
let legacyLocalBackend: { cwd: string; backend: Backend } | undefined;

function getLegacyLocalBackend(): Backend {
	const cwd = process.cwd();
	if (!legacyLocalBackend || legacyLocalBackend.cwd !== cwd) {
		legacyLocalBackend = { cwd, backend: new LocalBackend({ cwd }) };
	}
	return legacyLocalBackend.backend;
}

function getAutoGeneratedMap(backend: Backend): LRUCache<string, CachedMarker> {
	let map = autoGeneratedMaps.get(backend);
	if (!map) {
		map = new LRUCache<string, CachedMarker>({ max: 10 });
		autoGeneratedMaps.set(backend, map);
	}
	return map;
}

function isMissingFileError(error: unknown): boolean {
	if (isEnoent(error)) return true;
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: unknown }).code;
	return code === "ENOENT" || code === "ENOTDIR" || code === "not-found";
}

async function getAutoGeneratedMarker(
	backend: Backend,
	filePath: string,
	options?: { signal?: AbortSignal },
): Promise<string | undefined> {
	if (isAutoGeneratedFileName(filePath)) {
		return filePath.split("/").pop() ?? "";
	}

	const autoGeneratedMap = getAutoGeneratedMap(backend);
	const cached = autoGeneratedMap.get(filePath);
	if (cached !== undefined) return cached.marker;

	let marker: string | undefined;
	try {
		const { lines } = await backend.fs.readLines(filePath, {
			maxBytes: CHECK_BYTE_COUNT,
			signal: options?.signal,
		});
		const content = lines.join("\n");
		marker = detectAutoGeneratedMarker(content, filePath);
	} catch (err) {
		if (isMissingFileError(err)) {
			return undefined;
		}
		throw err;
	}

	autoGeneratedMap.set(filePath, { marker });
	return marker;
}

/**
 * Check if a file is auto-generated by examining its content.
 * Throws ToolError if the file appears to be auto-generated.
 *
 * @param backend - Backend that owns the file path
 * @param absolutePath - Absolute path to the file
 * @param displayPath - Path to show in error messages (relative or as provided)
 */
export async function assertEditableFile(absolutePath: string, displayPath?: string): Promise<void>;
export async function assertEditableFile(
	backend: Backend,
	absolutePath: string,
	displayPath?: string,
	options?: { signal?: AbortSignal },
): Promise<void>;
export async function assertEditableFile(
	backendOrPath: Backend | string,
	absolutePathOrDisplayPath?: string,
	displayPathOrOptions?: string | { signal?: AbortSignal },
	options?: { signal?: AbortSignal },
) {
	if (!settings.get("edit.blockAutoGenerated")) {
		return;
	}
	const backend = typeof backendOrPath === "string" ? getLegacyLocalBackend() : backendOrPath;
	const absolutePath = typeof backendOrPath === "string" ? backendOrPath : absolutePathOrDisplayPath;
	if (typeof absolutePath !== "string") {
		throw new TypeError("assertEditableFile requires a file path");
	}
	const displayPath =
		typeof backendOrPath === "string"
			? absolutePathOrDisplayPath
			: typeof displayPathOrOptions === "string"
				? displayPathOrOptions
				: undefined;
	const readOptions = typeof displayPathOrOptions === "object" ? displayPathOrOptions : options;
	const pathForDisplay = displayPath ?? absolutePath;
	const marker = await getAutoGeneratedMarker(backend, absolutePath, readOptions);
	if (marker) {
		throw buildAutoGeneratedError(pathForDisplay, marker);
	}
}

/**
 * Check if file content is auto-generated.
 * Uses only the first CHECK_BYTE_COUNT characters of the content.
 * Throws ToolError if the content appears to be auto-generated.
 *
 * @param content - File content to check (can be full content or prefix)
 * @param displayPath - Path to show in error messages
 */
export function assertEditableFileContent(content: string, displayPath: string): void {
	if (!settings.get("edit.blockAutoGenerated")) {
		return;
	}

	const prefix = content.slice(0, CHECK_BYTE_COUNT);
	const marker = detectAutoGeneratedMarker(prefix, displayPath);
	if (marker) {
		throw buildAutoGeneratedError(displayPath, marker);
	}
}
