import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";
import { vnDate } from "../src/worker/lib/time";

// EC-39: màn chuyển việc đang làm cho người khác khi nghỉ việc / khoá tài khoản
const V = "/api/v1";
const db = () => testEnv.DB;
const FUT = (n: number) => { const d = new Date(Date.now() + n * 86400_000 + 7 * 3600_000); return d.toISOString().slice(0, 10); };
let mgr = 0;

beforeAll(async () => {
  await seedBase();
  await seedStaff({ userId: 1100, username: "ho_a", employeeId: 1100, role: "manager" });
  await seedStaff({ userId: 1101, username: "ho_b", employeeId: 1101, role: "manager" });
  await seedStaff({ userId: 1102, username: "ho_c", employeeId: 1102, role: "cashier" });
  mgr = (await db().prepare(`SELECT id FROM users WHERE role='manager' AND id < 1100 LIMIT 1`).first<any>()).id;
  await db().batch([
    db().prepare(`INSERT INTO customers(id, code, type, name, owner_user_id) VALUES (1100,'KH-HO1','b2b','Quán Hạnh Phúc',1100), (1101,'KH-HO2','b2b','Quán Bình An',1100)`),
    db().prepare(`INSERT INTO stock_docs(id, code, type, status, store_id, created_by) VALUES (1100,'PN-HO1','receipt','draft',1,1100), (1101,'PN-HO2','receipt','pending_approval',1,1100)`),
    db().prepare(`INSERT INTO quotes(id, code, customer_id, status, valid_from, valid_until, created_by) VALUES (1100,'BG-HO1',1100,'draft','2026-11-01','2026-12-01',1100)`),
    db().prepare(`INSERT INTO orders(id, code, channel, store_id, status, created_by) VALUES (1100,'SO-HO1','b2b',1,'new',1100), (1101,'DR-HO1','pos',1,'draft',1100)`),
    db().prepare(`INSERT INTO approvals(id, type, status, requested_by) VALUES (1100,'price_below_cost','pending',1100)`),
    db().prepare(`INSERT INTO recurring_orders(id, customer_id, weekdays, lines_json, created_by) VALUES (1100,1100,'1,4','[]',1100)`),
    db().prepare(`INSERT INTO shift_templates(id, code, name, start_time, end_time) VALUES (1100,'HO1','Sáng','08:00','12:00')`),
    db().prepare(`INSERT INTO shift_assignments(employee_id, work_date, shift_template_id, start_at, end_at) VALUES (1100,?,1100,'2030-01-01T01:00:00Z','2030-01-01T05:00:00Z'), (1100,?,1100,'2030-01-02T01:00:00Z','2030-01-02T05:00:00Z')`).bind(FUT(2), FUT(3)),
  ]);
});

