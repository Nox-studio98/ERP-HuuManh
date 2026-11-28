import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm, can } from "../lib/rbac";
import { auditStmt } from "../lib/audit";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { assertStmt, onceStmt } from "../services/guard";
import { nextCode } from "../lib/codes";
import { currentAvgCost, resolvePrice } from "../services/pricing";
import { deviceIdOf, guarded, pageParams, parseBody } from "../services/http";
import { imageUrl } from "../services/online-media";

export const productRoutes = new Hono<AppBindings>();

const unitSchema = z.object({
  unit: z.string().trim().min(1).max(20),
  factorMilli: z.number().int().positive(),
  barcode: z.string().trim().min(1).max(64).nullish(),
});

const productBody = z.object({
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  groupId: z.number().int().positive().nullish(),
  baseUnit: z.string().trim().min(1).max(20),
  sellByWeight: z.boolean().default(false),
  origin: z.string().trim().max(100).nullish(),
  shelfLifeDays: z.number().int().positive().nullish(),
  minStockMilli: z.number().int().min(0).default(0),
  barcode: z.string().trim().min(1).max(64).nullish(),
  active: z.boolean().optional(),
  units: z.array(unitSchema).default([]),
});

function normalizeUnits(baseUnit: string, units: z.infer<typeof unitSchema>[]) {
  const map = new Map<string, z.infer<typeof unitSchema>>();
  for (const u of units) {
    if (map.has(u.unit)) throw new AppError(422, "validation_error", `Đơn vị "${u.unit}" bị lặp`);
    if (u.unit === baseUnit && u.factorMilli !== 1000) {
      throw new AppError(422, "validation_error", "Đơn vị chính phải có hệ số quy đổi = 1000");
    }
    map.set(u.unit, u);
  }
  if (!map.has(baseUnit)) map.set(baseUnit, { unit: baseUnit, factorMilli: 1000, barcode: null });
  return [...map.values()];
}

async function loadUnits(db: D1Database, ids: number[]) {
  if (!ids.length) return new Map<number, any[]>();
  const { results } = await db
    .prepare(
      `SELECT product_id, unit, factor_milli AS factorMilli, barcode FROM product_units
        WHERE product_id IN (${ids.map(() => "?").join(",")}) ORDER BY factor_milli, unit`,
    )
    .bind(...ids)
    .all<any>();
  const m = new Map<number, any[]>();
  for (const r of results) {
    const { product_id, ...rest } = r;
    (m.get(product_id) ?? m.set(product_id, []).get(product_id)!).push(rest);
  }
  return m;
}

function shape(p: any, units: any[]) {
  return {
    id: p.id,
    sku: p.sku,
    barcode: p.barcode,
    name: p.name,
    groupId: p.group_id,
    baseUnit: p.base_unit,
    sellByWeight: !!p.sell_by_weight,
    origin: p.origin,
    shelfLifeDays: p.shelf_life_days,
    minStockMilli: p.min_stock_milli,
    active: !!p.active,
    mergedInto: p.merged_into ?? null,
    version: p.version,
    updatedAt: p.updated_at,
    units,
  };
}

