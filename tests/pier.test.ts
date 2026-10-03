import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClock } from "../src/core/clock.js";
import { entitled } from "../src/core/ownership.js";
import { tick } from "../src/core/tick.js";
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
  "pry up floorboard with crowbar",
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
    for (const f of ["unease", "obsession", "breakdown", "glass_house_burned"]) {
      expect(w.state.flags[f], f).toBe(true);
    }
    for (const b of ["ashdowns-stayed", "stillborn-secret", "edmund-set-the-fire", "child-had-a-name"]) {
      expect(w.believes("player", b), b).toBe(true);
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
    expect(w.believes("player", "ashdowns-stayed")).toBe(false);
    expect(session.mode).toBe("ended");
    expect(w.state.ended?.text).toMatch(/you never learned their names/);
  });

  // ─── Emergent routes (no trigger knows about any of these) ───

  /** A fresh offline session on `seed`. */
  function fresh(seed: string) {
    const w = World.create(pier(), seed);
    const session = new Session(w, { provider: offlineProvider() });
    session.start();
    return { w, session };
  }

  const transgressions = (w: World) => w.log.filter((e) => e.kind === "transgression" && e.actor === "player");
  const dayLog = (w: World, who: string) => (w.state.dayLogs[who] ?? []).map((e) => e.text).join("\n");

  it("lets Marek hear the board, tell Liam, and lend the tools to lift it quietly", async () => {
    // Whether Marek hears the board on a given evening is a Perception roll: find an evening where he does.
    let found: { w: World; session: Session } | undefined;
    for (const seed of "abcdefghijklmnop".split("")) {
      const run = fresh(`board-${seed}`);
      // Gary is in the compound first thing; he'll lend the Room 7 key to a lad he trusts.
      await play(run.session, run.w, ["down", "north", "east", "wait until 07:35", "talk to gary"]);
      await play(run.session, run.w, ["> Have you got a key for Room 7?", leave, "cabin", "take room 7 key"]);
      await play(run.session, run.w, ["out", "in", "up", "wait until 18:50"]);
      if (run.w.believes("marek", "room-seven-creaks")) {
        found = run;
        break;
      }
    }
    expect(found, "Marek never heard the board").toBeDefined();
    const { w, session } = found!;
    expect(dayLog(w, "marek")).toMatch(/Heard a slow creak/);
    await play(session, w, ["talk to marek", "> You ever work here late?", leave]);
    expect(w.believes("player", "loose-board")).toBe(true);
    // Marek's toolbox is open to someone he trusts.
    await play(session, w, ["take screwdriver from toolbox", "unlock door", "east"]);
    for (let i = 0; i < 6 && w.prop("floorboard", "open") !== true; i++) await play(session, w, ["unscrew floorboard"]);
    expect(w.prop("floorboard", "open")).toBe(true);
    const log = await play(session, w, ["take letter", "examine letter"]);
    expect(log).toMatch(/The child came still/);
    expect(w.believes("player", "stillborn-secret")).toBe(true);
    expect(transgressions(w)).toEqual([]);
  });

  it("creaks under Liam's own foot, and that is how he finds it", async () => {
    const { w, session } = fresh("underfoot");
    await play(session, w, ["down", "north", "east", "cabin"]);
    w.state.objects["room-seven-key"]!.location = "player";
    await play(session, w, ["out", "in", "up", "unlock door", "east"]);
    expect(w.isHidden("floorboard")).toBe(true);
    const at = w.state.objects.player!.pos!;
    const board = w.state.objects.floorboard!.pos!;
    // Walk onto the board one step at a time.
    let log = "";
    for (let i = 0; i < 8 && (at[0] !== board[0] || at[1] !== board[1]); i++) {
      const p = w.state.objects.player!.pos!;
      const dx = Math.sign(board[0] - p[0]);
      const dy = Math.sign(board[1] - p[1]);
      const dir = `${dy < 0 ? "north" : dy > 0 ? "south" : ""}${dx < 0 ? "west" : dx > 0 ? "east" : ""}`;
      log += await play(session, w, [`step ${dir}`]);
      if (w.state.objects.player!.pos![0] === board[0] && w.state.objects.player!.pos![1] === board[1]) break;
    }
    expect(log).toMatch(/You hear a floorboard creak, hollow/);
    expect(w.isHidden("floorboard")).toBe(false);
  });

  it("notices a forced door on Gary's rounds, and a key taken from under his nose", async () => {
    const { w, session } = fresh("forced");
    await play(session, w, ["down", "north", "east", "take crowbar", "in", "up"]);
    for (let i = 0; i < 6 && w.prop("door-room-seven", "forced") !== true; i++) {
      await play(session, w, ["force door with crowbar"]);
    }
    expect(w.prop("door-room-seven", "forced")).toBe(true);
    // Stay on site (the compound) through Gary's 15:00 walk of the corridor.
    await play(session, w, ["down", "out", "wait until 15:20"]);
    expect(dayLog(w, "gary")).toMatch(/Somebody's forced the door to Room 7/);
    expect(w.log.some((e) => e.kind === "noticed-damage" && e.targets[0] === "door-room-seven")).toBe(true);
    // At 17:30 he's in the cabin: taking the key off his board in front of him, unasked, is a transgression.
    const before = w.relationship("gary", "player").trust;
    const log = await play(session, w, ["wait until 17:40", "cabin", "take room 7 key"]);
    expect(transgressions(w)).toHaveLength(1);
    expect(w.relationship("gary", "player").trust).toBeLessThanOrEqual(before - 20);
    expect(log).toMatch(/That's not yours/);
    expect(dayLog(w, "gary")).toMatch(/Saw Liam take my key to Room 7 without asking/);
  });

  it("carries on without him: skiving gets him sacked, Tommo finds the register, and Gary tells the pub", async () => {
    const { w, session } = fresh("skive");
    await play(session, w, ["wait until 21:00", "sleep", "wait until 10:30", "down", "north", "west"]);
    await play(session, w, ["wait until 19:20"]);
    expect(w.prop("timesheet", "sacked")).toBe(true);
    expect(w.prop("reception-panelling", "fastened")).toBe(false);
    expect(w.holderOf("guest-register")).toBe("gary");
    // He never read it, but he heard it, and it's enough.
    expect(w.believes("player", "ashdowns-stayed")).toBe(true);
    expect(w.state.flags.unease).toBe(true);
    // The site's tools are no longer his to take; Tommo still may.
    expect(entitled(w, "player", "crowbar")).toBe(false);
    expect(entitled(w, "tommo", "crowbar")).toBe(true);
    expect(dayLog(w, "gary")).toMatch(/Sacked Liam Doyle/);
  });

  it("has Gary tell the pub what he read even when he won't believe it (§6.11)", async () => {
    const w = World.create(pier(), "skive");
    // He reads it as a curiosity, nothing more.
    const unmoved = { reaction: "Old book. Edith'll love it.", accept: [], revise: [], thoughts: [] };
    const provider = offlineProvider().enqueue("reading", unmoved, unmoved, unmoved);
    const session = new Session(w, { provider });
    session.start();
    await play(session, w, ["wait until 21:00", "sleep", "wait until 10:30", "down", "north", "west"]);
    const log = await play(session, w, ["wait until 19:20"]);
    expect(w.hasRead("gary", "guest-register")).toBe(true);
    expect(w.believes("gary", "ashdowns-stayed")).toBe(false);
    expect(log).toMatch(/Never guess what Tommo dug out of the wall today/);
    expect(log).not.toMatch(/Some things don't change/);
    expect(w.believes("player", "ashdowns-stayed")).toBe(true);
    expect(w.log.find((e) => e.kind === "read")?.payload).toEqual({ accepted: [], rejected: ["ashdowns-stayed"] });
  });

  it("sends worried friends out onto the pier on the last night", () => {
    const w = World.create(pier(), "friends");
    w.state.flags.unease = true;
    w.state.flags.obsession = true;
    w.state.flags.breakdown = true;
    w.state.objects.kez!.location = "anchor";
    w.state.objects.player!.location = "anchor";
    tick(w, 0);
    expect(w.believes("kez", "liam-not-right")).toBe(true);
    w.state.objects.player!.location = "digs";
    w.state.clock = parseClock("21:20");
    w.state.windowFrom = w.state.clock;
    tick(w, 15);
    expect(w.roomOf("kez")).toBe("pier-head");
    expect(w.char("kez").intent).toMatch(/calling Liam's name/);
  });
});
