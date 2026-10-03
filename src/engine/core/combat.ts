/**
 * Combat (§5.6, §3.4). Turn-based, in Sequence order, spending AP. NPCs act from scripted combat profiles: there are
 * no LLM calls per round. Text comes from the payload's combat_text templates per weapon type.
 */
import {
  AP_COST,
  damage as damageFormula,
  hitChance,
  RANGE_PENALTY,
  ROUND_SECONDS,
  thrownWeapon,
  throwVelocity,
  UNARMED,
} from "../mechanics/combat-math.js";
import { armourClass, criticalChance, luckNudge, meleeDamageBonus, sequence } from "../mechanics/special.js";
import type { Exit, Weapon } from "../payload/schema.js";
import { attackRange, perform, walk } from "./actions.js";
import { exitLabel } from "./describe.js";
import { interpolate } from "./messages.js";
import { awardXp, damage, moveThing, setProp } from "./mutate.js";
import { set } from "./ops.js";
import {
  canSee,
  cheb,
  dirOffset,
  distance,
  exitOnTile,
  findPath,
  gridOf,
  lineOfSight,
  occupancy,
  type Pos,
  posOf,
  standable,
  terrainAt,
  walkable,
} from "./space.js";
import type { Combatant, CombatState, Trail } from "./state.js";
import type { Cause, World } from "./world.js";

const COMBAT: Cause = { by: "combat" };

export type CombatIntent =
  | { kind: "attack"; target: string; aimed?: boolean }
  | { kind: "move"; direction: string }
  | { kind: "use"; item: string }
  | { kind: "equip"; item: string }
  | { kind: "reload" }
  | { kind: "flee"; direction: string }
  | { kind: "pursue"; target: string }
  | { kind: "end" };

export interface CombatOutcome {
  ended: boolean;
  minutes: number;
  playerDowned: boolean;
  playerFled: boolean;
}

function update(w: World, combat: CombatState, payload: Record<string, unknown> = {}) {
  w.emit("mode", { payload: { combat: true, ...payload }, cause: COMBAT, ops: [set(["combat"], combat)] });
}

const cur = (w: World) => w.state.combat;
const clone = (c: CombatState): CombatState => JSON.parse(JSON.stringify(c)) as CombatState;

function show(w: World, text: string) {
  const c = cur(w);
  if (!c || c.room === w.roomOf(w.playerId)) w.say(text, "combat");
}

/** The weapon a combatant fights with: an equipped weapon, else unarmed. */
export function weaponOf(w: World, id: string): { weapon: Weapon; item?: string } {
  const item = w.char(id).equipment.weapon;
  const def = item ? w.thing(item)?.weapon : undefined;
  return def && item && w.isWithin(item, id) ? { weapon: def, item } : { weapon: UNARMED };
}

function joinSide(w: World, who: string, attacker: string, target: string): "a" | "b" | "flee" | null {
  const s = w.char(who);
  const def = w.charDef(who);
  if (s.status !== "ok" || s.asleepUntil !== null) return null;
  const player = w.playerId;
  if (s.hostile && (attacker === player || target === player)) return attacker === player ? "b" : "a";
  const toT = w.relationship(who, target).affinity;
  const toA = w.relationship(who, attacker).affinity;
  if (def.combat_profile.style === "coward" && (toT >= 50 || toA >= 50 || s.hostile)) return "flee";
  if (toT >= 50 && toT >= toA) return "b";
  if (toA >= 50) return "a";
  return def.combat_profile.style === "coward" ? "flee" : null;
}

