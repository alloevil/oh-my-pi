/**
 * `omp doctor` — offline session health report.
 *
 * Standalone CLI command (exits before any TUI), so writing to stdout is
 * allowed here. The analysis itself lives in `../health/doctor`.
 */
import * as path from "node:path";
import { evaluateScan, scanSession } from "../health/doctor";
import type { HealthFindingInput, HealthSeverity } from "../health/ledger";
import { findMostRecentSession, resolveResumableSession } from "../session/session-listing";
import { loadEntriesFromFile } from "../session/session-loader";
import { computeDefaultSessionDir } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";

const SEVERITY_GLYPHS: Record<HealthSeverity, string> = { warn: "⚠", info: "·" };
const SEVERITY_ORDER: Record<HealthSeverity, number> = { warn: 0, info: 1 };

export interface DoctorCommandFlags {
	json?: boolean;
}

export interface DoctorCommandArgs {
	/** Session file path or session id prefix; default is the most recent session for cwd. */
	session?: string;
	flags: DoctorCommandFlags;
}

/** Machine-readable doctor output (`--json`). */
export interface DoctorReport {
	sessionPath: string;
	sessionId: string | undefined;
	messageCount: number;
	models: string[];
	findings: HealthFindingInput[];
}

/**
 * Resolve the doctor target: explicit file path, session id prefix (local
 * first, then global — same matching as `--resume`), or the most recent
 * session recorded for `cwd`.
 */
async function resolveDoctorSessionFile(target: string | undefined, cwd: string): Promise<string> {
	const storage = new FileSessionStorage();
	if (target === undefined) {
		const sessionDir = computeDefaultSessionDir(cwd, storage);
		const mostRecent = await findMostRecentSession(sessionDir, storage);
		if (mostRecent === null) throw new Error(`no sessions recorded for ${cwd}`);
		return mostRecent;
	}
	if (await Bun.file(target).exists()) return path.resolve(target);
	const match = await resolveResumableSession(target, cwd, undefined, storage);
	if (match === undefined) throw new Error(`no session file or session id matching "${target}"`);
	return match.session.path;
}

function renderReport(report: DoctorReport): string {
	const id = report.sessionId ?? path.basename(report.sessionPath, ".jsonl");
	const models = report.models.length > 0 ? report.models.join(", ") : "none";
	if (report.findings.length === 0) {
		return `✓ session ${id}: no findings (${report.messageCount} messages, models: ${models})\n`;
	}
	const lines = [`session ${id} — ${report.messageCount} messages, models: ${models}`];
	// Stable sort: warns first, report order otherwise preserved.
	const sorted = [...report.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
	for (const finding of sorted) {
		lines.push(`${SEVERITY_GLYPHS[finding.severity]} ${finding.rule}: ${finding.message}`);
	}
	return `${lines.join("\n")}\n`;
}

export async function runDoctorCommand(args: DoctorCommandArgs, cwd = process.cwd()): Promise<DoctorReport> {
	const sessionPath = await resolveDoctorSessionFile(args.session, cwd);
	const entries = await loadEntriesFromFile(sessionPath);
	if (entries.length === 0) throw new Error(`session file is empty or has no valid header: ${sessionPath}`);
	const scan = scanSession(entries);
	const report: DoctorReport = {
		sessionPath,
		sessionId: scan.sessionId,
		messageCount: scan.messageCount,
		models: scan.models,
		findings: evaluateScan(scan),
	};
	process.stdout.write(args.flags.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
	return report;
}
