import { readFileSync } from "node:fs";
import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { World } from "../src/engine/core/world.js";
import { offlineProvider } from "../src/engine/narrative/offline.js";
import { Session } from "../src/engine/session/session.js";
import { absorb } from "../src/hosts/cli/tui/app.js";
import { Canvas } from "../src/hosts/cli/tui/canvas.js";
import { detectGraphics, iipImage, kittyImage, Painter } from "../src/hosts/cli/tui/graphics.js";
import { compose } from "../src/hosts/cli/tui/layout.js";
import { decodePng, encodePng, type Image, image } from "../src/hosts/cli/tui/png.js";
import { frameAt, SpriteSet } from "../src/hosts/cli/tui/sprites.js";
import { Controller, type Ui } from "../src/hosts/cli/tui/ui.js";
import { bbox, cutCharacter, cutObject, manifestEntry, removeBackground, seamless } from "../tools/art.js";
import { mini } from "./helpers.js";

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

/** A pattern with ESC and BEL spelled out (biome bars control characters in regex literals). */
const pattern = (source: string) => new RegExp(source.replaceAll("ESC", "\\x1b").replaceAll("BEL", "\\x07"));

const FLOOR: RGBA = [40, 120, 60, 255];
const HERO: RGBA = [250, 20, 200, 255];

function sprites(): SpriteSet {
  const set = new SpriteSet(16);
  set.add("terrain/floor", solid(16, 16, FLOOR));
  // Two frames: a figure, then the same figure one pixel lower.
  const strip = image(32, 16);
  draw(strip, 4, 2, 8, 12, HERO);
  draw(strip, 20, 3, 8, 12, HERO);
  set.add("character/player", strip, { frames: 2, fps: 4 });
  return set;
}

function game() {
  const w = World.create(mini(), "gfx");
  const session = new Session(w, { provider: offlineProvider() });
  const ui: Ui = { title: "Mini", mode: session.mode, log: [], scroll: 0, busy: false };
  const c = new Controller(ui, {
    submit: async (intent) => {
      absorb(ui, session, (await session.handle(intent)).views);
    },
    menu: () => session.menu(),
    quit: () => {},
    say: () => {},
  });
  absorb(ui, session, session.start().views);
  c.sync();
  return { ui, session };
}

describe("PNG and sprites", () => {
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

  it("cuts a strip into frames and steps through them at the sprite's rate", () => {
    const s = sprites().get("character/player")!;
    expect(s.frames).toHaveLength(2);
    expect(at(s.frames[0]!, 4, 2)).toEqual(HERO);
    expect(at(s.frames[1]!, 4, 2)[3]).toBe(0);
    expect(frameAt(s, 0)).toBe(s.frames[0]);
    expect(frameAt(s, 250)).toBe(s.frames[1]);
    expect(frameAt(s, 500)).toBe(s.frames[0]);
  });
});

