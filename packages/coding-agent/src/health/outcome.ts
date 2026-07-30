/**
 * Ground-truth session outcome labels.
 *
 * Sessions record everything the harness did and nothing about whether it
 * worked. `omp label <outcome> [session]` persists that post-hoc human
 * knowledge as a `session_outcome` custom entry in the session JSONL, giving
 * every health detector a dependent variable to correlate against (see
 * incident #1 in `scripts/harness-evolve/incidents.md`: the "abandoned to
 * manual takeover" ground truth existed only as prose).
 *
 * Multiple label entries may exist — the file is append-only, and relabeling
 * is a correction, not history worth merging — so readers take the LAST
 * parseable label ({@link collectSessionOutcome}).
 */
import type { FileEntry } from "../session/session-entries";

/** `customType` of a persisted ground-truth session outcome label. */
export const SESSION_OUTCOME_CUSTOM_TYPE = "session_outcome";

/** The closed outcome vocabulary, in "how well did it go" order. */
export const SESSION_OUTCOMES = ["done", "partial", "manual-takeover", "abandoned"] as const;

/** Ground-truth verdict on whether the session's task was accomplished. */
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

const SESSION_OUTCOME_SET: Record<string, true> = Object.fromEntries(SESSION_OUTCOMES.map(outcome => [outcome, true]));

/** Whether a raw string is one of the {@link SESSION_OUTCOMES}. */
export function isSessionOutcome(value: string): value is SessionOutcome {
	return SESSION_OUTCOME_SET[value] === true;
}

/** One persisted `session_outcome` payload. */
export interface SessionOutcomeLabel {
	outcome: SessionOutcome;
	/** Free-form human context (e.g. "user organized mail by hand"). */
	note?: string;
	/** Unix epoch ms at which the label was recorded (not when the session ran). */
	at: number;
}

/** Validate one persisted `session_outcome` payload; undefined when malformed. */
export function parseSessionOutcome(data: unknown): SessionOutcomeLabel | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.outcome !== "string" || SESSION_OUTCOME_SET[record.outcome] !== true) return undefined;
	if (typeof record.at !== "number" || !Number.isFinite(record.at)) return undefined;
	const label: SessionOutcomeLabel = { outcome: record.outcome as SessionOutcome, at: record.at };
	if (typeof record.note === "string" && record.note.length > 0) label.note = record.note;
	return label;
}

/**
 * The session's effective outcome label: the last parseable `session_outcome`
 * entry (relabeling corrects earlier labels), or undefined when unlabeled.
 */
export function collectSessionOutcome(entries: readonly FileEntry[]): SessionOutcomeLabel | undefined {
	let last: SessionOutcomeLabel | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SESSION_OUTCOME_CUSTOM_TYPE) continue;
		const label = parseSessionOutcome(entry.data);
		if (label !== undefined) last = label;
	}
	return last;
}

/** `outcome: manual-takeover — <note>` — the one-line rendering doctor and evidence share. */
export function formatSessionOutcome(label: SessionOutcomeLabel): string {
	return label.note === undefined ? `outcome: ${label.outcome}` : `outcome: ${label.outcome} — ${label.note}`;
}
