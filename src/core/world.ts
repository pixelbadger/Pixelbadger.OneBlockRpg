/**
 * The World: payload (immutable) + state (a fold over events) + the append-only event log (§3.7, §4.9).
 * All state changes go through `emit`, which records the event and applies its ops.
 */

import { Rng, seedState } from "../mechanics/rng.js";
import {
  actionPoints,
  carryCapacity,
  effectiveSpecial,
  type Modifier,
  maxHp,
  skillValue,
} from "../mechanics/special.js";
import type {
  Behaviour,
  Callout,
  Character,
  Condition,
  Conversation,
  Ending,
  GameObject,
  Hook,
  Payload,
  Room,
  Scalar,
  SetPiece,
  SkillId,
  Special,
  TextVariants,
  Trigger,
} from "../payload/schema.js";
import { formatClock, parseClock } from "./clock.js";
import { type CondEnv, evalCondition } from "./conditions.js";
import type { EventKind } from "./event-kinds.js";
import { capitalise, interpolate, MESSAGES } from "./messages.js";
import { applyOps, clone, type Op, set } from "./ops.js";
import { placement } from "./space.js";
import type { Belief, CharState, LogEntry, LogKind, WorldState } from "./state.js";

export type CauseBy =
  | "player"
  | "behaviour"
  | "trigger"
  | "hook"
  | "rule"
  | "director"
  | "conversation"
  | "combat"
  | "reading"
  | "engine";

export interface Cause {
  by: CauseBy;
  ref?: string;
}

export interface WorldEvent {
  seq: number;
  at: number;
  day: number;
  kind: EventKind;
  actor?: string;
  targets: string[];
  payload: Record<string, unknown>;
  cause: Cause;
  ops: Op[];
}

/** Player-facing output produced during a turn. Not state: the frontend renders it. */
export interface Output {
  kind: "narration" | "speech" | "ambient" | "system" | "callout" | "combat" | "journal" | "ending" | "check";
  text: string;
  speaker?: string;
}

/** Requests from the core to the session for work the core cannot do (LLM calls, loop changes). */
export type Signal =
  | { kind: "conversation"; id: string }
  | { kind: "callout"; id: string }
  | { kind: "sleep"; quality: number; on?: string }
  | { kind: "collapse" }
  | { kind: "player-downed" }
  /** A character read a document that teaches something new: the narrative layer reconciles it (§4.13). */
  | { kind: "read"; who: string; thing: string };

export interface EvalContext {
  /** The owner/actor `self` resolves to. */
  self?: string;
  /** Events visible to this evaluation (the current window). */
  events?: readonly WorldEvent[];
  /** Hook arguments for `$arg` substitution. */
  args?: Record<string, unknown>;
  /** Who perceives text variants (default the player). */
  observer?: string;
}

export interface Index {
  rooms: Map<string, Room>;
  /** Objects and characters. */
  things: Map<string, GameObject | Character>;
  chars: Map<string, Character>;
  conversations: Map<string, Conversation>;
  hooks: Map<string, Hook>;
  behaviours: Map<string, Behaviour>;
  callouts: Map<string, Callout>;
  setPieces: Map<string, SetPiece>;
  endings: Map<string, Ending>;
  triggers: Map<string, Trigger>;
  beliefs: Map<string, string>;
}

export function buildIndex(p: Payload): Index {
  const byId = <T extends { id: string }>(xs: readonly T[]) => new Map(xs.map((x) => [x.id, x]));
  return {
    rooms: byId(p.rooms),
    things: new Map<string, GameObject | Character>([
      ...p.objects.map((o) => [o.id, o] as const),
      ...p.characters.map((c) => [c.id, c] as const),
    ]),
    chars: byId(p.characters),
    conversations: byId(p.conversations),
    hooks: byId(p.hooks),
    behaviours: byId(p.behaviours),
    callouts: byId(p.callouts),
    setPieces: byId(p.set_pieces),
    endings: byId(p.story.endings),
    triggers: byId(p.story.triggers),
    beliefs: new Map(p.story.beliefs.map((b) => [b.id, b.text])),
  };
}

