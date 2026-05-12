import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { LocalBackend } from "../../src/backend";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import type { TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { EventBus } from "../../src/utils/event-bus";

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

function createSession(
	overrides: Partial<Record<string, unknown>> = {},
	extras: Partial<ToolSession> = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(overrides),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		backend: new LocalBackend({ cwd: "/tmp" }),
		...extras,
	} as unknown as ToolSession;
}

function createYieldingAgentSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	const session = {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	};

	return session as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function getSchemaProperties(tool: TaskTool): Record<string, unknown> {
	return ((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
}

function getAssignmentDescription(tool: TaskTool): string {
	const properties = getSchemaProperties(tool);
	const tasks = properties.tasks as { items?: { properties?: Record<string, { description?: string }> } } | undefined;
	return tasks?.items?.properties?.assignment?.description ?? "";
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

describe("task.simple", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("removes only the custom schema input in schema-free mode", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession({ "task.simple": "schema-free" }));
		const properties = getSchemaProperties(tool);

		expect(properties.context).toBeDefined();
		expect(properties.schema).toBeUndefined();
		expect(tool.description).toContain("`context` or `assignment`");
		expect(tool.description).toContain("- `context`:");
		expect(tool.description).not.toContain("- `schema`:");
		expect(getAssignmentDescription(tool)).toContain("shared background belongs in `context`");
	});

	it("removes both context and schema inputs in independent mode", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession({ "task.simple": "independent" }));
		const properties = getSchemaProperties(tool);

		expect(properties.context).toBeUndefined();
		expect(properties.schema).toBeUndefined();
		expect(tool.description).toContain("each `assignment`");
		expect(tool.description).not.toContain("- `context`:");
		expect(tool.description).not.toContain("- `schema`:");
		expect(getAssignmentDescription(tool)).toContain("include any background that would otherwise live in `context`");
	});

	it("rejects direct schema and context fields when the mode disables them", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const schemaFreeTool = await TaskTool.create(createSession({ "task.simple": "schema-free" }));
		const schemaFreeResult = await schemaFreeTool.execute("tool-1", {
			agent: "task",
			schema: '{"properties":{"ok":{"type":"boolean"}}}',
			tasks: [{ id: "One", description: "label", assignment: "Do the thing." }],
		} as TaskParams);
		expect(getFirstText(schemaFreeResult)).toContain("does not accept `schema`");

		const independentTool = await TaskTool.create(createSession({ "task.simple": "independent" }));
		const independentResult = await independentTool.execute("tool-2", {
			agent: "task",
			context: "Shared background",
			tasks: [{ id: "Two", description: "label", assignment: "Do the independent thing." }],
		} as TaskParams);
		expect(getFirstText(independentResult)).toContain("does not accept `context`");
	});

	it("does not build a parent conversation markdown dump when IRC is enabled", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(createYieldingAgentSession()));
		const getCompactContext = vi.fn(() => "# Parent conversation dump");
		const tool = await TaskTool.create(
			createSession(
				{ "irc.enabled": true },
				{
					getCompactContext,
					authStorage: {} as AuthStorage,
					modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
				},
			),
		);

		const result = await tool.execute("tool-irc-context", {
			agent: "task",
			tasks: [{ id: "One", description: "label", assignment: "Do the thing." }],
		} as TaskParams);

		expect(getCompactContext).not.toHaveBeenCalled();
		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(result.details?.results[0]?.exitCode).toBe(0);
	});
});
