/**
 * The session (§3): the game's loops — exploration, conversation, combat, set piece and the day cycle — over a World,
 * driven by player intents and reporting view models through the UI port.
 */
import { perform } from "../core/actions.js";
import {
  type CombatOutcome,
  currentId,
  playerCombat,
  playerTargets,
  pursuable,
  runCombat,
  weaponOf,
} from "../core/combat.js";
import { describeRoom, visibleExits } from "../core/describe.js";
import { endGame } from "../core/effects.js";
import { giveMoney, heal, moveThing } from "../core/mutate.js";
import { set } from "../core/ops.js";
import { footprint, gridOf, isFixed, posOf } from "../core/space.js";
import { tick } from "../core/tick.js";
import type { Cause, World } from "../core/world.js";
import type { LlmProvider, UsageRecord } from "../llm/provider.js";
import { AP_COST } from "../mechanics/combat-math.js";
import {
  actionMinutes,
  actionPoints,
  allSkills,
  armourClass,
  carryCapacity,
  criticalChance,
  healingRate,
  maxHp,
  meleeDamageBonus,
  SKILL_NAMES,
  sequence,
  wakingHours,
} from "../mechanics/special.js";
import { runCallout } from "../narrative/callouts.js";
import { Conversations, type NarrativeDeps } from "../narrative/conversation.js";
import { Director } from "../narrative/director.js";
import { compactDayLogs, endDay } from "../narrative/memory.js";
import { ATTRIBUTES, type SkillId, type Special } from "../payload/schema.js";
import { actionMenu } from "./menu.js";
import { parseCombat, parseCommand, parseSkill } from "./parser.js";
import type { Fx, Intent, MenuItem, Mode, SceneThing, Tile, TurnOutput, ViewModel, ViewOf } from "./port.js";

const PLAYER: Cause = { by: "player" };
/** Game seconds per tile walked outside combat (§4.10, Q36). */
const STEP_SECONDS = 10;

export const HELP = `Type commands like: look, go north (or n), take kettle, open drawer, put key in drawer, use kettle,
use deed on letters, give letters to dev, show deed to okafor, talk to okafor, buy bandage from ravi,
throw mug at window, attack pike with knife, sneak (toggle), sneak north, wait 30, wait until 22:00, sleep, examine me.
Also: inventory (i), status, journal, menu (numbered actions available right now), improve <skill> [points].
In conversation, pick an option by number. In combat: attack <target>, use <item>, flee <direction>,
pursue <target>, end.`;

export interface SessionOptions {
  provider: LlmProvider;
  onUsage?: (u: UsageRecord) => void;
  /** Called with every intent the session accepts (for saves and replay). */
  onInput?: (intent: Intent) => void;
}

export class Session {
  readonly narrative: NarrativeDeps;
  readonly conversations: Conversations;
  readonly director: Director;
  private views: ViewModel[] = [];
  private lastMenu: MenuItem[] = [];
  /** Log position at the end of the last turn, for collecting this turn's fx. */
  private seen: number;

  constructor(
    readonly w: World,
    private readonly opts: SessionOptions,
  ) {
    this.narrative = { w, provider: opts.provider, ...(opts.onUsage ? { onUsage: opts.onUsage } : {}) };
    this.conversations = new Conversations(this.narrative);
    this.director = new Director(this.narrative);
    this.seen = w.log.length;
  }

  get mode(): Mode {
    const s = this.w.state;
    if (s.ended) return "ended";
    if (!s.playerCreated) return "create";
    if (s.combat?.combatants.some((c) => c.id === this.w.playerId && c.status === "in")) return "combat";
    if (s.conversation && !s.conversation.suspended) return "conversation";
    return "explore";
  }

  // ─── Output ────────────────────────────────────────────────────────────────

  private flushWorldOutput(): void {
    for (const o of this.w.drainOutput()) {
      this.views.push({ type: "narration", kind: o.kind, text: o.text, ...(o.speaker ? { speaker: o.speaker } : {}) });
    }
  }

