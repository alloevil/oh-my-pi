/**
 * Offline session health analysis ("doctor").
 *
 * Two strictly separated stages:
 *  1. {@link scanSession} — one pass over persisted session entries (see
 *     `session-loader.ts` / `session-entries.ts`) extracting the cheap facts
 *     rules need. No rule logic lives here.
 *  2. {@link DOCTOR_RULES} — pure, deterministic rules evaluating the scan and
 *     returning {@link HealthFindingInput}s. No I/O, no model calls.
 *
 * {@link analyzeSession} composes both for consumers that hold raw entries:
 * the `omp doctor` CLI (`cli/doctor-cli.ts`) and the in-process session-end
 * sentinel ("doctor-lite").
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, StopReason, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { FileEntry, ModelChangeEntry } from "../session/session-entries";
import type { HealthFindingInput } from "./ledger";
import { OUTBOUND_SUMMARY_CUSTOM_TYPE, parseOutboundSummary } from "./outbound";
import {
	detectTtfbHealth,
	parseStageTimingsRow,
	STAGE_TIMINGS_CUSTOM_TYPE,
	TTFB_RECENT_WINDOW,
	TTFB_STALL_MS,
} from "./stages";

/**
 * Stop reasons of a healthy terminal turn.
 *
 * Calibrated from source, not guessed: the full vocabulary is the `StopReason`
 * union in `packages/ai/src/types.ts` (`"stop" | "length" | "toolUse" |
 * "error" | "aborted"`). Providers resolve every successful completion to
 * `"stop"` or `"toolUse"` (e.g. the `doneReason` mapping in
 * `packages/ai/src/providers/devin.ts`); history replay classifies
 * `"aborted"`/`"error"` as invalid turns (`invalidStopReason` in
 * `packages/ai/src/providers/transform-messages.ts`); `"length"` means the
 * reply was truncated by the output-token budget. Everything outside this set
 * is treated as an abnormal turn by the `error-turns` rule, except
 * `"aborted"`, which the rule skips as deliberate user interruption.
 */
const NORMAL_STOP_REASONS: Partial<Record<StopReason, true>> = { stop: true, toolUse: true };

/** Messages below this serialized content size are never reported by `oversized-messages`. */
const OVERSIZED_INFO_BYTES = 16 * 1024;
/** Serialized content size above which `oversized-messages` escalates to `warn`. */
const OVERSIZED_WARN_BYTES = 64 * 1024;
/** How many top offenders `oversized-messages` lists. */
const OVERSIZED_TOP_COUNT = 3;
/** Consecutive thinking-free assistant turns (after thinking was seen) that trigger `thinking-collapse`. */
const THINKING_COLLAPSE_RUN = 5;
/** Longest error/example excerpt embedded in a finding message. */
const EXAMPLE_MAX_CHARS = 100;

/** One assistant turn, reduced to the facts doctor rules consume. */
export interface AssistantTurnScan {
	/** Index into the scanned entries array. */
	entryIndex: number;
	model: string;
	stopReason: StopReason | undefined;
	errorMessage: string | undefined;
	hasThinking: boolean;
	toolCalls: { id: string; name: string }[];
}

/** One persisted tool result, reduced to pairing facts. */
export interface ToolResultScan {
	entryIndex: number;
	toolCallId: string;
	toolName: string;
	isError: boolean;
}

/** Serialized-size sample for one message entry. */
export interface MessageSizeScan {
	entryIndex: number;
	role: string;
	/** UTF-8 bytes of `JSON.stringify(message.content)`. */
	contentBytes: number;
	/** Tool names involved: the result's tool, or the tools an assistant turn called. */
	toolNames: string[];
}

/** Everything the doctor rules need, extracted in a single pass over entries. */
export interface SessionScan {
	sessionId: string | undefined;
	/** Number of `message` entries. */
	messageCount: number;
	/** Distinct bare model ids in order of first use (assistant turns + model changes). */
	models: string[];
	/**
	 * Chronological model sequence (assistant-turn models merged with
	 * `model_change` targets), consecutive duplicates collapsed, provider
	 * prefixes stripped from change entries so both sources compare equal.
	 */
	modelSequence: string[];
	assistantTurns: AssistantTurnScan[];
	toolResults: ToolResultScan[];
	/** `model_change` entries recorded after the first `message` entry. */
	midSessionModelChanges: ModelChangeEntry[];
	ttsrInjections: number;
	customMessages: number;
	messageSizes: MessageSizeScan[];
	/** Provider ttfb (ms) per turn, in stage-timings order. */
	ttfbSeriesMs: number[];
	/** `approxMessageChars`/`messageChars` of the last outbound summary, if any. */
	lastOutboundMessageChars: number | undefined;
	/**
	 * Entry index of the trailing in-flight assistant turn: the last assistant
	 * message with no user/assistant message after it. Its unanswered tool
	 * calls (and any trailing results) are still streaming when a session is
	 * snapshotted mid-turn, so orphan detection excludes them.
	 */
	inFlightAssistantIndex: number | undefined;
}