productRoutes.get("/products", requirePerm("inventory.view"), async (c) => {
  const db = c.env.DB;
  const u = c.get("user");
  const { limit, cursor } = pageParams(c);
  const q = c.req.query("q")?.trim();
  const groupId = Number(c.req.query("groupId")) || null;
  const active = c.req.query("active");
  const where: string[] = ["p.merged_into IS NULL", "p.id > ?"];
  const binds: unknown[] = [cursor];
  if (q) {
    where.push("(p.name LIKE ? OR p.sku LIKE ? OR p.barcode = ?)");
    binds.push(`%${q}%`, `%${q}%`, q);
  }
  if (groupId) (where.push("p.group_id = ?"), binds.push(groupId));
  // ids=1,2,3: lấy đúng các mã (màn POS dùng khi sao chép đơn / quét mã) — chỉ thêm bộ lọc, không đổi hành vi cũ
  const ids = (c.req.query("ids") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
  if (c.req.query("ids") != null && !ids.length) where.push("0");
  if (ids.length) (where.push(`p.id IN (${ids.map(() => "?").join(",")})`), binds.push(...ids));
  if (active === "0" || active === "1") (where.push("p.active = ?"), binds.push(Number(active)));
  const { results } = await db
    .prepare(`SELECT p.* FROM products p WHERE ${where.join(" AND ")} ORDER BY p.id LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<any>();
  const rows = results.slice(0, limit);
  const unitMap = await loadUnits(db, rows.map((r) => r.id));
  const now = new Date().toISOString();
  const seePrice = can(u.role, "prices.view_sell");
  const seeCost = can(u.role, "prices.view_cost");
  const items = await Promise.all(
    rows.map(async (p) => {
      const av = await db
        .prepare(
          `SELECT COALESCE(SUM(qty_on_hand_milli - qty_reserved_milli),0) q FROM lots
            WHERE product_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .bind(p.id, now)
        .first<{ q: number }>();
      let firstImage: string | null = null;
      try { firstImage = (JSON.parse(p.images_json ?? "[]") as string[])[0] ?? null; } catch { /* ảnh hỏng → coi như chưa có */ }
      const item: any = { ...shape(p, unitMap.get(p.id) ?? []), availableMilli: av?.q ?? 0, imageUrl: imageUrl(firstImage) };
      if (seePrice) item.price = await resolvePrice(db, p.id, { channel: "pos" }).then((r) => r.unitPrice, () => null);
      if (seeCost) item.avgCost = await currentAvgCost(db, p.id);
      return item;
    }),
  );
  return c.json({ items, nextCursor: results.length > limit ? rows[rows.length - 1].id : null });
});

/** Tra cứu theo mã quét. Luôn ghi scan_events (M2-16). Phải đăng ký trước /products/:id. */
productRoutes.get("/products/lookup", requirePerm("inventory.view"), async (c) => {
  const db = c.env.DB;
  const u = c.get("user");
  const code = c.req.query("code")?.trim();
  if (!code) throw new AppError(422, "validation_error", "Thiếu mã cần tra");
  const context = c.req.query("context") ?? null;
  const now = new Date().toISOString();

  let productId: number | null = null;
  let unit: any = null;
  let lot: any = null;
  const lotRow = await db.prepare(`SELECT * FROM lots WHERE lot_code = ?`).bind(code).first<any>();
  if (lotRow) {
    lot = lotRow;
    productId = lotRow.product_id;
  } else {
    // EC-22: mã đã gộp → trỏ về mã đích
    const pr = await db.prepare(`SELECT COALESCE(merged_into, id) AS id FROM products WHERE barcode = ? OR sku = ?`).bind(code, code).first<{ id: number }>();
    if (pr) productId = pr.id;
    else {
      const un = await db.prepare(`SELECT COALESCE(p.merged_into, pu.product_id) AS product_id, pu.unit, pu.factor_milli FROM product_units pu JOIN products p ON p.id = pu.product_id WHERE pu.barcode = ?`).bind(code).first<any>();
      if (un) {
        productId = un.product_id;
        unit = { unit: un.unit, factorMilli: un.factor_milli };
      }
    }
  }
  const log = (result: string, message: string | null) =>
    db
      .prepare(`INSERT INTO scan_events(user_id, device_id, code, context, result, message) VALUES (?,?,?,?,?,?)`)
      .bind(u.id, deviceIdOf(c), code, context, result, message)
      .run();

  if (productId == null) {
    await log("unknown", "Mã không tồn tại trong hệ thống");
    throw new AppError(404, "unknown_code", "Mã không tồn tại trong hệ thống", { code });
  }
  const p = await db.prepare(`SELECT * FROM products WHERE id = ?`).bind(productId).first<any>();
  const units = (await loadUnits(db, [productId])).get(productId) ?? [];
  if (!unit) unit = units.find((x) => x.unit === p.base_unit) ?? { unit: p.base_unit, factorMilli: 1000 };
  let expired = false;
  if (lot) {
    expired = lot.status === "expired" || (lot.expires_at != null && lot.expires_at <= now);
    await log(expired ? "expired" : "ok", expired ? "Lô đã hết hạn" : null);
  } else await log("ok", null);
  const lotOut = lot
    ? {
        id: lot.id, lotCode: lot.lot_code, locationId: lot.location_id, expiresAt: lot.expires_at, status: lot.status,
        qtyOnHandMilli: lot.qty_on_hand_milli, qtyReservedMilli: lot.qty_reserved_milli, expired,
        ...(can(u.role, "prices.view_cost") ? { unitCost: lot.unit_cost } : {}),
      }
    : undefined;
  return c.json({ product: shape(p, units), unit, lot: lotOut });
});

