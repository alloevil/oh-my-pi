# search

> Search file contents with a regex across files, directories, globs, and internal URLs.

## Source
- Entry: `packages/coding-agent/src/tools/search.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/search.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/match-line-format.ts` — model-facing anchor formatting.
  - `packages/coding-agent/src/tools/path-utils.ts` — path normalization, glob splitting, internal URL resolution.
  - `packages/coding-agent/src/tools/file-recorder.ts` — file ordering for grouped output.
  - `packages/coding-agent/src/tools/grouped-file-output.ts` — grouped per-file text layout.
  - `packages/coding-agent/src/session/streaming-output.ts` — line truncation and final byte truncation.
  - `packages/coding-agent/src/config/settings-schema.ts` — default context lines.
  - `packages/coding-agent/src/backend/types.ts` — `GrepHit` and grep-summary iterator contract.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | `string` | Yes | Regex pattern. `search.ts` trims it and rejects empty input. The native matcher enables multiline only when the pattern text contains a literal newline or the two-character sequence `\\n`. The model prompt explicitly documents literal-brace escaping such as ``interface\\{\\}``, although the native layer also auto-escapes braces that cannot be valid repetition quantifiers. |
| `paths` | `string[]` | Yes | One or more file paths, directory paths, glob-like paths, or internal URLs. Empty strings are rejected after trimming/quote stripping. Internal URLs must resolve to a backing file and cannot contain glob characters. |
| `i` | `boolean` | No | Case-insensitive search. Defaults to `false`. Passed to native `ignoreCase`. |
| `gitignore` | `boolean` | No | Respect `.gitignore` during directory scans and glob expansion. Defaults to `true`. |
| `skip` | `number` | No | Global match offset. Defaults to `0`. `search.ts` floors finite numbers and rejects negative or non-finite values. |

## Outputs
The tool returns a single text block in `content[0].text` plus structured `details`.

- Match lines are formatted by `formatMatchLine()` as `*<anchor>|<line>` for matches and ` <anchor>|<line>` for context.
  - Hashline mode: `*5th|content`, ` 9x}|content`.
  - Plain mode: `*5|content`, ` 9|content`.
- Directory results are grouped by file, with `# <path>` headings and blank lines between groups.
- `details` may include:
  - `scopePath` — formatted search scope.
  - `matchCount`, `fileCount`, `files`, `fileMatches` — counts for the returned page, not necessarily total corpus counts.
  - `matchLimitReached` — visible-page limit hit (`100`).
  - `resultLimitReached` — backend preselection limit hit (`500` in the current wrapper).
  - `linesTruncated` — one or more matched lines were shortened to `1024` chars plus `…`.
  - `truncated` and `meta.truncation` — final text output was head-truncated by `truncateHead()`.
  - `displayContent` — TUI-only rendering text with `│` gutters instead of model anchors.
  - `missingPaths` — multi-path entries skipped because their base path did not exist.
- No-match result text is `No matches found`, optionally followed by `Skipped missing paths: ...`.

## Flow
1. `SearchTool.execute()` validates and normalizes input in `packages/coding-agent/src/tools/search.ts`:
   - trims `pattern`, rejects empty patterns;
   - normalizes `skip` to a non-negative integer;
   - reads asymmetric `search.contextBefore` and `search.contextAfter` settings (`1` and `3` by default);
   - enables multiline only when `pattern` contains `\n` or an actual newline.
2. Each `paths` entry is normalized with `normalizePathLikeInput()`.
3. Internal URLs are resolved through `session.internalRouter`:
   - glob metacharacters (`*`, `?`, `[`, `{`) are rejected for internal URLs;
   - URLs without `resource.sourcePath` fail;
   - immutable sources are tracked so output can suppress editable hashline anchors per file.
4. For multi-path calls, `partitionExistingPaths()` skips only ENOENT entries. If every entry is missing, the tool errors.
5. Path resolution branches:
   - one entry: `parseSearchPath()` splits `basePath` and optional glob;
   - multiple entries: `resolveExplicitSearchPaths()` computes a common base directory, explicit-file set, glob union, or degenerate-root target list.
6. `search.ts` stats the resolved base path to decide file vs directory behavior, then builds grep plans:
   - explicit files become `{ path: dirname(file), allowed: Set([absoluteFile]) }` plans;
   - directory/glob targets expand globs first with `backend.fs.glob({ patterns, paths, includeHidden: true, types: ["file"], gitignore })`;
   - plain directories become one unrestricted grep plan.
7. For each plan, the tool streams `backend.fs.grep({ pattern, paths: [plan.path], ignoreCase, gitignore, multiline, contextBefore, contextAfter, maxMatches, signal })`.
8. JS merges grep hits into per-match windows with asymmetric context semantics:
   - up to `contextBefore` lines before each match;
   - up to `contextAfter` lines after each match;
   - nearby matches in the same file share the overlapping after/before region instead of duplicating it.
