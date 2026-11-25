/**
 * A-11: điều kiện đơn của dòng `payments` được tính vào số dư quỹ.
 * Đơn hoàn tất: luôn. Đơn online/MXH trả trước còn đang xử lý (chờ giao/đang giao/giao thất bại) và đơn đã huỷ/trả chờ hoàn
 * tiền: tiền đã vào tài khoản ngân hàng nên phải có trong quỹ ngay; khi hoàn tiền thì dòng payments âm cân lại (net 0).
 * Doanh thu/lãi lỗ vẫn chỉ ghi khi đơn hoàn tất — chỉ SỐ DƯ QUỸ đổi.
 * Cần alias `o` cho bảng orders.
 */
export const FUND_ORDER_OK = `(o.status = 'completed' OR (o.channel IN ('online','social') AND o.kind = 'sale' AND o.status IN ('new','confirmed','preparing','shipping','delivery_failed','cancelled','returned')))`;
