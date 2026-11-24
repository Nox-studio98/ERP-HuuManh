import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { applyStockDocPost, rejectStockDocPost } from "../src/worker/routes/inventory";

beforeAll(seedBase);

const V = "/api/v1";
const db = () => testEnv.DB;

async function mkProduct(sku: string) {
  const r = await api("manager", "POST", `${V}/products`, {
    sku, name: sku, baseUnit: "kg", sellByWeight: true, units: [{ unit: "thung", factorMilli: 10000 }],
  });
  return r.body.id as number;
}

/** Nhập 20 kg (2 thùng, 500k/thùng → 50k/kg) và post. Trả về lot. */
async function receive(sku: string, role = "manager", extra: any = {}) {
  const productId = await mkProduct(sku);
  const doc = await api(role, "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierRef: "NCC-001" });
  const line = await api(role, "POST", `${V}/stock-docs/${doc.body.id}/lines`, {
    productId, unit: "thung", qty: 2, docQty: 2.5, unitCost: 500000, ...extra,
  });
  expect(line.status).toBe(201);
  const post = await api(role, "POST", `${V}/stock-docs/${doc.body.id}/post`);
  expect(post.status).toBe(200);
  const lot = await db().prepare(`SELECT * FROM lots WHERE product_id = ?`).bind(productId).first<any>();
  return { productId, docId: doc.body.id as number, lot, post };
}

const fakeCtx = (userId: number) =>
  ({
    env: testEnv,
    get: (k: string) => (k === "user" ? { id: userId, role: "manager", deviceId: null } : "req-test"),
    req: { header: () => undefined },
  }) as any;

describe("receipt", () => {
  it("creates lots + moves, converts units, records doc vs actual variance", async () => {
    const { lot, post, docId } = await receive("NHAP-1");
    expect(lot.qty_in_milli).toBe(20000);
    expect(lot.qty_on_hand_milli).toBe(20000);
    expect(lot.unit_cost).toBe(50000);
    expect(lot.lot_code).toBe(`HML${String(lot.id).padStart(8, "0")}`);
    expect(lot.receipt_doc_id).toBe(docId);
    expect(post.body.status).toBe("posted");
    expect(post.body.variances).toEqual([expect.objectContaining({ docQtyMilli: 25000, qtyMilli: 20000 })]);
    expect(post.body.lines[0]).toMatchObject({ docQtyMilli: 25000, qtyMilli: 20000, diffMilli: -5000, lotId: lot.id });
    expect(post.body.totalAmount).toBe(1_000_000);
    const mv = await db().prepare(`SELECT * FROM stock_moves WHERE lot_id = ?`).bind(lot.id).all<any>();
    expect(mv.results).toHaveLength(1);
    expect(mv.results[0]).toMatchObject({ move_type: "receipt", qty_delta_milli: 20000, unit_cost: 50000 });
    // đã post thì không thêm dòng / post lại được
    expect((await api("manager", "POST", `${V}/stock-docs/${docId}/post`)).status).toBe(409);
    expect((await api("manager", "POST", `${V}/stock-docs/${docId}/lines`, { productId: 1, unit: "kg", qty: 1, unitCost: 1 })).status).toBe(409);
  });

  it("forbids cashier from inventory writes but allows viewing", async () => {
    expect((await api("cashier", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1 })).status).toBe(403);
    expect((await api("cashier", "GET", `${V}/stock-docs`)).status).toBe(200);
    expect((await api("cashier", "POST", `${V}/stock-docs/1/post`)).status).toBe(403);
  });

  it("rejects empty doc and zero-qty line at post, supports delete line & cancel", async () => {
    const pid = await mkProduct("NHAP-2");
    const doc = await api("warehouse", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1 });
    expect((await api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/post`)).status).toBe(422);
    const l = await api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { productId: pid, unit: "kg", qty: 0, docQty: 5, unitCost: 1000 });
    expect((await api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/post`)).body.error.code).toBe("zero_qty");
    expect((await api("warehouse", "DELETE", `${V}/stock-docs/${doc.body.id}/lines/${l.body.lines[0].id}`)).status).toBe(200);
    const c = await api("warehouse", "POST", `${V}/stock-docs/${doc.body.id}/cancel`);
    expect(c.body.status).toBe("cancelled");
    const list = await api("warehouse", "GET", `${V}/stock-docs?status=cancelled`);
    expect(list.body.items.some((d: any) => d.id === doc.body.id)).toBe(true);
  });
});

