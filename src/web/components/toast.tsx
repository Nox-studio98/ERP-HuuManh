import { useSyncExternalStore } from "react";
type T = { id: number; msg: string; kind: "info" | "ok" | "error" };
let list: T[] = [];
let seq = 1;
const subs = new Set<() => void>();
export function toast(msg: string, kind: T["kind"] = "info") {
  const id = seq++;
  list = [...list.slice(-3), { id, msg, kind }];
  subs.forEach((f) => f());
  setTimeout(() => dismiss(id), kind === "error" ? 6000 : 3500);
}
function dismiss(id: number) { list = list.filter((t) => t.id !== id); subs.forEach((f) => f()); }
export function Toaster() {
  const l = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => list);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false" role="status">
      {l.map((t) => (
        <div key={t.id} className={"toast " + t.kind} role={t.kind === "error" ? "alert" : undefined}>
          <span className="grow">{t.msg}</span>
          <button className="btn ghost sm" style={{ color: "inherit", borderColor: "currentColor" }} onClick={() => dismiss(t.id)} aria-label="Đóng thông báo">✕</button>
        </div>
      ))}
    </div>
  );
}
