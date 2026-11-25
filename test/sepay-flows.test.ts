import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { seedShop } from "./shop-helpers";
import { reconcileSepay } from "../src/worker/services/sepay-reconcile";
import { ACCOUNT, db, enableSepay, event, hook, nextId, tx, vnNow, webOrder } from "./sepay-helpers";

beforeAll(async () => {
  await seedShop();
  await seedSales();
  await enableSepay();
});
afterEach(() => vi.restoreAllMocks());

const V = "/api/v1";
let custSeq = 0;
async function customerWithInvoices(amounts: number[]) {
  const r = await api("owner", "POST", `${V}/customers`, {
    name: `KH SePay ${++custSeq}`, type: "b2b", customerGroupId: 1, creditLimit: 100_000_000, paymentTermsDays: 15,
    contacts: [{ name: "Nhận", phone: "0900000001", isReceiver: true }], addresses: [{ label: "Kho", address: "1 Lê Lợi", isDefault: true }],
  });
  expect(r.status).toBe(201);
  const ids: { id: number; code: string }[] = [];
  for (const [i, a] of amounts.entries()) {
    const code = `HDS-T${custSeq}-${i}`;
    const ins = await db().prepare(`INSERT INTO invoices(code, customer_id, issue_date, due_date, subtotal, total) VALUES (?,?,?,?,?,?) RETURNING id`).bind(code, r.body.id, `2026-0${i + 1}-01`, `2026-0${i + 1}-15`, a, a).first<any>();
    ids.push({ id: ins.id, code });
  }
  return { customerId: r.body.id as number, invoices: ids };
}
const payCode = async (invoiceId: number) => {
  const r = await api("owner", "GET", `${V}/sepay/invoices/${invoiceId}/pay-info`);
  expect(r.status).toBe(200);
  return r.body;
};
const allocs = async (customerId: number) =>
  (await db().prepare(`SELECT a.invoice_id, a.amount, p.code pcode, p.method, p.ref, p.status, p.created_by FROM debt_allocations a JOIN debt_payments p ON p.id = a.payment_id WHERE p.partner_id = ? ORDER BY a.id`).bind(customerId).all<any>()).results;

describe("SePay: nợ khách sỉ", () => {
  it("mã hoá đơn + đúng số còn nợ → phiếu thu + gạch ĐÚNG hoá đơn đó (không theo cũ nhất), success:true", async () => {
    const c = await customerWithInvoices([300000, 500000]); // hoá đơn cũ 300k, hoá đơn mới 500k
    const info = await payCode(c.invoices[1].id);
    expect(info).toMatchObject({ available: true, amount: 500000, invoiceCode: c.invoices[1].code });
    expect(info.code).toMatch(/^HDS\d{8}$/);
    expect((await payCode(c.invoices[1].id)).code).toBe(info.code); // mã ổn định
    const t = tx(info.code, 500000);
    expect((await hook(t)).body).toEqual({ success: true });
    const rows = await allocs(c.customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoice_id: c.invoices[1].id, amount: 500000, method: "transfer", ref: `SEPAY:${t.id}`, status: "posted", created_by: 900 });
    const v = await db().prepare(`SELECT v.direction, v.amount, f.type FROM debt_payments p JOIN cash_vouchers v ON v.id = p.cash_voucher_id JOIN funds f ON f.id = v.fund_id WHERE p.partner_id = ?`).bind(c.customerId).first<any>();
    expect(v).toEqual({ direction: "in", amount: 500000, type: "bank" });
    expect(await event(t.id)).toMatchObject({ status: "matched", verdict: 1, kind: "b2b", ref_code: c.invoices[1].code });
    // gửi lại cùng id & khoản chuyển thứ hai cho hoá đơn đã trả
    expect((await hook(t)).body).toEqual({ success: true });
    expect(await allocs(c.customerId)).toHaveLength(1);
    const t2 = tx(info.code, 500000);
    expect((await hook(t2)).body).toEqual({ success: false });
    expect(await event(t2.id)).toMatchObject({ status: "refund_pending", reason: "already_paid" });
    expect(await allocs(c.customerId)).toHaveLength(1);
  });

  it("sai số tiền → unmatched; hai giao dịch song song cho một hoá đơn → chỉ một phiếu thu", async () => {
    const c = await customerWithInvoices([200000]);
    const info = await payCode(c.invoices[0].id);
    const bad = tx(info.code, 150000);
    expect((await hook(bad)).body).toEqual({ success: false });
    expect(await event(bad.id)).toMatchObject({ status: "unmatched", reason: "amount_mismatch" });
    expect(await allocs(c.customerId)).toHaveLength(0);
    const a = tx(info.code, 200000), b = tx(info.code, 200000);
    const [ra, rb] = await Promise.all([hook(a), hook(b)]);
    expect([ra.body.success, rb.body.success].sort()).toEqual([false, true]);
    expect(await allocs(c.customerId)).toHaveLength(1);
  });

  it("kỳ đã khoá sổ → unmatched (không mất tiền, xử lý tay sau), không phiếu thu", async () => {
    const c = await customerWithInvoices([100000]);
    const info = await payCode(c.invoices[0].id);
    const { vnPeriod } = await import("../src/worker/lib/time");
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1) ON CONFLICT(period) DO UPDATE SET locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(vnPeriod()).run();
    const t = tx(info.code, 100000);
    expect((await hook(t)).body).toEqual({ success: false });
    expect((await event(t.id)).status).toBe("unmatched");
    expect(String((await event(t.id)).reason)).toContain("period_locked");
    expect(await allocs(c.customerId)).toHaveLength(0);
    await db().prepare(`UPDATE periods SET locked_at = NULL WHERE period = ?`).bind(vnPeriod()).run();
  });
});

