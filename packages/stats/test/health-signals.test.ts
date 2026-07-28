/**
 * End-to-end coverage for behavioral health signals: session JSONL →
 * `syncAllSessions` → `health_signals` rows → `readHealthSignals`.
 *
 * Signals are absolute per-session totals recomputed from the full transcript
 * on every pass, so the key contract beyond the counter math is idempotency:
 * incremental re-syncs REPLACE rows instead of accumulating deltas.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readHealthSignals, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { initDb } from "@oh-my-pi/omp-stats/db";
import type { HealthSignalName } from "@oh-my-pi/omp-stats/health-signals";
import { VALIDATION_FAILURE_PREFIX } from "@oh-my-pi/omp-stats/health-signals";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
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

function buildAssistantEntry(
	entryId: string,
	timestamp: string,
	toolCalls: ToolCallBlock[],
	overrides?: { stopReason?: string; errorMessage?: string; model?: string },
) {
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
			model: overrides?.model ?? MODEL,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			},
			stopReason: overrides?.stopReason ?? "toolUse",
			...(overrides?.errorMessage !== undefined ? { errorMessage: overrides.errorMessage } : {}),
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

function buildStageTimingEntry(entryId: string, timestamp: string, data: unknown) {
	return { type: "custom", customType: "stage_timings", data, id: entryId, parentId: null, timestamp };
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
 * turn 3's grep call is rejected at arg validation, turn 4 fails on the
 * provider side (error stop + errorMessage), turn 5 is a user abort that
 * must NOT count as a provider error.
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
		buildAssistantEntry("asst-err", TS4, [], {
			stopReason: "error",
			errorMessage: "Anthropic stream stalled while waiting for the next event",
		}),
		buildAssistantEntry("asst-abort", TS4, [], {
			stopReason: "aborted",
			errorMessage: "Interrupted by user",
		}),
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
		expect(rows).toHaveLength(6);
		expect(signalValue(rows, "tool_arg_validation_failures")).toBe(1);
		expect(signalValue(rows, "edit_rejections")).toBe(1);
		expect(signalValue(rows, "repeat_reads")).toBe(1);
		expect(signalValue(rows, "intent_filled_calls")).toBe(3);
		expect(signalValue(rows, "intent_total_calls")).toBe(5);
		// asst-err counts; the user abort (asst-abort) must not.
		expect(signalValue(rows, "provider_error_turns")).toBe(1);
		for (const row of rows) {
			expect(row.sessionFile).toBe(sessionFile);
			expect(row.timestamp).toBe(Date.parse(TS4));
			expect(row.model).toBe(MODEL);
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
		expect(signalValue(rows, "provider_error_turns")).toBe(1);

		// A no-op sync leaves everything untouched.
		await syncAllSessions({ workers: 1 });
		expect(await readHealthSignals(sessionFile)).toEqual(rows);
	});

	it("emits no rows for sessions without tool calls or provider errors", async () => {
		const sessionFile = await writeSessionFile("session-empty.jsonl", [buildAssistantEntry("asst-1", TS1, [])]);
		await syncAllSessions({ workers: 1 });
		expect(await readHealthSignals(sessionFile)).toEqual([]);
	});

	it("records provider errors even when the session made no tool calls", async () => {
		const sessionFile = await writeSessionFile("session-error-only.jsonl", [
			buildAssistantEntry("asst-err", TS1, [], {
				stopReason: "error",
				errorMessage: "Anthropic stream stalled while waiting for the next event",
			}),
		]);
		await syncAllSessions({ workers: 1 });
		const rows = await readHealthSignals(sessionFile);
		expect(signalValue(rows, "provider_error_turns")).toBe(1);
		expect(signalValue(rows, "intent_total_calls")).toBe(0);
	});

	it("folds stage_timings entries into per-session stage percentile signals", async () => {
		const sessionFile = await writeSessionFile("session-stages.jsonl", [
			buildAssistantEntry("asst-1", TS1, [
				{ id: "call-1", name: "read", arguments: { i: "Reading foo", path: "src/foo.ts" } },
			]),
			buildToolResultEntry("tr-1", "asst-1", TS1, "call-1", "1:export const foo = 1;"),
			buildStageTimingEntry("stage-1", TS1, {
				ts: Date.parse(TS1),
				turnMs: 1200,
				context: { transformMs: 10, promptChars: 40_000 },
				provider: { ttfbMs: 100, streamMs: 1000 },
				tools: [{ name: "read", ms: 40 }],
			}),
			buildStageTimingEntry("stage-2", TS2, {
				ts: Date.parse(TS2),
				turnMs: 4300,
				context: { transformMs: 30 },
				provider: { ttfbMs: 300, streamMs: 3000 },
				tools: [
					{ name: "bash", ms: 900, error: true },
					{ name: "edit", ms: 60, error: true },
				],
			}),
			// Malformed payload must be skipped, not crash the fold.
			buildStageTimingEntry("stage-bad", TS2, { nonsense: true }),
		]);
		await syncAllSessions({ workers: 1 });

		const rows = await readHealthSignals(sessionFile);
		// 6 behavioral counters (the read call fills intent) + 4 stage signals.
		expect(rows).toHaveLength(10);
		// Nearest-rank p95 over two samples is the larger one.
		expect(signalValue(rows, "stage_context_transform_p95_ms")).toBe(30);
		expect(signalValue(rows, "stage_provider_ttfb_p95_ms")).toBe(300);
		expect(signalValue(rows, "stage_provider_stream_p95_ms")).toBe(3000);
		// Two failed tool calls in one turn count that turn once.
		expect(signalValue(rows, "stage_tool_error_turns")).toBe(1);
		const stageRow = rows.find(r => r.signal === "stage_provider_ttfb_p95_ms");
		expect(stageRow?.timestamp).toBe(Date.parse(TS2));
	});

	it("emits stage signals for a session with stage timings but no tool calls", async () => {
		const sessionFile = await writeSessionFile("session-stages-only.jsonl", [
			buildStageTimingEntry("stage-1", TS1, {
				ts: Date.parse(TS1),
				turnMs: 900,
				provider: { ttfbMs: 250, streamMs: 600 },
			}),
		]);
		await syncAllSessions({ workers: 1 });

		const rows = await readHealthSignals(sessionFile);
		expect(rows).toHaveLength(4);
		expect(signalValue(rows, "stage_provider_ttfb_p95_ms")).toBe(250);
		expect(signalValue(rows, "stage_provider_stream_p95_ms")).toBe(600);
		// No context samples recorded → percentile collapses to 0.
		expect(signalValue(rows, "stage_context_transform_p95_ms")).toBe(0);
		expect(signalValue(rows, "stage_tool_error_turns")).toBe(0);
	});

	it("splits counters per model, attributing tool results to the issuing turn", async () => {
		const sessionFile = await writeSessionFile("session-two-models.jsonl", [
			// Model A issues three intent-filled calls, two of them reads of foo.
			buildAssistantEntry(
				"asst-a",
				TS1,
				[
					{ id: "call-a1", name: "read", arguments: { i: "Reading foo", path: "src/foo.ts" } },
					{ id: "call-a2", name: "edit", arguments: { i: "Patching foo", input: "[src/foo.ts#AAAA]\nDEL 1" } },
					{ id: "call-a3", name: "read", arguments: { i: "Re-reading foo", path: "src/foo.ts" } },
				],
				{ model: "model-a" },
			),
			buildToolResultEntry("tr-a1", "asst-a", TS1, "call-a1", "1:export const foo = 1;"),
			buildToolResultEntry("tr-a3", "asst-a", TS1, "call-a3", "1:export const foo = 1;"),
			// Model B answers next: its grep is rejected at validation and its
			// read of foo is the threshold-crossing third — both count under B.
			buildAssistantEntry(
				"asst-b",
				TS2,
				[
					{ id: "call-b1", name: "grep", arguments: {} },
					{ id: "call-b2", name: "read", arguments: { path: "src/foo.ts" } },
				],
				{ model: "model-b" },
			),
			buildToolResultEntry("tr-b2", "asst-b", TS2, "call-b2", "1:export const foo = 1;"),
			// Model A's edit result lands AFTER model B's turn — the rejection
			// must still count under model-a, the turn that issued the call.
			buildToolResultEntry("tr-a2", "asst-a", TS3, "call-a2", "Stale tag: re-read the file and retry.", true),
			buildToolResultEntry(
				"tr-b1",
				"asst-b",
				TS3,
				"call-b1",
				`${VALIDATION_FAILURE_PREFIX}grep":\npattern must be a string`,
				true,
			),
			buildAssistantEntry("asst-b-err", TS4, [], {
				model: "model-b",
				stopReason: "error",
				errorMessage: "Anthropic stream stalled while waiting for the next event",
			}),
		]);
		await syncAllSessions({ workers: 1 });

		const rows = await readHealthSignals(sessionFile);
		// One 6-signal counter group per model.
		expect(rows).toHaveLength(12);
		const a = rows.filter(row => row.model === "model-a");
		const b = rows.filter(row => row.model === "model-b");
		expect(signalValue(a, "edit_rejections")).toBe(1);
		expect(signalValue(a, "tool_arg_validation_failures")).toBe(0);
		expect(signalValue(a, "repeat_reads")).toBe(0);
		expect(signalValue(a, "intent_filled_calls")).toBe(3);
		expect(signalValue(a, "intent_total_calls")).toBe(3);
		expect(signalValue(a, "provider_error_turns")).toBe(0);
		expect(signalValue(b, "tool_arg_validation_failures")).toBe(1);
		expect(signalValue(b, "edit_rejections")).toBe(0);
		// The window spans models; B's read crossed the threshold, so the
		// incident attributes to B even though A contributed two of the reads.
		expect(signalValue(b, "repeat_reads")).toBe(1);
		expect(signalValue(b, "intent_filled_calls")).toBe(0);
		expect(signalValue(b, "intent_total_calls")).toBe(2);
		expect(signalValue(b, "provider_error_turns")).toBe(1);
		// Per-model timestamps track each model's newest contributing event.
		for (const row of a) expect(row.timestamp).toBe(Date.parse(TS3));
		for (const row of b) expect(row.timestamp).toBe(Date.parse(TS4));
	});

	it('splits stage signals by the row\'s own model, folding legacy rows under ""', async () => {
		const sessionFile = await writeSessionFile("session-stages-models.jsonl", [
			buildStageTimingEntry("stage-a", TS1, {
				ts: Date.parse(TS1),
				turnMs: 1000,
				model: "model-a",
				provider: { ttfbMs: 100, streamMs: 900 },
			}),
			buildStageTimingEntry("stage-b", TS2, {
				ts: Date.parse(TS2),
				turnMs: 2000,
				model: "model-b",
				provider: { ttfbMs: 300, streamMs: 1500 },
			}),
			// Row written before model capture existed (old session format).
			buildStageTimingEntry("stage-legacy", TS3, {
				ts: Date.parse(TS3),
				turnMs: 500,
				provider: { ttfbMs: 500, streamMs: 50 },
			}),
		]);
		await syncAllSessions({ workers: 1 });

		const rows = await readHealthSignals(sessionFile);
		// 4 stage signals × 3 model buckets (model-a, model-b, legacy "").
		expect(rows).toHaveLength(12);
		const ttfb = (model: string) =>
			rows.find(row => row.signal === "stage_provider_ttfb_p95_ms" && row.model === model)?.value;
		expect(ttfb("model-a")).toBe(100);
		expect(ttfb("model-b")).toBe(300);
		expect(ttfb("")).toBe(500);
	});

	it("drops a pre-model health_signals table on init and lazily repopulates on re-sync", async () => {
		// Seed an OLD-shape stats.db: `health_signals` keyed on
		// (session_file, signal) with no `model` column, plus a `file_offsets`
		// row and settled backfill sentinels so no unrelated migration wipes
		// offsets.
		const statsDbPath = getStatsDbPath();
		await fs.mkdir(path.dirname(statsDbPath), { recursive: true });
		const old = new Database(statsDbPath);
		old.run(`
			CREATE TABLE health_signals (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_file TEXT NOT NULL,
				ts INTEGER NOT NULL,
				signal TEXT NOT NULL,
				value INTEGER NOT NULL,
				UNIQUE(session_file, signal)
			);
			CREATE INDEX idx_health_signals_ts ON health_signals(ts);
			CREATE TABLE file_offsets (
				session_file TEXT PRIMARY KEY,
				offset INTEGER NOT NULL,
				last_modified INTEGER NOT NULL
			);
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
		old.run(
			"INSERT INTO health_signals (session_file, ts, signal, value) VALUES ('/old/session.jsonl', 1, 'repeat_reads', 3)",
		);
		old.run("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES ('/old/session.jsonl', 123, 456)");
		for (const key of [
			"user_messages_v8",
			"user_message_links_v1",
			"premium_requests_priority_v1",
			"agent_type_v1",
			"fork_dedupe_v1",
			"tool_calls_v1",
		]) {
			old.prepare("INSERT INTO meta (key, value) VALUES (?, 'complete')").run(key);
		}
		old.close();

		const db = await initDb();
		const columns = db.prepare("PRAGMA table_info(health_signals)").all() as { name: string }[];
		expect(columns.some(column => column.name === "model")).toBe(true);
		// Old rows are dropped, not backfilled — the table is a pure derivation
		// of session JSONL.
		expect(db.prepare("SELECT COUNT(*) AS n FROM health_signals").get()).toEqual({ n: 0 });
		// file_offsets survives: messages/tool_calls ingestion is not re-run.
		expect(db.prepare("SELECT offset FROM file_offsets WHERE session_file = '/old/session.jsonl'").get()).toEqual({
			offset: 123,
		});

		// Rows repopulate lazily: a session with new content re-parses fully.
		const sessionFile = await writeSessionFile("session-migrated.jsonl", buildStandardEntries());
		await syncAllSessions({ workers: 1 });
		const rows = await readHealthSignals(sessionFile);
		expect(rows).toHaveLength(6);
		expect(signalValue(rows, "intent_total_calls")).toBe(5);
		expect(rows.every(row => row.model === MODEL)).toBe(true);
	});
});
