import { describe, expect, it } from "vitest";
import { perform } from "../src/core/actions.js";
import { applyEffect } from "../src/core/effects.js";
import { makeNoise, propagate } from "../src/core/sound.js";
import { tick } from "../src/core/tick.js";
import type { World } from "../src/core/world.js";
import { COLLECTIONS, type Origins } from "../src/payload/loader.js";
import { Payload } from "../src/payload/schema.js";
import { checkPayload } from "../src/payload/validate.js";
import { parseCommand } from "../src/session/parser.js";
import { mini, world } from "./helpers.js";

const P = { by: "player" as const };
const B = { by: "behaviour" as const };

/**
 * The mini block with a loose board in the hall floor (underfoot, creaking, screwed down over a cavity with a letter
 * in it), a bar and a screwdriver, and Nell owning the key.
 */
function block(over: (p: Payload) => void = () => {}): Payload {
  const p = mini();
  p.rooms[0]!.map.rows = ["###D###", "#k...g#", "w.@fa.E", "#b.n.s#", "#######"];
  p.rooms[0]!.map.legend.f = { object: "board" };
  p.objects.push(
    {
      id: "board",
      name: "loose board",
      aliases: ["board"],
      location: "hall",
      scenery: true,
      description: "A board that sits proud.",
      affordances: ["underfoot", "container", "openable"],
      properties: { open: false, fastened: true },
      hidden_unless: { special: { PE: { gte: 9 } } },
      step_noise: { loudness: 5, sound: "a board creaking underfoot" },
      force: [
        { tools: ["screwdriver"], minutes: 20, noise: { loudness: 2, sound: "a screw squeaking" } },
        {
          tools: ["pry"],
          minutes: 5,
          noise: { loudness: 8, sound: "wood splitting" },
          text: "The board comes up with a crack.",
        },
      ],
    } as never,
    {
      id: "letter",
      name: "letter",
      location: "board",
      description: "A letter.",
      affordances: ["takeable"],
      properties: { mass: 0.01 },
    } as never,
    {
      id: "bar",
      name: "bar",
      location: "player",
      description: "A wrecking bar.",
      affordances: ["takeable"],
      tags: ["pry"],
      properties: { mass: 3 },
    } as never,
    {
      id: "screwdriver",
      name: "screwdriver",
      location: "kitchen",
      description: "A screwdriver.",
      affordances: ["takeable"],
      tags: ["screwdriver"],
      properties: { mass: 0.2 },
    } as never,
  );
  const parsed = Payload.parse(p);
  over(parsed);
  return Payload.parse(parsed);
}

function says(w: World): string {
  return w
    .drainOutput()
    .map((o) => o.text)
    .join("\n");
}

/** Nell steps out to the kitchen (without using the door, which may be locked). */
function away(w: World): void {
  w.state.objects.npc = { ...w.state.objects.npc!, location: "kitchen", pos: [2, 2] };
}

const log = (w: World, who: string) => (w.state.dayLogs[who] ?? []).map((e) => `(${e.kind}) ${e.text}`).join("\n");

