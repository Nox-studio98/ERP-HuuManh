-- Hữu Mạnh ERP — dữ liệu demo (master data) cho môi trường local/staging.
-- Chạy SAU migrations/0001_init.sql. Dùng INSERT OR IGNORE + id tường minh nên chạy lại an toàn.
-- Không chứa lô hàng, đơn hàng, hay dữ liệu của người thật.
-- Quy ước: tiền = VND nguyên; số lượng = milli (1 kg = 1000); factor_milli = milli của đơn vị chính trong 1 đơn vị.

PRAGMA foreign_keys = ON;

-- ===== Cửa hàng & vị trí =====
INSERT OR IGNORE INTO stores (id, code, name, address, active)
VALUES (1, 'CH1', 'Hữu Mạnh - Cửa hàng 1', NULL, 1);

INSERT OR IGNORE INTO locations (id, store_id, code, name, sellable) VALUES
  (1, 1, 'QUAY',    'Quầy',                    1),
  (2, 1, 'KHOLANH', 'Kho lạnh',                1),
  (3, 1, 'HONG',    'Khu hàng hỏng/chờ huỷ',   0);

-- ===== Người dùng hệ thống (không đăng nhập được: active=0, pass_hash không verify được) =====
INSERT OR IGNORE INTO users (id, username, full_name, pass_hash, role, store_id, active)
VALUES (1, 'system', 'Hệ thống', '!disabled', 'owner', 1, 0);

-- ===== Quỹ =====
INSERT OR IGNORE INTO funds (id, store_id, code, name, type, active) VALUES
  (1, 1, 'TM-CH1',     'Tiền mặt tại cửa hàng 1',       'cash',                 1),
  (2, 1, 'NH-01',      'Tài khoản ngân hàng chính',     'bank',                 1),
  (3, 1, 'VI-01',      'Ví điện tử',                    'ewallet',              1),
  (4, 1, 'COD-01',     'Đối soát COD (giao hàng thu hộ)', 'cod_clearing',       1),
  (5, 1, 'SAN-FRESCO', 'Đối soát sàn Fresco',           'marketplace_clearing', 1);

-- ===== Danh mục thu chi =====
INSERT OR IGNORE INTO cash_categories (id, code, name, direction, pnl_line) VALUES
  (1,  'BAN_HANG',  'Doanh thu bán hàng',        'in',  'revenue'),
  (2,  'TIEN_HANG', 'Tiền hàng nhập',            'out', 'cogs'),
  (3,  'MAT_BANG',  'Tiền mặt bằng',             'out', 'opex'),
  (4,  'DIEN_NUOC', 'Tiền điện, nước',           'out', 'opex'),
  (5,  'VAN_CHUYEN','Vận chuyển',                'out', 'opex'),
  (6,  'BAO_BI',    'Bao bì, túi, hộp',          'out', 'opex'),
  (7,  'KHAC',      'Chi phí khác',              'out', 'opex'),
  (8,  'LUONG',     'Lương nhân viên',           'out', 'payroll'),
  (9,  'HAO_HUT',   'Hao hụt, huỷ hàng',         'out', 'shrinkage'),
  (10, 'THU_KHAC',  'Thu khác',                  'in',  'other');

-- ===== Nhóm khách hàng & bảng giá =====
INSERT OR IGNORE INTO customer_groups (id, code, name) VALUES
  (1, 'le',         'Khách lẻ'),
  (2, 'than_thiet', 'Khách thân thiết'),
  (3, 'si_1',       'Sỉ cấp 1'),
  (4, 'si_2',       'Sỉ cấp 2');

INSERT OR IGNORE INTO price_lists (id, name, channel, customer_group_id, kind, priority, active) VALUES
  (1, 'Giá chung',   'all',    NULL, 'base',  0,  1),
  (2, 'Giá online',  'online', NULL, 'base',  5,  1),
  (3, 'Sỉ cấp 1',    'b2b',    3,    'group', 20, 1),
  (4, 'Sỉ cấp 2',    'b2b',    4,    'group', 20, 1);

-- ===== Nhóm hàng (biên mục tiêu theo basis point) =====
INSERT OR IGNORE INTO product_groups (id, name, target_margin_bp) VALUES
  (1, 'Trái cây nhập khẩu', 3500),
  (2, 'Trái cây nội địa',   3000),
  (3, 'Giỏ quà',            4000),
  (4, 'Hàng đóng gói',      2500);

