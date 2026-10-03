/**
 * Saves in the browser (§3.7): a save is read whole from IndexedDB when the game opens and kept in memory; every
 * write is applied in memory at once and written behind to IndexedDB, in order, a transaction per batch. Slots are
 * keyed `<game id>/<slot>`.
 */

import {
  type EventRow,
  type ExchangeRow,
  MemorySaveBackend,
  type SaveBackend,
  type SnapshotRow,
  type UsageRow,
} from "../../engine/session/save.js";
import { DEFAULT_SLOT, type SaveInfo, type SaveStorage } from "../../platform/index.js";

const DB_NAME = "oneblock";
const DB_VERSION = 2;
/** One small record per save: its meta and when it was last written. */
const SAVES = "saves";
/** Each save's latest snapshot, apart so that the per-turn stamp doesn't rewrite it. */
const SNAPSHOTS = "snapshots";
/** Appended rows, each tagged with its save and kind. */
const ROWS = "rows";
const STORES = [SAVES, SNAPSHOTS, ROWS];

type Kind = "event" | "input" | "exchange" | "usage";

interface SaveRecord {
  meta: Record<string, string>;
  /** ms since the epoch. */
  updated: number;
}

interface RowRecord {
  save: string;
  kind: Kind;
  data: unknown;
}

type Stores = Record<typeof SAVES | typeof SNAPSHOTS | typeof ROWS, IDBObjectStore>;

const keyOf = (gameId: string, slot: string) => `${gameId}/${slot}`;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("save transaction aborted"));
  });
}

const stores = (tx: IDBTransaction): Stores => ({
  saves: tx.objectStore(SAVES),
  snapshots: tx.objectStore(SNAPSHOTS),
  rows: tx.objectStore(ROWS),
});

/**
 * Version 1 kept one save per game, keyed by the game id, with its snapshot in the save record. Those become the
 * game's DEFAULT_SLOT.
 */
function upgradeFromV1(tx: IDBTransaction): void {
  const { saves, snapshots, rows } = stores(tx);
  const cursor = saves.openCursor();
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (!c) return;
    const old = String(c.key);
    if (!old.includes("/")) {
      const { meta, snapshot } = c.value as { meta: Record<string, string>; snapshot?: SnapshotRow };
      const key = keyOf(old, DEFAULT_SLOT);
      saves.put({ meta, updated: Date.now() } satisfies SaveRecord, key);
      if (snapshot) snapshots.put(snapshot, key);
      c.delete();
    }
    c.continue();
  };
  const rowCursor = rows.openCursor();
  rowCursor.onsuccess = () => {
    const c = rowCursor.result;
    if (!c) return;
    const row = c.value as RowRecord;
    if (!row.save.includes("/")) c.update({ ...row, save: keyOf(row.save, DEFAULT_SLOT) });
    c.continue();
  };
}

export function openDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  const open = factory.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = (e) => {
    const db = open.result;
    if (e.oldVersion < 1) {
      db.createObjectStore(SAVES);
      db.createObjectStore(ROWS, { autoIncrement: true }).createIndex("save", "save");
    }
    if (e.oldVersion < 2) {
      db.createObjectStore(SNAPSHOTS);
      if (e.oldVersion >= 1) upgradeFromV1(open.transaction!);
    }
  };
  return request(open).then((db) => {
    // Let a newer page upgrade the database rather than block on this one.
    db.onversionchange = () => db.close();
    return db;
  });
}

