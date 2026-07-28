/**
 * Pipeline stage timings — "where did the turn's wall-clock time go".
 *
 * The runtime tap (sdk.ts) drives a {@link StageTimingsRecorder} from the main
 * agent loop: the provider-context transform brackets stage ① (context
 * assembly), assistant `message_start`/`message_end` bracket stage ② (provider
 * ttfb + stream), and `tool_execution_start`/`tool_execution_end` bracket
 * stage ④ (tool execution). At `turn_end` the recorder yields one compact
 * {@link StageTimingsRow} persisted as a `stage_timings` custom entry —
 * append-only JSONL, invisible to LLM context, read back by
 * `omp doctor --stages` and the stats pipeline.
 *
 * Measurement approximations (documented, not bugs):
 * - `ttfbMs` runs from transform completion to the assistant `message_start`
 *   event, so it includes payload hooks, HTTP connection setup, and provider
 *   queueing — an upper bound on true network ttfb (error bar: hook cost,
 *   usually <10ms).
 * - `streamMs` runs `message_start` → `message_end` of the same assistant
 *   message; a retried turn keeps the first start and last end, so retries
 *   inflate it (the `retries` counter flags those rows).
 * - `transformMs` includes the outbound-summary tap cost when
 *   `debug.outboundSummaries` is on (string-length math, sub-ms).
 * All clock points are `Date.now()` deltas; aborted or failed turns produce
 * partial rows (missing fields), never throw.
 */
import type { FileEntry } from "../session/session-entries";

/** `customType` of persisted per-turn stage timings. */
export const STAGE_TIMINGS_CUSTOM_TYPE = "stage_timings";
/** How many trailing rows readers keep (the file itself is append-only). */
export const STAGE_TIMINGS_RING_SIZE = 512;
/** How many slowest turns the doctor report lists. */
const SLOWEST_TURN_COUNT = 5;

/** Stage ① — provider-context transform (obfuscation, snapcompact, clamping). */
export interface StageContextTiming {
	/** Total transform wall-clock in this turn (all attempts summed), ms. */
	transformMs: number;
	/** System-prompt chars of the final transformed context, when captured. */
	promptChars?: number;
}

/** Stage ② — provider request. */
export interface StageProviderTiming {
	/** Transform completion → assistant `message_start`, ms. */
	ttfbMs?: number;
	/** Assistant `message_start` → `message_end`, ms. */
	streamMs?: number;
	/** Transform re-runs within the turn beyond the first (0 omitted). */
	retries?: number;
	/** The assistant message settled with an `error` stop reason. */
	error?: boolean;
}

/** Stage ④ — one tool execution. */
export interface StageToolTiming {
	name: string;
	ms: number;
	error?: boolean;
}

/** One persisted `stage_timings` row — one assistant turn. */
export interface StageTimingsRow {
	/** Epoch ms of the turn's first recorded clock point. */
	ts: number;
	/** First clock point → `turn_end`, ms. */
	turnMs: number;
	/**
	 * Bare model id of the assistant message that streamed this turn (the
	 * first `message_start` — retries within the turn keep the first
	 * attribution, matching `ttfbMs`). Absent on rows written before model
	 * capture existed or when the turn never reached `message_start`.
	 */
	model?: string;
	context?: StageContextTiming;
	provider?: StageProviderTiming;
	tools?: StageToolTiming[];
}

interface OpenTurnState {
	ts: number;
	transformStartTs?: number;
	transformMs?: number;
	transformEndTs?: number;
	transformCount: number;
	promptChars?: number;
	ttfbMs?: number;
	firstMessageStartTs?: number;
	lastMessageEndTs?: number;
	model?: string;
	pendingTools: Map<string, { name: string; startTs: number }>;
	tools: StageToolTiming[];
}

/**
 * Session-scoped accumulator for the in-flight turn. Pure state machine over
 * an injectable clock: callers feed it clock points and collect the finished
 * row at `turn_end`. Every method tolerates out-of-order or missing points
 * (aborted turns, tool-less turns) by producing partial rows.
 */
