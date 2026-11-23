import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";

const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
window.addEventListener("popstate", notify);
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useLocation = () => useSyncExternalStore(subscribe, () => location.pathname + location.search);

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"]({}, "", to);
  notify();
  window.scrollTo(0, 0);
}

export function Link({ to, children, onClick, ...rest }: { to: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || rest.target === "_blank") return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** Khớp "/san-pham/:slug" → {slug}. Trả null nếu không khớp. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) {
      try { out[a[i].slice(1)] = decodeURIComponent(b[i]); } catch { return null; }
    } else if (a[i] !== b[i]) return null;
  }
  return out;
}

export const useQuery = () => {
  const loc = useLocation();
  return new URLSearchParams(loc.includes("?") ? loc.slice(loc.indexOf("?")) : "");
};

/** document.title + meta description cho từng trang. */
export function usePageMeta(title: string, description?: string) {
  useEffect(() => {
    document.title = title ? `${title} · Hữu Mạnh` : "Hữu Mạnh — Trái cây tươi giao tận nhà";
    let m = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!m) { m = document.createElement("meta"); m.name = "description"; document.head.appendChild(m); }
    m.content = description ?? "Trái cây tươi chọn lọc mỗi ngày, giao nhanh tại TP. Hồ Chí Minh. Hữu Mạnh — tươi ngon, rõ nguồn gốc.";
  }, [title, description]);
}
