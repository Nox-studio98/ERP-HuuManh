import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { allocateFefo } from "../src/worker/services/stock";
import { consumeForDeliveryStmts, reserveStmts, swapBadReservations } from "../src/worker/services/reservations";

const V = "/api/v1";
const db = () => testEnv.DB;
const iso = (offsetDays: number, offsetMs = 0) => new Date(Date.now() + offsetDays * 86400_000 + offsetMs).toISOString();

let seq = 8000;
async function mkProduct(sku: string) {
  const r = await api("manager", "POST", `${V}/products`, { sku, name: sku, baseUnit: "kg", sellByWeight: true });
  return r.body.id as number;
}
async function mkLot(productId: number, qty: number, expDays: number | null, loc = 1) {
  const id = ++seq;
  await db()
    .prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, `L${id}`, productId, loc, iso(0), expDays == null ? null : iso(expDays), 20000, qty, qty)
    .run();
  return id;
}
/** Đơn B2B 'confirmed' với 1 dòng; giữ tồn trên lot cho trước. */
async function mkOrder(productId: number, lotId: number, qty: number) {
  const id = ++seq;
  await db().batch([
    db().prepare(`INSERT INTO orders(id, code, channel, store_id, status) VALUES (?,?,?,?,?)`).bind(id, `DS-${id}`, "b2b", 1, "confirmed"),
    db().prepare(`INSERT INTO order_lines(id, order_id, product_id, unit, qty_milli, unit_price, line_total) VALUES (?,?,?,?,?,?,?)`).bind(id, id, productId, "kg", qty, 30000, 0),
  ]);
  await db().batch(reserveStmts(db(), id, [{ orderLineId: id, productId, alloc: [{ lotId, unitCost: 20000, qtyMilli: qty }] }]));
  return { orderId: id, lineId: id };
}
const lot = (id: number) => db().prepare(`SELECT * FROM lots WHERE id=?`).bind(id).first<any>();
const wasteDoc = async (role: string, lotId: number, qty: number) => {
  const d = await api(role, "POST", `${V}/stock-docs`, { type: "waste", locationId: 1 });
  const l = await api(role, "POST", `${V}/stock-docs/${d.body.id}/lines`, { lotId, qty, unit: "kg", reason: "dap" });
  expect(l.status).toBe(201);
  return api(role, "POST", `${V}/stock-docs/${d.body.id}/post`);
};

beforeAll(seedBase);

describe("B-03 waste / count of reserved lot", () => {
  it("auto-swaps reservations to another good lot (FEFO) instead of 409", async () => {
    const pid = await mkProduct("F2-A");
    const a = await mkLot(pid, 10000, 2);
    const b = await mkLot(pid, 10000, 6);
    const o = await mkOrder(pid, a, 10000); // giữ hết lô A
    const r = await wasteDoc("manager", a, 0.4); // 400 milli, dưới ngưỡng 5%
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("posted");
    expect(await lot(a)).toMatchObject({ qty_on_hand_milli: 9600, qty_reserved_milli: 9600 });
    expect(await lot(b)).toMatchObject({ qty_on_hand_milli: 10000, qty_reserved_milli: 400 });
    const sum = await db().prepare(`SELECT SUM(qty_milli) q FROM reservations WHERE order_id=? AND status='active'`).bind(o.orderId).first<any>();
    expect(sum.q).toBe(10000);
  });

  it("count down below reserved also swaps; no replacement → 409 with reservedQty + quarantine hint", async () => {
    const pid = await mkProduct("F2-B");
    const a = await mkLot(pid, 10000, 2);
    const b = await mkLot(pid, 10000, 6);
    await mkOrder(pid, a, 10000);
    const d = await api("manager", "POST", `${V}/stock-docs`, { type: "count", locationId: 1 });
    await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { lotId: a, countedQty: 9.5, unit: "kg" }); // -0.5kg
    const p = await api("manager", "POST", `${V}/stock-docs/${d.body.id}/post`);
    expect(p.body.status).toBe("posted");
    expect(await lot(a)).toMatchObject({ qty_on_hand_milli: 9500, qty_reserved_milli: 9500 });
    expect((await lot(b)).qty_reserved_milli).toBe(500);

    // lô duy nhất: không có chỗ chuyển
    const pid2 = await mkProduct("F2-B2");
    const only = await mkLot(pid2, 10000, 3);
    await mkOrder(pid2, only, 10000);
    const w = await wasteDoc("manager", only, 0.3);
    expect(w.status).toBe(409);
    expect(w.body.error.code).toBe("insufficient_stock");
    expect(w.body.error.details).toMatchObject({ lotId: only, reservedQty: 10000, hint: "quarantine" });
  });
});

