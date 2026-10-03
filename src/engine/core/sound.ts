/**
 * Sound (§4.11). A noise starts at its source's tile with a loudness, falls by one every three tiles, and loses more
 * passing through an exit into the next room (less through an open way, more through a closed door). Whoever it
 * reaches may hear it: plainly when it is loud enough, on a Perception roll when it is faint. Hearing is an event
 * like seeing, so behaviours, day logs and conversations all pick it up.
 */
import { attributeCheck } from "../mechanics/special.js";
import type { Noise } from "../payload/schema.js";
import { set } from "./ops.js";
import { canSee, cheb, gridOf, type Pos, posOf } from "./space.js";
import type { Cause, World } from "./world.js";

/** Loudness lost per this many tiles. */
export const TILES_PER_LEVEL = 3;
/** Loudness lost through an open way (no door, or the door open) and through a closed door. */
export const MUFFLE_OPEN = 2;
export const MUFFLE_CLOSED = 4;
/** At or above this a sound is heard without a roll; below it, a PE check at (level − PLAIN). */
export const PLAIN = 4;
/** A sleeper wakes at or above this, and hears nothing quieter. */
export const WAKES = 6;

interface Reach {
  room: string;
  /** Where the sound enters this room: the source's tile, or the doorway it came through. */
  from: Pos | null;
  level: number;
}

/** How loud a noise from `source` is in each room it reaches (its entry level and entry tile). */
export function propagate(w: World, source: string, loudness: number): Map<string, Reach> {
  const out = new Map<string, Reach>();
  const room = w.roomOf(source);
  if (!room) return out;
  const queue: Reach[] = [{ room, from: posOf(w, source), level: loudness }];
  while (queue.length) {
    queue.sort((a, b) => b.level - a.level);
    const cur = queue.shift()!;
    const prev = out.get(cur.room);
    if (prev && prev.level >= cur.level) continue;
    out.set(cur.room, cur);
    const r = w.ix.rooms.get(cur.room);
    const g = gridOf(w, cur.room);
    r?.exits.forEach((x, i) => {
      if (!x.to || x.blocked) return;
      const tiles = g?.exitTiles.get(i) ?? [];
      const d = cur.from && tiles.length ? Math.min(...tiles.map((t) => cheb(t, cur.from!))) : 0;
      const closed = !!x.via && w.prop(x.via, "open") !== true;
      const level = cur.level - Math.floor(d / TILES_PER_LEVEL) - (closed ? MUFFLE_CLOSED : MUFFLE_OPEN);
      if (level <= 0) return;
      const back = gridOf(w, x.to);
      const entry = w.ix.rooms
        .get(x.to)
        ?.exits.findIndex((y) => y.to === cur.room && (!x.via || y.via === x.via || !y.via));
      const at = entry !== undefined && entry >= 0 ? (back?.exitTiles.get(entry)?.[0] ?? null) : null;
      queue.push({ room: x.to, from: at, level });
    });
  }
  return out;
}

/** How loud the noise is where `listener` stands, given its reach into their room. */
function levelAt(w: World, reach: Reach, listener: string): number {
  const p = posOf(w, listener);
  const d = reach.from && p ? cheb(reach.from, p) : 0;
  return reach.level - Math.floor(d / TILES_PER_LEVEL);
}

export interface NoiseOptions {
  /** Who made the noise, if anyone. They don't "hear" their own doing unless `selfHears`. */
  actor?: string;
  /** The maker hears it too (a creak under your own foot is news to you). */
  selfHears?: boolean;
}

/** Makes a noise at `source` and lets everyone in earshot try to hear it. Returns who heard it. */
export function makeNoise(w: World, source: string, noise: Noise, cause: Cause, opts: NoiseOptions = {}): string[] {
  const room = w.roomOf(source);
  if (!room) return [];
  const sourceRoom = w.ix.rooms.get(room)!.name;
  w.emit("noise", {
    ...(opts.actor ? { actor: opts.actor } : {}),
    targets: [source],
    payload: { room, loudness: noise.loudness, sound: noise.sound },
    cause,
  });
  const reach = propagate(w, source, noise.loudness);
  const candidates: { who: string; level: number; near: boolean }[] = [];
  for (const [r, at] of reach) {
    for (const who of w.charsIn(r)) {
      if (who === source || (who === opts.actor && !opts.selfHears)) continue;
      const s = w.char(who);
      // Apparitions have no ears; NPCs never hear apparitions (Q31).
      if (s.status !== "ok" || !w.npcsPerceive(who)) continue;
      if (who !== w.playerId && (!w.npcsPerceive(source) || (opts.actor && !w.npcsPerceive(opts.actor)))) continue;
      const level = levelAt(w, at, who);
      if (level <= 0) continue;
      if (s.asleepUntil !== null && (level < WAKES || who === w.playerId)) continue;
      candidates.push({ who, level, near: r === room });
    }
  }
  if (!candidates.length) return [];
  const faint = candidates.filter((c) => c.level < PLAIN);
  const rolls = faint.length
    ? w.roll(
        (rng) => faint.map((c) => attributeCheck(rng, w.special(c.who).PE, c.level - PLAIN, w.special(c.who).LK).pass),
        cause,
      )
    : [];
  const heard = candidates.filter((c) => c.level >= PLAIN || rolls[faint.indexOf(c)]);
  for (const c of heard) hear(w, c.who, source, noise, room, sourceRoom, c.level, c.near, cause, opts.actor);
  return heard.map((c) => c.who);
}

function hear(
  w: World,
  who: string,
  source: string,
  noise: Noise,
  room: string,
  roomName: string,
  level: number,
  near: boolean,
  cause: Cause,
  actor?: string,
): void {
  const asleep = w.char(who).asleepUntil !== null;
  if (asleep) {
    w.emit("woke", {
      targets: [who],
      payload: { by: "noise" },
      cause,
      ops: [set(["chars", who, "asleepUntil"], null)],
    });
    if (w.roomOf(who) === w.roomOf(w.playerId) && w.isAwake(w.playerId) && w.perceives(w.playerId, who)) {
      w.say(w.msg("wake.npc", { Actor: w.label(who) }), "ambient");
    }
  }
  w.emit("heard", {
    actor: who,
    targets: [source],
    payload: { sound: noise.sound, room, level, near },
    cause,
  });
  const where = near ? "" : `, from ${roomName}`;
  w.dayLog(who, "heard", `Heard ${noise.sound}${where}.`, cause);
  if (who !== w.playerId) return;
  // What you can see happening you don't also need telling you heard.
  const seen = near && actor && actor !== who && canSee(w, who, actor) && w.perceives(who, actor);
  if (!seen) w.say(w.msg(near ? "hear.near" : "hear.far", { sound: noise.sound, room: roomName }), "ambient");
  // Hearing something from close by is how you find it (§4.11): a hidden source is revealed to the player.
  if (near && w.isHidden(source)) {
    w.emit("property-set", {
      actor: who,
      targets: [source],
      payload: { key: "revealed", value: true, prev: w.prop(source, "revealed") ?? null },
      cause,
      ops: [set(["objects", source, "props", "revealed"], true)],
    });
  }
}
