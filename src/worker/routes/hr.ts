import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { AppError, conflict, forbidden, notFound, onError } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { assertStmt } from "../services/guard";
import { hashPassword, randomToken } from "../lib/crypto";
import { can, requirePerm } from "../lib/rbac";
import { vnDate, vnDayRangeUtc } from "../lib/time";
import { pageParams, parseBody } from "../services/http";
import {
  addDays, assertPeriodsOpen, eachDate, employeeOfUser, hrSettings, isDate, isPeriod, leaveBalance, minutesBetween, shiftWindow,
} from "../services/hr-common";
import { haversineM } from "../services/hr-geo";
import { makeQrCode, qrWindowExpiresAt, qrWindowOf, verifyQrCode } from "../services/hr-qr";
import { MAX_SHIFT_MINUTES, collectUnresolved, computeTimesheet, computeTimesheetLive, hasUnresolved, snapshotStatements } from "../services/hr-timesheet";

type Ctx = Context<AppBindings>;
export const hrRoutes = new Hono<AppBindings>();

// Lỗi trigger DB → 409 dễ hiểu (nhật ký chấm công bất biến, bảng công đã chốt).
hrRoutes.onError((err, c) => {
  const m = String(err?.message ?? "");
  if (m.includes("attendance_immutable")) return onError(conflict("attendance_immutable", "Nhật ký chấm công không được sửa/xoá — dùng yêu cầu bổ sung"), c);
  if (m.includes("timesheet_closed")) return onError(conflict("timesheet_closed", "Kỳ công đã chốt, không thể sửa"), c);
  return onError(err, c);
});

const dateS = z.string().refine(isDate, "Ngày không hợp lệ (YYYY-MM-DD)");
const timeS = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Giờ không hợp lệ (HH:MM)");
const idOf = (c: Ctx, name = "id") => {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const sensOf = (c: Ctx) => can(c.get("user").role, "hr.sensitive");
const bool = (v: unknown) => !!v;
const nowIso = () => new Date().toISOString();

/** Segregation of duties: người duyệt không được là người yêu cầu / đối tượng của yêu cầu (trừ chủ). */
async function assertNotSelf(c: Ctx, o: { requestedBy?: number | null; employeeIds?: (number | null | undefined)[]; userIds?: (number | null | undefined)[] }) {
  const u = c.get("user");
  if (u.role === "owner") return;
  const selfErr = () => new AppError(403, "self_approval", "Không được tự duyệt yêu cầu của chính mình");
  if (o.requestedBy != null && o.requestedBy === u.id) throw selfErr();
  if (o.userIds?.some((x) => x != null && x === u.id)) throw selfErr();
  const ids = (o.employeeIds ?? []).filter((x): x is number => x != null);
  if (ids.length) {
    const mine = await c.env.DB.prepare(`SELECT id FROM employees WHERE user_id = ?`).bind(u.id).first<{ id: number }>();
    if (mine && ids.includes(mine.id)) throw selfErr();
  }
}
const SENS_FIELDS = new Set(["baseSalary", "hourlyRate", "shiftRate", "insuranceSalary", "idNumber", "bankAccount", "bankName", "dob", "address", "dependents", "salary", "amount", "phone", "email", "pitEnabled"]);
/** Nhật ký chỉ ghi TÊN trường nhạy cảm đã đổi, không ghi giá trị. */
function redactSens(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const [k, v] of Object.entries(o)) (SENS_FIELDS.has(k) ? changed.push(k) : (out[k] = v));
  if (changed.length) out.changed = changed;
  return out;
}
const SENS_ERR = () => forbidden("sensitive_forbidden", "Cần quyền xem dữ liệu nhạy cảm (lương, CCCD, ngân hàng…)");

// ============================================================================================
// Hồ sơ nhân viên
// ============================================================================================

const EMP_SELECT = `SELECT e.*, u.username FROM employees e LEFT JOIN users u ON u.id = e.user_id`;

function mapEmployee(r: any, sens: boolean, detail = false) {
  const o: Record<string, unknown> = {
    id: r.id, code: r.code, fullName: r.full_name, position: r.position, storeId: r.store_id, status: r.status,
    hireDate: r.hire_date, terminationDate: r.termination_date, payType: r.pay_type, userId: r.user_id,
    username: r.username ?? null, locationExempt: bool(r.location_exempt), annualLeaveDays: r.annual_leave_days, version: r.version,
  };
  if (sens) {
    Object.assign(o, {
      baseSalary: r.base_salary, hourlyRate: r.hourly_rate, shiftRate: r.shift_rate, insuranceSalary: r.insurance_salary,
      phone: r.phone, email: r.email, pitEnabled: bool(r.pit_enabled),
    });
    if (detail) Object.assign(o, { idNumber: r.id_number, address: r.address, dob: r.dob, bankName: r.bank_name, bankAccount: r.bank_account, dependents: r.dependents, note: r.note });
  }
  return o;
}

hrRoutes.get("/employees", requirePerm("hr.view"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.status) { conds.push(`e.status = ?`); params.push(q.status); }
  if (q.q) { conds.push(`(e.full_name LIKE ? OR e.code LIKE ?)`); params.push(`%${q.q}%`, `%${q.q}%`); }
  const { limit, cursor } = pageParams(c);
  if (cursor) { conds.push(`e.id > ?`); params.push(cursor); }
  const { results } = await c.env.DB
    .prepare(`${EMP_SELECT} ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY e.id LIMIT ?`)
    .bind(...params, limit + 1)
    .all<any>();
  const sens = sensOf(c);
  const rows = results.slice(0, limit);
  if (sens) await auditStmt(c, { action: "hr.view_sensitive", entity: "employee", after: { list: true, count: rows.length } }).run();
  return c.json({ items: rows.map((r) => mapEmployee(r, sens)), nextCursor: results.length > limit ? String(rows[rows.length - 1].id) : null });
});

async function employeeDetail(c: Ctx, id: number) {
  const db = c.env.DB;
  const r = await db.prepare(`${EMP_SELECT} WHERE e.id = ?`).bind(id).first<any>();
  if (!r) throw notFound("employee_not_found", "Không tìm thấy nhân viên");
  const sens = sensOf(c);
  const [ct, al] = await Promise.all([
    db.prepare(`SELECT * FROM employee_contracts WHERE employee_id = ? ORDER BY start_date DESC, id DESC`).bind(id).all<any>(),
    db.prepare(`SELECT * FROM employee_allowances WHERE employee_id = ? ORDER BY id`).bind(id).all<any>(),
  ]);
  return {
    ...mapEmployee(r, sens, true),
    contracts: ct.results.map((x) => ({ id: x.id, type: x.type, startDate: x.start_date, endDate: x.end_date, fileKey: x.file_key, note: x.note, ...(sens ? { salary: x.salary } : {}) })),
    allowances: al.results.map((x) => ({ id: x.id, name: x.name, taxable: bool(x.taxable), active: bool(x.active), ...(sens ? { amount: x.amount } : {}) })),
    leaveBalance: await leaveBalance(db, id, Number(vnDate().slice(0, 4))),
  };
}

hrRoutes.get("/employees/:id", requirePerm("hr.view"), async (c) => {
  const id = idOf(c);
  const out = await employeeDetail(c, id);
  if (sensOf(c)) await auditStmt(c, { action: "hr.view_sensitive", entity: "employee", entityId: id }).run();
  return c.json(out);
});

const money = z.number().int().min(0).max(10_000_000_000);
const empFields = {
  fullName: z.string().trim().min(1).max(100),
  position: z.string().trim().min(1).max(100),
  storeId: z.number().int().positive(),
  hireDate: dateS,
  payType: z.enum(["monthly", "hourly", "shift"]),
  locationExempt: z.boolean(),
  annualLeaveDays: z.number().int().min(0).max(60),
  baseSalary: money, hourlyRate: money, shiftRate: money, insuranceSalary: money,
  dependents: z.number().int().min(0).max(20),
  pitEnabled: z.boolean(),
  phone: z.string().trim().max(30).nullable(),
  email: z.string().trim().email().max(120).nullable(),
  idNumber: z.string().trim().max(30).nullable(),
  dob: dateS.nullable(),
  address: z.string().trim().max(300).nullable(),
  bankName: z.string().trim().max(100).nullable(),
  bankAccount: z.string().trim().max(40).nullable(),
  note: z.string().trim().max(500).nullable(),
};
// khoá body → [cột, nhạy cảm?]
const EMP_COLS: Record<string, [string, boolean]> = {
  fullName: ["full_name", false], position: ["position", false], storeId: ["store_id", false], hireDate: ["hire_date", false],
  payType: ["pay_type", false], locationExempt: ["location_exempt", false], annualLeaveDays: ["annual_leave_days", false],
  baseSalary: ["base_salary", true], hourlyRate: ["hourly_rate", true], shiftRate: ["shift_rate", true], insuranceSalary: ["insurance_salary", true],
  dependents: ["dependents", true], pitEnabled: ["pit_enabled", true], phone: ["phone", true], email: ["email", true], idNumber: ["id_number", true],
  dob: ["dob", true], address: ["address", true], bankName: ["bank_name", true], bankAccount: ["bank_account", true], note: ["note", true],
};
const ROLE_ENUM = ["owner", "manager", "cashier", "warehouse", "accountant", "online_staff", "staff"] as const;

const createEmp = z.object({
  fullName: empFields.fullName, position: empFields.position, storeId: empFields.storeId, hireDate: empFields.hireDate, payType: empFields.payType,
  baseSalary: empFields.baseSalary.optional(), hourlyRate: empFields.hourlyRate.optional(), shiftRate: empFields.shiftRate.optional(),
  insuranceSalary: empFields.insuranceSalary.optional(), dependents: empFields.dependents.optional(),
  phone: empFields.phone.optional(), email: empFields.email.optional(), idNumber: empFields.idNumber.optional(), dob: empFields.dob.optional(),
  address: empFields.address.optional(), bankName: empFields.bankName.optional(), bankAccount: empFields.bankAccount.optional(),
  annualLeaveDays: empFields.annualLeaveDays.optional(), locationExempt: empFields.locationExempt.optional(),
  createUser: z.object({ username: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9._-]+$/), role: z.enum(ROLE_ENUM).default("staff") }).optional(),
});

