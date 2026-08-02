import { describe, expect, test } from "bun:test";
import { buildTaskMap, MAP_WINDOW_TURNS, renderTaskMap } from "@oh-my-pi/pi-coding-agent/health/map";
import type { FileEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/todo";

/**
 * The task map juxtaposes declared intent with derived behavior; its whole
 * value is that the derived side cannot go stale and the divergence heuristics
 * fire exactly when declarations rot. Contracts pin the window semantics,
 * repetition seeding, and both divergence branches.
 */

let nextId = 0;
function turn(calls: { name: string; args?: Record<string, unknown> }[]): SessionMessageEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: calls.map(c => ({ type: "toolCall", id: `c${nextId++}`, name: c.name, arguments: c.args ?? {} })),
			model: "m",
			stopReason: "toolUse",
		},
	} as unknown as SessionMessageEntry;
}

function bashTurn(command: string): SessionMessageEntry {
	return turn([{ name: "bash", args: { command } }]);
}

function phases(done: number, total: number, current?: string): TodoPhase[] {
	const tasks: TodoPhase["tasks"] = Array.from({ length: total }, (_, i) => ({
		content: `task ${i}`,
		status: i < done ? "completed" : "pending",
	}));
	if (current !== undefined && done < total) tasks[done] = { content: current, status: "in_progress" };
	return [{ name: "Work", tasks }];
}

describe("task map", () => {
	test("declared progress arithmetic and current task", () => {
		const map = buildTaskMap([turn([{ name: "todo" }])], phases(2, 5, "wire the thing"));
		expect(map.declared.phases).toEqual([{ name: "Work", done: 2, total: 5 }]);
		expect(map.declared.current).toBe("wire the thing");
		expect(map.declared.turnsSinceTodo).toBe(0);
	});

	test("derived window clips to the trailing turns", () => {
		const entries: FileEntry[] = [];
		for (let i = 0; i < MAP_WINDOW_TURNS + 10; i++) entries.push(bashTurn(`echo ${i}`));
		const map = buildTaskMap(entries, []);
		expect(map.derived.windowTurns).toBe(MAP_WINDOW_TURNS);
		expect(map.derived.tools).toEqual([{ name: "bash", count: MAP_WINDOW_TURNS }]);
	});

	test("dominant prefix reports window count and lifetime separately", () => {
		const entries: FileEntry[] = [];
		for (let i = 0; i < 40; i++) entries.push(bashTurn("osascript <<'EOF'\nbody varies " + i));
		const map = buildTaskMap(entries, []);
		expect(map.derived.dominantPrefix).toEqual({ prefix: "osascript <<'EOF'", count: MAP_WINDOW_TURNS });
		expect(map.derived.dominantPrefixLifetime).toBe(40);
	});

	test("repetition counts window events against full history", () => {
		// The same read appears before the window and once inside it: one re-read.
		const entries: FileEntry[] = [turn([{ name: "read", args: { path: "/a.ts" } }])];
		for (let i = 0; i < MAP_WINDOW_TURNS - 1; i++) entries.push(bashTurn(`echo ${i}`));
		entries.push(turn([{ name: "read", args: { path: "/a.ts" } }]));
		const map = buildTaskMap(entries, []);
		expect(map.derived.reReads).toBe(1);
	});

	test("stale-todo divergence fires on command volume, not time", () => {
		const entries: FileEntry[] = [turn([{ name: "todo" }])];
		for (let i = 0; i < 15; i++) entries.push(bashTurn(`step ${i}`));
		const map = buildTaskMap(entries, phases(1, 3));
		expect(map.divergence).toHaveLength(1);
		expect(map.divergence[0]).toContain("15 commands since the last todo update");
		// One fewer command: quiet.
		expect(buildTaskMap(entries.slice(0, -1), phases(1, 3)).divergence).toHaveLength(0);
	});

	test("no-plan divergence fires only after enough turns", () => {
		const few = Array.from({ length: 19 }, (_, i) => bashTurn(`e ${i}`));
		expect(buildTaskMap(few, []).divergence).toHaveLength(0);
		const enough = [...few, bashTurn("e 19")];
		const map = buildTaskMap(enough, []);
		expect(map.divergence).toHaveLength(1);
		expect(map.divergence[0]).toContain("no declared plan");
	});

	test("render is deterministic and carries all three sections", () => {
		const entries = [turn([{ name: "todo" }]), bashTurn("echo hi")];
		const map = buildTaskMap(entries, phases(1, 2, "next"));
		const rendered = renderTaskMap(map);
		expect(rendered).toContain("declared: Work 1/2");
		expect(rendered).toContain("derived (last 2 turns):");
		expect(rendered).toContain("divergence: none");
		expect(renderTaskMap(buildTaskMap(entries, phases(1, 2, "next")))).toBe(rendered);
	});
});
