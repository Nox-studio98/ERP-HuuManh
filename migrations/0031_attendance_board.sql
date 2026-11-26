-- Bảng chấm công dạng lưới (kiểu KiotViet): phạt vi phạm / thưởng theo ca, chấm công thủ công của quản lý.
-- Xem docs/API-attendance-board.md.

-- Danh mục loại vi phạm / thưởng (quản lý tự thêm). Không xoá: ngừng dùng bằng active = 0.
CREATE TABLE attendance_incident_types (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('penalty','bonus')),
  name TEXT NOT NULL,
  default_amount INTEGER NOT NULL DEFAULT 0 CHECK (default_amount >= 0),   -- VND mỗi lần
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(kind, name)
);

-- Phạt / thưởng ghi theo ca (hoặc theo ngày nếu không có ca). Không sửa, không xoá: huỷ bằng voided_at (có người, lý do).
-- Kỳ lương lấy theo work_date (giờ VN) → cộng vào payroll_items.penalties / bonus.
CREATE TABLE attendance_incidents (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,                              -- YYYY-MM-DD giờ VN
  assignment_id INTEGER REFERENCES shift_assignments(id),
  type_id INTEGER NOT NULL REFERENCES attendance_incident_types(id),
  kind TEXT NOT NULL CHECK (kind IN ('penalty','bonus')),   -- chép từ loại lúc ghi
  times INTEGER NOT NULL DEFAULT 1 CHECK (times > 0),
  amount_each INTEGER NOT NULL CHECK (amount_each >= 0),
  amount INTEGER NOT NULL CHECK (amount >= 0),           -- = times × amount_each
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  void_reason TEXT
);
CREATE INDEX idx_att_incidents_date ON attendance_incidents(work_date, employee_id);
CREATE TRIGGER att_incidents_immutable BEFORE UPDATE OF employee_id, work_date, assignment_id, type_id, kind, times, amount_each, amount, created_by ON attendance_incidents
BEGIN SELECT RAISE(ABORT, 'incident_immutable'); END;
CREATE TRIGGER att_incidents_no_delete BEFORE DELETE ON attendance_incidents BEGIN SELECT RAISE(ABORT, 'incident_immutable'); END;

-- Chặn ghi / huỷ phạt-thưởng vào kỳ lương đã duyệt hoặc đã chi (kỳ lương theo work_date).
CREATE TRIGGER att_incidents_period_ins BEFORE INSERT ON attendance_incidents
WHEN EXISTS (SELECT 1 FROM payroll_periods WHERE period = substr(NEW.work_date, 1, 7) AND status IN ('approved','paid'))
BEGIN SELECT RAISE(ABORT, 'payroll_locked'); END;
CREATE TRIGGER att_incidents_period_void BEFORE UPDATE OF voided_at ON attendance_incidents
WHEN EXISTS (SELECT 1 FROM payroll_periods WHERE period = substr(OLD.work_date, 1, 7) AND status IN ('approved','paid'))
BEGIN SELECT RAISE(ABORT, 'payroll_locked'); END;

-- Số công quy đổi theo bậc (hr.workday_tiers) của từng ngày, chụp lúc chốt kỳ. NULL = lúc chốt chưa bật bậc công → lương không dùng.
ALTER TABLE timesheet_days ADD COLUMN work_units_x10 INTEGER;

-- Ca của người làm thay khi ghi nghỉ (trỏ về ca gốc của người nghỉ).
ALTER TABLE shift_assignments ADD COLUMN substitute_for_id INTEGER REFERENCES shift_assignments(id);

-- Loại phạt/thưởng mẫu (id ≥ 900 để không trùng seed).
INSERT INTO attendance_incident_types (id, kind, name, default_amount) VALUES
  (900, 'penalty', 'Đi muộn không lý do', 20000),
  (901, 'penalty', 'Quên chấm công', 10000),
  (902, 'penalty', 'Vi phạm nội quy', 50000),
  (903, 'bonus', 'Chuyên cần', 20000),
  (904, 'bonus', 'Làm tốt', 50000);

-- Tham số mới (khai báo trong settings-registry.ts).
INSERT OR IGNORE INTO settings(key, value, note) VALUES
  ('hr.attendance_mode', 'shift', 'shift = theo ca làm việc; window = theo khung giờ (không cần xếp ca)'),
  ('hr.window_start', '08:00', ''),
  ('hr.window_end', '17:30', ''),
  ('hr.window_break_start', '', 'để trống = không có nghỉ giữa giờ'),
  ('hr.window_break_end', '', ''),
  ('hr.early_grace_minutes', '0', 'ân hạn về sớm'),
  ('hr.ot_auto', '0', '1 = tự tính làm thêm từ giờ chấm (không cần đăng ký)'),
  ('hr.ot_min_before_minutes', '0', 'chỉ tính làm thêm trước ca khi ≥ số phút này (khi hr.ot_auto = 1)'),
  ('hr.ot_min_after_minutes', '0', 'chỉ tính làm thêm sau ca khi ≥ số phút này (khi hr.ot_auto = 1)'),
  ('hr.workday_tiers', '', 'quy đổi giờ làm → công; để trống = tắt. Dạng "240:5,480:10,600:15"'),
  ('hr.auto_attendance', '0', '1 = ca đã qua không có lần chấm nào được tính đủ giờ theo lịch'),
  ('hr.unscheduled_punch', 'allow', 'off = không cho chấm khi không có ca; approve = cho chấm, chờ duyệt; allow = ghi nhận ngay (mặc định: giữ cách chạy cũ)');
