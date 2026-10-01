import { describe, expect, it } from "vitest";
import { BASE_MINUTES, perform, SNEAK_TIME, UNNOTICED_STEAL_BONUS } from "../src/core/actions.js";
import { playerCombat, pursuable, runCombat } from "../src/core/combat.js";
import { describeRoom } from "../src/core/describe.js";
import { applyEffects } from "../src/core/effects.js";
import { applyOps, clone } from "../src/core/ops.js";
import { tick } from "../src/core/tick.js";
import { initialState } from "../src/core/world.js";
import { parseCommand } from "../src/session/parser.js";
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
      // If Nell runs, let her go.
      const fled = w.state.combat.combatants.some((x) => x.id === "npc" && x.status === "fled");
      const out = playerCombat(w, fled ? { kind: "end" } : { kind: "attack", target: "npc" });
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

describe("sneaking (§5.4)", () => {
  /** A nimble, lucky player and a short-sighted Nell, or the reverse. */
  const sneakers = (playerAG: number, nellPE: number) => {
    const p = mini();
    p.characters[0]!.special = { ...p.characters[0]!.special, AG: playerAG, LK: playerAG };
    p.characters[0]!.tag_skills = playerAG > 5 ? ["sneak"] : [];
    p.characters[1]!.special = { ...p.characters[1]!.special, PE: nellPE };
    p.characters[1]!.behaviours = ["watch"];
    p.behaviours.push({
      id: "watch",
      rules: [
        {
          when: { event: { kind: "took", actor: "player" } },
          do: [{ set_flag: "nell_saw" }],
          once: false,
          priority: 0,
        },
      ],
    });
    return p;
  };

  it("hides an unnoticed sneaker's actions from NPC logs and behaviours, and takes longer", () => {
    const w = world(sneakers(10, 1), "quiet");
    tick(w, 0);
    expect(perform(w, "player", { act: "sneak" }, P).ok).toBe(true);
    expect(w.isSneaking("player")).toBe(true);
    expect(w.char("player").sneaking!.aware).toEqual([]);
    const r = perform(w, "player", { act: "take", item: "key" }, P);
    expect(r.minutes).toBe(1.5);
    expect(w.char("player").sneaking!.aware).toEqual([]);
    tick(w, 1);
    expect(w.perceives("npc", "player")).toBe(false);
    expect(w.scope("npc")).not.toContain("player");
    expect((w.state.dayLogs.npc ?? []).map((e) => e.text).join("\n")).not.toContain("took");
    expect(w.state.flags.nell_saw).toBeUndefined();
  });

  it("lets a sharp-eyed observer notice, and then see everything", () => {
    const w = world(sneakers(1, 10), "loud");
    tick(w, 0);
    perform(w, "player", { act: "sneak" }, P);
    perform(w, "player", { act: "take", item: "key" }, P);
    expect(w.char("player").sneaking!.aware).toContain("npc");
    expect(w.log.some((e) => e.kind === "noticed" && e.actor === "npc")).toBe(true);
    tick(w, 1);
    const log = (w.state.dayLogs.npc ?? []).map((e) => e.text).join("\n");
    expect(log).toContain("creeping about");
    expect(log).toContain("took");
    expect(w.state.flags.nell_saw).toBe(true);
  });

  it("ends with stop, and talking or attacking gives the sneaker away", () => {
    const w = world(sneakers(10, 1), "quiet");
    expect(perform(w, "player", { act: "sneak", stop: true }, P).ok).toBe(false);
    perform(w, "player", { act: "sneak" }, P);
    expect(perform(w, "player", { act: "sneak" }, P).ok).toBe(false);
    perform(w, "player", { act: "sneak", stop: true }, P);
    expect(w.isSneaking("player")).toBe(false);
    perform(w, "player", { act: "sneak" }, P);
    perform(w, "player", { act: "talk", target: "npc" }, P);
    expect(w.isSneaking("player")).toBe(false);
    expect(w.log.some((e) => e.kind === "sneak-ended" && e.payload.revealed === true)).toBe(true);
  });

  it("moves with a direction and re-rolls for the next room", () => {
    const w = world(sneakers(10, 1), "quiet");
    const r = perform(w, "player", { act: "sneak", direction: "north" }, P);
    expect(r.ok).toBe(true);
    expect(w.roomOf("player")).toBe("kitchen");
    expect(w.isSneaking("player")).toBe(true);
    expect(r.minutes).toBe(BASE_MINUTES.go * SNEAK_TIME);
  });

  it("hides an unnoticed NPC sneaker from the player", () => {
    const p = mini();
    p.characters[0]!.special = { ...p.characters[0]!.special, PE: 1 };
    p.characters[1]!.special = { ...p.characters[1]!.special, AG: 10, LK: 10 };
    p.characters[1]!.tag_skills = ["sneak"];
    const w = world(p, "quiet");
    perform(w, "npc", { act: "sneak" }, { by: "behaviour" });
    expect(w.perceives("player", "npc")).toBe(false);
    expect(describeRoom(w, "hall").people).toEqual([]);
    expect(w.scope("player")).not.toContain("npc");
  });

  it("gives an unnoticed thief a Steal bonus, and a caught thief is noticed", () => {
    const p = sneakers(10, 1);
    p.objects.push({
      id: "purse",
      name: "purse",
      location: "npc",
      description: "A purse.",
      affordances: ["takeable"],
      properties: { mass: 0.2 },
      aliases: [],
      behaviours: [],
      tags: [],
      uses: [],
      messages: {},
    });
    const w = world(p, "quiet");
    perform(w, "player", { act: "sneak" }, P);
    perform(w, "player", { act: "steal", item: "purse", from: "npc" }, P);
    const check = w.log.find((e) => e.kind === "checked" && e.payload.skill === "steal")!;
    const plain = w.skill("player", "steal") - 0 + 50 - 10 + 5;
    expect(check.payload.target).toBe(Math.min(95, plain + UNNOTICED_STEAL_BONUS));
  });
});