/** A named doctor rule: pure function from scan to findings. */
export interface DoctorRule {
	rule: string;
	evaluate(scan: SessionScan): HealthFindingInput[];
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
	return message.role === "toolResult";
}

/** Stage 1: reduce raw session entries to the facts rules evaluate. */
export function scanSession(entries: FileEntry[]): SessionScan {
	const scan: SessionScan = {
		sessionId: undefined,
		messageCount: 0,
		models: [],
		modelSequence: [],
		assistantTurns: [],
		toolResults: [],
		midSessionModelChanges: [],
		ttsrInjections: 0,
		customMessages: 0,
		messageSizes: [],
		ttfbSeriesMs: [],
		lastOutboundMessageChars: undefined,
		inFlightAssistantIndex: undefined,
	};
	let seenMessage = false;
	const pushModelEvent = (model: string): void => {
		if (model !== "" && scan.modelSequence[scan.modelSequence.length - 1] !== model) {
			scan.modelSequence.push(model);
		}
	};

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		switch (entry.type) {
			case "session":
				scan.sessionId ??= entry.id;
				break;
			case "model_change": {
				// Change entries persist "provider/modelId" while assistant
				// messages persist the bare model id (provider is a separate
				// field), so strip the provider segment to sequence both.
				const slash = entry.model.indexOf("/");
				pushModelEvent(slash === -1 ? entry.model : entry.model.slice(slash + 1));
				if (seenMessage) scan.midSessionModelChanges.push(entry);
				break;
			}
			case "ttsr_injection":
				scan.ttsrInjections++;
				break;
			case "custom": {
				// Reuses the stage/outbound parsers so the scan and `--stages` /
				// `--outbound` never disagree about what a row means.
				if (entry.customType === STAGE_TIMINGS_CUSTOM_TYPE) {
					const ttfb = parseStageTimingsRow(entry.data)?.provider?.ttfbMs;
					if (ttfb !== undefined) scan.ttfbSeriesMs.push(ttfb);
				} else if (entry.customType === OUTBOUND_SUMMARY_CUSTOM_TYPE) {
					const chars = parseOutboundSummary(entry.data)?.messageChars;
					if (chars !== undefined) scan.lastOutboundMessageChars = chars;
				}
				break;
			}
			case "custom_message":
				scan.customMessages++;
				break;
			case "message": {
				seenMessage = true;
				scan.messageCount++;
				const message: AgentMessage = entry.message;
				// Custom agent messages (fileMention, bashExecution, …) have no
				// `content` field; their payload is the message body itself.
				const payload: unknown = "content" in message ? message.content : message;
				let contentBytes = 0;
				if (payload !== undefined) {
					try {
						contentBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
					} catch {
						// Non-serializable content (never occurs in loaded JSONL);
						// keep 0 rather than fail the scan.
					}
				}
				const size: MessageSizeScan = { entryIndex: index, role: message.role, contentBytes, toolNames: [] };
				scan.messageSizes.push(size);

				if (isAssistantMessage(message)) {
					const turn: AssistantTurnScan = {
						entryIndex: index,
						model: message.model ?? "",
						stopReason: message.stopReason,
						errorMessage: message.errorMessage ?? undefined,
						hasThinking: false,
						toolCalls: [],
					};
					if (Array.isArray(message.content)) {
						for (const block of message.content) {
							if (block.type === "toolCall") {
								turn.toolCalls.push({ id: block.id, name: block.name });
								size.toolNames.push(block.name);
							} else if (block.type === "thinking" || block.type === "redactedThinking") {
								turn.hasThinking = true;
							}
						}
					}
					pushModelEvent(turn.model);
					scan.assistantTurns.push(turn);
					scan.inFlightAssistantIndex = index;
				} else if (isToolResultMessage(message)) {
					size.toolNames.push(message.toolName);
					scan.toolResults.push({
						entryIndex: index,
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						isError: message.isError === true,
					});
				} else if (message.role === "user") {
					// A user message closes the previous assistant turn: anything
					// left unanswered before it is a real orphan, not an
					// in-flight tail.
					scan.inFlightAssistantIndex = undefined;
				}
				break;
			}
			default:
				break;
		}
	}
	// Set iteration preserves insertion order — first use wins.
	scan.models = [...new Set(scan.modelSequence)];
	return scan;
}

function evaluateModelSwitch(scan: SessionScan): HealthFindingInput[] {
	if (scan.models.length < 2) return [];
	return [
		{
			rule: "model-switch",
			severity: "info",
			message: `session spans ${scan.models.length} models: ${scan.modelSequence.join(" → ")}`,
			details: {
				models: scan.models,
				sequence: scan.modelSequence,
				midSessionModelChanges: scan.midSessionModelChanges.length,
			},
		},
	];
}

