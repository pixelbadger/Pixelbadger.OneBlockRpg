/**
 * Input, host-neutral. Keys use the DOM's KeyboardEvent.key names, which hosts without a DOM (SDL) translate to.
 * Pointer input is already resolved by the host to what was hit: a map tile (scene.ts `tileAt`), a menu row, an
 * option. HTML clicks and canvas clicks so drive the same paths as the keys.
 */

import type { Tile } from "../engine/session/port.js";
import type { Command } from "./keymap.js";

/**
 * A key press. `key` is KeyboardEvent.key: "ArrowUp", "Enter", "Escape", "Tab", "PageUp", "PageDown", "Home",
 * "End", "Backspace", " ", "a", "A", "1", "?"… Keys with `ctrl` or `alt` are left to the host.
 */
export interface KeyInput {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export type PointerInput =
  /**
   * A click on a map tile. Primary: while aiming, do the verb to that tile. Otherwise, exploring: on a person, talk
   * (look, if they can't); on an item or an open container, get; on another thing, look; on an exit, go through it;
   * on yourself, look around. In a fight: on an enemy, attack. Anywhere else: one step towards the tile (in a fight,
   * a 1 AP move). Secondary: look at what is there, or cancel aiming. A click on the scene closes a non-sticky menu.
   */
  | { kind: "tile"; tile: Tile; button: "primary" | "secondary" }
  /** The pointer is over a tile: while aiming, the cursor follows it. */
  | { kind: "hover"; tile: Tile }
  /** A row of the open menu (Model.menu.items), chosen. */
  | { kind: "menu"; index: number }
  /** A conversation option, by its index in the conversation view. */
  | { kind: "option"; index: number }
  /** A skill row of the stats overlay, raised. */
  | { kind: "skill"; index: number }
  /** The overlay's buttons. "next" on the last page closes it. */
  | { kind: "overlay"; action: "next" | "prev" | "close" }
  /** The custom-character screen: pick an attribute row, raise or lower it, finish or cancel. */
  | { kind: "allot"; action: "select" | "raise" | "lower" | "done" | "cancel"; index?: number }
  /** The log scrolled by `delta` pages (positive is back in time). */
  | { kind: "scroll"; delta: number }
  /** A toolbar button: the same as the command's key. */
  | { kind: "command"; command: Command };
