/**
 * The native window's frame, from the presentation model, in the layout the web host shares (it draws the same with
 * HTML). Left, the scene over the message log; right, a column 34 characters wide with the title, the status and the
 * fight roster or the pack. Menus, sheets, the introduction, character creation and the ending float centred over
 * the scene.
 */

import type { RGB } from "../../client/art.js";
import type { Canvas2D, CanvasImage, Rect, Scratch } from "../../client/canvas.js";
import { ALLOT_TOTAL } from "../../client/controller.js";
import type { Model } from "../../client/model.js";
import { drawScene } from "../../client/scene.js";
import type { SpriteSheet } from "../../client/sprites.js";
import { gaugeStyle, markdownParagraphs, type Paragraph, type Span } from "../../client/text.js";
import { theme } from "../../client/theme.js";
import type { AnimFrame, SceneLayout } from "../../client/timeline.js";
import { ATTRIBUTE_NAMES } from "../../engine/mechanics/special.js";
import { ATTRIBUTES } from "../../engine/payload/schema.js";
import type { Action, Kit } from "./widgets.js";

/** The right column's width, in characters of the body font (plus its padding). */
export const SIDEBAR_CHARS = 34;
/** The message log's share of the window's height. */
export const LOG_SHARE = 0.3;
/** The widest a floating box grows, in characters. */
const BOX_CHARS = 80;

export interface HudOptions<I extends CanvasImage> {
  /** Animation time in ms. */
  t: number;
  scratch: Scratch<I>;
  sprites?: SpriteSheet<I>;
  frame?: AnimFrame;
  /** The biggest whole-number scale for the scene's art. */
  maxScale?: number;
}

export interface HudLayout {
  scene: Rect;
  log: Rect;
  sidebar: Rect;
  /** Where the scene's tiles landed, when there is a scene. */
  tiles?: SceneLayout;
}

const sp = (text: string, style: Span["style"] = "plain"): Span => ({ text, style });

/** Where everything goes in a window of `w`×`h` device pixels. */
export function hudLayout(kit: Kit, w: number, h: number): HudLayout {
  const g = kit.space(2);
  const side = Math.ceil(SIDEBAR_CHARS * kit.charWidth()) + 2 * kit.space(3);
  const left = Math.max(0, w - side - 3 * g);
  const logH = Math.round(h * LOG_SHARE);
  const scene = { x: g, y: g, w: left, h: Math.max(0, h - logH - 3 * g) };
  return {
    scene,
    log: { x: g, y: scene.y + scene.h + g, w: left, h: logH },
    sidebar: { x: w - g - side, y: g, w: side, h: Math.max(0, h - 2 * g) },
  };
}

/** Draws the whole frame. Hit regions go to `kit`; the returned layout says where the scene's tiles are. */
export function drawHud<I extends CanvasImage>(
  kit: Kit,
  ctx: Canvas2D<I>,
  m: Model,
  w: number,
  h: number,
  o: HudOptions<I>,
): HudLayout {
  const l = hudLayout(kit, w, h);
  kit.fill({ x: 0, y: 0, w, h }, theme.colours.background);

  // The scene, framed; red in a fight.
  kit.fill(l.scene, theme.colours.panel);
  if (m.scene && l.scene.w > 0 && l.scene.h > 0) {
    const b = kit.line();
    const r = { x: l.scene.x + b, y: l.scene.y + b, w: l.scene.w - 2 * b, h: l.scene.h - 2 * b };
    l.tiles = drawScene(ctx, r, m.scene, {
      t: o.t,
      scratch: o.scratch,
      ...(o.sprites ? { sprites: o.sprites } : {}),
      ...(o.frame ? { frame: o.frame } : {}),
      ...(o.maxScale ? { maxScale: o.maxScale } : {}),
      ...(m.targeting ? { cursor: m.targeting.cursor } : {}),
    });
  }
  kit.outline(l.scene, m.mode === "combat" ? theme.colours.red : theme.colours.border);

  drawLog(kit, m, l.log);
  drawSidebar(kit, m, l.sidebar);

  const ended = m.mode === "ended" && m.ended;
  if (ended || m.overlay || m.mode === "create") kit.fill(l.scene, theme.colours.scrim, theme.scrimAlpha);
  if (ended) drawEnded(kit, m, l);
  else if (m.overlay) drawOverlay(kit, m, l);
  else if (m.allot) drawAllot(kit, m, l);
  else if (m.menu) drawMenu(kit, m, l);
  return l;
}

