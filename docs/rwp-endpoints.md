# Remote Workspace Protocol endpoint reference

Protocol-wide rules live in [`docs/rwp-protocol.md`](./rwp-protocol.md). The authoritative route list lives in [`crates/rwp-server/src/router.rs`](../crates/rwp-server/src/router.rs).

This page is the per-endpoint contract reference. It omits shared auth, request-id, CORS, and cancellation rules that already live in `rwp-protocol.md`.

`ErrorBody = { code: string; message: string; detail?: unknown }`

### Contents

- Sessions
	- `POST /sessions`
	- `DELETE /sessions/{id}`
	- `PUT /sessions/{id}/cwd`
	- `PATCH /sessions/{id}/env`
	- `PUT /sessions/{id}/watch`
	- `GET /sessions/{id}/events`
	- `GET /sessions/{id}/logs`
- Filesystem reads
	- `GET /sessions/{id}/read.lines`
	- `GET /sessions/{id}/read.blob`
	- `GET /sessions/{id}/read.ast`
	- `GET /sessions/{id}/stat`
	- `GET /sessions/{id}/exists`
	- `GET /sessions/{id}/archive.entries`
	- `GET /sessions/{id}/archive.read`
- Filesystem writes
	- `PUT /sessions/{id}/write.lines`
	- `PUT /sessions/{id}/write.blob`
	- `PUT /sessions/{id}/archive.write`
	- `DELETE /sessions/{id}/fs`
	- `POST /sessions/{id}/mkdir`
	- `POST /sessions/{id}/rename`
- Globs + greps
	- `GET /sessions/{id}/glob`
	- `GET /sessions/{id}/grep`
	- `GET /sessions/{id}/grep.ast`
- Edits
	- `POST /sessions/{id}/edit.replace`
	- `POST /sessions/{id}/edit.patch`
	- `POST /sessions/{id}/edit.ast`
- Bash
	- `POST /sessions/{id}/bash.exec`
- SQLite
	- `GET /sessions/{id}/read.db`
	- `POST /sessions/{id}/write.db`
- Schema + admin
	- `GET /openapi.json`
	- `GET /metrics`
- Tunnels
	- `GET /eval/{name}`
	- `PUT /eval/{name}`
	- `DELETE /eval/{name}`
	- `POST /eval/{name}`
	- `GET /lsp/{name}`
	- `PUT /lsp/{name}`
	- `DELETE /lsp/{name}`
	- `GET /dap/{name}`
	- `PUT /dap/{name}`
	- `DELETE /dap/{name}`
	- `GET /cdp/{name}`
	- `PUT /cdp/{name}`
	- `DELETE /cdp/{name}`

## POST /sessions

Create a new session with its own cwd, env map, caches, shell state, and event channel.

- Method + path: `POST /sessions`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
CreateSessionRequest = {
  cwd?: string;
  env?: Record<string, string>;
}
```

Response:

- `201` → `CreateSessionResponse = { id: string }`

Error responses:

- `400` → `bad-request`
- `500` → `io-error` or `internal`

Example:

```sh
curl -X POST http://127.0.0.1:8080/sessions -H 'Content-Type: application/json' --data '{"cwd":".","env":{"DEBUG":"1"}}'
```

## DELETE /sessions/{id}

Delete a session and release its per-session state.

- Method + path: `DELETE /sessions/{id}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `204` → no body

Error responses:

- `404` → `not-found`

Example:

```sh
curl -X DELETE http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000
```

## PUT /sessions/{id}/cwd

Change the working directory for an existing session.

- Method + path: `PUT /sessions/{id}/cwd`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
SetCwdRequest = {
  cwd: string;
}
```

Response:

- `204` → no body

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `500` → `io-error`

Example:

```sh
curl -X PUT http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/cwd -H 'Content-Type: application/json' --data '{"cwd":"src"}'
```

## PATCH /sessions/{id}/env

Set or unset session environment variables without replacing the whole map.

- Method + path: `PATCH /sessions/{id}/env`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
PatchEnvRequest = {
  env: Record<string, string | null>;
}
```

Response:

- `204` → no body

Error responses:

- `404` → `not-found`

Example:

```sh
curl -X PATCH http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/env -H 'Content-Type: application/json' --data '{"env":{"DEBUG":"1","OLD_VAR":null}}'
```

