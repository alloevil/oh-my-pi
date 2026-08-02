import type { FileEntry } from "../session/session-entries";
import { firstLine } from "./cluster";
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
	/**
	 * Commands that plausibly mutated user data *outside the repository*,
	 * clustered by first line. Lexical heuristic inventory for post-hoc audit,
	 * not a safety boundary: it classifies command text, not effects, so it can
	 * miss mutations and flag reads. Classes: osascript with mutation verbs,
	 * browser automation, rm/rmdir/mv on absolute/home paths, sqlite writes to
	 * absolute paths.
	 */
	mutations: { cluster: string; count: number }[];
	ending: {
		lastRole: string | undefined;
		/** Head of the last assistant text block, as the transcript's final word. */
		lastAssistantText: string | undefined;
		/** True when the transcript stops inside an unanswered assistant turn. */
		inFlight: boolean;
		todoCalls: number;
		/**
		 * Did verification *happen*? The harness cannot judge output correctness,
		 * but "was anything executed after the last repo mutation" is computable
		 * with zero NLP — an edit-then-declare-done ending leaves this false.
		 * Post-hoc reads only: an in-flight session naturally carries an
		 * unverified tail.
		 */
		verification: {
			/** Assistant-turn ordinal of the last edit/write; undefined = no repo mutations. */
			lastMutationTurn: number | undefined;
			/** Assistant-turn ordinal of the last bash/eval; undefined = nothing executed. */
			lastExecutionTurn: number | undefined;
			/** Last mutation strictly after last execution. */
			unverifiedTail: boolean;
			/**
			 * Files edited/written whose basename never appears in any LATER
			 * bash/eval command text (cap 5). Lexical containment heuristic: a
			 * test runner invoked without naming the file will false-positive
			 * here — report-only, the human judges.
			 */
			mutatedFilesNeverExercised: string[];
		};
	};
	asks: {
		count: number;
		questions: string[];
		/** Recorded execution durations (ms) of `ask` tool calls, longest first. */
		durationsMs: number[];
	};
}

/** Command prefixes repeated fewer times than this are omitted from the lineage. */
const LINEAGE_MIN_REPEATS = 2;
/** How many top clusters / prefixes the report carries. */
const TOP_LIMIT = 8;

