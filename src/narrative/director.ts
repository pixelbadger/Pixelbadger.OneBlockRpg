/**
 * The set-piece director (§6.7, Q29): one LLM call after each player turn inside a set piece. It sees the brief, the
 * beats, the stage and the cast, and returns cast actions, effects, hooks, narration and beat progress. Everything is
 * validated against the set piece's declared moves. On failure it takes a no-op turn and the scene runs on behaviours.
 */
import { perform } from "../core/actions.js";
import { describeEvent } from "../core/describe.js";
import { applyEffects } from "../core/effects.js";
import { push, set } from "../core/ops.js";
import { advanceBeat, beatId } from "../core/set-piece.js";
import type { Cause, World } from "../core/world.js";
import { complete } from "../llm/provider.js";
import type { ActionRequest, Effect, SetPiece } from "../payload/schema.js";
import { ENGINE_RULES, storyPart } from "./context.js";
import type { NarrativeDeps } from "./conversation.js";
import { invokeHook } from "./hooks.js";
import { type DirectorEffect, DirectorTurn } from "./schemas.js";

const DIRECTOR: Cause = { by: "director" };

function stageText(w: World, sp: SetPiece): string {
  return sp.stage
    .map((room) => {
      const r = w.ix.rooms.get(room)!;
      const people = w
        .charsIn(room)
        .map((c) => `${w.label(c)} [${c}]${w.char(c).status !== "ok" ? ` (${w.char(c).status})` : ""}`);
      const things = w
        .childrenOf(room)
        .filter((id) => !w.isChar(id))
        .map((id) => {
          const props = Object.entries(w.state.objects[id]!.props)
            .filter(([k]) => !k.startsWith("_"))
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          return `${w.thing(id)!.name} [${id}]${props ? ` {${props}}` : ""}`;
        });
      const exits = r.exits.filter((x) => x.to).map((x) => `${x.direction ?? x.label}→${x.to}`);
      return `- ${r.name} [${room}]: people: ${people.join(", ") || "none"}; things: ${things.join(", ") || "none"}; exits: ${exits.join(", ")}`;
    })
    .join("\n");
}

function castText(w: World, sp: SetPiece): string {
  return sp.cast
    .map((c) => {
      const s = w.special(c);
      const st = w.char(c);
      const def = w.charDef(c);
      return `- ${def.name} [${c}] in ${w.roomOf(c) ?? "nowhere"}; HP ${st.hp}/${w.maxHp(c)}; ${st.status}${st.asleepUntil !== null ? ", asleep" : ""}. SPECIAL ST${s.ST} PE${s.PE} EN${s.EN} CH${s.CH} IN${s.IN} AG${s.AG} LK${s.LK}. Goals: ${def.goals.join("; ")}`;
    })
    .join("\n");
}

const OUTPUT_GUIDE = `Reply as JSON: {"narration": a few sentences for the player (unbounded in tone, but don't describe the player's own choices), "lines": [{"who": cast id, "text"}], "castActions": [{"actor": cast id, "action": {act, item?, target?, to?, from?, on?}}], "effects": [{"kind", ...fields}], "hooks": [{"id","args":[]}], "targets": [{"actor","target"}] for fights, "advanceBeat": true when the current beat has played out}.
Move the scene forward one step per turn. Use only the moves listed.`;

export class Director {
  /** Event cursor: what happened since the director last looked. */
  private seen = 0;

  constructor(private readonly d: NarrativeDeps) {
    this.seen = d.w.log.length;
  }

  async turn(): Promise<void> {
    const w = this.d.w;
    const st = w.state.setPiece;
    if (!st) return;
    const sp = w.ix.setPieces.get(st.id)!;
    const recent = w.log
      .slice(this.seen)
      .map((e) => describeEvent(w, e))
      .filter((t): t is string => !!t)
      .slice(-20);
    this.seen = w.log.length;
    const beats = sp.beats.map((b, i) => {
      const id = beatId(b);
      const desc = typeof b === "string" ? "" : `: ${b.description}`;
      return `${i === st.beat ? "→ " : i < st.beat ? "✓ " : "  "}${id}${desc}`;
    });
    const result = await complete(
      this.d.provider,
      {
        purpose: "director",
        system: [
          { label: "engine", text: ENGINE_RULES },
          storyPart(w),
          {
            label: "set-piece",
            cache: true,
            text: `# You are the director of a set piece: ${sp.id}
The player's objective (shown to them loosely): ${sp.objective}
## Brief
${sp.director_brief.trim()}
## Allowed moves
Cast actions: ${sp.moves.actions.join(", ") || "none"} (only for cast: ${sp.cast.join(", ")}).
Effects: ${sp.moves.effects.join(", ")}. Hooks: ${sp.moves.hooks.map((h) => `${h} (${w.ix.hooks.get(h)?.description})`).join("; ") || "none"}.
Stage rooms: ${sp.stage.join(", ")}. Keep the cast on the stage.`,
          },
        ],
        messages: [
          {
            role: "user",
            content: `## Beats\n${beats.join("\n")}\n## Stage\n${stageText(w, sp)}\n## Cast\n${castText(w, sp)}\n## Player\n${w.label(w.playerId)} [player] is in ${w.roomOf(w.playerId)}.\n## Since your last turn\n${recent.join("\n") || "(nothing)"}\n${st.narration.length ? `## Your narration so far\n${st.narration.slice(-5).join("\n")}\n` : ""}Turn ${st.turns + 1}. ${OUTPUT_GUIDE}`,
          },
        ],
        schema: DirectorTurn,
        maxOutputTokens: 3000,
      },
      this.d.onUsage,
    );
    if (!w.state.setPiece) return;
    if (!result.ok) {
      // No-op turn: the set piece continues on behaviours.
      w.emit("mode", {
        payload: { director: "no-op", error: result.error },
        ops: [set(["setPiece", "turns"], st.turns + 1)],
      });
      return;
    }
    this.apply(sp, result.value);
  }

