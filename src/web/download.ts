import { toast } from "./components/toast";
import { deviceId } from "./api";

/** Tải file từ API (cookie phiên). Lỗi (vd. 422 vượt giới hạn) hiện toast tiếng Việt thay vì mở trang JSON. */
export async function downloadFile(path: string, query: Record<string, string | number | undefined | null>, fallbackName: string): Promise<boolean> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  try {
    const res = await fetch(`/api/v1${path}${q.toString() ? "?" + q : ""}`, { credentials: "same-origin", headers: { "X-Requested-With": "hm-erp", "X-Device-Id": deviceId() } });
    if (!res.ok) {
      let msg = `Không xuất được file (lỗi ${res.status})`;
      try { const j: any = await res.json(); if (j?.error?.message) msg = j.error.message; } catch { /* giữ thông báo chung */ }
      toast(msg, "error");
      return false;
    }
    const m = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = m?.[1] ?? fallbackName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    toast("Mất kết nối, không xuất được file", "error");
    return false;
  }
}
