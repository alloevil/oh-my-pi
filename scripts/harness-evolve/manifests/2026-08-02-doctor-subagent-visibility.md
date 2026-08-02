# 2026-08-02-doctor-subagent-visibility

- **Component-class**: observability
- **Date**: 2026-08-02
- **Fix**: `packages/coding-agent/src/health/subagents.ts` (new, pure ref
  extraction + disk resolver), `src/cli/doctor-cli.ts` + `src/commands/doctor.ts`
  (`--subagents` flag), `test/health-subagents.test.ts`

## Failure evidence

Every task fan-out this week produced child trajectories that doctor and the
evidence pipeline cannot see. Concrete case: parent session `019fa2f0`
(`~/.omp/agent/sessions/-Downloads/2026-07-27T09-38-24-417Z_019fa2f0-….jsonl`)
contains **11 persisted `task` toolResults naming 22 spawned agents**
(McpMountScout … ChurnGuard/SubagentVisibility), and all 22 child transcripts
exist on disk next to the parent — yet no command enumerates them. `omp doctor`
on the parent reports the parent's health only; each child must be found by
manually listing the artifacts directory and guessing which `.jsonl` belongs to
which spawn. The incident-analysis workflow (doctor → autopsy → evidence) has
therefore been operating on 1/23 of the actual trajectories a fan-out session
produced.

## Root cause

The linkage between a parent transcript and its children is **id-only plus a
directory convention — no session file path is persisted anywhere in the
parent transcript**. Verified mechanism on session `019fa2f0`:

1. The task tool persists its toolResult with
   `details.progress[]` rows (`{id, agent, status, resolvedModel, …}` —
   `AgentProgress` in `src/task/types.ts`) and `details.results[]`
   (`SingleResult`, sync spawns only; carries `outputPath` but still no
   session path). For async spawns the results array is empty at persist time
   (`buildAsyncDetails`, `src/task/index.ts` ~line 950): only progress rows
   and `details.async.jobId` name the children.
2. Async completions arrive later as `custom_message` entries with
   `customType: "async-result"` whose content embeds
   `<task-result id="OutcomeLabels" …>` — again id-only.
3. The child transcript location is a write-time convention, not persisted
   data: `task/index.ts` writes each child session to
   `<parentSessionFile minus ".jsonl">/<AgentId>.jsonl` (the parent's
   artifacts dir; confirmed by `registry-helpers.ts` docs and by inspecting
   the `019fa2f0` artifacts dir: 22 `<AgentId>.jsonl` files exactly matching
   the 22 progress-row ids).

The runtime `AgentRegistry` ref does hold `ref.sessionFile`, but it is
in-memory only — nothing about it survives into the parent JSONL. So any
post-hoc resolver is honest name-matching: extract ids from the transcript,
then look for `<id>.jsonl` under the parent's artifacts dir; anything that
doesn't match must be reported as **unresolved**, not dropped.

## Targeted fix

Pure `collectSubagentRefs(entries)` in `src/health/subagents.ts`: single pass
over `FileEntry[]` collecting refs from (a) toolResult `details.progress[]` and
`details.results[]` rows, (b) `async-result` custom messages, (c) task
toolCall argument `tasks[].name` hints only when that call never persisted a
result (allocation can rename; progress rows are authoritative when present).
Dedup by id, first-seen order, last-write-wins status.

Separate `resolveSubagentSessions(refs, artifactsRoot)` (injectable root =
parent session path minus `.jsonl`): exact `<root>/<id>.jsonl` probe, then a
case-insensitive scan of the root's `.jsonl` entries; resolved children get a
digest via the existing `scanSession`/`evaluateScan` (message count, models,
warn-severity findings count). Unresolvable refs stay listed with
`resolved: false`.

`omp doctor <session> --subagents` (same branch pattern as `--stages`/
`--autopsy`): renders one row per child — name/id · resolved/unresolved ·
messages · models · warns · session path — so any child can be doctored or
autopsied directly by path. `--json` emits the structured rows. Sessions with
no spawns print `(no subagents)`. Non-goals: no recursive rollup into
evidence, no `/map` changes, no registry/runtime changes.

## Prediction

- routing canary ≥ 87.4% (5pp tolerance of 92.4%); edit gate within 1 task of
  baseline — observability-only change, no prompt/tool surface touched.
- On real parent session `019fa2f0` (spawned ≥2 workers), `--subagents` lists
  ≥2 children (expected: all 22) with resolvable session files, and each
  resolved row shows messages/models/warn-count computed by the existing
  scan/evaluate pipeline.
- On a session with no task spawns, the command prints a clean
  `(no subagents)` line and `--json` emits `[]`.
- A ref whose `<id>.jsonl` does not exist under the artifacts root is listed
  as `unresolved`, not dropped from the table.
- Unit contracts: ref extraction from synthetic task toolResults (progress +
  sync results + async-result messages + arg-name fallback), resolver against
  a temp sessions dir with a fixture child session, unresolved handling,
  digest correctness (messages/models/warns), determinism (same entries →
  identical rows twice).

## Verification (auto)

_Generated by `bun run manifest:verify` at 2026-08-02T07:03:04.263Z. Do not edit — re-runs replace this whole section._

| Metric | Measured | Baseline | Delta | Gate | Exit code |
|---|---|---|---|---|---|
| Routing canary (top-1) | 93.1% | 92.4% | +0.7pp | PASS | 0 |
| Edit gate | 29/30 | 28/30 | +1 task(s) | PASS | 0 |

Manual metrics — predictions the canary does not measure; fill by hand:

- [x] (measured: `omp doctor <019fa2f0> --subagents` → "22 referenced, 22 resolved"; every row shows msgs/warns/models from scanSession+evaluateScan, e.g. McpMountScout 74 msgs / 1 warn / 4 models, CanaryExpansion 253 msgs / 2 warns; a listed child path fed back into `omp doctor` reproduces its findings) On real parent session `019fa2f0` (spawned ≥2 workers), `--subagents` lists ≥2 children (expected: all 22) with resolvable session files, and each resolved row shows messages/models/warn-count computed by the existing scan/evaluate pipeline.
- [x] (measured on child session `XdDeviceScout.jsonl`, zero task calls: text output `session 019fa2f6-…: (no subagents)`, `--json` prints `[]`) On a session with no task spawns, the command prints a clean `(no subagents)` line and `--json` emits `[]`.
- [x] (unit contract: ref `Ghost` with no `<root>/Ghost.jsonl` returns `{resolved: false}` at its original position; also covered for a wholly missing artifacts root) A ref whose `<id>.jsonl` does not exist under the artifacts root is listed as `unresolved`, not dropped from the table.
- [x] (11/11 in `test/health-subagents.test.ts`: progress/result/async-result merge with last-write-wins status, failed/aborted derivation, arg-name fallback only for unanswered calls, no-spawn empty, temp-dir resolver with digest {3 msgs, 2 models, 1 warn}, case-insensitive match, empty-file note, missing root, determinism ×2, root-path shape) Unit contracts: ref extraction from synthetic task toolResults (progress + sync results + async-result messages + arg-name fallback), resolver against a temp sessions dir with a fixture child session, unresolved handling, digest correctness (messages/models/warns), determinism (same entries → identical rows twice).

## Verdict

pending-review
