import { api, seedBase } from "./helpers";
import { call, testEnv } from "./shop-helpers";
import { mkProduct, mkSupplier } from "./po-helpers";

export { api, call, testEnv };
export const V = "/api/v1";
export const NCC_PW = "NccMatkhau-2026";
/** Mật khẩu giả cho test đổi mật khẩu (không phải bí mật thật). */
export const NCC_PW_NEW = "MatKhauMoi-12345";
export const NCC_PW_NEW_B = "MatKhauMoiAAA-1";
export const NCC_PW_WRONG = "SaiSaiSai-1234";
export const db = () => testEnv.DB;

/** Phiên cổng NCC: header Cookie + CSRF. */
export type NccSession = { headers: Record<string, string>; account: any };

export const tokenOf = (path: string) => path.slice(path.indexOf("#") + 1);

/** Mời từ ERP (quản lý) → trả link (token chỉ có trong response). */
export async function invite(supplierId: number, email: string, fullName = "Nhân viên NCC") {
  const r = await api("manager", "POST", `${V}/suppliers/${supplierId}/portal/invites`, { fullName, email });
  if (r.status !== 201) throw new Error("invite " + r.status + JSON.stringify(r.body));
  return r.body as { account: any; invite: { id: number; path: string; link: string | null; expiresAt: string } };
}

export function cookieOf(res: Response) {
  const m = /__Host-ncc=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  return m ? m[1] : null;
}

export async function loginNcc(email: string, password = NCC_PW, env?: Record<string, unknown>): Promise<NccSession> {
  const r = await call("POST", "/api/ncc/auth/login", { email, password }, { env });
  if (r.status !== 200) throw new Error("ncc login " + r.status + r.text);
  return { headers: { cookie: `__Host-ncc=${cookieOf(r.res)}`, "x-requested-with": "hm-shop" }, account: r.body.account };
}

/** Mời + đặt mật khẩu (như người dùng thật) + đăng nhập. */
export async function mkNcc(supplierId: number, email: string, password = NCC_PW) {
  const inv = await invite(supplierId, email);
  const r = await call("POST", "/api/ncc/auth/accept", { token: tokenOf(inv.invite.path), password });
  if (r.status !== 200) throw new Error("accept " + r.status + r.text);
  return loginNcc(email, password);
}

export const ncc = (s: NccSession, method: string, path: string, body?: unknown) => call(method, `/api/ncc${path}`, body, { headers: s.headers });

/** PO tay đã gửi cho NCC (chưa phản hồi). */
export async function mkSentPo(supplierId: number, lines: { productId: number; qty: number; unitCost?: number }[], opts: { note?: string; expectedDate?: string } = {}) {
  const c = await api("manager", "POST", `${V}/purchase-orders`, { supplierId, lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: l.unitCost ?? 30000 })), ...opts });
  if (c.status !== 201) throw new Error("create po " + c.status + JSON.stringify(c.body));
  const a = await api("manager", "POST", `${V}/purchase-orders/${c.body.id}/approve`, {});
  if (a.status !== 200 || a.body.status !== "sent") throw new Error("approve " + a.status + JSON.stringify(a.body));
  return (await api("manager", "GET", `${V}/purchase-orders/${c.body.id}`)).body as any;
}

export async function mkDraftPo(supplierId: number, productId: number, qty = 5) {
  const c = await api("manager", "POST", `${V}/purchase-orders`, { supplierId, lines: [{ productId, qty, unitCost: 31000 }] });
  return c.body as any;
}

export { seedBase, mkProduct, mkSupplier };