9. Backend completion summaries use the `{ type: "summary", limitReached, truncated? }` contract. The tool reads `limitReached` from that discriminator instead of treating arbitrary iterator return payloads as summaries.
10. JS output shaping then:
   - round-robins directory matches down to `100` visible matches so one file does not monopolize the page;
   - keeps the first `100` file matches for single-file searches;
   - formats lines through `formatMatchLine()` for the model and `formatCodeFrameLine()` for TUI;
   - records non-truncated matched/context lines into the session file-read cache with `recordSparse()`.
11. Final text is passed through `truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })`, so the effective cap is the default byte cap from `streaming-output.ts`, not the default line cap.
12. `toolResult()` attaches text plus limit/truncation metadata.

## Modes / Variants
1. **Single file path**
   - `backend.fs.grep(...)` searches one file.
   - Output is a flat list of match/context lines.
   - Visible limit is the first `100` matches after wrapper-side `skip` handling.
2. **Single directory path or single glob-like path**
   - `parseSearchPath()` may split the input into `path` + `glob`.
   - One `backend.fs.grep(...)` scan walks the directory tree with `gitignore` and `hidden:true`.
   - Wrapper-side `skip` handling is global across files after hits are merged.
   - JS round-robins the returned matches to `100` visible rows.
3. **Multiple explicit paths/globs**
   - `resolveExplicitSearchPaths()` collapses them into a common base and either a brace-union glob, an explicit file list, or per-target searches when the only common base is the filesystem root.
   - Missing entries are skipped non-fatally unless all are missing.
4. **Internal URL paths**
   - Supported only when the internal resource resolves to a real backing file.
   - No internal-URL globbing.
   - Immutable sources switch to the immutable display mode when formatting anchors.

## Side Effects
- Filesystem
  - Stats resolved search roots and input paths.
  - Reads matched files through `backend.fs.grep(...)`.
  - Records sparse matched/context lines into the session file-read cache via `getFileReadCache(...).recordSparse(...)`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Reads session settings for context defaults.
  - Uses `session.internalRouter` to resolve internal URLs.
  - Populates tool `details.meta` with truncation/limit metadata.
- Background work / cancellation
  - Wrapped in `untilAborted(signal, ...)` at the JS level.
  - The tool forwards `signal` into both `backend.fs.glob(...)` and `backend.fs.grep(...)`. There is no separate tool-level timeout knob.

## Limits & Caps
- Visible page limit: `100` matches (`DEFAULT_MATCH_LIMIT` in `packages/coding-agent/src/tools/search.ts`).
- Backend preselection limit: `500` matches in the current wrapper (`internalLimit = Math.min(DEFAULT_MATCH_LIMIT * 5, 2000)` in `packages/coding-agent/src/tools/search.ts`).
- Line truncation: `1024` characters per emitted line (`DEFAULT_MAX_COLUMN` in `packages/coding-agent/src/session/streaming-output.ts`). Backend grep marks truncated lines; JS reports `linesTruncated`.
- Final text truncation: `truncateHead()` default byte cap `50 * 1024` bytes (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`). `search.ts` overrides `maxLines` to `Number.MAX_SAFE_INTEGER`, so normal search output is byte-capped, not line-capped.
- Context defaults: `search.contextBefore = 1`, `search.contextAfter = 3` in `packages/coding-agent/src/config/settings-schema.ts`.
- Pagination: `skip` is a global match offset applied in the wrapper as matches are accumulated; backend grep receives a larger `maxMatches` budget rather than a native offset parameter.

## Errors
- `Pattern must not be empty` when trimmed `pattern` is empty.
- `Skip must be a non-negative number` for negative or non-finite `skip`.
- `` `paths` must contain non-empty paths or globs `` when any normalized path is empty.
- `Glob patterns are not supported for internal URLs: ...` for internal URL + glob metacharacters.
- `Cannot search internal URL without a backing file: ...` when the router resolves a virtual resource without `sourcePath`.
- `Path not found: ...` when the resolved base path is missing, or when every multi-path entry is missing.
- Regex compile failures bubble from backend grep as tool errors. `search.ts` has a special catch for messages beginning with `regex parse error`, then otherwise rethrows.
- Backend grep may continue past per-file open/search failures and still return surviving matches; `search.ts` does not add extra retry or recovery logic on top.

## Notes
- The model-facing prompt documents standard regex syntax plus two search-specific rules: escape literal braces, and use `\n` or a literal newline for cross-line matching.
- Native `build_matcher()` already auto-escapes braces that cannot be valid quantifiers, so patterns like `${platform}` become searchable instead of failing. Valid quantifiers like `a{2,4}` remain unchanged.
- Native compile retry also escapes unescaped literal parentheses only after an unopened/unclosed-group parse error. It is a fallback, not a general parser mode.
- Internal URLs are resolved before path existence checks. After resolution, the native layer sees ordinary filesystem paths.
- `hidden:true` is hard-coded in `search.ts`; there is no model-facing flag to exclude dotfiles.
- `gitignore:false` affects both backend glob expansion and backend grep traversal. It does not disable the tool's own path normalization or explicit-file handling.
- When `paths` resolves to multiple exact files, `search.ts` does not apply the native `500` match cap and reports `totalMatches` internally as the post-skip length for that branch.
- The anchor suffix in hashline mode comes from `computeLineHash()` in `packages/coding-agent/src/hashline/hash.ts`; `search` itself only formats it.
