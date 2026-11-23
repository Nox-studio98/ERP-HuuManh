-- Đợt 3: M8 Website & ứng dụng bán hàng cho khách + xử lý đơn online trong ERP (M1-05/06/07).
-- Website là Worker riêng (huu-manh-shop) dùng chung D1 này.

-- ===== Sản phẩm hiển thị online (M8-01, M8-10) =====
ALTER TABLE products ADD COLUMN slug TEXT;
ALTER TABLE products ADD COLUMN description TEXT;          -- markdown đơn giản, hiển thị escape
ALTER TABLE products ADD COLUMN images_json TEXT;          -- ["products/12/a.webp", ...] khoá R2
ALTER TABLE products ADD COLUMN published_online INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN allow_preorder INTEGER NOT NULL DEFAULT 0;   -- M8-08
ALTER TABLE products ADD COLUMN online_sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN online_step_milli INTEGER;  -- bước số lượng khi đặt online (vd 500 = 0,5 kg)
CREATE UNIQUE INDEX idx_products_slug ON products(slug) WHERE slug IS NOT NULL;

-- ===== Tài khoản khách trên website / app (M8-07, M8-09) =====
CREATE TABLE shop_accounts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),   -- mỗi tài khoản gắn 1 hồ sơ khách (lẻ hoặc sỉ)
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  full_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'retail' CHECK (kind IN ('retail','b2b')),
  b2b_status TEXT CHECK (b2b_status IN ('pending','approved','rejected')),  -- khách sỉ phải được ERP duyệt liên kết
  email_verified_at TEXT,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT                                           -- NĐ 13/2023: yêu cầu xoá → ẩn danh hoá
);

