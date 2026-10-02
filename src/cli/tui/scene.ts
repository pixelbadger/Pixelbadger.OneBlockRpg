/**
 * The scene: the player's room drawn as tiles, in the manner of Ultima V. A viewport follows the player across rooms
 * bigger than the screen. Animations (walks, shots, hits) come from a timeline built from the turn's fx (port.ts).
 */

import type { Fx, SceneThing, Tile, ViewOf } from "../../session/port.js";
import type { Canvas, Rect } from "./canvas.js";
import { mix, type RGB, style } from "./color.js";
import { type Art, exitArt, lighting, nightTint, terrainArt, thingArt } from "./tiles.js";

export type Scene = ViewOf<"scene">;

export interface SceneOptions {
  /** Animation time in ms. */
  t: number;
  emoji: boolean;
  frame?: AnimFrame;
  /** A targeting cursor, in map tiles. */
  cursor?: Tile;
  /** Highlight the tiles around the player (a direction prompt). */
  around?: boolean;
}

/** One instant of an animation. */
export interface AnimFrame {
  /** Positions overriding the scene's while things are walking. */
  pos: Map<string, Tile>;
  marks: { at: Tile; emoji: string; glyph: string; fg: RGB }[];
  floats: { at: Tile; text: string; fg: RGB; rise: number }[];
  shots: { at: Tile }[];
}

const STEP_MS = 70;

/** A turn's fx as a timeline: walks move tile by tile, then hits, misses and falls play in order. */
export class Timeline {
  readonly duration: number;
  private walks = new Map<string, { start: number; seq: Tile[] }[]>();
  private beats: { start: number; end: number; draw: (f: AnimFrame, u: number) => void }[] = [];

  constructor(fx: readonly Fx[], before: Map<string, Tile>) {
    let t = 0;
    let i = 0;
    const last = new Map(before);
    while (i < fx.length) {
      const f = fx[i]!;
      if (f.kind === "walk") {
        // Consecutive walks play together.
        const group = new Map<string, Tile[]>();
        while (i < fx.length && fx[i]!.kind === "walk") {
          const w = fx[i] as Extract<Fx, { kind: "walk" }>;
          group.set(w.id, [...(group.get(w.id) ?? []), ...w.path]);
          i++;
        }
        let longest = 0;
        for (const [id, path] of group) {
          const from = last.get(id);
          const seq = from ? [from, ...path] : path;
          this.walks.set(id, [...(this.walks.get(id) ?? []), { start: t, seq }]);
          last.set(id, seq[seq.length - 1]!);
          longest = Math.max(longest, seq.length);
        }
        t += longest * STEP_MS;
        continue;
      }
      i++;
      if (f.kind === "hit" || f.kind === "miss") {
        const to = f.to;
        if (!to) continue;
        if (f.ranged && f.from) {
          const from = f.from;
          const line = bresenham(from, to);
          const dur = Math.max(120, line.length * 30);
          this.beats.push({
            start: t,
            end: t + dur,
            draw: (fr, u) => {
              const p = line[Math.min(line.length - 1, Math.floor(u * line.length))];
              if (p) fr.shots.push({ at: p });
            },
          });
          t += dur;
        }
        const crit = f.kind === "hit" && f.crit;
        const mark =
          f.kind === "miss"
            ? { emoji: "💨", glyph: "~~", fg: [200, 200, 220] as RGB }
            : crit
              ? { emoji: "⚡", glyph: "!!", fg: [255, 230, 80] as RGB }
              : { emoji: "💥", glyph: "**", fg: [255, 120, 60] as RGB };
        this.beats.push({ start: t, end: t + 380, draw: (fr) => fr.marks.push({ at: to, ...mark }) });
        const text = f.kind === "miss" ? "miss" : `-${f.damage ?? 0}`;
        const fg: RGB = f.kind === "miss" ? [190, 190, 210] : [255, 90, 80];
        this.beats.push({ start: t, end: t + 800, draw: (fr, u) => fr.floats.push({ at: to, text, fg, rise: u }) });
        t += 300;
      } else if ((f.kind === "down" || f.kind === "killed") && f.at) {
        const at = f.at;
        const emoji = f.kind === "down" ? "💫" : "💀";
        this.beats.push({
          start: t,
          end: t + 500,
          draw: (fr) => fr.marks.push({ at, emoji, glyph: "%%", fg: [230, 230, 230] }),
        });
        t += 350;
      }
    }
    this.duration = t + (this.beats.length ? 500 : 0);
  }

  at(ms: number, finalPos: Map<string, Tile>): AnimFrame {
    const frame: AnimFrame = { pos: new Map(), marks: [], floats: [], shots: [] };
    for (const [id, phases] of this.walks) {
      let pos: Tile | undefined;
      for (const ph of phases) {
        if (ms < ph.start) {
          pos ??= ph.seq[0];
          break;
        }
        pos = ph.seq[Math.min(ph.seq.length - 1, Math.floor((ms - ph.start) / STEP_MS))];
      }
      const p = pos ?? finalPos.get(id);
      if (p) frame.pos.set(id, p);
    }
    for (const b of this.beats) {
      if (ms >= b.start && ms < b.end) b.draw(frame, (ms - b.start) / (b.end - b.start));
    }
    return frame;
  }
}

