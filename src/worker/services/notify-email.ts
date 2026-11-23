import type { Env } from "../env";
import { sysAudit } from "./sysaudit";

/** Che địa chỉ nhận trong audit: ab***@domain.vn */
export function maskEmail(to: string) {
  const [u, d] = to.split("@");
  if (!d) return "***";
  return `${u.slice(0, 2)}***@${d}`;
}

const header = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const wrap76 = (s: string) => s.replace(/(.{76})/g, "$1\r\n");

/** Dựng thư RFC 822 tối thiểu (UTF-8, text/plain, base64). Chống chèn header bằng cách bỏ CR/LF trong mọi trường. */
export function buildRfc822(m: { from: string; to: string; subject: string; text: string; messageId?: string; date?: Date }) {
  const id = m.messageId ?? `${crypto.randomUUID()}@${header(m.from).split("@")[1]?.replace(/[^\w.-]/g, "") || "huumanh.vn"}`;
  return [
    `From: ${header(m.from)}`,
    `To: ${header(m.to)}`,
    `Subject: =?UTF-8?B?${b64(header(m.subject))}?=`,
    `Message-ID: <${id}>`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(m.text)),
    "",
  ].join("\r\n");
}

export interface EmailMsg { to: string; subject: string; text: string; template: string; ref?: Record<string, unknown> }

async function setting(db: D1Database, key: string, fb: string) {
  return (await db.prepare(`SELECT value FROM settings WHERE key=?`).bind(key).first<{ value: string }>())?.value || fb;
}

/** Cho phép test thay thế bước gửi thật của Cloudflare. */
export const cloudflareSender = {
  async send(env: Env, from: string, msg: EmailMsg) {
    if (!env.EMAIL) throw new Error("Thiếu binding EMAIL (send_email)");
    // "cloudflare:email" chỉ có trong runtime workerd; nạp động để test/tsc không phụ thuộc.
    const spec = "cloudflare:email";
    const mod = (await import(/* @vite-ignore */ spec)) as { EmailMessage: new (from: string, to: string, raw: string) => unknown };
    const raw = buildRfc822({ from, to: msg.to, subject: msg.subject, text: msg.text });
    await env.EMAIL.send(new mod.EmailMessage(from, msg.to, raw) as never);
  },
};

/**
 * Gửi email theo `notify.email_provider`: fake (chỉ ghi audit: tên mẫu + người nhận đã che, KHÔNG ghi nội dung/token)
 * | cloudflare (binding EMAIL).
 */
export async function sendEmail(env: Env, msg: EmailMsg): Promise<{ provider: string; sent: boolean }> {
  const provider = await setting(env.DB, "notify.email_provider", "fake");
  if (provider === "cloudflare") {
    const from = await setting(env.DB, "notify.email_from", "Hữu Mạnh <no-reply@huumanh.vn>");
    await cloudflareSender.send(env, from, msg);
    await sysAudit(env.DB, { action: "notify.email", entity: "email", after: { provider, template: msg.template, to: maskEmail(msg.to), ...msg.ref } });
    return { provider, sent: true };
  }
  await sysAudit(env.DB, { action: "notify.email", entity: "email", after: { provider: "fake", template: msg.template, to: maskEmail(msg.to), ...msg.ref } });
  return { provider: "fake", sent: false };
}
