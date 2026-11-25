import type { Env } from "./env";
import { backupToR2 } from "./services/backup";
import { enqueueDebtReminders, sweepJobs } from "./services/jobs";
import { cancelExpiredAwaitingPayment } from "./services/online-payments";
import { swapBadReservationsAllStores } from "./services/reservations";
import { hrAttendanceAlerts } from "./services/hr-cron";
import { runDueCompetitorCrawls } from "./services/competitor-cron";
import { generateRecurringOrders } from "./services/recurring-cron";
import { cleanupGuardsStmt } from "./services/guard";
import { sweepStaleDrafts } from "./services/online-ops";
import { reconcileSepay } from "./services/sepay-reconcile";
import { cancelStaleCodOrders } from "../shop/worker/lib/cod-expiry";

/** Chạy một bước cron độc lập: lỗi một bước không chặn bước khác. */
async function step(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: `cron_${name}`, err: String((e as Error)?.message).slice(0, 200) }));
  }
}

/**
 * Cron Triggers (wrangler.jsonc → triggers.crons):
 *  - "0 17 * * *"  (00:00 giờ VN): đánh dấu lô hết hạn, đổi lô giữ tồn xấu (A-17), sao lưu logic ra R2.
 *  - "*\/30 * * * *": dọn phiên hết hạn.
 *  - "*\/5 * * * *": quét job tích hợp đến hạn (sweepJobs).
 *  - "0 1 * * *" (08:00 VN): đổi lô giữ tồn xấu (EC-15), sinh đơn lặp, nhắc nợ.
 * D1 Time Travel đã cho khôi phục điểm thời gian 30 ngày; bản xuất R2 là lớp sao lưu thứ hai (yêu cầu chung mục 12).
 */
export async function runScheduled(event: ScheduledController, env: Env) {
  const now = new Date().toISOString();
  if (event.cron === "*/30 * * * *") {
    await step("sessions", () => env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL`).bind(now).run());
    await step("guards", () => cleanupGuardsStmt(env.DB).run());
    await step("stale_drafts", () => sweepStaleDrafts(env.DB)); // audit #16: đơn nháp mồ côi chặn đồng bộ offline
    await step("stale_cod", () => cancelStaleCodOrders(env)); // audit: đơn COD khách vãng lai chưa xác nhận quá hạn → nhả tồn
    await step("hr_alerts", () => hrAttendanceAlerts(env)); // Đợt 4 — M9-23
    await step("sepay_reconcile", () => reconcileSepay(env)); // chỉ chạy khi có SEPAY_API_KEY
    await step("competitor_crawl", () => runDueCompetitorCrawls(env)); // Đợt 4 — M7
    return;
  }
  if (event.cron === "*/5 * * * *") {
    await sweepJobs(env);
    try {
      await cancelExpiredAwaitingPayment(env); // EC-05: huỷ đơn online chờ chuyển khoản quá hạn
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "cancel_expired_online", err: String((e as Error)?.message).slice(0, 200) }));
    }
    return;
  }
  if (event.cron === "0 1 * * *") {
    await dailyMorning(env);
    return;
  }
  // Hằng ngày (00:00 giờ VN)
  await env.DB.prepare(
    `UPDATE lots SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
  )
    .bind(now)
    .run();
  // A-17: lô vừa hết hạn đang giữ cho đơn → đổi sang lô tốt NGAY (không đợi 08:00 — giao buổi sáng sớm không xuất lô quá hạn)
  await step("swap_expired_reservations", () => swapBadReservationsAllStores(env.DB));
  await step("backup", () => backupToR2(env)); // C-06: lỗi sao lưu được ghi log, không chặn bước khác
}

/** 08:00 giờ VN. Mỗi bước độc lập: lỗi một bước không chặn bước sau. */
async function dailyMorning(env: Env) {
  try {
    const r = await swapBadReservationsAllStores(env.DB); // EC-15, mọi cửa hàng
    // Từng đơn thiếu đã được ghi audit + thông báo ngay trong swapBadReservations
    void r;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "swap_bad_reservations", err: String((e as Error)?.message).slice(0, 200) }));
  }
  await step("recurring_orders", () => generateRecurringOrders(env)); // M4-08 (Đợt 4)
  try {
    await enqueueDebtReminders(env); // M5-06
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "enqueue_debt_reminders", err: String((e as Error)?.message).slice(0, 200) }));
  }
}
