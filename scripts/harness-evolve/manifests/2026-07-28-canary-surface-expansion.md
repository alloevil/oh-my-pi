# 2026-07-28-canary-surface-expansion

- **Component-class**: observability
- **Date**: 2026-07-28
- **Fix**: `scripts/canary-eval/fixtures/skills/` (+8 synthetic skills), `scripts/canary-eval/fixtures/queries.json` (48 → 144), `scripts/canary-eval/edit-gate.ts` (`PINNED_TASK_IDS` 12 → 30), `scripts/canary-eval/run.ts` (eval-script concurrency only), `scripts/canary-eval/baseline.json`, `scripts/canary-eval/edit-baseline.json`, `scripts/canary-eval/README.md`

## Failure evidence

The canary surface is small enough for a future evolution loop to overfit or
game: 48 routing queries over 8 near-neighbor axes and 12 edit tasks covering
only 12 of the 20 mutation families in
`packages/typescript-edit-benchmark/fixtures.tar.gz`. A prompt change tuned
(even accidentally) to those 48 phrasings or 12 task shapes passes the gate
while regressing the general behavior the gate stands in for. The edit gate's
own baseline sits at ceiling (12/12), so it has zero headroom to show *which*
families a change helps or hurts — only catastrophic breakage moves it. Small
fitness surfaces are exactly what reward-hacking loops exploit.

## Root cause

The canary was built as a cheap release smoke probe, not as a fitness
function: 3 queries/skill was the minimum for off-ceiling calibration, and the
12 pinned tasks were "one per mutation family" under an earlier fixture set —
fixtures now carry 20 families, so 8 families (arithmetic/equality/
increment-decrement/logical/nullish operator swaps, delete-statement,
remove-early-return, swap-adjacent-lines) are entirely unmeasured. Nothing in
the harness maintains surface breadth as fixtures grow.

## Targeted fix

Widen the fitness surface; no runtime changes, no new eval axes:

- Routing: 16 → 24 synthetic skills (12 near-neighbor pairs; the 4 new pairs
  are distinct domains: slide-decks vs whiteboards, attendance clock-in vs
  leave balances, OKR goals vs metric dashboards, translation vs terminology
  glossary). 48 → 144 queries, 6 per skill (2 direct, 2 boundary, 2
  cross-cutting/exclusion-bait), zh/en mixed; existing 48 reviewed for
  description-verbatim leakage and fixed in place where found.
- Edit gate: `PINNED_TASK_IDS` 12 → 30, all 20 mutation families covered (one
  comment per task naming its family), 10 families with a second seed; pinning
  rationale unchanged (fixture regeneration must fail loudly).
- Edit-gate noise hardening added during recalibration (eval script only):
  sessions sample at temperature 0 (parity with the routing probe), a task
  that hits the per-task timeout retries once in a fresh workdir (timeout
  raised 150s → 240s; mismatches never retry), and `--write-baseline`
  records the median passed count of 3 full runs instead of a single run.
- Recalibrate query difficulty until the weak router (broker
  anthropic/claude-haiku-4-5) lands off-ceiling, then `--write-baseline` for
  both probes.

## Prediction

Pre-registered before recalibration. NOTE: `manifest:verify` for this card
runs against the NEW baselines this change itself records, so its delta rows
are self-referential (trivially ~0). The meaningful pre-registered claims are
the baseline RANGE, the STABILITY, and the wall-time bound below — check those
against the recorded recalibration runs, not the delta column.

- New routing baseline mean in **85–95%** (off-ceiling) on the 144-query set,
  REPEATS=3, temp 0.
- Routing stability: the 3 runs of the baseline recording agree within **±1
  correct item** of each other (≤ ~0.7pp spread on 144 queries).
- Edit gate ≥ **28/30** on the expanded pinned set, same tolerance semantics
  as today (`CANARY_EDIT_TOLERANCE` in tasks, default 1).
- Total `bun run canary:eval` wall time on the expanded set ≤ **15 min**.
- routing canary ≥ 85% (within 5pp tolerance of the new baseline)
- edit gate ≥ 28/30 (within 1-task tolerance of the new baseline)

