/**
 * Frame composition for the TUI: a pure function from TUI state and terminal size to a canvas. The driver (app.ts)
 * owns the terminal; everything here is testable without one.
 */

import { ATTRIBUTE_NAMES, SKILL_NAMES } from "../../mechanics/special.js";
import { ATTRIBUTES } from "../../payload/schema.js";
import type { Mode, ViewModel, ViewOf } from "../../session/port.js";
import { Canvas, type Rect, S, type Span, truncate, wrapSpans } from "./canvas.js";
import { drawMap, type MapView } from "./map.js";

/** One logical block of the scrollback, re-wrapped to the pane width on every frame. */
export interface Paragraph {
  spans: Span[];
  indent?: number;
}

export interface TuiState {
  title: string;
  log: Paragraph[];
  /** Lines scrolled back from the bottom of the log. */
  scroll: number;
  input: string;
  /** Cursor position in `input`, in code points. */
  cursor: number;
  busy: boolean;
  /** Animation frame for the busy spinner. */
  tick: number;
  mode: Mode;
  status?: ViewOf<"status">;
  sheet?: ViewOf<"sheet">;
  inventory?: ViewOf<"inventory">;
  map?: MapView;
  /** A one-line notice under the input (e.g. "press any key to quit"). */
  notice?: string;
}

export const MIN_COLS = 80;
export const MIN_ROWS = 24;
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function emptyState(title: string): TuiState {
  return { title, log: [], scroll: 0, input: "", cursor: 0, busy: false, tick: 0, mode: "explore" };
}

// ─── View models → scrollback ─────────────────────────────────────────────────