  private finish(): TurnOutput {
    this.flushWorldOutput();
    const mode = this.mode;
    if (mode === "conversation") {
      const conv = this.w.state.conversation!;
      this.views.push({
        type: "conversation",
        with: this.w.label(conv.character),
        options: conv.options.map((o, index) => ({ index, text: o.text })),
      });
    } else if (mode === "combat") {
      this.views.push(this.combatView());
    } else if (mode === "create") {
      this.views.push(this.createView());
    } else if (mode === "ended") {
      const e = this.w.state.ended!;
      this.views.push({ type: "ended", ending: e.ending, ...(e.title ? { title: e.title } : {}), text: e.text });
    }
    if (mode !== "create" && mode !== "ended") this.views.push(this.statusView());
    const fx = this.fx();
    if (fx.length) this.views.push({ type: "fx", fx });
    const views = this.views;
    this.views = [];
    return { views, mode };
  }

  /** Flushes pending narration, then appends the room view, so text stays in the order it happened. */
  private pushRoom(): void {
    this.flushWorldOutput();
    this.views.push(this.roomView());
  }

  roomView(): ViewOf<"room"> {
    const room = this.w.roomOf(this.w.playerId)!;
    const sp = this.w.state.setPiece ? this.w.ix.setPieces.get(this.w.state.setPiece.id) : undefined;
    return { type: "room", room: describeRoom(this.w, room), ...(sp ? { objective: sp.objective } : {}) };
  }

  statusView(): ViewOf<"status"> {
    const w = this.w;
    const s = w.char(w.playerId);
    return {
      type: "status",
      clock: w.clockText(),
      day: w.state.day,
      hp: s.hp,
      maxHp: w.maxHp(w.playerId),
      awakeHours: Math.floor(s.awakeMinutes / 60),
      wakingHours: wakingHours(s.special.EN),
      money: s.money,
      level: s.level,
      xp: s.xp,
      unspentSkillPoints: s.unspentSkillPoints,
      sneaking: !!s.sneaking,
    };
  }

  inventoryView(): ViewOf<"inventory"> {
    const w = this.w;
    const p = w.playerId;
    const eq = w.char(p).equipment;
    const ids = w.inventory(p);
    return {
      type: "inventory",
      items: ids.map((id) => w.name(id)),
      equipped: [eq.weapon, eq.armour].filter((x): x is string => !!x).map((id) => w.name(id)),
      money: w.char(p).money,
      entries: ids.map((id) => {
        const def = w.thing(id)!;
        return {
          id,
          name: w.name(id),
          equipped: eq.weapon === id || eq.armour === id,
          ...(def.weapon ? { weapon: true } : {}),
          ...(def.armour ? { armour: true } : {}),
          ...(def.consumable ? { consumable: true } : {}),
        };
      }),
    };
  }

