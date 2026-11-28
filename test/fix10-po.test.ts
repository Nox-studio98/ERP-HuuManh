import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase } from "./helpers";
import { vnDate } from "../src/worker/lib/time";
import { addDays } from "../src/worker/services/debt";
import { runPoCutoff } from "../src/worker/services/po";
import { swapBadReservations } from "../src/worker/services/reservations";
import { db, lotOf, mkB2bOrder, mkCustomer, mkProduct, mkSupplier, reservedFor, shortRows } from "./po-helpers";

// Đợt 10 — K-PO1, K-PO1b, K-B2B1, K-PO2, K-PO3, K-KHO2 (hồi quy theo docs/audit/dot10-R2-core.md)
const sys = { type: "system" as const, userId: null };
const V = "/api/v1/purchase-orders";
const future = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

beforeAll(async () => {
  await seedBase();
});

const cutoffNow = () => runPoCutoff(db(), { mode: "now", actor: sys });
const draftOf = async (pid: number) =>
  (await db().prepare(`SELECT p.* FROM purchase_orders p JOIN purchase_order_lines l ON l.po_id = p.id WHERE l.product_id = ? AND p.status = 'draft'`).bind(pid).first<any>())!;
async function sendAndConfirm(poId: number) {
  const sent = await api("owner", "POST", `${V}/${poId}/approve`, {});
  expect(sent.body.status).toBe("sent");
  const conf = await api("manager", "POST", `${V}/${poId}/supplier-response`, { action: "confirm", version: sent.body.version });
  expect(conf.body.status).toBe("confirmed");
  return conf.body as any;
}

