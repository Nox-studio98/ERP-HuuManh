import { beforeAll, describe, expect, it } from "vitest";
import { api, login, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { seedShop } from "./shop-helpers";
import { insertOrders } from "./sales-helpers";
import { app } from "../src/worker/index";
import { buildXlsx } from "../src/worker/services/xlsx";
import { hashPassword } from "../src/worker/lib/crypto";
import { PASSWORD } from "./helpers";
import { vnDate, vnPeriod } from "../src/worker/lib/time";

// fix8-reports: PA-1, PA-4, PA-7/C2-10/B-N6, C2-05, PA-8, B-N4, B-N5, C2-09, C2-11 (test hồi quy: assert hành vi ĐÚNG)
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const uid = () => `uuid-fix8r-${Date.now()}-${++seq}`;
const set = (k: string, v: string) => db().prepare(`INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`).bind(k, v).run();
const line = (qty: number) => ({ productId: 1, unit: "kg", qty }); // 100.000đ/kg
let cseq = 0;
async function retail(limit = 1_000_000) {
  const n = ++cseq;
  return (await db()
    .prepare(`INSERT INTO customers(code, type, name, phone, customer_group_id, credit_limit, payment_terms_days) VALUES (?, 'retail', ?, ?, 1, ?, 0) RETURNING id`)
    .bind(`KL-F8R${n}`, `Khách fix8r ${n}`, `09200000${String(n).padStart(2, "0")}`, limit)
    .first<{ id: number }>())!.id;
}

beforeAll(async () => {
  await seedShop();
  await seedSales();
  await db().prepare(`UPDATE lots SET qty_in_milli = 500000, qty_on_hand_milli = 500000 WHERE id = 1`).run();
  await set("pos.retail_credit_enabled", "1");
  await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 100000 });
  await api("manager", "POST", `${V}/shifts/open`, { openingCash: 0 });
});

// ---------------------------------------------------------------- PA-1
describe("PA-1: /reports/vat không cộng hoá đơn phải thu sinh từ ghi nợ POS", () => {
  it("bán nợ một phần + huỷ đơn → output không đổi; hoá đơn B2B vẫn được tính", async () => {
    const period = vnPeriod();
    const before = (await api("owner", "GET", `${V}/reports/vat?period=${period}`)).body;
    const cu = await retail();
    const r = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uid(), customerId: cu, lines: [line(2)], payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    expect(r.status).toBe(201);
    expect((await db().prepare(`SELECT COUNT(*) n FROM invoices WHERE order_id = ?`).bind(r.body.id).first<any>()).n).toBe(1);
    const after = (await api("owner", "GET", `${V}/reports/vat?period=${period}`)).body;
    expect(after.output.base).toBe(before.output.base);
    expect(after.output.count).toBe(before.output.count);
    const v = await api("manager", "POST", `${V}/orders/${r.body.id}/void`, { reason: "hồi quy" });
    expect(v.status).toBe(200);
    expect((await db().prepare(`SELECT COUNT(*) n FROM invoices WHERE order_id = ? AND kind='adjustment'`).bind(r.body.id).first<any>()).n).toBe(1);
    const after2 = (await api("owner", "GET", `${V}/reports/vat?period=${period}`)).body;
    expect(after2.output.count).toBe(before.output.count);
    expect(after2.output.base).toBe(before.output.base);
    // đơn sỉ giữ nguyên: hoá đơn gắn đơn kênh b2b vẫn vào doanh thu chịu thuế
    await insertOrders([{ id: 98801, channel: "b2b", at: new Date().toISOString(), lines: [[1, 1000, 500000, 300000]] }]);
    await db().prepare(`INSERT INTO invoices(code, kind, customer_id, order_id, issue_date, due_date, subtotal, vat_rate_bp, vat_amount, total, einvoice_status) VALUES ('HDB-F8R-1','sale',?,98801,?,?,500000,500,25000,525000,'none')`).bind(cu, vnDate(), vnDate()).run();
    const after3 = (await api("owner", "GET", `${V}/reports/vat?period=${period}`)).body;
    expect(after3.output.base - before.output.base).toBe(500000);
    expect(after3.output.count - before.output.count).toBe(1);
  });
});