  /** The player's room as drawn (§4.10). */
  sceneView(): ViewOf<"scene"> {
    const w = this.w;
    const p = w.playerId;
    const room = w.roomOf(p)!;
    const r = w.ix.rooms.get(room)!;
    const g = gridOf(w, room)!;
    const visible = new Set(visibleExits(w, room).map((x) => x.label));
    const exits: ViewOf<"scene">["exits"] = [];
    r.exits.forEach((x, i) => {
      const label = x.direction ?? x.label ?? "?";
      if (!visible.has(label)) return;
      for (const pos of g.exitTiles.get(i) ?? []) {
        exits.push({
          pos,
          label: x.label ?? label,
          ...(x.direction ? { direction: x.direction } : {}),
          ...(x.to ? { to: x.to } : {}),
          ...(x.to && w.state.visited.includes(x.to) ? { toName: w.ix.rooms.get(x.to)!.name } : {}),
          blocked: !!x.blocked,
          ...(x.via
            ? { door: x.via, open: w.prop(x.via, "open") === true, locked: w.prop(x.via, "locked") === true }
            : {}),
        });
      }
    });
    const combat = w.state.combat?.room === room ? w.state.combat : null;
    const things: SceneThing[] = [];
    for (const id of w.childrenOf(room)) {
      const pos = w.state.objects[id]?.pos;
      if (!pos || !w.perceives(p, id) || w.isHidden(id)) continue;
      const def = w.thing(id)!;
      const t: SceneThing = {
        id,
        name: id === p ? w.charDef(p).name : w.label(id),
        kind: w.isChar(id) ? "character" : isFixed(w, id) ? "fixed" : "item",
        pos,
        tiles: footprint(w, id) as Tile[],
        ...(def.look ? { look: def.look } : {}),
      };
      if (w.isChar(id)) {
        const s = w.char(id);
        t.status = s.status === "ok" ? (s.asleepUntil !== null ? "asleep" : "ok") : s.status;
        if (id === p) t.player = true;
        if (s.hostile) t.hostile = true;
        if (!w.npcsPerceive(id)) t.apparition = true;
        const side = combat?.combatants.find((x) => x.id === id && x.status === "in")?.side;
        if (side) t.side = side;
        if (w.charDef(id).merchant) t.merchant = true;
        if (id !== p) t.contents = this.seenIn(id);
      } else {
        if (!w.npcsPerceive(id)) t.apparition = true;
        if (w.isContainer(id)) t.container = true;
        if (def.affordances.includes("openable")) t.open = w.prop(id, "open") === true;
        if (def.affordances.includes("lockable")) {
          t.lockable = true;
          t.locked = w.prop(id, "locked") === true;
        }
        if (w.isContainer(id) && w.isOpen(id)) t.contents = this.seenIn(id);
      }
      things.push(t);
    }
    // Characters last, so they draw over things on the floor.
    things.sort((a, b) => Number(a.kind === "character") - Number(b.kind === "character"));
    return {
      type: "scene",
      room,
      name: r.name,
      w: g.w,
      h: g.h,
      terrain: g.terrain,
      looks: Object.fromEntries(g.looks),
      exits,
      things,
      tags: r.tags,
      minute: w.state.clock % 1440,
    };
  }

  /** What the player can see directly inside (or held by) `holder`. */
  private seenIn(holder: string): { id: string; name: string }[] {
    const w = this.w;
    return w
      .childrenOf(holder)
      .filter((c) => !w.isChar(c) && !w.isHidden(c) && w.perceives(w.playerId, c))
      .map((c) => ({ id: c, name: w.name(c) }));
  }

  /** Spatial events since the last turn, for frontends that animate them. */
  private fx(): Fx[] {
    const w = this.w;
    const out: Fx[] = [];
    const here = w.roomOf(w.playerId);
    for (const e of w.log.slice(this.seen)) {
      const pl = e.payload as Record<string, unknown>;
      if (e.kind === "walked" && e.actor && w.roomOf(e.actor) === here) {
        out.push({ kind: "walk", id: e.actor, room: here ?? "", path: pl.path as Tile[] });
      } else if ((e.kind === "hit" || e.kind === "missed") && e.actor && e.targets[0]) {
        out.push({
          kind: e.kind === "hit" ? "hit" : "miss",
          actor: e.actor,
          target: e.targets[0],
          ...(pl.from ? { from: pl.from as Tile } : {}),
          ...(pl.to ? { to: pl.to as Tile } : {}),
          ranged: !!pl.ranged,
          ...(pl.crit ? { crit: true } : {}),
          ...(typeof pl.damage === "number" ? { damage: pl.damage } : {}),
        });
      } else if ((e.kind === "downed" || e.kind === "killed") && e.targets[0]) {
        const at = posOf(w, e.targets[0]);
        out.push({
          kind: e.kind === "downed" ? "down" : "killed",
          id: e.targets[0],
          ...(at ? { at: at as Tile } : {}),
        });
      }
    }
    this.seen = w.log.length;
    return out;
  }

