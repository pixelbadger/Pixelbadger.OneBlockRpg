import { EVENT_KINDS } from "../core/event-kinds.js";
import type { PayloadIssue } from "./issues.js";
import { type Collection, type LoadResult, loadPayload, locate, locateEntity, type Origins } from "./loader.js";
import { checkMaps } from "./maps.js";
import {
  type Condition,
  DEFAULT_CONVERSATION_ACTIONS,
  type Effect,
  type Payload,
  SCHEMA_VERSION,
  type TextVariants,
} from "./schema.js";
import { flagsRead, type Where, walkPayload } from "./walk.js";

export interface ValidationResult extends LoadResult {
  ok: boolean;
}

/** Loads and fully validates a payload: schema, references and lints (§7.7). */
export function validatePayloadAt(path: string): ValidationResult {
  const loaded = loadPayload(path);
  if (loaded.payload) loaded.issues.push(...checkPayload(loaded.payload, loaded.origins));
  return { ...loaded, ok: !loaded.issues.some((i) => i.severity === "error") };
}

const BUDGET = { persona: 1500, synopsis: 2500, director_brief: 1500, style_guide: 2500, goals: 800 };

/** Reference checks and playability, mechanics and budget lints on a schema-valid payload. */
export function checkPayload(p: Payload, origins: Origins): PayloadIssue[] {
  const issues: PayloadIssue[] = [];
  const add = (
    severity: PayloadIssue["severity"],
    where: { file: string; path: string },
    message: string,
    fix?: string,
  ) => issues.push({ severity, file: where.file, path: where.path, message, ...(fix ? { fix } : {}) });
  const ent = (c: Collection, id: string, ...sub: PropertyKey[]) => locateEntity(origins, p, c, id, sub);
  const loc = (w: Where) =>
    w.in === "game" || w.in === "story" ? locate(origins, [w.in, ...w.path]) : ent(w.in, w.id!, ...w.path);

  // ── version ──
  const [major] = p.game.schema_version.split(".");
  if (major !== SCHEMA_VERSION.split(".")[0]) {
    add(
      "error",
      locate(origins, ["game", "schema_version"]),
      `schema_version ${p.game.schema_version} is not loadable by this engine (supports ${SCHEMA_VERSION})`,
      `set schema_version: "${SCHEMA_VERSION}"`,
    );
  }

  // ── ids: global and unique ──
  const owner = new Map<string, Collection>();
  const collections: Collection[] = [
    "rooms",
    "objects",
    "characters",
    "conversations",
    "hooks",
    "behaviours",
    "callouts",
    "set_pieces",
  ];
  for (const c of collections) {
    for (const e of p[c] as { id: string }[]) {
      const prev = owner.get(e.id);
      if (prev) {
        add(
          "error",
          ent(c, e.id, "id"),
          `duplicate id '${e.id}' (already used in ${prev})`,
          "ids are global; rename one",
        );
      } else owner.set(e.id, c);
    }
  }
  const rooms = new Map(p.rooms.map((r) => [r.id, r]));
  const objects = new Map(p.objects.map((o) => [o.id, o]));
  const chars = new Map(p.characters.map((c) => [c.id, c]));
  const convs = new Map(p.conversations.map((c) => [c.id, c]));
  const hooks = new Map(p.hooks.map((h) => [h.id, h]));
  const behaviours = new Map(p.behaviours.map((b) => [b.id, b]));
  const callouts = new Map(p.callouts.map((c) => [c.id, c]));
  const setPieces = new Map(p.set_pieces.map((s) => [s.id, s]));
  const endings = new Map(p.story.endings.map((e) => [e.id, e]));
  const beats = new Set(p.set_pieces.flatMap((s) => s.beats.map((b) => (typeof b === "string" ? b : b.id))));
  const beliefCatalogue = new Set(p.story.beliefs.map((b) => b.id));
  const playerId = p.game.player.character;
  const isThing = (id: string) => objects.has(id) || chars.has(id);
  const isPlace = (id: string) => rooms.has(id) || objects.has(id) || chars.has(id);
  const isWho = (id: string) => id === "player" || id === "self" || isThing(id);
  const isCharRef = (id: string) => id === "player" || id === "self" || chars.has(id);

  // ── maps (§7.10) ──
  for (const m of checkMaps(p)) add(m.severity, ent("rooms", m.room, ...m.path), m.message, m.fix);

  // ── game ──
  if (!rooms.has(p.game.start)) {
    add("error", locate(origins, ["game", "start"]), `start room '${p.game.start}' does not exist`, "use a room id");
  }
  if (!chars.has(playerId)) {
    add(
      "error",
      locate(origins, ["game", "player", "character"]),
      `player character '${playerId}' does not exist`,
      "add the player to characters/ and name its id here",
    );
  }
  if (p.game.downed.room && !rooms.has(p.game.downed.room)) {
    add("error", locate(origins, ["game", "downed", "room"]), `room '${p.game.downed.room}' does not exist`);
  }
  if (p.game.downed.mode === "end-game") {
    if (!p.game.downed.ending) {
      add("error", locate(origins, ["game", "downed"]), "downed.mode end-game needs an ending", "set downed.ending");
    } else if (!endings.has(p.game.downed.ending)) {
      add("error", locate(origins, ["game", "downed", "ending"]), `ending '${p.game.downed.ending}' does not exist`);
    }
  }
  p.game.player.presets.forEach((pr, i) => {
    const vals = Object.values(pr.special);
    const sum = vals.reduce((a, b) => a + b, 0);
    if (vals.some((v) => v < 1 || v > 10) || sum !== 40) {
      add(
        "error",
        locate(origins, ["game", "player", "presets", i, "special"]),
        `preset '${pr.name}' must spend exactly 40 points (7×5 + 5 free) with every attribute in 1–10; it has ${sum}`,
      );
    }
  });

  // ── rooms ──
  for (const r of p.rooms) {
    r.exits.forEach((x, i) => {
      if (!x.to && !x.blocked) {
        add("error", ent("rooms", r.id, "exits", i), "exit needs `to` (a room) or `blocked` (edge-of-block text)");
      }
      if (x.to && x.blocked) {
        add("error", ent("rooms", r.id, "exits", i), "an exit cannot have both `to` and `blocked`");
      }
      if (!x.direction && !x.label) {
        add("error", ent("rooms", r.id, "exits", i), "exit needs a direction or a label");
      }
      if (x.to && !rooms.has(x.to)) {
        add(
          "error",
          ent("rooms", r.id, "exits", i, "to"),
          `room '${x.to}' does not exist`,
          "the block is closed: exits may only lead to rooms in the payload (Q6); use `blocked` for the edge",
        );
      }
      if (x.via && !objects.has(x.via)) {
        add("error", ent("rooms", r.id, "exits", i, "via"), `door object '${x.via}' does not exist`);
      }
    });
  }

  // ── objects and characters ──
  const allThings = [
    ...p.objects.map((o) => ["objects", o] as const),
    ...p.characters.map((c) => ["characters", c] as const),
  ];
  for (const [col, o] of allThings) {
    if (o.location && !isPlace(o.location)) {
      add("error", ent(col, o.id, "location"), `location '${o.location}' is not a room, object or character`);
    }
    if (o.location === o.id) add("error", ent(col, o.id, "location"), "an object cannot contain itself");
    if (o.key && !objects.has(o.key)) add("error", ent(col, o.id, "key"), `key object '${o.key}' does not exist`);
    o.behaviours.forEach((b, i) => {
      if (!behaviours.has(b)) add("error", ent(col, o.id, "behaviours", i), `behaviour '${b}' does not exist`);
    });
    o.uses.forEach((u, i) => {
      if (u.on && !u.on.startsWith("tag:") && !isThing(u.on)) {
        add("error", ent(col, o.id, "uses", i, "on"), `object '${u.on}' does not exist`, "use an id or 'tag:<tag>'");
      }
    });
    if (o.weapon && !(o.weapon.type in p.combat_text)) {
      add(
        "error",
        ent(col, o.id, "weapon", "type"),
        `weapon type '${o.weapon.type}' has no combat text`,
        `add a '${o.weapon.type}' entry (hit/miss/crit/down) to combat_text.yaml`,
      );
    }
    if (o.weapon && o.weapon.damage[0] > o.weapon.damage[1]) {
      add("error", ent(col, o.id, "weapon", "damage"), "damage min is greater than max");
    }
    if (o.weapon && p.characters.every((c) => c.special.ST < o.weapon!.min_st)) {
      add(
        "warning",
        ent(col, o.id, "weapon", "min_st"),
        `no character has ST ≥ ${o.weapon.min_st}; this weapon is only usable at a penalty`,
      );
    }
  }
  // Location cycles.
  for (const [col, o] of allThings) {
    const seen = new Set<string>([o.id]);
    let cur = o.location;
    while (cur && !rooms.has(cur)) {
      if (seen.has(cur)) {
        add("error", ent(col, o.id, "location"), "location forms a containment cycle");
        break;
      }
      seen.add(cur);
      cur = objects.get(cur)?.location ?? chars.get(cur)?.location;
    }
  }
  if (!p.combat_text.unarmed) {
    add(
      "error",
      { file: origins.combat_text, path: "" },
      "combat_text needs an 'unarmed' entry: every character can fight unarmed",
      "add unarmed: { hit, miss, crit, down }",
    );
  }

  // Off-stage characters that some spawn or move effect brings on.
  const staged = new Set([...JSON.stringify(p).matchAll(/"(?:spawn|move)":\{"object":"([^"]+)"/g)].map((m) => m[1]!));
  for (const c of p.characters) {
    for (const k of Object.keys(c.special) as (keyof typeof c.special)[]) {
      if (c.special[k] < 1 || c.special[k] > 10) {
        add("error", ent("characters", c.id, "special", k), `${k} ${c.special[k]} is outside 1–10`);
      }
    }
    if (new Set(c.tag_skills).size !== c.tag_skills.length) {
      add("error", ent("characters", c.id, "tag_skills"), "tag skills must be distinct");
    }
    for (const rel of Object.keys(c.relationships)) {
      if (rel !== "player" && !chars.has(rel)) {
        add("error", ent("characters", c.id, "relationships", rel), `character '${rel}' does not exist`);
      }
    }
    for (const slot of ["weapon", "armour"] as const) {
      const id = c.equipment[slot];
      if (!id) continue;
      const item = objects.get(id);
      if (!item) add("error", ent("characters", c.id, "equipment", slot), `object '${id}' does not exist`);
      else if (!item[slot]) add("error", ent("characters", c.id, "equipment", slot), `'${id}' is not a ${slot}`);
      else if (item.location !== c.id) {
        add("error", ent("characters", c.id, "equipment", slot), `'${id}' must be located on ${c.id} to be equipped`);
      }
    }
    if (c.combat_profile.preferred_weapon && !objects.has(c.combat_profile.preferred_weapon)) {
      add("error", ent("characters", c.id, "combat_profile", "preferred_weapon"), "object does not exist");
    }
    const personaSize = JSON.stringify(c.persona).length;
    if (personaSize > BUDGET.persona) {
      add(
        "warning",
        ent("characters", c.id, "persona"),
        `persona is ${personaSize} chars (budget ${BUDGET.persona}); it is in every prompt for this character`,
        "tighten it",
      );
    }
    if (c.goals.join(" ").length > BUDGET.goals) {
      add("warning", ent("characters", c.id, "goals"), `goals exceed ${BUDGET.goals} chars`);
    }
    if (c.id !== playerId && !c.location && !staged.has(c.id)) {
      add("warning", ent("characters", c.id, "location"), "character starts off-stage; make sure something spawns it");
    }
    for (const b of c.beliefs) {
      const id = typeof b === "string" ? b : b.belief;
      if (beliefCatalogue.size > 0 && !beliefCatalogue.has(id)) {
        add("warning", ent("characters", c.id, "beliefs"), `belief '${id}' is not in story.beliefs`);
      }
    }
  }

  // ── conversations ──
  for (const c of p.conversations) {
    const ch = chars.get(c.character);
    if (!ch) add("error", ent("conversations", c.id, "character"), `character '${c.character}' does not exist`);
    else if (c.character === playerId) {
      add("error", ent("conversations", c.id, "character"), "the player cannot be a conversation partner");
    }
    c.hooks.forEach((h, i) => {
      if (!hooks.has(h)) {
        add("error", ent("conversations", c.id, "hooks", i), `hook '${h}' does not exist`, "add it to hooks.yaml");
      }
    });
    if (c.actions?.includes("attack")) {
      add(
        "warning",
        ent("conversations", c.id, "actions"),
        "grants attack: the character can start combat mid-conversation (flagged for review)",
      );
    }
    for (const a of c.actions ?? DEFAULT_CONVERSATION_ACTIONS) {
      if (["talk", "sleep", "look"].includes(a)) {
        add("warning", ent("conversations", c.id, "actions"), `action '${a}' makes no sense mid-conversation`);
      }
    }
  }

  // ── set pieces ──
  for (const sp of p.set_pieces) {
    sp.stage.forEach((r, i) => {
      if (!rooms.has(r)) add("error", ent("set_pieces", sp.id, "stage", i), `stage room '${r}' does not exist`);
    });
    sp.cast.forEach((c, i) => {
      if (!chars.has(c)) add("error", ent("set_pieces", sp.id, "cast", i), `cast member '${c}' does not exist`);
    });
    sp.moves.hooks.forEach((h, i) => {
      if (!hooks.has(h)) add("error", ent("set_pieces", sp.id, "moves", "hooks", i), `hook '${h}' does not exist`);
    });
    if (sp.director_brief.length > BUDGET.director_brief) {
      add(
        "warning",
        ent("set_pieces", sp.id, "director_brief"),
        `director brief exceeds ${BUDGET.director_brief} chars`,
      );
    }
  }

  // ── behaviours: whose? ──
  const behaviourOwners = new Map<string, string[]>();
  for (const [, o] of allThings) {
    for (const b of o.behaviours) behaviourOwners.set(b, [...(behaviourOwners.get(b) ?? []), o.id]);
  }

  // ── expressions: references, flags, variants ──
  const flagsSet = new Set<string>();
  const flagReads: { flag: string; where: Where }[] = [];
  const endGames = new Set<string>();
  const startedSetPieces = new Set<string>();
  const ref = (ok: boolean, w: Where, msg: string, fix?: string) => {
    if (!ok) add("error", loc(w), msg, fix);
  };
  const checkWho = (id: string | undefined, w: Where, field: string, mustBeChar = false) => {
    if (id === undefined) return;
    if (mustBeChar ? !isCharRef(id) : !isWho(id)) {
      ref(false, { ...w, path: [...w.path, field] }, `'${id}' is not ${mustBeChar ? "a character" : "an object"} id`);
    }
    if (id === "self" && w.in !== "behaviours" && w.in !== "conversations" && w.in !== "hooks") {
      if (w.in !== "objects" && w.in !== "characters") {
        add("warning", loc(w), "'self' has no meaning here; name the character explicitly");
      }
    }
  };

  walkPayload(p, {
    text(t: TextVariants, w) {
      if (Array.isArray(t) && t[t.length - 1]?.when !== undefined) {
        add(
          "error",
          loc(w),
          "text variant list has no unconditional fallback",
          "make the last variant a plain { text: ... } with no `when`",
        );
      }
    },
    condition(c: Condition, w) {
      if ("flag" in c) flagReads.push({ flag: c.flag, where: w });
      if ("flag_eq" in c) flagReads.push({ flag: c.flag_eq.flag, where: w });
      if ("in_room" in c) {
        checkWho(c.in_room.who, w, "in_room.who");
        ref(rooms.has(c.in_room.where), w, `room '${c.in_room.where}' does not exist`);
      }
      if ("holds" in c) {
        checkWho(c.holds.who, w, "holds.who", true);
        ref(isThing(c.holds.what), w, `object '${c.holds.what}' does not exist`);
      }
      if ("property" in c) checkWho(c.property.object, w, "property.object");
      if ("special" in c) checkWho(c.special.who, w, "special.who", true);
      if ("skill" in c) checkWho(c.skill.who, w, "skill.who", true);
      if ("relationship" in c) {
        checkWho(c.relationship.who, w, "relationship.who", true);
        checkWho(c.relationship.with, w, "relationship.with", true);
      }
      if ("believes" in c) {
        checkWho(c.believes.who, w, "believes.who", true);
        if (beliefCatalogue.size > 0 && !beliefCatalogue.has(c.believes.belief)) {
          add("warning", loc(w), `belief '${c.believes.belief}' is not in story.beliefs`);
        }
      }
      if ("event" in c) {
        const kind = typeof c.event === "string" ? c.event : c.event.kind;
        if (!(EVENT_KINDS as readonly string[]).includes(kind)) {
          add("warning", loc(w), `unknown event kind '${kind}'`, `one of: ${EVENT_KINDS.join(", ")}`);
        }
        const ev = typeof c.event === "string" ? { actor: c.actor, target: c.target } : c.event;
        if (ev.actor) checkWho(ev.actor, w, "actor");
        if (ev.target && !isPlace(ev.target) && !isWho(ev.target)) {
          ref(false, w, `event target '${ev.target}' does not exist`);
        }
      }
      for (const k of ["hp", "level", "money"] as const) {
        if (k in c) checkWho((c as Record<string, { who?: string }>)[k]!.who, w, `${k}.who`, true);
      }
      if ("in_combat" in c && typeof c.in_combat === "string") checkWho(c.in_combat, w, "in_combat", true);
      if ("in_set_piece" in c && typeof c.in_set_piece === "string") {
        ref(setPieces.has(c.in_set_piece), w, `set piece '${c.in_set_piece}' does not exist`);
      }
      if ("beat" in c) ref(beats.has(c.beat), w, `beat '${c.beat}' is not declared by any set piece`);
      for (const k of ["asleep", "down", "dead"] as const) {
        if (k in c) checkWho((c as Record<string, string>)[k], w, k, true);
      }
      if ("visited" in c) ref(rooms.has(c.visited), w, `room '${c.visited}' does not exist`);
      if ("turns" in c && w.in !== "conversations") {
        add("warning", loc(w), "`turns` only has meaning inside a conversation");
      }
    },
    effect(e: Effect, w) {
      if ("set_flag" in e) flagsSet.add(typeof e.set_flag === "string" ? e.set_flag : e.set_flag.flag);
      if ("set_property" in e) checkWho(e.set_property.object, w, "set_property.object");
      if ("move" in e) {
        checkWho(e.move.object, w, "move.object");
        ref(isPlace(e.move.to) || e.move.to === "player", w, `destination '${e.move.to}' does not exist`);
      }
      if ("spawn" in e) {
        ref(isThing(e.spawn.object), w, `object '${e.spawn.object}' does not exist`);
        ref(isPlace(e.spawn.in) || e.spawn.in === "player", w, `destination '${e.spawn.in}' does not exist`);
      }
      if ("remove" in e) checkWho(e.remove, w, "remove");
      if ("act" in e) {
        checkWho(e.actor, w, "actor", true);
        if (!e.actor && (w.in === "story" || w.in === "game" || w.in === "set_pieces")) {
          add("error", loc(w), "`act` needs an `actor` here", "add actor: <character id>");
        }
        for (const k of ["item", "target", "from", "on", "weapon"] as const) {
          const v = e[k];
          if (v && !isWho(v) && !rooms.has(v)) ref(false, w, `${k} '${v}' does not exist`);
        }
        if (e.to && !isPlace(e.to) && e.to !== "player") ref(false, w, `to '${e.to}' does not exist`);
      }
      if ("say" in e && typeof e.say !== "string") checkWho(e.say.who, w, "say.who", true);
      if ("set_intent" in e && e.set_intent && typeof e.set_intent === "object") {
        checkWho(e.set_intent.who, w, "set_intent.who", true);
      }
      for (const k of ["start_behaviour", "stop_behaviour"] as const) {
        if (k in e) {
          const v = (e as Record<string, string | { who?: string; behaviour: string }>)[k]!;
          const b = typeof v === "string" ? v : v.behaviour;
          ref(behaviours.has(b), w, `behaviour '${b}' does not exist`);
          if (typeof v !== "string") checkWho(v.who, w, `${k}.who`);
        }
      }
      if ("adjust_relationship" in e) {
        checkWho(e.adjust_relationship.who, w, "adjust_relationship.who", true);
        checkWho(e.adjust_relationship.with, w, "adjust_relationship.with", true);
      }
      if ("add_belief" in e) {
        checkWho(e.add_belief.who, w, "add_belief.who", true);
        if (beliefCatalogue.size > 0 && !beliefCatalogue.has(e.add_belief.belief)) {
          add("warning", loc(w), `belief '${e.add_belief.belief}' is not in story.beliefs`);
        }
      }
      if ("remove_belief" in e) checkWho(e.remove_belief.who, w, "remove_belief.who", true);
      if ("start_conversation" in e) {
        ref(convs.has(e.start_conversation), w, `conversation '${e.start_conversation}' does not exist`);
      }
      if ("check" in e) {
        checkWho(e.check.who, w, "check.who", true);
        checkWho(e.check.opposed, w, "check.opposed", true);
        if (!e.check.skill === !e.check.attribute) {
          add("error", loc(w), "a check needs exactly one of `skill` or `attribute`");
        }
      }
      for (const k of ["heal", "damage", "give_money", "modify"] as const) {
        if (k in e) checkWho((e as Record<string, { who?: string }>)[k]!.who, w, `${k}.who`, true);
      }
      if ("modify" in e && !e.modify.attribute === !e.modify.skill) {
        add("error", loc(w), "modify needs exactly one of `attribute` or `skill`");
      }
      if ("award_xp" in e && typeof e.award_xp === "object" && "amount" in e.award_xp) {
        checkWho(e.award_xp.who, w, "award_xp.who", true);
      }
      if ("set_hostile" in e) {
        checkWho(typeof e.set_hostile === "string" ? e.set_hostile : e.set_hostile.who, w, "set_hostile", true);
      }
      if ("set_combat_profile" in e) checkWho(e.set_combat_profile.who, w, "set_combat_profile.who", true);
      if ("start_set_piece" in e) {
        ref(setPieces.has(e.start_set_piece), w, `set piece '${e.start_set_piece}' does not exist`);
        startedSetPieces.add(e.start_set_piece);
      }
      if ("advance_beat" in e && typeof e.advance_beat === "string") {
        ref(beats.has(e.advance_beat), w, `beat '${e.advance_beat}' is not declared by any set piece`);
      }
      if ("end_set_piece" in e && typeof e.end_set_piece === "string") {
        ref(setPieces.has(e.end_set_piece), w, `set piece '${e.end_set_piece}' does not exist`);
      }
      if ("callout" in e) ref(callouts.has(e.callout), w, `callout '${e.callout}' does not exist`);
      if ("end_game" in e) {
        ref(endings.has(e.end_game), w, `ending '${e.end_game}' does not exist`);
        endGames.add(e.end_game);
      }
    },
  });

  // Hook params referenced by $arg exist.
  for (const h of p.hooks) {
    const used = JSON.stringify(h.effects).match(/"\$arg":"([^"]+)"/g) ?? [];
    for (const m of used) {
      const name = m.slice(8, -1);
      if (!(name in h.params)) {
        add("error", ent("hooks", h.id, "effects"), `$arg '${name}' is not declared in params`, "declare it in params");
      }
    }
  }

  // Flags read but never set. Triggers and set-piece end conditions are errors; elsewhere a warning.
  for (const { flag, where } of flagReads) {
    if (flagsSet.has(flag)) continue;
    const critical = where.in === "story" || where.in === "set_pieces";
    add(
      critical ? "error" : "warning",
      loc(where),
      `flag '${flag}' is read but never set by any effect`,
      "add a set_flag somewhere (trigger, hook, option or behaviour), or fix the name",
    );
  }

  // Set pieces need a way to start and an end condition that can hold.
  for (const sp of p.set_pieces) {
    if (!sp.starts_when && !startedSetPieces.has(sp.id)) {
      add("warning", ent("set_pieces", sp.id), "set piece has no starts_when and nothing starts it");
    }
    const endFlags = flagsRead(sp.ends_when);
    const hasTimeOrOther = JSON.stringify(sp.ends_when).match(/"(time|time_after|time_before|day|beat|dead|down)"/);
    if (endFlags.length > 0 && !endFlags.some((f) => flagsSet.has(f)) && !hasTimeOrOther) {
      add("error", ent("set_pieces", sp.id, "ends_when"), "end condition can never hold: none of its flags is set");
    }
  }

  // At least one ending reachable.
  const reachableEnding = p.story.endings.some((e) => {
    if (endGames.has(e.id) || p.game.downed.ending === e.id) return true;
    if (!e.when) return false;
    const fs = flagsRead(e.when);
    return fs.length === 0 || fs.some((f) => flagsSet.has(f));
  });
  if (!reachableEnding) {
    add(
      "error",
      locate(origins, ["story", "endings"]),
      "no ending is reachable: none has a satisfiable `when` and no end_game effect names one",
    );
  }

  // Every room reachable from the start room.
  if (rooms.has(p.game.start)) {
    const seen = new Set([p.game.start]);
    const queue = [p.game.start];
    while (queue.length) {
      const r = rooms.get(queue.shift()!)!;
      for (const x of r.exits) {
        if (x.to && rooms.has(x.to) && !seen.has(x.to)) {
          seen.add(x.to);
          queue.push(x.to);
        }
      }
    }
    for (const r of p.rooms) {
      if (!seen.has(r.id)) {
        add("error", ent("rooms", r.id), `room is unreachable from the start room '${p.game.start}'`, "add an exit");
      }
    }
  }

  // Sleep: every character can reach something sleepable or has sleep in their schedule (§7.7 mechanics lint).
  const sleepableRooms = new Set<string>();
  for (const o of p.objects) {
    if (o.affordances.includes("sleepable") && o.location) {
      let cur: string | null | undefined = o.location;
      while (cur && !rooms.has(cur)) cur = objects.get(cur)?.location;
      if (cur) sleepableRooms.add(cur);
    }
  }
  for (const c of p.characters) {
    if (c.perceived_by === "player") continue;
    const sleepsInSchedule = c.behaviours.some((b) =>
      JSON.stringify(behaviours.get(b) ?? {}).includes('"act":"sleep"'),
    );
    if (sleepsInSchedule) continue;
    const startRoom = c.location && rooms.has(c.location) ? c.location : undefined;
    if (!startRoom) continue;
    const seen = new Set([startRoom]);
    const queue = [startRoom];
    let found = sleepableRooms.has(startRoom);
    while (queue.length && !found) {
      for (const x of rooms.get(queue.shift()!)!.exits) {
        if (x.to && rooms.has(x.to) && !seen.has(x.to)) {
          if (sleepableRooms.has(x.to)) found = true;
          seen.add(x.to);
          queue.push(x.to);
        }
      }
    }
    if (!found) {
      add(
        "warning",
        ent("characters", c.id),
        "cannot reach anything sleepable and has no sleep in its schedule",
        "add a sleepable object (affordance 'sleepable') or a behaviour rule with { act: sleep }",
      );
    }
  }

  // Budgets.
  if (p.story.synopsis.length > BUDGET.synopsis) {
    add("warning", locate(origins, ["story", "synopsis"]), `synopsis exceeds ${BUDGET.synopsis} chars`);
  }
  if (p.game.style_guide.length > BUDGET.style_guide) {
    add("warning", locate(origins, ["game", "style_guide"]), `style guide exceeds ${BUDGET.style_guide} chars`);
  }

  // Behaviours nobody runs.
  for (const b of p.behaviours) {
    const startedByEffect =
      JSON.stringify(p).includes(`"behaviour":"${b.id}"`) || JSON.stringify(p).includes(`_behaviour":"${b.id}"`);
    if (!behaviourOwners.has(b.id) && !startedByEffect) {
      add("warning", ent("behaviours", b.id), "behaviour is not attached to any object or character");
    }
  }

  // Unused callouts.
  for (const c of p.callouts) {
    if (!JSON.stringify(p).includes(`"callout":"${c.id}"`)) {
      add("warning", ent("callouts", c.id), "callout is never fired by any effect");
    }
  }
  return issues;
}
