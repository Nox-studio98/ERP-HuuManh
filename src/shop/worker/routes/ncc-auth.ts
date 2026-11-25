import { Hono } from "hono";
import { z } from "zod";
import { hashPassword, sha256, timingSafeEqual, verifyPassword } from "../../../worker/lib/crypto";
import { AppError } from "../../../worker/lib/errors";
import { assertStmt } from "../../../worker/services/guard";
import type { ShopBindings } from "../env";
import { nccAuditStmt } from "../lib/ncc-audit";
import { assertNccEnabled, clearNccCookie, loadSupplier, nccTokenOf, startNccSession } from "../lib/ncc-session";
import { verifyTurnstile } from "../lib/turnstile";
import { clientIp, parseBody } from "../lib/util";

/** Cổng NCC — xác thực: đăng nhập, link mời / đặt mật khẩu, đổi mật khẩu, đăng xuất (docs/PO-NCC.md mục 5, docs/SECOPS.md). */
export const nccAuthRoutes = new Hono<ShopBindings>();

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const Email = z.string().trim().toLowerCase().email().max(200);
const Password = z.string().min(10, "Mật khẩu tối thiểu 10 ký tự").max(128);
const INVALID_LINK = () => new AppError(400, "invalid_token", "Liên kết không hợp lệ hoặc đã hết hạn. Vui lòng nhờ cửa hàng gửi lại liên kết mời.");

export const nccMeShape = (a: { id: number; fullName: string; email: string; phone: string | null; supplierName: string; supplierCode: string }) => ({
  id: a.id, fullName: a.fullName, email: a.email, phone: a.phone, supplier: { name: a.supplierName, code: a.supplierCode },
});

/** Băm (SHA-256) IP làm khoá "khoá theo (tài khoản + IP)": kẻ tấn công từ IP khác không khoá được chủ tài khoản (chống DoS); không lưu IP thô trong cột reason. */
const ipKey = async (ip: string) => (await sha256(`ncc-login|${ip}`)).slice(0, 24);