## PUT /sessions/{id}/watch

Enable or disable the session-scoped filesystem watcher, optionally filtered by a glob.

- Method + path: `PUT /sessions/{id}/watch`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
WatchRequest = {
  enabled: boolean;
  glob?: string;
}
```

Response:

- `204` → no body

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `500` → `internal`

Example:

```sh
curl -X PUT http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/watch -H 'Content-Type: application/json' --data '{"enabled":true,"glob":"src/**/*.ts"}'
```

## GET /sessions/{id}/events

Stream session heartbeat, file-change, and diagnostics events as NDJSON.

- Method + path: `GET /sessions/{id}/events`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `200` → `application/x-ndjson`, one `SessionEvent` per line
- `SessionEvent =`
  - `{ type: "file-changed"; path: string; etag: string }`
  - `{ type: "diagnostics"; path: string; diagnostics: unknown }`
  - `{ type: "heartbeat" }`

Error responses:

- `404` → `not-found`

Example:

```sh
curl --no-buffer http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/events
```

## GET /sessions/{id}/logs

Stream session-relevant log records as NDJSON.

- Method + path: `GET /sessions/{id}/logs`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `200` → `application/x-ndjson`, one `LogRecord` per line
- `LogRecord = {
  ts_ms: number;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  fields: Record<string, unknown>;
}`

Error responses:

- `404` → `not-found`

Example:

```sh
curl --no-buffer http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/logs
```

## GET /sessions/{id}/read.lines

Read text content, optionally using an inline or query line selector.

- Method + path: `GET /sessions/{id}/read.lines`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | File path or URL; may include an inline selector like `file.ts:10-20` or `https://example.com:raw`. |
| `range` | `string` | no | Alternate selector when not embedded in `path`: `N`, `N-M`, `N+LEN`, or `raw`. |

Request body:

```ts
None
```

Response:

- `200` → text body
- Headers:
  - `ETag: "<etag>"`
  - `X-Total-Lines: <count>`
  - `Content-Type: text/plain; charset=utf-8`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `415` → `unsupported-media-type`
- `500` → `io-error` or `internal`

Example:

```sh
curl 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/read.lines?path=src%2Fmain.rs&range=1-20'
```

## GET /sessions/{id}/read.blob

Read raw file bytes with optional HTTP byte-range support.

- Method + path: `GET /sessions/{id}/read.blob`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | File path relative to the session cwd, or absolute path. |

Request body:

```ts
None
```

Response:

- `200` → full binary body
- `206` → partial binary body when `Range: bytes=START-END` is supplied
- Headers:
  - `ETag: "<etag>"`
  - `Accept-Ranges: bytes`
  - `Content-Type: <sniffed mime>`
  - `Content-Range: bytes START-END/TOTAL` on `206`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `415` → `unsupported-media-type`
- `500` → `io-error` or `internal`

Example:

```sh
curl -H 'Range: bytes=0-255' 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/read.blob?path=assets%2Ficon.svg'
```

## GET /sessions/{id}/read.ast

Return an AST-aware structural summary for a source file.

- Method + path: `GET /sessions/{id}/read.ast`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | Source file path relative to the session cwd, or absolute path. |

Request body:

```ts
None
```

Response:

- `200` → `ReadAstResponse = {
  language?: string;
  parsed: boolean;
  elided: boolean;
  total_lines: number;
  segments: Array<{
    kind: string;
    start_line: number;
    end_line: number;
    text?: string;
  }>;
}`

Error responses:

- `404` → `not-found`
- `415` → `unsupported-media-type`
- `500` → `internal`

Example:

```sh
curl 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/read.ast?path=packages%2Fagent%2Fsrc%2Findex.ts'
```

## GET /sessions/{id}/stat

Return existence, type, size, modification time, and file ETag for a session-scoped path.

- Method + path: `GET /sessions/{id}/stat`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | Path relative to the session cwd. |

Request body:

```ts
None
```

Response:

- `200` → `StatResponse = {
  exists: boolean;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime_ms: number;
  etag?: string | null;
}`
- Missing paths return `{ exists: false, kind: "other", size: 0, mtime_ms: 0, etag: null }`.

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `500` → `internal`

Example:

