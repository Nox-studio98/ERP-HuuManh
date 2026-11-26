-- Hoa hồng bán hàng theo quy tắc (docs/API-dot4.md, mục "Báo cáo bán hàng & hoa hồng").
-- Có ít nhất một quy tắc đang hiệu lực cho kỳ lương → thưởng doanh số tính theo quy tắc; không có → giữ hr.sales_bonus_bp.
CREATE TABLE commission_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('all','group','product')),
  product_group_id INTEGER REFERENCES product_groups(id),
  product_id INTEGER REFERENCES products(id),
  employee_id INTEGER REFERENCES employees(id),          -- NULL = mọi nhân viên
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  active INTEGER NOT NULL DEFAULT 1,
  effective_from TEXT,                                    -- YYYY-MM-DD (giờ VN), NULL = từ trước đến nay
  effective_to TEXT,                                      -- NULL = không giới hạn
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  CHECK ((scope = 'all' AND product_group_id IS NULL AND product_id IS NULL)
      OR (scope = 'group' AND product_group_id IS NOT NULL AND product_id IS NULL)
      OR (scope = 'product' AND product_id IS NOT NULL AND product_group_id IS NULL))
);
CREATE INDEX idx_commission_rules_active ON commission_rules(active, scope);
CREATE TRIGGER commission_rules_no_delete BEFORE DELETE ON commission_rules BEGIN SELECT RAISE(ABORT, 'commission_rules: chỉ ngừng áp dụng, không xoá'); END;
