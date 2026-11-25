import { useEffect, useState } from "react";
import { del, get, post } from "../api";
import { toast } from "./toast";

const b64uToBytes = (s: string) => { const p = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4); const r = atob(p); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
const bufToB64u = (b: ArrayBuffer | null) => { if (!b) return ""; let s = ""; new Uint8Array(b).forEach((x) => (s += String.fromCharCode(x))); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };

/** Bật/tắt thông báo đẩy "Đơn online mới" cho nhân viên. Ẩn khi trình duyệt không hỗ trợ hoặc server chưa có khoá VAPID. */
export function PushToggle() {
  const [key, setKey] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  useEffect(() => {
    if (!supported) return;
    get("/push/vapid-public-key", undefined, { silent: true }).then((r) => setKey(r.publicKey ?? null)).catch(() => {});
    navigator.serviceWorker.getRegistration().then((reg) => reg?.pushManager.getSubscription()).then((s) => setOn(!!s)).catch(() => {});
  }, [supported]);
  if (!supported || !key) return null;
  const toggle = async (v: boolean) => {
    setBusy(true);
    try {
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      if (v) {
        if ((await Notification.requestPermission()) !== "granted") { toast("Trình duyệt đã chặn thông báo", "error"); return; }
        const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) }));
        await post("/me/push-subscriptions", { endpoint: sub.endpoint, keys: { p256dh: bufToB64u(sub.getKey("p256dh")), auth: bufToB64u(sub.getKey("auth")) } });
        setOn(true); toast("Đã bật thông báo đẩy", "ok");
      } else {
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await del("/me/push-subscriptions", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
        setOn(false); toast("Đã tắt thông báo", "ok");
      }
    } catch { toast("Không bật được thông báo trên thiết bị này", "error"); } finally { setBusy(false); }
  };
  return (
    <label className="row" style={{ minHeight: 44, gap: 8 }}>
      <input type="checkbox" style={{ width: 22, height: 22 }} checked={on} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
      <span>Thông báo đẩy (đơn mới, yêu cầu duyệt)</span>
    </label>
  );
}
