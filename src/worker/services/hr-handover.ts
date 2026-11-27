import { auditStmt } from "../lib/audit";
import { AppError, conflict } from "../lib/errors";
import { can, type Permission } from "../lib/rbac";
import { vnDate } from "../lib/time";
import { assertStmt } from "./guard";
import type { Context } from "hono";
import type { AppBindings } from "../env";

/**
 * EC-39: chuyển việc đang làm cho người khác khi nhân viên nghỉ việc / khoá tài khoản.
 * Mỗi nhóm = một bảng + cột "người phụ trách/người lập" + phạm vi dòng còn dang dở.
 * Chỉ ĐỔI người phụ trách (hoặc huỷ chứng từ nháp) — không đụng tới chứng từ đã ghi sổ, kỳ đã khoá, bảng bất biến.
 */
interface Group {
  key: string;
  label: string;
  /** Quyền bổ sung ngoài hr.manage để chuyển nhóm này. */
  perm?: Permission;
  table: string;
  userCol: string;
  /** Điều kiện phạm vi (SQL, không bind). */
  scope: string;
  /** Biểu thức nhãn hiển thị cho từng dòng. */
  labelSql: string;
  versioned?: boolean;
  /** Huỷ/ngừng: chỉ dòng thoả `only`; `set` là phần SET (có thể kèm 1 bind là lý do). */
  cancel?: { verb: string; only: string; set: string; reasonBind?: boolean };
}

export const GROUPS: Group[] = [
  { key: "customers", label: "Khách sỉ đang phụ trách", perm: "b2b.write", table: "customers", userCol: "owner_user_id", scope: "active = 1", labelSql: "code || ' · ' || name", versioned: true },
  { key: "quotes", label: "Báo giá nháp / chờ duyệt", perm: "b2b.write", table: "quotes", userCol: "created_by", scope: "status IN ('draft','pending_approval')", labelSql: "code", versioned: true, cancel: { verb: "Huỷ báo giá nháp", only: "status = 'draft'", set: "status = 'cancelled'" } },
  { key: "orders", label: "Đơn nháp / đơn sỉ mới", perm: "b2b.write", table: "orders", userCol: "created_by", scope: "(status = 'draft' OR (channel = 'b2b' AND status = 'new'))", labelSql: "code" },
  { key: "stock_docs", label: "Phiếu kho nháp / chờ duyệt", perm: "inventory.write", table: "stock_docs", userCol: "created_by", scope: "status IN ('draft','pending_approval')", labelSql: "code", versioned: true, cancel: { verb: "Huỷ phiếu nháp", only: "status = 'draft'", set: "status = 'cancelled'" } },
  { key: "purchase_orders", label: "Đơn đặt NCC (PO) nháp / chờ duyệt", perm: "purchasing.write", table: "purchase_orders", userCol: "created_by", scope: "status IN ('draft','pending_approval')", labelSql: "code", versioned: true, cancel: { verb: "Huỷ PO nháp", only: "status = 'draft'", set: "status = 'cancelled', cancel_reason = ?", reasonBind: true } },
  { key: "purchase_returns", label: "Phiếu trả hàng NCC nháp / chờ duyệt", perm: "inventory.write", table: "purchase_returns", userCol: "created_by", scope: "status IN ('draft','pending_approval')", labelSql: "'#' || id", cancel: { verb: "Huỷ phiếu nháp", only: "status = 'draft'", set: "status = 'cancelled'" } },
  { key: "promotions", label: "Khuyến mãi nháp / chờ duyệt", perm: "promotions.write", table: "promotions", userCol: "created_by", scope: "status IN ('draft','pending_approval')", labelSql: "COALESCE(name, '#' || id)", cancel: { verb: "Huỷ khuyến mãi nháp", only: "status = 'draft'", set: "status = 'cancelled'" } },
  { key: "settlements", label: "Phiếu đối soát nháp", perm: "finance.write", table: "settlements", userCol: "created_by", scope: "status = 'draft'", labelSql: "'#' || id" },
  { key: "recurring_orders", label: "Đơn lặp hằng tuần đang chạy", perm: "b2b.write", table: "recurring_orders", userCol: "created_by", scope: "active = 1", labelSql: "'Đơn lặp #' || id || ' · ' || weekdays", cancel: { verb: "Ngừng đơn lặp", only: "1 = 1", set: "active = 0" } },
  { key: "approvals", label: "Yêu cầu chờ duyệt do người này lập", table: "approvals", userCol: "requested_by", scope: "status = 'pending'", labelSql: "type || ' #' || id" },
  { key: "deliveries", label: "Đơn đang giao (người giao)", perm: "orders.online.manage", table: "orders", userCol: "deliverer_user_id", scope: "status IN ('confirmed','preparing','shipping')", labelSql: "code" },
];
const byKey = new Map(GROUPS.map((g) => [g.key, g]));

