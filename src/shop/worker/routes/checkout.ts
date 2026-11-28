import { Hono } from "hono";
import { z } from "zod";
import { AppError, conflict } from "../../../worker/lib/errors";
import { nextCode, nextOnlineCode } from "../../../worker/lib/codes";
import { newTrackingToken } from "../../../worker/services/online-orders";
import { planReservations, type ReservationPlan } from "../../../worker/services/reservations";
import { kickJobs } from "../../../worker/services/outbox";
import { applyStock, computeTotals, priceCart, priceCtxOf, promoForCart, publicRemaining, redeemCustomerId } from "../lib/cart";
import { promoStatements } from "../../../worker/services/promo-checkout";
import { isPointsInsufficient, isVoucherExhausted } from "../../../worker/services/loyalty-points";
import { DATE_RE, addDaysStr, feeAfterDiscount, findZone, getSlot, slotProblem } from "../lib/delivery";
import { orderView } from "../lib/orderview";
import { optionalAuth } from "../lib/session";
import { verifyTurnstile } from "../lib/turnstile";
import { mailAllowed } from "../lib/mailguard";
import { assertStmt } from "../../../worker/services/guard";
import { slotCapacityGuard } from "../../../worker/services/slots";
import { baseUrl, enqueueByRef, last4, normalizePhone, httpError, onlineStoreId, parseBody, setting, settingNum } from "../lib/util";
import { vnDate } from "../../../worker/lib/time";
import type { ShopBindings } from "../env";
import { ItemSchema } from "./cart";

export const checkoutRoutes = new Hono<ShopBindings>();

export const AddressSchema = z.object({
  receiverName: z.string().trim().min(1).max(100),
  receiverPhone: z.string().trim().min(8).max(20),
  addressLine: z.string().trim().min(1).max(200),
  ward: z.string().trim().max(100).optional().nullable(),
  district: z.string().trim().min(1).max(100),
  province: z.string().trim().min(1).max(100),
});

const CheckoutSchema = z.object({
  // uuid-grade (>= 16 ký tự): chống đoán mã để xem lại đơn của người khác
  clientUuid: z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/),
  /** 4 số cuối SĐT người nhận — khách vãng lai gửi lại cùng clientUuid cần kèm (hoặc gửi lại đúng địa chỉ có SĐT đó) mới xem lại được đơn. */
  phone4: z.string().regex(/^\d{4}$/).optional(),
  items: z.array(ItemSchema.extend({ expectedUnitPrice: z.number().int().nonnegative() })).min(1).max(50),
  address: z.union([z.object({ addressId: z.number().int().positive() }), AddressSchema]),
  slotDate: z.string().regex(DATE_RE),
  slotId: z.number().int().positive(),
  paymentMethod: z.enum(["cod", "transfer", "gateway"]),
  note: z.string().trim().max(500).optional(),
  acceptPreorder: z.boolean().optional(),
  email: z.string().trim().email().max(200).optional(),
  voucherCode: z.string().trim().min(1).max(40).optional(), // Đợt 4
  redeemPoints: z.number().int().positive().max(100_000_000).optional(), // đổi điểm thành viên (chỉ tài khoản bán lẻ đăng nhập)
});

const isCheckFail = (e: unknown) => /CHECK constraint failed/i.test(String((e as Error)?.message ?? ""));
const isUnique = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? ""));
const ORD = `(SELECT id FROM orders WHERE code = ?1)`;