/** Begins (or joins) combat when an attack resolves (§5.6). The attacker strikes first. */
export function startCombat(
  w: World,
  attacker: string,
  target: string,
  weapon: string | undefined,
  cause: Cause,
): void {
  const room = w.roomOf(attacker)!;
  let combat = cur(w) ? clone(cur(w)!) : null;
  if (combat && combat.room !== room) return;
  if (!combat) {
    const combatants: Combatant[] = [
      { id: attacker, side: "a", status: "in", target },
      { id: target, side: "b", status: "in", target: attacker },
    ];
    const bystanders = w.charsIn(room).filter((c) => c !== attacker && c !== target && w.npcsPerceive(c));
    const fleeing: string[] = [];
    for (const b of bystanders) {
      if (b === w.playerId) continue;
      const side = joinSide(w, b, attacker, target);
      if (side === "flee") fleeing.push(b);
      else if (side) combatants.push({ id: b, side, status: "in", target: side === "a" ? target : attacker });
    }
    const ids = combatants.map((c) => c.id);
    const tiebreak = w.roll((rng) => Object.fromEntries(ids.map((id) => [id, rng.next()])), cause);
    const order = [...ids].sort((x, y) => {
      const sx = w.special(x);
      const sy = w.special(y);
      return sequence(sy) - sequence(sx) || sy.AG - sx.AG || tiebreak[y]! - tiebreak[x]!;
    });
    // The attacker acts first in round one.
    order.splice(order.indexOf(attacker), 1);
    order.unshift(attacker);
    const origin = w.state.setPiece ? "set-piece" : w.state.conversation ? "conversation" : "explore";
    combat = { room, combatants, order, round: 1, turn: 0, ap: w.ap(attacker), seconds: 0, origin, log: [] };
    w.emit("combat-started", {
      actor: attacker,
      targets: [target],
      payload: { order },
      cause,
      ops: [set(["combat"], combat)],
    });
    const names = order.map((id) => w.label(id));
    show(w, w.msg("combat.start", { list: names.join(", ") }));
    for (const f of fleeing) fleeRoom(w, f, undefined, true);
  } else {
    for (const id of [attacker, target]) {
      if (!combat.combatants.some((x) => x.id === id)) {
        const side = id === attacker ? "a" : "b";
        combat.combatants.push({ id, side, status: "in" });
        combat.order.push(id);
        show(w, w.msg("combat.joins", { Actor: w.label(id) }));
      }
    }
    const att = combat.combatants.find((x) => x.id === attacker)!;
    att.target = target;
    update(w, combat);
  }
  // The opening strike.
  if (w.state.combat && currentId(w) === attacker) strike(w, attacker, target, weapon, false);
}

export function currentId(w: World): string | undefined {
  const c = cur(w);
  return c ? c.order[c.turn] : undefined;
}

function combatant(c: CombatState, id: string) {
  return c.combatants.find((x) => x.id === id);
}

function opponents(w: World, id: string): string[] {
  const c = cur(w)!;
  const me = combatant(c, id);
  return c.combatants.filter((x) => x.status === "in" && me && x.side !== me.side).map((x) => x.id);
}

function combatText(
  w: World,
  type: string,
  key: "hit" | "miss" | "crit" | "down" | "kill",
  vars: Record<string, string | number>,
) {
  const entry = w.payload.combat_text[type] ?? w.payload.combat_text.unarmed;
  const fallback: Record<string, string> = {
    hit: "{{Attacker}} hits {{target}} for {{damage}}.",
    miss: "{{Attacker}} misses {{target}}.",
    crit: "{{Attacker}} lands a vicious blow on {{target}} for {{damage}}!",
    down: "{{Target}} goes down.",
    kill: "{{Target}} is dead.",
  };
  const raw = entry?.[key] ?? (key === "kill" ? entry?.down : undefined) ?? fallback[key]!;
  const t = Array.isArray(raw) ? w.roll((rng) => rng.pick(raw), COMBAT) : raw;
  return interpolate(t, vars);
}

