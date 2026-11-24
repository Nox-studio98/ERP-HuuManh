import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import { verifyPassword } from "../../../worker/lib/crypto";
import { AppError, conflict, notFound } from "../../../worker/lib/errors";
import { loyaltyConfig } from "../../../worker/services/loyalty-points";
import { sysAuditStmt } from "../../../worker/services/sysaudit";
import type { ShopBindings } from "../env";
import { findZone } from "../lib/delivery";
import { SESSION_COOKIE, requireAccount } from "../lib/session";
import { normalizePhone, parseBody } from "../lib/util";
import { AddressSchema } from "./checkout";
import { meShape } from "./auth";

export const meRoutes = new Hono<ShopBindings>();
meRoutes.use("/me", requireAccount);
meRoutes.use("/me/addresses", requireAccount);
meRoutes.use("/me/addresses/*", requireAccount);
meRoutes.use("/me/push-subscriptions", requireAccount);

meRoutes.get("/me", async (c) => {
  const a = c.get("account")!;
  const base = meShape(a);
  // Điểm thành viên: chỉ tài khoản bán lẻ, khi chương trình tích điểm đang bật
  if (a.kind !== "retail") return c.json(base);
  const cfg = await loyaltyConfig(c.env.DB);
  if (!cfg.enabled) return c.json(base);
  const cu = await c.env.DB.prepare(`SELECT points FROM customers WHERE id = ?`).bind(a.customerId).first<{ points: number }>();
  return c.json({ ...base, points: cu?.points ?? 0, pointValueVnd: cfg.pointValueVnd });
});

meRoutes.put("/me", async (c) => {
  const a = c.get("account")!;
  const b = await parseBody(c, z.object({ fullName: z.string().trim().min(1).max(100).optional(), phone: z.string().trim().min(8).max(20).optional(), marketingOptIn: z.boolean().optional() }));
  const phone = b.phone ? normalizePhone(b.phone) : undefined;
  if (b.phone && !phone) throw new AppError(422, "invalid_phone", "Số điện thoại không hợp lệ");
  const db = c.env.DB;
  const full = b.fullName ?? a.fullName;
  const ph = phone ?? a.phone;
  const stmts = [
    db.prepare(`UPDATE shop_accounts SET full_name = ?, phone = ?, marketing_opt_in = ? WHERE id = ?`).bind(full, ph, (b.marketingOptIn ?? a.marketingOptIn) ? 1 : 0, a.id),
  ];
  // hồ sơ khách lẻ đồng bộ theo; hồ sơ sỉ do ERP quản lý nên không ghi đè
  if (a.kind === "retail") stmts.push(db.prepare(`UPDATE customers SET name = ?, phone = ? WHERE id = ? AND type = 'retail'`).bind(full, ph, a.customerId));
  await db.batch(stmts);
  return c.json(meShape({ ...a, fullName: full, phone: ph, marketingOptIn: b.marketingOptIn ?? a.marketingOptIn }));
});

/**
 * NĐ 13/2023 (quyền xoá dữ liệu): ẩn danh hoá tài khoản. Yêu cầu nhập lại mật khẩu (chống xoá do phiên bị chiếm).
 *  - XOÁ/ẩn danh: shop_accounts (tên, email, SĐT, hash mật khẩu), shop_addresses, shop_sessions, shop_tokens, push_subscriptions,
 *    và hồ sơ customers loại retail của chính tài khoản (tên/SĐT/email).
 *  - GIỮ: orders/order_lines/payments/order_events — chứng từ kế toán phải lưu theo Luật Kế toán; trường người nhận trên đơn
 *    (receiver_name/phone, ship_address) được giữ để đối soát giao hàng. [Cần xác nhận] thời hạn lưu trữ & ẩn danh hoá nốt sau thời hạn.
 *  - Không cho xoá khi còn đơn đang xử lý.
 */
