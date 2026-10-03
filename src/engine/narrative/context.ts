/**
 * The context builder (§6.3). Prompt parts are ordered from stable to volatile so prompt caching works:
 * engine rules → story → character → previous day summaries (cache breakpoint) → conversation/scene → per turn.
 */
import { formatClock } from "../core/clock.js";
import { describeRoom } from "../core/describe.js";
import type { World } from "../core/world.js";
import type { PromptPart } from "../llm/provider.js";
import { ATTRIBUTE_NAMES, actionPoints, armourClass, carryCapacity } from "../mechanics/special.js";
import type { Conversation } from "../payload/schema.js";

export const ENGINE_RULES = `You are part of a text adventure engine for a "one block" role-playing game: a single city block simulated in depth.
The engine owns the world: rooms, objects, who is where, flags and time. You never change the world by saying so.
You change it only by requesting actions (the shared action vocabulary, validated by the engine) or by invoking the hooks you are offered.
Anything you say without a hook or action is speech: it is remembered by those who heard it, but it is not fact.
The engine resolves every roll and check. Never narrate the outcome of an action or check before the engine reports it.
Refer to people and things by the ids given in brackets when you request actions or hooks.
Reply with a single JSON object matching the schema. No prose outside the JSON.`;

const VERB_HELP = `Action fields: act (verb), item, target, to, from, on, weapon, direction.
go {to: room id}; give {item, to}; take {item, from?}; use {item, on?}; open/close {target}; drop {item}; equip {item}; attack {target, weapon?}; show {item, to}; throw {item, target?}.`;

export function storyPart(w: World): PromptPart {
  const p = w.payload;
  const beliefs = p.story.beliefs.length
    ? `\nNamed beliefs (ids used by hooks):\n${p.story.beliefs.map((b) => `- ${b.id}: ${b.text}`).join("\n")}`
    : "";
  return {
    label: "story",
    text: `# The game: ${p.game.title}
## Synopsis
${p.story.synopsis.trim()}
${p.story.tone ? `\n## Tone\n${p.story.tone}\n` : ""}${p.story.tensions.length ? `\n## Tensions\n${p.story.tensions.map((t) => `- ${t}`).join("\n")}\n` : ""}
## Style guide
${p.game.style_guide.trim() || "Write in the story's tone."}${beliefs}`,
  };
}

function relationshipsText(w: World, who: string): string {
  const rels = Object.entries(w.char(who).relationships);
  if (!rels.length) return "none recorded";
  return rels
    .map(
      ([other, r]) =>
        `- ${w.label(other)} [${other}]: trust ${r.trust}, affinity ${r.affinity}${r.notes ? `. ${r.notes}` : ""}`,
    )
    .join("\n");
}

export function characterPart(w: World, who: string): PromptPart {
  const def = w.charDef(who);
  const s = w.special(who);
  const special = (Object.keys(ATTRIBUTE_NAMES) as (keyof typeof ATTRIBUTE_NAMES)[])
    .map((k) => `${k} ${s[k]}`)
    .join(", ");
  return {
    label: "character",
    text: `# You are ${def.name} [${who}]
${def.persona.identity}
${def.persona.background ? `Background: ${def.persona.background}\n` : ""}${def.persona.personality.length ? `Personality: ${def.persona.personality.join(", ")}\n` : ""}${def.persona.voice ? `Voice: ${def.persona.voice}\n` : ""}
SPECIAL: ${special}. AP ${actionPoints(s)}, AC ${armourClass(s)}, carry ${carryCapacity(s)} kg. Tag skills: ${w.char(who).tags.join(", ") || "none"}.
## Your goals
${def.goals.map((g) => `- ${g}`).join("\n") || "- (none stated)"}
## Relationships
${relationshipsText(w, who)}`,
  };
}

/** All previous day summaries for this character (§6.8). Changes only overnight: the cache breakpoint sits here. */
export function summariesPart(w: World, who: string): PromptPart {
  const sums = w.state.summaries[who] ?? [];
  return {
    label: "memory",
    cache: true,
    text: sums.length
      ? `# Your memory of previous days\n${sums.map((d) => `## Day ${d.day}\n${d.text}`).join("\n\n")}`
      : "# Your memory of previous days\n(This is the first day.)",
  };
}

