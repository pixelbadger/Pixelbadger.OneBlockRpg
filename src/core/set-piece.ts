/**
 * Set-piece state in the core (§6.7). The director that runs inside a set piece lives in the narrative layer;
 * starting, beats and ending (with outcomes) are plain state changes here.
 */
import { applyEffects } from "./effects.js";
import { push, set } from "./ops.js";
import type { SetPieceState } from "./state.js";
import type { Cause, World } from "./world.js";

export const beatId = (b: string | { id: string }) => (typeof b === "string" ? b : b.id);

export function startSetPiece(w: World, id: string, cause: Cause): boolean {
  if (w.state.setPiece || w.state.setPiecesDone.includes(id)) return false;
  const def = w.ix.setPieces.get(id);
  if (!def) return false;
  const sp: SetPieceState = { id, beat: 0, beatsDone: [], startedAt: w.state.clock, turns: 0, narration: [] };
  w.emit("set-piece-started", { targets: [...def.cast], payload: { id }, cause, ops: [set(["setPiece"], sp)] });
  w.say(def.objective, "system");
  return true;
}

export function advanceBeat(w: World, to: string | undefined, cause: Cause): void {
  const sp = w.state.setPiece;
  if (!sp) return;
  const def = w.ix.setPieces.get(sp.id)!;
  const ids = def.beats.map(beatId);
  const next = to ? ids.indexOf(to) : sp.beat + 1;
  if (next < 0 || next >= ids.length || next === sp.beat) return;
  w.emit("beat-advanced", {
    payload: { from: ids[sp.beat], to: ids[next] },
    cause,
    ops: [set(["setPiece", "beat"], next), push(["setPiece", "beatsDone"], ids[sp.beat])],
  });
}

/** Ends the active set piece: applies every outcome whose condition holds, and logs a summary for participants. */
export function endSetPiece(w: World, cause: Cause): void {
  const sp = w.state.setPiece;
  if (!sp) return;
  const def = w.ix.setPieces.get(sp.id)!;
  const outcomes = def.outcomes.filter((o) => !o.when || w.cond(o.when));
  const ids = def.beats.map(beatId);
  const reached = [...sp.beatsDone, ids[sp.beat]].filter(Boolean).join(", ");
  const summary = `${def.objective} — beats: ${reached}.${sp.narration.length ? ` ${sp.narration.slice(-3).join(" ")}` : ""}`;
  w.emit("set-piece-ended", {
    targets: [...def.cast],
    payload: { id: sp.id, summary },
    cause,
    ops: [set(["setPiece"], null), push(["setPiecesDone"], sp.id)],
  });
  for (const who of [w.playerId, ...def.cast]) {
    if (w.isChar(who) && (who === w.playerId || w.npcsPerceive(who))) w.dayLog(who, "set-piece", summary, cause);
  }
  for (const o of outcomes) applyEffects(w, o.do, { by: "trigger", ref: `${sp.id}.outcomes` });
}
