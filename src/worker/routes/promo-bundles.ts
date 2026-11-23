import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode } from "../lib/codes";
import { parseBody, unitFactor, guarded } from "../services/http";
import { assemblyStatements, planAssembly } from "../services/bundle-assembly";

export const bundleRoutes = new Hono<AppBindings>();
const isCheckFail = (e: unknown) => /CHECK constraint failed/i.test(String((e as Error)?.message ?? ""));

async function product(db: D1Database, id: number) {
  const p = await db.prepare(`SELECT id, sku, name, base_unit, active FROM products WHERE id = ?`).bind(id).first<any>();
  if (!p) throw notFound("product_not_found", "Không tìm thấy mặt hàng");
  return p;
}

async function componentsView(db: D1Database, bundleProductId: number) {
  const rows = (
    await db
      .prepare(
        `SELECT bc.component_product_id AS product_id, bc.qty_milli, p.name, p.sku, p.base_unit
           FROM bundle_components bc JOIN products p ON p.id = bc.component_product_id WHERE bc.bundle_product_id = ? ORDER BY bc.component_product_id`,
      )
      .bind(bundleProductId)
      .all<any>()
  ).results;
  return rows.map((r) => ({ productId: r.product_id, name: r.name, sku: r.sku, baseUnit: r.base_unit, qtyMilli: r.qty_milli, qty: r.qty_milli / 1000 }));
}

bundleRoutes.get("/bundles/:productId/components", requirePerm("products.write"), async (c) => {
  const id = Number(c.req.param("productId"));
  const db = c.env.DB;
  const p = await product(db, id);
  return c.json({ bundleProductId: id, name: p.name, components: await componentsView(db, id) });
});

bundleRoutes.put("/bundles/:productId/components", requirePerm("products.write"), async (c) => {
  const id = Number(c.req.param("productId"));
  const db = c.env.DB;
  const b = await parseBody(c, z.object({
    components: z.array(z.object({
      productId: z.number().int().positive(),
      qty: z.number().positive().max(100000).optional(), // theo đơn vị chính của thành phần, cho MỖI giỏ
      qtyMilli: z.number().int().positive().optional(),
    }).refine((x) => (x.qty != null) !== (x.qtyMilli != null), { message: "Cần đúng một trong qty / qtyMilli" })).max(50),
  }));
  await product(db, id);
  const seen = new Set<number>();
  for (const cmp of b.components) {
    if (cmp.productId === id) throw new AppError(422, "invalid_component", "Giỏ quà không thể chứa chính nó");
    if (seen.has(cmp.productId)) throw new AppError(422, "duplicate_component", "Thành phần bị trùng", { productId: cmp.productId });
    seen.add(cmp.productId);
    const p = await product(db, cmp.productId);
    if (!p.active) throw new AppError(422, "product_not_found", "Thành phần đã ngừng bán", { productId: cmp.productId });
  }
  await guarded(() =>
    db.batch([
      db.prepare(`DELETE FROM bundle_components WHERE bundle_product_id = ?`).bind(id),
      ...b.components.map((x) =>
        db.prepare(`INSERT INTO bundle_components(bundle_product_id, component_product_id, qty_milli) VALUES (?,?,?)`).bind(id, x.productId, x.qtyMilli ?? Math.round(x.qty! * 1000)),
      ),
      auditStmt(c, { action: "bundle.set_components", entity: "product", entityId: id, after: { components: b.components } }),
    ]),
  );
  return c.json({ bundleProductId: id, components: await componentsView(db, id) });
});

const assemblyView = async (db: D1Database, id: number) => {
  const a = await db
    .prepare(
      `SELECT a.*, p.name AS product_name, l.lot_code, l.unit_cost AS lot_unit_cost, l.qty_on_hand_milli
         FROM assembly_orders a JOIN products p ON p.id = a.bundle_product_id LEFT JOIN lots l ON l.id = a.lot_id WHERE a.id = ?`,
    )
    .bind(id)
    .first<any>();
  if (!a) throw notFound("assembly_not_found", "Không tìm thấy lệnh đóng giỏ");
  const used = (
    await db
      .prepare(
        `SELECT m.product_id, p.name, m.lot_id, m.qty_delta_milli, m.unit_cost FROM stock_moves m JOIN products p ON p.id = m.product_id
          WHERE m.ref_type='assembly_order' AND m.ref_id = ? AND m.move_type='assemble_out' ORDER BY m.id`,
      )
      .bind(id)
      .all<any>()
  ).results;
  return {
    id: a.id, code: a.code, status: a.status, bundleProductId: a.bundle_product_id, productName: a.product_name,
    qtyMilli: a.qty_milli, extraCost: a.extra_cost, expiresAt: a.expires_at, lotId: a.lot_id, lotCode: a.lot_code,
    unitCost: a.lot_unit_cost, createdAt: a.created_at, note: a.note,
    components: used.map((u) => ({ productId: u.product_id, name: u.name, lotId: u.lot_id, qtyMilli: -u.qty_delta_milli, unitCost: u.unit_cost })),
  };
};

