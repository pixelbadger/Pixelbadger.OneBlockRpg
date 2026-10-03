/**
 * The shared action vocabulary (§4.3, P4). The player, behaviours, conversation characters and the director all act
 * through `perform`, under the same preconditions. Results go to the player as authored/templated text when they
 * can perceive them, and back to the caller as a result (for LLM feedback, §6.6).
 */
import { maxThrowMass, throwVelocity } from "../mechanics/combat-math.js";
import {
  attributeCheck,
  buyPrice,
  opposedCheck,
  perceptionDefence,
  sellPrice,
  skillCheck,
} from "../mechanics/special.js";
import type { ActionRequest, ActionVerb, Exit, ForceMethod, UseRule } from "../payload/schema.js";
import { startCombat } from "./combat.js";
import { exitLabel } from "./describe.js";
import { applyEffects, resolveCheck } from "./effects.js";
import { listJoin } from "./messages.js";
import {
  addBelief,
  addModifier,
  adjustRelationship,
  awardXp,
  giveMoney,
  heal,
  moveThing,
  setCharField,
  setProp,
} from "./mutate.js";
import { set } from "./ops.js";
import { transgress } from "./ownership.js";
import { makeNoise } from "./sound.js";
import {
  canSee,
  cheb,
  dirOffset,
  distance,
  exitOnTile,
  findPath,
  footprint,
  gridOf,
  inReach,
  isFixed,
  isUnderfoot,
  occupancy,
  type Pos,
  pathNextTo,
  posOf,
  reachTiles,
  standable,
  terrainAt,
  walkable,
} from "./space.js";
import type { Cause, World } from "./world.js";

/** Engine sounds (§4.11). */
export const BREAKING = { loudness: 8, sound: "something breaking" };
export const FIGHTING = { loudness: 8, sound: "a fight: shouting, and blows landing" };

/** Base minutes at AP 8 (Q8: 1–5), scaled by 8 / AP. */
export const BASE_MINUTES: Record<ActionVerb, number> = {
  go: 2,
  step: 0,
  take: 1,
  drop: 1,
  put: 1,
  open: 1,
  close: 1,
  lock: 1,
  unlock: 1,
  use: 2,
  throw: 1,
  push: 2,
  give: 1,
  show: 1,
  steal: 1,
  buy: 3,
  sell: 3,
  equip: 1,
  unequip: 1,
  attack: 0,
  sleep: 0,
  talk: 0,
  wait: 0,
  examine: 1,
  look: 0,
  sneak: 0,
};

/** Sneaking makes every action take longer (§5.4). */
export const SNEAK_TIME = 1.5;
/** Steal bonus against a victim who hasn't noticed the thief. */
export const UNNOTICED_STEAL_BONUS = 20;

export interface ActionResult {
  ok: boolean;
  /** Base minutes (before AP scaling). */
  minutes: number;
  /** A short, neutral account for LLM feedback. */
  summary: string;
  /** True if time should not be scaled by AP (wait). */
  fixedTime?: boolean;
  /** Tiles walked, on top of `minutes` (§4.10: 10 seconds each). */
  steps?: number;
}

const fail = (summary: string): ActionResult => ({ ok: false, minutes: 0, summary });

interface Ctx {
  w: World;
  actor: string;
  cause: Cause;
  isPlayer: boolean;
  /** Player perceives this actor's actions (same room, awake). */
  seen: boolean;
  /** Tiles walked so far during this action. */
  steps: number;
  inCombat: boolean;
}

/** Tell the player: second person if they did it, third person if they saw it. */
function report(c: Ctx, verb: string, vars: Record<string, string | number | undefined>, obj?: string): string {
  const { w } = c;
  const base = { actor: w.name(c.actor), Actor: w.label(c.actor), ...vars };
  if (c.isPlayer) {
    const text = w.msg(`${verb}.ok`, base, obj);
    w.say(text);
    return text;
  }
  const text = w.msg(`${verb}.npc`, base, obj);
  if (c.seen) w.say(text, "ambient");
  return text;
}

function refuse(
  c: Ctx,
  key: string,
  vars: Record<string, string | number | undefined> = {},
  obj?: string,
): ActionResult {
  const text = c.w.msg(key, { actor: c.w.name(c.actor), Actor: c.w.label(c.actor), ...vars }, obj);
  if (c.isPlayer) c.w.say(text);
  return fail(text);
}

function playerSees(w: World, actor: string): boolean {
  if (actor === w.playerId) return true;
  const room = w.roomOf(actor);
  return !!room && room === w.roomOf(w.playerId) && w.isAwake(w.playerId) && w.perceives(w.playerId, actor);
}

/** Things the actor can reach right now: their room (through open containers) and what they carry. */
function inScope(c: Ctx, id: string | undefined): id is string {
  return !!id && c.w.scope(c.actor).includes(id);
}

function held(c: Ctx, id: string | undefined): id is string {
  return !!id && c.w.isWithin(id, c.actor);
}

export function perform(
  w: World,
  actor: string,
  req: ActionRequest,
  cause: Cause,
  opts: { inCombat?: boolean } = {},
): ActionResult {
  const c: Ctx = {
    w,
    actor,
    cause,
    isPlayer: actor === w.playerId,
    seen: playerSees(w, actor),
    steps: 0,
    inCombat: !!opts.inCombat,
  };
  if (!w.isChar(actor)) return fail(`${actor} is not a character`);
  const st = w.char(actor);
  if (st.status !== "ok") return fail(`${w.label(actor)} is ${st.status === "dead" ? "dead" : "unconscious"}`);
  if (st.asleepUntil !== null && req.act !== "wait") return refuse(c, "busy-asleep");
  if (w.state.combat && !opts.inCombat && req.act !== "look" && req.act !== "examine") {
    const inCombat = w.state.combat.combatants.some((x) => x.id === actor && x.status === "in");
    if (inCombat && req.act !== "attack") return fail("in combat");
  }
  if (req.act === "sneak") return sneak(c, req);
  if (st.sneaking) {
    // Talking or attacking gives a sneaker away; anything else is a fresh chance for each observer to notice.
    if (req.act === "talk" || req.act === "attack") stopSneaking(w, actor, c.cause, true);
    else if (req.act !== "look") sneakRolls(w, actor, w.roomOf(actor), c.cause);
    c.seen = playerSees(w, actor);
  }
  const approached = c.inCombat ? null : approach(c, req);
  const r = approached ?? dispatch(c, req);
  const out = c.steps ? { ...r, steps: c.steps } : r;
  if (w.char(actor).sneaking && !r.fixedTime && r.minutes > 0) return { ...out, minutes: r.minutes * SNEAK_TIME };
  return out;
}

// ─── Space: walking and reach (§4.10) ────────────────────────────────────────

/** Moves `who` along `path` within their room as one event. */
export function walk(w: World, who: string, path: readonly Pos[], cause: Cause): void {
  if (!path.length) return;
  w.emit("walked", {
    actor: who,
    targets: [who],
    payload: { path },
    cause,
    ops: [set(["objects", who, "pos"], path[path.length - 1])],
  });
  stepNoises(w, who, path, cause);
}

/** Things underfoot that make a sound when walked over (§4.11): each sounds once per walk. */
function stepNoises(w: World, who: string, path: readonly Pos[], cause: Cause): void {
  const room = w.roomOf(who);
  if (!room || !w.npcsPerceive(who)) return;
  for (const id of w.childrenOf(room)) {
    const noise = w.thing(id)?.step_noise;
    if (!noise || !isUnderfoot(w, id)) continue;
    const tiles = footprint(w, id);
    if (path.some((p) => tiles.some((t) => t[0] === p[0] && t[1] === p[1]))) {
      makeNoise(w, id, noise, cause, { actor: who, selfHears: true });
    }
  }
}

