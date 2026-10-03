import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Canvas, createCanvas, type Image, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { Canvas2D, Scratch } from "../src/client/canvas.js";
import { GameClient } from "../src/client/game-client.js";
import type { KeyInput } from "../src/client/input.js";
import { DIRECTION_KEYS, directionName, KEYMAP } from "../src/client/keymap.js";
import { drawScene, type Scene } from "../src/client/scene.js";
import { SpriteSheet } from "../src/client/sprites.js";
import { markdownParagraphs, plain, TEXT_STYLES, toParagraphs, wrapSpans } from "../src/client/text.js";
import { themeCss } from "../src/client/theme.js";
import { camera, sceneLayout, Timeline, tileAt } from "../src/client/timeline.js";
import { World } from "../src/engine/core/world.js";
import { offlineProvider } from "../src/engine/narrative/offline.js";
import type { Payload } from "../src/engine/payload/schema.js";
import type { Tile } from "../src/engine/session/port.js";
import { Session } from "../src/engine/session/session.js";
import { validatePayloadAt } from "../src/hosts/node/payload.js";
import type { Assets } from "../src/platform/index.js";
import { example, mini } from "./helpers.js";

const PIER = fileURLToPath(new URL("../examples/the-pier", import.meta.url));

const pier = () => validatePayloadAt(PIER).payload!;

/** Mini, with something to say to Nell. */
const chatty = () =>
  mini({
    conversations: [
      {
        id: "nell-chat",
        character: "npc",
        goals: ["Chat."],
        opening: "Nell looks up.",
        options: [{ text: "Nice day." }, { text: "Bye then.", end: true }],
      },
    ],
  });

function game(p: Payload = example()) {
  const w = World.create(p, "client");
  const session = new Session(w, { provider: offlineProvider() });
  let quit = 0;
  const client = new GameClient({ session, title: p.game.title, flush: () => {}, quit: () => quit++ });
  client.start();
  const m = client.model;
  const press = async (key: string, mods: Omit<KeyInput, "key"> = {}) => {
    client.key({ key, ...mods });
    await client.settled();
  };
  const click = async (...inputs: Parameters<GameClient["pointer"]>) => {
    client.pointer(...inputs);
    await client.settled();
  };
  const pos = () => w.state.objects[w.playerId]!.pos!;
  return { w, session, client, m, press, click, pos, quits: () => quit };
}

/** A game past its introduction and character creation. */
async function begun(p?: Payload) {
  const g = game(p);
  if (g.m.overlay?.pages) await g.press("Escape");
  if (g.m.mode === "create") await g.press("1");
  return g;
}