/** One attack: hit chance, crit, damage, down/death (§5.6). Spends AP. */
function strike(w: World, attacker: string, target: string, thrownItem: string | undefined, aimed: boolean): boolean {
  const c = clone(cur(w)!);
  let { weapon, item } = weaponOf(w, attacker);
  if (thrownItem) {
    const v = throwVelocity(w.special(attacker).ST, w.mass(thrownItem));
    weapon = thrownWeapon(w.mass(thrownItem), v);
    item = thrownItem;
  }
  const cost = weapon.ap + (aimed ? AP_COST.aimed : 0);
  if (c.ap < cost) {
    if (attacker === w.playerId) w.say(w.msg("combat.no-ap"), "system");
    return false;
  }
  // Space (§5.6): melee needs an adjacent target; ranged and thrown need range and line of sight.
  const range = attackRange(w, attacker, thrownItem);
  const tiles = distance(w, attacker, target);
  if (tiles > range) {
    if (attacker === w.playerId) w.say(w.msg("combat.out-of-range", { target: w.label(target) }), "system");
    return false;
  }
  if (range > 1 && !canSee(w, attacker, target)) {
    if (attacker === w.playerId) w.say(w.msg("combat.no-sight", { target: w.label(target) }), "system");
    return false;
  }
  const penalty = range > 1 && Number.isFinite(tiles) ? RANGE_PENALTY * Math.max(0, tiles - 1) : 0;
  if (weapon.ammo && item && !thrownItem) {
    const loaded = w.numProp(item, "loaded", weapon.ammo.capacity);
    if (loaded <= 0) {
      if (attacker === w.playerId) w.say(w.msg("combat.empty", { item: w.name(item) }), "system");
      return false;
    }
    setProp(w, item, "loaded", loaded - 1, COMBAT, attacker);
  }
  c.ap -= cost;
  update(w, c);
  const as = w.special(attacker);
  const ts = w.special(target);
  const armourId = w.char(target).equipment.armour;
  const armour = armourId ? w.thing(armourId)?.armour : undefined;
  const ac = armourClass(ts, armour?.ac ?? 0);
  const chance = hitChance(w.skill(attacker, weapon.skill), ac, weapon, as.ST, aimed, luckNudge(as.LK) - penalty);
  const { roll, dmgRoll } = w.roll(
    (rng) => ({ roll: rng.die(100), dmgRoll: rng.int(weapon.damage[0], weapon.damage[1]) }),
    COMBAT,
  );
  if (thrownItem) {
    const lands = posOf(w, target);
    moveThing(w, thrownItem, c.room, "thrown", COMBAT, attacker, [target], lands ? { pos: lands } : {});
  }
  const vars = {
    attacker: w.label(attacker),
    Attacker: w.label(attacker),
    target: w.label(target),
    Target: w.label(target),
    weapon: item ? w.name(item) : "bare hands",
  };
  // Where it happened, for frontends that draw the fight (§4.10).
  const where = { from: posOf(w, attacker), to: posOf(w, target), ranged: range > 1 };
  if (roll > chance) {
    w.emit("missed", { actor: attacker, targets: [target], payload: { roll, chance, ...where }, cause: COMBAT });
    show(w, combatText(w, weapon.type, "miss", vars));
    return true;
  }
  const crit = roll <= criticalChance(as);
  const dmg = damageFormula(dmgRoll, weapon, meleeDamageBonus(as), armour, crit);
  w.emit("hit", {
    actor: attacker,
    targets: [target],
    payload: { roll, chance, crit, damage: dmg, ...where },
    cause: COMBAT,
  });
  show(w, combatText(w, weapon.type, crit ? "crit" : "hit", { ...vars, damage: dmg }));
  const status = damage(w, target, dmg, COMBAT, attacker);
  if (status) {
    show(w, combatText(w, weapon.type, status === "dead" ? "kill" : "down", vars));
    const c2 = clone(cur(w)!);
    combatant(c2, target)!.status = status;
    update(w, c2);
  }
  return true;
}

function passableExits(w: World, room: string, who: string): Exit[] {
  return (w.ix.rooms.get(room)?.exits ?? []).filter(
    (x) =>
      x.to &&
      !x.blocked &&
      (!x.when || w.cond(x.when, { self: who })) &&
      (!x.via || w.prop(x.via, "open") === true || w.prop(x.via, "locked") !== true),
  );
}

/** The tiles of an exit, by object identity. */
function exitTiles(w: World, room: string, x: Exit): Pos[] {
  const i = w.ix.rooms.get(room)?.exits.indexOf(x) ?? -1;
  return gridOf(w, room)?.exitTiles.get(i) ?? [];
}

/** Path from `who` onto one of the exit's tiles (the last tile is the exit itself), or null. */
function pathOnto(w: World, who: string, room: string, x: Exit): Pos[] | null {
  const g = gridOf(w, room);
  const from = w.state.objects[who]?.pos;
  const tiles = exitTiles(w, room, x);
  if (!g || !from) return [];
  if (!tiles.length) return null;
  return findPath(g, from, (p) => tiles.some((t) => t[0] === p[0] && t[1] === p[1]), occupancy(w, room, who));
}

