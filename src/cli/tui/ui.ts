/**
 * The keys-only controller, in the manner of Ultima V: one key per verb (A)ttack, T)alk, L)ook, G)et…), then a
 * target picked with a cursor or from a menu. Everything becomes an ordinary port Intent (§3.1), so play through the
 * TUI saves and replays like typed play.
 */

import type { CombatIntent } from "../../core/combat.js";
import type { ActionRequest, Special } from "../../payload/schema.js";
import { ATTRIBUTES } from "../../payload/schema.js";
import type { Intent, MenuItem, MetaCommand, Mode, SceneThing, Tile, ViewOf } from "../../session/port.js";
import type { Paragraph } from "./log.js";

export interface UiMenuItem {
  label: string;
  detail?: string;
  run: () => void | Promise<void>;
}

export interface UiMenu {
  title: string;
  items: UiMenuItem[];
  index: number;
  /** Conversation menus can't be dismissed; you have to say something. */
  sticky?: boolean;
  /** Escape goes back to this menu. */
  back?: UiMenu;
}

export type Verb =
  | "attack"
  | "talk"
  | "look"
  | "get"
  | "open"
  | "lock"
  | "push"
  | "use-on"
  | "throw"
  | "give"
  | "steal"
  | "barter";

/** A target in the scene: a thing, or an exit tile. */
export type Target = { kind: "thing"; thing: SceneThing } | { kind: "exit"; exit: ViewOf<"scene">["exits"][number] };

export interface Targeting {
  verb: Verb;
  title: string;
  cursor: Tile;
  candidates: Target[];
  /** The held item being used, thrown or given. */
  item?: { id: string; name: string };
  /** Enter on your own tile does this (e.g. use an item on nothing). */
  self?: () => void | Promise<void>;
}

export interface Ui {
  title: string;
  mode: Mode;
  scene?: ViewOf<"scene">;
  status?: ViewOf<"status">;
  sheet?: ViewOf<"sheet">;
  inventory?: ViewOf<"inventory">;
  combat?: ViewOf<"combat">;
  conversation?: ViewOf<"conversation">;
  create?: ViewOf<"create">;
  ended?: ViewOf<"ended">;
  log: Paragraph[];
  scroll: number;
  menu?: UiMenu;
  targeting?: Targeting;
  overlay?: { title: string; lines: Paragraph[]; skills?: { id: string; label: string }[]; index?: number };
  /** Custom character creation: SPECIAL being allocated. */
  allot?: { special: Special; index: number };
  busy: boolean;
  /** The prompt shown at the foot of the message pane. */
  prompt?: string;
}

/** What the controller needs from the app. */
export interface UiIo {
  submit(intent: Intent): Promise<void>;
  menu(): MenuItem[];
  quit(): void;
  say(text: string): void;
}

export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

const ARROWS: Record<string, Tile> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const NUMPAD: Record<string, Tile> = {
  "1": [-1, 1],
  "2": [0, 1],
  "3": [1, 1],
  "4": [-1, 0],
  "6": [1, 0],
  "7": [-1, -1],
  "8": [0, -1],
  "9": [1, -1],
};
const DIR_NAME: Record<string, string> = {
  "0,-1": "north",
  "1,-1": "northeast",
  "1,0": "east",
  "1,1": "southeast",
  "0,1": "south",
  "-1,1": "southwest",
  "-1,0": "west",
  "-1,-1": "northwest",
};

export const HELP_LINES = [
  "Arrows (or numpad 1–9) walk. Walk into a doorway or stairs to leave. In a fight each tile costs 1 AP.",
  "A attack   T talk     L look     G get       D drop     U use      O open/close",
  "K lock     P push     R ready    H hurl      V give     F filch    B barter",
  "W wait     S sneak    Space pass (end turn in a fight)",
  "Z stats    J journal  M every action here     PgUp/PgDn scroll     ? help     Q quit",
  "Picking a target: arrows move the cursor, Tab cycles targets, Enter acts, Esc cancels.",
  "Menus: arrows or numbers, Enter chooses, Esc goes back.",
];

