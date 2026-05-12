import * as fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger, once, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import type { Backend, JsonRpcChannel } from "../backend/backend";
import type { LspConfig as BackendLspConfig, LspStatus as BackendLspStatus } from "../backend/types";
import { type Theme, theme } from "../modes/theme/theme";
import lspDescription from "../prompts/tools/lsp.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";
import { clampTimeout } from "../tools/tool-timeouts";
import {
	getActiveClients,
	getOrCreateClient,
	type LspServerStatus,
	notifySaved,
	sendRequest,
	setIdleTimeout,
	syncContent,
	WARMUP_TIMEOUT_MS,
	waitForProjectLoaded,
} from "./client";
import { getLinterClient } from "./clients";
import { getServersForFile, type LspConfig, loadConfig } from "./config";
import { applyTextEditsToString, applyWorkspaceEdit } from "./edits";
import { detectLspmux } from "./lspmux";
import { renderCall, renderResult } from "./render";
import {
	type CodeAction,
	type CodeActionContext,
	type Command,
	type Diagnostic,
	type DocumentSymbol,
	type Hover,
	type Location,
	type LocationLink,
	type LspClient,
	type LspParams,
	type LspServerCapabilities,
	type LspToolDetails,
	lspSchema,
	type Position,
	type PublishDiagnosticsParams,
	type PublishedDiagnostics,
	type ServerConfig,
	type SymbolInformation,
	type TextEdit,
	type WorkspaceEdit,
} from "./types";
import {
	applyCodeAction,
	dedupeWorkspaceSymbols,
	detectLanguageId,
	extractHoverText,
	fileToUri,
	filterWorkspaceSymbols,
	formatCodeAction,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatDocumentSymbol,
	formatGroupedDiagnosticMessages,
	formatLocation,
	formatSymbolInformation,
	formatWorkspaceEdit,
	readLocationContext,
	resolveDiagnosticTargets,
	resolveSymbolColumn,
	sortDiagnostics,
	symbolKindToIcon,
	uriToFile,
} from "./utils";

export type { LspServerStatus } from "./client";
export type { LspToolDetails } from "./types";

export interface LspStartupServerInfo {
	name: string;
	status: "connecting" | "ready" | "error";
	fileTypes: string[];
	error?: string;
}

/** Result from warming up LSP servers */
export interface LspWarmupResult {
	servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
}

/** Options for warming up LSP servers */
export interface LspWarmupOptions {
	/** Called when starting to connect to servers */
	onConnecting?: (serverNames: string[]) => void;
}

export function discoverStartupLspServers(cwd: string): LspStartupServerInfo[] {
	const config = loadConfig(cwd);
	return getLspServers(config).map(([name, serverConfig]) => ({
		name,
		status: "connecting",
		fileTypes: serverConfig.fileTypes,
	}));
}

/**
 * Warm up LSP servers for a directory by connecting to all detected servers.
 * This should be called at startup to avoid cold-start delays.
 *
 * @param cwd - Working directory to detect and start servers for
 * @param options - Optional callbacks for progress reporting
 * @returns Status of each server that was started
 */
export async function warmupLspServers(cwd: string, options?: LspWarmupOptions): Promise<LspWarmupResult> {
	const config = loadConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const servers: LspWarmupResult["servers"] = [];
	const lspServers = getLspServers(config);

	// Notify caller which servers we're connecting to
	if (lspServers.length > 0 && options?.onConnecting) {
		options.onConnecting(lspServers.map(([name]) => name));
	}

	// Start all detected servers in parallel with a short timeout
	// Servers that don't respond quickly will be initialized lazily on first use
	const results = await Promise.allSettled(
		lspServers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const [name, serverConfig] = lspServers[i];
		if (result.status === "fulfilled") {
			servers.push({
				name: result.value.name,
				status: "ready",
				fileTypes: result.value.fileTypes,
			});
		} else {
			const errorMsg = result.reason?.message ?? String(result.reason);
			logger.warn("LSP server failed to start", { server: name, error: errorMsg });
			servers.push({
				name,
				status: "error",
				fileTypes: serverConfig.fileTypes,
				error: errorMsg,
			});
		}
	}

	return { servers };
}

/**
 * Get status of currently active LSP servers.
 */
export function getLspStatus(): LspServerStatus[] {
	return getActiveClients();
}

/**
 * Sync in-memory file content to all applicable LSP servers.
 * Sends didOpen (if new) or didChange (if already open).
 *
 * @param absolutePath - Absolute path to the file
 * @param content - The new file content
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to sync to
 */
async function syncFileContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = await getOrCreateClient(serverConfig, cwd);
			throwIfAborted(signal);
			await syncContent(client, absolutePath, content, signal);
		}),
	);
}

/**
 * Notify all LSP servers that a file was saved.
 * Assumes content was already synced via syncFileContent.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to notify
 */
async function notifyFileSaved(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = await getOrCreateClient(serverConfig, cwd);
			await notifySaved(client, absolutePath, signal);
		}),
	);
}

// Cache config per cwd to avoid repeated file I/O
const configCache = new Map<string, LspConfig>();

function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		setIdleTimeout(config.idleTimeoutMs);
		configCache.set(cwd, config);
	}
	return config;
}

function isCustomLinter(serverConfig: ServerConfig): boolean {
	return Boolean(serverConfig.createClient);
}

function splitServers(servers: Array<[string, ServerConfig]>): {
	lspServers: Array<[string, ServerConfig]>;
	customLinterServers: Array<[string, ServerConfig]>;
} {
	const lspServers: Array<[string, ServerConfig]> = [];
	const customLinterServers: Array<[string, ServerConfig]> = [];
	for (const entry of servers) {
		if (isCustomLinter(entry[1])) {
			customLinterServers.push(entry);
		} else {
			lspServers.push(entry);
		}
	}
	return { lspServers, customLinterServers };
}

function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
		([, serverConfig]) => !isCustomLinter(serverConfig),
	);
}

function getLspServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	return getServersForFile(config, filePath).filter(([, serverConfig]) => !isCustomLinter(serverConfig));
}

function getLspServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getLspServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
	return !serverConfig.createClient && !serverConfig.isLinter;
}

const DIAGNOSTIC_MESSAGE_LIMIT = 50;
const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
const WORKSPACE_SYMBOL_LIMIT = 200;
const CONNECTED_LSP_UNAVAILABLE_MESSAGE =
	"LSP is unavailable in connected sessions because remote path/root/sync/diagnostic behavior is not safe yet.";
const CONNECTED_LSP_WRITETHROUGH_DISABLED_SUMMARY = "LSP disabled for connected session";
const CONNECTED_LSP_WRITETHROUGH_DISABLED_MESSAGE =
	"LSP format/diagnostics skipped: connected sessions do not yet have trustworthy remote LSP state.";

function isRemoteBackend(backend?: Pick<Backend, "kind">): boolean {
	return backend?.kind === "remote";
}

function connectedLspDisabledDiagnostics(): FileDiagnosticsResult {
	return {
		server: "LSP",
		messages: [CONNECTED_LSP_WRITETHROUGH_DISABLED_MESSAGE],
		summary: CONNECTED_LSP_WRITETHROUGH_DISABLED_SUMMARY,
		errored: false,
	};
}

function limitDiagnosticMessages(messages: string[]): string[] {
	if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
		return messages;
	}
	return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
}

const LOCATION_CONTEXT_LINES = 1;
const REFERENCE_CONTEXT_LIMIT = 50;

const REFERENCES_RETRY_COUNT = 2;
const REFERENCES_RETRY_DELAY_MS = 250;

function comparePosition(a: Position, b: Position): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function rangeContainsPosition(range: Location["range"], position: Position): boolean {
	return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

function isOnlyQueriedDeclaration(locations: Location[], uri: string, position: Position): boolean {
	return locations.length === 1 && locations[0]?.uri === uri && rangeContainsPosition(locations[0].range, position);
}

function normalizeLocationResult(result: Location | Location[] | LocationLink | LocationLink[] | null): Location[] {
	if (!result) return [];
	const raw = Array.isArray(result) ? result : [result];
	return raw.flatMap(loc => {
		if ("uri" in loc) {
			return [loc as Location];
		}
		if ("targetUri" in loc) {
			const link = loc as LocationLink;
			return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
		}
		return [];
	});
}

async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
	const header = `  ${formatLocation(location, cwd)}`;
	const context = await readLocationContext(
		uriToFile(location.uri),
		location.range.start.line + 1,
		LOCATION_CONTEXT_LINES,
	);
	if (context.length === 0) {
		return header;
	}
	return `${header}\n${context.map(lineText => `    ${lineText}`).join("\n")}`;
}

const MAX_RENAME_PAIRS = 1000;

interface FileRenamePair {
	oldUri: string;
	newUri: string;
}

/**
 * Enumerate the {oldUri, newUri} pairs needed for an LSP willRenameFiles/didRenameFiles request.
 * For files this is a single pair. For directories this walks every regular file underneath
 * and produces a parallel pair anchored at the new directory root.
 */
async function enumerateRenamePairs(
	source: string,
	dest: string,
): Promise<{ pairs: FileRenamePair[]; directory: boolean; exceeded: boolean }> {
	const stat = await fs.promises.stat(source);
	if (!stat.isDirectory()) {
		return {
			pairs: [{ oldUri: fileToUri(source), newUri: fileToUri(dest) }],
			directory: false,
			exceeded: false,
		};
	}
	const entries = await fs.promises.readdir(source, { recursive: true, withFileTypes: true });
	const pairs: FileRenamePair[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (pairs.length >= MAX_RENAME_PAIRS) {
			return { pairs, directory: true, exceeded: true };
		}
		const parent = entry.parentPath ?? source;
		const absOld = path.join(parent, entry.name);
		const rel = path.relative(source, absOld);
		pairs.push({
			oldUri: fileToUri(absOld),
			newUri: fileToUri(path.join(dest, rel)),
		});
	}
	return { pairs, directory: true, exceeded: false };
}

/** True when an LSP error indicates the server doesn't implement the requested method. */
function isMethodNotFoundError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("method not found") ||
		msg.includes("unhandled method") ||
		msg.includes("not supported") ||
		msg.includes("-32601")
	);
}

