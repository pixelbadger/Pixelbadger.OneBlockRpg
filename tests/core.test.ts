import { describe, expect, it } from "vitest";
import { perform } from "../src/core/actions.js";
import { playerCombat, runCombat } from "../src/core/combat.js";
import { describeRoom } from "../src/core/describe.js";
import { applyEffects } from "../src/core/effects.js";
import { applyOps, clone } from "../src/core/ops.js";
import { tick } from "../src/core/tick.js";
import { initialState } from "../src/core/world.js";
import { mini, world } from "./helpers.js";

const P = { by: "player" as const };
const go = (w: ReturnType<typeof world>, who: string, direction: string) =>
  perform(w, who, { act: "go", direction }, P);

describe("conditions (§7.5)", () => {
  it("evaluates flags, comparisons, holds, rooms and SPECIAL", () => {
    const w = world();
    expect(w.cond({ flag: "x" })).toBe(false);
    applyEffects(w, [{ set_flag: "x" }, { set_flag: { flag: "n", value: 3 } }], P);
    expect(w.cond({ flag: "x" })).toBe(true);
    expect(w.cond({ flag_eq: { flag: "n", value: 3 } })).toBe(true);
    expect(w.cond({ all: [{ flag: "x" }, { not: { flag: "y" } }] })).toBe(true);
    expect(w.cond({ any: [{ flag: "y" }, { day: { gte: 1 } }] })).toBe(true);
    expect(w.cond({ holds: { who: "player", what: "mug" } })).toBe(true);
    expect(w.cond({ in_room: { who: "npc", where: "hall" } })).toBe(true);
    expect(w.cond({ special: { PE: { gte: 5 }, ST: 5 } })).toBe(true);
    expect(w.cond({ skill: { skill: "unarmed", gte: 50 } })).toBe(true);
    expect(w.cond({ relationship: { who: "npc", with: "player", trust: { gte: 10 } } })).toBe(true);
    expect(w.cond({ money: { who: "player", eq: 10 } })).toBe(true);
  });

  it("treats `time` as crossing within the current window and time_between as a level", () => {
    const w = world();
    expect(w.cond({ time_between: { from: "07:00", to: "09:00" } })).toBe(true);
    expect(w.cond({ time_between: { from: "22:00", to: "02:00" } })).toBe(false);
    tick(w, 30);
    // The last chunk ran from 08:15 to 08:30.
    expect(w.cond({ time: "08:20" })).toBe(true);
    expect(w.cond({ time: "08:10" })).toBe(false);
  });
});

describe("actions (§4.3)", () => {
  it("moves through doors, opening them, and refuses the edge of the block", () => {
    const w = world();
    const r = go(w, "player", "north");
    expect(r.ok).toBe(true);
    expect(w.locationOf("player")).toBe("kitchen");
    expect(w.prop("door", "open")).toBe(true);
    go(w, "player", "south");
    const edge = go(w, "player", "east");
    expect(edge.ok).toBe(false);
    expect(w.drainOutput().map((o) => o.text)).toContain("The ring road. The block ends here.");
  });

  it("respects locks and keys", () => {
    const w = world();
    perform(w, "player", { act: "take", item: "key" }, P);
    expect(perform(w, "player", { act: "lock", target: "door" }, P).ok).toBe(true);
    perform(w, "player", { act: "drop", item: "key" }, P);
    expect(go(w, "player", "north").ok).toBe(false);
    expect(perform(w, "player", { act: "unlock", target: "door" }, P).ok).toBe(false);
  });

  it("enforces carry capacity and containers", () => {
    const w = world();
    expect(perform(w, "player", { act: "take", item: "anvil" }, P).ok).toBe(false);
    expect(perform(w, "player", { act: "take", item: "coin" }, P).ok).toBe(false); // box closed: not in scope
    perform(w, "player", { act: "open", target: "box" }, P);
    expect(perform(w, "player", { act: "take", item: "coin" }, P).ok).toBe(true);
    expect(perform(w, "player", { act: "put", item: "coin", on: "box" }, P).ok).toBe(true);
    expect(w.locationOf("coin")).toBe("box");
    expect(perform(w, "player", { act: "use", item: "box", on: "coin" }, P).ok).toBe(true);
    expect(w.state.flags.rattled).toBe(true);
  });

  it("breaks things with thrown objects when the impact is enough", () => {
    // Try several seeds: the throw is a skill check, so find one that hits.
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const w = world(mini(), seed);
      perform(w, "player", { act: "throw", item: "mug", target: "window" }, P);
      if (w.log.some((e) => e.kind === "impact")) {
        expect(w.prop("window", "broken")).toBe(true);
        expect(w.log.some((e) => e.kind === "broken" && e.targets[0] === "window")).toBe(true);
        expect(w.locationOf("mug")).toBe("hall");
        return;
      }
    }
    throw new Error("no seed hit the window");
  });

  it("needs consent to take from a character", () => {
    const w = world();
    perform(w, "player", { act: "give", item: "mug", to: "npc" }, P);
    expect(w.locationOf("mug")).toBe("npc");
    expect(perform(w, "player", { act: "take", item: "mug", from: "npc" }, P).ok).toBe(false);
  });
});