/** What an action needs within reach (adjacent tile), by verb. Things already held never need walking to. */
function reachNeeds(c: Ctx, req: ActionRequest): string[] {
  const { w } = c;
  const free = (id: string | undefined): id is string => !!id && id !== c.actor && !w.isWithin(id, c.actor);
  const ids: (string | undefined)[] = [];
  switch (req.act) {
    case "take": {
      const item = req.item ?? req.target;
      const holder = item ? w.holderOf(item) : null;
      ids.push(holder && holder !== c.actor ? holder : item);
      break;
    }
    case "put":
      ids.push(req.on ?? req.target ?? req.to);
      break;
    case "open":
    case "close":
    case "lock":
    case "unlock":
    case "push":
      ids.push(req.target ?? req.item);
      break;
    case "use": {
      const item = req.item ?? req.target;
      ids.push(item, req.item ? (req.on ?? (req.target !== req.item ? req.target : undefined)) : req.on);
      break;
    }
    case "give":
    case "show":
      ids.push(req.to ?? req.target);
      break;
    case "steal":
      ids.push(req.from ?? req.target);
      break;
    case "buy":
      ids.push(req.from ?? req.target);
      break;
    case "sell":
      ids.push(req.to ?? req.target);
      break;
    case "talk":
      ids.push(req.target ?? req.to);
      break;
    case "sleep": {
      const room = w.roomOf(c.actor);
      ids.push(
        (req.target ?? req.on ?? req.item) ||
          w.scope(c.actor).find((x) => w.thing(x)?.affordances.includes("sleepable") && w.roomOf(x) === room),
      );
      break;
    }
    case "attack": {
      const target = req.target;
      // Ranged and thrown attacks fire from where you stand when you can (§5.6).
      if (target && !rangedReach(w, c.actor, target, req.weapon)) ids.push(target);
      break;
    }
  }
  return ids.filter(free);
}

/** Can `who` hit `target` from here with a ranged weapon or a thrown item? */
export function rangedReach(w: World, who: string, target: string, thrown?: string): boolean {
  const range = attackRange(w, who, thrown);
  return range > 1 && distance(w, who, target) <= range && canSee(w, who, target);
}

/** Reach of `who`'s attack in tiles: 1 for melee, the weapon's range, or 2 × ST for something thrown (§5.6). */
export function attackRange(w: World, who: string, thrown?: string): number {
  if (thrown) return 2 * w.special(who).ST;
  const item = w.char(who).equipment.weapon;
  const def = item && w.isWithin(item, who) ? w.thing(item)?.weapon : undefined;
  if (!def?.ranged) return 1;
  return def.range ?? 15;
}

/** Walks the actor next to whatever the action needs, or refuses if they can't get there. */
function approach(c: Ctx, req: ActionRequest): ActionResult | null {
  const { w } = c;
  const room = w.roomOf(c.actor);
  if (!room) return null;
  for (const id of reachNeeds(c, req)) {
    if (!w.thing(id) || inReach(w, c.actor, id)) continue;
    const tiles = reachTiles(w, room, id);
    if (!tiles.length) continue;
    const path = pathNextTo(w, c.actor, tiles);
    if (!path) return refuse(c, "reach.none", { item: w.name(id) });
    walk(w, c.actor, path, c.cause);
    c.steps += path.length;
  }
  return null;
}

/** One tile in one of eight directions; onto an exit tile it is `go` through that exit (§4.10). */
function stepTo(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const room = w.roomOf(c.actor);
  const from = w.state.objects[c.actor]?.pos;
  const d = req.direction ? dirOffset(req.direction) : undefined;
  if (!room || !from || !d) return refuse(c, "step.wall");
  const g = gridOf(w, room)!;
  const to: Pos = [from[0] + d[0], from[1] + d[1]];
  const exit = exitOnTile(w, room, to);
  if (exit) return traverse(c, exit.exit);
  const occ = occupancy(w, room, c.actor);
  const cornerCut =
    d[0] !== 0 &&
    d[1] !== 0 &&
    (!walkable(terrainAt(g, [from[0] + d[0], from[1]])) || !walkable(terrainAt(g, [from[0], from[1] + d[1]])));
  if (!cornerCut && standable(g, to, occ)) {
    walk(w, c.actor, [to], c.cause);
    c.steps += 1;
    return { ok: true, minutes: 0, summary: `stepped ${req.direction}` };
  }
  const there = w.childrenOf(room).find((id) => {
    const p = w.state.objects[id]?.pos;
    if (w.isChar(id)) return !!p && p[0] === to[0] && p[1] === to[1] && w.char(id).status !== "dead";
    return (
      isFixed(w, id) && !isUnderfoot(w, id) && reachTiles(w, room, id).some((t) => t[0] === to[0] && t[1] === to[1])
    );
  });
  if (there && w.isChar(there)) return refuse(c, "step.someone", { Actor: w.label(there) });
  if (there) return refuse(c, "step.blocked", { item: w.name(there) }, there);
  return refuse(c, "step.wall");
}

function dispatch(c: Ctx, req: ActionRequest): ActionResult {
  switch (req.act) {
    case "go":
      return go(c, req);
    case "step":
      return stepTo(c, req);
    case "take":
      return take(c, req);
    case "drop":
      return drop(c, req);
    case "put":
      return put(c, req);
    case "open":
    case "close":
      return openClose(c, req, req.act);
    case "lock":
    case "unlock":
      return lockUnlock(c, req, req.act);
    case "use":
      return use(c, req);
    case "throw":
      return throwIt(c, req);
    case "push":
      return pushIt(c, req);
    case "give":
    case "show":
      return giveShow(c, req, req.act);
    case "steal":
      return steal(c, req);
    case "buy":
    case "sell":
      return trade(c, req, req.act);
    case "equip":
    case "unequip":
      return equip(c, req, req.act);
    case "attack":
      return attack(c, req);
    case "sleep":
      return sleep(c, req);
    case "talk":
      return talk(c, req);
    case "wait":
      return wait(c, req);
    case "examine":
      return examine(c, req);
    case "look":
      return { ok: true, minutes: 0, summary: "looked around" };
    case "sneak":
      return sneak(c, req);
  }
}

// ─── sneak (§5.4) ────────────────────────────────────────────────────────────

/**
 * Each awake observer in `room` who hasn't yet noticed the sneaker rolls once: Sneak vs 10×PE (opposed, with the
 * sneaker's Luck nudge). Observers who win notice them and stay aware while they share the room.
 */
export function sneakRolls(w: World, sneaker: string, room: string | null, cause: Cause): string[] {
  const s = w.char(sneaker).sneaking;
  if (!s || !room) return [];
  const observers = w.witnessesIn(room).filter((o) => o !== sneaker && !s.aware.includes(o) && canSee(w, o, sneaker));
  if (!observers.length) return [];
  const skill = w.skill(sneaker, "sneak");
  const LK = w.special(sneaker).LK;
  const results = w.roll(
    (rng) => observers.map((o) => opposedCheck(rng, skill, perceptionDefence(w.special(o)), "normal", 0, LK)),
    cause,
  );
  const noticed: string[] = [];
  observers.forEach((o, i) => {
    const result = results[i]!;
    w.emit("checked", { actor: sneaker, targets: [o], payload: { skill: "sneak", ...result }, cause });
    if (!result.pass) noticed.push(o);
  });
  for (const o of noticed) notice(w, o, sneaker, cause);
  return noticed;
}

