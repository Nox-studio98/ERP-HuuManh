import type { Context } from "hono";
import type { AppBindings } from "../env";
import { auditStmt } from "../lib/audit";
import { AppError, conflict, notFound } from "../lib/errors";
import { PREFIX } from "../lib/codes";
import { can } from "../lib/rbac";
import { lineAmount, toMilli } from "../lib/money";
import { vnDate } from "../lib/time";
import { allocateFefo, allocationCost, availableQty, moveStatements, type LotAllocation } from "./stock";
import { resolvePrice } from "./pricing";
import { nextCode, nextOnlineCode } from "../lib/codes";
import { consumeForDeliveryStmts, planReservations, releaseOrderStmts, reserveStmts } from "./reservations";
import { enqueueJobStmt, kickJobs } from "./outbox";
import { CUSTOMER_LABEL, newTrackingToken, normalizeVi, transitionStmts, type OnlineStatus } from "./online-orders";
import { assertStmt } from "./guard";
import { guardStmts, notifyJob, paidNet, refundObligation, refundPlan, runOrderBatch } from "./online-payments";
import { assertPeriodOpen } from "./period";
import { unitFactor } from "./http";
import { repriceAfterPack } from "./pack-reprice";
import { slotCapacityGuard, slotRuleProblem, slotUsed } from "./slots";
import { earnFor, pointsStmts, reversalStatements } from "./loyalty-points";
import { allowShortConfirm, closeOrderShortagesStmt, planPartialReservations, shortageUpsertStmts, type ShortLine } from "./shortages";

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
  const pre = (await db.prepare(`SELECT id, product_id, preorder_milli FROM order_lines WHERE order_id=? AND preorder_milli > 0`).bind(id).all<any>()).results;
  // PO tự động (docs/PO-NCC.md 4.1): chỉ đơn ĐẶT TRƯỚC giao NGÀY SAU được chờ hàng (giữ phần có tồn, ghi phần thiếu); đơn giao trong ngày vẫn chặn như cũ
  const canWait = pre.length > 0 && !!o.slot_date && o.slot_date > vnDate() && (await allowShortConfirm(db));
  for (let attempt = 0; ; attempt++) {
    const stmts: D1PreparedStatement[] = [];
    const t = transitionStmts(db, id, o.status, "confirmed", staff(c), { note: "Đơn đã được xác nhận" });
    let short: ShortLine[] = [];
    if (pre.length) {
      // M8-08: đặt trước chỉ xác nhận khi đủ hàng cho phần chờ → giữ tồn phần đó (thiếu: chờ hàng về nếu được phép)
      let plans;
      const lines = pre.map((l) => ({ orderLineId: l.id, productId: l.product_id, qtyMilli: l.preorder_milli }));
      if (canWait) ({ plans, short } = await planPartialReservations(db, lines, o.store_id));
      else {
        try {
          plans = await planReservations(db, lines, o.store_id);
        } catch (e) {
          if (e instanceof AppError && e.code === "insufficient_stock") throw conflict("preorder_not_ready", "Hàng đặt trước chưa về đủ, chưa thể xác nhận", e.details);
          throw e;
        }
      }
      stmts.push(
        t[0], ...reserveStmts(db, id, plans), ...shortageUpsertStmts(db, id, o.slot_date ?? null, short),
        db.prepare(`UPDATE order_lines SET preorder_milli = 0 WHERE order_id = ? AND preorder_milli > 0`).bind(id), ...t.slice(1),
      );
    } else stmts.push(...t);
    stmts.push(
      notifyJob(db, id, { status: "confirmed" }),
      auditStmt(c, {
        action: "online_order.confirm", entity: "order", entityId: id, before: { status: o.status },
        after: { status: "confirmed", preorderFulfilled: pre.length > 0, ...(short.length ? { shortages: short.map((x) => ({ productId: x.productId, missingMilli: x.missingMilli })) } : {}) },
      }),
    );
    try {
      await runOrderBatch(db, id, o.status, stmts);
      break;
    } catch (e) {
      if (canWait && attempt === 0 && e instanceof AppError && e.code === "insufficient_stock") continue; // tồn vừa đổi: tính lại một lần (EC-02)
      throw e;
    }
  }
  await finish(c, id);
}

/** PO: đơn còn phần chờ hàng về thì chưa soạn / giao được (không hứa giao hàng chưa có). */
export async function assertNotAwaitingStock(db: D1Database, orderId: number) {
  const r = await db.prepare(`SELECT COALESCE(SUM(qty_milli),0) AS q FROM so_shortages WHERE order_id = ? AND status = 'open'`).bind(orderId).first<{ q: number }>();
  if ((r?.q ?? 0) > 0) throw conflict("awaiting_stock", "Đơn còn phần chờ hàng về (chưa đủ hàng), chưa thể soạn / giao", { awaitingMilli: r!.q });
}

