/** The platform for hosts running on Node (the native window): SQLite saves, XDG settings. */
import { type AudioOut, type Platform, type SaveStorage, type Settings, silentAudio } from "../../platform/index.js";
import { dirAssets } from "./assets.js";
import { nodeProviders } from "./providers.js";
import { SqliteSaveStorage } from "./save-sqlite.js";
import { FileSettings } from "./settings.js";

export interface NodePlatformOptions {
  /** Where SqliteSaveStorage keeps saves (default `$XDG_DATA_HOME/oneblock/saves`). */
  saveRoot?: string;
  /** The settings file (default `$XDG_CONFIG_HOME/oneblock/settings.json`). */
  settingsPath?: string;
  /** Replace the save storage or settings outright. */
  saves?: SaveStorage;
  settings?: Settings;
  /** Sound out (default silent). */
  audio?: AudioOut;
}

export function nodePlatform(payloadDir: string, o: NodePlatformOptions = {}): Platform {
  return {
    id: "native",
    saves: o.saves ?? new SqliteSaveStorage(o.saveRoot),
    settings: o.settings ?? new FileSettings(o.settingsPath),
    audio: o.audio ?? silentAudio,
    assets: dirAssets(payloadDir),
    providers: nodeProviders,
  };
}
