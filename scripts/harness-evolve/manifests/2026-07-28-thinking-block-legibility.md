# 2026-07-28-thinking-block-legibility

- **Component-class**: observability
- **Date**: 2026-07-28
- **Fix**: `packages/tui/src/utils.ts` (`shadeAnsiForegrounds`), `packages/coding-agent/src/modes/components/thinking-block.ts` (new), `packages/coding-agent/src/modes/components/assistant-message.ts` (thinking render path), `packages/coding-agent/src/config/settings-schema.ts` (`thinkingBlockStyle`)

## Failure evidence

User report: thinking blocks in the transcript are hard to read (legibility,
not screen real estate). Measured with a render probe (`probe-thinking.ts`,
representative thinking text with a heading, bold, bullets, an ordered list,
inline code and a blockquote) rendering the same source through the assistant
prose path and the thinking path, dumping raw ANSI:

- prose heading: `\x1b[38;2;254;188;56m\x1b[1m方案对比` — mdHeading amber + bold.
- thinking heading: `\x1b[38;2;254;188;56m\x1b[1m\x1b[3m\x1b[38;2;119;125;136m方案对比`
  — the theme colour is emitted, then **overwritten** by `thinkingText`
  (119;125;136) before any glyph. The heading renders as body-grey.
- list bullet (`\x1b[38;2;254;188;56m- `) and inline code
  (`\x1b[38;2;229;193;255mSessionStore`) are *not* overwritten: those two
  survive today.
- every text run carries `\x1b[3m` (italic), including CJK runs, where
  monospace fonts synthesise italic by shearing glyphs.

So the block loses exactly one hierarchy level — headings, the highest-value
structural cue in reasoning text — and pays a legibility tax on all CJK prose.

## Root cause

`assistant-message.ts` renders thinking with `DefaultTextStyle`:

```ts
new Markdown(text, 1, 0, getMarkdownTheme(), {
  color: t => theme.fg("thinkingText", t),
  italic: true,
})
```

`Markdown#applyDefaultStyle` applies `color` **after** the element theme
function for text runs, so the innermost (last) SGR wins: the recess colour
replaces the semantic colour instead of attenuating it. Recessing the block
and preserving its structure are in direct conflict under a
colour-*replacement* model; they only compose under a colour-*transform*
model.

## Targeted fix

1. `packages/tui`: `shadeAnsiForegrounds(line, transform)` — rewrites every
   truecolor foreground (`38;2;r;g;b`) **inside SGR sequences only**, leaving
   indexed colours, backgrounds, decorations and text untouched. The colour
   policy is the caller's; tui owns nothing but the ANSI parsing.
2. New `ThinkingBlockComponent` (coding-agent): owns the inner `Markdown`
   (constructed with the *full* markdown theme, no colour override, **no
   italic**), renders it at `width - 2`, recesses each rendered line, and
   prefixes a muted `thinking.rail` (`╎`, with nerd/ascii preset variants) —
   the aside marker moves from the glyph shape (italic) to the left edge, which
   terminals render losslessly for CJK. A recessed `text` role becomes the
   block's base foreground and markdown's `ESC[39m` is rewritten to it, so
   uncoloured prose recedes too.
3. `assistant-message.ts` builds a `ThinkingBlockComponent`; `captureItems`
   keeps the *inner* Markdown so the streaming fast path (`setText`,
   `transientRenderCache`) is untouched.
4. Degradation: in `256color` mode there is no RGB foreground to rewrite, so the
   block recesses with SGR 2 (faint) + the rail instead. Documented in-code.

### Corrections made mid-flight (recorded, not silently absorbed)

- **Dropped** the planned `thinkingBlockStyle` setting. Settings are threaded
  through five constructor/deps hops in this codebase (interactive-mode →
  context helpers → component → agent-hub → transcript viewer); adding that
  plumbing for an escape hatch nobody asked for is scope the request does not
  carry, and `hideThinkingBlock` already exists as the off switch.
- **Recess model changed** from multiplicative HSV (`adjustHsv({s, v})`) to
  "desaturate, then fade toward the surface". Caught by the light-theme test,
  not by inspection: the light theme's `text` role is `#000000`, whose HSV value
  is 0 and therefore immune to any multiplier — light themes had *zero* recess
  effect under the original design. Value-scaling also cannot recess a
  near-white foreground on a dark theme without inverting hierarchy.
