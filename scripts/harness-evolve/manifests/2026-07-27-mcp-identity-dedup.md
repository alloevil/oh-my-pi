# 2026-07-27-mcp-identity-dedup

> **Retroactive reconstruction.** This card was written 2026-07-28 for a change
> that already landed; the prediction is reconstructed after the fact from
> `docs/notes/2026-07-27-harness-optimization-measurements.md` (branch
> `docs/optimization-measurements`) and does not carry pre-registration value.

- **Component-class**: middleware
- **Date**: 2026-07-27
- **Fix**: `packages/coding-agent/src/mcp/` — commits `ab8fb13ee`…`dbfc3b6b9` (branch `feat/mcp-dedupe-prompt-budget`), PR [can1357/oh-my-pi#6793](https://github.com/can1357/oh-my-pi/pull/6793), issue [#6786](https://github.com/can1357/oh-my-pi/issues/6786)

## Failure evidence

The mounted device inventory carried two duplicate routes
(`mcp__context_context_query_docs` / `mcp__context_context_resolve_library_id`)
next to the plain `mcp__context_*` pair, and every session spawned a redundant
`npx @upstash/context7-mcp` stdio subprocess (npx cold-start latency plus one
extra node process). Lossy tool-name sanitization could additionally overwrite
registry entries silently on collision.

## Root cause

One MCP server registered under two config names — typically a
Claude-plugin-shipped alias (`context7:context7`) next to a direct entry.
Server configs were keyed by name only, so both entries connected and mounted
every tool under two `mcp__` prefixes; final minted-name collisions from
sanitization silently overwrote the tool registry.

## Targeted fix

Dedupe server configs by connection identity — stdio: command+args+env+cwd;
http/sse: url+headers — preferring the colon-free name; resolve remaining
minted tool-name collisions deterministically (keep-first) with a warning
instead of a silent overwrite.

## Prediction

(Reconstructed; the routing/edit canary did not exist yet at landing time.)

- Duplicate mounted routes eliminated: the 2 duplicate `mcp__context_context_*`
  device routes disappear from the inventory; one fewer stdio subprocess per session.
- `atlassian` / `atlassian:atlassian` coexistence contract tests stay green
  (`test/mcp-server-tool-ownership.test.ts`, `test/mcp-mount-dedupe.test.ts` —
  49-test contract suite per the measurement notes).

## Verification (manual, retroactive)

- Duplicate routes: confirmed gone by live-session inventory comparison; one
  fewer `npx @upstash/context7-mcp` process per session. ✓
- Contract suite (49 tests across mcp-mount-dedupe, prompt-budget-controls,
  system-prompt-inventory, mcp-server-tool-ownership,
  issue-5764-registertool-loadmode): green. ✓
- Side finding: the two local context7 entries were different transports
  (plugin stdio vs `mcp.context7.com` HTTP) — config redundancy, not an alias;
  resolved via `disabledServers` in `~/.omp/agent/mcp.json`.

## Verification (auto)

_Empty until `bun run manifest:verify` fills this section._

## Verdict

keep — both predictions held. Later superseded upstream by PR
[#6787](https://github.com/can1357/oh-my-pi/pull/6787) (`fix(mcp): deduplicate
aliased server connections`, @roboomp, merged via `b0063dd18`); the local
implementation was retired in favor of the upstream one.
