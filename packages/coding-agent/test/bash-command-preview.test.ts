import { describe, expect, test } from "bun:test";
import { setTheme, theme } from "../src/modes/theme/theme";
import { formatBashCommandLines } from "../src/tools/bash";

/**
 * A heredoc body is data the command carries, not command structure. Rendered as
 * command lines it took the full preview budget (`previewWindowRows()`, i.e. the
 * viewport), so a 60-line PR body buried the `gh pr create` that consumed it.
 * These tests pin the collapse and, just as importantly, its inertness on
 * commands that carry no heredoc.
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
		expect(plain.some(line => line.includes("52 lines of heredoc body (MSG)"))).toBeTrue();
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
		expect(plain[1]).toContain("9 lines of heredoc body (MSG, still streaming)");
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
