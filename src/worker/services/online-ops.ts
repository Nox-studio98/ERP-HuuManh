import type { Context } from "hono";
import type { AppBindings } from "../env";
import { auditStmt } from "../lib/audit";
import { AppError, conflict, notFound } from "../lib/errors";
import { can } from "../lib/rbac";
import { lineAmount, toMilli } from "../lib/money";
import { vnDate } from "../lib/time";
import { allocateFefo, allocationCost, availableQty, moveStatements, type LotAllocation } from "./stock";
import { resolvePrice } from "./pricing";
import { nextCode } from "../lib/codes";
import { consumeForDeliveryStmts, planReservations, releaseOrderStmts, reserveStmts } from "./reservations";
import { enqueueJobStmt, kickJobs } from "./outbox";
import { CUSTOMER_LABEL, newTrackingToken, normalizeVi, transitionStmts, type OnlineStatus } from "./online-orders";
import { guardStmts, notifyJob, refundPlan, runOrderBatch } from "./online-payments";
import { unitFactor } from "./http";

type Ctx = Context<AppBindings>;

/** Kênh ERP được xử lý trong luồng này (Fresco có luồng riêng, chỉ xem). */
export const OPS_CHANNELS = ["online", "social"];

export async function loadOpsOrder(db: D1Database, id: number, channels = OPS_CHANNELS) {
  const o = await db.prepare(`SELECT * FROM orders WHERE id = ? AND kind='sale'`).bind(id).first<any>();
  if (!o || !channels.includes(o.channel)) throw notFound("order_not_found", "Không tìm thấy đơn online");
  return o;
}

const staff = (c: Ctx) => ({ type: "staff" as const, id: c.get("user").id });

async function finish(c: Ctx, id: number) {
  await kickJobs(c.env, "order", id);
}

// ---------------------------------------------------------------- confirm / prepare

export async function confirmOrder(c: Ctx, id: number) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  const stmts: D1PreparedStatement[] = [];
  const t = transitionStmts(db, id, o.status, "confirmed", staff(c), { note: "Đơn đã được xác nhận" });
  const pre = (await db.prepare(`SELECT id, product_id, preorder_milli FROM order_lines WHERE order_id=? AND preorder_milli > 0`).bind(id).all<any>()).results;
  if (pre.length) {
    // M8-08: đặt trước chỉ xác nhận khi đủ hàng cho phần chờ → giữ tồn phần đó
    let plans;
    try {
      plans = await planReservations(db, pre.map((l) => ({ orderLineId: l.id, productId: l.product_id, qtyMilli: l.preorder_milli })), o.store_id);
    } catch (e) {
      if (e instanceof AppError && e.code === "insufficient_stock") throw conflict("preorder_not_ready", "Hàng đặt trước chưa về đủ, chưa thể xác nhận", e.details);
      throw e;
    }
    stmts.push(t[0], ...reserveStmts(db, id, plans), db.prepare(`UPDATE order_lines SET preorder_milli = 0 WHERE order_id = ? AND preorder_milli > 0`).bind(id), ...t.slice(1));
  } else stmts.push(...t);
  stmts.push(notifyJob(db, id, { status: "confirmed" }), auditStmt(c, { action: "online_order.confirm", entity: "order", entityId: id, before: { status: o.status }, after: { status: "confirmed", preorderFulfilled: pre.length > 0 } }));
  await runOrderBatch(db, id, o.status, stmts);
  await finish(c, id);
}

export async function prepareOrder(c: Ctx, id: number) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  await runOrderBatch(db, id, o.status, [
    ...transitionStmts(db, id, o.status, "preparing", staff(c), { note: "Đang chuẩn bị hàng" }),
    notifyJob(db, id, { status: "preparing" }),
    auditStmt(c, { action: "online_order.prepare", entity: "order", entityId: id, before: { status: o.status }, after: { status: "preparing" } }),
  ]);
  await finish(c, id);
}

// ---------------------------------------------------------------- pack (EC-03)

