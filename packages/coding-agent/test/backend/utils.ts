import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EtagMismatchError, type SqliteTableInfo } from "@oh-my-pi/rwp-client";
import type { Backend, BashEvent, ReadDbResponse } from "../../src/backend";
import type { GrepAstHit, GrepAstSummary, GrepHit, GrepSummary } from "../../src/backend/types";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const serverUrlPattern = /listening on (https?:\/\/[^\s]+)/;
const structuredServerPattern = /rwp-server listening address=([^\s]+) scheme="(https?)"/;

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rwp-backend-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

export interface SpawnedRwpServer {
	baseUrl: string;
	close(): Promise<void>;
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	return promise.finally(() => clearTimeout(timer));
}
function extractServerUrl(text: string): string | null {
	const direct = text.match(serverUrlPattern);
	if (direct?.[1]) return direct[1];
	const structured = text.match(structuredServerPattern);
	if (!structured?.[1] || !structured[2]) return null;
	return `${structured[2]}://${structured[1]}`;
}

export async function spawnRwpServer(): Promise<SpawnedRwpServer> {
	const proc = Bun.spawn(["cargo", "run", "--quiet", "-p", "rwp-server", "--", "--bind", "127.0.0.1:0"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const decoder = new TextDecoder();
	let settled = false;

	const finishResolve = (url: string): void => {
		if (settled) return;
		settled = true;
		resolve(url);
	};
	const finishReject = (error: Error): void => {
		if (settled) return;
		settled = true;
		reject(error);
	};

	const timeout = setTimeout(() => {
		finishReject(new Error("Timed out waiting for rwp-server to report its listening URL"));
	}, 300_000);

	const consume = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
		if (!stream) {
			return;
		}
		const reader = stream.getReader();
		let text = "";
		try {
			while (!settled) {
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}
				text += decoder.decode(chunk.value, { stream: true });
				const url = extractServerUrl(text);
				if (url) {
					finishResolve(url);
					break;
				}
			}
			text += decoder.decode();
			const url = extractServerUrl(text);
			if (url) {
				finishResolve(url);
			}
		} catch (error) {
			finishReject(error instanceof Error ? error : new Error(String(error)));
		} finally {
			reader.releaseLock();
		}
	};

	void consume(proc.stdout);
	void consume(proc.stderr);
	void proc.exited.then(code => {
		finishReject(new Error(`rwp-server exited before reporting its listening URL (exit ${code})`));
	});

	try {
		const baseUrl = await promise.finally(() => clearTimeout(timeout));
		return {
			baseUrl,
			async close(): Promise<void> {
				try {
					proc.kill();
				} catch {}
				const result = await Promise.race([
					proc.exited.then(() => "exit" as const),
					delay(5_000).then(() => "timeout" as const),
				]);
				if (result === "timeout") {
					try {
						proc.kill("SIGKILL");
					} catch {}
					await proc.exited;
				}
			},
		};
	} catch (error) {
		try {
			proc.kill("SIGKILL");
		} catch {}
		await proc.exited.catch(() => undefined);
		throw error;
	}
}

async function collectEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}
async function collectEventsAndReturn<TValue, TReturn>(
	stream: AsyncIterable<TValue>,
): Promise<{ events: TValue[]; result: TReturn | undefined }> {
	const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<TValue, TReturn>;
	const events: TValue[] = [];
	while (true) {
		const next = await iterator.next();
		if (next.done) {
			return { events, result: next.value };
		}
		events.push(next.value);
	}
}

function expectTables(result: ReadDbResponse): SqliteTableInfo[] {
	expect("tables" in result).toBe(true);
	if (!("tables" in result)) {
		throw new Error("Expected sqlite table listing response");
	}
	return result.tables;
}

export interface DogfoodResult {
	initialLines: string[];
	finalLines: string[];
	bashOutput: string;
	exitCode: number | null;
}

export interface BackendScenarioOptions {
	backendForDir(dir: string): Promise<Backend>;
	disposeBackend?(backend: Backend): Promise<void>;
	assertWriteReadEtagEquality?: boolean;
}

