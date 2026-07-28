#!/usr/bin/env bun
/**
 * Canary edit gate: scores the coding agent's edit-tool capability with a
 * deliberately weak model on a small pinned slice of the TypeScript edit
 * benchmark (packages/typescript-edit-benchmark).
 *
 * Each pinned task is a single-file bug fix: the agent gets the task prompt
 * in a temp workdir seeded with the mutated input file and must produce an
 * exact (whitespace-tolerant) match against the expected fixture. Pass rate
 * is compared against edit-baseline.json; a drop of more than
 * CANARY_EDIT_TOLERANCE tasks exits non-zero.
 *
 * Env:
 *   CANARY_MODEL           provider/model-id   (default anthropic/claude-haiku-4-5)
 *   CANARY_SKIP_EDIT=1     skip the gate entirely (exit 0)
 *   CANARY_EDIT_TOLERANCE  allowed drop in passed tasks (default 1)
 * Flags:
 *   --write-baseline  overwrite edit-baseline.json with this run's scores
 *
 * CI-safe: with no resolvable credentials it prints SKIPPED and exits 0.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	discoverSharedInfra,
	InProcessClient,
	type SharedInfra,
} from "@oh-my-pi/typescript-edit-benchmark/in-process-client";
import { type EditTask, loadTasksFromDir } from "@oh-my-pi/typescript-edit-benchmark/tasks";
import { verifyExpectedFiles } from "@oh-my-pi/typescript-edit-benchmark/verify";

const CANARY_DIR = path.dirname(Bun.fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(CANARY_DIR, "edit-baseline.json");
const FIXTURES_ARCHIVE = path.join(CANARY_DIR, "..", "..", "packages", "typescript-edit-benchmark", "fixtures.tar.gz");

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const CONCURRENCY = 4;
const TASK_TIMEOUT_MS = 150_000;

/**
 * Pinned task slice: one per mutation family, first seed of each. Pinning by
 * id (instead of stride-sampling) makes fixture regeneration fail loudly here
 * instead of silently invalidating the baseline.
 */
const PINNED_TASK_IDS = [
	"access-remove-optional-chain-001",
	"call-swap-call-args-001",
	"duplicate-duplicate-line-flip-001",
	"identifier-identifier-multi-edit-001",
	"import-swap-named-imports-001",
	"literal-flip-boolean-001",
	"literal-off-by-one-001",
	"operator-remove-negation-001",
	"operator-swap-comparison-001",
	"regex-swap-regex-quantifier-001",
	"structural-swap-if-else-001",
	"unicode-unicode-hyphen-001",
];

const SYSTEM_PROMPT = `You are participating in a code-edit benchmark scored by exact text diff.
- Make the minimum change necessary; there is exactly one intended fix.
- Do not refactor, reformat, rearrange, or "improve" anything else.
- Never modify comments or license headers unless the task asks.
- Re-read the changed region after editing to confirm you only touched the intended line(s).`;

interface EditBaseline {
	status: "ok" | "unset";
	model: string;
	tasks: string[];
	passed: number | null;
	perTask: Record<string, boolean>;
	generatedAt: string | null;
	note?: string;
}

interface TaskVerdict {
	task: EditTask;
	passed: boolean;
	detail: string;
	durationMs: number;
}

/** Resolve the model through the same registry the interactive CLI uses. Undefined → SKIPPED. */
async function resolveModel(spec: string): Promise<Model<Api> | undefined> {
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`CANARY_MODEL must be <provider>/<model-id>, got "${spec}"`);
	const provider = spec.slice(0, slash);
	const modelId = spec.slice(slash + 1);
	try {
		const storage = await discoverAuthStorage();
		try {
			const registry = new ModelRegistry(storage);
			const available = await registry.getAvailable();
			const model = available.find(entry => entry.provider === provider && entry.id === modelId);
			if (!model) return undefined;
			const apiKey = await registry.getApiKey(model);
			return apiKey ? model : undefined;
		} finally {
			storage.close();
		}
	} catch {
		return undefined;
	}
}

async function extractFixtures(): Promise<{ dir: string; temp: TempDir }> {
	const temp = await TempDir.create("@canary-edit-fixtures-");
	const archive = new Bun.Archive(await Bun.file(FIXTURES_ARCHIVE).arrayBuffer());
	for (const [filePath, file] of await archive.files()) {
		await Bun.write(path.join(temp.path(), filePath), file);
	}
	const entries = await fs.readdir(temp.path(), { withFileTypes: true });
	const directories = entries.filter(entry => entry.isDirectory());
	const files = entries.filter(entry => entry.isFile());
	const dir =
		directories.length === 1 && files.length === 0 ? path.join(temp.path(), directories[0].name) : temp.path();
	return { dir, temp };
}

