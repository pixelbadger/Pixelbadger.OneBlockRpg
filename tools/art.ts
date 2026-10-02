/**
 * Sprite art for a payload, generated with OpenAI's image API from an art brief (`<payload>/assets/art.yaml`).
 * Development tooling, not part of the engine: the engine and the TUI only read the PNGs and sprites.json it writes.
 *
 *   OPENAI_API_KEY=… pnpm art examples/the-pier [--only key,key] [--force] [--reprocess] [--concurrency 4] [--dry-run]
 *
 * Raw images are cached in `assets/.raw/` (git-ignored), so `--reprocess` re-cuts sprites without new API calls and
 * a run only generates what is missing. Behind an HTTPS proxy, run with NODE_USE_ENV_PROXY=1.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { decodePng, encodePng, type Image, image } from "../src/cli/tui/png.js";
import type { SpriteEntry, SpriteManifest } from "../src/cli/tui/sprites.js";

export type ArtKind = "texture" | "object" | "character" | "effect";

export interface ArtSprite {
  kind?: ArtKind;
  prompt?: string;
  /** Tiles across and down, for a thing stretched over several (beds, sofas). */
  span?: [number, number];
  /** Character frames (default 4). */
  frames?: number;
  fps?: number;
  anim?: "loop" | "scroll";
  /** Reuse another sprite's art. */
  same?: string;
}

export interface ArtBrief {
  tile: number;
  model?: string;
  quality?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
  style: string;
  sprites: Record<string, ArtSprite>;
}

const FRAMING: Record<ArtKind, string> = {
  texture:
    "A seamless, tileable square texture that fills the whole image edge to edge, seen from directly above. " +
    "The whole image is a single 32 by 32 pixel game tile enlarged, so draw it with very big square pixels and " +
    "only a few large, bold, high-contrast features (for example three or four planks, slabs or stripes across, " +
    "a handful of stones) that still read when shrunk to 32 pixels. " +
    "No objects, no border, no frame, no background around it.",
  object:
    "A single object seen from a three-quarter top-down view, as in a classic tile-based RPG, centred and filling " +
    "most of the image, on a fully transparent background. No ground, no shadow, no text, no border.",
  character:
    "A sprite sheet: exactly {n} frames of the same character side by side in one horizontal row, evenly spaced " +
    "with clear transparent gaps between them. Each frame is a full-body figure facing the viewer in a walking " +
    "cycle (left foot forward, standing, right foot forward, standing). Identical character, colours and size in " +
    "every frame, feet on the same line. Fully transparent background, no ground, no shadow, no text, no grid lines.",
  effect: "A single small effect, centred in the image, on a fully transparent background. No text, no border.",
};

export function promptFor(brief: ArtBrief, s: ArtSprite): string {
  const kind = s.kind ?? "object";
  const framing = FRAMING[kind].replace("{n}", String(s.frames ?? 4));
  return `${brief.style}\n\n${framing}\n\nSubject: ${s.prompt ?? ""}`;
}

const sizeFor = (s: ArtSprite) =>
  s.kind === "character" || (s.span && s.span[0] > s.span[1]) ? "1536x1024" : "1024x1024";

const fileFor = (key: string) => `${key.replace(/[^a-z0-9/_-]/gi, "_")}.png`;

// ─── Image processing ───────────────────────────────────────────────────────

/** Area-average downscale (premultiplied, so transparent edges don't go dark). */
export function downsample(src: Image, w: number, h: number): Image {
  const out = image(w, h);
  const sx = src.w / w;
  const sy = src.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < src.h; yy++) {
        for (let xx = x0; xx < x1 && xx < src.w; xx++) {
          const i = (yy * src.w + xx) * 4;
          const al = src.data[i + 3]!;
          r += src.data[i]! * al;
          g += src.data[i + 1]! * al;
          b += src.data[i + 2]! * al;
          a += al;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = Math.round(a / Math.max(1, n));
    }
  }
  return out;
}

/**
 * If the model drew an opaque background anyway, removes the colour that touches the border (flood fill from the
 * edges, within a tolerance).
 */
