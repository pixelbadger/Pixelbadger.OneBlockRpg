import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../src/engine/llm/anthropic-api.js";
import { dirAssets } from "../src/hosts/node/assets.js";
import { nodePlatform } from "../src/hosts/node/platform.js";
import { nodeProviders } from "../src/hosts/node/providers.js";
import { defaultSaveRoot, SqliteSaveStorage } from "../src/hosts/node/save-sqlite.js";
import { defaultSettingsPath, FileSettings } from "../src/hosts/node/settings.js";
import { embeddedAssets } from "../src/hosts/web/assets.js";
import { flushOnHide, IdbSaveStorage } from "../src/hosts/web/save-idb.js";
import { LocalSettings } from "../src/hosts/web/settings.js";
import { startGame } from "../src/platform/game.js";
import { DEFAULT_SLOT, type Platform, type SaveStorage, silentAudio } from "../src/platform/index.js";
import { MemorySettings, memoryPlatform, offlineProviders, overlaySettings } from "../src/platform/memory.js";
import { mini } from "./helpers.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "oneblock-platform-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const on = (saves: SaveStorage): Platform => ({ ...memoryPlatform(), saves });

/** Starts a game in `slot`, plays a turn or two, and closes it; returns the final state. */
async function playSome(platform: Platform, o: { slot?: string; seed?: string } = {}) {
  const game = await startGame(mini(), platform, { providerId: "offline", seed: o.seed ?? "p", ...o });
  expect(game.resuming).toBe(false);
  game.session.start();
  game.flush();
  await game.session.handle({ type: "command", text: "Talker" });
  game.flush();
  await game.session.handle({ type: "command", text: "look" });
  game.flush();
  const inputs = game.store.inputs();
  game.close();
  return { state: game.world.state, events: game.world.log.length, inputs };
}

/** Every storage: start, write through a game, list, resume, start over, delete. */
async function roundTrip(saves: SaveStorage): Promise<void> {
  const platform = on(saves);
  expect(await saves.list("mini")).toEqual([]);
  const played = await playSome(platform);
  await saves.settled();

  const listed = await saves.list("mini");
  expect(listed.map((s) => s.slot)).toEqual([DEFAULT_SLOT]);
  expect(listed[0]!.meta).toMatchObject({ payloadId: "mini", seed: "p", provider: "offline" });
  expect(listed[0]!.updated).toBeGreaterThan(Date.now() - 60_000);
  expect(await saves.list("other-game")).toEqual([]);

  const again = await startGame(mini(), platform, { providerId: "offline" });
  expect(again.resuming).toBe(true);
  expect(again.world.state).toEqual(played.state);
  expect(again.world.log.length).toBe(played.events);
  expect(again.store.inputs()).toEqual(played.inputs);
  again.close();
  await saves.settled();

  // Another slot is separate.
  await playSome(platform, { slot: "second", seed: "q" });
  await saves.settled();
  expect((await saves.list("mini")).map((s) => s.slot).sort()).toEqual(["main", "second"]);

  // `fresh` starts over in the slot.
  const fresh = await startGame(mini(), platform, { providerId: "offline", fresh: true, seed: "r" });
  expect(fresh.resuming).toBe(false);
  expect(fresh.store.meta().seed).toBe("r");
  fresh.close();
  await saves.settled();

  await saves.delete("mini", "second");
  expect((await saves.list("mini")).map((s) => s.slot)).toEqual([DEFAULT_SLOT]);
  await saves.delete("mini", DEFAULT_SLOT);
  expect(await saves.list("mini")).toEqual([]);
  const after = await startGame(mini(), platform, { providerId: "offline" });
  expect(after.resuming).toBe(false);
  after.close();
}

describe("startGame over a platform", () => {
  it("resumes from memory storage", async () => {
    await roundTrip(memoryPlatform().saves);
  });

  it("records the provider's id and rejects one the platform lacks", async () => {
    const platform = memoryPlatform();
    const game = await startGame(mini(), platform, { providerId: "offline", seed: "x" });
    expect(game.providerId).toBe("offline");
    game.close();
    await expect(startGame(mini(), platform, { providerId: "claude-subscription" })).rejects.toThrow(/not available/);
  });
});

describe("SQLite save storage", () => {
  it("keeps <root>/<game>/<slot>.db, lists, resumes and deletes", async () => {
    const root = tmp();
    const saves = new SqliteSaveStorage(root);
    await roundTrip(saves);
    expect(existsSync(join(root, "mini"))).toBe(true);
    await playSome(on(saves), { slot: "third" });
    const path = join(root, "mini", "third.db");
    expect(saves.pathOf("mini", "third")).toBe(path);
    expect((await saves.list("mini"))[0]).toMatchObject({ slot: "third", updated: statSync(path).mtimeMs });
  });

  it("refuses names that would leave the root", async () => {
    const saves = new SqliteSaveStorage(tmp());
    await expect(saves.open("mini", "../escape")).rejects.toThrow(/bad save slot/);
    await expect(saves.list("..")).rejects.toThrow(/bad save game id/);
  });

  it("defaults under XDG_DATA_HOME, else ~/.local/share", () => {
    expect(defaultSaveRoot({ XDG_DATA_HOME: "/data" })).toBe("/data/oneblock/saves");
    expect(defaultSaveRoot({})).toMatch(/\.local\/share\/oneblock\/saves$/);
  });
});

