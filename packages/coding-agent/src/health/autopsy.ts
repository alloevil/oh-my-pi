import type { FileEntry } from "../session/session-entries";
import { collectStageTimings } from "./stages";

/**
 * Deterministic behavioral autopsy of a session transcript.
 *
 * Incident grounding (session 019fac75, a Mail-organizing task): three
 * automation stacks tried in sequence with 19 errors across ~15 distinct
 * failure shapes, a transcript ending mid-operation, and the same login
 * question asked three ways with two ~14-minute waits — none of it visible to
 * any rule, all of it recovered by ad-hoc archaeology after the user reported
 * the session id.
 *
 * Every number here is computable; none of it tolerates a threshold (a
 * hundred repetitions of one command prefix may be flailing or legitimate
 * iteration). So this is a *report*, not a rule set: it computes every
 * behavioral axis every time — including the ones the current investigation
 * was not already staring at — and the human judges. Display-only by design;
 * nothing lands in the health ledger.
 */
export interface SessionAutopsy {
	/** Failed tool results clustered by (tool, first line). */
	errors: {
		total: number;
		distinctClusters: number;
		top: { cluster: string; count: number }[];
	};
	/** bash/eval commands clustered by first line — strategy-churn evidence. */
	commandLineage: { prefix: string; count: number }[];
	ending: {
		lastRole: string | undefined;
		/** Head of the last assistant text block, as the transcript's final word. */
		lastAssistantText: string | undefined;
		/** True when the transcript stops inside an unanswered assistant turn. */
		inFlight: boolean;
		todoCalls: number;
	};
	asks: {
		count: number;
		questions: string[];
		/** Recorded execution durations (ms) of `ask` tool calls, longest first. */
		durationsMs: number[];
	};
}

/** Cluster key length — enough to distinguish failure shapes, short enough to merge noise. */
const CLUSTER_HEAD_CHARS = 80;
/** Command prefixes repeated fewer times than this are omitted from the lineage. */
const LINEAGE_MIN_REPEATS = 2;
/** How many top clusters / prefixes the report carries. */
const TOP_LIMIT = 8;

function firstLine(text: string): string {
	const nl = text.indexOf("\n");
	const line = nl === -1 ? text : text.slice(0, nl);
	return line.length > CLUSTER_HEAD_CHARS ? line.slice(0, CLUSTER_HEAD_CHARS) : line;
}

function topOf(counts: Map<string, number>, min = 1): { cluster: string; count: number }[] {
	return [...counts.entries()]
		.filter(([, count]) => count >= min)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, TOP_LIMIT)
		.map(([cluster, count]) => ({ cluster, count }));
}

/** Compute the autopsy from persisted session entries. Pure; no I/O. */
export function buildAutopsy(entries: readonly FileEntry[]): SessionAutopsy {
	const errorClusters = new Map<string, number>();
	let errorTotal = 0;
	const lineage = new Map<string, number>();
	const questions: string[] = [];
	let todoCalls = 0;
	let askCalls = 0;
	let lastRole: string | undefined;
	let lastAssistantText: string | undefined;
	let inFlight = false;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		lastRole = message.role;
		if (message.role === "toolResult") {
			inFlight = true; // still inside the turn until a user/assistant message follows
			if (message.isError === true) {
				errorTotal++;
				const body = Array.isArray(message.content)
					? (message.content.find(block => block.type === "text") as { text?: string } | undefined)?.text
					: undefined;
				const key = `${message.toolName} | ${firstLine((body ?? "").trim() || "(empty)")}`;
				errorClusters.set(key, (errorClusters.get(key) ?? 0) + 1);
			}
			continue;
		}
		if (message.role === "user") {
			inFlight = false;
			continue;
		}
		if (message.role !== "assistant") continue;
		inFlight = false;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "text" && block.text.trim().length > 0) {
				lastAssistantText = block.text.trim();
			} else if (block.type === "toolCall") {
				inFlight = true;
				const args = block.arguments as Record<string, unknown> | undefined;
				if (block.name === "todo") todoCalls++;
				if (block.name === "ask") {
					askCalls++;
					const qs = args?.questions;
					const question = Array.isArray(qs) ? (qs[0] as { question?: string } | undefined)?.question : undefined;
					if (typeof question === "string") questions.push(firstLine(question));
				}
				if ((block.name === "bash" || block.name === "eval") && typeof args?.command === "string") {
					const prefix = firstLine(args.command);
					lineage.set(prefix, (lineage.get(prefix) ?? 0) + 1);
				} else if (block.name === "eval" && typeof args?.code === "string") {
					const prefix = firstLine(args.code);
					lineage.set(prefix, (lineage.get(prefix) ?? 0) + 1);
				}
			}
		}
	}

	const askDurations: number[] = [];
	for (const row of collectStageTimings(entries)) {
		for (const tool of row.tools ?? []) {
			if (tool.name === "ask") askDurations.push(tool.ms);
		}
	}
	askDurations.sort((a, b) => b - a);

	return {
		errors: { total: errorTotal, distinctClusters: errorClusters.size, top: topOf(errorClusters) },
		commandLineage: topOf(lineage, LINEAGE_MIN_REPEATS).map(({ cluster, count }) => ({ prefix: cluster, count })),
		ending: { lastRole, lastAssistantText: lastAssistantText?.slice(0, 120), inFlight, todoCalls },
		asks: { count: askCalls, questions, durationsMs: askDurations },
	};
}

/** Render the autopsy as the doctor CLI's `--autopsy` report. */
export function renderAutopsy(sessionId: string, autopsy: SessionAutopsy): string {
	const lines: string[] = [`behavioral autopsy for session ${sessionId}`, ""];

	lines.push(`errors: ${autopsy.errors.total} failed tool result(s) in ${autopsy.errors.distinctClusters} cluster(s)`);
	for (const { cluster, count } of autopsy.errors.top) lines.push(`  ${String(count).padStart(3)}× ${cluster}`);
	if (autopsy.errors.total === 0) lines.push("  (none)");
	lines.push("");

	lines.push("command lineage (repeated first-line prefixes):");
	for (const { prefix, count } of autopsy.commandLineage) lines.push(`  ${String(count).padStart(3)}× ${prefix}`);
	if (autopsy.commandLineage.length === 0) lines.push("  (no prefix repeated)");
	lines.push("");

	const e = autopsy.ending;
	lines.push(
		`ending: last message from ${e.lastRole ?? "?"}${e.inFlight ? " — transcript stops inside an unanswered assistant turn" : ""}; todo calls: ${e.todoCalls}`,
	);
	if (e.lastAssistantText) lines.push(`  last assistant text: ${JSON.stringify(e.lastAssistantText)}`);
	lines.push("");

	lines.push(`asks: ${autopsy.asks.count}`);
	for (let i = 0; i < autopsy.asks.questions.length; i++) {
		lines.push(`  - ${autopsy.asks.questions[i]}`);
	}
	if (autopsy.asks.durationsMs.length > 0) {
		lines.push(`  wait durations: ${autopsy.asks.durationsMs.map(ms => `${Math.round(ms / 1000)}s`).join(", ")}`);
	}
	return lines.join("\n");
}
