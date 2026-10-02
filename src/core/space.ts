/**
 * Space (§4.10): every room is an authored tile map. This module compiles maps, answers the four spatial questions
 * (can I step there, can I reach it, can I see it, how far is it) and places things that arrive in a room.
 * Positions live in state (`objects[id].pos`) and only change through events, like everything else.
 */

import type { Exit, Look, Payload, Room, Terrain } from "../payload/schema.js";
import { exitLabel } from "./describe.js";
import type { World } from "./world.js";

export type Pos = [number, number];

/** Terrain the engine can walk on and see through (§4.10). */
const BLOCKS_MOVE = new Set<Terrain>(["wall", "window", "railing", "fence", "water", "void"]);
const BLOCKS_SIGHT = new Set<Terrain>(["wall"]);

export const walkable = (t: Terrain): boolean => !BLOCKS_MOVE.has(t);
export const seeThrough = (t: Terrain): boolean => !BLOCKS_SIGHT.has(t);

/** Eight directions, in the fixed order pathing explores them (so paths are deterministic). */
export const DIRS: Record<string, Pos> = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
  northeast: [1, -1],
  southeast: [1, 1],
  southwest: [-1, 1],
  northwest: [-1, -1],
};
const DIR_ALIASES: Record<string, string> = {
  n: "north",
  e: "east",
  s: "south",
  w: "west",
  ne: "northeast",
  se: "southeast",
  sw: "southwest",
  nw: "northwest",
  "north-east": "northeast",
  "south-east": "southeast",
  "south-west": "southwest",
  "north-west": "northwest",
};
const STEPS = Object.values(DIRS);

export function dirOffset(direction: string): Pos | undefined {
  const d = direction.toLowerCase();
  return DIRS[DIR_ALIASES[d] ?? d];
}

export function dirName(d: Pos): string {
  return Object.entries(DIRS).find(([, v]) => v[0] === d[0] && v[1] === d[1])?.[0] ?? "here";
}

// ─── Compiled maps ───────────────────────────────────────────────────────────

export interface Grid {
  room: string;
  w: number;
  h: number;
  /** terrain[y][x] */
  terrain: Terrain[][];
  /** Authored look overrides for terrain tiles, keyed "x,y". */
  looks: Map<string, Look>;
  /** Authored tiles of each object and character placed on this map, in reading order. */
  placements: Map<string, Pos[]>;
  /** Exit tiles: index into room.exits. */
  exitAt: Map<string, number>;
  /** Tiles of each exit, by index into room.exits. */
  exitTiles: Map<number, Pos[]>;
  /** Problems found while compiling (for the validator). */
  problems: { row?: number; message: string; fix?: string }[];
}

export const key = (p: Pos): string => `${p[0]},${p[1]}`;

/** Finds an exit of `room` by direction, label or destination. */
export function exitByToken(room: Room, token: string): number {
  const t = token.toLowerCase();
  const i = room.exits.findIndex((x) => x.direction?.toLowerCase() === t || x.label?.toLowerCase() === t);
  return i >= 0 ? i : room.exits.findIndex((x) => exitLabel(x).toLowerCase() === t || x.to === token);
}

export function compileMap(room: Room): Grid {
  const rows = room.map.rows;
  const w = Math.max(...rows.map((r) => [...r].length));
  const h = rows.length;
  const g: Grid = {
    room: room.id,
    w,
    h,
    terrain: [],
    looks: new Map(),
    placements: new Map(),
    exitAt: new Map(),
    exitTiles: new Map(),
    problems: [],
  };
  const legend = room.map.legend;
  rows.forEach((row, y) => {
    const cells = [...row];
    if (cells.length !== w) {
      g.problems.push({
        row: y,
        message: `row ${y} is ${cells.length} tiles wide; the widest row is ${w}`,
        fix: "pad rows to the same width",
      });
    }
    const line: Terrain[] = [];
    for (let x = 0; x < w; x++) {
      const ch = cells[x] ?? " ";
      const p: Pos = [x, y];
      const entry = legend[ch];
      if (entry) {
        if ("terrain" in entry) {
          line.push(entry.terrain);
          if (entry.look) g.looks.set(key(p), entry.look);
        } else {
          line.push(
            entry.on ??
              ("exit" in entry && room.exits[exitByToken(room, entry.exit)]?.direction?.match(/^(up|down)$/i)
                ? "stairs"
                : "floor"),
          );
          const id = "object" in entry ? entry.object : "character" in entry ? entry.character : undefined;
          if (id) {
            const list = g.placements.get(id) ?? [];
            list.push(p);
            g.placements.set(id, list);
          } else if ("exit" in entry) {
            const i = exitByToken(room, entry.exit);
            if (i < 0) {
              g.problems.push({
                row: y,
                message: `legend '${ch}' names exit '${entry.exit}', which room '${room.id}' does not have`,
                fix: `use one of: ${room.exits.map(exitLabel).join(", ")}`,
              });
            } else {
              g.exitAt.set(key(p), i);
              g.exitTiles.set(i, [...(g.exitTiles.get(i) ?? []), p]);
            }
          }
        }
      } else if (ch === "#") line.push("wall");
      else if (ch === ".") line.push("floor");
      else if (ch === " ") line.push("void");
      else {
        line.push("floor");
        g.problems.push({
          row: y,
          message: `'${ch}' at ${x},${y} is not in the legend`,
          fix: `add '${ch}' to map.legend`,
        });
      }
    }
    g.terrain.push(line);
  });
  return g;
}

