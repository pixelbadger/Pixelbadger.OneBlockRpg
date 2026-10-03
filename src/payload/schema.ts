/**
 * Game payload schema (spec §7). The zod types here are the single source of truth: the loader validates against them,
 * the published JSON Schema is generated from them, and the engine reads the inferred types.
 *
 * Payload keys are snake_case, matching the YAML examples in the spec.
 */
import { z } from "zod";

// ─── Shared vocabulary ────────────────────────────────────────────────────────

export const ATTRIBUTES = ["ST", "PE", "EN", "CH", "IN", "AG", "LK"] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

/** Core skill set (§5.3). */
export const SKILLS = [
  "small_guns",
  "melee_weapons",
  "unarmed",
  "throwing",
  "first_aid",
  "doctor",
  "speech",
  "barter",
  "gambling",
  "sneak",
  "lockpick",
  "steal",
  "traps",
  "science",
  "repair",
] as const;
export type SkillId = (typeof SKILLS)[number];

export const TIERS = ["trivial", "easy", "normal", "hard", "very_hard", "heroic"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * The shared action vocabulary (§4.3). `buy`/`sell` are the two halves of trade; `examine`/`look` are free perception;
 * `sneak` enters the sneaking stance (`stop: true` leaves it; with a direction it also moves).
 */
export const ACTION_VERBS = [
  "go",
  "step",
  "take",
  "drop",
  "put",
  "open",
  "close",
  "lock",
  "unlock",
  "use",
  "throw",
  "push",
  "give",
  "show",
  "steal",
  "buy",
  "sell",
  "equip",
  "unequip",
  "attack",
  "sleep",
  "talk",
  "wait",
  "examine",
  "look",
  "sneak",
] as const;
export type ActionVerb = (typeof ACTION_VERBS)[number];

const Id = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "ids are lower-case kebab/snake case, e.g. 'flat-2b'");
const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "times are 24h 'HH:MM'");
export const Scalar = z.union([z.string(), z.number(), z.boolean()]);
export type Scalar = z.infer<typeof Scalar>;

export const Comparison = z.union([
  z.number(),
  z
    .strictObject({
      eq: z.number().optional(),
      ne: z.number().optional(),
      gt: z.number().optional(),
      gte: z.number().optional(),
      lt: z.number().optional(),
      lte: z.number().optional(),
    })
    .refine((o) => Object.keys(o).length > 0, "a comparison needs at least one of eq/ne/gt/gte/lt/lte"),
]);
export type Comparison = z.infer<typeof Comparison>;

const cmpFields = {
  eq: z.number().optional(),
  ne: z.number().optional(),
  gt: z.number().optional(),
  gte: z.number().optional(),
  lt: z.number().optional(),
  lte: z.number().optional(),
};

/** `who` references accept an object id, `player`, or `self` (the acting/owning character in context). */
const Who = z.string().min(1);

// ─── Conditions (§7.5) ────────────────────────────────────────────────────────

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { flag: string }
  | { flag_eq: { flag: string; value: Scalar } }
  | { time: string }
  | { time_between: { from: string; to: string } }
  | { time_after: string }
  | { time_before: string }
  | { day: Comparison }
  | { in_room: { who: string; where: string } }
  | { same_room: { who: string; with: string } }
  | { holds: { who: string; what: string } }
  | { property: { object: string; key: string; op?: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: Scalar } }
  | { special: { who?: string } & Partial<Record<Attribute, Comparison>> }
  | { skill: { who?: string; skill: SkillId } & CmpFields }
  | { relationship: { who: string; with: string; trust?: Comparison; affinity?: Comparison } }
  | { believes: { who: string; belief: string } }
  | { event: string | { kind: string; actor?: string; target?: string }; actor?: string; target?: string }
  | { turns: Comparison }
  | { hp: { who?: string } & CmpFields }
  | { level: { who?: string } & CmpFields }
  | { money: { who?: string } & CmpFields }
  | { in_combat: boolean | string }
  | { in_set_piece: boolean | string }
  | { beat: string }
  | { asleep: string }
  | { down: string }
  | { dead: string }
  | { visited: string };

