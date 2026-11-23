import type { Env } from "../env";

/** M9-23 cảnh báo chấm công (chưa vào ca, quên ra ca cuối ngày, bất thường). Gọi từ cron "*\/30". Agent HR hiện thực. */
export async function hrAttendanceAlerts(_env: Env, _now = new Date()): Promise<void> {}
