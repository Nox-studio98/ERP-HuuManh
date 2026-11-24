-- Màn hình Cài đặt: ghi nhận chủ cửa hàng đã xác nhận một tham số có chú thích "[Cần xác nhận]" (audit C-16/C-17).
-- Có dòng ở đây = huy hiệu "Cần xác nhận" của khoá đó biến mất. Lưu một giá trị đổi hoặc bấm "Xác nhận" đều ghi dòng này.
CREATE TABLE settings_confirmations (
  key TEXT PRIMARY KEY,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