## Verification notes (manual)

**Baseline transition.** Routing: 93.8% on 16 skills/48 queries → **92.4%**
on 24 skills/144 queries — five full REPEATS=3 evaluations during
calibration each scored an identical 133/144 on every run (zero spread, well
inside the ±1-item stability bound). Edit gate: 12/12 pinned tasks (at
ceiling, zero discriminative headroom) → **28/30** across 30 tasks / all 20
mutation families, recorded as the median of 3 recording runs (29, 25, 28 —
the 25 was a provider brownout window in which four otherwise-stable tasks
failed simultaneously; the median discards it). At temperature 0 the
per-run totals concentrate at 28–29: `access-remove-optional-chain-003` is a
stable miss keeping the gate off-ceiling;
`regex-swap-regex-quantifier-002` and `structural-remove-early-return-004`
are borderline and flip within the 1-task tolerance.
Pre-registered range/stability/wall-time claims: routing mean 92.4% ∈
[85, 95] ✓; routing spread 0 items ≤ ±1 ✓; edit baseline 28/30 ≥ 28/30 ✓;
full `canary:eval` wall time ≈ 2m35s (routing) + ~2m (edit gate single run)
≈ 5 min ≤ 15 min ✓ (baseline recording, 3× runs, takes ~6 min on top and is
not part of `canary:eval`).

**Seed selection honesty.** Three seeds were swapped during calibration
(`structural-delete-statement-001` → `-004`,
`structural-remove-early-return-001` → `-004` via `-002`,
`access-remove-optional-chain-002` → `-003`): their expected fixtures
require reproducing deleted content byte-exact that cannot be inferred from
context (an unseen constructor line; a verbatim multi-line prompt string; an
unsignaled blank-line deletion; a needle-in-haystack `?.` in a file full of
them that the weak model picks wrongly every time at temp 0).
Deterministic-fail tasks are dead weight in a drop-only gate. The
replacements keep the same mutation families with context-inferable fixes.

**Per-skill confusion, new pairs** (expected → predicted ×N across the 3
baseline-recording runs; identical in the pre-baseline calibration run):

| New pair axis | Confusion observed |
|---|---|
| slide-deck ↔ board-sketch | slide-deck → board-sketch ×6 (2 queries, every run) |
| clock-punch ↔ leave-ledger | clock-punch → leave-ledger ×3 (1 query, every run) |
| okr-compass ↔ kpi-monitor | none (both 100%) |
| phrase-bridge ↔ term-vault | none (both 100%) |

Cross-pair: approval-desk → leave-ledger ×3 — the leave-domain bait in an
approval query pulls the router across pair boundaries, evidence the new
skills interact with the old axes rather than sitting in isolation.
Remaining confusion on legacy axes: docs-editor→docs-feedback ×6,
room-reserve→agenda-planner ×6, chat-relay↔mail-station ×3+×3,
drive-depot→docs-editor ×3.

**Self-referential caveat** (restated from Prediction): the auto section
below verifies against the baselines this change itself recorded, so its
deltas are ~0 by construction; the range/stability/wall-time checks above
are the real pre-registered content.

## Verification (auto)

_Generated by `bun run manifest:verify` at 2026-07-28T11:07:00.531Z. Do not edit — re-runs replace this whole section._

| Metric | Measured | Baseline | Delta | Gate | Exit code |
|---|---|---|---|---|---|
| Routing canary (top-1) | 92.4% | 92.4% | +0pp | PASS | 0 |
| Edit gate | 28/30 | 28/30 | +0 task(s) | PASS | 0 |

Manual metrics — predictions the canary does not measure; fill by hand:

- [ ] New routing baseline mean in **85–95%** (off-ceiling) on the 144-query set, REPEATS=3, temp 0.
- [ ] Routing stability: the 3 runs of the baseline recording agree within **±1 correct item** of each other (≤ ~0.7pp spread on 144 queries).
- [ ] Total `bun run canary:eval` wall time on the expanded set ≤ **15 min**.

## Verdict

pending-review