type CmpFields = { eq?: number; ne?: number; gt?: number; gte?: number; lt?: number; lte?: number };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(Condition).min(1) }),
    z.strictObject({ any: z.array(Condition).min(1) }),
    z.strictObject({ not: Condition }),
    z.strictObject({ flag: z.string().min(1) }),
    z.strictObject({ flag_eq: z.strictObject({ flag: z.string().min(1), value: Scalar }) }),
    z.strictObject({ time: ClockTime }),
    z.strictObject({ time_between: z.strictObject({ from: ClockTime, to: ClockTime }) }),
    z.strictObject({ time_after: ClockTime }),
    z.strictObject({ time_before: ClockTime }),
    z.strictObject({ day: Comparison }),
    z.strictObject({ in_room: z.strictObject({ who: Who, where: Id }) }),
    z.strictObject({ same_room: z.strictObject({ who: Who, with: Who }) }),
    z.strictObject({ holds: z.strictObject({ who: Who, what: Id }) }),
    z.strictObject({
      property: z.strictObject({
        object: Who,
        key: z.string().min(1),
        op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]).optional(),
        value: Scalar,
      }),
    }),
    z.strictObject({
      special: z.strictObject({
        who: Who.optional(),
        ST: Comparison.optional(),
        PE: Comparison.optional(),
        EN: Comparison.optional(),
        CH: Comparison.optional(),
        IN: Comparison.optional(),
        AG: Comparison.optional(),
        LK: Comparison.optional(),
      }),
    }),
    z.strictObject({ skill: z.strictObject({ who: Who.optional(), skill: z.enum(SKILLS), ...cmpFields }) }),
    z.strictObject({
      relationship: z.strictObject({
        who: Who,
        with: Who,
        trust: Comparison.optional(),
        affinity: Comparison.optional(),
      }),
    }),
    z.strictObject({ believes: z.strictObject({ who: Who, belief: z.string().min(1) }) }),
    z.strictObject({
      event: z.union([
        z.string().min(1),
        z.strictObject({ kind: z.string().min(1), actor: Who.optional(), target: Who.optional() }),
      ]),
      actor: Who.optional(),
      target: Who.optional(),
    }),
    z.strictObject({ turns: Comparison }),
    z.strictObject({ hp: z.strictObject({ who: Who.optional(), ...cmpFields }) }),
    z.strictObject({ level: z.strictObject({ who: Who.optional(), ...cmpFields }) }),
    z.strictObject({ money: z.strictObject({ who: Who.optional(), ...cmpFields }) }),
    z.strictObject({ in_combat: z.union([z.boolean(), Who]) }),
    z.strictObject({ in_set_piece: z.union([z.boolean(), Id]) }),
    z.strictObject({ beat: z.string().min(1) }),
    z.strictObject({ asleep: Who }),
    z.strictObject({ down: Who }),
    z.strictObject({ dead: Who }),
    z.strictObject({ visited: Id }),
  ]),
);

// ─── Text variants (§7.4) ─────────────────────────────────────────────────────

export const TextVariant = z.strictObject({ when: Condition.optional(), text: z.string() });
export const TextVariants = z.union([z.string(), z.array(TextVariant).min(1)]);
export type TextVariants = z.infer<typeof TextVariants>;

// ─── Effects (§7.5) ───────────────────────────────────────────────────────────

/**
 * A sound (§4.11). `loudness` is roughly how far it carries: it falls by one every three tiles and is muffled
 * passing between rooms. `sound` completes "You hear …", e.g. "a board creaking".
 */
export const Noise = z.strictObject({
  loudness: z.number().int().min(1).max(12),
  sound: z.string().min(1),
});
export type Noise = z.infer<typeof Noise>;

/** A number, or a reference to a hook argument (`{ $arg: amount }`), substituted when a hook fires. */
export const NumArg = z.union([z.number(), z.strictObject({ $arg: z.string().min(1) })]);
export type NumArg = z.infer<typeof NumArg>;

export const CheckSpec = z.strictObject({
  who: Who.optional(),
  skill: z.enum(SKILLS).optional(),
  attribute: z.enum(ATTRIBUTES).optional(),
  tier: z.enum(TIERS).optional(),
  modifier: z.number().optional(),
  /** Makes this an opposed check against the named character (§5.4). */
  opposed: Who.optional(),
  get pass() {
    return z.array(Effect).optional();
  },
  get fail() {
    return z.array(Effect).optional();
  },
});
export type CheckSpec = {
  who?: string;
  skill?: SkillId;
  attribute?: Attribute;
  tier?: Tier;
  modifier?: number;
  opposed?: string;
  pass?: Effect[];
  fail?: Effect[];
};

