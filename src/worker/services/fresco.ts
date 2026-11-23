import { z } from "zod";
import type { Env } from "../env";
import { AppError } from "../lib/errors";
import { nextCode } from "../lib/codes";
import { timingSafeEqual } from "../lib/crypto";
import { planReservations, reserveStmts } from "./reservations";
import { sysAuditStmt, sysAudit } from "./sysaudit";
import { unitFactor } from "./http";

/**
 * Tích hợp sàn Fresco — [Cần xác nhận định dạng thật của Fresco]. Toàn bộ định dạng dưới đây là GIẢ ĐỊNH.
 *
 * Webhook: POST /api/integrations/fresco/webhook  (không cần đăng nhập, xác thực bằng chữ ký)
 *   Headers:
 *     X-Fresco-Timestamp: <epoch giây>           (lệch quá ±300s → 401)
 *     X-Fresco-Signature: sha256=<hex HMAC-SHA256(FRESCO_WEBHOOK_SECRET, rawBody)>
 *   Body JSON:
 *     {
 *       "eventId": "evt_123",                     // khoá idempotency (webhook_events.source='fresco')
 *       "type": "order.created",                  // loại khác được ghi nhận và bỏ qua
 *       "data": {
 *         "orderId": "FR-100234",                 // external_id (unique cùng source)
 *         "createdAt": "2026-11-23T03:00:00Z",
 *         "buyer": { "name": "...", "phone": "...", "address": "..." },
 *         "shippingFee": 15000,                   // VND
 *         "note": "...",
 *         "items": [ { "sku": "FR-CAM-01", "qty": 2, "price": 55000 } ]   // price = giá sàn / 1 đơn vị đã ghép (external_products.unit)
 *       }
 *     }
 * CSV import (cột): order_id, created_at, sku, qty, unit_price, shipping_fee, buyer_name — nhiều dòng cùng order_id = 1 đơn.
 */
export const frescoPayloadSchema = z.object({
  eventId: z.string().min(1).max(100),
  type: z.string().max(60),
  data: z.unknown().optional(),
});

export const frescoOrderSchema = z.object({
  orderId: z.string().min(1).max(100),
  createdAt: z.string().max(40).optional(),
  buyer: z.object({ name: z.string().max(200).optional(), phone: z.string().max(40).optional(), address: z.string().max(500).optional() }).optional(),
  shippingFee: z.number().int().min(0).max(100_000_000).default(0),
  note: z.string().max(500).optional(),
  items: z.array(z.object({ sku: z.string().min(1).max(100), qty: z.number().positive().max(100000), price: z.number().int().min(0).max(1_000_000_000) })).min(1).max(200),
});
export type FrescoOrderData = z.infer<typeof frescoOrderSchema>;

export const FRESCO_SOURCE = "fresco";

export async function isFrescoEnabled(db: D1Database) {
  const r = await db.prepare(`SELECT value FROM settings WHERE key='fresco.enabled'`).first<{ value: string }>();
  return r?.value === "1";
}

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => {
  if (!/^[0-9a-f]*$/i.test(h) || h.length % 2) return null;
  return new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
};

export async function hmacSha256Hex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

/** Kiểm tra chữ ký (so sánh thời gian hằng số) + timestamp ±300s. Ném 401 nếu sai. */
export async function verifyFrescoSignature(secret: string, rawBody: string, sigHeader: string | undefined, tsHeader: string | undefined, nowMs = Date.now()) {
  const bad = () => new AppError(401, "invalid_signature", "Chữ ký webhook không hợp lệ");
  if (!sigHeader || !tsHeader) throw bad();
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) throw new AppError(401, "stale_timestamp", "Timestamp webhook quá lệch");
  const given = unhex(sigHeader.replace(/^sha256=/i, ""));
  if (!given) throw bad();
  const expected = unhex(await hmacSha256Hex(secret, rawBody))!;
  if (!timingSafeEqual(given, expected)) throw bad();
}

