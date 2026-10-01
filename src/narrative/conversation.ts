/**
 * Conversations (§6.2–6.6, §3.3): multiple choice, two-party, overheard by others in the room. Each character turn is
 * one structured LLM call; the character's actions and hooks are resolved by the engine; player options merge
 * authored lines (pinned and gated) with LLM suggestions. The rest of the world pauses until it ends.
 */
import { BASE_MINUTES, perform } from "../core/actions.js";
import { applyEffects, resolveCheck } from "../core/effects.js";
import { push, set } from "../core/ops.js";
import type { ConversationState, ConvOption } from "../core/state.js";
import type { Cause, World } from "../core/world.js";
import { complete, type LlmProvider, type UsageRecord } from "../llm/provider.js";
import { actionMinutes, SKILL_NAMES } from "../mechanics/special.js";
import {
  type ActionRequest,
  type AuthoredOption,
  type Condition,
  type Conversation,
  DEFAULT_CONVERSATION_ACTIONS,
} from "../payload/schema.js";
import {
  characterPart,
  conversationPart,
  ENGINE_RULES,
  OUTPUT_GUIDE_CONVERSATION,
  sceneText,
  storyPart,
  summariesPart,
  todayLog,
} from "./context.js";
import { invokeHook } from "./hooks.js";
import { CharacterTurn, type LlmAction } from "./schemas.js";

const MAX_LLM_OPTIONS = 4;
const OPTION_ACTIONS = new Set([
  "give",
  "show",
  "take",
  "drop",
  "use",
  "open",
  "close",
  "go",
  "attack",
  "throw",
  "steal",
  "buy",
  "sell",
  "equip",
]);

export interface NarrativeDeps {
  w: World;
  provider: LlmProvider;
  onUsage?: (u: UsageRecord) => void;
}

function cause(id: string): Cause {
  return { by: "conversation", ref: id };
}

function patch(w: World, values: Partial<ConversationState>): void {
  w.emit("mode", {
    payload: { conversation: Object.keys(values) },
    ops: Object.entries(values).map(([k, v]) => set(["conversation", k], v)),
  });
}

function addLine(w: World, conv: ConversationState, speaker: string, text: string): void {
  if (!text.trim()) return;
  w.emit("said", {
    actor: speaker,
    targets: [speaker === conv.character ? w.playerId : conv.character],
    payload: { text, conversation: conv.id },
    cause: cause(conv.id),
    ops: [push(["conversation", "transcript"], { speaker, text })],
  });
}

/** Gate label for an authored option (§6.3): "[Speech]" for a check, "[CH 6]" for a SPECIAL threshold. */
export function gateLabel(o: AuthoredOption): string | undefined {
  if (o.text.trim().startsWith("[")) return undefined;
  if (o.check?.skill) return `[${SKILL_NAMES[o.check.skill]}]`;
  if (o.check?.attribute) return `[${o.check.attribute}]`;
  const find = (c: Condition | undefined): string | undefined => {
    if (!c) return undefined;
    if ("special" in c) {
      for (const [k, v] of Object.entries(c.special)) {
        if (k === "who" || v === undefined || typeof v === "string") continue;
        const n = typeof v === "number" ? v : (v.gte ?? v.gt ?? v.eq);
        if (n !== undefined) return `[${k} ${n}]`;
      }
    }
    if ("skill" in c) return `[${SKILL_NAMES[c.skill.skill]} ${c.skill.gte ?? c.skill.gt ?? ""}]`.replace(" ]", "]");
    if ("all" in c) for (const x of c.all) if (find(x)) return find(x);
    return undefined;
  };
  return find(o.when);
}

export function allowedActions(conv: Conversation): string[] {
  return [...(conv.actions ?? DEFAULT_CONVERSATION_ACTIONS)];
}

function toRequest(a: LlmAction): ActionRequest {
  const out: ActionRequest = { act: a.act };
  for (const k of ["item", "target", "to", "from", "on", "weapon", "direction"] as const) {
    if (a[k]) out[k] = a[k];
  }
  return out;
}

