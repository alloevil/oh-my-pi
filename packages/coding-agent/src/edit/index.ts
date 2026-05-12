import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Static } from "@sinclair/typebox";
import * as Diff from "diff";
import type { Backend } from "../backend";
import {
	type HashlineApplyOptions,
	type HashlineEdit,
	HashlineMismatchError,
	type HashlineParams,
	hashlineEditParamsSchema,
} from "../hashline";
import { applyHashlineEdits, type HashlineApplyResult } from "../hashline/apply";
import { buildCompactHashlineDiffPreview } from "../hashline/diff-preview";
import hashlineGrammarTemplate from "../hashline/grammar.lark" with { type: "text" };
import { resolveHashlineGrammarPlaceholders } from "../hashline/hash";
import { type HashlineInputSection, splitHashlineInputs } from "../hashline/input";
import { parseHashlineWithWarnings } from "../hashline/parser";
import { tryRecoverHashlineWithCache } from "../hashline/recovery";
import {
	createLspWritethrough,
	type FileDiagnosticsResult,
	flushLspWritethroughBatch,
	type WritethroughCallback,
	type WritethroughDeferredHandle,
	writethroughNoop,
} from "../lsp";
import applyPatchDescription from "../prompts/tools/apply-patch.md" with { type: "text" };
import hashlineDescription from "../prompts/tools/hashline.md" with { type: "text" };
import patchDescription from "../prompts/tools/patch.md" with { type: "text" };
import replaceDescription from "../prompts/tools/replace.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { assertEditableFile, assertEditableFileContent } from "../tools/auto-generated-guard";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../tools/fs-cache-invalidation";
import { type OutputMeta, outputMeta } from "../tools/output-meta";
import { resolveToCwd } from "../tools/path-utils";
import { enforcePlanModeWrite, resolvePlanPath } from "../tools/plan-mode-guard";
import { throwIfAborted } from "../tools/tool-errors";
import { VimTool, vimSchema } from "../tools/vim";
import { type EditMode, normalizeEditMode, resolveEditMode } from "../utils/edit-mode";
import type { VimToolDetails } from "../vim/types";
import { generateDiffString, generateUnifiedDiffString, replaceText } from "./diff";
import { getFileReadCache } from "./file-read-cache";
import { type ApplyPatchParams, applyPatchSchema, expandApplyPatchToEntries } from "./modes/apply-patch";
import applyPatchGrammar from "./modes/apply-patch.lark" with { type: "text" };
import {
	applyPatch,
	backendPatchFs,
	mergeDiagnosticsWithWarnings,
	type PatchEditEntry,
	type FileSystem as PatchFileSystem,
	type PatchInput,
	type PatchParams,
	patchEditSchema,
} from "./modes/patch";
import {
	EditMatchError,
	findMatch,
	type MatchOutcome,
	type ReplaceEditEntry,
	type ReplaceParams,
	replaceEditSchema,
} from "./modes/replace";
import { normalizeToLF, stripBom } from "./normalize";
import { type EditToolDetails, type EditToolPerFileResult, getLspBatchRequest, type LspBatchRequest } from "./renderer";

export { DEFAULT_EDIT_MODE, type EditMode, normalizeEditMode } from "../utils/edit-mode";
export * from "./apply-patch";
export * from "./diff";
export * from "./file-read-cache";

// Resolve the `$HFMT$` and `$HSEP$` placeholders in the hashline Lark grammar.
const hashlineGrammar = resolveHashlineGrammarPlaceholders(hashlineGrammarTemplate);

export * from "../hashline";
export * from "./modes/apply-patch";
export * from "./modes/patch";
export * from "./modes/replace";
export * from "./normalize";
export * from "./renderer";
export * from "./streaming";

type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof vimSchema
	| typeof applyPatchSchema;

type VimParams = Static<typeof vimSchema>;
type EditParams = ReplaceParams | PatchParams | HashlineParams | VimParams | ApplyPatchParams;
type EditToolResultDetails = EditToolDetails | VimToolDetails;