hrRoutes.post("/employees", requirePerm("hr.manage"), async (c) => {
  const body = await parseBody(c, createEmp);
  const db = c.env.DB;
  const sens = sensOf(c);
  for (const [k, [, s]] of Object.entries(EMP_COLS)) if (s && (body as any)[k] !== undefined && !sens) throw SENS_ERR();
  const store = await db.prepare(`SELECT id FROM stores WHERE id = ?`).bind(body.storeId).first();
  if (!store) throw new AppError(422, "invalid_store", "Cửa hàng không tồn tại");
  let tempPassword: string | undefined;
  const userStmts: D1PreparedStatement[] = [];
  if (body.createUser) {
    const callerRole = c.get("user").role;
    const r = body.createUser.role;
    if (callerRole === "owner" ? r === "owner" : r !== "staff") throw forbidden("role_forbidden", "Không đủ quyền tạo tài khoản với vai trò này");
    const dup = await db.prepare(`SELECT id FROM users WHERE username = ?`).bind(body.createUser.username).first();
    if (dup) throw conflict("username_taken", "Tên đăng nhập đã tồn tại");
    tempPassword = randomToken(9);
    userStmts.push(
      db.prepare(`INSERT INTO users(username, full_name, pass_hash, role, store_id, must_change_password) VALUES (?,?,?,?,?,1)`)
        .bind(body.createUser.username, body.fullName, await hashPassword(tempPassword), body.createUser.role, body.storeId),
    );
  }
  let id = 0;
  for (let attempt = 0; attempt < 4 && !id; attempt++) {
    try {
      const res = await db.batch([
        ...userStmts,
        db.prepare(
          `INSERT INTO employees(code, user_id, full_name, phone, email, dob, id_number, address, position, store_id, hire_date, pay_type,
             base_salary, hourly_rate, shift_rate, insurance_salary, dependents, annual_leave_days, location_exempt, bank_name, bank_account)
           VALUES ('NV-' || printf('%04d', (SELECT COALESCE(MAX(CAST(SUBSTR(code,4) AS INTEGER)),0)+1 FROM employees WHERE code GLOB 'NV-[0-9]*')),
             ${body.createUser ? `(SELECT id FROM users WHERE username = ?)` : "NULL"}, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          ...(body.createUser ? [body.createUser.username] : []),
          body.fullName, body.phone ?? null, body.email ?? null, body.dob ?? null, body.idNumber ?? null, body.address ?? null, body.position,
          body.storeId, body.hireDate, body.payType, body.baseSalary ?? 0, body.hourlyRate ?? 0, body.shiftRate ?? 0, body.insuranceSalary ?? 0,
          body.dependents ?? 0, body.annualLeaveDays ?? 12, body.locationExempt ? 1 : 0, body.bankName ?? null, body.bankAccount ?? null,
        ),
      ]);
      id = res[res.length - 1].meta.last_row_id as number;
    } catch (e) {
      const m = String((e as Error).message);
      if (m.includes("employees.code") && attempt < 3) continue; // đụng mã đồng thời → thử lại
      if (m.includes("users.username")) throw conflict("username_taken", "Tên đăng nhập đã tồn tại");
      throw e;
    }
  }
  const { fullName, createUser, ...rest } = body;
  await auditStmt(c, { action: "hr.employee.create", entity: "employee", entityId: id, after: { fullName, createUser: createUser?.username, fields: Object.keys(rest) } }).run();
  const out = await employeeDetail(c, id);
  return c.json(tempPassword ? { ...out, tempPassword } : out, 201);
});

hrRoutes.put("/employees/:id", requirePerm("hr.manage"), async (c) => {
  const id = idOf(c);
  const body = await parseBody(c, z.object({ ...Object.fromEntries(Object.entries(empFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])), version: z.number().int().positive() }) as z.ZodType<Record<string, any>>);
  const db = c.env.DB;
  const sens = sensOf(c);
  const before = await db.prepare(`SELECT * FROM employees WHERE id = ?`).bind(id).first<any>();
  if (!before) throw notFound("employee_not_found", "Không tìm thấy nhân viên");
  if (before.version !== body.version) throw conflict("version_conflict", "Hồ sơ vừa được người khác sửa, hãy tải lại");
  const sets: string[] = [];
  const params: unknown[] = [];
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const [k, [col, s]] of Object.entries(EMP_COLS)) {
    if (body[k] === undefined) continue;
    if (s && !sens) throw SENS_ERR();
    const v = typeof body[k] === "boolean" ? (body[k] ? 1 : 0) : body[k];
    sets.push(`${col} = ?`);
    params.push(v);
    b[k] = before[col];
    a[k] = v;
  }
  if (body.storeId !== undefined && !(await db.prepare(`SELECT id FROM stores WHERE id=?`).bind(body.storeId).first())) throw new AppError(422, "invalid_store", "Cửa hàng không tồn tại");
  if (!sets.length) throw new AppError(422, "validation_error", "Không có thay đổi nào");
  const res = await db.batch([
    db.prepare(`UPDATE employees SET ${sets.join(", ")}, version = version + 1 WHERE id = ? AND version = ?`).bind(...params, id, body.version),
    auditStmt(c, { action: "hr.employee.update", entity: "employee", entityId: id, before: redactSens(b), after: redactSens(a) }),
  ]);
  if (res[0].meta.changes === 0) throw conflict("version_conflict", "Hồ sơ vừa được người khác sửa, hãy tải lại");
  return c.json(await employeeDetail(c, id));
});

hrRoutes.post("/employees/:id/terminate", requirePerm("hr.manage"), async (c) => {
  const id = idOf(c);
  const body = await parseBody(c, z.object({ terminationDate: dateS, reason: z.string().trim().min(1).max(300) }));
  const db = c.env.DB;
  const e = await db.prepare(`SELECT id, user_id, status, hire_date FROM employees WHERE id = ?`).bind(id).first<any>();
  if (!e) throw notFound("employee_not_found", "Không tìm thấy nhân viên");
  if (e.status === "terminated") throw conflict("already_terminated", "Nhân viên đã nghỉ việc");
  if (e.user_id) {
    const me = c.get("user");
    const tu = await db.prepare(`SELECT role FROM users WHERE id = ?`).bind(e.user_id).first<{ role: string }>();
    if (e.user_id === me.id || (me.role !== "owner" && tu && ["owner", "manager", "accountant"].includes(tu.role))) {
      throw forbidden("terminate_forbidden", "Không được cho nghỉ việc / khoá tài khoản này");
    }
  }
  if (body.terminationDate < e.hire_date) throw new AppError(422, "validation_error", "Ngày nghỉ việc trước ngày vào làm");
  const at = nowIso();
  const stmts = [
    db.prepare(`UPDATE employees SET status='terminated', termination_date=?, note = COALESCE(note || char(10), '') || ?, version = version + 1 WHERE id=?`).bind(body.terminationDate, `Nghỉ việc ${body.terminationDate}: ${body.reason}`, id),
    db.prepare(`UPDATE shift_assignments SET status='cancelled' WHERE employee_id=? AND work_date > ? AND status='scheduled'`).bind(id, body.terminationDate),
  ];
  if (e.user_id) {
    stmts.push(db.prepare(`UPDATE users SET active=0 WHERE id=?`).bind(e.user_id));
    stmts.push(db.prepare(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`).bind(at, e.user_id));
  }
  stmts.push(auditStmt(c, { action: "hr.employee.terminate", entity: "employee", entityId: id, before: { status: "active" }, after: { status: "terminated", terminationDate: body.terminationDate }, reason: body.reason }));
  await db.batch(stmts);
  return c.json(await employeeDetail(c, id));
});

// ----- Hợp đồng & phụ cấp -----
async function requireEmployee(c: Ctx, id: number) {
  const e = await c.env.DB.prepare(`SELECT id FROM employees WHERE id=?`).bind(id).first();
  if (!e) throw notFound("employee_not_found", "Không tìm thấy nhân viên");
}
const contractBody = z.object({
  type: z.string().trim().min(1).max(60), startDate: dateS, endDate: dateS.nullable().optional(),
  salary: money.nullable().optional(), fileKey: z.string().max(200).nullable().optional(), note: z.string().max(500).nullable().optional(),
});

hrRoutes.post("/employees/:id/contracts", requirePerm("hr.manage"), async (c) => {
  const id = idOf(c);
  const b = await parseBody(c, contractBody);
  await requireEmployee(c, id);
  if (b.salary != null && !sensOf(c)) throw SENS_ERR();
  const db = c.env.DB;
  const r = await db.prepare(`INSERT INTO employee_contracts(employee_id, type, start_date, end_date, salary, file_key, note, created_by) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(id, b.type, b.startDate, b.endDate ?? null, b.salary ?? null, b.fileKey ?? null, b.note ?? null, c.get("user").id).run();
  await auditStmt(c, { action: "hr.contract.create", entity: "employee", entityId: id, after: { ...redactSens(b), contractId: r.meta.last_row_id } }).run();
  return c.json({ id: r.meta.last_row_id }, 201);
});

hrRoutes.put("/employees/:id/contracts/:cid", requirePerm("hr.manage"), async (c) => {
  const id = idOf(c), cid = idOf(c, "cid");
  const b = await parseBody(c, contractBody.partial());
  const db = c.env.DB;
  const before = await db.prepare(`SELECT * FROM employee_contracts WHERE id=? AND employee_id=?`).bind(cid, id).first<any>();
  if (!before) throw notFound("contract_not_found", "Không tìm thấy hợp đồng");
  if (b.salary !== undefined && !sensOf(c)) throw SENS_ERR();
  const map: Record<string, string> = { type: "type", startDate: "start_date", endDate: "end_date", salary: "salary", fileKey: "file_key", note: "note" };
  const sets = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
  if (!sets.length) throw new AppError(422, "validation_error", "Không có thay đổi nào");
  await db.batch([
    db.prepare(`UPDATE employee_contracts SET ${sets.map((k) => `${map[k]}=?`).join(", ")} WHERE id=?`).bind(...sets.map((k) => (b as any)[k]), cid),
    auditStmt(c, { action: "hr.contract.update", entity: "employee", entityId: id, before: redactSens(Object.fromEntries(sets.map((k) => [k, before[map[k]]]))), after: redactSens(b) }),
  ]);
  return c.json({ id: cid });
});

hrRoutes.post("/employees/:id/allowances", requirePerm("hr.manage", "hr.sensitive"), async (c) => {
  const id = idOf(c);
  const b = await parseBody(c, z.object({ name: z.string().trim().min(1).max(100), amount: money, taxable: z.boolean().optional() }));
  await requireEmployee(c, id);
  const r = await c.env.DB.prepare(`INSERT INTO employee_allowances(employee_id, name, amount, taxable) VALUES (?,?,?,?)`).bind(id, b.name, b.amount, b.taxable === false ? 0 : 1).run();
  await auditStmt(c, { action: "hr.allowance.create", entity: "employee", entityId: id, after: { ...redactSens(b), allowanceId: r.meta.last_row_id } }).run();
  return c.json({ id: r.meta.last_row_id }, 201);
});

hrRoutes.put("/employees/:id/allowances/:aid", requirePerm("hr.manage"), async (c) => {
  const id = idOf(c), aid = idOf(c, "aid");
  const b = await parseBody(c, z.object({ name: z.string().trim().min(1).max(100), amount: money, taxable: z.boolean(), active: z.boolean() }).partial());
  const before = await c.env.DB.prepare(`SELECT * FROM employee_allowances WHERE id=? AND employee_id=?`).bind(aid, id).first<any>();
  if (!before) throw notFound("allowance_not_found", "Không tìm thấy phụ cấp");
  if (b.amount !== undefined && !sensOf(c)) throw SENS_ERR();
  const keys = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
  if (!keys.length) throw new AppError(422, "validation_error", "Không có thay đổi nào");
  const v = (k: string) => { const x = (b as any)[k]; return typeof x === "boolean" ? (x ? 1 : 0) : x; };
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE employee_allowances SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`).bind(...keys.map(v), aid),
    auditStmt(c, { action: "hr.allowance.update", entity: "employee", entityId: id, before: redactSens(Object.fromEntries(keys.map((k) => [k, before[k]]))), after: redactSens(b) }),
  ]);
  return c.json({ id: aid });
});

