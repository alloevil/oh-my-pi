import { describe, expect, it } from "bun:test";
import { RwpClient } from "@oh-my-pi/rwp-client";
import { zipSync } from "fflate";
import { RemoteBackend } from "../../src/backend";
import { spawnRwpServer, withTempDir } from "./utils";

describe("RemoteBackend", () => {
	it("archive snapshots survive session cwd changes", async () => {
		await withTempDir(async dir => {
			await Bun.write(`${dir}/fixture.zip`, zipSync({ "root.txt": new TextEncoder().encode("root") }));
			await Bun.write(`${dir}/subdir/.keep`, "");

			const server = await spawnRwpServer();
			const client = new RwpClient({ baseUrl: server.baseUrl });
			const session = await client.createSession({ cwd: dir });
			const backend = new RemoteBackend({ baseUrl: server.baseUrl, sessionId: session.id });
			const snapshot = await backend.fs.openArchive("fixture.zip");
			try {
				const setCwd = await fetch(`${server.baseUrl}/sessions/${session.id}/cwd`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ cwd: `${dir}/subdir` }),
				});
				expect(setCwd.status).toBe(204);

				const entries = await snapshot.entries();
				expect(entries.map(entry => entry.path)).toEqual(["root.txt"]);
				const bytes = await snapshot.readEntry("root.txt");
				expect(new TextDecoder().decode(bytes)).toBe("root");
			} finally {
				await snapshot.close();
				await backend.dispose();
				await client.deleteSession(session.id);
				await server.close();
			}
		});
	}, 300_000);
});
