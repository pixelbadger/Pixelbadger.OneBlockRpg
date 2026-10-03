/**
 * Settings in localStorage, under `oneblock:` keys. Storage can be missing or refuse (private windows, blocked site
 * data), so every access is guarded and a failure reads as unset.
 */
import type { SettingKey, Settings } from "../../platform/index.js";

/** The API key keeps the name the first browser build stored it under. */
const NAMES: Partial<Record<SettingKey, string>> = { anthropicApiKey: "anthropic-api-key" };

export const storageKey = (key: SettingKey): string => `oneblock:${NAMES[key] ?? key}`;

export class LocalSettings implements Settings {
  /** `storage` defaults to the page's localStorage, looked up on each access. */
  constructor(private readonly storage?: Storage) {}

  private store(): Storage {
    return this.storage ?? localStorage;
  }

  get(key: SettingKey): string | undefined {
    try {
      return this.store().getItem(storageKey(key)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  set(key: SettingKey, value: string | undefined): void {
    try {
      if (value === undefined) this.store().removeItem(storageKey(key));
      else this.store().setItem(storageKey(key), value);
    } catch {}
  }
}
