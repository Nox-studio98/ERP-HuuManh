-- Fix đợt 2 (audit nghiệp vụ B: B-02, B-03, B-04, B-19, B-20).

-- B-03 / EC-15: cách ly lô hỏng (status='quarantine' đã có trong CHECK) — lưu lý do + người thực hiện
ALTER TABLE lots ADD COLUMN quarantine_reason TEXT;
ALTER TABLE lots ADD COLUMN quarantined_at TEXT;
ALTER TABLE lots ADD COLUMN quarantined_by INTEGER REFERENCES users(id);

-- Đơn có phần giữ tồn không thay được lô khác (hết hạn / cách ly) → đánh dấu để người xử lý đơn thấy
ALTER TABLE orders ADD COLUMN reservation_short_milli INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN reservation_short_at TEXT;

-- Thông báo trong ứng dụng (audience_perm: quyền cần có để thấy thông báo)
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  audience_perm TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT,
  read_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_notifications_unread ON notifications(read_at, id);

-- B-02 / EC-18: phiếu kiểm kê có thể khoá xuất kho các lô tại vị trí đang kiểm
ALTER TABLE stock_docs ADD COLUMN lock_lots INTEGER NOT NULL DEFAULT 0;

-- B-19 / EC-21: chuyển kho 2 bước. transfer_status: 'in_transit' (đã xuất, chưa nhận) | 'received'
ALTER TABLE stock_docs ADD COLUMN transfer_status TEXT CHECK (transfer_status IN ('in_transit','received'));
ALTER TABLE stock_docs ADD COLUMN received_at TEXT;
ALTER TABLE stock_docs ADD COLUMN received_by INTEGER REFERENCES users(id);
ALTER TABLE stock_doc_lines ADD COLUMN received_qty_milli INTEGER;
ALTER TABLE stock_doc_lines ADD COLUMN received_lot_id INTEGER REFERENCES lots(id);
ALTER TABLE stock_doc_lines ADD COLUMN lost_reason TEXT;

-- B-20 / EC-22: lịch sử gộp mã sản phẩm
CREATE TABLE product_merges (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES products(id),
  target_id INTEGER NOT NULL REFERENCES products(id),
  reason TEXT NOT NULL,
  moved_json TEXT,
  merged_by INTEGER NOT NULL REFERENCES users(id),
  merged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_product_merges_source ON product_merges(source_id);
