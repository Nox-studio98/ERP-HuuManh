import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";
import { calculatePayslip, DEFAULT_PAYROLL_SETTINGS, type PayslipInput } from "../src/worker/services/payroll-calc";
import { periodValue, type HistRow } from "../src/worker/services/salary-history";
import { vnDate, vnPeriod } from "../src/worker/lib/time";

// Fix 5d: C-10, C-11, C-12, C-18, C-19, C-20, C-24, C-25, C-26, C-31
const V = "/api/v1";
const db = () => testEnv.DB;
const LAT = 10.7769, LNG = 106.7009;
const punch = (u: string, body: unknown) => call(u, "POST", `${V}/me/attendance/punch`, body, { headers: { "x-device-id": `dev-${u}` } });

beforeAll(async () => {
  await seedBase();
  await db().prepare(`UPDATE stores SET lat=?, lng=?, geofence_m=100 WHERE id=1`).bind(LAT, LNG).run();
  for (const [i, n] of ["a", "b", "c", "d", "e"].entries()) await seedStaff({ userId: 700 + i, username: `f5_${n}`, employeeId: 700 + i });
});

describe("C-10 chốt công + chấm công vào kỳ đã chốt", () => {
  it("không chốt kỳ tương lai / kỳ chưa kết thúc; phải chốt theo thứ tự; force cần lý do", async () => {
    const fut = await call("accountant", "POST", `${V}/timesheets/2099-01/close`, { force: true, reason: "thử" });
    expect(fut.status).toBe(409);
    expect(fut.body.error.code).toBe("period_in_future");
    const cur = vnPeriod();
    const notEnded = await call("accountant", "POST", `${V}/timesheets/${cur}/close`, {});
    expect(notEnded.body.error.code).toBe("period_not_ended");
    expect((await call("accountant", "POST", `${V}/timesheets/${cur}/close`, { force: true })).status).toBe(422);
    // kỳ đầu tiên chốt được; sau đó nhảy cóc bị chặn
    expect((await call("accountant", "POST", `${V}/timesheets/2026-07/close`, {})).status).toBe(200);
    const skip = await call("accountant", "POST", `${V}/timesheets/2026-09/close`, {});
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe("previous_period_open");
    expect((await call("accountant", "POST", `${V}/timesheets/2026-08/close`, {})).status).toBe(200);
    expect((await call("accountant", "POST", `${V}/timesheets/2026-09/close`, {})).status).toBe(200);
  });

  it("chấm công (offline) vào kỳ đã chốt trả 409 rõ ràng, không nhận rồi bỏ qua", async () => {
    const past = new Date(Date.now() - 40 * 86400_000);
    const p = vnDate(past).slice(0, 7);
    await db().prepare(`INSERT OR IGNORE INTO timesheets(period, status) VALUES (?, 'closed')`).bind(p).run();
    await db().prepare(`UPDATE timesheets SET status='closed' WHERE period=?`).bind(p).run();
    await db().prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('hr.offline_max_hours','2000')`).run();
    const r = await punch("f5_a", { kind: "in", method: "gps", lat: LAT, lng: LNG, accuracyM: 10, offline: { clientAt: past.toISOString() } });
    await db().prepare(`DELETE FROM settings WHERE key='hr.offline_max_hours'`).run();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("timesheet_closed");
  });
});

describe("C-25 punch pending của kỳ đã chốt", () => {
  it("không duyệt được nhưng từ chối (kèm lý do) để dọn hàng chờ", async () => {
    const ins = await db().prepare(`INSERT INTO attendance_punches(employee_id, kind, server_at, effective_at, method, status) VALUES (702,'in','2026-07-03T01:00:00.000Z','2026-07-03T01:00:00.000Z','offline','pending') RETURNING id`).first<any>();
    const id = ins.id;
    expect((await call("manager", "POST", `${V}/attendance/punches/${id}/decide`, { decision: "approved" })).status).toBe(409);
    expect((await call("manager", "POST", `${V}/attendance/punches/${id}/decide`, { decision: "rejected" })).status).toBe(422);
    const ok = await call("manager", "POST", `${V}/attendance/punches/${id}/decide`, { decision: "rejected", note: "kỳ đã chốt, không tính công" });
    expect(ok.status).toBe(200);
    expect(await db().prepare(`SELECT status FROM attendance_punches WHERE id=?`).bind(id).first()).toEqual({ status: "rejected" });
  });
});

describe("C-11 danh sách cảnh báo chấm công", () => {
  it("lọc loại/ngày, đánh dấu đã xem, chỉ người có hr.schedule", async () => {
    const mk = (kind: string, id: string, msg: string) =>
      db().prepare(`INSERT INTO audit_log(user_id, action, entity, entity_id, after_json, reason) VALUES (NULL,'hr.alert','attendance_punch',?,?,?)`).bind(id, JSON.stringify({ kind, employeeId: 700 }), msg);
    await db().batch([mk("far_punch", "9001", "NV a chấm xa"), mk("late_no_checkin", "9002", "NV a chưa vào ca")]);
    const all = await call("manager", "GET", `${V}/attendance/alerts`);
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(2);
    expect(all.body.items[0]).toMatchObject({ acked: false, employeeName: "NV f5_a" });
    const far = await call("manager", "GET", `${V}/attendance/alerts?kind=far_punch&from=${vnDate()}&to=${vnDate()}`);
    expect(far.body.items.map((a: any) => a.kind)).toEqual(["far_punch"]);
    expect((await call("manager", "GET", `${V}/attendance/alerts?kind=bậy`)).status).toBe(422);
    const id = far.body.items[0].id;
    expect((await call("manager", "POST", `${V}/attendance/alerts/${id}/ack`, { note: "đã gọi NV" })).status).toBe(200);
    expect((await call("manager", "POST", `${V}/attendance/alerts/${id}/ack`, {})).status).toBe(409);
    const open = await call("manager", "GET", `${V}/attendance/alerts?status=open&kind=far_punch`);
    expect(open.body.items).toHaveLength(0);
    const acked = await call("manager", "GET", `${V}/attendance/alerts?status=acked`);
    expect(acked.body.items[0]).toMatchObject({ id, acked: true, ackNote: "đã gọi NV" });
    expect((await call("cashier", "GET", `${V}/attendance/alerts`)).status).toBe(403);
  });
});

describe("C-12 tạm ứng: giới hạn luỹ kế + chặn tự ứng", () => {
  it("vượt % lương tháng theo kỳ khấu trừ → 422; kế toán không tự ứng cho mình", async () => {
    await db().batch([
      db().prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date, pay_type, base_salary) VALUES (610,'NV-A12','Ứng Một','kho',1,'2026-01-01','monthly',10000000)`),
      db().prepare(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date, pay_type, base_salary) VALUES (611,'NV-A13',5,'Kế Toán','kế toán',1,'2026-01-01','monthly',10000000)`),
    ]);
    const adv = (amount: number, employeeId = 610) => call("accountant", "POST", `${V}/payroll/advances`, { employeeId, amount, fundId: 1, deductPeriod: "2099-05" });
    expect((await adv(3_000_000)).status).toBe(201);
    const over = await adv(2_500_000);
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("advance_limit_exceeded");
    expect(over.body.error.details).toMatchObject({ cap: 5_000_000, used: 3_000_000, remaining: 2_000_000 });
    expect((await adv(2_000_000)).status).toBe(201);
    const self = await adv(1_000_000, 611);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("self_advance");
  });
});

describe("C-18 lịch sử lương theo ngày hiệu lực", () => {
  it("sửa lương ghi lịch sử (không ghi giá trị vào audit_log), chỉ hr.sensitive xem, không tự sửa lương mình", async () => {
    await db().prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date, pay_type, base_salary) VALUES (620,'NV-H18','Lương Hai','kho',1,'2026-01-01','monthly',2600000)`).run();
    const e = await call("accountant", "GET", `${V}/employees/620`);
    const up = await call("accountant", "PUT", `${V}/employees/620`, { baseSalary: 8_765_431, salaryEffectiveDate: "2026-09-16", salaryReason: "tăng lương", version: e.body.version });
    expect(up.status).toBe(200);
    const h = await call("accountant", "GET", `${V}/employees/620/salary-history`);
    expect(h.body.items[0]).toMatchObject({ field: "baseSalary", oldValue: 2_600_000, newValue: 8_765_431, effectiveDate: "2026-09-16" });
    expect((await call("manager", "GET", `${V}/employees/620/salary-history`)).status).toBe(403);
    const leaked = await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE entity='employee' AND entity_id='620' AND (before_json LIKE '%8765431%' OR after_json LIKE '%8765431%')`).first<any>();
    expect(leaked.n).toBe(0);
    // kế toán tự sửa lương của chính mình → chặn
    const me = await call("accountant", "GET", `${V}/employees/611`);
    const self = await call("accountant", "PUT", `${V}/employees/611`, { baseSalary: 99_000_000, version: me.body.version });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("self_salary_edit");
  });

  it("periodValue: đổi lương giữa tháng → mỗi ngày dùng mức đúng ngày đó; kỳ trước dùng mức cũ, kỳ sau mức mới", () => {
    const rows: HistRow[] = [{ id: 1, employee_id: 1, field: "baseSalary", ref_id: null, old_value: 3_000_000, new_value: 6_000_000, effective_date: "2026-09-16" }];
    expect(periodValue(rows, 6_000_000, "2026-08")).toBe(3_000_000);
    expect(periodValue(rows, 6_000_000, "2026-09")).toBe(4_500_000);
    expect(periodValue(rows, 6_000_000, "2026-10")).toBe(6_000_000);
    expect(periodValue([], 5, "2026-10")).toBe(5);
  });

  it("tính lương kỳ 2026-09 dùng mức theo ngày hiệu lực (không dùng lương hiện hành)", async () => {
    await db().prepare(`UPDATE employees SET hire_date='2026-01-01' WHERE id=620`).run();
    await db().batch(Array.from({ length: 26 }, (_, i) => db().prepare(`INSERT INTO timesheet_days(period, employee_id, work_date, worked_minutes, shifts_worked) VALUES ('2026-09',620,?,480,1)`).bind(`2026-09-${String(i + 1).padStart(2, "0")}`)));
    const calc = await call("accountant", "POST", `${V}/payroll/periods/2026-09/calculate`);
    expect(calc.status).toBe(200);
    const d = await call("accountant", "GET", `${V}/payroll/periods/2026-09`);
    const it = d.body.items.find((i: any) => i.code === "NV-H18");
    // 15 ngày × 2.600.000 + 15 ngày × 8.765.431, trung bình theo ngày lịch
    expect(it.basePay).toBe(Math.round((15 * 2_600_000 + 15 * 8_765_431) / 30));
  });
});

const base = (over: Partial<PayslipInput["employee"]>, days: PayslipInput["days"], more: Partial<PayslipInput> = {}): PayslipInput => ({
  employee: { payType: "hourly", baseSalary: 0, hourlyRate: 30000, shiftRate: 0, insuranceSalary: 0, dependents: 0, pitEnabled: false, ...over },
  days, adjustMinutes: { work: 0, overtime: 0 }, allowances: [], entries: [], advances: [], salesRevenue: 0, ...more,
});
const dd = (workDate: string, workedMinutes: number, holiday = false) => ({ workDate, workedMinutes, overtimeMinutes: 0, overtimeMultiplierBp: 15000, shiftsWorked: 1, leavePaidX10: 0, holiday });

describe("C-19 phụ trội giờ làm trong ca ngày lễ / cuối tuần", () => {
  it("mặc định 0 = như cũ; bật hệ số thì giờ trong ca được cộng thêm", () => {
    const days = [dd("2026-09-02", 480, true), dd("2026-10-03", 480)]; // lễ 2/9; thứ Bảy 3/10
    expect(calculatePayslip(base({}, days), DEFAULT_PAYROLL_SETTINGS).gross).toBe(2 * 240_000);
    const p = calculatePayslip(base({}, days), { ...DEFAULT_PAYROLL_SETTINGS, holidayPremiumBp: 20000, weekendPremiumBp: 5000 });
    expect(p.overtimePay).toBe(480_000 + 120_000);
    expect(p.gross).toBe(2 * 240_000 + 600_000);
    expect(p.lines.some((l) => l.label.startsWith("Phụ trội ngày lễ"))).toBe(true);
  });
  it("tham số có trong Cài đặt (migration) và đọc được", async () => {
    const r = await db().prepare(`SELECT key FROM settings WHERE key IN ('hr.holiday_premium_bp','hr.weekend_premium_bp','hr.advance_max_bp','hr.prorate_fixed_pay')`).all();
    expect(r.results).toHaveLength(4);
  });
});

describe("C-20 chấm offline vẫn kiểm nơi chấm", () => {
  const at = () => new Date(Date.now() - 3600_000).toISOString();
  it("không kèm GPS/QR → chờ duyệt + cảnh báo; ngoài vùng → chờ duyệt; trong vùng → tính công kèm cờ", async () => {
    const none = await punch("f5_b", { kind: "in", method: "gps", offline: { clientAt: at() } });
    expect(none.status).toBe(201);
    expect(none.body.punch).toMatchObject({ status: "pending", reviewFlag: false });
    expect(none.body.punch.warning).toContain("không kèm vị trí");
    const row = await db().prepare(`SELECT note FROM attendance_punches WHERE id=?`).bind(none.body.punch.id).first<any>();
    expect(row.note).toContain("chưa xác thực");
    const far = await punch("f5_c", { kind: "in", method: "gps", lat: LAT + 0.05, lng: LNG, accuracyM: 10, offline: { clientAt: at() } });
    expect(far.body.punch.status).toBe("pending");
    expect(far.body.punch.distanceM).toBeGreaterThan(1000);
    const ok = await punch("f5_d", { kind: "in", method: "gps", lat: LAT, lng: LNG, accuracyM: 10, offline: { clientAt: at() } });
    expect(ok.body.punch).toMatchObject({ status: "accepted", reviewFlag: true });
  });
});

describe("C-24 phụ cấp/bảo hiểm theo ngày làm; phút điều chỉnh với lương theo ca", () => {
  const monthly = (hire: string, term: string | null = null) => base({ payType: "monthly", baseSalary: 26_000_000, insuranceSalary: 6_000_000, hireDate: hire, terminationDate: term }, Array.from({ length: 15 }, (_, i) => dd(`2026-09-${String(16 + i).padStart(2, "0")}`, 480)), { period: "2026-09", allowances: [{ name: "Ăn trưa", amount: 3_000_000, taxable: false }] });
  it("vào làm 16/9: phụ cấp và lương đóng BH tính 15/30 ngày", () => {
    const p = calculatePayslip(monthly("2026-09-16"), DEFAULT_PAYROLL_SETTINGS);
    expect(p.allowances).toBe(1_500_000);
    expect(p.insuranceEmployee).toBe(Math.round((3_000_000 * 1050) / 10000));
  });
  it("nghỉ 10/9: 10/30 ngày; cả tháng không có công: 0; tắt tham số: đủ tháng", () => {
    expect(calculatePayslip({ ...monthly("2026-01-01", "2026-09-10"), days: [] }, DEFAULT_PAYROLL_SETTINGS).allowances).toBe(0);
    const p = calculatePayslip(monthly("2026-01-01", "2026-09-10"), DEFAULT_PAYROLL_SETTINGS);
    expect(p.allowances).toBe(1_000_000);
    expect(calculatePayslip(monthly("2026-09-16"), { ...DEFAULT_PAYROLL_SETTINGS, prorateFixedPay: false }).allowances).toBe(3_000_000);
  });
  it("lương theo ca: +480 phút điều chỉnh = +1 ca (trước đây không đổi)", () => {
    const days = Array.from({ length: 10 }, (_, i) => dd(`2026-10-${String(i + 5).padStart(2, "0")}`, 480));
    const p = calculatePayslip(base({ payType: "shift", shiftRate: 200_000 }, days, { adjustMinutes: { work: 480, overtime: 0 } }), DEFAULT_PAYROLL_SETTINGS);
    expect(p.basePay).toBe(11 * 200_000);
  });
});

describe("C-26 nghỉ việc / khoá tài khoản", () => {
  it("chặn khi còn ca POS mở; còn yêu cầu đang chờ thì cần force", async () => {
    await seedStaff({ userId: 730, username: "f5_off", employeeId: 730, role: "cashier" });
    const sh = await db().prepare(`INSERT INTO shifts(store_id, user_id, fund_id, opening_cash) VALUES (1,730,1,0) RETURNING id`).first<any>();
    const t = { terminationDate: vnDate(), reason: "Xin nghỉ" };
    const a = await call("accountant", "POST", `${V}/employees/730/terminate`, t);
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe("open_shift");
    const u = await call("owner", "PUT", `/api/admin/users/730`, { active: false });
    expect([404, 409]).toContain(u.status);
    await db().prepare(`UPDATE shifts SET status='closed', closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).bind(sh.id).run();
    await db().prepare(`INSERT INTO leave_requests(employee_id, leave_type_id, from_date, to_date, days_x10, requested_by) VALUES (730,(SELECT id FROM leave_types LIMIT 1),'2027-01-05','2027-01-05',10,730)`).run();
    const b = await call("accountant", "POST", `${V}/employees/730/terminate`, t);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("pending_requests");
    expect(b.body.error.details.leave).toBe(1);
    const c = await call("accountant", "POST", `${V}/employees/730/terminate`, { ...t, force: true });
    expect(c.status).toBe(200);
  });
});

