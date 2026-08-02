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

	test("osascript mutation verbs land in the mutation inventory", () => {
		const entries: FileEntry[] = [
			header(),
			assistantCalling("bash", {
				command:
					'osascript <<\'EOF\' 2>&1\ntell application "Mail"\n  move message 1 to mailbox "Archive"\nend tell\nEOF',
			}),
		];
		const autopsy = buildAutopsy(entries);
		expect(autopsy.mutations).toEqual([{ cluster: "osascript <<'EOF' 2>&1", count: 1 }]);
	});

	test("read-only osascript stays out of the mutation inventory", () => {
		const entries: FileEntry[] = [
			header(),
			assistantCalling("bash", { command: "osascript -e 'tell application \"Mail\" to get name of every account'" }),
		];
		expect(buildAutopsy(entries).mutations).toEqual([]);
	});

	test("rm on an absolute path is inventoried; rm on a relative path is not", () => {
		const absolute: FileEntry[] = [
			header(),
			assistantCalling("bash", { command: "rm -rf /Users/allo/Library/Mail/backup" }),
		];
		expect(buildAutopsy(absolute).mutations).toEqual([
			{ cluster: "rm -rf /Users/allo/Library/Mail/backup", count: 1 },
		]);

		const relative: FileEntry[] = [header(), assistantCalling("bash", { command: "rm -rf dist && rm src/old.ts" })];
		expect(buildAutopsy(relative).mutations).toEqual([]);
	});

	test("browser-automation click scripts are inventoried", () => {
		const entries: FileEntry[] = [
			header(),
			assistantCalling("bash", { command: "ego-browser nodejs <<'EOF'\nawait tab.click('#move-button');\nEOF" }),
			assistantCalling("eval", { code: "await tab.click('aria-ref=e5');" }),
		];
		const autopsy = buildAutopsy(entries);
		expect(autopsy.mutations).toEqual([
			{ cluster: "await tab.click('aria-ref=e5');", count: 1 },
			{ cluster: "ego-browser nodejs <<'EOF'", count: 1 },
		]);
	});

	test("mutation inventory is deterministic and renders (none detected) when empty", () => {
		const busy: FileEntry[] = [
			header(),
			assistantCalling("bash", { command: "osascript <<'EOF'\nset x to 1\nEOF" }),
			assistantCalling("bash", { command: "osascript <<'EOF'\nset x to 1\nEOF" }),
		];
		expect(buildAutopsy(busy).mutations).toEqual(buildAutopsy(busy).mutations);
		expect(renderAutopsy("autopsy-test", buildAutopsy(busy))).toContain(
			"out-of-repo mutations (heuristic inventory):",
		);

		const quiet: FileEntry[] = [header(), assistantText("Done: refactor complete.")];
		expect(renderAutopsy("autopsy-test", buildAutopsy(quiet))).toContain("  (none detected)");
	});
});

describe("ending verification", () => {
	const writeCall = (path: string) => assistantCalling("write", { path, content: "x" });
	const editCall = (path: string) => assistantCalling("edit", { input: `[${path}#AB12]\nSWAP 1.=1:\n+x` });
	const bash = (command: string) => assistantCalling("bash", { command });
	function bothInOneTurn(path: string, command: string): SessionMessageEntry {
		return {
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "b1", name: "write", arguments: { path, content: "x" } },
					{ type: "toolCall", id: "b2", name: "bash", arguments: { command } },
				],
				model: "test-model",
				stopReason: "toolUse",
			},
		} as unknown as SessionMessageEntry;
	}

	test("execution at the mutation turn or later verifies the tail", () => {
		expect(
			buildAutopsy([header(), writeCall("/a/x.ts"), bash("bun test x.ts")]).ending.verification.unverifiedTail,
		).toBeFalse();
		// Same turn: a turn carrying both write and bash counts as verified.
		expect(
			buildAutopsy([header(), bothInOneTurn("/a/x.ts", "bun test x.ts")]).ending.verification.unverifiedTail,
		).toBeFalse();
	});

	test("mutation after the last execution is an unverified tail", () => {
		const autopsy = buildAutopsy([header(), bash("bun test"), editCall("/a/y.ts")]);
		expect(autopsy.ending.verification.unverifiedTail).toBeTrue();
		expect(autopsy.ending.verification.lastMutationTurn).toBe(2);
		expect(autopsy.ending.verification.lastExecutionTurn).toBe(1);
		expect(renderAutopsy("s", autopsy)).toContain("⚠ verification: unverified tail");
	});

	test("earlier mention does not exercise a later mutation", () => {
		// x.ts named BEFORE its edit — not exercised; z.ts edited then named — exercised.
		const autopsy = buildAutopsy([
			header(),
			bash("cat x.ts"),
			editCall("/a/x.ts"),
			editCall("/a/z.ts"),
			bash("bun test z.ts"),
		]);
		expect(autopsy.ending.verification.mutatedFilesNeverExercised).toEqual(["x.ts"]);
		expect(autopsy.ending.verification.unverifiedTail).toBeFalse();
	});

	test("no repo mutations renders the neutral line", () => {
		const autopsy = buildAutopsy([header(), bash("ls")]);
		expect(autopsy.ending.verification.lastMutationTurn).toBeUndefined();
		expect(renderAutopsy("s", autopsy)).toContain("no repo mutations");
	});
});
