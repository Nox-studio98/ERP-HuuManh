-- Sửa chi tiết hoá đơn POS đã lập (docs/API.md "Trả hàng nhanh / Sửa hoá đơn"): không sửa chứng từ cũ — lập phiếu trả toàn bộ đơn cũ
-- + đơn bán mới (nội dung đã sửa). Đơn mới trỏ về đơn cũ qua cột này. Trả hàng nhanh (không cần hoá đơn gốc) dùng phiếu kind='return'
-- với original_order_id NULL nên không cần cột mới.
ALTER TABLE orders ADD COLUMN corrected_from_order_id INTEGER REFERENCES orders(id);
-- Một đơn chỉ được sửa một lần (chốt chặn cuối ngoài onceStmt); đơn nháp bị huỷ không tính
CREATE UNIQUE INDEX idx_orders_corrected_from ON orders(corrected_from_order_id) WHERE corrected_from_order_id IS NOT NULL AND status <> 'cancelled';
