/** Combat formulas (§5.6). */
import type { Armour, Weapon } from "../payload/schema.js";

export const AP_COST = {
  aimed: 1,
  reload: 2,
  useItem: 2,
  equip: 2,
  leave: 4,
  bark: 0,
} as const;

/** A round is 10 game seconds. */
export const ROUND_SECONDS = 10;

export const UNARMED: Weapon = {
  type: "unarmed",
  skill: "unarmed",
  damage: [1, 2],
  ap: 3,
  accuracy: 0,
  min_st: 1,
  ranged: false,
};

/**
 * Hit chance = weapon skill − target AC + accuracy − 20 per point of ST below minimum (+ the attacker's Luck nudge,
 * §5.1), clamped to 5–95%.
 */
export function hitChance(
  skill: number,
  targetAc: number,
  weapon: Weapon,
  attackerST: number,
  aimed = false,
  luck = 0,
): number {
  const stShort = Math.max(0, weapon.min_st - attackerST);
  const raw = skill - targetAc + weapon.accuracy - 20 * stShort + (aimed ? 15 : 0) + luck;
  return Math.max(5, Math.min(95, raw));
}

/**
 * Damage = (weapon roll + melee bonus for melee/unarmed − DT) × (1 − DR%), minimum 0.
 * A critical doubles damage and ignores DT.
 */
export function damage(
  roll: number,
  weapon: Weapon,
  meleeBonus: number,
  armour: Armour | undefined,
  critical: boolean,
) {
  const bonus = weapon.ranged ? 0 : meleeBonus;
  const dt = critical ? 0 : (armour?.dt ?? 0);
  const dr = armour?.dr ?? 0;
  const base = Math.max(0, roll + bonus - dt) * (critical ? 2 : 1);
  return Math.max(0, Math.floor(base * (1 - dr / 100)));
}

/** Thrown objects (§4.2, Q18): velocity is an abstract magnitude from Strength and mass. */
export function throwVelocity(ST: number, mass: number): number {
  return Math.max(1, Math.min(30, Math.round((ST * 4) / Math.max(0.25, mass))));
}

/** The heaviest thing a character can throw, in kg. */
export const maxThrowMass = (ST: number) => ST * 4;

/** An improvised weapon for a thrown object. */
export function thrownWeapon(mass: number, velocity: number): Weapon {
  const impact = mass * velocity;
  return {
    type: "thrown",
    skill: "throwing",
    damage: [1, Math.max(1, Math.round(impact / 4))],
    ap: 3,
    accuracy: 0,
    min_st: 1,
    ranged: true,
  };
}