export function removeBackground(img: Image, tolerance = 48): Image {
  const d = img.data;
  const n = img.w * img.h;
  let clear = 0;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3]! < 200) clear++;
  if (clear > n * 0.02) return img;
  const out: Image = { w: img.w, h: img.h, data: new Uint8Array(d) };
  const border: number[] = [];
  for (let x = 0; x < img.w; x++) border.push(x, (img.h - 1) * img.w + x);
  for (let y = 0; y < img.h; y++) border.push(y * img.w, y * img.w + img.w - 1);
  const avg = [0, 0, 0];
  for (const p of border) for (let c = 0; c < 3; c++) avg[c]! += d[p * 4 + c]!;
  for (let c = 0; c < 3; c++) avg[c]! /= border.length;
  const near = (p: number) =>
    Math.abs(d[p * 4]! - avg[0]!) + Math.abs(d[p * 4 + 1]! - avg[1]!) + Math.abs(d[p * 4 + 2]! - avg[2]!) <=
    tolerance * 1.5;
  const seen = new Uint8Array(n);
  const stack = border.filter(near);
  while (stack.length) {
    const p = stack.pop()!;
    if (seen[p]) continue;
    seen[p] = 1;
    out.data[p * 4 + 3] = 0;
    const x = p % img.w;
    const y = (p - x) / img.w;
    if (x > 0 && !seen[p - 1] && near(p - 1)) stack.push(p - 1);
    if (x < img.w - 1 && !seen[p + 1] && near(p + 1)) stack.push(p + 1);
    if (y > 0 && !seen[p - img.w] && near(p - img.w)) stack.push(p - img.w);
    if (y < img.h - 1 && !seen[p + img.w] && near(p + img.w)) stack.push(p + img.w);
  }
  return out;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The bounding box of pixels more opaque than `min` within `area` (undefined if none). */
export function bbox(img: Image, area: Box = { x: 0, y: 0, w: img.w, h: img.h }, min = 40): Box | undefined {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = area.y; y < area.y + area.h; y++) {
    for (let x = area.x; x < area.x + area.w; x++) {
      if (img.data[(y * img.w + x) * 4 + 3]! > min) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function cropImage(src: Image, b: Box): Image {
  const out = image(b.w, b.h);
  for (let y = 0; y < b.h; y++) {
    const from = ((b.y + y) * src.w + b.x) * 4;
    out.data.set(src.data.subarray(from, from + b.w * 4), y * b.w * 4);
  }
  return out;
}

/** Draws `src` into `dst` at (x, y), keeping whatever is opaque. */
function paste(dst: Image, src: Image, x: number, y: number): void {
  for (let yy = 0; yy < src.h; yy++) {
    for (let xx = 0; xx < src.w; xx++) {
      const tx = x + xx;
      const ty = y + yy;
      if (tx < 0 || ty < 0 || tx >= dst.w || ty >= dst.h) continue;
      const i = (yy * src.w + xx) * 4;
      if (src.data[i + 3] === 0) continue;
      dst.data.set(src.data.subarray(i, i + 4), (ty * dst.w + tx) * 4);
    }
  }
}

/** Hard alpha, as pixel art has: each pixel is there or not. */
export function crispAlpha(img: Image, cut = 110): Image {
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i]! >= cut ? 255 : 0;
  return img;
}

/** Fits the opaque part of `src`, scaled by `scale`, into a `w`×`h` box: centred, on its bottom edge unless `middle`. */
function place(src: Image, b: Box, scale: number, w: number, h: number, middle: boolean): Image {
  const sw = Math.max(1, Math.min(w, Math.round(b.w * scale)));
  const sh = Math.max(1, Math.min(h, Math.round(b.h * scale)));
  const small = crispAlpha(downsample(cropImage(src, b), sw, sh));
  const out = image(w, h);
  paste(out, small, Math.floor((w - sw) / 2), middle ? Math.floor((h - sh) / 2) : h - sh);
  return out;
}

/** A thing on a transparent ground, fitted into `w`×`h` with a pixel to spare. */
export function cutObject(raw: Image, w: number, h: number, middle = false): Image {
  const img = removeBackground(raw);
  const b = bbox(img) ?? { x: 0, y: 0, w: img.w, h: img.h };
  const scale = Math.min((w - 2) / b.w, (h - 1) / b.h);
  return place(img, b, scale, w, h, middle);
}

/** A texture: the middle of the image, scaled to a tile and made to wrap at its edges. */
export function cutTexture(raw: Image, T: number): Image {
  const inset = Math.floor(Math.min(raw.w, raw.h) * 0.04);
  const side = Math.min(raw.w, raw.h) - inset * 2;
  const square = cropImage(raw, {
    x: Math.floor((raw.w - side) / 2),
    y: Math.floor((raw.h - side) / 2),
    w: side,
    h: side,
  });
  const small = downsample(square, T, T);
  for (let i = 3; i < small.data.length; i += 4) small.data[i] = 255;
  return seamless(small);
}

/** Blends a texture with itself shifted by half, towards the edges, so tiles join without a seam. */
export function seamless(img: Image): Image {
  const { w, h } = img;
  const out = image(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ex = Math.abs(x + 0.5 - w / 2) / (w / 2);
      const ey = Math.abs(y + 0.5 - h / 2) / (h / 2);
      // Shifted copy near the edges, the original in the middle.
      const k = Math.min(1, Math.max(0, (Math.max(ex, ey) - 0.55) / 0.45));
      const i = (y * w + x) * 4;
      const j = (((y + h / 2) % h) * w + ((x + w / 2) % w)) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(img.data[i + c]! * (1 - k) + img.data[j + c]! * k);
      out.data[i + 3] = 255;
    }
  }
  return out;
}