export function beliefsText(w: World, who: string): string {
  const bs = w.char(who).beliefs;
  if (!bs.length) return "none";
  return bs
    .map(
      (b) =>
        `- ${b.text ?? w.ix.beliefs.get(b.id) ?? b.id} [${b.id}] (${b.text ? "in your own words, " : ""}confidence ${b.confidence}, from ${b.source})`,
    )
    .join("\n");
}

export function sceneText(w: World, who: string): string {
  const room = w.roomOf(who);
  if (!room) return "You are nowhere.";
  const r = describeRoom(w, room);
  const people = w
    .charsIn(room, who)
    .filter((c) => c !== who)
    .map((c) => `${w.label(c)} [${c}]${w.char(c).status !== "ok" ? ` (${w.char(c).status})` : ""}`);
  const things = w
    .scope(who)
    .filter((id) => !w.isChar(id) && !w.isWithin(id, who))
    .map((id) => `${w.thing(id)!.name} [${id}]`);
  const carried = w.inventory(who).map((id) => `${w.thing(id)!.name} [${id}]`);
  const exits = (w.ix.rooms.get(room)?.exits ?? [])
    .filter((x) => x.to)
    .map((x) => `${x.direction ?? x.label} → ${w.ix.rooms.get(x.to!)!.name} [${x.to}]`);
  return `Location: ${r.name} [${room}]. ${r.description}
Time: day ${w.state.day}, ${formatClock(w.state.clock)}.
People here: ${people.join(", ") || "nobody else"}.
Things here: ${things.join(", ") || "nothing notable"}.
You carry: ${carried.join(", ") || "nothing"}; money ${w.char(who).money}.
Exits: ${exits.join("; ") || "none"}.`;
}

export function conversationPart(w: World, conv: Conversation, allowed: readonly string[]): PromptPart {
  const hooks = conv.hooks
    .map((id) => w.ix.hooks.get(id)!)
    .filter((h) => !(h.once && w.state.hooksUsed.includes(h.id)))
    .map((h) => {
      const params = Object.entries(h.params)
        .map(
          ([k, p]) =>
            `${k}: ${p.type}${p.min !== undefined ? ` ${p.min}..${p.max}` : ""}${p.enum ? ` one of ${p.enum.join("|")}` : ""}`,
        )
        .join(", ");
      return `- ${h.id}: ${h.description}${params ? ` (args: ${params})` : ""}`;
    });
  const sp = w.state.setPiece ? w.ix.setPieces.get(w.state.setPiece.id) : undefined;
  const beat = sp && w.state.setPiece ? sp.beats[w.state.setPiece.beat] : undefined;
  return {
    label: "conversation",
    text: `# This conversation
You are talking with ${w.label(w.playerId)} [player]. The player chooses from options; you speak for your character only.
## Goals for this conversation
${conv.goals.map((g) => `- ${g}`).join("\n") || "- Be yourself."}
## Hooks you may invoke (the engine checks each one; a refused hook is reported back)
${hooks.join("\n") || "(none)"}
## Actions you may take mid-conversation
${allowed.join(", ") || "(none)"}. ${VERB_HELP}
Leaving the room ends the conversation. Attacking starts a fight.
## What you currently believe
${beliefsText(w, conv.character)}${
  sp
    ? `\n## A scene is under way\n${sp.director_brief.trim()}\nCurrent beat: ${typeof beat === "string" ? beat : `${beat?.id}: ${beat?.description}`}. Stay in the scene.`
    : ""
}`,
  };
}

/** Today's raw log for a character (§6.8): seen only on the day it happened. */
export function todayLog(w: World, who: string): string {
  const log = w.state.dayLogs[who] ?? [];
  if (!log.length) return "(nothing yet today)";
  return log.map((e) => `[${formatClock(e.at)}] (${e.kind}) ${e.text}`).join("\n");
}

export const OUTPUT_GUIDE_CONVERSATION = `Reply as JSON: {"line": what you say (in your voice; can be empty if you only act), "emotion": optional, "actions": [action requests, usually none], "hooks": [{"id", "args": [{"name","value"}]}], "playerOptions": [2-4 short things the player might say or do next; an option may carry an "action" the player would perform or a "check": {"skill","tier"} for the engine to roll], "wantsToEnd": true if you are ending the conversation}.
Keep lines short: one to three sentences.`;
