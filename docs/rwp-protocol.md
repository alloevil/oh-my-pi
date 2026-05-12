# Remote Workspace Protocol

`rwp-server` is the wire-facing server for the harness. The concrete endpoint list lives in [`crates/rwp-server/src/router.rs`](../crates/rwp-server/src/router.rs); this document records the protocol rules and design constraints around that surface.

## Transport

- HTTP/1.1 request/response for ordinary operations.
- WebSocket upgrades on named-handle `GET` routes for bidirectional tunnels.
- Streaming responses use `application/x-ndjson`.
- No SSE. A single NDJSON line is the framing unit for streamed HTTP responses.


## TLS

By default `rwp-server` serves plain HTTP on the configured `--bind` address.

Provide both `--tls-cert <PATH>` and `--tls-key <PATH>` to serve HTTPS with a PEM-encoded certificate chain plus private key. The server loads both files at startup and exits with an error if only one flag is set.

TLS mode changes transport security only. Routes, authentication, request ids, websocket upgrades, and NDJSON streaming semantics stay the same.
## CORS

By default `rwp-server` does not attach a CORS layer. Requests with an `Origin` header still execute normally, but the server omits `Access-Control-Allow-Origin`, so browsers deny cross-origin access.

Enable CORS with repeatable `--cors-origin <ORIGIN>` flags:

- `rwp-server --cors-origin https://app.example.com`
- `rwp-server --cors-origin https://app.example.com --cors-origin https://admin.example.com`
- `rwp-server --cors-origin '*'`

When enabled, the server allows `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`; allows request headers `Authorization`, `Content-Type`, `If-Match`, and `X-Request-Id`; and exposes `ETag` plus `X-Request-Id` to browser clients.


## Request correlation

- Every HTTP response includes `X-Request-Id`.
- If the client sends `X-Request-Id`, the server echoes that value unchanged.
- Otherwise the server generates a single UUIDv4 for the request and reuses it for tracing + the response header.
- Error responses follow the same rule because the correlation header is attached by outer middleware, not per-handler code.
## Authentication

When `RWP_TOKEN` is set, every endpoint requires `Authorization: Bearer <token>`; missing or invalid bearer tokens return `401 Unauthorized`, and `OPTIONS` preflights are exempt.

## Cancellation model

Cancellation is connection-scoped.

- If the client drops a streaming HTTP response body, the server drops the request task and associated cancellation token.
- If the client closes a websocket, the attachment refcount is decremented and idle reapers can collect the named handle later.
- There is no `/jobs` registry and no out-of-band cancel endpoint.
- For bash, timeout-based cancellation is currently the reliable child-reaping mechanism; disconnect detection is best-effort and not the contract to build on.
- Known v2 issue: if a foreground bash command spawns background grandchildren and then times out, those grandchildren may outlive the request briefly. The server reports the timeout correctly, but immediate background-job reaping is not yet guaranteed.

## Session model

`POST /sessions` allocates a session id plus mutable per-session state:

- cwd
- environment map
- file read cache
- shell session state
- event broadcast channel
- edit serialization lock

Session events stream from `GET /sessions/{id}/events` as NDJSON. Current event kinds are heartbeat, file-changed, and diagnostics.

## Named handles

Named handles back `/eval/{name}`, `/lsp/{name}`, `/dap/{name}`, and `/cdp/{name}`.

Discovery / attach flow:

1. `GET /<kind>/{name}`
2. If `404`, create with `PUT /<kind>/{name}`
3. `GET /<kind>/{name}` again
4. If the route supports websocket attach, upgrade that `GET` to WS

Properties:

- `PUT` is idempotent for the same config.
- Concurrent `PUT`s race safely: exactly one handle is registered; late racers reuse it or get `409` on config mismatch.
- Handle lifecycle is server-owned, with per-handle idle reapers plus websocket refcounts.


## LSP routing

Write-through LSP forwarding is file-extension driven:

1. infer the language id from the written path (`.rs` → `rust`, `.ts` → `typescript`, etc.)
2. prefer an exact `/lsp/{language_id}` handle
3. otherwise, consider `/lsp/{language_id}-*` handles
4. if multiple prefixed handles match, pick the earliest registration order

Examples:

- `src/lib.rs` routes to `/lsp/rust` when present
- if `/lsp/rust` is absent, `src/lib.rs` can route to `/lsp/rust-analyzer`
- if both `/lsp/rust-analyzer` and `/lsp/rust-alt` exist, the first `PUT /lsp/{name}` wins until it is deleted

## ETag / CAS rules

Filesystem writes are compare-and-swap.

- Reads return a strong `ETag` header derived from the current bytes.
- Writes against existing files require `If-Match`.
- `If-Match: *` means “write if the file exists”.
- Missing or stale tags on an existing file return `412 Precondition Failed`.
- New-file creation does not require `If-Match`.
- `edit.replace`, `edit.patch`, and `edit.ast` all resolve current bytes first, compute a new body, then route through the same write-through CAS path.

## Harness-side vs server-side responsibilities

Harness-side:

- anchor / hashline formats
- stale-anchor recovery policy
- user-facing edit planning
- session orchestration

Server-side:

- byte storage and `ETag` generation
- atomic writes
- session shell persistence
- LSP/DAP/CDP/eval handle lifecycle
- session event fanout
- read coalescing through `FileReadCache`
- LSP document lifecycle forwarding (`didOpen` / `didChange`) from the shared write path, using incremental `didChange` when the selected server advertises `TextDocumentSyncKind.Incremental`

The server is intentionally thin: it does not understand harness anchor semantics and it does not maintain a background jobs registry.

## OpenAPI contract

`GET /openapi.json` serves the generated schema for the current router. Treat it as the machine-readable contract for request/response bodies and status codes; treat [`crates/rwp-server/src/router.rs`](../crates/rwp-server/src/router.rs) as the source of truth for which paths exist.