// ---- Gộp mã trùng (EC-22 / B-20) ----
const mergeBody = z.object({ reason: z.string().trim().min(3).max(300) });

productRoutes.post("/products/:id/merge-into/:targetId", requirePerm("products.write"), async (c) => {
  const db = c.env.DB;
  const u = c.get("user");
  if (u.role !== "owner" && u.role !== "manager") throw forbidden("forbidden", "Chỉ chủ/quản lý được gộp mã hàng");
  const src = Number(c.req.param("id"));
  const tgt = Number(c.req.param("targetId"));
  const b = await parseBody(c, mergeBody);
  if (!src || !tgt || src === tgt) throw new AppError(422, "validation_error", "Hai mã hàng phải khác nhau");
  const [s, t] = await Promise.all([src, tgt].map((id) => db.prepare(`SELECT * FROM products WHERE id = ?`).bind(id).first<any>()));
  if (!s || !t) throw notFound("not_found", "Không tìm thấy mặt hàng");
  if (s.merged_into != null) throw conflict("already_merged", "Mã nguồn đã được gộp vào mã khác");
  if (t.merged_into != null || !t.active) throw conflict("target_invalid", "Mã đích đã bị gộp hoặc đã ngừng kinh doanh");
  if (s.base_unit !== t.base_unit) throw new AppError(422, "units_incompatible", "Hai mã khác đơn vị chính, không thể gộp", { source: s.base_unit, target: t.base_unit });
  const su = (await loadUnits(db, [src])).get(src) ?? [];
  const tu = (await loadUnits(db, [tgt])).get(tgt) ?? [];
  for (const x of su) {
    const y = tu.find((z) => z.unit === x.unit);
    if (y && y.factorMilli !== x.factorMilli) throw new AppError(422, "units_incompatible", `Đơn vị "${x.unit}" quy đổi khác nhau giữa hai mã`, { unit: x.unit, source: x.factorMilli, target: y.factorMilli });
  }
  const now = new Date().toISOString();
  const cnt = async (sql: string) => (await db.prepare(sql).bind(src).first<{ n: number }>())?.n ?? 0;
  const moved = {
    lots: await cnt(`SELECT COUNT(*) n FROM lots WHERE product_id = ?`),
    prices: await cnt(`SELECT COUNT(*) n FROM prices WHERE product_id = ?`),
    externalProducts: await cnt(`SELECT COUNT(*) n FROM external_products WHERE product_id = ?`),
    openOrderLines: await cnt(`SELECT COUNT(*) n FROM order_lines WHERE product_id = ? AND order_id IN (SELECT id FROM orders WHERE status IN ('draft','new','confirmed','preparing','shipping','awaiting_payment'))`),
  };
  const openStatuses = `'draft','new','confirmed','preparing','shipping','awaiting_payment','delivery_failed'`;
  // K-KHO3: PO đang chạy (chưa nhận đủ/đóng/huỷ) + phần thiếu SO đang mở + liên kết NCC chuyển sang mã đích
  const poLive = `SELECT id FROM purchase_orders WHERE status NOT IN ('received','closed','cancelled','rejected')`;
  const poClash = await db
    .prepare(
      `SELECT po.code AS code FROM purchase_order_lines a JOIN purchase_order_lines b ON b.po_id = a.po_id AND b.product_id = ?2
         JOIN purchase_orders po ON po.id = a.po_id
        WHERE a.product_id = ?1 AND po.status NOT IN ('received','closed','cancelled','rejected')`,
    )
    .bind(src, tgt)
    .all<{ code: string }>();
  if (poClash.results.length)
    throw conflict("merge_po_conflict", `Đơn đặt NCC ${poClash.results.map((x) => x.code).join(", ")} có cả hai mã: sửa/huỷ dòng của mã nguồn rồi gộp lại`, { pos: poClash.results.map((x) => x.code) });
  moved.openOrderLines = await cnt(`SELECT COUNT(*) n FROM order_lines WHERE product_id = ? AND order_id IN (SELECT id FROM orders WHERE status IN (${openStatuses}))`);
  (moved as Record<string, number>).poLines = await cnt(`SELECT COUNT(*) n FROM purchase_order_lines WHERE product_id = ? AND po_id IN (${poLive})`);
  (moved as Record<string, number>).shortages = await cnt(`SELECT COUNT(*) n FROM so_shortages WHERE product_id = ? AND status = 'open'`);
  (moved as Record<string, number>).suppliers = await cnt(`SELECT COUNT(*) n FROM product_suppliers WHERE product_id = ?`);
  await guarded(() =>
    db.batch([
      assertStmt(db, "product.merge", `SELECT (SELECT merged_into IS NULL FROM products WHERE id = ?) AND (SELECT merged_into IS NULL AND active = 1 FROM products WHERE id = ?)`, [src, tgt]),
      onceStmt(db, "product.merge", src),
      // đơn vị quy đổi/mã vạch đơn vị chưa có ở mã đích → chuyển sang mã đích
      db.prepare(`UPDATE product_units SET product_id = ?2 WHERE product_id = ?1 AND unit NOT IN (SELECT unit FROM product_units WHERE product_id = ?2)`).bind(src, tgt),
      // lô + giữ tồn (reservations trỏ theo lô nên đi theo lô)
      db.prepare(`UPDATE lots SET product_id = ?2 WHERE product_id = ?1`).bind(src, tgt),
      // giá: bảng giá đã có giá ở mã đích thì dòng của mã nguồn bị thay thế/từ chối, còn lại chuyển sang mã đích
      db.prepare(`UPDATE prices SET status = 'superseded', effective_to = COALESCE(effective_to, ?3) WHERE product_id = ?1 AND status = 'active' AND price_list_id IN (SELECT price_list_id FROM prices WHERE product_id = ?2 AND status = 'active')`).bind(src, tgt, now),
      db.prepare(`UPDATE prices SET status = 'rejected' WHERE product_id = ?1 AND status = 'pending' AND price_list_id IN (SELECT price_list_id FROM prices WHERE product_id = ?2 AND status = 'active')`).bind(src, tgt),
      db.prepare(`UPDATE prices SET product_id = ?2 WHERE product_id = ?1`).bind(src, tgt),
      db.prepare(`UPDATE external_products SET product_id = ?2 WHERE product_id = ?1`).bind(src, tgt),
      db.prepare(`UPDATE order_lines SET product_id = ?2 WHERE product_id = ?1 AND order_id IN (SELECT id FROM orders WHERE status IN (${openStatuses}))`).bind(src, tgt),
      db.prepare(`UPDATE stock_doc_lines SET product_id = ?2 WHERE product_id = ?1 AND doc_id IN (SELECT id FROM stock_docs WHERE status IN ('draft','pending_approval'))`).bind(src, tgt),
      db.prepare(`UPDATE quote_lines SET product_id = ?2 WHERE product_id = ?1 AND quote_id IN (SELECT id FROM quotes WHERE status IN ('draft','pending_approval','sent'))`).bind(src, tgt),
      db.prepare(`UPDATE promotion_items SET product_id = ?2 WHERE product_id = ?1`).bind(src, tgt),
      // đơn sỉ lặp lưu dòng hàng dạng JSON → đổi productId nguồn sang đích
      db.prepare(
        `UPDATE recurring_orders SET lines_json = (SELECT json_group_array(CASE WHEN json_extract(value, '$.productId') = ?1 THEN json_set(value, '$.productId', ?2) ELSE json(value) END) FROM json_each(lines_json))
          WHERE EXISTS (SELECT 1 FROM json_each(lines_json) WHERE json_extract(value, '$.productId') = ?1)`,
      ).bind(src, tgt),
      db.prepare(`UPDATE OR IGNORE bundle_components SET bundle_product_id = ?2 WHERE bundle_product_id = ?1`).bind(src, tgt),
      db.prepare(`UPDATE OR IGNORE bundle_components SET component_product_id = ?2 WHERE component_product_id = ?1`).bind(src, tgt),
      db.prepare(`UPDATE OR IGNORE product_matches SET product_id = ?2 WHERE product_id = ?1`).bind(src, tgt),
      db.prepare(`UPDATE OR IGNORE product_suppliers SET product_id = ?2 WHERE product_id = ?1`).bind(src, tgt),
      db.prepare(`DELETE FROM product_suppliers WHERE product_id = ?1`).bind(src), // liên kết trùng với mã đích: giữ cấu hình của mã đích
      assertStmt(db, "product.merge.po", `SELECT NOT EXISTS (SELECT 1 FROM purchase_order_lines a JOIN purchase_order_lines b ON b.po_id = a.po_id AND b.product_id = ? JOIN purchase_orders po ON po.id = a.po_id WHERE a.product_id = ? AND po.status NOT IN ('received','closed','cancelled','rejected'))`, [tgt, src]),
      db.prepare(`UPDATE purchase_order_lines SET product_id = ?2 WHERE product_id = ?1 AND po_id IN (${poLive})`).bind(src, tgt),
      db.prepare(`UPDATE so_shortages SET product_id = ?2 WHERE product_id = ?1 AND status = 'open'`).bind(src, tgt),
      db.prepare(`UPDATE products SET merged_into = ?2, active = 0, published_online = 0, version = version + 1, updated_at = ?3 WHERE id = ?1 AND merged_into IS NULL`).bind(src, tgt, now),
      db.prepare(`INSERT INTO product_merges(source_id, target_id, reason, moved_json, merged_by) VALUES (?,?,?,?,?)`).bind(src, tgt, b.reason, JSON.stringify(moved), u.id),
      auditStmt(c, { action: "product.merge", entity: "product", entityId: src, before: { sku: s.sku, name: s.name }, after: { mergedInto: tgt, targetSku: t.sku, moved }, reason: b.reason }),
    ]),
  );
  const row = await db.prepare(`SELECT * FROM products WHERE id = ?`).bind(tgt).first<any>();
  return c.json({ source: src, target: shape(row, (await loadUnits(db, [tgt])).get(tgt) ?? []), moved });
});

