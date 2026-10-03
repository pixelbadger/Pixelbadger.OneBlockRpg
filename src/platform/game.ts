/**
 * Starting or resuming a game, for any host: the save comes from the platform's storage, the provider from its
 * factory. The provider is recorded for replay (§3.8), and inputs and usage go to the save.
 */

import { World } from "../engine/core/world.js";
import type { LlmProvider } from "../engine/llm/provider.js";
import { RecordingProvider } from "../engine/llm/scripted.js";
import type { Payload } from "../engine/payload/schema.js";
import { SaveStore } from "../engine/session/save.js";
import { Session } from "../engine/session/session.js";
import { DEFAULT_SLOT, type Platform } from "./index.js";

export interface Game {
  session: Session;
  world: World;
  store: SaveStore;
  providerId: string;
  resuming: boolean;
  flush: () => void;
  close: () => void;
}

export interface StartOptions {
  /** The save slot (default DEFAULT_SLOT). */
  slot?: string;
  providerId: string;
  /** Start over, deleting the slot first. */
  fresh?: boolean;
  /** PRNG seed for a new world. */
  seed?: string;
}

/** Opens the payload's slot on the platform: resumes it if it holds a game, else starts a new one. */
export async function startGame(payload: Payload, platform: Platform, o: StartOptions): Promise<Game> {
  const gameId = payload.game.id;
  const slot = o.slot ?? DEFAULT_SLOT;
  // The provider first: a rejected key should not leave a save open.
  const inner = await platform.providers.create(o.providerId, platform.settings);
  if (o.fresh) await platform.saves.delete(gameId, slot);
  const { backend, existed } = await platform.saves.open(gameId, slot);
  return gameOnStore(payload, new SaveStore(backend), inner, { resuming: existed, seed: o.seed });
}

/** Resumes the save if `resuming`, else starts a new world on it from `seed`. */
export function gameOnStore(
  payload: Payload,
  store: SaveStore,
  inner: LlmProvider,
  o: { resuming: boolean; seed?: string | undefined },
): Game {
  const provider = new RecordingProvider(inner, (c, req) => store.recordExchange(c, req));
  let world: World;
  if (o.resuming) {
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
    resuming: o.resuming,
    flush: () => store.flush(world),
    close: () => {
      if (closed) return;
      closed = true;
      store.flush(world);
      store.close();
    },
  };
}