/** Spends 1 AP a tile walking `who` along `path`, as far as their AP goes. Returns the tiles walked. */
function combatWalk(w: World, who: string, path: readonly Pos[]): number {
  const c = clone(cur(w)!);
  const n = Math.min(path.length, Math.floor(c.ap / AP_COST.move));
  if (n <= 0) return 0;
  c.ap -= n * AP_COST.move;
  update(w, c);
  walk(w, who, path.slice(0, n), COMBAT);
  return n;
}

/** A path for `who` to a tile it can attack `target` from (in range and, for ranged attacks, in sight). */
function pathToStrike(w: World, who: string, target: string): Pos[] | null {
  const room = w.roomOf(who);
  const from = w.state.objects[who]?.pos;
  const at = posOf(w, target);
  if (!room || !from || !at) return [];
  const g = gridOf(w, room)!;
  const range = attackRange(w, who);
  const ok = (p: Pos) => cheb(p, at) <= range && (range === 1 || canSeeTile(w, room, p, at));
  if (ok(from)) return [];
  const occ = occupancy(w, room, who);
  return findPath(g, from, (p) => ok(p) && standable(g, p, occ), occ);
}

function canSeeTile(w: World, room: string, a: Pos, b: Pos): boolean {
  return lineOfSight(w, room, a, b);
}

/**
 * `who` leaves the room through an exit (§5.6): the one named, else the nearest. Out of combat (`free`), or with AP
 * for the walk plus leave AP, they cross it; with less AP they walk towards it. Returns "fled", "moving" or "none".
 */
function fleeRoom(w: World, who: string, direction?: string, free = false): "fled" | "moving" | "none" {
  const room = w.roomOf(who)!;
  const exits = passableExits(w, room, who);
  const candidates = direction
    ? exits.filter((e) => exitLabel(e).toLowerCase() === direction.toLowerCase() || e.to === direction)
    : exits;
  let best: { x: Exit; path: Pos[] } | null = null;
  for (const x of candidates) {
    const path = pathOnto(w, who, room, x);
    if (path && (!best || path.length < best.path.length)) best = { x, path };
  }
  if (!best) return "none";
  const { x, path } = best;
  const approach = path.slice(0, -1);
  if (!free) {
    const c = cur(w)!;
    if (c.ap < approach.length * AP_COST.move + AP_COST.leave) {
      return combatWalk(w, who, approach) > 0 ? "moving" : "none";
    }
    combatWalk(w, who, approach);
    const c2 = clone(cur(w)!);
    c2.ap -= AP_COST.leave;
    update(w, c2);
  } else if (approach.length) walk(w, who, approach, COMBAT);
  if (x.via && w.prop(x.via, "open") !== true) setProp(w, x.via, "open", true, COMBAT, who);
  show(w, w.msg("combat.flee", { Actor: w.label(who), dir: exitLabel(x) }));
  moveThing(w, who, x.to!, "moved", COMBAT, who, [room, x.to!], x.via ? { via: x.via } : {});
  w.emit("fled", { actor: who, targets: [who], cause: COMBAT });
  const c = cur(w);
  if (c) {
    const c2 = clone(c);
    const me = combatant(c2, who);
    if (me) {
      me.status = "fled";
      // Each opponent may follow on their next turn, until the order comes back round to the fleer.
      const trail: Trail = {
        id: who,
        from: room,
        to: x.to!,
        direction: exitLabel(x),
        expires: { round: c2.round + 1, turn: c2.order.indexOf(who) },
      };
      c2.trails = [...(c2.trails ?? []).filter((t) => t.id !== who), trail];
    }
    update(w, c2);
  }
  return "fled";
}

// ─── Pursuit (§5.6) ──────────────────────────────────────────────────────────