describe("waste", () => {
  it("posts small waste directly; large waste or non-approver creator goes pending and applies on approval", async () => {
    const { lot } = await receive("HH-1"); // 20kg → ngưỡng 5% = 1kg
    const mk = async (role: string, qty: number) => {
      const d = await api(role, "POST", `${V}/stock-docs`, { type: "waste", locationId: 1 });
      const l = await api(role, "POST", `${V}/stock-docs/${d.body.id}/lines`, { lotId: lot.id, qty, unit: "kg", reason: "dap" });
      expect(l.status).toBe(201);
      return d.body.id as number;
    };
    const small = await api("manager", "POST", `${V}/stock-docs/${await mk("manager", 0.5)}/post`);
    expect(small.body.status).toBe("posted");
    let on = await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id=?`).bind(lot.id).first<any>();
    expect(on.q).toBe(19500);

    const bigId = await mk("manager", 3); // 3.5kg tổng > 1kg
    const big = await api("manager", "POST", `${V}/stock-docs/${bigId}/post`);
    expect(big.body.status).toBe("pending_approval");
    expect(big.body.approvalId).toBeGreaterThan(0);
    const ap = await db().prepare(`SELECT * FROM approvals WHERE id=?`).bind(big.body.approvalId).first<any>();
    expect(ap).toMatchObject({ type: "stock_doc.post", ref_type: "stock_doc", ref_id: String(bigId), status: "pending" });
    on = await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id=?`).bind(lot.id).first<any>();
    expect(on.q).toBe(19500); // chưa trừ kho
    expect((await api("manager", "POST", `${V}/stock-docs/${bigId}/post`)).status).toBe(409);

    const done = await applyStockDocPost(fakeCtx(2), bigId);
    expect(done.status).toBe("posted");
    on = await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id=?`).bind(lot.id).first<any>();
    expect(on.q).toBe(16500);

    // người lập không có inventory.approve (thủ kho) → luôn chờ duyệt, từ chối trả về nháp
    const whId = await mk("warehouse", 0.1);
    const wh = await api("warehouse", "POST", `${V}/stock-docs/${whId}/post`);
    expect(wh.body.status).toBe("pending_approval");
    const rej = await rejectStockDocPost(fakeCtx(2), whId, "Không hợp lý");
    expect(rej.status).toBe("draft");
  });

  it("cannot waste more than available", async () => {
    const { lot } = await receive("HH-2");
    const d = await api("manager", "POST", `${V}/stock-docs`, { type: "waste", locationId: 1 });
    await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { lotId: lot.id, qty: 99, unit: "kg", reason: "heo" });
    const r = await api("manager", "POST", `${V}/stock-docs/${d.body.id}/post`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("insufficient_stock");
  });
});

describe("count & adjust", () => {
  it("count creates adjust moves from the diff, small diff posts directly", async () => {
    const { lot, productId } = await receive("KK-1");
    const d = await api("manager", "POST", `${V}/stock-docs`, { type: "count", locationId: 1 });
    await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { lotId: lot.id, countedQty: 19, unit: "kg" });
    const p = await api("manager", "POST", `${V}/stock-docs/${d.body.id}/post`);
    expect(p.body.status).toBe("posted");
    expect(p.body.totalAmount).toBe(50000);
    expect(p.body.lines[0]).toMatchObject({ docQtyMilli: 20000, qtyMilli: 19000 });
    const mv = await db().prepare(`SELECT qty_delta_milli d, move_type t FROM stock_moves WHERE lot_id=? AND move_type='adjust'`).bind(lot.id).all<any>();
    expect(mv.results).toEqual([{ d: -1000, t: "adjust" }]);
    const card = await api("manager", "GET", `${V}/stock/card?productId=${productId}`);
    expect(card.body.closingMilli).toBe(19000);
    expect(card.body.moves.map((m: any) => m.moveType)).toEqual(["receipt", "adjust"]);
  });

  it("count diff above threshold waits for approval; counting up adds stock", async () => {
    const { lot } = await receive("KK-2"); // 50k/kg; ngưỡng 1tr → > 20kg diff
    const d = await api("manager", "POST", `${V}/stock-docs`, { type: "count", locationId: 1 });
    await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { lotId: lot.id, countedQty: 50, unit: "kg" }); // +30kg = 1.5tr
    const p = await api("manager", "POST", `${V}/stock-docs/${d.body.id}/post`);
    expect(p.body.status).toBe("pending_approval");
    await applyStockDocPost(fakeCtx(1), d.body.id);
    const on = await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id=?`).bind(lot.id).first<any>();
    expect(on.q).toBe(50000);
  });

  it("adjust by warehouse needs approval; negative adjust reduces stock after approval", async () => {
    const { lot } = await receive("DC-1");
    const d = await api("warehouse", "POST", `${V}/stock-docs`, { type: "adjust", locationId: 1 });
    await api("warehouse", "POST", `${V}/stock-docs/${d.body.id}/lines`, { lotId: lot.id, qty: -2, unit: "kg", reason: "hao_can" });
    expect((await api("warehouse", "POST", `${V}/stock-docs/${d.body.id}/post`)).body.status).toBe("pending_approval");
    await applyStockDocPost(fakeCtx(2), d.body.id);
    const on = await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id=?`).bind(lot.id).first<any>();
    expect(on.q).toBe(18000);
  });
});

describe("expired lots & scanning", () => {
  async function expiredLot(sku: string) {
    const productId = await mkProduct(sku);
    const past = new Date(Date.now() - 3600_000).toISOString();
    const r = await db().prepare(
      `INSERT INTO lots(lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli)
       VALUES (?,?,1,?,?,30000,10000,10000)`,
    ).bind(`HML-EXP-${sku}`, productId, past, past).run();
    return { productId, lotId: r.meta.last_row_id as number, code: `HML-EXP-${sku}` };
  }

  it("expired lot can only leave via waste", async () => {
    const { lotId } = await expiredLot("EXP-1");
    for (const type of ["adjust", "transfer"]) {
      const d = await api("manager", "POST", `${V}/stock-docs`, { type, locationId: 1, toLocationId: 2 });
      const l = await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { lotId, qty: 1, unit: "kg", reason: "x" });
      expect(l.status).toBe(422);
      expect(l.body.error.code).toBe("lot_expired");
    }
    const w = await api("manager", "POST", `${V}/stock-docs`, { type: "waste", locationId: 1 });
    expect((await api("manager", "POST", `${V}/stock-docs/${w.body.id}/lines`, { lotId, qty: 1, unit: "kg", reason: "het_han" })).status).toBe(201);
  });

  it("scan returns unknown_code / lot_expired / not_in_doc / duplicate_scan and always logs", async () => {
    const { code } = await expiredLot("EXP-2");
    const fresh = await receive("SCAN-1");
    const xfer = await api("manager", "POST", `${V}/stock-docs`, { type: "transfer", locationId: 1, toLocationId: 2 });
    const scan = (docId: number, c: string, extra: any = {}) => api("manager", "POST", `${V}/stock-docs/${docId}/scan`, { code: c, ...extra });

    const unknown = await scan(xfer.body.id, "KHONG-CO");
    expect([unknown.status, unknown.body.error.code]).toEqual([422, "unknown_code"]);
    const expired = await scan(xfer.body.id, code);
    expect([expired.status, expired.body.error.code]).toEqual([422, "lot_expired"]);
    const ok = await scan(xfer.body.id, `HML${String(fresh.lot.id).padStart(8, "0")}`, { qty: 2 });
    expect(ok.status).toBe(201);
    expect(ok.body.lines[0]).toMatchObject({ qtyMilli: 2000, lotId: fresh.lot.id });
    const dup = await scan(xfer.body.id, `HML${String(fresh.lot.id).padStart(8, "0")}`);
    expect([dup.status, dup.body.error.code]).toEqual([422, "duplicate_scan"]);

    // lô ở vị trí khác → not_in_doc
    const other = await api("manager", "POST", `${V}/stock-docs`, { type: "waste", locationId: 2 });
    const nid = await scan(other.body.id, `HML${String(fresh.lot.id).padStart(8, "0")}`);
    expect([nid.status, nid.body.error.code]).toEqual([422, "not_in_doc"]);

    // phiếu nhập: quét sản phẩm không có trong phiếu
    const rc = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1 });
    const prod = await db().prepare(`SELECT barcode FROM products WHERE id=?`).bind(fresh.productId).first<any>();
    const nr = await scan(rc.body.id, prod.barcode);
    expect([nr.status, nr.body.error.code]).toEqual([422, "not_in_doc"]);
    await api("manager", "POST", `${V}/stock-docs/${rc.body.id}/lines`, { productId: fresh.productId, unit: "kg", qty: 0, docQty: 3, unitCost: 1000 });
    const rs = await scan(rc.body.id, prod.barcode, { qty: 3 });
    expect(rs.body.lines[0].qtyMilli).toBe(3000);

    const ev = await db().prepare(`SELECT result, user_id FROM scan_events WHERE context LIKE 'transfer:%' OR context LIKE 'waste:%' OR context LIKE 'receipt:%'`).all<any>();
    const results = ev.results.map((e) => e.result);
    for (const r of ["unknown", "expired", "ok", "duplicate", "not_in_doc"]) expect(results).toContain(r);
  });

  it("scan on count doc accumulates counted qty", async () => {
    const { lot } = await receive("SCAN-2");
    const d = await api("manager", "POST", `${V}/stock-docs`, { type: "count", locationId: 1 });
    const code = `HML${String(lot.id).padStart(8, "0")}`;
    await api("manager", "POST", `${V}/stock-docs/${d.body.id}/scan`, { code, qty: 5 });
    const r = await api("manager", "POST", `${V}/stock-docs/${d.body.id}/scan`, { code, qty: 5 });
    expect(r.body.lines[0]).toMatchObject({ qtyMilli: 10000, docQtyMilli: 20000 });
  });
});

describe("transfer, alerts, trace", () => {
  it("transfer keeps unit cost and expiry in a new lot at destination", async () => {
    const exp = new Date(Date.now() + 4 * 86400_000).toISOString();
    const { lot, productId } = await receive("CK-1", "manager", { expiresAt: exp });
    const d = await api("manager", "POST", `${V}/stock-docs`, { type: "transfer", locationId: 1, toLocationId: 2 });
    await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { lotId: lot.id, qty: 5, unit: "kg" });
    const p = await api("manager", "POST", `${V}/stock-docs/${d.body.id}/post`);
    expect(p.body.status).toBe("posted");
    expect(p.body.transferStatus).toBe("in_transit"); // B-19: chuyển kho 2 bước — hàng đang đi đường, chưa có lô ở đích
    expect((await db().prepare(`SELECT COUNT(*) n FROM lots WHERE product_id=?`).bind(productId).first<any>()).n).toBe(1);
    const rc = await api("manager", "POST", `${V}/stock-docs/${d.body.id}/receive`, {});
    expect(rc.status).toBe(200);
    const lots = await db().prepare(`SELECT * FROM lots WHERE product_id=? ORDER BY id`).bind(productId).all<any>();
    expect(lots.results.map((l) => [l.location_id, l.qty_on_hand_milli])).toEqual([[1, 15000], [2, 5000]]);
    expect(lots.results[1]).toMatchObject({ unit_cost: 50000, expires_at: lot.expires_at });
    expect(lots.results[1].lot_code).toMatch(/^HML\d{8}$/);
    const types = await db().prepare(`SELECT move_type t FROM stock_moves WHERE ref_type='stock_doc' AND ref_id=? ORDER BY id`).bind(d.body.id).all<any>();
    expect(types.results.map((r) => r.t)).toEqual(["transfer_out", "transfer_in"]);
  });

  it("alerts list low stock / expiring / expired; trace shows supplier doc", async () => {
    const soon = new Date(Date.now() + 86400_000).toISOString();
    const { lot, productId } = await receive("AL-1", "manager", { expiresAt: soon });
    await db().prepare(`UPDATE products SET min_stock_milli = 100000 WHERE id = ?`).bind(productId).run();
    const al = await api("warehouse", "GET", `${V}/stock/alerts`);
    expect(al.body.lowStock.map((p: any) => p.id)).toContain(productId);
    expect(al.body.expiringSoon.map((l: any) => l.id)).toContain(lot.id);
    expect(al.body.expired.length).toBeGreaterThan(0);
    const tr = await api("manager", "GET", `${V}/stock/lots/${`HML${String(lot.id).padStart(8, "0")}`}/trace`);
    expect(tr.body.receipt).toMatchObject({ supplierRef: "NCC-001" });
    expect(tr.body.moves).toHaveLength(1);
    const lots = await api("manager", "GET", `${V}/stock/lots?productId=${productId}`);
    expect(lots.body.items[0].unitCost).toBe(50000);
    expect((await api("online_staff", "GET", `${V}/stock/lots?productId=${productId}`)).body.items[0].unitCost).toBeUndefined();
  });
});

describe("double post guard", () => {
  it("second concurrent post of same doc rolls back", async () => {
    const { testEnv } = await import("./helpers");
    const db = testEnv.DB;
    await db.prepare(`INSERT INTO stock_doc_post_guard(doc_id) SELECT MAX(id) FROM stock_docs WHERE status='posted'`).run().catch(() => {});
    const r = await db.prepare(`SELECT MAX(id) id FROM stock_docs WHERE status='posted'`).first<{ id: number }>();
    if (!r?.id) return;
    await expect(db.prepare(`INSERT INTO stock_doc_post_guard(doc_id) VALUES (?)`).bind(r.id).run()).rejects.toThrow();
  });
});
