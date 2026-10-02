/**
 * The room map. Rooms have no dimensions (§4.1), so the map is a sketch: starting from the player's room, compass
 * exits place neighbours on a grid, one cell per room. Vertical and named exits (up, down, in, the lift) can't be laid
 * out on a plane; they show as marks on a room's box and, for the current room, in a legend under the grid.
 */

import type { ViewOf } from "../../session/port.js";
import { type BoxStyle, type Canvas, type Rect, S, type Span, truncate } from "./canvas.js";

export type MapView = ViewOf<"map">;

const COMPASS: Record<string, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  northeast: [1, -1],
  northwest: [-1, -1],
  southeast: [1, 1],
  southwest: [-1, 1],
  n: [0, -1],
  s: [0, 1],
  e: [1, 0],
  w: [-1, 0],
  ne: [1, -1],
  nw: [-1, -1],
  se: [1, 1],
  sw: [-1, 1],
};

const VERTICAL: Record<string, string> = { up: "▲", u: "▲", down: "▼", d: "▼" };
const OTHER_MARK = "◆";

export interface Placed {
  id: string;
  gx: number;
  gy: number;
}

/** Places rooms on a grid by breadth-first search over compass exits from the current room. */
export function placeRooms(view: MapView): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  const taken = new Set<string>();
  const visited = new Set(view.rooms.filter((r) => r.visited).map((r) => r.id));
  const put = (id: string, gx: number, gy: number) => {
    placed.set(id, { id, gx, gy });
    taken.add(`${gx},${gy}`);
  };
  put(view.here, 0, 0);
  const queue = [view.here];
  while (queue.length) {
    const id = queue.shift()!;
    const at = placed.get(id)!;
    for (const x of view.exits) {
      if (x.from !== id || !x.to || x.blocked) continue;
      const d = COMPASS[x.direction];
      if (!d || placed.has(x.to)) continue;
      const gx = at.gx + d[0];
      const gy = at.gy + d[1];
      if (taken.has(`${gx},${gy}`)) continue;
      put(x.to, gx, gy);
      // Unvisited rooms are placed but not explored beyond: the player doesn't know what's past them.
      if (visited.has(x.to)) queue.push(x.to);
    }
  }
  return placed;
}

/** The current room's exits that the grid can't show: up, down, in, out and named ways. */
export function offGridExits(view: MapView): { mark: string; label: string; to: string }[] {
  const names = new Map(view.rooms.map((r) => [r.id, r]));
  return view.exits
    .filter((x) => x.from === view.here && !x.blocked && x.to && !COMPASS[x.direction])
    .map((x) => {
      const r = names.get(x.to!);
      return { mark: VERTICAL[x.direction] ?? OTHER_MARK, label: x.label, to: r?.visited ? r.name : "?" };
    });
}