productRoutes.get("/products/:id", requirePerm("inventory.view"), async (c) => {
  const db = c.env.DB;
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  const p = await db.prepare(`SELECT * FROM products WHERE id = ?`).bind(id).first<any>();
  if (!p) throw notFound();
  const units = (await loadUnits(db, [id])).get(id) ?? [];
  const { results: lots } = await db
    .prepare(
      `SELECT id, lot_code AS lotCode, location_id AS locationId, supplier_id AS supplierId, received_at AS receivedAt,
              expires_at AS expiresAt, unit_cost AS unitCost, qty_in_milli AS qtyInMilli, qty_on_hand_milli AS qtyOnHandMilli,
              qty_reserved_milli AS qtyReservedMilli, status
         FROM lots WHERE product_id = ? AND qty_on_hand_milli > 0 ORDER BY (expires_at IS NULL), expires_at, id`,
    )
    .bind(id)
    .all<any>();
  const seeCost = can(u.role, "prices.view_cost");
  const out: any = { ...shape(p, units), lots: seeCost ? lots : lots.map(({ unitCost, ...r }) => r) };
  if (can(u.role, "prices.view_sell")) out.price = await resolvePrice(db, id, { channel: "pos" }).then((r) => r.unitPrice, () => null);
  if (seeCost) out.avgCost = await currentAvgCost(db, id);
  return c.json(out);
});

