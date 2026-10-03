/**
 * Saves (§3.7, Q12): one save per game, holding the payload id and version, seed, snapshots, the event log, player
 * inputs and the LLM exchange log (cassettes for replay, §3.8). Day summaries live in the state. Where a save is kept
 * is a backend: a SQLite database on disk (save-sqlite.ts) or the browser's IndexedDB (src/hosts/web).
 */
import { applyOps, clone } from "../core/ops.js";
import type { WorldState } from "../core/state.js";
import { resetCursors } from "../core/tick.js";
import { addNewEntities, initialState, World, type WorldEvent } from "../core/world.js";
import type { CompletionRequest, UsageRecord } from "../llm/provider.js";
import type { Cassette } from "../llm/scripted.js";
import type { Payload } from "../payload/schema.js";
import type { Intent } from "./port.js";

export interface ExchangeRow {
  purpose: string;
  hash: string;
  request: string;
  response: string;
}

export interface UsageRow {
  purpose: string;
  provider: string;
  ok: boolean;
  json: string;
}

export interface EventRow {
  seq: number;
  json: string;
}

export interface SnapshotRow {
  seq: number;
  state: string;
}

/** Where a save's rows (JSON text) are kept. Writes are synchronous as far as the engine is concerned. */
export interface SaveBackend {
  meta(): Record<string, string>;
  setMeta(key: string, value: string): void;
  addInput(json: string): void;
  addExchange(row: ExchangeRow): void;
  addUsage(row: UsageRow): void;
  /** Appends events and, if given, a snapshot, together (in one transaction where the backend has them). */
  addEvents(events: EventRow[], snapshot?: SnapshotRow): void;
  setSnapshot(snapshot: SnapshotRow): void;
  /** In seq order. */
  events(): string[];
  /** In the order they were added. */
  inputs(): string[];
  exchanges(): ExchangeRow[];
  usage(): UsageRow[];
  /** The snapshot with the highest seq. */
  latestSnapshot(): SnapshotRow | undefined;
  close(): void;
}

/** A save held in memory: for tests, and under the browser's IndexedDB save. */
export class MemorySaveBackend implements SaveBackend {
  protected readonly rows = {
    meta: {} as Record<string, string>,
    events: [] as EventRow[],
    inputs: [] as string[],
    exchanges: [] as ExchangeRow[],
    usage: [] as UsageRow[],
    snapshot: undefined as SnapshotRow | undefined,
  };

  meta(): Record<string, string> {
    return { ...this.rows.meta };
  }

  setMeta(key: string, value: string): void {
    this.rows.meta[key] = value;
  }

  addInput(json: string): void {
    this.rows.inputs.push(json);
  }

  addExchange(row: ExchangeRow): void {
    this.rows.exchanges.push(row);
  }

  addUsage(row: UsageRow): void {
    this.rows.usage.push(row);
  }

  addEvents(events: EventRow[], snapshot?: SnapshotRow): void {
    this.rows.events.push(...events);
    if (snapshot) this.setSnapshot(snapshot);
  }

  setSnapshot(snapshot: SnapshotRow): void {
    if (!this.rows.snapshot || snapshot.seq >= this.rows.snapshot.seq) this.rows.snapshot = snapshot;
  }

  events(): string[] {
    return [...this.rows.events].sort((a, b) => a.seq - b.seq).map((e) => e.json);
  }

  inputs(): string[] {
    return [...this.rows.inputs];
  }

  exchanges(): ExchangeRow[] {
    return [...this.rows.exchanges];
  }

  usage(): UsageRow[] {
    return [...this.rows.usage];
  }

  latestSnapshot(): SnapshotRow | undefined {
    return this.rows.snapshot;
  }

  close(): void {}
}

export const SNAPSHOT_EVERY = 1000;

export class SaveStore {
  private pending: WorldEvent[] = [];
  private sinceSnapshot = 0;

  constructor(private readonly db: SaveBackend) {}

  meta(): Record<string, string> {
    return this.db.meta();
  }

