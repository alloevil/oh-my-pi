#!/usr/bin/env bun
/**
 * Canary eval: scores the REAL system prompt's skill-routing behavior with a
 * deliberately weak router model on fixed synthetic fixtures.
 *
 * For each fixture query the router model receives the full system prompt
 * (built via buildSystemPrompt with the 12 synthetic skills under
 * fixtures/skills/) and is asked which skill it reads first. Top-1 accuracy
 * averaged over REPEATS runs is compared against baseline.json; a drop of
 * more than CANARY_TOLERANCE percentage points exits non-zero.
 *
 * Env:
 *   CANARY_MODEL      provider/model-id       (default anthropic/claude-haiku-4-5)
 *   CANARY_API_KEY    bearer for the request  (default: omp auth storage / provider env var)
 *   CANARY_BASE_URL   endpoint override for proxied/brokered access to CANARY_MODEL
 *   REPEATS           runs to average         (default 3)
 *   CANARY_TOLERANCE  allowed drop in pct pts (default 5)
 * Flags:
 *   --write-baseline  overwrite baseline.json with this run's scores
 *
 * CI-safe: with no resolvable credentials it prints SKIPPED and exits 0.
 */

import * as path from "node:path";
import { type Api, AuthStorage, completeSimple, type Model, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { loadSkillsFromDir } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import type { WorkspaceTree } from "@oh-my-pi/pi-coding-agent/workspace-tree";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

const CANARY_DIR = path.dirname(Bun.fileURLToPath(import.meta.url));
const FIXTURE_SKILLS_DIR = path.join(CANARY_DIR, "fixtures", "skills");
const QUERIES_PATH = path.join(CANARY_DIR, "fixtures", "queries.json");
const BASELINE_PATH = path.join(CANARY_DIR, "baseline.json");

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const DEFAULT_REPEATS = 3;
const DEFAULT_TOLERANCE_PCT_PTS = 5;
const CONCURRENCY = 3;
const ATTEMPTS_PER_QUERY = 6;

/** Standard tool set for the rendered prompt; `read` is required for the skills listing. */
const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "glob"];

interface CanaryQuery {
	query: string;
	expected: string;
}

interface QueriesFile {
	queries: CanaryQuery[];
}

interface Baseline {
	status: "ok" | "unset";
	model: string;
	repeats: number;
	accuracyPct: number | null;
	perSkillPct: Record<string, number>;
	generatedAt: string | null;
	note?: string;
}

interface Verdict {
	query: CanaryQuery;
	predicted: string;
	correct: boolean;
}

interface Router {
	spec: string;
	model: Model<Api>;
	apiKey: string;
}

function envInt(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFloat(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (!raw) return fallback;
	const value = Number.parseFloat(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Resolve model + credentials. Returns undefined (→ SKIPPED) when no credentials exist. */
async function openRouter(spec: string): Promise<Router | undefined> {
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`CANARY_MODEL must be <provider>/<model-id>, got "${spec}"`);
	const provider = spec.slice(0, slash);
	const modelId = spec.slice(slash + 1);
	const bundled = getBundledModel(provider as GeneratedProvider, modelId);
	if (!bundled) throw new Error(`unknown model "${spec}" (not in the bundled catalog)`);
	const baseUrl = Bun.env.CANARY_BASE_URL?.trim();
	const model = baseUrl ? { ...bundled, baseUrl } : bundled;
	let apiKey = Bun.env.CANARY_API_KEY?.trim();
	if (!apiKey) {
		try {
			const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
			const storage = new AuthStorage(store);
			await storage.reload();
			apiKey = await storage.getApiKey(provider);
		} catch {
			apiKey = undefined;
		}
	}
	if (!apiKey) return undefined;
	return { spec, model, apiKey };
}

/** Earliest whole-match of any fixture skill name inside the model's reply. */
function parseAnswer(text: string, skillNames: readonly string[]): string {
	const haystack = text.toLowerCase();
	let best: { name: string; index: number } | undefined;
	for (const name of skillNames) {
		const index = haystack.indexOf(name.toLowerCase());
		if (index >= 0 && (best === undefined || index < best.index)) best = { name, index };
	}
	if (best) return best.name;
	const firstLine = text.trim().split("\n", 1)[0] ?? "";
	return firstLine.slice(0, 60) || "<empty>";
}

async function routeQuery(
	router: Router,
	systemPrompt: string[],
	query: CanaryQuery,
	skillNames: readonly string[],
): Promise<Verdict> {
	const probe = `${query.query}\n\n(Routing probe: which skill do you read first for the request above? Reply with the skill name only — no punctuation, no explanation.)`;
	let lastError = "";
	for (let attempt = 0; attempt < ATTEMPTS_PER_QUERY; attempt++) {
		const response = await completeSimple(
			router.model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: probe }], timestamp: Date.now() }],
			},
			{ apiKey: router.apiKey, disableReasoning: true, temperature: 0, maxTokens: 128 },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			lastError = response.errorMessage ?? response.stopReason;
			// Rate limits (free tiers cap RPM): honor the server-suggested retry
			// delay when present, otherwise back off linearly.
			const rateLimited = /\b429\b|rate.?limit|quota/i.test(lastError);
			const suggested = lastError.match(/retry in ([\d.]+)\s*s/i);
			const delayMs = suggested
				? Number.parseFloat(suggested[1]) * 1000 + 1000
				: rateLimited
					? 20_000
					: 1500 * (attempt + 1);
			await Bun.sleep(delayMs);
			continue;
		}
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text)
			.join("");
		const predicted = parseAnswer(text, skillNames);
		return { query, predicted, correct: predicted === query.expected };
	}
	throw new Error(`router call failed after ${ATTEMPTS_PER_QUERY} attempts: ${lastError}`);
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

