import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { afterAll, describe, expect, it } from "vitest";
import { World } from "../src/engine/core/world.js";
import { offlineProvider } from "../src/engine/narrative/offline.js";
import { MemorySaveBackend, SaveStore } from "../src/engine/session/save.js";
import { Session } from "../src/engine/session/session.js";
import { runTui } from "../src/hosts/cli/tui/app.js";
import { image } from "../src/hosts/cli/tui/png.js";
import { SpriteSet } from "../src/hosts/cli/tui/sprites.js";
import { GAME_DATA_ID, type WebGame } from "../src/hosts/cli/web/page.js";
import { deleteBrowserSave, openBrowserSave } from "../src/hosts/cli/web/save-idb.js";
import { decodeKeys, type XtermLike, xtermTerminal } from "../src/hosts/cli/web/terminal.js";
import { gameOnStore as startGame } from "../src/platform/game.js";
import { buildWeb } from "../tools/web.js";
import { EXAMPLE, example, mini } from "./helpers.js";

/** A pattern with ESC spelled out (biome bars control characters in regex literals). */
const pattern = (source: string) => new RegExp(source.replaceAll("ESC", "\\x1b"));

/** Enough of xterm.js to run the TUI against: keys go in with `type`, the screen comes out in `screen`. */
function fakeXterm(cols = 120, rows = 40) {
  let onData: (d: string) => void = () => {};
  const term = {
    cols,
    rows,
    screen: "",
    write(data: string, cb?: () => void) {
      term.screen += data;
      setTimeout(() => cb?.(), 0);
    },
    onData(fn: (d: string) => void) {
      onData = fn;
      return { dispose: () => {} };
    },
    onResize() {
      return { dispose: () => {} };
    },
    type: (d: string) => onData(d),
  } satisfies XtermLike & Record<string, unknown>;
  return term;
}

describe("browser keys", () => {
  it("decodes terminal input the way Node's readline names keys", () => {
    const keys = (d: string) =>
      decodeKeys(d).map((k) => [k.str, k.key.name, !!k.key.ctrl, !!k.key.meta, !!k.key.shift]);
    expect(keys("\r")).toEqual([["\r", "return", false, false, false]]);
    expect(keys("aB1 ")).toEqual([
      ["a", "a", false, false, false],
      ["B", "b", false, false, true],
      ["1", "1", false, false, false],
      [" ", "space", false, false, false],
    ]);
    expect(keys("\x1b[A\x1bOB\x1b[5~\x1b[6~\x1b[H\x1b[F")).toEqual([
      [undefined, "up", false, false, false],
      [undefined, "down", false, false, false],
      [undefined, "pageup", false, false, false],
      [undefined, "pagedown", false, false, false],
      [undefined, "home", false, false, false],
      [undefined, "end", false, false, false],
    ]);
    expect(keys("\x1b")).toEqual([[undefined, "escape", false, false, false]]);
    expect(keys("\x1b[Z")).toEqual([[undefined, "tab", false, false, true]]);
    expect(keys("\x1b[1;5C")).toEqual([[undefined, "right", true, false, false]]);
    expect(keys("\x03\x7f\t")).toEqual([
      ["\x03", "c", true, false, false],
      ["\x7f", "backspace", false, false, false],
      ["\t", "tab", false, false, false],
    ]);
    expect(keys("\x1bx")).toEqual([[undefined, "x", false, true, false]]);
    expect(keys("é")).toEqual([["é", undefined, false, false, false]]);
  });
});

