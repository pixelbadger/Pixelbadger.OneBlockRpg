/**
 * Screen layout for the tiled TUI, in the manner of Ultima V: the scene on the left, the message scroll beneath it,
 * and the party panel (character, pack, time or the fight) on the right. Menus and sheets float over the scene.
 */

import { ATTRIBUTE_NAMES } from "../../mechanics/special.js";
import { ATTRIBUTES } from "../../payload/schema.js";
import { Canvas, type Rect, S, type Span, truncate, wrapSpans } from "./canvas.js";
import { style } from "./color.js";
import { attrSgr, bar } from "./log.js";
import type { Image } from "./png.js";
import { rasterScene } from "./raster.js";
import { type AnimFrame, drawScene, viewport } from "./scene.js";
import type { SpriteSet } from "./sprites.js";
import type { Ui } from "./ui.js";

export const MIN_COLS = 80;
export const MIN_ROWS = 24;

export interface LayoutOptions {
  t: number;
  emoji: boolean;
  frame?: AnimFrame;
  /** Draw the scene as a picture from these sprites (the terminal shows images). */
  sprites?: SpriteSet;
}

export interface Frame {
  canvas: Canvas;
  /** Message pane height, for page-sized scrolling. */
  page: number;
  maxScroll: number;
  /** In image mode: the scene's picture and the cells it covers (punched out of the canvas). */
  picture?: { rect: Rect; draw: () => Image };
}

export function compose(ui: Ui, cols: number, rows: number, o: LayoutOptions): Frame {
  const cv = new Canvas(cols, rows);
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    cv.block(
      0,
      0,
      wrapSpans(
        [{ text: `Make the terminal at least ${MIN_COLS}×${MIN_ROWS} (it is ${cols}×${rows}).`, sgr: S.yellow }],
        cols,
      ),
    );
    return { canvas: cv, page: 1, maxScroll: 0 };
  }
  header(cv, ui, cols);
  const sideW = cols >= 140 ? 36 : 30;
  const leftW = cols - sideW;
  const msgH = Math.max(7, Math.min(12, Math.floor(rows * 0.3)));
  const sceneH = rows - 1 - msgH;
  const sceneRect: Rect = { x: 0, y: 1, w: leftW, h: sceneH };
  const msgRect: Rect = { x: 0, y: 1 + sceneH, w: leftW, h: msgH };
  const picture = sceneBox(cv, ui, sceneRect, o);
  const { page, maxScroll } = messages(cv, ui, msgRect);
  sidebar(cv, ui, { x: leftW, y: 1, w: sideW, h: rows - 1 });
  if (ui.menu) menuBox(cv, ui, sceneRect);
  if (ui.allot) allotBox(cv, ui, sceneRect);
  if (ui.overlay) overlayBox(cv, ui, sceneRect);
  return { canvas: cv, page, maxScroll, ...(picture ? { picture } : {}) };
}

function header(cv: Canvas, ui: Ui, cols: number): void {
  cv.fill({ x: 0, y: 0, w: cols, h: 1 }, " ", S.header);
  const x = cv.text(1, 0, "◆ ", S.header);
  cv.text(x, 0, truncate(ui.title, Math.floor(cols / 2)), S.header);
  const right: string[] = [];
  if (ui.status) {
    const m = ui.scene?.minute ?? 0;
    right.push(`${m >= 360 && m < 1260 ? "☀" : "☾"} ${ui.status.clock}`);
    if (ui.status.sneaking) right.push("sneaking");
  }
  right.push(ui.mode === "combat" ? "⚔ COMBAT" : ui.mode.toUpperCase());
  const text = right.join("  ·  ");
  cv.text(cols - 1 - [...text].length, 0, text, S.headerDim);
}

