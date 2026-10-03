/**
 * Saves on disk (§3.7, Q12): one SQLite database per save game. SqliteSaveStorage keeps them as
 * `<root>/<game id>/<slot>.db`, the root defaulting to `$XDG_DATA_HOME/oneblock/saves`.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, ExchangeRow, SaveBackend, SnapshotRow, UsageRow } from "../../engine/session/save.js";
import { SaveStore } from "../../engine/session/save.js";
import { DEFAULT_SLOT, type SaveInfo, type SaveStorage } from "../../platform/index.js";
import { dataDir } from "./xdg.js";

/** node:sqlite is still flagged experimental on Node 22; load it lazily and without the warning. */
async function openDb(path: string, readOnly = false): Promise<DatabaseSync> {
  const original = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    const text = typeof w === "string" ? w : w.message;
    if (text.includes("SQLite")) return;
    return (original as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(path, { readOnly });
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
export async function openSqliteBackend(path: string): Promise<SaveBackend> {
  const db = await openDb(path);
  db.exec(SCHEMA);
  return new SqliteSaveBackend(db);
}

export async function openSqliteSave(path: string): Promise<SaveStore> {
  return new SaveStore(await openSqliteBackend(path));
}

/** A save holds a game once it has been given its payload. */
const holdsGame = (b: SaveBackend) => b.meta().payloadId !== undefined;

async function readMeta(path: string): Promise<Record<string, string>> {
  const db = await openDb(path, true);
  try {
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  } finally {
    db.close();
  }
}

function removeDb(path: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

/** Game ids and slots become path segments, so only plain names are allowed. */
function segment(name: string, what: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) throw new Error(`bad save ${what} '${name}'`);
  return name;
}

export const defaultSaveRoot = (env?: Record<string, string | undefined>): string => join(dataDir(env), "saves");

/** Save slots on disk: `<root>/<game id>/<slot>.db`. */
export class SqliteSaveStorage implements SaveStorage {
  constructor(readonly root: string = defaultSaveRoot()) {}

  pathOf(gameId: string, slot: string): string {
    return join(this.root, segment(gameId, "game id"), `${segment(slot, "slot")}.db`);
  }

  async list(gameId: string): Promise<SaveInfo[]> {
    const dir = join(this.root, segment(gameId, "game id"));
    if (!existsSync(dir)) return [];
    const out: SaveInfo[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".db")) continue;
      const path = join(dir, file);
      out.push({ gameId, slot: file.slice(0, -3), updated: statSync(path).mtimeMs, meta: await readMeta(path) });
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async open(gameId: string, slot: string): Promise<{ backend: SaveBackend; existed: boolean }> {
    const path = this.pathOf(gameId, slot);
    mkdirSync(join(this.root, gameId), { recursive: true });
    const backend = await openSqliteBackend(path);
    return { backend, existed: holdsGame(backend) };
  }

  async delete(gameId: string, slot: string): Promise<void> {
    removeDb(this.pathOf(gameId, slot));
  }

  /** SQLite writes are durable when they return. */
  async settled(): Promise<void> {}
}

/** One save file, whatever the game and slot: the terminal's `play --save <file>`. */
export function singleSqliteSave(path: string): SaveStorage {
  return {
    list: async (gameId) =>
      existsSync(path)
        ? [{ gameId, slot: DEFAULT_SLOT, updated: statSync(path).mtimeMs, meta: await readMeta(path) }]
        : [],
    open: async () => {
      const backend = await openSqliteBackend(path);
      return { backend, existed: holdsGame(backend) };
    },
    delete: async () => removeDb(path),
    settled: async () => {},
  };
}