describe("client keys", () => {
  it("pages the introduction, creates a character from the menu and walks with the arrows", async () => {
    const { m, press, pos } = game();
    expect(m.mode).toBe("create");
    expect(m.overlay?.pages).toHaveLength(3);
    expect(m.overlay!.lines[0]!.spans[0]).toEqual({ text: "The building", style: "heading" });
    await press("x");
    expect(m.overlay?.page).toBe(1);
    await press("ArrowLeft");
    expect(m.overlay?.page).toBe(0);
    await press("Escape");
    expect(m.overlay).toBeUndefined();
    expect(m.menu?.title).toBe("Who are you?");
    await press("1");
    expect(m.mode).toBe("explore");
    const before = pos();
    await press("ArrowUp");
    expect(pos()).toEqual([before[0], before[1] - 1]);
    expect(m.prompt).toMatch(/Arrows walk/);
    await press("n");
    expect(m.overlay?.pages).toHaveLength(3);
  });

  it("makes your own character on the allotment screen", async () => {
    const { m, press } = game();
    await press("Escape");
    await press("3");
    expect(m.allot).toBeDefined();
    for (let i = 0; i < 5; i++) await press("ArrowRight");
    await press("Enter");
    expect(m.mode).toBe("explore");
    expect(m.sheet?.special.ST).toBe(10);
  });

  it("aims a verb with a cursor and does it to the target, which starts a fight", async () => {
    const { m, press, w } = game(mini());
    await press("a");
    expect(m.targeting?.verb).toBe("attack");
    expect(m.targeting?.cursor).toEqual(w.state.objects.npc!.pos);
    await press("Enter");
    expect(m.mode).toBe("combat");
    expect(m.combat?.combatants.map((x) => x.id)).toContain("npc");
    expect(m.scene?.things.find((t) => t.id === "npc")?.side).toBe("b");
  });

  it("gets things from containers through a menu, and escapes back out", async () => {
    const { m, press, w } = game(mini());
    await press("o");
    m.targeting!.cursor = w.state.objects.box!.pos!;
    await press("Enter");
    expect(w.prop("box", "open")).toBe(true);
    await press("g");
    m.targeting!.cursor = w.state.objects.box!.pos!;
    await press("Enter");
    expect(m.menu?.items.map((i) => i.label)).toEqual(["the coin", "the box itself"]);
    await press("Enter");
    expect(w.isWithin("coin", w.playerId)).toBe(true);
    await press("w");
    expect(m.menu?.title).toBe("Wait");
    await press("Escape");
    expect(m.menu).toBeUndefined();
  });

  it("talks, picks a conversation option by number, and opens sheets", async () => {
    const { m, press } = game(chatty());
    await press("t");
    expect(m.mode).toBe("conversation");
    expect(m.menu?.sticky).toBe(true);
    expect(m.menu?.items.map((i) => i.label)).toEqual(["Nice day.", "Bye then.", "[Leave]"]);
    await press("Escape");
    expect(m.menu?.sticky).toBe(true);
    await press("2");
    expect(m.mode).toBe("explore");
    await press("z");
    expect(m.overlay?.title).toBe("Pat");
    await press("x");
    await press("?");
    expect(m.overlay?.title).toBe("Keys");
    await press("x");
    await press("m");
    expect(m.menu?.items.some((i) => i.label.startsWith("go north"))).toBe(true);
  });

  it("leaves modified keys to the host, scrolls the log, and quits when asked", async () => {
    const { client, m, press, quits } = game(mini());
    expect(client.key({ key: "r", ctrl: true })).toBe(false);
    expect(client.key({ key: "F5" })).toBe(false);
    expect(client.handles({ key: "ArrowUp" })).toBe(true);
    await press("PageUp");
    await press("PageUp");
    await press("PageDown");
    expect(m.scroll).toBe(1);
    await press("q");
    expect(quits()).toBe(1);
  });

  it("keeps its keymap as data, with a name for every step", () => {
    expect(new Set(KEYMAP.map((b) => b.key)).size).toBe(KEYMAP.length);
    expect(Object.values(DIRECTION_KEYS).map(directionName)).toContain("northwest");
  });
});

