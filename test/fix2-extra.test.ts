import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { currentAvgCost } from "../src/worker/services/pricing";

const V = "/api/v1";
const db = () => testEnv.DB;
const iso = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
let seq = 760000;

async function mkProduct(sku: string) {
  const r = await api("manager", "POST", `${V}/products`, { sku, name: `Hàng ${sku}`, baseUnit: "kg", sellByWeight: true, units: [] });
  return r.body.id as number;
}
async function mkLot(productId: number, qty: number, cost: number, opts: { location?: number; expiresDays?: number; at?: string } = {}) {
  const id = ++seq;
  const r = await db()
    .prepare(`INSERT INTO lots(lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(`X${id}`, productId, opts.location ?? 1, iso(-2), iso(opts.expiresDays ?? 5), cost, qty, qty)
    .run();
  const lotId = r.meta.last_row_id as number;
  await db()
    .prepare(`INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id, at) VALUES (?,?,?,?, 'receipt','stock_doc',1,1,?)`)
    .bind(lotId, productId, qty, cost, opts.at ?? iso(0))
    .run();
  return lotId;
}

beforeAll(seedBase);

describe("B-23 giá vốn tham chiếu chỉ tính lô bán được", () => {
  it("bỏ qua lô ở khu hàng hỏng và lô đã hết hạn", async () => {
    const p = await mkProduct("B23");
    await mkLot(p, 1000, 20000);
    await mkLot(p, 1000, 90000, { location: 2 }); // khu HONG (sellable = 0)
    await mkLot(p, 1000, 80000, { expiresDays: -1 }); // đã hết hạn
    expect(await currentAvgCost(db(), p)).toBe(20000);
  });
});

describe("B-14 nhập-xuất-tồn cân khi có lắp giỏ quà", () => {
  it("Tồn đầu + Nhập − Bán + Trả − Hao hụt + Lắp ráp + Điều chỉnh = Tồn cuối", async () => {
    const p = await mkProduct("B14");
    const lot = await mkLot(p, 5000, 10000);
    await db()
      .prepare(`INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id, at) VALUES (?,?,?,?, 'assemble_out','bundle',1,1,?)`)
      .bind(lot, p, -2000, 10000, iso(0))
      .run();
    const r = await api("manager", "GET", `${V}/reports/inventory`);
    expect(r.status).toBe(200);
    const it = r.body.items.find((x: any) => x.productId === p);
    expect(it.assembleMilli).toBe(-2000);
    expect(it.adjustMilli).toBe(0);
    expect(it.openingMilli + it.inMilli - it.soldMilli + it.returnedMilli - it.wasteMilli + it.assembleMilli + it.adjustMilli).toBe(it.onHandMilli);
  });
});

describe("EC-22 gộp mã cập nhật đơn sỉ lặp", () => {
  it("đổi productId trong lines_json của đơn lặp sang mã đích", async () => {
    const src = await mkProduct("RC-S");
    const tgt = await mkProduct("RC-T");
    const other = await mkProduct("RC-O");
    const custId = 7610;
    await db().prepare(`INSERT INTO customers(id, code, type, name) VALUES (7610,'KH-RC','b2b','Khách đơn lặp')`).run();
    await db()
      .prepare(`INSERT INTO recurring_orders(id, customer_id, weekdays, lines_json, created_by) VALUES (7611, ?, '1,4', ?, 1)`)
      .bind(custId, JSON.stringify([{ productId: src, unit: "kg", qty: 2 }, { productId: other, unit: "kg", qty: 1 }]))
      .run();
    const m = await api("manager", "POST", `${V}/products/${src}/merge-into/${tgt}`, { reason: "Trùng mã" });
    expect(m.status).toBe(200);
    const row = await db().prepare(`SELECT lines_json FROM recurring_orders WHERE id = 7611`).first<{ lines_json: string }>();
    expect(JSON.parse(row!.lines_json)).toEqual([{ productId: tgt, unit: "kg", qty: 2 }, { productId: other, unit: "kg", qty: 1 }]);
  });
});
