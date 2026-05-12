import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
} from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { logger, prompt, ptree } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { JsonRpcChannel } from "../backend/backend";
import {
	type DapAttachArguments,
	type DapBreakpoint,
	type DapBreakpointRecord,
	type DapCapabilities,
	type DapContinueArguments,
	type DapContinueOutcome,
	type DapContinueResponse,
	type DapDataBreakpointInfoArguments,
	type DapDataBreakpointInfoResponse,
	type DapDataBreakpointRecord,
	type DapDisassembleArguments,
	type DapDisassembledInstruction,
	type DapDisassembleResponse,
	type DapEvaluateArguments,
	type DapEvaluateResponse,
	type DapExitedEventBody,
	type DapFunctionBreakpoint,
	type DapFunctionBreakpointRecord,
	type DapInitializeArguments,
	type DapInstructionBreakpointRecord,
	type DapLaunchArguments,
	type DapLoadedSourcesResponse,
	type DapModule,
	type DapModulesArguments,
	type DapModulesResponse,
	type DapOutputEventBody,
	type DapPauseArguments,
	type DapReadMemoryArguments,
	type DapReadMemoryResponse,
	type DapResolvedAdapter,
	type DapRunInTerminalArguments,
	type DapRunInTerminalResponse,
	type DapScope,
	type DapScopesArguments,
	type DapScopesResponse,
	type DapSessionSummary,
	type DapSetDataBreakpointsArguments,
	type DapSetInstructionBreakpointsArguments,
	type DapSource,
	type DapSourceBreakpoint,
	type DapStackFrame,
	type DapStackTraceArguments,
	type DapStackTraceResponse,
	type DapStartDebuggingArguments,
	type DapStopLocation,
	type DapThread,
	type DapThreadsResponse,
	type DapVariable,
	type DapVariablesArguments,
	type DapVariablesResponse,
	type DapWriteMemoryArguments,
	type DapWriteMemoryResponse,
	getAvailableAdapters,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../dap";
import { NON_INTERACTIVE_ENV } from "../exec/non-interactive-env";
import type { Theme } from "../modes/theme/theme";
import debugDescription from "../prompts/tools/debug.md" with { type: "text" };
import { renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import {
	formatExpandHint,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const debugSchema = Type.Object({
	action: StringEnum([
		"launch",
		"attach",
		"set_breakpoint",
		"remove_breakpoint",
		"set_instruction_breakpoint",
		"remove_instruction_breakpoint",
		"data_breakpoint_info",
		"set_data_breakpoint",
		"remove_data_breakpoint",
		"continue",
		"step_over",
		"step_in",
		"step_out",
		"pause",
		"evaluate",
		"stack_trace",
		"threads",
		"scopes",
		"variables",
		"disassemble",
		"read_memory",
		"write_memory",
		"modules",
		"loaded_sources",
		"custom_request",
		"output",
		"terminate",
		"sessions",
	]),
	program: Type.Optional(Type.String({ description: "program path" })),
	args: Type.Optional(Type.Array(Type.String(), { description: "program arguments" })),
	adapter: Type.Optional(Type.String({ description: "debugger adapter (gdb, lldb-dap, debugpy, dlv)" })),
	cwd: Type.Optional(Type.String()),
	file: Type.Optional(Type.String({ description: "source file" })),
	line: Type.Optional(Type.Number({ description: "source line" })),
	function: Type.Optional(Type.String({ description: "function name" })),
	name: Type.Optional(Type.String({ description: "variable or data name" })),
	condition: Type.Optional(Type.String({ description: "breakpoint condition" })),
	hit_condition: Type.Optional(Type.String()),
	expression: Type.Optional(Type.String({ description: "expression to evaluate" })),
	context: Type.Optional(
		Type.String({ description: "evaluate context: watch | repl | hover | variables | clipboard" }),
	),
	frame_id: Type.Optional(Type.Number()),
	scope_id: Type.Optional(Type.Number({ description: "scope variables reference" })),
	variable_ref: Type.Optional(Type.Number({ description: "variable reference" })),
	pid: Type.Optional(Type.Number({ description: "process id for attach" })),
	port: Type.Optional(Type.Number({ description: "remote attach port" })),
	host: Type.Optional(Type.String({ description: "remote attach host" })),
	levels: Type.Optional(Type.Number({ description: "max stack frames" })),
	memory_reference: Type.Optional(Type.String({ description: "memory reference or address" })),
	instruction_reference: Type.Optional(Type.String()),
	instruction_count: Type.Optional(Type.Number()),
	instruction_offset: Type.Optional(Type.Number()),
	count: Type.Optional(Type.Number({ description: "bytes to read" })),
	data: Type.Optional(Type.String({ description: "base64 memory payload" })),
	data_id: Type.Optional(Type.String({ description: "data breakpoint id" })),
	access_type: Type.Optional(StringEnum(["read", "write", "readWrite"])),
	command: Type.Optional(Type.String({ description: "custom dap request command" })),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "custom request arguments" })),
	offset: Type.Optional(Type.Number()),
	resolve_symbols: Type.Optional(Type.Boolean()),
	allow_partial: Type.Optional(Type.Boolean()),
	start_module: Type.Optional(Type.Number()),
	module_count: Type.Optional(Type.Number()),
	timeout: Type.Optional(Type.Number({ description: "per-request timeout seconds" })),
});

export type DebugParams = Static<typeof debugSchema>;
export type DebugAction = DebugParams["action"];

interface DebugToolDetails {
	action: DebugAction;
	success: boolean;
	snapshot?: DapSessionSummary;
	sessions?: DapSessionSummary[];
	stackFrames?: DapStackFrame[];
	threads?: DapThread[];
	scopes?: DapScope[];
	variables?: DapVariable[];
	sources?: DapSource[];
	modules?: DapModule[];
	evaluation?: DapEvaluateResponse;
	breakpoints?: DapBreakpointRecord[];
	functionBreakpoints?: DapFunctionBreakpointRecord[];
	instructionBreakpoints?: DapInstructionBreakpointRecord[];
	dataBreakpoints?: DapDataBreakpointRecord[];
	dataBreakpointInfo?: DapDataBreakpointInfoResponse;
	disassembly?: DapDisassembledInstruction[];
	memoryAddress?: string;
	memoryData?: string;
	unreadableBytes?: number;
	bytesWritten?: number;
	customBody?: unknown;
	output?: string;
	adapter?: string;
	state?: DapContinueOutcome["state"];
	timedOut?: boolean;
	meta?: OutputMeta;
}

function formatLocation(snapshot: DapSessionSummary | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) {
		return null;
	}
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

function formatSessionSnapshot(snapshot: DapSessionSummary): string[] {
	const lines = [
		`Session ${snapshot.id}`,
		`Adapter: ${snapshot.adapter}`,
		`Status: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) {
		lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`);
	}
	const location = formatLocation(snapshot);
	if (location) lines.push(`Location: ${location}`);
	if (snapshot.needsConfigurationDone) {
		lines.push("Configuration: pending configurationDone; set breakpoints, then continue.");
	}
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}

