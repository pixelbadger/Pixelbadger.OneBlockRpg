/**
 * The scene as pixels, for terminals that show images (graphics.ts). Same room, camera, lighting and animation as
 * the glyph renderer (scene.ts), drawn from sprite art (sprites.ts). Anything without a sprite is drawn from its
 * glyph art on a coloured tile, so a payload without art still plays.
 */

import type { Tile } from "../../../engine/session/port.js";
import { mix, type RGB } from "./color.js";
import { type Image, image } from "./png.js";
import { type AnimFrame, apparitionShows, type Scene, type Viewport } from "./scene.js";
import { frameAt, type Sprite, type SpriteSet } from "./sprites.js";
import { type Art, exitArt, lighting, nightTint, terrainArt, thingArt } from "./tiles.js";

export interface RasterOptions {
  /** Animation time in ms. */
  t: number;
  frame?: AnimFrame;
  cursor?: Tile;
  around?: boolean;
}

type PixelMap = (r: number, g: number, b: number, a: number) => [number, number, number, number];

const VOID: RGB = [8, 8, 10];

/** Draws the scene's viewport `v` as an image, `sprites.tile` pixels a tile. */
export function rasterScene(scene: Scene, sprites: SpriteSet, v: Viewport, o: RasterOptions): Image {
  const T = sprites.tile;
  const img = image(v.tilesW * T, v.tilesH * T);
  fill(img, 0, 0, img.w, img.h, VOID);
  const px = (p: Tile): [number, number] => [(v.ox + p[0]) * T, (v.oy + p[1]) * T];
  const inView = (p: Tile) => {
    const x = v.ox + p[0];
    const y = v.oy + p[1];
    return x >= 0 && y >= 0 && x < v.tilesW && y < v.tilesH;
  };
  const light = (p: Tile) => lighting(scene, p[0], p[1], v.playerAt);
  const ground = new Map<string, Art>();
  const under = (p: Tile): Art => ground.get(`${p[0]},${p[1]}`) ?? { glyph: "  ", fg: VOID, bg: VOID };

  // Terrain.
  for (let y = 0; y < scene.h; y++) {
    for (let x = 0; x < scene.w; x++) {
      if (!inView([x, y])) continue;
      const kind = scene.terrain[y]![x]!;
      const look = scene.looks[`${x},${y}`];
      const art = terrainArt(kind, x, y, o.t, look);
      ground.set(`${x},${y}`, art);
      const [dx, dy] = px([x, y]);
      const sprite = sprites.get(look?.sprite) ?? sprites.get(`terrain/${kind}`);
      if (sprite) drawTerrain(img, sprite, dx, dy, T, x, y, o.t, !UNFLIPPED.has(kind));
      else tileFromArt(img, dx, dy, T, art);
    }
  }

  // Exits.
  for (const x of scene.exits) {
    if (!inView(x.pos)) continue;
    const [dx, dy] = px(x.pos);
    const dir = (x.direction ?? "").toLowerCase();
    const key = x.blocked
      ? "exit/blocked"
      : x.door && !x.open
        ? "exit/door"
        : dir === "up" || dir === "down"
          ? `exit/${dir}`
          : x.door
            ? "exit/door-open"
            : "exit/doorway";
    const sprite = sprites.get(key);
    if (sprite) blit(img, frameAt(sprite, o.t), dx, dy, T, T);
    else if (key === "exit/doorway" || key === "exit/door-open") {
      blend(img, dx, dy, T, T, [230, 215, 170], 0.22);
      arrow(img, dx, dy, T, dir, [250, 235, 170]);
    } else tileFromArt(img, dx, dy, T, exitArt(x, under(x.pos)), true);
  }

  // Fixed things and items.
  for (const t of scene.things) {
    if (t.kind === "character") continue;
    const tiles = t.tiles.length ? t.tiles : [t.pos];
    if (!tiles.some(inView)) continue;
    const sprite = sprites.get(t.look?.sprite) ?? sprites.get(`object/${t.id}`);
    if (sprite?.fit === "span") {
      const xs = tiles.map((p) => p[0]);
      const ys = tiles.map((p) => p[1]);
      const [dx, dy] = px([Math.min(...xs), Math.min(...ys)]);
      const w = (Math.max(...xs) - Math.min(...xs) + 1) * T;
      const h = (Math.max(...ys) - Math.min(...ys) + 1) * T;
      blit(img, frameAt(sprite, o.t, phase(t.id)), dx, dy, w, h);
      continue;
    }
    for (const p of tiles) {
      if (!inView(p)) continue;
      const [dx, dy] = px(p);
      if (sprite) blit(img, frameAt(sprite, o.t, phase(t.id) + p[0] + p[1]), dx, dy, T, T);
      else glyphOnTile(img, dx, dy, T, thingArt(t, under(p), 0));
    }
  }

  // Light falls on the room before the people are drawn; the player is always lit.
  for (let y = 0; y < scene.h; y++) {
    for (let x = 0; x < scene.w; x++) {
      if (!inView([x, y])) continue;
      const k = light([x, y]);
      if (k < 1) {
        const [dx, dy] = px([x, y]);
        mapRect(img, dx, dy, T, T, lightMap(k));
      }
    }
  }

  // Characters.
  const people = scene.things.filter((t) => t.kind === "character");
  people.forEach((t, i) => {
    const p = o.frame?.pos.get(t.id) ?? t.pos;
    if (!inView(p)) return;
    if (t.apparition && !apparitionShows(t, o.t)) return;
    const [dx, dy] = px(p);
    const k = t.player ? 1 : light(p);
    if (t.player) ring(img, dx, dy, T, [120, 220, 255], 0.45 + 0.25 * Math.sin(o.t / 260));
    else if (t.side === "b") ring(img, dx, dy, T, [230, 60, 40], 0.7);
    const sprite = sprites.get(t.look?.sprite) ?? sprites.get(`character/${t.id}`);
    const walking = o.frame?.pos.has(t.id) ?? false;
    let art = sprite ? frameAt(sprite, walking ? o.t * 2 : o.t, phase(t.id)) : undefined;
    if (art && t.status && t.status !== "ok") art = lying(art);
    const map = composeMaps(
      t.apparition ? ghostMap : undefined,
      t.status === "dead" ? greyMap : undefined,
      k < 1 ? lightMap(k) : undefined,
    );
    if (art) blit(img, art, dx, dy, T, T, map);
    else glyphOnTile(img, dx, dy, T, thingArt(t, under(p), i), map);
    if (t.status === "asleep") text(img, dx + T - 8, dy + 1 - Math.floor((o.t / 400) % 3), "z", [190, 200, 255], 1);
  });

  // The direction prompt, shots, hits, damage numbers and the targeting cursor.
  if (o.around && v.playerAt) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const p: Tile = [v.playerAt[0] + dx, v.playerAt[1] + dy];
        if ((dx || dy) && inView(p)) blend(img, ...px(p), T, T, [255, 230, 120], 0.25 + 0.1 * Math.sin(o.t / 200));
      }
    }
  }
  for (const shot of o.frame?.shots ?? []) {
    if (!inView(shot.at)) continue;
    const [dx, dy] = px(shot.at);
    const r = Math.max(2, Math.floor(T / 8));
    fill(img, dx + T / 2 - r, dy + T / 2 - r, r * 2, r * 2, [255, 240, 180]);
  }
  for (const m of o.frame?.marks ?? []) {
    if (!inView(m.at)) continue;
    const [dx, dy] = px(m.at);
    const sprite = sprites.get(`fx/${MARKS[m.emoji] ?? "hit"}`);
    if (sprite) blit(img, frameAt(sprite, o.t), dx, dy, T, T);
    else text(img, dx + 2, dy + T / 2 - 5, m.glyph.trim() || "*", m.fg, 2);
  }
  for (const f of o.frame?.floats ?? []) {
    if (!inView(f.at)) continue;
    const [dx, dy] = px(f.at);
    const scale = T >= 32 ? 2 : 1;
    text(img, dx + 1, dy - Math.floor(f.rise * T * 0.8), f.text, f.fg, scale);
  }
  if (o.cursor && inView(o.cursor)) {
    const on = Math.floor(o.t / 300) % 2 === 0;
    const [dx, dy] = px(o.cursor);
    blend(img, dx, dy, T, T, on ? [255, 220, 60] : [255, 255, 255], on ? 0.3 : 0.15);
    outline(img, dx, dy, T, T, [255, 220, 60], Math.max(1, Math.floor(T / 16)));
  }
  return img;
}

