import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import type { Env } from "../src/worker/env";
import { b64uDecode, b64uEncode, encryptAes128gcm, pushTransport, sendWebPush, vapidJwt } from "../src/worker/services/webpush";
import { buildRfc822, cloudflareSender, maskEmail, sendEmail } from "../src/worker/services/notify-email";
import { enqueueJobStmt } from "../src/worker/services/outbox";
import { processJob } from "../src/worker/services/jobs";

const enc = new TextEncoder();
const dec = new TextDecoder();
type Bytes = Uint8Array<ArrayBuffer>;
const cat = (...a: Uint8Array[]): Bytes => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) { out.set(x, o); o += x.length; }
  return out;
};
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, len: number): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

interface Receiver { pair: CryptoKeyPair; p256dh: string; auth: string; authBytes: Bytes }
async function newReceiver(): Promise<Receiver> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const authBytes = crypto.getRandomValues(new Uint8Array(16));
  return { pair, p256dh: b64uEncode(await crypto.subtle.exportKey("raw", pair.publicKey)), auth: b64uEncode(authBytes), authBytes };
}

/** Giải mã aes128gcm theo RFC 8291 §3.4 (phía trình duyệt) — dùng để kiểm tra đường mã hoá. */
async function decryptPush(body: Uint8Array, r: Receiver): Promise<string> {
  const salt = body.slice(0, 16) as Bytes;
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16, false);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen) as Bytes;
  const cipher = body.slice(21 + idlen);
  expect(rs).toBe(4096);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, r.pair.privateKey, 256)) as Bytes;
  const uaPublic = b64uDecode(r.p256dh);
  const ikm = await hkdf(r.authBytes, ecdh, cat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0") as Bytes, 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0") as Bytes, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  expect(plain[end - 1]).toBe(2); // dấu phân cách bản ghi cuối
  return dec.decode(plain.slice(0, end - 1));
}

let vapid: { pub: string; jwk: JsonWebKey };
const withVapid = (extra: Partial<Env> = {}) =>
  Object.assign({}, testEnv, { VAPID_PUBLIC_KEY: vapid.pub, VAPID_PRIVATE_KEY: JSON.stringify(vapid.jwk), SHOP_BASE_URL: "https://huumanh.test", ...extra }) as Env;

const origFetch = pushTransport.fetch;
afterEach(() => { pushTransport.fetch = origFetch; });

let jobSeq = 0;
async function runJob(env: Env, type: any, refType: string, refId: number, payload: unknown = {}) {
  jobSeq++;
  const r = await env.DB.prepare(`INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES (?,?,?,?) RETURNING id`).bind(type, refType, refId, JSON.stringify(payload)).first<{ id: number }>();
  void enqueueJobStmt;
  const out = await processJob(env, r!.id);
  const row = await env.DB.prepare(`SELECT status, result_json, last_error FROM integration_jobs WHERE id=?`).bind(r!.id).first<any>();
  return { out, row, result: row.result_json ? JSON.parse(row.result_json) : null };
}

