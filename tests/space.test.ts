import { describe, expect, it } from "vitest";
import { perform } from "../src/core/actions.js";
import { playerCombat } from "../src/core/combat.js";
import { canSee, compileMap, findPath, gridOf, occupancy } from "../src/core/space.js";
import { tick } from "../src/core/tick.js";
import { placeAll } from "../src/core/world.js";
import { checkMaps } from "../src/payload/maps.js";
import { mini, world } from "./helpers.js";

const P = { by: "player" as const };
const pos = (w: ReturnType<typeof world>, id: string) => w.state.objects[id]?.pos;

/** The mini hall, redrawn: `rows` replaces the hall's map rows (the legend stays). */
function hall(rows: string[]) {
  const p = mini();
  p.rooms[0]!.map.rows = rows;
  return p;
}

describe("space: positions and placement (§4.10)", () => {
  it("puts everything in a room on its authored tile, and nothing held or a door on any tile", () => {
    const w = world();
    expect(pos(w, "player")).toEqual([2, 2]);
    expect(pos(w, "npc")).toEqual([3, 3]);
    expect(pos(w, "key")).toEqual([1, 1]);
    expect(pos(w, "mug")).toBeNull();
    expect(pos(w, "door") ?? null).toBeNull();
  });

  it("compiles terrain, exits and placements, and reports unknown characters", () => {
    const g = compileMap({ ...mini().rooms[0]!, map: { rows: ["#?#", "#.D"], legend: { D: { exit: "east" } } } });
    expect(g.terrain[0]).toEqual(["wall", "floor", "wall"]);
    expect(g.exitTiles.get(1)).toEqual([[2, 1]]);
    expect(g.problems[0]?.message).toMatch(/'\?' at 1,0 is not in the legend/);
  });

  it("lets a placed thing stand on the floor around it when `on` is unset", () => {
    const g = compileMap({
      ...mini().rooms[0]!,
      map: { rows: ["___", "_k_"], legend: { _: { terrain: "carpet" }, k: { object: "key" } } },
    });
    expect(g.terrain[1]![1]).toBe("carpet");
  });

  it("places old saves' things on their authored tiles (Q34)", () => {
    const w = world();
    for (const s of Object.values(w.state.objects)) delete s.pos;
    placeAll(w.state, w.payload);
    expect(pos(w, "player")).toEqual([2, 2]);
    expect(pos(w, "key")).toEqual([1, 1]);
  });
});

describe("space: walking (§4.10)", () => {
  it("steps one tile, and refuses walls and people", () => {
    const w = world();
    expect(perform(w, "player", { act: "step", direction: "north" }, P).ok).toBe(true);
    expect(pos(w, "player")).toEqual([2, 1]);
    expect(perform(w, "player", { act: "step", direction: "north" }, P).ok).toBe(false);
    expect(pos(w, "player")).toEqual([2, 1]);
    perform(w, "player", { act: "step", direction: "south" }, P);
    const r = perform(w, "player", { act: "step", direction: "southeast" }, P);
    expect(r.ok).toBe(false);
    expect(w.drainOutput().map((o) => o.text)).toContain("Nell is in the way.");
  });

  it("walks to what an action needs and counts the steps", () => {
    const w = world();
    perform(w, "player", { act: "step", direction: "east" }, P);
    perform(w, "player", { act: "step", direction: "east" }, P);
    expect(pos(w, "player")).toEqual([4, 2]);
    const r = perform(w, "player", { act: "take", item: "key" }, P);
    expect(r.ok).toBe(true);
    expect(r.steps).toBeGreaterThan(0);
    const at = pos(w, "player")!;
    expect(Math.max(Math.abs(at[0] - 1), Math.abs(at[1] - 1))).toBeLessThanOrEqual(1);
  });

  it("walks to the doorway, goes through, and arrives at the far side's door", () => {
    const w = world();
    const r = perform(w, "player", { act: "go", direction: "north" }, P);
    expect(r.ok).toBe(true);
    expect(w.roomOf("player")).toBe("kitchen");
    expect(pos(w, "player")).toEqual([2, 2]);
    perform(w, "player", { act: "go", direction: "south" }, P);
    expect(w.roomOf("player")).toBe("hall");
    expect(pos(w, "player")).toEqual([3, 1]);
  });

  it("goes through an exit by stepping onto its tile", () => {
    const w = world();
    perform(w, "player", { act: "step", direction: "north" }, P);
    perform(w, "player", { act: "step", direction: "northeast" }, P);
    expect(w.roomOf("player")).toBe("kitchen");
  });

  it("refuses what it can't reach on foot", () => {
    const w = world(hall(["###D###", "#k#..g#", "w##.a.E", "#b.n.s#", "#######"]));
    expect(perform(w, "player", { act: "take", item: "key" }, P).ok).toBe(false);
  });

  it("finds deterministic paths that don't cut wall corners", () => {
    const w = world();
    const g = gridOf(w, "hall")!;
    const path = findPath(g, [2, 2], (p) => p[0] === 5 && p[1] === 2, occupancy(w, "hall", "player"));
    expect(path?.at(-1)).toEqual([5, 2]);
    expect(findPath(g, [2, 2], (p) => p[0] === 5 && p[1] === 2, occupancy(w, "hall", "player"))).toEqual(path);
  });

  it("brings characters home as the clock runs", () => {
    const w = world();
    w.state.objects.npc!.pos = [5, 2];
    tick(w, 1);
    expect(pos(w, "npc")).toEqual([3, 3]);
  });
});

