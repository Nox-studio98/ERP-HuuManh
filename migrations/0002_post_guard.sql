-- Chống post một chứng từ kho hai lần đồng thời: batch post chèn doc_id vào đây;
-- lần post thứ hai vi phạm PRIMARY KEY → toàn bộ batch (tạo lô, thẻ kho) rollback.
CREATE TABLE stock_doc_post_guard (
  doc_id INTEGER PRIMARY KEY REFERENCES stock_docs(id),
  posted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
