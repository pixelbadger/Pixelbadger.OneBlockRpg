/**
 * SPECIAL (§5): attributes, derived statistics, skills, checks, progression, trade and time.
 * Everything here is a pure function. Baseline values are Fallout 2's, to be tuned.
 */
import { ATTRIBUTES, type Attribute, SKILLS, type SkillId, type Special, type Tier } from "../payload/schema.js";
import type { Rng } from "./rng.js";

export const ATTRIBUTE_NAMES: Record<Attribute, string> = {
  ST: "Strength",
  PE: "Perception",
  EN: "Endurance",
  CH: "Charisma",
  IN: "Intelligence",
  AG: "Agility",
  LK: "Luck",
};

export const SKILL_NAMES: Record<SkillId, string> = {
  small_guns: "Small Guns",
  melee_weapons: "Melee Weapons",
  unarmed: "Unarmed",
  throwing: "Throwing",
  first_aid: "First Aid",
  doctor: "Doctor",
  speech: "Speech",
  barter: "Barter",
  gambling: "Gambling",
  sneak: "Sneak",
  lockpick: "Lockpick",
  steal: "Steal",
  traps: "Traps",
  science: "Science",
  repair: "Repair",
};

export interface Modifier {
  id: string;
  attribute?: Attribute;
  skill?: SkillId;
  amount: number;
  /** Clock minute at which it lapses; undefined is permanent. */
  expiresAt?: number;
  source?: string;
}

export const clampAttr = (v: number) => Math.max(1, Math.min(10, v));

// ─── Fatigue (§5.8) ───────────────────────────────────────────────────────────

/** Waking hours: 14 + EN (ours, not Fallout). */
export const wakingHours = (EN: number) => 14 + EN;

/** Whole hours past waking hours; each costs −1 AG and −1 PE. */
export function fatiguePenalty(minutesAwake: number, baseEN: number): number {
  return Math.max(0, Math.floor(minutesAwake / 60 - wakingHours(baseEN)));
}

/** At waking hours + 4 a character collapses where they stand. */
export function collapses(minutesAwake: number, baseEN: number): boolean {
  return minutesAwake >= (wakingHours(baseEN) + 4) * 60;
}

// ─── Attributes after modifiers ───────────────────────────────────────────────

export function effectiveSpecial(base: Special, modifiers: readonly Modifier[], minutesAwake = 0): Special {
  const out = { ...base };
  for (const m of modifiers) if (m.attribute) out[m.attribute] += m.amount;
  const penalty = fatiguePenalty(minutesAwake, base.EN);
  out.AG -= penalty;
  out.PE -= penalty;
  for (const a of ATTRIBUTES) out[a] = clampAttr(out[a]);
  return out;
}

// ─── Derived statistics (§5.2) ────────────────────────────────────────────────

export const hpPerLevel = (EN: number) => 2 + Math.floor(EN / 2);
export const maxHp = (base: Special, level: number) => 15 + base.ST + 2 * base.EN + (level - 1) * hpPerLevel(base.EN);
export const actionPoints = (s: Special) => 5 + Math.floor(s.AG / 2);
export const armourClass = (s: Special, armourAc = 0) => s.AG + armourAc;
export const carryCapacity = (s: Special) => 11 + 11 * s.ST;
export const meleeDamageBonus = (s: Special) => Math.max(1, s.ST - 5);
export const sequence = (s: Special) => 2 * s.PE;
export const healingRate = (s: Special) => Math.max(1, Math.floor(s.EN / 3));
export const criticalChance = (s: Special) => s.LK;
export const skillPointsPerLevel = (s: Special) => 5 + 2 * s.IN;

// ─── Skills (§5.3) ────────────────────────────────────────────────────────────

export function skillBase(skill: SkillId, s: Special): number {
  switch (skill) {
    case "small_guns":
      return 5 + 4 * s.AG;
    case "melee_weapons":
      return 20 + 2 * (s.AG + s.ST);
    case "unarmed":
      return 30 + 2 * (s.AG + s.ST);
    case "throwing":
      return 4 * s.AG;
    case "first_aid":
      return 2 * (s.PE + s.IN);
    case "doctor":
      return 5 + s.PE + s.IN;
    case "speech":
      return 5 * s.CH;
    case "barter":
      return 4 * s.CH;
    case "gambling":
      return 5 * s.LK;
    case "sneak":
      return 5 + 3 * s.AG;
    case "lockpick":
      return 10 + s.PE + s.AG;
    case "steal":
      return 3 * s.AG;
    case "traps":
      return 10 + s.PE + s.AG;
    case "science":
      return 4 * s.IN;
    case "repair":
      return 3 * s.IN;
  }
}

