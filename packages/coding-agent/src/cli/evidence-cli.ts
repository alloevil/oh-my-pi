/**
 * `omp evidence` — layered health evidence report over recent sessions.
 *
 * Standalone CLI command (exits before any TUI), so writing to stdout is
 * allowed here. The compilation itself lives in `../health/evidence`; this
 * module only resolves the most recent N sessions for the working directory,
 * derives one bundle per session, and optionally joins stats `health_signals`
 * rows (read-only — a missing stats.db is tolerated, never created).
 */
import * as path from "node:path";
import type { HealthSignalStat } from "@oh-my-pi/omp-stats";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { isEphemeralSession } from "../health/ephemeral";
import { collectEvidenceBundle, compileEvidenceReport, type EvidenceSessionBundle } from "../health/evidence";
import { listSessionsReadOnly } from "../session/session-listing";
import { loadEntriesFromFile } from "../session/session-loader";
import { computeDefaultSessionDir } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";

/** Default session count when `--sessions` is not given. */
export const DEFAULT_EVIDENCE_SESSIONS = 10;

export interface EvidenceCommandFlags {
	/** Most recent sessions to analyze; default {@link DEFAULT_EVIDENCE_SESSIONS}. */
	sessions?: number;
	/** Write the report to this file instead of stdout. */
	out?: string;
	/** Emit the structured per-session bundles as JSON instead of markdown. */
	json?: boolean;
	/**
	 * Also analyze ephemeral (eval/tmp) sessions. Default scans skip sessions
	 * whose recorded cwd / session dir resolves under an OS temp root so eval
	 * harness runs never contaminate the evidence denominator.
	 */
	includeEphemeral?: boolean;
}

/**
 * Read stats `health_signals` rows for each session file. Read-only: when
 * stats.db does not exist the stats package is never imported (importing it
 * would create the database), and any read failure degrades to empty rows.
 */
async function readHealthSignalsByFile(files: readonly string[]): Promise<Map<string, HealthSignalStat[]>> {
	const byFile = new Map<string, HealthSignalStat[]>();
	if (files.length === 0 || !(await Bun.file(getStatsDbPath()).exists())) return byFile;
	try {
		// Dynamic on purpose: statically importing @oh-my-pi/omp-stats pulls the
		// SQLite runtime into every CLI start, and its initDb() would CREATE a
		// stats.db we just proved absent. Load it only when the db exists.
		const { readHealthSignals } = await import("@oh-my-pi/omp-stats");
		for (const file of files) {
			byFile.set(file, await readHealthSignals(file));
		}
	} catch {
		// stats.db unreadable (locked, corrupt, schema drift) — report proceeds without signals.
		byFile.clear();
	}
	return byFile;
}

/** Resolve, bundle, compile; returns whatever was written (markdown or JSON). */
export async function runEvidenceCommand(flags: EvidenceCommandFlags, cwd = process.cwd()): Promise<string> {
	const storage = new FileSessionStorage();
	const sessionDir = computeDefaultSessionDir(cwd, storage);
	const sessions = await listSessionsReadOnly(sessionDir, storage);
	if (sessions.length === 0) throw new Error(`no sessions recorded for ${cwd}`);
	const sessionDirName = path.basename(sessionDir);
	const eligible = flags.includeEphemeral
		? sessions
		: sessions.filter(info => !isEphemeralSession({ headerCwd: info.cwd, sessionDirName }));
	const skippedEphemeral = sessions.length - eligible.length;
	if (skippedEphemeral > 0) {
		// stderr on purpose: the report payload (markdown or JSON) owns stdout.
		process.stderr.write(`evidence: skipped ${skippedEphemeral} ephemeral (eval/tmp) sessions\n`);
	}
	if (eligible.length === 0) {
		throw new Error(
			`no non-ephemeral sessions recorded for ${cwd} (${skippedEphemeral} eval/tmp sessions skipped; use --include-ephemeral to analyze them)`,
		);
	}
	const limit = flags.sessions !== undefined && flags.sessions > 0 ? flags.sessions : DEFAULT_EVIDENCE_SESSIONS;
	const recent = eligible.slice(0, limit);

	const signalsByFile = await readHealthSignalsByFile(recent.map(info => info.path));
	const bundles: EvidenceSessionBundle[] = [];
	for (const info of recent) {
		const entries = await loadEntriesFromFile(info.path);
		if (entries.length === 0) continue; // unreadable or headerless file — skip, don't abort the batch
		bundles.push(collectEvidenceBundle(info.id, info.path, entries, signalsByFile.get(info.path) ?? []));
	}
	if (bundles.length === 0) throw new Error(`no readable sessions among the ${recent.length} most recent for ${cwd}`);

	const output = flags.json ? `${JSON.stringify(bundles, null, 2)}\n` : compileEvidenceReport(bundles);
	if (flags.out !== undefined && flags.out !== "") {
		await Bun.write(flags.out, output);
		process.stdout.write(`evidence report written to ${flags.out} (${bundles.length} sessions)\n`);
	} else {
		process.stdout.write(output);
	}
	return output;
}
