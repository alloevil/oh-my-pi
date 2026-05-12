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

interface PackageJsonInfo {
	name?: string;
	scripts: string[];
	workspaces: string[];
}

async function commandExists(cwd: string, backend: RecipeBackend, command: string): Promise<boolean> {
	const result = await execRecipeCommand(backend, cwd, `command -v ${command}`);
	return result.exitCode === 0 && result.stdout.trim().length > 0;
}

async function resolvePackageRunner(cwd: string, backend: RecipeBackend): Promise<string> {
	const [bunLock, bunLockb, pnpmLock, yarnLock, npmLock, npmShrink] = await Promise.all([
		isFile(path.join(cwd, "bun.lock"), backend),
		isFile(path.join(cwd, "bun.lockb"), backend),
		isFile(path.join(cwd, "pnpm-lock.yaml"), backend),
		isFile(path.join(cwd, "yarn.lock"), backend),
		isFile(path.join(cwd, "package-lock.json"), backend),
		isFile(path.join(cwd, "npm-shrinkwrap.json"), backend),
	]);
	if (bunLock || bunLockb) return "bun run";
	if (pnpmLock) return "pnpm run";
	if (yarnLock) return "yarn";
	if (npmLock || npmShrink) return "npm run";
	if (await commandExists(cwd, backend, "bun")) return "bun run";
	return "npm run";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function isFile(filePath: string, backend: RecipeBackend): Promise<boolean> {
	return isBackendFile(backend, filePath);
}

function parseWorkspacePatterns(pkg: Record<string, unknown>): string[] {
	const { workspaces } = pkg;
	if (Array.isArray(workspaces)) return workspaces.filter((entry): entry is string => typeof entry === "string");
	if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
		return workspaces.packages.filter((entry): entry is string => typeof entry === "string");
	}
	return [];
}

function normalizeWorkspacePattern(pattern: string): string {
	const negated = pattern.startsWith("!");
	const body = negated ? pattern.slice(1) : pattern;
	const normalizedBody = body.endsWith("package.json") ? body : `${body.replace(/\/+$/u, "")}/package.json`;
	return negated ? `!${normalizedBody}` : normalizedBody;
}

async function readPackageJson(filePath: string, backend: RecipeBackend): Promise<PackageJsonInfo | null> {
	try {
		const pkg = JSON.parse(await readBackendText(backend, filePath)) as unknown;
		if (!isRecord(pkg)) return null;
		const scripts = isRecord(pkg.scripts)
			? Object.entries(pkg.scripts)
					.filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].length > 0)
					.map(([name]) => name)
			: [];
		const name = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : undefined;
		return { name, scripts, workspaces: parseWorkspacePatterns(pkg) };
	} catch (err) {
		logger.debug("package.json script detection failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

async function findWorkspacePackageJsons(cwd: string, patterns: string[], backend: RecipeBackend): Promise<string[]> {
	const includePatterns = patterns.filter(pattern => !pattern.startsWith("!")).map(normalizeWorkspacePattern);
	const excludePatterns = patterns.filter(pattern => pattern.startsWith("!")).map(normalizeWorkspacePattern);

	const collect = async (pattern: string): Promise<string[]> => {
		const result = await backend.fs.glob({
			patterns: [pattern],
			paths: [cwd],
			types: ["file"],
			gitignore: false,
		});
		return result.entries.map(entry =>
			path.relative(cwd, path.isAbsolute(entry.path) ? entry.path : path.join(cwd, entry.path)),
		);
	};

	const [excludedLists, includedLists] = await Promise.all([
		Promise.all(excludePatterns.map(pattern => collect(pattern.slice(1)))),
		Promise.all(includePatterns.map(pattern => collect(pattern))),
	]);
	const excluded = new Set<string>(excludedLists.flat());
	const files = new Set<string>();
	for (const entry of includedLists.flat()) {
		if (entry !== "package.json" && !excluded.has(entry)) files.add(entry);
	}
	return [...files].sort((left, right) => left.localeCompare(right));
}

function packageTaskName(packageName: string | undefined, packageDir: string, scriptName: string): string {
	return `${packageName ?? packageDir}/${scriptName}`;
}

function tasksForPackage(options: { pkg: PackageJsonInfo; packageDir: string; namespaced: boolean }): RunnerTask[] {
	return options.pkg.scripts.map(scriptName => ({
		name: options.namespaced ? packageTaskName(options.pkg.name, options.packageDir, scriptName) : scriptName,
		doc: options.namespaced ? options.packageDir : undefined,
		parameters: [],
		cwd: options.namespaced ? options.packageDir : undefined,
		commandName: shellQuote(scriptName),
	}));
}

async function readPackageTasks(cwd: string, backend: RecipeBackend): Promise<RunnerTask[] | null> {
	const rootPkg = await readPackageJson(path.join(cwd, "package.json"), backend);
	if (!rootPkg) return null;
	const workspacePackageJsons = await findWorkspacePackageJsons(cwd, rootPkg.workspaces, backend);
	const tasks: RunnerTask[] = [];

	if (rootPkg.scripts.length > 0) {
		tasks.push(
			...tasksForPackage({
				pkg: rootPkg,
				packageDir: ".",
				namespaced: false,
			}),
		);
	}

	const pkgs = await Promise.all(workspacePackageJsons.map(p => readPackageJson(path.join(cwd, p), backend)));
	pkgs.forEach((pkg, index) => {
		if (!pkg || pkg.scripts.length === 0) return;
		const packageDir = path.dirname(workspacePackageJsons[index]);
		tasks.push(
			...tasksForPackage({
				pkg,
				packageDir,
				namespaced: true,
			}),
		);
	});

	return tasks.length > 0 ? tasks : null;
}

export const pkgRunner: TaskRunner = {
	id: "pkg",
	label: "Pkg",
	async detect(cwd: string, backend: RecipeBackend): Promise<DetectedRunner | null> {
		try {
			const [commandPrefix, tasks] = await Promise.all([
				resolvePackageRunner(cwd, backend),
				readPackageTasks(cwd, backend),
			]);
			if (!tasks || tasks.length === 0) return null;
			return { id: "pkg", label: "Pkg", commandPrefix, tasks };
		} catch (err) {
			logger.debug("package runner probe failed", { error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	},
};
