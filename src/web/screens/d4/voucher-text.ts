/** Lý do engine khuyến mãi từ chối voucher/khuyến mãi → tiếng Việt (dùng chung POS, web ERP). */
export const REASON: Record<string, string> = {
  voucher_not_found: "Không tìm thấy mã voucher", voucher_inactive: "Voucher đã bị khoá", voucher_exhausted: "Voucher đã hết lượt", voucher_wrong_customer: "Voucher dành cho khách khác",
  voucher_customer_limit: "Khách đã dùng hết lượt của voucher", voucher_customer_required: "Voucher này cần gắn khách hàng vào đơn", promotion_inactive: "Khuyến mãi chưa/không còn hiệu lực", channel_not_allowed: "Khuyến mãi không áp dụng cho kênh này",
  min_order: "Chưa đạt giá trị đơn tối thiểu", not_applicable: "Giỏ hàng không có sản phẩm áp dụng", combo_incomplete: "Chưa đủ thành phần combo", no_discount: "Không phát sinh giảm giá",
  not_best_promotion: "Có khuyến mãi khác lợi hơn (không cộng dồn)",
};
export const reasonText = (r: string) => REASON[r] ?? r;
