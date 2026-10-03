/**
 * The keymap, in the manner of Ultima V: one key per verb, then a target. Data, so hosts can show it as help or as
 * buttons (a button sends `{ kind: "command" }`, the same path as its key).
 */

import type { Tile } from "../engine/session/port.js";

export type Command =
  | "attack"
  | "talk"
  | "look"
  | "get"
  | "drop"
  | "use"
  | "open"
  | "lock"
  | "push"
  | "ready"
  | "hurl"
  | "give"
  | "filch"
  | "barter"
  | "wait"
  | "sneak"
  | "pass"
  | "stats"
  | "journal"
  | "intro"
  | "inventory"
  | "actions"
  | "help"
  | "quit";

export interface Binding {
  /** The key as KeyInput names it (lower case for letters). */
  key: string;
  /** How to show the key. */
  label: string;
  command: Command;
  /** What it does, in a word or two. */
  name: string;
  /** Usable in a fight. */
  combat: boolean;
}

const b = (key: string, command: Command, name: string, combat = true, label = key.toUpperCase()): Binding => ({
  key,
  label,
  command,
  name,
  combat,
});

/** Every command key, in the order the help lists them. */
export const KEYMAP: readonly Binding[] = [
  b("a", "attack", "attack"),
  b("t", "talk", "talk", false),
  b("l", "look", "look"),
  b("g", "get", "get", false),
  b("d", "drop", "drop", false),
  b("u", "use", "use"),
  b("o", "open", "open/close", false),
  b("k", "lock", "lock", false),
  b("p", "push", "push", false),
  b("r", "ready", "ready"),
  b("h", "hurl", "hurl", false),
  b("v", "give", "give", false),
  b("f", "filch", "filch", false),
  b("b", "barter", "barter", false),
  b("w", "wait", "wait", false),
  b("s", "sneak", "sneak", false),
  b(" ", "pass", "pass", true, "Space"),
  b("z", "stats", "stats"),
  b("j", "journal", "journal"),
  b("n", "intro", "introduction"),
  b("i", "inventory", "pack"),
  b("m", "actions", "every action here"),
  b("?", "help", "help", true, "?"),
  b("q", "quit", "quit"),
];

const BY_KEY = new Map(KEYMAP.map((x) => [x.key, x.command]));

/** The command a key runs, if any (letters either case). */
export const commandFor = (key: string): Command | undefined => BY_KEY.get(key.length === 1 ? key.toLowerCase() : key);

/** Walking: the arrows and the numpad digits, as steps. */
export const DIRECTION_KEYS: Readonly<Record<string, Tile>> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  "1": [-1, 1],
  "2": [0, 1],
  "3": [1, 1],
  "4": [-1, 0],
  "6": [1, 0],
  "7": [-1, -1],
  "8": [0, -1],
  "9": [1, -1],
};

/** The compass name of a one-tile step. */
export function directionName(d: Tile): string {
  const ns = d[1] < 0 ? "north" : d[1] > 0 ? "south" : "";
  const ew = d[0] < 0 ? "west" : d[0] > 0 ? "east" : "";
  return ns + ew;
}

export const HELP_LINES = [
  "Arrows (or numpad 1–9) walk. Walk into a doorway or stairs to leave. In a fight each tile costs 1 AP.",
  "Click a tile to step towards it, a person to talk (an enemy, in a fight, to attack), a thing to get or look at; right-click looks.",
  "A attack   T talk     L look     G get       D drop     U use      O open/close",
  "K lock     P push     R ready    H hurl      V give     F filch    B barter",
  "W wait     S sneak    Space pass (end turn in a fight)",
  "Z stats    J journal  N introduction   I pack   M every action here   PgUp/PgDn scroll   ? help   Q quit",
  "Picking a target: arrows move the cursor, Tab cycles targets, Enter acts, Esc cancels.",
  "Menus: arrows or numbers, Enter chooses, Esc goes back.",
];
