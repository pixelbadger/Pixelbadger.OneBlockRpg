/**
 * The native host's widget kit: panels, rules, styled and wrapped text, gauges, list rows and buttons, drawn on a
 * Canvas 2D (Skia) from the theme's tokens alone. Sizes are the theme's CSS pixels times `unit` (the display's pixel
 * ratio times the `ui.scale` setting). Everything clickable records a hit region, so a click maps back to input.
 */

import { css, type RGB } from "../../client/art.js";
import type { Canvas2D, Rect } from "../../client/canvas.js";
import type { PointerInput } from "../../client/input.js";
import { type Paragraph, type Span, type TextStyle, wrapSpans } from "../../client/text.js";
import { font, theme } from "../../client/theme.js";

/**
 * A clickable region and what a click there means: an input for the client, or `quit` for the host. With neither it
 * only stops clicks reaching what is under it.
 */
export interface Hit {
  rect: Rect;
  input?: PointerInput;
  quit?: true;
}

/** What a click on a widget does. */
export type Action = PointerInput | "quit";

/** A text size from the theme. */
export type Size = "size" | "small" | "large";

/** A run of text drawn in one look: a semantic style, or the selected row's colour. */
type Look = TextStyle | "selected";

export const inside = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/** Wrapped paragraphs, by width and size, so the log is wrapped once rather than every frame. */
const wrapped = new WeakMap<Paragraph, { key: string; lines: Span[][] }>();

export class Kit {
  /** Hit regions, topmost last. */
  readonly hits: Hit[] = [];

  constructor(
    readonly ctx: Canvas2D,
    readonly unit: number,
  ) {}

  /** CSS pixels to device pixels, whole. */
  px(n: number): number {
    return Math.round(n * this.unit);
  }

  /** The theme's spacing step `i`, in device pixels. */
  space(i: number): number {
    return this.px(theme.space[i] ?? 0);
  }

  /** The theme's border width in device pixels, at least one. */
  line(): number {
    return Math.max(1, this.px(theme.border));
  }

  /** Device pixels a size's text is drawn at. */
  fontPx(size: Size = "size"): number {
    return this.px(theme.font[size]);
  }

  lineHeight(size: Size = "size"): number {
    return Math.round(this.fontPx(size) * theme.font.lineHeight);
  }

  /** The width of one character (the font is monospace). */
  charWidth(size: Size = "size"): number {
    return this.measure("M", size);
  }

  /** The width of `text` in a size. */
  measure(text: string, size: Size = "size"): number {
    this.ctx.font = font(this.fontPx(size));
    return this.ctx.measureText(text).width;
  }

  hit(rect: Rect, action?: Action): void {
    this.hits.push(action === "quit" ? { rect, quit: true } : action ? { rect, input: action } : { rect });
  }

  /** The topmost hit region under (x, y). */
  hitAt(x: number, y: number): Hit | undefined {
    for (let i = this.hits.length - 1; i >= 0; i--) if (inside(this.hits[i]!.rect, x, y)) return this.hits[i];
    return undefined;
  }

