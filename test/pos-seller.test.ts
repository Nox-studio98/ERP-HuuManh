import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { vnPeriod } from "../src/worker/lib/time";

const db = () => testEnv.DB;
const line = (productId: number, qty: number) => ({ productId, unit: "kg", qty });
const OWNER = 1, MANAGER = 2, CASHIER = 3, WAREHOUSE = 4;
let uuid = 0;
const sell = (role: string, extra: object = {}, productId = 1) =>
  api(role, "POST", "/api/v1/pos/orders", { clientUuid: `seller-uuid-${++uuid}-xxxx`, lines: [line(productId, 1)], payments: [{ method: "cash", amount: 500000 }], ...extra });

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().prepare(`INSERT INTO users(id, username, full_name, pass_hash, role, store_id, active) VALUES (9001,'nghi','Đã nghỉ','x','cashier',1,0)`).run();
  expect((await api("cashier", "POST", "/api/v1/shifts/open", { openingCash: 0 })).status).toBe(201);
  expect((await api("manager", "POST", "/api/v1/shifts/open", { openingCash: 0 })).status).toBe(201);
});

describe("GET /pos/sellers", () => {
  it("lists active sellable users, only id and name", async () => {
    const r = await api("cashier", "GET", "/api/v1/pos/sellers");
    expect(r.status).toBe(200);
    const ids = r.body.items.map((x: any) => x.id);
    expect(ids).toEqual(expect.arrayContaining([OWNER, MANAGER, CASHIER]));
    expect(ids).not.toContain(WAREHOUSE); // không có pos.sell và không có hồ sơ nhân viên
    expect(ids).not.toContain(9001); // đã khoá
    expect(Object.keys(r.body.items[0]).sort()).toEqual(["id", "name"]);
  });
  it("requires pos.sell", async () => {
    expect((await api("warehouse", "GET", "/api/v1/pos/sellers")).status).toBe(403);
  });
  it("includes active employees even without pos.sell role", async () => {
    await db().prepare(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date) VALUES (9101,'NV-W',4,'Test warehouse','kho',1,'2026-01-01')`).run();
    const ids = (await api("cashier", "GET", "/api/v1/pos/sellers")).body.items.map((x: any) => x.id);
    expect(ids).toContain(WAREHOUSE);
    await db().prepare(`DELETE FROM employees WHERE id = 9101`).run();
  });
});

describe("POST /pos/orders sellerId", () => {
  it("stores a valid seller different from the cashier", async () => {
    const r = await sell("cashier", { sellerId: MANAGER });
    expect(r.status).toBe(201);
    expect(r.body.seller_id).toBe(MANAGER);
    expect(r.body.created_by).toBe(CASHIER);
    expect(r.body.seller_name).toBe("Test manager");
  });
  it("defaults to the creator (NULL) when omitted or equal to creator", async () => {
    const a = await sell("cashier");
    expect(a.body.seller_id).toBeNull();
    const b = await sell("cashier", { sellerId: CASHIER });
    expect(b.body.seller_id).toBeNull();
  });
  it("rejects invalid sellers with 422 invalid_seller", async () => {
    for (const sellerId of [9999, 9001, WAREHOUSE]) {
      const r = await sell("cashier", { sellerId });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("invalid_seller");
    }
  });
});

describe("order meta edit", () => {
  let a: any;
  let b: any;
  let c2: any;
  beforeAll(async () => {
    a = (await sell("cashier")).body;
    b = (await sell("cashier")).body;
    c2 = (await sell("manager")).body;
  });
  const audits = async (id: number) =>
    (await db().prepare(`SELECT * FROM audit_log WHERE action='order.meta' AND entity='order' AND entity_id=? ORDER BY id`).bind(String(id)).all<any>()).results;

  it("cashier cannot edit (403); warehouse neither", async () => {
    expect((await api("cashier", "PATCH", `/api/v1/orders/${a.id}/meta`, { note: "x" })).status).toBe(403);
    expect((await api("cashier", "POST", "/api/v1/orders/meta/bulk", { ids: [a.id], note: "x" })).status).toBe(403);
    expect((await api("warehouse", "PATCH", `/api/v1/orders/${a.id}/meta`, { note: "x" })).status).toBe(403);
  });

  it("manager edits seller and note, money/lines unchanged, audit before/after", async () => {
    const before = (await api("manager", "GET", `/api/v1/orders/${a.id}`)).body;
    const r = await api("manager", "PATCH", `/api/v1/orders/${a.id}/meta`, { sellerId: MANAGER, note: "  Giao chị Lan  " });
    expect(r.status).toBe(200);
    expect(r.body.seller_id).toBe(MANAGER);
    expect(r.body.seller_name).toBe("Test manager");
    expect(r.body.note).toBe("Giao chị Lan");
    expect(r.body.total).toBe(before.total);
    expect(r.body.paid_total).toBe(before.paid_total);
    expect(r.body.lines).toHaveLength(before.lines.length);
    expect(r.body.metaVersion).toBe(1);
    const log = await audits(a.id);
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].before_json)).toEqual({ sellerId: null, note: null });
    expect(JSON.parse(log[0].after_json)).toEqual({ sellerId: MANAGER, note: "Giao chị Lan" });
    expect(log[0].user_id).toBe(MANAGER);
  });

  it("clearing: sellerId null and note null", async () => {
    const r = await api("owner", "PATCH", `/api/v1/orders/${a.id}/meta`, { sellerId: null, note: null });
    expect(r.status).toBe(200);
    expect(r.body.seller_id).toBeNull();
    expect(r.body.note).toBeNull();
  });

  it("validates: needs a field, invalid seller, unknown order, non-sale order", async () => {
    expect((await api("manager", "PATCH", `/api/v1/orders/${a.id}/meta`, {})).status).toBe(422);
    const bad = await api("manager", "PATCH", `/api/v1/orders/${a.id}/meta`, { sellerId: 9999 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("invalid_seller");
    expect((await api("manager", "PATCH", `/api/v1/orders/99999999/meta`, { note: "x" })).status).toBe(404);
    await db().prepare(`INSERT INTO orders(id, code, channel, kind, original_order_id, store_id, status, total, created_by) VALUES (95001,'TH-META','pos','return',?,1,'completed',1000,3)`).bind(a.id).run();
    const ret = await api("manager", "PATCH", `/api/v1/orders/95001/meta`, { note: "x" });
    expect(ret.status).toBe(422);
    expect(ret.body.error.code).toBe("not_editable");
  });

  it("version guards against concurrent edits", async () => {
    const cur = (await api("manager", "GET", `/api/v1/orders/${b.id}`)).body.metaVersion;
    expect((await api("manager", "PATCH", `/api/v1/orders/${b.id}/meta`, { note: "lần 1", version: cur })).status).toBe(200);
    const stale = await api("manager", "PATCH", `/api/v1/orders/${b.id}/meta`, { note: "lần 2", version: cur });
    expect(stale.status).toBe(409);
    expect((await db().prepare(`SELECT note FROM orders WHERE id=?`).bind(b.id).first<any>()).note).toBe("lần 1");
  });

  it("bulk updates up to 100 orders in one go with an audit row each", async () => {
    const r = await api("manager", "POST", "/api/v1/orders/meta/bulk", { ids: [a.id, b.id, c2.id], sellerId: CASHIER, note: "Hàng loạt" });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(3);
    for (const id of [a.id, b.id, c2.id]) {
      const o = await db().prepare(`SELECT seller_id, note, created_by FROM orders WHERE id=?`).bind(id).first<any>();
      expect(o.note).toBe("Hàng loạt");
      expect(o.seller_id).toBe(o.created_by === CASHIER ? null : CASHIER); // trùng người lập → NULL
    }
    expect((await audits(c2.id)).length).toBe(1);
    // chỉ ghi chú: không đổi người bán
    await api("manager", "POST", "/api/v1/orders/meta/bulk", { ids: [c2.id], note: "Chỉ note" });
    expect((await db().prepare(`SELECT seller_id, note FROM orders WHERE id=?`).bind(c2.id).first<any>())).toEqual({ seller_id: CASHIER, note: "Chỉ note" });
  });

  it("bulk is all-or-nothing: unknown or non-sale id aborts everything", async () => {
    const x = await api("manager", "POST", "/api/v1/orders/meta/bulk", { ids: [a.id, 95001], note: "KHÔNG ĐƯỢC GHI" });
    expect(x.status).toBe(422);
    const y = await api("manager", "POST", "/api/v1/orders/meta/bulk", { ids: [a.id, 99999999], note: "KHÔNG ĐƯỢC GHI" });
    expect(y.status).toBe(404);
    expect((await db().prepare(`SELECT note FROM orders WHERE id=?`).bind(a.id).first<any>()).note).toBe("Hàng loạt");
    expect((await api("manager", "POST", "/api/v1/orders/meta/bulk", { ids: [], note: "x" })).status).toBe(422);
    expect((await api("manager", "POST", "/api/v1/orders/meta/bulk", { ids: Array.from({ length: 101 }, (_, i) => i + 1), note: "x" })).status).toBe(422);
  });

  it("locked period → 423 and nothing changes", async () => {
    const o = (await sell("cashier")).body;
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, '2099-01-01T00:00:00Z', 1)`).bind(vnPeriod()).run();
    const r1 = await api("manager", "PATCH", `/api/v1/orders/${o.id}/meta`, { note: "kỳ khoá" });
    expect(r1.status).toBe(423);
    const r2 = await api("manager", "POST", "/api/v1/orders/meta/bulk", { ids: [o.id, a.id], note: "kỳ khoá" });
    expect(r2.status).toBe(423);
    await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(vnPeriod()).run();
    expect((await db().prepare(`SELECT note FROM orders WHERE id=?`).bind(o.id).first<any>()).note).toBeNull();
    expect((await audits(o.id)).length).toBe(0);
  });
});

