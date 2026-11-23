import type { Env } from "../env";
import { can } from "../lib/rbac";
import type { Role } from "../env";
import { vnDate, vnDayRangeUtc } from "../lib/time";
import { addDays } from "./hr-common";
import { pushConfigured, sendWebPush } from "./webpush";

const LATE_AFTER_MIN = 15;
const FAR_FACTOR = 3;

interface Alert { kind: string; entity: string; entityId: string; message: string; data: Record<string, unknown> }

async function recordAlert(env: Env, a: Alert): Promise<boolean> {
  const dup = await env.DB
    .prepare(`SELECT 1 x FROM audit_log WHERE action='hr.alert' AND entity=? AND entity_id=? AND json_extract(after_json,'$.kind')=? LIMIT 1`)
    .bind(a.entity, a.entityId, a.kind)
    .first();
  if (dup) return false; // idempotent: không báo lại cùng ca/loại
  await env.DB
    .prepare(`INSERT INTO audit_log(user_id, action, entity, entity_id, after_json, reason) VALUES (NULL,'hr.alert',?,?,?,?)`)
    .bind(a.entity, a.entityId, JSON.stringify({ kind: a.kind, ...a.data }), a.message)
    .run();
  return true;
}

async function pushToSchedulers(env: Env, alerts: Alert[]) {
  if (!alerts.length || !pushConfigured(env)) return;
  const { results } = await env.DB
    .prepare(`SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, u.role FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE u.active = 1`)
    .all<{ id: number; endpoint: string; p256dh: string; auth: string; role: Role }>();
  const subs = results.filter((s) => can(s.role, "hr.schedule"));
  for (const s of subs) {
    try {
      const r = await sendWebPush(env, s, { title: "Cảnh báo chấm công", body: alerts.length === 1 ? alerts[0].message : `${alerts.length} cảnh báo chấm công mới`, url: "/hr/attendance", tag: "hr-alert" });
      if (!r.ok && r.gone) await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id=?`).bind(s.id).run();
    } catch { /* push lỗi không chặn cron */ }
  }
}

/**
 * M9-23 cảnh báo chấm công (cron "*\/30"). Ghi audit_log action `hr.alert` (idempotent theo entity+kind) + push cho người có hr.schedule:
 *  - late_no_checkin: quá 15' sau giờ vào ca mà chưa chấm vào (trừ NV đang nghỉ phép đã duyệt);
 *  - open_in_2300: từ 23:00 VN còn 'vào' chưa 'ra' (trừ ca qua đêm chưa kết thúc);
 *  - multi_device: một NV chấm bằng ≥ 2 thiết bị trong ngày;
 *  - far_punch: punch cách cửa hàng > 3× bán kính cho phép (offline/chờ duyệt).
 */
export async function hrAttendanceAlerts(env: Env, now = new Date()): Promise<void> {
  const db = env.DB;
  const nowIso = now.toISOString();
  const today = vnDate(now);
  const fresh: Alert[] = [];
  const add = async (a: Alert) => { if (await recordAlert(env, a)) fresh.push(a); };

  // 1) quá giờ vào ca chưa chấm
  const lateBefore = new Date(now.getTime() - LATE_AFTER_MIN * 60_000).toISOString();
  const lateAfter = new Date(now.getTime() - 6 * 3600_000).toISOString();
  const { results: late } = await db
    .prepare(
      `SELECT sa.id, sa.employee_id, sa.work_date, sa.start_at, e.full_name FROM shift_assignments sa JOIN employees e ON e.id = sa.employee_id
        WHERE sa.status='scheduled' AND e.status='active' AND sa.start_at <= ?1 AND sa.start_at >= ?2 AND sa.end_at > ?3
          AND NOT EXISTS (SELECT 1 FROM attendance_punches p WHERE p.employee_id = sa.employee_id AND p.kind='in' AND p.status != 'rejected'
                            AND p.server_at >= strftime('%Y-%m-%dT%H:%M:%fZ', sa.start_at, '-2 hours') AND p.server_at <= ?3)
          AND NOT EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.employee_id = sa.employee_id AND lr.status='approved' AND lr.from_date <= sa.work_date AND lr.to_date >= sa.work_date)`,
    )
    .bind(lateBefore, lateAfter, nowIso)
    .all<{ id: number; employee_id: number; work_date: string; start_at: string; full_name: string }>();
  for (const r of late) {
    await add({ kind: "late_no_checkin", entity: "shift_assignment", entityId: String(r.id), message: `${r.full_name} chưa chấm vào ca ${r.work_date}`, data: { employeeId: r.employee_id, workDate: r.work_date, startAt: r.start_at } });
  }

  // 2) từ 23:00 VN còn vào chưa ra
  const vnHour = new Date(now.getTime() + 7 * 3600_000).getUTCHours();
  if (vnHour >= 23) {
    const day = vnDayRangeUtc(today);
    const { results } = await db
      .prepare(
        `SELECT p.id, p.employee_id, e.full_name FROM attendance_punches p JOIN employees e ON e.id = p.employee_id
          WHERE p.kind='in' AND p.status != 'rejected' AND p.server_at >= ?1 AND p.server_at < ?2
            AND NOT EXISTS (SELECT 1 FROM attendance_punches o WHERE o.employee_id = p.employee_id AND o.kind='out' AND o.status != 'rejected' AND o.server_at > p.server_at)
            AND NOT EXISTS (SELECT 1 FROM shift_assignments sa WHERE sa.id = p.assignment_id AND sa.end_at > ?3)`,
      )
      .bind(day.from, day.to, nowIso)
      .all<{ id: number; employee_id: number; full_name: string }>();
    for (const r of results) {
      await add({ kind: "open_in_2300", entity: "attendance_punch", entityId: String(r.id), message: `${r.full_name} còn đang vào ca lúc 23:00, chưa chấm ra`, data: { employeeId: r.employee_id } });
    }
  }

  // 3) bất thường: nhiều thiết bị trong ngày
  const day = vnDayRangeUtc(today);
  const { results: multi } = await db
    .prepare(
      `SELECT p.employee_id, e.full_name, COUNT(DISTINCT p.device_id) n FROM attendance_punches p JOIN employees e ON e.id = p.employee_id
        WHERE p.server_at >= ? AND p.server_at < ? AND p.device_id IS NOT NULL GROUP BY p.employee_id HAVING n >= 2`,
    )
    .bind(day.from, day.to)
    .all<{ employee_id: number; full_name: string; n: number }>();
  for (const r of multi) {
    await add({ kind: "multi_device", entity: "attendance_anomaly", entityId: `${r.employee_id}:${today}`, message: `${r.full_name} chấm công bằng ${r.n} thiết bị trong ngày`, data: { employeeId: r.employee_id, workDate: today, devices: r.n } });
  }

  // 4) bất thường: khoảng cách lớn
  const since = vnDayRangeUtc(addDays(today, -1)).from;
  const { results: far } = await db
    .prepare(
      `SELECT p.id, p.employee_id, p.distance_m, s.geofence_m, e.full_name FROM attendance_punches p
         JOIN employees e ON e.id = p.employee_id JOIN stores s ON s.id = e.store_id
        WHERE p.server_at >= ? AND p.distance_m IS NOT NULL AND p.distance_m > COALESCE(s.geofence_m, 100) * ?`,
    )
    .bind(since, FAR_FACTOR)
    .all<{ id: number; employee_id: number; distance_m: number; geofence_m: number; full_name: string }>();
  for (const r of far) {
    await add({ kind: "far_punch", entity: "attendance_punch", entityId: String(r.id), message: `${r.full_name} chấm công cách cửa hàng ${r.distance_m} m`, data: { employeeId: r.employee_id, distanceM: r.distance_m } });
  }

  await pushToSchedulers(env, fresh);
}