// ---------------------------------------------------------------- PA-4
describe("PA-4: dòng tiền không cộng chuyển quỹ vào tổng thu/chi", () => {
  it("chuyển 1.000.000 tiền mặt → ngân hàng: tổng thu/chi không đổi, báo riêng 'Chuyển giữa các quỹ', số dư từng quỹ vẫn khớp", async () => {
    const cat = await db().prepare(`SELECT id FROM cash_categories WHERE code = 'SO_DU_DAU_KY'`).first<any>();
    await db().prepare(`INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, status, period, created_by, created_at) VALUES ('TOP-F8R4', 'in', 1, ?, 5000000, 'posted', ?, 1, '2020-01-01T00:00:00.000Z')`).bind(cat.id, vnPeriod()).run();
    const bank = await db().prepare(`SELECT id FROM funds WHERE type='bank' AND active=1 ORDER BY id LIMIT 1`).first<any>();
    const day = vnDate();
    const f0 = (await api("owner", "GET", `${V}/reports/cash-flow?from=${day}&to=${day}`)).body;
    const t = await api("owner", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: bank.id, amount: 1_000_000 });
    expect(t.status).toBe(201);
    const f1 = (await api("owner", "GET", `${V}/reports/cash-flow?from=${day}&to=${day}`)).body;
    expect(f1.totalInflow).toBe(f0.totalInflow);
    expect(f1.totalOutflow).toBe(f0.totalOutflow);
    expect(f1.closing).toBe(f0.closing);
    expect(f1.transfers.inflow - f0.transfers.inflow).toBe(1_000_000);
    expect(f1.transfers.outflow - f0.transfers.outflow).toBe(1_000_000);
    expect(f1.transfers.label).toBe("Chuyển giữa các quỹ");
    expect(f1.inflows.some((x: any) => /chuyển quỹ/i.test(x.category))).toBe(false);
    const fb = (id: number, r: any) => r.byFund.find((x: any) => x.fundId === id);
    expect(fb(bank.id, f1).inflow - fb(bank.id, f0).inflow).toBe(1_000_000);
    expect(fb(1, f1).outflow - fb(1, f0).outflow).toBe(1_000_000);
    expect(fb(bank.id, f1).closing - fb(bank.id, f0).closing).toBe(1_000_000);
    expect(fb(1, f1).closing - fb(1, f0).closing).toBe(-1_000_000);
  });
});

