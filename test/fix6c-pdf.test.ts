import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { api, login, PASSWORD, seedBase, testEnv } from "./helpers";
import { app } from "../src/worker/index";
import { hashPassword } from "../src/worker/lib/crypto";
import { FONT_KEYS } from "../src/worker/services/pdf";
// Font thật lấy từ gói npm devDependency (không commit file font)
import regularFont from "@expo-google-fonts/be-vietnam-pro/400Regular/BeVietnamPro_400Regular.ttf?inline";
import boldFont from "@expo-google-fonts/be-vietnam-pro/700Bold/BeVietnamPro_700Bold.ttf?inline";

// Fix 6c: C-28 PDF báo cáo + phiếu lương
const db = () => testEnv.DB;
const V = "/api/v1";
const fromDataUri = (u: string) => Uint8Array.from(atob(u.slice(u.indexOf(",") + 1)), (c) => c.charCodeAt(0));

async function getPdf(role: string, path: string) {
  const token = await login(role);
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } }, testEnv);
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), disp: res.headers.get("content-disposition"), buf };
}
const isPdf = (b: Uint8Array) => new TextDecoder("latin1").decode(b.slice(0, 5)) === "%PDF-";

beforeAll(async () => {
  await seedBase();
  await testEnv.FILES.put(FONT_KEYS.regular, fromDataUri(regularFont));
  await testEnv.FILES.put(FONT_KEYS.bold, fromDataUri(boldFont));
  const hash = await hashPassword(PASSWORD);
  await db().batch([
    db().prepare(`INSERT INTO users(id, username, full_name, pass_hash, role, store_id) VALUES (9101,'pdf_a','Nguyễn Văn A',?,'staff',1),(9102,'pdf_b','Trần Thị B',?,'staff',1)`).bind(hash, hash),
    db().prepare(
      `INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date, pay_type, base_salary, insurance_salary) VALUES
        (9101,'NV-PA',9101,'Nguyễn Văn A','thu ngân',1,'2026-01-01','monthly',10400000,10000000),
        (9102,'NV-PB',9102,'Trần Thị B','kho',1,'2026-01-01','monthly',9000000,0)`),
    db().prepare(`INSERT INTO timesheets(period, status) VALUES ('2026-10','open')`),
    ...Array.from({ length: 26 }, (_, i) => [9101, 9102].map((e) => db().prepare(`INSERT INTO timesheet_days(period, employee_id, work_date, worked_minutes, shifts_worked) VALUES ('2026-10',?,?,480,1)`).bind(e, `2026-10-${String(i + 1).padStart(2, "0")}`))).flat(),
    db().prepare(`UPDATE timesheets SET status='closed' WHERE period='2026-10'`),
  ]);
  expect((await api("accountant", "POST", `${V}/payroll/periods/2026-10/calculate`)).status).toBe(200);
});

describe("C-28 PDF lương", () => {
  it("phiếu lương cá nhân: chỉ khi kỳ đã duyệt, chỉ của chính mình", async () => {
    expect((await getPdf("pdf_a", `${V}/me/payslips/2026-10/pdf`)).status).toBe(404); // chưa duyệt
    expect((await api("owner", "POST", `${V}/payroll/periods/2026-10/approve`, {})).status).toBe(200);
    const a = await getPdf("pdf_a", `${V}/me/payslips/2026-10/pdf`);
    expect(a.status).toBe(200);
    expect(a.type).toBe("application/pdf");
    expect(a.disp).toContain("NV-PA");
    expect(isPdf(a.buf)).toBe(true);
    expect((await PDFDocument.load(a.buf)).getPageCount()).toBe(1);
    const b = await getPdf("pdf_b", `${V}/me/payslips/2026-10/pdf`);
    expect(b.disp).toContain("NV-PB"); // luôn là phiếu của người đang đăng nhập, không có tham số chọn người khác
    expect(a.buf.length).not.toBe(0);
  });

  it("phiếu lương theo nhân viên và bảng lương kỳ: chỉ hr.sensitive (chủ/kế toán)", async () => {
    for (const role of ["owner", "accountant"]) {
      const p = await getPdf(role, `${V}/payroll/periods/2026-10/payslips/9101/pdf`);
      expect(p.status, role).toBe(200);
      expect(p.type).toBe("application/pdf");
      expect(isPdf(p.buf)).toBe(true);
      const t = await getPdf(role, `${V}/payroll/periods/2026-10/export.pdf`);
      expect(t.status, role).toBe(200);
      expect(isPdf(t.buf)).toBe(true);
    }
    for (const role of ["manager", "cashier", "warehouse", "online_staff", "pdf_a"]) {
      expect((await getPdf(role, `${V}/payroll/periods/2026-10/payslips/9102/pdf`)).status, role).toBe(403);
      expect((await getPdf(role, `${V}/payroll/periods/2026-10/export.pdf`)).status, role).toBe(403);
    }
    expect((await getPdf("accountant", `${V}/payroll/periods/2026-10/payslips/99999/pdf`)).status).toBe(404);
    expect((await getPdf("accountant", `${V}/payroll/periods/2030-01/export.pdf`)).status).toBe(404);
  });

  it("thiếu font → 501, không lộ lỗi khác", async () => {
    await testEnv.FILES.delete(FONT_KEYS.bold);
    expect((await getPdf("accountant", `${V}/payroll/periods/2026-10/export.pdf`)).status).toBe(501);
    await testEnv.FILES.put(FONT_KEYS.bold, fromDataUri(boldFont));
  });

  it("ghi nhật ký khi tải phiếu lương", async () => {
    const n = (await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='payslip.pdf'`).first<{ n: number }>())!.n;
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe("C-28 PDF lãi lỗ và tuổi nợ", () => {
  it("lãi lỗ: reports.view", async () => {
    for (const role of ["owner", "manager", "accountant"]) {
      const r = await getPdf(role, `${V}/reports/pnl.pdf?from=2026-10-01&to=2026-10-31&groupBy=channel`);
      expect(r.status, role).toBe(200);
      expect(r.type).toBe("application/pdf");
      expect(isPdf(r.buf)).toBe(true);
    }
    for (const role of ["cashier", "warehouse", "online_staff", "pdf_a"]) expect((await getPdf(role, `${V}/reports/pnl.pdf`)).status, role).toBe(403);
    expect((await getPdf("owner", `${V}/reports/pnl.pdf?from=abc`)).status).toBe(422);
  });

  it("tuổi nợ phải thu/phải trả: debt.view", async () => {
    for (const side of ["receivable", "payable"]) {
      const r = await getPdf("accountant", `${V}/debts/aging.pdf?side=${side}`);
      expect(r.status).toBe(200);
      expect(r.type).toBe("application/pdf");
      expect(isPdf(r.buf)).toBe(true);
    }
    expect((await getPdf("cashier", `${V}/debts/aging.pdf`)).status).toBe(403);
    expect((await getPdf("pdf_a", `${V}/debts/aging.pdf`)).status).toBe(403);
  });
});
