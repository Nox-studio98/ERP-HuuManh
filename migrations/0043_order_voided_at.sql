-- Thời điểm huỷ đơn đã hoàn tất (void) — để thu hồi hoa hồng/thưởng ở kỳ lương CÓ NGÀY HUỶ (giống trả hàng), fix8 C2-05.
-- Trigger tự ghi ở MỌI đường huỷ đơn đã hoàn tất, không phụ thuộc từng route.
ALTER TABLE orders ADD COLUMN voided_at TEXT;

CREATE TRIGGER orders_set_voided_at AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status = 'completed' AND NEW.voided_at IS NULL
BEGIN
  UPDATE orders SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

-- Đơn đã huỷ trước đây: lấy giờ từ nhật ký order.void (nếu không có thì để trống → không thu hồi lùi)
UPDATE orders SET voided_at = (SELECT MAX(a.at) FROM audit_log a WHERE a.action = 'order.void' AND a.entity = 'order' AND a.entity_id = CAST(orders.id AS TEXT))
 WHERE status = 'cancelled' AND completed_at IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NULL;
