/**
 * Sound design, shared by every host: which cue a turn's views call for, and which ambience beds the scene wants.
 * TODO(audio): there are no sounds yet. Cue ids are provisional until the payload sound manifest (`sounds.json`, see
 * docs/plans/frontend-platforms.md) exists; a payload will map these ids (or its own, via `look.sound`) to files.
 */

import type { ViewModel, ViewOf } from "../engine/session/port.js";
import type { AudioOut } from "../platform/index.js";

/** One-shot cues for a turn's output, in order. */
export function cuesFor(views: readonly ViewModel[], playerId?: string): string[] {
  const out: string[] = [];
  for (const v of views) {
    if (v.type === "fx") {
      for (const f of v.fx) {
        if (f.kind === "walk") {
          if (f.id === playerId) out.push("step");
        } else if (f.kind === "hit") out.push(f.crit ? "crit" : f.ranged ? "shot" : "hit");
        else out.push(f.kind);
      }
    } else if (v.type === "narration") {
      if (v.kind === "journal") out.push("journal");
      else if (v.kind === "callout") out.push("callout");
    } else if (v.type === "conversation" || v.type === "ended") out.push(v.type);
  }
  return out;
}

/** The looping beds for a scene: one per room tag, and the time of day outdoors. */
export function ambienceFor(scene: ViewOf<"scene">): string[] {
  const day = scene.minute >= 360 && scene.minute < 1260;
  const beds = scene.tags.map((t) => `room/${t}`);
  if (scene.tags.includes("outdoors")) beds.push(day ? "outdoors/day" : "outdoors/night");
  return beds;
}

/** Plays a turn's cues, and changes the ambience when the beds differ from `playing`. Returns what now plays. */
export function playCues(
  audio: AudioOut,
  views: readonly ViewModel[],
  scene: ViewOf<"scene"> | undefined,
  playing: readonly string[],
): string[] {
  const player = scene?.things.find((t) => t.player)?.id;
  for (const id of cuesFor(views, player)) audio.cue(id);
  const beds = scene ? ambienceFor(scene) : [];
  if (beds.join() !== playing.join()) audio.ambience(beds);
  return beds;
}