export class StageTimingsRecorder {
	readonly #now: () => number;
	#turn: OpenTurnState | undefined;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Discard any open turn (a fresh run supersedes an unflushed one). */
	reset(): void {
		this.#turn = undefined;
	}

	/** Provider-context transform starting; opens the turn on first call. */
	onTransformStart(): void {
		const now = this.#now();
		const turn = this.#turn ?? this.#open(now);
		turn.transformStartTs = now;
		turn.transformCount++;
	}

	/** Provider-context transform finished for one request attempt. */
	onTransformEnd(promptChars?: number): void {
		const turn = this.#turn;
		if (!turn) return;
		const now = this.#now();
		if (turn.transformStartTs !== undefined) {
			turn.transformMs = (turn.transformMs ?? 0) + Math.max(0, now - turn.transformStartTs);
			turn.transformStartTs = undefined;
		}
		turn.transformEndTs = now;
		if (promptChars !== undefined) turn.promptChars = promptChars;
	}

	/** Assistant message began streaming; `model` is the bare model id off the message. */
	onAssistantMessageStart(model?: string): void {
		const turn = this.#turn;
		if (!turn) return;
		const now = this.#now();
		if (turn.ttfbMs === undefined && turn.transformEndTs !== undefined) {
			turn.ttfbMs = Math.max(0, now - turn.transformEndTs);
		}
		if (turn.firstMessageStartTs === undefined) turn.firstMessageStartTs = now;
		if (turn.model === undefined && typeof model === "string" && model.length > 0) turn.model = model;
	}

	/** Assistant message settled (complete, aborted, or errored). */
	onAssistantMessageEnd(): void {
		const turn = this.#turn;
		if (!turn) return;
		turn.lastMessageEndTs = this.#now();
	}

