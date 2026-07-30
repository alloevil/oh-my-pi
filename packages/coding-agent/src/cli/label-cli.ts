/**
 * `omp label` — persist a ground-truth session outcome label.
 *
 * The target session is usually NOT the live one (outcomes become known after
 * the fact), so the append goes through `SessionManager.open` — the same
 * storage-backed appender the session-end sentinel uses — rather than any
 * in-process session state: proper id/parent chaining, no hand-rolled JSONL.
 */
import {
	isSessionOutcome,
	SESSION_OUTCOME_CUSTOM_TYPE,
	SESSION_OUTCOMES,
	type SessionOutcomeLabel,
} from "../health/outcome";
import { SessionManager } from "../session/session-manager";
import { resolveDoctorSessionFile } from "./doctor-cli";

export interface LabelCommandArgs {
	/** One of {@link SESSION_OUTCOMES}. */
	outcome: string;
	/** Session file path or session id prefix; default is the most recent session for cwd. */
	session?: string;
	/** Free-form human context stored with the label. */
	note?: string;
}

/** What `omp label` wrote and where. */
export interface LabelCommandResult {
	sessionPath: string;
	label: SessionOutcomeLabel;
}

/**
 * Append a `session_outcome` custom entry to the resolved session file.
 * Appending never rewrites earlier labels — readers take the last one, so
 * relabeling is a correction while the JSONL stays append-only.
 */
export async function runLabelCommand(args: LabelCommandArgs, cwd = process.cwd()): Promise<LabelCommandResult> {
	if (!isSessionOutcome(args.outcome)) {
		throw new Error(`unknown outcome "${args.outcome}" (expected one of: ${SESSION_OUTCOMES.join(" | ")})`);
	}
	const sessionPath = await resolveDoctorSessionFile(args.session, cwd);
	const label: SessionOutcomeLabel = { outcome: args.outcome, at: Date.now() };
	if (args.note !== undefined && args.note.length > 0) label.note = args.note;
	const manager = await SessionManager.open(sessionPath, undefined, undefined, { suppressBreadcrumb: true });
	try {
		manager.appendCustomEntry(SESSION_OUTCOME_CUSTOM_TYPE, label);
	} finally {
		// close() flushes queued appends before releasing the writer.
		await manager.close();
	}
	return { sessionPath, label };
}
