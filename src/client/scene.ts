/**
 * The scene renderer: the player's room on a Canvas 2D, in the manner of Ultima V, shared verbatim by the web and
 * native hosts. Sprite art (sprites.ts) is drawn at a whole-number scale with smoothing off; anything without a
 * sprite is drawn from its tile art (art.ts) as a glyph on a coloured tile, so a payload without art still plays.
 * Night, dark rooms, ghosts and the dead recolour sprites through a scratch canvas, cached.
 */

import type { Tile, ViewOf } from "../engine/session/port.js";
import {
  type Art,
  css,
  exitArt,
  lighting,
  mix,
  nightTint,
  type RGB,
  terrainArt,
  thingArt,
  tileHash,
  VOID,
} from "./art.js";
import type { Canvas2D, CanvasImage, Rect, Scratch } from "./canvas.js";
import { frameAt, type Sprite, type SpriteFrame, type SpriteSheet } from "./sprites.js";
import { font } from "./theme.js";
import { type AnimFrame, apparitionShows, type SceneLayout, sceneLayout } from "./timeline.js";

export type Scene = ViewOf<"scene">;

export interface SceneOptions<I extends CanvasImage> {
  /** Animation time in ms (water, idle frames, flicker, the cursor's blink); any steady clock. */
  t: number;
  /** For recolouring sprites; required with `sprites`. */
  scratch: Scratch<I>;
  /** The payload's sprite art. Without it every tile is drawn from its glyph art. */
  sprites?: SpriteSheet<I>;
  /** This turn's animation (GameClient.frame). */
  frame?: AnimFrame;
  /** The targeting cursor, in map tiles (Model.targeting.cursor). */
  cursor?: Tile;
  /** Highlight the tiles around the player (a direction prompt). */
  around?: boolean;
  /** Draw glyph-art things as their emoji, where they have one (the host has an emoji font). */
  emoji?: boolean;
  /** The biggest whole-number scale for the art (default 4). */
  maxScale?: number;
}

/** Pixels a tile in the glyph art, when the payload ships no sprites. */
export const GLYPH_TILE = 32;

/** Where the scene would land in `r`, for hit-testing clicks with `tileAt` (scene.ts draws with the same layout). */
export function layoutFor<I extends CanvasImage>(
  r: Rect,
  scene: Scene,
  o: Pick<SceneOptions<I>, "sprites" | "frame" | "maxScale">,
): SceneLayout {
  return sceneLayout(r, scene, {
    art: o.sprites?.tile ?? GLYPH_TILE,
    ...(o.frame ? { frame: o.frame } : {}),
    ...(o.maxScale ? { maxScale: o.maxScale } : {}),
  });
}