/** Terrains whose art has an up and a down (or a left and right) and so are never mirrored for variety. */
const UNFLIPPED = new Set(["wall", "window", "stairs", "railing", "fence"]);

/** Fx marks (by the emoji the timeline uses) to sprite names. */
const MARKS: Record<string, string> = { "💨": "miss", "⚡": "crit", "💥": "hit", "💫": "down", "💀": "killed" };

const phase = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 7;
};

const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
};

function drawTerrain(
  img: Image,
  s: Sprite,
  dx: number,
  dy: number,
  T: number,
  x: number,
  y: number,
  t: number,
  vary: boolean,
): void {
  const h = hash(x, y);
  const src = frameAt(s, t, h % 5);
  if (s.anim === "scroll") {
    // Slide the texture sideways, wrapping, so water moves.
    const shift = Math.floor(t / 140 + y * 3) % src.w;
    for (let yy = 0; yy < T; yy++) {
      const sy = Math.floor((yy * src.h) / T);
      for (let xx = 0; xx < T; xx++) {
        const sx = (Math.floor((xx * src.w) / T) + shift) % src.w;
        put(img, dx + xx, dy + yy, src, (sy * src.w + sx) * 4);
      }
    }
    return;
  }
  blit(img, src, dx, dy, T, T, undefined, vary && (h & 1) === 1, vary && (h & 2) === 2);
}

