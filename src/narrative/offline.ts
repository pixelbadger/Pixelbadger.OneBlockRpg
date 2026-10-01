/**
 * An offline stand-in for a model (`--provider offline`): conversations run on authored options only, the director
 * takes no-op turns, day summaries fall back to log digests and callouts to their authored fallback. The game stays
 * fully playable without any LLM, which is also what every fallback path looks like (§6.9).
 */
import { ScriptedProvider } from "../llm/scripted.js";

export function offlineProvider(): ScriptedProvider {
  const p = new ScriptedProvider({
    conversation: () => ({ line: "", actions: [], hooks: [], playerOptions: [] }),
    director: () => ({
      narration: "",
      lines: [],
      castActions: [],
      effects: [],
      hooks: [],
      targets: [],
      advanceBeat: false,
    }),
  });
  return Object.assign(p, { id: "offline" }) as ScriptedProvider;
}
