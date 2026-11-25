import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";
import { sweepJobs } from "../src/worker/services/jobs";

// Fix 6c: C-27 thông báo cho người duyệt / báo lại người yêu cầu
const V = "/api/v1";
const db = () => testEnv.DB;
const flush = () => sweepJobs(testEnv, { inline: true, limit: 200 });
const bell = async (role: string) => (await call(role, "GET", `${V}/notifications`)).body as { items: any[]; unread: number };
const titles = async (role: string) => (await bell(role)).items.map((n) => n.title as string);

beforeAll(async () => {
  await seedBase();
  await seedStaff({ userId: 900, username: "n6_nv", employeeId: 900 });
  await seedStaff({ userId: 901, username: "n6_nv2", employeeId: 901 });
  await flush();
});

const insertApproval = async (type: string, by: number, payload: unknown = {}) => {
  const r = await db().prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES (?, 'x', '1', ?, 'Số tiền 98765432 đ giá vốn 12345', ?)`).bind(type, JSON.stringify(payload), by).run();
  await flush();
  return r.meta.last_row_id as number;
};

describe("C-27 approvals", () => {
  it("phiếu chi chờ duyệt: chỉ người có finance.approve (chủ) nhận; không lộ số tiền", async () => {
    await insertApproval("cash_voucher.post", 3, { amount: 98765432 });
    const o = await bell("owner");
    const n = o.items.find((x) => x.title === "Phiếu chi chờ duyệt");
    expect(n).toBeTruthy();
    expect(n.url).toBe("/approvals");
    expect(JSON.stringify(n)).not.toMatch(/98765432|12345/);
    expect(await titles("manager")).not.toContain("Phiếu chi chờ duyệt"); // quản lý không có finance.approve
    expect(await titles("cashier")).not.toContain("Phiếu chi chờ duyệt"); // người yêu cầu không tự nhận
    expect(await titles("accountant")).not.toContain("Phiếu chi chờ duyệt");
  });

  it("bán dưới giá vốn: quản lý và chủ nhận, thu ngân (người yêu cầu) không nhận, nội dung không có giá vốn", async () => {
    await insertApproval("order.below_cost", 3, { cost: 777777 });
    for (const r of ["owner", "manager"]) {
      const n = (await bell(r)).items.find((x) => x.title === "Bán dưới giá vốn chờ duyệt");
      expect(n, r).toBeTruthy();
      expect(JSON.stringify(n)).not.toMatch(/777777|12345/);
    }
    expect(await titles("cashier")).not.toContain("Bán dưới giá vốn chờ duyệt");
    expect(await titles("warehouse")).not.toContain("Bán dưới giá vốn chờ duyệt");
  });

  it("duyệt / từ chối → báo lại đúng người yêu cầu", async () => {
    const id = await insertApproval("order.discount", 3);
    const dec = await call("manager", "POST", `${V}/approvals/${id}/decide`, { decision: "rejected", note: "Giảm quá sâu" });
    expect(dec.status).toBe(200);
    await flush();
    const c = await bell("cashier");
    const n = c.items.find((x) => x.title === "Giảm giá đơn hàng: bị từ chối");
    expect(n).toBeTruthy();
    expect(n.body).toContain("Giảm quá sâu");
    expect(c.unread).toBeGreaterThan(0);
    // người khác không thấy thông báo gửi riêng cho thu ngân
    expect(await titles("warehouse")).not.toContain("Giảm giá đơn hàng: bị từ chối");
    expect(await titles("owner")).not.toContain("Giảm giá đơn hàng: bị từ chối");
  });

  it("đọc thông báo: chỉ người nhận; chạy lại job không nhân đôi", async () => {
    const c = await bell("cashier");
    const n = c.items[0];
    expect((await call("warehouse", "POST", `${V}/notifications/${n.id}/read`, {})).status).toBe(404);
    expect((await call("cashier", "POST", `${V}/notifications/${n.id}/read`, {})).status).toBe(200);
    const before = (await db().prepare(`SELECT COUNT(*) n FROM notifications`).first<{ n: number }>())!.n;
    await db().prepare(`UPDATE integration_jobs SET status='queued', next_run_at='2000-01-01' WHERE type='notify.approval'`).run();
    await flush();
    expect((await db().prepare(`SELECT COUNT(*) n FROM notifications`).first<{ n: number }>())!.n).toBe(before);
  });

  it("tham số tắt thông báo / tắt theo nhóm", async () => {
    await db().prepare(`UPDATE settings SET value='finance,hr,other' WHERE key='notify.approval.groups'`).run();
    await insertApproval("order.discount", 3, { marker: "sales-off" });
    expect((await bell("manager")).items.filter((x) => x.title === "Giảm giá đơn hàng chờ duyệt").length).toBe(1); // chỉ cái cũ (id trước đó đã tạo)
    await db().prepare(`UPDATE settings SET value='finance,sales,stock,hr,other' WHERE key='notify.approval.groups'`).run();
    await db().prepare(`UPDATE settings SET value='0' WHERE key='notify.approval.enabled'`).run();
    const before = (await bell("owner")).items.length;
    await insertApproval("cash_voucher.post", 3);
    expect((await bell("owner")).items.length).toBe(before);
    await db().prepare(`UPDATE settings SET value='1' WHERE key='notify.approval.enabled'`).run();
  });
});

describe("C-27 nhân sự", () => {
  it("nghỉ phép: quản lý/chủ nhận (không phải thu ngân), NV được báo lại khi duyệt", async () => {
    const r = await call("n6_nv", "POST", `${V}/me/leave-requests`, { leaveTypeCode: "annual", fromDate: "2027-03-01", toDate: "2027-03-02" });
    expect(r.status).toBe(201);
    await flush();
    for (const role of ["manager", "owner"]) {
      const n = (await bell(role)).items.find((x) => x.title === "Đơn nghỉ phép chờ duyệt");
      expect(n, role).toBeTruthy();
      expect(n.body).toContain("NV n6_nv");
      expect(n.url).toBe("/hr/attendance");
    }
    expect(await titles("cashier")).not.toContain("Đơn nghỉ phép chờ duyệt");
    expect(await titles("n6_nv")).not.toContain("Đơn nghỉ phép chờ duyệt");
    const d = await call("manager", "POST", `${V}/leave-requests/${r.body.id}/decide`, { decision: "approved" });
    expect(d.status).toBe(200);
    await flush();
    expect(await titles("n6_nv")).toContain("Đơn nghỉ phép 01/03–02/03: đã được duyệt");
  });

  it("bổ sung công + tăng ca chờ duyệt", async () => {
    const c = await call("n6_nv", "POST", `${V}/me/attendance/corrections`, { workDate: "2026-09-03", type: "missing_out", requestedAt: "2026-09-03T08:00:00.000Z", reason: "Quên chấm ra" });
    expect(c.status).toBe(201);
    const o = await call("n6_nv", "POST", `${V}/me/overtime-requests`, { workDate: "2026-09-10", minutes: 90 });
    expect(o.status).toBe(201);
    await flush();
    const t = await titles("manager");
    expect(t).toContain("Bổ sung công chờ duyệt");
    expect(t).toContain("Tăng ca chờ duyệt");
    const ot = (await bell("manager")).items.find((x) => x.title === "Tăng ca chờ duyệt");
    expect(ot.body).toContain("90 phút");
  });

  it("đổi ca: người nhận ca được hỏi trước, quản lý nhận sau khi đồng ý, kết quả báo cả hai", async () => {
    const tpl = await db().prepare(`INSERT INTO shift_templates(code, name, start_time, end_time) VALUES ('S6C','Sáng6c','07:00','12:00')`).run();
    const day = "2099-05-05";
    const a = await db().prepare(`INSERT INTO shift_assignments(employee_id, work_date, shift_template_id, start_at, end_at) VALUES (900, ?, ?, '2099-05-05T00:00:00.000Z', '2099-05-05T05:00:00.000Z')`).bind(day, tpl.meta.last_row_id).run();
    const sw = await call("n6_nv", "POST", `${V}/schedule/swaps`, { fromAssignmentId: a.meta.last_row_id, toEmployeeId: 901, reason: "Bận việc nhà" });
    expect(sw.status).toBe(201);
    await flush();
    expect(await titles("n6_nv2")).toContain("Có người nhờ bạn đổi ca");
    expect(await titles("manager")).not.toContain("Đổi ca chờ duyệt");
    expect((await call("n6_nv2", "POST", `${V}/schedule/swaps/${sw.body.id}/accept`, {})).status).toBe(200);
    await flush();
    expect(await titles("manager")).toContain("Đổi ca chờ duyệt");
    expect((await call("manager", "POST", `${V}/schedule/swaps/${sw.body.id}/decide`, { decision: "rejected", note: "Thiếu người" })).status).toBe(200);
    await flush();
    expect((await titles("n6_nv")).some((t) => t.startsWith("Đổi ca ngày 05/05: bị từ chối"))).toBe(true);
    expect((await titles("n6_nv2")).some((t) => t.startsWith("Đổi ca ngày 05/05: bị từ chối"))).toBe(true);
  });
});
