/** Settings on disk: a JSON file, `$XDG_CONFIG_HOME/oneblock/settings.json` by default. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SettingKey, Settings } from "../../platform/index.js";
import { configDir } from "./xdg.js";

type Env = Record<string, string | undefined>;

export const defaultSettingsPath = (env?: Env): string => join(configDir(env), "settings.json");

/**
 * Read once when made, written through on every set. `ANTHROPIC_API_KEY` stands in for an unset API key, without
 * being written to the file.
 */
export class FileSettings implements Settings {
  private readonly values: Partial<Record<SettingKey, string>>;
  private readonly env: Env;

  constructor(
    readonly path: string = defaultSettingsPath(),
    o: { env?: Env } = {},
  ) {
    this.env = o.env ?? process.env;
    this.values = read(path);
  }

  get(key: SettingKey): string | undefined {
    const v = this.values[key];
    if (v === undefined && key === "anthropicApiKey") return this.env.ANTHROPIC_API_KEY || undefined;
    return v;
  }

  set(key: SettingKey, value: string | undefined): void {
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    // It may hold an API key: readable by the player alone.
    writeFileSync(this.path, `${JSON.stringify(this.values, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

function read(path: string): Partial<Record<SettingKey, string>> {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === "string"));
  } catch {
    // A settings file the player broke by hand is treated as empty, not fatal.
    return {};
  }
}