/** Ca xếp từ hôm nay trở đi, chưa huỷ, nằm trong kỳ công chưa chốt. */
const SHIFT_SCOPE = `employee_id = ? AND status = 'scheduled' AND work_date >= ? AND substr(work_date,1,7) NOT IN (SELECT period FROM timesheets WHERE status = 'closed')`;

const itemLimit = 60;

type Ctx = Context<AppBindings>;

export async function listHandover(db: D1Database, userId: number | null, employeeId: number | null) {
  const today = vnDate();
  const groups: any[] = [];
  if (userId) {
    for (const g of GROUPS) {
      const total = (await db.prepare(`SELECT COUNT(*) n FROM ${g.table} WHERE ${g.userCol} = ? AND ${g.scope}`).bind(userId).first<{ n: number }>())?.n ?? 0;
      if (!total) continue;
      const { results } = await db.prepare(`SELECT id, ${g.labelSql} AS label FROM ${g.table} WHERE ${g.userCol} = ? AND ${g.scope} ORDER BY id LIMIT ${itemLimit}`).bind(userId).all<{ id: number; label: string }>();
      const cancelable = g.cancel ? (await db.prepare(`SELECT COUNT(*) n FROM ${g.table} WHERE ${g.userCol} = ? AND ${g.scope} AND ${g.cancel.only}`).bind(userId).first<{ n: number }>())?.n ?? 0 : 0;
      groups.push({ key: g.key, label: g.label, perm: g.perm ?? null, count: total, items: results, truncated: total > results.length, kind: "user", cancel: g.cancel && cancelable === total ? g.cancel.verb : null });
    }
  }
  if (employeeId) {
    const total = (await db.prepare(`SELECT COUNT(*) n FROM shift_assignments WHERE ${SHIFT_SCOPE}`).bind(employeeId, today).first<{ n: number }>())?.n ?? 0;
    if (total) {
      const { results } = await db.prepare(`SELECT id, work_date || ' · ca ' || shift_template_id AS label FROM shift_assignments WHERE ${SHIFT_SCOPE} ORDER BY work_date LIMIT ${itemLimit}`).bind(employeeId, today).all<{ id: number; label: string }>();
      groups.push({ key: "shifts", label: "Ca đã xếp từ hôm nay", perm: null, count: total, items: results, truncated: total > results.length, kind: "employee", cancel: "Huỷ các ca" });
    }
  }
  const openShifts = userId ? (await db.prepare(`SELECT COUNT(*) n FROM shifts WHERE user_id = ? AND status = 'open'`).bind(userId).first<{ n: number }>())?.n ?? 0 : 0;
  return { openShifts, groups, total: groups.reduce((a, g) => a + g.count, 0) };
}

export interface HandoverAction { group: string; action: "reassign" | "cancel"; toUserId?: number; toEmployeeId?: number }

