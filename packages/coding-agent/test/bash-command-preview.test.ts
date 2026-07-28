import { describe, expect, test } from "bun:test";
import { setTheme, theme } from "../src/modes/theme/theme";
import { formatBashCommandLines } from "../src/tools/bash";

/**
 * A heredoc body is data the command carries, not shell source. Two consequences
 * these tests pin: it must be highlighted in its *own* language (highlighting a
 * markdown PR body as bash produced one undifferentiated run), and it must not
 * spend the whole preview budget (`previewWindowRows()`, i.e. the viewport) —
 * a 57-line body buried the `gh pr create` that consumed it. Inertness on
 * commands carrying no heredoc matters just as much.
 */

const PR_BODY_COMMAND = [
	"cd ~/Downloads/oh-my-pi && cat > /tmp/pr-body.md <<'MSG'",
	"## Problem",
	"",
	...Array.from({ length: 50 }, (_, i) => `body line ${i + 1}`),
	"MSG",
	"gh pr create --repo can1357/oh-my-pi --body-file /tmp/pr-body.md",
].join("\n");

const strip = (line: string): string => line.replaceAll(/\x1b\[[\d;:]*m/g, "");

describe("bash command preview", () => {
	test("collapses a long heredoc body but keeps the commands around it", async () => {
		await setTheme("dark");
		const lines = formatBashCommandLines({ command: PR_BODY_COMMAND }, theme);
		const plain = lines.map(strip);

		expect(lines.length).toBeLessThanOrEqual(8);
		expect(plain[0]).toContain("cat > /tmp/pr-body.md <<'MSG'");
		expect(plain.some(line => line.includes("52 lines of heredoc body (MSG, markdown)"))).toBeTrue();
		expect(plain.at(-2)).toBe("MSG");
		expect(plain.at(-1)).toContain("gh pr create");
		// The payload itself is gone from the collapsed view.
		expect(plain.some(line => line.includes("body line 20"))).toBeFalse();
	});

	test("expanded shows every payload line verbatim", async () => {
		await setTheme("dark");
		const lines = formatBashCommandLines({ command: PR_BODY_COMMAND }, theme, { expanded: true });
		const plain = lines.map(strip);

		expect(lines.length).toBe(PR_BODY_COMMAND.split("\n").length);
		expect(plain.some(line => line.includes("body line 20"))).toBeTrue();
		expect(plain.some(line => line.includes("heredoc body"))).toBeFalse();
	});

	test("is inert on a command with no heredoc", async () => {
		await setTheme("dark");
		const command = "grep -rn foo src \\\n  | sort -u \\\n  | head -20";
		const collapsed = formatBashCommandLines({ command }, theme);
		const expanded = formatBashCommandLines({ command }, theme, { expanded: true });

		expect(collapsed).toEqual(expanded);
	});

	test("leaves a body shorter than the threshold alone", async () => {
		await setTheme("dark");
		const command = ["cat <<EOF", "one", "two", "EOF"].join("\n");
		const plain = formatBashCommandLines({ command }, theme).map(strip);

		expect(plain).toEqual(["$ cat <<EOF", "one", "two", "EOF"]);
	});

	test("collapses an unterminated body while args still stream", async () => {
		await setTheme("dark");
		const command = ["cat > out.md <<'MSG'", ...Array.from({ length: 9 }, (_, i) => `line ${i}`)].join("\n");
		const plain = formatBashCommandLines({ command }, theme).map(strip);

		expect(plain[0]).toContain("cat > out.md <<'MSG'");
		expect(plain[1]).toContain("9 lines of heredoc body (MSG, markdown, still streaming)");
		expect(plain).toHaveLength(2);
	});

	test("honours <<- tab-stripped terminators", async () => {
		await setTheme("dark");
		const command = ["\tcat <<-EOF", "\tone", "\ttwo", "\tthree", "\tfour", "\tEOF", "echo done"].join("\n");
		const plain = formatBashCommandLines({ command }, theme).map(strip);

		expect(plain.some(line => line.includes("4 lines of heredoc body (EOF)"))).toBeTrue();
		expect(plain.at(-1)).toBe("echo done");
	});

	test("collapses each of several heredocs in one command", async () => {
		await setTheme("dark");
		const command = [
			"cat > a <<'A'",
			...Array.from({ length: 6 }, (_, i) => `a${i}`),
			"A",
			"cat > b <<'B'",
			...Array.from({ length: 7 }, (_, i) => `b${i}`),
			"B",
		].join("\n");
		const plain = formatBashCommandLines({ command }, theme).map(strip);

		expect(plain.some(line => line.includes("6 lines of heredoc body (A)"))).toBeTrue();
		expect(plain.some(line => line.includes("7 lines of heredoc body (B)"))).toBeTrue();
		expect(plain.some(line => line === "a3" || line === "b3")).toBeFalse();
	});
});

describe("heredoc payload language", () => {
	const fgCount = (line: string): number => [...line.matchAll(/\x1b\[38;2;/g)].length;

	test("markdown payload is highlighted as markdown, not as shell source", async () => {
		await setTheme("dark");
		const command = ["cat > notes.md <<'MSG'", "## Heading", "| a | b |", "MSG"].join("\n");
		const lines = formatBashCommandLines({ command }, theme, { expanded: true });

		// Structure carries colour: the ATX marker and the table pipes are tokens,
		// which is exactly what bash highlighting could not see.
		expect(fgCount(lines[1]!)).toBeGreaterThan(0);
		expect(fgCount(lines[2]!)).toBeGreaterThan(1);
		expect(strip(lines[1]!)).toBe("## Heading");
	});

	test("delimiter label selects the language when no redirect target exists", async () => {
		await setTheme("dark");
		const command = ["python3 - <<'PY'", "import json", "print(1)", "PY"].join("\n");
		const lines = formatBashCommandLines({ command }, theme, { expanded: true });

		expect(fgCount(lines[1]!)).toBeGreaterThan(0);
		expect(strip(lines[1]!)).toBe("import json");
	});

	test("redirect target wins over a conflicting delimiter label", async () => {
		await setTheme("dark");
		// `PY` claims python, the target claims markdown. A path is concrete evidence,
		// a label is a convention, so markdown must win — and the two grammars colour
		// this line differently (markdown tokenises `##`, python sees a comment).
		const payload = "## Heading";
		const viaTarget = formatBashCommandLines(
			{ command: ["cat > notes.md <<'PY'", payload, "PY"].join("\n") },
			theme,
			{ expanded: true },
		)[1]!;
		const viaLabel = formatBashCommandLines({ command: ["python3 - <<'PY'", payload, "PY"].join("\n") }, theme, {
			expanded: true,
		})[1]!;

		expect(strip(viaTarget)).toBe(payload);
		expect(viaTarget).not.toBe(viaLabel);
	});

	test("no colour bleeds from the shell into the payload", async () => {
		await setTheme("dark");
		// The bash highlighter reads everything after <<'DELIM' as an unterminated
		// string, so without a reset the payload inherits its colour.
		const command = ["cat > notes.md <<'MSG'", "plain text line", "MSG"].join("\n");
		const lines = formatBashCommandLines({ command }, theme, { expanded: true });

		expect(lines[0]!.endsWith("\x1b[0m")).toBeTrue();
	});

	test("unknown payload language renders muted rather than mis-highlighted", async () => {
		await setTheme("dark");
		const command = ["cat > payload.unknownext <<'ZZZ'", "some data", "ZZZ"].join("\n");
		const lines = formatBashCommandLines({ command }, theme, { expanded: true });

		expect(strip(lines[1]!)).toBe("some data");
		expect(lines[1]).not.toBe("some data");
	});

	test("summary names the payload language when one is known", async () => {
		await setTheme("dark");
		const command = ["cat > s.sql <<'EOF'", ...Array.from({ length: 5 }, (_, i) => `select ${i};`), "EOF"].join("\n");
		const plain = formatBashCommandLines({ command }, theme).map(strip);

		expect(plain.some(line => line.includes("5 lines of heredoc body (EOF, sql)"))).toBeTrue();
	});
});