  fill(r: Rect, c: RGB, alpha = 1): void {
    this.ctx.fillStyle = css(c, alpha);
    this.ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  /** A frame of the border's width, inside `r`. */
  outline(r: Rect, c: RGB = theme.colours.border): void {
    const t = this.line();
    this.fill({ x: r.x, y: r.y, w: r.w, h: t }, c);
    this.fill({ x: r.x, y: r.y + r.h - t, w: r.w, h: t }, c);
    this.fill({ x: r.x, y: r.y, w: t, h: r.h }, c);
    this.fill({ x: r.x + r.w - t, y: r.y, w: t, h: r.h }, c);
  }

  /** A horizontal rule `w` wide at `y`. */
  rule(x: number, y: number, w: number): void {
    this.fill({ x, y, w, h: this.line() }, theme.colours.border);
  }

  /** A panel: filled and framed. Returns its content rect inside a padding of spacing step `pad`. */
  panel(r: Rect, o: { fill?: RGB; pad?: number } = {}): Rect {
    this.fill(r, o.fill ?? theme.colours.panel);
    this.outline(r);
    const p = this.space(o.pad ?? 2);
    return { x: r.x + p, y: r.y + p, w: Math.max(0, r.w - 2 * p), h: Math.max(0, r.h - 2 * p) };
  }

  /** One line of spans from (x, top of the line), clipped to `maxW`. Returns the width drawn. */
  spans(spans: readonly Span[], x: number, y: number, o: { size?: Size; maxW?: number; look?: Look } = {}): number {
    const ctx = this.ctx;
    const size = o.size ?? "size";
    const lh = this.lineHeight(size);
    ctx.save();
    if (o.maxW !== undefined) {
      ctx.beginPath();
      ctx.rect(x, y, Math.max(0, o.maxW), lh);
      ctx.clip();
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    let at = x;
    for (const s of spans) {
      const look = theme.styles[s.style];
      ctx.font = font(this.fontPx(size), look);
      ctx.fillStyle = css(o.look === "selected" ? theme.colours.selectionText : look.colour);
      ctx.fillText(s.text, at, y + lh / 2);
      at += ctx.measureText(s.text).width;
    }
    ctx.restore();
    return at - x;
  }

  /** Text in one style. */
  text(text: string, x: number, y: number, style: TextStyle = "plain", o: { size?: Size; maxW?: number } = {}): number {
    return this.spans([{ text, style }], x, y, o);
  }

  /** A paragraph wrapped to `width`, its indent applied: lines of spans and the x offset they start at. */
  wrap(p: Paragraph, width: number, size: Size = "size"): { lines: Span[][]; indent: number } {
    const indent = (p.indent ?? 0) * this.charWidth(size);
    const w = Math.max(1, width - indent);
    const key = `${w}|${this.fontPx(size)}`;
    const hit = wrapped.get(p);
    if (hit?.key === key) return { lines: hit.lines, indent };
    this.ctx.font = font(this.fontPx(size));
    const lines = wrapSpans(p.spans, w, (s) => this.ctx.measureText(s).width);
    wrapped.set(p, { key, lines });
    return { lines, indent };
  }

  /** Every line of some paragraphs wrapped to `width`, each with its indent. */
  lines(paras: readonly Paragraph[], width: number, size: Size = "size"): { spans: Span[]; indent: number }[] {
    return paras.flatMap((p) => {
      const w = this.wrap(p, width, size);
      return w.lines.map((spans) => ({ spans, indent: w.indent }));
    });
  }

  /** Paragraphs in `r`, starting `offset` lines down (clamped so the last line ends the box). */
  paragraphs(paras: readonly Paragraph[], r: Rect, offset = 0, size: Size = "size"): void {
    const lines = this.lines(paras, r.w, size);
    const lh = this.lineHeight(size);
    const fit = Math.max(1, Math.floor(r.h / lh));
    const from = Math.max(0, Math.min(offset, lines.length - fit));
    lines.slice(from, from + fit).forEach((l, i) => {
      this.spans(l.spans, r.x + l.indent, r.y + i * lh, { size, maxW: r.w - l.indent });
    });
  }

  /** A gauge: a track, filled to value/max in `colour`. */
  bar(r: Rect, value: number, max: number, colour: RGB): void {
    this.fill(r, theme.bars.track);
    const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    if (frac > 0) this.fill({ ...r, w: Math.max(1, Math.round(r.w * frac)) }, colour);
  }

  /** A list row: filled in the selection colour when selected, clickable as `input`. */
  row(r: Rect, spans: readonly Span[], o: { selected?: boolean; input?: PointerInput } = {}): void {
    if (o.selected) this.fill(r, theme.colours.selection);
    const pad = this.space(1);
    this.spans(spans, r.x + pad, r.y + (r.h - this.lineHeight()) / 2, {
      maxW: r.w - 2 * pad,
      ...(o.selected ? { look: "selected" as const } : {}),
    });
    if (o.input) this.hit(r, o.input);
  }

  /** The size of the button `button` draws for `label`. */
  buttonSize(label: string): { w: number; h: number } {
    return {
      w: Math.ceil(this.measure(label, "small")) + 2 * this.space(2),
      h: this.lineHeight("small") + this.space(1),
    };
  }

  /** A framed button; greyed and inert when disabled. Returns its rect. */
  button(x: number, y: number, label: string, action: Action, enabled = true): Rect {
    const r = { x, y, ...this.buttonSize(label) };
    this.fill(r, theme.colours.panel);
    this.outline(r, enabled ? theme.colours.borderActive : theme.colours.border);
    this.text(label, r.x + this.space(2), r.y + this.space(1) / 2, enabled ? "plain" : "muted", { size: "small" });
    if (enabled) this.hit(r, action);
    return r;
  }
}
