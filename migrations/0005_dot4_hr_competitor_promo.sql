-- Đợt 4: M9 Nhân sự–chấm công–lương, M7 Giá đối thủ, M2-11 gợi ý đặt hàng,
-- khuyến mãi/voucher/tích điểm (M1-08, M1-13, M3-08, M8-11), giỏ quà & đặt cọc (M1-12),
-- báo cáo tài chính bổ sung (M6-06/07/08/10).
-- Quy ước như các migration trước: tiền INTEGER VND, số lượng INTEGER milli, thời gian ISO UTC do server sinh,
-- "ngày/kỳ" theo giờ VN (YYYY-MM-DD / YYYY-MM).

-- ===== Vai trò mới 'staff' (nhân viên chỉ chấm công + xem phiếu lương của mình) =====
-- SQLite không sửa được CHECK → dựng lại bảng users. defer_foreign_keys cho phép DROP/RENAME khi còn khoá ngoại trỏ tới.
PRAGMA defer_foreign_keys = true;
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier','warehouse','accountant','online_staff','staff')),
  store_id INTEGER REFERENCES stores(id),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO users_new (id, username, full_name, pass_hash, role, store_id, active, must_change_password, failed_logins, locked_until, created_at)
  SELECT id, username, full_name, pass_hash, role, store_id, active, must_change_password, failed_logins, locked_until, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
PRAGMA defer_foreign_keys = false;

