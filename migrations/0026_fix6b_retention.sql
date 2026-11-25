-- Fix nhóm 6b: chính sách lưu giữ dữ liệu (C-29)

-- 1) Tham số chính sách (mọi mốc nằm ở Cài đặt; nhãn còn "Cần xác nhận" với chủ)
INSERT OR IGNORE INTO settings(key, value, note) VALUES
  ('retention.gps_months', '12', 'Sau số tháng này, toạ độ GPS của lượt chấm công bị xoá (giữ giờ, loại, trạng thái). Tối thiểu 6. [Cần xác nhận]'),
  ('retention.employee_pii_months', '24', 'Nhân viên nghỉ việc quá số tháng này: che CCCD, ngân hàng, địa chỉ, SĐT, email, ngày sinh (giữ họ tên, mã, dữ liệu lương). [Cần xác nhận]'),
  ('retention.audit_years', '10', 'Nhật ký audit_log giữ tối thiểu số năm này. Hiện KHÔNG tự xoá (chỉ ghi chính sách). [Cần xác nhận]');

-- Bản sao lưu R2: mặc định 90 ngày (trước đây 30). Chỉ đổi khi chủ chưa tự chỉnh (còn đúng giá trị mặc định cũ).
UPDATE settings SET value = '90', note = 'Số ngày giữ bản sao lưu R2 (backups/YYYY-MM-DD/). Mặc định 90 ngày. [Cần xác nhận]'
  WHERE key = 'backup.retention_days' AND value = '30';

-- 2) Dấu vết đã che dữ liệu cá nhân của nhân viên nghỉ việc (idempotent, không che hai lần)
ALTER TABLE employees ADD COLUMN pii_purged_at TEXT;

-- 3) attendance_punches vẫn bất biến, NGOẠI LỆ DUY NHẤT: đặt lat, lng, accuracy_m = NULL (cả ba cùng lúc) trên bản ghi
--    cũ hơn 6 tháng. Mọi cột khác (giờ, loại, thiết bị, trạng thái...) vẫn bị khoá như cũ; không xoá được dòng.
--    Giữ distance_m (khoảng cách tới cửa hàng) vì không cho biết nhân viên đang ở đâu.
DROP TRIGGER punches_immutable;
CREATE TRIGGER punches_immutable BEFORE UPDATE OF employee_id, kind, server_at, client_at, method, device_id ON attendance_punches
BEGIN SELECT RAISE(ABORT, 'attendance_immutable'); END;
CREATE TRIGGER punches_geo_scrub_only BEFORE UPDATE OF lat, lng, accuracy_m ON attendance_punches
WHEN NOT (NEW.lat IS NULL AND NEW.lng IS NULL AND NEW.accuracy_m IS NULL
          AND OLD.server_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 months'))
BEGIN SELECT RAISE(ABORT, 'attendance_immutable'); END;
