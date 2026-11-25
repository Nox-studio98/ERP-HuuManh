import type { Env, Role } from "../env";
import { can, type Permission } from "../lib/rbac";
import { getApprovalHandler } from "./approval-registry";
import { pushAll, type Sub } from "./notify";

/**
 * C-27: thông báo cho người duyệt + báo lại người yêu cầu.
 * Điểm gom chung: trigger DB (migrations/0027) ghi job `notify.approval` (outbox) trong CÙNG giao dịch với mọi yêu cầu duyệt
 * (bảng approvals và các bảng yêu cầu nhân sự). Hàm này chạy ở worker/queue: tạo một dòng `notifications` cho TỪNG người nhận
 * (target_user_id → đọc/chưa đọc riêng, lọc theo đúng người) và gửi Web Push nếu người đó đã đăng ký.
 * Nội dung chỉ gồm loại yêu cầu, tên người yêu cầu/nhân viên và ngày — KHÔNG có số tiền, lương, giá vốn.
 */

type Group = "finance" | "sales" | "stock" | "hr" | "other";
export const APPROVAL_GROUPS: Group[] = ["finance", "sales", "stock", "hr", "other"];

interface TypeInfo { label: string; group: Group; perm: Permission }
/** Loại approvals đã biết. Quyền ưu tiên lấy từ approval-registry (nếu module đã đăng ký), nếu không dùng cột perm ở đây. */
const APPROVAL_TYPES: Record<string, TypeInfo> = {
  "cash_voucher.post": { label: "Phiếu chi", group: "finance", perm: "finance.approve" },
  "debt_payment.post": { label: "Phiếu chi công nợ", group: "finance", perm: "finance.approve" },
  "debt_adjustment.post": { label: "Xoá nợ / chiết khấu công nợ", group: "finance", perm: "debt.approve" },
  "order.below_cost": { label: "Bán dưới giá vốn", group: "sales", perm: "approvals.decide" },
  "order.discount": { label: "Giảm giá đơn hàng", group: "sales", perm: "approvals.decide" },
  "order.return": { label: "Trả hàng tại quầy", group: "sales", perm: "approvals.decide" },
  "order.credit_override": { label: "Vượt hạn mức nợ", group: "sales", perm: "b2b.credit_override" },
  "customer.credit_change": { label: "Đổi hạn mức nợ khách", group: "sales", perm: "b2b.credit_override" },
  "quote.approve": { label: "Báo giá", group: "sales", perm: "b2b.approve" },
  "shop.b2b_link": { label: "Liên kết khách sỉ", group: "sales", perm: "b2b.approve" },
  "price.activate": { label: "Bảng giá", group: "sales", perm: "prices.approve" },
  "promotion.activate": { label: "Khuyến mãi", group: "sales", perm: "promotions.approve" },
  "preorder.forfeit": { label: "Giữ cọc đặt trước", group: "sales", perm: "approvals.decide" },
  "stock_doc.post": { label: "Phiếu kho / kiểm kê lệch", group: "stock", perm: "inventory.approve" },
  "purchase_return.post": { label: "Trả hàng nhà cung cấp", group: "stock", perm: "inventory.approve" },
};

const HR_LABEL: Record<string, string> = {
  leave_requests: "Đơn nghỉ phép",
  shift_swap_requests: "Đổi ca",
  attendance_corrections: "Bổ sung công",
  overtime_requests: "Tăng ca",
  devices_registry_requests: "Đổi thiết bị chấm công",
  attendance_punches: "Chấm công offline",
};

interface Plan {
  recipients: number[];
  kind: string;
  title: string;
  body: string;
  url: string;
  group: Group;
}

