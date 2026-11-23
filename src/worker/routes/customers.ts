import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm, can, maskPhone } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { customerDebtStatus } from "../services/debt";
import { guarded, pageParams } from "../services/http";

export const customerRoutes = new Hono<AppBindings>();

type Ctx = Context<AppBindings>;
const parse = async <T extends z.ZodTypeAny>(c: Ctx, s: T): Promise<z.infer<T>> => s.parse(await c.req.json().catch(() => ({})));
const maskEmail = (e: string | null, ok: boolean) => (e && !ok ? "***" : e ?? null);

const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().max(120).nullish(),
  role: z.string().trim().max(50).nullish(),
  isReceiver: z.boolean().default(false),
});
const addressSchema = z.object({
  label: z.string().trim().min(1).max(60),
  address: z.string().trim().min(3).max(300),
  receiverContactIndex: z.number().int().min(0).optional(),
  deliveryNote: z.string().trim().max(300).nullish(),
  isDefault: z.boolean().default(false),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  type: z.literal("b2b").default("b2b"),
  taxCode: z.string().trim().max(20).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().max(120).nullish(),
  billingAddress: z.string().trim().max(300).nullish(),
  note: z.string().trim().max(500).nullish(),
  customerGroupId: z.number().int().positive(),
  creditLimit: z.number().int().min(0),
  paymentTermsDays: z.number().int().min(0).max(365),
  ownerUserId: z.number().int().positive().nullish(),
  contacts: z.array(contactSchema).max(20),
  addresses: z.array(addressSchema).max(20),
});

/** KH-0001: số tăng liên tục, nguyên tử qua doc_sequences (day cố định). */
async function nextCustomerCode(db: D1Database) {
  const r = await db
    .prepare(`INSERT INTO doc_sequences(prefix, day, seq) VALUES ('KH','-',1) ON CONFLICT(prefix, day) DO UPDATE SET seq = seq + 1 RETURNING seq`)
    .first<{ seq: number }>();
  return `KH-${String(r!.seq).padStart(4, "0")}`;
}

const SEL = `SELECT cu.*, g.name AS group_name, u.full_name AS owner_name
               FROM customers cu LEFT JOIN customer_groups g ON g.id = cu.customer_group_id LEFT JOIN users u ON u.id = cu.owner_user_id`;

function shape(r: any, pii: boolean) {
  return {
    id: r.id, code: r.code, type: r.type, name: r.name,
    phone: pii ? r.phone : maskPhone(r.phone, "warehouse"), email: maskEmail(r.email, pii),
    taxCode: r.tax_code, billingAddress: r.billing_address, note: r.note,
    customerGroupId: r.customer_group_id, groupName: r.group_name, creditLimit: r.credit_limit, paymentTermsDays: r.payment_terms_days,
    ownerUserId: r.owner_user_id, ownerName: r.owner_name, active: !!r.active, version: r.version,
  };
}

const contactShape = (r: any, pii: boolean) => ({
  id: r.id, name: r.name, phone: pii ? r.phone : maskPhone(r.phone, "warehouse"), email: maskEmail(r.email, pii), role: r.role, isReceiver: !!r.is_receiver, active: !!r.active,
});
const addressShape = (r: any) => ({
  id: r.id, label: r.label, address: r.address, receiverContactId: r.receiver_contact_id, deliveryNote: r.delivery_note, isDefault: !!r.is_default, active: !!r.active,
});

async function loadCustomer(db: D1Database, id: number) {
  const r = await db.prepare(`${SEL} WHERE cu.id = ?`).bind(id).first<any>();
  if (!r) throw notFound("customer_not_found", "Không tìm thấy khách hàng");
  return r;
}

async function customerDetail(c: Ctx, id: number) {
  const db = c.env.DB;
  const role = c.get("user").role;
  const pii = can(role, "customers.view_pii");
  const r = await loadCustomer(db, id);
  const contacts = (await db.prepare(`SELECT * FROM customer_contacts WHERE customer_id = ? ORDER BY id`).bind(id).all<any>()).results;
  const addresses = (await db.prepare(`SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY id`).bind(id).all<any>()).results;
  const pl = await db.prepare(`SELECT id FROM price_lists WHERE customer_id = ? AND kind = 'customer' AND active = 1 ORDER BY id LIMIT 1`).bind(id).first<{ id: number }>();
  return {
    ...shape(r, pii),
    contacts: contacts.map((x) => contactShape(x, pii)),
    addresses: addresses.map(addressShape),
    debt: await customerDebtStatus(db, id),
    priceListId: pl?.id ?? null,
  };
}