-- ===== Sản phẩm =====
-- Cột: id, sku, barcode (NULL: hệ thống tự sinh), name, group_id, base_unit, sell_by_weight, origin, shelf_life_days, min_stock_milli, active
INSERT OR IGNORE INTO products
  (id, sku, barcode, name, group_id, base_unit, sell_by_weight, origin, shelf_life_days, min_stock_milli, active) VALUES
  -- Trái cây nhập khẩu (group 1)
  (1,  'TAO-ENVY',          NULL, 'Táo Envy',                        1, 'kg',   1, 'New Zealand', 60, 20000, 1),
  (2,  'NHO-XANH-UC',       NULL, 'Nho xanh Úc',                     1, 'kg',   1, 'Úc',          21, 10000, 1),
  (3,  'CHERRY-MY',         NULL, 'Cherry Mỹ',                       1, 'kg',   1, 'Mỹ',          21,  3000, 1),
  (4,  'KIWI-VANG',         NULL, 'Kiwi vàng',                       1, 'kg',   1, 'New Zealand', 45,  5000, 1),
  (5,  'LE-HAN',            NULL, 'Lê Hàn Quốc',                     1, 'kg',   1, 'Hàn Quốc',    45, 10000, 1),
  (6,  'CAM-MY',            NULL, 'Cam Mỹ',                          1, 'kg',   1, 'Mỹ',          30, 10000, 1),
  (7,  'MIT-THAI',          NULL, 'Mít Thái',                        1, 'kg',   1, 'Thái Lan',     5,  5000, 1),
  (8,  'CHUOI-NAM-MY',      NULL, 'Chuối già Nam Mỹ',                1, 'kg',   1, 'Nam Mỹ',       7, 10000, 1),
  (9,  'LUU-AN-DO',         NULL, 'Lựu Ấn Độ',                      1, 'trai', 0, 'Ấn Độ',       30, 10000, 1),
  (10, 'DUA-LUOI-DL',       NULL, 'Dưa lưới Đài Loan',               1, 'trai', 0, 'Đài Loan',     7,  4000, 1),
  -- Trái cây nội địa (group 2)
  (11, 'XOAI-CAT-HL',       NULL, 'Xoài cát Hoà Lộc',                2, 'kg',   1, 'Tiền Giang',   7, 10000, 1),
  (12, 'BUOI-DA-XANH',      NULL, 'Bưởi da xanh',                    2, 'trai', 0, 'Bến Tre',     14, 10000, 1),
  (13, 'SAU-RIENG-RI6',     NULL, 'Sầu riêng Ri6',                   2, 'kg',   1, 'Tiền Giang',   5,  5000, 1),
  (14, 'MANG-CUT',          NULL, 'Măng cụt',                        2, 'kg',   1, 'Bến Tre',      5,  3000, 1),
  (15, 'THANH-LONG-DO',     NULL, 'Thanh long ruột đỏ',              2, 'kg',   1, 'Bình Thuận',  10, 10000, 1),
  (16, 'DUA-HAU',           NULL, 'Dưa hấu',                         2, 'trai', 0, 'Long An',      7, 10000, 1),
  (17, 'OI',                NULL, 'Ổi',                              2, 'kg',   1, 'Đồng Tháp',    7,  5000, 1),
  (18, 'CHOM-CHOM',         NULL, 'Chôm chôm',                       2, 'kg',   1, 'Bến Tre',      5,  5000, 1),
  (19, 'VU-SUA-LO-REN',     NULL, 'Vú sữa Lò Rèn',                   2, 'kg',   1, 'Vĩnh Long',    5,  3000, 1),
  (20, 'DUA-THOM',          NULL, 'Dứa',                             2, 'trai', 0, 'Tiền Giang',   7,  5000, 1),
  (21, 'BO-034',            NULL, 'Bơ 034',                          2, 'kg',   1, 'Đắk Lắk',       7, 10000, 1),
  (22, 'VAI-THIEU',         NULL, 'Vải thiều Lục Ngạn',              2, 'kg',   1, 'Bắc Giang',     5,  5000, 1),
  (23, 'DU-DU',             NULL, 'Đu đủ',                           2, 'kg',   1, 'Đồng Nai',      7,  5000, 1),
  (24, 'CHUOI-TIEU',        NULL, 'Chuối tiêu',                      2, 'kg',   1, 'Đồng Tháp',     5,  5000, 1),
  -- Giỏ quà (group 3)
  (25, 'GIO-QUA-TET',       NULL, 'Giỏ quà Tết',                     3, 'hop',  0, 'Việt Nam',     14,     0, 1),
  (26, 'GIO-TRAI-CAO-CAP',  NULL, 'Giỏ trái cây cao cấp',            3, 'hop',  0, 'Việt Nam',      7,     0, 1),
  -- Hàng đóng gói (group 4)
  (27, 'DAU-TAY-DL-HOP',    NULL, 'Dâu tây Đà Lạt (hộp 250g)',       4, 'hop',  0, 'Đà Lạt',        5,  5000, 1),
  (28, 'VIET-QUAT-HOP',     NULL, 'Việt quất (hộp 125g)',            4, 'hop',  0, 'Peru',         14,  5000, 1),
  (29, 'SALAD-TRAI-CAY-HOP',NULL, 'Salad trái cây (hộp 500g)',       4, 'hop',  0, 'Việt Nam',      3,  5000, 1);

