/**
 * The native host (Linux): an SDL window (@kmamal/sdl) showing frames drawn with Skia (@napi-rs/canvas). The game runs
 * in this process on Node, so every Node provider works here, the Claude subscription included. The frame is redrawn
 * when the model changes, every frame while a turn animates, and a few times a second for water and flicker; it does
 * not spin when nothing moves.
 */

import { createRequire } from "node:module";
import sdl from "@kmamal/sdl";
import { type Canvas, createCanvas, GlobalFonts, type Image, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { Scratch } from "../../client/canvas.js";
import { GameClient } from "../../client/game-client.js";
import type { KeyInput } from "../../client/input.js";
import { SpriteSheet } from "../../client/sprites.js";
import type { Paragraph } from "../../client/text.js";
import { FONT_FAMILY, FONT_FILES } from "../../client/theme.js";
import { tileAt } from "../../client/timeline.js";
import type { Payload } from "../../engine/payload/schema.js";
import type { Tile } from "../../engine/session/port.js";
import { type Game, startGame } from "../../platform/game.js";
import { DEFAULT_SLOT, type Platform } from "../../platform/index.js";
import { drawHud, drawMessage, type HudLayout } from "./hud.js";
import { fromKeyDown, fromText, type SdlKey } from "./keys.js";
import { type Hit, inside, Kit } from "./widgets.js";

export interface NativeOptions {
  payload: Payload;
  platform: Platform;
  providerId: string;
  /** The save slot (default DEFAULT_SLOT). */
  slot?: string;
  /** Start over in the slot. */
  fresh?: boolean;
  seed?: string;
  /** The window's title. */
  title: string;
  /** The settings file, named when a provider can't start for want of a key. */
  settingsPath?: string;
  /** The window's size in screen points (default 1280×800). */
  width?: number;
  height?: number;
}

/** The window events the app handles: SDL's, by the same names (tests feed them in directly). */
export type NativeEvent =
  | ({ type: "keyDown" } & SdlKey)
  | { type: "textInput"; text: string }
  | { type: "mouseButtonDown"; x: number; y: number; button: number }
  | { type: "mouseMove"; x: number; y: number }
  | { type: "mouseWheel"; x: number; y: number; dy: number; flipped?: boolean }
  | { type: "resize" }
  | { type: "close" };

type Window = ReturnType<typeof sdl.video.createWindow>;
type Picture = Image | Canvas;

/** Redraws a second when nothing else asks: water, idle frames, flicker and the cursor's blink. */
const AMBIENT_FPS = 5;
/** Milliseconds between frames while a turn animates. */
const FRAME_MS = 16;

const scratch: Scratch<Picture> = (w, h) => {
  const c = createCanvas(w, h);
  return { ctx: c.getContext("2d"), image: c };
};

const decode = (bytes: Uint8Array) => loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

let fontsRegistered = false;

/** Registers JetBrains Mono (from @fontsource/jetbrains-mono) with Skia, once. */
export function registerFonts(): void {
  if (fontsRegistered) return;
  const require = createRequire(import.meta.url);
  const root = require.resolve("@fontsource/jetbrains-mono/package.json").replace(/package\.json$/, "");
  for (const f of FONT_FILES) GlobalFonts.registerFromPath(root + f.file, FONT_FAMILY);
  fontsRegistered = true;
}

/** Opens the window and starts (or resumes) the game in it. Await `closed` for the player to quit. */
export async function runNative(o: NativeOptions): Promise<NativeApp> {
  registerFonts();
  const window = sdl.video.createWindow({
    title: o.title,
    resizable: true,
    width: o.width ?? 1280,
    height: o.height ?? 800,
  });
  const app = new NativeApp(window, o);
  await app.start();
  return app;
}

export class NativeApp {
  client?: GameClient;
  game?: Game;
  /** Resolves once the game is saved and closed and the window gone. */
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private canvas: Canvas;
  private ctx: SKRSContext2D;
  /** The last frame's widgets and layout, for hit-testing the pointer. */
  private kit?: Kit;
  private layout?: HudLayout;
  /** Shown instead of the game: starting up, or why it could not start. */
  private message?: { title: string; paras: Paragraph[] };
  private failed = false;
  private sprites?: SpriteSheet<Picture>;
  private readonly scale: number;
  private pending?: ReturnType<typeof setTimeout>;
  private ambient?: ReturnType<typeof setInterval>;
  private animating = false;
  private closing = false;
  private hover?: Tile;

  constructor(
    private readonly window: Window,
    private readonly o: NativeOptions,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.canvas = createCanvas(Math.max(1, window.pixelWidth), Math.max(1, window.pixelHeight));
    this.ctx = this.canvas.getContext("2d");
    this.scale = Number(o.platform.settings.get("ui.scale")) || 1;
    const on = (e: NativeEvent) => this.handleEvent(e);
    window.on("keyDown", on);
    window.on("textInput", on);
    window.on("mouseButtonDown", on);
    window.on("mouseMove", on);
    window.on("mouseWheel", on);
    window.on("resize", () => on({ type: "resize" }));
    window.on("expose", () => on({ type: "resize" }));
    window.on("close", () => on({ type: "close" }));
  }

  /** Loads the art, opens the save and shows the game; or shows why it could not. */
  async start(): Promise<void> {
    const o = this.o;
    this.message = { title: o.title, paras: [{ spans: [{ text: "Starting…", style: "muted" }] }] };
    this.draw();
    const slot = o.slot ?? DEFAULT_SLOT;
    try {
      this.sprites = await SpriteSheet.load(o.platform.assets, decode);
      this.game = await startGame(o.payload, o.platform, {
        providerId: o.providerId,
        slot,
        ...(o.fresh ? { fresh: true } : {}),
        ...(o.seed ? { seed: o.seed } : {}),
      });
    } catch (err) {
      this.failed = true;
      this.message = { title: "The game could not start", paras: this.explain(err) };
      this.request();
      return;
    }
    const g = this.game;
    this.message = undefined;
    this.client = new GameClient({
      session: g.session,
      title: o.title,
      flush: g.flush,
      audio: o.platform.audio,
      quit: () => void this.quit(),
      banner: `${o.title}: provider ${g.providerId}, save slot "${slot}"${g.resuming ? ", resumed" : ""}. Press ? for the keys.`,
    });
    this.client.onChange(() => this.request());
    this.client.start();
    this.ambient = setInterval(() => this.request(), 1000 / AMBIENT_FPS);
  }

  /** Resolves once every input so far has been handled. */
  async settled(): Promise<void> {
    await this.client?.settled();
  }

  /** The last frame drawn, in device pixels. */
  get frame(): Canvas {
    return this.canvas;
  }

  /** The last frame's clickable regions, topmost last, in device pixels. */
  get hits(): readonly Hit[] {
    return this.kit?.hits ?? [];
  }

  handleEvent(e: NativeEvent): void {
    if (this.closing) return;
    const dpr = this.ratio();
    switch (e.type) {
      case "keyDown": {
        const k = fromKeyDown(e);
        if (k) this.key(k);
        return;
      }
      case "textInput":
        for (const k of fromText(e.text)) this.key(k);
        return;
      case "mouseButtonDown":
        this.click(e.x * dpr, e.y * dpr, e.button);
        return;
      case "mouseMove":
        this.move(e.x * dpr, e.y * dpr);
        return;
      case "mouseWheel": {
        // SDL's dy is positive away from the player; back in the log is up.
        const up = e.flipped ? -e.dy : e.dy;
        if (up) this.client?.pointer({ kind: "scroll", delta: Math.sign(up) });
        return;
      }
      case "resize":
        this.request();
        return;
      case "close":
        void this.quit();
        return;
    }
  }

  /** Saves, closes the game and the window. */
  async quit(): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true;
    clearInterval(this.ambient);
    clearTimeout(this.pending);
    try {
      await this.client?.settled();
      this.game?.close();
      await this.o.platform.saves.settled();
      this.o.platform.audio.dispose();
    } finally {
      if (!this.window.destroyed) this.window.destroy();
      this.resolveClosed();
    }
    return this.closed;
  }

  /** Draws a frame now and shows it in the window. */
  draw(now = performance.now()): void {
    if (this.window.destroyed) return;
    const w = Math.max(1, this.window.pixelWidth);
    const h = Math.max(1, this.window.pixelHeight);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = createCanvas(w, h);
      this.ctx = this.canvas.getContext("2d");
    }
    const kit = new Kit(this.ctx, this.ratio() * this.scale);
    this.animating = false;
    if (this.message) drawMessage(kit, w, h, this.message.title, this.message.paras);
    else if (this.client) {
      const frame = this.client.frame(now);
      this.animating = !!frame;
      this.layout = drawHud(kit, this.ctx, this.client.model, w, h, {
        t: now,
        scratch,
        ...(this.sprites ? { sprites: this.sprites } : {}),
        ...(frame ? { frame } : {}),
        maxScale: Math.round(4 * this.ratio()),
      });
    }
    this.kit = kit;
    const data = this.ctx.getImageData(0, 0, w, h).data;
    this.window.render(w, h, w * 4, "rgba32", Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  /** Device pixels a screen point (HiDPI). */
  private ratio(): number {
    return this.window.width > 0 ? this.window.pixelWidth / this.window.width : 1;
  }

  /** Asks for a frame: soon, or on the animation's beat while one plays. */
  private request(): void {
    if (this.pending || this.closing) return;
    this.pending = setTimeout(
      () => {
        this.pending = undefined;
        this.draw();
        if (this.animating) this.request();
      },
      this.animating ? FRAME_MS : 0,
    );
  }

  private key(k: KeyInput): void {
    if (this.failed) {
      void this.quit();
      return;
    }
    this.client?.key(k);
  }

  private click(x: number, y: number, button: number): void {
    const client = this.client;
    if (!client || (button !== 1 && button !== 3)) return;
    const hit = this.kit?.hitAt(x, y);
    if (hit) {
      if (button !== 1) return;
      if (hit.quit) void this.quit();
      else if (hit.input) client.pointer(hit.input);
      return;
    }
    const tile = this.tileAt(x, y);
    if (tile) client.pointer({ kind: "tile", tile, button: button === 1 ? "primary" : "secondary" });
  }

  private move(x: number, y: number): void {
    if (!this.client?.model.targeting) return;
    const tile = this.tileAt(x, y);
    if (!tile || (this.hover && tile[0] === this.hover[0] && tile[1] === this.hover[1])) return;
    this.hover = tile;
    this.client.pointer({ kind: "hover", tile });
  }

  private tileAt(x: number, y: number): Tile | undefined {
    const l = this.layout;
    if (!l?.tiles || this.kit?.hitAt(x, y) || !inside(l.scene, x, y)) return undefined;
    return tileAt(l.tiles, x, y);
  }

  /** Why the game could not start, and for a missing key, where to put one. */
  private explain(err: unknown): Paragraph[] {
    const text = err instanceof Error ? err.message : String(err);
    const paras: Paragraph[] = [{ spans: [{ text, style: "danger" }] }, { spans: [] }];
    if (this.o.providerId === "anthropic-api") {
      paras.push({
        spans: [
          { text: "Save your key as ", style: "plain" },
          { text: '"anthropicApiKey"', style: "strong" },
          { text: ` in ${this.o.settingsPath ?? "the settings file"}, or set `, style: "plain" },
          { text: "ANTHROPIC_API_KEY", style: "strong" },
          { text: ", or play with --provider claude-subscription.", style: "plain" },
        ],
      });
      paras.push({ spans: [] });
    }
    paras.push({ spans: [{ text: "Press any key to close.", style: "muted" }] });
    return paras;
  }
}
