/**
 * Time in the scene: a turn's fx (port.ts) as a timeline of walks, shots, hits and falls, and the camera that keeps
 * the player in view across rooms bigger than the screen.
 */

import type { Fx, SceneThing, Tile } from "../engine/session/port.js";
import type { RGB } from "./art.js";
import type { Rect } from "./canvas.js";

export type Mark = "hit" | "miss" | "crit" | "down" | "killed";

/** One instant of an animation. */
export interface AnimFrame {
  /** Positions overriding the scene's while things are walking. */
  pos: Map<string, Tile>;
  /** Hits, misses and falls, drawn from the `fx/<kind>` sprite or else the glyph (or emoji). */
  marks: { at: Tile; kind: Mark; emoji: string; glyph: string; fg: RGB }[];
  /** Damage numbers and "miss", rising (`rise` 0–1) off the tile. */
  floats: { at: Tile; text: string; fg: RGB; rise: number }[];
  /** A missile in flight. */
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
            ? { kind: "miss" as const, emoji: "💨", glyph: "~", fg: [200, 200, 220] as RGB }
            : crit
              ? { kind: "crit" as const, emoji: "⚡", glyph: "!", fg: [255, 230, 80] as RGB }
              : { kind: "hit" as const, emoji: "💥", glyph: "*", fg: [255, 120, 60] as RGB };
        this.beats.push({ start: t, end: t + 380, draw: (fr) => fr.marks.push({ at: to, ...mark }) });
        const text = f.kind === "miss" ? "miss" : `-${f.damage ?? 0}`;
        const fg: RGB = f.kind === "miss" ? [190, 190, 210] : [255, 90, 80];
        this.beats.push({ start: t, end: t + 800, draw: (fr, u) => fr.floats.push({ at: to, text, fg, rise: u }) });
        t += 300;
      } else if ((f.kind === "down" || f.kind === "killed") && f.at) {
        const at = f.at;
        const kind = f.kind;
        const emoji = kind === "down" ? "💫" : "💀";
        this.beats.push({
          start: t,
          end: t + 500,
          draw: (fr) => fr.marks.push({ at, kind, emoji, glyph: "%", fg: [230, 230, 230] }),
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
export function camera(room: { w: number; h: number }, tilesW: number, tilesH: number, focus: Tile | undefined): Tile {
  const axis = (size: number, view: number, at: number | undefined) => {
    if (size <= view) return Math.floor((view - size) / 2);
    const want = Math.floor(view / 2) - (at ?? Math.floor(size / 2));
    return Math.max(view - size, Math.min(0, want));
  };
  return [axis(room.w, tilesW, focus?.[0]), axis(room.h, tilesH, focus?.[1])];
}

/** Where the room lands on screen, in pixels: tile size, tiles in view and the camera. */
export interface SceneLayout {
  /** Screen pixels a tile: the art's tile size times a whole-number scale, so pixel art stays crisp. */
  tile: number;
  /** Pixels a tile in the art (the sprite sheet's, or the glyph fallback's). */
  art: number;
  tilesW: number;
  tilesH: number;
  /** The top-left of the tiles in view, in screen pixels. */
  x: number;
  y: number;
  /** Where the map's (0, 0) is, in viewport tiles. */
  ox: number;
  oy: number;
  /** The player's tile (mid-walk during an animation). */
  playerAt?: Tile;
}

/**
 * Fits a room into `r`: the biggest whole-number scale (up to `maxScale`) at which it all shows, or 1 with the
 * camera following the player when even that is too big. The room is centred in what is left over.
 */
export function sceneLayout(
  r: Rect,
  room: { w: number; h: number; things: readonly SceneThing[] },
  o: { art: number; frame?: AnimFrame; maxScale?: number },
): SceneLayout {
  const fit = Math.floor(Math.min(r.w / (room.w * o.art), r.h / (room.h * o.art)));
  const tile = o.art * Math.max(1, Math.min(o.maxScale ?? 4, fit));
  const tilesW = Math.max(1, Math.min(room.w, Math.floor(r.w / tile)));
  const tilesH = Math.max(1, Math.min(room.h, Math.floor(r.h / tile)));
  const player = room.things.find((t) => t.player);
  const playerAt = (player && o.frame?.pos.get(player.id)) ?? player?.pos;
  const [ox, oy] = camera(room, tilesW, tilesH, playerAt);
  return {
    tile,
    art: o.art,
    tilesW,
    tilesH,
    x: r.x + Math.floor((r.w - tilesW * tile) / 2),
    y: r.y + Math.floor((r.h - tilesH * tile) / 2),
    ox,
    oy,
    ...(playerAt ? { playerAt } : {}),
  };
}

/** The map tile under a screen pixel, if it is one in view. */
export function tileAt(l: SceneLayout, px: number, py: number): Tile | undefined {
  const vx = Math.floor((px - l.x) / l.tile);
  const vy = Math.floor((py - l.y) / l.tile);
  if (vx < 0 || vy < 0 || vx >= l.tilesW || vy >= l.tilesH) return undefined;
  return [vx - l.ox, vy - l.oy];
}

/** Apparitions flicker: now you see them, now you don't. */
export function apparitionShows(t: SceneThing, ms: number): boolean {
  let h = 0;
  for (const ch of t.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const v = Math.sin(ms / 340 + h) + Math.sin(ms / 910 + h * 0.37) * 0.8;
  return v > -0.9;
}
