/**
 * Contract tests for the evidence corpus compiler (`health/evidence`):
 * honest L1 baseline placeholder (thin data never fabricates trends), L2
 * deep-dive selection (healthy sessions excluded), L3 citation integrity
 * (every claim ref resolves to an appendix entry), and determinism.
 */
import { describe, expect, test } from "bun:test";
import type { HealthSignalStat } from "@oh-my-pi/omp-stats";
import { compileEvidenceReport, type EvidenceSessionBundle } from "@oh-my-pi/pi-coding-agent/health/evidence";
import type { StageTimingsRow } from "@oh-my-pi/pi-coding-agent/health/stages";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_TS = 1_750_000_000_000;

function bundle(index: number, overrides: Partial<EvidenceSessionBundle> = {}): EvidenceSessionBundle {
	return {
		sessionId: `session-${index}`,
		filePath: `/tmp/sessions/session-${index}.jsonl`,
		findings: [],
		stageRows: [],
		outbound: [],
		healthSignals: [],
		...overrides,
	};
}

function stageItem(entryIndex: number, row: Partial<StageTimingsRow> = {}) {
	return {
		row: { ts: BASE_TS, turnMs: 1000, provider: { ttfbMs: 500, streamMs: 400 }, ...row },
		entryIndex,
	};
}

function warnFinding(rule = "error-turns", message = "2 failed assistant turns") {
	return { finding: { rule, severity: "warn" as const, message }, entryIndex: 0 };
}

function signal(sessionFile: string, timestamp: number, value = 1): HealthSignalStat {
	return { sessionFile, timestamp, signal: "edit_rejections", model: "model-a", value };
}

describe("L1 baseline placeholder", () => {
	test("data spanning under 7 days emits the placeholder even with health signals", () => {
		const b = bundle(1, {
			stageRows: [stageItem(3), stageItem(4, { ts: BASE_TS + 2 * DAY_MS })],
			healthSignals: [signal("/tmp/sessions/session-1.jsonl", BASE_TS)],
		});
		const report = compileEvidenceReport([b]);
		expect(report).toContain("insufficient baseline: 2 days of data; trends omitted");
		expect(report).not.toContain("first half vs second half");
	});

	test("empty health signals emit the placeholder even when the span is long", () => {
		const a = bundle(1, { stageRows: [stageItem(3)] });
		const b = bundle(2, { stageRows: [stageItem(3, { ts: BASE_TS + 10 * DAY_MS })] });
		const report = compileEvidenceReport([a, b]);
		expect(report).toContain("insufficient baseline: 10 days of data; trends omitted");
		expect(report).not.toContain("first half vs second half");
	});

	test("long span with signals emits a computed trend line instead of the placeholder", () => {
		const a = bundle(1, {
			findings: [warnFinding()],
			stageRows: [stageItem(3)],
			healthSignals: [signal("/tmp/sessions/session-1.jsonl", BASE_TS)],
		});
		const b = bundle(2, {
			stageRows: [stageItem(3, { ts: BASE_TS + 10 * DAY_MS })],
			healthSignals: [signal("/tmp/sessions/session-2.jsonl", BASE_TS + 10 * DAY_MS)],
		});
		const report = compileEvidenceReport([a, b]);
		expect(report).not.toContain("insufficient baseline");
		expect(report).toContain("warn findings, first half vs second half of span: 1 → 0 (improving)");
	});
});

describe("L2 selection", () => {
	test("healthy session is excluded; warn session gets a deep-dive", () => {
		const healthy = bundle(1, { stageRows: [stageItem(3)] });
		const warned = bundle(2, { findings: [warnFinding()], stageRows: [stageItem(3)] });
		const report = compileEvidenceReport([healthy, warned]);
		expect(report).not.toContain("### s1 — session session-1");
		expect(report).toContain("### s2 — session session-2");
		expect(report).toContain("1 warn finding(s)");
	});

	test("stage p95 at 2x the batch median selects a session without warn findings", () => {
		const inputs = [
			bundle(1, { stageRows: [stageItem(3, { provider: { streamMs: 100 } })] }),
			bundle(2, { stageRows: [stageItem(3, { provider: { streamMs: 110 } })] }),
			bundle(3, { stageRows: [stageItem(3, { provider: { streamMs: 1000 } })] }),
		];
		const report = compileEvidenceReport(inputs);
		expect(report).not.toContain("### s1 —");
		expect(report).not.toContain("### s2 —");
		expect(report).toContain("### s3 — session session-3");
		expect(report).toContain("provider stream p95 1,000ms ≥ 2× batch median");
	});

	test("no qualifying session collapses L2 to the explicit empty line", () => {
		const report = compileEvidenceReport([bundle(1, { stageRows: [stageItem(3)] })]);
		expect(report).toContain("No session met the deep-dive bar");
	});
});

describe("L3 citation integrity", () => {
	test("every L2 claim ref resolves to an appendix entry mapping label to file path", () => {
		const warned = bundle(1, {
			findings: [
				warnFinding(),
				{ finding: { rule: "model-switch", severity: "info" as const, message: "2 models" }, entryIndex: 0 },
			],
			stageRows: [
				stageItem(5, { turnMs: 500 }),
				stageItem(9, { ts: BASE_TS + 60_000, turnMs: 5000, provider: { streamMs: 4500 } }),
			],
			outbound: [
				{
					summary: {
						timestamp: BASE_TS,
						model: "model-a",
						systemPromptChars: 100,
						systemPromptSections: [],
						messageCount: 1,
						messageChars: 10,
						toolCount: 0,
						toolNames: [],
					},
					entryIndex: 4,
				},
				{
					summary: {
						timestamp: BASE_TS + 30_000,
						model: "model-b",
						systemPromptChars: 100,
						systemPromptSections: [],
						messageCount: 2,
						messageChars: 20,
						toolCount: 0,
						toolNames: [],
					},
					entryIndex: 8,
				},
			],
		});
		const report = compileEvidenceReport([warned, bundle(2, { stageRows: [stageItem(3)] })]);

		const l2 = report.slice(report.indexOf("## L2"), report.indexOf("## L3"));
		const appendix = report.slice(report.indexOf("## L3"));
		const refs = [...l2.matchAll(/\[(s\d+):(\d+)\]/g)];
		expect(refs.length).toBeGreaterThan(2);
		for (const [, label] of refs) {
			expect(appendix).toContain(`- ${label} — `);
		}
		// Every claim bullet in L2 carries a citation.
		const claims = l2.split("\n").filter(line => line.startsWith("- "));
		expect(claims.length).toBeGreaterThan(0);
		for (const claim of claims) {
			expect(claim).toMatch(/\[s\d+:\d+\]$/);
		}
		// Refs cite the exact source entries the bundle recorded.
		expect(l2).toContain("[s1:9]"); // outlier turn's stage_timings entry
		expect(l2).toContain("[s1:8]"); // outbound diff's outbound_summary entry
		expect(appendix).toContain("`/tmp/sessions/session-1.jsonl`");
	});
});

describe("determinism", () => {
	test("identical inputs compile to byte-identical reports", () => {
		const inputs = [
			bundle(1, {
				findings: [warnFinding()],
				stageRows: [stageItem(3), stageItem(7, { ts: BASE_TS + 90_000, turnMs: 9000 })],
				healthSignals: [signal("/tmp/sessions/session-1.jsonl", BASE_TS)],
			}),
			bundle(2, { stageRows: [stageItem(3)] }),
		];
		expect(compileEvidenceReport(inputs)).toBe(compileEvidenceReport(inputs));
	});
});
