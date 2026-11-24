import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can, requirePerm } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { lineAmount } from "../lib/money";
import { vnDate, vnPeriod } from "../lib/time";
import { parseBody, unitFactor } from "../services/http";
import { registerApprovalHandler } from "../services/approval-registry";
import { resolvePrice } from "../services/pricing";
import { allocateFefo, allocationCost, moveStatements, type LotAllocation } from "../services/stock";
import { consumeForDeliveryStmts, planReservations, releaseOrderStmts } from "../services/reservations";
import { getSettingInt } from "../services/settings";
import { assertStmt } from "../services/guard";

/** M1-12 đặt trước giỏ quà dịp lễ tại quầy: cọc khi đặt → phiếu thu; giao thì trừ cọc, doanh thu ghi nhận khi đơn completed. */
export const preorderRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const METHODS = ["cash", "transfer", "qr", "card", "ewallet"] as const;
const isCheckFail = (e: unknown) => /CHECK constraint failed/i.test(String((e as Error)?.message ?? ""));
const ORD = `(SELECT id FROM orders WHERE code = ?1)`;

const DEP_IN = { code: "COC_DAT_HANG", name: "Đặt cọc đơn đặt trước", direction: "in" };
const DEP_OUT = { code: "COC_HOAN", name: "Hoàn tiền đặt cọc", direction: "out" };
// pnl_line 'revenue': không tính vào chi phí P&L (cọc là khoản phải trả khách, không phải doanh thu/chi phí)
const ensureCategory = (db: D1Database, c: typeof DEP_IN) =>
  db.prepare(`INSERT OR IGNORE INTO cash_categories(code, name, direction, pnl_line) VALUES (?,?,?, 'revenue')`).bind(c.code, c.name, c.direction);

async function openShiftOf(db: D1Database, userId: number) {
  return db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).bind(userId).first<any>();
}

async function fundFor(db: D1Database, storeId: number, method: string, shift: { fund_id: number } | null) {
  if (method === "cash") {
    if (shift) return shift.fund_id;
    const f = await db.prepare(`SELECT id FROM funds WHERE type='cash' AND active=1 ORDER BY (store_id IS ?) DESC, id LIMIT 1`).bind(storeId).first<{ id: number }>();
    if (!f) throw new AppError(422, "no_fund", "Chưa cấu hình quỹ tiền mặt");
    return f.id;
  }
  for (const t of method === "ewallet" ? ["ewallet", "bank"] : ["bank"]) {
    const f = await db.prepare(`SELECT id FROM funds WHERE type = ? AND active=1 ORDER BY (store_id IS ?) DESC, id LIMIT 1`).bind(t, storeId).first<{ id: number }>();
    if (f) return f.id;
  }
  throw new AppError(422, "no_fund", "Chưa cấu hình quỹ ngân hàng cho hình thức thanh toán này");
}

async function customerCode(db: D1Database) {
  const r = await db
    .prepare(`INSERT INTO doc_sequences(prefix, day, seq) VALUES ('KH','-',1) ON CONFLICT(prefix, day) DO UPDATE SET seq = seq + 1 RETURNING seq`)
    .first<{ seq: number }>();
  return `KH-${String(r!.seq).padStart(4, "0")}`;
}

const preorderSchema = z.object({
  clientUuid: z.string().min(8).max(64).optional(),
  customerId: z.number().int().positive().optional(),
  customer: z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().min(8).max(20) }).optional(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(z.object({ productId: z.number().int().positive(), unit: z.string().min(1).max(20), qty: z.number().positive().max(100000) })).min(1).max(100),
  deposit: z.object({ amount: z.number().int().positive().max(10_000_000_000), method: z.enum(METHODS) }),
  note: z.string().max(500).optional(),
});

