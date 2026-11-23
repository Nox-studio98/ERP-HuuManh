import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm, can } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { vnDayRangeUtc, vnPeriod } from "../lib/time";
import { getSettingInt } from "../services/settings";
import { approveVoucher } from "../services/vouchers";

export const financeRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

async function parseBody<T extends z.ZodTypeAny>(c: Ctx, schema: T): Promise<z.infer<T>> {
  return schema.parse(await c.req.json().catch(() => ({})));
}

financeRoutes.get("/funds", requirePerm("finance.view"), async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT f.id, f.store_id, f.code, f.name, f.type, f.active,
              COALESCE((SELECT SUM(p.amount) FROM payments p JOIN orders o ON o.id = p.order_id
                         WHERE p.fund_id = f.id AND p.status='confirmed' AND o.status='completed'),0) AS payments_total,
              COALESCE((SELECT SUM(CASE WHEN v.direction='in' THEN v.amount ELSE -v.amount END) FROM cash_vouchers v
                         WHERE v.fund_id = f.id AND v.status='posted'),0) AS vouchers_net
         FROM funds f ORDER BY f.id`,
    )
    .all<any>();
  return c.json({
    items: results.map((f) => ({ ...f, balance: f.payments_total + f.vouchers_net })),
  });
});

financeRoutes.get("/cash-categories", requirePerm("finance.view"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM cash_categories ORDER BY id`).all();
  return c.json({ items: results });
});

financeRoutes.get("/vouchers", requirePerm("finance.view"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.period) { conds.push(`v.period = ?`); params.push(q.period); }
  if (q.fundId) { conds.push(`v.fund_id = ?`); params.push(Number(q.fundId)); }
  if (q.direction) { conds.push(`v.direction = ?`); params.push(q.direction); }
  if (q.status) { conds.push(`v.status = ?`); params.push(q.status); }
  if (q.cursor) { conds.push(`v.id < ?`); params.push(Number(q.cursor)); }
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const rows = (
    await c.env.DB
      .prepare(
        `SELECT v.*, cc.name AS category_name, cc.pnl_line, f.name AS fund_name
           FROM cash_vouchers v JOIN cash_categories cc ON cc.id = v.category_id JOIN funds f ON f.id = v.fund_id
          ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY v.id DESC LIMIT ?`,
      )
      .bind(...params, limit + 1)
      .all<any>()
  ).results;
  const items = rows.slice(0, limit);
  return c.json({ items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null });
});

const voucherSchema = z.object({
  direction: z.enum(["in", "out"]),
  fundId: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  amount: z.number().int().positive(),
  counterparty: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
  refType: z.string().max(50).optional(),
  refId: z.number().int().optional(),
  channel: z.enum(["pos", "online", "b2b"]).optional(), // chi phí trực tiếp theo kênh (M6-06)
});

financeRoutes.post("/vouchers", requirePerm("finance.write"), async (c) => {
  const body = await parseBody(c, voucherSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const fund = await db.prepare(`SELECT id FROM funds WHERE id = ? AND active = 1`).bind(body.fundId).first();
  if (!fund) throw new AppError(422, "fund_not_found", "Quỹ không tồn tại hoặc đã ngừng");
  const cat = await db.prepare(`SELECT id, direction FROM cash_categories WHERE id = ?`).bind(body.categoryId).first<{ id: number; direction: string }>();
  if (!cat) throw new AppError(422, "category_not_found", "Khoản mục không tồn tại");
  if (cat.direction !== body.direction) throw new AppError(422, "category_direction_mismatch", "Khoản mục không đúng loại thu/chi");
  const threshold = await getSettingInt(db, "approval.cash_out_vnd", 5_000_000);
  const needApproval = body.direction === "out" && body.amount > threshold && !can(user.role, "finance.approve");
  const code = await nextCode(db, body.direction === "in" ? PREFIX.cashIn : PREFIX.cashOut);
  const r = await db
    .prepare(
      `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by, channel)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(code, body.direction, body.fundId, body.categoryId, body.amount, body.counterparty ?? null, body.refType ?? null, body.refId ?? null,
      needApproval ? "pending_approval" : "posted", vnPeriod(), body.note ?? null, user.id, needApproval ? null : (can(user.role, "finance.approve") ? user.id : null), body.channel ?? null)
    .run();
  const id = r.meta.last_row_id as number;
  const stmts = [
    auditStmt(c, { action: "voucher.create", entity: "cash_voucher", entityId: id, after: { code, direction: body.direction, amount: body.amount, pending: needApproval } }),
  ];
  if (needApproval) {
    stmts.unshift(
      db
        .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('cash_voucher.post','cash_voucher',?,?,?,?)`)
        .bind(String(id), JSON.stringify({ amount: body.amount, code }), `Phiếu chi ${body.amount} vượt ngưỡng ${threshold}`, user.id),
    );
  }
  await db.batch(stmts);
  const v = await db.prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(id).first();
  const approval = needApproval ? await db.prepare(`SELECT id FROM approvals WHERE type='cash_voucher.post' AND ref_id=? ORDER BY id DESC`).bind(String(id)).first<{ id: number }>() : null;
  return c.json({ ...v, approvalId: approval?.id ?? null }, 201);
});

