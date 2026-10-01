import { describe, expect, it } from "vitest";
import { damage, hitChance, UNARMED } from "../src/mechanics/combat-math.js";
import { Rng, seedState } from "../src/mechanics/rng.js";
import {
  actionMinutes,
  actionPoints,
  attributeCheck,
  buyPrice,
  carryCapacity,
  collapses,
  effectiveSpecial,
  fatiguePenalty,
  levelForXp,
  maxHp,
  opposedCheck,
  sellPrice,
  skillBase,
  skillCheck,
  skillValue,
  xpForLevel,
} from "../src/mechanics/special.js";

const avg = { ST: 5, PE: 5, EN: 5, CH: 5, IN: 5, AG: 5, LK: 5 };

describe("seeded PRNG", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = new Rng(seedState("x"));
    const b = new Rng(seedState("x"));
    const c = new Rng(seedState("y"));
    const seqA = Array.from({ length: 5 }, () => a.die(100));
    expect(Array.from({ length: 5 }, () => b.die(100))).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.die(100))).not.toEqual(seqA);
  });
  it("rolls within bounds", () => {
    const r = new Rng(seedState("bounds"));
    for (let i = 0; i < 1000; i++) {
      const d = r.die(10);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(10);
    }
  });
});

describe("derived statistics (§5.2)", () => {
  it("follows the Fallout 2 baseline", () => {
    expect(maxHp(avg, 1)).toBe(15 + 5 + 10);
    expect(maxHp(avg, 3)).toBe(30 + 2 * (2 + 2));
    expect(actionPoints(avg)).toBe(7);
    expect(actionPoints({ ...avg, AG: 10 })).toBe(10);
    expect(carryCapacity(avg)).toBe(66);
  });
});

describe("skills (§5.3)", () => {
  it("computes bases, tags and points", () => {
    expect(skillBase("unarmed", avg)).toBe(50);
    expect(skillBase("speech", avg)).toBe(25);
    const tagged = skillValue("speech", { special: avg, tags: ["speech"], points: { speech: 3 }, modifiers: [] });
    expect(tagged).toBe(25 + 20 + 6);
    const plain = skillValue("barter", {
      special: avg,
      tags: [],
      points: { barter: 3 },
      modifiers: [{ id: "m", skill: "barter", amount: -5 }],
    });
    expect(plain).toBe(20 + 3 - 5);
  });
});

describe("checks (§5.4)", () => {
  it("passes when the roll is at or under the target, reporting the margin", () => {
    const r = skillCheck(new Rng(seedState("c")), 50, "normal");
    expect(r.pass).toBe(r.roll <= 50);
    expect(r.margin).toBe(50 - r.roll);
    expect(skillCheck(new Rng(seedState("c")), 50, "trivial").target).toBe(80);
    expect(skillCheck(new Rng(seedState("c")), 50, "heroic").target).toBe(0);
  });
  it("attribute checks use d10", () => {
    const r = attributeCheck(new Rng(seedState("a")), 6, -1);
    expect(r.target).toBe(5);
    expect(r.roll).toBeGreaterThanOrEqual(1);
    expect(r.roll).toBeLessThanOrEqual(10);
  });
  it("opposed checks centre on 50% and clamp to 5–95", () => {
    expect(opposedCheck(new Rng(seedState("o")), 50, 50).target).toBe(50);
    expect(opposedCheck(new Rng(seedState("o")), 0, 100).target).toBe(5);
    expect(opposedCheck(new Rng(seedState("o")), 200, 0).target).toBe(95);
  });
});

describe("combat formulas (§5.6)", () => {
  it("clamps hit chance and penalises low ST", () => {
    expect(hitChance(300, 5, UNARMED, 5)).toBe(95);
    expect(hitChance(0, 5, UNARMED, 5)).toBe(5);
    expect(hitChance(80, 5, { ...UNARMED, min_st: 7 }, 5)).toBe(80 - 5 - 40);
  });
  it("applies DT, DR and criticals", () => {
    const armour = { ac: 0, dt: 2, dr: 50 };
    expect(damage(4, UNARMED, 1, armour, false)).toBe(Math.floor((4 + 1 - 2) * 0.5));
    expect(damage(4, UNARMED, 1, armour, true)).toBe(Math.floor((4 + 1) * 2 * 0.5));
    expect(damage(1, UNARMED, 0, { ac: 0, dt: 10, dr: 0 }, false)).toBe(0);
  });
});

describe("fatigue (§5.8)", () => {
  it("penalises AG and PE past waking hours, and collapses at +4", () => {
    const waking = (14 + 5) * 60;
    expect(fatiguePenalty(waking - 1, 5)).toBe(0);
    expect(fatiguePenalty(waking + 120, 5)).toBe(2);
    const s = effectiveSpecial(avg, [], waking + 120);
    expect(s.AG).toBe(3);
    expect(s.PE).toBe(3);
    expect(collapses(waking + 239, 5)).toBe(false);
    expect(collapses(waking + 240, 5)).toBe(true);
  });
  it("keeps attributes within 1–10", () => {
    const s = effectiveSpecial(avg, [
      { id: "m", attribute: "ST", amount: 9 },
      { id: "n", attribute: "CH", amount: -9 },
    ]);
    expect(s.ST).toBe(10);
    expect(s.CH).toBe(1);
  });
});

describe("progression and trade (§5.7, §5.9)", () => {
  it("uses Fallout's level curve", () => {
    expect(xpForLevel(2)).toBe(1000);
    expect(xpForLevel(3)).toBe(3000);
    expect(levelForXp(2999)).toBe(2);
    expect(levelForXp(3000)).toBe(3);
  });
  it("prices with Barter and clamps", () => {
    expect(buyPrice(100, 50, 50)).toBe(100);
    expect(buyPrice(100, 90, 10)).toBe(140);
    expect(buyPrice(100, 500, 0)).toBe(200);
    expect(sellPrice(100, 10, 90)).toBe(60);
  });
  it("scales action time by 8 / AP", () => {
    expect(actionMinutes(2, 8)).toBe(2);
    expect(actionMinutes(5, 5)).toBe(8);
    expect(actionMinutes(5, 10)).toBe(4);
    expect(actionMinutes(0, 5)).toBe(0);
  });
});