function sceneBox(cv: Canvas, ui: Ui, r: Rect, o: LayoutOptions): Frame["picture"] {
  const title: Span[] = [{ text: ui.scene?.name ?? ui.title, sgr: S.boldCyan }];
  cv.box(r, "round", ui.mode === "combat" ? S.red : S.grey, title);
  const inner = { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
  if (!ui.scene || ui.mode === "create") {
    const lines = wrapSpans([{ text: ui.title, sgr: S.boldYellow }], inner.w - 4);
    cv.block(inner.x + 2, inner.y + Math.floor(inner.h / 3), lines);
    return undefined;
  }
  if (o.sprites) {
    // Image mode: tiles at least 4 columns by 2 rows (roughly square) unless the view is very small.
    const scene = ui.scene;
    const sprites = o.sprites;
    const v = viewport(scene, inner, o.frame, inner.w >= 44 && inner.h >= 16 ? 2 : 1);
    const rect = { x: inner.x + v.padX, y: inner.y + v.padY, w: v.tilesW * 2 * v.s, h: v.tilesH * v.s };
    cv.fill(inner, " ", style(undefined, [8, 8, 10]));
    cv.punch(rect);
    const targeting = ui.targeting;
    const draw = () =>
      rasterScene(scene, sprites, v, {
        t: o.t,
        ...(o.frame ? { frame: o.frame } : {}),
        ...(targeting ? { cursor: targeting.cursor } : {}),
      });
    return { rect, draw };
  }
  drawScene(cv, inner, ui.scene, {
    t: o.t,
    emoji: o.emoji,
    ...(o.frame ? { frame: o.frame } : {}),
    ...(ui.targeting ? { cursor: ui.targeting.cursor } : {}),
  });
}

function messages(cv: Canvas, ui: Ui, r: Rect): { page: number; maxScroll: number } {
  const inner = { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 3 };
  const lines = ui.log.flatMap((p) => wrapSpans(p.spans, inner.w, p.indent ?? 0));
  const maxScroll = Math.max(0, lines.length - inner.h);
  const scroll = Math.min(ui.scroll, maxScroll);
  const end = lines.length - scroll;
  const shown = lines.slice(Math.max(0, end - inner.h), end);
  const title: Span[] = [{ text: "Messages", sgr: S.boldCyan }];
  if (scroll > 0) title.push({ text: ` ↑ ${scroll} more below`, sgr: S.yellow });
  cv.box(r, "round", S.grey, title);
  cv.clip(inner, () => cv.block(inner.x, inner.y, shown));
  // The prompt line.
  const py = r.y + r.h - 2;
  cv.clip({ x: r.x + 1, y: py, w: r.w - 2, h: 1 }, () => {
    const x = cv.text(r.x + 2, py, ui.busy ? "… " : "› ", ui.busy ? S.yellow : S.boldCyan);
    cv.text(x, py, ui.busy ? "thinking" : (ui.prompt ?? ""), ui.targeting ? S.boldYellow : S.grey);
  });
  return { page: inner.h, maxScroll };
}

function sidebar(cv: Canvas, ui: Ui, r: Rect): void {
  const charH = 9;
  const tailH = ui.mode === "combat" ? Math.max(6, Math.min(12, (ui.combat?.combatants.length ?? 0) + 3)) : 6;
  const packH = Math.max(4, r.h - charH - tailH);
  characterBox(cv, ui, { x: r.x, y: r.y, w: r.w, h: charH });
  packBox(cv, ui, { x: r.x, y: r.y + charH, w: r.w, h: packH });
  if (ui.mode === "combat") fightBox(cv, ui, { x: r.x, y: r.y + charH + packH, w: r.w, h: r.h - charH - packH });
  else hereBox(cv, ui, { x: r.x, y: r.y + charH + packH, w: r.w, h: r.h - charH - packH });
}

function characterBox(cv: Canvas, ui: Ui, r: Rect): void {
  const s = ui.status;
  const sh = ui.sheet;
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
      { text: `Level ${s.level}`, sgr: S.bold },
      { text: `  ${s.xp} XP`, sgr: S.grey },
      ...(s.unspentSkillPoints ? [{ text: `  +${s.unspentSkillPoints} (Z)`, sgr: S.boldYellow }] : []),
    ],
    [
      { text: "£", sgr: S.yellow },
      { text: String(s.money), sgr: S.boldYellow },
      { text: `   AP ${sh.derived.AP ?? "?"}   AC ${sh.derived.AC ?? "?"}`, sgr: S.grey },
    ],
    [],
    attrRow(sh, ATTRIBUTES.slice(0, 4)),
    attrRow(sh, ATTRIBUTES.slice(4)),
  ];
  cv.clip(inner, () => cv.block(inner.x, inner.y, rows));
}

