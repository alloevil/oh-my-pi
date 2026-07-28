import { beforeAll, describe, expect, test } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui";
import { ThinkingBlockComponent } from "../src/modes/components/thinking-block";
import { getMarkdownTheme, setTheme, theme } from "../src/modes/theme/theme";

/**
 * Thinking traces are rendered by attenuating the markdown theme's own colours
 * rather than overriding them, so the block recedes while keeping the hierarchy
 * the model wrote. These tests assert that hierarchy from the emitted ANSI —
 * the only ground truth for "is the heading still a heading" — because the
 * previous rendering looked reasonable in a screenshot while having silently
 * flattened every heading to body grey.
 */

const SAMPLE = [
	"## Plan",
	"",
	"Weigh **cache** placement:",
	"",
	"- inside `SessionStore` — simple",
	"- at `ProviderBoundary` — isolated",
	"",
	"> note: `transformProviderContext` memoises already.",
	"",
	"Go with the second.",
].join("\n");

const WIDTH = 72;
const FG_RE = /38;2;(\d{1,3});(\d{1,3});(\d{1,3})/g;

type Rgb = readonly [number, number, number];

function foregrounds(line: string): Rgb[] {
	return [...line.matchAll(FG_RE)].map(m => [Number(m[1]), Number(m[2]), Number(m[3])] as Rgb);
}

function luma([r, g, b]: Rgb): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Hue in degrees, or -1 for achromatic colours (r == g == b). */
function hue([r, g, b]: Rgb): number {
	const [rn, gn, bn] = [r / 255, g / 255, b / 255];
	const max = Math.max(rn, gn, bn);
	const delta = max - Math.min(rn, gn, bn);
	if (delta < 0.02) return -1;
	let h: number;
	if (max === rn) h = ((gn - bn) / delta) % 6;
	else if (max === gn) h = (bn - rn) / delta + 2;
	else h = (rn - gn) / delta + 4;
	h *= 60;
	return h < 0 ? h + 360 : h;
}

function renderThinking(): readonly string[] {
	const block = new ThinkingBlockComponent(new Markdown(SAMPLE, 0, 0, getMarkdownTheme()));
	return block.render(WIDTH);
}

function renderProse(): readonly string[] {
	return new Markdown(SAMPLE, 1, 0, getMarkdownTheme(), undefined).render(WIDTH);
}

const contentful = (lines: readonly string[]): string[] => lines.filter(line => line.trim().length > 0);

describe("thinking block rendering", () => {
	beforeAll(async () => {
		await setTheme("dark");
	});

	test("heading keeps its semantic hue, attenuated rather than replaced", () => {
		const thinkingHeading = contentful(renderThinking())[0]!;
		const proseHeading = contentful(renderProse())[0]!;
		const proseHeadingFg = foregrounds(proseHeading)[0]!;
		// [rail, base, heading, base, …] — the heading colour is the first foreground
		// that is neither the (unshaded) rail nor the repeated base.
		const fgs = foregrounds(thinkingHeading);
		const headingFg = fgs.find((c, i) => i > 1 && c.join() !== fgs[1]!.join())!;

		expect(headingFg).toBeDefined();
		expect(Math.abs(hue(headingFg) - hue(proseHeadingFg))).toBeLessThanOrEqual(10);
		// The pre-fix rendering emitted the flat `thinkingText` role here instead.
		expect(headingFg.join()).not.toBe(theme.getColorHex("thinkingText"));
	});

	test("heading outranks body prose in brightness", () => {
		const lines = contentful(renderThinking());
		const bodyFg = foregrounds(lines[1]!)[1]!;
		const fgs = foregrounds(lines[0]!);
		const headingFg = fgs.find((c, i) => i > 1 && c.join() !== fgs[1]!.join())!;

		expect(luma(headingFg)).toBeGreaterThan(luma(bodyFg));
	});

	test("body prose is attenuated below unshaded prose", () => {
		const thinkingBodyFg = foregrounds(contentful(renderThinking())[1]!)[1]!;
		// Prose body carries no explicit foreground at all — it renders at the
		// terminal default, which is the brightest thing on screen.
		expect(luma(thinkingBodyFg)).toBeLessThan(luma([255, 255, 255]));
		expect(hue(thinkingBodyFg)).toBeLessThan(1);
	});

	test("inline code stays chromatically distinct from body prose", () => {
		const lines = contentful(renderThinking());
		const codeLine = lines.find(line => line.includes("SessionStore"))!;
		const fgs = foregrounds(codeLine);
		const bodyFg = fgs[1]!;
		const codeFg = fgs.find(c => hue(c) >= 0 && Math.abs(hue(c) - 40) > 15)!;

		expect(codeFg).toBeDefined();
		expect(hue(bodyFg)).toBeLessThan(0);
		expect(hue(codeFg)).toBeGreaterThanOrEqual(0);
	});

	test("every rendered row carries the aside rail", () => {
		const rail = theme.symbol("thinking.rail");
		for (const line of renderThinking()) expect(line).toContain(rail);
	});

	test("prose is no longer italicised; only markdown's own blockquote italics remain", () => {
		const quoteBorder = theme.symbol("md.quoteBorder");
		for (const line of contentful(renderThinking())) {
			if (line.includes(quoteBorder)) continue;
			expect(line).not.toContain("\x1b[3m");
		}
	});

	test("decoration is memoised while the inner markdown is unchanged", () => {
		const block = new ThinkingBlockComponent(new Markdown(SAMPLE, 0, 0, getMarkdownTheme()));
		const first = block.render(WIDTH);
		expect(block.render(WIDTH)).toBe(first);
		block.invalidate();
		expect(block.render(WIDTH)).not.toBe(first);
	});

	test("streaming target stays the inner markdown", () => {
		const md = new Markdown(SAMPLE, 0, 0, getMarkdownTheme());
		const block = new ThinkingBlockComponent(md);
		const before = block.render(WIDTH);
		md.setText(`${SAMPLE}\n\nAnd one more line.`);
		const after = block.render(WIDTH);

		expect(block.markdown).toBe(md);
		expect(after.length).toBeGreaterThan(before.length);
		expect(after.at(-1)).toContain("more line");
	});

	test("light theme attenuates toward the surface instead of away from it", async () => {
		await setTheme("light");
		try {
			const lightBodyFg = foregrounds(contentful(renderThinking())[1]!)[1]!;
			const lightText = theme.getColorHex("text");
			const textRgb: Rgb = [
				Number.parseInt(lightText.slice(1, 3), 16),
				Number.parseInt(lightText.slice(3, 5), 16),
				Number.parseInt(lightText.slice(5, 7), 16),
			];
			// Recessing on a bright surface means moving *up* in luma, toward the page.
			expect(luma(lightBodyFg)).toBeGreaterThan(luma(textRgb));
		} finally {
			await setTheme("dark");
		}
	});
});
