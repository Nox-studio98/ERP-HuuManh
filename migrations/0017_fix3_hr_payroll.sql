-- Fix nhóm 3: nhân sự / lương / sao lưu (audit C-01, C-04, C-05, C-08)

-- C-01: giờ hiệu lực của lần chấm công. Chấm offline dùng client_at (đã kiểm tra hợp lý), còn lại = server_at.
-- Bản ghi vẫn bất biến: server_at/client_at không sửa được, effective_at cũng không sửa được sau khi đã đặt.
ALTER TABLE attendance_punches ADD COLUMN effective_at TEXT;
ALTER TABLE attendance_punches ADD COLUMN review_flag INTEGER NOT NULL DEFAULT 0;  -- 1 = chấm offline tính ngay, chờ quản lý xem lại
UPDATE attendance_punches SET effective_at = server_at WHERE effective_at IS NULL;
CREATE INDEX idx_punch_eff ON attendance_punches(employee_id, effective_at);
CREATE TRIGGER punches_effective_immutable BEFORE UPDATE OF effective_at ON attendance_punches
WHEN OLD.effective_at IS NOT NULL AND NEW.effective_at IS NOT OLD.effective_at
BEGIN SELECT RAISE(ABORT, 'attendance_immutable'); END;

-- C-04: dấu vân tay dữ liệu đầu vào lúc tính lương; duyệt phải khớp.
ALTER TABLE payroll_periods ADD COLUMN inputs_hash TEXT;

-- C-05: phần tạm ứng chưa khấu trừ hết được chuyển kỳ sau
ALTER TABLE payroll_items ADD COLUMN advances_carried INTEGER NOT NULL DEFAULT 0;
ALTER TABLE salary_advances ADD COLUMN carried_from_id INTEGER REFERENCES salary_advances(id);

-- C-08: duyệt phép vượt số dư (ngoại lệ có lý do)
ALTER TABLE leave_requests ADD COLUMN exception_reason TEXT;

INSERT OR IGNORE INTO settings(key, value, note) VALUES
  ('hr.offline_max_hours', '48', 'Chấm công offline: chấp nhận giờ máy NV (client_at) lùi tối đa bao nhiêu giờ so với lúc gửi lên'),
  ('backup.retention_days', '30', 'Số ngày giữ bản sao lưu R2 (backups/YYYY-MM-DD/)');