/** osascript bodies containing these verbs plausibly change app state (word-boundary, case-insensitive). */
const OSA_MUTATION_VERBS = /\b(?:move|delete|save|make new|empty trash|set )/i;
/** rm/rmdir/mv whose first non-flag argument is absolute or home-relative — repo-relative targets are excluded. */
const FS_DESTRUCTION_ABS = /(?:^|[\s;&|(])(?:rm|rmdir|mv)\s+(?:--?[\w=,-]+\s+)*["']?[/~]/m;
/** sqlite3 pointed at an absolute/home database path. */
const SQLITE_ABS = /\bsqlite3\s+["']?[/~]/;
/** SQL verbs that write. */
const SQL_WRITE = /\b(?:insert|update|delete|drop)\b/i;

/**
 * Lexical heuristic: does this bash/eval command text plausibly mutate user
 * data outside the repository? Heuristic inventory for post-hoc audit, not a
 * safety boundary — text-level classification only, no execution semantics.
 */
function isOutOfRepoMutation(command: string): boolean {
	if (/\bosascript\b/.test(command) && OSA_MUTATION_VERBS.test(command)) return true;
	if (
		command.includes("ego-browser") ||
		command.includes("tab.click") ||
		command.includes("tab.fill") ||
		command.includes("dispatchMouseEvent")
	)
		return true;
	if (FS_DESTRUCTION_ABS.test(command)) return true;
	if (SQLITE_ABS.test(command) && SQL_WRITE.test(command)) return true;
	return false;
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
	const mutationClusters = new Map<string, number>();
	const questions: string[] = [];
	let todoCalls = 0;
	let askCalls = 0;
	let lastRole: string | undefined;
	let lastAssistantText: string | undefined;
	let inFlight = false;
	let assistantTurn = 0;
	let lastMutationTurn: number | undefined;
	let lastExecutionTurn: number | undefined;
	/** file path → turn of its last mutation; command texts checked later. */
	const mutatedAt = new Map<string, number>();
	const executions: { turn: number; text: string }[] = [];

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
		assistantTurn++;
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
				const commandText =
					(block.name === "bash" || block.name === "eval") && typeof args?.command === "string"
						? args.command
						: block.name === "eval" && typeof args?.code === "string"
							? args.code
							: undefined;
				if (commandText !== undefined) {
					const prefix = firstLine(commandText);
					lineage.set(prefix, (lineage.get(prefix) ?? 0) + 1);
					if (isOutOfRepoMutation(commandText))
						mutationClusters.set(prefix, (mutationClusters.get(prefix) ?? 0) + 1);
					lastExecutionTurn = assistantTurn;
					executions.push({ turn: assistantTurn, text: commandText });
				}
				const mutatedPath =
					block.name === "write" && typeof args?.path === "string"
						? args.path
						: block.name === "edit" && typeof args?.input === "string"
							? /\[([^\]#]+)#/.exec(args.input)?.[1]
							: undefined;
				// `write` to an internal URI (xd:// device dispatch, local:// notes)
				// is a tool invocation, not a repo mutation — found live on the
				// first real-session smoke and excluded since.
				if (mutatedPath !== undefined && !mutatedPath.includes("://")) {
					lastMutationTurn = assistantTurn;
					mutatedAt.set(mutatedPath, assistantTurn);
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

	// A file counts as exercised when any LATER execution's text contains its
	// basename — lexical containment, so an unnamed test-runner run will
	// false-positive the other way; the field is report-only.
	const neverExercised: string[] = [];
	for (const [file, mutTurn] of mutatedAt) {
		const base = file.split("/").pop() ?? file;
		const exercised = executions.some(ex => ex.turn >= mutTurn && ex.text.includes(base));
		if (!exercised) neverExercised.push(base);
		if (neverExercised.length >= 5) break;
	}

	return {
		errors: { total: errorTotal, distinctClusters: errorClusters.size, top: topOf(errorClusters) },
		commandLineage: topOf(lineage, LINEAGE_MIN_REPEATS).map(({ cluster, count }) => ({ prefix: cluster, count })),
		mutations: topOf(mutationClusters),
		ending: {
			lastRole,
			lastAssistantText: lastAssistantText?.slice(0, 120),
			inFlight,
			todoCalls,
			verification: {
				lastMutationTurn,
				lastExecutionTurn,
				unverifiedTail:
					lastMutationTurn !== undefined &&
					(lastExecutionTurn === undefined || lastMutationTurn > lastExecutionTurn),
				mutatedFilesNeverExercised: neverExercised,
			},
		},
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

	lines.push("out-of-repo mutations (heuristic inventory):");
	for (const { cluster, count } of autopsy.mutations) lines.push(`  ${String(count).padStart(3)}× ${cluster}`);
	if (autopsy.mutations.length === 0) lines.push("  (none detected)");
	lines.push("");

	const e = autopsy.ending;
	lines.push(
		`ending: last message from ${e.lastRole ?? "?"}${e.inFlight ? " — transcript stops inside an unanswered assistant turn" : ""}; todo calls: ${e.todoCalls}`,
	);
	if (e.lastAssistantText) lines.push(`  last assistant text: ${JSON.stringify(e.lastAssistantText)}`);
	const v = e.verification;
	if (v.lastMutationTurn === undefined) {
		lines.push("  verification: no repo mutations (edit/write) in this session");
	} else if (v.unverifiedTail) {
		lines.push(
			`  ⚠ verification: unverified tail — last mutation at turn ${v.lastMutationTurn}, ${v.lastExecutionTurn === undefined ? "nothing was ever executed" : `last execution at turn ${v.lastExecutionTurn}`}`,
		);
	} else {
		lines.push(
			`  verification: ✓ execution followed the last mutation (turn ${v.lastMutationTurn} → ${v.lastExecutionTurn})`,
		);
	}
	if (v.mutatedFilesNeverExercised.length > 0) {
		lines.push(`  edited but never exercised later: ${v.mutatedFilesNeverExercised.join(", ")}`);
	}
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