/** Draws the scene into `r` and returns where it put the tiles. */
export function drawScene<I extends CanvasImage>(
  ctx: Canvas2D<I>,
  r: Rect,
  scene: Scene,
  o: SceneOptions<I>,
): SceneLayout {
  const l = layoutFor(r, scene, o);
  const T = l.tile;
  const sprites = o.sprites;
  const px = (p: Tile): [number, number] => [l.x + (l.ox + p[0]) * T, l.y + (l.oy + p[1]) * T];
  const inView = (p: Tile) => {
    const x = l.ox + p[0];
    const y = l.oy + p[1];
    return x >= 0 && y >= 0 && x < l.tilesW && y < l.tilesH;
  };
  const light = (p: Tile) => lighting(scene, p[0], p[1], l.playerAt);
  const ground = new Map<string, Art>();
  const under = (p: Tile): Art => ground.get(`${p[0]},${p[1]}`) ?? { glyph: "  ", fg: VOID, bg: VOID };
  const g = new Painter(ctx, T, o);

  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  g.fill(r.x, r.y, r.w, r.h, VOID);

  // Terrain.
  for (let y = 0; y < scene.h; y++) {
    for (let x = 0; x < scene.w; x++) {
      if (!inView([x, y])) continue;
      const kind = scene.terrain[y]![x]!;
      const look = scene.looks[`${x},${y}`];
      const art = terrainArt(kind, x, y, o.t, look);
      ground.set(`${x},${y}`, art);
      const [dx, dy] = px([x, y]);
      const sprite = sprites?.get(look?.sprite) ?? sprites?.get(`terrain/${kind}`);
      if (sprite) g.terrain(sprite, dx, dy, x, y, !UNFLIPPED.has(kind));
      else g.tile(dx, dy, art);
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
    const sprite = sprites?.get(key);
    if (sprite) g.image(frameAt(sprite, o.t), dx, dy, T, T);
    else if (key === "exit/doorway" || key === "exit/door-open") {
      g.fill(dx, dy, T, T, [230, 215, 170], 0.22);
      g.arrow(dx, dy, dir, [250, 235, 170]);
    } else g.tile(dx, dy, exitArt(x, under(x.pos)));
  }

  // Fixed things and items.
  for (const t of scene.things) {
    if (t.kind === "character") continue;
    const tiles = t.tiles.length ? t.tiles : [t.pos];
    if (!tiles.some(inView)) continue;
    const sprite = sprites?.get(t.look?.sprite) ?? sprites?.get(`object/${t.id}`);
    if (sprite?.fit === "span") {
      const xs = tiles.map((p) => p[0]);
      const ys = tiles.map((p) => p[1]);
      const [dx, dy] = px([Math.min(...xs), Math.min(...ys)]);
      const w = (Math.max(...xs) - Math.min(...xs) + 1) * T;
      const h = (Math.max(...ys) - Math.min(...ys) + 1) * T;
      g.image(frameAt(sprite, o.t, phase(t.id)), dx, dy, w, h);
      continue;
    }
    for (const p of tiles) {
      if (!inView(p)) continue;
      const [dx, dy] = px(p);
      if (sprite) g.image(frameAt(sprite, o.t, phase(t.id) + p[0] + p[1]), dx, dy, T, T);
      else g.glyph(dx, dy, thingArt(t, under(p), 0));
    }
  }

  // Light falls on the room before the people are drawn; the player is always lit.
  for (let y = 0; y < scene.h; y++) {
    for (let x = 0; x < scene.w; x++) {
      const k = light([x, y]);
      if (k < 1 && inView([x, y])) g.shade(...px([x, y]), T, T, k);
    }
  }

  // Characters.
  scene.things
    .filter((t) => t.kind === "character")
    .forEach((t, i) => {
      const p = o.frame?.pos.get(t.id) ?? t.pos;
      if (!inView(p)) return;
      if (t.apparition && !apparitionShows(t, o.t)) return;
      const [dx, dy] = px(p);
      const k = t.player ? 1 : light(p);
      if (t.player) g.ring(dx, dy, [120, 220, 255], 0.45 + 0.25 * Math.sin(o.t / 260));
      else if (t.side === "b") g.ring(dx, dy, [230, 60, 40], 0.7);
      const sprite = sprites?.get(t.look?.sprite) ?? sprites?.get(`character/${t.id}`);
      const walking = o.frame?.pos.has(t.id) ?? false;
      const look = { ghost: !!t.apparition, grey: t.status === "dead", light: k };
      if (sprite) {
        const f = g.recolour(frameAt(sprite, walking ? o.t * 2 : o.t, phase(t.id)), look);
        ctx.globalAlpha = t.apparition ? 0.6 : 1;
        if (t.status && t.status !== "ok") g.lying(f, dx, dy);
        else g.image(f, dx, dy, T, T);
        ctx.globalAlpha = 1;
      } else {
        let art = thingArt(t, under(p), i);
        if (t.apparition) art = { ...art, fg: mix(art.fg, [170, 200, 255], 0.55) };
        if (t.status === "dead") art = { ...art, fg: grey(art.fg) };
        g.glyph(dx, dy, { ...art, fg: k < 1 ? nightTint(art.fg, k) : art.fg }, t.apparition ? 0.6 : 1);
      }
      if (t.status === "asleep") g.text("z", dx + T - T / 6, dy + T / 6 - ((o.t / 400) % 3), [190, 200, 255], T / 3);
    });

  // The direction prompt and the targeting cursor, then shots, hits and damage numbers over them.
  if (o.around && l.playerAt) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const p: Tile = [l.playerAt[0] + dx, l.playerAt[1] + dy];
        if ((dx || dy) && inView(p)) g.fill(...px(p), T, T, [255, 230, 120], 0.25 + 0.1 * Math.sin(o.t / 200));
      }
    }
  }
  if (o.cursor && inView(o.cursor)) {
    const on = Math.floor(o.t / 300) % 2 === 0;
    const [dx, dy] = px(o.cursor);
    g.fill(dx, dy, T, T, on ? [255, 220, 60] : [255, 255, 255], on ? 0.3 : 0.15);
    g.outline(dx, dy, T, T, [255, 220, 60], Math.max(1, Math.floor(T / 16)));
  }
  for (const shot of o.frame?.shots ?? []) {
    if (!inView(shot.at)) continue;
    const [dx, dy] = px(shot.at);
    const s = Math.max(2, Math.floor(T / 8));
    g.fill(dx + T / 2 - s, dy + T / 2 - s, s * 2, s * 2, [255, 240, 180]);
  }
  for (const m of o.frame?.marks ?? []) {
    if (!inView(m.at)) continue;
    const [dx, dy] = px(m.at);
    const sprite = sprites?.get(`fx/${m.kind}`);
    if (sprite) g.image(frameAt(sprite, o.t), dx, dy, T, T);
    else g.glyph(dx, dy, { glyph: m.glyph, fg: m.fg, bg: VOID, emoji: m.emoji, bold: true });
  }
  for (const f of o.frame?.floats ?? []) {
    if (!inView(f.at)) continue;
    const [dx, dy] = px(f.at);
    g.text(f.text, dx + T / 2, dy + T / 3 - Math.floor(f.rise * T * 0.6), f.fg, Math.max(10, T / 2.5));
  }
  ctx.restore();
  return l;
}

