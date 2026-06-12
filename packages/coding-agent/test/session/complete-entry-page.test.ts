import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readCompleteEntryPage } from "@oh-my-pi/pi-coding-agent/session/complete-entry-page";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function sessionFile(content: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "complete-entry-page-test-"));
	tempDirs.push(dir);
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, content);
	return file;
}

function messageLine(id: string, text: string): string {
	return `${JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-12T00:00:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text }] },
	})}\n`;
}

describe("readCompleteEntryPage", () => {
	it("skips oversized complete entries so later transcript pages remain reachable", async () => {
		const oversized = messageLine("oversized", "x".repeat(256));
		const following = messageLine("following", "visible");
		const file = await sessionFile(`${oversized}${following}`);

		const skipped = await readCompleteEntryPage(file, { maxBytes: 32 });
		expect(skipped.entries).toEqual([]);
		expect(skipped.nextByte).toBe(Buffer.byteLength(oversized, "utf8"));

		const page = await readCompleteEntryPage(file, { fromByte: skipped.nextByte, maxBytes: 1024 });
		expect(page.entries.map(entry => entry.id)).toEqual(["following"]);
	});

	it("does not advance past an oversized entry until its newline is present", async () => {
		const partial = messageLine("partial", "x".repeat(256)).slice(0, -1);
		const file = await sessionFile(partial);

		const page = await readCompleteEntryPage(file, { maxBytes: 32 });
		expect(page.entries).toEqual([]);
		expect(page.nextByte).toBe(0);
	});
});
