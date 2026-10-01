/**
 * The verb–noun parser (§3.2, Q19). It turns typed commands into the same Intents the menu produces.
 * Nouns resolve against what the player can perceive: names, aliases and ids.
 */
import type { CombatIntent } from "../core/combat.js";
import type { World } from "../core/world.js";
import { SKILLS } from "../payload/schema.js";
import type { Intent } from "./port.js";

export type ParseResult = { ok: true; intent: Intent } | { ok: false; error: string };

const DIRECTIONS: Record<string, string> = {
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  u: "up",
  d: "down",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
};

const ARTICLES = /^(the|a|an|some|my|your)\s+/i;

const clean = (s: string) => s.trim().toLowerCase().replace(ARTICLES, "").trim();

/** Candidate names for an entity: id, name (without article), aliases. */
function namesOf(w: World, id: string): string[] {
  const def = w.thing(id);
  if (!def) return [id];
  return [id, def.name.toLowerCase().replace(ARTICLES, ""), ...def.aliases.map((a) => a.toLowerCase())];
}

/** Resolves a noun phrase to an id among candidates. Exact name/alias wins; then unique partial match. */
export function resolveNoun(w: World, phrase: string, candidates: readonly string[]): { id?: string; error?: string } {
  const p = clean(phrase);
  if (!p) return { error: "What?" };
  if (["me", "myself", "self"].includes(p)) return { id: w.playerId };
  const exact = candidates.filter((id) => namesOf(w, id).includes(p));
  if (exact.length === 1) return { id: exact[0]! };
  const partial = (exact.length ? exact : candidates).filter((id) =>
    namesOf(w, id).some((n) => n.includes(p) || p.split(/\s+/).every((word) => n.split(/\s+/).includes(word))),
  );
  if (partial.length === 1) return { id: partial[0]! };
  if (partial.length > 1) {
    // Prefer something held, then something in the room.
    const held = partial.filter((id) => w.isWithin(id, w.playerId));
    if (held.length === 1) return { id: held[0]! };
    return { error: `Which do you mean: ${partial.map((id) => w.name(id)).join(", ")}?` };
  }
  return { error: `You don't see any "${phrase.trim()}" here.` };
}

/** Everything the player can refer to: their scope, plus doors on exits from their room. */
export function nounScope(w: World): string[] {
  const room = w.roomOf(w.playerId);
  const doors = room
    ? (w.ix.rooms
        .get(room)
        ?.exits.map((x) => x.via)
        .filter((x): x is string => !!x) ?? [])
    : [];
  return [...new Set([...w.scope(w.playerId), ...doors])];
}

function split(rest: string, words: string[]): [string, string] | null {
  for (const word of words) {
    const re = new RegExp(`^(.*?)\\s+${word}\\s+(.*)$`, "i");
    const m = rest.match(re);
    if (m) return [m[1]!, m[2]!];
  }
  return null;
}

