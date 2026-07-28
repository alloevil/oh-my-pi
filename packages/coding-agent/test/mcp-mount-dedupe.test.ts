/**
 * Contract: one MCP server registered under two names (typically a
 * plugin-namespaced alias like `context7:context7` next to a plain `context7`
 * entry) must connect and mount only once, and the plain name must win so
 * minted tool names don't stutter. Distinct connection identities always
 * coexist. Downstream, final minted tool names must never silently collide in
 * the session tool registry.
 */
import { describe, expect, it } from "bun:test";
import { dedupeServerConfigsByIdentity } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { dedupeMCPToolsByName } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

const STDIO: MCPServerConfig = {
	type: "stdio",
	command: "bunx",
	args: ["@upstash/context7-mcp"],
};

describe("dedupeServerConfigsByIdentity", () => {
	it("collapses two names for the same connection and keeps the plain one, in either order", () => {
		const aliasFirst = dedupeServerConfigsByIdentity(
			{ "context7:context7": { ...STDIO }, context7: { ...STDIO } },
			{},
		);
		expect(Object.keys(aliasFirst.configs)).toEqual(["context7"]);

		const plainFirst = dedupeServerConfigsByIdentity(
			{ context7: { ...STDIO }, "context7:context7": { ...STDIO } },
			{},
		);
		expect(Object.keys(plainFirst.configs)).toEqual(["context7"]);
	});

	it("keeps both entries when the connection identity differs", () => {
		const { configs } = dedupeServerConfigsByIdentity(
			{
				context7: { ...STDIO },
				"context7:context7": { ...STDIO, env: { API_KEY: "other" } },
			},
			{},
		);
		expect(Object.keys(configs).sort()).toEqual(["context7", "context7:context7"]);
	});

	it("dedupes http servers by url and headers", () => {
		const http: MCPServerConfig = { type: "http", url: "https://mcp.example.com/sse" };
		const { configs } = dedupeServerConfigsByIdentity(
			{
				"plugin:remote": { ...http },
				remote: { ...http },
				other: { type: "http", url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer x" } },
			},
			{},
		);
		expect(Object.keys(configs).sort()).toEqual(["other", "remote"]);
	});
});

describe("dedupeMCPToolsByName", () => {
	it("keeps the first tool when lossy sanitization folds two registrations into one name", () => {
		const tools = [
			{ name: "mcp__foo_bar_run", mcpServerName: "foo.bar", mcpToolName: "run" },
			{ name: "mcp__foo_bar_run", mcpServerName: "foo_bar", mcpToolName: "run" },
			{ name: "mcp__foo_bar_stop", mcpServerName: "foo.bar", mcpToolName: "stop" },
		];
		const deduped = dedupeMCPToolsByName(tools);
		expect(deduped.map(tool => tool.name)).toEqual(["mcp__foo_bar_run", "mcp__foo_bar_stop"]);
		expect(deduped[0].mcpServerName).toBe("foo.bar");
	});
});
