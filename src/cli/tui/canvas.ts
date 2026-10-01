/**
 * A character-cell canvas for the TUI. Everything is drawn into cells (one code point, one SGR style each) and
 * serialised once per frame, so layout never has to measure strings that already carry escape codes.
 */

/** An SGR parameter string, e.g. "1;36" for bold cyan. Empty for the terminal default. */
export type Sgr = string;

export interface Span {
  text: string;
  sgr?: Sgr;
}

interface Cell {
  ch: string;
  sgr: Sgr;
}

export const S = {
  none: "",
  bold: "1",
  dim: "2",
  italic: "3",
  inverse: "7",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  grey: "90",
  boldCyan: "1;36",
  boldYellow: "1;33",
  boldWhite: "1;97",
  header: "1;97;44",
  headerDim: "97;44",
} as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BOX = {
  light: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  dashed: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "┄", v: "┆" },
} as const;
export type BoxStyle = keyof typeof BOX;

export class Canvas {
  private readonly cells: Cell[][];
  /** Drawing is clipped to this rectangle (the whole canvas unless narrowed with `clip`). */
  private bounds: Rect;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: " ", sgr: "" })));
    this.bounds = { x: 0, y: 0, w, h };
  }

  /** Runs `draw` with drawing clipped to `r` (intersected with the current clip). */
  clip(r: Rect, draw: () => void): void {
    const prev = this.bounds;
    const x = Math.max(prev.x, r.x);
    const y = Math.max(prev.y, r.y);
    const x2 = Math.min(prev.x + prev.w, r.x + r.w);
    const y2 = Math.min(prev.y + prev.h, r.y + r.h);
    this.bounds = { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
    try {
      draw();
    } finally {
      this.bounds = prev;
    }
  }

  set(x: number, y: number, ch: string, sgr: Sgr = ""): void {
    const b = this.bounds;
    if (x < b.x || y < b.y || x >= b.x + b.w || y >= b.y + b.h) return;
    this.cells[y]![x] = { ch, sgr };
  }

  /** Writes text from (x, y), one cell per code point; returns the x after the last cell. */
  text(x: number, y: number, text: string, sgr: Sgr = ""): number {
    for (const ch of text) this.set(x++, y, ch, sgr);
    return x;
  }

  spans(x: number, y: number, spans: readonly Span[]): number {
    for (const s of spans) x = this.text(x, y, s.text, s.sgr);
    return x;
  }

  /** Writes span lines downwards from (x, y). */
  block(x: number, y: number, lines: readonly (readonly Span[])[]): void {
    lines.forEach((l, i) => {
      this.spans(x, y + i, l);
    });
  }

  fill(r: Rect, ch = " ", sgr: Sgr = ""): void {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.set(x, y, ch, sgr);
  }

  /** A box around `r`, with an optional title set into the top border. */
  box(r: Rect, style: BoxStyle = "round", sgr: Sgr = S.grey, title?: readonly Span[]): void {
    if (r.w < 2 || r.h < 2) return;
    const b = BOX[style];
    const right = r.x + r.w - 1;
    const bottom = r.y + r.h - 1;
    for (let x = r.x + 1; x < right; x++) {
      this.set(x, r.y, b.h, sgr);
      this.set(x, bottom, b.h, sgr);
    }
    for (let y = r.y + 1; y < bottom; y++) {
      this.set(r.x, y, b.v, sgr);
      this.set(right, y, b.v, sgr);
    }
    this.set(r.x, r.y, b.tl, sgr);
    this.set(right, r.y, b.tr, sgr);
    this.set(r.x, bottom, b.bl, sgr);
    this.set(right, bottom, b.br, sgr);
    if (title?.length && r.w > 6) {
      this.clip({ x: r.x + 1, y: r.y, w: r.w - 3, h: 1 }, () => {
        const x = this.text(r.x + 2, r.y, " ", sgr);
        this.text(this.spans(x, r.y, title), r.y, " ", sgr);
      });
    }
  }

  /** The frame as lines with SGR codes (or plain text when `color` is false). */
  lines(color = true): string[] {
    return this.cells.map((row) => {
      let out = "";
      let cur = "";
      for (const c of row) {
        if (color && c.sgr !== cur) {
          out += c.sgr ? `\x1b[0;${c.sgr}m` : "\x1b[0m";
          cur = c.sgr;
        }
        out += c.ch;
      }
      return color && cur ? `${out}\x1b[0m` : out;
    });
  }
}

/** Shortens `text` to `width` cells, ending in an ellipsis when cut. */
export function truncate(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  if (width <= 0) return "";
  return `${chars.slice(0, width - 1).join("")}…`;
}

/** Word-wraps styled spans to `width` cells. Newlines in the text force breaks; `indent` prefixes every line. */
export function wrapSpans(spans: readonly Span[], width: number, indent = 0): Span[][] {
  const lines: Span[][] = [];
  const pad = indent > 0 ? [{ text: " ".repeat(indent) }] : [];
  const room = Math.max(1, width - indent);
  let line: Span[] = [];
  let used = 0;
  let pendingSpace: Span | null = null;
  const newline = () => {
    lines.push([...pad, ...line]);
    line = [];
    used = 0;
    pendingSpace = null;
  };
  const push = (text: string, sgr: Sgr | undefined) => {
    const last = line[line.length - 1];
    if (last && last.sgr === sgr) last.text += text;
    else line.push(sgr ? { text, sgr } : { text });
  };
  for (const s of spans) {
    for (const part of s.text.split(/(\n|[ \t]+)/)) {
      if (!part) continue;
      if (part === "\n") {
        newline();
        continue;
      }
      if (/^[ \t]+$/.test(part)) {
        if (used > 0) pendingSpace = s.sgr ? { text: " ", sgr: s.sgr } : { text: " " };
        continue;
      }
      let word = [...part];
      const space = pendingSpace as Span | null;
      if (used > 0 && used + (space ? 1 : 0) + word.length > room) newline();
      else if (space && used > 0) {
        push(" ", space.sgr);
        used += 1;
      }
      pendingSpace = null;
      while (word.length > room - used) {
        // A word longer than a whole line: hard-split it.
        const take = room - used;
        push(word.slice(0, take).join(""), s.sgr);
        word = word.slice(take);
        newline();
      }
      if (word.length) {
        push(word.join(""), s.sgr);
        used += word.length;
      }
    }
  }
  if (line.length || lines.length === 0) newline();
  return lines;
}
