import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { seedStaff } from "./hr-helpers";
import { vnDate } from "../src/worker/lib/time";

// FIX-8 (tiền): B-N1, B-N2, B-N3, PA-3, PA-5, C2-02, C2-03, C2-08 + bảng hình thức thanh toán của ca có trả trước đơn giao
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
let cashierShift = 0;
let ownerShift = 0;
const body = (over: Record<string, unknown> = {}) => ({
  clientUuid: `fix8-${++seq}-${crypto.randomUUID()}`,
  receiver: { name: "Chị Lan", phone: "0901234567", address: "12 Lê Lợi, Quận 1" },
  lines: [{ productId: 1, unit: "kg", qty: 2 }], // 200.000 + phí 20.000
  shippingFee: 20000,
  deliverer: { userId: 3 },
  prepay: [] as any[],
  cod: 220000,
  ...over,
});
const create = (b: unknown) => api("cashier", "POST", `${V}/pos/delivery-orders`, b);
const act = (id: number, path: string, b?: unknown) => api("online_staff", "POST", `${V}/online-orders/${id}/${path}`, b ?? {});
const set = (k: string, v: string) => db().prepare(`INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`).bind(k, v).run();
const summary = async (id: number, role = "cashier") => (await api(role, "GET", `${V}/shifts/${id}/summary`)).body;
const expected = async (id: number) => (await summary(id)).cashFormula.expected as number;
const payments = async (orderId: number) => (await db().prepare(`SELECT method, amount, fund_id, refund_shift_id FROM payments WHERE order_id=? ORDER BY id`).bind(orderId).all<any>()).results;
/** Giao thất bại + trả hàng (đủ dòng) để có nghĩa vụ hoàn */
async function failAndReturn(orderId: number) {
  expect((await act(orderId, "fail", { reason: "Khách không nhận" })).status).toBe(200);
  const lines = (await db().prepare(`SELECT id FROM order_lines WHERE order_id=?`).bind(orderId).all<any>()).results;
  expect((await act(orderId, "return-to-stock", { lines: [{ orderLineId: lines[0].id, qty: 2, restock: true, reason: "Hàng còn nguyên" }] })).status).toBe(200);
}
let cseq = 0;
async function retail(limit = 1_000_000) {
  const n = ++cseq;
  return (await db()
    .prepare(`INSERT INTO customers(code, type, name, phone, customer_group_id, credit_limit, payment_terms_days) VALUES (?, 'retail', ?, ?, 1, ?, 0) RETURNING id`)
    .bind(`KL-F8${n}`, `Khách fix8 ${n}`, `09300000${String(n).padStart(2, "0")}`, limit)
    .first<{ id: number }>())!.id;
}

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().prepare(`UPDATE lots SET qty_in_milli = 500000, qty_on_hand_milli = 500000 WHERE id = 1`).run();
  await db().batch([
    db().prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-CH1','Chờ đối soát COD','cod_clearing')`),
    db().prepare(`INSERT INTO customers(id, code, type, name, phone, billing_address, address, customer_group_id, credit_limit) VALUES
      (9801,'KH-SI9','b2b','Nhà hàng Bí Mật','0909888777','99 Đường Riêng, Q3','99 Đường Riêng, Q3',2,0),
      (9802,'KL-P1','retail','Chị Riêng Tư','0903123456',NULL,'12 Ngõ Kín, Q1',1,1000000)`),
    db().prepare(`INSERT INTO customer_addresses(customer_id, label, address, is_default, active) VALUES (9801,'Kho','Số 7 Hẻm Bí Mật, Q10',1,1)`),
  ]);
  await seedStaff({ userId: 50, username: "nv50", employeeId: 50, role: "staff" });
  await set("pos.retail_credit_enabled", "1");
  cashierShift = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 500000 })).body.shift.id;
  await api("manager", "POST", `${V}/shifts/open`, { openingCash: 0 });
  ownerShift = (await api("owner", "POST", `${V}/shifts/open`, { openingCash: 1_000_000 })).body.shift.id;
});

