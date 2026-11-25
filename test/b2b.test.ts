import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { addDays, customerDebtStatus } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";

const db = () => testEnv.DB;
const tomorrow = () => addDays(vnDate(), 1);
const lot = async (id: number) => (await db().prepare(`SELECT qty_on_hand_milli h, qty_reserved_milli r FROM lots WHERE id=?`).bind(id).first<{ h: number; r: number }>())!;
let seq = 0;
const uuid = () => `b2b-test-${Date.now()}-${++seq}`;

async function newCustomer(name: string, over: Record<string, unknown> = {}) {
  const r = await api("owner", "POST", "/api/v1/customers", {
    name, type: "b2b", customerGroupId: 1, creditLimit: 100_000_000, paymentTermsDays: 15,
    contacts: [{ name: "Người nhận", phone: "0900000001", isReceiver: true }],
    addresses: [{ label: "Kho", address: "1 Lê Lợi", isDefault: true }], ...over,
  });
  expect(r.status).toBe(201);
  return { id: r.body.id as number, addressId: r.body.addresses[0].id as number };
}

const order = (c: { id: number; addressId: number }, lines: any[], extra: Record<string, unknown> = {}, role = "manager") =>
  api(role, "POST", "/api/v1/b2b/orders", { customerId: c.id, addressId: c.addressId, deliveryDate: tomorrow(), clientUuid: uuid(), lines, ...extra });

