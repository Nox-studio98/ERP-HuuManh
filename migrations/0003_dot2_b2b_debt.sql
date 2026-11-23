-- Đợt 2: M4 Khách hàng B2B, M5 Công nợ, giữ tồn, hoá đơn, tích hợp (MISA, Fresco), đối soát.
-- Quy ước như 0001: tiền INTEGER VND, số lượng INTEGER milli, thời gian ISO UTC do server sinh.

-- ===== M4: hồ sơ khách B2B =====
ALTER TABLE customers ADD COLUMN owner_user_id INTEGER REFERENCES users(id);      -- M4-10 người phụ trách
ALTER TABLE customers ADD COLUMN linked_supplier_id INTEGER REFERENCES suppliers(id); -- M5-09 cấn trừ cùng đối tác
ALTER TABLE customers ADD COLUMN billing_address TEXT;
ALTER TABLE customers ADD COLUMN note TEXT;
ALTER TABLE customers ADD COLUMN created_at TEXT;

CREATE TABLE customer_contacts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  role TEXT,                       -- người nhận hàng / kế toán / người đặt
  is_receiver INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE customer_addresses (  -- M4-01 nhiều địa chỉ giao; quy tắc: ít nhất 1 địa chỉ + 1 người nhận
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  receiver_contact_id INTEGER REFERENCES customer_contacts(id),
  delivery_note TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Giá riêng theo khách (EC-13 ưu tiên cao nhất): price_lists kind='customer' gắn 1 khách
ALTER TABLE price_lists ADD COLUMN customer_id INTEGER REFERENCES customers(id);

-- ===== M4: báo giá =====
CREATE TABLE quotes (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                 -- BG-YYYYMMDD-0001
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','sent','accepted','expired','cancelled')),
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,                 -- mặc định +7 ngày (settings quote.valid_days)
  subtotal INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  pdf_key TEXT,                              -- R2 key
  extended_by INTEGER REFERENCES users(id),  -- EC-28 quản lý gia hạn có ghi nhận
  extended_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_by INTEGER REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_quotes_customer ON quotes(customer_id, status);

CREATE TABLE quote_lines (
  id INTEGER PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  unit TEXT NOT NULL,
  qty_milli INTEGER,                         -- có thể để trống (báo giá đơn giá)
  list_price INTEGER NOT NULL,               -- giá theo bảng giá lúc báo (VND / đơn vị chính)
  unit_price INTEGER NOT NULL,               -- giá báo cho khách
  cost_at_quote INTEGER,                     -- giá vốn tham chiếu lúc báo (EC-12)
  note TEXT
);

-- ===== M4: đơn sỉ dùng bảng orders (channel='b2b') + cột bổ sung =====
ALTER TABLE orders ADD COLUMN quote_id INTEGER REFERENCES quotes(id);
ALTER TABLE orders ADD COLUMN address_id INTEGER REFERENCES customer_addresses(id);
ALTER TABLE orders ADD COLUMN delivery_date TEXT;                 -- ngày giao dự kiến (YYYY-MM-DD giờ VN)
ALTER TABLE orders ADD COLUMN credit_override_approval_id INTEGER REFERENCES approvals(id);
ALTER TABLE orders ADD COLUMN recurring_template_id INTEGER;      -- M4-08
ALTER TABLE orders ADD COLUMN external_source TEXT;               -- 'fresco' ...
ALTER TABLE orders ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX idx_orders_external ON orders(external_source, external_id) WHERE external_id IS NOT NULL;

-- M2-06: giữ tồn theo lô cho đơn chưa giao. Giữ = UPDATE lots.qty_reserved_milli (+CHECK) + dòng ở đây.
CREATE TABLE reservations (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','consumed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT
);
CREATE INDEX idx_resv_order ON reservations(order_id, status);
CREATE INDEX idx_resv_lot ON reservations(lot_id, status);

CREATE TABLE recurring_orders (    -- M4-08 đơn lặp hằng tuần
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  address_id INTEGER REFERENCES customer_addresses(id),
  weekdays TEXT NOT NULL,          -- "1,4" (Thứ 2, Thứ 5; 1=Thứ 2 .. 7=CN)
  lines_json TEXT NOT NULL,        -- [{productId, unit, qty}]
  active INTEGER NOT NULL DEFAULT 1,
  last_generated_for TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id)
);

-- ===== M4: giao hàng =====
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,       -- GH-YYYYMMDD-0001 (phiếu giao)
  order_id INTEGER NOT NULL REFERENCES orders(id),
  address_id INTEGER REFERENCES customer_addresses(id),
  status TEXT NOT NULL DEFAULT 'picking'
    CHECK (status IN ('picking','ready','shipping','delivered','failed','cancelled')),
  shipper TEXT,
  picked_by INTEGER REFERENCES users(id),
  delivered_at TEXT,
  receiver_name TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE delivery_lines (
  id INTEGER PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  picked_milli INTEGER NOT NULL DEFAULT 0,     -- quét soạn hàng
  delivered_milli INTEGER,                     -- khách thực nhận
  rejected_milli INTEGER NOT NULL DEFAULT 0,   -- từ chối / trả lại lúc giao (EC-26)
  reject_reason TEXT                           -- hong | sai_quy_cach | thua | khac
);

-- ===== Hoá đơn bán (phải thu) =====
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                   -- HDB-YYYYMMDD-0001 (số nội bộ)
  kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','adjustment','replacement')),
  original_invoice_id INTEGER REFERENCES invoices(id),  -- EC-09/EC-25 điều chỉnh/thay thế
  customer_id INTEGER REFERENCES customers(id),
  order_id INTEGER REFERENCES orders(id),
  delivery_id INTEGER REFERENCES deliveries(id),
  issue_date TEXT NOT NULL,                    -- YYYY-MM-DD giờ VN
  due_date TEXT NOT NULL,
  subtotal INTEGER NOT NULL,                   -- âm với hoá đơn điều chỉnh giảm
  vat_rate_bp INTEGER NOT NULL DEFAULT 0,      -- [Cần xác nhận hình thức kinh doanh / thuế suất]
  vat_amount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled')),  -- đã trả hay chưa tính từ allocations
  einvoice_status TEXT NOT NULL DEFAULT 'none'
    CHECK (einvoice_status IN ('none','queued','issued','failed','not_required')),
  einvoice_no TEXT,
  einvoice_series TEXT,
  einvoice_lookup_code TEXT,
  einvoice_error TEXT,
  buyer_name TEXT, buyer_tax_code TEXT, buyer_address TEXT, buyer_email TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_invoices_customer ON invoices(customer_id, status, due_date);
-- EC-09: hoá đơn đã phát hành điện tử không được sửa số tiền / khách / ngày
CREATE TRIGGER invoices_issued_immutable BEFORE UPDATE OF subtotal, vat_amount, total, customer_id, issue_date ON invoices
WHEN OLD.einvoice_status = 'issued'
BEGIN SELECT RAISE(ABORT, 'invoice_issued_immutable'); END;
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices BEGIN SELECT RAISE(ABORT, 'invoice_no_delete'); END;

CREATE TABLE invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  order_line_id INTEGER REFERENCES order_lines(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty_milli INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  amount INTEGER NOT NULL
);

-- ===== Hoá đơn mua (phải trả) — sinh từ phiếu nhập =====
CREATE TABLE supplier_bills (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                   -- CNP-YYYYMMDD-0001
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  stock_doc_id INTEGER REFERENCES stock_docs(id),
  supplier_ref TEXT,                           -- số hoá đơn NCC
  is_provisional INTEGER NOT NULL DEFAULT 0,   -- EC-30 hoá đơn đến muộn / giá chờ chốt
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled')),
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_bills_doc ON supplier_bills(stock_doc_id) WHERE stock_doc_id IS NOT NULL;
CREATE TRIGGER bills_no_delete BEFORE DELETE ON supplier_bills BEGIN SELECT RAISE(ABORT, 'bill_no_delete'); END;

-- ===== M5: thu / chi công nợ và gạch nợ =====
CREATE TABLE debt_payments (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),   -- in: khách trả; out: trả NCC
  partner_type TEXT NOT NULL CHECK (partner_type IN ('customer','supplier')),
  partner_id INTEGER NOT NULL,
  fund_id INTEGER NOT NULL REFERENCES funds(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','transfer','offset')),
  ref TEXT,
  paid_at TEXT NOT NULL,
  cash_voucher_id INTEGER REFERENCES cash_vouchers(id),       -- phiếu thu/chi M6 tương ứng
  bank_txn_id INTEGER,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_dpay_partner ON debt_payments(partner_type, partner_id);

CREATE TABLE debt_allocations (    -- gạch nợ một phần / toàn bộ (M5-03); phần chưa gạch = số dư có của khách (EC-24)
  id INTEGER PRIMARY KEY,
  payment_id INTEGER REFERENCES debt_payments(id),
  adjustment_id INTEGER,           -- hoặc từ điều chỉnh (chiết khấu, xoá nợ, trả hàng, cấn trừ)
  invoice_id INTEGER REFERENCES invoices(id),
  bill_id INTEGER REFERENCES supplier_bills(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((invoice_id IS NULL) <> (bill_id IS NULL)),
  CHECK ((payment_id IS NULL) <> (adjustment_id IS NULL))
);
CREATE INDEX idx_alloc_invoice ON debt_allocations(invoice_id);
CREATE INDEX idx_alloc_bill ON debt_allocations(bill_id);

CREATE TABLE debt_adjustments (    -- M5-08 chiết khấu TT, xoá nợ, trừ hàng trả; M5-09 cấn trừ
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('discount','write_off','return_credit','offset','opening_balance')),
  partner_type TEXT NOT NULL CHECK (partner_type IN ('customer','supplier')),
  partner_id INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending_approval','posted','rejected')),
  reason TEXT NOT NULL,
  approval_id INTEGER REFERENCES approvals(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Số dư đầu kỳ chỉ nhập một lần rồi khoá (M5 quy tắc)
CREATE TABLE opening_balances_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked_at TEXT NOT NULL,
  locked_by INTEGER NOT NULL REFERENCES users(id)
);

-- EC-24: giao dịch ngân hàng chưa rõ nội dung → chờ đối chiếu
CREATE TABLE bank_transactions (
  id INTEGER PRIMARY KEY,
  fund_id INTEGER NOT NULL REFERENCES funds(id),
  txn_date TEXT NOT NULL,
  amount INTEGER NOT NULL,         -- dương = tiền vào
  description TEXT,
  bank_ref TEXT,
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','ignored')),
  matched_type TEXT, matched_id INTEGER,
  imported_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(fund_id, bank_ref)
);

-- M6-03: đối soát COD / tiền sàn theo đợt của đối tác
CREATE TABLE settlements (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,            -- fresco | ghn | ghtk ...
  external_ref TEXT,
  period_from TEXT, period_to TEXT,
  fund_id INTEGER NOT NULL REFERENCES funds(id),
  expected_amount INTEGER NOT NULL,
  received_amount INTEGER NOT NULL,
  fee_amount INTEGER NOT NULL DEFAULT 0,
  diff_amount INTEGER NOT NULL,
  diff_reason TEXT,                -- bắt buộc khi diff ≠ 0
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source, external_ref)
);
CREATE TABLE settlement_lines (
  id INTEGER PRIMARY KEY,
  settlement_id INTEGER NOT NULL REFERENCES settlements(id),
  order_id INTEGER REFERENCES orders(id),
  external_order_id TEXT,
  expected_amount INTEGER NOT NULL,
  received_amount INTEGER NOT NULL,
  fee_amount INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

-- ===== Tích hợp: outbox job (MISA, ...) + webhook idempotency + map SKU sàn =====
CREATE TABLE integration_jobs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,              -- einvoice.issue | einvoice.adjust | fresco.ack ...
  ref_type TEXT, ref_id INTEGER,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);
CREATE INDEX idx_jobs_due ON integration_jobs(status, next_run_at);

CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  payload_json TEXT NOT NULL,
  result TEXT,
  UNIQUE(source, event_id)
);

CREATE TABLE external_products (   -- ghép SKU trên sàn với sản phẩm cửa hàng
  source TEXT NOT NULL,
  external_sku TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  unit TEXT NOT NULL,
  PRIMARY KEY (source, external_sku)
);

-- ===== Cài đặt Đợt 2 (đa số [Cần xác nhận]) =====
INSERT OR IGNORE INTO settings(key, value, note) VALUES
 ('quote.valid_days', '7', 'Báo giá B2B hiệu lực 7 ngày'),
 ('debt.aging_buckets', '30,60,90', 'Mốc tuổi nợ (ngày) [Cần xác nhận]'),
 ('debt.allocation', 'oldest_first', 'Gạch hoá đơn cũ nhất trước [Cần xác nhận]'),
 ('approval.writeoff_vnd', '0', 'Xoá nợ/chiết khấu > ngưỡng cần chủ duyệt (0 = luôn duyệt) [Cần xác nhận]'),
 ('approval.quote_discount_bp', '500', 'Báo giá thấp hơn bảng giá >5% cần duyệt [Cần xác nhận]'),
 ('invoice.vat_rate_bp', '0', 'Thuế suất GTGT mặc định (hộ kinh doanh = 0) [Cần xác nhận]'),
 ('einvoice.provider', 'fake', 'fake | misa — chuyển sang misa khi có tài khoản API'),
 ('einvoice.auto_issue_b2b', '1', 'Tự phát hành HĐĐT khi xuất hoá đơn B2B'),
 ('fresco.enabled', '0', 'Bật nhận đơn sàn Fresco [Cần xác nhận API]'),
 ('remind.days_before_due', '3', 'Nhắc nợ trước hạn (ngày)');
