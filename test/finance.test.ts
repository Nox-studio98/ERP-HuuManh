import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnPeriod } from "../src/worker/lib/time";

beforeAll(seedBase);

const cat = async (code: string) => ((await api("accountant", "GET", "/api/v1/cash-categories")).body.items as any[]).find((c) => c.code === code).id;
const balance = async (fundId: number) => ((await api("accountant", "GET", "/api/v1/funds")).body.items as any[]).find((f) => f.id === fundId).balance;

describe("finance", () => {
  it("forbids cashier from writing vouchers", async () => {
    const r = await api("cashier", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: 1, amount: 1000 });
    expect(r.status).toBe(403);
    expect((await api("cashier", "GET", "/api/v1/funds")).status).toBe(403);
  });

  it("posts small vouchers immediately and updates balance", async () => {
    const r = await api("accountant", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: await cat("DIEN_NUOC"), amount: 300000, note: "Tiền điện" });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("posted");
    expect(r.body.code).toMatch(/^PC-/);
    expect(await balance(1)).toBe(-300000);
    const bad = await api("accountant", "POST", "/api/v1/vouchers", { direction: "in", fundId: 1, categoryId: await cat("DIEN_NUOC"), amount: 1000 });
    expect(bad.status).toBe(422);
  });

  it("over-threshold voucher is pending until owner approves", async () => {
    const r = await api("accountant", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: await cat("MAT_BANG"), amount: 6_000_000 });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.approvalId).toBeGreaterThan(0);
    expect(await balance(1)).toBe(-300000);
    expect((await api("accountant", "POST", `/api/v1/vouchers/${r.body.id}/approve`)).status).toBe(403);
    const ok = await api("owner", "POST", `/api/v1/vouchers/${r.body.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("posted");
    expect(await balance(1)).toBe(-6_300_000);
    const ap = await api("owner", "GET", "/api/v1/approvals?status=approved");
    expect(ap.body.items.some((a: any) => a.id === r.body.approvalId)).toBe(true);
  });

  it("owner can post a large voucher directly", async () => {
    const r = await api("owner", "POST", "/api/v1/vouchers", { direction: "out", fundId: 2, categoryId: await cat("TIEN_HANG"), amount: 8_000_000 });
    expect(r.body.status).toBe("posted");
  });

  it("reverses a voucher once, in the current period, without editing the original", async () => {
    const v = await api("accountant", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: await cat("VAN_CHUYEN"), amount: 100000 });
    const before = await balance(1);
    const rev = await api("accountant", "POST", `/api/v1/vouchers/${v.body.id}/reverse`, { reason: "Ghi nhầm" });
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ direction: "in", amount: 100000, reverses_id: v.body.id, period: vnPeriod() });
    expect(await balance(1)).toBe(before + 100000);
    expect((await api("accountant", "POST", `/api/v1/vouchers/${v.body.id}/reverse`, { reason: "lần hai" })).status).toBe(409);
    expect((await api("accountant", "POST", `/api/v1/vouchers/${rev.body.id}/reverse`, { reason: "đảo phiếu đảo" })).status).toBe(409);
    const orig = await api("accountant", "GET", `/api/v1/vouchers?period=${vnPeriod()}&direction=out`);
    expect(orig.body.items.find((x: any) => x.id === v.body.id).status).toBe("posted");
  });

  it("lists reconciliation (shift_reconcile) for cashier role", async () => {
    const r = await api("cashier", "GET", "/api/v1/reconcile/shifts");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
  });

  it("locked period blocks new vouchers with 423", async () => {
    // B-08: chỉ khoá được kỳ đã kết thúc; kỳ hiện tại/tương lai → 422 period_not_ended
    const prev = new Date(Date.now() - 40 * 86400_000);
    const past = vnPeriod(prev);
    expect((await api("accountant", "POST", `/api/v1/periods/${past}/lock`)).status).toBe(403);
    const cur = await api("owner", "POST", `/api/v1/periods/${vnPeriod()}/lock`);
    expect(cur.status).toBe(422);
    expect(cur.body.error.code).toBe("period_not_ended");
    expect((await api("owner", "POST", `/api/v1/periods/2099-01/lock`)).status).toBe(422);
    const lk = await api("owner", "POST", `/api/v1/periods/${past}/lock`);
    expect(lk.status).toBe(200);
    // kỳ hiện tại bị khoá (dữ liệu cũ/khoá thủ công trong DB) vẫn chặn phiếu mới bằng trigger
    await testEnv.DB.prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(vnPeriod()).run();
    const r = await api("accountant", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: await cat("DIEN_NUOC"), amount: 1000 });
    expect(r.status).toBe(423);
    expect(r.body.error.code).toBe("period_locked");
    const list = await api("accountant", "GET", "/api/v1/periods");
    expect(list.body.items.find((p: any) => p.period === past).locked).toBe(true);
    expect(list.body.items.find((p: any) => p.period === vnPeriod()).locked).toBe(true);
  });
});