export async function prepareOrder(c: Ctx, id: number) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  await assertNotAwaitingStock(db, id);
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
  const priced = lines.map((l) => {
    const qty = actual.get(l.id) ?? l.qty_milli;
    const gross = lineAmount(l.unit_price, qty);
    baseline += lineAmount(l.unit_price, l.ordered_qty_milli ?? l.qty_milli);
    subtotal += gross;
    return { l, qty, gross };
  });
  // A-19: tính lại khuyến mãi %/voucher + ngưỡng miễn phí giao theo tiền hàng thực (A-08: giảm giá ghi theo dòng)
  const rp = await repriceAfterPack(db, o, priced.map((x) => ({ id: x.l.id, productId: x.l.product_id, qtyMilli: x.qty, unitPrice: x.l.unit_price, gross: x.gross })), subtotal);
  for (const x of priced) {
    const disc = rp.info.promoRecalc ? rp.lineDiscounts.get(x.l.id) ?? 0 : x.l.discount;
    stmts.push(
      db.prepare(`UPDATE order_lines SET qty_milli=?, discount=?, line_total=?, ordered_qty_milli=COALESCE(ordered_qty_milli, ?) WHERE id=?`).bind(x.qty, disc, Math.max(0, x.gross - disc), x.l.qty_milli, x.l.id),
    );
  }
  stmts.push(...rp.stmts);
  const total = Math.max(0, subtotal - rp.discount) + rp.shippingFee;
  const devBp = baseline > 0 ? Math.round((Math.abs(subtotal - baseline) * 10000) / baseline) : 0;
  const weightStatus = devBp <= (Number.isFinite(tolBp) ? tolBp : 1000) ? "auto_accepted" : "pending_customer";
  const pending = weightStatus === "pending_customer";
  // A-02 (EC-03/EC-05): đơn TRẢ TRƯỚC đã thu đủ theo tổng ước tính → lưu chênh lệch so với tiền đã nhận.
  //  dương: thu thêm khi giao (COD phần chênh); âm: phải hoàn lại khách; deliver bị chặn tới khi hoàn xong hoặc được miễn có người duyệt.
  const prepaidPaid = (o.payment_method === "transfer" || o.payment_method === "gateway") && o.payment_status === "paid";
  const diff = prepaidPaid ? total - (o.paid_total ?? 0) : 0;
  stmts.push(
    db
      .prepare(`UPDATE orders SET subtotal=?, discount=?, shipping_fee=?, total=?, weight_adjust_status=?, diff_amount=?, diff_status=?, diff_note=NULL, diff_waived_by=NULL WHERE id=? AND status='preparing'`)
      .bind(subtotal, rp.discount, rp.shippingFee, total, weightStatus, diff, diff !== 0 ? "pending" : "none", id),
    db
      .prepare(`INSERT INTO order_events(order_id, status, note, internal_note, actor_type, actor_id) VALUES (?,?,?,?, 'staff', ?)`)
      .bind(id, "preparing", pending ? "Khối lượng thực tế chênh lệch, vui lòng xác nhận lại" : "Đã cân hàng, tổng tiền được cập nhật", input.note ?? null, c.get("user").id),
    g2,
    notifyJob(db, id, { status: "preparing", ...(pending ? { event: "weight_pending" } : {}) }),
    auditStmt(c, {
      action: "online_order.pack", entity: "order", entityId: id,
      before: { subtotal: o.subtotal, total: o.total, discount: o.discount, shippingFee: o.shipping_fee, weightAdjustStatus: o.weight_adjust_status },
      after: { subtotal, total, discount: rp.discount, shippingFee: rp.shippingFee, voucherDropped: rp.info.voucherDropped, baseline, deviationBp: devBp, toleranceBp: tolBp, weightAdjustStatus: weightStatus, paidTotal: o.paid_total, diff },
    }),
  );
  await runOrderBatch(db, id, "preparing", stmts);
  await finish(c, id);
  return { weightAdjustStatus: weightStatus, deviationBp: devBp, baseline, subtotal, total, diffAmount: diff };
}

/**
 * A-20: khách không phản hồi trên web nhưng đã đồng ý lệch cân qua điện thoại → nhân viên ghi nhận thay (bắt buộc lý do, lưu người ghi, audit).
 * Chỉ khi đơn đang chuẩn bị và chờ khách xác nhận khối lượng; kết quả giống khách bấm đồng ý (`accepted`).
 */
export async function overrideWeight(c: Ctx, id: number, reason: string) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  if (o.status !== "preparing") throw conflict("invalid_transition", "Chỉ ghi nhận khi đơn đang chuẩn bị", { from: o.status });
  if (o.weight_adjust_status !== "pending_customer") throw conflict("no_pending_decision", "Đơn không có yêu cầu xác nhận khối lượng");
  const uid = c.get("user").id;
  const [g1, g2] = guardStmts(db, id, "preparing");
  await runOrderBatch(db, id, "preparing", [
    g1,
    assertStmt(db, "order.weight_override", `SELECT weight_adjust_status = 'pending_customer' FROM orders WHERE id = ?`, [id]),
    db.prepare(`UPDATE orders SET weight_adjust_status='accepted', weight_override_by=?, weight_override_reason=? WHERE id=? AND weight_adjust_status='pending_customer'`).bind(uid, reason, id),
    db.prepare(`INSERT INTO order_events(order_id, status, note, internal_note, actor_type, actor_id) VALUES (?,?,?,?, 'staff', ?)`).bind(id, "preparing", "Khách đồng ý giá theo khối lượng thực tế (qua điện thoại)", `Nhân viên ghi nhận thay khách: ${reason}`, uid),
    g2,
    auditStmt(c, { action: "online_order.weight_override", entity: "order", entityId: id, before: { weightAdjustStatus: "pending_customer" }, after: { weightAdjustStatus: "accepted", total: o.total }, reason }),
  ]);
  return { weightAdjustStatus: "accepted" };
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

