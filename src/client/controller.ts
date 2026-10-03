/**
 * The controller, in the manner of Ultima V: one key per verb (A)ttack, T)alk, L)ook, G)et…), then a target picked
 * with a cursor, a click or from a menu. Everything becomes an ordinary port Intent (§3.1), so play here saves and
 * replays like typed play.
 */

import type { CombatIntent } from "../engine/core/combat.js";
import type { ActionRequest, Special } from "../engine/payload/schema.js";
import { ATTRIBUTES } from "../engine/payload/schema.js";
import type {
  Intent,
  MetaCommand,
  MenuItem as PortMenuItem,
  SceneThing,
  Tile,
  ViewOf,
} from "../engine/session/port.js";
import type { KeyInput, PointerInput } from "./input.js";
import { type Command, commandFor, DIRECTION_KEYS, directionName, HELP_LINES } from "./keymap.js";
import type { Menu, MenuItem, Model, Target, Verb } from "./model.js";

/** What the controller needs from the game. */
export interface ControllerIo {
  submit(intent: Intent): Promise<void>;
  menu(): PortMenuItem[];
  quit(): void;
  say(text: string): void;
}

type Entry = NonNullable<ViewOf<"inventory">["entries"]>[number];

/** Keys with a name rather than a character that the controller uses. */
const NAMED = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Escape",
  "Tab",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Backspace",
]);

/** The total of SPECIAL points a made-up character spends. */
const ALLOT_TOTAL = 40;

const dist = (a: Tile, b: Tile) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const isEnter = (k: KeyInput) => k.key === "Enter" || k.key === " ";

export class Controller {
  constructor(
    readonly model: Model,
    private readonly io: ControllerIo,
  ) {}

  private get player(): SceneThing | undefined {
    return this.model.scene?.things.find((t) => t.player);
  }

  private act(action: ActionRequest): Promise<void> {
    return this.io.submit({ type: "action", action });
  }

  private fight(intent: CombatIntent): Promise<void> {
    return this.io.submit({ type: "combat", intent });
  }

  private meta(command: MetaCommand, arg?: string): Promise<void> {
    return this.io.submit({ type: "meta", command, ...(arg ? { arg } : {}) });
  }

  /** Whether the controller wants this key (hosts let the rest through, e.g. browser shortcuts). */
  handles(k: KeyInput): boolean {
    return !k.ctrl && !k.alt && (k.key.length === 1 || NAMED.has(k.key));
  }

  // ─── Keys ──────────────────────────────────────────────────────────────────

  async key(k: KeyInput): Promise<void> {
    const m = this.model;
    if (!this.handles(k)) return;
    if (k.key === "PageUp" || k.key === "PageDown") return this.scroll(k.key === "PageUp" ? 1 : -1);
    if (m.busy) return;
    if (m.mode === "ended") return this.io.quit();
    if (m.overlay) return this.overlayKey(k);
    if (m.allot) return this.allotKey(k);
    if (m.menu) return this.menuKey(k);
    if (m.targeting) return this.targetKey(k);
    if (m.mode === "create") return this.openCreate();
    if (m.mode === "conversation") return this.openConversation();
    const dir = DIRECTION_KEYS[k.key];
    if (dir) return this.walk(dir);
    const command = commandFor(k.key);
    if (command) return this.command(command);
  }

  /** Puts up whatever the mode needs (the conversation menu, the creation menu) and sets the prompt. */
  sync(): void {
    const m = this.model;
    if (m.mode === "conversation" && !m.menu) this.openConversation();
    if (m.mode !== "conversation" && m.menu?.sticky) m.menu = undefined;
    if (m.mode === "create" && !m.menu && !m.allot) this.openCreate();
    if (m.mode !== "create") m.allot = undefined;
    m.prompt = this.hint();
  }

