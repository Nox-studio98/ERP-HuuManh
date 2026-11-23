import { app } from "../src/shop/worker/index";
import { seedBase, testEnv } from "./helpers";
import { addDays } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";

export { testEnv };
export const tomorrow = () => addDays(vnDate(), 1);
export const today = () => vnDate();
const baseEnv = (over: Record<string, unknown> = {}) => ({ ...testEnv, APP_ENV: "dev", JOBS: undefined, ...over }) as any;

export interface CallOpts {
  headers?: Record<string, string>;
  env?: Record<string, unknown>;
  raw?: string;
}

export async function call<T = any>(method: string, path: string, body?: unknown, o: CallOpts = {}) {
  const headers: Record<string, string> = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...o.headers };
  const res = await app.request(path, { method, headers, body: o.raw ?? (body === undefined ? undefined : JSON.stringify(body)) }, baseEnv(o.env));
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* không phải JSON */ }
  return { status: res.status, body: json as T, text, res };
}

/** Khách đăng nhập: trả header Cookie + CSRF dùng cho các request sau. */
export async function register(email: string, password = "Matkhau-123", phone = "0912345678") {
  const r = await call("POST", "/api/auth/register", { fullName: "Khách Test", email, phone, password });
  if (r.status !== 201) throw new Error("register " + r.status + r.text);
  return login(email, password);
}

export async function login(email: string, password = "Matkhau-123") {
  const r = await call("POST", "/api/auth/login", { email, password });
  if (r.status !== 200) throw new Error("login " + r.status + r.text);
  const m = /__Host-hm_shop=([^;]+)/.exec(r.res.headers.get("set-cookie") ?? "");
  return { headers: { cookie: `__Host-hm_shop=${m![1]}`, "x-requested-with": "hm-shop" } as Record<string, string>, account: r.body.account };
}

let seeded = false;
export async function seedShop() {
  await seedBase();
  if (seeded) return;
  seeded = true;
  const d = testEnv.DB;
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 20 * 86400_000).toISOString();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight, origin, group_id, slug, description, images_json, published_online, featured, allow_preorder) VALUES
      (901,'S901','Cam sành','kg',0,'Vĩnh Long',2,'cam-sanh','Cam ngọt','["products/901/a.webp"]',1,1,0),
      (902,'S902','Dâu Đà Lạt','kg',0,'Đà Lạt',2,'dau-da-lat','Dâu tươi',NULL,1,0,1),
      (903,'S903','Táo ẩn','kg',0,NULL,1,'tao-an',NULL,NULL,0,0,0),
      (904,'S904','Xoài không giá','kg',0,NULL,1,'xoai',NULL,NULL,1,0,0),
      (905,'S905','Nho cân','kg',1,'Mỹ',1,'nho-can',NULL,NULL,1,0,0),
      (906,'S906','Mít hết hàng','kg',0,NULL,1,'mit-het',NULL,NULL,1,0,0)`),
    d.prepare(`INSERT INTO product_units(product_id, unit, factor_milli) VALUES (901,'thung',10000)`),
    d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES
      (901,'SL-901',901,1,?1,?2,30000,300000,300000),(902,'SL-902',902,1,?1,?2,100000,2000,2000),
      (903,'SL-903',903,1,?1,?2,30000,10000,10000),(905,'SL-905',905,1,?1,?2,80000,10000,10000)`).bind(now, later),
    d.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES
      (1,901,50000,'2020-01-01T00:00:00Z','active',1),(1,902,200000,'2020-01-01T00:00:00Z','active',1),(1,903,10000,'2020-01-01T00:00:00Z','active',1),
      (1,905,150000,'2020-01-01T00:00:00Z','active',1),(1,906,20000,'2020-01-01T00:00:00Z','active',1)`),
    d.prepare(`INSERT INTO delivery_zones(id, name, districts_json, fee, free_over, min_order) VALUES
      (1,'Nội thành','["Quận 1","Quận 3","Bình Thạnh"]',20000,300000,100000)`),
    d.prepare(`INSERT INTO delivery_slots(id, label, start_time, end_time, cutoff_minutes, capacity) VALUES
      (1,'8:00–10:00','08:00','10:00',90,50),(2,'10:00–12:00','10:00','12:00',90,1),(3,'Sớm','00:00','01:00',90,50)`),
    d.prepare(`INSERT INTO cms_banners(id, title, image_key, link_url) VALUES (1,'Khuyến mãi','cms/b1.webp','/san-pham'),(2,'Xấu','cms/b2.webp','https://evil.example')`),
    d.prepare(`INSERT INTO cms_posts(id, slug, title, excerpt, body_md, status, published_at) VALUES
      (1,'mua-cam','Mùa cam','Tóm tắt','# Cam','published','2026-11-01T00:00:00Z'),(2,'nhap','Nháp','x','y','draft',NULL)`),
    d.prepare(`UPDATE settings SET value='0123456789' WHERE key='payment.bank_account'`),
    d.prepare(`UPDATE settings SET value='HUU MANH' WHERE key='payment.bank_account_name'`),
  ]);
}

let seq = 0;
export const uuid = () => `shop-test-${Date.now()}-${++seq}`;

export const ADDR = { receiverName: "Nguyễn Văn A", receiverPhone: "0901234567", addressLine: "12 Lê Lợi", ward: "Bến Nghé", district: "Quận 1", province: "TP.HCM" };

/** Body checkout hợp lệ (giỏ 3 kg cam = 150.000đ → phí giao 20.000đ). */
export function checkoutBody(over: Record<string, unknown> = {}) {
  return {
    clientUuid: uuid(),
    items: [{ productId: 901, unit: "kg", qty: 3, expectedUnitPrice: 50000 }],
    address: ADDR, slotDate: tomorrow(), slotId: 1, paymentMethod: "cod", ...over,
  };
}

export const lot = async (id: number) => (await testEnv.DB.prepare(`SELECT qty_on_hand_milli h, qty_reserved_milli r FROM lots WHERE id=?`).bind(id).first<{ h: number; r: number }>())!;
