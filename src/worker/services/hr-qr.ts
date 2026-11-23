import { timingSafeEqual } from "../lib/crypto";

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** Cửa sổ thời gian của mã QR: floor(epoch giây / độ dài cửa sổ). */
export const qrWindowOf = (nowMs: number, windowSeconds: number) => Math.floor(nowMs / 1000 / windowSeconds);
export const qrWindowExpiresAt = (window: number, windowSeconds: number) => new Date((window + 1) * windowSeconds * 1000).toISOString();

async function sign(secret: string, storeId: number, window: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${storeId}|${window}`));
  return b64u(sig).slice(0, 16);
}

/** code = storeId.window.base64url(HMAC-SHA256(secret, "storeId|window"))[0..16] */
export async function makeQrCode(secret: string, storeId: number, window: number): Promise<string> {
  return `${storeId}.${window}.${await sign(secret, storeId, window)}`;
}

/** Hợp lệ khi đúng cửa hàng, đúng chữ ký và thuộc cửa sổ hiện tại hoặc liền trước. */
export async function verifyQrCode(
  secret: string,
  code: string,
  storeId: number,
  nowMs: number,
  windowSeconds: number,
): Promise<{ ok: true; window: number } | { ok: false }> {
  const parts = code.trim().split(".");
  if (parts.length !== 3) return { ok: false };
  const sid = Number(parts[0]);
  const win = Number(parts[1]);
  if (!Number.isInteger(sid) || !Number.isInteger(win) || sid !== storeId) return { ok: false };
  const cur = qrWindowOf(nowMs, windowSeconds);
  if (win !== cur && win !== cur - 1) return { ok: false };
  const expect = await sign(secret, sid, win);
  if (!timingSafeEqual(enc.encode(expect), enc.encode(parts[2]))) return { ok: false };
  return { ok: true, window: win };
}
