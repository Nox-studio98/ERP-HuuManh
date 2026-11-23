import { uuid } from "./format";
import { toast } from "./components/toast";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any, public requestId?: string) { super(message); }
}

const VI: Record<string, string> = {
  validation_error: "Dữ liệu chưa hợp lệ, vui lòng kiểm tra lại.",
  insufficient_stock: "Không đủ tồn kho.",
  constraint_violation: "Thao tác vi phạm ràng buộc dữ liệu.",
  version_conflict: "Dữ liệu đã được người khác thay đổi, hãy tải lại.",
  approval_required: "Cần quản lý duyệt.",
  period_locked: "Kỳ kế toán đã khoá sổ.",
  forbidden: "Bạn không có quyền thực hiện thao tác này.",
  not_found: "Không tìm thấy dữ liệu.",
  unauthorized: "Phiên đăng nhập đã hết hạn.",
  network: "Không kết nối được máy chủ. Kiểm tra mạng.",
  rate_limited: "Thao tác quá nhanh, thử lại sau giây lát.",
};
const hasVietnamese = (s: string) => /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s);

export function deviceId() {
  try {
    let id = localStorage.getItem("hm_device");
    if (!id) { id = uuid(); localStorage.setItem("hm_device", id); }
    return id;
  } catch { return "00000000-0000-4000-8000-000000000000"; }
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
export function camelize<T = any>(v: any): T {
  if (Array.isArray(v)) return v.map(camelize) as any;
  if (v && typeof v === "object") {
    const o: any = {};
    for (const k of Object.keys(v)) o[camel(k)] = camelize(v[k]);
    return o;
  }
  return v;
}

type Opt = { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined | null>; silent?: boolean; raw?: boolean };
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };

export async function api<T = any>(path: string, opt: Opt = {}): Promise<T> {
  const base = path.startsWith("/api/") ? path : "/api/v1" + path;
  let url = base;
  if (opt.query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opt.query)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    const s = q.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }
  const method = opt.method ?? (opt.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { "X-Requested-With": "hm-erp", "X-Device-Id": deviceId(), Accept: "application/json" };
  if (opt.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, { method, headers, credentials: "same-origin", body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined });
  } catch {
    const e = new ApiError(0, "network", VI.network);
    if (!opt.silent) toast(e.message, "error");
    throw e;
  }
  const text = await res.text();
  let data: any = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const er = data?.error ?? {};
    const code = er.code ?? (res.status === 401 ? "unauthorized" : res.status === 404 ? "not_found" : "error");
    const msg = er.message && hasVietnamese(er.message) ? er.message : VI[code] ?? er.message ?? `Lỗi ${res.status}`;
    const e = new ApiError(res.status, code, msg, camelize(er.details), data?.requestId);
    if (res.status === 401 && !path.startsWith("/api/auth/login")) onUnauthorized();
    else if (!opt.silent && code !== "approval_required") toast(e.message, "error");
    throw e;
  }
  return (opt.raw ? data : camelize(data)) as T;
}
export const get = <T = any>(p: string, query?: Opt["query"], o: Opt = {}) => api<T>(p, { ...o, query });
export const post = <T = any>(p: string, body: unknown = {}, o: Opt = {}) => api<T>(p, { ...o, method: "POST", body });
export const put = <T = any>(p: string, body: unknown = {}, o: Opt = {}) => api<T>(p, { ...o, method: "PUT", body });
export const items = <T = any>(r: any): T[] => (Array.isArray(r) ? r : r?.items ?? r?.rows ?? []);