// ============================================================================================
// Ca làm & lịch
// ============================================================================================

hrRoutes.get("/shift-templates", requirePerm("hr.view"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM shift_templates ORDER BY start_time, id`).all<any>();
  return c.json({ items: results.map(mapTemplate) });
});
const mapTemplate = (r: any) => ({ id: r.id, code: r.code, name: r.name, startTime: r.start_time, endTime: r.end_time, breakMinutes: r.break_minutes, active: bool(r.active), overnight: r.end_time <= r.start_time });
const tplBody = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/), name: z.string().trim().min(1).max(60), startTime: timeS, endTime: timeS, breakMinutes: z.number().int().min(0).max(240), active: z.boolean() });

hrRoutes.post("/shift-templates", requirePerm("hr.schedule"), async (c) => {
  const b = await parseBody(c, tplBody.omit({ active: true, breakMinutes: true }).extend({ breakMinutes: tplBody.shape.breakMinutes.optional() }));
  const r = await c.env.DB.prepare(`INSERT INTO shift_templates(code, name, start_time, end_time, break_minutes) VALUES (?,?,?,?,?)`).bind(b.code.toUpperCase(), b.name, b.startTime, b.endTime, b.breakMinutes ?? 0).run().catch((e) => {
    if (String(e.message).includes("UNIQUE")) throw conflict("duplicate", "Mã ca đã tồn tại");
    throw e;
  });
  await auditStmt(c, { action: "hr.shift_template.create", entity: "shift_template", entityId: r.meta.last_row_id as number, after: b }).run();
  return c.json(mapTemplate(await c.env.DB.prepare(`SELECT * FROM shift_templates WHERE id=?`).bind(r.meta.last_row_id).first()), 201);
});

hrRoutes.put("/shift-templates/:id", requirePerm("hr.schedule"), async (c) => {
  const id = idOf(c);
  const b = await parseBody(c, tplBody.omit({ code: true }).partial());
  const before = await c.env.DB.prepare(`SELECT * FROM shift_templates WHERE id=?`).bind(id).first<any>();
  if (!before) throw notFound("shift_template_not_found", "Không tìm thấy mẫu ca");
  const map: Record<string, string> = { name: "name", startTime: "start_time", endTime: "end_time", breakMinutes: "break_minutes", active: "active" };
  const keys = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
  if (!keys.length) throw new AppError(422, "validation_error", "Không có thay đổi nào");
  const v = (k: string) => { const x = (b as any)[k]; return typeof x === "boolean" ? (x ? 1 : 0) : x; };
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE shift_templates SET ${keys.map((k) => `${map[k]}=?`).join(", ")} WHERE id=?`).bind(...keys.map(v), id),
    auditStmt(c, { action: "hr.shift_template.update", entity: "shift_template", entityId: id, before: Object.fromEntries(keys.map((k) => [k, before[map[k]]])), after: b }),
  ]);
  return c.json(mapTemplate(await c.env.DB.prepare(`SELECT * FROM shift_templates WHERE id=?`).bind(id).first()));
});

async function scheduleItems(c: Ctx, employeeId: number | null, from: string, to: string, includeCancelled: boolean) {
  const conds = [`sa.work_date >= ?`, `sa.work_date <= ?`];
  const params: unknown[] = [from, to];
  if (employeeId) { conds.push(`sa.employee_id = ?`); params.push(employeeId); }
  if (!includeCancelled) conds.push(`sa.status = 'scheduled'`);
  const { results } = await c.env.DB
    .prepare(
      `SELECT sa.*, e.full_name, st.name shift_name FROM shift_assignments sa JOIN employees e ON e.id = sa.employee_id
         JOIN shift_templates st ON st.id = sa.shift_template_id WHERE ${conds.join(" AND ")} ORDER BY sa.work_date, sa.start_at, sa.id LIMIT 2000`,
    )
    .bind(...params)
    .all<any>();
  return results.map((r) => ({
    id: r.id, employeeId: r.employee_id, employeeName: r.full_name, workDate: r.work_date, shiftTemplateId: r.shift_template_id,
    shiftName: r.shift_name, startAt: r.start_at, endAt: r.end_at, status: r.status,
  }));
}
function rangeQ(c: Ctx) {
  const today = vnDate();
  const from = c.req.query("from") ?? today;
  const to = c.req.query("to") ?? addDays(from, 6);
  if (!isDate(from) || !isDate(to) || from > to) throw new AppError(422, "validation_error", "Khoảng ngày không hợp lệ");
  if (eachDate(from, to).length > 93) throw new AppError(422, "validation_error", "Khoảng ngày tối đa 93 ngày");
  return { from, to };
}

hrRoutes.get("/schedule", requirePerm("hr.view"), async (c) => {
  const { from, to } = rangeQ(c);
  const emp = Number(c.req.query("employeeId")) || null;
  return c.json({ items: await scheduleItems(c, emp, from, to, c.req.query("includeCancelled") === "1") });
});

hrRoutes.get("/me/schedule", requirePerm("hr.self"), async (c) => {
  const { from, to } = rangeQ(c);
  const me = await employeeOfUser(c.env.DB, c.get("user").id);
  return c.json({ items: await scheduleItems(c, me.id, from, to, false) });
});

hrRoutes.post("/schedule/bulk", requirePerm("hr.schedule"), async (c) => {
  const body = await parseBody(c, z.object({ assignments: z.array(z.object({ employeeId: z.number().int().positive(), workDate: dateS, shiftTemplateId: z.number().int().positive() })).min(1).max(500) }));
  const db = c.env.DB;
  const empIds = [...new Set(body.assignments.map((a) => a.employeeId))];
  const tplIds = [...new Set(body.assignments.map((a) => a.shiftTemplateId))];
  const emps = new Map((await db.prepare(`SELECT id, status, hire_date, termination_date FROM employees WHERE id IN (${empIds.map(() => "?").join(",")})`).bind(...empIds).all<any>()).results.map((e) => [e.id, e]));
  const tpls = new Map((await db.prepare(`SELECT * FROM shift_templates WHERE id IN (${tplIds.map(() => "?").join(",")})`).bind(...tplIds).all<any>()).results.map((t) => [t.id, t]));
  for (const a of body.assignments) {
    const e = emps.get(a.employeeId);
    if (!e) throw new AppError(422, "employee_not_found", `Nhân viên #${a.employeeId} không tồn tại`);
    if (e.status === "terminated" && (!e.termination_date || a.workDate > e.termination_date)) throw new AppError(422, "employee_terminated", `Nhân viên #${a.employeeId} đã nghỉ việc`);
    if (e.termination_date && a.workDate > e.termination_date) throw new AppError(422, "employee_terminated", `Nhân viên #${a.employeeId} nghỉ việc từ ${e.termination_date}`);
    const t = tpls.get(a.shiftTemplateId);
    if (!t || !t.active) throw new AppError(422, "shift_template_invalid", `Mẫu ca #${a.shiftTemplateId} không tồn tại hoặc đã tắt`);
  }
  await assertPeriodsOpen(db, body.assignments.map((a) => a.workDate));
  const uid = c.get("user").id;
  const stmts = body.assignments.map((a) => {
    const t = tpls.get(a.shiftTemplateId);
    const w = shiftWindow(a.workDate, t.start_time, t.end_time);
    return db
      .prepare(
        `INSERT INTO shift_assignments(employee_id, work_date, shift_template_id, start_at, end_at, break_minutes, created_by) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(employee_id, work_date, shift_template_id) DO UPDATE SET status='scheduled', start_at=excluded.start_at, end_at=excluded.end_at, break_minutes=excluded.break_minutes
           WHERE shift_assignments.status = 'cancelled'`,
      )
      .bind(a.employeeId, a.workDate, a.shiftTemplateId, w.startAt, w.endAt, t.break_minutes, uid);
  });
  const res = await db.batch([...stmts, auditStmt(c, { action: "hr.schedule.bulk", entity: "shift_assignment", after: { count: body.assignments.length } })]);
  const created = res.slice(0, stmts.length).filter((r) => r.meta.changes > 0).length;
  return c.json({ created, skipped: body.assignments.length - created }, 201);
});

