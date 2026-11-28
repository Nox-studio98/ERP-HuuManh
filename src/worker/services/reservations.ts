import { allocateFefo, allocateFefoPartial, type LotAllocation } from "./stock";
import { assertStmt } from "./guard";
import { sysAuditStmt } from "./sysaudit";
import { enqueueJobStmt } from "./outbox";
import { AppError, conflict } from "../lib/errors";
import { getSettingInt } from "./settings";

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
  await ensureReservationsDeliverable(db, orderId);
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


const BAD_LOT_SQL = `(l.status <> 'active' OR (l.expires_at IS NOT NULL AND l.expires_at <= ?))`;

export interface SwapShort {
  orderId: number;
  orderCode: string;
  orderLineId: number;
  productId: number;
  lotId: number;
  lotCode: string;
  missingMilli: number;
}

/**
 * EC-15 (B-03): lô đang giữ cho đơn bị hết hạn / chuyển quarantine → chuyển phần giữ sang lô tốt khác theo FEFO.
 * Phần không thay được: nhả giữ, đánh dấu đơn (orders.reservation_short_*), ghi thông báo cho quản lý
 * (notifications + job push) và audit. Gọi từ: cron hằng ngày (mọi cửa hàng), ngay khi cách ly lô
 * (opts.lotId), trước khi giao hàng (opts.orderId).
 * storeId: chỉ xử lý các lô thuộc cửa hàng đó và chỉ lấy lô thay thế trong cửa hàng đó.
 */
