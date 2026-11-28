-- Đợt 10 fix (website): S-2 email người mua lưu trên đơn; S-3 nhớ hồ sơ khách lẻ tạo lúc đăng ký (NĐ13); S-6 khai báo tham số.

-- S-2: NULL = đơn cũ / tạo ở ERP (dùng hồ sơ khách); '' = khách vãng lai không để lại email; có giá trị = gửi thông báo tới email này.
ALTER TABLE orders ADD COLUMN contact_email TEXT;

-- S-3: hồ sơ khách lẻ tạo lúc đăng ký (kể cả sau khi liên kết khách sỉ, customer_id đổi sang hồ sơ sỉ).
ALTER TABLE shop_accounts ADD COLUMN retail_customer_id INTEGER REFERENCES customers(id);
UPDATE shop_accounts SET retail_customer_id = customer_id WHERE kind = 'retail' AND retail_customer_id IS NULL;

-- S-6 + HR: giá trị mặc định đúng với mã (không ghi đè nếu chủ đã chỉnh).
INSERT OR IGNORE INTO settings(key, value) VALUES
  ('online.max_open_orders_per_phone', '3'),
  ('online.cod_unconfirmed_hours', '72'),
  ('hr.bonus_max_vnd', '2000000');