/** Turns session output into scrollback paragraphs. Status views feed the sidebar instead. */
export function toParagraphs(views: readonly ViewModel[]): Paragraph[] {
  const out: Paragraph[] = [];
  const p = (spans: Span[], indent?: number) => out.push(indent ? { spans, indent } : { spans });
  const blank = () => {
    if (out.length && out[out.length - 1]!.spans.length) p([]);
  };
  for (const v of views) {
    switch (v.type) {
      case "narration":
        switch (v.kind) {
          case "speech":
            p([{ text: `${v.speaker ?? ""}: `, sgr: S.boldCyan }, { text: `“${v.text}”` }]);
            break;
          case "system":
          case "check":
            p([{ text: v.text, sgr: S.grey }]);
            break;
          case "ambient":
            p([{ text: v.text, sgr: S.italic }]);
            break;
          case "combat":
            p([{ text: v.text, sgr: S.red }]);
            break;
          case "callout":
            p([{ text: v.text, sgr: S.magenta }], 2);
            break;
          case "journal":
            p([{ text: "Journal", sgr: S.yellow }]);
            p([{ text: v.text }], 2);
            break;
          case "ending":
            blank();
            p([{ text: v.text, sgr: S.bold }]);
            break;
          default:
            p([{ text: v.text }]);
        }
        break;
      case "room": {
        const r = v.room;
        blank();
        p([{ text: `━━ ${r.name} `, sgr: S.boldCyan }]);
        p([{ text: r.description }]);
        if (v.objective)
          p([
            { text: "Objective: ", sgr: S.boldYellow },
            { text: v.objective, sgr: S.yellow },
          ]);
        for (const o of r.objects) p([{ text: o }]);
        for (const x of r.people) p([{ text: x, sgr: S.cyan }]);
        if (r.exits.length) {
          const spans: Span[] = [{ text: "Exits: ", sgr: S.grey }];
          r.exits.forEach((x, i) => {
            if (i) spans.push({ text: ", ", sgr: S.grey });
            spans.push({ text: x.label, sgr: x.blocked ? S.grey : S.bold });
          });
          p(spans);
        }
        blank();
        break;
      }
      case "sheet": {
        p([{ text: v.name, sgr: S.bold }]);
        p(
          ATTRIBUTES.flatMap((a, i) => [
            ...(i ? [{ text: " · ", sgr: S.grey }] : []),
            { text: `${ATTRIBUTE_NAMES[a]} ` },
            { text: String(v.special[a]), sgr: attrSgr(v.special[a], v.base[a]) },
          ]),
        );
        p([
          {
            text: Object.entries(v.derived)
              .map(([n, x]) => `${n} ${x}`)
              .join(" · "),
            sgr: S.grey,
          },
        ]);
        p([
          {
            text: Object.entries(v.skills)
              .map(
                ([s, x]) =>
                  `${SKILL_NAMES[s as keyof typeof SKILL_NAMES]}${v.tags.includes(s as never) ? "*" : ""} ${x}%`,
              )
              .join(" · "),
          },
        ]);
        break;
      }
      case "inventory":
        p([
          {
            text: v.items.length
              ? `You are carrying: ${v.items.join(", ")}.${v.equipped.length ? ` Ready: ${v.equipped.join(", ")}.` : ""} Money: £${v.money}.`
              : `You are carrying nothing. Money: £${v.money}.`,
          },
        ]);
        break;
      case "journal":
        if (!v.entries.length) p([{ text: "Your journal is empty. Days are written up when you sleep.", sgr: S.grey }]);
        for (const e of v.entries) {
          p([{ text: `Day ${e.day}`, sgr: S.yellow }]);
          p([{ text: e.text }], 2);
        }
        break;
      case "conversation":
        blank();
        for (const o of v.options) p(option(o.index + 1, o.text), 2);
        break;
      case "combat": {
        blank();
        p([
          { text: `Round ${v.round}`, sgr: S.red },
          ...(v.yourTurn ? [{ text: ` · ${v.ap} AP left`, sgr: S.grey }] : []),
        ]);
        for (const x of v.combatants) {
          p(
            [
              { text: x.side === "a" ? "▲ " : "▼ ", sgr: x.side === "a" ? S.green : S.red },
              { text: `${x.name} ` },
              ...bar(x.hp, x.maxHp, 10),
              { text: ` ${x.hp}/${x.maxHp}${x.status !== "in" ? ` (${x.status})` : ""}`, sgr: S.grey },
            ],
            2,
          );
        }
        if (v.yourTurn) for (const [i, o] of v.options.entries()) p(option(i + 1, o.label), 2);
        break;
      }
      case "menu":
        for (const [i, o] of v.items.entries()) p(option(i + 1, o.label), 2);
        break;
      case "create":
        p([
          { text: "Create your character. ", sgr: S.bold },
          {
            text: `Every attribute starts at 5; you have ${v.points} more points; each stays within ${v.min}–${v.max}. Enter seven numbers for ST PE EN CH IN AG LK (totalling 40), or a preset:`,
          },
        ]);
        for (const pr of v.presets)
          p(
            [
              { text: `${pr.name}: `, sgr: S.boldCyan },
              { text: ATTRIBUTES.map((a) => `${a} ${pr.special[a]}`).join(" ") },
            ],
            2,
          );
        break;
      case "help":
        p([{ text: v.text, sgr: S.grey }]);
        break;
      case "ended":
        blank();
        p([{ text: `— ${v.title ?? "The End"} —`, sgr: S.boldYellow }]);
        break;
      case "status":
      case "map":
        break;
    }
  }
  return out;
}

function option(n: number, text: string): Span[] {
  return [{ text: `${n}`, sgr: S.boldCyan }, { text: ". ", sgr: S.grey }, { text }];
}

function attrSgr(now: number, base: number): string {
  return now > base ? S.green : now < base ? S.red : S.bold;
}

/** A horizontal gauge: filled cells coloured by how full it is. */
export function bar(value: number, max: number, width: number, invert = false): Span[] {
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(frac * width);
  const health = invert ? 1 - frac : frac;
  const sgr = health > 0.6 ? S.green : health > 0.3 ? S.yellow : S.red;
  return [
    { text: "█".repeat(filled), sgr },
    { text: "░".repeat(width - filled), sgr: S.grey },
  ];
}

// ─── Layout ──────────────────────────────────────────────────────────────────

export interface Frame {
  canvas: Canvas;
  /** Where the terminal cursor belongs (the input caret), or null to hide it. */
  cursor: { x: number; y: number } | null;
  /** The furthest the log can scroll back, for clamping. */
  maxScroll: number;
  /** Log pane height in lines, for page-sized scrolling. */
  page: number;
}

