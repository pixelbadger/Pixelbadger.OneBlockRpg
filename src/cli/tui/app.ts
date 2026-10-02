/**
 * The full-screen TUI: an adapter on the UI port (§3.1) alongside the readline CLI. It drives a Session with the
 * same intents and draws its view models into a story pane, a room map, a character panel and an inventory.
 */

import { emitKeypressEvents } from "node:readline";
import type { Session } from "../../session/session.js";
import { compose, emptyState, type TuiState, toParagraphs } from "./frame.js";

export interface TuiOptions {
  session: Session;
  title: string;
  /** Shown in the scrollback before the game starts (provider, save path…). */
  banner: string;
  /** Called after every turn so the game is saved. */
  flush: () => void;
  /** Handles front-end commands (save, usage); returns text to show, or null if `line` isn't one. */
  command?: (line: string) => string | null;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error("--tui needs an interactive terminal");
  const { session } = opts;
  const st: TuiState = emptyState(opts.title);
  const history: string[] = [];
  let historyAt = 0;
  let page = 10;
  let maxScroll = 0;
  let spinner: NodeJS.Timeout | undefined;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  let quitting = false;

  const refreshPanels = () => {
    st.mode = session.mode;
    if (st.mode === "create") return;
    st.status = session.statusView();
    st.sheet = session.sheetView();
    st.inventory = session.inventoryView();
    st.map = session.mapView();
  };

  const draw = () => {
    const cols = output.columns ?? 80;
    const rows = output.rows ?? 24;
    const f = compose(st, cols, rows);
    page = Math.max(1, f.page);
    maxScroll = f.maxScroll;
    st.scroll = Math.min(st.scroll, maxScroll);
    let out = "\x1b[?25l";
    f.canvas.lines(true).forEach((line, i) => {
      out += `\x1b[${i + 1};1H${line}`;
    });
    if (f.cursor) out += `\x1b[${f.cursor.y + 1};${f.cursor.x + 1}H\x1b[?25h`;
    output.write(out);
  };

  const append = (paras: TuiState["log"]) => {
    st.log.push(...paras);
    // Keep the scrollback bounded on very long sessions.
    if (st.log.length > 5000) st.log.splice(0, st.log.length - 5000);
    st.scroll = 0;
  };

  const setBusy = (busy: boolean) => {
    st.busy = busy;
    if (busy && !spinner) {
      spinner = setInterval(() => {
        st.tick++;
        draw();
      }, 80);
    } else if (!busy && spinner) {
      clearInterval(spinner);
      spinner = undefined;
    }
  };

  const quit = () => {
    if (quitting) return;
    quitting = true;
    done();
  };

  const submit = async (line: string) => {
    const text = line.trim();
    if (!text) return;
    if (history[history.length - 1] !== text) history.push(text);
    historyAt = history.length;
    if (["quit", "exit", "q"].includes(text.toLowerCase())) return quit();
    append([{ spans: [{ text: `› ${text}`, sgr: "1;36" }] }]);
    const own = opts.command?.(text);
    if (own != null) {
      append([{ spans: [{ text: own, sgr: "90" }] }]);
      return;
    }
    setBusy(true);
    draw();
    try {
      const out = await session.handle({ type: "command", text });
      opts.flush();
      append(toParagraphs(out.views));
    } catch (err) {
      append([{ spans: [{ text: `Error: ${err instanceof Error ? err.message : String(err)}`, sgr: "31" }] }]);
    } finally {
      setBusy(false);
      refreshPanels();
    }
    if (session.mode === "ended") st.notice = "The end. Press any key to leave.";
  };

  const insert = (s: string) => {
    const chars = [...st.input];
    chars.splice(st.cursor, 0, ...s);
    st.input = chars.join("");
    st.cursor += [...s].length;
  };

  const onKey = (str: string | undefined, key: Key = {}) => {
    if (st.notice) return quit();
    if (key.ctrl && (key.name === "c" || key.name === "d")) return quit();
    if (key.ctrl && key.name === "l") return draw();
    // Scrolling works while the model is thinking; editing waits.
    switch (key.name) {
      case "pageup":
        st.scroll = Math.min(maxScroll, st.scroll + Math.max(1, page - 2));
        return draw();
      case "pagedown":
        st.scroll = Math.max(0, st.scroll - Math.max(1, page - 2));
        return draw();
    }
    if (st.busy) return;
    const chars = [...st.input];
    switch (key.name) {
      case "return":
      case "enter": {
        const line = st.input;
        st.input = "";
        st.cursor = 0;
        void submit(line).then(draw);
        return;
      }
      case "backspace":
        if (st.cursor > 0) {
          chars.splice(st.cursor - 1, 1);
          st.input = chars.join("");
          st.cursor--;
        }
        break;
      case "delete":
        chars.splice(st.cursor, 1);
        st.input = chars.join("");
        break;
      case "left":
        st.cursor = Math.max(0, st.cursor - 1);
        break;
      case "right":
        st.cursor = Math.min(chars.length, st.cursor + 1);
        break;
      case "home":
        st.cursor = 0;
        break;
      case "end":
        st.cursor = chars.length;
        break;
      case "up":
      case "down": {
        if (!history.length) break;
        historyAt = Math.max(0, Math.min(history.length, historyAt + (key.name === "up" ? -1 : 1)));
        st.input = history[historyAt] ?? "";
        st.cursor = [...st.input].length;
        break;
      }
      default:
        if (key.ctrl && key.name === "u") {
          st.input = "";
          st.cursor = 0;
        } else if (key.ctrl && key.name === "a") st.cursor = 0;
        else if (key.ctrl && key.name === "e") st.cursor = chars.length;
        else if (str && !key.ctrl && !key.meta && printable(str)) insert(str);
        else return;
    }
    draw();
  };

  const restore = () => {
    if (spinner) clearInterval(spinner);
    input.off("keypress", onKey);
    output.off("resize", draw);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  };
  const onExit = () => restore();

  output.write("\x1b[?1049h\x1b[2J");
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  input.on("keypress", onKey);
  output.on("resize", draw);
  process.once("exit", onExit);
  process.once("SIGTERM", quit);
  try {
    append([{ spans: [{ text: opts.banner, sgr: "90" }] }]);
    const start = session.start();
    opts.flush();
    append(toParagraphs(start.views));
    refreshPanels();
    if (session.mode === "ended") st.notice = "The end. Press any key to leave.";
    draw();
    await finished;
  } finally {
    process.off("exit", onExit);
    process.off("SIGTERM", quit);
    restore();
  }
}

/** True when every character is printable (no control codes), so it belongs in the input line. */
function printable(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}