describe("client pointer", () => {
  it("steps towards an empty tile, talks to a person and gets an item by clicking", async () => {
    const { m, click, pos, w } = game(chatty());
    const [x, y] = pos();
    await click({ kind: "tile", tile: [x, y + 1], button: "primary" });
    expect(pos()).toEqual([x, y + 1]);
    await click({ kind: "tile", tile: [x, y - 1], button: "primary" });
    expect(pos()).toEqual([x, y]);
    await click({ kind: "tile", tile: w.state.objects.key!.pos! as Tile, button: "primary" });
    expect(w.isWithin("key", w.playerId)).toBe(true);
    await click({ kind: "tile", tile: w.state.objects.npc!.pos! as Tile, button: "primary" });
    expect(m.mode).toBe("conversation");
    await click({ kind: "option", index: 1 });
    expect(m.mode).toBe("explore");
  });

  it("looks with the secondary button, and walks out through an exit", async () => {
    const { m, click, w } = game(mini());
    const window = w.state.objects.window!.pos! as Tile;
    await click({ kind: "tile", tile: window, button: "secondary" });
    expect(plain(m.log.at(-1)!.spans)).toMatch(/window/i);
    const east = m.scene!.exits.find((x) => x.direction === "east")!;
    await click({ kind: "tile", tile: east.pos, button: "secondary" });
    expect(plain(m.log.at(-1)!.spans)).toBe("The way east goes nowhere you can follow.");
    await click({ kind: "tile", tile: m.scene!.exits.find((x) => x.direction === "north")!.pos, button: "primary" });
    expect(m.scene?.room).toBe("kitchen");
  });

  it("aims with hover and click, chooses menu rows, and drives overlays and buttons", async () => {
    const { m, click, press, w, session } = game(mini());
    await press("l");
    const npc = w.state.objects.npc!.pos! as Tile;
    await click({ kind: "hover", tile: npc });
    expect(m.targeting?.cursor).toEqual(npc);
    await click({ kind: "tile", tile: npc, button: "primary" });
    expect(m.targeting).toBeUndefined();
    expect(plain(m.log.at(-1)!.spans)).toMatch(/Nell/);
    await click({ kind: "command", command: "wait" });
    const clock = session.statusView().clock;
    await click({ kind: "menu", index: 0 });
    expect(session.statusView().clock).not.toBe(clock);
    await click({ kind: "command", command: "stats" });
    expect(m.overlay?.title).toBe("Pat");
    await click({ kind: "overlay", action: "close" });
    expect(m.overlay).toBeUndefined();
    await click({ kind: "scroll", delta: 2 });
    expect(m.scroll).toBe(2);
  });

  it("pages the introduction and allots SPECIAL with clicks", async () => {
    const { m, click } = game();
    await click({ kind: "overlay", action: "next" });
    await click({ kind: "overlay", action: "next" });
    await click({ kind: "overlay", action: "prev" });
    expect(m.overlay?.page).toBe(1);
    await click({ kind: "overlay", action: "close" });
    await click({ kind: "menu", index: m.menu!.items.length - 1 });
    expect(m.allot).toBeDefined();
    await click({ kind: "allot", action: "select", index: 1 });
    for (let i = 0; i < 5; i++) await click({ kind: "allot", action: "raise" });
    await click({ kind: "allot", action: "done" });
    expect(m.mode).toBe("explore");
    expect(m.sheet?.special.PE).toBe(10);
  });
});

describe("client text and theme", () => {
  it("styles the log semantically and keeps panel views out of it", () => {
    const paras = toParagraphs([
      { type: "narration", kind: "speech", speaker: "Nell", text: "Hello." },
      { type: "narration", kind: "system", text: "Saved." },
      { type: "narration", kind: "combat", text: "Nell hits you." },
      { type: "conversation", with: "Nell", options: [{ index: 0, text: "Bye." }] },
    ]);
    expect(paras[0]!.spans).toEqual([
      { text: "Nell: ", style: "speaker" },
      { text: "“Hello.”", style: "speech" },
    ]);
    expect(paras[1]!.spans[0]!.style).toBe("muted");
    expect(paras[2]!.spans[0]!.style).toBe("danger");
    expect(paras.map((p) => plain(p.spans))).toContain("1. Bye.");
    expect(toParagraphs([{ type: "conversation", with: "Nell", options: [] }], { compact: true })).toEqual([]);
  });

  it("styles light markdown", () => {
    const paras = markdownParagraphs("# Title\n\nSome **bold** and *slanted*.\n\n> quoted\n\n- item");
    expect(paras[0]!.spans).toEqual([{ text: "Title", style: "heading" }]);
    expect(paras[2]!.spans.map((s) => s.style)).toEqual(["plain", "strong", "plain", "emphasis", "plain"]);
    expect(paras[4]).toEqual({ spans: [{ text: "quoted", style: "quote" }], indent: 4 });
    expect(paras[6]!.spans[0]).toEqual({ text: "• ", style: "muted" });
  });

  it("wraps spans by measured width, keeping styles and hard breaks", () => {
    const lines = wrapSpans(
      [
        { text: "Mrs Okafor: ", style: "speaker" },
        { text: "the rent is due\non Friday", style: "plain" },
      ],
      12,
      (s) => s.length,
    );
    expect(lines.map(plain)).toEqual(["Mrs Okafor:", "the rent is", "due", "on Friday"]);
    expect(lines[0]![0]!.style).toBe("speaker");
    expect(wrapSpans([{ text: "abcdefghij", style: "plain" }], 4, (s) => s.length).map(plain)).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
  });

  it("emits CSS for every text style", () => {
    const sheet = themeCss();
    for (const s of TEXT_STYLES) {
      expect(sheet).toContain(`.style-${s} {`);
      expect(sheet).toContain(`--ob-style-${s}:`);
    }
    expect(sheet).toContain('--ob-font: "JetBrains Mono"');
  });
});