-- ===== Đơn vị quy đổi =====
-- Mọi sản phẩm: đơn vị chính, factor 1000 (1 đơn vị chính = 1000 milli).
INSERT OR IGNORE INTO product_units (product_id, unit, factor_milli, barcode) VALUES
  (1,  'kg',   1000, NULL), (2,  'kg',   1000, NULL), (3,  'kg',   1000, NULL), (4,  'kg',   1000, NULL),
  (5,  'kg',   1000, NULL), (6,  'kg',   1000, NULL), (7,  'kg',   1000, NULL), (8,  'kg',   1000, NULL),
  (9,  'trai', 1000, NULL), (10, 'trai', 1000, NULL), (11, 'kg',   1000, NULL), (12, 'trai', 1000, NULL),
  (13, 'kg',   1000, NULL), (14, 'kg',   1000, NULL), (15, 'kg',   1000, NULL), (16, 'trai', 1000, NULL),
  (17, 'kg',   1000, NULL), (18, 'kg',   1000, NULL), (19, 'kg',   1000, NULL), (20, 'trai', 1000, NULL),
  (21, 'kg',   1000, NULL), (22, 'kg',   1000, NULL), (23, 'kg',   1000, NULL), (24, 'kg',   1000, NULL),
  (25, 'hop',  1000, NULL), (26, 'hop',  1000, NULL), (27, 'hop',  1000, NULL), (28, 'hop',  1000, NULL),
  (29, 'hop',  1000, NULL);

-- Đơn vị thùng / khay bổ sung
INSERT OR IGNORE INTO product_units (product_id, unit, factor_milli, barcode) VALUES
  (1, 'thung', 18000, NULL),   -- Táo Envy thùng 18 kg
  (2, 'thung',  5000, NULL),   -- Nho xanh Úc thùng 5 kg
  (4, 'thung', 10000, NULL),   -- Kiwi vàng thùng 10 kg
  (5, 'thung', 10000, NULL),   -- Lê Hàn thùng 10 kg
  (6, 'thung', 15000, NULL),   -- Cam Mỹ thùng 15 kg
  (3, 'khay',    500, NULL);   -- Cherry Mỹ khay 500 g

-- ===== Nhà cung cấp (tên minh hoạ, không phải đối tác thật) =====
INSERT OR IGNORE INTO suppliers (id, code, name, phone, address, tax_code, payment_terms_days, active) VALUES
  (1, 'NCC01', 'Vựa đầu mối Thủ Đức',                 NULL, 'Chợ đầu mối Thủ Đức, TP.HCM', NULL, 0,  1),
  (2, 'NCC02', 'Công ty NK Trái cây Nam Hải (demo)',  NULL, 'TP.HCM',                      NULL, 30, 1),
  (3, 'NCC03', 'HTX Rau quả Đà Lạt (demo)',           NULL, 'Đà Lạt, Lâm Đồng',            NULL, 15, 1),
  (4, 'NCC04', 'Vườn trái cây Tiền Giang (demo)',     NULL, 'Tiền Giang',                  NULL, 7,  1),
  (5, 'NCC05', 'Vựa trái cây Bến Tre (demo)',         NULL, 'Bến Tre',                     NULL, 7,  1);

-- ===== Bảng giá chung (list 1): giá VND / đơn vị chính, hiệu lực từ 2026-01-01 =====
INSERT OR IGNORE INTO prices (id, price_list_id, product_id, unit_price, effective_from, effective_to, status, created_by, note) VALUES
  (1,  1, 1,  159000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (2,  1, 2,  259000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (3,  1, 3,  499000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (4,  1, 4,  149000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (5,  1, 5,   99000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (6,  1, 6,   89000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (7,  1, 7,   79000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (8,  1, 8,   39000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (9,  1, 9,   79000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (10, 1, 10, 129000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (11, 1, 11,  65000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (12, 1, 12,  65000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (13, 1, 13, 169000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (14, 1, 14, 149000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (15, 1, 15,  35000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (16, 1, 16,  85000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (17, 1, 17,  35000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (18, 1, 18,  38000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (19, 1, 19,  79000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (20, 1, 20,  35000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (21, 1, 21,  55000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (22, 1, 22,  65000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (23, 1, 23,  25000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (24, 1, 24,  28000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (25, 1, 25, 550000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (26, 1, 26, 890000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (27, 1, 27,  75000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (28, 1, 28,  99000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (29, 1, 29,  45000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL);

-- ===== Bảng giá Sỉ cấp 1 (list 3): hàng nhập khẩu thấp hơn ~10% so với giá chung =====
INSERT OR IGNORE INTO prices (id, price_list_id, product_id, unit_price, effective_from, effective_to, status, created_by, note) VALUES
  (101, 3, 1,  143000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (102, 3, 2,  233000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (103, 3, 3,  449000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (104, 3, 4,  134000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (105, 3, 5,   89000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (106, 3, 6,   80000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (107, 3, 7,   71000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (108, 3, 8,   35000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (109, 3, 9,   71000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL),
  (110, 3, 10, 116000, '2026-01-01T00:00:00.000Z', NULL, 'active', 1, NULL);