function isAbortLikeError(err: unknown, signal?: AbortSignal): boolean {
	return (
		err instanceof ToolAbortError || signal?.aborted === true || (err instanceof Error && err.name === "AbortError")
	);
}

function formatLspOperationError(
	serverName: string,
	method: string,
	filePath: string,
	cwd: string,
	err: unknown,
): string {
	const message = err instanceof Error ? err.message : String(err);
	return `${serverName} ${method} failed for ${formatPathRelativeToCwd(filePath, cwd)}: ${message}`;
}

function describeActionMethod(action: LspParams["action"]): string | null {
	switch (action) {
		case "hover":
			return "textDocument/hover";
		case "definition":
			return "textDocument/definition";
		case "implementation":
			return "textDocument/implementation";
		case "type_definition":
			return "textDocument/typeDefinition";
		case "references":
			return "textDocument/references";
		case "code_actions":
			return "textDocument/codeAction";
		case "symbols":
			return "textDocument/documentSymbol";
		case "rename":
			return "textDocument/rename";
		case "reload":
			return "workspace/didChangeConfiguration";
		default:
			return null;
	}
}
async function _reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
	let output = `Restarted ${serverName}`;
	const reloadMethods = ["rust-analyzer/reloadWorkspace", "workspace/didChangeConfiguration"];
	for (const method of reloadMethods) {
		try {
			await sendRequest(client, method, method.includes("Configuration") ? { settings: {} } : null, signal);
			output = `Reloaded ${serverName}`;
			break;
		} catch {
			// Method not supported, try next
		}
	}
	if (output.startsWith("Restarted")) {
		client.proc.kill();
	}
	return output;
}

interface WaitForDiagnosticsOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	minVersion?: number;
	expectedDocumentVersion?: number;
	allowUnversioned?: boolean;
}

function getAcceptedDiagnostics(
	publishedDiagnostics: PublishedDiagnostics | undefined,
	expectedDocumentVersion?: number,
	allowUnversioned = true,
): Diagnostic[] | undefined {
	if (!publishedDiagnostics) {
		return undefined;
	}
	if (expectedDocumentVersion === undefined) {
		return publishedDiagnostics.diagnostics;
	}
	if (publishedDiagnostics.version === expectedDocumentVersion) {
		return publishedDiagnostics.diagnostics;
	}
	if (allowUnversioned && publishedDiagnostics.version == null) {
		return publishedDiagnostics.diagnostics;
	}
	return undefined;
}

async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
	const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, allowUnversioned = true } = options;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		throwIfAborted(signal);
		const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
		const diagnostics = getAcceptedDiagnostics(
			client.diagnostics.get(uri),
			expectedDocumentVersion,
			allowUnversioned,
		);
		if (diagnostics !== undefined && versionOk) {
			return diagnostics;
		}
		await Bun.sleep(100);
	}
	const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
	if (!versionOk) {
		return [];
	}
	return getAcceptedDiagnostics(client.diagnostics.get(uri), expectedDocumentVersion, allowUnversioned) ?? [];
}

interface ToolLspChannelState {
	diagnostics: Map<string, PublishedDiagnostics>;
	diagnosticsVersion: number;
	openFiles: Map<string, { version: number; languageId: string }>;
	activeProgressTokens: Set<string | number>;
}

type LegacyBackendLspCapabilities = {
	capabilities?: NonNullable<BackendLspStatus["capabilities"]>;
};

function isLspServerCapabilities(value: unknown): value is LspServerCapabilities {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyBackendLspCapabilities(value: unknown): value is LegacyBackendLspCapabilities {
	return (
		typeof value === "object" &&
		value !== null &&
		"capabilities" in value &&
		(value.capabilities === undefined || isLspServerCapabilities(value.capabilities))
	);
}

type BackendDiagnosticsPayload =
	| BackendLspStatus["diagnostics"]
	| Map<string, PublishedDiagnostics>
	| Record<string, Diagnostic[] | PublishedDiagnostics>
	| Array<{ uri: string; diagnostics: Diagnostic[]; version?: number | null }>;

type BackendPublishedDiagnosticsEntry = { uri: string; diagnostics: Diagnostic[]; version?: number | null };

type BackendOpenFilesPayload =
	| BackendLspStatus["openFiles"]
	| Array<{ uri: string; version?: number; languageId?: string; language_id?: string }>;

interface BackendLspRuntimeStatus {
	capabilities?: NonNullable<BackendLspStatus["capabilities"]> | LegacyBackendLspCapabilities;
	projectLoaded?: BackendLspStatus["projectLoaded"];
	project_loaded?: BackendLspStatus["projectLoaded"];
	openFiles?: BackendOpenFilesPayload;
	open_files?: BackendOpenFilesPayload;
	diagnostics?: BackendDiagnosticsPayload;
	diagnosticCache?: BackendDiagnosticsPayload;
	diagnostic_cache?: BackendDiagnosticsPayload;
}

const PROJECT_LOAD_NOTIFICATION_GRACE_MS = 250;

function getBackendLspCapabilities(
	status: BackendLspRuntimeStatus | null,
): NonNullable<BackendLspStatus["capabilities"]> | null {
	const capabilities = status?.capabilities;
	if (!capabilities) return null;
	if (isLegacyBackendLspCapabilities(capabilities)) {
		return capabilities.capabilities ?? null;
	}
	return isLspServerCapabilities(capabilities) ? capabilities : null;
}

function getBackendProjectLoaded(status: BackendLspRuntimeStatus | null): boolean | null {
	return status?.projectLoaded ?? status?.project_loaded ?? null;
}

function getBackendOpenFilesCount(status: BackendLspRuntimeStatus | null): number | null {
	const raw = status?.openFiles ?? status?.open_files;
	return raw?.length ?? null;
}

function toPublishedDiagnostics(
	value: Diagnostic[] | PublishedDiagnostics | BackendPublishedDiagnosticsEntry | undefined,
): PublishedDiagnostics | null {
	if (!value) {
		return null;
	}
	if (Array.isArray(value)) {
		return {
			diagnostics: value,
			version: null,
		};
	}
	return {
		diagnostics: value.diagnostics,
		version: value.version ?? null,
	};
}

function getBackendDiagnosticsPayload(status: BackendLspRuntimeStatus | null): BackendDiagnosticsPayload | null {
	return status?.diagnostics ?? status?.diagnosticCache ?? status?.diagnostic_cache ?? null;
}

function getBackendDiagnostics(status: BackendLspRuntimeStatus | null): Map<string, PublishedDiagnostics> {
	const diagnostics = new Map<string, PublishedDiagnostics>();
	const raw = getBackendDiagnosticsPayload(status);
	if (!raw) return diagnostics;
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			const published = toPublishedDiagnostics(entry);
			if (published) diagnostics.set(entry.uri, published);
		}
		return diagnostics;
	}
	if (raw instanceof Map) {
		for (const [uri, value] of raw) {
			const published = toPublishedDiagnostics(value);
			if (published) diagnostics.set(uri, published);
		}
		return diagnostics;
	}
	for (const [uri, value] of Object.entries(raw)) {
		const published = toPublishedDiagnostics(value);
		if (published) diagnostics.set(uri, published);
	}
	return diagnostics;
}

function getBackendDiagnosticsForUri(status: BackendLspRuntimeStatus | null, uri: string): Diagnostic[] | null {
	const raw = getBackendDiagnosticsPayload(status);
	if (!raw) return null;
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (entry.uri === uri) {
				return entry.diagnostics;
			}
		}
		return null;
	}
	if (raw instanceof Map) {
		return toPublishedDiagnostics(raw.get(uri))?.diagnostics ?? null;
	}
	return toPublishedDiagnostics(raw[uri])?.diagnostics ?? null;
}

function getBackendOpenFiles(
	status: BackendLspRuntimeStatus | null,
): Map<string, { version: number; languageId: string }> {
	const openFiles = new Map<string, { version: number; languageId: string }>();
	const raw = status?.openFiles ?? status?.open_files;
	if (!raw) return openFiles;
	for (const entry of raw) {
		if (typeof entry === "string") {
			openFiles.set(entry, {
				version: 1,
				languageId: detectLanguageId(uriToFile(entry)),
			});
			continue;
		}
		openFiles.set(entry.uri, {
			version: entry.version ?? 1,
			languageId: entry.languageId ?? entry.language_id ?? detectLanguageId(uriToFile(entry.uri)),
		});
	}
	return openFiles;
}

async function getBackendLspRuntimeStatus(
	backend: Backend,
	serverName: string,
): Promise<BackendLspRuntimeStatus | null> {
	return await backend.lsp.get(serverName);
}

function createToolLspChannelState(seed?: {
	diagnostics?: Iterable<[string, PublishedDiagnostics]>;
	openFiles?: Iterable<[string, { version: number; languageId: string }]>;
	activeProgressTokens?: Iterable<string | number>;
}): ToolLspChannelState {
	const diagnostics = seed?.diagnostics ? Array.from(seed.diagnostics) : [];
	return {
		diagnostics: new Map(diagnostics),
		diagnosticsVersion: diagnostics.length,
		openFiles: new Map(seed?.openFiles),
		activeProgressTokens: new Set(seed?.activeProgressTokens),
	};
}
function mergeBackendLspRuntimeStatusIntoState(
	state: ToolLspChannelState,
	status: BackendLspRuntimeStatus | null,
): void {
	for (const [uri, published] of getBackendDiagnostics(status)) {
		state.diagnostics.set(uri, published);
	}
	state.diagnosticsVersion = Math.max(state.diagnosticsVersion, state.diagnostics.size);
	for (const [uri, openFile] of getBackendOpenFiles(status)) {
		state.openFiles.set(uri, openFile);
	}
}

