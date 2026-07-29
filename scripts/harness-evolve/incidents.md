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
**Outcome**: transcript ends mid-operation (“移动项目”对话框出现了…); completion unverified.

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

### Candidate measurements — 2026-07-28, corpus = 380 sessions (7 with bash/eval)

| Candidate | Result | Verdict |
|---|---|---|
| consecutive same-prefix failures ≥3 | **0 firings anywhere — including the incident.** The incident's failures were 16 distinct shapes interleaved with successes ("wandering between walls"), never 3 consecutive hits on one wall | **discarded — deaf** |
| error-diversity ≥0.7 with total ≥10 | 2 firings: the incident (19/16, 0.84) **and** a legitimate dev session (16/15, 0.94 — iteration, not flailing). 50% precision, n=3 eligible | **report-only**; not separable at this corpus size |
| dominant command prefix ≥50 | 1 firing: the incident at **120×**. Next highest in the corpus: 11× (another Mail session), 10× (dev). Margin 120 vs 11 | **survives** — the one candidate fit for a live nudge |

Delivery seam for the surviving candidate (per advisor recon): the advisor
subsystem cannot host trajectory oversight (off by default, delta-only view,
same-theme note dedup silences repeated nudges), but `ToolCallLoopGuard`
(threshold: 5 consecutive *identical* calls → hidden redirect custom message
at turn end) is the exact structural idiom — the churn nudge is its
generalization from "identical call ×5" to "same first-line prefix ×50",
attached on the same `setOnTurnEnd` chain next to `LoopGuards.recordTurn`.
Advisor's own system prompt already lists "Churning" as a concern trigger
with nothing computing it.
