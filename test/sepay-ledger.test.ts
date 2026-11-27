/**
 * SePay × sổ quỹ. Bất biến chính: Σ tiền SePay báo về (đúng tài khoản) − Σ đã hoàn = mức tăng số dư quỹ ngân hàng.
 * Mỗi kịch bản kiểm lại bất biến; khoản chờ "Chuyển khoản chờ xử lý" không đổi lãi lỗ.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { seedShop } from "./shop-helpers";
import { reconcileSepay } from "../src/worker/services/sepay-reconcile";
import { vnPeriod } from "../src/worker/lib/time";
import { FUND_ORDER_OK } from "../src/worker/services/fund-sql";
import { ACCOUNT, db, enableSepay, event, hook, tx, vnNow, webOrder } from "./sepay-helpers";

const V = "/api/v1";
let baseline = 0; // số dư quỹ ngân hàng khi bắt đầu
let received = 0; // Σ tiền SePay báo về (đúng tài khoản)
let refunded = 0; // Σ đã hoàn
let bankId = 0;

beforeAll(async () => {
  await seedShop();
  await seedSales();
  await enableSepay();
  await db().prepare(`INSERT OR IGNORE INTO cash_categories(code, name, direction, pnl_line) VALUES ('THU_KHAC','Thu khác','in','other')`).run();
  bankId = (await db().prepare(`SELECT id FROM funds WHERE type='bank' AND active=1 ORDER BY id LIMIT 1`).first<{ id: number }>())!.id;
  baseline = await balance();
});
afterEach(() => vi.restoreAllMocks());

async function balance() {
  const r = await db()
    .prepare(
      `SELECT COALESCE((SELECT SUM(p.amount) FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.fund_id = ?1 AND p.status='confirmed' AND ${FUND_ORDER_OK}),0)
            + COALESCE((SELECT SUM(CASE WHEN v.direction='in' THEN v.amount ELSE -v.amount END) FROM cash_vouchers v WHERE v.fund_id = ?1 AND v.status='posted'),0) AS b`,
    )
    .bind(bankId)
    .first<{ b: number }>();
  return r!.b;
}
/** Bất biến chính. */
const invariant = async () => expect((await balance()) - baseline).toBe(received - refunded);
const recv = (n: number) => { received += n; };
const holdBal = async () => (await api("accountant", "GET", `${V}/sepay/hold`)).body.summary.balance as number;
const vouchersOf = async (eventId: number) =>
  (await db().prepare(`SELECT v.code, v.direction, v.amount, v.created_at, v.period, v.note, cc.code AS cat, cc.pnl_line FROM cash_vouchers v JOIN cash_categories cc ON cc.id = v.category_id WHERE v.ref_type='sepay_event' AND v.ref_id = ? ORDER BY v.id`).bind(eventId).all<any>()).results;
const pnl = async () => (await api("owner", "GET", `${V}/reports/pnl?from=2020-01-01&to=2099-12-31`)).body;
const cashFlow = async () => (await api("owner", "GET", `${V}/reports/cash-flow?from=2020-01-01&to=2099-12-31`)).body;

let custSeq = 0;
async function customerWithInvoice(amount: number) {
  const r = await api("owner", "POST", `${V}/customers`, {
    name: `KH Quỹ ${++custSeq}`, type: "b2b", customerGroupId: 1, creditLimit: 100_000_000, paymentTermsDays: 15,
    contacts: [{ name: "Nhận", phone: "0900000002", isReceiver: true }], addresses: [{ label: "Kho", address: "1 Lê Lợi", isDefault: true }],
  });
  const code = `HDS-Q${custSeq}`;
  const inv = await db().prepare(`INSERT INTO invoices(code, customer_id, issue_date, due_date, subtotal, total) VALUES (?,?,?,?,?,?) RETURNING id`).bind(code, r.body.id, "2026-01-01", "2026-01-15", amount, amount).first<any>();
  return { id: inv.id as number, code, customerId: r.body.id as number };
}

describe("SePay × sổ quỹ: khớp ngay (không qua khoản chờ)", () => {
  it("đơn web DH và hoá đơn sỉ HDS: quỹ tăng đúng một lần, khoản chờ 0", async () => {
    const o = await webOrder();
    const t = tx(o.code, o.total);
    expect((await hook(t)).body).toEqual({ success: true });
    recv(o.total);
    await invariant();
    const inv = await customerWithInvoice(250_000);
    const pc = (await api("owner", "GET", `${V}/sepay/invoices/${inv.id}/pay-info`)).body;
    const t2 = tx(pc.code, 250_000);
    expect((await hook(t2)).body).toEqual({ success: true });
    recv(250_000);
    await invariant();
    expect(await holdBal()).toBe(0);
    expect(await vouchersOf((await event(t.id)).id)).toHaveLength(0);
    expect(await vouchersOf((await event(t2.id)).id)).toHaveLength(0);
  });
});

