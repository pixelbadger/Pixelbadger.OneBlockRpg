/**
 * The clock and everything that runs on it (§3.2 steps 3–5, §3.6, §5.8): time advances in chunks; bodies tire, sleep,
 * heal and wake; behaviours tick; triggers fire; set pieces start and end; endings are checked; witnesses log.
 */
import { collapses, healingRate } from "../mechanics/special.js";
import { fallAsleep, perform } from "./actions.js";
import { describeEvent, WITNESSED } from "./describe.js";
import { applyEffects, endGame } from "./effects.js";
import { activeBehaviours, heal } from "./mutate.js";
import { type Op, push, set } from "./ops.js";
import { endSetPiece, startSetPiece } from "./set-piece.js";
import type { Cause, World, WorldEvent } from "./world.js";

const ENGINE: Cause = { by: "engine" };
/** Largest step of the clock, in minutes, so time-of-day rules fire in order during long waits and sleeps. */
export const CHUNK = 15;
const MAX_PASSES = 4;

export interface TickOptions {
  /** The player is asleep: stop early if a waking trigger fires. */
  playerAsleep?: boolean;
}

export interface TickResult {
  /** Minutes actually advanced. */
  minutes: number;
  /** A trigger, conversation, combat or ending interrupted the advance. */
  interrupted: boolean;
}

/**
 * Per-World cursors into the event log (not state). A fresh world starts at the beginning, so events emitted before
 * the first tick are still seen; a loaded save calls resetCursors to start at the end of its log.
 */
const cursors = new WeakMap<World, { rules: number; witness: number; wake: boolean }>();
function cursor(w: World) {
  let c = cursors.get(w);
  if (!c) {
    c = { rules: 0, witness: 0, wake: false };
    cursors.set(w, c);
  }
  return c;
}

/** Advance the clock by `minutes` (0 runs one evaluation pass with no time passing). */
export function tick(w: World, minutes: number, opts: TickOptions = {}): TickResult {
  const cur = cursor(w);
  cur.wake = false;
  if (minutes <= 0) {
    evaluate(w, w.state.clock);
    return { minutes: 0, interrupted: interrupted(w, opts) };
  }
  let done = 0;
  while (done < minutes) {
    const step = Math.min(CHUNK, minutes - done);
    const from = w.state.clock;
    w.emit("clock-advanced", {
      payload: { from, to: from + step },
      ops: [set(["clock"], from + step), set(["windowFrom"], from)],
    });
    done += step;
    bodies(w, step);
    evaluate(w, from);
    if (interrupted(w, opts)) return { minutes: done, interrupted: true };
  }
  return { minutes: done, interrupted: false };
}

function interrupted(w: World, opts: TickOptions): boolean {
  if (w.state.ended) return true;
  if (w.signals.some((s) => s.kind === "conversation" || s.kind === "player-downed" || s.kind === "collapse")) {
    return true;
  }
  if (w.state.combat?.combatants.some((c) => c.id === w.playerId)) return true;
  return !!opts.playerAsleep && cursor(w).wake;
}

// ─── Bodies: fatigue, sleep, healing, modifiers, momentum (§5.8, Q18) ─────────