describe("parser: sneak (§3.2)", () => {
  it("toggles the stance and sneaks in a direction", () => {
    const w = world();
    expect(parseCommand(w, "sneak")).toEqual({ ok: true, intent: { type: "action", action: { act: "sneak" } } });
    expect(parseCommand(w, "sneak n")).toEqual({
      ok: true,
      intent: { type: "action", action: { act: "sneak", direction: "north" } },
    });
    perform(w, "player", { act: "sneak" }, P);
    expect(parseCommand(w, "sneak")).toEqual({
      ok: true,
      intent: { type: "action", action: { act: "sneak", stop: true } },
    });
    expect(parseCommand(w, "stop sneaking").ok).toBe(true);
  });
});

describe("pursuit (§5.6)", () => {
  /** Nell runs at the first blow; Brute (aggressive) can stand with the player. */
  const chase = (opts: { brute?: boolean } = {}) => {
    const p = mini();
    p.objects.find((o) => o.id === "door")!.properties.open = true;
    p.characters[1]!.combat_profile = { style: "coward", flee_at: 100 };
    p.characters[1]!.essential = true;
    if (opts.brute) {
      p.characters.push({
        ...p.characters[1]!,
        id: "brute",
        name: "Brute",
        combat_profile: { style: "aggressive" },
        relationships: { player: { trust: 50, affinity: 80, notes: "" } },
      });
    }
    return p;
  };

  it("lets the player follow a fleeing opponent, moving the fight", () => {
    const w = world(chase(), "chase");
    perform(w, "player", { act: "attack", target: "npc" }, P);
    let out = playerCombat(w, { kind: "end" });
    expect(out.ended).toBe(false);
    expect(w.char("npc") && w.roomOf("npc")).toBe("kitchen");
    expect(pursuable(w, "player").map((t) => t.id)).toEqual(["npc"]);
    out = playerCombat(w, { kind: "pursue", target: "npc" });
    expect(w.roomOf("player")).toBe("kitchen");
    expect(w.state.combat?.room).toBe("kitchen");
    expect(w.state.combat?.combatants.find((x) => x.id === "npc")?.status).toBe("in");
    expect(w.log.some((e) => e.kind === "pursued" && e.actor === "player")).toBe(true);
  });

  it("lets the escape stand if nobody follows before the order comes round", () => {
    const w = world(chase(), "chase");
    perform(w, "player", { act: "attack", target: "npc" }, P);
    playerCombat(w, { kind: "end" });
    expect(w.state.combat).not.toBeNull();
    const out = playerCombat(w, { kind: "end" });
    expect(out.ended).toBe(true);
    expect(w.state.combat).toBeNull();
    expect(w.roomOf("player")).toBe("hall");
  });

  it("has aggressive NPCs chase a fleeing player", () => {
    const p = mini();
    p.objects.find((o) => o.id === "door")!.properties.open = true;
    p.characters[1]!.combat_profile = { style: "aggressive" };
    p.characters[1]!.hostile = true;
    const w = world(p, "hunt");
    perform(w, "npc", { act: "attack", target: "player" }, { by: "behaviour" });
    runCombat(w);
    expect(w.char("player").status).toBe("ok");
    const out = playerCombat(w, { kind: "flee", direction: "north" });
    expect(out.ended).toBe(false);
    expect(w.roomOf("npc")).toBe("kitchen");
    expect(w.state.combat?.room).toBe("kitchen");
    expect(w.state.combat?.combatants.find((x) => x.id === "player")?.status).toBe("in");
  });

  it("leaves a player's ally behind when the player gives chase, and NPC allies leave the choice to the player", () => {
    const w = world(chase({ brute: true }), "ally");
    perform(w, "player", { act: "attack", target: "npc" }, P);
    playerCombat(w, { kind: "end" });
    expect(w.roomOf("brute")).toBe("hall");
    expect(pursuable(w, "player").map((t) => t.id)).toEqual(["npc"]);
    playerCombat(w, { kind: "pursue", target: "npc" });
    expect(w.state.combat?.combatants.find((x) => x.id === "brute")?.status).toBe("left");
  });
});
