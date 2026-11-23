import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/worker/index";
import { api, login, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { vnDate } from "../src/worker/lib/time";

beforeAll(async () => {
  await seedBase();
  await seedSales();
});

const today = vnDate();

describe("reports", () => {
  it("builds P&L for a small scenario", async () => {
    expect((await api("cashier", "POST", "/api/v1/shifts/open", { openingCash: 0 })).status).toBe(201);
    const sale = await api("cashier", "POST", "/api/v1/pos/orders", {
      clientUuid: "rep-sale-0001", lines: [{ productId: 1, unit: "kg", qty: 2 }], payments: [{ method: "cash", amount: 200000 }],
    });
    expect(sale.status).toBe(201);
    const lineId = sale.body.lines[0].id;
    await api("cashier", "POST", `/api/v1/orders/${sale.body.id}/return`, {
      lines: [{ orderLineId: lineId, qty: 1, unit: "kg", restock: true, reason: "đổi ý" }], refundMethod: "cash",
    });
    await api("cashier", "POST", `/api/v1/orders/${sale.body.id}/return`, {
      lines: [{ orderLineId: lineId, qty: 0.5, unit: "kg", restock: false, reason: "dập" }], refundMethod: "cash",
    });
    // đơn nháp/huỷ không được tính
    const gone = await api("cashier", "POST", "/api/v1/pos/orders", {
      clientUuid: "rep-sale-0002", lines: [{ productId: 2, unit: "kg", qty: 1 }], payments: [{ method: "cash", amount: 200000 }],
    });
    await api("manager", "POST", `/api/v1/orders/${gone.body.id}/void`, { reason: "kiểm thử báo cáo" });
    // chi phí
    const cats = (await api("accountant", "GET", "/api/v1/cash-categories")).body.items as any[];
    const id = (c: string) => cats.find((x) => x.code === c).id;
    await api("accountant", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: id("DIEN_NUOC"), amount: 20000 });
    await api("accountant", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: id("TIEN_HANG"), amount: 999000 }); // cogs: không vào chi phí

    const r = await api("manager", "GET", `/api/v1/reports/pnl?from=${today}&to=${today}&groupBy=channel`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      salesTotal: 200000,
      returnsTotal: 150000,
      revenue: 50000,
      cogs: 30000, // 120000 - 60000 - 30000
      grossProfit: 20000,
      expenses: { opex: 20000, shrinkage: 30000 },
      totalExpenses: 50000,
      netProfit: -30000,
    });
    expect(r.body.breakdown).toEqual([{ key: "pos", revenue: 50000, cogs: 30000, grossProfit: 20000 }]);
  });

  it("builds the daily report and inventory report", async () => {
    const d = await api("manager", "GET", `/api/v1/reports/daily?day=${today}`);
    expect(d.status).toBe(200);
    expect(d.body.revenue).toBe(50000);
    expect(d.body.byMethod.find((m: any) => m.method === "cash").amount).toBe(50000);
    const inv = await api("manager", "GET", `/api/v1/reports/inventory?asOf=${today}`);
    expect(inv.status).toBe(200);
    const tao = inv.body.items.find((i: any) => i.sku === "TAO");
    expect(tao).toMatchObject({ soldMilli: 2000, returnedMilli: 1000, onHandMilli: -1000 });
  });

  it("exports CSV with UTF-8 BOM and enforces permission", async () => {
    const token = await login("manager");
    const res = await app.request(`/api/v1/reports/export/pnl.csv?from=${today}&to=${today}`, { headers: { authorization: `Bearer ${token}` } }, testEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toContain("Doanh thu thuần");
    expect((await api("cashier", "GET", `/api/v1/reports/pnl`)).status).toBe(403);
    expect((await api("manager", "GET", "/api/v1/reports/export/nope.csv")).status).toBe(404);
  });
});
