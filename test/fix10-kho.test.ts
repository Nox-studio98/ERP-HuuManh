import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate, vnPeriod } from "../src/worker/lib/time";

// Đợt 10 — kho lõi: K-KHO1 (chốt hoá đơn mua sau chuyển kho), K-KHO3 (gộp mã trùng), K-KHO4 (giỏ quà: khoá sổ, hạn dùng, tháo giỏ)
const V = "/api/v1";
const db = () => testEnv.DB;
const today = vnDate();
const iso = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO suppliers(id, code, name, payment_terms_days) VALUES (5001,'F10-NCC','NCC đợt 10',0)`),
    db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (5001,'F10-A','Táo F10','kg'),(5002,'F10-B','Cam F10','kg'),(5003,'F10-C','Nho F10','kg')`),
    db().prepare(`INSERT INTO stock_docs(id, code, type, status, store_id, location_id, supplier_id, created_by, posted_at) VALUES (5001,'F10-PN1','receipt','posted',1,1,5001,1,${NOW}),(5002,'F10-PN2','receipt','posted',1,1,5001,1,${NOW})`),
    db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, supplier_id, receipt_doc_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES
      (5001,'F10-L1',5001,1,5001,5001,${NOW},?,10000,10000,10000),
      (5002,'F10-L2',5002,1,5001,5002,${NOW},?,10000,10000,10000)`).bind(iso(10), iso(10)),
    db().prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, lot_id, unit, qty_milli, unit_cost, amount) VALUES (5001,5001,5001,'kg',10000,10000,100000),(5002,5002,5002,'kg',10000,10000,100000)`),
    db().prepare(`INSERT INTO supplier_bills(id, code, supplier_id, stock_doc_id, is_provisional, issue_date, due_date, total) VALUES (5001,'F10-CNP-1',5001,5001,1,?,?,100000),(5002,'F10-CNP-2',5001,5002,1,?,?,100000)`).bind(today, today, today, today),
  ]);
});

async function transfer(lotId: number, qty: number, receive: boolean) {
  const t = (await api("manager", "POST", `${V}/stock-docs`, { type: "transfer", locationId: 1, toLocationId: 2 })).body.id as number;
  await api("manager", "POST", `${V}/stock-docs/${t}/lines`, { lotId, qty, unit: "kg" });
  expect((await api("manager", "POST", `${V}/stock-docs/${t}/post`)).status).toBe(200);
  if (receive) expect((await api("manager", "POST", `${V}/stock-docs/${t}/receive`, {})).status).toBe(200);
  return t;
}

describe("K-KHO1: chốt hoá đơn mua sau khi chuyển kho", () => {
  it("lô con ở kho đích cũng được điều chỉnh giá vốn; chưa bán gì thì giá vốn (COGS) = 0", async () => {
    await transfer(5001, 6, true); // 4kg ở lô nguồn, 6kg ở lô đích (chuỗi lô gốc)
    const r = await api("accountant", "POST", `${V}/bills/5001/finalize`, { supplierRef: "HD-F10-1", total: 120_000, reason: "NCC tăng giá" });
    expect(r.status).toBe(200);
    const lots = (await db().prepare(`SELECT id, unit_cost, qty_on_hand_milli FROM lots WHERE product_id=5001 ORDER BY id`).all<any>()).results;
    expect(lots).toHaveLength(2);
    expect(lots.map((l) => l.unit_cost)).toEqual([12000, 12000]);
    const adj = (await db().prepare(`SELECT lot_id, diff_amount, onhand_amount, cogs_amount FROM purchase_cost_adjustments WHERE bill_id=5001`).all<any>()).results;
    expect(adj.reduce((n, x) => n + x.cogs_amount, 0)).toBe(0);
    expect(adj.reduce((n, x) => n + x.diff_amount, 0)).toBe(20_000);
    expect(adj.reduce((n, x) => n + x.onhand_amount, 0)).toBe(20_000);
    // trả hàng NCC theo lô đích dùng giá mới
    const dest = lots.find((l) => l.id !== 5001)!;
    expect(dest.unit_cost).toBe(12000);
  });

  it("đã bán 2kg + chuyển 6kg đi đường rồi nhận: chỉ phần đã bán vào chênh lệch giá mua", async () => {
    await db().prepare(`UPDATE lots SET qty_on_hand_milli = qty_on_hand_milli - 2000 WHERE id = 5002`).run(); // bán 2kg
    await transfer(5002, 6, false); // 6kg đang đi đường, 2kg còn ở nguồn
    const r = await api("accountant", "POST", `${V}/bills/5002/finalize`, { supplierRef: "HD-F10-2", total: 120_000, reason: "NCC tăng giá" });
    expect(r.status).toBe(200);
    const adj = (await db().prepare(`SELECT diff_amount, onhand_amount, cogs_amount FROM purchase_cost_adjustments WHERE bill_id=5002`).all<any>()).results;
    expect(adj.reduce((n, x) => n + x.diff_amount, 0)).toBe(20_000);
    expect(adj.reduce((n, x) => n + x.cogs_amount, 0)).toBe(4_000); // 2kg đã bán × 2.000
    expect((await db().prepare(`SELECT unit_cost FROM lots WHERE id=5002`).first<any>()).unit_cost).toBe(12000);
    // nhận phiếu chuyển sau đó: lô đích lấy giá đã điều chỉnh
    const doc = (await db().prepare(`SELECT d.id FROM stock_docs d JOIN stock_doc_lines l ON l.doc_id = d.id WHERE d.type='transfer' AND l.lot_id=5002`).first<any>())!;
    expect((await api("manager", "POST", `${V}/stock-docs/${doc.id}/receive`, {})).status).toBe(200);
    const dest = await db().prepare(`SELECT unit_cost, qty_on_hand_milli FROM lots WHERE product_id=5002 AND location_id=2`).first<any>();
    expect(dest).toEqual({ unit_cost: 12000, qty_on_hand_milli: 6000 });
  });
});

