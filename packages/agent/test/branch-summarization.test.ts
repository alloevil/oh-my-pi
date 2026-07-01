/**
 * Regression tests for #4025: branch summaries dropped every `toolResult`
 * before serialization, so facts learned only from `read`/`grep`/`bash`
 * observations disappeared from the abandoned-branch summary. The pre-filter
 * in `getMessageFromEntry()` now keeps tool results; downstream
 * `serializeConversation()` truncates each and drops `useless` entries.
 */
import { describe, expect, test } from "bun:test";
import { generateBranchSummary, prepareBranchEntries, type SessionEntry } from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const UNIQUE_FACT = "primary color is cerulean 7f00ff";

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: "2026-07-01T00:00:00.000Z", message };
}

function assistantMsg(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: ZERO_USAGE,
		stopReason,
		timestamp: 0,
	};
}

/**
 * Branch where the useful fact appears only inside the `read` tool result.
 * The assistant's tool call captures the request, not the file contents.
 */
function branchEntries(): SessionEntry[] {
	return [
		messageEntry("e1", null, { role: "user", content: "check the theme file", timestamp: 0 }),
		messageEntry(
			"e2",
			"e1",
			assistantMsg(
				[
					{ type: "text", text: "Reading the theme file." },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "theme.json" } },
				],
				"toolUse",
			),
		),
		messageEntry("e3", "e2", {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: UNIQUE_FACT }],
			isError: false,
			timestamp: 0,
		}),
		messageEntry("e4", "e3", assistantMsg([{ type: "text", text: "Got it, will use that." }], "stop")),
	];
}

describe("prepareBranchEntries — tool result preservation", () => {
	test("keeps toolResult messages so summarizer sees observations", () => {
		const { messages } = prepareBranchEntries(branchEntries());
		const toolResult = messages.find(m => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		if (toolResult?.role !== "toolResult") throw new Error("unreachable");
		expect(Array.isArray(toolResult.content)).toBe(true);
		const text = toolResult.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("");
		expect(text).toBe(UNIQUE_FACT);
	});

	test("retains the paired assistant tool call alongside the result", () => {
		const { messages } = prepareBranchEntries(branchEntries());
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		if (assistant?.role !== "assistant") throw new Error("unreachable");
		const toolCall = assistant.content.find(block => block.type === "toolCall");
		expect(toolCall).toBeDefined();
	});

	test("budgets large tool results after summary truncation", () => {
		const largeObservation = `${UNIQUE_FACT}\n${"large observation ".repeat(20_000)}`;
		const entries: SessionEntry[] = [
			messageEntry("e1", null, { role: "user", content: "read large output", timestamp: 0 }),
			messageEntry(
				"e2",
				"e1",
				assistantMsg(
					[{ type: "toolCall", id: "call-large", name: "read", arguments: { path: "large.txt" } }],
					"toolUse",
				),
			),
			messageEntry("e3", "e2", {
				role: "toolResult",
				toolCallId: "call-large",
				toolName: "read",
				content: [{ type: "text", text: largeObservation }],
				isError: false,
				timestamp: 0,
			}),
		];

		const { messages, totalTokens } = prepareBranchEntries(entries, 1_200);
		const toolResult = messages.find(m => m.role === "toolResult");

		expect(toolResult).toBeDefined();
		expect(totalTokens).toBeLessThan(1_200);
	});
});

describe("generateBranchSummary — tool observation content reaches the summarizer", () => {
	test("branch summarizer prompt contains the tool result fact, not just the tool call scaffolding", async () => {
		let capturedPrompt = "";
		const completeImpl = async <TApi extends Api>(
			_model: Model<TApi>,
			ctx: Context,
			_options: SimpleStreamOptions,
		): Promise<AssistantMessage> => {
			const userMsg = ctx.messages.at(-1);
			if (userMsg?.role === "user" && Array.isArray(userMsg.content)) {
				for (const block of userMsg.content) {
					if (block.type === "text") capturedPrompt += block.text;
				}
			}
			return {
				role: "assistant",
				content: [{ type: "text", text: "summary" }],
				api: "mock",
				provider: "mock",
				model: "mock-model",
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: 0,
			};
		};

		const result = await generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: "test-key",
			signal: new AbortController().signal,
			completeImpl,
		});

		expect(result.summary).toContain("summary");
		// The unique fact lives only in the tool result content; before the fix
		// it was dropped before serialization and never reached the summarizer.
		expect(capturedPrompt).toContain(UNIQUE_FACT);
	});

	test("drops results flagged useless while keeping real observations", async () => {
		const entries: SessionEntry[] = [
			messageEntry("e1", null, { role: "user", content: "search", timestamp: 0 }),
			messageEntry(
				"e2",
				"e1",
				assistantMsg(
					[
						{ type: "toolCall", id: "call-keep", name: "search", arguments: { pattern: "alpha" } },
						{ type: "toolCall", id: "call-drop", name: "search", arguments: { pattern: "zzz_nothing" } },
					],
					"toolUse",
				),
			),
			messageEntry("e3", "e2", {
				role: "toolResult",
				toolCallId: "call-keep",
				toolName: "search",
				content: [{ type: "text", text: `alpha match: ${UNIQUE_FACT}` }],
				isError: false,
				timestamp: 0,
			}),
			messageEntry("e4", "e3", {
				role: "toolResult",
				toolCallId: "call-drop",
				toolName: "search",
				content: [{ type: "text", text: "No matches found" }],
				isError: false,
				useless: true,
				timestamp: 0,
			}),
		];

		let capturedPrompt = "";
		const completeImpl = async <TApi extends Api>(
			_model: Model<TApi>,
			ctx: Context,
			_options: SimpleStreamOptions,
		): Promise<AssistantMessage> => {
			const userMsg = ctx.messages.at(-1);
			if (userMsg?.role === "user" && Array.isArray(userMsg.content)) {
				for (const block of userMsg.content) {
					if (block.type === "text") capturedPrompt += block.text;
				}
			}
			return {
				role: "assistant",
				content: [{ type: "text", text: "summary" }],
				api: "mock",
				provider: "mock",
				model: "mock-model",
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: 0,
			};
		};

		await generateBranchSummary(entries, {
			model: MODEL,
			apiKey: "test-key",
			signal: new AbortController().signal,
			completeImpl,
		});

		expect(capturedPrompt).toContain(UNIQUE_FACT);
		expect(capturedPrompt).not.toContain("No matches found");
	});
});
