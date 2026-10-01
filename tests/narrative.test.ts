import { describe, expect, it } from "vitest";
import { tick } from "../src/core/tick.js";
import type { CompletionRequest } from "../src/llm/provider.js";
import { complete, toJsonSchema } from "../src/llm/provider.js";
import { type Cassette, RecordingProvider, ReplayProvider, ScriptedProvider } from "../src/llm/scripted.js";
import { runCallout } from "../src/narrative/callouts.js";
import { Conversations } from "../src/narrative/conversation.js";
import { Director } from "../src/narrative/director.js";
import { endDay } from "../src/narrative/memory.js";
import { CharacterTurn } from "../src/narrative/schemas.js";
import { mini, world } from "./helpers.js";

const turn = (over: Partial<CharacterTurn> = {}) => ({
  line: "Hm.",
  actions: [],
  hooks: [],
  playerOptions: [],
  ...over,
});

function convPayload() {
  const base = mini();
  return mini({
    characters: [...base.characters, { ...base.characters[1]!, id: "eve", name: "Eve", relationships: {} }],
    hooks: [
      {
        id: "tell-secret",
        description: "Tell the player the secret.",
        guard: { relationship: { who: "self", with: "player", trust: { gte: 50 } } },
        effects: [{ add_belief: { who: "player", belief: "the-secret" } }],
        once: true,
      },
      {
        id: "warm-up",
        description: "Trust the player more.",
        params: { amount: { type: "number", min: -10, max: 10 } },
        effects: [{ adjust_relationship: { who: "self", with: "player", trust: { $arg: "amount" } } }],
      },
    ],
    conversations: [
      {
        id: "nell-chat",
        character: "npc",
        goals: ["Chat."],
        opening: "Nell looks up.",
        options: [
          { text: "Nice day.", effects: [] },
          {
            text: "Tell me a secret.",
            when: { special: { CH: { gte: 5 } } },
            check: { skill: "speech", tier: "easy" },
          },
          { text: "Bye then.", end: true },
        ],
        hooks: ["tell-secret", "warm-up"],
        actions: ["give", "go"],
      },
    ],
  });
}

