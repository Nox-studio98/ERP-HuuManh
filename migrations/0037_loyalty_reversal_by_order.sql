-- Sau khi gộp khách (migrations/0034), đơn đã chuyển sang khách đích còn sổ điểm mang customer_id của khách nguồn.
-- Trigger hoàn/thu hồi điểm đơn online phải tra sổ theo ĐƠN (bỏ điều kiện customer_id); bút toán mới và số dư vẫn ghi cho NEW.customer_id (khách hiện tại của đơn).
-- Thân trigger giữ nguyên bản 0011 (chưa migration nào tạo lại), chỉ bỏ "AND customer_id = NEW.customer_id" ở các truy vấn đọc sổ.
DROP TRIGGER IF EXISTS orders_reverse_online_points;
CREATE TRIGGER orders_reverse_online_points AFTER UPDATE OF status ON orders
WHEN NEW.status IN ('cancelled','returned') AND OLD.status <> NEW.status
 AND NEW.channel IN ('online','social') AND NEW.shop_account_id IS NOT NULL AND NEW.customer_id IS NOT NULL
BEGIN
  -- (1) hoàn điểm đã đổi
  UPDATE customers SET points = points + (
    SELECT -COALESCE(SUM(CASE WHEN kind = 'redeem' THEN points END), 0) - COALESCE(SUM(CASE WHEN kind = 'reverse' AND points > 0 THEN points END), 0)
      FROM loyalty_ledger WHERE order_id = NEW.id)
   WHERE id = NEW.customer_id
     AND (SELECT -COALESCE(SUM(CASE WHEN kind = 'redeem' THEN points END), 0) - COALESCE(SUM(CASE WHEN kind = 'reverse' AND points > 0 THEN points END), 0)
            FROM loyalty_ledger WHERE order_id = NEW.id) > 0;
  INSERT INTO loyalty_ledger(customer_id, order_id, kind, points, note)
  SELECT NEW.customer_id, NEW.id, 'reverse', x, 'Hoàn điểm đã đổi (huỷ/trả đơn)' FROM (
    SELECT -COALESCE(SUM(CASE WHEN kind = 'redeem' THEN points END), 0) - COALESCE(SUM(CASE WHEN kind = 'reverse' AND points > 0 THEN points END), 0) AS x
      FROM loyalty_ledger WHERE order_id = NEW.id) WHERE x > 0;
  -- (2) thu hồi điểm đã tích (kẹp theo số dư; sổ ghi đúng phần thực trừ)
  INSERT INTO loyalty_ledger(customer_id, order_id, kind, points, note)
  SELECT NEW.customer_id, NEW.id, 'reverse', -MIN(x, (SELECT points FROM customers WHERE id = NEW.customer_id)), 'Thu hồi điểm tích (huỷ/trả đơn)' FROM (
    SELECT COALESCE(SUM(CASE WHEN kind = 'earn' THEN points END), 0) + COALESCE(SUM(CASE WHEN kind = 'reverse' AND points < 0 THEN points END), 0) AS x
      FROM loyalty_ledger WHERE order_id = NEW.id)
   WHERE x > 0 AND (SELECT points FROM customers WHERE id = NEW.customer_id) > 0;
  UPDATE customers SET points = MAX(0, points + (SELECT points FROM loyalty_ledger WHERE id = last_insert_rowid()))
   WHERE id = NEW.customer_id
     AND EXISTS (SELECT 1 FROM loyalty_ledger WHERE id = last_insert_rowid() AND order_id = NEW.id AND note = 'Thu hồi điểm tích (huỷ/trả đơn)');
END;
