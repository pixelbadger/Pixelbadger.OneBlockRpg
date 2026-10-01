import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replaySave } from "../src/cli/main.js";
import { World } from "../src/core/world.js";
import { RecordingProvider, ScriptedProvider } from "../src/llm/scripted.js";
import { offlineProvider } from "../src/narrative/offline.js";
import type { Intent, TurnOutput } from "../src/session/port.js";
import { SaveStore } from "../src/session/save.js";
import { Session } from "../src/session/session.js";
import { example } from "./helpers.js";

/** A scripted Mrs Okafor: once the deed conversation is on offer, she takes it up. */
function provider() {
  return new ScriptedProvider({
    conversation: (req) => {
      const offered = req.system.some((s) => s.label === "conversation" && s.text.includes("take-up-the-deed"));
      return offered
        ? {
            line: "Give it to me. I know who to show.",
            hooks: [{ id: "take-up-the-deed", args: [] }],
            actions: [],
            playerOptions: [],
          }
        : { line: "Mm.", actions: [], hooks: [], playerOptions: [{ text: "Fine weather." }] };
    },
    "day-summary": () => ({ summary: "A long day." }),
  });
}

const text = (o: TurnOutput) =>
  o.views
    .map((v) =>
      v.type === "narration"
        ? v.text
        : v.type === "room"
          ? `[${v.room.name}]`
          : v.type === "conversation"
            ? v.options.map((x) => x.text).join(" | ")
            : "",
    )
    .join("\n");

async function play(session: Session, commands: string[]): Promise<string> {
  let log = "";
  for (const c of commands) {
    const out = await session.handle({ type: "command", text: c });
    log += `\n> ${c}\n${text(out)}`;
  }
  return log;
}

// The route to "The Block Holds": find Dev's letters while he's at the shop, slip into 3A while Pike is out on the
// landing, see that the deed is traced from the letters' signature, settle the rent and show Mrs Okafor.
const ROUTE = [
  "Talker",
  "wait until 09:01",
  "east",
  "down",
  "3",
  "east",
  "open floorboard",
  "take letters",
  "west",
  "wait until 10:05",
  "west",
  "open filing box",
  "take deed",
  "use deed on letters",
  "east",
  "down",
  "down",
  "talk to okafor",
  "2", // "I'll pay Friday."
  "talk to okafor",
];

describe("playthrough (§3.9)", () => {
  it("reaches an ending through typed commands, with a scripted provider", async () => {
    const w = World.create(example(), "playthrough");
    const session = new Session(w, { provider: provider() });
    expect(session.start().mode).toBe("create");
    const log = await play(session, ROUTE);
    // The deal is struck mid-conversation; the ending lands when the conversation closes.
    expect(session.mode).toBe("conversation");
    const leave = w.state.conversation!.options.findIndex((o) => o.kind === "leave");
    await session.handle({ type: "option", index: leave });
    expect(log).toContain("[Flat 3B]");
    expect(log).toMatch(/You take the bundle of unstamped letters/);
    expect(log).toMatch(/The D's don't match/);
    expect(w.believes("player", "pike-forged-deed")).toBe(true);
    expect(w.state.flags.promised_rent).toBe(true);
    expect(w.state.flags.sale_stopped).toBe(true);
    expect(session.mode).toBe("ended");
    expect(w.state.ended?.ending).toBe("the-block-holds");
  });

  it("plays offline, sleeps through a day boundary and writes the journal", async () => {
    const w = World.create(example(), "offline");
    const session = new Session(w, { provider: offlineProvider() });
    session.start();
    const log = await play(session, ["Bruiser", "take kettle", "drop kettle", "wait until 22:00", "sleep", "journal"]);
    expect(w.state.day).toBe(2);
    expect(log).toMatch(/You wake/);
    expect(w.state.summaries.player?.[0]?.text).toMatch(/kettle/);
    // Sleep closes the day first, so the night already counts as day 2: the dream fires (offline, its fallback).
    expect(w.state.callouts["dream-sequence"]).toMatch(/staircase/);
  });
});

describe("saves and replay (§3.7, §3.8, P11)", () => {
  it("saves every event, resumes to the same state, and replays identically from cassettes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oneblock-save-"));
    const path = join(dir, "game.db");
    const payload = example();
    const store = await SaveStore.open(path);
    const w = World.create(payload, "replay-me");
    store.init(payload, w, "scripted");
    store.attach(w);
    const session = new Session(w, {
      provider: new RecordingProvider(provider(), (c, req) => store.recordExchange(c, req)),
      onInput: (i: Intent) => store.recordInput(i),
    });
    session.start();
    for (const c of ROUTE.slice(0, 12)) {
      await session.handle({ type: "command", text: c });
      store.flush(w);
    }
    store.close();

    const reopened = await SaveStore.open(path);
    const loaded = reopened.load(payload);
    expect(loaded.state).toEqual(w.state);
    expect(loaded.log.length).toBe(w.log.length);

    const result = await replaySave(payload, reopened);
    expect(result.detail).toBeUndefined();
    expect(result.ok).toBe(true);
    reopened.close();
  });

  it("refuses a save from a different payload version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oneblock-save-"));
    const payload = example();
    const store = await SaveStore.open(join(dir, "g.db"));
    store.init(payload, World.create(payload, "x"), "scripted");
    const changed = { ...payload, game: { ...payload.game, version: "9.9.9" } };
    expect(() => store.load(changed)).toThrow(/does not declare it compatible/);
    expect(() =>
      store.load({ ...changed, game: { ...changed.game, compatible_with: [payload.game.version] } }),
    ).not.toThrow();
    store.close();
  });
});
