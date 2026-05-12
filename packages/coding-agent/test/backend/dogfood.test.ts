import { describe, expect, it } from "bun:test";
import { RwpClient, type RwpSession } from "@oh-my-pi/rwp-client";
import { LocalBackend, RemoteBackend } from "../../src/backend";
import { type DogfoodResult, runDogfoodScenario, spawnRwpServer, withTempDir } from "./utils";

describe.skipIf(process.platform === "win32")("dogfood scenario", () => {
	it("matches between LocalBackend and RemoteBackend", async () => {
		const localResult = await withTempDir(async dir => {
			await Bun.write(`${dir}/hello.txt`, "line one\nline two\nline three\n");
			const backend = new LocalBackend({ cwd: dir });
			try {
				return await runDogfoodScenario(backend, dir);
			} finally {
				await backend.dispose();
			}
		});

		const server = await spawnRwpServer();
		try {
			const remoteResult = await withTempDir(async dir => {
				await Bun.write(`${dir}/hello.txt`, "line one\nline two\nline three\n");
				const client = new RwpClient({ baseUrl: server.baseUrl });
				const session: RwpSession = await client.createSession({ cwd: dir });
				const backend = new RemoteBackend({ baseUrl: server.baseUrl, sessionId: session.id });
				try {
					return await runDogfoodScenario(backend, dir);
				} finally {
					await backend.dispose();
					await session.delete();
				}
			});

			expect(remoteResult.initialLines).toEqual(localResult.initialLines);
			expect(remoteResult.finalLines).toEqual(localResult.finalLines);
			expect(remoteResult.bashOutput).toBe(localResult.bashOutput);
			expect(remoteResult.exitCode).toBe(localResult.exitCode);
			expect(remoteResult).toEqual<DogfoodResult>(localResult);
		} finally {
			await server.close();
		}
	}, 180_000);
});