productRoutes.post("/products", requirePerm("products.write"), async (c) => {
  const db = c.env.DB;
  const b = await parseBody(c, productBody);
  const units = normalizeUnits(b.baseUnit, b.units);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO products(sku, barcode, name, group_id, base_unit, sell_by_weight, origin, shelf_life_days, min_stock_milli, active)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(b.sku, b.barcode ?? null, b.name, b.groupId ?? null, b.baseUnit, b.sellByWeight ? 1 : 0, b.origin ?? null, b.shelfLifeDays ?? null, b.minStockMilli, b.active === false ? 0 : 1),
    // M2-15: không có barcode → sinh mã nội bộ HMP + id (khớp internalBarcode('P', id))
    db.prepare(`UPDATE products SET barcode = 'HMP' || substr('00000000' || id, -8) WHERE sku = ? AND barcode IS NULL`).bind(b.sku),
    ...units.map((u) =>
      db
        .prepare(`INSERT INTO product_units(product_id, unit, factor_milli, barcode) SELECT id, ?, ?, ? FROM products WHERE sku = ?`)
        .bind(u.unit, u.factorMilli, u.barcode ?? null, b.sku),
    ),
    auditStmt(c, { action: "product.create", entity: "product", entityId: b.sku, after: { ...b, units } }),
  ];
  await guarded(() => db.batch(stmts), "SKU hoặc mã vạch đã tồn tại");
  const row = await db.prepare(`SELECT * FROM products WHERE sku = ?`).bind(b.sku).first<any>();
  const us = (await loadUnits(db, [row.id])).get(row.id) ?? [];
  return c.json(shape(row, us), 201);
});

