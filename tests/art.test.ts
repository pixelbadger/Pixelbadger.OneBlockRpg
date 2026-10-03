import { readFileSync } from "node:fs";
import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bbox, cutCharacter, cutObject, manifestEntry, removeBackground, seamless } from "../tools/art.js";
import { decodePng, encodePng, type Image, image } from "../tools/png.js";

type RGBA = [number, number, number, number];

function solid(w: number, h: number, c: RGBA): Image {
  const img = image(w, h);
  for (let i = 0; i < w * h; i++) img.data.set(c, i * 4);
  return img;
}

const at = (img: Image, x: number, y: number): RGBA =>
  [...img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4)] as RGBA;

function draw(img: Image, x0: number, y0: number, w: number, h: number, c: RGBA): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set(c, (y * img.w + x) * 4);
}

const HERO: RGBA = [250, 20, 200, 255];

describe("PNG codec", () => {
  it("round-trips RGBA through the PNG codec", () => {
    const img = image(5, 3);
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37) % 256;
    const back = decodePng(encodePng(img));
    expect(back.w).toBe(5);
    expect(back.h).toBe(3);
    expect([...back.data]).toEqual([...img.data]);
  });

  it("writes PNGs other decoders read, and reads theirs", () => {
    const img = image(4, 2);
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 53) % 256;
    const png = encodePng(img);
    // The image data is a zlib stream, CRC-checked: Node's zlib inflates it to a row filter byte plus RGBA per row.
    const idat = Buffer.from(png).indexOf("IDAT");
    const len = Buffer.from(png).readUInt32BE(idat - 4);
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + len)).length).toBe(2 * (1 + 4 * 4));
    expect(Buffer.from(png).readUInt32BE(idat + 4 + len)).toBe(crc32(png.subarray(idat, idat + 4 + len)) >>> 0);
    // A sprite from the repo, written by another encoder.
    const sprite = decodePng(readFileSync(new URL("../examples/the-pier/assets/terrain/water.png", import.meta.url)));
    expect(sprite.w).toBeGreaterThan(0);
  });
});

describe("art tool (cutting generated images into sprites)", () => {
  it("fits an object into its tile, feet on the bottom edge, with hard alpha", () => {
    const raw = image(400, 400);
    draw(raw, 100, 50, 200, 300, HERO);
    const s = cutObject(raw, 32, 32);
    const b = bbox(s)!;
    expect(b.y + b.h).toBe(32);
    expect(b.h).toBe(31);
    expect(Math.abs(b.x + b.w / 2 - 16)).toBeLessThanOrEqual(1);
    for (let i = 3; i < s.data.length; i += 4) expect([0, 255]).toContain(s.data[i]);
  });

  it("removes an opaque background the model drew anyway", () => {
    const raw = solid(100, 100, [255, 0, 255, 255]);
    draw(raw, 30, 30, 40, 40, HERO.map((v, i) => (i === 3 ? 255 : 255 - v)) as RGBA);
    const clean = removeBackground(raw);
    expect(at(clean, 0, 0)[3]).toBe(0);
    expect(at(clean, 50, 50)[3]).toBe(255);
  });

  it("finds a character's frames by the gaps between them and scales them alike", () => {
    const raw = image(800, 200);
    [50, 250, 450, 650].forEach((x, i) => {
      draw(raw, x, 20 + (i % 2) * 10, 80, 160 - (i % 2) * 10, HERO);
    });
    const strip = cutCharacter(raw, 4, 32);
    expect(strip.w).toBe(128);
    for (let f = 0; f < 4; f++) {
      const b = bbox(strip, { x: f * 32, y: 0, w: 32, h: 32 })!;
      expect(b.y + b.h).toBe(32);
    }
    const tall = bbox(strip, { x: 0, y: 0, w: 32, h: 32 })!;
    const short = bbox(strip, { x: 32, y: 0, w: 32, h: 32 })!;
    expect(short.h).toBeLessThan(tall.h);
  });

  it("makes textures wrap without a seam", () => {
    const tex = image(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) tex.data.set([x * 16, y * 16, 0, 255], (y * 16 + x) * 4);
    const s = seamless(tex);
    const step = (a: RGBA, b: RGBA) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    for (let y = 0; y < 16; y++) expect(step(at(s, 15, y), at(s, 0, y))).toBeLessThan(48);
    for (let x = 0; x < 16; x++) expect(step(at(s, x, 15), at(s, x, 0))).toBeLessThan(48);
  });

  it("writes manifest entries the hosts read", () => {
    expect(manifestEntry({ kind: "character" }, "character/a.png")).toEqual({
      file: "character/a.png",
      frames: 4,
      fps: 4,
    });
    expect(manifestEntry({ kind: "object", span: [2, 1] }, "object/bed.png")).toEqual({
      file: "object/bed.png",
      fit: "span",
    });
    expect(manifestEntry({ kind: "texture", anim: "scroll" }, "terrain/water.png")).toEqual({
      file: "terrain/water.png",
      anim: "scroll",
    });
  });
});
