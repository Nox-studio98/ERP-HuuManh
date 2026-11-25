-- Fix đợt 5a (audit nghiệp vụ A-09, A-10, C-30): bán offline, hạn mức nợ khách sỉ, khoá lạc quan bảng giá.

-- C-30: phát hiện sửa đồng thời bảng giá (EC-38) như khách, sản phẩm, báo giá
ALTER TABLE price_lists ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

INSERT OR IGNORE INTO settings(key, value, note) VALUES
 -- A-09: đơn bán offline chỉ được ghi theo thời điểm bán gốc trong giới hạn này; quá hạn → máy chủ từ chối, quản lý xử lý tay
 ('pos.offline_max_age_hours', '48', 'Đơn bán offline đồng bộ chậm quá số giờ này bị từ chối [Cần xác nhận]'),
 -- A-09: chấp nhận giá khách đã thấy lúc offline nếu lệch bảng giá tại thời điểm bán không quá ngưỡng (điểm cơ bản, 1000 = 10%)
 ('pos.offline_price_tolerance_bp', '1000', 'Đơn offline: giá đã hiển thị được chấp nhận nếu lệch bảng giá không quá % này [Cần xác nhận]'),
 -- A-10: khách sỉ mới có hạn mức / hạn thanh toán vượt ngưỡng → phần vượt cần chủ duyệt
 ('b2b.new_credit_limit_max_vnd', '50000000', 'Hạn mức nợ tối đa quản lý được tự đặt cho khách sỉ; vượt cần chủ duyệt [Cần xác nhận]'),
 ('b2b.new_payment_terms_max_days', '30', 'Hạn thanh toán tối đa (ngày) quản lý được tự đặt cho khách sỉ; vượt cần chủ duyệt [Cần xác nhận]');
