import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { auditStmt } from "../lib/audit";
import { randomToken, sha256 } from "../lib/crypto";
import { AppError, conflict, notFound } from "../lib/errors";
import { requirePerm } from "../lib/rbac";
import { parseBody } from "../services/http";
import { assertStmt } from "../services/guard";
import { getSettingInt } from "../services/settings";

/**
 * Quản lý tài khoản cổng NCC (/ncc trên website) từ màn Nhà cung cấp — docs/PO-NCC.md mục 3.3, docs/API-po.md mục 8.
 * Quyền: purchasing.approve (chủ, quản lý) cho mọi thao tác — mời người ngoài vào xem đơn đặt hàng và công nợ là việc nhạy cảm.
 * Link mời: "<SHOP_BASE_URL>/ncc/dat-mat-khau#<id>.<bí mật>" — token chỉ trả MỘT lần trong response tạo/gửi lại; DB chỉ lưu SHA-256, audit không ghi token.
 */
export const supplierPortalRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const pid = (c: Ctx, name = "id") => {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const Email = z.string().trim().toLowerCase().email().max(200);

async function loadSupplier(c: Ctx, id: number) {
  const s = await c.env.DB.prepare(`SELECT id, code, name, active FROM suppliers WHERE id = ?`).bind(id).first<{ id: number; code: string; name: string; active: number }>();
  if (!s) throw notFound("supplier_not_found", "Không tìm thấy nhà cung cấp");
  return s;
}
/** Tài khoản phải thuộc đúng nhà cung cấp trên đường dẫn (không thao tác chéo NCC). */
async function loadAccount(c: Ctx, supplierId: number, accountId: number) {
  const a = await c.env.DB.prepare(`SELECT * FROM supplier_accounts WHERE id = ? AND supplier_id = ?`).bind(accountId, supplierId).first<any>();
  if (!a) throw notFound("account_not_found", "Không tìm thấy tài khoản NCC");
  return a;
}

const shapeAccount = (a: any) => ({
  id: a.id, fullName: a.full_name, email: a.email, phone: a.phone, status: a.status, hasPassword: !!a.pass_hash,
  lastLoginAt: a.last_login_at, failedLogins: a.failed_logins, createdAt: a.created_at, invitedByName: a.invited_by_name ?? null,
  pendingInvite: a.invite_id ? { id: a.invite_id, expiresAt: a.invite_expires_at, expired: a.invite_expires_at <= new Date().toISOString() } : null,
});

async function listAccounts(c: Ctx, supplierId: number) {
  const { results } = await c.env.DB
    .prepare(
      `SELECT a.*, u.full_name AS invited_by_name,
              (SELECT i.id FROM supplier_invites i WHERE i.account_id = a.id AND i.used_at IS NULL AND i.revoked_at IS NULL ORDER BY i.id DESC LIMIT 1) AS invite_id,
              (SELECT i.expires_at FROM supplier_invites i WHERE i.account_id = a.id AND i.used_at IS NULL AND i.revoked_at IS NULL ORDER BY i.id DESC LIMIT 1) AS invite_expires_at
         FROM supplier_accounts a LEFT JOIN users u ON u.id = a.invited_by WHERE a.supplier_id = ? ORDER BY a.id`,
    )
    .bind(supplierId)
    .all<any>();
  return results.map(shapeAccount);
}

async function portalEnabled(c: Ctx) {
  return (await c.env.DB.prepare(`SELECT value FROM settings WHERE key = 'ncc.portal_enabled'`).first<{ value: string }>())?.value !== "0";
}

/** Tạo token mời (chỉ trả ở đây) + câu lệnh ghi invite; invite cũ còn hiệu lực của tài khoản bị thu hồi. */
async function newInvite(c: Ctx, accountIdSql: string, accountBinds: unknown[]) {
  const db = c.env.DB;
  const secret = randomToken(32);
  const hash = await sha256(secret);
  const ttl = Math.min(Math.max(await getSettingInt(db, "ncc.invite_ttl_hours", 72), 1), 720);
  const expiresAt = new Date(Date.now() + ttl * 3600_000).toISOString();
  const now = new Date().toISOString();
  const stmts = [
    db.prepare(`UPDATE supplier_invites SET revoked_at = ? WHERE account_id = ${accountIdSql} AND used_at IS NULL AND revoked_at IS NULL`).bind(now, ...accountBinds),
    db
      .prepare(`INSERT INTO supplier_invites(account_id, token_hash, expires_at, created_by) VALUES (${accountIdSql}, ?, ?, ?)`)
      .bind(...accountBinds, hash, expiresAt, c.get("user").id),
  ];
  const finish = async () => {
    const row = await db.prepare(`SELECT id FROM supplier_invites WHERE token_hash = ?`).bind(hash).first<{ id: number }>();
    const path = `/ncc/dat-mat-khau#${row!.id}.${secret}`;
    const base = (c.env.SHOP_BASE_URL ?? "").replace(/\/$/, "");
    return { id: row!.id, path, link: base ? base + path : null, expiresAt, ttlHours: ttl };
  };
  return { stmts, finish, expiresAt };
}

supplierPortalRoutes.get("/suppliers/:id/portal", requirePerm("purchasing.approve"), async (c) => {
  const id = pid(c);
  await loadSupplier(c, id);
  return c.json({ enabled: await portalEnabled(c), shopConfigured: !!c.env.SHOP_BASE_URL, items: await listAccounts(c, id), nextCursor: null });
});

supplierPortalRoutes.post("/suppliers/:id/portal/invites", requirePerm("purchasing.approve"), async (c) => {
  const id = pid(c);
  const s = await loadSupplier(c, id);
  if (!s.active) throw new AppError(422, "supplier_inactive", "Nhà cung cấp đã ngừng giao dịch");
  const b = await parseBody(c, z.object({ fullName: z.string().trim().min(1).max(100), email: Email, phone: z.string().trim().max(20).nullish() }));
  const taken = await c.env.DB.prepare(`SELECT id FROM supplier_accounts WHERE email = ?`).bind(b.email).first();
  if (taken) throw conflict("email_taken", "Email này đã có tài khoản cổng NCC");
  const inv = await newInvite(c, `(SELECT id FROM supplier_accounts WHERE email = ?)`, [b.email]);
  try {
    await c.env.DB.batch([
      c.env.DB
        .prepare(`INSERT INTO supplier_accounts(supplier_id, email, phone, full_name, status, invited_by) VALUES (?,?,?,?, 'invited', ?)`)
        .bind(id, b.email, b.phone || null, b.fullName, c.get("user").id),
      ...inv.stmts,
      auditStmt(c, { action: "ncc.account_invite", entity: "supplier", entityId: id, after: { email: b.email, fullName: b.fullName, supplierCode: s.code, expiresAt: inv.expiresAt } }),
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String((e as Error)?.message))) throw conflict("email_taken", "Email này đã có tài khoản cổng NCC");
    throw e;
  }
  const invite = await inv.finish();
  const acc = (await listAccounts(c, id)).find((a) => a.email === b.email);
  return c.json({ account: acc, invite }, 201);
});

/** Gửi lại link: tài khoản chưa đặt mật khẩu → link mời mới; đã đặt → link đặt lại mật khẩu (quên mật khẩu). Link cũ chưa dùng bị thu hồi. */
supplierPortalRoutes.post("/suppliers/:id/portal/accounts/:accountId/invite", requirePerm("purchasing.approve"), async (c) => {
  const id = pid(c), accId = pid(c, "accountId");
  await loadSupplier(c, id);
  const a = await loadAccount(c, id, accId);
  if (a.status === "locked") throw conflict("account_locked", "Tài khoản đang bị khoá, hãy mở khoá trước khi gửi link");
  const inv = await newInvite(c, "?", [accId]);
  await c.env.DB.batch([
    assertStmt(c.env.DB, "ncc.reinvite", `SELECT status <> 'locked' FROM supplier_accounts WHERE id = ? AND supplier_id = ?`, [accId, id]),
    ...inv.stmts,
    auditStmt(c, { action: "ncc.account_reinvite", entity: "supplier_account", entityId: accId, after: { supplierId: id, reset: !!a.pass_hash, expiresAt: inv.expiresAt } }),
  ]);
  return c.json({ account: (await listAccounts(c, id)).find((x) => x.id === accId), invite: await inv.finish() }, 201);
});

supplierPortalRoutes.post("/suppliers/:id/portal/accounts/:accountId/revoke-invite", requirePerm("purchasing.approve"), async (c) => {
  const id = pid(c), accId = pid(c, "accountId");
  await loadSupplier(c, id);
  await loadAccount(c, id, accId);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE supplier_invites SET revoked_at = ? WHERE account_id = ? AND used_at IS NULL AND revoked_at IS NULL`).bind(new Date().toISOString(), accId),
    auditStmt(c, { action: "ncc.invite_revoke", entity: "supplier_account", entityId: accId, after: { supplierId: id } }),
  ]);
  return c.json({ account: (await listAccounts(c, id)).find((x) => x.id === accId) });
});

supplierPortalRoutes.post("/suppliers/:id/portal/accounts/:accountId/lock", requirePerm("purchasing.approve"), async (c) => {
  const id = pid(c), accId = pid(c, "accountId");
  await loadSupplier(c, id);
  await loadAccount(c, id, accId);
  const b = await parseBody(c, z.object({ reason: z.string().trim().max(300).optional() }));
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE supplier_accounts SET status = 'locked', locked_by = ? WHERE id = ? AND supplier_id = ?`).bind(c.get("user").id, accId, id),
    c.env.DB.prepare(`UPDATE supplier_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`).bind(now, accId), // thu hồi phiên ngay
    c.env.DB.prepare(`UPDATE supplier_invites SET revoked_at = ? WHERE account_id = ? AND used_at IS NULL AND revoked_at IS NULL`).bind(now, accId),
    auditStmt(c, { action: "ncc.account_lock", entity: "supplier_account", entityId: accId, after: { supplierId: id }, reason: b.reason }),
  ]);
  return c.json({ account: (await listAccounts(c, id)).find((x) => x.id === accId) });
});

supplierPortalRoutes.post("/suppliers/:id/portal/accounts/:accountId/unlock", requirePerm("purchasing.approve"), async (c) => {
  const id = pid(c), accId = pid(c, "accountId");
  await loadSupplier(c, id);
  const a = await loadAccount(c, id, accId);
  if (a.status !== "locked") throw conflict("not_locked", "Tài khoản không bị khoá");
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE supplier_accounts SET status = CASE WHEN pass_hash IS NULL THEN 'invited' ELSE 'active' END, locked_by = NULL, failed_logins = 0 WHERE id = ? AND supplier_id = ? AND status = 'locked'`).bind(accId, id),
    auditStmt(c, { action: "ncc.account_unlock", entity: "supplier_account", entityId: accId, after: { supplierId: id } }),
  ]);
  return c.json({ account: (await listAccounts(c, id)).find((x) => x.id === accId) });
});
