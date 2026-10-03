/**
 * Sprite art. A payload may ship `assets/sprites.json` next to its YAML: a manifest of PNG strips (frames side by
 * side), keyed `terrain/<kind>`, `object/<id>`, `character/<id>`, `exit/<kind>` or `fx/<kind>`. A `look.sprite`
 * (§7.10) names any key instead. Like `look`, the engine never reads any of it. Hosts decode the PNGs (to an
 * ImageBitmap or a Skia Image); the client only cuts frames out of them by rectangle.
 */

import type { Assets } from "../platform/index.js";
import type { CanvasImage } from "./canvas.js";

export interface SpriteEntry {
  /** A PNG next to the manifest. */
  file: string;
  /** Frames side by side in the file (default 1). */
  frames?: number;
  /** Animation speed in frames a second (default 4). */
  fps?: number;
  /**
   * `tile` (default) draws the sprite on every tile the thing covers; `span` stretches it over their bounding box
   * (beds, bars, sofas).
   */
  fit?: "tile" | "span";
  /** `scroll` slides a terrain texture sideways over time (water). */
  anim?: "loop" | "scroll";
}

export interface SpriteManifest {
  /** Pixels a tile, e.g. 32. */
  tile: number;
  sprites: Record<string, SpriteEntry>;
}

/** One frame: a rectangle of a decoded image. */
export interface SpriteFrame<I extends CanvasImage> {
  image: I;
  sx: number;
  sy: number;
  w: number;
  h: number;
}

export interface Sprite<I extends CanvasImage> {
  key: string;
  frames: SpriteFrame<I>[];
  fps: number;
  fit: "tile" | "span";
  anim: "loop" | "scroll";
}

/** Turns PNG bytes into an image the host's canvas can draw. */
export type Decode<I extends CanvasImage> = (bytes: Uint8Array) => Promise<I>;

export class SpriteSheet<I extends CanvasImage> {
  private readonly sprites = new Map<string, Sprite<I>>();

  constructor(readonly tile: number) {}

  /** Reads `sprites.json` and its PNGs from the payload's assets, or resolves undefined if it ships none. */
  static async load<I extends CanvasImage>(assets: Assets, decode: Decode<I>): Promise<SpriteSheet<I> | undefined> {
    const text = await assets.text("sprites.json");
    if (!text) return undefined;
    const manifest = JSON.parse(text) as SpriteManifest;
    const sheet = new SpriteSheet<I>(manifest.tile);
    const images = new Map<string, Promise<I>>();
    const image = (file: string) => {
      let p = images.get(file);
      if (!p) {
        p = assets.bytes(file).then((bytes) => {
          if (!bytes) throw new Error(`sprites.json names ${file}, which is missing`);
          return decode(bytes);
        });
        images.set(file, p);
      }
      return p;
    };
    const entries = Object.entries(manifest.sprites);
    const decoded = await Promise.all(entries.map(([, e]) => image(e.file)));
    entries.forEach(([key, e], i) => {
      sheet.add(key, decoded[i]!, e);
    });
    return sheet;
  }

  /** Adds a sprite cut from a strip of `entry.frames` frames. */
  add(key: string, image: I, entry: Omit<SpriteEntry, "file"> = {}): void {
    const n = Math.max(1, entry.frames ?? 1);
    const w = Math.floor(image.width / n);
    const frames = Array.from({ length: n }, (_, i) => ({ image, sx: i * w, sy: 0, w, h: image.height }));
    this.sprites.set(key, { key, frames, fps: entry.fps ?? 4, fit: entry.fit ?? "tile", anim: entry.anim ?? "loop" });
  }

  get(key: string | undefined): Sprite<I> | undefined {
    return key ? this.sprites.get(key) : undefined;
  }

  has(key: string): boolean {
    return this.sprites.has(key);
  }

  get size(): number {
    return this.sprites.size;
  }
}

/** The frame of `s` to show at `ms`, offset by `phase` so neighbours don't move in lockstep. */
export function frameAt<I extends CanvasImage>(s: Sprite<I>, ms: number, phase = 0): SpriteFrame<I> {
  return s.frames[(Math.floor((ms * s.fps) / 1000) + phase) % s.frames.length]!;
}