/** A message alone in the window: starting up, or why the game could not start. */
export function drawMessage(kit: Kit, w: number, h: number, title: string, paras: Paragraph[]): void {
  kit.fill({ x: 0, y: 0, w, h }, theme.colours.background);
  const area = { x: 0, y: 0, w, h };
  const b = box(kit, area, area, BOX_CHARS, (inner) => headerHeight(kit) + linesHeight(kit, paras, inner));
  const top = header(kit, b, title);
  kit.paragraphs(paras, { x: b.x, y: top, w: b.w, h: b.y + b.h - top });
}

// ─── The log ─────────────────────────────────────────────────────────────────

function drawLog(kit: Kit, m: Model, r: Rect): void {
  const inner = kit.panel(r);
  const lh = kit.lineHeight();
  const foot = kit.lineHeight("small");
  const footY = inner.y + inner.h - foot;
  const bottom = footY - kit.space(1);
  const fit = Math.max(1, Math.floor((bottom - kit.space(1) - inner.y) / lh));
  // A page is a screenful less a line, so one line carries over; only as much log is wrapped as is needed.
  const page = Math.max(1, fit - 1);
  const need = fit + m.scroll * page;
  const chunks: { spans: Span[]; indent: number }[][] = [];
  let count = 0;
  for (let i = m.log.length - 1; i >= 0 && count < need; i--) {
    const wr = kit.wrap(m.log[i]!, inner.w);
    chunks.push(wr.lines.map((spans) => ({ spans, indent: wr.indent })));
    count += wr.lines.length;
  }
  const lines = chunks.reverse().flat();
  const back = Math.min(m.scroll * page, Math.max(0, lines.length - fit));
  const shown = lines.slice(Math.max(0, lines.length - back - fit), lines.length - back);
  const last = bottom - kit.space(1);
  shown.forEach((line, i) => {
    kit.spans(line.spans, inner.x + line.indent, last - (shown.length - i) * lh, { maxW: inner.w - line.indent });
  });
  kit.rule(inner.x, bottom, inner.w);
  const hint = m.busy ? "…" : (m.prompt ?? "");
  const more = back > 0 ? "PgDn: newer ↓" : "";
  const moreW = more ? kit.measure(more, "small") : 0;
  kit.text(hint, inner.x, footY, "muted", { size: "small", maxW: inner.w - moreW - kit.space(2) });
  if (more) kit.text(more, inner.x + inner.w - moreW, footY, "warning", { size: "small" });
}

// ─── The right column ────────────────────────────────────────────────────────

