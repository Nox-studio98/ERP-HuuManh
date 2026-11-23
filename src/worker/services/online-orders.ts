import { AppError } from "../lib/errors";

/**
 * Vòng đời đơn online (M1 "Trạng thái đơn online", M8) — dùng chung cho website (shop worker) và ERP.
 *
 *  awaiting_payment ──(tiền về / cổng TT báo thành công)──► new
 *  new ──(nhân viên xác nhận, đủ hàng)──► confirmed ──(bắt đầu soạn)──► preparing
 *  preparing ──(cân/đóng gói xong, giao shipper)──► shipping ──(giao thành công)──► completed
 *  Nhánh: new|awaiting_payment|confirmed|preparing → cancelled (EC-06)
 *         shipping → delivery_failed (EC-07) → confirmed (giao lại) | returned (hoàn kho)
 *         completed → returned (trả hàng sau giao, M1-09)
 *
 * Trạng thái khách nhìn thấy (CUSTOMER_LABEL) gộp bớt để dễ hiểu.
 */
export type OnlineStatus =
  | "awaiting_payment" | "new" | "confirmed" | "preparing" | "shipping"
  | "completed" | "cancelled" | "delivery_failed" | "returned";

export const ONLINE_TRANSITIONS: Record<OnlineStatus, OnlineStatus[]> = {
  awaiting_payment: ["new", "cancelled"],
  new: ["confirmed", "cancelled"],
  confirmed: ["preparing", "cancelled"],
  preparing: ["shipping", "cancelled"],
  shipping: ["completed", "delivery_failed"],
  delivery_failed: ["confirmed", "returned"],
  completed: ["returned"],
  cancelled: [],
  returned: [],
};

export const CUSTOMER_LABEL: Record<OnlineStatus, string> = {
  awaiting_payment: "Chờ thanh toán",
  new: "Chờ xác nhận",
  confirmed: "Đã xác nhận",
  preparing: "Đang chuẩn bị",
  shipping: "Đang giao",
  completed: "Hoàn tất",
  cancelled: "Đã huỷ",
  delivery_failed: "Giao không thành công",
  returned: "Đã trả hàng",
};

export function assertTransition(from: string, to: OnlineStatus) {
  const allowed = ONLINE_TRANSITIONS[from as OnlineStatus];
  if (!allowed || !allowed.includes(to)) {
    throw new AppError(409, "invalid_transition", `Không thể chuyển đơn từ "${CUSTOMER_LABEL[from as OnlineStatus] ?? from}" sang "${CUSTOMER_LABEL[to]}"`, { from, to });
  }
}

export interface Actor {
  type: "customer" | "staff" | "system";
  id?: number | null;
}

/**
 * Statements đổi trạng thái + ghi order_events, có điều kiện `status = from` để chống hai người đổi cùng lúc:
 * nếu trạng thái đã bị đổi, UPDATE không khớp dòng nào và INSERT sự kiện dùng SELECT ... WHERE changes() — xem guard bên dưới.
 * Gộp vào cùng batch với các tác động khác (giữ/nhả tồn, thanh toán, audit).
 */
export function transitionStmts(
  db: D1Database,
  orderId: number,
  from: string,
  to: OnlineStatus,
  actor: Actor,
  opts: { note?: string; internalNote?: string; extraSet?: string; extraBinds?: unknown[] } = {},
): D1PreparedStatement[] {
  assertTransition(from, to);
  const completed = to === "completed" ? `, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')` : "";
  return [
    // Chốt chặn đồng thời: nếu trạng thái hiện tại ≠ from thì chèn vào bảng guard bị lỗi CHECK → cả batch rollback.
    db
      .prepare(`INSERT INTO order_transition_guard(order_id, ok) SELECT ?1, CASE WHEN status = ?2 THEN 1 ELSE 0 END FROM orders WHERE id = ?1`)
      .bind(orderId, from),
    db
      .prepare(`UPDATE orders SET status = ?1${completed}${opts.extraSet ? ", " + opts.extraSet : ""} WHERE id = ?2`)
      .bind(to, orderId, ...(opts.extraBinds ?? [])),
    db
      .prepare(`INSERT INTO order_events(order_id, status, note, internal_note, actor_type, actor_id) VALUES (?,?,?,?,?,?)`)
      .bind(orderId, to, opts.note ?? null, opts.internalNote ?? null, actor.type, actor.id ?? null),
    db.prepare(`DELETE FROM order_transition_guard WHERE order_id = ?`).bind(orderId),
  ];
}

/** Sinh tracking token ngẫu nhiên (base64url, 24 byte) cho link tra cứu đơn của khách. */
export function newTrackingToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Bỏ dấu tiếng Việt + thường hoá để so khớp quận/huyện với delivery_zones. */
export function normalizeVi(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replaceAll("đ", "d")
    .replaceAll("Đ", "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