productRoutes.put("/products/:id", requirePerm("products.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, productBody.extend({ version: z.number().int().positive() }));
  const cur = await db.prepare(`SELECT * FROM products WHERE id = ?`).bind(id).first<any>();
  if (!cur) throw notFound();
  if (cur.version !== b.version) throw conflict("version_conflict", "Mặt hàng đã được người khác sửa, hãy tải lại", { currentVersion: cur.version });
  const units = normalizeUnits(b.baseUnit, b.units);
  if (b.baseUnit !== cur.base_unit) {
    const used = await db.prepare(`SELECT 1 FROM lots WHERE product_id = ? LIMIT 1`).bind(id).first();
    if (used) throw conflict("base_unit_locked", "Không đổi đơn vị chính khi mặt hàng đã có lô tồn kho");
  }
  const newVer = b.version + 1;
  const guard = `EXISTS (SELECT 1 FROM products WHERE id = ? AND version = ?)`;
  const before = shape(cur, (await loadUnits(db, [id])).get(id) ?? []);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE products SET sku=?, barcode=COALESCE(?, barcode), name=?, group_id=?, base_unit=?, sell_by_weight=?, origin=?,
                shelf_life_days=?, min_stock_milli=?, active=?, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND version=?`,
      )
      .bind(b.sku, b.barcode ?? null, b.name, b.groupId ?? null, b.baseUnit, b.sellByWeight ? 1 : 0, b.origin ?? null, b.shelfLifeDays ?? null, b.minStockMilli, b.active === false ? 0 : 1, id, b.version),
    db
      .prepare(`DELETE FROM product_units WHERE product_id = ? AND unit NOT IN (${units.map(() => "?").join(",")}) AND ${guard}`)
      .bind(id, ...units.map((u) => u.unit), id, newVer),
    ...units.map((u) =>
      db
        .prepare(
          `INSERT INTO product_units(product_id, unit, factor_milli, barcode)
           SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM products WHERE id = ?1 AND version = ?5)
           ON CONFLICT(product_id, unit) DO UPDATE SET factor_milli = excluded.factor_milli, barcode = excluded.barcode`,
        )
        .bind(id, u.unit, u.factorMilli, u.barcode ?? null, newVer),
    ),
    auditStmt(c, { action: "product.update", entity: "product", entityId: id, before, after: { ...b, units, version: newVer } }),
  ];
  await guarded(() => db.batch(stmts), "SKU hoặc mã vạch đã tồn tại");
  const row = await db.prepare(`SELECT * FROM products WHERE id = ?`).bind(id).first<any>();
  if (row.version !== newVer) throw conflict("version_conflict", "Mặt hàng đã được người khác sửa, hãy tải lại");
  return c.json(shape(row, (await loadUnits(db, [id])).get(id) ?? []));
});

// ---- Nhóm hàng ----
productRoutes.get("/product-groups", requirePerm("inventory.view"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, name, target_margin_bp AS targetMarginBp FROM product_groups ORDER BY name`).all();
  return c.json({ items: results, nextCursor: null });
});
productRoutes.post("/product-groups", requirePerm("products.write"), async (c) => {
  const b = await parseBody(c, z.object({ name: z.string().trim().min(1).max(100), targetMarginBp: z.number().int().min(0).max(100000).default(3000) }));
  const db = c.env.DB;
  await guarded(
    () =>
      db.batch([
        db.prepare(`INSERT INTO product_groups(name, target_margin_bp) VALUES (?,?)`).bind(b.name, b.targetMarginBp),
        auditStmt(c, { action: "product_group.create", entity: "product_group", entityId: b.name, after: b }),
      ]),
    "Tên nhóm hàng đã tồn tại",
  );
  const row = await db.prepare(`SELECT id, name, target_margin_bp AS targetMarginBp FROM product_groups WHERE name = ?`).bind(b.name).first();
  return c.json(row, 201);
});

