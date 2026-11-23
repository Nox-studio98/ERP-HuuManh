/* Hàng đợi đơn offline (IndexedDB) — đồng bộ idempotent qua clientUuid (EC-04) */
import { useSyncExternalStore } from "react";
import { ApiError, post } from "./api";
import { toast } from "./components/toast";

export type QueuedOrder = { clientUuid: string; payload: any; createdAt: string; error?: string };
const DB = "hm-offline", STORE = "orders";
let cache: QueuedOrder[] = [];
let syncing = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "clientUuid" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const r = f(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function refreshQueue() {
  try { cache = (await tx("readonly", (s) => s.getAll())) as QueuedOrder[]; } catch { cache = []; }
  emit();
}
export async function enqueue(payload: any) {
  const item: QueuedOrder = { clientUuid: payload.clientUuid, payload, createdAt: new Date().toISOString() };
  try { await tx("readwrite", (s) => s.put(item)); } catch { cache = [...cache, item]; emit(); return; }
  await refreshQueue();
}
export const useQueue = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => cache);

export async function syncQueue(manual = false) {
  if (syncing) return;
  syncing = true;
  let ok = 0;
  try {
    for (const it of cache) {
      try {
        await post("/pos/orders", it.payload, { silent: true });
        await tx("readwrite", (s) => s.delete(it.clientUuid));
        ok++;
      } catch (e) {
        if (e instanceof ApiError && e.code === "network") break;
        if (e instanceof ApiError && e.status === 401) break;
        // lỗi nghiệp vụ: giữ lại, đánh dấu để người dùng xử lý
        const msg = e instanceof ApiError ? e.message : "Lỗi không xác định";
        await tx("readwrite", (s) => s.put({ ...it, error: msg }));
      }
    }
  } finally { syncing = false; await refreshQueue(); }
  if (ok) toast(`Đã đồng bộ ${ok} đơn`, "ok");
  else if (manual && cache.length) toast("Chưa đồng bộ được, sẽ thử lại khi có mạng", "info");
}
export async function discard(uuid: string) { await tx("readwrite", (s) => s.delete(uuid)); await refreshQueue(); }

export function startOfflineSync() {
  refreshQueue().then(() => { if (cache.length && navigator.onLine) syncQueue(); });
  window.addEventListener("online", () => syncQueue());
  setInterval(() => { if (cache.length && navigator.onLine) syncQueue(); }, 60000);
}