type EditModeDefinition = {
	description: (session: ToolSession) => string;
	parameters: TInput;
	execute: (
		tool: EditTool,
		params: EditParams,
		signal: AbortSignal | undefined,
		batchRequest: LspBatchRequest | undefined,
		onUpdate?: (partialResult: AgentToolResult<EditToolResultDetails, TInput>) => void,
	) => Promise<AgentToolResult<EditToolResultDetails, TInput>>;
};

function resolveConfiguredEditMode(rawEditMode: string): EditMode | undefined {
	if (!rawEditMode || rawEditMode === "auto") {
		return undefined;
	}

	const editMode = normalizeEditMode(rawEditMode);
	if (!editMode) {
		throw new Error(`Invalid PI_EDIT_VARIANT: ${rawEditMode}`);
	}

	return editMode;
}

function resolveAllowFuzzy(session: ToolSession, rawValue: string): boolean {
	switch (rawValue) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		case "auto":
			return session.settings.get("edit.fuzzyMatch");
		default:
			throw new Error(`Invalid PI_EDIT_FUZZY: ${rawValue}`);
	}
}

function resolveFuzzyThreshold(session: ToolSession, rawValue: string): number {
	if (rawValue === "auto") {
		return session.settings.get("edit.fuzzyThreshold");
	}

	const threshold = Number.parseFloat(rawValue);
	if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
		throw new Error(`Invalid PI_EDIT_FUZZY_THRESHOLD: ${rawValue}`);
	}

	return threshold;
}

function createEditWritethrough(session: ToolSession): WritethroughCallback {
	const enableLsp = session.enableLsp ?? true;
	const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnEdit");
	const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
	return enableLsp
		? createLspWritethrough(session.cwd, { enableFormat, enableDiagnostics }, session.backend)
		: writethroughNoop;
}

interface BackendWriteProxy {
	write(content: string): Promise<number>;
}

interface BackendTextRead {
	text: string;
	etag: string | undefined;
	eol: "LF" | "CRLF" | "CR";
	bom: boolean;
}

function createBackendWriteProxy(args: {
	backend: Backend;
	path: string;
	ifMatch: string | undefined;
	onWrite?: (content: string, etag: string) => void;
}): Bun.BunFile {
	let currentIfMatch = args.ifMatch;
	const proxy: BackendWriteProxy = {
		async write(content: string): Promise<number> {
			const result = await args.backend.fs.writeLines(args.path, content, { ifMatch: currentIfMatch });
			currentIfMatch = result.etag;
			args.onWrite?.(content, result.etag);
			return result.written;
		},
	};
	return proxy as unknown as Bun.BunFile;
}

