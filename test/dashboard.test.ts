import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { call, seedStaff } from "./hr-helpers";
import { vnDate } from "../src/worker/lib/time";

const today = vnDate();
let orderId = 0;

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await testEnv.DB.prepare(`INSERT INTO customers(id, code, type, name, phone) VALUES (9701,'KL-D1','retail','Chị Hạnh','0988777666')`).run();
  await seedStaff({ userId: 20, username: "nv-dash", employeeId: 20 });
  await api("cashier", "POST", "/api/v1/shifts/open", { openingCash: 0 });
  const sale = await api("cashier", "POST", "/api/v1/pos/orders", { clientUuid: "dash-sale-0001", customerId: 9701, lines: [{ productId: 1, unit: "kg", qty: 2 }], payments: [{ method: "cash", amount: 200000 }] });
  expect(sale.status).toBe(201);
  orderId = sale.body.id;
  const sale2 = await api("cashier", "POST", "/api/v1/pos/orders", { clientUuid: "dash-sale-0002", lines: [{ productId: 2, unit: "kg", qty: 1 }], payments: [{ method: "transfer", amount: 200000 }] });
  expect(sale2.status).toBe(201);
});

describe("GET /dashboard", () => {
  it("owner sees sales with gross profit, 7-day series and todo sections", async () => {
    const r = await api("owner", "GET", "/api/v1/dashboard");
    expect(r.status).toBe(200);
    expect(r.body.today).toBe(today);
    expect(r.body.sales.canSeeCost).toBe(true);
    expect(r.body.sales.today).toMatchObject({ orders: 2, revenue: 400000, grossProfit: 400000 - 120000 - 150000 });
    expect(r.body.sales.yesterday).toMatchObject({ orders: 0, revenue: 0 });
    expect(r.body.series7d).toHaveLength(7);
    expect(r.body.series7d[6]).toMatchObject({ day: today, revenue: 400000, orders: 2 });
    expect(r.body.sales.today.byChannel).toEqual([{ channel: "pos", orders: 2, revenue: 400000 }]);
    for (const k of ["approvalsPending", "onlinePending", "b2bDeliveries", "stock", "overdueDebt", "attendanceReview"]) expect(r.body.todo).toHaveProperty(k);
  });

  it("cashier sees revenue but never cost / approvals / debt / HR sections", async () => {
    const r = await api("cashier", "GET", "/api/v1/dashboard");
    expect(r.status).toBe(200);
    expect(r.body.sales.canSeeCost).toBe(false);
    expect(r.body.sales.today).not.toHaveProperty("grossProfit");
    expect(JSON.stringify(r.body)).not.toMatch(/grossProfit|costTotal|unitCost|salary|"net"/i);
    expect(r.body.todo).not.toHaveProperty("approvalsPending");
    expect(r.body.todo).not.toHaveProperty("overdueDebt");
    expect(r.body.todo).not.toHaveProperty("attendanceReview");
  });

  it("warehouse has orders.view + cost perm but not reports.view → no gross profit", async () => {
    const r = await api("warehouse", "GET", "/api/v1/dashboard");
    expect(r.body.sales.canSeeCost).toBe(false);
    expect(r.body.sales.today).not.toHaveProperty("grossProfit");
    expect(r.body.todo).toHaveProperty("stock");
    expect(r.body.todo).not.toHaveProperty("attendanceReview");
  });

  it("manager sees approvals + attendance review; accountant sees debt but not approvals", async () => {
    const m = await api("manager", "GET", "/api/v1/dashboard");
    expect(m.body.todo).toHaveProperty("approvalsPending");
    expect(m.body.todo).toHaveProperty("attendanceReview");
    expect(m.body.sales.canSeeCost).toBe(true);
    const a = await api("accountant", "GET", "/api/v1/dashboard");
    expect(a.body.todo).toHaveProperty("overdueDebt");
    expect(a.body.todo).not.toHaveProperty("approvalsPending");
  });

  it("staff (hr.self only) gets an empty dashboard, never data", async () => {
    const r = await call("nv-dash", "GET", "/api/v1/dashboard");
    expect(r.status).toBe(200);
    expect(r.body.sales).toBeUndefined();
    expect(r.body.series7d).toBeUndefined();
    expect(r.body.todo).toEqual({});
  });

  it("rejects unauthenticated calls", async () => {
    const { app } = await import("../src/worker/index");
    const res = await app.request("/api/v1/dashboard", {}, testEnv);
    expect(res.status).toBe(401);
  });

  it("counts pending approvals, new online orders and overdue invoices", async () => {
    const db = testEnv.DB;
    await db.prepare(`INSERT INTO approvals(type, reason, requested_by) VALUES ('price_below_cost','test',3)`).run();
    await db.prepare(`INSERT INTO orders(code, channel, kind, store_id, status, total) VALUES ('ON-D-1','online','sale',1,'new',50000)`).run();
    await db.prepare(`INSERT INTO orders(code, channel, kind, store_id, status, total, delivery_date) VALUES ('DS-D-1','b2b','sale',1,'confirmed',50000,?)`).bind(today).run();
    await db.prepare(`INSERT INTO orders(code, channel, kind, store_id, status, total, delivery_date) VALUES ('DS-D-2','b2b','sale',1,'preparing',50000,'2020-01-01')`).run();
    const r = await api("owner", "GET", "/api/v1/dashboard");
    expect(r.body.todo.approvalsPending).toBeGreaterThanOrEqual(1);
    expect(r.body.todo.onlinePending).toBe(1);
    expect(r.body.todo.b2bDeliveries).toEqual({ dueToday: 1, late: 1 });
  });
});