const timeOf = (w: World, who: string, req: ActionRequest, minutes: number, fixed?: boolean) =>
  fixed ? minutes : actionMinutes(minutes || BASE_MINUTES[req.act], w.ap(who));

export class Conversations {
  constructor(private readonly d: NarrativeDeps) {}

  get w(): World {
    return this.d.w;
  }

  current(): ConversationState | null {
    return this.w.state.conversation;
  }

  spec(): Conversation | undefined {
    const c = this.current();
    return c ? this.w.ix.conversations.get(c.id) : undefined;
  }

  /** Opens a conversation and plays the character's first turn. */
  async start(id: string): Promise<boolean> {
    const w = this.w;
    const spec = w.ix.conversations.get(id);
    if (!spec || w.state.conversation) return false;
    const ch = spec.character;
    if (!w.isChar(ch) || w.roomOf(ch) !== w.roomOf(w.playerId) || !w.isAwake(ch) || !w.isAwake(w.playerId))
      return false;
    const state: ConversationState = {
      id,
      character: ch,
      turn: 0,
      startedAt: w.state.clock,
      transcript: [],
      results: [],
      actionMinutes: 0,
      suspended: false,
      ending: false,
      options: [],
    };
    w.emit("conversation-started", {
      actor: w.playerId,
      targets: [ch],
      payload: { conversation: id },
      cause: cause(id),
      ops: [set(["conversation"], state)],
    });
    if (spec.opening) {
      const opening = w.text(spec.opening, { self: ch });
      w.say(opening);
      addLine(w, w.state.conversation!, ch, opening);
    }
    await this.characterTurn();
    return true;
  }

  /** One character turn: an LLM call, then the engine resolves actions and hooks, then merges options. */
  async characterTurn(): Promise<void> {
    const w = this.w;
    const conv = this.current();
    const spec = this.spec();
    if (!conv || !spec) return;
    const ch = conv.character;
    const allowed = allowedActions(spec);
    const result = await complete(
      this.d.provider,
      {
        purpose: "conversation",
        system: [
          { label: "engine", text: ENGINE_RULES },
          storyPart(w),
          characterPart(w, ch),
          summariesPart(w, ch),
          conversationPart(w, spec, allowed),
        ],
        messages: [{ role: "user", content: this.turnMessage(conv) }],
        schema: CharacterTurn,
        maxOutputTokens: 2000,
      },
      this.d.onUsage,
    );

    const results: string[] = [];
    let llmOptions: CharacterTurn["playerOptions"] = [];
    let wantsToEnd = false;
    if (!result.ok) {
      const line = spec.fallback_line ?? w.charDef(ch).fallback_line ?? `${w.label(ch)} doesn't answer.`;
      w.say(line, "narration");
      addLine(w, conv, ch, `(${line})`);
    } else {
      const turn = result.value;
      if (turn.line.trim()) {
        w.say(turn.line, "speech", w.label(ch));
        addLine(w, conv, ch, turn.line);
      }
      // Actions (§6.6): allow-list, then the same validation as anywhere else.
      for (const a of turn.actions) {
        if (!allowed.includes(a.act)) {
          results.push(`${a.act}: not allowed in this conversation`);
          continue;
        }
        const req = toRequest(a);
        const r = perform(w, ch, req, cause(conv.id));
        results.push(`${w.label(ch)} tried to ${a.act}: ${r.ok ? r.summary : `failed (${r.summary})`}`);
        if (r.ok)
          patch(w, {
            actionMinutes: (this.current()?.actionMinutes ?? 0) + timeOf(w, ch, req, r.minutes, r.fixedTime),
          });
        if (w.state.combat) break;
        if (w.roomOf(ch) !== w.roomOf(w.playerId)) break;
      }
      for (const h of turn.hooks) results.push(invokeHook(w, h, spec.hooks, ch, "conversation").summary);
      llmOptions = turn.playerOptions;
      wantsToEnd = !!turn.wantsToEnd;
    }
    if (!this.current()) return;
    patch(w, { results, turn: this.current()!.turn + 1 });
    // An attack suspends the conversation; combat takes over.
    if (w.state.combat) {
      patch(w, { suspended: true, options: [] });
      return;
    }
    if (w.roomOf(ch) !== w.roomOf(w.playerId) || !w.isAwake(ch) || wantsToEnd || this.endsNow()) {
      this.end();
      return;
    }
    patch(w, { options: this.mergeOptions(spec, llmOptions) });
  }

