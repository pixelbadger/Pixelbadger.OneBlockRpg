/**
 * SDL keyboard events as the client's KeyInput (DOM key names). Named keys come from `keyDown`; printable characters
 * from `textInput`, which has shift and the keyboard layout applied ("?" rather than shift+"/"). A printable key held
 * with ctrl or alt sends no text, so it comes from `keyDown`, for the host.
 */

import type { KeyInput } from "../../client/input.js";

/** SDL's key names (@kmamal/sdl) to the DOM's. */
const NAMED: Readonly<Record<string, string>> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  return: "Enter",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  pageUp: "PageUp",
  pageDown: "PageDown",
  home: "Home",
  end: "End",
  backspace: "Backspace",
};

/** The modifiers SDL reports on a key event (non-zero when held). */
export interface SdlKey {
  key: string | null;
  shift?: number | boolean;
  ctrl?: number | boolean;
  alt?: number | boolean;
}

/** A keyDown as a KeyInput, or undefined when its character will arrive as text (or it means nothing here). */
export function fromKeyDown(e: SdlKey): KeyInput | undefined {
  if (!e.key) return undefined;
  const mods = {
    ...(e.shift ? { shift: true } : {}),
    ...(e.ctrl ? { ctrl: true } : {}),
    ...(e.alt ? { alt: true } : {}),
  };
  const named = NAMED[e.key];
  if (named) return { key: named, ...mods };
  const ch = e.key === "space" ? " " : [...e.key].length === 1 ? e.key : undefined;
  return ch && (e.ctrl || e.alt) ? { key: ch, ...mods } : undefined;
}

/** A textInput as one KeyInput a character. */
export function fromText(text: string): KeyInput[] {
  return [...text].map((key) => ({ key }));
}