```sh
curl 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/stat?path=packages%2Fagent%2Fsrc%2Findex.ts'
```

## GET /sessions/{id}/exists

Probe whether a session-scoped path exists without returning metadata.

- Method + path: `GET /sessions/{id}/exists`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | Path relative to the session cwd. |

Request body:

```ts
None
```

Response:

- `204` → no body when the path exists

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `500` → `internal`

Example:

```sh
curl -i 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/exists?path=packages%2Fagent%2Fsrc%2Findex.ts'
```

## GET /sessions/{id}/archive.entries

List entries inside a zip, tar, tar.gz, or tgz archive.

- Method + path: `GET /sessions/{id}/archive.entries`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | Archive path relative to the session cwd. |
| `prefix` | `string` | no | Restrict results to entry paths with this normalized prefix. |
| `limit` | `number` | no | Max returned entries; default `10000`. |

Request body:

```ts
None
```

Response:

- `200` → `ArchiveEntriesResponse = {
  entries: Array<{
    path: string;
    kind: "file" | "dir";
    size: number;
    mtime_ms?: number;
    compressed_size?: number;
  }>;
  format: "zip" | "tar" | "tar.gz";
  truncated: boolean;
}`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `413` → `payload-too-large`
- `500` → `internal`

Example:

```sh
curl 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/archive.entries?path=release.tar.gz&prefix=bin%2F&limit=100'
```

## GET /sessions/{id}/archive.read

Read one file entry from an archive as raw bytes, with optional HTTP byte-range support.

- Method + path: `GET /sessions/{id}/archive.read`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | Archive path relative to the session cwd. |
| `entry` | `string` | yes | Entry path inside the archive. |

Request body:

```ts
None
```

Response:

- `200` → full binary body
- `206` → partial binary body when `Range: bytes=START-END` is supplied
- Headers:
  - `ETag: "<entry-etag>"`
  - `Accept-Ranges: bytes`
  - `Content-Type: <sniffed mime>`
  - `Content-Range: bytes START-END/TOTAL` on `206`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `413` → `payload-too-large`
- `500` → `internal`

Example:

```sh
curl -H 'Range: bytes=0-255' 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/archive.read?path=release.tar.gz&entry=bin%2Fagent'
```

## PUT /sessions/{id}/write.lines

Write text bytes with compare-and-swap semantics and text-convention preservation.

- Method + path: `PUT /sessions/{id}/write.lines`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | File path relative to the session cwd. |

Request body:

```ts
text/plain body
```

Response:

- `204` → no body
- Header: `ETag: "<new-etag>"`

Error responses:

- `404` → `not-found`
- `412` → `etag-mismatch`
- `500` → `io-error` or `internal`

Example:

```sh
curl -X PUT 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/write.lines?path=notes.txt' -H 'Content-Type: text/plain' -H 'If-Match: "current-etag"' --data-binary $'hello\nworld\n'
```

## PUT /sessions/{id}/write.blob

Write binary bytes with compare-and-swap semantics.

- Method + path: `PUT /sessions/{id}/write.blob`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | File path relative to the session cwd. |

Request body:

```ts
application/octet-stream body
```

Response:

- `204` → no body
- Header: `ETag: "<new-etag>"`

Error responses:

- `404` → `not-found`
- `412` → `etag-mismatch`
- `500` → `io-error` or `internal`

Example:

```sh
curl -X PUT 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/write.blob?path=data.bin' -H 'Content-Type: application/octet-stream' -H 'If-Match: "current-etag"' --data-binary @./data.bin
```

## PUT /sessions/{id}/archive.write

Write or replace a single archive entry with compare-and-swap semantics against the archive ETag.

- Method + path: `PUT /sessions/{id}/archive.write`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | Archive path relative to the session cwd. |
| `entry` | `string` | yes | Entry path inside the archive. |

Request body:

```ts
application/octet-stream body
```

Response:

- `200` → `ArchiveWriteResponse = { etag: string }`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `412` → `etag-mismatch`
- `413` → `payload-too-large`
- `500` → `internal`

Example:

```sh
curl -X PUT 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/archive.write?path=release.tar.gz&entry=bin%2Fagent' -H 'Content-Type: application/octet-stream' -H 'If-Match: "current-archive-etag"' --data-binary @./agent
```

## DELETE /sessions/{id}/fs

