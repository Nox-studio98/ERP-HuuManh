import type { Context } from "hono";
import type { ZodTypeAny, z } from "zod";
import { AppError } from "../../../worker/lib/errors";
import type { ShopBindings } from "../env";

export type SCtx = Context<ShopBindings>;

export async function parseBody<S extends ZodTypeAny>(c: SCtx, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(400, "invalid_json", "Nội dung gửi lên không phải JSON hợp lệ");
  }
  return schema.parse(raw);
}

/** Lỗi với mã HTTP ngoài danh sách của AppError (403/503...). */
export const httpError = (status: number, code: string, message: string, details?: unknown) =>
  new AppError(status as 400, code, message, details);

export async function setting(db: D1Database, key: string, fallback = ""): Promise<string> {
  const r = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
  return r ? r.value : fallback;
}

export async function settingNum(db: D1Database, key: string, fallback: number) {
  const v = await setting(db, key, "");
  const n = Number(v);
  return v !== "" && Number.isFinite(n) ? n : fallback;
}

/** Cửa hàng xử lý đơn online (cửa hàng đang hoạt động đầu tiên). */
export async function onlineStoreId(db: D1Database): Promise<number> {
  const s = await db.prepare(`SELECT id FROM stores WHERE active = 1 ORDER BY id LIMIT 1`).first<{ id: number }>();
  return s?.id ?? 1;
}

export const clientIp = (c: SCtx) => c.req.header("cf-connecting-ip") ?? "unknown";

/** Chuẩn hoá SĐT Việt Nam về dạng 0xxxxxxxxx; trả null nếu không hợp lệ. */
export function normalizePhone(raw: string): string | null {
  let s = raw.replace(/[\s.\-()]/g, "");
  if (s.startsWith("+84")) s = "0" + s.slice(3);
  else if (s.startsWith("84") && s.length >= 11) s = "0" + s.slice(2);
  return /^0\d{9,10}$/.test(s) ? s : null;
}

export const maskPhone = (p: string | null | undefined) => {
  if (!p) return "";
  const d = p.replace(/\D/g, "");
  return d.length <= 4 ? d : "*".repeat(d.length - 4) + d.slice(-4);
};

export const last4 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-4);

const UNIT_LABEL: Record<string, string> = { kg: "kg", trai: "trái", khay: "khay", hop: "hộp", thung: "thùng", g: "g" };
export const unitLabel = (u: string) => UNIT_LABEL[u] ?? u;

export const imageUrl = (key: string | null | undefined) => (key ? `/img/${key}` : null);

export function parseImages(json: string | null): string[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a.filter((x) => typeof x === "string" && (x.startsWith("products/") || x.startsWith("cms/"))) : [];
  } catch {
    return [];
  }
}

/** link_url banner: chỉ nhận đường dẫn nội bộ bắt đầu bằng "/" (chống open redirect). */
export const safeLink = (u: string | null) => (u && /^\/(?![\/\\])/.test(u) ? u : null);

export const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);

export function baseUrl(c: SCtx) {
  return (c.env.SHOP_BASE_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
}

/** Job outbox với ref_id lấy theo mã đơn/tài khoản (cùng batch với việc tạo bản ghi). jobs type nằm ngoài union JobType của ERP. */
export function enqueueByRef(db: D1Database, type: string, refType: "order" | "shop_account", refCode: string, payload: unknown) {
  const sub = refType === "order" ? `(SELECT id FROM orders WHERE code = ?2)` : `(SELECT id FROM shop_accounts WHERE email = ?2)`;
  return db
    .prepare(`INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES (?1, '${refType}', ${sub}, ?3)`)
    .bind(type, refCode, JSON.stringify(payload));
}