describe("EC-39 chuyển việc khi nghỉ việc / khoá tài khoản", () => {
  it("chặn quyền: chỉ hr.manage (quản lý/thu ngân 403)", async () => {
    expect((await call("manager", "GET", `${V}/handover?employeeId=1100`)).status).toBe(403);
    expect((await call("cashier", "POST", `${V}/handover`, { employeeId: 1100, reason: "x", actions: [{ group: "customers", action: "reassign", toUserId: mgr }] })).status).toBe(403);
  });

  it("liệt kê mọi nhóm việc dở + người nhận", async () => {
    const r = await call<any>("owner", "GET", `${V}/handover?employeeId=1100`);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.groups.map((g: any) => [g.key, g]));
    expect(by.customers.count).toBe(2);
    expect(by.stock_docs.count).toBe(2);
    expect(by.stock_docs.cancel).toBeNull(); // có phiếu chờ duyệt → chỉ chuyển
    expect(by.quotes.cancel).toBeTruthy();
    expect(by.orders.count).toBe(2);
    expect(by.approvals.count).toBe(1);
    expect(by.recurring_orders.count).toBe(1);
    expect(by.shifts.count).toBe(2);
    expect(r.body.recipients.users.some((u: any) => u.id === 1100)).toBe(false);
    // truy cập theo userId cho ra cùng kết quả
    const r2 = await call<any>("owner", "GET", `${V}/handover?userId=1100`);
    expect(r2.body.total).toBe(r.body.total);
  });

  it("còn việc dở → nghỉ việc bị chặn (force) ; ca POS đang mở không chuyển được", async () => {
    const t = { terminationDate: vnDate(), reason: "Nghỉ" };
    expect((await call<any>("owner", "POST", `${V}/employees/1100/terminate`, t)).body.error.code).toBe("pending_requests");
    await db().prepare(`INSERT INTO shifts(id, store_id, user_id, fund_id, opening_cash) VALUES (1100,1,1102,1,0)`).run();
    const r = await call<any>("owner", "GET", `${V}/handover?userId=1102`);
    expect(r.body.openShifts).toBe(1);
    expect((await call<any>("owner", "POST", `${V}/employees/1102/terminate`, t)).body.error.code).toBe("open_shift");
    await db().prepare(`DELETE FROM shifts WHERE id=1100`).run();
  });

  it("validate: người nhận phải đang hoạt động, đủ quyền; huỷ chỉ khi toàn nháp; không trùng nhóm", async () => {
    const act = (a: any[]) => call<any>("owner", "POST", `${V}/handover`, { employeeId: 1100, reason: "Nghỉ việc", actions: a });
    expect((await act([{ group: "customers", action: "reassign", toUserId: 1100 }])).status).toBe(422);
    expect((await act([{ group: "customers", action: "reassign", toUserId: 99999 }])).body.error.code).toBe("invalid_recipient");
    expect((await act([{ group: "customers", action: "reassign", toUserId: 1102 }])).body.error.code).toBe("invalid_recipient"); // thu ngân không có b2b.write
    expect((await act([{ group: "stock_docs", action: "cancel" }])).body.error.code).toBe("cancel_not_allowed");
    expect((await act([{ group: "approvals", action: "cancel" }])).body.error.code).toBe("cancel_not_allowed");
    expect((await act([{ group: "x", action: "reassign", toUserId: mgr }])).status).toBe(422);
    expect((await act([{ group: "customers", action: "reassign", toUserId: mgr }, { group: "customers", action: "cancel" }])).status).toBe(422);
    expect((await call("owner", "POST", `${V}/handover`, { employeeId: 1100, reason: "", actions: [{ group: "customers", action: "reassign", toUserId: mgr }] })).status).toBe(422);
    const n = await db().prepare(`SELECT COUNT(*) n FROM customers WHERE owner_user_id=1100`).first<any>();
    expect(n.n).toBe(2); // không nhóm nào bị đổi khi lỗi
  });

  it("chuyển trong MỘT batch + audit; sau đó nghỉ việc không còn bị chặn", async () => {
    // ca: người nhận trùng ca thì chặn
    await db().prepare(`INSERT INTO shift_assignments(employee_id, work_date, shift_template_id, start_at, end_at) VALUES (1101,?,1100,'2030-01-01T01:00:00Z','2030-01-01T05:00:00Z')`).bind(FUT(2)).run();
    const clash = await call<any>("owner", "POST", `${V}/handover`, { employeeId: 1100, reason: "Nghỉ việc", actions: [{ group: "customers", action: "reassign", toUserId: mgr }, { group: "shifts", action: "reassign", toEmployeeId: 1101 }] });
    expect(clash.body.error.code).toBe("shift_conflict");
    expect((await db().prepare(`SELECT COUNT(*) n FROM customers WHERE owner_user_id=?`).bind(mgr).first<any>()).n).toBe(0);
    await db().prepare(`DELETE FROM shift_assignments WHERE employee_id=1101`).run();

    const auditBefore = (await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='hr.handover'`).first<any>()).n;
    const actions = [
      { group: "customers", action: "reassign", toUserId: mgr },
      { group: "stock_docs", action: "reassign", toUserId: 1101 },
      { group: "quotes", action: "cancel" },
      { group: "orders", action: "reassign", toUserId: mgr },
      { group: "approvals", action: "reassign", toUserId: 1101 },
      { group: "recurring_orders", action: "cancel" },
      { group: "shifts", action: "reassign", toEmployeeId: 1101 },
    ];
    const r = await call<any>("owner", "POST", `${V}/handover`, { employeeId: 1100, reason: "Nghỉ việc, bàn giao", actions });
    expect(r.status).toBe(200);
    expect(r.body.remaining.total).toBe(0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM customers WHERE owner_user_id=?`).bind(mgr).first<any>()).n).toBe(2);
    expect((await db().prepare(`SELECT created_by FROM stock_docs WHERE id=1101`).first<any>()).created_by).toBe(1101);
    expect((await db().prepare(`SELECT status FROM quotes WHERE id=1100`).first<any>()).status).toBe("cancelled");
    expect((await db().prepare(`SELECT active FROM recurring_orders WHERE id=1100`).first<any>()).active).toBe(0);
    expect((await db().prepare(`SELECT requested_by FROM approvals WHERE id=1100`).first<any>()).requested_by).toBe(1101);
    expect((await db().prepare(`SELECT COUNT(*) n FROM shift_assignments WHERE employee_id=1101`).first<any>()).n).toBe(2);
    const au = await db().prepare(`SELECT reason, after_json FROM audit_log WHERE action='hr.handover' ORDER BY id DESC LIMIT 1`).first<any>();
    expect(au.reason).toBe("Nghỉ việc, bàn giao");
    expect(JSON.parse(au.after_json).groups.customers).toMatchObject({ action: "reassign", toUserId: mgr, count: 2 });
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='hr.handover'`).first<any>()).n).toBe(auditBefore + 1);
    // lặp lại → không còn gì để chuyển
    expect((await call<any>("owner", "POST", `${V}/handover`, { employeeId: 1100, reason: "x", actions: [{ group: "customers", action: "reassign", toUserId: mgr }] })).body.error.code).toBe("nothing_to_hand_over");

    const t = await call<any>("owner", "POST", `${V}/employees/1100/terminate`, { terminationDate: vnDate(), reason: "Nghỉ việc" });
    expect(t.status).toBe(200);
    expect((await db().prepare(`SELECT active FROM users WHERE id=1100`).first<any>()).active).toBe(0);
  });

  it("khoá tài khoản (PUT /users) cũng hết bị chặn sau khi chuyển; kỳ công đã chốt thì không đụng ca", async () => {
    await db().prepare(`INSERT INTO customers(id, code, type, name, owner_user_id) VALUES (1110,'KH-HO9','b2b','Quán Lẻ',1101)`).run();
    expect((await call<any>("owner", "PUT", `${V}/users/1101`, { active: false })).body.error.code).toBe("pending_requests");
    // chốt mọi tháng có ca tương lai của người này (ca có thể rơi vào 2 tháng khi chạy gần cuối tháng)
    const months = (await db().prepare(`SELECT DISTINCT substr(work_date,1,7) m FROM shift_assignments WHERE employee_id=1101`).all<any>()).results.map((r: any) => r.m);
    for (const m of months) await db().prepare(`INSERT INTO timesheets(period, status) VALUES (?, 'closed') ON CONFLICT(period) DO UPDATE SET status='closed'`).bind(m).run().catch(() => {});
    const g = await call<any>("owner", "GET", `${V}/handover?userId=1101`);
    expect(g.body.groups.find((x: any) => x.key === "shifts")).toBeUndefined();
    const r = await call<any>("owner", "POST", `${V}/handover`, { userId: 1101, reason: "Khoá TK", actions: [{ group: "customers", action: "reassign", toUserId: mgr }, { group: "stock_docs", action: "reassign", toUserId: mgr }, { group: "approvals", action: "reassign", toUserId: mgr }] });
    expect(r.status).toBe(200);
    expect((await call<any>("owner", "PUT", `${V}/users/1101`, { active: false })).status).toBe(200);
  });
});