/** Flat action parameters, shared by the `act` effect, authored options and LLM action requests. */
export const actionParams = {
  item: Who.optional(),
  target: Who.optional(),
  to: Who.optional(),
  from: Who.optional(),
  on: Who.optional(),
  weapon: Who.optional(),
  direction: z.string().optional(),
  minutes: z.number().int().positive().optional(),
  /** `sneak` only: leave the stance instead of entering it. */
  stop: z.boolean().optional(),
};

export const ActionRequest = z.strictObject({ act: z.enum(ACTION_VERBS), ...actionParams });
export type ActionRequest = z.infer<typeof ActionRequest>;

const WhoRef = z.union([z.string().min(1), z.strictObject({ who: Who.optional(), behaviour: Id })]);

export type Effect =
  | { set_flag: string | { flag: string; value: Scalar } }
  | { clear_flag: string }
  | { set_property: { object: string; key: string; value: Scalar } }
  | { adjust_property: { object: string; key: string; by: NumArg } }
  | { noise: { source: string } & Noise }
  | { move: { object: string; to: string } }
  | { spawn: { object: string; in: string } }
  | { remove: string }
  | ({ act: ActionVerb; actor?: string } & Omit<ActionRequest, "act">)
  | { say: string | { who: string; text: string } }
  | { narrate: TextVariants }
  | { remember: { who: string; text: string } }
  | { set_intent: string | null | { who: string; intent: string | null } }
  | { start_behaviour: string | { who?: string; behaviour: string } }
  | { stop_behaviour: string | { who?: string; behaviour: string } }
  | { adjust_relationship: { who: string; with: string; trust?: NumArg; affinity?: NumArg } }
  | { add_belief: { who: string; belief: string; confidence?: number; source?: string } }
  | { remove_belief: { who: string; belief: string } }
  | { start_conversation: string }
  | { end_conversation: Record<string, never> | true }
  | { check: CheckSpec }
  | { award_xp: NumArg | { who?: string; amount: NumArg } }
  | { heal: { who?: string; amount: NumArg } }
  | { damage: { who?: string; amount: NumArg } }
  | {
      modify: {
        who?: string;
        id?: string;
        attribute?: Attribute;
        skill?: SkillId;
        amount: number;
        minutes?: number;
        hours?: number;
      };
    }
  | { give_money: { who?: string; amount: NumArg } }
  | { set_hostile: string | { who: string; hostile?: boolean } }
  | { set_combat_profile: { who: string; profile: Partial<CombatProfile> } }
  | { start_set_piece: string }
  | { advance_beat: string | Record<string, never> }
  | { end_set_piece: string | Record<string, never> }
  | { callout: string }
  | { end_game: string };

export const COMBAT_STYLES = ["aggressive", "defensive", "coward"] as const;
export const CombatProfile = z.strictObject({
  style: z.enum(COMBAT_STYLES).default("defensive"),
  /** Flee (or surrender if cornered) at or below this percentage of max HP. */
  flee_at: z.number().min(0).max(100).optional(),
  preferred_weapon: Id.optional(),
});
export type CombatProfile = z.infer<typeof CombatProfile>;

const Empty = z.strictObject({});

