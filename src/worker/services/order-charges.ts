/**
 * POS-KV đợt B2 — thu khác trên hoá đơn (phí đóng gói, phí giỏ quà, phí giao hàng...).
 * Cộng vào tổng đơn (orders.charges_total), KHÔNG áp khuyến mãi / voucher / điểm, không tích điểm. Báo cáo tách riêng dòng "Thu khác".
 */
import { z } from "zod";
import type { Role } from "../env";
import { AppError, forbidden } from "../lib/errors";
import { can } from "../lib/rbac";

export const MAX_CHARGES = 10;

export const chargeInputSchema = z.object({
  chargeTypeId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  amount: z.number().int().positive().max(100_000_000),
});
export type ChargeInput = z.infer<typeof chargeInputSchema>;
export type ResolvedCharge = { chargeTypeId: number | null; name: string; amount: number };

/**
 * Kiểm và chuẩn hoá các khoản thu khác.
 *  - Loại có sẵn (chargeTypeId): phải còn hoạt động; số tiền khác mặc định (khi mặc định > 0) cần quyền `pos.other_charge`.
 *  - Nhập tay (không có chargeTypeId): cần quyền `pos.other_charge` và phải có tên.
 */
export async function resolveCharges(db: D1Database, role: Role, input: ChargeInput[] | undefined): Promise<ResolvedCharge[]> {
  const out: ResolvedCharge[] = [];
  for (const ch of input ?? []) {
    if (ch.chargeTypeId) {
      const t = await db.prepare(`SELECT id, name, default_amount, active FROM charge_types WHERE id = ?`).bind(ch.chargeTypeId).first<{ id: number; name: string; default_amount: number; active: number }>();
      if (!t || !t.active) throw new AppError(422, "charge_type_not_found", "Loại thu khác không tồn tại hoặc đã ngừng", { chargeTypeId: ch.chargeTypeId });
      if (t.default_amount > 0 && ch.amount !== t.default_amount && !can(role, "pos.other_charge")) throw forbidden("forbidden", "Sửa số tiền thu khác cần quyền quản lý");
      out.push({ chargeTypeId: t.id, name: t.name, amount: ch.amount });
    } else {
      if (!can(role, "pos.other_charge")) throw forbidden("forbidden", "Nhập tay khoản thu khác cần quyền quản lý");
      if (!ch.name) throw new AppError(422, "charge_name_required", "Khoản thu khác nhập tay cần có tên");
      out.push({ chargeTypeId: null, name: ch.name, amount: ch.amount });
    }
  }
  return out;
}

/** Câu lệnh ghi các dòng thu khác của đơn (đơn nhận id sau khi tạo nháp). */
export function chargeStmts(db: D1Database, orderId: number, charges: ResolvedCharge[]) {
  return charges.map((ch) =>
    db.prepare(`INSERT INTO order_charges(order_id, charge_type_id, name, amount) VALUES (?,?,?,?)`).bind(orderId, ch.chargeTypeId, ch.name, ch.amount),
  );
}