const dist = (a: Tile, b: Tile) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

export class Controller {
  constructor(
    readonly ui: Ui,
    private readonly io: UiIo,
  ) {}

  private get player(): SceneThing | undefined {
    return this.ui.scene?.things.find((t) => t.player);
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

  // ─── Keys ──────────────────────────────────────────────────────────────────

  async key(str: string | undefined, k: Key): Promise<void> {
    const ui = this.ui;
    if (k.ctrl && (k.name === "c" || k.name === "d")) return this.io.quit();
    if (k.name === "pageup") {
      ui.scroll += 4;
      return;
    }
    if (k.name === "pagedown") {
      ui.scroll = Math.max(0, ui.scroll - 4);
      return;
    }
    if (ui.busy) return;
    if (ui.mode === "ended") return this.io.quit();
    if (ui.overlay) return this.overlayKey(str, k);
    if (ui.allot) return this.allotKey(str, k);
    if (ui.menu) return this.menuKey(str, k);
    if (ui.targeting) return this.targetKey(str, k);
    if (ui.mode === "create") return this.openCreate();
    if (ui.mode === "conversation") return this.openConversation();
    return this.commandKey(str, k);
  }

  /** Puts up whatever the mode needs (the conversation menu, the creation menu). */
  sync(): void {
    const ui = this.ui;
    if (ui.mode === "conversation" && !ui.menu) this.openConversation();
    if (ui.mode !== "conversation" && ui.menu?.sticky) ui.menu = undefined;
    if (ui.mode === "create" && !ui.menu && !ui.allot) this.openCreate();
    if (ui.mode !== "create") ui.allot = undefined;
    ui.prompt = this.hint();
  }

  hint(): string {
    const ui = this.ui;
    if (ui.targeting) return `${ui.targeting.title} — arrows aim · Tab next · Enter ${ui.targeting.verb} · Esc cancel`;
    if (ui.mode === "combat" && ui.combat) {
      return ui.combat.yourTurn
        ? `Your turn: ${ui.combat.ap} AP. Arrows move (1 AP) · A attack · U use · R ready · M more · Space end turn`
        : "…";
    }
    if (ui.mode === "conversation") return "Choose what to say.";
    if (ui.mode === "ended") return "Press any key.";
    return "Arrows walk · A T L G U O · M all actions · ? help";
  }

  private async commandKey(str: string | undefined, k: Key): Promise<void> {
    const ui = this.ui;
    const dir = (k.name && ARROWS[k.name]) || (str && NUMPAD[str]);
    if (dir) return this.walk(dir);
    const combat = ui.mode === "combat";
    if (combat && !ui.combat?.yourTurn) return;
    // An Esc pressed just before a letter arrives as Alt+letter; treat it as the letter.
    const ch = k.meta && k.name?.length === 1 ? k.name : (str ?? "");
    switch (ch.toLowerCase()) {
      case "a":
        return this.target("attack", "Attack whom?", this.people({ fightable: true }));
      case "t":
        return this.target("talk", "Talk to whom?", this.people({ talkable: true }));
      case "l":
        return this.target("look", "Look at what?", [...this.everything(), ...this.exits()], true);
      case "g":
        return this.target(
          "get",
          "Get what?",
          this.things((t) => t.kind === "item" || (!!t.contents?.length && t.kind !== "character")),
        );
      case "d":
        return this.pickItem(
          "Drop what?",
          () => true,
          (it) => this.act({ act: "drop", item: it.id }),
        );
      case "u":
        return this.useKey();
      case "o":
        return this.target("open", "Open or close what?", [
          ...this.things((t) => t.open !== undefined),
          ...this.exits().filter((x) => x.kind === "exit" && !!x.exit.door),
        ]);
      case "k":
        return this.target("lock", "Lock or unlock what?", [
          ...this.things((t) => !!t.lockable),
          ...this.exits().filter((x) => x.kind === "exit" && !!x.exit.door),
        ]);
      case "p":
        return this.target(
          "push",
          "Push what?",
          this.things((t) => t.kind !== "character"),
        );
      case "r":
        return this.pickItem(
          "Ready what?",
          (it) => !!(it.weapon || it.armour),
          (it) =>
            combat
              ? this.fight({ kind: "equip", item: it.id })
              : this.act({ act: it.equipped ? "unequip" : "equip", item: it.id }),
        );
      case "h":
        if (combat) return this.io.say("Not in the middle of a fight. Use A to attack.");
        return this.pickItem(
          "Hurl what?",
          () => true,
          (it) => this.target("throw", `Throw ${it.name} at what?`, this.everything(), false, it),
        );
      case "v":
        if (combat) return;
        return this.pickItem(
          "Give what?",
          () => true,
          (it) => this.target("give", `Give ${it.name} to whom?`, this.people({}), false, it),
        );
      case "f":
        if (combat) return;
        return this.target(
          "steal",
          "Filch from whom?",
          this.people({}).filter((t) => (t.kind === "thing" ? !!t.thing.contents?.length : false)),
        );
      case "b":
        if (combat) return;
        return this.target(
          "barter",
          "Barter with whom?",
          this.people({}).filter((t) => t.kind === "thing" && !!t.thing.merchant),
        );
      case "w":
        if (combat) return;
        return this.waitMenu();
      case "s":
        if (combat) return;
        return this.act(ui.status?.sneaking ? { act: "sneak", stop: true } : { act: "sneak" });
      case " ":
        return combat ? this.fight({ kind: "end" }) : this.act({ act: "wait", minutes: 1 });
      case "z":
        return this.meta("status");
      case "j":
        return this.meta("journal");
      case "i":
        return this.pickItem(
          "Your pack",
          () => true,
          (it) => this.act({ act: "examine", target: it.id }),
        );
      case "m":
        return this.allActions();
      case "?":
        ui.overlay = { title: "Keys", lines: HELP_LINES.map((t) => ({ spans: [{ text: t }] })) };
        return;
      case "q":
        return this.io.quit();
    }
  }

  private async walk(d: Tile): Promise<void> {
    const name = DIR_NAME[`${d[0]},${d[1]}`]!;
    if (this.ui.mode === "combat") return this.fight({ kind: "move", direction: name });
    // Walking into a closed door or a doorway goes through it; into a person, U5-style, does nothing much.
    return this.act({ act: "step", direction: name });
  }

  private useKey(): Promise<void> | void {
    if (this.ui.mode === "combat") {
      return this.pickItem(
        "Use what?",
        (it) => !!it.consumable,
        (it) => this.fight({ kind: "use", item: it.id }),
      );
    }
    const inv = this.ui.inventory?.entries ?? [];
    const items: UiMenuItem[] = inv.map((it) => ({
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
    this.ui.menu = { title: "Use what?", items, index: 0 };
  }

  private waitMenu(): void {
    const minute = this.ui.scene?.minute ?? 0;
    const until = (hh: number) => {
      const target = hh * 60;
      return (target - minute + 1440) % 1440 || 1440;
    };
    const w = (label: string, minutes: number): UiMenuItem => ({
      label,
      run: () => this.act({ act: "wait", minutes }),
    });
    this.ui.menu = {
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
    const items: MenuItem[] = this.ui.mode === "combat" ? (this.ui.combat?.options ?? []) : this.io.menu();
    this.ui.menu = {
      title: this.ui.mode === "combat" ? "Combat" : "What now?",
      index: 0,
      items: items.map((m) => ({ label: m.label, run: () => this.io.submit(m.intent) })),
    };
  }

  private pickItem(
    title: string,
    filter: (it: NonNullable<ViewOf<"inventory">["entries"]>[number]) => boolean,
    run: (it: NonNullable<ViewOf<"inventory">["entries"]>[number]) => void | Promise<void>,
  ): void {
    const inv = (this.ui.inventory?.entries ?? []).filter(filter);
    if (!inv.length) {
      this.io.say("You have nothing for that.");
      return;
    }
    this.ui.menu = {
      title,
      index: 0,
      items: inv.map((it) => ({ label: it.name, ...(it.equipped ? { detail: "ready" } : {}), run: () => run(it) })),
    };
  }

  // ─── Targets ───────────────────────────────────────────────────────────────

  private things(f: (t: SceneThing) => boolean): Target[] {
    return (this.ui.scene?.things ?? []).filter((t) => !t.player && f(t)).map((thing) => ({ kind: "thing", thing }));
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
    return (this.ui.scene?.exits ?? []).map((exit) => ({ kind: "exit", exit }));
  }

  private target(
    verb: Verb,
    title: string,
    candidates: Target[],
    allowSelf = false,
    item?: { id: string; name: string },
    self?: () => void | Promise<void>,
  ): void {
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
      void this.apply(verb, sorted[0]!, item);
      return;
    }
    this.ui.targeting = {
      verb,
      title,
      cursor: sorted[0] && !self ? pos(sorted[0]) : me,
      candidates: sorted,
      ...(item ? { item } : {}),
      ...(self || allowSelf ? { self: self ?? (() => this.meta("look")) } : {}),
    };
  }

  private async targetKey(str: string | undefined, k: Key): Promise<void> {
    const t = this.ui.targeting!;
    const me = this.player?.pos;
    const dir = (k.name && ARROWS[k.name]) || (str && NUMPAD[str]);
    if (k.name === "escape") {
      this.ui.targeting = undefined;
      return;
    }
    if (dir) {
      const s = this.ui.scene!;
      t.cursor = [
        Math.max(0, Math.min(s.w - 1, t.cursor[0] + dir[0])),
        Math.max(0, Math.min(s.h - 1, t.cursor[1] + dir[1])),
      ];
      return;
    }
    if (k.name === "tab") {
      if (!t.candidates.length) return;
      const here = t.candidates.findIndex((c) => sameTile(targetTiles(c), t.cursor));
      const next = (here + (k.shift ? -1 + t.candidates.length : 1)) % t.candidates.length;
      t.cursor = targetTiles(t.candidates[next]!)[0]!;
      return;
    }
    if (k.name === "return" || k.name === "enter" || str === " ") {
      const hit = t.candidates.find((c) => sameTile(targetTiles(c), t.cursor));
      this.ui.targeting = undefined;
      if (hit) return this.apply(t.verb, hit, t.item);
      if (me && t.cursor[0] === me[0] && t.cursor[1] === me[1] && t.self) return t.self();
      this.io.say("Nothing there for that.");
    }
  }

  /** Does the verb to the target. */
  private async apply(verb: Verb, target: Target, item?: { id: string; name: string }): Promise<void> {
    const combat = this.ui.mode === "combat";
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
        if (t.kind === "item" && this.ui.menu) {
          this.ui.menu.items.push({ label: `${t.name} itself`, run: () => this.act({ act: "take", item: t.id }) });
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
    this.ui.menu = { title, index: 0, items: t.contents.map((c) => ({ label: c.name, run: () => run(c) })) };
  }

  private barterMenu(t: SceneThing): void {
    const buys = this.io
      .menu()
      .filter((m) => m.intent.type === "action" && m.intent.action.act === "buy" && m.intent.action.from === t.id)
      .map((m) => ({ label: m.label.replace(/ from .*\(/, " (£"), run: () => this.io.submit(m.intent) }));
    const sells = (this.ui.inventory?.entries ?? []).map((it) => ({
      label: `sell ${it.name}`,
      run: () => this.act({ act: "sell", item: it.id, to: t.id }),
    }));
    if (!buys.length && !sells.length) {
      this.io.say(`${t.name} has nothing to trade.`);
      return;
    }
    this.ui.menu = { title: `Barter with ${t.name}`, index: 0, items: [...buys, ...sells] };
  }

  // ─── Menus ─────────────────────────────────────────────────────────────────

  private async menuKey(str: string | undefined, k: Key): Promise<void> {
    const m = this.ui.menu!;
    const n = m.items.length;
    if (k.name === "escape") {
      if (!m.sticky) this.ui.menu = m.back;
      return;
    }
    if (k.name === "up") m.index = (m.index - 1 + n) % n;
    else if (k.name === "down") m.index = (m.index + 1) % n;
    else if (k.name === "home") m.index = 0;
    else if (k.name === "end") m.index = n - 1;
    else if (str && /^[1-9]$/.test(str) && Number(str) <= n) {
      m.index = Number(str) - 1;
      return this.choose(m);
    } else if (k.name === "return" || k.name === "enter" || str === " ") return this.choose(m);
  }

  private async choose(m: UiMenu): Promise<void> {
    const item = m.items[m.index];
    if (!item) return;
    this.ui.menu = undefined;
    await item.run();
  }

  openConversation(): void {
    const c = this.ui.conversation;
    if (!c) return;
    this.ui.menu = {
      title: `Talking to ${c.with}`,
      index: 0,
      sticky: true,
      items: c.options.map((o) => ({ label: o.text, run: () => this.io.submit({ type: "option", index: o.index }) })),
    };
  }

  // ─── Creation ──────────────────────────────────────────────────────────────

  openCreate(): void {
    const c = this.ui.create;
    if (!c) return;
    this.ui.menu = {
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
            this.ui.allot = {
              special: Object.fromEntries(ATTRIBUTES.map((a) => [a, 5])) as Special,
              index: 0,
            };
          },
        },
      ],
    };
  }

  private async allotKey(str: string | undefined, k: Key): Promise<void> {
    const a = this.ui.allot!;
    const c = this.ui.create;
    const min = c?.min ?? 1;
    const max = c?.max ?? 10;
    const total = ATTRIBUTES.reduce((s, x) => s + a.special[x], 0);
    const left = 40 - total;
    const attr = ATTRIBUTES[a.index]!;
    if (k.name === "escape") {
      this.ui.allot = undefined;
      return;
    }
    if (k.name === "up") a.index = (a.index - 1 + ATTRIBUTES.length) % ATTRIBUTES.length;
    else if (k.name === "down") a.index = (a.index + 1) % ATTRIBUTES.length;
    else if ((k.name === "right" || str === "+") && left > 0 && a.special[attr] < max) a.special[attr]++;
    else if ((k.name === "left" || str === "-") && a.special[attr] > min) a.special[attr]--;
    else if ((k.name === "return" || k.name === "enter") && left === 0) {
      this.ui.allot = undefined;
      this.ui.menu = undefined;
      await this.io.submit({ type: "create", special: { ...a.special } });
    }
  }

  // ─── Overlays ──────────────────────────────────────────────────────────────

  private async overlayKey(str: string | undefined, k: Key): Promise<void> {
    const o = this.ui.overlay!;
    if (o.skills?.length) {
      const n = o.skills.length;
      if (k.name === "up") {
        o.index = ((o.index ?? 0) - 1 + n) % n;
        return;
      }
      if (k.name === "down") {
        o.index = ((o.index ?? 0) + 1) % n;
        return;
      }
      if (k.name === "return" || k.name === "enter" || str === "+") {
        const skill = o.skills[o.index ?? 0]!;
        this.ui.overlay = undefined;
        return this.meta("improve", skill.id);
      }
    }
    this.ui.overlay = undefined;
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
