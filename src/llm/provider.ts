/**
 * The LLM provider interface (§6.9). Providers turn a request into text (JSON text when a schema is given).
 * Validation, the single retry and the safe fallback happen engine-side in `complete`, regardless of provider.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export type Purpose = "conversation" | "director" | "callout" | "day-summary";

/** A system prompt part. Parts are ordered stable → volatile so prompt caching works (§6.3). */
export interface PromptPart {
  label: string;
  text: string;
  /** Put a cache breakpoint after this part (the last stable part). */
  cache?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest<T = unknown> {
  purpose: Purpose;
  system: PromptPart[];
  messages: ChatMessage[];
  /** Validated engine-side regardless of provider. */
  schema?: z.ZodType<T>;
  maxOutputTokens?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface RawCompletion {
  text: string;
  /** The provider declined (refusal stop reason). Treated like invalid output. */
  refusal?: boolean;
  usage?: Usage;
}

export interface ProviderCapabilities {
  structuredOutput: boolean;
  promptCaching: boolean;
  streaming: boolean;
  maxContextTokens: number;
}

export interface LlmProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  /** Produce raw text. With a JSON schema, the text must be a JSON document. */
  generate(req: CompletionRequest, jsonSchema?: Record<string, unknown>): Promise<RawCompletion>;
}

export type CompletionResult<T> =
  | { ok: true; value: T; raw: string; attempts: number }
  | { ok: false; error: string; raw?: string; attempts: number };

/** JSON Schema for structured output, trimmed to keywords structured-output backends accept. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as Record<string, unknown>;
  const strip = new Set([
    "$schema",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "maxItems",
    "pattern",
    "format",
  ]);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (strip.has(k)) continue;
        if (k === "minItems" && typeof x === "number" && x > 1) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(js) as Record<string, unknown>;
}

/** Extracts a JSON document from model text (tolerates code fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) return JSON.parse(fence[1]);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("no JSON found in output");
  }
}

/** Stable hash of a request, for cassettes (§3.8). */
export function requestHash(req: CompletionRequest): string {
  const body = JSON.stringify({
    purpose: req.purpose,
    system: req.system.map((p) => p.text),
    messages: req.messages,
    schema: req.schema ? toJsonSchema(req.schema) : null,
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

export interface UsageRecord {
  purpose: Purpose;
  provider: string;
  usage?: Usage;
  ok: boolean;
}

/**
 * Calls the provider and validates the output engine-side. Invalid output (or a refusal) gets one retry, then the
 * caller's safe fallback applies (§6.9). Never throws: a turn never crashes.
 */
export async function complete<T>(
  provider: LlmProvider,
  req: CompletionRequest<T>,
  onUsage?: (u: UsageRecord) => void,
): Promise<CompletionResult<T>> {
  const jsonSchema = req.schema ? toJsonSchema(req.schema) : undefined;
  let lastError = "";
  let raw: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r: CompletionRequest = attempt === 1 ? req : withRetryNote(req, lastError);
    try {
      const out = await provider.generate(r, jsonSchema);
      raw = out.text;
      if (out.refusal) {
        lastError = "the provider declined to answer";
        onUsage?.({
          purpose: req.purpose,
          provider: provider.id,
          ...(out.usage ? { usage: out.usage } : {}),
          ok: false,
        });
        continue;
      }
      if (!req.schema) {
        onUsage?.({
          purpose: req.purpose,
          provider: provider.id,
          ...(out.usage ? { usage: out.usage } : {}),
          ok: true,
        });
        return { ok: true, value: out.text as T, raw: out.text, attempts: attempt };
      }
      const parsed = req.schema.safeParse(extractJson(out.text));
      if (parsed.success) {
        onUsage?.({
          purpose: req.purpose,
          provider: provider.id,
          ...(out.usage ? { usage: out.usage } : {}),
          ok: true,
        });
        return { ok: true, value: parsed.data, raw: out.text, attempts: attempt };
      }
      lastError = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      onUsage?.({ purpose: req.purpose, provider: provider.id, ...(out.usage ? { usage: out.usage } : {}), ok: false });
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  return { ok: false, error: lastError, ...(raw !== undefined ? { raw } : {}), attempts: 2 };
}

function withRetryNote<T>(req: CompletionRequest<T>, error: string): CompletionRequest<T> {
  return {
    ...req,
    messages: [
      ...req.messages,
      {
        role: "user",
        content: `Your previous reply could not be used (${error}). Reply again with a single JSON object matching the schema exactly.`,
      },
    ],
  };
}

/** Renders the conversation messages as a single prompt, for backends that take one string. */
export function renderMessages(messages: readonly ChatMessage[]): string {
  return messages.map((m) => (m.role === "user" ? m.content : `(Your earlier reply)\n${m.content}`)).join("\n\n");
}
