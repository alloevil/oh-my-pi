#!/usr/bin/env bun
/**
 * manifest:verify — runs the canary evals for a harness-evolution manifest
 * card and records the measured results in the card itself.
 *
 * Usage: bun run manifest:verify scripts/harness-evolve/manifests/<id>.md
 *
 * Runs the same two stages as `bun run canary:eval` (routing canary +
 * edit gate), but invokes them separately so a routing failure still
 * yields an edit-gate measurement and both raw exit codes land on the
 * card. Parses accuracy / task counts from the scripts' output, computes
 * deltas against the committed baselines, and upserts a
 * `## Verification (auto)` section in the manifest.
 *
 * Idempotent: re-running replaces the auto section in place, never
 * duplicates it. Prediction bullets that do not name the routing canary
 * or the edit gate are not auto-measured — they are re-emitted as manual
 * checkbox line items for the human to fill.
 */

import * as path from "node:path";

const SCRIPT_DIR = path.dirname(Bun.fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, "..", "..");
const ROUTING_SCRIPT = path.join(REPO_ROOT, "scripts", "canary-eval", "run.ts");
const EDIT_GATE_SCRIPT = path.join(REPO_ROOT, "scripts", "canary-eval", "edit-gate.ts");
const ROUTING_BASELINE = path.join(REPO_ROOT, "scripts", "canary-eval", "baseline.json");
const EDIT_BASELINE = path.join(REPO_ROOT, "scripts", "canary-eval", "edit-baseline.json");

const AUTO_HEADING = "## Verification (auto)";

interface StageResult {
	exitCode: number;
	output: string;
}

interface RoutingBaseline {
	accuracyPct: number | null;
	model: string;
}

interface EditBaseline {
	passed: number | null;
	tasks: string[];
	model: string;
}

async function runStage(script: string): Promise<StageResult> {
	const proc = Bun.spawn(["bun", script], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: Bun.env,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, output: stderr ? `${stdout}\n${stderr}` : stdout };
}

/** PASS | FAIL | SKIPPED from the script's own verdict line, else record-only/none. */
function stageStatus(output: string, prefix: string): string {
	const verdict = output.match(new RegExp(`^${prefix}: (PASS|FAIL|SKIPPED)`, "m"));
	if (verdict) return verdict[1];
	if (output.includes("record-only mode")) return "record-only";
	return "no verdict";
}

function fmtDelta(delta: number, unit: string): string {
	const sign = delta >= 0 ? "+" : "";
	return `${sign}${Math.round(delta * 10) / 10}${unit}`;
}

/** Bullets under `## Prediction` (continuation lines folded) that the canary does not measure. */
function manualPredictions(card: string): string[] {
	const section = card.match(/^## Prediction\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
	if (!section) return [];
	const bullets: string[] = [];
	for (const raw of section[1].split("\n")) {
		const line = raw.trim();
		if (line.startsWith("- ")) {
			bullets.push(line.replace(/^- \[[ xX]\] /, "- "));
		} else if (line.length > 0 && bullets.length > 0 && /^\s/.test(raw)) {
			// Indented continuation of the previous bullet.
			bullets[bullets.length - 1] += ` ${line}`;
		}
	}
	return bullets.filter(bullet => !/routing canary|edit[\s-]?gate/i.test(bullet));
}

/** Replaces the auto section (heading to next `## ` or EOF); inserts before `## Verdict` when absent. */
function upsertAutoSection(card: string, section: string): string {
	const lines = card.split("\n");
	const start = lines.findIndex(line => line.trim() === AUTO_HEADING);
	if (start >= 0) {
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			if (lines[i].startsWith("## ")) {
				end = i;
				break;
			}
		}
		lines.splice(start, end - start, ...section.split("\n"));
		return lines.join("\n");
	}
	const verdict = lines.findIndex(line => line.startsWith("## Verdict"));
	if (verdict >= 0) {
		lines.splice(verdict, 0, ...section.split("\n"));
		return lines.join("\n");
	}
	const trimmed = card.replace(/\n+$/, "");
	return `${trimmed}\n\n${section.split("\n").join("\n")}`;
}