async function view(c: Ctx, orderId: number) {
  const db = c.env.DB;
  const o = await db
    .prepare(`SELECT o.*, cu.name AS customer_name, cu.phone AS customer_phone FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id WHERE o.id = ? AND o.is_preorder = 1`)
    .bind(orderId)
    .first<any>();
  if (!o) throw notFound("preorder_not_found", "Không tìm thấy đơn đặt trước");
  const lines = (await db.prepare(`SELECT ol.*, p.name AS product_name FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`).bind(orderId).all<any>()).results;
  const dep = await db.prepare(`SELECT * FROM order_deposits WHERE order_id = ? ORDER BY id DESC LIMIT 1`).bind(orderId).first<any>();
  const reserved = (await db.prepare(`SELECT COALESCE(SUM(qty_milli),0) AS q FROM reservations WHERE order_id = ? AND status='active'`).bind(orderId).first<{ q: number }>())!.q;
  return {
    id: o.id, code: o.code, status: o.status, pickupDate: o.pickup_date, subtotal: o.subtotal, total: o.total, paidTotal: o.paid_total, note: o.note,
    customer: o.customer_id ? { id: o.customer_id, name: o.customer_name } : null, createdAt: o.created_at, completedAt: o.completed_at,
    lines: lines.map((l) => ({ id: l.id, productId: l.product_id, productName: l.product_name, unit: l.unit, qtyMilli: l.qty_milli, unitPrice: l.unit_price, lineTotal: l.line_total })),
    deposit: dep ? { id: dep.id, amount: dep.amount, method: dep.method, fundId: dep.fund_id, status: dep.status, cashVoucherId: dep.cash_voucher_id, settledAt: dep.settled_at } : null,
    remaining: dep && dep.status === "held" ? o.total - dep.amount : Math.max(0, o.total - o.paid_total),
    reservedMilli: reserved,
  };
}

preorderRoutes.get("/pos/preorders", requirePerm("pos.sell"), async (c) => {
  const q = c.req.query();
  const where = ["o.is_preorder = 1"];
  const params: unknown[] = [];
  if (q.status) { where.push(`o.status = ?`); params.push(q.status); }
  if (q.pickupDate) { where.push(`o.pickup_date = ?`); params.push(q.pickupDate); }
  const { results } = await c.env.DB
    .prepare(
      `SELECT o.id, o.code, o.status, o.total, o.pickup_date, o.customer_id, cu.name AS customer_name,
              (SELECT d.amount FROM order_deposits d WHERE d.order_id = o.id ORDER BY d.id DESC LIMIT 1) AS deposit_amount,
              (SELECT d.status FROM order_deposits d WHERE d.order_id = o.id ORDER BY d.id DESC LIMIT 1) AS deposit_status
         FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id WHERE ${where.join(" AND ")} ORDER BY o.pickup_date, o.id DESC LIMIT 200`,
    )
    .bind(...params)
    .all<any>();
  return c.json({
    items: results.map((r) => ({ id: r.id, code: r.code, status: r.status, total: r.total, pickupDate: r.pickup_date, customerId: r.customer_id, customerName: r.customer_name, depositAmount: r.deposit_amount, depositStatus: r.deposit_status })),
  });
});

preorderRoutes.get("/pos/preorders/:id", requirePerm("pos.sell"), async (c) => c.json(await view(c, Number(c.req.param("id")))));

