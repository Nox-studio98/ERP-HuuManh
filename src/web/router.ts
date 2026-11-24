import { useSyncExternalStore } from "react";
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
window.addEventListener("popstate", notify);
export const usePath = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => location.pathname);
export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"]({}, "", to);
  notify();
  window.scrollTo(0, 0);
}
export const onLink = (e: React.MouseEvent<HTMLAnchorElement>, to: string) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault(); navigate(to);
};
export const useSearch = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => location.search);
/** Đổi query string mà không thêm lịch sử (dùng cho bộ lọc có thể chia sẻ). */
export function setQuery(params: Record<string, string | undefined>) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) { if (v) q.set(k, v); else q.delete(k); }
  const s = q.toString();
  history.replaceState({}, "", location.pathname + (s ? "?" + s : ""));
}
