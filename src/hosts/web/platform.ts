/** The web platform: saves in IndexedDB, settings in localStorage, assets embedded in the page, sound stubbed. */
import type { Platform } from "../../platform/index.js";
import { embeddedAssets } from "./assets.js";
import { webAudio } from "./audio.js";
import { webProviders } from "./providers.js";
import { IdbSaveStorage } from "./save-idb.js";
import { LocalSettings } from "./settings.js";

export interface WebPlatform extends Platform {
  saves: IdbSaveStorage;
}

/** `assets` is the page's embedded assets (path → base64); save failures go to `onSaveError`. */
export function webPlatform(o: { assets: Record<string, string>; onSaveError?: (err: unknown) => void }): WebPlatform {
  return {
    id: "web",
    saves: new IdbSaveStorage(o.onSaveError ? { onError: o.onSaveError } : {}),
    settings: new LocalSettings(),
    audio: webAudio(),
    assets: embeddedAssets(o.assets),
    providers: webProviders,
  };
}