preorderRoutes.post("/pos/preorders", requirePerm("pos.sell"), async (c) => {
  const b = await parseBody(c, preorderSchema);
  const db = c.env.DB;
  const user = c.get("user");
  if (b.clientUuid) {
    const ex = await db.prepare(`SELECT id, is_preorder FROM orders WHERE client_uuid = ?`).bind(b.clientUuid).first<{ id: number; is_preorder: number }>();
    if (ex) {
      if (!ex.is_preorder) throw conflict("duplicate_client_uuid", "Mã yêu cầu đã được dùng");
      return c.json(await view(c, ex.id), 200);
    }
  }
  if (!b.customerId && !b.customer) throw new AppError(422, "customer_required", "Đơn đặt trước cần thông tin khách hàng");
  if (b.pickupDate < vnDate()) throw new AppError(422, "invalid_pickup_date", "Ngày hẹn lấy phải từ hôm nay trở đi");
  const shift = await openShiftOf(db, user.id);
  if (!shift) throw conflict("no_open_shift", "Chưa mở ca bán hàng");
  const storeId = shift.store_id as number;

  // khách hàng
  let customerId = b.customerId ?? null;
  let newCustomerCode: string | null = null;
  let group: number | null = null;
  if (customerId) {
    const cu = await db.prepare(`SELECT id, customer_group_id FROM customers WHERE id = ? AND active = 1`).bind(customerId).first<any>();
    if (!cu) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng");
    group = cu.customer_group_id;
  } else {
    const found = await db.prepare(`SELECT id, customer_group_id FROM customers WHERE phone = ? AND active = 1 ORDER BY id LIMIT 1`).bind(b.customer!.phone).first<any>();
    if (found) { customerId = found.id; group = found.customer_group_id; }
    else {
      newCustomerCode = await customerCode(db);
      group = (await db.prepare(`SELECT id FROM customer_groups WHERE code = 'le'`).first<{ id: number }>())?.id ?? null;
    }
  }

  // giá + tổng
  const lines: { productId: number; unit: string; qtyMilli: number; unitPrice: number; priceListId: number; lineTotal: number }[] = [];
  for (const l of b.lines) {
    const factor = await unitFactor(db, l.productId, l.unit);
    const p = await db.prepare(`SELECT active FROM products WHERE id = ?`).bind(l.productId).first<{ active: number }>();
    if (!p || !p.active) throw new AppError(422, "product_not_found", "Mặt hàng không tồn tại hoặc đã ngừng bán", { productId: l.productId });
    const qtyMilli = Math.round(l.qty * factor);
    if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ");
    const r = await resolvePrice(db, l.productId, { channel: "pos", customerGroupId: group, customerId });
    lines.push({ productId: l.productId, unit: l.unit, qtyMilli, unitPrice: r.unitPrice, priceListId: r.priceListId, lineTotal: lineAmount(r.unitPrice, qtyMilli) });
  }
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  const minBp = await getSettingInt(db, "deposit.min_bp", 3000);
  const minDeposit = Math.ceil((total * minBp) / 10000);
  if (b.deposit.amount < minDeposit) throw new AppError(422, "deposit_too_low", "Tiền cọc thấp hơn mức tối thiểu", { minDeposit, total });
  if (b.deposit.amount > total) throw new AppError(422, "deposit_too_high", "Tiền cọc lớn hơn giá trị đơn", { total });
  const fundId = await fundFor(db, storeId, b.deposit.method, shift);

  // giữ tồn nếu có hàng (thiếu thì đặt trước không giữ — giao khi hàng về)
  let plans: Awaited<ReturnType<typeof planReservations>> = [];
  try {
    plans = await planReservations(db, lines.map((l, i) => ({ orderLineId: i, productId: l.productId, qtyMilli: l.qtyMilli })), storeId);
  } catch (e) {
    if (!(e instanceof AppError && e.code === "insufficient_stock")) throw e;
  }

  const code = await nextCode(db, PREFIX.order);
  const vCode = await nextCode(db, PREFIX.cashIn);
  const stmts: D1PreparedStatement[] = [];
  if (newCustomerCode)
    stmts.push(
      db
        .prepare(`INSERT INTO customers(code, type, name, phone, customer_group_id, created_at) VALUES (?, 'retail', ?, ?, ?, ?)`)
        .bind(newCustomerCode, b.customer!.name, b.customer!.phone, group, new Date().toISOString()),
    );
  stmts.push(
    db
      .prepare(
        `INSERT INTO orders(code, client_uuid, channel, kind, store_id, shift_id, customer_id, status, is_preorder, pickup_date, subtotal, total, paid_total, note, created_by)
         VALUES (?,?, 'pos','sale',?,?, COALESCE(?, (SELECT id FROM customers WHERE code = ?)), 'confirmed', 1, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(code, b.clientUuid ?? null, storeId, shift.id, customerId, newCustomerCode, b.pickupDate, total, total, b.deposit.amount, b.note ?? null, user.id),
  );
  for (const l of lines)
    stmts.push(
      db
        .prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, discount, line_total) VALUES (${ORD}, ?2, ?3, ?4, ?5, ?6, 0, ?7)`)
        .bind(code, l.productId, l.unit, l.qtyMilli, l.unitPrice, l.priceListId, l.lineTotal),
    );
  for (const p of plans)
    for (const a of p.alloc)
      stmts.push(
        db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli + ? WHERE id = ?`).bind(a.qtyMilli, a.lotId),
        db
          .prepare(`INSERT INTO reservations(order_id, order_line_id, lot_id, qty_milli) VALUES (${ORD}, (SELECT id FROM order_lines WHERE order_id = ${ORD} ORDER BY id LIMIT 1 OFFSET ?2), ?3, ?4)`)
          .bind(code, p.orderLineId, a.lotId, a.qtyMilli),
      );
  stmts.push(
    ensureCategory(db, DEP_IN),
    db
      .prepare(
        `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by)
         VALUES (?, 'in', ?, (SELECT id FROM cash_categories WHERE code = ?), ?, ?, 'order_deposit', ${ORD.replace("?1", "?")}, 'posted', ?, ?, ?, ?)`,
      )
      .bind(vCode, fundId, DEP_IN.code, b.deposit.amount, b.customer?.name ?? null, code, vnPeriod(), `Đặt cọc đơn ${code}`, user.id, user.id),
    db
      .prepare(
        `INSERT INTO order_deposits(order_id, amount, method, fund_id, cash_voucher_id, created_by) VALUES (${ORD}, ?2, ?3, ?4, (SELECT id FROM cash_vouchers WHERE code = ?5), ?6)`,
      )
      .bind(code, b.deposit.amount, b.deposit.method, fundId, vCode, user.id),
    auditStmt(c, { action: "preorder.create", entity: "order", entityId: code, after: { total, deposit: b.deposit.amount, pickupDate: b.pickupDate, reserved: plans.length > 0 } }),
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    if (b.clientUuid) {
      const again = await db.prepare(`SELECT id FROM orders WHERE client_uuid = ?`).bind(b.clientUuid).first<{ id: number }>();
      if (again) return c.json(await view(c, again.id), 200);
    }
    if (isCheckFail(e)) throw conflict("insufficient_stock", "Tồn vừa thay đổi, vui lòng thử lại");
    throw e;
  }
  const row = await db.prepare(`SELECT id FROM orders WHERE code = ?`).bind(code).first<{ id: number }>();
  return c.json(await view(c, row!.id), 201);
});

async function loadPreorder(db: D1Database, id: number) {
  const o = await db.prepare(`SELECT * FROM orders WHERE id = ? AND is_preorder = 1`).bind(id).first<any>();
  if (!o) throw notFound("preorder_not_found", "Không tìm thấy đơn đặt trước");
  if (o.status !== "confirmed") throw conflict("invalid_status", `Đơn đặt trước đang ở trạng thái ${o.status}`, { status: o.status });
  const dep = await db.prepare(`SELECT * FROM order_deposits WHERE order_id = ? AND status = 'held' ORDER BY id DESC LIMIT 1`).bind(id).first<any>();
  if (!dep) throw conflict("no_held_deposit", "Đơn không còn tiền cọc đang giữ");
  return { o, dep };
}

preorderRoutes.post("/pos/preorders/:id/fulfill", requirePerm("pos.sell"), async (c) => {
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, z.object({ payments: z.array(z.object({ method: z.enum(METHODS), amount: z.number().int().positive().max(10_000_000_000), ref: z.string().max(100).optional() })).max(10).default([]) }));
  const db = c.env.DB;
  const user = c.get("user");
  const { o, dep } = await loadPreorder(db, id);
  const shift = await openShiftOf(db, user.id);
  if (!shift) throw conflict("no_open_shift", "Chưa mở ca bán hàng");
  const remaining = o.total - dep.amount;
  const paid = b.payments.reduce((s, p) => s + p.amount, 0);
  if (paid < remaining) throw new AppError(422, "payment_mismatch", "Thanh toán chưa đủ phần còn lại sau cọc", { remaining, paid });
  const cashTotal = b.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
  const change = paid - remaining;
  if (change > cashTotal) throw new AppError(422, "payment_mismatch", "Thanh toán vượt phần còn lại (chỉ tiền mặt được thối lại)", { remaining, paid });
  const recorded = b.payments.map((p) => ({ ...p }));
  let toCut = change;
  for (let i = recorded.length - 1; i >= 0 && toCut > 0; i--) {
    if (recorded[i].method !== "cash") continue;
    const cut = Math.min(recorded[i].amount, toCut);
    recorded[i].amount -= cut;
    toCut -= cut;
  }
  const payFunds = new Map<string, number>();
  for (const p of recorded) if (!payFunds.has(p.method)) payFunds.set(p.method, await fundFor(db, shift.store_id, p.method, shift));

  const lines = (await db.prepare(`SELECT id, product_id, qty_milli FROM order_lines WHERE order_id = ? ORDER BY id`).bind(id).all<any>()).results;

  const build = async () => {
    const consume = await consumeForDeliveryStmts(db, id, new Map(lines.map((l) => [l.id, l.qty_milli])), "order", id, user.id);
    const allocByLine = new Map<number, LotAllocation[]>(consume.allocByLine);
    const extra: D1PreparedStatement[] = [];
    // phần giữ không đủ (đặt trước chưa có hàng khi đặt): lấy thêm FEFO từ tồn tự do
    for (const [lineId, miss] of consume.shortByLine) {
      const line = lines.find((l) => l.id === lineId)!;
      const alloc = await allocateFefo(db, line.product_id, miss, shift.store_id);
      allocByLine.set(lineId, [...(allocByLine.get(lineId) ?? []), ...alloc]);
      extra.push(...moveStatements(db, line.product_id, alloc, -1, "sale", "order", id, user.id));
    }
    // Chốt chặn (audit #7): giao/huỷ/hoàn cọc đồng thời — đơn còn 'confirmed' và cọc còn 'held' mới được xuất kho
    const stmts: D1PreparedStatement[] = [
      assertStmt(db, "preorder.fulfill", `SELECT (SELECT status FROM orders WHERE id = ?) = 'confirmed' AND (SELECT status FROM order_deposits WHERE id = ?) = 'held'`, [id, dep.id]),
      ...consume.stmts,
      ...extra,
    ];
    let costTotal = 0;
    for (const l of lines) {
      const alloc = allocByLine.get(l.id) ?? [];
      const cost = allocationCost(alloc);
      costTotal += cost;
      stmts.push(db.prepare(`UPDATE order_lines SET cost_amount = ? WHERE id = ?`).bind(cost, l.id));
      for (const a of alloc) stmts.push(db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(l.id, a.lotId, a.qtyMilli, a.unitCost));
    }
    for (const p of recorded) {
      if (p.amount <= 0) continue;
      stmts.push(db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`).bind(id, p.method, p.amount, payFunds.get(p.method)!, p.ref ?? null));
    }
    stmts.push(
      db
        .prepare(`UPDATE orders SET status='completed', cost_total=?, paid_total=?, shift_id=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='confirmed'`)
        .bind(costTotal, o.total, shift.id, id),
      db.prepare(`UPDATE order_deposits SET status='applied', settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='held'`).bind(dep.id),
      auditStmt(c, { action: "preorder.fulfill", entity: "order", entityId: o.code, after: { total: o.total, deposit: dep.amount, paidNow: o.total - dep.amount, change } }),
    );
    return stmts;
  };
  try {
    try {
      await db.batch(await build());
    } catch (e) {
      if (!isCheckFail(e)) throw e;
      await db.batch(await build());
    }
  } catch (e) {
    if (isCheckFail(e)) throw conflict("insufficient_stock", "Không đủ tồn để giao (tồn vừa thay đổi)");
    throw e;
  }
  return c.json({ ...(await view(c, id)), change });
});

