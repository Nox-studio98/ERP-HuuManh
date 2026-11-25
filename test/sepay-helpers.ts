import { app } from "../src/worker/index";
import { sepaySign } from "../src/worker/services/sepay";
import { testEnv } from "./helpers";
import { call, checkoutBody } from "./shop-helpers";

export const SECRET = "whsec_sepay_test";
export const ACCOUNT = "0123456789";
export const vnNow = (offsetMs = 0) => new Date(Date.now() + 7 * 3600_000 + offsetMs).toISOString().slice(0, 19).replace("T", " ");
let seq = 1000 + Math.floor(Math.random() * 1000);
export const nextId = () => ++seq;

export interface Tx { id: number; gateway: string; transactionDate: string; accountNumber: string; subAccount: string; code: string | null; content: string; transferType: string; description: string; transferAmount: number; accumulated: number; referenceCode: string }
export const tx = (code: string | null, amount: number, over: Partial<Tx> = {}): Tx => {
  const id = nextId();
  return { id, gateway: "Vietcombank", transactionDate: vnNow(), accountNumber: ACCOUNT, subAccount: "", code, content: `${code ?? ""} chuyen khoan`, transferType: "in", description: "", transferAmount: amount, accumulated: 0, referenceCode: `FT${id}`, ...over };
};

/** Gửi webhook giả có chữ ký đúng (hoặc chỉnh qua `o`). */
export async function hook(payload: unknown, o: { secret?: string; ts?: number; sig?: string; raw?: string; env?: Record<string, unknown>; noHeaders?: boolean } = {}) {
  const raw = o.raw ?? JSON.stringify(payload);
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const sig = o.sig ?? (await sepaySign(o.secret ?? SECRET, ts, raw));
  const res = await app.request(
    "/api/integrations/sepay/webhook",
    { method: "POST", headers: { "content-type": "application/json", ...(o.noHeaders ? {} : { "x-sepay-signature": sig, "x-sepay-timestamp": String(ts) }) }, body: raw },
    { ...testEnv, SEPAY_WEBHOOK_SECRET: SECRET, ...o.env } as any,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export const db = () => testEnv.DB;
export async function enableSepay(extra: Record<string, string> = {}) {
  const set = { "sepay.enabled": "1", ...extra };
  for (const [k, v] of Object.entries(set)) await db().prepare(`INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`).bind(k, v).run();
}
export const event = (sepayId: number) => db().prepare(`SELECT * FROM sepay_events WHERE sepay_id = ?`).bind(sepayId).first<any>();

/** Đơn website chuyển khoản (170.000đ) đang chờ thanh toán. */
export async function webOrder() {
  const r = await call("POST", "/api/checkout", checkoutBody({ paymentMethod: "transfer" }));
  if (r.status !== 201) throw new Error("checkout " + r.status + r.text);
  return r.body as { code: string; total: number };
}
