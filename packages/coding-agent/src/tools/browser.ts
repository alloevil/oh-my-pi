import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { CdpAttachHandleConfig, CdpSpawnHandleConfig } from "@oh-my-pi/rwp-client";
import { type Static, Type } from "@sinclair/typebox";
import type { Backend } from "../backend";
import type { BrowserConfig } from "../backend/types";
import browserDescription from "../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { BROWSER_PROTOCOL_TIMEOUT_MS, ensureChromiumExecutable, loadPuppeteer } from "./browser/launch";
import {
	type BrowserHandle,
	type BrowserKind,
	type BrowserKindTag,
	toPuppeteerConnectOptions,
} from "./browser/registry";
import type { Observation, ScreenshotResult } from "./browser/tab-protocol";
import { acquireTab, dropHeadlessTabs, getTab, releaseAllTabs, releaseTab, runInTab } from "./browser/tab-supervisor";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./browser/readable";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";

const appSchema = Type.Object({
	path: Type.Optional(
		Type.String({
			description: "absolute path to a binary to spawn (single-instance reuse)",
			examples: ["/Applications/Cursor.app/Contents/MacOS/Cursor"],
		}),
	),
	cdp_url: Type.Optional(
		Type.String({
			description: "existing CDP endpoint to connect to (e.g. http://127.0.0.1:9222)",
		}),
	),
	args: Type.Optional(Type.Array(Type.String(), { description: "extra CLI args when spawning" })),
	target: Type.Optional(Type.String({ description: "substring matched against url+title to pick a BrowserWindow" })),
});

const browserSchema = Type.Object({
	action: StringEnum(["open", "close", "run"], { description: "tab/browser operation" }),
	name: Type.Optional(
		Type.String({
			description: "tab id; default 'main'. Multiple tabs can coexist; reusable across run() calls and subagents.",
			examples: ["main", "docs", "gh"],
		}),
	),
	url: Type.Optional(Type.String({ description: "open: navigate after acquiring tab" })),
	app: Type.Optional(appSchema),
	viewport: Type.Optional(
		Type.Object({
			width: Type.Number(),
			height: Type.Number(),
			scale: Type.Optional(Type.Number()),
		}),
	),
	wait_until: Type.Optional(
		StringEnum(["load", "domcontentloaded", "networkidle0", "networkidle2"], {
			description: "navigation wait condition for url",
		}),
	),
	dialogs: Type.Optional(
		StringEnum(["accept", "dismiss"], {
			description: "open: auto-handle alert/confirm/beforeunload dialogs (default: leave for caller to handle)",
		}),
	),
	code: Type.Optional(
		Type.String({
			description:
				"run: JS body executed with `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. Treated as the body of an async function. Use `display(value)` to attach text/JSON/images; the function's return value is JSON-serialized as a final block.",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "timeout in seconds", default: 30 })),
	all: Type.Optional(Type.Boolean({ description: "close: close every tab" })),
	kill: Type.Optional(Type.Boolean({ description: "close: also kill spawned-app browsers (default: leave running)" })),
});

/** Input schema for the browser tool. */
export type BrowserParams = Static<typeof browserSchema>;

/** Details describing a browser tool execution result (for renderers + transcript). */
export interface BrowserToolDetails {
	action: BrowserParams["action"];
	name?: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	observation?: Observation;
	screenshots?: ScreenshotResult[];
	result?: string;
	meta?: OutputMeta;
}

function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		return { kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") };
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		return { kind: "spawned", path: exe, args: normalizeAppArgs(app.args) };
	}
	const headless = session.settings.get("browser.headless") as boolean;
	return { kind: "headless", headless, args: normalizeAppArgs(app?.args) };
}

function normalizeAppArgs(args: string[] | undefined): string[] | undefined {
	return args && args.length > 0 ? [...args] : undefined;
}

function assertBrowserKindAvailable(kind: BrowserKind, backendKind: "local" | "remote"): void {
	if (backendKind !== "remote" || kind.kind === "connected") return;
	const mode = kind.kind === "headless" ? "headless launch" : "app.path spawn";
	throw new ToolError(
		`Remote browser ${mode} is disabled because local executable paths are not valid on the remote backend. Pass app.cdp_url to attach to a browser reachable from the remote server.`,
	);
}

