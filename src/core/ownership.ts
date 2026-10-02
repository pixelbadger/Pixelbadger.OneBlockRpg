/**
 * Ownership (§4.13). Things can belong to someone. Taking, forcing or breaking what isn't yours is a transgression
 * when someone sees it: they think less of you and remember it. Owners also notice, on their own, when something of
 * theirs is gone from its place or has been forced, whoever did it. The block polices itself; nothing here decides
 * what anyone does about it, which is left to behaviours and conversations.
 */
import { describeEvent } from "./describe.js";
import { adjustRelationship, setProp } from "./mutate.js";
import { canSee } from "./space.js";
import type { Cause, World } from "./world.js";

/** May `actor` take or force `id` without it being a transgression? */
export function entitled(w: World, actor: string, id: string): boolean {
  const def = w.thing(id);
  if (!def?.owner || actor === def.owner) return true;
  return !!def.permitted && w.cond(def.permitted, { self: actor });
}

/** Trust lost by a witness, and by an owner who sees it done to their own things. */
export const WITNESS_TRUST = -10;
export const OWNER_TRUST = -20;

/**
 * Records that `actor` did `act` to `id` without the right to. Only matters when someone sees it: each witness
 * thinks less of the actor and remembers it; nobody seeing means nothing (yet: the owner may notice later).
 */
export function transgress(w: World, actor: string, id: string, act: "took" | "forced" | "broke", cause: Cause): void {
  if (entitled(w, actor, id)) return;
  const owner = w.thing(id)!.owner!;
  const room = w.roomOf(actor);
  if (!room) return;
  const witnesses = w
    .witnessesIn(room)
    .filter((o) => o !== actor && w.npcsPerceive(o) && w.perceives(o, actor) && canSee(w, o, actor));
  if (!witnesses.length) return;
  w.emit("transgression", { actor, targets: [id, owner], payload: { act, witnesses }, cause });
  const whose = owner === actor ? "" : `${w.label(owner)}'s `;
  const what = (w.thing(id)!.name ?? id).replace(/^(the|a|an|some)\s+/i, "");
  const verb = act === "took" ? "take" : act === "forced" ? "force" : "break";
  for (const o of witnesses) {
    if (o === w.playerId) continue;
    adjustRelationship(
      w,
      o,
      actor,
      o === owner ? { trust: OWNER_TRUST, affinity: -10 } : { trust: WITNESS_TRUST },
      cause,
    );
    const text =
      o === owner
        ? `Saw ${w.label(actor)} ${verb} my ${what} without asking.`
        : `Saw ${w.label(actor)} ${verb} ${whose}${what} without asking.`;
    w.dayLog(o, "witnessed", text, cause);
  }
}

const ENGINE: Cause = { by: "engine", ref: "ownership" };

/**
 * Owners notice what has happened to their things when they are where those things should be: gone from its place
 * (and not with someone entitled to it), or forced or broken. Something they carry is missed wherever they are. Each
 * is noticed once, until it is put right.
 */
export function noticeLosses(w: World): void {
  for (const def of w.payload.objects) {
    const owner = def.owner;
    if (!owner || !w.isChar(owner) || !w.isAwake(owner)) continue;
    const id = def.id;
    const where = w.roomOf(owner);
    if (!where) continue;
    const home = def.location ?? null;
    if (home && (!w.isChar(home) || home === owner)) {
      const carried = home === owner;
      const homeRoom = carried ? where : w.isRoom(home) ? home : w.roomOf(home);
      const here = carried ? w.isWithin(id, owner) : w.locationOf(id) === home;
      const holder = w.holderOf(id);
      const missing = !here && !(holder && entitled(w, holder, id));
      if (!missing && w.prop(id, "_missing") === true) setProp(w, id, "_missing", false, ENGINE);
      if (missing && homeRoom === where && w.prop(id, "_missing") !== true) {
        setProp(w, id, "_missing", true, ENGINE);
        const e = w.emit("noticed-missing", { actor: owner, targets: [id], cause: ENGINE });
        w.dayLog(owner, "witnessed", describeEvent(w, e) ?? "", ENGINE);
      }
    }
    const damaged = w.prop(id, "forced") === true || w.prop(id, "broken") === true;
    if (damaged && w.roomOf(id) === where && w.prop(id, "_damage_noticed") !== true) {
      setProp(w, id, "_damage_noticed", true, ENGINE);
      const e = w.emit("noticed-damage", { actor: owner, targets: [id], cause: ENGINE });
      w.dayLog(owner, "witnessed", describeEvent(w, e) ?? "", ENGINE);
    }
  }
}
