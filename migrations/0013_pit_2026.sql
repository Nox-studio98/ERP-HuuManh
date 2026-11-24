-- Biểu thuế TNCN cho thu nhập tiền lương, tiền công của cá nhân cư trú.
-- Luật Thuế TNCN số 109/2025/QH15 (hiệu lực 01/07/2026; phần tiền lương áp dụng từ kỳ tính thuế 2026): 5 bậc
--   ≤10tr 5% | 10–30tr 10% | 30–60tr 20% | 60–100tr 30% | >100tr 35% (thu nhập tính thuế/tháng).
-- Giảm trừ gia cảnh 15,5tr/tháng, người phụ thuộc 6,2tr/tháng theo NQ 110/2025/UBTVQH15 (từ 01/01/2026).
-- Chỉ ghi đè khi cửa hàng vẫn đang dùng giá trị mặc định cũ (không đè cấu hình đã chỉnh tay).
UPDATE settings
   SET value = '[[10000000,500],[30000000,1000],[60000000,2000],[100000000,3000],[null,3500]]',
       note = 'Biểu thuế TNCN luỹ tiến [trần, bp] — Luật 109/2025/QH15, áp dụng từ kỳ tính thuế 2026'
 WHERE key = 'hr.pit_brackets_json'
   AND value = '[[5000000,500],[10000000,1000],[18000000,1500],[32000000,2000],[52000000,2500],[80000000,3000],[null,3500]]';
UPDATE settings SET note = 'Giảm trừ gia cảnh bản thân — NQ 110/2025/UBTVQH15 (từ 01/01/2026)' WHERE key = 'hr.pit_family_deduction';
UPDATE settings SET note = 'Giảm trừ mỗi người phụ thuộc — NQ 110/2025/UBTVQH15 (từ 01/01/2026)' WHERE key = 'hr.pit_dependent_deduction';