describe("GET /orders filters + summary", () => {
  it("filters by from/to, channel, cashier, method, q (code / customer name / phone) and keeps legacy day", async () => {
    const all = await api("owner", "GET", `/api/v1/orders?from=${today}&to=${today}`);
    expect(all.status).toBe(200);
    expect(all.body.summary).toMatchObject({ saleCount: 2, saleTotal: 400000, revenue: 400000, avgOrder: 200000, returnCount: 0, cancelledCount: 0 });
    expect((await api("owner", "GET", `/api/v1/orders?day=${today}&channel=pos`)).body.items.length).toBeGreaterThanOrEqual(2);
    const byMethod = await api("owner", "GET", `/api/v1/orders?from=${today}&to=${today}&method=transfer`);
    expect(byMethod.body.items.map((o: any) => o.methods)).toEqual([["transfer"]]);
    expect((await api("owner", "GET", `/api/v1/orders?from=${today}&to=${today}&cashierId=3`)).body.items.length).toBe(2);
    expect((await api("owner", "GET", `/api/v1/orders?from=${today}&to=${today}&cashierId=999`)).body.items).toEqual([]);
    const byName = await api("owner", "GET", `/api/v1/orders?q=H%E1%BA%A1nh`);
    expect(byName.body.items.map((o: any) => o.id)).toEqual([orderId]);
    expect(byName.body.items[0]).toMatchObject({ customer_name: "Chị Hạnh", cashier_name: "Test cashier" });
    expect((await api("owner", "GET", `/api/v1/orders?q=0988777`)).body.items.map((o: any) => o.id)).toEqual([orderId]);
    expect((await api("owner", "GET", `/api/v1/orders?q=${all.body.items[0].code}`)).body.items.length).toBe(1);
    expect((await api("owner", "GET", `/api/v1/orders?from=2020-01-01&to=2020-01-02`)).body.items).toEqual([]);
  });

  it("paginates with cursor and keeps summary independent of page size", async () => {
    const p1 = await api("owner", "GET", `/api/v1/orders?from=${today}&to=${today}&limit=1`);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).toBeTruthy();
    expect(p1.body.summary.saleCount).toBe(2);
    const p2 = await api("owner", "GET", `/api/v1/orders?from=${today}&to=${today}&limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].id).toBeLessThan(p1.body.items[0].id);
  });

  it("validates dates and masks / protects phone for roles without customers.view_pii", async () => {
    expect((await api("owner", "GET", `/api/v1/orders?from=abc`)).status).toBe(422);
    expect((await api("owner", "GET", `/api/v1/orders?from=${today}&to=2020-01-01`)).status).toBe(422);
    const w = await api("warehouse", "GET", `/api/v1/orders?from=${today}&to=${today}&q=Hạnh`);
    expect(w.body.items[0].customer_phone).not.toBe("0988777666");
    // không dò được SĐT khi không có quyền xem PII
    expect((await api("warehouse", "GET", `/api/v1/orders?q=0988777`)).body.items).toEqual([]);
    expect((await api("owner", "GET", `/api/v1/orders/cashiers`)).body.items.some((u: any) => u.id === 3)).toBe(true);
  });
});

describe("/me without employee profile", () => {
  it("returns 404 employee_not_linked for owner on every /me/* endpoint", async () => {
    for (const p of ["/api/v1/me/attendance/today", "/api/v1/me/schedule?from=2026-11-01&to=2026-11-07", "/api/v1/me/payslips"]) {
      const r = await api("owner", "GET", p);
      expect(r.status, p).toBe(404);
      expect(r.body.error.code, p).toBe("employee_not_linked");
    }
  });
});