// ---------------------------------------------------------------- PA-8
describe("PA-8: ngân sách – thực tế khớp lãi lỗ cùng kỳ", () => {
  it("xoá nợ vào dòng 'other', chiết khấu thanh toán giảm doanh thu", async () => {
    const period = vnPeriod();
    const day = vnDate();
    const b0 = (await api("owner", "GET", `${V}/reports/budget-vs-actual?period=${period}`)).body.lineActuals;
    const p0 = (await api("owner", "GET", `${V}/reports/pnl?from=${day}&to=${day}`)).body;
    const cu = await retail();
    await db().prepare(`INSERT INTO debt_adjustments(code, type, partner_type, partner_id, amount, status, reason, created_by, posted_at) VALUES ('DCN-F8R-1','write_off','customer',?,70000,'posted','khó đòi',1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),('DCN-F8R-2','discount','customer',?,30000,'posted','CK thanh toán',1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(cu, cu).run();
    const b1 = (await api("owner", "GET", `${V}/reports/budget-vs-actual?period=${period}`)).body.lineActuals;
    expect((b1.other ?? 0) - (b0.other ?? 0)).toBe(70000);
    expect(b1.revenue - b0.revenue).toBe(-30000);
    expect(b1.badDebt).toBe(70000 + (b0.badDebt ?? 0));
    const p1 = (await api("owner", "GET", `${V}/reports/pnl?from=${day}&to=${day}`)).body;
    expect(p1.expenses.badDebt - (p0.expenses.badDebt ?? 0)).toBe(70000);
    expect(p1.revenueDeductions.paymentDiscount - p0.revenueDeductions.paymentDiscount).toBe(30000);
  });
});

// ---------------------------------------------------------------- B-N4 / B-N5
const xlsx = (header: string[], rows: string[][]) =>
  buildXlsx([{ name: "Dữ liệu", columns: header.map((h) => ({ header: h, type: "text" as const })), rows }]);
async function upload(role: string, kind: string, step: "preview" | "commit", bytes: Uint8Array, name: string, mode?: string) {
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], name));
  if (mode) fd.set("mode", mode);
  const res = await app.request(`${V}/imports/${kind}/${step}`, { method: "POST", headers: { authorization: `Bearer ${await login(role)}` }, body: fd }, testEnv);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const PH = ["Mã hàng", "Tên hàng", "Đơn vị chính", "Bán theo cân", "Đơn vị quy đổi", "Hệ số quy đổi", "Giá bán chung"];

describe("B-N4: nhập Excel khớp mã không phân biệt hoa/thường và ghi theo hàng đã có", () => {
  it("mã 'prb-tao' khớp 'PRB-TAO': đơn vị quy đổi và giá được ghi", async () => {
    const p = await api("manager", "POST", `${V}/products`, { sku: "PRB-TAO", name: "Táo probe", baseUnit: "kg", sellByWeight: true });
    expect(p.status).toBe(201);
    const file = xlsx(PH, [["prb-tao", "Táo probe mới", "kg", "Có", "", "", "150000"], ["prb-tao", "", "", "", "thùng", "10", ""]]);
    const pv = await upload("owner", "products", "preview", file, "a.xlsx");
    expect(pv.body.rows[0].status).toBe("exists");
    const cm = await upload("owner", "products", "commit", file, "a.xlsx", "update");
    expect(cm.status).toBe(201);
    expect(cm.body.updated).toBe(1);
    const prod = await db().prepare(`SELECT id, name, sku FROM products WHERE sku='PRB-TAO'`).first<any>();
    expect(prod.name).toBe("Táo probe mới");
    const units = (await db().prepare(`SELECT unit FROM product_units WHERE product_id=?`).bind(prod.id).all<any>()).results;
    const prices = (await db().prepare(`SELECT unit_price FROM prices WHERE product_id=? AND status='active'`).bind(prod.id).all<any>()).results;
    expect(units.map((u: any) => u.unit)).toContain("thùng");
    expect(prices.map((x: any) => x.unit_price)).toContain(150000);
    expect((await db().prepare(`SELECT COUNT(*) n FROM products WHERE lower(sku) = 'prb-tao'`).first<any>()).n).toBe(1);
  });
});

describe("B-N5: xuất dùng nội bộ chặn lô cách ly", () => {
  it("thêm dòng từ lô đang cách ly bị chặn; lô cách ly SAU khi thêm dòng → ghi sổ bị chặn, tồn không đổi", async () => {
    const pr = await api("manager", "POST", `${V}/products`, { sku: "PRB-IU", name: "IU probe", baseUnit: "kg", sellByWeight: true });
    const doc = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierRef: "X" });
    await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { productId: pr.body.id, unit: "kg", qty: 5, unitCost: 10000 });
    expect((await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/post`)).status).toBe(200);
    const lot = (await db().prepare(`SELECT * FROM lots WHERE receipt_doc_id = ?`).bind(doc.body.id).first<any>())!;
    const iu = await api("manager", "POST", `${V}/stock-docs`, { type: "internal_use", locationId: 1, reason: "Ăn thử" });
    expect((await api("manager", "POST", `${V}/stock-docs/${iu.body.id}/lines`, { lotId: lot.id, qty: 1, unit: "kg" })).status).toBe(201);
    expect((await api("manager", "POST", `${V}/lots/${lot.id}/quarantine`, { reason: "Hỏng, nghi nhiễm" })).status).toBe(200);
    const post = await api("manager", "POST", `${V}/stock-docs/${iu.body.id}/post`);
    expect(post.status).toBe(422);
    expect(post.body.error.code).toBe("lot_not_active");
    const after = await db().prepare(`SELECT status, qty_on_hand_milli FROM lots WHERE id=?`).bind(lot.id).first<any>();
    expect(after).toMatchObject({ status: "quarantine", qty_on_hand_milli: lot.qty_on_hand_milli });
    expect((await db().prepare(`SELECT status FROM stock_docs WHERE id=?`).bind(iu.body.id).first<any>()).status).not.toBe("posted");
    // thêm dòng mới từ lô đã cách ly cũng bị chặn
    const iu2 = await api("manager", "POST", `${V}/stock-docs`, { type: "internal_use", locationId: 1, reason: "Ăn thử 2" });
    const add = await api("manager", "POST", `${V}/stock-docs/${iu2.body.id}/lines`, { lotId: lot.id, qty: 1, unit: "kg" });
    expect(add.status).toBe(422);
    expect(add.body.error.code).toBe("lot_not_active");
  });
});