Placeholder for the per-path filesystem delete endpoint landing in this round.

- Method + path: `DELETE /sessions/{id}/fs`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | Path to delete, relative to the session cwd. |

Request body:

```ts
None
```

Response:

- Placeholder only. Final response shape lands with the server implementation in this round.

Error responses:

- Placeholder only.

Example:

```sh
curl -X DELETE 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/fs?path=notes.txt'
```

## POST /sessions/{id}/mkdir

Placeholder for the session-scoped directory creation endpoint landing in this round.

- Method + path: `POST /sessions/{id}/mkdir`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | Directory path to create, relative to the session cwd. |
| `recursive` | `boolean` | no | Whether to create missing parent directories. |

Request body:

```ts
None
```

Response:

- Placeholder only. Final response shape lands with the server implementation in this round.

Error responses:

- Placeholder only.

Example:

```sh
curl -X POST 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/mkdir?path=tmp%2Fcache&recursive=true'
```

## POST /sessions/{id}/rename

Placeholder for the session-scoped rename endpoint landing in this round.

- Method + path: `POST /sessions/{id}/rename`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `from` | `string` | yes | Source path relative to the session cwd. |
| `to` | `string` | yes | Destination path relative to the session cwd. |
| `overwrite` | `boolean` | no | Whether to replace an existing destination path. |

Request body:

```ts
None
```

Response:

- Placeholder only. Final response shape lands with the server implementation in this round.

Error responses:

- Placeholder only.

Example:

```sh
curl -X POST 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/rename?from=old.txt&to=new.txt&overwrite=false'
```

## GET /sessions/{id}/glob

List files matching one or more glob patterns, newest first.

- Method + path: `GET /sessions/{id}/glob`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `patterns` | `string` | yes | Comma-separated glob patterns. |
| `hidden` | `boolean` | no | Include hidden files; default `false`. |
| `limit` | `number` | no | Max returned paths; default `1000`. |
| `gitignore` | `boolean` | no | Respect ignore files; default `true`. |

Request body:

```ts
None
```

Response:

- `200` → `{
  paths: Array<{
    path: string;
    mtime: number;
    size: number;
  }>;
  truncated: boolean;
}`
- Header `X-Truncated: 1` is set when the server trims the payload to its byte budget.

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `500` → `io-error` or `internal`

Example:

```sh
curl 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/glob?patterns=packages%2F**%2F*.ts,crates%2F**%2F*.rs&limit=50&gitignore=true'
```

## GET /sessions/{id}/grep

Search text files with regex and stream matches plus context as NDJSON.

- Method + path: `GET /sessions/{id}/grep`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `pattern` | `string` | yes | Regex pattern. |
| `paths` | `string` | no | Comma-separated files, directories, or glob patterns; defaults to the whole session cwd. |
| `i` | `boolean` | no | Case-insensitive search. |
| `skip` | `number` | no | Skip this many matches before emitting results. |
| `gitignore` | `boolean` | no | Respect ignore files; default `true`. |
| `context` | `number` | no | Context lines around each match; default `2`. |
| `max_matches` | `number` | no | Match cap before truncation; default `500`. |

Request body:

```ts
None
```

Response:

- `200` → `application/x-ndjson`, one line per record
- `GrepRecord = { path: string; line: number; kind: "match" | "context"; text: string }`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `500` → `io-error` or `internal`

Example:

```sh
curl --no-buffer 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/grep?pattern=session.backend&paths=packages%2Fcoding-agent%2Fsrc&gitignore=true'
```

## GET /sessions/{id}/grep.ast

Search source files structurally with an AST pattern and stream match locations as NDJSON.

- Method + path: `GET /sessions/{id}/grep.ast`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `pattern` | `string` | yes | AST search pattern. |
| `paths` | `string` | yes | Comma-separated file or directory paths used to collect candidate source files. |
| `language` | `string` | no | Explicit AST language alias; otherwise inferred per file. |

Request body:

```ts
None
```

Response:

- `200` → `application/x-ndjson`, one line per record
- `GrepAstLine = {
  path: string;
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  text: string;
}`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `500` → `io-error` or `internal`

Example:

```sh
curl --no-buffer 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/grep.ast?pattern=console.log($$$ARGS)&paths=packages%2Fagent%2Fsrc&language=typescript'
```

