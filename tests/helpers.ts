import { fileURLToPath } from "node:url";
import { World } from "../src/engine/core/world.js";
import { Payload, type PayloadInput } from "../src/engine/payload/schema.js";
import { loadPayload, validatePayloadAt } from "../src/hosts/node/payload.js";

export const EXAMPLE = fileURLToPath(new URL("../examples/carver-street", import.meta.url));

export function example(): Payload {
  const r = validatePayloadAt(EXAMPLE);
  if (!r.payload || !r.ok) throw new Error(`example payload invalid: ${JSON.stringify(r.issues)}`);
  return r.payload;
}

/** A small payload: two rooms joined by a door, the player, one NPC and a few objects. Override any part. */
export function mini(over: Partial<PayloadInput> = {}): Payload {
  const base: PayloadInput = {
    game: {
      id: "mini",
      title: "Mini",
      schema_version: "2.0",
      start: "hall",
      player: { character: "player" },
      clock: { time: "08:00" },
    },
    story: { synopsis: "A test block.", endings: [{ id: "end", when: { flag: "done" }, text: "The end." }] },
    rooms: [
      {
        id: "hall",
        name: "Hall",
        description: "A hall.",
        exits: [
          { direction: "north", to: "kitchen", via: "door" },
          { direction: "east", blocked: "The ring road. The block ends here." },
        ],
        map: {
          rows: ["###D###", "#k...g#", "w.@.a.E", "#b.n.s#", "#######"],
          legend: {
            D: { exit: "north" },
            E: { exit: "east" },
            k: { object: "key" },
            g: { object: "ghost" },
            w: { object: "window" },
            a: { object: "anvil" },
            b: { object: "box" },
            s: { object: "secret" },
            n: { character: "npc" },
            "@": { character: "player" },
          },
        },
      },
      {
        id: "kitchen",
        name: "Kitchen",
        description: "A kitchen.",
        exits: [{ direction: "south", to: "hall", via: "door" }],
        map: {
          rows: ["#####", "#B.l#", "#...#", "##S##"],
          legend: { B: { object: "bed" }, l: { object: "bell" }, S: { exit: "south" } },
        },
      },
    ],
    objects: [
      {
        id: "door",
        name: "door",
        location: "hall",
        scenery: true,
        description: "A door.",
        affordances: ["openable", "lockable"],
        key: "key",
        properties: { open: false, locked: false },
      },
      {
        id: "key",
        name: "key",
        location: "hall",
        description: "A key.",
        affordances: ["takeable"],
        properties: { mass: 0.1 },
      },
      {
        id: "anvil",
        name: "anvil",
        location: "hall",
        description: "An anvil.",
        affordances: ["takeable"],
        properties: { mass: 500 },
      },
      {
        id: "mug",
        name: "mug",
        location: "player",
        description: "A mug.",
        affordances: ["takeable"],
        properties: { mass: 2 },
      },
      {
        id: "window",
        name: "window",
        location: "hall",
        scenery: true,
        description: "A window.",
        break_at: 10,
        properties: {},
      },
      {
        id: "box",
        name: "box",
        location: "hall",
        description: "A box.",
        affordances: ["container", "openable", "takeable"],
        properties: { open: false, mass: 1 },
        uses: [{ on: "coin", text: "You rattle the coin in the box.", effects: [{ set_flag: "rattled" }] }],
      },
      {
        id: "coin",
        name: "coin",
        location: "box",
        description: "A coin.",
        affordances: ["takeable"],
        properties: { mass: 0.01, value: 5 },
      },
      {
        id: "bell",
        name: "bell",
        location: "kitchen",
        description: "A bell marked END.",
        uses: [{ text: "Ding.", effects: [{ set_flag: "done" }] }],
      },
      { id: "bed", name: "bed", location: "kitchen", scenery: true, description: "A bed.", affordances: ["sleepable"] },
      { id: "ghost", name: "ghost", location: "hall", description: "A ghost.", perceived_by: "player" },
      {
        id: "secret",
        name: "secret note",
        location: "hall",
        description: "A note.",
        affordances: ["takeable"],
        hidden_unless: { special: { PE: { gte: 8 } } },
      },
    ],
    characters: [
      {
        id: "player",
        name: "Pat",
        description: "You.",
        persona: { identity: "The player." },
        special: { ST: 5, PE: 5, EN: 5, CH: 5, IN: 5, AG: 5, LK: 5 },
        money: 10,
      },
      {
        id: "npc",
        name: "Nell",
        location: "hall",
        description: "Nell.",
        persona: { identity: "Nell, a neighbour." },
        special: { ST: 5, PE: 5, EN: 5, CH: 5, IN: 5, AG: 5, LK: 5 },
        goals: ["Be left alone."],
        relationships: { player: { trust: 10, affinity: 10 } },
      },
    ],
    combat_text: {
      unarmed: { hit: "{{Attacker}} hits {{target}}.", miss: "Miss.", crit: "Crit!", down: "{{Target}} drops." },
    },
  };
  return Payload.parse({ ...base, ...over });
}

export function world(p: Payload = mini(), seed = "test"): World {
  return World.create(p, seed);
}

export { loadPayload };
