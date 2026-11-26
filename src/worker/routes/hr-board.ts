/**
 * Bảng chấm công dạng lưới — hợp đồng: docs/API-attendance-board.md.
 * Gắn vào cùng router `hrRoutes` (routes/hr.ts) để dùng chung onError (trigger DB → 409 dễ hiểu).
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt, type AuditEntry } from "../lib/audit";
import { can, requirePerm } from "../lib/rbac";
import { vnDate, vnPeriod } from "../lib/time";
import { assertStmt } from "../services/guard";
import { parseBody } from "../services/http";
import { addDays, assertPeriodsOpen, eachDate, hrSettings, isDate, leaveBalance, minutesBetween, vnLocalToUtc, weekStart } from "../services/hr-common";
import { loadBoard, selectCellPunches, type BoardCell } from "../services/hr-board";
import { punchFlags } from "../services/hr-timesheet";

type Ctx = Context<AppBindings>;

const dateS = z.string().refine(isDate, "Ngày không hợp lệ (YYYY-MM-DD)");
const timeS = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Giờ không hợp lệ (HH:MM)");
const optTime = z.union([timeS, z.literal(""), z.null()]).optional();
const MAX_BOARD_DAYS = 42;
const MAX_VND_EACH = 100_000_000;

/** Người xem có quyền thấy số tiền phạt/thưởng (dữ liệu lương): hr.sensitive hoặc hr.schedule. */
const moneyOf = (c: Ctx) => {
  const role = c.get("user").role;
  return can(role, "hr.sensitive") || can(role, "hr.schedule");
};
const idOf = (c: Ctx, name = "id") => {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const nowIso = () => new Date().toISOString();
const intQ = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

/** audit_log có entity_id = id dòng vừa INSERT ngay trước trong cùng batch. */
function auditAfterInsert(c: Ctx, e: AuditEntry): D1PreparedStatement {
  const u = c.get("user");
  return c.env.DB
    .prepare(
      `INSERT INTO audit_log(user_id, action, entity, entity_id, before_json, after_json, reason, ip, device_id, request_id)
       VALUES (?,?,?,(SELECT CAST(last_insert_rowid() AS TEXT)),?,?,?,?,?,?)`,
    )
    .bind(
      u?.id ?? null, e.action, e.entity ?? null, e.before !== undefined ? JSON.stringify(e.before) : null, e.after !== undefined ? JSON.stringify(e.after) : null,
      e.reason ?? null, c.req.header("cf-connecting-ip") ?? null, u?.deviceId ?? c.req.header("x-device-id") ?? null, c.get("requestId") ?? null,
    );
}

function boardRange(c: Ctx) {
  const today = vnDate();
  const from = c.req.query("from") ?? weekStart(today);
  const to = c.req.query("to") ?? addDays(from, 6);
  if (!isDate(from) || !isDate(to) || from > to) throw new AppError(422, "validation_error", "Khoảng ngày không hợp lệ");
  if (eachDate(from, to).length > MAX_BOARD_DAYS) throw new AppError(422, "validation_error", `Khoảng ngày tối đa ${MAX_BOARD_DAYS} ngày`);
  return { from, to };
}

export function registerBoardRoutes(hrRoutes: Hono<AppBindings>) {
  // ==========================================================================================
  // Lưới
  // ==========================================================================================
  hrRoutes.get("/attendance/board", requirePerm("hr.view"), async (c) => {
    const { from, to } = boardRange(c);
    const storeId = intQ(c.req.query("storeId"));
    return c.json(await loadBoard(c.env.DB, { from, to, q: c.req.query("q"), storeId, money: moneyOf(c) }));
  });

  hrRoutes.get("/attendance/cell", requirePerm("hr.view"), async (c) => {
    const db = c.env.DB;
    const money = moneyOf(c);
    const aid = intQ(c.req.query("assignmentId"));
    let employeeId = intQ(c.req.query("employeeId"));
    let workDate = c.req.query("workDate");
    let asg: { id: number; startAt: string; endAt: string } | null = null;
    if (aid) {
      const a = await db.prepare(`SELECT id, employee_id, work_date, start_at, end_at FROM shift_assignments WHERE id = ?`).bind(aid).first<any>();
      if (!a) throw notFound("assignment_not_found", "Không tìm thấy ca");
      employeeId = a.employee_id;
      workDate = a.work_date;
      asg = { id: a.id, startAt: a.start_at, endAt: a.end_at };
    }
    if (!employeeId || !workDate || !isDate(workDate)) throw new AppError(422, "validation_error", "Cần assignmentId hoặc employeeId + workDate");
    const emp = await db.prepare(`SELECT id FROM employees WHERE id = ?`).bind(employeeId).first();
    if (!emp) throw notFound("employee_not_found", "Không tìm thấy nhân viên");
    const hs = await hrSettings(db);
    const board = await loadBoard(db, { from: workDate, to: workDate, employeeIds: [employeeId], money, light: true });
    const key = asg ? `a:${asg.id}` : `u:${employeeId}:${workDate}`;
    let cell = board.cells.find((x) => x.key === key);
    if (!cell) {
      if (asg) throw notFound("cell_not_found", "Ô không còn (ca đã huỷ?)");
      const win = hs.attendanceMode === "window";
      const startAt = win ? vnLocalToUtc(workDate, hs.windowStart) : null;
      cell = {
        key, assignmentId: null, employeeId, workDate, shiftId: 0, startAt, endAt: win ? vnLocalToUtc(workDate, hs.windowEnd) : null, inAt: null, outAt: null,
        status: workDate > vnDate() ? "upcoming" : "not_yet", lateMinutes: 0, earlyMinutes: 0, otMinutes: 0, workedMinutes: 0, pending: 0, leaveCode: null, leavePaid: null,
        substituteForId: null, substituteForEmployeeId: null, incidents: money ? { penalty: 0, bonus: 0, amountPenalty: 0, amountBonus: 0 } : { penalty: 0, bonus: 0 }, manual: false,
      } satisfies BoardCell;
    }
    const punchRows = await selectCellPunches(db, { employeeId, workDate, assignment: asg, windowMode: hs.attendanceMode === "window" });
    const corrections = (
      await db
        .prepare(
          `SELECT c.*, du.full_name AS decided_name FROM attendance_corrections c LEFT JOIN users du ON du.id = c.decided_by WHERE c.employee_id = ? AND c.work_date = ? ORDER BY c.id`,
        )
        .bind(employeeId, workDate)
        .all<any>()
    ).results;
    // phạt/thưởng của ô: theo ca; phạt không gắn ca nằm ở ô ngoài lịch (hoặc ô đầu ngày)
    const dayCells = board.cells.filter((x) => x.employeeId === employeeId);
    const home = dayCells.find((x) => x.assignmentId == null) ?? dayCells[0];
    const attachNull = home?.key === key || (!home && !asg);
    const incRows = (
      await db
        .prepare(
          `SELECT i.*, t.name AS type_name, cu.full_name AS created_name FROM attendance_incidents i JOIN attendance_incident_types t ON t.id = i.type_id LEFT JOIN users cu ON cu.id = i.created_by
            WHERE i.employee_id = ? AND i.work_date = ? ORDER BY i.id`,
        )
        .bind(employeeId, workDate)
        .all<any>()
    ).results.filter((i) => (asg ? i.assignment_id === asg.id : i.assignment_id == null) || (asg && i.assignment_id == null && attachNull) || (!asg && i.assignment_id != null && !dayCells.some((x) => x.assignmentId === i.assignment_id)));
    const incidents = incRows.map((i) => ({
      id: i.id, kind: i.kind, typeId: i.type_id, typeName: i.type_name, times: i.times, note: i.note, createdByName: i.created_name, createdAt: i.created_at,
      voided: i.voided_at != null, voidedAt: i.voided_at, voidReason: i.void_reason, ...(money ? { amountEach: i.amount_each, amount: i.amount } : {}),
    }));

    // lịch sử thao tác (audit) của ô / các lần chấm / phạt-thưởng
    const pIds = punchRows.slice(-40).map((p) => String(p.id));
    const iIds = incRows.slice(-40).map((i) => String(i.id));
    const hconds = [`(a.entity = 'attendance_cell' AND a.entity_id = ?)`];
    const hbind: unknown[] = [key];
    if (asg) { hconds.push(`(a.entity = 'shift_assignment' AND a.entity_id = ?)`); hbind.push(String(asg.id)); }
    if (pIds.length) { hconds.push(`(a.entity = 'attendance_punch' AND a.entity_id IN (${pIds.map(() => "?").join(",")}))`); hbind.push(...pIds); }
    if (iIds.length) { hconds.push(`(a.entity = 'attendance_incident' AND a.entity_id IN (${iIds.map(() => "?").join(",")}))`); hbind.push(...iIds); }
    const hist = (
      await db
        .prepare(`SELECT a.at, a.action, a.after_json, a.reason, u.full_name AS by_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${hconds.join(" OR ")} ORDER BY a.id LIMIT 200`)
        .bind(...hbind)
        .all<any>()
    ).results;
    const scrub = (j: string | null) => {
      if (!j) return null;
      try {
        const o = JSON.parse(j);
        if (o && typeof o === "object" && !money) { delete o.amount; delete o.amountEach; }
        return JSON.stringify(o).slice(0, 300);
      } catch { return null; }
    };

    return c.json({
      cell,
      punches: punchRows.map((p) => ({
        id: p.id, kind: p.kind, at: p.at, method: p.method, status: p.status, note: p.note, reviewFlag: !!p.review_flag, assignmentId: p.assignment_id,
        createdByName: p.created_name ?? null, decidedByName: p.decided_name ?? null, decidedAt: p.decided_at ?? null,
      })),
      corrections: corrections.map((r) => ({
        id: r.id, type: r.type, kind: r.kind, requestedAt: r.requested_at, reason: r.reason, status: r.status, decidedByName: r.decided_name ?? null, decidedAt: r.decided_at, decisionNote: r.decision_note,
      })),
      incidents,
      history: hist.map((h) => ({ at: h.at, action: h.action, byName: h.by_name ?? null, detail: h.reason ?? scrub(h.after_json) })),
    });
  });

  // ==========================================================================================
  // Chấm công thủ công (một hoặc nhiều ô)
  // ==========================================================================================
  const manualBody = z.object({
    targets: z.array(z.union([z.object({ assignmentId: z.number().int().positive() }), z.object({ employeeId: z.number().int().positive(), workDate: dateS })])).min(1).max(50),
    type: z.enum(["work", "paid_leave", "unpaid_leave"]),
    inTime: optTime,
    outTime: optTime,
    applyLate: z.boolean().optional(),
    applyEarly: z.boolean().optional(),
    applyOt: z.boolean().optional(),
    substituteEmployeeId: z.number().int().positive().optional(),
    note: z.string().trim().min(3, "Ghi chú tối thiểu 3 ký tự").max(300),
  });

  hrRoutes.post("/attendance/manual", requirePerm("hr.schedule"), async (c) => {
    const b = await parseBody(c, manualBody);
    const db = c.env.DB;
    const uid = c.get("user").id;
    const hs = await hrSettings(db);
    const windowMode = hs.attendanceMode === "window";
    const now = nowIso();

    // 1) xác định các ô
    interface T { key: string; employeeId: number; workDate: string; asg: { id: number; templateId: number; startAt: string; endAt: string; breakMinutes: number; startTime: string } | null }
    const targets: T[] = [];
    for (const t of b.targets) {
      if ("assignmentId" in t) {
        const a = await db
          .prepare(`SELECT sa.*, st.start_time FROM shift_assignments sa JOIN shift_templates st ON st.id = sa.shift_template_id WHERE sa.id = ?`)
          .bind(t.assignmentId)
          .first<any>();
        if (!a) throw notFound("assignment_not_found", `Không tìm thấy ca #${t.assignmentId}`);
        if (a.status !== "scheduled") throw conflict("assignment_cancelled", "Ca đã bị huỷ");
        targets.push({ key: `a:${a.id}`, employeeId: a.employee_id, workDate: a.work_date, asg: { id: a.id, templateId: a.shift_template_id, startAt: a.start_at, endAt: a.end_at, breakMinutes: a.break_minutes, startTime: a.start_time } });
      } else {
        targets.push({ key: `u:${t.employeeId}:${t.workDate}`, employeeId: t.employeeId, workDate: t.workDate, asg: null });
      }
    }
    if (new Set(targets.map((t) => t.key)).size !== targets.length) throw new AppError(422, "validation_error", "Có ô bị chọn trùng");
    if (targets.length > 1) {
      const withAsg = targets.filter((t) => t.asg).length;
      if (withAsg !== 0 && withAsg !== targets.length) throw new AppError(422, "mixed_targets", "Chỉ chọn nhiều ô cùng loại (cùng ca)");
      if (withAsg && new Set(targets.map((t) => t.asg!.templateId)).size > 1) throw new AppError(422, "mixed_shifts", "Chỉ chấm hàng loạt cho các ô cùng một ca");
    }
    const empIds = [...new Set(targets.map((t) => t.employeeId))];
    const emps = new Map((await db.prepare(`SELECT id, status, hire_date, termination_date FROM employees WHERE id IN (${empIds.map(() => "?").join(",")})`).bind(...empIds).all<any>()).results.map((e) => [e.id, e]));
    for (const t of targets) {
      const e = emps.get(t.employeeId);
      if (!e) throw new AppError(422, "employee_not_found", `Nhân viên #${t.employeeId} không tồn tại`);
      if (t.workDate < e.hire_date || (e.termination_date && t.workDate > e.termination_date)) throw new AppError(422, "employee_inactive", `Nhân viên #${t.employeeId} không làm việc ngày ${t.workDate}`);
    }
    await assertPeriodsOpen(db, targets.map((t) => t.workDate));

    const flagList = [b.applyLate === false ? "noLate" : "", b.applyEarly === false ? "noEarly" : "", b.applyOt === false ? "noOt" : ""].filter(Boolean);
    const punchNote = flagList.length ? `${b.note} [flags:${flagList.join(",")}]` : b.note;
    const stmts: D1PreparedStatement[] = [];
    const changedKeys: string[] = [];
    const involved = new Set<number>(empIds);
    const dates = targets.map((t) => t.workDate);

    if (b.type === "work") {
      const inTime = b.inTime || null;
      const outTime = b.outTime || null;
      if (!inTime && !outTime) throw new AppError(422, "time_required", "Nhập giờ vào hoặc giờ ra");
      for (const t of targets) {
        const inAt = inTime ? vnLocalToUtc(t.workDate, inTime) : null;
        let outAt: string | null = null;
        if (outTime) {
          outAt = vnLocalToUtc(t.workDate, outTime);
          if (inAt && outAt <= inAt) outAt = vnLocalToUtc(addDays(t.workDate, 1), outTime);
          else if (!inAt && t.asg && outAt < t.asg.startAt) outAt = vnLocalToUtc(addDays(t.workDate, 1), outTime);
        }
        if (inAt && outAt && minutesBetween(inAt, outAt) > 16 * 60) throw new AppError(422, "validation_error", "Giờ ra quá xa giờ vào");
        for (const at of [inAt, outAt]) if (at && Date.parse(at) > Date.now() + 5 * 60_000) throw new AppError(422, "future_time", "Không chấm công cho thời điểm chưa tới");
        const want = [inAt ? { kind: "in" as const, at: inAt } : null, outAt ? { kind: "out" as const, at: outAt } : null].filter((x): x is { kind: "in" | "out"; at: string } => !!x);
        const existing = (await selectCellPunches(db, { employeeId: t.employeeId, workDate: t.workDate, assignment: t.asg, windowMode, statuses: ["accepted", "pending"] })).filter((p) => want.some((w) => w.kind === p.kind));
        // idempotent: đã đúng y hệt (cùng giờ, cùng cờ, đã chấp nhận) thì không đổi gì
        const same = want.every((w) => {
          const ps = existing.filter((p) => p.kind === w.kind);
          if (ps.length !== 1) return false;
          const f = punchFlags(ps[0].note);
          return ps[0].status === "accepted" && Date.parse(ps[0].at) === Date.parse(w.at) && f.noLate === (b.applyLate === false) && f.noEarly === (b.applyEarly === false) && f.noOt === (b.applyOt === false);
        });
        if (same) continue;
        for (const p of existing) {
          stmts.push(db.prepare(`UPDATE attendance_punches SET status='rejected', note='replaced_by_manual', decided_by=?, decided_at=? WHERE id=? AND status IN ('accepted','pending')`).bind(uid, now, p.id));
        }
        for (const w of want) {
          stmts.push(
            db
              .prepare(
                `INSERT INTO attendance_punches(employee_id, kind, server_at, method, status, assignment_id, created_by, effective_at, note, decided_by, decided_at)
                 VALUES (?,?,?,'manual','accepted',?,?,?,?,?,?)`,
              )
              .bind(t.employeeId, w.kind, w.at, t.asg?.id ?? null, uid, w.at, punchNote, uid, now),
          );
        }
        stmts.push(
          auditStmt(c, {
            action: "attendance.manual", entity: "attendance_cell", entityId: t.key,
            before: { replaced: existing.map((p) => ({ id: p.id, kind: p.kind, at: p.at, status: p.status, method: p.method })) },
            after: { type: "work", inAt, outAt, flags: flagList }, reason: b.note,
          }),
        );
        changedKeys.push(t.key);
      }
    } else {
      const paid = b.type === "paid_leave";
      const lt = await db.prepare(`SELECT id, uses_balance FROM leave_types WHERE paid = ? AND active = 1 ORDER BY id LIMIT 1`).bind(paid ? 1 : 0).first<{ id: number; uses_balance: number }>();
      if (!lt) throw new AppError(422, "leave_type_missing", paid ? "Chưa có loại phép có lương đang dùng" : "Chưa có loại nghỉ không lương đang dùng");
      if (b.substituteEmployeeId && (targets.length !== 1 || !targets[0].asg)) throw new AppError(422, "validation_error", "Người làm thay chỉ dùng khi chọn đúng một ca");
      for (const t of targets) {
        const ex = await db
          .prepare(`SELECT lt.paid FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.employee_id = ? AND lr.status = 'approved' AND lr.from_date <= ? AND lr.to_date >= ?`)
          .bind(t.employeeId, t.workDate, t.workDate)
          .first<{ paid: number }>();
        let leaveDone = false;
        if (ex) {
          if (!!ex.paid !== paid) throw conflict("leave_overlap", "Ngày này đã có đơn nghỉ khác loại được duyệt");
          leaveDone = true;
        }
        const subStmts: D1PreparedStatement[] = [];
        if (b.substituteEmployeeId && t.asg) {
          const sub = b.substituteEmployeeId;
          if (sub === t.employeeId) throw new AppError(422, "validation_error", "Người làm thay phải khác người nghỉ");
          const se = await db.prepare(`SELECT id, status, hire_date, termination_date FROM employees WHERE id = ?`).bind(sub).first<any>();
          if (!se || se.status !== "active" || t.workDate < se.hire_date || (se.termination_date && t.workDate > se.termination_date)) throw new AppError(422, "employee_inactive", "Người làm thay không hợp lệ hoặc đã nghỉ việc");
          involved.add(sub);
          const linked = await db.prepare(`SELECT id FROM shift_assignments WHERE substitute_for_id = ? AND employee_id = ? AND status = 'scheduled'`).bind(t.asg.id, sub).first();
          if (!linked) {
            const busy = await db.prepare(`SELECT id FROM shift_assignments WHERE employee_id = ? AND status = 'scheduled' AND start_at < ? AND end_at > ?`).bind(sub, t.asg.endAt, t.asg.startAt).first();
            if (busy) throw conflict("substitute_busy", "Người làm thay đã có ca trùng giờ");
            subStmts.push(
              db
                .prepare(
                  `INSERT INTO shift_assignments(employee_id, work_date, shift_template_id, start_at, end_at, break_minutes, created_by, substitute_for_id) VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(employee_id, work_date, shift_template_id) DO UPDATE SET status='scheduled', start_at=excluded.start_at, end_at=excluded.end_at, break_minutes=excluded.break_minutes, substitute_for_id=excluded.substitute_for_id
                     WHERE shift_assignments.status = 'cancelled'`,
                )
                .bind(sub, t.workDate, t.asg.templateId, t.asg.startAt, t.asg.endAt, t.asg.breakMinutes, uid, t.asg.id),
            );
          }
        }
        if (leaveDone && !subStmts.length) continue;
        if (!leaveDone) {
          const bal = lt.uses_balance ? await leaveBalance(db, t.employeeId, Number(t.workDate.slice(0, 4))) : null;
          const over = bal && bal.remainingX10 < 10 ? 1 : 0;
          stmts.push(
            db
              .prepare(
                `INSERT INTO leave_requests(employee_id, leave_type_id, from_date, to_date, half_day, days_x10, reason, status, over_balance, requested_by, decided_by, decided_at)
                 VALUES (?,?,?,?,0,10,?,'approved',?,?,?,?)`,
              )
              .bind(t.employeeId, lt.id, t.workDate, t.workDate, b.note, over, uid, uid, now),
          );
        }
        stmts.push(...subStmts);
        stmts.push(
          auditStmt(c, {
            action: "attendance.manual", entity: "attendance_cell", entityId: t.key,
            after: { type: b.type, substituteEmployeeId: b.substituteEmployeeId ?? null }, reason: b.note,
          }),
        );
        changedKeys.push(t.key);
      }
    }

    if (stmts.length) {
      const asgIds = targets.filter((t) => t.asg).map((t) => t.asg!.id);
      const guard = asgIds.length ? [assertStmt(db, "attendance.manual", `SELECT COUNT(*) = ? FROM shift_assignments WHERE id IN (${asgIds.map(() => "?").join(",")}) AND status = 'scheduled'`, [asgIds.length, ...asgIds])] : [];
      await db.batch([...guard, ...stmts]);
    }

    const from = dates.reduce((a, d) => (d < a ? d : a));
    const to = dates.reduce((a, d) => (d > a ? d : a));
    const board = await loadBoard(db, { from, to, employeeIds: [...involved], money: moneyOf(c), light: true });
    const wanted = new Set(targets.map((t) => t.key));
    const subAsg = b.substituteEmployeeId && targets[0]?.asg ? (await db.prepare(`SELECT id FROM shift_assignments WHERE substitute_for_id = ? AND status = 'scheduled'`).bind(targets[0].asg.id).all<{ id: number }>()).results.map((r) => `a:${r.id}`) : [];
    for (const k of subAsg) wanted.add(k);
    return c.json({ updated: changedKeys.length, cells: board.cells.filter((x) => wanted.has(x.key)) });
  });

  // ==========================================================================================
  // Đổi ca trực tiếp
  // ==========================================================================================
  hrRoutes.post("/schedule/:id/reassign", requirePerm("hr.schedule"), async (c) => {
    const id = idOf(c);
    const b = await parseBody(c, z.object({ employeeId: z.number().int().positive(), reason: z.string().trim().min(3).max(300) }));
    const db = c.env.DB;
    const a = await db.prepare(`SELECT * FROM shift_assignments WHERE id = ?`).bind(id).first<any>();
    if (!a) throw notFound("assignment_not_found", "Không tìm thấy ca");
    if (a.status !== "scheduled") throw conflict("assignment_cancelled", "Ca đã bị huỷ");
    if (a.employee_id === b.employeeId) throw new AppError(422, "validation_error", "Nhân viên mới trùng nhân viên hiện tại");
    await assertPeriodsOpen(db, [a.work_date]);
    const e = await db.prepare(`SELECT id, full_name, status, hire_date, termination_date FROM employees WHERE id = ?`).bind(b.employeeId).first<any>();
    if (!e) throw new AppError(422, "employee_not_found", "Nhân viên không tồn tại");
    if (e.status !== "active" || a.work_date < e.hire_date || (e.termination_date && a.work_date > e.termination_date)) throw new AppError(422, "employee_inactive", "Nhân viên không làm việc ngày này");
    const punched = await db.prepare(`SELECT COUNT(*) n FROM attendance_punches WHERE assignment_id = ? AND status IN ('accepted','pending')`).bind(id).first<{ n: number }>();
    if (punched?.n) throw conflict("has_punches", "Ca đã có lần chấm công, không đổi người được");
    const inc = await db.prepare(`SELECT COUNT(*) n FROM attendance_incidents WHERE assignment_id = ? AND voided_at IS NULL`).bind(id).first<{ n: number }>();
    if (inc?.n) throw conflict("has_incidents", "Ca đã có phạt/thưởng, hãy huỷ chúng trước khi đổi người");
    const busy = await db.prepare(`SELECT id FROM shift_assignments WHERE employee_id = ? AND status = 'scheduled' AND start_at < ? AND end_at > ?`).bind(b.employeeId, a.end_at, a.start_at).first();
    if (busy) throw conflict("employee_busy", "Nhân viên mới đã có ca trùng giờ");
    const dup = await db.prepare(`SELECT id FROM shift_assignments WHERE employee_id = ? AND work_date = ? AND shift_template_id = ?`).bind(b.employeeId, a.work_date, a.shift_template_id).first();
    if (dup) throw conflict("duplicate", "Nhân viên mới từng được xếp ca này (đã huỷ): hãy xếp lại bằng Xếp lịch");
    await db.batch([
      assertStmt(db, "schedule.reassign", `SELECT status = 'scheduled' AND employee_id = ? AND NOT EXISTS (SELECT 1 FROM attendance_punches WHERE assignment_id = ? AND status IN ('accepted','pending')) FROM shift_assignments WHERE id = ?`, [a.employee_id, id, id]),
      db.prepare(`UPDATE shift_assignments SET employee_id = ? WHERE id = ? AND employee_id = ? AND status = 'scheduled'`).bind(b.employeeId, id, a.employee_id),
      auditStmt(c, { action: "hr.schedule.reassign", entity: "shift_assignment", entityId: id, before: { employeeId: a.employee_id }, after: { employeeId: b.employeeId }, reason: b.reason }),
    ]);
    const r = await db.prepare(`SELECT sa.*, e.full_name, st.name AS shift_name FROM shift_assignments sa JOIN employees e ON e.id = sa.employee_id JOIN shift_templates st ON st.id = sa.shift_template_id WHERE sa.id = ?`).bind(id).first<any>();
    return c.json({ id, employeeId: r.employee_id, employeeName: r.full_name, workDate: r.work_date, shiftTemplateId: r.shift_template_id, shiftName: r.shift_name, startAt: r.start_at, endAt: r.end_at, status: r.status });
  });

  // ==========================================================================================
  // Loại phạt / thưởng
  // ==========================================================================================
  const mapType = (r: any, money: boolean) => ({ id: r.id, kind: r.kind, name: r.name, defaultAmount: money ? r.default_amount : null, active: !!r.active });

  hrRoutes.get("/attendance/incident-types", requirePerm("hr.view"), async (c) => {
    const kind = c.req.query("kind");
    if (kind && kind !== "penalty" && kind !== "bonus") throw new AppError(422, "validation_error", "kind chỉ nhận penalty | bonus");
    const { results } = await c.env.DB.prepare(`SELECT * FROM attendance_incident_types ${kind ? "WHERE kind = ?" : ""} ORDER BY kind, id`).bind(...(kind ? [kind] : [])).all<any>();
    const money = moneyOf(c);
    return c.json({ items: results.map((r) => mapType(r, money)) });
  });

  hrRoutes.post("/attendance/incident-types", requirePerm("hr.manage"), async (c) => {
    const b = await parseBody(c, z.object({ kind: z.enum(["penalty", "bonus"]), name: z.string().trim().min(1).max(80), defaultAmount: z.number().int().min(0).max(MAX_VND_EACH) }));
    const db = c.env.DB;
    let res: D1Result[];
    try {
      res = await db.batch([
        db.prepare(`INSERT INTO attendance_incident_types(kind, name, default_amount) VALUES (?,?,?)`).bind(b.kind, b.name, b.defaultAmount),
        auditAfterInsert(c, { action: "attendance.incident_type.create", entity: "attendance_incident_type", after: b }),
      ]);
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) throw conflict("duplicate", "Loại này đã tồn tại");
      throw e;
    }
    const id = res[0].meta.last_row_id as number;
    return c.json(mapType(await db.prepare(`SELECT * FROM attendance_incident_types WHERE id = ?`).bind(id).first(), true), 201);
  });

  hrRoutes.put("/attendance/incident-types/:id", requirePerm("hr.manage"), async (c) => {
    const id = idOf(c);
    const b = await parseBody(c, z.object({ name: z.string().trim().min(1).max(80).optional(), defaultAmount: z.number().int().min(0).max(MAX_VND_EACH).optional(), active: z.boolean().optional() }));
    const db = c.env.DB;
    const before = await db.prepare(`SELECT * FROM attendance_incident_types WHERE id = ?`).bind(id).first<any>();
    if (!before) throw notFound("incident_type_not_found", "Không tìm thấy loại vi phạm/thưởng");
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.name !== undefined) { sets.push("name = ?"); vals.push(b.name); }
    if (b.defaultAmount !== undefined) { sets.push("default_amount = ?"); vals.push(b.defaultAmount); }
    if (b.active !== undefined) { sets.push("active = ?"); vals.push(b.active ? 1 : 0); }
    if (!sets.length) throw new AppError(422, "validation_error", "Không có thay đổi nào");
    try {
      await db.batch([
        db.prepare(`UPDATE attendance_incident_types SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id),
        auditStmt(c, { action: "attendance.incident_type.update", entity: "attendance_incident_type", entityId: id, before: { name: before.name, defaultAmount: before.default_amount, active: !!before.active }, after: b }),
      ]);
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) throw conflict("duplicate", "Tên loại đã tồn tại");
      throw e;
    }
    return c.json(mapType(await db.prepare(`SELECT * FROM attendance_incident_types WHERE id = ?`).bind(id).first(), true));
  });

  // ==========================================================================================
  // Phạt / thưởng theo ca
  // ==========================================================================================
  hrRoutes.post("/attendance/incidents", requirePerm("hr.schedule"), async (c) => {
    const b = await parseBody(
      c,
      z.object({
        employeeId: z.number().int().positive(),
        workDate: dateS,
        assignmentId: z.number().int().positive().optional(),
        typeId: z.number().int().positive(),
        times: z.number().int().min(1).max(100),
        amountEach: z.number().int().min(0).max(MAX_VND_EACH).optional(),
        note: z.string().trim().max(300).optional(),
      }),
    );
    const db = c.env.DB;
    const emp = await db.prepare(`SELECT id, hire_date, termination_date FROM employees WHERE id = ?`).bind(b.employeeId).first<any>();
    if (!emp) throw new AppError(422, "employee_not_found", "Nhân viên không tồn tại");
    if (b.workDate < emp.hire_date || (emp.termination_date && b.workDate > emp.termination_date)) throw new AppError(422, "employee_inactive", "Nhân viên không làm việc ngày này");
    const t = await db.prepare(`SELECT * FROM attendance_incident_types WHERE id = ?`).bind(b.typeId).first<any>();
    if (!t) throw new AppError(422, "incident_type_not_found", "Loại vi phạm/thưởng không tồn tại");
    if (!t.active) throw new AppError(422, "incident_type_inactive", "Loại này đã ngừng dùng");
    if (b.assignmentId) {
      const a = await db.prepare(`SELECT employee_id, work_date FROM shift_assignments WHERE id = ?`).bind(b.assignmentId).first<any>();
      if (!a || a.employee_id !== b.employeeId || a.work_date !== b.workDate) throw new AppError(422, "assignment_mismatch", "Ca không thuộc nhân viên/ngày này");
    }
    const amountEach = b.amountEach ?? t.default_amount;
    const amount = amountEach * b.times;
    const locked = await db.prepare(`SELECT 1 x FROM payroll_periods WHERE period = ? AND status IN ('approved','paid')`).bind(b.workDate.slice(0, 7)).first();
    if (locked) throw conflict("payroll_locked", "Kỳ lương đã duyệt/đã chi: không ghi thêm phạt/thưởng cho kỳ này");
    const res = await db.batch([
      db
        .prepare(`INSERT INTO attendance_incidents(employee_id, work_date, assignment_id, type_id, kind, times, amount_each, amount, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(b.employeeId, b.workDate, b.assignmentId ?? null, b.typeId, t.kind, b.times, amountEach, amount, b.note ?? null, c.get("user").id),
      auditAfterInsert(c, { action: `attendance.incident.${t.kind}`, entity: "attendance_incident", after: { employeeId: b.employeeId, workDate: b.workDate, assignmentId: b.assignmentId ?? null, typeId: b.typeId, kind: t.kind, times: b.times, amountEach, amount }, reason: b.note }),
    ]);
    const id = res[0].meta.last_row_id as number;
    const money = moneyOf(c);
    return c.json({ id, employeeId: b.employeeId, workDate: b.workDate, assignmentId: b.assignmentId ?? null, typeId: b.typeId, typeName: t.name, kind: t.kind, times: b.times, note: b.note ?? null, voided: false, ...(money ? { amountEach, amount } : {}) }, 201);
  });

  hrRoutes.post("/attendance/incidents/:id/void", requirePerm("hr.schedule"), async (c) => {
    const id = idOf(c);
    const b = await parseBody(c, z.object({ reason: z.string().trim().min(3).max(300) }));
    const db = c.env.DB;
    const i = await db.prepare(`SELECT * FROM attendance_incidents WHERE id = ?`).bind(id).first<any>();
    if (!i) throw notFound("incident_not_found", "Không tìm thấy phạt/thưởng");
    if (i.voided_at) throw conflict("already_voided", "Đã huỷ trước đó");
    const locked = await db.prepare(`SELECT 1 x FROM payroll_periods WHERE period = ? AND status IN ('approved','paid')`).bind(i.work_date.slice(0, 7)).first();
    if (locked) throw conflict("payroll_locked", "Kỳ lương đã duyệt/đã chi: không huỷ được phạt/thưởng của kỳ này");
    const uid = c.get("user").id;
    await db.batch([
      assertStmt(db, "incident.void", `SELECT voided_at IS NULL FROM attendance_incidents WHERE id = ?`, [id]),
      db.prepare(`UPDATE attendance_incidents SET voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL`).bind(uid, nowIso(), b.reason, id),
      auditStmt(c, { action: "attendance.incident.void", entity: "attendance_incident", entityId: id, before: { voided: false }, after: { voided: true }, reason: b.reason }),
    ]);
    return c.json({ id, voided: true });
  });

  hrRoutes.get("/attendance/incidents", requirePerm("hr.view"), async (c) => {
    const q = c.req.query();
    const today = vnDate();
    const from = q.from ?? `${vnPeriod()}-01`;
    const to = q.to ?? today;
    if (!isDate(from) || !isDate(to) || from > to) throw new AppError(422, "validation_error", "Khoảng ngày không hợp lệ");
    if (eachDate(from, to).length > 93) throw new AppError(422, "validation_error", "Khoảng ngày tối đa 93 ngày");
    if (q.kind && q.kind !== "penalty" && q.kind !== "bonus") throw new AppError(422, "validation_error", "kind chỉ nhận penalty | bonus");
    const conds = [`i.work_date >= ?`, `i.work_date <= ?`];
    const params: unknown[] = [from, to];
    const eid = intQ(q.employeeId);
    if (eid) { conds.push(`i.employee_id = ?`); params.push(eid); }
    if (q.kind) { conds.push(`i.kind = ?`); params.push(q.kind); }
    const { results } = await c.env.DB
      .prepare(
        `SELECT i.*, e.full_name, t.name AS type_name, st.name AS shift_name, cu.full_name AS created_name
           FROM attendance_incidents i JOIN employees e ON e.id = i.employee_id JOIN attendance_incident_types t ON t.id = i.type_id
           LEFT JOIN shift_assignments sa ON sa.id = i.assignment_id LEFT JOIN shift_templates st ON st.id = sa.shift_template_id LEFT JOIN users cu ON cu.id = i.created_by
          WHERE ${conds.join(" AND ")} ORDER BY i.work_date, i.id LIMIT 2000`,
      )
      .bind(...params)
      .all<any>();
    const money = moneyOf(c);
    const items = results.map((i) => ({
      id: i.id, employeeId: i.employee_id, employeeName: i.full_name, workDate: i.work_date, shiftName: i.shift_name ?? null, kind: i.kind, typeName: i.type_name, times: i.times,
      ...(money ? { amountEach: i.amount_each, amount: i.amount } : {}),
      note: i.note, createdByName: i.created_name ?? null, createdAt: i.created_at, voided: i.voided_at != null, voidReason: i.void_reason ?? null,
    }));
    const body: Record<string, unknown> = { items };
    if (money) {
      const totals = { penalty: 0, bonus: 0 };
      for (const i of results) if (!i.voided_at) totals[i.kind as "penalty" | "bonus"] += i.amount;
      body.totals = totals;
    }
    return c.json(body);
  });
}