async function runTask(task: EditTask, modelSpec: string, shared: SharedInfra, workRoot: string): Promise<TaskVerdict> {
	const started = Date.now();
	const cwd = path.join(workRoot, task.id);
	await fs.mkdir(cwd, { recursive: true });
	for (const file of task.files) {
		await Bun.write(path.join(cwd, file), Bun.file(path.join(task.inputDir, file)));
	}

	const client = new InProcessClient({
		cwd,
		agentId: `CanaryEdit-${task.id}`,
		model: modelSpec,
		appendSystemPrompt: SYSTEM_PROMPT,
		tools: ["read", "edit", "write"],
		shared,
	});
	try {
		await client.start();
		let timer: Timer | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				client.abort();
				reject(new Error(`timed out after ${TASK_TIMEOUT_MS / 1000}s`));
			}, TASK_TIMEOUT_MS);
		});
		try {
			await Promise.race([client.prompt(task.prompt), timeout]);
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		return {
			task,
			passed: false,
			detail: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - started,
		};
	} finally {
		await client.dispose().catch(() => {});
	}

	const verification = await verifyExpectedFiles(task.expectedDir, cwd);
	return {
		task,
		passed: verification.success,
		detail: verification.success ? "ok" : (verification.mismatchedFiles ?? []).join(", ") || "mismatch",
		durationMs: Date.now() - started,
	};
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

async function main(): Promise<number> {
	if (Bun.env.CANARY_SKIP_EDIT === "1") {
		console.log("canary-edit-gate: SKIPPED — CANARY_SKIP_EDIT=1");
		return 0;
	}
	const modelSpec = Bun.env.CANARY_MODEL || DEFAULT_MODEL;
	const toleranceRaw = Number.parseInt(Bun.env.CANARY_EDIT_TOLERANCE ?? "", 10);
	const tolerance = Number.isFinite(toleranceRaw) && toleranceRaw >= 0 ? toleranceRaw : 1;
	const writeBaseline = Bun.argv.includes("--write-baseline");

	const model = await resolveModel(modelSpec);
	if (!model) {
		console.log(
			`canary-edit-gate: SKIPPED — no credentials resolve for "${modelSpec}" (omp login or provider env var required)`,
		);
		return 0;
	}

	const fixtures = await extractFixtures();
	const workRoot = await TempDir.create("@canary-edit-work-");
	try {
		const allTasks = await loadTasksFromDir(fixtures.dir);
		const byId = new Map(allTasks.map(task => [task.id, task]));
		const missing = PINNED_TASK_IDS.filter(id => !byId.has(id));
		if (missing.length > 0) {
			throw new Error(
				`pinned tasks missing from fixtures (fixtures regenerated? update PINNED_TASK_IDS + baseline): ${missing.join(", ")}`,
			);
		}
		const tasks = PINNED_TASK_IDS.map(id => byId.get(id)!);

		console.log(`canary-edit-gate: model=${modelSpec} tasks=${tasks.length} tolerance=${tolerance} task(s)`);
		const shared = await discoverSharedInfra({ cwd: workRoot.path() });
		const verdicts = await mapLimit(tasks, CONCURRENCY, task => runTask(task, modelSpec, shared, workRoot.path()));

		const passed = verdicts.filter(verdict => verdict.passed).length;
		const perTask: Record<string, boolean> = {};
		for (const verdict of verdicts) {
			perTask[verdict.task.id] = verdict.passed;
			const mark = verdict.passed ? "pass" : "FAIL";
			console.log(`  ${mark}  ${verdict.task.id} (${Math.round(verdict.durationMs / 1000)}s)`);
			if (!verdict.passed) console.log(`        ${verdict.detail}`);
		}
		console.log(`\ncanary-edit-gate: ${passed}/${tasks.length} tasks passed`);

		if (writeBaseline) {
			const baseline: EditBaseline = {
				status: "ok",
				model: modelSpec,
				tasks: PINNED_TASK_IDS,
				passed,
				perTask,
				generatedAt: new Date().toISOString(),
			};
			await Bun.write(BASELINE_PATH, `${JSON.stringify(baseline, null, "\t")}\n`);
			console.log(`canary-edit-gate: baseline written to ${BASELINE_PATH}`);
			return 0;
		}

		const baseline = (await Bun.file(BASELINE_PATH).json()) as EditBaseline;
		if (baseline.status !== "ok" || baseline.passed === null) {
			console.log(
				"canary-edit-gate: baseline is unset — record-only mode (no pass/fail). Run with --write-baseline to record one.",
			);
			return 0;
		}
		if (baseline.model !== modelSpec) {
			console.log(
				`canary-edit-gate: baseline model (${baseline.model}) differs from ${modelSpec} — scores not comparable, record-only mode.`,
			);
			return 0;
		}
		const drop = baseline.passed - passed;
		if (drop > tolerance) {
			console.error(
				`canary-edit-gate: FAIL — ${passed}/${tasks.length} is ${drop} task(s) below baseline ${baseline.passed}/${baseline.tasks.length} (tolerance ${tolerance})`,
			);
			return 1;
		}
		console.log(
			`canary-edit-gate: PASS — baseline ${baseline.passed}/${baseline.tasks.length}, delta ${-drop} task(s) (tolerance ${tolerance})`,
		);
		return 0;
	} finally {
		await workRoot.remove().catch(() => {});
		await fixtures.temp.remove().catch(() => {});
	}
}

main()
	.then(code => process.exit(code))
	.catch(error => {
		console.error(`canary-edit-gate: error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