export function parseCommand(w: World, input: string): ParseResult {
  const text = input.trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, error: "Say again?" };
  const lower = text.toLowerCase();
  const [verbRaw, ...restWords] = lower.split(" ");
  const verb = verbRaw!;
  const rest = restWords.join(" ");
  const scope = nounScope(w);
  const noun = (phrase: string, cands: readonly string[] = scope) => resolveNoun(w, phrase, cands);
  const ok = (intent: Intent): ParseResult => ({ ok: true, intent });
  const err = (error: string): ParseResult => ({ ok: false, error });
  const act = (action: Intent & { type: "action" }) => ok(action);

  // Meta commands.
  if (["l", "look"].includes(lower)) return ok({ type: "meta", command: "look" });
  if (["i", "inv", "inventory"].includes(lower)) return ok({ type: "meta", command: "inventory" });
  if (["status", "stats", "sheet", "char", "character"].includes(lower)) return ok({ type: "meta", command: "status" });
  if (["journal", "j", "diary"].includes(lower)) return ok({ type: "meta", command: "journal" });
  if (["menu", "m", "actions", "?"].includes(lower)) return ok({ type: "meta", command: "menu" });
  if (["help", "h"].includes(lower)) return ok({ type: "meta", command: "help" });
  if (verb === "improve" || verb === "train") return ok({ type: "meta", command: "improve", arg: rest });

  // Movement.
  const dirWord = DIRECTIONS[lower] ?? lower;
  const room = w.roomOf(w.playerId);
  const exits = room ? (w.ix.rooms.get(room)?.exits ?? []) : [];
  const exitMatch = (token: string) =>
    exits.find(
      (x) =>
        x.direction?.toLowerCase() === token ||
        x.label?.toLowerCase() === token ||
        (x.to && w.ix.rooms.get(x.to)?.name.toLowerCase() === token),
    );
  if (exitMatch(dirWord)) {
    const x = exitMatch(dirWord)!;
    return act({ type: "action", action: { act: "go", direction: x.direction ?? x.label! } });
  }
  if (["go", "walk", "run", "climb", "enter"].includes(verb)) {
    const token = DIRECTIONS[clean(rest)] ?? clean(rest.replace(/^(to|into|through)\s+/, ""));
    const x = exitMatch(token);
    if (!x) return err("You can't go that way.");
    return act({ type: "action", action: { act: "go", direction: x.direction ?? x.label! } });
  }

  switch (verb) {
    case "x":
    case "examine":
    case "inspect":
    case "read":
    case "check": {
      const r = noun(rest.replace(/^at\s+/, ""), [...scope, w.playerId]);
      return r.id ? act({ type: "action", action: { act: "examine", target: r.id } }) : err(r.error!);
    }
    case "take":
    case "get":
    case "grab":
    case "pick": {
      const phrase = rest.replace(/^up\s+/, "");
      const parts = split(phrase, ["from", "off", "out of"]);
      if (parts) {
        const from = noun(parts[1]);
        if (!from.id) return err(from.error!);
        const cands = w.isChar(from.id) ? w.inventory(from.id) : w.childrenOf(from.id);
        const it = noun(parts[0], cands);
        if (!it.id) return err(it.error!);
        return act({ type: "action", action: { act: "take", item: it.id, from: from.id } });
      }
      const it = noun(phrase);
      return it.id ? act({ type: "action", action: { act: "take", item: it.id } }) : err(it.error!);
    }
    case "drop": {
      const it = noun(rest, w.inventory(w.playerId));
      return it.id ? act({ type: "action", action: { act: "drop", item: it.id } }) : err(it.error!);
    }
    case "put":
    case "place": {
      const parts = split(rest, ["in", "into", "on", "onto", "inside"]);
      if (!parts) return err("Put it where?");
      const it = noun(parts[0], w.inventory(w.playerId));
      const c = noun(parts[1]);
      if (!it.id) return err(it.error!);
      if (!c.id) return err(c.error!);
      return act({ type: "action", action: { act: "put", item: it.id, on: c.id } });
    }
    case "open":
    case "close":
    case "shut":
    case "lock":
    case "unlock": {
      const v = verb === "shut" ? "close" : verb;
      const it = noun(rest.replace(/\s+with\s+.*$/, ""));
      return it.id ? act({ type: "action", action: { act: v as "open", target: it.id } }) : err(it.error!);
    }
    case "use":
    case "apply":
    case "drink":
    case "eat":
    case "turn":
    case "switch":
    case "flick": {
      const parts = split(rest, ["on", "with", "at"]);
      const it = noun(parts ? parts[0] : rest.replace(/^(on|off)\s+/, ""));
      if (!it.id) return err(it.error!);
      if (parts) {
        const on = noun(parts[1], [...scope, w.playerId]);
        if (!on.id) return err(on.error!);
        return act({ type: "action", action: { act: "use", item: it.id, on: on.id } });
      }
      return act({ type: "action", action: { act: "use", item: it.id } });
    }
    case "throw":
    case "toss":
    case "hurl": {
      const parts = split(rest, ["at", "to", "into"]);
      const it = noun(parts ? parts[0] : rest, w.inventory(w.playerId));
      if (!it.id) return err(it.error!);
      if (parts) {
        const t = noun(parts[1]);
        if (!t.id) return err(t.error!);
        return act({ type: "action", action: { act: "throw", item: it.id, target: t.id } });
      }
      return act({ type: "action", action: { act: "throw", item: it.id } });
    }
    case "push":
    case "shove":
    case "move":
    case "pull": {
      const words = rest.split(" ");
      const last = DIRECTIONS[words[words.length - 1]!] ?? words[words.length - 1]!;
      const dir = words.length > 1 && exitMatch(last) ? last : undefined;
      const it = noun(dir ? words.slice(0, -1).join(" ") : rest);
      if (!it.id) return err(it.error!);
      return act({ type: "action", action: { act: "push", target: it.id, ...(dir ? { direction: dir } : {}) } });
    }
    case "give":
    case "hand":
    case "offer":
    case "show": {
      const v = verb === "show" ? "show" : "give";
      const parts = split(rest, ["to"]);
      if (!parts) return err(`${v === "show" ? "Show" : "Give"} it to whom?`);
      const it = noun(parts[0], w.inventory(w.playerId));
      const to = noun(parts[1]);
      if (!it.id) return err(it.error!);
      if (!to.id) return err(to.error!);
      return act({ type: "action", action: { act: v, item: it.id, to: to.id } });
    }
    case "steal":
    case "pickpocket":
    case "lift": {
      const parts = split(rest, ["from", "off"]);
      if (!parts) return err("Steal it from whom?");
      const from = noun(parts[1]);
      if (!from.id) return err(from.error!);
      const it = noun(parts[0], w.isChar(from.id) ? w.inventory(from.id) : []);
      if (!it.id) return err(it.error!);
      return act({ type: "action", action: { act: "steal", item: it.id, from: from.id } });
    }
    case "buy":
    case "sell": {
      const parts = split(rest, verb === "buy" ? ["from"] : ["to"]);
      const other = parts
        ? noun(parts[1])
        : { id: w.charsIn(room ?? "").find((c) => c !== w.playerId && w.charDef(c).merchant) };
      if (!other.id) return err("buy" === verb ? "Buy it from whom?" : "Sell it to whom?");
      const cands = verb === "buy" ? w.inventory(other.id) : w.inventory(w.playerId);
      const it = noun(parts ? parts[0] : rest, cands);
      if (!it.id) return err(it.error!);
      return act({
        type: "action",
        action:
          verb === "buy" ? { act: "buy", item: it.id, from: other.id } : { act: "sell", item: it.id, to: other.id },
      });
    }
    case "equip":
    case "wield":
    case "wear":
    case "ready":
    case "unequip":
    case "remove": {
      const v = verb === "unequip" || verb === "remove" ? "unequip" : "equip";
      const it = noun(rest, w.inventory(w.playerId));
      return it.id ? act({ type: "action", action: { act: v, item: it.id } }) : err(it.error!);
    }
    case "attack":
    case "hit":
    case "punch":
    case "kill":
    case "fight":
    case "stab": {
      const parts = split(rest, ["with"]);
      const t = noun(parts ? parts[0] : rest);
      if (!t.id) return err(t.error!);
      if (parts) {
        const wpn = noun(parts[1], w.inventory(w.playerId));
        if (!wpn.id) return err(wpn.error!);
        return act({ type: "action", action: { act: "attack", target: t.id, weapon: wpn.id } });
      }
      return act({ type: "action", action: { act: "attack", target: t.id } });
    }
    case "sleep":
    case "rest":
    case "nap": {
      const phrase = rest.replace(/^(on|in)\s+/, "");
      if (!phrase) return act({ type: "action", action: { act: "sleep" } });
      const t = noun(phrase);
      return t.id ? act({ type: "action", action: { act: "sleep", target: t.id } }) : err(t.error!);
    }
    case "talk":
    case "speak":
    case "chat":
    case "ask": {
      const t = noun(rest.replace(/^(to|with)\s+/, "").replace(/\s+about\s+.*$/, ""));
      return t.id ? act({ type: "action", action: { act: "talk", target: t.id } }) : err(t.error!);
    }
    case "wait":
    case "z": {
      const until = rest.match(/^until\s+(\d{1,2}):(\d{2})$/);
      if (until) {
        const target = Number(until[1]) * 60 + Number(until[2]);
        const now = w.state.clock % 1440;
        const minutes = (target - now + 1440) % 1440 || 1440;
        return act({ type: "action", action: { act: "wait", minutes } });
      }
      const n = Number.parseInt(rest, 10);
      return act({ type: "action", action: { act: "wait", ...(Number.isFinite(n) && n > 0 ? { minutes: n } : {}) } });
    }
  }
  return err(`I don't know how to "${verb}". Type "help" or "menu".`);
}

