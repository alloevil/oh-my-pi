import { describe, expect, it } from "bun:test";
import type { Backend } from "../../src/backend";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { openArchive } from "../../src/tools/archive-reader";

describe("archive-reader", () => {
	it("reads through backend snapshots without re-fetching archive bytes", async () => {
		const counts = {
			openArchive: 0,
			entries: 0,
			readEntry: 0,
			close: 0,
			legacyEntries: 0,
			legacyRead: 0,
		};
		const bytes = new TextEncoder().encode("hello");
		const snapshot = {
			format: "zip" as const,
			async entries() {
				counts.entries += 1;
				return [
					{ path: "dir", kind: "dir" as const, size: 0, mtimeMs: null, compressedSize: null },
					{
						path: "dir/file.txt",
						kind: "file" as const,
						size: bytes.byteLength,
						mtimeMs: null,
						compressedSize: null,
					},
				];
			},
			async readEntry(name: string) {
				counts.readEntry += 1;
				expect(name).toBe("dir/file.txt");
				return bytes;
			},
			async close() {
				counts.close += 1;
			},
			async [Symbol.asyncDispose]() {
				await this.close();
			},
		};
		const backend = {
			fs: {
				openArchive: async () => {
					counts.openArchive += 1;
					return snapshot;
				},
				archiveEntries: async () => {
					counts.legacyEntries += 1;
					throw new Error("archiveEntries should not be called");
				},
				archiveReadEntry: async () => {
					counts.legacyRead += 1;
					throw new Error("archiveReadEntry should not be called");
				},
			} as unknown as Backend["fs"],
			dispose: async () => {},
		} as Backend;
		const session = {
			cwd: "/tmp/archive-reader-test",
			backend,
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
		} as ToolSession;

		const reader = await openArchive("fixture.zip", session);
		try {
			expect(reader.listDirectory("dir").map(entry => entry.name)).toEqual(["file.txt"]);
			const entry = await reader.readEntry("dir/file.txt");
			expect(new TextDecoder().decode(entry.bytes)).toBe("hello");
		} finally {
			await reader.close();
		}

		expect(counts.openArchive).toBe(1);
		expect(counts.entries).toBe(1);
		expect(counts.readEntry).toBe(1);
		expect(counts.close).toBe(1);
		expect(counts.legacyEntries).toBe(0);
		expect(counts.legacyRead).toBe(0);
	});
});
