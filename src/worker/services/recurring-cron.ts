import type { Context } from "hono";
import type { AppBindings, Env, SessionUser } from "../env";
import { AppError } from "../lib/errors";
import { vnDate } from "../lib/time";
import { confirmOrderFlow, createB2bOrder, type Ctx } from "./b2b-orders";
import { getSettingInt } from "./settings";

/** Cộng ngày cho chuỗi YYYY-MM-DD. */
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
/** 1 = Thứ 2 … 7 = Chủ nhật (khớp recurring_orders.weekdays). */
const isoWeekday = (d: string) => new Date(d + "T00:00:00Z").getUTCDay() || 7;

/** Ngữ cảnh "người dùng hệ thống" cho dịch vụ đơn sỉ (cùng cách src/shop/worker/routes/b2b.ts). Vai trò manager: KHÔNG có b2b.credit_override. */
function systemCtx(env: Env, user: SessionUser): Ctx {
  const vars: Record<string, unknown> = { user, requestId: "cron-recurring" };
  return { env, get: (k: string) => vars[k], req: { header: () => undefined } } as unknown as Context<AppBindings>;
}

/**
 * M4-08 tự sinh đơn sỉ lặp cho ngày mai (setting recurring.auto_generate). Gọi từ cron "0 1 * * *" (08:00 giờ VN).
 * Mẫu active có weekday của NGÀY MAI và last_generated_for ≠ ngày mai → createB2bOrder + confirmOrderFlow.
 * Idempotent: clientUuid `recurring:<id>:<date>` + last_generated_for. Bị chặn hạn mức / thiếu tồn → đơn vẫn ở `new` kèm approval như bình thường.
 */
export async function generateRecurringOrders(env: Env, now = new Date()): Promise<void> {
  const db = env.DB;
  if ((await getSettingInt(db, "recurring.auto_generate", 1)) !== 1) return;
  const tomorrow = addDays(vnDate(now), 1);
  const wd = isoWeekday(tomorrow);
  const sys = await db.prepare(`SELECT id, username, full_name, store_id FROM users WHERE active = 1 ORDER BY (role = 'owner') DESC, id LIMIT 1`).first<any>();
  if (!sys) return;
  const user: SessionUser = { id: sys.id, username: "system", fullName: "Đơn lặp (hệ thống)", role: "manager", storeId: sys.store_id ?? null, sessionId: "recurring-system", deviceId: null };
  const ctx = systemCtx(env, user);

  const templates = (
    await db
      .prepare(`SELECT * FROM recurring_orders WHERE active = 1 AND (last_generated_for IS NULL OR last_generated_for <> ?) ORDER BY id`)
      .bind(tomorrow)
      .all<any>()
  ).results.filter((t) => String(t.weekdays).split(",").map((x) => Number(x.trim())).includes(wd));

  for (const t of templates) {
    try {
      let addressId: number | null = t.address_id;
      if (!addressId) {
        addressId = (await db.prepare(`SELECT id FROM customer_addresses WHERE customer_id = ? AND active = 1 ORDER BY is_default DESC, id LIMIT 1`).bind(t.customer_id).first<{ id: number }>())?.id ?? null;
      }
      if (!addressId) throw new AppError(422, "address_not_found", "Mẫu đơn lặp chưa có địa chỉ giao");
      const lines = (JSON.parse(t.lines_json) as { productId: number; unit: string; qty: number }[]).map((l) => ({ productId: l.productId, unit: l.unit, qty: l.qty }));
      const res = await createB2bOrder(ctx, {
        customerId: t.customer_id, addressId, deliveryDate: tomorrow, lines,
        clientUuid: `recurring:${t.id}:${tomorrow}`, recurringTemplateId: t.id, note: `Đơn lặp tự động ngày ${tomorrow}`,
      });
      // đã có đơn cho ngày mai → coi như xong (đánh dấu ngay để lần chạy sau không sinh lại)
      await db.prepare(`UPDATE recurring_orders SET last_generated_for = ? WHERE id = ?`).bind(tomorrow, t.id).run();
      const st = (await db.prepare(`SELECT status FROM orders WHERE id = ?`).bind(res.orderId).first<{ status: string }>())?.status;
      if (st === "new") {
        try {
          await confirmOrderFlow(ctx, res.orderId); // 409 credit_blocked / insufficient_stock: để đơn `new` (approval đã được tạo)
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          console.error(JSON.stringify({ level: "warn", msg: "recurring_confirm_blocked", template: t.id, code: e.code }));
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "recurring_order_failed", template: t.id, err: String((e as Error)?.message).slice(0, 200) }));
    }
  }
}
