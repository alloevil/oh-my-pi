# Incident ledger

Observed-but-unruled behavioral pathologies. A doctor rule needs a known
false-positive rate; a single incident cannot provide one. Each entry here is
one observation of a pattern — when a second incident matches an entry, that
pair is the evidence a manifest card needs. Until then: `omp doctor <session>
--autopsy` computes the axes, humans judge.

Format per entry: session, task, pathologies (with the autopsy numbers),
candidate rule sketch, and what a second occurrence would look like.

---

## #1 — 2026-07-28 · Mail-organizing session `019fac75-730d-7000-ab46-05190f8fb6b0`

**Task**: organize Mac Mail inboxes by sender (user's daily workload).
**Outcome**: transcript ends mid-operation (“移动项目”对话框出现了…); ground truth
(user, 2026-07-28): **task abandoned to manual takeover** — the user organized
the mail themselves. 2.5h of session time, ~28min of ask-waits, and the
deliverable was ultimately produced by hand. This label is what every detector
above lacks: a dependent variable.

Pathologies (autopsy numbers):

| Pattern | Evidence | Candidate rule sketch | Second occurrence looks like |
|---|---|---|---|
| **Strategy flailing** | 3 automation stacks in sequence (Mail AppleScript → System Events UI → 120× ego-browser CDP); 19 errors in 16 distinct clusters; no step-back | high error *diversity*: distinct-clusters / total-errors ≥ 0.7 with total ≥ 10 — "many different things failed" ≠ "one flaky thing failed often" | another session with ≥10 errors spread across ≥70% distinct shapes |
| **O(n) UI grinding** | one message moved per synthesized browser click; 120 near-identical script invocations | top command-prefix count ≥ 50 within one session | any session where one prefix dominates ≥50 calls |
| **Dangling ending** | last assistant text is an unfinished operation narration; todo used 2× in 457 messages | last-assistant-text heuristics are judgment, not code — keep report-only | recurring user reports of sessions that "just stopped" |
| **Repeated asking** | “登录好了吗/登录状态/登录情况” — same question 3 ways; waits 828s + 805s | ask count ≥ 3 with pairwise-similar questions — similarity is judgment; report-only | another login-wait loop |

Fixes applied at other layers:
- `ttfb-health` doctor rule (stalls/chronic) — the mechanical half of this
  incident (card `2026-07-28-ttfb-trend-rule`, including the falsified trend
  hypothesis).
- `--autopsy` report (card `2026-07-28-behavior-autopsy`) — makes this
  archaeology a one-flag operation.
- `mac-mail-automation` user skill — strategy ladder so the same task starts
  with Mail rules / batch AppleScript instead of ending at per-message UI
  clicks.

### Candidate measurements — 2026-07-28, corrected 2026-07-30: real corpus = 11 sessions, not 380

**Denominator correction (2026-07-30, card
`2026-07-30-eval-session-contamination`):** the original "corpus = 380
sessions" counted 369 eval artifacts as usage. Recount by session header:
**366** are routing-probe sessions from the 2026-07-27 canary generation
(zero tool calls, ≤4 messages each, single burst — and path-invisible: their
header cwd is the repo package dir, so any future measurement script must
exclude them by that explicit content criterion, not by path) and **3** are
tmp smoke runs (`/tmp/outbound-smoke` ×2, `/tmp/stage-e2e` — these ARE
path-detectable and are now excluded mechanically by
`packages/coding-agent/src/health/ephemeral.ts`; `omp evidence` skips them
by default, `--include-ephemeral` restores them). The real corpus is **11
sessions, 7 with bash/eval** — the same 7 the original parenthetical already
admitted. Re-run on the real corpus, **all three verdicts hold**; the only
number that moves is the diversity candidate's eligible population, n=3 →
n=2 (nothing outside the real 11 has ≥10 errors — routing probes make no
tool calls — so the ledger's third eligible session does not reproduce on
today's corpus; counting drift or a since-archived session).

| Candidate | Result (real corpus, n=11, re-measured 2026-07-30) | Verdict |
|---|---|---|
| consecutive same-prefix failures ≥3 | **0 firings anywhere — including the incident** (max observed streak: 1). The incident's failures were 16 distinct shapes interleaved with successes ("wandering between walls"), never 3 consecutive hits on one wall | **discarded — deaf** (unchanged) |
| error-diversity ≥0.7 with total ≥10 | 2 firings: the incident (19/16, 0.84) **and** a legitimate dev session (16/15, 0.94 — iteration, not flailing). 50% precision, n=2 eligible | **report-only** (unchanged); not separable at this corpus size |
| dominant command prefix ≥50 | 1 firing: the incident at **120×**. Next highest in the real corpus: 11× (another Mail session), 10× (dev). Margin 120 vs 11 | **survives** (unchanged) — the one candidate fit for a live nudge |

Delivery seam for the surviving candidate (per advisor recon): the advisor
subsystem cannot host trajectory oversight (off by default, delta-only view,
same-theme note dedup silences repeated nudges), but `ToolCallLoopGuard`
(threshold: 5 consecutive *identical* calls → hidden redirect custom message
at turn end) is the exact structural idiom — the churn nudge is its
generalization from "identical call ×5" to "same first-line prefix ×50",
attached on the same `setOnTurnEnd` chain next to `LoopGuards.recordTurn`.
Advisor's own system prompt already lists "Churning" as a concern trigger
with nothing computing it.

---

## Lesson loop

What the outcome labels (card in flight: OutcomeLabels slice — `omp label`,
`health/outcome.ts`) close: every detector above lacked a dependent
variable until a user happened to report a session id. The loop, each step
one command:

1. **Label the outcome** the moment ground truth exists: `omp label
   abandoned|manual-takeover <session> --note "user finished by hand"`
   (also `done` / `partial` — labeling successes is what gives detectors a
   negative class). Last label wins; the label renders in the `omp doctor`
   header.
2. **Autopsy the labeled session**: `omp doctor <session> --autopsy` —
   error clusters, command lineage, out-of-repo mutations, ending state,
   ask waits. Computed evidence, human judgment.
3. **File or match an incident entry** here: grep this ledger for the
   pathology shape first. A first occurrence gets a new `## #N` entry
   (session, task, autopsy numbers, candidate rule sketch, what a second
   occurrence looks like). A *second* occurrence matching an existing entry
   is the false-positive evidence a manifest card needs.
4. **Sketch the fix at the right layer**: a doctor rule
   (`packages/coding-agent/src/health/doctor.ts` + manifest card from
   `scripts/harness-evolve/TEMPLATE.md`) when the signal is mechanical; a
   skill when the pathology is task strategy (e.g. `mac-mail-automation`);
   report-only autopsy axes when the number needs human judgment.

Corpus hygiene for step-zero measurement: `omp evidence` and any
measurement script must exclude eval sessions —
`health/ephemeral.ts` (`isEphemeralSession`) handles tmp-workdir evals
mechanically; the 2026-07-27 legacy routing probes need the explicit
content criterion documented in the correction above.

### Candidate added 2026-07-30 — repetition-trend (lost-in-the-middle proxy)

Position-resolved probe over the 3 real sessions ≥300 messages: repetition
signals (same path+selector re-reads, byte-identical command re-runs) skew to
the back half in 2/3 (incident: re-reads 0→7→13→9 by quartile, re-runs
0→1→3→3); raw error *rate* is U-shaped (Q1 setup noise dominates), so the
instrument must use repetition density, never error rate. Rule sketch:
back-half repetition density ≥ k× front-half. k uncalibratable at n=3 —
waiting on outcome-labeled sessions (abandoned/manual-takeover set becomes the
calibration corpus). Full analysis: docs/notes/2026-07-30-agent-error-discovery-and-task-map.md