describe("settings file", () => {
  it("reads at construction and writes through, readable by the player only", () => {
    const path = join(tmp(), "conf", "settings.json");
    const s = new FileSettings(path, { env: {} });
    expect(s.get("model")).toBeUndefined();
    s.set("model", "claude-x");
    s.set("anthropicApiKey", "sk-1");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "claude-x", anthropicApiKey: "sk-1" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new FileSettings(path, { env: {} });
    expect(again.get("model")).toBe("claude-x");
    again.set("model", undefined);
    expect(new FileSettings(path, { env: {} }).get("model")).toBeUndefined();
  });

  it("takes the API key from the environment without saving it", () => {
    const path = join(tmp(), "settings.json");
    const s = new FileSettings(path, { env: { ANTHROPIC_API_KEY: "sk-env" } });
    expect(s.get("anthropicApiKey")).toBe("sk-env");
    s.set("volume.master", "0.5");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "volume.master": "0.5" });
    s.set("anthropicApiKey", "sk-mine");
    expect(s.get("anthropicApiKey")).toBe("sk-mine");
  });

  it("treats a broken file as empty", () => {
    const path = join(tmp(), "settings.json");
    writeFileSync(path, "{ not json");
    expect(new FileSettings(path, { env: {} }).get("model")).toBeUndefined();
  });

  it("defaults under XDG_CONFIG_HOME, else ~/.config", () => {
    expect(defaultSettingsPath({ XDG_CONFIG_HOME: "/conf" })).toBe("/conf/oneblock/settings.json");
    expect(defaultSettingsPath({})).toMatch(/\.config\/oneblock\/settings\.json$/);
  });

  it("can be overlaid for one run", () => {
    const base = new MemorySettings({ model: "a" });
    const s = overlaySettings(base, { model: "b" });
    expect(s.get("model")).toBe("b");
    s.set("provider", "offline");
    expect(base.get("provider")).toBe("offline");
  });
});

describe("node platform", () => {
  it("reads assets from the payload's assets directory, and nothing outside it", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "assets", "terrain"), { recursive: true });
    writeFileSync(join(dir, "assets", "sprites.json"), '{"size":16}');
    writeFileSync(join(dir, "assets", "terrain", "floor.png"), Uint8Array.of(1, 2, 3));
    writeFileSync(join(dir, "secret.txt"), "no");
    const assets = dirAssets(dir);
    expect(await assets.text("sprites.json")).toBe('{"size":16}');
    expect(await assets.bytes("terrain/floor.png")).toEqual(Uint8Array.of(1, 2, 3));
    expect(await assets.bytes("missing.png")).toBeUndefined();
    expect(await assets.text("../secret.txt")).toBeUndefined();
  });

  it("offers the subscription first and needs a key for the API", async () => {
    expect(nodeProviders.available().map((c) => c.id)).toEqual(["claude-subscription", "anthropic-api", "offline"]);
    expect((await nodeProviders.create("offline", new MemorySettings())).id).toBe("offline");
    const api = await nodeProviders.create("anthropic-api", new MemorySettings({ anthropicApiKey: "sk-test" }));
    expect(api.id).toBe("anthropic-api");
    await expect(nodeProviders.create("nope", new MemorySettings())).rejects.toThrow(/unknown provider/);
  });

  it("assembles SQLite saves, file settings and silent audio", async () => {
    const dir = tmp();
    const platform = nodePlatform(dir, { saveRoot: join(dir, "saves"), settingsPath: join(dir, "settings.json") });
    expect(platform.id).toBe("native");
    expect(platform.audio).toBe(silentAudio);
    await playSome(platform);
    expect(existsSync(join(dir, "saves", "mini", "main.db"))).toBe(true);
  });
});

