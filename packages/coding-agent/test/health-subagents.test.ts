import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import {
	collectSubagentRefs,
	resolveSubagentSessions,
	subagentsRootForSession,
} from "@oh-my-pi/pi-coding-agent/health/subagents";
import type {
	CustomMessageEntry,
	FileEntry,
	SessionHeader,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";

let entrySeq = 0;
const T0 = Date.parse("2026-08-02T00:00:00.000Z");

function base(): { id: string; parentId: null; timestamp: string } {
	entrySeq++;
	return { id: `entry-${entrySeq}`, parentId: null, timestamp: new Date(T0 + entrySeq * 1000).toISOString() };
}

function header(id = "parent-session"): SessionHeader {
	return { type: "session", version: 3, id, timestamp: new Date(T0).toISOString(), cwd: "/tmp/subagents-test" };
}

function user(text = "hello"): SessionMessageEntry {
	const message = { role: "user", content: text, timestamp: T0 } as unknown as UserMessage;
	return { ...base(), type: "message", message };
}

interface AssistantOptions {
	model?: string;
	errorMessage?: string;
	toolCalls?: { id: string; name: string; arguments?: Record<string, unknown> }[];
}

function assistant(options: AssistantOptions = {}): SessionMessageEntry {
	const content: Record<string, unknown>[] = [{ type: "text", text: "ok" }];
	for (const call of options.toolCalls ?? []) {
		content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} });
	}
	// Partial fabrication: ref extraction reads role/content; the digest scan reads model/stopReason/errorMessage.
	const message = {
		role: "assistant",
		content,
		model: options.model ?? "test-model",
		stopReason: (options.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop",
		errorMessage: options.errorMessage ?? null,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: T0,
	} as unknown as AssistantMessage;
	return { ...base(), type: "message", message };
}

/** A `task` toolResult with the persisted `TaskToolDetails` shape (`progress` + `results` rows). */
function taskResult(
	toolCallId: string,
	details: {
		progress?: Record<string, unknown>[];
		results?: Record<string, unknown>[];
	},
): SessionMessageEntry {
	const message = {
		role: "toolResult",
		toolCallId,
		toolName: "task",
		content: [{ type: "text", text: "spawned" }],
		details: {
			projectAgentsDir: null,
			results: details.results ?? [],
			totalDurationMs: 0,
			progress: details.progress,
		},
		isError: false,
		timestamp: T0,
	} as unknown as ToolResultMessage;
	return { ...base(), type: "message", message };
}

function asyncResult(body: string): CustomMessageEntry {
	return { ...base(), type: "custom_message", customType: "async-result", content: body, display: false };
}

function progressRow(id: string, status = "pending", agent = "task"): Record<string, unknown> {
	return { index: 0, id, agent, agentSource: "bundled", status, task: "work" };
}

describe("collectSubagentRefs", () => {
	test("extracts progress rows, sync results, and async-result updates with last-write-wins status", () => {
		const entries: FileEntry[] = [
			header(),
			user(),
			assistant({
				toolCalls: [{ id: "call-1", name: "task", arguments: { tasks: [{ task: "a" }, { task: "b" }] } }],
			}),
			taskResult("call-1", {
				progress: [progressRow("Alpha", "pending", "scout"), progressRow("Beta")],
				results: [
					{
						index: 0,
						id: "Gamma",
						agent: "task",
						exitCode: 0,
						outputPath: "/tmp/Gamma.md",
						resolvedModel: "prov/model-x",
					},
				],
			}),
			asyncResult(
				'<system-notice>\nBackground job Alpha has completed.\n<task-result id="Alpha" agent="scout" status="completed" duration="1m2s">\nbody\n</task-result>',
			),
		];
		const refs = collectSubagentRefs(entries);
		expect(refs.map(ref => ref.id)).toEqual(["Alpha", "Beta", "Gamma"]);

		const alpha = refs[0];
		expect(alpha.agent).toBe("scout");
		expect(alpha.status).toBe("completed"); // async-result overrode the persisted "pending"
		expect(alpha.sources).toEqual(["progress", "async-result"]);

		expect(refs[1].status).toBe("pending");

		const gamma = refs[2];
		expect(gamma.status).toBe("completed"); // derived from exitCode 0
		expect(gamma.outputPath).toBe("/tmp/Gamma.md");
		expect(gamma.resolvedModel).toBe("prov/model-x");
		expect(gamma.sources).toEqual(["result"]);
	});

	test("result rows derive failed/aborted status from exitCode and aborted", () => {
		const refs = collectSubagentRefs([
			header(),
			user(),
			taskResult("call-1", {
				results: [
					{ index: 0, id: "Failed", agent: "task", exitCode: 1 },
					{ index: 1, id: "Stopped", agent: "task", exitCode: 0, aborted: true },
				],
			}),
		]);
		expect(refs.find(ref => ref.id === "Failed")?.status).toBe("failed");
		expect(refs.find(ref => ref.id === "Stopped")?.status).toBe("aborted");
	});

	test("task-call argument names count only when the call never persisted a result", () => {
		const entries: FileEntry[] = [
			header(),
			user(),
			// Answered call: progress rows are authoritative; the renamed arg name must not leak.
			assistant({
				toolCalls: [{ id: "call-1", name: "task", arguments: { tasks: [{ name: "Original", task: "x" }] } }],
			}),
			taskResult("call-1", { progress: [progressRow("Original2")] }),
			// Unanswered call (stream died before the result persisted): arg names are the only trace.
			assistant({
				toolCalls: [
					{ id: "call-2", name: "task", arguments: { name: "FlatOrphan", task: "y" } },
					{ id: "call-3", name: "task", arguments: { tasks: [{ name: "BatchOrphan", task: "z" }] } },
				],
			}),
		];
		const refs = collectSubagentRefs(entries);
		expect(refs.map(ref => ref.id)).toEqual(["Original2", "FlatOrphan", "BatchOrphan"]);
		expect(refs.find(ref => ref.id === "FlatOrphan")?.sources).toEqual(["task-args"]);
	});

	test("sessions without task spawns produce no refs", () => {
		const entries: FileEntry[] = [
			header(),
			user(),
			assistant({ toolCalls: [{ id: "call-1", name: "read" }] }),
			{
				...base(),
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "file body" }],
					isError: false,
					timestamp: T0,
				} as unknown as ToolResultMessage,
			},
		];
		expect(collectSubagentRefs(entries)).toEqual([]);
	});

	test("is deterministic over the same entries", () => {
		const entries: FileEntry[] = [
			header(),
			user(),
			taskResult("call-1", { progress: [progressRow("A"), progressRow("B")] }),
			asyncResult('<task-result id="A" agent="task" status="completed">'),
		];
		expect(collectSubagentRefs(entries)).toEqual(collectSubagentRefs(entries));
	});
});