  sheetView(): ViewOf<"sheet"> {
    const w = this.w;
    const p = w.playerId;
    const s = w.special(p);
    const st = w.char(p);
    const armour = st.equipment.armour ? w.thing(st.equipment.armour)?.armour : undefined;
    return {
      type: "sheet",
      name: w.charDef(p).name,
      special: s,
      base: st.special,
      derived: {
        HP: st.hp,
        "Max HP": w.maxHp(p),
        AP: actionPoints(s),
        AC: armourClass(s, armour?.ac ?? 0),
        "Carry (kg)": carryCapacity(s),
        Carried: w.carried(p),
        "Melee bonus": meleeDamageBonus(s),
        Sequence: sequence(s),
        "Healing / 6h": healingRate(s),
        "Crit %": criticalChance(s),
        Level: st.level,
        XP: st.xp,
        "Skill points": st.unspentSkillPoints,
      },
      skills: allSkills({ special: s, tags: st.tags, points: st.skillPoints, modifiers: st.modifiers }),
      tags: st.tags,
    };
  }

  /** The visited rooms and their visible exits; unvisited destinations are listed but not explored (fog of war). */
  mapView(): ViewOf<"map"> {
    const w = this.w;
    const here = w.roomOf(w.playerId)!;
    const visited = new Set([...w.state.visited, here]);
    const rooms = new Map<string, { id: string; name: string; visited: boolean }>();
    const exits: ViewOf<"map">["exits"] = [];
    for (const id of visited) {
      const r = w.ix.rooms.get(id);
      if (!r) continue;
      rooms.set(id, { id, name: r.name, visited: true });
      for (const x of visibleExits(w, id)) {
        exits.push({
          from: id,
          ...(x.to ? { to: x.to } : {}),
          direction: (x.direction ?? x.label).toLowerCase(),
          label: x.label,
          blocked: x.blocked,
        });
        if (x.to && !rooms.has(x.to) && !visited.has(x.to) && w.ix.rooms.has(x.to)) {
          rooms.set(x.to, { id: x.to, name: w.ix.rooms.get(x.to)!.name, visited: false });
        }
      }
    }
    return { type: "map", here, rooms: [...rooms.values()], exits };
  }

  private createView(): ViewModel {
    return { type: "create", presets: this.w.payload.game.player.presets, points: 5, min: 1, max: 10 };
  }

  private combatView(): ViewModel {
    const w = this.w;
    const c = w.state.combat!;
    const yourTurn = currentId(w) === w.playerId;
    const options: MenuItem[] = [];
    if (yourTurn) {
      const wpn = weaponOf(w, w.playerId);
      const add = (label: string, cost: number, intent: MenuItem["intent"]) => {
        if (cost <= c.ap) options.push({ label: `${label} (${cost} AP)`, intent });
      };
      for (const t of playerTargets(w)) {
        add(`attack ${w.label(t)}`, wpn.weapon.ap, { type: "combat", intent: { kind: "attack", target: t } });
        add(`aimed attack on ${w.label(t)}`, wpn.weapon.ap + AP_COST.aimed, {
          type: "combat",
          intent: { kind: "attack", target: t, aimed: true },
        });
      }
      for (const it of w.inventory(w.playerId)) {
        const def = w.thing(it)!;
        if (def.consumable)
          add(`use ${w.name(it)}`, AP_COST.useItem, { type: "combat", intent: { kind: "use", item: it } });
        if (def.weapon && w.char(w.playerId).equipment.weapon !== it) {
          add(`equip ${w.name(it)}`, AP_COST.equip, { type: "combat", intent: { kind: "equip", item: it } });
        }
      }
      if (wpn.weapon.ammo) add("reload", AP_COST.reload, { type: "combat", intent: { kind: "reload" } });
      for (const t of pursuable(w, w.playerId)) {
        add(`pursue ${w.label(t.id)} ${t.direction}`, AP_COST.leave, {
          type: "combat",
          intent: { kind: "pursue", target: t.id },
        });
      }
      for (const x of w.ix.rooms.get(c.room)?.exits ?? []) {
        if (x.to && !x.blocked) {
          const dir = x.direction ?? x.label!;
          add(`flee ${dir}`, AP_COST.leave, { type: "combat", intent: { kind: "flee", direction: dir } });
        }
      }
      options.push({ label: "end turn", intent: { type: "combat", intent: { kind: "end" } } });
    }
    this.lastMenu = options;
    return {
      type: "combat",
      round: c.round,
      ap: yourTurn ? c.ap : 0,
      yourTurn,
      combatants: c.combatants.map((x) => ({
        id: x.id,
        name: w.label(x.id),
        hp: w.char(x.id).hp,
        maxHp: w.maxHp(x.id),
        side: x.side,
        status: x.status,
      })),
      options,
    };
  }

