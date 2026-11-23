import { env } from "cloudflare:workers";
import { app } from "../src/worker/index";
import { hashPassword } from "../src/worker/lib/crypto";
import type { Env, Role } from "../src/worker/env";

export const testEnv = env as unknown as Env;
export const PASSWORD = "Test-Password-123";

let pwHash: string | null = null;

/**
 * Dữ liệu nền tối thiểu cho test: 1 cửa hàng, 2 vị trí (quầy bán được, kho hỏng không bán), 1 quỹ tiền mặt,
 * nhóm khách 'le', bảng giá cơ bản POS, 1 user cho mỗi vai trò (username = tên vai trò).
 */
export async function seedBase() {
  const db = testEnv.DB;
  const exists = await db.prepare(`SELECT id FROM stores WHERE code='CH1'`).first();
  if (exists) return;
  pwHash ??= await hashPassword(PASSWORD);
  const roles: Role[] = ["owner", "manager", "cashier", "warehouse", "accountant", "online_staff"];
  await db.batch([
    db.prepare(`INSERT INTO stores(id, code, name) VALUES (1,'CH1','Hữu Mạnh - Cửa hàng 1')`),
    db.prepare(`INSERT INTO locations(id, store_id, code, name, sellable) VALUES (1,1,'QUAY','Quầy',1),(2,1,'HONG','Khu hàng hỏng',0)`),
    db.prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (1,1,'TM-CH1','Tiền mặt quầy','cash'),(2,1,'NH-VCB','Ngân hàng','bank')`),
    db.prepare(`INSERT INTO customer_groups(id, code, name) VALUES (1,'le','Khách lẻ'),(2,'si_1','Sỉ cấp 1')`),
    db.prepare(`INSERT INTO price_lists(id, name, channel, kind, priority) VALUES (1,'Giá chung','all','base',0)`),
    db.prepare(`INSERT INTO product_groups(id, name) VALUES (1,'Trái cây nhập'),(2,'Trái cây nội')`),
    db.prepare(
      `INSERT INTO cash_categories(code, name, direction, pnl_line) VALUES
        ('BAN_HANG','Thu tiền bán hàng','in','revenue'),('TIEN_HANG','Chi tiền hàng','out','cogs'),
        ('MAT_BANG','Mặt bằng','out','opex'),('DIEN_NUOC','Điện nước','out','opex'),
        ('LUONG','Lương','out','payroll'),('VAN_CHUYEN','Vận chuyển','out','opex'),('HAO_HUT','Hao hụt','out','shrinkage')`,
    ),
    ...roles.map((r, i) =>
      db.prepare(`INSERT INTO users(id, username, full_name, pass_hash, role, store_id) VALUES (?,?,?,?,?,1)`).bind(i + 1, r, `Test ${r}`, pwHash, r),
    ),
  ]);
}

const tokens = new Map<string, string>();

export async function login(username: Role | string) {
  const cached = tokens.get(username);
  if (cached) return cached;
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  }, testEnv);
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${await res.text()}`);
  const { token } = (await res.json()) as { token: string };
  tokens.set(username, token);
  return token;
}

/** Gọi API với vai trò cho trước. Trả về { status, body }. */
export async function api<T = any>(role: Role | string, method: string, path: string, body?: unknown) {
  const token = await login(role);
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

export function resetTokens() {
  tokens.clear();
}
