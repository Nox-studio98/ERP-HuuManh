-- Hoàn lượt voucher khi đơn bị huỷ / trả toàn bộ, ở MỌI đường huỷ (NV huỷ, khách huỷ trên web, từ chối lệch cân,
-- tự huỷ đơn chuyển khoản quá hạn, huỷ POS). Idempotent: chỉ xử lý redemption còn 'used', nên không trừ đôi
-- khi code ứng dụng đã tự hoàn trong cùng batch (services/loyalty-points.ts reversalStatements).
CREATE TRIGGER orders_release_vouchers AFTER UPDATE OF status ON orders
WHEN NEW.status IN ('cancelled','returned') AND OLD.status <> NEW.status
BEGIN
  UPDATE vouchers SET used_count = used_count - 1
   WHERE id IN (SELECT voucher_id FROM voucher_redemptions WHERE order_id = NEW.id AND status = 'used');
  UPDATE voucher_redemptions SET status = 'reversed' WHERE order_id = NEW.id AND status = 'used';
END;
