import { allocateFefo, type LotAllocation } from "./stock";
import { assertStmt } from "./guard";

/**
 * Giữ tồn cho đơn chưa giao (M2-06) — dùng chung cho đơn sỉ (M4), đơn sàn Fresco, đơn online (Đợt 3).
 * Vòng đời: active → consumed (khi giao/xuất kho) | released (huỷ đơn, giao thiếu, đổi lô).
 * Bất biến: Σ reservations.active theo lô == lots.qty_reserved_milli; CHECK trên lots chặn giữ vượt tồn (EC-02).
 */

export interface LineToReserve {
  orderLineId: number;
  productId: number;
  qtyMilli: number;
}

export interface ReservationPlan {
  orderLineId: number;
  productId: number;
  alloc: LotAllocation[];
}

/** Đọc: phân bổ FEFO cho từng dòng. Ném 409 insufficient_stock nếu thiếu. */
export async function planReservations(db: D1Database, lines: LineToReserve[], storeId: number): Promise<ReservationPlan[]> {
  // Gộp theo sản phẩm, phân bổ FEFO một lần cho tổng, rồi chia lại cho từng dòng theo thứ tự
  // → hai dòng cùng sản phẩm không giữ trùng phần tồn.
  const byProduct = new Map<number, LineToReserve[]>();
  for (const l of lines) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
  const plans = new Map<number, ReservationPlan>();
  for (const [productId, ls] of byProduct) {
    const pool = (await allocateFefo(db, productId, ls.reduce((s, l) => s + l.qtyMilli, 0), storeId)).map((a) => ({ ...a }));
    for (const l of ls) {
      const alloc: LotAllocation[] = [];
      let need = l.qtyMilli;
      for (const a of pool) {
        if (need <= 0) break;
        if (a.qtyMilli <= 0) continue;
        const take = Math.min(a.qtyMilli, need);
        alloc.push({ lotId: a.lotId, unitCost: a.unitCost, qtyMilli: take });
        a.qtyMilli -= take;
        need -= take;
      }
      plans.set(l.orderLineId, { orderLineId: l.orderLineId, productId, alloc });
    }
  }
  return lines.map((l) => plans.get(l.orderLineId)!);
}

