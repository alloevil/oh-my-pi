/**
 * Behavioral degradation signals derived from session transcripts.
 *
 * Pure, deterministic helpers — no DB handle, no I/O, no model calls. The
 * parser folds a session's tool-call / tool-result events through these and
 * emits absolute per-session totals; `insertHealthSignals` (db.ts) upserts
 * them keyed on `(session_file, signal, model)`, so a full-file recompute
 * stays idempotent under the offset-based incremental sync.
 *
 * Signals ride the existing offline stats write path (session JSONL →
 * `syncAllSessions` → stats.db). The session process never opens a second
 * SQLite connection — when stats are never synced, nothing here runs.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

/** Signal names recorded in the `health_signals` table. */
export type HealthSignalName =
	| "tool_arg_validation_failures"
	| "edit_rejections"
	| "repeat_reads"
	| "intent_filled_calls"
	| "intent_total_calls"
	| "provider_error_turns"
	| "stage_context_transform_p95_ms"
	| "stage_provider_ttfb_p95_ms"
	| "stage_provider_stream_p95_ms"
	| "stage_tool_error_turns";

/** One per-session health counter row. */
export interface HealthSignalStat {
	/** Session file path (the session identity used across stats tables). */
	sessionFile: string;
	/** Unix ms of the newest transcript event that contributed (0 when unknown). */
	timestamp: number;
	signal: HealthSignalName;
	/** Bare model id the counter attributes to (e.g. "claude-fable-5"), "" when unattributable. */
	model: string;
	value: number;
}

/** Trailing tool-call window inspected for repeated reads. */
export const REPEAT_READ_WINDOW = 20;
/** Reads of the same key within the window that count as one incident. */
export const REPEAT_READ_THRESHOLD = 3;

/**
 * Error-text prefix `validateToolArguments` (pi-ai) puts on tool calls
 * rejected before execution. The header phrase is asserted by pi-ai's own
 * tests, so matching on it is contract-stable.
 */
export const VALIDATION_FAILURE_PREFIX = 'Validation failed for tool "';

/**
 * True when an assistant turn failed on the provider side: an explicit
 * `error` stop or a recorded errorMessage. User aborts (ESC) persist
 * `stopReason: "aborted"` plus an errorMessage like "Interrupted by user" —
 * deliberate action, not degradation, so they never count. Local twin of
 * `classifyProviderErrorTurn` in coding-agent's src/health/guards.ts,
 * duplicated to keep stats free of a cross-package runtime dependency.
 */
export function isProviderErrorTurn(turn: { stopReason?: string; errorMessage?: string | null }): boolean {
	if (turn.stopReason === "aborted") return false;
	return turn.stopReason === "error" || turn.errorMessage != null;
}

/** Whether a call's arguments carry a non-empty harness intent (`i`) field. */
export function hasNonEmptyIntent(args: unknown): boolean {
	if (!args || typeof args !== "object") return false;
	const intent = (args as Record<string, unknown>)[INTENT_FIELD];
	return typeof intent === "string" && intent.trim().length > 0;
}

/** Running intent-fill numerator/denominator over a session's tool calls. */
export interface IntentFill {
	/** Calls whose args carried a non-empty `i`. */
	filled: number;
	/** All tool calls seen. */
	total: number;
}

/** Fold a batch of tool-call argument objects into an intent-fill accumulator. */
export function accumulateIntentFill(acc: IntentFill, argsList: readonly unknown[]): IntentFill {
	let filled = acc.filled;
	for (const args of argsList) {
		if (hasNonEmptyIntent(args)) filled++;
	}
	return { filled, total: acc.total + argsList.length };
}

/** `customType` of the coding-agent's per-turn stage-timing entries. */
export const STAGE_TIMINGS_CUSTOM_TYPE = "stage_timings";

/**
 * Duration samples folded from a session's `stage_timings` custom entries.
 * Local twin of the row shape in coding-agent's src/health/stages.ts,
 * duplicated (like {@link isProviderErrorTurn}) to keep stats free of a
 * cross-package runtime dependency; every field is re-validated on read.
 */
export interface StageTimingSamples {
	/** Context-transform durations, one per turn that recorded stage ①. */
	transformMs: number[];
	/** Provider ttfb durations (transform end → assistant message_start). */
	ttfbMs: number[];
	/** Provider stream durations (message_start → message_end). */
	streamMs: number[];
	/** Turns with at least one failed tool call. */
	toolErrorTurns: number;
	/** Rows folded (0 = session predates stage tracking). */
	rows: number;
	/** Unix ms of the newest contributing row (0 when unknown). */
	timestamp: number;
}