describe("client timeline and layout", () => {
  it("plays a walk tile by tile from where the walker stood", () => {
    const t = new Timeline(
      [
        {
          kind: "walk",
          id: "npc",
          room: "hall",
          path: [
            [1, 0],
            [2, 0],
          ],
        },
        { kind: "hit", actor: "npc", target: "player", to: [3, 0], ranged: false, damage: 4 },
      ],
      new Map<string, Tile>([["npc", [0, 0]]]),
    );
    const final = new Map<string, Tile>([["npc", [2, 0]]]);
    expect(t.at(0, final).pos.get("npc")).toEqual([0, 0]);
    expect(t.at(100, final).pos.get("npc")).toEqual([1, 0]);
    const hit = t.at(250, final);
    expect(hit.marks[0]?.kind).toBe("hit");
    expect(hit.floats[0]?.text).toBe("-4");
  });

  it("follows the player across a room bigger than the view", () => {
    expect(camera({ w: 40, h: 40 }, 10, 10, [30, 30])).toEqual([-25, -25]);
    expect(camera({ w: 40, h: 40 }, 10, 10, [1, 1])).toEqual([0, 0]);
  });

  it("scales the art by whole numbers, centres the room and maps pixels back to tiles", () => {
    const room = { w: 7, h: 5, things: [] };
    const l = sceneLayout({ x: 10, y: 0, w: 700, h: 400 }, room, { art: 32 });
    expect(l.tile).toBe(64);
    expect([l.tilesW, l.tilesH, l.x, l.y]).toEqual([7, 5, 10 + (700 - 448) / 2, (400 - 320) / 2]);
    expect(tileAt(l, l.x + 64 * 3 + 5, l.y + 64 * 2 + 63)).toEqual([3, 2]);
    expect(tileAt(l, l.x - 1, l.y)).toBeUndefined();
    expect(sceneLayout({ x: 0, y: 0, w: 100, h: 100 }, room, { art: 32 }).tile).toBe(32);
  });

  it("animates a turn's fx from the first frame drawn after it", async () => {
    const { client, press } = game(mini());
    expect(client.frame(1000)).toBeUndefined();
    await press("ArrowDown");
    const first = client.frame(5000);
    expect(first?.pos.size).toBeGreaterThan(0);
    expect(client.frame(5000 + 60_000)).toBeUndefined();
  });
});

// ─── Drawing, with Skia standing in for the browser ──────────────────────────

type Picture = Image | Canvas;
const scratch: Scratch<Picture> = (w, h) => {
  const c = createCanvas(w, h);
  return { ctx: c.getContext("2d"), image: c };
};

const files: Assets = {
  text: async (path) => readFile(`${PIER}/assets/${path}`, "utf8").catch(() => undefined),
  bytes: async (path) => readFile(`${PIER}/assets/${path}`).catch(() => undefined),
};

const decode = (bytes: Uint8Array) => loadImage(Buffer.from(bytes));