beforeAll(async () => {
  await seedBase();
  const d = db();
  const now = new Date().toISOString();
  const soon = new Date(Date.now() + 10 * 86400_000).toISOString();
  const later = new Date(Date.now() + 20 * 86400_000).toISOString();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (810,'CAM','Cam sành','kg'),(811,'DUA','Dưa hấu','kg'),(812,'KHAC','Mít','kg'),(813,'HIEM','Sầu riêng','kg')`),
    d.prepare(`INSERT INTO product_units(product_id, unit, factor_milli) VALUES (810,'thung',10000)`),
    d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES
      (810,'LOT-CAM-1',810,1,?1,?2,30000,100000,100000),(811,'LOT-CAM-2',810,1,?1,?3,31000,50000,50000),
      (812,'LOT-DUA-1',811,1,?1,?2,10000,60000,60000),(813,'LOT-KHAC-1',812,1,?1,?2,5000,10000,10000),(814,'LOT-HIEM-1',813,1,?1,?2,90000,2000,2000)`).bind(now, soon, later),
    d.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES
      (1,810,50000,'2020-01-01T00:00:00Z','active',1),(1,811,20000,'2020-01-01T00:00:00Z','active',1),(1,812,10000,'2020-01-01T00:00:00Z','active',1),(1,813,200000,'2020-01-01T00:00:00Z','active',1)`),
  ]);
});

describe("b2b orders: access, stock and credit", () => {
  it("forbids cashier on /b2b/orders", async () => {
    expect((await api("cashier", "GET", "/api/v1/b2b/orders")).status).toBe(403);
    const c = await newCustomer("KH quyền");
    expect((await order(c, [{ productId: 810, unit: "kg", qty: 1 }], {}, "cashier")).status).toBe(403);
    expect((await api("accountant", "GET", "/api/v1/b2b/orders")).status).toBe(200);
  });

  it("checks credit, reserves FEFO and is idempotent on clientUuid", async () => {
    const c = await newCustomer("KH giữ tồn");
    const before = await lot(810);
    const clientUuid = uuid();
    const r = await order(c, [{ productId: 810, unit: "thung", qty: 2 }], { clientUuid });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("confirmed");
    expect(r.body.code).toMatch(/^DS-\d{8}-\d{4}$/);
    expect(r.body.total).toBe(1_000_000);
    expect(r.body.lines[0]).toMatchObject({ qty: 2, qtyMilli: 20000, unit: "thung", reservedMilli: 20000, deliveredMilli: 0 });
    expect((await lot(810)).r).toBe(before.r + 20000);
    const again = await order(c, [{ productId: 810, unit: "thung", qty: 2 }], { clientUuid });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(r.body.id);
    expect((await lot(810)).r).toBe(before.r + 20000); // không giữ trùng
  });

  it("over credit limit is blocked before reserving; manager cannot approve, owner can; confirm then reserves", async () => {
    const c = await newCustomer("KH hạn mức", { creditLimit: 500_000 });
    const before = await lot(810);
    const r = await order(c, [{ productId: 810, unit: "kg", qty: 20 }]); // 1.000.000 > 500.000
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("credit_blocked");
    const { approvalId, reasons, orderId } = r.body.error.details;
    expect(reasons).toContain("over_limit");
    expect(approvalId).toBeGreaterThan(0);
    expect((await lot(810)).r).toBe(before.r); // EC-23: chưa giữ hàng
    expect((await api("manager", "GET", `/api/v1/b2b/orders/${orderId}`)).body.status).toBe("new");
    expect((await api("manager", "POST", `/api/v1/b2b/orders/${orderId}/confirm`)).status).toBe(409);
    const mgr = await api("manager", "POST", `/api/v1/approvals/${approvalId}/decide`, { decision: "approved" });
    expect(mgr.status).toBe(403);
    const own = await api("owner", "POST", `/api/v1/approvals/${approvalId}/decide`, { decision: "approved" });
    expect(own.status).toBe(200);
    expect((await lot(810)).r).toBe(before.r); // duyệt không tự giữ hàng
    const conf = await api("manager", "POST", `/api/v1/b2b/orders/${orderId}/confirm`);
    expect(conf.status).toBe(200);
    expect(conf.body.status).toBe("confirmed");
    expect(conf.body.creditOverrideApprovalId).toBe(approvalId);
    expect((await lot(810)).r).toBe(before.r + 20000);
  });

  it("blocks a customer with an overdue invoice (EC-23) and a rejected override stays blocked", async () => {
    const c = await newCustomer("KH nợ quá hạn");
    await db().prepare(`INSERT INTO invoices(code, customer_id, issue_date, due_date, subtotal, total) VALUES ('OLD-1',?, '2026-01-01','2026-01-15',100000,100000)`).bind(c.id).run();
    const r = await order(c, [{ productId: 810, unit: "kg", qty: 1 }]);
    expect(r.status).toBe(409);
    expect(r.body.error.details.reasons).toContain("overdue");
    await api("owner", "POST", `/api/v1/approvals/${r.body.error.details.approvalId}/decide`, { decision: "rejected" });
    const conf = await api("manager", "POST", `/api/v1/b2b/orders/${r.body.error.details.orderId}/confirm`);
    expect(conf.status).toBe(409);
    expect(conf.body.error.code).toBe("credit_blocked");
    expect(conf.body.error.details.approvalId).not.toBe(r.body.error.details.approvalId); // yêu cầu mới
    // hoá đơn quá hạn hiện trong danh sách công nợ
    const inv = await api("accountant", "GET", `/api/v1/invoices?customerId=${c.id}&overdue=1`);
    expect(inv.body.items).toHaveLength(1);
    expect(inv.body.items[0]).toMatchObject({ code: "OLD-1", outstanding: 100000, paid: 0 });
    expect(inv.body.items[0].overdueDays).toBeGreaterThan(0);
  });

  it("returns insufficient_stock and leaves the order in `new` (po.allow_short_confirm = 0: hành vi cũ)", async () => {
    await testEnv.DB.prepare(`UPDATE settings SET value = '0' WHERE key = 'po.allow_short_confirm'`).run();
    const c = await newCustomer("KH thiếu hàng");
    const r = await order(c, [{ productId: 813, unit: "kg", qty: 5 }]); // chỉ còn 2kg
    await testEnv.DB.prepare(`UPDATE settings SET value = '1' WHERE key = 'po.allow_short_confirm'`).run();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("insufficient_stock");
    const list = await api("manager", "GET", `/api/v1/b2b/orders?customerId=${c.id}`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].status).toBe("new");
    expect((await lot(814)).r).toBe(0);
  });

  it("cancel releases reservations; editing lines re-reserves", async () => {
    const c = await newCustomer("KH huỷ");
    const base = await lot(812);
    const r = await order(c, [{ productId: 811, unit: "kg", qty: 10 }]);
    expect((await lot(812)).r).toBe(base.r + 10000);
    const edit = await api("manager", "PUT", `/api/v1/b2b/orders/${r.body.id}`, { lines: [{ productId: 811, unit: "kg", qty: 4 }] });
    expect(edit.status).toBe(200);
    expect(edit.body.status).toBe("confirmed");
    expect(edit.body.total).toBe(80000);
    expect((await lot(812)).r).toBe(base.r + 4000);
    const bad = await api("manager", "POST", `/api/v1/b2b/orders/${r.body.id}/cancel`, {});
    expect(bad.status).toBe(422); // cần lý do
    const cx = await api("manager", "POST", `/api/v1/b2b/orders/${r.body.id}/cancel`, { reason: "Khách đổi ý" });
    expect(cx.status).toBe(200);
    expect(cx.body.status).toBe("cancelled");
    expect((await lot(812)).r).toBe(base.r);
    const active = await db().prepare(`SELECT COUNT(*) n FROM reservations WHERE order_id=? AND status='active'`).bind(r.body.id).first<{ n: number }>();
    expect(active!.n).toBe(0);
  });
});

describe("b2b delivery: pick, scan, partial delivery, invoice, return", () => {
  let c: { id: number; addressId: number };
  let orderId = 0;
  let deliveryId = 0;
  let invoiceId = 0;
  const camBefore = { h: 0, r: 0 };
  const duaBefore = { h: 0, r: 0 };

  beforeAll(async () => {
    c = await newCustomer("KH giao hàng", { paymentTermsDays: 15 });
    Object.assign(camBefore, await lot(810));
    Object.assign(duaBefore, await lot(812));
  });

  it("picks, rejects wrong scans and requires a reason for a short pick", async () => {
    const r = await order(c, [{ productId: 810, unit: "kg", qty: 20 }, { productId: 811, unit: "kg", qty: 10 }]);
    expect(r.status).toBe(201);
    orderId = r.body.id;
    const pk = await api("warehouse", "POST", `/api/v1/b2b/orders/${orderId}/pick`);
    expect(pk.status).toBe(201);
    deliveryId = pk.body.deliveryId;
    expect(pk.body.code).toMatch(/^GH-\d{8}-\d{4}$/);
    expect(pk.body.lines[0].lots[0]).toMatchObject({ lotCode: "LOT-CAM-1", qtyMilli: 20000 });
    expect((await api("warehouse", "POST", `/api/v1/b2b/orders/${orderId}/pick`)).status).toBe(409); // đã có phiếu giao
    const scan = (body: any) => api("warehouse", "POST", `/api/v1/deliveries/${deliveryId}/scan`, body);
    const notIn = await scan({ code: "KHAC" });
    expect(notIn.status).toBe(422);
    expect(notIn.body.error.code).toBe("not_in_doc");
    expect((await scan({ code: "LOT-KHAC-1" })).body.error.code).toBe("not_in_doc");
    const wrong = await scan({ code: "LOT-CAM-2" }); // lô Cam không được giữ cho đơn
    expect(wrong.body.error.code).toBe("wrong_lot");
    expect((await scan({ code: "NOPE-123" })).body.error.code).toBe("unknown_code");
    const evs = await db().prepare(`SELECT result FROM scan_events WHERE context=? ORDER BY id`).bind(`delivery:${deliveryId}`).all<{ result: string }>();
    expect(evs.results.map((e) => e.result)).toEqual(["not_in_doc", "not_in_doc", "wrong_lot", "unknown"]);
    // quét đúng lô (số lượng mặc định = số giữ trên lô)
    const ok = await scan({ code: "LOT-CAM-1" });
    expect(ok.status).toBe(201);
    expect(ok.body.lines[0].pickedMilli).toBe(20000);
    expect((await scan({ code: "LOT-CAM-1" })).body.error.code).toBe("duplicate_scan");
    expect((await scan({ code: "DUA", qty: 20 })).body.error.code).toBe("over_pick");
    await scan({ code: "DUA", qty: 8 });
    const shortReady = await api("warehouse", "POST", `/api/v1/deliveries/${deliveryId}/ready`, {});
    expect(shortReady.status).toBe(422);
    expect(shortReady.body.error.code).toBe("reason_required");
    await scan({ code: "DUA", qty: 2 });
    const ready = await api("warehouse", "POST", `/api/v1/deliveries/${deliveryId}/ready`, {});
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe("ready");
    const ship = await api("warehouse", "POST", `/api/v1/deliveries/${deliveryId}/ship`, { shipper: "Anh Ba" });
    expect(ship.body.status).toBe("shipping");
    expect((await api("manager", "GET", `/api/v1/b2b/orders/${orderId}`)).body.status).toBe("shipping");
  });

  it("confirms partial delivery with a rejection: stock drops only by delivered, rest released, invoice = delivered amount", async () => {
    const lines = (await api("manager", "GET", `/api/v1/b2b/orders/${orderId}`)).body.lines;
    const [cam, dua] = lines;
    const cf = await api("warehouse", "POST", `/api/v1/deliveries/${deliveryId}/confirm`, {
      receiverName: "Anh Tùng",
      lines: [
        { orderLineId: cam.id, deliveredQty: 18, rejectedQty: 2, rejectReason: "hong" },
        { orderLineId: dua.id, deliveredQty: 10 },
      ],
    });
    expect(cf.status).toBe(200);
    expect(cf.body.orderStatus).toBe("completed");
    const inv = cf.body.invoice;
    invoiceId = inv.id;
    expect(inv.subtotal).toBe(18 * 50000 + 10 * 20000); // 1.100.000
    expect(inv.total).toBe(1_100_000);
    expect(inv.dueDate).toBe(addDays(vnDate(), 15));
    expect(inv.issueDate).toBe(vnDate());
    expect(inv.einvoiceStatus).toBe("queued");
    const cam1 = await lot(810);
    const dua1 = await lot(812);
    expect(cam1.h).toBe(camBefore.h - 18000);
    expect(cam1.r).toBe(camBefore.r); // phần giữ dư đã nhả
    expect(dua1.h).toBe(duaBefore.h - 10000);
    expect(dua1.r).toBe(duaBefore.r);
    const job = await db().prepare(`SELECT type, status FROM integration_jobs WHERE ref_type='invoice' AND ref_id=?`).bind(invoiceId).all<any>();
    expect(job.results).toEqual([{ type: "einvoice.issue", status: "queued" }]);
    const o = (await api("manager", "GET", `/api/v1/b2b/orders/${orderId}`)).body;
    expect(o.status).toBe("completed");
    expect(o.total).toBe(1_100_000);
    expect(o.invoiceId).toBe(invoiceId);
    expect(o.lines[0].deliveredMilli).toBe(18000);
    const dl = await db().prepare(`SELECT rejected_milli r, reject_reason rr, delivered_milli d FROM delivery_lines WHERE delivery_id=? ORDER BY id`).bind(deliveryId).all<any>();
    expect(dl.results[0]).toEqual({ r: 2000, rr: "hong", d: 18000 });
    const sm = await db().prepare(`SELECT SUM(qty_delta_milli) q FROM stock_moves WHERE ref_type='delivery' AND ref_id=? AND product_id=810`).bind(deliveryId).first<{ q: number }>();
    expect(sm!.q).toBe(-18000);
    const cost = await db().prepare(`SELECT cost_total FROM orders WHERE id=?`).bind(orderId).first<{ cost_total: number }>();
    expect(cost!.cost_total).toBe(18 * 30000 + 10 * 10000);
    // công nợ khách = hoá đơn
    expect((await customerDebtStatus(db(), c.id)).balance).toBe(1_100_000);
    // hoá đơn xem được, buyer lấy từ khách hàng
    const detail = await api("accountant", "GET", `/api/v1/invoices/${invoiceId}`);
    expect(detail.body.lines).toHaveLength(2);
    expect(detail.body.buyer.name).toBe("KH giao hàng");
    expect(detail.body.outstanding).toBe(1_100_000);
    // không xác nhận giao lần hai
    expect((await api("warehouse", "POST", `/api/v1/deliveries/${deliveryId}/confirm`, { receiverName: "X", lines: [{ orderLineId: cam.id, deliveredQty: 1 }] })).status).toBe(409);
  });

  it("return after invoicing creates a negative adjustment invoice, restocks the original lot and reduces debt", async () => {
    const cam = (await api("manager", "GET", `/api/v1/b2b/orders/${orderId}`)).body.lines[0];
    const before = await lot(810);
    const over = await api("manager", "POST", `/api/v1/b2b/orders/${orderId}/returns`, { lines: [{ orderLineId: cam.id, qty: 19, unit: "kg", restock: true, reason: "Hư" }] });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("over_return");
    const r = await api("manager", "POST", `/api/v1/b2b/orders/${orderId}/returns`, { lines: [{ orderLineId: cam.id, qty: 3, unit: "kg", restock: true, reason: "Khách trả dư" }] });
    expect(r.status).toBe(201);
    expect(r.body.invoice).toMatchObject({ kind: "adjustment", originalInvoiceId: invoiceId, total: -150000, subtotal: -150000 });
    expect((await lot(810)).h).toBe(before.h + 3000);
    const job = await db().prepare(`SELECT type FROM integration_jobs WHERE ref_id=? AND ref_type='invoice'`).bind(r.body.invoice.id).all<any>();
    expect(job.results).toEqual([{ type: "einvoice.adjust" }]);
    const st = (await api("manager", "GET", `/api/v1/customers/${c.id}`)).body.debt;
    expect(st.balance).toBe(950_000);
    expect(st.outstanding).toBe(950_000);
    const orig = await api("accountant", "GET", `/api/v1/invoices/${invoiceId}`);
    expect(orig.body.outstanding).toBe(950_000);
    expect(orig.body.adjustments).toHaveLength(1);
    // trả thêm không restock: tồn không đổi; tổng trả không vượt số giao (18 − 3 = 15)
    const h = (await lot(810)).h;
    const r2 = await api("manager", "POST", `/api/v1/b2b/orders/${orderId}/returns`, { lines: [{ orderLineId: cam.id, qty: 15, unit: "kg", restock: false, reason: "Hỏng" }] });
    expect(r2.status).toBe(201);
    expect((await lot(810)).h).toBe(h);
    expect((await api("manager", "POST", `/api/v1/b2b/orders/${orderId}/returns`, { lines: [{ orderLineId: cam.id, qty: 1, unit: "kg", restock: true, reason: "Hỏng" }] })).status).toBe(422);
    const open = await api("accountant", "GET", `/api/v1/invoices?customerId=${c.id}&status=open`);
    expect(open.body.items.map((i: any) => i.outstanding)).toEqual([200000]);
  });

  it("failed delivery releases reservations and the order can be re-confirmed and delivered again", async () => {
    const c2 = await newCustomer("KH giao lỗi");
    const base = await lot(812);
    const r = await order(c2, [{ productId: 811, unit: "kg", qty: 5 }]);
    const pk = await api("warehouse", "POST", `/api/v1/b2b/orders/${r.body.id}/pick`);
    expect((await lot(812)).r).toBe(base.r + 5000);
    const f = await api("warehouse", "POST", `/api/v1/deliveries/${pk.body.deliveryId}/fail`, { reason: "Khách vắng nhà" });
    expect(f.status).toBe(200);
    expect((await lot(812)).r).toBe(base.r);
    expect((await api("manager", "GET", `/api/v1/b2b/orders/${r.body.id}`)).body.status).toBe("delivery_failed");
    const re = await api("manager", "POST", `/api/v1/b2b/orders/${r.body.id}/confirm`);
    expect(re.status).toBe(200);
    expect(re.body.status).toBe("confirmed");
    expect((await lot(812)).r).toBe(base.r + 5000);
  });
});

describe("recurring orders and e-invoice", () => {
  it("generates an order from a recurring template idempotently through the credit flow", async () => {
    const c = await newCustomer("KH đơn lặp");
    const t = await api("manager", "POST", "/api/v1/b2b/recurring", { customerId: c.id, addressId: c.addressId, weekdays: [1, 4], lines: [{ productId: 811, unit: "kg", qty: 3 }] });
    expect(t.status).toBe(201);
    expect(t.body.weekdays).toEqual([1, 4]);
    const g = await api("manager", "POST", `/api/v1/b2b/recurring/${t.body.id}/generate`, { deliveryDate: tomorrow() });
    expect(g.status).toBe(201);
    expect(g.body.status).toBe("confirmed");
    expect(g.body.recurringTemplateId).toBe(t.body.id);
    const g2 = await api("manager", "POST", `/api/v1/b2b/recurring/${t.body.id}/generate`, { deliveryDate: tomorrow() });
    expect(g2.status).toBe(200);
    expect(g2.body.id).toBe(g.body.id);
    const list = await api("manager", "GET", "/api/v1/b2b/recurring");
    expect(list.body.items.find((x: any) => x.id === t.body.id).lastGeneratedFor).toBe(tomorrow());
  });

  it("manual e-invoice issue enqueues a job once and refuses issued invoices", async () => {
    const c = await newCustomer("KH hoá đơn");
    await db().prepare(`INSERT INTO invoices(code, customer_id, issue_date, due_date, subtotal, total) VALUES ('MAN-1',?,?,?,10000,10000)`).bind(c.id, vnDate(), vnDate()).run();
    const inv = await db().prepare(`SELECT id FROM invoices WHERE code='MAN-1'`).first<{ id: number }>();
    expect((await api("warehouse", "POST", `/api/v1/invoices/${inv!.id}/einvoice`)).status).toBe(403);
    const r = await api("accountant", "POST", `/api/v1/invoices/${inv!.id}/einvoice`);
    expect(r.status).toBe(202);
    expect(r.body.einvoiceStatus).toBe("queued");
    await api("accountant", "POST", `/api/v1/invoices/${inv!.id}/einvoice`);
    const n = await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE ref_type='invoice' AND ref_id=? AND type='einvoice.issue'`).bind(inv!.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
    await db().prepare(`UPDATE invoices SET einvoice_status='issued' WHERE id=?`).bind(inv!.id).run();
    expect((await api("accountant", "POST", `/api/v1/invoices/${inv!.id}/einvoice`)).status).toBe(409);
  });
});
