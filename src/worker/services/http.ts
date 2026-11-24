import type { Context } from "hono";
import type { ZodTypeAny, z } from "zod";
import type { AppBindings } from "../env";
import { AppError, conflict } from "../lib/errors";
import { toMilli } from "../lib/money";
import { vnDayRangeUtc } from "../lib/time";

/** Đọc + kiểm tra JSON body bằng zod. */
export async function parseBody<S extends ZodTypeAny>(c: Context<AppBindings>, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(400, "invalid_json", "Nội dung gửi lên không phải JSON hợp lệ");
  }
  return schema.parse(raw);
}

export function parseQuery<S extends ZodTypeAny>(c: Context<AppBindings>, schema: S): z.infer<S> {
  return schema.parse(c.req.query());
}

export function pageParams(c: Context<AppBindings>) {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const cursor = Number(c.req.query("cursor") ?? 0) || 0;
  return { limit, cursor };
}

/** Lọc khoảng ngày VN `from`/`to` (YYYY-MM-DD, gồm cả hai đầu, tối đa 366 ngày) trên cột thời gian UTC `col`. Thêm điều kiện vào conds/params. */
export function addVnRange(q: Record<string, string | undefined>, col: string, conds: string[], params: unknown[]) {
  if (!q.from && !q.to) return;
  const ok = (v: string, n: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))) throw new AppError(422, "validation_error", `${n} phải có dạng YYYY-MM-DD`);
    return v;
  };
  const from = ok((q.from ?? q.to)!, "from"), to = ok((q.to ?? q.from)!, "to");
  if (to < from) throw new AppError(422, "validation_error", "to phải sau hoặc bằng from");
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 366) throw new AppError(422, "validation_error", "Khoảng ngày tối đa 366 ngày");
  const a = vnDayRangeUtc(from), b = vnDayRangeUtc(to);
  conds.push(`${col} >= ? AND ${col} < ?`);
  params.push(a.from, b.to);
}

/** Escape LIKE (dùng với ESCAPE '\\'). */
export const likeOf = (s: string) => `%${s.trim().replace(/[\\%_]/g, (m) => "\\" + m)}%`;

export async function getSetting(db: D1Database, key: string, fallback: number) {
  const r = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
  const n = Number(r?.value);
  return Number.isFinite(n) && r ? n : fallback;
}

export const deviceIdOf = (c: Context<AppBindings>) => c.req.header("x-device-id") ?? c.get("user")?.deviceId ?? null;

/** Bắt lỗi ràng buộc SQLite thành lỗi nghiệp vụ dễ hiểu. */
export async function guarded<T>(fn: () => Promise<T>, dupMsg = "Dữ liệu bị trùng (mã đã tồn tại)"): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const m = String((e as Error)?.message ?? "");
    if (m.includes("UNIQUE constraint failed")) throw conflict("duplicate", dupMsg);
    if (m.includes("FOREIGN KEY constraint failed")) throw new AppError(422, "invalid_reference", "Tham chiếu không tồn tại");
    throw e;
  }
}

/** Hệ số quy đổi của một đơn vị (đơn vị chính = 1000). */
export async function unitFactor(db: D1Database, productId: number, unit: string): Promise<number> {
  const r = await db
    .prepare(
      `SELECT pu.factor_milli f FROM product_units pu WHERE pu.product_id = ?1 AND pu.unit = ?2
       UNION ALL SELECT 1000 FROM products WHERE id = ?1 AND base_unit = ?2 LIMIT 1`,
    )
    .bind(productId, unit)
    .first<{ f: number }>();
  if (!r) throw new AppError(422, "unknown_unit", `Đơn vị "${unit}" không có trong danh mục của mặt hàng`);
  return r.f;
}

export const qtyToMilli = (qty: number, factor: number) => toMilli(qty, factor);

export const isExpired = (lot: { status: string; expires_at: string | null }, at = new Date().toISOString()) =>
  lot.status === "expired" || (lot.expires_at != null && lot.expires_at <= at);
