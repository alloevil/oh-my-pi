/**
 * Post-hoc subagent discovery from a parent session transcript.
 *
 * The persisted parent↔child linkage is id-only: `task` toolResults carry
 * `details.progress[]` rows naming spawned agent ids (`AgentProgress`), sync
 * spawns settle into `details.results[]` (`SingleResult`), and async
 * completions arrive later as `async-result` custom messages embedding
 * `<task-result id="…">`. No child session file path is persisted anywhere —
 * the transcript location is a write-time convention (`task/index.ts`): each
 * child lives at `<parentSessionFile minus ".jsonl">/<AgentId>.jsonl`, the
 * parent's artifacts directory. Resolution is therefore an honest disk probe
 * against that convention; refs that match nothing are reported as
 * unresolved, never dropped.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { FileEntry } from "../session/session-entries";
import { loadEntriesFromFile } from "../session/session-loader";
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "../task/types";
import { evaluateScan, scanSession } from "./doctor";
import type { HealthFindingInput } from "./ledger";

/** Where in the parent transcript a subagent reference was observed. */
export type SubagentRefSource = "progress" | "result" | "async-result" | "task-args";

/** One spawned agent referenced by a parent transcript. */
export interface SubagentRef {
	/** Agent id (registry id and transcript basename), e.g. `OutcomeLabels`. */
	id: string;
	/** Agent type (`scout`, `task`, …), when persisted. */
	agent?: string;
	/** Last persisted lifecycle status (`completed`, `failed`, `aborted`, `running`, `pending`). */
	status?: string;
	/** Resolved model display string, when the transcript recorded one. */
	resolvedModel?: string;
	/** `agent://` output path from a settled sync result, when persisted. */
	outputPath?: string;
	/** Which transcript facts mentioned this agent, in first-seen order. */
	sources: SubagentRefSource[];
}

/** Digest of one resolved child session, computed by the doctor scan pipeline. */
export interface SubagentDigest {
	/** Number of `message` entries in the child session. */
	messageCount: number;
	/** Distinct bare model ids in first-use order. */
	models: string[];
	/** Warn-severity findings from the doctor rules. */
	warnCount: number;
	/** Total findings (warn + info). */
	findingCount: number;
}

/** One subagent table row: a transcript ref plus its disk resolution. */
export interface SubagentRow {
	ref: SubagentRef;
	/** True when a session file for `ref.id` exists under the artifacts root. */
	resolved: boolean;
	/** Absolute child session path, when resolved. */
	sessionPath?: string;
	/** Health digest, when the resolved file loaded as a valid session. */
	digest?: SubagentDigest;
	/** Why a resolved file produced no digest (unreadable, empty, no header). */
	note?: string;
}

/** Custom-message type carrying a settled background task result. */
const ASYNC_RESULT_CUSTOM_TYPE = "async-result";
const TASK_RESULT_TAG_PATTERN = /<task-result\b([^>]*)>/g;
const TAG_ATTR_PATTERN = /([\w-]+)="([^"]*)"/g;

/** Artifacts-dir convention: a parent's children live under `<session path minus ".jsonl">/`. */
export function subagentsRootForSession(sessionPath: string): string {
	return sessionPath.endsWith(".jsonl") ? sessionPath.slice(0, -".jsonl".length) : `${sessionPath}.d`;
}

/** Non-empty string field of a persisted row, else undefined. */
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** Derive a lifecycle status for a settled `SingleResult` row. */
function resultStatus(result: Partial<SingleResult>): string {
	if (result.aborted === true) return "aborted";
	if (typeof result.exitCode === "number" && result.exitCode !== 0) return "failed";
	return "completed";
}

/** Parse `<task-result …>` attribute payloads out of an async-result message body. */
function parseTaskResultTags(content: string): { id: string; agent?: string; status?: string }[] {
	const tags: { id: string; agent?: string; status?: string }[] = [];
	for (const match of content.matchAll(TASK_RESULT_TAG_PATTERN)) {
		const attrs = new Map<string, string>();
		for (const attr of match[1].matchAll(TAG_ATTR_PATTERN)) attrs.set(attr[1], attr[2]);
		const id = optionalString(attrs.get("id"));
		if (id !== undefined) {
			tags.push({ id, agent: optionalString(attrs.get("agent")), status: optionalString(attrs.get("status")) });
		}
	}
	return tags;
}

