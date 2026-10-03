/**
 * The game as a host sees it: a session, the presentation model, the controller and the turn's animation in one
 * object. Hosts own the window and the render loop: they feed it keys and clicks, redraw the HUD on `onChange`, and
 * draw the scene every animation frame with `frame(now)`.
 */

import type { Tile, ViewModel } from "../engine/session/port.js";
import type { Session } from "../engine/session/session.js";
import { type AudioOut, silentAudio } from "../platform/index.js";
import { Controller } from "./controller.js";
import { playCues } from "./cues.js";
import type { KeyInput, PointerInput } from "./input.js";
import { absorb, emptyModel, type Model, pushLog } from "./model.js";
import type { AnimFrame, Timeline } from "./timeline.js";

export interface GameClientOptions {
  session: Session;
  /** The game's title, for the header and the introduction. */
  title: string;
  /** Called after every turn so the game is saved. */
  flush: () => void;
  audio?: AudioOut;
  /** The player asked to quit (Q, or any key once the game has ended). */
  quit?: () => void;
  /** Shown in the log before the game starts (provider, save slot…). */
  banner?: string;
}

export class GameClient {
  readonly model: Model;
  private readonly controller: Controller;
  private readonly listeners = new Set<() => void>();
  private readonly audio: AudioOut;
  private ambience: string[] = [];
  /** The turn's animation; it starts on the first frame drawn after the turn. */
  private anim?: { timeline: Timeline; start?: number };
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly o: GameClientOptions) {
    this.model = emptyModel(o.title, o.session.mode);
    this.audio = o.audio ?? silentAudio;
    this.controller = new Controller(this.model, {
      submit: (intent) => this.turn(() => o.session.handle(intent)),
      menu: () => o.session.menu(),
      quit: () => o.quit?.(),
      say: (text) => pushLog(this.model, [{ spans: [{ text, style: "muted" }] }]),
    });
  }

  /** Shows the opening (or the resumed game). Call once. */
  start(): void {
    if (this.o.banner) pushLog(this.model, [{ spans: [{ text: this.o.banner, style: "muted" }] }]);
    const out = this.o.session.start();
    this.o.flush();
    this.absorb(out.views);
    this.controller.sync();
    this.changed();
  }

  get busy(): boolean {
    return this.model.busy;
  }

  /** Whether a key is the game's (the host should swallow it) or the host's to handle. */
  handles(k: KeyInput): boolean {
    return this.controller.handles(k);
  }

  /** A key press. Returns `handles(k)`. Skips any animation playing. */
  key(k: KeyInput): boolean {
    if (!this.controller.handles(k)) return false;
    this.anim = undefined;
    this.run(() => this.controller.key(k));
    return true;
  }

  /** A click, hover or scroll, resolved by the host to what it hit. */
  pointer(p: PointerInput): void {
    if (p.kind !== "hover") this.anim = undefined;
    this.run(() => this.controller.pointer(p));
  }

  /** Calls `listener` whenever the model changes. Returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The animation frame to draw at `now` (any clock in ms), or undefined when nothing is playing. */
  frame(now: number): AnimFrame | undefined {
    const a = this.anim;
    if (!a) return undefined;
    a.start ??= now;
    const ms = now - a.start;
    if (ms >= a.timeline.duration) {
      this.anim = undefined;
      return undefined;
    }
    return a.timeline.at(ms, new Map<string, Tile>((this.model.scene?.things ?? []).map((t) => [t.id, t.pos])));
  }

  /** Resolves once every input so far has been handled (for tests and orderly shutdown). */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all(this.inflight);
  }

  /**
   * Handles an input at once. Input that arrives while a turn plays is dropped by the controller (the model is
   * busy) rather than queued, as in the old games.
   */
  private run(f: () => void | Promise<void>): void {
    const p = (async () => f())()
      .catch((err) => this.error(err))
      .finally(() => {
        this.inflight.delete(p);
        this.controller.sync();
        this.changed();
      });
    this.inflight.add(p);
  }

  private async turn(play: () => ReturnType<Session["handle"]>): Promise<void> {
    const m = this.model;
    m.busy = true;
    m.menu = undefined;
    this.changed();
    try {
      const out = await play();
      this.o.flush();
      this.absorb(out.views);
    } catch (err) {
      this.error(err);
    } finally {
      m.busy = false;
      this.controller.sync();
      this.changed();
    }
  }

  private absorb(views: readonly ViewModel[]): void {
    const timeline = absorb(this.model, this.o.session, views);
    if (timeline && timeline.duration > 0) this.anim = { timeline };
    this.ambience = playCues(this.audio, views, this.model.scene, this.ambience);
  }

  private error(err: unknown): void {
    pushLog(this.model, [
      { spans: [{ text: `Error: ${err instanceof Error ? err.message : String(err)}`, style: "danger" }] },
    ]);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}
