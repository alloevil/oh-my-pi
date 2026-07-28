import { describe, expect, test } from "bun:test";
import { shadeAnsiForegrounds } from "../src/utils";

/**
 * `shadeAnsiForegrounds` exists so a caller can recess an already-rendered block
 * without discarding the colours the renderer just chose. The contract is
 * narrow on purpose: truecolor foregrounds are rewritten, everything else in the
 * stream — backgrounds, indexed colours, decorations, text — is bit-preserved.
 */
describe("shadeAnsiForegrounds", () => {
	const toBlack = (): string => "#000000";

	test("rewrites every truecolor foreground in the line", () => {
		const line = "\x1b[38;2;254;188;56mheading\x1b[39m body \x1b[38;2;10;20;30mtail\x1b[39m";
		expect(shadeAnsiForegrounds(line, toBlack)).toBe(
			"\x1b[38;2;0;0;0mheading\x1b[39m body \x1b[38;2;0;0;0mtail\x1b[39m",
		);
	});

	test("passes the source colour to the transform as #rrggbb", () => {
		const seen: string[] = [];
		shadeAnsiForegrounds("\x1b[38;2;254;188;56mx\x1b[39m", hex => {
			seen.push(hex);
			return hex;
		});
		expect(seen).toEqual(["#febc38"]);
	});

	test("leaves backgrounds, indexed colours and decorations untouched", () => {
		const line = "\x1b[48;2;10;20;30m\x1b[38;5;213m\x1b[1m\x1b[3mstyled\x1b[0m";
		expect(shadeAnsiForegrounds(line, toBlack)).toBe(line);
	});

	test("is a no-op when the line carries no truecolor foreground", () => {
		const line = "plain \x1b[31mred\x1b[39m";
		expect(shadeAnsiForegrounds(line, toBlack)).toBe(line);
	});

	test("keeps the original run when the transform returns a non-colour", () => {
		const line = "\x1b[38;2;1;2;3mx\x1b[39m";
		expect(shadeAnsiForegrounds(line, () => "not-a-colour")).toBe(line);
		expect(shadeAnsiForegrounds(line, () => "#12345")).toBe(line);
	});

	test("ignores parameter runs that cannot be a colour", () => {
		// 999 is not a channel value; rewriting it would corrupt the sequence.
		const line = "\x1b[38;2;999;1;2mx\x1b[39m";
		expect(shadeAnsiForegrounds(line, toBlack)).toBe(line);
	});

	test("literal colour syntax in the text is left alone", () => {
		// A thinking trace may reason about ANSI itself; only real SGR sequences are
		// rewritten, so prose that merely looks like one survives verbatim.
		const line = "\x1b[38;2;5;5;5mliteral 38;2;7;7;7 inside text\x1b[39m";
		expect(shadeAnsiForegrounds(line, toBlack)).toBe("\x1b[38;2;0;0;0mliteral 38;2;7;7;7 inside text\x1b[39m");
	});

	test("rewrites a foreground carried in a compound parameter list", () => {
		const line = "\x1b[1;38;2;9;9;9;4mx\x1b[0m";
		expect(shadeAnsiForegrounds(line, toBlack)).toBe("\x1b[1;38;2;0;0;0;4mx\x1b[0m");
	});
});
