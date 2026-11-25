/**
 * Ngân hàng nhận tiền dùng được với SePay (webhook) — dữ liệu thuần, dùng chung cho ERP (Cài đặt, SePay) và website (trang chuyển khoản).
 *
 * Nguồn (lấy ngày 25/11/2026, cập nhật khi SePay đổi danh sách):
 *  - Danh sách ngân hàng hỗ trợ webhook + quy tắc "chỉ qua VA": https://developer.sepay.vn/vi/sepay-webhooks/tai-khoan-ngan-hang#ngan-hang-ho-tro
 *  - Mã BIN (VietQR/NAPAS) + short_name: https://vietqr.app/banks.json
 *  - Quy tắc nội dung VietinBank cá nhân/hộ kinh doanh (`SEVQR`): https://developer.sepay.vn/vi/tien-ich-khac/tao-qr-code
 * Ngân hàng không có trong danh sách SePay thì chưa hỗ trợ webhook: không đưa vào đây.
 */
export interface VnBank {
  bin: string;
  /** short_name theo vietqr.app (SePay cũng trả tên này ở trường `gateway` của webhook). */
  shortName: string;
  name: string;
  /** Các cách viết khác có thể gặp ở `gateway` (so không phân biệt hoa thường, bỏ khoảng trắng). */
  aliases?: string[];
  /**
   * Với tài khoản kết nối API, KHÔNG có SMS (theo tài liệu SePay): "all" = mọi loại tài khoản chỉ nhận tiền qua VA; "some" = tuỳ loại tài khoản;
   * undefined = nhận ở tài khoản chính. Tài khoản có kết nối SMS luôn nhận cả tài khoản chính lẫn VA.
   */
  vaOnly?: "all" | "some";
  note?: string;
}

export const VN_BANKS: VnBank[] = [
  { bin: "970416", shortName: "ACB", name: "Ngân hàng TMCP Á Châu" },
  { bin: "970418", shortName: "BIDV", name: "Ngân hàng TMCP Đầu tư và Phát triển Việt Nam", vaOnly: "some", note: "Kết nối API không SMS: tài khoản cá nhân / hộ kinh doanh chỉ nhận qua VA; doanh nghiệp nhận ở tài khoản chính." },
  { bin: "970452", shortName: "KienLongBank", name: "Ngân hàng TMCP Kiên Long", aliases: ["KienlongBank", "KLB"], vaOnly: "all", note: "Kết nối API không SMS: chỉ nhận qua VA, QR phải dùng số VA." },
  { bin: "970422", shortName: "MBBank", name: "Ngân hàng TMCP Quân đội", aliases: ["MB", "MB Bank"] },
  { bin: "970426", shortName: "MSB", name: "Ngân hàng TMCP Hàng Hải Việt Nam", vaOnly: "all", note: "Kết nối API không SMS: chỉ nhận qua VA, QR phải dùng số VA." },
  { bin: "970448", shortName: "OCB", name: "Ngân hàng TMCP Phương Đông", vaOnly: "all", note: "Kết nối API không SMS: chỉ nhận qua VA, QR phải dùng số VA." },
  { bin: "970403", shortName: "Sacombank", name: "Ngân hàng TMCP Sài Gòn Thương Tín" },
  { bin: "970424", shortName: "ShinhanBank", name: "Ngân hàng TNHH MTV Shinhan Việt Nam", aliases: ["Shinhan Bank", "Shinhan"], note: "SePay chỉ hỗ trợ tài khoản doanh nghiệp." },
  { bin: "970423", shortName: "TPBank", name: "Ngân hàng TMCP Tiên Phong" },
  { bin: "970436", shortName: "Vietcombank", name: "Ngân hàng TMCP Ngoại Thương Việt Nam", aliases: ["VCB"], vaOnly: "all", note: "Kết nối API không SMS: chỉ nhận qua VA, QR phải dùng số VA." },
  { bin: "970415", shortName: "VietinBank", name: "Ngân hàng TMCP Công thương Việt Nam", aliases: ["ICB"], vaOnly: "some", note: "Cá nhân / hộ kinh doanh: nội dung chuyển khoản phải có SEVQR. Doanh nghiệp dùng MAP: chỉ nhận qua VA." },
  { bin: "970432", shortName: "VPBank", name: "Ngân hàng TMCP Việt Nam Thịnh Vượng", vaOnly: "some", note: "VPBank NEO (cá nhân / hộ kinh doanh) tuỳ cách liên kết; NEOBiz doanh nghiệp nhận ở tài khoản chính." },
];

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

export const bankByBin = (bin: string | null | undefined): VnBank | undefined => VN_BANKS.find((b) => b.bin === (bin ?? "").trim());

/** Tìm ngân hàng theo tên SePay trả ở `gateway` (short_name hoặc alias). */
export function bankByGateway(gateway: string | null | undefined): VnBank | undefined {
  const g = norm(gateway ?? "");
  if (!g) return undefined;
  return VN_BANKS.find((b) => norm(b.shortName) === g || (b.aliases ?? []).some((a) => norm(a) === g));
}

/** Nhãn ô chọn: cảnh báo đứng ngay sau tên ngắn để vẫn thấy khi ô hẹp (390px): "Vietcombank (API: chỉ qua VA) — Ngân hàng TMCP …". */
export const bankOptionLabel = (b: VnBank) =>
  `${b.shortName}${b.vaOnly === "all" ? " (API: chỉ qua VA)" : b.vaOnly === "some" ? " (tuỳ loại tài khoản)" : ""} — ${b.name}`;