export async function packOrder(c: Ctx, id: number, input: { lines: { orderLineId: number; actualQty: number; unit?: string }[]; note?: string }) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  if (o.status !== "preparing") throw conflict("invalid_transition", "Chỉ cân/đóng gói khi đơn đang chuẩn bị", { from: o.status });
  const hasLots = await db.prepare(`SELECT 1 AS x FROM order_line_lots oll JOIN order_lines ol ON ol.id = oll.order_line_id WHERE ol.order_id=? LIMIT 1`).bind(id).first();
  if (hasLots) throw conflict("already_deducted", "Hàng đã xuất kho ở lần giao trước, không cân lại");
  const lines = (await db.prepare(`SELECT * FROM order_lines WHERE order_id=? ORDER BY id`).bind(id).all<any>()).results;
  const byId = new Map(lines.map((l) => [l.id, l]));
  const actual = new Map<number, number>();
  for (const l of input.lines) {
    const ol = byId.get(l.orderLineId);
    if (!ol) throw new AppError(422, "line_not_found", "Dòng hàng không thuộc đơn này", { orderLineId: l.orderLineId });
    if (actual.has(ol.id)) throw new AppError(422, "validation_error", "Dòng hàng bị lặp", { orderLineId: ol.id });
    const factor = await unitFactor(db, ol.product_id, l.unit ?? ol.unit);
    actual.set(ol.id, toMilli(l.actualQty, factor));
  }
  const tolBp = Number((await db.prepare(`SELECT value FROM settings WHERE key='online.weight_tolerance_bp'`).first<{ value: string }>())?.value ?? 1000);
  let baseline = 0, subtotal = 0;
  const stmts: D1PreparedStatement[] = [];
  const [g1, g2] = guardStmts(db, id, "preparing");
  stmts.push(g1);
  for (const l of lines) {
    const ordered = l.ordered_qty_milli ?? l.qty_milli;
    const qty = actual.get(l.id) ?? l.qty_milli;
    baseline += lineAmount(l.unit_price, ordered);
    const gross = lineAmount(l.unit_price, qty);
    subtotal += gross;
    stmts.push(
      db.prepare(`UPDATE order_lines SET qty_milli=?, line_total=?, ordered_qty_milli=COALESCE(ordered_qty_milli, ?) WHERE id=?`).bind(qty, Math.max(0, gross - l.discount), l.qty_milli, l.id),
    );
  }
  const total = Math.max(0, subtotal - o.discount) + o.shipping_fee;
  const devBp = baseline > 0 ? Math.round((Math.abs(subtotal - baseline) * 10000) / baseline) : 0;
  const weightStatus = devBp <= (Number.isFinite(tolBp) ? tolBp : 1000) ? "auto_accepted" : "pending_customer";
  const pending = weightStatus === "pending_customer";
  stmts.push(
    db.prepare(`UPDATE orders SET subtotal=?, total=?, weight_adjust_status=? WHERE id=? AND status='preparing'`).bind(subtotal, total, weightStatus, id),
    db
      .prepare(`INSERT INTO order_events(order_id, status, note, internal_note, actor_type, actor_id) VALUES (?,?,?,?, 'staff', ?)`)
      .bind(id, "preparing", pending ? "Khối lượng thực tế chênh lệch, vui lòng xác nhận lại" : "Đã cân hàng, tổng tiền được cập nhật", input.note ?? null, c.get("user").id),
    g2,
    notifyJob(db, id, { status: "preparing", ...(pending ? { event: "weight_pending" } : {}) }),
    auditStmt(c, {
      action: "online_order.pack", entity: "order", entityId: id,
      before: { subtotal: o.subtotal, total: o.total, weightAdjustStatus: o.weight_adjust_status },
      after: { subtotal, total, baseline, deviationBp: devBp, toleranceBp: tolBp, weightAdjustStatus: weightStatus },
    }),
  );
  await runOrderBatch(db, id, "preparing", stmts);
  await finish(c, id);
  return { weightAdjustStatus: weightStatus, deviationBp: devBp, baseline, subtotal, total };
}

// ---------------------------------------------------------------- ship (EC-05)

/** Chia một phân bổ lô cho nhiều dòng theo thứ tự. */
function splitAlloc(alloc: LotAllocation[], qtys: number[]): LotAllocation[][] {
  const pool = alloc.map((a) => ({ ...a }));
  let i = 0;
  return qtys.map((q) => {
    const out: LotAllocation[] = [];
    let need = q;
    while (need > 0 && i < pool.length) {
      const take = Math.min(pool[i].qtyMilli, need);
      out.push({ lotId: pool[i].lotId, unitCost: pool[i].unitCost, qtyMilli: take });
      pool[i].qtyMilli -= take;
      need -= take;
      if (pool[i].qtyMilli === 0) i++;
    }
    return out;
  });
}