const gridCache = new WeakMap<Payload, Map<string, Grid>>();

export function gridOf(w: World, room: string): Grid | undefined {
  let m = gridCache.get(w.payload);
  if (!m) {
    m = new Map();
    gridCache.set(w.payload, m);
  }
  let g = m.get(room);
  if (!g) {
    const r = w.ix.rooms.get(room);
    if (!r) return undefined;
    g = compileMap(r);
    // `character: player` in a legend means the player character.
    const mine = g.placements.get("player");
    if (mine) {
      g.placements.delete("player");
      g.placements.set(w.playerId, [...(g.placements.get(w.playerId) ?? []), ...mine]);
    }
    m.set(room, g);
  }
  return g;
}

export const inBounds = (g: Grid, p: Pos): boolean => p[0] >= 0 && p[1] >= 0 && p[0] < g.w && p[1] < g.h;
export const terrainAt = (g: Grid, p: Pos): Terrain => (inBounds(g, p) ? g.terrain[p[1]]![p[0]]! : "void");
export const cheb = (a: Pos, b: Pos): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const add = (a: Pos, d: Pos): Pos => [a[0] + d[0], a[1] + d[1]];

// ─── Positions ───────────────────────────────────────────────────────────────

/** The room-level ancestor of `id` (itself, its container, its holder…), or null if it isn't in a room. */
export function topInRoom(w: World, id: string): string | null {
  let cur: string | null = id;
  for (let i = 0; i < 64 && cur; i++) {
    const loc = w.locationOf(cur);
    if (!loc) return null;
    if (w.isRoom(loc)) return cur;
    cur = loc;
  }
  return null;
}

/** The tile `id` is on: its own, or its container's or holder's. Null when not in a room. */
export function posOf(w: World, id: string): Pos | null {
  const top = topInRoom(w, id);
  return top ? (w.state.objects[top]?.pos ?? null) : null;
}

const doorCache = new WeakMap<Payload, Set<string>>();

/** Doors are drawn on their exits' tiles, never placed as furniture (§4.10). */
export function isDoor(w: World, id: string): boolean {
  let s = doorCache.get(w.payload);
  if (!s) {
    s = new Set(w.payload.rooms.flatMap((r) => r.exits.flatMap((x) => (x.via ? [x.via] : []))));
    doorCache.set(w.payload, s);
  }
  return s.has(id);
}

/** True for objects that stand fixed on the map: not takeable, not characters, not doors. They block movement. */
export function isFixed(w: World, id: string): boolean {
  const def = w.thing(id);
  return !!def && !w.isChar(id) && !def.affordances.includes("takeable") && !isDoor(w, id);
}

/** The tiles `id` covers: a fixed object at its authored place covers all its authored tiles. */
export function footprint(w: World, id: string): Pos[] {
  const top = topInRoom(w, id);
  if (!top) return [];
  const pos = w.state.objects[top]?.pos;
  if (!pos) return [];
  if (isFixed(w, top)) {
    const tiles = gridOf(w, w.locationOf(top)!)?.placements.get(top);
    if (tiles?.length && key(tiles[0]!) === key(pos)) return tiles;
  }
  return [pos];
}

/** Exit tiles in `room` belonging to exits through door `door`. */
export function doorTiles(w: World, room: string, door: string): Pos[] {
  const g = gridOf(w, room);
  const r = w.ix.rooms.get(room);
  if (!g || !r) return [];
  return r.exits.flatMap((x, i) => (x.via === door ? (g.exitTiles.get(i) ?? []) : []));
}

/** Tiles you must be next to in order to reach `id` from inside `room`: its footprint, or a door's exit tiles. */
export function reachTiles(w: World, room: string, id: string): Pos[] {
  const doors = doorTiles(w, room, id);
  if (doors.length) return doors;
  return w.roomOf(id) === room ? footprint(w, id) : [];
}