  // ─── Start ─────────────────────────────────────────────────────────────────

  /** The opening views (or the current state, when resuming a save). */
  start(): TurnOutput {
    if (this.mode !== "create") this.opening();
    return this.finish();
  }

  private opening(): void {
    const w = this.w;
    if (w.log.length === 0 || !w.log.some((e) => e.kind !== "rng" && e.kind !== "player-created")) {
      const intro = w.payload.game.intro;
      if (intro) this.views.push({ type: "narration", kind: "narration", text: w.text(intro) });
    }
    if (this.mode === "explore") this.pushRoom();
  }

  // ─── Intents ───────────────────────────────────────────────────────────────

  async handle(intent: Intent): Promise<TurnOutput> {
    const mode = this.mode;
    if (mode === "ended") return this.finish();
    // Numbers pick from the current menu (action menu or combat options) or conversation options.
    if (
      intent.type === "command" &&
      /^\d+$/.test(intent.text.trim()) &&
      (mode !== "explore" || this.lastMenu.length > 0)
    ) {
      const n = Number(intent.text.trim());
      if (mode === "conversation") return this.handle({ type: "option", index: n - 1 });
      if (mode === "combat") this.combatView();
      const picked = this.lastMenu[n - 1];
      if (!picked) {
        this.views.push({ type: "narration", kind: "system", text: "No such option. Type menu to list them." });
        return this.finish();
      }
      return this.handle(picked.intent);
    }
    if (intent.type === "command") {
      const parsed =
        mode === "combat"
          ? parseCombat(
              this.w,
              intent.text,
              playerTargets(this.w),
              pursuable(this.w, this.w.playerId).map((t) => t.id),
            )
          : mode === "create"
            ? this.parseCreate(intent.text)
            : parseCommand(this.w, intent.text);
      if (!parsed.ok) {
        // Meta commands still work in combat.
        if (mode === "combat") {
          const meta = parseCommand(this.w, intent.text);
          if (meta.ok && meta.intent.type === "meta") return this.handle(meta.intent);
        }
        this.views.push({ type: "narration", kind: "system", text: parsed.error });
        return this.finish();
      }
      return this.handle(parsed.intent);
    }
    if (intent.type === "meta") {
      this.meta(intent.command, intent.arg);
      return this.finish();
    }
    this.opts.onInput?.(intent);
    switch (intent.type) {
      case "create":
        this.create(intent);
        break;
      case "action":
        if (mode === "explore") await this.exploreTurn(intent.action);
        else this.views.push({ type: "narration", kind: "system", text: "Not now." });
        break;
      case "option":
        if (mode === "conversation") await this.conversationChoice(intent.index);
        break;
      case "combat":
        if (mode === "combat") await this.afterCombatStep(playerCombat(this.w, intent.intent));
        else this.views.push({ type: "narration", kind: "system", text: "You're not fighting anyone." });
        break;
    }
    return this.finish();
  }

  private parseCreate(text: string): { ok: true; intent: Intent } | { ok: false; error: string } {
    const t = text.trim();
    const preset = this.w.payload.game.player.presets.find((p) => p.name.toLowerCase() === t.toLowerCase());
    if (preset) return { ok: true, intent: { type: "create", preset: preset.name } };
    const nums = t.split(/[\s,]+/).map(Number);
    if (nums.length === 7 && nums.every((n) => Number.isInteger(n))) {
      const special = Object.fromEntries(ATTRIBUTES.map((a, i) => [a, nums[i]!])) as Special;
      return { ok: true, intent: { type: "create", special } };
    }
    return {
      ok: false,
      error: "Choose a preset by name, or enter seven numbers for ST PE EN CH IN AG LK (each 1–10, totalling 40).",
    };
  }