  hint(): string {
    const m = this.model;
    if (m.targeting) return `${m.targeting.title} — arrows aim · Tab next · Enter ${m.targeting.verb} · Esc cancel`;
    if (m.mode === "combat" && m.combat) {
      return m.combat.yourTurn
        ? `Your turn: ${m.combat.ap} AP. Arrows move (1 AP) · A attack · U use · R ready · M more · Space end turn`
        : "…";
    }
    if (m.mode === "conversation") return "Choose what to say.";
    if (m.mode === "ended") return "Press any key.";
    return "Arrows walk · A T L G U O · M all actions · ? help";
  }

  private scroll(delta: number): void {
    this.model.scroll = Math.max(0, this.model.scroll + delta);
  }

  /** Runs a verb key's command (from a key or a toolbar button). */
  async command(command: Command): Promise<void> {
    const m = this.model;
    const combat = m.mode === "combat";
    if (m.busy || m.mode === "create" || m.mode === "conversation" || m.mode === "ended") return;
    if (combat && !m.combat?.yourTurn) return;
    switch (command) {
      case "attack":
        return this.target("attack", "Attack whom?", this.people({ fightable: true }));
      case "talk":
        return this.target("talk", "Talk to whom?", this.people({ talkable: true }));
      case "look":
        return this.target("look", "Look at what?", [...this.everything(), ...this.exits()], true);
      case "get":
        return this.target(
          "get",
          "Get what?",
          this.things((t) => t.kind === "item" || (!!t.contents?.length && t.kind !== "character")),
        );
      case "drop":
        return this.pickItem(
          "Drop what?",
          () => true,
          (it) => this.act({ act: "drop", item: it.id }),
        );
      case "use":
        return this.useKey();
      case "open":
        return this.target("open", "Open or close what?", [
          ...this.things((t) => t.open !== undefined),
          ...this.exits().filter((x) => x.kind === "exit" && !!x.exit.door),
        ]);
      case "lock":
        return this.target("lock", "Lock or unlock what?", [
          ...this.things((t) => !!t.lockable),
          ...this.exits().filter((x) => x.kind === "exit" && !!x.exit.door),
        ]);
      case "push":
        return this.target(
          "push",
          "Push what?",
          this.things((t) => t.kind !== "character"),
        );
      case "ready":
        return this.pickItem(
          "Ready what?",
          (it) => !!(it.weapon || it.armour),
          (it) =>
            combat
              ? this.fight({ kind: "equip", item: it.id })
              : this.act({ act: it.equipped ? "unequip" : "equip", item: it.id }),
        );
      case "hurl":
        if (combat) return this.io.say("Not in the middle of a fight. Use A to attack.");
        return this.pickItem(
          "Hurl what?",
          () => true,
          (it) => this.target("throw", `Throw ${it.name} at what?`, this.everything(), false, it),
        );
      case "give":
        if (combat) return;
        return this.pickItem(
          "Give what?",
          () => true,
          (it) => this.target("give", `Give ${it.name} to whom?`, this.people({}), false, it),
        );
      case "filch":
        if (combat) return;
        return this.target(
          "steal",
          "Filch from whom?",
          this.people({}).filter((t) => (t.kind === "thing" ? !!t.thing.contents?.length : false)),
        );
      case "barter":
        if (combat) return;
        return this.target(
          "barter",
          "Barter with whom?",
          this.people({}).filter((t) => t.kind === "thing" && !!t.thing.merchant),
        );
      case "wait":
        if (combat) return;
        return this.waitMenu();
      case "sneak":
        if (combat) return;
        return this.act(m.status?.sneaking ? { act: "sneak", stop: true } : { act: "sneak" });
      case "pass":
        return combat ? this.fight({ kind: "end" }) : this.act({ act: "wait", minutes: 1 });
      case "stats":
        return this.meta("status");
      case "journal":
        return this.meta("journal");
      case "intro":
        return this.meta("intro");
      case "inventory":
        return this.pickItem(
          "Your pack",
          () => true,
          (it) => this.act({ act: "examine", target: it.id }),
        );
      case "actions":
        return this.allActions();
      case "help":
        m.overlay = { title: "Keys", lines: HELP_LINES.map((text) => ({ spans: [{ text, style: "plain" }] })) };
        return;
      case "quit":
        return this.io.quit();
    }
  }

