import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate } from "../src/worker/lib/time";

const db = () => testEnv.DB;
const today = vnDate();
const old = "2026-01-05";
let cust = 0;

beforeAll(async () => {
  await seedBase();
  const c = await db().prepare(`INSERT INTO customers(code, type, name) VALUES ('UX2C-1','b2b','Nhà hàng Hoa Sen') RETURNING id`).first<{ id: number }>();
  cust = c!.id;
  await db().batch([
    db().prepare(`INSERT INTO invoices(code, customer_id, issue_date, due_date, subtotal, total) VALUES ('UX-OLD',?,?,?,100000,100000)`).bind(cust, old, old),
    db().prepare(`INSERT INTO invoices(code, customer_id, issue_date, due_date, subtotal, total) VALUES ('UX-NEW',?,?,?,250000,250000)`).bind(cust, today, today),
  ]);
});

describe("GET /invoices filters + summary", () => {
  it("filters by q (code and customer name) and date range, summary covers all filtered rows", async () => {
    const all = await api("accountant", "GET", `/api/v1/invoices?customerId=${cust}`);
    expect(all.status).toBe(200);
    expect(all.body.summary).toMatchObject({ count: 2, total: 350000 });
    const byCode = await api("accountant", "GET", "/api/v1/invoices?q=UX-NEW");
    expect(byCode.body.items.map((x: any) => x.code)).toEqual(["UX-NEW"]);
    expect(byCode.body.summary.count).toBe(1);
    const byName = await api("accountant", "GET", "/api/v1/invoices?q=Hoa%20Sen");
    expect(byName.body.items).toHaveLength(2);
    const ranged = await api("accountant", "GET", `/api/v1/invoices?customerId=${cust}&from=${today}&to=${today}`);
    expect(ranged.body.items.map((x: any) => x.code)).toEqual(["UX-NEW"]);
    expect(ranged.body.summary).toMatchObject({ count: 1, total: 250000, outstanding: 250000 });
    const wild = await api("accountant", "GET", "/api/v1/invoices?q=%25");
    expect(wild.body.items).toHaveLength(0);
  });
  it("rejects bad ranges and keeps cursor paging + permissions", async () => {
    expect((await api("accountant", "GET", "/api/v1/invoices?from=abc")).status).toBe(422);
    expect((await api("accountant", "GET", "/api/v1/invoices?from=2026-05-01&to=2026-04-01")).status).toBe(422);
    const p1 = await api("accountant", "GET", `/api/v1/invoices?customerId=${cust}&limit=1`);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await api("accountant", "GET", `/api/v1/invoices?customerId=${cust}&limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].code).toBe("UX-OLD");
    expect(p2.body.summary.count).toBe(2);
    expect((await api("cashier", "GET", "/api/v1/invoices")).status).toBe(403);
  });
});

describe("GET /vouchers filters + summary", () => {
  it("filters by q/from/to and returns totals; hides payroll vouchers without hr.sensitive", async () => {
    const cat = async (code: string) => ((await api("accountant", "GET", "/api/v1/cash-categories")).body.items as any[]).find((c) => c.code === code).id;
    expect((await api("accountant", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: await cat("DIEN_NUOC"), amount: 300000, counterparty: "EVN", note: "Tiền điện tháng" })).status).toBe(201);
    expect((await api("accountant", "POST", "/api/v1/vouchers", { direction: "in", fundId: 1, categoryId: await cat("BAN_HANG"), amount: 500000, note: "Thu lẻ" })).status).toBe(201);
    await db().prepare(`INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, status, period, created_by, ref_type) VALUES ('PC-LUONG-X','out',1,?,9000000,'posted',?,1,'payroll_item')`).bind(await cat("LUONG"), today.slice(0, 7)).run();
    const r = await api("owner", "GET", `/api/v1/vouchers?from=${today}&to=${today}`);
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ totalIn: 500000, totalOut: 9300000 });
    const evn = await api("owner", "GET", "/api/v1/vouchers?q=EVN");
    expect(evn.body.items).toHaveLength(1);
    expect(evn.body.summary).toMatchObject({ count: 1, totalOut: 300000, totalIn: 0 });
    const acc = await api("manager", "GET", `/api/v1/vouchers?from=${today}&to=${today}`);
    expect(acc.body.summary.totalOut).toBe(300000); // không lộ phiếu lương
    expect(acc.body.items.some((x: any) => x.code === "PC-LUONG-X")).toBe(false);
    const none = await api("owner", "GET", "/api/v1/vouchers?from=2020-01-01&to=2020-01-02");
    expect(none.body.items).toHaveLength(0);
    expect((await api("owner", "GET", "/api/v1/vouchers?from=zzz")).status).toBe(422);
    expect((await api("cashier", "GET", "/api/v1/vouchers")).status).toBe(403);
  });
});