CREATE TABLE shop_sessions (
  id TEXT PRIMARY KEY,                                      -- SHA-256(token)
  account_id INTEGER NOT NULL REFERENCES shop_accounts(id),
  ip TEXT, user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE shop_tokens (          -- xác minh email, đặt lại mật khẩu (dùng 1 lần, hết hạn)
  id TEXT PRIMARY KEY,              -- SHA-256(token)
  account_id INTEGER NOT NULL REFERENCES shop_accounts(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE shop_addresses (       -- sổ địa chỉ (M8-07)
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES shop_accounts(id),
  label TEXT,
  receiver_name TEXT NOT NULL,
  receiver_phone TEXT NOT NULL,
  address_line TEXT NOT NULL,
  ward TEXT, district TEXT NOT NULL, province TEXT NOT NULL,
  zone_id INTEGER REFERENCES delivery_zones(id),
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- ===== Giao hàng: khu vực + khung giờ (M1-07, M8-02) =====
CREATE TABLE delivery_zones (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  districts_json TEXT NOT NULL,     -- ["Quận 1","Quận 3",...] so khớp không dấu, không phân biệt hoa thường
  fee INTEGER NOT NULL,
  free_over INTEGER,                -- miễn phí giao khi tạm tính ≥
  min_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE delivery_slots (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,              -- "8:00–10:00"
  start_time TEXT NOT NULL,         -- "08:00" giờ VN
  end_time TEXT NOT NULL,
  cutoff_minutes INTEGER NOT NULL DEFAULT 90,   -- phải đặt trước giờ bắt đầu ít nhất N phút
  capacity INTEGER NOT NULL DEFAULT 20,         -- số đơn tối đa / khung / ngày
  weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
  active INTEGER NOT NULL DEFAULT 1
);

-- ===== Đơn online: cột bổ sung trên orders (channel 'online') =====
ALTER TABLE orders ADD COLUMN shop_account_id INTEGER REFERENCES shop_accounts(id);
ALTER TABLE orders ADD COLUMN tracking_token TEXT;          -- link tra cứu cho khách (không đoán được)
ALTER TABLE orders ADD COLUMN receiver_name TEXT;
ALTER TABLE orders ADD COLUMN receiver_phone TEXT;
ALTER TABLE orders ADD COLUMN ship_address TEXT;
ALTER TABLE orders ADD COLUMN zone_id INTEGER REFERENCES delivery_zones(id);
ALTER TABLE orders ADD COLUMN slot_date TEXT;               -- YYYY-MM-DD giờ VN
ALTER TABLE orders ADD COLUMN slot_id INTEGER REFERENCES delivery_slots(id);
ALTER TABLE orders ADD COLUMN payment_method TEXT;          -- cod | transfer | gateway
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'
  CHECK (payment_status IN ('unpaid','pending','paid','partially_refunded','refunded'));
ALTER TABLE orders ADD COLUMN estimated_total INTEGER;      -- tạm tính lúc đặt (hàng cân, EC-03)
ALTER TABLE orders ADD COLUMN weight_adjust_status TEXT NOT NULL DEFAULT 'none'
  CHECK (weight_adjust_status IN ('none','auto_accepted','pending_customer','accepted','rejected'));
ALTER TABLE orders ADD COLUMN carrier TEXT;
ALTER TABLE orders ADD COLUMN carrier_tracking_no TEXT;
ALTER TABLE orders ADD COLUMN cancel_reason TEXT;
ALTER TABLE orders ADD COLUMN shipping_fee_policy TEXT;     -- EC-06 ai chịu phí khi huỷ [Cần xác nhận]
CREATE UNIQUE INDEX idx_orders_tracking ON orders(tracking_token) WHERE tracking_token IS NOT NULL;
CREATE INDEX idx_orders_slot ON orders(slot_date, slot_id);
CREATE INDEX idx_orders_channel_status ON orders(channel, status);

ALTER TABLE order_lines ADD COLUMN ordered_qty_milli INTEGER;   -- số khách đặt (qty_milli = số thực khi cân, EC-03)
ALTER TABLE order_lines ADD COLUMN preorder_milli INTEGER NOT NULL DEFAULT 0; -- phần chờ hàng về (M8-08)

CREATE TABLE order_events (         -- dòng thời gian trạng thái cho khách theo dõi (M8-05)
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL,
  note TEXT,                        -- nội dung hiển thị cho khách (không chứa ghi chú nội bộ)
  internal_note TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer','staff','system')),
  actor_id INTEGER
);
CREATE INDEX idx_order_events ON order_events(order_id, at);

-- ===== Thanh toán online (M8-04) =====
CREATE TABLE payment_intents (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL,           -- vietqr | fake_gateway | <cổng [Cần xác nhận]>
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','expired','cancelled')),
  transfer_content TEXT,            -- nội dung CK bắt buộc, vd "HM DH20261123001"
  provider_ref TEXT,
  checkout_url TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  UNIQUE(provider, provider_ref)
);

-- ===== Thông báo đẩy (M8-05, M5-06) =====
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES shop_accounts(id),
  user_id INTEGER REFERENCES users(id),     -- nhân viên ERP nhận thông báo đơn mới
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error TEXT,
  CHECK ((account_id IS NULL) <> (user_id IS NULL))
);

-- ===== Nội dung website (M8-10) =====
CREATE TABLE cms_banners (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  image_key TEXT NOT NULL,
  link_url TEXT,                    -- chỉ đường dẫn nội bộ "/..." (chống open redirect)
  sort INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT, ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE cms_posts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT,
  body_md TEXT NOT NULL,            -- render an toàn (escape HTML) phía client
  cover_key TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT
);

-- ===== Cài đặt Đợt 3 (đa số [Cần xác nhận]) =====
INSERT OR IGNORE INTO settings(key, value, note) VALUES
 ('online.weight_tolerance_bp', '1000', 'EC-03: lệch cân ≤10% tự chấp nhận; vượt → khách xác nhận lại [Cần xác nhận]'),
 ('online.hold_minutes_transfer', '30', 'EC-05: giữ đơn chuyển khoản chờ tiền tối đa N phút rồi huỷ'),
 ('online.auto_confirm', '0', '1 = tự xác nhận đơn online khi đủ hàng; 0 = nhân viên xác nhận'),
 ('online.cancel_fee_policy', 'shop', 'EC-06 ai chịu phí giao khi khách huỷ sau khi giao cho shipper: shop | customer [Cần xác nhận]'),
 ('payment.methods', 'cod,transfer', 'cod,transfer,gateway — cổng thanh toán [Cần xác nhận]'),
 ('payment.bank_bin', '970436', 'Mã BIN ngân hàng nhận tiền (VietQR) — mặc định VCB, [Cần xác nhận]'),
 ('payment.bank_account', '', 'Số tài khoản nhận tiền [Cần xác nhận]'),
 ('payment.bank_account_name', '', 'Tên chủ tài khoản [Cần xác nhận]'),
 ('notify.email_provider', 'fake', 'fake | cloudflare'),
 ('shop.name', 'Hữu Mạnh — Trái cây tươi', ''),
 ('shop.hotline', '', '[Cần xác nhận]');

-- Chốt chặn đổi trạng thái đồng thời (services/online-orders.ts transitionStmts):
-- dòng chèn với ok=0 (trạng thái đã bị người khác đổi) vi phạm CHECK → cả batch rollback.
CREATE TABLE order_transition_guard (
  order_id INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1)
);