hrRoutes.delete("/schedule/:id", requirePerm("hr.schedule"), async (c) => {
  const id = idOf(c);
  const a = await c.env.DB.prepare(`SELECT * FROM shift_assignments WHERE id=?`).bind(id).first<any>();
  if (!a) throw notFound("assignment_not_found", "Không tìm thấy ca");
  await assertPeriodsOpen(c.env.DB, [a.work_date]);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE shift_assignments SET status='cancelled' WHERE id=?`).bind(id),
    auditStmt(c, { action: "hr.schedule.cancel", entity: "shift_assignment", entityId: id, before: { status: a.status }, after: { status: "cancelled" } }),
  ]);
  return c.json({ id, status: "cancelled" });
});

// ----- Đổi ca (M9-22) -----
hrRoutes.post("/schedule/swaps", requirePerm("hr.self"), async (c) => {
  const b = await parseBody(c, z.object({ fromAssignmentId: z.number().int().positive(), toEmployeeId: z.number().int().positive(), toAssignmentId: z.number().int().positive().optional(), reason: z.string().trim().min(1).max(300) }));
  const db = c.env.DB;
  const me = await employeeOfUser(db, c.get("user").id);
  const from = await db.prepare(`SELECT * FROM shift_assignments WHERE id=?`).bind(b.fromAssignmentId).first<any>();
  if (!from || from.employee_id !== me.id || from.status !== "scheduled") throw new AppError(422, "invalid_assignment", "Ca muốn đổi phải là ca của bạn và đang hiệu lực");
  if (from.start_at <= nowIso()) throw new AppError(422, "shift_started", "Ca đã bắt đầu, không thể đổi");
  const to = await db.prepare(`SELECT id, status FROM employees WHERE id=?`).bind(b.toEmployeeId).first<any>();
  if (!to || to.status !== "active" || b.toEmployeeId === me.id) throw new AppError(422, "invalid_employee", "Nhân viên nhận ca không hợp lệ");
  if (b.toAssignmentId) {
    const ta = await db.prepare(`SELECT employee_id, status FROM shift_assignments WHERE id=?`).bind(b.toAssignmentId).first<any>();
    if (!ta || ta.employee_id !== b.toEmployeeId || ta.status !== "scheduled") throw new AppError(422, "invalid_assignment", "Ca đổi lấy không hợp lệ");
  }
  const r = await db.prepare(`INSERT INTO shift_swap_requests(from_assignment_id, to_employee_id, to_assignment_id, reason, requested_by) VALUES (?,?,?,?,?)`).bind(b.fromAssignmentId, b.toEmployeeId, b.toAssignmentId ?? null, b.reason, c.get("user").id).run();
  await auditStmt(c, { action: "hr.swap.request", entity: "shift_swap", entityId: r.meta.last_row_id as number, after: b }).run();
  return c.json({ id: r.meta.last_row_id, status: "pending" }, 201);
});

hrRoutes.post("/schedule/swaps/:id/accept", requirePerm("hr.self"), async (c) => {
  const id = idOf(c);
  const db = c.env.DB;
  const me = await employeeOfUser(db, c.get("user").id);
  const s = await db.prepare(`SELECT * FROM shift_swap_requests WHERE id=?`).bind(id).first<any>();
  if (!s || s.to_employee_id !== me.id) throw notFound("swap_not_found", "Không tìm thấy yêu cầu đổi ca");
  if (s.status !== "pending") throw conflict("already_decided", "Yêu cầu đã được xử lý");
  await db.batch([
    db.prepare(`UPDATE shift_swap_requests SET status='accepted' WHERE id=? AND status='pending'`).bind(id),
    auditStmt(c, { action: "hr.swap.accept", entity: "shift_swap", entityId: id }),
  ]);
  return c.json({ id, status: "accepted" });
});

// Danh sách đổi ca kèm tên & ngày ca (dùng cho quản lý và cho NV xem yêu cầu liên quan đến mình)
const SWAP_SELECT = `SELECT s.*, fa.employee_id AS from_employee_id, fe.full_name AS from_employee_name, fa.work_date AS from_work_date, ft.name AS from_shift_name,
         te.full_name AS to_employee_name, ta.work_date AS to_work_date, tt.name AS to_shift_name
    FROM shift_swap_requests s
    JOIN shift_assignments fa ON fa.id = s.from_assignment_id JOIN employees fe ON fe.id = fa.employee_id JOIN shift_templates ft ON ft.id = fa.shift_template_id
    JOIN employees te ON te.id = s.to_employee_id
    LEFT JOIN shift_assignments ta ON ta.id = s.to_assignment_id LEFT JOIN shift_templates tt ON tt.id = ta.shift_template_id`;
const mapSwap = (s: any) => ({
  id: s.id, status: s.status, reason: s.reason, createdAt: s.created_at,
  fromAssignmentId: s.from_assignment_id, fromEmployeeId: s.from_employee_id, fromEmployeeName: s.from_employee_name, fromWorkDate: s.from_work_date, fromShiftName: s.from_shift_name,
  toEmployeeId: s.to_employee_id, toEmployeeName: s.to_employee_name, toAssignmentId: s.to_assignment_id, toWorkDate: s.to_work_date, toShiftName: s.to_shift_name,
});

hrRoutes.get("/schedule/swaps", requirePerm("hr.schedule"), async (c) => {
  const st = c.req.query("status");
  const { results } = await c.env.DB.prepare(`${SWAP_SELECT} ${st ? "WHERE s.status=?" : ""} ORDER BY s.id DESC LIMIT 200`).bind(...(st ? [st] : [])).all<any>();
  return c.json({ items: results.map(mapSwap) });
});

/** NV: yêu cầu đổi ca mình gửi hoặc được nhờ nhận. */
hrRoutes.get("/me/schedule/swaps", requirePerm("hr.self"), async (c) => {
  const me = await employeeOfUser(c.env.DB, c.get("user").id);
  const { results } = await c.env.DB.prepare(`${SWAP_SELECT} WHERE fa.employee_id = ?1 OR s.to_employee_id = ?1 ORDER BY s.id DESC LIMIT 100`).bind(me.id).all<any>();
  return c.json({ items: results.map(mapSwap) });
});

/** NV: đồng nghiệp đang làm cùng cửa hàng (chỉ tên & vị trí — không có dữ liệu nhạy cảm) để chọn người đổi ca. */
hrRoutes.get("/me/colleagues", requirePerm("hr.self"), async (c) => {
  const me = await employeeOfUser(c.env.DB, c.get("user").id);
  const { results } = await c.env.DB.prepare(
    `SELECT id, full_name, position FROM employees WHERE store_id = (SELECT store_id FROM employees WHERE id = ?1) AND status = 'active' AND id <> ?1 ORDER BY full_name`,
  ).bind(me.id).all<any>();
  return c.json({ items: results.map((e) => ({ id: e.id, fullName: e.full_name, position: e.position })) });
});

/** NV: đơn tăng ca và yêu cầu bổ sung công của chính mình. */
hrRoutes.get("/me/overtime-requests", requirePerm("hr.self"), async (c) => {
  const me = await employeeOfUser(c.env.DB, c.get("user").id);
  const { results } = await c.env.DB.prepare(`SELECT * FROM overtime_requests WHERE employee_id = ? ORDER BY id DESC LIMIT 100`).bind(me.id).all<any>();
  return c.json({ items: results.map((o) => ({ id: o.id, workDate: o.work_date, minutes: o.minutes, reason: o.reason, status: o.status, createdAt: o.created_at, decidedAt: o.decided_at })) });
});

hrRoutes.get("/me/attendance/corrections", requirePerm("hr.self"), async (c) => {
  const me = await employeeOfUser(c.env.DB, c.get("user").id);
  const { results } = await c.env.DB.prepare(`SELECT * FROM attendance_corrections WHERE employee_id = ? ORDER BY id DESC LIMIT 100`).bind(me.id).all<any>();
  return c.json({ items: results.map((r) => ({ id: r.id, workDate: r.work_date, type: r.type, kind: r.kind, requestedAt: r.requested_at, reason: r.reason, status: r.status, decisionNote: r.decision_note, createdAt: r.created_at })) });
});

hrRoutes.post("/schedule/swaps/:id/decide", requirePerm("hr.schedule"), async (c) => {
  const id = idOf(c);
  const b = await parseBody(c, z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(300).optional() }));
  const db = c.env.DB;
  const s = await db.prepare(`SELECT * FROM shift_swap_requests WHERE id=?`).bind(id).first<any>();
  if (!s) throw notFound("swap_not_found", "Không tìm thấy yêu cầu đổi ca");
  if (!["pending", "accepted"].includes(s.status)) throw conflict("already_decided", "Yêu cầu đã được xử lý");
  const uid = c.get("user").id;
  const fromA = await db.prepare(`SELECT employee_id FROM shift_assignments WHERE id=?`).bind(s.from_assignment_id).first<{ employee_id: number }>();
  await assertNotSelf(c, { requestedBy: s.requested_by, employeeIds: [fromA?.employee_id, s.to_employee_id] });
  const stmts: D1PreparedStatement[] = [assertStmt(db, "swap.decide", `SELECT status = ? FROM shift_swap_requests WHERE id = ?`, [s.status, id])];
  if (b.decision === "approved") {
    if (s.status !== "accepted") throw conflict("not_accepted", "Nhân viên nhận ca chưa chấp nhận");
    const from = await db.prepare(`SELECT * FROM shift_assignments WHERE id=?`).bind(s.from_assignment_id).first<any>();
    const to = s.to_assignment_id ? await db.prepare(`SELECT * FROM shift_assignments WHERE id=?`).bind(s.to_assignment_id).first<any>() : null;
    if (!from || from.status !== "scheduled" || (s.to_assignment_id && (!to || to.status !== "scheduled"))) throw conflict("assignment_changed", "Ca đã thay đổi hoặc bị huỷ");
    await assertPeriodsOpen(db, [from.work_date, ...(to ? [to.work_date] : [])]);
    const clash = async (empId: number, a: any) => db.prepare(`SELECT id FROM shift_assignments WHERE employee_id=? AND work_date=? AND shift_template_id=? AND id != ?`).bind(empId, a.work_date, a.shift_template_id, a.id).first();
    if (await clash(s.to_employee_id, from)) throw conflict("assignment_clash", "Nhân viên nhận ca đã có ca này");
    stmts.push(db.prepare(`UPDATE shift_assignments SET employee_id=? WHERE id=?`).bind(s.to_employee_id, from.id));
    if (to) {
      if (await clash(from.employee_id, to)) throw conflict("assignment_clash", "Nhân viên đổi ca đã có ca này");
      stmts.push(db.prepare(`UPDATE shift_assignments SET employee_id=? WHERE id=?`).bind(from.employee_id, to.id));
    }
  }
  stmts.push(db.prepare(`UPDATE shift_swap_requests SET status=?, decided_by=?, decided_at=? WHERE id=?`).bind(b.decision, uid, nowIso(), id));
  stmts.push(auditStmt(c, { action: `hr.swap.${b.decision}`, entity: "shift_swap", entityId: id, before: { status: s.status }, after: { status: b.decision }, reason: b.note }));
  await db.batch(stmts);
  return c.json({ id, status: b.decision });
});

// ============================================================================================
// Chấm công (NV, điện thoại)
// ============================================================================================

async function nearestAssignment(db: D1Database, employeeId: number, atIso: string, by: "start" | "end" = "start") {
  const d = vnDate(new Date(atIso));
  const { results } = await db
    .prepare(`SELECT id, start_at, end_at FROM shift_assignments WHERE employee_id=? AND status='scheduled' AND work_date IN (?,?)`)
    .bind(employeeId, d, addDays(d, -1))
    .all<{ id: number; start_at: string; end_at: string }>();
  let best: number | null = null;
  let gap = 8 * 60;
  for (const a of results) {
    const g = Math.abs(minutesBetween(by === "start" ? a.start_at : a.end_at, atIso));
    if (g <= gap) { gap = g; best = a.id; }
  }
  return best;
}

async function storeOf(db: D1Database, storeId: number) {
  return db.prepare(`SELECT id, lat, lng, geofence_m FROM stores WHERE id=?`).bind(storeId).first<{ id: number; lat: number | null; lng: number | null; geofence_m: number | null }>();
}

/** Chỉ thiết bị đã đăng ký & duyệt của NV mới chấm được; thiết bị đầu tiên tự đăng ký. */
async function checkDevice(c: Ctx, deviceId: string) {
  const db = c.env.DB;
  const uid = c.get("user").id;
  const dev = await db.prepare(`SELECT id, user_id, approved_by, revoked_at FROM devices WHERE id=?`).bind(deviceId).first<any>();
  if (dev && dev.user_id !== uid) throw forbidden("device_not_registered", "Thiết bị này đã đăng ký cho tài khoản khác");
  if (dev && dev.approved_by && !dev.revoked_at) return;
  if (!dev) {
    const mine = await db.prepare(`SELECT COUNT(*) n FROM devices WHERE user_id=?`).bind(uid).first<{ n: number }>();
    if (!mine?.n) {
      await db.prepare(`INSERT INTO devices(id, user_id, label, approved_by, approved_at) VALUES (?,?,?,?,?)`).bind(deviceId, uid, "Thiết bị đầu tiên (tự đăng ký)", uid, nowIso()).run();
      return;
    }
  }
  let req = await db.prepare(`SELECT id FROM devices_registry_requests WHERE user_id=? AND device_id=? AND status='pending'`).bind(uid, deviceId).first<{ id: number }>();
  if (!req) {
    const r = await db.prepare(`INSERT INTO devices_registry_requests(user_id, device_id, label) VALUES (?,?,?)`).bind(uid, deviceId, (c.req.header("user-agent") ?? "").slice(0, 80)).run();
    req = { id: r.meta.last_row_id as number };
  }
  throw new AppError(403, "device_not_registered", "Thiết bị chưa được đăng ký. Đã gửi yêu cầu cho quản lý duyệt.", { requestId: req.id });
}

hrRoutes.get("/me/attendance/today", requirePerm("hr.self"), async (c) => {
  const db = c.env.DB;
  const me = await employeeOfUser(db, c.get("user").id);
  const now = nowIso();
  const today = vnDate();
  const day = vnDayRangeUtc(today);
  const [shifts, punches, last, store, settings] = await Promise.all([
    db.prepare(`SELECT sa.id, sa.work_date, sa.start_at, sa.end_at, sa.status, st.name shift_name FROM shift_assignments sa JOIN shift_templates st ON st.id = sa.shift_template_id
                 WHERE sa.employee_id=? AND sa.status='scheduled' AND (sa.work_date=? OR (sa.work_date=? AND sa.end_at > ?)) ORDER BY sa.start_at`).bind(me.id, today, addDays(today, -1), now).all<any>(),
    db.prepare(`SELECT kind, server_at, method, status FROM attendance_punches WHERE employee_id=? AND server_at >= ? AND server_at < ? ORDER BY server_at, id`).bind(me.id, day.from, day.to).all<any>(),
    db.prepare(`SELECT kind, server_at FROM attendance_punches WHERE employee_id=? AND status != 'rejected' ORDER BY server_at DESC, id DESC LIMIT 1`).bind(me.id).first<{ kind: string; server_at: string }>(),
    storeOf(db, me.store_id),
    hrSettings(db),
  ]);
  const isIn = !!last && last.kind === "in" && minutesBetween(last.server_at, now) <= MAX_SHIFT_MINUTES;
  const methods = settings.methods.filter((m) => m === "gps" || (m === "qr" && !!c.env.ATTENDANCE_QR_SECRET));
  const canPunch: Record<string, unknown> = { in: me.status === "active" && !isIn, out: me.status === "active" && isIn };
  if (me.status !== "active") canPunch.reason = "Nhân viên đã nghỉ việc";
  else if (isIn) canPunch.reason = "Bạn đang trong ca, hãy chấm ra";
  return c.json({
    employee: { id: me.id, fullName: me.full_name, locationExempt: bool(me.location_exempt) },
    shifts: shifts.results.map((s) => ({ id: s.id, workDate: s.work_date, shiftName: s.shift_name, startAt: s.start_at, endAt: s.end_at, status: s.status })),
    punches: punches.results.map((p) => ({ kind: p.kind, serverAt: p.server_at, method: p.method, status: p.status })),
    canPunch,
    methods,
    store: { lat: store?.lat ?? null, lng: store?.lng ?? null, geofenceM: store?.geofence_m ?? 100 },
  });
});

const punchBody = z.object({
  kind: z.enum(["in", "out"]),
  method: z.enum(["gps", "qr"]),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100000).optional(),
  qrCode: z.string().max(100).optional(),
  offline: z.object({ clientAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Thời gian không hợp lệ") }).optional(),
});

hrRoutes.post("/me/attendance/punch", requirePerm("hr.self"), async (c) => {
  const b = await parseBody(c, punchBody);
  const db = c.env.DB;
  const user = c.get("user");
  const me = await employeeOfUser(db, user.id);
  if (me.status !== "active") throw forbidden("employee_terminated", "Nhân viên đã nghỉ việc");
  const deviceId = c.req.header("x-device-id")?.trim();
  if (!deviceId || deviceId.length > 100) throw new AppError(422, "device_required", "Thiếu mã thiết bị (header X-Device-Id)");
  await checkDevice(c, deviceId);

  const now = new Date();
  const serverAt = now.toISOString();
  const last = await db.prepare(`SELECT kind, server_at, assignment_id FROM attendance_punches WHERE employee_id=? AND status != 'rejected' ORDER BY server_at DESC, id DESC LIMIT 1`).bind(me.id).first<any>();
  const lastIn = !!last && last.kind === "in" && minutesBetween(last.server_at, serverAt) <= MAX_SHIFT_MINUTES;
  if (b.kind === "in" && lastIn) throw conflict("already_in", "Bạn đã chấm vào, hãy chấm ra trước");
  if (b.kind === "out" && !lastIn) throw conflict("not_in", "Chưa có lần chấm vào — gửi yêu cầu bổ sung công nếu quên chấm");

  const settings = await hrSettings(db);
  const store = await storeOf(db, me.store_id);
  let method: "gps" | "qr" | "offline" | "exempt" = b.method;
  let status: "accepted" | "pending" = "accepted";
  let distance: number | null = null;
  let qrWindow: number | null = null;
  let clientAt: string | null = null;
  const hasPos = b.lat !== undefined && b.lng !== undefined;
  const dist = () => (hasPos && store?.lat != null && store?.lng != null ? haversineM(b.lat!, b.lng!, store.lat, store.lng) : null);

  if (b.offline) {
    method = "offline";
    status = "pending";
    clientAt = new Date(b.offline.clientAt).toISOString();
    distance = dist();
  } else if (me.location_exempt) {
    method = "exempt";
  } else if (b.method === "gps") {
    if (!settings.methods.includes("gps")) throw new AppError(422, "method_disabled", "Cửa hàng không bật chấm công bằng GPS");
    if (!hasPos) throw new AppError(422, "location_required", "Cần vị trí GPS để chấm công");
    if (b.accuracyM === undefined || b.accuracyM > settings.gpsMaxAccuracyM)
      throw new AppError(422, "low_accuracy", `Sai số GPS quá lớn (tối đa ${settings.gpsMaxAccuracyM} m). Hãy ra chỗ thoáng hoặc dùng mã QR.`, { accuracyM: b.accuracyM ?? null, maxAccuracyM: settings.gpsMaxAccuracyM });
    if (store?.lat == null || store?.lng == null) throw new AppError(422, "store_not_geolocated", "Cửa hàng chưa cấu hình toạ độ, dùng mã QR hoặc báo quản lý");
    distance = dist();
    const fence = store.geofence_m ?? 100;
    if (distance! > fence) throw new AppError(422, "out_of_area", `Bạn đang cách cửa hàng ${distance} m (cho phép ${fence} m). Có thể gửi yêu cầu bổ sung công.`, { distanceM: distance, geofenceM: fence });
  } else {
    if (!settings.methods.includes("qr")) throw new AppError(422, "method_disabled", "Cửa hàng không bật chấm công bằng QR");
    const secret = c.env.ATTENDANCE_QR_SECRET;
    if (!secret) throw new AppError(503, "qr_not_configured", "Chưa cấu hình mã QR chấm công, hãy dùng GPS");
    if (!b.qrCode) throw new AppError(422, "invalid_qr", "Thiếu mã QR");
    const v = await verifyQrCode(secret, b.qrCode, me.store_id, now.getTime(), settings.qrWindowSeconds);
    if (!v.ok) throw new AppError(422, "invalid_qr", "Mã QR không hợp lệ hoặc đã hết hạn. Có thể gửi yêu cầu bổ sung công.");
    qrWindow = v.window;
  }

  const assignmentId = b.kind === "out" ? (last?.assignment_id ?? (await nearestAssignment(db, me.id, serverAt, "end"))) : await nearestAssignment(db, me.id, serverAt, "start");
  const keepPos = method === "gps" || method === "offline";
  let id: number;
  try {
    const r = await db
      .prepare(
        `INSERT INTO attendance_punches(employee_id, kind, server_at, client_at, device_id, method, lat, lng, accuracy_m, distance_m, qr_window, status, assignment_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(me.id, b.kind, serverAt, clientAt, deviceId, method, keepPos ? (b.lat ?? null) : null, keepPos ? (b.lng ?? null) : null, keepPos ? (b.accuracyM ?? null) : null, distance, qrWindow, status, assignmentId, user.id)
      .run();
    id = r.meta.last_row_id as number;
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE") && qrWindow !== null) throw conflict("qr_already_used", "Mã QR này đã được dùng, hãy đợi mã mới");
    throw e;
  }
  return c.json({ punch: { id, kind: b.kind, serverAt, method, status, distanceM: distance } }, 201);
});

