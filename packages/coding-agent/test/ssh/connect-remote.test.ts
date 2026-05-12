import { describe, expect, it } from "bun:test";
import {
	connectRemote,
	detectRemotePlatform,
	mapUnameToRemotePlatform,
	parseConnectTarget,
} from "../../src/ssh/connect-remote";

describe("parseConnectTarget", () => {
	it("parses ssh scheme with username", () => {
		expect(parseConnectTarget("ssh://alice@example.com")).toEqual({
			host: {
				name: "alice@example.com",
				host: "example.com",
				username: "alice",
				port: undefined,
			},
		});
	});

	it("parses ssh scheme with username and port", () => {
		expect(parseConnectTarget("ssh://alice@example.com:2222")).toEqual({
			host: {
				name: "alice@example.com:2222",
				host: "example.com",
				username: "alice",
				port: 2222,
			},
		});
	});

	it("parses scp-like user@host targets", () => {
		expect(parseConnectTarget("alice@example.com")).toEqual({
			host: {
				name: "alice@example.com",
				host: "example.com",
				username: "alice",
				port: undefined,
			},
		});
	});

	it("parses bare host targets", () => {
		expect(parseConnectTarget("example.com")).toEqual({
			host: {
				name: "example.com",
				host: "example.com",
				username: undefined,
				port: undefined,
			},
		});
	});

	it("extracts remote path suffix from URL form", () => {
		expect(parseConnectTarget("ssh://alice@example.com/tmp/workspace")).toEqual({
			host: {
				name: "alice@example.com",
				host: "example.com",
				username: "alice",
				port: undefined,
			},
			path: "/tmp/workspace",
		});
	});

	it("extracts remote path suffix from scp-style target", () => {
		expect(parseConnectTarget("alice@example.com:/srv/work")).toEqual({
			host: {
				name: "alice@example.com",
				host: "example.com",
				username: "alice",
				port: undefined,
			},
			path: "/srv/work",
		});
	});

	it("allows absolute-looking URL path suffixes", () => {
		expect(() => parseConnectTarget("ssh://example.com/relative/path")).not.toThrow();
	});

	it("rejects tilde-prefixed path suffix for now", () => {
		expect(() => parseConnectTarget("alice@example.com:~/work")).toThrow();
	});

	it("rejects unsupported schemes", () => {
		expect(() => parseConnectTarget("http://example.com")).toThrow("Unsupported --connect scheme");
	});
});

describe("mapUnameToRemotePlatform", () => {
	it("maps supported Darwin and Linux targets", () => {
		expect(mapUnameToRemotePlatform("Darwin arm64")).toMatchObject({ id: "darwin-arm64" });
		expect(mapUnameToRemotePlatform("Darwin x86_64")).toMatchObject({ id: "darwin-x64" });
		expect(mapUnameToRemotePlatform("Linux x86_64")).toMatchObject({ id: "linux-x64" });
		expect(mapUnameToRemotePlatform("Linux aarch64")).toMatchObject({ id: "linux-arm64" });
	});

	it("rejects unsupported targets", () => {
		expect(() => mapUnameToRemotePlatform("FreeBSD amd64")).toThrow("Unsupported remote platform");
	});
});

describe("detectRemotePlatform", () => {
	it("maps uname output through executeSSH", async () => {
		const detected = await detectRemotePlatform(
			{ name: "host", host: "example.com" },
			{
				executeSSH: async () => ({
					output: "Linux aarch64\n",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 1,
					totalBytes: 14,
					outputLines: 1,
					outputBytes: 14,
				}),
			},
		);
		expect(detected).toMatchObject({ id: "linux-arm64" });
	});

	it("falls back to a Windows probe when uname is unusable", async () => {
		let call = 0;
		const detected = await detectRemotePlatform(
			{ name: "host", host: "example.com" },
			{
				executeSSH: async () => {
					call += 1;
					if (call === 1) {
						return {
							output: "",
							exitCode: 1,
							cancelled: false,
							truncated: false,
							totalLines: 0,
							totalBytes: 0,
							outputLines: 0,
							outputBytes: 0,
						};
					}
					return {
						output: "Win32NT\n",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						totalLines: 1,
						totalBytes: 8,
						outputLines: 1,
						outputBytes: 8,
					};
				},
			},
		);
		expect(detected).toMatchObject({ id: "win32-x64" });
	});
});

describe("connectRemote", () => {
	it("passes the parsed remote path through as remote.cwd", async () => {
		const child = {
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("rwp-server listening on http://127.0.0.1:43123\n"));
					controller.close();
				},
			}),
			stderr: null,
			exited: new Promise<number>(() => {}),
			kill: () => undefined,
		};
		const connection = await connectRemote("alice@example.com:/srv/work", {
			allocatePort: async () => 43123,
			readWorkspaceVersion: async () => "1.2.3",
			resolveBundledBinary: () => "/tmp/rwp-server",
			randomToken: () => "token",
			executeSSH: async (_host, command) => {
				if (command === "uname -s -m") {
					return {
						output: "Linux x86_64\n",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						totalLines: 1,
						totalBytes: 13,
						outputLines: 1,
						outputBytes: 13,
					};
				}
				return {
					output: "rwp-server 1.2.3\n",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 1,
					totalBytes: 17,
					outputLines: 1,
					outputBytes: 17,
				};
			},
			copyFileSCP: async () => {},
			spawnWithPortForward: async () => child,
		});
		expect(connection.remote.cwd).toBe("/srv/work");
	});
});

describe.skipIf(!Bun.env.OMP_CONNECT_LIVE_TEST)("detectRemotePlatform live", () => {
	it("detects localhost over ssh", async () => {
		const detected = await detectRemotePlatform(parseConnectTarget("localhost").host);
		expect(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]).toContain(detected.id);
	});
});