/** Draws the map into `r` on the canvas, centred on the player's room. */
export function drawMap(cv: Canvas, r: Rect, view: MapView): void {
  const legend = offGridExits(view);
  const room = Math.max(0, Math.floor(r.h / 3));
  const legendLines: Span[][] = legend.slice(0, room).map((l) => [
    { text: `${l.mark} `, sgr: S.yellow },
    { text: truncate(l.label, Math.max(1, r.w - 6)), sgr: S.bold },
    { text: truncate(` → ${l.to}`, Math.max(0, r.w - 2 - [...l.label].length)), sgr: S.grey },
  ]);
  if (legend.length > room && room > 0)
    legendLines[room - 1] = [{ text: `… ${legend.length - room + 1} more ways`, sgr: S.grey }];
  const gridH = r.h - legendLines.length;
  cv.clip(r, () => cv.block(r.x, r.y + gridH, legendLines));

  const GX = 3;
  const GY = 1;
  const BH = 4;
  const BW = Math.max(7, Math.min(16, Math.floor((r.w - 2 * GX) / 3)));
  const placed = placeRooms(view);
  const rooms = new Map(view.rooms.map((x) => [x.id, x]));
  const ox = r.x + Math.floor((r.w - BW) / 2);
  const oy = r.y + Math.floor((gridH - BH) / 2);
  const cellX = (gx: number) => ox + gx * (BW + GX);
  const cellY = (gy: number) => oy + gy * (BH + GY);
  const grid: Rect = { x: r.x, y: r.y, w: r.w, h: gridH };

  cv.clip(grid, () => {
    // Connectors first, so boxes sit on top of them.
    const drawn = new Set<string>();
    for (const x of view.exits) {
      const d = COMPASS[x.direction];
      const a = placed.get(x.from);
      if (!d || !a) continue;
      const sx = cellX(a.gx);
      const sy = cellY(a.gy);
      if (x.blocked || !x.to || !placed.has(x.to)) {
        // The edge of the block (or a way the grid can't fit): a short stub.
        if (x.blocked) stub(cv, sx, sy, BW, BH, d, GX);
        continue;
      }
      const b = placed.get(x.to)!;
      if (b.gx !== a.gx + d[0] || b.gy !== a.gy + d[1]) continue;
      const key = [x.from, x.to].sort().join("|");
      if (drawn.has(key)) continue;
      drawn.add(key);
      connect(cv, sx, sy, BW, BH, d, GX, GY);
    }
    for (const p of placed.values()) {
      const room = rooms.get(p.id);
      if (!room) continue;
      const here = p.id === view.here;
      const style: BoxStyle = here ? "double" : room.visited ? "round" : "dashed";
      const sgr = here ? S.boldYellow : room.visited ? S.none : S.grey;
      const x = cellX(p.gx);
      const y = cellY(p.gy);
      cv.fill({ x: x + 1, y: y + 1, w: BW - 2, h: BH - 2 });
      cv.box({ x, y, w: BW, h: BH }, style, sgr);
      const name = room.visited ? room.name : "?";
      const lines = wrapName(name, BW - 2);
      const shown = lines.length > 2 ? [lines[0]!, truncate(lines.slice(1).join(" "), BW - 2)] : lines;
      shown.forEach((t, i) => {
        const pad = Math.floor((BW - 2 - [...t].length) / 2);
        cv.text(x + 1 + pad, y + 1 + i, t, here ? S.boldWhite : sgr);
      });
      // Marks for exits the grid can't show, set into the bottom border.
      const marks = [
        ...new Set(
          view.exits
            .filter((e) => e.from === p.id && !e.blocked && e.to && !COMPASS[e.direction])
            .map((e) => VERTICAL[e.direction] ?? OTHER_MARK),
        ),
      ].sort();
      marks.forEach((m, i) => {
        cv.set(x + BW - 2 - marks.length + i, y + BH - 1, m, S.yellow);
      });
      if (here) cv.set(x + 1, y + BH - 1, "@", S.boldCyan);
    }
  });
}

function connect(
  cv: Canvas,
  x: number,
  y: number,
  bw: number,
  bh: number,
  d: [number, number],
  gx: number,
  gy: number,
) {
  const midX = x + Math.floor(bw / 2);
  const midY = y + Math.floor(bh / 2);
  const [dx, dy] = d;
  if (dy === 0) {
    const from = dx > 0 ? x + bw : x - gx;
    for (let i = 0; i < gx; i++) cv.set(from + i, midY, "─", S.grey);
  } else if (dx === 0) {
    const from = dy > 0 ? y + bh : y - gy;
    for (let i = 0; i < gy; i++) cv.set(midX, from + i, "│", S.grey);
  } else {
    // A diagonal: one glyph in the corner gap.
    const cx = dx > 0 ? x + bw + Math.floor(gx / 2) : x - 1 - Math.floor(gx / 2);
    const cy = dy > 0 ? y + bh : y - 1;
    cv.set(cx, cy, dx === dy ? "╲" : "╱", S.grey);
  }
}

function stub(cv: Canvas, x: number, y: number, bw: number, bh: number, d: [number, number], gx: number) {
  const midX = x + Math.floor(bw / 2);
  const midY = y + Math.floor(bh / 2);
  const [dx, dy] = d;
  if (dy === 0) cv.set(dx > 0 ? x + bw + Math.floor(gx / 2) : x - 1 - Math.floor(gx / 2), midY, "×", S.red);
  else if (dx === 0) cv.set(midX, dy > 0 ? y + bh : y - 1, "×", S.red);
}

/** Wraps a room name for a map box, breaking at spaces or after hyphens; a word too long for a line is cut short. */
export function wrapName(name: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const token of name.split(/\s+|(?<=-)/).filter(Boolean)) {
    const sep = line && !line.endsWith("-") ? " " : "";
    if ([...line].length + sep.length + [...token].length <= width) {
      line += sep + token;
      continue;
    }
    if (line) lines.push(line);
    line = truncate(token, width);
  }
  if (line) lines.push(line);
  return lines;
}
