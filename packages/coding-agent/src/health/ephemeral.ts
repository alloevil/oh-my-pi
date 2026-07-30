/**
 * Ephemeral (eval/tmp) session detection.
 *
 * Eval harnesses — the canary edit gate (per-task `TempDir` workdirs under
 * `os.tmpdir()`), e2e smoke runs (`/tmp/outbound-smoke`, `/tmp/stage-e2e`) —
 * persist sessions exactly like interactive use does. Nothing in the session
 * file marks them, so any measurement that counts sessions counts them too:
 * the 2026-07-28 candidate-detector measurements reported "corpus = 380
 * sessions" when only 11 were real usage (card
 * `2026-07-30-eval-session-contamination`). This module is the shared
 * predicate that keeps eval artifacts out of behavioral denominators.
 *
 * A session is ephemeral when it was RUN from an OS temp directory: the
 * recorded session-header cwd (authoritative when available) or, as a
 * fallback, the encoded sessions-dir folder name resolves under a temp root
 * (`os.tmpdir()`, `/tmp`, `/var/folders`, and their macOS `/private/...`
 * aliases). Path classification only — a legacy eval generation that ran
 * from a repo directory is invisible here and must be excluded by explicit
 * criterion in measurement scripts (see the incident ledger).
 */
import * as os from "node:os";
import * as path from "node:path";

/**
 * Strip the macOS `/private` prefix so `/private/tmp` and `/tmp` (a symlink
 * to it) compare equal without touching the filesystem: recorded header cwds
 * are raw `process.cwd()` values, encoded dir names use the resolved path.
 */
function canonicalizeTempAlias(p: string): string {
	return p.startsWith("/private/") ? p.slice("/private".length) : p;
}

/** Temp roots, canonicalized; `/tmp` and `/var/folders` cover the darwin idioms beyond `os.tmpdir()`. */
function tempRoots(): string[] {
	const roots = [canonicalizeTempAlias(path.resolve(os.tmpdir())), "/tmp", "/var/folders"];
	return roots.filter((root, index) => roots.indexOf(root) === index);
}

/** True when `cwd` (a raw recorded working directory) lies under an OS temp root. */
export function isEphemeralCwd(cwd: string): boolean {
	const canonical = canonicalizeTempAlias(path.resolve(cwd));
	return tempRoots().some(root => canonical === root || canonical.startsWith(root + path.sep));
}

/** Encode an absolute path the way legacy `--<encoded>--` session dir names do. */
function encodeLegacySegment(absolutePath: string): string {
	return absolutePath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
}

/**
 * True when an encoded sessions-dir folder name denotes a temp-root cwd.
 * Two encodings exist: the modern temp-relative form (`-tmp` / `-tmp-<rel>`,
 * relative to `os.tmpdir()`) and the legacy absolute form (`--<abs with /
 * replaced by ->--`, e.g. `/private/tmp/outbound-smoke` →
 * `--private-tmp-outbound-smoke--`). Fallback only — the header cwd is
 * authoritative when a session file is readable.
 */
export function isEphemeralSessionDirName(dirName: string): boolean {
	if (dirName === "-tmp" || dirName.startsWith("-tmp-")) return true;
	if (!dirName.startsWith("--") || !dirName.endsWith("--") || dirName.length < 5) return false;
	const encoded = dirName.slice(2, -2);
	const encodedRoots: string[] = [];
	for (const root of tempRoots()) {
		encodedRoots.push(encodeLegacySegment(root));
		encodedRoots.push(encodeLegacySegment(`/private${root}`));
	}
	return encodedRoots.some(root => encoded === root || encoded.startsWith(`${root}-`));
}

/**
 * Classify a session as ephemeral (produced by an eval/smoke run in a temp
 * workdir). Prefers the session-header cwd; falls back to the encoded
 * sessions-dir folder name when the header cwd is missing (old sessions
 * record an empty string).
 */
export function isEphemeralSession(input: { headerCwd?: string; sessionDirName?: string }): boolean {
	const cwd = input.headerCwd?.trim();
	if (cwd !== undefined && cwd !== "") return isEphemeralCwd(cwd);
	const dirName = input.sessionDirName?.trim();
	if (dirName !== undefined && dirName !== "") return isEphemeralSessionDirName(dirName);
	return false;
}