describe("provider wrapper (§6.9)", () => {
  it("validates output, retries once, then reports failure", async () => {
    const p = new ScriptedProvider({}, { conversation: ["not json", { line: 5 }] });
    const r = await complete(p, {
      purpose: "conversation",
      system: [],
      messages: [{ role: "user", content: "hi" }],
      schema: CharacterTurn,
    });
    expect(r.ok).toBe(false);
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]!.messages.at(-1)!.content).toMatch(/could not be used/);
  });

  it("treats refusals as invalid output", async () => {
    const p = new ScriptedProvider({}, { conversation: [{ refusal: true }, turn()] });
    const r = await complete(p, {
      purpose: "conversation",
      system: [],
      messages: [{ role: "user", content: "hi" }],
      schema: CharacterTurn,
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it("produces a JSON Schema without unsupported keywords", () => {
    const s = JSON.stringify(toJsonSchema(CharacterTurn));
    expect(s).not.toContain("maxItems");
    expect(s).toContain("playerOptions");
  });

  it("records and replays exchanges by request hash", async () => {
    const tape: Cassette[] = [];
    const rec = new RecordingProvider(new ScriptedProvider({}, { callout: ["a dream"] }), (c) => tape.push(c));
    const req: CompletionRequest = {
      purpose: "callout",
      system: [{ label: "x", text: "sys" }],
      messages: [{ role: "user", content: "go" }],
    };
    await rec.generate(req);
    const replay = new ReplayProvider(tape);
    expect((await replay.generate(req)).text).toBe("a dream");
    await expect(replay.generate(req)).rejects.toThrow(/no cassette/);
  });
});

describe("conversations (§6.2–6.6)", () => {
  it("opens with authored text, merges options and always offers Leave", async () => {
    const w = world(convPayload());
    const provider = new ScriptedProvider(
      {},
      {
        conversation: [
          turn({
            playerOptions: [
              { text: "nice day." },
              { text: "What's that smell?" },
              { text: "You're lying.", check: { skill: "speech", tier: "hard" } },
            ],
          }),
        ],
      },
    );
    const c = new Conversations({ w, provider });
    expect(await c.start("nell-chat")).toBe(true);
    const opts = w.state.conversation!.options.map((o) => o.text);
    expect(opts[0]).toBe("Nice day.");
    expect(opts[1]).toBe("[Speech] Tell me a secret.");
    expect(opts).toContain("What's that smell?");
    expect(opts).toContain("[Speech] You're lying.");
    expect(opts.filter((o) => o.toLowerCase() === "nice day.")).toHaveLength(1); // authored wins the tie
    expect(opts.at(-1)).toBe("[Leave]");
    // The context is ordered stable → volatile, with the cache breakpoint on the memory part.
    const sys = provider.calls[0]!.system;
    expect(sys.map((s) => s.label)).toEqual(["engine", "story", "character", "memory", "conversation"]);
    expect(sys.find((s) => s.cache)?.label).toBe("memory");
  });

  it("resolves allowed actions, refuses others, and reports results on the next turn", async () => {
    const w = world(convPayload());
    w.emit("relocated", { ops: [{ op: "set", path: ["objects", "key", "location"], value: "npc" }] });
    const provider = new ScriptedProvider(
      {},
      {
        conversation: [
          turn({
            actions: [
              { act: "give", item: "key", to: "player" },
              { act: "attack", target: "player" },
            ],
          }),
          turn(),
        ],
      },
    );
    const c = new Conversations({ w, provider });
    await c.start("nell-chat");
    expect(w.locationOf("key")).toBe("player");
    expect(w.state.combat).toBeNull();
    await c.choose(0);
    const second = provider.calls[1]!.messages[0]!.content;
    expect(second).toMatch(/gave the key to Pat/);
    expect(second).toMatch(/attack: not allowed/);
  });

  it("checks hook guards and arguments; constructed talk becomes ground only through hooks", async () => {
    const w = world(convPayload());
    const provider = new ScriptedProvider(
      {},
      {
        conversation: [
          turn({ hooks: [{ id: "tell-secret", args: [] }] }),
          turn({
            hooks: [
              { id: "warm-up", args: [{ name: "amount", value: 99 }] },
              { id: "tell-secret", args: [] },
            ],
          }),
          turn({ hooks: [{ id: "tell-secret", args: [] }] }),
        ],
      },
    );
    const c = new Conversations({ w, provider });
    await c.start("nell-chat");
    expect(w.believes("player", "the-secret")).toBe(false); // trust 10 < 50
    expect(w.state.conversation!.results.join(" ")).toMatch(/refused/);
    await c.choose(0);
    // warm-up clamps to +10 → trust 20; still short of the guard.
    expect(w.relationship("npc", "player").trust).toBe(20);
    expect(w.believes("player", "the-secret")).toBe(false);
  });

  it("falls back to an authored line and authored options when the model fails", async () => {
    const w = world(convPayload());
    const provider = new ScriptedProvider({}, { conversation: ["garbage", "more garbage"] });
    const c = new Conversations({ w, provider });
    await c.start("nell-chat");
    expect(w.drainOutput().map((o) => o.text)).toContain("Nell doesn't answer.");
    expect(w.state.conversation!.options.map((o) => o.kind)).toEqual(["authored", "authored", "authored", "leave"]);
  });

  it("ends on an option, logging the transcript to both parties and to overhearers", async () => {
    const w = world(convPayload());
    w.emit("relocated", { ops: [{ op: "set", path: ["objects", "eve", "location"], value: "hall" }] });
    const provider = new ScriptedProvider({ conversation: () => turn({ line: "Mm-hm." }) });
    const c = new Conversations({ w, provider });
    await c.start("nell-chat");
    await c.choose(2); // "Bye then." ends
    expect(w.state.conversation).toBeNull();
    expect(w.state.dayLogs.player!.some((e) => e.kind === "conversation" && e.text.includes("Bye then."))).toBe(true);
    expect(w.state.dayLogs.npc!.some((e) => e.kind === "conversation")).toBe(true);
    expect(w.state.dayLogs.eve!.some((e) => e.kind === "overheard")).toBe(true);
  });

  it("ends when the character walks off", async () => {
    const w = world(convPayload());
    const provider = new ScriptedProvider(
      {},
      { conversation: [turn({ line: "I'm off.", actions: [{ act: "go", to: "kitchen" }] })] },
    );
    const c = new Conversations({ w, provider });
    await c.start("nell-chat");
    expect(w.locationOf("npc")).toBe("kitchen");
    expect(w.state.conversation).toBeNull();
  });
});

describe("set-piece director (§6.7)", () => {
  function scene() {
    const base = mini();
    return mini({
      hooks: [{ id: "smoke", description: "Smoke rises.", effects: [{ set_flag: "smoky" }] }],
      set_pieces: [
        {
          id: "drill",
          starts_when: { flag: "alarm" },
          objective: "Get out.",
          stage: ["hall", "kitchen"],
          cast: ["npc"],
          director_brief: "A fire drill.",
          beats: ["alarm", "exit"],
          moves: { actions: ["go"], effects: ["narrate", "set_flag"], hooks: ["smoke"] },
          ends_when: { flag: "out" },
          outcomes: [{ when: { flag: "out" }, do: [{ award_xp: 50 }] }],
        },
      ],
      story: {
        ...base.story,
        triggers: [{ id: "t", when: { day: 99 }, do: [{ set_flag: "alarm" }, { set_flag: "out" }] }],
      },
    });
  }

  it("applies only declared moves for cast on stage, and advances beats", async () => {
    const w = world(scene());
    w.emit("flag-set", { ops: [{ op: "set", path: ["flags", "alarm"], value: true }] });
    tick(w, 0);
    expect(w.state.setPiece?.id).toBe("drill");
    const provider = new ScriptedProvider(
      {},
      {
        director: [
          {
            narration: "Bells.",
            lines: [{ who: "npc", text: "Move!" }],
            castActions: [
              { actor: "npc", action: { act: "go", to: "kitchen" } },
              { actor: "player", action: { act: "go", to: "kitchen" } },
            ],
            effects: [
              { kind: "set_flag", flag: "lit" },
              { kind: "set_property", object: "window", key: "broken", value: true },
            ],
            hooks: [{ id: "smoke", args: [] }],
            targets: [],
            advanceBeat: true,
          },
        ],
      },
    );
    const d = new Director({ w, provider });
    await d.turn();
    expect(w.locationOf("npc")).toBe("kitchen"); // cast action allowed
    expect(w.locationOf("player")).toBe("hall"); // the player is not cast
    expect(w.state.flags.lit).toBe(true); // set_flag is an allowed move
    expect(w.prop("window", "broken")).not.toBe(true); // set_property is not
    expect(w.state.flags.smoky).toBe(true);
    expect(w.state.setPiece!.beat).toBe(1);
    w.emit("flag-set", { ops: [{ op: "set", path: ["flags", "out"], value: true }] });
    tick(w, 0);
    expect(w.state.setPiece).toBeNull();
    expect(w.char("player").xp).toBe(50);
    expect(w.state.dayLogs.npc!.some((e) => e.kind === "set-piece")).toBe(true);
  });

  it("takes a no-op turn when the model fails", async () => {
    const w = world(scene());
    w.emit("flag-set", { ops: [{ op: "set", path: ["flags", "alarm"], value: true }] });
    tick(w, 0);
    const d = new Director({ w, provider: new ScriptedProvider() });
    await d.turn();
    expect(w.state.setPiece!.turns).toBe(1);
  });
});

describe("memory: days are chapters (§6.8)", () => {
  it("summarises each active character in their own perspective and carries summaries forward", async () => {
    const w = world();
    w.dayLog("npc", "witnessed", "Pat dropped a mug.");
    w.dayLog("player", "action", "You dropped a mug.");
    const provider = new ScriptedProvider({
      "day-summary": (req) => ({
        summary: req.system.some((s) => s.text.includes("You are Pat"))
          ? "I dropped a mug."
          : "Pat dropped a mug. Clumsy.",
      }),
    });
    await endDay({ w, provider });
    expect(w.state.day).toBe(2);
    expect(w.state.dayLogs).toEqual({});
    expect(w.state.summaries.npc).toEqual([{ day: 1, text: "Pat dropped a mug. Clumsy." }]);
    expect(w.state.summaries.player![0]!.text).toBe("I dropped a mug.");
    expect(provider.calls).toHaveLength(2);
  });

  it("falls back to a digest when summarising fails", async () => {
    const w = world();
    w.dayLog("npc", "witnessed", "Something odd happened in the hall.");
    await endDay({ w, provider: new ScriptedProvider() });
    expect(w.state.summaries.npc![0]!.text).toContain("Something odd happened");
  });
});

describe("callouts (§6.5)", () => {
  it("generates once per save and interpolates summaries", async () => {
    const p = mini({
      callouts: [
        { id: "dream", prompt: "Dream about {{summaries.player.latest}}", cache: "per-save", fallback: "Nothing." },
      ],
    });
    const w = world(p);
    w.emit("day-summary", { ops: [{ op: "push", path: ["summaries", "player"], value: { day: 1, text: "the mug" } }] });
    const provider = new ScriptedProvider({ callout: (req) => `You dream of ${req.messages[0]!.content.slice(-7)}.` });
    expect(await runCallout({ w, provider }, "dream")).toBe("You dream of the mug.");
    expect(await runCallout({ w, provider }, "dream")).toBe("You dream of the mug.");
    expect(provider.calls).toHaveLength(1);
  });
});