/** Terrains whose art has an up and a down (or a left and right) and so are never mirrored for variety. */
const UNFLIPPED = new Set(["wall", "window", "stairs", "railing", "fence"]);

const phase = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 7;
};

const grey = (c: RGB): RGB => {
  const v = Math.round(0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]);
  return [v, v, v];
};

/** How a sprite is recoloured: an apparition's blue, the greyness of the dead, and the light it stands in. */
interface Recolour {
  ghost: boolean;
  grey: boolean;
  light: number;
}

/** Recoloured frames, by source image and frame, recolour and light (to 1/50). */
const variants = new WeakMap<CanvasImage, Map<string, SpriteFrame<CanvasImage>>>();
const VARIANTS_PER_IMAGE = 256;

/** Drawing helpers over one context, at one tile size. */
class Painter<I extends CanvasImage> {
  constructor(
    private readonly ctx: Canvas2D<I>,
    private readonly T: number,
    private readonly o: SceneOptions<I>,
  ) {}

  fill(x: number, y: number, w: number, h: number, c: RGB, alpha = 1): void {
    this.ctx.fillStyle = css(c, alpha);
    this.ctx.fillRect(x, y, w, h);
  }

  outline(x: number, y: number, w: number, h: number, c: RGB, t: number): void {
    this.fill(x, y, w, t, c);
    this.fill(x, y + h - t, w, t, c);
    this.fill(x, y, t, h, c);
    this.fill(x + w - t, y, t, h, c);
  }

  image(f: SpriteFrame<I>, dx: number, dy: number, w: number, h: number): void {
    this.ctx.drawImage(f.image, f.sx, f.sy, f.w, f.h, dx, dy, w, h);
  }