class IdbSaveBackend extends MemorySaveBackend {
  private queue: ((s: Stores) => void)[] = [];
  private scheduled = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: IDBDatabase,
    private readonly key: string,
    private readonly onError: (err: unknown) => void,
    private readonly onClose: (b: IdbSaveBackend) => void,
  ) {
    super();
  }

  /** Fills memory from what IndexedDB holds for this save; false if it holds nothing. */
  async read(): Promise<boolean> {
    const tx = this.db.transaction(STORES, "readonly");
    const s = stores(tx);
    // Every request goes in before awaiting any, so the transaction can't finish under us.
    const [record, snapshot, rows] = (await Promise.all([
      request(s.saves.get(this.key)),
      request(s.snapshots.get(this.key)),
      request(s.rows.index("save").getAll(this.key)),
    ])) as [SaveRecord | undefined, SnapshotRow | undefined, RowRecord[]];
    if (!record) return false;
    this.rows.meta = { ...record.meta };
    this.rows.snapshot = snapshot;
    for (const r of rows) {
      if (r.kind === "event") this.rows.events.push(r.data as EventRow);
      else if (r.kind === "input") this.rows.inputs.push(r.data as string);
      else if (r.kind === "exchange") this.rows.exchanges.push(r.data as ExchangeRow);
      else this.rows.usage.push(r.data as UsageRow);
    }
    return true;
  }

  /** Queues `op` for the next batch. Every batch also stamps the save record with its meta and the time. */
  private write(op?: (s: Stores) => void): void {
    if (op) this.queue.push(op);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const ops = this.queue;
      this.queue = [];
      const tx = this.db.transaction(STORES, "readwrite");
      const s = stores(tx);
      for (const o of ops) o(s);
      s.saves.put({ meta: { ...this.rows.meta }, updated: Date.now() } satisfies SaveRecord, this.key);
      this.writing = done(tx).catch(this.onError);
    });
  }

  private addRow(kind: Kind, data: unknown): void {
    const row: RowRecord = { save: this.key, kind, data };
    this.write((s) => s.rows.add(row));
  }

  override setMeta(key: string, value: string): void {
    super.setMeta(key, value);
    this.write();
  }

  override addInput(json: string): void {
    super.addInput(json);
    this.addRow("input", json);
  }

  override addExchange(row: ExchangeRow): void {
    super.addExchange(row);
    this.addRow("exchange", row);
  }

  override addUsage(row: UsageRow): void {
    super.addUsage(row);
    this.addRow("usage", row);
  }

  override addEvents(events: EventRow[], snapshot?: SnapshotRow): void {
    super.addEvents(events);
    for (const e of events) this.addRow("event", e);
    if (snapshot) this.setSnapshot(snapshot);
  }

  override setSnapshot(snapshot: SnapshotRow): void {
    super.setSnapshot(snapshot);
    const latest = this.rows.snapshot;
    this.write((s) => s.snapshots.put(latest, this.key));
  }

  /** Resolves once everything written so far is in IndexedDB. */
  async settled(): Promise<void> {
    await new Promise<void>((r) => queueMicrotask(r));
    await this.writing;
  }

  override close(): void {
    void this.settled().then(() => this.onClose(this));
  }
}

/** Save slots in IndexedDB. Write failures go to `onError` (the game carries on in memory). */
export class IdbSaveStorage implements SaveStorage {
  private db: Promise<IDBDatabase> | undefined;
  /** Open saves, and closed ones still writing. */
  private readonly live = new Set<IdbSaveBackend>();
  private readonly factory: IDBFactory | undefined;
  private readonly onError: (err: unknown) => void;

  constructor(o: { factory?: IDBFactory; onError?: (err: unknown) => void } = {}) {
    this.factory = o.factory;
    this.onError = o.onError ?? ((err) => console.error("saving failed", err));
  }

  private database(): Promise<IDBDatabase> {
    this.db ??= openDatabase(this.factory);
    return this.db;
  }

  async list(gameId: string): Promise<SaveInfo[]> {
    const db = await this.database();
    const saves = db.transaction(SAVES, "readonly").objectStore(SAVES);
    const [keys, records] = await Promise.all([request(saves.getAllKeys()), request(saves.getAll())]);
    const prefix = `${gameId}/`;
    const out: SaveInfo[] = [];
    keys.forEach((k, i) => {
      const key = String(k);
      const r = records[i] as SaveRecord;
      if (key.startsWith(prefix))
        out.push({ gameId, slot: key.slice(prefix.length), updated: r.updated, meta: r.meta });
    });
    return out.sort((a, b) => b.updated - a.updated);
  }

  async open(gameId: string, slot: string): Promise<{ backend: SaveBackend; existed: boolean }> {
    const db = await this.database();
    const backend = new IdbSaveBackend(db, keyOf(gameId, slot), this.onError, (b) => this.live.delete(b));
    const existed = await backend.read();
    this.live.add(backend);
    return { backend, existed };
  }

  async delete(gameId: string, slot: string): Promise<void> {
    // Writes still queued would bring the save back.
    await this.settled();
    const key = keyOf(gameId, slot);
    const db = await this.database();
    const tx = db.transaction(STORES, "readwrite");
    const s = stores(tx);
    s.saves.delete(key);
    s.snapshots.delete(key);
    const keys = s.rows.index("save").getAllKeys(key);
    // Deleted in the success callback, while the transaction is still active.
    keys.onsuccess = () => {
      for (const k of keys.result) s.rows.delete(k);
    };
    await done(tx);
  }

  async settled(): Promise<void> {
    await Promise.all([...this.live].map((b) => b.settled()));
  }

  /** Closes the database once pending writes are in. */
  async close(): Promise<void> {
    await this.settled();
    if (this.db) (await this.db).close();
    this.db = undefined;
  }
}

/** Waits for pending writes when the page is hidden or unloaded, the last moments a browser promises to run. */
export function flushOnHide(
  storage: Pick<SaveStorage, "settled">,
  target: EventTarget & { document?: { visibilityState?: string } },
): () => void {
  const flush = () => void storage.settled();
  const onVisibility = () => {
    if (target.document?.visibilityState !== "visible") flush();
  };
  target.addEventListener("pagehide", flush);
  target.addEventListener("visibilitychange", onVisibility);
  return () => {
    target.removeEventListener("pagehide", flush);
    target.removeEventListener("visibilitychange", onVisibility);
  };
}
