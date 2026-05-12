import * as path from "node:path";
import { FileType, type GlobMatch, listWorkspace } from "@oh-my-pi/pi-natives";
import { formatAge, formatBytes } from "@oh-my-pi/pi-utils";
import type { FsBackend, GlobResult } from "./backend";

/** Defaults for the workspace tree shown in the system prompt. */
const WORKSPACE_DEFAULTS = {
	maxDepth: 3,
	perDirLimit: 12,
	lineCap: 120,
} as const;

/**
 * Hard cap on AGENTS.md files surfaced by `buildWorkspaceTree`. Mirrors the
 * native cap so the system-prompt builder does not need a second pass.
 */
export const AGENTS_MD_LIMIT = 200;

export interface DirectoryTree {
	rootPath: string;
	rendered: string;
	truncated: boolean;
	totalLines: number;
}

export interface WorkspaceTree extends DirectoryTree {
	/** AGENTS.md files beneath the root whose rules may apply to subdirectories. */
	agentsMdFiles: string[];
}

export interface BuildDirectoryTreeOptions {
	/** Directory depth below the root to include. Root itself is depth 0. Default: 1. */
	maxDepth?: number;
	/** Per-directory child cap. `null` disables the cap. Default: `null`. */
	perDirLimit?: number | null;
	/** Optional override for the root level. Defaults to `perDirLimit`. */
	rootLimit?: number | null;
	/** Hard rendered line cap. `null` disables. Default: `null`. */
	lineCap?: number | null;
}

export interface BuildWorkspaceTreeOptions {
	/** Abort the native workspace scan after this many milliseconds. */
	timeoutMs?: number;
}

const BACKEND_DIRECTORY_GLOB_LIMIT = 10_000;

type TreeEntryType = "file" | "dir" | "symlink" | "other";

interface TreeEntry {
	path: string;
	type: TreeEntryType;
	size: number;
	mtimeMs: number;
}

export interface BuildBackendDirectoryTreeOptions extends BuildDirectoryTreeOptions {
	/** Session cwd used to scope backend glob results. */
	cwd: string;
	/** Abort the backend scan. */
	signal?: AbortSignal;
}

/**
 * Build a generic directory tree using a single native scan. Hidden files are
 * shown, .gitignore is not consulted, and the standard non-source directories
 * (`node_modules`, `.git`, build outputs, caches…) are pruned by the native
 * walker. Used by the read tool's directory-listing path.
 */
export async function buildDirectoryTree(cwd: string, options: BuildDirectoryTreeOptions = {}): Promise<DirectoryTree> {
	const rootPath = path.resolve(cwd);
	const maxDepth = options.maxDepth ?? 1;
	const perDirLimit = options.perDirLimit === undefined ? null : options.perDirLimit;
	const rootLimit = options.rootLimit === undefined ? perDirLimit : options.rootLimit;

	let entries: readonly TreeEntry[];
	let nativeTruncated: boolean;
	try {
		const result = await listWorkspace({
			path: rootPath,
			maxDepth,
			hidden: true,
			gitignore: false,
		});
		entries = result.entries.map(nativeGlobMatchToTreeEntry);
		nativeTruncated = result.truncated;
	} catch {
		return emptyTree(rootPath);
	}

	return assembleTree(rootPath, entries, {
		perDirLimit,
		rootLimit,
		lineCap: options.lineCap === undefined ? null : options.lineCap,
		nativeTruncated,
	});
}

/**
 * Build a directory tree from the active backend rather than the local
 * filesystem. Used by connected sessions, where `cwd` and `rootPath` belong to
 * the remote backend and must not be probed locally.
 */
