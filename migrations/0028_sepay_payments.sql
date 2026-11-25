-- Tích hợp SePay (xác nhận chuyển khoản qua webhook): sự kiện, mã thanh toán nợ sỉ / QR POS, yêu cầu QR POS, con trỏ đối soát.
-- Đơn website dùng chính mã đơn `DH` + 12 số làm mã thanh toán (không cần bảng mã riêng).

-- Người dùng hệ thống (không đăng nhập được: active = 0, hash không hợp lệ) để ghi phiếu thu/audit do webhook tạo ra.
INSERT OR IGNORE INTO users(id, username, full_name, pass_hash, role, active) VALUES (900, 'he-thong-sepay', 'Hệ thống (SePay)', '!', 'accountant', 0);

CREATE TABLE sepay_events (
  id INTEGER PRIMARY KEY,
  sepay_id INTEGER UNIQUE,           -- `id` trong payload webhook: khoá chống trùng
  api_id TEXT UNIQUE,                -- UUID giao dịch của API v2 (đối soát); KHÁC sepay_id
  source TEXT NOT NULL CHECK (source IN ('webhook','reconcile')),
  txn_at TEXT,                       -- thời điểm ngân hàng ghi nhận, UTC (transactionDate là giờ VN)
  account_number TEXT,
  gateway TEXT,
  code TEXT,                         -- mã thanh toán do SePay nhận diện (in hoa)
  transfer_type TEXT,
  amount INTEGER NOT NULL,           -- VND nguyên, dương
  reference_code TEXT,               -- mã tham chiếu ngân hàng (không duy nhất)
  content TEXT,                      -- nội dung chuyển khoản (dữ liệu cá nhân: chỉ người có quyền tài chính xem, không ghi log)
  payload_json TEXT NOT NULL,        -- bản gốc để đối chứng (bảng hạn chế truy cập)
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','matched','unmatched','refund_pending','refunded','ignored')),
  verdict INTEGER,                   -- 1 = đã trả success:true, 0 = success:false; NULL = chưa quyết định
  reason TEXT,                       -- lý do chưa khớp / chờ hoàn
  kind TEXT,                         -- web | b2b | pos
  ref_id INTEGER,
  ref_code TEXT,
  resolution TEXT,                   -- ghi chú xử lý tay (gán / đã hoàn / bỏ qua)
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
CREATE INDEX idx_sepay_events_status ON sepay_events(status, id);
CREATE INDEX idx_sepay_events_ref ON sepay_events(kind, ref_id);

-- Mã thanh toán cho hoá đơn sỉ (b2b) và yêu cầu QR tại quầy (pos): tiền tố + 8 chữ số, UNIQUE.
CREATE TABLE pay_codes (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('b2b','pos')),
  ref_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(kind, ref_id)
);

-- Yêu cầu QR tại quầy POS: tạo trước khi có đơn; webhook đánh dấu 'paid'; thanh toán đơn dùng nó (một lần) rồi 'used'.
CREATE TABLE pos_qr_requests (
  id INTEGER PRIMARY KEY,
  amount INTEGER NOT NULL CHECK (amount > 0),
  user_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','used','expired','cancelled')),
  expires_at TEXT NOT NULL,
  event_id INTEGER REFERENCES sepay_events(id),
  paid_at TEXT,
  order_id INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Con trỏ đối soát (api_cursor = UUID giao dịch cuối đã xử lý)
CREATE TABLE sepay_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO settings(key, value, note) VALUES
  ('sepay.enabled', '0', '[Cần xác nhận] Bật xác nhận chuyển khoản qua SePay (cần SEPAY_WEBHOOK_SECRET)'),
  ('sepay.account_numbers', '', '[Cần xác nhận] Số tài khoản nhận tiền đăng ký ở SePay (nhiều số cách nhau dấu phẩy); trống = dùng payment.bank_account'),
  ('sepay.flow_web', '1', 'Tự xác nhận đơn website chuyển khoản'),
  ('sepay.flow_b2b', '1', 'Tự thu nợ khách sỉ theo mã hoá đơn'),
  ('sepay.flow_pos', '1', 'Xác nhận QR tại quầy POS'),
  ('sepay.prefix_b2b', 'HDS', '[Cần xác nhận] Tiền tố mã thanh toán nợ sỉ (khớp Cấu trúc mã thanh toán ở SePay: 8 chữ số)'),
  ('sepay.prefix_pos', 'POS', '[Cần xác nhận] Tiền tố mã QR tại quầy (khớp Cấu trúc mã thanh toán ở SePay: 8 chữ số)'),
  ('sepay.pos_qr_ttl_min', '15', 'Số phút mã QR tại quầy còn hiệu lực'),
  ('sepay.api_base', 'https://userapi.sepay.vn/v2', '[Cần xác nhận] Địa chỉ API SePay (sandbox: https://userapi-sandbox.sepay.vn/v2)');
