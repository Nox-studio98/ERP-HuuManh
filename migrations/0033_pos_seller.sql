-- Người bán khác thu ngân (docs/POS-KV.md A4). NULL = người lập đơn (created_by).
ALTER TABLE orders ADD COLUMN seller_id INTEGER REFERENCES users(id);
CREATE INDEX idx_orders_seller ON orders(seller_id, created_at);
