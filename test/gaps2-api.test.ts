import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";

const V = "/api/v1";
const db = () => testEnv.DB;

beforeAll(async () => {
  await seedBase();
  await seedStaff({ userId: 9801, username: "nv_g2", employeeId: 9801 });
  await db().prepare(`INSERT INTO customers(id, code, type, name, customer_group_id) VALUES (9801,'KS-G2','b2b','Khách G2',1)`).run();
});

describe("PUT /price-lists/:id", () => {
  it("quản lý sửa bảng giá + audit; thu ngân bị chặn; 404; validate", async () => {
    const c = await api("manager", "POST", `${V}/price-lists`, { name: "KM G2", channel: "pos", kind: "promo", priority: 5 });
    expect(c.status).toBe(201);
    const body = { name: "KM G2 sửa", channel: "online", kind: "group", priority: 30, customerGroupId: 2, active: false };
    const u = await api("manager", "PUT", `${V}/price-lists/${c.body.id}`, body);
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ name: "KM G2 sửa", channel: "online", kind: "group", priority: 30, customerGroupId: 2, active: false });
    const a = await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='price_list.update' AND entity_id=?`).bind(String(c.body.id)).first<{ n: number }>();
    expect(a!.n).toBe(1);
    expect((await api("cashier", "PUT", `${V}/price-lists/${c.body.id}`, body)).status).toBe(403);
    expect((await api("manager", "PUT", `${V}/price-lists/99999`, body)).status).toBe(404);
    expect((await api("manager", "PUT", `${V}/price-lists/${c.body.id}`, { ...body, priority: -1 })).status).toBe(422);
  });
  it("không cho tắt bảng giá nền cuối cùng", async () => {
    const r = await api("manager", "PUT", `${V}/price-lists/1`, { name: "Giá chung", channel: "all", kind: "base", priority: 0, active: false });
    expect(r.status).toBe(409);
  });
});

describe("GET /users/assignable", () => {
  it("quản lý xem được: chỉ owner/manager đang hoạt động, chỉ id + fullName", async () => {
    const r = await api("manager", "GET", `${V}/users/assignable`);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThanOrEqual(2);
    for (const u of r.body.items) expect(Object.keys(u).sort()).toEqual(["fullName", "id"]);
    const names = r.body.items.map((u: any) => u.fullName);
    expect(names).toContain("Test owner");
    expect(names).not.toContain("Test cashier");
  });
  it("loại user đã khoá; vai trò không có b2b.write bị chặn", async () => {
    await db().prepare(`UPDATE users SET active = 0 WHERE username = 'manager'`).run();
    const r = await api("owner", "GET", `${V}/users/assignable`);
    expect(r.body.items.map((u: any) => u.fullName)).not.toContain("Test manager");
    await db().prepare(`UPDATE users SET active = 1 WHERE username = 'manager'`).run();
    expect((await api("cashier", "GET", `${V}/users/assignable`)).status).toBe(403);
    expect((await api("warehouse", "GET", `${V}/users/assignable`)).status).toBe(403);
  });
});

describe("/leave-types", () => {
  it("mặc định có 3 loại; nhân viên (hr.self) đọc được, cashier-no-hr không", async () => {
    const r = await call("nv_g2", "GET", `${V}/leave-types`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => x.code)).toEqual(expect.arrayContaining(["annual", "sick", "unpaid"]));
    expect(r.body.items.find((x: any) => x.code === "annual")).toMatchObject({ paid: true, usesBalance: true, active: true });
  });
  it("accountant (hr.manage) tạo/sửa; trùng mã 409; staff không ghi được; audit", async () => {
    const c = await api("accountant", "POST", `${V}/leave-types`, { code: "wedding", name: "Nghỉ cưới", paid: true, usesBalance: false });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: "wedding", active: true });
    expect((await api("accountant", "POST", `${V}/leave-types`, { code: "wedding", name: "Trùng", paid: true, usesBalance: false })).status).toBe(409);
    expect((await api("accountant", "POST", `${V}/leave-types`, { code: "Bad Code", name: "x", paid: true, usesBalance: false })).status).toBe(422);
    expect((await call("nv_g2", "POST", `${V}/leave-types`, { code: "zzz", name: "x", paid: true, usesBalance: false })).status).toBe(403);
    expect((await call("nv_g2", "PUT", `${V}/leave-types/${c.body.id}`, { name: "x" })).status).toBe(403);
    const u = await api("accountant", "PUT", `${V}/leave-types/${c.body.id}`, { name: "Cưới", paid: false });
    expect(u.body).toMatchObject({ name: "Cưới", paid: false, code: "wedding" });
    expect((await api("accountant", "PUT", `${V}/leave-types/99999`, { name: "x" })).status).toBe(404);
    const a = await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'hr.leave_type.%'`).first<{ n: number }>();
    expect(a!.n).toBe(2);
  });
  it("loại đã tắt: ẩn khỏi danh sách mặc định, không xin nghỉ được; vẫn thấy với all=1", async () => {
    const list = await api("accountant", "GET", `${V}/leave-types`);
    const w = list.body.items.find((x: any) => x.code === "wedding");
    expect((await api("accountant", "PUT", `${V}/leave-types/${w.id}`, { active: false })).body.active).toBe(false);
    expect((await call("nv_g2", "GET", `${V}/leave-types`)).body.items.map((x: any) => x.code)).not.toContain("wedding");
    expect((await api("accountant", "GET", `${V}/leave-types?all=1`)).body.items.map((x: any) => x.code)).toContain("wedding");
    const req = await call("nv_g2", "POST", `${V}/me/leave-requests`, { leaveTypeCode: "wedding", fromDate: "2099-02-02", toDate: "2099-02-02" });
    expect(req.status).toBe(422);
    const ok = await call("nv_g2", "POST", `${V}/me/leave-requests`, { leaveTypeCode: "sick", fromDate: "2099-02-02", toDate: "2099-02-02" });
    expect(ok.status).toBe(201);
  });
});