/** Copies `src` scaled (nearest neighbour) into `w`×`h` at (dx, dy), alpha-blended, optionally recoloured. */
export function blit(
  dst: Image,
  src: Image,
  dx: number,
  dy: number,
  w: number,
  h: number,
  map?: PixelMap,
  flipX = false,
  flipY = false,
): void {
  for (let y = 0; y < h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.h) continue;
    let sy = Math.floor((y * src.h) / h);
    if (flipY) sy = src.h - 1 - sy;
    for (let x = 0; x < w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.w) continue;
      let sx = Math.floor((x * src.w) / w);
      if (flipX) sx = src.w - 1 - sx;
      put(dst, tx, ty, src, (sy * src.w + sx) * 4, map);
    }
  }
}

function put(dst: Image, x: number, y: number, src: Image, i: number, map?: PixelMap): void {
  const s = src.data;
  let r = s[i]!;
  let g = s[i + 1]!;
  let b = s[i + 2]!;
  let a = s[i + 3]!;
  if (a === 0) return;
  if (map) [r, g, b, a] = map(r, g, b, a);
  const o = (y * dst.w + x) * 4;
  const d = dst.data;
  if (a >= 255) {
    d[o] = r;
    d[o + 1] = g;
    d[o + 2] = b;
    d[o + 3] = 255;
    return;
  }
  const k = a / 255;
  d[o] = d[o]! + (r - d[o]!) * k;
  d[o + 1] = d[o + 1]! + (g - d[o + 1]!) * k;
  d[o + 2] = d[o + 2]! + (b - d[o + 2]!) * k;
  d[o + 3] = 255;
}

function fill(img: Image, x0: number, y0: number, w: number, h: number, c: RGB): void {
  blend(img, x0, y0, w, h, c, 1);
}