describe("sound (§4.11)", () => {
  it("is heard plainly up close and muffled through a closed door", () => {
    const w = world(block());
    const reach = propagate(w, "bar", 8);
    expect(reach.get("hall")?.level).toBe(8);
    // Through the closed door into the kitchen: −4, and a little further from the bar.
    expect(reach.get("kitchen")!.level).toBeLessThan(5);
    perform(w, "player", { act: "open", target: "door" }, P);
    expect(propagate(w, "bar", 8).get("kitchen")!.level).toBeGreaterThan(reach.get("kitchen")!.level);
  });

  it("makes hearing an event: logged, told to the player, and reacted to", () => {
    const w = world(block());
    says(w);
    const heard = makeNoise(w, "window", { loudness: 6, sound: "glass rattling" }, B);
    expect(heard.sort()).toEqual(["npc", "player"]);
    expect(says(w)).toMatch(/You hear glass rattling\./);
    expect(log(w, "npc")).toMatch(/\(heard\) Heard glass rattling\./);
    expect(w.log.some((e) => e.kind === "heard" && e.actor === "npc" && e.targets[0] === "window")).toBe(true);
  });

  it("wakes sleepers only when it's loud", () => {
    const w = world(block());
    perform(w, "npc", { act: "sleep" }, B);
    makeNoise(w, "window", { loudness: 4, sound: "a tap" }, B);
    expect(w.char("npc").asleepUntil).not.toBeNull();
    makeNoise(w, "window", { loudness: 9, sound: "a crash" }, B);
    expect(w.char("npc").asleepUntil).toBeNull();
    expect(log(w, "npc")).toMatch(/Heard a crash/);
  });

  it("never lets NPCs hear apparitions (Q31)", () => {
    const w = world(block());
    const heard = makeNoise(w, "ghost", { loudness: 8, sound: "a sigh" }, B);
    expect(heard).toEqual(["player"]);
  });

  it("creaks underfoot: you can walk over the board, and hearing it close by finds it", () => {
    const w = world(block());
    expect(w.isHidden("board")).toBe(true);
    says(w);
    const r = perform(w, "player", { act: "step", direction: "east" }, P);
    expect(r.ok).toBe(true);
    expect(w.state.objects.player?.pos).toEqual([3, 2]);
    expect(says(w)).toMatch(/You hear a board creaking underfoot/);
    expect(w.isHidden("board")).toBe(false);
    expect(log(w, "npc")).toMatch(/Heard a board creaking underfoot/);
  });
});

describe("forcing (§4.12)", () => {
  it("won't open while fastened, and any tool with the right tag forces it", () => {
    const w = world(block());
    w.state.objects.board!.props.revealed = true;
    says(w);
    expect(perform(w, "player", { act: "open", target: "board" }, P).ok).toBe(false);
    expect(says(w)).toMatch(/fastened down/);
    const r = perform(w, "player", { act: "use", item: "bar", on: "board" }, P);
    expect(r.ok).toBe(true);
    expect(r.minutes).toBe(5);
    expect(w.prop("board", "fastened")).toBe(false);
    expect(w.prop("board", "open")).toBe(true);
    expect(w.prop("board", "forced")).toBe(true);
    const out = says(w);
    expect(out).toMatch(/comes up with a crack/);
    expect(out).toMatch(/Inside: the letter/);
    // Loud: Nell hears wood splitting, and saw who did it.
    tick(w, 0);
    expect(log(w, "npc")).toMatch(/Heard wood splitting/);
    expect(log(w, "npc")).toMatch(/Pat forced the loose board with the bar/);
    expect(perform(w, "player", { act: "use", item: "bar", on: "board" }, P).ok).toBe(false);
  });

  it("picks the method by the tool: a screwdriver is slow and quiet", () => {
    const w = world(block());
    w.state.objects.board!.props.revealed = true;
    w.state.objects.screwdriver!.location = "player";
    const r = perform(w, "player", { act: "use", item: "screwdriver", on: "board" }, P);
    expect(r.minutes).toBe(20);
    expect(log(w, "npc")).not.toMatch(/Heard/);
  });

  it("refuses tools that don't fit, and a failed check takes the time but does nothing", () => {
    const w = world(
      block((p) => {
        const board = p.objects.find((o) => o.id === "board")!;
        board.force = [{ tools: ["pry"], minutes: 7, check: { attribute: "ST", modifier: -20 }, effects: [] }];
      }),
    );
    w.state.objects.board!.props.revealed = true;
    w.state.objects.mug!.location = "player";
    expect(perform(w, "player", { act: "use", item: "mug", on: "board" }, P).ok).toBe(false);
    const r = perform(w, "player", { act: "use", item: "bar", on: "board" }, P);
    expect(r).toMatchObject({ ok: false, minutes: 7 });
    expect(w.prop("board", "fastened")).toBe(true);
  });

  it("forces a locked door open for good: it can't be locked again", () => {
    const w = world(
      block((p) => {
        const door = p.objects.find((o) => o.id === "door")!;
        door.properties.locked = true;
        door.force = [{ tools: ["pry"], minutes: 3, effects: [] }];
      }),
    );
    expect(perform(w, "player", { act: "go", direction: "north" }, P).ok).toBe(false);
    expect(perform(w, "player", { act: "use", item: "bar", on: "door" }, P).ok).toBe(true);
    expect(w.prop("door", "open")).toBe(true);
    perform(w, "player", { act: "close", target: "door" }, P);
    w.state.objects.key!.location = "player";
    expect(perform(w, "player", { act: "lock", target: "door" }, P).ok).toBe(false);
    expect(perform(w, "player", { act: "go", direction: "north" }, P).ok).toBe(true);
  });

  it("parses pry, prise, force and unscrew, finding a tool in hand", () => {
    const w = world(block());
    w.state.objects.board!.props.revealed = true;
    expect(parseCommand(w, "pry up the board with the bar")).toMatchObject({
      ok: true,
      intent: { action: { act: "use", item: "bar", on: "board" } },
    });
    expect(parseCommand(w, "force board")).toMatchObject({ intent: { action: { act: "use", item: "bar" } } });
    expect(parseCommand(w, "lift board")).toMatchObject({ intent: { action: { act: "use", item: "bar" } } });
    w.state.objects.bar!.location = "kitchen";
    expect(parseCommand(w, "lift board")).toMatchObject({ intent: { action: { act: "open", target: "board" } } });
    expect(parseCommand(w, "unscrew board")).toMatchObject({ ok: false });
  });
});