function handleToolLspNotification(state: ToolLspChannelState, method: string, params: unknown): void {
	if (method === "textDocument/publishDiagnostics" && params && typeof params === "object") {
		const published = params as PublishDiagnosticsParams;
		if (typeof published.uri === "string" && Array.isArray(published.diagnostics)) {
			state.diagnostics.set(published.uri, {
				diagnostics: published.diagnostics,
				version: typeof published.version === "number" ? published.version : null,
			});
			state.diagnosticsVersion += 1;
		}
		return;
	}

	if (method !== "$/progress" || !params || typeof params !== "object") {
		return;
	}

	const progress = params as { token?: unknown; value?: { kind?: unknown } };
	if ((typeof progress.token !== "string" && typeof progress.token !== "number") || !progress.value) {
		return;
	}
	if (progress.value.kind === "begin") {
		state.activeProgressTokens.add(progress.token);
	} else if (progress.value.kind === "end") {
		state.activeProgressTokens.delete(progress.token);
	}
}

function toBackendLspConfig(serverConfig: ServerConfig, cwd: string, signal?: AbortSignal): BackendLspConfig {
	return {
		kind: "lsp",
		command: serverConfig.resolvedCommand ?? serverConfig.command,
		args: serverConfig.args ?? [],
		root_uri: fileToUri(cwd),
		initialization_options: serverConfig.initOptions,
		signal,
	};
}

async function openToolLspChannel(
	backend: Backend,
	serverName: string,
	serverConfig: ServerConfig,
	cwd: string,
	signal?: AbortSignal,
	trackedOpenFiles?: Set<string>,
): Promise<{ channel: JsonRpcChannel; state: ToolLspChannelState; close: () => Promise<void> }> {
	await backend.lsp.put(serverName, toBackendLspConfig(serverConfig, cwd, signal));
	const status = await getBackendLspRuntimeStatus(backend, serverName);
	if (trackedOpenFiles && getBackendOpenFilesCount(status) === 0) {
		trackedOpenFiles.clear();
	}
	const backendOpenFiles = getBackendOpenFiles(status);
	const initialOpenFiles = new Set(backendOpenFiles.keys());
	const openFiles = new Map(backendOpenFiles);
	if (trackedOpenFiles) {
		for (const uri of trackedOpenFiles) {
			if (openFiles.has(uri)) continue;
			openFiles.set(uri, {
				version: 1,
				languageId: detectLanguageId(uriToFile(uri)),
			});
		}
	}
	const channel = await backend.lsp.openChannel(serverName, { signal });
	const state = createToolLspChannelState({
		diagnostics: getBackendDiagnostics(status),
		openFiles,
	});
	const unsubscribe = channel.onNotification((method, params) => {
		handleToolLspNotification(state, method, params);
	});
	mergeBackendLspRuntimeStatusIntoState(state, await getBackendLspRuntimeStatus(backend, serverName));
	return {
		channel,
		state,
		close: async () => {
			unsubscribe();
			const urisToClose = Array.from(state.openFiles.keys()).filter(uri => !initialOpenFiles.has(uri));
			try {
				for (const uri of urisToClose) {
					channel.notify("textDocument/didClose", {
						textDocument: { uri },
					});
				}
			} finally {
				for (const uri of urisToClose) {
					trackedOpenFiles?.delete(uri);
					state.openFiles.delete(uri);
				}
				await channel.close();
			}
		},
	};
}

async function readLspToolFileText(backend: Backend, filePath: string): Promise<string> {
	const { bytes } = await backend.fs.readBlob(filePath);
	return new TextDecoder().decode(bytes);
}

function isBackendNotFoundError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	if ("code" in err && (err as { code?: unknown }).code === "ENOENT") return true;
	if (err instanceof Error) {
		return err.message.includes("ENOENT") || err.message.includes("not found");
	}
	return false;
}

async function ensureToolFileOpen(
	backend: Backend,
	channel: JsonRpcChannel,
	state: ToolLspChannelState,
	filePath: string,
	signal?: AbortSignal,
	trackedOpenFiles?: Set<string>,
): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	if (state.openFiles.has(uri)) {
		return;
	}

	let content: string;
	try {
		content = await readLspToolFileText(backend, filePath);
	} catch (err) {
		if (isBackendNotFoundError(err)) return;
		throw err;
	}

	const languageId = detectLanguageId(filePath);
	channel.notify("textDocument/didOpen", {
		textDocument: {
			uri,
			languageId,
			version: 1,
			text: content,
		},
	});
	state.openFiles.set(uri, { version: 1, languageId });
	trackedOpenFiles?.add(uri);
}

async function refreshToolFile(
	backend: Backend,
	channel: JsonRpcChannel,
	state: ToolLspChannelState,
	filePath: string,
	signal?: AbortSignal,
	trackedOpenFiles?: Set<string>,
): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	state.diagnostics.delete(uri);
	const openFile = state.openFiles.get(uri);
	if (!openFile) {
		await ensureToolFileOpen(backend, channel, state, filePath, signal, trackedOpenFiles);
		return;
	}

	let content: string;
	try {
		content = await readLspToolFileText(backend, filePath);
	} catch (err) {
		if (isBackendNotFoundError(err)) return;
		throw err;
	}

	const version = openFile.version + 1;
	openFile.version = version;
	channel.notify("textDocument/didChange", {
		textDocument: { uri, version },
		contentChanges: [{ text: content }],
	});
	channel.notify("textDocument/didSave", {
		textDocument: { uri },
		text: content,
	});
	trackedOpenFiles?.add(uri);
}

async function waitForToolProjectLoaded(
	backend: Backend,
	serverName: string,
	state: ToolLspChannelState,
	signal?: AbortSignal,
): Promise<void> {
	for (;;) {
		throwIfAborted(signal);
		const status = await getBackendLspRuntimeStatus(backend, serverName);
		const projectLoaded = getBackendProjectLoaded(status);
		if (projectLoaded === true) {
			return;
		}
		if (projectLoaded !== false) {
			break;
		}
		await Bun.sleep(100);
	}

	const graceDeadline = Date.now() + PROJECT_LOAD_NOTIFICATION_GRACE_MS;
	while (state.activeProgressTokens.size === 0 && Date.now() < graceDeadline) {
		throwIfAborted(signal);
		await Bun.sleep(25);
	}
	while (state.activeProgressTokens.size > 0) {
		throwIfAborted(signal);
		await Bun.sleep(100);
	}
}

async function waitForToolDiagnostics(
	state: ToolLspChannelState,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
	const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, allowUnversioned = true } = options;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		throwIfAborted(signal);
		const versionOk = minVersion === undefined || state.diagnosticsVersion > minVersion;
		const diagnostics = getAcceptedDiagnostics(state.diagnostics.get(uri), expectedDocumentVersion, allowUnversioned);
		if (diagnostics !== undefined && versionOk) {
			return diagnostics;
		}
		await Bun.sleep(100);
	}
	const versionOk = minVersion === undefined || state.diagnosticsVersion > minVersion;
	if (!versionOk) {
		return [];
	}
	return getAcceptedDiagnostics(state.diagnostics.get(uri), expectedDocumentVersion, allowUnversioned) ?? [];
}

async function reloadServerViaChannel(
	channel: JsonRpcChannel,
	serverName: string,
	signal?: AbortSignal,
): Promise<string> {
	let output = `Restarted ${serverName}`;
	const reloadMethods = ["rust-analyzer/reloadWorkspace", "workspace/didChangeConfiguration"];
	for (const method of reloadMethods) {
		try {
			await channel.request(method, method.includes("Configuration") ? { settings: {} } : null, { signal });
			output = `Reloaded ${serverName}`;
			break;
		} catch {
			// Method not supported, try next
		}
	}
	return output;
}

/** Project type detection result */
interface ProjectType {
	type: "rust" | "typescript" | "go" | "python" | "unknown";
	command?: string[];
	description: string;
}

/** Detect project type from root markers */
function detectProjectType(cwd: string): ProjectType {
	// Check for Rust (Cargo.toml)
	if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
		return { type: "rust", command: ["cargo", "check", "--message-format=short"], description: "Rust (cargo check)" };
	}

	// Check for TypeScript (tsconfig.json)
	if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
		return { type: "typescript", command: ["npx", "tsc", "--noEmit"], description: "TypeScript (tsc --noEmit)" };
	}

	// Check for Go (go.mod)
	if (fs.existsSync(path.join(cwd, "go.mod"))) {
		return { type: "go", command: ["go", "build", "./..."], description: "Go (go build)" };
	}

	// Check for Python (pyproject.toml or pyrightconfig.json)
	if (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "pyrightconfig.json"))) {
		return { type: "python", command: ["pyright"], description: "Python (pyright)" };
	}

	return { type: "unknown", description: "Unknown project type" };
}

/** Run workspace diagnostics command and parse output */
async function runWorkspaceDiagnostics(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ output: string; projectType: ProjectType }> {
	throwIfAborted(signal);
	const projectType = detectProjectType(cwd);
	if (!projectType.command) {
		return {
			output: `Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.mod), Python (pyproject.toml)`,
			projectType,
		};
	}
	const proc = Bun.spawn(projectType.command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const abortHandler = () => {
		proc.kill();
	};
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		await proc.exited;
		throwIfAborted(signal);
		const combined = (stdout + stderr).trim();
		if (!combined) {
			return { output: "No issues found", projectType };
		}
		// Limit output length
		const lines = combined.split("\n");
		if (lines.length > 50) {
			return { output: `${lines.slice(0, 50).join("\n")}\n... and ${lines.length - 50} more lines`, projectType };
		}
		return { output: combined, projectType };
	} catch (e) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return { output: `Failed to run ${projectType.command.join(" ")}: ${e}`, projectType };
	} finally {
		signal?.removeEventListener("abort", abortHandler);
	}
}

/** Result from getDiagnosticsForFile */
export interface FileDiagnosticsResult {
	/** Name of the LSP server used (if available) */
	server?: string;
	/** Formatted diagnostic messages */
	messages: string[];
	/** Summary string (e.g., "2 error(s), 1 warning(s)") */
	summary: string;
	/** Whether there are any errors (severity 1) */
	errored: boolean;
	/** Whether the file was formatted */
	formatter?: FileFormatResult;
}

type ServerVersionMap = Map<string, number>;

interface GetDiagnosticsForFileOptions {
	signal?: AbortSignal;
	minVersions?: ServerVersionMap;
	expectedDocumentVersions?: ServerVersionMap;
	allowUnversionedLspDiagnostics?: boolean;
}