	onToolExecutionStart(toolCallId: string, toolName: string): void {
		const turn = this.#turn ?? this.#open(this.#now());
		turn.pendingTools.set(toolCallId, { name: toolName, startTs: this.#now() });
	}

	onToolExecutionEnd(toolCallId: string, isError: boolean): void {
		const turn = this.#turn;
		if (!turn) return;
		const pending = turn.pendingTools.get(toolCallId);
		if (!pending) return;
		turn.pendingTools.delete(toolCallId);
		const timing: StageToolTiming = { name: pending.name, ms: Math.max(0, this.#now() - pending.startTs) };
		if (isError) timing.error = true;
		turn.tools.push(timing);
	}

	/**
	 * Close the turn and return its row, or undefined when nothing measurable
	 * happened (e.g. a synthetic stop turn with no provider request).
	 */
	onTurnEnd(providerError = false): StageTimingsRow | undefined {
		const turn = this.#turn;
		this.#turn = undefined;
		if (!turn) return undefined;
		const row: StageTimingsRow = { ts: turn.ts, turnMs: Math.max(0, this.#now() - turn.ts) };
		if (turn.model !== undefined) row.model = turn.model;
		if (turn.transformMs !== undefined) {
			row.context = { transformMs: turn.transformMs };
			if (turn.promptChars !== undefined) row.context.promptChars = turn.promptChars;
		}
		const provider: StageProviderTiming = {};
		if (turn.ttfbMs !== undefined) provider.ttfbMs = turn.ttfbMs;
		if (turn.firstMessageStartTs !== undefined && turn.lastMessageEndTs !== undefined) {
			provider.streamMs = Math.max(0, turn.lastMessageEndTs - turn.firstMessageStartTs);
		}
		if (turn.transformCount > 1) provider.retries = turn.transformCount - 1;
		if (providerError) provider.error = true;
		if (Object.keys(provider).length > 0) row.provider = provider;
		if (turn.tools.length > 0) row.tools = turn.tools;
		if (!row.context && !row.provider && !row.tools) return undefined;
		return row;
	}

	#open(now: number): OpenTurnState {
		const turn: OpenTurnState = { ts: now, transformCount: 0, pendingTools: new Map(), tools: [] };
		this.#turn = turn;
		return turn;
	}
}

/** Validate one persisted `stage_timings` payload; undefined when malformed. */
export function parseStageTimingsRow(data: unknown): StageTimingsRow | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return undefined;
	const row: StageTimingsRow = {
		ts: record.ts,
		turnMs: typeof record.turnMs === "number" && Number.isFinite(record.turnMs) ? record.turnMs : 0,
	};
	// Rows persisted before model capture (or turns that never streamed) have
	// no `model`; readers treat absence as unattributable.
	if (typeof record.model === "string" && record.model.length > 0) row.model = record.model;
	const context = record.context;
	if (context !== null && typeof context === "object") {
		const transformMs = (context as Record<string, unknown>).transformMs;
		if (typeof transformMs === "number" && Number.isFinite(transformMs)) {
			row.context = { transformMs };
			const promptChars = (context as Record<string, unknown>).promptChars;
			if (typeof promptChars === "number" && Number.isFinite(promptChars)) row.context.promptChars = promptChars;
		}
	}
	const providerRecord = record.provider;
	if (providerRecord !== null && typeof providerRecord === "object") {
		const raw = providerRecord as Record<string, unknown>;
		const provider: StageProviderTiming = {};
		if (typeof raw.ttfbMs === "number" && Number.isFinite(raw.ttfbMs)) provider.ttfbMs = raw.ttfbMs;
		if (typeof raw.streamMs === "number" && Number.isFinite(raw.streamMs)) provider.streamMs = raw.streamMs;
		if (typeof raw.retries === "number" && Number.isFinite(raw.retries)) provider.retries = raw.retries;
		if (raw.error === true) provider.error = true;
		if (Object.keys(provider).length > 0) row.provider = provider;
	}
	if (Array.isArray(record.tools)) {
		const tools: StageToolTiming[] = [];
		for (const rawTool of record.tools) {
			if (rawTool === null || typeof rawTool !== "object") continue;
			const tool = rawTool as Record<string, unknown>;
			if (typeof tool.name !== "string" || typeof tool.ms !== "number" || !Number.isFinite(tool.ms)) continue;
			const timing: StageToolTiming = { name: tool.name, ms: tool.ms };
			if (tool.error === true) timing.error = true;
			tools.push(timing);
		}
		if (tools.length > 0) row.tools = tools;
	}
	if (!row.context && !row.provider && !row.tools) return undefined;
	return row;
}

/**
 * Collect persisted stage-timing rows from session entries, keeping only the
 * trailing {@link STAGE_TIMINGS_RING_SIZE} (the JSONL is append-only, so the
 * cap is enforced on read).
 */
export function collectStageTimings(entries: readonly FileEntry[], cap = STAGE_TIMINGS_RING_SIZE): StageTimingsRow[] {
	const ring: StageTimingsRow[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STAGE_TIMINGS_CUSTOM_TYPE) continue;
		const row = parseStageTimingsRow(entry.data);
		if (row === undefined) continue;
		if (ring.length === cap) ring.shift();
		ring.push(row);
	}
	return ring;
}

/** Aggregate stats for one stage's duration samples. */
export interface StageStat {
	count: number;
	p50: number;
	p95: number;
	max: number;
	errors: number;
}

/** Per-stage aggregates over a set of rows. */
export interface StageTimingsSummary {
	turns: number;
	contextTransform: StageStat;
	providerTtfb: StageStat;
	providerStream: StageStat;
	toolExecution: StageStat;
}

/**
 * Nearest-rank percentile over an ascending-sorted sample array: the smallest
 * value with at least `p`% of samples at or below it. 0 for an empty array.
 */
export function stagePercentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.min(index, sorted.length - 1)];
}

function stageStat(values: number[], errors: number): StageStat {
	values.sort((a, b) => a - b);
	if (values.length === 0) return { count: 0, p50: 0, p95: 0, max: 0, errors };
	return {
		count: values.length,
		p50: stagePercentile(values, 50),
		p95: stagePercentile(values, 95),
		max: values[values.length - 1],
		errors,
	};
}

/**
 * Per-stage {count, p50, p95, max, errors} over collected rows. Error
 * semantics: `providerStream.errors` counts turns whose assistant message
 * errored on the provider side; `toolExecution.errors` counts failed tool
 * calls; the context transform has no error signal (a throw fails the turn).
 */
export function summarizeStageTimings(rows: readonly StageTimingsRow[]): StageTimingsSummary {
	const context: number[] = [];
	const ttfb: number[] = [];
	const stream: number[] = [];
	const tools: number[] = [];
	let providerErrors = 0;
	let toolErrors = 0;
	for (const row of rows) {
		if (row.context) context.push(row.context.transformMs);
		if (row.provider?.ttfbMs !== undefined) ttfb.push(row.provider.ttfbMs);
		if (row.provider?.streamMs !== undefined) stream.push(row.provider.streamMs);
		if (row.provider?.error) providerErrors++;
		for (const tool of row.tools ?? []) {
			tools.push(tool.ms);
			if (tool.error) toolErrors++;
		}
	}
	return {
		turns: rows.length,
		contextTransform: stageStat(context, 0),
		providerTtfb: stageStat(ttfb, 0),
		providerStream: stageStat(stream, providerErrors),
		toolExecution: stageStat(tools, toolErrors),
	};
}

interface RankedTurn {
	row: StageTimingsRow;
	contextMs: number;
	providerMs: number;
	toolsMs: number;
	total: number;
	dominant: "context" | "provider" | "tools";
}

function rankTurn(row: StageTimingsRow): RankedTurn {
	const contextMs = row.context?.transformMs ?? 0;
	const providerMs = (row.provider?.ttfbMs ?? 0) + (row.provider?.streamMs ?? 0);
	let toolsMs = 0;
	for (const tool of row.tools ?? []) toolsMs += tool.ms;
	let dominant: RankedTurn["dominant"] = "provider";
	if (toolsMs > providerMs) dominant = "tools";
	if (contextMs > providerMs && contextMs > toolsMs) dominant = "context";
	return { row, contextMs, providerMs, toolsMs, total: contextMs + providerMs + toolsMs, dominant };
}

/**
 * `--stages` rendering: per-stage summary table plus the slowest turns with
 * their dominant stage. Zero rows collapses to a one-line hint.
 */
export function renderStagesReport(sessionId: string, rows: readonly StageTimingsRow[]): string {
	if (rows.length === 0) {
		return `session ${sessionId}: no stage timings recorded (session predates stage tracking or debug.stageTimings is off)\n`;
	}
	const summary = summarizeStageTimings(rows);
	const lines = [
		`stage timings for session ${sessionId} (last ${rows.length} turns, ring capped at ${STAGE_TIMINGS_RING_SIZE}; durations in ms)`,
		"  stage              count      p50      p95      max  errors",
	];
	const table: readonly (readonly [string, StageStat])[] = [
		["context.transform", summary.contextTransform],
		["provider.ttfb", summary.providerTtfb],
		["provider.stream", summary.providerStream],
		["tool.execution", summary.toolExecution],
	];
	for (const [name, stat] of table) {
		lines.push(
			`  ${name.padEnd(17)}${String(stat.count).padStart(7)}${String(stat.p50).padStart(9)}${String(stat.p95).padStart(9)}${String(stat.max).padStart(9)}${String(stat.errors).padStart(8)}`,
		);
	}
	const ranked = rows.map(rankTurn).sort((a, b) => b.total - a.total);
	const slowest = ranked.slice(0, SLOWEST_TURN_COUNT);
	lines.push("", "slowest turns:", "  time         total  dominant     context     ttfb   stream    tools");
	for (const turn of slowest) {
		const time = turn.row.ts > 0 ? new Date(turn.row.ts).toISOString().slice(11, 19) : "--:--:--";
		lines.push(
			`  ${time}${String(turn.total).padStart(10)}  ${turn.dominant.padEnd(8)}${String(turn.contextMs).padStart(12)}${String(turn.row.provider?.ttfbMs ?? 0).padStart(9)}${String(turn.row.provider?.streamMs ?? 0).padStart(9)}${String(turn.toolsMs).padStart(9)}`,
		);
	}
	return `${lines.join("\n")}\n`;
}
