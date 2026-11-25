-- PO tự động từ phần thiếu SO (docs/PO-NCC.md, bước 1–3): phần thiếu khi xác nhận SO, đơn đặt NCC (PO), nhận hàng theo PO.
-- Cổng NCC (supplier_accounts...) thuộc đợt sau, KHÔNG nằm trong file này.

-- ============================================================================
-- 1) Phần thiếu của SO (đơn sỉ + đơn online đặt trước giao ngày sau)
-- ============================================================================
CREATE TABLE so_shortages (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id) UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  initial_milli INTEGER NOT NULL CHECK (initial_milli > 0),   -- thiếu lúc xác nhận
  qty_milli INTEGER NOT NULL CHECK (qty_milli >= 0),          -- còn thiếu (giảm dần khi được giữ hàng; 0 khi filled)
  need_by TEXT,                                               -- ngày giao SO (YYYY-MM-DD giờ VN)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT
);
CREATE INDEX idx_so_shortages_open ON so_shortages(status, product_id, need_by);
CREATE INDEX idx_so_shortages_order ON so_shortages(order_id, status);

-- ============================================================================
-- 2) Đơn đặt NCC (PO)
-- ============================================================================
CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                 -- PO-YYYYMMDD-0001
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  store_id INTEGER NOT NULL REFERENCES stores(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','pending_approval','sent','supplier_proposed','confirmed',
    'partially_received','received','rejected','cancelled','closed')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('nightly','manual')),
  cutoff_day TEXT,                           -- ngày chốt sinh ra PO nháp (ngày của buổi tối nhập đơn)
  expected_date TEXT,                        -- ngày giao dự kiến (NCC xác nhận)
  proposed_expected_date TEXT,               -- ngày giao NCC đề xuất
  total INTEGER NOT NULL DEFAULT 0,          -- theo giá đang hiệu lực (đã chốt nếu có, không thì giá đặt)
  note TEXT,
  supplier_note TEXT,
  reject_reason TEXT,
  cancel_reason TEXT,
  close_reason TEXT,
  approval_id INTEGER REFERENCES approvals(id),
  version INTEGER NOT NULL DEFAULT 1,        -- chống sửa đồng thời
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  sent_at TEXT,
  confirmed_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_po_status ON purchase_orders(status, id);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id, status);
-- Mỗi (NCC, ngày chốt) tối đa một PO nháp tự động: chạy job hai lần / hai người bấm "Tính lại" không tạo trùng.
CREATE UNIQUE INDEX uq_po_nightly_draft ON purchase_orders(supplier_id, cutoff_day)
  WHERE source = 'nightly' AND status = 'draft';

CREATE TABLE purchase_order_lines (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  order_unit TEXT NOT NULL,                  -- đơn vị đặt (thùng, kg…)
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),          -- SL đặt (đơn vị chính)
  unit_cost INTEGER,                         -- giá đặt / đơn vị chính (gợi ý từ giá nhập gần nhất); NULL = chưa có giá
  proposed_qty_milli INTEGER, proposed_unit_cost INTEGER,    -- NCC đề xuất
  confirmed_qty_milli INTEGER, confirmed_unit_cost INTEGER,  -- đã chốt hai bên
  received_milli INTEGER NOT NULL DEFAULT 0 CHECK (received_milli >= 0),
  line_note TEXT,
  supplier_line_note TEXT,
  UNIQUE(po_id, product_id)
);

-- PO nào phủ phần thiếu nào (giải thích "PO này phủ SO nào" + phân bổ khi nhận hàng)
CREATE TABLE po_shortage_links (
  po_line_id INTEGER NOT NULL REFERENCES purchase_order_lines(id),
  shortage_id INTEGER NOT NULL REFERENCES so_shortages(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  PRIMARY KEY(po_line_id, shortage_id)
);
CREATE INDEX idx_po_links_shortage ON po_shortage_links(shortage_id);

-- Phiếu nhập theo PO
ALTER TABLE stock_docs ADD COLUMN po_id INTEGER REFERENCES purchase_orders(id);
CREATE INDEX idx_stock_docs_po ON stock_docs(po_id);

-- ============================================================================
-- 3) Tham số (đều khai báo ở settings-registry.ts)
-- ============================================================================
INSERT OR IGNORE INTO settings(key, value, note) VALUES
  ('po.allow_short_confirm', '1', 'Cho xác nhận đơn sỉ / đơn online đặt trước khi thiếu hàng: giữ phần có tồn, ghi phần thiếu chờ hàng về (1 = bật; 0 = như cũ, thiếu thì chặn 409)'),
  ('po.cutoff_time', '03:00', 'Giờ chốt đêm gom phần thiếu thành PO nháp (giờ VN, HH:MM); đơn nhập trước giờ này thuộc ngày chốt của buổi tối hôm trước'),
  ('po.horizon_days', '2', '[Cần xác nhận] Gom phần thiếu của SO giao trong N ngày tới (kể cả hôm nay) vào PO'),
  ('approval.po_vnd', '20000000', '[Cần xác nhận] PO có giá trị lớn hơn mức này cần chủ duyệt (qua luồng duyệt chung, có thông báo)');