describe("SePay × sổ quỹ: chưa khớp", () => {
  it("chưa khớp → phiếu thu vào khoản chờ (không vào lãi lỗ); gửi lại webhook không ghi lần hai; gán đơn → chuyển ra, quỹ không đổi lần hai", async () => {
    const p0 = await pnl();
    const cf0 = await cashFlow();
    const o = await webOrder();
    const t = tx("DH000000012345", o.total); // mã lạ
    expect((await hook(t)).body).toEqual({ success: false });
    recv(o.total);
    await invariant();
    const ev = await event(t.id);
    expect(ev.hold_in_voucher_id).toBeTruthy();
    expect(await vouchersOf(ev.id)).toMatchObject([{ direction: "in", amount: o.total, cat: "CK_CHO_XL", pnl_line: "transfer" }]);
    expect(await holdBal()).toBe(o.total);
    expect(await pnl()).toEqual(p0); // khoản chờ không đổi lãi lỗ
    // webhook gửi lại cùng id
    await hook(t); await hook(t);
    expect(await vouchersOf(ev.id)).toHaveLength(1);
    await invariant();

    // gán đơn: payments của đơn + phiếu chi khỏi khoản chờ cùng lúc
    const res = await api("accountant", "POST", `${V}/sepay/events/${ev.id}/assign`, { kind: "web", code: o.code, note: "khách ghi nhầm mã" });
    expect(res.status).toBe(200);
    await invariant();
    expect(await holdBal()).toBe(0);
    const vs = await vouchersOf(ev.id);
    expect(vs.map((v: any) => [v.direction, v.cat])).toEqual([["in", "CK_CHO_XL"], ["out", "CK_CHO_XL_RA"]]);
    expect(await pnl()).toEqual(p0);
    // báo cáo dòng tiền: tiền vào chỉ tính MỘT lần (phiếu chờ + thanh toán đơn − phiếu chi khỏi chờ), không thành tiền ra
    const cf1 = await cashFlow();
    expect(cf1.totalInflow - cf0.totalInflow).toBe(o.total);
    expect(cf1.totalOutflow - cf0.totalOutflow).toBe(0);
    // hai người cùng bấm Gán: lần hai 409, không thêm phiếu
    const again = await api("accountant", "POST", `${V}/sepay/events/${ev.id}/assign`, { kind: "web", code: o.code, note: "lần hai" });
    expect(again.status).toBe(409);
    expect(await vouchersOf(ev.id)).toHaveLength(2);
    await invariant();
  });

  it("gán vào hoá đơn sỉ: phiếu thu công nợ + chi khỏi khoản chờ cùng batch", async () => {
    const inv = await customerWithInvoice(400_000);
    const t = tx("HDS11112222", 150_000); // mã HDS lạ → chưa khớp
    await hook(t);
    recv(150_000);
    await invariant();
    const ev = await event(t.id);
    expect((await api("accountant", "POST", `${V}/sepay/events/${ev.id}/assign`, { kind: "b2b", code: inv.code, note: "KH báo chuyển thiếu" })).status).toBe(200);
    await invariant();
    expect(await holdBal()).toBe(0);
  });

  it("chưa khớp → đã hoàn: phiếu chi hoàn tiền khỏi quỹ; mức tăng ròng = vào − hoàn", async () => {
    const t = tx("DH000000054321", 333_000);
    await hook(t);
    recv(333_000);
    await invariant();
    const ev = await event(t.id);
    expect((await api("cashier", "POST", `${V}/sepay/events/${ev.id}/resolve`, { action: "refunded", reason: "Đã hoàn qua Internet Banking" })).status).toBe(403);
    const r = await api("accountant", "POST", `${V}/sepay/events/${ev.id}/resolve`, { action: "refunded", reason: "Đã hoàn qua Internet Banking", refundRef: "FTHOAN123" });
    expect(r.status).toBe(200);
    refunded += 333_000;
    await invariant();
    expect(await holdBal()).toBe(0);
    const vs = await vouchersOf(ev.id);
    expect(vs[1]).toMatchObject({ direction: "out", cat: "CK_CHO_XL_RA", amount: 333_000 });
    expect(vs[1].note).toContain("FTHOAN123");
    expect((await api("accountant", "POST", `${V}/sepay/events/${ev.id}/resolve`, { action: "refunded", reason: "hai lần" })).status).toBe(409);
    await invariant();
  });

  it("chờ hoàn (đơn đã thanh toán) → bỏ qua: bắt buộc chọn khoản mục thu hoặc giữ ở khoản chờ; tiền không biến mất khỏi sổ", async () => {
    const o = await webOrder();
    await hook(tx(o.code, o.total));
    recv(o.total);
    const dup = tx(o.code, o.total); // chuyển lần hai → chờ hoàn
    await hook(dup);
    recv(o.total);
    const ev = await event(dup.id);
    expect(ev.status).toBe("refund_pending");
    await invariant();
    const noChoice = await api("accountant", "POST", `${V}/sepay/events/${ev.id}/resolve`, { action: "ignored", reason: "để sau" });
    expect(noChoice.status).toBe(422);
    expect(noChoice.body.error.code).toBe("category_required");
    const transferCat = (await db().prepare(`SELECT id FROM cash_categories WHERE code='CK_CHO_XL'`).first<any>()).id;
    expect((await api("accountant", "POST", `${V}/sepay/events/${ev.id}/resolve`, { action: "ignored", reason: "x", categoryId: transferCat })).status).toBe(422);
    const other = (await db().prepare(`SELECT id FROM cash_categories WHERE code='THU_KHAC'`).first<any>()).id;
    expect((await api("accountant", "POST", `${V}/sepay/events/${ev.id}/resolve`, { action: "ignored", reason: "Khách tặng thêm", categoryId: other })).status).toBe(200);
    await invariant();
    expect(await holdBal()).toBe(0);
    expect((await vouchersOf(ev.id)).map((v: any) => v.cat)).toEqual(["CK_CHO_XL", "CK_CHO_XL_RA", "THU_KHAC"]);

    // giữ ở khoản chờ (kèm lý do)
    const t = tx("KHONGMA", 77_000, { code: null });
    await hook(t);
    recv(77_000);
    const e2 = await event(t.id);
    expect((await api("accountant", "POST", `${V}/sepay/events/${e2.id}/resolve`, { action: "ignored", reason: "Chờ kế toán đối chiếu", keepInHold: true })).status).toBe(200);
    await invariant();
    expect(await holdBal()).toBe(77_000);
    expect(await vouchersOf(e2.id)).toHaveLength(1);
  });

  it("không phải tiền vào tài khoản cửa hàng (sai tài khoản, tiền ra, SePay tắt) → không phiếu quỹ", async () => {
    const wrong = tx("DH000000000001", 10_000, { accountNumber: "9999999999" });
    const out = tx(null, 20_000, { transferType: "out", code: null });
    await hook(wrong); await hook(out);
    expect((await event(wrong.id)).hold_in_voucher_id).toBeNull();
    expect((await event(out.id)).hold_in_voucher_id).toBeNull();
    await enableSepay({ "sepay.enabled": "0" });
    const off = tx("DH000000000002", 30_000);
    await hook(off);
    await enableSepay();
    expect((await event(off.id)).hold_in_voucher_id).toBeNull();
    await invariant();
  });
});

