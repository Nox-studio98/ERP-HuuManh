import { testEnv } from "./helpers";

/** Dữ liệu bán hàng tối thiểu: Táo (giá 100k, vốn 60k, 20kg), Nho (giá 200k, vốn 150k, 5kg). Gọi sau seedBase(). */
export async function seedSales() {
  const db = testEnv.DB;
  if (await db.prepare(`SELECT id FROM products WHERE id=1`).first()) return;
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + 10 * 86400_000).toISOString();
  await db.batch([
    db.prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight, group_id) VALUES (1,'TAO','Táo Envy','kg',1,1),(2,'NHO','Nho Mỹ','kg',1,1)`),
    db.prepare(`INSERT INTO product_units(product_id, unit, factor_milli) VALUES (1,'thung',10000)`),
    db.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES
      (1,'LOT-TAO-1',1,1,?1,?2,60000,20000,20000),(2,'LOT-NHO-1',2,1,?1,?2,150000,5000,5000)`).bind(now, exp),
    db.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,1,100000,'2020-01-01T00:00:00Z','active',1),(1,2,200000,'2020-01-01T00:00:00Z','active',1)`),
  ]);
}

export const lotQty = async (id: number) =>
  (await testEnv.DB.prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id=?`).bind(id).first<{ q: number }>())!.q;
