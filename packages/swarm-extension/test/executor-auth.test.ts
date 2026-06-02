import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, ModelRegistry, Settings, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent";
import { PipelineController } from "../src/swarm/pipeline";
import { parseSwarmYaml } from "../src/swarm/schema";
import { StateTracker } from "../src/swarm/state";

class AbortingModelRegistry extends ModelRegistry {
	#abortController: AbortController;

	constructor(authStorage: AuthStorage, abortController: AbortController) {
		super(authStorage);
		this.#abortController = abortController;
	}

	override getAvailable() {
		this.#abortController.abort("registry reached");
		return [];
	}
}

describe("swarm executor auth storage", () => {
	const tempDirs: string[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		await Promise.all(tempDirs.splice(0).map(tempDir => fs.rm(tempDir, { force: true, recursive: true })));
	});

	it("uses the model registry auth storage when both auth inputs are present", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-swarm-auth-"));
		tempDirs.push(workspace);

		const sessionAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		const discoveredAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		authStorages.push(sessionAuthStorage, discoveredAuthStorage);

		const abortController = new AbortController();
		const modelRegistry = new AbortingModelRegistry(sessionAuthStorage, abortController);
		const def = parseSwarmYaml(`
swarm:
  name: auth-repro
  workspace: .
  mode: parallel
  target_count: 1
  model: dummy-model
  agents:
    inventory:
      role: inventory
      task: Inventory this repo.
`);
		const stateTracker = new StateTracker(workspace, def.name);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

		const controller = new PipelineController(def, [["inventory"]], stateTracker);
		const result = await controller.run({
			workspace,
			signal: abortController.signal,
			authStorage: discoveredAuthStorage,
			modelRegistry,
			settings: Settings.isolated(),
		});

		const errors = result.errors.join("\n");
		expect(errors).not.toContain("options.authStorage and options.modelRegistry.authStorage");
		expect(result.agentResults.get("inventory")?.[0]?.aborted).toBe(true);
	});
});
