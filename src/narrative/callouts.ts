/**
 * Scripted callouts (§6.5): payload-declared one-off generations (a dream, a radio broadcast) fired by an effect.
 * `cache: per-save` generates once per save, then the text is fixed.
 */
import { set } from "../core/ops.js";
import { complete } from "../llm/provider.js";
import { ENGINE_RULES, storyPart } from "./context.js";
import type { NarrativeDeps } from "./conversation.js";
import { summaryVar } from "./memory.js";

export async function runCallout(d: NarrativeDeps, id: string): Promise<string> {
  const w = d.w;
  const def = w.ix.callouts.get(id);
  if (!def) return "";
  const cached = w.state.callouts[id];
  let text: string;
  if (def.cache === "per-save" && cached !== undefined) {
    text = cached;
  } else {
    const prompt = def.prompt.replace(
      /\{\{\s*summaries\.([a-z0-9_-]+)\.([a-z]+)\s*\}\}/g,
      (_, who: string, which: string) => summaryVar(w, w.resolve(who), which),
    );
    const r = await complete(
      d.provider,
      {
        purpose: "callout",
        system: [
          {
            label: "engine",
            text: `${ENGINE_RULES}\nFor this request, reply with plain prose only: no JSON, no preamble.`,
          },
          storyPart(w),
        ],
        messages: [{ role: "user", content: w.interpolate(prompt) }],
        maxOutputTokens: 2000,
      },
      d.onUsage,
    );
    text = r.ok && String(r.value).trim() ? String(r.value).trim() : def.fallback;
    w.emit("callout", {
      payload: { callout: id, text },
      ops: def.cache === "per-save" ? [set(["callouts", id], text)] : [],
    });
  }
  if (text) {
    w.say(text, "callout");
    w.dayLog(w.playerId, "witnessed", text);
  }
  return text;
}