nccAuthRoutes.post("/login", async (c) => {
  await assertNccEnabled(c.env.DB);
  await verifyTurnstile(c);
  const b = await parseBody(c, z.object({ email: Email, password: z.string().min(1).max(128) }));
  const db = c.env.DB;
  const u = await db
    .prepare(
      `SELECT a.id, a.pass_hash, a.status, s.active AS supplier_active FROM supplier_accounts a JOIN suppliers s ON s.id = a.supplier_id WHERE a.email = ?`,
    )
    .bind(b.email)
    .first<{ id: number; pass_hash: string | null; status: string; supplier_active: number }>();
  const ip = clientIp(c);
  const key = await ipKey(ip);
  // Khoá KHÔNG lộ: phản hồi y hệt sai mật khẩu, và luôn băm mật khẩu để thời gian không phân biệt được tài khoản có/không tồn tại
  let locked = false;
  if (u) {
    const since = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString();
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ncc.login_failed' AND entity_id = ?1 AND reason = ?2 AND at >= ?3
            AND at > COALESCE((SELECT MAX(at) FROM audit_log WHERE action = 'ncc.login_ok' AND entity_id = ?1 AND reason = ?2), '')`,
      )
      .bind(String(u.id), key, since)
      .first<{ n: number }>();
    locked = (r?.n ?? 0) >= MAX_FAILS;
  }
  const ok = await verifyPassword(b.password, u?.pass_hash ?? DUMMY_HASH);
  if (!u || !ok || !u.pass_hash || u.status !== "active" || !u.supplier_active || locked) {
    if (u)
      await db.batch([
        db.prepare(`UPDATE supplier_accounts SET failed_logins = failed_logins + 1 WHERE id = ?`).bind(u.id),
        nccAuditStmt(c, u.id, { action: "ncc.login_failed", entity: "supplier_account", entityId: u.id, reason: key, after: { why: locked ? "locked" : !ok || !u.pass_hash ? "bad_password" : "inactive" } }),
      ]);
    throw new AppError(401, "invalid_credentials", "Email hoặc mật khẩu không đúng");
  }
  const old = nccTokenOf(c);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE supplier_accounts SET failed_logins = 0, last_login_at = ? WHERE id = ?`).bind(now, u.id),
    nccAuditStmt(c, u.id, { action: "ncc.login_ok", entity: "supplier_account", entityId: u.id, reason: key }),
    ...(old ? [db.prepare(`UPDATE supplier_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(now, await sha256(old))] : []),
  ]);
  const token = await startNccSession(c, u.id);
  const acc = (await loadSupplier(c.env, token))!;
  return c.json({ account: nccMeShape(acc) });
});

type InviteRow = { id: number; account_id: number; token_hash: string; expires_at: string; used_at: string | null; revoked_at: string | null; status: string; email: string; full_name: string; supplier_name: string; supplier_active: number };

/** Link dạng "<id>.<bí mật>". Tra theo id rồi so SHA-256 của phần bí mật bằng timingSafeEqual (luôn tính hash kể cả khi không có dòng, để thời gian không phân biệt). */
async function findInvite(db: D1Database, token: string): Promise<{ row: InviteRow; hash: string } | null> {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{20,100})$/.exec(token);
  const hash = await sha256(m?.[2] ?? "invalid");
  if (!m) return null;
  const row = await db
    .prepare(
      `SELECT i.id, i.account_id, i.token_hash, i.expires_at, i.used_at, i.revoked_at, a.status, a.email, a.full_name, s.name AS supplier_name, s.active AS supplier_active
         FROM supplier_invites i JOIN supplier_accounts a ON a.id = i.account_id JOIN suppliers s ON s.id = a.supplier_id WHERE i.id = ?`,
    )
    .bind(Number(m[1]))
    .first<InviteRow>();
  const stored = row?.token_hash ?? "0".repeat(64);
  const same = timingSafeEqual(new TextEncoder().encode(hash), new TextEncoder().encode(stored));
  if (!row || !same) return null;
  return { row, hash };
}

const usable = (r: InviteRow) => !r.used_at && !r.revoked_at && r.expires_at > new Date().toISOString() && r.status !== "locked" && !!r.supplier_active;

nccAuthRoutes.post("/invite", async (c) => {
  await assertNccEnabled(c.env.DB);
  const b = await parseBody(c, z.object({ token: z.string().min(10).max(200) }));
  const f = await findInvite(c.env.DB, b.token);
  if (!f || !usable(f.row)) throw INVALID_LINK();
  return c.json({ fullName: f.row.full_name, email: f.row.email, supplierName: f.row.supplier_name, expiresAt: f.row.expires_at, firstTime: f.row.status === "invited" });
});

nccAuthRoutes.post("/accept", async (c) => {
  await assertNccEnabled(c.env.DB);
  await verifyTurnstile(c);
  const b = await parseBody(c, z.object({ token: z.string().min(10).max(200), password: Password }));
  const db = c.env.DB;
  const f = await findInvite(db, b.token);
  if (!f || !usable(f.row)) {
    await hashPassword(b.password); // cân bằng thời gian
    throw INVALID_LINK();
  }
  const { row, hash } = f;
  const passHash = await hashPassword(b.password);
  const now = new Date().toISOString();
  try {
    await db.batch([
      // dùng MỘT lần: hai request đồng thời → request sau bị state_changed
      assertStmt(
        db, "ncc.accept",
        `SELECT EXISTS(SELECT 1 FROM supplier_invites i JOIN supplier_accounts a ON a.id = i.account_id
                        WHERE i.id = ? AND i.token_hash = ? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? AND a.status <> 'locked')`,
        [row.id, hash, now],
      ),
      db.prepare(`UPDATE supplier_invites SET used_at = ? WHERE id = ? AND used_at IS NULL`).bind(now, row.id),
      db.prepare(`UPDATE supplier_invites SET revoked_at = ? WHERE account_id = ? AND id <> ? AND used_at IS NULL AND revoked_at IS NULL`).bind(now, row.account_id, row.id),
      db.prepare(`UPDATE supplier_accounts SET pass_hash = ?, status = 'active', failed_logins = 0 WHERE id = ? AND status <> 'locked'`).bind(passHash, row.account_id),
      db.prepare(`UPDATE supplier_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`).bind(now, row.account_id),
      nccAuditStmt(c, row.account_id, { action: row.status === "invited" ? "ncc.invite_accept" : "ncc.password_reset", entity: "supplier_account", entityId: row.account_id, after: { inviteId: row.id } }),
    ]);
  } catch (e) {
    if (String((e as Error)?.message).includes("state_changed")) throw INVALID_LINK();
    throw e;
  }
  const token = await startNccSession(c, row.account_id);
  const acc = (await loadSupplier(c.env, token))!;
  return c.json({ account: nccMeShape(acc) });
});

nccAuthRoutes.post("/logout", async (c) => {
  const t = nccTokenOf(c);
  if (t) {
    const a = await loadSupplier(c.env, t);
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE supplier_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(new Date().toISOString(), await sha256(t)),
      ...(a ? [nccAuditStmt(c, a.id, { action: "ncc.logout", entity: "supplier_account", entityId: a.id })] : []),
    ]);
  }
  clearNccCookie(c);
  return c.json({ ok: true });
});
