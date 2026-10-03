/** Saves on disk (§3.7, Q12): one SQLite database per save game. */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, ExchangeRow, SaveBackend, SnapshotRow, UsageRow } from "./save.js";
import { SaveStore } from "./save.js";

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

class SqliteSaveBackend implements SaveBackend {
  constructor(private readonly db: DatabaseSync) {}

  meta(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  addInput(json: string): void {
    this.db.prepare("INSERT INTO inputs (json) VALUES (?)").run(json);
  }

  addExchange(r: ExchangeRow): void {
    this.db
      .prepare("INSERT INTO llm (purpose, hash, request, response) VALUES (?, ?, ?, ?)")
      .run(r.purpose, r.hash, r.request, r.response);
  }

  addUsage(r: UsageRow): void {
    this.db
      .prepare("INSERT INTO usage (purpose, provider, ok, json) VALUES (?, ?, ?, ?)")
      .run(r.purpose, r.provider, r.ok ? 1 : 0, r.json);
  }

  addEvents(events: EventRow[], snapshot?: SnapshotRow): void {
    const insert = this.db.prepare("INSERT INTO events (seq, json) VALUES (?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const e of events) insert.run(e.seq, e.json);
      if (snapshot) this.setSnapshot(snapshot);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  setSnapshot(s: SnapshotRow): void {
    this.db.prepare("INSERT OR REPLACE INTO snapshots (seq, state) VALUES (?, ?)").run(s.seq, s.state);
  }

  events(): string[] {
    return (this.db.prepare("SELECT json FROM events ORDER BY seq").all() as { json: string }[]).map((r) => r.json);
  }

  inputs(): string[] {
    return (this.db.prepare("SELECT json FROM inputs ORDER BY n").all() as { json: string }[]).map((r) => r.json);
  }

  exchanges(): ExchangeRow[] {
    return this.db
      .prepare("SELECT purpose, hash, request, response FROM llm ORDER BY n")
      .all() as unknown as ExchangeRow[];
  }

  usage(): UsageRow[] {
    const rows = this.db.prepare("SELECT purpose, provider, ok, json FROM usage ORDER BY n").all() as {
      purpose: string;
      provider: string;
      ok: number;
      json: string;
    }[];
    return rows.map((r) => ({ ...r, ok: !!r.ok }));
  }

  latestSnapshot(): SnapshotRow | undefined {
    return this.db.prepare("SELECT seq, state FROM snapshots ORDER BY seq DESC LIMIT 1").get() as
      | SnapshotRow
      | undefined;
  }

  close(): void {
    this.db.close();
  }
}

/** Opens (creating if need be) the save database at `path`. */
export async function openSqliteSave(path: string): Promise<SaveStore> {
  const db = await openDb(path);
  db.exec(SCHEMA);
  return new SaveStore(new SqliteSaveBackend(db));
}

export const saveExists = (path: string): boolean => existsSync(path);
