import { beforeAll, describe, expect, it } from "bun:test";
import {
	detectDuplicateDeviceRoutes,
	detectPromptSizeJump,
	detectSilentModelSwitch,
	formatHealthBadge,
	formatSessionEndHealthSummary,
	HEALTH_RULES,
	recordHealthFinding,
} from "@oh-my-pi/pi-coding-agent/health/guards";
import { HealthLedger } from "@oh-my-pi/pi-coding-agent/health/ledger";
import { SEGMENTS } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/** Minimal segment context: the health segment only reads `session.healthLedger`. */
function contextWithSession(session: unknown): SegmentContext {
	return { session } as unknown as SegmentContext;
}

describe("prompt-size-jump threshold", () => {
	it("never fires on the first rebuild (no baseline)", () => {
		expect(detectPromptSizeJump(undefined, 50_000)).toBeNull();
	});

	it("does not fire at a 24% change", () => {
		expect(detectPromptSizeJump(10_000, 12_400)).toBeNull();
		expect(detectPromptSizeJump(10_000, 7_600)).toBeNull();
	});

	it("does not fire at exactly 25% (strictly-greater contract)", () => {
		expect(detectPromptSizeJump(10_000, 12_500)).toBeNull();
		expect(detectPromptSizeJump(10_000, 7_500)).toBeNull();
	});

	it("fires at a 26% growth", () => {
		const jump = detectPromptSizeJump(10_000, 12_600);
		expect(jump).not.toBeNull();
		expect(jump?.direction).toBe("grew");
		expect(jump?.ratio).toBeCloseTo(0.26, 5);
		expect(jump?.previousChars).toBe(10_000);
		expect(jump?.currentChars).toBe(12_600);
	});

	it("fires at a 26% shrink", () => {
		const jump = detectPromptSizeJump(10_000, 7_400);
		expect(jump?.direction).toBe("shrank");
		expect(jump?.ratio).toBeCloseTo(0.26, 5);
	});

	it("treats a zero-char baseline as no baseline", () => {
		expect(detectPromptSizeJump(0, 10_000)).toBeNull();
	});
});

describe("duplicate-device-routes detection", () => {
	it("reports nothing for distinct routes", () => {
		const routes = [
			{ name: "mcp__alpha_search", mcpServerName: "alpha", mcpToolName: "search" },
			{ name: "mcp__alpha_fetch", mcpServerName: "alpha", mcpToolName: "fetch" },
			{ name: "mcp__beta_write", mcpServerName: "beta", mcpToolName: "write" },
		];
		expect(detectDuplicateDeviceRoutes(routes)).toEqual([]);
	});

	it("flags two device names aliasing the same server/tool identity", () => {
		const routes = [
			{ name: "mcp__alpha_search", mcpServerName: "alpha", mcpToolName: "search" },
			{ name: "mcp__alpha_search_2", mcpServerName: "alpha", mcpToolName: "search" },
		];
		const duplicates = detectDuplicateDeviceRoutes(routes);
		expect(duplicates).toHaveLength(1);
		expect(duplicates[0].kind).toBe("identity");
		expect(duplicates[0].key).toBe("alpha/search");
		expect(duplicates[0].names.sort()).toEqual(["mcp__alpha_search", "mcp__alpha_search_2"]);
	});

	it("flags the same original tool name mounted from different servers", () => {
		const routes = [
			{ name: "mcp__alpha_search", mcpServerName: "alpha", mcpToolName: "search" },
			{ name: "mcp__beta_search", mcpServerName: "beta", mcpToolName: "search" },
		];
		const duplicates = detectDuplicateDeviceRoutes(routes);
		expect(duplicates).toHaveLength(1);
		expect(duplicates[0].kind).toBe("tool-name");
		expect(duplicates[0].key).toBe("search");
	});

	it("does not double-report an identity alias as a tool-name collision", () => {
		const routes = [
			{ name: "mcp__alpha_search", mcpServerName: "alpha", mcpToolName: "search" },
			{ name: "mcp__alpha_search_2", mcpServerName: "alpha", mcpToolName: "search" },
		];
		expect(detectDuplicateDeviceRoutes(routes).map(dup => dup.kind)).toEqual(["identity"]);
	});

	it("ignores repeated observations of the same mounted name", () => {
		const route = { name: "mcp__alpha_search", mcpServerName: "alpha", mcpToolName: "search" };
		expect(detectDuplicateDeviceRoutes([route, route])).toEqual([]);
	});
});

