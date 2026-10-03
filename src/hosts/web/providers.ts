/**
 * The model providers a browser offers: the Anthropic API with the player's own key (checked before play), and
 * offline. The Claude subscription needs the Agent SDK, which only runs on Node.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicApiProvider, DEFAULT_MODEL } from "../../engine/llm/anthropic-api.js";
import { offlineProvider } from "../../engine/narrative/offline.js";
import type { ProviderChoice, ProviderFactory } from "../../platform/index.js";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const browserClient = (apiKey: string): Anthropic => new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

/** What is wrong with a key and model, if anything (one free API call), in words for the player. */
export async function checkApiKey(client: Anthropic, model: string): Promise<string | undefined> {
  try {
    await client.models.retrieve(model);
    return undefined;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return "The API didn't accept that key.";
    if (err instanceof Anthropic.NotFoundError) return `The API doesn't know the model '${model}'.`;
    return `Couldn't reach the API: ${message(err)}`;
  }
}

const CHOICES: ProviderChoice[] = [
  { id: "anthropic-api", label: "Anthropic API (your API key)", needs: ["anthropicApiKey"] },
  { id: "offline", label: "Offline (authored options only)", needs: [] },
];

/** `client` builds the API client for a key (tests pass a fake). */
export function webProviderFactory(o: { client?: (apiKey: string) => Anthropic } = {}): ProviderFactory {
  const makeClient = o.client ?? browserClient;
  return {
    available: () => CHOICES.map((c) => ({ ...c, needs: [...c.needs] })),
    create: async (id, settings) => {
      if (id === "offline") return offlineProvider();
      if (id !== "anthropic-api") throw new Error(`provider '${id}' is not available in the browser`);
      const key = settings.get("anthropicApiKey");
      if (!key) throw new Error("Enter an Anthropic API key to play.");
      const model = settings.get("model") || DEFAULT_MODEL;
      const client = makeClient(key);
      const problem = await checkApiKey(client, model);
      if (problem) throw new Error(problem);
      return new AnthropicApiProvider({ client, model });
    },
  };
}

export const webProviders: ProviderFactory = webProviderFactory();
