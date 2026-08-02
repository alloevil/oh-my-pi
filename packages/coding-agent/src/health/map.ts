import type { FileEntry } from "../session/session-entries";
import type { TodoPhase } from "../tools/todo";

/**
 * Task map: declared intent (todo phases) juxtaposed with derived trajectory
 * (what the agent actually did), plus the divergence between them.
 *
 * Incident grounding (session 019fac75): 120 near-identical browser
 * invocations accumulated in front of a watching user with no way to name the
 * pattern forming, while the declared plan — todo called twice in 457
 * messages — was stale from the first hour. A model-maintained map goes stale
 * exactly when it matters; a map derived from the transcript cannot. The
 * *divergence* between the two is the earliest deterministic sign of an agent
 * grinding off-plan, and it is computed nowhere else.
 *
 * Display-only by design: the divergence heuristics judge the staleness of
 * declarations, never the quality of behavior. Nothing lands in the health
 * ledger.
 */
export interface TaskMap {
	declared: {
		/** Phase name → done/total. Empty when no todos were ever declared. */
		phases: { name: string; done: number; total: number }[];
		/** The in-progress task's content, if any. */
		current: string | undefined;
		/** Assistant turns since the last todo tool call; undefined when never called. */
		turnsSinceTodo: number | undefined;
	};
	derived: {
		/** Assistant turns covered by the trailing window. */
		windowTurns: number;
		/** Tool-call counts by tool name within the window, descending. */
		tools: { name: string; count: number }[];
		/** Failed tool results within the window. */
		errors: number;
		/** Most-repeated bash/eval first-line prefix within the window. */
		dominantPrefix: { prefix: string; count: number } | undefined;
		/** Lifetime count of the window's dominant prefix — churn that outlives the window. */
		dominantPrefixLifetime: number;
		/** Same path+selector re-reads within the window (lost-in-the-middle proxy). */
		reReads: number;
		/** Byte-identical bash/eval re-runs within the window (same proxy). */
		identicalReruns: number;
	};
	/** Human-readable divergence findings; empty when declared and derived agree. */
	divergence: string[];
}

/** Trailing assistant-turn window the derived side describes. */
export const MAP_WINDOW_TURNS = 30;
/** Commands since the last todo update before the declared plan counts as stale. */
const STALE_TODO_COMMANDS = 15;
/** Assistant turns without any todo before "no declared plan" is worth saying. */
const NO_PLAN_TURNS = 20;
/** Cluster key length — matches the autopsy's first-line clustering. */
const PREFIX_HEAD_CHARS = 80;

function firstLine(text: string): string {
	const nl = text.indexOf("\n");
	const line = nl === -1 ? text : text.slice(0, nl);
	return line.length > PREFIX_HEAD_CHARS ? line.slice(0, PREFIX_HEAD_CHARS) : line;
}

interface TurnFacts {
	toolNames: string[];
	/** bash/eval first-line prefixes called this turn. */
	prefixes: string[];
	/** Full command texts (for identical-rerun detection). */
	commands: string[];
	/** read-tool path+selector keys. */
	readKeys: string[];
	calledTodo: boolean;
}

