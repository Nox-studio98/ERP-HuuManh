import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { AppError, notFound } from "../lib/errors";
import { guarded, parseBody, unitFactor } from "../services/http";
import { getSettingInt } from "../services/settings";

export const purchasingRoutes = new Hono<AppBindings>();

const DAY = 86400_000;

/**
 * M2-11 gợi ý đặt hàng.
 *  tốc độ bán/ngày = Σ(-stock_moves.sale) trong `reorder.lookback_days` / lookback_days
 *  tồn khả dụng   = Σ(tồn - giữ) các lô active ở vị trí bán được, LOẠI lô hết hạn trước khi hàng mới về (hạn <= hôm nay + lead_time_days)
 *  đề xuất        = max(0, tốc độ × (lead_time + `reorder.cover_days`) − tồn khả dụng), tối thiểu min_order, làm tròn lên đơn vị đặt.
 */
purchasingRoutes.get("/purchasing/suggestions", requirePerm("purchasing.view"), async (c) => {
  const db = c.env.DB;
  const storeId = c.get("user").storeId ?? 1;
  const supplierId = Number(c.req.query("supplierId")) || null;
  const onlyNeeded = c.req.query("onlyNeeded") === "1";
  const lookback = Math.max(1, await getSettingInt(db, "reorder.lookback_days", 14));
  const cover = Math.max(0, await getSettingInt(db, "reorder.cover_days", 3));
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const since = new Date(now - lookback * DAY).toISOString();

  const { results: links } = await db
    .prepare(
      `SELECT ps.*, p.name, p.base_unit, s.name AS supplier_name FROM product_suppliers ps
         JOIN products p ON p.id = ps.product_id AND p.active = 1 AND p.merged_into IS NULL
         JOIN suppliers s ON s.id = ps.supplier_id AND s.active = 1
        ${supplierId ? "WHERE ps.supplier_id = ?" : ""} ORDER BY p.name, ps.preferred DESC, ps.lead_time_days, ps.supplier_id`,
    )
    .bind(...(supplierId ? [supplierId] : []))
    .all<any>();
  const chosen = new Map<number, any>();
  for (const l of links) if (!chosen.has(l.product_id)) chosen.set(l.product_id, l); // đã sắp: ưu tiên NCC preferred

  const items = [];
  for (const l of chosen.values()) {
    const cut = new Date(now + l.lead_time_days * DAY).toISOString();
    const st = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at > ?2) THEN l.qty_on_hand_milli ELSE 0 END), 0) AS onhand,
                COALESCE(SUM(CASE WHEN l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at > ?2) THEN l.qty_reserved_milli ELSE 0 END), 0) AS reserved,
                COALESCE(SUM(CASE WHEN l.status = 'active' AND l.expires_at IS NOT NULL AND l.expires_at <= ?2 THEN l.qty_on_hand_milli ELSE 0 END), 0) AS expiring
           FROM lots l JOIN locations loc ON loc.id = l.location_id
          WHERE l.product_id = ?1 AND loc.store_id = ?3 AND loc.sellable = 1`,
      )
      .bind(l.product_id, cut, storeId)
      .first<{ onhand: number; reserved: number; expiring: number }>();
    const sold = await db
      .prepare(`SELECT COALESCE(-SUM(qty_delta_milli), 0) AS q FROM stock_moves WHERE product_id = ? AND move_type = 'sale' AND at >= ? AND at <= ?`)
      .bind(l.product_id, since, nowIso)
      .first<{ q: number }>();
    const cost = await db
      .prepare(`SELECT unit_cost FROM lots WHERE product_id = ? ORDER BY (supplier_id = ?) DESC, received_at DESC, id DESC LIMIT 1`)
      .bind(l.product_id, l.supplier_id)
      .first<{ unit_cost: number }>();
    const available = st!.onhand - st!.reserved;
    const totalSold = Math.max(0, sold!.q);
    const avgDaily = Math.round(totalSold / lookback);
    const f = l.order_unit ? await unitFactor(db, l.product_id, l.order_unit).catch(() => 1000) : 1000;
    let need = Math.max(0, Math.ceil((totalSold * (l.lead_time_days + cover)) / lookback - available));
    if (need > 0 && l.min_order_milli > need) need = l.min_order_milli;
    const suggested = need > 0 ? Math.ceil(need / f) * f : 0;
    if (onlyNeeded && suggested === 0) continue;
    items.push({
      productId: l.product_id, name: l.name, baseUnit: l.base_unit,
      onHandMilli: st!.onhand, reservedMilli: st!.reserved, expiringMilli: st!.expiring,
      avgDailySalesMilli: avgDaily,
      daysCover: avgDaily > 0 ? Math.round((available / avgDaily) * 10) / 10 : null,
      leadTimeDays: l.lead_time_days, orderUnit: l.order_unit ?? l.base_unit, orderQty: suggested / f, minOrderMilli: l.min_order_milli,
      suggestedMilli: suggested, supplierId: l.supplier_id, supplierName: l.supplier_name, lastCost: cost?.unit_cost ?? null,
    });
  }
  return c.json({ items, nextCursor: null });
});

purchasingRoutes.post("/purchasing/suggestions/to-receipt", requirePerm("purchasing.view", "inventory.write"), async (c) => {
  const db = c.env.DB;
  const u = c.get("user");
  const b = await parseBody(
    c,
    z.object({
      supplierId: z.number().int().positive(),
      locationId: z.number().int().positive().optional(),
      note: z.string().trim().max(500).optional(),
      lines: z
        .array(z.object({ productId: z.number().int().positive(), qtyMilli: z.number().int().positive(), unitCost: z.number().int().min(0).optional() }))
        .min(1)
        .max(100),
    }),
  );
  if (new Set(b.lines.map((l) => l.productId)).size !== b.lines.length) throw new AppError(422, "validation_error", "Mặt hàng bị lặp");
  const sup = await db.prepare(`SELECT id FROM suppliers WHERE id = ? AND active = 1`).bind(b.supplierId).first();
  if (!sup) throw new AppError(422, "invalid_supplier", "Nhà cung cấp không tồn tại");
  const loc = b.locationId
    ? await db.prepare(`SELECT id, store_id FROM locations WHERE id = ?`).bind(b.locationId).first<any>()
    : await db.prepare(`SELECT id, store_id FROM locations WHERE store_id = ? AND sellable = 1 ORDER BY id LIMIT 1`).bind(u.storeId ?? 1).first<any>();
  if (!loc) throw new AppError(422, "invalid_location", "Vị trí kho không tồn tại");

  const lines: { productId: number; unit: string; qty: number; cost: number }[] = [];
  for (const l of b.lines) {
    const p = await db.prepare(`SELECT id, base_unit, active FROM products WHERE id = ?`).bind(l.productId).first<any>();
    if (!p || !p.active) throw new AppError(422, "invalid_product", `Mặt hàng ${l.productId} không tồn tại hoặc đã ngừng`);
    let cost = l.unitCost;
    if (cost == null) {
      cost = (await db.prepare(`SELECT unit_cost FROM lots WHERE product_id = ? ORDER BY (supplier_id = ?) DESC, received_at DESC, id DESC LIMIT 1`).bind(l.productId, b.supplierId).first<{ unit_cost: number }>())?.unit_cost;
    }
    if (cost == null) throw new AppError(422, "missing_cost", `Mặt hàng ${l.productId} chưa có giá nhập, hãy nhập unitCost`);
    lines.push({ productId: l.productId, unit: p.base_unit, qty: l.qtyMilli, cost });
  }
  const code = await nextCode(db, PREFIX.receipt);
  const total = lines.reduce((s, l) => s + Math.round((l.qty * l.cost) / 1000), 0);
  await guarded(() =>
    db.batch([
      db
        .prepare(`INSERT INTO stock_docs(code, type, store_id, location_id, supplier_id, reason, note, total_amount, created_by) VALUES (?, 'receipt', ?, ?, ?, 'Gợi ý đặt hàng', ?, ?, ?)`)
        .bind(code, loc.store_id, loc.id, b.supplierId, b.note ?? null, total, u.id),
      ...lines.map((l) =>
        db
          .prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, unit, doc_qty_milli, qty_milli, unit_cost) VALUES ((SELECT id FROM stock_docs WHERE code = ?), ?, ?, ?, ?, ?)`)
          .bind(code, l.productId, l.unit, l.qty, l.qty, l.cost),
      ),
      auditStmt(c, { action: "stock_doc.create", entity: "stock_doc", entityId: code, after: { source: "purchasing_suggestion", supplierId: b.supplierId, lines } }),
    ]),
  );
  const d = await db.prepare(`SELECT id, code, type, status, store_id, location_id, supplier_id, total_amount FROM stock_docs WHERE code = ?`).bind(code).first<any>();
  return c.json(
    {
      id: d.id, code: d.code, type: d.type, status: d.status, storeId: d.store_id, locationId: d.location_id, supplierId: d.supplier_id, totalAmount: d.total_amount,
      lines: lines.map((l) => ({ productId: l.productId, unit: l.unit, qtyMilli: l.qty, unitCost: l.cost })),
    },
    201,
  );
});