## POST /sessions/{id}/edit.replace

Replace a single text region, optionally with fuzzy matching, and return a diff summary.

- Method + path: `POST /sessions/{id}/edit.replace`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
EditReplaceRequest = {
  path: string;
  old: string;
  new: string;
  fuzzy: boolean;
}
```

Response:

- `200` → `EditResult = {
  diff: string;
  first_changed_line?: number;
  op: "create" | "update";
}`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `409` → `conflict`
- `412` → `etag-mismatch`
- `500` → `io-error` or `internal`

Example:

```sh
curl -X POST http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/edit.replace -H 'Content-Type: application/json' --data '{"path":"notes.txt","old":"hello","new":"hi","fuzzy":false}'
```

## POST /sessions/{id}/edit.patch

Apply ordered line-based patch hunks and return a diff summary.

- Method + path: `POST /sessions/{id}/edit.patch`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
EditPatchRequest = {
  path: string;
  hunks: Array<Hunk>;
}

Hunk = {
  start: number;
  deleted: number;
  inserted: string[];
}
```

Response:

- `200` → `EditResult = {
  diff: string;
  first_changed_line?: number;
  op: "create" | "update";
}`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `412` → `etag-mismatch`
- `500` → `io-error` or `internal`

Example:

```sh
curl -X POST http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/edit.patch -H 'Content-Type: application/json' --data '{"path":"notes.txt","hunks":[{"start":1,"deleted":1,"inserted":["hi"]}]}'
```

## POST /sessions/{id}/edit.ast

Apply AST rewrite rules across one or more source files and return per-file diffs.

- Method + path: `POST /sessions/{id}/edit.ast`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
EditAstRequest = {
  ops: Array<AstOp>;
  paths: string[];
}

AstOp = {
  pat: string;
  out: string;
}
```

Response:

- `200` → `AstEditResult = {
  changes: Array<{
    path: string;
    replacements: number;
    diff: string;
  }>;
}`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `500` → `io-error` or `internal`

Example:

```sh
curl -X POST http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/edit.ast -H 'Content-Type: application/json' --data '{"ops":[{"pat":"console.log($$$ARGS)","out":""}],"paths":["packages/agent/src"]}'
```

## POST /sessions/{id}/bash.exec

Run a shell command inside the session and stream output plus final exit metadata.

- Method + path: `POST /sessions/{id}/bash.exec`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
BashExecRequest = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  pty: boolean;
  timeout_ms?: number;
}
```

Response:

- `200` → `application/x-ndjson`
- `BashEvent =`
  - `{ type: "output"; data: string }`
  - `{ type: "exit"; code?: number; cancelled: boolean; timed_out: boolean; minimized?: unknown }`

Error responses:

- `404` → `not-found`
- `500` → `io-error` or `internal`

Example:

```sh
curl --no-buffer -X POST http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/bash.exec -H 'Content-Type: application/json' --data '{"command":"pwd && echo done","pty":false,"timeout_ms":5000}'
```

## GET /sessions/{id}/read.db

Inspect a SQLite database, table, row, or read-only query result.

- Method + path: `GET /sessions/{id}/read.db`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | `string` | yes | SQLite file path. |
| `table` | `string` | no | Table name; omitted means list tables. |
| `key` | `string` | no | Primary-key or `rowid` lookup inside `table`. |
| `q` | `string` | no | A single read-only `SELECT` or `WITH` statement. |
| `where` | `string` | no | Filter expression for table reads. |
| `order` | `string` | no | `ORDER BY` expression for table reads. |
| `limit` | `number` | no | Row limit; default `50`. |
| `offset` | `number` | no | Row offset; default `0`. |

Request body:

```ts
None
```

Response:

- `200` → one of:
  - `SqliteTablesResponse = {
    tables: Array<{
      name: string;
      row_count: number;
      columns: Array<{ name: string; type: string }>;
    }>;
  }`
  - `ReadDbResponse = {
    rows: Array<Record<string, unknown>>;
    columns: Array<{ name: string; type: string }>;
    rowid_column?: string;
  }`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `500` → `io-error` or `internal`

Example:

```sh
curl 'http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/read.db?path=app.db&table=users&limit=10&offset=0'
```

## POST /sessions/{id}/write.db

