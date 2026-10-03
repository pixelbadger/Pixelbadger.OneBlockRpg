/**
 * Opening a game for a frontend: the save, the provider (recorded for replay, §3.8) and the session. Shared by
 * `play` and `serve`.
 */

import { rmSync } from "node:fs";
import { World } from "../core/world.js";
import { AnthropicApiProvider } from "../llm/anthropic-api.js";
import { ClaudeSubscriptionProvider } from "../llm/claude-subscription.js";
import type { LlmProvider } from "../llm/provider.js";
import { RecordingProvider } from "../llm/scripted.js";
import { offlineProvider } from "../narrative/offline.js";
import type { Payload } from "../payload/schema.js";
import type { SaveStore } from "../session/save.js";
import { openSqliteSave, saveExists } from "../session/save-sqlite.js";
import { Session } from "../session/session.js";

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

export interface Game {
  session: Session;
  world: World;
  store: SaveStore;
  providerId: string;
  resuming: boolean;
  flush: () => void;
  close: () => void;
}

/** Opens (resuming if the save exists) or starts a game. */
export async function openGame(payload: Payload, o: GameOptions): Promise<Game> {
  if (o.fresh) rmSync(o.savePath, { force: true });
  const resuming = saveExists(o.savePath);
  const store = await openSqliteSave(o.savePath);
  const inner = makeProvider(o.provider, o.model);
  const provider = new RecordingProvider(inner, (c, req) => store.recordExchange(c, req));
  let world: World;
  if (resuming) {
    world = store.load(payload);
  } else {
    // The seed is the only outside input to a new world; everything after it is deterministic (§3.8).
    world = World.create(payload, o.seed ?? `${payload.game.id}-${Date.now()}`);
    store.init(payload, world, inner.id);
  }
  store.attach(world);
  const session = new Session(world, {
    provider,
    onUsage: (u) => store.recordUsage(u),
    onInput: (i) => store.recordInput(i),
  });
  let closed = false;
  return {
    session,
    world,
    store,
    providerId: inner.id,
    resuming,
    flush: () => store.flush(world),
    close: () => {
      if (closed) return;
      closed = true;
      store.flush(world);
      store.close();
    },
  };
}
