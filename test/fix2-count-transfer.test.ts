import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { allocateFefo } from "../src/worker/services/stock";

const V = "/api/v1";
const db = () => testEnv.DB;
const iso = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
let seq = 900000;

async function mkProduct(sku: string) {
  return (await api("manager", "POST", `${V}/products`, { sku, name: sku, baseUnit: "kg", sellByWeight: true })).body.id as number;
}
async function mkLot(productId: number, qty: number, expDays = 5, loc = 1) {
  const id = ++seq;
  const r = await db()
    .prepare(`INSERT INTO lots(lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(`C${id}`, productId, loc, iso(-1), iso(expDays), 50000, qty, qty)
    .run();
  const lid = r.meta.last_row_id as number;
  return lid;
}
const lot = (id: number) => db().prepare(`SELECT * FROM lots WHERE id=?`).bind(id).first<any>();
async function doc(role: string, type: string, extra: any = {}) {
  return (await api(role, "POST", `${V}/stock-docs`, { type, locationId: 1, ...extra })).body.id as number;
}
const addLine = (role: string, id: number, body: any) => api(role, "POST", `${V}/stock-docs/${id}/lines`, body);
const post = (role: string, id: number) => api(role, "POST", `${V}/stock-docs/${id}/post`);

beforeAll(seedBase);

describe("B-02 count diff against on-hand at counting time", () => {
  it("movement between count and post is not turned into a phantom diff; warning returned", async () => {
    const pid = await mkProduct("F2C-1");
    const l = await mkLot(pid, 20000, 5);
    const c = await doc("manager", "count");
    await addLine("manager", c, { lotId: l, countedQty: 20, unit: "kg" }); // đếm đúng 20kg
    // hao hụt 1kg sau khi đếm
    const w = await doc("manager", "waste");
    await addLine("manager", w, { lotId: l, qty: 0.4, unit: "kg", reason: "dap" });
    expect((await post("manager", w)).body.status).toBe("posted");
    const w2 = await doc("manager", "waste");
    await addLine("manager", w2, { lotId: l, qty: 0.4, unit: "kg", reason: "dap" });
    expect((await post("manager", w2)).body.status).toBe("posted");
    expect((await lot(l)).qty_on_hand_milli).toBe(19200);

    const p = await post("manager", c);
    expect(p.status).toBe(200);
    expect(p.body.status).toBe("posted");
    expect(p.body.warnings).toEqual([expect.objectContaining({ code: "lot_moved_since_count", lotId: l, snapshotMilli: 20000, currentMilli: 19200, deltaMilli: -800 })]);
    expect(p.body.lines[0]).toMatchObject({ systemQtyMilli: 20000, qtyMilli: 20000, diffMilli: 0 });
    expect((await lot(l)).qty_on_hand_milli).toBe(19200); // KHÔNG bị cộng lại về 20000
    expect((await db().prepare(`SELECT COUNT(*) n FROM stock_moves WHERE lot_id=? AND move_type='adjust'`).bind(l).first<any>()).n).toBe(0);
  });

  it("real difference is applied on top of concurrent movements", async () => {
    const pid = await mkProduct("F2C-2");
    const l = await mkLot(pid, 20000, 5);
    const c = await doc("manager", "count");
    await addLine("manager", c, { lotId: l, countedQty: 19, unit: "kg" }); // thiếu 1kg
    const w = await doc("manager", "waste");
    await addLine("manager", w, { lotId: l, qty: 0.4, unit: "kg", reason: "dap" });
    await post("manager", w);
    const p = await post("manager", c);
    expect(p.body.status).toBe("posted");
    expect((await lot(l)).qty_on_hand_milli).toBe(20000 - 400 - 1000);
  });

  it("stale count that would go negative is rejected", async () => {
    const pid = await mkProduct("F2C-3");
    const l = await mkLot(pid, 2000, 5);
    const c = await doc("manager", "count");
    await addLine("manager", c, { lotId: l, countedQty: 0, unit: "kg" }); // diff -2000
    await db().prepare(`UPDATE lots SET qty_on_hand_milli = 500 WHERE id=?`).bind(l).run();
    const p = await post("manager", c);
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe("count_stale");
  });

  it("EC-18: lock_lots blocks selling and out-docs at that location until the count is closed", async () => {
    const pid = await mkProduct("F2C-4");
    const l = await mkLot(pid, 5000, 5);
    const c = await doc("manager", "count", { lockLots: true });
    expect((await api("manager", "GET", `${V}/stock-docs/${c}`)).body.lockLots).toBe(true);
    await expect(allocateFefo(db(), pid, 1000, 1)).rejects.toMatchObject({ code: "insufficient_stock" });
    const w = await doc("manager", "waste");
    await addLine("manager", w, { lotId: l, qty: 0.1, unit: "kg", reason: "dap" });
    const r = await post("manager", w);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("count_in_progress");
    await api("manager", "POST", `${V}/stock-docs/${c}/cancel`);
    expect((await allocateFefo(db(), pid, 1000, 1))[0].lotId).toBe(l);
    expect((await post("manager", w)).status).toBe(200);
  });

  it("B-10: count by a creator who cannot approve waits for approval when there is a difference", async () => {
    const pid = await mkProduct("F2C-5");
    const l = await mkLot(pid, 5000, 5);
    const c = await doc("warehouse", "count");
    await addLine("warehouse", c, { lotId: l, countedQty: 4.9, unit: "kg" });
    expect((await post("warehouse", c)).body.status).toBe("pending_approval");
    const c2 = await doc("warehouse", "count");
    await addLine("warehouse", c2, { lotId: l, countedQty: 5, unit: "kg" });
    expect((await post("warehouse", c2)).body.status).toBe("posted"); // không chênh lệch → không cần duyệt
  });
});

describe("B-19 transfer in transit", () => {
  it("out creates an in_transit doc, receive creates the lot keeping dates/qty_in; lost qty becomes waste", async () => {
    const pid = await mkProduct("F2T-1");
    const l = await mkLot(pid, 20000, 4);
    const src = await lot(l);
    const t = await doc("manager", "transfer", { toLocationId: 2 });
    const ln = await addLine("manager", t, { lotId: l, qty: 5, unit: "kg" });
    const lineId = ln.body.lines[0].id;
    const p = await post("manager", t);
    expect(p.body).toMatchObject({ status: "posted", transferStatus: "in_transit" });
    // đang đi đường: không còn ở nguồn, chưa có ở đích
    expect((await lot(l)).qty_on_hand_milli).toBe(15000);
    expect((await db().prepare(`SELECT COUNT(*) n FROM lots WHERE product_id=? AND location_id=2`).bind(pid).first<any>()).n).toBe(0);

    // nhận thiếu cần lý do
    const bad = await api("manager", "POST", `${V}/stock-docs/${t}/receive`, { lines: [{ lineId, qty: 4 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("reason_required");
    expect((await api("manager", "POST", `${V}/stock-docs/${t}/receive`, { lines: [{ lineId, qty: 6 }], reason: "x" })).body.error.code).toBe("over_receive");
    expect((await api("cashier", "POST", `${V}/stock-docs/${t}/receive`, {})).status).toBe(403);

    const rc = await api("manager", "POST", `${V}/stock-docs/${t}/receive`, { lines: [{ lineId, qty: 4 }], reason: "rơi vỡ khi vận chuyển" });
    expect(rc.status).toBe(200);
    expect(rc.body.transferStatus).toBe("received");
    expect(rc.body.received).toEqual([{ lineId, sentMilli: 5000, receivedMilli: 4000, lostMilli: 1000 }]);
    const dest = await db().prepare(`SELECT * FROM lots WHERE product_id=? AND location_id=2`).bind(pid).first<any>();
    expect(dest).toMatchObject({ qty_on_hand_milli: 4000, qty_in_milli: 20000, expires_at: src.expires_at, received_at: src.received_at, unit_cost: 50000 });
    expect(dest.lot_code).toMatch(/^HML\d{8}$/);
    const mv = await db().prepare(`SELECT move_type t, qty_delta_milli q FROM stock_moves WHERE ref_type='stock_doc' AND ref_id=? ORDER BY id`).bind(t).all<any>();
    expect(mv.results).toEqual([{ t: "transfer_out", q: -5000 }, { t: "transfer_in", q: 5000 }, { t: "waste", q: -1000 }]);
    // nhận lần hai bị chặn
    const again = await api("manager", "POST", `${V}/stock-docs/${t}/receive`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_received");
  });

  it("quarantined / expired lots cannot be transferred", async () => {
    const pid = await mkProduct("F2T-2");
    const l = await mkLot(pid, 5000, 4);
    await db().prepare(`UPDATE lots SET status='quarantine' WHERE id=?`).bind(l).run();
    const t = await doc("manager", "transfer", { toLocationId: 2 });
    const r = await addLine("manager", t, { lotId: l, qty: 1, unit: "kg" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("lot_not_active");
  });

  it("receive on a non-transfer or draft doc is rejected", async () => {
    const w = await doc("manager", "waste");
    expect((await api("manager", "POST", `${V}/stock-docs/${w}/receive`, {})).status).toBe(409);
  });
});