export interface FrescoOrderResult {
  orderId: number;
  code: string;
  status: "confirmed" | "new";
  duplicate: boolean;
  warnings: string[];
}

/** Lõi tạo đơn Fresco — dùng chung cho webhook và import CSV. Idempotent theo (external_source, external_id). */
export async function createFrescoOrder(env: Env, data: FrescoOrderData, opts: { userId?: number | null } = {}): Promise<FrescoOrderResult> {
  const db = env.DB;
  const existing = await db.prepare(`SELECT id, code, status FROM orders WHERE external_source=? AND external_id=?`).bind(FRESCO_SOURCE, data.orderId).first<{ id: number; code: string; status: string }>();
  if (existing) return { orderId: existing.id, code: existing.code, status: existing.status === "confirmed" ? "confirmed" : "new", duplicate: true, warnings: [] };

  const storeId = (await db.prepare(`SELECT id FROM stores WHERE active=1 ORDER BY id LIMIT 1`).first<{ id: number }>())?.id ?? 1;
  const warnings: string[] = [];
  const mapped: { productId: number; unit: string; qtyMilli: number; unitPrice: number; lineTotal: number }[] = [];
  const unknown: string[] = [];
  for (const it of data.items) {
    const m = await db.prepare(`SELECT product_id, unit FROM external_products WHERE source=? AND external_sku=?`).bind(FRESCO_SOURCE, it.sku).first<{ product_id: number; unit: string }>();
    if (!m) {
      unknown.push(`${it.sku} x${it.qty} @${it.price}`);
      continue;
    }
    const f = await unitFactor(db, m.product_id, m.unit);
    mapped.push({
      productId: m.product_id,
      unit: m.unit,
      qtyMilli: Math.round(it.qty * f),
      unitPrice: Math.round((it.price * 1000) / f), // giá / đơn vị chính
      lineTotal: Math.round(it.price * it.qty), // giá sàn là nguồn sự thật cho thành tiền
    });
  }
  if (unknown.length) warnings.push(`SKU chưa ghép: ${unknown.join("; ")}`);

  const subtotal = mapped.reduce((s, l) => s + l.lineTotal, 0);
  const buyer = data.buyer ?? {};
  const baseNote = [
    `Đơn sàn Fresco ${data.orderId}${data.createdAt ? ` (${data.createdAt})` : ""}`,
    buyer.name ? `Người mua: ${buyer.name}${buyer.phone ? ` - ${buyer.phone}` : ""}` : null,
    buyer.address ? `Giao đến: ${buyer.address}` : null,
    data.note ? `Ghi chú: ${data.note}` : null,
    unknown.length ? `CẢNH BÁO - ${warnings[0]} (đã loại khỏi tổng tiền, cần ghép SKU rồi xử lý tay)` : null,
  ].filter(Boolean).join(" | ").slice(0, 1000);

  const code = await nextCode(db, "FR");
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO orders(code, channel, kind, store_id, status, subtotal, shipping_fee, total, note, created_by, external_source, external_id)
           VALUES (?,'fresco','sale',?,'new',?,?,?,?,?,?,?)`,
        )
        .bind(code, storeId, subtotal, data.shippingFee, subtotal + data.shippingFee, baseNote, opts.userId ?? null, FRESCO_SOURCE, data.orderId),
      ...mapped.map((l) =>
        db
          .prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, line_total) SELECT id, ?, ?, ?, ?, ? FROM orders WHERE code = ?`)
          .bind(l.productId, l.unit, l.qtyMilli, l.unitPrice, l.lineTotal, code),
      ),
    ]);
  } catch (e) {
    if (String((e as Error)?.message).includes("UNIQUE constraint failed")) {
      const o = await db.prepare(`SELECT id, code, status FROM orders WHERE external_source=? AND external_id=?`).bind(FRESCO_SOURCE, data.orderId).first<{ id: number; code: string; status: string }>();
      if (o) return { orderId: o.id, code: o.code, status: o.status === "confirmed" ? "confirmed" : "new", duplicate: true, warnings: [] };
    }
    throw e;
  }
  const order = (await db.prepare(`SELECT id FROM orders WHERE code=?`).bind(code).first<{ id: number }>())!;

  let status: "confirmed" | "new" = "new";
  if (!unknown.length && mapped.length) {
    const lines = (await db.prepare(`SELECT id, product_id, qty_milli FROM order_lines WHERE order_id=? ORDER BY id`).bind(order.id).all<{ id: number; product_id: number; qty_milli: number }>()).results;
    try {
      const plans = await planReservations(db, lines.map((l) => ({ orderLineId: l.id, productId: l.product_id, qtyMilli: l.qty_milli })), storeId);
      await db.batch([
        ...reserveStmts(db, order.id, plans),
        db.prepare(`UPDATE orders SET status='confirmed' WHERE id=? AND status='new'`).bind(order.id),
        sysAuditStmt(db, { action: "fresco.order_confirmed", entity: "order", entityId: order.id, after: { code, externalId: data.orderId } }, opts.userId ?? null),
      ]);
      status = "confirmed";
    } catch (e) {
      const m = String((e as Error)?.message ?? "");
      if (e instanceof AppError && e.code === "insufficient_stock") warnings.push("Không đủ tồn để giữ hàng, đơn để ở trạng thái mới");
      else if (m.includes("CHECK constraint failed")) warnings.push("Tồn vừa thay đổi, không giữ được hàng, đơn để ở trạng thái mới");
      else throw e;
    }
  }
  if (status === "new") {
    const extra = warnings.filter((w) => !baseNote.includes(w));
    if (extra.length) await db.prepare(`UPDATE orders SET note = substr(note || ' | CẢNH BÁO - ' || ?, 1, 1000) WHERE id=?`).bind(extra.join("; "), order.id).run();
    await sysAudit(db, { action: "fresco.order_warning", entity: "order", entityId: order.id, after: { code, externalId: data.orderId, warnings } }, opts.userId ?? null);
  }
  return { orderId: order.id, code, status, duplicate: false, warnings };
}

