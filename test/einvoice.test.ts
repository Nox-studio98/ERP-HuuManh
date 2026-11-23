import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/index";
import { api, login, seedBase, testEnv } from "./helpers";
import { insertInvoice } from "./integration-helpers";
import { FakeProvider, MisaProvider, buildMisaPayload, getProvider, loadInvoiceDoc, misaConfigFromEnv } from "../src/worker/services/einvoice";
import { processJob } from "../src/worker/services/jobs";
import { enqueueJobStmt } from "../src/worker/services/outbox";

const MISA_ENV = { MISA_BASE_URL: "https://misa.example.test/", MISA_APP_ID: "app-id-123", MISA_TAX_CODE: "0312345678", MISA_USERNAME: "shop-user", MISA_PASSWORD: "Sup3r-Secret-Pw" };
const misaEnv = () => ({ ...testEnv, ...MISA_ENV }) as typeof testEnv;

beforeAll(seedBase);
afterEach(() => vi.restoreAllMocks());

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("providers", () => {
  it("FakeProvider returns TEST- numbers", async () => {
    const id = await insertInvoice();
    const doc = (await loadInvoiceDoc(testEnv.DB, id))!;
    const r = await new FakeProvider().issue(doc);
    expect(r.einvoiceNo).toMatch(/^TEST-\d{6}$/);
    expect(r.series).toBeTruthy();
    expect(r.lookupCode).toBeTruthy();
    expect(await getProvider(testEnv)).toBeInstanceOf(FakeProvider);
  });

  it("buildMisaPayload maps invoice and lines", async () => {
    const id = await insertInvoice({ total: 100000 });
    const doc = (await loadInvoiceDoc(testEnv.DB, id))!;
    const p = buildMisaPayload(doc);
    expect(p.RefID).toBe(doc.code);
    expect(p.TotalAmount).toBe(100000);
    expect(p.BuyerLegalName).toBe("Công ty Test");
    expect(p.OriginalInvoiceDetails).toHaveLength(1);
    expect(p.OriginalInvoiceDetails[0]).toMatchObject({ ItemName: "Cam sành", Quantity: 2, Amount: 100000 });
  });

  it("MisaProvider: gets a token then publishes (mocked fetch, no network)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith("/api/v2/Account/Token")) return jsonRes({ Success: true, Data: "tok-abc" });
      if (url.endsWith("/api/v2/Invoice/Publish")) {
        expect(init.headers.authorization).toBe("Bearer tok-abc");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return jsonRes({ Success: true, Data: { InvoiceNo: "0000123", InvoiceSeries: "1C26TAA", TransactionID: "TX-9" } });
      }
      return jsonRes({}, 404);
    });
    const cfg = misaConfigFromEnv(misaEnv())!;
    expect(cfg.baseUrl).toBe("https://misa.example.test");
    const id = await insertInvoice();
    const r = await new MisaProvider(cfg).issue((await loadInvoiceDoc(testEnv.DB, id))!);
    expect(r).toEqual({ einvoiceNo: "0000123", series: "1C26TAA", lookupCode: "TX-9" });
    expect(spy).toHaveBeenCalledTimes(2);
    const tokenCall = spy.mock.calls[0];
    expect(String(tokenCall[0])).toBe("https://misa.example.test/api/v2/Account/Token");
  });

  it("MisaProvider errors never leak secrets", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) =>
      String(input).endsWith("/Token") ? jsonRes({ Data: "tok" }) : jsonRes({ Message: "Sai du lieu" }, 400),
    );
    const id = await insertInvoice();
    const p = new MisaProvider(misaConfigFromEnv(misaEnv())!);
    await expect(p.issue((await loadInvoiceDoc(testEnv.DB, id))!)).rejects.toThrow(/HTTP 400.*Sai du lieu/);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("boom Sup3r-Secret-Pw"), { name: "TimeoutError" }));
    const e = await new MisaProvider(misaConfigFromEnv(misaEnv())!).issue((await loadInvoiceDoc(testEnv.DB, id))!).catch((x) => x);
    expect(String(e.message)).toContain("hết thời gian");
    expect(String(e.message)).not.toContain("Sup3r-Secret-Pw");
  });

  it("MisaProvider adjust/cancel call the right endpoints", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      urls.push(String(input));
      return String(input).endsWith("/Token") ? jsonRes({ Data: "tok" }) : jsonRes({ Success: true, Data: { InvoiceNo: "9", InvoiceSeries: "S" } });
    });
    const o = await insertInvoice();
    const a = await insertInvoice({ kind: "adjustment", original: o, total: -1000 });
    const p = new MisaProvider(misaConfigFromEnv(misaEnv())!);
    const od = { ...(await loadInvoiceDoc(testEnv.DB, o))!, einvoiceNo: "100", einvoiceSeries: "S1" };
    const ad = (await loadInvoiceDoc(testEnv.DB, a))!;
    expect((await p.adjust(ad, od)).einvoiceNo).toBe("9");
    await p.cancel(od, "Sai");
    expect(urls.filter((u) => !u.endsWith("/Token")).map((u) => u.split("/").pop())).toEqual(["Adjust", "Cancel"]);
  });
});

