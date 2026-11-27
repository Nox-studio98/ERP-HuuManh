-- POS-KV đợt B2: thu khác trên hoá đơn (phí đóng gói, phí giỏ quà...). Cộng vào tổng đơn, không áp khuyến mãi/voucher/điểm.
CREATE TABLE charge_types (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  default_amount INTEGER NOT NULL DEFAULT 0 CHECK (default_amount >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE order_charges (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  charge_type_id INTEGER REFERENCES charge_types(id),
  name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  refunded_amount INTEGER NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0 AND refunded_amount <= amount),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_order_charges_order ON order_charges(order_id);

-- Tổng thu khác của đơn (đã nằm trong orders.total). Phiếu trả: số thu khác được hoàn (dương, cùng chiều với total của phiếu trả).
ALTER TABLE orders ADD COLUMN charges_total INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO charge_types(id, code, name, default_amount) VALUES
 (901, 'PHI_DONG_GOI', 'Phí đóng gói', 5000),
 (902, 'PHI_GIAO_HANG', 'Phí giao hàng', 20000),
 (903, 'PHI_GIO_QUA', 'Phí giỏ quà', 30000);