hrRoutes.get("/attendance/qr", requirePerm("hr.schedule"), async (c) => {
  const secret = c.env.ATTENDANCE_QR_SECRET;
  if (!secret) throw new AppError(503, "qr_not_configured", "Chưa cấu hình ATTENDANCE_QR_SECRET");
  const user = c.get("user");
  const storeId = Number(c.req.query("storeId") ?? user.storeId ?? 0);
  if (!storeId || !(await storeOf(c.env.DB, storeId))) throw new AppError(422, "invalid_store", "Cửa hàng không tồn tại");
  const { qrWindowSeconds } = await hrSettings(c.env.DB);
  const w = qrWindowOf(Date.now(), qrWindowSeconds);
  return c.json({ code: await makeQrCode(secret, storeId, w), expiresAt: qrWindowExpiresAt(w, qrWindowSeconds), windowSeconds: qrWindowSeconds });
});

// ----- Bổ sung công (M9-17) -----
const mapCorr = (r: any) => ({
  id: r.id, employeeId: r.employee_id, employeeName: r.full_name, workDate: r.work_date, type: r.type, kind: r.kind, requestedAt: r.requested_at,
  reason: r.reason, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, createdAt: r.created_at,
});

hrRoutes.post("/me/attendance/corrections", requirePerm("hr.self"), async (c) => {
  const b = await parseBody(c, z.object({
    workDate: dateS, type: z.enum(["missing_in", "missing_out", "out_of_area", "other"]),
    kind: z.enum(["in", "out"]).optional(), requestedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Thời gian không hợp lệ").optional(),
    reason: z.string().trim().min(1).max(500),
  }));
  const db = c.env.DB;
  const me = await employeeOfUser(db, c.get("user").id);
  const kind = b.kind ?? (b.type === "missing_in" ? "in" : b.type === "missing_out" ? "out" : undefined);
  const at = b.requestedAt ? new Date(b.requestedAt).toISOString() : null;
  if (at) {
    if (at > nowIso()) throw new AppError(422, "validation_error", "Giờ đề nghị không được ở tương lai");
    const d = vnDate(new Date(at));
    if (d !== b.workDate && d !== addDays(b.workDate, 1)) throw new AppError(422, "validation_error", "Giờ đề nghị không thuộc ngày làm việc");
  }
  if (b.workDate > vnDate()) throw new AppError(422, "validation_error", "Ngày làm việc ở tương lai");
  await assertPeriodsOpen(db, [b.workDate]);
  const r = await db.prepare(`INSERT INTO attendance_corrections(employee_id, work_date, type, requested_at, kind, reason, requested_by) VALUES (?,?,?,?,?,?,?)`).bind(me.id, b.workDate, b.type, at, kind ?? null, b.reason, c.get("user").id).run();
  await auditStmt(c, { action: "hr.correction.request", entity: "attendance_correction", entityId: r.meta.last_row_id as number, after: b }).run();
  return c.json({ id: r.meta.last_row_id, status: "pending" }, 201);
});

