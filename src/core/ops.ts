/**
 * Event ops: the only way world state changes. Each event carries the ops that apply it, so loading a save is a
 * snapshot plus a fold of the events after it (§3.7).
 */
import type { WorldState } from "./state.js";

export type Path = (string | number)[];

export type Op =
  | { op: "set"; path: Path; value: unknown }
  | { op: "push"; path: Path; value: unknown }
  | { op: "del"; path: Path }
  /** Remove array elements equal (by JSON) to value. */
  | { op: "pull"; path: Path; value: unknown };

export const set = (path: Path, value: unknown): Op => ({ op: "set", path, value: clone(value) });
export const push = (path: Path, value: unknown): Op => ({ op: "push", path, value: clone(value) });
export const del = (path: Path): Op => ({ op: "del", path });
export const pull = (path: Path, value: unknown): Op => ({ op: "pull", path, value: clone(value) });

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function parentOf(root: unknown, path: Path, create: boolean): Record<string | number, unknown> {
  let cur = root as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    let next = cur[k];
    if (next === undefined || next === null) {
      if (!create) throw new Error(`op path missing at ${path.slice(0, i + 1).join(".")}`);
      next = typeof path[i + 1] === "number" ? [] : {};
      cur[k] = next;
    }
    cur = next as Record<string | number, unknown>;
  }
  return cur;
}

export function applyOp(state: WorldState, op: Op): void {
  const key = op.path[op.path.length - 1]!;
  switch (op.op) {
    case "set": {
      parentOf(state, op.path, true)[key] = clone(op.value);
      return;
    }
    case "del": {
      const parent = parentOf(state, op.path, true);
      if (Array.isArray(parent) && typeof key === "number") parent.splice(key, 1);
      else delete parent[key];
      return;
    }
    case "push": {
      const parent = parentOf(state, op.path, true);
      if (!Array.isArray(parent[key])) parent[key] = [];
      (parent[key] as unknown[]).push(clone(op.value));
      return;
    }
    case "pull": {
      const parent = parentOf(state, op.path, true);
      const arr = (parent[key] ?? []) as unknown[];
      const needle = JSON.stringify(op.value);
      parent[key] = arr.filter((x) => JSON.stringify(x) !== needle);
      return;
    }
  }
}

export function applyOps(state: WorldState, ops: readonly Op[]): void {
  for (const op of ops) applyOp(state, op);
}