  /** Point-buy character creation (§5.1, Q26): every attribute starts at 5, plus 5 free points, within 1–10. */
  private create(intent: Intent & { type: "create" }): void {
    const w = this.w;
    if (w.state.playerCreated) return;
    const special = intent.preset
      ? w.payload.game.player.presets.find((p) => p.name === intent.preset)?.special
      : intent.special;
    if (!special) {
      this.views.push({ type: "narration", kind: "system", text: "Unknown preset." });
      return;
    }
    const vals = ATTRIBUTES.map((a) => special[a]);
    const sum = vals.reduce((a, b) => a + b, 0);
    if (vals.some((v) => v < 1 || v > 10) || sum !== 40) {
      this.views.push({
        type: "narration",
        kind: "system",
        text: `Attributes must each be 1–10 and total 40 (yours total ${sum}).`,
      });
      return;
    }
    const p = w.playerId;
    w.emit("player-created", {
      targets: [p],
      payload: { special },
      cause: PLAYER,
      ops: [
        set(["chars", p, "special"], special),
        set(["chars", p, "hp"], maxHp(special, w.char(p).level)),
        set(["playerCreated"], true),
      ],
    });
    this.opening();
  }

  private meta(command: Intent & { type: "meta" } extends { command: infer C } ? C : never, arg?: string): void {
    const w = this.w;
    const p = w.playerId;
    switch (command) {
      case "look":
        this.pushRoom();
        break;
      case "inventory":
        this.views.push(this.inventoryView());
        break;
      case "status":
        this.views.push(this.sheetView());
        break;
      case "journal":
        this.views.push({ type: "journal", entries: [...(w.state.summaries[p] ?? [])] });
        break;
      case "menu": {
        this.lastMenu = this.mode === "combat" ? (this.combatView() as { options: MenuItem[] }).options : actionMenu(w);
        this.views.push({ type: "menu", items: this.lastMenu });
        break;
      }
      case "help":
        this.views.push({ type: "help", text: HELP });
        break;
      case "improve":
        this.improve(arg ?? "");
        break;
    }
  }

  /** Spend skill points (§5.9): one point raises a skill by 1, or by 2 if it is tagged. */
  private improve(arg: string): void {
    const w = this.w;
    const p = w.playerId;
    const [skillWord, nWord] = arg.trim().split(/\s+(?=\d+$)/);
    const skill = parseSkill(skillWord ?? "") as SkillId | undefined;
    const st = w.char(p);
    if (!skill) {
      this.views.push({
        type: "narration",
        kind: "system",
        text: `Improve which skill? ${Object.values(SKILL_NAMES).join(", ")}.`,
      });
      return;
    }
    const n = Math.min(st.unspentSkillPoints, Math.max(1, Number(nWord ?? 1) || 1));
    if (n <= 0 || st.unspentSkillPoints <= 0) {
      this.views.push({ type: "narration", kind: "system", text: w.msg("improve.none") });
      return;
    }
    this.opts.onInput?.({ type: "meta", command: "improve", arg });
    w.emit("skill-improved", {
      targets: [p],
      payload: { skill, points: n },
      cause: PLAYER,
      ops: [
        set(["chars", p, "skillPoints", skill], (st.skillPoints[skill] ?? 0) + n),
        set(["chars", p, "unspentSkillPoints"], st.unspentSkillPoints - n),
      ],
    });
    this.views.push({
      type: "narration",
      kind: "system",
      text: w.msg("improve.ok", { skill: SKILL_NAMES[skill], value: w.skill(p, skill) }),
    });
  }

  // ─── Exploration (§3.2) ────────────────────────────────────────────────────