function drawSidebar(kit: Kit, m: Model, r: Rect): void {
  const inner = kit.panel(r, { pad: 3 });
  const lh = kit.lineHeight();
  let y = inner.y;
  kit.text(m.title, inner.x, y, "title", { size: "large", maxW: inner.w });
  y += kit.lineHeight("large") + kit.space(1);
  const s = m.status;
  if (!s) return;
  const line = (spans: Span[]) => {
    kit.spans(spans, inner.x, y, { maxW: inner.w });
    y += lh;
  };
  line([sp(s.clock)]);
  gauge(kit, inner.x, y, inner.w, "HP", s.hp, s.maxHp);
  y += lh;
  if (m.combat) {
    gauge(kit, inner.x, y, inner.w, "AP", m.combat.ap, m.sheet?.derived.AP ?? m.combat.ap, theme.bars.ap);
    y += lh;
  }
  line([sp(`£${s.money}`, "objective")]);
  line([
    sp(`Level ${s.level} · ${s.xp} XP`),
    ...(s.unspentSkillPoints ? [sp(` · +${s.unspentSkillPoints} (Z)`, "warning")] : []),
  ]);
  if (s.sneaking) line([sp("Sneaking", "warning")]);
  y += kit.space(2);
  kit.rule(inner.x, y, inner.w);
  y += kit.space(2);
  const paras: Paragraph[] = [];
  if (m.combat) {
    paras.push({ spans: [sp(`Round ${m.combat.round}`, "danger")] });
    for (const x of m.combat.combatants) {
      paras.push({
        spans: [
          sp(x.side === "a" ? "▲ " : "▼ ", x.side === "a" ? "good" : "danger"),
          sp(x.status !== "in" ? `${x.name} (${x.status}) ` : `${x.name} `),
          sp(`${x.hp}/${x.maxHp}`, gaugeStyle(x.hp, x.maxHp)),
        ],
      });
    }
  } else {
    paras.push({ spans: [sp("Pack", "heading")] });
    const inv = m.inventory;
    const entries = inv?.entries ?? inv?.items.map((name) => ({ name, equipped: inv.equipped.includes(name) })) ?? [];
    if (!entries.length) paras.push({ spans: [sp("Nothing.", "muted")] });
    for (const it of entries) {
      paras.push({ spans: it.equipped ? [sp(it.name, "strong"), sp(" (ready)", "good")] : [sp(it.name)] });
    }
  }
  kit.paragraphs(paras, { x: inner.x, y, w: inner.w, h: inner.y + inner.h - y });
}

/** A labelled gauge on one line: the label, a bar, and value/max coloured by how full it is. */
function gauge(kit: Kit, x: number, y: number, w: number, label: string, value: number, max: number, colour?: RGB) {
  const lh = kit.lineHeight();
  const figure = `${value}/${max}`;
  const style = gaugeStyle(value, max);
  const labelW = Math.ceil(kit.charWidth() * 3);
  const figureW = Math.ceil(kit.measure(figure)) + kit.space(2);
  kit.text(label, x, y, "muted");
  const bh = kit.space(2);
  const bar = { x: x + labelW, y: Math.round(y + (lh - bh) / 2), w: Math.max(0, w - labelW - figureW), h: bh };
  kit.bar(bar, value, max, colour ?? theme.bars[style]);
  kit.text(figure, x + w - figureW + kit.space(2), y, style);
}

// ─── Floating boxes ──────────────────────────────────────────────────────────

/**
 * A floating box: as wide as `chars` allows within the left column, as tall as `content` needs (given its inner
 * width), centred over the scene and kept in the window. Clicks on it go no further. Returns its inner rect.
 */
function box(kit: Kit, scene: Rect, column: Rect, chars: number, content: (inner: number) => number): Rect {
  const g = kit.space(2);
  const pad = kit.space(3);
  const w = Math.max(0, Math.min(column.w - 2 * g, Math.ceil(chars * kit.charWidth()) + 2 * pad));
  const h = Math.max(0, Math.min(column.h - 2 * g, content(w - 2 * pad) + 2 * pad));
  const x = Math.round(scene.x + (scene.w - w) / 2);
  const y = Math.round(Math.max(column.y + g, Math.min(scene.y + (scene.h - h) / 2, column.y + column.h - g - h)));
  const r = { x, y, w, h };
  kit.hit(r);
  return kit.panel(r, { fill: theme.colours.overlay, pad: 3 });
}

/** The left column (scene and log), which floating boxes may cover. */
const column = (l: HudLayout): Rect => ({ x: l.scene.x, y: l.scene.y, w: l.scene.w, h: l.log.y + l.log.h - l.scene.y });

const headerHeight = (kit: Kit) => kit.lineHeight("large") + 2 * kit.space(2) + kit.line();

/** A box's title, ruled off; `right` is muted text at its far end. Returns the y below it. */
function header(kit: Kit, inner: Rect, title: string, right?: string): number {
  const rightW = right ? kit.measure(right, "small") : 0;
  kit.text(title, inner.x, inner.y, "title", { size: "large", maxW: inner.w - rightW - kit.space(2) });
  if (right) kit.text(right, inner.x + inner.w - rightW, inner.y + kit.space(1), "muted", { size: "small" });
  const y = inner.y + kit.lineHeight("large") + kit.space(2);
  kit.rule(inner.x, y, inner.w);
  return y + kit.line() + kit.space(2);
}