financeRoutes.post("/vouchers/:id/approve", requirePerm("finance.approve"), async (c) => {
  const v = await approveVoucher(c, Number(c.req.param("id")));
  return c.json(v);
});

financeRoutes.post("/vouchers/:id/reverse", requirePerm("finance.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, z.object({ reason: z.string().trim().min(3).max(300) }));
  const db = c.env.DB;
  const user = c.get("user");
  const v = await db.prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(id).first<any>();
  if (!v) throw notFound("voucher_not_found", "Không tìm thấy phiếu");
  if (v.status !== "posted") throw conflict("not_posted", "Chỉ đảo được phiếu đã ghi sổ");
  if (v.reverses_id) throw conflict("is_reversal", "Không thể đảo một phiếu đảo");
  const done = await db.prepare(`SELECT id FROM cash_vouchers WHERE reverses_id = ?`).bind(id).first();
  if (done) throw conflict("already_reversed", "Phiếu đã được đảo trước đó");
  const code = await nextCode(db, v.direction === "in" ? PREFIX.cashOut : PREFIX.cashIn);
  const r = await db
    .prepare(
      `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by, reverses_id)
       VALUES (?,?,?,?,?,?,?,?, 'posted', ?,?,?,?,?)`,
    )
    .bind(code, v.direction === "in" ? "out" : "in", v.fund_id, v.category_id, v.amount, v.counterparty, v.ref_type, v.ref_id, vnPeriod(),
      `Đảo phiếu ${v.code}: ${body.reason}`, user.id, user.id, id)
    .run();
  const newId = r.meta.last_row_id as number;
  await auditStmt(c, { action: "voucher.reverse", entity: "cash_voucher", entityId: id, before: { code: v.code, period: v.period }, after: { reversalId: newId, code }, reason: body.reason }).run();
  return c.json(await db.prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(newId).first(), 201);
});

financeRoutes.get("/reconcile/shifts", requirePerm("finance.shift_reconcile"), async (c) => {
  const day = c.req.query("day");
  const params: unknown[] = [];
  let where = "";
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError(422, "validation_error", "day phải có dạng YYYY-MM-DD");
    const r = vnDayRangeUtc(day);
    where = `WHERE s.opened_at >= ? AND s.opened_at < ?`;
    params.push(r.from, r.to);
  }
  const { results } = await c.env.DB
    .prepare(
      `SELECT s.*, u.full_name AS cashier_name,
              s.opening_cash + COALESCE((SELECT SUM(p.amount) FROM payments p JOIN orders o ON o.id = p.order_id
                 WHERE o.shift_id = s.id AND o.status='completed' AND p.method='cash' AND p.status='confirmed'),0) AS computed_expected
         FROM shifts s JOIN users u ON u.id = s.user_id ${where} ORDER BY s.id DESC LIMIT 200`,
    )
    .bind(...params)
    .all<any>();
  return c.json({
    items: results.map((s) => ({
      ...s,
      expected_cash: s.status === "closed" ? s.expected_cash : s.computed_expected,
      diff: s.status === "closed" ? s.diff_cash : null,
    })),
  });
});

financeRoutes.get("/periods", requirePerm("finance.view"), async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT period, MAX(locked_at) AS locked_at, MAX(locked_by) AS locked_by FROM (
         SELECT period, locked_at, locked_by FROM periods
         UNION ALL SELECT period, NULL, NULL FROM cash_vouchers
       ) GROUP BY period ORDER BY period DESC`,
    )
    .all();
  return c.json({ items: results.map((r: any) => ({ ...r, locked: !!r.locked_at })), current: vnPeriod() });
});

financeRoutes.post("/periods/:period/lock", requirePerm("finance.lock_period"), async (c) => {
  const period = c.req.param("period");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError(422, "validation_error", "Kỳ phải có dạng YYYY-MM");
  const db = c.env.DB;
  const user = c.get("user");
  const cur = await db.prepare(`SELECT locked_at FROM periods WHERE period = ?`).bind(period).first<{ locked_at: string | null }>();
  if (cur?.locked_at) throw conflict("already_locked", "Kỳ đã khoá sổ");
  await db.batch([
    db
      .prepare(
        `INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
         ON CONFLICT(period) DO UPDATE SET locked_at = excluded.locked_at, locked_by = excluded.locked_by`,
      )
      .bind(period, user.id),
    auditStmt(c, { action: "period.lock", entity: "period", entityId: period, before: { locked: false }, after: { locked: true } }),
  ]);
  return c.json({ period, locked: true });
});
