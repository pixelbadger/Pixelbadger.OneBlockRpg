/**
 * anthropic-api provider (§6.9): the Messages API with an API key (or any credential the SDK resolves).
 * Structured outputs via output_config.format, prompt caching on the last stable system part, and server-side
 * refusal fallbacks. A refusal that survives the fallback is reported as such.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, LlmProvider, Purpose, RawCompletion } from "./provider.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Conversation turns need to be quick; the director benefits from a little more thought. */
const DEFAULT_EFFORT: Record<Purpose, Effort> = {
  conversation: "low",
  director: "medium",
  callout: "low",
  "day-summary": "low",
};

export interface AnthropicApiOptions {
  model?: string;
  apiKey?: string;
  effort?: Partial<Record<Purpose, Effort>>;
  client?: Anthropic;
}

export class AnthropicApiProvider implements LlmProvider {
  readonly id = "anthropic-api";
  readonly capabilities = { structuredOutput: true, promptCaching: true, streaming: true, maxContextTokens: 1_000_000 };
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: Record<Purpose, Effort>;

  constructor(opts: AnthropicApiOptions = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? DEFAULT_MODEL;
    this.effort = { ...DEFAULT_EFFORT, ...opts.effort };
  }

  async generate(req: CompletionRequest, jsonSchema?: Record<string, unknown>): Promise<RawCompletion> {
    // Stable parts first; one cache breakpoint after the last part marked cacheable.
    const lastCached = req.system.map((p) => !!p.cache).lastIndexOf(true);
    const system = req.system.map((p, i) => ({
      type: "text" as const,
      text: p.text,
      ...(i === lastCached ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: req.maxOutputTokens ?? 16000,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: {
        effort: this.effort[req.purpose],
        ...(jsonSchema ? { format: { type: "json_schema" as const, schema: jsonSchema } } : {}),
      },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      refusal: response.stop_reason === "refusal",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
