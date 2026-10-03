/**
 * The platform contracts (§3.1): everything a host supplies to the game. The engine and the shared client never
 * reach past these to a file system, a browser API, a window or a sound device. Hosts implement them: the web host
 * (IndexedDB, localStorage, Web Audio), the native host (SQLite and XDG files, SDL audio), and memory.ts for tests.
 */
import type { LlmProvider } from "../engine/llm/provider.js";
import type { SaveBackend } from "../engine/session/save.js";

export interface Platform {
  readonly id: "web" | "native" | "test";
  saves: SaveStorage;
  settings: Settings;
  audio: AudioOut;
  assets: Assets;
  providers: ProviderFactory;
}

// ─── Saves ───────────────────────────────────────────────────────────────────

/** A save slot as listed (newest first). */
export interface SaveInfo {
  gameId: string;
  slot: string;
  /** ms since the epoch, when last written. */
  updated: number;
  /** The save's meta rows (payload version, seed, provider…). */
  meta: Record<string, string>;
}

/**
 * Where saves live: slots per game. A slot opens to the engine's synchronous SaveBackend; a host whose storage is
 * asynchronous (IndexedDB) keeps the slot in memory and writes behind it.
 */
export interface SaveStorage {
  list(gameId: string): Promise<SaveInfo[]>;
  /** Opens the slot, creating it if need be. `existed` is true when it already held a game. */
  open(gameId: string, slot: string): Promise<{ backend: SaveBackend; existed: boolean }>;
  delete(gameId: string, slot: string): Promise<void>;
  /** Resolves once every write so far is durable. */
  settled(): Promise<void>;
}

/** The slot a game plays in unless the player picks another. */
export const DEFAULT_SLOT = "main";

// ─── Settings ────────────────────────────────────────────────────────────────

export type SettingKey =
  | "provider"
  | "model"
  | "anthropicApiKey"
  | "volume.master"
  | "volume.sfx"
  | "volume.ambience"
  | "ui.scale";

/** Small per-player preferences, read synchronously. */
export interface Settings {
  get(key: SettingKey): string | undefined;
  /** `undefined` removes the setting. */
  set(key: SettingKey, value: string | undefined): void;
}

// ─── Assets ──────────────────────────────────────────────────────────────────

/**
 * Files a payload ships beside its data, by path relative to the payload's `assets/` directory: sprite art now
 * (`sprites.json` and its PNGs), sounds later. The web host embeds them in the page; the native host reads disk.
 */
export interface Assets {
  text(path: string): Promise<string | undefined>;
  bytes(path: string): Promise<Uint8Array | undefined>;
}

// ─── Model providers ─────────────────────────────────────────────────────────

export interface ProviderChoice {
  /** Provider id: "claude-subscription", "anthropic-api" or "offline". */
  id: string;
  label: string;
  /** Settings the player must fill in first (e.g. the API key). */
  needs: SettingKey[];
}

export interface ProviderFactory {
  /** What this platform can offer, the default first. */
  available(): ProviderChoice[];
  /** Builds the provider, checking its credentials where that is cheap. Rejects with a message for the player. */
  create(id: string, settings: Settings): Promise<LlmProvider>;
}

// ─── Audio ───────────────────────────────────────────────────────────────────

/** A payload's sound manifest (`assets/sounds.json`). TODO(audio): schema to be written with the payload side. */
export interface SoundManifest {
  sounds: Record<string, { file: string; loop?: boolean; volume?: number }>;
}

export type AudioBus = "master" | "sfx" | "ambience";

/**
 * Sound out. TODO(audio): every host ships `silentAudio` until there is sound to play.
 * - Web: Web Audio (one AudioContext, decoded AudioBuffers, a GainNode per bus, crossfaded ambience loops).
 * - Native: an SDL audio device (@kmamal/sdl) fed mixed PCM; needs a WAV/OGG decoder in JS or WASM.
 * Cue ids come from the shared client (fx, narration kinds, scene tags), so both hosts sound the same.
 */
export interface AudioOut {
  load(manifest: SoundManifest, assets: Assets): Promise<void>;
  /** A one-shot: a hit, a door, a footstep. */
  cue(id: string, o?: { volume?: number; pan?: number }): void;
  /** The looping beds for the current scene; replaces the set playing now. */
  ambience(ids: string[]): void;
  volume(bus: AudioBus, v: number): void;
  /** Browsers only start audio after a user gesture; hosts call this from one. */
  resume(): Promise<void>;
  dispose(): void;
}

export const silentAudio: AudioOut = {
  load: async () => {},
  cue: () => {},
  ambience: () => {},
  volume: () => {},
  resume: async () => {},
  dispose: () => {},
};
