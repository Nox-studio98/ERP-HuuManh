import { describe, expect, it } from "vitest";
import { createScanDetector, detectScans, type KeyEv } from "../src/web/scanner";

/** Sinh dãy phím: chữ cách nhau `gap` ms từ mốc `t0`, kèm Enter nếu enter=true. */
const typed = (s: string, t0: number, gap: number, enter = true): KeyEv[] => {
  const ev: KeyEv[] = [...s].map((key, i) => ({ key, t: t0 + i * gap }));
  if (enter) ev.push({ key: "Enter", t: t0 + s.length * gap });
  return ev;
};

describe("scanner — bộ phát hiện quét mã vạch", () => {
  it("nhận một lần quét: ≥4 ký tự, nhịp 5ms, kết thúc Enter", () => {
    const r = detectScans(typed("8931234567890", 1000, 5));
    expect(r).toHaveLength(1);
    expect(r[0].code).toBe("8931234567890");
    expect(r[0].start).toBe(0);
    expect(r[0].end).toBe(13);
  });
  it("gõ tay (nhịp ≥ 35ms) không bị nhận nhầm", () => {
    expect(detectScans(typed("8931234567890", 0, 120))).toEqual([]);
    expect(detectScans(typed("8931234567890", 0, 35))).toEqual([]); // đúng ngưỡng: chưa tính là máy quét
  });
  it("ngắn hơn 4 ký tự → không phải quét", () => {
    expect(detectScans(typed("123", 0, 5))).toEqual([]);
    expect(detectScans(typed("1234", 0, 5))).toHaveLength(1);
  });
  it("không có Enter → chưa tính là một lần quét", () => {
    expect(detectScans(typed("8931234567890", 0, 5, false))).toEqual([]);
  });
  it("Enter đến chậm sau ký tự cuối → không tính", () => {
    const ev = typed("12345678", 0, 5, false);
    ev.push({ key: "Enter", t: 7 * 5 + 200 });
    expect(detectScans(ev)).toEqual([]);
  });
  it("nhiều lần quét liên tiếp, kèm người gõ chậm ở giữa", () => {
    const ev = [
      ...typed("SP0001", 0, 4),
      ...typed("xx", 5000, 150, false), // gõ tay dở dang
      ...typed("893000111", 6000, 6), // máy quét: chuỗi mới tách khỏi phần gõ tay nhờ nhịp
    ];
    const r = detectScans(ev);
    expect(r.map((x) => x.code)).toEqual(["SP0001", "893000111"]);
  });
  it("Shift/CapsLock giữa chuỗi không làm đứt nhịp (mã có chữ hoa)", () => {
    const ev: KeyEv[] = [
      { key: "Shift", t: 0 }, { key: "A", t: 2 }, { key: "Shift", t: 4 }, { key: "B", t: 6 },
      { key: "1", t: 10 }, { key: "2", t: 14 }, { key: "Enter", t: 18 },
    ];
    expect(detectScans(ev).map((x) => x.code)).toEqual(["AB12"]);
  });
  it("phím điều khiển khác (Tab, mũi tên) làm bỏ chuỗi đang gom", () => {
    const ev: KeyEv[] = [...typed("1234", 0, 5, false), { key: "ArrowLeft", t: 22 }, ...typed("56", 25, 5)];
    expect(detectScans(ev)).toEqual([]);
  });
  it("Enter đơn lẻ hoặc Enter lặp không sinh lần quét", () => {
    expect(detectScans([{ key: "Enter", t: 0 }, { key: "Enter", t: 5 }])).toEqual([]);
  });
  it("dạng luồng cho kết quả giống dạng hàm", () => {
    const ev = [...typed("ABCD1234", 0, 5), ...typed("98765", 100, 5)];
    const d = createScanDetector();
    const got = ev.map((e) => d.push(e)).filter(Boolean).map((s) => s!.code);
    expect(got).toEqual(detectScans(ev).map((s) => s.code));
    expect(got).toEqual(["ABCD1234", "98765"]);
  });
  it("tuỳ chỉnh ngưỡng", () => {
    expect(detectScans(typed("12", 0, 5), { minLen: 2 })).toHaveLength(1);
    expect(detectScans(typed("12345", 0, 50), { maxGapMs: 60 })).toHaveLength(1);
  });
});