/** `observer` becomes aware of a sneaking character. */
export function notice(w: World, observer: string, sneaker: string, cause: Cause): void {
  const s = w.char(sneaker).sneaking;
  if (!s || s.aware.includes(observer)) return;
  w.emit("noticed", {
    actor: observer,
    targets: [sneaker],
    cause,
    ops: [set(["chars", sneaker, "sneaking"], { aware: [...s.aware, observer] })],
  });
  if (sneaker === w.playerId) w.say(w.msg("sneak.noticed", { Observer: w.label(observer) }), "ambient");
  else if (observer === w.playerId) w.say(w.msg("sneak.npc-noticed", { Actor: w.label(sneaker) }), "ambient");
  w.dayLog(observer, "witnessed", `Noticed ${w.label(sneaker)} creeping about.`, cause);
}

/** Leaves the stance. `revealed` when an attack or a word gave the sneaker away. */
export function stopSneaking(w: World, who: string, cause: Cause, revealed = false): void {
  if (!w.char(who).sneaking) return;
  w.emit("sneak-ended", {
    actor: who,
    targets: [who],
    payload: { revealed },
    cause,
    ops: [set(["chars", who, "sneaking"], null)],
  });
  if (who === w.playerId) w.say(w.msg(revealed ? "sneak.revealed" : "sneak.stop"));
  else if (playerSees(w, who)) w.say(w.msg("sneak.stop-npc", { Actor: w.label(who) }), "ambient");
}

/** After a room change only those in the new room can still be aware of the sneaker. */
function pruneAware(w: World, who: string): void {
  const s = w.char(who).sneaking;
  if (!s) return;
  const room = w.roomOf(who);
  const aware = s.aware.filter((o) => w.roomOf(o) === room);
  if (aware.length !== s.aware.length) {
    w.emit("mode", { payload: { sneak: who }, ops: [set(["chars", who, "sneaking"], { aware })] });
  }
}

function sneak(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const sneaking = !!w.char(c.actor).sneaking;
  if (req.stop) {
    if (!sneaking) return refuse(c, "sneak.not");
    stopSneaking(w, c.actor, c.cause);
    return { ok: true, minutes: 0, summary: "stopped sneaking" };
  }
  if (sneaking && !req.direction && !req.to) return refuse(c, "sneak.already");
  if (sneaking) sneakRolls(w, c.actor, w.roomOf(c.actor), c.cause);
  else {
    const seen = c.seen;
    // The start is unseen by everyone; the rolls that follow decide who notices.
    w.emit("sneak-started", {
      actor: c.actor,
      targets: [c.actor],
      payload: { sneak: [] },
      cause: c.cause,
      ops: [set(["chars", c.actor, "sneaking"], { aware: [] })],
    });
    if (c.isPlayer) w.say(w.msg("sneak.ok"));
    else if (seen) w.say(w.msg("sneak.npc", { Actor: w.label(c.actor) }), "ambient");
    sneakRolls(w, c.actor, w.roomOf(c.actor), c.cause);
  }
  if (req.direction || req.to) {
    const r = go({ ...c, seen: playerSees(w, c.actor) }, { ...req, act: "go" });
    return { ...r, minutes: r.minutes * SNEAK_TIME, summary: `sneaked: ${r.summary}` };
  }
  return { ok: true, minutes: 0, summary: "started sneaking" };
}

// ─── go ──────────────────────────────────────────────────────────────────────

export function findExit(w: World, room: string, token: string): Exit | undefined {
  const r = w.ix.rooms.get(room);
  if (!r) return undefined;
  const t = token.toLowerCase();
  return (
    r.exits.find((x) => x.direction?.toLowerCase() === t || x.label?.toLowerCase() === t) ??
    r.exits.find((x) => x.to === token) ??
    r.exits.find((x) => x.to && w.ix.rooms.get(x.to)?.name.toLowerCase() === t)
  );
}

/** Breadth-first route through exits whose conditions hold. Returns the exits to take, or null. */
export function route(w: World, from: string, to: string): Exit[] | null {
  if (from === to) return [];
  const prev = new Map<string, { room: string; exit: Exit }>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const x of w.ix.rooms.get(cur)?.exits ?? []) {
      if (!x.to || seen.has(x.to)) continue;
      if (x.when && !w.cond(x.when)) continue;
      seen.add(x.to);
      prev.set(x.to, { room: cur, exit: x });
      if (x.to === to) {
        const path: Exit[] = [];
        let r = to;
        while (r !== from) {
          const p = prev.get(r)!;
          path.unshift(p.exit);
          r = p.room;
        }
        return path;
      }
      queue.push(x.to);
    }
  }
  return null;
}

function passDoor(c: Ctx, x: Exit): ActionResult | null {
  const { w } = c;
  if (!x.via) return null;
  if (w.prop(x.via, "open") === true) return null;
  const door = x.via;
  if (w.prop(door, "locked") === true) {
    const key = w.thing(door)?.key;
    if (!c.isPlayer && key && w.isWithin(key, c.actor)) {
      setProp(w, door, "locked", false, c.cause, c.actor);
      w.emit("unlocked", { actor: c.actor, targets: [door], cause: c.cause });
    } else {
      return refuse(c, "go.door-locked", { door: w.name(door) }, door);
    }
  }
  setProp(w, door, "open", true, c.cause, c.actor);
  w.emit("opened", { actor: c.actor, targets: [door], cause: c.cause });
  if (c.isPlayer) w.say(w.msg("go.door-opened", { door: w.name(door) }));
  return null;
}

/** Walks the actor to an exit's tile, then through it (§4.10). */
function traverse(c: Ctx, x: Exit): ActionResult {
  const { w } = c;
  const room = w.locationOf(c.actor)!;
  const g = gridOf(w, room);
  const from = w.state.objects[c.actor]?.pos;
  const index = w.ix.rooms.get(room)?.exits.indexOf(x) ?? -1;
  const tiles = g?.exitTiles.get(index) ?? [];
  if (g && from && tiles.length && !tiles.some((t) => cheb(t, from) <= 1)) {
    const occ = occupancy(w, room, c.actor);
    const path = findPath(g, from, (p) => tiles.some((t) => cheb(t, p) <= 1) && standable(g, p, occ), occ);
    if (!path) return refuse(c, "go.no-path", { dir: exitLabel(x) });
    walk(w, c.actor, path, c.cause);
    c.steps += path.length;
  }
  return cross(c, x);
}

function cross(c: Ctx, x: Exit): ActionResult {
  const { w } = c;
  const from = w.locationOf(c.actor)!;
  if (x.blocked) {
    const text = w.text(x.blocked, { self: c.actor });
    if (c.isPlayer) w.say(text);
    return fail(text || "That way is blocked.");
  }
  if (x.when && !w.cond(x.when, { self: c.actor })) {
    if (c.isPlayer) w.say(x.closed_text ? w.text(x.closed_text) : w.msg("go.closed"));
    return fail("the way is closed");
  }
  const blocked = passDoor(c, x);
  if (blocked) return blocked;
  const dir = exitLabel(x);
  // Compass and up/down read as "go north"; anything else (a label, a floor number) as "go to the Stairwell".
  const compass = /^(north|south|east|west|up|down|in|out|north-?east|north-?west|south-?east|south-?west)$/i.test(dir);
  const room = w.ix.rooms.get(x.to!)!.name;
  const playerRoom = w.roomOf(w.playerId);
  moveThing(w, c.actor, x.to!, "moved", c.cause, c.actor, [from, x.to!], x.via ? { via: x.via } : {});
  pruneAware(w, c.actor);
  // A sneaker's arrival is a fresh chance for those in the next room to notice.
  sneakRolls(w, c.actor, x.to!, c.cause);
  const seenArriving = c.isPlayer || (w.perceives(w.playerId, c.actor) && w.isAwake(w.playerId));
  if (c.isPlayer) {
    w.say(w.msg(compass ? "go.ok" : "go.ok-to", { dir, room }));
  } else if (seenArriving) {
    if (playerRoom === from) {
      w.say(w.msg(compass ? "go.npc-leave" : "go.npc-leave-to", { Actor: w.label(c.actor), dir, room }), "ambient");
    } else if (playerRoom === x.to) w.say(w.msg("go.npc-arrive", { Actor: w.label(c.actor) }), "ambient");
  }
  return { ok: true, minutes: BASE_MINUTES.go, summary: `went ${dir} to ${w.ix.rooms.get(x.to!)!.name}` };
}