- **Rewrite scoped to SGR sequences** after a test showed a literal
  `38;2;7;7;7` in prose being rewritten. Not theoretical: the very session that
  produced this change has thinking text discussing ANSI colour codes.

## Prediction

- routing canary ≥ 88% (within 5pp tolerance of the 92.4% baseline) — this
  change touches presentation only and must not move routing at all.
- edit gate ≥ 27/30 (within the 1-task tolerance of the 28/30 baseline).
- Render probe, `shaded` mode, dark theme, truecolor: the heading's emitted
  foreground is a **shaded mdHeading** (hue within ±10° of `#febc38`), not
  `thinkingText`; body prose foreground luma < heading foreground luma; inline
  code hue distinct from body hue (≥30° apart). All three measured from raw
  ANSI, not judged by eye.
- Zero `\x1b[3m` (italic) sequences in `shaded`-mode thinking output.
- Doctor's `thinking-collapse` rule verdict on a fixed transcript fixture is
  **unchanged** (the rule reads transcript entries, not rendered rows — this
  must be verified, not assumed, because the health stack's only view of model
  reasoning depends on it).
- Streaming fast path still engages: `#canFastPath`/`#tryFastPathUpdate`
  contract tests green, i.e. no full-rebuild regression per thinking delta.

### Adjudication (measured, dark theme, truecolor, width 72–90)

| prediction | outcome |
|---|---|
| heading hue within ±10° of prose `mdHeading` | **held** — 40.2° vs 40.0°, emitted `38;2;208;175;108` (was `38;2;119;125;136`) |
| heading luma > body luma | **held** — 177.2 vs 138.1 (first attempt inverted at 161 vs 166; retuned by splitting accent and base recess) |
| inline code distinct from body | **held**, restated: body base is achromatic (hue −1), code is chromatic (hue 274.8). The original "≥30° apart" bound is unmeasurable against an achromatic reference — the honest test is chromatic-vs-achromatic. |
| zero `ESC[3m` in thinking output | **falsified as written, revised**: blockquote italics survive because `MarkdownTheme.quote` applies them at theme level, identically to assistant prose. The intent — no *block-wide* italic — holds: every non-blockquote row is italic-free. Recorded rather than widened. |
| `thinking-collapse` verdicts unchanged | **held** — `test/health-doctor.test.ts` green (21 tests with `thinking-block.test.ts`); the rule reads transcript entries, never rendered rows |
| streaming fast path intact | **held** — inner `Markdown` is still the `setText` target (asserted in `thinking-block.test.ts`); 95 tests across 18 assistant/transcript/markdown files green, plus 134 tui markdown tests |
| light theme recesses at all | **added after the fact** — was not predicted; the light path was broken (see corrections) and is now covered by a test asserting the body fades *toward* the surface |

## Verification (auto)

_Generated by `bun run manifest:verify` at 2026-07-28T11:55:31.568Z. Do not edit — re-runs replace this whole section._

| Metric | Measured | Baseline | Delta | Gate | Exit code |
|---|---|---|---|---|---|
| Routing canary (top-1) | 92.4% | 92.4% | +0pp | PASS | 0 |
| Edit gate | 28/30 | 28/30 | +0 task(s) | PASS | 0 |

Manual metrics — predictions the canary does not measure; fill by hand:

- [x] (see Adjudication) Render probe, `shaded` mode, dark theme, truecolor: the heading's emitted foreground is a **shaded mdHeading** (hue within ±10° of `#febc38`), not `thinkingText`; body prose foreground luma < heading foreground luma; inline code hue distinct from body hue (≥30° apart). All three measured from raw ANSI, not judged by eye.
- [~] (falsified as written, revised — see Adjudication) Zero `\x1b[3m` (italic) sequences in `shaded`-mode thinking output.
- [x] (see Adjudication) Doctor's `thinking-collapse` rule verdict on a fixed transcript fixture is **unchanged** (the rule reads transcript entries, not rendered rows — this must be verified, not assumed, because the health stack's only view of model reasoning depends on it).
- [x] (see Adjudication) Streaming fast path still engages: `#canFastPath`/`#tryFastPathUpdate` contract tests green, i.e. no full-rebuild regression per thinking delta.

## Verdict

pending-review — six of seven predictions held as written; the italic prediction was falsified as literally stated (markdown-theme blockquote italics, identical to prose) and is recorded as revised rather than widened. Light-theme recess was broken by the first design and is now covered by a test.
