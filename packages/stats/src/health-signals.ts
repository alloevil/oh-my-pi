/**
 * Behavioral degradation signals derived from session transcripts.
 *
 * Pure, deterministic helpers — no DB handle, no I/O, no model calls. The
 * parser folds a session's tool-call / tool-result events through these and
 * emits absolute per-session totals; `insertHealthSignals` (db.ts) upserts
 * them keyed on `(session_file, signal)`, so a full-file recompute stays
 * idempotent under the offset-based incremental sync.
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
	| "intent_total_calls";

/** One per-session health counter row. */
export interface HealthSignalStat {
	/** Session file path (the session identity used across stats tables). */
	sessionFile: string;
	/** Unix ms of the newest transcript event that contributed (0 when unknown). */
	timestamp: number;
	signal: HealthSignalName;
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

/**
 * Count repeat-read incidents over an ordered tool-call sequence.
 *
 * `readKeys[n]` is the dedup key of the n-th tool call when it was a `read`
 * (the raw `path` argument — inline selectors like `:50-200` ride in the
 * string, so the key already distinguishes path+selector), or `null` for any
 * other tool. An incident fires when a key's occurrence count inside the
 * trailing `windowSize`-call window climbs to exactly `threshold` —
 * transition-only, so a 4th read in the same window does not double count;
 * once eviction drops the key below threshold, a later burst counts again.
 */
export function countRepeatReads(
	readKeys: readonly (string | null)[],
	windowSize = REPEAT_READ_WINDOW,
	threshold = REPEAT_READ_THRESHOLD,
): number {
	if (windowSize < 1 || threshold < 1) return 0;
	const counts = new Map<string, number>();
	let incidents = 0;
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
		if (next === threshold) incidents++;
	}
	return incidents;
}