  private apply(sp: SetPiece, t: DirectorTurn): void {
    const w = this.d.w;
    const inStage = (id: string) => {
      const room = w.isRoom(id) ? id : w.roomOf(id);
      return !!room && sp.stage.includes(room);
    };
    if (t.narration.trim()) {
      w.emit("narrated", {
        payload: { text: t.narration },
        cause: DIRECTOR,
        ops: [push(["setPiece", "narration"], t.narration)],
      });
      w.say(t.narration);
      w.dayLog(w.playerId, "set-piece", t.narration, DIRECTOR);
    }
    for (const l of t.lines) {
      if (!sp.cast.includes(l.who) || !w.isAwake(l.who)) continue;
      applyEffects(w, [{ say: { who: l.who, text: l.text } }], DIRECTOR);
    }
    for (const ca of t.castActions) {
      if (!sp.cast.includes(ca.actor) || !sp.moves.actions.includes(ca.action.act)) continue;
      if (ca.action.act === "go" && ca.action.to && !sp.stage.includes(ca.action.to)) continue;
      const req: ActionRequest = { act: ca.action.act };
      for (const k of ["item", "target", "to", "from", "on", "weapon", "direction"] as const) {
        if (ca.action[k]) req[k] = ca.action[k];
      }
      perform(w, ca.actor, req, DIRECTOR);
    }
    for (const e of t.effects) {
      if (!sp.moves.effects.includes(e.kind)) continue;
      const effect = toEffect(e, sp, inStage);
      if (effect) applyEffects(w, [effect], DIRECTOR);
    }
    for (const h of t.hooks) invokeHook(w, h, sp.moves.hooks, sp.cast[0] ?? w.playerId, "director");
    if (w.state.combat) {
      const combat = JSON.parse(JSON.stringify(w.state.combat)) as NonNullable<typeof w.state.combat>;
      let changed = false;
      for (const tg of t.targets) {
        const c = combat.combatants.find((x) => x.id === tg.actor);
        if (c && sp.cast.includes(tg.actor) && combat.combatants.some((x) => x.id === tg.target)) {
          c.target = tg.target;
          changed = true;
        }
      }
      if (changed) w.emit("mode", { payload: { director: "targets" }, ops: [set(["combat"], combat)] });
    }
    if (t.advanceBeat) advanceBeat(w, undefined, DIRECTOR);
    if (w.state.setPiece) {
      w.emit("mode", { payload: { director: "turn" }, ops: [set(["setPiece", "turns"], w.state.setPiece.turns + 1)] });
    }
  }
}

/** Rebuilds a director effect as a payload effect, constrained to the stage and cast. */
function toEffect(e: DirectorEffect, sp: SetPiece, inStage: (id: string) => boolean): Effect | null {
  const castOrPlayer = (id?: string) => !!id && (id === "player" || sp.cast.includes(id));
  switch (e.kind) {
    case "narrate":
      return e.text ? { narrate: e.text } : null;
    case "say":
      return e.text && castOrPlayer(e.who) && e.who !== "player" ? { say: { who: e.who!, text: e.text } } : null;
    case "set_property":
      return e.object && e.key && e.value !== undefined && inStage(e.object)
        ? { set_property: { object: e.object, key: e.key, value: e.value } }
        : null;
    case "set_flag":
      return e.flag ? { set_flag: e.value === undefined ? e.flag : { flag: e.flag, value: e.value } } : null;
    case "clear_flag":
      return e.flag ? { clear_flag: e.flag } : null;
    case "add_belief":
      return castOrPlayer(e.who) && e.belief
        ? { add_belief: { who: e.who!, belief: e.belief, source: "director" } }
        : null;
    case "remove_belief":
      return castOrPlayer(e.who) && e.belief ? { remove_belief: { who: e.who!, belief: e.belief } } : null;
    case "set_intent":
      return castOrPlayer(e.who) && e.who !== "player" ? { set_intent: { who: e.who!, intent: e.text ?? null } } : null;
    case "adjust_relationship":
      return castOrPlayer(e.who) && e.with
        ? {
            adjust_relationship: {
              who: e.who!,
              with: e.with,
              ...(e.trust ? { trust: e.trust } : {}),
              ...(e.affinity ? { affinity: e.affinity } : {}),
            },
          }
        : null;
    case "set_hostile":
      return castOrPlayer(e.who) && e.who !== "player"
        ? { set_hostile: { who: e.who!, hostile: e.value !== false } }
        : null;
    case "move":
      return e.object && e.to && inStage(e.object) && inStage(e.to) ? { move: { object: e.object, to: e.to } } : null;
    case "spawn":
      return e.object && e.to && inStage(e.to) ? { spawn: { object: e.object, in: e.to } } : null;
    case "remove":
      return e.object && inStage(e.object) ? { remove: e.object } : null;
  }
}
