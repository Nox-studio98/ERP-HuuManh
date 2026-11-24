import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { addDays } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";

const db = () => testEnv.DB;
const V = "/api/v1";
const tomorrow = () => addDays(vnDate(), 1);
const today = vnDate();
let seq = 0;
const uuid = () => `sec-stock-${Date.now()}-${++seq}-aaaa`;
const lot = async (id: number) => (await db().prepare(`SELECT qty_on_hand_milli h, qty_reserved_milli r FROM lots WHERE id=?`).bind(id).first<{ h: number; r: number }>())!;

async function mkProduct(id: number, qtyMilli: number, cost: number, price: number, extra = "") {
  const d = db();
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + 10 * 86400_000).toISOString();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight, group_id${extra ? ", allow_preorder" : ""}) VALUES (?,?,?,'kg',1,1${extra ? ",1" : ""})`).bind(id, `SP${id}`, `Hàng ${id}`),
    d.prepare(`INSERT INTO product_units(product_id, unit, factor_milli) VALUES (?,'thung',10000)`).bind(id),
    d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (?,?,?,1,?,?,?,?,?)`).bind(id, `LOT-SEC-${id}`, id, now, exp, cost, qtyMilli, qtyMilli),
    d.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,?,?,'2020-01-01T00:00:00Z','active',1)`).bind(id, price),
  ]);
}

async function newCustomer(name: string, creditLimit = 100_000_000) {
  const r = await api("manager", "POST", `${V}/customers`, {
    name, type: "b2b", customerGroupId: 1, creditLimit, paymentTermsDays: 15,
    contacts: [{ name: "Người nhận", phone: "0900000001", isReceiver: true }],
    addresses: [{ label: "Kho", address: "1 Lê Lợi", isDefault: true }],
  });
  expect(r.status).toBe(201);
  return { id: r.body.id as number, addressId: r.body.addresses[0].id as number };
}
const b2bOrder = (c: { id: number; addressId: number }, lines: any[], role = "manager") =>
  api(role, "POST", `${V}/b2b/orders`, { customerId: c.id, addressId: c.addressId, deliveryDate: tomorrow(), clientUuid: uuid(), lines });

/** Đơn sỉ → soạn → giao đủ; trả về order + dòng + hoá đơn. */
async function deliverFull(c: { id: number; addressId: number }, pid: number, qty: number) {
  const o = await b2bOrder(c, [{ productId: pid, unit: "kg", qty }]);
  expect(o.status).toBe(201);
  const pick = await api("warehouse", "POST", `${V}/b2b/orders/${o.body.id}/pick`);
  expect(pick.status).toBe(201);
  const did = pick.body.deliveryId;
  expect((await api("warehouse", "POST", `${V}/deliveries/${did}/ready`, { reason: "soạn đủ theo phiếu" })).status).toBe(200);
  expect((await api("warehouse", "POST", `${V}/deliveries/${did}/ship`, { shipper: "Tài xế" })).status).toBe(200);
  const lineId = o.body.lines[0].id;
  const cf = await api("warehouse", "POST", `${V}/deliveries/${did}/confirm`, { receiverName: "Người nhận", lines: [{ orderLineId: lineId, deliveredQty: qty }] });
  expect(cf.status).toBe(200);
  return { orderId: o.body.id as number, lineId: lineId as number, invoiceId: cf.body.invoice.id as number };
}

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO delivery_zones(id, name, districts_json, fee, free_over, min_order) VALUES (1,'Nội thành','["Quận 1"]',0,0,0)`),
    db().prepare(`INSERT INTO delivery_slots(id, label, start_time, end_time, capacity) VALUES (31,'8:00–10:00','08:00','10:00',1)`),
  ]);
  await mkProduct(9001, 100000, 30000, 50000);
  await mkProduct(9002, 100000, 30000, 50000);
  await mkProduct(9003, 100000, 30000, 50000);
  await mkProduct(9004, 100000, 30000, 50000);
  await mkProduct(9005, 100000, 30000, 50000);
  await mkProduct(9006, 50000, 30000, 100000);
});

