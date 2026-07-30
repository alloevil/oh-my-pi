/**
 * Contract tests for ground-truth session outcome labels (`health/outcome`):
 * defensive payload parsing, last-label-wins (relabeling is a correction),
 * the doctor header contract (`outcome: <label> — <note>` in the header block
 * and in the JSON report), the `omp label` append round-trip through
 * `SessionManager.open`, and the evidence L1 outcomes line that appears only
 * when a label exists (unlabeled corpora render byte-identically).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDoctorCommand } from "@oh-my-pi/pi-coding-agent/cli/doctor-cli";
import { runLabelCommand } from "@oh-my-pi/pi-coding-agent/cli/label-cli";
import { scanSession } from "@oh-my-pi/pi-coding-agent/health/doctor";
import { compileEvidenceReport, type EvidenceSessionBundle } from "@oh-my-pi/pi-coding-agent/health/evidence";
import {
	collectSessionOutcome,
	formatSessionOutcome,
	parseSessionOutcome,
	SESSION_OUTCOME_CUSTOM_TYPE,
	type SessionOutcomeLabel,
} from "@oh-my-pi/pi-coding-agent/health/outcome";
import type { CustomEntry, FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";

let entrySeq = 0;
const T0 = Date.parse("2026-07-30T00:00:00.000Z");

function base(): { id: string; parentId: null; timestamp: string } {
	entrySeq++;
	return { id: `entry-${entrySeq}`, parentId: null, timestamp: new Date(T0 + entrySeq * 1000).toISOString() };
}

function header(): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: "outcome-test-session",
		timestamp: new Date(T0).toISOString(),
		cwd: "/tmp/outcome-test",
	};
}

function outcomeEntry(data: unknown): CustomEntry {
	return { ...base(), type: "custom", customType: SESSION_OUTCOME_CUSTOM_TYPE, data };
}

describe("parseSessionOutcome", () => {
	test("valid payload round-trips, note optional", () => {
		const full: SessionOutcomeLabel = { outcome: "manual-takeover", note: "user finished by hand", at: T0 };
		expect(parseSessionOutcome(full)).toEqual(full);
		expect(parseSessionOutcome({ outcome: "done", at: T0 })).toEqual({ outcome: "done", at: T0 });
	});

	test("malformed payloads are rejected, not thrown", () => {
		expect(parseSessionOutcome(null)).toBeUndefined();
		expect(parseSessionOutcome("done")).toBeUndefined();
		expect(parseSessionOutcome({ outcome: "victory", at: T0 })).toBeUndefined();
		expect(parseSessionOutcome({ outcome: "done" })).toBeUndefined();
		expect(parseSessionOutcome({ outcome: "done", at: Number.NaN })).toBeUndefined();
		expect(parseSessionOutcome({ outcome: "done", at: "yesterday" })).toBeUndefined();
	});

	test("empty or non-string note is dropped, label kept", () => {
		expect(parseSessionOutcome({ outcome: "partial", at: T0, note: "" })).toEqual({ outcome: "partial", at: T0 });
		expect(parseSessionOutcome({ outcome: "partial", at: T0, note: 42 })).toEqual({ outcome: "partial", at: T0 });
	});
});

describe("last label wins", () => {
	test("collectSessionOutcome returns the last parseable label", () => {
		const entries: FileEntry[] = [
			header(),
			outcomeEntry({ outcome: "abandoned", at: T0 }),
			outcomeEntry({ outcome: "done", at: T0 + 1000 }),
		];
		expect(collectSessionOutcome(entries)?.outcome).toBe("done");
	});

	test("a trailing malformed label does not clobber an earlier valid one", () => {
		const entries: FileEntry[] = [
			header(),
			outcomeEntry({ outcome: "manual-takeover", at: T0 }),
			outcomeEntry({ outcome: "nonsense", at: T0 + 1000 }),
		];
		expect(collectSessionOutcome(entries)?.outcome).toBe("manual-takeover");
	});

	test("scanSession carries the same last-wins label", () => {
		const entries: FileEntry[] = [
			header(),
			outcomeEntry({ outcome: "partial", at: T0 }),
			outcomeEntry({ outcome: "manual-takeover", at: T0 + 1000, note: "corrected" }),
		];
		const scan = scanSession(entries);
		expect(scan.outcome).toEqual({ outcome: "manual-takeover", at: T0 + 1000, note: "corrected" });
		expect(scanSession([header()]).outcome).toBeUndefined();
	});
});

describe("doctor header contract", () => {
	const tmpFiles: string[] = [];
	afterEach(() => {
		for (const file of tmpFiles.splice(0)) fs.rmSync(file, { force: true });
	});

	function writeSessionFile(entries: FileEntry[]): string {
		const file = path.join(os.tmpdir(), `outcome-test-${process.pid}-${entrySeq}.jsonl`);
		fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		tmpFiles.push(file);
		return file;
	}

	async function captureDoctor(file: string) {
		const writes: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			const report = await runDoctorCommand({ session: file, flags: {} });
			return { report, output: writes.join("") };
		} finally {
			process.stdout.write = original;
		}
	}

	test("label round-trip: omp-label append then doctor shows the outcome header line", async () => {
		const file = writeSessionFile([header()]);
		const result = await runLabelCommand({
			outcome: "manual-takeover",
			session: file,
			note: "user finished by hand",
		});
		expect(result.sessionPath).toBe(file);
		// Exactly one JSONL line appended per label; the rest of the file is untouched.
		expect(fs.readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(2);

		const { report, output } = await captureDoctor(file);
		expect(output).toContain("outcome: manual-takeover — user finished by hand");
		expect(report.outcome?.outcome).toBe("manual-takeover");
		expect(report.outcome?.note).toBe("user finished by hand");
		expect(typeof report.outcome?.at).toBe("number");
	});

	test("relabeling corrects: the second label is the one doctor reports", async () => {
		const file = writeSessionFile([header()]);
		await runLabelCommand({ outcome: "abandoned", session: file });
		await runLabelCommand({ outcome: "done", session: file });
		const { report, output } = await captureDoctor(file);
		expect(output).toContain("outcome: done");
		expect(output).not.toContain("abandoned");
		expect(report.outcome?.outcome).toBe("done");
	});

	test("unknown outcome is rejected without touching the file", async () => {
		const file = writeSessionFile([header()]);
		const before = fs.readFileSync(file, "utf8");
		await expect(runLabelCommand({ outcome: "victory", session: file })).rejects.toThrow('unknown outcome "victory"');
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});

	test("unlabeled session renders no outcome line", async () => {
		const file = writeSessionFile([header()]);
		const { report, output } = await captureDoctor(file);
		expect(output).not.toContain("outcome:");
		expect(report.outcome).toBeUndefined();
	});
});

describe("evidence L1 outcomes line", () => {
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

	test("appears only when a label exists, and only that line differs", () => {
		const unlabeled = compileEvidenceReport([bundle(1), bundle(2)]);
		expect(unlabeled).not.toContain("- outcomes:");

		const labeled = compileEvidenceReport([
			bundle(1, { outcome: { outcome: "manual-takeover", at: T0 } }),
			bundle(2),
		]);
		expect(labeled).toContain("- outcomes: manual-takeover 1 (1/2 sessions labeled)");

		// Everything except the one inserted line is byte-identical.
		const extra = labeled.split("\n").filter(line => !unlabeled.split("\n").includes(line));
		expect(extra).toEqual(["- outcomes: manual-takeover 1 (1/2 sessions labeled)"]);
	});

	test("counts group by label in fixed vocabulary order", () => {
		const report = compileEvidenceReport([
			bundle(1, { outcome: { outcome: "abandoned", at: T0 } }),
			bundle(2, { outcome: { outcome: "done", at: T0 } }),
			bundle(3, { outcome: { outcome: "done", at: T0 } }),
			bundle(4),
		]);
		expect(report).toContain("- outcomes: done 2, abandoned 1 (3/4 sessions labeled)");
	});
});

describe("formatSessionOutcome", () => {
	test("note joined with an em dash, absent note renders bare", () => {
		expect(formatSessionOutcome({ outcome: "done", at: T0 })).toBe("outcome: done");
		expect(formatSessionOutcome({ outcome: "partial", note: "half the mail moved", at: T0 })).toBe(
			"outcome: partial — half the mail moved",
		);
	});
});