meRoutes.delete("/me", async (c) => {
  const a = c.get("account")!;
  const db = c.env.DB;
  const b = await parseBody(c, z.object({ password: z.string().min(1).max(128) }));
  const row = await db.prepare(`SELECT pass_hash FROM shop_accounts WHERE id = ?`).bind(a.id).first<{ pass_hash: string }>();
  if (!row || !(await verifyPassword(b.password, row.pass_hash))) throw new AppError(403, "invalid_password", "Mật khẩu không đúng");
  const open = await db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE shop_account_id = ? AND status NOT IN ('completed','cancelled','returned')`)
    .bind(a.id)
    .first<{ n: number }>();
  if ((open?.n ?? 0) > 0) throw conflict("active_orders", "Bạn còn đơn hàng đang xử lý, vui lòng chờ hoàn tất hoặc huỷ trước khi xoá tài khoản");
  const now = new Date().toISOString();
  const stmts = [
    db
      .prepare(`UPDATE shop_accounts SET email = ?, phone = NULL, full_name = 'Tài khoản đã xoá', pass_hash = '!deleted', active = 0, marketing_opt_in = 0, email_verified_at = NULL, deleted_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?`)
      .bind(`deleted+${a.id}@deleted.invalid`, now, a.id),
    db.prepare(`DELETE FROM shop_addresses WHERE account_id = ?`).bind(a.id),
    db.prepare(`DELETE FROM push_subscriptions WHERE account_id = ?`).bind(a.id),
    db.prepare(`DELETE FROM shop_tokens WHERE account_id = ?`).bind(a.id),
    db.prepare(`UPDATE shop_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`).bind(now, a.id),
    sysAuditStmt(db, { action: "shop.account_delete", entity: "shop_account", entityId: a.id, after: { customerId: a.customerId, anonymized: true } }),
  ];
  if (a.kind === "retail")
    stmts.push(db.prepare(`UPDATE customers SET name = ?, phone = NULL, email = NULL, active = 0 WHERE id = ? AND type = 'retail'`).bind(`Khách đã xoá #${a.id}`, a.customerId));
  await db.batch(stmts);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

// ===== sổ địa chỉ =====
const AddrBody = AddressSchema.extend({ label: z.string().trim().max(50).optional().nullable(), isDefault: z.boolean().optional() });
const addrOut = (r: any) => ({
  id: r.id, label: r.label, receiverName: r.receiver_name, receiverPhone: r.receiver_phone, addressLine: r.address_line, ward: r.ward,
  district: r.district, province: r.province, zoneId: r.zone_id, isDefault: !!r.is_default,
});

meRoutes.get("/me/addresses", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM shop_addresses WHERE account_id = ? AND active = 1 ORDER BY is_default DESC, id`).bind(c.get("account")!.id).all<any>();
  return c.json({ items: results.map(addrOut) });
});

async function saveAddress(c: any, id: number | null) {
  const a = c.get("account")!;
  const db: D1Database = c.env.DB;
  const b = await parseBody(c, AddrBody);
  const phone = normalizePhone(b.receiverPhone);
  if (!phone) throw new AppError(422, "invalid_phone", "Số điện thoại không hợp lệ");
  const zone = await findZone(db, b.district);
  const count = (await db.prepare(`SELECT COUNT(*) n FROM shop_addresses WHERE account_id = ? AND active = 1`).bind(a.id).first<{ n: number }>())!.n;
  if (id == null && count >= 20) throw new AppError(422, "too_many_addresses", "Tối đa 20 địa chỉ");
  const makeDefault = b.isDefault || (id == null && count === 0);
  const stmts: D1PreparedStatement[] = [];
  if (makeDefault) stmts.push(db.prepare(`UPDATE shop_addresses SET is_default = 0 WHERE account_id = ?`).bind(a.id));
  if (id == null)
    stmts.push(
      db
        .prepare(`INSERT INTO shop_addresses(account_id, label, receiver_name, receiver_phone, address_line, ward, district, province, zone_id, is_default) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(a.id, b.label ?? null, b.receiverName, phone, b.addressLine, b.ward ?? null, b.district, b.province, zone?.id ?? null, makeDefault ? 1 : 0),
    );
  else {
    const own = await db.prepare(`SELECT is_default FROM shop_addresses WHERE id = ? AND account_id = ? AND active = 1`).bind(id, a.id).first<{ is_default: number }>();
    if (!own) throw notFound("address_not_found", "Không tìm thấy địa chỉ");
    stmts.push(
      db
        .prepare(`UPDATE shop_addresses SET label=?, receiver_name=?, receiver_phone=?, address_line=?, ward=?, district=?, province=?, zone_id=?, is_default=? WHERE id=? AND account_id=?`)
        .bind(b.label ?? null, b.receiverName, phone, b.addressLine, b.ward ?? null, b.district, b.province, zone?.id ?? null, makeDefault || own.is_default ? 1 : 0, id, a.id),
    );
  }
  const res = await db.batch(stmts);
  const rid = id ?? ((res[res.length - 1].meta.last_row_id as number) ?? 0);
  const row = await db.prepare(`SELECT * FROM shop_addresses WHERE id = ?`).bind(rid).first<any>();
  return c.json(addrOut(row), id == null ? 201 : 200);
}

meRoutes.post("/me/addresses", (c) => saveAddress(c, null));
meRoutes.put("/me/addresses/:id", (c) => saveAddress(c, Number(c.req.param("id"))));
meRoutes.delete("/me/addresses/:id", async (c) => {
  const r = await c.env.DB.prepare(`UPDATE shop_addresses SET active = 0, is_default = 0 WHERE id = ? AND account_id = ? AND active = 1`).bind(Number(c.req.param("id")), c.get("account")!.id).run();
  if (!r.meta.changes) throw notFound("address_not_found", "Không tìm thấy địa chỉ");
  return c.json({ ok: true });
});

// ===== thông báo đẩy =====
meRoutes.post("/me/push-subscriptions", async (c) => {
  const b = await parseBody(c, z.object({
    endpoint: z.string().url().max(600).refine((u) => u.startsWith("https://"), "endpoint phải là https"),
    keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(100) }),
  }));
  await c.env.DB
    .prepare(
      `INSERT INTO push_subscriptions(account_id, endpoint, p256dh, auth) VALUES (?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET account_id = excluded.account_id, user_id = NULL, p256dh = excluded.p256dh, auth = excluded.auth, last_error = NULL`,
    )
    .bind(c.get("account")!.id, b.endpoint, b.keys.p256dh, b.keys.auth)
    .run();
  return c.json({ ok: true }, 201);
});

meRoutes.get("/push/vapid-public-key", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? null }));