function go(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const room = w.locationOf(c.actor);
  if (!room || !w.isRoom(room)) return fail("not in a room");
  const token = req.direction ?? req.to;
  if (!token) return refuse(c, "go.no-exit");
  const x = findExit(w, room, token);
  if (x) return traverse(c, x);
  // Characters may be sent to any room by id: walk the route one exit at a time.
  if (!c.isPlayer && w.isRoom(token)) {
    const path = route(w, room, token);
    if (!path) return fail(`no route to ${token}`);
    let minutes = 0;
    for (const e of path) {
      const r = traverse(c, e);
      if (!r.ok) return { ...r, minutes };
      minutes += r.minutes;
    }
    return { ok: true, minutes, summary: `went to ${w.ix.rooms.get(token)!.name}` };
  }
  return refuse(c, "go.no-exit");
}

// ─── take / drop / put ───────────────────────────────────────────────────────

function take(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const item = req.item ?? req.target;
  if (!item || !w.thing(item) || w.isChar(item)) return refuse(c, "not-here");
  const holder = w.holderOf(item);
  if (holder === c.actor) return refuse(c, "take.already", { item: w.name(item) }, item);
  if (holder && holder !== c.actor) {
    // Taking from a character needs consent: a give, a successful steal, or the holder being down (§5.7).
    if (w.roomOf(holder) !== w.roomOf(c.actor)) return refuse(c, "not-here");
    const hs = w.char(holder);
    if (hs.status === "ok") {
      if (c.isPlayer) return refuse(c, "take.consent", { holder: w.label(holder) });
      return steal(c, { act: "steal", item, from: holder });
    }
  } else if (!inScope(c, item)) {
    return refuse(c, "not-here");
  }
  const def = w.thing(item)!;
  if (!def.affordances.includes("takeable")) return refuse(c, "take.fixed", { item: w.name(item) }, item);
  if (w.prop(item, "fastened") === true) return refuse(c, "take.fastened", { item: w.name(item) }, item);
  const loc = w.locationOf(item)!;
  if (!w.isRoom(loc) && !w.isChar(loc) && !w.isOpen(loc)) {
    return refuse(c, "take.closed", { container: w.name(loc) });
  }
  const carried = w.carried(c.actor);
  const capacity = w.capacity(c.actor);
  if (carried + w.mass(item) > capacity) {
    return refuse(c, "take.too-heavy", { item: w.name(item), capacity, carried }, item);
  }
  moveThing(w, item, c.actor, "took", c.cause, c.actor, holder ? [holder] : []);
  report(c, "take", { item: w.name(item) }, item);
  if (!holder) transgress(w, c.actor, item, "took", c.cause);
  return { ok: true, minutes: BASE_MINUTES.take, summary: `took ${w.label(item)}` };
}

function drop(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const item = req.item ?? req.target;
  if (!held(c, item)) return refuse(c, "not-held", { item: item ? w.name(item) : "that" });
  moveThing(w, item, w.roomOf(c.actor), "dropped", c.cause, c.actor);
  report(c, "drop", { item: w.name(item) }, item);
  return { ok: true, minutes: BASE_MINUTES.drop, summary: `dropped ${w.label(item)}` };
}

function put(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const item = req.item;
  const container = req.on ?? req.target ?? req.to;
  if (!held(c, item)) return refuse(c, "not-held", { item: item ? w.name(item) : "that" });
  if (!container || (!inScope(c, container) && !held(c, container))) return refuse(c, "not-here");
  if (!w.isContainer(container)) return refuse(c, "put.not-container", { container: w.name(container) }, container);
  if (container === item || w.isWithin(container, item)) return refuse(c, "put.self");
  if (!w.isOpen(container)) return refuse(c, "put.closed", { container: w.name(container) }, container);
  const capacity = w.numProp(container, "capacity", Number.POSITIVE_INFINITY);
  const inside = w.childrenOf(container).reduce((a, x) => a + w.mass(x), 0);
  if (inside + w.mass(item) > capacity) return refuse(c, "put.full", { container: w.name(container) }, container);
  moveThing(w, item, container, "put", c.cause, c.actor, [container]);
  report(c, "put", { item: w.name(item), container: w.name(container) }, item);
  return { ok: true, minutes: BASE_MINUTES.put, summary: `put ${w.label(item)} in ${w.label(container)}` };
}

// ─── open / close / lock / unlock ────────────────────────────────────────────

function openClose(c: Ctx, req: ActionRequest, verb: "open" | "close"): ActionResult {
  const { w } = c;
  const id = req.target ?? req.item;
  if (!id || (!inScope(c, id) && !doorHere(c, id))) return refuse(c, "not-here");
  const def = w.thing(id)!;
  if (!def.affordances.includes("openable")) return refuse(c, `${verb}.cannot`, { item: w.name(id) }, id);
  const open = w.prop(id, "open") === true;
  if (verb === "open" && open) return refuse(c, "open.already", { item: w.name(id) }, id);
  if (verb === "close" && !open) return refuse(c, "close.already", { item: w.name(id) }, id);
  if (verb === "open" && w.prop(id, "locked") === true) return refuse(c, "open.locked", { item: w.name(id) }, id);
  if (verb === "open" && w.prop(id, "fastened") === true) return refuse(c, "open.fastened", { item: w.name(id) }, id);
  setProp(w, id, "open", verb === "open", c.cause, c.actor);
  w.emit(verb === "open" ? "opened" : "closed", { actor: c.actor, targets: [id], cause: c.cause });
  report(c, verb, { item: w.name(id) }, id);
  if (verb === "open" && c.isPlayer && w.isContainer(id)) {
    const inside = w.childrenOf(id).filter((x) => !w.isHidden(x) && w.perceives(w.playerId, x));
    if (inside.length) w.say(w.msg("open.contents", { contents: listJoin(inside.map((x) => w.name(x))) }));
  }
  return { ok: true, minutes: BASE_MINUTES[verb], summary: `${verb === "open" ? "opened" : "closed"} ${w.label(id)}` };
}

/** Doors referenced by an exit of the actor's room are in reach even if located elsewhere. */
function doorHere(c: Ctx, id: string): boolean {
  const room = c.w.roomOf(c.actor);
  return !!room && !!c.w.ix.rooms.get(room)?.exits.some((x) => x.via === id);
}

