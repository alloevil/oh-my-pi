import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { CommandChurnGuard } from "@oh-my-pi/pi-coding-agent/session/stream-guards";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

/** Incident-shaped command: identical first line, per-call heredoc body (never identical arguments). */
function browserGrindCommand(i: number): string {
	return `ego-browser nodejs <<'EOF'\nawait tab.click("#msg-${i}");\nEOF`;
}

describe("CommandChurnGuard", () => {
	it("fires exactly once per cluster, at the threshold call, on a synthetic 120-call incident replay", () => {
		const guard = new CommandChurnGuard({ threshold: 50 });
		const firedAt: number[] = [];
		for (let i = 1; i <= 120; i++) {
			const detection = guard.recordCommand("bash", browserGrindCommand(i));
			if (detection) {
				firedAt.push(i);
				expect(detection.prefix).toBe("ego-browser nodejs <<'EOF'");
				expect(detection.count).toBe(50);
				expect(detection.toolName).toBe("bash");
			}
		}
		expect(firedAt).toEqual([50]);
	});

	it("does not fire below the threshold", () => {
		const guard = new CommandChurnGuard({ threshold: 50 });
		for (let i = 1; i <= 49; i++) {
			expect(guard.recordCommand("bash", browserGrindCommand(i))).toBeNull();
		}
	});

	it("fires independently per cluster", () => {
		const guard = new CommandChurnGuard({ threshold: 10 });
		const fired: string[] = [];
		for (let i = 1; i <= 12; i++) {
			for (const command of [
				`osascript -e 'tell app "Mail"'\n-- step ${i}`,
				`sqlite3 /tmp/x.db <<SQL\nselect ${i};\nSQL`,
			]) {
				const detection = guard.recordCommand("bash", command);
				if (detection) fired.push(`${detection.prefix} @${detection.count}`);
			}
		}
		expect(fired).toEqual([`osascript -e 'tell app "Mail"' @10`, `sqlite3 /tmp/x.db <<SQL @10`]);
	});

	it("clusters by first line only: bodies differ, first 80 chars decide", () => {
		const guard = new CommandChurnGuard({ threshold: 10 });
		const longHead = `bun run scripts/very-long-invocation.ts --with --many --flags --padding-padding ${"x".repeat(40)}`;
		const firedAt: number[] = [];
		for (let i = 1; i <= 10; i++) {
			// Same >80-char first line with a differing tail: one cluster.
			if (guard.recordCommand("bash", `${longHead}-variant-${i}`)) firedAt.push(i);
		}
		expect(firedAt).toEqual([10]);
	});

	it("clamps the configured threshold to the minimum of 10", () => {
		const guard = new CommandChurnGuard({ threshold: 3 });
		const firedAt: number[] = [];
		for (let i = 1; i <= 12; i++) {
			if (guard.recordCommand("eval", "print(1)")) firedAt.push(i);
		}
		expect(firedAt).toEqual([10]);
	});
});

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession command churn guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-command-churn-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	/** Drives `grindTurns` same-prefix bash turns (distinct arguments each) then a stop turn. */
	async function runGrindSession(
		grindTurns: number,
		overrides: Partial<Record<SettingPath, unknown>>,
	): Promise<{ contexts: Context[]; redirects: CustomMessage[] }> {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "moved 1 message" }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const toolCallTurn = callCount < grindTurns;
				const toolCallId = `tc-${callCount}`;
				callCount++;
				const message: AssistantMessage = toolCallTurn
					? {
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: toolCallId,
									name: "bash",
									arguments: { command: browserGrindCommand(callCount) },
								},
							],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done grinding." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			...overrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("organize the mail");
		await session.waitForIdle();

		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "command-churn-redirect",
		);
		return { contexts, redirects };
	}

	it("injects one hidden redirect at the configured threshold and records an info health finding", async () => {
		const { contexts, redirects } = await runGrindSession(12, { "model.commandChurnGuard.threshold": 10 });

		expect(contexts).toHaveLength(13);
		// Fired at the end of the 10th grind turn: visible to model call 11 (index 10), not before.
		expect(JSON.stringify(contexts[9]!.messages)).not.toContain("command_churn_detected");
		expect(JSON.stringify(contexts[10]!.messages)).toContain("command_churn_detected");

		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.display).toBe(false);
		const content = JSON.stringify(redirects[0]!.content);
		expect(content).toContain("ego-browser nodejs <<'EOF'");
		expect(content).toContain("10");

		const findings = session!.healthLedger.findings().filter(finding => finding.rule === "command-churn");
		expect(findings).toHaveLength(1);
		expect(findings[0]!.severity).toBe("info");
		expect(findings[0]!.details).toMatchObject({ prefix: "ego-browser nodejs <<'EOF'", count: 10 });
	});

	it("stays inert when disabled", async () => {
		const { contexts, redirects } = await runGrindSession(12, {
			"model.commandChurnGuard.enabled": false,
			"model.commandChurnGuard.threshold": 10,
		});

		expect(contexts).toHaveLength(13);
		expect(redirects).toHaveLength(0);
		expect(JSON.stringify(contexts[12]!.messages)).not.toContain("command_churn_detected");
		expect(session!.healthLedger.findings().some(finding => finding.rule === "command-churn")).toBe(false);
	});
});