describe("SePay: QR tại quầy POS", () => {
  const line = { productId: 1, unit: "kg", qty: 1 };
  it("tạo mã QR → webhook đúng tiền → trạng thái paid → thanh toán đơn bằng mã (một lần)", async () => {
    expect((await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 })).status).toBe(201);
    const q = await api("cashier", "POST", `${V}/pos/qr-requests`, { amount: 100000 });
    expect(q.status).toBe(201);
    expect(q.body.code).toMatch(/^POS\d{8}$/);
    expect(q.body.qrPayload).toContain(q.body.code);
    expect((await api("cashier", "GET", `${V}/pos/qr-requests/${q.body.id}`)).body.status).toBe("pending");
    // chưa nhận tiền: không thanh toán QR bằng tay được
    const early = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: "uuid-qr-early-1", lines: [line], payments: [{ method: "qr", amount: 100000, qrRequestId: q.body.id }] });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe("qr_not_confirmed");
    const noRef = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: "uuid-qr-early-2", lines: [line], payments: [{ method: "qr", amount: 100000 }] });
    expect(noRef.body.error.code).toBe("qr_not_confirmed");

    const t = tx(q.body.code, 100000);
    expect((await hook(t)).body).toEqual({ success: true });
    const st = await api("cashier", "GET", `${V}/pos/qr-requests/${q.body.id}`);
    expect(st.body).toMatchObject({ status: "paid", amount: 100000 });
    expect((await api("manager", "GET", `${V}/pos/qr-requests/${q.body.id}`)).status).toBe(404); // chỉ thu ngân tạo mã xem được

    const wrongAmt = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: "uuid-qr-wrong", lines: [line], payments: [{ method: "qr", amount: 90000, qrRequestId: q.body.id }, { method: "cash", amount: 10000 }] });
    expect(wrongAmt.status).toBe(422); // số tiền QR trong đơn khác số tiền mã đã nhận → không dùng
    const ok = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: "uuid-qr-ok-0001", lines: [line], payments: [{ method: "qr", amount: 100000, qrRequestId: q.body.id }] });
    expect(ok.status).toBe(201);
    expect(ok.body.payments.find((p: any) => p.method === "qr")).toMatchObject({ amount: 100000, ref: q.body.code });
    expect((await api("cashier", "GET", `${V}/pos/qr-requests/${q.body.id}`)).body.status).toBe("used");
    const again = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: "uuid-qr-again-1", lines: [line], payments: [{ method: "qr", amount: 100000, qrRequestId: q.body.id }] });
    expect(again.body.error.code).toBe("qr_not_confirmed");
    // chuyển lần hai vào cùng mã → chờ hoàn
    const t2 = tx(q.body.code, 100000);
    expect((await hook(t2)).body).toEqual({ success: false });
    expect(await event(t2.id)).toMatchObject({ status: "refund_pending", reason: "already_paid" });
  });

  it("sai tiền → unmatched; mã hết hạn / bị huỷ → chờ hoàn", async () => {
    const a = (await api("cashier", "POST", `${V}/pos/qr-requests`, { amount: 120000 })).body;
    const t1 = tx(a.code, 119000);
    expect((await hook(t1)).body).toEqual({ success: false });
    expect(await event(t1.id)).toMatchObject({ status: "unmatched", reason: "amount_mismatch" });
    expect((await api("cashier", "GET", `${V}/pos/qr-requests/${a.id}`)).body.status).toBe("pending");
    await db().prepare(`UPDATE pos_qr_requests SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?`).bind(a.id).run();
    const t2 = tx(a.code, 120000);
    expect((await hook(t2)).body).toEqual({ success: false });
    expect(await event(t2.id)).toMatchObject({ status: "refund_pending", reason: "qr_expired" });
    expect((await api("cashier", "GET", `${V}/pos/qr-requests/${a.id}`)).body.status).toBe("expired");
    const b = (await api("cashier", "POST", `${V}/pos/qr-requests`, { amount: 50000 })).body;
    const c = (await api("cashier", "POST", `${V}/pos/qr-requests`, { amount: 60000 })).body; // mã mới thay mã cũ
    expect((await api("cashier", "GET", `${V}/pos/qr-requests/${b.id}`)).body.status).toBe("cancelled");
    const t3 = tx(b.code, 50000);
    expect((await hook(t3)).body).toEqual({ success: false });
    expect(await event(t3.id)).toMatchObject({ status: "refund_pending", reason: "qr_cancelled" });
    expect(c.status).toBe("pending");
  });

  it("tắt luồng POS: thanh toán QR như cũ (thu ngân tự xác nhận)", async () => {
    await enableSepay({ "sepay.flow_pos": "0" });
    const r = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: "uuid-qr-legacy-1", lines: [line], payments: [{ method: "qr", amount: 100000, ref: "FT999" }] });
    expect(r.status).toBe(201);
    await enableSepay({ "sepay.flow_pos": "1" });
  });
});

