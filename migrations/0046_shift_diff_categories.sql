-- L-3 (dot10-R2): chênh lệch tiền khi chốt ca vào sổ quỹ tiền mặt bằng phiếu thu/chi hệ thống (ref_type='shift').
-- Thừa két: phiếu thu vào thu nhập khác; thiếu két: phiếu chi vào chi phí hoạt động. Id >= 900 để không trùng seed.
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (930, 'THUA_KET', 'Chênh lệch két (thừa)', 'in', 'other_income');
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (931, 'THIEU_KET', 'Chênh lệch két (thiếu)', 'out', 'opex');
