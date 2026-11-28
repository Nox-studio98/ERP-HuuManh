import { allocateFefoPartial, type LotAllocation } from "./stock";
import { reserveStmts, type LineToReserve, type ReservationPlan } from "./reservations";
import { assertStmt } from "./guard";
import { sysAuditStmt } from "./sysaudit";
import { enqueueJobStmt } from "./outbox";
import { getSettingInt } from "./settings";

/**
 * Phần thiếu của SO (docs/PO-NCC.md mục 3.1, 4.1): xác nhận SO khi thiếu hàng không bị từ chối —
 * giữ FEFO phần có tồn, ghi phần còn lại vào `so_shortages` TRONG CÙNG batch. Khi hàng về (nhận theo PO) phần thiếu được giữ
 * theo thứ tự `need_by` rồi thời điểm tạo.
 */

export const allowShortConfirm = async (db: D1Database) => (await getSettingInt(db, "po.allow_short_confirm", 1)) === 1;

export interface ShortLine {
  orderLineId: number;
  productId: number;
  missingMilli: number;
}

/**
 * Như planReservations nhưng KHÔNG ném lỗi khi thiếu: mỗi dòng giữ phần có tồn, phần còn lại trả về trong `short`.
 * Gộp theo sản phẩm (hai dòng cùng sản phẩm không giữ trùng tồn), dòng đứng trước được ưu tiên.
 */
export async function planPartialReservations(
  db: D1Database,
  lines: LineToReserve[],
  storeId: number,
): Promise<{ plans: ReservationPlan[]; short: ShortLine[] }> {
  const byProduct = new Map<number, LineToReserve[]>();
  for (const l of lines) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
  const plans = new Map<number, ReservationPlan>();
  const short: ShortLine[] = [];
  for (const [productId, ls] of byProduct) {
    const total = ls.reduce((s, l) => s + l.qtyMilli, 0);
    const { alloc } = await allocateFefoPartial(db, productId, total, storeId);
    const pool = alloc.map((a) => ({ ...a }));
    for (const l of ls) {
      const got: LotAllocation[] = [];
      let need = l.qtyMilli;
      for (const a of pool) {
        if (need <= 0) break;
        if (a.qtyMilli <= 0) continue;
        const take = Math.min(a.qtyMilli, need);
        got.push({ lotId: a.lotId, unitCost: a.unitCost, qtyMilli: take });
        a.qtyMilli -= take;
        need -= take;
      }
      plans.set(l.orderLineId, { orderLineId: l.orderLineId, productId, alloc: got });
      if (need > 0) short.push({ orderLineId: l.orderLineId, productId, missingMilli: need });
    }
  }
  return { plans: lines.map((l) => plans.get(l.orderLineId)!), short };
}

