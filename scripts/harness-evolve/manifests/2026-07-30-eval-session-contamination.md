# 2026-07-30-eval-session-contamination

- **Component-class**: observability
- **Date**: 2026-07-30
- **Fix**: `packages/coding-agent/src/health/ephemeral.ts` (new),
  `packages/coding-agent/src/cli/evidence-cli.ts` (default ephemeral filter +
  `--include-ephemeral`), `packages/coding-agent/src/commands/evidence.ts`
  (flag), `packages/coding-agent/test/health-ephemeral.test.ts` (new),
  `scripts/harness-evolve/incidents.md` (corrected denominators + lesson
  loop), `packages/coding-agent/CHANGELOG.md`

## Failure evidence

The 2026-07-28 candidate-detector measurements in
`scripts/harness-evolve/incidents.md` used "corpus = 380 sessions" as the
false-positive denominator. Recounting the corpus
(`~/.omp/agent/sessions/*/*.jsonl`, 380 files) by session-header `cwd`:

- **366** sessions in `-Downloads-oh-my-pi-packages-coding-agent` are
  single-burst routing-probe sessions from the 2026-07-27 canary generation
  (≤4 messages, **zero** tool calls each, `session_exit reason=dispose`,
  header cwd = the package dir). They are eval artifacts, not usage.
- **3** sessions live under OS temp cwds (`/tmp/outbound-smoke` ×2,
  `/tmp/stage-e2e`) — e2e smoke runs.
- **11** sessions in `-Downloads` are the real corpus (7 with bash/eval —
  exactly the "7 with bash/eval" the ledger already noted).

So the honest denominator was 11, not 380 — a 34× inflation. Nothing in the
evidence/measurement tooling distinguishes eval sessions from real ones, and
the next measurement will make the same mistake.

**Premise correction (recorded prominently, per discipline):** the working
assumption was that eval sessions are identifiable by tmp session dirs
(`-private-tmp-*` / `-var-folders-*`). That holds for only 3 of the 369
ephemeral sessions on this machine. The dominant contaminant — the 366
legacy routing probes — carries the *repo package dir* as header cwd and is
path-invisible; it is identifiable only by content shape (zero tool calls,
≤4 messages, one burst). The current `scripts/canary-eval/run.ts` no longer
creates sessions at all (it calls `completeSimple` directly) and the edit
gate runs in `TempDir` workdirs (under `os.tmpdir()`), so the tmp-root rule
is correct and complete *going forward*; the 366 are a legacy artifact that
measurement scripts must exclude by explicit documented criterion, not by
path.

## Root cause

Session storage records every session identically regardless of origin; the
evidence CLI and ad-hoc measurement scripts scan session directories with no
notion of "this session was produced by an eval harness in a throwaway
workdir". Eval harnesses (edit gate, smoke e2e) run in OS temp workdirs, so
their sessions are mechanically identifiable by header cwd / encoded session
dir name under temp roots — but no shared predicate existed, so every
consumer counted them as usage.

## Targeted fix

- New pure helper `packages/coding-agent/src/health/ephemeral.ts`:
  `isEphemeralSession({ headerCwd, sessionDirName })` — true when the
  recorded session-header cwd (preferred) or, as fallback, the encoded
  sessions-dir folder name resolves under the OS temp roots (`os.tmpdir()`,
  `/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders`; the modern
  `-tmp-*` and legacy `--<encoded-abs>--` dir-name encodings both handled).
- `evidence-cli.ts`: the default session scan drops ephemeral sessions
  before the most-recent-N cut; `--include-ephemeral` restores the old
  behavior; when any were dropped, a `skipped N ephemeral (eval/tmp)
  sessions` line is written (stderr, so markdown/JSON payloads stay clean).
- `scripts/harness-evolve/incidents.md`: candidate-measurements section
  corrected with the real denominators and re-verdicts; new "Lesson loop"
  section documenting the outcome-label → autopsy → incident-entry →
  candidate-rule loop (references the in-flight OutcomeLabels slice).
- Re-measurement itself via a throwaway `/tmp` script over `buildAutopsy`
  (not committed). No canary script changes; no session files deleted.

## Prediction

- routing canary ≥ 93% (within 5pp tolerance of the committed baseline;
  this change touches no prompt or tool path — prompt-inert)
- edit gate within 1 task of the committed baseline
- Re-running the three 2026-07-28 candidate measurements over the REAL
  corpus (the 11 `-Downloads` sessions; 369 ephemeral excluded) keeps all
  three verdicts: consecutive same-prefix failures ≥3 still fires 0 times
  (still deaf, still discarded); error-diversity ≥0.7 with total ≥10 still
  fires exactly 2 times (incident 019fac75 + the one legitimate dev
  session; still report-only); dominant command prefix ≥50 still fires
  exactly once (the incident at 120×; still survives). Any verdict change
  is recorded prominently in incidents.md — that would be the headline
  result, not a footnote.
