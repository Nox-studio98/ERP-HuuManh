-- Hữu Mạnh ERP — dữ liệu demo đợt 4 (nhân sự, đối thủ, gợi ý đặt hàng, giỏ quà, khuyến mãi).
-- Chạy SAU migrations/0005_dot4_hr_competitor_promo.sql và seed/seed.sql.
-- Dùng INSERT OR IGNORE + id tường minh nên chạy lại an toàn.
-- Toàn bộ nhân viên, đối thủ là dữ liệu giả/minh hoạ (không phải người thật, không phải công ty thật).

PRAGMA foreign_keys = ON;

-- ===== Ngày lễ (M9): hệ số lương 300% [Cần xác nhận], nghỉ hưởng lương =====
-- Ngày âm lịch & ngày nghỉ bù: [Cần xác nhận theo thông báo chính thức hằng năm]
INSERT OR IGNORE INTO holidays (day, name, multiplier_bp, paid_off) VALUES
  ('2026-01-01', 'Tết Dương lịch', 30000, 1),
  ('2026-02-16', 'Tết Nguyên Đán (ngày 1)', 30000, 1),
  ('2026-02-17', 'Tết Nguyên Đán (ngày 2)', 30000, 1),
  ('2026-02-18', 'Tết Nguyên Đán (ngày 3)', 30000, 1),
  ('2026-02-19', 'Tết Nguyên Đán (ngày 4)', 30000, 1),
  ('2026-02-20', 'Tết Nguyên Đán (ngày 5)', 30000, 1),
  ('2026-04-26', 'Giỗ Tổ Hùng Vương', 30000, 1),
  ('2026-04-30', 'Giải phóng miền Nam', 30000, 1),
  ('2026-05-01', 'Quốc tế Lao động', 30000, 1),
  ('2026-09-01', 'Quốc khánh (ngày nghỉ liền kề)', 30000, 1),
  ('2026-09-02', 'Quốc khánh', 30000, 1),
  ('2027-01-01', 'Tết Dương lịch', 30000, 1),
  ('2027-02-05', 'Tết Nguyên Đán (ngày 1)', 30000, 1),
  ('2027-02-06', 'Tết Nguyên Đán (ngày 2)', 30000, 1),
  ('2027-02-07', 'Tết Nguyên Đán (ngày 3)', 30000, 1),
  ('2027-02-08', 'Tết Nguyên Đán (ngày 4)', 30000, 1),
  ('2027-02-09', 'Tết Nguyên Đán (ngày 5)', 30000, 1),
  ('2027-04-16', 'Giỗ Tổ Hùng Vương', 30000, 1),
  ('2027-04-30', 'Giải phóng miền Nam', 30000, 1),
  ('2027-05-01', 'Quốc tế Lao động', 30000, 1),
  ('2027-09-01', 'Quốc khánh (ngày nghỉ liền kề)', 30000, 1),
  ('2027-09-02', 'Quốc khánh', 30000, 1);

-- ===== Nhân viên demo (M9-01). Tên giả, user_id NULL: tài khoản tạo qua app. =====
-- Cột: id, code, full_name, position, store_id, hire_date, pay_type, base_salary, hourly_rate, shift_rate, insurance_salary, location_exempt
INSERT OR IGNORE INTO employees
  (id, code, user_id, full_name, position, store_id, hire_date, status, pay_type,
   base_salary, hourly_rate, shift_rate, insurance_salary, location_exempt) VALUES
  (1, 'NV-0001', NULL, 'Nguyễn Văn An (demo)',  'thu ngân',  1, '2026-01-05', 'active', 'monthly', 7000000, 0,     0,      7000000, 0),
  (2, 'NV-0002', NULL, 'Trần Thị Bình (demo)',  'thu ngân',  1, '2026-01-05', 'active', 'hourly',  0,       30000, 0,      0,       0),
  (3, 'NV-0003', NULL, 'Lê Minh Cường (demo)',  'thủ kho',   1, '2026-01-05', 'active', 'monthly', 8000000, 0,     0,      8000000, 0),
  (4, 'NV-0004', NULL, 'Phạm Thu Dung (demo)',  'giao hàng', 1, '2026-01-05', 'active', 'shift',   0,       0,     220000, 0,       1),
  (5, 'NV-0005', NULL, 'Hoàng Quốc Em (demo)',  'kế toán',   1, '2026-01-05', 'active', 'monthly', 9000000, 0,     0,      9000000, 0);

-- ===== Phụ cấp cố định hằng tháng =====
INSERT OR IGNORE INTO employee_allowances (id, employee_id, name, amount, taxable, active) VALUES
  (1, 1, 'Ăn trưa', 730000, 0, 1),
  (2, 2, 'Ăn trưa', 730000, 0, 1),
  (3, 3, 'Ăn trưa', 730000, 0, 1),
  (4, 4, 'Ăn trưa', 730000, 0, 1),
  (5, 5, 'Ăn trưa', 730000, 0, 1),
  (6, 4, 'Xăng xe', 500000, 1, 1);