export async function buildBackendDirectoryTree(
	rootPath: string,
	fsBackend: Pick<FsBackend, "glob">,
	options: BuildBackendDirectoryTreeOptions,
): Promise<DirectoryTree> {
	const resolvedRootPath = path.resolve(rootPath);
	const maxDepth = options.maxDepth ?? 1;
	const perDirLimit = options.perDirLimit === undefined ? null : options.perDirLimit;
	const rootLimit = options.rootLimit === undefined ? perDirLimit : options.rootLimit;
	const scopePath = relativeScopePath(options.cwd, resolvedRootPath);
	const patterns = maxDepth <= 0 ? [] : boundedGlobPatterns(maxDepth + 1);

	let result: GlobResult;
	try {
		result =
			patterns.length === 0
				? { entries: [], truncated: false }
				: await fsBackend.glob({
						patterns,
						paths: [scopePath],
						includeHidden: true,
						gitignore: false,
						limit: BACKEND_DIRECTORY_GLOB_LIMIT,
						signal: options.signal,
					});
	} catch {
		return emptyTree(resolvedRootPath);
	}

	const entries = result.entries
		.map(entry => backendGlobEntryToTreeEntry(entry, options.cwd, resolvedRootPath, scopePath))
		.map(entry => (entry === null ? null : capTreeEntryDepth(entry, maxDepth)))
		.filter((entry): entry is TreeEntry => entry !== null);

	return assembleTree(resolvedRootPath, entries, {
		perDirLimit,
		rootLimit,
		lineCap: options.lineCap === undefined ? null : options.lineCap,
		nativeTruncated: result.truncated,
	});
}

/**
 * Build the workspace tree shown in the system prompt. Returns the rendered
 * tree plus the AGENTS.md files surfaced by the same native walk so callers
 * never need to do a second filesystem scan.
 */
export async function buildWorkspaceTree(cwd: string, options: BuildWorkspaceTreeOptions = {}): Promise<WorkspaceTree> {
	const rootPath = path.resolve(cwd);
	try {
		const result = await listWorkspace({
			path: rootPath,
			maxDepth: WORKSPACE_DEFAULTS.maxDepth,
			hidden: false,
			gitignore: true,
			collectAgentsMd: true,
			timeoutMs: options.timeoutMs,
		});
		const tree = assembleTree(rootPath, result.entries.map(nativeGlobMatchToTreeEntry), {
			perDirLimit: WORKSPACE_DEFAULTS.perDirLimit,
			rootLimit: WORKSPACE_DEFAULTS.perDirLimit,
			lineCap: WORKSPACE_DEFAULTS.lineCap,
			nativeTruncated: result.truncated,
		});
		return { ...tree, agentsMdFiles: result.agentsMdFiles };
	} catch {
		return { ...emptyTree(rootPath), agentsMdFiles: [] };
	}
}

// ─── internals ──────────────────────────────────────────────────────────────

interface Node {
	name: string;
	isDir: boolean;
	mtimeMs: number;
	size: number;
	depth: number;
	children: Node[];
	/** When > 0, `children` is laid out as `[recent…, oldest]`. */
	droppedCount: number;
	/** Synthetic directory inferred from a backend that only returned files. */
	synthetic: boolean;
}

interface RenderedLine {
	label: string;
	depth: number;
	isRoot: boolean;
	size?: string;
	age?: string;
}

interface AssembleOptions {
	perDirLimit: number | null;
	rootLimit: number | null;
	lineCap: number | null;
	nativeTruncated: boolean;
}

function nativeGlobMatchToTreeEntry(entry: GlobMatch): TreeEntry {
	return {
		path: entry.path,
		type: entry.fileType === FileType.Dir ? "dir" : entry.fileType === FileType.Symlink ? "symlink" : "file",
		size: entry.size ?? 0,
		mtimeMs: entry.mtime ?? 0,
	};
}

function relativeScopePath(cwd: string, rootPath: string): string {
	const relative = path.relative(path.resolve(cwd), rootPath).replaceAll("\\", "/");
	return relative.length === 0 ? "." : relative;
}

function boundedGlobPatterns(maxDepth: number): string[] {
	const depth = Math.max(0, Math.floor(maxDepth));
	const patterns: string[] = [];
	for (let level = 1; level <= depth; level++) {
		patterns.push(Array.from({ length: level }, () => "*").join("/"));
	}
	return patterns;
}

function normalizeTreePath(input: string): string | null {
	const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
	const trimmed = normalized === "." ? "" : normalized.replace(/^\.\/+/, "").replace(/\/+$/, "");
	if (!trimmed || trimmed === ".." || trimmed.startsWith("../") || path.posix.isAbsolute(trimmed)) return null;
	return trimmed;
}

