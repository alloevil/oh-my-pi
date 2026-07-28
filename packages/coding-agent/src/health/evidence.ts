/**
 * Evidence corpus compiler — one layered markdown report over the four
 * per-session health data sources (doctor findings, stage timings, outbound
 * summaries, stats health signals).
 *
 * Pure compilation: {@link compileEvidenceReport} is a deterministic function
 * from prepared per-session bundles to a markdown string — no clocks, no I/O,
 * no model calls. {@link collectEvidenceBundle} derives one bundle from
 * in-memory session entries, recording the JSONL entry index of every stage
 * and outbound row so L2 claims can cite their source (`[label:entryIndex]`).
 *
 * Report layers:
 * - L1 overview — cross-session aggregates. When the underlying data spans
 *   fewer than {@link DEFAULT_BASELINE_DAYS} days or no health signals exist,
 *   an explicit `insufficient baseline` placeholder replaces trends; trends
 *   are never fabricated.
 * - L2 deep-dives — only sessions with ≥1 warn finding or a per-session stage
 *   p95 at least {@link OUTLIER_FACTOR}× the batch median. Findings, outlier
 *   turns, and outbound diffs interleave chronologically where timestamps
 *   allow; every claim line ends with a source ref.
 * - L3 citations — appendix mapping every ref label to its session file path.
 *
 * The `omp evidence` CLI (`cli/evidence-cli.ts`) feeds this from the most
 * recent sessions for the working directory.
 */
import type { HealthSignalStat } from "@oh-my-pi/omp-stats";
import type { FileEntry } from "../session/session-entries";
import { analyzeSession } from "./doctor";
import type { HealthFindingInput } from "./ledger";
import {
	diffOutboundSummaries,
	OUTBOUND_SUMMARY_CUSTOM_TYPE,
	type OutboundRequestSummary,
	parseOutboundSummary,
} from "./outbound";
import { parseStageTimingsRow, STAGE_TIMINGS_CUSTOM_TYPE, type StageTimingsRow, stagePercentile } from "./stages";

/** Minimum data span (days) before L1 emits trend lines instead of the placeholder. */
export const DEFAULT_BASELINE_DAYS = 7;
/** A session's stage p95 at or beyond this multiple of the batch median marks it an outlier. */
export const OUTLIER_FACTOR = 2;
/** Most outlier turns one L2 timeline lists. */
const TIMELINE_TURN_CAP = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One doctor finding plus the entry it cites (0 = header: whole-transcript claim). */
export interface EvidenceFindingItem {
	finding: HealthFindingInput;
	entryIndex: number;
}

/** One persisted stage-timings row plus its JSONL entry index. */
export interface EvidenceStageItem {
	row: StageTimingsRow;
	entryIndex: number;
}

/** One persisted outbound summary plus its JSONL entry index. */
export interface EvidenceOutboundItem {
	summary: OutboundRequestSummary;
	entryIndex: number;
}

/** Everything the compiler consumes for one session. */
export interface EvidenceSessionBundle {
	sessionId: string;
	filePath: string;
	findings: EvidenceFindingItem[];
	stageRows: EvidenceStageItem[];
	outbound: EvidenceOutboundItem[];
	/** Stats `health_signals` rows for this session file; empty when stats.db is absent or unsynced. */
	healthSignals: HealthSignalStat[];
}

export interface EvidenceReportOptions {
	/** Data span (days) required before trends are emitted; default {@link DEFAULT_BASELINE_DAYS}. */
	baselineDays?: number;
}

/**
 * Derive one compiler bundle from in-memory session entries. Doctor findings
 * are whole-transcript claims and cite entry 0 (the session header); stage and
 * outbound rows cite the exact custom entry they were parsed from.
 */
