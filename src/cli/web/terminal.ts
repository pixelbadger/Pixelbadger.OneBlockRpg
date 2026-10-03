/**
 * The TUI's terminal in a browser: xterm.js. Keys arrive as the bytes a terminal would send; they are decoded into
 * the same shape as Node's keypress events, so the TUI's controller can't tell the difference.
 */

import type { Terminal } from "../tui/app.js";
import type { Key } from "../tui/ui.js";

/** The parts of an xterm.js Terminal this uses. */
export interface XtermLike {
  readonly cols: number;
  readonly rows: number;
  write(data: string, callback?: () => void): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
}

/** Frames in flight before drawing skips one (xterm.js parses writes asynchronously). */
const MAX_IN_FLIGHT = 3;

export function xtermTerminal(term: XtermLike): Terminal {
  let inFlight = 0;
  return {
    get columns() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    get congested() {
      return inFlight >= MAX_IN_FLIGHT;
    },
    write(text) {
      inFlight++;
      term.write(text, () => {
        inFlight--;
      });
    },
    listen(onKey, onResize) {
      const data = term.onData((d) => {
        for (const k of decodeKeys(d)) onKey(k.str, k.key);
      });
      const resize = term.onResize(() => onResize());
      return () => {
        data.dispose();
        resize.dispose();
      };
    },
  };
}

const CSI_NAMES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  F: "end",
  H: "home",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
  "1~": "home",
  "2~": "insert",
  "3~": "delete",
  "4~": "end",
  "5~": "pageup",
  "6~": "pagedown",
  "7~": "home",
  "8~": "end",
};

// After ESC: [ or O, optional params, then a final letter or ~.
const CSI = /^(?:\[|O)([\d;]*)([A-Za-z~])/;

/** Splits terminal input into keypresses, named as Node's readline names them. */
export function decodeKeys(data: string): { str: string | undefined; key: Key }[] {
  const out: { str: string | undefined; key: Key }[] = [];
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const csi = rest[0] === "\x1b" ? rest.slice(1).match(CSI) : null;
    if (csi) {
      const [body, params, final] = csi as unknown as [string, string, string];
      const seq = `\x1b${body}`;
      const parts = params.split(";");
      const code = final === "~" ? `${parts[0]}~` : final;
      const mod = Number(parts[1] ?? 1) - 1;
      const name = final === "Z" ? "tab" : CSI_NAMES[code];
      const key: Key = {
        sequence: seq,
        shift: final === "Z" || !!(mod & 1),
        meta: !!(mod & 2),
        ctrl: !!(mod & 4),
        ...(name ? { name } : {}),
      };
      out.push({ str: undefined, key });
      i += seq.length;
      continue;
    }
    // ESC then a character is that character with meta; ESC alone (or ESC ESC) is escape.
    if (rest[0] === "\x1b" && rest.length > 1 && rest[1] !== "\x1b") {
      const ch = Array.from(rest.slice(1))[0]!;
      const k = plain(ch);
      out.push({ str: undefined, key: { ...k.key, sequence: `\x1b${ch}`, meta: true } });
      i += 1 + ch.length;
      continue;
    }
    const ch = Array.from(rest)[0]!;
    const k = plain(ch);
    // As in Node, a key that starts with ESC comes without a string.
    out.push(ch === "\x1b" ? { str: undefined, key: k.key } : k);
    i += ch.length;
  }
  return out;
}

function plain(ch: string): { str: string; key: Key } {
  const key: Key = { sequence: ch, ctrl: false, meta: false, shift: false };
  if (ch === "\r") key.name = "return";
  else if (ch === "\n") key.name = "enter";
  else if (ch === "\t") key.name = "tab";
  else if (ch === "\b" || ch === "\x7f") key.name = "backspace";
  else if (ch === "\x1b") key.name = "escape";
  else if (ch === " ") key.name = "space";
  else if (ch.length === 1 && ch <= "\x1a") {
    key.name = String.fromCharCode(ch.charCodeAt(0) + 96);
    key.ctrl = true;
  } else if (/^[0-9A-Za-z]$/.test(ch)) {
    key.name = ch.toLowerCase();
    key.shift = /^[A-Z]$/.test(ch);
  }
  return { str: ch, key };
}