function disconnectBrowserClient(handle: BrowserHandle): void {
	if (!handle.browser.connected) return;
	try {
		handle.browser.disconnect();
	} catch {}
}

/**
 * Browser tool: stateful, multi-tab. Three actions:
 * - `open`  → acquire/create a named tab on a browser kind (headless | spawned | connected) and optionally goto a url.
 * - `close` → release a named tab (or all tabs); dispose browser when refcount hits 0.
 * - `run`   → execute JS code against an existing tab with `page`/`browser`/`tab` helpers in scope.
 */
export class BrowserTool implements AgentTool<typeof browserSchema, BrowserToolDetails> {
	readonly name = "browser";
	readonly label = "Browser";
	readonly loadMode = "discoverable";
	readonly summary = "Control a headless browser to navigate and interact with web pages";
	readonly parameters = browserSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}
	#description?: string;
	get description(): string {
		this.#description ??= prompt.render(browserDescription, {});
		return this.#description;
	}

	/** Restart browser to apply mode changes (e.g. headless toggle). Drops only headless browsers. */
	async restartForModeChange(): Promise<void> {
		await dropHeadlessTabs();
	}

	async execute(
		_toolCallId: string,
		params: BrowserParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BrowserToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		try {
			throwIfAborted(signal);
			const timeoutSeconds = clampTimeout("browser", params.timeout);
			const timeoutMs = timeoutSeconds * 1000;
			const name = params.name ?? DEFAULT_TAB_NAME;
			const details: BrowserToolDetails = { action: params.action, name };

			switch (params.action) {
				case "open":
					return await this.#open(name, params, details, timeoutMs, signal);
				case "close":
					return await this.#close(name, params, details, signal);
				case "run":
					return await this.#run(name, params, details, timeoutMs, signal);
				default:
					throw new ToolError(`Unsupported action: ${(params as BrowserParams).action}`);
			}
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			if (error instanceof Error && error.name === "AbortError") {
				throw new ToolAbortError();
			}
			throw error;
		}
	}

	async #open(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kind = resolveBrowserKind(params, this.session);
		const backend = this.session.backend;
		const browserBackend = backend.browser;
		details.browser = kind.kind;
		assertBrowserKindAvailable(kind, backend.kind);

		// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
		const existing = getTab(name);
		if (existing && !sameBrowserKind(existing.browser.kind, kind)) {
			throw new ToolError(
				`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
			);
		}

		const browser = existing?.browser ?? (await this.#connectBackendBrowser(name, kind, backend, signal));

		try {
			const result = await untilAborted(signal, () =>
				acquireTab(name, browser, {
					url: params.url,
					waitUntil: params.wait_until,
					viewport: params.viewport
						? {
								width: params.viewport.width,
								height: params.viewport.height,
								deviceScaleFactor: params.viewport.scale,
							}
						: undefined,
					target: params.app?.target,
					timeoutMs,
					dialogs: params.dialogs,
					signal,
				}),
			);
			const tab = result.tab;
			const url = tab.info.url;
			const title = tab.info.title ?? "";
			details.url = url;
			details.viewport = tab.info.viewport;
			const verb = result.created ? "Opened" : "Reused";
			const lines = [
				`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}`,
				`URL: ${url}`,
				title ? `Title: ${title}` : null,
			].filter((l): l is string => typeof l === "string");
			details.result = lines.join("\n");
			return toolResult(details).text(lines.join("\n")).done();
		} catch (error) {
			if (!existing) {
				disconnectBrowserClient(browser);
				await untilAborted(
					signal,
					async () => await browserBackend.delete(name, { signal }).catch(() => undefined),
				);
			}
			throw error;
		}
	}

	async #close(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const backend = this.session.backend;
		const browserBackend = backend.browser;
		const kill = !!params.kill;
		if (params.all) {
			const count = await untilAborted(signal, () => releaseAllTabs({ kill }));
			const backendNames = (await untilAborted(signal, () => browserBackend.list({ signal }))).map(
				status => status.name,
			);
			await Promise.all(
				[...new Set(backendNames)].map(
					async tabName =>
						await untilAborted(
							signal,
							async () => await browserBackend.delete(tabName, { signal }).catch(() => undefined),
						),
				),
			);
			details.result = `Closed ${count} tab(s)`;
			return toolResult(details).text(details.result).done();
		}
		const status = await untilAborted(signal, () => browserBackend.get(name, { signal }));
		const closed = await untilAborted(signal, () => releaseTab(name, { kill }));
		if (closed || status) {
			await untilAborted(signal, async () => await browserBackend.delete(name, { signal }).catch(() => undefined));
		}
		details.result = closed || status ? `Closed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`;
		return toolResult(details).text(details.result).done();
	}

	async #run(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!params.code?.trim()) {
			throw new ToolError("Missing required parameter 'code' for action 'run'.");
		}
		const tab = getTab(name);
		if (tab) {
			details.browser = tab.browser.kind.kind;
			details.url = tab.info.url;
		}

		const { displays, returnValue, screenshots } = await runInTab(name, {
			code: params.code,
			timeoutMs,
			signal,
			session: this.session,
		});

		if (screenshots.length) details.screenshots = screenshots;

		const content = [...displays];
		if (returnValue !== undefined) {
			content.push({ type: "text", text: stringifyReturnValue(returnValue) });
		}
		if (!content.length) {
			content.push({ type: "text", text: `Ran code on tab ${JSON.stringify(name)}` });
		}
		const textOnly = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		details.result = textOnly;
		return toolResult(details).content(content).done();
	}
	async #connectBackendBrowser(
		name: string,
		kind: BrowserKind,
		backend: Backend,
		signal?: AbortSignal,
	): Promise<BrowserHandle> {
		const browserBackend = backend.browser;
		assertBrowserKindAvailable(kind, backend.kind);
		await untilAborted(signal, async () => await browserBackend.put(name, await toBrowserConfig(kind), { signal }));
		try {
			const cdpEndpoint = await untilAborted(signal, () => browserBackend.wsUrl(name, { signal }));
			return await untilAborted(signal, () => connectBrowserHandle(name, cdpEndpoint, kind));
		} catch (error) {
			await untilAborted(signal, async () => await browserBackend.delete(name, { signal }).catch(() => undefined));
			throw error;
		}
	}
}

async function connectBrowserHandle(name: string, cdpEndpoint: string, kind: BrowserKind): Promise<BrowserHandle> {
	const endpoint = cdpEndpoint.replace(/\/+$/, "");
	const puppeteer = await loadPuppeteer();
	const browser = await puppeteer.connect({
		...toPuppeteerConnectOptions(endpoint),
		defaultViewport: null,
		protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
	});
	return {
		key: `backend:${name}`,
		kind,
		browser,
		cdpUrl: endpoint,
		refCount: 0,
		stealth: { browserSession: null, override: null },
	};
}

async function toBrowserConfig(kind: BrowserKind): Promise<BrowserConfig> {
	switch (kind.kind) {
		case "headless": {
			const executablePath = await ensureChromiumExecutable();
			if (!executablePath) {
				throw new ToolError(
					"Unable to resolve a Chromium executable for backend browser spawn. Set PUPPETEER_EXECUTABLE_PATH or install Chrome/Chromium.",
				);
			}
			const config: CdpSpawnHandleConfig = {
				kind: "cdp-spawn",
				path: executablePath,
				args: kind.args,
				headless: kind.headless,
			};
			return config;
		}
		case "spawned": {
			const config: CdpSpawnHandleConfig = {
				kind: "cdp-spawn",
				path: kind.path,
				args: kind.args,
			};
			return config;
		}
		case "connected": {
			const config: CdpAttachHandleConfig = { kind: "cdp-attach", cdp_url: kind.cdpUrl };
			return config;
		}
	}
}

function describeBrowser(handle: BrowserHandle): string {
	switch (handle.kind.kind) {
		case "headless":
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
	}
}

function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "headless" && b.kind === "headless") {
		return a.headless === b.headless && sameStringArray(a.args, b.args);
	}
	if (a.kind === "spawned" && b.kind === "spawned") {
		return a.path === b.path && sameStringArray(a.args, b.args);
	}
	if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
	return false;
}

function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return !a && !b;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