  private async walk(d: Tile): Promise<void> {
    if (this.model.mode === "combat") {
      if (!this.model.combat?.yourTurn) return;
      return this.fight({ kind: "move", direction: directionName(d) });
    }
    // Walking into a closed door or a doorway goes through it; into a person, U5-style, does nothing much.
    return this.act({ act: "step", direction: directionName(d) });
  }

  private useKey(): Promise<void> | void {
    if (this.model.mode === "combat") {
      return this.pickItem(
        "Use what?",
        (it) => !!it.consumable,
        (it) => this.fight({ kind: "use", item: it.id }),
      );
    }
    const inv = this.model.inventory?.entries ?? [];
    const items: MenuItem[] = inv.map((it) => ({
      label: it.name,
      run: () =>
        this.target(
          "use-on",
          `Use ${it.name} on what? (Enter on yourself: just use it)`,
          this.everything(),
          true,
          it,
          () => this.act({ act: "use", item: it.id }),
        ),
    }));
    items.push({
      label: "something here…",
      run: () =>
        this.target(
          "use-on",
          "Use what?",
          this.things((t) => t.kind !== "character"),
        ),
    });
    this.model.menu = { title: "Use what?", items, index: 0 };
  }

  private waitMenu(): void {
    const minute = this.model.scene?.minute ?? 0;
    const until = (hh: number) => (hh * 60 - minute + 1440) % 1440 || 1440;
    const w = (label: string, minutes: number): MenuItem => ({ label, run: () => this.act({ act: "wait", minutes }) });
    this.model.menu = {
      title: "Wait",
      index: 0,
      items: [
        w("10 minutes", 10),
        w("30 minutes", 30),
        w("an hour", 60),
        w("three hours", 180),
        w("until 06:00", until(6)),
        w("until noon", until(12)),
        w("until 18:00", until(18)),
        w("until 22:00", until(22)),
        { label: "sleep", run: () => this.act({ act: "sleep" }) },
      ],
    };
  }

  private allActions(): void {
    const combat = this.model.mode === "combat";
    const items = combat ? (this.model.combat?.options ?? []) : this.io.menu();
    this.model.menu = {
      title: combat ? "Combat" : "What now?",
      index: 0,
      items: items.map((x) => ({ label: x.label, run: () => this.io.submit(x.intent) })),
    };
  }

  private pickItem(title: string, filter: (it: Entry) => boolean, run: (it: Entry) => void | Promise<void>): void {
    const inv = (this.model.inventory?.entries ?? []).filter(filter);
    if (!inv.length) {
      this.io.say("You have nothing for that.");
      return;
    }
    this.model.menu = {
      title,
      index: 0,
      items: inv.map((it) => ({ label: it.name, ...(it.equipped ? { detail: "ready" } : {}), run: () => run(it) })),
    };
  }

  // ─── Targets ───────────────────────────────────────────────────────────────

  private things(f: (t: SceneThing) => boolean): Target[] {
    return (this.model.scene?.things ?? []).filter((t) => !t.player && f(t)).map((thing) => ({ kind: "thing", thing }));
  }

  private people(o: { fightable?: boolean; talkable?: boolean }): Target[] {
    return this.things(
      (t) =>
        t.kind === "character" &&
        (!o.fightable || (t.status !== "dead" && !t.apparition)) &&
        (!o.talkable || t.status === "ok"),
    );
  }

  private everything(): Target[] {
    return this.things(() => true);
  }

  private exits(): Target[] {
    return (this.model.scene?.exits ?? []).map((exit) => ({ kind: "exit", exit }));
  }