describe("B-03 quarantine", () => {
  it("validates permission/reason; quarantine swaps reservations, flags short orders, notifies managers", async () => {
    const pid = await mkProduct("F2-Q");
    const bad = await mkLot(pid, 10000, 2);
    const good = await mkLot(pid, 6000, 6);
    const o1 = await mkOrder(pid, bad, 4000); // thay được hết
    const o2 = await mkOrder(pid, bad, 6000); // chỉ thay được 2000 (good còn 6000−4000)

    expect((await api("cashier", "POST", `${V}/lots/${bad}/quarantine`, { reason: "dập nát" })).status).toBe(403);
    expect((await api("warehouse", "POST", `${V}/lots/${bad}/quarantine`, {})).status).toBe(422);

    const q = await api("warehouse", "POST", `${V}/lots/${bad}/quarantine`, { reason: "dập nát, thối" });
    expect(q.status).toBe(200);
    expect(q.body.lot).toMatchObject({ status: "quarantine", quarantineReason: "dập nát, thối" });
    expect(q.body.swappedOrders).toEqual(expect.arrayContaining([o1.orderId, o2.orderId]));
    expect(q.body.shortOrders).toEqual([expect.objectContaining({ orderId: o2.orderId, missingMilli: 4000 })]);

    expect(await lot(bad)).toMatchObject({ status: "quarantine", qty_reserved_milli: 0, qty_on_hand_milli: 10000 });
    expect(await lot(good)).toMatchObject({ qty_reserved_milli: 6000 });
    const ord = await db().prepare(`SELECT reservation_short_milli m FROM orders WHERE id=?`).bind(o2.orderId).first<any>();
    expect(ord.m).toBe(4000);
    expect((await db().prepare(`SELECT reservation_short_milli m FROM orders WHERE id=?`).bind(o1.orderId).first<any>()).m).toBe(0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action IN ('lot.quarantine','reservation.short_after_swap')`).first<any>()).n).toBeGreaterThanOrEqual(2);
    expect((await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE type='notify.managers' AND ref_id=?`).bind(o2.orderId).first<any>()).n).toBe(1);

    // thông báo trong ứng dụng: quản lý thấy, thủ kho (không có quyền duyệt) thì không
    const n = await api("manager", "GET", `${V}/notifications?unread=1`);
    expect(n.body.items.some((x: any) => x.kind === "reservation_short" && x.refId === o2.orderId)).toBe(true);
    expect((await api("warehouse", "GET", `${V}/notifications`)).body.items).toEqual([]);
    expect((await api("manager", "POST", `${V}/notifications/${n.body.items[0].id}/read`)).status).toBe(200);

    // không quarantine hai lần; lô cách ly không bán/giữ được
    expect((await api("manager", "POST", `${V}/lots/${bad}/quarantine`, { reason: "lần hai" })).status).toBe(409);
    await expect(allocateFefo(db(), pid, 1000, 1)).rejects.toMatchObject({ code: "insufficient_stock" });

    // sau cách ly: hao hụt được toàn bộ lô vì không còn bị giữ (hao hụt lớn → chờ duyệt rồi áp dụng)
    const w = await wasteDoc("manager", bad, 10);
    expect(["posted", "pending_approval"]).toContain(w.body.status);
    // unquarantine cần quyền duyệt
    const pid2 = await mkProduct("F2-Q2");
    const l2 = await mkLot(pid2, 1000, 3);
    await api("manager", "POST", `${V}/lots/${l2}/quarantine`, { reason: "kiểm tra" });
    expect((await api("warehouse", "POST", `${V}/lots/${l2}/release-quarantine`, { reason: "ok" })).status).toBe(403);
    expect((await api("manager", "POST", `${V}/lots/${l2}/release-quarantine`, { reason: "đã kiểm tra lại" })).status).toBe(200);
    expect((await lot(l2)).status).toBe("active");
  });

  it("cron-style swap is scoped by store and can target one lot", async () => {
    const pid = await mkProduct("F2-S");
    const bad = await mkLot(pid, 3000, 2);
    const good = await mkLot(pid, 3000, 5);
    const o = await mkOrder(pid, bad, 1000);
    await db().prepare(`UPDATE lots SET status='quarantine' WHERE id=?`).bind(bad).run();
    expect((await swapBadReservations(db(), 999, { lotId: bad })).swapped).toEqual([]); // cửa hàng khác
    expect((await swapBadReservations(db(), 1, { lotId: bad })).swapped).toEqual([o.orderId]);
    expect((await lot(good)).qty_reserved_milli).toBe(1000);
  });
});

describe("B-04 delivery never consumes bad lots", () => {
  it("expired reserved lot: swapped to a good lot at delivery time", async () => {
    const pid = await mkProduct("F2-D1");
    const a = await mkLot(pid, 5000, 1);
    const b = await mkLot(pid, 5000, 5);
    const o = await mkOrder(pid, a, 2000);
    await db().prepare(`UPDATE lots SET expires_at=? WHERE id=?`).bind(iso(0, -60_000), a).run(); // vừa hết hạn
    const res = await consumeForDeliveryStmts(db(), o.orderId, new Map([[o.lineId, 2000]]), "delivery", 1, 1);
    expect(res.allocByLine.get(o.lineId)).toEqual([expect.objectContaining({ lotId: b, qtyMilli: 2000 })]);
    await db().batch(res.stmts);
    expect((await lot(a)).qty_on_hand_milli).toBe(5000);
    expect((await lot(b)).qty_on_hand_milli).toBe(3000);
  });

  it("no replacement: 409 lot_expired listing lines; order flagged", async () => {
    const pid = await mkProduct("F2-D2");
    const a = await mkLot(pid, 5000, 1);
    const o = await mkOrder(pid, a, 2000);
    await db().prepare(`UPDATE lots SET expires_at=? WHERE id=?`).bind(iso(0, -60_000), a).run();
    await expect(consumeForDeliveryStmts(db(), o.orderId, new Map([[o.lineId, 2000]]), "delivery", 1, 1)).rejects.toMatchObject({
      status: 409,
      code: "lot_expired",
      details: { lines: [expect.objectContaining({ orderLineId: o.lineId, missingMilli: 2000 })] },
    });
    expect((await db().prepare(`SELECT reservation_short_milli m FROM orders WHERE id=?`).bind(o.orderId).first<any>()).m).toBe(2000);
  });

  it("POS never sells expired / quarantined lots", async () => {
    const pid = await mkProduct("F2-D3");
    await mkLot(pid, 5000, -1); // hết hạn
    const q = await mkLot(pid, 5000, 3);
    await db().prepare(`UPDATE lots SET status='quarantine' WHERE id=?`).bind(q).run();
    await expect(allocateFefo(db(), pid, 1000, 1)).rejects.toMatchObject({ code: "insufficient_stock" });
  });
});
