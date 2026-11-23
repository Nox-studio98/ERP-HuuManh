import type { Env } from "../env";

/** M4-08 tự sinh đơn sỉ lặp cho ngày mai (setting recurring.auto_generate). Gọi từ cron "0 1 * * *". Agent D hiện thực. */
export async function generateRecurringOrders(_env: Env, _now = new Date()): Promise<void> {}
