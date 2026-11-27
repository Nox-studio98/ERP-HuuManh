-- FIX-8 (B-N3): hoàn tiền mặt của đơn giao tại quầy sau khi ca tạo đơn đã chốt → ghi vào ca ĐANG MỞ của người hoàn
-- (như orders.refund_shift_id của A-06, nhưng theo từng dòng hoàn vì một đơn có thể hoàn nhiều lần/nhiều hình thức).
-- NULL = dòng thu gốc, hoặc hoàn trong ca tạo đơn (tính vào ca đó), hoặc hoàn qua quỹ khi không có ca mở.
ALTER TABLE payments ADD COLUMN refund_shift_id INTEGER REFERENCES shifts(id);
CREATE INDEX idx_payments_refund_shift ON payments(refund_shift_id) WHERE refund_shift_id IS NOT NULL;
