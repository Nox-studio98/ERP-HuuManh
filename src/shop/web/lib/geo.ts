/**
 * Danh sách quận/huyện hiển thị trong ô chọn khu vực giao. API chưa có endpoint liệt kê vùng giao hàng
 * (GET /api/delivery/zones) nên danh sách này nằm ở client; server vẫn là nơi quyết định vùng có hỗ trợ hay không
 * (quote/checkout trả zone_unsupported).
 */
export const PROVINCE = "TP. Hồ Chí Minh";
export const DISTRICTS = [
  "Quận 1", "Quận 3", "Quận 4", "Quận 5", "Quận 6", "Quận 7", "Quận 8", "Quận 10", "Quận 11", "Quận 12",
  "Bình Thạnh", "Gò Vấp", "Phú Nhuận", "Tân Bình", "Tân Phú", "Bình Tân", "Thủ Đức", "Quận 2", "Quận 9",
  "Bình Chánh", "Hóc Môn", "Nhà Bè", "Củ Chi", "Cần Giờ",
];