function attrRow(sh: NonNullable<Ui["sheet"]>, attrs: readonly (typeof ATTRIBUTES)[number][]): Span[] {
  return attrs.flatMap((a) => [
    { text: `${a} `, sgr: S.grey },
    { text: String(sh.special[a]).padEnd(4), sgr: attrSgr(sh.special[a], sh.base[a]) },
  ]);
}

function packBox(cv: Canvas, ui: Ui, r: Rect): void {
  const inv = ui.inventory;
  cv.box(r, "round", S.grey, [{ text: "Pack", sgr: S.boldCyan }]);
  if (!inv) return;
  const inner = { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 };
  const entries = inv.entries ?? inv.items.map((name) => ({ id: name, name, equipped: inv.equipped.includes(name) }));
  const rows: Span[][] = entries.length
    ? entries.map((e) =>
        e.equipped
          ? [
              { text: "◆ ", sgr: S.yellow },
              { text: truncate(e.name, inner.w - 2), sgr: S.bold },
            ]
          : [{ text: "• ", sgr: S.grey }, { text: truncate(e.name, inner.w - 2) }],
      )
    : [[{ text: "Nothing.", sgr: S.grey }]];
  if (rows.length > inner.h) {
    const more = rows.length - inner.h + 1;
    rows.splice(inner.h - 1, rows.length, [{ text: `… ${more} more (I)`, sgr: S.grey }]);
  }
  cv.clip(inner, () => cv.block(inner.x, inner.y, rows));
}

function hereBox(cv: Canvas, ui: Ui, r: Rect): void {
  cv.box(r, "round", S.grey, [{ text: "Here", sgr: S.boldCyan }]);
  const inner = { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 };
  const people = (ui.scene?.things ?? []).filter((t) => t.kind === "character" && !t.player);
  const rows: Span[][] = people.length
    ? people.map((p) => [
        { text: p.status === "ok" ? "☺ " : p.status === "asleep" ? "z " : "✝ ", sgr: p.hostile ? S.red : S.cyan },
        { text: truncate(p.name, inner.w - 2), sgr: p.apparition ? S.italic : "" },
      ])
    : [[{ text: "Nobody else.", sgr: S.grey }]];
  cv.clip(inner, () => cv.block(inner.x, inner.y, rows));
}

function fightBox(cv: Canvas, ui: Ui, r: Rect): void {
  const c = ui.combat;
  cv.box(r, "round", S.red, [{ text: c ? `Round ${c.round}` : "Fight", sgr: S.red }]);
  if (!c) return;
  const inner = { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 };
  const rows: Span[][] = c.combatants.map((x) => [
    { text: x.side === "a" ? "▲ " : "▼ ", sgr: x.side === "a" ? S.green : S.red },
    { text: truncate(x.name, inner.w - 12).padEnd(inner.w - 12) },
    ...bar(x.hp, x.maxHp, 6),
    { text: x.status === "in" ? "" : ` ${x.status}`, sgr: S.grey },
  ]);
  if (c.yourTurn) rows.push([{ text: `${c.ap} AP left`, sgr: S.boldYellow }]);
  cv.clip(inner, () => cv.block(inner.x, inner.y, rows));
}

/** A floating box centred over `r`, sized to its contents. */
function floating(cv: Canvas, r: Rect, w: number, h: number, title: Span[], color = S.yellow): Rect {
  const bw = Math.min(r.w - 2, w + 4);
  const bh = Math.min(r.h - 2, h + 2);
  const box = { x: r.x + Math.floor((r.w - bw) / 2), y: r.y + Math.max(1, Math.floor((r.h - bh) / 2)), w: bw, h: bh };
  cv.fill(box, " ", "");
  cv.box(box, "double", color, title);
  return { x: box.x + 2, y: box.y + 1, w: box.w - 4, h: box.h - 2 };
}

