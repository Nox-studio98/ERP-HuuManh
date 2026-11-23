import type { Env } from "../env";

/** M7-02/07 chạy thu thập giá các nguồn đến hạn (giới hạn số nguồn mỗi lần). Gọi từ cron "*\/30". Agent M7 hiện thực. */
export async function runDueCompetitorCrawls(_env: Env, _now = new Date()): Promise<void> {}