function evaluateOrphanToolPairs(scan: SessionScan): HealthFindingInput[] {
	const resultIds = new Set(scan.toolResults.map(result => result.toolCallId));
	const callIds = new Set<string>();
	const unansweredCalls: { id: string; name: string }[] = [];
	for (const turn of scan.assistantTurns) {
		for (const call of turn.toolCalls) {
			callIds.add(call.id);
			if (!resultIds.has(call.id) && turn.entryIndex !== scan.inFlightAssistantIndex) {
				unansweredCalls.push(call);
			}
		}
	}
	const orphanResults = scan.toolResults.filter(
		result =>
			!callIds.has(result.toolCallId) &&
			(scan.inFlightAssistantIndex === undefined || result.entryIndex < scan.inFlightAssistantIndex),
	);
	if (unansweredCalls.length === 0 && orphanResults.length === 0) return [];

	const parts: string[] = [];
	if (unansweredCalls.length > 0) {
		const first = unansweredCalls[0];
		parts.push(
			`${unansweredCalls.length} tool call${unansweredCalls.length === 1 ? "" : "s"} without a result (e.g. ${first.name} ${first.id})`,
		);
	}
	if (orphanResults.length > 0) {
		const first = orphanResults[0];
		parts.push(
			`${orphanResults.length} tool result${orphanResults.length === 1 ? "" : "s"} without a matching call (e.g. ${first.toolName} ${first.toolCallId})`,
		);
	}
	return [
		{
			rule: "orphan-tool-pairs",
			severity: "warn",
			message: parts.join("; "),
			details: {
				unansweredCalls,
				orphanResults: orphanResults.map(result => ({ id: result.toolCallId, name: result.toolName })),
			},
		},
	];
}

function evaluateErrorTurns(scan: SessionScan): HealthFindingInput[] {
	const failed = scan.assistantTurns.filter(turn => {
		// A user pressing ESC aborts the in-flight turn (`stopReason: "aborted"`,
		// errorMessage like "Interrupted by user"). That is deliberate user
		// action, not a degradation signal — counting it made real sessions warn
		// on every interruption. Provider errors and truncation still count.
		if (turn.stopReason === "aborted") return false;
		return turn.errorMessage != null || (turn.stopReason !== undefined && !NORMAL_STOP_REASONS[turn.stopReason]);
	});
	if (failed.length === 0) return [];
	const first = failed[0];
	let example: string;
	if (first.errorMessage != null) {
		const collapsed = first.errorMessage.replace(/\s+/g, " ").trim();
		example =
			collapsed.length > EXAMPLE_MAX_CHARS ? `"${collapsed.slice(0, EXAMPLE_MAX_CHARS - 1)}…"` : `"${collapsed}"`;
	} else {
		example = `stopReason=${first.stopReason}`;
	}
	const stopReasons: Record<string, number> = {};
	for (const turn of failed) {
		const key = turn.stopReason ?? "unknown";
		stopReasons[key] = (stopReasons[key] ?? 0) + 1;
	}
	return [
		{
			rule: "error-turns",
			severity: "warn",
			message: `${failed.length} assistant turn${failed.length === 1 ? "" : "s"} failed (first: ${example})`,
			details: { count: failed.length, firstEntryIndex: first.entryIndex, stopReasons },
		},
	];
}

function evaluateInjectionVolume(scan: SessionScan): HealthFindingInput[] {
	if (scan.ttsrInjections === 0 && scan.customMessages === 0) return [];
	return [
		{
			rule: "injection-volume",
			severity: "info",
			message: `context injections: ${scan.ttsrInjections} TTSR, ${scan.customMessages} custom message${scan.customMessages === 1 ? "" : "s"}`,
			details: { ttsrInjections: scan.ttsrInjections, customMessages: scan.customMessages },
		},
	];
}

function evaluateOversizedMessages(scan: SessionScan): HealthFindingInput[] {
	const top = scan.messageSizes
		.filter(sample => sample.contentBytes >= OVERSIZED_INFO_BYTES)
		.sort((a, b) => b.contentBytes - a.contentBytes)
		.slice(0, OVERSIZED_TOP_COUNT);
	if (top.length === 0) return [];
	const labels = top.map(sample => {
		const kib = `${(sample.contentBytes / 1024).toFixed(1)} KiB`;
		return `${kib} ${sample.role}${sample.toolNames.length > 0 ? `(${sample.toolNames.join(", ")})` : ""}`;
	});
	return [
		{
			rule: "oversized-messages",
			severity: top[0].contentBytes > OVERSIZED_WARN_BYTES ? "warn" : "info",
			message: `largest messages: ${labels.join(", ")}`,
			details: {
				top: top.map(sample => ({
					entryIndex: sample.entryIndex,
					role: sample.role,
					bytes: sample.contentBytes,
					toolNames: sample.toolNames,
				})),
			},
		},
	];
}