/** Blocked tiles of a room right now: fixed objects and standing characters (except `except`). */
export function occupancy(w: World, room: string, except?: string): Set<string> {
  const out = new Set<string>();
  for (const id of w.childrenOf(room)) {
    if (id === except) continue;
    if (w.isChar(id)) {
      const p = w.state.objects[id]?.pos;
      if (p && w.char(id).status !== "dead") out.add(key(p));
    } else if (isFixed(w, id)) {
      for (const p of footprint(w, id)) out.add(key(p));
    }
  }
  return out;
}

/** Can `who` stand on `p`: walkable terrain, not an exit tile, not occupied. */
export function standable(g: Grid, p: Pos, occ: Set<string>): boolean {
  return inBounds(g, p) && walkable(terrainAt(g, p)) && !g.exitAt.has(key(p)) && !occ.has(key(p));
}

/** No cutting corners round walls: a diagonal step needs both orthogonal neighbours to be walkable terrain. */
function diagonalOk(g: Grid, from: Pos, d: Pos): boolean {
  if (d[0] === 0 || d[1] === 0) return true;
  return walkable(terrainAt(g, [from[0] + d[0], from[1]])) && walkable(terrainAt(g, [from[0], from[1] + d[1]]));
}

/**
 * Breadth-first path from `from` to the first tile satisfying `goal` (which may be a tile you can't stand on, such
 * as an exit). Returns the tiles to step onto, excluding `from`; [] if `from` already satisfies `goal`; null if
 * unreachable.
 */
