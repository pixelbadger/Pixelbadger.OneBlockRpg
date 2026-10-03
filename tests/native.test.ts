import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Rect } from "../src/client/canvas.js";
import type { PointerInput } from "../src/client/input.js";
import { theme } from "../src/client/theme.js";
import { hudLayout, SIDEBAR_CHARS } from "../src/hosts/native/hud.js";
import { fromKeyDown, fromText } from "../src/hosts/native/keys.js";
import { Kit } from "../src/hosts/native/widgets.js";
import { nodePlatform } from "../src/hosts/node/platform.js";
import { EXAMPLE, example } from "./helpers.js";

// Headless: SDL draws to memory and plays no sound. Set before SDL loads.
process.env.SDL_VIDEODRIVER = "offscreen";
process.env.SDL_AUDIODRIVER = "dummy";

/** The native app, or undefined where SDL can't load (no prebuilt for this platform). */
const native = await import("../src/hosts/native/app.js").catch(() => undefined);

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "oneblock-native-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A colour as one number, for sets. */
const rgb = (c: readonly number[]) => (c[0]! << 16) | (c[1]! << 8) | c[2]!;
const centre = (r: Rect): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];

describe("native keys", () => {
  it("names SDL's keys as the DOM does, leaving printable keys to the text they type", () => {
    expect(fromKeyDown({ key: "up" })).toEqual({ key: "ArrowUp" });
    expect(fromKeyDown({ key: "return" })).toEqual({ key: "Enter" });
    expect(fromKeyDown({ key: "enter" })).toEqual({ key: "Enter" });
    expect(fromKeyDown({ key: "pageUp" })).toEqual({ key: "PageUp" });
    expect(fromKeyDown({ key: "tab", shift: 1 })).toEqual({ key: "Tab", shift: true });
    expect(fromKeyDown({ key: "a" })).toBeUndefined();
    expect(fromKeyDown({ key: "space" })).toBeUndefined();
    expect(fromKeyDown({ key: "q", ctrl: 1 })).toEqual({ key: "q", ctrl: true });
    expect(fromKeyDown({ key: null })).toBeUndefined();
    expect(fromText("?A ")).toEqual([{ key: "?" }, { key: "A" }, { key: " " }]);
  });
});

describe("native widgets", () => {
  it("lays out the scene over the log, beside a 34-character column", () => {
    const kit = new Kit(createCanvas(1, 1).getContext("2d"), 1);
    const l = hudLayout(kit, 1200, 800);
    expect(l.sidebar.w).toBe(Math.ceil(SIDEBAR_CHARS * kit.charWidth()) + 2 * kit.space(3));
    expect(l.sidebar.x + l.sidebar.w).toBe(1200 - kit.space(2));
    expect(l.log.y).toBeGreaterThan(l.scene.y + l.scene.h);
    expect(l.log.h).toBe(240);
    expect(l.scene.w).toBe(l.log.w);
    expect(l.scene.x + l.scene.w).toBeLessThan(l.sidebar.x);
  });

  it("wraps styled paragraphs with their indent, and scales with the unit", () => {
    const ctx = createCanvas(400, 200).getContext("2d");
    const one = new Kit(ctx, 1);
    const two = new Kit(ctx, 2);
    expect(two.charWidth()).toBeCloseTo(one.charWidth() * 2, 0);
    const p = {
      spans: [
        { text: "the quick brown fox ", style: "plain" as const },
        { text: "jumps", style: "danger" as const },
      ],
      indent: 2,
    };
    const w = one.wrap(p, one.charWidth() * 12);
    expect(w.indent).toBeCloseTo(one.charWidth() * 2);
    expect(w.lines.map((l) => l.map((s) => s.text).join(""))).toEqual(["the quick", "brown fox", "jumps"]);
    expect(w.lines[2]![0]!.style).toBe("danger");
  });

  it("returns the topmost hit region, and boxes swallow clicks", () => {
    const kit = new Kit(createCanvas(10, 10).getContext("2d"), 1);
    const row: PointerInput = { kind: "menu", index: 2 };
    kit.hit({ x: 0, y: 0, w: 100, h: 100 });
    kit.hit({ x: 10, y: 10, w: 20, h: 10 }, row);
    expect(kit.hitAt(15, 15)?.input).toEqual(row);
    expect(kit.hitAt(50, 50)?.input).toBeUndefined();
    expect(kit.hitAt(150, 50)).toBeUndefined();
  });
});