async function main(): Promise<number> {
	const manifestPath = Bun.argv[2];
	if (!manifestPath) {
		console.error("usage: bun run manifest:verify scripts/harness-evolve/manifests/<id>.md");
		return 2;
	}
	const manifestFile = Bun.file(manifestPath);
	if (!(await manifestFile.exists())) {
		console.error(`manifest:verify: manifest not found: ${manifestPath}`);
		return 2;
	}
	const card = await manifestFile.text();

	console.log("manifest:verify: running routing canary (scripts/canary-eval/run.ts)…");
	const routing = await runStage(ROUTING_SCRIPT);
	process.stdout.write(routing.output);
	console.log("manifest:verify: running edit gate (scripts/canary-eval/edit-gate.ts)…");
	const editGate = await runStage(EDIT_GATE_SCRIPT);
	process.stdout.write(editGate.output);

	const routingBaseline = (await Bun.file(ROUTING_BASELINE).json()) as RoutingBaseline;
	const editBaseline = (await Bun.file(EDIT_BASELINE).json()) as EditBaseline;

	const accuracyMatch = routing.output.match(/^canary-eval: top-1 accuracy ([\d.]+)%/m);
	const accuracy = accuracyMatch ? Number.parseFloat(accuracyMatch[1]) : null;
	const routingStatus = stageStatus(routing.output, "canary-eval");
	const routingMeasured = accuracy === null ? "—" : `${accuracy}%`;
	const routingDelta =
		accuracy !== null && routingBaseline.accuracyPct !== null
			? fmtDelta(accuracy - routingBaseline.accuracyPct, "pp")
			: "—";

	const editMatch = editGate.output.match(/^canary-edit-gate: (\d+)\/(\d+) tasks passed/m);
	const editPassed = editMatch ? Number.parseInt(editMatch[1], 10) : null;
	const editTotal = editMatch ? Number.parseInt(editMatch[2], 10) : null;
	const editStatus = stageStatus(editGate.output, "canary-edit-gate");
	const editMeasured = editPassed === null ? "—" : `${editPassed}/${editTotal}`;
	const editDelta =
		editPassed !== null && editBaseline.passed !== null
			? fmtDelta(editPassed - editBaseline.passed, " task(s)")
			: "—";

	const manual = manualPredictions(card);
	const manualBlock =
		manual.length === 0
			? "No manual metrics: every prediction bullet names a canary-covered metric."
			: [
					"Manual metrics — predictions the canary does not measure; fill by hand:",
					"",
					...manual.map(bullet => bullet.replace(/^- /, "- [ ] ")),
				].join("\n");

	const section = [
		AUTO_HEADING,
		"",
		`_Generated by \`bun run manifest:verify\` at ${new Date().toISOString()}. Do not edit — re-runs replace this whole section._`,
		"",
		"| Metric | Measured | Baseline | Delta | Gate | Exit code |",
		"|---|---|---|---|---|---|",
		`| Routing canary (top-1) | ${routingMeasured} | ${routingBaseline.accuracyPct ?? "—"}% | ${routingDelta} | ${routingStatus} | ${routing.exitCode} |`,
		`| Edit gate | ${editMeasured} | ${editBaseline.passed ?? "—"}/${editBaseline.tasks.length} | ${editDelta} | ${editStatus} | ${editGate.exitCode} |`,
		"",
		manualBlock,
		"",
	].join("\n");

	await Bun.write(manifestPath, upsertAutoSection(card, section));
	console.log(`\nmanifest:verify: wrote "${AUTO_HEADING}" to ${manifestPath}`);
	console.log(
		`manifest:verify: routing=${routingStatus} (exit ${routing.exitCode}), edit-gate=${editStatus} (exit ${editGate.exitCode}), manual items=${manual.length}`,
	);
	return 0;
}

main()
	.then(code => process.exit(code))
	.catch(error => {
		console.error(`manifest:verify: error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
