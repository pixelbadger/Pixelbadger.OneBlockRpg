/** The condition half of the §7.5 language. Pure reads of world state. */
import type { Comparison, Condition, Scalar } from "../payload/schema.js";
import { between, crossed, parseClock, timeOfDay } from "./clock.js";
import type { EvalContext, World } from "./world.js";

type Cmp = { eq?: number; ne?: number; gt?: number; gte?: number; lt?: number; lte?: number };

export function compare(value: number, c: Comparison | Cmp): boolean {
  if (typeof c === "number") return value === c;
  if (c.eq !== undefined && !(value === c.eq)) return false;
  if (c.ne !== undefined && !(value !== c.ne)) return false;
  if (c.gt !== undefined && !(value > c.gt)) return false;
  if (c.gte !== undefined && !(value >= c.gte)) return false;
  if (c.lt !== undefined && !(value < c.lt)) return false;
  if (c.lte !== undefined && !(value <= c.lte)) return false;
  return true;
}

function cmpFields(o: Record<string, unknown>): Cmp {
  const out: Cmp = {};
  for (const k of ["eq", "ne", "gt", "gte", "lt", "lte"] as const)
    if (typeof o[k] === "number") out[k] = o[k] as number;
  return out;
}

function scalarOp(a: Scalar | undefined, op: string, b: Scalar): boolean {
  if (op === "eq") return a === b;
  if (op === "ne") return a !== b;
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (op === "gt") return a > b;
  if (op === "gte") return a >= b;
  if (op === "lt") return a < b;
  if (op === "lte") return a <= b;
  return false;
}

export interface CondEnv extends EvalContext {
  /** Conversation turn count, for `turns`. */
  turns?: number;
}

export function evalCondition(w: World, c: Condition, ctx: CondEnv = {}): boolean {
  const who = (id: string | undefined) => w.resolve(id ?? "player", ctx);
  const isChar = (id: string) => w.isChar(id);

  if ("all" in c) return c.all.every((x) => evalCondition(w, x, ctx));
  if ("any" in c) return c.any.some((x) => evalCondition(w, x, ctx));
  if ("not" in c) return !evalCondition(w, c.not, ctx);
  if ("flag" in c) {
    const v = w.state.flags[c.flag];
    return v !== undefined && v !== false && v !== 0 && v !== "";
  }
  if ("flag_eq" in c) return w.state.flags[c.flag_eq.flag] === c.flag_eq.value;
  if ("time" in c) return crossed(c.time, w.state.windowFrom, w.state.clock);
  if ("time_between" in c) return between(w.state.clock, c.time_between.from, c.time_between.to);
  if ("time_after" in c) return timeOfDay(w.state.clock) >= parseClock(c.time_after);
  if ("time_before" in c) return timeOfDay(w.state.clock) < parseClock(c.time_before);
  if ("day" in c) return compare(w.state.day, c.day);
  if ("in_room" in c) {
    const id = who(c.in_room.who);
    return w.locationOf(id) === c.in_room.where || (!w.isChar(id) && w.roomOf(id) === c.in_room.where);
  }
  if ("holds" in c) return w.isWithin(c.holds.what, who(c.holds.who));
  if ("property" in c) {
    const id = who(c.property.object);
    return scalarOp(w.prop(id, c.property.key), c.property.op ?? "eq", c.property.value);
  }
  if ("special" in c) {
    const id = who(c.special.who);
    if (!isChar(id)) return false;
    const s = w.special(id);
    for (const [k, v] of Object.entries(c.special)) {
      if (k === "who" || v === undefined) continue;
      if (!compare(s[k as keyof typeof s], v as Comparison)) return false;
    }
    return true;
  }
  if ("skill" in c) {
    const id = who(c.skill.who);
    return isChar(id) && compare(w.skill(id, c.skill.skill), cmpFields(c.skill));
  }
  if ("relationship" in c) {
    const a = who(c.relationship.who);
    const b = who(c.relationship.with);
    if (!isChar(a)) return false;
    const r = w.relationship(a, b);
    if (c.relationship.trust !== undefined && !compare(r.trust, c.relationship.trust)) return false;
    if (c.relationship.affinity !== undefined && !compare(r.affinity, c.relationship.affinity)) return false;
    return true;
  }
  if ("believes" in c) {
    const id = who(c.believes.who);
    return isChar(id) && w.believes(id, c.believes.belief);
  }
  if ("event" in c) {
    const spec = typeof c.event === "string" ? { kind: c.event, actor: c.actor, target: c.target } : c.event;
    const actor = spec.actor ? who(spec.actor) : undefined;
    const target = spec.target ? who(spec.target) : undefined;
    return (ctx.events ?? []).some(
      (e) => e.kind === spec.kind && (!actor || e.actor === actor) && (!target || e.targets.includes(target)),
    );
  }
  if ("turns" in c) return ctx.turns !== undefined && compare(ctx.turns, c.turns);
  for (const k of ["hp", "level", "money"] as const) {
    if (k in c) {
      const o = (c as Record<string, Record<string, unknown>>)[k]!;
      const id = who(o.who as string | undefined);
      return isChar(id) && compare(w.char(id)[k], cmpFields(o));
    }
  }
  if ("in_combat" in c) {
    const combat = w.state.combat;
    if (typeof c.in_combat === "boolean") return (combat !== null) === c.in_combat;
    const id = who(c.in_combat);
    return !!combat?.combatants.some((x) => x.id === id && x.status === "in");
  }
  if ("in_set_piece" in c) {
    const sp = w.state.setPiece;
    if (typeof c.in_set_piece === "boolean") return (sp !== null) === c.in_set_piece;
    return sp?.id === c.in_set_piece;
  }
  if ("beat" in c) {
    const sp = w.state.setPiece;
    if (!sp) return false;
    const def = w.ix.setPieces.get(sp.id)!;
    const b = def.beats[sp.beat];
    return (typeof b === "string" ? b : b?.id) === c.beat;
  }
  if ("asleep" in c) {
    const id = who(c.asleep);
    return isChar(id) && w.char(id).asleepUntil !== null;
  }
  if ("down" in c) {
    const id = who(c.down);
    return isChar(id) && w.char(id).status === "down";
  }
  if ("dead" in c) {
    const id = who(c.dead);
    return isChar(id) && w.char(id).status === "dead";
  }
  if ("visited" in c) return w.state.visited.includes(c.visited);
  return false;
}
