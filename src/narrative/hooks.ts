/**
 * The hook executor (§6.4): where the constructed touches the ground. The LLM chooses whether and when to invoke a
 * hook; the engine checks it is on offer, validates its arguments, checks its guard and applies its effects.
 */
import { applyEffects } from "../core/effects.js";
import { push } from "../core/ops.js";
import type { Cause, World } from "../core/world.js";

export interface HookCallInput {
  id: string;
  args: { name: string; value: string | number | boolean }[];
}

export interface HookOutcome {
  ok: boolean;
  summary: string;
}

export function invokeHook(
  w: World,
  call: HookCallInput,
  allowed: readonly string[],
  self: string,
  by: Cause["by"],
): HookOutcome {
  const refuse = (why: string): HookOutcome => {
    w.emit("hook-refused", { actor: self, payload: { hook: call.id, why }, cause: { by, ref: call.id } });
    return { ok: false, summary: `hook ${call.id} refused: ${why}` };
  };
  if (!allowed.includes(call.id)) return refuse("not available here");
  const hook = w.ix.hooks.get(call.id);
  if (!hook) return refuse("unknown hook");
  if (hook.once && w.state.hooksUsed.includes(hook.id)) return refuse("already used");

  const given = Object.fromEntries(call.args.map((a) => [a.name, a.value]));
  const args: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(hook.params)) {
    let v = given[name];
    if (v === undefined) return refuse(`missing argument ${name}`);
    if (p.type === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) return refuse(`argument ${name} must be a number`);
      v = Math.max(p.min ?? Number.NEGATIVE_INFINITY, Math.min(p.max ?? Number.POSITIVE_INFINITY, n));
    } else if (p.type === "boolean") {
      v = v === true || v === "true";
    } else {
      v = String(v);
      if (p.enum && !p.enum.includes(v)) return refuse(`argument ${name} must be one of ${p.enum.join(", ")}`);
    }
    args[name] = v;
  }

  const cause: Cause = { by: "hook", ref: hook.id };
  if (hook.guard && !w.cond(hook.guard, { self, args })) return refuse("its conditions do not hold");
  w.emit("hook-fired", {
    actor: self,
    payload: { hook: hook.id, args },
    cause,
    ops: hook.once ? [push(["hooksUsed"], hook.id)] : [],
  });
  applyEffects(w, hook.effects, cause, { self, args });
  const what = hook.description.charAt(0).toLowerCase() + hook.description.slice(1);
  w.dayLog(self, "hook", `You chose to ${what.replace(/\.$/, "")}.`, cause);
  return { ok: true, summary: `hook ${hook.id} applied` };
}
