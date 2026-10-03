/**
 * The map lint (§7.7, §7.10): every room's tile map is well formed, places everything that starts in the room, gives
 * every exit a tile, and can be crossed on foot.
 */

import { compileMap, DIRS, type Grid, inBounds, key, type Pos, terrainAt, walkable } from "../core/space.js";
import type { Payload, Room } from "./schema.js";

export interface MapIssue {
  severity: "error" | "warning";
  room: string;
  /** Path inside the room entity, e.g. ["map", "rows", 3]. */
  path: PropertyKey[];
  message: string;
  fix?: string;
}

const MAX = 64;

export function checkMaps(p: Payload): MapIssue[] {
  const issues: MapIssue[] = [];
  const objects = new Map(p.objects.map((o) => [o.id, o]));
  const chars = new Map(p.characters.map((c) => [c.id, c]));
  const doors = new Set(p.rooms.flatMap((r) => r.exits.flatMap((x) => (x.via ? [x.via] : []))));
  const playerId = p.game.player.character;
  const roomIds = new Set(p.rooms.map((r) => r.id));
  for (const room of p.rooms) {
    const add = (severity: MapIssue["severity"], path: PropertyKey[], message: string, fix?: string) =>
      issues.push({ severity, room: room.id, path: ["map", ...path], message, ...(fix ? { fix } : {}) });
    const g = compileMap(room);
    for (const pr of g.problems) add("error", pr.row !== undefined ? ["rows", pr.row] : ["rows"], pr.message, pr.fix);
    if (g.w > MAX || g.h > MAX) add("error", ["rows"], `map is ${g.w}×${g.h}; the most is ${MAX}×${MAX}`);
    for (const [ch, entry] of Object.entries(room.map.legend)) {
      if ([...ch].length !== 1) add("error", ["legend", ch], `legend keys are one character, not '${ch}'`);
      if ("object" in entry && !objects.has(entry.object)) {
        add("error", ["legend", ch, "object"], `object '${entry.object}' does not exist`);
      }
      if ("character" in entry && !chars.has(entry.character) && entry.character !== "player") {
        add("error", ["legend", ch, "character"], `character '${entry.character}' does not exist`);
      }
      if (("object" in entry || "character" in entry) && entry.on && !walkable(entry.on)) {
        add("error", ["legend", ch, "on"], `things can't stand on ${entry.on}`, "use a floor terrain");
      }
    }
    // Legend may say `character: player`.
    const placed = new Map(g.placements);
    const playerTiles = placed.get("player");
    if (playerTiles) {
      placed.delete("player");
      placed.set(playerId, [...(placed.get(playerId) ?? []), ...playerTiles]);
    }

    // Everything that starts here stands on the map.
    for (const o of p.objects) {
      if (o.location !== room.id || doors.has(o.id) || placed.has(o.id)) continue;
      add(
        "error",
        ["legend"],
        `object '${o.id}' starts in this room but isn't on its map`,
        `give it a legend letter and put the letter on a tile`,
      );
    }
    for (const c of p.characters) {
      const starts = c.id === playerId ? p.game.start === room.id : c.location === room.id;
      if (!starts || placed.has(c.id)) continue;
      add(
        "error",
        ["legend"],
        `character '${c.id}' starts in this room but isn't on its map`,
        `give them a legend letter and put it on a tile`,
      );
    }
    for (const [id, tiles] of placed) {
      const o = objects.get(id);
      const isChar = chars.has(id);
      if (isChar && tiles.length > 1)
        add("error", ["rows"], `character '${id}' is on ${tiles.length} tiles; a character stands on one`);
      if (o?.affordances.includes("takeable") && tiles.length > 1) {
        add(
          "error",
          ["rows"],
          `'${id}' is takeable but covers ${tiles.length} tiles`,
          "only fixed objects cover several tiles",
        );
      }
      if (o?.location && o.location !== room.id && !doors.has(id) && roomIds.has(o.location)) {
        add(
          "warning",
          ["legend"],
          `object '${id}' is on this map but starts in '${o.location}'`,
          "remove it from this map or move it here",
        );
      }
      if (o && doors.has(id))
        add("warning", ["legend"], `'${id}' is a door; it is drawn on its exit's tile`, "remove it from the legend");
    }

    // Every exit has a tile.
    room.exits.forEach((x, i) => {
      if (!g.exitTiles.has(i)) {
        add(
          "error",
          ["legend"],
          `exit '${x.direction ?? x.label}' has no tile`,
          `add e.g. "D": { exit: "${x.direction ?? x.label}" } and put D on the map`,
        );
      }
    });

    // Nothing shares a tile with a fixed object or another character.
    const fixedTiles = new Map<string, string>();
    for (const [id, tiles] of placed) {
      const fixed = objects.get(id) && !objects.get(id)!.affordances.includes("takeable");
      if (!fixed && !chars.has(id)) continue;
      for (const t of tiles) {
        const other = fixedTiles.get(key(t));
        if (other && other !== id)
          add("error", ["rows", t[1]], `'${id}' and '${other}' are on the same tile ${t[0]},${t[1]}`);
        fixedTiles.set(key(t), id);
      }
    }

    // On foot: everything is reachable from the first way in.
    reachability(room, g, placed, objects, p.game.start === room.id ? placed.get(playerId)?.[0] : undefined, add);
  }
  return issues;
}