/**
 * A character strip: finds the `n` figures in a sheet (by the gaps between them, or equal slices if that fails)
 * and scales them alike, feet on the tile's bottom edge.
 */
export function cutCharacter(raw: Image, n: number, T: number): Image {
  const img = removeBackground(raw);
  const cols: boolean[] = [];
  for (let x = 0; x < img.w; x++) {
    let any = false;
    for (let y = 0; y < img.h && !any; y++) any = img.data[(y * img.w + x) * 4 + 3]! > 40;
    cols.push(any);
  }
  let runs: { x: number; w: number }[] = [];
  for (let x = 0; x < cols.length; ) {
    if (!cols[x]) {
      x++;
      continue;
    }
    const start = x;
    while (x < cols.length && cols[x]) x++;
    runs.push({ x: start, w: x - start });
  }
  // Ignore specks; take the n widest figures, left to right.
  runs = runs.filter((r) => r.w > img.w * 0.02);
  if (runs.length >= n)
    runs = [...runs]
      .sort((a, b) => b.w - a.w)
      .slice(0, n)
      .sort((a, b) => a.x - b.x);
  else runs = Array.from({ length: n }, (_, i) => ({ x: Math.floor((i * img.w) / n), w: Math.floor(img.w / n) }));
  const boxes = runs.map((r) => bbox(img, { x: r.x, y: 0, w: r.w, h: img.h }) ?? { x: r.x, y: 0, w: r.w, h: img.h });
  const scale = Math.min(...boxes.map((b) => Math.min((T - 2) / b.w, (T - 1) / b.h)));
  const strip = image(T * n, T);
  boxes.forEach((b, i) => {
    paste(strip, place(img, b, scale, T, T, false), i * T, 0);
  });
  return strip;
}

/** Cuts one sprite from its raw image, as the brief describes it. */
export function cut(raw: Image, s: ArtSprite, T: number): Image {
  switch (s.kind ?? "object") {
    case "texture":
      return cutTexture(raw, T);
    case "character":
      return cutCharacter(raw, s.frames ?? 4, T);
    case "effect":
      return cutObject(raw, T, T, true);
    default: {
      const [w, h] = s.span ?? [1, 1];
      return cutObject(raw, w * T, h * T);
    }
  }
}

export function manifestEntry(s: ArtSprite, file: string): SpriteEntry {
  const e: SpriteEntry = { file };
  if (s.kind === "character") {
    e.frames = s.frames ?? 4;
    e.fps = s.fps ?? 4;
  } else if (s.fps) e.fps = s.fps;
  if (s.span) e.fit = "span";
  if (s.anim) e.anim = s.anim;
  return e;
}

// ─── The OpenAI image API ───────────────────────────────────────────────────

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
}