/**
 * Capture current diagnostic versions for all LSP servers.
 * Call this BEFORE syncing content to detect stale diagnostics later.
 */
async function captureDiagnosticVersions(
	cwd: string,
	servers: Array<[string, ServerConfig]>,
): Promise<ServerVersionMap> {
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			if (serverConfig.createClient) return;
			const client = await getOrCreateClient(serverConfig, cwd);
			versions.set(serverName, client.diagnosticsVersion);
		}),
	);
	return versions;
}

async function captureOpenFileVersions(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
): Promise<ServerVersionMap> {
	const uri = fileToUri(absolutePath);
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd);
			const version = client.openFiles.get(uri)?.version;
			if (version !== undefined) {
				versions.set(serverName, version);
			}
		}),
	);
	return versions;
}

/**
 * Get diagnostics for a file using LSP or custom linter client.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to query diagnostics for
 * @param minVersions - Minimum diagnostic versions per server (to detect stale results)
 * @returns Diagnostic results or undefined if no servers
 */
async function getDiagnosticsForFile(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	options: GetDiagnosticsForFileOptions = {},
): Promise<FileDiagnosticsResult | undefined> {
	const { signal, minVersions, expectedDocumentVersions, allowUnversionedLspDiagnostics = true } = options;
	if (servers.length === 0) {
		return undefined;
	}

	const uri = fileToUri(absolutePath);
	const relPath = formatPathRelativeToCwd(absolutePath, cwd);
	const allDiagnostics: Diagnostic[] = [];
	const serverNames: string[] = [];

	// Wait for diagnostics from all servers in parallel
	const results = await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			throwIfAborted(signal);
			// Use custom linter client if configured
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				const diagnostics = await linterClient.lint(absolutePath);
				return { serverName, diagnostics };
			}

			// Default: use LSP
			const client = await getOrCreateClient(serverConfig, cwd);
			throwIfAborted(signal);
			if (isProjectAwareLspServer(serverConfig)) {
				await waitForProjectLoaded(client, signal);
				throwIfAborted(signal);
			}
			// Content already synced + didSave sent, wait for fresh diagnostics
			const minVersion = minVersions?.get(serverName);
			const expectedDocumentVersion = expectedDocumentVersions?.get(serverName);
			const diagnostics = await waitForDiagnostics(client, uri, {
				timeoutMs: 3000,
				signal,
				minVersion,
				expectedDocumentVersion,
				allowUnversioned: allowUnversionedLspDiagnostics,
			});
			return { serverName, diagnostics };
		}),
	);

	for (const result of results) {
		if (result.status === "fulfilled") {
			serverNames.push(result.value.serverName);
			allDiagnostics.push(...result.value.diagnostics);
		}
	}

	if (serverNames.length === 0) {
		return undefined;
	}

	if (allDiagnostics.length === 0) {
		return {
			server: serverNames.join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
	}

	// Deduplicate diagnostics by range + message (different servers might report similar issues)
	const seen = new Set<string>();
	const uniqueDiagnostics: Diagnostic[] = [];
	for (const d of allDiagnostics) {
		const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
		if (!seen.has(key)) {
			seen.add(key);
			uniqueDiagnostics.push(d);
		}
	}

	sortDiagnostics(uniqueDiagnostics);
	const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
	const limited = limitDiagnosticMessages(formatted);
	const summary = formatDiagnosticsSummary(uniqueDiagnostics);
	const hasErrors = uniqueDiagnostics.some(d => d.severity === 1);

	return {
		server: serverNames.join(", "),
		messages: limited,
		summary,
		errored: hasErrors,
	};
}

export enum FileFormatResult {
	UNCHANGED = "unchanged",
	FORMATTED = "formatted",
}

/** Default formatting options for LSP */
const DEFAULT_FORMAT_OPTIONS = {
	tabSize: 3,
	insertSpaces: true,
	trimTrailingWhitespace: true,
	insertFinalNewline: true,
	trimFinalNewlines: true,
};

/**
 * Format content using LSP or custom linter client.
 *
 * @param absolutePath - Absolute path (for URI)
 * @param content - Content to format
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to try formatting with
 * @param backend - Optional backend handle for routed LSP formatting
 * @returns Formatted content, or original if no formatter available
 */
async function formatContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
	backend?: Backend,
): Promise<string> {
	if (servers.length === 0) {
		return content;
	}

	const uri = fileToUri(absolutePath);
	const languageId = detectLanguageId(absolutePath);
	const formatterErrors: string[] = [];

	for (const [serverName, serverConfig] of servers) {
		try {
			throwIfAborted(signal);
			// Use custom linter client if configured
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				return await linterClient.format(absolutePath, content);
			}

			if (!backend) {
				throw new Error(
					"LSP writethrough formatting requires a backend; pass session.backend to createLspWritethrough().",
				);
			}

			const lsp = await openToolLspChannel(backend, serverName, serverConfig, cwd, signal);
			let opened = false;
			try {
				throwIfAborted(signal);
				const caps = getBackendLspCapabilities(await getBackendLspRuntimeStatus(backend, serverName));
				if (caps?.documentFormattingProvider === false) {
					continue;
				}

				lsp.channel.notify("textDocument/didOpen", {
					textDocument: {
						uri,
						languageId,
						version: 1,
						text: content,
					},
				});
				opened = true;

				const edits = (await lsp.channel.request(
					"textDocument/formatting",
					{
						textDocument: { uri },
						options: DEFAULT_FORMAT_OPTIONS,
					},
					{ signal },
				)) as TextEdit[] | null;

				if (!edits || edits.length === 0) {
					return content;
				}

				return applyTextEditsToString(content, edits);
			} catch (err) {
				if (isAbortLikeError(err, signal)) {
					throw err;
				}
				if (isMethodNotFoundError(err)) {
					continue;
				}
				formatterErrors.push(
					formatLspOperationError(serverName, "textDocument/formatting", absolutePath, cwd, err),
				);
			} finally {
				if (opened) {
					lsp.channel.notify("textDocument/didClose", {
						textDocument: { uri },
					});
				}
				await lsp.close();
			}
		} catch (err) {
			if (isAbortLikeError(err, signal)) {
				throw err;
			}
			formatterErrors.push(formatLspOperationError(serverName, "textDocument/formatting", absolutePath, cwd, err));
		}
	}

	if (formatterErrors.length > 0) {
		throw new Error(formatterErrors.join("\n"));
	}

	return content;
}

/** Options for creating the LSP writethrough callback */
export interface WritethroughOptions {
	/** Whether to format the file using LSP after writing */
	enableFormat?: boolean;
	/** Whether to get LSP diagnostics after writing */
	enableDiagnostics?: boolean;
	/** Called when diagnostics arrive after the main timeout. */
	onDeferredDiagnostics?: (diagnostics: FileDiagnosticsResult) => void;
	/** Signal to cancel a pending deferred diagnostics fetch. */
	deferredSignal?: AbortSignal;
}

/** Internal resolved form of {@link WritethroughOptions} that the writethrough machinery operates on. */
type ResolvedWritethroughOptions = {
	enableFormat: boolean;
	enableDiagnostics: boolean;
};

/** Per-file deferred LSP diagnostics wiring for {@link WritethroughCallback}. */
export type WritethroughDeferredHandle = {
	onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
	signal: AbortSignal;
	finalize: (diagnostics: FileDiagnosticsResult | undefined) => void;
};

/** Callback type for the LSP writethrough */
export type WritethroughCallback = (
	dst: string,
	content: string,
	signal?: AbortSignal,
	file?: BunFile,
	batch?: LspWritethroughBatchRequest,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<FileDiagnosticsResult | undefined>;

/** No-op writethrough callback */
export async function writethroughNoop(
	dst: string,
	content: string,
	_signal?: AbortSignal,
	file?: BunFile,
	_batch?: LspWritethroughBatchRequest,
	_getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	if (file) {
		await file.write(content);
	} else {
		await Bun.write(dst, content);
	}
	return undefined;
}

interface PendingWritethrough {
	dst: string;
	content: string;
	file?: BunFile;
}

interface LspWritethroughBatchRequest {
	id: string;
	flush: boolean;
}

interface LspWritethroughBatchState {
	entries: Map<string, PendingWritethrough>;
	options: ResolvedWritethroughOptions;
	backend?: Backend;
}

const writethroughBatches = new Map<string, LspWritethroughBatchState>();

function getOrCreateWritethroughBatch(
	id: string,
	options: ResolvedWritethroughOptions,
	backend?: Backend,
): LspWritethroughBatchState {
	const existing = writethroughBatches.get(id);
	if (existing) {
		existing.options.enableFormat ||= options.enableFormat;
		existing.options.enableDiagnostics ||= options.enableDiagnostics;
		existing.backend ??= backend;
		return existing;
	}
	const batch: LspWritethroughBatchState = {
		entries: new Map<string, PendingWritethrough>(),
		options: { ...options },
		backend,
	};
	writethroughBatches.set(id, batch);
	return batch;
}

export async function flushLspWritethroughBatch(
	id: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<FileDiagnosticsResult | undefined> {
	const state = writethroughBatches.get(id);
	if (!state) {
		return undefined;
	}
	writethroughBatches.delete(id);
	return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, state.backend, signal);
}

function summarizeDiagnosticMessages(messages: string[]): { summary: string; errored: boolean } {
	const counts = { error: 0, warning: 0, info: 0, hint: 0 };
	for (const message of messages) {
		const match = message.match(/\[(error|warning|info|hint)\]/i);
		if (!match) continue;
		const key = match[1].toLowerCase() as keyof typeof counts;
		counts[key] += 1;
	}

	const parts: string[] = [];
	if (counts.error > 0) parts.push(`${counts.error} error(s)`);
	if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
	if (counts.info > 0) parts.push(`${counts.info} info(s)`);
	if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);

	return {
		summary: parts.length > 0 ? parts.join(", ") : "no issues",
		errored: counts.error > 0,
	};
}