/** Task names declared in a `task` toolCall's streamed arguments (flat or batch shape). */
function taskArgNames(args: unknown): string[] {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
	const params = args as Partial<TaskParams>;
	const names: string[] = [];
	const single = optionalString(params.name);
	if (single !== undefined) names.push(single.trim());
	if (Array.isArray(params.tasks)) {
		for (const item of params.tasks) {
			const name = optionalString(item?.name);
			if (name !== undefined) names.push(name.trim());
		}
	}
	return names.filter(name => name !== "");
}

/**
 * Extract every subagent reference a parent transcript persists, deduped by
 * id in first-seen order. Sources, strongest first:
 *
 * - `task` toolResult `details.progress[]` rows (authoritative allocation:
 *   ids survive rename-on-collision) and settled `details.results[]` rows;
 * - `async-result` custom messages (`<task-result id="…">`);
 * - `task` toolCall argument names, only for calls that never persisted a
 *   toolResult — when a result exists its progress rows carry the allocated
 *   ids, and an argument name absent from them was renamed, not spawned.
 *
 * Field merge is fill-if-missing except `status`, which is last-write-wins
 * (later transcript facts describe a later lifecycle state).
 */
export function collectSubagentRefs(entries: FileEntry[]): SubagentRef[] {
	// Pass 1: which task toolCalls got a persisted result.
	const answeredCallIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult" && message.toolName === "task") answeredCallIds.add(message.toolCallId);
	}

	// Pass 2: merge refs in transcript order.
	const refs = new Map<string, SubagentRef>();
	const merge = (
		id: string,
		source: SubagentRefSource,
		patch: Partial<Omit<SubagentRef, "id" | "sources">> = {},
	): void => {
		const existing = refs.get(id);
		if (existing === undefined) {
			refs.set(id, { id, ...patch, sources: [source] });
			return;
		}
		if (!existing.sources.includes(source)) existing.sources.push(source);
		existing.agent ??= patch.agent;
		existing.resolvedModel ??= patch.resolvedModel;
		existing.outputPath ??= patch.outputPath;
		if (patch.status !== undefined) existing.status = patch.status;
	};

	for (const entry of entries) {
		if (entry.type === "custom_message") {
			if (entry.customType !== ASYNC_RESULT_CUSTOM_TYPE) continue;
			const body =
				typeof entry.content === "string"
					? entry.content
					: entry.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			for (const tag of parseTaskResultTags(body)) {
				merge(tag.id, "async-result", { agent: tag.agent, status: tag.status });
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			const content = (message as AssistantMessage).content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (block.type !== "toolCall" || block.name !== "task") continue;
				if (answeredCallIds.has(block.id)) continue;
				for (const name of taskArgNames(block.arguments)) merge(name, "task-args");
			}
			continue;
		}
		if (message.role !== "toolResult" || message.toolName !== "task") continue;
		const details = (message as ToolResultMessage).details;
		if (typeof details !== "object" || details === null || Array.isArray(details)) continue;
		// Boundary assertion: persisted task toolResult details are TaskToolDetails
		// (written by task/index.ts); rows are still field-checked below because
		// old sessions may predate individual fields.
		const taskDetails = details as Partial<TaskToolDetails>;
		if (Array.isArray(taskDetails.progress)) {
			for (const row of taskDetails.progress as Partial<AgentProgress>[]) {
				const id = optionalString(row.id);
				if (id === undefined) continue;
				merge(id, "progress", {
					agent: optionalString(row.agent),
					status: optionalString(row.status),
					resolvedModel: optionalString(row.resolvedModel),
				});
			}
		}
		if (Array.isArray(taskDetails.results)) {
			for (const row of taskDetails.results as Partial<SingleResult>[]) {
				const id = optionalString(row.id);
				if (id === undefined) continue;
				merge(id, "result", {
					agent: optionalString(row.agent),
					status: resultStatus(row),
					resolvedModel: optionalString(row.resolvedModel),
					outputPath: optionalString(row.outputPath),
				});
			}
		}
	}
	return [...refs.values()];
}