describe("ownership (§4.13)", () => {
  const owned = (permitted?: Payload["objects"][number]["permitted"]) =>
    block((p) => {
      const key = p.objects.find((o) => o.id === "key")!;
      key.owner = "npc";
      if (permitted) key.permitted = permitted;
    });

  it("taking what isn't yours in front of someone is a transgression", () => {
    const w = world(owned());
    const before = w.relationship("npc", "player").trust;
    perform(w, "player", { act: "take", item: "key" }, P);
    expect(w.log.some((e) => e.kind === "transgression" && e.actor === "player")).toBe(true);
    expect(w.relationship("npc", "player").trust).toBe(before - 20);
    expect(log(w, "npc")).toMatch(/Saw Pat take my key without asking/);
  });

  it("isn't one when you're permitted, or nobody sees", () => {
    const w = world(owned({ relationship: { who: "npc", with: "self", trust: { gte: 5 } } }));
    perform(w, "player", { act: "take", item: "key" }, P);
    expect(w.log.some((e) => e.kind === "transgression")).toBe(false);
    const w2 = world(owned());
    away(w2);
    perform(w2, "player", { act: "take", item: "key" }, P);
    expect(w2.log.some((e) => e.kind === "transgression")).toBe(false);
  });

  it("owners notice what's gone from its place, and what's been forced", () => {
    const w = world(
      block((p) => {
        p.objects.find((o) => o.id === "key")!.owner = "npc";
        const door = p.objects.find((o) => o.id === "door")!;
        door.owner = "npc";
        door.properties.locked = true;
        door.force = [{ tools: ["pry"], minutes: 3, effects: [] }];
      }),
    );
    away(w);
    perform(w, "player", { act: "take", item: "key" }, P);
    perform(w, "player", { act: "use", item: "bar", on: "door" }, P);
    tick(w, 1);
    expect(w.log.some((e) => e.kind === "noticed-missing")).toBe(false);
    perform(w, "npc", { act: "go", to: "hall" }, B);
    tick(w, 1);
    const kinds = w.log.filter((e) => e.actor === "npc").map((e) => e.kind);
    expect(kinds).toContain("noticed-missing");
    expect(kinds).toContain("noticed-damage");
    expect(log(w, "npc")).toMatch(/Noticed the key was missing/);
    // Noticed once, until it's put right.
    tick(w, 15);
    expect(w.log.filter((e) => e.kind === "noticed-missing")).toHaveLength(1);
  });
});

