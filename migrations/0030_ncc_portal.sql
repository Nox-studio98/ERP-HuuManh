-- Cổng nhà cung cấp (NCC) — docs/PO-NCC.md bước 4–5: tài khoản NCC, phiên riêng, lời mời đặt mật khẩu, audit có người thực hiện.
-- Cổng chạy trên Worker website (/ncc), TÁCH hẳn tài khoản/phiên của khách (shop_*) và nhân viên (users/sessions).

-- Tài khoản NCC: do cửa hàng MỜI từ ERP (không có tự đăng ký). Một NCC có nhiều tài khoản (nhân viên của NCC).
CREATE TABLE supplier_accounts (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  email TEXT NOT NULL,                       -- tên đăng nhập (chữ thường); duy nhất toàn hệ thống
  phone TEXT,
  full_name TEXT NOT NULL,
  pass_hash TEXT,                            -- PBKDF2 như tài khoản khác; NULL cho tới khi người được mời đặt mật khẩu
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','locked')),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  invited_by INTEGER REFERENCES users(id),
  locked_by INTEGER REFERENCES users(id),    -- nhân viên khoá tài khoản (không phải khoá tạm do nhập sai)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX uq_supplier_accounts_email ON supplier_accounts(email);
CREATE INDEX idx_supplier_accounts_supplier ON supplier_accounts(supplier_id, status);

-- Phiên cổng NCC: id = SHA-256 của token (cookie __Host-ncc); token thô không lưu.
CREATE TABLE supplier_sessions (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES supplier_accounts(id),
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_supplier_sessions_account ON supplier_sessions(account_id, revoked_at);

-- Lời mời / đặt lại mật khẩu: link dạng "<id>.<bí mật>"; chỉ lưu SHA-256 của phần bí mật; hết hạn (ncc.invite_ttl_hours), dùng MỘT lần, thu hồi được.
CREATE TABLE supplier_invites (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES supplier_accounts(id),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_supplier_invites_account ON supplier_invites(account_id, used_at, revoked_at);

-- Audit: ai thực hiện (nhân viên đã có user_id; NCC ghi actor = 'supplier_account:<id>'). Cột thêm, audit_log vẫn append-only.
ALTER TABLE audit_log ADD COLUMN actor TEXT;
CREATE INDEX idx_audit_actor ON audit_log(actor, id) WHERE actor IS NOT NULL;

-- Tham số (đều khai báo ở settings-registry.ts)
INSERT OR IGNORE INTO settings(key, value, note) VALUES
  ('ncc.invite_ttl_hours', '72', '[Cần xác nhận] Hạn link mời / đặt mật khẩu cổng nhà cung cấp (giờ)'),
  ('ncc.portal_enabled', '1', '[Cần xác nhận] Bật cổng nhà cung cấp /ncc trên website (1 = bật; 0 = tắt: NCC không đăng nhập được, phiên đang mở bị từ chối)');