/** Huỷ đơn đặt trước: nhả giữ tồn, cọc → hoàn (phiếu chi) hoặc không hoàn (forfeited, thu khác). Dùng chung cho API và handler duyệt. */
async function cancelStatements(c: Ctx, o: any, dep: any, mode: "refund" | "forfeit", reason: string) {
  const db = c.env.DB;
  const user = c.get("user");
  const stmts: D1PreparedStatement[] = [
    // Chốt chặn (audit #7): hoàn cọc hai lần / hoàn cọc sau khi đã giao → rollback, không sinh phiếu chi thứ hai
    assertStmt(db, "preorder.cancel", `SELECT (SELECT status FROM orders WHERE id = ?) = 'confirmed' AND (SELECT status FROM order_deposits WHERE id = ?) = 'held'`, [o.id, dep.id]),
    ...(await releaseOrderStmts(db, o.id)),
  ];
  stmts.push(db.prepare(`UPDATE orders SET status='cancelled', void_reason=?, voided_by=? WHERE id=? AND status='confirmed'`).bind(reason, user.id, o.id));
  if (mode === "refund") {
    const vCode = await nextCode(db, PREFIX.cashOut);
    stmts.push(
      ensureCategory(db, DEP_OUT),
      db
        .prepare(
          `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, ref_type, ref_id, status, period, note, created_by, approved_by)
           VALUES (?, 'out', ?, (SELECT id FROM cash_categories WHERE code = ?), ?, 'order_deposit', ?, 'posted', ?, ?, ?, ?)`,
        )
        .bind(vCode, dep.fund_id, DEP_OUT.code, dep.amount, o.id, vnPeriod(), `Hoàn cọc đơn ${o.code}: ${reason}`, user.id, user.id),
      db.prepare(`UPDATE order_deposits SET status='refunded', settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='held'`).bind(dep.id),
    );
  } else {
    stmts.push(db.prepare(`UPDATE order_deposits SET status='forfeited', settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='held'`).bind(dep.id));
  }
  stmts.push(auditStmt(c, { action: mode === "refund" ? "preorder.cancel_refund" : "preorder.cancel_forfeit", entity: "order", entityId: o.code, after: { deposit: dep.amount, mode }, reason }));
  return stmts;
}

