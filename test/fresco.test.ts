import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/worker/index";
import { api, seedBase, testEnv } from "./helpers";
import { hmacSha256Hex } from "../src/worker/services/fresco";

const SECRET = "test-fresco-secret";
const env = { ...testEnv, FRESCO_WEBHOOK_SECRET: SECRET } as typeof testEnv;
const URL_ = "/api/integrations/fresco/webhook";
let n = 0;

async function post(body: unknown, opts: { secret?: string; ts?: number; sig?: string | null; raw?: string; env?: typeof testEnv } = {}) {
  const raw = opts.raw ?? JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "content-type": "application/json", "x-fresco-timestamp": ts };
  if (opts.sig !== null) headers["x-fresco-signature"] = opts.sig ?? "sha256=" + (await hmacSha256Hex(opts.secret ?? SECRET, raw));
  const res = await app.request(URL_, { method: "POST", headers, body: raw }, opts.env ?? env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const evt = (items: any[], extra: any = {}, eventId = `evt-${++n}`) => ({
  eventId, type: "order.created",
  data: { orderId: `FR-${1000 + n}`, createdAt: "2026-11-23T03:00:00Z", buyer: { name: "Chị Lan", phone: "0900000000", address: "1 Lê Lợi" }, shippingFee: 15000, items, ...extra },
});
const q = (sql: string, ...a: unknown[]) => testEnv.DB.prepare(sql).bind(...a);

beforeAll(async () => {
  await seedBase();
  const db = testEnv.DB;
  await db.batch([
    db.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (501,'CAM','Cam sành','kg'),(502,'TAO','Táo Envy','kg')`),
    db.prepare(`INSERT INTO product_units(product_id, unit, factor_milli) VALUES (501,'thung',10000)`),
    db.prepare(`INSERT INTO lots(lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES ('L-CAM',501,1,'2026-11-20T00:00:00Z','2027-12-01T00:00:00Z',30000,50000,50000),('L-TAO',502,1,'2026-11-20T00:00:00Z','2027-12-01T00:00:00Z',40000,3000,3000)`),
  ]);
  await api("owner", "PUT", "/api/v1/fresco/products", { mappings: [{ externalSku: "FR-CAM", productId: 501, unit: "kg" }, { externalSku: "FR-CAM-BOX", productId: 501, unit: "thung" }, { externalSku: "FR-TAO", productId: 502, unit: "kg" }] });
});

describe("webhook gate + signature", () => {
  it("returns 404 while fresco.enabled=0 (even with a valid signature)", async () => {
    const r = await post(evt([{ sku: "FR-CAM", qty: 1, price: 50000 }]));
    expect(r.status).toBe(404);
  });

  it("rejects bad/missing signature and stale timestamps once enabled", async () => {
    await api("owner", "PUT", "/api/v1/integrations/settings", { frescoEnabled: true });
    const body = evt([{ sku: "FR-CAM", qty: 1, price: 50000 }]);
    expect((await post(body, { secret: "wrong" })).status).toBe(401);
    expect((await post(body, { sig: null })).status).toBe(401);
    expect((await post(body, { sig: "sha256=zz" })).status).toBe(401);
    expect((await post(body, { ts: Math.floor(Date.now() / 1000) - 400 })).status).toBe(401);
    expect((await post(body, { ts: Math.floor(Date.now() / 1000) + 400 })).status).toBe(401);
    // chữ ký đúng cho body khác
    const raw = JSON.stringify(body);
    expect((await post(body, { raw: raw + " ", sig: "sha256=" + (await hmacSha256Hex(SECRET, raw)) })).status).toBe(401);
    expect((await q(`SELECT COUNT(*) n FROM webhook_events WHERE source='fresco'`).first<{ n: number }>())!.n).toBe(0);
    // chưa cấu hình secret → 500 không lộ
    expect((await post(body, { env: testEnv })).status).toBe(500);
  });

  it("needs no session cookie (public) but rejects oversize bodies", async () => {
    const big = JSON.stringify({ eventId: "big", type: "x", pad: "a".repeat(300 * 1024) });
    expect((await post(null, { raw: big })).status).toBe(422);
  });
});

describe("order creation", () => {
  it("creates a confirmed order with reservation, marketplace prices and unit conversion", async () => {
    const e = evt([{ sku: "FR-CAM", qty: 2.5, price: 52000 }, { sku: "FR-CAM-BOX", qty: 1, price: 480000 }]);
    const r = await post(e);
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe("confirmed");
    const o = (await q(`SELECT * FROM orders WHERE id=?`, r.body.order.id).first<any>())!;
    expect(o).toMatchObject({ channel: "fresco", external_source: "fresco", external_id: e.data.orderId, status: "confirmed", subtotal: 130000 + 480000, shipping_fee: 15000, total: 625000 });
    expect(o.code).toMatch(/^FR-/);
    const lines = (await q(`SELECT * FROM order_lines WHERE order_id=? ORDER BY id`, o.id).all<any>()).results;
    expect(lines.map((l) => [l.qty_milli, l.unit_price, l.line_total])).toEqual([[2500, 52000, 130000], [10000, 48000, 480000]]);
    const resv = (await q(`SELECT SUM(qty_milli) s FROM reservations WHERE order_id=? AND status='active'`, o.id).first<{ s: number }>())!;
    expect(resv.s).toBe(12500);
    expect((await q(`SELECT qty_reserved_milli r FROM lots WHERE lot_code='L-CAM'`).first<{ r: number }>())!.r).toBe(12500);
    expect((await q(`SELECT COUNT(*) n FROM audit_log WHERE action='fresco.order_confirmed' AND entity_id=?`, String(o.id)).first<{ n: number }>())!.n).toBe(1);
  });

  it("is idempotent on eventId and on orderId", async () => {
    const e = evt([{ sku: "FR-CAM", qty: 1, price: 50000 }]);
    const a = await post(e);
    expect(a.body.order.duplicate).toBe(false);
    const b = await post(e);
    expect(b.body).toEqual({ ok: true, duplicate: true });
    // cùng orderId, event khác (Fresco gửi lại)
    const c = await post({ ...e, eventId: "another-event" });
    expect(c.body.order.duplicate).toBe(true);
    expect(c.body.order.id).toBe(a.body.order.id);
    expect((await q(`SELECT COUNT(*) n FROM orders WHERE external_id=?`, e.data.orderId).first<{ n: number }>())!.n).toBe(1);
    expect((await q(`SELECT SUM(qty_milli) s FROM reservations WHERE order_id=?`, a.body.order.id).first<{ s: number }>())!.s).toBe(1000);
  });

  it("unknown SKU → order stays new, no reservation, warning audited", async () => {
    const r = await post(evt([{ sku: "FR-CAM", qty: 1, price: 50000 }, { sku: "FR-LA", qty: 3, price: 10000 }]));
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe("new");
    expect(r.body.order.warnings[0]).toContain("FR-LA");
    const o = (await q(`SELECT * FROM orders WHERE id=?`, r.body.order.id).first<any>())!;
    expect(o.status).toBe("new");
    expect(o.note).toContain("FR-LA");
    expect((await q(`SELECT COUNT(*) n FROM reservations WHERE order_id=?`, o.id).first<{ n: number }>())!.n).toBe(0);
    expect((await q(`SELECT COUNT(*) n FROM audit_log WHERE action='fresco.order_warning' AND entity_id=?`, String(o.id)).first<{ n: number }>())!.n).toBe(1);
  });

  it("insufficient stock → order new, nothing reserved", async () => {
    const before = (await q(`SELECT qty_reserved_milli r FROM lots WHERE lot_code='L-TAO'`).first<{ r: number }>())!.r;
    const r = await post(evt([{ sku: "FR-TAO", qty: 10, price: 90000 }]));
    expect(r.body.order.status).toBe("new");
    expect(r.body.order.warnings.join()).toContain("tồn");
    expect((await q(`SELECT qty_reserved_milli r FROM lots WHERE lot_code='L-TAO'`).first<{ r: number }>())!.r).toBe(before);
    expect((await q(`SELECT COUNT(*) n FROM reservations WHERE order_id=?`, r.body.order.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("ignores other event types and validates payload (and lets a bad payload be retried)", async () => {
    const r = await post({ eventId: "e-ping", type: "ping" });
    expect(r.body.ignored).toBe(true);
    const bad = await post({ eventId: "e-bad", type: "order.created", data: { orderId: "X", items: [] } });
    expect(bad.status).toBe(422);
    expect((await q(`SELECT COUNT(*) n FROM webhook_events WHERE event_id='e-bad'`).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("CSV import + product mapping", () => {
  const csv = [
    "order_id,created_at,sku,qty,unit_price,shipping_fee,buyer_name",
    'CSV-1,2026-11-23,FR-CAM,2,50000,12000,"Nguyễn, Văn A"',
    "CSV-1,2026-11-23,FR-TAO,1,90000,12000,Nguyễn Văn A",
    "CSV-2,2026-11-23,FR-CAM,1,50000,0,Trần B",
    "CSV-3,2026-11-23,FR-CAM,abc,50000,0,Lỗi",
  ].join("\n");

  it("requires orders.online.manage, imports through the same core, is idempotent", async () => {
    expect((await api("cashier", "POST", "/api/v1/fresco/orders/import", { csv })).status).toBe(403);
    const r = await api("online_staff", "POST", "/api/v1/fresco/orders/import", { csv });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items.every((i: any) => i.status === "confirmed")).toBe(true);
    expect(r.body.errors).toHaveLength(1);
    const o = (await q(`SELECT * FROM orders WHERE external_id='CSV-1'`).first<any>())!;
    expect(o).toMatchObject({ channel: "fresco", total: 100000 + 90000 + 12000, created_by: 6 });
    expect(o.note).toContain("Nguyễn, Văn A");
    const again = await api("online_staff", "POST", "/api/v1/fresco/orders/import", { csv });
    expect(again.body.imported).toBe(0);
    expect(again.body.items.every((i: any) => i.duplicate)).toBe(true);
  });

  it("product mapping endpoints are permission-gated and validated", async () => {
    expect((await api("online_staff", "GET", "/api/v1/fresco/products")).status).toBe(403);
    const g = await api("owner", "GET", "/api/v1/fresco/products");
    expect(g.body.items.find((i: any) => i.externalSku === "FR-CAM")).toMatchObject({ productId: 501, unit: "kg", productSku: "CAM" });
    expect((await api("owner", "PUT", "/api/v1/fresco/products", { mappings: [{ externalSku: "Z", productId: 501, unit: "hop" }] })).status).toBe(422);
    expect((await api("owner", "PUT", "/api/v1/fresco/products", { mappings: [{ externalSku: "Z", productId: 99999, unit: "kg" }] })).status).toBe(422);
    expect((await api("owner", "PUT", "/api/v1/fresco/products", { mappings: [{ externalSku: "FR-NEW", productId: 502, unit: "kg" }] })).status).toBe(200);
    expect((await api("owner", "PUT", "/api/v1/fresco/products", { remove: ["FR-NEW"] })).status).toBe(200);
  });
});