export const Effect: z.ZodType<Effect> = z.lazy(() =>
  z.union([
    z.strictObject({
      set_flag: z.union([z.string().min(1), z.strictObject({ flag: z.string().min(1), value: Scalar })]),
    }),
    z.strictObject({ clear_flag: z.string().min(1) }),
    z.strictObject({ set_property: z.strictObject({ object: Who, key: z.string().min(1), value: Scalar }) }),
    z.strictObject({ adjust_property: z.strictObject({ object: Who, key: z.string().min(1), by: NumArg }) }),
    z.strictObject({ noise: z.strictObject({ source: Who, ...Noise.shape }) }),
    z.strictObject({ move: z.strictObject({ object: Who, to: Who }) }),
    z.strictObject({ spawn: z.strictObject({ object: Id, in: Who }) }),
    z.strictObject({ remove: Who }),
    z.strictObject({ act: z.enum(ACTION_VERBS), actor: Who.optional(), ...actionParams }),
    z.strictObject({ say: z.union([z.string(), z.strictObject({ who: Who, text: z.string() })]) }),
    z.strictObject({ narrate: TextVariants }),
    /** A note in a character's day log (§6.8): what they make of something, for their conversations and summaries. */
    z.strictObject({ remember: z.strictObject({ who: Who, text: z.string().min(1) }) }),
    z.strictObject({
      set_intent: z.union([z.string(), z.null(), z.strictObject({ who: Who, intent: z.string().nullable() })]),
    }),
    z.strictObject({ start_behaviour: WhoRef }),
    z.strictObject({ stop_behaviour: WhoRef }),
    z.strictObject({
      adjust_relationship: z.strictObject({
        who: Who,
        with: Who,
        trust: NumArg.optional(),
        affinity: NumArg.optional(),
      }),
    }),
    z.strictObject({
      add_belief: z.strictObject({
        who: Who,
        belief: z.string().min(1),
        confidence: z.number().min(0).max(1).optional(),
        source: z.string().optional(),
      }),
    }),
    z.strictObject({ remove_belief: z.strictObject({ who: Who, belief: z.string().min(1) }) }),
    z.strictObject({ start_conversation: Id }),
    z.strictObject({ end_conversation: z.union([Empty, z.literal(true)]) }),
    z.strictObject({ check: CheckSpec }),
    z.strictObject({ award_xp: z.union([NumArg, z.strictObject({ who: Who.optional(), amount: NumArg })]) }),
    z.strictObject({ heal: z.strictObject({ who: Who.optional(), amount: NumArg }) }),
    z.strictObject({ damage: z.strictObject({ who: Who.optional(), amount: NumArg }) }),
    z.strictObject({
      modify: z.strictObject({
        who: Who.optional(),
        id: z.string().optional(),
        attribute: z.enum(ATTRIBUTES).optional(),
        skill: z.enum(SKILLS).optional(),
        amount: z.number(),
        minutes: z.number().positive().optional(),
        hours: z.number().positive().optional(),
      }),
    }),
    z.strictObject({ give_money: z.strictObject({ who: Who.optional(), amount: NumArg }) }),
    z.strictObject({
      set_hostile: z.union([Who, z.strictObject({ who: Who, hostile: z.boolean().optional() })]),
    }),
    z.strictObject({ set_combat_profile: z.strictObject({ who: Who, profile: CombatProfile.partial() }) }),
    z.strictObject({ start_set_piece: Id }),
    z.strictObject({ advance_beat: z.union([z.string().min(1), Empty]) }),
    z.strictObject({ end_set_piece: z.union([Id, Empty]) }),
    z.strictObject({ callout: Id }),
    z.strictObject({ end_game: Id }),
  ]),
) as z.ZodType<Effect>;