const linesHeight = (kit: Kit, paras: readonly Paragraph[], width: number) =>
  kit.lines(paras, width).length * kit.lineHeight();

/** The height of a footer of buttons. */
const footHeight = (kit: Kit) => kit.space(2) + kit.buttonSize("M").h;

/** Buttons right-aligned at the foot of `inner`, and muted text at its left. */
function footer(kit: Kit, inner: Rect, list: { label: string; action: Action; enabled?: boolean }[], left = ""): void {
  const h = kit.buttonSize("M").h;
  const y = inner.y + inner.h - h;
  let x = inner.x + inner.w;
  for (const b of [...list].reverse()) {
    x -= kit.buttonSize(b.label).w;
    kit.button(x, y, b.label, b.action, b.enabled ?? true);
    x -= kit.space(2);
  }
  if (left) kit.text(left, inner.x, y + kit.space(1) / 2, "muted", { size: "small", maxW: x - inner.x });
}

function drawMenu(kit: Kit, m: Model, l: HudLayout): void {
  const menu = m.menu!;
  const lh = kit.lineHeight();
  const pad = kit.space(1);
  const numW = Math.ceil(kit.measure("00. "));
  const detailW = (i: number) => {
    const d = menu.items[i]!.detail;
    return d ? Math.ceil(kit.measure(d)) + kit.space(3) : 0;
  };
  const chars = Math.max(
    24,
    menu.title.length + 4,
    ...menu.items.map((it) => it.label.length + (it.detail ? it.detail.length + 3 : 0) + 5),
  );
  // Rows wrap (conversation options can be long), the number hanging and the detail at the right.
  let wrap: Span[][][] = [];
  const inner = box(kit, l.scene, column(l), Math.min(BOX_CHARS, chars), (w) => {
    wrap = menu.items.map((it, i) => kit.wrap({ spans: [sp(it.label)] }, w - 2 * pad - numW - detailW(i)).lines);
    return headerHeight(kit) + wrap.reduce((n, r) => n + r.length * lh, 0);
  });
  const top = header(kit, inner, menu.title);
  const room = inner.y + inner.h - top;
  // Scroll so the highlighted row shows.
  const heights = wrap.map((r) => r.length * lh);
  const used = (from: number, to: number) => heights.slice(from, to + 1).reduce((a, b) => a + b, 0);
  let start = 0;
  while (start < menu.index && used(start, menu.index) > room) start++;
  let y = top;
  for (let i = start; i < menu.items.length && y + heights[i]! <= top + room; i++) {
    const rowR = { x: inner.x, y, w: inner.w, h: heights[i]! };
    const selected = i === menu.index;
    const look = selected ? { look: "selected" as const } : {};
    if (selected) kit.fill(rowR, theme.colours.selection);
    kit.spans([sp(`${i + 1}`, "choice"), sp(". ", "muted")], inner.x + pad, y, look);
    wrap[i]!.forEach((line, j) => {
      kit.spans(line, inner.x + pad + numW, y + j * lh, { maxW: inner.w - 2 * pad - numW - detailW(i), ...look });
    });
    const detail = menu.items[i]!.detail;
    if (detail) kit.spans([sp(detail, "muted")], inner.x + inner.w - pad - kit.measure(detail), y, look);
    kit.hit(rowR, { kind: "menu", index: i });
    y += heights[i]!;
  }
}