function splitDiffLines(value: string): string[] {
	const lines = value.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function buildLinePatchHunks(
	before: string,
	after: string,
): Array<{ start: number; deleted: number; inserted: string[] }> {
	const hunks: Array<{ start: number; deleted: number; inserted: string[] }> = [];
	const parts = Diff.diffLines(before, after);
	let oldLine = 1;
	for (let i = 0; i < parts.length; ) {
		const part = parts[i];
		const lines = splitDiffLines(part.value);
		if (!part.added && !part.removed) {
			oldLine += lines.length;
			i += 1;
			continue;
		}
		const start = oldLine;
		let deleted = 0;
		const inserted: string[] = [];
		while (i < parts.length && (parts[i].added || parts[i].removed)) {
			const change = parts[i];
			const changeLines = splitDiffLines(change.value);
			if (change.removed) {
				deleted += changeLines.length;
				oldLine += changeLines.length;
			} else {
				inserted.push(...changeLines);
			}
			i += 1;
		}
		hunks.push({ start, deleted, inserted });
	}
	return hunks;
}

function getHashlineApplyOptions(session: ToolSession): HashlineApplyOptions {
	return {
		autoDropPureInsertDuplicates: session.settings.get("edit.hashlineAutoDropPureInsertDuplicates"),
	};
}

function hasAnchorScopedEdit(edits: HashlineEdit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete") return true;
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function formatNoChangeDiagnostic(pathText: string): string {
	return `Edits to ${pathText} resulted in no changes being made.`;
}

function applyHashlineEditsWithRecovery(
	session: ToolSession,
	absolutePath: string,
	text: string,
	edits: HashlineEdit[],
	options: HashlineApplyOptions,
): HashlineApplyResult {
	try {
		return applyHashlineEdits(text, edits, options);
	} catch (err) {
		if (!(err instanceof HashlineMismatchError)) throw err;
		const recovered = tryRecoverHashlineWithCache({
			cache: getFileReadCache(session),
			absolutePath,
			currentText: text,
			edits,
			options,
		});
		if (!recovered) throw err;
		return {
			lines: recovered.lines,
			firstChangedLine: recovered.firstChangedLine,
			warnings: recovered.warnings,
		};
	}
}

async function readTextViaBackend(
	session: ToolSession,
	path: string,
	range?: { start: number; end: number },
): Promise<BackendTextRead> {
	const backend = session.backend;
	const read = await backend.fs.readLines(path, range ? { range } : undefined);
	getFileReadCache(session).recordContiguous(path, read.startLine, read.lines);
	return {
		text: read.lines.join("\n"),
		etag: read.etag ?? undefined,
		eol: read.eol,
		bom: read.bom,
	};
}

async function readMaybeMissingTextViaBackend(
	session: ToolSession,
	path: string,
): Promise<(BackendTextRead & { exists: true }) | { exists: false }> {
	try {
		return { exists: true, ...(await readTextViaBackend(session, path)) };
	} catch (error) {
		if (error instanceof Error && error.message === `File not found: ${path}`) {
			return { exists: false };
		}
		throw error;
	}
}

function formatOccurrenceError(path: string, matchOutcome: MatchOutcome): string {
	const previews = matchOutcome.occurrencePreviews?.join("\n\n") ?? "";
	const moreMsg =
		matchOutcome.occurrences && matchOutcome.occurrences > 5
			? ` (showing first 5 of ${matchOutcome.occurrences})`
			: "";
	return `Found ${matchOutcome.occurrences} occurrences in ${path}${moreMsg}:\n\n${previews}\n\nAdd more context lines to disambiguate.`;
}

function mergeHashlineSections(sections: HashlineInputSection[]): HashlineInputSection[] {
	const byPath = new Map<string, string[]>();
	for (const section of sections) {
		const existing = byPath.get(section.path);
		if (existing) existing.push(section.diff);
		else byPath.set(section.path, [section.diff]);
	}
	return Array.from(byPath, ([path, diffs]) => ({ path, diff: diffs.join("\n") }));
}

async function executePatchSingleViaBackend(options: {
	session: ToolSession;
	path: string;
	params: PatchEditEntry;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}): Promise<AgentToolResult<EditToolDetails>> {
	const {
		session,
		path,
		params,
		signal,
		batchRequest,
		allowFuzzy,
		fuzzyThreshold,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = options;
	const { op: rawOp, rename, diff } = params;
	const op = rawOp === "create" || rawOp === "delete" ? rawOp : "update";
	const backend = session.backend;
	const absolutePath = resolvePlanPath(session, path);
	const resolvedRename = rename ? resolvePlanPath(session, rename) : undefined;
	const resolvePatchPath = (filePath: string): string => resolveToCwd(filePath, session.cwd);
	enforcePlanModeWrite(session, path, { op, move: rename });
	await assertEditableFile(backend, absolutePath, path, { signal });
	const input: PatchInput = { path, op, rename, diff };
	let diagnostics: FileDiagnosticsResult | undefined;
	let source: BackendTextRead | undefined;
	const getSource = async (): Promise<BackendTextRead> => {
		source ??= await readTextViaBackend(session, absolutePath);
		return source;
	};
	const backendFileSystem = backendPatchFs(backend, { signal });
	const patchFileSystem: PatchFileSystem = {
		...backendFileSystem,
		async readText(filePath: string): Promise<string> {
			const resolvedPath = resolvePatchPath(filePath);
			if (resolvedPath === absolutePath) return (await getSource()).text;
			return (await readTextViaBackend(session, resolvedPath)).text;
		},
		async writeText(filePath: string, content: string): Promise<void> {
			signal?.throwIfAborted();
			const resolvedPath = resolvePatchPath(filePath);
			const currentSource = resolvedPath === absolutePath && op !== "create" ? await getSource() : undefined;
			const proxy = createBackendWriteProxy({
				backend,
				path: resolvedPath,
				ifMatch: currentSource?.etag,
			});
			const contentToWrite =
				currentSource === undefined
					? content
					: `${currentSource.bom ? "\uFEFF" : ""}${currentSource.eol === "CRLF" ? content.replaceAll("\n", "\r\n") : currentSource.eol === "CR" ? content.replaceAll("\n", "\r") : content}`;
			diagnostics = await writethrough(resolvedPath, contentToWrite, signal, proxy, batchRequest, dst =>
				dst === resolvedPath ? beginDeferredDiagnosticsForPath(resolvedPath) : undefined,
			);
		},
	};
	const result = await applyPatch(input, {
		cwd: session.cwd,
		fs: patchFileSystem,
		fuzzyThreshold,
		allowFuzzy,
	});
	signal?.throwIfAborted();
	if (resolvedRename) {
		invalidateFsScanAfterRename(absolutePath, resolvedRename);
	} else if (result.change.type === "delete") {
		invalidateFsScanAfterDelete(absolutePath);
	} else {
		invalidateFsScanAfterWrite(absolutePath);
	}
	const effectiveRename = result.change.newPath ? rename : undefined;
	let diffResult: { diff: string; firstChangedLine: number | undefined } = {
		diff: "",
		firstChangedLine: undefined,
	};
	if (result.change.type === "update" && result.change.oldContent && result.change.newContent) {
		const normalizedOld = normalizeToLF(stripBom(result.change.oldContent).text);
		const normalizedNew = normalizeToLF(stripBom(result.change.newContent).text);
		diffResult = generateUnifiedDiffString(normalizedOld, normalizedNew);
	}
	let resultText: string;
	switch (result.change.type) {
		case "create":
			resultText = `Created ${path}`;
			break;
		case "delete":
			resultText = `Deleted ${path}`;
			break;
		case "update":
			resultText = effectiveRename ? `Updated and moved ${path} to ${effectiveRename}` : `Updated ${path}`;
			break;
	}
	if (op === "delete" && batchRequest?.flush) {
		const flushedDiagnostics = await flushLspWritethroughBatch(batchRequest.id, session.cwd, signal);
		diagnostics ??= flushedDiagnostics;
	}
	const mergedDiagnostics = mergeDiagnosticsWithWarnings(diagnostics, result.warnings ?? []);
	const meta = outputMeta()
		.diagnostics(mergedDiagnostics?.summary ?? "", mergedDiagnostics?.messages ?? [])
		.get();
	return {
		content: [{ type: "text", text: resultText }],
		details: {
			diff: diffResult.diff,
			firstChangedLine: diffResult.firstChangedLine,
			diagnostics: mergedDiagnostics,
			op,
			move: effectiveRename,
			meta,
		},
	};
}

async function executeReplaceSingleViaBackend(options: {
	session: ToolSession;
	path: string;
	params: ReplaceEditEntry;
	signal?: AbortSignal;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
}): Promise<AgentToolResult<EditToolDetails>> {
	const { session, path, params, signal, allowFuzzy, fuzzyThreshold } = options;
	const backend = session.backend;
	const absolutePath = resolvePlanPath(session, path);
	enforcePlanModeWrite(session, path);
	if (params.old_text.length === 0) throw new Error("old_text must not be empty.");
	const source = await readTextViaBackend(session, absolutePath);
	assertEditableFileContent(source.text, path);
	const normalizedContent = normalizeToLF(source.text);
	const normalizedOldText = normalizeToLF(params.old_text);
	const normalizedNewText = normalizeToLF(params.new_text);
	const result = replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
		fuzzy: allowFuzzy,
		all: params.all ?? false,
		threshold: fuzzyThreshold,
	});
	if (result.count === 0) {
		const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
			allowFuzzy,
			threshold: fuzzyThreshold,
		});
		if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
			throw new Error(formatOccurrenceError(path, matchOutcome));
		}
		throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
			allowFuzzy,
			threshold: fuzzyThreshold,
			fuzzyMatches: matchOutcome.fuzzyMatches,
		});
	}
	if (normalizedContent === result.content) {
		throw new Error(`Edits to ${path} resulted in no changes being made.`);
	}
	signal?.throwIfAborted();
	await backend.edit.replace({
		path: absolutePath,
		old: normalizedOldText,
		new: normalizedNewText,
		fuzzy: allowFuzzy,
		all: params.all ?? false,
		ifMatch: source.etag,
	});
	invalidateFsScanAfterWrite(absolutePath);
	const diffResult = generateDiffString(normalizedContent, result.content);
	const resultText =
		result.count > 1
			? `Successfully replaced ${result.count} occurrences in ${path}.`
			: `Successfully replaced text in ${path}.`;
	return {
		content: [{ type: "text", text: resultText }],
		details: {
			diff: diffResult.diff,
			firstChangedLine: diffResult.firstChangedLine,
			meta: outputMeta().get(),
		},
	};
}

