import { vnDay } from "./time";

/** Sinh mã chứng từ tăng dần theo ngày, nguyên tử trên D1: HD-20261123-0001 */
export async function nextCode(db: D1Database, prefix: string): Promise<string> {
  const day = vnDay();
  const row = await db
    .prepare(
      `INSERT INTO doc_sequences(prefix, day, seq) VALUES (?1, ?2, 1)
       ON CONFLICT(prefix, day) DO UPDATE SET seq = seq + 1 RETURNING seq`,
    )
    .bind(prefix, day)
    .first<{ seq: number }>();
  return `${prefix}-${day}-${String(row!.seq).padStart(4, "0")}`;
}

/** Mã vạch nội bộ Code128 cho sản phẩm/lô không có mã sẵn (M2-15). */
export const internalBarcode = (kind: "P" | "L", id: number) => `HM${kind}${String(id).padStart(8, "0")}`;

/** Prefix chứng từ dùng chung toàn hệ thống. */
export const PREFIX = {
  order: "HD",
  return: "TH",
  receipt: "PN",
  issue: "PX",
  waste: "HH",
  adjust: "DC",
  count: "KK",
  transfer: "CK",
  cashIn: "PT",
  cashOut: "PC",
} as const;