export function collectEvidenceBundle(
	sessionId: string,
	filePath: string,
	entries: readonly FileEntry[],
	healthSignals: HealthSignalStat[] = [],
): EvidenceSessionBundle {
	const stageRows: EvidenceStageItem[] = [];
	const outbound: EvidenceOutboundItem[] = [];
	for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
		const entry = entries[entryIndex];
		if (entry.type !== "custom") continue;
		if (entry.customType === STAGE_TIMINGS_CUSTOM_TYPE) {
			const row = parseStageTimingsRow(entry.data);
			if (row !== undefined) stageRows.push({ row, entryIndex });
		} else if (entry.customType === OUTBOUND_SUMMARY_CUSTOM_TYPE) {
			const summary = parseOutboundSummary(entry.data);
			if (summary !== undefined) outbound.push({ summary, entryIndex });
		}
	}
	const findings = analyzeSession([...entries]).map(finding => ({ finding, entryIndex: 0 }));
	return { sessionId, filePath, findings, stageRows, outbound, healthSignals };
}

/** Stage keys the report aggregates, with human labels. */
const STAGE_KEYS = ["contextTransform", "providerTtfb", "providerStream", "toolExecution"] as const;
type StageKey = (typeof STAGE_KEYS)[number];
const STAGE_LABELS: Record<StageKey, string> = {
	contextTransform: "context transform",
	providerTtfb: "provider ttfb",
	providerStream: "provider stream",
	toolExecution: "tool execution",
};

/** Duration samples for one stage key over one session's rows. */
function stageSamples(rows: readonly EvidenceStageItem[], key: StageKey): number[] {
	const samples: number[] = [];
	for (const { row } of rows) {
		switch (key) {
			case "contextTransform":
				if (row.context !== undefined) samples.push(row.context.transformMs);
				break;
			case "providerTtfb":
				if (row.provider?.ttfbMs !== undefined) samples.push(row.provider.ttfbMs);
				break;
			case "providerStream":
				if (row.provider?.streamMs !== undefined) samples.push(row.provider.streamMs);
				break;
			case "toolExecution":
				for (const tool of row.tools ?? []) samples.push(tool.ms);
				break;
		}
	}
	return samples.sort((a, b) => a - b);
}

/** Nearest-rank median over unsorted values; 0 for empty. */
function median(values: readonly number[]): number {
	return stagePercentile(
		[...values].sort((a, b) => a - b),
		50,
	);
}

/** p95 per stage key for one session; a key is absent when the session has no samples for it. */
function sessionStageP95(bundle: EvidenceSessionBundle): Partial<Record<StageKey, number>> {
	const p95: Partial<Record<StageKey, number>> = {};
	for (const key of STAGE_KEYS) {
		const samples = stageSamples(bundle.stageRows, key);
		if (samples.length > 0) p95[key] = stagePercentile(samples, 95);
	}
	return p95;
}

/** Why one session earned an L2 section. */
interface SelectionReason {
	warnCount: number;
	outliers: Array<{ key: StageKey; p95: number; batchMedian: number }>;
}

function formatMs(ms: number): string {
	return `${Math.round(ms).toLocaleString("en-US")}ms`;
}

function formatDays(spanMs: number): string {
	if (spanMs <= 0) return "0";
	const days = spanMs / DAY_MS;
	return days >= 10 ? String(Math.round(days)) : (Math.round(days * 10) / 10).toString();
}

function formatTime(ts: number): string {
	return ts > 0 ? new Date(ts).toISOString().slice(0, 19).replace("T", " ") : "(no timestamp)";
}

/** All data timestamps (unix ms, > 0) carried by a bundle. */
function bundleTimestamps(bundle: EvidenceSessionBundle): number[] {
	const out: number[] = [];
	for (const { row } of bundle.stageRows) if (row.ts > 0) out.push(row.ts);
	for (const { summary } of bundle.outbound) if (summary.timestamp > 0) out.push(summary.timestamp);
	for (const signal of bundle.healthSignals) if (signal.timestamp > 0) out.push(signal.timestamp);
	return out;
}

