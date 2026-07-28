# Canary Eval — skill-routing regression probe

Scores the **real** system prompt (built with `buildSystemPrompt` from
`@oh-my-pi/pi-coding-agent`) on a fixed skill-routing task, using a
deliberately **weak router model**. Strong models paper over prompt
regressions — they route correctly even from a degraded prompt. A weak model
sits closer to the decision boundary, so a wording/ordering/rendering
regression in the prompt pipeline shows up as an accuracy drop before release.

## Method

- `fixtures/skills/`: 12 synthetic skills in 6 near-neighbor pairs
  (spreadsheet vs record-table, doc-edit vs doc-comment, calendar vs
  room-booking, chat vs mail, drive vs wiki, meeting-lookup vs transcription).
  Near-neighbors force the router to actually read the descriptions.
- `fixtures/queries.json`: 24 colloquial, boundary-adjacent queries
  (2 per skill, zh/en mixed), deliberately not phrased like the descriptions.
- For each query the router model gets the full rendered system prompt and
  answers "which skill do you read first"; top-1 accuracy is scored.
- Single runs are noisy, so `REPEATS=3` runs are averaged. The committed
  baseline (haiku-4.5) sits at ceiling: a mean flip of ≥2 items across runs
  breaches the 5pp tolerance. Sanity check: gutting the prompt
  (`NULL_PROMPT=true`) drops accuracy to 0% and fails the run.

## Usage

```sh
bun run canary:eval                        # compare against baseline.json
CANARY_MODEL=... REPEATS=5 bun run canary:eval
bun scripts/canary-eval/run.ts --write-baseline   # re-record baseline
```

Credentials resolve through omp auth storage or provider env vars
(e.g. `ANTHROPIC_API_KEY`); `CANARY_API_KEY` + `CANARY_BASE_URL` route the
probe through a proxy/broker. Exit 1 when mean accuracy drops more than
`CANARY_TOLERANCE` (default 5) percentage points below `baseline.json`.
With no resolvable credentials it prints SKIPPED and exits 0 (CI-safe).
A baseline with `"status": "unset"` or a different model runs in
record-only mode.

**Updating the baseline:** after an intentional prompt change, verify the
delta is expected, re-run with `--write-baseline` (same model, same repeats),
and commit `baseline.json`.
