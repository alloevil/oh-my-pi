# harness-evolve — manifest cards for harness changes

Human-in-loop decision observability for harness evolution (after the AHE
paper's manifest/decision discipline, arXiv 2604.25850): every harness change
carries a card with a pre-registered, measurable prediction, gets verified
against the canaries after landing, and ends in a binding verdict.

## The discipline

1. **Card BEFORE change.** Copy `TEMPLATE.md` to `manifests/<date-slug>.md`;
   fill failure evidence, root cause, targeted fix, and a prediction whose
   every bullet names a metric, a direction, and a bound.
2. **Verify AFTER landing.** `bun run manifest:verify manifests/<id>.md` runs
   the routing canary and the edit gate and writes measured numbers, baseline
   deltas, and raw exit codes into the card's `## Verification (auto)` section
   (idempotent — re-runs replace it).
3. **Verdict binds.** Human writes `keep` | `rollback` | `revise` in
   `## Verdict`. A falsified prediction means rollback or revise — never a
   quietly widened bound. See `2026-07-27-skill-brief-mode.md` for the
   canonical falsification.

## Component taxonomy

`system-prompt` | `tool-implementation` | `tool-description` | `middleware` |
`memory` | `skills` | `subagent-config` | `observability`

## Querying history

```sh
grep -l 'Component-class.*: middleware' scripts/harness-evolve/manifests/*.md
grep -A2 '^## Verdict' scripts/harness-evolve/manifests/*.md   # verdicts + rationale
grep -rl 'rollback —' scripts/harness-evolve/manifests/        # falsifications
```

## Honest boundary

The canary covers **skill routing + edit capability only**. Every other
prediction (prompt size, process counts, doctor findings, …) is emitted by
`manifest:verify` as a manual line item — a human measures and checks it off.
The three seed cards are retroactive reconstructions (predictions written
after the fact) and carry no pre-registration value.