preorderRoutes.post("/pos/preorders/:id/cancel", requirePerm("pos.sell"), async (c) => {
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, z.object({ refundDeposit: z.boolean(), reason: z.string().trim().min(3).max(300) }));
  const db = c.env.DB;
  const user = c.get("user");
  const { o, dep } = await loadPreorder(db, id);
  if (!b.refundDeposit && !can(user.role, "approvals.decide")) {
    // không hoàn cọc = mất cọc, cần quản lý duyệt; duyệt xong hệ thống tự huỷ + ghi nhận forfeited
    const pending = await db.prepare(`SELECT id FROM approvals WHERE type='preorder.forfeit' AND ref_id = ? AND status='pending'`).bind(String(id)).first<{ id: number }>();
    let approvalId = pending?.id;
    if (!approvalId) {
      const r = await db
        .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('preorder.forfeit','order',?,?,?,?)`)
        .bind(String(id), JSON.stringify({ orderCode: o.code, deposit: dep.amount, reason: b.reason }), `Huỷ đơn đặt trước ${o.code}, không hoàn cọc ${dep.amount}`, user.id)
        .run();
      approvalId = r.meta.last_row_id as number;
    }
    throw conflict("approval_required", "Không hoàn cọc cần quản lý duyệt", { approvalId });
  }
  await db.batch(await cancelStatements(c, o, dep, b.refundDeposit ? "refund" : "forfeit", b.reason));
  return c.json(await view(c, id));
});

registerApprovalHandler("preorder.forfeit", {
  perm: "approvals.decide",
  onApprove: async (c, a) => {
    const { o, dep } = await loadPreorder(c.env.DB, Number(a.ref_id));
    let reason = "Không hoàn cọc (đã duyệt)";
    try { reason = JSON.parse(a.payload_json ?? "{}").reason ?? reason; } catch { /* giữ mặc định */ }
    return cancelStatements(c, o, dep, "forfeit", reason);
  },
});