function menuBox(cv: Canvas, ui: Ui, r: Rect): void {
  const m = ui.menu!;
  const labels = m.items.map(
    (it, i) => `${i < 9 ? `${i + 1}.` : "  "} ${it.label}${it.detail ? `  ${it.detail}` : ""}`,
  );
  const width = Math.min(r.w - 6, Math.max(24, ...labels.map((l) => [...l].length)));
  const lines: Span[][] = [];
  m.items.forEach((it, i) => {
    const sel = i === m.index;
    const head = i < 9 ? `${i + 1}.` : "  ";
    const wrapped = wrapSpans([{ text: it.label }], width - 4);
    wrapped.forEach((w, j) => {
      const text = w.map((s) => s.text).join("");
      lines.push([
        { text: j === 0 ? `${head} ` : "   ", sgr: sel ? S.inverse : S.boldCyan },
        { text: text.padEnd(width - 3), sgr: sel ? S.inverse : "" },
      ]);
    });
    if (it.detail) lines.push([{ text: `   ${truncate(it.detail, width - 3)}`, sgr: S.grey }]);
  });
  const inner = floating(cv, r, width, Math.min(lines.length, r.h - 4), [{ text: m.title, sgr: S.boldYellow }]);
  // Keep the selection in view.
  const selLine = lines.findIndex((l) => l[0]?.sgr === S.inverse);
  const start = Math.max(0, Math.min(selLine - Math.floor(inner.h / 2), lines.length - inner.h));
  cv.clip(inner, () => cv.block(inner.x, inner.y, lines.slice(start, start + inner.h)));
}

function allotBox(cv: Canvas, ui: Ui, r: Rect): void {
  const a = ui.allot!;
  const total = ATTRIBUTES.reduce((s, x) => s + a.special[x], 0);
  const lines: Span[][] = ATTRIBUTES.map((attr, i) => {
    const sel = i === a.index;
    return [
      { text: ` ${ATTRIBUTE_NAMES[attr].padEnd(13)}`, sgr: sel ? S.inverse : "" },
      { text: ` ◀ ${String(a.special[attr]).padStart(2)} ▶ `, sgr: sel ? S.boldYellow : S.bold },
      { text: "█".repeat(a.special[attr]), sgr: S.green },
    ];
  });
  lines.push([]);
  lines.push([{ text: `${40 - total} points left. ↑↓ choose · ←→ adjust · Enter done`, sgr: S.grey }]);
  const inner = floating(cv, r, 44, lines.length, [{ text: "Make your own", sgr: S.boldYellow }]);
  cv.clip(inner, () => cv.block(inner.x, inner.y, lines));
}

function overlayBox(cv: Canvas, ui: Ui, r: Rect): void {
  const o = ui.overlay!;
  const width = Math.min(r.w - 6, 72);
  const lines = o.lines.flatMap((p) => wrapSpans(p.spans, width, p.indent ?? 0));
  if (o.skills?.length) {
    lines.push([]);
    lines.push([{ text: "Spend skill points: ↑↓ choose, Enter raise", sgr: S.boldYellow }]);
    o.skills.forEach((s, i) => {
      lines.push([{ text: ` ${s.label}`.padEnd(width), sgr: i === (o.index ?? 0) ? S.inverse : "" }]);
    });
  }
  if (o.pages) {
    // Paged text reads from the top; the footer stays put while ↑↓ scroll a page too tall for the box.
    const n = o.pages.length;
    const at = o.page ?? 0;
    const footer: Span[] = [
      { text: n > 1 ? `${at + 1}/${n}  ` : "", sgr: S.grey },
      { text: at + 1 < n ? "Any key: next page · ← back · Esc skip" : "Any key to begin.", sgr: S.grey },
    ];
    const inner = floating(cv, r, width, Math.min(lines.length + 2, r.h - 4), [{ text: o.title, sgr: S.boldYellow }]);
    const room = Math.max(1, inner.h - 2);
    o.offset = Math.min(o.offset ?? 0, Math.max(0, lines.length - room));
    const shown = lines.slice(o.offset, o.offset + room);
    cv.clip(inner, () => cv.block(inner.x, inner.y, [...shown, ...Array(room - shown.length).fill([]), [], footer]));
    return;
  }
  lines.push([{ text: "Any key to close.", sgr: S.grey }]);
  const inner = floating(cv, r, width, Math.min(lines.length, r.h - 4), [{ text: o.title, sgr: S.boldYellow }]);
  cv.clip(inner, () => cv.block(inner.x, inner.y, lines.slice(Math.max(0, lines.length - inner.h))));
}
