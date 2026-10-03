/**
 * Saves in the browser (§3.7): a save is read whole from IndexedDB when the game opens and kept in memory; every
 * write is applied in memory at once and written behind to IndexedDB, in order, a transaction per batch.
 */

import {
  type EventRow,
  type ExchangeRow,
  MemorySaveBackend,
  SaveStore,
  type SnapshotRow,
  type UsageRow,
} from "../../session/save.js";

const DB_NAME = "oneblock";
/** One record per save: its meta and latest snapshot. */
const SAVES = "saves";
/** Appended rows, each tagged with its save and kind. */
const ROWS = "rows";

type Kind = "event" | "input" | "exchange" | "usage";

interface SaveRecord {
  meta: Record<string, string>;
  snapshot?: SnapshotRow;
}

interface RowRecord {
  save: string;
  kind: Kind;
  data: unknown;
}

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

export function openDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  const open = factory.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore(SAVES);
    db.createObjectStore(ROWS, { autoIncrement: true }).createIndex("save", "save");
  };
  return request(open);
}

class IdbSaveBackend extends MemorySaveBackend {
  private queue: ((saves: IDBObjectStore, rows: IDBObjectStore) => void)[] = [];
  private scheduled = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: IDBDatabase,
    private readonly id: string,
    private readonly onError: (err: unknown) => void,
  ) {
    super();
  }

  /** Fills memory from what IndexedDB holds for this save. */
  async read(): Promise<boolean> {
    const tx = this.db.transaction([SAVES, ROWS], "readonly");
    // Both requests go in before awaiting either, so the transaction can't finish under us.
    const [record, rows] = (await Promise.all([
      request(tx.objectStore(SAVES).get(this.id)),
      request(tx.objectStore(ROWS).index("save").getAll(this.id)),
    ])) as [SaveRecord | undefined, RowRecord[]];
    if (!record) return false;
    this.rows.meta = { ...record.meta };
    this.rows.snapshot = record.snapshot;
    for (const r of rows) {
      if (r.kind === "event") this.rows.events.push(r.data as EventRow);
      else if (r.kind === "input") this.rows.inputs.push(r.data as string);
      else if (r.kind === "exchange") this.rows.exchanges.push(r.data as ExchangeRow);
      else this.rows.usage.push(r.data as UsageRow);
    }
    return true;
  }

  private write(op: (saves: IDBObjectStore, rows: IDBObjectStore) => void): void {
    this.queue.push(op);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const ops = this.queue;
      this.queue = [];
      const tx = this.db.transaction([SAVES, ROWS], "readwrite");
      const saves = tx.objectStore(SAVES);
      const rows = tx.objectStore(ROWS);
      for (const o of ops) o(saves, rows);
      this.writing = done(tx).catch(this.onError);
    });
  }

  private putRecord(): void {
    const record: SaveRecord = {
      meta: { ...this.rows.meta },
      ...(this.rows.snapshot ? { snapshot: this.rows.snapshot } : {}),
    };
    this.write((saves) => saves.put(record, this.id));
  }

  private addRow(kind: Kind, data: unknown): void {
    const row: RowRecord = { save: this.id, kind, data };
    this.write((_, rows) => rows.add(row));
  }

  override setMeta(key: string, value: string): void {
    super.setMeta(key, value);
    this.putRecord();
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
    this.putRecord();
  }

  /** Resolves once everything written so far is in IndexedDB. */
  async settled(): Promise<void> {
    await new Promise<void>((r) => queueMicrotask(r));
    await this.writing;
  }

  override close(): void {
    void this.settled().then(() => this.db.close());
  }
}

export interface BrowserSave {
  store: SaveStore;
  /** The save already held a game. */
  resuming: boolean;
}

/** Opens the save `id` in IndexedDB; write failures go to `onError`. */
export async function openBrowserSave(
  id: string,
  onError: (err: unknown) => void,
  factory?: IDBFactory,
): Promise<BrowserSave> {
  const db = await openDatabase(factory);
  const backend = new IdbSaveBackend(db, id, onError);
  const resuming = await backend.read();
  return { store: new SaveStore(backend), resuming };
}

/** Deletes the save `id`. */
export async function deleteBrowserSave(id: string, factory?: IDBFactory): Promise<void> {
  const db = await openDatabase(factory);
  try {
    const tx = db.transaction([SAVES, ROWS], "readwrite");
    tx.objectStore(SAVES).delete(id);
    const rows = tx.objectStore(ROWS);
    const keys = rows.index("save").getAllKeys(id);
    // Deleted in the success callback, while the transaction is still active.
    keys.onsuccess = () => {
      for (const k of keys.result) rows.delete(k);
    };
    await done(tx);
  } finally {
    db.close();
  }
}
