import { type Component, type Markdown, shadeAnsiForegrounds, visibleWidth } from "@oh-my-pi/pi-tui";
import { adjustHsv } from "@oh-my-pi/pi-utils";
import { theme } from "../theme/theme";

/**
 * How far a colour travels toward the surface it recesses into. Accents move
 * less than plain prose: they *are* the hierarchy, so they must stay above the
 * body they annotate (measured inversion when both used one factor: base luma
 * 166 vs shaded-heading luma 161).
 */
const ACCENT_RECESS = 0.32;
const BASE_RECESS = 0.46;
/** Saturation multiplier applied alongside the fade, so accents read as quieter. */
const ACCENT_DESATURATE = 0.72;

/** Left-edge aside marker. Two columns: rail plus separator space. */
const GUTTER_WIDTH = 2;

/**
 * A thinking trace rendered as a recessed aside.
 *
 * The inner {@link Markdown} is built with the *full* markdown theme — no
 * foreground override, no italic — so headings, bullets, inline code and quotes
 * keep their semantic colours. This wrapper then pushes the whole block back one
 * step and marks it as an aside with a muted rail instead of italics, which
 * monospace fonts synthesise by shearing glyphs and which costs CJK text most.
 *
 * Recessing is a fade toward the surface, not a multiplicative darkening: on a
 * light theme the body text is `#000000`, whose HSV value is 0 and therefore
 * immune to any multiplier — it can only recede by moving toward white.
 *
 * On 256-colour terminals there is no RGB foreground to rewrite, so the block
 * recesses with SGR 2 (faint) instead, keeping colour identity intact.
 *
 * The inner component stays the streaming target: callers hold the `Markdown`
 * and drive `setText`/`transientRenderCache` on it exactly as before.
 */
export class ThinkingBlockComponent implements Component {
	#cacheSource: readonly string[] | undefined;
	#cacheWidth = -1;
	#cacheResult: readonly string[] = [];
	/** Recessed colour per source colour, reset whenever the theme changes. */
	readonly #recessed = new Map<string, string>();
	#recessedForTheme: unknown;

	constructor(readonly markdown: Markdown) {}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - GUTTER_WIDTH);
		const source = this.markdown.render(innerWidth);
		// Markdown returns the same array reference while unchanged, so reference
		// identity is a sound (and free) memo key for the decoration pass.
		if (source === this.#cacheSource && this.#cacheWidth === width) return this.#cacheResult;

		if (this.#recessedForTheme !== theme) {
			this.#recessed.clear();
			this.#recessedForTheme = theme;
		}
		const truecolor = theme.getColorMode() === "truecolor";
		const rail = theme.fg("mdQuoteBorder", theme.symbol("thinking.rail"));
		// Plain prose carries no explicit foreground, so rewriting emitted colours
		// alone would leave body text at full terminal brightness while only the
		// accents receded. A recessed `text` role becomes the block's base
		// foreground, and markdown's own `ESC[39m` (revert to default) is rewritten
		// to that base so a coloured run hands the line back to the aside rather
		// than to the terminal default.
		const base = truecolor ? `\x1b[${sgrFg(this.#recess(theme.getColorHex("text"), BASE_RECESS))}m` : "";
		const shade = (hex: string): string => {
			const cached = this.#recessed.get(hex);
			if (cached !== undefined) return cached;
			const value = this.#recess(adjustHsv(hex, { s: ACCENT_DESATURATE }), ACCENT_RECESS);
			this.#recessed.set(hex, value);
			return value;
		};

		const decorated: string[] = [];
		for (const line of source) {
			if (visibleWidth(line) === 0) {
				decorated.push(rail);
				continue;
			}
			const body = truecolor
				? `${base}${shadeAnsiForegrounds(line, shade).replaceAll("\x1b[39m", base)}\x1b[39m`
				: faint(line);
			decorated.push(`${rail} ${body}`);
		}

		this.#cacheSource = source;
		this.#cacheWidth = width;
		this.#cacheResult = decorated;
		return decorated;
	}

	invalidate(): void {
		this.#cacheSource = undefined;
		this.#cacheWidth = -1;
		this.markdown.invalidate();
	}

	/** Fade `hex` toward the theme's surface (white on light themes, black on dark). */
	#recess(hex: string, amount: number): string {
		const target = theme.isLight ? 255 : 0;
		const channels: string[] = [];
		for (let i = 1; i < 7; i += 2) {
			const channel = Number.parseInt(hex.slice(i, i + 2), 16);
			channels.push(
				Math.round(channel + (target - channel) * amount)
					.toString(16)
					.padStart(2, "0"),
			);
		}
		return `#${channels.join("")}`;
	}
}

/**
 * Wrap a rendered line in SGR 2 (faint). Any reset the line already emits would
 * clear the attenuation, so faint is re-armed after every reset sequence.
 */
function faint(line: string): string {
	if (line.length === 0) return line;
	return `\x1b[2m${line.replaceAll("\x1b[0m", "\x1b[0m\x1b[2m").replaceAll("\x1b[22m", "\x1b[22m\x1b[2m")}\x1b[22m`;
}

/** `#rrggbb` → the SGR parameter list selecting it as a truecolor foreground. */
function sgrFg(hex: string): string {
	return `38;2;${Number.parseInt(hex.slice(1, 3), 16)};${Number.parseInt(hex.slice(3, 5), 16)};${Number.parseInt(hex.slice(5, 7), 16)}`;
}