/** One chronological L2 timeline event, pre-rendered with its citation. */
interface TimelineEvent {
	ts: number;
	line: string;
}

/**
 * Compile the layered evidence report. Deterministic: identical inputs yield
 * a byte-identical markdown string (no clocks, no randomness).
 */
export function compileEvidenceReport(
	inputs: readonly EvidenceSessionBundle[],
	options: EvidenceReportOptions = {},
): string {
	const baselineDays = options.baselineDays ?? DEFAULT_BASELINE_DAYS;
	// Stable short labels in input order: s1, s2, … — resolved in the L3 appendix.
	const labels = new Map<EvidenceSessionBundle, string>();
	for (const [index, bundle] of inputs.entries()) labels.set(bundle, `s${index + 1}`);
	const ref = (bundle: EvidenceSessionBundle, entryIndex: number): string => `[${labels.get(bundle)}:${entryIndex}]`;

	const lines: string[] = ["# Evidence report", ""];

	// ---- L1 overview -------------------------------------------------------
	lines.push("## L1 — Overview", "");
	lines.push(`- sessions analyzed: ${inputs.length}`);

	const allTimestamps = inputs.flatMap(bundleTimestamps);
	const spanMs = allTimestamps.length > 0 ? Math.max(...allTimestamps) - Math.min(...allTimestamps) : 0;
	if (allTimestamps.length > 0) {
		lines.push(
			`- data span: ${formatDays(spanMs)} days (${formatTime(Math.min(...allTimestamps))} → ${formatTime(Math.max(...allTimestamps))} UTC)`,
		);
	} else {
		lines.push("- data span: no timestamped health data recorded");
	}
	lines.push("");

	// Finding counts by rule.
	lines.push("### Findings by rule", "");
	const byRule = new Map<string, { severity: string; count: number; sessions: Set<string> }>();
	for (const bundle of inputs) {
		for (const { finding } of bundle.findings) {
			const key = `${finding.severity}:${finding.rule}`;
			let slot = byRule.get(key);
			if (slot === undefined) {
				slot = { severity: finding.severity, count: 0, sessions: new Set() };
				byRule.set(key, slot);
			}
			slot.count++;
			slot.sessions.add(bundle.sessionId);
		}
	}
	if (byRule.size === 0) {
		lines.push("No doctor findings across the analyzed sessions.");
	} else {
		lines.push("| rule | severity | findings | sessions |", "|---|---|---|---|");
		const sortedRules = [...byRule.entries()].sort((a, b) => {
			if (a[1].severity !== b[1].severity) return a[1].severity === "warn" ? -1 : 1;
			if (b[1].count !== a[1].count) return b[1].count - a[1].count;
			return a[0].localeCompare(b[0]);
		});
		for (const [key, slot] of sortedRules) {
			lines.push(
				`| ${key.slice(key.indexOf(":") + 1)} | ${slot.severity} | ${slot.count} | ${slot.sessions.size} |`,
			);
		}
	}
	lines.push("");

	// Stage p95 ranges across sessions.
	lines.push("### Stage p95 ranges (per-session p95 across the batch)", "");
	const perSession = inputs.map(bundle => ({ bundle, stats: sessionStageP95(bundle) }));
	const batchMedians: Partial<Record<StageKey, number>> = {};
	let anyStageData = false;
	for (const key of STAGE_KEYS) {
		const values = perSession.map(({ stats }) => stats[key]).filter((value): value is number => value !== undefined);
		if (values.length === 0) continue;
		anyStageData = true;
		batchMedians[key] = median(values);
	}
	if (!anyStageData) {
		lines.push("No stage timings recorded (sessions predate stage tracking or debug.stageTimings is off).");
	} else {
		lines.push("| stage | sessions | p95 min | p95 median | p95 max |", "|---|---|---|---|---|");
		for (const key of STAGE_KEYS) {
			const values = perSession
				.map(({ stats }) => stats[key])
				.filter((value): value is number => value !== undefined);
			if (values.length === 0) continue;
			lines.push(
				`| ${STAGE_LABELS[key]} | ${values.length} | ${formatMs(Math.min(...values))} | ${formatMs(batchMedians[key] ?? 0)} | ${formatMs(Math.max(...values))} |`,
			);
		}
	}
	lines.push("");

	// Per-model aggregates from health signals.
	lines.push("### Per-model health signals", "");
	const anySignals = inputs.some(bundle => bundle.healthSignals.length > 0);
	if (!anySignals) {
		lines.push("No health signals recorded (stats.db missing or sessions not yet synced by `omp stats`).");
	} else {
		const byModelSignal = new Map<string, { model: string; signal: string; total: number; sessions: Set<string> }>();
		for (const bundle of inputs) {
			for (const row of bundle.healthSignals) {
				const model = row.model === "" ? "(unattributed)" : row.model;
				const key = `${model}\u0000${row.signal}`;
				let slot = byModelSignal.get(key);
				if (slot === undefined) {
					slot = { model, signal: row.signal, total: 0, sessions: new Set() };
					byModelSignal.set(key, slot);
				}
				slot.total += row.value;
				slot.sessions.add(bundle.sessionId);
			}
		}
		lines.push("| model | signal | total | sessions |", "|---|---|---|---|");
		const sortedSignals = [...byModelSignal.values()].sort(
			(a, b) => a.model.localeCompare(b.model) || a.signal.localeCompare(b.signal),
		);
		for (const slot of sortedSignals) {
			lines.push(`| ${slot.model} | ${slot.signal} | ${slot.total} | ${slot.sessions.size} |`);
		}
	}
	lines.push("");

	// Trend baseline: honest placeholder unless the data genuinely supports it.
	lines.push("### Trends", "");
	const spanDays = spanMs / DAY_MS;
	if (spanDays < baselineDays || !anySignals) {
		lines.push(`insufficient baseline: ${formatDays(spanMs)} days of data; trends omitted`);
	} else {
		// Real first-half vs second-half comparison over the data span.
		const minTs = Math.min(...allTimestamps);
		const midTs = minTs + spanMs / 2;
		let earlyWarns = 0;
		let lateWarns = 0;
		for (const bundle of inputs) {
			const timestamps = bundleTimestamps(bundle);
			if (timestamps.length === 0) continue;
			const sessionTs = Math.min(...timestamps);
			const warns = bundle.findings.filter(({ finding }) => finding.severity === "warn").length;
			if (sessionTs < midTs) earlyWarns += warns;
			else lateWarns += warns;
		}
		lines.push(
			`- warn findings, first half vs second half of span: ${earlyWarns} → ${lateWarns} (${lateWarns > earlyWarns ? "worsening" : lateWarns < earlyWarns ? "improving" : "flat"})`,
		);
	}
	lines.push("");

	// ---- L2 deep-dives -----------------------------------------------------
	lines.push("## L2 — Session deep-dives", "");
	const selected: Array<{ bundle: EvidenceSessionBundle; reason: SelectionReason }> = [];
	for (const { bundle, stats } of perSession) {
		const warnCount = bundle.findings.filter(({ finding }) => finding.severity === "warn").length;
		const outliers: SelectionReason["outliers"] = [];
		for (const key of STAGE_KEYS) {
			const value = stats[key];
			const batchMedian = batchMedians[key];
			if (value === undefined || batchMedian === undefined || batchMedian <= 0) continue;
			if (value >= OUTLIER_FACTOR * batchMedian && value > batchMedian) {
				outliers.push({ key, p95: value, batchMedian });
			}
		}
		if (warnCount > 0 || outliers.length > 0) selected.push({ bundle, reason: { warnCount, outliers } });
	}
	if (selected.length === 0) {
		lines.push("No session met the deep-dive bar (≥1 warn finding or a stage p95 ≥ 2× the batch median).");
		lines.push("");
	}
	for (const { bundle, reason } of selected) {
		const label = labels.get(bundle);
		lines.push(`### ${label} — session ${bundle.sessionId}`, "");
		const why: string[] = [];
		if (reason.warnCount > 0) why.push(`${reason.warnCount} warn finding(s)`);
		for (const outlier of reason.outliers) {
			why.push(
				`${STAGE_LABELS[outlier.key]} p95 ${formatMs(outlier.p95)} ≥ ${OUTLIER_FACTOR}× batch median ${formatMs(outlier.batchMedian)}`,
			);
		}
		lines.push(`Selected: ${why.join("; ")}. ${ref(bundle, 0)}`, "");

		if (bundle.findings.length > 0) {
			lines.push("Findings:", "");
			const sortedFindings = [...bundle.findings].sort((a, b) =>
				a.finding.severity === b.finding.severity ? 0 : a.finding.severity === "warn" ? -1 : 1,
			);
			for (const item of sortedFindings) {
				const glyph = item.finding.severity === "warn" ? "⚠" : "·";
				lines.push(`- ${glyph} ${item.finding.rule}: ${item.finding.message} ${ref(bundle, item.entryIndex)}`);
			}
			lines.push("");
		}

		// Chronological timeline: outlier turns + outbound diffs, where timestamps allow.
		const events: TimelineEvent[] = [];
		const turnDurations = bundle.stageRows.map(({ row }) => row.turnMs);
		const turnMedian = median(turnDurations);
		const outlierTurns = bundle.stageRows
			.filter(({ row }) => turnMedian > 0 && row.turnMs >= OUTLIER_FACTOR * turnMedian)
			.sort((a, b) => b.row.turnMs - a.row.turnMs)
			.slice(0, TIMELINE_TURN_CAP);
		for (const item of outlierTurns) {
			const { row } = item;
			const parts: string[] = [];
			if (row.provider?.ttfbMs !== undefined) parts.push(`ttfb ${formatMs(row.provider.ttfbMs)}`);
			if (row.provider?.streamMs !== undefined) parts.push(`stream ${formatMs(row.provider.streamMs)}`);
			if (row.provider?.error) parts.push("provider error");
			const toolMs = (row.tools ?? []).reduce((sum, tool) => sum + tool.ms, 0);
			if (toolMs > 0) parts.push(`tools ${formatMs(toolMs)} (${(row.tools ?? []).length})`);
			const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
			events.push({
				ts: row.ts,
				line: `- ${formatTime(row.ts)} slow turn ${formatMs(row.turnMs)} (≥${OUTLIER_FACTOR}× session median ${formatMs(turnMedian)})${detail} ${ref(bundle, item.entryIndex)}`,
			});
		}
		for (let index = 1; index < bundle.outbound.length; index++) {
			const prev = bundle.outbound[index - 1];
			const curr = bundle.outbound[index];
			const diffs = diffOutboundSummaries(prev.summary, curr.summary);
			if (diffs.length === 0) continue;
			events.push({
				ts: curr.summary.timestamp,
				line: `- ${formatTime(curr.summary.timestamp)} outbound Δ ${diffs.join("; ")} ${ref(bundle, curr.entryIndex)}`,
			});
		}
		if (events.length > 0) {
			lines.push("Timeline:", "");
			events.sort((a, b) => a.ts - b.ts);
			for (const event of events) lines.push(event.line);
			lines.push("");
		}
	}

	// ---- L3 citations ------------------------------------------------------
	lines.push("## L3 — Citations", "");
	lines.push(
		"Refs read `[label:entryIndex]` — `entryIndex` is the 0-based position in the session JSONL; index 0 is the session header and marks a whole-transcript claim.",
		"",
	);
	for (const bundle of inputs) {
		lines.push(`- ${labels.get(bundle)} — session ${bundle.sessionId} — \`${bundle.filePath}\``);
	}
	lines.push("");

	return lines.join("\n");
}
