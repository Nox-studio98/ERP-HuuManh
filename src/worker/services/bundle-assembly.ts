import { AppError } from "../lib/errors";
import { allocateFefo, allocationCost, moveStatements, type LotAllocation } from "./stock";

export interface ComponentRow {
  component_product_id: number;
  qty_milli: number;
}

export async function bundleComponents(db: D1Database, bundleProductId: number): Promise<ComponentRow[]> {
  return (await db.prepare(`SELECT component_product_id, qty_milli FROM bundle_components WHERE bundle_product_id = ? ORDER BY component_product_id`).bind(bundleProductId).all<ComponentRow>()).results;
}

export interface AssemblyPlan {
  components: { productId: number; needMilli: number; alloc: LotAllocation[]; cost: number }[];
  componentCost: number;
  earliestExpiry: string | null;
}

/**
 * Kế hoạch đóng giỏ quà: tiêu thụ thành phần theo FEFO (allocateFefo chỉ đọc; thiếu → 409 insufficient_stock).
 * Số lượng thành phần = qty_milli (mỗi 1 đơn vị giỏ) × số giỏ.
 */
export async function planAssembly(db: D1Database, bundleProductId: number, bundleQtyMilli: number, storeId: number): Promise<AssemblyPlan> {
  const comps = await bundleComponents(db, bundleProductId);
  if (!comps.length) throw new AppError(422, "no_components", "Giỏ quà chưa khai báo thành phần");
  const out: AssemblyPlan["components"] = [];
  for (const cmp of comps) {
    const need = Math.round((cmp.qty_milli * bundleQtyMilli) / 1000);
    if (need <= 0) throw new AppError(422, "invalid_qty", "Số lượng thành phần không hợp lệ");
    const alloc = await allocateFefo(db, cmp.component_product_id, need, storeId);
    out.push({ productId: cmp.component_product_id, needMilli: need, alloc, cost: allocationCost(alloc) });
  }
  const lotIds = out.flatMap((c) => c.alloc.map((a) => a.lotId));
  const exp = lotIds.length
    ? (await db.prepare(`SELECT MIN(expires_at) AS e FROM lots WHERE id IN (${lotIds.map(() => "?").join(",")})`).bind(...lotIds).first<{ e: string | null }>())?.e ?? null
    : null;
  return { components: out, componentCost: out.reduce((s, c) => s + c.cost, 0), earliestExpiry: exp };
}

/** Statement ghi: trừ thành phần (assemble_out), tạo lô giỏ quà + thẻ kho assemble_in, chốt lệnh. Đưa vào MỘT batch. */
export function assemblyStatements(
  db: D1Database,
  o: { assemblyId: number; bundleProductId: number; locationId: number; qtyMilli: number; unitCost: number; expiresAt: string | null; plan: AssemblyPlan; userId: number },
): D1PreparedStatement[] {
  const tmp = `TMP-ASM-${o.assemblyId}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const s: D1PreparedStatement[] = [];
  for (const c of o.plan.components) s.push(...moveStatements(db, c.productId, c.alloc, -1, "assemble_out", "assembly_order", o.assemblyId, o.userId));
  s.push(
    db
      .prepare(`INSERT INTO lots(lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(tmp, o.bundleProductId, o.locationId, now, o.expiresAt, o.unitCost, o.qtyMilli, o.qtyMilli),
    db
      .prepare(
        `INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id)
         SELECT id, product_id, qty_in_milli, unit_cost, 'assemble_in', 'assembly_order', ?, ? FROM lots WHERE lot_code = ?`,
      )
      .bind(o.assemblyId, o.userId, tmp),
    db.prepare(`UPDATE assembly_orders SET lot_id = (SELECT id FROM lots WHERE lot_code = ?), status='posted' WHERE id = ? AND status='cancelled'`).bind(tmp, o.assemblyId),
    db.prepare(`UPDATE lots SET lot_code = 'HML' || substr('00000000' || id, -8) WHERE lot_code = ?`).bind(tmp),
  );
  return s;
}