async function executeHashlineSingleViaBackend(options: {
	session: ToolSession;
	input: string;
	path?: string;
	signal?: AbortSignal;
}): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const { session, input, path, signal } = options;
	const backend = session.backend;
	const sections = mergeHashlineSections(splitHashlineInputs(input, { cwd: session.cwd, path }));
	const results: Array<{ path: string; result: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema> }> =
		[];
	for (const section of sections) {
		const absolutePath = resolvePlanPath(session, section.path);
		const { edits, warnings: parseWarnings } = parseHashlineWithWarnings(section.diff);
		enforcePlanModeWrite(session, section.path, { op: "update" });
		const source = await readMaybeMissingTextViaBackend(session, absolutePath);
		if (!source.exists && hasAnchorScopedEdit(edits)) throw new Error(`File not found: ${section.path}`);
		if (source.exists) assertEditableFileContent(source.text, section.path);
		const originalNormalized = source.exists ? normalizeToLF(source.text) : "";
		const result = applyHashlineEditsWithRecovery(
			session,
			absolutePath,
			originalNormalized,
			edits,
			getHashlineApplyOptions(session),
		);
		if (originalNormalized === result.lines) {
			results.push({
				path: section.path,
				result: {
					content: [{ type: "text", text: formatNoChangeDiagnostic(section.path) }],
					details: { diff: "", op: "update", meta: outputMeta().get() },
				},
			});
			continue;
		}
		signal?.throwIfAborted();
		await backend.edit.patch({
			path: absolutePath,
			hunks: buildLinePatchHunks(originalNormalized, result.lines),
			ifMatch: source.exists ? source.etag : undefined,
		});
		invalidateFsScanAfterWrite(absolutePath);
		getFileReadCache(session).recordContiguous(absolutePath, 1, result.lines.split("\n"));
		const diffResult = generateDiffString(originalNormalized, result.lines);
		const preview = buildCompactHashlineDiffPreview(diffResult.diff);
		const warnings = [...parseWarnings, ...(result.warnings ?? [])];
		const warningsBlock = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
		const previewBlock = preview.preview ? `\n${preview.preview}` : "";
		const headline = preview.preview
			? `${section.path}:`
			: source.exists
				? `Updated ${section.path}`
				: `Created ${section.path}`;
		results.push({
			path: section.path,
			result: {
				content: [{ type: "text", text: `${headline}${previewBlock}${warningsBlock}` }],
				details: {
					diff: diffResult.diff,
					firstChangedLine: result.firstChangedLine ?? diffResult.firstChangedLine,
					op: source.exists ? "update" : "create",
					meta: outputMeta().get(),
				},
			},
		});
	}
	return {
		content: [
			{
				type: "text",
				text: results
					.map(({ result }) => (result.content[0]?.type === "text" ? result.content[0].text : ""))
					.join("\n\n"),
			},
		],
		details: {
			diff: results.map(({ result }) => result.details?.diff ?? "").join("\n"),
			perFileResults: results.map(({ path: resultPath, result }) => ({
				path: resultPath,
				diff: result.details?.diff ?? "",
				firstChangedLine: result.details?.firstChangedLine,
				diagnostics: result.details?.diagnostics,
				op: result.details?.op,
				move: result.details?.move,
				meta: result.details?.meta,
			})),
		},
	};
}

