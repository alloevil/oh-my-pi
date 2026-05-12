import { ptree } from "@oh-my-pi/pi-utils";
import { buildRemoteCommand, buildSSHBaseArgs, type SSHConnectionTarget } from "./connection-manager";

export interface SSHExecutorOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface SSHResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
}

export interface SSHPortForwardOptions {
	localPort: number;
	remotePort: number;
	signal?: AbortSignal;
}

export interface SSHSpawnedProcess {
	stdout: ReadableStream<Uint8Array> | null;
	stderr: ReadableStream<Uint8Array> | null;
	exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): number | undefined;
	pid?: number;
}

function buildSshTarget(username: string | undefined, host: string): string {
	return username ? `${username}@${host}` : host;
}

function combineOutput(stdout: string, stderr: string): string {
	if (!stdout) return stderr;
	if (!stderr) return stdout;
	return `${stdout}${stdout.endsWith("\n") || stderr.startsWith("\n") ? "" : "\n"}${stderr}`;
}

async function collectStreamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return await new Response(stream).text();
}

export async function executeSSH(
	host: SSHConnectionTarget,
	command: string,
	options?: SSHExecutorOptions,
): Promise<SSHResult> {
	using child = ptree.spawn(["ssh", ...(await buildRemoteCommand(host, command))], {
		signal: options?.signal,
		timeout: options?.timeout,
		stdin: "pipe",
		stderr: "full",
	});

	const stdoutPromise = collectStreamText(child.stdout as ReadableStream<Uint8Array> | null);
	const stderrPromise = collectStreamText(child.stderr as ReadableStream<Uint8Array> | null);

	try {
		const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, child.exited]);
		return {
			output: combineOutput(stdout, stderr),
			exitCode,
			cancelled: false,
		};
	} catch (error) {
		const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
		if (error instanceof ptree.Exception) {
			return {
				output: combineOutput(stdout, stderr),
				exitCode: error.aborted ? undefined : error.exitCode,
				cancelled: error.aborted || error instanceof ptree.TimeoutError,
			};
		}
		throw error;
	}
}

export async function copyFileSCP(host: SSHConnectionTarget, localPath: string, remotePath: string): Promise<void> {
	const args = ["-O", ...buildSSHBaseArgs({ ...host, port: undefined }, { includeStdinNull: false })];
	if (host.port) {
		args.push("-P", String(host.port));
	}
	args.push(localPath, `${buildSshTarget(host.username, host.host)}:${remotePath}`);
	const child = Bun.spawn(["scp", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectStreamText(child.stdout),
		collectStreamText(child.stderr),
		child.exited,
	]);
	if (exitCode !== 0) {
		const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
		throw new Error(`scp upload failed${detail ? `: ${detail}` : ""}`);
	}
}

export async function spawnWithPortForward(
	host: SSHConnectionTarget,
	command: string,
	options: SSHPortForwardOptions,
): Promise<SSHSpawnedProcess> {
	const args = [
		...buildSSHBaseArgs(host),
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"ServerAliveInterval=30",
		"-o",
		"ServerAliveCountMax=3",
		"-L",
		`${options.localPort}:127.0.0.1:${options.remotePort}`,
		buildSshTarget(host.username, host.host),
		command,
	];
	const proc = ptree.spawn(["ssh", ...args], {
		signal: options.signal,
		stdin: "pipe",
		stderr: "full",
	});
	return {
		stdout: proc.stdout as ReadableStream<Uint8Array> | null,
		stderr: proc.stderr as ReadableStream<Uint8Array> | null,
		exited: proc.exited,
		kill: proc.kill.bind(proc) as (signal?: number | NodeJS.Signals) => number | undefined,
		pid: proc.pid,
	};
}
