import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm, can } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { vnDayRangeUtc, vnPeriod, parseDayRange } from "../lib/time";
import { getSettingInt } from "../services/settings";
import { approveVoucher } from "../services/vouchers";
import { assertStmt } from "../services/guard";
import { FUND_ORDER_OK } from "../services/fund-sql";

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
                         WHERE p.fund_id = f.id AND p.status='confirmed' AND ${FUND_ORDER_OK}),0) AS payments_total,
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
  const range = parseDayRange(q.from, q.to);
  if (range) { conds.push(`v.created_at >= ? AND v.created_at < ?`); params.push(vnDayRangeUtc(range.from).from, vnDayRangeUtc(range.to).to); }
  const term = q.q?.trim();
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    conds.push(`(v.code LIKE ? ESCAPE '\\' OR COALESCE(v.counterparty,'') LIKE ? ESCAPE '\\' OR COALESCE(v.note,'') LIKE ? ESCAPE '\\' OR cc.name LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  // Phiếu lương/tạm ứng là dữ liệu nhạy cảm của nhân sự: chỉ người có hr.sensitive mới thấy
  if (!can(c.get("user").role, "hr.sensitive")) conds.push(`COALESCE(v.ref_type,'') NOT IN ('payroll_item','salary_advance','payroll') AND cc.code <> 'LUONG'`);
  const baseConds = [...conds], baseParams = [...params];
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
  // Tổng hợp trên TOÀN BỘ kết quả lọc (chỉ phiếu đã ghi): tổng thu, tổng chi, số phiếu
  const s = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(CASE WHEN v.direction='in' AND v.status='posted' THEN v.amount END),0) AS total_in,
              COALESCE(SUM(CASE WHEN v.direction='out' AND v.status='posted' THEN v.amount END),0) AS total_out,
              COALESCE(SUM(CASE WHEN v.status='pending_approval' THEN 1 ELSE 0 END),0) AS pending
         FROM cash_vouchers v JOIN cash_categories cc ON cc.id = v.category_id JOIN funds f ON f.id = v.fund_id
        ${baseConds.length ? "WHERE " + baseConds.join(" AND ") : ""}`,
    )
    .bind(...baseParams)
    .first<any>();
  return c.json({
    items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null,
    summary: { count: s?.cnt ?? 0, totalIn: s?.total_in ?? 0, totalOut: s?.total_out ?? 0, pending: s?.pending ?? 0 },
  });
});

const voucherSchema = z.object({
  direction: z.enum(["in", "out"]),
  fundId: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  amount: z.number().int().positive().max(10_000_000_000),
  counterparty: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
  // Chỉ phiếu thủ công: các ref_type của module khác (debt_payment, payroll_item, order_deposit...) do chính module đó tạo
  refType: z.literal("manual").nullish(),
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
  // Phiếu do module khác quản lý (thu nợ, lương, tạm ứng, cọc, đối soát, đơn...) phải đảo bằng luồng của module đó, nếu không sổ nghiệp vụ lệch sổ quỹ
  if (v.ref_type && v.ref_type !== "manual") throw conflict("managed_voucher", "Phiếu này do module khác quản lý, hãy đảo từ chứng từ gốc", { refType: v.ref_type });
  const done = await db.prepare(`SELECT id FROM cash_vouchers WHERE reverses_id = ?`).bind(id).first();
  if (done) throw conflict("already_reversed", "Phiếu đã được đảo trước đó");
  const code = await nextCode(db, v.direction === "in" ? PREFIX.cashOut : PREFIX.cashIn);
  // Chốt chặn (audit #6): phiếu gốc còn 'posted'; đảo đôi còn bị unique reverses_id chặn → 409 already_reversed
  const res = await db.batch([
    assertStmt(db, "voucher.reverse", `SELECT status = 'posted' FROM cash_vouchers WHERE id = ?`, [id]),
    db
      .prepare(
        `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by, reverses_id, channel)
         VALUES (?,?,?,?,?,?,?,?, 'posted', ?,?,?,?,?,?)`,
      )
      .bind(code, v.direction === "in" ? "out" : "in", v.fund_id, v.category_id, v.amount, v.counterparty, v.ref_type, v.ref_id, vnPeriod(),
        `Đảo phiếu ${v.code}: ${body.reason}`, user.id, user.id, id, v.channel ?? null),
  ]);
  const newId = res[1].meta.last_row_id as number;
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
      `SELECT g.period, g.locked_at, g.locked_by, u.full_name AS locked_by_name FROM (
         SELECT period, MAX(locked_at) AS locked_at, MAX(locked_by) AS locked_by FROM (
           SELECT period, locked_at, locked_by FROM periods
           UNION ALL SELECT period, NULL, NULL FROM cash_vouchers
         ) GROUP BY period
       ) g LEFT JOIN users u ON u.id = g.locked_by ORDER BY g.period DESC`,
    )
    .all();
  return c.json({ items: results.map((r: any) => ({ ...r, locked: !!r.locked_at, lockable: !r.locked_at && r.period < vnPeriod() })), current: vnPeriod() });
});

financeRoutes.post("/periods/:period/lock", requirePerm("finance.lock_period"), async (c) => {
  const period = c.req.param("period");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError(422, "validation_error", "Kỳ phải có dạng YYYY-MM");
  const db = c.env.DB;
  const user = c.get("user");
  // B-08: chỉ khoá kỳ ĐÃ KẾT THÚC (cuối kỳ < hôm nay giờ VN); kỳ hiện tại/tương lai còn phát sinh nghiệp vụ nên không khoá được
  if (period >= vnPeriod()) throw new AppError(422, "period_not_ended", "Chỉ khoá được kỳ đã kết thúc (kỳ hiện tại hoặc tương lai chưa khoá được)", { period, current: vnPeriod() });
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

// Mở khoá sổ (C-16): chỉ chủ (finance.lock_period), bắt buộc lý do, ghi nhật ký. Không đụng khoá bảng công / bảng lương (bảng riêng).
financeRoutes.post("/periods/:period/unlock", requirePerm("finance.lock_period"), async (c) => {
  const period = c.req.param("period");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError(422, "validation_error", "Kỳ phải có dạng YYYY-MM");
  const body = await c.req.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 5) throw new AppError(422, "validation_error", "Phải nhập lý do mở khoá (ít nhất 5 ký tự)", { fields: { reason: "Phải nhập lý do mở khoá (ít nhất 5 ký tự)" } });
  if (reason.length > 500) throw new AppError(422, "validation_error", "Lý do tối đa 500 ký tự", { fields: { reason: "Lý do tối đa 500 ký tự" } });
  const db = c.env.DB;
  const cur = await db.prepare(`SELECT locked_at, locked_by FROM periods WHERE period = ?`).bind(period).first<{ locked_at: string | null; locked_by: number | null }>();
  if (!cur?.locked_at) throw conflict("not_locked", "Kỳ này chưa khoá sổ");
  await db.batch([
    db.prepare(`UPDATE periods SET locked_at = NULL, locked_by = NULL WHERE period = ? AND locked_at IS NOT NULL`).bind(period),
    auditStmt(c, { action: "period.unlock", entity: "period", entityId: period, before: { locked: true, lockedAt: cur.locked_at, lockedBy: cur.locked_by }, after: { locked: false }, reason }),
  ]);
  return c.json({ period, locked: false });
});
