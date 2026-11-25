-- Fix đợt 6c: C-27 thông báo cho người duyệt / báo lại người yêu cầu (qua outbox), C-28 (PDF — không cần bảng mới).

-- Thông báo trong app có thể gửi riêng cho một người (target_user_id) thay vì theo quyền; url = đường dẫn nội bộ để bấm vào.
ALTER TABLE notifications ADD COLUMN target_user_id INTEGER REFERENCES users(id);
ALTER TABLE notifications ADD COLUMN url TEXT;
CREATE INDEX idx_notifications_target ON notifications(target_user_id, id);

-- Tham số (đều khai báo ở settings-registry.ts)
INSERT OR IGNORE INTO settings(key, value, note) VALUES
  ('notify.approval.enabled', '1', 'Bật thông báo cho người duyệt khi có yêu cầu chờ duyệt và báo lại người yêu cầu khi được duyệt/từ chối (1 = bật)'),
  ('notify.approval.push', '1', 'Gửi cả Web Push (nếu người nhận đã đăng ký) ngoài thông báo trong app (1 = bật)'),
  ('notify.approval.groups', 'finance,sales,stock,hr,other', 'Các nhóm yêu cầu có thông báo: finance (phiếu chi, công nợ), sales (giảm giá, dưới giá vốn, hạn mức nợ, báo giá, giá, khuyến mãi), stock (kiểm kê, trả hàng NCC), hr (nghỉ phép, đổi ca, tăng ca, bổ sung công, chấm offline, đổi thiết bị), other');

-- Điểm gom chung: mọi yêu cầu chờ duyệt phát sinh (bảng approvals + các bảng yêu cầu nhân sự) tự ghi một job outbox
-- TRONG CÙNG giao dịch với nghiệp vụ; worker xử lý job (services/notify-approval.ts) tạo thông báo cho đúng người.
-- Job chỉ mang tham chiếu (bảng + id + giai đoạn), không chứa số tiền/lương/giá vốn.

-- approvals (phiếu chi, giảm giá, dưới giá vốn, hạn mức nợ, trả hàng NCC, kiểm kê lệch, báo giá, giá, khuyến mãi...)
CREATE TRIGGER notify_approvals_ins AFTER INSERT ON approvals WHEN NEW.status = 'pending'
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'approvals', NEW.id, '{"phase":"requested"}');
END;
CREATE TRIGGER notify_approvals_upd AFTER UPDATE OF status ON approvals WHEN OLD.status = 'pending' AND NEW.status IN ('approved','rejected')
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'approvals', NEW.id, '{"phase":"decided"}');
END;

-- Nghỉ phép
CREATE TRIGGER notify_leave_ins AFTER INSERT ON leave_requests WHEN NEW.status = 'pending'
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'leave_requests', NEW.id, '{"phase":"requested"}');
END;
CREATE TRIGGER notify_leave_upd AFTER UPDATE OF status ON leave_requests WHEN OLD.status = 'pending' AND NEW.status IN ('approved','rejected')
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'leave_requests', NEW.id, '{"phase":"decided"}');
END;

-- Đổi ca: pending (báo người nhận ca) → accepted (báo quản lý) → approved/rejected (báo người yêu cầu + người nhận ca)
CREATE TRIGGER notify_swap_ins AFTER INSERT ON shift_swap_requests WHEN NEW.status = 'pending'
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'shift_swap_requests', NEW.id, '{"phase":"asked"}');
END;
CREATE TRIGGER notify_swap_accepted AFTER UPDATE OF status ON shift_swap_requests WHEN OLD.status = 'pending' AND NEW.status = 'accepted'
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'shift_swap_requests', NEW.id, '{"phase":"requested"}');
END;
CREATE TRIGGER notify_swap_decided AFTER UPDATE OF status ON shift_swap_requests WHEN OLD.status IN ('pending','accepted') AND NEW.status IN ('approved','rejected')
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'shift_swap_requests', NEW.id, '{"phase":"decided"}');
END;

-- Bổ sung công (quên chấm / sửa giờ / ngoài vùng)
CREATE TRIGGER notify_corr_ins AFTER INSERT ON attendance_corrections WHEN NEW.status = 'pending'
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'attendance_corrections', NEW.id, '{"phase":"requested"}');
END;
CREATE TRIGGER notify_corr_upd AFTER UPDATE OF status ON attendance_corrections WHEN OLD.status = 'pending' AND NEW.status IN ('approved','rejected')
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'attendance_corrections', NEW.id, '{"phase":"decided"}');
END;

-- Tăng ca (bản quản lý tự nhập đã approved ngay thì không báo)
CREATE TRIGGER notify_ot_ins AFTER INSERT ON overtime_requests WHEN NEW.status = 'pending'
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'overtime_requests', NEW.id, '{"phase":"requested"}');
END;
CREATE TRIGGER notify_ot_upd AFTER UPDATE OF status ON overtime_requests WHEN OLD.status = 'pending' AND NEW.status IN ('approved','rejected')
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'overtime_requests', NEW.id, '{"phase":"decided"}');
END;

-- Đổi thiết bị chấm công
CREATE TRIGGER notify_dev_ins AFTER INSERT ON devices_registry_requests WHEN NEW.status = 'pending'
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'devices_registry_requests', NEW.id, '{"phase":"requested"}');
END;
CREATE TRIGGER notify_dev_upd AFTER UPDATE OF status ON devices_registry_requests WHEN OLD.status = 'pending' AND NEW.status IN ('approved','rejected')
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'devices_registry_requests', NEW.id, '{"phase":"decided"}');
END;

-- Chấm công offline chờ duyệt (pending) hoặc tính ngay nhưng có cờ xem lại
CREATE TRIGGER notify_punch_ins AFTER INSERT ON attendance_punches WHEN NEW.status = 'pending' OR NEW.review_flag = 1
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'attendance_punches', NEW.id, '{"phase":"requested"}');
END;
CREATE TRIGGER notify_punch_upd AFTER UPDATE OF status, review_flag ON attendance_punches
  WHEN (OLD.status = 'pending' AND NEW.status IN ('accepted','rejected')) OR (OLD.review_flag = 1 AND NEW.review_flag = 0)
BEGIN
  INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.approval', 'attendance_punches', NEW.id, '{"phase":"decided"}');
END;
