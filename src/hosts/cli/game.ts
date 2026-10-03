/** Opening a game in the terminal: the Node platform, with the save in one file and the provider chosen by id. */

import type { Payload } from "../../engine/payload/schema.js";
import { type Game, startGame } from "../../platform/game.js";
import { overlaySettings } from "../../platform/memory.js";
import { nodePlatform } from "../node/platform.js";
import { singleSqliteSave } from "../node/save-sqlite.js";
import { FileSettings } from "../node/settings.js";

export type { Game } from "../../platform/game.js";

export interface GameOptions {
  payloadDir: string;
  savePath: string;
  /** Start over, replacing the save. */
  fresh?: boolean;
  seed?: string;
  provider: string;
  model?: string;
}

/** Opens (resuming if the save holds a game) or starts a game. */
export async function openGame(payload: Payload, o: GameOptions): Promise<Game> {
  const settings = new FileSettings();
  const platform = nodePlatform(o.payloadDir, {
    saves: singleSqliteSave(o.savePath),
    settings: o.model ? overlaySettings(settings, { model: o.model }) : settings,
  });
  return startGame(payload, platform, {
    providerId: o.provider,
    ...(o.fresh ? { fresh: true } : {}),
    ...(o.seed ? { seed: o.seed } : {}),
  });
}