export async function swapBadReservations(
  db: D1Database,
  storeId: number,
  opts: { lotId?: number; orderId?: number; actorId?: number | null } = {},
) {
  const now = new Date().toISOString();
  const where = [`r.status = 'active'`, `loc.store_id = ?`, BAD_LOT_SQL];
  const binds: unknown[] = [storeId, now];
  if (opts.lotId != null) (where.push("r.lot_id = ?"), binds.push(opts.lotId));
  if (opts.orderId != null) (where.push("r.order_id = ?"), binds.push(opts.orderId));
  const { results } = await db
    .prepare(
      `SELECT r.id, r.order_id, r.order_line_id, r.lot_id, r.qty_milli, l.product_id, l.lot_code, o.code AS order_code, o.channel, o.status AS order_status,
              COALESCE(o.delivery_date, o.slot_date) AS need_by
         FROM reservations r JOIN lots l ON l.id = r.lot_id JOIN locations loc ON loc.id = l.location_id JOIN orders o ON o.id = r.order_id
        WHERE ${where.join(" AND ")} ORDER BY r.id`,
    )
    .bind(...binds)
    .all<{ id: number; order_id: number; order_line_id: number; lot_id: number; qty_milli: number; product_id: number; lot_code: string; order_code: string; channel: string; order_status: string; need_by: string | null }>();
  const allowShort = (await getSettingInt(db, "po.allow_short_confirm", 1)) === 1;
  const swapped: number[] = [];
  const short: SwapShort[] = [];
  for (const r of results) {
    const { alloc, missingMilli } = await allocateFefoPartial(db, r.product_id, r.qty_milli, storeId, { at: now, excludeLotIds: [r.lot_id] });
    const stmts: D1PreparedStatement[] = [
      assertStmt(db, "reservation.swap", `SELECT status = 'active' AND qty_milli = ? FROM reservations WHERE id = ?`, [r.qty_milli, r.id]),
      db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli - ? WHERE id = ?`).bind(r.qty_milli, r.lot_id),
      db.prepare(`UPDATE reservations SET status='released', closed_at=? WHERE id=? AND status='active'`).bind(now, r.id),
    ];
    if (alloc.length) stmts.push(...reserveStmts(db, r.order_id, [{ orderLineId: r.order_line_id, productId: r.product_id, alloc }]));
    if (missingMilli > 0) {
      const title = `Đơn ${r.order_code} thiếu hàng do lô ${r.lot_code} hỏng/hết hạn`;
      const body = `Thiếu ${missingMilli / 1000} (đơn vị chính) chưa có lô thay thế — cần liên hệ khách hoặc bổ sung hàng.`;
      stmts.push(
        db.prepare(`UPDATE orders SET reservation_short_milli = reservation_short_milli + ?, reservation_short_at = ? WHERE id = ?`).bind(missingMilli, now, r.order_id),
        // K-KHO2: ghi phần thiếu để đơn hiện "Chờ hàng" và vào chốt đêm / PO (cộng dồn vào dòng thiếu đang mở của dòng đơn)
        ...(allowShort && (r.channel === "b2b" || r.channel === "online") && ["confirmed", "preparing", "shipping", "delivery_failed"].includes(r.order_status)
          ? [
              db
                .prepare(
                  `INSERT INTO so_shortages(order_id, order_line_id, product_id, initial_milli, qty_milli, need_by) VALUES (?,?,?,?,?,?)
                   ON CONFLICT(order_line_id) DO UPDATE SET
                     initial_milli = CASE WHEN status = 'open' THEN initial_milli + excluded.initial_milli ELSE excluded.initial_milli END,
                     qty_milli = CASE WHEN status = 'open' THEN qty_milli + excluded.qty_milli ELSE excluded.qty_milli END,
                     need_by = excluded.need_by, status = 'open', closed_at = NULL`,
                )
                .bind(r.order_id, r.order_line_id, r.product_id, missingMilli, missingMilli, r.need_by),
            ]
          : []),
        db.prepare(`INSERT INTO notifications(kind, title, body, audience_perm, ref_type, ref_id) VALUES ('reservation_short', ?, ?, 'inventory.approve', 'order', ?)`).bind(title, body, r.order_id),
        enqueueJobStmt(db, "notify.managers", "order", r.order_id, { title, body, url: "/orders" }),
        sysAuditStmt(db, { action: "reservation.short_after_swap", entity: "order", entityId: r.order_id, after: { lotId: r.lot_id, lotCode: r.lot_code, orderLineId: r.order_line_id, missingMilli } }, opts.actorId ?? null),
      );
    }
    try {
      await db.batch(stmts);
    } catch (e) {
      if (String((e as Error)?.message).includes("state_changed")) continue; // đã được xử lý song song
      throw e;
    }
    if (alloc.length) swapped.push(r.order_id);
    if (missingMilli > 0) short.push({ orderId: r.order_id, orderCode: r.order_code, orderLineId: r.order_line_id, productId: r.product_id, lotId: r.lot_id, lotCode: r.lot_code, missingMilli });
  }
  return { swapped: [...new Set(swapped)], short };
}

/** Chạy swap cho mọi cửa hàng (cron). */
export async function swapBadReservationsAllStores(db: D1Database) {
  const { results } = await db.prepare(`SELECT id FROM stores`).all<{ id: number }>();
  const out = { swapped: [] as number[], short: [] as SwapShort[] };
  for (const s of results) {
    const r = await swapBadReservations(db, s.id);
    out.swapped.push(...r.swapped);
    out.short.push(...r.short);
  }
  return out;
}

/**
 * B-04: trước khi giao, các lô đang giữ cho đơn phải còn bán được (active, chưa hết hạn). Lô hỏng → thử đổi sang lô tốt (FEFO);
 * không thay được → 409 lot_expired kèm các dòng thiếu (đơn đã được đánh dấu + báo quản lý).
 */
export async function ensureReservationsDeliverable(db: D1Database, orderId: number) {
  const now = new Date().toISOString();
  const bad = await db
    .prepare(
      `SELECT DISTINCT loc.store_id AS store_id FROM reservations r JOIN lots l ON l.id = r.lot_id JOIN locations loc ON loc.id = l.location_id
        WHERE r.order_id = ? AND r.status = 'active' AND ${BAD_LOT_SQL}`,
    )
    .bind(orderId, now)
    .all<{ store_id: number }>();
  if (!bad.results.length) return;
  const lines: SwapShort[] = [];
  for (const s of bad.results) lines.push(...(await swapBadReservations(db, s.store_id, { orderId })).short);
  if (lines.length) {
    throw conflict("lot_expired", "Lô đang giữ cho đơn đã hết hạn / bị cách ly và không còn lô thay thế — không thể giao", { lines });
  }
}

/**
 * B-03: giải phóng `needFreeMilli` tồn khả dụng của một lô bằng cách chuyển phần giữ của các đơn sang lô khác (FEFO, cùng cửa hàng).
 * Dùng khi ghi hao hụt / điều chỉnh / kiểm kê giảm vượt phần khả dụng. Trả số còn thiếu (0 = đã đủ).
 */
export async function freeLotReservations(db: D1Database, lotId: number, needFreeMilli: number): Promise<number> {
  const lot = await db
    .prepare(`SELECT l.product_id, l.qty_on_hand_milli, l.qty_reserved_milli, loc.store_id FROM lots l JOIN locations loc ON loc.id = l.location_id WHERE l.id = ?`)
    .bind(lotId)
    .first<{ product_id: number; qty_on_hand_milli: number; qty_reserved_milli: number; store_id: number }>();
  if (!lot) throw new AppError(422, "unknown_lot", "Không tìm thấy lô hàng");
  let extra = needFreeMilli - (lot.qty_on_hand_milli - lot.qty_reserved_milli);
  if (extra <= 0) return 0;
  const now = new Date().toISOString();
  const { results } = await db
    .prepare(`SELECT id, order_id, order_line_id, qty_milli FROM reservations WHERE lot_id = ? AND status = 'active' ORDER BY id DESC`)
    .bind(lotId)
    .all<{ id: number; order_id: number; order_line_id: number; qty_milli: number }>();
  for (const r of results) {
    if (extra <= 0) break;
    const want = Math.min(r.qty_milli, extra);
    const { alloc } = await allocateFefoPartial(db, lot.product_id, want, lot.store_id, { at: now, excludeLotIds: [lotId] });
    const got = alloc.reduce((s, a) => s + a.qtyMilli, 0);
    if (got <= 0) continue;
    await db.batch([
      assertStmt(db, "reservation.relocate", `SELECT status = 'active' AND qty_milli = ? FROM reservations WHERE id = ?`, [r.qty_milli, r.id]),
      db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli - ? WHERE id = ?`).bind(got, lotId),
      got === r.qty_milli
        ? db.prepare(`UPDATE reservations SET status='released', closed_at=? WHERE id=?`).bind(now, r.id)
        : db.prepare(`UPDATE reservations SET qty_milli = qty_milli - ? WHERE id=?`).bind(got, r.id),
      ...reserveStmts(db, r.order_id, [{ orderLineId: r.order_line_id, productId: lot.product_id, alloc }]),
      sysAuditStmt(db, { action: "reservation.relocate", entity: "order", entityId: r.order_id, after: { fromLotId: lotId, toLots: alloc, qtyMilli: got } }),
    ]);
    extra -= got;
  }
  return Math.max(extra, 0);
}
