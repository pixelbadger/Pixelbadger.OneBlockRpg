/**
 * State mutations shared by actions, effects, combat and the clock. Each is one event carrying the ops that apply it.
 */
import { levelForXp, type Modifier, skillPointsPerLevel } from "../mechanics/special.js";
import type { Attribute, Scalar, SkillId } from "../payload/schema.js";
import type { EventKind } from "./event-kinds.js";
import { pull, push, set } from "./ops.js";
import type { CharStatus } from "./state.js";
import type { Cause, World } from "./world.js";

export function moveThing(
  w: World,
  id: string,
  to: string | null,
  kind: EventKind,
  cause: Cause,
  actor?: string,
  extraTargets: string[] = [],
): void {
  const from = w.locationOf(id);
  const ops = [set(["objects", id, "location"], to)];
  // Moving an item out of a character's hands unequips it.
  if (from && w.isChar(from)) {
    const eq = w.char(from).equipment;
    if (eq.weapon === id) ops.push(set(["chars", from, "equipment", "weapon"], null));
    if (eq.armour === id) ops.push(set(["chars", from, "equipment", "armour"], null));
  }
  if (w.isChar(id) && id === w.playerId && to && w.isRoom(to) && !w.state.visited.includes(to)) {
    ops.push(push(["visited"], to));
  }
  w.emit(kind, {
    ...(actor ? { actor } : {}),
    targets: [id, ...extraTargets],
    payload: { from, to },
    cause,
    ops,
  });
}

export function setFlag(w: World, flag: string, value: Scalar, cause: Cause): void {
  w.emit("flag-set", { targets: [], payload: { flag, value }, cause, ops: [set(["flags", flag], value)] });
}

export function clearFlag(w: World, flag: string, cause: Cause): void {
  w.emit("flag-cleared", { payload: { flag }, cause, ops: [{ op: "del", path: ["flags", flag] }] });
}

export function setProp(w: World, id: string, key: string, value: Scalar, cause: Cause, actor?: string): void {
  w.emit("property-set", {
    ...(actor ? { actor } : {}),
    targets: [id],
    payload: { key, value, prev: w.prop(id, key) ?? null },
    cause,
    ops: [set(["objects", id, "props", key], value)],
  });
}

export function setCharField(w: World, id: string, field: string, value: unknown, kind: EventKind, cause: Cause) {
  w.emit(kind, { targets: [id], payload: { field, value }, cause, ops: [set(["chars", id, field], value)] });
}

const clampRel = (v: number) => Math.max(-100, Math.min(100, Math.round(v)));

export function adjustRelationship(
  w: World,
  who: string,
  withWhom: string,
  delta: { trust?: number; affinity?: number },
  cause: Cause,
): void {
  const cur = w.relationship(who, withWhom);
  const next = {
    trust: clampRel(cur.trust + (delta.trust ?? 0)),
    affinity: clampRel(cur.affinity + (delta.affinity ?? 0)),
    notes: cur.notes,
  };
  w.emit("relationship-adjusted", {
    actor: who,
    targets: [withWhom],
    payload: { delta, value: next },
    cause,
    ops: [set(["chars", who, "relationships", withWhom], next)],
  });
}

export function addBelief(w: World, who: string, belief: string, confidence: number, source: string, cause: Cause) {
  const existing = w.char(who).beliefs.findIndex((b) => b.id === belief);
  const value = { id: belief, confidence, source, day: w.state.day };
  w.emit("belief-added", {
    actor: who,
    targets: [who],
    payload: { belief, confidence, source },
    cause,
    ops: [existing >= 0 ? set(["chars", who, "beliefs", existing], value) : push(["chars", who, "beliefs"], value)],
  });
}

export function removeBelief(w: World, who: string, belief: string, cause: Cause) {
  const remaining = w.char(who).beliefs.filter((b) => b.id !== belief);
  w.emit("belief-removed", {
    actor: who,
    targets: [who],
    payload: { belief },
    cause,
    ops: [set(["chars", who, "beliefs"], remaining)],
  });
}

export function awardXp(w: World, who: string, amount: number, cause: Cause): void {
  if (amount <= 0) return;
  const c = w.char(who);
  const xp = c.xp + amount;
  w.emit("xp-awarded", { targets: [who], payload: { amount, xp }, cause, ops: [set(["chars", who, "xp"], xp)] });
  if (who === w.playerId) w.say(w.msg("xp", { amount }), "system");
  const newLevel = levelForXp(xp);
  for (let level = c.level + 1; level <= newLevel; level++) {
    const cur = w.char(who);
    const points = skillPointsPerLevel(w.special(who));
    const hpGain = 2 + Math.floor(cur.special.EN / 2);
    w.emit("level-up", {
      targets: [who],
      payload: { level, points, hpGain },
      cause,
      ops: [
        set(["chars", who, "level"], level),
        set(["chars", who, "unspentSkillPoints"], cur.unspentSkillPoints + points),
        set(["chars", who, "hp"], cur.hp + hpGain),
      ],
    });
    if (who === w.playerId) w.say(w.msg("level-up", { level, points: cur.unspentSkillPoints + points }), "system");
  }
}

