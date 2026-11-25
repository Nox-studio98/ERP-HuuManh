import { beforeAll, describe, expect, it } from "vitest";
import { VN_BANKS, bankByBin, bankByGateway, bankOptionLabel } from "../src/worker/lib/vn-banks";
import { SETTING_DEFS, validateSetting } from "../src/worker/services/settings-registry";
import { api, seedBase, testEnv } from "./helpers";

const db = () => testEnv.DB;

const V = "/api/v1";

beforeAll(seedBase);

describe("danh sách ngân hàng nhận tiền (SePay)", () => {
  it("mã BIN 6 số, không trùng; tra được theo BIN và theo tên SePay trả ở gateway", () => {
    expect(VN_BANKS.every((b) => /^\d{6}$/.test(b.bin))).toBe(true);
    expect(new Set(VN_BANKS.map((b) => b.bin)).size).toBe(VN_BANKS.length);
    expect(bankByBin("970416")?.shortName).toBe("ACB");
    expect(bankByGateway("ACB")?.bin).toBe("970416");
    expect(bankByGateway("Kienlong Bank")?.bin).toBe("970452"); // alias, bỏ khoảng trắng, không phân biệt hoa thường
    expect(bankByGateway("")).toBeUndefined();
    expect(bankOptionLabel(bankByBin("970436")!)).toContain("API: chỉ qua VA");
  });

  it("Cài đặt: ô ngân hàng là danh sách chọn, chỉ nhận BIN trong danh sách", () => {
    const def = SETTING_DEFS.find((d) => d.key === "payment.bank_bin")!;
    expect(def.type).toBe("enum");
    expect(def.options!.map((o) => o.value).sort()).toEqual(VN_BANKS.map((b) => b.bin).sort());
    expect(validateSetting(def, "970416")).toEqual({ value: "970416" });
    expect("error" in validateSetting(def, "970405")).toBe(true); // Agribank: SePay chưa hỗ trợ webhook
    expect("error" in validateSetting(def, "12345")).toBe(true);
  });

  it("/sepay/config báo lệch ngân hàng khi giao dịch SePay gần nhất đến từ ngân hàng khác", async () => {
    await db().prepare(`UPDATE settings SET value = '970416' WHERE key = 'payment.bank_bin'`).run();
    let r = await api("owner", "GET", `${V}/sepay/config`);
    expect(r.status).toBe(200);
    expect(r.body.bankCheck).toMatchObject({ supported: true, mismatch: false, selected: { shortName: "ACB", vaOnly: null } });

    await db().prepare(`INSERT INTO sepay_events(sepay_id, source, transfer_type, amount, gateway, status, payload_json) VALUES (990001, 'webhook', 'in', 1000, 'Vietcombank', 'unmatched', '{}')`).run();
    r = await api("owner", "GET", `${V}/sepay/config`);
    expect(r.body.bankCheck).toMatchObject({ mismatch: true, lastGateway: "Vietcombank" });

    await db().prepare(`UPDATE settings SET value = '970436' WHERE key = 'payment.bank_bin'`).run();
    r = await api("owner", "GET", `${V}/sepay/config`);
    expect(r.body.bankCheck).toMatchObject({ mismatch: false, selected: { shortName: "Vietcombank", vaOnly: "all" } });
  });
});