function bodies(w: World, minutes: number): void {
  const ops: Op[] = [];
  const clock = w.state.clock;
  const wakeList: string[] = [];
  const collapseList: string[] = [];
  const healList: [string, number][] = [];
  for (const [id, s] of Object.entries(w.state.chars)) {
    if (s.status === "dead") continue;
    const asleep = s.asleepUntil !== null;
    let awake = s.awakeMinutes;
    if (asleep) awake = Math.max(0, awake - minutes * 2 * s.sleepQuality);
    else if (s.status === "ok") awake += minutes;
    if (awake !== s.awakeMinutes) ops.push(set(["chars", id, "awakeMinutes"], awake));
    // Healing: rate per 6 hours, doubled while asleep.
    let acc = s.healAccum + minutes * (asleep ? 2 : 1);
    let ticks = 0;
    while (acc >= 360) {
      acc -= 360;
      ticks++;
    }
    if (acc !== s.healAccum) ops.push(set(["chars", id, "healAccum"], acc));
    if (ticks && s.hp < w.maxHp(id)) healList.push([id, ticks * healingRate(w.special(id))]);
    // Expired modifiers.
    const live = s.modifiers.filter((m) => m.expiresAt === undefined || m.expiresAt > clock);
    if (live.length !== s.modifiers.length) ops.push(set(["chars", id, "modifiers"], live));
    if (asleep && id !== w.playerId && s.asleepUntil! <= clock) wakeList.push(id);
    if (!asleep && s.status === "ok" && collapses(awake, s.special.EN)) collapseList.push(id);
    if (s.status === "down" && id !== w.playerId && s.downUntil !== null && s.downUntil <= clock) {
      ops.push(
        set(["chars", id, "status"], "ok"),
        set(["chars", id, "downUntil"], null),
        set(["chars", id, "hp"], Math.max(1, s.hp)),
      );
      wakeList.push(id);
    }
  }
  // Momentum decays each tick.
  for (const [id, o] of Object.entries(w.state.objects)) {
    const v = o.props.velocity;
    if (typeof v === "number" && v > 0) ops.push(set(["objects", id, "props", "velocity"], Math.floor(v / 2)));
  }
  if (ops.length) w.emit("fatigue", { payload: { minutes }, ops });
  for (const [id, amount] of healList) heal(w, id, amount, ENGINE);
  for (const id of wakeList) {
    if (w.char(id).asleepUntil !== null) {
      w.emit("woke", { targets: [id], ops: [set(["chars", id, "asleepUntil"], null)] });
    } else {
      w.emit("woke", { targets: [id] });
    }
    if (w.roomOf(id) === w.roomOf(w.playerId) && w.isAwake(w.playerId) && w.perceives(w.playerId, id)) {
      w.say(w.msg("wake.npc", { Actor: w.label(id) }), "ambient");
    }
  }
  for (const id of collapseList) {
    if (id === w.playerId) {
      if (!w.signals.some((s) => s.kind === "collapse")) w.signals.push({ kind: "collapse" });
    } else {
      fallAsleep(w, id, 0.5, ENGINE, true);
    }
  }
}

// ─── Behaviours, triggers, set pieces, endings ───────────────────────────────

function involvesApparition(w: World, e: WorldEvent): boolean {
  return [e.actor, ...e.targets].some((id) => id && w.thing(id) && !w.npcsPerceive(id));
}

function setEdge(w: World, key: string, value: boolean): void {
  if ((w.state.edges[key] ?? false) !== value) {
    w.emit("mode", { payload: { edge: key, value }, ops: [set(["edges", key], value)] });
  }
}

function evaluate(w: World, windowFrom: number): void {
  const cur = cursor(w);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const window = w.log.slice(cur.rules);
    cur.rules = w.log.length;
    if (pass > 0) {
      if (!window.some((e) => !["rng", "mode", "day-log", "fatigue"].includes(e.kind))) break;
      // Later passes react to new events only; the time window is already spent.
      if (w.state.windowFrom !== w.state.clock) {
        w.emit("mode", { payload: { window: "spent" }, ops: [set(["windowFrom"], w.state.clock)] });
      }
    } else if (w.state.windowFrom !== windowFrom) {
      w.emit("mode", { payload: { window: windowFrom }, ops: [set(["windowFrom"], windowFrom)] });
    }
    runBehaviours(w, window);
    if (w.state.ended) break;
    runTriggers(w, window);
    if (w.state.ended) break;
    runSetPieces(w);
    runEndings(w);
    if (w.state.ended) break;
  }
  recordWitnesses(w);
  hostiles(w);
}

function runBehaviours(w: World, window: WorldEvent[]): void {
  const owners = [...w.payload.objects.map((o) => o.id), ...w.payload.characters.map((c) => c.id)];
  for (const owner of owners) {
    if (w.locationOf(owner) === null) continue;
    const isChar = w.isChar(owner);
    if (isChar) {
      const s = w.char(owner);
      if (s.status !== "ok" || s.asleepUntil !== null) continue;
      if (w.state.combat?.combatants.some((c) => c.id === owner && c.status === "in")) continue;
      if (w.state.conversation?.character === owner) continue;
    }
    const events = isChar && owner !== w.playerId ? window.filter((e) => !involvesApparition(w, e)) : window;
    for (const bid of activeBehaviours(w, owner)) {
      const b = w.ix.behaviours.get(bid);
      if (!b) continue;
      const rules = b.rules.map((r, i) => ({ r, i })).sort((a, z) => z.r.priority - a.r.priority);
      for (const { r, i } of rules) {
        const key = `${owner}/${bid}/${i}`;
        const st = w.state.rules[key];
        if (r.once && st?.count) continue;
        if (r.cooldown !== undefined && st && w.state.clock - st.last < r.cooldown) continue;
        const now = w.cond(r.when, { self: owner, events });
        let fire = now;
        // Without a cooldown, rules are edge-triggered: they fire when their condition becomes true.
        if (r.cooldown === undefined) {
          fire = now && !(w.state.edges[key] ?? false);
          setEdge(w, key, now);
        }
        if (!fire) continue;
        w.emit("behaviour-fired", {
          actor: owner,
          payload: { behaviour: bid, rule: i },
          cause: { by: "behaviour", ref: key },
          ops: [set(["rules", key], { last: w.state.clock, count: (st?.count ?? 0) + 1 })],
        });
        applyEffects(w, r.do, { by: "behaviour", ref: key }, { self: owner, events });
        if (w.state.ended) return;
        if (isChar && (w.char(owner).status !== "ok" || w.char(owner).asleepUntil !== null)) break;
      }
    }
  }
}

