/** The effect half of the §7.5 language. Effects never run code: each is one engine operation. */
import {
  attributeCheck,
  type CheckResult,
  opposedCheck,
  perceptionDefence,
  SKILL_NAMES,
  skillCheck,
  speechDefence,
} from "../mechanics/special.js";
import type { CheckSpec, Effect, NumArg } from "../payload/schema.js";
import { perform } from "./actions.js";
import {
  addBelief,
  addModifier,
  adjustRelationship,
  awardXp,
  clearFlag,
  damage,
  giveMoney,
  heal,
  moveThing,
  removeBelief,
  setCharField,
  setFlag,
  setProp,
  startBehaviour,
  stopBehaviour,
} from "./mutate.js";
import { set } from "./ops.js";
import { advanceBeat, endSetPiece, startSetPiece } from "./set-piece.js";
import type { Cause, EvalContext, World } from "./world.js";

export function argValue(v: NumArg | undefined, ctx: EvalContext): number {
  if (v === undefined) return 0;
  if (typeof v === "number") return v;
  const a = ctx.args?.[v.$arg];
  return typeof a === "number" ? a : Number(a ?? 0) || 0;
}

export interface CheckOutcome extends CheckResult {
  label: string;
}

/** Resolves a check (§5.4). The engine always rolls; nobody else decides outcomes. */
export function resolveCheck(w: World, spec: CheckSpec, ctx: EvalContext, cause: Cause): CheckOutcome {
  const who = w.resolve(spec.who ?? "player", ctx);
  const tier = spec.tier ?? "normal";
  const mod = spec.modifier ?? 0;
  const LK = w.special(who).LK;
  let result: CheckResult;
  let label: string;
  if (spec.skill) {
    const skill = w.skill(who, spec.skill);
    label = SKILL_NAMES[spec.skill];
    if (spec.opposed) {
      const opp = w.resolve(spec.opposed, ctx);
      const defence =
        spec.skill === "speech" || spec.skill === "barter"
          ? speechDefence(w.special(opp), w.relationship(opp, who).trust)
          : perceptionDefence(w.special(opp));
      result = w.roll((rng) => opposedCheck(rng, skill, defence, tier, mod, LK), cause);
    } else {
      result = w.roll((rng) => skillCheck(rng, skill, tier, mod, LK), cause);
    }
  } else {
    const attr = spec.attribute ?? "LK";
    label = attr;
    result = w.roll((rng) => attributeCheck(rng, w.special(who)[attr], mod, LK), cause);
  }
  w.emit("checked", {
    actor: who,
    targets: spec.opposed ? [w.resolve(spec.opposed, ctx)] : [],
    payload: { skill: spec.skill ?? null, attribute: spec.attribute ?? null, tier, ...result },
    cause,
  });
  if (who === w.playerId) {
    const shown = result.kind === "attribute" ? `${result.target}/10` : `${Math.max(0, Math.min(100, result.target))}`;
    w.say(w.msg(result.pass ? "check.pass" : "check.fail", { label, target: shown }).replace("/10%", "/10"), "check");
    if (result.pass) awardXp(w, who, w.payload.game.xp.check, cause);
  }
  return { ...result, label };
}

export function applyEffects(w: World, effects: readonly Effect[] | undefined, cause: Cause, ctx: EvalContext = {}) {
  for (const e of effects ?? []) {
    if (w.state.ended) return;
    applyEffect(w, e, cause, ctx);
  }
}

