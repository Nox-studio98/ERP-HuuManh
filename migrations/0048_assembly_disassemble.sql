-- K-KHO4: tháo giỏ quà (đảo lệnh đóng giỏ). Lệnh vẫn giữ status 'posted' (CHECK cũ không đổi được), đánh dấu thời điểm tháo ở đây.
ALTER TABLE assembly_orders ADD COLUMN disassembled_at TEXT;
ALTER TABLE assembly_orders ADD COLUMN disassembled_by INTEGER REFERENCES users(id);
