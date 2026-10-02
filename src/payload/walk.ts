import type { Collection } from "./loader.js";
import type { CheckSpec, Condition, Effect, Payload, TextVariants } from "./schema.js";

/** Where an expression sits: an entity in a collection, or the game/story file, plus a path inside it. */
export interface Where {
  in: Collection | "game" | "story";
  id?: string;
  path: PropertyKey[];
}

export interface Visitor {
  condition?(c: Condition, where: Where): void;
  effect?(e: Effect, where: Where): void;
  text?(t: TextVariants, where: Where): void;
}

const at = (w: Where, ...more: PropertyKey[]): Where => ({ ...w, path: [...w.path, ...more] });

export function walkCondition(c: Condition, w: Where, v: Visitor): void {
  v.condition?.(c, w);
  if ("all" in c) {
    c.all.forEach((x, i) => {
      walkCondition(x, at(w, "all", i), v);
    });
  } else if ("any" in c) {
    c.any.forEach((x, i) => {
      walkCondition(x, at(w, "any", i), v);
    });
  } else if ("not" in c) walkCondition(c.not, at(w, "not"), v);
}

export function walkText(t: TextVariants | undefined, w: Where, v: Visitor): void {
  if (t === undefined) return;
  v.text?.(t, w);
  if (Array.isArray(t)) {
    t.forEach((x, i) => {
      if (x.when) walkCondition(x.when, at(w, i, "when"), v);
    });
  }
}

export function walkCheck(c: CheckSpec, w: Where, v: Visitor): void {
  walkEffects(c.pass, at(w, "pass"), v);
  walkEffects(c.fail, at(w, "fail"), v);
}

export function walkEffects(list: readonly Effect[] | undefined, w: Where, v: Visitor): void {
  list?.forEach((e, i) => {
    walkEffect(e, at(w, i), v);
  });
}

export function walkEffect(e: Effect, w: Where, v: Visitor): void {
  v.effect?.(e, w);
  if ("check" in e) walkCheck(e.check, at(w, "check"), v);
  if ("narrate" in e) walkText(e.narrate, at(w, "narrate"), v);
}

/** Visits every condition, effect and text variant list in the payload. */
export function walkPayload(p: Payload, v: Visitor): void {
  const g: Where = { in: "game", path: [] };
  walkText(p.game.intro, at(g, "intro"), v);
  walkText(p.game.downed.text, at(g, "downed", "text"), v);

  const s: Where = { in: "story", path: [] };
  p.story.triggers.forEach((t, i) => {
    walkCondition(t.when, at(s, "triggers", i, "when"), v);
    walkEffects(t.do, at(s, "triggers", i, "do"), v);
  });
  p.story.endings.forEach((e, i) => {
    if (e.when) walkCondition(e.when, at(s, "endings", i, "when"), v);
    walkText(e.text, at(s, "endings", i, "text"), v);
  });

  for (const r of p.rooms) {
    const w: Where = { in: "rooms", id: r.id, path: [] };
    walkText(r.description, at(w, "description"), v);
    r.exits.forEach((x, i) => {
      if (x.when) walkCondition(x.when, at(w, "exits", i, "when"), v);
      walkText(x.closed_text, at(w, "exits", i, "closed_text"), v);
      walkText(x.blocked, at(w, "exits", i, "blocked"), v);
    });
  }

  const objectLike = (o: Payload["objects"][number], w: Where) => {
    walkText(o.description, at(w, "description"), v);
    walkText(o.room_text, at(w, "room_text"), v);
    if (o.hidden_unless) walkCondition(o.hidden_unless, at(w, "hidden_unless"), v);
    o.uses.forEach((u, i) => {
      if (u.when) walkCondition(u.when, at(w, "uses", i, "when"), v);
      walkText(u.text, at(w, "uses", i, "text"), v);
      walkEffects(u.effects, at(w, "uses", i, "effects"), v);
    });
    o.force.forEach((m, i) => {
      walkText(m.text, at(w, "force", i, "text"), v);
      walkText(m.fail_text, at(w, "force", i, "fail_text"), v);
      walkEffects(m.effects, at(w, "force", i, "effects"), v);
    });
    if (o.permitted) walkCondition(o.permitted, at(w, "permitted"), v);
    if (o.consumable) {
      walkEffects(o.consumable.effects, at(w, "consumable", "effects"), v);
      walkText(o.consumable.text, at(w, "consumable", "text"), v);
    }
    for (const [k, t] of Object.entries(o.messages)) walkText(t, at(w, "messages", k), v);
  };
  for (const o of p.objects) objectLike(o, { in: "objects", id: o.id, path: [] });
  for (const c of p.characters) {
    const w: Where = { in: "characters", id: c.id, path: [] };
    objectLike(c, w);
    if (c.talk_when) walkCondition(c.talk_when, at(w, "talk_when"), v);
    walkText(c.refuse_text, at(w, "refuse_text"), v);
  }

  for (const b of p.behaviours) {
    const w: Where = { in: "behaviours", id: b.id, path: [] };
    b.rules.forEach((r, i) => {
      walkCondition(r.when, at(w, "rules", i, "when"), v);
      walkEffects(r.do, at(w, "rules", i, "do"), v);
    });
  }

  for (const c of p.conversations) {
    const w: Where = { in: "conversations", id: c.id, path: [] };
    if (c.when) walkCondition(c.when, at(w, "when"), v);
    walkText(c.opening, at(w, "opening"), v);
    c.options.forEach((o, i) => {
      if (o.when) walkCondition(o.when, at(w, "options", i, "when"), v);
      if (o.check) walkCheck(o.check, at(w, "options", i, "check"), v);
      walkEffects(o.effects, at(w, "options", i, "effects"), v);
    });
    if (c.ends_when) walkCondition(c.ends_when, at(w, "ends_when"), v);
  }

  for (const h of p.hooks) {
    const w: Where = { in: "hooks", id: h.id, path: [] };
    if (h.guard) walkCondition(h.guard, at(w, "guard"), v);
    walkEffects(h.effects, at(w, "effects"), v);
  }

  for (const sp of p.set_pieces) {
    const w: Where = { in: "set_pieces", id: sp.id, path: [] };
    if (sp.starts_when) walkCondition(sp.starts_when, at(w, "starts_when"), v);
    walkCondition(sp.ends_when, at(w, "ends_when"), v);
    sp.outcomes.forEach((o, i) => {
      if (o.when) walkCondition(o.when, at(w, "outcomes", i, "when"), v);
      walkEffects(o.do, at(w, "outcomes", i, "do"), v);
    });
  }
}

/** All flag names read by a condition tree. */
export function flagsRead(c: Condition): string[] {
  const out: string[] = [];
  walkCondition(
    c,
    { in: "story", path: [] },
    {
      condition(x) {
        if ("flag" in x) out.push(x.flag);
        if ("flag_eq" in x) out.push(x.flag_eq.flag);
      },
    },
  );
  return out;
}
