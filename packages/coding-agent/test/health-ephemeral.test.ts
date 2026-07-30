/**
 * Contract tests for ephemeral (eval/tmp) session detection
 * (`health/ephemeral`): temp cwds classify as ephemeral (including the
 * macOS `/private` alias and `os.tmpdir()`), real project cwds do not, and
 * the encoded session-dir-name fallback recognizes both the modern
 * `-tmp-*` and legacy `--<encoded-abs>--` forms.
 */
import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	isEphemeralCwd,
	isEphemeralSession,
	isEphemeralSessionDirName,
} from "@oh-my-pi/pi-coding-agent/health/ephemeral";

describe("isEphemeralCwd", () => {
	test("cwds under /tmp and /private/tmp are ephemeral", () => {
		expect(isEphemeralCwd("/tmp/outbound-smoke")).toBe(true);
		expect(isEphemeralCwd("/private/tmp/stage-e2e")).toBe(true);
		expect(isEphemeralCwd("/tmp")).toBe(true);
	});

	test("cwds under os.tmpdir() are ephemeral", () => {
		expect(isEphemeralCwd(path.join(os.tmpdir(), "canary-edit-work-xyz", "task-1"))).toBe(true);
		expect(isEphemeralCwd(os.tmpdir())).toBe(true);
	});

	test("home-project cwds are not ephemeral", () => {
		expect(isEphemeralCwd(path.join(os.homedir(), "Downloads", "oh-my-pi"))).toBe(false);
		expect(isEphemeralCwd("/Users/someone/work/repo")).toBe(false);
	});

	test("temp-prefixed but distinct paths are not ephemeral", () => {
		expect(isEphemeralCwd("/tmpfs/data")).toBe(false);
		expect(isEphemeralCwd("/home/user/tmp/project")).toBe(false);
	});
});

describe("isEphemeralSessionDirName", () => {
	test("modern temp-relative encodings are ephemeral", () => {
		expect(isEphemeralSessionDirName("-tmp")).toBe(true);
		expect(isEphemeralSessionDirName("-tmp-canary-edit-work-abc")).toBe(true);
	});

	test("legacy absolute encodings of temp roots are ephemeral", () => {
		expect(isEphemeralSessionDirName("--private-tmp-outbound-smoke--")).toBe(true);
		expect(isEphemeralSessionDirName("--tmp-stage-e2e--")).toBe(true);
		expect(isEphemeralSessionDirName("--private-var-folders-xx-yy-T-work--")).toBe(true);
	});

	test("home-relative and repo dir names are not ephemeral", () => {
		expect(isEphemeralSessionDirName("-Downloads-oh-my-pi")).toBe(false);
		expect(isEphemeralSessionDirName("-Downloads-oh-my-pi-packages-coding-agent")).toBe(false);
		expect(isEphemeralSessionDirName("--Volumes-work-repo--")).toBe(false);
		// "-tmpfs-cache" is home-relative (~/tmpfs/cache), not the temp root.
		expect(isEphemeralSessionDirName("-tmpfs-cache")).toBe(false);
	});
});

describe("isEphemeralSession", () => {
	test("header cwd decides when present", () => {
		expect(isEphemeralSession({ headerCwd: "/tmp/work", sessionDirName: "-Downloads" })).toBe(true);
		// A real cwd wins even when the dir name looks ephemeral.
		expect(
			isEphemeralSession({
				headerCwd: path.join(os.homedir(), "repo"),
				sessionDirName: "--private-tmp-work--",
			}),
		).toBe(false);
	});

	test("falls back to the dir name when the header cwd is missing or empty", () => {
		expect(isEphemeralSession({ headerCwd: "", sessionDirName: "--private-tmp-work--" })).toBe(true);
		expect(isEphemeralSession({ sessionDirName: "-tmp-run" })).toBe(true);
		expect(isEphemeralSession({ headerCwd: "", sessionDirName: "-Downloads" })).toBe(false);
	});

	test("no information means not ephemeral", () => {
		expect(isEphemeralSession({})).toBe(false);
		expect(isEphemeralSession({ headerCwd: "", sessionDirName: "" })).toBe(false);
	});
});