/** Run apply_patch file operations and aggregate their multi-file result. */
async function executeApplyPatchPerFile(
	fileEntries: {
		path: string;
		run: (batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>;
	}[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (fileEntries.length === 1) {
		// Single file — just run directly, no wrapping
		return fileEntries[0].run(outerBatchRequest);
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];

	for (let i = 0; i < fileEntries.length; i++) {
		const { path, run } = fileEntries[i];
		const isLast = i === fileEntries.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await run(batchRequest);
			const details = result.details;
			perFileResults.push({
				path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				diagnostics: details?.diagnostics,
				op: details?.op,
				move: details?.move,
				meta: details?.meta,
			});
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			const displayErrorText = err instanceof HashlineMismatchError ? err.displayMessage : undefined;
			perFileResults.push({ path, diff: "", isError: true, errorText, displayErrorText });
			contentTexts.push(`Error editing ${path}: ${errorText}`);
		}

		// Emit partial result after each file so UI shows progressive completion
		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: perFileResults
						.map(r => r.diff)
						.filter(Boolean)
						.join("\n"),
					firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
					perFileResults: [...perFileResults],
				},
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: {
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
			perFileResults,
		},
	};
}

function appendJoinedText(current: string, next: string | undefined): string {
	if (!next) return current;
	return current ? `${current}\n${next}` : next;
}