/** Compute the task map from session entries and the live todo phases. Pure; no I/O. */
export function buildTaskMap(entries: readonly FileEntry[], todoPhases: readonly TodoPhase[]): TaskMap {
	// ---- reduce entries to per-assistant-turn facts + error attribution ----
	const turns: TurnFacts[] = [];
	const callTurn = new Map<string, number>();
	const errorTurns: number[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const facts: TurnFacts = { toolNames: [], prefixes: [], commands: [], readKeys: [], calledTodo: false };
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				facts.toolNames.push(block.name);
				if (block.name === "todo") facts.calledTodo = true;
				const args = block.arguments as Record<string, unknown> | undefined;
				const command =
					typeof args?.command === "string"
						? args.command
						: typeof args?.code === "string"
							? args.code
							: undefined;
				if ((block.name === "bash" || block.name === "eval") && command !== undefined) {
					facts.prefixes.push(firstLine(command));
					facts.commands.push(command);
				}
				if (block.name === "read" && typeof args?.path === "string") {
					facts.readKeys.push(`${args.path}#${String(args.offset ?? "")}`);
				}
				callTurn.set(block.id, turns.length);
			}
			turns.push(facts);
		} else if (message.role === "toolResult" && message.isError === true) {
			const turn = callTurn.get(message.toolCallId);
			if (turn !== undefined) errorTurns.push(turn);
		}
	}

	// ---- declared ----------------------------------------------------------
	const phases = todoPhases
		.filter(phase => phase.tasks.length > 0)
		.map(phase => ({
			name: phase.name,
			done: phase.tasks.filter(task => task.status === "completed").length,
			total: phase.tasks.length,
		}));
	let current: string | undefined;
	for (const phase of todoPhases) {
		current ??= phase.tasks.find(task => task.status === "in_progress")?.content;
	}
	let lastTodoTurn = -1;
	for (let i = 0; i < turns.length; i++) if (turns[i].calledTodo) lastTodoTurn = i;
	const turnsSinceTodo = lastTodoTurn === -1 ? undefined : turns.length - 1 - lastTodoTurn;

	// ---- derived window ----------------------------------------------------
	const windowStart = Math.max(0, turns.length - MAP_WINDOW_TURNS);
	const window = turns.slice(windowStart);
	// Record<> would satisfy string keys, but these are unbounded runtime
	// aggregations needing .size-free iteration + sort — Map per the rulebook.
	const toolCounts = new Map<string, number>();
	const prefixCounts = new Map<string, number>();
	let reReads = 0;
	let identicalReruns = 0;
	const seenReads = new Set<string>();
	const seenCommands = new Set<string>();
	// Seed "seen" with pre-window history so window repetition means
	// "repeated something it already did", not "did two things in the window".
	for (const facts of turns.slice(0, windowStart)) {
		for (const key of facts.readKeys) seenReads.add(key);
		for (const command of facts.commands) seenCommands.add(command);
	}
	for (const facts of window) {
		for (const name of facts.toolNames) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
		for (const prefix of facts.prefixes) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
		for (const key of facts.readKeys) {
			if (seenReads.has(key)) reReads++;
			seenReads.add(key);
		}
		for (const command of facts.commands) {
			if (seenCommands.has(command)) identicalReruns++;
			seenCommands.add(command);
		}
	}
	const tools = [...toolCounts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([name, count]) => ({ name, count }));
	const dominantEntry = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
	const dominantPrefix = dominantEntry ? { prefix: dominantEntry[0], count: dominantEntry[1] } : undefined;
	let dominantPrefixLifetime = 0;
	if (dominantPrefix) {
		for (const facts of turns) {
			for (const prefix of facts.prefixes) if (prefix === dominantPrefix.prefix) dominantPrefixLifetime++;
		}
	}
	const errors = errorTurns.filter(turn => turn >= windowStart).length;

	// ---- divergence --------------------------------------------------------
	const divergence: string[] = [];
	const commandsSinceTodo =
		lastTodoTurn === -1 ? undefined : turns.slice(lastTodoTurn + 1).reduce((n, t) => n + t.commands.length, 0);
	if (phases.length > 0 && commandsSinceTodo !== undefined && commandsSinceTodo >= STALE_TODO_COMMANDS) {
		divergence.push(
			`declared plan may be stale: ${commandsSinceTodo} commands since the last todo update (${turnsSinceTodo} turns ago)`,
		);
	}
	if (phases.length === 0 && turns.length >= NO_PLAN_TURNS) {
		divergence.push(`no declared plan after ${turns.length} assistant turns — trajectory below is the only map`);
	}

	return {
		declared: { phases, current, turnsSinceTodo },
		derived: {
			windowTurns: window.length,
			tools,
			errors,
			dominantPrefix,
			dominantPrefixLifetime,
			reReads,
			identicalReruns,
		},
		divergence,
	};
}

/** Render the task map for `/map` output. */
export function renderTaskMap(map: TaskMap): string {
	const lines: string[] = ["task map — declared plan vs derived trajectory", ""];

	if (map.declared.phases.length === 0) {
		lines.push("declared: (no todos)");
	} else {
		const summary = map.declared.phases.map(phase => `${phase.name} ${phase.done}/${phase.total}`).join(" · ");
		lines.push(`declared: ${summary}`);
		if (map.declared.current) lines.push(`  ▸ current: ${map.declared.current}`);
		if (map.declared.turnsSinceTodo !== undefined) {
			lines.push(`  last todo update: ${map.declared.turnsSinceTodo} turn(s) ago`);
		}
	}
	lines.push("");

	const d = map.derived;
	lines.push(`derived (last ${d.windowTurns} turns):`);
	if (d.tools.length === 0) {
		lines.push("  (no tool calls)");
	} else {
		lines.push(`  tools: ${d.tools.map(t => `${t.name}×${t.count}`).join("  ")}  errors: ${d.errors}`);
	}
	if (d.dominantPrefix) {
		const lifetime =
			d.dominantPrefixLifetime > d.dominantPrefix.count ? ` (${d.dominantPrefixLifetime} lifetime)` : "";
		lines.push(`  dominant prefix: ×${d.dominantPrefix.count}${lifetime}  ${d.dominantPrefix.prefix}`);
	}
	if (d.reReads > 0 || d.identicalReruns > 0) {
		lines.push(`  repetition: ${d.reReads} re-read(s) · ${d.identicalReruns} identical re-run(s)`);
	}
	lines.push("");

	if (map.divergence.length === 0) {
		lines.push("divergence: none — declared and derived agree");
	} else {
		for (const finding of map.divergence) lines.push(`⚠ divergence: ${finding}`);
	}
	return lines.join("\n");
}
