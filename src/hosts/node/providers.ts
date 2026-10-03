/** The model providers a Node host offers: the Claude subscription (default), the API with a key, and offline. */
import { AnthropicApiProvider } from "../../engine/llm/anthropic-api.js";
import type { LlmProvider } from "../../engine/llm/provider.js";
import { offlineProvider } from "../../engine/narrative/offline.js";
import type { ProviderChoice, ProviderFactory, Settings } from "../../platform/index.js";
import { ClaudeSubscriptionProvider } from "./claude-subscription.js";

const CHOICES: ProviderChoice[] = [
  { id: "claude-subscription", label: "Claude subscription (Claude Code login)", needs: [] },
  { id: "anthropic-api", label: "Anthropic API (your API key)", needs: ["anthropicApiKey"] },
  { id: "offline", label: "Offline (authored options only)", needs: [] },
];

export const nodeProviders: ProviderFactory = {
  available: () => CHOICES.map((c) => ({ ...c, needs: [...c.needs] })),
  create: async (id: string, settings: Settings): Promise<LlmProvider> => {
    const model = settings.get("model");
    switch (id) {
      case "claude-subscription":
        return new ClaudeSubscriptionProvider(model ? { model } : {});
      case "anthropic-api": {
        const apiKey = settings.get("anthropicApiKey") ?? process.env.ANTHROPIC_API_KEY;
        // Without a key the SDK may still find a token of its own.
        if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
          throw new Error("anthropic-api needs an API key: set ANTHROPIC_API_KEY or save one in settings");
        }
        return new AnthropicApiProvider({ ...(apiKey ? { apiKey } : {}), ...(model ? { model } : {}) });
      }
      case "offline":
      case "scripted":
        return offlineProvider();
      default:
        throw new Error(`unknown provider '${id}' (claude-subscription | anthropic-api | offline)`);
    }
  },
};
