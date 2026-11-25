-- Fix nhóm 5c: trả hàng NCC (B-12), số dư đầu kỳ không vào VAT (B-21), đảo chi lương/tạm ứng (C-23)

-- B-12: phiếu trả hàng NCC. Xuất kho theo lô gốc của phiếu nhập + giảm công nợ phải trả (debit note) hoặc huỷ hoá đơn mua chưa thanh toán.
CREATE TABLE purchase_returns (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  receipt_doc_id INTEGER NOT NULL REFERENCES stock_docs(id),
  bill_id INTEGER REFERENCES supplier_bills(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','posted','rejected','cancelled')),
  total INTEGER NOT NULL DEFAULT 0,            -- giá trị hàng trả (VND)
  credited_amount INTEGER NOT NULL DEFAULT 0,  -- phần đã giảm công nợ phải trả (debit note / huỷ hoá đơn)
  refund_due INTEGER NOT NULL DEFAULT 0,       -- phần hoá đơn đã trả tiền rồi: NCC phải hoàn tiền (lập phiếu thu thủ công)
  bill_cancelled INTEGER NOT NULL DEFAULT 0,   -- 1 = trả toàn bộ hoá đơn chưa thanh toán → huỷ hoá đơn mua
  adjustment_id INTEGER REFERENCES debt_adjustments(id),
  approval_id INTEGER,
  reason TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  posted_at TEXT
);
CREATE INDEX idx_pret_supplier ON purchase_returns(supplier_id, status);
CREATE INDEX idx_pret_doc ON purchase_returns(receipt_doc_id);
CREATE TRIGGER pret_no_delete BEFORE DELETE ON purchase_returns BEGIN SELECT RAISE(ABORT, 'purchase_returns is immutable'); END;

CREATE TABLE purchase_return_lines (
  id INTEGER PRIMARY KEY,
  return_id INTEGER NOT NULL REFERENCES purchase_returns(id),
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  unit TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_cost INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT,
  UNIQUE(return_id, lot_id)
);
CREATE TRIGGER pretl_no_update BEFORE UPDATE ON purchase_return_lines BEGIN SELECT RAISE(ABORT, 'purchase_return_lines is immutable'); END;
CREATE TRIGGER pretl_no_delete BEFORE DELETE ON purchase_return_lines BEGIN SELECT RAISE(ABORT, 'purchase_return_lines is immutable'); END;

INSERT OR IGNORE INTO settings(key, value, note) VALUES
  ('approval.purchase_return_vnd', '5000000', '[Cần xác nhận] Phiếu trả hàng NCC có giá trị lớn hơn mức này cần chủ duyệt (giảm công nợ phải trả); người lập không có quyền duyệt kho thì luôn chờ duyệt');

-- B-21: số dư đầu kỳ không phải doanh thu/mua hàng của tháng nhập → loại khỏi cơ sở tính VAT
ALTER TABLE invoices ADD COLUMN is_opening INTEGER NOT NULL DEFAULT 0;
ALTER TABLE supplier_bills ADD COLUMN is_opening INTEGER NOT NULL DEFAULT 0;
UPDATE invoices SET is_opening = 1 WHERE note = 'Số dư đầu kỳ';
UPDATE supplier_bills SET is_opening = 1 WHERE note = 'Số dư đầu kỳ';

-- C-23: đảo chi lương → trả các khoản tạm ứng bị dời kỳ về đúng kỳ gốc (chỉ ghi nhận từ nay)
ALTER TABLE salary_advances ADD COLUMN moved_from_period TEXT;