export function compose(st: TuiState, cols: number, rows: number): Frame {
  const cv = new Canvas(cols, rows);
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    const msg = `Make the terminal at least ${MIN_COLS}×${MIN_ROWS} (it is ${cols}×${rows}).`;
    cv.block(0, 0, wrapSpans([{ text: msg, sgr: S.yellow }], cols));
    return { canvas: cv, cursor: null, maxScroll: 0, page: 1 };
  }

  header(cv, st, cols);
  const sideW = cols >= 130 ? 46 : cols >= 105 ? 40 : 34;
  const mainH = rows - 1 - 3;
  const logRect: Rect = { x: 0, y: 1, w: cols - sideW, h: mainH };
  const sideRect: Rect = { x: cols - sideW, y: 1, w: sideW, h: mainH };
  const { maxScroll, page } = logPane(cv, st, logRect);
  sidebar(cv, st, sideRect);
  const cursor = inputBox(cv, st, { x: 0, y: rows - 3, w: cols, h: 3 });
  return { canvas: cv, cursor, maxScroll, page };
}

function header(cv: Canvas, st: TuiState, cols: number): void {
  cv.fill({ x: 0, y: 0, w: cols, h: 1 }, " ", S.header);
  const x = cv.text(1, 0, "◆ ", S.header);
  cv.text(x, 0, truncate(st.title, Math.floor(cols / 2)), S.header);
  const right: string[] = [];
  if (st.status) {
    right.push(st.status.clock);
    if (st.status.sneaking) right.push("sneaking");
  }
  right.push(st.mode.toUpperCase());
  const text = right.join("  ·  ");
  cv.text(cols - 1 - [...text].length, 0, text, S.headerDim);
}

function logPane(cv: Canvas, st: TuiState, r: Rect): { maxScroll: number; page: number } {
  const inner = { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 };
  const lines = st.log.flatMap((p) => wrapSpans(p.spans, inner.w, p.indent ?? 0));
  const maxScroll = Math.max(0, lines.length - inner.h);
  const scroll = Math.min(st.scroll, maxScroll);
  const end = lines.length - scroll;
  const shown = lines.slice(Math.max(0, end - inner.h), end);
  const title: Span[] = [{ text: "Story", sgr: S.boldCyan }];
  if (scroll > 0) title.push({ text: ` ↑ ${scroll} more below`, sgr: S.yellow });
  cv.box(r, "round", S.grey, title);
  cv.clip(inner, () => cv.block(inner.x, inner.y, shown));
  if (maxScroll > 0) {
    // A scrollbar on the right border.
    const track = inner.h;
    const thumb = Math.max(1, Math.round((track * inner.h) / lines.length));
    const top = Math.round(((maxScroll - scroll) / maxScroll) * (track - thumb));
    for (let i = 0; i < thumb; i++) cv.set(r.x + r.w - 1, inner.y + top + i, "┃", S.cyan);
  }
  return { maxScroll, page: inner.h };
}

function sidebar(cv: Canvas, st: TuiState, r: Rect): void {
  const charH = 7;
  const items = st.inventory?.items.length ?? 0;
  let invH = Math.max(4, Math.min(items + 2, 12));
  let mapH = r.h - charH - invH;
  if (mapH < 12) {
    invH = Math.max(3, invH - (12 - mapH));
    mapH = r.h - charH - invH;
  }
  mapBox(cv, st, { x: r.x, y: r.y, w: r.w, h: mapH });
  characterBox(cv, st, { x: r.x, y: r.y + mapH, w: r.w, h: charH });
  inventoryBox(cv, st, { x: r.x, y: r.y + mapH + charH, w: r.w, h: invH });
}

