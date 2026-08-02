# 2026-07-28-heredoc-command-preview

- **Component-class**: observability
- **Date**: 2026-07-28
- **Fix**: `packages/coding-agent/src/tools/bash.ts` (`formatBashCommandLines`, shell renderer call sites), `packages/coding-agent/test/bash-command-preview.test.ts`

## Failure evidence

User report with a verbatim transcript excerpt: a single `bash` call that wrote
a PR body via heredoc and then ran `gh pr create` rendered as a ~60-line boxed
block filling the entire viewport — the whole markdown payload, line by line,
inside the command frame. The two facts a reader wants ("writes /tmp/pr-body.md",
"then runs gh pr create") were buried in it.

Reproduced from the session transcript: the rendered command block for that
call spans the full `previewWindowRows()` window, and the trailing
`gh pr create …` line — the actual action — is the last line after 50+ lines of
prose.

## Root cause

`formatBashCommandLines` highlights the command and hands every line to
`capPreviewLines`, whose default cap is `previewWindowRows()` — terminal rows
minus a small reserve. So a long command is *permitted* to consume the whole
viewport, and the cap keeps the **tail** window (correct while args stream,
since the live edge is at the end).

Underneath that is a semantic mismatch: a heredoc body is **data the command
carries**, not command structure. Rendering it as command lines gives payload
bytes the same visual weight as the pipeline they belong to, and the line budget
is spent on the least informative part.

## Second finding (user, after the first fix landed)

> "问题在于它没有按照 markdown 来展示" — the payload isn't displayed as markdown.

The sharper diagnosis, and the one that names the actual defect. The body went
through `highlightCode(command, "bash")` with the rest of the command, so a
markdown PR body was tokenised as shell: ATX headings, fenced blocks and table
rows are not bash tokens, and the payload came out as one undifferentiated run.
Worse, the bash grammar reads everything after `<<'DELIM'` as an unterminated
string and leaves that colour open at end of line, so payload text bled shell
string colour.

Collapsing (the first fix) hid the symptom on long bodies while leaving every
short body mis-highlighted. Both defects share one cause: the body was treated
as shell source instead of as the payload it is.

## Targeted fix

`formatBashCommandLines` gains an `expanded` option and, when collapsed, folds
each heredoc body longer than 3 lines into one dim summary line
(`… 58 lines of heredoc body (MSG)`), keeping the redirect line, the closing
delimiter, and every following command visible. Detection is lexical over the
raw command (`<<` / `<<-`, quoted or bare delimiter, tab-stripped terminator for
`<<-`), and unterminated bodies — the streaming case — collapse to the end of
the buffer. `ctrl+o` (expanded) still shows the payload verbatim.

Highlighted lines map 1:1 onto raw lines, so the collapse operates on raw-line
indices and splices the highlighted array.

**Second pass (payload language).** Each body is highlighted in its own language:
the redirect target's extension first (`> notes.md` → markdown, via the existing
`getLanguageFromPath`), then the delimiter label as the author's own hint
(`<<'PY'` → python, `<<'SQL'` → sql; `EOF`/`MSG` name nothing and fall through),
else muted plain text — muted rather than default so an unrecognised payload still
reads as data inside a command. Bash lines keep the whole-command bash
highlighting unchanged. An explicit SGR reset is appended to the redirect line so
the shell's unterminated-string colour cannot bleed into a payload highlighted by
a different grammar. The collapse summary now names the detected language
(`… 54 lines of heredoc body (MSG, markdown)`).

## Prediction

- routing canary ≥ 88% (5pp tolerance of the 92.4% baseline); edit gate ≥ 27/30
  (1-task tolerance of 28/30). Presentation-only change; both must be flat.
- The reported command (heredoc PR body + `gh pr create`) renders in **≤ 8
  lines** collapsed, down from 60+, with the `gh pr create` line still present.
- A command with **no** heredoc renders byte-identically to today's output
  (regression guard: the collapse must be inert outside heredocs).
- A 2-line heredoc body is **not** collapsed (threshold respected — collapsing
  something shorter than its own summary line is a loss).
- Expanded (`ctrl+o`) output contains every payload line verbatim.
- Streaming case: a command whose heredoc is still unterminated collapses
  without dropping the redirect line that opened it.

### Added for the second pass (pre-registered before implementing it)

- A markdown payload emits **structure colour**: the ATX marker and table pipes
  carry foreground sequences (bash highlighting produced none for them).
- Redirect target beats a conflicting delimiter label: `cat > notes.md <<'PY'`
  highlights the body as markdown, and the emitted line differs from the same
  payload highlighted via the `PY` label.
- The redirect line ends with an SGR reset — no shell colour bleeds into the
  payload.
- An unrecognised payload language renders muted, not mis-highlighted.
- The collapse summary names the detected language.

## Verification (auto)

_Generated by `bun run manifest:verify` at 2026-07-28T12:28:16.127Z. Do not edit — re-runs replace this whole section._

| Metric | Measured | Baseline | Delta | Gate | Exit code |
|---|---|---|---|---|---|
| Routing canary (top-1) | 92.4% | 92.4% | +0pp | PASS | 0 |
| Edit gate | 28/30 | 28/30 | +0 task(s) | PASS | 0 |

Manual metrics — predictions the canary does not measure; fill by hand:

- [x] (57 → 4 lines; `gh pr create` present) The reported command (heredoc PR body + `gh pr create`) renders in **≤ 8 lines** collapsed, down from 60+, with the `gh pr create` line still present.
- [x] (test: collapsed `toEqual` expanded) A command with **no** heredoc renders byte-identically to today's output (regression guard: the collapse must be inert outside heredocs).
- [x] (test: exact line array) A 2-line heredoc body is **not** collapsed (threshold respected — collapsing something shorter than its own summary line is a loss).
- [x] (test: full payload, no summary) Expanded (`ctrl+o`) output contains every payload line verbatim.
- [x] (test: redirect kept, `still streaming` note) Streaming case: a command whose heredoc is still unterminated collapses without dropping the redirect line that opened it.
- [x] (test: `##` + table pipes carry fg sequences) A markdown payload emits **structure colour**: the ATX marker and table pipes carry foreground sequences (bash highlighting produced none for them).
- [x] (test: markdown vs `PY` output differ) Redirect target beats a conflicting delimiter label: `cat > notes.md <<'PY'` highlights the body as markdown, and the emitted line differs from the same payload highlighted via the `PY` label.
- [x] (test: line ends with `ESC[0m`) The redirect line ends with an SGR reset — no shell colour bleeds into the payload.
- [x] (test: stripped equal, styled not equal) An unrecognised payload language renders muted, not mis-highlighted.
- [x] (test + smoke: `(MSG, markdown)`, `(EOF, sql)`) The collapse summary names the detected language.

## Verdict

keep — user-approved 2026-08-02 after real use; both passes (collapse + payload language) accepted
pre-registered for the payload-language pass). Recorded corrections: the `<<-`
terminator match was written against tabs though `replaceTabs` runs first
(caught by test, not by reading); and the first pass fixed only the symptom —
collapsing hid mis-highlighted long bodies while every short body stayed
mis-highlighted. The user's second diagnosis ("it isn't displayed as markdown")
named the real defect; the collapse alone would have shipped as a
plausible-looking partial fix. — all six pre-registered predictions held. One correction worth
recording: the `<<-` terminator match was written against tabs, but the display
pipeline runs `replaceTabs` before this code sees the command, so the tab-indented
terminator never matched. Caught by the `<<-` test, not by reading the code; the
match now ignores leading whitespace and says why.
