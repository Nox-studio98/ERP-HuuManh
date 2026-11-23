import { useCallback, useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: { render(el: HTMLElement, o: Record<string, unknown>): string; reset(id?: string): void; remove(id?: string): void };
    __hmTsLoad?: Promise<void>;
  }
}

/** Site key công khai: biến build VITE_TURNSTILE_SITE_KEY hoặc <meta name="turnstile-site-key">. Rỗng → không hiện widget (dev: backend bỏ qua). */
export const turnstileKey = (): string => {
  const e = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  if (e) return e;
  return document.querySelector<HTMLMetaElement>('meta[name="turnstile-site-key"]')?.content ?? "";
};

function loadScript(): Promise<void> {
  if (window.__hmTsLoad) return window.__hmTsLoad;
  window.__hmTsLoad = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error("turnstile"));
    document.head.appendChild(s);
  });
  return window.__hmTsLoad;
}

/** Trả về {node, token, reset, required}. `required` = có site key (nút gửi nên chờ token). */
export function useTurnstile() {
  const key = turnstileKey();
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef<string | undefined>(undefined);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const setHost = useCallback((el: HTMLDivElement | null) => {
    hostRef.current = el;
    if (!el || !key) return;
    loadScript()
      .then(() => {
        if (!hostRef.current || idRef.current || !window.turnstile) return;
        idRef.current = window.turnstile.render(hostRef.current, {
          sitekey: key, language: "vi", theme: "auto",
          callback: (t: string) => setToken(t),
          "expired-callback": () => setToken(null),
          "error-callback": () => { setToken(null); setFailed(true); },
        });
      })
      .catch(() => setFailed(true));
  }, [key]);

  useEffect(() => () => { try { if (idRef.current) window.turnstile?.remove(idRef.current); } catch { /* bỏ qua */ } idRef.current = undefined; }, []);

  const reset = useCallback(() => {
    setToken(null);
    try { if (idRef.current) window.turnstile?.reset(idRef.current); } catch { /* bỏ qua */ }
  }, []);

  const node = key ? (
    <div className="turnstile">
      <div ref={setHost} />
      {failed && <p className="hint err">Không tải được ô xác minh chống robot. Hãy tải lại trang hoặc kiểm tra kết nối.</p>}
    </div>
  ) : null;
  return { node, token, reset, required: !!key, ready: !key || !!token };
}
