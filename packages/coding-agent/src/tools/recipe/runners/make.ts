import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type DetectedRunner,
	execRecipeCommand,
	isBackendFile,
	type RecipeBackend,
	type RunnerTask,
	readBackendText,
	type TaskRunner,
} from "../runner";

const MAKEFILE_NAMES = ["Makefile", "makefile", "GNUmakefile"] as const;
const TARGET_PATTERN = /^(?<name>[A-Za-z_][A-Za-z0-9_-]*)\s*:(?!=).*?(?:##\s*(?<doc>.+))?$/u;
const PHONY_PATTERN = /^\.PHONY\s*:\s*(?<targets>.*)$/u;

interface MakeTargetInfo {
	name: string;
	doc?: string;
	order: number;
	phony: boolean;
}

async function findMakefile(cwd: string, backend: RecipeBackend): Promise<string | null> {
	for (const name of MAKEFILE_NAMES) {
		const candidate = path.join(cwd, name);
		if (await isBackendFile(backend, candidate)) return candidate;
	}
	return null;
}

async function probeMake(cwd: string, backend: RecipeBackend): Promise<boolean> {
	const result = await execRecipeCommand(backend, cwd, "make -p -q");
	return result.exitCode === 0 || result.exitCode === 1;
}

function isVariableAssignment(line: string, name: string): boolean {
	return new RegExp(`^\\s*${name}\\s*[:?+]?=`, "u").test(line);
}

function parsePhonyTargets(line: string): string[] {
	const match = PHONY_PATTERN.exec(line);
	if (!match?.groups?.targets) return [];
	return match.groups.targets
		.split(/\s+/u)
		.map(target => target.trim())
		.filter(target => /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(target));
}

function parseMakeTargets(text: string): RunnerTask[] {
	const targets = new Map<string, MakeTargetInfo>();
	const phonyTargets: string[] = [];
	let order = 0;

	for (const line of text.split("\n")) {
		for (const target of parsePhonyTargets(line)) {
			if (!phonyTargets.includes(target)) phonyTargets.push(target);
		}

		const match = TARGET_PATTERN.exec(line);
		const name = match?.groups?.name;
		if (!name || name === ".PHONY" || isVariableAssignment(line, name)) continue;
		if (targets.has(name)) continue;
		const rawDoc = match?.groups?.doc?.trim();
		const doc = rawDoc && rawDoc.length > 0 ? rawDoc : undefined;
		targets.set(name, { name, doc, order, phony: false });
		order += 1;
	}

	for (const phony of phonyTargets) {
		const existing = targets.get(phony);
		if (existing) {
			existing.phony = true;
			continue;
		}
		targets.set(phony, { name: phony, order, phony: true });
		order += 1;
	}

	const hasPhonyTargets = phonyTargets.length > 0;
	return [...targets.values()]
		.sort((left, right) => left.order - right.order)
		.flatMap(target => {
			if (!hasPhonyTargets || target.phony) {
				return [{ name: target.name, doc: target.doc, parameters: [] }];
			}
			if (!target.doc) return [];
			return [{ name: target.name, doc: `${target.doc} (file target)`, parameters: [] }];
		});
}

export const makeRunner: TaskRunner = {
	id: "make",
	label: "Make",
	async detect(cwd: string, backend: RecipeBackend): Promise<DetectedRunner | null> {
		try {
			const makefile = await findMakefile(cwd, backend);
			if (!makefile) return null;
			if (!(await probeMake(cwd, backend))) return null;
			const tasks = parseMakeTargets(await readBackendText(backend, makefile));
			if (tasks.length === 0) return null;
			return { id: "make", label: "Make", commandPrefix: "make", tasks };
		} catch (err) {
			logger.debug("make runner probe failed", { error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	},
};