describe.skipIf(!native)("native window (headless)", () => {
  it("plays in the window, draws the HUD, saves, and resumes when reopened", async () => {
    const root = tmp();
    const payload = example();
    const open = (fresh: boolean) =>
      native!.runNative({
        payload,
        platform: nodePlatform(EXAMPLE, { saveRoot: join(root, "saves"), settingsPath: join(root, "settings.json") }),
        providerId: "offline",
        title: payload.game.title,
        fresh,
        seed: "native",
        width: 1100,
        height: 720,
      });
    const app = await open(true);
    const m = app.client!.model;
    expect(m.overlay?.pages).toBeDefined();
    const send = async (...events: Parameters<typeof app.handleEvent>[0][]) => {
      for (const e of events) {
        app.handleEvent(e);
        await app.settled();
      }
    };
    await send({ type: "keyDown", key: "escape" });
    expect(m.overlay).toBeUndefined();
    expect(m.mode).toBe("create");
    // The creation menu, drawn: its first row is clickable.
    app.draw();
    const first = app.hits.find((h) => h.input?.kind === "menu" && h.input.index === 0)!;
    expect(first).toBeDefined();
    const logBefore = m.log.length;
    const [mx, my] = centre(first.rect);
    await send({ type: "mouseButtonDown", x: mx, y: my, button: 1 });
    expect(m.mode).toBe("explore");
    expect(m.log.length).toBeGreaterThan(logBefore);
    const at = () => m.scene!.things.find((t) => t.player)!.pos;
    const start = at();
    // Walk with the arrows; "?" (typed text, shift applied) opens the keys.
    await send({ type: "keyDown", key: "left" }, { type: "keyDown", key: "left" });
    expect(at()).not.toEqual(start);
    await send({ type: "textInput", text: "?" });
    expect(m.overlay?.title).toBe("Keys");
    app.draw();
    const close = app.hits.find((h) => h.input?.kind === "overlay")!;
    await send({ type: "mouseButtonDown", x: centre(close.rect)[0], y: centre(close.rect)[1], button: 1 });
    expect(m.overlay).toBeUndefined();

    app.draw(5000);
    const frame = app.frame;
    const { width, height } = frame;
    const data = frame.getContext("2d").getImageData(0, 0, width, height).data;
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 4) colours.add(rgb([data[i]!, data[i + 1]!, data[i + 2]!]));
    expect(colours.size).toBeGreaterThan(20);
    // The window's corner is the background; the sidebar's title is drawn in the theme's title colour.
    expect([...data.subarray(0, 3)]).toEqual(theme.colours.background);
    expect(colours.has(rgb(theme.styles.title.colour))).toBe(true);
    const png = await frame.encode("png");
    writeFileSync(join(root, "frame.png"), png);
    expect(png.length).toBeGreaterThan(1000);
    if (process.env.ONEBLOCK_FRAME) writeFileSync(process.env.ONEBLOCK_FRAME, png);

    const pos = at();
    await app.quit();
    await app.closed;

    const again = await open(false);
    expect(again.game!.resuming).toBe(true);
    expect(again.client!.model.scene!.things.find((t) => t.player)!.pos).toEqual(pos);
    await again.quit();
  }, 60_000);

  it("explains a missing API key in the window, and closes on a key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    try {
      const root = tmp();
      const settingsPath = join(root, "settings.json");
      const payload = example();
      const app = await native!.runNative({
        payload,
        platform: nodePlatform(EXAMPLE, { saveRoot: join(root, "saves"), settingsPath }),
        providerId: "anthropic-api",
        title: payload.game.title,
        settingsPath,
        width: 800,
        height: 500,
      });
      expect(app.client).toBeUndefined();
      app.draw();
      if (process.env.ONEBLOCK_FRAME)
        writeFileSync(`${process.env.ONEBLOCK_FRAME}.error.png`, await app.frame.encode("png"));
      app.handleEvent({ type: "keyDown", key: "escape" });
      await app.closed;
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
