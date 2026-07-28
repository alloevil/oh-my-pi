import { describe, expect, test } from "bun:test";
import {
	collectStageTimings,
	parseStageTimingsRow,
	renderStagesReport,
	STAGE_TIMINGS_CUSTOM_TYPE,
	StageTimingsRecorder,
	type StageTimingsRow,
	stagePercentile,
	summarizeStageTimings,
} from "@oh-my-pi/pi-coding-agent/health/stages";
import type { CustomEntry, FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";

/** Manual clock: tests advance `now` between recorder calls. */
function fakeClock(start = 1_000_000) {
	const state = { now: start };
	return { state, now: () => state.now };
}

function row(overrides: Partial<StageTimingsRow> = {}): StageTimingsRow {
	return { ts: 1, turnMs: 100, provider: { ttfbMs: 500, streamMs: 2000 }, ...overrides };
}

describe("stagePercentile", () => {
	test("single sample is every percentile", () => {
		expect(stagePercentile([42], 50)).toBe(42);
		expect(stagePercentile([42], 95)).toBe(42);
	});

	test("odd sample count picks the middle for p50", () => {
		expect(stagePercentile([1, 2, 3, 4, 5], 50)).toBe(3);
		expect(stagePercentile([1, 2, 3, 4, 5], 95)).toBe(5);
	});

	test("even sample count picks the lower-middle for p50 (nearest rank)", () => {
		expect(stagePercentile([1, 2, 3, 4], 50)).toBe(2);
		expect(stagePercentile([1, 2, 3, 4], 95)).toBe(4);
	});

	test("empty samples yield 0", () => {
		expect(stagePercentile([], 50)).toBe(0);
	});

	test("p95 over 100 samples excludes the top 5", () => {
		const values = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(stagePercentile(values, 95)).toBe(95);
	});
});

describe("StageTimingsRecorder", () => {
	test("records a complete turn: context, provider, tools", () => {
		const clock = fakeClock();
		const recorder = new StageTimingsRecorder(clock.now);
		recorder.onTransformStart();
		clock.state.now += 12;
		recorder.onTransformEnd(48_000);
		clock.state.now += 850;
		recorder.onAssistantMessageStart();
		clock.state.now += 3200;
		recorder.onAssistantMessageEnd();
		recorder.onToolExecutionStart("call-1", "read");
		clock.state.now += 40;
		recorder.onToolExecutionEnd("call-1", false);
		recorder.onToolExecutionStart("call-2", "bash");
		clock.state.now += 900;
		recorder.onToolExecutionEnd("call-2", true);
		const result = recorder.onTurnEnd();
		expect(result).toEqual({
			ts: 1_000_000,
			turnMs: 12 + 850 + 3200 + 40 + 900,
			context: { transformMs: 12, promptChars: 48_000 },
			provider: { ttfbMs: 850, streamMs: 3200 },
			tools: [
				{ name: "read", ms: 40 },
				{ name: "bash", ms: 900, error: true },
			],
		});
	});

	test("aborted turn without message events produces a partial context-only row", () => {
		const clock = fakeClock();
		const recorder = new StageTimingsRecorder(clock.now);
		recorder.onTransformStart();
		clock.state.now += 8;
		recorder.onTransformEnd();
		clock.state.now += 100;
		const result = recorder.onTurnEnd();
		expect(result).toEqual({ ts: 1_000_000, turnMs: 108, context: { transformMs: 8 } });
	});

	test("turn with no clock points flushes nothing", () => {
		const recorder = new StageTimingsRecorder(fakeClock().now);
		expect(recorder.onTurnEnd()).toBeUndefined();
		// Message/tool events without an open turn are ignored, not recorded.
		recorder.onAssistantMessageStart();
		recorder.onAssistantMessageEnd();
		recorder.onToolExecutionEnd("ghost", false);
		expect(recorder.onTurnEnd()).toBeUndefined();
	});

	test("a second transform in one turn counts as a retry and keeps the first ttfb", () => {
		const clock = fakeClock();
		const recorder = new StageTimingsRecorder(clock.now);
		recorder.onTransformStart();
		clock.state.now += 10;
		recorder.onTransformEnd();
		clock.state.now += 200;
		recorder.onAssistantMessageStart();
		clock.state.now += 50;
		recorder.onAssistantMessageEnd();
		// Retry: transform runs again within the same turn.
		recorder.onTransformStart();
		clock.state.now += 5;
		recorder.onTransformEnd();
		clock.state.now += 300;
		recorder.onAssistantMessageEnd();
		const result = recorder.onTurnEnd(true);
		expect(result?.context?.transformMs).toBe(15);
		expect(result?.provider).toEqual({ ttfbMs: 200, streamMs: 50 + 5 + 300, retries: 1, error: true });
	});

	test("reset discards the open turn", () => {
		const clock = fakeClock();
		const recorder = new StageTimingsRecorder(clock.now);
		recorder.onTransformStart();
		clock.state.now += 10;
		recorder.onTransformEnd();
		recorder.reset();
		expect(recorder.onTurnEnd()).toBeUndefined();
	});

	test("a tool that never ends is dropped, finished tools are kept", () => {
		const clock = fakeClock();
		const recorder = new StageTimingsRecorder(clock.now);
		recorder.onToolExecutionStart("call-1", "bash");
		recorder.onToolExecutionStart("call-2", "read");
		clock.state.now += 30;
		recorder.onToolExecutionEnd("call-2", false);
		const result = recorder.onTurnEnd();
		expect(result?.tools).toEqual([{ name: "read", ms: 30 }]);
	});

	test("captures the streaming model at first attributable message_start; retries keep the first", () => {
		const clock = fakeClock();
		const recorder = new StageTimingsRecorder(clock.now);
		recorder.onTransformStart();
		clock.state.now += 10;
		recorder.onTransformEnd();
		clock.state.now += 100;
		// An empty model id is unattributable and must not claim the slot.
		recorder.onAssistantMessageStart("");
		clock.state.now += 50;
		recorder.onAssistantMessageEnd();
		recorder.onTransformStart();
		clock.state.now += 5;
		recorder.onTransformEnd();
		recorder.onAssistantMessageStart("model-a");
		clock.state.now += 20;
		recorder.onAssistantMessageEnd();
		// A further retry with a different model keeps the first attribution.
		recorder.onAssistantMessageStart("model-b");
		const row = recorder.onTurnEnd();
		expect(row?.model).toBe("model-a");
	});
});

describe("parseStageTimingsRow / collectStageTimings", () => {
	function entriesWith(rows: unknown[]): FileEntry[] {
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "stages-test",
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp/stages-test",
		};
		const entries: FileEntry[] = [header];
		for (let index = 0; index < rows.length; index++) {
			const entry: CustomEntry = {
				type: "custom",
				customType: STAGE_TIMINGS_CUSTOM_TYPE,
				data: rows[index],
				id: `entry-${index}`,
				parentId: null,
				timestamp: new Date(index).toISOString(),
			};
			entries.push(entry);
		}
		return entries;
	}

	test("keeps only the trailing rows past the cap", () => {
		const rows = Array.from({ length: 6 }, (_, i) => row({ ts: i + 1 }));
		const kept = collectStageTimings(entriesWith(rows), 4);
		expect(kept.length).toBe(4);
		expect(kept[0].ts).toBe(3);
		expect(kept[3].ts).toBe(6);
	});

	test("ignores malformed payloads and unrelated custom entries", () => {
		const entries = entriesWith([row({ ts: 7 }), { nonsense: true }, { ts: "later" }, null]);
		entries.push({
			type: "custom",
			customType: "unrelated",
			data: row(),
			id: "other",
			parentId: null,
			timestamp: new Date(0).toISOString(),
		} as CustomEntry);
		const kept = collectStageTimings(entries);
		expect(kept.length).toBe(1);
		expect(kept[0].ts).toBe(7);
	});

	test("tolerates partial rows and drops invalid tool entries", () => {
		const parsed = parseStageTimingsRow({
			ts: 5,
			context: { transformMs: 3 },
			tools: [{ name: "bash", ms: 10 }, { name: 42, ms: 10 }, { name: "read" }],
		});
		expect(parsed).toEqual({ ts: 5, turnMs: 0, context: { transformMs: 3 }, tools: [{ name: "bash", ms: 10 }] });
	});

	test("parses the model field and tolerates rows without one (old sessions)", () => {
		expect(parseStageTimingsRow({ ts: 5, turnMs: 9, model: "claude-fable-5", provider: { ttfbMs: 10 } })).toEqual({
			ts: 5,
			turnMs: 9,
			model: "claude-fable-5",
			provider: { ttfbMs: 10 },
		});
		expect(parseStageTimingsRow({ ts: 5, turnMs: 9, provider: { ttfbMs: 10 } })?.model).toBeUndefined();
		// Non-string / empty model values are dropped, not propagated.
		expect(parseStageTimingsRow({ ts: 5, turnMs: 9, model: 42, provider: { ttfbMs: 10 } })?.model).toBeUndefined();
		expect(parseStageTimingsRow({ ts: 5, turnMs: 9, model: "", provider: { ttfbMs: 10 } })?.model).toBeUndefined();
	});

	test("a row with a timestamp but no stages is malformed", () => {
		expect(parseStageTimingsRow({ ts: 5, turnMs: 100 })).toBeUndefined();
		expect(parseStageTimingsRow("nope")).toBeUndefined();
	});
});

