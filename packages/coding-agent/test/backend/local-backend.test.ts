import { describe, expect, it } from "bun:test";
import { LocalBackend } from "../../src/backend";
import { registerBackendScenarios, withTempDir } from "./utils";

describe("LocalBackend", () => {
	registerBackendScenarios({
		async backendForDir(dir) {
			return new LocalBackend({ cwd: dir });
		},
		async disposeBackend(backend) {
			await backend.dispose();
		},
	});

	it("kernel.get preserves transport and idle timeout config", async () => {
		await withTempDir(async dir => {
			const backend = new LocalBackend({ cwd: dir });
			try {
				await backend.kernel.put("py", { kind: "eval", lang: "python", transport: "stdio", idleTimeoutMs: 4321 });
				const status = await backend.kernel.get("py");
				expect(status?.config.transport).toBe("stdio");
				expect(status?.config.idleTimeoutMs).toBe(4321);
			} finally {
				await backend.dispose();
			}
		});
	});
});
