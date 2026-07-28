import { describe, expect, test } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import {
	collectOutboundSummaries,
	diffOutboundSummaries,
	OUTBOUND_SUMMARY_CUSTOM_TYPE,
	type OutboundRequestSummary,
	splitSystemPromptSections,
	summarizeOutboundRequest,
} from "@oh-my-pi/pi-coding-agent/health/outbound";
import type { CustomEntry, FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";

/** Realistic multi-section prompt: banner headings + markdown subsections. */
const FIXTURE_PROMPT = [
	"You are a helpful assistant.",
	"",
	"ROLE",
	"==============",
	"Operate in the harness.",
	"",
	"# Engineering Principles",
	"- Correctness first.",
	"",
	"TOOL POLICY",
	"==============",
	"",
	"# General",
	"Use tools whenever they help.",
	"",
	"# Tool I/O",
	"- Prefer relative paths.",
	"",
].join("\n");

function summary(overrides: Partial<OutboundRequestSummary> = {}): OutboundRequestSummary {
	return {
		timestamp: 1,
		model: "anthropic/claude-test",
		systemPromptChars: 1000,
		systemPromptSections: [
			{ heading: "ROLE", chars: 400 },
			{ heading: "TOOL POLICY", chars: 600 },
		],
		messageCount: 4,
		messageChars: 2000,
		toolCount: 2,
		toolNames: ["bash", "read"],
		...overrides,
	};
}

describe("splitSystemPromptSections", () => {
	test("splits banner and markdown headings, preamble included, chars sum to total", () => {
		const sections = splitSystemPromptSections(FIXTURE_PROMPT);
		expect(sections.map(section => section.heading)).toEqual([
			"(preamble)",
			"ROLE",
			"# Engineering Principles",
			"TOOL POLICY",
			"# General",
			"# Tool I/O",
		]);
		const total = sections.reduce((sum, section) => sum + section.chars, 0);
		expect(total).toBe(FIXTURE_PROMPT.length);
		for (const section of sections) expect(section.chars).toBeGreaterThan(0);
	});

	test("text without headings is a single preamble section", () => {
		expect(splitSystemPromptSections("just plain instructions")).toEqual([
			{ heading: "(preamble)", chars: "just plain instructions".length },
		]);
	});

	test("a bare ==== divider without a heading line does not split", () => {
		const text = "alpha\n\n====\n\nbeta";
		expect(splitSystemPromptSections(text)).toEqual([{ heading: "(preamble)", chars: text.length }]);
	});
});

describe("summarizeOutboundRequest", () => {
	test("counts system prompt, messages, and sorted tool names without serializing payloads", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello world", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hi" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x", limit: 5 } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-test",
				usage: {},
				stopReason: "toolUse",
				timestamp: 2,
			} as unknown as Message,
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 3,
			},
		];
		const result = summarizeOutboundRequest({
			model: "anthropic/claude-test",
			systemPrompt: [FIXTURE_PROMPT],
			messages,
			tools: [{ name: "read" }, { name: "bash" }],
			thinkingLevel: "high",
			timestamp: 99,
		});
		expect(result.model).toBe("anthropic/claude-test");
		expect(result.timestamp).toBe(99);
		expect(result.systemPromptChars).toBe(FIXTURE_PROMPT.length);
		expect(result.systemPromptSections.length).toBe(6);
		expect(result.messageCount).toBe(3);
		// user text + assistant text + toolCall (name + keys + string arg + 8 for the number) + tool result text
		const expectedChars =
			"hello world".length +
			"hi".length +
			("read".length + "path".length + "/tmp/x".length + "limit".length + 8) +
			"file body".length;
		expect(result.messageChars).toBe(expectedChars);
		expect(result.toolNames).toEqual(["bash", "read"]);
		expect(result.toolCount).toBe(2);
		expect(result.thinkingLevel).toBe("high");
	});
});

describe("diffOutboundSummaries", () => {
	test("identical summaries produce an empty diff", () => {
		expect(diffOutboundSummaries(summary(), summary())).toEqual([]);
	});

	test("section growth beyond 10% is reported with percentage", () => {
		const grown = summary({
			systemPromptSections: [
				{ heading: "ROLE", chars: 400 },
				{ heading: "TOOL POLICY", chars: 720 },
			],
		});
		const diffs = diffOutboundSummaries(summary(), grown);
		expect(diffs).toEqual(['section "TOOL POLICY" 600→720ch (+20%)']);
	});

	test("section growth within 10% is not reported", () => {
		const nudged = summary({
			systemPromptSections: [
				{ heading: "ROLE", chars: 400 },
				{ heading: "TOOL POLICY", chars: 630 },
			],
		});
		expect(diffOutboundSummaries(summary(), nudged)).toEqual([]);
	});

	test("sections added and removed are reported", () => {
		const changed = summary({
			systemPromptSections: [
				{ heading: "ROLE", chars: 400 },
				{ heading: "PLAN", chars: 150 },
			],
		});
		const diffs = diffOutboundSummaries(summary(), changed);
		expect(diffs).toContain('+section "PLAN" (150ch)');
		expect(diffs).toContain('-section "TOOL POLICY" (600ch)');
	});

	test("tool set changes are reported as +name/-name", () => {
		const changed = summary({ toolNames: ["bash", "edit"], toolCount: 2 });
		const diffs = diffOutboundSummaries(summary(), changed);
		expect(diffs).toContain("+tool edit");
		expect(diffs).toContain("-tool read");
	});

	test("model changes are reported", () => {
		const switched = summary({ model: "openai/gpt-test" });
		expect(diffOutboundSummaries(summary(), switched)).toEqual(["model anthropic/claude-test → openai/gpt-test"]);
	});
});

describe("collectOutboundSummaries", () => {
	function entriesWith(count: number): FileEntry[] {
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "outbound-test",
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp/outbound-test",
		};
		const entries: FileEntry[] = [header];
		for (let index = 0; index < count; index++) {
			const entry: CustomEntry = {
				type: "custom",
				customType: OUTBOUND_SUMMARY_CUSTOM_TYPE,
				data: summary({ timestamp: index + 1 }),
				id: `entry-${index}`,
				parentId: null,
				timestamp: new Date(index).toISOString(),
			};
			entries.push(entry);
		}
		return entries;
	}

	test("keeps only the trailing 32 of 33 recorded summaries", () => {
		const kept = collectOutboundSummaries(entriesWith(33));
		expect(kept.length).toBe(32);
		expect(kept[0].timestamp).toBe(2); // first summary dropped
		expect(kept[31].timestamp).toBe(33);
	});

	test("ignores malformed and unrelated custom entries", () => {
		const entries = entriesWith(2);
		entries.push({
			type: "custom",
			customType: OUTBOUND_SUMMARY_CUSTOM_TYPE,
			data: { nonsense: true },
			id: "bad",
			parentId: null,
			timestamp: new Date(0).toISOString(),
		} as CustomEntry);
		entries.push({
			type: "custom",
			customType: "unrelated",
			data: summary(),
			id: "other",
			parentId: null,
			timestamp: new Date(0).toISOString(),
		} as CustomEntry);
		expect(collectOutboundSummaries(entries).length).toBe(2);
	});
});