describe("SePay: xử lý tay (chưa khớp / chờ hoàn)", () => {
  it("phân quyền: chỉ finance xem/làm; thu ngân đọc được cấu hình POS tối thiểu", async () => {
    expect((await api("cashier", "GET", `${V}/pos/sepay-config`)).body).toEqual({ enabled: true, flow: { pos: true } });
    expect((await api("cashier", "GET", `${V}/sepay/config`)).status).toBe(403);
    expect((await api("accountant", "GET", `${V}/sepay/config`)).status).toBe(200);
    expect((await api("cashier", "GET", `${V}/sepay/events`)).status).toBe(403);
    expect((await api("accountant", "GET", `${V}/sepay/events`)).status).toBe(200);
    expect((await api("cashier", "POST", `${V}/sepay/events/1/resolve`, { action: "ignored", reason: "xxx" })).status).toBe(403);
    expect((await api("cashier", "POST", `${V}/sepay/reconcile`)).status).toBe(403);
  });

  it("gán tay vào hoá đơn sỉ (chuyển thiếu), vào đơn web; đánh dấu đã hoàn / bỏ qua kèm lý do; không xử lý hai lần", async () => {
    const c = await customerWithInvoices([400000]);
    const part = tx("HDS99999999", 150000);
    await hook(part);
    expect((await event(part.id)).status).toBe("unmatched");
    const ev = await event(part.id);
    expect((await api("accountant", "POST", `${V}/sepay/events/${ev.id}/assign`, { kind: "b2b", code: c.invoices[0].code, note: "KH báo chuyển thiếu" })).status).toBe(200);
    expect(await event(part.id)).toMatchObject({ status: "matched", verdict: 1, reason: "manual", kind: "b2b", ref_code: c.invoices[0].code, resolution: "KH báo chuyển thiếu" });
    expect((await allocs(c.customerId))[0]).toMatchObject({ invoice_id: c.invoices[0].id, amount: 150000 });
    expect((await api("accountant", "POST", `${V}/sepay/events/${ev.id}/assign`, { kind: "b2b", code: c.invoices[0].code, note: "lần hai" })).status).toBe(409);
    expect((await hook(part)).body).toEqual({ success: true }); // gửi lại id cũ: phán quyết sau khi gán tay

    // gán đơn web: sai số tiền bị chặn, đúng số tiền thì được
    const o = await webOrder();
    const lost = tx("DH000000099999", o.total);
    await hook(lost);
    const le = await event(lost.id);
    const bad = await api("accountant", "POST", `${V}/sepay/events/${le.id}/assign`, { kind: "web", code: "DH-KHONG-CO", note: "thử mã sai" });
    expect(bad.status).toBe(422);
    expect((await api("accountant", "POST", `${V}/sepay/events/${le.id}/assign`, { kind: "web", code: o.code, note: "khách ghi nhầm mã" })).status).toBe(200);
    expect((await db().prepare(`SELECT payment_status FROM orders WHERE code=?`).bind(o.code).first<any>()).payment_status).toBe("paid");
    const audit = await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='sepay.assign' AND entity_id=?`).bind(String(le.id)).first<any>();
    expect(audit.n).toBe(1);

    const o2 = await webOrder();
    const wrongAmt = tx("DH000000088888", o2.total - 5000);
    await hook(wrongAmt);
    const we = await event(wrongAmt.id);
    expect((await api("accountant", "POST", `${V}/sepay/events/${we.id}/assign`, { kind: "web", code: o2.code, note: "thử" })).body.error.code).toBe("amount_mismatch");
    expect((await api("accountant", "POST", `${V}/sepay/events/${we.id}/resolve`, { action: "refunded", reason: "x" })).status).toBe(422); // lý do tối thiểu 3 ký tự
    expect((await api("accountant", "POST", `${V}/sepay/events/${we.id}/resolve`, { action: "refunded", reason: "Đã hoàn qua Internet Banking" })).status).toBe(200);
    expect(await event(wrongAmt.id)).toMatchObject({ status: "refunded", resolution: "Đã hoàn qua Internet Banking" });
    expect((await api("accountant", "POST", `${V}/sepay/events/${we.id}/resolve`, { action: "ignored", reason: "hai lần" })).status).toBe(409);
    const list = await api("accountant", "GET", `${V}/sepay/events?status=refunded`);
    expect(list.body.items.map((i: any) => i.id)).toContain(we.id);
    expect(list.body.items[0].accountNumber).toBe("***6789");
    const pending = await api("accountant", "GET", `${V}/sepay/events`);
    expect(pending.body.items.every((i: any) => ["unmatched", "refund_pending"].includes(i.status))).toBe(true);
  });
});

describe("SePay: đối soát (SEPAY_API_KEY, mock fetch)", () => {
  const apiRow = (id: string, code: string | null, amount: number, over: Record<string, unknown> = {}) => ({
    id, transaction_date: vnNow(), account_number: ACCOUNT, transfer_type: "in", amount_in: amount, transaction_content: `${code} CK`, reference_number: `FT${id}`, code, bank_brand_name: "Vietcombank", ...over,
  });
  const mockApi = (pages: unknown[][]) => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      urls.push(String(input));
      expect(init?.headers?.authorization).toBe("Bearer key-gia");
      const n = Number(new URL(String(input)).searchParams.get("page") ?? 1);
      const rows = pages[n - 1] ?? [];
      return new Response(JSON.stringify({ status: "success", data: rows, meta: { pagination: { has_more: n < pages.length } } }), { headers: { "content-type": "application/json" } });
    });
    return urls;
  };
  const env = { ...testEnv, SEPAY_API_KEY: "key-gia" } as any;

  it("không có SEPAY_API_KEY hoặc SePay tắt → không làm gì, không gọi mạng", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect((await reconcileSepay({ ...testEnv, SEPAY_API_KEY: undefined } as any)).skipped).toBe("no_api_key");
    await enableSepay({ "sepay.enabled": "0" });
    expect((await reconcileSepay(env)).skipped).toBe("disabled");
    await enableSepay();
    expect(spy).not.toHaveBeenCalled();
  });

  it("bỏ qua giao dịch webhook đã xử lý, xử lý giao dịch bị lỡ, lưu con trỏ, chạy lại không xử lý lại", async () => {
    const seen = await webOrder(); // đã được webhook xử lý
    const missed = await webOrder(); // webhook bị lỡ
    const tSeen = tx(seen.code, seen.total, { referenceCode: "FTSEEN1" });
    expect((await hook(tSeen)).body).toEqual({ success: true });
    const urls = mockApi([
      [
        apiRow("11111111-aaaa", seen.code, seen.total, { transaction_date: tSeen.transactionDate, reference_number: "FTSEEN1" }),
        apiRow("22222222-bbbb", missed.code, missed.total),
        apiRow("33333333-cccc", "DH000000077777", 1000), // mã lạ
      ],
    ]);
    const r = await reconcileSepay(env, { pauseMs: 0 });
    expect(r).toMatchObject({ fetched: 3, duplicates: 1, processed: 2 });
    expect((await db().prepare(`SELECT payment_status FROM orders WHERE code=?`).bind(missed.code).first<any>()).payment_status).toBe("paid");
    expect((await db().prepare(`SELECT COUNT(*) n FROM payments WHERE order_id=(SELECT id FROM orders WHERE code=?)`).bind(seen.code).first<any>()).n).toBe(1);
    expect(await db().prepare(`SELECT status, source FROM sepay_events WHERE api_id='22222222-bbbb'`).first()).toEqual({ status: "matched", source: "reconcile" });
    expect((await event(tSeen.id)).api_id).toBe("11111111-aaaa"); // nhận ra cùng giao dịch, gắn UUID
    expect((await db().prepare(`SELECT value FROM sepay_state WHERE key='api_cursor'`).first<any>()).value).toBe("33333333-cccc");
    expect(urls[0]).toContain("transaction_date_from=");

    // lần sau dùng since_id; trả lại cùng dòng thì không xử lý lại
    const urls2 = mockApi([[apiRow("22222222-bbbb", missed.code, missed.total)]]);
    const r2 = await reconcileSepay(env, { pauseMs: 0 });
    expect(r2.processed).toBe(0);
    expect(urls2[0]).toContain("since_id=33333333-cccc");
    expect((await db().prepare(`SELECT COUNT(*) n FROM payments WHERE order_id=(SELECT id FROM orders WHERE code=?)`).bind(missed.code).first<any>()).n).toBe(1);

    // webhook đến muộn cho giao dịch đối soát đã xử lý → cùng phán quyết (success:true), không thanh toán lần hai
    const late = tx(missed.code, missed.total, { transactionDate: (await db().prepare(`SELECT txn_at FROM sepay_events WHERE api_id='22222222-bbbb'`).first<any>()).txn_at && vnNow(), referenceCode: "FT22222222-bbbb" });
    const row = await db().prepare(`SELECT txn_at FROM sepay_events WHERE api_id='22222222-bbbb'`).first<any>();
    late.transactionDate = new Date(new Date(row.txn_at).getTime() + 7 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
    expect((await hook(late)).body).toEqual({ success: true });
    expect((await db().prepare(`SELECT COUNT(*) n FROM payments WHERE order_id=(SELECT id FROM orders WHERE code=?)`).bind(missed.code).first<any>()).n).toBe(1);
    expect((await event(late.id)).api_id).toBe("22222222-bbbb");
  });

  it("phân trang và API lỗi: ném lỗi, giữ con trỏ", async () => {
    const o1 = await webOrder(), o2 = await webOrder();
    const page = (n: number) => Array.from({ length: n }, (_, i) => apiRow(`p-${nextId()}-${i}`, i === 0 ? o1.code : null, o1.total));
    const urls = mockApi([page(100), [apiRow("last-1", o2.code, o2.total)]]);
    const r = await reconcileSepay(env, { pauseMs: 0 });
    expect(r.fetched).toBe(101);
    expect(urls).toHaveLength(2);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 500 }));
    await expect(reconcileSepay(env, { pauseMs: 0 })).rejects.toThrow("sepay_api_500");
    expect((await db().prepare(`SELECT value FROM sepay_state WHERE key='api_cursor'`).first<any>()).value).toBe("last-1");
  });
});
