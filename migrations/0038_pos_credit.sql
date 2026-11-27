-- POS-KV đợt B1: bán nợ cho khách lẻ. Không có bảng mới — dùng hoá đơn phải thu (invoices), debt_payments, debt_allocations hiện có.
-- Hoá đơn phần ghi nợ: invoices(kind='sale', order_id = đơn POS, einvoice_status='not_required'); phần ghi nợ cũng có một dòng payments method='credit' (fund_id NULL).
INSERT OR IGNORE INTO settings(key, value, note) VALUES
 ('pos.retail_credit_enabled', '0', 'Cho phép bán nợ khách lẻ tại quầy (mặc định tắt) [Cần xác nhận]'),
 ('pos.retail_credit_default_limit', '0', 'Hạn mức nợ mặc định của khách lẻ mới (0 = phải đặt riêng từng khách)'),
 ('approval.pos_credit_vnd', '500000', 'Ghi nợ khách lẻ vượt mức này mỗi lần cần quản lý duyệt'),
 ('pos.retail_credit_default_terms_days', '7', 'Kỳ hạn thanh toán mặc định (ngày) của nợ khách lẻ khi khách chưa đặt kỳ hạn');