export async function shipOrder(c: Ctx, id: number, input: { carrier?: string; trackingNo?: string; extra?: D1PreparedStatement[] }) {
  const db = c.env.DB;
  const user = c.get("user");
  const o = await loadOpsOrder(db, id);
  if (o.status !== "preparing") throw conflict("invalid_transition", "Chỉ giao khi đơn đang chuẩn bị", { from: o.status });
  await assertNotAwaitingStock(db, id);
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
    ...(input.extra ?? []), // vd. giao hàng tại quầy: ghi tiền trả trước vào két ca cùng batch với bước chuyển "Đang giao"
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
  const prepaid = o.payment_method === "transfer" || o.payment_method === "gateway";
  if (prepaid && o.diff_status === "pending" && o.diff_amount < 0) {
    // A-02: khách đã trả dư do cân nhẹ hơn → phải hoàn (hoặc người có quyền duyệt miễn) trước khi hoàn tất
    throw conflict("diff_unsettled", `Cần hoàn lại ${-o.diff_amount}đ cho khách (hoặc miễn có người duyệt) trước khi hoàn tất đơn`, { diffAmount: o.diff_amount });
  }
  if (prepaid && o.diff_status === "pending" && o.diff_amount > 0) {
    // A-02: thu phần chênh khi giao như COD (quỹ chờ đối soát COD), cùng đường đi với COD thường
    const fund = await db.prepare(`SELECT id FROM funds WHERE type='cod_clearing' AND active=1 ORDER BY id LIMIT 1`).first<{ id: number }>();
    if (!fund) throw new AppError(422, "no_fund", "Chưa cấu hình quỹ chờ đối soát COD (cod_clearing)");
    t = transitionStmts(db, id, o.status, "completed", staff(c), { note: `Giao hàng thành công, thu thêm ${o.diff_amount}đ (chênh lệch cân)`, extraSet: "paid_total = paid_total + ?3, diff_status = 'settled'", extraBinds: [o.diff_amount] });
    stmts.push(
      assertStmt(db, "order.diff_collect", `SELECT diff_status = 'pending' AND diff_amount = ? FROM orders WHERE id = ?`, [o.diff_amount, id]),
      t[0],
      db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?, 'cod', ?, ?, ?, 'confirmed')`).bind(id, o.diff_amount, fund.id, `${o.code}-CHENH`),
      ...t.slice(1),
    );
  } else if (o.payment_method === "cod" && o.payment_status !== "paid") {
    const fund = await db.prepare(`SELECT id FROM funds WHERE type='cod_clearing' AND active=1 ORDER BY id LIMIT 1`).first<{ id: number }>();
    if (!fund) throw new AppError(422, "no_fund", "Chưa cấu hình quỹ chờ đối soát COD (cod_clearing)");
    t = transitionStmts(db, id, o.status, "completed", staff(c), { note: "Giao hàng thành công", extraSet: "payment_status = ?3, paid_total = paid_total + ?4", extraBinds: ["paid", o.total - (o.paid_total ?? 0)] });
    // Đơn giao từ quầy (B3) đã trả trước một phần: COD chỉ thu phần còn lại (đơn COD thường paid_total = 0 nên không đổi)
    stmts.push(t[0], db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?, 'cod', ?, ?, ?, 'confirmed')`).bind(id, o.total - (o.paid_total ?? 0), fund.id, o.code), ...t.slice(1));
  } else {
    t = transitionStmts(db, id, o.status, "completed", staff(c), { note: "Giao hàng thành công" });
    if (prepaid) stmts.push(assertStmt(db, "order.diff_none", `SELECT diff_status <> 'pending' FROM orders WHERE id = ?`, [id]));
    stmts.push(...t);
  }
  // Tích điểm khi đơn website hoàn tất: theo số tiền khách thực trả, không tính phí giao (cùng luật với POS)
  if (o.shop_account_id && o.customer_id) {
    const earn = await earnFor(db, Math.max(0, o.total - (o.shipping_fee ?? 0)), o.customer_id);
    stmts.push(...pointsStmts(db, { sql: "?", bind: id }, o.customer_id, "earn", earn, "Tích điểm đơn hàng online", c.get("user").id));
  }
  stmts.push(notifyJob(db, id, { status: "completed" }), auditStmt(c, { action: "online_order.deliver", entity: "order", entityId: id, before: { status: o.status }, after: { status: "completed", total: o.total, cod: o.payment_method === "cod", diffCollected: prepaid && o.diff_status === "pending" ? o.diff_amount : 0, diffStatus: o.diff_status } }));
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
  const slot = await db.prepare(`SELECT id, label, start_time, cutoff_minutes, weekdays, capacity FROM delivery_slots WHERE id=? AND active=1`).bind(input.slotId).first<any>();
  if (!slot) throw new AppError(422, "slot_not_found", "Khung giờ giao không tồn tại");
  if (input.slotDate < vnDate()) throw new AppError(422, "slot_in_past", "Ngày giao lại không được ở quá khứ");
  // A-18: giao lại phải qua cùng kiểm tra như đặt mới — khung có giao hôm đó, chưa quá giờ chốt, còn sức chứa (bỏ qua chính đơn này)
  const rule = slotRuleProblem(slot, input.slotDate);
  if (rule === "closed") throw new AppError(422, "slot_closed", "Khung giờ không giao vào ngày này");
  if (rule === "cutoff" || rule === "past") throw conflict("slot_cutoff", "Đã quá giờ chốt của khung giờ này");
  if ((await slotUsed(db, input.slotDate, input.slotId, id)) >= slot.capacity) throw conflict("slot_full", "Khung giờ giao đã đầy");
  await runOrderBatch(db, id, o.status, [
    slotCapacityGuard(db, "redeliver.slot_capacity", input.slotDate, input.slotId, slot.capacity, id),
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
  // B-08/EC-33: trả hàng ghi vào NGÀY HÔM NAY — hôm nay thuộc kỳ khoá thì chặn
  await assertPeriodOpen(db, new Date(), "phiếu trả hàng");
  if (o.status === "completed") return returnAfterDelivery(c, o, input);
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
  // Giao không thành công: chưa từng ghi nhận doanh thu → vẫn chuyển đơn gốc sang 'returned' (không có phiếu trả)
  // A-14: chỉ ghi nghĩa vụ hoàn tiền; kế toán (finance.write) hoàn thực tế qua /refund
  // A-28: giao thất bại → phí giao do bên chịu theo `online.cancel_fee_shipping` (mặc định khách chịu): giữ lại, chỉ hoàn phần còn lại
  const feePolicy = await cancelFeePolicy(db, o.status);
  const keepFee = feePolicy === "customer" ? o.shipping_fee ?? 0 : 0;
  const due = await refundObligation(db, id, (o.refund_due ?? 0) + keepFee);
  const t = transitionStmts(db, id, o.status, "returned", staff(c), {
    note: "Đơn đã được trả hàng",
    internalNote: input.lines.map((l) => `${l.orderLineId}: ${l.reason}${l.restock ? "" : " (không nhập lại kho)"}`).join("; ").slice(0, 500) || undefined,
    extraSet: "refund_due = refund_due + ?3, shipping_fee_policy = ?4, diff_status = 'none', diff_amount = 0",
    extraBinds: [due, feePolicy],
  });
  stmts.unshift(t[0]);
  stmts.push(...t.slice(1), notifyJob(db, id, { status: "returned" }), auditStmt(c, { action: "online_order.return", entity: "order", entityId: id, before: { status: o.status }, after: { status: "returned", lines: summary, refundDue: due, shippingFeeKept: keepFee } }));
  await runOrderBatch(db, id, o.status, stmts);
  await finish(c, id);
  return { refund: 0, refundDue: due };
}

/**
 * A-05 (EC-01/EC-33): trả hàng SAU KHI GIAO → lập phiếu trả `orders.kind='return'` (original_order_id, ngày hôm nay, cùng cách POS/B2B biểu diễn)
 * thay vì sửa đơn gốc: đơn gốc vẫn 'completed' nên doanh thu/giá vốn ngày đã giao giữ nguyên; báo cáo trừ doanh thu ở NGÀY TRẢ (returnsTotal).
 * Hỗ trợ trả một phần/nhiều lần. `lines` rỗng = trả toàn bộ phần còn lại (nhập lại kho). Trả hết mọi dòng → phiếu trả gồm cả phí giao hàng.
 * Hoàn tiền: trừ vào số đã thu của đơn gốc (dòng payments âm cùng phương thức/quỹ). Điểm tích/đổi và lượt voucher đảo đúng một lần theo luỹ kế
 * (reversalStatements idempotent theo sổ điểm) — đơn gốc không đổi trạng thái nên trigger 0011 không chạy.
 */
async function returnAfterDelivery(
  c: Ctx,
  o: any,
  input: { lines: { orderLineId: number; qty: number; unit?: string; restock: boolean; reason: string }[] },
) {
  const db = c.env.DB;
  const user = c.get("user");
  const id: number = o.id;
  const lines = (await db.prepare(`SELECT * FROM order_lines WHERE order_id=? ORDER BY id`).bind(id).all<any>()).results;
  const lotsByLine = new Map<number, LotAllocation[]>();
  for (const r of (await db.prepare(`SELECT oll.order_line_id, oll.lot_id, oll.qty_milli, oll.unit_cost FROM order_line_lots oll JOIN order_lines ol ON ol.id = oll.order_line_id WHERE ol.order_id = ? ORDER BY oll.id`).bind(id).all<any>()).results) {
    lotsByLine.set(r.order_line_id, [...(lotsByLine.get(r.order_line_id) ?? []), { lotId: r.lot_id, qtyMilli: r.qty_milli, unitCost: r.unit_cost }]);
  }
  if (!lotsByLine.size) throw conflict("not_shipped", "Đơn chưa xuất kho nên không có hàng để nhập lại");
  const prevRows = (
    await db
      .prepare(
        `SELECT r.original_line_id AS lid, COALESCE(SUM(r.qty_milli),0) AS q, COALESCE(SUM(r.line_total),0) AS amt
           FROM order_lines r JOIN orders ro ON ro.id = r.order_id
          WHERE ro.original_order_id = ? AND ro.kind = 'return' AND ro.status = 'completed' GROUP BY r.original_line_id`,
      )
      .bind(id)
      .all<any>()
  ).results;
  const prev = new Map<number, { q: number; amt: number }>(prevRows.map((r) => [r.lid, { q: r.q, amt: r.amt }]));
  const priorTotal = (await db.prepare(`SELECT COALESCE(SUM(total),0) AS t FROM orders WHERE original_order_id = ? AND kind='return' AND status='completed'`).bind(id).first<{ t: number }>())?.t ?? 0;

  // Phân bổ tiền hàng thực thu (đã trừ giảm giá đơn) cho từng dòng; dòng cuối nhận phần làm tròn dư
  const itemsNet = Math.max(0, o.total - (o.shipping_fee ?? 0));
  const sumLines = lines.reduce((s, l) => s + l.line_total, 0);
  const net = new Map<number, number>();
  let acc = 0;
  lines.forEach((l, i) => {
    const v = i === lines.length - 1 ? itemsNet - acc : sumLines > 0 ? Math.round((l.line_total * itemsNet) / sumLines) : 0;
    net.set(l.id, Math.max(0, v));
    acc += v;
  });

  const want = new Map<number, { qty: number; restock: boolean; reason: string }>();
  if (input.lines.length === 0) {
    for (const l of lines) {
      const left = l.qty_milli - (prev.get(l.id)?.q ?? 0);
      if (left > 0 && lotsByLine.has(l.id)) want.set(l.id, { qty: left, restock: true, reason: "Trả toàn bộ đơn" });
    }
  } else {
    for (const r of input.lines) {
      const l = lines.find((x) => x.id === r.orderLineId);
      if (!l) throw new AppError(422, "line_not_found", "Dòng hàng không thuộc đơn này", { orderLineId: r.orderLineId });
      if (want.has(l.id)) throw new AppError(422, "validation_error", "Dòng hàng bị lặp", { orderLineId: l.id });
      const q = toMilli(r.qty, await unitFactor(db, l.product_id, r.unit ?? l.unit));
      if (q <= 0) continue;
      want.set(l.id, { qty: q, restock: r.restock, reason: r.reason });
    }
  }
  if (!want.size) throw conflict("nothing_to_return", "Không còn số lượng nào để trả");

  const prepared: { l: any; qtyMilli: number; lineTotal: number; cost: number; alloc: LotAllocation[]; restock: boolean; reason: string }[] = [];
  for (const [lid, w] of want) {
    const l = lines.find((x) => x.id === lid)!;
    const already = prev.get(lid)?.q ?? 0;
    if (already + w.qty > l.qty_milli) throw conflict("return_exceeds_sold", "Số lượng trả vượt số đã giao trừ số đã trả", { orderLineId: lid, soldMilli: l.qty_milli, returnedMilli: already });
    // đi qua các lô đã xuất theo thứ tự, bỏ qua phần đã trả trước đó (cùng cách POS)
    let skip = already, need = w.qty;
    const alloc: LotAllocation[] = [];
    for (const lot of lotsByLine.get(lid) ?? []) {
      let avail = lot.qtyMilli;
      if (skip > 0) { const x = Math.min(skip, avail); skip -= x; avail -= x; }
      if (avail <= 0 || need <= 0) continue;
      const take = Math.min(avail, need);
      alloc.push({ lotId: lot.lotId, qtyMilli: take, unitCost: lot.unitCost });
      need -= take;
    }
    const isLast = already + w.qty === l.qty_milli;
    const base = net.get(lid) ?? 0;
    const lineTotal = isLast ? base - (prev.get(lid)?.amt ?? 0) : Math.round((base * w.qty) / l.qty_milli);
    prepared.push({ l, qtyMilli: w.qty, lineTotal: Math.max(0, lineTotal), cost: allocationCost(alloc), alloc, restock: w.restock, reason: w.reason });
  }
  // Trả hết mọi dòng (luỹ kế) → phiếu cuối gồm cả phí giao hàng để luỹ kế = tổng đơn
  const fullyReturned = lines.every((l) => (prev.get(l.id)?.q ?? 0) + (want.get(l.id)?.qty ?? 0) >= l.qty_milli);
  const shippingBack = fullyReturned ? Math.max(0, o.total - priorTotal - prepared.reduce((s, x) => s + x.lineTotal, 0)) : 0;
  const total = prepared.reduce((s, x) => s + x.lineTotal, 0) + shippingBack;
  const costTotal = prepared.reduce((s, x) => s + x.cost, 0);
  const refundDue = await refundObligation(db, id, o.refund_due ?? 0, total); // A-14: nghĩa vụ hoàn, chưa ghi quỹ
  const code = await nextCode(db, PREFIX.return);
  const note = prepared.map((x) => `${x.l.id}: ${x.reason}${x.restock ? "" : " (không nhập lại kho)"}`).join("; ").slice(0, 500);
  const r = await db
    .prepare(`INSERT INTO orders(code, channel, kind, original_order_id, store_id, customer_id, status, note, created_by) VALUES (?,?,'return',?,?,?,'draft',?,?)`)
    .bind(code, o.channel, id, o.store_id, o.customer_id, note, user.id)
    .run();
  const retId = r.meta.last_row_id as number;
  try {
    const lineIds: number[] = [];
    for (const x of prepared) {
      const row = await db
        .prepare(
          `INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, discount, line_total, cost_amount, original_line_id)
           VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        )
        .bind(retId, x.l.product_id, x.l.unit, x.qtyMilli, x.l.unit_price, x.l.price_list_id, Math.max(0, lineAmount(x.l.unit_price, x.qtyMilli) - x.lineTotal), x.lineTotal, x.cost, x.l.id)
        .first<{ id: number }>();
      lineIds.push(row!.id);
    }
    const stmts: D1PreparedStatement[] = [
      // Chốt chặn đồng thời: đơn gốc còn 'completed'; tổng số trả không vượt số đã giao; tổng tiền trả không vượt tổng đơn
      assertStmt(db, "online.return.status", `SELECT status = 'completed' AND kind = 'sale' FROM orders WHERE id = ?`, [id]),
      ...prepared.map((x) =>
        assertStmt(
          db,
          "online.return.qty",
          `SELECT (SELECT qty_milli FROM order_lines WHERE id = ?)
                  - COALESCE((SELECT SUM(r.qty_milli) FROM order_lines r WHERE r.original_line_id = ? AND r.order_id IN (SELECT id FROM orders WHERE kind = 'return' AND status = 'completed')), 0) >= ?`,
          [x.l.id, x.l.id, x.qtyMilli],
        ),
      ),
      assertStmt(db, "online.return.amount", `SELECT (SELECT total FROM orders WHERE id = ?) - COALESCE((SELECT SUM(total) FROM orders WHERE original_order_id = ? AND kind = 'return' AND status = 'completed'), 0) >= ?`, [id, id, total]),
    ];
    // Điểm tích / điểm đã đổi / lượt voucher: đảo theo luỹ kế tiền đã trả (chỉ đơn có khách; idempotent theo sổ)
    stmts.push(...(await reversalStatements(db, o, priorTotal + total, user.id, `trả hàng ${code}`)));
    prepared.forEach((x, i) => {
      if (!x.restock) return;
      for (const a of x.alloc) stmts.push(db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(lineIds[i], a.lotId, a.qtyMilli, a.unitCost));
      stmts.push(...moveStatements(db, x.l.product_id, x.alloc, 1, "return", "order", retId, user.id));
    });
    if (refundDue > 0) {
      stmts.push(
        assertStmt(db, "online.return.due", `SELECT COALESCE((SELECT SUM(amount) FROM payments WHERE order_id = ? AND status = 'confirmed'), 0) - (SELECT refund_due FROM orders WHERE id = ?) >= ?`, [id, id, refundDue]),
        db.prepare(`UPDATE orders SET refund_due = refund_due + ? WHERE id = ?`).bind(refundDue, id),
      );
    }
    stmts.push(
      db
        .prepare(`UPDATE orders SET status='completed', subtotal=?, total=?, cost_total=?, paid_total=0, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'`)
        .bind(total - shippingBack, total, costTotal, retId),
      notifyJob(db, id, { status: "returned" }),
      auditStmt(c, {
        action: "online_order.return", entity: "order", entityId: id,
        before: { status: o.status },
        after: { status: o.status, returnOrder: code, returnTotal: total, fullyReturned, refundDue, lines: prepared.map((x) => ({ orderLineId: x.l.id, qtyMilli: x.qtyMilli, restock: x.restock, reason: x.reason })) },
        reason: note,
      }),
    );
    await db.batch(stmts);
  } catch (e) {
    await db.prepare(`UPDATE orders SET status='cancelled' WHERE id=? AND status='draft'`).bind(retId).run();
    throw e;
  }
  await finish(c, id);
  return { refund: 0, refundDue, returnOrder: code, returnTotal: total, fullyReturned };
}

// ---------------------------------------------------------------- chênh lệch cân đơn trả trước (A-02)

/** Hoàn phần khách trả dư do cân nhẹ hơn ước tính: dòng payments âm cùng phương thức/quỹ gốc; xong thì đơn được giao/hoàn tất. */
export async function refundDiff(c: Ctx, id: number) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  if (o.diff_status !== "pending" || o.diff_amount >= 0) throw conflict("nothing_to_refund", "Đơn không có khoản chênh lệch cần hoàn lại");
  if (!["preparing", "shipping", "delivery_failed"].includes(o.status)) throw conflict("invalid_transition", "Chỉ hoàn chênh lệch khi đơn đang chuẩn bị/giao", { from: o.status });
  await assertPeriodOpen(db, new Date(), "hoàn tiền chênh lệch");
  const amount = -o.diff_amount;
  const p = await paidNet(db, id);
  if (p.net < amount) throw conflict("nothing_to_refund", "Số đã thu của đơn không đủ để hoàn", { paid: p.net, amount });
  await runOrderBatch(db, id, o.status, [
    assertStmt(db, "order.diff_refund", `SELECT diff_status = 'pending' AND diff_amount = ? AND status = ? FROM orders WHERE id = ?`, [o.diff_amount, o.status, id]),
    assertStmt(db, "order.refund", `SELECT COALESCE(SUM(amount), 0) >= ? FROM payments WHERE order_id = ? AND status = 'confirmed'`, [amount, id]),
    db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`).bind(id, p.method, -amount, p.fundId, "refund_diff"),
    db.prepare(`UPDATE orders SET paid_total = paid_total - ?, diff_status = 'settled', diff_note = ? WHERE id = ?`).bind(amount, `Đã hoàn ${amount}đ chênh lệch cân`, id),
    db.prepare(`INSERT INTO order_events(order_id, status, note, actor_type, actor_id) VALUES (?,?,?, 'staff', ?)`).bind(id, o.status, `Đã hoàn ${amount}đ chênh lệch khối lượng`, c.get("user").id),
    auditStmt(c, { action: "online_order.diff_refund", entity: "order", entityId: id, before: { diffAmount: o.diff_amount, diffStatus: "pending" }, after: { diffStatus: "settled", refunded: amount } }),
  ]);
  return { refund: amount };
}

/** Miễn khoản chênh lệch (thu thêm / hoàn lại) — chỉ người có quyền duyệt; bắt buộc lý do, ghi audit. */
export async function waiveDiff(c: Ctx, id: number, reason: string) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  if (o.diff_status !== "pending") throw conflict("nothing_to_waive", "Đơn không có khoản chênh lệch chờ xử lý");
  if (!["preparing", "shipping", "delivery_failed"].includes(o.status)) throw conflict("invalid_transition", "Chỉ miễn chênh lệch khi đơn đang chuẩn bị/giao", { from: o.status });
  await runOrderBatch(db, id, o.status, [
    assertStmt(db, "order.diff_waive", `SELECT diff_status = 'pending' AND status = ? FROM orders WHERE id = ?`, [o.status, id]),
    db.prepare(`UPDATE orders SET diff_status = 'waived', diff_waived_by = ?, diff_note = ? WHERE id = ?`).bind(c.get("user").id, reason, id),
    db.prepare(`INSERT INTO order_events(order_id, status, note, internal_note, actor_type, actor_id) VALUES (?,?,?,?, 'staff', ?)`).bind(id, o.status, "Cửa hàng miễn khoản chênh lệch cân", reason, c.get("user").id),
    auditStmt(c, { action: "online_order.diff_waive", entity: "order", entityId: id, before: { diffAmount: o.diff_amount, diffStatus: "pending" }, after: { diffStatus: "waived" }, reason }),
  ]);
  return { waived: o.diff_amount };
}

/**
 * A-28 (chủ đã chốt): ai chịu phí giao khi huỷ/trả đơn online, theo giai đoạn. Mặc định:
 * chưa soạn (awaiting_payment/new/confirmed) → cửa hàng chịu (hoàn đủ); đã soạn/đóng gói (preparing) → khách chịu;
 * giao thất bại (delivery_failed, đơn đang giao chỉ thành huỷ/trả qua bước này) → khách chịu.
 * Tham số: online.cancel_fee_before_prepare / online.cancel_fee_preparing / online.cancel_fee_shipping ('shop' | 'customer').
 * `online.cancel_fee_policy` (cũ) không còn dùng.
 */
export async function cancelFeePolicy(db: D1Database, status: string): Promise<"shop" | "customer"> {
  const key = status === "preparing" ? "online.cancel_fee_preparing" : status === "shipping" || status === "delivery_failed" ? "online.cancel_fee_shipping" : "online.cancel_fee_before_prepare";
  const v = (await db.prepare(`SELECT value FROM settings WHERE key=?`).bind(key).first<{ value: string }>())?.value;
  return v === "shop" || v === "customer" ? v : key === "online.cancel_fee_before_prepare" ? "shop" : "customer";
}

// ---------------------------------------------------------------- cancel (EC-06)

export async function cancelOrder(c: Ctx, id: number, reason: string) {
  const db = c.env.DB;
  const user = c.get("user");
  const o = await loadOpsOrder(db, id);
  await assertPeriodOpen(db, new Date(), "huỷ đơn / hoàn tiền"); // B-08
  const release = await releaseOrderStmts(db, id);
  const lots = await shippedLots(db, id); // đã xuất ở lần giao trước rồi giao lại → hàng về kho đúng lô
  const restock: D1PreparedStatement[] = [];
  for (const [lineId, sh] of lots) {
    const line = await db.prepare(`SELECT qty_milli FROM order_lines WHERE id=?`).bind(lineId).first<{ qty_milli: number }>();
    const p = takeFromLots(sh.lots, line!.qty_milli, 0);
    restock.push(...restockStmts(db, sh.productId, p.restock, [], "order_cancel", id, user.id));
  }
  // A-28: phí giao khi huỷ theo giai đoạn (xem cancelFeePolicy)
  const policy = await cancelFeePolicy(db, o.status);
  const keepFee = policy === "customer" ? o.shipping_fee ?? 0 : 0;
  // A-14: huỷ chỉ ghi nghĩa vụ hoàn tiền (refund_due); không chèn dòng quỹ. Hoàn thực tế do finance.write qua /refund. COD chưa thu → 0.
  const due = await refundObligation(db, id, keepFee);
  const set = ["cancel_reason = ?3", "shipping_fee_policy = ?4", "diff_status = 'none'", "diff_amount = 0", "refund_due = ?5"];
  const binds: unknown[] = [reason, policy, due];
  const t = transitionStmts(db, id, o.status, "cancelled", staff(c), { note: "Đơn đã được huỷ", internalNote: reason, extraSet: set.join(", "), extraBinds: binds });
  const stmts = [
    t[0],
    ...release,
    closeOrderShortagesStmt(db, id),
    ...restock,
    db.prepare(`UPDATE payment_intents SET status='cancelled' WHERE order_id=? AND status='pending'`).bind(id),
    ...t.slice(1),
    notifyJob(db, id, { status: "cancelled" }),
    auditStmt(c, { action: "online_order.cancel", entity: "order", entityId: id, before: { status: o.status }, after: { status: "cancelled", refundDue: due, restocked: lots.size > 0 }, reason }),
  ];
  await runOrderBatch(db, id, o.status, stmts);
  await finish(c, id);
  return { refund: 0, refundDue: due };
}

/**
 * Hoàn tiền thực tế (finance.write) cho nghĩa vụ `refund_due` do huỷ/trả hàng tạo ra (A-14): dòng payments âm cùng phương thức/quỹ gốc.
 * Đơn huỷ/trả: hoàn đúng `refund_due`; đơn đã giao có phiếu trả (completed) cũng hoàn theo `refund_due`. Hoàn đôi bị chặn bởi guard.
 */
export async function refundOrder(c: Ctx, id: number) {
  const db = c.env.DB;
  const o = await loadOpsOrder(db, id);
  if (o.status !== "cancelled" && o.status !== "returned" && !(o.status === "completed" && o.refund_due > 0)) throw conflict("not_refundable", "Chỉ hoàn tiền cho đơn đã huỷ hoặc đã trả hàng");
  await assertPeriodOpen(db, new Date(), "hoàn tiền"); // B-08
  if (!(o.refund_due > 0)) throw conflict("nothing_to_refund", "Đơn không còn khoản tiền cần hoàn");
  const refund = await refundPlan(db, id, o.total, 0, o.refund_due);
  if (!refund) throw conflict("nothing_to_refund", "Đơn không còn khoản tiền cần hoàn");
  const [g1, g2] = guardStmts(db, id, o.status);
  await runOrderBatch(db, id, o.status, [
    g1,
    assertStmt(db, "order.refund_due", `SELECT refund_due >= ? FROM orders WHERE id = ?`, [refund.amount, id]),
    refund.guard,
    refund.stmt,
    db.prepare(`UPDATE orders SET payment_status=?, paid_total = paid_total - ?, refund_due = refund_due - ? WHERE id=?`).bind(refund.status, refund.amount, refund.amount, id),
    g2,
    auditStmt(c, { action: "online_order.refund", entity: "order", entityId: id, before: { refundDue: o.refund_due }, after: { amount: refund.amount, status: refund.status } }),
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
  /** Giao hàng tại quầy (B3): đánh dấu nguồn + ca tạo + người giao, ghi cùng lúc tạo đơn. */
  pos?: { shiftId: number; delivererUserId?: number | null; zoneId?: number | null };
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
    const ex = await db.prepare(`SELECT id, status, created_at FROM orders WHERE client_uuid=?`).bind(b.clientUuid).first<{ id: number; status: string; created_at: string }>();
    if (ex && ex.status === "draft" && Date.parse(ex.created_at) < Date.now() - STALE_DRAFT_REPLAY_MS) {
      await retireStaleDraft(db, ex.id); // nháp mồ côi (crash giữa chừng): giải phóng clientUuid để thử lại
    } else if (ex) {
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
  let slotCapacity = 0;
  if (b.slotDate && b.slotId) {
    const slot = await db.prepare(`SELECT capacity FROM delivery_slots WHERE id=? AND active=1`).bind(b.slotId).first<{ capacity: number }>();
    if (!slot) throw new AppError(422, "slot_not_found", "Khung giờ giao không tồn tại");
    slotCapacity = slot.capacity;
    if ((await slotUsed(db, b.slotDate, b.slotId)) >= slot.capacity) throw conflict("slot_full", "Khung giờ giao đã đầy");
  }
  const total = subtotal + shippingFee;
  const code = await nextOnlineCode(db);
  const token = newTrackingToken();
  const status: OnlineStatus = b.paymentMethod === "transfer" ? "awaiting_payment" : "new";
  const address = [b.addressLine, b.ward, b.district, b.province].filter(Boolean).join(", ");
  const isPre = items.some((i) => i.preorder > 0) ? 1 : 0;
  let orderId: number;
  try {
    const r = await db
      .prepare(
        `INSERT INTO orders(code, client_uuid, channel, kind, store_id, customer_id, status, is_preorder, subtotal, shipping_fee, total, note, created_by,
                            tracking_token, receiver_name, receiver_phone, ship_address, zone_id, slot_date, slot_id, payment_method, estimated_total,
                            source, pos_shift_id, deliverer_user_id)
         VALUES (?,?,'social','sale',?,?, 'draft', ?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?)`,
      )
      .bind(code, b.clientUuid ?? null, storeId, b.customerId ?? null, isPre, subtotal, shippingFee, total, b.note ?? null, user.id,
        token, b.receiverName, b.receiverPhone, address, b.pos?.zoneId ?? zone?.id ?? null, b.slotDate ?? null, b.slotId ?? null, b.paymentMethod, total,
        b.pos ? "pos" : null, b.pos?.shiftId ?? null, b.pos?.delivererUserId ?? null)
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
        // Chốt chặn sức chứa khung giờ (audit #17): hai đơn đồng thời không được cùng chiếm chỗ cuối
        ...(b.slotDate && b.slotId ? [slotCapacityGuard(db, "slot.capacity", b.slotDate, b.slotId, slotCapacity)] : []),
        ...reserveStmts(db, orderId, plans),
        db.prepare(`UPDATE orders SET status=? WHERE id=? AND status='draft'`).bind(status, orderId),
        db.prepare(`INSERT INTO order_events(order_id, status, note, actor_type, actor_id) VALUES (?,?,?, 'staff', ?)`).bind(orderId, status, "Đơn được tạo bởi cửa hàng (mạng xã hội)", user.id),
      ];
      if (status === "awaiting_payment") {
        const hold = Number((await db.prepare(`SELECT value FROM settings WHERE key='online.hold_minutes_transfer'`).first<{ value: string }>())?.value) || 30;
        stmts.push(
          db
            .prepare(`INSERT INTO payment_intents(order_id, provider, amount, transfer_content, expires_at) VALUES (?, 'vietqr', ?, ?, ?)`)
            .bind(orderId, total, code, new Date(Date.now() + hold * 60_000).toISOString()),
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
    if (/state_changed/.test(String((e as Error)?.message)) && b.slotDate && b.slotId) throw conflict("slot_full", "Khung giờ giao đã đầy");
    if (/CHECK constraint failed/i.test(String((e as Error)?.message))) throw conflict("insufficient_stock", "Không đủ tồn khả dụng (tồn vừa thay đổi), vui lòng thử lại");
    throw e;
  }
  await kickJobs(c.env, "order", orderId);
  return { id: orderId, created: true };
}

// ---------------------------------------------------------------- đơn nháp mồ côi (audit #16)

/** Nháp quá tuổi này khi client gửi lại cùng clientUuid thì coi là mồ côi (crash giữa lúc tạo nháp và batch hoàn tất). */
export const STALE_DRAFT_REPLAY_MS = 2 * 60_000;
/** Nháp quá tuổi này bị cron dọn. */
export const STALE_DRAFT_SWEEP_MS = 10 * 60_000;

/** Huỷ một nháp mồ côi và giải phóng client_uuid (UNIQUE) để lần gửi lại tạo đơn mới. Chỉ tác động khi vẫn là 'draft'. */
export async function retireStaleDraft(db: D1Database, orderId: number) {
  await db
    .prepare(`UPDATE orders SET status='cancelled', client_uuid = CASE WHEN client_uuid IS NULL THEN NULL ELSE client_uuid || ':stale:' || id END WHERE id = ? AND status = 'draft'`)
    .bind(orderId)
    .run();
}

/**
 * Cron: huỷ các đơn 'draft' quá 10 phút (nháp không bao giờ giữ kho/tiền vì batch hoàn tất là nguyên tử) và
 * giải phóng clientUuid. Trả số đơn đã dọn.
 */
export async function sweepStaleDrafts(db: D1Database, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_DRAFT_SWEEP_MS).toISOString();
  const r = await db
    .prepare(`UPDATE orders SET status='cancelled', client_uuid = CASE WHEN client_uuid IS NULL THEN NULL ELSE client_uuid || ':stale:' || id END WHERE status = 'draft' AND created_at < ?`)
    .bind(cutoff)
    .run();
  return r.meta.changes ?? 0;
}

export const canCost = (c: Ctx) => can(c.get("user").role, "prices.view_cost");
export { CUSTOMER_LABEL };
