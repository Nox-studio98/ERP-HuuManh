import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import { conflict } from "../../../worker/lib/errors";
import { customerDebtStatus } from "../../../worker/services/debt";
import { confirmOrderFlow, createB2bOrder, DATE_RE, type Ctx } from "../../../worker/services/b2b-orders";
import { sysAuditStmt } from "../../../worker/services/sysaudit";
import type { AppBindings, SessionUser } from "../../../worker/env";
import type { ShopBindings } from "../env";
import { cards } from "../lib/catalog";
import { orderView } from "../lib/orderview";
import { requireAccount, requireB2b } from "../lib/session";
import { ItemSchema } from "./cart";
import { parseBody } from "../lib/util";

export const b2bRoutes = new Hono<ShopBindings>();

b2bRoutes.post("/b2b/link-request", requireAccount, async (c) => {
  const a = c.get("account")!;
  const db = c.env.DB;
  const b = await parseBody(c, z.object({ companyName: z.string().trim().min(1).max(200), taxCode: z.string().trim().min(8).max(20).regex(/^[0-9-]+$/), note: z.string().trim().max(500).optional() }));
  if (a.b2bStatus === "approved") throw conflict("already_approved", "Tài khoản đã được liên kết khách sỉ");
  if (a.b2bStatus === "pending") throw conflict("already_pending", "Yêu cầu liên kết đang chờ duyệt");
  // approvals.requested_by bắt buộc là users.id → dùng tài khoản hệ thống id 1 (như đơn sỉ từ shop)
  await db.batch([
    db.prepare(`UPDATE shop_accounts SET b2b_status = 'pending' WHERE id = ?`).bind(a.id),
    db
      .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('shop.b2b_link','shop_account',?,?,?,1)`)
      .bind(String(a.id), JSON.stringify({ accountId: a.id, companyName: b.companyName, taxCode: b.taxCode, note: b.note ?? null }), `Yêu cầu liên kết khách sỉ: ${b.companyName}`),
  ]);
  return c.json({ ok: true, b2bStatus: "pending" }, 201);
});

b2bRoutes.use("/b2b/catalog", requireAccount, requireB2b);
b2bRoutes.use("/b2b/orders", requireAccount, requireB2b);
b2bRoutes.use("/b2b/addresses", requireAccount, requireB2b);

b2bRoutes.get("/b2b/catalog", async (c) => {
  const a = c.get("account")!;
  const db = c.env.DB;
  const offset = /^\d+$/.test(c.req.query("cursor") ?? "") ? Number(c.req.query("cursor")) : 0;
  const q = c.req.query("q")?.trim();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) (binds.push(`%${q.replace(/[\\%_]/g, (m) => "\\" + m).slice(0, 60)}%`), where.push(`p.name LIKE ?5 ESCAPE '\\'`));
  const rows = await cards(db, { channel: "b2b", groupId: a.customerGroupId, customerId: a.customerId, onlyPublished: false, where, binds, order: "p.name ASC", limit: 101, offset });
  const st = await customerDebtStatus(db, a.customerId);
  return c.json({
    items: rows.slice(0, 100),
    nextCursor: rows.length > 100 ? String(offset + 100) : null,
    creditStatus: { creditLimit: st.creditLimit, balance: st.balance, available: st.available, overdueAmount: st.overdueAmount, overdue: st.overdueCount > 0 },
  });
});

b2bRoutes.get("/b2b/addresses", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, label, address, is_default FROM customer_addresses WHERE customer_id = ? AND active = 1 ORDER BY is_default DESC, id`).bind(c.get("account")!.customerId).all<any>();
  return c.json({ items: results.map((r) => ({ id: r.id, label: r.label, address: r.address, isDefault: !!r.is_default })) });
});

/** Ngữ cảnh "người dùng hệ thống" để tái dùng dịch vụ đơn sỉ của ERP. Vai trò manager: KHÔNG có b2b.credit_override. */
const SHOP_SYSTEM_USER: SessionUser = { id: 1, username: "system", fullName: "Shop (hệ thống)", role: "manager", storeId: null, sessionId: "shop-system", deviceId: null };

function systemCtx(c: Context<ShopBindings>): Ctx {
  const vars: Record<string, unknown> = { user: SHOP_SYSTEM_USER, requestId: c.get("requestId") };
  return { env: c.env, get: (k: string) => vars[k], req: { header: (n: string) => c.req.header(n) } } as unknown as Context<AppBindings>;
}

b2bRoutes.post("/b2b/orders", async (c) => {
  const a = c.get("account")!;
  const db = c.env.DB;
  const b = await parseBody(c, z.object({
    clientUuid: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    addressId: z.number().int().positive(),
    deliveryDate: z.string().regex(DATE_RE),
    note: z.string().trim().max(500).optional(),
    lines: z.array(ItemSchema).min(1).max(100),
  }));
  const ctx = systemCtx(c);
  // Không truyền unitPrice/creditOverrideApprovalId: giá luôn theo bảng giá b2b của khách, không thể vượt hạn mức từ shop.
  const res = await createB2bOrder(ctx, {
    customerId: a.customerId, addressId: b.addressId, deliveryDate: b.deliveryDate, note: b.note, clientUuid: b.clientUuid,
    lines: b.lines.map((l) => ({ productId: l.productId, unit: l.unit, qty: l.qty })),
  });
  const owner = await db.prepare(`SELECT customer_id, channel FROM orders WHERE id = ?`).bind(res.orderId).first<{ customer_id: number; channel: string }>();
  if (!owner || owner.channel !== "b2b" || owner.customer_id !== a.customerId) throw conflict("duplicate_client_uuid", "Mã yêu cầu đã được dùng");
  const st = (await db.prepare(`SELECT status FROM orders WHERE id = ?`).bind(res.orderId).first<{ status: string }>())?.status;
  if (st === "new") await confirmOrderFlow(ctx, res.orderId); // 409 credit_blocked / insufficient_stock như ERP
  if (!res.replay) await db.batch([sysAuditStmt(db, { action: "shop.b2b_order", entity: "order", entityId: res.orderId, after: { accountId: a.id, customerId: a.customerId } })]);
  const o = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(res.orderId).first<any>();
  return c.json(await orderView(db, o), res.replay ? 200 : 201);
});

