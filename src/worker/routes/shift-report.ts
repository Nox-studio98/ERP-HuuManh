import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can } from "../lib/rbac";
import { AppError, forbidden, notFound } from "../lib/errors";
import { vnDayRangeUtc } from "../lib/time";
import { parseQuery } from "../services/http";
import { shiftSummary } from "../services/shift-report";

/**
 * Lịch sử ca + chi tiết ca (phiếu bàn giao). Chỉ đọc.
 * Thu ngân chỉ thấy ca của chính mình; vai trò có `reports.view` (chủ, quản lý, kế toán) thấy mọi ca của cửa hàng.
 */
export const shiftReportRoutes = new Hono<AppBindings>();

/** Cần pos.shift (thu ngân, quản lý, chủ) HOẶC reports.view (kế toán). Không mở thêm quyền nào mới. */
const shiftViewer: import("hono").MiddlewareHandler<AppBindings> = async (c, next) => {
  const u = c.get("user");
  if (!u || !(can(u.role, "pos.shift") || can(u.role, "reports.view"))) throw forbidden();
  await next();
};
const seesAll = (role: Parameters<typeof can>[0]) => can(role, "reports.view");

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v + "T00:00:00Z")), "Ngày không hợp lệ");
const historyQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  userId: z.coerce.number().int().positive().optional(),
  status: z.enum(["open", "closed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

shiftReportRoutes.get("/shifts/history", shiftViewer, async (c) => {
  const q = parseQuery(c, historyQuery);
  const user = c.get("user");
  const conds: string[] = [];
  const params: unknown[] = [];
  if (!seesAll(user.role)) { conds.push(`s.user_id = ?`); params.push(user.id); } // thu ngân: chỉ ca của mình
  else if (q.userId) { conds.push(`s.user_id = ?`); params.push(q.userId); }
  if (q.from || q.to) {
    const from = q.from ?? q.to!, to = q.to ?? q.from!;
    if (to < from) throw new AppError(422, "validation_error", "to phải sau hoặc bằng from");
    conds.push(`s.opened_at >= ? AND s.opened_at < ?`);
    params.push(vnDayRangeUtc(from).from, vnDayRangeUtc(to).to);
  }
  if (q.status) { conds.push(`s.status = ?`); params.push(q.status); }
  if (q.cursor) { conds.push(`s.id < ?`); params.push(q.cursor); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = (
    await c.env.DB
      .prepare(
        `SELECT s.id, s.user_id, u.full_name AS cashier_name, s.status, s.opened_at, s.closed_at, s.opening_cash, s.expected_cash, s.counted_cash, s.diff_cash, s.diff_reason,
                (SELECT COUNT(*) FROM orders o WHERE o.shift_id = s.id AND o.kind = 'sale' AND o.status = 'completed') AS sale_count,
                (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.shift_id = s.id AND o.kind = 'sale' AND o.status = 'completed') AS sale_total,
                (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.shift_id = s.id AND o.kind = 'return' AND o.status = 'completed') AS return_total
           FROM shifts s JOIN users u ON u.id = s.user_id ${where} ORDER BY s.id DESC LIMIT ?`,
      )
      .bind(...params, q.limit + 1)
      .all<any>()
  ).results;
  const page = rows.slice(0, q.limit).map((r) => ({
    id: r.id, cashierId: r.user_id, cashierName: r.cashier_name, status: r.status, openedAt: r.opened_at, closedAt: r.closed_at,
    openingCash: r.opening_cash, expectedCash: r.expected_cash, countedCash: r.counted_cash, diffCash: r.diff_cash, diffReason: r.diff_reason,
    saleCount: r.sale_count, saleTotal: r.sale_total, returnTotal: r.return_total, revenue: r.sale_total - r.return_total,
  }));
  return c.json({ items: page, nextCursor: rows.length > q.limit ? String(page[page.length - 1].id) : null });
});

shiftReportRoutes.get("/shifts/:id/summary", shiftViewer, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw notFound("shift_not_found", "Không tìm thấy ca");
  const r = await shiftSummary(c.env.DB, id, { sensitive: can(c.get("user").role, "hr.sensitive") });
  // Thu ngân xem ca người khác → 404 như không tồn tại (không lộ sự tồn tại / số liệu)
  if (!r || (!seesAll(c.get("user").role) && r.shift.cashierId !== c.get("user").id)) throw notFound("shift_not_found", "Không tìm thấy ca");
  return c.json(r);
});
