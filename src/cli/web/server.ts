/**
 * `oneblock serve`: the TUI (§3.1 adapter) in a browser. Each tab is an xterm.js terminal on a WebSocket; the server
 * runs one game per tab through the same runTui as `play --tui`, with pictures sent as iTerm2 inline images, which
 * xterm.js's image addon shows. A tab's game is saved under its id and resumes when the tab comes back.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { Payload } from "../../payload/schema.js";
import { openGame } from "../game.js";
import { runTui } from "../tui/app.js";
import type { SpriteSet } from "../tui/sprites.js";
import { page } from "./page.js";

export interface ServeOptions {
  payload: Payload;
  sprites?: SpriteSet | undefined;
  port: number;
  host: string;
  /** Directory for each tab's save. */
  saves: string;
  provider: string;
  model?: string;
}

export interface Server {
  url: string;
  close: () => Promise<void>;
}

const require = createRequire(import.meta.url);
const xtermFile = (pkg: string, file: string) => join(dirname(require.resolve(`${pkg}/package.json`)), file);

/** Static files the page loads: xterm.js and its addons, from node_modules. */
const STATIC: Record<string, { file: string; type: string }> = {
  "/xterm/xterm.js": { file: xtermFile("@xterm/xterm", "lib/xterm.js"), type: "text/javascript" },
  "/xterm/xterm.css": { file: xtermFile("@xterm/xterm", "css/xterm.css"), type: "text/css" },
  "/xterm/addon-fit.js": { file: xtermFile("@xterm/addon-fit", "lib/addon-fit.js"), type: "text/javascript" },
  "/xterm/addon-image.js": { file: xtermFile("@xterm/addon-image", "lib/addon-image.js"), type: "text/javascript" },
};

const GAME_ID = /^[A-Za-z0-9-]{8,64}$/;

export async function serve(o: ServeOptions): Promise<Server> {
  mkdirSync(o.saves, { recursive: true });
  const cache = new Map<string, Buffer>();
  const html = page(o.payload.game.title, o.payload.game.id);
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    const file = STATIC[path];
    if (!file) {
      res.writeHead(404).end("not found");
      return;
    }
    let body = cache.get(path);
    if (!body) {
      body = readFileSync(file.file);
      cache.set(path, body);
    }
    res.writeHead(200, { "content-type": `${file.type}; charset=utf-8`, "cache-control": "max-age=3600" });
    res.end(body);
  });

  const playing = new Set<string>();
  const wss = new WebSocketServer({ server: http, path: "/play", maxPayload: 64 * 1024 });
  wss.on("connection", (ws, req) => {
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const id = q.get("game") ?? "";
    if (!GAME_ID.test(id)) {
      ws.close(1008, "bad game id");
      return;
    }
    if (playing.has(id)) {
      ws.close(1008, "this game is open in another tab");
      return;
    }
    playing.add(id);
    const size = (v: string | null, d: number) => Math.max(20, Math.min(500, Number(v) || d));
    void play(ws, id, size(q.get("cols"), 120), size(q.get("rows"), 40), o)
      .catch((err) => {
        if (ws.readyState === ws.OPEN) ws.close(1011, String(err instanceof Error ? err.message : err).slice(0, 120));
      })
      .finally(() => playing.delete(id));
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(o.port, o.host, () => resolve());
  });
  const addr = http.address() as AddressInfo;
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    url: `http://${host}:${addr.port}/`,
    close: async () => {
      for (const c of wss.clients) c.close(1001, "server stopping");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** One tab's game: a terminal made of the socket, and runTui on it until the tab goes or the player quits. */
async function play(ws: WebSocket, id: string, cols: number, rows: number, o: ServeOptions): Promise<void> {
  const { input, output } = socketTerminal(ws, cols, rows);
  const game = await openGame(o.payload, {
    savePath: join(o.saves, `${o.payload.game.id}-${id}.db`),
    provider: o.provider,
    ...(o.model ? { model: o.model } : {}),
  });
  const ended = new AbortController();
  ws.on("close", () => ended.abort());
  try {
    await runTui({
      session: game.session,
      title: o.payload.game.title,
      banner: `${o.payload.game.title} (provider: ${game.providerId}; ${game.resuming ? "resumed" : "new game"}; press ? for keys)`,
      flush: game.flush,
      graphics: o.sprites ? "iip" : "none",
      truecolor: true,
      signal: ended.signal,
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      ...(o.sprites ? { sprites: o.sprites } : {}),
    });
  } finally {
    game.close();
    if (ws.readyState === ws.OPEN) ws.close(1000, "game over");
  }
}

/** Streams that look enough like a TTY for runTui: keys in, screen out, resizes from the page. */
export function socketTerminal(ws: WebSocket, cols: number, rows: number) {
  const input = Object.assign(new PassThrough({ encoding: "utf8" }), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      input.isRaw = mode;
      return input;
    },
  });
  const output = Object.assign(
    new Writable({
      decodeStrings: false,
      highWaterMark: 1 << 20,
      write(chunk: string | Buffer, _enc, done) {
        if (ws.readyState !== ws.OPEN) return done();
        ws.send(typeof chunk === "string" ? chunk : chunk.toString("utf8"), (err) => done(err ?? undefined));
      },
    }),
    { isTTY: true, columns: cols, rows },
  );
  ws.on("message", (raw) => {
    let m: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.t === "in" && typeof m.d === "string") input.write(m.d);
    else if (m.t === "size" && Number.isInteger(m.cols) && Number.isInteger(m.rows)) {
      output.columns = Math.max(20, Math.min(500, m.cols as number));
      output.rows = Math.max(10, Math.min(300, m.rows as number));
      output.emit("resize");
    }
  });
  // A dropped connection never drains: let the game end instead of waiting on it. Late writes are dropped.
  output.on("error", () => {});
  ws.on("close", () => output.destroy());
  return { input, output };
}