hrRoutes.get("/attendance/corrections", requirePerm("hr.schedule"), async (c) => {
  const st = c.req.query("status");
  const { limit, cursor } = pageParams(c);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (st) { conds.push(`ac.status = ?`); params.push(st); }
  if (cursor) { conds.push(`ac.id < ?`); params.push(cursor); }
  const { results } = await c.env.DB.prepare(`SELECT ac.*, e.full_name FROM attendance_corrections ac JOIN employees e ON e.id = ac.employee_id ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY ac.id DESC LIMIT ?`).bind(...params, limit + 1).all<any>();
  const rows = results.slice(0, limit);
  return c.json({ items: rows.map(mapCorr), nextCursor: results.length > limit ? String(rows[rows.length - 1].id) : null });
});

const decideBody = z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(300).optional() });

hrRoutes.post("/attendance/corrections/:id/decide", requirePerm("hr.schedule"), async (c) => {
  const id = idOf(c);
  const b = await parseBody(c, decideBody);
  const db = c.env.DB;
  const uid = c.get("user").id;
  const r = await db.prepare(`SELECT * FROM attendance_corrections WHERE id=?`).bind(id).first<any>();
  if (!r) throw notFound("correction_not_found", "Không tìm thấy yêu cầu");
  if (r.status !== "pending") throw conflict("already_decided", "Yêu cầu đã được xử lý");
  await assertNotSelf(c, { requestedBy: r.requested_by, employeeIds: [r.employee_id] });
  const at = nowIso();
  const stmts = [assertStmt(db, "correction.decide", `SELECT status = 'pending' FROM attendance_corrections WHERE id = ?`, [id]), db.prepare(`UPDATE attendance_corrections SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=? AND status='pending'`).bind(b.decision, uid, at, b.note ?? null, id)];
  if (b.decision === "approved") {
    if (!r.kind || !r.requested_at) throw new AppError(422, "incomplete_correction", "Yêu cầu thiếu loại (vào/ra) hoặc giờ đề nghị, không thể tạo bản ghi chấm công");
    await assertPeriodsOpen(db, [r.work_date, vnDate(new Date(r.requested_at))]);
    const aid = await nearestAssignment(db, r.employee_id, r.requested_at, r.kind === "in" ? "start" : "end");
    stmts.push(
      db.prepare(`INSERT INTO attendance_punches(employee_id, kind, server_at, method, status, assignment_id, correction_id, note, created_by, decided_by, decided_at) VALUES (?,?,?,'manual','accepted',?,?,?,?,?,?)`)
        .bind(r.employee_id, r.kind, r.requested_at, aid, id, `Bổ sung công: ${r.reason}`, uid, uid, at),
    );
  }
  stmts.push(auditStmt(c, { action: `hr.correction.${b.decision}`, entity: "attendance_correction", entityId: id, before: { status: "pending" }, after: { status: b.decision, kind: r.kind, requestedAt: r.requested_at }, reason: b.note }));
  await db.batch(stmts);
  return c.json({ id, status: b.decision });
});

// ----- Nhật ký chấm công (M9-20) -----
hrRoutes.get("/attendance/punches", requirePerm("hr.view"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.employeeId) { conds.push(`p.employee_id = ?`); params.push(Number(q.employeeId)); }
  if (q.status) { conds.push(`p.status = ?`); params.push(q.status); }
  if (q.from) { if (!isDate(q.from)) throw new AppError(422, "validation_error", "from không hợp lệ"); conds.push(`p.server_at >= ?`); params.push(vnDayRangeUtc(q.from).from); }
  if (q.to) { if (!isDate(q.to)) throw new AppError(422, "validation_error", "to không hợp lệ"); conds.push(`p.server_at < ?`); params.push(vnDayRangeUtc(q.to).to); }
  const { limit, cursor } = pageParams(c);
  if (cursor) { conds.push(`p.id < ?`); params.push(cursor); }
  const { results } = await c.env.DB
    .prepare(`SELECT p.*, e.full_name FROM attendance_punches p JOIN employees e ON e.id = p.employee_id ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY p.id DESC LIMIT ?`)
    .bind(...params, limit + 1)
    .all<any>();
  const rows = results.slice(0, limit);
  return c.json({
    items: rows.map((p) => ({
      id: p.id, employeeId: p.employee_id, employeeName: p.full_name, kind: p.kind, serverAt: p.server_at, clientAt: p.client_at, method: p.method,
      status: p.status, distanceM: p.distance_m, accuracyM: p.accuracy_m, deviceId: p.device_id, assignmentId: p.assignment_id,
      correctionId: p.correction_id, note: p.note, createdBy: p.created_by, decidedBy: p.decided_by, decidedAt: p.decided_at,
    })),
    nextCursor: results.length > limit ? String(rows[rows.length - 1].id) : null,
  });
});

hrRoutes.post("/attendance/punches/:id/decide", requirePerm("hr.schedule"), async (c) => {
  const id = idOf(c);
  const b = await parseBody(c, z.object({ decision: z.enum(["approved", "accepted", "rejected"]), note: z.string().trim().max(300).optional() }));
  const db = c.env.DB;
  const p = await db.prepare(`SELECT * FROM attendance_punches WHERE id=?`).bind(id).first<any>();
  if (!p) throw notFound("punch_not_found", "Không tìm thấy lần chấm công");
  if (p.status !== "pending") throw conflict("already_decided", "Lần chấm công không ở trạng thái chờ duyệt");
  await assertPeriodsOpen(db, [vnDate(new Date(p.server_at))]);
  await assertNotSelf(c, { requestedBy: p.created_by, employeeIds: [p.employee_id] });
  const status = b.decision === "rejected" ? "rejected" : "accepted";
  await db.batch([
    assertStmt(db, "punch.decide", `SELECT status = 'pending' FROM attendance_punches WHERE id = ?`, [id]),
    db.prepare(`UPDATE attendance_punches SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'`).bind(status, c.get("user").id, nowIso(), id),
    auditStmt(c, { action: `hr.punch.${status}`, entity: "attendance_punch", entityId: id, before: { status: "pending" }, after: { status }, reason: b.note }),
  ]);
  return c.json({ id, status });
});

