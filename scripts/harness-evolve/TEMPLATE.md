# YYYY-MM-DD-short-slug

<!--
Copy this file to manifests/<id>.md BEFORE landing the harness change.
id = date-slug, matching the filename. Fill every section except
"Verification (auto)" (script-owned) and write the Verdict only AFTER
verification.
-->

- **Component-class**: one of: system-prompt | tool-implementation | tool-description | middleware | memory | skills | subagent-config | observability
- **Date**: YYYY-MM-DD
- **Fix**: files / commits / PRs touched

## Failure evidence

What concrete observation motivated this change (doctor finding, canary
confusion, session transcript, measurement). No evidence, no card.

## Root cause

Why the harness behaves that way today. Mechanism, not symptom.

## Targeted fix

What changes, exactly: files, settings, commits. Smallest change that
addresses the root cause.

## Prediction

Written BEFORE the change lands. Every bullet MUST be measurable: named
metric, direction, bound. Bullets mentioning the routing canary or the edit
gate are auto-checked by `manifest:verify`; everything else becomes a manual
line item for the human.

- routing canary ≥ 93% (within 5pp tolerance of baseline)
- edit gate ≥ 11/12 (within 1-task tolerance of baseline)
- <other metric>: <direction + bound, e.g. "system prompt chars -20±5%">

## Verification (auto)

_Empty until `bun run manifest:verify scripts/harness-evolve/manifests/<id>.md`
runs the canary evals and fills this section. Do not edit by hand — re-runs
replace the whole section._

## Verdict

_Human-filled after verification. First word one of `keep` | `rollback` |
`revise`, then the rationale. The verdict binds: a falsified prediction means
rollback or revise, not a quietly widened bound._
