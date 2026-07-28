/**
 * End-to-end coverage for behavioral health signals: session JSONL →
 * `syncAllSessions` → `health_signals` rows → `readHealthSignals`.
 *
 * Signals are absolute per-session totals recomputed from the full transcript
 * on every pass, so the key contract beyond the counter math is idempotency:
 * incremental re-syncs REPLACE rows instead of accumulating deltas.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readHealthSignals, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import type { HealthSignalName } from "@oh-my-pi/omp-stats/health-signals";
import { VALIDATION_FAILURE_PREFIX } from "@oh-my-pi/omp-stats/health-signals";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-health-signals-");

const FOLDER_SLUG = "--tmp--health-signals";
const MODEL = "gpt-5.4";
const PROVIDER = "openai";

const TS1 = "2026-06-24T10:00:00.000Z";
const TS2 = "2026-06-24T10:05:00.000Z";
const TS3 = "2026-06-24T10:10:00.000Z";
const TS4 = "2026-06-24T10:15:00.000Z";

interface ToolCallBlock {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

function buildAssistantEntry(entryId: string, timestamp: string, toolCalls: ToolCallBlock[]) {
	return {
		type: "message",
		id: entryId,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "ok" },
				...toolCalls.map(call => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments })),
			],
			api: "openai-responses",
			provider: PROVIDER,
			model: MODEL,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			},
			stopReason: "toolUse",
			timestamp: Date.parse(timestamp),
			duration: 10,
			ttft: 5,
		},
	};
}

function buildToolResultEntry(
	entryId: string,
	parentId: string,
	timestamp: string,
	toolCallId: string,
	text: string,
	isError = false,
) {
	return {
		type: "message",
		id: entryId,
		parentId,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId,
			content: [{ type: "text", text }],
			isError,
			timestamp: Date.parse(timestamp),
		},
	};
}

async function writeSessionFile(fileName: string, entries: unknown[]): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), FOLDER_SLUG);
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const headerEntry = {
		type: "session",
		version: 3,
		id: "sess-health",
		timestamp: new Date().toISOString(),
		cwd: "/tmp/project",
	};
	const lines = [headerEntry, ...entries].map(entry => JSON.stringify(entry)).join("\n");
	await Bun.write(sessionFile, `${lines}\n`);
	return sessionFile;
}

/**
 * Fixture: turn 1 reads src/foo.ts twice (both with intents), turn 2 reads it
 * a third time (repeat-read incident, no intent) and lands a rejected edit,
 * turn 3's grep call is rejected at arg validation.
 */
function buildStandardEntries(): unknown[] {
	return [
		buildAssistantEntry("asst-1", TS1, [
			{ id: "call-1", name: "read", arguments: { i: "Reading foo", path: "src/foo.ts" } },
			{ id: "call-2", name: "read", arguments: { i: "Re-reading foo", path: "src/foo.ts" } },
		]),
		buildToolResultEntry("tr-1", "asst-1", TS1, "call-1", "1:export const foo = 1;"),
		buildToolResultEntry("tr-2", "asst-1", TS1, "call-2", "1:export const foo = 1;"),
		buildAssistantEntry("asst-2", TS2, [
			{ id: "call-3", name: "read", arguments: { path: "src/foo.ts" } },
			{ id: "call-4", name: "edit", arguments: { i: "Patching foo", input: "[src/foo.ts#AAAA]\nDEL 1" } },
		]),
		buildToolResultEntry("tr-3", "asst-2", TS2, "call-3", "1:export const foo = 1;"),
		buildToolResultEntry("tr-4", "asst-2", TS2, "call-4", "Stale tag: re-read the file and retry.", true),
		buildAssistantEntry("asst-3", TS3, [{ id: "call-5", name: "grep", arguments: {} }]),
		buildToolResultEntry(
			"tr-5",
			"asst-3",
			TS3,
			"call-5",
			`${VALIDATION_FAILURE_PREFIX}grep":\npattern must be a string`,
			true,
		),
	];
}

function signalValue(rows: { signal: HealthSignalName; value: number }[], signal: HealthSignalName): number {
	const row = rows.find(r => r.signal === signal);
	if (!row) throw new Error(`missing health signal row "${signal}"`);
	return row.value;
}

describe("health signals pipeline", () => {
	it("records per-session counters through the stats sync path", async () => {
		const sessionFile = await writeSessionFile("session.jsonl", buildStandardEntries());
		await syncAllSessions({ workers: 1 });

		const rows = await readHealthSignals(sessionFile);
		expect(rows).toHaveLength(5);
		expect(signalValue(rows, "tool_arg_validation_failures")).toBe(1);
		expect(signalValue(rows, "edit_rejections")).toBe(1);
		expect(signalValue(rows, "repeat_reads")).toBe(1);
		expect(signalValue(rows, "intent_filled_calls")).toBe(3);
		expect(signalValue(rows, "intent_total_calls")).toBe(5);
		for (const row of rows) {
			expect(row.sessionFile).toBe(sessionFile);
			expect(row.timestamp).toBe(Date.parse(TS3));
		}
	});

	it("replaces rows on incremental re-sync instead of accumulating deltas", async () => {
		const entries = buildStandardEntries();
		const sessionFile = await writeSessionFile("session-incremental.jsonl", entries);
		await syncAllSessions({ workers: 1 });

		// Append a turn with two more reads of the already-hot path. The full
		// recompute keeps the burst inside one window, so repeat_reads must
		// stay 1 (transition-only) and every counter must be absolute, not
		// first-pass + second-pass.
		const appended = [
			...entries,
			buildAssistantEntry("asst-4", TS4, [
				{ id: "call-6", name: "read", arguments: { path: "src/foo.ts" } },
				{ id: "call-7", name: "read", arguments: { path: "src/foo.ts" } },
			]),
			buildToolResultEntry("tr-6", "asst-4", TS4, "call-6", "1:export const foo = 1;"),
			buildToolResultEntry("tr-7", "asst-4", TS4, "call-7", "1:export const foo = 1;"),
		];
		await writeSessionFile("session-incremental.jsonl", appended);
		const future = new Date(Date.now() + 5_000);
		await fs.utimes(sessionFile, future, future);
		await syncAllSessions({ workers: 1 });

		const rows = await readHealthSignals(sessionFile);
		expect(signalValue(rows, "tool_arg_validation_failures")).toBe(1);
		expect(signalValue(rows, "edit_rejections")).toBe(1);
		expect(signalValue(rows, "repeat_reads")).toBe(1);
		expect(signalValue(rows, "intent_filled_calls")).toBe(3);
		expect(signalValue(rows, "intent_total_calls")).toBe(7);

		// A no-op sync leaves everything untouched.
		await syncAllSessions({ workers: 1 });
		expect(await readHealthSignals(sessionFile)).toEqual(rows);
	});

	it("emits no rows for sessions without tool calls", async () => {
		const sessionFile = await writeSessionFile("session-empty.jsonl", [buildAssistantEntry("asst-1", TS1, [])]);
		await syncAllSessions({ workers: 1 });
		expect(await readHealthSignals(sessionFile)).toEqual([]);
	});
});