// ----- Thiết bị chấm công -----
hrRoutes.get("/devices/requests", requirePerm("hr.schedule"), async (c) => {
  const st = c.req.query("status") ?? "pending";
  const { results } = await c.env.DB
    .prepare(`SELECT r.*, u.full_name, u.username FROM devices_registry_requests r JOIN users u ON u.id = r.user_id WHERE r.status = ? ORDER BY r.id DESC LIMIT 200`)
    .bind(st)
    .all<any>();
  return c.json({ items: results.map((r) => ({ id: r.id, userId: r.user_id, fullName: r.full_name, username: r.username, deviceId: r.device_id, label: r.label, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at })) });
});

hrRoutes.post("/devices/requests/:id/decide", requirePerm("hr.schedule"), async (c) => {
  const id = idOf(c);
  const b = await parseBody(c, decideBody);
  const db = c.env.DB;
  const r = await db.prepare(`SELECT * FROM devices_registry_requests WHERE id=?`).bind(id).first<any>();
  if (!r) throw notFound("request_not_found", "Không tìm thấy yêu cầu");
  if (r.status !== "pending") throw conflict("already_decided", "Yêu cầu đã được xử lý");
  const uid = c.get("user").id;
  await assertNotSelf(c, { userIds: [r.user_id] });
  const at = nowIso();
  const stmts = [assertStmt(db, "device.decide", `SELECT status = 'pending' FROM devices_registry_requests WHERE id = ?`, [id]), db.prepare(`UPDATE devices_registry_requests SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'`).bind(b.decision, uid, at, id)];
  if (b.decision === "approved") {
    const dev = await db.prepare(`SELECT user_id FROM devices WHERE id=?`).bind(r.device_id).first<{ user_id: number }>();
    if (dev && dev.user_id !== r.user_id) throw conflict("device_taken", "Thiết bị đang đăng ký cho tài khoản khác");
    // đổi điện thoại: thu hồi thiết bị cũ để chỉ còn một máy chấm công
    stmts.push(db.prepare(`UPDATE devices SET revoked_at=? WHERE user_id=? AND id != ? AND revoked_at IS NULL`).bind(at, r.user_id, r.device_id));
    stmts.push(
      db.prepare(`INSERT INTO devices(id, user_id, label, approved_by, approved_at) VALUES (?,?,?,?,?)
                  ON CONFLICT(id) DO UPDATE SET approved_by=excluded.approved_by, approved_at=excluded.approved_at, revoked_at=NULL`)
        .bind(r.device_id, r.user_id, r.label, uid, at),
    );
  }
  stmts.push(auditStmt(c, { action: `hr.device.${b.decision}`, entity: "device", entityId: r.device_id, after: { userId: r.user_id, requestId: id }, reason: b.note }));
  await db.batch(stmts);
  return c.json({ id, status: b.decision });
});

// ============================================================================================
// Nghỉ phép, tăng ca, ngày lễ
// ============================================================================================

const mapLeave = (r: any) => ({
  id: r.id, employeeId: r.employee_id, employeeName: r.full_name, leaveTypeCode: r.code, fromDate: r.from_date, toDate: r.to_date, halfDay: bool(r.half_day),
  daysX10: r.days_x10, reason: r.reason, status: r.status, overBalance: bool(r.over_balance), decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at,
});
const LEAVE_SELECT = `SELECT lr.*, lt.code, e.full_name FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id JOIN employees e ON e.id = lr.employee_id`;

hrRoutes.post("/me/leave-requests", requirePerm("hr.self"), async (c) => {
  const b = await parseBody(c, z.object({ leaveTypeCode: z.string().min(1).max(30), fromDate: dateS, toDate: dateS, halfDay: z.boolean().optional(), reason: z.string().trim().max(500).optional() }));
  const db = c.env.DB;
  const me = await employeeOfUser(db, c.get("user").id);
  if (b.fromDate > b.toDate) throw new AppError(422, "validation_error", "Ngày bắt đầu sau ngày kết thúc");
  if (eachDate(b.fromDate, b.toDate).length > 120) throw new AppError(422, "validation_error", "Khoảng nghỉ tối đa 120 ngày");
  if (b.halfDay && b.fromDate !== b.toDate) throw new AppError(422, "validation_error", "Nghỉ nửa ngày chỉ áp dụng cho một ngày");
  const lt = await db.prepare(`SELECT id, uses_balance FROM leave_types WHERE code=?`).bind(b.leaveTypeCode).first<any>();
  if (!lt) throw new AppError(422, "leave_type_invalid", "Loại nghỉ không tồn tại");
  const hol = new Set((await db.prepare(`SELECT day FROM holidays WHERE day >= ? AND day <= ?`).bind(b.fromDate, b.toDate).all<{ day: string }>()).results.map((h) => h.day));
  // Chỉ bỏ ngày lễ (không bỏ Chủ nhật — ngày nghỉ hằng tuần do lịch ca quyết định)
  const dates = eachDate(b.fromDate, b.toDate).filter((d) => !hol.has(d));
  if (!dates.length) throw new AppError(422, "no_working_days", "Khoảng nghỉ chỉ gồm ngày lễ");
  const daysX10 = b.halfDay ? 5 : dates.length * 10;
  const overlap = await db.prepare(`SELECT id FROM leave_requests WHERE employee_id=? AND status IN ('pending','approved') AND from_date <= ? AND to_date >= ?`).bind(me.id, b.toDate, b.fromDate).first();
  if (overlap) throw conflict("leave_overlap", "Đã có đơn nghỉ trùng khoảng ngày này");
  await assertPeriodsOpen(db, dates);
  let over = 0;
  if (lt.uses_balance) {
    const bal = await leaveBalance(db, me.id, Number(b.fromDate.slice(0, 4)));
    over = daysX10 > bal.remainingX10 ? 1 : 0;
  }
  const r = await db.prepare(`INSERT INTO leave_requests(employee_id, leave_type_id, from_date, to_date, half_day, days_x10, reason, over_balance, requested_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(me.id, lt.id, b.fromDate, b.toDate, b.halfDay ? 1 : 0, daysX10, b.reason ?? null, over, c.get("user").id).run();
  await auditStmt(c, { action: "hr.leave.request", entity: "leave_request", entityId: r.meta.last_row_id as number, after: { ...b, daysX10, overBalance: !!over } }).run();
  return c.json(mapLeave(await db.prepare(`${LEAVE_SELECT} WHERE lr.id=?`).bind(r.meta.last_row_id).first()), 201);
});

hrRoutes.get("/me/leave-requests", requirePerm("hr.self"), async (c) => {
  const me = await employeeOfUser(c.env.DB, c.get("user").id);
  const { results } = await c.env.DB.prepare(`${LEAVE_SELECT} WHERE lr.employee_id=? ORDER BY lr.id DESC LIMIT 200`).bind(me.id).all<any>();
  return c.json({ items: results.map(mapLeave), leaveBalance: await leaveBalance(c.env.DB, me.id, Number(vnDate().slice(0, 4))) });
});

hrRoutes.get("/leave-requests", requirePerm("hr.view"), async (c) => {
  const st = c.req.query("status");
  const { limit, cursor } = pageParams(c);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (st) { conds.push(`lr.status=?`); params.push(st); }
  if (cursor) { conds.push(`lr.id < ?`); params.push(cursor); }
  const { results } = await c.env.DB.prepare(`${LEAVE_SELECT} ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY lr.id DESC LIMIT ?`).bind(...params, limit + 1).all<any>();
  const rows = results.slice(0, limit);
  return c.json({ items: rows.map(mapLeave), nextCursor: results.length > limit ? String(rows[rows.length - 1].id) : null });
});

hrRoutes.post("/leave-requests/:id/decide", requirePerm("hr.schedule"), async (c) => {
  const id = idOf(c);
  const b = await parseBody(c, decideBody.extend({ allowOverBalance: z.boolean().optional() }));
  const db = c.env.DB;
  const r = await db.prepare(`SELECT * FROM leave_requests WHERE id=?`).bind(id).first<any>();
  if (!r) throw notFound("leave_not_found", "Không tìm thấy đơn nghỉ");
  if (r.status !== "pending") throw conflict("already_decided", "Đơn đã được xử lý");
  await assertNotSelf(c, { requestedBy: r.requested_by, employeeIds: [r.employee_id] });
  if (b.decision === "approved") {
    if (r.over_balance && !b.allowOverBalance) throw conflict("over_balance", "Đơn vượt số ngày phép còn lại — cần duyệt ngoại lệ (allowOverBalance: true)");
    await assertPeriodsOpen(db, eachDate(r.from_date, r.to_date));
  }
  await db.batch([
    assertStmt(db, "leave.decide", `SELECT status = 'pending' FROM leave_requests WHERE id = ?`, [id]),
    db.prepare(`UPDATE leave_requests SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'`).bind(b.decision, c.get("user").id, nowIso(), id),
    auditStmt(c, { action: `hr.leave.${b.decision}`, entity: "leave_request", entityId: id, before: { status: "pending" }, after: { status: b.decision, overBalanceException: !!(r.over_balance && b.allowOverBalance) }, reason: b.note }),
  ]);
  return c.json({ id, status: b.decision });
});

const mapOt = (r: any) => ({ id: r.id, employeeId: r.employee_id, employeeName: r.full_name, workDate: r.work_date, minutes: r.minutes, multiplierBp: r.multiplier_bp, reason: r.reason, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at });
const OT_SELECT = `SELECT o.*, e.full_name FROM overtime_requests o JOIN employees e ON e.id = o.employee_id`;

hrRoutes.post("/me/overtime-requests", requirePerm("hr.self"), async (c) => {
  const b = await parseBody(c, z.object({ workDate: dateS, minutes: z.number().int().min(1).max(720), reason: z.string().trim().max(300).optional() }));
  const db = c.env.DB;
  const me = await employeeOfUser(db, c.get("user").id);
  await assertPeriodsOpen(db, [b.workDate]);
  const r = await db.prepare(`INSERT INTO overtime_requests(employee_id, work_date, minutes, reason, requested_by) VALUES (?,?,?,?,?)`).bind(me.id, b.workDate, b.minutes, b.reason ?? null, c.get("user").id).run();
  await auditStmt(c, { action: "hr.overtime.request", entity: "overtime_request", entityId: r.meta.last_row_id as number, after: b }).run();
  return c.json(mapOt(await db.prepare(`${OT_SELECT} WHERE o.id=?`).bind(r.meta.last_row_id).first()), 201);
});