/** Ghi: tăng qty_reserved_milli của lô + dòng reservations. Đưa vào cùng batch với tạo/xác nhận đơn. */
export function reserveStmts(db: D1Database, orderId: number, plans: ReservationPlan[]): D1PreparedStatement[] {
  const s: D1PreparedStatement[] = [];
  for (const p of plans)
    for (const a of p.alloc) {
      s.push(
        db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli + ? WHERE id = ?`).bind(a.qtyMilli, a.lotId),
        db
          .prepare(`INSERT INTO reservations(order_id, order_line_id, lot_id, qty_milli) VALUES (?,?,?,?)`)
          .bind(orderId, p.orderLineId, a.lotId, a.qtyMilli),
      );
    }
  return s;
}

interface ResvRow {
  id: number;
  order_line_id: number;
  lot_id: number;
  qty_milli: number;
  product_id: number;
  unit_cost: number;
}

async function activeReservations(db: D1Database, orderId: number) {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.order_line_id, r.lot_id, r.qty_milli, l.product_id, l.unit_cost
         FROM reservations r JOIN lots l ON l.id = r.lot_id
        WHERE r.order_id = ? AND r.status = 'active'
        ORDER BY (l.expires_at IS NULL), l.expires_at, l.id`,
    )
    .bind(orderId)
    .all<ResvRow>();
  return results;
}

/** Nhả toàn bộ giữ tồn của đơn (huỷ đơn, EC-06). */
export async function releaseOrderStmts(db: D1Database, orderId: number): Promise<D1PreparedStatement[]> {
  const rows = await activeReservations(db, orderId);
  const now = new Date().toISOString();
  if (!rows.length) return [];
  return [
    // Chốt chặn (audit #7): các dòng giữ tồn phải còn đúng như lúc đọc, nếu không (nhả đôi) cả batch rollback
    activeCountGuard(db, orderId, rows.length),
    ...rows.flatMap((r) => [
      // Chỉ trừ qty_reserved khi dòng giữ còn 'active' — nhả lần hai không được "ăn" phần giữ của đơn khác
      db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli - ? WHERE id = ? AND EXISTS (SELECT 1 FROM reservations WHERE id = ? AND status = 'active')`).bind(r.qty_milli, r.lot_id, r.id),
      db.prepare(`UPDATE reservations SET status='released', closed_at=? WHERE id=? AND status='active'`).bind(now, r.id),
    ]),
  ];
}

/** Số dòng giữ tồn đang active của đơn phải đúng bằng n (batch rollback 409 state_changed nếu đã bị nhả/xuất ở nơi khác). */
export function activeCountGuard(db: D1Database, orderId: number, n: number) {
  return assertStmt(db, "reservations.active", `SELECT COUNT(*) = ? FROM reservations WHERE order_id = ? AND status = 'active'`, [n, orderId]);
}

export interface ConsumeResult {
  stmts: D1PreparedStatement[];
  /** Phân bổ thực xuất theo dòng (để ghi order_line_lots và tính giá vốn). */
  allocByLine: Map<number, LotAllocation[]>;
  /** Dòng nào giữ không đủ số giao (cần phân bổ thêm từ tồn tự do). */
  shortByLine: Map<number, number>;
}

/**
 * Xuất kho khi giao (M4-05/06, EC-26): với mỗi dòng, tiêu thụ phần giữ theo FEFO đúng số thực giao,
 * phần giữ dư được nhả. Trừ đồng thời qty_on_hand và qty_reserved trong MỘT câu UPDATE (CHECK luôn đúng),
 * ghi stock_moves move_type='sale'.
 */
export async function consumeForDeliveryStmts(
  db: D1Database,
  orderId: number,
  deliveredByLine: Map<number, number>,
  refType: string,
  refId: number,
  userId: number,
): Promise<ConsumeResult> {
  const rows = await activeReservations(db, orderId);
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [activeCountGuard(db, orderId, rows.length)];
  const allocByLine = new Map<number, LotAllocation[]>();
  const remaining = new Map(deliveredByLine);
  for (const r of rows) {
    const need = remaining.get(r.order_line_id) ?? 0;
    const take = Math.min(need, r.qty_milli);
    const release = r.qty_milli - take;
    if (take > 0) {
      stmts.push(
        db
          .prepare(`UPDATE lots SET qty_on_hand_milli = qty_on_hand_milli - ?1, qty_reserved_milli = qty_reserved_milli - ?2 WHERE id = ?3 AND EXISTS (SELECT 1 FROM reservations WHERE id = ?4 AND status = 'active')`)
          .bind(take, r.qty_milli, r.lot_id, r.id),
        db
          .prepare(
            `INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id)
             VALUES (?,?,?,?, 'sale', ?, ?, ?)`,
          )
          .bind(r.lot_id, r.product_id, -take, r.unit_cost, refType, refId, userId),
      );
      const list = allocByLine.get(r.order_line_id) ?? [];
      list.push({ lotId: r.lot_id, qtyMilli: take, unitCost: r.unit_cost });
      allocByLine.set(r.order_line_id, list);
      remaining.set(r.order_line_id, need - take);
    } else {
      stmts.push(db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli - ? WHERE id = ? AND EXISTS (SELECT 1 FROM reservations WHERE id = ? AND status = 'active')`).bind(release, r.lot_id, r.id));
    }
    stmts.push(
      db.prepare(`UPDATE reservations SET status=?, closed_at=? WHERE id=? AND status='active'`).bind(take > 0 ? "consumed" : "released", now, r.id),
    );
  }
  const shortByLine = new Map<number, number>();
  for (const [line, q] of remaining) if (q > 0) shortByLine.set(line, q);
  return { stmts, allocByLine, shortByLine };
}

/**
 * EC-15: lô đang giữ cho đơn bị hết hạn / chuyển quarantine → nhả và giữ lại từ lô khác nếu còn.
 * Trả danh sách đơn thiếu hàng để báo người phụ trách. Gọi từ cron hằng ngày và khi ghi hao hụt một lô.
 */
export async function swapBadReservations(db: D1Database, storeId: number) {
  const now = new Date().toISOString();
  const { results } = await db
    .prepare(
      `SELECT r.id, r.order_id, r.order_line_id, r.lot_id, r.qty_milli, l.product_id
         FROM reservations r JOIN lots l ON l.id = r.lot_id
        WHERE r.status = 'active' AND (l.status <> 'active' OR (l.expires_at IS NOT NULL AND l.expires_at <= ?))`,
    )
    .bind(now)
    .all<{ id: number; order_id: number; order_line_id: number; lot_id: number; qty_milli: number; product_id: number }>();
  const swapped: number[] = [];
  const short: { orderId: number; orderLineId: number; productId: number; missingMilli: number }[] = [];
  for (const r of results) {
    const release = [
      db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli - ? WHERE id = ? AND EXISTS (SELECT 1 FROM reservations WHERE id = ? AND status = 'active')`).bind(r.qty_milli, r.lot_id, r.id),
      db.prepare(`UPDATE reservations SET status='released', closed_at=? WHERE id=? AND status='active'`).bind(now, r.id),
    ];
    try {
      const alloc = await allocateFefo(db, r.product_id, r.qty_milli, storeId);
      await db.batch([...release, ...reserveStmts(db, r.order_id, [{ orderLineId: r.order_line_id, productId: r.product_id, alloc }])]);
      swapped.push(r.order_id);
    } catch {
      await db.batch(release);
      short.push({ orderId: r.order_id, orderLineId: r.order_line_id, productId: r.product_id, missingMilli: r.qty_milli });
    }
  }
  return { swapped, short };
}
