-- Fix nhóm 4b: giá vốn mua (B-09), lãi lỗ (B-11), lương (C-09, C-14, C-15)

-- B-11: số dư quỹ đầu kỳ nhập bằng phiếu thu nhưng KHÔNG vào P&L (pnl_line = transfer); id 901–905 dùng ở migration 0010/0014, 906 = HOAN_KH (migration 0015)
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (907, 'SO_DU_DAU_KY', 'Số dư quỹ đầu kỳ', 'in', 'transfer');

-- B-09: bản ghi điều chỉnh giá mua khi chốt hoá đơn tạm khác giá
CREATE TABLE purchase_cost_adjustments (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES supplier_bills(id),
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  diff_amount INTEGER NOT NULL,          -- phần chênh phân bổ cho lô (VND, âm = giảm giá)
  onhand_amount INTEGER NOT NULL,        -- phần tính lại vào giá trị tồn (đổi unit_cost)
  cogs_amount INTEGER NOT NULL,          -- phần đã bán, ghi chênh lệch giá mua vào giá vốn
  old_unit_cost INTEGER NOT NULL,
  new_unit_cost INTEGER NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pca_bill ON purchase_cost_adjustments(bill_id);
CREATE INDEX idx_pca_at ON purchase_cost_adjustments(created_at);
CREATE TRIGGER pca_no_update BEFORE UPDATE ON purchase_cost_adjustments BEGIN SELECT RAISE(ABORT, 'purchase_cost_adjustments is immutable'); END;
CREATE TRIGGER pca_no_delete BEFORE DELETE ON purchase_cost_adjustments BEGIN SELECT RAISE(ABORT, 'purchase_cost_adjustments is immutable'); END;

-- C-14 / C-15: cấu hình lương
INSERT OR IGNORE INTO settings(key, value, note) VALUES
  ('hr.monthly_pay_mode', 'proportional', '[Cần xác nhận] Cách tính lương tháng: proportional = theo giờ làm thực tế (ngày công = phút làm / phút ca, tối đa 1, làm tròn 0,1 ngày; đi muộn/về sớm bị trừ); day_present = kiểu cũ, có ≥1 phút công là đủ 1 ngày'),
  ('hr.weekly_off_days', '', '[Cần xác nhận] Ngày nghỉ hằng tuần không tính vào số ngày phép, ví dụ "7" = Chủ nhật, "6,7" = thứ Bảy + Chủ nhật (1=Thứ Hai … 7=Chủ nhật). Để trống = không loại ngày nào theo tuần');
