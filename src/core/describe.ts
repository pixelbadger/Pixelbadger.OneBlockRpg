/** Rendering authored text for rooms, objects and events (P5: all of it authored or templated, none generated). */

import type { Exit } from "../payload/schema.js";
import { listJoin } from "./messages.js";
import type { World, WorldEvent } from "./world.js";

export interface ExitView {
  label: string;
  to?: string;
  blocked: boolean;
}

export function exitLabel(x: Exit): string {
  return x.direction ?? x.label ?? "?";
}

/** Exits the player can see from a room (hidden exits only once their condition holds). */
export function visibleExits(w: World, room: string): ExitView[] {
  const r = w.ix.rooms.get(room);
  if (!r) return [];
  return r.exits
    .filter((x) => !x.hidden || (x.when ? w.cond(x.when) : false))
    .map((x) => ({ label: exitLabel(x), ...(x.to ? { to: x.to } : {}), blocked: !!x.blocked }));
}

/** Objects the player sees listed in a room: not scenery, not characters, not hidden. */
export function listedObjects(w: World, room: string): string[] {
  return w
    .childrenOf(room)
    .filter((id) => !w.isChar(id) && !w.thing(id)?.scenery && !w.isHidden(id) && w.perceives(w.playerId, id));
}

export function charLine(w: World, id: string): string {
  const s = w.char(id);
  const Actor = w.label(id);
  if (s.status === "dead") return w.msg("room.person-dead", { Actor });
  if (s.status === "down") return w.msg("room.person-down", { Actor });
  if (s.asleepUntil !== null) return w.msg("room.person-asleep", { Actor });
  const room_text = w.thing(id)?.room_text;
  if (room_text) return w.text(room_text, { self: id });
  if (s.intent) return w.msg("room.person-intent", { Actor, intent: s.intent });
  return w.msg("room.person", { Actor });
}

export interface RoomDescription {
  id: string;
  name: string;
  description: string;
  objects: string[];
  people: string[];
  exits: ExitView[];
}

export function describeRoom(w: World, room: string): RoomDescription {
  const r = w.ix.rooms.get(room)!;
  const objects: string[] = [];
  const plain: string[] = [];
  const visible = (id: string) => !w.isHidden(id) && w.perceives(w.playerId, id);
  const contentsLine = (id: string) => {
    if (!w.isContainer(id) || !w.isOpen(id)) return;
    const inside = w
      .childrenOf(id)
      .filter((c) => !w.isChar(c) && !w.thing(c)?.scenery && visible(c))
      .map((c) => w.name(c).replace(/^the /, "a "));
    const key = w.thing(id)!.affordances.includes("surface") ? "room.contents-on" : "room.contents-of";
    if (inside.length) objects.push(w.msg(key, { container: w.name(id), list: listJoin(inside) }));
  };
  for (const id of w.childrenOf(room)) {
    if (w.isChar(id) || !visible(id)) continue;
    const def = w.thing(id)!;
    if (!def.scenery) {
      if (def.room_text) objects.push(w.text(def.room_text, { self: id }));
      else plain.push(w.name(id).replace(/^the /, "a "));
    }
    // Contents of open containers and surfaces, scenery included (a desk, a shelf).
    contentsLine(id);
  }
  if (plain.length) objects.unshift(w.msg("room.you-see", { list: listJoin(plain) }));
  const people = w
    .charsIn(room, w.playerId)
    .filter((c) => c !== w.playerId)
    .map((c) => charLine(w, c));
  return {
    id: room,
    name: r.name,
    description: w.text(r.description, { self: w.playerId }),
    objects,
    people,
    exits: visibleExits(w, room),
  };
}

/** A plain third-person sentence for an event, used in day logs and prompts (§6.8). */
export function describeEvent(w: World, e: WorldEvent): string | null {
  const a = e.actor ? w.label(e.actor) : "Someone";
  const t = (i: number) => (e.targets[i] ? w.label(e.targets[i]!) : "something");
  switch (e.kind) {
    case "moved": {
      const to = e.payload.to as string | null;
      return to && w.isRoom(to) ? `${t(0)} went to ${w.ix.rooms.get(to)!.name}.` : null;
    }
    case "took":
      return `${a} took ${t(0)}.`;
    case "dropped":
      return `${a} dropped ${t(0)}.`;
    case "put":
      return `${a} put ${t(0)} in ${t(1)}.`;
    case "opened":
      return `${a} opened ${t(0)}.`;
    case "closed":
      return `${a} closed ${t(0)}.`;
    case "locked":
      return `${a} locked ${t(0)}.`;
    case "unlocked":
      return `${a} unlocked ${t(0)}.`;
    case "used":
      return e.targets[1] ? `${a} used ${t(0)} on ${t(1)}.` : `${a} used ${t(0)}.`;
    case "thrown":
      return e.targets[1] ? `${a} threw ${t(0)} at ${t(1)}.` : `${a} threw ${t(0)}.`;
    case "pushed":
      return `${a} pushed ${t(0)}.`;
    case "broken":
      return `${t(0)} broke.`;
    case "gave":
      return `${a} gave ${t(0)} to ${t(1)}.`;
    case "showed":
      return `${a} showed ${t(0)} to ${t(1)}.`;
    case "caught-stealing":
      return `${a} was caught trying to steal ${t(0)} from ${t(1)}.`;
    case "bought":
      return `${a} bought ${t(0)} from ${t(1)}.`;
    case "sold":
      return `${a} sold ${t(0)} to ${t(1)}.`;
    case "attacked":
      return `${a} attacked ${t(0)}.`;
    case "downed":
      return `${t(0)} was knocked unconscious${e.actor ? ` by ${a}` : ""}.`;
    case "killed":
      return `${t(0)} was killed${e.actor ? ` by ${a}` : ""}.`;
    case "fled":
      return `${t(0)} fled the fight.`;
    case "pursued":
      return `${a} chased after ${t(0)}.`;
    case "surrendered":
      return `${t(0)} surrendered.`;
    case "slept":
      return `${t(0)} went to sleep.`;
    case "collapsed":
      return `${t(0)} collapsed from exhaustion.`;
    case "spawned":
      return `${t(0)} appeared.`;
    case "narrated":
      return (e.payload.text as string) ?? null;
    case "said":
      return `${a} said: "${e.payload.text as string}"`;
    default:
      return null;
  }
}

/** Event kinds worth a witnessed day-log entry. */
export const WITNESSED = new Set([
  "took",
  "dropped",
  "put",
  "used",
  "thrown",
  "pushed",
  "broken",
  "gave",
  "showed",
  "caught-stealing",
  "bought",
  "sold",
  "attacked",
  "downed",
  "killed",
  "fled",
  "pursued",
  "surrendered",
  "collapsed",
  "spawned",
  "said",
  "opened",
  "unlocked",
]);