Insert, update, delete, or execute SQL against a SQLite database.

- Method + path: `POST /sessions/{id}/write.db`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
WriteDbRequest = {
  path: string;
  op: "insert" | "update" | "delete" | "exec";
  table?: string;
  key?: string;
  row?: Record<string, unknown>;
  sql?: string;
}
```

Response:

- `200` → `WriteDbResponse = { affected: number }`

Error responses:

- `400` → `bad-request`
- `404` → `not-found`
- `500` → `io-error` or `internal`

Example:

```sh
curl -X POST http://127.0.0.1:8080/sessions/00000000-0000-0000-0000-000000000000/write.db -H 'Content-Type: application/json' --data '{"path":"app.db","op":"update","table":"users","key":"42","row":{"name":"Ada"}}'
```

## GET /openapi.json

Fetch the generated OpenAPI schema for the current router.

- Method + path: `GET /openapi.json`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `200` → OpenAPI JSON document

Error responses:

- `401` → `unauthorized`

Example:

```sh
curl http://127.0.0.1:8080/openapi.json -H 'Authorization: Bearer <token>'
```

## GET /metrics

Expose Prometheus-format process and request metrics. This route is intentionally unauthenticated.

- Method + path: `GET /metrics`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `200` → Prometheus text exposition format
- Header: `Content-Type: text/plain; version=0.0.4; charset=utf-8`

Error responses:

- None documented.

Example:

```sh
curl http://127.0.0.1:8080/metrics
```
## GET /eval/{name}

Fetch eval-kernel metadata by name.

- Method + path: `GET /eval/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `200` → `EvalStatusResponse = {
  name: string;
  lang: string;
  status: "starting" | "busy" | "idle";
  ref_count: number;
}`

Error responses:

- `404` → `not-found`

Example:

```sh
curl http://127.0.0.1:8080/eval/demo
```

## PUT /eval/{name}

Create or reuse a named eval kernel.

- Method + path: `PUT /eval/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
NamedHandleConfig = {
  kind: "eval";
  lang: string;
  kernelspec?: string;
}
```

Response:

- `201` → no body; kernel created
- `200` → no body; existing kernel reused

Error responses:

- `400` → `bad-request`
- `409` → `conflict`
- `500` → `internal`

Example:

```sh
curl -X PUT http://127.0.0.1:8080/eval/demo -H 'Content-Type: application/json' --data '{"kind":"eval","lang":"python"}'
```

## DELETE /eval/{name}

Delete a named eval kernel.

- Method + path: `DELETE /eval/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `204` → no body

Error responses:

- `404` → `not-found`
- `500` → `internal`

Example:

```sh
curl -X DELETE http://127.0.0.1:8080/eval/demo
```

## POST /eval/{name}

Execute code in a named eval kernel and stream events as NDJSON.

- Method + path: `POST /eval/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
EvalExecRequest = {
  code: string;
  timeout_ms?: number;
  store_history: boolean;
}
```

Response:

- `200` → `application/x-ndjson`
- `EvalEvent =`
  - `{ type: "stdout"; data: string }`
  - `{ type: "stderr"; data: string }`
  - `{ type: "display"; mime: string; data: string }`
  - `{ type: "result"; text: string }`
  - `{ type: "error"; ename: string; evalue: string; traceback: string[] }`
  - `{ type: "status"; state: "starting" | "busy" | "idle" }`

Error responses:

- `404` → `not-found`
- `500` → `internal`

Example:

```sh
curl --no-buffer -X POST http://127.0.0.1:8080/eval/demo -H 'Content-Type: application/json' --data '{"code":"print(1 + 1)","store_history":true,"timeout_ms":5000}'
```

## GET /lsp/{name}

Fetch LSP handle metadata or upgrade to a websocket tunnel.

- Method + path: `GET /lsp/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `101` → websocket upgrade when the request is a valid WS handshake
- `200` → `LspGetResponse = {
  name: string;
  initialized: boolean;
  capabilities: Record<string, unknown>;
  ref_count: number;
  last_active_ms: number;
}`

Error responses:

- `404` → `not-found`

Example:

```sh
curl -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==' -H 'Sec-WebSocket-Version: 13' http://127.0.0.1:8080/lsp/typescript-language-server
```
Note: a successful tunnel attach returns `101 Switching Protocols`; use a websocket client after the upgrade.