export async function runDogfoodScenario(backend: Backend, tempdir: string): Promise<DogfoodResult> {
	const initial = await backend.fs.readLines("hello.txt");
	const initialLines = [...initial.lines];
	await backend.edit.patch({
		path: "hello.txt",
		hunks: [{ start: 2, deleted: 1, inserted: ["line TWO"] }],
		ifMatch: initial.etag ?? undefined,
	});
	const updated = await backend.fs.readLines("hello.txt");
	const events = await collectEvents(
		backend.shell.exec({
			command: "wc -l hello.txt",
			cwd: tempdir,
			timeout_ms: 5_000,
		}),
	);
	const bashOutput = events
		.filter((event): event is Extract<BashEvent, { type: "output" }> => event.type === "output")
		.map(event => event.text)
		.join("");
	const exitEvents = events.filter((event): event is Extract<BashEvent, { type: "exit" }> => event.type === "exit");
	expect(updated.lines[1]).toBe("line TWO");
	expect(bashOutput).toContain("hello.txt");
	expect(exitEvents).toHaveLength(1);
	return {
		initialLines,
		finalLines: updated.lines,
		bashOutput,
		exitCode: exitEvents[0]?.exitCode ?? null,
	};
}

export function registerBackendScenarios(options: BackendScenarioOptions): void {
	it("fs.readLines + writeLines round-trip preserves CRLF when file had CRLF", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				const filePath = path.join(dir, "crlf.txt");
				await Bun.write(filePath, "alpha\r\nbeta\r\n");
				const initial = await backend.fs.readLines("crlf.txt");
				const write = await backend.fs.writeLines("crlf.txt", initial.lines.join("\n"), {
					ifMatch: initial.etag ?? undefined,
				});
				const reread = await backend.fs.readLines("crlf.txt");
				expect(await fs.readFile(filePath, "utf8")).toBe("alpha\r\nbeta\r\n");
				expect(reread.eol).toBe("CRLF");
				if (options.assertWriteReadEtagEquality) {
					expect(reread.etag).toBe(write.etag);
				}
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});
	it("fs.readLines reports totalLines for whole-file reads", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				await backend.fs.writeLines("lines.txt", "one\ntwo\nthree", { ifMatch: "*" });
				const result = await backend.fs.readLines("lines.txt");
				expect(result.totalLines).toBe(3);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});

	it("fs.writeLines with stale ifMatch throws EtagMismatchError", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				await backend.fs.writeLines("etag.txt", "current", { ifMatch: "*" });
				await expect(backend.fs.writeLines("etag.txt", "next", { ifMatch: "stale-etag" })).rejects.toBeInstanceOf(
					EtagMismatchError,
				);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});

	it("fs.glob returns expected paths", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				await backend.fs.writeLines("alpha/one.txt", "one", { ifMatch: "*" });
				await backend.fs.writeLines("alpha/two.md", "two", { ifMatch: "*" });
				await backend.fs.writeLines("beta.txt", "beta", { ifMatch: "*" });
				const result = await backend.fs.glob({
					patterns: ["**/*.txt"],
					paths: ["."],
					limit: 10,
				});
				const found = result.entries.map(entry => entry.path).sort();
				expect(found).toEqual(["alpha/one.txt", "beta.txt"]);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});

	it("fs.grep async-iterates and yields expected hits for a known pattern", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				await backend.fs.writeLines("grep.txt", "alpha\nneedle here\nomega", { ifMatch: "*" });
				const hits = await collectEvents(
					backend.fs.grep({
						pattern: "needle",
						paths: ["."],
						maxMatches: 10,
					}),
				);
				expect(
					hits.some(hit => hit.kind === "match" && hit.path === "grep.txt" && hit.text.includes("needle")),
				).toBe(true);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});
	it("fs.grep returns a completion summary", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				await backend.fs.writeLines("grep-summary.txt", "needle one\nneedle two\nneedle three\n", { ifMatch: "*" });
				const { events, result } = await collectEventsAndReturn<GrepHit, GrepSummary>(
					backend.fs.grep({
						pattern: "needle",
						paths: ["."],
						maxMatches: 2,
					}),
				);
				expect(events.filter(hit => hit.kind === "match")).toHaveLength(2);
				expect(result?.limitReached).toBe(true);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});

	it("edit.patch applies a one-hunk patch", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				await backend.fs.writeLines("patch.txt", "alpha\nbeta\ngamma", { ifMatch: "*" });
				await backend.edit.patch({
					path: "patch.txt",
					hunks: [{ start: 2, deleted: 1, inserted: ["delta"] }],
				});
				const result = await backend.fs.readLines("patch.txt");
				expect(result.lines).toEqual(["alpha", "delta", "gamma"]);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});

	it("edit.replace performs a literal replace and round-trips", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				await backend.fs.writeLines("replace.txt", "hello world", { ifMatch: "*" });
				await backend.edit.replace({ path: "replace.txt", old: "world", new: "there", fuzzy: false });
				let result = await backend.fs.readLines("replace.txt");
				expect(result.lines).toEqual(["hello there"]);
				await backend.edit.replace({ path: "replace.txt", old: "there", new: "world", fuzzy: false });
				result = await backend.fs.readLines("replace.txt");
				expect(result.lines).toEqual(["hello world"]);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});
	it("edit.grepAst returns columns and a completion summary", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				await backend.fs.writeLines("ast.ts", "const value = oldApi(1);\n", { ifMatch: "*" });
				const { events, result } = await collectEventsAndReturn<GrepAstHit, GrepAstSummary>(
					backend.edit.grepAst({
						pattern: "oldApi($$$ARGS)",
						paths: ["ast.ts"],
						language: "typescript",
					}),
				);
				expect(events).toHaveLength(1);
				expect(events[0]?.column).toBeGreaterThan(0);
				expect(events[0]?.endColumn).toBeGreaterThanOrEqual(events[0]!.column);
				expect(result?.filesSearched).toBe(1);
				expect(result?.limitReached).toBe(false);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});

	it("edit.editAst returns metadata fields", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				await backend.fs.writeLines("rewrite.ts", "const value = oldApi(1);\n", { ifMatch: "*" });
				const result = await backend.edit.editAst({
					ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }],
					paths: ["rewrite.ts"],
					language: "typescript",
					dryRun: true,
				});
				expect(result.filesSearched).toBe(1);
				expect(result.limitReached).toBe(false);
				expect(result.written).toBe(false);
				expect(result.truncated).toBe(false);
				expect(result.exceededLimit).toBe(false);
				expect(result.parseErrors).toEqual([]);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});

	it("shell.exec runs echo hello and exits cleanly", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			try {
				const events = await collectEvents(
					backend.shell.exec({
						command: "echo hello",
						cwd: dir,
						timeout_ms: 5_000,
					}),
				);
				const outputEvents = events.filter(
					(event): event is Extract<BashEvent, { type: "output" }> => event.type === "output",
				);
				const exitEvents = events.filter(
					(event): event is Extract<BashEvent, { type: "exit" }> => event.type === "exit",
				);
				expect(outputEvents.some(event => event.text.includes("hello"))).toBe(true);
				expect(exitEvents).toHaveLength(1);
				expect(exitEvents[0]?.exitCode).toBe(0);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});

	it("sqlite.read lists tables of a temp bun:sqlite DB created in the test", async () => {
		await withTempDir(async dir => {
			const backend = await options.backendForDir(dir);
			const dbPath = path.join(dir, "tables.sqlite");
			const db = new Database(dbPath);
			try {
				db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
			} finally {
				db.close();
			}
			try {
				const result = await backend.sqlite.read({ path: dbPath });
				const tables = expectTables(result);
				const users = tables.find(table => table.name === "users");
				expect(users).toBeDefined();
				expect(users?.columns.map(column => column.name)).toEqual(["id", "name"]);
			} finally {
				await options.disposeBackend?.(backend);
			}
		});
	});
}
