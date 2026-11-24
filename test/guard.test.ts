import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv, api } from "./helpers";
import { assertStmt, onceStmt } from "../src/worker/services/guard";

beforeAll(seedBase);

describe("chốt chặn đồng thời (0008)", () => {
  it("assertStmt rolls back the whole batch when the condition no longer holds", async () => {
    const db = testEnv.DB;
    await db.prepare(`INSERT INTO orders(id, code, channel, store_id, status) VALUES (9901,'G-1','pos',1,'completed')`).run();
    const stmts = () => [
      assertStmt(db, "t", "SELECT status = 'completed' FROM orders WHERE id = ?", [9901]),
      db.prepare(`UPDATE orders SET status='cancelled', note = COALESCE(note,'') || 'x' WHERE id=9901`),
    ];
    await db.batch(stmts());
    await expect(db.batch(stmts())).rejects.toThrow(/state_changed/);
    const o = await db.prepare(`SELECT note FROM orders WHERE id=9901`).first<{ note: string }>();
    expect(o!.note).toBe("x"); // lần 2 không chạy
    // id không tồn tại → NULL → sai
    await expect(db.batch([assertStmt(db, "t", "SELECT 1 FROM orders WHERE id = ?", [123456])])).rejects.toThrow(/state_changed/);
  });

  it("onceStmt blocks a second run; overallocation and double reverse are rejected by the DB", async () => {
    const db = testEnv.DB;
    await db.batch([onceStmt(db, "payroll.pay", 1)]);
    await expect(db.batch([onceStmt(db, "payroll.pay", 1)])).rejects.toThrow(/UNIQUE/);
    await db.batch([
      db.prepare(`INSERT INTO customers(id, code, name) VALUES (9901,'KH-G','G')`),
      db.prepare(`INSERT INTO invoices(id, code, customer_id, issue_date, due_date, subtotal, total) VALUES (9901,'HD-G',9901,'2026-01-01','2026-01-10',100000,100000)`),
      db.prepare(`INSERT INTO debt_payments(id, code, direction, partner_type, partner_id, fund_id, amount, method, paid_at, created_by) VALUES (9901,'TT-G','in','customer',9901,1,150000,'cash','2026-01-02',1)`),
      db.prepare(`INSERT INTO debt_allocations(payment_id, invoice_id, amount) VALUES (9901,9901,100000)`),
    ]);
    await expect(db.prepare(`INSERT INTO debt_allocations(payment_id, invoice_id, amount) VALUES (9901,9901,1)`).run()).rejects.toThrow(/overallocated/);
    const cat = await db.prepare(`SELECT id FROM cash_categories LIMIT 1`).first<{ id: number }>();
    await db.prepare(`INSERT INTO cash_vouchers(id, code, direction, fund_id, category_id, amount, period, created_by) VALUES (9901,'PC-G','out',1,?,1000,'2026-11',1)`).bind(cat!.id).run();
    await db.prepare(`INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, period, created_by, reverses_id) VALUES ('PT-G1','in',1,?,1000,'2026-11',1,9901)`).bind(cat!.id).run();
    await expect(db.prepare(`INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, period, created_by, reverses_id) VALUES ('PT-G2','in',1,?,1000,'2026-11',1,9901)`).bind(cat!.id).run()).rejects.toThrow(/UNIQUE/);
  });

  it("state_changed maps to HTTP 409", async () => {
    // voucher reverse twice via API → the second hits the unique index → 409 (not 500)
    const cat = await testEnv.DB.prepare(`SELECT id FROM cash_categories WHERE direction='out' LIMIT 1`).first<{ id: number }>();
    const v = await api("owner", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: cat!.id, amount: 777 });
    const a = await api("owner", "POST", `/api/v1/vouchers/${v.body.id}/reverse`, { reason: "nhập sai số tiền" });
    const b = await api("owner", "POST", `/api/v1/vouchers/${v.body.id}/reverse`, { reason: "nhập sai số tiền" });
    expect(a.status).toBeLessThan(300);
    expect(b.status).toBe(409);
  });
});
