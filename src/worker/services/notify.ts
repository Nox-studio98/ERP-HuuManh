import type { Env, Role } from "../env";
import { can } from "../lib/rbac";
import { CUSTOMER_LABEL, type OnlineStatus } from "./online-orders";
import { sendEmail } from "./notify-email";
import { pushConfigured, sendWebPush } from "./webpush";

/** Đường dẫn tra cứu đơn trên website (không chứa dữ liệu cá nhân ngoài token không đoán được). */
export const trackingPath = (token: string) => `/track/${token}`;

interface Sub { id: number; endpoint: string; p256dh: string; auth: string }

async function pushAll(env: Env, subs: Sub[], message: unknown) {
  let sent = 0, removed = 0, failed = 0;
  if (!pushConfigured(env)) return { sent, removed, failed, skipped: "no_vapid" as string | undefined };
  for (const s of subs) {
    try {
      const r = await sendWebPush(env, s, message);
      if (r.ok) {
        sent++;
        await env.DB.prepare(`UPDATE push_subscriptions SET last_error=NULL WHERE id=?`).bind(s.id).run();
      } else if (r.gone) {
        removed++;
        await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id=?`).bind(s.id).run();
      } else {
        failed++;
        await env.DB.prepare(`UPDATE push_subscriptions SET last_error=? WHERE id=?`).bind(`HTTP ${r.status}`, s.id).run();
      }
    } catch (e) {
      failed++;
      await env.DB.prepare(`UPDATE push_subscriptions SET last_error=? WHERE id=?`).bind(String((e as Error).message).slice(0, 100), s.id).run();
    }
  }
  return { sent, removed, failed, skipped: undefined as string | undefined };
}

/** notify.order_status: email + push cho khách. Nội dung chỉ gồm mã đơn, nhãn trạng thái và link tra cứu. */
export async function notifyOrderStatus(env: Env, orderId: number, payload: { status?: string; email?: string | null; event?: string; link?: string; accountId?: number | null; orderCode?: string }) {
  const o = await env.DB
    .prepare(`SELECT id, code, status, tracking_token, shop_account_id, customer_id FROM orders WHERE id=?`)
    .bind(orderId)
    .first<{ id: number; code: string; status: string; tracking_token: string | null; shop_account_id: number | null; customer_id: number | null }>();
  if (!o) throw new Error("Không tìm thấy đơn để thông báo");
  const status = (payload.status ?? o.status) as OnlineStatus;
  const label = payload.event === "weight_pending" ? "Cần xác nhận lại khối lượng" : CUSTOMER_LABEL[status] ?? status;
  const path = payload.link?.startsWith("/") && !payload.link.startsWith("//") ? payload.link : o.tracking_token ? trackingPath(o.tracking_token) : "/";
  const accountId = payload.accountId ?? o.shop_account_id;
  const title = `Đơn ${o.code}`;
  const out: Record<string, unknown> = {};

  let email = payload.email ?? null;
  if (!email && o.shop_account_id) email = (await env.DB.prepare(`SELECT email FROM shop_accounts WHERE id=?`).bind(o.shop_account_id).first<{ email: string }>())?.email ?? null;
  if (!email && o.customer_id) email = (await env.DB.prepare(`SELECT email FROM customers WHERE id=?`).bind(o.customer_id).first<{ email: string | null }>())?.email ?? null;
  if (email) {
    const base = (env.SHOP_BASE_URL ?? "").replace(/\/$/, "");
    const r = await sendEmail(env, {
      to: email,
      template: "order_status",
      subject: `${title} — ${label}`,
      text: `Đơn hàng ${o.code} của bạn: ${label}.\nTheo dõi đơn: ${base}${path}\n\nCảm ơn bạn đã mua hàng tại Hữu Mạnh.`,
      ref: { orderCode: o.code, status },
    });
    out.email = r.provider;
  } else out.email = "no_recipient";

  if (accountId) {
    const { results } = await env.DB.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE account_id=?`).bind(accountId).all<Sub>();
    out.push = await pushAll(env, results, { title, body: label, url: path, tag: o.code });
  }
  return out;
}

/** notify.staff_new_order: push cho nhân viên có quyền xử lý đơn online. */
export async function notifyStaffNewOrder(env: Env, orderId: number) {
  const o = await env.DB.prepare(`SELECT code FROM orders WHERE id=?`).bind(orderId).first<{ code: string }>();
  if (!o) throw new Error("Không tìm thấy đơn để thông báo");
  const { results } = await env.DB
    .prepare(
      `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, u.role FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id
        WHERE u.active = 1`,
    )
    .all<Sub & { role: Role }>();
  const staff = results.filter((r) => can(r.role, "orders.online.manage"));
  return { push: await pushAll(env, staff, { title: "Đơn online mới", body: o.code, url: "/online-orders", tag: o.code }) };
}

/** notify.email: xác minh email / đặt lại mật khẩu cho khách. Token chỉ nằm trong nội dung thư, không vào audit. */
export async function notifyEmail(env: Env, payload: { to?: string; template?: string; token?: string; link?: string }) {
  if (!payload.to || !payload.template) throw new Error("Job email thiếu người nhận hoặc mẫu");
  const base = (env.SHOP_BASE_URL ?? "").replace(/\/$/, "");
  const defaults: Record<string, { subject: string; line: string; path: string }> = {
    verify_email: { subject: "Xác minh email tài khoản Hữu Mạnh", line: "Nhấn vào liên kết để xác minh email", path: "/verify-email?token=" },
    reset_password: { subject: "Đặt lại mật khẩu Hữu Mạnh", line: "Nhấn vào liên kết để đặt lại mật khẩu (hết hạn sau ít phút)", path: "/reset-password?token=" },
  };
  const t = defaults[payload.template];
  if (!t) throw new Error(`Mẫu email không hỗ trợ: ${payload.template}`);
  let path = payload.link ?? (payload.token ? t.path + encodeURIComponent(payload.token) : "");
  if (path && !path.startsWith("/")) throw new Error("link phải là đường dẫn nội bộ");
  const r = await sendEmail(env, { to: payload.to, template: payload.template, subject: t.subject, text: `${t.line}:\n${base}${path}\n\nNếu bạn không yêu cầu, hãy bỏ qua thư này.` });
  return { provider: r.provider };
}

/** notify.managers: push cho người có quyền duyệt kho (quản lý/chủ) — cảnh báo thiếu hàng do lô hỏng (EC-15). */
export async function notifyManagers(env: Env, payload: { title?: string; body?: string; url?: string }) {
  const { results } = await env.DB
    .prepare(`SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, u.role FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE u.active = 1`)
    .all<Sub & { role: Role }>();
  const staff = results.filter((r) => can(r.role, "inventory.approve"));
  const url = payload.url?.startsWith("/") && !payload.url.startsWith("//") ? payload.url : "/";
  return { push: await pushAll(env, staff, { title: payload.title ?? "Cảnh báo kho", body: payload.body ?? "", url, tag: "stock-alert" }) };
}