function lockUnlock(c: Ctx, req: ActionRequest, verb: "lock" | "unlock"): ActionResult {
  const { w } = c;
  const id = req.target ?? req.item;
  if (!id || (!inScope(c, id) && !doorHere(c, id))) return refuse(c, "not-here");
  const def = w.thing(id)!;
  if (!def.affordances.includes("lockable")) return refuse(c, "lock.cannot", { item: w.name(id) }, id);
  const locked = w.prop(id, "locked") === true;
  if (verb === "lock" && locked) return refuse(c, "lock.already", { item: w.name(id) }, id);
  if (verb === "lock" && w.prop(id, "forced") === true) return refuse(c, "lock.broken", { item: w.name(id) }, id);
  if (verb === "unlock" && !locked) return refuse(c, "unlock.already", { item: w.name(id) }, id);
  if (verb === "lock" && w.prop(id, "open") === true) return refuse(c, "lock.open", { item: w.name(id) }, id);
  const hasKey = !!def.key && w.isWithin(def.key, c.actor);
  let minutes = BASE_MINUTES[verb];
  if (!hasKey) {
    const tool =
      verb === "unlock" ? w.inventory(c.actor).find((x) => w.thing(x)?.tags.includes("lockpick")) : undefined;
    if (!tool) return refuse(c, "lock.no-key");
    // Lockpick (§5.3): a skill check at the lock's tier.
    const result = w.roll(
      (rng) => skillCheck(rng, w.skill(c.actor, "lockpick"), def.lock_tier ?? "normal", 0, w.special(c.actor).LK),
      c.cause,
    );
    w.emit("checked", {
      actor: c.actor,
      targets: [id],
      payload: { skill: "lockpick", ...result },
      cause: c.cause,
    });
    minutes = 3;
    if (!result.pass) {
      if (c.isPlayer) w.say(w.msg("unlock.pick-failed", { tool: w.name(tool) }));
      return { ok: false, minutes, summary: "failed to pick the lock" };
    }
    if (c.isPlayer) {
      w.say(w.msg("unlock.picked", { tool: w.name(tool) }));
      awardXp(w, c.actor, w.payload.game.xp.check, c.cause);
    }
  }
  setProp(w, id, "locked", verb === "lock", c.cause, c.actor);
  w.emit(verb === "lock" ? "locked" : "unlocked", { actor: c.actor, targets: [id], cause: c.cause });
  if (hasKey || !c.isPlayer) report(c, verb, { item: w.name(id) }, id);
  return { ok: true, minutes, summary: `${verb}ed ${w.label(id)}` };
}

// ─── use ─────────────────────────────────────────────────────────────────────

function ruleMatches(w: World, rule: UseRule, on: string | undefined, actor: string): boolean {
  if (rule.on === undefined ? on !== undefined : on === undefined) return false;
  if (rule.on && on) {
    if (rule.on.startsWith("tag:")) {
      if (!w.thing(on)?.tags.includes(rule.on.slice(4))) return false;
    } else if (rule.on !== on) return false;
  }
  return !rule.when || w.cond(rule.when, { self: actor });
}

function use(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const item = req.item ?? req.target;
  const on = req.item ? (req.on ?? (req.target !== req.item ? req.target : undefined)) : req.on;
  if (!item || (!inScope(c, item) && !doorHere(c, item))) return refuse(c, "not-here");
  if (on && !inScope(c, on) && !doorHere(c, on) && on !== c.actor) return refuse(c, "not-here");
  const def = w.thing(item)!;
  let rule = def.uses.find((r) => ruleMatches(w, r, on, c.actor));
  let owner = item;
  if (!rule && on) {
    // "use key on door" may be authored on either side.
    const onDef = w.thing(on);
    rule = onDef?.uses.find((r) => ruleMatches(w, r, item, c.actor));
    if (rule) owner = on;
  }
  if (rule) {
    if (rule.text) {
      const text = w.text(rule.text, { self: c.actor });
      if (c.isPlayer || c.seen) w.say(text);
    } else if (!c.isPlayer && c.seen) {
      w.say(w.msg("use.npc", { Actor: w.label(c.actor), item: w.name(item) }), "ambient");
    }
    w.emit("used", { actor: c.actor, targets: on ? [item, on] : [item], payload: { owner }, cause: c.cause });
    if (rule.noise) makeNoise(w, on ?? item, rule.noise, c.cause, { actor: c.actor });
    applyEffects(w, rule.effects, { by: "rule", ref: `${owner}.uses` }, { self: c.actor });
    if (rule.consume) moveThing(w, item, null, "removed", c.cause, c.actor);
    return { ok: true, minutes: rule.minutes ?? BASE_MINUTES.use, summary: `used ${w.label(item)}` };
  }
  // Tools work on anything with a way of forcing it that takes their tag (§4.12), in either order.
  if (on && held(c, item) && forceMethod(w, on, item)) return force(c, on, item);
  if (on && held(c, on) && forceMethod(w, item, on)) return force(c, item, on);
  if (def.consumable && !on) return consume(c, item);
  if (def.consumable && on && w.isChar(on)) return consume(c, item, on);
  return refuse(c, "use.nothing", { item: w.name(item), onText: on ? ` on ${w.name(on)}` : "" }, item);
}

// ─── force (§4.12) ───────────────────────────────────────────────────────────

/** The first of `target`'s ways of being forced that `tool` (by its tags) can do. */
export function forceMethod(w: World, target: string, tool: string): ForceMethod | undefined {
  const tags = w.thing(tool)?.tags ?? [];
  return w.thing(target)?.force.find((m) => m.tools.some((t) => tags.includes(t)));
}

/** Something the actor holds that could force `target`, if anything. */
export function forceTool(w: World, actor: string, target: string): string | undefined {
  return w.inventory(actor).find((x) => forceMethod(w, target, x));
}

/**
 * Forces `target` with `tool`: unfastens it, breaks its lock and opens it if it opens. The method's check (if any)
 * decides success; either way the attempt takes its time and makes its noise, and anyone watching sees it.
 */
function force(c: Ctx, target: string, tool: string): ActionResult {
  const { w } = c;
  const m = forceMethod(w, target, tool)!;
  const vars = { item: w.name(target), tool: w.name(tool), Actor: w.label(c.actor) };
  if (w.prop(target, "fastened") !== true && w.prop(target, "locked") !== true) {
    return refuse(c, "force.nothing", vars, target);
  }
  const minutes = m.minutes;
  if (m.noise) makeNoise(w, target, m.noise, c.cause, { actor: c.actor });
  let pass = true;
  if (m.check) pass = resolveCheck(w, { who: c.actor, ...m.check }, { self: c.actor }, c.cause).pass;
  if (!pass) {
    if (c.isPlayer) w.say(m.fail_text ? w.text(m.fail_text, { self: c.actor }) : w.msg("force.failed", vars, target));
    else if (c.seen) w.say(w.msg("force.npc-failed", vars, target), "ambient");
    return { ok: false, minutes, summary: `failed to force ${w.label(target)}` };
  }
  const def = w.thing(target)!;
  if (w.prop(target, "fastened") === true) setProp(w, target, "fastened", false, c.cause, c.actor);
  if (w.prop(target, "locked") === true) setProp(w, target, "locked", false, c.cause, c.actor);
  setProp(w, target, "forced", true, c.cause, c.actor);
  if (def.affordances.includes("openable") && w.prop(target, "open") !== true) {
    setProp(w, target, "open", true, c.cause, c.actor);
  }
  w.emit("forced", { actor: c.actor, targets: [target, tool], cause: c.cause });
  if (m.text) {
    if (c.isPlayer || c.seen) w.say(w.text(m.text, { self: c.actor }));
  } else if (c.isPlayer) w.say(w.msg("force.ok", vars, target));
  else if (c.seen) w.say(w.msg("force.npc", vars, target), "ambient");
  if (c.isPlayer && w.isContainer(target)) {
    const inside = w.childrenOf(target).filter((x) => !w.isHidden(x) && w.perceives(w.playerId, x));
    if (inside.length) w.say(w.msg("open.contents", { contents: listJoin(inside.map((x) => w.name(x))) }));
  }
  transgress(w, c.actor, target, "forced", c.cause);
  applyEffects(w, m.effects, { by: "rule", ref: `${target}.force` }, { self: c.actor });
  return { ok: true, minutes, summary: `forced ${w.label(target)} with ${w.label(tool)}` };
}

