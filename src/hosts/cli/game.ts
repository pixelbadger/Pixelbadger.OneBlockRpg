/** Opening a game in the terminal: a SQLite save on disk and a provider chosen by id. */

import { rmSync } from "node:fs";
import { AnthropicApiProvider } from "../../engine/llm/anthropic-api.js";
import type { LlmProvider } from "../../engine/llm/provider.js";
import { offlineProvider } from "../../engine/narrative/offline.js";
import type { Payload } from "../../engine/payload/schema.js";
import { ClaudeSubscriptionProvider } from "../node/claude-subscription.js";
import { openSqliteSave, saveExists } from "../node/save-sqlite.js";
import { type Game, startGame } from "./start-game.js";

export type { Game } from "./start-game.js";

export function makeProvider(id: string, model?: string): LlmProvider {
  switch (id) {
    case "claude-subscription":
      return new ClaudeSubscriptionProvider(model ? { model } : {});
    case "anthropic-api":
      return new AnthropicApiProvider(model ? { model } : {});
    case "offline":
    case "scripted":
      return offlineProvider();
    default:
      throw new Error(`unknown provider '${id}' (claude-subscription | anthropic-api | offline)`);
  }
}

export interface GameOptions {
  savePath: string;
  /** Start over, replacing the save. */
  fresh?: boolean;
  seed?: string;
  provider: string;
  model?: string;
}

/** Opens (resuming if the save exists) or starts a game. */
export async function openGame(payload: Payload, o: GameOptions): Promise<Game> {
  if (o.fresh) rmSync(o.savePath, { force: true });
  const resuming = saveExists(o.savePath);
  const store = await openSqliteSave(o.savePath);
  return startGame(payload, store, makeProvider(o.provider, o.model), { resuming, seed: o.seed });
}