describe("GET /debts/payments — lọc", () => {
  it("lọc theo direction, partner, khoảng ngày, trạng thái; có partnerName", async () => {
    const p = await api("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: 9801, fundId: 1, amount: 120_000, method: "cash" });
    expect(p.status).toBe(201);
    const id = p.body.payment.id;
    const all = await api("accountant", "GET", `${V}/debts/payments?direction=in&partnerType=customer&partnerId=9801`);
    expect(all.body.items.map((x: any) => x.id)).toContain(id);
    expect(all.body.items[0].partnerName).toBe("Khách G2");
    expect((await api("accountant", "GET", `${V}/debts/payments?direction=out&partnerId=9801`)).body.items).toHaveLength(0);
    expect((await api("accountant", "GET", `${V}/debts/payments?from=2099-01-01`)).body.items).toHaveLength(0);
    expect((await api("accountant", "GET", `${V}/debts/payments?to=2000-01-01`)).body.items).toHaveLength(0);
    const day = (await db().prepare(`SELECT substr(datetime(substr(paid_at,1,19), '+7 hours'),1,10) d FROM debt_payments WHERE id=?`).bind(id).first<{ d: string }>())!.d;
    expect((await api("accountant", "GET", `${V}/debts/payments?from=${day}&to=${day}&status=posted`)).body.items.map((x: any) => x.id)).toContain(id);
    expect((await api("accountant", "POST", `${V}/debts/payments/${id}/reverse`, { reason: "nhập nhầm" })).status).toBe(200);
    expect((await api("accountant", "GET", `${V}/debts/payments?status=posted&partnerId=9801`)).body.items.map((x: any) => x.id)).not.toContain(id);
    expect((await api("accountant", "GET", `${V}/debts/payments?status=reversed&partnerId=9801`)).body.items.map((x: any) => x.id)).toContain(id);
  });
});