export function applyEffect(w: World, e: Effect, cause: Cause, ctx: EvalContext = {}): void {
  const r = (id: string | undefined, fallback = "player") => w.resolve(id ?? fallback, ctx);

  if ("set_flag" in e) {
    if (typeof e.set_flag === "string") setFlag(w, e.set_flag, true, cause);
    else setFlag(w, e.set_flag.flag, e.set_flag.value, cause);
  } else if ("clear_flag" in e) {
    clearFlag(w, e.clear_flag, cause);
  } else if ("set_property" in e) {
    setProp(w, r(e.set_property.object), e.set_property.key, e.set_property.value, cause);
  } else if ("move" in e) {
    moveThing(w, r(e.move.object), r(e.move.to), "relocated", cause);
  } else if ("spawn" in e) {
    moveThing(w, e.spawn.object, r(e.spawn.in), "spawned", cause);
  } else if ("remove" in e) {
    moveThing(w, r(e.remove), null, "removed", cause);
  } else if ("act" in e) {
    const { act, actor, ...params } = e;
    const who = r(actor, "self");
    perform(w, who, { act, ...params } as never, cause);
  } else if ("say" in e) {
    const who = typeof e.say === "string" ? r("self") : r(e.say.who);
    const text = w.interpolate(typeof e.say === "string" ? e.say : e.say.text);
    w.emit("said", { actor: who, payload: { text }, cause });
    const room = w.roomOf(who);
    if (who !== w.playerId && room && room === w.roomOf(w.playerId) && w.isAwake(w.playerId)) {
      w.say(text, "speech", w.label(who));
    }
  } else if ("narrate" in e) {
    const text = w.text(e.narrate, ctx);
    w.emit("narrated", { payload: { text }, cause });
    w.say(text);
    w.dayLog(w.playerId, "witnessed", text, cause);
  } else if ("set_intent" in e) {
    const [who, intent] =
      e.set_intent === null || typeof e.set_intent === "string"
        ? [r("self"), e.set_intent]
        : [r(e.set_intent.who), e.set_intent.intent];
    if (w.isChar(who)) setCharField(w, who, "intent", intent, "intent-set", cause);
  } else if ("start_behaviour" in e || "stop_behaviour" in e) {
    const start = "start_behaviour" in e;
    const v = start
      ? e.start_behaviour
      : (e as { stop_behaviour: string | { who?: string; behaviour: string } }).stop_behaviour;
    const [who, b] = typeof v === "string" ? [r("self"), v] : [r(v.who, "self"), v.behaviour];
    if (start) startBehaviour(w, who, b, cause);
    else stopBehaviour(w, who, b, cause);
  } else if ("adjust_relationship" in e) {
    const a = e.adjust_relationship;
    adjustRelationship(
      w,
      r(a.who),
      r(a.with),
      { trust: argValue(a.trust, ctx), affinity: argValue(a.affinity, ctx) },
      cause,
    );
  } else if ("add_belief" in e) {
    const b = e.add_belief;
    addBelief(w, r(b.who), b.belief, b.confidence ?? 1, b.source ?? cause.by, cause);
  } else if ("remove_belief" in e) {
    removeBelief(w, r(e.remove_belief.who), e.remove_belief.belief, cause);
  } else if ("start_conversation" in e) {
    w.signals.push({ kind: "conversation", id: e.start_conversation });
  } else if ("end_conversation" in e) {
    if (w.state.conversation) {
      w.emit("mode", { payload: { conversation: "ending" }, cause, ops: [set(["conversation", "ending"], true)] });
    }
  } else if ("check" in e) {
    const result = resolveCheck(w, e.check, ctx, cause);
    applyEffects(w, result.pass ? e.check.pass : e.check.fail, cause, ctx);
  } else if ("award_xp" in e) {
    const [who, amount] =
      typeof e.award_xp === "object" && "amount" in e.award_xp
        ? [r(e.award_xp.who), argValue(e.award_xp.amount, ctx)]
        : [w.playerId, argValue(e.award_xp as NumArg, ctx)];
    awardXp(w, who, amount, cause);
  } else if ("heal" in e) {
    heal(w, r(e.heal.who), argValue(e.heal.amount, ctx), cause);
  } else if ("damage" in e) {
    const who = r(e.damage.who);
    const status = damage(w, who, argValue(e.damage.amount, ctx), cause);
    if (status && who === w.playerId && !w.state.combat) w.signals.push({ kind: "player-downed" });
  } else if ("modify" in e) {
    const m = e.modify;
    const minutes = (m.minutes ?? 0) + (m.hours ?? 0) * 60;
    addModifier(
      w,
      r(m.who),
      {
        amount: m.amount,
        ...(m.id ? { id: m.id } : {}),
        ...(m.attribute ? { attribute: m.attribute } : {}),
        ...(m.skill ? { skill: m.skill } : {}),
        ...(minutes > 0 ? { minutes } : {}),
        source: cause.ref ?? cause.by,
      },
      cause,
    );
  } else if ("give_money" in e) {
    giveMoney(w, r(e.give_money.who), argValue(e.give_money.amount, ctx), cause);
  } else if ("set_hostile" in e) {
    const [who, hostile] =
      typeof e.set_hostile === "string"
        ? [r(e.set_hostile), true]
        : [r(e.set_hostile.who), e.set_hostile.hostile ?? true];
    setCharField(w, who, "hostile", hostile, "hostile-set", cause);
  } else if ("set_combat_profile" in e) {
    const who = r(e.set_combat_profile.who);
    setCharField(
      w,
      who,
      "combatProfile",
      { ...w.char(who).combatProfile, ...e.set_combat_profile.profile },
      "combat-profile-set",
      cause,
    );
  } else if ("start_set_piece" in e) {
    startSetPiece(w, e.start_set_piece, cause);
  } else if ("advance_beat" in e) {
    advanceBeat(w, typeof e.advance_beat === "string" ? e.advance_beat : undefined, cause);
  } else if ("end_set_piece" in e) {
    const id = typeof e.end_set_piece === "string" ? e.end_set_piece : w.state.setPiece?.id;
    if (id && w.state.setPiece?.id === id) endSetPiece(w, cause);
  } else if ("callout" in e) {
    w.signals.push({ kind: "callout", id: e.callout });
  } else if ("end_game" in e) {
    endGame(w, e.end_game, cause);
  }
}

export function endGame(w: World, endingId: string, cause: Cause): void {
  if (w.state.ended) return;
  const ending = w.ix.endings.get(endingId);
  if (!ending) return;
  const text = w.text(ending.text);
  const ended = { ending: endingId, ...(ending.title ? { title: ending.title } : {}), text };
  w.emit("game-ended", { payload: ended, cause, ops: [set(["ended"], ended)] });
  w.say(text, "ending");
}
