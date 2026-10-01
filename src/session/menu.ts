/**
 * The action menu (§3.2, Q19): the actions available right now. Picks produce the same Intents as the parser.
 */
import { availableConversation, priceOf } from "../core/actions.js";
import { exitLabel } from "../core/describe.js";
import type { World } from "../core/world.js";
import type { ActionRequest } from "../payload/schema.js";
import { nounScope } from "./parser.js";
import type { MenuItem } from "./port.js";

const item = (label: string, action: ActionRequest): MenuItem => ({ label, intent: { type: "action", action } });

export function actionMenu(w: World): MenuItem[] {
  const p = w.playerId;
  const room = w.roomOf(p);
  if (!room) return [];
  const out: MenuItem[] = [];
  for (const x of w.ix.rooms.get(room)!.exits) {
    if (x.hidden && !(x.when && w.cond(x.when))) continue;
    const dir = exitLabel(x);
    const where = x.to ? ` (${w.ix.rooms.get(x.to)!.name})` : "";
    out.push(item(`go ${dir}${where}`, { act: "go", direction: x.direction ?? x.label! }));
  }
  const scope = nounScope(w);
  for (const id of scope) {
    if (w.isChar(id)) continue;
    const def = w.thing(id)!;
    const n = w.name(id);
    const held = w.isWithin(id, p);
    const heldByOther = !held && !!w.holderOf(id);
    if (heldByOther) continue;
    out.push(item(`examine ${n}`, { act: "examine", target: id }));
    if (def.affordances.includes("takeable") && !held) out.push(item(`take ${n}`, { act: "take", item: id }));
    if (held && w.locationOf(id) === p) out.push(item(`drop ${n}`, { act: "drop", item: id }));
    if (def.affordances.includes("openable")) {
      const open = w.prop(id, "open") === true;
      out.push(item(`${open ? "close" : "open"} ${n}`, { act: open ? "close" : "open", target: id }));
    }
    if (def.affordances.includes("lockable") && def.key && w.isWithin(def.key, p)) {
      const locked = w.prop(id, "locked") === true;
      out.push(item(`${locked ? "unlock" : "lock"} ${n}`, { act: locked ? "unlock" : "lock", target: id }));
    }
    if (def.uses.some((u) => !u.on) || (def.consumable && held)) out.push(item(`use ${n}`, { act: "use", item: id }));
    for (const u of def.uses) {
      if (u.on && !u.on.startsWith("tag:") && scope.includes(u.on) && held) {
        out.push(item(`use ${n} on ${w.name(u.on)}`, { act: "use", item: id, on: u.on }));
      }
    }
    if (held && (def.weapon || def.armour)) {
      const eq = w.char(p).equipment;
      const on = eq.weapon === id || eq.armour === id;
      out.push(item(`${on ? "unequip" : "equip"} ${n}`, { act: on ? "unequip" : "equip", item: id }));
    }
  }
  for (const c of w.charsIn(room, p)) {
    if (c === p) continue;
    const n = w.label(c);
    out.push(item(`examine ${n}`, { act: "examine", target: c }));
    if (w.isAwake(c) && availableConversation(w, c)) out.push(item(`talk to ${n}`, { act: "talk", target: c }));
    if (w.charDef(c).merchant && w.isAwake(c)) {
      for (const it of w.inventory(c, false)) {
        out.push(
          item(`buy ${w.name(it)} from ${n} (${priceOf(w, it, c, p, "buy")})`, { act: "buy", item: it, from: c }),
        );
      }
    }
    if (w.char(c).status !== "dead") out.push(item(`attack ${n}`, { act: "attack", target: c }));
  }
  const bed = scope.find((id) => w.thing(id)?.affordances.includes("sleepable"));
  out.push(
    item(bed ? `sleep on ${w.name(bed)}` : "sleep on the floor", { act: "sleep", ...(bed ? { target: bed } : {}) }),
  );
  out.push(
    w.isSneaking(p) ? item("stop sneaking", { act: "sneak", stop: true }) : item("start sneaking", { act: "sneak" }),
  );
  out.push(item("wait 10 minutes", { act: "wait", minutes: 10 }));
  out.push(item("wait an hour", { act: "wait", minutes: 60 }));
  return out;
}
