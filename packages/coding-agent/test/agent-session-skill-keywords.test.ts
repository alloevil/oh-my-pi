import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel, type TextContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { WORKFLOW_NOTICE } from "@oh-my-pi/pi-coding-agent/modes/workflow";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	convertToLlm,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type ObservedSkillTurn = {
	texts: string[];
};

describe("AgentSession skill prompt keyword steering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	let holdFirstTurn = false;
	let finishHeldTurn: (() => void) | undefined;
	let heldTurnStarted: PromiseWithResolvers<void> | undefined;
	let secondTurnObserved: PromiseWithResolvers<void> | undefined;
	const observedTurns: ObservedSkillTurn[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-skill-keywords-");
		observedTurns.length = 0;
		holdFirstTurn = false;
		finishHeldTurn = undefined;
		heldTurnStarted = undefined;
		secondTurnObserved = undefined;

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: (_model, context) => {
				const turnIndex = observedTurns.length;
				observedTurns.push({
					texts: context.messages.map(message => {
						const content = message.content;
						if (typeof content === "string") return content;
						if (!Array.isArray(content)) return "";
						return content
							.filter((block): block is TextContent => block.type === "text")
							.map(block => block.text)
							.join("\n");
					}),
				});
				if (turnIndex === 1) {
					secondTurnObserved?.resolve();
				}
				const stream = new AssistantMessageEventStream();
				if (holdFirstTurn && turnIndex === 0) {
					queueMicrotask(() => {
						const response = createAssistantMessage("waiting");
						stream.push({ type: "start", partial: response });
						heldTurnStarted?.resolve();
					});
					finishHeldTurn = () => {
						const response = createAssistantMessage("done");
						stream.push({ type: "done", reason: "stop", message: response });
					};
					return stream;
				}
				queueMicrotask(() => {
					const response = createAssistantMessage("done");
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("injects magic keyword notices and turn budgets from user-authored skill args", async () => {
		const skillPath = path.join(tempDir.path(), "deep-research.md");
		const details: SkillPromptDetails = {
			name: "deep-research",
			path: skillPath,
			args: "workflowz +500k! compare these approaches",
			lineCount: 1,
		};
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: `Skill body\n\n---\n\nSkill: ${skillPath}\nUser: ${details.args}`,
			display: true,
			details,
			attribution: "user",
		});

		expect(observedTurns).toHaveLength(1);
		const observedTurn = observedTurns[0];
		if (!observedTurn) throw new Error("Expected prompt context to be captured");
		expect(observedTurn.texts).toContain(`Skill body\n\n---\n\nSkill: ${skillPath}\nUser: ${details.args}`);
		expect(observedTurn.texts).toContain(WORKFLOW_NOTICE);
		expect(session.sessionManager.getTurnBudget()).toEqual({ total: 500_000, spent: 0, hard: true });
	});

	it("groups queued skill keyword notices with the streaming skill prompt", async () => {
		holdFirstTurn = true;
		heldTurnStarted = Promise.withResolvers<void>();
		secondTurnObserved = Promise.withResolvers<void>();
		const firstPrompt = session.prompt("initial request");
		await heldTurnStarted.promise;

		const skillPath = path.join(tempDir.path(), "deep-research.md");
		const details: SkillPromptDetails = {
			name: "deep-research",
			path: skillPath,
			args: "workflowz compare these approaches",
			lineCount: 1,
		};
		await session.promptCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: `Skill body\n\n---\n\nSkill: ${skillPath}\nUser: ${details.args}`,
				display: true,
				details,
				attribution: "user",
			},
			{ streamingBehavior: "steer" },
		);

		finishHeldTurn?.();
		await secondTurnObserved.promise;
		await session.waitForIdle();
		await firstPrompt;

		const queuedSkillTurn = observedTurns[1];
		if (!queuedSkillTurn) throw new Error("Expected queued skill turn to be captured");
		expect(queuedSkillTurn.texts).toContain(`Skill body\n\n---\n\nSkill: ${skillPath}\nUser: ${details.args}`);
		expect(queuedSkillTurn.texts).toContain(WORKFLOW_NOTICE);
	});
});