export interface SkillInputs {
  special: Special;
  tags: readonly SkillId[];
  points: Partial<Record<SkillId, number>>;
  modifiers: readonly Modifier[];
}

/** Base + 20 if tagged + invested points (doubled if tagged) + modifiers. */
export function skillValue(skill: SkillId, i: SkillInputs): number {
  const tagged = i.tags.includes(skill);
  let v = skillBase(skill, i.special) + (tagged ? 20 : 0) + (i.points[skill] ?? 0) * (tagged ? 2 : 1);
  for (const m of i.modifiers) if (m.skill === skill) v += m.amount;
  return Math.max(0, v);
}

export function allSkills(i: SkillInputs): Record<SkillId, number> {
  return Object.fromEntries(SKILLS.map((s) => [s, skillValue(s, i)])) as Record<SkillId, number>;
}

// ─── Checks (§5.4) ────────────────────────────────────────────────────────────

export const TIER_MODIFIER: Record<Tier, number> = {
  trivial: 30,
  easy: 15,
  normal: 0,
  hard: -15,
  very_hard: -30,
  heroic: -50,
};

export interface CheckResult {
  kind: "skill" | "attribute" | "opposed";
  roll: number;
  target: number;
  pass: boolean;
  /** target − roll: positive is a pass by that much, negative a fail by that much. */
  margin: number;
}

/** d100 ≤ skill + tier modifier. */
export function skillCheck(rng: Rng, skill: number, tier: Tier = "normal", modifier = 0): CheckResult {
  const roll = rng.die(100);
  const target = skill + TIER_MODIFIER[tier] + modifier;
  return { kind: "skill", roll, target, pass: roll <= target, margin: target - roll };
}

/** d10 ≤ attribute + modifier. */
export function attributeCheck(rng: Rng, attribute: number, modifier = 0): CheckResult {
  const roll = rng.die(10);
  const target = attribute + modifier;
  return { kind: "attribute", roll, target, pass: roll <= target, margin: target - roll };
}

/**
 * Opposed check: the actor's skill against a defender value (Sneak/Steal vs 10×PE, Speech vs trust + 5×IN).
 * The spec leaves the combining rule open; we centre it so that skill = defender gives 50%:
 * chance = skill − defender + 50 + tier, clamped to 5–95.
 */
export function opposedCheck(
  rng: Rng,
  skill: number,
  defender: number,
  tier: Tier = "normal",
  modifier = 0,
): CheckResult {
  const roll = rng.die(100);
  const target = Math.max(5, Math.min(95, skill - defender + 50 + TIER_MODIFIER[tier] + modifier));
  return { kind: "opposed", roll, target, pass: roll <= target, margin: target - roll };
}

/** Defender values for opposed checks (§5.4). */
export const perceptionDefence = (target: Special) => 10 * target.PE;
export const speechDefence = (target: Special, trustTowardActor: number) => trustTowardActor + 5 * target.IN;

// ─── Progression (§5.9) ───────────────────────────────────────────────────────

/** Level n needs n(n−1)/2 × 1000 XP. */
export const xpForLevel = (n: number) => ((n * (n - 1)) / 2) * 1000;

export function levelForXp(xp: number): number {
  let n = 1;
  while (xpForLevel(n + 1) <= xp) n++;
  return n;
}

// ─── Trade (§5.7) ─────────────────────────────────────────────────────────────

const clampPrice = (value: number, factor: number) =>
  Math.max(0, Math.round(value * Math.max(0.5, Math.min(2, factor))));

/** Buy price = value × (1 + (merchant Barter − buyer Barter) / 200), clamped to 0.5×–2×. */
export const buyPrice = (value: number, merchantBarter: number, buyerBarter: number) =>
  clampPrice(value, 1 + (merchantBarter - buyerBarter) / 200);

/** Sell price mirrors buy: value × (1 + (seller Barter − merchant Barter) / 200), clamped to 0.5×–2×. */
export const sellPrice = (value: number, sellerBarter: number, merchantBarter: number) =>
  clampPrice(value, 1 + (sellerBarter - merchantBarter) / 200);

// ─── Time (§5.5) ──────────────────────────────────────────────────────────────

/** Base minutes at AP 8, scaled by 8 / AP. A non-zero cost is at least one minute. */
export function actionMinutes(base: number, ap: number): number {
  if (base <= 0) return 0;
  return Math.max(1, Math.round((base * 8) / ap));
}
