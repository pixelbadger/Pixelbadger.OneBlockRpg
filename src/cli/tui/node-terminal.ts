/** The TUI's terminal when it runs in this process's TTY (`play --tui`). */

import { emitKeypressEvents } from "node:readline";
import type { Terminal } from "./app.js";

export function nodeTerminal(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Terminal {
  if (!input.isTTY || !output.isTTY) throw new Error("--tui needs an interactive terminal");
  return {
    get columns() {
      return output.columns;
    },
    get rows() {
      return output.rows;
    },
    get congested() {
      return output.writableNeedDrain;
    },
    write: (text) => void output.write(text),
    listen(onKey, onResize) {
      // If the process dies mid-game, give the shell its terminal back.
      const onExit = () => {
        input.setRawMode(false);
        output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
      };
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", onKey);
      output.on("resize", onResize);
      process.once("exit", onExit);
      return () => {
        process.off("exit", onExit);
        input.off("keypress", onKey);
        output.off("resize", onResize);
        input.setRawMode(false);
        input.pause();
      };
    },
  };
}
