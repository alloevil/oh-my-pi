/**
 * Contract for `tools.xdevTopLevelDevices`: a discoverable tool whose name
 * matches a configured glob must stay top-level (skipping xd:// dispatch
 * round-trips) while non-matching tools still mount; transport tools and
 * essential tools are never affected by pins; malformed config entries are
 * dropped instead of breaking partitioning.
 */
import { describe, expect, it } from "bun:test";
import { compileXdevDeviceGlobs, isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";

describe("tools.xdevTopLevelDevices pins", () => {
	it("keeps a matching discoverable tool top-level and mounts the rest", () => {
		const pins = compileXdevDeviceGlobs(["lsp", "mcp__linear_*"]);
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" }, pins)).toBe(false);
		expect(isMountableUnderXdev({ name: "mcp__linear_create_issue", loadMode: "discoverable" }, pins)).toBe(false);
		expect(isMountableUnderXdev({ name: "browser", loadMode: "discoverable" }, pins)).toBe(true);
	});

	it("never promotes transport tools or demotes essentials via pins", () => {
		const pins = compileXdevDeviceGlobs(["*"]);
		// A '*' pin keeps every discoverable tool top-level…
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" }, pins)).toBe(false);
		// …and essential tools were never mountable to begin with.
		expect(isMountableUnderXdev({ name: "edit", loadMode: "essential" }, pins)).toBe(false);
	});

	it("drops malformed glob config entries instead of breaking partitioning", () => {
		const pins = compileXdevDeviceGlobs([42, null, "lsp"] as unknown as string[]);
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" }, pins)).toBe(false);
		expect(isMountableUnderXdev({ name: "debug", loadMode: "discoverable" }, pins)).toBe(true);
	});
});
