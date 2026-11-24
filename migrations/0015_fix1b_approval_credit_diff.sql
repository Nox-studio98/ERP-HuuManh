-- Fix đợt 1b (audit nghiệp vụ A-01, A-02, A-05, B-01, B-08).

-- 1) B-01: phiếu chi công nợ vượt ngưỡng duyệt phải chờ duyệt → debt_payments cần thêm trạng thái pending_approval / rejected.
--    SQLite không sửa được CHECK → dựng lại bảng (defer_foreign_keys cho phép DROP/RENAME khi debt_allocations còn trỏ tới).
-- Trigger chống gạch vượt (0008) tham chiếu debt_payments nên phải gỡ trước khi đổi tên bảng, rồi dựng lại y nguyên.
DROP TRIGGER alloc_invoice_not_over;
DROP TRIGGER alloc_bill_not_over;
PRAGMA defer_foreign_keys = true;
CREATE TABLE debt_payments_new (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),   -- in: khách trả; out: trả NCC (hoặc hoàn tiền dư có cho khách)
  partner_type TEXT NOT NULL CHECK (partner_type IN ('customer','supplier')),
  partner_id INTEGER NOT NULL,
  fund_id INTEGER NOT NULL REFERENCES funds(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','transfer','offset')),
  ref TEXT,
  paid_at TEXT NOT NULL,
  cash_voucher_id INTEGER REFERENCES cash_vouchers(id),       -- phiếu chi chỉ tạo khi đã duyệt (pending_approval chưa có phiếu, chưa tác động quỹ)
  bank_txn_id INTEGER,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending_approval','posted','reversed','rejected')),
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  alloc_json TEXT,                                            -- gạch nợ client chỉ định (dùng khi duyệt)
  approval_id INTEGER REFERENCES approvals(id)
);
INSERT INTO debt_payments_new (id, code, direction, partner_type, partner_id, fund_id, amount, method, ref, paid_at, cash_voucher_id, bank_txn_id, status, note, created_by, created_at)
  SELECT id, code, direction, partner_type, partner_id, fund_id, amount, method, ref, paid_at, cash_voucher_id, bank_txn_id, status, note, created_by, created_at FROM debt_payments;
DROP TABLE debt_payments;
ALTER TABLE debt_payments_new RENAME TO debt_payments;
CREATE INDEX idx_dpay_partner ON debt_payments(partner_type, partner_id);
PRAGMA defer_foreign_keys = false;
CREATE TRIGGER alloc_invoice_not_over BEFORE INSERT ON debt_allocations
WHEN NEW.invoice_id IS NOT NULL AND NEW.amount > (
  SELECT i.total
       + COALESCE((SELECT SUM(a.total) FROM invoices a WHERE a.original_invoice_id = i.id AND a.kind = 'adjustment' AND a.status = 'open'), 0)
       - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x
                     LEFT JOIN debt_payments xp ON xp.id = x.payment_id
                     LEFT JOIN debt_adjustments xd ON xd.id = x.adjustment_id
                    WHERE x.invoice_id = i.id AND (xp.status = 'posted' OR xd.status = 'posted')), 0)
    FROM invoices i WHERE i.id = NEW.invoice_id)
BEGIN SELECT RAISE(ABORT, 'overallocated'); END;

CREATE TRIGGER alloc_bill_not_over BEFORE INSERT ON debt_allocations
WHEN NEW.bill_id IS NOT NULL AND NEW.amount > (
  SELECT b.total
       - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x
                     LEFT JOIN debt_payments xp ON xp.id = x.payment_id
                     LEFT JOIN debt_adjustments xd ON xd.id = x.adjustment_id
                    WHERE x.bill_id = b.id AND (xp.status = 'posted' OR xd.status = 'posted')), 0)
    FROM supplier_bills b WHERE b.id = NEW.bill_id)
BEGIN SELECT RAISE(ABORT, 'overallocated'); END;

-- 2) A-01: hoàn tiền số dư có cho khách (chi công nợ direction='out' cho khách) — khoản mục không vào P&L (doanh thu đã giảm bởi phiếu trả hàng)
INSERT OR IGNORE INTO cash_categories(code, name, direction, pnl_line) VALUES ('HOAN_KH', 'Hoàn tiền dư có cho khách', 'out', 'transfer');

-- 3) A-02: đơn online trả trước, cân thực tế làm tổng đổi → lưu chênh lệch (dương: thu thêm khi giao; âm: phải hoàn lại)
ALTER TABLE orders ADD COLUMN diff_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN diff_status TEXT NOT NULL DEFAULT 'none' CHECK (diff_status IN ('none','pending','settled','waived'));
ALTER TABLE orders ADD COLUMN diff_note TEXT;
ALTER TABLE orders ADD COLUMN diff_waived_by INTEGER REFERENCES users(id);

-- 4) B-08: phiếu chi đang chờ duyệt nằm trong kỳ vừa khoá phải còn đường TỪ CHỐI (pending_approval → cancelled không đổi số liệu kỳ).
--    Mọi cập nhật khác lên phiếu của kỳ đã khoá vẫn bị chặn (đảo bằng bút toán ở kỳ sau).
DROP TRIGGER vouchers_locked_update;
CREATE TRIGGER vouchers_locked_update BEFORE UPDATE ON cash_vouchers
WHEN EXISTS (SELECT 1 FROM periods WHERE period = OLD.period AND locked_at IS NOT NULL)
 AND NOT (OLD.status = 'pending_approval' AND NEW.status = 'cancelled')
BEGIN SELECT RAISE(ABORT, 'period_locked'); END;