const OPEN_STATUSES = `('new','awaiting_payment')`;
const dayAgo = () => new Date(Date.now() - 86400_000).toISOString();
/** Số đơn COD đang mở (new/awaiting_payment) của một tài khoản — không giới hạn thời gian: đơn treo cũ vẫn giữ tồn cho tới khi cron/nhân viên xử lý. */
async function openCodByAccount(db: D1Database, accountId: number) {
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE channel = 'online' AND shop_account_id = ? AND payment_method = 'cod' AND status IN ${OPEN_STATUSES}`)
    .bind(accountId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}
/** Số đơn online chưa hoàn tất xác nhận của một SĐT người nhận trong 24h. */
async function openOrdersByPhone(db: D1Database, phone: string) {
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE channel = 'online' AND receiver_phone = ? AND status IN ${OPEN_STATUSES} AND created_at >= ?`)
    .bind(phone, dayAgo())
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Câu lệnh giữ tồn theo kế hoạch FEFO; order_line_id lấy theo thứ tự chèn dòng (vị trí) → cùng một batch với tạo đơn. */
function reserveByPosition(db: D1Database, code: string, plans: { pos: number; plan: ReservationPlan }[]) {
  const s: D1PreparedStatement[] = [];
  for (const { pos, plan } of plans)
    for (const a of plan.alloc)
      s.push(
        db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli + ? WHERE id = ?`).bind(a.qtyMilli, a.lotId),
        db
          .prepare(
            `INSERT INTO reservations(order_id, order_line_id, lot_id, qty_milli)
             VALUES (${ORD}, (SELECT id FROM order_lines WHERE order_id = ${ORD} ORDER BY id LIMIT 1 OFFSET ?2), ?3, ?4)`,
          )
          .bind(code, pos, a.lotId, a.qtyMilli),
      );
  return s;
}

checkoutRoutes.post("/checkout", optionalAuth, async (c) => {
  const db = c.env.DB;
  const b = await parseBody(c, CheckoutSchema);
  const account = c.get("account");

  // Idempotent theo clientUuid: kiểm trước Turnstile (token Turnstile chỉ dùng một lần, client có thể gửi lại cùng uuid)
  const replay = async () => {
    const ex = await db.prepare(`SELECT * FROM orders WHERE client_uuid = ?`).bind(b.clientUuid).first<any>();
    if (!ex) return null;
    if (ex.channel !== "online" || (ex.shop_account_id ?? null) !== (account?.id ?? null))
      throw conflict("duplicate_client_uuid", "Mã yêu cầu đã được dùng");
    if (account) return c.json(await orderView(db, ex), 200);
    // Khách vãng lai: chỉ lộ đầy đủ khi chứng minh biết SĐT người nhận (4 số cuối); ngược lại chỉ trả mã + trạng thái
    const supplied = b.phone4 ?? ("receiverPhone" in b.address ? last4(normalizePhone(b.address.receiverPhone) ?? "") : "");
    if (supplied && supplied === last4(ex.receiver_phone)) return c.json(await orderView(db, ex), 200);
    return c.json({ code: ex.code, status: ex.status }, 200);
  };
  const r0 = await replay();
  if (r0) return r0;

  // S-1: khách vãng lai và tài khoản CHƯA xác minh email (đặt COD) đều phải qua Turnstile
  if (!account || (b.paymentMethod === "cod" && !account.emailVerified)) await verifyTurnstile(c);

  // --- địa chỉ nhận ---
  let addr: z.infer<typeof AddressSchema>;
  if ("addressId" in b.address) {
    if (!account) throw new AppError(401, "unauthenticated", "Vui lòng đăng nhập để dùng sổ địa chỉ");
    const a = await db
      .prepare(`SELECT receiver_name, receiver_phone, address_line, ward, district, province FROM shop_addresses WHERE id = ? AND account_id = ? AND active = 1`)
      .bind(b.address.addressId, account.id)
      .first<any>();
    if (!a) throw new AppError(404, "address_not_found", "Không tìm thấy địa chỉ");
    addr = { receiverName: a.receiver_name, receiverPhone: a.receiver_phone, addressLine: a.address_line, ward: a.ward, district: a.district, province: a.province };
  } else addr = b.address;
  const phone = normalizePhone(addr.receiverPhone);
  if (!phone) throw new AppError(422, "invalid_phone", "Số điện thoại không hợp lệ");

  // Chống giữ hàng bằng đơn ảo (S-1): mỗi SĐT người nhận tối đa N đơn chưa hoàn tất (new/awaiting_payment) trong 24h,
  // và mỗi tài khoản đăng nhập tối đa N đơn COD đang mở — áp cho cả khách vãng lai lẫn tài khoản.
  const maxOpen = await settingNum(db, "online.max_open_orders_per_phone", 3);
  const capByAccount = !!account && b.paymentMethod === "cod";
  const overCap = async () => (await openOrdersByPhone(db, phone)) >= maxOpen || (capByAccount && (await openCodByAccount(db, account!.id)) >= maxOpen);
  const capError = () => httpError(429, "too_many_open_orders", "Bạn đang có quá nhiều đơn chưa được xác nhận, vui lòng chờ cửa hàng xử lý hoặc liên hệ hotline");
  if (await overCap()) throw capError();

  // --- khu vực + khung giờ ---
  const zone = await findZone(db, addr.district);
  if (!zone) throw new AppError(422, "zone_unsupported", "Chưa hỗ trợ giao hàng tới khu vực này");
  if (b.slotDate > addDaysStr(vnDate(), 14)) throw new AppError(422, "invalid_slot", "Chỉ nhận đặt giao trong 14 ngày tới");
  const slot = await getSlot(db, b.slotId);
  if (!slot) throw new AppError(422, "invalid_slot", "Khung giờ giao không tồn tại");
  const why = await slotProblem(db, slot, b.slotDate);
  if (why === "full") throw conflict("slot_full", "Khung giờ đã đầy, vui lòng chọn khung khác");
  if (why === "cutoff" || why === "past") throw conflict("slot_cutoff", "Đã quá giờ chốt đặt cho khung giờ này");
  if (why === "closed") throw new AppError(422, "slot_closed", "Khung giờ không giao vào ngày này");

  // --- giá + EC-11 ---
  const { lines, issues } = await priceCart(db, b.items, priceCtxOf(account));
  if (issues.length) throw new AppError(422, "product_unavailable", "Có sản phẩm không còn bán online", { issues });
  const changed = lines.filter((l) => l.expectedUnitPrice !== l.unitPrice);
  if (changed.length)
    throw conflict("price_changed", "Giá đã thay đổi, vui lòng kiểm tra lại giỏ hàng", {
      lines: changed.map((l) => ({ productId: l.productId, oldPrice: l.expectedUnitPrice, newPrice: l.unitPrice })),
    });
  const totals = await computeTotals(db, lines, addr.district);
  if (totals.subtotal < zone.minOrder) throw new AppError(422, "min_order", `Đơn tối thiểu ${zone.minOrder.toLocaleString("vi-VN")}đ`, { minOrder: zone.minOrder, subtotal: totals.subtotal });

  // --- khuyến mãi / voucher (Đợt 4): giảm tính trên tiền hàng, phí giao giữ nguyên ---
  const redeemCid = redeemCustomerId(account, b.redeemPoints);
  const promo = await promoForCart(db, lines, totals.subtotal, redeemCid, b.voucherCode, true, phone, b.redeemPoints ?? 0);
  // Ngưỡng miễn phí giao tính SAU giảm giá / voucher / điểm
  const orderDiscount = promo.promoTotal + promo.pointsAmount;
  const shippingFee = zone ? feeAfterDiscount(zone, totals.subtotal, orderDiscount) : 0;
  const finalTotal = totals.subtotal - orderDiscount + shippingFee;

  // --- thanh toán ---
  const methods = (await setting(db, "payment.methods", "cod,transfer")).split(",").map((x) => x.trim());
  if (!methods.includes(b.paymentMethod)) throw new AppError(422, "payment_method_unavailable", "Hình thức thanh toán này hiện chưa được hỗ trợ");
  if (b.paymentMethod === "transfer" && !(await setting(db, "payment.bank_account", "")))
    throw new AppError(422, "payment_method_unavailable", "Chuyển khoản tạm thời chưa khả dụng, vui lòng chọn hình thức khác");
  const holdMinutes = await settingNum(db, "online.hold_minutes_transfer", 30);
  const autoConfirm = (await setting(db, "online.auto_confirm", "0")) === "1";
  const storeId = await onlineStoreId(db);

  const code = await nextOnlineCode(db);
  // A-24: khách vãng lai — dùng lại hồ sơ khách bán lẻ cùng SĐT (lịch sử/điểm không bị tách), chỉ tạo mới khi chưa có
  const phoneForms = [phone, "+84" + phone.slice(1), "84" + phone.slice(1)];
  const knownGuestId = account
    ? null
    : (
        await db
          .prepare(`SELECT id FROM customers WHERE type = 'retail' AND active = 1 AND phone IN (?, ?, ?) ORDER BY id LIMIT 1`)
          .bind(...phoneForms)
          .first<{ id: number }>()
      )?.id ?? null;
  const guestCustomerCode = account || knownGuestId ? null : await nextCode(db, "KL");
  const token = newTrackingToken();
  const groupId = (await db.prepare(`SELECT id FROM customer_groups WHERE code = 'le'`).first<{ id: number }>())?.id ?? null;
  const shipAddress = [addr.addressLine, addr.ward, addr.district, addr.province].filter(Boolean).join(", ");
  const link = `${baseUrl(c)}/track/${token}`;

  // Email xác nhận cho khách vãng lai: giới hạn theo người nhận (60 giây/lần, 5/ngày) — bị chặn thì bỏ qua im lặng
  const guestMailOk = !account && !!b.email && (await mailAllowed(db, "notify.order_status", null, b.email));

  for (let attempt = 0; ; attempt++) {
    const short = await applyStock(db, storeId, lines);
    for (const s of short)
      if (!s.line.allowPreorder || !b.acceptPreorder)
        throw conflict("insufficient_stock", "Không đủ hàng cho một số sản phẩm", { productId: s.line.productId, availableMilli: publicRemaining(s.line, s.remainingBefore) });
    const isPreorder = lines.some((l) => l.preorderMilli > 0);

    let plans: { pos: number; plan: ReservationPlan }[] = [];
    try {
      const covered = lines.map((l, pos) => ({ l, pos })).filter((x) => x.l.coveredMilli > 0);
      const res = covered.length
        ? await planReservations(db, covered.map((x) => ({ orderLineId: x.pos, productId: x.l.productId, qtyMilli: x.l.coveredMilli })), storeId)
        : [];
      plans = res.map((plan, i) => ({ pos: covered[i].pos, plan }));
    } catch (e) {
      if (e instanceof AppError && e.code === "insufficient_stock" && attempt === 0) continue;
      throw e;
    }

    const status = b.paymentMethod === "cod" ? (autoConfirm && !isPreorder ? "confirmed" : "new") : "awaiting_payment";
    const payStatus = b.paymentMethod === "cod" ? "unpaid" : "pending";
    const stmts: D1PreparedStatement[] = [];
    // Chốt chặn đồng thời (trong batch): khung giờ còn chỗ và SĐT chưa vượt trần đơn mở — đặt ĐẦU batch
    stmts.push(
      slotCapacityGuard(db, "checkout.slot_capacity", b.slotDate, b.slotId, slot.capacity),
    );
    stmts.push(
      assertStmt(db, "checkout.phone_open_cap", `SELECT (SELECT COUNT(*) FROM orders WHERE channel = 'online' AND receiver_phone = ? AND status IN ${OPEN_STATUSES} AND created_at >= ?) < ?`, [phone, dayAgo(), maxOpen]),
    );
    if (capByAccount)
      stmts.push(
        assertStmt(db, "checkout.account_open_cap", `SELECT (SELECT COUNT(*) FROM orders WHERE channel = 'online' AND shop_account_id = ? AND payment_method = 'cod' AND status IN ${OPEN_STATUSES}) < ?`, [account!.id, maxOpen]),
      );
    if (guestCustomerCode)
      stmts.push(
        db
          .prepare(`INSERT INTO customers(code, type, name, phone, email, customer_group_id, created_at) VALUES (?, 'retail', ?, ?, ?, ?, ?)`)
          .bind(guestCustomerCode, addr.receiverName, phone, b.email ?? null, groupId, new Date().toISOString()),
      );
    stmts.push(
      db
        .prepare(
          `INSERT INTO orders(code, client_uuid, channel, kind, store_id, customer_id, status, is_preorder, subtotal, discount, shipping_fee, total, note,
                              shop_account_id, tracking_token, receiver_name, receiver_phone, ship_address, zone_id, slot_date, slot_id,
                              payment_method, payment_status, estimated_total, weight_adjust_status, contact_email)
           VALUES (?,?,'online','sale',?, COALESCE(?, (SELECT id FROM customers WHERE code = ?)), ?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,'none', ?)`,
        )
        .bind(
          code, b.clientUuid, storeId, account?.customerId ?? knownGuestId, guestCustomerCode, status, isPreorder ? 1 : 0,
          totals.subtotal, orderDiscount, shippingFee, finalTotal, b.note ?? null,
          account?.id ?? null, token, addr.receiverName, phone, shipAddress, zone.id, b.slotDate, b.slotId,
          b.paymentMethod, payStatus, finalTotal,
          // S-2: email người mua lưu TRÊN ĐƠN ('' = khách vãng lai không để lại email → không gửi thông báo tới hồ sơ cũ)
          account ? null : b.email ?? "",
        ),
    );
    for (const [li, l] of lines.entries())
      stmts.push(
        db
          .prepare(
            `INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, discount, line_total, ordered_qty_milli, preorder_milli)
             VALUES (${ORD}, ?2, ?3, ?4, ?5, ?8, ?6, ?4, ?7)`,
          )
          // A-08: giảm giá/voucher/điểm đã phân bổ theo dòng → báo cáo theo dòng khớp doanh thu (phí giao báo riêng ở orders.shipping_fee)
          .bind(code, l.productId, l.unit, l.qtyMilli, l.unitPrice, l.lineTotal - (promo.lineDiscounts[li] ?? 0), l.preorderMilli, promo.lineDiscounts[li] ?? 0),
      );
    stmts.push(...reserveByPosition(db, code, plans));
    stmts.push(
      ...(await promoStatements(
        db,
        { sql: "(SELECT id FROM orders WHERE code = ?)", bind: code },
        {
          plan: promo, customerId: account?.customerId ?? null, receiverPhone: phone, payableTotal: finalTotal, userId: null, skipEarn: true,
          // Lượt dùng voucher của khách vãng lai ghi theo hồ sơ khách (cũ hoặc mới tạo) để giới hạn theo khách đếm đúng khi họ đăng nhập
          customerSql: knownGuestId ? { sql: "(SELECT id FROM customers WHERE id = ?)", bind: knownGuestId } : { sql: "(SELECT id FROM customers WHERE code = ?)", bind: guestCustomerCode },
        },
      )),
    );
    const ev = (st: string, note: string) =>
      db
        .prepare(`INSERT INTO order_events(order_id, status, note, actor_type, actor_id) VALUES (${ORD}, ?2, ?3, 'customer', ?4)`)
        .bind(code, st, note, account?.id ?? null);
    if (status === "confirmed") stmts.push(ev("new", "Đặt hàng thành công"), ev("confirmed", "Đơn được tự động xác nhận"));
    else stmts.push(ev(status, status === "awaiting_payment" ? "Đặt hàng thành công, chờ thanh toán" : "Đặt hàng thành công"));
    if (b.paymentMethod !== "cod") {
      const expires = new Date(Date.now() + holdMinutes * 60_000).toISOString();
      stmts.push(
        db
          .prepare(`INSERT INTO payment_intents(order_id, provider, amount, transfer_content, provider_ref, expires_at) VALUES (${ORD}, ?2, ?3, ?4, ?5, ?6)`)
          .bind(code, b.paymentMethod === "transfer" ? "vietqr" : "fake_gateway", finalTotal, code, b.paymentMethod === "gateway" ? code : null, expires),
      );
    }
    stmts.push(
      enqueueByRef(db, "notify.order_status", "order", code, {
        orderCode: code, status, accountId: account?.id ?? null, email: account ? null : guestMailOk ? b.email ?? null : null, link,
        ...(!account && !guestMailOk ? { skipEmail: true } : {}), // bị mailguard chặn / không có email: không gửi tới hồ sơ cũ
      }),
      enqueueByRef(db, "notify.staff_new_order", "order", code, { orderCode: code, total: finalTotal, isPreorder }),
    );

    try {
      await db.batch(stmts);
    } catch (e) {
      if (isUnique(e)) {
        const r = await replay();
        if (r) return r;
      }
      if (isPointsInsufficient(e)) throw conflict("points_insufficient", "Số dư điểm không đủ (có thể vừa được dùng ở đơn khác)");
      if (isVoucherExhausted(e)) throw conflict("voucher_exhausted", "Voucher đã hết lượt sử dụng");
      if (/state_changed/.test(String((e as Error)?.message ?? ""))) {
        // Chốt chặn trong batch bật: xác định nguyên nhân để báo đúng lỗi
        if ((await slotProblem(db, slot, b.slotDate)) === "full") throw conflict("slot_full", "Khung giờ đã đầy, vui lòng chọn khung khác");
        if (await overCap()) throw capError();
        await promoForCart(db, lines, totals.subtotal, redeemCid, b.voucherCode, true, phone, b.redeemPoints ?? 0); // ném lỗi voucher cụ thể nếu có
      }
      if (isCheckFail(e)) {
        if (attempt === 0) continue; // tồn vừa đổi: tính lại một lần
        throw conflict("insufficient_stock", "Không đủ hàng (tồn vừa thay đổi), vui lòng thử lại");
      }
      throw e;
    }
    const row = await db.prepare(`SELECT * FROM orders WHERE code = ?`).bind(code).first<any>();
    try {
      await kickJobs(c.env as never, "order", row.id);
    } catch {
      /* cron sẽ quét lại */
    }
    return c.json(await orderView(db, row), 201);
  }
});