- `omp evidence` run from a cwd whose session dir contains only ephemeral
  sessions skips them by default and reports `skipped N ephemeral
  (eval/tmp) sessions`; with `--include-ephemeral` the same invocation
  compiles a report over those sessions.
- `omp evidence` for a real-session cwd (`-Downloads`) produces a byte-wise
  unchanged report vs. before this change (no ephemeral sessions live in
  that dir, so the filter is a no-op there).
- `packages/coding-agent/test/health-ephemeral.test.ts` passes: tmp cwd →
  ephemeral; home-project cwd → not; folder-name fallback (modern `-tmp-*`
  and legacy `--private-tmp-*--` encodings) works; `os.tmpdir()` respected.

## Verification (auto)

_Generated by `bun run manifest:verify` at 2026-07-30T02:05:39.669Z. Do not edit — re-runs replace this whole section._

| Metric | Measured | Baseline | Delta | Gate | Exit code |
|---|---|---|---|---|---|
| Routing canary (top-1) | 91.7% | 92.4% | -0.7pp | PASS | 0 |
| Edit gate | 27/30 | 28/30 | -1 task(s) | PASS | 0 |

Manual metrics — predictions the canary does not measure; fill by hand:

- [ ] Re-running the three 2026-07-28 candidate measurements over the REAL corpus (the 11 `-Downloads` sessions; 369 ephemeral excluded) keeps all three verdicts: consecutive same-prefix failures ≥3 still fires 0 times (still deaf, still discarded); error-diversity ≥0.7 with total ≥10 still fires exactly 2 times (incident 019fac75 + the one legitimate dev session; still report-only); dominant command prefix ≥50 still fires exactly once (the incident at 120×; still survives). Any verdict change is recorded prominently in incidents.md — that would be the headline result, not a footnote.
- [ ] `omp evidence` run from a cwd whose session dir contains only ephemeral sessions skips them by default and reports `skipped N ephemeral (eval/tmp) sessions`; with `--include-ephemeral` the same invocation compiles a report over those sessions.
- [ ] `omp evidence` for a real-session cwd (`-Downloads`) produces a byte-wise unchanged report vs. before this change (no ephemeral sessions live in that dir, so the filter is a no-op there).
- [ ] `packages/coding-agent/test/health-ephemeral.test.ts` passes: tmp cwd → ephemeral; home-project cwd → not; folder-name fallback (modern `-tmp-*` and legacy `--private-tmp-*--` encodings) works; `os.tmpdir()` respected.

## Verification (manual, author-run)

Evidence for the non-canary predictions, measured 2026-07-30 (coordinator
ticks after review):

- Re-measurement (throwaway `/tmp/remeasure-candidates.ts` over
  `buildAutopsy` + `loadEntriesFromFile`, not committed): corpus 380 →
  real 11 / ephemeral-path 3 / legacy-probe 366. All three verdicts held:
  streak ≥3 fired 0 times (max observed streak anywhere: 1); diversity
  fired exactly twice — incident 019fac75 (19 total/16 distinct, 0.84) and
  dev session 019fa2f0 (16/15, 0.94); dominant prefix fired exactly once —
  the incident at 120× (next: 11×, 10×). One number moved: diversity's
  eligible population is n=2 on the real corpus, not the ledger's n=3
  (nothing excluded has ≥10 errors — probes make no tool calls); recorded
  in the corrected incidents.md section. Nothing among the 369 excluded
  sessions would have fired any candidate.
- Skip line, pasted (run from `/tmp/outbound-smoke`, whose session dir
  holds 2 smoke sessions):
  ```
  === default ===
  evidence: skipped 2 ephemeral (eval/tmp) sessions
  evidence: no non-ephemeral sessions recorded for /private/tmp/outbound-smoke (2 eval/tmp sessions skipped; use --include-ephemeral to analyze them)
  exit=1
  === --include-ephemeral ===
  # Evidence report
  ## L1 — Overview
  - sessions analyzed: 2
  ```
- Real-corpus no-op: `omp evidence` from `~/Downloads` (the `-Downloads`
  dir, 11 real sessions) exits 0, emits no skip line, and its report is
  byte-identical (`cmp`) with and without `--include-ephemeral`.
- `bun test test/health-ephemeral.test.ts`: 10/10 pass (tmp cwd →
  ephemeral incl. `/private` alias and `os.tmpdir()`; home-project cwd →
  not; `-tmp-*` and `--private-tmp-*--` dir-name fallbacks; `/tmpfs`
  non-matches). `tsgo --noEmit` and `biome check` clean on touched files.
- Files touched: `src/health/ephemeral.ts` (new),
  `test/health-ephemeral.test.ts` (new), `src/cli/evidence-cli.ts`,
  `src/commands/evidence.ts`, `scripts/harness-evolve/incidents.md`,
  `CHANGELOG.md`, this card. No session file deleted; no canary script
  changed.

## Verdict

keep — user-approved 2026-08-02; corpus corrected 380→11 real, all three candidate verdicts survived, premise-failure (366 path-invisible probe sessions) recorded
