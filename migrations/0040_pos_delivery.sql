-- POS-KV đợt B3: bán giao hàng tại quầy (docs/POS-KV-B.md mục B3).
-- Đơn giao từ quầy là đơn online kênh 'social' đánh dấu source='pos', gắn ca tạo và người giao (nhân viên cửa hàng).
-- Xe ngoài dùng cột carrier / carrier_tracking_no sẵn có.
ALTER TABLE orders ADD COLUMN source TEXT CHECK (source IS NULL OR source = 'pos');
ALTER TABLE orders ADD COLUMN pos_shift_id INTEGER REFERENCES shifts(id);
ALTER TABLE orders ADD COLUMN deliverer_user_id INTEGER REFERENCES users(id);
CREATE INDEX idx_orders_pos_shift ON orders(pos_shift_id) WHERE pos_shift_id IS NOT NULL;
CREATE INDEX idx_orders_source ON orders(source, status) WHERE source IS NOT NULL;