function drawOverlay(kit: Kit, m: Model, l: HudLayout): void {
  const o = m.overlay!;
  const lh = kit.lineHeight();
  const skills = o.skills ?? [];
  const inner = box(kit, l.scene, column(l), BOX_CHARS, (w) => {
    return headerHeight(kit) + linesHeight(kit, o.lines, w) + skills.length * lh + footHeight(kit);
  });
  const top = header(kit, inner, o.title);
  const room = inner.y + inner.h - footHeight(kit) - top;
  // The skills to raise keep at least a few rows; the sheet's text takes the rest.
  const skillRows = Math.min(skills.length, Math.max(skills.length ? 3 : 0, Math.floor(room / lh) - 4));
  const textH = room - skillRows * lh;
  kit.paragraphs(o.lines, { x: inner.x, y: top, w: inner.w, h: textH }, o.offset ?? 0);
  if (skillRows) {
    const index = o.index ?? 0;
    const start = Math.max(0, Math.min(index - Math.floor(skillRows / 2), skills.length - skillRows));
    for (let i = start; i < start + skillRows; i++) {
      const rowR = { x: inner.x, y: top + textH + (i - start) * lh, w: inner.w, h: lh };
      kit.row(rowR, [sp(skills[i]!.label)], { selected: i === index, input: { kind: "skill", index: i } });
    }
  }
  if (o.pages) {
    const page = o.page ?? 0;
    const last = page >= o.pages.length - 1;
    footer(
      kit,
      inner,
      [
        { label: "‹ Back", action: { kind: "overlay", action: "prev" }, enabled: page > 0 },
        last
          ? { label: "Close", action: { kind: "overlay", action: "close" } }
          : { label: "Next ›", action: { kind: "overlay", action: "next" } },
      ],
      `page ${page + 1} / ${o.pages.length}`,
    );
  } else footer(kit, inner, [{ label: "Close", action: { kind: "overlay", action: "close" } }]);
}

function drawAllot(kit: Kit, m: Model, l: HudLayout): void {
  const a = m.allot!;
  const lh = kit.lineHeight();
  const rowH = lh + kit.space(1);
  const left = ALLOT_TOTAL - ATTRIBUTES.reduce((s, x) => s + a.special[x], 0);
  const inner = box(
    kit,
    l.scene,
    column(l),
    40,
    () => headerHeight(kit) + lh + ATTRIBUTES.length * rowH + footHeight(kit),
  );
  const top = header(kit, inner, "Make your own");
  kit.text(`${left} points left`, inner.x, top, left ? "warning" : "good", { maxW: inner.w });
  const btn = kit.buttonSize("+");
  const valueW = Math.ceil(kit.measure("00")) + 2 * kit.space(2);
  ATTRIBUTES.forEach((attr, i) => {
    const y = top + lh + i * rowH;
    const selected = i === a.index;
    kit.row({ x: inner.x, y, w: inner.w, h: rowH }, [sp(ATTRIBUTE_NAMES[attr])], {
      selected,
      input: { kind: "allot", action: "select", index: i },
    });
    const by = Math.round(y + (rowH - btn.h) / 2);
    const plusX = inner.x + inner.w - kit.space(1) - btn.w;
    const valueX = plusX - valueW;
    kit.button(plusX, by, "+", { kind: "allot", action: "raise", index: i });
    kit.spans([sp(String(a.special[attr]).padStart(2), "strong")], valueX + kit.space(2), y + (rowH - lh) / 2, {
      ...(selected ? { look: "selected" as const } : {}),
    });
    kit.button(valueX - btn.w, by, "−", { kind: "allot", action: "lower", index: i });
  });
  footer(kit, inner, [
    { label: "Cancel", action: { kind: "allot", action: "cancel" } },
    { label: "Done", action: { kind: "allot", action: "done" }, enabled: left === 0 },
  ]);
}

function drawEnded(kit: Kit, m: Model, l: HudLayout): void {
  const e = m.ended!;
  const paras = markdownParagraphs(e.text);
  const inner = box(
    kit,
    l.scene,
    column(l),
    BOX_CHARS,
    (w) => headerHeight(kit) + linesHeight(kit, paras, w) + footHeight(kit),
  );
  const top = header(kit, inner, `— ${e.title ?? "The End"} —`);
  kit.paragraphs(paras, { x: inner.x, y: top, w: inner.w, h: inner.y + inner.h - footHeight(kit) - top });
  footer(kit, inner, [{ label: "Quit", action: "quit" }]);
}