describe("GET /orders seller filter + search", () => {
  let nho: any;
  beforeAll(async () => {
    nho = (await sell("cashier", { sellerId: MANAGER, note: "Khách quen bà Tư" }, 2)).body;
  });
  it("returns sellerId/sellerName (falls back to cashier) and filters by sellerId", async () => {
    const all = (await api("manager", "GET", "/api/v1/orders?limit=200")).body.items;
    const o = all.find((x: any) => x.id === nho.id);
    expect(o.seller_id).toBe(MANAGER);
    expect(o.seller_name).toBe("Test manager");
    expect(o.cashier_id).toBe(CASHIER);
    const noSeller = all.find((x: any) => x.seller_id === CASHIER);
    expect(noSeller.seller_name).toBe("Test cashier");
    const f = (await api("manager", "GET", `/api/v1/orders?sellerId=${MANAGER}&limit=200`)).body.items;
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x: any) => x.seller_id === MANAGER)).toBe(true);
    expect(f.some((x: any) => x.id === nho.id)).toBe(true);
    const fc = (await api("manager", "GET", `/api/v1/orders?sellerId=${CASHIER}&limit=200`)).body.items;
    expect(fc.some((x: any) => x.id === nho.id)).toBe(false);
  });
  it("q matches product name and note", async () => {
    const byProduct = (await api("manager", "GET", "/api/v1/orders?q=Nho%20M%E1%BB%B9")).body.items;
    expect(byProduct.map((x: any) => x.id)).toEqual([nho.id]);
    const bySku = (await api("manager", "GET", "/api/v1/orders?q=nho")).body.items;
    expect(bySku.some((x: any) => x.id === nho.id)).toBe(true);
    const byNote = (await api("manager", "GET", `/api/v1/orders?q=${encodeURIComponent("bà Tư")}`)).body.items;
    expect(byNote.map((x: any) => x.id)).toEqual([nho.id]);
    expect((await api("manager", "GET", "/api/v1/orders?q=khong-ton-tai-xyz")).body.items).toHaveLength(0);
    // summary khớp bộ lọc
    expect((await api("manager", "GET", "/api/v1/orders?q=Nho%20M%E1%BB%B9")).body.summary.saleCount).toBe(1);
  });
});