/** An NPC gives chase when it is aggressive or hostile, isn't itself ready to flee, and has nobody left to fight. */
function npcWouldPursue(w: World, id: string): boolean {
  const c = cur(w)!;
  const s = w.char(id);
  const profile = s.combatProfile;
  if (profile.style !== "aggressive" && !s.hostile) return false;
  if (opponents(w, id).length > 0) return false;
  // Never drag the fight away from a player fighting on the same side: the player decides that.
  const me = combatant(c, id)!;
  if (c.combatants.some((x) => x.id === w.playerId && x.status === "in" && x.side === me.side)) return false;
  const fleeAt = profile.flee_at ?? (profile.style === "coward" ? 60 : profile.style === "defensive" ? 20 : undefined);
  return fleeAt === undefined || (s.hp / w.maxHp(id)) * 100 > fleeAt;
}

/** Can `id` follow the fleer on `trail` (ignoring AP)? */
function canPursue(w: World, id: string, trail: Trail): boolean {
  const c = cur(w)!;
  const me = combatant(c, id);
  const quarry = combatant(c, trail.id);
  if (!me || !quarry || me.status !== "in" || me.side === quarry.side || quarry.status !== "fled") return false;
  if (w.char(id).status !== "ok" || w.roomOf(id) !== c.room || trail.from !== c.room) return false;
  if (w.roomOf(trail.id) !== trail.to) return false;
  return id === w.playerId || npcWouldPursue(w, id);
}

/** Open trails that someone in the fight could still follow. */
function openTrails(w: World): Trail[] {
  const c = cur(w);
  if (!c) return [];
  return (c.trails ?? []).filter((t) => c.combatants.some((x) => canPursue(w, x.id, t)));
}

/** Trails `id` could follow this turn. */
export function pursuable(w: World, id: string): Trail[] {
  const c = cur(w);
  return c ? (c.trails ?? []).filter((t) => canPursue(w, id, t)) : [];
}

/**
 * `who` follows the fleer through the same exit, spending leave AP. The fight moves to the new room with the pursuer
 * and the quarry; everyone else still in it is left behind.
 */
function pursue(w: World, who: string, trail: Trail): boolean {
  const c = cur(w)!;
  if (c.ap < AP_COST.leave || !canPursue(w, who, trail)) return false;
  const x = passableExits(w, c.room, who).find((e) => e.to === trail.to);
  if (!x) return false;
  if (x.via && w.prop(x.via, "open") !== true) setProp(w, x.via, "open", true, COMBAT, who);
  const from = c.room;
  const vars = { Actor: w.label(who), target: w.label(trail.id), dir: trail.direction };
  if (who === w.playerId) w.say(w.msg("combat.pursue", vars), "combat");
  else if (w.roomOf(w.playerId) === from) w.say(w.msg("combat.pursue-npc", vars), "combat");
  // The chase crosses the room to the same doorway; the pursuer arrives beside the quarry (§5.6).
  moveThing(w, who, trail.to, "moved", COMBAT, who, [from, trail.to], x.via ? { via: x.via } : {});
  const c2 = clone(cur(w)!);
  c2.ap -= AP_COST.leave;
  c2.room = trail.to;
  c2.trails = [];
  for (const m of c2.combatants) {
    if (m.id === trail.id) m.status = "in";
    else if (m.id !== who && m.status === "in") m.status = "left";
  }
  combatant(c2, who)!.target = trail.id;
  combatant(c2, trail.id)!.target = who;
  update(w, c2);
  w.emit("pursued", { actor: who, targets: [trail.id, from, trail.to], cause: COMBAT });
  if (trail.id === w.playerId) w.say(w.msg("combat.pursued", vars), "combat");
  return true;
}

function sideAlive(c: CombatState, side: "a" | "b") {
  return c.combatants.some((x) => x.side === side && x.status === "in");
}

/**
 * True if the fight is over: one side is out, or the player has left it, and no escape is still open to pursuit.
 */
function isOver(w: World): boolean {
  const c = cur(w);
  if (!c) return true;
  const open = openTrails(w);
  const player = combatant(c, w.playerId);
  if (player && player.status !== "in") return !(player.status === "fled" && open.some((t) => t.id === w.playerId));
  return (!sideAlive(c, "a") || !sideAlive(c, "b")) && open.length === 0;
}

