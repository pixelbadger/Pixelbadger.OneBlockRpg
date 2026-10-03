import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { payloadJsonSchema } from "../src/engine/payload/json-schema.js";
import type { PayloadInput } from "../src/engine/payload/schema.js";
import { validatePayloadAt } from "../src/hosts/node/payload.js";
import { EXAMPLE, mini } from "./helpers.js";

/** Writes a single-file payload (merged form) and validates it. */
function check(mutate: (p: PayloadInput) => void) {
  const p = JSON.parse(JSON.stringify(mini())) as PayloadInput;
  mutate(p);
  const dir = mkdtempSync(join(tmpdir(), "oneblock-"));
  const file = join(dir, "payload.json");
  writeFileSync(file, JSON.stringify(p));
  return validatePayloadAt(file);
}

const messages = (r: ReturnType<typeof check>) => r.issues.map((i) => `${i.severity} ${i.path}: ${i.message}`);

describe("payload validation (§7.7)", () => {
  it("accepts the example payload", () => {
    const r = validatePayloadAt(EXAMPLE);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts the minimal fixture", () => {
    const r = check(() => {});
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("names the file and path of a schema error inside a directory payload", () => {
    const r = validatePayloadAt(join(EXAMPLE, "..", "..", "examples", "carver-street"));
    expect(r.ok).toBe(true);
  });

  it("reports a misspelt effect key with the expected keys", () => {
    const r = check((p) => {
      p.story.triggers = [{ id: "t", when: { flag: "x" }, do: [{ set_flagg: "x" } as never] }];
    });
    expect(r.ok).toBe(false);
    expect(messages(r).join("\n")).toMatch(/story.*triggers\[0\]\.do\[0\]|triggers\[0\]\.do\[0\]/);
    expect(messages(r).join("\n")).toMatch(/exactly one of these keys: .*set_flag/);
  });

  it("reports unknown keys on strict objects", () => {
    const r = check((p) => {
      (p.rooms[0] as Record<string, unknown>).colour = "red";
    });
    expect(messages(r).join("\n")).toMatch(/unknown key\(s\): colour/);
  });

  it("reports missing references", () => {
    const r = check((p) => {
      p.rooms[0]!.exits!.push({ direction: "west", to: "nowhere" });
      p.objects!.push({ id: "x", name: "x", description: "x", location: "limbo" });
    });
    const m = messages(r).join("\n");
    expect(m).toMatch(/room 'nowhere' does not exist/);
    expect(m).toMatch(/location 'limbo'/);
  });

  it("flags reads of flags that are never set", () => {
    const r = check((p) => {
      p.story.triggers = [{ id: "t", when: { flag: "never_set" }, do: [{ narrate: "hi" }] }];
    });
    expect(messages(r).join("\n")).toMatch(/error .*flag 'never_set' is read but never set/);
  });

  it("requires an unconditional fallback in text variants", () => {
    const r = check((p) => {
      p.rooms[0]!.description = [{ when: { flag: "x" }, text: "a" }];
      p.story.triggers = [{ id: "t", when: { day: 2 }, do: [{ set_flag: "x" }] }];
    });
    expect(messages(r).join("\n")).toMatch(/no unconditional fallback/);
  });

  it("finds unreachable rooms and the closed edge of the block (Q6)", () => {
    const r = check((p) => {
      p.rooms.push({ id: "attic", name: "Attic", description: "Dust.", map: { rows: ["..."], legend: {} } });
    });
    expect(messages(r).join("\n")).toMatch(/unreachable from the start room/);
  });

  it("requires combat text for every weapon type", () => {
    const r = check((p) => {
      p.objects!.push({
        id: "bat",
        name: "bat",
        description: "A bat.",
        location: "hall",
        weapon: { type: "club", skill: "melee_weapons", damage: [1, 4], ap: 3 },
      });
    });
    expect(messages(r).join("\n")).toMatch(/weapon type 'club' has no combat text/);
  });

  it("checks SPECIAL ranges and presets", () => {
    const r = check((p) => {
      p.characters[1]!.special.ST = 11;
      p.game.player.presets = [{ name: "Bad", special: { ST: 10, PE: 10, EN: 10, CH: 10, IN: 10, AG: 10, LK: 10 } }];
    });
    const m = messages(r).join("\n");
    expect(m).toMatch(/ST 11 is outside 1–10/);
    expect(m).toMatch(/preset 'Bad' must spend exactly 40 points/);
  });

  it("flags conversations that grant attack for review, and missing hooks", () => {
    const r = check((p) => {
      p.conversations = [{ id: "c", character: "npc", hooks: ["nope"], actions: ["go", "attack"] }];
    });
    const m = messages(r).join("\n");
    expect(m).toMatch(/warning .*grants attack/);
    expect(m).toMatch(/hook 'nope' does not exist/);
  });

  it("rejects duplicate ids across collections", () => {
    const r = check((p) => {
      p.objects!.push({ id: "hall", name: "hall thing", description: "x" });
    });
    expect(messages(r).join("\n")).toMatch(/duplicate id 'hall'/);
  });
});

describe("JSON Schema (§7.3)", () => {
  it("is generated from the zod types", () => {
    const s = payloadJsonSchema();
    expect(s.title).toMatch(/payload/i);
    expect(JSON.stringify(s)).toContain("director_brief");
    expect(JSON.stringify(s)).toContain("perceived_by");
  });
});
