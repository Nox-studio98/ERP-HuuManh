-- Fix đợt 5b (audit nghiệp vụ A-08, A-19, A-20, A-27): đơn online & sỉ.

-- A-20: nhân viên ghi nhận "khách đồng ý lệch cân qua điện thoại" — người ghi + lý do (kèm audit_log + order_events)
ALTER TABLE orders ADD COLUMN weight_override_by INTEGER REFERENCES users(id);
ALTER TABLE orders ADD COLUMN weight_override_reason TEXT;

-- A-27: đơn bổ sung cho phần giao thiếu của đơn sỉ gốc
ALTER TABLE orders ADD COLUMN backorder_of_order_id INTEGER REFERENCES orders(id);
CREATE INDEX idx_orders_backorder ON orders(backorder_of_order_id) WHERE backorder_of_order_id IS NOT NULL;

INSERT OR IGNORE INTO settings(key, value, note) VALUES
 ('online.pack_recalc_promo', '1', 'Sau khi cân/đóng gói đơn online: tính lại khuyến mãi %/voucher theo engine khuyến mãi với tiền hàng thực tế (voucher không còn đủ điều kiện thì bỏ giảm và hoàn lượt) [Cần xác nhận]'),
 ('online.pack_recalc_shipping', '1', 'Sau khi cân/đóng gói đơn online: xét lại ngưỡng miễn phí giao hàng theo tiền hàng thực tế [Cần xác nhận]'),
 ('b2b.backorder_on_short', '0', 'Giao thiếu đơn sỉ: 1 = tự tạo đơn bổ sung cho phần còn lại (có thể chọn lại ở từng lần xác nhận giao) [Cần xác nhận]');
