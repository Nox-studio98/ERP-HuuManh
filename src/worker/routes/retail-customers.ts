import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm, can, maskPhone } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { assertStmt } from "../services/guard";
import { addVnRange, guarded, likeOf, pageParams, parseBody } from "../services/http";
import { pointsStmts, loyaltyConfig } from "../services/loyalty-points";

/**
 * Quản lý khách lẻ (`customers.type = 'retail'`), mount ở /api/v1/retail-customers.
 * Không đụng route khách sỉ (`routes/customers.ts` vẫn ép type = 'b2b').
 * Quyền: xem = b2b.view (như khách sỉ; SĐT/email che nếu thiếu customers.view_pii); sửa / ngừng / gộp / gán nhóm = b2b.write (chủ, quản lý).
 */
export const retailCustomerRoutes = new Hono<AppBindings>();

// Chi tiêu = đơn bán hoàn tất trừ phiếu trả hoàn tất (mọi kênh: POS, online, social)
const SPEND = `(SELECT COALESCE(SUM(CASE WHEN o.kind = 'sale' THEN o.total ELSE -o.total END), 0) FROM orders o WHERE o.customer_id = cu.id AND o.status = 'completed')`;
const LAST = `(SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = cu.id AND o.kind = 'sale' AND o.status = 'completed')`;
const ORDERS_N = `(SELECT COUNT(*) FROM orders o WHERE o.customer_id = cu.id AND o.kind = 'sale' AND o.status = 'completed')`;

const SEL = `SELECT cu.*, g.name AS group_name, ${SPEND} AS spend, ${LAST} AS last_purchase_at, ${ORDERS_N} AS orders_count
               FROM customers cu LEFT JOIN customer_groups g ON g.id = cu.customer_group_id`;

const phoneOf = (r: any, pii: boolean) => (pii ? r.phone : maskPhone(r.phone, "warehouse"));
const maskEmail = (e: string | null, pii: boolean) => (e && !pii ? "***" : e ?? null);

function shape(r: any, pii: boolean) {
  return {
    id: r.id, code: r.code, name: r.name, phone: phoneOf(r, pii), email: maskEmail(r.email, pii),
    birthday: r.birthday ?? null, gender: r.gender ?? null, address: pii ? r.address ?? null : r.address ? "***" : null, note: r.note ?? null,
    customerGroupId: r.customer_group_id, groupName: r.group_name ?? null,
    points: r.points, active: !!r.active, mergedInto: r.merged_into ?? null, version: r.version, createdAt: r.created_at ?? null,
    spend: r.spend ?? 0, ordersCount: r.orders_count ?? 0, lastPurchaseAt: r.last_purchase_at ?? null,
  };
}

async function loadRetail(db: D1Database, id: number) {
  const r = await db.prepare(`${SEL} WHERE cu.id = ? AND cu.type = 'retail'`).bind(id).first<any>();
  if (!r) throw notFound("customer_not_found", "Không tìm thấy khách lẻ");
  return r;
}

const idParam = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(422, "validation_error", "Mã khách không hợp lệ");
  return n;
};