describe("B-N1: gửi lại clientUuid của lần tạo đơn giao đã thất bại", () => {
  it("lần đầu lỗi giữa chừng (đơn tự huỷ) → gửi lại cùng mã = 409 previous_attempt_failed, không phải 200; mã mới tạo được", async () => {
    await db().prepare(`CREATE TRIGGER t_f8_boom BEFORE INSERT ON payments WHEN NEW.amount = 77777 BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();
    const b = body({ prepay: [{ method: "cash", amount: 77777 }], cod: 220000 - 77777 });
    const r1 = await create(b);
    await db().prepare(`DROP TRIGGER t_f8_boom`).run();
    expect(r1.status).toBeGreaterThanOrEqual(400);
    const r2 = await create(b);
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe("previous_attempt_failed");
    const o = (await db().prepare(`SELECT id, status FROM orders WHERE client_uuid = ?`).bind(b.clientUuid).first<any>())!;
    expect(o.status).toBe("cancelled");
    expect((await payments(o.id)).length).toBe(0);
    // mã mới → tạo bình thường
    const r3 = await create({ ...b, clientUuid: `fix8-new-${crypto.randomUUID()}` });
    expect(r3.status).toBe(201);
    expect(r3.body.status).toBe("shipping");
    // gửi lại mã của lần THÀNH CÔNG vẫn trả đơn cũ (idempotent)
    const again = await create({ ...b, clientUuid: (await db().prepare(`SELECT client_uuid FROM orders WHERE id=?`).bind(r3.body.id).first<any>()).client_uuid });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: r3.body.id, created: false, status: "shipping" });
  });
});

describe("B-N2: hoàn tiền theo từng dòng thu gốc", () => {
  it("trả trước 100k tiền mặt + 120k chuyển khoản → hoàn: tiền mặt về quỹ tiền mặt, chuyển khoản về quỹ ngân hàng, không vượt số đã thu của dòng", async () => {
    const r = await create(body({ prepay: [{ method: "cash", amount: 100000 }, { method: "transfer", amount: 120000 }], cod: 0 }));
    expect(r.status).toBe(201);
    const exp0 = await expected(cashierShift);
    await failAndReturn(r.body.id);
    const rf = await api("accountant", "POST", `${V}/online-orders/${r.body.id}/refund`, {});
    expect(rf.status).toBe(200);
    const neg = (await payments(r.body.id)).filter((p: any) => p.amount < 0);
    expect(neg.map((p: any) => ({ method: p.method, amount: p.amount, fund_id: p.fund_id }))).toEqual([
      { method: "cash", amount: -100000, fund_id: 1 },
      { method: "transfer", amount: -100000, fund_id: 2 },
    ]);
    // tiền mặt dự kiến chỉ giảm đúng phần tiền mặt đã nhận
    expect((await expected(cashierShift)) - exp0).toBe(-100000);
    // hoàn lần hai không được
    expect((await api("accountant", "POST", `${V}/online-orders/${r.body.id}/refund`, {})).status).toBe(409);
  });

  it("trả trước 100k tiền mặt + COD 120k đã thu, giao xong rồi trả hết → hoàn 100k tiền mặt từ két, 120k COD từ quỹ chờ đối soát", async () => {
    const r = await create(body({ prepay: [{ method: "cash", amount: 100000 }], cod: 120000 }));
    expect(r.status).toBe(201);
    expect((await act(r.body.id, "deliver")).status).toBe(200);
    const rt = await act(r.body.id, "return-to-stock", { lines: [] });
    expect(rt.status).toBe(200);
    const rf = await api("accountant", "POST", `${V}/online-orders/${r.body.id}/refund`, {});
    expect(rf.status).toBe(200);
    const neg = (await payments(r.body.id)).filter((p: any) => p.amount < 0);
    expect(neg.map((p: any) => ({ method: p.method, amount: p.amount, fund_id: p.fund_id }))).toEqual([
      { method: "cash", amount: -100000, fund_id: 1 },
      { method: "cod", amount: -120000, fund_id: 3 },
    ]);
  });

  it("COD chưa thu (đơn bị huỷ khi đang giao) → không có dòng hoàn nào cho phần COD", async () => {
    const r = await create(body({ prepay: [{ method: "transfer", amount: 100000 }], cod: 120000 }));
    expect(r.status).toBe(201);
    await failAndReturn(r.body.id);
    const rf = await api("accountant", "POST", `${V}/online-orders/${r.body.id}/refund`, {});
    expect(rf.status).toBe(200);
    const neg = (await payments(r.body.id)).filter((p: any) => p.amount < 0);
    expect(neg.map((p: any) => ({ method: p.method, amount: p.amount, fund_id: p.fund_id }))).toEqual([{ method: "transfer", amount: -80000, fund_id: 2 }]); // giữ 20k phí giao khi giao thất bại
  });
});

describe("Bảng hình thức thanh toán của ca có trả trước đơn giao tại quầy", () => {
  it("tiền mặt/chuyển khoản trả trước hiện trong byPayment; dòng tiền mặt khớp cashFormula", async () => {
    const before = await summary(cashierShift);
    const r = await create(body({ prepay: [{ method: "cash", amount: 150000 }, { method: "qr", amount: 70000 }], cod: 0 }));
    expect(r.status).toBe(201);
    const s = await summary(cashierShift);
    const row = (m: string, x: any) => x.byPayment.find((p: any) => p.method === m);
    expect(row("cash", s).sold - row("cash", before).sold).toBe(150000);
    expect(row("qr", s).sold - row("qr", before).sold).toBe(70000);
    expect(row("cash", s).net).toBe(s.cashFormula.cashSold - s.cashFormula.cashRefunded);
    // COD không phải tiền của quầy
    expect(row("cod", s)).toBeUndefined();
  });
});

describe("PA-3: /reconcile/shifts dùng cashFormula cho ca đang mở", () => {
  it("ca đang mở có thu nợ tiền mặt: expected_cash ở danh sách = expectedCash ở chi tiết ca", async () => {
    const cu = await retail();
    const o = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: `fix8-pa3-${crypto.randomUUID()}`, customerId: cu, lines: [{ productId: 1, unit: "kg", qty: 2 }], payments: [], credit: { amount: 200000 } });
    expect(o.status).toBe(201);
    const pay = await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 120000, method: "cash", idempotencyKey: `fix8-k-${crypto.randomUUID()}` });
    expect(pay.status).toBe(201);
    const sum = await summary(cashierShift, "manager");
    expect(sum.cashFormula.debtCollected).toBe(120000);
    const list = (await api("manager", "GET", `${V}/reconcile/shifts?day=${vnDate()}`)).body;
    expect(list.items.find((s: any) => s.id === cashierShift).expected_cash).toBe(sum.shift.expectedCash);
  });
});

describe("PA-5: đảo phiếu thu nợ tại quầy trừ khỏi tiền mặt dự kiến của ca", () => {
  it("thu ngân thu nợ 120.000 tiền mặt, quản lý đảo phiếu → debtCollected của ca về mức cũ", async () => {
    const cu = await retail();
    const o = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: `fix8-pa5-${crypto.randomUUID()}`, customerId: cu, lines: [{ productId: 1, unit: "kg", qty: 2 }], payments: [], credit: { amount: 200000 } });
    expect(o.status).toBe(201);
    const f0 = (await summary(cashierShift)).cashFormula;
    const pay = await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 120000, method: "cash", idempotencyKey: `fix8-k-${crypto.randomUUID()}` });
    expect(pay.status).toBe(201);
    expect((await summary(cashierShift)).cashFormula.debtCollected - f0.debtCollected).toBe(120000);
    const pid = (await db().prepare(`SELECT id FROM debt_payments WHERE partner_id = ? AND status='posted'`).bind(cu).first<any>()).id;
    const rv = await api("manager", "POST", `${V}/debts/payments/${pid}/reverse`, { reason: "thu nhầm, trả lại tiền khách" });
    expect(rv.status).toBe(200);
    const f1 = (await summary(cashierShift)).cashFormula;
    expect(f1.debtCollected).toBe(f0.debtCollected);
    expect(f1.expected).toBe(f0.expected);
  });
});

describe("C2-02: địa chỉ giao và người giao", () => {
  it("delivery-addresses: khách sỉ/không tồn tại → rỗng; khách lẻ → trả địa chỉ, SĐT che theo quyền", async () => {
    const si = await api("cashier", "GET", `${V}/pos/delivery-addresses?customerId=9801`);
    expect(si.status).toBe(200);
    expect(JSON.stringify(si.body)).not.toContain("Hẻm Bí Mật");
    expect(JSON.stringify(si.body)).not.toContain("Đường Riêng");
    expect(si.body).toEqual({ receiverName: null, receiverPhone: null, items: [] });
    const none = await api("cashier", "GET", `${V}/pos/delivery-addresses?customerId=424242`);
    expect(none.body).toEqual(si.body);
    const le = await api("cashier", "GET", `${V}/pos/delivery-addresses?customerId=9802`);
    expect(JSON.stringify(le.body)).toContain("Ngõ Kín");
    expect(le.body.receiverPhone).toBeNull();
    expect((await api("manager", "GET", `${V}/pos/delivery-addresses?customerId=9802`)).body.receiverPhone).toBe("0903123456");
  });

  it("deliverers: chỉ người làm tại cửa hàng đang hoạt động; không kế toán, người đã nghỉ; không giao được bằng tài khoản ngoài danh sách", async () => {
    const r = await api("cashier", "GET", `${V}/pos/deliverers`);
    const ids = r.body.items.map((u: any) => u.id).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 6, 50]); // không có kế toán (5); 50 = nhân viên chung
    await db().prepare(`UPDATE employees SET status = 'terminated' WHERE id = 50`).run();
    expect((await api("cashier", "GET", `${V}/pos/deliverers`)).body.items.map((u: any) => u.id)).not.toContain(50); // đã nghỉ việc
    await db().prepare(`UPDATE employees SET status = 'active' WHERE id = 50`).run();
    const bad = await create(body({ deliverer: { userId: 5 } })); // kế toán
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("deliverer_not_found");
  });
});

describe("C2-03 + C2-08: lương/tạm ứng không lộ cho người thiếu hr.sensitive", () => {
  it("chi tiết ca và báo cáo cuối ngày gộp thành 'Chi lương (tổng)', không mã phiếu/mã NV/số phiếu; người có hr.sensitive vẫn thấy đủ", async () => {
    await db().prepare(`UPDATE employees SET base_salary = 10000000, pay_type = 'monthly' WHERE id = 50`).run();
    const adv = await api("owner", "POST", `${V}/payroll/advances`, { employeeId: 50, amount: 1234000, fundId: 1, reason: "ốm" });
    expect(adv.status).toBe(201);
    const m = await api("manager", "GET", `${V}/shifts/${ownerShift}/summary`);
    expect(m.status).toBe(200);
    const mj = JSON.stringify(m.body.vouchers);
    expect(mj).not.toContain("NV-");
    expect(mj).not.toContain("ốm");
    const agg = m.body.vouchers.items.filter((v: any) => v.category === "Chi lương (tổng)");
    expect(agg.length).toBe(1);
    expect(agg[0]).toMatchObject({ code: "", note: null, direction: "out" });
    const o = await api("owner", "GET", `${V}/shifts/${ownerShift}/summary`);
    expect(JSON.stringify(o.body.vouchers)).toContain("NV-");
    // tổng chi của ca vẫn đủ
    expect(m.body.vouchers.out).toBe(o.body.vouchers.out);

    const d = await api("manager", "GET", `${V}/reports/daily`);
    const lines = d.body.cashFlow.byCategory.filter((r: any) => r.direction === "out" && /lương/i.test(r.category));
    expect(lines).toEqual([expect.objectContaining({ category: "Chi lương (tổng)", count: 0 })]);
    const da = await api("owner", "GET", `${V}/reports/daily`);
    const full = da.body.cashFlow.byCategory.find((r: any) => r.category === "Lương");
    expect(full.count).toBeGreaterThanOrEqual(1);
    expect(d.body.cashFlow.out).toBe(da.body.cashFlow.out);
  });
});

describe("B-N3: hoàn tiền mặt đơn giao tại quầy sau khi ca tạo đơn đã chốt", () => {
  it("hoàn bởi người có ca đang mở → trừ tiền mặt dự kiến của ca đó (có refund_shift_id), ca đã chốt giữ nguyên", async () => {
    const r = await create(body({ prepay: [{ method: "cash", amount: 220000 }], cod: 0 }));
    expect(r.status).toBe(201);
    const exp = await expected(cashierShift);
    expect((await api("cashier", "POST", `${V}/shifts/${cashierShift}/close`, { countedCash: exp })).status).toBe(200);
    const closedExp = (await summary(cashierShift)).shift.expectedCash;
    await failAndReturn(r.body.id);
    const e0 = (await summary(ownerShift, "owner")).cashFormula.expected;
    const rf = await api("owner", "POST", `${V}/online-orders/${r.body.id}/refund`, {});
    expect(rf.status).toBe(200);
    const neg = (await payments(r.body.id)).filter((p: any) => p.amount < 0);
    expect(neg).toEqual([{ method: "cash", amount: -200000, fund_id: 1, refund_shift_id: ownerShift }]);
    expect((await summary(ownerShift, "owner")).cashFormula.expected - e0).toBe(-200000);
    expect((await summary(cashierShift)).shift.expectedCash).toBe(closedExp);
    // hiện ở bảng hình thức của ca hoàn
    expect((await summary(ownerShift, "owner")).byPayment.find((p: any) => p.method === "cash").refunded).toBeGreaterThanOrEqual(200000);
  });

  it("không có ca mở (kế toán hoàn qua quỹ) → vẫn ghi quỹ, không ca nào bị trừ; ca đã chốt không đổi", async () => {
    const s2 = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift.id;
    const r = await create(body({ prepay: [{ method: "cash", amount: 220000 }], cod: 0 }));
    expect(r.status).toBe(201);
    expect((await api("cashier", "POST", `${V}/shifts/${s2}/close`, { countedCash: 220000 })).status).toBe(200);
    const s3 = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift.id;
    await failAndReturn(r.body.id);
    const e0 = await expected(s3);
    const rf = await api("accountant", "POST", `${V}/online-orders/${r.body.id}/refund`, {});
    expect(rf.status).toBe(200);
    const neg = (await payments(r.body.id)).filter((p: any) => p.amount < 0);
    expect(neg).toEqual([{ method: "cash", amount: -200000, fund_id: 1, refund_shift_id: null }]);
    expect(await expected(s3)).toBe(e0);
  });
});
