import { describe, expect, it } from "vitest";
import { absorb } from "../src/cli/tui/app.js";
import { Canvas, S, wrapSpans } from "../src/cli/tui/canvas.js";
import { compose } from "../src/cli/tui/layout.js";
import { toParagraphs } from "../src/cli/tui/log.js";
import { camera, Timeline, tileScale } from "../src/cli/tui/scene.js";
import { Controller, type Key, type Ui } from "../src/cli/tui/ui.js";
import { World } from "../src/core/world.js";
import { offlineProvider } from "../src/narrative/offline.js";
import type { Payload } from "../src/payload/schema.js";
import type { Tile } from "../src/session/port.js";
import { Session } from "../src/session/session.js";
import { example, mini } from "./helpers.js";

const plain = (spans: { text: string }[]) => spans.map((s) => s.text).join("");
/** Terminal columns a line takes: emoji are two wide. */
const width = (line: string) => [...line].reduce((n, ch) => n + (/\p{Emoji_Presentation}/u.test(ch) ? 2 : 1), 0);

function game(p: Payload = example()) {
  const w = World.create(p, "tui");
  const session = new Session(w, { provider: offlineProvider() });
  const ui: Ui = { title: p.game.title, mode: session.mode, log: [], scroll: 0, busy: false };
  const said: string[] = [];
  const c = new Controller(ui, {
    submit: async (intent) => {
      absorb(ui, session, (await session.handle(intent)).views);
    },
    menu: () => session.menu(),
    quit: () => {},
    say: (t) => said.push(t),
  });
  absorb(ui, session, session.start().views);
  c.sync();
  const press = async (str: string | undefined, key: Key = {}) => {
    await c.key(str, key);
    c.sync();
  };
  return { w, session, ui, c, press, said };
}

describe("TUI text and canvas", () => {
  it("wraps styled spans to a width, keeping styles and hard breaks", () => {
    const lines = wrapSpans([{ text: "Mrs Okafor: ", sgr: S.bold }, { text: "the rent is due\non Friday" }], 12);
    expect(lines.map(plain)).toEqual(["Mrs Okafor:", "the rent is", "due", "on Friday"]);
  });

  it("keeps double-width emoji whole", () => {
    const cv = new Canvas(6, 1);
    cv.wide(1, 0, "🫖");
    expect(width(cv.lines(false)[0]!)).toBe(6);
    cv.set(2, 0, "x");
    expect(cv.lines(false)[0]).toBe("  x   ");
    cv.clip({ x: 0, y: 0, w: 5, h: 1 }, () => cv.wide(4, 0, "🫖"));
    expect(cv.lines(false)[0]).toBe("  x   ");
  });

  it("shows conversation and combat choices as numbered options in the plain log", () => {
    const paras = toParagraphs([{ type: "conversation", with: "Nell", options: [{ index: 0, text: "Hello." }] }]);
    expect(paras.map((p) => plain(p.spans))).toContain("1. Hello.");
    expect(toParagraphs([{ type: "conversation", with: "Nell", options: [] }], { compact: true })).toEqual([]);
  });
});

describe("TUI scene", () => {
  it("scales small rooms up to fill the view and centres them", () => {
    const { ui } = game(mini());
    expect(tileScale(ui.scene!, { x: 0, y: 0, w: 80, h: 20 })).toBe(3);
    expect(tileScale(ui.scene!, { x: 0, y: 0, w: 20, h: 6 })).toBe(1);
    expect(camera(ui.scene!, 20, 10, [2, 2])).toEqual([6, 2]);
  });

  it("follows the player across a room bigger than the view", () => {
    const { ui } = game(mini());
    const scene = { ...ui.scene!, w: 40, h: 40 };
    expect(camera(scene, 10, 10, [30, 30])).toEqual([-25, -25]);
    expect(camera(scene, 10, 10, [1, 1])).toEqual([0, 0]);
  });

  it("plays a walk tile by tile from where the walker stood", () => {
    const before = new Map<string, Tile>([["npc", [0, 0]]]);
    const t = new Timeline(
      [
        {
          kind: "walk",
          id: "npc",
          room: "hall",
          path: [
            [1, 0],
            [2, 0],
          ],
        },
        { kind: "hit", actor: "npc", target: "player", to: [3, 0], ranged: false, damage: 4 },
      ],
      before,
    );
    const final = new Map<string, Tile>([["npc", [2, 0]]]);
    expect(t.at(0, final).pos.get("npc")).toEqual([0, 0]);
    expect(t.at(100, final).pos.get("npc")).toEqual([1, 0]);
    expect(t.at(10_000, final).pos.get("npc")).toEqual([2, 0]);
    const hit = t.at(250, final);
    expect(hit.marks[0]?.emoji).toBe("💥");
    expect(hit.floats[0]?.text).toBe("-4");
  });
});