function bresenham(a: Tile, b: Tile): Tile[] {
  const out: Tile[] = [];
  let [x, y] = a;
  const dx = Math.abs(b[0] - x);
  const dy = -Math.abs(b[1] - y);
  const sx = x < b[0] ? 1 : -1;
  const sy = y < b[1] ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 128; guard++) {
    if (x === b[0] && y === b[1]) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    out.push([x, y]);
  }
  return out;
}

/** Where the map's (0, 0) lands in the viewport, in tiles, keeping the player in view. */
export function camera(scene: Scene, tilesW: number, tilesH: number, focus: Tile | undefined): Tile {
  const axis = (size: number, view: number, at: number | undefined) => {
    if (size <= view) return Math.floor((view - size) / 2);
    const want = Math.floor(view / 2) - (at ?? Math.floor(size / 2));
    return Math.max(view - size, Math.min(0, want));
  };
  return [axis(scene.w, tilesW, focus?.[0]), axis(scene.h, tilesH, focus?.[1])];
}

/** How a thing fills its block when tiles are drawn bigger than one cell high. */
type Fill = "terrain" | "solid" | "centre";

/**
 * Draws art over a tile's block of 2s × s cells. Terrain repeats its glyph over the block; solid things (furniture)
 * fill it; anything else sits in the middle of its own background.
 */
function put(cv: Canvas, x: number, y: number, art: Art, emoji: boolean, s: number, fill: Fill): void {
  const sgr = style(art.fg, art.bg, ...(art.bold ? ["1"] : []));
  const [a = " ", b = " "] = [...art.glyph];
  const cx = x + 2 * Math.floor((s - 1) / 2) + (s % 2 ? 0 : 1);
  const cy = y + Math.floor((s - 1) / 2);
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      const px = x + dx * 2;
      const centre = s === 1 || (px === cx - (s % 2 ? 0 : 1) && y + dy === cy) || (px === cx && y + dy === cy);
      if (fill === "centre" && !centre) {
        cv.set(px, y + dy, " ", style(undefined, art.bg));
        cv.set(px + 1, y + dy, " ", style(undefined, art.bg));
      } else if (fill !== "centre" || s === 1) {
        if (emoji && art.emoji && (s === 1 || fill === "solid"))
          cv.wide(px, y + dy, art.emoji, style(undefined, art.bg));
        else {
          cv.set(px, y + dy, a, sgr);
          cv.set(px + 1, y + dy, b, sgr);
        }
      }
    }
  }
  if (s > 1 && fill === "centre") {
    if (emoji && art.emoji) cv.wide(cx, cy, art.emoji, style(undefined, art.bg));
    else {
      cv.set(cx, cy, a, sgr);
      cv.set(cx + 1, cy, b, sgr);
    }
  }
}

const lit = (art: Art, k: number): Art =>
  k >= 1 ? art : { ...art, fg: nightTint(art.fg, k), bg: nightTint(art.bg, k) };

/** The biggest tile scale (1–3) at which the whole room fits in `r`. */
export function tileScale(scene: Scene, r: Rect): number {
  for (let s = 3; s > 1; s--) if (scene.w * 2 * s <= r.w && scene.h * s <= r.h) return s;
  return 1;
}

