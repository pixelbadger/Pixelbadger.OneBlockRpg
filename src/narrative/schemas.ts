/** Structured outputs the narrative layer asks for (§6.3, §6.7, §6.8). Validated engine-side with zod. */
import { z } from "zod";
import { ACTION_VERBS, SKILLS, TIERS } from "../payload/schema.js";

/** A physical action request in the shared vocabulary (§6.6). Flat, so it suits structured-output backends. */
export const LlmAction = z.strictObject({
  act: z.enum(ACTION_VERBS),
  item: z.string().optional(),
  target: z.string().optional(),
  to: z.string().optional(),
  from: z.string().optional(),
  on: z.string().optional(),
  weapon: z.string().optional(),
  direction: z.string().optional(),
});
export type LlmAction = z.infer<typeof LlmAction>;

const ArgValue = z.union([z.string(), z.number(), z.boolean()]);

export const HookCall = z.strictObject({
  id: z.string(),
  args: z.array(z.strictObject({ name: z.string(), value: ArgValue })).default([]),
});

export const CharacterTurn = z.strictObject({
  /** What the character says; tone unbounded. May be empty if they only act. */
  line: z.string(),
  emotion: z.string().optional(),
  actions: z.array(LlmAction).max(3).default([]),
  hooks: z.array(HookCall).max(3).default([]),
  /** 2–4 suggested player replies, merged with authored options. */
  playerOptions: z
    .array(
      z.strictObject({
        text: z.string(),
        action: LlmAction.optional(),
        check: z.strictObject({ skill: z.enum(SKILLS), tier: z.enum(TIERS) }).optional(),
      }),
    )
    .max(4)
    .default([]),
  wantsToEnd: z.boolean().optional(),
});
export type CharacterTurn = z.infer<typeof CharacterTurn>;

/** Director effects are flat records of the simple effect kinds; the engine rebuilds and validates them. */
export const DirectorEffect = z.strictObject({
  kind: z.enum([
    "narrate",
    "set_property",
    "set_flag",
    "clear_flag",
    "add_belief",
    "remove_belief",
    "set_intent",
    "adjust_relationship",
    "set_hostile",
    "move",
    "spawn",
    "remove",
    "say",
  ]),
  text: z.string().optional(),
  object: z.string().optional(),
  key: z.string().optional(),
  value: ArgValue.optional(),
  flag: z.string().optional(),
  who: z.string().optional(),
  with: z.string().optional(),
  belief: z.string().optional(),
  to: z.string().optional(),
  trust: z.number().optional(),
  affinity: z.number().optional(),
});
export type DirectorEffect = z.infer<typeof DirectorEffect>;

export const DirectorTurn = z.strictObject({
  /** Scene narration for the player; tone unbounded. */
  narration: z.string(),
  lines: z
    .array(z.strictObject({ who: z.string(), text: z.string() }))
    .max(4)
    .default([]),
  castActions: z
    .array(z.strictObject({ actor: z.string(), action: LlmAction }))
    .max(6)
    .default([]),
  effects: z.array(DirectorEffect).max(6).default([]),
  hooks: z.array(HookCall).max(3).default([]),
  /** Combat intentions: who should go for whom (§5.6, applied between rounds). */
  targets: z
    .array(z.strictObject({ actor: z.string(), target: z.string() }))
    .max(6)
    .default([]),
  advanceBeat: z.boolean().default(false),
});
export type DirectorTurn = z.infer<typeof DirectorTurn>;

export const DaySummary = z.strictObject({ summary: z.string() });

/**
 * How a character takes in a document (§4.13): which of its propositions they accept, how their existing beliefs
 * shift, and what they now think in their own words. Validated and applied by the engine (confidences clamped to 0–1).
 */
export const ReadingVerdict = z.strictObject({
  /** Their private reaction, first person; it goes in their day log. */
  reaction: z.string(),
  /** The document's propositions (belief ids) they now hold, and how firmly. */
  accept: z
    .array(z.strictObject({ belief: z.string(), confidence: z.number() }))
    .max(8)
    .default([]),
  /** Beliefs they already held, re-weighed or dropped in the light of it. */
  revise: z
    .array(
      z.strictObject({
        belief: z.string(),
        confidence: z.number().optional(),
        drop: z.boolean().optional(),
      }),
    )
    .max(6)
    .default([]),
  /** New beliefs in their own words: what it proves, who it shows up, why it must be false. */
  thoughts: z
    .array(z.strictObject({ text: z.string(), confidence: z.number() }))
    .max(2)
    .default([]),
});
export type ReadingVerdict = z.infer<typeof ReadingVerdict>;
