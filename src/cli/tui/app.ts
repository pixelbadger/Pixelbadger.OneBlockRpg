/**
 * The full-screen TUI (`play --tui`): an adapter on the UI port (§3.1), in the manner of Ultima V. The player's room
 * is drawn as animated tiles; play is keys only (ui.ts). Every key becomes an ordinary Intent, so games played here
 * save and replay like typed ones.
 */

import { SKILL_NAMES } from "../../mechanics/special.js";
import type { Intent, Tile, ViewModel } from "../../session/port.js";
import type { Session } from "../../session/session.js";
import { setColorDepth } from "./color.js";
import { type Graphics, Painter } from "./graphics.js";
import { compose } from "./layout.js";
import { markdownParagraphs, type Paragraph, toParagraphs } from "./log.js";
import { Timeline } from "./scene.js";
import type { SpriteSet } from "./sprites.js";
import { Controller, type Key, type Ui } from "./ui.js";

export interface TuiOptions {
  session: Session;
  title: string;
  /** Shown in the message log before the game starts (provider, save path…). */
  banner: string;
  /** Called after every turn so the game is saved. */
  flush: () => void;
  /** Draw with emoji (default) or with plain glyphs. */
  emoji?: boolean;
  /** The payload's sprite art; with `graphics`, the scene is drawn as a picture. */
  sprites?: SpriteSet;
  /** How the terminal shows images ("none" draws tiles with glyphs). */
  graphics?: Graphics;
  /** True colour (default: from COLORTERM). */
  truecolor?: boolean;
  /** Ends the game (e.g. the process is told to stop). */
  signal?: AbortSignal;
  /** Where to draw and where keys come from: the process's TTY (node-terminal.ts) or xterm.js in a browser. */
  terminal: Terminal;
}

/** What the TUI needs of a terminal. */
export interface Terminal {
  readonly columns: number;
  readonly rows: number;
  /** Output is backed up: skip a frame rather than queue it. */
  readonly congested?: boolean;
  write(text: string): void;
  /** Starts sending keys (raw mode) and resizes; the returned function stops them. */
  listen(onKey: (str: string | undefined, key: Key) => void, onResize: () => void): () => void;
}

const FRAME_MS = 80;
/** In image mode, ambient animation (water, idle frames, pulses) steps at this rate, so pictures are sent less. */
const PICTURE_MS = 200;

/** Turns session output into UI state: the log, the panels and any sheet to show. */
export function absorb(ui: Ui, session: Session, views: readonly ViewModel[]): Timeline | undefined {
  const before = new Map<string, Tile>((ui.scene?.things ?? []).map((t) => [t.id, t.pos]));
  const beforeRoom = ui.scene?.room;
  push(ui, toParagraphs(views, { compact: true }));
  let timeline: Timeline | undefined;
  for (const v of views) {
    if (v.type === "sheet") {
      const skills = Object.entries(v.skills).map(([id, value]) => ({
        id,
        label: `${SKILL_NAMES[id as keyof typeof SKILL_NAMES]}${v.tags.includes(id as never) ? "*" : ""}  ${value}%`,
      }));
      ui.overlay = {
        title: v.name,
        lines: toParagraphs([v]),
        ...(ui.status?.unspentSkillPoints || Number(v.derived["Skill points"] ?? 0) > 0 ? { skills, index: 0 } : {}),
      };
    } else if (v.type === "journal") ui.overlay = { title: "Journal", lines: toParagraphs([v]) };
    else if (v.type === "help") ui.overlay = { title: "Help", lines: toParagraphs([v]) };
    else if (v.type === "introduction") {
      const pages = v.pages.map(markdownParagraphs);
      ui.overlay = { title: v.title ?? ui.title, lines: pages[0]!, pages, page: 0, offset: 0 };
    } else if (v.type === "combat") ui.combat = v;
    else if (v.type === "conversation") {
      ui.conversation = v;
      ui.menu = undefined;
    } else if (v.type === "create") ui.create = v;
    else if (v.type === "ended") ui.ended = v;
  }
  ui.mode = session.mode;
  if (ui.mode !== "combat") ui.combat = undefined;
  if (ui.mode !== "conversation") ui.conversation = undefined;
  if (ui.mode !== "create") {
    ui.status = session.statusView();
    ui.sheet = session.sheetView();
    ui.inventory = session.inventoryView();
    ui.scene = session.sceneView();
  }
  const fx = views.find((v) => v.type === "fx");
  if (fx?.type === "fx" && ui.scene && beforeRoom === ui.scene.room) timeline = new Timeline(fx.fx, before);
  return timeline;
}

/** The hole key of a rectangle with nothing over it (Canvas.holeKey). */
const fullKey = (r: { x: number; y: number; w: number; h: number }) =>
  Array.from({ length: r.h }, (_, i) => `${r.x},${r.y + i},${r.w}`).join(";");