describe("K-KHO3: gộp mã trùng chuyển PO, phần thiếu, đơn giao thất bại, NCC", () => {
  it("chuyển dòng PO đang chạy, so_shortages, delivery_failed, product_suppliers; mã nguồn không nhận hàng nữa", async () => {
    await db().batch([
      db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (5011,'F10-S','Mã nguồn','kg'),(5012,'F10-T','Mã đích','kg')`),
      db().prepare(`INSERT INTO product_suppliers(product_id, supplier_id, lead_time_days) VALUES (5011,5001,2)`),
      db().prepare(`INSERT INTO purchase_orders(id, code, supplier_id, store_id, status) VALUES (5011,'PO-F10-1',5001,1,'confirmed'),(5012,'PO-F10-2',5001,1,'received')`),
      db().prepare(`INSERT INTO purchase_order_lines(id, po_id, product_id, order_unit, qty_milli) VALUES (5011,5011,5011,'kg',4000),(5012,5012,5011,'kg',1000)`),
      db().prepare(`INSERT INTO orders(id, code, channel, store_id, status) VALUES (5011,'DS-F10','b2b',1,'delivery_failed')`),
      db().prepare(`INSERT INTO order_lines(id, order_id, product_id, unit, qty_milli, unit_price, line_total) VALUES (5011,5011,5011,'kg',4000,40000,0)`),
      db().prepare(`INSERT INTO so_shortages(id, order_id, order_line_id, product_id, initial_milli, qty_milli, status) VALUES (5011,5011,5011,5011,4000,4000,'open')`),
    ]);
    const m = await api("manager", "POST", `${V}/products/5011/merge-into/5012`, { reason: "Trùng mã" });
    expect(m.status).toBe(200);
    const one = async (sql: string) => (await db().prepare(sql).first<any>())!.v;
    expect(await one(`SELECT product_id v FROM purchase_order_lines WHERE id=5011`)).toBe(5012);
    expect(await one(`SELECT product_id v FROM purchase_order_lines WHERE id=5012`)).toBe(5011); // PO đã nhận đủ: giữ lịch sử
    expect(await one(`SELECT product_id v FROM so_shortages WHERE id=5011`)).toBe(5012);
    expect(await one(`SELECT product_id v FROM order_lines WHERE id=5011`)).toBe(5012);
    expect(await one(`SELECT product_id v FROM product_suppliers WHERE supplier_id=5001 AND lead_time_days=2`)).toBe(5012);
    // nhập kho mã nguồn bị chặn
    const d = (await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId: 5001 })).body.id;
    const ln = await api("manager", "POST", `${V}/stock-docs/${d}/lines`, { productId: 5011, qty: 1, unit: "kg", unitCost: 1000 });
    expect(ln.status).toBe(422);
  });

  it("PO đang chạy có cả hai mã → chặn gộp (409), không đổi gì", async () => {
    await db().batch([
      db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (5013,'F10-S2','Nguồn 2','kg'),(5014,'F10-T2','Đích 2','kg')`),
      db().prepare(`INSERT INTO purchase_orders(id, code, supplier_id, store_id, status) VALUES (5013,'PO-F10-3',5001,1,'sent')`),
      db().prepare(`INSERT INTO purchase_order_lines(po_id, product_id, order_unit, qty_milli) VALUES (5013,5013,'kg',1000),(5013,5014,'kg',2000)`),
    ]);
    const m = await api("manager", "POST", `${V}/products/5013/merge-into/5014`, { reason: "Trùng mã" });
    expect(m.status).toBe(409);
    expect(m.body.error.code).toBe("merge_po_conflict");
    expect((await db().prepare(`SELECT merged_into v FROM products WHERE id=5013`).first<any>()).v).toBeNull();
  });
});