// Quản lý ghi nhận tăng ca sau (đã xác nhận) → duyệt ngay
hrRoutes.post("/overtime-requests", requirePerm("hr.schedule"), async (c) => {
  const b = await parseBody(c, z.object({ employeeId: z.number().int().positive(), workDate: dateS, minutes: z.number().int().min(1).max(720), multiplierBp: z.number().int().min(10000).max(50000).optional(), reason: z.string().trim().max(300).optional() }));
  const db = c.env.DB;
  await requireEmployee(c, b.employeeId);
  await assertNotSelf(c, { employeeIds: [b.employeeId] });
  await assertPeriodsOpen(db, [b.workDate]);
  const uid = c.get("user").id;
  const r = await db.prepare(`INSERT INTO overtime_requests(employee_id, work_date, minutes, multiplier_bp, reason, status, requested_by, decided_by, decided_at) VALUES (?,?,?,?,?, 'approved', ?,?,?)`)
    .bind(b.employeeId, b.workDate, b.minutes, b.multiplierBp ?? null, b.reason ?? null, uid, uid, nowIso()).run();
  await auditStmt(c, { action: "hr.overtime.create_approved", entity: "overtime_request", entityId: r.meta.last_row_id as number, after: b }).run();
  return c.json(mapOt(await db.prepare(`${OT_SELECT} WHERE o.id=?`).bind(r.meta.last_row_id).first()), 201);
});

hrRoutes.get("/overtime-requests", requirePerm("hr.view"), async (c) => {
  const st = c.req.query("status");
  const { results } = await c.env.DB.prepare(`${OT_SELECT} ${st ? "WHERE o.status=?" : ""} ORDER BY o.id DESC LIMIT 200`).bind(...(st ? [st] : [])).all<any>();
  return c.json({ items: results.map(mapOt) });
});

hrRoutes.post("/overtime-requests/:id/decide", requirePerm("hr.schedule"), async (c) => {
  const id = idOf(c);
  const b = await parseBody(c, decideBody.extend({ multiplierBp: z.number().int().min(10000).max(50000).optional() }));
  const db = c.env.DB;
  const r = await db.prepare(`SELECT * FROM overtime_requests WHERE id=?`).bind(id).first<any>();
  if (!r) throw notFound("overtime_not_found", "Không tìm thấy yêu cầu tăng ca");
  if (r.status !== "pending") throw conflict("already_decided", "Yêu cầu đã được xử lý");
  await assertNotSelf(c, { requestedBy: r.requested_by, employeeIds: [r.employee_id] });
  await assertPeriodsOpen(db, [r.work_date]);
  await db.batch([
    assertStmt(db, "overtime.decide", `SELECT status = 'pending' FROM overtime_requests WHERE id = ?`, [id]),
    db.prepare(`UPDATE overtime_requests SET status=?, decided_by=?, decided_at=?, multiplier_bp=COALESCE(?, multiplier_bp) WHERE id=? AND status='pending'`).bind(b.decision, c.get("user").id, nowIso(), b.multiplierBp ?? null, id),
    auditStmt(c, { action: `hr.overtime.${b.decision}`, entity: "overtime_request", entityId: id, before: { status: "pending" }, after: { status: b.decision, minutes: r.minutes }, reason: b.note }),
  ]);
  return c.json({ id, status: b.decision });
});

hrRoutes.get("/holidays", requirePerm("hr.view"), async (c) => {
  const year = c.req.query("year");
  const { results } = await c.env.DB.prepare(`SELECT * FROM holidays ${year ? "WHERE substr(day,1,4)=?" : ""} ORDER BY day`).bind(...(year ? [year] : [])).all<any>();
  return c.json({ items: results.map((h) => ({ day: h.day, name: h.name, multiplierBp: h.multiplier_bp, paidOff: bool(h.paid_off) })) });
});

hrRoutes.post("/holidays", requirePerm("hr.manage"), async (c) => {
  const b = await parseBody(c, z.object({ day: dateS, name: z.string().trim().min(1).max(100), multiplierBp: z.number().int().min(10000).max(50000).optional(), paidOff: z.boolean().optional() }));
  await assertPeriodsOpen(c.env.DB, [b.day]);
  const dup = await c.env.DB.prepare(`SELECT day FROM holidays WHERE day=?`).bind(b.day).first();
  if (dup) throw conflict("duplicate", "Ngày lễ đã tồn tại");
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO holidays(day, name, multiplier_bp, paid_off) VALUES (?,?,?,?)`).bind(b.day, b.name, b.multiplierBp ?? 30000, b.paidOff === false ? 0 : 1),
    auditStmt(c, { action: "hr.holiday.create", entity: "holiday", entityId: b.day, after: b }),
  ]);
  return c.json({ day: b.day, name: b.name, multiplierBp: b.multiplierBp ?? 30000, paidOff: b.paidOff !== false }, 201);
});

hrRoutes.delete("/holidays/:day", requirePerm("hr.manage"), async (c) => {
  const day = c.req.param("day");
  if (!isDate(day)) throw notFound();
  const h = await c.env.DB.prepare(`SELECT * FROM holidays WHERE day=?`).bind(day).first<any>();
  if (!h) throw notFound("holiday_not_found", "Không tìm thấy ngày lễ");
  await assertPeriodsOpen(c.env.DB, [day]);
  await c.env.DB.batch([c.env.DB.prepare(`DELETE FROM holidays WHERE day=?`).bind(day), auditStmt(c, { action: "hr.holiday.delete", entity: "holiday", entityId: day, before: h })]);
  return c.json({ day, deleted: true });
});

// ============================================================================================
// Bảng công
// ============================================================================================

hrRoutes.get("/timesheets/adjustments", requirePerm("hr.view"), async (c) => {
  const p = c.req.query("period");
  const { results } = await c.env.DB.prepare(`SELECT * FROM timesheet_adjustments ${p ? "WHERE target_period=? OR source_period=?" : ""} ORDER BY id DESC LIMIT 200`).bind(...(p ? [p, p] : [])).all<any>();
  return c.json({ items: results.map((a) => ({ id: a.id, employeeId: a.employee_id, sourcePeriod: a.source_period, targetPeriod: a.target_period, minutes: a.minutes, kind: a.kind, reason: a.reason, createdBy: a.created_by, createdAt: a.created_at })) });
});

hrRoutes.get("/timesheets/:period", requirePerm("hr.view"), async (c) => {
  const period = c.req.param("period");
  if (!isPeriod(period)) throw new AppError(422, "validation_error", "Kỳ công phải có dạng YYYY-MM");
  const emp = c.req.query("employeeId") ? Number(c.req.query("employeeId")) : undefined;
  return c.json(await computeTimesheet(c.env.DB, period, emp));
});

hrRoutes.post("/timesheets/:period/close", requirePerm("hr.manage"), async (c) => {
  const period = c.req.param("period");
  if (!isPeriod(period)) throw new AppError(422, "validation_error", "Kỳ công phải có dạng YYYY-MM");
  const b = await parseBody(c, z.object({ force: z.boolean().optional(), reason: z.string().trim().min(1).max(500).optional() }).default({}));
  const db = c.env.DB;
  const cur = await db.prepare(`SELECT status FROM timesheets WHERE period=?`).bind(period).first<{ status: string }>();
  if (cur?.status === "closed") throw conflict("already_closed", "Kỳ công đã chốt");
  const ts = await computeTimesheetLive(db, period);
  const unresolved = await collectUnresolved(db, period, ts);
  const bad = hasUnresolved(unresolved);
  if (bad && !b.force) throw conflict("unresolved_items", "Còn mục chưa xử lý (chấm công chờ duyệt, thiếu công, đơn chờ duyệt)", unresolved);
  if (bad && !b.reason) throw new AppError(422, "reason_required", "Chốt cưỡng chế cần nhập lý do");
  const snap = snapshotStatements(db, ts);
  const at = nowIso();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO timesheets(period, status) VALUES (?, 'open')`).bind(period),
    db.prepare(`DELETE FROM timesheet_days WHERE period=?`).bind(period),
    ...snap,
    db.prepare(`UPDATE timesheets SET status='closed', closed_by=?, closed_at=? WHERE period=? AND status='open'`).bind(c.get("user").id, at, period),
    auditStmt(c, { action: "hr.timesheet.close", entity: "timesheet", entityId: period, after: { rows: snap.length, forced: bad && !!b.force, unresolved: bad ? unresolved : undefined }, reason: b.reason }),
  ]);
  return c.json({ period, status: "closed", closedAt: at, rows: snap.length, forced: bad });
});

hrRoutes.post("/timesheets/adjustments", requirePerm("hr.manage"), async (c) => {
  const b = await parseBody(c, z.object({
    employeeId: z.number().int().positive(), sourcePeriod: z.string().refine(isPeriod), targetPeriod: z.string().refine(isPeriod).optional(),
    minutes: z.number().int().min(-100000).max(100000).refine((n) => n !== 0, "Số phút phải khác 0"), kind: z.enum(["work", "overtime"]), reason: z.string().trim().min(1).max(500),
  }));
  const db = c.env.DB;
  await requireEmployee(c, b.employeeId);
  const src = await db.prepare(`SELECT status FROM timesheets WHERE period=?`).bind(b.sourcePeriod).first<{ status: string }>();
  if (src?.status !== "closed") throw conflict("period_not_closed", "Kỳ nguồn chưa chốt — sửa trực tiếp dữ liệu chấm công");
  const [y, m] = b.sourcePeriod.split("-").map(Number);
  const target = b.targetPeriod ?? new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  if (target <= b.sourcePeriod) throw new AppError(422, "validation_error", "Kỳ điều chỉnh phải sau kỳ nguồn");
  await assertPeriodsOpen(db, [target + "-01"]);
  const r = await db.prepare(`INSERT INTO timesheet_adjustments(employee_id, source_period, target_period, minutes, kind, reason, created_by) VALUES (?,?,?,?,?,?,?)`).bind(b.employeeId, b.sourcePeriod, target, b.minutes, b.kind, b.reason, c.get("user").id).run();
  await auditStmt(c, { action: "hr.timesheet.adjust", entity: "timesheet", entityId: b.sourcePeriod, after: { ...b, targetPeriod: target, adjustmentId: r.meta.last_row_id }, reason: b.reason }).run();
  return c.json({ id: r.meta.last_row_id, employeeId: b.employeeId, sourcePeriod: b.sourcePeriod, targetPeriod: target, minutes: b.minutes, kind: b.kind }, 201);
});