  /** Starts a new save for a fresh world. */
  init(payload: Payload, w: World, providerId: string): void {
    this.db.setMeta("payloadId", payload.game.id);
    this.db.setMeta("payloadVersion", payload.game.version);
    this.db.setMeta("schemaVersion", payload.game.schema_version);
    this.db.setMeta("seed", w.state.seed);
    this.db.setMeta("provider", providerId);
    this.db.setSnapshot({ seq: -1, state: JSON.stringify(w.state) });
  }

  /** Attach to a world: every event is queued and written on flush. */
  attach(w: World): void {
    w.onEvent((e) => this.pending.push(e));
  }

  recordInput(intent: Intent): void {
    this.db.addInput(JSON.stringify(intent));
  }

  recordExchange(c: Cassette, req: CompletionRequest): void {
    const request = JSON.stringify({ purpose: req.purpose, system: req.system, messages: req.messages });
    this.db.addExchange({ purpose: c.purpose, hash: c.hash, request, response: JSON.stringify(c.response) });
  }

  recordUsage(u: UsageRecord): void {
    this.db.addUsage({ purpose: u.purpose, provider: u.provider, ok: u.ok, json: JSON.stringify(u.usage ?? {}) });
  }

  /** Writes queued events in one go, with a snapshot every SNAPSHOT_EVERY events. */
  flush(w: World): void {
    if (this.pending.length === 0) return;
    const events = this.pending.map((e) => ({ seq: e.seq, json: JSON.stringify(e) }));
    this.sinceSnapshot += events.length;
    let snapshot: SnapshotRow | undefined;
    if (this.sinceSnapshot >= SNAPSHOT_EVERY) {
      snapshot = { seq: w.log.length - 1, state: JSON.stringify(w.state) };
      this.sinceSnapshot = 0;
    }
    this.db.addEvents(events, snapshot);
    this.pending = [];
  }

  events(): WorldEvent[] {
    return this.db.events().map((json) => JSON.parse(json) as WorldEvent);
  }

  inputs(): Intent[] {
    return this.db.inputs().map((json) => JSON.parse(json) as Intent);
  }

  cassettes(): Cassette[] {
    return this.db.exchanges().map((r) => ({
      purpose: r.purpose as Cassette["purpose"],
      hash: r.hash,
      response: JSON.parse(r.response),
    }));
  }

  usageByPurpose(): Record<string, { calls: number; failed: number; inputTokens: number; outputTokens: number }> {
    const out: Record<string, { calls: number; failed: number; inputTokens: number; outputTokens: number }> = {};
    for (const r of this.db.usage()) {
      const u = JSON.parse(r.json) as { inputTokens?: number; outputTokens?: number };
      out[r.purpose] ??= { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
      const o = out[r.purpose]!;
      o.calls++;
      if (!r.ok) o.failed++;
      o.inputTokens += u.inputTokens ?? 0;
      o.outputTokens += u.outputTokens ?? 0;
    }
    return out;
  }

  /**
   * Loads the world: the latest snapshot plus a fold of the events after it (§3.7). Checks the payload matches
   * (§7.8): a changed payload invalidates the save unless it declares the save's version compatible.
   */
  load(payload: Payload): World {
    const meta = this.meta();
    if (meta.payloadId !== payload.game.id) {
      throw new Error(`save is for payload '${meta.payloadId}', not '${payload.game.id}'`);
    }
    if (
      meta.payloadVersion !== payload.game.version &&
      !payload.game.compatible_with.includes(meta.payloadVersion ?? "")
    ) {
      throw new Error(
        `save is for ${payload.game.id} ${meta.payloadVersion}; this payload is ${payload.game.version} and does not declare it compatible`,
      );
    }
    const snap = this.db.latestSnapshot();
    const events = this.events();
    let state: WorldState = snap ? (JSON.parse(snap.state) as WorldState) : initialState(payload, meta.seed ?? "seed");
    const from = snap ? snap.seq + 1 : 0;
    state = clone(state);
    for (const e of events) if (e.seq >= from) applyOps(state, e.ops);
    // A compatible newer payload may add objects and characters the save has never seen.
    addNewEntities(state, payload);
    const w = new World(payload, state);
    w.log = events;
    resetCursors(w);
    return w;
  }

  close(): void {
    this.db.close();
  }
}
