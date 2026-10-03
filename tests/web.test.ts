import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SpriteSheet } from "../src/client/sprites.js";
import { FONT_FILES } from "../src/client/theme.js";
import { World } from "../src/engine/core/world.js";
import { offlineProvider } from "../src/engine/narrative/offline.js";
import { MemorySaveBackend, SaveStore } from "../src/engine/session/save.js";
import { Session } from "../src/engine/session/session.js";
import { embeddedAssets } from "../src/hosts/web/assets.js";
import { fontPath, GAME_DATA_ID, page, type WebGame } from "../src/hosts/web/page.js";
import { buildWeb } from "../tools/web.js";
import { EXAMPLE, example, mini } from "./helpers.js";

/** A PNG's size from its header, standing in for a decoder. */
const pngSize = async (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
};

const embedded = (html: string) =>
  JSON.parse(
    html.match(new RegExp(`<script type="application/json" id="${GAME_DATA_ID}">(.*?)</script>`, "s"))![1]!,
  ) as WebGame;

describe("saves", () => {
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

describe("the web page", () => {
  it("embeds the game so that no text in it can close the script", () => {
    const payload = mini();
    payload.game.title = "</script><b>Mini</b>";
    const html = page({ payload });
    expect(html).toContain("<title>&lt;/script&gt;&lt;b&gt;Mini&lt;/b&gt;</title>");
    expect(embedded(html).payload.game.title).toBe("</script><b>Mini</b>");
    // The look is inline: the font faces and the theme's tokens.
    expect(html).toContain(`url("../${fontPath(FONT_FILES[0].file)}")`);
    expect(html).toContain("--ob-background:");
    expect(html).toContain(".style-danger");
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
    expect(js).not.toMatch(/xterm/i);
    for (const f of FONT_FILES) expect(existsSync(join(out, fontPath(f.file)))).toBe(true);
    expect(readFileSync(join(out, "fonts", "OFL.txt"), "utf8")).toContain("SIL OPEN FONT LICENSE");
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain('href="the-pier/"');

    const html = readFileSync(join(out, "carver-street", "index.html"), "utf8");
    expect(html).toContain('src="../oneblock.js"');
    expect(html).not.toMatch(/xterm/i);
    const game = embedded(html);
    expect(game.payload).toEqual(JSON.parse(JSON.stringify(example())));
    expect(game.assets).toBeUndefined();

    const art = embedded(readFileSync(join(out, "the-pier", "index.html"), "utf8")).assets!;
    const sheet = await SpriteSheet.load(embeddedAssets(art), pngSize);
    const manifest = JSON.parse(Buffer.from(art["sprites.json"]!, "base64").toString("utf8"));
    expect(sheet!.size).toBe(Object.keys(manifest.sprites).length);
  }, 60_000);

  it("refuses a payload with errors", async () => {
    await expect(buildWeb([join(out, "missing")], join(out, "bad"))).rejects.toThrow(/error/);
  });
});