  private async exploreTurn(
    action: Intent & { type: "action" } extends { action: infer A } ? A : never,
  ): Promise<void> {
    const w = this.w;
    const p = w.playerId;
    const roomBefore = w.roomOf(p);
    this.lastMenu = [];
    const r = perform(w, p, action, PLAYER);
    const minutes = (r.fixedTime ? r.minutes : actionMinutes(r.minutes, w.ap(p))) + this.walked(r.steps ?? 0);
    if (action.act === "look") this.pushRoom();
    await this.advance(minutes);
    // Inside a set piece the director takes one turn after each player turn (Q29).
    if (
      w.state.setPiece &&
      !w.state.ended &&
      this.mode === "explore" &&
      action.act !== "look" &&
      action.act !== "examine"
    ) {
      await this.director.turn();
      await this.advance(0);
    }
    if (this.mode === "explore" && w.roomOf(p) !== roomBefore) this.pushRoom();
    await compactDayLogs(this.narrative);
  }

  /** Turns tiles walked into whole minutes, carrying the remainder (§4.10: a step is 10 seconds). */
  private walked(steps: number): number {
    if (!steps) return 0;
    const w = this.w;
    const total = (w.state.seconds ?? 0) + steps * STEP_SECONDS;
    const rest = total % 60;
    if (rest !== (w.state.seconds ?? 0)) {
      w.emit("seconds-carried", { payload: { seconds: rest }, cause: PLAYER, ops: [set(["seconds"], rest)] });
    }
    return Math.floor(total / 60);
  }

  /** Advance time, then react: signals (conversations, callouts, sleep), combat, conversation endings. */
  private async advance(minutes: number): Promise<void> {
    const w = this.w;
    tick(w, minutes);
    await this.processSignals();
    await this.checkCombat();
  }

  private async processSignals(): Promise<void> {
    const w = this.w;
    for (let guard = 0; guard < 20 && w.signals.length > 0; guard++) {
      const s = w.signals.shift()!;
      this.flushWorldOutput();
      switch (s.kind) {
        case "conversation":
          if (!w.state.conversation && !w.state.combat && !w.state.ended) {
            const started = await this.conversations.start(s.id);
            // A conversation can end on its first turn (the character walks off, or wants to end).
            if (started && !w.state.conversation && !w.state.combat) await this.afterConversation();
          }
          break;
        case "callout":
          await runCallout(this.narrative, s.id);
          break;
        case "sleep":
          await this.sleep(s.quality, s.on);
          break;
        case "collapse":
          w.say(w.msg("collapse.player"));
          await this.sleep(0.5);
          break;
        case "player-downed":
          await this.playerDowned();
          break;
      }
      if (w.state.ended) {
        w.signals.length = 0;
        return;
      }
    }
  }

  private async checkCombat(): Promise<void> {
    const w = this.w;
    if (!w.state.combat) return;
    await this.afterCombatStep(runCombat(w));
  }

  private async afterCombatStep(out: CombatOutcome): Promise<void> {
    if (!out.ended) return;
    const w = this.w;
    this.lastMenu = [];
    this.flushWorldOutput();
    tick(w, out.minutes);
    if (out.playerDowned) await this.playerDowned();
    const conv = w.state.conversation;
    if (conv?.suspended && !w.state.ended) {
      const outcome = (
        w.log.filter((e) => e.kind === "combat-ended").at(-1)?.payload.result as
          | { id: string; status: string }[]
          | undefined
      )
        ?.map((r) => `${w.label(r.id)} ${r.status === "in" ? "still standing" : r.status}`)
        .join(", ");
      await this.conversations.resumeAfterCombat(outcome ?? "it ended");
      if (!w.state.conversation) await this.afterConversation();
    }
    await this.processSignals();
    if (w.state.combat) await this.afterCombatStep(runCombat(w));
    else if (this.mode === "explore") this.pushRoom();
  }

  // ─── Conversation (§3.3) ───────────────────────────────────────────────────

