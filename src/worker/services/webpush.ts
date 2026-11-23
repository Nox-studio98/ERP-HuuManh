/**
 * Web Push (RFC 8030) + mã hoá nội dung aes128gcm (RFC 8291) + VAPID (RFC 8292) bằng WebCrypto thuần.
 * Khoá: VAPID_PUBLIC_KEY = raw P-256 (65 byte) base64url; VAPID_PRIVATE_KEY = JWK JSON.
 */
import type { Env } from "../env";

const enc = new TextEncoder();

export const b64uEncode = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
export const b64uDecode = (s: string): Bytes => {
  const t = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
type Bytes = Uint8Array<ArrayBuffer>;
const concat = (...a: Uint8Array[]): Bytes => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) { out.set(x, o); o += x.length; }
  return out;
};

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, len: number): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

/** Mã hoá một bản tin cho một subscription (p256dh, auth dạng base64url). Trả body `aes128gcm` (một record). */
export async function encryptAes128gcm(
  plaintext: Bytes,
  p256dh: string,
  auth: string,
  opts: { salt?: Bytes; senderKeys?: CryptoKeyPair } = {},
): Promise<Bytes> {
  const uaPublic = b64uDecode(p256dh);
  const authSecret = b64uDecode(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh không hợp lệ");
  const sender = opts.senderKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic: Bytes = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh: Bytes = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, sender.privateKey, 256));
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const rs = 4096;
  if (plaintext.length > rs - 17) throw new Error("Nội dung push quá dài");
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = bản ghi cuối
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher: Bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

/** JWT ES256 cho VAPID (aud = origin của push service). */
export async function vapidJwt(privateJwk: JsonWebKey, aud: string, subject: string, now = Date.now(), ttlSec = 12 * 3600): Promise<string> {
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64uEncode(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + ttlSec, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig: Bytes = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64uEncode(sig)}`; // WebCrypto trả sẵn r||s 64 byte đúng định dạng JWS
}

/** Cho phép test thay thế đường gửi mạng. */
export const pushTransport = { fetch: (input: string, init: RequestInit) => fetch(input, init) };

export interface PushSub { endpoint: string; p256dh: string; auth: string }
export type PushResult = { ok: true } | { ok: false; gone: boolean; status: number };

export const pushConfigured = (env: Env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

/** Gửi push. `gone` = endpoint trả 404/410 → người gọi phải xoá subscription. */
export async function sendWebPush(env: Env, sub: PushSub, message: unknown, now = Date.now()): Promise<PushResult> {
  if (!pushConfigured(env)) throw new Error("Chưa cấu hình VAPID");
  const jwk = JSON.parse(env.VAPID_PRIVATE_KEY!) as JsonWebKey;
  const aud = new URL(sub.endpoint).origin;
  const subject = env.VAPID_SUBJECT ?? (env.SHOP_BASE_URL?.startsWith("https://") ? env.SHOP_BASE_URL : "mailto:admin@huumanh.vn");
  const jwt = await vapidJwt(jwk, aud, subject, now);
  const body = await encryptAes128gcm(enc.encode(JSON.stringify(message)), sub.p256dh, sub.auth);
  const res = await pushTransport.fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body,
  });
  if (res.ok) return { ok: true };
  return { ok: false, gone: res.status === 404 || res.status === 410, status: res.status };
}