function pct(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
}

async function main(): Promise<number> {
	const modelSpec = Bun.env.CANARY_MODEL || DEFAULT_MODEL;
	const repeats = envInt("REPEATS", DEFAULT_REPEATS);
	const tolerance = envFloat("CANARY_TOLERANCE", DEFAULT_TOLERANCE_PCT_PTS);
	const writeBaseline = Bun.argv.includes("--write-baseline");

	const { queries } = (await Bun.file(QUERIES_PATH).json()) as QueriesFile;
	const { skills, warnings } = await loadSkillsFromDir({ dir: FIXTURE_SKILLS_DIR, source: "canary:project" });
	for (const warning of warnings) console.error(`canary-eval: fixture warning: ${warning.message}`);
	if (skills.length === 0) throw new Error(`no fixture skills found under ${FIXTURE_SKILLS_DIR}`);
	const skillNames = skills.map(skill => skill.name);
	const unknown = queries.filter(q => !skillNames.includes(q.expected));
	if (unknown.length > 0) {
		throw new Error(`queries.json references unknown skills: ${unknown.map(q => q.expected).join(", ")}`);
	}

	const router = await openRouter(modelSpec);
	if (!router) {
		console.log(
			`canary-eval: SKIPPED — no credentials resolve for "${modelSpec}" (omp login or provider env var required)`,
		);
		return 0;
	}

	// Real prompt pipeline, hermetic inputs: fixture skills only, no context
	// files, no workspace tree, no repo context.
	const emptyTree: WorkspaceTree = {
		rootPath: CANARY_DIR,
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [],
	};
	const { systemPrompt } = await buildSystemPrompt({
		cwd: CANARY_DIR,
		contextFiles: [],
		skills,
		toolNames: TOOL_NAMES,
		workspaceTree: emptyTree,
		activeRepoContext: null,
		model: modelSpec,
	});

	console.log(`canary-eval: model=${modelSpec} queries=${queries.length} repeats=${repeats} tolerance=${tolerance}pp`);

	const runAccuracies: number[] = [];
	const perSkillCorrect = new Map<string, number>();
	const perSkillTotal = new Map<string, number>();
	const confusion = new Map<string, Map<string, number>>();
	for (let run = 0; run < repeats; run++) {
		const verdicts = await mapLimit(queries, CONCURRENCY, q => routeQuery(router, systemPrompt, q, skillNames));
		const correct = verdicts.filter(v => v.correct).length;
		runAccuracies.push(pct(correct, verdicts.length));
		console.log(`  run ${run + 1}/${repeats}: ${correct}/${verdicts.length} (${pct(correct, verdicts.length)}%)`);
		for (const verdict of verdicts) {
			const expected = verdict.query.expected;
			perSkillTotal.set(expected, (perSkillTotal.get(expected) ?? 0) + 1);
			if (verdict.correct) {
				perSkillCorrect.set(expected, (perSkillCorrect.get(expected) ?? 0) + 1);
			} else {
				const bucket = confusion.get(expected) ?? new Map<string, number>();
				bucket.set(verdict.predicted, (bucket.get(verdict.predicted) ?? 0) + 1);
				confusion.set(expected, bucket);
			}
		}
	}

	const meanAccuracy = Math.round((runAccuracies.reduce((a, b) => a + b, 0) / runAccuracies.length) * 10) / 10;
	const perSkillPct: Record<string, number> = {};
	for (const name of skillNames) {
		perSkillPct[name] = pct(perSkillCorrect.get(name) ?? 0, perSkillTotal.get(name) ?? 0);
	}

	console.log(
		`\ncanary-eval: top-1 accuracy ${meanAccuracy}% (mean of ${repeats} runs: ${runAccuracies.join("%, ")}%)`,
	);
	if (confusion.size > 0) {
		console.log("confusions (expected -> predicted xN, across all runs):");
		for (const [expected, bucket] of [...confusion.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			const parts = [...bucket.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([predicted, count]) => `${predicted} x${count}`);
			console.log(`  ${expected} -> ${parts.join(", ")}`);
		}
	}

	if (writeBaseline) {
		const baseline: Baseline = {
			status: "ok",
			model: modelSpec,
			repeats,
			accuracyPct: meanAccuracy,
			perSkillPct,
			generatedAt: new Date().toISOString(),
		};
		await Bun.write(BASELINE_PATH, `${JSON.stringify(baseline, null, "\t")}\n`);
		console.log(`canary-eval: baseline written to ${BASELINE_PATH}`);
		return 0;
	}

	const baseline = (await Bun.file(BASELINE_PATH).json()) as Baseline;
	if (baseline.status !== "ok" || baseline.accuracyPct === null) {
		console.log(
			"canary-eval: baseline is unset — record-only mode (no pass/fail). Run with --write-baseline to record one.",
		);
		return 0;
	}
	if (baseline.model !== modelSpec) {
		console.log(
			`canary-eval: baseline model (${baseline.model}) differs from ${modelSpec} — scores not comparable, record-only mode.`,
		);
		return 0;
	}
	const drop = baseline.accuracyPct - meanAccuracy;
	if (drop > tolerance) {
		console.error(
			`canary-eval: FAIL — accuracy ${meanAccuracy}% is ${drop.toFixed(1)}pp below baseline ${baseline.accuracyPct}% (tolerance ${tolerance}pp)`,
		);
		return 1;
	}
	console.log(
		`canary-eval: PASS — baseline ${baseline.accuracyPct}%, delta ${(-drop).toFixed(1)}pp (tolerance ${tolerance}pp)`,
	);
	return 0;
}

main()
	.then(code => process.exit(code))
	.catch(error => {
		console.error(`canary-eval: error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
