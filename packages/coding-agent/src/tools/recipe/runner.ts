import * as path from "node:path";
import type { Backend } from "../../backend/backend";
import { ToolError } from "../tool-errors";

export type RecipeBackend = Pick<Backend, "fs" | "shell">;

export interface RecipeShellResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const textDecoder = new TextDecoder();

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readBackendTextIfExists(backend: RecipeBackend, filePath: string): Promise<string> {
	try {
		return readBackendText(backend, filePath);
	} catch {
		return "";
	}
}

export async function isBackendFile(backend: RecipeBackend, filePath: string): Promise<boolean> {
	const stat = await backend.fs.stat(filePath);
	return stat.exists && stat.kind === "file";
}

export async function readBackendText(backend: RecipeBackend, filePath: string): Promise<string> {
	const blob = await backend.fs.readBlob(filePath);
	return textDecoder.decode(blob.bytes);
}

export async function execRecipeCommand(
	backend: RecipeBackend,
	cwd: string,
	command: string,
): Promise<RecipeShellResult> {
	const stdoutPath = path.join(cwd, `.omp-recipe-stdout-${crypto.randomUUID()}`);
	const stderrPath = path.join(cwd, `.omp-recipe-stderr-${crypto.randomUUID()}`);
	const redirected = `${command} > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}`;
	let exitCode: number | null = null;
	for await (const event of backend.shell.exec({ command: redirected, cwd })) {
		if (event.type === "exit") exitCode = event.exitCode;
	}
	try {
		const [stdout, stderr] = await Promise.all([
			readBackendTextIfExists(backend, stdoutPath),
			readBackendTextIfExists(backend, stderrPath),
		]);
		return { exitCode: exitCode ?? 0, stdout, stderr };
	} finally {
		await Promise.allSettled([backend.fs.delete(stdoutPath), backend.fs.delete(stderrPath)]);
	}
}

export interface RunnerTask {
	name: string;
	doc?: string;
	/** Parameter names only; used for the `name foo bar` signature line in the description. */
	parameters: string[];
	/** Override for this specific task, e.g. `cargo run --package crate --bin`. */
	commandPrefix?: string;
	/** Token passed to the runner command; defaults to `name`. Used when display names are namespaced. */
	commandName?: string;
	/** Working directory for the task, relative to the session cwd; absent means the runner's root cwd. */
	cwd?: string;
}

export interface DetectedRunner {
	id: string;
	label: string;
	/** Resolved shell prefix, e.g. "just" or "bun run" or "make". */
	commandPrefix: string;
	tasks: RunnerTask[];
}

export interface TaskRunner {
	id: string;
	label: string;
	/**
	 * Probe `cwd` for the manifest, the binary, and the task list.
	 * Returns null when this runner does not apply.
	 */
	detect(cwd: string, backend: RecipeBackend): Promise<DetectedRunner | null>;
}

interface ParsedOp {
	head: string;
	tail: string;
}

interface PromptTaskModel {
	name: string;
	paramSig?: string;
	command?: string;
	doc?: string;
	cwd?: string;
}

const PROMPT_TASK_LIMIT = 20;

interface PromptRunnerModel {
	id: string;
	label: string;
	commandPrefix: string;
	tasks: PromptTaskModel[];
	hiddenTaskCount?: number;
}

export interface RecipePromptModel {
	[key: string]: unknown;
	hasMultipleRunners: boolean;
	ambiguityExampleRunner?: string;
	ambiguityExampleTask?: string;
	runners: PromptRunnerModel[];
}

