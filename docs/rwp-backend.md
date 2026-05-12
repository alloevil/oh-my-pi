# RWP backend guide

The `Backend` trait family in `packages/coding-agent/src/backend/backend.ts` is the coding-agent IO boundary: tools talk to a session-scoped backend instead of reaching directly into `pi-natives`, local managers, or ad hoc filesystem/process APIs. That indirection keeps tool contracts stable while `packages/coding-agent/src/sdk.ts` wires the concrete implementation with `pickBackend({ cwd: toolSession.cwd, env: Bun.env })`, choosing `LocalBackend` for in-process execution or `RemoteBackend` when `RWP_URL` points at `rwp-server`.

## Contents

- [Trait surface](#trait-surface)
  - [FsBackend](#fsbackend)
  - [EditBackend](#editbackend)
  - [ShellBackend](#shellbackend)
  - [SqliteBackend](#sqlitebackend)
  - [KernelBackend](#kernelbackend)
  - [LspBackend](#lspbackend)
  - [DapBackend](#dapbackend)
  - [BrowserBackend](#browserbackend)
- [How to add a new tool](#how-to-add-a-new-tool)
- [How to add a new backend method](#how-to-add-a-new-backend-method)
- [Cross-compiling `rwp-server`](#cross-compiling-rwp-server)
- [Anti-patterns](#anti-patterns)
- [Related references](#related-references)

## Trait surface

The signatures below are copied verbatim from `packages/coding-agent/src/backend/backend.ts`.

### FsBackend

```ts
export interface FsBackend {
	readLines(path: string, opts?: T.ReadLinesOptions): Promise<T.ReadLinesResult>;
	readBlob(path: string, opts?: T.ReadBlobOptions): Promise<T.ReadBlobResult>;
	readAst(path: string, opts?: T.ReadAstOptions): Promise<T.AstSummary>;
	writeLines(path: string, text: string, opts: T.WriteOptions): Promise<T.WriteResult>;
	writeBlob(path: string, bytes: Uint8Array, opts: T.WriteOptions): Promise<T.WriteResult>;
	stat(path: string, opts?: { signal?: AbortSignal }): Promise<T.StatResult>;
	exists(path: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
	archiveEntries(path: string, opts?: T.ArchiveEntriesOptions): Promise<T.ArchiveEntriesResult>;
	archiveReadEntry(path: string, entry: string, opts?: { signal?: AbortSignal }): Promise<T.ReadBlobResult>;
	archiveWriteEntry(
		path: string,
		entry: string,
		bytes: Uint8Array,
		opts: { ifMatch?: string | "*"; signal?: AbortSignal },
	): Promise<T.WriteResult>;
	glob(req: T.GlobRequest): Promise<T.GlobResult>;
	grep(req: T.GrepRequest): AsyncIterable<T.GrepHit>;
}
```

### EditBackend

```ts
export interface EditBackend {
	patch(req: T.EditPatchRequest): Promise<T.EditResult>;
	replace(req: T.EditReplaceRequest): Promise<T.EditResult>;
	editAst(req: T.EditAstRequest): Promise<T.AstEditResult>;
	grepAst(req: T.GrepAstRequest): AsyncIterable<T.GrepAstHit>;
}
```

### ShellBackend

```ts
export interface ShellBackend {
	exec(req: T.BashExecRequest): AsyncIterable<T.BashEvent>;
}
```

### SqliteBackend

```ts
export interface SqliteBackend {
	read(req: T.ReadDbRequest): Promise<T.ReadDbResponse>;
	write(req: T.WriteDbRequest): Promise<T.WriteDbResponse>;
}
```

### KernelBackend

```ts
export interface KernelBackend {
	put(name: string, cfg: T.KernelConfig): Promise<T.KernelStatus>;
	get(name: string): Promise<T.KernelStatus | null>;
	exec(name: string, req: T.KernelExecRequest): AsyncIterable<T.KernelEvent>;
	delete(name: string): Promise<void>;
}
```

### LspBackend

```ts
export interface LspBackend {
	put(name: string, cfg: T.LspConfig): Promise<T.LspStatus>;
	get(name: string): Promise<T.LspStatus | null>;
	openChannel(name: string, opts?: { signal?: AbortSignal }): Promise<JsonRpcChannel>;
	delete(name: string): Promise<void>;
}
```

### DapBackend

```ts
export interface DapBackend {
	put(name: string, cfg: T.DapConfig): Promise<T.DapStatus>;
	get(name: string): Promise<T.DapStatus | null>;
	openChannel(name: string, opts?: { signal?: AbortSignal }): Promise<JsonRpcChannel>;
	delete(name: string): Promise<void>;
}
```

### BrowserBackend

```ts
export interface BrowserBackend {
	put(name: string, cfg: T.BrowserConfig): Promise<T.BrowserStatus>;
	get(name: string): Promise<T.BrowserStatus | null>;
	wsUrl(name: string): Promise<string>;
	delete(name: string): Promise<void>;
}
```

For completeness, `Backend` is the aggregate interface that exposes these areas as `readonly fs`, `edit`, `shell`, `sqlite`, `kernel`, `lsp`, `dap`, and `browser`, plus `dispose(): Promise<void>`.

## How to add a new tool

1. Decide which backend area owns the operation. Do not let a tool invent its own IO path if the call is really filesystem, edit, shell, sqlite, kernel, LSP, DAP, or browser work.
2. In the tool's `execute()` path, use the required session backend from `this.session.backend`.
3. Dispatch through the appropriate method, for example `this.session.backend.fs.readLines(...)` or `this.session.backend.shell.exec(...)`.
4. Keep transport details out of the tool. The tool should shape tool-level input/output; `LocalBackend` and `RemoteBackend` own the local-vs-RWP split.
5. Add coverage for both backend implementations using the shared helper in `packages/coding-agent/test/backend/utils.ts`:
   - `packages/coding-agent/test/backend/local-backend.test.ts`
   - `packages/coding-agent/test/backend/remote-backend.test.ts`
   - extend `registerBackendScenarios(...)` when the behavior is backend-generic
   - add tool-specific tests if the tool has rendering, validation, or error mapping beyond the raw backend call

Minimal pattern:

```ts
const backend = this.session.backend;
return await backend.<area>.<method>(...);
```

## How to add a new backend method

1. Add the method to the correct interface in `packages/coding-agent/src/backend/backend.ts`.
2. Implement it in `packages/coding-agent/src/backend/local-backend.ts`, reusing the existing in-process code path instead of bypassing the backend.
3. Implement it in `packages/coding-agent/src/backend/remote-backend.ts`, delegating to `RwpClient` when the client already exposes the call or to `fetch`/stream handling when it does not yet have a typed helper.
4. If the capability must exist server-side, add the endpoint and handler in `crates/rwp-server/src/handlers/*.rs` and wire any request/response protocol pieces needed by `rwp-server` and `rwp-client`.
5. Add tests on both sides:
   - coding-agent backend tests for `LocalBackend` and `RemoteBackend`
   - client/server protocol tests where a new route, stream shape, or wire type was introduced
6. Only after both backend implementations exist should tools call the new method.

That sequence keeps `pickBackend(...)` honest: every tool call works the same way whether the session is local or remote.

## Cross-compiling `rwp-server`

Release builds bundle five prebuilt `rwp-server-*` binaries under `packages/coding-agent/binaries/`. The build entrypoint is `scripts/ci-build-rwp-server.ts`, which maps the release matrix target ids (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`) to Cargo target triples, runs either `cargo build --release` or `cargo zigbuild --release --no-default-features`, and copies the resulting executable to the package bundle directory.

Runtime lookup lives in `packages/coding-agent/src/backend/rwp-server-path.ts`:
- `resolveLocalRwpServerBinary()` resolves the current host binary or returns `null` when the install does not ship one.
- `resolveRwpServerBinaryFor(platform, arch)` first checks `../../binaries/rwp-server-<platform>-<arch>[.exe]`, then falls back to `require.resolve("@oh-my-pi/rwp-server-<platform>-<arch>/rwp-server[.exe]")` for future split-package installs.
- `listBundledRwpServerBinaries()` scans the bundle directory and reports the binaries actually present on disk.

Cross-built Linux and Windows release artifacts intentionally compile with `--no-default-features`, which disables the optional Jupyter/ZeroMQ transport. That keeps the musl and `windows-gnu` binaries self-contained while native development builds still retain Jupyter support through the default Cargo feature set.

## Anti-patterns

- Silent `LocalBackend` fallback inside a tool. Backend selection is centralized in `sdk.ts`; tools must not decide that remote is unavailable and quietly do something local instead.
- Optional tool backend plumbing. `ToolSession.backend` is required; missing wiring should be caught when constructing the session, not inside each tool.
- Direct `Bun.file`, `node:fs`, or other filesystem/process access inside tools when the operation belongs behind `Backend`. That breaks remote execution and creates behavior skew between local and RWP-backed sessions.
- Direct `pi-natives` calls from tools. If a tool needs a capability, add or use the backend method instead of tunneling around the abstraction.

## Related references

- [`RWP.md`](../RWP.md)
- [`docs/rwp-protocol.md`](./rwp-protocol.md)
- [`docs/rwp-endpoints.md`](./rwp-endpoints.md)
