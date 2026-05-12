import * as fs from "node:fs";

export interface SSHConnectionTarget {
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
}

function buildSshTarget(username: string | undefined, host: string): string {
	return username ? `${username}@${host}` : host;
}

async function validateKeyPermissions(keyPath?: string): Promise<void> {
	if (!keyPath) return;
	const stats = await fs.promises.stat(keyPath);
	if (!stats.isFile()) {
		throw new Error(`SSH key is not a file: ${keyPath}`);
	}
	const mode = stats.mode & 0o777;
	if ((mode & 0o077) !== 0) {
		throw new Error(`SSH key permissions must be 600 or stricter: ${keyPath}`);
	}
}

export function buildSSHBaseArgs(host: SSHConnectionTarget, options?: { includeStdinNull?: boolean }): string[] {
	const args: string[] = [];
	if (options?.includeStdinNull !== false) {
		args.push("-n");
	}
	args.push("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new");
	if (host.port) {
		args.push("-p", String(host.port));
	}
	if (host.keyPath) {
		args.push("-i", host.keyPath);
	}
	return args;
}

export async function buildRemoteCommand(host: SSHConnectionTarget, command: string): Promise<string[]> {
	await validateKeyPermissions(host.keyPath);
	return [...buildSSHBaseArgs(host), buildSshTarget(host.username, host.host), command];
}