describe("summarizeStageTimings", () => {
	test("aggregates per-stage samples and counts errors", () => {
		const rows: StageTimingsRow[] = [
			row({
				context: { transformMs: 10 },
				provider: { ttfbMs: 100, streamMs: 1000 },
				tools: [{ name: "bash", ms: 50, error: true }],
			}),
			row({
				context: { transformMs: 20 },
				provider: { ttfbMs: 300, streamMs: 3000, error: true },
				tools: [
					{ name: "read", ms: 10 },
					{ name: "edit", ms: 30, error: true },
				],
			}),
			// Partial row: aborted before the provider answered.
			row({ context: { transformMs: 30 }, provider: undefined }),
		];
		const summary = summarizeStageTimings(rows);
		expect(summary.turns).toBe(3);
		expect(summary.contextTransform).toEqual({ count: 3, p50: 20, p95: 30, max: 30, errors: 0 });
		expect(summary.providerTtfb).toEqual({ count: 2, p50: 100, p95: 300, max: 300, errors: 0 });
		expect(summary.providerStream).toEqual({ count: 2, p50: 1000, p95: 3000, max: 3000, errors: 1 });
		expect(summary.toolExecution).toEqual({ count: 3, p50: 30, p95: 50, max: 50, errors: 2 });
	});

	test("empty rows produce zeroed stats", () => {
		const summary = summarizeStageTimings([]);
		expect(summary.turns).toBe(0);
		expect(summary.contextTransform).toEqual({ count: 0, p50: 0, p95: 0, max: 0, errors: 0 });
	});
});

