import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type DetectedRunner,
	execRecipeCommand,
	isBackendFile,
	type RecipeBackend,
	type RunnerTask,
	type TaskRunner,
} from "../runner";

interface JustDumpRecipeRaw {
	name?: string;
	doc?: string | null;
	private?: boolean;
	parameters?: Array<{ name?: string }>;
}

interface JustDump {
	recipes?: Record<string, JustDumpRecipeRaw>;
}

const JUSTFILE_NAMES = ["justfile", "Justfile", ".justfile"] as const;

async function hasJustfile(cwd: string, backend: RecipeBackend): Promise<boolean> {
	for (const name of JUSTFILE_NAMES) {
		if (await isBackendFile(backend, path.join(cwd, name))) return true;
	}
	return false;
}

async function dumpJustTasks(cwd: string, backend: RecipeBackend): Promise<RunnerTask[] | null> {
	try {
		const result = await execRecipeCommand(backend, cwd, "just --dump --dump-format=json");
		if (result.exitCode !== 0) return null;
		const dump = JSON.parse(result.stdout) as JustDump;
		const tasks: RunnerTask[] = [];
		for (const recipe of Object.values(dump.recipes ?? {})) {
			if (!recipe.name || recipe.private) continue;
			const parameters = (recipe.parameters ?? [])
				.map(parameter => parameter.name)
				.filter((name): name is string => typeof name === "string" && name.length > 0);
			const doc = typeof recipe.doc === "string" && recipe.doc.length > 0 ? recipe.doc : undefined;
			tasks.push({ name: recipe.name, doc, parameters });
		}
		return tasks;
	} catch (err) {
		logger.debug("just task detection failed", { error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}

export const justRunner: TaskRunner = {
	id: "just",
	label: "Just",
	async detect(cwd: string, backend: RecipeBackend): Promise<DetectedRunner | null> {
		try {
			if (!(await hasJustfile(cwd, backend))) return null;
			const tasks = await dumpJustTasks(cwd, backend);
			if (!tasks || tasks.length === 0) return null;
			return { id: "just", label: "Just", commandPrefix: "just", tasks };
		} catch (err) {
			logger.debug("just runner probe failed", { error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	},
};
