-- Fix nhóm 6a: đổi hàng tại quầy (A-13), phí giao khi huỷ đơn online theo giai đoạn (A-28)

-- A-13: đơn bán mới của một lần "Đổi hàng" trỏ về đơn gốc và về phiếu trả (kind='return') cùng lần đổi.
-- Phiếu trả vẫn dùng original_order_id như trả hàng thường nên mọi báo cáo/giới hạn trả hiện có giữ nguyên.
ALTER TABLE orders ADD COLUMN exchange_of_order_id INTEGER REFERENCES orders(id);
ALTER TABLE orders ADD COLUMN exchange_return_order_id INTEGER REFERENCES orders(id);
CREATE INDEX idx_orders_exchange_of ON orders(exchange_of_order_id);

-- A-28: ai chịu phí giao khi huỷ đơn online, theo giai đoạn (chủ cửa hàng đã chốt): shop = hoàn phí giao, customer = giữ lại phí giao.
INSERT OR IGNORE INTO settings(key, value, note) VALUES
 ('online.cancel_fee_before_prepare', 'shop',     'A-28: huỷ khi chưa soạn hàng (mới/đã xác nhận/chờ thanh toán): shop | customer'),
 ('online.cancel_fee_preparing',      'customer', 'A-28: huỷ khi đang soạn/đóng gói: shop | customer'),
 ('online.cancel_fee_shipping',       'customer', 'A-28: huỷ khi đang giao hoặc giao thất bại: shop | customer');