describe("pictures in the terminal", () => {
  it("leaves punched holes alone when printing, and reports when they change", () => {
    const cv = new Canvas(6, 2);
    cv.fill({ x: 0, y: 0, w: 6, h: 2 }, "x");
    cv.punch({ x: 1, y: 0, w: 3, h: 2 });
    expect(cv.lines(false)).toEqual(["x   xx", "x   xx"]);
    expect(cv.lines(true)[0]).toContain("\x1b[3C");
    const before = cv.holeKey();
    cv.text(2, 1, "m");
    expect(cv.holeKey()).not.toBe(before);
    expect(cv.clearHoles()).toContain("\x1b[1;2H");
  });

  it("draws the room as a picture from sprites, with the player on their tile", () => {
    const { ui } = game();
    const f = compose(ui, 120, 40, { t: 0, emoji: true, sprites: sprites() });
    expect(f.picture).toBeDefined();
    const { rect, draw: paint } = f.picture!;
    const img = paint();
    const scene = ui.scene!;
    // Each tile is 2s columns by s rows of the rectangle and 16 pixels of the picture.
    const s = rect.h / Math.round(img.h / 16);
    expect(img.w / 16).toBe(rect.w / (2 * s));
    // The punched rectangle prints as spaces.
    const lines = f.canvas.lines(false);
    expect(lines[rect.y]!.slice(rect.x, rect.x + rect.w).trim()).toBe("");
    // Somewhere is floor, and the player's sprite is in the picture.
    const pixels = Array.from({ length: img.w * img.h }, (_, i) => at(img, i % img.w, Math.floor(i / img.w)).join());
    expect(pixels).toContain(FLOOR.join());
    expect(pixels).toContain(HERO.join());
    expect(scene.things.some((t) => t.player)).toBe(true);
  });

  it("draws things without sprites from their glyph art", () => {
    const { ui } = game();
    const img = compose(ui, 120, 40, { t: 0, emoji: true, sprites: new SpriteSet(16) }).picture!.draw();
    const colours = new Set(
      Array.from({ length: img.w * img.h }, (_, i) => at(img, i % img.w, Math.floor(i / img.w)).join()),
    );
    // Floor is its glyph-art colour; the player's "@" is drawn in the pixel font in their colour.
    expect(colours).toContain("62,58,52,255");
    expect(colours).toContain("120,220,255,255");
  });

  it("speaks the kitty protocol in 4096-byte chunks, under text, without moving the cursor", () => {
    const png = encodePng(solid(64, 64, HERO));
    const big = new Uint8Array(10_000).map((_, i) => (i * 7919) % 256);
    const seq = kittyImage(big, 2, 10, 5);
    const chunks = seq.split("\x1b\\").filter(Boolean);
    expect(chunks.length).toBe(Math.ceil(Buffer.from(big).toString("base64").length / 4096));
    expect(chunks[0]).toMatch(pattern(String.raw`^ESC_Ga=T,f=100,q=2,C=1,i=2,p=1,c=10,r=5,z=-\d+,m=1;`));
    expect(chunks.at(-1)).toMatch(pattern("^ESC_Gm=0;"));
    for (const c of chunks) expect(c.split(";")[1]!.length).toBeLessThanOrEqual(4096);
    expect(kittyImage(png, 1, 4, 2)).toContain("m=0;");
  });

  it("speaks iTerm2's inline images, sized in cells", () => {
    const png = encodePng(solid(8, 8, HERO));
    const seq = iipImage(png, 12, 6);
    expect(seq).toMatch(
      pattern(
        String.raw`^ESC\]1337;File=inline=1;size=\d+;width=12;height=6;preserveAspectRatio=0:[A-Za-z0-9+/=]+BEL$`,
      ),
    );
    expect(seq).toContain(`size=${png.length}`);
  });

  it("sends a picture only when it changes, swapping kitty ids so it never flickers", () => {
    const p = new Painter("kitty");
    const r = { x: 2, y: 1, w: 10, h: 5 };
    const a = p.paint(solid(8, 8, HERO), r);
    expect(a).toContain("\x1b[2;3H");
    expect(a).toContain("i=2,");
    expect(a).toContain("a=d,d=I,i=1");
    expect(p.paint(solid(8, 8, HERO), r)).toBe("");
    expect(p.paint(solid(8, 8, HERO), r, true)).toContain("i=1,");
    expect(p.paint(solid(8, 8, FLOOR), r)).not.toBe("");
    expect(p.clear()).toContain("a=d,d=A");
    expect(p.clear()).toBe("");
  });

  it("guesses the terminal's graphics from its environment", () => {
    expect(detectGraphics({ TERM: "xterm-kitty" })).toBe("kitty");
    expect(detectGraphics({ TERM_PROGRAM: "ghostty" })).toBe("kitty");
    expect(detectGraphics({ TERM_PROGRAM: "iTerm.app" })).toBe("iip");
    expect(detectGraphics({ TERM_PROGRAM: "WezTerm" })).toBe("iip");
    expect(detectGraphics({ TERM: "xterm-kitty", TMUX: "/tmp/x" })).toBe("none");
    expect(detectGraphics({ TERM: "xterm-256color" })).toBe("none");
    expect(detectGraphics({ TERM: "xterm-256color", ONEBLOCK_GRAPHICS: "iip" })).toBe("iip");
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

  it("writes manifest entries the TUI reads", () => {
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