describe("C-31 duyệt đổi ca kiểm xung đột", () => {
  const D = "2027-03-10";
  const asg = (id: number, emp: number, tpl: number, start: string, end: string) =>
    db().prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at, break_minutes, status) VALUES (?,?,?,?,?,?,0,'scheduled')`).bind(id, emp, D, tpl, start, end);
  const swap = async (id: number, from: number, toEmp: number) =>
    (await db().prepare(`INSERT INTO shift_swap_requests(id, from_assignment_id, to_employee_id, reason, status, requested_by) VALUES (?,?,?, 'đổi', 'accepted', (SELECT user_id FROM employees WHERE id=(SELECT employee_id FROM shift_assignments WHERE id=?))) RETURNING id`).bind(id, from, toEmp, from).first<any>()).id;
  beforeAll(async () => {
    await db().batch([
      db().prepare(`INSERT INTO shift_templates(id, code, name, start_time, end_time) VALUES (950,'FX1','Sáng','08:00','12:00'),(951,'FX2','Sáng muộn','10:00','14:00'),(952,'FX3','Chiều','14:00','18:00')`),
      asg(9801, 700, 950, "2027-03-10T01:00:00.000Z", "2027-03-10T05:00:00.000Z"),
      asg(9802, 702, 951, "2027-03-10T03:00:00.000Z", "2027-03-10T07:00:00.000Z"), // trùng giờ với 9801
      asg(9803, 700, 952, "2027-03-10T07:00:00.000Z", "2027-03-10T11:00:00.000Z"),
    ]);
  });
  it("người nhận trùng giờ → 409 shift_overlap; đang nghỉ phép đã duyệt → 409 leave_conflict; sạch thì duyệt được", async () => {
    const s1 = await swap(9901, 9801, 702);
    const ov = await call("manager", "POST", `${V}/schedule/swaps/${s1}/decide`, { decision: "approved" });
    expect(ov.status).toBe(409);
    expect(ov.body.error.code).toBe("shift_overlap");
    await db().prepare(`UPDATE shift_assignments SET status='cancelled' WHERE id=9802`).run();
    await db().prepare(`INSERT INTO leave_requests(employee_id, leave_type_id, from_date, to_date, days_x10, status, requested_by) VALUES (702,(SELECT id FROM leave_types LIMIT 1),?,?,10,'approved',702)`).bind(D, D).run();
    const lv = await call("manager", "POST", `${V}/schedule/swaps/${s1}/decide`, { decision: "approved" });
    expect(lv.body.error.code).toBe("leave_conflict");
    await db().prepare(`UPDATE leave_requests SET status='cancelled' WHERE employee_id=702`).run().catch(() => {});
  });
  it("ca đã bắt đầu → 422; ca sạch → duyệt được", async () => {
    await db().prepare(`DELETE FROM leave_requests WHERE employee_id=702`).run();
    const s2 = await swap(9902, 9803, 703);
    await db().prepare(`UPDATE shift_assignments SET start_at='2020-01-01T00:00:00.000Z', end_at='2020-01-01T04:00:00.000Z' WHERE id=9803`).run();
    const st = await call("manager", "POST", `${V}/schedule/swaps/${s2}/decide`, { decision: "approved" });
    expect(st.status).toBe(422);
    expect(st.body.error.code).toBe("shift_started");
    await db().prepare(`UPDATE shift_assignments SET start_at='2027-03-10T07:00:00.000Z', end_at='2027-03-10T11:00:00.000Z' WHERE id=9803`).run();
    expect((await call("manager", "POST", `${V}/schedule/swaps/${s2}/decide`, { decision: "approved" })).status).toBe(200);
  });
});