describe("K-PO1 / K-PO1b: phần thiếu gắn PO + giữ theo ngày giao", () => {
  it("hàng về giữ cho đơn giao sớm hơn dù tạo sau; không đặt trùng", async () => {
    await mkSupplier(9801, "NCC f10a");
    await mkProduct(9811, { cost: 30000, supplierId: 9801 });
    const a = (await mkB2bOrder(await mkCustomer(), [{ productId: 9811, qty: 5 }], addDays(vnDate(), 2))).body;
    await cutoffNow();
    let d = await draftOf(9811);
    const po1 = await sendAndConfirm(d.id);
    const b = (await mkB2bOrder(await mkCustomer(), [{ productId: 9811, qty: 4 }], addDays(vnDate(), 1))).body;
    await cutoffNow();
    // B được gắn vào dòng PO đang chạy (không "mồ côi")
    const linkB = await db().prepare(`SELECT COALESCE(SUM(qty_milli),0) q FROM po_shortage_links WHERE shortage_id IN (SELECT id FROM so_shortages WHERE order_id = ?)`).bind(b.id).first<{ q: number }>();
    expect(linkB!.q).toBeGreaterThan(0);
    const total = (await db().prepare(`SELECT COALESCE(SUM(l.qty_milli),0) q FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE l.product_id = 9811 AND p.status NOT IN ('cancelled','rejected')`).first<{ q: number }>())!.q;
    expect(total).toBe(9000);
    // chỉ nhận 4kg: giữ cho B (giao sớm) trước A
    const r = await api("warehouse", "POST", `${V}/${po1.id}/receive`, { version: po1.version, lines: [{ poLineId: po1.lines[0].id, qtyMilli: 4000, unitCost: 30000 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await reservedFor(b.id)).toBe(4000);
    expect(await reservedFor(a.id)).toBe(0);
  });

  it("K-PO1b: tồn tự do (nhập thường) giữ cho phần thiếu khi chốt, không tạo PO", async () => {
    await mkSupplier(9802, "NCC f10b");
    await mkProduct(9812, { supplierId: 9802, cost: 20000 });
    const o = (await mkB2bOrder(await mkCustomer(), [{ productId: 9812, qty: 5 }])).body;
    expect(o.awaitingStock).toBe(true);
    await db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (9812,'L9812',9812,1,?,?,20000,5000,5000)`).bind(future(0), future(10)).run();
    await cutoffNow();
    expect(await draftOf(9812)).toBeNull();
    expect(await reservedFor(o.id)).toBe(5000);
    expect((await shortRows(o.id))[0].status).toBe("filled");
    expect((await lotOf(9812)).r).toBe(5000);
  });

  it("K-PO1b: giao đơn chờ hàng khi kho đã có tồn tự do", async () => {
    await mkProduct(9813, {});
    const o = (await mkB2bOrder(await mkCustomer(), [{ productId: 9813, qty: 3 }])).body;
    await db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (9813,'L9813',9813,1,?,?,20000,3000,3000)`).bind(future(0), future(10)).run();
    const pk = await api("warehouse", "POST", `/api/v1/b2b/orders/${o.id}/pick`);
    expect(pk.status).toBe(201);
    const did = pk.body.deliveryId;
    await api("warehouse", "POST", `/api/v1/deliveries/${did}/scan`, { code: "L9813" });
    await api("warehouse", "POST", `/api/v1/deliveries/${did}/ready`, {});
    await api("warehouse", "POST", `/api/v1/deliveries/${did}/ship`, { shipper: "A" });
    const ok = await api("warehouse", "POST", `/api/v1/deliveries/${did}/confirm`, { receiverName: "X", lines: [{ orderLineId: o.lines[0].id, deliveredQty: 3 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("sửa dòng đơn đã xác nhận: dòng thiếu mới vẫn gắn PO đang chạy", async () => {
    await mkSupplier(9803, "NCC f10c");
    await mkProduct(9814, { supplierId: 9803, cost: 10000 });
    const o = (await mkB2bOrder(await mkCustomer(), [{ productId: 9814, qty: 5 }])).body;
    await cutoffNow();
    await sendAndConfirm((await draftOf(9814)).id);
    const e = await api("manager", "PUT", `/api/v1/b2b/orders/${o.id}`, { lines: [{ productId: 9814, unit: "kg", qty: 6 }] });
    expect(e.status).toBe(200);
    const sh = (await shortRows(o.id))[0];
    const link = await db().prepare(`SELECT COALESCE(SUM(qty_milli),0) q FROM po_shortage_links WHERE shortage_id = ?`).bind(sh.id).first<{ q: number }>();
    expect(link!.q).toBeGreaterThan(0);
    await cutoffNow();
    const n = await db().prepare(`SELECT COUNT(*) n FROM purchase_orders p JOIN purchase_order_lines l ON l.po_id = p.id WHERE l.product_id = 9814 AND p.status = 'draft'`).first<{ n: number }>();
    expect(n!.n).toBe(1 - 1 + (6000 > 5000 ? 1 : 0)); // chỉ 1kg thiếu thêm → một nháp mới, không đặt lại 6kg
    const d = await draftOf(9814);
    const l = await db().prepare(`SELECT qty_milli q FROM purchase_order_lines WHERE po_id = ?`).bind(d.id).first<{ q: number }>();
    expect(l!.q).toBe(1000);
  });
});

describe("K-B2B1: giao thất bại rồi xác nhận lại khi đủ tồn", () => {
  it("đóng phần thiếu cũ, hết 'Chờ hàng', giao đủ", async () => {
    await mkProduct(9821, { stockMilli: 3000, cost: 10000 });
    const o = (await mkB2bOrder(await mkCustomer(), [{ productId: 9821, qty: 5 }])).body;
    expect((await shortRows(o.id))[0].qty_milli).toBe(2000);
    const pk = await api("warehouse", "POST", `/api/v1/b2b/orders/${o.id}/pick`);
    const did = pk.body.deliveryId;
    await api("warehouse", "POST", `/api/v1/deliveries/${did}/scan`, { code: "LOT-PO9821" });
    await api("warehouse", "POST", `/api/v1/deliveries/${did}/ready`, { reason: "Soạn phần có hàng" });
    await api("warehouse", "POST", `/api/v1/deliveries/${did}/ship`, { shipper: "A" });
    expect((await api("warehouse", "POST", `/api/v1/deliveries/${did}/fail`, { reason: "Khách vắng" })).status).toBe(200);
    await db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (98211,'L98211',9821,1,?,?,10000,10000,10000)`).bind(future(0), future(10)).run();
    const re = await api("manager", "POST", `/api/v1/b2b/orders/${o.id}/confirm`, {});
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.awaitingStock).toBe(false);
    expect(re.body.shortMilli).toBe(0);
    expect(await reservedFor(o.id)).toBe(5000);
    expect((await shortRows(o.id))[0].status).not.toBe("open");
  });
});

describe("K-PO2 / K-PO3: ngưỡng duyệt", () => {
  it("K-PO2: chấp nhận đề xuất làm tổng vượt ngưỡng cần chủ", async () => {
    await mkSupplier(9804, "NCC f10d");
    await mkProduct(9831, { stockMilli: 1000, cost: 15000, supplierId: 9804 });
    const created = await api("warehouse", "POST", V, { supplierId: 9804, lines: [{ productId: 9831, qty: 1000, unitCost: 15000 }] });
    expect(created.status).toBe(201);
    const sent = await api("owner", "POST", `${V}/${created.body.id}/approve`, {});
    expect(sent.body.status).toBe("sent");
    const pr = await api("manager", "POST", `${V}/${created.body.id}/supplier-response`, { action: "propose", version: sent.body.version, lines: [{ productId: 9831, qtyMilli: 3_000_000, unitCost: 20000 }] });
    expect(pr.status, JSON.stringify(pr.body)).toBe(200);
    const acc = await api("manager", "POST", `${V}/${created.body.id}/proposal/accept`, { version: pr.body.version });
    expect(acc.status).toBe(409);
    expect(acc.body.error.code).toBe("owner_approval_required");
    const okOwner = await api("owner", "POST", `${V}/${created.body.id}/proposal/accept`, { version: pr.body.version });
    expect(okOwner.status).toBe(200);
  });

  it("K-PO3: PO chưa có giá cần chủ duyệt; giá chốt không bị ghi đè khi nhận; thủ kho không tự định giá vượt ngưỡng", async () => {
    await mkSupplier(9805, "NCC f10e");
    await mkProduct(9841, { supplierId: 9805 }); // chưa từng nhập → không có giá
    const created = await api("warehouse", "POST", V, { supplierId: 9805, lines: [{ productId: 9841, qty: 1000 }] });
    expect(created.body.total ?? 0).toBe(0);
    const req = await api("manager", "POST", `${V}/${created.body.id}/approve`, {});
    expect(req.body.status).toBe("pending_approval");
    const sent = await api("owner", "POST", `${V}/${created.body.id}/approve`, {});
    expect(sent.body.status).toBe("sent");
    const conf = await api("manager", "POST", `${V}/${created.body.id}/supplier-response`, { action: "confirm", version: sent.body.version });
    const lineId = conf.body.lines[0].id;
    const r = await api("warehouse", "POST", `${V}/${created.body.id}/receive`, { version: conf.body.version, lines: [{ poLineId: lineId, qtyMilli: 1_000_000, unitCost: 90000 }] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("owner_approval_required");
    const bills = await db().prepare(`SELECT COUNT(*) n FROM supplier_bills WHERE supplier_id = 9805`).first<{ n: number }>();
    expect(bills!.n).toBe(0);
    // giá đã chốt: không ghi đè
    await mkProduct(9842, { supplierId: 9805 });
    const p2 = await api("warehouse", "POST", V, { supplierId: 9805, lines: [{ productId: 9842, qty: 2, unitCost: 10000 }] });
    const s2 = await api("manager", "POST", `${V}/${p2.body.id}/approve`, {});
    const c2 = await api("manager", "POST", `${V}/${p2.body.id}/supplier-response`, { action: "confirm", version: s2.body.version });
    const bad = await api("warehouse", "POST", `${V}/${p2.body.id}/receive`, { version: c2.body.version, lines: [{ poLineId: c2.body.lines[0].id, qtyMilli: 2000, unitCost: 99000 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("unit_cost_locked");
    const good = await api("warehouse", "POST", `${V}/${p2.body.id}/receive`, { version: c2.body.version, lines: [{ poLineId: c2.body.lines[0].id, qtyMilli: 2000 }] });
    expect(good.status).toBe(201);
    expect((await db().prepare(`SELECT total FROM supplier_bills WHERE supplier_id = 9805 AND stock_doc_id IS NOT NULL ORDER BY id DESC LIMIT 1`).first<any>()).total).toBe(20000);
  });
});

describe("K-KHO2: cách ly lô đang giữ, không có lô thay", () => {
  it("ghi phần thiếu → đơn 'Chờ hàng' và vào chốt đêm", async () => {
    await mkSupplier(9806, "NCC f10f");
    await mkProduct(9851, { stockMilli: 5000, cost: 10000, supplierId: 9806 });
    const o = (await mkB2bOrder(await mkCustomer(), [{ productId: 9851, qty: 5 }])).body;
    expect(o.awaitingStock).toBe(false);
    await db().prepare(`UPDATE lots SET status = 'quarantine' WHERE id = 9851`).run();
    const r = await swapBadReservations(db(), 1, { lotId: 9851 });
    expect(r.short[0].missingMilli).toBe(5000);
    const sh = await shortRows(o.id);
    expect(sh).toHaveLength(1);
    expect(sh[0]).toMatchObject({ qty_milli: 5000, status: "open" });
    const det = await api("manager", "GET", `/api/v1/b2b/orders/${o.id}`);
    expect(det.body.awaitingStock).toBe(true);
    const res = await cutoffNow();
    expect(res.created.length + res.updated.length).toBeGreaterThan(0);
  });
});