  private target(
    verb: Verb,
    title: string,
    candidates: Target[],
    allowSelf = false,
    item?: { id: string; name: string },
    self?: () => void | Promise<void>,
  ): Promise<void> | void {
    const me = this.player?.pos;
    if (!me) return;
    const pos = (t: Target): Tile => (t.kind === "thing" ? nearestTile(t.thing, me) : t.exit.pos);
    const sorted = [...candidates].sort((a, b) => dist(pos(a), me) - dist(pos(b), me));
    if (!sorted.length && !allowSelf && !self) {
      this.io.say("There's nothing here for that.");
      return;
    }
    // A single obvious target needs no cursor (talking to the only person here).
    if (sorted.length === 1 && !allowSelf && !self && (verb === "talk" || verb === "barter")) {
      return this.apply(verb, sorted[0]!, item);
    }
    this.model.targeting = {
      verb,
      title,
      cursor: sorted[0] && !self ? pos(sorted[0]) : me,
      candidates: sorted,
      ...(item ? { item } : {}),
      ...(self || allowSelf ? { self: self ?? (() => this.meta("look")) } : {}),
    };
  }

  private async targetKey(k: KeyInput): Promise<void> {
    const t = this.model.targeting!;
    const dir = DIRECTION_KEYS[k.key];
    if (k.key === "Escape") {
      this.model.targeting = undefined;
      return;
    }
    if (dir) {
      const s = this.model.scene!;
      t.cursor = [
        Math.max(0, Math.min(s.w - 1, t.cursor[0] + dir[0])),
        Math.max(0, Math.min(s.h - 1, t.cursor[1] + dir[1])),
      ];
      return;
    }
    if (k.key === "Tab") {
      if (!t.candidates.length) return;
      const here = t.candidates.findIndex((c) => sameTile(targetTiles(c), t.cursor));
      const next = (here + (k.shift ? -1 + t.candidates.length : 1)) % t.candidates.length;
      t.cursor = targetTiles(t.candidates[next]!)[0]!;
      return;
    }
    if (isEnter(k)) return this.aim();
  }

  /** Does the aimed verb to whatever is under the cursor. */
  private async aim(): Promise<void> {
    const t = this.model.targeting!;
    const me = this.player?.pos;
    const hit = t.candidates.find((c) => sameTile(targetTiles(c), t.cursor));
    this.model.targeting = undefined;
    if (hit) return this.apply(t.verb, hit, t.item);
    if (me && t.cursor[0] === me[0] && t.cursor[1] === me[1] && t.self) return t.self();
    this.io.say("Nothing there for that.");
  }

  /** Does the verb to the target. */
  private async apply(verb: Verb, target: Target, item?: { id: string; name: string }): Promise<void> {
    const combat = this.model.mode === "combat";
    if (target.kind === "exit") {
      const x = target.exit;
      if (verb === "look") {
        const where = x.blocked
          ? "goes nowhere you can follow"
          : `leads to ${x.toName ?? "somewhere you haven't been"}`;
        this.io.say(
          `The way ${x.label} ${where}.${x.door ? (x.open ? " The door is open." : " The door is shut.") : ""}`,
        );
        return;
      }
      if (x.door) {
        if (verb === "open") return this.act({ act: x.open ? "close" : "open", target: x.door });
        if (verb === "lock") return this.act({ act: x.locked ? "unlock" : "lock", target: x.door });
      }
      return;
    }
    const t = target.thing;
    switch (verb) {
      case "attack":
        return combat ? this.fight({ kind: "attack", target: t.id }) : this.act({ act: "attack", target: t.id });
      case "talk":
        return this.act({ act: "talk", target: t.id });
      case "look":
        return this.act({ act: "examine", target: t.id });
      case "get": {
        if (!t.contents?.length) return this.act({ act: "take", item: t.id });
        // An open container: what's in it, and (if it can be carried) the thing itself.
        this.contentsMenu(`From ${t.name}`, t, (c) => this.act({ act: "take", item: c.id }));
        if (t.kind === "item" && this.model.menu) {
          this.model.menu.items.push({ label: `${t.name} itself`, run: () => this.act({ act: "take", item: t.id }) });
        }
        return;
      }
      case "open":
        return this.act({ act: t.open ? "close" : "open", target: t.id });
      case "lock":
        return this.act({ act: t.locked ? "unlock" : "lock", target: t.id });
      case "push":
        return this.act({ act: "push", target: t.id });
      case "use-on":
        return item ? this.act({ act: "use", item: item.id, on: t.id }) : this.act({ act: "use", item: t.id });
      case "throw":
        return item ? this.act({ act: "throw", item: item.id, target: t.id }) : undefined;
      case "give":
        return item ? this.act({ act: "give", item: item.id, to: t.id }) : undefined;
      case "steal":
        return this.contentsMenu(`Filch from ${t.name}`, t, (c) => this.act({ act: "steal", item: c.id, from: t.id }));
      case "barter":
        return this.barterMenu(t);
    }
  }

