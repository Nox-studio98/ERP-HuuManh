-- Audit #13: thành tiền dòng phiếu nhập = số lượng × đơn giá theo ĐƠN VỊ CHỨNG TỪ, làm tròn đúng một lần.
-- unit_cost lưu theo đơn vị chính (đã làm tròn khi quy đổi) nên nhân lại sẽ lệch hoá đơn thật của NCC vài đồng/dòng.
-- NULL = dòng cũ / dòng quét thêm số lượng → tính lại từ unit_cost như trước.
ALTER TABLE stock_doc_lines ADD COLUMN amount INTEGER;
