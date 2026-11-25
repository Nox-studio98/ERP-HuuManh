import { beforeAll, describe, expect, it } from "vitest";
import { seedShop } from "./shop-helpers";
import { ACCOUNT, db, enableSepay, event, hook, nextId, tx, webOrder } from "./sepay-helpers";

beforeAll(async () => {
  await seedShop();
  await enableSepay();
});

const orderRow = (code: string) => db().prepare(`SELECT id, status, payment_status, paid_total FROM orders WHERE code = ?`).bind(code).first<any>();
const paymentCount = async (orderId: number) => (await db().prepare(`SELECT COUNT(*) n FROM payments WHERE order_id = ? AND status='confirmed'`).bind(orderId).first<any>()).n;

describe("SePay webhook: xác thực", () => {
  it("chữ ký sai / thiếu header / timestamp quá hạn → 401, không lưu gì", async () => {
    const o = await webOrder();
    const t = tx(o.code, o.total);
    expect((await hook(t, { sig: "sha256=" + "00".repeat(32) })).status).toBe(401);
    expect((await hook(t, { secret: "khac" })).status).toBe(401);
    expect((await hook(t, { noHeaders: true })).status).toBe(401);
    expect((await hook(t, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await hook(t, { ts: Math.floor(Date.now() / 1000) + 3600 })).status).toBe(401);
    expect(await event(t.id)).toBeNull();
    expect((await orderRow(o.code)).payment_status).not.toBe("paid");
  });

  it("chữ ký tính trên bytes gốc: sửa một byte của body thì bị từ chối", async () => {
    const o = await webOrder();
    const t = tx(o.code, o.total);
    const raw = JSON.stringify(t);
    const ts = Math.floor(Date.now() / 1000);
    const { sepaySign } = await import("../src/worker/services/sepay");
    const sig = await sepaySign("whsec_sepay_test", ts, raw);
    expect((await hook(t, { raw: raw.replace(String(o.total), String(o.total - 1)), sig, ts })).status).toBe(401);
  });

  it("secret rỗng → từ chối tất cả, kể cả chữ ký tính bằng khoá rỗng", async () => {
    const o = await webOrder();
    const t = tx(o.code, o.total);
    for (const secret of [undefined, ""]) {
      const r = await hook(t, { env: { SEPAY_WEBHOOK_SECRET: secret }, sig: "sha256=" + "00".repeat(32) });
      expect(r.status).toBe(503);
    }
    expect(await event(t.id)).toBeNull();
    expect((await orderRow(o.code)).payment_status).not.toBe("paid");
  });

  it("chữ ký đúng nhưng payload sai định dạng → 400/422, không phải success", async () => {
    const r = await hook({ id: "x" });
    expect([400, 422]).toContain(r.status);
    expect((await hook(null, { raw: "khong-phai-json" })).status).toBe(400);
  });
});

describe("SePay webhook: luồng đơn website", () => {
  it("đúng mã + đúng số tiền: đơn chờ thanh toán → mới, có payment quỹ ngân hàng, success:true, lưu phán quyết + referenceCode", async () => {
    const o = await webOrder();
    expect(o.code).toMatch(/^DH\d{12}$/);
    const t = tx(o.code, o.total);
    const r = await hook(t);
    expect(r).toEqual({ status: 200, body: { success: true } });
    const row = await orderRow(o.code);
    expect(row).toMatchObject({ status: "new", payment_status: "paid", paid_total: o.total });
    const pay = await db().prepare(`SELECT p.method, p.amount, f.type ftype, p.ref FROM payments p JOIN funds f ON f.id = p.fund_id WHERE p.order_id = ?`).bind(row.id).all<any>();
    expect(pay.results).toEqual([{ method: "transfer", amount: o.total, ftype: "bank", ref: `SEPAY:${t.id}` }]);
    const ev = await event(t.id);
    expect(ev).toMatchObject({ status: "matched", verdict: 1, kind: "web", ref_code: o.code, reference_code: t.referenceCode, code: o.code });
    expect((await db().prepare(`SELECT status FROM payment_intents WHERE order_id = ?`).bind(row.id).first<any>()).status).toBe("succeeded");
    const last = await db().prepare(`SELECT actor_type FROM order_events WHERE order_id = ? ORDER BY id DESC LIMIT 1`).bind(row.id).first<any>();
    expect(last.actor_type).toBe("system");
  });

  it("code viết thường (không phân biệt hoa/thường) vẫn khớp", async () => {
    const o = await webOrder();
    const r = await hook(tx(o.code.toLowerCase(), o.total));
    expect(r.body).toEqual({ success: true });
    expect((await orderRow(o.code)).payment_status).toBe("paid");
  });

  it("cùng id hai lần: một tác dụng, cùng phán quyết (thành công không bị đảo thành thất bại)", async () => {
    const o = await webOrder();
    const t = tx(o.code, o.total);
    expect((await hook(t)).body).toEqual({ success: true });
    expect((await hook(t)).body).toEqual({ success: true });
    expect((await hook(t)).body).toEqual({ success: true });
    expect(await paymentCount((await orderRow(o.code)).id)).toBe(1);
    expect((await db().prepare(`SELECT COUNT(*) n FROM sepay_events WHERE sepay_id = ?`).bind(t.id).first<any>()).n).toBe(1);
  });

  it("phán quyết false cũng được giữ khi gửi lại (sai số tiền → luôn success:false)", async () => {
    const o = await webOrder();
    const t = tx(o.code, o.total - 1000);
    expect((await hook(t)).body).toEqual({ success: false });
    expect((await hook(t)).body).toEqual({ success: false });
    expect((await db().prepare(`SELECT COUNT(*) n FROM sepay_events WHERE sepay_id = ?`).bind(t.id).first<any>()).n).toBe(1);
  });

  it("hai giao dịch KHÁC nhau cho một đơn chạy song song: chỉ một lần thanh toán, giao dịch kia success:false + chờ hoàn", async () => {
    const o = await webOrder();
    const a = tx(o.code, o.total), b = tx(o.code, o.total);
    const [ra, rb] = await Promise.all([hook(a), hook(b)]);
    expect([ra.body.success, rb.body.success].sort()).toEqual([false, true]);
    const row = await orderRow(o.code);
    expect(row).toMatchObject({ status: "new", payment_status: "paid", paid_total: o.total });
    expect(await paymentCount(row.id)).toBe(1);
    const evs = [await event(a.id), await event(b.id)];
    expect(evs.map((e) => e.status).sort()).toEqual(["matched", "refund_pending"]);
    expect(evs.find((e) => e.status === "refund_pending").reason).toBe("already_paid");
    // giao dịch thứ ba về sau cũng vậy
    const c = tx(o.code, o.total);
    expect((await hook(c)).body).toEqual({ success: false });
    expect((await event(c.id)).status).toBe("refund_pending");
    expect(await paymentCount(row.id)).toBe(1);
  });

  it("sai số tiền (thiếu / thừa) → unmatched, đơn không đổi, success:false", async () => {
    const o = await webOrder();
    for (const amt of [o.total - 1, o.total + 1, 1]) {
      const t = tx(o.code, amt);
      expect((await hook(t)).body).toEqual({ success: false });
      expect(await event(t.id)).toMatchObject({ status: "unmatched", reason: "amount_mismatch", verdict: 0, kind: "web", ref_code: o.code });
    }
    expect(await orderRow(o.code)).toMatchObject({ status: "awaiting_payment", payment_status: "pending", paid_total: 0 });
    // sau đó chuyển đúng vẫn được
    expect((await hook(tx(o.code, o.total))).body).toEqual({ success: true });
  });

  it("đơn đã huỷ / quá hạn → danh sách chờ hoàn, không tự giao", async () => {
    const cancelled = await webOrder();
    await db().prepare(`UPDATE orders SET status='cancelled' WHERE code = ?`).bind(cancelled.code).run();
    await db().prepare(`UPDATE payment_intents SET status='expired' WHERE order_id=(SELECT id FROM orders WHERE code=?)`).bind(cancelled.code).run();
    const t1 = tx(cancelled.code, cancelled.total);
    expect((await hook(t1)).body).toEqual({ success: false });
    expect(await event(t1.id)).toMatchObject({ status: "refund_pending", reason: "order_closed" });
    expect((await orderRow(cancelled.code)).status).toBe("cancelled");

    const expired = await webOrder(); // đơn còn awaiting_payment nhưng yêu cầu đã hết hạn (cron chưa kịp huỷ)
    await db().prepare(`UPDATE payment_intents SET status='expired' WHERE order_id=(SELECT id FROM orders WHERE code=?)`).bind(expired.code).run();
    const t2 = tx(expired.code, expired.total);
    expect((await hook(t2)).body).toEqual({ success: false });
    expect(await event(t2.id)).toMatchObject({ status: "refund_pending", reason: "order_expired" });
    expect((await orderRow(expired.code)).payment_status).not.toBe("paid");
  });

  it("mã lạ / không có mã / sai tài khoản / tiền ra / SePay tắt → unmatched, success:false", async () => {
    const cases: [string, ReturnType<typeof tx>, string][] = [
      ["mã lạ", tx("DH999999999999", 100000), "unknown_code"],
      ["mã không phải mã của hệ thống", tx("ZZ12345678", 100000), "unknown_code"],
      ["không có code", tx(null, 100000), "no_code"],
      ["sai tài khoản", tx("DH000000000001", 100000, { accountNumber: "999999999" }), "wrong_account"],
      ["tiền ra", tx("DH000000000001", 100000, { transferType: "out" }), "not_money_in"],
    ];
    for (const [name, t, reason] of cases) {
      const r = await hook(t);
      expect(r, name).toEqual({ status: 200, body: { success: false } });
      expect(await event(t.id), name).toMatchObject({ status: "unmatched", reason });
    }
    // memo chứa mã đơn nhưng SePay không nhận diện (code rỗng): KHÔNG tự tách mã từ content
    const o = await webOrder();
    const t = tx(null, o.total, { content: `thanh toan ${o.code}` });
    expect((await hook(t)).body).toEqual({ success: false });
    expect((await orderRow(o.code)).payment_status).not.toBe("paid");

    await enableSepay({ "sepay.enabled": "0" });
    const t2 = tx(o.code, o.total);
    expect((await hook(t2)).body).toEqual({ success: false });
    expect(await event(t2.id)).toMatchObject({ status: "unmatched", reason: "sepay_disabled" });
    await enableSepay();
  });

  it("tài khoản nhận cấu hình riêng: chỉ khớp tài khoản trong danh sách", async () => {
    const o = await webOrder();
    await enableSepay({ "sepay.account_numbers": "111, 222" });
    const bad = tx(o.code, o.total); // ACCOUNT không nằm trong danh sách
    expect((await hook(bad)).body).toEqual({ success: false });
    const ok = tx(o.code, o.total, { accountNumber: "222" });
    expect((await hook(ok)).body).toEqual({ success: true });
    await enableSepay({ "sepay.account_numbers": "" });
    expect(ACCOUNT).toBe("0123456789");
  });

  it("không có số tài khoản cấu hình → fail closed", async () => {
    const o = await webOrder();
    await db().prepare(`UPDATE settings SET value='' WHERE key='payment.bank_account'`).run();
    const t = tx(o.code, o.total);
    expect((await hook(t)).body).toEqual({ success: false });
    expect(await event(t.id)).toMatchObject({ reason: "account_not_configured" });
    await db().prepare(`UPDATE settings SET value='0123456789' WHERE key='payment.bank_account'`).run();
  });

  it("log không chứa memo / secret", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      const o = await webOrder();
      await hook(tx(o.code, o.total, { content: "NGUYEN VAN MEMO-BI-MAT" }));
    } finally { console.log = orig; }
    const all = logs.join("\n");
    expect(all).not.toContain("MEMO-BI-MAT");
    expect(all).not.toContain("whsec_sepay_test");
    expect(all).not.toContain(ACCOUNT);
  });
});

describe("SePay webhook: sự kiện kẹt được xử lý lại", () => {
  it("dòng 'received' bị bỏ dở được cron xử lý lại", async () => {
    const { redriveReceived } = await import("../src/worker/services/sepay");
    const { testEnv } = await import("./helpers");
    const o = await webOrder();
    const id = nextId();
    await db()
      .prepare(`INSERT INTO sepay_events(sepay_id, source, txn_at, account_number, code, transfer_type, amount, payload_json, created_at) VALUES (?, 'webhook', ?, ?, ?, 'in', ?, '{}', '2020-01-01T00:00:00Z')`)
      .bind(id, new Date().toISOString(), ACCOUNT, o.code, o.total)
      .run();
    expect(await redriveReceived(testEnv)).toBeGreaterThanOrEqual(1);
    expect(await event(id)).toMatchObject({ status: "matched", verdict: 1 });
    expect((await orderRow(o.code)).payment_status).toBe("paid");
  });
});
