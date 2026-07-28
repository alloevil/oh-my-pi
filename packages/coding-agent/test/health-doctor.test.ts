import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { analyzeSession } from "@oh-my-pi/pi-coding-agent/health/doctor";
import type { HealthFindingInput } from "@oh-my-pi/pi-coding-agent/health/ledger";
import type {
	CustomMessageEntry,
	FileEntry,
	ModelChangeEntry,
	SessionHeader,
	SessionMessageEntry,
	TtsrInjectionEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";

let entrySeq = 0;
const T0 = Date.parse("2026-07-28T00:00:00.000Z");

function base(): { id: string; parentId: null; timestamp: string } {
	entrySeq++;
	return { id: `entry-${entrySeq}`, parentId: null, timestamp: new Date(T0 + entrySeq * 1000).toISOString() };
}

function header(): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: "doctor-test-session",
		timestamp: new Date(T0).toISOString(),
		cwd: "/tmp/doctor-test",
	};
}

interface AssistantOptions {
	model?: string;
	stopReason?: string;
	errorMessage?: string | null;
	thinking?: boolean;
	text?: string;
	toolCalls?: { id: string; name: string }[];
}

function assistant(options: AssistantOptions = {}): SessionMessageEntry {
	const content: Record<string, unknown>[] = [];
	if (options.thinking) content.push({ type: "thinking", thinking: "pondering" });
	content.push({ type: "text", text: options.text ?? "ok" });
	for (const call of options.toolCalls ?? []) {
		content.push({ type: "toolCall", id: call.id, name: call.name, arguments: {} });
	}
	// Partial fabrication: doctor only reads role/content/model/stopReason/errorMessage.
	const message = {
		role: "assistant",
		content,
		model: options.model ?? "test-model",
		stopReason: options.stopReason ?? ((options.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop"),
		errorMessage: options.errorMessage ?? null,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: T0,
	} as unknown as AssistantMessage;
	return { ...base(), type: "message", message };
}

function user(text = "hello"): SessionMessageEntry {
	const message = { role: "user", content: text, timestamp: T0 } as unknown as UserMessage;
	return { ...base(), type: "message", message };
}

function toolResult(toolCallId: string, toolName = "read", text = "done"): SessionMessageEntry {
	const message = {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: T0,
	} as unknown as ToolResultMessage;
	return { ...base(), type: "message", message };
}

function modelChange(model: string): ModelChangeEntry {
	return { ...base(), type: "model_change", model };
}

function ttsrInjection(): TtsrInjectionEntry {
	return { ...base(), type: "ttsr_injection", injectedRules: ["some-rule"] };
}

function customMessage(): CustomMessageEntry {
	return { ...base(), type: "custom_message", customType: "test-notice", content: "notice", display: false };
}

function findByRule(findings: HealthFindingInput[], rule: string): HealthFindingInput | undefined {
	return findings.find(finding => finding.rule === rule);
}

/** A complete healthy exchange: matched tool pair, thinking present, single model. */
function healthyEntries(): FileEntry[] {
	return [
		header(),
		modelChange("anthropic/test-model"), // initial selection before any message is not a switch
		user(),
		assistant({ thinking: true, toolCalls: [{ id: "call-1", name: "read" }] }),
		toolResult("call-1"),
		assistant({ thinking: true, text: "all done" }),
	];
}

describe("health doctor rules", () => {
	test("healthy session yields zero findings", () => {
		expect(analyzeSession(healthyEntries())).toEqual([]);
	});

	test("model-switch fires on two assistant models with the sequence in the message", () => {
		const findings = analyzeSession([
			header(),
			user(),
			assistant({ model: "model-a" }),
			assistant({ model: "model-b" }),
		]);
		const finding = findByRule(findings, "model-switch");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("info");
		expect(finding?.message).toContain("model-a → model-b");
		expect(findings).toHaveLength(1);
	});

	test("model-switch fires on a mid-session model_change entry", () => {
		const findings = analyzeSession([
			header(),
			user(),
			assistant({ model: "model-a" }),
			modelChange("provider/model-b"),
		]);
		const finding = findByRule(findings, "model-switch");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("info");
		// Provider prefix is stripped so change targets align with assistant models.
		expect(finding?.message).toContain("model-a → model-b");
	});

	test("orphan-tool-pairs warns on unanswered calls and unmatched results in closed turns", () => {
		const findings = analyzeSession([
			header(),
			user(),
			assistant({
				toolCalls: [
					{ id: "call-1", name: "read" },
					{ id: "call-2", name: "bash" },
				],
			}),
			toolResult("call-1"),
			toolResult("ghost-id", "grep"),
			user("continue"),
			assistant({ text: "wrapping up" }),
		]);
		const finding = findByRule(findings, "orphan-tool-pairs");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warn");
		expect(finding?.message).toContain("1 tool call without a result");
		expect(finding?.message).toContain("bash call-2");
		expect(finding?.message).toContain("1 tool result without a matching call");
		expect(finding?.message).toContain("grep ghost-id");
	});

	test("orphan-tool-pairs excludes the trailing in-flight turn", () => {
		// Session snapshotted mid-turn: last assistant still has call-2 pending
		// and one trailing result arrived with an id we never saw.
		const findings = analyzeSession([
			header(),
			user(),
			assistant({
				toolCalls: [
					{ id: "call-1", name: "read" },
					{ id: "call-2", name: "bash" },
				],
			}),
			toolResult("call-1"),
			toolResult("ghost-trailing", "grep"),
		]);
		expect(findByRule(findings, "orphan-tool-pairs")).toBeUndefined();
		expect(findings).toEqual([]);
	});

	test("error-turns warns with count and first example", () => {
		const findings = analyzeSession([
			header(),
			user(),
			assistant({ errorMessage: "Connection error." }),
			assistant({ stopReason: "length" }),
			assistant({ text: "recovered" }),
		]);
		const finding = findByRule(findings, "error-turns");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warn");
		expect(finding?.message).toContain("2 assistant turns failed");
		expect(finding?.message).toContain("Connection error.");
	});

	test("aborted stop reason counts as an error turn", () => {
		const findings = analyzeSession([header(), user(), assistant({ stopReason: "aborted" })]);
		const finding = findByRule(findings, "error-turns");
		expect(finding?.severity).toBe("warn");
		expect(finding?.message).toContain("stopReason=aborted");
	});

	test("injection-volume reports TTSR and custom message counts as info", () => {
		const findings = analyzeSession([
			header(),
			user(),
			ttsrInjection(),
			customMessage(),
			customMessage(),
			assistant({}),
		]);
		const finding = findByRule(findings, "injection-volume");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("info");
		expect(finding?.message).toContain("1 TTSR");
		expect(finding?.message).toContain("2 custom messages");
	});

	test("oversized-messages escalates to warn above 64KB and names the tool", () => {
		const findings = analyzeSession([
			header(),
			user(),
			assistant({ toolCalls: [{ id: "call-1", name: "read" }] }),
			toolResult("call-1", "read", "x".repeat(70 * 1024)),
			assistant({ text: "digested" }),
		]);
		const finding = findByRule(findings, "oversized-messages");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warn");
		expect(finding?.message).toContain("toolResult(read)");
	});

	test("oversized-messages stays info between 16KB and 64KB", () => {
		const findings = analyzeSession([
			header(),
			user(),
			assistant({ toolCalls: [{ id: "call-1", name: "read" }] }),
			toolResult("call-1", "read", "x".repeat(20 * 1024)),
			assistant({ text: "digested" }),
		]);
		const finding = findByRule(findings, "oversized-messages");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("info");
	});

	test("thinking-collapse fires after five consecutive thinking-free turns", () => {
		const entries: FileEntry[] = [header(), user(), assistant({ thinking: true })];
		for (let i = 0; i < 5; i++) entries.push(assistant({ text: `turn ${i}` }));
		const findings = analyzeSession(entries);
		const finding = findByRule(findings, "thinking-collapse");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("info");
		expect(finding?.message).toContain("5 consecutive assistant turns");
	});

	test("thinking-collapse stays silent below the threshold and without prior thinking", () => {
		const fourWithout: FileEntry[] = [header(), user(), assistant({ thinking: true })];
		for (let i = 0; i < 4; i++) fourWithout.push(assistant({ text: `turn ${i}` }));
		expect(findByRule(analyzeSession(fourWithout), "thinking-collapse")).toBeUndefined();

		const neverThought: FileEntry[] = [header(), user()];
		for (let i = 0; i < 6; i++) neverThought.push(assistant({ text: `turn ${i}` }));
		expect(findByRule(analyzeSession(neverThought), "thinking-collapse")).toBeUndefined();
	});
});
