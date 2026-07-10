import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { FooterComponent } from "@oh-my-pi/pi-coding-agent/modes/components/footer";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "git.enabled": false } });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function makeOAuthBackedMainSession(): AgentSession {
	const model = { id: "oauth-backed-model", provider: "anthropic", contextWindow: 200_000 };
	const entries: unknown[] = [];
	const session = {
		state: { messages: [], model },
		model,
		messages: [],
		sessionManager: {
			getEntries() {
				const currentEntries = entries;
				return currentEntries;
			},
		},
		modelRegistry: {
			isUsingOAuth(candidate: unknown) {
				const activeModel = model;
				return candidate === activeModel;
			},
		},
		getContextUsage() {
			const usage = undefined;
			return usage;
		},
		isAutoThinking: false,
		autoResolvedThinkingLevel() {
			const level = undefined;
			return level;
		},
	};
	return session as unknown as AgentSession;
}

describe("OAuth billing status labels", () => {
	it("renders the status-line cost segment with an OAuth marker, not the subagent marker", () => {
		const session = makeOAuthBackedMainSession();
		const result = renderSegment("cost", {
			session,
			usageStats: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
				tokensPerSecond: null,
			},
		} as unknown as SegmentContext);
		const plain = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(plain).toContain("(oauth)");
		expect(plain).not.toContain("(sub)");
	});

	it("renders the footer billing summary with an OAuth marker, not the subagent marker", () => {
		const session = makeOAuthBackedMainSession();
		const footer = new FooterComponent(session);
		const plain = footer
			.render(120)
			.map(line => stripVTControlCharacters(line))
			.join("\n");

		expect(plain).toContain("(oauth)");
		expect(plain).not.toContain("(sub)");
	});
});