export function heal(w: World, who: string, amount: number, cause: Cause): number {
  const c = w.char(who);
  if (c.status === "dead" || amount <= 0) return 0;
  const hp = Math.min(w.maxHp(who), c.hp + amount);
  const gained = hp - c.hp;
  if (gained <= 0) return 0;
  const ops = [set(["chars", who, "hp"], hp)];
  if (c.status === "down" && hp > 0) {
    ops.push(set(["chars", who, "status"], "ok"), set(["chars", who, "downUntil"], null));
  }
  w.emit("healed", { targets: [who], payload: { amount: gained, hp }, cause, ops });
  return gained;
}

/**
 * Applies damage. At HP ≤ 0 a character is unconscious; at HP ≤ −EN dead, unless essential (§5.6).
 * Returns the resulting status change, if any.
 */
export function damage(w: World, who: string, amount: number, cause: Cause, by?: string): "down" | "dead" | null {
  const c = w.char(who);
  if (c.status === "dead" || amount <= 0) return null;
  // The player is never killed outright: what being downed means is the payload's choice (§5.6, Q27).
  const essential = w.charDef(who).essential || who === w.playerId;
  let hp = c.hp - amount;
  let status: CharStatus = c.status;
  if (hp <= -c.special.EN && !essential) status = "dead";
  else if (hp <= 0) status = "down";
  if (essential && hp <= -c.special.EN) hp = -c.special.EN + 1;
  const ops = [set(["chars", who, "hp"], hp)];
  w.emit("damaged", { ...(by ? { actor: by } : {}), targets: [who], payload: { amount, hp }, cause, ops });
  if (status === c.status || status === "ok") return null;
  const statusOps = [
    set(["chars", who, "status"], status),
    set(["chars", who, "downUntil"], status === "down" ? w.state.clock + 60 : null),
    set(["chars", who, "asleepUntil"], null),
  ];
  w.emit(status === "dead" ? "killed" : "downed", {
    ...(by ? { actor: by } : {}),
    targets: [who],
    cause,
    ops: statusOps,
  });
  return status;
}

export function giveMoney(w: World, who: string, amount: number, cause: Cause): void {
  const money = Math.max(0, w.char(who).money + amount);
  w.emit("money-changed", {
    targets: [who],
    payload: { amount, money },
    cause,
    ops: [set(["chars", who, "money"], money)],
  });
}

export function addModifier(
  w: World,
  who: string,
  m: { id?: string; attribute?: Attribute; skill?: SkillId; amount: number; minutes?: number; source?: string },
  cause: Cause,
): void {
  const id = m.id ?? `mod-${w.log.length}`;
  const mod: Modifier = {
    id,
    amount: m.amount,
    ...(m.attribute ? { attribute: m.attribute } : {}),
    ...(m.skill ? { skill: m.skill } : {}),
    ...(m.minutes ? { expiresAt: w.state.clock + Math.round(m.minutes) } : {}),
    ...(m.source ? { source: m.source } : {}),
  };
  // A modifier with an explicit id replaces an earlier one with the same id (e.g. madness stages).
  const kept = w.char(who).modifiers.filter((x) => x.id !== id);
  w.emit("modifier-added", {
    targets: [who],
    payload: { ...mod },
    cause,
    ops: [set(["chars", who, "modifiers"], [...kept, mod])],
  });
}

export function startBehaviour(w: World, who: string, behaviour: string, cause: Cause): void {
  if (w.char(who) && w.state.chars[who]?.behaviours.includes(behaviour)) return;
  if (!w.isChar(who)) {
    // Objects keep their active behaviours in a property list.
    const active = objectBehaviours(w, who);
    if (active.includes(behaviour)) return;
    setProp(w, who, "_behaviours", [...active, behaviour].join(","), cause);
    return;
  }
  w.emit("behaviour-started", {
    targets: [who],
    payload: { behaviour },
    cause,
    ops: [push(["chars", who, "behaviours"], behaviour)],
  });
}

export function stopBehaviour(w: World, who: string, behaviour: string, cause: Cause): void {
  if (!w.isChar(who)) {
    setProp(
      w,
      who,
      "_behaviours",
      objectBehaviours(w, who)
        .filter((b) => b !== behaviour)
        .join(","),
      cause,
    );
    return;
  }
  w.emit("behaviour-stopped", {
    targets: [who],
    payload: { behaviour },
    cause,
    ops: [pull(["chars", who, "behaviours"], behaviour)],
  });
}

/** Active behaviours of a non-character object: its declared ones unless overridden by start/stop effects. */
export function objectBehaviours(w: World, id: string): string[] {
  const v = w.prop(id, "_behaviours");
  if (typeof v === "string") return v ? v.split(",") : [];
  return [...(w.thing(id)?.behaviours ?? [])];
}

export function activeBehaviours(w: World, id: string): string[] {
  return w.isChar(id) ? w.char(id).behaviours : objectBehaviours(w, id);
}