function backendGlobEntryToTreeEntry(
	entry: GlobResult["entries"][number],
	cwd: string,
	rootPath: string,
	scopePath: string,
): TreeEntry | null {
	const normalizedScope = normalizeTreePath(scopePath);
	const normalizedEntry = entry.path.replaceAll("\\", "/").replace(/\/+$/, "");
	let relativePath: string | null = null;

	if (normalizedScope === null || normalizedScope === "") {
		relativePath = normalizeTreePath(normalizedEntry);
	} else if (normalizedEntry === normalizedScope) {
		return null;
	} else if (normalizedEntry.startsWith(`${normalizedScope}/`)) {
		relativePath = normalizeTreePath(normalizedEntry.slice(normalizedScope.length + 1));
	}

	if (relativePath === null) {
		relativePath = path.isAbsolute(entry.path) ? null : normalizeTreePath(normalizedEntry);
	}

	if (relativePath === null) {
		const absoluteEntry = path.isAbsolute(entry.path) ? entry.path : path.resolve(cwd, entry.path);
		relativePath = normalizeTreePath(path.relative(rootPath, absoluteEntry));
	}

	if (relativePath === null) return null;
	return {
		path: relativePath,
		type: entry.type,
		size: entry.size,
		mtimeMs: entry.modified,
	};
}

function capTreeEntryDepth(entry: TreeEntry, maxDepth: number): TreeEntry | null {
	if (maxDepth <= 0) return null;
	const parts = entry.path.split("/");
	if (parts.length <= maxDepth) return entry;
	return {
		path: parts.slice(0, maxDepth).join("/"),
		type: "dir",
		size: 0,
		mtimeMs: entry.mtimeMs,
	};
}

function createNode(
	name: string,
	isDir: boolean,
	mtimeMs: number,
	size: number,
	depth: number,
	synthetic: boolean,
): Node {
	return {
		name,
		isDir,
		mtimeMs,
		size,
		depth,
		children: [],
		droppedCount: 0,
		synthetic,
	};
}

function upsertExplicitNode(nodesByPath: Map<string, Node>, entryPath: string, entry: TreeEntry): void {
	const slash = entryPath.lastIndexOf("/");
	const name = slash === -1 ? entryPath : entryPath.slice(slash + 1);
	const depth = entryPath.split("/").length;
	const isDir = entry.type === "dir";
	const existing = nodesByPath.get(entryPath);
	if (!existing) {
		nodesByPath.set(entryPath, createNode(name, isDir, entry.mtimeMs, entry.size, depth, false));
		return;
	}

	existing.synthetic = false;
	existing.isDir = existing.isDir || isDir;
	existing.mtimeMs = Math.max(existing.mtimeMs, entry.mtimeMs);
	if (!isDir) existing.size = entry.size;
}

function ensureSyntheticDirectory(nodesByPath: Map<string, Node>, dirPath: string, childMtimeMs: number): void {
	const existing = nodesByPath.get(dirPath);
	if (existing) {
		if (existing.synthetic) existing.mtimeMs = Math.max(existing.mtimeMs, childMtimeMs);
		return;
	}
	const slash = dirPath.lastIndexOf("/");
	const name = slash === -1 ? dirPath : dirPath.slice(slash + 1);
	nodesByPath.set(dirPath, createNode(name, true, childMtimeMs, 0, dirPath.split("/").length, true));
}

function materializeTreeEntries(entries: readonly TreeEntry[]): Map<string, Node> {
	const nodesByPath = new Map<string, Node>();
	const normalizedEntries: Array<{ path: string; entry: TreeEntry }> = [];
	for (const entry of entries) {
		const entryPath = normalizeTreePath(entry.path);
		if (entryPath === null) continue;
		normalizedEntries.push({ path: entryPath, entry });
		upsertExplicitNode(nodesByPath, entryPath, entry);
	}

	for (const { path: entryPath, entry } of normalizedEntries) {
		const parts = entryPath.split("/");
		for (let index = 1; index < parts.length; index++) {
			ensureSyntheticDirectory(nodesByPath, parts.slice(0, index).join("/"), entry.mtimeMs);
		}
	}

	return nodesByPath;
}