describe("ownership: what you carry (§4.13)", () => {
  it("misses something lifted from your pocket in your sleep, once you wake", () => {
    const w = world(
      block((p) => {
        p.objects.push({
          id: "purse",
          name: "purse",
          location: "npc",
          owner: "npc",
          description: "A purse.",
          affordances: ["takeable"],
        } as never);
      }),
    );
    perform(w, "npc", { act: "sleep" }, B);
    perform(w, "player", { act: "steal", item: "purse", from: "npc" }, P);
    expect(w.holderOf("purse")).toBe("player");
    tick(w, 1);
    expect(w.log.some((e) => e.kind === "noticed-missing")).toBe(false);
    w.state.chars.npc!.asleepUntil = null;
    tick(w, 1);
    expect(w.log.some((e) => e.kind === "noticed-missing" && e.actor === "npc")).toBe(true);
  });
});

describe("effects", () => {
  it("adjust_property adds to a number", () => {
    const w = world(block());
    applyEffect(w, { adjust_property: { object: "anvil", key: "dents", by: 2 } }, B);
    applyEffect(w, { adjust_property: { object: "anvil", key: "dents", by: -1 } }, B);
    expect(w.prop("anvil", "dents")).toBe(1);
  });

  it("noise is an effect behaviours and triggers can use", () => {
    const w = world(block());
    applyEffect(w, { noise: { source: "window", loudness: 6, sound: "the wind" } }, B);
    expect(log(w, "npc")).toMatch(/Heard the wind/);
  });
});

describe("reading (§4.13)", () => {
  it("teaches the player what they read, and leaves a character to weigh it", () => {
    const w = world(
      block((p) => {
        p.objects.find((o) => o.id === "coin")!.teaches = ["coin-is-old"];
      }),
    );
    w.state.objects.coin!.location = "hall";
    perform(w, "player", { act: "examine", target: "coin" }, P);
    expect(w.believes("player", "coin-is-old")).toBe(true);
    expect(w.char("player").beliefs.find((b) => b.id === "coin-is-old")?.source).toBe("coin");
    // A character's reading is reconciled with their beliefs by the narrative layer (tests/narrative.test.ts).
    perform(w, "npc", { act: "examine", target: "coin" }, B);
    expect(w.believes("npc", "coin-is-old")).toBe(false);
    expect(w.signals).toContainEqual({ kind: "read", who: "npc", thing: "coin" });
  });

  it("records who has read a document, whatever they believe (the read condition)", () => {
    const w = world(
      block((p) => {
        p.objects.find((o) => o.id === "coin")!.teaches = ["coin-is-old"];
      }),
    );
    w.state.objects.coin!.location = "hall";
    const read = { read: { who: "npc", document: "coin" } };
    expect(w.cond(read)).toBe(false);
    perform(w, "npc", { act: "examine", target: "coin" }, B);
    expect(w.cond(read)).toBe(true);
    expect(w.believes("npc", "coin-is-old")).toBe(false);
    // Once only, and nothing is recorded for things that teach nothing.
    perform(w, "npc", { act: "examine", target: "coin" }, B);
    perform(w, "npc", { act: "examine", target: "anvil" }, B);
    expect(w.char("npc").read).toEqual(["coin"]);
  });
});

describe("validation", () => {
  it("checks owners, step noises and force tools", () => {
    const p = block((p) => {
      p.objects.find((o) => o.id === "key")!.owner = "nobody";
      p.objects.find((o) => o.id === "anvil")!.step_noise = { loudness: 3, sound: "clank" };
      p.objects.find((o) => o.id === "window")!.force = [{ tools: ["laser"], minutes: 1, effects: [] }];
    });
    const origins = {
      root: "",
      game: "game.yaml",
      story: "story.yaml",
      combat_text: "c.yaml",
      entities: Object.fromEntries(COLLECTIONS.map((c) => [c, []])),
    };
    const msgs = checkPayload(p, origins as unknown as Origins).map((i) => i.message);
    expect(msgs).toContain("owner 'nobody' is not a character");
    expect(msgs.some((m) => /step_noise never sounds/.test(m))).toBe(true);
    expect(msgs.some((m) => /tags laser/.test(m))).toBe(true);
  });
});