describe("the TUI on xterm.js", () => {
  it("plays through a browser terminal, with pictures as inline images", async () => {
    const sprites = new SpriteSet(16);
    sprites.add("terrain/floor", image(16, 16));
    const term = fakeXterm();
    const store = new SaveStore(new MemorySaveBackend());
    const game = startGame(mini(), store, offlineProvider(), { resuming: false, seed: "web" });
    const stop = new AbortController();
    const until = async (re: RegExp) => {
      for (let i = 0; i < 100 && !re.test(term.screen); i++) await new Promise((r) => setTimeout(r, 20));
      return re.test(term.screen);
    };
    const running = runTui({
      session: game.session,
      title: "Mini",
      banner: "Mini",
      flush: game.flush,
      graphics: "iip",
      sprites,
      truecolor: true,
      terminal: xtermTerminal(term),
      signal: stop.signal,
    });
    try {
      expect(await until(pattern(String.raw`ESC\[\?1049h`))).toBe(true);
      expect(await until(pattern(String.raw`ESC\]1337;File=inline=1`))).toBe(true);
      // An arrow key is a step: an ordinary input, saved like a typed one.
      term.type("\x1b[C");
      for (let i = 0; i < 100 && !store.inputs().length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(store.inputs()).toHaveLength(1);
    } finally {
      stop.abort();
      await running;
      game.close();
    }
    expect(term.screen.endsWith("\x1b[?1049l")).toBe(true);
  });
});

describe("browser saves (IndexedDB)", () => {
  it("writes behind to IndexedDB and resumes to the same state", async () => {
    const idb = new IDBFactory();
    const errors: unknown[] = [];
    const payload = mini();
    const first = await openBrowserSave("mini", (e) => errors.push(e), idb);
    expect(first.resuming).toBe(false);
    const game = startGame(payload, first.store, offlineProvider(), { resuming: false, seed: "idb" });
    game.session.start();
    game.flush();
    await game.session.handle({ type: "command", text: "Talker" });
    game.flush();
    await game.session.handle({ type: "command", text: "look" });
    game.close();
    // close() lets queued writes land before the database closes.
    await new Promise((r) => setTimeout(r, 50));

    const again = await openBrowserSave("mini", (e) => errors.push(e), idb);
    expect(again.resuming).toBe(true);
    const loaded = again.store.load(payload);
    expect(loaded.state).toEqual(game.world.state);
    expect(loaded.log.length).toBe(game.world.log.length);
    expect(again.store.inputs()).toEqual(first.store.inputs());

    // Another save in the same database is separate; deleting one leaves the other.
    const other = await openBrowserSave("other", (e) => errors.push(e), idb);
    expect(other.resuming).toBe(false);
    other.store.init(payload, World.create(payload, "o"), "offline");
    other.store.close();
    await new Promise((r) => setTimeout(r, 50));
    await deleteBrowserSave("mini", idb);
    expect((await openBrowserSave("mini", () => {}, idb)).resuming).toBe(false);
    expect((await openBrowserSave("other", () => {}, idb)).resuming).toBe(true);
    expect(errors).toEqual([]);
  });

  it("keeps the latest snapshot when resuming", async () => {
    const store = new SaveStore(new MemorySaveBackend());
    const payload = mini();
    const w = World.create(payload, "snap");
    store.init(payload, w, "offline");
    store.attach(w);
    const session = new Session(w, { provider: offlineProvider() });
    session.start();
    store.flush(w);
    expect(store.load(payload).state).toEqual(w.state);
  });
});

describe("the browser build", () => {
  const out = mkdtempSync(join(tmpdir(), "oneblock-web-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("bundles the engine for the browser and embeds each payload in its own page", async () => {
    const pier = join(EXAMPLE, "..", "the-pier");
    const result = await buildWeb([EXAMPLE, pier], out, { minify: false });
    expect(result.games.map((g) => g.id).sort()).toEqual(["carver-street", "the-pier"]);
    const js = readFileSync(join(out, "oneblock.js"), "utf8");
    expect(js).not.toMatch(/require\(["']node:/);
    expect(js).toContain("dangerouslyAllowBrowser");
    expect(readFileSync(join(out, "xterm.css"), "utf8")).toContain(".xterm");
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain('href="the-pier/"');

    const html = readFileSync(join(out, "carver-street", "index.html"), "utf8");
    expect(html).toContain('src="../oneblock.js"');
    const json = html.match(new RegExp(`<script type="application/json" id="${GAME_DATA_ID}">(.*?)</script>`, "s"));
    const embedded = JSON.parse(json![1]!) as WebGame;
    expect(embedded.payload).toEqual(JSON.parse(JSON.stringify(example())));
    expect(embedded.sprites).toBeUndefined();

    const pierPage = readFileSync(join(out, "the-pier", "index.html"), "utf8");
    const pierGame = JSON.parse(pierPage.match(/id="oneblock-game">(.*?)<\/script>/s)![1]!) as WebGame;
    const art = pierGame.sprites!;
    const set = SpriteSet.fromManifest(art.manifest, (f) => Buffer.from(art.files[f]!, "base64"));
    expect(set.size).toBe(Object.keys(art.manifest.sprites).length);
  }, 60_000);

  it("refuses a payload with errors", async () => {
    await expect(buildWeb([join(out, "missing")], join(out, "bad"))).rejects.toThrow(/error/);
  });
});