describe("SePay × sổ quỹ: QR tại quầy", () => {
  const line = { productId: 1, unit: "kg", qty: 1 };
  it("khách đã chuyển → vào khoản chờ ngay; hoàn tất đơn bằng QR → payment + chi khỏi khoản chờ (không cộng hai lần)", async () => {
    await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 });
    const h0 = await holdBal();
    const q = (await api("cashier", "POST", `${V}/pos/qr-requests`, { amount: 100_000 })).body;
    const t = tx(q.code, 100_000);
    expect((await hook(t)).body).toEqual({ success: true });
    recv(100_000);
    await invariant();
    const ev = await event(t.id);
    expect(await holdBal()).toBe(h0 + 100_000);
    expect(await vouchersOf(ev.id)).toHaveLength(1);
    const ok = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: `uuid-ledger-${Date.now()}`, lines: [line], payments: [{ method: "qr", amount: 100_000, qrRequestId: q.id }] });
    expect(ok.status).toBe(201);
    await invariant();
    expect(await holdBal()).toBe(h0);
    expect((await vouchersOf(ev.id)).map((v: any) => v.cat)).toEqual(["CK_CHO_XL", "CK_CHO_XL_RA"]);
  });

  it("khách đã chuyển nhưng đơn không hoàn tất (huỷ mã / hết ca): tiền vẫn nằm ở khoản chờ; chuyển trễ vào mã hết hạn cũng vào khoản chờ", async () => {
    const h0 = await holdBal();
    const q = (await api("cashier", "POST", `${V}/pos/qr-requests`, { amount: 120_000 })).body;
    const t = tx(q.code, 120_000);
    await hook(t);
    recv(120_000);
    await api("cashier", "POST", `${V}/pos/qr-requests/${q.id}/cancel`); // mã đã paid nên không huỷ được; vẫn ở khoản chờ
    await invariant();
    expect(await holdBal()).toBe(h0 + 120_000);
    const q2 = (await api("cashier", "POST", `${V}/pos/qr-requests`, { amount: 50_000 })).body;
    await db().prepare(`UPDATE pos_qr_requests SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?`).bind(q2.id).run();
    const t2 = tx(q2.code, 50_000);
    expect((await hook(t2)).body).toEqual({ success: false });
    recv(50_000);
    await invariant();
    expect(await holdBal()).toBe(h0 + 170_000);
    // chờ hoàn (QR hết hạn) → đã hoàn: ra khỏi khoản chờ; QR đã nhận nhưng chưa tạo đơn vẫn nằm ở khoản chờ cho kế toán
    const e2 = await event(t2.id);
    expect((await api("accountant", "POST", `${V}/sepay/events/${e2.id}/resolve`, { action: "refunded", reason: "Hoàn khách QR hết hạn" })).status).toBe(200);
    refunded += 50_000;
    expect(await holdBal()).toBe(h0 + 120_000);
    await invariant();
  });
});

