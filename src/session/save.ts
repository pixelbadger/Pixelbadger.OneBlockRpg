/**
 * Saves (§3.7, Q12): one SQLite database per save game, holding the payload id and version, seed, snapshots, the
 * event log, player inputs and the LLM exchange log (cassettes for replay, §3.8). Day summaries live in the state.
 */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { applyOps, clone } from "../core/ops.js";
import type { WorldState } from "../core/state.js";
import { resetCursors } from "../core/tick.js";
import { addNewEntities, initialState, World, type WorldEvent } from "../core/world.js";
import type { CompletionRequest, UsageRecord } from "../llm/provider.js";
import type { Cassette } from "../llm/scripted.js";
import type { Payload } from "../payload/schema.js";
import type { Intent } from "./port.js";

/** node:sqlite is still flagged experimental on Node 22; load it lazily and without the warning. */
async function openDb(path: string): Promise<DatabaseSync> {
  const original = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    const text = typeof w === "string" ? w : w.message;
    if (text.includes("SQLite")) return;
    return (original as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(path);
  } finally {
    process.emitWarning = original;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (seq INTEGER PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inputs (n INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS llm (n INTEGER PRIMARY KEY AUTOINCREMENT, purpose TEXT NOT NULL, hash TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (n INTEGER PRIMARY KEY AUTOINCREMENT, purpose TEXT NOT NULL, provider TEXT NOT NULL, ok INTEGER NOT NULL, json TEXT NOT NULL);
`;

export const SNAPSHOT_EVERY = 1000;

export class SaveStore {
  private pending: WorldEvent[] = [];
  private sinceSnapshot = 0;

  private constructor(
    readonly path: string,
    private readonly db: DatabaseSync,
  ) {}

  static async open(path: string): Promise<SaveStore> {
    const db = await openDb(path);
    db.exec(SCHEMA);
    return new SaveStore(path, db);
  }

  static exists(path: string): boolean {
    return existsSync(path);
  }

  meta(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  private setMeta(key: string, value: string) {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Starts a new save for a fresh world. */
  init(payload: Payload, w: World, providerId: string): void {
    this.setMeta("payloadId", payload.game.id);
    this.setMeta("payloadVersion", payload.game.version);
    this.setMeta("schemaVersion", payload.game.schema_version);
    this.setMeta("seed", w.state.seed);
    this.setMeta("provider", providerId);
    this.db.prepare("INSERT OR REPLACE INTO snapshots (seq, state) VALUES (?, ?)").run(-1, JSON.stringify(w.state));
  }

  /** Attach to a world: every event is queued and written on flush. */
  attach(w: World): void {
    w.onEvent((e) => this.pending.push(e));
  }

  recordInput(intent: Intent): void {
    this.db.prepare("INSERT INTO inputs (json) VALUES (?)").run(JSON.stringify(intent));
  }

  recordExchange(c: Cassette, req: CompletionRequest): void {
    const request = JSON.stringify({ purpose: req.purpose, system: req.system, messages: req.messages });
    this.db
      .prepare("INSERT INTO llm (purpose, hash, request, response) VALUES (?, ?, ?, ?)")
      .run(c.purpose, c.hash, request, JSON.stringify(c.response));
  }

  recordUsage(u: UsageRecord): void {
    this.db
      .prepare("INSERT INTO usage (purpose, provider, ok, json) VALUES (?, ?, ?, ?)")
      .run(u.purpose, u.provider, u.ok ? 1 : 0, JSON.stringify(u.usage ?? {}));
  }

  /** Writes queued events in one transaction, with a snapshot every SNAPSHOT_EVERY events. */
  flush(w: World): void {
    if (this.pending.length === 0) return;
    const insert = this.db.prepare("INSERT INTO events (seq, json) VALUES (?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const e of this.pending) insert.run(e.seq, JSON.stringify(e));
      this.sinceSnapshot += this.pending.length;
      if (this.sinceSnapshot >= SNAPSHOT_EVERY) {
        this.db
          .prepare("INSERT OR REPLACE INTO snapshots (seq, state) VALUES (?, ?)")
          .run(w.log.length - 1, JSON.stringify(w.state));
        this.sinceSnapshot = 0;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.pending = [];
  }

  events(): WorldEvent[] {
    return (this.db.prepare("SELECT json FROM events ORDER BY seq").all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as WorldEvent,
    );
  }

  inputs(): Intent[] {
    return (this.db.prepare("SELECT json FROM inputs ORDER BY n").all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Intent,
    );
  }

  cassettes(): Cassette[] {
    return (
      this.db.prepare("SELECT purpose, hash, response FROM llm ORDER BY n").all() as {
        purpose: string;
        hash: string;
        response: string;
      }[]
    ).map((r) => ({ purpose: r.purpose as Cassette["purpose"], hash: r.hash, response: JSON.parse(r.response) }));
  }

  usageByPurpose(): Record<string, { calls: number; failed: number; inputTokens: number; outputTokens: number }> {
    const rows = this.db.prepare("SELECT purpose, ok, json FROM usage").all() as {
      purpose: string;
      ok: number;
      json: string;
    }[];
    const out: Record<string, { calls: number; failed: number; inputTokens: number; outputTokens: number }> = {};
    for (const r of rows) {
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
    const snap = this.db.prepare("SELECT seq, state FROM snapshots ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; state: string }
      | undefined;
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