-- ============================================================================
-- M9 NHÂN SỰ
-- ============================================================================
CREATE TABLE employees (                 -- M9-01 (dữ liệu nhạy cảm: mọi lần xem/sửa đều ghi audit_log)
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,             -- NV-0001
  user_id INTEGER UNIQUE REFERENCES users(id),   -- tài khoản đăng nhập để chấm công / xem phiếu lương
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  dob TEXT,
  id_number TEXT,                        -- CCCD — chỉ owner/accountant xem
  address TEXT,
  position TEXT NOT NULL,                -- thu ngân, thủ kho, giao hàng, ...
  store_id INTEGER NOT NULL REFERENCES stores(id),
  hire_date TEXT NOT NULL,
  termination_date TEXT,                 -- nghỉ việc: tính công đến ngày làm cuối
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','terminated')),
  pay_type TEXT NOT NULL DEFAULT 'monthly' CHECK (pay_type IN ('monthly','hourly','shift')),   -- [Cần xác nhận]
  base_salary INTEGER NOT NULL DEFAULT 0,      -- lương tháng (monthly)
  hourly_rate INTEGER NOT NULL DEFAULT 0,      -- đơn giá giờ (hourly)
  shift_rate INTEGER NOT NULL DEFAULT 0,       -- đơn giá ca (shift)
  insurance_salary INTEGER NOT NULL DEFAULT 0, -- lương đóng BH; 0 = không đóng [Cần xác nhận]
  dependents INTEGER NOT NULL DEFAULT 0,       -- người phụ thuộc (giảm trừ TNCN)
  pit_enabled INTEGER NOT NULL DEFAULT 1,
  annual_leave_days INTEGER NOT NULL DEFAULT 12,
  location_exempt INTEGER NOT NULL DEFAULT 0,  -- NV giao hàng: chấm không ràng buộc vị trí [Cần xác nhận]
  bank_name TEXT, bank_account TEXT,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE employee_contracts (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  type TEXT NOT NULL,                    -- thử việc / xác định thời hạn / không thời hạn / thời vụ
  start_date TEXT NOT NULL,
  end_date TEXT,
  salary INTEGER,
  file_key TEXT,                         -- R2 hr/contracts/...
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE employee_allowances (       -- phụ cấp cố định hằng tháng (ăn trưa, xăng xe, trách nhiệm...)
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  taxable INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

-- ===== Ca làm & lịch (M9-14, M9-15, M9-06, M9-22) =====
CREATE TABLE shift_templates (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,             -- SANG / CHIEU / TOI
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,              -- "06:00" giờ VN
  end_time TEXT NOT NULL,                -- "14:00"; nhỏ hơn start = ca qua đêm (tính cho ngày bắt đầu)
  break_minutes INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE shift_assignments (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,               -- ngày bắt đầu ca (giờ VN)
  shift_template_id INTEGER NOT NULL REFERENCES shift_templates(id),
  start_at TEXT NOT NULL,                -- UTC tính sẵn từ work_date + giờ ca
  end_at TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(employee_id, work_date, shift_template_id)
);
CREATE INDEX idx_shift_assign_date ON shift_assignments(work_date, status);

CREATE TABLE shift_swap_requests (       -- M9-22 đổi ca giữa hai NV, quản lý duyệt
  id INTEGER PRIMARY KEY,
  from_assignment_id INTEGER NOT NULL REFERENCES shift_assignments(id),
  to_employee_id INTEGER NOT NULL REFERENCES employees(id),
  to_assignment_id INTEGER REFERENCES shift_assignments(id),   -- đổi lấy ca của người kia (tuỳ chọn)
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','approved','rejected','cancelled')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);

-- ===== Chấm công (M9-12, M9-13, M9-20) =====
CREATE TABLE attendance_punches (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL CHECK (kind IN ('in','out')),
  server_at TEXT NOT NULL,               -- GIỜ MÁY CHỦ (M9-12)
  client_at TEXT,                        -- giờ máy NV (chỉ khi chấm offline, để đối chiếu)
  device_id TEXT,
  method TEXT NOT NULL CHECK (method IN ('gps','qr','manual','offline','exempt')),
  lat REAL, lng REAL, accuracy_m REAL,
  distance_m INTEGER,                    -- khoảng cách tới cửa hàng
  qr_window INTEGER,                     -- cửa sổ thời gian của mã QR đã quét (chống dùng lại)
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','pending','rejected')),
  assignment_id INTEGER REFERENCES shift_assignments(id),
  correction_id INTEGER,                 -- tạo từ yêu cầu bổ sung (M9-17)
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT
);
CREATE INDEX idx_punch_emp ON attendance_punches(employee_id, server_at);
-- Nhật ký chấm công bất biến: chỉ được đổi trạng thái duyệt (pending → accepted/rejected), không sửa giờ/người/loại, không xoá.
CREATE TRIGGER punches_immutable BEFORE UPDATE OF employee_id, kind, server_at, client_at, method, lat, lng, device_id ON attendance_punches
BEGIN SELECT RAISE(ABORT, 'attendance_immutable'); END;
CREATE TRIGGER punches_no_delete BEFORE DELETE ON attendance_punches BEGIN SELECT RAISE(ABORT, 'attendance_immutable'); END;
-- Mỗi NV chỉ dùng một mã QR của một cửa sổ thời gian một lần cho mỗi loại chấm
CREATE UNIQUE INDEX idx_punch_qr_once ON attendance_punches(employee_id, kind, qr_window) WHERE qr_window IS NOT NULL;

CREATE TABLE attendance_corrections (    -- M9-17 quên chấm / sửa giờ / chấm ngoài vùng — quản lý duyệt
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('missing_in','missing_out','out_of_area','other')),
  requested_at TEXT,                     -- giờ đề nghị ghi nhận (UTC)
  kind TEXT CHECK (kind IN ('in','out')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE overtime_requests (         -- M9-21 tăng ca: đăng ký trước hoặc quản lý xác nhận sau
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  multiplier_bp INTEGER,                 -- null = theo cài đặt (ngày thường / cuối tuần / lễ)
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);

CREATE TABLE devices_registry_requests ( -- đổi điện thoại chấm công cần quản lý duyệt (chống chấm hộ)
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);

-- ===== Nghỉ phép (M9-18) & ngày lễ =====
CREATE TABLE leave_types (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,             -- annual | sick | unpaid | ...
  name TEXT NOT NULL,
  paid INTEGER NOT NULL DEFAULT 1,
  uses_balance INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE leave_requests (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  half_day INTEGER NOT NULL DEFAULT 0,
  days_x10 INTEGER NOT NULL,             -- số ngày ×10 (0,5 ngày = 5)
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  over_balance INTEGER NOT NULL DEFAULT 0, -- vượt số ngày còn lại → cần quản lý duyệt ngoại lệ
  requested_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);

CREATE TABLE holidays (
  day TEXT PRIMARY KEY,                  -- YYYY-MM-DD
  name TEXT NOT NULL,
  multiplier_bp INTEGER NOT NULL DEFAULT 30000,   -- 300% [Cần xác nhận]
  paid_off INTEGER NOT NULL DEFAULT 1              -- nghỉ hưởng lương
);

-- ===== Bảng công (M9-16, M9-19) =====
CREATE TABLE timesheets (                -- 1 kỳ công / tháng
  period TEXT PRIMARY KEY,               -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT
);

CREATE TABLE timesheet_days (            -- ảnh chụp số công đã tính lúc chốt kỳ (bất biến sau khi chốt)
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL REFERENCES timesheets(period),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  scheduled_minutes INTEGER NOT NULL DEFAULT 0,
  worked_minutes INTEGER NOT NULL DEFAULT 0,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  early_leave_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,    -- chỉ phần đã duyệt
  overtime_multiplier_bp INTEGER NOT NULL DEFAULT 15000,
  shifts_worked INTEGER NOT NULL DEFAULT 0,
  missing_punch INTEGER NOT NULL DEFAULT 0,       -- có vào không có ra: "thiếu công chờ bổ sung"
  leave_code TEXT,
  leave_paid_x10 INTEGER NOT NULL DEFAULT 0,
  holiday INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE(period, employee_id, work_date)
);
CREATE TRIGGER timesheet_days_locked BEFORE UPDATE ON timesheet_days
WHEN EXISTS (SELECT 1 FROM timesheets t WHERE t.period = OLD.period AND t.status = 'closed')
BEGIN SELECT RAISE(ABORT, 'timesheet_closed'); END;
CREATE TRIGGER timesheet_days_locked_del BEFORE DELETE ON timesheet_days
WHEN EXISTS (SELECT 1 FROM timesheets t WHERE t.period = OLD.period AND t.status = 'closed')
BEGIN SELECT RAISE(ABORT, 'timesheet_closed'); END;

CREATE TABLE timesheet_adjustments (     -- sai sót của kỳ đã chốt → điều chỉnh ở kỳ sau, có lý do
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  source_period TEXT NOT NULL,
  target_period TEXT NOT NULL,
  minutes INTEGER NOT NULL,              -- có thể âm
  kind TEXT NOT NULL CHECK (kind IN ('work','overtime')),
  reason TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ===== Lương (M9-03 → M9-11) =====
CREATE TABLE payroll_periods (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL UNIQUE,           -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','calculated','approved','paid')),
  calculated_at TEXT,
  approved_by INTEGER REFERENCES users(id), approved_at TEXT,
  paid_at TEXT, paid_fund_id INTEGER REFERENCES funds(id),
  total_net INTEGER NOT NULL DEFAULT 0,
  total_cost INTEGER NOT NULL DEFAULT 0, -- chi phí công ty (gross + BH phần công ty)
  note TEXT
);

CREATE TABLE payroll_items (
  id INTEGER PRIMARY KEY,
  payroll_period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  pay_type TEXT NOT NULL,
  worked_minutes INTEGER NOT NULL DEFAULT 0,
  paid_days_x10 INTEGER NOT NULL DEFAULT 0,
  shifts INTEGER NOT NULL DEFAULT 0,
  base_pay INTEGER NOT NULL DEFAULT 0,
  allowances INTEGER NOT NULL DEFAULT 0,
  overtime_pay INTEGER NOT NULL DEFAULT 0,
  bonus INTEGER NOT NULL DEFAULT 0,
  sales_bonus INTEGER NOT NULL DEFAULT 0,       -- M9-11
  penalties INTEGER NOT NULL DEFAULT 0,
  adjustments INTEGER NOT NULL DEFAULT 0,       -- dòng điều chỉnh từ kỳ trước
  gross INTEGER NOT NULL DEFAULT 0,
  insurance_employee INTEGER NOT NULL DEFAULT 0,
  insurance_employer INTEGER NOT NULL DEFAULT 0,
  taxable_income INTEGER NOT NULL DEFAULT 0,
  pit INTEGER NOT NULL DEFAULT 0,
  advances INTEGER NOT NULL DEFAULT 0,          -- khấu trừ tạm ứng (M9-08)
  net INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,                             -- diễn giải từng dòng cho phiếu lương
  UNIQUE(payroll_period_id, employee_id)
);
-- Kỳ lương đã duyệt/chi: không sửa dòng lương (sai sót → payroll_entries kind 'adjustment' ở kỳ sau)
CREATE TRIGGER payroll_items_locked BEFORE UPDATE ON payroll_items
WHEN EXISTS (SELECT 1 FROM payroll_periods p WHERE p.id = OLD.payroll_period_id AND p.status IN ('approved','paid'))
BEGIN SELECT RAISE(ABORT, 'payroll_locked'); END;
CREATE TRIGGER payroll_items_locked_del BEFORE DELETE ON payroll_items
WHEN EXISTS (SELECT 1 FROM payroll_periods p WHERE p.id = OLD.payroll_period_id AND p.status IN ('approved','paid'))
BEGIN SELECT RAISE(ABORT, 'payroll_locked'); END;

CREATE TABLE payroll_entries (           -- thưởng / phạt / điều chỉnh thủ công theo kỳ
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  period TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bonus','penalty','allowance','adjustment')),
  amount INTEGER NOT NULL,               -- adjustment có thể âm
  taxable INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  source_period TEXT,                    -- adjustment: kỳ gốc bị sai
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE salary_advances (           -- M9-08 tạm ứng, khấu trừ kỳ sau
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  advance_date TEXT NOT NULL,
  deduct_period TEXT NOT NULL,
  fund_id INTEGER NOT NULL REFERENCES funds(id),
  cash_voucher_id INTEGER REFERENCES cash_vouchers(id),
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','deducted','cancelled')),
  reason TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- M7 GIÁ ĐỐI THỦ
-- ============================================================================
CREATE TABLE competitors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  website TEXT,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE competitor_sources (        -- M7-01
  id INTEGER PRIMARY KEY,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  kind TEXT NOT NULL CHECK (kind IN ('website','marketplace','manual')),
  url TEXT,                              -- trang danh mục / sitemap / feed công khai
  parser TEXT NOT NULL DEFAULT 'jsonld' CHECK (parser IN ('jsonld','microdata','css','manual')),
  parser_config_json TEXT,               -- selector cho parser css
  frequency_minutes INTEGER NOT NULL DEFAULT 720,   -- [Cần xác nhận tần suất]
  min_delay_ms INTEGER NOT NULL DEFAULT 3000,       -- giới hạn tốc độ giữa 2 request
  max_pages INTEGER NOT NULL DEFAULT 20,
  robots_allowed INTEGER,                -- kết quả kiểm robots.txt lần gần nhất
  last_run_at TEXT,
  last_status TEXT,                      -- ok | blocked | layout_changed | error | robots_disallow
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE competitor_products (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES competitor_sources(id),
  external_id TEXT NOT NULL,             -- URL chuẩn hoá hoặc SKU trên trang đối thủ
  url TEXT,
  name TEXT NOT NULL,
  pack_text TEXT,                        -- "hộp 500g", "1 kg", "túi 3 trái"
  pack_qty_milli INTEGER,                -- quy chuẩn (M7-04): số milli đơn vị chuẩn trong 1 gói
  pack_unit TEXT,                        -- kg | trai
  last_price INTEGER,
  last_in_stock INTEGER,
  last_seen_at TEXT,
  UNIQUE(source_id, external_id)
);

CREATE TABLE competitor_price_obs (      -- M7-02/08 lịch sử quan sát giá
  id INTEGER PRIMARY KEY,
  competitor_product_id INTEGER NOT NULL REFERENCES competitor_products(id),
  observed_at TEXT NOT NULL,
  price INTEGER NOT NULL,                -- giá gói
  unit_price INTEGER,                    -- VND / kg hoặc / trái sau chuẩn hoá
  in_stock INTEGER,
  promo_text TEXT,
  source TEXT NOT NULL CHECK (source IN ('crawl','manual','import')),
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','outlier','approved_outlier','rejected')),   -- EC-36
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_cobs_product ON competitor_price_obs(competitor_product_id, observed_at);

CREATE TABLE product_matches (           -- M7-03 ghép SP đối thủ ↔ SP cửa hàng (người duyệt, EC-37)
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  competitor_product_id INTEGER NOT NULL REFERENCES competitor_products(id),
  score INTEGER,                         -- 0–100 độ giống tên gợi ý
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','approved','rejected')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  UNIQUE(product_id, competitor_product_id)
);

CREATE TABLE crawl_runs (                -- M7-07 giám sát
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES competitor_sources(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed','skipped')),
  pages INTEGER NOT NULL DEFAULT 0,
  items INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE price_alerts (              -- M7-09
  id INTEGER PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  competitor_product_id INTEGER REFERENCES competitor_products(id),
  source_id INTEGER REFERENCES competitor_sources(id),
  kind TEXT NOT NULL CHECK (kind IN ('competitor_cheaper','big_change','source_failed','outlier')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acked_by INTEGER REFERENCES users(id),
  acked_at TEXT
);

CREATE TABLE price_suggestions (         -- M7-10 / M3-10: chỉ GỢI Ý, người có quyền quyết định trong M3
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id),
  current_price INTEGER,
  suggested_price INTEGER NOT NULL,
  market_min INTEGER, market_avg INTEGER,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed')),
  price_id INTEGER REFERENCES prices(id),   -- dòng giá tạo ra khi chấp nhận (đi qua luồng duyệt M3)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT
);

-- ===== M2-11 gợi ý đặt hàng: NCC ưu tiên theo sản phẩm =====
CREATE TABLE product_suppliers (
  product_id INTEGER NOT NULL REFERENCES products(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  lead_time_days INTEGER NOT NULL DEFAULT 1,
  order_unit TEXT,                       -- đơn vị đặt (thùng, kg)
  min_order_milli INTEGER NOT NULL DEFAULT 0,
  preferred INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(product_id, supplier_id)
);

-- ============================================================================
-- KHUYẾN MÃI, VOUCHER, TÍCH ĐIỂM (M1-08, M3-08, M8-11, M1-13)
-- ============================================================================
CREATE TABLE promotions (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,             -- KM-0001
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('percent','amount','fixed_price','combo','end_of_day')),
  channels TEXT NOT NULL DEFAULT 'pos,online',      -- pos,online,b2b
  value_bp INTEGER,                      -- percent: basis point (1000 = 10%)
  value_amount INTEGER,                  -- amount: giảm VND; fixed_price/combo: giá trọn gói
  min_order INTEGER NOT NULL DEFAULT 0,
  max_discount INTEGER,                  -- trần giảm (percent)
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  daily_start TEXT, daily_end TEXT,      -- khung giờ trong ngày (giá xả cuối ngày "19:00"–"22:00")
  requires_voucher INTEGER NOT NULL DEFAULT 0,
  stackable INTEGER NOT NULL DEFAULT 0,  -- EC-08 [Cần xác nhận]: mặc định chỉ áp 1 khuyến mãi tốt nhất
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','active','ended','cancelled')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE promotion_items (           -- phạm vi áp dụng; combo: danh sách thành phần bắt buộc
  id INTEGER PRIMARY KEY,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id),
  product_id INTEGER REFERENCES products(id),
  product_group_id INTEGER REFERENCES product_groups(id),
  qty_milli INTEGER,                     -- combo: số lượng mỗi thành phần
  CHECK ((product_id IS NULL) <> (product_group_id IS NULL))
);

CREATE TABLE vouchers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id),
  max_uses INTEGER,                      -- null = không giới hạn
  per_customer_limit INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  customer_id INTEGER REFERENCES customers(id),    -- voucher cá nhân
  active INTEGER NOT NULL DEFAULT 1,
  CHECK (max_uses IS NULL OR used_count <= max_uses)  -- chốt chặn dùng quá lượt khi đồng thời (EC-08)
);

CREATE TABLE order_discounts (           -- khuyến mãi đã áp vào đơn (giữ nguyên dù KM đổi sau)
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  promotion_id INTEGER REFERENCES promotions(id),
  voucher_id INTEGER REFERENCES vouchers(id),
  points_redeemed INTEGER,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  description TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_voucher_once_per_order ON order_discounts(order_id, voucher_id) WHERE voucher_id IS NOT NULL;

CREATE TABLE voucher_redemptions (
  id INTEGER PRIMARY KEY,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  customer_id INTEGER REFERENCES customers(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'used' CHECK (status IN ('used','reversed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(voucher_id, order_id)
);

CREATE TABLE loyalty_ledger (            -- M1-13 sổ điểm (customers.points = số dư, cập nhật cùng batch)
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_id INTEGER REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('earn','redeem','reverse','expire','adjust')),
  points INTEGER NOT NULL,               -- dương = cộng, âm = trừ
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_loyalty_customer ON loyalty_ledger(customer_id, created_at);
CREATE TRIGGER loyalty_no_update BEFORE UPDATE ON loyalty_ledger BEGIN SELECT RAISE(ABORT, 'loyalty_immutable'); END;
CREATE TRIGGER loyalty_no_delete BEFORE DELETE ON loyalty_ledger BEGIN SELECT RAISE(ABORT, 'loyalty_immutable'); END;
-- Không cho số dư điểm âm (đổi điểm đồng thời)
CREATE TRIGGER customers_points_nonneg BEFORE UPDATE OF points ON customers WHEN NEW.points < 0
BEGIN SELECT RAISE(ABORT, 'points_insufficient'); END;

-- ============================================================================
-- GIỎ QUÀ & ĐẶT CỌC (M1-12)
-- ============================================================================
-- Giỏ quà là một sản phẩm; "đóng giỏ" = lệnh lắp ráp tiêu thụ thành phần (FEFO) và tạo lô giỏ quà
-- với giá vốn = tổng giá vốn thành phần (+ chi phí bao bì). Bán giỏ quà sau đó như hàng thường.
CREATE TABLE bundle_components (
  bundle_product_id INTEGER NOT NULL REFERENCES products(id),
  component_product_id INTEGER NOT NULL REFERENCES products(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  PRIMARY KEY (bundle_product_id, component_product_id),
  CHECK (bundle_product_id <> component_product_id)
);

CREATE TABLE assembly_orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,             -- LR-YYYYMMDD-0001
  bundle_product_id INTEGER NOT NULL REFERENCES products(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  extra_cost INTEGER NOT NULL DEFAULT 0, -- giỏ, nơ, thiệp...
  expires_at TEXT,
  lot_id INTEGER REFERENCES lots(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE order_deposits (            -- đặt trước giỏ quà dịp lễ: cọc khi đặt, trừ vào khi giao
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  fund_id INTEGER NOT NULL REFERENCES funds(id),
  cash_voucher_id INTEGER REFERENCES cash_vouchers(id),
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','applied','refunded','forfeited')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  settled_at TEXT
);
ALTER TABLE orders ADD COLUMN pickup_date TEXT;          -- ngày hẹn lấy/giao đơn đặt trước tại quầy

-- ============================================================================
-- TÀI CHÍNH BỔ SUNG (M6-06, M6-08, M6-10)
-- ============================================================================
ALTER TABLE supplier_bills ADD COLUMN vat_amount INTEGER NOT NULL DEFAULT 0;   -- thuế GTGT đầu vào (M6-08)
ALTER TABLE cash_vouchers ADD COLUMN channel TEXT;      -- chi phí gắn trực tiếp cho kênh (pos/online/b2b) — M6-06

CREATE TABLE cost_allocation_rules (     -- M6-06 phân bổ chi phí chung theo kênh
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES cash_categories(id),
  method TEXT NOT NULL CHECK (method IN ('revenue_share','fixed_bp')),
  weights_json TEXT,                     -- fixed_bp: {"pos":5000,"online":3000,"b2b":2000}
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(category_id)
);

CREATE TABLE budgets (                   -- M6-10 ngân sách theo kỳ & danh mục
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,                  -- YYYY-MM
  category_id INTEGER REFERENCES cash_categories(id),
  line TEXT,                             -- hoặc dòng P&L: revenue | cogs | opex | payroll | shrinkage
  amount INTEGER NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  CHECK ((category_id IS NULL) <> (line IS NULL)),
  UNIQUE(period, category_id, line)
);

-- ============================================================================
-- CÀI ĐẶT (đa số [Cần xác nhận] với chủ cửa hàng)
-- ============================================================================
INSERT OR IGNORE INTO settings(key, value, note) VALUES
 ('hr.standard_workdays', '26', 'Ngày công chuẩn/tháng cho lương tháng [Cần xác nhận]'),
 ('hr.late_grace_minutes', '5', 'Đi muộn quá N phút mới tính muộn [Cần xác nhận]'),
 ('hr.rounding_minutes', '15', 'Làm tròn phút tăng ca xuống bội số N phút [Cần xác nhận]'),
 ('hr.ot_weekday_bp', '15000', 'Hệ số tăng ca ngày thường 150% [Cần xác nhận]'),
 ('hr.ot_weekend_bp', '20000', 'Hệ số tăng ca cuối tuần 200% [Cần xác nhận]'),
 ('hr.ot_holiday_bp', '30000', 'Hệ số làm ngày lễ 300% [Cần xác nhận]'),
 ('hr.attendance_methods', 'gps,qr', 'Cách xác thực nơi chấm: gps, qr hoặc cả hai [Cần xác nhận]'),
 ('hr.gps_max_accuracy_m', '100', 'Bỏ qua toạ độ có sai số lớn hơn N mét'),
 ('hr.qr_window_seconds', '30', 'Mã QR chấm công đổi mỗi N giây'),
 ('hr.insurance_employee_bp', '1050', 'BHXH 8% + BHYT 1,5% + BHTN 1% phần NLĐ [Cần xác nhận]'),
 ('hr.insurance_employer_bp', '2150', 'BH phần doanh nghiệp 21,5% [Cần xác nhận]'),
 ('hr.insurance_cap_vnd', '46800000', 'Trần lương đóng BH (20 × lương cơ sở) [Cần xác nhận theo năm]'),
 ('hr.pit_family_deduction', '15500000', 'Giảm trừ gia cảnh bản thân [Cần xác nhận theo quy định hiện hành]'),
 ('hr.pit_dependent_deduction', '6200000', 'Giảm trừ mỗi người phụ thuộc [Cần xác nhận theo quy định hiện hành]'),
 ('hr.pit_brackets_json', '[[5000000,500],[10000000,1000],[18000000,1500],[32000000,2000],[52000000,2500],[80000000,3000],[null,3500]]', 'Biểu thuế TNCN luỹ tiến [trần, bp] [Cần xác nhận theo luật hiện hành]'),
 ('hr.sales_bonus_bp', '0', 'Thưởng doanh số: % doanh thu NV bán (0 = tắt) [Cần xác nhận]'),
 ('competitor.outlier_band_bp', '5000', 'Giá đối thủ lệch >50% so với trung vị → nghi bất thường (EC-36)'),
 ('competitor.alert_change_bp', '1000', 'Cảnh báo khi đối thủ đổi giá >10%'),
 ('competitor.user_agent', 'HuuManhPriceBot/1.0 (+lien he cua hang)', 'User-Agent khi thu thập [Cần xác nhận thông tin liên hệ]'),
 ('reorder.lookback_days', '14', 'Số ngày tính tốc độ bán cho gợi ý đặt hàng'),
 ('reorder.cover_days', '3', 'Số ngày tồn kho mục tiêu sau khi hàng về'),
 ('loyalty.enabled', '0', 'Bật tích điểm [Cần xác nhận]'),
 ('loyalty.earn_per_vnd', '10000', 'Mỗi N đồng chi tiêu = 1 điểm [Cần xác nhận]'),
 ('loyalty.point_value_vnd', '100', '1 điểm = N đồng khi đổi [Cần xác nhận]'),
 ('loyalty.max_redeem_bp', '5000', 'Đổi điểm tối đa 50% giá trị đơn [Cần xác nhận]'),
 ('promo.allow_stacking', '0', 'EC-08: 0 = chỉ áp khuyến mãi tốt nhất; 1 = cho cộng dồn KM stackable [Cần xác nhận]'),
 ('deposit.min_bp', '3000', 'Đặt cọc tối thiểu 30% cho đơn đặt trước giỏ quà [Cần xác nhận]'),
 ('recurring.auto_generate', '1', 'Tự sinh đơn sỉ lặp cho ngày mai lúc 08:00 (M4-08)');

INSERT OR IGNORE INTO leave_types(code, name, paid, uses_balance) VALUES
 ('annual', 'Phép năm', 1, 1),
 ('sick', 'Nghỉ ốm', 1, 0),
 ('unpaid', 'Nghỉ không lương', 0, 0);

INSERT OR IGNORE INTO shift_templates(code, name, start_time, end_time, break_minutes) VALUES
 ('SANG', 'Ca sáng', '06:00', '14:00', 30),
 ('CHIEU', 'Ca chiều', '14:00', '22:00', 30);