function render(scene: Scene, sprites?: SpriteSheet<Picture>, w = 640, h = 480) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const layout = drawScene(ctx, { x: 0, y: 0, w, h }, scene, { t: 0, scratch, ...(sprites ? { sprites } : {}) });
  const data = ctx.getImageData(0, 0, w, h).data;
  const px = (x: number, y: number) => [...data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  const luma = () => {
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.3 * data[i]! + 0.59 * data[i + 1]! + 0.11 * data[i + 2]!;
    return sum / (w * h);
  };
  return { layout, px, luma };
}

/** The opaque colours of a PNG, as "r,g,b" strings. */
async function colours(file: string): Promise<Set<string>> {
  const img = await loadImage(await readFile(`${PIER}/assets/${file}`));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  const out = new Set<string>();
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) out.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
  return out;
}

describe("scene on Canvas 2D", () => {
  it("draws on the browser's and Skia's 2D contexts as they are (checked by tsc)", () => {
    const dom = (c: CanvasRenderingContext2D): Canvas2D<ImageBitmap | OffscreenCanvas> => c;
    const skia = (c: SKRSContext2D): Canvas2D<Image | Canvas> => c;
    expect(skia(createCanvas(1, 1).getContext("2d")).imageSmoothingEnabled).toBe(true);
    expect(dom).toBeTypeOf("function");
  });

  it("loads the pier's sprite sheet through the platform's assets", async () => {
    const sprites = (await SpriteSheet.load(files, decode))!;
    expect(sprites.tile).toBe(32);
    expect(sprites.get("character/player")?.frames).toHaveLength(4);
    expect(sprites.get("character/player")?.frames[1]).toMatchObject({ sx: 32, w: 32, h: 32 });
  });

  it("draws sprites at a whole-number scale, the player on their tile, and maps clicks back", async () => {
    const sprites = (await SpriteSheet.load(files, decode))!;
    const { m } = await begun(pier());
    const scene = m.scene!;
    const { layout, px } = render(scene, sprites);
    expect(layout.tile % 32).toBe(0);
    const me = scene.things.find((t) => t.player)!.pos;
    const x0 = layout.x + (layout.ox + me[0]) * layout.tile;
    const y0 = layout.y + (layout.oy + me[1]) * layout.tile;
    expect(tileAt(layout, x0 + 1, y0 + 1)).toEqual(me);
    const player = await colours("character/player.png");
    let hits = 0;
    for (let y = y0; y < y0 + layout.tile; y++) {
      for (let x = x0; x < x0 + layout.tile; x++) if (player.has(px(x, y).slice(0, 3).join())) hits++;
    }
    expect(hits).toBeGreaterThan(layout.tile * 2);
  });

  it("is darker at night out of doors", async () => {
    const sprites = (await SpriteSheet.load(files, decode))!;
    const { m } = await begun(pier());
    const outdoors = { ...m.scene!, tags: ["outdoors"] };
    const day = render({ ...outdoors, minute: 12 * 60 }, sprites).luma();
    const night = render({ ...outdoors, minute: 60 }, sprites).luma();
    expect(night).toBeLessThan(day * 0.8);
  });

  it("draws tiles without sprites from their glyph art", async () => {
    const { m } = game(mini());
    const scene = m.scene!;
    const { layout, px } = render(scene);
    expect(layout.tile).toBe(64);
    // An empty floor tile: its colour. The player: "@" in their colour.
    expect(scene.terrain[2]![3]).toBe("floor");
    expect(px(layout.x + 3 * layout.tile + 1, layout.y + 2 * layout.tile + 1)).toEqual([62, 58, 52, 255]);
    const at = (x: number, y: number) => {
      const out = new Set<string>();
      for (let dy = 0; dy < layout.tile; dy++) {
        for (let dx = 0; dx < layout.tile; dx++)
          out.add(px(x * layout.tile + layout.x + dx, y * layout.tile + layout.y + dy).join());
      }
      return out;
    };
    expect(at(2, 2)).toContain("120,220,255,255");
    expect(px(0, 0)).toEqual([8, 8, 10, 255]);
  });
});