const fmtDay = (ymd: string | null | undefined) => (ymd && /^\d{4}-\d{2}-\d{2}/.test(ymd) ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}` : ymd ?? "");
const vnHm = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(11, 16);
const clip = (s: string | null | undefined, n = 120) => (s ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : "");

interface U { id: number; role: Role; full_name: string }

async function activeUsers(env: Env): Promise<U[]> {
  return (await env.DB.prepare(`SELECT id, role, full_name FROM users WHERE active = 1`).all<U>()).results;
}
const approvers = (users: U[], perms: Permission[], exclude: (number | null | undefined)[]) =>
  users.filter((u) => perms.every((p) => can(u.role, p)) && !exclude.includes(u.id)).map((u) => u.id);
const uniq = (a: (number | null | undefined)[]) => [...new Set(a.filter((x): x is number => x != null))];

async function planApproval(env: Env, id: number, phase: string, users: U[]): Promise<Plan | null> {
  const a = await env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<any>();
  if (!a) return null;
  const info = APPROVAL_TYPES[a.type];
  const handler = getApprovalHandler(a.type);
  const perm = (handler?.perm ?? info?.perm ?? "approvals.decide") as Permission;
  const label = info?.label ?? "Yêu cầu duyệt";
  const group = info?.group ?? "other";
  const name = (uid: number | null) => users.find((u) => u.id === uid)?.full_name ?? "Nhân viên";
  if (phase === "decided") {
    if (a.status !== "approved" && a.status !== "rejected") return null;
    const ok = a.status === "approved";
    return {
      recipients: a.requested_by === a.decided_by ? [] : [a.requested_by],
      kind: "approval_decided", group, url: "/approvals",
      title: `${label}: ${ok ? "đã được duyệt" : "bị từ chối"}`,
      body: `${name(a.decided_by)} đã ${ok ? "duyệt" : "từ chối"} yêu cầu của bạn.${a.decision_note ? ` Ghi chú: ${clip(a.decision_note)}` : ""}`,
    };
  }
  if (a.status !== "pending") return null;
  return {
    recipients: approvers(users, [...new Set<Permission>(["approvals.decide", perm])], [a.requested_by]),
    kind: "approval_requested", group, url: "/approvals",
    title: `${label} chờ duyệt`,
    body: `${name(a.requested_by)} gửi yêu cầu. Mở màn Duyệt để xem chi tiết.`,
  };
}

async function planHr(env: Env, table: string, id: number, phase: string, users: U[]): Promise<Plan | null> {
  const db = env.DB;
  const label = HR_LABEL[table];
  const userOfEmp = async (empId: number | null | undefined) =>
    empId == null ? null : (await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(empId).first<{ user_id: number | null }>())?.user_id ?? null;
  const empName = async (empId: number) => (await db.prepare(`SELECT full_name FROM employees WHERE id = ?`).bind(empId).first<{ full_name: string }>())?.full_name ?? "Nhân viên";
  const mgr = (exclude: (number | null)[]) => approvers(users, ["hr.schedule"], exclude);
  const nameOf = (uid: number | null) => users.find((u) => u.id === uid)?.full_name ?? "Quản lý";
  const base = { group: "hr" as Group };

  if (table === "leave_requests") {
    const r = await db.prepare(`SELECT r.*, lt.name AS type_name FROM leave_requests r JOIN leave_types lt ON lt.id = r.leave_type_id WHERE r.id = ?`).bind(id).first<any>();
    if (!r) return null;
    const who = await empName(r.employee_id);
    const range = r.from_date === r.to_date ? fmtDay(r.from_date) : `${fmtDay(r.from_date)}–${fmtDay(r.to_date)}`;
    const selfUser = await userOfEmp(r.employee_id);
    if (phase === "decided") {
      const ok = r.status === "approved";
      return { ...base, recipients: uniq([r.requested_by, selfUser]).filter((u) => u !== r.decided_by), kind: "approval_decided", url: "/me",
        title: `Đơn nghỉ phép ${range}: ${ok ? "đã được duyệt" : "bị từ chối"}`, body: `${nameOf(r.decided_by)} đã ${ok ? "duyệt" : "từ chối"} đơn nghỉ ${r.type_name}.` };
    }
    return { ...base, recipients: mgr([r.requested_by, selfUser]), kind: "approval_requested", url: "/hr/attendance",
      title: "Đơn nghỉ phép chờ duyệt", body: `${who} xin nghỉ ${r.type_name} ${range}${r.over_balance ? " (vượt số ngày còn lại)" : ""}.` };
  }

  if (table === "shift_swap_requests") {
    const s = await db.prepare(
      `SELECT s.*, fa.employee_id AS from_emp, fa.work_date AS from_date FROM shift_swap_requests s JOIN shift_assignments fa ON fa.id = s.from_assignment_id WHERE s.id = ?`,
    ).bind(id).first<any>();
    if (!s) return null;
    const [fromName, toName, toUser] = [await empName(s.from_emp), await empName(s.to_employee_id), await userOfEmp(s.to_employee_id)];
    if (phase === "asked") {
      return { ...base, recipients: toUser ? [toUser] : [], kind: "approval_asked", url: "/me", title: "Có người nhờ bạn đổi ca", body: `${fromName} muốn đổi ca ngày ${fmtDay(s.from_date)} với bạn. Mở Chấm công để đồng ý hoặc bỏ qua.` };
    }
    if (phase === "decided") {
      const ok = s.status === "approved";
      return { ...base, recipients: uniq([s.requested_by, toUser]).filter((u) => u !== s.decided_by), kind: "approval_decided", url: "/me",
        title: `Đổi ca ngày ${fmtDay(s.from_date)}: ${ok ? "đã được duyệt" : "bị từ chối"}`, body: `${nameOf(s.decided_by)} đã ${ok ? "duyệt" : "từ chối"} đổi ca giữa ${fromName} và ${toName}.` };
    }
    return { ...base, recipients: mgr([s.requested_by, toUser, await userOfEmp(s.from_emp)]), kind: "approval_requested", url: "/hr/attendance", title: "Đổi ca chờ duyệt", body: `${fromName} đổi ca ngày ${fmtDay(s.from_date)} cho ${toName} (hai bên đã đồng ý).` };
  }

  if (table === "attendance_corrections" || table === "overtime_requests") {
    const r = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<any>();
    if (!r) return null;
    const who = await empName(r.employee_id);
    const selfUser = await userOfEmp(r.employee_id);
    const what = table === "overtime_requests" ? "tăng ca" : "bổ sung công";
    if (phase === "decided") {
      const ok = r.status === "approved";
      return { ...base, recipients: uniq([r.requested_by, selfUser]).filter((u) => u !== r.decided_by), kind: "approval_decided", url: "/me",
        title: `Yêu cầu ${what} ngày ${fmtDay(r.work_date)}: ${ok ? "đã được duyệt" : "bị từ chối"}`, body: `${nameOf(r.decided_by)} đã ${ok ? "duyệt" : "từ chối"} yêu cầu ${what} của bạn.${r.decision_note ? ` Ghi chú: ${clip(r.decision_note)}` : ""}` };
    }
    return { ...base, recipients: mgr([r.requested_by, selfUser]), kind: "approval_requested", url: "/hr/attendance",
      title: `${table === "overtime_requests" ? "Tăng ca" : "Bổ sung công"} chờ duyệt`,
      body: `${who} — ngày ${fmtDay(r.work_date)}${table === "overtime_requests" ? `, ${r.minutes} phút` : ""}.` };
  }

  if (table === "devices_registry_requests") {
    const r = await db.prepare(`SELECT * FROM devices_registry_requests WHERE id = ?`).bind(id).first<any>();
    if (!r) return null;
    if (phase === "decided") {
      const ok = r.status === "approved";
      return { ...base, recipients: [r.user_id].filter((u) => u !== r.decided_by), kind: "approval_decided", url: "/me",
        title: `Đổi thiết bị chấm công: ${ok ? "đã được duyệt" : "bị từ chối"}`, body: `${nameOf(r.decided_by)} đã ${ok ? "duyệt" : "từ chối"} thiết bị mới của bạn.` };
    }
    return { ...base, recipients: mgr([r.user_id]), kind: "approval_requested", url: "/hr/attendance", title: "Đổi thiết bị chấm công chờ duyệt", body: `${nameOf(r.user_id)} đăng ký thiết bị mới.` };
  }

  if (table === "attendance_punches") {
    const p = await db.prepare(`SELECT * FROM attendance_punches WHERE id = ?`).bind(id).first<any>();
    if (!p) return null;
    const selfUser = await userOfEmp(p.employee_id);
    const when = `${fmtDay(new Date(Date.parse(p.server_at) + 7 * 3600_000).toISOString().slice(0, 10))} ${vnHm(p.server_at)}`;
    const kindVi = p.kind === "in" ? "vào ca" : "ra ca";
    if (phase === "decided") {
      const ok = p.status === "accepted";
      return { ...base, recipients: [selfUser].filter((u): u is number => u != null && u !== p.decided_by), kind: "approval_decided", url: "/me",
        title: `Chấm công offline ${when}: ${ok ? "đã được xác nhận" : "bị từ chối"}`, body: `${nameOf(p.decided_by)} đã ${ok ? "xác nhận" : "từ chối"} lần chấm ${kindVi} của bạn.` };
    }
    return { ...base, recipients: mgr([selfUser, p.created_by]), kind: "approval_requested", url: "/hr/attendance", title: "Chấm công offline chờ duyệt", body: `${await empName(p.employee_id)} chấm ${kindVi} lúc ${when} khi mất mạng.` };
  }
  return null;
}

async function setting(env: Env, key: string, def: string) {
  return (await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>())?.value ?? def;
}

/** Xử lý job notify.approval: ref_type = bảng nguồn, ref_id = id dòng, payload.phase = requested | decided | asked. */
export async function notifyApproval(env: Env, job: { ref_type: string | null; ref_id: number | null; payload_json: string }) {
  if (!job.ref_type || !job.ref_id) throw new Error("Job thông báo duyệt thiếu tham chiếu");
  if ((await setting(env, "notify.approval.enabled", "1")) !== "1") return { skipped: "disabled" };
  const phase = (JSON.parse(job.payload_json || "{}") as { phase?: string }).phase ?? "requested";
  const users = await activeUsers(env);
  const plan = job.ref_type === "approvals" ? await planApproval(env, job.ref_id, phase, users) : HR_LABEL[job.ref_type] ? await planHr(env, job.ref_type, job.ref_id, phase, users) : null;
  if (!plan) return { skipped: "no_plan" };
  const groups = (await setting(env, "notify.approval.groups", APPROVAL_GROUPS.join(","))).split(",");
  if (!groups.includes(plan.group)) return { skipped: `group_${plan.group}_off` };
  const active = new Set(users.map((u) => u.id));
  const recipients = plan.recipients.filter((id) => active.has(id));
  if (!recipients.length) return { recipients: 0 };

  // Idempotent khi job chạy lại: bỏ người đã có thông báo cùng (loại, nguồn, id)
  const have = new Set(
    (await env.DB.prepare(`SELECT target_user_id FROM notifications WHERE kind = ? AND ref_type = ? AND ref_id = ? AND target_user_id IS NOT NULL`).bind(plan.kind, job.ref_type, job.ref_id).all<{ target_user_id: number }>())
      .results.map((r) => r.target_user_id),
  );
  const fresh = recipients.filter((id) => !have.has(id));
  if (fresh.length) {
    await env.DB.batch(
      fresh.map((uid) =>
        env.DB
          .prepare(`INSERT INTO notifications(kind, title, body, audience_perm, ref_type, ref_id, target_user_id, url) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(plan.kind, plan.title, plan.body, "hr.self", job.ref_type, job.ref_id, uid, plan.url),
      ),
    );
  }
  let push: unknown = { skipped: "off" };
  if (fresh.length && (await setting(env, "notify.approval.push", "1")) === "1") {
    const ph = fresh.map(() => "?").join(",");
    const subs = (await env.DB.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${ph})`).bind(...fresh).all<Sub>()).results;
    push = subs.length ? await pushAll(env, subs, { title: plan.title, body: plan.body, url: plan.url, tag: `${job.ref_type}-${job.ref_id}` }) : { skipped: "no_subscription" };
  }
  return { recipients: fresh.length, push };
}

/** Đẩy các job notify.approval vừa phát sinh lên Queue (hoặc xử lý ngay nếu không có Queue). Gọi sau request ghi (waitUntil). */
export async function kickApprovalJobs(env: Env, processJob: (env: Env, id: number) => Promise<unknown>) {
  const { results } = await env.DB.prepare(`SELECT id FROM integration_jobs WHERE type = 'notify.approval' AND status = 'queued' AND next_run_at <= ? ORDER BY id LIMIT 30`).bind(new Date().toISOString()).all<{ id: number }>();
  if (!results.length) return 0;
  if (env.JOBS) {
    try {
      await env.JOBS.sendBatch(results.map((r) => ({ body: { jobId: r.id } })));
      return results.length;
    } catch { /* Queue lỗi → xử lý trực tiếp */ }
  }
  for (const r of results) await processJob(env, r.id);
  return results.length;
}