function mapBox(cv: Canvas, st: TuiState, r: Rect): void {
  const here = st.map?.rooms.find((x) => x.id === st.map?.here);
  cv.box(r, "round", S.grey, [{ text: "Map", sgr: S.boldCyan }, ...(here ? [{ text: ` · ${here.name}` }] : [])]);
  if (!st.map) return;
  const inner = { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
  cv.clip(inner, () => drawMap(cv, inner, st.map!));
}

function characterBox(cv: Canvas, st: TuiState, r: Rect): void {
  const s = st.status;
  const sh = st.sheet;
  cv.box(r, "round", S.grey, [{ text: sh?.name ?? "Character", sgr: S.boldCyan }]);
  if (!s || !sh) return;
  const inner = { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 };
  const barW = Math.max(6, inner.w - 14);
  const rows: Span[][] = [
    [{ text: "HP    " }, ...bar(s.hp, s.maxHp, barW), { text: ` ${s.hp}/${s.maxHp}`.padStart(7), sgr: S.grey }],
    [
      { text: "Awake " },
      ...bar(s.awakeHours, s.wakingHours, barW, true),
      { text: ` ${s.awakeHours}/${s.wakingHours}h`.padStart(7), sgr: S.grey },
    ],
    [
      { text: `L${s.level}`, sgr: S.bold },
      { text: ` ${s.xp} XP`, sgr: S.grey },
      { text: "  £", sgr: S.yellow },
      { text: String(s.money), sgr: S.boldYellow },
      { text: `  AP ${sh.derived.AP ?? "?"}  AC ${sh.derived.AC ?? "?"}`, sgr: S.grey },
      ...(s.unspentSkillPoints ? [{ text: `  +${s.unspentSkillPoints} SP`, sgr: S.boldYellow }] : []),
    ],
    attrRow(sh, ATTRIBUTES.slice(0, 4)),
    attrRow(sh, ATTRIBUTES.slice(4)),
  ];
  cv.clip(inner, () => cv.block(inner.x, inner.y, rows));
}

function attrRow(sh: ViewOf<"sheet">, attrs: readonly (typeof ATTRIBUTES)[number][]): Span[] {
  return attrs.flatMap((a) => [
    { text: `${a} `, sgr: S.grey },
    { text: String(sh.special[a]).padEnd(4), sgr: attrSgr(sh.special[a], sh.base[a]) },
  ]);
}

function inventoryBox(cv: Canvas, st: TuiState, r: Rect): void {
  const inv = st.inventory;
  cv.box(r, "round", S.grey, [{ text: "Inventory", sgr: S.boldCyan }]);
  if (!inv) return;
  const inner = { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 };
  const ready = new Set(inv.equipped);
  const rows: Span[][] = inv.items.length
    ? inv.items.map((name) =>
        ready.has(name)
          ? [
              { text: "◆ ", sgr: S.yellow },
              { text: truncate(name, inner.w - 10), sgr: S.bold },
              { text: " (ready)", sgr: S.grey },
            ]
          : [{ text: "• ", sgr: S.grey }, { text: truncate(name, inner.w - 2) }],
      )
    : [[{ text: "Nothing.", sgr: S.grey }]];
  if (rows.length > inner.h) {
    const more = rows.length - inner.h + 1;
    rows.splice(inner.h - 1, rows.length, [{ text: `… ${more} more (type i)`, sgr: S.grey }]);
  }
  cv.clip(inner, () => cv.block(inner.x, inner.y, rows));
}

function inputBox(cv: Canvas, st: TuiState, r: Rect): { x: number; y: number } | null {
  const title: Span[] = st.busy
    ? [{ text: `${SPINNER[st.tick % SPINNER.length]} thinking…`, sgr: S.yellow }]
    : [{ text: hint(st.mode), sgr: S.grey }];
  cv.box(r, "round", st.busy ? S.yellow : S.cyan, title);
  const help = st.notice ?? "PgUp/PgDn scroll · ↑/↓ history · Ctrl+C quit";
  const hx = r.x + r.w - 2 - [...help].length - 2;
  if (hx > r.x + 30) cv.text(hx, r.y + r.h - 1, ` ${help} `, st.notice ? S.boldYellow : S.grey);
  const px = cv.text(r.x + 2, r.y + 1, "› ", S.boldCyan);
  const width = r.w - (px - r.x) - 2;
  const chars = [...st.input];
  // Keep the caret in view when the input is longer than the box.
  const start = Math.max(0, st.cursor - width + 1);
  cv.clip({ x: px, y: r.y + 1, w: width, h: 1 }, () => cv.text(px, r.y + 1, chars.slice(start).join("")));
  return st.busy || st.notice ? null : { x: px + st.cursor - start, y: r.y + 1 };
}

function hint(mode: Mode): string {
  switch (mode) {
    case "conversation":
      return "Pick an option by number";
    case "combat":
      return "attack · use · flee · end — or a number";
    case "create":
      return "Seven numbers or a preset name";
    case "ended":
      return "The end";
    default:
      return "What do you do?";
  }
}
