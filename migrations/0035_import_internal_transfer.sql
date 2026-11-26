-- Đợt 8: xuất dùng nội bộ (loại chứng từ kho mới) + chuyển tiền giữa các quỹ. (Nhập Excel hàng loạt không cần bảng mới.)

-- 1) stock_docs.type thêm 'internal_use'. SQLite không sửa được CHECK → dựng lại bảng stock_docs, giữ nguyên mọi cột và chỉ mục.
--    defer_foreign_keys cho phép DROP/RENAME khi stock_doc_lines, stock_doc_post_guard, supplier_bills, purchase_returns... còn trỏ tới.
--    (stock_moves.move_type không có CHECK nên loại 'internal_use' của thẻ kho không cần đổi gì.)
PRAGMA defer_foreign_keys = true;
CREATE TABLE stock_docs_new (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('receipt','issue','waste','adjust','count','transfer','internal_use')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','posted','cancelled')),
  store_id INTEGER NOT NULL REFERENCES stores(id),
  location_id INTEGER REFERENCES locations(id),
  to_location_id INTEGER REFERENCES locations(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  supplier_ref TEXT,
  reason TEXT,
  note TEXT,
  total_amount INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_by INTEGER REFERENCES users(id),
  posted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  vat_amount INTEGER NOT NULL DEFAULT 0,
  lock_lots INTEGER NOT NULL DEFAULT 0,
  transfer_status TEXT CHECK (transfer_status IN ('in_transit','received')),
  received_at TEXT,
  received_by INTEGER REFERENCES users(id),
  po_id INTEGER REFERENCES purchase_orders(id)
);
INSERT INTO stock_docs_new (id, code, type, status, store_id, location_id, to_location_id, supplier_id, supplier_ref, reason, note, total_amount, created_by, created_at, approved_by, posted_at, version, vat_amount, lock_lots, transfer_status, received_at, received_by, po_id)
  SELECT id, code, type, status, store_id, location_id, to_location_id, supplier_id, supplier_ref, reason, note, total_amount, created_by, created_at, approved_by, posted_at, version, vat_amount, lock_lots, transfer_status, received_at, received_by, po_id FROM stock_docs;
DROP TABLE stock_docs;
ALTER TABLE stock_docs_new RENAME TO stock_docs;
CREATE INDEX idx_stock_docs_po ON stock_docs(po_id);
PRAGMA defer_foreign_keys = false;

-- 2) Ngưỡng duyệt xuất dùng nội bộ: giá trị phiếu (theo giá vốn lô) vượt mức này cần chủ/quản lý duyệt
INSERT OR IGNORE INTO settings(key, value, note) VALUES
 ('approval.internal_use_vnd', '500000', 'Xuất dùng nội bộ >500k (giá vốn) cần quản lý/chủ duyệt [Cần xác nhận]');

-- 3) Chuyển tiền giữa các quỹ: một cặp phiếu chi (quỹ nguồn) + phiếu thu (quỹ đích) liên kết với nhau.
--    Hai khoản mục dưới đây có dòng P&L 'transfer' nên không bao giờ vào lãi lỗ.
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (910, 'CHUYEN_QUY_RA', 'Chuyển tiền sang quỹ khác', 'out', 'transfer');
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (911, 'CHUYEN_QUY_VAO', 'Nhận tiền từ quỹ khác', 'in', 'transfer');

CREATE TABLE fund_transfers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                                   -- CQ-YYYYMMDD-0001
  from_fund_id INTEGER NOT NULL REFERENCES funds(id),
  to_fund_id INTEGER NOT NULL REFERENCES funds(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT,
  period TEXT NOT NULL,                                        -- YYYY-MM (giờ VN) lúc lập
  out_voucher_id INTEGER REFERENCES cash_vouchers(id),         -- phiếu chi ở quỹ nguồn
  in_voucher_id INTEGER REFERENCES cash_vouchers(id),          -- phiếu thu ở quỹ đích
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversed_at TEXT,
  reversed_by INTEGER REFERENCES users(id),
  reverse_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (from_fund_id <> to_fund_id)
);
CREATE INDEX idx_fund_transfers_created ON fund_transfers(created_at);