// ---------------------------------------------------------------- C2-09 / C2-11
describe("C2-09: gộp khách lẻ chuyển đủ dữ liệu, chỉ chặn khi còn hoá đơn chưa trả hết", () => {
  const mk = async (code: string) =>
    (await db().prepare(`INSERT INTO customers(code, type, name, phone, customer_group_id, credit_limit) VALUES (?, 'retail', ?, ?, 1, 1000000) RETURNING id`).bind(code, `Khách ${code}`, `0933${code.slice(-6).padStart(6, "0")}`).first<{ id: number }>())!.id;
  const ver = async (id: number) => (await api("owner", "GET", `${V}/retail-customers/${id}`)).body.version as number;
  const inv = (code: string, cust: number, total: number) =>
    db().prepare(`INSERT INTO invoices(code, kind, customer_id, issue_date, due_date, subtotal, vat_rate_bp, vat_amount, total, einvoice_status) VALUES (?, 'sale', ?, ?, ?, ?, 0, 0, ?, 'not_required') RETURNING id`).bind(code, cust, vnDate(), vnDate(), total, total).first<{ id: number }>();

  it("còn hoá đơn chưa trả hết → 422; đã trả hết (có hoá đơn điều chỉnh) → gộp được, hoá đơn ở lại nguồn", async () => {
    const dst = await mk("KL-M9001"), s1 = await mk("KL-M9002"), s2 = await mk("KL-M9003");
    await inv("HDB-F8R-M1", s1, 100000);
    const m1 = await api("owner", "POST", `${V}/retail-customers/${s1}/merge`, { targetId: dst, version: await ver(s1), targetVersion: await ver(dst), reason: "trùng hồ sơ" });
    expect(m1.status).toBe(422);
    expect(m1.body.error.code).toBe("has_unpaid_invoices");

    const paid = (await inv("HDB-F8R-M2", s2, 100000))!;
    await db().prepare(`INSERT INTO invoices(code, kind, original_invoice_id, customer_id, issue_date, due_date, subtotal, vat_rate_bp, vat_amount, total, einvoice_status) VALUES ('HDB-F8R-M2A','adjustment',?,?,?,?,-100000,0,0,-100000,'not_required')`).bind(paid.id, s2, vnDate(), vnDate()).run();
    await db().batch([
      db().prepare(`INSERT INTO customer_contacts(customer_id, name, phone, is_receiver) VALUES (?, 'Người nhận', '0911', 1)`).bind(s2),
      db().prepare(`INSERT INTO customer_addresses(customer_id, label, address, is_default) VALUES (?, 'Nhà', '1 Đường Gộp', 1)`).bind(s2),
      db().prepare(`INSERT INTO price_lists(name, channel, kind, priority, customer_id) VALUES ('Giá riêng M9003','all','customer',50,?)`).bind(s2),
      db().prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('customer.credit_change','customer',?, '{"creditLimit":9000000}', 'nâng hạn mức', 1)`).bind(String(s2)),
    ]);
    const m2 = await api("owner", "POST", `${V}/retail-customers/${s2}/merge`, { targetId: dst, version: await ver(s2), targetVersion: await ver(dst), reason: "trùng hồ sơ" });
    expect(m2.status).toBe(200);
    const n = async (sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).first<any>()).n;
    expect(await n(`SELECT COUNT(*) n FROM customer_addresses WHERE customer_id = ?`, dst)).toBe(1);
    expect(await n(`SELECT COUNT(*) n FROM customer_addresses WHERE customer_id = ?`, s2)).toBe(0);
    expect(await n(`SELECT COUNT(*) n FROM customer_contacts WHERE customer_id = ?`, dst)).toBe(1);
    expect(await n(`SELECT COUNT(*) n FROM price_lists WHERE customer_id = ?`, dst)).toBe(1);
    expect(await n(`SELECT COUNT(*) n FROM price_lists WHERE customer_id = ?`, s2)).toBe(0);
    expect(await n(`SELECT COUNT(*) n FROM approvals WHERE type='customer.credit_change' AND ref_id = ? AND status = 'pending'`, String(s2))).toBe(0);
    expect(await n(`SELECT COUNT(*) n FROM approvals WHERE type='customer.credit_change' AND ref_id = ? AND status = 'rejected'`, String(s2))).toBe(1);
    expect(await n(`SELECT COUNT(*) n FROM invoices WHERE customer_id = ?`, s2)).toBe(2); // lịch sử ở lại nguồn
  });
});

describe("C2-11: /retail-customers che ngày sinh, ghi chú, địa chỉ khi thiếu customers.view_pii", () => {
  it("thủ kho thấy MM-DD và '***'; chủ thấy đầy đủ", async () => {
    const id = (await db().prepare(`INSERT INTO customers(code, type, name, phone, customer_group_id, birthday, note, address) VALUES ('KL-PII1','retail','Khách PII','0903123499',1,'1990-05-17','Hay đổi ý, ghi nợ','12 Ngõ Kín') RETURNING id`).first<{ id: number }>())!.id;
    const w = await api("warehouse", "GET", `${V}/retail-customers/${id}`);
    expect(w.status).toBe(200);
    expect(w.body.birthday).toBe("05-17");
    expect(w.body.note).toBe("***");
    expect(w.body.address).toBe("***");
    const o = await api("owner", "GET", `${V}/retail-customers/${id}`);
    expect(o.body).toMatchObject({ birthday: "1990-05-17", note: "Hay đổi ý, ghi nợ", address: "12 Ngõ Kín" });
    const list = await api("warehouse", "GET", `${V}/retail-customers?q=PII`);
    const row = list.body.items.find((x: any) => x.id === id);
    expect(row).toMatchObject({ birthday: "05-17", note: "***", address: "***" });
  });
});

// ---------------------------------------------------------------- thưởng/hoa hồng: PA-7, C2-10, B-N6, C2-05
const U = 9501, EMP = 9501;
const at = (d: string) => `${d}T03:00:00.000Z`;
async function closeTimesheet(period: string) {
  await db().batch([
    db().prepare(`INSERT INTO timesheets(period, status) VALUES (?, 'open')`).bind(period),
    ...Array.from({ length: 26 }, (_, i) => db().prepare(`INSERT INTO timesheet_days(period, employee_id, work_date, worked_minutes, shifts_worked) VALUES (?,?,?,?,1)`).bind(period, EMP, `${period}-${String(i + 1).padStart(2, "0")}`, 480)),
    db().prepare(`UPDATE timesheets SET status='closed' WHERE period = ?`).bind(period),
  ]);
}
const salesBonus = async (period: string) => {
  expect((await api("accountant", "POST", `${V}/payroll/periods/${period}/calculate`)).status).toBe(200);
  const it = (await api("accountant", "GET", `${V}/payroll/periods/${period}`)).body.items.find((i: any) => i.code === `NV-${EMP}`);
  return it.salesBonus as number;
};

describe("thưởng/hoa hồng", () => {
  beforeAll(async () => {
    const hash = await hashPassword(PASSWORD);
    await db().batch([
      db().prepare(`INSERT INTO users(id, username, full_name, pass_hash, role, store_id) VALUES (?, 'f8r_seller', 'NV Bán F8R', ?, 'staff', 1)`).bind(U, hash),
      db().prepare(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date, pay_type, base_salary, insurance_salary, pit_enabled) VALUES (?, 'NV-9501', ?, 'NV Bán F8R', 'bán hàng', 1, '2026-01-01', 'monthly', 10400000, 0, 0)`).bind(EMP, U),
    ]);
    for (const p of ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]) await closeTimesheet(p);
  });

  it("B-N6 + C2-10 + PA-7: thưởng % kiểu cũ — doanh số HÀNG (không gồm thu khác), trả hàng chỉ trừ đơn gốc kênh pos", async () => {
    await db().prepare(`UPDATE settings SET value='1000' WHERE key='hr.sales_bonus_bp'`).run();
    await insertOrders([
      { id: 95001, createdBy: U, at: at("2026-03-10"), lines: [[1, 10000, 900000, 500000]] }, // hàng 900.000 (+ thu khác 100.000)
      { id: 95002, channel: "social", createdBy: U, at: at("2026-03-10"), lines: [[1, 5000, 500000, 300000]] }, // đơn giao tại quầy: chưa từng cộng
      { id: 95003, kind: "return", orig: 95001, createdBy: 1, at: at("2026-03-12"), lines: [[1, 1000, 100000, 60000, 950010]] },
      { id: 95004, channel: "social", kind: "return", orig: 95002, createdBy: 1, at: at("2026-03-12"), lines: [[1, 5000, 500000, 300000, 950020]] }, // không được trừ
      { id: 95005, createdBy: U, at: at("2026-03-20"), lines: [[1, 4000, 400000, 240000]] }, // sẽ bị huỷ ở tháng 4
    ]);
    await db().prepare(`UPDATE orders SET charges_total = 100000, total = total + 100000 WHERE id = 95001`).run();
    // (900.000 − 100.000 + 400.000) × 10%
    expect(await salesBonus("2026-03")).toBe(120_000);
    // báo cáo người bán cùng cơ sở: doanh số hàng, thu khác tách riêng
    const rep = (await api("manager", "GET", `${V}/reports/sales/sellers?from=2026-03-01&to=2026-03-31&channel=pos`)).body;
    const me = rep.items.find((x: any) => x.sellerId === U);
    expect(me.sales).toBe(900_000 + 400_000);
    expect(me.returns).toBe(100_000);
    expect(me.otherCharges).toBe(100_000);
    expect(rep.totals.otherCharges).toBeGreaterThanOrEqual(100_000);
  });

  it("C2-05 (thưởng cũ): huỷ đơn của kỳ đã duyệt → trừ ở kỳ có ngày huỷ; kỳ chưa duyệt → đơn huỷ chỉ đơn giản không tính", async () => {
    expect((await api("owner", "POST", `${V}/payroll/periods/2026-03/approve`)).status).toBe(200);
    // huỷ đơn 95005 (hoàn tất 20/03, kỳ 03 đã duyệt) — trigger tự ghi voided_at; giả lập ngày huỷ ở kỳ 04
    await db().prepare(`UPDATE orders SET status='cancelled', voided_by=1, void_reason='hồi quy' WHERE id=95005`).run();
    expect((await db().prepare(`SELECT voided_at FROM orders WHERE id=95005`).first<any>()).voided_at).not.toBeNull();
    await db().prepare(`UPDATE orders SET voided_at = ? WHERE id=95005`).bind(at("2026-04-05")).run();
    // đơn tháng 2 (kỳ chưa tính/duyệt) bị huỷ tháng 4 → không thu hồi
    await insertOrders([
      { id: 95006, createdBy: U, at: at("2026-02-10"), lines: [[1, 3000, 300000, 180000]] },
      { id: 95007, createdBy: U, at: at("2026-04-10"), lines: [[1, 20000, 2000000, 1200000]] },
    ]);
    await db().prepare(`UPDATE orders SET status='cancelled', voided_by=1, void_reason='hồi quy' WHERE id=95006`).run();
    await db().prepare(`UPDATE orders SET voided_at = ? WHERE id=95006`).bind(at("2026-04-06")).run();
    // (2.000.000 − 400.000 thu hồi) × 10%
    expect(await salesBonus("2026-04")).toBe(160_000);
  });

  it("C2-05 (hoa hồng theo quy tắc): huỷ đơn kỳ đã duyệt thu hồi ở kỳ huỷ; kỳ chưa duyệt không thu hồi", async () => {
    const rule = await api("owner", "POST", `${V}/commission/rules`, { name: "10% F8R", scope: "all", rateBp: 1000, effectiveFrom: "2026-05-01", effectiveTo: "2026-07-31" });
    expect(rule.status).toBe(201);
    await db().prepare(`UPDATE settings SET value='0' WHERE key='hr.sales_bonus_bp'`).run();
    await insertOrders([
      { id: 95101, createdBy: U, at: at("2026-06-10"), lines: [[1, 10000, 1000000, 600000]] }, // kỳ 06: hoa hồng 100.000, sẽ được duyệt
      { id: 95102, createdBy: U, at: at("2026-05-10"), lines: [[1, 7000, 700000, 420000]] }, // kỳ 05: chưa duyệt
    ]);
    expect(await salesBonus("2026-06")).toBe(100_000);
    expect((await api("owner", "POST", `${V}/payroll/periods/2026-06/approve`)).status).toBe(200);
    await db().prepare(`UPDATE orders SET status='cancelled', voided_by=1, void_reason='hồi quy' WHERE id IN (95101, 95102)`).run();
    await db().prepare(`UPDATE orders SET voided_at = ? WHERE id IN (95101, 95102)`).bind(at("2026-07-05")).run();
    await insertOrders([{ id: 95103, createdBy: U, at: at("2026-07-10"), lines: [[1, 15000, 1500000, 900000]] }]);
    const prev = (await api("accountant", "GET", `${V}/commission/preview?period=2026-07`)).body.items.find((x: any) => x.userId === U);
    expect(prev.revenue).toBe(500_000); // 1.500.000 − 1.000.000 (đơn kỳ 06 đã duyệt); đơn kỳ 05 chưa duyệt không bị trừ
    expect(prev.commission).toBe(50_000);
    expect(await salesBonus("2026-07")).toBe(50_000);
  });
});