// ---------------------------------------------------------------- danh sách / chi tiết
customerRoutes.get("/customer-groups", requirePerm("b2b.view"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, code, name FROM customer_groups ORDER BY id`).all();
  return c.json({ items: results });
});

customerRoutes.get("/customers", requirePerm("b2b.view"), async (c) => {
  const db = c.env.DB;
  const role = c.get("user").role;
  const pii = can(role, "customers.view_pii");
  const { limit, cursor } = pageParams(c);
  const q = c.req.query();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.type) (where.push("cu.type = ?"), binds.push(q.type));
  if (q.ownerUserId) (where.push("cu.owner_user_id = ?"), binds.push(Number(q.ownerUserId)));
  if (q.q) {
    const like = `%${q.q}%`;
    where.push(pii ? "(cu.name LIKE ? OR cu.code LIKE ? OR cu.tax_code LIKE ? OR cu.phone LIKE ?)" : "(cu.name LIKE ? OR cu.code LIKE ? OR cu.tax_code LIKE ?)");
    binds.push(like, like, like);
    if (pii) binds.push(like);
  }
  if (cursor) (where.push("cu.id < ?"), binds.push(cursor));
  const rows = (await db.prepare(`${SEL} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY cu.id DESC LIMIT ?`).bind(...binds, limit + 1).all<any>()).results;
  const page = rows.slice(0, limit);
  const items = [];
  for (const r of page) {
    const d = await customerDebtStatus(db, r.id);
    items.push({ ...shape(r, pii), debt: { balance: d.balance, overdueAmount: d.overdueAmount } });
  }
  return c.json({ items, nextCursor: rows.length > limit ? page[page.length - 1].id : null });
});

customerRoutes.get("/customers/:id", requirePerm("b2b.view"), async (c) => c.json(await customerDetail(c, Number(c.req.param("id")))));

// ---------------------------------------------------------------- tạo / sửa
customerRoutes.post("/customers", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const b = await parse(c, createSchema);
  if (b.addresses.length < 1) throw new AppError(422, "address_required", "Khách sỉ phải có ít nhất 1 địa chỉ giao hàng");
  if (!b.contacts.some((x) => x.isReceiver)) throw new AppError(422, "receiver_required", "Khách sỉ phải có ít nhất 1 người nhận hàng");
  for (const a of b.addresses)
    if (a.receiverContactIndex != null && a.receiverContactIndex >= b.contacts.length) throw new AppError(422, "validation_error", "receiverContactIndex vượt quá số liên hệ");
  const g = await db.prepare(`SELECT id FROM customer_groups WHERE id = ?`).bind(b.customerGroupId).first();
  if (!g) throw new AppError(422, "invalid_group", "Nhóm khách hàng không tồn tại");
  const code = await nextCustomerCode(db);
  const firstReceiver = b.contacts.findIndex((x) => x.isReceiver);
  const defaultIdx = Math.max(0, b.addresses.findIndex((a) => a.isDefault));
  const byCode = `(SELECT id FROM customers WHERE code = ?)`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO customers(code, type, name, phone, email, customer_group_id, tax_code, credit_limit, payment_terms_days, owner_user_id, billing_address, note, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .bind(code, "b2b", b.name, b.phone ?? null, b.email ?? null, b.customerGroupId, b.taxCode ?? null, b.creditLimit, b.paymentTermsDays, b.ownerUserId ?? null, b.billingAddress ?? null, b.note ?? null),
    ...b.contacts.map((x) =>
      db
        .prepare(`INSERT INTO customer_contacts(customer_id, name, phone, email, role, is_receiver) VALUES (${byCode},?,?,?,?,?)`)
        .bind(code, x.name, x.phone ?? null, x.email ?? null, x.role ?? null, x.isReceiver ? 1 : 0),
    ),
    ...b.addresses.map((a, i) =>
      db
        .prepare(
          `INSERT INTO customer_addresses(customer_id, label, address, receiver_contact_id, delivery_note, is_default)
           VALUES (${byCode},?,?,(SELECT id FROM customer_contacts WHERE customer_id = ${byCode} ORDER BY id LIMIT 1 OFFSET ?),?,?)`,
        )
        .bind(code, a.label, a.address, code, a.receiverContactIndex ?? firstReceiver, a.deliveryNote ?? null, i === defaultIdx ? 1 : 0),
    ),
    auditStmt(c, { action: "customer.create", entity: "customer", entityId: code, after: { name: b.name, creditLimit: b.creditLimit, paymentTermsDays: b.paymentTermsDays, customerGroupId: b.customerGroupId } }),
  ];
  await guarded(() => db.batch(stmts));
  const row = await db.prepare(`SELECT id FROM customers WHERE code = ?`).bind(code).first<{ id: number }>();
  return c.json(await customerDetail(c, row!.id), 201);
});

const updateSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(150).optional(),
  taxCode: z.string().trim().max(20).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().max(120).nullish(),
  billingAddress: z.string().trim().max(300).nullish(),
  note: z.string().trim().max(500).nullish(),
  customerGroupId: z.number().int().positive().optional(),
  creditLimit: z.number().int().min(0).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  ownerUserId: z.number().int().positive().nullish(),
  active: z.boolean().optional(),
});

customerRoutes.put("/customers/:id", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const b = await parse(c, updateSchema);
  const cur = await loadCustomer(db, id);
  if (cur.version !== b.version) throw conflict("version_conflict", "Khách hàng đã được người khác cập nhật", { currentVersion: cur.version });
  const sensitive =
    (b.creditLimit !== undefined && b.creditLimit !== cur.credit_limit) ||
    (b.paymentTermsDays !== undefined && b.paymentTermsDays !== cur.payment_terms_days) ||
    (b.customerGroupId !== undefined && b.customerGroupId !== cur.customer_group_id);
  if (sensitive && !can(c.get("user").role, "b2b.approve")) throw new AppError(403, "forbidden", "Đổi hạn mức, hạn thanh toán hoặc nhóm khách cần quyền duyệt");
  const next = {
    name: b.name ?? cur.name,
    tax_code: b.taxCode !== undefined ? b.taxCode : cur.tax_code,
    phone: b.phone !== undefined ? b.phone : cur.phone,
    email: b.email !== undefined ? b.email : cur.email,
    billing_address: b.billingAddress !== undefined ? b.billingAddress : cur.billing_address,
    note: b.note !== undefined ? b.note : cur.note,
    customer_group_id: b.customerGroupId ?? cur.customer_group_id,
    credit_limit: b.creditLimit ?? cur.credit_limit,
    payment_terms_days: b.paymentTermsDays ?? cur.payment_terms_days,
    owner_user_id: b.ownerUserId !== undefined ? b.ownerUserId : cur.owner_user_id,
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
  };
  const pick = (o: any) => ({ name: o.name, tax_code: o.tax_code, billing_address: o.billing_address, customer_group_id: o.customer_group_id, credit_limit: o.credit_limit, payment_terms_days: o.payment_terms_days, owner_user_id: o.owner_user_id, active: o.active });
  const res = await db.batch([
    db
      .prepare(
        `UPDATE customers SET name=?, tax_code=?, phone=?, email=?, billing_address=?, note=?, customer_group_id=?, credit_limit=?, payment_terms_days=?, owner_user_id=?, active=?, version = version + 1
          WHERE id = ? AND version = ?`,
      )
      .bind(next.name, next.tax_code, next.phone, next.email, next.billing_address, next.note, next.customer_group_id, next.credit_limit, next.payment_terms_days, next.owner_user_id, next.active, id, b.version),
    auditStmt(c, { action: "customer.update", entity: "customer", entityId: id, before: pick(cur), after: pick(next) }),
  ]);
  if (res[0].meta.changes === 0) throw conflict("version_conflict", "Khách hàng đã được người khác cập nhật");
  return c.json(await customerDetail(c, id));
});

// ---------------------------------------------------------------- liên hệ & địa chỉ
customerRoutes.post("/customers/:id/contacts", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  await loadCustomer(db, id);
  const b = await parse(c, contactSchema);
  await db.batch([
    db.prepare(`INSERT INTO customer_contacts(customer_id, name, phone, email, role, is_receiver) VALUES (?,?,?,?,?,?)`).bind(id, b.name, b.phone ?? null, b.email ?? null, b.role ?? null, b.isReceiver ? 1 : 0),
    auditStmt(c, { action: "customer.contact_add", entity: "customer", entityId: id, after: { name: b.name, isReceiver: b.isReceiver } }),
  ]);
  return c.json(await customerDetail(c, id), 201);
});

customerRoutes.put("/customers/:id/contacts/:cid", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const cid = Number(c.req.param("cid"));
  const cur = await db.prepare(`SELECT * FROM customer_contacts WHERE id = ? AND customer_id = ?`).bind(cid, id).first<any>();
  if (!cur) throw notFound("contact_not_found", "Không tìm thấy liên hệ");
  const b = await parse(c, contactSchema.partial().extend({ active: z.boolean().optional() }));
  const n = {
    name: b.name ?? cur.name,
    phone: b.phone !== undefined ? b.phone : cur.phone,
    email: b.email !== undefined ? b.email : cur.email,
    role: b.role !== undefined ? b.role : cur.role,
    is_receiver: b.isReceiver !== undefined ? (b.isReceiver ? 1 : 0) : cur.is_receiver,
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
  };
  if (cur.is_receiver && cur.active && (!n.is_receiver || !n.active)) {
    const other = await db.prepare(`SELECT COUNT(*) n FROM customer_contacts WHERE customer_id = ? AND is_receiver = 1 AND active = 1 AND id <> ?`).bind(id, cid).first<{ n: number }>();
    if (!other!.n) throw new AppError(422, "receiver_required", "Khách sỉ phải còn ít nhất 1 người nhận hàng");
  }
  await db.batch([
    db.prepare(`UPDATE customer_contacts SET name=?, phone=?, email=?, role=?, is_receiver=?, active=? WHERE id=?`).bind(n.name, n.phone, n.email, n.role, n.is_receiver, n.active, cid),
    auditStmt(c, { action: "customer.contact_update", entity: "customer", entityId: id, before: { contactId: cid, name: cur.name, isReceiver: cur.is_receiver, active: cur.active }, after: { contactId: cid, ...n } }),
  ]);
  return c.json(await customerDetail(c, id));
});

customerRoutes.post("/customers/:id/addresses", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  await loadCustomer(db, id);
  const b = await parse(c, addressSchema.extend({ receiverContactId: z.number().int().positive().optional() }));
  if (b.receiverContactId) {
    const ct = await db.prepare(`SELECT id FROM customer_contacts WHERE id = ? AND customer_id = ?`).bind(b.receiverContactId, id).first();
    if (!ct) throw new AppError(422, "contact_not_found", "Người nhận không thuộc khách hàng");
  }
  const stmts = [
    ...(b.isDefault ? [db.prepare(`UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?`).bind(id)] : []),
    db
      .prepare(`INSERT INTO customer_addresses(customer_id, label, address, receiver_contact_id, delivery_note, is_default) VALUES (?,?,?,?,?,?)`)
      .bind(id, b.label, b.address, b.receiverContactId ?? null, b.deliveryNote ?? null, b.isDefault ? 1 : 0),
    auditStmt(c, { action: "customer.address_add", entity: "customer", entityId: id, after: { label: b.label, address: b.address } }),
  ];
  await db.batch(stmts);
  return c.json(await customerDetail(c, id), 201);
});

customerRoutes.put("/customers/:id/addresses/:aid", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const aid = Number(c.req.param("aid"));
  const cur = await db.prepare(`SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?`).bind(aid, id).first<any>();
  if (!cur) throw notFound("address_not_found", "Không tìm thấy địa chỉ");
  const b = await parse(c, addressSchema.partial().extend({ active: z.boolean().optional(), receiverContactId: z.number().int().positive().nullish() }));
  const n = {
    label: b.label ?? cur.label,
    address: b.address ?? cur.address,
    receiver_contact_id: b.receiverContactId !== undefined ? b.receiverContactId : cur.receiver_contact_id,
    delivery_note: b.deliveryNote !== undefined ? b.deliveryNote : cur.delivery_note,
    is_default: b.isDefault !== undefined ? (b.isDefault ? 1 : 0) : cur.is_default,
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
  };
  if (n.receiver_contact_id) {
    const ct = await db.prepare(`SELECT id FROM customer_contacts WHERE id = ? AND customer_id = ?`).bind(n.receiver_contact_id, id).first();
    if (!ct) throw new AppError(422, "contact_not_found", "Người nhận không thuộc khách hàng");
  }
  if (cur.active && !n.active) {
    const other = await db.prepare(`SELECT COUNT(*) n FROM customer_addresses WHERE customer_id = ? AND active = 1 AND id <> ?`).bind(id, aid).first<{ n: number }>();
    if (!other!.n) throw new AppError(422, "address_required", "Khách sỉ phải còn ít nhất 1 địa chỉ giao hàng");
  }
  await db.batch([
    ...(n.is_default ? [db.prepare(`UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ? AND id <> ?`).bind(id, aid)] : []),
    db.prepare(`UPDATE customer_addresses SET label=?, address=?, receiver_contact_id=?, delivery_note=?, is_default=?, active=? WHERE id=?`).bind(n.label, n.address, n.receiver_contact_id, n.delivery_note, n.is_default, n.active, aid),
    auditStmt(c, { action: "customer.address_update", entity: "customer", entityId: id, before: { addressId: aid, label: cur.label, address: cur.address, active: cur.active }, after: { addressId: aid, ...n } }),
  ]);
  return c.json(await customerDetail(c, id));
});

// ---------------------------------------------------------------- lịch sử M4-09
customerRoutes.get("/customers/:id/history", requirePerm("b2b.view"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  await loadCustomer(db, id);
  const orders = (
    await db
      .prepare(`SELECT id, code, status, delivery_date, total, created_at FROM orders WHERE customer_id = ? AND channel = 'b2b' ORDER BY id DESC LIMIT 100`)
      .bind(id)
      .all<any>()
  ).results;
  const invoices = (
    await db
      .prepare(`SELECT id, code, kind, issue_date, due_date, total, einvoice_status FROM invoices WHERE customer_id = ? AND status = 'open' ORDER BY id DESC LIMIT 100`)
      .bind(id)
      .all<any>()
  ).results;
  const rev = (
    await db
      .prepare(`SELECT substr(issue_date,1,7) AS month, SUM(total) AS revenue FROM invoices WHERE customer_id = ? AND status = 'open' GROUP BY 1 ORDER BY 1`)
      .bind(id)
      .all<any>()
  ).results;
  return c.json({
    orders: orders.map((o) => ({ id: o.id, code: o.code, status: o.status, deliveryDate: o.delivery_date, total: o.total, createdAt: o.created_at })),
    invoices: invoices.map((i) => ({ id: i.id, code: i.code, kind: i.kind, issueDate: i.issue_date, dueDate: i.due_date, total: i.total, einvoiceStatus: i.einvoice_status })),
    revenueByMonth: rev.map((r) => ({ month: r.month, revenue: r.revenue })),
    debt: await customerDebtStatus(db, id),
  });
});

// ---------------------------------------------------------------- giá riêng theo khách (EC-13)
const pricesSchema = z.object({
  items: z.array(z.object({ productId: z.number().int().positive(), unitPrice: z.number().int().min(0) })).min(1).max(500),
  note: z.string().trim().max(300).optional(),
});

customerRoutes.put("/customers/:id/prices", requirePerm("b2b.approve"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const cu = await loadCustomer(db, id);
  const b = await parse(c, pricesSchema);
  const ids = b.items.map((i) => i.productId);
  if (new Set(ids).size !== ids.length) throw new AppError(422, "validation_error", "Mặt hàng bị lặp trong danh sách");
  const found = await db.prepare(`SELECT id FROM products WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  if (found.results.length !== ids.length) throw new AppError(422, "invalid_product", "Có mặt hàng không tồn tại");
  let list = await db.prepare(`SELECT id FROM price_lists WHERE customer_id = ? AND kind = 'customer' ORDER BY id LIMIT 1`).bind(id).first<{ id: number }>();
  if (!list) {
    const r = await db
      .prepare(`INSERT INTO price_lists(name, channel, customer_group_id, kind, priority, customer_id) VALUES (?, 'b2b', NULL, 'customer', 100, ?)`)
      .bind(`Giá riêng ${cu.code}`, id)
      .run();
    list = { id: r.meta.last_row_id as number };
  }
  const from = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const i of b.items)
    stmts.push(
      db.prepare(`UPDATE prices SET effective_to = ? WHERE price_list_id = ? AND product_id = ? AND status = 'active' AND effective_to IS NULL AND effective_from <= ?`).bind(from, list.id, i.productId, from),
      db
        .prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by, approved_by, note) VALUES (?,?,?,?,'active',?,?,?)`)
        .bind(list.id, i.productId, i.unitPrice, from, user.id, user.id, b.note ?? null),
    );
  stmts.push(auditStmt(c, { action: "customer.prices", entity: "customer", entityId: id, after: { priceListId: list.id, items: b.items }, reason: b.note }));
  await guarded(() => db.batch(stmts));
  return c.json({ priceListId: list.id, effectiveFrom: from, items: b.items });
});
