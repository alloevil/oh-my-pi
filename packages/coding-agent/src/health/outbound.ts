/**
 * Outbound provider-request summaries — "what did the model actually see".
 *
 * A per-request summary (system-prompt section sizes, message/tool counts,
 * model) is recorded on the provider request path and persisted as an
 * `outbound_summary` custom entry in the session JSONL. Everything here is
 * pure string-length math over the already-built provider context: no
 * serialization of message payloads, no raw-byte retention.
 *
 * Consumers: the request tap in `sdk.ts` (write side) and
 * `omp doctor --outbound` (read side, {@link collectOutboundSummaries} +
 * {@link diffOutboundSummaries}).
 */
import type { Message } from "@oh-my-pi/pi-ai";
import type { FileEntry } from "../session/session-entries";

/** `customType` of persisted per-request summaries. */
export const OUTBOUND_SUMMARY_CUSTOM_TYPE = "outbound_summary";
/** How many trailing summaries readers keep (the file itself is append-only). */
export const OUTBOUND_SUMMARY_RING_SIZE = 32;
/** Relative size change beyond which a section counts as resized in a diff. */
const SECTION_RESIZE_RATIO = 0.1;

/**
 * One system-prompt section. The real system prompt uses two delimiter styles
 * (see `prompts/system/system-prompt.md`): banner headings (`ROLE` followed by
 * a `====…` underline) for top-level sections and markdown `#`-headings for
 * subsections. Both are split so diffs point at the exact block that moved.
 */
export interface OutboundSectionSummary {
	/** Raw heading line, trimmed (`ROLE`, `# Tool I/O`, or `(preamble)`). */
	heading: string;
	/** Section span in characters, heading line included. */
	chars: number;
}

/** Compact per-request payload summary persisted to the session file. */
export interface OutboundRequestSummary {
	/** Unix ms when the request was dispatched. */
	timestamp: number;
	/** Model id the request targeted. */
	model: string;
	systemPromptChars: number;
	systemPromptSections: OutboundSectionSummary[];
	messageCount: number;
	/** Approximate message payload size (content-block string lengths). */
	messageChars: number;
	toolCount: number;
	/** Sorted tool names. */
	toolNames: string[];
	/** Reasoning effort in force, when the agent exposes one. */
	thinkingLevel?: string;
}

/** Input to {@link summarizeOutboundRequest} — the final provider context. */
export interface OutboundRequestInput {
	model: string;
	systemPrompt?: readonly string[];
	messages: readonly Message[];
	tools?: ReadonlyArray<{ name: string }>;
	thinkingLevel?: string;
	timestamp?: number;
}