function mergeDiagnostics(
	results: Array<FileDiagnosticsResult | undefined>,
	options: ResolvedWritethroughOptions,
): FileDiagnosticsResult | undefined {
	const messages: string[] = [];
	const servers = new Set<string>();
	let hasResults = false;
	let hasFormatter = false;
	let formatted = false;

	for (const result of results) {
		if (!result) continue;
		hasResults = true;
		if (result.server) {
			for (const server of result.server.split(",")) {
				const trimmed = server.trim();
				if (trimmed) {
					servers.add(trimmed);
				}
			}
		}
		if (result.messages.length > 0) {
			messages.push(...result.messages);
		}
		if (result.formatter !== undefined) {
			hasFormatter = true;
			if (result.formatter === FileFormatResult.FORMATTED) {
				formatted = true;
			}
		}
	}

	if (!hasResults && !hasFormatter) {
		return undefined;
	}

	let summary = options.enableDiagnostics ? "no issues" : "OK";
	let errored = false;
	let limitedMessages = messages;
	if (messages.length > 0) {
		const summaryInfo = summarizeDiagnosticMessages(messages);
		summary = summaryInfo.summary;
		errored = summaryInfo.errored;
		limitedMessages = limitDiagnosticMessages(messages);
	}
	const formatter = hasFormatter ? (formatted ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED) : undefined;

	return {
		server: servers.size > 0 ? Array.from(servers).join(", ") : undefined,
		messages: limitedMessages,
		summary,
		errored,
		formatter,
	};
}

async function scheduleDeferredDiagnosticsFetch(args: {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	signal: AbortSignal;
	callback: (diagnostics: FileDiagnosticsResult) => void;
}): Promise<void> {
	try {
		const deferredTimeout = AbortSignal.timeout(25_000);
		const combined = AbortSignal.any([args.signal, deferredTimeout]);
		const diagnostics = await getDiagnosticsForFile(args.dst, args.cwd, args.servers, {
			signal: combined,
			minVersions: args.minVersions,
			expectedDocumentVersions: args.expectedDocumentVersions,
		});
		if (args.signal.aborted || diagnostics === undefined) return;
		args.callback(diagnostics);
	} catch {
		// Cancelled or LSP gave up; silently discard.
	}
}