function endCombat(w: World): CombatOutcome {
  const c = cur(w)!;
  const minutes = Math.max(1, Math.ceil(c.seconds / 60));
  const player = combatant(c, w.playerId);
  const playerDowned = !!player && (player.status === "down" || player.status === "dead");
  const playerFled = player?.status === "fled";
  if (player && player.status === "in") {
    const beaten = c.combatants.filter((x) => x.side !== player.side && x.status !== "in").length;
    show(w, w.msg("combat.end-win"));
    awardXp(w, w.playerId, beaten * w.payload.game.xp.fight, COMBAT);
  } else if (playerFled) {
    w.say(w.msg("combat.end-fled"), "combat");
  }
  w.emit("combat-ended", {
    targets: c.combatants.map((x) => x.id),
    payload: { minutes, result: c.combatants.map((x) => ({ id: x.id, status: x.status })) },
    cause: COMBAT,
    ops: [set(["combat"], null)],
  });
  return { ended: true, minutes, playerDowned, playerFled };
}

/** Moves to the next combatant who can act; starts a new round when the order wraps. */
function nextTurn(w: World): void {
  const c = clone(cur(w)!);
  for (let i = 0; i < c.order.length; i++) {
    c.turn++;
    if (c.turn >= c.order.length) {
      c.turn = 0;
      c.round++;
      c.seconds += ROUND_SECONDS;
    }
    const id = c.order[c.turn]!;
    const me = combatant(c, id);
    if (me?.status === "in" && w.char(id).status === "ok") break;
  }
  if (c.trails?.length) {
    c.trails = c.trails.filter(
      (t) => c.round < t.expires.round || (c.round === t.expires.round && c.turn < t.expires.turn),
    );
  }
  c.ap = w.ap(c.order[c.turn]!);
  update(w, c);
}

/** An NPC's turn, from its combat profile (§5.6). Returns when its AP is spent or it can do nothing more. */
function npcTurn(w: World, id: string): void {
  const s = w.char(id);
  const profile = s.combatProfile;
  const trail = pursuable(w, id)[0];
  if (trail && !pursue(w, id, trail)) return;
  const hpPct = (s.hp / w.maxHp(id)) * 100;
  const fleeAt = profile.flee_at ?? (profile.style === "coward" ? 60 : profile.style === "defensive" ? 20 : undefined);
  if (fleeAt !== undefined && hpPct <= fleeAt) {
    const fled = fleeRoom(w, id);
    if (fled !== "none") return;
    const c = clone(cur(w)!);
    combatant(c, id)!.status = "surrendered";
    update(w, c);
    w.emit("surrendered", { actor: id, targets: [id], cause: COMBAT });
    show(w, w.msg("combat.surrender", { Actor: w.label(id) }));
    return;
  }
  // Ready the preferred weapon.
  const pref = profile.preferred_weapon;
  if (pref && w.isWithin(pref, id) && s.equipment.weapon !== pref && cur(w)!.ap >= AP_COST.equip) {
    const c = clone(cur(w)!);
    c.ap -= AP_COST.equip;
    update(w, c);
    w.emit("equipped", {
      actor: id,
      targets: [pref],
      cause: COMBAT,
      ops: [set(["chars", id, "equipment", "weapon"], pref)],
    });
    show(w, w.msg("equip.npc", { Actor: w.label(id), item: w.name(pref) }));
  }
  let attacks = 0;
  for (let guard = 0; guard < 10; guard++) {
    if (isOver(w)) return;
    const c = cur(w)!;
    const me = combatant(c, id)!;
    const foes = opponents(w, id);
    if (foes.length === 0) return;
    const target =
      me.target && foes.includes(me.target) ? me.target : foes.includes(w.playerId) ? w.playerId : foes[0]!;
    const { weapon, item } = weaponOf(w, id);
    if (weapon.ammo && item && w.numProp(item, "loaded", weapon.ammo.capacity) <= 0) {
      if (!reload(w, id)) return;
      continue;
    }
    // Close the distance first (§5.6): walk towards a tile it can strike from.
    const path = pathToStrike(w, id, target);
    if (path === null) return;
    if (path.length) {
      if (profile.style === "defensive" && attacks >= 1) return;
      if (combatWalk(w, id, path) < path.length) return;
      continue;
    }
    if (cur(w)!.ap < weapon.ap) return;
    if (profile.style === "defensive" && attacks >= 1) return;
    if (!strike(w, id, target, undefined, false)) return;
    attacks++;
  }
}