-- ===== Đối thủ giả lập (M7-01) — tên minh hoạ, không URL thật =====
INSERT OR IGNORE INTO competitors (id, name, website, note, active) VALUES
  (1, 'Đối thủ A (ví dụ)',        NULL, 'Dữ liệu demo, nhập tay', 1),
  (2, 'Đối thủ B (ví dụ)',        NULL, 'Dữ liệu demo, nhập tay', 1),
  (3, 'Chợ truyền thống (ví dụ)', NULL, 'Dữ liệu demo, nhập tay', 1);

INSERT OR IGNORE INTO competitor_sources (id, competitor_id, kind, url, parser, active) VALUES
  (1, 1, 'manual', NULL, 'manual', 1),
  (2, 2, 'manual', NULL, 'manual', 1),
  (3, 3, 'manual', NULL, 'manual', 1);

-- ===== Gợi ý nhà cung cấp cho sản phẩm 1–29 (M2-11) =====
-- Nhập khẩu 1–10: NCC02, lead 2 ngày, đặt theo thùng nếu có đơn vị 'thung', còn lại theo đơn vị chính.
INSERT OR IGNORE INTO product_suppliers (product_id, supplier_id, lead_time_days, order_unit, min_order_milli, preferred) VALUES
  (1,  2, 2, 'thung', 0, 1),
  (2,  2, 2, 'thung', 0, 1),
  (3,  2, 2, 'kg',    0, 1),
  (4,  2, 2, 'thung', 0, 1),
  (5,  2, 2, 'thung', 0, 1),
  (6,  2, 2, 'thung', 0, 1),
  (7,  2, 2, 'kg',    0, 1),
  (8,  2, 2, 'kg',    0, 1),
  (9,  2, 2, 'trai',  0, 1),
  (10, 2, 2, 'trai',  0, 1);

-- Nội địa 11–18: NCC04; 19–24: NCC05; lead 1 ngày, đặt theo đơn vị chính. (25, 26 là giỏ quà: không gắn NCC)
INSERT OR IGNORE INTO product_suppliers (product_id, supplier_id, lead_time_days, order_unit, min_order_milli, preferred) VALUES
  (11, 4, 1, 'kg',   0, 1),
  (12, 4, 1, 'trai', 0, 1),
  (13, 4, 1, 'kg',   0, 1),
  (14, 4, 1, 'kg',   0, 1),
  (15, 4, 1, 'kg',   0, 1),
  (16, 4, 1, 'trai', 0, 1),
  (17, 4, 1, 'kg',   0, 1),
  (18, 4, 1, 'kg',   0, 1),
  (19, 5, 1, 'kg',   0, 1),
  (20, 5, 1, 'trai', 0, 1),
  (21, 5, 1, 'kg',   0, 1),
  (22, 5, 1, 'kg',   0, 1),
  (23, 5, 1, 'kg',   0, 1),
  (24, 5, 1, 'kg',   0, 1);

-- Hàng đóng gói 27–29: NCC03 (Đà Lạt), lead 2 ngày, đặt theo hộp.
INSERT OR IGNORE INTO product_suppliers (product_id, supplier_id, lead_time_days, order_unit, min_order_milli, preferred) VALUES
  (27, 3, 2, 'hop', 0, 1),
  (28, 3, 2, 'hop', 0, 1),
  (29, 3, 2, 'hop', 0, 1);

-- ===== Thành phần giỏ quà (M1-12). qty_milli: 2000 = 2 kg, 1000 = 1 kg/1 trái =====
INSERT OR IGNORE INTO bundle_components (bundle_product_id, component_product_id, qty_milli) VALUES
  (25, 1,  2000),
  (25, 4,  1000),
  (25, 12, 1000),
  (26, 3,  1000),
  (26, 2,  1000),
  (26, 5,  1000);

-- ===== Khuyến mãi nháp (M1-08, M3-08, M8-11). Trạng thái 'draft': chưa kích hoạt. =====
INSERT OR IGNORE INTO promotions
  (id, code, name, kind, channels, value_bp, value_amount, min_order, max_discount,
   starts_at, ends_at, daily_start, daily_end, requires_voucher, status, created_by) VALUES
  (1, 'KM-0001', 'Giảm 10% trái cây nhập khẩu', 'percent',     'pos,online', 1000, NULL,   0,      50000, '2026-12-01T00:00:00.000Z', '2027-02-28T23:59:59.000Z', NULL,    NULL,    0, 'draft', 1),
  (2, 'KM-0002', 'Xả cuối ngày 20%',           'end_of_day',   'pos',        2000, NULL,   0,      NULL,  '2026-12-01T00:00:00.000Z', '2027-02-28T23:59:59.000Z', '19:00', '22:00', 0, 'draft', 1),
  (3, 'KM-0003', 'Voucher 30.000đ đơn từ 300.000đ', 'amount',  'online',     NULL, 30000,  300000, NULL,  '2026-12-01T00:00:00.000Z', '2027-02-28T23:59:59.000Z', NULL,    NULL,    1, 'draft', 1);

-- Phạm vi: KM-0001 áp cho nhóm 'Trái cây nhập khẩu'; KM-0002 áp cho nhóm 'Trái cây nội địa'; KM-0003 áp cho toàn đơn (không có dòng phạm vi).
INSERT OR IGNORE INTO promotion_items (id, promotion_id, product_id, product_group_id, qty_milli) VALUES
  (1, 1, NULL, 1, NULL),
  (2, 2, NULL, 2, NULL);
