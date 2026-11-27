import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { insertOrders } from "./sales-helpers";
import { ROLE_PERMS } from "../src/worker/lib/rbac";

// Báo cáo bán hàng: theo người bán / hàng hoá / khách / NCC. Số liệu phải khớp /reports/pnl.
const db = () => testEnv.DB;
const V = "/api/v1";
const D = "2026-03-10T05:00:00.000Z"; // 12:00 giờ VN ngày 2026-03-10
const Q = "from=2026-03-10&to=2026-03-10";
const CASHIER = 3, MANAGER = 2;

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO products(id, sku, name, base_unit, group_id) VALUES (501,'SR-A','Cam SR','kg',1),(502,'SR-B','Táo SR','kg',2),(503,'SR-C','Mít không bán','kg',1)`),
    db().prepare(`INSERT INTO customers(id, code, type, name, phone) VALUES (501,'KH-SR1','retail','Khách SR 1','0901234567')`),
    db().prepare(`INSERT INTO suppliers(id, code, name) VALUES (501,'NCC-SR1','NCC SR 1'),(502,'NCC-SR2','NCC SR 2 (không phát sinh)')`),
  ]);
  await insertOrders([
    // O1: thu ngân bán 2 dòng cho khách 501
    { id: 5001, createdBy: CASHIER, customer: 501, at: D, lines: [[501, 2000, 100000, 60000], [502, 1000, 50000, 30000]] },
    // O2: thu ngân lập nhưng người bán là quản lý
    { id: 5002, createdBy: CASHIER, sellerId: MANAGER, at: D, lines: [[501, 1000, 50000, 30000]] },
    // O3: trả 1000 milli của O1 — tính về người bán của đơn gốc (thu ngân) và khách của đơn gốc
    { id: 5003, kind: "return", orig: 5001, createdBy: MANAGER, customer: 501, at: D, lines: [[501, 1000, 50000, 30000, 50010]] },
    // O4: đơn online có phí giao 10.000, không có người bán
    { id: 5004, channel: "online", shipping: 10000, at: D, lines: [[502, 1000, 70000, 40000]] },
    // ngoài khoảng ngày, nháp, đã huỷ: không được tính
    { id: 5005, createdBy: CASHIER, at: "2026-02-01T05:00:00.000Z", lines: [[501, 1000, 999000, 1]] },
    { id: 5006, createdBy: CASHIER, status: "draft", at: D, lines: [[501, 1000, 888000, 1]] },
    { id: 5007, createdBy: CASHIER, status: "cancelled", at: D, lines: [[501, 1000, 777000, 1]] },
  ]);
  await db().batch([
    db().prepare(`INSERT INTO stock_docs(id, code, type, status, store_id, location_id, supplier_id, total_amount, created_by, posted_at) VALUES (5101,'SR-PN1','receipt','posted',1,1,501,1000000,1,?)`).bind(D),
    db().prepare(`INSERT INTO stock_docs(id, code, type, status, store_id, location_id, supplier_id, total_amount, created_by, posted_at) VALUES (5102,'SR-PN-OLD','receipt','posted',1,1,501,7000000,1,'2026-01-01T05:00:00.000Z')`),
    db().prepare(`INSERT INTO purchase_returns(id, code, supplier_id, receipt_doc_id, status, total, reason, created_by, posted_at) VALUES (5201,'SR-TH1',501,5101,'posted',200000,'hỏng',1,?)`).bind(D),
    db().prepare(`INSERT INTO supplier_bills(id, code, supplier_id, stock_doc_id, issue_date, due_date, total) VALUES (5301,'SR-CNP1',501,5101,'2026-03-10','2026-04-10',800000)`),
  ]);
});

describe("báo cáo theo người bán", () => {
  it("tính theo người bán (seller_id trước created_by), trả hàng về người bán đơn gốc", async () => {
    const r = await api("manager", "GET", `${V}/reports/sales/sellers?${Q}`);
    expect(r.status).toBe(200);
    const by = new Map<any, any>(r.body.items.map((i: any) => [i.sellerId, i]));
    expect(by.get(CASHIER)).toMatchObject({ saleCount: 1, sales: 150000, returnCount: 1, returns: 50000, revenue: 100000, avgOrder: 150000, cogs: 60000, grossProfit: 40000 });
    expect(by.get(MANAGER)).toMatchObject({ saleCount: 1, sales: 50000, returns: 0, revenue: 50000, grossProfit: 20000 });
    expect(by.get(null)).toMatchObject({ saleCount: 1, sales: 80000, revenue: 80000, sellerName: "Không rõ người bán" });
  });

  it("tổng khớp /reports/pnl (doanh thu thuần, giá vốn, lãi gộp)", async () => {
    const s = (await api("manager", "GET", `${V}/reports/sales/sellers?${Q}`)).body;
    const p = (await api("manager", "GET", `${V}/reports/pnl?${Q}`)).body;
    expect(p.revenue).toBe(230000);
    expect(s.totals.revenue).toBe(p.revenue);
    expect(s.totals.sales).toBe(p.salesTotal);
    expect(s.totals.returns).toBe(p.returnsTotal);
    expect(s.totals.cogs).toBe(p.cogs);
    expect(s.totals.grossProfit).toBe(p.grossProfit);
  });

  it("lọc kênh và nhóm hàng", async () => {
    const online = (await api("manager", "GET", `${V}/reports/sales/sellers?${Q}&channel=online`)).body;
    expect(online.items).toHaveLength(1);
    expect(online.items[0]).toMatchObject({ sellerId: null, revenue: 80000 });
    const g2 = (await api("manager", "GET", `${V}/reports/sales/sellers?${Q}&groupId=2`)).body;
    expect(g2.basis).toBe("lines");
    // nhóm 2 = Táo: thu ngân 50.000 (O1) và đơn online 70.000 (không tính phí giao)
    expect(g2.totals.revenue).toBe(120000);
    const pnlG = (await api("manager", "GET", `${V}/reports/pnl?${Q}&groupBy=group`)).body.breakdown.find((x: any) => x.key === "Trái cây nội");
    expect(pnlG.revenue - 0).toBe(g2.totals.revenue);
    expect(pnlG.cogs).toBe(g2.totals.cogs);
  });

  it("phân quyền, kiểm tra tham số, không lộ giá vốn khi thiếu prices.view_cost", async () => {
    for (const role of ["cashier", "warehouse", "online_staff"]) expect((await api(role, "GET", `${V}/reports/sales/sellers?${Q}`)).status).toBe(403);
    expect((await api("accountant", "GET", `${V}/reports/sales/sellers?${Q}`)).status).toBe(200);
    expect((await api("manager", "GET", `${V}/reports/sales/sellers?from=2026-13-40`)).status).toBe(422);
    expect((await api("manager", "GET", `${V}/reports/sales/sellers?${Q}&channel=xx`)).status).toBe(422);
    const perms = ROLE_PERMS.manager as Set<string>;
    perms.delete("prices.view_cost");
    try {
      const raw = JSON.stringify((await api("manager", "GET", `${V}/reports/sales/sellers?${Q}`)).body);
      expect(raw).not.toMatch(/cogs|grossProfit/);
      expect(JSON.stringify((await api("manager", "GET", `${V}/reports/sales/products?${Q}`)).body)).not.toMatch(/cogs|grossProfit/);
      expect((await api("manager", "GET", `${V}/reports/sales/suppliers?${Q}`)).status).toBe(403);
    } finally { perms.add("prices.view_cost"); }
  });
});

describe("báo cáo theo hàng hoá", () => {
  it("bán chạy theo số lượng/doanh thu/lãi gộp, trả hàng trừ ra, khớp P&L theo nhóm", async () => {
    const r = (await api("manager", "GET", `${V}/reports/sales/products?${Q}`)).body;
    const by = Object.fromEntries(r.items.map((i: any) => [i.productId, i]));
    expect(by[501]).toMatchObject({ qtyMilli: 2000, revenue: 100000, cogs: 60000, grossProfit: 40000 });
    expect(by[502]).toMatchObject({ qtyMilli: 2000, revenue: 120000, grossProfit: 50000 });
    const p = (await api("manager", "GET", `${V}/reports/pnl?${Q}&groupBy=group`)).body;
    const sumNoShip = p.breakdown.filter((x: any) => x.key !== "Phí giao hàng").reduce((t: number, x: any) => t + x.revenue, 0);
    expect(r.totals.revenue).toBe(sumNoShip);
    expect(r.totals.revenue + 10000).toBe(p.revenue); // 10.000 = phí giao đơn online
    expect(r.totals.grossProfit + 10000).toBe(p.grossProfit);
  });

  it("hàng không bán trong kỳ", async () => {
    const r = (await api("manager", "GET", `${V}/reports/sales/products?${Q}`)).body;
    expect(r.unsold.map((x: any) => x.productId)).toEqual([503]);
    const feb = (await api("manager", "GET", `${V}/reports/sales/products?from=2026-02-01&to=2026-02-01`)).body;
    expect(feb.items.map((x: any) => x.productId)).toEqual([501]);
    expect(feb.unsold.map((x: any) => x.productId).sort()).toEqual([502, 503]);
    const g = (await api("manager", "GET", `${V}/reports/sales/products?${Q}&groupId=1`)).body;
    expect(g.items.map((x: any) => x.productId)).toEqual([501]);
  });
});

describe("báo cáo theo khách", () => {
  it("top khách, trả hàng về khách đơn gốc, khách lẻ tách riêng, che SĐT khi thiếu quyền", async () => {
    const r = (await api("manager", "GET", `${V}/reports/sales/customers?${Q}`)).body;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ customerId: 501, orders: 1, sales: 150000, returns: 50000, revenue: 100000, phone: "0901234567" });
    expect(r.walkIn).toMatchObject({ orders: 2, sales: 130000 });
    expect(r.totals.revenue).toBe(230000);
    const perms = ROLE_PERMS.manager as Set<string>;
    perms.delete("customers.view_pii");
    try {
      const m = (await api("manager", "GET", `${V}/reports/sales/customers?${Q}`)).body;
      expect(m.items[0].phone).toBe("090****567");
    } finally { perms.add("customers.view_pii"); }
  });
});

describe("báo cáo theo nhà cung cấp", () => {
  it("giá trị nhập, trả hàng NCC, công nợ còn; chỉ phiếu trong kỳ", async () => {
    const r = await api("accountant", "GET", `${V}/reports/sales/suppliers?${Q}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ supplierId: 501, receiptCount: 1, purchased: 1000000, returnCount: 1, returned: 200000, netPurchased: 800000, debt: 800000 });
    expect(r.body.totals).toMatchObject({ purchased: 1000000, netPurchased: 800000, debt: 800000 });
    expect((await api("warehouse", "GET", `${V}/reports/sales/suppliers?${Q}`)).status).toBe(403);
  });
});