function reload(w: World, id: string): boolean {
  const c = clone(cur(w)!);
  const { weapon, item } = weaponOf(w, id);
  if (!weapon.ammo || !item || c.ap < AP_COST.reload) return false;
  const ammo = w.inventory(id).find((x) => w.thing(x)?.ammo?.type === weapon.ammo!.type && w.numProp(x, "count") > 0);
  if (!ammo) {
    if (id === w.playerId) w.say(w.msg("combat.no-ammo", { item: w.name(item) }), "system");
    return false;
  }
  const loaded = w.numProp(item, "loaded", 0);
  const take = Math.min(weapon.ammo.capacity - loaded, w.numProp(ammo, "count"));
  c.ap -= AP_COST.reload;
  update(w, c);
  setProp(w, item, "loaded", loaded + take, COMBAT, id);
  setProp(w, ammo, "count", w.numProp(ammo, "count") - take, COMBAT, id);
  show(w, w.msg("combat.reload", { Actor: w.label(id), item: w.name(item) }));
  return true;
}

/**
 * Runs NPC turns until it is the player's turn or combat ends. Combat that doesn't involve the player runs to
 * completion.
 */
export function runCombat(w: World): CombatOutcome {
  for (let guard = 0; guard < 500; guard++) {
    if (!cur(w)) return { ended: true, minutes: 0, playerDowned: false, playerFled: false };
    if (isOver(w)) return endCombat(w);
    const id = currentId(w)!;
    const me = combatant(cur(w)!, id);
    if (id === w.playerId && me?.status === "in") {
      return { ended: false, minutes: 0, playerDowned: false, playerFled: false };
    }
    if (me?.status === "in" && w.char(id).status === "ok") npcTurn(w, id);
    if (isOver(w)) return endCombat(w);
    nextTurn(w);
  }
  return endCombat(w);
}

/** Applies a player combat intent, then runs NPC turns as needed. */
export function playerCombat(w: World, intent: CombatIntent): CombatOutcome {
  const c = cur(w);
  if (!c || currentId(w) !== w.playerId) return runCombat(w);
  const p = w.playerId;
  switch (intent.kind) {
    case "attack": {
      if (
        !opponents(w, p).includes(intent.target) &&
        !c.combatants.some((x) => x.id === intent.target && x.status === "in")
      ) {
        w.say(w.msg("combat.target-gone", { target: w.label(intent.target) }), "system");
        break;
      }
      if (!combatant(c, intent.target)) break;
      // Out of reach: walk towards the target with the AP there is, then strike if any is left.
      const path = pathToStrike(w, p, intent.target);
      if (path === null) {
        w.say(w.msg("combat.out-of-range", { target: w.label(intent.target) }), "system");
        break;
      }
      if (path.length && combatWalk(w, p, path) < path.length) break;
      const ok = strike(w, p, intent.target, undefined, intent.aimed ?? false);
      if (!ok) return endPlayerTurn(w);
      break;
    }
    case "move": {
      const r = combatStep(w, p, intent.direction);
      if (r === "fled") return endPlayerTurn(w);
      break;
    }
    case "use": {
      if (c.ap < AP_COST.useItem) return endPlayerTurn(w);
      if (!w.thing(intent.item)?.consumable || !w.isWithin(intent.item, p)) break;
      const c2 = clone(c);
      c2.ap -= AP_COST.useItem;
      update(w, c2);
      perform(w, p, { act: "use", item: intent.item }, COMBAT, { inCombat: true });
      break;
    }
    case "equip": {
      if (c.ap < AP_COST.equip || !w.isWithin(intent.item, p)) break;
      const def = w.thing(intent.item);
      const slot = def?.weapon ? "weapon" : def?.armour ? "armour" : null;
      if (!slot) break;
      const c2 = clone(c);
      c2.ap -= AP_COST.equip;
      update(w, c2);
      w.emit("equipped", {
        actor: p,
        targets: [intent.item],
        cause: COMBAT,
        ops: [set(["chars", p, "equipment", slot], intent.item)],
      });
      w.say(w.msg("equip.ok", { item: w.name(intent.item) }), "combat");
      break;
    }
    case "reload":
      reload(w, p);
      break;
    case "flee": {
      if (c.ap < AP_COST.leave) {
        w.say(w.msg("combat.no-ap"), "system");
        break;
      }
      const fled = fleeRoom(w, p, intent.direction);
      if (fled === "none") {
        w.say(w.msg("go.no-exit"), "system");
        break;
      }
      if (fled === "fled") return endPlayerTurn(w);
      break;
    }
    case "pursue": {
      const trail = pursuable(w, p).find((t) => t.id === intent.target);
      if (!trail) {
        w.say(w.msg("combat.pursue-gone", { Target: w.label(intent.target) }), "system");
        break;
      }
      if (c.ap < AP_COST.leave) {
        w.say(w.msg("combat.no-ap"), "system");
        break;
      }
      if (!pursue(w, p, trail)) w.say(w.msg("go.no-exit"), "system");
      break;
    }
    case "end":
      return endPlayerTurn(w);
  }
  if (isOver(w)) return endCombat(w);
  // Auto-end the turn when nothing affordable remains.
  if (cur(w)!.ap < cheapestPlayerAction(w)) return endPlayerTurn(w);
  return { ended: false, minutes: 0, playerDowned: false, playerFled: false };
}