function parseOp(op: string): ParsedOp {
	const trimmedStart = op.trimStart();
	if (trimmedStart.length === 0) return { head: "", tail: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(trimmedStart);
	return { head: match?.[1] ?? "", tail: match?.[2] ?? "" };
}

function hasTask(runner: DetectedRunner, taskName: string): boolean {
	return runner.tasks.some(task => task.name === taskName);
}

function findMatchingRunners(taskName: string, runners: DetectedRunner[]): DetectedRunner[] {
	return runners.filter(runner => hasTask(runner, taskName));
}

function formatAvailableTasks(runners: DetectedRunner[]): string {
	return runners
		.map(runner => {
			const names = runner.tasks.map(task => task.name).join(", ");
			return `- ${runner.id}: ${names || "(no tasks)"}`;
		})
		.join("\n");
}

function formatRunnerIds(runners: DetectedRunner[]): string {
	return runners.map(runner => runner.id).join(", ");
}
function findExplicitRunnerTask(
	head: string,
	runners: DetectedRunner[],
): { runner: DetectedRunner; task: RunnerTask } | undefined {
	for (const runner of runners) {
		const runnerPrefix = `${runner.id}:`;
		if (!head.startsWith(runnerPrefix)) continue;
		const taskName = head.slice(runnerPrefix.length);
		if (!taskName) return undefined;
		const task = runner.tasks.find(candidate => candidate.name === taskName);
		if (task) {
			return { runner, task };
		}
		return undefined;
	}
	return undefined;
}

function buildCommand(commandPrefix: string, taskName: string, tail: string): string {
	return [commandPrefix, taskName, tail]
		.filter(part => part.trim().length > 0)
		.join(" ")
		.trim();
}

function resolveRunnerAndTask(
	op: string,
	runners: DetectedRunner[],
): { runner: DetectedRunner; task: RunnerTask; tail: string } {
	const { head, tail } = parseOp(op);
	if (!head) {
		throw new ToolError(`recipe op is empty. Available tasks:\n${formatAvailableTasks(runners)}`);
	}

	const matches = findMatchingRunners(head, runners);
	if (matches.length === 1) {
		return { runner: matches[0]!, task: matches[0]!.tasks.find(task => task.name === head)!, tail };
	}
	if (matches.length > 1) {
		const ids = matches.map(runner => runner.id).join(", ");
		throw new ToolError(
			`Task \`${head}\` exists in multiple runners (${ids}). Use \`<runner-id>:<task>\`, for example \`${matches[0]!.id}:${head}\`. Available tasks:\n${formatAvailableTasks(runners)}`,
		);
	}

	const explicit = findExplicitRunnerTask(head, runners);
	if (explicit) {
		return { runner: explicit.runner, task: explicit.task, tail };
	}

	throw new ToolError(
		`No runner task named \`${head}\`. Use one of the available runner ids (${formatRunnerIds(runners)}) as a prefix when needed, e.g. \`pkg:${head}\`. Available tasks:\n${formatAvailableTasks(runners)}`,
	);
}

export interface ResolvedTask {
	command: string;
	cwd?: string;
}

export function resolveCommand(op: string, runners: DetectedRunner[]): ResolvedTask {
	const { runner, task, tail } = resolveRunnerAndTask(op, runners);
	const command = buildCommand(task.commandPrefix ?? runner.commandPrefix, task.commandName ?? task.name, tail);
	return task.cwd ? { command, cwd: task.cwd } : { command };
}

export function resolveTaskFromOp(op: string | undefined, runners: DetectedRunner[]): ResolvedTask | undefined {
	if (!op) return undefined;
	try {
		return resolveCommand(op, runners);
	} catch {
		return undefined;
	}
}

export function commandFromOp(op: string | undefined, runners: DetectedRunner[]): string | undefined {
	return resolveTaskFromOp(op, runners)?.command;
}

export function cwdFromOp(op: string | undefined, runners: DetectedRunner[]): string | undefined {
	return resolveTaskFromOp(op, runners)?.cwd;
}

export function titleFromOp(op: string | undefined, runners: DetectedRunner[]): string {
	if (!op) return "Run";
	const { head } = parseOp(op);
	if (!head) return "Run";
	const matches = findMatchingRunners(head, runners);
	if (matches.length === 1) {
		return matches[0]!.label;
	}
	const explicit = findExplicitRunnerTask(head, runners);
	return explicit?.runner.label ?? "Run";
}

function findAmbiguityExample(runners: DetectedRunner[]): { runner: string; task: string } | undefined {
	const seen = new Map<string, string>();
	for (const runner of runners) {
		for (const task of runner.tasks) {
			const previousRunner = seen.get(task.name);
			if (previousRunner) return { runner: previousRunner, task: task.name };
			seen.set(task.name, runner.id);
		}
	}
	const firstRunner = runners[0];
	const firstTask = firstRunner?.tasks[0];
	return firstRunner && firstTask ? { runner: firstRunner.id, task: firstTask.name } : undefined;
}

export function buildPromptModel(runners: DetectedRunner[]): RecipePromptModel {
	const ambiguityExample = findAmbiguityExample(runners);
	return {
		hasMultipleRunners: runners.length > 1,
		ambiguityExampleRunner: ambiguityExample?.runner,
		ambiguityExampleTask: ambiguityExample?.task,
		runners: runners.map(runner => ({
			id: runner.id,
			label: runner.label,
			commandPrefix: runner.commandPrefix,
			tasks: runner.tasks.slice(0, PROMPT_TASK_LIMIT).map(task => ({
				name: task.name,
				paramSig: task.parameters.length > 0 ? task.parameters.join(" ") : undefined,
				command: buildCommand(task.commandPrefix ?? runner.commandPrefix, task.commandName ?? task.name, ""),
				doc: task.doc,
				cwd: task.cwd,
			})),
			hiddenTaskCount: runner.tasks.length > PROMPT_TASK_LIMIT ? runner.tasks.length - PROMPT_TASK_LIMIT : undefined,
		})),
	};
}
