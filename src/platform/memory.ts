/** In-memory platform pieces: for tests, and as building blocks for hosts. */
import { offlineProvider } from "../engine/narrative/offline.js";
import { MemorySaveBackend, type SaveBackend } from "../engine/session/save.js";
import {
  type Assets,
  type Platform,
  type ProviderFactory,
  type SaveInfo,
  type SaveStorage,
  type SettingKey,
  type Settings,
  silentAudio,
} from "./index.js";

export class MemorySaveStorage implements SaveStorage {
  private readonly slots = new Map<string, { backend: MemorySaveBackend; updated: number }>();

  private key = (gameId: string, slot: string) => `${gameId}\u0000${slot}`;

  async list(gameId: string): Promise<SaveInfo[]> {
    const out: SaveInfo[] = [];
    for (const [k, v] of this.slots) {
      const [g, slot] = k.split("\u0000") as [string, string];
      if (g === gameId) out.push({ gameId, slot, updated: v.updated, meta: v.backend.meta() });
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async open(gameId: string, slot: string): Promise<{ backend: SaveBackend; existed: boolean }> {
    const k = this.key(gameId, slot);
    const found = this.slots.get(k);
    if (found) {
      found.updated = Date.now();
      return { backend: found.backend, existed: true };
    }
    const backend = new MemorySaveBackend();
    this.slots.set(k, { backend, updated: Date.now() });
    return { backend, existed: false };
  }

  async delete(gameId: string, slot: string): Promise<void> {
    this.slots.delete(this.key(gameId, slot));
  }

  async settled(): Promise<void> {}
}

export class MemorySettings implements Settings {
  private readonly values = new Map<SettingKey, string>();

  constructor(initial: Partial<Record<SettingKey, string>> = {}) {
    for (const [k, v] of Object.entries(initial)) if (v !== undefined) this.values.set(k as SettingKey, v);
  }

  get(key: SettingKey): string | undefined {
    return this.values.get(key);
  }

  set(key: SettingKey, value: string | undefined): void {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

/** `base` with some keys fixed for this run (e.g. a command-line `--model`): reads see them, writes go to `base`. */
export function overlaySettings(base: Settings, fixed: Partial<Record<SettingKey, string>>): Settings {
  return {
    get: (key) => fixed[key] ?? base.get(key),
    set: (key, value) => base.set(key, value),
  };
}

/** Assets from a map of path → bytes. */
export function mapAssets(files: ReadonlyMap<string, Uint8Array> = new Map()): Assets {
  return {
    bytes: async (path) => files.get(path),
    text: async (path) => {
      const b = files.get(path);
      return b ? new TextDecoder().decode(b) : undefined;
    },
  };
}

/** Only the offline provider: conversations on authored options, no model. */
export const offlineProviders: ProviderFactory = {
  available: () => [{ id: "offline", label: "Offline (authored options only)", needs: [] }],
  create: async (id) => {
    if (id !== "offline") throw new Error(`provider '${id}' is not available here`);
    return offlineProvider();
  },
};

export function memoryPlatform(o: { assets?: Assets; providers?: ProviderFactory } = {}): Platform {
  return {
    id: "test",
    saves: new MemorySaveStorage(),
    settings: new MemorySettings(),
    audio: silentAudio,
    assets: o.assets ?? mapAssets(),
    providers: o.providers ?? offlineProviders,
  };
}
