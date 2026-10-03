/**
 * Starting or resuming a game on a save, for any frontend (the terminal's `play`, the browser build): the provider
 * is recorded for replay (§3.8), and inputs and usage go to the save.
 */

import { World } from "../core/world.js";
import type { LlmProvider } from "../llm/provider.js";
import { RecordingProvider } from "../llm/scripted.js";
import type { Payload } from "../payload/schema.js";
import type { SaveStore } from "../session/save.js";
import { Session } from "../session/session.js";

export interface Game {
  session: Session;
  world: World;
  store: SaveStore;
  providerId: string;
  resuming: boolean;
  flush: () => void;
  close: () => void;
}

/** Resumes the save if `resuming`, else starts a new world on it from `seed`. */
export function startGame(
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
