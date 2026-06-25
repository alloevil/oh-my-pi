import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "images.autoResize": false }),
	} as unknown as ToolSession;
}

function joinText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("read local:// ranges", () => {
	let testDir: string;
	let localRoot: string;

	beforeEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-local-range-"));
		const artifactsDir = path.join(testDir, "artifacts");
		localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		LocalProtocolHandler.setOverride({
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "session-local-range",
		});
	});

	afterEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("streams ranged reads from oversized local text files", async () => {
		const localFile = path.join(localRoot, "huge.log");
		const filler = "x".repeat(1000);
		const handle = await fs.open(localFile, "w");
		try {
			for (let i = 1; i <= 11 * 1024; i++) {
				await handle.write(`line-${i.toString().padStart(5, "0")} ${filler}\n`);
			}
		} finally {
			await handle.close();
		}
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://huge.log:3-5" });
		const text = joinText(result.content);

		expect(text).not.toContain("Cannot inline local:// file");
		expect(text).toContain("line-00003");
		expect(text).toContain("line-00005");
		expect(text).not.toContain("line-00100");
	});
});