function blend(img: Image, x0: number, y0: number, w: number, h: number, c: RGB, k: number): void {
  const d = img.data;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x0 + w); x++) {
      const o = (y * img.w + x) * 4;
      d[o] = d[o]! + (c[0] - d[o]!) * k;
      d[o + 1] = d[o + 1]! + (c[1] - d[o + 1]!) * k;
      d[o + 2] = d[o + 2]! + (c[2] - d[o + 2]!) * k;
      d[o + 3] = 255;
    }
  }
}

function mapRect(img: Image, x0: number, y0: number, w: number, h: number, map: PixelMap): void {
  const d = img.data;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x0 + w); x++) {
      const o = (y * img.w + x) * 4;
      const [r, g, b] = map(d[o]!, d[o + 1]!, d[o + 2]!, 255);
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
    }
  }
}

function outline(img: Image, x: number, y: number, w: number, h: number, c: RGB, t: number): void {
  fill(img, x, y, w, t, c);
  fill(img, x, y + h - t, w, t, c);
  fill(img, x, y, t, h, c);
  fill(img, x + w - t, y, t, h, c);
}

/** A flat ellipse at a character's feet: the player's marker, or an enemy's. */
function ring(img: Image, dx: number, dy: number, T: number, c: RGB, k: number): void {
  const cx = dx + T / 2 - 0.5;
  const cy = dy + T * 0.86;
  const rx = T * 0.36;
  const ry = T * 0.11;
  for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) {
    for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
      const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (e <= 1.15 && e >= 0.55) blend(img, x, y, 1, 1, c, Math.max(0, Math.min(1, k)));
    }
  }
}

/** A doorway's arrow, pointing the way out. */
function arrow(img: Image, dx: number, dy: number, T: number, dir: string, c: RGB): void {
  const v: Record<string, [number, number]> = {
    north: [0, -1],
    south: [0, 1],
    east: [1, 0],
    west: [-1, 0],
    northeast: [1, -1],
    northwest: [-1, -1],
    southeast: [1, 1],
    southwest: [-1, 1],
  };
  const [ax, ay] = v[dir] ?? [0, 0];
  const cx = dx + T / 2;
  const cy = dy + T / 2;
  const len = Math.hypot(ax, ay) || 1;
  const [ux, uy] = [ax / len, ay / len];
  const size = T * 0.28;
  for (let y = dy; y < dy + T; y++) {
    for (let x = dx; x < dx + T; x++) {
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      if (!ax && !ay) {
        if (Math.abs(px) + Math.abs(py) <= size) blend(img, x, y, 1, 1, c, 0.9);
        continue;
      }
      const along = px * ux + py * uy;
      const across = Math.abs(-px * uy + py * ux);
      if (along <= size && along >= -size * 0.6 && across <= (size - along) * 0.75) blend(img, x, y, 1, 1, c, 0.9);
    }
  }
}

/** A tile drawn from glyph art: its background, and its glyph in the pixel font. */
function tileFromArt(img: Image, dx: number, dy: number, T: number, art: Art, mark = false): void {
  fill(img, dx, dy, T, T, art.bg);
  const ch = [...art.glyph].find((c) => c.trim());
  if (ch && (mark || FONT[ch.toUpperCase()])) glyph(img, dx, dy, T, ch, art.fg);
}

/** A thing without a sprite: its glyph, outlined, on whatever is under it. */
function glyphOnTile(img: Image, dx: number, dy: number, T: number, art: Art, map?: PixelMap): void {
  const ch = [...art.glyph].find((c) => c.trim()) ?? "?";
  const fg = map ? (map(...art.fg, 255).slice(0, 3) as RGB) : art.fg;
  glyph(img, dx, dy, T, ch, fg);
}