function runTriggers(w: World, window: WorldEvent[]): void {
  for (const t of w.payload.story.triggers) {
    if (t.once && w.state.triggersFired.includes(t.id)) continue;
    const now = w.cond(t.when, { events: window });
    const key = `trigger:${t.id}`;
    const fire = now && (t.once || !(w.state.edges[key] ?? false));
    if (!t.once) setEdge(w, key, now);
    if (!fire) continue;
    w.emit("trigger-fired", {
      payload: { trigger: t.id },
      cause: { by: "trigger", ref: t.id },
      ops: t.once ? [push(["triggersFired"], t.id)] : [],
    });
    if (t.wakes) cursor(w).wake = true;
    applyEffects(w, t.do, { by: "trigger", ref: t.id }, { events: window });
    if (w.state.ended) return;
  }
}

function runSetPieces(w: World): void {
  const sp = w.state.setPiece;
  if (sp) {
    const def = w.ix.setPieces.get(sp.id)!;
    if (w.cond(def.ends_when)) endSetPiece(w, { by: "trigger", ref: `${sp.id}.ends_when` });
    return;
  }
  for (const def of w.payload.set_pieces) {
    if (!def.starts_when || w.state.setPiecesDone.includes(def.id)) continue;
    if (w.cond(def.starts_when)) {
      if (startSetPiece(w, def.id, { by: "trigger", ref: `${def.id}.starts_when` })) {
        cursor(w).wake = true;
        return;
      }
    }
  }
}

function runEndings(w: World): void {
  for (const e of w.payload.story.endings) {
    if (e.when && w.cond(e.when)) {
      endGame(w, e.id, { by: "trigger", ref: `ending:${e.id}` });
      return;
    }
  }
}

/** Day logs for what characters saw (§6.8). Apparitions never enter NPC logs (Q31). */
function recordWitnesses(w: World): void {
  const cur = cursor(w);
  const events = w.log.slice(cur.witness);
  cur.witness = w.log.length;
  for (const e of events) {
    if (!WITNESSED.has(e.kind)) continue;
    if (e.kind === "said" && e.payload.conversation) continue;
    const subject = e.actor ?? e.targets[0];
    if (!subject) continue;
    const room = w.roomOf(subject) ?? (e.targets[1] ? w.roomOf(e.targets[1]) : null);
    if (!room) continue;
    const text = describeEvent(w, e);
    if (!text) continue;
    const ghostly = involvesApparition(w, e);
    for (const who of w.witnessesIn(room)) {
      if (who !== w.playerId && ghostly) continue;
      const involved = who === e.actor || e.targets.includes(who);
      w.dayLog(who, involved ? "action" : "witnessed", text);
    }
  }
  cur.witness = w.log.length;
}

/** Hostile characters attack the player on sight. */
function hostiles(w: World): void {
  if (w.state.combat || w.state.conversation || w.state.ended) return;
  const p = w.playerId;
  if (!w.isAwake(p)) return;
  const room = w.roomOf(p);
  if (!room) return;
  for (const id of w.charsIn(room)) {
    if (id === p) continue;
    const s = w.char(id);
    if (s.hostile && s.status === "ok" && s.asleepUntil === null && w.npcsPerceive(id)) {
      perform(w, id, { act: "attack", target: p }, { by: "engine", ref: "hostile" });
      return;
    }
  }
}

/** Resets event cursors to the end of the log (after loading a save). */
export function resetCursors(w: World): void {
  cursors.set(w, { rules: w.log.length, witness: w.log.length, wake: false });
}
