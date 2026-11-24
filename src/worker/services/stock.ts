import { AppError } from "../lib/errors";

export interface LotAllocation {
  lotId: number;
  qtyMilli: number;
  unitCost: number;
}

interface LotRow {
  id: number;
  unit_cost: number;
  available: number;
  expires_at: string | null;
}

/**
 * EC-18: vị trí đang có phiếu kiểm kê bật "khoá lô" (nháp / chờ duyệt) thì các lô tại đó không được xuất bán / giữ tồn.
 * Dùng làm điều kiện SQL cho bảng lots đặt bí danh `l`.
 */
export const LOT_NOT_LOCKED_SQL = `NOT EXISTS (SELECT 1 FROM stock_docs cd WHERE cd.type = 'count' AND cd.lock_lots = 1
          AND cd.status IN ('draft','pending_approval') AND cd.location_id = l.location_id)`;

/**
 * Tồn khả dụng = tồn thực − đã giữ, chỉ tính lô active, chưa hết hạn, ở vị trí bán được (M1 quy tắc, M2-06).
 */
export async function availableQty(db: D1Database, productId: number, storeId: number, at = new Date().toISOString()) {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(l.qty_on_hand_milli - l.qty_reserved_milli), 0) AS q
         FROM lots l JOIN locations loc ON loc.id = l.location_id
        WHERE l.product_id = ? AND loc.store_id = ? AND loc.sellable = 1 AND l.status = 'active'
          AND (l.expires_at IS NULL OR l.expires_at > ?) AND ${LOT_NOT_LOCKED_SQL}`,
    )
    .bind(productId, storeId, at)
    .first<{ q: number }>();
  return r?.q ?? 0;
}

/**
 * Phân bổ FEFO (hết hạn trước xuất trước — M2-04). Lô hết hạn không bao giờ được chọn.
 * Chỉ ĐỌC; việc trừ kho thực hiện bằng deductStatements() trong một D1 batch.
 * Ràng buộc CHECK trên bảng lots là chốt chặn cuối cho bán đồng thời (EC-02):
 * nếu tồn đã đổi giữa lúc đọc và ghi, batch vi phạm CHECK và rollback toàn bộ.
 */
export async function allocateFefo(
  db: D1Database,
  productId: number,
  qtyMilli: number,
  storeId: number,
  at = new Date().toISOString(),
): Promise<LotAllocation[]> {
  if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng phải lớn hơn 0");
  const { alloc, missingMilli } = await allocateFefoPartial(db, productId, qtyMilli, storeId, { at });
  if (missingMilli > 0) {
    throw new AppError(409, "insufficient_stock", "Không đủ tồn khả dụng", {
      productId,
      requestedMilli: qtyMilli,
      availableMilli: qtyMilli - missingMilli,
    });
  }
  return alloc;
}

/** Như allocateFefo nhưng không ném lỗi khi thiếu: trả phần phân bổ được + số còn thiếu. excludeLotIds: lô không được chọn. */
export async function allocateFefoPartial(
  db: D1Database,
  productId: number,
  qtyMilli: number,
  storeId: number,
  opts: { at?: string; excludeLotIds?: number[] } = {},
): Promise<{ alloc: LotAllocation[]; missingMilli: number }> {
  const at = opts.at ?? new Date().toISOString();
  const ex = opts.excludeLotIds ?? [];
  const { results } = await db
    .prepare(
      `SELECT l.id, l.unit_cost, (l.qty_on_hand_milli - l.qty_reserved_milli) AS available, l.expires_at
         FROM lots l JOIN locations loc ON loc.id = l.location_id
        WHERE l.product_id = ? AND loc.store_id = ? AND loc.sellable = 1 AND l.status = 'active'
          AND (l.expires_at IS NULL OR l.expires_at > ?)
          AND l.qty_on_hand_milli - l.qty_reserved_milli > 0 AND ${LOT_NOT_LOCKED_SQL}
          ${ex.length ? `AND l.id NOT IN (${ex.map(() => "?").join(",")})` : ""}
        ORDER BY (l.expires_at IS NULL), l.expires_at, l.received_at, l.id`,
    )
    .bind(productId, storeId, at, ...ex)
    .all<LotRow>();

  const alloc: LotAllocation[] = [];
  let remaining = qtyMilli;
  for (const lot of results) {
    if (remaining <= 0) break;
    const take = Math.min(lot.available, remaining);
    alloc.push({ lotId: lot.id, qtyMilli: take, unitCost: lot.unit_cost });
    remaining -= take;
  }
  return { alloc, missingMilli: Math.max(remaining, 0) };
}

export const allocationCost = (alloc: LotAllocation[]) =>
  alloc.reduce((s, a) => s + Math.round((a.unitCost * a.qtyMilli) / 1000), 0);

/**
 * Statement trừ kho + ghi thẻ kho cho một phân bổ. refId phải là id đã tồn tại (tạo chứng từ trước, rồi batch).
 * sign = -1 xuất (bán, hao hụt), +1 nhập lại (trả hàng).
 */
export function moveStatements(
  db: D1Database,
  productId: number,
  alloc: LotAllocation[],
  sign: 1 | -1,
  moveType: string,
  refType: string,
  refId: number,
  userId: number,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const a of alloc) {
    stmts.push(
      db.prepare(`UPDATE lots SET qty_on_hand_milli = qty_on_hand_milli + ? WHERE id = ?`).bind(sign * a.qtyMilli, a.lotId),
      db
        .prepare(
          `INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(a.lotId, productId, sign * a.qtyMilli, a.unitCost, moveType, refType, refId, userId),
    );
  }
  return stmts;
}

/** Giữ tồn cho đơn online/B2B chưa giao (M2-06). CHECK reserved<=on_hand chặn giữ vượt tồn. */
export function reserveStatements(db: D1Database, alloc: LotAllocation[], sign: 1 | -1) {
  return alloc.map((a) =>
    db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli + ? WHERE id = ?`).bind(sign * a.qtyMilli, a.lotId),
  );
}
