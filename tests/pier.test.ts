import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { World } from "../src/core/world.js";
import { ScriptedProvider } from "../src/llm/scripted.js";
import { offlineProvider } from "../src/narrative/offline.js";
import type { Payload } from "../src/payload/schema.js";
import { validatePayloadAt } from "../src/payload/validate.js";
import type { TurnOutput } from "../src/session/port.js";
import { Session } from "../src/session/session.js";

/** The Pier (Q22): the first full example story, and the worked example of the authoring guide (§7.9). */
const PIER = fileURLToPath(new URL("../examples/the-pier", import.meta.url));

function pier(): Payload {
  const r = validatePayloadAt(PIER);
  if (!r.payload || !r.ok) throw new Error(`the-pier is invalid: ${JSON.stringify(r.issues)}`);
  return r.payload;
}

/** A scripted cast: whoever is offered a hook that hands Liam a piece of the story uses it. */
function provider() {
  const give = ["shaun-gives-rattle", "marek-tells-of-room-seven"];
  return new ScriptedProvider({
    conversation: (req) => {
      const conv = req.system.find((s) => s.label === "conversation")?.text ?? "";
      const hook = give.find((h) => conv.includes(`- ${h}:`));
      return {
        line: hook ? "Here. Take it." : "Mm.",
        actions: [],
        hooks: hook ? [{ id: hook, args: [] }] : [],
        playerOptions: [],
      };
    },
    director: () => ({ narration: "The lamps hiss.", lines: [], castActions: [], effects: [], hooks: [], targets: [] }),
    "day-summary": () => ({ summary: "Another day on the site." }),
  });
}

const text = (o: TurnOutput) =>
  o.views
    .map((v) => (v.type === "narration" || v.type === "ended" ? v.text : v.type === "room" ? `[${v.room.name}]` : ""))
    .join("\n");

/** Plays commands; `"> text"` picks the conversation option whose text starts with `text`. */
async function play(session: Session, w: World, steps: string[]): Promise<string> {
  let log = "";
  for (const step of steps) {
    let out: TurnOutput;
    if (step.startsWith("> ")) {
      const want = step.slice(2);
      const index = w.state.conversation?.options.findIndex((o) => o.text.startsWith(want)) ?? -1;
      if (index < 0) throw new Error(`no option "${want}" in ${JSON.stringify(w.state.conversation?.options)}`);
      out = await session.handle({ type: "option", index });
    } else {
      out = await session.handle({ type: "command", text: step });
    }
    log += `\n> ${step}\n${text(out)}`;
    if (session.mode === "ended") break;
  }
  return log;
}

const leave = "> [Leave]";

// Every piece of the story, in the order a curious player might find them: the register behind the panelling, the
// pier archive through Edith, the rattle from Shaun, then Room 7 on day two, and the glass house on night three.
const FULL = [
  // Day 1
  "down",
  "north",
  "east",
  "take crowbar",
  "in",
  "use crowbar on panelling",
  "examine register",
  "out",
  "west",
  "north",
  "talk to edith",
  "> Mr and Mrs Ashdown",
  "unlock cupboard",
  "open cupboard",
  "examine newspaper",
  "south",
  "wait until 13:30",
  "west",
  "talk to shaun",
  "> Find anything old",
  leave,
  "examine rattle",
  "east",
  "south",
  "take matches",
  "up",
  "wait until 21:30",
  "sleep",
  // Day 2 (obsession). Clara at the foot of the bed in the small hours.
  "wait until 07:40",
  "down",
  "north",
  "east",
  "take petrol can",
  "cabin",
  "take room 7 key",
  "out",
  "in",
  "up",
  "unlock door",
  "east",
  "open floorboard",
  "examine letter",
  "west",
  "down",
  "out",
  "west",
  "south",
  "up",
  "wait until 21:30",
  "sleep",
  // Day 3 (breakdown): the glass house.
  "wait until 21:30",
  "down",
  "north",
  "north",
  "over",
  "north",
  "in",
  "use petrol can on deckchairs",
  "use matches on deckchairs",
];

describe("The Pier (Q22, §7.9)", () => {
  it("validates with no errors or warnings", () => {
    const r = validatePayloadAt(PIER);
    expect(r.issues).toEqual([]);
  });

  it("plays to the full-understanding ending, the madness advancing with each piece", async () => {
    const w = World.create(pier(), "pier-full");
    const session = new Session(w, { provider: provider() });
    session.start();
    const log = await play(session, w, FULL);
    expect(log).toMatch(/Mr & Mrs E\. Ashdown & infant/);
    expect(log).toMatch(/PAVILION TRAGEDY/);
    expect(log).toMatch(/ALICE · 9th JUNE 1893/);
    expect(log).toMatch(/The child came still/);
    expect(log).toMatch(/standing at the foot of the bed/);
    for (const f of ["unease", "obsession", "breakdown", "clue_rattle", "glass_house_burned"]) {
      expect(w.state.flags[f], f).toBe(true);
    }
    expect(w.char("player").modifiers.find((m) => m.id === "madness-pe")?.amount).toBe(4);
    expect(session.mode).toBe("ended");
    expect(w.state.ended?.ending).toBe("the-glass-house");
    expect(w.state.ended?.text).toMatch(/There has always been a cup for you/);
  });

  it("keeps the ghosts out of everyone else's world (Q31)", async () => {
    const w = World.create(pier(), "pier-ghosts");
    const session = new Session(w, { provider: offlineProvider() });
    session.start();
    // Tommo eats his chips on the parade while the woman in black stands at the rail.
    await play(session, w, ["down", "north", "wait until 12:45", "examine woman", "attack woman", "wait until 13:20"]);
    expect(w.state.flags.saw_clara).toBe(true);
    expect(w.roomOf("clara")).toBeNull();
    expect(w.state.combat).toBeNull();
    for (const [who, log] of Object.entries(w.state.dayLogs)) {
      if (who === w.playerId) continue;
      expect(log.map((e) => e.text).join("\n"), who).not.toMatch(/woman in black/);
    }
    expect(w.char("clara").awakeMinutes).toBe(0);
  });

  it("forces the ending on the fifth night if Liam learns nothing (offline)", async () => {
    const w = World.create(pier(), "pier-stall");
    const session = new Session(w, { provider: offlineProvider() });
    session.start();
    const days = Array.from({ length: 4 }, () => ["wait until 21:30", "sleep"]).flat();
    await play(session, w, [...days, "wait until 22:45", "wait 60", "look", "wait 360"]);
    expect(w.state.flags.compelled).toBe(true);
    expect(w.state.flags.clue_register).toBeUndefined();
    expect(session.mode).toBe("ended");
    expect(w.state.ended?.text).toMatch(/you never learned their names/);
  });
});