function endPlayerTurn(w: World): CombatOutcome {
  if (isOver(w)) return endCombat(w);
  nextTurn(w);
  return runCombat(w);
}

/** AP cost of the cheapest thing the player could still do this turn. */
export function cheapestPlayerAction(w: World): number {
  const p = w.playerId;
  const costs = [weaponOf(w, p).weapon.ap, AP_COST.leave];
  // Walking is worth a turn's AP only while someone is out of reach.
  if (opponents(w, p).some((o) => distance(w, p, o) > attackRange(w, p))) costs.push(AP_COST.move);
  const inv = w.inventory(p);
  if (inv.some((x) => w.thing(x)?.consumable)) costs.push(AP_COST.useItem);
  if (inv.some((x) => w.thing(x)?.weapon && w.char(p).equipment.weapon !== x)) costs.push(AP_COST.equip);
  return Math.min(...costs);
}

/** Opponents the player can target, for menus. */
export function playerTargets(w: World): string[] {
  return cur(w) ? opponents(w, w.playerId) : [];
}

/**
 * One tile in combat for 1 AP (§5.6). Onto an exit tile it is leaving, which also costs leave AP. Returns "moved",
 * "fled" or "blocked".
 */
export function combatStep(w: World, who: string, direction: string): "moved" | "fled" | "blocked" {
  const c = cur(w);
  const room = w.roomOf(who);
  const from = w.state.objects[who]?.pos;
  const d = dirOffset(direction);
  if (!c || !room || !from || !d) return "blocked";
  const to: Pos = [from[0] + d[0], from[1] + d[1]];
  const exit = exitOnTile(w, room, to);
  if (exit) {
    if (c.ap < AP_COST.leave) {
      if (who === w.playerId) w.say(w.msg("combat.no-ap"), "system");
      return "blocked";
    }
    return fleeRoom(w, who, exitLabel(exit.exit)) === "fled" ? "fled" : "blocked";
  }
  const g = gridOf(w, room)!;
  const cornerCut =
    d[0] !== 0 &&
    d[1] !== 0 &&
    (!walkable(terrainAt(g, [from[0] + d[0], from[1]])) || !walkable(terrainAt(g, [from[0], from[1] + d[1]])));
  if (cornerCut || !standable(g, to, occupancy(w, room, who))) {
    if (who === w.playerId) w.say(w.msg("step.wall"), "system");
    return "blocked";
  }
  if (c.ap < AP_COST.move) {
    if (who === w.playerId) w.say(w.msg("combat.no-ap"), "system");
    return "blocked";
  }
  combatWalk(w, who, [to]);
  return "moved";
}
