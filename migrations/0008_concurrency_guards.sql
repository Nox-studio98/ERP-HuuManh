-- Audit (24/11/2026): chốt chặn đồng thời & ràng buộc toàn vẹn.
-- Vấn đề gốc: "đọc trạng thái → UPDATE ... WHERE status='cũ'" trong batch KHÔNG làm batch thất bại khi 0 dòng khớp,
-- nên các tác động đi kèm (kho, tiền, voucher) vẫn chạy khi hai request đồng thời. Các cơ chế dưới đây làm batch ROLLBACK.

-- 1) Chốt chặn chung (services/guard.ts): chèn 1 dòng với ok = điều kiện; ok = 0 → trigger RAISE → cả batch rollback.
CREATE TABLE state_guard (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  ok INTEGER NOT NULL
);
CREATE TRIGGER state_guard_check BEFORE INSERT ON state_guard WHEN NEW.ok IS NOT 1
BEGIN SELECT RAISE(ABORT, 'state_changed'); END;

-- 2) Khoá idempotency một lần cho thao tác tiền/kho (chi lương, hoàn tiền, đóng giỏ, thu nợ...). Trùng khoá → batch rollback.
CREATE TABLE once_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, key)
);

-- 3) Mỗi phiếu thu/chi chỉ được đảo một lần
CREATE UNIQUE INDEX idx_vouchers_reverse_once ON cash_vouchers(reverses_id) WHERE reverses_id IS NOT NULL;

-- 4) Mỗi yêu cầu bổ sung công chỉ sinh tối đa 1 lần chấm
CREATE UNIQUE INDEX idx_punch_correction_once ON attendance_punches(correction_id) WHERE correction_id IS NOT NULL;

-- 5) Mỗi người chỉ có một ca bán đang mở
CREATE UNIQUE INDEX idx_shift_one_open ON shifts(user_id) WHERE status = 'open';

-- 6) Không gạch nợ vượt số còn nợ của hoá đơn bán / hoá đơn mua (thu tiền đồng thời, gạch tay, cấn trừ)
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

-- 7) Mỗi đơn chỉ xuất hiện một lần trong các đợt đối soát COD/sàn
CREATE UNIQUE INDEX idx_settlement_line_order_once ON settlement_lines(order_id) WHERE order_id IS NOT NULL;