describe("SePay × sổ quỹ: đối soát cron", () => {
  const env = { ...testEnv, SEPAY_API_KEY: "key-gia" } as any;
  const apiRow = (id: string, code: string | null, amount: number, over: Record<string, unknown> = {}) => ({
    id, transaction_date: vnNow(), account_number: ACCOUNT, transfer_type: "in", amount_in: amount, transaction_content: `${code} CK`, reference_number: `FT${id}`, code, bank_brand_name: "Vietcombank", ...over,
  });
  const mockApi = (rows: unknown[]) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "success", data: rows, meta: { pagination: { has_more: false } } }), { headers: { "content-type": "application/json" } }));

  it("đối soát gặp lại giao dịch webhook đã nhận: không phiếu thứ hai; giao dịch bị lỡ chưa khớp vẫn vào khoản chờ đúng một lần", async () => {
    const t = tx("KHACLA9", 61_000);
    await hook(t);
    recv(61_000);
    const ev = await event(t.id);
    mockApi([apiRow("ledger-aaaa", "KHACLA9", 61_000, { transaction_date: t.transactionDate, reference_number: t.referenceCode }), apiRow("ledger-bbbb", "KHACLB9", 72_000)]);
    await reconcileSepay(env, { pauseMs: 0 });
    recv(72_000);
    expect(await vouchersOf(ev.id)).toHaveLength(1);
    const lost = await db().prepare(`SELECT id, hold_in_voucher_id FROM sepay_events WHERE api_id='ledger-bbbb'`).first<any>();
    expect(lost.hold_in_voucher_id).toBeTruthy();
    expect(await vouchersOf(lost.id)).toHaveLength(1);
    await invariant();
    mockApi([apiRow("ledger-bbbb", "KHACLB9", 72_000)]);
    await reconcileSepay(env, { pauseMs: 0 });
    expect(await vouchersOf(lost.id)).toHaveLength(1);
    await invariant();
  });
});