function initialChar(c: Character, day: number): CharState {
  const beliefs: Belief[] = c.beliefs.map((b) =>
    typeof b === "string"
      ? { id: b, confidence: 1, source: "authored", day }
      : { id: b.belief, confidence: b.confidence, source: b.source, day },
  );
  return {
    special: { ...c.special },
    tags: [...c.tag_skills],
    skillPoints: { ...c.skill_points },
    unspentSkillPoints: 0,
    hp: c.hp ?? maxHp(c.special, c.level),
    level: c.level,
    xp: c.xp,
    money: c.money,
    awakeMinutes: Math.round(c.fatigue_hours * 60),
    asleepUntil: null,
    sleepQuality: 1,
    status: "ok",
    downUntil: null,
    hostile: c.hostile,
    combatProfile: { ...c.combat_profile },
    intent: c.intent ?? null,
    equipment: { ...c.equipment },
    relationships: clone(c.relationships),
    beliefs,
    modifiers: [],
    behaviours: [...c.behaviours],
    healAccum: 0,
    firstAidDay: null,
    sneaking: null,
  };
}

/**
 * Brings a saved state up to a compatible newer payload (§7.8): objects and characters the save has never seen
 * start as the payload declares them. Returns the ids added.
 */
export function addNewEntities(state: WorldState, p: Payload): string[] {
  const added: string[] = [];
  for (const o of [...p.objects, ...p.characters]) {
    if (state.objects[o.id]) continue;
    state.objects[o.id] = { location: o.location ?? null, props: clone(o.properties) };
    added.push(o.id);
  }
  for (const c of p.characters) if (!state.chars[c.id]) state.chars[c.id] = initialChar(c, state.day);
  placeAll(state, p);
  return added;
}

/**
 * Gives everything standing directly in a room a tile (§4.10): its authored tile, or the nearest free one. Runs on new
 * worlds and on saves from before maps (Q34).
 */
export function placeAll(state: WorldState, p: Payload): void {
  const w = new World(p, state);
  // Fixed objects first (they don't move), then characters, then everything else.
  const order = [...p.objects.filter((o) => !o.affordances.includes("takeable")), ...p.characters, ...p.objects];
  for (const o of order) {
    const s = state.objects[o.id];
    if (!s || s.pos || !s.location || !w.isRoom(s.location)) continue;
    s.pos = placement(w, o.id, s.location, null);
  }
  for (const s of Object.values(state.objects)) if (s.location && !w.isRoom(s.location)) s.pos = null;
}

export function initialState(p: Payload, seed: string): WorldState {
  const clock = parseClock(p.game.clock.time);
  const objects: WorldState["objects"] = {};
  const chars: WorldState["chars"] = {};
  for (const o of [...p.objects, ...p.characters]) {
    objects[o.id] = { location: o.location ?? null, props: clone(o.properties) };
  }
  for (const c of p.characters) chars[c.id] = initialChar(c, 1);
  const playerId = p.game.player.character;
  objects[playerId]!.location = p.game.start;
  const state: WorldState = {
    payloadId: p.game.id,
    payloadVersion: p.game.version,
    seed,
    clock,
    day: 1,
    windowFrom: clock,
    rng: seedState(seed),
    flags: {},
    objects,
    chars,
    visited: [p.game.start],
    triggersFired: [],
    edges: {},
    rules: {},
    hooksUsed: [],
    optionsUsed: [],
    dayLogs: {},
    summaries: {},
    callouts: {},
    conversation: null,
    setPiece: null,
    setPiecesDone: [],
    combat: null,
    ended: null,
    playerCreated: p.game.player.mode === "fixed",
  };
  placeAll(state, p);
  return state;
}

export class World {
  readonly ix: Index;
  readonly playerId: string;
  log: WorldEvent[] = [];
  out: Output[] = [];
  signals: Signal[] = [];
  /** Listeners notified of every event (persistence, debugging). */
  private listeners: ((e: WorldEvent) => void)[] = [];

  constructor(
    readonly payload: Payload,
    public state: WorldState,
  ) {
    this.ix = buildIndex(payload);
    this.playerId = payload.game.player.character;
  }

  static create(payload: Payload, seed: string): World {
    return new World(payload, initialState(payload, seed));
  }