describe("IndexedDB save storage", () => {
  it("lists, resumes and deletes slots, keyed <game>/<slot>", async () => {
    const errors: unknown[] = [];
    const idb = new IDBFactory();
    const saves = new IdbSaveStorage({ factory: idb, onError: (e) => errors.push(e) });
    await roundTrip(saves);
    // A second storage on the same database (another page load) sees what the first wrote.
    await playSome(on(saves), { slot: "later" });
    await saves.settled();
    const other = new IdbSaveStorage({ factory: idb });
    const listed = await other.list("mini");
    expect(listed.map((s) => s.slot)).toEqual(["later", "main"]);
    expect(listed[0]!.updated).toBeGreaterThanOrEqual(listed[1]!.updated);
    expect(errors).toEqual([]);
    await saves.close();
    await other.close();
  });

  it("settled() waits for writes still queued", async () => {
    const idb = new IDBFactory();
    const saves = new IdbSaveStorage({ factory: idb });
    const game = await startGame(mini(), on(saves), { providerId: "offline", seed: "s" });
    game.session.start();
    game.flush();
    // Not closed, and not waited for: only settled() stands between the writes and a reload.
    await saves.settled();
    const reloaded = new IdbSaveStorage({ factory: idb });
    const { backend, existed } = await reloaded.open("mini", DEFAULT_SLOT);
    expect(existed).toBe(true);
    expect(backend.events().length).toBe(game.world.log.length);
    game.close();
    await saves.close();
    await reloaded.close();
  });

  it("moves a version 1 save (one per game) into the game's main slot", async () => {
    const idb = new IDBFactory();
    const v1 = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = idb.open("oneblock", 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("saves");
        open.result.createObjectStore("rows", { autoIncrement: true }).createIndex("save", "save");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = v1.transaction(["saves", "rows"], "readwrite");
    tx.objectStore("saves").put({ meta: { payloadId: "mini" }, snapshot: { seq: -1, state: "{}" } }, "mini");
    tx.objectStore("rows").add({ save: "mini", kind: "input", data: '{"type":"command","text":"look"}' });
    await new Promise((r) => {
      tx.oncomplete = r;
    });
    v1.close();

    const saves = new IdbSaveStorage({ factory: idb });
    expect((await saves.list("mini")).map((s) => [s.slot, s.meta.payloadId])).toEqual([["main", "mini"]]);
    const { backend, existed } = await saves.open("mini", "main");
    expect(existed).toBe(true);
    expect(backend.latestSnapshot()).toEqual({ seq: -1, state: "{}" });
    expect(backend.inputs()).toEqual(['{"type":"command","text":"look"}']);
    await saves.close();
  });

  it("waits for writes when the page is hidden or unloaded", () => {
    let calls = 0;
    const page = Object.assign(new EventTarget(), { document: { visibilityState: "visible" } });
    const stop = flushOnHide({ settled: async () => void calls++ }, page);
    page.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toBe(0);
    page.document.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    page.dispatchEvent(new Event("pagehide"));
    expect(calls).toBe(2);
    stop();
    page.dispatchEvent(new Event("pagehide"));
    expect(calls).toBe(2);
  });
});

describe("web settings, assets and providers", () => {
  /** Enough of Storage for the settings. */
  const fakeStorage = () => {
    const m = new Map<string, string>();
    return {
      map: m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    } as unknown as Storage & { map: Map<string, string> };
  };

  it("keeps settings in localStorage under oneblock: keys", () => {
    const store = fakeStorage();
    const s = new LocalSettings(store);
    s.set("anthropicApiKey", "sk-1");
    s.set("model", "m");
    s.set("ui.scale", "2");
    expect([...store.map]).toEqual([
      ["oneblock:anthropic-api-key", "sk-1"],
      ["oneblock:model", "m"],
      ["oneblock:ui.scale", "2"],
    ]);
    expect(s.get("model")).toBe("m");
    s.set("model", undefined);
    expect(s.get("model")).toBeUndefined();
  });

  it("reads as unset when storage refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    const s = new LocalSettings(refusing);
    expect(() => s.set("model", "m")).not.toThrow();
    expect(s.get("model")).toBeUndefined();
  });

  it("decodes embedded assets", async () => {
    const assets = embeddedAssets({
      "sprites.json": Buffer.from('{"a":1}').toString("base64"),
      "x.png": Buffer.from([9, 8]).toString("base64"),
    });
    expect(await assets.text("sprites.json")).toBe('{"a":1}');
    expect(await assets.bytes("x.png")).toEqual(Uint8Array.of(9, 8));
    expect(await assets.bytes("toString")).toBeUndefined();
  });

  it("offers the API and offline, checking the key first", async () => {
    const { webProviderFactory } = await import("../src/hosts/web/providers.js");
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const checked: string[] = [];
    const factory = webProviderFactory({
      client: (key) => {
        const c = new Anthropic({ apiKey: key });
        c.models.retrieve = (async (model: string) => {
          checked.push(`${key}:${model}`);
          if (key !== "good") {
            throw new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers());
          }
          return {};
        }) as unknown as typeof c.models.retrieve;
        return c;
      },
    });
    expect(factory.available().map((c) => c.id)).toEqual(["anthropic-api", "offline"]);
    expect((await factory.create("offline", new MemorySettings())).id).toBe("offline");
    await expect(factory.create("anthropic-api", new MemorySettings())).rejects.toThrow(/API key/);
    await expect(factory.create("anthropic-api", new MemorySettings({ anthropicApiKey: "bad" }))).rejects.toThrow(
      "The API didn't accept that key.",
    );
    const p = await factory.create("anthropic-api", new MemorySettings({ anthropicApiKey: "good", model: "m1" }));
    expect(p.id).toBe("anthropic-api");
    expect(checked).toEqual([`bad:${DEFAULT_MODEL}`, "good:m1"]);
    await expect(factory.create("claude-subscription", new MemorySettings())).rejects.toThrow(/not available/);
    expect(offlineProviders.available()).toHaveLength(1);
  });
});