  private async conversationChoice(index: number): Promise<void> {
    const w = this.w;
    if (!w.state.conversation?.options[index]) {
      this.views.push({ type: "narration", kind: "system", text: "Pick one of the numbered options." });
      return;
    }
    await this.conversations.choose(index);
    if (w.state.combat) {
      await this.checkCombat();
      return;
    }
    if (!w.state.conversation) await this.afterConversation();
  }

  /** Conversation time is applied when it ends; then the world catches up. */
  private async afterConversation(): Promise<void> {
    const w = this.w;
    const ended = w.log.filter((e) => e.kind === "conversation-ended").at(-1);
    const minutes = (ended?.payload.minutes as number | undefined) ?? 0;
    await this.advance(minutes);
    if (this.mode === "explore") this.pushRoom();
  }

  // ─── Day cycle (§3.6, §5.8) ────────────────────────────────────────────────

  private async sleep(quality: number, on?: string): Promise<void> {
    const w = this.w;
    const p = w.playerId;
    if (w.state.conversation) this.conversations.end();
    w.say(on ? w.msg("sleep.ok", { item: w.name(on) }) : w.msg("sleep.floor"));
    w.emit("slept", {
      actor: p,
      targets: [p],
      payload: { quality },
      cause: PLAYER,
      ops: [set(["chars", p, "asleepUntil"], w.state.clock + 480), set(["chars", p, "sleepQuality"], quality)],
    });
    this.flushWorldOutput();
    // The player's sleep closes the day: summaries in every character's own perspective (§6.8).
    await endDay(this.narrative);
    const slept = tick(w, 480, { playerAsleep: true });
    const ops = [set(["chars", p, "asleepUntil"], null)];
    if (slept.minutes >= 480 && quality >= 1) ops.push(set(["chars", p, "awakeMinutes"], 0));
    w.emit("woke", { targets: [p], payload: { slept: slept.minutes }, cause: PLAYER, ops });
    w.say(w.msg("wake.ok"));
    const journal = (w.state.summaries[p] ?? []).at(-1);
    if (journal) w.say(journal.text, "journal");
    // Whatever happened in the night (dreams, callouts) comes before the room.
    await this.processSignals();
    this.pushRoom();
  }

  /** The payload decides (Q27): default wake up hurt and robbed somewhere in the block; or end the game. */
  private async playerDowned(): Promise<void> {
    const w = this.w;
    const p = w.playerId;
    const cfg = w.payload.game.downed;
    w.say(w.msg("combat.player-down"), "combat");
    if (cfg.mode === "end-game" && cfg.ending) {
      endGame(w, cfg.ending, { by: "engine", ref: "downed" });
      return;
    }
    const room = w.roomOf(p)!;
    const robber = w.charsIn(room).find((c) => c !== p && w.isAwake(c) && w.npcsPerceive(c));
    const cause: Cause = { by: "engine", ref: "downed" };
    for (const it of w.inventory(p, false))
      moveThing(w, it, robber ?? room, robber ? "stole" : "dropped", cause, robber);
    const money = w.char(p).money;
    if (money > 0) {
      giveMoney(w, p, -money, cause);
      if (robber) giveMoney(w, robber, money, cause);
    }
    const dest = cfg.room ?? w.payload.game.start;
    moveThing(w, p, dest, "relocated", cause);
    w.emit("woke", {
      targets: [p],
      cause,
      ops: [
        set(["chars", p, "status"], "ok"),
        set(["chars", p, "downUntil"], null),
        set(["chars", p, "hp"], Math.max(1, w.char(p).hp)),
      ],
    });
    heal(w, p, Math.max(1, Math.floor(w.maxHp(p) / 4) - w.char(p).hp), cause);
    tick(w, 60);
    w.say(cfg.text ? w.text(cfg.text) : w.msg("combat.wake-robbed", { room: w.ix.rooms.get(dest)!.name }));
    this.pushRoom();
  }

  /** Lists what the menu would offer (for frontends that render it persistently). */
  menu(): MenuItem[] {
    this.lastMenu = actionMenu(this.w);
    return this.lastMenu;
  }
}