/** Ghi phần thiếu (upsert theo dòng đơn: xác nhận lại đơn không sinh dòng trùng). */
export function shortageUpsertStmts(db: D1Database, orderId: number, needBy: string | null, short: ShortLine[]): D1PreparedStatement[] {
  return short.map((s) =>
    db
      .prepare(
        `INSERT INTO so_shortages(order_id, order_line_id, product_id, initial_milli, qty_milli, need_by) VALUES (?,?,?,?,?,?)
         ON CONFLICT(order_line_id) DO UPDATE SET initial_milli = excluded.initial_milli, qty_milli = excluded.qty_milli, need_by = excluded.need_by,
           status = 'open', closed_at = NULL, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .bind(orderId, s.orderLineId, s.productId, s.missingMilli, s.missingMilli, needBy),
  );
}

/** Đóng phần thiếu còn mở của đơn (huỷ đơn, giao xong, sửa đơn). Lịch sử giữ ở bảng (status cancelled) để màn PO cảnh báo "nguồn đã huỷ". */
export const closeOrderShortagesStmt = (db: D1Database, orderId: number) =>
  db.prepare(`UPDATE so_shortages SET status = 'cancelled', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE order_id = ? AND status = 'open'`).bind(orderId);

/** Xoá hẳn phần thiếu của đơn (khi sửa dòng đơn: dòng cũ bị xoá nên khoá ngoại order_line_id phải gỡ trước). Lịch sử còn trong audit_log. */
export const deleteOrderShortagesStmts = (db: D1Database, orderId: number): D1PreparedStatement[] => [
  db.prepare(`DELETE FROM po_shortage_links WHERE shortage_id IN (SELECT id FROM so_shortages WHERE order_id = ?)`).bind(orderId),
  db.prepare(`DELETE FROM so_shortages WHERE order_id = ?`).bind(orderId),
];

/** Tổng phần còn thiếu theo dòng của một đơn (chỉ phần đang mở). */
export async function openShortByLine(db: D1Database, orderId: number): Promise<Map<number, number>> {
  const { results } = await db
    .prepare(`SELECT order_line_id, qty_milli FROM so_shortages WHERE order_id = ? AND status = 'open' AND qty_milli > 0`)
    .bind(orderId)
    .all<{ order_line_id: number; qty_milli: number }>();
  return new Map(results.map((r) => [r.order_line_id, r.qty_milli]));
}

/** Thông tin hiển thị cho từng dòng thiếu của đơn: còn thiếu, đã có PO nào phủ (không lộ giá). */
export async function shortageView(db: D1Database, orderId: number) {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.order_line_id, s.product_id, s.initial_milli, s.qty_milli, s.need_by, s.status,
              (SELECT po.code FROM po_shortage_links l JOIN purchase_order_lines pl ON pl.id = l.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
                WHERE l.shortage_id = s.id AND po.status NOT IN ('cancelled','rejected','closed') ORDER BY po.id DESC LIMIT 1) AS po_code,
              (SELECT po.status FROM po_shortage_links l JOIN purchase_order_lines pl ON pl.id = l.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
                WHERE l.shortage_id = s.id AND po.status NOT IN ('cancelled','rejected','closed') ORDER BY po.id DESC LIMIT 1) AS po_status,
              (SELECT COALESCE(po.expected_date, po.proposed_expected_date) FROM po_shortage_links l JOIN purchase_order_lines pl ON pl.id = l.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
                WHERE l.shortage_id = s.id AND po.status NOT IN ('cancelled','rejected','closed') ORDER BY po.id DESC LIMIT 1) AS po_expected
         FROM so_shortages s WHERE s.order_id = ? ORDER BY s.id`,
    )
    .bind(orderId)
    .all<any>();
  return results.map((r) => ({
    id: r.id, orderLineId: r.order_line_id, productId: r.product_id, initialMilli: r.initial_milli, qtyMilli: r.qty_milli, needBy: r.need_by, status: r.status as string,
    poCode: (r.po_code as string | null) ?? null, poStatus: (r.po_status as string | null) ?? null, poExpectedDate: (r.po_expected as string | null) ?? null,
  }));
}

/** Dọn phần thiếu của đơn đã huỷ / hoàn tất / trả (đường huỷ ở nơi khác, vd. website, cron). */
export const sweepDeadShortagesStmt = (db: D1Database) =>
  db.prepare(
    `UPDATE so_shortages SET status = 'cancelled', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status = 'open' AND order_id IN (SELECT id FROM orders WHERE status IN ('cancelled','completed','returned'))`,
  );

interface OpenShort {
  id: number;
  order_id: number;
  order_line_id: number;
  product_id: number;
  qty_milli: number;
  need_by: string | null;
  order_code: string;
  channel: string;
  store_id: number;
  status: string;
  product_name: string;
  base_unit: string;
}

const CHECK_FAIL = /CHECK constraint failed/i;

const OPEN_ORDER_SQL = `'confirmed','preparing','shipping','delivery_failed'`;
const IN_FLIGHT_PO_SQL = `'pending_approval','sent','supplier_proposed','confirmed','partially_received'`;

/**
 * Giữ FEFO từ tồn TỰ DO cho các phần thiếu đang mở (K-PO1b), ưu tiên ngày giao sớm rồi đơn tạo trước (K-PO1).
 * Dùng khi nhận hàng theo PO, trước khi chốt đêm / "Chốt ngay" tính nhu cầu, và trước khi xác nhận giao đơn sỉ.
 * Mỗi phần thiếu là một batch riêng, tự kiểm lại trạng thái (assertStmt) và chỉ giữ phần tồn đang có (CHECK reserved ≤ on_hand: EC-02).
 * Đủ → `filled` + thông báo cho người xử lý đơn.
 */
export async function fillShortagesFromStock(
  db: D1Database,
  opts: { productIds?: number[]; orderId?: number; actorUserId: number | null; poCode?: string | null },
) {
  const filled: { orderId: number; orderCode: string; productId: number; productName: string; baseUnit: string; qtyMilli: number; done: boolean }[] = [];
  const where = [`s.status = 'open'`, `s.qty_milli > 0`, `o.status IN (${OPEN_ORDER_SQL})`];
  const binds: unknown[] = [];
  if (opts.productIds) {
    if (!opts.productIds.length) return filled;
    where.push(`s.product_id IN (${opts.productIds.map(() => "?").join(",")})`);
    binds.push(...opts.productIds);
  }
  if (opts.orderId != null) (where.push(`s.order_id = ?`), binds.push(opts.orderId));
  const { results } = await db
    .prepare(
      `SELECT s.id, s.order_id, s.order_line_id, s.product_id, s.qty_milli, s.need_by, o.code AS order_code, o.channel, o.store_id, o.status, p.name AS product_name, p.base_unit
         FROM so_shortages s JOIN orders o ON o.id = s.order_id JOIN products p ON p.id = s.product_id
        WHERE ${where.join(" AND ")}
        ORDER BY s.product_id, (s.need_by IS NULL), s.need_by, s.created_at, s.id`,
    )
    .bind(...binds)
    .all<OpenShort>();
  const dry = new Set<string>(); // sản phẩm + kho đã hết tồn tự do: bỏ qua các phần thiếu sau
  for (const s of results) {
    const key = `${s.product_id}:${s.store_id}`;
    if (dry.has(key)) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await db.prepare(`SELECT qty_milli, status FROM so_shortages WHERE id = ?`).bind(s.id).first<{ qty_milli: number; status: string }>();
      if (!cur || cur.status !== "open" || cur.qty_milli <= 0) break;
      const { alloc, missingMilli } = await allocateFefoPartial(db, s.product_id, cur.qty_milli, s.store_id);
      const got = cur.qty_milli - missingMilli;
      if (got <= 0) {
        dry.add(key);
        break;
      }
      const left = cur.qty_milli - got;
      const title = `Đơn ${s.order_code} đã đủ hàng`;
      const body = opts.poCode ? `Hàng theo ${opts.poCode} đã về và được giữ cho đơn. Có thể soạn / giao.` : `Kho đã có hàng và được giữ cho đơn. Có thể soạn / giao.`;
      const stmts: D1PreparedStatement[] = [
        assertStmt(db, "so_shortage.fill", `SELECT status = 'open' AND qty_milli = ? FROM so_shortages WHERE id = ?`, [cur.qty_milli, s.id]),
        ...reserveStmts(db, s.order_id, [{ orderLineId: s.order_line_id, productId: s.product_id, alloc }]),
        db
          .prepare(`UPDATE so_shortages SET qty_milli = ?, status = ?, closed_at = ? WHERE id = ? AND status = 'open'`)
          .bind(left, left === 0 ? "filled" : "open", left === 0 ? new Date().toISOString() : null, s.id),
        sysAuditStmt(db, { action: "so_shortage.fill", entity: "order", entityId: s.order_id, after: { shortageId: s.id, po: opts.poCode ?? null, source: opts.poCode ? "po" : "free_stock", filledMilli: got, leftMilli: left } }, opts.actorUserId),
      ];
      if (left === 0) {
        // thông báo khi đơn không còn dòng thiếu nào
        stmts.push(
          db
            .prepare(
              `INSERT INTO notifications(kind, title, body, audience_perm, ref_type, ref_id)
               SELECT 'so_filled', ?, ?, ?, 'order', ? WHERE NOT EXISTS (SELECT 1 FROM so_shortages WHERE order_id = ? AND status = 'open' AND id <> ? AND qty_milli > 0)`,
            )
            .bind(title, body, s.channel === "b2b" ? "b2b.write" : "orders.online.manage", s.order_id, s.order_id, s.id),
          enqueueJobStmt(db, "notify.managers", "order", s.order_id, { title, body, url: s.channel === "b2b" ? "/b2b/orders" : "/online-orders" }),
        );
      }
      try {
        await db.batch(stmts);
      } catch (e) {
        const m = String((e as Error)?.message);
        if ((CHECK_FAIL.test(m) || m.includes("state_changed")) && attempt === 0) continue; // tồn / dòng thiếu vừa đổi: tính lại một lần
        if (CHECK_FAIL.test(m) || m.includes("state_changed")) break;
        throw e;
      }
      filled.push({ orderId: s.order_id, orderCode: s.order_code, productId: s.product_id, productName: s.product_name, baseUnit: s.base_unit, qtyMilli: got, done: left === 0 });
      break;
    }
  }
  return filled;
}