export async function shipOrder(c: Ctx, id: number, input: { carrier?: string; trackingNo?: string }) {
  const db = c.env.DB;
  const user = c.get("user");
  const o = await loadOpsOrder(db, id);
  if (o.status !== "preparing") throw conflict("invalid_transition", "Chỉ giao khi đơn đang chuẩn bị", { from: o.status });
  if ((o.payment_method === "transfer" || o.payment_method === "gateway") && o.payment_status !== "paid") {
    throw conflict("payment_required", "Đơn chuyển khoản/cổng thanh toán chưa nhận được tiền, chưa thể giao", { paymentStatus: o.payment_status });
  }
  if (o.weight_adjust_status === "pending_customer" || o.weight_adjust_status === "rejected") {
    throw conflict("weight_not_accepted", "Khách chưa xác nhận khối lượng thực tế", { weightAdjustStatus: o.weight_adjust_status });
  }
  const lines = (await db.prepare(`SELECT * FROM order_lines WHERE order_id=? ORDER BY id`).bind(id).all<any>()).results;
  const already = await db.prepare(`SELECT 1 AS x FROM order_line_lots oll JOIN order_lines ol ON ol.id = oll.order_line_id WHERE ol.order_id=? LIMIT 1`).bind(id).first();
  let consume: D1PreparedStatement[] = [];
  let costTotal = 0;
  if (!already) {
    // Xuất kho theo số thực cân: tiêu thụ phần giữ (FEFO), phần dư giữ nhả, phần thiếu lấy thêm từ tồn tự do.
    const delivered = new Map(lines.map((l) => [l.id, l.qty_milli as number]));
    const res = await consumeForDeliveryStmts(db, id, delivered, "order", id, user.id);
    const allocByLine = new Map(res.allocByLine);
    const extra: D1PreparedStatement[] = [];
    const shortByProduct = new Map<number, { line: any; q: number }[]>();
    for (const [lineId, q] of res.shortByLine) {
      const l = lines.find((x) => x.id === lineId)!;
      shortByProduct.set(l.product_id, [...(shortByProduct.get(l.product_id) ?? []), { line: l, q }]);
    }
    for (const [pid, items] of shortByProduct) {
      const alloc = await allocateFefo(db, pid, items.reduce((s, x) => s + x.q, 0), o.store_id);
      extra.push(...moveStatements(db, pid, alloc, -1, "sale", "order", id, user.id));
      splitAlloc(alloc, items.map((x) => x.q)).forEach((a, i) => allocByLine.set(items[i].line.id, [...(allocByLine.get(items[i].line.id) ?? []), ...a]));
    }
    const lotStmts: D1PreparedStatement[] = [];
    for (const l of lines) {
      const a = allocByLine.get(l.id) ?? [];
      const cost = allocationCost(a);
      costTotal += cost;
      lotStmts.push(db.prepare(`UPDATE order_lines SET cost_amount=? WHERE id=?`).bind(cost, l.id));
      for (const x of a) lotStmts.push(db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(l.id, x.lotId, x.qtyMilli, x.unitCost));
    }
    consume = [...res.stmts, ...extra, ...lotStmts];
  }
  const t = transitionStmts(db, id, "preparing", "shipping", staff(c), {
    note: "Đơn đã được giao cho đơn vị vận chuyển",
    extraSet: `carrier = ?3, carrier_tracking_no = ?4${already ? "" : ", cost_total = ?5"}`,
    extraBinds: already ? [input.carrier ?? null, input.trackingNo ?? null] : [input.carrier ?? null, input.trackingNo ?? null, costTotal],
  });
  const stmts: D1PreparedStatement[] = [t[0], ...consume, ...t.slice(1)];
  stmts.push(
    notifyJob(db, id, { status: "shipping" }),
    auditStmt(c, { action: "online_order.ship", entity: "order", entityId: id, before: { status: "preparing" }, after: { status: "shipping", costTotal, carrier: input.carrier ?? null, restockedBefore: !!already } }),
  );
  await runOrderBatch(db, id, "preparing", stmts);
  await finish(c, id);
}

// ---------------------------------------------------------------- deliver / fail / redeliver