describe("TUI frame", () => {
  it("fills the screen exactly at every size, with the scene, character, pack and messages", async () => {
    const { ui, press } = game();
    await press("2");
    for (const [cols, rows] of [
      [80, 24],
      [110, 34],
      [160, 50],
    ] as const) {
      for (const emoji of [true, false]) {
        const lines = compose(ui, cols, rows, { t: 0, emoji }).canvas.lines(false);
        expect(lines).toHaveLength(rows);
        for (const l of lines) expect(width(l)).toBe(cols);
        const screen = lines.join("\n");
        expect(screen).toContain("Flat 2B");
        expect(screen).toContain("Messages");
        expect(screen).toMatch(/HP +█+ +\d+\/\d+/);
        expect(screen).toContain("the key to 2B");
      }
    }
  });

  it("asks for a bigger terminal when it is too small", () => {
    const { ui } = game();
    expect(compose(ui, 60, 20, { t: 0, emoji: true }).canvas.lines(false)[0]).toMatch(/at least 80×24/);
  });
});

describe("TUI keys (Ultima V style)", () => {
  it("creates a character from the menu and walks with the arrows", async () => {
    const { ui, press, w } = game();
    expect(ui.mode).toBe("create");
    expect(ui.menu?.title).toBe("Who are you?");
    await press("1");
    expect(ui.mode).toBe("explore");
    const before = w.state.objects[w.playerId]!.pos!;
    await press(undefined, { name: "up" });
    expect(w.state.objects[w.playerId]!.pos).toEqual([before[0], before[1] - 1]);
  });

  it("makes your own character with the allotment screen", async () => {
    const { ui, press } = game();
    await press("3");
    expect(ui.allot).toBeDefined();
    for (let i = 0; i < 5; i++) await press(undefined, { name: "right" });
    await press(undefined, { name: "return" });
    expect(ui.mode).toBe("explore");
    expect(ui.sheet?.special.ST).toBe(10);
  });

  it("aims with a cursor and attacks, which starts a fight on the tiles", async () => {
    const { ui, press, w } = game(mini());
    await press("a");
    expect(ui.targeting?.verb).toBe("attack");
    expect(ui.targeting?.cursor).toEqual(w.state.objects.npc!.pos);
    await press(undefined, { name: "return" });
    expect(ui.mode).toBe("combat");
    expect(ui.combat?.combatants.map((x) => x.id)).toContain("npc");
    expect(ui.scene?.things.find((t) => t.id === "npc")?.side).toBe("b");
  });

  it("gets things from containers through a menu, and escapes back out", async () => {
    const { ui, press, w } = game(mini());
    await press("o");
    await press(undefined, { name: "tab" });
    const box = ui.targeting?.candidates.find((c) => c.kind === "thing" && c.thing.id === "box");
    expect(box).toBeDefined();
    ui.targeting!.cursor = w.state.objects.box!.pos!;
    await press(undefined, { name: "return" });
    expect(w.prop("box", "open")).toBe(true);
    await press("g");
    ui.targeting!.cursor = w.state.objects.box!.pos!;
    await press(undefined, { name: "return" });
    expect(ui.menu?.items.map((i) => i.label)).toEqual(["the coin", "the box itself"]);
    await press(undefined, { name: "return" });
    expect(w.isWithin("coin", w.playerId)).toBe(true);
    await press("w");
    expect(ui.menu?.title).toBe("Wait");
    await press(undefined, { name: "escape" });
    expect(ui.menu).toBeUndefined();
  });

  it("opens the stats sheet, the help and the action menu", async () => {
    const { ui, press } = game(mini());
    await press("z");
    expect(ui.overlay?.title).toBe("Pat");
    await press("x");
    await press("?");
    expect(ui.overlay?.title).toBe("Keys");
    await press("x");
    await press("m");
    expect(ui.menu?.items.some((i) => i.label.startsWith("go north"))).toBe(true);
  });
});
