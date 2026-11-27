import { beforeAll, describe, expect, it } from "vitest";
import { api, login, seedBase, testEnv } from "./helpers";
import { app } from "../src/worker/index";
import { vnDate, vnPeriod } from "../src/worker/lib/time";

// Đợt 8 — xuất dùng nội bộ (stock_docs.type='internal_use') và chuyển tiền giữa các quỹ (fund_transfers).
const V = "/api/v1";
const db = () => testEnv.DB;
const today = vnDate();
const pnl = async () => (await api("owner", "GET", `${V}/reports/pnl?from=${today}&to=${today}`)).body;
const invRow = async (productId: number) => (await api("owner", "GET", `${V}/reports/inventory?asOf=${today}`)).body.items.find((x: any) => x.productId === productId);

async function mkProduct(sku: string) {
  const r = await api("manager", "POST", `${V}/products`, { sku, name: sku, baseUnit: "kg", sellByWeight: true });
  expect(r.status).toBe(201);
  return r.body.id as number;
}
/** Nhập lô `qty` kg giá `cost`/kg (có thể chỉ định hạn dùng). */
async function receive(productId: number, qty: number, cost: number, expiresAt?: string) {
  const doc = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierRef: "NCC-IU" });
  await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { productId, unit: "kg", qty, unitCost: cost, ...(expiresAt ? { expiresAt } : {}) });
  expect((await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/post`)).status).toBe(200);
  return (await db().prepare(`SELECT * FROM lots WHERE receipt_doc_id = ?`).bind(doc.body.id).first<any>())!;
}
async function internalDoc(role: string, reason: string | undefined = "Dùng làm hàng mẫu cho khách") {
  const r = await api(role, "POST", `${V}/stock-docs`, { type: "internal_use", locationId: 1, ...(reason ? { reason } : {}) });
  return r;
}

beforeAll(seedBase);

describe("Xuất dùng nội bộ", () => {
  it("bắt buộc có lý do / mục đích", async () => {
    const r = await internalDoc("manager", "");
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation_error");
  });

  it("người không có quyền kho không tạo được", async () => {
    expect((await internalDoc("cashier")).status).toBe(403);
  });

  it("xuất theo FEFO: lấy lô hết hạn sớm trước; ghi stock_moves internal_use; không đụng lô sau", async () => {
    const pid = await mkProduct("IU-FEFO");
    const soon = await receive(pid, 3, 40000, new Date(Date.now() + 5 * 86400_000).toISOString());
    const late = await receive(pid, 10, 60000, new Date(Date.now() + 30 * 86400_000).toISOString());
    const doc = await internalDoc("manager");
    expect(doc.status).toBe(201);
    expect(doc.body.type).toBe("internal_use");
    expect(doc.body.code).toMatch(/^XN-/);
    const ln = await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { productId: pid, unit: "kg", qty: 4 });
    expect(ln.status).toBe(201);
    expect(ln.body.lines).toHaveLength(2); // 3 kg lô sớm + 1 kg lô sau
    const post = await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/post`);
    expect(post.status).toBe(200);
    expect(post.body.status).toBe("posted");
    expect(post.body.totalAmount).toBe(3 * 40000 + 1 * 60000);
    const mv = (await db().prepare(`SELECT lot_id, qty_delta_milli, unit_cost, move_type FROM stock_moves WHERE ref_type='stock_doc' AND ref_id = ? ORDER BY lot_id`).bind(doc.body.id).all<any>()).results;
    expect(mv).toEqual([
      { lot_id: soon.id, qty_delta_milli: -3000, unit_cost: 40000, move_type: "internal_use" },
      { lot_id: late.id, qty_delta_milli: -1000, unit_cost: 60000, move_type: "internal_use" },
    ]);
    expect((await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id = ?`).bind(soon.id).first<any>()).q).toBe(0);
    expect((await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id = ?`).bind(late.id).first<any>()).q).toBe(9000);
  });

  it("vào lãi lỗ ở dòng riêng 'internalUse' theo giá vốn lô; nhập-xuất-tồn có cột riêng và vẫn cân", async () => {
    const pid = await mkProduct("IU-PNL");
    const lot = await receive(pid, 20, 50000);
    const before = await pnl();
    const doc = await internalDoc("manager", "Ăn thử, kiểm tra chất lượng");
    await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { lotId: lot.id, qty: 2, unit: "kg" });
    expect((await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/post`)).status).toBe(200);
    const after = await pnl();
    expect((after.expenses.internalUse ?? 0) - (before.expenses.internalUse ?? 0)).toBe(100_000);
    expect(after.totalExpenses - before.totalExpenses).toBe(100_000);
    expect(after.netProfit - before.netProfit).toBe(-100_000);
    // không tính trùng vào hao hụt / kiểm kê
    expect((after.expenses.shrinkage ?? 0)).toBe(before.expenses.shrinkage ?? 0);
    expect((after.expenses.stockCount ?? 0)).toBe(before.expenses.stockCount ?? 0);
    const r = await invRow(pid);
    expect(r.internalUseMilli).toBe(2000);
    expect(r.wasteMilli).toBe(0);
    expect(r.adjustMilli).toBe(0);
    expect(r.openingMilli + r.inMilli - r.soldMilli + r.returnedMilli - r.wasteMilli - r.internalUseMilli + r.assembleMilli + r.adjustMilli).toBe(r.onHandMilli);
    expect(r.onHandMilli).toBe(18000);
    // P&L theo kênh liệt kê trong khoản chưa phân bổ
    const ch = (await api("owner", "GET", `${V}/reports/pnl-by-channel?from=${today}&to=${today}`)).body;
    expect(ch.unallocated.find((x: any) => x.category === "Xuất dùng nội bộ").amount).toBeGreaterThanOrEqual(100_000);
    // xuất file Excel nhập-xuất-tồn có cột mới
    const xl = await app.request(`${V}/exports/nhap-xuat-ton.xlsx?from=${today}&to=${today}`, { headers: { authorization: `Bearer ${await login("owner")}` } }, testEnv);
    expect(xl.status).toBe(200);
    expect((await xl.arrayBuffer()).byteLength).toBeGreaterThan(500);
  });

  it("người lập là thủ kho (không có quyền duyệt) → chờ duyệt; chủ duyệt xong mới trừ kho", async () => {
    const pid = await mkProduct("IU-APR");
    const lot = await receive(pid, 5, 20000);
    const doc = await internalDoc("warehouse");
    await api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { lotId: lot.id, qty: 1, unit: "kg" });
    const post = await api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/post`);
    expect(post.status).toBe(200);
    expect(post.body.status).toBe("pending_approval");
    expect((await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id = ?`).bind(lot.id).first<any>()).q).toBe(5000);
    const dec = await api("owner", "POST", `${V}/approvals/${post.body.approvalId}/decide`, { decision: "approved" });
    expect(dec.status).toBe(200);
    expect((await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id = ?`).bind(lot.id).first<any>()).q).toBe(4000);
    expect((await api("owner", "GET", `${V}/stock-docs/${doc.body.id}`)).body.status).toBe("posted");
  });

  it("giá trị vượt ngưỡng approval.internal_use_vnd → chờ duyệt kể cả người lập là quản lý", async () => {
    const pid = await mkProduct("IU-BIG");
    const lot = await receive(pid, 10, 100000);
    const doc = await internalDoc("manager");
    await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { lotId: lot.id, qty: 6, unit: "kg" }); // 600k > 500k
    const post = await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/post`);
    expect(post.body.status).toBe("pending_approval");
    expect(post.body.approvalReason).toContain("vượt ngưỡng");
  });

  it("kỳ đã khoá sổ → 423, không trừ kho", async () => {
    const pid = await mkProduct("IU-LOCK");
    const lot = await receive(pid, 5, 10000);
    const doc = await internalDoc("manager");
    await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { lotId: lot.id, qty: 1, unit: "kg" });
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, '2026-01-01T00:00:00Z', 1) ON CONFLICT(period) DO UPDATE SET locked_at = excluded.locked_at`).bind(vnPeriod()).run();
    try {
      const post = await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/post`);
      expect(post.status).toBe(423);
      expect(post.body.error.code).toBe("period_locked");
      expect((await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id = ?`).bind(lot.id).first<any>()).q).toBe(5000);
    } finally {
      await db().prepare(`UPDATE periods SET locked_at = NULL, locked_by = NULL WHERE period = ?`).bind(vnPeriod()).run();
    }
  });

  it("lô hết hạn không xuất dùng nội bộ được (chỉ qua phiếu hao hụt); thiếu tồn → 409", async () => {
    const pid = await mkProduct("IU-EXP");
    const lot = await receive(pid, 5, 10000, new Date(Date.now() + 86400_000).toISOString());
    await db().prepare(`UPDATE lots SET expires_at = ? WHERE id = ?`).bind(new Date(Date.now() - 86400_000).toISOString(), lot.id).run();
    const doc = await internalDoc("manager");
    const bad = await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { lotId: lot.id, qty: 1, unit: "kg" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("lot_expired");
    const none = await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { productId: pid, qty: 1, unit: "kg" });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("insufficient_stock");
  });

  it("đăng đồng thời hai lần chỉ trừ kho một lần", async () => {
    const pid = await mkProduct("IU-DUP");
    const lot = await receive(pid, 5, 10000);
    const doc = await internalDoc("manager");
    await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { lotId: lot.id, qty: 2, unit: "kg" });
    const rs = await Promise.all([1, 2].map(() => api("manager", "POST", `${V}/stock-docs/${doc.body.id}/post`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id = ?`).bind(lot.id).first<any>()).q).toBe(3000);
  });
});

async function fundBalance(id: number) {
  return (await api("owner", "GET", `${V}/funds`)).body.items.find((f: any) => f.id === id).balance as number;
}
/** Nạp tiền vào quỹ bằng phiếu thu trực tiếp (ngoài P&L: khoản mục 'transfer') cho test độc lập. */
async function topUp(fundId: number, amount: number) {
  const cat = await db().prepare(`SELECT id FROM cash_categories WHERE code = 'SO_DU_DAU_KY'`).first<any>();
  await db().prepare(`INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, status, period, created_by) VALUES (?, 'in', ?, ?, ?, 'posted', ?, 1)`)
    .bind(`TOP-${Math.random().toString(36).slice(2)}`, fundId, cat.id, amount, vnPeriod()).run();
}

describe("Chuyển tiền giữa các quỹ", () => {
  beforeAll(async () => {
    await db().prepare(`INSERT OR IGNORE INTO funds(id, store_id, code, name, type) VALUES (9, 1, 'COD', 'Chờ đối soát COD', 'cod_clearing')`).run();
    await topUp(1, 5_000_000);
  });

  it("tạo cặp phiếu chi/thu liên kết, đổi số dư hai quỹ, KHÔNG vào lãi lỗ, có audit", async () => {
    const p0 = await pnl();
    const day = vnDate();
    const d0 = (await api("owner", "GET", `${V}/reports/daily?day=${day}`)).body.cashFlow;
    const c0 = await fundBalance(1), b0 = await fundBalance(2);
    const r = await api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: 2, amount: 1_000_000, note: "Nộp tiền mặt cuối ngày" });
    expect(r.status).toBe(201);
    // Báo cáo cuối ngày: chuyển quỹ không làm tăng tổng thu/chi của cửa hàng, báo riêng ở `transfers`
    const d1 = (await api("owner", "GET", `${V}/reports/daily?day=${day}`)).body.cashFlow;
    expect(d1.in).toBe(d0.in);
    expect(d1.out).toBe(d0.out);
    expect(d1.transfers - (d0.transfers ?? 0)).toBe(1_000_000);
    expect(r.body).toMatchObject({ fromFundId: 1, toFundId: 2, amount: 1_000_000, status: "posted" });
    expect(r.body.code).toMatch(/^CQ-/);
    expect(await fundBalance(1)).toBe(c0 - 1_000_000);
    expect(await fundBalance(2)).toBe(b0 + 1_000_000);
    const vs = (await db().prepare(`SELECT * FROM cash_vouchers WHERE ref_type = 'fund_transfer' AND ref_id = ? ORDER BY id`).bind(r.body.id).all<any>()).results;
    expect(vs).toHaveLength(2);
    expect(vs.map((v) => [v.direction, v.fund_id, v.amount])).toEqual([["out", 1, 1_000_000], ["in", 2, 1_000_000]]);
    expect(r.body.outVoucherId).toBe(vs[0].id);
    expect(r.body.inVoucherId).toBe(vs[1].id);
    const p1 = await pnl();
    expect(p1.totalExpenses).toBe(p0.totalExpenses);
    expect(p1.netProfit).toBe(p0.netProfit);
    expect(p1.otherIncome.total).toBe(p0.otherIncome.total);
    const a = await db().prepare(`SELECT action FROM audit_log WHERE action = 'fund_transfer.create' AND entity_id = ?`).bind(r.body.code).first();
    expect(a).toBeTruthy();
    const list = await api("accountant", "GET", `${V}/fund-transfers`);
    expect(list.body.items.find((x: any) => x.id === r.body.id)).toMatchObject({ fromFundName: expect.any(String), outVoucherCode: expect.any(String) });
    // phiếu trong danh sách phiếu thu chi hiện đúng
    const vl = await api("accountant", "GET", `${V}/vouchers?fundId=2`);
    expect(vl.body.items.some((v: any) => v.id === vs[1].id && v.pnl_line === "transfer")).toBe(true);
  });

  it("kiểm tra đầu vào: cùng quỹ, quỹ chờ đối soát, thiếu số dư, quyền", async () => {
    const same = await api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: 1, amount: 1000 });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe("same_fund");
    const clr = await api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: 9, amount: 1000 });
    expect(clr.body.error.code).toBe("clearing_fund");
    const big = await api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 2, toFundId: 1, amount: 900_000_000 });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe("insufficient_fund");
    expect((await api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: 2, amount: 0 })).status).toBe(422);
    expect((await api("manager", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: 2, amount: 1000 })).status).toBe(403);
    expect((await api("cashier", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: 2, amount: 1000 })).status).toBe(403);
    expect((await api("warehouse", "GET", `${V}/fund-transfers`)).status).toBe(403);
  });

  it("kỳ đã khoá sổ → 423, không tạo phiếu nào", async () => {
    const n0 = (await db().prepare(`SELECT COUNT(*) n FROM fund_transfers`).first<any>()).n;
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, '2026-01-01T00:00:00Z', 1) ON CONFLICT(period) DO UPDATE SET locked_at = excluded.locked_at`).bind(vnPeriod()).run();
    try {
      const r = await api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: 2, amount: 1000 });
      expect(r.status).toBe(423);
      expect(r.body.error.code).toBe("period_locked");
    } finally {
      await db().prepare(`UPDATE periods SET locked_at = NULL, locked_by = NULL WHERE period = ?`).bind(vnPeriod()).run();
    }
    expect((await db().prepare(`SELECT COUNT(*) n FROM fund_transfers`).first<any>()).n).toBe(n0);
  });

  it("đảo phiếu chuyển đảo CẢ CẶP; không đảo từng phiếu riêng; đảo hai lần → 409", async () => {
    const c0 = await fundBalance(1), b0 = await fundBalance(2);
    const t = await api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: 2, amount: 300_000 });
    expect(t.status).toBe(201);
    const single = await api("accountant", "POST", `${V}/vouchers/${t.body.outVoucherId}/reverse`, { reason: "đảo lẻ" });
    expect(single.status).toBe(409);
    expect(single.body.error.code).toBe("managed_voucher");
    const p0 = await pnl();
    const rv = await api("accountant", "POST", `${V}/fund-transfers/${t.body.id}/reverse`, { reason: "Nhập nhầm số tiền" });
    expect(rv.status).toBe(200);
    expect(rv.body.status).toBe("reversed");
    expect(await fundBalance(1)).toBe(c0);
    expect(await fundBalance(2)).toBe(b0);
    const rvs = (await db().prepare(`SELECT reverses_id, direction, fund_id FROM cash_vouchers WHERE reverses_id IN (?, ?) ORDER BY reverses_id`).bind(t.body.outVoucherId, t.body.inVoucherId).all<any>()).results;
    expect(rvs).toEqual([
      { reverses_id: t.body.outVoucherId, direction: "in", fund_id: 1 },
      { reverses_id: t.body.inVoucherId, direction: "out", fund_id: 2 },
    ]);
    const p1 = await pnl();
    expect(p1.totalExpenses).toBe(p0.totalExpenses);
    expect(p1.netProfit).toBe(p0.netProfit);
    const again = await api("accountant", "POST", `${V}/fund-transfers/${t.body.id}/reverse`, { reason: "đảo lại" });
    expect(again.status).toBe(409);
    expect(await fundBalance(1)).toBe(c0);
  });

  it("đảo bị chặn khi quỹ nhận không còn đủ tiền để hoàn lại", async () => {
    await db().prepare(`INSERT OR IGNORE INTO funds(id, store_id, code, name, type) VALUES (8, 1, 'NH-TEST', 'Ngân hàng test', 'bank')`).run();
    const t = await api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: 8, amount: 200_000 });
    expect(t.status).toBe(201);
    const t2 = await api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 8, toFundId: 1, amount: 150_000 });
    expect(t2.status).toBe(201);
    const rv = await api("accountant", "POST", `${V}/fund-transfers/${t.body.id}/reverse`, { reason: "thử đảo" });
    expect(rv.status).toBe(422);
    expect(rv.body.error.code).toBe("insufficient_fund");
  });

  it("bấm đúp (cùng khoá) chỉ tạo một lần; hai lệnh song song vượt số dư chỉ một lệnh thành công", async () => {
    const key = "idem-" + Math.random().toString(36).slice(2);
    const n0 = (await db().prepare(`SELECT COUNT(*) n FROM fund_transfers`).first<any>()).n;
    const rs = await Promise.all([1, 2].map(() => api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 1, toFundId: 2, amount: 10_000, idempotencyKey: key })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await db().prepare(`SELECT COUNT(*) n FROM fund_transfers`).first<any>()).n).toBe(n0 + 1);

    await db().prepare(`INSERT OR IGNORE INTO funds(id, store_id, code, name, type) VALUES (7, 1, 'TM-PHU', 'Tiền mặt phụ', 'cash')`).run();
    await topUp(7, 1_000_000);
    const two = await Promise.all([1, 2].map(() => api("accountant", "POST", `${V}/fund-transfers`, { fromFundId: 7, toFundId: 2, amount: 800_000 })));
    expect(two.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await fundBalance(7)).toBe(200_000);
  });
});