  onEvent(fn: (e: WorldEvent) => void): void {
    this.listeners.push(fn);
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  emit(
    kind: EventKind,
    opts: {
      actor?: string;
      targets?: string[];
      payload?: Record<string, unknown>;
      cause?: Cause;
      ops?: Op[];
    } = {},
  ): WorldEvent {
    // A sneaking actor's events carry who noticed them; everyone else did not perceive the event (§5.4).
    const sneak = opts.actor && this.state.chars[opts.actor]?.sneaking;
    const e: WorldEvent = {
      seq: this.log.length,
      at: this.state.clock,
      day: this.state.day,
      kind,
      ...(opts.actor ? { actor: opts.actor } : {}),
      targets: opts.targets ?? [],
      payload: sneak ? { ...opts.payload, sneak: [...sneak.aware] } : (opts.payload ?? {}),
      cause: opts.cause ?? { by: "engine" },
      ops: opts.ops ?? [],
    };
    applyOps(this.state, e.ops);
    this.log.push(e);
    for (const l of this.listeners) l(e);
    return e;
  }

  /** Runs `fn` with the world's seeded PRNG and records the new PRNG state as an event. */
  roll<T>(fn: (rng: Rng) => T, cause?: Cause): T {
    const rng = new Rng(this.state.rng);
    const result = fn(rng);
    this.emit("rng", { ops: [set(["rng"], rng.state)], ...(cause ? { cause } : {}) });
    return result;
  }

  // ─── Output ────────────────────────────────────────────────────────────────

  say(text: string, kind: Output["kind"] = "narration", speaker?: string): void {
    if (!text.trim()) return;
    this.out.push({ kind, text, ...(speaker ? { speaker } : {}) });
  }

  drainOutput(): Output[] {
    const o = this.out;
    this.out = [];
    return o;
  }

  // ─── Payload lookup ────────────────────────────────────────────────────────

  thing(id: string): GameObject | Character | undefined {
    return this.ix.things.get(id);
  }

  isChar(id: string): boolean {
    return this.ix.chars.has(id);
  }

  isRoom(id: string): boolean {
    return this.ix.rooms.has(id);
  }

  char(id: string): CharState {
    const c = this.state.chars[id];
    if (!c) throw new Error(`not a character: ${id}`);
    return c;
  }

  charDef(id: string): Character {
    const c = this.ix.chars.get(id);
    if (!c) throw new Error(`not a character: ${id}`);
    return c;
  }

  /** Resolves `player` and `self` tokens. */
  resolve(who: string, ctx: EvalContext = {}): string {
    if (who === "player") return this.playerId;
    if (who === "self") return ctx.self ?? this.playerId;
    return who;
  }

  // ─── Location ──────────────────────────────────────────────────────────────

  locationOf(id: string): string | null {
    return this.state.objects[id]?.location ?? null;
  }

  /** The room an object or character is in, following containers and holders. Null if off-stage. */
  roomOf(id: string): string | null {
    let cur: string | null = id;
    for (let i = 0; i < 64 && cur; i++) {
      if (this.isRoom(cur)) return cur;
      cur = this.locationOf(cur);
    }
    return null;
  }

  /** Direct children of a room, container or character. */
  childrenOf(id: string): string[] {
    const out: string[] = [];
    for (const [oid, o] of Object.entries(this.state.objects)) if (o.location === id) out.push(oid);
    return out;
  }

  /** True if `id` is (transitively) inside or held by `holder`. */
  isWithin(id: string, holder: string): boolean {
    let cur = this.locationOf(id);
    for (let i = 0; i < 64 && cur; i++) {
      if (cur === holder) return true;
      if (this.isRoom(cur)) return false;
      cur = this.locationOf(cur);
    }
    return false;
  }

  /** The character directly or indirectly holding `id`, if any. */
  holderOf(id: string): string | null {
    let cur = this.locationOf(id);
    for (let i = 0; i < 64 && cur; i++) {
      if (this.isChar(cur)) return cur;
      if (this.isRoom(cur)) return null;
      cur = this.locationOf(cur);
    }
    return null;
  }

  isOpen(id: string): boolean {
    const def = this.thing(id);
    if (!def) return false;
    if (!def.affordances.includes("openable")) return true;
    return this.prop(id, "open") === true;
  }

  isContainer(id: string): boolean {
    const def = this.thing(id);
    return !!def && (def.affordances.includes("container") || def.affordances.includes("surface"));
  }

  prop(id: string, key: string): Scalar | undefined {
    return this.state.objects[id]?.props[key];
  }

  numProp(id: string, key: string, fallback = 0): number {
    const v = this.prop(id, key);
    return typeof v === "number" ? v : fallback;
  }

  mass(id: string): number {
    return this.numProp(id, "mass", 0);
  }

  /** Total mass carried by a character (everything held, recursively). */
  carried(charId: string): number {
    let total = 0;
    const walk = (holder: string) => {
      for (const c of this.childrenOf(holder)) {
        if (this.isChar(c)) continue;
        total += this.mass(c);
        walk(c);
      }
    };
    walk(charId);
    return Math.round(total * 100) / 100;
  }

  /** Everything a character holds, directly and inside held containers. */
  inventory(charId: string, deep = true): string[] {
    const out: string[] = [];
    const walk = (holder: string) => {
      for (const c of this.childrenOf(holder)) {
        if (this.isChar(c)) continue;
        out.push(c);
        if (deep && this.isContainer(c) && this.isOpen(c)) walk(c);
      }
    };
    walk(charId);
    return out;
  }

  // ─── Perception (§4, Q31) ──────────────────────────────────────────────────

  /** False for apparitions: entities only the player perceives. */
  npcsPerceive(id: string): boolean {
    return this.thing(id)?.perceived_by !== "player";
  }

  /** Can `observer` perceive entity `id` at all (ignoring location)? Apparitions and unnoticed sneakers are unseen. */
  perceives(observer: string, id: string): boolean {
    if (observer !== this.playerId && !this.npcsPerceive(id)) return false;
    const sneak = observer !== id ? this.state.chars[id]?.sneaking : null;
    if (sneak && !sneak.aware.includes(observer)) return false;
    return true;
  }

  /** True if `who` did not perceive event `e`: it involves an apparition (for NPCs) or an unnoticed sneaker. */
  missed(e: WorldEvent, who: string): boolean {
    if (who !== this.playerId && [e.actor, ...e.targets].some((id) => id && this.thing(id) && !this.npcsPerceive(id))) {
      return true;
    }
    const aware = e.payload.sneak as string[] | undefined;
    return !!aware && who !== e.actor && !aware.includes(who);
  }

  isSneaking(id: string): boolean {
    return !!this.state.chars[id]?.sneaking;
  }

  /** Hidden objects need their hidden_unless condition to hold for the player, or to have been found by ear (§4.11). */
  isHidden(id: string): boolean {
    const def = this.thing(id);
    return !!def?.hidden_unless && this.prop(id, "revealed") !== true && !this.cond(def.hidden_unless, { self: id });
  }

  /**
   * Objects and characters `observer` can perceive and interact with: everything in their room (looking into open
   * containers and onto surfaces) plus what they carry. Excludes off-stage things, hidden things (for the player),
   * and apparitions (for NPCs).
   */
  scope(observer: string): string[] {
    const room = this.roomOf(observer);
    if (!room) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (holder: string, intoChars: boolean) => {
      for (const c of this.childrenOf(holder)) {
        if (seen.has(c) || c === observer) continue;
        if (!this.perceives(observer, c)) continue;
        if (observer === this.playerId && this.isHidden(c)) continue;
        seen.add(c);
        out.push(c);
        if (this.isChar(c)) {
          if (intoChars) walk(c, false);
          continue;
        }
        if (this.isContainer(c) && this.isOpen(c)) walk(c, intoChars);
      }
    };
    walk(observer, false);
    walk(room, false);
    return out;
  }

  /** Characters present in a room (excluding apparitions when the observer is an NPC). */
  charsIn(room: string, observer?: string): string[] {
    return [...this.ix.chars.keys()].filter(
      (c) => this.locationOf(c) === room && (!observer || observer === c || this.perceives(observer, c)),
    );
  }

  /** Characters who can witness things: present, awake, conscious and not apparitions. */
  witnessesIn(room: string): string[] {
    return this.charsIn(room).filter((c) => {
      const s = this.char(c);
      return s.status === "ok" && s.asleepUntil === null && (c === this.playerId || this.npcsPerceive(c));
    });
  }

  isAwake(id: string): boolean {
    const s = this.char(id);
    return s.status === "ok" && s.asleepUntil === null;
  }

  // ─── Character stats ───────────────────────────────────────────────────────

  activeModifiers(id: string): Modifier[] {
    return this.char(id).modifiers;
  }

  special(id: string): Special {
    const s = this.char(id);
    return effectiveSpecial(s.special, s.modifiers, s.awakeMinutes);
  }

  skill(id: string, skill: SkillId): number {
    const s = this.char(id);
    return skillValue(skill, {
      special: this.special(id),
      tags: s.tags,
      points: s.skillPoints,
      modifiers: s.modifiers,
    });
  }

  ap(id: string): number {
    return actionPoints(this.special(id));
  }

  maxHp(id: string): number {
    const s = this.char(id);
    return maxHp(s.special, s.level);
  }

  capacity(id: string): number {
    return carryCapacity(this.special(id));
  }

  relationship(who: string, withWhom: string) {
    return this.char(who).relationships[withWhom] ?? { trust: 0, affinity: 0, notes: "" };
  }

  believes(who: string, belief: string): boolean {
    return this.char(who).beliefs.some((b) => b.id === belief);
  }

  // ─── Names and text ────────────────────────────────────────────────────────

  /** Display name: characters as written; objects with "the" unless the name is proper or already has an article. */
  name(id: string): string {
    if (id === this.playerId) return "you";
    const def = this.thing(id) ?? this.ix.rooms.get(id);
    if (!def) return id;
    if (this.isChar(id) || this.isRoom(id)) return def.name;
    return /^(the|a|an|some)\s/i.test(def.name) || /^[A-Z]/.test(def.name) ? def.name : `the ${def.name}`;
  }

  /** Third-person name, used in logs and prompts (the player by their character name). */
  label(id: string): string {
    if (id === this.playerId) return this.charDef(id).name;
    return this.name(id);
  }

  /** Evaluates a condition (§7.5). */
  cond(c: Condition, ctx: CondEnv = {}): boolean {
    return evalCondition(this, c, ctx);
  }

  /** Picks the first text variant whose condition holds and interpolates state into it (§7.4). */
  text(
    variants: TextVariants | undefined,
    ctx: CondEnv = {},
    vars: Record<string, string | number | undefined> = {},
  ): string {
    if (variants === undefined) return "";
    let raw: string;
    if (typeof variants === "string") raw = variants;
    else raw = variants.find((v) => !v.when || this.cond(v.when, ctx))?.text ?? "";
    return this.interpolate(raw, vars);
  }

  /** Interpolates {{clock.time}}, {{flags.x}}, {{objects.id.key}}, {{chars.id.field}}, {{player.name}} and vars. */
  interpolate(raw: string, vars: Record<string, string | number | undefined> = {}): string {
    return raw.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (m, path: string) => {
      if (vars[path] !== undefined) return String(vars[path]);
      const [head, a, b] = path.split(".");
      switch (head) {
        case "clock":
          if (a === "time") return formatClock(this.state.clock);
          if (a === "day") return String(this.state.day);
          break;
        case "flags":
          if (a) return String(this.state.flags[a] ?? "");
          break;
        case "objects":
          if (a && b) return String(this.state.objects[a]?.props[b] ?? "");
          if (a) return this.name(a);
          break;
        case "chars": {
          const c = a ? this.state.chars[a] : undefined;
          if (c && b && b in c) return String((c as unknown as Record<string, unknown>)[b]);
          if (a && !b) return this.label(a);
          break;
        }
        case "player":
          if (a === "name") return this.charDef(this.playerId).name;
          break;
      }
      return m;
    });
  }

  /** Engine message: per-object override, then game.messages, then the built-in template. */
  msg(key: string, vars: Record<string, string | number | undefined> = {}, objectId?: string): string {
    const short = key.split(".")[0]!;
    const def = objectId ? this.thing(objectId) : undefined;
    const override = def?.messages[key] ?? (key.endsWith(".ok") ? def?.messages[short] : undefined);
    if (override !== undefined) return capitalise(this.text(override, {}, vars));
    const template = this.payload.game.messages[key] ?? MESSAGES[key] ?? key;
    return capitalise(interpolate(template, vars));
  }

  clockText(): string {
    return `Day ${this.state.day}, ${formatClock(this.state.clock)}`;
  }

  // ─── Day logs (§6.8) ───────────────────────────────────────────────────────

  dayLog(who: string, kind: LogKind, text: string, cause?: Cause): void {
    if (!this.isChar(who) || !text) return;
    const entry: LogEntry = { at: this.state.clock, kind, text };
    this.emit("day-log", {
      targets: [who],
      payload: { kind },
      ops: [{ op: "push", path: ["dayLogs", who], value: entry }],
      ...(cause ? { cause } : {}),
    });
  }
}
