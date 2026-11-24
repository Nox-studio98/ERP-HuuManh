import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { reserveStmts } from "../src/worker/services/reservations";

const V = "/api/v1";
const db = () => testEnv.DB;
const iso = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
let seq = 700000;

async function mkProduct(sku: string, baseUnit = "kg", units: any[] = []) {
  const r = await api("manager", "POST", `${V}/products`, { sku, name: `Táo ${sku}`, baseUnit, sellByWeight: true, units });
  return r.body as { id: number; barcode: string };
}
async function mkLot(productId: number, qty: number) {
  const id = ++seq;
  const r = await db()
    .prepare(`INSERT INTO lots(lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(`M${id}`, productId, 1, iso(-1), iso(5), 20000, qty, qty)
    .run();
  await db().prepare(`INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id) VALUES (?,?,?,?, 'receipt','stock_doc',1,1)`).bind(r.meta.last_row_id, productId, qty, 20000).run();
  return r.meta.last_row_id as number;
}

beforeAll(seedBase);

describe("B-20 merge duplicate products (EC-22)", () => {
  it("moves lots, prices, online mapping, open order lines; hides source; history stays", async () => {
    const src = await mkProduct("MG-S", "kg", [{ unit: "thung", factorMilli: 10000, barcode: "BC-THUNG-S" }]);
    const tgt = await mkProduct("MG-T");
    const lotS = await mkLot(src.id, 4000);
    const lotT = await mkLot(tgt.id, 6000);
    await db().prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,?,40000,?, 'active',1),(1,?,45000,?, 'active',1)`).bind(src.id, iso(-3), tgt.id, iso(-3)).run();
    await db().prepare(`INSERT INTO external_products(source, external_sku, product_id, unit) VALUES ('shopee','SP-1',?,'kg')`).bind(src.id).run();
    // đơn B2B đang mở có giữ tồn lô nguồn + đơn đã hoàn tất (giữ nguyên lịch sử)
    await db().batch([
      db().prepare(`INSERT INTO orders(id, code, channel, store_id, status) VALUES (7901,'DS-M1','b2b',1,'confirmed'),(7902,'DS-M2','b2b',1,'completed')`),
      db().prepare(`INSERT INTO order_lines(id, order_id, product_id, unit, qty_milli, unit_price, line_total) VALUES (7901,7901,?,'kg',1000,40000,0),(7902,7902,?,'kg',1000,40000,0)`).bind(src.id, src.id),
    ]);
    await db().batch(reserveStmts(db(), 7901, [{ orderLineId: 7901, productId: src.id, alloc: [{ lotId: lotS, unitCost: 20000, qtyMilli: 1000 }] }]));

    expect((await api("cashier", "POST", `${V}/products/${src.id}/merge-into/${tgt.id}`, { reason: "trùng mã" })).status).toBe(403);
    expect((await api("manager", "POST", `${V}/products/${src.id}/merge-into/${tgt.id}`, {})).status).toBe(422);
    expect((await api("manager", "POST", `${V}/products/${src.id}/merge-into/${src.id}`, { reason: "trùng mã" })).status).toBe(422);

    const m = await api("manager", "POST", `${V}/products/${src.id}/merge-into/${tgt.id}`, { reason: "Trùng mã Táo Envy" });
    expect(m.status).toBe(200);
    expect(m.body.moved).toMatchObject({ lots: 1, prices: 1, externalProducts: 1, openOrderLines: 1 });

    const s = await db().prepare(`SELECT merged_into, active FROM products WHERE id=?`).bind(src.id).first<any>();
    expect(s).toEqual({ merged_into: tgt.id, active: 0 });
    expect((await db().prepare(`SELECT product_id FROM lots WHERE id=?`).bind(lotS).first<any>()).product_id).toBe(tgt.id);
    expect((await db().prepare(`SELECT product_id FROM external_products WHERE external_sku='SP-1'`).first<any>()).product_id).toBe(tgt.id);
    // dòng đơn đang mở theo mã đích; đơn đã xong giữ mã nguồn
    expect((await db().prepare(`SELECT product_id FROM order_lines WHERE id=7901`).first<any>()).product_id).toBe(tgt.id);
    expect((await db().prepare(`SELECT product_id FROM order_lines WHERE id=7902`).first<any>()).product_id).toBe(src.id);
    // giá: mã đích đã có giá active ở bảng giá 1 → giá nguồn bị thay thế
    const pr = await db().prepare(`SELECT product_id, status FROM prices WHERE unit_price IN (40000,45000) ORDER BY unit_price`).all<any>();
    expect(pr.results).toEqual([{ product_id: tgt.id, status: "superseded" }, { product_id: tgt.id, status: "active" }]);
    // đơn vị quy đổi chuyển sang mã đích
    expect((await db().prepare(`SELECT COUNT(*) n FROM product_units WHERE product_id=? AND unit='thung'`).bind(tgt.id).first<any>()).n).toBe(1);

    // danh sách chỉ còn mã đích; tồn gộp
    const list = await api("manager", "GET", `${V}/products?q=MG-`);
    expect(list.body.items.map((p: any) => p.id)).toEqual([tgt.id]);
    expect(list.body.items[0].availableMilli).toBe(9000); // 4000+6000 − 1000 giữ
    const lk = await api("manager", "GET", `${V}/products/lookup?code=${src.barcode}`);
    expect(lk.body.product.id).toBe(tgt.id);
    const lk2 = await api("manager", "GET", `${V}/products/lookup?code=BC-THUNG-S`);
    expect(lk2.body.product.id).toBe(tgt.id);
    // thẻ kho & báo cáo gộp cả lịch sử mã nguồn
    const card = await api("manager", "GET", `${V}/stock/card?productId=${tgt.id}`);
    expect(card.body.closingMilli).toBe(10000);
    const rep = await api("manager", "GET", `${V}/reports/inventory`);
    const row = rep.body.items.filter((i: any) => [src.id, tgt.id].includes(i.productId));
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ productId: tgt.id, onHandMilli: 10000 });
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='product.merge'`).first<any>()).n).toBe(1);
    expect((await db().prepare(`SELECT COUNT(*) n FROM product_merges WHERE source_id=?`).bind(src.id).first<any>()).n).toBe(1);

    // gộp lại / gộp vào mã đã bị gộp → 409
    expect((await api("manager", "POST", `${V}/products/${src.id}/merge-into/${tgt.id}`, { reason: "lần hai" })).status).toBe(409);
    const other = await mkProduct("MG-O");
    expect((await api("manager", "POST", `${V}/products/${other.id}/merge-into/${src.id}`, { reason: "vào mã đã gộp" })).body.error.code).toBe("target_invalid");
  });

  it("rejects incompatible units and inactive target", async () => {
    const a = await mkProduct("MG-U1", "kg", [{ unit: "thung", factorMilli: 10000 }]);
    const b = await mkProduct("MG-U2", "kg", [{ unit: "thung", factorMilli: 12000 }]);
    const r = await api("manager", "POST", `${V}/products/${a.id}/merge-into/${b.id}`, { reason: "trùng" });
    expect([r.status, r.body.error.code]).toEqual([422, "units_incompatible"]);
    const c = await mkProduct("MG-U3", "trai");
    expect((await api("manager", "POST", `${V}/products/${a.id}/merge-into/${c.id}`, { reason: "trùng" })).body.error.code).toBe("units_incompatible");
    await db().prepare(`UPDATE products SET active=0 WHERE id=?`).bind(b.id).run();
    const d = await mkProduct("MG-U4");
    expect((await api("manager", "POST", `${V}/products/${d.id}/merge-into/${b.id}`, { reason: "trùng" })).body.error.code).toBe("target_invalid");
  });
});