/**
 * Nhận hàng theo PO xong → giữ FEFO cho phần thiếu mở của các mặt hàng vừa nhận (không chỉ phần có liên kết với dòng PO này:
 * K-PO1), ưu tiên ngày giao sớm rồi đơn tạo trước. Phần thiếu đã có tồn tự do (nhập thường...) cũng được giữ luôn (K-PO1b).
 */
export async function allocateReceivedToShortages(
  db: D1Database,
  received: { poLineId: number; productId: number; qtyMilli: number }[],
  actorUserId: number | null,
  poCode: string,
) {
  return fillShortagesFromStock(db, { productIds: [...new Set(received.map((r) => r.productId))], actorUserId, poCode });
}

/**
 * Gắn phần thiếu đang mở vào dòng PO đang chạy còn "chỗ" (K-PO1): theo thứ tự ngày giao sớm → muộn, mỗi dòng PO chỉ gắn tối đa
 * số còn chờ nhận. Phần thiếu được coi là "đã có hàng sắp về" nhờ đó luôn có PO cụ thể (hiện trên chi tiết đơn, không đặt trùng).
 * Gọi lại nhiều lần an toàn (chỉ gắn phần chưa gắn).
 */
export async function linkCoveredShortages(db: D1Database, actorUserId: number | null, productIds?: number[]) {
  if (productIds && !productIds.length) return;
  const pf = productIds ? ` AND pl.product_id IN (${productIds.map(() => "?").join(",")})` : "";
  const lines = (
    await db
      .prepare(
        `SELECT pl.id, pl.product_id,
                MAX(COALESCE(pl.confirmed_qty_milli, pl.qty_milli) - pl.received_milli, 0) AS remaining
           FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id
          WHERE po.status IN (${IN_FLIGHT_PO_SQL})${pf} ORDER BY pl.id`,
      )
      .bind(...(productIds ?? []))
      .all<{ id: number; product_id: number; remaining: number }>()
  ).results;
  const cap = new Map<number, { id: number; free: number }[]>();
  for (const l of lines) cap.set(l.product_id, [...(cap.get(l.product_id) ?? []), { id: l.id, free: l.remaining }]);
  if (!cap.size) return;
  const sf = productIds ? ` AND s.product_id IN (${productIds.map(() => "?").join(",")})` : "";
  const shorts = (
    await db
      .prepare(
        `SELECT s.id, s.product_id, s.qty_milli FROM so_shortages s JOIN orders o ON o.id = s.order_id
          WHERE s.status = 'open' AND s.qty_milli > 0 AND o.status IN (${OPEN_ORDER_SQL})${sf}
          ORDER BY s.product_id, (s.need_by IS NULL), s.need_by, s.created_at, s.id`,
      )
      .bind(...(productIds ?? []))
      .all<{ id: number; product_id: number; qty_milli: number }>()
  ).results;
  // Gán lại từ đầu theo thứ tự ngày giao: đơn giao sớm được phủ trước, liên kết cũ lệch thứ tự (hoặc cũ do hàng đã về) được sắp lại
  const byProduct = new Map<number, D1PreparedStatement[]>();
  for (const [productId, slots] of cap) {
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          `DELETE FROM po_shortage_links WHERE po_line_id IN (${slots.map(() => "?").join(",")}) AND shortage_id IN (SELECT id FROM so_shortages WHERE status = 'open')`,
        )
        .bind(...slots.map((x) => x.id)),
    ];
    for (const s of shorts.filter((x) => x.product_id === productId)) {
      let need = s.qty_milli;
      for (const slot of slots) {
        if (need <= 0) break;
        if (slot.free <= 0) continue;
        const take = Math.min(slot.free, need);
        slot.free -= take;
        need -= take;
        stmts.push(
          db
            .prepare(`INSERT INTO po_shortage_links(po_line_id, shortage_id, qty_milli) VALUES (?,?,?) ON CONFLICT(po_line_id, shortage_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`)
            .bind(slot.id, s.id, take),
        );
      }
    }
    byProduct.set(productId, stmts);
  }
  for (const [productId, stmts] of byProduct)
    await db.batch([...stmts, sysAuditStmt(db, { action: "so_shortage.link_po", entity: "product", entityId: productId, after: { links: stmts.length - 1 } }, actorUserId)]);
}

/** Phần thiếu đang mở của nhiều đơn (cho nhãn "Chờ hàng X" ở danh sách): orderId → [{ productName, qtyMilli, baseUnit }]. */
export async function openShortLinesFor(db: D1Database, orderIds: number[]) {
  const out = new Map<number, { productName: string; qtyMilli: number; baseUnit: string }[]>();
  if (!orderIds.length) return out;
  const { results } = await db
    .prepare(
      `SELECT s.order_id, s.qty_milli, p.name, p.base_unit FROM so_shortages s JOIN products p ON p.id = s.product_id
        WHERE s.status = 'open' AND s.qty_milli > 0 AND s.order_id IN (${orderIds.map(() => "?").join(",")}) ORDER BY s.id`,
    )
    .bind(...orderIds)
    .all<{ order_id: number; qty_milli: number; name: string; base_unit: string }>();
  for (const r of results) out.set(r.order_id, [...(out.get(r.order_id) ?? []), { productName: r.name, qtyMilli: r.qty_milli, baseUnit: r.base_unit }]);
  return out;
}