describe("space: sight and range (§4.10, §5.6)", () => {
  it("walls block line of sight; people don't", () => {
    const w = world(hall(["###D###", "#k.#.g#", "w.@#a.E", "#b.n.s#", "#######"]));
    expect(canSee(w, "player", "anvil")).toBe(false);
    expect(canSee(w, "player", "npc")).toBe(true);
    expect(perform(w, "player", { act: "throw", item: "mug", target: "anvil" }, P).ok).toBe(false);
  });

  it("closes in to strike in melee, and moving in a fight costs AP", () => {
    const w = world(hall(["###D###", "#k...g#", "w.@.a.E", "#b..ns#", "#######"]));
    perform(w, "player", { act: "attack", target: "npc" }, P);
    expect(w.state.combat).not.toBeNull();
    expect(Math.max(Math.abs(pos(w, "player")![0] - 4), Math.abs(pos(w, "player")![1] - 3))).toBe(1);
    if (w.state.combat?.order[w.state.combat.turn] === "player") {
      const before = w.state.combat.ap;
      playerCombat(w, { kind: "move", direction: "north" });
      if (w.state.combat?.order[w.state.combat.turn] === "player") expect(w.state.combat.ap).toBe(before - 1);
    }
  });
});

describe("map lint (§7.7, §7.10)", () => {
  const messages = (p: ReturnType<typeof mini>) => checkMaps(p).map((i) => i.message);

  it("passes the fixture", () => {
    expect(checkMaps(mini())).toEqual([]);
  });

  it("finds things that start in a room but aren't on its map", () => {
    const p = mini();
    delete p.rooms[0]!.map.legend.k;
    p.rooms[0]!.map.rows = p.rooms[0]!.map.rows.map((r) => r.replace("k", "."));
    expect(messages(p)).toContain("object 'key' starts in this room but isn't on its map");
  });

  it("finds exits without tiles and exits you can't walk to", () => {
    const p = hall(["###D###", "#k...g#", "w.@.a##", "#b.n.s#", "#######"]);
    expect(messages(p)).toContain("exit 'east' has no tile");
    const q = hall(["###D###", "#k...g#", "w.@.a#E", "#b.ns##", "#######"]);
    expect(messages(q)).toContain("exit 'east' can't be reached on foot");
  });

  it("finds ragged rows", () => {
    expect(messages(hall(["###D###", "#k...g", "w.@.a.E", "#b.n.s#", "#######"])).join("\n")).toMatch(/row 1 is 6/);
  });
});