describe("renderStagesReport", () => {
	test("zero rows collapse to the predates-tracking hint", () => {
		const rendered = renderStagesReport("sess-1", []);
		expect(rendered).toBe(
			"session sess-1: no stage timings recorded (session predates stage tracking or debug.stageTimings is off)\n",
		);
	});

	test("renders the summary table and slowest turns with dominant stage", () => {
		const rows: StageTimingsRow[] = [
			row({ ts: Date.UTC(2026, 6, 28, 10, 0, 0), provider: { ttfbMs: 500, streamMs: 9000 } }),
			row({
				ts: Date.UTC(2026, 6, 28, 10, 1, 0),
				provider: { ttfbMs: 400, streamMs: 100 },
				tools: [{ name: "bash", ms: 30_000 }],
			}),
		];
		const rendered = renderStagesReport("sess-1", rows);
		expect(rendered).toContain("stage timings for session sess-1 (last 2 turns");
		expect(rendered).toContain("context.transform");
		expect(rendered).toContain("provider.ttfb");
		expect(rendered).toContain("provider.stream");
		expect(rendered).toContain("tool.execution");
		expect(rendered).toContain("slowest turns:");
		const lines = rendered.split("\n");
		const slowestIndex = lines.indexOf("slowest turns:");
		// The tool-heavy turn (30.5s total) outranks the stream-heavy one (9.5s).
		expect(lines[slowestIndex + 2]).toContain("10:01:00");
		expect(lines[slowestIndex + 2]).toContain("tools");
		expect(lines[slowestIndex + 3]).toContain("10:00:00");
		expect(lines[slowestIndex + 3]).toContain("provider");
	});
});