class DiagnosticsAccumulator {
	#messages = new Set<string>();
	#summaries = new Set<string>();
	#servers = new Set<string>();
	#errored = false;
	#formatter: FileDiagnosticsResult["formatter"];

	add(diagnostics: FileDiagnosticsResult | undefined): void {
		if (!diagnostics) return;
		for (const message of diagnostics.messages) this.#messages.add(message);
		if (diagnostics.summary.length > 0) this.#summaries.add(diagnostics.summary);
		if (diagnostics.server) this.#servers.add(diagnostics.server);
		this.#errored ||= diagnostics.errored;
		this.#formatter = diagnostics.formatter ?? this.#formatter;
	}

	snapshot(): FileDiagnosticsResult | undefined {
		if (this.#messages.size === 0 && this.#summaries.size === 0 && this.#servers.size === 0 && !this.#errored) {
			return undefined;
		}
		return {
			server: this.#servers.size === 1 ? this.#servers.values().next().value : undefined,
			messages: [...this.#messages],
			summary: [...this.#summaries].join("; "),
			errored: this.#errored,
			formatter: this.#formatter,
		};
	}
}

function mergeOutputMetas(
	metas: Array<OutputMeta | undefined>,
	diagnostics: FileDiagnosticsResult | undefined,
): OutputMeta | undefined {
	const merged: OutputMeta = {};
	let hasMeta = false;
	for (const meta of metas) {
		if (!meta) continue;
		if (meta.truncation !== undefined) {
			merged.truncation = meta.truncation;
			hasMeta = true;
		}
		if (meta.source !== undefined) {
			merged.source = meta.source;
			hasMeta = true;
		}
		if (meta.limits !== undefined) {
			merged.limits = meta.limits;
			hasMeta = true;
		}
	}

	if (diagnostics) {
		merged.diagnostics = {
			summary: diagnostics.summary,
			messages: diagnostics.messages,
		};
		hasMeta = true;
	}

	return hasMeta ? merged : undefined;
}

async function executeSinglePathEntries(
	path: string,
	runs: ((batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>)[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
	signal?: AbortSignal,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	throwIfAborted(signal);
	if (runs.length === 1) {
		return runs[0](outerBatchRequest);
	}

	let contentText = "";
	let diffText = "";
	const diagnostics = new DiagnosticsAccumulator();
	const metas: OutputMeta[] = [];
	const perFileResults: EditToolPerFileResult[] = [];
	let firstChangedLine: number | undefined;
	let errorCount = 0;

	for (let i = 0; i < runs.length; i++) {
		throwIfAborted(signal);
		const isLast = i === runs.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await runs[i](batchRequest);
			throwIfAborted(signal);
			const details = result.details;
			diffText = appendJoinedText(diffText, details?.diff);
			firstChangedLine ??= details?.firstChangedLine;
			diagnostics.add(details?.diagnostics);
			if (details?.meta) metas.push(details.meta);
			perFileResults.push({
				path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				diagnostics: details?.diagnostics,
				op: details?.op,
				move: details?.move,
				meta: details?.meta,
			});
			contentText = appendJoinedText(contentText, result.content?.find(c => c.type === "text")?.text);
		} catch (err) {
			if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
				throwIfAborted(signal);
				throw err;
			}
			const errorText = err instanceof Error ? err.message : String(err);
			const displayErrorText = err instanceof HashlineMismatchError ? err.displayMessage : undefined;
			perFileResults.push({ path, diff: "", isError: true, errorText, displayErrorText });
			contentText = appendJoinedText(contentText, `Error editing ${path}: ${errorText}`);
			errorCount++;
			break;
		}

		if (!isLast && onUpdate) {
			const mergedDiagnostics = diagnostics.snapshot();
			onUpdate({
				content: [{ type: "text", text: contentText }],
				details: {
					diff: diffText,
					firstChangedLine,
					diagnostics: mergedDiagnostics,
					meta: mergeOutputMetas(metas, mergedDiagnostics),
					perFileResults: [...perFileResults],
				},
				...(errorCount > 0 ? { isError: true } : {}),
			});
		}
	}

	const mergedDiagnostics = diagnostics.snapshot();
	return {
		content: [{ type: "text", text: contentText }],
		details: {
			diff: diffText,
			firstChangedLine,
			diagnostics: mergedDiagnostics,
			meta: mergeOutputMetas(metas, mergedDiagnostics),
			perFileResults,
		},
		// Any per-entry failure marks the aggregate result as an error so the
		// renderer takes the error branch instead of falling through to the
		// streaming-edit preview (which displays the *proposed* diff and looks
		// indistinguishable from success).
		...(errorCount > 0 ? { isError: true } : {}),
	};
}

export class EditTool implements AgentTool<TInput> {
	readonly name = "edit";
	readonly label = "Edit";
	readonly loadMode = "essential";
	readonly nonAbortable = true;
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #editMode?: EditMode;
	readonly #vimTool: VimTool;
	readonly #pendingDeferredFetches = new Map<string, AbortController>();

	constructor(private readonly session: ToolSession) {
		const {
			PI_EDIT_FUZZY: editFuzzy = "auto",
			PI_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			PI_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;

		this.#editMode = resolveConfiguredEditMode(envEditVariant);
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
		this.#writethrough = createEditWritethrough(session);
		this.#vimTool = new VimTool(session);
	}

	get mode(): EditMode {
		if (this.#editMode) return this.#editMode;
		return resolveEditMode(this.session);
	}

	get description(): string {
		return this.#getModeDefinition().description(this.session);
	}

	get parameters(): TInput {
		return this.#getModeDefinition().parameters;
	}

	/**
	 * When in `apply_patch` mode, expose the Codex Lark grammar so providers
	 * that support OpenAI-style custom tools can emit a grammar-constrained
	 * variant. Providers that don't support custom tools ignore this field
	 * and fall back to emitting a JSON function tool from `parameters`.
	 */
	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		if (this.mode === "apply_patch") return { syntax: "lark", definition: applyPatchGrammar };
		if (this.mode === "hashline") return { syntax: "lark", definition: hashlineGrammar };
		return undefined;
	}

	/**
	 * Wire-level tool name used when the custom-tool variant is active. GPT-5+
	 * is trained on the literal name `apply_patch`; internally this is just a
	 * mode of the `edit` tool. The agent-loop dispatcher matches both the
	 * internal `name` and `customWireName`, so returned calls route correctly.
	 */
	get customWireName(): string | undefined {
		if (this.mode !== "apply_patch") return undefined;
		return "apply_patch";
	}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolResultDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolResultDetails, TInput>> {
		const modeDefinition = this.#getModeDefinition();
		return modeDefinition.execute(this, params, signal, getLspBatchRequest(context?.toolCall), onUpdate);
	}

	#getModeDefinition(): EditModeDefinition {
		return {
			patch: {
				description: () => prompt.render(patchDescription),
				parameters: patchEditSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as PatchParams;
					const runs = (edits as PatchEditEntry[]).map(
						entry => (br: LspBatchRequest | undefined) =>
							executePatchSingleViaBackend({
								session: tool.session,
								path,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
							}),
					);
					return executeSinglePathEntries(path, runs, batchRequest, onUpdate, signal);
				},
			},
			apply_patch: {
				description: () => prompt.render(applyPatchDescription),
				parameters: applyPatchSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const entries = expandApplyPatchToEntries(params as ApplyPatchParams);
					const perFile = entries.map(entry => {
						const { path, ...patchParams } = entry;
						return {
							path,
							run: (br: LspBatchRequest | undefined) =>
								executePatchSingleViaBackend({
									session: tool.session,
									path,
									params: patchParams,
									signal,
									batchRequest: br,
									allowFuzzy: tool.#allowFuzzy,
									fuzzyThreshold: tool.#fuzzyThreshold,
									writethrough: tool.#writethrough,
									beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
								}),
						};
					});
					return executeApplyPatchPerFile(perFile, batchRequest, onUpdate);
				},
			},
			hashline: {
				description: () => prompt.render(hashlineDescription),
				parameters: hashlineEditParamsSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					_batchRequest: LspBatchRequest | undefined,
					_onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { input, path } = params as HashlineParams & { path?: string };
					return executeHashlineSingleViaBackend({
						session: tool.session,
						input,
						path,
						signal,
					});
				},
			},
			replace: {
				description: () => prompt.render(replaceDescription),
				parameters: replaceEditSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as ReplaceParams;
					const runs = (edits as ReplaceEditEntry[]).map(
						entry => (_br: LspBatchRequest | undefined) =>
							executeReplaceSingleViaBackend({
								session: tool.session,
								path,
								params: entry,
								signal,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
							}),
					);
					return executeSinglePathEntries(path, runs, batchRequest, onUpdate, signal);
				},
			},
			vim: {
				description: () => this.#vimTool.description,
				parameters: vimSchema,
				execute: async (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					_batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolResultDetails, TInput>) => void,
				) => {
					const handleUpdate = onUpdate
						? (partialResult: AgentToolResult<VimToolDetails>) => {
								onUpdate(partialResult as AgentToolResult<EditToolResultDetails, TInput>);
							}
						: undefined;
					return (await tool.#vimTool.execute(
						"edit",
						params as VimParams,
						signal,
						handleUpdate,
					)) as AgentToolResult<EditToolResultDetails, TInput>;
				},
			},
		}[this.mode];
	}

	#beginDeferredDiagnosticsForPath(path: string): WritethroughDeferredHandle {
		const existingDeferred = this.#pendingDeferredFetches.get(path);
		if (existingDeferred) {
			existingDeferred.abort();
			this.#pendingDeferredFetches.delete(path);
		}

		const deferredController = new AbortController();
		return {
			onDeferredDiagnostics: (lateDiagnostics: FileDiagnosticsResult) => {
				this.#pendingDeferredFetches.delete(path);
				this.#injectLateDiagnostics(path, lateDiagnostics);
			},
			signal: deferredController.signal,
			finalize: (diagnostics: FileDiagnosticsResult | undefined) => {
				if (!diagnostics) {
					this.#pendingDeferredFetches.set(path, deferredController);
				} else {
					deferredController.abort();
				}
			},
		};
	}

	#injectLateDiagnostics(path: string, diagnostics: FileDiagnosticsResult): void {
		const summary = diagnostics.summary ?? "";
		const lines = diagnostics.messages ?? [];
		const body = [`Late LSP diagnostics for ${path} (arrived after the edit tool returned):`, summary, ...lines]
			.filter(Boolean)
			.join("\n");

		this.session.queueDeferredMessage?.({
			role: "custom",
			customType: "lsp-late-diagnostic",
			content: body,
			display: false,
			timestamp: Date.now(),
		});
	}
}