/** List `.jsonl` transcript basenames under `root`, keyed by lowercased name. Missing root reads as empty. */
async function listSessionFiles(root: string): Promise<Map<string, string>> {
	let dirents: Dirent[];
	try {
		dirents = await fs.readdir(root, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return new Map();
		throw err;
	}
	const files = new Map<string, string>();
	for (const dirent of dirents) {
		if (!dirent.isFile()) continue;
		const name = dirent.name;
		if (!name.endsWith(".jsonl") || name.startsWith("__advisor")) continue;
		if (!files.has(name.toLowerCase())) files.set(name.toLowerCase(), name);
	}
	return files;
}

/**
 * Resolve transcript refs against the parent's artifacts directory
 * (`subagentsRootForSession(parentSessionPath)`, injectable for tests).
 * Exact `<root>/<id>.jsonl` first, then a case-insensitive basename match.
 * Each resolved child gets a health digest from the same scan/evaluate
 * pipeline `omp doctor` runs on the parent; refs without a matching file are
 * returned with `resolved: false`. Row order mirrors ref order.
 */
export async function resolveSubagentSessions(refs: SubagentRef[], sessionsRoot: string): Promise<SubagentRow[]> {
	const files = await listSessionFiles(sessionsRoot);
	const rows: SubagentRow[] = [];
	for (const ref of refs) {
		const filename = files.get(`${ref.id.toLowerCase()}.jsonl`);
		if (filename === undefined) {
			rows.push({ ref, resolved: false });
			continue;
		}
		const sessionPath = path.join(sessionsRoot, filename);
		const row: SubagentRow = { ref, resolved: true, sessionPath };
		try {
			const entries = await loadEntriesFromFile(sessionPath);
			if (entries.length === 0) {
				row.note = "session file is empty or has no valid header";
			} else {
				const scan = scanSession(entries);
				const findings = evaluateScan(scan);
				row.digest = {
					messageCount: scan.messageCount,
					models: scan.models,
					warnCount: findings.filter(finding => finding.severity === "warn").length,
					findingCount: findings.length,
				};
			}
		} catch (err) {
			row.note = `failed to read session: ${err instanceof Error ? err.message : String(err)}`;
		}
		rows.push(row);
	}
	return rows;
}

/**
 * Session-end sweep: fold the children's warn counts into one parent finding.
 *
 * The week's largest dev session ended `✓` while eight of its twenty-two
 * children carried warn findings — child ledgers are invisible to the parent
 * unless a human runs `--subagents` after the fact. This gives the sentinel a
 * cheap way to land the children's state in the parent ledger at dispose.
 *
 * Capped and defensive: at most {@link SWEEP_CHILD_CAP} children are read, and
 * any failure degrades to `undefined` — the sentinel must never fail a dispose.
 */
export async function sweepSubagentWarns(
	entries: FileEntry[],
	sessionFile: string,
): Promise<HealthFindingInput | undefined> {
	try {
		const refs = collectSubagentRefs(entries).slice(0, SWEEP_CHILD_CAP);
		if (refs.length === 0) return undefined;
		const rows = await resolveSubagentSessions(refs, subagentsRootForSession(sessionFile));
		let warns = 0;
		let resolved = 0;
		for (const row of rows) {
			if (row.digest === undefined) continue;
			resolved++;
			warns += row.digest.warnCount;
		}
		if (warns === 0) return undefined;
		return {
			rule: "subagent-health",
			severity: "info",
			message: `${warns} warn finding(s) across ${resolved} subagent session(s) — inspect with omp doctor <session> --subagents`,
			details: { warns, resolved, referenced: refs.length },
		};
	} catch {
		return undefined;
	}
}

/** Upper bound on children read during the dispose-time sweep. */
const SWEEP_CHILD_CAP = 32;
