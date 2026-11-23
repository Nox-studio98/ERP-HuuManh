import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { vnDate, vnPeriod } from "../src/worker/lib/time";

const V = "/api/v1";
const db = () => testEnv.DB;
const today = () => vnDate();
const cat: Record<string, number> = {};
const nowIso = () => new Date().toISOString();

async function voucher(code: string, direction: "in" | "out", categoryCode: string, amount: number, channel: string | null = null) {
  await db()
    .prepare(`INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, status, period, created_by, channel) VALUES (?,?,1,?,?, 'posted', ?, 1, ?)`)
    .bind(code, direction, cat[categoryCode], amount, vnPeriod(), channel)
    .run();
}
async function order(code: string, channel: string, total: number, cost: number) {
  const r = await db()
    .prepare(`INSERT INTO orders(code, channel, kind, store_id, status, subtotal, total, cost_total, paid_total, completed_at) VALUES (?,?, 'sale',1,'completed',?,?,?,?,?) RETURNING id`)
    .bind(code, channel, total, total, cost, total, nowIso())
    .first<{ id: number }>();
  await db().prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, line_total, cost_amount) VALUES (?,1,'kg',1000,?,?,?)`).bind(r!.id, total, total, cost).run();
}

beforeAll(async () => {
  await seedBase();
  await seedSales();
  for (const c of (await db().prepare(`SELECT id, code FROM cash_categories`).all<any>()).results) cat[c.code] = c.id;
  await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 });
  // POS thật: 2kg Táo = 200.000, vốn 120.000
  const pos = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: "fin-pos-0001", lines: [{ productId: 1, unit: "kg", qty: 2 }], payments: [{ method: "cash", amount: 200000 }] });
  expect(pos.status).toBe(201);
  await order("DH-FIN-1", "online", 100000, 40000);
  await order("DS-FIN-1", "b2b", 300000, 200000);
  // chi phí: chung (chia theo doanh thu / tỉ lệ cố định), trực tiếp kênh online, chung chưa có quy tắc
  await voucher("PC-FIN-1", "out", "MAT_BANG", 300000);
  await voucher("PC-FIN-2", "out", "DIEN_NUOC", 100000);
  await voucher("PC-FIN-3", "out", "VAN_CHUYEN", 50000, "online");
  await voucher("PC-FIN-4", "out", "LUONG", 90000);
  await voucher("PT-FIN-1", "in", "BAN_HANG", 70000);
  // hao hụt 1kg Táo lô 1 (vốn 60k)
  await db().batch([
    db().prepare(`UPDATE lots SET qty_on_hand_milli = qty_on_hand_milli - 1000 WHERE id=1`),
    db().prepare(`INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id) VALUES (1,1,-1000,60000,'waste','stock_doc',1)`),
  ]);
});

describe("quy tắc phân bổ chi phí", () => {
  it("chỉ finance.write; validate tổng tỉ lệ = 10000 và tên kênh", async () => {
    expect((await api("manager", "GET", `${V}/cost-allocation-rules`)).status).toBe(403);
    const bad = await api("accountant", "PUT", `${V}/cost-allocation-rules`, { rules: [{ categoryId: cat.DIEN_NUOC, method: "fixed_bp", weights: { pos: 5000, online: 3000 } }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("weights_not_100");
    expect((await api("accountant", "PUT", `${V}/cost-allocation-rules`, { rules: [{ categoryId: cat.DIEN_NUOC, method: "fixed_bp", weights: { pos: 5000, shop: 5000 } }] })).status).toBe(422);
  });

  it("lưu và đọc lại quy tắc", async () => {
    const r = await api("accountant", "PUT", `${V}/cost-allocation-rules`, {
      rules: [
        { categoryId: cat.MAT_BANG, method: "revenue_share" },
        { categoryId: cat.DIEN_NUOC, method: "fixed_bp", weights: { pos: 5000, online: 3000, b2b: 2000 } },
      ],
    });
    expect(r.status).toBe(200);
    const g = await api("accountant", "GET", `${V}/cost-allocation-rules`);
    expect(g.body.items).toHaveLength(2);
    expect(g.body.items.find((x: any) => x.method === "fixed_bp").weights).toEqual({ pos: 5000, online: 3000, b2b: 2000 });
  });
});

describe("lãi lỗ theo kênh (M6-06)", () => {
  it("doanh thu / giá vốn / chi phí trực tiếp / phân bổ theo từng kênh", async () => {
    const r = await api("manager", "GET", `${V}/reports/pnl-by-channel?from=${today()}&to=${today()}`);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.channels.map((c: any) => [c.channel, c]));
    expect(by.pos).toMatchObject({ revenue: 200000, cogs: 120000, grossProfit: 80000, directCosts: 0 });
    expect(by.online).toMatchObject({ revenue: 100000, cogs: 40000, directCosts: 50000 });
    expect(by.b2b).toMatchObject({ revenue: 300000, cogs: 200000 });
    // MAT_BANG 300k theo doanh thu 200:100:300 → 100k / 50k / 150k ; DIEN_NUOC 100k theo 50/30/20 → 50k / 30k / 20k
    expect(by.pos.allocatedCosts).toBe(100000 + 50000);
    expect(by.online.allocatedCosts).toBe(50000 + 30000);
    expect(by.b2b.allocatedCosts).toBe(150000 + 20000);
    const mb = r.body.allocations.find((a: any) => a.method === "revenue_share");
    expect(mb.byChannel).toEqual({ pos: 100000, online: 50000, b2b: 150000 });
    // lương (không có quy tắc) + hao hụt 60k chưa phân bổ
    expect(r.body.unallocated.map((u: any) => [u.category, u.amount, u.reason]).sort()).toEqual([["Hao hụt", 60000, "not_attributable"], ["Lương", 90000, "no_rule"]].sort());
  });

  it("tổng các kênh khớp /reports/pnl (doanh thu, giá vốn, chi phí, lợi nhuận)", async () => {
    const q = `from=${today()}&to=${today()}`;
    const ch = (await api("manager", "GET", `${V}/reports/pnl-by-channel?${q}`)).body;
    const pnl = (await api("manager", "GET", `${V}/reports/pnl?${q}`)).body;
    expect(ch.totals.revenue).toBe(pnl.revenue);
    expect(ch.totals.cogs).toBe(pnl.cogs);
    expect(ch.totals.grossProfit).toBe(pnl.grossProfit);
    expect(ch.totals.totalExpenses).toBe(pnl.totalExpenses);
    expect(ch.totals.netProfit).toBe(pnl.netProfit);
    expect(pnl.revenue).toBe(600000);
    // Σ từng dòng kênh cũng khớp
    expect(ch.channels.reduce((s: number, c: any) => s + c.revenue, 0)).toBe(pnl.revenue);
    expect(ch.channels.reduce((s: number, c: any) => s + c.netProfit, 0) - ch.totals.unallocatedCosts).toBe(pnl.netProfit);
  });

  it("chỉ người có reports.view", async () => {
    expect((await api("cashier", "GET", `${V}/reports/pnl-by-channel`)).status).toBe(403);
    expect((await api("cashier", "GET", `${V}/reports/cash-flow`)).status).toBe(403);
    expect((await api("cashier", "GET", `${V}/reports/vat`)).status).toBe(403);
  });
});

describe("dòng tiền (M6-07)", () => {
  it("đầu kỳ + thu − chi = cuối kỳ và khớp số dư các quỹ", async () => {
    const r = await api("manager", "GET", `${V}/reports/cash-flow?from=${today()}&to=${today()}`);
    expect(r.status).toBe(200);
    expect(r.body.opening).toBe(0);
    const inflow = (n: string) => r.body.inflows.find((x: any) => x.category === n)?.amount;
    expect(inflow("Thu bán hàng")).toBe(200000);
    expect(inflow("Thu tiền bán hàng")).toBe(70000);
    expect(r.body.outflows.reduce((s: number, x: any) => s + x.amount, 0)).toBe(300000 + 100000 + 50000 + 90000);
    expect(r.body.closing).toBe(r.body.opening + r.body.totalInflow - r.body.totalOutflow);
    const funds = (await api("manager", "GET", `${V}/funds`)).body.items;
    expect(r.body.closing).toBe(funds.reduce((s: number, f: any) => s + f.balance, 0));
    for (const bf of r.body.byFund) expect(bf.closing).toBe(funds.find((f: any) => f.id === bf.fundId).balance);
    expect(r.body.byFund.find((f: any) => f.fundId === 1).inflow).toBe(270000);
  });

  it("kỳ sau: số dư đầu kỳ = cuối kỳ trước; lọc theo quỹ", async () => {
    const tomorrow = vnDate(new Date(Date.now() + 86400_000));
    const t = await api("manager", "GET", `${V}/reports/cash-flow?from=${today()}&to=${today()}`);
    const next = await api("manager", "GET", `${V}/reports/cash-flow?from=${tomorrow}&to=${tomorrow}`);
    expect(next.body.opening).toBe(t.body.closing);
    expect(next.body.inflows).toEqual([]);
    expect(next.body.closing).toBe(next.body.opening);
    const f2 = await api("manager", "GET", `${V}/reports/cash-flow?from=${today()}&to=${today()}&fundId=2`);
    expect(f2.body.byFund).toHaveLength(1);
    expect(f2.body.closing).toBe(0);
    expect((await api("manager", "GET", `${V}/reports/cash-flow?from=2026-13-40`)).status).toBe(422);
  });
});

describe("thuế GTGT (M6-08)", () => {
  it("đầu ra từ hoá đơn bán, đầu vào từ hoá đơn mua, phải nộp = ra − vào", async () => {
    const period = vnPeriod();
    const d = `${period}-15`;
    await db().batch([
      db().prepare(`INSERT INTO customers(id, code, type, name) VALUES (51,'KH-VAT','b2b','Công ty VAT')`),
      db().prepare(`INSERT INTO suppliers(id, code, name) VALUES (51,'NCC-VAT','NCC VAT')`),
      db().prepare(`INSERT INTO invoices(code, customer_id, issue_date, due_date, subtotal, vat_rate_bp, vat_amount, total, created_by) VALUES
        ('HDB-V1',51,?,?,1000000,800,80000,1080000,1),('HDB-V2',51,?,?,300000,1000,30000,330000,1),('HDB-V3',51,?,?,500000,800,40000,540000,1)`).bind(d, d, d, d, d, d),
      db().prepare(`UPDATE invoices SET status='cancelled' WHERE code='HDB-V3'`),
      db().prepare(`INSERT INTO invoices(code, customer_id, issue_date, due_date, subtotal, vat_rate_bp, vat_amount, total, created_by) VALUES ('HDB-OLD',51,'2020-01-10','2020-01-10',1000000,800,80000,1080000,1)`),
      db().prepare(`INSERT INTO supplier_bills(code, supplier_id, issue_date, due_date, total, vat_amount, created_by) VALUES ('CNP-V1',51,?,?,2160000,160000,1),('CNP-V2',51,?,?,100000,0,1)`).bind(d, d, d, d),
    ]);
    const r = await api("manager", "GET", `${V}/reports/vat?period=${period}`);
    expect(r.status).toBe(200);
    expect(r.body.output).toMatchObject({ vat: 110000, base: 1300000, count: 2 });
    expect(r.body.output.byRate).toEqual([
      { rateBp: 800, count: 1, base: 1000000, vat: 80000 },
      { rateBp: 1000, count: 1, base: 300000, vat: 30000 },
    ]);
    expect(r.body.input).toMatchObject({ vat: 160000, count: 2 });
    expect(r.body.payable).toBe(110000 - 160000);
    expect(r.body.notice).toContain("Cần xác nhận");
    expect((await api("manager", "GET", `${V}/reports/vat?period=2020-01`)).body.output.vat).toBe(80000);
    expect((await api("manager", "GET", `${V}/reports/vat?period=abc`)).status).toBe(422);
  });
});

describe("ngân sách (M6-10)", () => {
  const period = vnPeriod();
  it("lưu ngân sách theo kỳ (thay thế toàn bộ), đọc lại; quyền", async () => {
    expect((await api("cashier", "GET", `${V}/budgets?period=${period}`)).status).toBe(403);
    expect((await api("manager", "PUT", `${V}/budgets`, { period, items: [] })).status).toBe(403);
    const dup = await api("accountant", "PUT", `${V}/budgets`, { period, items: [{ line: "revenue", amount: 1 }, { line: "revenue", amount: 2 }] });
    expect(dup.status).toBe(422);
    const r = await api("accountant", "PUT", `${V}/budgets`, {
      period,
      items: [{ categoryId: cat.MAT_BANG, amount: 400000 }, { line: "revenue", amount: 1000000 }, { line: "cogs", amount: 300000 }, { categoryId: cat.DIEN_NUOC, amount: 0 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(4);
    const g = await api("manager", "GET", `${V}/budgets?period=${period}`);
    expect(g.body.items).toHaveLength(4);
    expect((await api("manager", "GET", `${V}/budgets?period=2020-01`)).body.items).toEqual([]);
  });

  it("ngân sách so với thực tế: chênh lệch và %", async () => {
    const r = await api("manager", "GET", `${V}/reports/budget-vs-actual?period=${period}`);
    expect(r.status).toBe(200);
    const row = (f: (x: any) => boolean) => r.body.items.find(f);
    const rent = row((x) => x.categoryId === cat.MAT_BANG);
    expect(rent).toMatchObject({ budget: 400000, actual: 300000, variance: -100000, variancePct: -25 });
    const revenue = row((x) => x.line === "revenue");
    expect(revenue).toMatchObject({ budget: 1000000, actual: 600000, variance: -400000, variancePct: -40 });
    const cogs = row((x) => x.line === "cogs");
    expect(cogs).toMatchObject({ budget: 300000, actual: 360000, variance: 60000, variancePct: 20 });
    const power = row((x) => x.categoryId === cat.DIEN_NUOC);
    expect(power).toMatchObject({ budget: 0, actual: 100000, variance: 100000, variancePct: null });
    // thực tế dòng khớp P&L
    const pnl = (await api("manager", "GET", `${V}/reports/pnl?from=${period}-01&to=${today()}`)).body;
    expect(r.body.lineActuals.revenue).toBe(pnl.revenue);
    expect(r.body.lineActuals.cogs).toBe(pnl.cogs);
    expect(r.body.lineActuals.payroll).toBe(pnl.expenses.payroll);
  });
});