function formatBreakpoints(filePath: string, breakpoints: DapBreakpointRecord[]): string {
	const lines = [`Breakpoints for ${filePath}:`];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- line ${breakpoint.line}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatFunctionBreakpoints(breakpoints: DapFunctionBreakpointRecord[]): string {
	const lines = ["Function breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- ${breakpoint.name}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatStackFrames(frames: DapStackFrame[]): string {
	const lines = ["Stack trace:"];
	if (frames.length === 0) {
		lines.push("(empty)");
		return lines.join("\n");
	}
	for (const frame of frames) {
		const location = frame.source?.path
			? `${frame.source.path}:${frame.line}:${frame.column}`
			: `<unknown>:${frame.line}:${frame.column}`;
		lines.push(`- #${frame.id} ${frame.name} @ ${location}`);
	}
	return lines.join("\n");
}

function formatThreads(threads: DapThread[]): string {
	const lines = ["Threads:"];
	if (threads.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const thread of threads) {
		lines.push(`- ${thread.id}: ${thread.name}`);
	}
	return lines.join("\n");
}

function formatScopes(scopes: DapScope[]): string {
	const lines = ["Scopes:"];
	if (scopes.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const scope of scopes) {
		lines.push(
			`- ${scope.name}: ref=${scope.variablesReference}, expensive=${scope.expensive ? "yes" : "no"}${scope.presentationHint ? `, hint=${scope.presentationHint}` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatVariables(variables: DapVariable[]): string {
	const lines = ["Variables:"];
	if (variables.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const variable of variables) {
		lines.push(
			`- ${variable.name} = ${variable.value}${variable.type ? ` (${variable.type})` : ""}${variable.variablesReference > 0 ? ` [ref=${variable.variablesReference}]` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatSourceLabel(source: DapSource | undefined, line?: number, column?: number): string | null {
	if (!source?.path && !source?.name) {
		return null;
	}
	const base = source.path ?? source.name ?? "<unknown>";
	if (line === undefined) {
		return base;
	}
	return `${base}:${line}${column !== undefined ? `:${column}` : ""}`;
}

function formatDisassembly(instructions: DapDisassembledInstruction[]): string {
	const lines = ["Disassembly:"];
	if (instructions.length === 0) {
		lines.push("(empty)");
		return lines.join("\n");
	}
	const addressWidth = Math.max(...instructions.map(instruction => instruction.address.length));
	const bytesWidth = Math.max(...instructions.map(instruction => instruction.instructionBytes?.length ?? 0), 2);
	for (const instruction of instructions) {
		const location = formatSourceLabel(instruction.location, instruction.line, instruction.column);
		const parts = [
			instruction.address.padEnd(addressWidth),
			(instruction.instructionBytes ?? "").padEnd(bytesWidth),
			instruction.instruction,
		];
		if (instruction.symbol) {
			parts.push(`<${instruction.symbol}>`);
		}
		if (location) {
			parts.push(`[${location}]`);
		}
		lines.push(
			parts
				.filter(part => part.length > 0)
				.join("  ")
				.trimEnd(),
		);
	}
	return lines.join("\n");
}

function formatMemoryRead(address: string, data: string | undefined, unreadableBytes?: number): string {
	const lines = [`Memory at ${address}:`];
	const buffer = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
	if (buffer.length === 0) {
		lines.push("(no readable bytes)");
	} else {
		for (let offset = 0; offset < buffer.length; offset += 16) {
			const chunk = buffer.subarray(offset, offset + 16);
			const hex = Array.from(chunk, byte => byte.toString(16).padStart(2, "0")).join(" ");
			const ascii = Array.from(chunk, byte => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
			lines.push(
				`${(offset === 0 ? address : `+0x${offset.toString(16)}`).padEnd(18)} ${hex.padEnd(47)} |${ascii}|`,
			);
		}
	}
	if (unreadableBytes !== undefined && unreadableBytes > 0) {
		lines.push(`Unreadable bytes: ${unreadableBytes}`);
	}
	return lines.join("\n");
}

function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map(row => (row[index] ?? "").length)),
	);
	const formatRow = (row: string[]) => row.map((cell, index) => (cell ?? "").padEnd(widths[index])).join("  ");
	return [formatRow(headers), formatRow(widths.map(width => "-".repeat(width))), ...rows.map(formatRow)].join("\n");
}

function formatModules(modules: DapModule[]): string {
	if (modules.length === 0) {
		return "Modules:\n(none)";
	}
	return [
		"Modules:",
		formatTable(
			["ID", "Name", "Path", "Symbols", "Range"],
			modules.map(module => [
				String(module.id),
				module.name,
				module.path ?? "",
				module.symbolStatus ?? "",
				module.addressRange ?? "",
			]),
		),
	].join("\n");
}

function formatLoadedSources(sources: DapSource[]): string {
	const lines = ["Loaded sources:"];
	if (sources.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const source of sources) {
		const label = source.path ?? source.name ?? "<unknown>";
		lines.push(`- ${label}${source.sourceReference !== undefined ? ` [ref=${source.sourceReference}]` : ""}`);
	}
	return lines.join("\n");
}

function formatInstructionBreakpoints(breakpoints: DapInstructionBreakpointRecord[]): string {
	const lines = ["Instruction breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		const location = `${breakpoint.instructionReference}${breakpoint.offset !== undefined ? `+${breakpoint.offset}` : ""}`;
		lines.push(
			`- ${location}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.hitCondition ? ` after ${breakpoint.hitCondition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatDataBreakpointInfo(info: DapDataBreakpointInfoResponse): string {
	const lines = [`Data breakpoint info: ${info.description}`];
	lines.push(`Data ID: ${info.dataId ?? "(not available)"}`);
	if (info.accessTypes && info.accessTypes.length > 0) {
		lines.push(`Access types: ${info.accessTypes.join(", ")}`);
	}
	if (info.canPersist !== undefined) {
		lines.push(`Persistent: ${info.canPersist ? "yes" : "no"}`);
	}
	return lines.join("\n");
}

function formatDataBreakpoints(breakpoints: DapDataBreakpointRecord[]): string {
	const lines = ["Data breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- ${breakpoint.dataId}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.accessType ? ` (${breakpoint.accessType})` : ""}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.hitCondition ? ` after ${breakpoint.hitCondition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatCustomResponse(command: string, body: unknown): string {
	let serialized = "";
	try {
		serialized = JSON.stringify(body, null, 2) ?? "null";
	} catch {
		serialized = Bun.inspect(body);
	}
	return `${command} response:\n${serialized}`;
}

function formatSessions(sessions: DapSessionSummary[]): string {
	if (sessions.length === 0) {
		return "No debug sessions.";
	}
	return sessions
		.map(session => {
			const location = formatLocation(session);
			return [
				`${session.id}: ${session.status}`,
				`  adapter=${session.adapter}`,
				`  cwd=${session.cwd}`,
				...(session.program ? [`  program=${session.program}`] : []),
				...(location ? [`  location=${location}`] : []),
				...(session.stopReason ? [`  reason=${session.stopReason}`] : []),
			].join("\n");
		})
		.join("\n\n");
}

function formatEvaluation(evaluation: DapEvaluateResponse): string {
	const lines = [`Result: ${evaluation.result}`];
	if (evaluation.type) lines.push(`Type: ${evaluation.type}`);
	if (evaluation.variablesReference > 0) {
		lines.push(`Variables ref: ${evaluation.variablesReference}`);
	}
	return lines.join("\n");
}

function buildOutcomeText(outcome: DapContinueOutcome, timeoutSec: number, verb: string): string {
	const lines = formatSessionSnapshot(outcome.snapshot);
	if (outcome.timedOut) {
		lines.push(`Program is still running after ${timeoutSec}s. Use pause to interrupt and inspect state.`);
		return lines.join("\n");
	}
	if (outcome.state === "stopped") {
		lines.push(`${verb} stopped at ${formatLocation(outcome.snapshot) ?? "unknown location"}.`);
		return lines.join("\n");
	}
	if (outcome.state === "terminated") {
		lines.push(
			`Program terminated${outcome.snapshot.exitCode !== undefined ? ` with exit code ${outcome.snapshot.exitCode}` : ""}.`,
		);
		return lines.join("\n");
	}
	lines.push("Program is running.");
	return lines.join("\n");
}

function getConfiguredAdapters(cwd: string): string {
	const adapters = getAvailableAdapters(cwd).map(adapter => adapter.name);
	return adapters.length > 0 ? adapters.join(", ") : "none";
}

interface DebugRenderArgs extends Partial<DebugParams> {}

const DEBUG_HANDLE_BASENAME = "debug";
const MAX_OUTPUT_BYTES = 128 * 1024;
const STOP_CAPTURE_TIMEOUT_MS = 5_000;
const ADAPTER_LIVENESS_POLL_INTERVAL_MS = 1_000;
const SUPPORTS_REVERSE_DAP_REQUESTS = true;
const CONNECTED_DEBUG_UNAVAILABLE_MESSAGE =
	"Debug is unavailable in connected sessions because remote DAP behavior is not trustworthy yet.";
const UNSUPPORTED_REVERSE_DAP_REQUEST_ERROR =
	"this debug adapter requires reverse-request support which is unavailable on the current backend";

function isConnectedSession(session: ToolSession): boolean {
	return session.backend?.kind === "remote";
}

function assertDebugAvailable(session: ToolSession): void {
	if (isConnectedSession(session)) {
		throw new ToolError(CONNECTED_DEBUG_UNAVAILABLE_MESSAGE);
	}
}

interface DebugNotificationWaiter {
	methods: Set<string>;
	resolve: (event: { method: string; params: unknown }) => void;
	reject: (error: Error) => void;
	timeout?: ReturnType<typeof setTimeout>;
	abortHandler?: () => void;
}

interface DebugSessionState {
	id: string;
	handleName: string;
	adapter: DapResolvedAdapter;
	cwd: string;
	program?: string;
	channel: JsonRpcChannel;
	unsubscribeNotifications: () => void;
	unsubscribeReverseRequests: () => void;
	unsubscribeLiveness: () => void;
	status: "launching" | "configuring" | "running" | "stopped" | "terminated";
	launchedAt: number;
	lastUsedAt: number;
	breakpoints: Map<string, DapBreakpointRecord[]>;
	functionBreakpoints: DapFunctionBreakpointRecord[];
	instructionBreakpoints: DapInstructionBreakpointRecord[];
	dataBreakpoints: DapDataBreakpointRecord[];
	output: string;
	outputBytes: number;
	outputTruncated: boolean;
	stop: DapStopLocation;
	threads: DapThread[];
	lastStackFrames: DapStackFrame[];
	exitCode?: number;
	capabilities?: DapCapabilities;
	initializedSeen: boolean;
	needsConfigurationDone: boolean;
	configurationDoneSent: boolean;
	notificationWaiters: Set<DebugNotificationWaiter>;
}

function truncateOutput(session: DebugSessionState, output: string): void {
	if (!output) return;
	session.output += output;
	session.outputBytes += Buffer.byteLength(output, "utf-8");
	while (Buffer.byteLength(session.output, "utf-8") > MAX_OUTPUT_BYTES) {
		session.output = session.output.slice(Math.min(1024, session.output.length));
		session.outputTruncated = true;
	}
}

function summarizeBreakpointCount(breakpoints: Map<string, DapBreakpointRecord[]>): number {
	let total = 0;
	for (const entries of breakpoints.values()) {
		total += entries.length;
	}
	return total;
}

function buildSummary(session: DebugSessionState): DapSessionSummary {
	return {
		id: session.id,
		adapter: session.adapter.name,
		cwd: session.cwd,
		program: session.program,
		status: session.status,
		launchedAt: new Date(session.launchedAt).toISOString(),
		lastUsedAt: new Date(session.lastUsedAt).toISOString(),
		threadId: session.stop.threadId,
		frameId: session.stop.frameId,
		stopReason: session.stop.reason,
		stopDescription: session.stop.description ?? session.stop.text,
		frameName: session.stop.frameName,
		instructionPointerReference: session.stop.instructionPointerReference,
		source: session.stop.source,
		line: session.stop.line,
		column: session.stop.column,
		breakpointFiles: session.breakpoints.size,
		breakpointCount: summarizeBreakpointCount(session.breakpoints),
		functionBreakpointCount: session.functionBreakpoints.length,
		outputBytes: session.outputBytes,
		outputTruncated: session.outputTruncated,
		exitCode: session.exitCode,
		needsConfigurationDone: session.needsConfigurationDone && !session.configurationDoneSent,
	};
}

function buildInitializeArguments(adapter: DapResolvedAdapter): DapInitializeArguments {
	return {
		clientID: "omp",
		clientName: "Oh My Pi",
		adapterID: adapter.name,
		locale: "en-US",
		linesStartAt1: true,
		columnsStartAt1: true,
		pathFormat: "path",
		supportsRunInTerminalRequest: SUPPORTS_REVERSE_DAP_REQUESTS,
		supportsStartDebuggingRequest: SUPPORTS_REVERSE_DAP_REQUESTS,
		supportsMemoryReferences: true,
		supportsVariableType: true,
		supportsInvalidatedEvent: true,
	};
}

function throwIfReverseRequestsAreRequired(_requestArgs: DapLaunchArguments | DapAttachArguments): void {}

function wrapReverseRequestError(error: unknown): unknown {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
	if (message && /reverse-request support|No reverse request handler registered/u.test(message)) {
		return new ToolError(UNSUPPORTED_REVERSE_DAP_REQUEST_ERROR);
	}
	return error;
}

function mapSourceBreakpoints(
	input: DapBreakpointRecord[],
	responseBreakpoints: DapBreakpoint[] | undefined,
): DapBreakpointRecord[] {
	return input.map((entry, index) => ({
		line: entry.line,
		condition: entry.condition,
		id: responseBreakpoints?.[index]?.id,
		verified: responseBreakpoints?.[index]?.verified ?? false,
		message: responseBreakpoints?.[index]?.message,
	}));
}

function mapFunctionBreakpoints(
	input: DapFunctionBreakpointRecord[],
	responseBreakpoints: DapBreakpoint[] | undefined,
): DapFunctionBreakpointRecord[] {
	return input.map((entry, index) => ({
		name: entry.name,
		condition: entry.condition,
		id: responseBreakpoints?.[index]?.id,
		verified: responseBreakpoints?.[index]?.verified ?? false,
		message: responseBreakpoints?.[index]?.message,
	}));
}

function mapInstructionBreakpoints(
	input: DapInstructionBreakpointRecord[],
	responseBreakpoints: DapBreakpoint[] | undefined,
): DapInstructionBreakpointRecord[] {
	return input.map((entry, index) => ({
		instructionReference: responseBreakpoints?.[index]?.instructionReference ?? entry.instructionReference,
		offset: responseBreakpoints?.[index]?.offset ?? entry.offset,
		condition: entry.condition,
		hitCondition: entry.hitCondition,
		id: responseBreakpoints?.[index]?.id,
		verified: responseBreakpoints?.[index]?.verified ?? false,
		message: responseBreakpoints?.[index]?.message,
	}));
}

function mapDataBreakpoints(
	input: DapDataBreakpointRecord[],
	responseBreakpoints: DapBreakpoint[] | undefined,
): DapDataBreakpointRecord[] {
	return input.map((entry, index) => ({
		dataId: entry.dataId,
		accessType: entry.accessType,
		condition: entry.condition,
		hitCondition: entry.hitCondition,
		id: responseBreakpoints?.[index]?.id,
		verified: responseBreakpoints?.[index]?.verified ?? false,
		message: responseBreakpoints?.[index]?.message,
	}));
}

function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? args.action.replaceAll("_", " ") : "request";
	if (args.program) {
		return `${action} ${truncateToWidth(args.program, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.file && args.line !== undefined) {
		return `${action} ${truncateToWidth(`${args.file}:${args.line}`, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.function) {
		return `${action} ${truncateToWidth(args.function, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.expression) {
		return `${action} ${truncateToWidth(args.expression, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.command) {
		return `${action} ${truncateToWidth(args.command, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.memory_reference) {
		return `${action} ${truncateToWidth(args.memory_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.instruction_reference) {
		return `${action} ${truncateToWidth(args.instruction_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.data_id) {
		return `${action} ${truncateToWidth(args.data_id, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.name) {
		return `${action} ${truncateToWidth(args.name, TRUNCATE_LENGTHS.TITLE)}`;
	}
	return action;
}

export const debugToolRenderer = {
	renderCall(args: DebugRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Debug", description: summarizeDebugCall(args) }, theme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DebugToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DebugRenderArgs,
	): Component {
		const outputBlock = new CachedOutputBlock();
		return {
			render(width: number): string[] {
				const action = (args?.action ?? result.details?.action ?? "debug").replaceAll("_", " ");
				const status = options.isPartial ? "running" : result.isError ? "error" : "success";
				const header = `${formatStatusIcon(status, theme, options.spinnerFrame)} Debug ${action}`;
				const summaryLines = result.details?.snapshot
					? formatSessionSnapshot(result.details.snapshot).map(line => replaceTabs(line))
					: [];
				const text = result.content.find(block => block.type === "text")?.text ?? "No output";
				const rawLines = replaceTabs(text).split("\n");
				const previewLimit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
				const displayedLines = rawLines
					.slice(0, previewLimit)
					.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE));
				const remaining = rawLines.length - displayedLines.length;
				if (remaining > 0) {
					displayedLines.push(
						theme.fg("muted", `… ${remaining} more lines ${formatExpandHint(theme, options.expanded, true)}`),
					);
				}
				return outputBlock.render(
					{
						header,
						state: result.isError ? "error" : "success",
						sections: [
							...(summaryLines.length > 0
								? [{ label: theme.fg("toolTitle", "Session"), lines: summaryLines }]
								: []),
							{ label: theme.fg("toolTitle", "Output"), lines: displayedLines },
						],
						width,
						applyBg: false,
					},
					theme,
				);
			},
			invalidate() {
				outputBlock.invalidate();
			},
		};
	},
	mergeCallAndResult: true,
	inline: true,
};

export class DebugTool implements AgentTool<typeof debugSchema, DebugToolDetails> {
	readonly name = "debug";
	readonly label = "Debug";
	readonly summary = "Debug a running process with DAP (debugger adapter protocol)";
	readonly description: string;
	readonly parameters = debugSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	#activeSession: DebugSessionState | null = null;
	#nextId = 0;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(debugDescription);
	}

	static createIf(session: ToolSession): DebugTool | null {
		return session.settings.get("debug.enabled") && !isConnectedSession(session) ? new DebugTool(session) : null;
	}

	#getHandleName(): string {
		const sessionId = this.session.getSessionId?.();
		return sessionId ? `${DEBUG_HANDLE_BASENAME}:${sessionId}` : DEBUG_HANDLE_BASENAME;
	}

	async #deleteStaleHandle(handleName: string): Promise<void> {
		const backend = this.session.backend;
		const existing = await backend.dap.get(handleName);
		if (existing) {
			await backend.dap.delete(handleName);
		}
	}

	async #putHandle(
		handleName: string,
		cfg: {
			kind: "dap";
			command: string;
			args?: string[];
			transport: "tcp" | "stdio";
		},
		signal?: AbortSignal,
	): Promise<void> {
		const backend = this.session.backend;
		await backend.dap.put(handleName, cfg, { signal });
	}

	#markSessionTerminated(session: DebugSessionState): void {
		if (session.status === "terminated") {
			return;
		}
		this.#handleNotification(session, "terminated", {});
	}

	#watchAdapterLiveness(session: DebugSessionState): () => void {
		const backend = this.session.backend;
		let disposed = false;
		let inFlight = false;
		const interval = setInterval(() => {
			if (disposed || inFlight || this.#activeSession?.id !== session.id || session.status === "terminated") {
				return;
			}
			inFlight = true;
			void backend.dap
				.get(session.handleName)
				.then(status => {
					if (disposed || this.#activeSession?.id !== session.id || session.status === "terminated") {
						return;
					}
					if (!status || status.state === "closed" || status.state === "error") {
						this.#markSessionTerminated(session);
					}
				})
				.catch(() => undefined)
				.finally(() => {
					inFlight = false;
				});
		}, ADAPTER_LIVENESS_POLL_INTERVAL_MS);
		return () => {
			disposed = true;
			clearInterval(interval);
		};
	}
	async #handleRunInTerminalReverseRequest(
		session: DebugSessionState,
		rawArgs: unknown,
	): Promise<DapRunInTerminalResponse> {
		const args = (rawArgs ?? {}) as DapRunInTerminalArguments;
		if (!Array.isArray(args.args) || args.args.length === 0) {
			throw new Error("runInTerminal request did not include a command");
		}
		const env = Object.fromEntries(
			Object.entries(args.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
		);
		const proc = ptree.spawn(args.args, {
			cwd: args.cwd ?? session.cwd,
			stdin: "pipe",
			env: {
				...Bun.env,
				...NON_INTERACTIVE_ENV,
				...env,
			},
			detached: true,
		});
		return { processId: proc.pid } satisfies DapRunInTerminalResponse;
	}

	async #handleStartDebuggingReverseRequest(
		session: DebugSessionState,
		rawArgs: unknown,
	): Promise<Record<string, never>> {
		const startArgs = (rawArgs ?? {}) as Partial<DapStartDebuggingArguments>;
		const request = startArgs.request === "attach" ? "attach" : "launch";
		const configuration =
			startArgs.configuration && typeof startArgs.configuration === "object" ? startArgs.configuration : {};
		logger.debug("Adapter requested child debug session", {
			adapter: session.adapter.name,
			sessionId: session.id,
			request,
			name: typeof configuration.name === "string" ? configuration.name : undefined,
		});
		return {};
	}

	#getActiveSessionOrThrow(): DebugSessionState {
		const session = this.#activeSession;
		if (!session) {
			throw new ToolError("No active debug session. Launch or attach first.");
		}
		session.lastUsedAt = Date.now();
		return session;
	}

	#requireCapability(capability: keyof DapCapabilities, description: string): DebugSessionState {
		const session = this.#getActiveSessionOrThrow();
		if (session.capabilities?.[capability] !== true) {
			throw new ToolError(`Current adapter does not support ${description}`);
		}
		return session;
	}

	#resolveDisassemblyReference(memoryReference: string | undefined): string {
		if (memoryReference) {
			return memoryReference;
		}
		const session = this.#getActiveSessionOrThrow();
		if (session.stop.instructionPointerReference) {
			return session.stop.instructionPointerReference;
		}
		throw new ToolError(
			"disassemble requires memory_reference unless the current stop location has an instruction pointer reference",
		);
	}

	async #disposeSession(session: DebugSessionState, deleteHandle: boolean): Promise<void> {
		for (const waiter of Array.from(session.notificationWaiters)) {
			waiter.reject(new Error("Debug session closed"));
		}
		session.notificationWaiters.clear();
		session.unsubscribeReverseRequests();
		session.unsubscribeNotifications();
		session.unsubscribeLiveness();
		await session.channel.close().catch(() => undefined);
		if (deleteHandle) {
			const backend = this.session.backend;
			await backend.dap.delete(session.handleName).catch(() => undefined);
		}
		if (this.#activeSession?.id === session.id) {
			this.#activeSession = null;
		}
	}

	async #disposeActiveSession(deleteHandle: boolean): Promise<void> {
		const session = this.#activeSession;
		if (!session) return;
		await this.#disposeSession(session, deleteHandle);
	}

	#resolveNotificationWaiters(session: DebugSessionState, method: string, params: unknown): void {
		for (const waiter of Array.from(session.notificationWaiters)) {
			if (waiter.methods.has(method)) {
				waiter.resolve({ method, params });
			}
		}
	}

	#handleNotification(session: DebugSessionState, method: string, params: unknown): void {
		session.lastUsedAt = Date.now();
		switch (method) {
			case "output":
				truncateOutput(session, (params as DapOutputEventBody | undefined)?.output ?? "");
				break;
			case "initialized":
				session.initializedSeen = true;
				session.status = session.configurationDoneSent ? session.status : "configuring";
				break;
			case "stopped": {
				const stopped = params as DapStopLocation & { reason?: string };
				session.status = "stopped";
				session.stop = {
					threadId: stopped.threadId,
					reason: stopped.reason,
					description: stopped.description,
					text: stopped.text,
				};
				session.lastStackFrames = [];
				break;
			}
			case "continued": {
				const continued = params as { threadId?: number } | undefined;
				session.status = "running";
				session.stop = { threadId: continued?.threadId };
				session.lastStackFrames = [];
				break;
			}
			case "exited":
				session.exitCode = (params as DapExitedEventBody | undefined)?.exitCode;
				break;
			case "terminated":
				session.status = "terminated";
				break;
		}
		this.#resolveNotificationWaiters(session, method, params);
	}

	async #waitForNotification(
		session: DebugSessionState,
		methods: string | string[],
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ method: string; params: unknown }> {
		const methodSet = new Set(Array.isArray(methods) ? methods : [methods]);
		return await new Promise((resolve, reject) => {
			let waiter!: DebugNotificationWaiter;
			const cleanup = () => {
				session.notificationWaiters.delete(waiter);
				if (waiter.timeout) clearTimeout(waiter.timeout);
				if (waiter.abortHandler && signal) {
					signal.removeEventListener("abort", waiter.abortHandler);
				}
			};
			waiter = {
				methods: methodSet,
				resolve(event) {
					cleanup();
					resolve(event);
				},
				reject(error) {
					cleanup();
					reject(error);
				},
			};
			if (signal?.aborted) {
				waiter.reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted"));
				return;
			}
			if (signal) {
				waiter.abortHandler = () =>
					waiter.reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted"));
				signal.addEventListener("abort", waiter.abortHandler, { once: true });
			}
			if (timeoutMs > 0) {
				waiter.timeout = setTimeout(() => {
					waiter.reject(new Error(`Timed out waiting for ${Array.from(methodSet).join(" or ")}`));
				}, timeoutMs);
			}
			session.notificationWaiters.add(waiter);
		});
	}

	async #completeConfigurationHandshake(
		session: DebugSessionState,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<void> {
		if (!session.needsConfigurationDone || session.configurationDoneSent) {
			return;
		}
		if (!session.initializedSeen) {
			try {
				await this.#waitForNotification(session, "initialized", signal, timeoutMs);
			} catch {
				return;
			}
		}
		await session.channel.request("configurationDone", {}, { signal, timeoutMs });
		session.configurationDoneSent = true;
		if (session.status === "configuring") {
			session.status = "running";
		}
	}

	async #ensureConfigurationDone(
		session: DebugSessionState,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<void> {
		if (!session.needsConfigurationDone || session.configurationDoneSent) {
			return;
		}
		await session.channel.request("configurationDone", {}, { signal, timeoutMs });
		session.configurationDoneSent = true;
		if (session.status === "configuring") {
			session.status = "running";
		}
	}

	async #request<TBody>(
		session: DebugSessionState,
		command: string,
		args: unknown,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<TBody> {
		await this.#ensureConfigurationDone(session, signal, timeoutMs);
		const body = await session.channel.request<TBody>(command, args, { signal, timeoutMs });
		session.lastUsedAt = Date.now();
		return body;
	}

	#applyTopFrame(session: DebugSessionState, frame: DapStackFrame | undefined): void {
		if (!frame) return;
		session.stop.frameId = frame.id;
		session.stop.frameName = frame.name;
		session.stop.instructionPointerReference = frame.instructionPointerReference;
		session.stop.source = frame.source;
		session.stop.line = frame.line;
		session.stop.column = frame.column;
	}

	async #fetchTopFrame(session: DebugSessionState, signal?: AbortSignal, timeoutMs: number = 5_000): Promise<void> {
		if (session.stop.threadId === undefined) return;
		try {
			const response = await session.channel.request<DapStackTraceResponse>(
				"stackTrace",
				{ threadId: session.stop.threadId, levels: 1 } satisfies DapStackTraceArguments,
				{ signal, timeoutMs },
			);
			session.lastStackFrames = response?.stackFrames ?? [];
			this.#applyTopFrame(session, session.lastStackFrames[0]);
		} catch {}
	}

	#prepareStopOutcome(session: DebugSessionState, signal?: AbortSignal, timeoutMs: number = 30_000): Promise<unknown> {
		const promises = [
			this.#waitForNotification(session, "stopped", signal, timeoutMs),
			this.#waitForNotification(session, "terminated", signal, timeoutMs),
			this.#waitForNotification(session, "exited", signal, timeoutMs),
		];
		for (const promise of promises) {
			promise.catch(() => undefined);
		}
		return Promise.race(promises);
	}

	async #awaitStopOutcome(
		session: DebugSessionState,
		outcomePromise: Promise<unknown>,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapContinueOutcome> {
		try {
			await outcomePromise;
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
			}
			if (session.status === "stopped") {
				await this.#fetchTopFrame(session, signal, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS));
			}
			const state =
				session.status === "stopped" ? "stopped" : session.status === "terminated" ? "terminated" : "running";
			return { snapshot: buildSummary(session), state, timedOut: false };
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
			return { snapshot: buildSummary(session), state: "running", timedOut: session.status === "running" };
		}
	}

	async #resolveThreadId(
		session: DebugSessionState,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<number> {
		if (session.stop.threadId !== undefined) {
			return session.stop.threadId;
		}
		if (session.threads.length > 0) {
			return session.threads[0].id;
		}
		const response = await session.channel.request<DapThreadsResponse>("threads", undefined, { signal, timeoutMs });
		session.threads = response?.threads ?? [];
		const threadId = session.threads[0]?.id;
		if (threadId === undefined) {
			throw new ToolError("Debugger reported no threads.");
		}
		return threadId;
	}

	async #step(
		command: "stepIn" | "stepOut" | "next",
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapContinueOutcome> {
		const session = this.#getActiveSessionOrThrow();
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		session.stop = {};
		session.lastStackFrames = [];
		session.status = "running";
		const outcomePromise = this.#prepareStopOutcome(session, signal, timeoutMs);
		await this.#request(session, command, { threadId }, signal, timeoutMs);
		return await this.#awaitStopOutcome(session, outcomePromise, signal, timeoutMs);
	}

	async #ensureLaunchSlot(): Promise<void> {
		const session = this.#activeSession;
		if (!session) return;
		if (session.status === "terminated") {
			await this.#disposeActiveSession(true);
			return;
		}
		throw new ToolError(`Debug session ${session.id} is still active. Terminate it before launching another.`);
	}

	#registerSession(
		handleName: string,
		channel: JsonRpcChannel,
		adapter: DapResolvedAdapter,
		cwd: string,
		program?: string,
	): DebugSessionState {
		const now = Date.now();
		const session: DebugSessionState = {
			id: `debug-${++this.#nextId}`,
			handleName,
			adapter,
			cwd,
			program,
			channel,
			unsubscribeNotifications: () => undefined,
			unsubscribeReverseRequests: () => undefined,
			unsubscribeLiveness: () => undefined,
			status: "launching",
			launchedAt: now,
			lastUsedAt: now,
			breakpoints: new Map(),
			functionBreakpoints: [],
			instructionBreakpoints: [],
			dataBreakpoints: [],
			output: "",
			outputBytes: 0,
			outputTruncated: false,
			stop: {},
			threads: [],
			lastStackFrames: [],
			initializedSeen: false,
			needsConfigurationDone: false,
			configurationDoneSent: false,
			notificationWaiters: new Set(),
		};
		session.unsubscribeNotifications = channel.onNotification((method, params) => {
			this.#handleNotification(session, method, params);
		});
		const unsubscribeRunInTerminal = channel.setReverseRequestHandler("runInTerminal", async args => {
			return await this.#handleRunInTerminalReverseRequest(session, args);
		});
		const unsubscribeStartDebugging = channel.setReverseRequestHandler("startDebugging", async args => {
			return await this.#handleStartDebuggingReverseRequest(session, args);
		});
		session.unsubscribeReverseRequests = () => {
			unsubscribeRunInTerminal();
			unsubscribeStartDebugging();
		};
		session.unsubscribeLiveness = this.#watchAdapterLiveness(session);
		this.#activeSession = session;
		return session;
	}

	async #openDebugSession(
		adapter: DapResolvedAdapter,
		cwd: string,
		program: string | undefined,
		command: "launch" | "attach",
		requestArgs: DapLaunchArguments | DapAttachArguments,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapSessionSummary> {
		throwIfReverseRequestsAreRequired(requestArgs);
		await this.#ensureLaunchSlot();
		const backend = this.session.backend;
		const handleName = this.#getHandleName();
		await this.#deleteStaleHandle(handleName);
		await this.#putHandle(
			handleName,
			{
				kind: "dap",
				command: adapter.resolvedCommand,
				args: adapter.args,
				transport: adapter.connectMode === "socket" ? "tcp" : "stdio",
			},
			signal,
		);
		const channel = await backend.dap.openChannel(handleName, { signal });
		const session = this.#registerSession(handleName, channel, adapter, cwd, program);
		try {
			session.capabilities = await channel.request<DapCapabilities>(
				"initialize",
				buildInitializeArguments(adapter),
				{ signal, timeoutMs },
			);
			session.needsConfigurationDone = session.capabilities.supportsConfigurationDoneRequest === true;
			const initialStopPromise = this.#prepareStopOutcome(
				session,
				signal,
				Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
			);
			const requestPromise = channel.request(command, requestArgs, { signal, timeoutMs });
			requestPromise.catch(() => undefined);
			await this.#completeConfigurationHandshake(session, signal, timeoutMs);
			await requestPromise;
			try {
				await initialStopPromise;
				if (session.status === "stopped") {
					await this.#fetchTopFrame(session, signal, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS));
				}
			} catch {
				if (session.initializedSeen && session.status === "launching") {
					session.status = session.configurationDoneSent ? "running" : "configuring";
				}
			}
			return buildSummary(session);
		} catch (error) {
			await this.#disposeSession(session, true);
			throw wrapReverseRequestError(error);
		}
	}

	async execute(
		_toolCallId: string,
		params: DebugParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DebugToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<DebugToolDetails>> {
		assertDebugAvailable(this.session);
		const timeoutSec = clampTimeout("debug", params.timeout);
		const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const timeoutMs = timeoutSec * 1000;
		const details: DebugToolDetails = { action: params.action, success: true };
		const result = toolResult(details);
		switch (params.action) {
			case "launch": {
				if (!params.program) {
					throw new ToolError("program is required for launch");
				}
				const commandCwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
				const program = resolveToCwd(params.program, commandCwd);
				const adapter = selectLaunchAdapter(program, commandCwd, params.adapter);
				if (!adapter) {
					throw new ToolError(
						`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`,
					);
				}
				const snapshot = await this.#openDebugSession(
					adapter,
					commandCwd,
					program,
					"launch",
					{
						...adapter.launchDefaults,
						program,
						cwd: commandCwd,
						args: params.args,
					} satisfies DapLaunchArguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = snapshot;
				details.adapter = adapter.name;
				return result.text(formatSessionSnapshot(snapshot).join("\n")).done();
			}
			case "attach": {
				if (params.pid === undefined && params.port === undefined) {
					throw new ToolError("attach requires pid or port");
				}
				const commandCwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
				const adapter = selectAttachAdapter(commandCwd, params.adapter, params.port);
				if (!adapter) {
					throw new ToolError(
						`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`,
					);
				}
				const snapshot = await this.#openDebugSession(
					adapter,
					commandCwd,
					undefined,
					"attach",
					{
						...adapter.attachDefaults,
						cwd: commandCwd,
						...(params.pid !== undefined ? { pid: params.pid, processId: params.pid } : {}),
						...(params.port !== undefined ? { port: params.port } : {}),
						...(params.host ? { host: params.host } : {}),
					} satisfies DapAttachArguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = snapshot;
				details.adapter = adapter.name;
				return result.text(formatSessionSnapshot(snapshot).join("\n")).done();
			}
			case "set_breakpoint": {
				const session = this.#getActiveSessionOrThrow();
				if (params.function) {
					const current = session.functionBreakpoints.filter(entry => entry.name !== params.function);
					current.push({ verified: false, name: params.function, condition: params.condition });
					current.sort((left, right) => left.name.localeCompare(right.name));
					const response = await this.#request<{ breakpoints?: DapBreakpoint[] }>(
						session,
						"setFunctionBreakpoints",
						{
							breakpoints: current.map<DapFunctionBreakpoint>(entry => ({
								name: entry.name,
								...(entry.condition ? { condition: entry.condition } : {}),
							})),
						},
						combinedSignal,
						timeoutMs,
					);
					session.functionBreakpoints = mapFunctionBreakpoints(current, response?.breakpoints);
					details.snapshot = buildSummary(session);
					details.functionBreakpoints = session.functionBreakpoints;
					return result.text(formatFunctionBreakpoints(session.functionBreakpoints)).done();
				}
				if (!params.file || params.line === undefined) {
					throw new ToolError("set_breakpoint requires file+line or function");
				}
				const file = resolveToCwd(params.file, this.session.cwd);
				const current = [...(session.breakpoints.get(file) ?? [])].filter(entry => entry.line !== params.line);
				current.push({ verified: false, line: params.line, condition: params.condition });
				current.sort((left, right) => left.line - right.line);
				const response = await this.#request<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setBreakpoints",
					{
						source: { path: file, name: path.basename(file) },
						breakpoints: current.map<DapSourceBreakpoint>(entry => ({
							line: entry.line,
							...(entry.condition ? { condition: entry.condition } : {}),
						})),
					},
					combinedSignal,
					timeoutMs,
				);
				session.breakpoints.set(file, mapSourceBreakpoints(current, response?.breakpoints));
				details.snapshot = buildSummary(session);
				details.breakpoints = session.breakpoints.get(file) ?? [];
				return result.text(formatBreakpoints(file, details.breakpoints)).done();
			}
			case "remove_breakpoint": {
				const session = this.#getActiveSessionOrThrow();
				if (params.function) {
					const current = session.functionBreakpoints.filter(entry => entry.name !== params.function);
					const response = await this.#request<{ breakpoints?: DapBreakpoint[] }>(
						session,
						"setFunctionBreakpoints",
						{
							breakpoints: current.map<DapFunctionBreakpoint>(entry => ({
								name: entry.name,
								...(entry.condition ? { condition: entry.condition } : {}),
							})),
						},
						combinedSignal,
						timeoutMs,
					);
					session.functionBreakpoints = mapFunctionBreakpoints(current, response?.breakpoints);
					details.snapshot = buildSummary(session);
					details.functionBreakpoints = session.functionBreakpoints;
					return result.text(formatFunctionBreakpoints(session.functionBreakpoints)).done();
				}
				if (!params.file || params.line === undefined) {
					throw new ToolError("remove_breakpoint requires file+line or function");
				}
				const file = resolveToCwd(params.file, this.session.cwd);
				const current = [...(session.breakpoints.get(file) ?? [])].filter(entry => entry.line !== params.line);
				const response = await this.#request<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setBreakpoints",
					{
						source: { path: file, name: path.basename(file) },
						breakpoints: current.map<DapSourceBreakpoint>(entry => ({
							line: entry.line,
							...(entry.condition ? { condition: entry.condition } : {}),
						})),
					},
					combinedSignal,
					timeoutMs,
				);
				if (current.length === 0) {
					session.breakpoints.delete(file);
				} else {
					session.breakpoints.set(file, mapSourceBreakpoints(current, response?.breakpoints));
				}
				details.snapshot = buildSummary(session);
				details.breakpoints = session.breakpoints.get(file) ?? [];
				return result.text(formatBreakpoints(file, details.breakpoints)).done();
			}
			case "set_instruction_breakpoint": {
				const session = this.#requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
				if (!params.instruction_reference) {
					throw new ToolError("instruction_reference is required for set_instruction_breakpoint");
				}
				const current = session.instructionBreakpoints.filter(
					entry => entry.instructionReference !== params.instruction_reference || entry.offset !== params.offset,
				);
				current.push({
					verified: false,
					instructionReference: params.instruction_reference,
					offset: params.offset,
					condition: params.condition,
					hitCondition: params.hit_condition,
				});
				current.sort((left, right) => {
					const referenceOrder = left.instructionReference.localeCompare(right.instructionReference);
					return referenceOrder !== 0 ? referenceOrder : (left.offset ?? 0) - (right.offset ?? 0);
				});
				const response = await this.#request<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setInstructionBreakpoints",
					{
						breakpoints: current.map(entry => ({
							instructionReference: entry.instructionReference,
							...(entry.offset !== undefined ? { offset: entry.offset } : {}),
							...(entry.condition ? { condition: entry.condition } : {}),
							...(entry.hitCondition ? { hitCondition: entry.hitCondition } : {}),
						})),
					} satisfies DapSetInstructionBreakpointsArguments,
					combinedSignal,
					timeoutMs,
				);
				session.instructionBreakpoints = mapInstructionBreakpoints(current, response?.breakpoints);
				details.snapshot = buildSummary(session);
				details.instructionBreakpoints = session.instructionBreakpoints;
				return result.text(formatInstructionBreakpoints(session.instructionBreakpoints)).done();
			}
			case "remove_instruction_breakpoint": {
				const session = this.#requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
				if (!params.instruction_reference) {
					throw new ToolError("instruction_reference is required for remove_instruction_breakpoint");
				}
				const current = session.instructionBreakpoints.filter(entry => {
					if (entry.instructionReference !== params.instruction_reference) {
						return true;
					}
					if (params.offset === undefined) {
						return false;
					}
					return entry.offset !== params.offset;
				});
				const response = await this.#request<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setInstructionBreakpoints",
					{
						breakpoints: current.map(entry => ({
							instructionReference: entry.instructionReference,
							...(entry.offset !== undefined ? { offset: entry.offset } : {}),
							...(entry.condition ? { condition: entry.condition } : {}),
							...(entry.hitCondition ? { hitCondition: entry.hitCondition } : {}),
						})),
					} satisfies DapSetInstructionBreakpointsArguments,
					combinedSignal,
					timeoutMs,
				);
				session.instructionBreakpoints = mapInstructionBreakpoints(current, response?.breakpoints);
				details.snapshot = buildSummary(session);
				details.instructionBreakpoints = session.instructionBreakpoints;
				return result.text(formatInstructionBreakpoints(session.instructionBreakpoints)).done();
			}
			case "data_breakpoint_info": {
				const session = this.#requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.name) {
					throw new ToolError("name is required for data_breakpoint_info");
				}
				const info = await this.#request<DapDataBreakpointInfoResponse>(
					session,
					"dataBreakpointInfo",
					{
						name: params.name,
						...((params.variable_ref ?? params.scope_id) !== undefined
							? { variablesReference: params.variable_ref ?? params.scope_id }
							: {}),
						...(params.frame_id !== undefined ? { frameId: params.frame_id } : {}),
					} satisfies DapDataBreakpointInfoArguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = buildSummary(session);
				details.dataBreakpointInfo = info;
				return result.text(formatDataBreakpointInfo(info)).done();
			}
			case "set_data_breakpoint": {
				const session = this.#requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.data_id) {
					throw new ToolError("data_id is required for set_data_breakpoint");
				}
				const current = session.dataBreakpoints.filter(entry => entry.dataId !== params.data_id);
				current.push({
					verified: false,
					dataId: params.data_id,
					accessType: params.access_type,
					condition: params.condition,
					hitCondition: params.hit_condition,
				});
				current.sort((left, right) => left.dataId.localeCompare(right.dataId));
				const response = await this.#request<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setDataBreakpoints",
					{
						breakpoints: current.map(entry => ({
							dataId: entry.dataId,
							...(entry.accessType ? { accessType: entry.accessType } : {}),
							...(entry.condition ? { condition: entry.condition } : {}),
							...(entry.hitCondition ? { hitCondition: entry.hitCondition } : {}),
						})),
					} satisfies DapSetDataBreakpointsArguments,
					combinedSignal,
					timeoutMs,
				);
				session.dataBreakpoints = mapDataBreakpoints(current, response?.breakpoints);
				details.snapshot = buildSummary(session);
				details.dataBreakpoints = session.dataBreakpoints;
				return result.text(formatDataBreakpoints(session.dataBreakpoints)).done();
			}
			case "remove_data_breakpoint": {
				const session = this.#requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.data_id) {
					throw new ToolError("data_id is required for remove_data_breakpoint");
				}
				const current = session.dataBreakpoints.filter(entry => entry.dataId !== params.data_id);
				const response = await this.#request<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setDataBreakpoints",
					{
						breakpoints: current.map(entry => ({
							dataId: entry.dataId,
							...(entry.accessType ? { accessType: entry.accessType } : {}),
							...(entry.condition ? { condition: entry.condition } : {}),
							...(entry.hitCondition ? { hitCondition: entry.hitCondition } : {}),
						})),
					} satisfies DapSetDataBreakpointsArguments,
					combinedSignal,
					timeoutMs,
				);
				session.dataBreakpoints = mapDataBreakpoints(current, response?.breakpoints);
				details.snapshot = buildSummary(session);
				details.dataBreakpoints = session.dataBreakpoints;
				return result.text(formatDataBreakpoints(session.dataBreakpoints)).done();
			}
			case "continue": {
				const session = this.#getActiveSessionOrThrow();
				const threadId = await this.#resolveThreadId(session, combinedSignal, timeoutMs);
				session.stop = {};
				session.lastStackFrames = [];
				session.status = "running";
				const outcomePromise = this.#prepareStopOutcome(session, combinedSignal, timeoutMs);
				await this.#request<DapContinueResponse>(
					session,
					"continue",
					{ threadId } satisfies DapContinueArguments,
					combinedSignal,
					timeoutMs,
				);
				const outcome = await this.#awaitStopOutcome(session, outcomePromise, combinedSignal, timeoutMs);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Continue")).done();
			}
			case "step_over": {
				const outcome = await this.#step("next", combinedSignal, timeoutMs);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step over")).done();
			}
			case "step_in": {
				const outcome = await this.#step("stepIn", combinedSignal, timeoutMs);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step in")).done();
			}
			case "step_out": {
				const outcome = await this.#step("stepOut", combinedSignal, timeoutMs);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step out")).done();
			}
			case "pause": {
				const session = this.#getActiveSessionOrThrow();
				if (session.status === "stopped") {
					const snapshot = buildSummary(session);
					details.snapshot = snapshot;
					return result.text(formatSessionSnapshot(snapshot).concat("Program paused.").join("\n")).done();
				}
				const threadId = await this.#resolveThreadId(session, combinedSignal, timeoutMs);
				const stopPromise = this.#waitForNotification(session, "stopped", combinedSignal, timeoutMs)
					.then(() => true)
					.catch(() => false);
				await this.#request(session, "pause", { threadId } satisfies DapPauseArguments, combinedSignal, timeoutMs);
				if (await stopPromise) {
					await this.#fetchTopFrame(session, combinedSignal, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS));
				}
				const snapshot = buildSummary(session);
				details.snapshot = snapshot;
				return result.text(formatSessionSnapshot(snapshot).concat("Program paused.").join("\n")).done();
			}
			case "evaluate": {
				const session = this.#getActiveSessionOrThrow();
				if (!params.expression) {
					throw new ToolError("expression is required for evaluate");
				}
				const evaluation = await this.#request<DapEvaluateResponse>(
					session,
					"evaluate",
					{
						expression: params.expression,
						context: (params.context as DapEvaluateArguments["context"] | undefined) ?? "repl",
						...((params.frame_id ?? session.stop.frameId) !== undefined
							? { frameId: params.frame_id ?? session.stop.frameId }
							: {}),
					} satisfies DapEvaluateArguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = buildSummary(session);
				details.evaluation = evaluation;
				return result.text(formatEvaluation(evaluation)).done();
			}
			case "stack_trace": {
				const session = this.#getActiveSessionOrThrow();
				const threadId = await this.#resolveThreadId(session, combinedSignal, timeoutMs);
				const response = await this.#request<DapStackTraceResponse>(
					session,
					"stackTrace",
					{
						threadId,
						...(params.levels !== undefined ? { levels: params.levels } : {}),
					} satisfies DapStackTraceArguments,
					combinedSignal,
					timeoutMs,
				);
				session.lastStackFrames = response?.stackFrames ?? [];
				this.#applyTopFrame(session, session.lastStackFrames[0]);
				details.snapshot = buildSummary(session);
				details.stackFrames = session.lastStackFrames;
				return result.text(formatStackFrames(session.lastStackFrames)).done();
			}
			case "threads": {
				const session = this.#getActiveSessionOrThrow();
				const response = await this.#request<DapThreadsResponse>(
					session,
					"threads",
					undefined,
					combinedSignal,
					timeoutMs,
				);
				session.threads = response?.threads ?? [];
				details.snapshot = buildSummary(session);
				details.threads = session.threads;
				return result.text(formatThreads(session.threads)).done();
			}
			case "scopes": {
				const session = this.#getActiveSessionOrThrow();
				const frameId = params.frame_id ?? session.stop.frameId;
				if (frameId === undefined) {
					throw new ToolError("No active stack frame. Run stack_trace first or supply frame_id.");
				}
				const response = await this.#request<DapScopesResponse>(
					session,
					"scopes",
					{ frameId } satisfies DapScopesArguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = buildSummary(session);
				details.scopes = response?.scopes ?? [];
				return result.text(formatScopes(details.scopes)).done();
			}
			case "variables": {
				const session = this.#getActiveSessionOrThrow();
				const variableReference = params.variable_ref ?? params.scope_id;
				if (variableReference === undefined) {
					throw new ToolError("variables requires variable_ref or scope_id");
				}
				const response = await this.#request<DapVariablesResponse>(
					session,
					"variables",
					{ variablesReference: variableReference } satisfies DapVariablesArguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = buildSummary(session);
				details.variables = response?.variables ?? [];
				return result.text(formatVariables(details.variables)).done();
			}
			case "disassemble": {
				const session = this.#requireCapability("supportsDisassembleRequest", "disassembly");
				if (params.instruction_count === undefined) {
					throw new ToolError("instruction_count is required for disassemble");
				}
				const response = await this.#request<DapDisassembleResponse>(
					session,
					"disassemble",
					{
						memoryReference: this.#resolveDisassemblyReference(params.memory_reference),
						instructionCount: params.instruction_count,
						...(params.offset !== undefined ? { offset: params.offset } : {}),
						...(params.instruction_offset !== undefined ? { instructionOffset: params.instruction_offset } : {}),
						...(params.resolve_symbols !== undefined ? { resolveSymbols: params.resolve_symbols } : {}),
					} satisfies DapDisassembleArguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = buildSummary(session);
				details.disassembly = response?.instructions ?? [];
				return result.text(formatDisassembly(details.disassembly)).done();
			}
			case "read_memory": {
				const session = this.#requireCapability("supportsReadMemoryRequest", "memory reads");
				if (!params.memory_reference) {
					throw new ToolError("memory_reference is required for read_memory");
				}
				if (params.count === undefined) {
					throw new ToolError("count is required for read_memory");
				}
				const response = await this.#request<DapReadMemoryResponse>(
					session,
					"readMemory",
					{
						memoryReference: params.memory_reference,
						count: params.count,
						...(params.offset !== undefined ? { offset: params.offset } : {}),
					} satisfies DapReadMemoryArguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = buildSummary(session);
				details.memoryAddress = response?.address ?? params.memory_reference;
				details.memoryData = response?.data;
				details.unreadableBytes = response?.unreadableBytes;
				return result
					.text(formatMemoryRead(details.memoryAddress, details.memoryData, details.unreadableBytes))
					.done();
			}
			case "write_memory": {
				const session = this.#requireCapability("supportsWriteMemoryRequest", "memory writes");
				if (!params.memory_reference) {
					throw new ToolError("memory_reference is required for write_memory");
				}
				if (!params.data) {
					throw new ToolError("data is required for write_memory");
				}
				const response = await this.#request<DapWriteMemoryResponse>(
					session,
					"writeMemory",
					{
						memoryReference: params.memory_reference,
						data: params.data,
						...(params.offset !== undefined ? { offset: params.offset } : {}),
						...(params.allow_partial !== undefined ? { allowPartial: params.allow_partial } : {}),
					} satisfies DapWriteMemoryArguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = buildSummary(session);
				details.bytesWritten = response?.bytesWritten;
				return result
					.text(
						[
							"Memory write completed.",
							...(response?.bytesWritten !== undefined ? [`Bytes written: ${response.bytesWritten}`] : []),
							...(response?.offset !== undefined ? [`Offset: ${response.offset}`] : []),
						].join("\n"),
					)
					.done();
			}
			case "modules": {
				const session = this.#requireCapability("supportsModulesRequest", "module introspection");
				const response = await this.#request<DapModulesResponse>(
					session,
					"modules",
					{
						...(params.start_module !== undefined ? { startModule: params.start_module } : {}),
						...(params.module_count !== undefined ? { moduleCount: params.module_count } : {}),
					} satisfies DapModulesArguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = buildSummary(session);
				details.modules = response?.modules ?? [];
				return result.text(formatModules(details.modules)).done();
			}
			case "loaded_sources": {
				const session = this.#requireCapability("supportsLoadedSourcesRequest", "loaded sources");
				const response = await this.#request<DapLoadedSourcesResponse>(
					session,
					"loadedSources",
					{},
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = buildSummary(session);
				details.sources = response?.sources ?? [];
				return result.text(formatLoadedSources(details.sources)).done();
			}
			case "custom_request": {
				const session = this.#getActiveSessionOrThrow();
				if (!params.command) {
					throw new ToolError("command is required for custom_request");
				}
				const body = await this.#request<unknown>(
					session,
					params.command,
					params.arguments,
					combinedSignal,
					timeoutMs,
				);
				details.snapshot = buildSummary(session);
				details.customBody = body;
				return result.text(formatCustomResponse(params.command, body)).done();
			}
			case "output": {
				const session = this.#getActiveSessionOrThrow();
				details.snapshot = buildSummary(session);
				details.output = session.output;
				return result.text(session.output.length > 0 ? session.output : "(no output captured)").done();
			}
			case "terminate": {
				const session = this.#activeSession;
				if (!session) {
					return result.text("No debug session to terminate.").done();
				}
				session.lastUsedAt = Date.now();
				if (session.status !== "terminated") {
					if (session.capabilities?.supportsTerminateRequest) {
						await session.channel
							.request("terminate", undefined, { signal: combinedSignal, timeoutMs })
							.catch(() => undefined);
					}
					await session.channel
						.request("disconnect", { terminateDebuggee: true }, { signal: combinedSignal, timeoutMs })
						.catch(() => undefined);
				}
				session.status = "terminated";
				const snapshot = buildSummary(session);
				details.snapshot = snapshot;
				await this.#disposeSession(session, true);
				return result.text(formatSessionSnapshot(snapshot).concat("Debug session terminated.").join("\n")).done();
			}
			case "sessions": {
				const sessions = this.#activeSession ? [buildSummary(this.#activeSession)] : [];
				details.sessions = sessions;
				return result.text(formatSessions(sessions)).done();
			}
			default:
				throw new ToolError(`Unsupported debug action: ${params.action}`);
		}
	}
}
