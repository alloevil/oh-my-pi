/**
 * Repro for https://github.com/can1357/oh-my-pi/issues/1777
 *
 * `validateLoadedBindings` intentionally skips the per-release version
 * sentinel check on workspace dev loads so a stale post-pull `packages/
 * natives/native/<addon>.node` boots while `bun --cwd=packages/natives run
 * build` rebuilds. The old branch silently returned, so the next native call
 * — e.g. `applyBashFixups` from `packages/coding-agent/src/tools/bash-
 * command-fixup.ts` — crashed with `<sym> is not a function` and no hint
 * about why.
 *
 * The contract this test pins down: in workspace dev with a missing sentinel
 * the loader still returns (boot continues) but writes a one-time, actionable
 * rebuild hint to stderr. Install and compiled-binary loads still throw the
 * actionable reinstall error.
 */
import { describe, expect, it } from "bun:test";
import { validateLoadedBindings } from "../native/loader-state.js";

function makeCtx(overrides: { isWorkspaceLoad: boolean }): {
	versionSentinelExport: string;
	isWorkspaceLoad: boolean;
	packageVersion: string;
} {
	return {
		versionSentinelExport: "__piNativesV99_0_0",
		isWorkspaceLoad: overrides.isWorkspaceLoad,
		packageVersion: "99.0.0",
	};
}

function captureStderr(): { writes: string[]; stderr: { write(chunk: string): true } } {
	const writes: string[] = [];
	return {
		writes,
		stderr: {
			write(chunk: string): true {
				writes.push(chunk);
				return true;
			},
		},
	};
}

describe("issue 1777: workspace-stale native exports", () => {
	it("returns silently when the version sentinel is present", () => {
		const { writes, stderr } = captureStderr();
		const bindings = { __piNativesV99_0_0: () => {} } as Record<string, unknown>;

		expect(() =>
			validateLoadedBindings(makeCtx({ isWorkspaceLoad: true }), bindings, "/ws/pi_natives.linux-x64.node", {
				stderr,
			}),
		).not.toThrow();
		expect(writes).toEqual([]);
	});

	it("writes a rebuild hint to stderr in workspace dev when the sentinel is missing", () => {
		const { writes, stderr } = captureStderr();

		expect(() =>
			validateLoadedBindings(makeCtx({ isWorkspaceLoad: true }), {}, "/ws/pi_natives.linux-x64.node", { stderr }),
		).not.toThrow();

		expect(writes.length).toBe(1);
		const message = writes[0]!;
		expect(message).toContain("@oh-my-pi/pi-natives");
		expect(message).toContain("/ws/pi_natives.linux-x64.node");
		expect(message).toContain("99.0.0");
		expect(message).toContain("__piNativesV99_0_0");
		expect(message).toContain("bun --cwd=packages/natives run build");
		expect(message.endsWith("\n")).toBe(true);
	});

	it("throws the actionable reinstall error outside workspace dev when the sentinel is missing", () => {
		const { writes, stderr } = captureStderr();

		expect(() =>
			validateLoadedBindings(makeCtx({ isWorkspaceLoad: false }), {}, "/nm/pi_natives.linux-x64.node", { stderr }),
		).toThrow(/reinstall to re-sync/);
		// Install/compiled paths surface the error via throw, not stderr.
		expect(writes).toEqual([]);
	});
});