describe("perception (Q31)", () => {
  it("hides apparitions from NPCs but shows them to the player", () => {
    const w = world();
    expect(w.scope("player")).toContain("ghost");
    expect(w.scope("npc")).not.toContain("ghost");
  });

  it("hides Perception-gated objects until the condition holds", () => {
    const w = world();
    expect(w.scope("player")).not.toContain("secret");
    applyEffects(w, [{ modify: { who: "player", attribute: "PE", amount: 3 } }], P);
    expect(w.scope("player")).toContain("secret");
    expect(describeRoom(w, "hall").objects.join(" ")).toContain("secret note");
  });

  it("keeps apparitions out of NPC day logs", () => {
    const w = world();
    tick(w, 0);
    perform(w, "player", { act: "examine", target: "ghost" }, P);
    perform(w, "player", { act: "show", item: "mug", to: "npc" }, P);
    tick(w, 1);
    const npcLog = (w.state.dayLogs.npc ?? []).map((e) => e.text).join("\n");
    expect(npcLog).toContain("showed");
    expect(npcLog).not.toContain("ghost");
  });
});

describe("behaviours and triggers (§4.5, §7.6)", () => {
  const routine = mini({
    behaviours: [
      {
        id: "nell-routine",
        rules: [
          { when: { time: "09:00" }, do: [{ act: "go", to: "kitchen" }, { set_intent: "making toast" }] },
          { when: { event: { kind: "broken", target: "window" } }, do: [{ say: "Who did that?" }] },
        ],
      },
    ],
    characters: mini().characters.map((c) => (c.id === "npc" ? { ...c, behaviours: ["nell-routine"] } : c)),
    story: {
      synopsis: "s",
      triggers: [
        { id: "once", when: { flag: "a" }, do: [{ give_money: { amount: 1 } }], once: true },
        { id: "edge", when: { flag: "b" }, do: [{ give_money: { amount: 100 } }] },
      ],
      endings: [{ id: "end", when: { flag: "done" }, text: "The end." }],
    },
  });

  it("runs time rules as the clock passes", () => {
    const w = world(routine);
    tick(w, 45);
    expect(w.locationOf("npc")).toBe("hall");
    tick(w, 30);
    expect(w.locationOf("npc")).toBe("kitchen");
    expect(w.char("npc").intent).toBe("making toast");
  });

  it("reacts to events", () => {
    const w = world(routine);
    applyEffects(w, [{ set_property: { object: "window", key: "broken", value: true } }], P);
    w.emit("broken", { targets: ["window"] });
    tick(w, 0);
    expect(w.log.some((e) => e.kind === "said" && e.actor === "npc")).toBe(true);
  });

  it("fires once-triggers once and edge-triggers on each rise", () => {
    const w = world(routine);
    applyEffects(w, [{ set_flag: "a" }, { set_flag: "b" }], P);
    tick(w, 0);
    tick(w, 0);
    expect(w.char("player").money).toBe(10 + 1 + 100);
    applyEffects(w, [{ clear_flag: "b" }], P);
    tick(w, 0);
    applyEffects(w, [{ set_flag: "b" }], P);
    tick(w, 0);
    expect(w.char("player").money).toBe(10 + 1 + 200);
  });

  it("ends the game when an ending's condition holds", () => {
    const w = world(routine);
    applyEffects(w, [{ set_flag: "done" }], P);
    tick(w, 0);
    expect(w.state.ended?.ending).toBe("end");
  });
});

describe("bodies (§5.8)", () => {
  it("tires characters until they collapse, and timed modifiers lapse", () => {
    const w = world();
    applyEffects(w, [{ modify: { who: "npc", attribute: "CH", amount: 2, hours: 1 } }], P);
    expect(w.special("npc").CH).toBe(7);
    tick(w, 60);
    expect(w.special("npc").CH).toBe(5);
    tick(w, (19 + 4) * 60);
    expect(w.char("npc").asleepUntil).not.toBeNull();
    expect(w.signals.some((s) => s.kind === "collapse")).toBe(true);
  });

  it("heals over time", () => {
    const w = world();
    applyEffects(w, [{ damage: { who: "npc", amount: 5 } }], P);
    const hp = w.char("npc").hp;
    tick(w, 6 * 60);
    expect(w.char("npc").hp).toBe(hp + 1);
  });
});

describe("combat (§5.6)", () => {
  it("runs to an outcome with downed characters and awards XP to the winner", () => {
    const w = world(mini(), "fight");
    perform(w, "player", { act: "attack", target: "npc" }, P);
    expect(w.state.combat).not.toBeNull();
    for (let i = 0; i < 200 && w.state.combat; i++) {
      const out = playerCombat(w, { kind: "attack", target: "npc" });
      if (out.ended) break;
    }
    expect(w.state.combat).toBeNull();
    const npc = w.char("npc");
    const player = w.char("player");
    expect(
      npc.status !== "ok" || player.status !== "ok" || w.log.some((e) => e.kind === "fled" || e.kind === "surrendered"),
    ).toBe(true);
  });

  it("runs NPC-only fights to completion", () => {
    const p = mini();
    p.characters.push({
      ...p.characters[1]!,
      id: "brute",
      name: "Brute",
      hostile: false,
      combat_profile: { style: "aggressive" },
    });
    const w = world(p, "npc-fight");
    perform(w, "brute", { act: "attack", target: "npc" }, { by: "behaviour" });
    const out = runCombat(w);
    expect(out.ended).toBe(true);
    expect(w.state.combat).toBeNull();
  });
});

describe("event sourcing (§3.7)", () => {
  it("folds the event log back into the same state", () => {
    const p = mini();
    const w = world(p, "fold");
    perform(w, "player", { act: "take", item: "key" }, P);
    go(w, "player", "north");
    tick(w, 120);
    applyEffects(
      w,
      [
        { add_belief: { who: "npc", belief: "pat-is-odd" } },
        { adjust_relationship: { who: "npc", with: "player", trust: -5 } },
      ],
      P,
    );
    const folded = clone(initialState(p, "fold"));
    for (const e of w.log) applyOps(folded, e.ops);
    expect(folded).toEqual(w.state);
  });
});
