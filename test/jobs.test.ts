import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { insertInvoice } from "./integration-helpers";
import { BACKOFF_MS, enqueueDebtReminders, processJob, sanitizeError, sweepJobs } from "../src/worker/services/jobs";
import { enqueueJobStmt } from "../src/worker/services/outbox";
import { runScheduled } from "../src/worker/scheduled";
import { addDays } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";

const db = () => testEnv.DB;
async function enqueue(type: any, refType: string, refId: number, payload: unknown = {}) {
  await enqueueJobStmt(db(), type, refType, refId, payload).run();
  return (await db().prepare(`SELECT MAX(id) id FROM integration_jobs`).first<{ id: number }>())!.id;
}
const job = (id: number) => db().prepare(`SELECT * FROM integration_jobs WHERE id=?`).bind(id).first<any>();
const inv = (id: number) => db().prepare(`SELECT * FROM invoices WHERE id=?`).bind(id).first<any>();
const setProvider = (v: string) => db().prepare(`UPDATE settings SET value=? WHERE key='einvoice.provider'`).bind(v).run();

beforeAll(seedBase);

describe("processJob", () => {
  it("issues an e-invoice with the fake provider and is idempotent", async () => {
    const id = await insertInvoice();
    const j = await enqueue("einvoice.issue", "invoice", id);
    const o = await processJob(testEnv, j);
    expect(o.status).toBe("done");
    const i = await inv(id);
    expect(i.einvoice_status).toBe("issued");
    expect(i.einvoice_no).toMatch(/^TEST-/);
    expect(i.einvoice_series).toBeTruthy();
    expect((await job(j)).status).toBe("done");
    // chạy lại job đã xong → bỏ qua
    expect((await processJob(testEnv, j)).status).toBe("skipped");
    // job thứ hai cho hoá đơn đã phát hành → không phát hành lại, giữ nguyên số
    const j2 = await enqueue("einvoice.issue", "invoice", id);
    await processJob(testEnv, j2);
    expect((await inv(id)).einvoice_no).toBe(i.einvoice_no);
    expect(JSON.parse((await job(j2)).result_json).skipped).toBe("already_issued");
  });

  it("claims atomically: concurrent runs process once", async () => {
    const id = await insertInvoice();
    const j = await enqueue("einvoice.issue", "invoice", id);
    const [a, b] = await Promise.all([processJob(testEnv, j), processJob(testEnv, j)]);
    expect([a.status, b.status].sort()).toEqual(["done", "skipped"]);
    expect((await job(j)).attempts).toBe(1);
  });

  it("does not run a job before next_run_at", async () => {
    const id = await insertInvoice();
    const j = await enqueue("einvoice.issue", "invoice", id);
    await db().prepare(`UPDATE integration_jobs SET next_run_at=? WHERE id=?`).bind(new Date(Date.now() + 3600_000).toISOString(), j).run();
    expect((await processJob(testEnv, j)).status).toBe("skipped");
    expect((await job(j)).attempts).toBe(0);
  });

  it("fails with backoff, marks invoice failed, goes dead after 5 attempts and audits", async () => {
    await setProvider("misa"); // chưa cấu hình MISA → mỗi lần chạy đều lỗi
    try {
      const id = await insertInvoice();
      const j = await enqueue("einvoice.issue", "invoice", id);
      let now = new Date();
      for (let n = 1; n <= 5; n++) {
        const o = await processJob(testEnv, j, now);
        const row = await job(j);
        expect(row.attempts).toBe(n);
        if (n < 5) {
          expect(o.status).toBe("failed");
          expect(row.status).toBe("failed");
          expect(Date.parse(row.next_run_at) - now.getTime()).toBe(BACKOFF_MS[n - 1]);
          // chưa tới hạn → không chạy
          expect((await processJob(testEnv, j, now)).status).toBe("skipped");
          now = new Date(Date.parse(row.next_run_at) + 1000);
        } else expect(o.status).toBe("dead");
      }
      expect((await job(j)).status).toBe("dead");
      expect((await job(j)).last_error).toContain("MISA");
      const i = await inv(id);
      expect(i.einvoice_status).toBe("failed");
      expect(i.einvoice_error).toBeTruthy();
      const au = await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='job.dead' AND entity_id=?`).bind(String(j)).first<{ n: number }>();
      expect(au!.n).toBe(1);
      // retry thủ công qua API đưa job về queued
      await setProvider("fake");
      const r = await api("owner", "POST", `/api/v1/integrations/jobs/${j}/retry`);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("queued");
      expect((await processJob(testEnv, j)).status).toBe("done");
      expect((await inv(id)).einvoice_status).toBe("issued");
    } finally {
      await setProvider("fake");
    }
  });

  it("adjust requires issued original, then issues the adjustment", async () => {
    const orig = await insertInvoice();
    const adj = await insertInvoice({ kind: "adjustment", original: orig, total: -20000 });
    const j = await enqueue("einvoice.adjust", "invoice", adj);
    expect((await processJob(testEnv, j)).status).toBe("failed"); // gốc chưa phát hành
    await processJob(testEnv, await enqueue("einvoice.issue", "invoice", orig));
    const row = await job(j);
    expect((await processJob(testEnv, j, new Date(Date.parse(row.next_run_at) + 1000))).status).toBe("done");
    expect((await inv(adj)).einvoice_status).toBe("issued");
  });

  it("cancel resets einvoice status and is idempotent", async () => {
    const id = await insertInvoice();
    await processJob(testEnv, await enqueue("einvoice.issue", "invoice", id));
    const j = await enqueue("einvoice.cancel", "invoice", id, { reason: "Sai thông tin người mua" });
    expect((await processJob(testEnv, j)).status).toBe("done");
    const i = await inv(id);
    expect(i.einvoice_status).toBe("none");
    expect(i.einvoice_error).toContain("Sai thông tin");
    const j2 = await enqueue("einvoice.cancel", "invoice", id, { reason: "x" });
    await processJob(testEnv, j2);
    expect(JSON.parse((await job(j2)).result_json).skipped).toBe("not_issued");
  });

  it("unknown job type fails; fresco.ack is a no-op", async () => {
    const j = await enqueue("nope" as any, "x", 1);
    expect((await processJob(testEnv, j)).status).toBe("failed");
    const a = await enqueue("fresco.ack", "order", 1);
    expect((await processJob(testEnv, a)).status).toBe("done");
  });

  it("sanitizes errors: truncates to 500 and masks secrets", () => {
    const env = { ...testEnv, MISA_PASSWORD: "S3cretPass!" } as any;
    const m = sanitizeError(new Error("x".repeat(900) + " S3cretPass! Authorization: Bearer abc"), env);
    expect(m.length).toBeLessThanOrEqual(500);
    expect(sanitizeError(new Error("lỗi S3cretPass! Authorization: Bearer abc.def"), env)).not.toMatch(/S3cretPass|abc\.def/);
  });
});

describe("debt reminders + sweep + cron", () => {
  it("debt.remind records recipients in result_json and audit", async () => {
    await db().prepare(`INSERT INTO customers(code, type, name, email) VALUES ('KH-T1','b2b','Nhà hàng A','a@example.com')`).run();
    const cid = (await db().prepare(`SELECT id FROM customers WHERE code='KH-T1'`).first<{ id: number }>())!.id;
    const overdue = await insertInvoice({ customerId: cid, due: addDays(vnDate(), -5), total: 500000 });
    await insertInvoice({ customerId: cid, due: addDays(vnDate(), 60), total: 300000 }); // chưa tới hạn nhắc
    const j = await enqueue("debt.remind", "customer", cid);
    const o = await processJob(testEnv, j);
    expect(o.status).toBe("done");
    const res = JSON.parse((await job(j)).result_json);
    expect(res.recipients).toHaveLength(1);
    expect(res.recipients[0].email).toBe("a@example.com");
    expect(res.recipients[0].invoices.map((x: any) => x.id)).toEqual([overdue]);
    expect(res.recipients[0].totalOutstanding).toBe(500000);
  });

  it("enqueueDebtReminders creates one job per customer per day", async () => {
    const before = (await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE type='debt.remind'`).first<{ n: number }>())!.n;
    const n1 = await enqueueDebtReminders(testEnv);
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(await enqueueDebtReminders(testEnv)).toBe(0);
    const after = (await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE type='debt.remind'`).first<{ n: number }>())!.n;
    expect(after - before).toBe(n1);
  });

  it("sweepJobs processes due jobs inline and recovers stuck running jobs", async () => {
    const id = await insertInvoice();
    const j = await enqueue("einvoice.issue", "invoice", id);
    await db().prepare(`UPDATE integration_jobs SET status='running', updated_at=? WHERE id=?`).bind(new Date(Date.now() - 3600_000).toISOString(), j).run();
    const r = await sweepJobs(testEnv, { inline: true });
    expect(r.processed).toBeGreaterThanOrEqual(1);
    expect((await job(j)).status).toBe("done");
    expect((await inv(id)).einvoice_status).toBe("issued");
  });

  it("cron */5 runs the sweep and cron 0 1 enqueues reminders without throwing", async () => {
    const id = await insertInvoice();
    const j = await enqueue("einvoice.issue", "invoice", id);
    await runScheduled({ cron: "*/5 * * * *" } as ScheduledController, testEnv);
    // có Queue binding → job được đẩy lên Queue (consumer chạy ngoài test); không có → xử lý trực tiếp
    expect(["queued", "done", "running"]).toContain((await job(j)).status);
    await runScheduled({ cron: "0 1 * * *" } as ScheduledController, testEnv);
  });

  it("jobs API requires integrations.manage and lists with filters", async () => {
    expect((await api("cashier", "GET", "/api/v1/integrations/jobs")).status).toBe(403);
    expect((await api("accountant", "GET", "/api/v1/integrations/jobs")).status).toBe(403);
    const r = await api("owner", "GET", "/api/v1/integrations/jobs?status=done&limit=2");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(2);
    expect(r.body.items.every((x: any) => x.status === "done")).toBe(true);
    expect(r.body.items[0]).toHaveProperty("nextRunAt");
    expect((await api("owner", "GET", "/api/v1/integrations/jobs?status=bogus")).status).toBe(422);
    const j = r.body.items[0].id;
    expect((await api("owner", "POST", `/api/v1/integrations/jobs/${j}/retry`)).status).toBe(409);
    expect((await api("owner", "POST", `/api/v1/integrations/jobs/999999/retry`)).status).toBe(404);
  });
});