function push(ui: Ui, paras: Paragraph[]): void {
  ui.log.push(...paras);
  if (ui.log.length > 3000) ui.log.splice(0, ui.log.length - 3000);
  ui.scroll = 0;
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const term = opts.terminal;
  setColorDepth(opts.truecolor);
  const { session } = opts;
  const emoji = opts.emoji ?? true;
  const painter = opts.sprites && opts.graphics && opts.graphics !== "none" ? new Painter(opts.graphics) : undefined;
  const sprites = painter ? opts.sprites : undefined;
  let holes = "";
  const ui: Ui = { title: opts.title, mode: session.mode, log: [], scroll: 0, busy: false };
  let anim: { timeline: Timeline; start: number } | undefined;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  let quitting = false;
  let restored = false;
  const epoch = Date.now();

  const draw = () => {
    // A slow connection: skip frames rather than queue them. Once the screen is given back, draw nothing.
    if (term.congested || restored) return;
    const cols = term.columns || 80;
    const rows = term.rows || 24;
    const now = Date.now();
    let frame: ReturnType<Timeline["at"]> | undefined;
    if (anim) {
      const ms = now - anim.start;
      if (ms >= anim.timeline.duration) anim = undefined;
      else frame = anim.timeline.at(ms, new Map((ui.scene?.things ?? []).map((t) => [t.id, t.pos])));
    }
    const t = now - epoch;
    const f = compose(ui, cols, rows, {
      t: sprites && !frame ? Math.floor(t / PICTURE_MS) * PICTURE_MS : t,
      emoji,
      ...(frame ? { frame } : {}),
      ...(sprites ? { sprites } : {}),
    });
    ui.scroll = Math.min(ui.scroll, f.maxScroll);
    // Synchronised output, so a picture and the text over it land together.
    let out = "\x1b[?2026h\x1b[?25l";
    if (painter) {
      // Holes change when a menu opens or closes over the scene: wipe them, then send the picture again.
      const key = f.canvas.holeKey();
      const moved = key !== holes;
      holes = key;
      if (moved) out += f.canvas.clearHoles();
      if (f.picture) {
        const r = f.picture.rect;
        // Inline images can't sit under text: while a menu covers part of the scene, keep the picture still.
        const covered = painter.mode === "iip" && key !== fullKey(r);
        if (moved || !covered) out += painter.paint(f.picture.draw(), r, moved);
      } else out += painter.clear();
    }
    f.canvas.lines(true).forEach((line, i) => {
      out += `\x1b[${i + 1};1H${line}`;
    });
    term.write(`${out}\x1b[?2026l`);
  };

  const quit = () => {
    if (quitting) return;
    quitting = true;
    done();
  };

  const controller = new Controller(ui, {
    submit: async (intent: Intent) => {
      ui.busy = true;
      ui.menu = undefined;
      draw();
      try {
        const out = await session.handle(intent);
        opts.flush();
        const timeline = absorb(ui, session, out.views);
        if (timeline && timeline.duration > 0) anim = { timeline, start: Date.now() };
      } catch (err) {
        push(ui, [{ spans: [{ text: `Error: ${err instanceof Error ? err.message : String(err)}`, sgr: "31" }] }]);
      } finally {
        ui.busy = false;
        controller.sync();
      }
    },
    menu: () => session.menu(),
    quit,
    say: (text) => push(ui, [{ spans: [{ text, sgr: "90" }] }]),
  });

  const onKey = (str: string | undefined, key: Key = {}) => {
    // A key skips the rest of an animation.
    anim = undefined;
    void controller
      .key(str, key)
      .then(() => {
        controller.sync();
        draw();
      })
      .catch((err) => {
        push(ui, [{ spans: [{ text: `Error: ${err instanceof Error ? err.message : String(err)}`, sgr: "31" }] }]);
      });
  };

  let unlisten = () => {};
  const restore = () => {
    restored = true;
    clearInterval(ticker);
    unlisten();
    term.write(`${painter?.clear() ?? ""}\x1b[0m\x1b[?25h\x1b[?1049l`);
  };

  term.write("\x1b[?1049h\x1b[2J");
  unlisten = term.listen(onKey, draw);
  opts.signal?.addEventListener("abort", quit, { once: true });
  if (opts.signal?.aborted) quit();
  const ticker = setInterval(draw, FRAME_MS);
  try {
    push(ui, [{ spans: [{ text: opts.banner, sgr: "90" }] }]);
    const start = session.start();
    opts.flush();
    absorb(ui, session, start.views);
    controller.sync();
    draw();
    await finished;
  } finally {
    opts.signal?.removeEventListener("abort", quit);
    restore();
  }
}
