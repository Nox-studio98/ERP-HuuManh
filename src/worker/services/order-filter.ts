import { AppError } from "../lib/errors";
import { vnDayRangeUtc } from "../lib/time";

/**
 * Bộ lọc danh sách đơn (GET /orders) dùng chung cho xuất file chi tiết dòng hàng.
 * Giữ ĐÚNG ngữ nghĩa của route /orders: ngày VN (day | from..to), kênh, trạng thái (mặc định bỏ nháp), ca, loại, thu ngân,
 * người bán, hình thức thanh toán, từ khoá (SĐT chỉ tìm được khi có quyền xem PII). Bảng: orders `o`, customers `cu`.
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: string, name: string) => {
  if (!DAY_RE.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))) throw new AppError(422, "validation_error", `${name} phải có dạng YYYY-MM-DD`);
  return v;
};

export function buildOrderFilter(q: Record<string, string>, pii: boolean) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.day) {
    const r = vnDayRangeUtc(validDay(q.day, "day"));
    conds.push(`o.created_at >= ? AND o.created_at < ?`);
    params.push(r.from, r.to);
  } else if (q.from || q.to) {
    const from = validDay(q.from ?? q.to!, "from"), to = validDay(q.to ?? q.from!, "to");
    if (to < from) throw new AppError(422, "validation_error", "to phải sau hoặc bằng from");
    if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 366) throw new AppError(422, "validation_error", "Khoảng ngày tối đa 366 ngày");
    conds.push(`o.created_at >= ? AND o.created_at < ?`);
    params.push(vnDayRangeUtc(from).from, vnDayRangeUtc(to).to);
  }
  if (q.channel) { conds.push(`o.channel = ?`); params.push(q.channel); }
  if (q.status) { conds.push(`o.status = ?`); params.push(q.status); } else conds.push(`o.status <> 'draft'`);
  if (q.shiftId) { conds.push(`o.shift_id = ?`); params.push(Number(q.shiftId)); }
  if (q.kind) { conds.push(`o.kind = ?`); params.push(q.kind); }
  if (q.cashierId) { conds.push(`o.created_by = ?`); params.push(Number(q.cashierId)); }
  if (q.sellerId) { conds.push(`COALESCE(o.seller_id, o.created_by) = ?`); params.push(Number(q.sellerId)); }
  if (q.method) { conds.push(`EXISTS (SELECT 1 FROM payments pm WHERE pm.order_id = o.id AND pm.method = ? AND pm.status = 'confirmed')`); params.push(q.method); }
  const term = q.q?.trim();
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    const parts = [
      `o.code LIKE ? ESCAPE '\\'`, `cu.name LIKE ? ESCAPE '\\'`, `o.receiver_name LIKE ? ESCAPE '\\'`, `o.note LIKE ? ESCAPE '\\'`,
      `EXISTS (SELECT 1 FROM order_lines ql JOIN products qp ON qp.id = ql.product_id WHERE ql.order_id = o.id AND (qp.name LIKE ? ESCAPE '\\' OR qp.sku LIKE ? ESCAPE '\\'))`,
    ];
    const ps: unknown[] = [like, like, like, like, like, like];
    if (pii) { parts.push(`cu.phone LIKE ? ESCAPE '\\'`, `o.receiver_phone LIKE ? ESCAPE '\\'`); ps.push(like, like); }
    conds.push(`(${parts.join(" OR ")})`);
    params.push(...ps);
  }
  return { where: conds.length ? "WHERE " + conds.join(" AND ") : "", params };
}