function reachability(
  room: Room,
  g: Grid,
  placed: Map<string, Pos[]>,
  objects: Map<string, Payload["objects"][number]>,
  start: Pos | undefined,
  add: (severity: MapIssue["severity"], path: PropertyKey[], message: string, fix?: string) => void,
): void {
  const blocked = new Set<string>();
  for (const [id, tiles] of placed) {
    const o = objects.get(id);
    if (o && !o.affordances.includes("takeable")) for (const t of tiles) blocked.add(key(t));
  }
  const free = (q: Pos) => inBounds(g, q) && walkable(terrainAt(g, q)) && !g.exitAt.has(key(q)) && !blocked.has(key(q));
  // Seeds: the player's start, else free tiles next to the first exit.
  const seeds: Pos[] = [];
  if (start) seeds.push(start);
  else {
    const first = [...g.exitTiles.values()][0]?.[0];
    if (!first) return;
    for (const d of Object.values(DIRS)) {
      const q: Pos = [first[0] + d[0], first[1] + d[1]];
      if (free(q)) seeds.push(q);
    }
  }
  const region = new Set(seeds.map(key));
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const d of Object.values(DIRS)) {
      const q: Pos = [cur[0] + d[0], cur[1] + d[1]];
      if (region.has(key(q)) || !free(q)) continue;
      if (
        d[0] &&
        d[1] &&
        !(walkable(terrainAt(g, [cur[0] + d[0], cur[1]])) && walkable(terrainAt(g, [cur[0], cur[1] + d[1]])))
      )
        continue;
      region.add(key(q));
      queue.push(q);
    }
  }
  const touches = (tiles: Pos[]) =>
    tiles.some(
      (t) => region.has(key(t)) || Object.values(DIRS).some((d) => region.has(key([t[0] + d[0], t[1] + d[1]]))),
    );
  room.exits.forEach((x, i) => {
    const tiles = g.exitTiles.get(i);
    if (tiles && !touches(tiles)) {
      add(
        "error",
        ["rows", tiles[0]![1]],
        `exit '${x.direction ?? x.label}' can't be reached on foot`,
        "clear a path of walkable tiles to it",
      );
    }
  });
  for (const [id, tiles] of placed) {
    if (!touches(tiles)) {
      add("error", ["rows", tiles[0]![1]], `'${id}' can't be reached on foot`, "clear a path of walkable tiles to it");
    }
  }
}