function assembleTree(rootPath: string, entries: readonly TreeEntry[], opts: AssembleOptions): DirectoryTree {
	// Bucket entries by parent path. The native walker may yield siblings in
	// any order across worker threads, so we group by string key and sort once
	// per directory below.
	const nodesByPath = materializeTreeEntries(entries);
	const byParent = new Map<string, Node[]>();
	for (const [entryPath, node] of nodesByPath) {
		const slash = entryPath.lastIndexOf("/");
		const parentPath = slash === -1 ? "" : entryPath.slice(0, slash);
		const bucket = byParent.get(parentPath);
		if (bucket) bucket.push(node);
		else byParent.set(parentPath, [node]);
	}

	const root: Node = {
		name: ".",
		isDir: true,
		mtimeMs: 0,
		size: 0,
		depth: 0,
		children: [],
		droppedCount: 0,
		synthetic: false,
	};

	let truncated = opts.nativeTruncated;
	const stack: Array<{ node: Node; relPath: string }> = [{ node: root, relPath: "" }];
	while (stack.length > 0) {
		const { node, relPath } = stack.pop()!;
		const all = (byParent.get(relPath) ?? []).slice().sort(byRecency);
		const limit = node.depth === 0 ? opts.rootLimit : opts.perDirLimit;
		if (limit !== null && all.length > limit) {
			node.children = limit <= 1 ? all.slice(0, Math.max(0, limit)) : [...all.slice(0, limit - 1), all.at(-1)!];
			node.droppedCount = all.length - limit;
			truncated = true;
		} else {
			node.children = all;
		}
		for (const child of node.children) {
			if (!child.isDir) continue;
			stack.push({ node: child, relPath: relPath ? `${relPath}/${child.name}` : child.name });
		}
	}

	const rawLines: RenderedLine[] = [];
	renderNode(root, Date.now(), rawLines);
	const { lines, elidedCount } = applyLineCap(rawLines, opts.lineCap);

	return {
		rootPath,
		rendered: formatLines(lines),
		truncated: truncated || elidedCount > 0,
		totalLines: lines.length,
	};
}

function byRecency(a: Node, b: Node): number {
	return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
}

function renderNode(node: Node, nowMs: number, out: RenderedLine[]): void {
	if (node.depth === 0) {
		out.push({ label: node.name, depth: 0, isRoot: true });
	} else {
		const indent = "  ".repeat(node.depth);
		const suffix = node.isDir ? "/" : "";
		out.push({
			label: `${indent}- ${node.name}${suffix}`,
			depth: node.depth,
			isRoot: false,
			size: node.isDir ? undefined : formatBytes(node.size),
			age: formatAge(Math.max(0, Math.floor((nowMs - node.mtimeMs) / 1000))),
		});
	}

	if (node.droppedCount === 0) {
		for (const child of node.children) renderNode(child, nowMs, out);
		return;
	}

	// Layout: recent children, then "… N more" marker, then the oldest child.
	const recent = node.children.slice(0, -1);
	const oldest = node.children.at(-1);
	for (const child of recent) renderNode(child, nowMs, out);
	const childDepth = node.depth + 1;
	out.push({
		label: `${"  ".repeat(childDepth)}- … ${node.droppedCount} more`,
		depth: childDepth,
		isRoot: false,
	});
	if (oldest) renderNode(oldest, nowMs, out);
}

/**
 * Cap the rendered tree at `lineCap` lines by removing the deepest trailing
 * entries first. Root and root children (depth ≤ 1) are always preserved so
 * the structural overview stays intact.
 */
function applyLineCap(
	lines: readonly RenderedLine[],
	lineCap: number | null,
): { lines: RenderedLine[]; elidedCount: number } {
	if (lineCap === null || lines.length <= lineCap) return { lines: [...lines], elidedCount: 0 };

	const PROTECTED_DEPTH = 1;
	const target = Math.max(1, lineCap - 1);
	const removable = lines
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => !line.isRoot && line.depth > PROTECTED_DEPTH)
		.sort((a, b) => b.line.depth - a.line.depth || b.index - a.index)
		.slice(0, lines.length - target);
	if (removable.length === 0) return { lines: [...lines], elidedCount: 0 };

	const removed = new Set(removable.map(item => item.index));
	const kept = lines.filter((_, index) => !removed.has(index));
	kept.push({
		label: `… (${removable.length} lines elided beyond depth/cap)`,
		depth: 0,
		isRoot: false,
	});
	return { lines: kept, elidedCount: removable.length };
}

function formatLines(lines: readonly RenderedLine[]): string {
	const maxLabelLength = lines.reduce((max, line) => Math.max(max, line.label.length), 0);
	return lines
		.map(line => {
			if (!line.age) return line.label;
			const sizeColumn = (line.size ?? "").padEnd(8);
			return `${line.label.padEnd(maxLabelLength + 2)}${sizeColumn}  ${line.age.padEnd(4)}`.trimEnd();
		})
		.join("\n");
}

function emptyTree(rootPath: string): DirectoryTree {
	return {
		rootPath,
		rendered: "",
		truncated: false,
		totalLines: 0,
	};
}
