/**
 * Reading (§4.13): a character who reads a document doesn't simply absorb it. They weigh what it says against what
 * they already believe, as people do (cognitive dissonance): they accept it and let go of what it contradicts, discount
 * the source, bend it to fit what they thought all along, or shelve it. One LLM call decides, in character; the engine
 * validates and applies the verdict as belief events. Without a model, they take in what it says (the old rule).
 */
import { addBelief, removeBelief } from "../core/mutate.js";
import type { Cause, World } from "../core/world.js";
import { complete } from "../llm/provider.js";
import { beliefsText, characterPart, ENGINE_RULES, storyPart, summariesPart, todayLog } from "./context.js";
import type { NarrativeDeps } from "./conversation.js";
import { ReadingVerdict } from "./schemas.js";

const THOUGHT_CHARS = 240;

const clamp = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;

function readingPrompt(w: World, who: string, thing: string, taught: readonly string[]): string {
  const def = w.thing(thing)!;
  const props = taught.map((b) => `- [${b}] ${w.ix.beliefs.get(b) ?? b}`).join("\n");
  const IN = w.special(who).IN;
  return `## You have just read: ${def.name} [${thing}]
${w.text(def.description, { self: thing })}

## What it tells you, as plainly as it can be put
${props}

## What you believe right now
${beliefsText(w, who)}

## Your day so far
${todayLog(w, who)}

## How you take it in
People don't simply absorb what they read. What fits what they already believe goes in easily. What contradicts something they hold firmly, or something that matters to them, is uncomfortable (cognitive dissonance), and people ease that discomfort in one of a few ways:
- change their mind: accept it, and weaken or drop the beliefs it contradicts;
- discount the source: a forgery, a mistake, gossip, someone's agenda;
- reinterpret it so it fits: it proves what they suspected all along, or shows the other side is wrong;
- shelve it: not sure, it'll keep.
The firmer a belief (its confidence) and the more it matters to you, the harder you resist what threatens it. Your Intelligence is ${IN} of 10: it decides how fully you follow what the document actually says, not how willing you are to believe it. Decide as ${w.charDef(who).name} would, from everything you know of yourself.

Reply as JSON: {"reaction": one or two sentences of private thought, first person, in your voice; "accept": [{"belief": id from "What it tells you", "confidence": 0-1}] for each proposition you now hold (leave out what you reject or shelve); "revise": [{"belief": id of something you already believe, "confidence": new 0-1}, or {"belief": id, "drop": true}] only where this changes your mind; "thoughts": [{"text": a belief in your own words, "confidence": 0-1}], at most two, only if the reading leaves you believing something new beyond its propositions (what it proves, who it shows up, why it must be false)}.`;
}

/** Reconciles a document a character has read with their beliefs, and applies the outcome (a `read` signal). */
export async function reconcileReading(d: NarrativeDeps, who: string, thing: string): Promise<void> {
  const w = d.w;
  const def = w.thing(thing);
  if (!def || !w.isChar(who)) return;
  const taught = def.teaches.filter((b) => !w.believes(who, b));
  if (!taught.length) return;
  const cause: Cause = { by: "reading", ref: thing };
  const r = await complete(
    d.provider,
    {
      purpose: "reading",
      system: [{ label: "engine", text: ENGINE_RULES }, storyPart(w), characterPart(w, who), summariesPart(w, who)],
      messages: [{ role: "user", content: readingPrompt(w, who, thing, taught) }],
      schema: ReadingVerdict,
      maxOutputTokens: 1200,
    },
    d.onUsage,
  );
  // The safe fallback (§6.9): they take it in as written.
  const v: ReadingVerdict = r.ok
    ? r.value
    : { reaction: "", accept: taught.map((belief) => ({ belief, confidence: 1 })), revise: [], thoughts: [] };

  const accepted = new Map<string, number>();
  for (const a of v.accept) if (taught.includes(a.belief)) accepted.set(a.belief, clamp(a.confidence));
  for (const [belief, confidence] of accepted) addBelief(w, who, belief, confidence, def.name, cause);
  for (const x of v.revise) {
    const held = w.char(who).beliefs.find((b) => b.id === x.belief);
    if (!held || accepted.has(x.belief)) continue;
    if (x.drop || x.confidence === 0) removeBelief(w, who, x.belief, cause);
    else if (x.confidence !== undefined && clamp(x.confidence) !== held.confidence) {
      addBelief(w, who, x.belief, clamp(x.confidence), `${held.source}; weighed against ${def.name}`, cause, held.text);
    }
  }
  const own = w.char(who).beliefs.filter((b) => b.id.startsWith("thought-")).length;
  v.thoughts
    .map((t) => ({ text: t.text.trim().slice(0, THOUGHT_CHARS), confidence: clamp(t.confidence) }))
    .filter((t) => t.text && t.confidence > 0)
    .forEach((t, i) => {
      addBelief(w, who, `thought-${own + i + 1}`, t.confidence, `reading the ${def.name}`, cause, t.text);
    });
  const rejected = taught.filter((b) => !accepted.has(b));
  w.emit("read", { actor: who, targets: [thing], payload: { accepted: [...accepted.keys()], rejected }, cause });
  const reaction = v.reaction.trim();
  w.dayLog(who, "note", `Read the ${def.name}.${reaction ? ` ${reaction}` : ""}`, cause);
}