export async function deliverOrder(c: Ctx, id: number) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  const stmts: D1PreparedStatement[] = [];
  let t: D1PreparedStatement[];
  if (o.payment_method === "cod" && o.payment_status !== "paid") {
    const fund = await db.prepare(`SELECT id FROM funds WHERE type='cod_clearing' AND active=1 ORDER BY id LIMIT 1`).first<{ id: number }>();
    if (!fund) throw new AppError(422, "no_fund", "Chưa cấu hình quỹ chờ đối soát COD (cod_clearing)");
    t = transitionStmts(db, id, o.status, "completed", staff(c), { note: "Giao hàng thành công", extraSet: "payment_status = ?3, paid_total = paid_total + ?4", extraBinds: ["paid", o.total] });
    stmts.push(t[0], db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?, 'cod', ?, ?, ?, 'confirmed')`).bind(id, o.total, fund.id, o.code), ...t.slice(1));
  } else {
    t = transitionStmts(db, id, o.status, "completed", staff(c), { note: "Giao hàng thành công" });
    stmts.push(...t);
  }
  stmts.push(notifyJob(db, id, { status: "completed" }), auditStmt(c, { action: "online_order.deliver", entity: "order", entityId: id, before: { status: o.status }, after: { status: "completed", total: o.total, cod: o.payment_method === "cod" } }));
  await runOrderBatch(db, id, o.status, stmts);
  await finish(c, id);
}

export async function failOrder(c: Ctx, id: number, reason: string) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  await runOrderBatch(db, id, o.status, [
    ...transitionStmts(db, id, o.status, "delivery_failed", staff(c), { note: "Giao hàng chưa thành công, cửa hàng sẽ liên hệ", internalNote: reason }),
    notifyJob(db, id, { status: "delivery_failed" }),
    auditStmt(c, { action: "online_order.fail", entity: "order", entityId: id, before: { status: o.status }, after: { status: "delivery_failed" }, reason }),
  ]);
  await finish(c, id);
}

export async function redeliverOrder(c: Ctx, id: number, input: { slotDate: string; slotId: number }) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  const slot = await db.prepare(`SELECT id, label FROM delivery_slots WHERE id=? AND active=1`).bind(input.slotId).first<{ id: number; label: string }>();
  if (!slot) throw new AppError(422, "slot_not_found", "Khung giờ giao không tồn tại");
  if (input.slotDate < vnDate()) throw new AppError(422, "slot_in_past", "Ngày giao lại không được ở quá khứ");
  await runOrderBatch(db, id, o.status, [
    ...transitionStmts(db, id, o.status, "confirmed", staff(c), {
      note: `Giao lại ngày ${input.slotDate}, khung ${slot.label}`,
      internalNote: "Giao lại: hàng vẫn ở shipper/kho, không xuất kho lần nữa",
      extraSet: "slot_date = ?3, slot_id = ?4",
      extraBinds: [input.slotDate, input.slotId],
    }),
    notifyJob(db, id, { status: "confirmed" }),
    auditStmt(c, { action: "online_order.redeliver", entity: "order", entityId: id, before: { status: o.status, slotDate: o.slot_date, slotId: o.slot_id }, after: { status: "confirmed", slotDate: input.slotDate, slotId: input.slotId } }),
  ]);
  await finish(c, id);
}

// ---------------------------------------------------------------- hoàn kho (return / cancel sau khi đã xuất)

/** Dòng order_line_lots của đơn theo từng dòng (đúng lô đã xuất). */
async function shippedLots(db: D1Database, orderId: number) {
  const rows = (
    await db
      .prepare(
        `SELECT oll.order_line_id, oll.lot_id, oll.qty_milli, oll.unit_cost, ol.product_id
           FROM order_line_lots oll JOIN order_lines ol ON ol.id = oll.order_line_id WHERE ol.order_id = ? ORDER BY oll.id`,
      )
      .bind(orderId)
      .all<any>()
  ).results;
  const m = new Map<number, { productId: number; lots: LotAllocation[] }>();
  for (const r of rows) {
    const e = m.get(r.order_line_id) ?? { productId: r.product_id, lots: [] as LotAllocation[] };
    e.lots.push({ lotId: r.lot_id, qtyMilli: r.qty_milli, unitCost: r.unit_cost });
    m.set(r.order_line_id, e);
  }
  return m;
}

/** Lấy lần lượt `restockMilli` rồi `wasteMilli` từ các lô đã xuất. */
function takeFromLots(lots: LotAllocation[], restockMilli: number, wasteMilli: number) {
  const restock: LotAllocation[] = [], waste: LotAllocation[] = [];
  const pool = lots.map((l) => ({ ...l }));
  const take = (need: number, out: LotAllocation[]) => {
    for (const p of pool) {
      if (need <= 0) break;
      const q = Math.min(p.qtyMilli, need);
      if (q <= 0) continue;
      out.push({ lotId: p.lotId, unitCost: p.unitCost, qtyMilli: q });
      p.qtyMilli -= q;
      need -= q;
    }
  };
  take(restockMilli, restock);
  take(wasteMilli, waste);
  return { restock, waste };
}

function restockStmts(db: D1Database, productId: number, restock: LotAllocation[], waste: LotAllocation[], refType: string, orderId: number, userId: number) {
  const s = moveStatements(db, productId, restock, 1, "return", refType, orderId, userId);
  for (const w of waste) {
    // Hàng trả về không còn bán được: ghi nhập rồi hao hụt cùng lô (tồn ròng không đổi) → P&L tính vào hao hụt (shrinkage)
    s.push(
      db.prepare(`INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id) VALUES (?,?,?,?, 'return', ?, ?, ?)`).bind(w.lotId, productId, w.qtyMilli, w.unitCost, refType, orderId, userId),
      db.prepare(`INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id) VALUES (?,?,?,?, 'waste', ?, ?, ?)`).bind(w.lotId, productId, -w.qtyMilli, w.unitCost, refType, orderId, userId),
    );
  }
  return s;
}

export async function returnToStock(
  c: Ctx,
  id: number,
  input: { lines: { orderLineId: number; qty: number; unit?: string; restock: boolean; reason: string }[] },
) {
  const db = c.env.DB;
  const user = c.get("user");
  const o = await loadOpsOrder(db, id);
  if (o.status !== "delivery_failed" && o.status !== "completed") throw conflict("invalid_transition", "Chỉ trả hàng cho đơn giao không thành công hoặc đã giao", { from: o.status });
  const lines = (await db.prepare(`SELECT * FROM order_lines WHERE order_id=? ORDER BY id`).bind(id).all<any>()).results;
  const lots = await shippedLots(db, id);
  if (!lots.size) throw conflict("not_shipped", "Đơn chưa xuất kho nên không có hàng để nhập lại");
  const req = new Map(input.lines.map((l) => [l.orderLineId, l]));
  for (const l of input.lines) if (!lines.some((x) => x.id === l.orderLineId)) throw new AppError(422, "line_not_found", "Dòng hàng không thuộc đơn này", { orderLineId: l.orderLineId });
  const stmts: D1PreparedStatement[] = [];
  const summary: unknown[] = [];
  for (const l of lines) {
    const sh = lots.get(l.id);
    if (!sh) continue;
    const r = req.get(l.id);
    let qty = l.qty_milli as number;
    if (r) {
      qty = toMilli(r.qty, await unitFactor(db, l.product_id, r.unit ?? l.unit));
      if (qty < 0 || qty > l.qty_milli) throw conflict("return_exceeds_sold", "Số lượng trả vượt số đã giao", { orderLineId: l.id, soldMilli: l.qty_milli });
    }
    const restockMilli = (r ? r.restock : true) ? qty : 0;
    const wasteMilli = l.qty_milli - restockMilli; // phần không trả về / không còn tươi = hao hụt
    const parts = takeFromLots(sh.lots, restockMilli, wasteMilli);
    stmts.push(...restockStmts(db, l.product_id, parts.restock, parts.waste, "order_return", id, user.id));
    summary.push({ orderLineId: l.id, restockMilli, wasteMilli, reason: r?.reason ?? null });
  }
  const refund = await refundPlan(db, id, o.total);
  const t = transitionStmts(db, id, o.status, "returned", staff(c), {
    note: "Đơn đã được trả hàng",
    internalNote: input.lines.map((l) => `${l.orderLineId}: ${l.reason}${l.restock ? "" : " (không nhập lại kho)"}`).join("; ").slice(0, 500) || undefined,
    extraSet: refund ? "payment_status = ?3, paid_total = paid_total - ?4" : undefined,
    extraBinds: refund ? [refund.status, refund.amount] : undefined,
  });
  stmts.unshift(t[0]);
  if (refund) stmts.push(refund.stmt);
  stmts.push(...t.slice(1), notifyJob(db, id, { status: "returned" }), auditStmt(c, { action: "online_order.return", entity: "order", entityId: id, before: { status: o.status }, after: { status: "returned", lines: summary, refund: refund?.amount ?? 0 } }));
  await runOrderBatch(db, id, o.status, stmts);
  await finish(c, id);
  return { refund: refund?.amount ?? 0 };
}

// ---------------------------------------------------------------- cancel (EC-06)

export async function cancelOrder(c: Ctx, id: number, reason: string) {
  const db = c.env.DB;
  const user = c.get("user");
  const o = await loadOpsOrder(db, id);
  const release = await releaseOrderStmts(db, id);
  const lots = await shippedLots(db, id); // đã xuất ở lần giao trước rồi giao lại → hàng về kho đúng lô
  const restock: D1PreparedStatement[] = [];
  for (const [lineId, sh] of lots) {
    const line = await db.prepare(`SELECT qty_milli FROM order_lines WHERE id=?`).bind(lineId).first<{ qty_milli: number }>();
    const p = takeFromLots(sh.lots, line!.qty_milli, 0);
    restock.push(...restockStmts(db, sh.productId, p.restock, [], "order_cancel", id, user.id));
  }
  const policy = (await db.prepare(`SELECT value FROM settings WHERE key='online.cancel_fee_policy'`).first<{ value: string }>())?.value ?? "shop";
  const keepFee = policy === "customer" && o.status === "preparing" ? o.shipping_fee : 0;
  const refund = await refundPlan(db, id, o.total, keepFee);
  const set = ["cancel_reason = ?3", "shipping_fee_policy = ?4"];
  const binds: unknown[] = [reason, keepFee ? "customer" : policy];
  if (refund) {
    set.push("payment_status = ?5", "paid_total = paid_total - ?6");
    binds.push(refund.status, refund.amount);
  }
  const t = transitionStmts(db, id, o.status, "cancelled", staff(c), { note: "Đơn đã được huỷ", internalNote: reason, extraSet: set.join(", "), extraBinds: binds });
  const stmts = [
    t[0],
    ...release,
    ...restock,
    db.prepare(`UPDATE payment_intents SET status='cancelled' WHERE order_id=? AND status='pending'`).bind(id),
    ...(refund ? [refund.stmt] : []),
    ...t.slice(1),
    notifyJob(db, id, { status: "cancelled" }),
    auditStmt(c, { action: "online_order.cancel", entity: "order", entityId: id, before: { status: o.status }, after: { status: "cancelled", refund: refund?.amount ?? 0, restocked: lots.size > 0 }, reason }),
  ];
  await runOrderBatch(db, id, o.status, stmts);
  await finish(c, id);
  return { refund: refund?.amount ?? 0 };
}

/** Hoàn tiền cho đơn đã huỷ/trả mà chưa hoàn (vd khách tự huỷ sau khi đã trả — shop worker không xử lý tiền). */
export async function refundOrder(c: Ctx, id: number) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  if (o.status !== "cancelled" && o.status !== "returned") throw conflict("not_refundable", "Chỉ hoàn tiền cho đơn đã huỷ hoặc đã trả hàng");
  const refund = await refundPlan(db, id, o.total);
  if (!refund) throw conflict("nothing_to_refund", "Đơn không còn khoản tiền cần hoàn");
  const [g1, g2] = guardStmts(db, id, o.status);
  await runOrderBatch(db, id, o.status, [
    g1,
    refund.stmt,
    db.prepare(`UPDATE orders SET payment_status=?, paid_total = paid_total - ? WHERE id=?`).bind(refund.status, refund.amount, id),
    g2,
    auditStmt(c, { action: "online_order.refund", entity: "order", entityId: id, after: { amount: refund.amount, status: refund.status } }),
  ]);
  return { refund: refund.amount };
}

// ---------------------------------------------------------------- tạo đơn mạng xã hội (M1-05)

export interface SocialOrderInput {
  clientUuid?: string;
  customerId?: number | null;
  receiverName: string;
  receiverPhone: string;
  addressLine: string;
  ward?: string | null;
  district: string;
  province?: string | null;
  items: { productId: number; unit: string; qty: number }[];
  slotDate?: string | null;
  slotId?: number | null;
  paymentMethod: "cod" | "transfer";
  note?: string | null;
  shippingFee?: number;
  acceptPreorder?: boolean;
}

export async function findZone(db: D1Database, district: string) {
  const d = normalizeVi(district);
  const zones = (await db.prepare(`SELECT * FROM delivery_zones WHERE active=1 ORDER BY id`).all<any>()).results;
  return zones.find((z) => (JSON.parse(z.districts_json) as string[]).some((x) => normalizeVi(x) === d)) ?? null;
}

export async function createSocialOrder(c: Ctx, b: SocialOrderInput): Promise<{ id: number; created: boolean }> {
  const db = c.env.DB;
  const user = c.get("user");
  if (b.clientUuid) {
    const ex = await db.prepare(`SELECT id, status FROM orders WHERE client_uuid=?`).bind(b.clientUuid).first<{ id: number; status: string }>();
    if (ex) {
      if (ex.status === "draft") throw conflict("order_in_progress", "Đơn đang được xử lý, vui lòng thử lại");
      return { id: ex.id, created: false };
    }
  }
  let group: number | null = null;
  if (b.customerId) {
    const cu = await db.prepare(`SELECT id, customer_group_id FROM customers WHERE id=? AND active=1`).bind(b.customerId).first<any>();
    if (!cu) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng");
    group = cu.customer_group_id;
  }
  const storeId = user.storeId ?? 1;
  type Item = { productId: number; unit: string; qtyMilli: number; unitPrice: number; priceListId: number; preorder: number; reserve: number; lineId?: number; name: string };
  const items: Item[] = [];
  for (const it of b.items) {
    const p = await db.prepare(`SELECT id, name, active, allow_preorder FROM products WHERE id=?`).bind(it.productId).first<any>();
    if (!p || !p.active) throw new AppError(422, "product_not_found", "Mặt hàng không tồn tại hoặc đã ngừng bán", { productId: it.productId });
    const factor = await unitFactor(db, it.productId, it.unit);
    const qtyMilli = toMilli(it.qty, factor);
    if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ");
    const price = await resolvePrice(db, it.productId, { channel: "online", customerGroupId: group, customerId: b.customerId ?? null });
    items.push({ productId: it.productId, unit: it.unit, qtyMilli, unitPrice: price.unitPrice, priceListId: price.priceListId, preorder: 0, reserve: qtyMilli, name: p.name });
  }
  // tồn: gộp theo sản phẩm; thiếu → đặt trước nếu được phép + khách chấp nhận
  const byProduct = new Map<number, Item[]>();
  for (const i of items) byProduct.set(i.productId, [...(byProduct.get(i.productId) ?? []), i]);
  for (const [pid, its] of byProduct) {
    let avail = await availableQty(db, pid, storeId);
    const need = its.reduce((s, x) => s + x.qtyMilli, 0);
    if (need <= avail) continue;
    const p = await db.prepare(`SELECT allow_preorder FROM products WHERE id=?`).bind(pid).first<{ allow_preorder: number }>();
    if (!(p?.allow_preorder && b.acceptPreorder)) throw conflict("insufficient_stock", "Không đủ tồn khả dụng", { productId: pid, availableMilli: avail });
    for (const x of its) {
      x.reserve = Math.min(x.qtyMilli, Math.max(0, avail));
      avail -= x.reserve;
      x.preorder = x.qtyMilli - x.reserve;
    }
  }
  const subtotal = items.reduce((s, i) => s + lineAmount(i.unitPrice, i.qtyMilli), 0);
  const zone = await findZone(db, b.district);
  let shippingFee = b.shippingFee ?? 0;
  if (b.shippingFee == null && zone) {
    if (subtotal < zone.min_order) throw new AppError(422, "min_order", "Chưa đạt giá trị đơn tối thiểu của khu vực", { minOrder: zone.min_order });
    shippingFee = zone.free_over != null && subtotal >= zone.free_over ? 0 : zone.fee;
  }
  if (b.slotDate && b.slotId) {
    const slot = await db.prepare(`SELECT capacity FROM delivery_slots WHERE id=? AND active=1`).bind(b.slotId).first<{ capacity: number }>();
    if (!slot) throw new AppError(422, "slot_not_found", "Khung giờ giao không tồn tại");
    const used = await db.prepare(`SELECT COUNT(*) n FROM orders WHERE slot_date=? AND slot_id=? AND status NOT IN ('cancelled','returned','draft')`).bind(b.slotDate, b.slotId).first<{ n: number }>();
    if ((used?.n ?? 0) >= slot.capacity) throw conflict("slot_full", "Khung giờ giao đã đầy");
  }
  const total = subtotal + shippingFee;
  const code = await nextCode(db, "DH");
  const token = newTrackingToken();
  const status: OnlineStatus = b.paymentMethod === "transfer" ? "awaiting_payment" : "new";
  const address = [b.addressLine, b.ward, b.district, b.province].filter(Boolean).join(", ");
  const isPre = items.some((i) => i.preorder > 0) ? 1 : 0;
  let orderId: number;
  try {
    const r = await db
      .prepare(
        `INSERT INTO orders(code, client_uuid, channel, kind, store_id, customer_id, status, is_preorder, subtotal, shipping_fee, total, note, created_by,
                            tracking_token, receiver_name, receiver_phone, ship_address, zone_id, slot_date, slot_id, payment_method, estimated_total)
         VALUES (?,?,'social','sale',?,?, 'draft', ?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)`,
      )
      .bind(code, b.clientUuid ?? null, storeId, b.customerId ?? null, isPre, subtotal, shippingFee, total, b.note ?? null, user.id,
        token, b.receiverName, b.receiverPhone, address, zone?.id ?? null, b.slotDate ?? null, b.slotId ?? null, b.paymentMethod, total)
      .run();
    orderId = r.meta.last_row_id as number;
  } catch (e) {
    if (b.clientUuid) {
      const again = await db.prepare(`SELECT id FROM orders WHERE client_uuid=?`).bind(b.clientUuid).first<{ id: number }>();
      if (again) return { id: again.id, created: false };
    }
    throw e;
  }
  const cancelDraft = () => db.prepare(`UPDATE orders SET status='cancelled' WHERE id=? AND status='draft'`).bind(orderId).run();
  try {
    for (const i of items) {
      const r = await db
        .prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, discount, line_total, ordered_qty_milli, preorder_milli) VALUES (?,?,?,?,?,?,0,?,?,?) RETURNING id`)
        .bind(orderId, i.productId, i.unit, i.qtyMilli, i.unitPrice, i.priceListId, lineAmount(i.unitPrice, i.qtyMilli), i.qtyMilli, i.preorder)
        .first<{ id: number }>();
      i.lineId = r!.id;
    }
    const commit = async () => {
      const toReserve = items.filter((i) => i.reserve > 0).map((i) => ({ orderLineId: i.lineId!, productId: i.productId, qtyMilli: i.reserve }));
      const plans = await planReservations(db, toReserve, storeId);
      const stmts: D1PreparedStatement[] = [
        ...reserveStmts(db, orderId, plans),
        db.prepare(`UPDATE orders SET status=? WHERE id=? AND status='draft'`).bind(status, orderId),
        db.prepare(`INSERT INTO order_events(order_id, status, note, actor_type, actor_id) VALUES (?,?,?, 'staff', ?)`).bind(orderId, status, "Đơn được tạo bởi cửa hàng (mạng xã hội)", user.id),
      ];
      if (status === "awaiting_payment") {
        const hold = Number((await db.prepare(`SELECT value FROM settings WHERE key='online.hold_minutes_transfer'`).first<{ value: string }>())?.value) || 30;
        stmts.push(
          db
            .prepare(`INSERT INTO payment_intents(order_id, provider, amount, transfer_content, expires_at) VALUES (?, 'vietqr', ?, ?, ?)`)
            .bind(orderId, total, `HM ${code.replaceAll("-", "")}`, new Date(Date.now() + hold * 60_000).toISOString()),
        );
      }
      stmts.push(
        enqueueJobStmt(db, "notify.staff_new_order", "order", orderId, {}),
        auditStmt(c, { action: "online_order.create_social", entity: "order", entityId: orderId, after: { code, total, lines: items.length, paymentMethod: b.paymentMethod, preorder: !!isPre } }),
      );
      await db.batch(stmts);
    };
    try {
      await commit();
    } catch (e) {
      if (!/CHECK constraint failed/i.test(String((e as Error)?.message))) throw e;
      await commit(); // tồn vừa đổi: tính lại một lần
    }
  } catch (e) {
    await cancelDraft();
    if (/CHECK constraint failed/i.test(String((e as Error)?.message))) throw conflict("insufficient_stock", "Không đủ tồn khả dụng (tồn vừa thay đổi), vui lòng thử lại");
    throw e;
  }
  await kickJobs(c.env, "order", orderId);
  return { id: orderId, created: true };
}

export const canCost = (c: Ctx) => can(c.get("user").role, "prices.view_cost");
export { CUSTOMER_LABEL };