describe("SePay × sổ quỹ: nhập sao kê ngân hàng", () => {
  const today = () => vnNow().slice(0, 10);
  const imp = (csv: string) => api("accountant", "POST", `${V}/bank-transactions/import`, { fundId: bankIdOf(), csv });
  const bankIdOf = () => bankId;
  const bankRow = async (id: number) => db().prepare(`SELECT * FROM bank_transactions WHERE id = ?`).bind(id).first<any>();

  it("dòng sao kê trùng giao dịch SePay (tiền + ngày + tham chiếu) → đánh dấu đã ghi qua SePay, không phiếu thu mới; khớp tay 409", async () => {
    const o = await webOrder();
    const matched = tx(o.code, o.total, { referenceCode: "FTSTMT001" });
    await hook(matched);
    recv(o.total);
    const orphan = tx("KHONGMA", 91_000, { referenceCode: "FTSTMT002", code: null });
    await hook(orphan);
    recv(91_000);
    const before = await balance();
    const payBefore = (await db().prepare(`SELECT COUNT(*) n FROM payments`).first<any>()).n;
    const vBefore = (await db().prepare(`SELECT COUNT(*) n FROM cash_vouchers`).first<any>()).n;
    const r = await imp(`date,amount,description,ref\n${today()},${o.total},CK ${o.code},FTSTMT001\n${today()},91000,chuyen khoan,FTSTMT002\n${today()},12345,tien le khong ro,FTSTMT003`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ imported: 3, sepayLinked: 2 });
    expect(r.body.items.map((i: any) => i.status)).toEqual(["matched", "matched", "unmatched"]);
    expect(await balance()).toBe(before); // không ghi quỹ lần hai
    expect((await db().prepare(`SELECT COUNT(*) n FROM payments`).first<any>()).n).toBe(payBefore);
    expect((await db().prepare(`SELECT COUNT(*) n FROM cash_vouchers`).first<any>()).n).toBe(vBefore);
    const row = await bankRow(r.body.items[0].id);
    expect(row).toMatchObject({ status: "matched", matched_type: "sepay", sepay_event_id: (await event(matched.id)).id });
    await invariant();
    // nhập lại cùng sao kê: trùng, không đổi gì
    expect((await imp(`date,amount,description,ref\n${today()},91000,chuyen khoan,FTSTMT002`)).body).toMatchObject({ imported: 0, duplicates: 1 });

    // sự kiện đã gắn một dòng: dòng thứ hai cùng tiền/ngày không còn ứng viên → chờ xử lý tay như thường
    const second = await imp(`date,amount,description,ref\n${today()},91000,chuyen khoan lai,FTSTMT009`);
    expect(second.body.items[0].status).toBe("unmatched");
    // mã tham chiếu cả hai có mà khác hẳn → không phải cùng giao dịch
    const diff = tx("KHONGMA3", 44_000, { referenceCode: "FTSTMT100", code: null });
    await hook(diff);
    recv(44_000);
    expect((await imp(`date,amount,description,ref\n${today()},44000,ck,FTBANKKHAC`)).body.items[0].status).toBe("unmatched");
  });

  it("nhiều ứng viên → không tự quyết; khớp tay tạo phiếu thu bị 409; chọn đúng giao dịch SePay thì liên kết (không phiếu mới)", async () => {
    const a = tx("KHONGMA4", 66_000, { referenceCode: "", code: null });
    const b = tx("KHONGMA5", 66_000, { referenceCode: "", code: null });
    await hook(a); await hook(b);
    recv(132_000);
    const ea = await event(a.id), eb = await event(b.id);
    const r = await imp(`date,amount,description\n${today()},66000,ck khong ro`);
    expect(r.body.items[0]).toMatchObject({ status: "unmatched", sepayCandidates: [ea.id, eb.id] });
    const id = r.body.items[0].id;
    const cust = await customerWithInvoice(66_000);
    const m = await api("accountant", "POST", `${V}/bank-transactions/${id}/match`, { partnerType: "customer", partnerId: cust.customerId });
    expect(m.status).toBe(409);
    expect(m.body.error.code).toBe("already_recorded_by_sepay");
    const before = await balance();
    const link = await api("accountant", "POST", `${V}/bank-transactions/${id}/match`, { sepayEventId: eb.id });
    expect(link.status).toBe(200);
    expect(await bankRow(id)).toMatchObject({ status: "matched", matched_type: "sepay", sepay_event_id: eb.id });
    expect(await balance()).toBe(before);
    // sự kiện còn lại tự khớp với dòng kế tiếp (chỉ còn một ứng viên)
    const r2 = await imp(`date,amount,description\n${today()},66000,ck khong ro 2`);
    expect(r2.body.items[0]).toMatchObject({ status: "matched", sepayEventId: ea.id });
    // liên kết sai (không phải ứng viên) bị từ chối
    const r3 = await imp(`date,amount,description\n${today()},777,le`);
    const bad = await api("accountant", "POST", `${V}/bank-transactions/${r3.body.items[0].id}/match`, { sepayEventId: ea.id });
    expect(bad.status).toBe(422);
    await invariant();
  });
});