describe("sales bonus follows the seller", () => {
  it("credits COALESCE(seller_id, created_by), including deducting returns", async () => {
    const closeSheet = async (period: string) => {
      await db().batch([
        db().prepare(`INSERT INTO timesheets(period, status) VALUES (?, 'open')`).bind(period),
        db().prepare(`INSERT INTO timesheet_days(period, employee_id, work_date, worked_minutes, shifts_worked) VALUES (?,9201,?,480,1),(?,9202,?,480,1)`).bind(period, `${period}-02`, period, `${period}-02`),
        db().prepare(`UPDATE timesheets SET status='closed' WHERE period = ?`).bind(period),
      ]);
    };
    await db().batch([
      db().prepare(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date, pay_type, base_salary) VALUES (9201,'NV-CA',3,'Thu ngân','thu ngân',1,'2026-01-01','monthly',5000000),(9202,'NV-QL',2,'Quản lý','quản lý',1,'2026-01-01','monthly',5000000)`),
      db().prepare(`UPDATE settings SET value='1000' WHERE key='hr.sales_bonus_bp'`),
      // đơn 1: thu ngân lập, người bán = quản lý (2): 5.000.000; đơn 2: thu ngân lập, không người bán: 2.000.000
      db().prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, created_by, seller_id, completed_at) VALUES (96001,'HD-B1','pos','sale',1,'completed',5000000,3,2,'2026-03-10T03:00:00Z'),(96002,'HD-B2','pos','sale',1,'completed',2000000,3,NULL,'2026-03-11T03:00:00Z')`),
      // trả 1.000.000 từ đơn 1 → trừ vào người bán (quản lý), không phải thu ngân
      db().prepare(`INSERT INTO orders(id, code, channel, kind, original_order_id, store_id, status, total, created_by, completed_at) VALUES (96003,'TH-B1','pos','return',96001,1,'completed',1000000,3,'2026-03-12T03:00:00Z')`),
    ]);
    await closeSheet("2026-03");
    expect((await api("accountant", "POST", "/api/v1/payroll/periods/2026-03/calculate")).status).toBe(200);
    const d = await api("accountant", "GET", "/api/v1/payroll/periods/2026-03");
    const ql = d.body.items.find((i: any) => i.code === "NV-QL");
    const ca = d.body.items.find((i: any) => i.code === "NV-CA");
    expect(ql.salesBonus).toBe(400_000); // (5.000.000 − 1.000.000) × 10%
    expect(ca.salesBonus).toBe(200_000); // 2.000.000 × 10%
    await db().prepare(`UPDATE settings SET value='0' WHERE key='hr.sales_bonus_bp'`).run();
  });
});