async function runLspWritethrough(
	dst: string,
	content: string,
	cwd: string,
	options: ResolvedWritethroughOptions,
	backend: Backend | undefined,
	signal?: AbortSignal,
	file?: BunFile,
	deferred?: {
		onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
		signal: AbortSignal;
	},
): Promise<FileDiagnosticsResult | undefined> {
	const { enableFormat, enableDiagnostics } = options;
	const config = getConfig(cwd);
	const servers = getServersForFile(config, dst);
	if (servers.length === 0) {
		return writethroughNoop(dst, content, signal, file);
	}
	const { lspServers, customLinterServers } = splitServers(servers);

	let finalContent = content;
	const writeContent = async (value: string) => (file ? file.write(value) : Bun.write(dst, value));
	const getWritePromise = once(() => writeContent(finalContent));
	const useCustomFormatter = enableFormat && customLinterServers.length > 0;

	// Capture diagnostic versions BEFORE syncing to detect stale diagnostics
	const minVersions = enableDiagnostics ? await captureDiagnosticVersions(cwd, servers) : undefined;
	let expectedDocumentVersions: ServerVersionMap | undefined;

	let formatter: FileFormatResult | undefined;
	let diagnostics: FileDiagnosticsResult | undefined;
	let timedOut = false;
	try {
		const timeoutSignal = AbortSignal.timeout(5_000);
		timeoutSignal.addEventListener(
			"abort",
			() => {
				timedOut = true;
			},
			{ once: true },
		);
		const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		await untilAborted(operationSignal, async () => {
			if (useCustomFormatter) {
				// Custom linters (e.g. Biome CLI) require on-disk input.
				await writeContent(content);
				finalContent = await formatContent(dst, content, cwd, customLinterServers, operationSignal, backend);
				formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				await writeContent(finalContent);
				await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
			} else {
				// 1. Sync original content to LSP servers
				await syncFileContent(dst, content, cwd, lspServers, operationSignal);

				// 2. Format in-memory via LSP
				if (enableFormat) {
					finalContent = await formatContent(dst, content, cwd, lspServers, operationSignal, backend);
					formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				}

				// 3. If formatted, sync formatted content to LSP servers
				if (finalContent !== content) {
					await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
				}

				// 4. Write to disk
				await getWritePromise();
			}

			if (enableDiagnostics) {
				expectedDocumentVersions = await captureOpenFileVersions(dst, cwd, lspServers);
			}

			// 5. Notify saved to LSP servers
			await notifyFileSaved(dst, cwd, lspServers, operationSignal);

			// 6. Get diagnostics from all servers (wait for fresh results)
			if (enableDiagnostics) {
				diagnostics = await getDiagnosticsForFile(dst, cwd, servers, {
					signal: operationSignal,
					minVersions,
					expectedDocumentVersions,
					allowUnversionedLspDiagnostics: false,
				});
			}
		});
	} catch {
		if (timedOut) {
			formatter = undefined;
			diagnostics = undefined;
			// Schedule background diagnostic fetch if caller wants deferred results
			if (deferred && !deferred.signal.aborted && enableDiagnostics) {
				void scheduleDeferredDiagnosticsFetch({
					dst,
					cwd,
					servers,
					minVersions,
					expectedDocumentVersions,
					signal: deferred.signal,
					callback: deferred.onDeferredDiagnostics,
				});
			}
		}
		await getWritePromise();
	}

	if (formatter !== undefined) {
		diagnostics ??= {
			server: servers.map(([name]) => name).join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
		diagnostics.formatter = formatter;
	}

	return diagnostics;
}

async function flushWritethroughBatch(
	batch: PendingWritethrough[],
	cwd: string,
	options: ResolvedWritethroughOptions,
	backend: Backend | undefined,
	signal?: AbortSignal,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	if (batch.length === 0) {
		return undefined;
	}
	const results: Array<FileDiagnosticsResult | undefined> = [];
	for (const entry of batch) {
		const bundle = getDeferred?.(entry.dst);
		const deferredInner =
			bundle &&
			({
				onDeferredDiagnostics: bundle.onDeferredDiagnostics,
				signal: bundle.signal,
			} as const);
		const diag = await runLspWritethrough(
			entry.dst,
			entry.content,
			cwd,
			options,
			backend,
			signal,
			entry.file,
			deferredInner,
		);
		bundle?.finalize(diag);
		results.push(diag);
	}
	return mergeDiagnostics(results, options);
}

/** Create a writethrough callback for LSP aware write operations */
export function createLspWritethrough(
	cwd: string,
	options?: WritethroughOptions,
	backend?: Backend,
): WritethroughCallback {
	const resolvedOptions: ResolvedWritethroughOptions = {
		enableFormat: options?.enableFormat ?? false,
		enableDiagnostics: options?.enableDiagnostics ?? false,
	};
	if (!resolvedOptions.enableFormat && !resolvedOptions.enableDiagnostics) {
		return writethroughNoop;
	}
	if (isRemoteBackend(backend)) {
		return async (
			dst: string,
			content: string,
			signal?: AbortSignal,
			file?: BunFile,
			_batch?: LspWritethroughBatchRequest,
			getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
		) => {
			await writethroughNoop(dst, content, signal, file);
			const diagnostics = connectedLspDisabledDiagnostics();
			getDeferred?.(dst)?.finalize(diagnostics);
			return diagnostics;
		};
	}
	return async (
		dst: string,
		content: string,
		signal?: AbortSignal,
		file?: BunFile,
		batch?: LspWritethroughBatchRequest,
		getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
	) => {
		if (!batch) {
			const bundle = getDeferred?.(dst);
			const deferredInner =
				bundle &&
				({
					onDeferredDiagnostics: bundle.onDeferredDiagnostics,
					signal: bundle.signal,
				} as const);
			const diagnostics = await runLspWritethrough(
				dst,
				content,
				cwd,
				resolvedOptions,
				backend,
				signal,
				file,
				deferredInner,
			);
			bundle?.finalize(diagnostics);
			return diagnostics;
		}

		const state = getOrCreateWritethroughBatch(batch.id, resolvedOptions, backend);
		state.entries.set(dst, { dst, content, file });

		if (!batch.flush) {
			await writethroughNoop(dst, content, signal, file);
			return undefined;
		}

		writethroughBatches.delete(batch.id);
		return flushWritethroughBatch(
			Array.from(state.entries.values()),
			cwd,
			state.options,
			state.backend,
			signal,
			getDeferred,
		);
	};
}

/**
 * LSP tool for language server protocol operations.
 */
export class LspTool implements AgentTool<typeof lspSchema, LspToolDetails, Theme> {
	readonly name = "lsp";
	readonly label = "LSP";
	readonly loadMode = "discoverable";
	readonly summary = "Query LSP (language server) for diagnostics, hover info, and references";
	readonly description: string;
	readonly parameters = lspSchema;
	readonly renderCall = renderCall;
	readonly renderResult = renderResult;
	readonly mergeCallAndResult = true;
	readonly inline = true;
	readonly strict = true;
	private readonly openFiles = new Set<string>();

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(lspDescription);
	}

	static createIf(session: ToolSession): LspTool | null {
		return session.enableLsp === false || isRemoteBackend(session.backend) ? null : new LspTool(session);
	}

	async execute(
		_toolCallId: string,
		params: LspParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<LspToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file, line, symbol, query, new_name, apply, timeout } = params;
		const timeoutSec = clampTimeout("lsp", timeout);
		const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
		signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		throwIfAborted(signal);
		if (isRemoteBackend(this.session.backend)) {
			throw new ToolError(CONNECTED_LSP_UNAVAILABLE_MESSAGE);
		}

		const config = getConfig(this.session.cwd);
		const backend = this.session.backend;

		// Status action doesn't need a file
		if (action === "status") {
			const servers = Object.keys(config.servers);
			const lspmuxState = await detectLspmux();
			const lspmuxStatus = lspmuxState.available
				? lspmuxState.running
					? "lspmux: active (multiplexing enabled)"
					: "lspmux: installed but server not running"
				: "";

			const serverStatus =
				servers.length > 0
					? `Active language servers: ${servers.join(", ")}`
					: "No language servers configured for this project";

			const output = lspmuxStatus ? `${serverStatus}\n${lspmuxStatus}` : serverStatus;
			return {
				content: [{ type: "text", text: output }],
				details: { action, success: true, request: params },
			};
		}

		// Diagnostics can be batch or single-file - queries all applicable servers
		if (action === "diagnostics") {
			if (file === "*") {
				// `*` => run workspace diagnostics across all configured servers
				const result = await runWorkspaceDiagnostics(this.session.cwd, signal);
				return {
					content: [
						{
							type: "text",
							text: `Workspace diagnostics (${result.projectType.description}):\n${result.output}`,
						},
					],
					details: { action, success: true, request: params },
				};
			}

			if (!file) {
				return {
					content: [
						{
							type: "text",
							text: "Error: file parameter required. Use `*` for workspace-wide diagnostics or a path/glob for specific files.",
						},
					],
					details: { action, success: false, request: params },
				};
			}

			let targets: string[];
			let truncatedGlobTargets = false;
			const resolvedTargets = await resolveDiagnosticTargets(file, this.session.cwd, MAX_GLOB_DIAGNOSTIC_TARGETS);
			targets = resolvedTargets.matches;
			truncatedGlobTargets = resolvedTargets.truncated;

			if (targets.length === 0) {
				return {
					content: [{ type: "text", text: `No files matched pattern: ${file}` }],
					details: { action, success: true, request: params },
				};
			}

			const detailed = targets.length > 1 || truncatedGlobTargets;
			const diagnosticsWaitTimeoutMs = detailed
				? Math.min(BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000)
				: Math.min(SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000);
			const results: string[] = [];
			const allServerNames = new Set<string>();
			let hadDiagnosticsFailure = false;
			if (truncatedGlobTargets) {
				results.push(
					`${theme.status.warning} Pattern matched more than ${MAX_GLOB_DIAGNOSTIC_TARGETS} files; showing first ${MAX_GLOB_DIAGNOSTIC_TARGETS}. Narrow the glob or use workspace diagnostics.`,
				);
			}

			for (const target of targets) {
				throwIfAborted(signal);
				const resolved = resolveToCwd(target, this.session.cwd);
				const servers = getServersForFile(config, resolved);
				if (servers.length === 0) {
					results.push(`${theme.status.error} ${target}: No language server found`);
					hadDiagnosticsFailure = true;
					continue;
				}

				const uri = fileToUri(resolved);
				const relPath = formatPathRelativeToCwd(resolved, this.session.cwd);
				const allDiagnostics: Diagnostic[] = [];
				const successfulServers: string[] = [];
				const serverFailures: string[] = [];

				// Query all applicable servers for this file
				for (const [serverName, serverConfig] of servers) {
					allServerNames.add(serverName);
					try {
						throwIfAborted(signal);
						if (serverConfig.createClient) {
							const linterClient = getLinterClient(serverName, serverConfig, this.session.cwd);
							const diagnostics = await linterClient.lint(resolved);
							allDiagnostics.push(...diagnostics);
							successfulServers.push(serverName);
							continue;
						}
						const lsp = await openToolLspChannel(
							backend,
							serverName,
							serverConfig,
							this.session.cwd,
							signal,
							this.openFiles,
						);
						try {
							if (isProjectAwareLspServer(serverConfig)) {
								await waitForToolProjectLoaded(backend, serverName, lsp.state, signal);
								throwIfAborted(signal);
							}
							const minVersion = lsp.state.diagnosticsVersion;
							await refreshToolFile(backend, lsp.channel, lsp.state, resolved, signal, this.openFiles);
							const expectedDocumentVersion = lsp.state.openFiles.get(uri)?.version;
							const diagnostics = await waitForToolDiagnostics(lsp.state, uri, {
								timeoutMs: diagnosticsWaitTimeoutMs,
								signal,
								minVersion,
								expectedDocumentVersion,
							});
							allDiagnostics.push(...diagnostics);
							successfulServers.push(serverName);
						} finally {
							await lsp.close();
						}
					} catch (err) {
						if (isAbortLikeError(err, signal)) {
							throw err;
						}
						serverFailures.push(
							formatLspOperationError(serverName, "textDocument/diagnostic", resolved, this.session.cwd, err),
						);
					}
				}

				if (successfulServers.length === 0) {
					hadDiagnosticsFailure = true;
					const failureText = serverFailures.join("\n");
					if (!detailed && targets.length === 1) {
						return {
							content: [{ type: "text", text: failureText }],
							details: {
								action,
								serverName: Array.from(allServerNames).join(", "),
								success: false,
								request: params,
							},
						};
					}
					results.push(`${theme.status.error} ${relPath}: diagnostics failed`);
					results.push(failureText);
					continue;
				}

				// Deduplicate diagnostics
				const seen = new Set<string>();
				const uniqueDiagnostics: Diagnostic[] = [];
				for (const d of allDiagnostics) {
					const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
					if (!seen.has(key)) {
						seen.add(key);
						uniqueDiagnostics.push(d);
					}
				}

				sortDiagnostics(uniqueDiagnostics);

				if (!detailed && targets.length === 1) {
					if (uniqueDiagnostics.length === 0) {
						return {
							content: [{ type: "text", text: "OK" }],
							details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
						};
					}

					const summary = formatDiagnosticsSummary(uniqueDiagnostics);
					const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
					const output = `${summary}:\n${formatGroupedDiagnosticMessages(formatted)}`;
					return {
						content: [{ type: "text", text: output }],
						details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
					};
				}

				if (uniqueDiagnostics.length === 0) {
					results.push(`${theme.status.success} ${relPath}: no issues`);
				} else {
					const summary = formatDiagnosticsSummary(uniqueDiagnostics);
					results.push(`${theme.status.error} ${relPath}: ${summary}`);
					const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
					results.push(formatGroupedDiagnosticMessages(formatted));
				}
			}

			return {
				content: [{ type: "text", text: results.join("\n") }],
				details: {
					action,
					serverName: Array.from(allServerNames).join(", "),
					success: !hadDiagnosticsFailure,
				},
			};
		}

		if (action === "rename_file") {
			if (!file || !new_name) {
				return {
					content: [
						{
							type: "text",
							text: "Error: rename_file requires both `file` (source path) and `new_name` (destination path)",
						},
					],
					details: { action, success: false, request: params },
				};
			}

			const source = resolveToCwd(file, this.session.cwd);
			const dest = resolveToCwd(new_name, this.session.cwd);

			if (source === dest) {
				return {
					content: [{ type: "text", text: "Error: source and destination paths are identical" }],
					details: { action, success: false, request: params },
				};
			}

			let sourceStat: fs.Stats;
			try {
				sourceStat = await fs.promises.stat(source);
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Error: source path does not exist: ${formatPathRelativeToCwd(source, this.session.cwd)}`,
						},
					],
					details: { action, success: false, request: params },
				};
			}

			let destExists = false;
			try {
				await fs.promises.stat(dest);
				destExists = true;
			} catch {
				// expected: destination must not exist
			}
			if (destExists) {
				return {
					content: [
						{
							type: "text",
							text: `Error: destination already exists: ${formatPathRelativeToCwd(dest, this.session.cwd)}`,
						},
					],
					details: { action, success: false, request: params },
				};
			}

			const enumerated = await enumerateRenamePairs(source, dest);
			if (enumerated.exceeded) {
				return {
					content: [
						{
							type: "text",
							text: `Error: directory contains more than ${MAX_RENAME_PAIRS} files; rename in smaller batches to keep LSP edits accurate`,
						},
					],
					details: { action, success: false, request: params },
				};
			}
			const { pairs } = enumerated;
			if (pairs.length === 0) {
				return {
					content: [{ type: "text", text: "Error: no files to rename" }],
					details: { action, success: false, request: params },
				};
			}

			const lspParams = { files: pairs };
			const servers = getLspServers(config);
			const respondingServers = new Set<string>();
			const perServerEdits: Array<{ serverName: string; edit: WorkspaceEdit }> = [];
			const serverNotes: string[] = [];
			const activeServers: Array<{
				serverName: string;
				channel: JsonRpcChannel;
				close: () => Promise<void>;
			}> = [];

			try {
				for (const [serverName, serverConfig] of servers) {
					throwIfAborted(signal);
					try {
						const lsp = await openToolLspChannel(
							backend,
							serverName,
							serverConfig,
							this.session.cwd,
							signal,
							this.openFiles,
						);
						activeServers.push({ serverName, channel: lsp.channel, close: lsp.close });
						if (isProjectAwareLspServer(serverConfig)) {
							await waitForToolProjectLoaded(backend, serverName, lsp.state, signal);
						}
						const result = (await lsp.channel.request("workspace/willRenameFiles", lspParams, {
							signal,
						})) as WorkspaceEdit | null;
						respondingServers.add(serverName);
						if (result && (result.changes || result.documentChanges)) {
							perServerEdits.push({ serverName, edit: result });
						}
					} catch (err) {
						if (err instanceof ToolAbortError || signal?.aborted) {
							throw err;
						}
						if (!isMethodNotFoundError(err)) {
							const msg = err instanceof Error ? err.message : String(err);
							serverNotes.push(`  ${serverName}: ${msg}`);
						}
					}
				}

				const sourceLabel = formatPathRelativeToCwd(source, this.session.cwd);
				const destLabel = formatPathRelativeToCwd(dest, this.session.cwd);
				const fileCountLabel = sourceStat.isDirectory()
					? `${pairs.length} file${pairs.length !== 1 ? "s" : ""} under ${sourceLabel}`
					: sourceLabel;

				const shouldApply = apply !== false;
				if (!shouldApply) {
					const lines: string[] = [];
					lines.push(`Rename preview: ${fileCountLabel} → ${destLabel}`);
					if (perServerEdits.length === 0) {
						lines.push("  No LSP edits would be applied");
					} else {
						for (const { serverName, edit } of perServerEdits) {
							const edits = formatWorkspaceEdit(edit, this.session.cwd);
							if (edits.length === 0) continue;
							lines.push(`  ${serverName}:`);
							for (const e of edits) {
								lines.push(`    ${e}`);
							}
						}
					}
					if (serverNotes.length > 0) {
						lines.push("  Server notes:");
						lines.push(...serverNotes);
					}
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: {
							action,
							serverName: Array.from(respondingServers).join(", "),
							success: true,
							request: params,
						},
					};
				}

				const summary: string[] = [];
				for (const { serverName, edit } of perServerEdits) {
					const applied = await applyWorkspaceEdit(edit, this.session.cwd);
					if (applied.length > 0) {
						summary.push(`  ${serverName}:`);
						summary.push(...applied.map(line => `    ${line}`));
					}
				}

				await fs.promises.mkdir(path.dirname(dest), { recursive: true });
				await fs.promises.rename(source, dest);
				summary.push(`  Renamed ${sourceLabel} → ${destLabel}`);

				for (const { serverName, channel } of activeServers) {
					try {
						for (const { oldUri } of pairs) {
							if (!this.openFiles.has(oldUri)) {
								continue;
							}
							channel.notify("textDocument/didClose", {
								textDocument: { uri: oldUri },
							});
							this.openFiles.delete(oldUri);
						}
						channel.notify("workspace/didRenameFiles", lspParams);
					} catch (err) {
						if (err instanceof ToolAbortError || signal?.aborted) {
							throw err;
						}
						const msg = err instanceof Error ? err.message : String(err);
						serverNotes.push(`  ${serverName}: ${msg}`);
					}
				}

				if (serverNotes.length > 0) {
					summary.push("  Server notes:");
					summary.push(...serverNotes);
				}

				const header = `Renamed ${fileCountLabel} → ${destLabel}`;
				return {
					content: [{ type: "text", text: `${header}\n${summary.join("\n")}` }],
					details: {
						action,
						serverName: Array.from(respondingServers).join(", "),
						success: true,
						request: params,
					},
				};
			} finally {
				await Promise.allSettled(activeServers.map(server => server.close()));
			}
		}

		if (action === "capabilities") {
			let serverList: Array<[string, ServerConfig]>;
			if (file && file !== "*") {
				const resolved = resolveToCwd(file, this.session.cwd);
				serverList = getLspServersForFile(config, resolved);
				if (serverList.length === 0) {
					return {
						content: [{ type: "text", text: "No language server found for this file" }],
						details: { action, success: false, request: params },
					};
				}
			} else {
				serverList = getLspServers(config);
			}

			if (serverList.length === 0) {
				return {
					content: [{ type: "text", text: "No language servers configured" }],
					details: { action, success: false, request: params },
				};
			}

			const sections: string[] = [];
			const respondingServers = new Set<string>();
			for (const [serverName, serverConfig] of serverList) {
				throwIfAborted(signal);
				try {
					const lsp = await openToolLspChannel(
						backend,
						serverName,
						serverConfig,
						this.session.cwd,
						signal,
						this.openFiles,
					);
					try {
						respondingServers.add(serverName);
						const caps = getBackendLspCapabilities(await getBackendLspRuntimeStatus(backend, serverName));
						sections.push(`${serverName}:`);
						sections.push(
							`  capabilities: ${JSON.stringify(caps ?? null, null, 2)
								.split("\n")
								.join("\n  ")}`,
						);
					} finally {
						await lsp.close();
					}
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
					const msg = err instanceof Error ? err.message : String(err);
					sections.push(`${serverName}: failed to start (${msg})`);
				}
			}

			return {
				content: [{ type: "text", text: sections.join("\n") }],
				details: {
					action,
					serverName: Array.from(respondingServers).join(", "),
					success: true,
					request: params,
				},
			};
		}

		if (action === "request") {
			const method = query?.trim();
			if (!method) {
				return {
					content: [
						{
							type: "text",
							text: "Error: action=request requires `query` to specify the LSP method name (e.g., 'rust-analyzer/expandMacro')",
						},
					],
					details: { action, success: false, request: params },
				};
			}

			let chosenServer: [string, ServerConfig] | null = null;
			let resolvedTarget: string | null = null;
			if (file && file !== "*") {
				resolvedTarget = resolveToCwd(file, this.session.cwd);
				chosenServer = getLspServerForFile(config, resolvedTarget);
				if (!chosenServer) {
					return {
						content: [{ type: "text", text: "No language server found for this file" }],
						details: { action, success: false, request: params },
					};
				}
			} else {
				const all = getLspServers(config);
				if (all.length === 0) {
					return {
						content: [{ type: "text", text: "No language servers configured" }],
						details: { action, success: false, request: params },
					};
				}
				chosenServer = all[0];
			}

			const [chosenName, chosenConfig] = chosenServer;
			let requestParams: unknown;
			if (params.payload !== undefined) {
				try {
					requestParams = JSON.parse(params.payload);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Error: invalid JSON in payload: ${msg}` }],
						details: { action, serverName: chosenName, success: false, request: params },
					};
				}
			} else if (resolvedTarget) {
				const uri = fileToUri(resolvedTarget);
				if (line !== undefined) {
					const character = await resolveSymbolColumn(resolvedTarget, line, symbol);
					requestParams = { textDocument: { uri }, position: { line: line - 1, character } };
				} else {
					requestParams = { textDocument: { uri } };
				}
			} else {
				requestParams = {};
			}

			try {
				const lsp = await openToolLspChannel(
					backend,
					chosenName,
					chosenConfig,
					this.session.cwd,
					signal,
					this.openFiles,
				);
				try {
					if (resolvedTarget) {
						await ensureToolFileOpen(backend, lsp.channel, lsp.state, resolvedTarget, signal, this.openFiles);
					}
					const result = await lsp.channel.request(method, requestParams, { signal });
					const formatted =
						result === null || result === undefined
							? "null"
							: typeof result === "string"
								? result
								: JSON.stringify(result, null, 2);
					return {
						content: [{ type: "text", text: `${chosenName} ← ${method}:\n${formatted}` }],
						details: { action, serverName: chosenName, success: true, request: params },
					};
				} finally {
					await lsp.close();
				}
			} catch (err) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw new ToolAbortError();
				}
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `LSP error from ${chosenName} on ${method}: ${msg}` }],
					details: { action, serverName: chosenName, success: false, request: params },
				};
			}
		}

		// `*` means workspace scope for symbols/reload; other actions need a concrete file.
		const isWorkspace = file === "*";
		const requiresFile = !file && action !== "reload";

		if (requiresFile) {
			return {
				content: [
					{
						type: "text",
						text: "Error: file parameter required. Use `*` for workspace scope where supported.",
					},
				],
				details: { action, success: false },
			};
		}

		const resolvedFile = file && !isWorkspace ? resolveToCwd(file, this.session.cwd) : null;
		if (action === "symbols" && (isWorkspace || !resolvedFile)) {
			const normalizedQuery = query?.trim();
			if (!normalizedQuery) {
				return {
					content: [{ type: "text", text: "Error: query parameter required for workspace symbol search" }],
					details: { action, success: false, request: params },
				};
			}
			const servers = getLspServers(config);
			if (servers.length === 0) {
				return {
					content: [{ type: "text", text: "No language server found for this action" }],
					details: { action, success: false, request: params },
				};
			}
			const aggregatedSymbols: SymbolInformation[] = [];
			const respondingServers = new Set<string>();
			for (const [workspaceServerName, workspaceServerConfig] of servers) {
				throwIfAborted(signal);
				try {
					const lsp = await openToolLspChannel(
						backend,
						workspaceServerName,
						workspaceServerConfig,
						this.session.cwd,
						signal,
						this.openFiles,
					);
					try {
						const workspaceResult = (await lsp.channel.request(
							"workspace/symbol",
							{ query: normalizedQuery },
							{ signal },
						)) as SymbolInformation[] | null;
						if (!workspaceResult || workspaceResult.length === 0) {
							continue;
						}
						respondingServers.add(workspaceServerName);
						aggregatedSymbols.push(...filterWorkspaceSymbols(workspaceResult, normalizedQuery));
					} finally {
						await lsp.close();
					}
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
				}
			}
			const dedupedSymbols = dedupeWorkspaceSymbols(aggregatedSymbols);
			if (dedupedSymbols.length === 0) {
				return {
					content: [{ type: "text", text: `No symbols matching "${normalizedQuery}"` }],
					details: {
						action,
						serverName: Array.from(respondingServers).join(", "),
						success: true,
						request: params,
					},
				};
			}
			const limitedSymbols = dedupedSymbols.slice(0, WORKSPACE_SYMBOL_LIMIT);
			const lines = limitedSymbols.map(s => formatSymbolInformation(s, this.session.cwd));
			const truncationLine =
				dedupedSymbols.length > WORKSPACE_SYMBOL_LIMIT
					? `\n... ${dedupedSymbols.length - WORKSPACE_SYMBOL_LIMIT} additional symbol(s) omitted`
					: "";
			return {
				content: [
					{
						type: "text",
						text: `Found ${dedupedSymbols.length} symbol(s) matching "${normalizedQuery}":\n${lines.map(l => `  ${l}`).join("\n")}${truncationLine}`,
					},
				],
				details: {
					action,
					serverName: Array.from(respondingServers).join(", "),
					success: true,
					request: params,
				},
			};
		}

		if (action === "reload" && (isWorkspace || !resolvedFile)) {
			const servers = getLspServers(config);
			if (servers.length === 0) {
				return {
					content: [{ type: "text", text: "No language server found for this action" }],
					details: { action, success: false, request: params },
				};
			}
			const outputs: string[] = [];
			for (const [workspaceServerName, workspaceServerConfig] of servers) {
				throwIfAborted(signal);
				try {
					const lsp = await openToolLspChannel(
						backend,
						workspaceServerName,
						workspaceServerConfig,
						this.session.cwd,
						signal,
						this.openFiles,
					);
					try {
						outputs.push(await reloadServerViaChannel(lsp.channel, workspaceServerName, signal));
					} finally {
						await lsp.close();
					}
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
					const errorMessage = err instanceof Error ? err.message : String(err);
					outputs.push(`Failed to reload ${workspaceServerName}: ${errorMessage}`);
				}
			}
			return {
				content: [{ type: "text", text: outputs.join("\n") }],
				details: { action, serverName: servers.map(([name]) => name).join(", "), success: true, request: params },
			};
		}

		const serverInfo = resolvedFile ? getLspServerForFile(config, resolvedFile) : null;
		if (!serverInfo) {
			return {
				content: [{ type: "text", text: "No language server found for this action" }],
				details: { action, success: false },
			};
		}

		const [serverName, serverConfig] = serverInfo;

		try {
			const lsp = await openToolLspChannel(
				backend,
				serverName,
				serverConfig,
				this.session.cwd,
				signal,
				this.openFiles,
			);
			try {
				const targetFile = resolvedFile;

				if (targetFile) {
					await ensureToolFileOpen(backend, lsp.channel, lsp.state, targetFile, signal, this.openFiles);
				}

				const uri = targetFile ? fileToUri(targetFile) : "";
				const resolvedLine = line ?? 1;
				const resolvedCharacter = targetFile ? await resolveSymbolColumn(targetFile, resolvedLine, symbol) : 0;
				const position = { line: resolvedLine - 1, character: resolvedCharacter };

				let output: string;

				const crossFileActions = new Set([
					"definition",
					"type_definition",
					"implementation",
					"references",
					"rename",
				]);
				if (crossFileActions.has(action)) {
					await waitForToolProjectLoaded(backend, serverName, lsp.state, signal);
				}

				switch (action) {
					case "definition": {
						const result = (await lsp.channel.request(
							"textDocument/definition",
							{
								textDocument: { uri },
								position,
							},
							{ signal },
						)) as Location | Location[] | LocationLink | LocationLink[] | null;

						const locations = normalizeLocationResult(result);
						if (locations.length === 0) {
							output = "No definition found";
						} else {
							const lines = await Promise.all(
								locations.map(location => formatLocationWithContext(location, this.session.cwd)),
							);
							output = `Found ${locations.length} definition(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "type_definition": {
						const result = (await lsp.channel.request(
							"textDocument/typeDefinition",
							{
								textDocument: { uri },
								position,
							},
							{ signal },
						)) as Location | Location[] | LocationLink | LocationLink[] | null;

						const locations = normalizeLocationResult(result);
						if (locations.length === 0) {
							output = "No type definition found";
						} else {
							const lines = await Promise.all(
								locations.map(location => formatLocationWithContext(location, this.session.cwd)),
							);
							output = `Found ${locations.length} type definition(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "implementation": {
						const result = (await lsp.channel.request(
							"textDocument/implementation",
							{
								textDocument: { uri },
								position,
							},
							{ signal },
						)) as Location | Location[] | LocationLink | LocationLink[] | null;

						const locations = normalizeLocationResult(result);
						if (locations.length === 0) {
							output = "No implementation found";
						} else {
							const lines = await Promise.all(
								locations.map(location => formatLocationWithContext(location, this.session.cwd)),
							);
							output = `Found ${locations.length} implementation(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "references": {
						let result: Location[] | null = null;
						for (let attempt = 0; attempt <= REFERENCES_RETRY_COUNT; attempt++) {
							result = (await lsp.channel.request(
								"textDocument/references",
								{
									textDocument: { uri },
									position,
									context: { includeDeclaration: true },
								},
								{ signal },
							)) as Location[] | null;

							const locations = result ?? [];
							if (!isProjectAwareLspServer(serverConfig) || attempt === REFERENCES_RETRY_COUNT) {
								break;
							}
							if (locations.length > 0 && !isOnlyQueriedDeclaration(locations, uri, position)) {
								break;
							}

							await waitForToolProjectLoaded(backend, serverName, lsp.state, signal);
							throwIfAborted(signal);
							await untilAborted(signal, () => Bun.sleep(REFERENCES_RETRY_DELAY_MS));
						}

						if (!result || result.length === 0) {
							output = "No references found";
						} else {
							const contextualReferences = result.slice(0, REFERENCE_CONTEXT_LIMIT);
							const plainReferences = result.slice(REFERENCE_CONTEXT_LIMIT);
							const contextualLines = await Promise.all(
								contextualReferences.map(location => formatLocationWithContext(location, this.session.cwd)),
							);
							const plainLines = plainReferences.map(
								location => `  ${formatLocation(location, this.session.cwd)}`,
							);
							const lines = plainLines.length
								? [
										...contextualLines,
										`  ... ${plainLines.length} additional reference(s) shown without context`,
										...plainLines,
									]
								: contextualLines;
							output = `Found ${result.length} reference(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "hover": {
						const result = (await lsp.channel.request(
							"textDocument/hover",
							{
								textDocument: { uri },
								position,
							},
							{ signal },
						)) as Hover | null;

						if (!result?.contents) {
							output = "No hover information";
						} else {
							output = extractHoverText(result.contents);
						}
						break;
					}

					case "code_actions": {
						const diagnostics =
							getBackendDiagnosticsForUri(await getBackendLspRuntimeStatus(backend, serverName), uri) ??
							lsp.state.diagnostics.get(uri)?.diagnostics ??
							[];
						const context: CodeActionContext = {
							diagnostics,
							only: !apply && query ? [query] : undefined,
							triggerKind: 1,
						};

						const result = (await lsp.channel.request(
							"textDocument/codeAction",
							{
								textDocument: { uri },
								range: { start: position, end: position },
								context,
							},
							{ signal },
						)) as (CodeAction | Command)[] | null;

						if (!result || result.length === 0) {
							output = "No code actions available";
							break;
						}

						if (apply === true && query) {
							const normalizedQuery = query.trim();
							if (normalizedQuery.length === 0) {
								output = "Error: query parameter required when apply=true for code_actions";
								break;
							}
							const parsedIndex = /^\d+$/.test(normalizedQuery) ? Number.parseInt(normalizedQuery, 10) : null;
							const selectedAction = result.find(
								(actionItem, index) =>
									(parsedIndex !== null && index === parsedIndex) ||
									actionItem.title.toLowerCase().includes(normalizedQuery.toLowerCase()),
							);

							if (!selectedAction) {
								const actionLines = result.map(
									(actionItem, index) => `  ${formatCodeAction(actionItem, index)}`,
								);
								output = `No code action matches "${normalizedQuery}". Available actions:\n${actionLines.join("\n")}`;
								break;
							}

							const appliedAction = await applyCodeAction(selectedAction, {
								resolveCodeAction: async actionItem =>
									(await lsp.channel.request("codeAction/resolve", actionItem, { signal })) as CodeAction,
								applyWorkspaceEdit: async edit => applyWorkspaceEdit(edit, this.session.cwd),
								executeCommand: async commandItem => {
									await lsp.channel.request(
										"workspace/executeCommand",
										{
											command: commandItem.command,
											arguments: commandItem.arguments ?? [],
										},
										{ signal },
									);
								},
							});

							if (!appliedAction) {
								output = `Action "${selectedAction.title}" has no workspace edit or command to apply`;
								break;
							}

							const summaryLines: string[] = [];
							if (appliedAction.edits.length > 0) {
								summaryLines.push("  Workspace edit:");
								summaryLines.push(...appliedAction.edits.map(item => `    ${item}`));
							}
							if (appliedAction.executedCommands.length > 0) {
								summaryLines.push("  Executed command(s):");
								summaryLines.push(...appliedAction.executedCommands.map(commandName => `    ${commandName}`));
							}

							output = `Applied "${appliedAction.title}":\n${summaryLines.join("\n")}`;
							break;
						}

						const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
						output = `${result.length} code action(s):\n${actionLines.join("\n")}`;
						break;
					}

					case "symbols": {
						if (!targetFile) {
							output = "Error: file parameter required for document symbols";
							break;
						}
						const result = (await lsp.channel.request(
							"textDocument/documentSymbol",
							{
								textDocument: { uri },
							},
							{ signal },
						)) as (DocumentSymbol | SymbolInformation)[] | null;

						if (!result || result.length === 0) {
							output = "No symbols found";
						} else {
							const relPath = formatPathRelativeToCwd(targetFile, this.session.cwd);
							if ("selectionRange" in result[0]) {
								const lines = (result as DocumentSymbol[]).flatMap(s => formatDocumentSymbol(s));
								output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
							} else {
								const lines = (result as SymbolInformation[]).map(s => {
									const symbolLine = s.location.range.start.line + 1;
									const icon = symbolKindToIcon(s.kind);
									return `${icon} ${s.name} @ line ${symbolLine}`;
								});
								output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
							}
						}
						break;
					}

					case "rename": {
						if (!new_name) {
							return {
								content: [{ type: "text", text: "Error: new_name parameter required for rename" }],
								details: { action, serverName, success: false },
							};
						}

						const result = (await lsp.channel.request(
							"textDocument/rename",
							{
								textDocument: { uri },
								position,
								newName: new_name,
							},
							{ signal },
						)) as WorkspaceEdit | null;

						if (!result) {
							output = "Rename returned no edits";
						} else {
							const shouldApply = apply !== false;
							if (shouldApply) {
								const applied = await applyWorkspaceEdit(result, this.session.cwd);
								output = `Applied rename:\n${applied.map(a => `  ${a}`).join("\n")}`;
							} else {
								const preview = formatWorkspaceEdit(result, this.session.cwd);
								output = `Rename preview:\n${preview.map(p => `  ${p}`).join("\n")}`;
							}
						}
						break;
					}

					case "reload": {
						output = await reloadServerViaChannel(lsp.channel, serverName, signal);
						break;
					}

					default:
						output = `Unknown action: ${action}`;
				}

				return {
					content: [{ type: "text", text: output }],
					details: { serverName, action, success: true, request: params },
				};
			} finally {
				await lsp.close();
			}
		} catch (err) {
			if (isAbortLikeError(err, signal)) {
				throw new ToolAbortError();
			}
			const errorMessage = err instanceof Error ? err.message : String(err);
			const targetLabel = resolvedFile ? formatPathRelativeToCwd(resolvedFile, this.session.cwd) : "workspace";
			const methodLabel = describeActionMethod(action);
			const actionLabel = methodLabel ? `${action} (${methodLabel})` : action;
			return {
				content: [
					{
						type: "text",
						text: `LSP error from ${serverName} on ${targetLabel} during ${actionLabel}: ${errorMessage}`,
					},
				],
				details: { serverName, action, success: false, request: params },
			};
		}
	}
}
