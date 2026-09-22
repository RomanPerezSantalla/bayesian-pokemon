/**
 * Where battles are kept: IndexedDB, one packed record per battle plus a small summary for lists,
 * so a save writes one battle and nothing has a 5 MB ceiling like localStorage. Where IndexedDB is
 * unavailable (storage blocked), they're kept in memory for the visit.
 */
import type {Battle} from '../engine/types';
import {battleInfo, packBattle, unpackBattle, type BattleInfo, type PackedBattle} from './pack';

export interface BattleStore {
  kind: 'indexeddb' | 'memory';
  list(): Promise<BattleInfo[]>;
  get(id: string): Promise<Battle | undefined>;
  /** Saves battles in one go (all or nothing). */
  put(battles: (Battle | PackedBattle)[]): Promise<void>;
  remove(id: string): Promise<void>;
  /** Every battle, packed (for backups). */
  all(): Promise<PackedBattle[]>;
}

const DB_NAME = 'bayesian-battle';
const BATTLES = 'battles';
const INFO = 'info';

const packed = (b: Battle | PackedBattle): PackedBattle => ('packed' in b ? b : packBattle(b));

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** An abort with no error of its own: the connection closing mid-save, typically. */
const interrupted = () => Object.assign(new Error('the save was interrupted'), {name: 'Interrupted'});

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? interrupted());
    tx.onabort = () => reject(tx.error ?? interrupted());
  });
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(BATTLES)) db.createObjectStore(BATTLES, {keyPath: 'id'});
      if (!db.objectStoreNames.contains(INFO)) db.createObjectStore(INFO, {keyPath: 'id'});
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * The connection went away under us: Safari drops it when an app has sat in the background
 * ("Connection to Indexed Database server lost"), and a closed one refuses new transactions.
 * Worth one retry on a fresh connection; a full disk or blocked storage isn't.
 */
export const lostConnection = (err: unknown) =>
  err instanceof Error && ['InvalidStateError', 'UnknownError', 'TransactionInactiveError', 'Interrupted'].includes(err.name);

export async function indexedDBStore(open = openDB): Promise<BattleStore> {
  let conn: Promise<IDBDatabase> | null = null;
  const connect = () => {
    conn ??= open().then(db => {
      // Closed abnormally, or a newer version of the app in another tab wants to upgrade: reconnect next time.
      db.onclose = () => {
        conn = null;
      };
      db.onversionchange = () => {
        db.close();
        conn = null;
      };
      return db;
    }, err => {
      conn = null;
      throw err;
    });
    return conn;
  };
  // Fails here if this browser won't give us IndexedDB at all (the memory store takes over).
  await connect();

  async function run<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const using = connect();
      const db = await using;
      try {
        return await fn(db.transaction(stores, mode));
      } catch (err) {
        if (attempt > 0 || !lostConnection(err)) throw err;
        // Unless another save has already reconnected.
        if (conn === using) conn = null;
        try {
          db.close();
        } catch {
          // Already gone.
        }
      }
    }
  }
  return {
    kind: 'indexeddb',
    list: () => run([INFO], 'readonly', tx => request(tx.objectStore(INFO).getAll() as IDBRequest<BattleInfo[]>)),
    get: async id => {
      const p = await run([BATTLES], 'readonly', tx => request(tx.objectStore(BATTLES).get(id) as IDBRequest<PackedBattle | undefined>));
      return p && unpackBattle(p);
    },
    put: async battles => {
      if (!battles.length) return;
      // Packed before the transaction opens: it commits by itself once its requests are done.
      const records = battles.map(packed);
      await run([BATTLES, INFO], 'readwrite', tx => {
        for (const p of records) {
          tx.objectStore(BATTLES).put(p);
          tx.objectStore(INFO).put(battleInfo(p));
        }
        return finished(tx);
      });
    },
    remove: id => run([BATTLES, INFO], 'readwrite', tx => {
      tx.objectStore(BATTLES).delete(id);
      tx.objectStore(INFO).delete(id);
      return finished(tx);
    }),
    all: () => run([BATTLES], 'readonly', tx => request(tx.objectStore(BATTLES).getAll() as IDBRequest<PackedBattle[]>)),
  };
}

/** For this visit only. */
export function memoryStore(seed: (Battle | PackedBattle)[] = []): BattleStore {
  const saved = new Map<string, PackedBattle>();
  for (const b of seed) {
    try {
      saved.set(b.id, packed(b));
    } catch {
      // A damaged battle from an old version: left out.
    }
  }
  return {
    kind: 'memory',
    list: async () => [...saved.values()].map(battleInfo),
    get: async id => {
      const p = saved.get(id);
      return p && unpackBattle(p);
    },
    put: async battles => {
      for (const b of battles) saved.set(b.id, packed(b));
    },
    remove: async id => {
      saved.delete(id);
    },
    all: async () => [...saved.values()],
  };
}
