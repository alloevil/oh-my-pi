import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { computeBankScope, deriveBankId, ensureBankMission } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";

const baseConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelRefreshIntervalMs: 5 * 60 * 1000,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

describe("computeBankScope", () => {
	describe("scoping=global", () => {
		it("returns the configured bank id verbatim", async () => {
			expect(await computeBankScope(baseConfig({ bankId: "team-a" }), "/work/proj")).toEqual({
				bankId: "team-a",
			});
		});

		it("falls back to the default bank name when bankId is unset", async () => {
			expect(await computeBankScope(baseConfig(), "/whatever")).toEqual({ bankId: "omp" });
		});

		it("applies the configured prefix", async () => {
			expect(await computeBankScope(baseConfig({ bankId: "team", bankIdPrefix: "prod" }), "/cwd")).toEqual({
				bankId: "prod-team",
			});
		});

		it("does not surface tag fields", async () => {
			const scope = await computeBankScope(baseConfig(), "/work/proj");
			expect(scope.retainTags).toBeUndefined();
			expect(scope.recallTags).toBeUndefined();
			expect(scope.recallTagsMatch).toBeUndefined();
		});
	});

	describe("scoping=per-project", () => {
		it("appends the cwd basename to the base bank id", async () => {
			expect(await computeBankScope(baseConfig({ scoping: "per-project" }), "/work/proj")).toEqual({
				bankId: "omp-proj",
			});
		});

		it("appends `unknown` for an empty cwd", async () => {
			expect(await computeBankScope(baseConfig({ scoping: "per-project" }), "")).toEqual({
				bankId: "omp-unknown",
			});
		});

		it("composes prefix + bankId + project", async () => {
			const scope = await computeBankScope(
				baseConfig({ scoping: "per-project", bankId: "team", bankIdPrefix: "prod" }),
				"/work/cool-app",
			);
			expect(scope.bankId).toBe("prod-team-cool-app");
		});

		it("does not surface tag fields (isolation is at the bank level)", async () => {
			const scope = await computeBankScope(baseConfig({ scoping: "per-project" }), "/work/proj");
			expect(scope.retainTags).toBeUndefined();
			expect(scope.recallTags).toBeUndefined();
		});
	});

	describe("scoping=per-project-tagged", () => {
		it("keeps the base bank id and emits project tags with `any` match", async () => {
			expect(await computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "/work/proj")).toEqual({
				bankId: "omp",
				retainTags: ["project:proj"],
				recallTags: ["project:proj"],
				recallTagsMatch: "any",
			});
		});

		it("uses the same project label for retain and recall tags", async () => {
			const scope = await computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "/repo/cool-app");
			expect(scope.retainTags).toEqual(["project:cool-app"]);
			expect(scope.recallTags).toEqual(["project:cool-app"]);
		});

		it("falls back to project:unknown when cwd is empty", async () => {
			const scope = await computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "");
			expect(scope.retainTags).toEqual(["project:unknown"]);
			expect(scope.recallTags).toEqual(["project:unknown"]);
		});
	});

	describe("worktree stability", () => {
		/**
		 * Build a minimal git worktree filesystem on disk:
		 *
		 *   <tmp>/main-repo/.git/                  ← main repo's git dir
		 *   <tmp>/main-repo/.git/worktrees/<wt>/   ← per-worktree metadata
		 *   <tmp>/main-repo/.git/worktrees/<wt>/commondir  ← contains "../.."
		 *   <tmp>/<wt-dirname>/.git                ← gitdir file pointing into above
		 *
		 * This is exactly the structure `git worktree add` produces.
		 */
		function makeWorktreeFixture(mainName: string, wtDirname: string, wtName: string) {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hb-wt-"));
			const mainDir = path.join(tmp, mainName);
			const wtDir = path.join(tmp, wtDirname);
			const wtGitDir = path.join(mainDir, ".git", "worktrees", wtName);
			fs.mkdirSync(path.join(mainDir, ".git"), { recursive: true });
			fs.mkdirSync(wtGitDir, { recursive: true });
			fs.writeFileSync(path.join(wtGitDir, "commondir"), "../..\n");
			fs.mkdirSync(wtDir, { recursive: true });
			fs.writeFileSync(path.join(wtDir, ".git"), `gitdir: ${wtGitDir}\n`);
			return { tmp, mainDir, wtDir };
		}

		it("worktree and main checkout resolve to the same project:monorepo tag", async () => {
			const { tmp, mainDir, wtDir } = makeWorktreeFixture("monorepo", "monorepo-HOA-5574", "HOA-5574");
			try {
				const config = baseConfig({ scoping: "per-project-tagged" });
				const mainScope = await computeBankScope(config, mainDir);
				const wtScope = await computeBankScope(config, wtDir);
				expect(mainScope.retainTags).toEqual(["project:monorepo"]);
				expect(wtScope.retainTags).toEqual(["project:monorepo"]);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		});

		it(".worktrees/<repo>/<ticket> convention resolves to the parent repo name", async () => {
			// ~/Documents/GitHub/.worktrees/monorepo/HOA-5602 → project:monorepo
			const { tmp, mainDir, wtDir } = makeWorktreeFixture("monorepo", ".worktrees/monorepo/HOA-5602", "HOA-5602");
			try {
				const config = baseConfig({ scoping: "per-project-tagged" });
				const scope = await computeBankScope(config, wtDir);
				expect(scope.retainTags).toEqual(["project:monorepo"]);
				// main checkout still resolves correctly too
				const mainScope = await computeBankScope(config, mainDir);
				expect(mainScope.retainTags).toEqual(["project:monorepo"]);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("per-project scoping also benefits: worktree routes to the same bank", async () => {
			const { tmp, mainDir, wtDir } = makeWorktreeFixture("myrepo", "myrepo-feature", "feature");
			try {
				const config = baseConfig({ scoping: "per-project" });
				const mainScope = await computeBankScope(config, mainDir);
				const wtScope = await computeBankScope(config, wtDir);
				expect(mainScope.bankId).toBe("omp-myrepo");
				expect(wtScope.bankId).toBe("omp-myrepo");
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		});
	});
});

describe("deriveBankId (legacy wrapper)", () => {
	it("returns the bankId field of the resolved scope", async () => {
		expect(await deriveBankId(baseConfig({ bankId: "team", bankIdPrefix: "prod" }), "/cwd")).toBe("prod-team");
		expect(await deriveBankId(baseConfig({ scoping: "per-project" }), "/work/proj")).toBe("omp-proj");
		expect(await deriveBankId(baseConfig({ scoping: "per-project-tagged" }), "/work/proj")).toBe("omp");
	});
});

describe("ensureBankMission", () => {
	let client: HindsightApi;
	let createSpy: Mock<HindsightApi["createBank"]> | undefined;

	beforeEach(() => {
		client = new HindsightApi({ baseUrl: "http://localhost:8888" });
	});

	afterEach(() => {
		createSpy?.mockRestore();
	});

	it("calls createBank exactly once per bank id", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const seen = new Set<string>();
		const config = baseConfig({ bankMission: "remember everything", retainMission: "extract facts" });

		await ensureBankMission(client, "bank-a", config, seen);
		await ensureBankMission(client, "bank-a", config, seen);
		await ensureBankMission(client, "bank-b", config, seen);

		expect(createSpy).toHaveBeenCalledTimes(2);
		expect(createSpy).toHaveBeenCalledWith(
			"bank-a",
			expect.objectContaining({ reflectMission: "remember everything", retainMission: "extract facts" }),
		);
		expect(createSpy).toHaveBeenCalledWith("bank-b", expect.any(Object));
		expect(seen.has("bank-a")).toBe(true);
		expect(seen.has("bank-b")).toBe(true);
	});

	it("is a no-op when no mission is configured", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const seen = new Set<string>();
		await ensureBankMission(client, "bank", baseConfig({ bankMission: "" }), seen);
		await ensureBankMission(client, "bank", baseConfig({ bankMission: "   " }), seen);
		expect(createSpy).not.toHaveBeenCalled();
		expect(seen.size).toBe(0);
	});

	it("swallows API failures and does not mark the bank as initialised", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockRejectedValue(new Error("HTTP 500"));
		const seen = new Set<string>();
		const config = baseConfig({ bankMission: "do the thing" });

		await expect(ensureBankMission(client, "bank-x", config, seen)).resolves.toBeUndefined();
		expect(seen.has("bank-x")).toBe(false);
	});
});
