import { describe, expect, test } from "bun:test";
import { buildAutopsy, renderAutopsy } from "@oh-my-pi/pi-coding-agent/health/autopsy";
import type { FileEntry, SessionHeader, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

/**
 * The autopsy is computed evidence for human judgment: it must cluster failure
 * shapes, expose command churn, and report the transcript's ending without
 * ever judging any of it. Contracts pin the clustering and ending semantics —
 * the parts a refactor would silently bend.
 */

function header(): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: "autopsy-test",
		timestamp: new Date().toISOString(),
		cwd: "/tmp",
	} as SessionHeader;
}

let nextId = 0;
function assistantCalling(tool: string, args: Record<string, unknown>): SessionMessageEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `call-${nextId++}`, name: tool, arguments: args }],
			model: "test-model",
			stopReason: "toolUse",
		},
	} as unknown as SessionMessageEntry;
}

function assistantText(text: string): SessionMessageEntry {
	return {
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }], model: "test-model", stopReason: "stop" },
	} as unknown as SessionMessageEntry;
}

function failedResult(toolName: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: `call-${nextId}`,
			toolName,
			content: [{ type: "text", text }],
			isError: true,
		},
	} as unknown as SessionMessageEntry;
}

describe("behavioral autopsy", () => {
	test("clusters failures by tool and first line", () => {
		const entries: FileEntry[] = [
			header(),
			failedResult("bash", "Error: CDP request timed out\nstack…"),
			failedResult("bash", "Error: CDP request timed out\nother stack…"),
			failedResult("bash", "syntax error: Expected end of line"),
			failedResult("read", "Error: CDP request timed out"),
		];
		const autopsy = buildAutopsy(entries);
		expect(autopsy.errors.total).toBe(4);
		// Same first line, different stacks → one cluster; same line under another tool → separate.
		expect(autopsy.errors.distinctClusters).toBe(3);
		expect(autopsy.errors.top[0]).toEqual({ cluster: "bash | Error: CDP request timed out", count: 2 });
	});

	test("command lineage reports repeated prefixes only", () => {
		const entries: FileEntry[] = [
			header(),
			assistantCalling("bash", { command: "osascript <<'EOF'\ntell app…" }),
			assistantCalling("bash", { command: "osascript <<'EOF'\nother body…" }),
			assistantCalling("bash", { command: "echo once" }),
		];
		const lineage = buildAutopsy(entries).commandLineage;
		expect(lineage).toEqual([{ prefix: "osascript <<'EOF'", count: 2 }]);
	});

	test("ending reports the dangling assistant text and todo usage", () => {
		const entries: FileEntry[] = [
			header(),
			assistantCalling("todo", { op: "init" }),
			assistantText("对话框出现了。在其中搜 Dev 并确认："),
		];
		const ending = buildAutopsy(entries).ending;
		expect(ending.lastRole).toBe("assistant");
		expect(ending.todoCalls).toBe(1);
		expect(ending.lastAssistantText).toContain("搜 Dev");
		expect(ending.inFlight).toBeFalse();
	});

	test("a transcript stopping on an unanswered tool call is in-flight", () => {
		const entries: FileEntry[] = [header(), assistantCalling("bash", { command: "sleep 999" })];
		expect(buildAutopsy(entries).ending.inFlight).toBeTrue();
	});

	test("ask questions are collected in order", () => {
		const entries: FileEntry[] = [
			header(),
			assistantCalling("ask", { questions: [{ question: "登录好了吗？" }] }),
			assistantCalling("ask", { questions: [{ question: "登录状态？" }] }),
		];
		const asks = buildAutopsy(entries).asks;
		expect(asks.count).toBe(2);
		expect(asks.questions).toEqual(["登录好了吗？", "登录状态？"]);
	});

	test("healthy session renders without noise and deterministically", () => {
		const entries: FileEntry[] = [header(), assistantText("Done: all inboxes organized.")];
		const autopsy = buildAutopsy(entries);
		expect(autopsy.errors.total).toBe(0);
		expect(autopsy.commandLineage).toEqual([]);
		const rendered = renderAutopsy("autopsy-test", autopsy);
		expect(rendered).toContain("(none)");
		expect(rendered).toContain("(no prefix repeated)");
		expect(renderAutopsy("autopsy-test", buildAutopsy(entries))).toBe(rendered);
	});
});