## PUT /lsp/{name}

Create or reuse a named LSP subprocess handle.

- Method + path: `PUT /lsp/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
NamedHandleConfig = {
  kind: "lsp";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  root_uri?: string;
  initialization_options?: unknown;
  idle_timeout_ms?: number;
}
```

Response:

- `201` → `LspGetResponse`
- `200` → `LspGetResponse`

Error responses:

- `400` → `bad-request`
- `409` → `conflict`
- `500` → `internal`

Example:

```sh
curl -X PUT http://127.0.0.1:8080/lsp/typescript-language-server -H 'Content-Type: application/json' --data '{"kind":"lsp","command":"typescript-language-server","args":["--stdio"],"root_uri":"file:///workspace"}'
```

## DELETE /lsp/{name}

Delete a named LSP handle.

- Method + path: `DELETE /lsp/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `204` → no body

Error responses:

- `404` → `not-found`
- `500` → `internal`

Example:

```sh
curl -X DELETE http://127.0.0.1:8080/lsp/typescript-language-server
```

## GET /dap/{name}

Upgrade to a websocket tunnel for a named debug adapter.

- Method + path: `GET /dap/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `101` → websocket upgrade only

Error responses:

- `404` → `not-found`

Example:

```sh
curl -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==' -H 'Sec-WebSocket-Version: 13' http://127.0.0.1:8080/dap/debugpy
```
Note: this route is tunnel-only; a successful request upgrades to websocket instead of returning JSON.

## PUT /dap/{name}

Create or reuse a named debug-adapter handle.

- Method + path: `PUT /dap/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
NamedHandleConfig = {
  kind: "dap";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: "stdio" | "tcp";
  host?: string;
  port?: number;
}
```

Response:

- `201` → no body
- `200` → no body

Error responses:

- `400` → `bad-request`
- `500` → `internal`

Example:

```sh
curl -X PUT http://127.0.0.1:8080/dap/debugpy -H 'Content-Type: application/json' --data '{"kind":"dap","command":"python","args":["-m","debugpy.adapter"],"transport":"stdio"}'
```

## DELETE /dap/{name}

Delete a named debug-adapter handle.

- Method + path: `DELETE /dap/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `204` → no body

Error responses:

- `404` → `not-found`
- `500` → `internal`

Example:

```sh
curl -X DELETE http://127.0.0.1:8080/dap/debugpy
```

## GET /cdp/{name}

Fetch CDP handle metadata or upgrade to a websocket tunnel.

- Method + path: `GET /cdp/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `101` → websocket upgrade when the request is a valid WS handshake
- `200` → `CdpHandleResponse = {
  name: string;
  kind: "spawned" | "attached";
  ws_url: string;
  ref_count: number;
  last_active_ms: number;
}`

Error responses:

- `404` → `not-found`

Example:

```sh
curl -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==' -H 'Sec-WebSocket-Version: 13' http://127.0.0.1:8080/cdp/chrome
```
Note: a successful tunnel attach returns `101 Switching Protocols`; plain HTTP `GET` returns the JSON metadata instead.

## PUT /cdp/{name}

Create or reuse a named CDP handle by spawning a browser or attaching to an existing endpoint.

- Method + path: `PUT /cdp/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
NamedHandleConfig =
  | {
      kind: "cdp-spawn";
      path: string;
      args?: string[];
      headless?: boolean;
    }
  | {
      kind: "cdp-attach";
      cdp_url: string;
    }
```

Response:

- `201` → no body
- `200` → no body

Error responses:

- `400` → `bad-request`
- `500` → `internal`

Example:

```sh
curl -X PUT http://127.0.0.1:8080/cdp/chrome -H 'Content-Type: application/json' --data '{"kind":"cdp-attach","cdp_url":"http://127.0.0.1:9222"}'
```

## DELETE /cdp/{name}

Delete a named CDP handle.

- Method + path: `DELETE /cdp/{name}`

Query params:

| name | type | required | description |
| --- | --- | --- | --- |
| — | — | no | None. |

Request body:

```ts
None
```

Response:

- `204` → no body

Error responses:

- `404` → `not-found`

Example:

```sh
curl -X DELETE http://127.0.0.1:8080/cdp/chrome
```
