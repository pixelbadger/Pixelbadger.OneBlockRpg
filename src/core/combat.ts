/**
 * Combat (§5.6, §3.4). Turn-based, in Sequence order, spending AP. NPCs act from scripted combat profiles: there are
 * no LLM calls per round. Text comes from the payload's combat_text templates per weapon type.
 */
import {
  AP_COST,
  damage as damageFormula,
  hitChance,
  ROUND_SECONDS,
  thrownWeapon,
  throwVelocity,
  UNARMED,
} from "../mechanics/combat-math.js";
import { armourClass, criticalChance, meleeDamageBonus, sequence } from "../mechanics/special.js";
import type { Exit, Weapon } from "../payload/schema.js";
import { perform } from "./actions.js";
import { exitLabel } from "./describe.js";
import { interpolate } from "./messages.js";
import { awardXp, damage, moveThing, setProp } from "./mutate.js";
import { set } from "./ops.js";
import type { Combatant, CombatState } from "./state.js";
import type { Cause, World } from "./world.js";

const COMBAT: Cause = { by: "combat" };

export type CombatIntent =
  | { kind: "attack"; target: string; aimed?: boolean }
  | { kind: "use"; item: string }
  | { kind: "equip"; item: string }
  | { kind: "reload" }
  | { kind: "flee"; direction: string }
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
    for (const f of fleeing) fleeRoom(w, f);
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
  const chance = hitChance(w.skill(attacker, weapon.skill), armourClass(ts, armour?.ac ?? 0), weapon, as.ST, aimed);
  const { roll, dmgRoll } = w.roll(
    (rng) => ({ roll: rng.die(100), dmgRoll: rng.int(weapon.damage[0], weapon.damage[1]) }),
    COMBAT,
  );
  if (thrownItem) moveThing(w, thrownItem, c.room, "thrown", COMBAT, attacker, [target]);
  const vars = {
    attacker: w.label(attacker),
    Attacker: w.label(attacker),
    target: w.label(target),
    Target: w.label(target),
    weapon: item ? w.name(item) : "bare hands",
  };
  if (roll > chance) {
    w.emit("missed", { actor: attacker, targets: [target], payload: { roll, chance }, cause: COMBAT });
    show(w, combatText(w, weapon.type, "miss", vars));
    return true;
  }
  const crit = roll <= criticalChance(as);
  const dmg = damageFormula(dmgRoll, weapon, meleeDamageBonus(as), armour, crit);
  w.emit("hit", { actor: attacker, targets: [target], payload: { roll, chance, crit, damage: dmg }, cause: COMBAT });
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

function fleeRoom(w: World, who: string, direction?: string): boolean {
  const room = w.roomOf(who)!;
  const exits = passableExits(w, room, who);
  const x = direction
    ? exits.find((e) => exitLabel(e).toLowerCase() === direction.toLowerCase() || e.to === direction)
    : exits[0];
  if (!x) return false;
  if (x.via && w.prop(x.via, "open") !== true) setProp(w, x.via, "open", true, COMBAT, who);
  show(w, w.msg("combat.flee", { Actor: w.label(who), dir: exitLabel(x) }));
  moveThing(w, who, x.to!, "moved", COMBAT, who, [room, x.to!]);
  w.emit("fled", { actor: who, targets: [who], cause: COMBAT });
  const c = cur(w);
  if (c) {
    const c2 = clone(c);
    const me = combatant(c2, who);
    if (me) me.status = "fled";
    update(w, c2);
  }
  return true;
}

function sideAlive(c: CombatState, side: "a" | "b") {
  return c.combatants.some((x) => x.side === side && x.status === "in");
}

/** True if the fight is over: one side is out, or the player has left it. */
function isOver(w: World): boolean {
  const c = cur(w);
  if (!c) return true;
  const player = combatant(c, w.playerId);
  if (player && player.status !== "in") return true;
  return !sideAlive(c, "a") || !sideAlive(c, "b");
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
  c.ap = w.ap(c.order[c.turn]!);
  update(w, c);
}

/** An NPC's turn, from its combat profile (§5.6). Returns when its AP is spent or it can do nothing more. */
function npcTurn(w: World, id: string): void {
  const s = w.char(id);
  const profile = s.combatProfile;
  const hpPct = (s.hp / w.maxHp(id)) * 100;
  const fleeAt = profile.flee_at ?? (profile.style === "coward" ? 60 : profile.style === "defensive" ? 20 : undefined);
  if (fleeAt !== undefined && hpPct <= fleeAt) {
    if (cur(w)!.ap >= AP_COST.leave && fleeRoom(w, id)) return;
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
    if (c.ap < weapon.ap) return;
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
      const ok = strike(w, p, intent.target, undefined, intent.aimed ?? false);
      if (!ok) return endPlayerTurn(w);
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
      if (!fleeRoom(w, p, intent.direction)) w.say(w.msg("go.no-exit"), "system");
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
  const inv = w.inventory(p);
  if (inv.some((x) => w.thing(x)?.consumable)) costs.push(AP_COST.useItem);
  if (inv.some((x) => w.thing(x)?.weapon && w.char(p).equipment.weapon !== x)) costs.push(AP_COST.equip);
  return Math.min(...costs);
}

/** Opponents the player can target, for menus. */
export function playerTargets(w: World): string[] {
  return cur(w) ? opponents(w, w.playerId) : [];
}
