-- Màn quản lý khách lẻ: thông tin bổ sung và gộp khách trùng. Chỉ THÊM cột/chỉ mục vào customers.
ALTER TABLE customers ADD COLUMN birthday TEXT;                                         -- YYYY-MM-DD hoặc MM-DD (khách không nhớ năm)
ALTER TABLE customers ADD COLUMN gender TEXT CHECK (gender IS NULL OR gender IN ('male','female','other'));
ALTER TABLE customers ADD COLUMN address TEXT;                                          -- địa chỉ khách lẻ (khách sỉ dùng customer_addresses)
ALTER TABLE customers ADD COLUMN merged_into INTEGER REFERENCES customers(id);          -- khách đã gộp vào hồ sơ này (hồ sơ nguồn bị ngừng)
CREATE INDEX IF NOT EXISTS idx_customers_type_active ON customers(type, active, id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_merged ON customers(merged_into) WHERE merged_into IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON orders(customer_id, created_at);
