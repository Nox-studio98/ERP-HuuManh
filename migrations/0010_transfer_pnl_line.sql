-- Chuyển tiền nội bộ giữa các quỹ (vd rút khỏi quỹ chờ đối soát COD/sàn) không phải doanh thu hay chi phí.
-- Dòng P&L 'transfer' bị loại khỏi báo cáo lãi lỗ và chi phí theo kênh.
-- id cố định 901 (ngoài dải id 1–99 của dữ liệu danh mục nạp sẵn) để không chiếm id của seed khi migration chạy trước seed.
INSERT OR IGNORE INTO cash_categories(id, code, name, direction, pnl_line) VALUES (901, 'DOI_SOAT_RA', 'Chuyển khỏi quỹ chờ đối soát', 'out', 'transfer');
UPDATE cash_categories SET pnl_line = 'transfer' WHERE code = 'DOI_SOAT_RA';
