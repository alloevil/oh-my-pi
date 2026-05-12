#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

interface RwpTarget {
	id: string;
	cargoTarget: string;
	outputName: string;
	useZigbuild: boolean;
}

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const isDryRun = process.argv.includes("--dry-run");
const targets = [
	{
		id: "darwin-arm64",
		cargoTarget: "aarch64-apple-darwin",
		outputName: "rwp-server-darwin-arm64",
		useZigbuild: false,
	},
	{
		id: "darwin-x64",
		cargoTarget: "x86_64-apple-darwin",
		outputName: "rwp-server-darwin-x64",
		useZigbuild: false,
	},
	{
		id: "linux-x64",
		cargoTarget: "x86_64-unknown-linux-musl",
		outputName: "rwp-server-linux-x64",
		useZigbuild: true,
	},
	{
		id: "linux-arm64",
		cargoTarget: "aarch64-unknown-linux-musl",
		outputName: "rwp-server-linux-arm64",
		useZigbuild: true,
	},
	{
		id: "win32-x64",
		cargoTarget: "x86_64-pc-windows-gnu",
		outputName: "rwp-server-win32-x64.exe",
		useZigbuild: true,
	},
] as const satisfies RwpTarget[];

function parseOnlyTarget(): string | null {
	const flagIndex = process.argv.findIndex(arg => arg === "--only");
	if (flagIndex >= 0) {
		return process.argv[flagIndex + 1] ?? null;
	}

	return process.argv.find(arg => arg.startsWith("--only="))?.split("=", 2)[1] ?? null;
}

function outputPathFor(target: RwpTarget): string {
	return path.join(binariesDir, target.outputName);
}

function builtBinaryPathFor(target: RwpTarget): string {
	const executable = target.outputName.endsWith(".exe") ? "rwp-server.exe" : "rwp-server";
	return path.join(repoRoot, "target", target.cargoTarget, "release", executable);
}

async function runCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	if (isDryRun) {
		logger.debug(command.join(" "));
		return;
	}

	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function ensureRustTarget(target: RwpTarget): Promise<void> {
	await runCommand(["rustup", "target", "add", target.cargoTarget], repoRoot);
}

function buildEnvFor(target: RwpTarget): NodeJS.ProcessEnv {
	if (!target.useZigbuild) {
		return Bun.env;
	}

	const cflagsKey = `CFLAGS_${target.cargoTarget.replaceAll("-", "_")}`;
	return {
		...Bun.env,
		CFLAGS: "-UNDEBUG",
		[cflagsKey]: "-UNDEBUG",
		[`CFLAGS_${target.cargoTarget}`]: "-UNDEBUG",
	};
}

async function buildTarget(target: RwpTarget): Promise<void> {
	logger.debug("Building rwp-server bundle target", {
		target: target.id,
		cargoTarget: target.cargoTarget,
		zigbuild: target.useZigbuild,
	});
	await ensureRustTarget(target);

	const buildCommand = target.useZigbuild
		? [
				"cargo",
				"zigbuild",
				"--release",
				"-p",
				"rwp-server",
				"--target",
				target.cargoTarget,
				"--target-dir",
				"target",
				"--no-default-features",
			]
		: ["cargo", "build", "--release", "-p", "rwp-server", "--target", target.cargoTarget, "--target-dir", "target"];
	await runCommand(buildCommand, repoRoot, buildEnvFor(target));

	const sourcePath = builtBinaryPathFor(target);
	const destinationPath = outputPathFor(target);
	if (isDryRun) {
		logger.debug(`cp ${sourcePath} ${destinationPath}`);
		if (!destinationPath.endsWith(".exe")) {
			logger.debug(`chmod 755 ${destinationPath}`);
		}
		return;
	}

	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	await fs.copyFile(sourcePath, destinationPath);
	if (!destinationPath.endsWith(".exe")) {
		await fs.chmod(destinationPath, 0o755);
	}
}

async function main(): Promise<void> {
	const requestedTargetId = parseOnlyTarget();
	const selectedTargets = requestedTargetId ? targets.filter(target => target.id === requestedTargetId) : targets;
	if (requestedTargetId && selectedTargets.length === 0) {
		throw new Error(`Unknown rwp-server target: ${requestedTargetId}`);
	}
	if (selectedTargets.length === 0) {
		throw new Error("No rwp-server targets selected.");
	}

	await fs.mkdir(binariesDir, { recursive: true });
	for (const target of selectedTargets) {
		await buildTarget(target);
	}
}

await main();
