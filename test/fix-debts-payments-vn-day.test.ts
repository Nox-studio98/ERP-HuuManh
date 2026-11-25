import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";

// Hồi quy: lọc từ/đến ngày của GET /debts/payments phải theo NGÀY VN (UTC+7), không phải ngày UTC của paid_at.
let cust = 0;

beforeAll(async () => {
  await seedBase();
  const c = await testEnv.DB.prepare(`INSERT INTO customers(code, type, name) VALUES ('VNDAY-1','b2b','Khách ngày VN') RETURNING id`).first<{ id: number }>();
  cust = c!.id;
  const u = await testEnv.DB.prepare(`SELECT id FROM users LIMIT 1`).first<{ id: number }>();
  const ins = (code: string, paidAt: string) =>
    testEnv.DB.prepare(`INSERT INTO debt_payments(code, direction, partner_type, partner_id, fund_id, amount, method, paid_at, created_by) VALUES (?,?,?,?,1,100000,'cash',?,?)`)
      .bind(code, "in", "customer", cust, paidAt, u!.id);
  await testEnv.DB.batch([
    ins("VNDAY-A", "2026-11-24T21:18:00.000Z"), // 04:18 ngày 25/11 giờ VN
    ins("VNDAY-B", "2026-11-25T16:59:59.000Z"), // 23:59:59 ngày 25/11 giờ VN
    ins("VNDAY-C", "2026-11-25T17:00:00.000Z"), // 00:00 ngày 26/11 giờ VN
    ins("VNDAY-D", "2026-11-24T16:59:59.000Z"), // 23:59:59 ngày 24/11 giờ VN
  ]);
});

const codes = async (qs: string) =>
  (await api("accountant", "GET", `/api/v1/debts/payments?partnerType=customer&partnerId=${cust}&${qs}`)).body.items.map((x: any) => x.code).sort();

describe("GET /debts/payments lọc theo ngày VN", () => {
  it("phiếu lúc 00:00-07:00 giờ VN thuộc đúng ngày VN", async () => {
    expect(await codes("from=2026-11-25&to=2026-11-25")).toEqual(["VNDAY-A", "VNDAY-B"]);
    expect(await codes("from=2026-11-24&to=2026-11-24")).toEqual(["VNDAY-D"]);
    expect(await codes("from=2026-11-26&to=2026-11-26")).toEqual(["VNDAY-C"]);
  });
  it("khoảng nhiều ngày và chỉ một đầu", async () => {
    expect(await codes("from=2026-11-25")).toEqual(["VNDAY-A", "VNDAY-B", "VNDAY-C"]);
    expect(await codes("to=2026-11-24")).toEqual(["VNDAY-D"]);
  });
});