  private turnMessage(conv: ConversationState): string {
    const w = this.w;
    const transcript = conv.transcript.map(
      (l) => `${l.speaker === w.playerId ? w.label(w.playerId) : w.label(l.speaker)}: ${l.text}`,
    );
    return `## Where you are
${sceneText(w, conv.character)}
## Your day so far
${todayLog(w, conv.character)}
## This conversation so far
${transcript.join("\n") || "(it is just starting)"}
${conv.results.length ? `## What just happened (engine report)\n${conv.results.map((r) => `- ${r}`).join("\n")}\n` : ""}
It is your turn (turn ${conv.turn + 1}). ${OUTPUT_GUIDE_CONVERSATION}`;
  }

  private endsNow(): boolean {
    const conv = this.current();
    const spec = this.spec();
    if (!conv || !spec) return true;
    if (conv.ending) return true;
    return !!spec.ends_when && this.w.cond(spec.ends_when, { self: conv.character, turns: conv.turn });
  }

  /** Authored options whose conditions hold, then LLM suggestions (authored win ties), then Leave (§6.3). */
  mergeOptions(spec: Conversation, llm: CharacterTurn["playerOptions"]): ConvOption[] {
    const w = this.w;
    const conv = this.current()!;
    const out: ConvOption[] = [];
    const seen = new Set<string>();
    const norm = (t: string) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    spec.options.forEach((o, index) => {
      if (o.once && w.state.optionsUsed.includes(`${spec.id}/${index}`)) return;
      if (o.when && !w.cond(o.when, { self: conv.character, turns: conv.turn })) return;
      const gate = gateLabel(o);
      const text = gate ? `${gate} ${o.text}` : o.text;
      seen.add(norm(o.text));
      out.push({ kind: "authored", text, index });
    });
    let added = 0;
    for (const o of llm) {
      if (added >= MAX_LLM_OPTIONS || !o.text.trim() || seen.has(norm(o.text))) continue;
      seen.add(norm(o.text));
      // Only physical acts make sense attached to a reply (§6.6); talk, wait, sleep and look do not.
      const action = o.action && OPTION_ACTIONS.has(o.action.act) ? toRequest(o.action) : undefined;
      const label = o.check && !o.text.trim().startsWith("[") ? `[${SKILL_NAMES[o.check.skill]}] ${o.text}` : o.text;
      out.push({ kind: "llm", text: label, ...(action ? { action } : {}), ...(o.check ? { check: o.check } : {}) });
      added++;
    }
    out.push({ kind: "leave", text: "[Leave]" });
    return out;
  }

  /** The player picks an option. Attached actions and checks are resolved by the engine. */
  async choose(index: number): Promise<void> {
    const w = this.w;
    const conv = this.current();
    const spec = this.spec();
    if (!conv || !spec) return;
    const opt = conv.options[index];
    if (!opt) return;
    const ctx = { self: conv.character };
    const c = cause(conv.id);
    const results: string[] = [];
    const player = w.playerId;
    if (opt.kind === "leave") {
      this.end();
      return;
    }
    const spoken = opt.text.replace(/^\[[^\]]*\]\s*/, "");
    addLine(w, conv, player, opt.text);
    if (spoken) w.say(`"${spoken}"`, "narration");
    let endAfter = false;
    const doAction = (req: ActionRequest) => {
      const r = perform(w, player, req, c);
      results.push(`${w.label(player)} tried to ${req.act}: ${r.ok ? r.summary : `failed (${r.summary})`}`);
      if (r.ok)
        patch(w, {
          actionMinutes: (this.current()?.actionMinutes ?? 0) + timeOf(w, player, req, r.minutes, r.fixedTime),
        });
    };
    if (opt.kind === "authored") {
      const o = spec.options[opt.index]!;
      if (o.once)
        w.emit("mode", { payload: { option: opt.index }, ops: [push(["optionsUsed"], `${spec.id}/${opt.index}`)] });
      if (o.action) doAction(o.action);
      if (o.check) {
        const r = resolveCheck(w, o.check, ctx, c);
        results.push(
          `${w.label(player)} ${r.pass ? "passed" : "failed"} a ${r.label} check (${o.check.tier ?? "normal"})`,
        );
        applyEffects(w, r.pass ? o.check.pass : o.check.fail, c, ctx);
      }
      applyEffects(w, o.effects, c, ctx);
      endAfter = !!o.end;
    } else {
      if (opt.action) doAction(opt.action);
      if (opt.check) {
        const r = resolveCheck(w, { skill: opt.check.skill, tier: opt.check.tier }, ctx, c);
        results.push(
          `${w.label(player)} ${r.pass ? "passed" : "failed"} a ${r.label} check (${opt.check.tier}): ${r.pass ? "it works" : "it doesn't land"}`,
        );
      }
    }
    if (!this.current()) return;
    patch(w, { results: [...(this.current()!.results ?? []), ...results], options: [] });
    if (w.state.combat) {
      patch(w, { suspended: true });
      return;
    }
    if (endAfter || w.state.ended || this.endsNow() || w.roomOf(conv.character) !== w.roomOf(player)) {
      this.end();
      return;
    }
    await this.characterTurn();
  }

  /** After combat: resume if both are conscious, together and the character is willing (§6.6). */
  async resumeAfterCombat(outcome: string): Promise<void> {
    const w = this.w;
    const conv = this.current();
    if (!conv) return;
    const ch = conv.character;
    const willing =
      w.isAwake(ch) && w.isAwake(w.playerId) && !w.char(ch).hostile && w.roomOf(ch) === w.roomOf(w.playerId);
    if (!willing) {
      this.end();
      return;
    }
    patch(w, { suspended: false, results: [...conv.results, `The fight is over: ${outcome}`] });
    await this.characterTurn();
  }

  /** Ends the conversation: transcripts go to both parties' day logs and to anyone overhearing (§3.3, Q21). */
  end(): number {
    const w = this.w;
    const conv = this.current();
    if (!conv) return 0;
    const c = cause(conv.id);
    const name = (id: string) => w.label(id);
    const transcript = conv.transcript.map((l) => `${name(l.speaker)}: ${l.text}`).join("\n");
    const header = `Conversation between ${name(w.playerId)} and ${name(conv.character)}`;
    const room = w.roomOf(w.playerId);
    const turns = conv.transcript.filter((l) => l.speaker === conv.character).length;
    const minutes = Math.round(turns * w.payload.game.conversation_minutes_per_turn) + conv.actionMinutes;
    w.emit("conversation-ended", {
      actor: w.playerId,
      targets: [conv.character],
      payload: { conversation: conv.id, turns, minutes },
      cause: c,
      ops: [set(["conversation"], null)],
    });
    if (transcript) {
      w.dayLog(w.playerId, "conversation", `${header}:\n${transcript}`, c);
      w.dayLog(conv.character, "conversation", `${header}:\n${transcript}`, c);
      if (room) {
        for (const who of w.witnessesIn(room)) {
          if (who === w.playerId || who === conv.character) continue;
          w.dayLog(who, "overheard", `Overheard: ${header}:\n${transcript}`, c);
        }
      }
    }
    return minutes;
  }
}
