/**
 * First-line clustering key shared by every consumer that groups bash/eval
 * commands (or other free text) by shape: the autopsy command lineage, the
 * task-map prefix clusters, and the live command-churn guard. One definition
 * so a threshold calibrated on one instrument (the 2026-07-28 corpus sweep in
 * `scripts/harness-evolve/incidents.md`) transfers exactly to the others.
 */

/** Cluster key length — enough to distinguish command shapes, short enough to merge noise. */
export const CLUSTER_HEAD_CHARS = 80;

/** First line of `text`, truncated to {@link CLUSTER_HEAD_CHARS} — the canonical cluster key. */
export function firstLine(text: string): string {
	const nl = text.indexOf("\n");
	const line = nl === -1 ? text : text.slice(0, nl);
	return line.length > CLUSTER_HEAD_CHARS ? line.slice(0, CLUSTER_HEAD_CHARS) : line;
}
