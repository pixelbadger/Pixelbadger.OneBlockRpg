import { describe, expect, it } from "vitest";
import { World } from "../src/engine/core/world.js";
import { offlineProvider } from "../src/engine/narrative/offline.js";
import type { Payload } from "../src/engine/payload/schema.js";
import { parseInline, parseMarkdown } from "../src/engine/session/markdown.js";
import type { Tile } from "../src/engine/session/port.js";
import { Session } from "../src/engine/session/session.js";
import { render, renderMarkdown } from "../src/hosts/cli/render.js";
import { absorb } from "../src/hosts/cli/tui/app.js";
import { Canvas, S, wrapSpans } from "../src/hosts/cli/tui/canvas.js";
import { compose } from "../src/hosts/cli/tui/layout.js";
import { toParagraphs } from "../src/hosts/cli/tui/log.js";
import { camera, Timeline, tileScale } from "../src/hosts/cli/tui/scene.js";
import { Controller, type Key, type Ui } from "../src/hosts/cli/tui/ui.js";
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

/** A game past its introduction: Escape skips the pages. */
async function begun(p?: Payload) {
  const g = game(p);
  if (g.ui.overlay?.pages) await g.press(undefined, { name: "escape" });
  return g;
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
    const { ui, press } = await begun();
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

describe("light markdown", () => {
  it("parses headings, paragraphs, quotes, lists and rules", () => {
    const md = "# Title\n\nOne line\nand the next.\n\n> said\n> twice\n\n- a\n- **b**\n1. c\n\n---\nafter";
    expect(parseMarkdown(md)).toEqual([
      { kind: "heading", level: 1, runs: [{ text: "Title" }] },
      { kind: "paragraph", runs: [{ text: "One line and the next." }] },
      { kind: "quote", runs: [{ text: "said twice" }] },
      { kind: "item", marker: "•", runs: [{ text: "a" }] },
      { kind: "item", marker: "•", runs: [{ text: "b", bold: true }] },
      { kind: "item", marker: "1.", runs: [{ text: "c" }] },
      { kind: "rule" },
      { kind: "paragraph", runs: [{ text: "after" }] },
    ]);
  });

  it("parses emphasis, leaving lone markers, snake_case and escapes alone", () => {
    expect(parseInline("a **bold *both*** and _it_")).toEqual([
      { text: "a " },
      { text: "bold ", bold: true },
      { text: "both", bold: true, italic: true },
      { text: " and " },
      { text: "it", italic: true },
    ]);
    expect(parseInline("2 * 3 = six, snake_case_name, \\*not\\*")).toEqual([
      { text: "2 * 3 = six, snake_case_name, *not*" },
    ]);
  });

  it("renders for the plain CLI, wrapping on visible width", () => {
    const out = renderMarkdown("# Hi\n\n**Bold** words that go on and on until they wrap", false, 20);
    expect(out).toBe("Hi\n\nBold words that go\non and on until they\nwrap");
    const styled = renderMarkdown("x **y**", true, 20);
    expect(styled).toBe("x \x1b[1my\x1b[0m");
    expect(render([{ type: "introduction", title: "T", pages: ["one", "two"] }], false)).toContain("one\n\n───\n\ntwo");
  });
});

describe("TUI introduction", () => {
  it("pages through the introduction over the creation screen, and N brings it back", async () => {
    const { ui, press } = game();
    expect(ui.mode).toBe("create");
    const o = ui.overlay!;
    expect(o.title).toBe("41 Carver Street");
    expect(o.pages).toHaveLength(3);
    // Markdown: the heading is styled, bold runs carry bold.
    expect(o.lines[0]!.spans[0]).toMatchObject({ text: "The building", sgr: S.boldYellow });
    expect(o.lines.flatMap((l) => l.spans).find((s) => s.text === "41 Carver Street")?.sgr).toBe(S.bold);
    let screen = compose(ui, 100, 40, { t: 0, emoji: false }).canvas.lines(false).join("\n");
    expect(screen).toContain("1/3");
    expect(screen).toContain("soot-dark brick");
    await press("x");
    expect(ui.overlay?.page).toBe(1);
    await press(undefined, { name: "left" });
    expect(ui.overlay?.page).toBe(0);
    await press("x");
    await press("x");
    screen = compose(ui, 100, 40, { t: 0, emoji: false }).canvas.lines(false).join("\n");
    expect(screen).toContain("Any key to begin.");
    await press("x");
    expect(ui.overlay).toBeUndefined();
    await press("1");
    expect(ui.mode).toBe("explore");
    await press("n");
    expect(ui.overlay?.pages).toHaveLength(3);
  });

  it("keeps the introduction out of the message log", () => {
    const { ui } = game();
    expect(ui.log.some((p) => p.spans.some((s) => s.text.includes("soot-dark")))).toBe(false);
  });
});

describe("TUI keys (Ultima V style)", () => {
  it("creates a character from the menu and walks with the arrows", async () => {
    const { ui, press, w } = await begun();
    expect(ui.mode).toBe("create");
    expect(ui.menu?.title).toBe("Who are you?");
    await press("1");
    expect(ui.mode).toBe("explore");
    const before = w.state.objects[w.playerId]!.pos!;
    await press(undefined, { name: "up" });
    expect(w.state.objects[w.playerId]!.pos).toEqual([before[0], before[1] - 1]);
  });

  it("makes your own character with the allotment screen", async () => {
    const { ui, press } = await begun();
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
