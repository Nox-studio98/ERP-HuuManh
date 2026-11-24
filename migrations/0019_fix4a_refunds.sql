-- Fix đợt 4a (audit nghiệp vụ A-06, A-07, A-14, A-16).

-- A-06: huỷ đơn của ca đã chốt → tiền mặt hoàn thực tế lấy từ két CA ĐANG MỞ; ghi ca đó vào đơn để expected_cash của ca hiện tại trừ đúng,
--       số liệu ca đã chốt giữ nguyên.
ALTER TABLE orders ADD COLUMN refund_shift_id INTEGER REFERENCES shifts(id);
CREATE INDEX idx_orders_refund_shift ON orders(refund_shift_id);

-- A-14: nghĩa vụ hoàn tiền đơn online. Huỷ/trả hàng chỉ ghi số cần hoàn (refund_due); tiền ra khỏi quỹ khi người có finance.write bấm "Hoàn tiền".
ALTER TABLE orders ADD COLUMN refund_due INTEGER NOT NULL DEFAULT 0;
-- Đơn đã huỷ/trả trước khi có cột này: số còn phải hoàn = tiền đã thu ròng (trừ phí giao nếu chính sách huỷ do khách chịu)
UPDATE orders SET refund_due = MAX(0,
    COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = orders.id AND p.status = 'confirmed'), 0)
    - CASE WHEN shipping_fee_policy = 'customer' THEN shipping_fee ELSE 0 END)
 WHERE channel IN ('online','social') AND kind = 'sale' AND status IN ('cancelled','returned');

-- A-16: ngưỡng hoàn trả POS thu ngân tự làm được; từ ngưỡng trở lên cần quản lý duyệt
INSERT OR IGNORE INTO settings(key, value, note) VALUES
 ('approval.pos_return_vnd', '500000', 'Trả hàng POS từ mức này trở lên (hoặc đơn ca khác/không nhập lại kho) cần quản lý duyệt [Cần xác nhận]');
