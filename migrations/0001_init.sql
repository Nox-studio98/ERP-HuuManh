-- Hữu Mạnh ERP — schema Đợt 1 (M1 Bán hàng, M2 Kho, M3 Giá, M6 Thu chi) + nền tảng
-- Quy ước:
--   * Tiền: INTEGER VND (không số lẻ).
--   * Số lượng: INTEGER "milli" của đơn vị chính (kg -> gram; trái -> 1/1000 trái). 1 kg = 1000.
--   * Thời gian: TEXT ISO-8601 UTC, sinh bởi máy chủ (không tin giờ client). Hiển thị theo Asia/Ho_Chi_Minh.
--   * Không xoá chứng từ: chỉ đổi trạng thái / lập chứng từ điều chỉnh.

PRAGMA foreign_keys = ON;

-- ===== Tổ chức =====
CREATE TABLE stores (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL, lng REAL, geofence_m INTEGER DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE locations (           -- quầy, kho lạnh... (M2-10)
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sellable INTEGER NOT NULL DEFAULT 1,
  UNIQUE(store_id, code)
);

-- ===== Người dùng, phiên, nhật ký =====
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,           -- pbkdf2$iter$salt$hash
  role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier','warehouse','accountant','online_staff')),
  store_id INTEGER REFERENCES stores(id),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE devices (             -- thiết bị đã đăng ký (chống chấm công hộ, truy vết quét mã)
  id TEXT PRIMARY KEY,             -- uuid do app sinh, lưu bền trên máy
  user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,             -- SHA-256(token) — không lưu token gốc
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT,
  ip TEXT, user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE audit_log (           -- yêu cầu chung: ai, lúc nào, trước/sau
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER,
  action TEXT NOT NULL,            -- vd: price.update, stock.adjust, order.void, auth.login_failed
  entity TEXT,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  ip TEXT,
  device_id TEXT,
  request_id TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_at ON audit_log(at);
-- audit_log là append-only
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE settings (            -- ngưỡng duyệt, mốc tuổi nợ... (nhiều mục [Cần xác nhận])
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  note TEXT
);

CREATE TABLE doc_sequences (       -- sinh mã chứng từ không trùng: HD-20261123-0001
  prefix TEXT NOT NULL,
  day TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY(prefix, day)
);

CREATE TABLE approvals (           -- yêu cầu duyệt chung (giá dưới vốn, hao hụt, chi vượt ngưỡng...)
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  ref_type TEXT, ref_id TEXT,
  payload_json TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status);

-- ===== M2: Danh mục hàng hoá =====
CREATE TABLE product_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  target_margin_bp INTEGER NOT NULL DEFAULT 3000   -- biên mục tiêu (basis point) cho M3-07
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,              -- mã có sẵn (EAN) hoặc mã nội bộ sinh tự động (M2-15)
  name TEXT NOT NULL,
  group_id INTEGER REFERENCES product_groups(id),
  base_unit TEXT NOT NULL,          -- kg | trai | khay | hop
  sell_by_weight INTEGER NOT NULL DEFAULT 0,
  origin TEXT,
  shelf_life_days INTEGER,
  min_stock_milli INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  merged_into INTEGER REFERENCES products(id),     -- EC-22 gộp mã, giữ lịch sử
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1                -- EC-38 khoá lạc quan
);

CREATE TABLE product_units (       -- M2-01/M1-02 đơn vị quy đổi: 1 thùng = 10 kg
  product_id INTEGER NOT NULL REFERENCES products(id),
  unit TEXT NOT NULL,
  factor_milli INTEGER NOT NULL CHECK (factor_milli > 0), -- số milli đơn vị chính trong 1 đơn vị này
  barcode TEXT UNIQUE,
  PRIMARY KEY(product_id, unit)
);

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT, address TEXT, tax_code TEXT,
  payment_terms_days INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- ===== M2: Lô & sổ kho =====
CREATE TABLE lots (
  id INTEGER PRIMARY KEY,
  lot_code TEXT NOT NULL UNIQUE,    -- mã vạch lô nội bộ (Code128)
  product_id INTEGER NOT NULL REFERENCES products(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  receipt_doc_id INTEGER,
  received_at TEXT NOT NULL,
  expires_at TEXT,                  -- hạn dùng / ngày đánh giá độ tươi
  unit_cost INTEGER NOT NULL,       -- VND / 1 đơn vị chính (theo lô)
  qty_in_milli INTEGER NOT NULL,
  qty_on_hand_milli INTEGER NOT NULL,
  qty_reserved_milli INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantine','expired','closed')),
  -- EC-02: ràng buộc là "chốt chặn" cuối — batch D1 vi phạm sẽ rollback toàn bộ
  CHECK (qty_on_hand_milli >= 0),
  CHECK (qty_reserved_milli >= 0),
  CHECK (qty_reserved_milli <= qty_on_hand_milli)
);
CREATE INDEX idx_lots_fefo ON lots(product_id, status, expires_at);

CREATE TABLE stock_docs (          -- phiếu nhập/xuất/hao hụt/điều chỉnh/kiểm kê/chuyển kho
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('receipt','issue','waste','adjust','count','transfer')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','posted','cancelled')),
  store_id INTEGER NOT NULL REFERENCES stores(id),
  location_id INTEGER REFERENCES locations(id),
  to_location_id INTEGER REFERENCES locations(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  supplier_ref TEXT,                -- số chứng từ NCC
  reason TEXT,
  note TEXT,
  total_amount INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_by INTEGER REFERENCES users(id),
  posted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE stock_doc_lines (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES stock_docs(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES lots(id),
  unit TEXT NOT NULL,
  doc_qty_milli INTEGER,            -- số trên chứng từ NCC / số hệ thống khi kiểm kê
  qty_milli INTEGER NOT NULL,       -- số thực nhận / thực đếm / thực xuất (đơn vị chính)
  unit_cost INTEGER,
  expires_at TEXT,
  reason TEXT                       -- dap | heo | het_han | hao_can | khac
);

CREATE TABLE stock_moves (         -- thẻ kho (bất biến)
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty_delta_milli INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL,
  move_type TEXT NOT NULL,          -- receipt|sale|return|waste|adjust|transfer_out|transfer_in
  ref_type TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  user_id INTEGER
);
CREATE INDEX idx_moves_product ON stock_moves(product_id, at);
CREATE TRIGGER moves_no_update BEFORE UPDATE ON stock_moves BEGIN SELECT RAISE(ABORT, 'stock_moves is immutable'); END;
CREATE TRIGGER moves_no_delete BEFORE DELETE ON stock_moves BEGIN SELECT RAISE(ABORT, 'stock_moves is immutable'); END;

CREATE TABLE scan_events (         -- M2: mỗi lần quét ghi người, giờ, thiết bị
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER NOT NULL,
  device_id TEXT,
  code TEXT NOT NULL,
  context TEXT,                     -- receipt:12 | order:55 | count:3
  result TEXT NOT NULL,             -- ok|unknown|expired|not_in_doc|duplicate|manual
  message TEXT
);

-- ===== M3: Giá =====
CREATE TABLE customer_groups (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,        -- le | than_thiet | si_1 | si_2
  name TEXT NOT NULL
);

CREATE TABLE price_lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('pos','online','b2b','all')),
  customer_group_id INTEGER REFERENCES customer_groups(id),
  kind TEXT NOT NULL DEFAULT 'base' CHECK (kind IN ('base','group','promo','customer')),
  priority INTEGER NOT NULL DEFAULT 0,   -- EC-13: customer > promo > group > base
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE prices (              -- lịch sử giá = các dòng theo thời gian hiệu lực (M3-04)
  id INTEGER PRIMARY KEY,
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0), -- VND / đơn vị chính
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','rejected','superseded')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_by INTEGER REFERENCES users(id),
  note TEXT
);
CREATE INDEX idx_prices_lookup ON prices(product_id, price_list_id, status, effective_from);

-- ===== Khách hàng (tối thiểu cho Đợt 1; M4 mở rộng ở Đợt 2) =====
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'retail' CHECK (type IN ('retail','b2b')),
  name TEXT NOT NULL,
  phone TEXT,                       -- PII: chỉ trả về cho vai trò có quyền
  email TEXT,
  customer_group_id INTEGER REFERENCES customer_groups(id),
  tax_code TEXT,
  credit_limit INTEGER NOT NULL DEFAULT 0,
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1
);

-- ===== M1: Ca, đơn hàng, thanh toán =====
CREATE TABLE shifts (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  fund_id INTEGER NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  opening_cash INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  expected_cash INTEGER,
  counted_cash INTEGER,
  diff_cash INTEGER,
  diff_reason TEXT,                 -- EC-32
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  client_uuid TEXT UNIQUE,          -- EC-04: idempotency khi đồng bộ offline, không trùng số
  channel TEXT NOT NULL CHECK (channel IN ('pos','online','b2b','fresco','social')),
  kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','return')),
  original_order_id INTEGER REFERENCES orders(id),
  store_id INTEGER NOT NULL REFERENCES stores(id),
  shift_id INTEGER REFERENCES shifts(id),
  customer_id INTEGER REFERENCES customers(id),
  status TEXT NOT NULL CHECK (status IN (
    'draft','new','confirmed','preparing','shipping','completed',
    'cancelled','delivery_failed','returned','awaiting_payment')),
  is_preorder INTEGER NOT NULL DEFAULT 0,
  subtotal INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  shipping_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  cost_total INTEGER NOT NULL DEFAULT 0,
  paid_total INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT
);
CREATE INDEX idx_orders_created ON orders(store_id, created_at);
CREATE INDEX idx_orders_shift ON orders(shift_id);

CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  unit TEXT NOT NULL,
  qty_milli INTEGER NOT NULL,       -- theo đơn vị chính
  unit_price INTEGER NOT NULL,      -- giá chốt tại thời điểm bán (M3: không đổi theo bảng giá mới)
  price_list_id INTEGER,
  discount INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL,
  cost_amount INTEGER NOT NULL DEFAULT 0,
  below_cost_approval_id INTEGER REFERENCES approvals(id),
  original_line_id INTEGER REFERENCES order_lines(id)   -- dòng trả hàng trỏ về dòng gốc
);

CREATE TABLE order_line_lots (     -- phân bổ FEFO -> trả hàng cộng lại đúng lô (EC-01)
  id INTEGER PRIMARY KEY,
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  qty_milli INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL
);

-- ===== M6: Quỹ & thu chi =====
CREATE TABLE funds (
  id INTEGER PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cash','bank','ewallet','card_clearing','cod_clearing','marketplace_clearing')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE cash_categories (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  pnl_line TEXT                     -- revenue|cogs|opex|shrinkage|payroll|other
);

CREATE TABLE payments (            -- thanh toán của đơn (M1-04: nhiều hình thức, chia)
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL CHECK (method IN ('cash','transfer','qr','card','ewallet','cod','marketplace','credit')),
  amount INTEGER NOT NULL,
  fund_id INTEGER REFERENCES funds(id),
  ref TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','failed','refunded')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE cash_vouchers (       -- phiếu thu / phiếu chi
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  fund_id INTEGER NOT NULL REFERENCES funds(id),
  category_id INTEGER NOT NULL REFERENCES cash_categories(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  counterparty TEXT,
  ref_type TEXT, ref_id INTEGER,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending_approval','posted','cancelled')),
  period TEXT NOT NULL,             -- YYYY-MM (giờ VN)
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_by INTEGER REFERENCES users(id),
  reverses_id INTEGER REFERENCES cash_vouchers(id)   -- bút toán đảo / điều chỉnh (EC-33)
);
CREATE INDEX idx_vouchers_period ON cash_vouchers(period, fund_id);

CREATE TABLE periods (             -- M6-09 khoá sổ
  period TEXT PRIMARY KEY,
  locked_at TEXT,
  locked_by INTEGER REFERENCES users(id)
);
-- Chặn thêm/sửa phiếu thu chi trong kỳ đã khoá (EC-33)
CREATE TRIGGER vouchers_locked_insert BEFORE INSERT ON cash_vouchers
WHEN EXISTS (SELECT 1 FROM periods WHERE period = NEW.period AND locked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'period_locked'); END;
CREATE TRIGGER vouchers_locked_update BEFORE UPDATE ON cash_vouchers
WHEN EXISTS (SELECT 1 FROM periods WHERE period = OLD.period AND locked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'period_locked'); END;

-- ===== Cài đặt mặc định (đa số [Cần xác nhận] với chủ cửa hàng) =====
INSERT INTO settings(key, value, note) VALUES
 ('approval.discount_pct_bp', '1000', 'Giảm giá >10% cần duyệt [Cần xác nhận]'),
 ('approval.cash_out_vnd', '5000000', 'Phiếu chi >5tr cần chủ duyệt [Cần xác nhận]'),
 ('approval.waste_pct_bp', '500', 'Hao hụt >5% lượng nhập báo quản lý'),
 ('approval.count_diff_vnd', '1000000', 'Chênh lệch kiểm kê >1tr cần chủ duyệt [Cần xác nhận]'),
 ('costing.method', 'lot', 'lot | average [Cần xác nhận]'),
 ('pos.allow_offline', '1', 'EC-04 [Cần xác nhận]'),
 ('session.ttl_hours', '12', 'Thời hạn phiên đăng nhập'),
 ('timezone', 'Asia/Ho_Chi_Minh', '');