describe("resolveSubagentSessions", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function makeRoot(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-health-subagents-"));
		tempDirs.push(dir);
		return dir;
	}

	function childSessionJsonl(entries: FileEntry[]): string {
		return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
	}

	test("resolves children by id, digests them, and keeps unresolved refs listed", async () => {
		const root = await makeRoot();
		// Child with one failed assistant turn (error-turns => 1 warn) across two models (model-switch => info).
		await Bun.write(
			path.join(root, "Alpha.jsonl"),
			childSessionJsonl([
				header("alpha-child"),
				user(),
				assistant({ model: "model-a" }),
				assistant({ model: "model-b", errorMessage: "provider exploded" }),
			]),
		);
		const refs = collectSubagentRefs([
			header(),
			user(),
			taskResult("call-1", { progress: [progressRow("Alpha", "completed"), progressRow("Ghost", "failed")] }),
		]);
		const rows = await resolveSubagentSessions(refs, root);

		expect(rows.map(row => row.ref.id)).toEqual(["Alpha", "Ghost"]);

		const alpha = rows[0];
		expect(alpha.resolved).toBe(true);
		expect(alpha.sessionPath).toBe(path.join(root, "Alpha.jsonl"));
		expect(alpha.digest?.messageCount).toBe(3);
		expect(alpha.digest?.models).toEqual(["model-a", "model-b"]);
		expect(alpha.digest?.warnCount).toBe(1); // error-turns only
		expect(alpha.digest?.findingCount).toBeGreaterThan(1); // + model-switch info

		const ghost = rows[1];
		expect(ghost.resolved).toBe(false);
		expect(ghost.sessionPath).toBeUndefined();
		expect(ghost.digest).toBeUndefined();
	});

	test("matches child files case-insensitively", async () => {
		const root = await makeRoot();
		await Bun.write(
			path.join(root, "mixedcase.jsonl"),
			childSessionJsonl([header("mixed-child"), user(), assistant()]),
		);
		const rows = await resolveSubagentSessions(
			collectSubagentRefs([header(), user(), taskResult("call-1", { progress: [progressRow("MixedCase")] })]),
			root,
		);
		expect(rows[0].resolved).toBe(true);
		expect(rows[0].sessionPath).toBe(path.join(root, "mixedcase.jsonl"));
	});

	test("an empty child file resolves with a note instead of a digest", async () => {
		const root = await makeRoot();
		await Bun.write(path.join(root, "Empty.jsonl"), "");
		const rows = await resolveSubagentSessions(
			collectSubagentRefs([header(), user(), taskResult("call-1", { progress: [progressRow("Empty")] })]),
			root,
		);
		expect(rows[0].resolved).toBe(true);
		expect(rows[0].digest).toBeUndefined();
		expect(rows[0].note).toContain("empty");
	});

	test("a missing artifacts root leaves every ref unresolved", async () => {
		const rows = await resolveSubagentSessions(
			collectSubagentRefs([header(), user(), taskResult("call-1", { progress: [progressRow("Lonely")] })]),
			path.join(os.tmpdir(), "omp-health-subagents-does-not-exist"),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].resolved).toBe(false);
	});

	test("is deterministic over the same refs and directory", async () => {
		const root = await makeRoot();
		await Bun.write(path.join(root, "Alpha.jsonl"), childSessionJsonl([header("alpha-child"), user(), assistant()]));
		const refs = collectSubagentRefs([
			header(),
			user(),
			taskResult("call-1", { progress: [progressRow("Alpha"), progressRow("Ghost")] }),
		]);
		expect(await resolveSubagentSessions(refs, root)).toEqual(await resolveSubagentSessions(refs, root));
	});
});

describe("subagentsRootForSession", () => {
	test("maps a parent .jsonl path to its artifacts directory (doctor-cli depends on this shape)", () => {
		expect(subagentsRootForSession("/sessions/-Downloads/2026-08-02T00-00-00-000Z_abc.jsonl")).toBe(
			"/sessions/-Downloads/2026-08-02T00-00-00-000Z_abc",
		);
	});
});