describe("reservations: no double release (audit #7)", () => {
  it("concurrent B2B cancels release the reservation once and never steal another order's reservation", async () => {
    const c = await newCustomer("KH huỷ đôi");
    const other = await b2bOrder(c, [{ productId: 9001, unit: "kg", qty: 7 }]);
    expect(other.status).toBe(201);
    const a = await b2bOrder(c, [{ productId: 9001, unit: "kg", qty: 3 }]);
    expect(a.status).toBe(201);
    expect((await lot(9001)).r).toBe(10000);
    const res = await Promise.all([
      api("manager", "POST", `${V}/b2b/orders/${a.body.id}/cancel`, { reason: "huỷ đồng thời A" }),
      api("manager", "POST", `${V}/b2b/orders/${a.body.id}/cancel`, { reason: "huỷ đồng thời B" }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await lot(9001)).r).toBe(7000); // chỉ trả đúng phần của đơn A, phần của đơn kia còn nguyên
  });

  it("concurrent delivery /fail and delivery confirm cannot both release/consume", async () => {
    const c = await newCustomer("KH giao đôi");
    const o = await b2bOrder(c, [{ productId: 9002, unit: "kg", qty: 5 }]);
    const pick = await api("warehouse", "POST", `${V}/b2b/orders/${o.body.id}/pick`);
    const did = pick.body.deliveryId;
    await api("warehouse", "POST", `${V}/deliveries/${did}/ready`, { reason: "đủ" });
    await api("warehouse", "POST", `${V}/deliveries/${did}/ship`, {});
    const before = await lot(9002);
    const lineId = o.body.lines[0].id;
    const res = await Promise.all([
      api("warehouse", "POST", `${V}/deliveries/${did}/confirm`, { receiverName: "A", lines: [{ orderLineId: lineId, deliveredQty: 5 }] }),
      api("warehouse", "POST", `${V}/deliveries/${did}/confirm`, { receiverName: "B", lines: [{ orderLineId: lineId, deliveredQty: 5 }] }),
      api("warehouse", "POST", `${V}/deliveries/${did}/fail`, { reason: "khách vắng nhà" }),
    ]);
    expect(res.filter((r) => r.status === 200).length).toBe(1);
    const after = await lot(9002);
    const inv = await db().prepare(`SELECT COUNT(*) n FROM invoices WHERE order_id=? AND kind='sale'`).bind(o.body.id).first<{ n: number }>();
    const delivered = res.some((r) => r.status === 200 && r.body.status === "delivered");
    if (delivered) {
      expect(after.h).toBe(before.h - 5000);
      expect(inv!.n).toBe(1);
    } else {
      expect(after.h).toBe(before.h);
      expect(inv!.n).toBe(0);
    }
    expect(after.r).toBe(before.r - 5000); // giữ tồn nhả đúng một lần
  });
});

describe("inventory post vs cancel (audit #8)", () => {
  it("never ends cancelled while stock was received, and bills use the document amount", async () => {
    await db().prepare(`INSERT INTO suppliers(id, code, name, payment_terms_days) VALUES (9001,'NCC-SEC','NCC Sec',0)`).run();
    for (let i = 0; i < 6; i++) {
      const doc = await api("warehouse", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1 });
      expect(doc.status).toBe(201);
      expect((await api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { productId: 9003, unit: "kg", qty: 2, unitCost: 31000 })).status).toBe(201);
      await Promise.all([
        api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/post`),
        api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/cancel`),
      ]);
      const d = await db().prepare(`SELECT status FROM stock_docs WHERE id=?`).bind(doc.body.id).first<{ status: string }>();
      const lots = await db().prepare(`SELECT COUNT(*) n FROM lots WHERE receipt_doc_id=?`).bind(doc.body.id).first<{ n: number }>();
      expect(["posted", "cancelled"]).toContain(d!.status);
      expect(lots!.n).toBe(d!.status === "posted" ? 1 : 0);
    }
    // thành tiền = SL × đơn giá chứng từ, làm tròn một lần: 3 thùng × 105.333 = 315.999 (quy về kg rồi nhân lại sẽ ra 315.990)
    const doc = await api("warehouse", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId: 9001, supplierRef: "HD-NCC-1" });
    await api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { productId: 9003, unit: "thung", qty: 3, unitCost: 105333 });
    expect((await api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/post`)).status).toBe(200);
    const bill = await db().prepare(`SELECT total FROM supplier_bills WHERE stock_doc_id=?`).bind(doc.body.id).first<{ total: number }>();
    expect(bill!.total).toBe(315_999);
  });
});

describe("B2B credit exposure (audit #9)", () => {
  it("open confirmed orders count towards the credit limit", async () => {
    const c = await newCustomer("KH hạn mức mở", 1_000_000);
    const a = await b2bOrder(c, [{ productId: 9004, unit: "kg", qty: 12 }]); // 600.000
    expect(a.status).toBe(201);
    expect(a.body.status).toBe("confirmed");
    const b = await b2bOrder(c, [{ productId: 9004, unit: "kg", qty: 12 }]); // +600.000 > 1.000.000
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("credit_blocked");
  });

  it("two concurrent orders cannot both pass the limit", async () => {
    const c = await newCustomer("KH hạn mức đua", 1_000_000);
    const res = await Promise.all([b2bOrder(c, [{ productId: 9004, unit: "kg", qty: 12 }]), b2bOrder(c, [{ productId: 9004, unit: "kg", qty: 12 }])]);
    const confirmed = await db().prepare(`SELECT COUNT(*) n FROM orders WHERE customer_id=? AND status='confirmed'`).bind(c.id).first<{ n: number }>();
    expect(confirmed!.n).toBe(1);
    expect(res.filter((r) => r.status === 409).length).toBe(1);
  });
});

describe("B2B return: race and P&L (audit #14)", () => {
  it("returns reduce revenue and COGS in /reports/pnl and cannot exceed delivered quantity concurrently", async () => {
    const c = await newCustomer("KH trả hàng");
    const d = await deliverFull(c, 9005, 10); // doanh thu 500.000, giá vốn 300.000
    const pnl0 = (await api("owner", "GET", `${V}/reports/pnl?from=${today}&to=${today}`)).body;
    const stock0 = (await lot(9005)).h;
    const r1 = await api("manager", "POST", `${V}/b2b/orders/${d.orderId}/returns`, { lines: [{ orderLineId: d.lineId, qty: 4, unit: "kg", restock: true, reason: "Hư 4kg" }] });
    expect(r1.status).toBe(201);
    const pnl1 = (await api("owner", "GET", `${V}/reports/pnl?from=${today}&to=${today}`)).body;
    expect(pnl1.returnsTotal - pnl0.returnsTotal).toBe(200_000);
    expect(pnl1.revenue - pnl0.revenue).toBe(-200_000);
    expect(pnl1.cogs - pnl0.cogs).toBe(-120_000);
    expect((await lot(9005)).h).toBe(stock0 + 4000);
    // còn lại 6kg: hai yêu cầu trả 6kg đồng thời → chỉ một thành công
    const body = { lines: [{ orderLineId: d.lineId, qty: 6, unit: "kg", restock: true, reason: "Trả nốt" }] };
    const res = await Promise.all([api("manager", "POST", `${V}/b2b/orders/${d.orderId}/returns`, body), api("manager", "POST", `${V}/b2b/orders/${d.orderId}/returns`, body)]);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.find((r) => r.status !== 201)!.status).toBeGreaterThanOrEqual(409);
    expect((await lot(9005)).h).toBe(stock0 + 10000);
    const adj = await db().prepare(`SELECT COALESCE(SUM(total),0) s FROM invoices WHERE order_id=? AND kind='adjustment'`).bind(d.orderId).first<{ s: number }>();
    expect(adj!.s).toBe(-500_000);
    // các đơn trả không lẫn vào danh sách đơn sỉ
    const list = await api("manager", "GET", `${V}/b2b/orders?customerId=${c.id}`);
    expect(list.body.items).toHaveLength(1);
  });
});

describe("online refunds / payments / slots (audit #4, #17)", () => {
  it("concurrent refunds of a cancelled paid order refund only once", async () => {
    const r = await db().prepare(
      `INSERT INTO orders(code, channel, kind, store_id, status, total, paid_total, payment_method, payment_status, tracking_token) VALUES ('DH-SEC-RF','online','sale',1,'cancelled',100000,100000,'transfer','paid','tok-sec-rf') RETURNING id`,
    ).first<{ id: number }>();
    await db().prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?, 'transfer', 100000, 2, 'confirmed')`).bind(r!.id).run();
    const res = await Promise.all([
      api("accountant", "POST", `${V}/online-orders/${r!.id}/refund`),
      api("accountant", "POST", `${V}/online-orders/${r!.id}/refund`),
    ]);
    expect(res.map((x) => x.status).sort()).toEqual([200, 409]);
    const s = await db().prepare(`SELECT SUM(amount) s FROM payments WHERE order_id=?`).bind(r!.id).first<{ s: number }>();
    expect(s!.s).toBe(0);
    const o = await db().prepare(`SELECT paid_total FROM orders WHERE id=?`).bind(r!.id).first<{ paid_total: number }>();
    expect(o!.paid_total).toBe(0);
  });

  it("concurrent mark-paid adds paid_total once", async () => {
    const r = await db().prepare(
      `INSERT INTO orders(code, channel, kind, store_id, status, total, paid_total, payment_method, payment_status, tracking_token) VALUES ('DH-SEC-MP','online','sale',1,'confirmed',80000,0,'transfer','unpaid','tok-sec-mp') RETURNING id`,
    ).first<{ id: number }>();
    const res = await Promise.all([
      api("accountant", "POST", `${V}/online-orders/${r!.id}/mark-paid`, { ref: "SEC-REF-1" }),
      api("accountant", "POST", `${V}/online-orders/${r!.id}/mark-paid`, { ref: "SEC-REF-2" }),
    ]);
    expect(res.filter((x) => x.status === 200)).toHaveLength(1);
    const o = await db().prepare(`SELECT paid_total FROM orders WHERE id=?`).bind(r!.id).first<{ paid_total: number }>();
    expect(o!.paid_total).toBe(80000);
    const p = await db().prepare(`SELECT COUNT(*) n FROM payments WHERE order_id=?`).bind(r!.id).first<{ n: number }>();
    expect(p!.n).toBe(1);
  });

  it("slot capacity holds under concurrent social orders (capacity 1)", async () => {
    const mk = () => api("online_staff", "POST", `${V}/online-orders`, {
      clientUuid: crypto.randomUUID(), receiverName: "Chị Lan", receiverPhone: "0988000111", addressLine: "5 Nguyễn Huệ", district: "quan 1", province: "TP.HCM",
      items: [{ productId: 9004, unit: "kg", qty: 1 }], paymentMethod: "cod", slotDate: "2099-02-02", slotId: 31,
    });
    const res = await Promise.all([mk(), mk()]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.body.error.code).toBe("slot_full");
    const n = await db().prepare(`SELECT COUNT(*) n FROM orders WHERE slot_id=31 AND slot_date='2099-02-02' AND status NOT IN ('cancelled','draft')`).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
});

describe("pre-orders: deposit refund once (audit #7)", () => {
  it("concurrent cancels refund the deposit once and release the reservation once", async () => {
    expect((await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 })).status).toBe(201);
    const before = await lot(9006);
    const p = await api("cashier", "POST", `${V}/pos/preorders`, {
      customer: { name: "Chị Mai", phone: "0977000111" }, pickupDate: tomorrow(), lines: [{ productId: 9006, unit: "kg", qty: 4 }], deposit: { amount: 200000, method: "cash" },
    });
    expect(p.status).toBe(201);
    expect((await lot(9006)).r).toBe(before.r + 4000);
    const body = { refundDeposit: true, reason: "Khách đổi ý" };
    const res = await Promise.all([api("cashier", "POST", `${V}/pos/preorders/${p.body.id}/cancel`, body), api("cashier", "POST", `${V}/pos/preorders/${p.body.id}/cancel`, body)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await lot(9006)).r).toBe(before.r);
    const refunds = await db().prepare(`SELECT COUNT(*) n FROM cash_vouchers WHERE ref_type='order_deposit' AND direction='out' AND ref_id=?`).bind(p.body.id).first<{ n: number }>();
    expect(refunds!.n).toBe(1);
  });
});
