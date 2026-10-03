/**
 * Showing images in the terminal: the kitty graphics protocol (kitty, Ghostty) and iTerm2's inline images (iTerm2,
 * WezTerm, and xterm.js with its image addon, which the web frontend uses). The scene is one picture over a block of
 * cells that text never writes to (Canvas.punch); it is sent again only when it changes.
 */

import type { Rect } from "./canvas.js";
import { crc32, encodePng, type Image } from "./png.js";

export type Graphics = "kitty" | "iip" | "none";

export const GRAPHICS: readonly Graphics[] = ["kitty", "iip", "none"];

/** Guesses what the terminal can show from its environment. Inside tmux or screen, nothing (they drop images). */
export function detectGraphics(env: NodeJS.ProcessEnv = process.env): Graphics {
  const forced = env.ONEBLOCK_GRAPHICS?.toLowerCase();
  if (forced && (GRAPHICS as string[]).includes(forced)) return forced as Graphics;
  if (env.TMUX || /^screen/.test(env.TERM ?? "")) return "none";
  const program = env.TERM_PROGRAM ?? "";
  if (env.TERM === "xterm-kitty" || env.KITTY_WINDOW_ID || /ghostty/i.test(program) || env.TERM === "xterm-ghostty")
    return "kitty";
  if (/iTerm\.app|WezTerm/i.test(program) || env.LC_TERMINAL === "iTerm2") return "iip";
  return "none";
}

const ESC = "\x1b";

/** Base64 without Buffer, so this runs in a browser too. */
export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const ST = `${ESC}\\`;
/** Below cells with a non-default background, so menus drawn over the scene hide it (kitty's z-index rule). */
const UNDER_TEXT = -1_073_741_825;

/** Shows a PNG over `cols`×`rows` cells at the cursor, without moving it, as kitty image `id`. */
export function kittyImage(png: Uint8Array, id: number, cols: number, rows: number): string {
  const data = base64(png);
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += 4096) parts.push(data.slice(i, i + 4096));
  if (!parts.length) parts.push("");
  return parts
    .map((p, i) => {
      const more = i < parts.length - 1 ? 1 : 0;
      const head =
        i === 0 ? `a=T,f=100,q=2,C=1,i=${id},p=1,c=${cols},r=${rows},z=${UNDER_TEXT},m=${more}` : `m=${more}`;
      return `${ESC}_G${head};${p}${ST}`;
    })
    .join("");
}

/** Deletes kitty image `id` (and frees it), or every image. */
export const kittyDelete = (id?: number): string =>
  id === undefined ? `${ESC}_Ga=d,d=A,q=2${ST}` : `${ESC}_Ga=d,d=I,i=${id},q=2${ST}`;

/** Shows a PNG stretched over `cols`×`rows` cells at the cursor (iTerm2's inline image protocol). */
export function iipImage(png: Uint8Array, cols: number, rows: number): string {
  const data = base64(png);
  return `${ESC}]1337;File=inline=1;size=${png.length};width=${cols};height=${rows};preserveAspectRatio=0:${data}\x07`;
}

/** Keeps one picture on screen, sending it again only when it (or where it goes) changes. */
export class Painter {
  private last = "";
  private id = 1;

  constructor(readonly mode: Exclude<Graphics, "none">) {}

  /** Escape codes to show `img` over `r` (in cells); empty if the screen already shows it, unless `force`. */
  paint(img: Image, r: Rect, force = false): string {
    const key = `${r.x},${r.y},${r.w},${r.h},${img.w}x${img.h},${crc32(img.data)}`;
    if (!force && key === this.last) return "";
    this.last = key;
    const png = encodePng(img, 1);
    const at = `${ESC}[${r.y + 1};${r.x + 1}H`;
    if (this.mode === "iip") return at + iipImage(png, r.w, r.h);
    // Two ids in turn: place the new picture, then drop the old one, so it never flickers.
    const prev = this.id;
    this.id = prev === 1 ? 2 : 1;
    return at + kittyImage(png, this.id, r.w, r.h) + kittyDelete(prev);
  }

  /** Takes the picture away (kitty; with inline images, text drawn over it does that). */
  clear(): string {
    if (!this.last) return "";
    this.last = "";
    return this.mode === "kitty" ? kittyDelete() : "";
  }
}