async function generate(brief: ArtBrief, s: ArtSprite, key: string): Promise<{ png: Uint8Array; usage: Usage }> {
  const body = {
    model: brief.model ?? "gpt-image-2.5-flare",
    prompt: promptFor(brief, s),
    size: sizeFor(s),
    quality: brief.quality ?? "medium",
    background: s.kind === "texture" ? "opaque" : "transparent",
    output_format: "png",
    n: 1,
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: { b64_json?: string }[]; usage?: Usage };
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error("no image in the response");
      return { png: Buffer.from(b64, "base64"), usage: json.usage ?? {} };
    }
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 8) {
      // Image rate limits are per minute: wait as long as the API asks ("try again in 12s"), else back off.
      const asked = Number(res.headers.get("retry-after")) || Number(/try again in ([\d.]+)s/.exec(text)?.[1]);
      const wait = asked ? asked * 1000 + 1000 + Math.random() * 2000 : Math.min(60_000, 2000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  }
}

async function pool<T>(items: T[], n: number, work: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) await work(t);
    }),
  );
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      only: { type: "string" },
      force: { type: "boolean" },
      reprocess: { type: "boolean" },
      "dry-run": { type: "boolean" },
      concurrency: { type: "string", default: "4" },
    },
  });
  const payload = positionals[0];
  if (!payload) {
    console.error("usage: pnpm art <payload> [--only key,key] [--force] [--reprocess] [--dry-run] [--concurrency n]");
    return 2;
  }
  const dir = join(payload, "assets");
  const brief = parse(readFileSync(join(dir, "art.yaml"), "utf8")) as ArtBrief;
  const only = values.only ? new Set(values.only.split(",").map((k) => k.trim())) : undefined;
  const own = Object.entries(brief.sprites).filter(([, s]) => !s.same);
  const todo = own.filter(([k]) => !only || only.has(k));
  const rawPath = (k: string) => join(dir, ".raw", fileFor(k));
  const missing = todo.filter(([k]) => values.force || !existsSync(rawPath(k)));

  if (values["dry-run"]) {
    for (const [k, s] of todo) {
      console.log(`${existsSync(rawPath(k)) && !values.force ? "cached  " : "generate"} ${k} (${sizeFor(s)})`);
    }
    if (todo[0]) console.log(`\nprompt for ${todo[0][0]}:\n${promptFor(brief, todo[0][1])}`);
    return 0;
  }
  if (!values.reprocess && missing.length) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      console.error(`${missing.length} sprite(s) to generate: set OPENAI_API_KEY (or use --reprocess)`);
      return 2;
    }
    let done = 0;
    const failed: string[] = [];
    const spent = { input_tokens: 0, output_tokens: 0 };
    await pool(missing, Number(values.concurrency), async ([k, s]) => {
      try {
        const { png, usage } = await generate(brief, s, key);
        mkdirSync(dirname(rawPath(k)), { recursive: true });
        writeFileSync(rawPath(k), png);
        spent.input_tokens += usage.input_tokens ?? 0;
        spent.output_tokens += usage.output_tokens ?? 0;
        console.log(
          `[${++done}/${missing.length}] ${k} (${sizeFor(s)}, ${usage.input_tokens ?? "?"} in / ${usage.output_tokens ?? "?"} out tokens)`,
        );
      } catch (err) {
        failed.push(k);
        console.error(`[${++done}/${missing.length}] ${k} FAILED: ${err instanceof Error ? err.message : err}`);
      }
    });
    console.log(`tokens: ${spent.input_tokens} in, ${spent.output_tokens} out`);
    if (failed.length) console.error(`\n${failed.length} failed: ${failed.join(",")} (run again to retry)`);
  }

  // Cut every sprite that has a raw image, and write the manifest.
  const manifest: SpriteManifest = { tile: brief.tile, sprites: {} };
  for (const [k, s] of own) {
    if (!existsSync(rawPath(k))) continue;
    const file = fileFor(k);
    if (!only || only.has(k) || !existsSync(join(dir, file))) {
      const sprite = cut(decodePng(readFileSync(rawPath(k))), s, brief.tile);
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), encodePng(sprite, 9));
    }
    manifest.sprites[k] = manifestEntry(s, file);
  }
  for (const [k, s] of Object.entries(brief.sprites)) {
    const target = s.same ? manifest.sprites[s.same] : undefined;
    if (target) manifest.sprites[k] = { ...target };
  }
  const sorted = Object.fromEntries(Object.entries(manifest.sprites).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(dir, "sprites.json"), `${JSON.stringify({ ...manifest, sprites: sorted }, null, 2)}\n`);
  console.log(`wrote ${join(dir, "sprites.json")}: ${Object.keys(sorted).length} sprites`);
  return 0;
}

if (process.argv[1] && /tools[\\/]art\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