export const EFFECT_KINDS = [
  "set_flag",
  "clear_flag",
  "set_property",
  "adjust_property",
  "noise",
  "move",
  "spawn",
  "remove",
  "act",
  "say",
  "narrate",
  "remember",
  "set_intent",
  "start_behaviour",
  "stop_behaviour",
  "adjust_relationship",
  "add_belief",
  "remove_belief",
  "start_conversation",
  "end_conversation",
  "check",
  "award_xp",
  "heal",
  "damage",
  "modify",
  "give_money",
  "set_hostile",
  "set_combat_profile",
  "start_set_piece",
  "advance_beat",
  "end_set_piece",
  "callout",
  "end_game",
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

// ─── Space (§4.10, §7.10) ──────────────────────────────────────────────────────

/** Terrain kinds. The engine knows whether each can be walked on and seen through; frontends decide how they look. */
export const TERRAINS = [
  "floor",
  "carpet",
  "boards",
  "tiles",
  "lino",
  "concrete",
  "deck",
  "grass",
  "sand",
  "shingle",
  "road",
  "pavement",
  "stairs",
  "wall",
  "window",
  "railing",
  "fence",
  "water",
  "void",
] as const;
export type Terrain = (typeof TERRAINS)[number];

/** A hint to frontends on how something looks (§7.10). The engine ignores it. */
export const Look = z.strictObject({
  emoji: z.string().min(1).optional(),
  /** One or two characters for terminals without emoji. */
  glyph: z.string().min(1).max(2).optional(),
  /** A CSS-style colour, e.g. "#c0a060" or "yellow". */
  color: z.string().min(1).optional(),
  /** Alternate emoji (or glyphs) cycled for animation. */
  frames: z.array(z.string().min(1)).optional(),
  /** A sprite key from the payload's `assets/sprites.json`, for frontends that draw images (e.g. "terrain/water"). */
  sprite: z.string().min(1).optional(),
});
export type Look = z.infer<typeof Look>;

export const MapLegendEntry = z.union([
  z.strictObject({ terrain: z.enum(TERRAINS), look: Look.optional() }),
  z.strictObject({ object: Id, on: z.enum(TERRAINS).optional() }),
  z.strictObject({ character: Id, on: z.enum(TERRAINS).optional() }),
  /** The tile of an exit, by its direction or label. */
  z.strictObject({ exit: z.string().min(1), on: z.enum(TERRAINS).optional() }),
]);
export type MapLegendEntry = z.infer<typeof MapLegendEntry>;

export const RoomMap = z.strictObject({
  /** One string per row, one character per tile. `#` wall, `.` floor, space void; anything else is in the legend. */
  rows: z.array(z.string()).min(1).max(64),
  legend: z.record(z.string(), MapLegendEntry).default({}),
});
export type RoomMap = z.infer<typeof RoomMap>;

// ─── Rooms (§4.1) ─────────────────────────────────────────────────────────────

export const Exit = z.strictObject({
  direction: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  /** Destination room. Omit only for a blocked exit, which describes the edge of the block (P1, Q6). */
  to: Id.optional(),
  /** A door, hatch or fire escape object that must be open to pass. */
  via: Id.optional(),
  when: Condition.optional(),
  /** Shown when `when` fails. */
  closed_text: TextVariants.optional(),
  /** An impassable exit at the edge of the block: shown, never traversable. */
  blocked: TextVariants.optional(),
  hidden: z.boolean().optional(),
});
export type Exit = z.infer<typeof Exit>;

export const Room = z.strictObject({
  id: Id,
  name: z.string().min(1),
  description: TextVariants,
  exits: z.array(Exit).default([]),
  tags: z.array(z.string()).default([]),
  /** The room's floor plan (§4.10, §7.10). */
  map: RoomMap,
});
export type Room = z.infer<typeof Room>;

// ─── Objects and items (§4.2, §5.7) ───────────────────────────────────────────

export const UseRule = z.strictObject({
  /** Target object id (`use X on Y`), or `tag:<tag>` to match any object with that tag. Omit for `use X`. */
  on: z.string().min(1).optional(),
  when: Condition.optional(),
  text: TextVariants.optional(),
  effects: z.array(Effect).default([]),
  /** Base minutes at AP 8 (default 2). */
  minutes: z.number().int().min(0).optional(),
  consume: z.boolean().optional(),
  /** A sound this use makes, heard by whoever is in earshot (§4.11). */
  noise: Noise.optional(),
});
export type UseRule = z.infer<typeof UseRule>;

/**
 * One way of forcing an object (§4.12): prying up a board, unscrewing a panel, jemmying a door. Any held object
 * carrying one of `tools` as a tag will do. Forcing works on anything `fastened` or `locked`.
 */
export const ForceMethod = z.strictObject({
  tools: z.array(z.string().min(1)).min(1),
  /** A check the forcer must pass (skill or attribute, tier, modifier). Omit: it always works. */
  check: z
    .strictObject({
      skill: z.enum(SKILLS).optional(),
      attribute: z.enum(ATTRIBUTES).optional(),
      tier: z.enum(TIERS).optional(),
      modifier: z.number().optional(),
    })
    .optional(),
  /** Base minutes at AP 8, pass or fail. */
  minutes: z.number().int().min(0).default(5),
  noise: Noise.optional(),
  text: TextVariants.optional(),
  fail_text: TextVariants.optional(),
  effects: z.array(Effect).default([]),
});
export type ForceMethod = z.infer<typeof ForceMethod>;

export const Weapon = z.strictObject({
  /** Combat-text key (§5.6): every weapon type needs entries in combat_text. */
  type: z.string().min(1),
  skill: z.enum(["small_guns", "melee_weapons", "unarmed", "throwing"]),
  damage: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  ap: z.number().int().min(1).max(10),
  accuracy: z.number().int().default(0),
  min_st: z.number().int().min(1).max(10).default(1),
  ranged: z.boolean().default(false),
  /** Reach of a ranged weapon in tiles (§5.6). */
  range: z.number().int().min(1).max(64).optional(),
  ammo: z.strictObject({ type: z.string().min(1), capacity: z.number().int().positive() }).optional(),
});
export type Weapon = z.infer<typeof Weapon>;

export const Armour = z.strictObject({
  ac: z.number().int().min(0),
  dt: z.number().int().min(0).default(0),
  dr: z.number().min(0).max(90).default(0),
});
export type Armour = z.infer<typeof Armour>;

export const TimedModifier = z.strictObject({
  attribute: z.enum(ATTRIBUTES).optional(),
  skill: z.enum(SKILLS).optional(),
  amount: z.number(),
  hours: z.number().positive().optional(),
});

export const Consumable = z.strictObject({
  heal: z.number().int().min(0).optional(),
  /** Hours of fatigue removed. */
  fatigue: z.number().min(0).optional(),
  modifiers: z.array(TimedModifier).default([]),
  effects: z.array(Effect).default([]),
  text: TextVariants.optional(),
});
export type Consumable = z.infer<typeof Consumable>;

const objectFields = {
  id: Id,
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  /** Room, container or character id. Omit (or null) for an object that starts off-stage and is spawned later. */
  location: Id.nullable().optional(),
  description: TextVariants,
  /** Sentence used in room listings instead of the generic "You see X." */
  room_text: TextVariants.optional(),
  /** Scenery is described by its room and never listed separately. */
  scenery: z.boolean().optional(),
  properties: z.record(z.string(), Scalar).default({}),
  affordances: z.array(z.string()).default([]),
  behaviours: z.array(Id).default([]),
  tags: z.array(z.string()).default([]),
  /** Q31: `player` means only the player perceives this entity (apparitions). */
  perceived_by: z.literal("player").optional(),
  /** Hidden (unlisted, untargetable) unless this condition holds for the player, e.g. a Perception gate. */
  hidden_unless: Condition.optional(),
  /** Object id of the key that locks/unlocks this. */
  key: Id.optional(),
  lock_tier: z.enum(TIERS).optional(),
  /** Impact (mass × velocity) at or above which this breaks (`broken: true`). */
  break_at: z.number().positive().optional(),
  uses: z.array(UseRule).default([]),
  /** Ways to force this open or loose (§4.12). */
  force: z.array(ForceMethod).default([]),
  /** Sound made when someone walks over it (needs the `underfoot` affordance) (§4.11). */
  step_noise: Noise.optional(),
  /** Beliefs (story belief ids) anyone who examines this learns: what a letter or a register says (§4.13). */
  teaches: z.array(z.string().min(1)).default([]),
  /** The character it belongs to (§4.13). Others need `permitted` to take, force or break it unremarked. */
  owner: Id.optional(),
  /** Who else may take or force it, evaluated with `self` as the would-be taker. */
  permitted: Condition.optional(),
  weapon: Weapon.optional(),
  armour: Armour.optional(),
  consumable: Consumable.optional(),
  /** Ammunition: `count` property holds the rounds. */
  ammo: z.strictObject({ type: z.string().min(1) }).optional(),
  /** How frontends should draw this (§7.10). */
  look: Look.optional(),
  /** Per-object overrides for engine messages, keyed like game.messages (e.g. take, open, examine). */
  messages: z.record(z.string(), TextVariants).default({}),
};

export const GameObject = z.strictObject(objectFields);
export type GameObject = z.infer<typeof GameObject>;

// ─── Characters (§4.4) ────────────────────────────────────────────────────────

export const Special = z.strictObject({
  ST: z.number().int(),
  PE: z.number().int(),
  EN: z.number().int(),
  CH: z.number().int(),
  IN: z.number().int(),
  AG: z.number().int(),
  LK: z.number().int(),
});
export type Special = z.infer<typeof Special>;

export const Relationship = z.strictObject({
  trust: z.number().min(-100).max(100).default(0),
  affinity: z.number().min(-100).max(100).default(0),
  notes: z.string().default(""),
});

export const BeliefDecl = z.union([
  z.string().min(1),
  z.strictObject({
    belief: z.string().min(1),
    confidence: z.number().min(0).max(1).default(1),
    source: z.string().default("authored"),
  }),
]);

export const Character = z.strictObject({
  ...objectFields,
  persona: z.strictObject({
    identity: z.string().min(1),
    background: z.string().default(""),
    personality: z.array(z.string()).default([]),
    voice: z.string().default(""),
  }),
  special: Special,
  tag_skills: z.array(z.enum(SKILLS)).max(3).default([]),
  skill_points: z.partialRecord(z.enum(SKILLS), z.number().int().min(0)).default({}),
  hp: z.number().int().optional(),
  fatigue_hours: z.number().min(0).default(0),
  xp: z.number().int().min(0).default(0),
  level: z.number().int().min(1).default(1),
  money: z.number().int().min(0).default(0),
  equipment: z.strictObject({ weapon: Id.optional(), armour: Id.optional() }).default({}),
  combat_profile: CombatProfile.default({ style: "defensive" }),
  essential: z.boolean().default(false),
  hostile: z.boolean().default(false),
  merchant: z.boolean().default(false),
  goals: z.array(z.string()).default([]),
  intent: z.string().optional(),
  relationships: z.record(z.string(), Relationship).default({}),
  beliefs: z.array(BeliefDecl).default([]),
  /** When false, `talk` is refused with `refuse_text`. */
  talk_when: Condition.optional(),
  refuse_text: TextVariants.optional(),
  /** Authored "they don't answer" line used when the LLM fails (§6.9). */
  fallback_line: z.string().optional(),
});
export type Character = z.infer<typeof Character>;

// ─── Behaviours (§4.5) ────────────────────────────────────────────────────────

export const BehaviourRule = z.strictObject({
  when: Condition,
  do: z.array(Effect).min(1),
  /** Minimum game minutes between firings. */
  cooldown: z.number().int().min(0).optional(),
  once: z.boolean().default(false),
  priority: z.number().int().default(0),
});
export const Behaviour = z.strictObject({ id: Id, rules: z.array(BehaviourRule).min(1) });
export type Behaviour = z.infer<typeof Behaviour>;
export type BehaviourRule = z.infer<typeof BehaviourRule>;

// ─── Conversations and hooks (§6.2, §6.4) ─────────────────────────────────────

export const AuthoredOption = z.strictObject({
  text: z.string().min(1),
  when: Condition.optional(),
  check: CheckSpec.optional(),
  effects: z.array(Effect).default([]),
  action: ActionRequest.optional(),
  /** Ends the conversation after this option resolves. */
  end: z.boolean().optional(),
  /** Offered at most once per save. */
  once: z.boolean().optional(),
});
export type AuthoredOption = z.infer<typeof AuthoredOption>;

export const DEFAULT_CONVERSATION_ACTIONS: ActionVerb[] = ["go", "give", "take", "use"];

export const Conversation = z.strictObject({
  id: Id,
  character: Id,
  when: Condition.optional(),
  /** Higher wins when several of a character's conversations are available. */
  priority: z.number().int().default(0),
  goals: z.array(z.string()).default([]),
  opening: TextVariants.optional(),
  options: z.array(AuthoredOption).default([]),
  hooks: z.array(Id).default([]),
  /** Actions the character may take here (§6.6). Default go, give, take, use; attack must be granted explicitly. */
  actions: z.array(z.enum(ACTION_VERBS)).optional(),
  ends_when: Condition.optional(),
  fallback_line: z.string().optional(),
});
export type Conversation = z.infer<typeof Conversation>;

export const HookParam = z.strictObject({
  type: z.enum(["number", "string", "boolean"]),
  description: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  enum: z.array(z.string()).optional(),
});

export const Hook = z.strictObject({
  id: Id,
  description: z.string().min(1),
  guard: Condition.optional(),
  effects: z.array(Effect).min(1),
  once: z.boolean().default(false),
  params: z.record(z.string(), HookParam).default({}),
});
export type Hook = z.infer<typeof Hook>;

// ─── Callouts and set pieces (§6.5, §6.7) ─────────────────────────────────────

export const Callout = z.strictObject({
  id: Id,
  prompt: z.string().min(1),
  output: z.literal("text").default("text"),
  cache: z.enum(["per-save", "none"]).default("per-save"),
  /** Shown if the provider fails. */
  fallback: z.string().default(""),
});
export type Callout = z.infer<typeof Callout>;

export const Beat = z.union([z.string().min(1), z.strictObject({ id: z.string().min(1), description: z.string() })]);

export const SetPiece = z.strictObject({
  id: Id,
  starts_when: Condition.optional(),
  objective: z.string().min(1),
  stage: z.array(Id).min(1),
  cast: z.array(Id).default([]),
  director_brief: z.string().min(1),
  beats: z.array(Beat).min(1),
  moves: z
    .strictObject({
      actions: z.array(z.enum(ACTION_VERBS)).default([]),
      effects: z.array(z.enum(EFFECT_KINDS)).default(["narrate"]),
      hooks: z.array(Id).default([]),
    })
    .default({ actions: [], effects: ["narrate"], hooks: [] }),
  ends_when: Condition,
  outcomes: z.array(z.strictObject({ when: Condition.optional(), do: z.array(Effect).min(1) })).default([]),
});
export type SetPiece = z.infer<typeof SetPiece>;

// ─── Story, game, combat text (§7.3, §7.6) ────────────────────────────────────

export const Trigger = z.strictObject({
  id: Id,
  when: Condition,
  do: z.array(Effect).min(1),
  /** Fire at most once per save. Otherwise triggers fire each time their condition becomes true. */
  once: z.boolean().default(false),
  /** Firing during the player's sleep wakes them (default false: dreams and quiet changes don't). */
  wakes: z.boolean().default(false),
});
export type Trigger = z.infer<typeof Trigger>;

export const Ending = z.strictObject({
  id: Id,
  title: z.string().optional(),
  when: Condition.optional(),
  text: TextVariants,
});
export type Ending = z.infer<typeof Ending>;

export const Story = z.strictObject({
  synopsis: z.string().min(1),
  tone: z.string().default(""),
  tensions: z.array(z.string()).default([]),
  /** Optional belief catalogue: belief ids with the proposition they stand for (shown to the LLM). */
  beliefs: z.array(z.strictObject({ id: z.string().min(1), text: z.string().min(1) })).default([]),
  triggers: z.array(Trigger).default([]),
  endings: z.array(Ending).min(1),
});
export type Story = z.infer<typeof Story>;

export const Game = z.strictObject({
  id: Id,
  title: z.string().min(1),
  schema_version: z.string().regex(/^\d+\.\d+$/, "schema_version is 'MAJOR.MINOR', e.g. '1.0'"),
  version: z.string().default("0.0.0"),
  /** Saves from these earlier payload versions stay loadable (§7.8). */
  compatible_with: z.array(z.string()).default([]),
  start: Id,
  player: z.strictObject({
    character: Id,
    mode: z.enum(["fixed", "point-buy"]).default("fixed"),
    presets: z.array(z.strictObject({ name: z.string().min(1), special: Special })).default([]),
  }),
  clock: z.strictObject({ time: ClockTime }).default({ time: "08:00" }),
  intro: TextVariants.optional(),
  style_guide: z.string().default(""),
  downed: z
    .strictObject({
      mode: z.enum(["wake-robbed", "end-game"]).default("wake-robbed"),
      ending: Id.optional(),
      room: Id.optional(),
      text: TextVariants.optional(),
    })
    .default({ mode: "wake-robbed" }),
  xp: z
    .strictObject({ check: z.number().int().min(0).default(5), fight: z.number().int().min(0).default(25) })
    .default({ check: 5, fight: 25 }),
  /** Overrides for engine message templates (see src/core/messages.ts). */
  messages: z.record(z.string(), z.string()).default({}),
  conversation_minutes_per_turn: z.number().min(0).default(1),
});
export type Game = z.infer<typeof Game>;

export const CombatTextEntry = z.strictObject({
  hit: z.union([z.string(), z.array(z.string()).min(1)]),
  miss: z.union([z.string(), z.array(z.string()).min(1)]),
  crit: z.union([z.string(), z.array(z.string()).min(1)]),
  down: z.union([z.string(), z.array(z.string()).min(1)]),
  kill: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
});
export const CombatText = z.record(z.string(), CombatTextEntry);
export type CombatText = z.infer<typeof CombatText>;

// ─── The merged payload ───────────────────────────────────────────────────────

export const Payload = z.strictObject({
  game: Game,
  story: Story,
  rooms: z.array(Room).min(1),
  objects: z.array(GameObject).default([]),
  characters: z.array(Character).min(1),
  conversations: z.array(Conversation).default([]),
  hooks: z.array(Hook).default([]),
  behaviours: z.array(Behaviour).default([]),
  callouts: z.array(Callout).default([]),
  set_pieces: z.array(SetPiece).default([]),
  combat_text: CombatText.default({}),
});
export type Payload = z.infer<typeof Payload>;
export type PayloadInput = z.input<typeof Payload>;

export const SCHEMA_VERSION = "2.0";