// ---------------------------------------------------------------- NCC ưu tiên theo sản phẩm
const psShape = (r: any) => ({
  productId: r.product_id, productName: r.product_name, supplierId: r.supplier_id, supplierName: r.supplier_name,
  leadTimeDays: r.lead_time_days, orderUnit: r.order_unit, minOrderMilli: r.min_order_milli, preferred: !!r.preferred,
});

purchasingRoutes.get("/product-suppliers", requirePerm("inventory.view"), async (c) => {
  const productId = Number(c.req.query("productId")) || null;
  const { results } = await c.env.DB
    .prepare(
      `SELECT ps.*, p.name AS product_name, s.name AS supplier_name FROM product_suppliers ps JOIN products p ON p.id = ps.product_id JOIN suppliers s ON s.id = ps.supplier_id
        ${productId ? "WHERE ps.product_id = ?" : ""} ORDER BY p.name, ps.preferred DESC, s.name LIMIT 500`,
    )
    .bind(...(productId ? [productId] : []))
    .all<any>();
  return c.json({ items: results.map(psShape), nextCursor: null });
});

purchasingRoutes.put("/product-suppliers", requirePerm("products.write"), async (c) => {
  const db = c.env.DB;
  const productId = Number(c.req.query("productId"));
  if (!productId) throw new AppError(422, "validation_error", "Thiếu productId");
  const p = await db.prepare(`SELECT id FROM products WHERE id = ?`).bind(productId).first();
  if (!p) throw notFound("not_found", "Không tìm thấy mặt hàng");
  const b = await parseBody(
    c,
    z.object({
      items: z
        .array(
          z.object({
            supplierId: z.number().int().positive(),
            leadTimeDays: z.number().int().min(0).max(60).default(1),
            orderUnit: z.string().trim().min(1).max(30).nullish(),
            minOrderMilli: z.number().int().min(0).default(0),
            preferred: z.boolean().default(false),
          }),
        )
        .max(20),
    }),
  );
  if (new Set(b.items.map((i) => i.supplierId)).size !== b.items.length) throw new AppError(422, "validation_error", "NCC bị lặp");
  if (b.items.filter((i) => i.preferred).length > 1) throw new AppError(422, "validation_error", "Chỉ một NCC được đánh dấu ưu tiên");
  for (const i of b.items) {
    if (!(await db.prepare(`SELECT id FROM suppliers WHERE id = ?`).bind(i.supplierId).first())) throw new AppError(422, "invalid_supplier", "Nhà cung cấp không tồn tại");
    if (i.orderUnit) await unitFactor(db, productId, i.orderUnit);
  }
  const before = (await db.prepare(`SELECT * FROM product_suppliers WHERE product_id = ?`).bind(productId).all()).results;
  await guarded(() =>
    db.batch([
      db.prepare(`DELETE FROM product_suppliers WHERE product_id = ?`).bind(productId),
      ...b.items.map((i) =>
        db
          .prepare(`INSERT INTO product_suppliers(product_id, supplier_id, lead_time_days, order_unit, min_order_milli, preferred) VALUES (?,?,?,?,?,?)`)
          .bind(productId, i.supplierId, i.leadTimeDays, i.orderUnit ?? null, i.minOrderMilli, i.preferred ? 1 : 0),
      ),
      auditStmt(c, { action: "product_suppliers.update", entity: "product", entityId: productId, before, after: b.items }),
    ]),
  );
  const { results } = await db
    .prepare(`SELECT ps.*, p.name AS product_name, s.name AS supplier_name FROM product_suppliers ps JOIN products p ON p.id = ps.product_id JOIN suppliers s ON s.id = ps.supplier_id WHERE ps.product_id = ? ORDER BY ps.preferred DESC, s.name`)
    .bind(productId)
    .all<any>();
  return c.json({ items: results.map(psShape), nextCursor: null });
});