describe("K-KHO4: giỏ quà — khoá sổ, hạn dùng, tháo giỏ", () => {
  const BUNDLE = 5020;
  beforeAll(async () => {
    await db().batch([
      db().prepare(`INSERT INTO products(id, sku, name, base_unit, group_id) VALUES (${BUNDLE},'F10-GIO','Giỏ F10','hop',1)`),
      db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (5020,'F10-LG',5003,1,${NOW},?,20000,10000,10000)`).bind(iso(5)),
      db().prepare(`INSERT INTO bundle_components(bundle_product_id, component_product_id, qty_milli) VALUES (${BUNDLE},5003,1000)`),
    ]);
  });
  const lotQ = async (id: number) => (await db().prepare(`SELECT qty_on_hand_milli v FROM lots WHERE id=?`).bind(id).first<any>())!.v as number;

  it("kỳ khoá → 423; hạn dùng vượt hạn thành phần → 422", async () => {
    await db().prepare(`INSERT OR IGNORE INTO periods(period, locked_at, locked_by) VALUES (?, ${NOW}, 1)`).bind(vnPeriod()).run();
    expect((await api("warehouse", "POST", `${V}/assembly-orders`, { bundleProductId: BUNDLE, qty: 2, unit: "hop" })).status).toBe(423);
    await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(vnPeriod()).run();
    const late = await api("warehouse", "POST", `${V}/assembly-orders`, { bundleProductId: BUNDLE, qty: 2, unit: "hop", expiresAt: iso(30) });
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe("expiry_too_late");
    expect(await lotQ(5020)).toBe(10000);
  });

  it("đóng 3 giỏ rồi tháo: thành phần về đúng lô, thẻ kho đảo, chỉ tháo một lần", async () => {
    const a = await api("warehouse", "POST", `${V}/assembly-orders`, { bundleProductId: BUNDLE, qty: 3, unit: "hop", expiresAt: iso(2) });
    expect(a.status).toBe(201);
    expect(await lotQ(5020)).toBe(7000);
    expect((await api("cashier", "POST", `${V}/assembly-orders/${a.body.id}/disassemble`, { reason: "nhầm lệnh" })).status).toBe(403);
    expect((await api("warehouse", "POST", `${V}/assembly-orders/${a.body.id}/disassemble`, {})).status).toBe(422);
    // khoá sổ chặn tháo
    await db().prepare(`INSERT OR IGNORE INTO periods(period, locked_at, locked_by) VALUES (?, ${NOW}, 1)`).bind(vnPeriod()).run();
    expect((await api("warehouse", "POST", `${V}/assembly-orders/${a.body.id}/disassemble`, { reason: "nhầm lệnh" })).status).toBe(423);
    await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(vnPeriod()).run();
    // giỏ đã bán một phần → không tháo
    await db().prepare(`UPDATE lots SET qty_on_hand_milli = qty_on_hand_milli - 1000 WHERE id = ?`).bind(a.body.lotId).run();
    expect((await api("warehouse", "POST", `${V}/assembly-orders/${a.body.id}/disassemble`, { reason: "nhầm lệnh" })).body.error.code).toBe("bundle_in_use");
    await db().prepare(`UPDATE lots SET qty_on_hand_milli = qty_on_hand_milli + 1000 WHERE id = ?`).bind(a.body.lotId).run();

    const r = await api("warehouse", "POST", `${V}/assembly-orders/${a.body.id}/disassemble`, { reason: "nhầm lệnh" });
    expect(r.status).toBe(200);
    expect(r.body.disassembledAt).toBeTruthy();
    expect(await lotQ(5020)).toBe(10000);
    expect(await lotQ(a.body.lotId)).toBe(0);
    const mv = (await db().prepare(`SELECT move_type t, qty_delta_milli q FROM stock_moves WHERE ref_type='assembly_reversal' AND ref_id=? ORDER BY id`).bind(a.body.id).all<any>()).results;
    expect(mv).toEqual([{ t: "assemble_out", q: -3000 }, { t: "assemble_in", q: 3000 }]);
    expect((await api("warehouse", "POST", `${V}/assembly-orders/${a.body.id}/disassemble`, { reason: "lần hai" })).status).toBe(409);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='assembly.disassemble' AND entity_id=?`).bind(String(a.body.id)).first<any>()).n).toBe(1);
  });
});