  /** Night and darkness: the tile multiplied by the night tint of white (the curve of art.ts nightTint). */
  shade(x: number, y: number, w: number, h: number, k: number): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "multiply";
    this.fill(x, y, w, h, nightTint([255, 255, 255], k));
    ctx.globalCompositeOperation = "source-over";
  }

  /** A terrain texture: mirrored at random for variety, or sliding sideways (water). */
  terrain(s: Sprite<I>, dx: number, dy: number, x: number, y: number, vary: boolean): void {
    const T = this.T;
    const h = tileHash(x, y);
    const f = frameAt(s, this.o.t, h % 5);
    if (s.anim === "scroll") {
      const shift = Math.floor(this.o.t / 140 + y * 3) % f.w;
      const k = T / f.w;
      this.image({ ...f, sx: f.sx + shift, w: f.w - shift }, dx, dy, (f.w - shift) * k, T);
      if (shift) this.image({ ...f, w: shift }, dx + (f.w - shift) * k, dy, shift * k, T);
      return;
    }
    const fx = vary && (h & 1) === 1;
    const fy = vary && (h & 2) === 2;
    if (!fx && !fy) {
      this.image(f, dx, dy, T, T);
      return;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(dx + (fx ? T : 0), dy + (fy ? T : 0));
    ctx.scale(fx ? -1 : 1, fy ? -1 : 1);
    this.image(f, 0, 0, T, T);
    ctx.restore();
  }

  /** A character lying down (asleep, down or dead): turned on its side, at the foot of the tile. */
  lying(f: SpriteFrame<I>, dx: number, dy: number): void {
    const T = this.T;
    const w = T;
    const h = Math.ceil(T * 0.65);
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(dx + w / 2, dy + T - h / 2);
    ctx.rotate(Math.PI / 2);
    this.image(f, -h / 2, -w / 2, h, w);
    ctx.restore();
  }

  /** A frame recoloured through the scratch canvas (cached), or the frame itself when it needs none. */
  recolour(f: SpriteFrame<I>, r: Recolour): SpriteFrame<I> {
    const k = Math.round(r.light * 50) / 50;
    if (!r.ghost && !r.grey && k >= 1) return f;
    const key = `${f.sx},${f.sy},${f.w},${f.h},${r.ghost ? "g" : ""}${r.grey ? "d" : ""}${k}`;
    const cache = variants.get(f.image) ?? new Map<string, SpriteFrame<CanvasImage>>();
    variants.set(f.image, cache);
    const hit = cache.get(key) as SpriteFrame<I> | undefined;
    if (hit) return hit;
    const { ctx, image } = this.o.scratch(f.w, f.h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(f.image, f.sx, f.sy, f.w, f.h, 0, 0, f.w, f.h);
    const wash = (op: string, c: RGB, alpha = 1) => {
      ctx.globalCompositeOperation = op;
      ctx.fillStyle = css(c, alpha);
      ctx.fillRect(0, 0, f.w, f.h);
    };
    if (r.grey) wash("saturation", [128, 128, 128]);
    if (r.ghost) wash("source-atop", [170, 200, 255], 0.55);
    if (k < 1) wash("multiply", nightTint([255, 255, 255], k));
    // Blending paints the transparent pixels too: cut the sprite's shape back out.
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(f.image, f.sx, f.sy, f.w, f.h, 0, 0, f.w, f.h);
    ctx.globalCompositeOperation = "source-over";
    const out = { image, sx: 0, sy: 0, w: f.w, h: f.h };
    if (cache.size >= VARIANTS_PER_IMAGE) cache.clear();
    cache.set(key, out);
    return out;
  }

  /** A tile drawn from glyph art: its background, and its glyph. */
  tile(dx: number, dy: number, art: Art): void {
    this.fill(dx, dy, this.T, this.T, art.bg);
    this.glyph(dx, dy, art, 1, false);
  }

  /** A glyph (or emoji) centred on a tile, outlined in black so it reads on any ground. */
  glyph(dx: number, dy: number, art: Art, alpha = 1, outlined = true): void {
    const T = this.T;
    const ch = this.o.emoji && art.emoji ? art.emoji : art.glyph.trim();
    if (!ch) return;
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.font = font(Math.round(T * (ch.length > 1 && !art.emoji ? 0.45 : 0.6)), { bold: !!art.bold || outlined });
    const cx = dx + T / 2;
    const cy = dy + T / 2;
    if (outlined) {
      const o = Math.max(1, Math.round(T / 32));
      ctx.fillStyle = css([10, 10, 12]);
      for (const [ox, oy] of [
        [-o, 0],
        [o, 0],
        [0, -o],
        [0, o],
      ] as const) {
        ctx.fillText(ch, cx + ox, cy + oy);
      }
    }
    ctx.fillStyle = css(art.fg);
    ctx.fillText(ch, cx, cy);
    ctx.globalAlpha = 1;
  }

  /** Bold text centred on (x, y) with a drop shadow: damage numbers and the sleeper's z. */
  text(s: string, x: number, y: number, c: RGB, size: number): void {
    const ctx = this.ctx;
    const shadow = Math.max(1, Math.round(size / 10));
    ctx.font = font(Math.round(size), { bold: true });
    ctx.fillStyle = css([12, 10, 10]);
    ctx.fillText(s, x + shadow, y + shadow);
    ctx.fillStyle = css(c);
    ctx.fillText(s, x, y);
  }

  /** A flat ellipse at a character's feet: the player's marker, or an enemy's. */
  ring(dx: number, dy: number, c: RGB, k: number): void {
    const T = this.T;
    const ctx = this.ctx;
    ctx.strokeStyle = css(c, Math.max(0, Math.min(1, k)));
    ctx.lineWidth = Math.max(1, T / 16);
    ctx.beginPath();
    ctx.ellipse(dx + T / 2, dy + T * 0.86, T * 0.33, T * 0.1, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** A doorway's arrow, pointing the way out (a diamond when it has no direction). */
  arrow(dx: number, dy: number, dir: string, c: RGB): void {
    const T = this.T;
    const [ax, ay] = COMPASS[dir] ?? [0, 0];
    const cx = dx + T / 2;
    const cy = dy + T / 2;
    const size = T * 0.28;
    const ctx = this.ctx;
    ctx.fillStyle = css(c, 0.9);
    ctx.beginPath();
    if (!ax && !ay) {
      ctx.moveTo(cx, cy - size);
      ctx.lineTo(cx + size, cy);
      ctx.lineTo(cx, cy + size);
      ctx.lineTo(cx - size, cy);
    } else {
      const len = Math.hypot(ax, ay);
      const [ux, uy] = [ax / len, ay / len];
      const back = size * 0.6;
      const half = (size + back) * 0.75;
      ctx.moveTo(cx + ux * size, cy + uy * size);
      ctx.lineTo(cx - ux * back - uy * half, cy - uy * back + ux * half);
      ctx.lineTo(cx - ux * back + uy * half, cy - uy * back - ux * half);
    }
    ctx.closePath();
    ctx.fill();
  }
}

const COMPASS: Record<string, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  northeast: [1, -1],
  northwest: [-1, -1],
  southeast: [1, 1],
  southwest: [-1, 1],
};
