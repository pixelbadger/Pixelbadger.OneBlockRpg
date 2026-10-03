/**
 * claude-subscription provider (default, §6.9, Q10): Claude via the Claude Agent SDK, in-process, using the user's
 * Claude Code login. All tools are disabled and filesystem settings are not loaded: it is used as a plain model.
 *
 * Open question Q30: confirm the subscription terms allow this use from a personal app before release.
 */
import type { CompletionRequest, LlmProvider, RawCompletion } from "../../engine/llm/provider.js";
import { renderMessages } from "../../engine/llm/provider.js";

export interface ClaudeSubscriptionOptions {
  model?: string;
}

export class ClaudeSubscriptionProvider implements LlmProvider {
  readonly id = "claude-subscription";
  readonly capabilities = { structuredOutput: true, promptCaching: true, streaming: false, maxContextTokens: 200_000 };

  constructor(private readonly opts: ClaudeSubscriptionOptions = {}) {}

  async generate(req: CompletionRequest, jsonSchema?: Record<string, unknown>): Promise<RawCompletion> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const systemPrompt = req.system.map((p) => p.text).join("\n\n");
    const stream = query({
      prompt: renderMessages(req.messages),
      options: {
        systemPrompt,
        tools: [],
        allowedTools: [],
        settingSources: [],
        persistSession: false,
        // Structured output may use an extra internal turn.
        maxTurns: jsonSchema ? 3 : 1,
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(jsonSchema ? { outputFormat: { type: "json_schema" as const, schema: jsonSchema } } : {}),
      },
    });
    for await (const message of stream) {
      if (message.type !== "result") continue;
      if (message.subtype !== "success" || message.is_error) {
        return { text: "", refusal: message.stop_reason === "refusal" };
      }
      const text =
        jsonSchema && message.structured_output !== undefined
          ? JSON.stringify(message.structured_output)
          : message.result;
      return {
        text,
        refusal: message.stop_reason === "refusal",
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens,
          cacheWriteTokens: message.usage.cache_creation_input_tokens,
        },
      };
    }
    return { text: "" };
  }
}
