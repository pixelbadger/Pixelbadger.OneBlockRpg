/**
 * The look, for every host: one monospace font, one dark palette in the manner of Ultima V (parchment text on night
 * blue, gold and cyan accents, stone-grey frames), spacing, and a colour per text style. The web host inlines
 * `themeCss()`; the native host paints from `theme` directly. Change the look here and both follow.
 */

import { css, type RGB } from "./art.js";
import { TEXT_STYLES, type TextStyle } from "./text.js";

export interface StyleLook {
  colour: RGB;
  bold?: boolean;
  italic?: boolean;
}

/** The font: JetBrains Mono (@fontsource/jetbrains-mono), with monospace fallbacks while it loads. */
export const FONT_FAMILY = "JetBrains Mono";
export const FONT_STACK = `"${FONT_FAMILY}", "DejaVu Sans Mono", Menlo, Consolas, ui-monospace, monospace`;

/**
 * The font files to load, relative to the `@fontsource/jetbrains-mono` package. The web imports the package's CSS
 * (`@fontsource/jetbrains-mono/{400,700,400-italic}.css`); the native host registers these with Skia under
 * FONT_FAMILY.
 */
export const FONT_FILES = [
  { weight: 400, style: "normal", file: "files/jetbrains-mono-latin-400-normal.woff2" },
  { weight: 700, style: "normal", file: "files/jetbrains-mono-latin-700-normal.woff2" },
  { weight: 400, style: "italic", file: "files/jetbrains-mono-latin-400-italic.woff2" },
] as const;

const colours = {
  /** Behind everything. */
  background: [11, 11, 20],
  /** A panel's fill. */
  panel: [20, 20, 34],
  /** A floating box (menu, sheet, introduction) over the scene. */
  overlay: [26, 24, 40],
  /** What dims the scene under an overlay (drawn at `scrimAlpha`). */
  scrim: [0, 0, 0],
  border: [86, 82, 104],
  /** The border of the panel in focus, and of the scene in a fight it turns `danger`. */
  borderActive: [196, 160, 72],
  text: [222, 212, 186],
  muted: [138, 132, 120],
  gold: [226, 184, 80],
  cyan: [108, 196, 214],
  red: [222, 92, 74],
  green: [118, 192, 96],
  magenta: [196, 124, 214],
  /** The selected menu row. */
  selection: [196, 160, 72],
  selectionText: [16, 14, 22],
} satisfies Record<string, RGB>;

const styles: Record<TextStyle, StyleLook> = {
  plain: { colour: colours.text },
  muted: { colour: colours.muted },
  strong: { colour: [240, 232, 210], bold: true },
  emphasis: { colour: colours.text, italic: true },
  title: { colour: colours.cyan, bold: true },
  heading: { colour: colours.gold, bold: true },
  subheading: { colour: colours.cyan, bold: true },
  quote: { colour: [200, 192, 170], italic: true },
  speaker: { colour: colours.cyan, bold: true },
  speech: { colour: [236, 228, 204] },
  ambient: { colour: [170, 166, 190], italic: true },
  person: { colour: colours.cyan },
  objective: { colour: colours.gold },
  callout: { colour: colours.magenta },
  choice: { colour: colours.cyan, bold: true },
  danger: { colour: colours.red },
  good: { colour: colours.green },
  warning: { colour: colours.gold, bold: true },
};

export const theme = {
  font: {
    family: FONT_FAMILY,
    stack: FONT_STACK,
    /** Body text, in CSS pixels. */
    size: 15,
    /** Status lines, hints, the footer. */
    small: 13,
    /** Panel and overlay titles. */
    large: 18,
    /** Line height as a multiple of the size. */
    lineHeight: 1.45,
  },
  /** Spacing steps in CSS pixels: `space[2]` is the usual padding. */
  space: [0, 4, 8, 12, 16, 24, 32],
  /** Panel border width and corner radius, in CSS pixels (square and chunky, like the old games). */
  border: 2,
  radius: 2,
  scrimAlpha: 0.55,
  colours,
  styles,
  /** Gauge fills by how full they are (text.ts gaugeStyle), and their empty track. */
  bars: {
    good: colours.green,
    warning: colours.gold,
    danger: colours.red,
    track: [44, 42, 58] as RGB,
    ap: colours.cyan,
  },
};

/** A Canvas 2D / CSS font shorthand in the theme's family, e.g. `bold 15px "JetBrains Mono", …`. */
export function font(px: number, o: { bold?: boolean; italic?: boolean } = {}): string {
  return `${o.italic ? "italic " : ""}${o.bold ? "bold " : ""}${px}px ${FONT_STACK}`;
}

/** The theme as CSS: custom properties on `:root` (`--ob-*`) and a `.style-<name>` class per text style. */
export function themeCss(): string {
  const vars = [
    `--ob-font: ${FONT_STACK}`,
    `--ob-size: ${theme.font.size}px`,
    `--ob-size-small: ${theme.font.small}px`,
    `--ob-size-large: ${theme.font.large}px`,
    `--ob-line: ${theme.font.lineHeight}`,
    `--ob-border-width: ${theme.border}px`,
    `--ob-radius: ${theme.radius}px`,
    `--ob-scrim: ${css(colours.scrim, theme.scrimAlpha)}`,
    ...theme.space.map((s, i) => `--ob-space-${i}: ${s}px`),
    ...Object.entries(colours).map(([k, c]) => `--ob-${kebab(k)}: ${css(c)}`),
    ...Object.entries(theme.bars).map(([k, c]) => `--ob-bar-${k}: ${css(c)}`),
    ...TEXT_STYLES.map((s) => `--ob-style-${s}: ${css(styles[s].colour)}`),
  ];
  const classes = TEXT_STYLES.map((s) => {
    const l = styles[s];
    const rules = [`color: var(--ob-style-${s})`, `font-weight: ${l.bold ? 700 : 400}`];
    if (l.italic) rules.push("font-style: italic");
    return `.style-${s} { ${rules.join("; ")}; }`;
  });
  return [`:root {\n${vars.map((v) => `  ${v};`).join("\n")}\n}`, ...classes].join("\n");
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
