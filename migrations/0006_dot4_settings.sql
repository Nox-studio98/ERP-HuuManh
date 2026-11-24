-- Đợt 4: cài đặt bổ sung phát sinh khi hiện thực
INSERT OR IGNORE INTO settings(key, value, note) VALUES
 ('competitor.suggest_band_bp', '1000', 'Gợi ý chỉnh giá khi giá cửa hàng lệch giá TB thị trường >10% [Cần xác nhận]');