describe("silent-model-switch detection", () => {
	const anthropic = { provider: "anthropic", id: "claude-4" };

	it("fires when the answering model differs from the configured one", () => {
		const detected = detectSilentModelSwitch(anthropic, anthropic, { provider: "anthropic", id: "claude-3" });
		expect(detected).toEqual({ configured: "anthropic/claude-4", answered: "anthropic/claude-3" });
	});

	it("fires on a provider mismatch even with an identical id", () => {
		const detected = detectSilentModelSwitch(anthropic, anthropic, { provider: "bedrock", id: "claude-4" });
		expect(detected?.answered).toBe("bedrock/claude-4");
	});

	it("stays silent when a visible model change landed during the turn", () => {
		const switched = { provider: "openai", id: "gpt-5" };
		expect(detectSilentModelSwitch(anthropic, switched, { provider: "anthropic", id: "claude-4" })).toBeNull();
	});

	it("tolerates date-stamped snapshot aliases of the configured id", () => {
		const configured = { provider: "openai", id: "gpt-4o" };
		expect(
			detectSilentModelSwitch(configured, configured, { provider: "openai", id: "gpt-4o-2024-08-06" }),
		).toBeNull();
	});

	it("does not treat a variant suffix as a snapshot alias", () => {
		const configured = { provider: "openai", id: "gpt-5" };
		const detected = detectSilentModelSwitch(configured, configured, { provider: "openai", id: "gpt-5-mini" });
		expect(detected?.answered).toBe("openai/gpt-5-mini");
	});

	it("stays silent without a turn-start snapshot", () => {
		expect(detectSilentModelSwitch(undefined, anthropic, { provider: "anthropic", id: "claude-3" })).toBeNull();
	});
});

describe("health badge formatting", () => {
	it("returns the heartbeat glyph for an empty ledger", () => {
		expect(formatHealthBadge({ info: 0, warn: 0 })).toBe("✓");
	});

	it("renders the warn count with the warning glyph", () => {
		expect(formatHealthBadge({ info: 0, warn: 2 })).toBe("⚠2");
	});

	it("falls back to the info count for info-only ledgers", () => {
		expect(formatHealthBadge({ info: 3, warn: 0 })).toBe("·3");
	});

	it("prefers warn over info when both exist", () => {
		expect(formatHealthBadge({ info: 5, warn: 1 })).toBe("⚠1");
	});
});

describe("recordHealthFinding deferred warn notice", () => {
	it("queues one notice when a rule first reaches warn, then stays silent", () => {
		const ledger = new HealthLedger();
		const input = {
			rule: HEALTH_RULES.promptSizeJump,
			severity: "warn",
			message: "system prompt shrank 40% between rebuilds",
		} as const;
		recordHealthFinding(ledger, input);
		recordHealthFinding(ledger, input);
		expect(ledger.drainNotices()).toEqual(["system prompt shrank 40% between rebuilds"]);
		// Draining empties the queue; the findings keep accumulating.
		expect(ledger.drainNotices()).toEqual([]);
		expect(ledger.findings()).toHaveLength(1);
		expect(ledger.findings()[0].occurrences).toBe(2);
	});

	it("queues nothing for info findings", () => {
		const ledger = new HealthLedger();
		recordHealthFinding(ledger, {
			rule: HEALTH_RULES.silentModelSwitch,
			severity: "info",
			message: "answered by another model",
		});
		expect(ledger.drainNotices()).toEqual([]);
		expect(ledger.counts()).toEqual({ info: 1, warn: 0 });
	});
});

describe("session-end health summary", () => {
	it("renders nothing without warn findings", () => {
		expect(formatSessionEndHealthSummary({ info: 0, warn: 0 })).toBeNull();
		expect(formatSessionEndHealthSummary({ info: 4, warn: 0 })).toBeNull();
	});

	it("summarizes warn findings with the doctor hint", () => {
		expect(formatSessionEndHealthSummary({ info: 0, warn: 2 })).toBe(
			"health: 2 warnings — run omp doctor for details",
		);
		expect(formatSessionEndHealthSummary({ info: 1, warn: 1 })).toBe(
			"health: 1 warning — run omp doctor for details",
		);
	});
});

describe("health status-line segment", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the theme's health shield for an empty ledger (healthy ≠ monitor-off)", () => {
		const rendered = SEGMENTS.health.render(contextWithSession({ healthLedger: new HealthLedger() }));
		expect(rendered.visible).toBe(true);
		expect(theme.icon.health.length).toBeGreaterThan(0);
		expect(rendered.content).toContain(theme.icon.health);
	});

	it("renders nothing when the session exposes no ledger", () => {
		const rendered = SEGMENTS.health.render(contextWithSession({}));
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("renders the warn badge once findings exist", () => {
		const ledger = new HealthLedger();
		ledger.add({ rule: "prompt-size-jump", severity: "warn", message: "prompt shrank" });
		const rendered = SEGMENTS.health.render(contextWithSession({ healthLedger: ledger }));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("⚠1");
	});

	it("renders the info badge for info-only ledgers", () => {
		const ledger = new HealthLedger();
		ledger.add({ rule: "silent-model-switch", severity: "info", message: "answered by another model" });
		const rendered = SEGMENTS.health.render(contextWithSession({ healthLedger: ledger }));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("·1");
	});
});
