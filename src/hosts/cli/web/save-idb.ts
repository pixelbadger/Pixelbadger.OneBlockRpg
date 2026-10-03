/** The xterm.js page's saves: one per game, the DEFAULT_SLOT of the web host's IndexedDB storage. */

import { SaveStore } from "../../../engine/session/save.js";
import { DEFAULT_SLOT } from "../../../platform/index.js";
import { IdbSaveStorage } from "../../web/save-idb.js";

export interface BrowserSave {
  store: SaveStore;
  /** The save already held a game. */
  resuming: boolean;
}

/** Opens the save for game `id` in IndexedDB; write failures go to `onError`. */
export async function openBrowserSave(
  id: string,
  onError: (err: unknown) => void,
  factory?: IDBFactory,
): Promise<BrowserSave> {
  const storage = new IdbSaveStorage({ onError, ...(factory ? { factory } : {}) });
  const { backend, existed } = await storage.open(id, DEFAULT_SLOT);
  return { store: new SaveStore(backend), resuming: existed };
}

/** Deletes the save for game `id`. */
export async function deleteBrowserSave(id: string, factory?: IDBFactory): Promise<void> {
  const storage = new IdbSaveStorage(factory ? { factory } : {});
  try {
    await storage.delete(id, DEFAULT_SLOT);
  } finally {
    await storage.close();
  }
}
