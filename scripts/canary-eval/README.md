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

- `fixtures/skills/`: 24 synthetic skills in 12 near-neighbor pairs
  (spreadsheet vs record-table, doc-edit vs doc-comment, calendar vs
  room-booking, chat vs mail, drive vs wiki, meeting-lookup vs transcription,
  approval vs task-list, person-lookup vs org-tree, slide-deck vs whiteboard,
  attendance-punch vs leave-balance, OKR-goals vs metric-dashboard,
  translation vs term-glossary). Near-neighbors force the router to actually
  read the descriptions, including their exclusion rules. All skills are
  synthetic — none copies a real user skill's wording.
- `fixtures/queries.json`: 144 colloquial queries (6 per skill, zh/en mixed).
  Per skill: two direct asks, two boundary-adjacent phrasings that flirt with
  the near neighbor, and two cross-cutting/exclusion-bait queries that name a
  neighboring domain while this skill stays primary (e.g. "the plan we settled
  in the group chat — write it up and email it to the client, CC my boss" must
  route to mail, not chat). Queries never quote a skill description verbatim —
  shared wording would let the router string-match instead of route.
- For each query the router model gets the full rendered system prompt and
  answers "which skill do you read first"; top-1 accuracy is scored, averaged
  over `REPEATS=3` runs, and compared against `baseline.json`.

**Why the baseline must sit off the ceiling:** an earlier fixture set scored
100%. At ceiling the probe has zero discriminative power — a mild prompt
regression can't push the score *up*, and small regressions hide inside the
saturated band until they are large enough to break multiple queries at once.
The current fixtures are calibrated so haiku-4.5 lands ~92% with misses spread
across many near-neighbor axes (docs-editor→docs-feedback,
room-reserve→agenda-planner, slide-deck→board-sketch,
clock-punch→leave-ledger, chat↔mail, …). From there a regression has headroom
to move the mean immediately, and the per-skill confusion output names the
axis that degraded. The width (144 queries, 12 axes) also makes the probe
harder to overfit: a change tuned to a handful of phrasings still faces ~140
others. Sanity check: gutting the prompt (`NULL_PROMPT=true`) drops accuracy
to 0% and fails the run.

## Edit gate

`edit-gate.ts` reuses `packages/typescript-edit-benchmark` (its
`fixtures.tar.gz`, task loader, in-process `AgentSession` client, and
byte-level verifier) to run a **pinned 30-task slice** — all 20 mutation
families (operator swaps, off-by-one literals, import swaps, structural
if/else swaps, unicode hyphens, …) with a second seed for 10 of them. Each
task seeds a temp workdir with a mutated TypeScript file; the agent (with
`read`/`edit`/`write` tools and the same weak model) must produce an exact
match against the expected fixture. This exercises the layers the routing
probe can't see: tool schemas, the edit tool's matching pipeline, and the
agent loop. A full benchmark run needs 80 tasks x multiple runs; the pinned
30 finishes in a few minutes.

- Task IDs are **pinned, not sampled**, so regenerating benchmark fixtures
  fails the gate loudly instead of silently invalidating `edit-baseline.json`.
  Seeds are chosen so the fix is inferable from surrounding context — seeds
  whose deleted content must be reproduced byte-exact from nothing fail every
  model deterministically and would be dead weight in a drop-only gate.
- Sessions sample at **temperature 0** (parity with the routing probe), and a
  task that hits the per-task timeout is retried once in a fresh workdir —
  transient provider stalls are not capability signal; mismatches never
  retry.
- `--write-baseline` records the **median passed count of 3 full runs**
  (mirrors the routing probe's `REPEATS` averaging): single-run recording of
  a run-to-run-noisy count would make the baseline a lottery ticket, and a
  provider brownout during recording lands in the discarded tail instead of
  the committed number.
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

## Rebaseline record

- **2026-07-28** — initial off-ceiling calibration of the 16-skill/48-query
  set (routing 93.8%) and the 12-task pinned edit slice (12/12).
- **2026-07-28** — surface expansion so a future evolution loop cannot
  overfit the gate: 24 skills / 12 pairs, 144 queries (6 per skill), edit
  gate 30 pinned tasks covering all 20 mutation families. Routing
  recalibration (haiku-4.5, REPEATS=3, temp 0) scored 133/144 on every run
  (92.4% mean, zero spread). Edit gate hardened during recalibration:
  temperature pinned to 0, timeout retry added, baseline recording switched
  to median-of-3, and three seeds whose fixes cannot be inferred from
  context (`structural-delete-statement-001`,
  `structural-remove-early-return-001`, `access-remove-optional-chain-002`)
  swapped for inferable seeds of the same families; baseline recorded
  **28/30** (median of 29, 25, 28 — the 25 was a provider brownout window;
  `access-remove-optional-chain-003` is a stable miss that keeps the gate
  off-ceiling, `regex-swap-regex-quantifier-002` and
  `structural-remove-early-return-004` are borderline and covered by the
  1-task tolerance). See
  `scripts/harness-evolve/manifests/2026-07-28-canary-surface-expansion.md`.
