import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/worker/index";
import { api, login, seedBase, testEnv } from "./helpers";

beforeAll(seedBase);

describe("approvals", () => {
  it("only finance.approve roles decide cash voucher approvals; reject cancels voucher", async () => {
    const v = await api("accountant", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: 3, amount: 7_000_000 });
    expect(v.body.status).toBe("pending_approval");
    const list = await api("manager", "GET", "/api/v1/approvals?status=pending");
    expect(list.status).toBe(200);
    expect(list.body.items.some((a: any) => a.id === v.body.approvalId && a.payload.amount === 7_000_000)).toBe(true);
    expect((await api("accountant", "GET", "/api/v1/approvals")).status).toBe(403);
    expect((await api("manager", "POST", `/api/v1/approvals/${v.body.approvalId}/decide`, { decision: "approved" })).status).toBe(403);
    const rej = await api("owner", "POST", `/api/v1/approvals/${v.body.approvalId}/decide`, { decision: "rejected", note: "Không hợp lý" });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe("rejected");
    const row = await testEnv.DB.prepare(`SELECT status FROM cash_vouchers WHERE id=?`).bind(v.body.id).first<any>();
    expect(row.status).toBe("cancelled");
    expect((await api("owner", "POST", `/api/v1/approvals/${v.body.approvalId}/decide`, { decision: "approved" })).status).toBe(409);
  });

  it("approving a cash voucher via decide posts it", async () => {
    const v = await api("accountant", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: 3, amount: 5_500_000 });
    const d = await api("owner", "POST", `/api/v1/approvals/${v.body.approvalId}/decide`, { decision: "approved" });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("approved");
    const row = await testEnv.DB.prepare(`SELECT status, approved_by FROM cash_vouchers WHERE id=?`).bind(v.body.id).first<any>();
    expect(row).toMatchObject({ status: "posted", approved_by: 1 });
  });
});

describe("users", () => {
  it("is owner-only", async () => {
    expect((await api("manager", "GET", "/api/v1/users")).status).toBe(403);
    const r = await api("owner", "GET", "/api/v1/users");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("pass_hash");
  });

  it("creates a user with a temp password and must_change_password", async () => {
    const r = await api("owner", "POST", "/api/v1/users", { username: "nv_moi", fullName: "Nhân viên mới", role: "cashier" });
    expect(r.status).toBe(201);
    expect(r.body.tempPassword.length).toBeGreaterThanOrEqual(8);
    expect(r.body.must_change_password).toBe(1);
    expect(r.body.pass_hash).toBeUndefined();
    expect((await api("owner", "POST", "/api/v1/users", { username: "NV_MOI", fullName: "x", role: "cashier" })).status).toBe(409);
    const login = await app.request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nv_moi", password: r.body.tempPassword }),
    }, testEnv);
    expect(login.status).toBe(200);
    expect((await login.json() as any).mustChangePassword).toBe(true);
  });

  it("deactivating a user revokes their sessions (EC-39)", async () => {
    await login("warehouse");
    expect((await api("warehouse", "GET", "/api/auth/me")).status).toBe(200);
    const id = (await testEnv.DB.prepare(`SELECT id FROM users WHERE username='warehouse'`).first<any>()).id;
    const r = await api("owner", "PUT", `/api/v1/users/${id}`, { active: false });
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(0);
    expect((await api("warehouse", "GET", "/api/auth/me")).status).toBe(401);
    const again = await app.request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "warehouse", password: "Test-Password-123" }),
    }, testEnv);
    expect(again.status).toBe(401);
    expect((await api("owner", "PUT", "/api/v1/users/1", { active: false })).status).toBe(409);
  });
});

describe("settings & audit", () => {
  it("updates settings and records audit", async () => {
    const r = await api("owner", "PUT", "/api/v1/settings", { settings: { "approval.cash_out_vnd": 10_000_000 } });
    expect(r.status).toBe(200);
    expect(r.body.items.find((s: any) => s.key === "approval.cash_out_vnd").value).toBe("10000000");
    expect((await api("manager", "PUT", "/api/v1/settings", { settings: { a: "b" } })).status).toBe(403);
    const a = await api("manager", "GET", "/api/v1/audit?entity=settings");
    expect(a.status).toBe(200);
    expect(a.body.items[0].action).toBe("settings.update");
    expect(a.body.items[0].before_json).toContain("5000000");
  });
});
