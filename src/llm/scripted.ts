/**
 * Deterministic providers for tests and offline play (§3.9, P12): scripted responses, and record/replay cassettes.
 */
import type { CompletionRequest, LlmProvider, Purpose, RawCompletion } from "./provider.js";
import { requestHash } from "./provider.js";

export type ScriptedHandler = (req: CompletionRequest) => unknown;

const caps = { structuredOutput: true, promptCaching: false, streaming: false, maxContextTokens: 1_000_000 };

/**
 * Answers from per-purpose queues first, then per-purpose handlers. Objects are serialised as JSON.
 * With nothing scripted, it throws, which the engine treats as a failed call (and falls back safely).
 */
export class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  readonly capabilities = caps;
  readonly calls: CompletionRequest[] = [];
  private queues: Partial<Record<Purpose, unknown[]>>;

  constructor(
    private readonly handlers: Partial<Record<Purpose, ScriptedHandler>> = {},
    queues: Partial<Record<Purpose, unknown[]>> = {},
  ) {
    this.queues = Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, [...(v ?? [])]]));
  }

  /** Queue responses for a purpose (served before handlers, in order). */
  enqueue(purpose: Purpose, ...responses: unknown[]): this {
    this.queues[purpose] = [...(this.queues[purpose] ?? []), ...responses];
    return this;
  }

  async generate(req: CompletionRequest): Promise<RawCompletion> {
    this.calls.push(req);
    const q = this.queues[req.purpose];
    let out: unknown;
    if (q && q.length > 0) out = q.shift();
    else if (this.handlers[req.purpose]) out = this.handlers[req.purpose]!(req);
    else throw new Error(`scripted provider has no response for ${req.purpose}`);
    if (out instanceof Error) throw out;
    if (out && typeof out === "object" && "refusal" in out && (out as { refusal: unknown }).refusal === true) {
      return { text: "", refusal: true };
    }
    return { text: typeof out === "string" ? out : JSON.stringify(out) };
  }
}

/** A recorded LLM exchange (§3.8). */
export interface Cassette {
  purpose: Purpose;
  hash: string;
  response: RawCompletion;
}

/** Wraps a provider and records every exchange. */
export class RecordingProvider implements LlmProvider {
  readonly id: string;
  readonly capabilities;

  constructor(
    private readonly inner: LlmProvider,
    private readonly sink: (c: Cassette, req: CompletionRequest) => void,
  ) {
    this.id = inner.id;
    this.capabilities = inner.capabilities;
  }

  async generate(req: CompletionRequest, jsonSchema?: Record<string, unknown>): Promise<RawCompletion> {
    try {
      const response = await this.inner.generate(req, jsonSchema);
      this.sink({ purpose: req.purpose, hash: requestHash(req), response }, req);
      return response;
    } catch (e) {
      // Failures are recorded too, so replay reproduces the fallback path.
      this.sink({ purpose: req.purpose, hash: requestHash(req), response: { text: "", refusal: true } }, req);
      throw e;
    }
  }
}

/** Serves recorded responses by request hash, in recorded order per hash. */
export class ReplayProvider implements LlmProvider {
  readonly id = "replay";
  readonly capabilities = caps;
  private byHash = new Map<string, RawCompletion[]>();
  misses = 0;

  constructor(cassettes: readonly Cassette[]) {
    for (const c of cassettes) {
      const list = this.byHash.get(c.hash) ?? [];
      list.push(c.response);
      this.byHash.set(c.hash, list);
    }
  }

  async generate(req: CompletionRequest): Promise<RawCompletion> {
    const list = this.byHash.get(requestHash(req));
    const next = list?.shift();
    if (!next) {
      this.misses++;
      throw new Error(`no cassette for ${req.purpose} request ${requestHash(req)}`);
    }
    return next;
  }
}