describe("SePay × sổ quỹ: kỳ khoá và dữ liệu cũ", () => {
  const lock = (period: string, on: boolean) =>
    on
      ? db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1) ON CONFLICT(period) DO UPDATE SET locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(period).run()
      : db().prepare(`UPDATE periods SET locked_at = NULL WHERE period = ?`).bind(period).run();

  it("giao dịch của kỳ đã khoá → ghi vào ngày hiện tại và ghi rõ; kỳ chưa khoá → ghi đúng ngày giao dịch", async () => {
    const past = vnNow(-40 * 86400_000);
    const pastPeriod = past.slice(0, 7);
    const open = tx("KHONGMA6", 31_000, { code: null, transactionDate: past });
    await hook(open);
    recv(31_000);
    const vOpen = (await vouchersOf((await event(open.id)).id))[0];
    expect(vOpen.period).toBe(pastPeriod);
    expect(vOpen.created_at.slice(0, 10)).toBe(new Date(past.replace(" ", "T") + "+07:00").toISOString().slice(0, 10));
    await lock(pastPeriod, true);
    const locked = tx("KHONGMA7", 32_000, { code: null, transactionDate: past });
    await hook(locked);
    recv(32_000);
    const vLocked = (await vouchersOf((await event(locked.id)).id))[0];
    expect(vLocked.period).toBe(vnPeriod());
    expect(vLocked.note).toContain("đã khoá sổ");
    await lock(pastPeriod, false);
    await invariant();
  });

  it("kỳ hiện tại cũng khoá: sự kiện vẫn được lưu (không mất tiền), chưa có phiếu; mở khoá rồi ghi bằng thao tác 'ghi các giao dịch chờ cũ' (xem trước, phải khớp)", async () => {
    await lock(vnPeriod(), true);
    const t = tx("KHONGMA8", 18_000, { code: null });
    expect((await hook(t)).body).toEqual({ success: false });
    const ev = await event(t.id);
    expect(ev).toMatchObject({ status: "unmatched", hold_in_voucher_id: null });
    await lock(vnPeriod(), false);
    // dữ liệu cũ: sự kiện chưa khớp có từ trước migration (chưa phiếu)
    await db().prepare(`INSERT INTO sepay_events(sepay_id, source, txn_at, account_number, gateway, code, transfer_type, amount, reference_code, payload_json, status, verdict, reason) VALUES (?, 'webhook', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'Vietcombank', NULL, 'in', 25000, 'FTOLD1', '{}', 'unmatched', 0, 'no_code')`).bind(9_000_001, ACCOUNT).run();
    expect((await api("cashier", "GET", `${V}/sepay/ledger/backfill`)).status).toBe(403);
    const pre = (await api("accountant", "GET", `${V}/sepay/ledger/backfill`)).body;
    expect(pre).toMatchObject({ count: 2, amount: 43_000 });
    const wrong = await api("accountant", "POST", `${V}/sepay/ledger/backfill`, { expectedCount: 1, expectedAmount: 25_000 });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("preview_changed");
    const ok = await api("accountant", "POST", `${V}/sepay/ledger/backfill`, { expectedCount: pre.count, expectedAmount: pre.amount });
    expect(ok.body).toMatchObject({ posted: 2, skipped: 0, amount: 43_000 });
    recv(18_000); // giao dịch của kỳ khoá lúc nhận nay mới vào sổ
    received += 0;
    expect((await api("accountant", "GET", `${V}/sepay/ledger/backfill`)).body.count).toBe(0);
    expect((await api("accountant", "POST", `${V}/sepay/ledger/backfill`, { expectedCount: 0, expectedAmount: 0 })).body.posted).toBe(0);
    // sự kiện cũ (25.000) không nằm trong Σ tiền theo dõi của test → cộng vào để bất biến phản ánh đúng
    recv(25_000);
    await invariant();
  });

  it("gán đơn cho sự kiện chưa từng vào sổ (không có phiếu chờ) không rút tiền ra khỏi quỹ", async () => {
    const o = await webOrder();
    await db().prepare(`INSERT INTO sepay_events(sepay_id, source, txn_at, account_number, gateway, code, transfer_type, amount, reference_code, payload_json, status, verdict, reason) VALUES (?, 'webhook', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'Vietcombank', 'DH000000000999', 'in', ?, 'FTOLD2', '{}', 'unmatched', 0, 'unknown_code')`).bind(9_000_002, ACCOUNT, o.total).run();
    const ev = await event(9_000_002);
    expect((await api("accountant", "POST", `${V}/sepay/events/${ev.id}/assign`, { kind: "web", code: o.code, note: "sự kiện cũ" })).status).toBe(200);
    recv(o.total);
    await invariant();
    expect(await vouchersOf(ev.id)).toHaveLength(0);
  });
});
