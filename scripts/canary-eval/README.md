# Canary Eval — prompt-routing + edit-capability regression probes

Two cheap, weak-model probes that catch regressions before release:

1. **Routing probe** (`run.ts`) — scores the **real** system prompt (built with
   `buildSystemPrompt` from `@oh-my-pi/pi-coding-agent`) on a fixed
   skill-routing task.
2. **Edit gate** (`edit-gate.ts`) — scores the real agent session (tools,
   edit pipeline, prompt scaffolding) on a pinned slice of the TypeScript
   edit benchmark.

Both use a deliberately **weak model** (haiku-4.5 by default). Strong models
paper over prompt/pipeline regressions — they behave correctly even from a
degraded prompt. A weak model sits closer to the decision boundary, so a
wording/ordering/rendering regression shows up as a score drop before release.

## Routing probe

- `fixtures/skills/`: 16 synthetic skills in 8 near-neighbor pairs
  (spreadsheet vs record-table, doc-edit vs doc-comment, calendar vs
  room-booking, chat vs mail, drive vs wiki, meeting-lookup vs transcription,
  approval vs task-list, person-lookup vs org-tree). Near-neighbors force the
  router to actually read the descriptions, including their exclusion rules.
- `fixtures/queries.json`: 48 colloquial queries (3 per skill, zh/en mixed).
  Per skill: one direct ask, one boundary-adjacent phrasing that flirts with
  the near neighbor, and one cross-cutting/exclusion-bait query that names the
  neighbor's domain while this skill stays primary (e.g. "the plan we settled
  in the group chat — write it up and email it to the client, CC my boss" must
  route to mail, not chat).
- For each query the router model gets the full rendered system prompt and
  answers "which skill do you read first"; top-1 accuracy is scored, averaged
  over `REPEATS=3` runs, and compared against `baseline.json`.

**Why the baseline must sit off the ceiling:** an earlier fixture set scored
100%. At ceiling the probe has zero discriminative power — a mild prompt
regression can't push the score *up*, and small regressions hide inside the
saturated band until they are large enough to break multiple queries at once.
The current fixtures are calibrated so haiku-4.5 lands ~94% (misses spread
across several near-neighbor axes: docs-editor→docs-feedback,
mail-station→chat-relay, meet-recorder→minute-scribe). From there a
regression has headroom to move the mean immediately, and the per-skill
confusion output names the axis that degraded. Sanity check: gutting the
prompt (`NULL_PROMPT=true`) drops accuracy to 0% and fails the run.

## Edit gate

`edit-gate.ts` reuses `packages/typescript-edit-benchmark` (its
`fixtures.tar.gz`, task loader, in-process `AgentSession` client, and
byte-level verifier) to run a **pinned 12-task slice** — one task per mutation
family (operator swaps, off-by-one literals, import swaps, structural
if/else swaps, unicode hyphens, …). Each task seeds a temp workdir with a
mutated TypeScript file; the agent (with `read`/`edit`/`write` tools and the
same weak model) must produce an exact match against the expected fixture.
This exercises the layers the routing probe can't see: tool schemas, the edit
tool's matching pipeline, and the agent loop. A full benchmark run needs 80
tasks x multiple runs; the pinned dozen finishes in ~1-3 minutes.

- Task IDs are **pinned, not sampled**, so regenerating benchmark fixtures
  fails the gate loudly instead of silently invalidating `edit-baseline.json`.
- Pass count is compared against `edit-baseline.json` with a tolerance
  expressed in tasks (`CANARY_EDIT_TOLERANCE`, default 1) — a single flaky
  task never fails the gate, a 2+ task drop does.
- Skip with `CANARY_SKIP_EDIT=1`; it also auto-skips (exit 0) when no
  credentials resolve.

## Usage

```sh
bun run canary:eval                        # routing probe, then edit gate
CANARY_SKIP_EDIT=1 bun run canary:eval     # routing probe only
CANARY_MODEL=... REPEATS=5 bun scripts/canary-eval/run.ts
bun scripts/canary-eval/run.ts --write-baseline        # re-record routing baseline
bun scripts/canary-eval/edit-gate.ts --write-baseline  # re-record edit baseline
```

Credentials resolve exactly like the interactive CLI: `models.yml` provider
overrides (broker baseUrl + key), OAuth credentials, and provider env vars
(e.g. `ANTHROPIC_API_KEY`); `CANARY_API_KEY` + `CANARY_BASE_URL` route the
routing probe through an explicit proxy/broker instead.

Exit codes (both probes): pass = 0; regression beyond tolerance = 1; skipped
because no credentials resolve = 0 (CI-safe). Routing tolerance is
`CANARY_TOLERANCE` (default 5) percentage points below `baseline.json`.
A baseline with `"status": "unset"` or a different model runs in record-only
mode (exit 0).

**Updating the baselines:** after an intentional prompt/tooling change, verify
the delta is expected, re-run the affected probe with `--write-baseline`
(same model, same repeats), and commit `baseline.json` /
`edit-baseline.json`. After editing fixtures, always re-record: the baseline
is only meaningful for the exact fixture set it was measured on.