  private contentsMenu(title: string, t: SceneThing, run: (c: { id: string; name: string }) => Promise<void>): void {
    if (!t.contents?.length) {
      this.io.say(`There's nothing in ${t.name}.`);
      return;
    }
    this.model.menu = { title, index: 0, items: t.contents.map((c) => ({ label: c.name, run: () => run(c) })) };
  }

  private barterMenu(t: SceneThing): void {
    const buys = this.io
      .menu()
      .filter((x) => x.intent.type === "action" && x.intent.action.act === "buy" && x.intent.action.from === t.id)
      .map((x) => ({ label: x.label.replace(/ from .*\(/, " (£"), run: () => this.io.submit(x.intent) }));
    const sells = (this.model.inventory?.entries ?? []).map((it) => ({
      label: `sell ${it.name}`,
      run: () => this.act({ act: "sell", item: it.id, to: t.id }),
    }));
    if (!buys.length && !sells.length) {
      this.io.say(`${t.name} has nothing to trade.`);
      return;
    }
    this.model.menu = { title: `Barter with ${t.name}`, index: 0, items: [...buys, ...sells] };
  }

  // ─── Menus ─────────────────────────────────────────────────────────────────

  private async menuKey(k: KeyInput): Promise<void> {
    const m = this.model.menu!;
    const n = m.items.length;
    if (k.key === "Escape") {
      if (!m.sticky) this.model.menu = m.back;
      return;
    }
    if (k.key === "ArrowUp") m.index = (m.index - 1 + n) % n;
    else if (k.key === "ArrowDown") m.index = (m.index + 1) % n;
    else if (k.key === "Home") m.index = 0;
    else if (k.key === "End") m.index = n - 1;
    else if (/^[1-9]$/.test(k.key) && Number(k.key) <= n) return this.choose(m, Number(k.key) - 1);
    else if (isEnter(k)) return this.choose(m, m.index);
  }

  private async choose(m: Menu, index: number): Promise<void> {
    const item = m.items[index];
    if (!item) return;
    m.index = index;
    this.model.menu = undefined;
    await item.run();
  }

  openConversation(): void {
    const c = this.model.conversation;
    if (!c) return;
    this.model.menu = {
      title: `Talking to ${c.with}`,
      index: 0,
      sticky: true,
      items: c.options.map((o) => ({ label: o.text, run: () => this.io.submit({ type: "option", index: o.index }) })),
    };
  }

  // ─── Creation ──────────────────────────────────────────────────────────────

  openCreate(): void {
    const c = this.model.create;
    if (!c) return;
    this.model.menu = {
      title: "Who are you?",
      index: 0,
      sticky: true,
      items: [
        ...c.presets.map((p) => ({
          label: p.name,
          detail: ATTRIBUTES.map((a) => `${a} ${p.special[a]}`).join(" "),
          run: () => this.io.submit({ type: "create", preset: p.name }),
        })),
        {
          label: "Make your own…",
          run: () => {
            this.model.allot = { special: Object.fromEntries(ATTRIBUTES.map((a) => [a, 5])) as Special, index: 0 };
          },
        },
      ],
    };
  }

  /** Points left to spend on the custom character. */
  allotLeft(): number {
    const a = this.model.allot;
    return a ? ALLOT_TOTAL - ATTRIBUTES.reduce((s, x) => s + a.special[x], 0) : 0;
  }

  private allotKey(k: KeyInput): Promise<void> | void {
    if (k.key === "Escape") return this.allot("cancel");
    if (k.key === "ArrowUp" || k.key === "ArrowDown") {
      const n = ATTRIBUTES.length;
      return this.allot("select", (this.model.allot!.index + (k.key === "ArrowUp" ? n - 1 : 1)) % n);
    }
    if (k.key === "ArrowRight" || k.key === "+") return this.allot("raise");
    if (k.key === "ArrowLeft" || k.key === "-") return this.allot("lower");
    if (k.key === "Enter") return this.allot("done");
  }

  private async allot(action: "select" | "raise" | "lower" | "done" | "cancel", index?: number): Promise<void> {
    const a = this.model.allot;
    if (!a) return;
    const min = this.model.create?.min ?? 1;
    const max = this.model.create?.max ?? 10;
    if (index !== undefined) a.index = Math.max(0, Math.min(ATTRIBUTES.length - 1, index));
    const attr = ATTRIBUTES[a.index]!;
    if (action === "cancel") this.model.allot = undefined;
    else if (action === "raise" && this.allotLeft() > 0 && a.special[attr] < max) a.special[attr]++;
    else if (action === "lower" && a.special[attr] > min) a.special[attr]--;
    else if (action === "done" && this.allotLeft() === 0) {
      this.model.allot = undefined;
      this.model.menu = undefined;
      await this.io.submit({ type: "create", special: { ...a.special } });
    }
  }

  // ─── Overlays ──────────────────────────────────────────────────────────────

  private async overlayKey(k: KeyInput): Promise<void> {
    const o = this.model.overlay!;
    if (o.pages) {
      if (k.key === "ArrowUp" || k.key === "ArrowDown") {
        o.offset = Math.max(0, (o.offset ?? 0) + (k.key === "ArrowUp" ? -1 : 1));
        return;
      }
      if (k.key === "Escape") return this.overlay("close");
      return this.overlay(k.key === "ArrowLeft" || k.key === "Backspace" ? "prev" : "next");
    }
    if (o.skills?.length) {
      const n = o.skills.length;
      if (k.key === "ArrowUp" || k.key === "ArrowDown") {
        o.index = ((o.index ?? 0) + (k.key === "ArrowUp" ? n - 1 : 1)) % n;
        return;
      }
      if (k.key === "Enter" || k.key === "+") return this.raise(o.index ?? 0);
    }
    this.model.overlay = undefined;
  }

  private overlay(action: "next" | "prev" | "close"): void {
    const o = this.model.overlay;
    if (!o) return;
    const page = (o.page ?? 0) + (action === "prev" ? -1 : 1);
    if (action === "close" || !o.pages || page >= o.pages.length) {
      this.model.overlay = undefined;
      return;
    }
    o.page = Math.max(0, page);
    o.lines = o.pages[o.page]!;
    o.offset = 0;
  }

  private async raise(index: number): Promise<void> {
    const skill = this.model.overlay?.skills?.[index];
    if (!skill) return;
    this.model.overlay = undefined;
    return this.meta("improve", skill.id);
  }

  // ─── Pointer ───────────────────────────────────────────────────────────────

  async pointer(p: PointerInput): Promise<void> {
    const m = this.model;
    if (p.kind === "scroll") return this.scroll(p.delta);
    if (m.busy) return;
    switch (p.kind) {
      case "command":
        if (m.overlay || m.menu || m.allot || m.targeting) return;
        return this.command(p.command);
      case "menu":
        return m.menu ? this.choose(m.menu, p.index) : undefined;
      case "option":
        if (m.mode !== "conversation") return;
        m.menu = undefined;
        return this.io.submit({ type: "option", index: p.index });
      case "skill":
        return this.raise(p.index);
      case "overlay":
        return this.overlay(p.action);
      case "allot":
        return this.allot(p.action, p.index);
      case "hover":
        if (m.targeting && this.inScene(p.tile)) m.targeting.cursor = p.tile;
        return;
      case "tile":
        return this.tile(p.tile, p.button);
    }
  }

  private inScene(p: Tile): boolean {
    const s = this.model.scene;
    return !!s && p[0] >= 0 && p[1] >= 0 && p[0] < s.w && p[1] < s.h;
  }

  /** A click on the map (see PointerInput for the rule). */
  private async tile(at: Tile, button: "primary" | "secondary"): Promise<void> {
    const m = this.model;
    if (!this.inScene(at) || m.overlay || m.allot) return;
    if (m.menu) {
      // A click on the scene dismisses a menu that can be dismissed.
      if (!m.menu.sticky) m.menu = undefined;
      return;
    }
    if (m.targeting) {
      if (button === "secondary") m.targeting = undefined;
      else {
        m.targeting.cursor = at;
        await this.aim();
      }
      return;
    }
    if (m.mode !== "explore" && m.mode !== "combat") return;
    const combat = m.mode === "combat";
    if (combat && !m.combat?.yourTurn) return;
    const me = this.player?.pos;
    if (!me) return;
    const there = this.targetAt(at);
    if (at[0] === me[0] && at[1] === me[1]) return combat ? undefined : this.meta("look");
    if (button === "secondary") return there ? this.apply("look", there) : undefined;
    if (there?.kind === "thing") {
      const t = there.thing;
      if (combat && t.side === "b" && t.status !== "dead") return this.fight({ kind: "attack", target: t.id });
      if (!combat && t.kind === "character") return this.apply(t.status === "ok" ? "talk" : "look", there);
      if (!combat) return this.apply(t.kind === "item" || t.contents?.length ? "get" : "look", there);
    }
    if (there?.kind === "exit" && !combat) {
      return this.act({ act: "go", direction: there.exit.direction ?? there.exit.label });
    }
    return this.walk([Math.sign(at[0] - me[0]), Math.sign(at[1] - me[1])]);
  }

  /** What a click on a tile means: a person first, then an item, a fixed thing, an exit. */
  private targetAt(at: Tile): Target | undefined {
    const on = (t: SceneThing) => sameTile(t.kind === "character" ? [t.pos] : t.tiles.length ? t.tiles : [t.pos], at);
    const things = (this.model.scene?.things ?? []).filter((t) => !t.player && on(t));
    const rank = { character: 0, item: 1, fixed: 2 } as const;
    const thing = things.sort((a, b) => rank[a.kind] - rank[b.kind])[0];
    if (thing) return { kind: "thing", thing };
    const exit = this.model.scene?.exits.find((x) => sameTile([x.pos], at));
    return exit && { kind: "exit", exit };
  }
}

function nearestTile(t: SceneThing, to: Tile): Tile {
  const tiles = t.tiles.length ? t.tiles : [t.pos];
  return tiles.reduce((a, b) => (dist(b, to) < dist(a, to) ? b : a));
}

function targetTiles(t: Target): Tile[] {
  return t.kind === "exit" ? [t.exit.pos] : t.thing.tiles.length ? t.thing.tiles : [t.thing.pos];
}

function sameTile(tiles: Tile[], p: Tile): boolean {
  return tiles.some((t) => t[0] === p[0] && t[1] === p[1]);
}