// ===== CSV =====
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === "," || ch === ";") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** CSV cột: order_id, created_at, sku, qty, unit_price, shipping_fee, buyer_name → các đơn (gom theo order_id). */
export function csvToFrescoOrders(text: string): { orders: FrescoOrderData[]; errors: string[] } {
  const rows = parseCsv(text);
  const errors: string[] = [];
  if (rows.length < 2) return { orders: [], errors: ["CSV rỗng hoặc thiếu dòng dữ liệu"] };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (n: string) => head.indexOf(n);
  for (const need of ["order_id", "sku", "qty", "unit_price"]) if (idx(need) < 0) return { orders: [], errors: [`Thiếu cột ${need}`] };
  const byId = new Map<string, FrescoOrderData>();
  rows.slice(1).forEach((r, n) => {
    const get = (c: string) => (idx(c) >= 0 ? (r[idx(c)] ?? "").trim() : "");
    const id = get("order_id");
    const qty = Number(get("qty").replace(",", "."));
    const price = Number(get("unit_price"));
    if (!id || !get("sku") || !(qty > 0) || !Number.isInteger(price) || price < 0) {
      errors.push(`Dòng ${n + 2}: dữ liệu không hợp lệ`);
      return;
    }
    let o = byId.get(id);
    if (!o) {
      const ship = Number(get("shipping_fee") || 0);
      o = { orderId: id, createdAt: get("created_at") || undefined, buyer: get("buyer_name") ? { name: get("buyer_name") } : undefined, shippingFee: Number.isInteger(ship) && ship >= 0 ? ship : 0, items: [] };
      byId.set(id, o);
    }
    o.items.push({ sku: get("sku"), qty, price });
  });
  return { orders: [...byId.values()], errors };
}