bundleRoutes.get("/assembly-orders", requirePerm("inventory.view"), async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT a.id, a.code, a.status, a.qty_milli, a.extra_cost, a.created_at, p.name AS product_name FROM assembly_orders a JOIN products p ON p.id = a.bundle_product_id ORDER BY a.id DESC LIMIT 100`)
    .all<any>();
  return c.json({ items: results.map((a) => ({ id: a.id, code: a.code, status: a.status, qtyMilli: a.qty_milli, extraCost: a.extra_cost, productName: a.product_name, createdAt: a.created_at })) });
});

bundleRoutes.get("/assembly-orders/:id", requirePerm("inventory.view"), async (c) => c.json(await assemblyView(c.env.DB, Number(c.req.param("id")))));

bundleRoutes.post("/assembly-orders", requirePerm("inventory.write"), async (c) => {
  const b = await parseBody(c, z.object({
    bundleProductId: z.number().int().positive(),
    qty: z.number().positive().max(100000),
    unit: z.string().min(1).max(20),
    extraCost: z.number().int().min(0).default(0),
    expiresAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expiresAt không hợp lệ").optional(),
    note: z.string().max(300).optional(),
  }));
  const db = c.env.DB;
  const user = c.get("user");
  const p = await product(db, b.bundleProductId);
  if (!p.active) throw new AppError(422, "product_not_found", "Mặt hàng đã ngừng bán");
  const factor = await unitFactor(db, b.bundleProductId, b.unit);
  const qtyMilli = Math.round(b.qty * factor);
  if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ");
  const storeId = user.storeId ?? (await db.prepare(`SELECT id FROM stores WHERE active=1 ORDER BY id LIMIT 1`).first<{ id: number }>())?.id ?? 1;
  const loc = await db.prepare(`SELECT id FROM locations WHERE store_id = ? AND sellable = 1 ORDER BY id LIMIT 1`).bind(storeId).first<{ id: number }>();
  if (!loc) throw new AppError(422, "no_location", "Cửa hàng chưa có vị trí kho bán được");

  let plan = await planAssembly(db, b.bundleProductId, qtyMilli, storeId);
  const code = await nextCode(db, "LR");
  // lệnh tạo ở trạng thái cancelled (placeholder), batch thành công mới chuyển posted — thất bại thì còn nguyên placeholder
  const row = await db
    .prepare(`INSERT INTO assembly_orders(code, bundle_product_id, qty_milli, extra_cost, expires_at, status, note, created_by) VALUES (?,?,?,?,?,'cancelled',?,?) RETURNING id`)
    .bind(code, b.bundleProductId, qtyMilli, b.extraCost, null, b.note ?? null, user.id)
    .first<{ id: number }>();
  const id = row!.id;
  const build = () => {
    const total = plan.componentCost + b.extraCost;
    const unitCost = Math.round((total * 1000) / qtyMilli);
    const expiresAt = b.expiresAt ? new Date(b.expiresAt).toISOString() : plan.earliestExpiry;
    return {
      expiresAt,
      unitCost,
      stmts: [
        db.prepare(`UPDATE assembly_orders SET expires_at = ? WHERE id = ?`).bind(expiresAt, id),
        ...assemblyStatements(db, { assemblyId: id, bundleProductId: b.bundleProductId, locationId: loc.id, qtyMilli, unitCost, expiresAt, plan, userId: user.id }),
        auditStmt(c, { action: "assembly.post", entity: "assembly_order", entityId: id, after: { code, bundleProductId: b.bundleProductId, qtyMilli, componentCost: plan.componentCost, extraCost: b.extraCost, unitCost } }),
      ],
    };
  };
  try {
    try {
      await db.batch(build().stmts);
    } catch (e) {
      if (!isCheckFail(e)) throw e;
      plan = await planAssembly(db, b.bundleProductId, qtyMilli, storeId); // tồn vừa đổi: tính lại 1 lần
      await db.batch(build().stmts);
    }
  } catch (e) {
    await db.prepare(`UPDATE assembly_orders SET note = COALESCE(note,'') || ' [không ghi sổ được]' WHERE id = ? AND status='cancelled'`).bind(id).run();
    if (isCheckFail(e)) throw conflict("insufficient_stock", "Không đủ tồn thành phần (tồn vừa thay đổi), vui lòng thử lại");
    throw e;
  }
  return c.json(await assemblyView(db, id), 201);
});