function evaluateThinkingCollapse(scan: SessionScan): HealthFindingInput[] {
	let seenThinking = false;
	let run = 0;
	let longestRun = 0;
	let collapses = 0;
	const closeRun = (): void => {
		if (run >= THINKING_COLLAPSE_RUN) {
			collapses++;
			if (run > longestRun) longestRun = run;
		}
		run = 0;
	};
	for (const turn of scan.assistantTurns) {
		if (turn.hasThinking) {
			closeRun();
			seenThinking = true;
		} else if (seenThinking) {
			run++;
		}
	}
	closeRun();
	if (collapses === 0) return [];
	return [
		{
			rule: "thinking-collapse",
			severity: "info",
			message: `thinking blocks vanished for ${longestRun} consecutive assistant turns after being present${collapses > 1 ? ` (${collapses} such stretches)` : ""}`,
			details: { longestRun, collapses, threshold: THINKING_COLLAPSE_RUN },
		},
	];
}

/**
 * Report provider ttfb pathologies from the persisted stage timings. Incident
 * grounding (session 019fac75, a Mail-organizing task): two 164s first-byte
 * waits in the terminal three turns — one killed by the stream-stall watchdog
 * (visible to error-turns), one silently endured (invisible to everything) —
 * on top of a 10s chronic broker median. The originally hypothesised gradual
 * *trend* was falsified by progressive replay (medians flat at 1.27×; means
 * had suggested 2.4× — outlier-dominated); the trend branch stays as the cheap
 * early form, but stalls and chronic slowness are the signals with a real hit.
 */
function evaluateTtfbHealth(scan: SessionScan): HealthFindingInput[] {
	const verdict = detectTtfbHealth(scan.ttfbSeriesMs);
	if (!verdict) return [];
	const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
	const findings: HealthFindingInput[] = [];
	if (verdict.stalls) {
		findings.push({
			rule: "ttfb-stalls",
			severity: "warn",
			message: `provider stalls: ${verdict.stalls.count} turn(s) waited ≥${TTFB_STALL_MS / 1000}s for the first byte (max ${seconds(verdict.stalls.maxMs)})`,
			details: { count: verdict.stalls.count, maxMs: verdict.stalls.maxMs, thresholdMs: TTFB_STALL_MS },
		});
	}
	if (verdict.trend) {
		findings.push({
			rule: "ttfb-trend",
			severity: "warn",
			message: `provider ttfb degrading: last ${TTFB_RECENT_WINDOW} turns median ${seconds(verdict.trend.recentMs)} vs session baseline ${seconds(verdict.trend.baselineMs)} (${verdict.trend.ratio}×)`,
			details: verdict.trend,
		});
	}
	if (verdict.chronicMedianMs !== undefined) {
		findings.push({
			rule: "ttfb-chronic",
			severity: "info",
			message: `provider chronically slow: session median ttfb ${seconds(verdict.chronicMedianMs)} over ${scan.ttfbSeriesMs.length} turns — a provider/broker property, not a session event`,
			details: { medianMs: verdict.chronicMedianMs, turns: scan.ttfbSeriesMs.length },
		});
	}
	return findings;
}

/** All doctor rules, in report order. */
export const DOCTOR_RULES: readonly DoctorRule[] = [
	{ rule: "model-switch", evaluate: evaluateModelSwitch },
	{ rule: "orphan-tool-pairs", evaluate: evaluateOrphanToolPairs },
	{ rule: "error-turns", evaluate: evaluateErrorTurns },
	{ rule: "injection-volume", evaluate: evaluateInjectionVolume },
	{ rule: "oversized-messages", evaluate: evaluateOversizedMessages },
	{ rule: "thinking-collapse", evaluate: evaluateThinkingCollapse },
	{ rule: "ttfb-health", evaluate: evaluateTtfbHealth },
];

/** Stage 2: evaluate every rule against a prepared scan. */
export function evaluateScan(scan: SessionScan): HealthFindingInput[] {
	const findings: HealthFindingInput[] = [];
	for (const rule of DOCTOR_RULES) findings.push(...rule.evaluate(scan));
	return findings;
}

/**
 * Analyze persisted session entries and return findings. Reusable entry point
 * for the `omp doctor` CLI and the session-end sentinel (doctor-lite): cheap,
 * deterministic, no I/O — callers own loading (`loadEntriesFromFile`) and
 * reporting (ledger, stdout).
 */
export function analyzeSession(entries: FileEntry[]): HealthFindingInput[] {
	return evaluateScan(scanSession(entries));
}