// Either a markdown heading line or a banner heading (line underlined by 4+
// `=`). The banner alternative requires a non-empty heading line so a stray
// `====` divider without a title never matches.
const HEADING_RE = /^(#{1,3} \S.*)$|^([^\s=][^\n]*)\n={4,}[ \t]*$/gm;

/**
 * Split one system-prompt part into sections, appending to `out`. A section
 * spans from its heading line to the next heading (or end of text); leading
 * text before the first heading is reported as `(preamble)`.
 */
export function splitSystemPromptSections(text: string, out: OutboundSectionSummary[] = []): OutboundSectionSummary[] {
	let heading = "(preamble)";
	let start = 0;
	HEADING_RE.lastIndex = 0;
	for (let match = HEADING_RE.exec(text); match !== null; match = HEADING_RE.exec(text)) {
		if (match.index > start || heading !== "(preamble)") {
			out.push({ heading, chars: match.index - start });
		}
		heading = (match[1] ?? match[2] ?? "").trim();
		start = match.index;
	}
	if (text.length > start || heading !== "(preamble)") {
		out.push({ heading, chars: text.length - start });
	}
	return out;
}

/**
 * Approximate one message's wire size from content-block string lengths.
 * Deliberately NOT `JSON.stringify` — images count their base64 length, tool
 * calls count key + string-argument lengths, envelope/metadata is ignored.
 */
function approximateMessageChars(message: Message): number {
	const content = message.content;
	if (typeof content === "string") return content.length;
	let total = 0;
	for (const block of content) {
		switch (block.type) {
			case "text":
				total += block.text.length;
				break;
			case "thinking":
				total += block.thinking.length;
				break;
			case "image":
				total += block.data.length;
				break;
			case "toolCall":
				total += block.name.length;
				for (const key in block.arguments) {
					const value = block.arguments[key];
					total += key.length + (typeof value === "string" ? value.length : 8);
				}
				break;
			default:
				// Redacted thinking / provider-native blocks: opaque, skip.
				break;
		}
	}
	return total;
}

/** Reduce a final provider request to a compact, persistable summary. */
export function summarizeOutboundRequest(input: OutboundRequestInput): OutboundRequestSummary {
	let systemPromptChars = 0;
	const systemPromptSections: OutboundSectionSummary[] = [];
	for (const part of input.systemPrompt ?? []) {
		systemPromptChars += part.length;
		splitSystemPromptSections(part, systemPromptSections);
	}
	let messageChars = 0;
	for (const message of input.messages) messageChars += approximateMessageChars(message);
	const toolNames = (input.tools ?? []).map(tool => tool.name).sort();
	const summary: OutboundRequestSummary = {
		timestamp: input.timestamp ?? Date.now(),
		model: input.model,
		systemPromptChars,
		systemPromptSections,
		messageCount: input.messages.length,
		messageChars,
		toolCount: toolNames.length,
		toolNames,
	};
	if (input.thinkingLevel !== undefined) summary.thinkingLevel = input.thinkingLevel;
	return summary;
}

/** Sum section sizes per heading (duplicate headings across parts merge). */
function sectionSizesByHeading(sections: readonly OutboundSectionSummary[]): Map<string, number> {
	const sizes = new Map<string, number>();
	for (const section of sections) {
		sizes.set(section.heading, (sizes.get(section.heading) ?? 0) + section.chars);
	}
	return sizes;
}

/**
 * Human-readable differences between two consecutive request summaries.
 * Reports model changes, tool-set changes, and sections that were added,
 * removed, or resized by more than {@link SECTION_RESIZE_RATIO}. Returns an
 * empty array when nothing structural moved.
 */
export function diffOutboundSummaries(a: OutboundRequestSummary, b: OutboundRequestSummary): string[] {
	const diffs: string[] = [];
	if (a.model !== b.model) diffs.push(`model ${a.model} → ${b.model}`);
	const beforeTools = new Set(a.toolNames);
	const afterTools = new Set(b.toolNames);
	for (const name of b.toolNames) if (!beforeTools.has(name)) diffs.push(`+tool ${name}`);
	for (const name of a.toolNames) if (!afterTools.has(name)) diffs.push(`-tool ${name}`);
	const beforeSections = sectionSizesByHeading(a.systemPromptSections);
	const afterSections = sectionSizesByHeading(b.systemPromptSections);
	for (const [heading, chars] of afterSections) {
		const previous = beforeSections.get(heading);
		if (previous === undefined) {
			diffs.push(`+section "${heading}" (${chars}ch)`);
		} else if (previous > 0 && Math.abs(chars - previous) / previous > SECTION_RESIZE_RATIO) {
			const percent = Math.round(((chars - previous) / previous) * 100);
			diffs.push(`section "${heading}" ${previous}→${chars}ch (${percent > 0 ? "+" : ""}${percent}%)`);
		}
	}
	for (const [heading, chars] of beforeSections) {
		if (!afterSections.has(heading)) diffs.push(`-section "${heading}" (${chars}ch)`);
	}
	return diffs;
}

/** Validate one persisted `outbound_summary` payload; undefined when malformed. */
export function parseOutboundSummary(data: unknown): OutboundRequestSummary | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.model !== "string") return undefined;
	if (typeof record.systemPromptChars !== "number" || typeof record.messageCount !== "number") return undefined;
	const sections: OutboundSectionSummary[] = [];
	if (Array.isArray(record.systemPromptSections)) {
		for (const section of record.systemPromptSections) {
			if (
				section !== null &&
				typeof section === "object" &&
				typeof (section as OutboundSectionSummary).heading === "string" &&
				typeof (section as OutboundSectionSummary).chars === "number"
			) {
				sections.push({
					heading: (section as OutboundSectionSummary).heading,
					chars: (section as OutboundSectionSummary).chars,
				});
			}
		}
	}
	const toolNames = Array.isArray(record.toolNames)
		? record.toolNames.filter((name): name is string => typeof name === "string")
		: [];
	const summary: OutboundRequestSummary = {
		timestamp: typeof record.timestamp === "number" ? record.timestamp : 0,
		model: record.model,
		systemPromptChars: record.systemPromptChars,
		systemPromptSections: sections,
		messageCount: record.messageCount,
		messageChars: typeof record.messageChars === "number" ? record.messageChars : 0,
		toolCount: typeof record.toolCount === "number" ? record.toolCount : toolNames.length,
		toolNames,
	};
	if (typeof record.thinkingLevel === "string") summary.thinkingLevel = record.thinkingLevel;
	return summary;
}

/**
 * Collect persisted outbound summaries from session entries, keeping only the
 * trailing {@link OUTBOUND_SUMMARY_RING_SIZE} (the ring bound: the JSONL is
 * append-only, so the cap is enforced on read).
 */
export function collectOutboundSummaries(
	entries: readonly FileEntry[],
	cap = OUTBOUND_SUMMARY_RING_SIZE,
): OutboundRequestSummary[] {
	const ring: OutboundRequestSummary[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== OUTBOUND_SUMMARY_CUSTOM_TYPE) continue;
		const summary = parseOutboundSummary(entry.data);
		if (summary === undefined) continue;
		if (ring.length === cap) ring.shift();
		ring.push(summary);
	}
	return ring;
}