function consume(c: Ctx, item: string, on?: string): ActionResult {
  const { w } = c;
  const target = on ?? c.actor;
  const def = w.thing(item)!;
  const k = def.consumable!;
  const cause: Cause = { by: "rule", ref: `${item}.consumable` };
  if (k.text) {
    if (c.isPlayer || c.seen) w.say(w.text(k.text, { self: c.actor }));
  } else report(c, "consume", { item: w.name(item) }, item);
  if (k.heal) heal(w, target, k.heal, cause);
  if (k.fatigue) {
    const awake = Math.max(0, w.char(target).awakeMinutes - Math.round(k.fatigue * 60));
    setCharField(w, target, "awakeMinutes", awake, "fatigue", cause);
  }
  for (const m of k.modifiers) {
    addModifier(
      w,
      target,
      {
        amount: m.amount,
        ...(m.attribute ? { attribute: m.attribute } : {}),
        ...(m.skill ? { skill: m.skill } : {}),
        ...(m.hours ? { minutes: m.hours * 60 } : {}),
        source: item,
      },
      cause,
    );
  }
  applyEffects(w, k.effects, cause, { self: target });
  w.emit("used", { actor: c.actor, targets: on ? [item, on] : [item], payload: { consumed: true }, cause: c.cause });
  moveThing(w, item, null, "removed", c.cause, c.actor);
  return { ok: true, minutes: BASE_MINUTES.use, summary: `used up ${w.label(item)}` };
}

// ─── throw / push (§4.2, Q18) ────────────────────────────────────────────────

function throwIt(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const item = req.item;
  const target = req.target ?? req.on;
  if (!held(c, item)) return refuse(c, "not-held", { item: item ? w.name(item) : "that" });
  const mass = w.mass(item);
  const ST = w.special(c.actor).ST;
  if (mass > maxThrowMass(ST)) return refuse(c, "throw.too-heavy", { item: w.name(item) }, item);
  if (target && !inScope(c, target)) return refuse(c, "not-here");
  if (target && w.roomOf(target) === w.roomOf(c.actor)) {
    if (!canSee(w, c.actor, target)) return refuse(c, "throw.no-sight", { target: w.name(target) });
    if (distance(w, c.actor, target) > 2 * ST) return refuse(c, "throw.out-of-range", { target: w.name(target) });
  }
  // Throwing at a person is an attack with an improvised weapon (§5.6).
  if (target && w.isChar(target)) return attack(c, { act: "attack", target, weapon: item });
  const velocity = throwVelocity(ST, mass);
  const room = w.roomOf(c.actor)!;
  const lands = target ? posOf(w, target) : null;
  moveThing(w, item, room, "thrown", c.cause, c.actor, target ? [target] : [], lands ? { pos: lands } : {});
  setProp(w, item, "velocity", velocity, c.cause, c.actor);
  if (target) {
    const vars = { item: w.name(item), target: w.name(target), Actor: w.label(c.actor) };
    if (c.isPlayer) w.say(w.msg("throw.at", vars, item));
    else if (c.seen) w.say(w.msg("throw.at-npc", vars, item), "ambient");
  } else {
    report(c, "throw", { item: w.name(item) }, item);
  }
  if (!target) return { ok: true, minutes: BASE_MINUTES.throw, summary: `threw ${w.label(item)}` };
  const hit = w.roll((rng) => skillCheck(rng, w.skill(c.actor, "throwing"), "easy", 0, w.special(c.actor).LK), c.cause);
  w.emit("checked", {
    actor: c.actor,
    targets: [item, target],
    payload: { skill: "throwing", ...hit },
    cause: c.cause,
  });
  if (!hit.pass) {
    if (c.isPlayer || c.seen) w.say(w.msg("throw.miss"));
    return {
      ok: true,
      minutes: BASE_MINUTES.throw,
      summary: `threw ${w.label(item)} at ${w.label(target)} and missed`,
    };
  }
  impact(c, item, target, mass * velocity);
  return { ok: true, minutes: BASE_MINUTES.throw, summary: `threw ${w.label(item)} at ${w.label(target)} and hit` };
}

/** Mass × velocity against break thresholds, on both the projectile and what it hit. */
function impact(c: Ctx, item: string, target: string, energy: number): void {
  const { w } = c;
  w.emit("impact", { actor: c.actor, targets: [target, item], payload: { energy }, cause: c.cause });
  if (c.isPlayer || c.seen) w.say(w.msg("throw.hit", { target: w.name(target) }, item));
  for (const id of [target, item]) {
    const breakAt = w.thing(id)?.break_at;
    if (breakAt !== undefined && energy >= breakAt && w.prop(id, "broken") !== true) {
      setProp(w, id, "broken", true, c.cause, c.actor);
      w.emit("broken", { actor: c.actor, targets: [id], payload: { energy }, cause: c.cause });
      if (c.isPlayer || c.seen) w.say(w.msg("break.ok", { item: w.name(id) }, id));
      makeNoise(w, id, BREAKING, c.cause, { actor: c.actor });
      transgress(w, c.actor, id, "broke", c.cause);
    }
  }
}

function pushIt(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const id = req.target ?? req.item;
  if (!id || !inScope(c, id)) return refuse(c, "not-here");
  const def = w.thing(id)!;
  if (!def.affordances.includes("pushable")) return refuse(c, "push.fixed", { item: w.name(id) }, id);
  const mass = w.mass(id);
  const check = w.roll(
    (rng) => attributeCheck(rng, w.special(c.actor).ST, -Math.floor(mass / 25), w.special(c.actor).LK),
    c.cause,
  );
  w.emit("checked", { actor: c.actor, targets: [id], payload: { attribute: "ST", ...check }, cause: c.cause });
  if (!check.pass) {
    if (c.isPlayer) w.say(w.msg("push.failed", { item: w.name(id) }, id));
    return { ok: false, minutes: BASE_MINUTES.push, summary: `failed to push ${w.label(id)}` };
  }
  const velocity = Math.max(1, w.special(c.actor).ST - Math.floor(mass / 25));
  if (req.direction) {
    const room = w.roomOf(c.actor)!;
    const x = findExit(w, room, req.direction);
    if (!x?.to || x.blocked || (x.when && !w.cond(x.when)) || (x.via && w.prop(x.via, "open") !== true)) {
      return refuse(c, "push.cannot", { item: w.name(id) }, id);
    }
    moveThing(w, id, x.to, "pushed", c.cause, c.actor, [x.to]);
    setProp(w, id, "velocity", velocity, c.cause, c.actor);
    if (c.isPlayer) w.say(w.msg("push.moved", { item: w.name(id), dir: exitLabel(x) }, id));
    return { ok: true, minutes: BASE_MINUTES.push, summary: `pushed ${w.label(id)} ${exitLabel(x)}` };
  }
  setProp(w, id, "velocity", velocity, c.cause, c.actor);
  w.emit("pushed", { actor: c.actor, targets: [id], cause: c.cause });
  report(c, "push", { item: w.name(id) }, id);
  return { ok: true, minutes: BASE_MINUTES.push, summary: `pushed ${w.label(id)}` };
}

// ─── give / show / steal / trade (§5.7) ──────────────────────────────────────

