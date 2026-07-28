/**
 * Contract tests for the behavioral health telemetry primitives that feed the
 * `health_signals` stats table: sliding-window repeat-read detection,
 * intent-fill (`i` field) accumulation, and the pre-execution validation
 * failure marker shared with pi-ai's `validateToolArguments`.
 */
import { describe, expect, it } from "bun:test";
import {
	accumulateIntentFill,
	countRepeatReads,
	hasNonEmptyIntent,
	REPEAT_READ_THRESHOLD,
	REPEAT_READ_WINDOW,
	VALIDATION_FAILURE_PREFIX,
} from "@oh-my-pi/omp-stats/health-signals";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";

describe("countRepeatReads sliding window", () => {
	it("counts one incident when a key reaches the threshold inside the window", () => {
		expect(countRepeatReads(["a.ts", "a.ts", "a.ts"])).toBe(1);
	});

	it("stays quiet below the threshold", () => {
		expect(countRepeatReads(["a.ts", "a.ts"])).toBe(0);
		expect(countRepeatReads([])).toBe(0);
	});

	it("does not double count further reads while the key stays hot in the window", () => {
		expect(countRepeatReads(["a.ts", "a.ts", "a.ts", "a.ts", "a.ts"])).toBe(1);
	});

	it("interleaved other tool calls do not break a burst that fits the window", () => {
		expect(countRepeatReads(["a.ts", null, "b.ts", "a.ts", null, "a.ts"])).toBe(1);
	});

	it("ignores repeats spread wider than the window", () => {
		const gap: (string | null)[] = Array.from({ length: REPEAT_READ_WINDOW - 1 }, () => null);
		// Each read is REPEAT_READ_WINDOW calls after the previous one, so at
		// most one prior occurrence is ever inside the trailing window.
		const keys = ["a.ts", ...gap, "a.ts", ...gap, "a.ts"];
		expect(countRepeatReads(keys)).toBe(0);
	});

	it("counts a fresh incident after the window evicts the earlier burst", () => {
		const gap: (string | null)[] = Array.from({ length: REPEAT_READ_WINDOW }, () => null);
		const burst = Array.from({ length: REPEAT_READ_THRESHOLD }, () => "a.ts");
		expect(countRepeatReads([...burst, ...gap, ...burst])).toBe(2);
	});

	it("dedups by path+selector: distinct selectors never merge", () => {
		expect(countRepeatReads(["f.ts:1-10", "f.ts:20-30", "f.ts:1-10", "f.ts:20-30"])).toBe(0);
		expect(countRepeatReads(["f.ts:1-10", "f.ts:20-30", "f.ts:1-10", "f.ts:1-10"])).toBe(1);
	});

	it("honors explicit window and threshold overrides", () => {
		expect(countRepeatReads(["a", "a"], 2, 2)).toBe(1);
		// The second read lands exactly as the first is evicted from a 2-call window.
		expect(countRepeatReads(["a", null, "a"], 2, 2)).toBe(0);
		expect(countRepeatReads(["a", "a", "a"], 0, 2)).toBe(0);
	});
});

describe("intent fill accumulation", () => {
	it("recognizes only non-empty string intents", () => {
		expect(hasNonEmptyIntent({ i: "Reading config" })).toBe(true);
		expect(hasNonEmptyIntent({ i: "" })).toBe(false);
		expect(hasNonEmptyIntent({ i: "   " })).toBe(false);
		expect(hasNonEmptyIntent({ i: 42 })).toBe(false);
		expect(hasNonEmptyIntent({ path: "a.ts" })).toBe(false);
		expect(hasNonEmptyIntent(undefined)).toBe(false);
		expect(hasNonEmptyIntent(null)).toBe(false);
		expect(hasNonEmptyIntent("i")).toBe(false);
	});

	it("accumulates a running numerator/denominator across turns", () => {
		const zero = { filled: 0, total: 0 };
		const afterTurn1 = accumulateIntentFill(zero, [{ i: "Grepping usages" }, { path: "b.ts" }]);
		expect(afterTurn1).toEqual({ filled: 1, total: 2 });
		const afterTurn2 = accumulateIntentFill(afterTurn1, [{ i: "Editing parser" }]);
		expect(afterTurn2).toEqual({ filled: 2, total: 3 });
		// Input accumulator is never mutated.
		expect(zero).toEqual({ filled: 0, total: 0 });
		expect(accumulateIntentFill(afterTurn2, [])).toEqual(afterTurn2);
	});
});

describe("validation failure marker", () => {
	it("matches the header pi-ai's validateToolArguments actually throws", () => {
		const tool: Tool = {
			name: "probe",
			description: "",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		};
		let thrown: unknown;
		try {
			validateToolArguments(tool, { type: "toolCall", id: "call-1", name: "probe", arguments: {} });
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message.startsWith(VALIDATION_FAILURE_PREFIX)).toBe(true);
		expect(message).toContain('"probe"');
	});
});