export async function runHandover(c: Ctx, o: { userId: number | null; employeeId: number | null; actions: HandoverAction[]; reason: string }) {
  const db = c.env.DB;
  const me = c.get("user");
  const today = vnDate();
  if (!o.actions.length) throw new AppError(422, "validation_error", "Chưa chọn việc nào để chuyển");
  const seen = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  const summary: Record<string, unknown> = {};
  for (const a of o.actions) {
    if (seen.has(a.group)) throw new AppError(422, "validation_error", "Mỗi nhóm việc chỉ chọn một lần");
    seen.add(a.group);
    if (a.group === "shifts") {
      if (!o.employeeId) throw new AppError(422, "validation_error", "Nhân viên này không có ca để chuyển");
      const { results: rows } = await db.prepare(`SELECT id, work_date, shift_template_id FROM shift_assignments WHERE ${SHIFT_SCOPE}`).bind(o.employeeId, today).all<any>();
      if (!rows.length) continue;
      if (a.action === "cancel") {
        stmts.push(assertStmt(db, "handover.shifts", `SELECT COUNT(*) = ? FROM shift_assignments WHERE ${SHIFT_SCOPE}`, [rows.length, o.employeeId, today]));
        stmts.push(db.prepare(`UPDATE shift_assignments SET status = 'cancelled' WHERE ${SHIFT_SCOPE}`).bind(o.employeeId, today));
        summary.shifts = { action: "cancel", count: rows.length };
        continue;
      }
      if (!a.toEmployeeId || a.toEmployeeId === o.employeeId) throw new AppError(422, "validation_error", "Chọn nhân viên nhận ca");
      const to = await db.prepare(`SELECT id, status FROM employees WHERE id = ?`).bind(a.toEmployeeId).first<any>();
      if (!to || to.status !== "active") throw new AppError(422, "invalid_recipient", "Người nhận ca phải là nhân viên đang làm");
      const clash = await db.prepare(`SELECT s.work_date FROM shift_assignments s JOIN shift_assignments t ON t.employee_id = ? AND t.work_date = s.work_date AND t.shift_template_id = s.shift_template_id
          WHERE s.employee_id = ? AND s.status = 'scheduled' AND s.work_date >= ?`).bind(a.toEmployeeId, o.employeeId, today).all<{ work_date: string }>();
      if (clash.results.length) throw conflict("shift_conflict", `Người nhận đã có ca trùng ngày ${clash.results.map((r) => r.work_date).slice(0, 5).join(", ")}. Chọn người khác hoặc huỷ các ca này.`);
      stmts.push(assertStmt(db, "handover.shifts", `SELECT COUNT(*) = ? AND (SELECT status = 'active' FROM employees WHERE id = ?) FROM shift_assignments WHERE ${SHIFT_SCOPE}`, [rows.length, a.toEmployeeId, o.employeeId, today]));
      stmts.push(db.prepare(`UPDATE shift_assignments SET employee_id = ? WHERE ${SHIFT_SCOPE}`).bind(a.toEmployeeId, o.employeeId, today));
      summary.shifts = { action: "reassign", toEmployeeId: a.toEmployeeId, count: rows.length, ids: rows.map((r) => r.id).slice(0, 200) };
      continue;
    }
    const g = byKey.get(a.group);
    if (!g) throw new AppError(422, "validation_error", `Nhóm việc không hợp lệ: ${a.group}`);
    if (!o.userId) throw new AppError(422, "validation_error", "Nhân viên này chưa có tài khoản");
    if (g.perm && !can(me.role, g.perm)) throw new AppError(403, "forbidden", `Bạn không có quyền chuyển nhóm "${g.label}" (cần ${g.perm})`);
    const { results: rows } = await db.prepare(`SELECT id FROM ${g.table} WHERE ${g.userCol} = ? AND ${g.scope}`).bind(o.userId).all<{ id: number }>();
    if (!rows.length) continue;
    const countSql = `SELECT COUNT(*) = ? FROM ${g.table} WHERE ${g.userCol} = ? AND ${g.scope}`;
    if (a.action === "cancel") {
      if (!g.cancel) throw new AppError(422, "cancel_not_allowed", `Nhóm "${g.label}" chỉ chuyển cho người khác, không huỷ được`);
      const ok = (await db.prepare(`SELECT COUNT(*) n FROM ${g.table} WHERE ${g.userCol} = ? AND ${g.scope} AND ${g.cancel.only}`).bind(o.userId).first<{ n: number }>())?.n ?? 0;
      if (ok !== rows.length) throw new AppError(422, "cancel_not_allowed", `Nhóm "${g.label}" còn chứng từ đã gửi duyệt — chỉ chuyển cho người khác được`);
      stmts.push(assertStmt(db, `handover.${g.key}`, countSql, [rows.length, o.userId]));
      stmts.push(db.prepare(`UPDATE ${g.table} SET ${g.cancel.set}${g.versioned ? ", version = version + 1" : ""} WHERE ${g.userCol} = ? AND ${g.scope} AND ${g.cancel.only}`).bind(...(g.cancel.reasonBind ? [`Huỷ khi bàn giao nhân viên nghỉ: ${o.reason}`] : []), o.userId));
      summary[g.key] = { action: "cancel", count: rows.length, ids: rows.map((r) => r.id).slice(0, 200) };
      continue;
    }
    if (!a.toUserId || a.toUserId === o.userId) throw new AppError(422, "validation_error", `Chọn người nhận cho nhóm "${g.label}"`);
    const to = await db.prepare(`SELECT id, role, active FROM users WHERE id = ?`).bind(a.toUserId).first<any>();
    if (!to || !to.active) throw new AppError(422, "invalid_recipient", "Người nhận phải là tài khoản đang hoạt động");
    if (g.perm && !can(to.role, g.perm)) throw new AppError(422, "invalid_recipient", `Người nhận không đủ quyền cho nhóm "${g.label}" (cần ${g.perm})`);
    stmts.push(assertStmt(db, `handover.${g.key}`, `SELECT COUNT(*) = ? AND (SELECT active FROM users WHERE id = ?) = 1 FROM ${g.table} WHERE ${g.userCol} = ? AND ${g.scope}`, [rows.length, a.toUserId, o.userId]));
    stmts.push(db.prepare(`UPDATE ${g.table} SET ${g.userCol} = ?${g.versioned ? ", version = version + 1" : ""} WHERE ${g.userCol} = ? AND ${g.scope}`).bind(a.toUserId, o.userId));
    summary[g.key] = { action: "reassign", toUserId: a.toUserId, count: rows.length, ids: rows.map((r) => r.id).slice(0, 200) };
  }
  if (!stmts.length) throw new AppError(422, "nothing_to_hand_over", "Không còn việc nào cần chuyển");
  stmts.push(auditStmt(c, { action: "hr.handover", entity: o.employeeId ? "employee" : "user", entityId: o.employeeId ?? o.userId!, after: { userId: o.userId, employeeId: o.employeeId, groups: summary }, reason: o.reason }));
  // Một batch duy nhất: assertStmt đầu mỗi nhóm → trạng thái đổi giữa chừng thì cả batch rollback (409 state_changed).
  await db.batch(stmts);
  return { done: summary };
}