function giveShow(c: Ctx, req: ActionRequest, verb: "give" | "show"): ActionResult {
  const { w } = c;
  const item = req.item;
  const to = req.to ?? req.target;
  if (!held(c, item)) return refuse(c, "not-held", { item: item ? w.name(item) : "that" });
  if (!to || !w.isChar(to) || w.roomOf(to) !== w.roomOf(c.actor) || !w.perceives(c.actor, to)) {
    return refuse(c, to && !w.isChar(to) ? "give.not-char" : "not-here");
  }
  if (verb === "give") {
    if (!w.npcsPerceive(to)) return refuse(c, "give.apparition", { target: w.label(to) });
    if (w.carried(to) + w.mass(item) > w.capacity(to)) return refuse(c, "give.cannot-carry", { target: w.label(to) });
    moveThing(w, item, to, "gave", c.cause, c.actor, [to]);
  } else {
    w.emit("showed", { actor: c.actor, targets: [item, to], cause: c.cause });
  }
  const vars = { item: w.name(item), target: to === w.playerId ? "you" : w.label(to) };
  report(c, verb, vars, item);
  return {
    ok: true,
    minutes: BASE_MINUTES[verb],
    summary: `${verb === "give" ? "gave" : "showed"} ${w.label(item)} to ${w.label(to)}`,
  };
}

function steal(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const item = req.item;
  const from = req.from ?? req.target;
  if (!from || !w.isChar(from) || w.roomOf(from) !== w.roomOf(c.actor)) return refuse(c, "not-here");
  if (!item || w.holderOf(item) !== from) return refuse(c, "steal.not-held", { target: w.label(from) });
  const victim = w.char(from);
  const vars = { item: w.name(item), target: w.label(from), Actor: w.label(c.actor) };
  if (w.carried(c.actor) + w.mass(item) > w.capacity(c.actor)) {
    return refuse(c, "take.too-heavy", {
      item: w.name(item),
      capacity: w.capacity(c.actor),
      carried: w.carried(c.actor),
    });
  }
  let pass = victim.status !== "ok" || victim.asleepUntil !== null;
  if (!pass) {
    // Steal vs 10×PE of the target, −1 per kg of the item (§5.4).
    const unnoticed = w.isSneaking(c.actor) && !w.perceives(from, c.actor);
    const skill = w.skill(c.actor, "steal") - Math.round(w.mass(item)) + (unnoticed ? UNNOTICED_STEAL_BONUS : 0);
    const result = w.roll(
      (rng) => opposedCheck(rng, skill, perceptionDefence(w.special(from)), "normal", 0, w.special(c.actor).LK),
      c.cause,
    );
    w.emit("checked", {
      actor: c.actor,
      targets: [from, item],
      payload: { skill: "steal", ...result },
      cause: c.cause,
    });
    pass = result.pass;
  }
  if (!pass) {
    notice(w, from, c.actor, c.cause);
    w.emit("caught-stealing", { actor: c.actor, targets: [item, from], cause: c.cause });
    adjustRelationship(w, from, c.actor, { trust: -20, affinity: -10 }, c.cause);
    if (c.isPlayer) w.say(w.msg("steal.caught", vars));
    else if (from === w.playerId) w.say(w.msg("steal.npc-caught", vars));
    return { ok: false, minutes: BASE_MINUTES.steal, summary: `was caught trying to steal ${w.label(item)}` };
  }
  moveThing(w, item, c.actor, "stole", c.cause, c.actor, [from]);
  if (c.isPlayer) {
    w.say(w.msg("steal.ok", vars));
    awardXp(w, c.actor, w.payload.game.xp.check, c.cause);
  }
  return { ok: true, minutes: BASE_MINUTES.steal, summary: `stole ${w.label(item)} from ${w.label(from)}` };
}

export function priceOf(w: World, item: string, merchant: string, buyer: string, verb: "buy" | "sell"): number {
  const value = w.numProp(item, "value", 0);
  return verb === "buy"
    ? buyPrice(value, w.skill(merchant, "barter"), w.skill(buyer, "barter"))
    : sellPrice(value, w.skill(buyer, "barter"), w.skill(merchant, "barter"));
}

function trade(c: Ctx, req: ActionRequest, verb: "buy" | "sell"): ActionResult {
  const { w } = c;
  const item = req.item;
  const other = verb === "buy" ? (req.from ?? req.target) : (req.to ?? req.target);
  if (!other || !w.isChar(other) || w.roomOf(other) !== w.roomOf(c.actor)) return refuse(c, "not-here");
  const vars = { item: item ? w.name(item) : "that", target: w.label(other) };
  if (!w.charDef(other).merchant || !w.isAwake(other)) return refuse(c, `${verb}.not-merchant`, vars);
  if (!item) return refuse(c, "not-here");
  const price = priceOf(w, item, other, c.actor, verb);
  if (verb === "buy") {
    if (w.holderOf(item) !== other) return refuse(c, "buy.not-for-sale", vars);
    if (w.char(c.actor).money < price) {
      return refuse(c, "buy.poor", { ...vars, price, money: w.char(c.actor).money });
    }
    if (w.carried(c.actor) + w.mass(item) > w.capacity(c.actor)) {
      return refuse(c, "take.too-heavy", {
        item: w.name(item),
        capacity: w.capacity(c.actor),
        carried: w.carried(c.actor),
      });
    }
    giveMoney(w, c.actor, -price, c.cause);
    giveMoney(w, other, price, c.cause);
    moveThing(w, item, c.actor, "bought", c.cause, c.actor, [other]);
  } else {
    if (!held(c, item)) return refuse(c, "not-held", vars);
    if (w.char(other).money < price) return refuse(c, "sell.poor", vars);
    giveMoney(w, other, -price, c.cause);
    giveMoney(w, c.actor, price, c.cause);
    moveThing(w, item, other, "sold", c.cause, c.actor, [other]);
  }
  if (c.isPlayer) w.say(w.msg(`${verb}.ok`, { ...vars, price }));
  return {
    ok: true,
    minutes: BASE_MINUTES[verb],
    summary: `${verb === "buy" ? "bought" : "sold"} ${w.label(item)} for ${price}`,
  };
}

// ─── equipment ───────────────────────────────────────────────────────────────

function equip(c: Ctx, req: ActionRequest, verb: "equip" | "unequip"): ActionResult {
  const { w } = c;
  const item = req.item ?? req.target;
  if (!item || !w.thing(item)) return refuse(c, "not-here");
  const def = w.thing(item)!;
  const slot = def.weapon ? "weapon" : def.armour ? "armour" : null;
  if (verb === "unequip") {
    const eq = w.char(c.actor).equipment;
    const s = eq.weapon === item ? "weapon" : eq.armour === item ? "armour" : null;
    if (!s) return refuse(c, "unequip.not", { item: w.name(item) });
    w.emit("unequipped", {
      actor: c.actor,
      targets: [item],
      cause: c.cause,
      ops: [set(["chars", c.actor, "equipment", s], null)],
    });
    if (c.isPlayer) w.say(w.msg("unequip.ok", { item: w.name(item) }));
    return { ok: true, minutes: BASE_MINUTES.unequip, summary: `put away ${w.label(item)}` };
  }
  if (!held(c, item)) return refuse(c, "not-held", { item: w.name(item) });
  if (!slot) return refuse(c, "equip.cannot", { item: w.name(item) });
  w.emit("equipped", {
    actor: c.actor,
    targets: [item],
    cause: c.cause,
    ops: [set(["chars", c.actor, "equipment", slot], item)],
  });
  report(c, "equip", { item: w.name(item) }, item);
  if (def.weapon && def.weapon.min_st > w.special(c.actor).ST && c.isPlayer) {
    w.say(w.msg("equip.weak", { item: w.name(item), min: def.weapon.min_st }));
  }
  return { ok: true, minutes: BASE_MINUTES.equip, summary: `readied ${w.label(item)}` };
}