/** Draws the scene into `r`: each tile is 2s columns by s rows, s chosen so small rooms fill the view. */
export function drawScene(cv: Canvas, r: Rect, scene: Scene, o: SceneOptions): void {
  const s = tileScale(scene, r);
  const tilesW = Math.floor(r.w / (2 * s));
  const tilesH = Math.floor(r.h / s);
  const padX = Math.floor((r.w - tilesW * 2 * s) / 2);
  const padY = Math.floor((r.h - tilesH * s) / 2);
  const player = scene.things.find((t) => t.player);
  const playerAt = (player && o.frame?.pos.get(player.id)) ?? player?.pos;
  const [ox, oy] = camera(scene, tilesW, tilesH, playerAt);
  const sx = (mx: number) => r.x + padX + (ox + mx) * 2 * s;
  const sy = (my: number) => r.y + padY + (oy + my) * s;
  const inView = (p: Tile) => {
    const x = ox + p[0];
    const y = oy + p[1];
    return x >= 0 && y >= 0 && x < tilesW && y < tilesH;
  };
  cv.clip(r, () => {
    cv.fill(r, " ", style(undefined, [8, 8, 10]));
    const ground = new Map<string, Art>();
    for (let y = 0; y < scene.h; y++) {
      for (let x = 0; x < scene.w; x++) {
        if (!inView([x, y])) continue;
        const k = lighting(scene, x, y, playerAt);
        const art = lit(terrainArt(scene.terrain[y]![x]!, x, y, o.t, scene.looks[`${x},${y}`]), k);
        ground.set(`${x},${y}`, art);
        put(cv, sx(x), sy(y), art, o.emoji, s, art.emoji ? "centre" : "terrain");
      }
    }
    const under = (p: Tile): Art => ground.get(`${p[0]},${p[1]}`) ?? { glyph: "  ", fg: [0, 0, 0], bg: [8, 8, 10] };
    for (const x of scene.exits) {
      if (!inView(x.pos)) continue;
      const art = lit(exitArt(x, under(x.pos)), lighting(scene, ...x.pos, playerAt));
      put(cv, sx(x.pos[0]), sy(x.pos[1]), art, o.emoji, s, "centre");
    }
    // Fixed things and items, then characters on top.
    const people = new Map<string, number>();
    scene.things
      .filter((t) => t.kind === "character")
      .forEach((t, i) => {
        people.set(t.id, i);
      });
    for (const t of scene.things) {
      const tiles = t.kind === "character" ? [o.frame?.pos.get(t.id) ?? t.pos] : t.tiles.length ? t.tiles : [t.pos];
      for (const p of tiles) {
        if (!inView(p)) continue;
        if (t.apparition && !apparitionShows(t, o.t)) continue;
        let art = thingArt(t, under(p), people.get(t.id) ?? 0);
        if (t.apparition) art = { ...art, fg: mix(art.fg, [170, 200, 255], 0.6), bg: mix(art.bg, [60, 80, 120], 0.35) };
        if (t.player) {
          const pulse = 0.16 + 0.08 * Math.sin(o.t / 260);
          art = { ...art, bg: mix(art.bg, [255, 255, 255], pulse) };
        } else if (t.side === "b") {
          art = { ...art, bg: mix(art.bg, [200, 40, 30], 0.35) };
        }
        const fill: Fill = t.kind === "fixed" && !art.emoji ? "solid" : "centre";
        put(cv, sx(p[0]), sy(p[1]), lit(art, t.player ? 1 : lighting(scene, p[0], p[1], playerAt)), o.emoji, s, fill);
      }
    }
    const block = (p: Tile, c: RGB, k: number) => {
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < 2 * s; dx += 2) tint(cv, sx(p[0]) + dx, sy(p[1]) + dy, c, k);
    };
    if (o.around && playerAt) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const p: Tile = [playerAt[0] + dx, playerAt[1] + dy];
          if ((dx || dy) && inView(p)) block(p, [255, 230, 120], 0.25 + 0.1 * Math.sin(o.t / 200));
        }
      }
    }
    for (const shot of o.frame?.shots ?? []) {
      if (inView(shot.at)) {
        put(
          cv,
          sx(shot.at[0]),
          sy(shot.at[1]),
          { ...under(shot.at), glyph: "• ", fg: [255, 240, 180], bold: true },
          false,
          s,
          "centre",
        );
      }
    }
    for (const m of o.frame?.marks ?? []) {
      if (inView(m.at)) {
        put(
          cv,
          sx(m.at[0]),
          sy(m.at[1]),
          { ...under(m.at), glyph: m.glyph, fg: m.fg, emoji: m.emoji, bold: true },
          o.emoji,
          s,
          "centre",
        );
      }
    }
    for (const f of o.frame?.floats ?? []) {
      const y = sy(f.at[1]) - 1 - Math.floor(f.rise * 1.5);
      const x = sx(f.at[0]) + s - 1;
      if (y >= r.y) cv.text(x, y, f.text, style(f.fg, undefined, "1"));
    }
    if (o.cursor && inView(o.cursor)) {
      const on = Math.floor(o.t / 300) % 2 === 0;
      block(o.cursor, on ? [255, 220, 60] : [255, 255, 255], on ? 0.55 : 0.3);
      const x = sx(o.cursor[0]);
      const y = sy(o.cursor[1]) + Math.floor((s - 1) / 2);
      cv.set(x - 1, y, "[", style([255, 220, 60], undefined, "1"));
      cv.set(x + 2 * s, y, "]", style([255, 220, 60], undefined, "1"));
    }
  });
}

/** Re-styles a tile's background towards `c` (keeping what is drawn there). */
function tint(cv: Canvas, x: number, y: number, c: RGB, k: number): void {
  for (const cx of [x, x + 1]) {
    const sgr = cv.sgrAt(cx, y);
    const m = /48;2;(\d+);(\d+);(\d+)/.exec(sgr);
    const base: RGB = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [40, 40, 40];
    const next = mix(base, c, k);
    const replaced = m
      ? sgr.replace(m[0], `48;2;${next[0]};${next[1]};${next[2]}`)
      : `${sgr ? `${sgr};` : ""}${style(undefined, next)}`;
    cv.restyle(cx, y, replaced);
  }
}

/** Apparitions flicker: now you see them, now you don't. */
function apparitionShows(t: SceneThing, ms: number): boolean {
  let h = 0;
  for (const ch of t.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const v = Math.sin(ms / 340 + h) + Math.sin(ms / 910 + h * 0.37) * 0.8;
  return v > -0.9;
}