const birthdaySchema = z.string().trim().regex(/^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Ngày sinh dạng YYYY-MM-DD hoặc MM-DD");
const phoneSchema = z.string().trim().regex(/^[0-9+ ]{8,15}$/, "Số điện thoại không hợp lệ");
const normPhone = (p: string) => p.replace(/\s/g, "");

// ---------------------------------------------------------------- danh sách
retailCustomerRoutes.get("/retail-customers", requirePerm("b2b.view"), async (c) => {
  const db = c.env.DB;
  const pii = can(c.get("user").role, "customers.view_pii");
  const { limit, cursor } = pageParams(c);
  const q = c.req.query();
  const where: string[] = [`cu.type = 'retail'`, `cu.merged_into IS NULL`];
  const binds: unknown[] = [];
  const status = q.status ?? "active";
  if (!["active", "inactive", "all"].includes(status)) throw new AppError(422, "validation_error", "status không hợp lệ");
  if (status !== "all") where.push(`cu.active = ${status === "active" ? 1 : 0}`);
  if (q.q?.trim()) {
    // SĐT chỉ tìm được khi có customers.view_pii (tránh dò danh bạ qua kết quả lọc)
    const like = likeOf(q.q);
    where.push(pii ? `(cu.name LIKE ? ESCAPE '\\' OR cu.code LIKE ? ESCAPE '\\' OR cu.phone LIKE ? ESCAPE '\\')` : `(cu.name LIKE ? ESCAPE '\\' OR cu.code LIKE ? ESCAPE '\\')`);
    binds.push(like, like);
    if (pii) binds.push(like);
  }
  if (q.customerGroupId) (where.push(`cu.customer_group_id = ?`), binds.push(Number(q.customerGroupId) || 0));
  if (q.hasPoints === "1") where.push(`cu.points > 0`);
  if (q.hasPoints === "0") where.push(`cu.points = 0`);
  if (q.purchased === "0") where.push(`${LAST} IS NULL`);
  if (q.purchased === "1") where.push(`${LAST} IS NOT NULL`);
  addVnRange({ from: q.lastFrom, to: q.lastTo }, LAST, where, binds); // ngày mua gần nhất trong khoảng
  const filterWhere = where.join(" AND ");
  const filterBinds = [...binds];
  if (cursor) (where.push(`cu.id < ?`), binds.push(cursor));
  const rows = (await db.prepare(`${SEL} WHERE ${where.join(" AND ")} ORDER BY cu.id DESC LIMIT ?`).bind(...binds, limit + 1).all<any>()).results;
  const page = rows.slice(0, limit);
  const sum = await db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${SPEND}), 0) AS spend, COALESCE(SUM(cu.points), 0) AS points FROM customers cu WHERE ${filterWhere}`)
    .bind(...filterBinds)
    .first<{ n: number; spend: number; points: number }>();
  return c.json({
    items: page.map((r) => shape(r, pii)),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    summary: { count: sum?.n ?? 0, totalSpend: sum?.spend ?? 0, totalPoints: sum?.points ?? 0 },
  });
});

// ---------------------------------------------------------------- chi tiết
retailCustomerRoutes.get("/retail-customers/:id", requirePerm("b2b.view"), async (c) => {
  const db = c.env.DB;
  const pii = can(c.get("user").role, "customers.view_pii");
  const id = idParam(c.req.param("id"));
  const r = await loadRetail(db, id);
  const cfg = await loyaltyConfig(db);
  const ledger = (
    await db.prepare(`SELECT id, order_id, kind, points, note, created_by, created_at FROM loyalty_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT 200`).bind(id).all<any>()
  ).results;
  const orders = (
    await db
      .prepare(`SELECT id, code, channel, kind, status, total, paid_total, created_at FROM orders WHERE customer_id = ? AND status <> 'draft' ORDER BY id DESC LIMIT 100`)
      .bind(id)
      .all<any>()
  ).results;
  const accounts = (
    await db.prepare(`SELECT id, email, phone, full_name, active, created_at FROM shop_accounts WHERE customer_id = ? AND deleted_at IS NULL ORDER BY id`).bind(id).all<any>()
  ).results;
  const merged = (await db.prepare(`SELECT id, code, name FROM customers WHERE merged_into = ? ORDER BY id`).bind(id).all<any>()).results;
  return c.json({
    ...shape(r, pii),
    loyalty: {
      enabled: cfg.enabled, pointValueVnd: cfg.pointValueVnd,
      ledger: ledger.map((l) => ({ id: l.id, orderId: l.order_id, kind: l.kind, points: l.points, note: l.note, createdBy: l.created_by, createdAt: l.created_at })),
    },
    orders: orders.map((o) => ({ id: o.id, code: o.code, channel: o.channel, kind: o.kind, status: o.status, total: o.total, paidTotal: o.paid_total, createdAt: o.created_at })),
    shopAccounts: accounts.map((a) => ({
      id: a.id, email: pii ? a.email : "***", phone: pii ? a.phone : maskPhone(a.phone, "warehouse"), fullName: a.full_name, active: !!a.active, createdAt: a.created_at,
    })),
    mergedFrom: merged,
  });
});

// ---------------------------------------------------------------- sửa thông tin (có version)
const patchSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(150).optional(),
  phone: phoneSchema.nullable().optional(),
  email: z.string().trim().email().max(120).nullable().optional(),
  birthday: birthdaySchema.nullable().optional(),
  gender: z.enum(["male", "female", "other"]).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  customerGroupId: z.number().int().positive().optional(),
});

retailCustomerRoutes.patch("/retail-customers/:id", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const id = idParam(c.req.param("id"));
  const b = await parseBody(c, patchSchema);
  const cur = await loadRetail(db, id);
  if (cur.merged_into) throw conflict("customer_merged", "Khách này đã được gộp vào hồ sơ khác");
  if (cur.version !== b.version) throw conflict("version_conflict", "Hồ sơ vừa được người khác sửa — hãy tải lại", { version: cur.version });
  if (b.customerGroupId) {
    const g = await db.prepare(`SELECT id FROM customer_groups WHERE id = ?`).bind(b.customerGroupId).first();
    if (!g) throw new AppError(422, "invalid_group", "Nhóm khách hàng không tồn tại");
  }
  const phone = b.phone === undefined ? undefined : b.phone === null ? null : normPhone(b.phone);
  if (phone) {
    const dup = await db.prepare(`SELECT id, code FROM customers WHERE phone = ? AND type = 'retail' AND active = 1 AND merged_into IS NULL AND id <> ?`).bind(phone, id).first<any>();
    if (dup) throw conflict("phone_duplicate", `Số điện thoại đã thuộc khách ${dup.code} — hãy dùng chức năng Gộp khách`, { customerId: dup.id });
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = (col: string, key: string, v: unknown) => {
    if (v === undefined) return;
    sets.push(`${col} = ?`);
    vals.push(v);
    before[key] = cur[col];
    after[key] = v;
  };
  set("name", "name", b.name);
  set("phone", "phone", phone);
  set("email", "email", b.email);
  set("birthday", "birthday", b.birthday);
  set("gender", "gender", b.gender);
  set("address", "address", b.address);
  set("note", "note", b.note);
  set("customer_group_id", "customerGroupId", b.customerGroupId);
  if (!sets.length) throw new AppError(422, "validation_error", "Không có thông tin nào để cập nhật");
  await guarded(() =>
    db.batch([
      assertStmt(db, "retail_customer.update", `SELECT version = ? AND type = 'retail' AND merged_into IS NULL FROM customers WHERE id = ?`, [b.version, id]),
      db.prepare(`UPDATE customers SET ${sets.join(", ")}, version = version + 1 WHERE id = ?`).bind(...vals, id),
      auditStmt(c, { action: "retail_customer.update", entity: "customer", entityId: id, before, after }),
    ]),
  );
  const pii = can(c.get("user").role, "customers.view_pii");
  return c.json(shape(await loadRetail(db, id), pii));
});

// ---------------------------------------------------------------- ngừng / kích hoạt
retailCustomerRoutes.post("/retail-customers/:id/active", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const id = idParam(c.req.param("id"));
  const b = await parseBody(c, z.object({ active: z.boolean(), version: z.number().int().positive(), reason: z.string().trim().max(300).optional() }));
  const cur = await loadRetail(db, id);
  if (cur.merged_into) throw conflict("customer_merged", "Khách này đã được gộp vào hồ sơ khác");
  if (cur.version !== b.version) throw conflict("version_conflict", "Hồ sơ vừa được người khác sửa — hãy tải lại", { version: cur.version });
  if (b.active && cur.phone) {
    const dup = await db.prepare(`SELECT id FROM customers WHERE phone = ? AND type = 'retail' AND active = 1 AND id <> ?`).bind(cur.phone, id).first();
    if (dup) throw conflict("phone_duplicate", "Đã có khách khác đang dùng số điện thoại này — hãy gộp khách");
  }
  await guarded(() =>
    db.batch([
      assertStmt(db, "retail_customer.active", `SELECT version = ? AND merged_into IS NULL FROM customers WHERE id = ?`, [b.version, id]),
      db.prepare(`UPDATE customers SET active = ?, version = version + 1 WHERE id = ?`).bind(b.active ? 1 : 0, id),
      auditStmt(c, { action: b.active ? "retail_customer.activate" : "retail_customer.deactivate", entity: "customer", entityId: id, before: { active: !!cur.active }, after: { active: b.active }, reason: b.reason }),
    ]),
  );
  return c.json(shape(await loadRetail(db, id), can(c.get("user").role, "customers.view_pii")));
});

// ---------------------------------------------------------------- gán nhóm khách hàng loạt
retailCustomerRoutes.post("/retail-customers/assign-group", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const b = await parseBody(c, z.object({ ids: z.array(z.number().int().positive()).min(1).max(200), customerGroupId: z.number().int().positive() }));
  const ids = [...new Set(b.ids)];
  const g = await db.prepare(`SELECT id, name FROM customer_groups WHERE id = ?`).bind(b.customerGroupId).first<any>();
  if (!g) throw new AppError(422, "invalid_group", "Nhóm khách hàng không tồn tại");
  const ph = ids.map(() => "?").join(",");
  const found = (await db.prepare(`SELECT id FROM customers WHERE type = 'retail' AND merged_into IS NULL AND id IN (${ph})`).bind(...ids).all<{ id: number }>()).results;
  if (found.length !== ids.length) throw new AppError(422, "customer_not_found", "Có khách không tồn tại hoặc không phải khách lẻ");
  await db.batch([
    db.prepare(`UPDATE customers SET customer_group_id = ?, version = version + 1 WHERE type = 'retail' AND merged_into IS NULL AND id IN (${ph})`).bind(b.customerGroupId, ...ids),
    auditStmt(c, { action: "retail_customer.assign_group", entity: "customer", entityId: ids.length === 1 ? ids[0] : "bulk", after: { ids, customerGroupId: b.customerGroupId, groupName: g.name } }),
  ]);
  return c.json({ updated: ids.length });
});

// ---------------------------------------------------------------- gộp khách trùng
/**
 * Gộp khách `:id` (nguồn, bị ngừng) vào `targetId` (đích, giữ lại):
 *  - chuyển đơn hàng, voucher cá nhân + lượt dùng voucher, tài khoản website sang khách đích;
 *  - điểm: sổ điểm bất biến nên ghi 2 bút toán `adjust` (trừ nguồn, cộng đích), KHÔNG sửa/xoá dòng cũ;
 *  - bổ sung vào đích các trường còn trống (SĐT, email, ngày sinh, giới tính, địa chỉ);
 *  - nguồn: active = 0, merged_into = đích. Một batch + audit; assertStmt kiểm version hai bên và số điểm nguồn ở đầu batch.
 */
retailCustomerRoutes.post("/retail-customers/:id/merge", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const srcId = idParam(c.req.param("id"));
  const b = await parseBody(
    c,
    z.object({
      targetId: z.number().int().positive(),
      version: z.number().int().positive(),
      targetVersion: z.number().int().positive(),
      reason: z.string().trim().min(3).max(300),
    }),
  );
  if (b.targetId === srcId) throw new AppError(422, "merge_same", "Không thể gộp khách vào chính nó");
  const src = await loadRetail(db, srcId);
  const dst = await loadRetail(db, b.targetId);
  if (src.merged_into) throw conflict("customer_merged", "Khách nguồn đã được gộp trước đó");
  if (dst.merged_into) throw conflict("customer_merged", "Khách đích đã được gộp vào hồ sơ khác");
  if (!dst.active) throw new AppError(422, "target_inactive", "Khách đích đang ngừng hoạt động");
  if (src.version !== b.version || dst.version !== b.targetVersion) throw conflict("version_conflict", "Hồ sơ vừa được người khác sửa — hãy tải lại", { version: src.version, targetVersion: dst.version });
  const hasB2b = await db
    .prepare(`SELECT (SELECT COUNT(*) FROM invoices WHERE customer_id = ?1) + (SELECT COUNT(*) FROM quotes WHERE customer_id = ?1) + (SELECT COUNT(*) FROM recurring_orders WHERE customer_id = ?1) AS n`)
    .bind(srcId)
    .first<{ n: number }>();
  if (hasB2b?.n) throw new AppError(422, "has_b2b_documents", "Khách nguồn có hoá đơn/báo giá/đơn lặp — không gộp được");
  const pts = src.points as number;
  const moved = await db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?`).bind(srcId).first<{ n: number }>();
  const note = (dir: "to" | "from") => (dir === "to" ? `Gộp khách: chuyển ${pts} điểm sang ${dst.code}` : `Gộp khách: nhận ${pts} điểm từ ${src.code}`);
  await guarded(() =>
    db.batch([
      assertStmt(
        db,
        "retail_customer.merge",
        `SELECT (SELECT version = ? AND points = ? AND type = 'retail' AND merged_into IS NULL FROM customers WHERE id = ?)
            AND (SELECT version = ? AND active = 1 AND type = 'retail' AND merged_into IS NULL FROM customers WHERE id = ?)`,
        [b.version, pts, srcId, b.targetVersion, b.targetId],
      ),
      db.prepare(`UPDATE orders SET customer_id = ? WHERE customer_id = ?`).bind(b.targetId, srcId),
      db.prepare(`UPDATE voucher_redemptions SET customer_id = ? WHERE customer_id = ?`).bind(b.targetId, srcId),
      db.prepare(`UPDATE vouchers SET customer_id = ? WHERE customer_id = ?`).bind(b.targetId, srcId),
      db.prepare(`UPDATE shop_accounts SET customer_id = ? WHERE customer_id = ?`).bind(b.targetId, srcId),
      db
        .prepare(
          `UPDATE customers SET
             phone = COALESCE(NULLIF(phone, ''), ?1), email = COALESCE(NULLIF(email, ''), ?2), birthday = COALESCE(birthday, ?3),
             gender = COALESCE(gender, ?4), address = COALESCE(NULLIF(address, ''), ?5), version = version + 1
           WHERE id = ?6`,
        )
        .bind(src.phone ?? null, src.email ?? null, src.birthday ?? null, src.gender ?? null, src.address ?? null, b.targetId),
      ...pointsStmts(db, null, srcId, "adjust", -pts, note("to"), user.id),
      ...pointsStmts(db, null, b.targetId, "adjust", pts, note("from"), user.id),
      db.prepare(`UPDATE customers SET active = 0, merged_into = ?, version = version + 1 WHERE id = ?`).bind(b.targetId, srcId),
      auditStmt(c, {
        action: "retail_customer.merge", entity: "customer", entityId: srcId,
        before: { source: { code: src.code, name: src.name, points: pts, active: !!src.active }, target: { code: dst.code, name: dst.name, points: dst.points } },
        after: { targetId: b.targetId, ordersMoved: moved?.n ?? 0, pointsMoved: pts },
        reason: b.reason,
      }),
    ]),
  );
  const pii = can(user.role, "customers.view_pii");
  return c.json({ target: shape(await loadRetail(db, b.targetId), pii), ordersMoved: moved?.n ?? 0, pointsMoved: pts });
});