// ─── attack, sleep, talk, wait, examine ──────────────────────────────────────

function attack(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const target = req.target;
  if (!target || !w.isChar(target) || w.roomOf(target) !== w.roomOf(c.actor) || !w.perceives(c.actor, target)) {
    return refuse(c, "not-here");
  }
  if (target === c.actor) return fail("cannot attack yourself");
  // Apparitions are seen, not touched (Q31).
  if (!w.npcsPerceive(target)) return refuse(c, "attack.apparition", { target: w.label(target) });
  if (w.char(target).status === "dead") return fail(`${w.label(target)} is already dead`);
  const weapon = req.weapon && held(c, req.weapon) ? req.weapon : undefined;
  w.emit("attacked", { actor: c.actor, targets: [target], payload: { weapon: weapon ?? null }, cause: c.cause });
  makeNoise(w, c.actor, FIGHTING, c.cause, { actor: c.actor });
  startCombat(w, c.actor, target, weapon, c.cause);
  return { ok: true, minutes: 0, summary: `attacked ${w.label(target)}` };
}

function sleep(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const room = w.roomOf(c.actor)!;
  const on =
    (req.target ?? req.on ?? req.item) ||
    w.scope(c.actor).find((x) => w.thing(x)?.affordances.includes("sleepable") && w.roomOf(x) === room);
  let quality = 0.5;
  if (on) {
    if (!inScope(c, on)) return refuse(c, "not-here");
    if (!w.thing(on)?.affordances.includes("sleepable")) return fail(`${w.label(on)} is not something to sleep on`);
    quality = 1;
  }
  if (c.isPlayer) {
    w.signals.push({ kind: "sleep", quality, ...(on ? { on } : {}) });
    return { ok: true, minutes: 0, summary: "went to sleep" };
  }
  fallAsleep(w, c.actor, quality, c.cause);
  return { ok: true, minutes: 0, summary: "went to sleep" };
}

/** An NPC sleeps 8 hours, or until something wakes them. */
export function fallAsleep(w: World, who: string, quality: number, cause: Cause, collapsed = false): void {
  w.emit(collapsed ? "collapsed" : "slept", {
    targets: [who],
    payload: { quality },
    cause,
    ops: [
      set(["chars", who, "asleepUntil"], w.state.clock + 480),
      set(["chars", who, "sleepQuality"], quality),
      set(["chars", who, "sneaking"], null),
    ],
  });
  if (playerSees(w, who) && who !== w.playerId) {
    w.say(w.msg(collapsed ? "collapse.npc" : "sleep.npc", { Actor: w.label(who) }), "ambient");
  }
}

function talk(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const target = req.target ?? req.to;
  if (!c.isPlayer) return fail("only the player starts conversations with talk; characters use start_conversation");
  if (!target || !inScope(c, target)) return refuse(c, "not-here");
  if (!w.isChar(target)) return refuse(c, "talk.not-char", { target: w.name(target) });
  const s = w.char(target);
  const vars = { target: w.label(target) };
  if (s.status !== "ok") return refuse(c, "talk.down", vars);
  if (s.asleepUntil !== null) return refuse(c, "talk.asleep", vars);
  if (s.hostile) return refuse(c, "talk.hostile", vars);
  const def = w.charDef(target);
  if (def.talk_when && !w.cond(def.talk_when, { self: target })) {
    const text = def.refuse_text ? w.text(def.refuse_text, { self: target }) : w.msg("talk.nothing", vars);
    w.say(text);
    return fail(text);
  }
  const conv = availableConversation(w, target);
  if (!conv) {
    const text = def.refuse_text ? w.text(def.refuse_text, { self: target }) : w.msg("talk.nothing", vars);
    w.say(text);
    return fail(text);
  }
  w.signals.push({ kind: "conversation", id: conv });
  return { ok: true, minutes: 0, summary: `started talking to ${w.label(target)}` };
}

/** The highest-priority conversation spec of a character whose availability condition holds (§6.2). */
export function availableConversation(w: World, character: string): string | undefined {
  const specs = w.payload.conversations
    .filter((cv) => cv.character === character && (!cv.when || w.cond(cv.when, { self: character })))
    .sort((a, b) => b.priority - a.priority);
  return specs[0]?.id;
}

function wait(c: Ctx, req: ActionRequest): ActionResult {
  const minutes = Math.max(1, Math.min(1440, req.minutes ?? 10));
  if (c.isPlayer) c.w.say(c.w.msg("wait.ok"));
  c.w.emit("waited", { actor: c.actor, payload: { minutes }, cause: c.cause });
  return { ok: true, minutes, summary: `waited ${minutes} minutes`, fixedTime: true };
}

function examine(c: Ctx, req: ActionRequest): ActionResult {
  const { w } = c;
  const id = req.target ?? req.item;
  if (id === c.actor) {
    if (c.isPlayer) {
      const def = w.charDef(c.actor);
      w.say(w.text(def.description, { self: c.actor }));
      w.say(w.msg("examine.self", { name: def.name, hp: w.char(c.actor).hp, maxHp: w.maxHp(c.actor) }), "system");
    }
    return { ok: true, minutes: 0, summary: "examined themself" };
  }
  if (!id || (!inScope(c, id) && !doorHere(c, id))) return refuse(c, "not-here");
  if (!w.isWithin(id, c.actor) && w.roomOf(id) === w.roomOf(c.actor) && !canSee(w, c.actor, id)) {
    return refuse(c, "examine.no-sight", { item: w.name(id) });
  }
  w.emit("examined", { actor: c.actor, targets: [id], cause: c.cause });
  // Reading is learning (§4.13). The player takes in what they read; a character weighs it against what they
  // already believe, which takes the narrative layer (a `read` signal), and may not accept it at all.
  const teaches = (w.thing(id)?.teaches ?? []).filter((b) => !w.believes(c.actor, b));
  if (c.isPlayer) for (const b of teaches) addBelief(w, c.actor, b, 1, w.thing(id)!.name, c.cause);
  else if (teaches.length) w.signals.push({ kind: "read", who: c.actor, thing: id });
  if (!c.isPlayer) return { ok: true, minutes: BASE_MINUTES.examine, summary: `examined ${w.label(id)}` };
  const def = w.thing(id)!;
  const text = w.text(def.description, { self: id });
  w.say(text || w.msg("examine.nothing", { item: w.name(id) }));
  if (w.isChar(id)) {
    const s = w.char(id);
    const vars = { target: w.label(id) };
    if (s.status === "dead") w.say(w.msg("examine.status-dead", vars));
    else if (s.status === "down") w.say(w.msg("examine.status-down", vars));
    else if (s.asleepUntil !== null) w.say(w.msg("examine.status-asleep", vars));
    else if (s.hp < w.maxHp(id) / 2) w.say(w.msg("examine.status-hurt", vars));
    if (s.equipment.weapon) w.say(w.msg("examine.wielding", { ...vars, item: w.name(s.equipment.weapon) }));
  } else if (w.isContainer(id) && w.isOpen(id)) {
    const inside = w.childrenOf(id).filter((x) => !w.isHidden(x) && w.perceives(w.playerId, x));
    w.say(
      inside.length
        ? w.msg("examine.contents", { item: w.name(id), contents: listJoin(inside.map((x) => w.name(x))) })
        : w.msg("examine.empty", { item: w.name(id) }),
    );
  }
  return { ok: true, minutes: BASE_MINUTES.examine, summary: `examined ${w.label(id)}` };
}
