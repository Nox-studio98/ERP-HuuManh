import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate } from "../src/worker/lib/time";
import { addDays } from "../src/worker/services/debt";

// Đợt 7 — lỗi nhỏ còn lại sau audit: ngân sách có chênh lệch kiểm kê; điều chỉnh công nợ vào P&L theo ngày ghi sổ.
const db = () => testEnv.DB;
const V = "/api/v1";
const today = vnDate();
const period = today.slice(0, 7);
const pnl = async (day: string) => (await api("owner", "GET", `${V}/reports/pnl?from=${day}&to=${day}`)).body;

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO customers(id, code, type, name, credit_limit, payment_terms_days) VALUES (3701,'KH-F7','b2b','KH Fix7',5000000,15)`),
    db().prepare(`INSERT INTO invoices(id, code, kind, customer_id, issue_date, due_date, subtotal, total) VALUES (3701,'F7-HD-1','sale',3701,?,?,500000,500000)`).bind(addDays(today, -10), addDays(today, 5)),
  ]);
});

describe("Ngân sách – thực tế gồm chênh lệch kiểm kê", () => {
  it("kiểm kê thiếu cộng vào dòng hao hụt, khớp P&L", async () => {
    const prod = await api("manager", "POST", `${V}/products`, { sku: "F7-KK", name: "F7-KK", baseUnit: "kg", sellByWeight: true });
    const doc = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierRef: "F7-R" });
    await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { productId: prod.body.id, unit: "kg", qty: 10, unitCost: 100000 });
    expect((await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/post`)).status).toBe(200);
    const lot = await db().prepare(`SELECT id FROM lots WHERE product_id = ?`).bind(prod.body.id).first<any>();
    expect((await api("accountant", "PUT", `${V}/budgets`, { period, items: [{ line: "shrinkage", amount: 100000 }] })).status).toBe(200);
    const b0 = (await api("manager", "GET", `${V}/reports/budget-vs-actual?period=${period}`)).body;
    const cnt = await api("manager", "POST", `${V}/stock-docs`, { type: "count", locationId: 1 });
    await api("manager", "POST", `${V}/stock-docs/${cnt.body.id}/lines`, { lotId: lot.id, countedQty: 8, unit: "kg" });
    expect((await api("manager", "POST", `${V}/stock-docs/${cnt.body.id}/post`)).status).toBe(200);
    const b1 = (await api("manager", "GET", `${V}/reports/budget-vs-actual?period=${period}`)).body;
    const row = (b: any) => b.items.find((x: any) => x.line === "shrinkage");
    expect(row(b1).actual - row(b0).actual).toBe(200_000);
    expect(b1.lineActuals.stockCount - (b0.lineActuals.stockCount ?? 0)).toBe(200_000);
  });
});

describe("Điều chỉnh công nợ vào P&L theo ngày ghi sổ (ngày duyệt)", () => {
  it("lập từ 40 ngày trước, duyệt hôm nay → vào P&L hôm nay, không vào ngày lập", async () => {
    const past = addDays(today, -40);
    await db().prepare(`INSERT INTO debt_adjustments(code, type, partner_type, partner_id, amount, status, reason, created_by, created_at, posted_at) VALUES ('F7-DCN-1','write_off','customer',3701,25000,'posted','khó đòi',1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(`${past}T03:00:00.000Z`).run();
    expect((await pnl(today)).expenses.badDebt).toBe(25_000);
    expect((await pnl(past)).expenses.badDebt ?? 0).toBe(0);
  });

  it("luồng duyệt ghi posted_at lúc duyệt; ghi thẳng (dưới ngưỡng) có posted_at ngay", async () => {
    const r = await api("manager", "POST", `${V}/debts/adjustments`, { type: "write_off", partnerType: "customer", partnerId: 3701, amount: 100_000, reason: "Khó đòi" });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending_approval");
    const pending = await db().prepare(`SELECT posted_at FROM debt_adjustments WHERE id = ?`).bind(r.body.adjustment.id).first<any>();
    expect(pending.posted_at).toBeNull();
    const p0 = await pnl(today);
    expect((await api("owner", "POST", `${V}/approvals/${r.body.approvalId}/decide`, { decision: "approved" })).status).toBe(200);
    const posted = await db().prepare(`SELECT status, posted_at FROM debt_adjustments WHERE id = ?`).bind(r.body.adjustment.id).first<any>();
    expect(posted.status).toBe("posted");
    expect(posted.posted_at).toBeTruthy();
    expect((await pnl(today)).expenses.badDebt - p0.expenses.badDebt).toBe(100_000);
    const own = await api("owner", "POST", `${V}/debts/adjustments`, { type: "discount", partnerType: "customer", partnerId: 3701, amount: 10_000, reason: "Chiết khấu" });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.status).toBe("posted");
    expect((await db().prepare(`SELECT posted_at FROM debt_adjustments WHERE id = ?`).bind(own.body.adjustment.id).first<any>()).posted_at).toBeTruthy();
  });
});