export function findPath(
  g: Grid,
  from: Pos,
  goal: (p: Pos) => boolean,
  occ: Set<string>,
  maxSteps = 4096,
): Pos[] | null {
  if (goal(from)) return [];
  const prev = new Map<string, string>();
  const seen = new Set([key(from)]);
  let frontier: Pos[] = [from];
  for (let depth = 0; frontier.length && depth < maxSteps; depth++) {
    const next: Pos[] = [];
    for (const cur of frontier) {
      for (const d of STEPS) {
        const n = add(cur, d);
        const k = key(n);
        if (seen.has(k) || !inBounds(g, n) || !diagonalOk(g, cur, d)) continue;
        seen.add(k);
        if (goal(n)) {
          const path: Pos[] = [n];
          let back = key(cur);
          while (back !== key(from)) {
            const [x, y] = back.split(",").map(Number) as Pos;
            path.unshift([x, y]);
            back = prev.get(back)!;
          }
          return path;
        }
        if (!standable(g, n, occ)) continue;
        prev.set(k, key(cur));
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}

/** A path for `who` to a tile next to (or on) any of `targets`. */
export function pathNextTo(w: World, who: string, targets: Pos[]): Pos[] | null {
  const room = w.roomOf(who);
  const from = w.state.objects[who]?.pos;
  if (!room || !from || !targets.length) return null;
  const g = gridOf(w, room)!;
  const occ = occupancy(w, room, who);
  const near = (p: Pos) => targets.some((t) => cheb(p, t) <= 1);
  if (near(from)) return [];
  return findPath(g, from, (p) => near(p) && standable(g, p, occ), occ);
}

/** Line of sight between two tiles: no sight-blocking terrain or closed door strictly between them. */
export function lineOfSight(w: World, room: string, a: Pos, b: Pos): boolean {
  const g = gridOf(w, room);
  if (!g) return false;
  const r = w.ix.rooms.get(room)!;
  let [x, y] = a;
  const dx = Math.abs(b[0] - x);
  const dy = -Math.abs(b[1] - y);
  const sx = x < b[0] ? 1 : -1;
  const sy = y < b[1] ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 256; guard++) {
    if (x === b[0] && y === b[1]) return true;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    if (x === b[0] && y === b[1]) return true;
    const p: Pos = [x, y];
    if (!seeThrough(terrainAt(g, p))) return false;
    const exit = g.exitAt.get(key(p));
    const via = exit !== undefined ? r.exits[exit]?.via : undefined;
    if (via && w.prop(via, "open") !== true) return false;
  }
  return false;
}

/** Can `a` see `b` (both in the same room)? */
export function canSee(w: World, a: string, b: string): boolean {
  const room = w.roomOf(a);
  if (!room || room !== w.roomOf(b)) return false;
  const pa = posOf(w, a);
  const pb = posOf(w, b);
  if (!pa || !pb) return true;
  return lineOfSight(w, room, pa, pb);
}

/** Tiles between `a` and `b` (Chebyshev), or Infinity if not both placed in the same room. */
export function distance(w: World, a: string, b: string): number {
  const room = w.roomOf(a);
  if (!room || room !== w.roomOf(b)) return Number.POSITIVE_INFINITY;
  const pa = posOf(w, a);
  const pb = posOf(w, b);
  return pa && pb ? cheb(pa, pb) : Number.POSITIVE_INFINITY;
}

/** Is `who` within reach (adjacent, or on the same tile) of `id`? Things without a tile are always in reach. */
export function inReach(w: World, who: string, id: string): boolean {
  const room = w.roomOf(who);
  const from = w.state.objects[who]?.pos;
  if (!room || !from) return true;
  const tiles = reachTiles(w, room, id);
  if (!tiles.length) return true;
  return tiles.some((t) => cheb(from, t) <= 1);
}

// ─── Placement ───────────────────────────────────────────────────────────────

/** The nearest tile to `p` where a character could stand (spiralling out over walkable ground). */
export function nearestStandable(w: World, room: string, p: Pos, except?: string): Pos | null {
  const g = gridOf(w, room);
  if (!g) return null;
  const occ = occupancy(w, room, except);
  if (standable(g, p, occ)) return p;
  const seen = new Set([key(p)]);
  let frontier: Pos[] = [p];
  while (frontier.length) {
    const next: Pos[] = [];
    for (const cur of frontier) {
      for (const d of STEPS) {
        const n = add(cur, d);
        if (seen.has(key(n)) || !inBounds(g, n)) continue;
        seen.add(key(n));
        if (standable(g, n, occ)) return n;
        if (walkable(terrainAt(g, n)) || g.exitAt.has(key(n))) next.push(n);
      }
    }
    frontier = next;
  }
  // Nothing reachable over walkable ground: any standable tile at all.
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (standable(g, [x, y], occ)) return [x, y];
  return null;
}

/** The nearest walkable tile to `p` (for things that can share a tile, such as dropped items). */
function nearestWalkable(g: Grid, p: Pos): Pos {
  if (inBounds(g, p) && walkable(terrainAt(g, p)) && !g.exitAt.has(key(p))) return p;
  for (let r = 1; r < Math.max(g.w, g.h); r++) {
    for (const d of STEPS) {
      const n: Pos = [p[0] + d[0] * r, p[1] + d[1] * r];
      if (inBounds(g, n) && walkable(terrainAt(g, n)) && !g.exitAt.has(key(n))) return n;
    }
  }
  return p;
}

/** The exit tile in `room` that leads back to `fromRoom`, if any. */
export function arrivalTile(w: World, room: string, fromRoom: string | null, via?: string): Pos | null {
  const g = gridOf(w, room);
  const r = w.ix.rooms.get(room);
  if (!g || !r || !fromRoom) return null;
  const candidates = r.exits
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => x.to === fromRoom)
    .sort((a, b) => Number(b.x.via === via && !!via) - Number(a.x.via === via && !!via));
  for (const { i } of candidates) {
    const t = g.exitTiles.get(i)?.[0];
    if (t) return t;
  }
  return null;
}

/**
 * Where `id` lands when it moves into `room` from `from` (its previous location) without an explicit tile:
 * a character arriving from another room at the doorway that leads back; something dropped or thrown down at its
 * holder's feet; otherwise its authored home tile in this room, or the nearest free tile.
 */
export function placement(w: World, id: string, room: string, from: string | null, via?: string): Pos | null {
  const g = gridOf(w, room);
  if (!g || isDoor(w, id)) return null;
  const isChar = w.isChar(id);
  const fromRoom = from ? (w.isRoom(from) ? from : w.roomOf(from)) : null;
  let anchor: Pos | null = null;
  if (fromRoom && fromRoom !== room) anchor = arrivalTile(w, room, fromRoom, via);
  else if (from && !w.isRoom(from) && fromRoom === room) anchor = posOf(w, from);
  const home = g.placements.get(id)?.[0];
  if (!anchor && home) {
    if (!isChar && isFixed(w, id)) return home;
    anchor = home;
  }
  const player = w.roomOf(w.playerId) === room ? w.state.objects[w.playerId]?.pos : undefined;
  const at: Pos = anchor ?? player ?? [Math.floor(g.w / 2), Math.floor(g.h / 2)];
  return isChar ? nearestStandable(w, room, at, id) : nearestWalkable(g, at);
}

/** The exit (and its index) on tile `p` of `room`, if any. */
export function exitOnTile(w: World, room: string, p: Pos): { exit: Exit; index: number } | null {
  const g = gridOf(w, room);
  const i = g?.exitAt.get(key(p));
  if (i === undefined) return null;
  const exit = w.ix.rooms.get(room)!.exits[i];
  return exit ? { exit, index: i } : null;
}

/** Home tile of a character in `room`, if the room's map places them. */
export function homeTile(w: World, id: string, room: string): Pos | undefined {
  return gridOf(w, room)?.placements.get(id)?.[0];
}
