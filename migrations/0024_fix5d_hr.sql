-- Fix nhóm 5d: nhân sự – chấm công – lương (audit C-10, C-11, C-12, C-18, C-19, C-20, C-24, C-25, C-26, C-31)

-- C-11: xác nhận "đã xem" cho cảnh báo chấm công (audit_log action='hr.alert' là bất biến nên lưu riêng)
CREATE TABLE hr_alert_acks (
  alert_id INTEGER PRIMARY KEY,          -- audit_log.id của dòng hr.alert
  acked_by INTEGER NOT NULL REFERENCES users(id),
  acked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  note TEXT
);

-- C-18: lịch sử lương theo ngày hiệu lực. CHỈ người có hr.sensitive đọc được (API); audit_log vẫn không ghi giá trị lương.
-- field: baseSalary | hourlyRate | shiftRate | insuranceSalary | allowance (ref_id = employee_allowances.id)
-- Giá trị hiệu lực tại ngày D = new_value của bản ghi mới nhất có effective_date <= D;
-- nếu chưa có bản ghi nào <= D mà có bản ghi sau D thì lấy old_value của bản ghi sớm nhất sau D; không có bản ghi nào thì lấy giá trị hiện hành.
CREATE TABLE employee_salary_history (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  field TEXT NOT NULL,
  ref_id INTEGER,
  old_value INTEGER NOT NULL,
  new_value INTEGER NOT NULL,
  effective_date TEXT NOT NULL,
  reason TEXT,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_salary_hist_emp ON employee_salary_history(employee_id, field, effective_date);
CREATE TRIGGER salary_hist_no_update BEFORE UPDATE ON employee_salary_history BEGIN SELECT RAISE(ABORT, 'employee_salary_history is immutable'); END;
CREATE TRIGGER salary_hist_no_delete BEFORE DELETE ON employee_salary_history BEGIN SELECT RAISE(ABORT, 'employee_salary_history is immutable'); END;

-- C-12 / C-19 / C-24: tham số mới (đều [Cần xác nhận] với cửa hàng)
INSERT OR IGNORE INTO settings(key, value, note) VALUES
  ('hr.advance_max_bp', '5000', '[Cần xác nhận] Tạm ứng luỹ kế của một nhân viên cho cùng một kỳ khấu trừ tối đa bao nhiêu % lương tháng (bp, 5000 = 50%; 0 = không giới hạn). Lương tháng quy đổi: tháng = lương cơ bản; giờ = đơn giá giờ × 8 × ngày công chuẩn; ca = đơn giá ca × ngày công chuẩn'),
  ('hr.holiday_premium_bp', '0', '[Cần xác nhận] Phụ trội cho giờ làm TRONG CA vào ngày lễ (bp cộng thêm trên lương giờ thường, 20000 = +200%, tức tổng 300%); 0 = không phụ trội. Giờ tăng ca đã duyệt vẫn trả riêng theo hệ số tăng ca'),
  ('hr.weekend_premium_bp', '0', '[Cần xác nhận] Phụ trội cho giờ làm TRONG CA vào thứ Bảy/Chủ nhật (bp cộng thêm, 5000 = +50%); 0 = không phụ trội'),
  ('hr.prorate_fixed_pay', '1', '[Cần xác nhận] 1 = phụ cấp cố định và lương đóng bảo hiểm tính theo tỉ lệ ngày làm khi nhân viên vào/nghỉ giữa tháng hoặc cả tháng không có công; 0 = tính đủ tháng như cũ');