/** Empty stage-timing sample accumulator (one per attributed model). */
export function createStageTimingSamples(): StageTimingSamples {
	return { transformMs: [], ttfbMs: [], streamMs: [], toolErrorTurns: 0, rows: 0, timestamp: 0 };
}

/**
 * Fold one `stage_timings` entry payload into the per-model accumulator map;
 * malformed payloads are ignored. Rows carry their own bare `model` id
 * (captured at assistant `message_start` by the runtime recorder); rows
 * persisted before model capture fold under "".
 */
export function accumulateStageTimings(byModel: Map<string, StageTimingSamples>, data: unknown): void {
	if (data === null || typeof data !== "object") return;
	const row = data as Record<string, unknown>;
	if (typeof row.ts !== "number" || !Number.isFinite(row.ts)) return;
	const model = typeof row.model === "string" ? row.model : "";
	let acc = byModel.get(model);
	if (!acc) {
		acc = createStageTimingSamples();
		byModel.set(model, acc);
	}
	acc.rows++;
	if (row.ts > acc.timestamp) acc.timestamp = row.ts;
	const context = row.context as Record<string, unknown> | undefined;
	if (context && typeof context === "object" && typeof context.transformMs === "number") {
		acc.transformMs.push(context.transformMs);
	}
	const provider = row.provider as Record<string, unknown> | undefined;
	if (provider && typeof provider === "object") {
		if (typeof provider.ttfbMs === "number") acc.ttfbMs.push(provider.ttfbMs);
		if (typeof provider.streamMs === "number") acc.streamMs.push(provider.streamMs);
	}
	if (Array.isArray(row.tools)) {
		for (const tool of row.tools) {
			if (tool !== null && typeof tool === "object" && (tool as Record<string, unknown>).error === true) {
				acc.toolErrorTurns++;
				break;
			}
		}
	}
}

/**
 * Nearest-rank percentile over duration samples, rounded to integer ms —
 * the smallest sample with at least `p`% of samples at or below it. 0 for
 * an empty sample set.
 */
export function nearestRankPercentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
	return Math.round(sorted[Math.min(index, sorted.length - 1)]);
}

/**
 * Count repeat-read incidents per attributed model over an ordered tool-call
 * sequence.
 *
 * `readKeys[n]` is the dedup key of the n-th tool call when it was a `read`
 * (the raw `path` argument — inline selectors like `:50-200` ride in the
 * string, so the key already distinguishes path+selector), or `null` for any
 * other tool. An incident fires when a key's occurrence count inside the
 * trailing `windowSize`-call window climbs to exactly `threshold` —
 * transition-only, so a 4th read in the same window does not double count;
 * once eviction drops the key below threshold, a later burst counts again.
 *
 * The sliding window spans the whole sequence regardless of model — a burst
 * is a burst even when models interleave. Each incident attributes to the
 * model that issued the threshold-crossing read (`modelOf(index)`, "" when
 * unattributable); the map only carries models with at least one incident.
 */
export function countRepeatReadsByModel(
	readKeys: readonly (string | null)[],
	modelOf: (index: number) => string,
	windowSize = REPEAT_READ_WINDOW,
	threshold = REPEAT_READ_THRESHOLD,
): Map<string, number> {
	const incidents = new Map<string, number>();
	if (windowSize < 1 || threshold < 1) return incidents;
	const counts = new Map<string, number>();
	for (let i = 0; i < readKeys.length; i++) {
		const evictIndex = i - windowSize;
		if (evictIndex >= 0) {
			const evicted = readKeys[evictIndex];
			if (evicted !== null) {
				const count = counts.get(evicted);
				if (count !== undefined) {
					if (count <= 1) counts.delete(evicted);
					else counts.set(evicted, count - 1);
				}
			}
		}
		const key = readKeys[i];
		if (key === null) continue;
		const next = (counts.get(key) ?? 0) + 1;
		counts.set(key, next);
		if (next === threshold) {
			const model = modelOf(i);
			incidents.set(model, (incidents.get(model) ?? 0) + 1);
		}
	}
	return incidents;
}

/** Total repeat-read incidents regardless of model — see {@link countRepeatReadsByModel}. */
export function countRepeatReads(
	readKeys: readonly (string | null)[],
	windowSize = REPEAT_READ_WINDOW,
	threshold = REPEAT_READ_THRESHOLD,
): number {
	let total = 0;
	for (const value of countRepeatReadsByModel(readKeys, () => "", windowSize, threshold).values()) total += value;
	return total;
}
