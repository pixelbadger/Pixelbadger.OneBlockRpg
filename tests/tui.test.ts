import { describe, expect, it } from "vitest";
import { Canvas, S, wrapSpans } from "../src/cli/tui/canvas.js";
import { compose, emptyState, type TuiState, toParagraphs } from "../src/cli/tui/frame.js";
import { type MapView, offGridExits, placeRooms, wrapName } from "../src/cli/tui/map.js";
import { World } from "../src/core/world.js";
import { offlineProvider } from "../src/narrative/offline.js";
import { Session } from "../src/session/session.js";
import { example, mini } from "./helpers.js";

const plain = (spans: { text: string }[]) => spans.map((s) => s.text).join("");

async function playing(commands: string[]): Promise<{ session: Session; st: TuiState }> {
  const w = World.create(example(), "tui");
  const session = new Session(w, { provider: offlineProvider() });
  const st = emptyState(w.payload.game.title);
  st.log.push(...toParagraphs(session.start().views));
  for (const c of commands) st.log.push(...toParagraphs((await session.handle({ type: "command", text: c })).views));
  st.mode = session.mode;
  st.status = session.statusView();
  st.sheet = session.sheetView();
  st.inventory = session.inventoryView();
  st.map = session.mapView();
  return { session, st };
}

describe("TUI text layout", () => {
  it("wraps styled spans to a width, keeping styles and hard breaks", () => {
    const lines = wrapSpans([{ text: "Mrs Okafor: ", sgr: S.bold }, { text: "the rent is due\non Friday" }], 12);
    expect(lines.map(plain)).toEqual(["Mrs Okafor:", "the rent is", "due", "on Friday"]);
    expect(lines[0]![0]).toEqual({ text: "Mrs Okafor:", sgr: S.bold });
  });

  it("indents wrapped lines and hard-splits words longer than a line", () => {
    expect(wrapSpans([{ text: "abcdefghij" }], 6, 2).map(plain)).toEqual(["  abcd", "  efgh", "  ij"]);
  });

  it("breaks room names at spaces and hyphens, cutting only overlong words", () => {
    expect(wrapName("Second-floor Landing", 10)).toEqual(["Second-", "floor", "Landing"]);
    expect(wrapName("Stairwell", 8)).toEqual(["Stairwe…"]);
  });

  it("serialises a canvas to exact-width lines and clips drawing", () => {
    const cv = new Canvas(10, 2);
    cv.clip({ x: 2, y: 0, w: 3, h: 1 }, () => cv.text(0, 0, "abcdefgh", S.red));
    expect(cv.lines(false)).toEqual(["  cde     ", "          "]);
    expect(cv.lines(true)[0]).toBe("  \x1b[0;31mcde\x1b[0m     ");
  });
});

describe("TUI map", () => {
  it("lays rooms out by compass exits and keeps unvisited rooms in the fog", () => {
    const w = World.create(mini(), "map");
    const view = new Session(w, { provider: offlineProvider() }).mapView();
    expect(view.here).toBe("hall");
    expect(view.rooms).toEqual([
      { id: "hall", name: "Hall", visited: true },
      { id: "kitchen", name: "Kitchen", visited: false },
    ]);
    expect(view.exits).toContainEqual({ from: "hall", direction: "east", label: "east", blocked: true });
    const placed = placeRooms(view);
    expect(placed.get("hall")).toMatchObject({ gx: 0, gy: 0 });
    expect(placed.get("kitchen")).toMatchObject({ gx: 0, gy: -1 });
  });

  it("places neighbours relative to the current room and lists vertical exits off the grid", () => {
    const view: MapView = {
      type: "map",
      here: "landing",
      rooms: [
        { id: "landing", name: "Landing", visited: true },
        { id: "flat", name: "Flat", visited: true },
        { id: "attic", name: "Attic", visited: false },
        { id: "lobby", name: "Lobby", visited: true },
        { id: "beyond", name: "Beyond", visited: false },
      ],
      exits: [
        { from: "landing", to: "flat", direction: "west", label: "west", blocked: false },
        { from: "landing", to: "attic", direction: "up", label: "up", blocked: false },
        { from: "landing", to: "lobby", direction: "down", label: "down", blocked: false },
        { from: "flat", to: "landing", direction: "east", label: "east", blocked: false },
        { from: "flat", to: "beyond", direction: "north", label: "north", blocked: false },
      ],
    };
    const placed = placeRooms(view);
    expect([...placed.keys()].sort()).toEqual(["beyond", "flat", "landing"]);
    expect(placed.get("flat")).toMatchObject({ gx: -1, gy: 0 });
    expect(placed.get("beyond")).toMatchObject({ gx: -1, gy: -1 });
    expect(offGridExits(view)).toEqual([
      { mark: "▲", label: "up", to: "?" },
      { mark: "▼", label: "down", to: "Lobby" },
    ]);
  });
});

describe("TUI frame", () => {
  it("fills the screen exactly at every size, with map, character and inventory", async () => {
    const { st } = await playing(["Bruiser", "take kettle", "east"]);
    for (const [cols, rows] of [
      [80, 24],
      [110, 32],
      [160, 50],
    ] as const) {
      const f = compose(st, cols, rows);
      const lines = f.canvas.lines(false);
      expect(lines).toHaveLength(rows);
      for (const l of lines) expect([...l].length).toBe(cols);
      const screen = lines.join("\n");
      expect(screen).toContain("41 Carver Street");
      expect(screen).toContain("Map · Second-floor Landing");
      expect(screen).toContain("Flat 2B");
      expect(screen).toContain("the kettle");
      expect(screen).toMatch(/HP +█+ +\d+\/\d+/);
      expect(screen).toContain("You go east.");
      expect(f.cursor).toEqual({ x: 4, y: rows - 2 });
    }
  });

  it("scrolls the story back and clamps at the top", async () => {
    const { st } = await playing(["Bruiser", "look", "look", "look", "look"]);
    const bottom = compose(st, 80, 24);
    expect(bottom.maxScroll).toBeGreaterThan(0);
    st.scroll = 10_000;
    const top = compose(st, 80, 24).canvas.lines(false).join("\n");
    expect(top).toContain("more below");
    expect(top).toContain("Create your character.");
  });

  it("asks for a bigger terminal when it is too small", () => {
    const f = compose(emptyState("Mini"), 60, 20);
    expect(f.canvas.lines(false)[0]).toMatch(/at least 80×24/);
    expect(f.cursor).toBeNull();
  });

  it("shows conversation and combat choices as numbered options", () => {
    const paras = toParagraphs([
      { type: "conversation", with: "Nell", options: [{ index: 0, text: "Hello." }] },
      {
        type: "combat",
        round: 2,
        ap: 5,
        yourTurn: true,
        combatants: [{ id: "npc", name: "Nell", hp: 3, maxHp: 10, side: "b", status: "in" }],
        options: [{ label: "attack Nell", intent: { type: "command", text: "attack nell" } }],
      },
    ]).map((p) => plain(p.spans));
    expect(paras).toContain("1. Hello.");
    expect(paras).toContain("Round 2 · 5 AP left");
    expect(paras).toContain("▼ Nell ███░░░░░░░ 3/10");
    expect(paras).toContain("1. attack Nell");
  });
});
