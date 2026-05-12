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

interface TaskListEntry {
	name?: string;
	desc?: string;
	summary?: string;
}

interface TaskListJson {
	tasks?: TaskListEntry[];
}

const TASKFILE_NAMES = ["Taskfile.yml", "Taskfile.yaml"] as const;

async function hasTaskfile(cwd: string, backend: RecipeBackend): Promise<boolean> {
	for (const name of TASKFILE_NAMES) {
		if (await isBackendFile(backend, path.join(cwd, name))) return true;
	}
	return false;
}

async function listTaskfileTasks(cwd: string, backend: RecipeBackend): Promise<RunnerTask[] | null> {
	try {
		const result = await execRecipeCommand(backend, cwd, "task --list-all --json");
		if (result.exitCode !== 0) return null;
		const list = JSON.parse(result.stdout) as TaskListJson;
		const tasks = (list.tasks ?? [])
			.filter(
				(task): task is TaskListEntry & { name: string } => typeof task.name === "string" && task.name.length > 0,
			)
			.map(task => {
				const desc = typeof task.desc === "string" && task.desc.length > 0 ? task.desc : undefined;
				const summary = typeof task.summary === "string" && task.summary.length > 0 ? task.summary : undefined;
				return { name: task.name, doc: desc ?? summary, parameters: [] };
			});
		return tasks.length > 0 ? tasks : null;
	} catch (err) {
		logger.debug("task runner list failed", { error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}

export const taskRunner: TaskRunner = {
	id: "task",
	label: "Task",
	async detect(cwd: string, backend: RecipeBackend): Promise<DetectedRunner | null> {
		try {
			if (!(await hasTaskfile(cwd, backend))) return null;
			const tasks = await listTaskfileTasks(cwd, backend);
			if (!tasks || tasks.length === 0) return null;
			return { id: "task", label: "Task", commandPrefix: "task", tasks };
		} catch (err) {
			logger.debug("task runner probe failed", { error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	},
};
