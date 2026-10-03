/**
 * Sprite art for the TUI's image mode. A payload may ship `assets/sprites.json` next to its YAML: a manifest of PNG
 * strips (frames side by side), keyed `terrain/<kind>`, `object/<id>`, `character/<id>`, `exit/<kind>` or `fx/<kind>`.
 * A `look.sprite` (§7.10) names any key instead. Like `look`, the engine never reads any of it.
 */

import { decodePng, type Image, image } from "./png.js";

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

export interface Sprite {
  key: string;
  frames: Image[];
  fps: number;
  fit: "tile" | "span";
  anim: "loop" | "scroll";
}

export class SpriteSet {
  private readonly sprites = new Map<string, Sprite>();

  constructor(readonly tile: number) {}

  /** Builds a set from a manifest, reading each PNG (a path relative to the manifest) with `read`. */
  static fromManifest(manifest: SpriteManifest, read: (file: string) => Uint8Array): SpriteSet {
    const set = new SpriteSet(manifest.tile);
    const sheets = new Map<string, Image>();
    for (const [key, e] of Object.entries(manifest.sprites)) {
      let sheet = sheets.get(e.file);
      if (!sheet) {
        sheet = decodePng(read(e.file));
        sheets.set(e.file, sheet);
      }
      set.add(key, sheet, e);
    }
    return set;
  }

  /** Adds a sprite cut from a strip of `entry.frames` frames. */
  add(key: string, sheet: Image, entry: Omit<SpriteEntry, "file"> = {}): void {
    const n = Math.max(1, entry.frames ?? 1);
    const fw = Math.floor(sheet.w / n);
    const frames = Array.from({ length: n }, (_, i) => crop(sheet, i * fw, 0, fw, sheet.h));
    this.sprites.set(key, { key, frames, fps: entry.fps ?? 4, fit: entry.fit ?? "tile", anim: entry.anim ?? "loop" });
  }

  get(key: string | undefined): Sprite | undefined {
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
export function frameAt(s: Sprite, ms: number, phase = 0): Image {
  return s.frames[(Math.floor((ms * s.fps) / 1000) + phase) % s.frames.length]!;
}

export function crop(src: Image, x0: number, y0: number, w: number, h: number): Image {
  const out = image(w, h);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * src.w + x0) * 4;
    out.data.set(src.data.subarray(from, from + w * 4), y * w * 4);
  }
  return out;
}