// ---- Nhà cung cấp ----
const supplierBody = z.object({
  code: z.string().trim().min(1).max(30).optional(),
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(30).nullish(),
  address: z.string().trim().max(300).nullish(),
  taxCode: z.string().trim().max(30).nullish(),
  paymentTermsDays: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});
const supplierSel = `SELECT id, code, name, phone, address, tax_code AS taxCode, payment_terms_days AS paymentTermsDays, active FROM suppliers`;

productRoutes.get("/suppliers", requirePerm("inventory.view"), async (c) => {
  const q = c.req.query("q")?.trim();
  const { limit, cursor } = pageParams(c);
  const binds: unknown[] = [cursor];
  if (q) binds.push(`%${q}%`, `%${q}%`);
  const { results } = await c.env.DB
    .prepare(`${supplierSel} WHERE id > ? ${q ? "AND (name LIKE ? OR code LIKE ?)" : ""} ORDER BY id LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<any>();
  return c.json({ items: results.slice(0, limit).map((r) => ({ ...r, active: !!r.active })), nextCursor: results.length > limit ? results[limit - 1].id : null });
});
productRoutes.post("/suppliers", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const b = await parseBody(c, supplierBody);
  const code = b.code ?? (await nextCode(db, "NCC"));
  await guarded(
    () =>
      db.batch([
        db
          .prepare(`INSERT INTO suppliers(code, name, phone, address, tax_code, payment_terms_days, active) VALUES (?,?,?,?,?,?,?)`)
          .bind(code, b.name, b.phone ?? null, b.address ?? null, b.taxCode ?? null, b.paymentTermsDays, b.active ? 1 : 0),
        auditStmt(c, { action: "supplier.create", entity: "supplier", entityId: code, after: { ...b, code } }),
      ]),
    "Mã nhà cung cấp đã tồn tại",
  );
  const row = await db.prepare(`${supplierSel} WHERE code = ?`).bind(code).first<any>();
  return c.json({ ...row, active: !!row.active }, 201);
});
productRoutes.put("/suppliers/:id", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, supplierBody.omit({ code: true }));
  const cur = await db.prepare(`${supplierSel} WHERE id = ?`).bind(id).first<any>();
  if (!cur) throw notFound();
  await db.batch([
    db
      .prepare(`UPDATE suppliers SET name=?, phone=?, address=?, tax_code=?, payment_terms_days=?, active=? WHERE id=?`)
      .bind(b.name, b.phone ?? null, b.address ?? null, b.taxCode ?? null, b.paymentTermsDays, b.active ? 1 : 0, id),
    auditStmt(c, { action: "supplier.update", entity: "supplier", entityId: id, before: cur, after: b }),
  ]);
  const row = await db.prepare(`${supplierSel} WHERE id = ?`).bind(id).first<any>();
  return c.json({ ...row, active: !!row.active });
});

productRoutes.get("/locations", requirePerm("inventory.view"), async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT id, store_id AS storeId, code, name, sellable FROM locations ORDER BY id`)
    .all<any>();
  return c.json({ items: results.map((r) => ({ ...r, sellable: !!r.sellable })), nextCursor: null });
});