/** Combat commands: attack X, flee <dir>, use X, equip X, reload, end. */
export function parseCombat(w: World, input: string, targets: readonly string[]): ParseResult {
  const lower = input.trim().toLowerCase();
  const [verb, ...restW] = lower.split(/\s+/);
  const rest = restW.join(" ");
  const ok = (intent: CombatIntent): ParseResult => ({ ok: true, intent: { type: "combat", intent } });
  switch (verb) {
    case "attack":
    case "hit":
    case "a":
    case "punch":
    case "stab":
    case "shoot":
    case "aim": {
      const phrase = rest.replace(/^at\s+/, "");
      const t = phrase
        ? resolveNoun(w, phrase, targets)
        : targets.length === 1
          ? { id: targets[0]! }
          : { error: "Attack whom?" };
      return t.id ? ok({ kind: "attack", target: t.id, aimed: verb === "aim" }) : { ok: false, error: t.error! };
    }
    case "flee":
    case "run":
    case "leave":
    case "go": {
      const dir = DIRECTIONS[rest] ?? rest;
      return dir ? ok({ kind: "flee", direction: dir }) : { ok: false, error: "Flee which way?" };
    }
    case "use": {
      const it = resolveNoun(w, rest, w.inventory(w.playerId));
      return it.id ? ok({ kind: "use", item: it.id }) : { ok: false, error: it.error! };
    }
    case "equip":
    case "wield": {
      const it = resolveNoun(w, rest, w.inventory(w.playerId));
      return it.id ? ok({ kind: "equip", item: it.id }) : { ok: false, error: it.error! };
    }
    case "reload":
      return ok({ kind: "reload" });
    case "end":
    case "pass":
    case "wait":
    case "done":
      return ok({ kind: "end" });
  }
  return {
    ok: false,
    error: "In combat: attack <target>, aim <target>, use <item>, equip <item>, reload, flee <direction>, end.",
  };
}

export function parseSkill(phrase: string): string | undefined {
  const p = phrase.trim().toLowerCase().replace(/\s+/g, "_");
  return SKILLS.find((s) => s === p || s.startsWith(p));
}
