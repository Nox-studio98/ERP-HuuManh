-- 0014: sửa hạch toán đối soát COD/sàn (A-03/B-05, B-13) + VAT đầu vào (B-07).
-- id cố định 902-905 (ngoài dải 1-99 của seed, sau 901 của migration 0010) để không chiếm id seed; INSERT OR IGNORE để chạy lặp an toàn.
-- Phí sàn/vận chuyển thu hộ: chi phí thật (opex), ghi RA từ quỹ chờ đối soát — không bao giờ ra từ quỹ ngân hàng.
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (902, 'PHI_DOI_SOAT', 'Phí sàn/vận chuyển thu hộ (đối soát)', 'out', 'opex');
-- Chênh lệch đối soát thiếu: chi phí.
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (903, 'CHENH_LECH_DOI_SOAT', 'Chênh lệch đối soát (thiếu)', 'out', 'opex');
-- Chênh lệch đối soát thừa: thu khác (dòng P&L 'other_income').
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (904, 'THU_CHENH_LECH_DOI_SOAT', 'Chênh lệch đối soát (thừa)', 'in', 'other_income');
-- Tiền thực nhận về quỹ thật: chuyển nội bộ từ quỹ chờ, không phải doanh thu mới.
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (905, 'DOI_SOAT', 'Tiền đối soát về quỹ', 'in', 'transfer');
UPDATE cash_categories SET pnl_line = 'transfer' WHERE code = 'DOI_SOAT';

-- B-07: VAT đầu vào khai ở phiếu nhập (chuyển sang hoá đơn mua khi ghi sổ) hoặc khi chốt hoá đơn mua tạm tính.
ALTER TABLE stock_docs ADD COLUMN vat_amount INTEGER NOT NULL DEFAULT 0;
