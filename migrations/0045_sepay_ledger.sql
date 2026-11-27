-- SePay × sổ quỹ: số dư quỹ ngân hàng luôn khớp tiền SePay báo về.
-- Tiền vào chưa khớp đơn/hoá đơn được lập phiếu thu vào "Chuyển khoản chờ xử lý" (không vào lãi lỗ); gán/hoàn/bỏ qua lập phiếu chi tương ứng.
-- Không lập phiếu hồi tố cho sự kiện cũ trong migration: dùng thao tác "Ghi các giao dịch chờ cũ vào sổ" (xem docs/SEPAY.md).

INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (920, 'CK_CHO_XL', 'Chuyển khoản chờ xử lý', 'in', 'transfer');
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (921, 'CK_CHO_XL_RA', 'Chuyển ra khỏi khoản chờ xử lý', 'out', 'transfer');

ALTER TABLE sepay_events ADD COLUMN hold_in_voucher_id INTEGER REFERENCES cash_vouchers(id);   -- phiếu thu vào khoản chờ xử lý
ALTER TABLE sepay_events ADD COLUMN hold_out_voucher_id INTEGER REFERENCES cash_vouchers(id);  -- phiếu chi chuyển ra khỏi khoản chờ (gán / hoàn / bỏ qua / dùng QR)
CREATE INDEX idx_sepay_events_hold ON sepay_events(hold_in_voucher_id) WHERE hold_in_voucher_id IS NOT NULL;

-- Dòng sao kê đã được ghi vào quỹ qua SePay (không tạo phiếu thu lần hai)
ALTER TABLE bank_transactions ADD COLUMN sepay_event_id INTEGER REFERENCES sepay_events(id);
CREATE UNIQUE INDEX idx_bank_txn_sepay_once ON bank_transactions(sepay_event_id) WHERE sepay_event_id IS NOT NULL;