describe("job with misa provider", () => {
  it("issues via misa when configured and setting=misa; fails cleanly when not", async () => {
    const id = await insertInvoice();
    await enqueueJobStmt(testEnv.DB, "einvoice.issue", "invoice", id).run();
    const jid = (await testEnv.DB.prepare(`SELECT MAX(id) id FROM integration_jobs`).first<{ id: number }>())!.id;
    await testEnv.DB.prepare(`UPDATE settings SET value='misa' WHERE key='einvoice.provider'`).run();
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) =>
        String(input).endsWith("/Token") ? jsonRes({ Data: "tok" }) : jsonRes({ Success: true, Data: { InvoiceNo: "0000777", InvoiceSeries: "1C26TAA", TransactionID: "LK1" } }),
      );
      const o = await processJob(misaEnv(), jid);
      expect(o.status).toBe("done");
      const i = await testEnv.DB.prepare(`SELECT * FROM invoices WHERE id=?`).bind(id).first<any>();
      expect(i).toMatchObject({ einvoice_status: "issued", einvoice_no: "0000777", einvoice_series: "1C26TAA", einvoice_lookup_code: "LK1" });
      // không cấu hình → lỗi, không gọi mạng
      vi.restoreAllMocks();
      const spy = vi.spyOn(globalThis, "fetch");
      const id2 = await insertInvoice();
      await enqueueJobStmt(testEnv.DB, "einvoice.issue", "invoice", id2).run();
      const jid2 = (await testEnv.DB.prepare(`SELECT MAX(id) id FROM integration_jobs`).first<{ id: number }>())!.id;
      expect((await processJob(testEnv, jid2)).status).toBe("failed");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await testEnv.DB.prepare(`UPDATE settings SET value='fake' WHERE key='einvoice.provider'`).run();
    }
  });
});

describe("integration settings API", () => {
  it("never returns secrets, only misaConfigured", async () => {
    const token = await login("owner");
    const res = await app.request("/api/v1/integrations/settings", { headers: { authorization: `Bearer ${token}` } }, { ...testEnv, ...MISA_ENV, FRESCO_WEBHOOK_SECRET: "fresco-secret-zzz" });
    const text = await res.text();
    expect(res.status).toBe(200);
    const body = JSON.parse(text);
    expect(body.misaConfigured).toBe(true);
    expect(body.einvoiceProvider).toBe("fake");
    for (const s of ["Sup3r-Secret-Pw", "app-id-123", "0312345678", "shop-user", "fresco-secret-zzz", "misa.example.test"]) expect(text).not.toContain(s);
    const plain = await api("owner", "GET", "/api/v1/integrations/settings");
    expect(plain.body.misaConfigured).toBe(false);
  });

  it("PUT validates, requires permission, blocks misa when unconfigured, and audits", async () => {
    expect((await api("manager", "PUT", "/api/v1/integrations/settings", { frescoEnabled: true })).status).toBe(403);
    expect((await api("owner", "PUT", "/api/v1/integrations/settings", { einvoiceProvider: "misa" })).status).toBe(422);
    expect((await api("owner", "PUT", "/api/v1/integrations/settings", { bogus: 1 })).status).toBe(422);
    const r = await api("owner", "PUT", "/api/v1/integrations/settings", { frescoEnabled: true, remindDaysBeforeDue: 5 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ frescoEnabled: true, remindDaysBeforeDue: 5 });
    const a = await testEnv.DB.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='integration.settings_update'`).first<{ n: number }>();
    expect(a!.n).toBeGreaterThan(0);
    await api("owner", "PUT", "/api/v1/integrations/settings", { frescoEnabled: false, remindDaysBeforeDue: 3 });
  });
});