function glyph(img: Image, dx: number, dy: number, T: number, ch: string, fg: RGB): void {
  const scale = Math.max(1, Math.floor(T / 8));
  const x = dx + Math.floor((T - 3 * scale) / 2);
  const y = dy + Math.floor((T - 5 * scale) / 2);
  for (const [ox, oy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    text(img, x + ox, y + oy, ch, [10, 10, 12], scale, false);
  }
  text(img, x, y, ch, fg, scale, false);
}

// ─── Recolouring ────────────────────────────────────────────────────────────

const lightMaps = new Map<number, PixelMap>();

/** Night and darkness (the same curve as the glyph renderer's nightTint). */
function lightMap(k: number): PixelMap {
  const key = Math.round(k * 50) / 50;
  let m = lightMaps.get(key);
  if (!m) {
    const lut = Array.from({ length: 256 }, (_, v) => nightTint([v, v, v], key));
    m = (r, g, b, a) => [lut[r]![0], lut[g]![1], lut[b]![2], a];
    lightMaps.set(key, m);
  }
  return m;
}

const ghostMap: PixelMap = (r, g, b, a) => {
  const [mr, mg, mb] = mix([r, g, b], [170, 200, 255], 0.55);
  return [mr, mg, mb, Math.round(a * 0.6)];
};

const greyMap: PixelMap = (r, g, b, a) => {
  const v = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
  return [v, v, v, a];
};

function composeMaps(...maps: (PixelMap | undefined)[]): PixelMap | undefined {
  const ms = maps.filter((m): m is PixelMap => !!m);
  if (!ms.length) return undefined;
  return (r, g, b, a) => {
    let p: [number, number, number, number] = [r, g, b, a];
    for (const m of ms) p = m(...p);
    return p;
  };
}

/** A character lying down (asleep, down or dead): the sprite turned on its side, at the bottom of the tile. */
const lyingCache = new WeakMap<Image, Image>();
function lying(src: Image): Image {
  const hit = lyingCache.get(src);
  if (hit) return hit;
  const out = image(src.w, src.h);
  // Rotate 90° clockwise, then squash into the lower part of the tile.
  const rot = image(src.h, src.w);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const i = (y * src.w + x) * 4;
      const o = (x * rot.w + (rot.w - 1 - y)) * 4;
      rot.data.set(src.data.subarray(i, i + 4), o);
    }
  }
  blit(out, rot, 0, Math.floor(src.h * 0.35), src.w, Math.ceil(src.h * 0.65));
  lyingCache.set(src, out);
  return out;
}

// ─── A 3×5 pixel font for damage numbers and glyph fallbacks ───────────────

const FONT: Record<string, string> = {
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "111001111100111",
  "3": "111001111001111",
  "4": "101101111001001",
  "5": "111100111001111",
  "6": "111100111101111",
  "7": "111001010010010",
  "8": "111101111101111",
  "9": "111101111001111",
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101010",
  K: "101101110101101",
  L: "100100100100111",
  M: "101111111101101",
  N: "110101101101101",
  O: "010101101101010",
  P: "110101110100100",
  Q: "010101101110011",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  W: "101101111111101",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
  "-": "000000111000000",
  "+": "000010111010000",
  "!": "010010010000010",
  "?": "110001010000010",
  ".": "000000000000010",
  ":": "000010000010000",
  "*": "000101010101000",
  "%": "101001010100101",
  "@": "010101111100011",
  "#": "101111101111101",
  "/": "001001010100100",
  "~": "000011110000000",
  "=": "000111000111000",
  "■": "000111111111000",
  "•": "000010111010000",
};

/** Draws `s` in the pixel font, `scale` pixels a font pixel, with a dark shadow. */
export function text(img: Image, x: number, y: number, s: string, c: RGB, scale = 1, shadow = true): void {
  const pass = (off: number, colour: RGB) => {
    let cx = x;
    for (const raw of s) {
      const bits = FONT[raw.toUpperCase()] ?? FONT["■"]!;
      for (let i = 0; i < 15; i++) {
        if (bits[i] === "1")
          fill(img, cx + (i % 3) * scale + off, y + Math.floor(i / 3) * scale + off, scale, scale, colour);
      }
      cx += 4 * scale;
    }
  };
  if (shadow) pass(scale, [12, 10, 10]);
  pass(0, c);
}