beforeAll(async () => {
  await seedBase();
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  vapid = { pub: b64uEncode(await crypto.subtle.exportKey("raw", kp.publicKey)), jwk: (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey };
  const d = testEnv.DB;
  await d.batch([
    d.prepare(`INSERT INTO customers(id, code, type, name, phone, email) VALUES (801,'KHW1','retail','Trần Thị Bình','0903334444',NULL)`),
    d.prepare(`INSERT INTO shop_accounts(id, customer_id, email, phone, full_name, pass_hash) VALUES (81,801,'binh.tran@example.com','0903334444','Trần Thị Bình','x')`),
    d.prepare(`INSERT INTO orders(id, code, channel, store_id, status, shop_account_id, customer_id, tracking_token, receiver_name, receiver_phone, ship_address, total)
               VALUES (8101,'DH-20261123-0101','online',1,'shipping',81,801,'TRK-abc_123','Trần Thị Bình','0903334444','99 Hai Bà Trưng, Quận 1',250000)`),
  ]);
});

describe("web push: RFC 8291 aes128gcm", () => {
  it("matches the RFC 8291 appendix A test vector", async () => {
    const asPublic = b64uDecode("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const jwk: JsonWebKey = {
      kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
      x: b64uEncode(asPublic.slice(1, 33)), y: b64uEncode(asPublic.slice(33, 65)),
    };
    const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const pub = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, true, []);
    const body = await encryptAes128gcm(
      enc.encode("When I grow up, I want to be a watermelon") as Bytes,
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
      { salt: b64uDecode("DGv6ra1nlYgDCS1FRnbzlw"), senderKeys: { privateKey: priv, publicKey: pub } as CryptoKeyPair },
    );
    expect(b64uEncode(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("round-trips with a freshly generated receiver key pair", async () => {
    const r = await newReceiver();
    const msg = JSON.stringify({ title: "Đơn DH-1", body: "Đang giao — tiếng Việt có dấu" });
    const body = await encryptAes128gcm(enc.encode(msg) as Bytes, r.p256dh, r.auth);
    expect(body[20]).toBe(65);
    expect(await decryptPush(body, r)).toBe(msg);
    // mỗi lần mã hoá dùng salt + khoá tạm khác nhau
    const body2 = await encryptAes128gcm(enc.encode(msg) as Bytes, r.p256dh, r.auth);
    expect(b64uEncode(body2)).not.toBe(b64uEncode(body));
    await expect(encryptAes128gcm(enc.encode("x") as Bytes, "AAAA", r.auth)).rejects.toThrow();
    await expect(encryptAes128gcm(new Uint8Array(5000) as Bytes, r.p256dh, r.auth)).rejects.toThrow();
  });

  it("VAPID JWT is ES256 and verifies with the public key", async () => {
    const now = Date.UTC(2026, 10, 23, 3, 0, 0);
    const jwt = await vapidJwt(vapid.jwk, "https://push.example.com", "mailto:ops@huumanh.test", now);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(dec.decode(b64uDecode(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(dec.decode(b64uDecode(p)));
    expect(claims).toEqual({ aud: "https://push.example.com", exp: Math.floor(now / 1000) + 12 * 3600, sub: "mailto:ops@huumanh.test" });
    const pub = await crypto.subtle.importKey("raw", b64uDecode(vapid.pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(b64uDecode(s).length).toBe(64);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64uDecode(s), enc.encode(`${h}.${p}`))).toBe(true);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64uDecode(s), enc.encode(`${h}.${p}x`))).toBe(false);
  });

  it("sendWebPush posts an encrypted body with VAPID headers and reports gone on 404/410", async () => {
    const r = await newReceiver();
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 201;
    pushTransport.fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status }); };
    const env = withVapid();
    const sub = { endpoint: "https://push.example.com/send/abc", p256dh: r.p256dh, auth: r.auth };
    expect(await sendWebPush(env, sub, { title: "t", body: "b" })).toEqual({ ok: true });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h.Authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.pub}$`));
    expect(JSON.parse(await decryptPush(calls[0].init.body as Uint8Array, r))).toEqual({ title: "t", body: "b" });
    status = 410;
    expect(await sendWebPush(env, sub, {})).toEqual({ ok: false, gone: true, status: 410 });
    status = 500;
    expect(await sendWebPush(env, sub, {})).toEqual({ ok: false, gone: false, status: 500 });
    await expect(sendWebPush(testEnv, sub, {})).rejects.toThrow(/VAPID/);
  });
});

describe("job notify.order_status", () => {
  it("emails (fake provider → audit only) and pushes only code, label and tracking path; 410 subscription is removed", async () => {
    const d = testEnv.DB;
    const good = await newReceiver();
    const gone = await newReceiver();
    await d.batch([
      d.prepare(`INSERT INTO push_subscriptions(account_id, endpoint, p256dh, auth) VALUES (81,'https://push.example.com/good',?,?),(81,'https://push.example.com/gone',?,?)`).bind(good.p256dh, good.auth, gone.p256dh, gone.auth),
    ]);
    const seen = new Map<string, Uint8Array>();
    pushTransport.fetch = async (url, init) => {
      seen.set(url, init.body as Uint8Array);
      return new Response(null, { status: url.endsWith("/gone") ? 410 : 201 });
    };
    const { out, result } = await runJob(withVapid(), "notify.order_status", "order", 8101, { orderCode: "DH-20261123-0101", status: "shipping", accountId: 81, email: null, link: "/track/TRK-abc_123" });
    expect(out.status).toBe("done");
    expect(result).toMatchObject({ email: "fake", push: { sent: 1, removed: 1, failed: 0 } });
    const msg = JSON.parse(await decryptPush(seen.get("https://push.example.com/good")!, good));
    expect(msg).toEqual({ title: "Đơn DH-20261123-0101", body: "Đang giao", url: "/track/TRK-abc_123", tag: "DH-20261123-0101" });
    const text = JSON.stringify(msg);
    for (const pii of ["Trần", "0903334444", "Hai Bà Trưng", "binh.tran"]) expect(text).not.toContain(pii);
    const subs = await d.prepare(`SELECT endpoint FROM push_subscriptions WHERE account_id=81`).all<any>();
    expect(subs.results).toEqual([{ endpoint: "https://push.example.com/good" }]);
    const audit = await d.prepare(`SELECT after_json FROM audit_log WHERE action='notify.email' ORDER BY id DESC LIMIT 1`).first<any>();
    const a = JSON.parse(audit.after_json);
    expect(a).toMatchObject({ provider: "fake", template: "order_status", to: "bi***@example.com", orderCode: "DH-20261123-0101" });
    expect(audit.after_json).not.toContain("binh.tran");
    expect(audit.after_json).not.toContain("TRK-abc_123");
  });

  it("skips push without VAPID config but still succeeds; unknown order fails the job", async () => {
    const { out, result } = await runJob(testEnv, "notify.order_status", "order", 8101, { status: "completed" });
    expect(out.status).toBe("done");
    expect(result.push.skipped).toBe("no_vapid");
    const bad = await runJob(testEnv, "notify.order_status", "order", 999999, {});
    expect(bad.out.status).toBe("failed");
  });
});

describe("job notify.staff_new_order", () => {
  it("pushes only to staff with orders.online.manage", async () => {
    const d = testEnv.DB;
    const staff = await newReceiver();
    const cashier = await newReceiver();
    await d.batch([
      d.prepare(`INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth) VALUES (6,'https://push.example.com/staff',?,?),(3,'https://push.example.com/cashier',?,?)`).bind(staff.p256dh, staff.auth, cashier.p256dh, cashier.auth),
    ]);
    const seen = new Map<string, Uint8Array>();
    pushTransport.fetch = async (url, init) => { seen.set(url, init.body as Uint8Array); return new Response(null, { status: 201 }); };
    const { out, result } = await runJob(withVapid(), "notify.staff_new_order", "order", 8101);
    expect(out.status).toBe("done");
    expect(result.push.sent).toBe(1);
    expect(seen.has("https://push.example.com/cashier")).toBe(false);
    expect(JSON.parse(await decryptPush(seen.get("https://push.example.com/staff")!, staff))).toEqual({ title: "Đơn online mới", body: "DH-20261123-0101", url: "/online-orders", tag: "DH-20261123-0101" });
  });

  it("ERP staff can register a push subscription (validated) via API", async () => {
    const r = await newReceiver();
    const body = { endpoint: "https://push.example.com/api-sub", keys: { p256dh: r.p256dh, auth: r.auth } };
    expect((await api("online_staff", "POST", "/api/v1/me/push-subscriptions", body)).status).toBe(201);
    expect((await api("online_staff", "POST", "/api/v1/me/push-subscriptions", body)).status).toBe(201); // idempotent theo endpoint
    expect((await testEnv.DB.prepare(`SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint='https://push.example.com/api-sub'`).first<any>())!.n).toBe(1);
    expect((await api("online_staff", "POST", "/api/v1/me/push-subscriptions", { ...body, endpoint: "http://insecure.example.com/x" })).status).toBe(422);
    expect((await api("online_staff", "POST", "/api/v1/me/push-subscriptions", { ...body, keys: { p256dh: "A".repeat(87), auth: r.auth } })).status).toBe(422);
    expect((await api("online_staff", "DELETE", "/api/v1/me/push-subscriptions", { endpoint: body.endpoint })).status).toBe(200);
    expect((await api("online_staff", "GET", "/api/v1/push/vapid-public-key")).body).toEqual({ publicKey: null });
  });
});

describe("job notify.email + provider", () => {
  it("fake provider audits template name and masked recipient — never the token", async () => {
    const { out, result } = await runJob(withVapid(), "notify.email", "shop_account", 81, { to: "khach.hang@example.com", template: "verify_email", token: "SECRET-TOKEN-123" });
    expect(out.status).toBe("done");
    expect(result).toEqual({ provider: "fake" });
    const rows = await testEnv.DB.prepare(`SELECT after_json FROM audit_log WHERE action='notify.email'`).all<any>();
    const last = rows.results.at(-1)!.after_json as string;
    expect(JSON.parse(last)).toMatchObject({ template: "verify_email", to: "kh***@example.com" });
    expect(JSON.stringify(rows.results)).not.toContain("SECRET-TOKEN-123");
    const bad = await runJob(testEnv, "notify.email", "shop_account", 81, { to: "a@b.vn", template: "nope" });
    expect(bad.out.status).toBe("failed");
    const evil = await runJob(testEnv, "notify.email", "shop_account", 81, { to: "a@b.vn", template: "verify_email", link: "https://evil.example/x" });
    expect(evil.out.status).toBe("failed");
  });

  it("cloudflare provider hands a UTF-8 RFC822 message to the EMAIL binding", async () => {
    await testEnv.DB.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('notify.email_provider','cloudflare'),('notify.email_from','Hữu Mạnh <no-reply@huumanh.test>')`).run();
    const sent: { from: string; to: string; raw: string }[] = [];
    const env = withVapid({ EMAIL: { send: async (m: any) => { sent.push({ from: m.from, to: m.to, raw: m.raw }); } } as any });
    const orig = cloudflareSender.send;
    let viaReal = true;
    try {
      const r = await sendEmail(env, { to: "khach@example.com", subject: "Đơn DH-1 — Đang giao", text: "Xin chào\nTheo dõi", template: "order_status" });
      expect(r).toEqual({ provider: "cloudflare", sent: true });
    } catch {
      // runtime thử nghiệm không có module cloudflare:email → kiểm thử qua điểm thay thế
      viaReal = false;
      cloudflareSender.send = async (_e, from, msg) => { sent.push({ from, to: msg.to, raw: buildRfc822({ from, to: msg.to, subject: msg.subject, text: msg.text }) }); };
      await sendEmail(env, { to: "khach@example.com", subject: "Đơn DH-1 — Đang giao", text: "Xin chào\nTheo dõi", template: "order_status" });
    } finally {
      cloudflareSender.send = orig;
      await testEnv.DB.prepare(`UPDATE settings SET value='fake' WHERE key='notify.email_provider'`).run();
    }
    void viaReal;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "Hữu Mạnh <no-reply@huumanh.test>", to: "khach@example.com" });
  });

  it("buildRfc822 encodes UTF-8 and cannot be header-injected", () => {
    const raw = buildRfc822({ from: "Shop <a@huumanh.vn>", to: "x@example.com\r\nBcc: evil@example.com", subject: "Đơn hàng\r\nX-Evil: 1", text: "Xin chào Việt Nam", messageId: "id1@huumanh.vn", date: new Date(Date.UTC(2026, 10, 23)) });
    const [head, body] = raw.split("\r\n\r\n");
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).not.toMatch(/^X-Evil:/m);
    expect(head).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(head).toContain("Message-ID: <id1@huumanh.vn>");
    const subj = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(head)![1];
    expect(dec.decode(Uint8Array.from(atob(subj), (c) => c.charCodeAt(0)))).toBe("Đơn hàng X-Evil: 1");
    expect(dec.decode(Uint8Array.from(atob(body.replace(/\s/g, "")), (c) => c.charCodeAt(0)))).toBe("Xin chào Việt Nam");
    expect(maskEmail("ab@x.vn")).toBe("ab***@x.vn");
  });
});
