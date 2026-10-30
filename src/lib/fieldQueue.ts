/** Fila local de pontos GPS (IndexedDB): nada se perde sem internet; o envio é repetido sem duplicar. */
export interface QueuedPoint {
  id: string; sessionId: string; lat: number; lng: number; accuracy: number | null; altitude: number | null;
  speed: number | null; heading: number | null; capturedAt: string;
}

const DB = 'rastro-campo';
let dbp: Promise<IDBDatabase> | null = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore('points', { keyPath: 'id' });
        s.createIndex('session', 'sessionId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | void> {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction('points', mode);
    const r = fn(tx.objectStore('points'));
    tx.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : undefined);
    tx.onerror = () => reject(tx.error);
  }));
}

export const addPoint = (p: QueuedPoint) => run('readwrite', (s) => { s.put(p); });
export const removePoints = (ids: string[]) => run('readwrite', (s) => { ids.forEach((id) => s.delete(id)); });
export async function pendingFor(sessionId: string, limit = 200): Promise<QueuedPoint[]> {
  const all = (await run<QueuedPoint[]>('readonly', (s) => s.index('session').getAll(sessionId, limit))) as QueuedPoint[] | undefined;
  return (all ?? []).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}
export async function countFor(sessionId: string): Promise<number> {
  return ((await run<number>('readonly', (s) => s.index('session').count(sessionId))) as number) ?? 0;
}
export async function sessionsWithPending(): Promise<string[]> {
  const all = ((await run<QueuedPoint[]>('readonly', (s) => s.getAll())) as QueuedPoint[]) ?? [];
  return [...new Set(all.map((p) => p.sessionId))];
}

export function uuid() {
  return (crypto as any).randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
