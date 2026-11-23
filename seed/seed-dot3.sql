-- Hữu Mạnh ERP — dữ liệu demo Đợt 3 (website bán hàng online).
-- Chạy SAU migrations/0001 → 0004 và SAU seed/seed.sql. Chạy lại an toàn (INSERT OR IGNORE / UPDATE có điều kiện).

PRAGMA foreign_keys = ON;

-- ===== Khu vực giao hàng (M1-07, M8-02) =====
-- [Cần xác nhận] Thành phố và khu vực giao hàng thật của cửa hàng chưa được xác nhận.
-- Dữ liệu dưới đây lấy TP. Hồ Chí Minh làm VÍ DỤ.
INSERT OR IGNORE INTO delivery_zones (id, name, districts_json, fee, free_over, min_order, active) VALUES
  (1, 'Nội thành gần', '["Quận 1","Quận 3","Quận 10","Phú Nhuận","Bình Thạnh"]', 20000, 500000, 100000, 1),
  (2, 'Nội thành xa', '["Quận 7","Gò Vấp","Tân Bình","Tân Phú","Quận 5","Quận 6","Quận 8","Quận 11","Quận 12"]', 35000, 800000, 150000, 1),
  (3, 'Thủ Đức', '["Thủ Đức","Thành phố Thủ Đức","Quận 2","Quận 9"]', 40000, 1000000, 200000, 1);

-- ===== Khung giờ giao hàng (M8-02) =====
INSERT OR IGNORE INTO delivery_slots (id, label, start_time, end_time, cutoff_minutes, capacity, weekdays, active) VALUES
  (1, '8:00–10:00',  '08:00', '10:00', 90, 20, '1,2,3,4,5,6,7', 1),
  (2, '10:00–12:00', '10:00', '12:00', 90, 20, '1,2,3,4,5,6,7', 1),
  (3, '15:00–17:00', '15:00', '17:00', 90, 20, '1,2,3,4,5,6,7', 1),
  (4, '18:00–20:00', '18:00', '20:00', 90, 20, '1,2,3,4,5,6,7', 1);

-- ===== Sản phẩm hiển thị online (M8-01, M8-08, M8-10) =====
-- 20 / 29 sản phẩm. Khớp theo sku (xem seed/seed.sql).
-- Ghi chú: featured = 1 cho 6 sản phẩm nổi bật; allow_preorder = 1 cho 3 mặt hàng theo mùa.
-- online_step_milli: 500 (0,5 kg) cho hàng cân kg; 1000 cho hàng tính theo trái.

UPDATE products SET
  slug = 'tao-envy',
  description = 'Táo Envy nhập khẩu từ New Zealand, vỏ đỏ bóng, ruột giòn và ngọt thanh. Nên bảo quản trong ngăn mát tủ lạnh và ăn trong vòng 2 tuần để giữ độ giòn.',
  published_online = 1, featured = 1, allow_preorder = 0, online_sort = 1, online_step_milli = 500
WHERE sku = 'TAO-ENVY';

UPDATE products SET
  slug = 'nho-xanh-uc',
  description = 'Nho xanh Úc không hạt, quả tròn đều, vị ngọt mát và giòn mọng. Rửa nhẹ trước khi ăn; để trong hộp kín ngăn mát, dùng trong khoảng một tuần.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 2, online_step_milli = 500
WHERE sku = 'NHO-XANH-UC';

UPDATE products SET
  slug = 'cherry-my',
  description = 'Cherry Mỹ mùa vụ, quả đỏ sẫm căng mọng, vị ngọt đậm xen chút chua nhẹ. Hàng theo mùa, nhận đặt trước khi hàng về. Bảo quản ngăn mát, không rửa trước khi cất.',
  published_online = 1, featured = 1, allow_preorder = 1, online_sort = 3, online_step_milli = 500
WHERE sku = 'CHERRY-MY';

UPDATE products SET
  slug = 'kiwi-vang',
  description = 'Kiwi vàng New Zealand có ruột vàng mềm, vị ngọt chua hài hoà, giàu vitamin C. Để nơi thoáng vài ngày cho chín, khi chín mềm thì chuyển vào ngăn mát.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 4, online_step_milli = 500
WHERE sku = 'KIWI-VANG';

UPDATE products SET
  slug = 'le-han-quoc',
  description = 'Lê Hàn Quốc vỏ vàng nhạt, thịt trắng giòn, nước nhiều và thơm dịu. Ngon nhất khi ướp lạnh. Bảo quản ngăn mát tủ lạnh, tránh để chung với táo vì dễ bị dậy mùi.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 5, online_step_milli = 500
WHERE sku = 'LE-HAN';

UPDATE products SET
  slug = 'cam-my',
  description = 'Cam Mỹ vỏ mỏng, múi mọng nước, vị ngọt thanh và ít hạt. Phù hợp ép nước hoặc ăn tươi. Bảo quản nơi mát, có thể để ngăn mát tủ lạnh để giữ được lâu hơn.',
  published_online = 1, featured = 1, allow_preorder = 0, online_sort = 6, online_step_milli = 500
WHERE sku = 'CAM-MY';

UPDATE products SET
  slug = 'mit-thai',
  description = 'Mít Thái múi vàng óng, thơm nồng và ngọt đậm, cơm dày và giòn dai. Mít chín nên ăn trong ngày; có thể bảo quản múi đã tách trong hộp kín ngăn mát.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 7, online_step_milli = 500
WHERE sku = 'MIT-THAI';

UPDATE products SET
  slug = 'chuoi-gia-nam-my',
  description = 'Chuối già Nam Mỹ có cơm dẻo, vị ngọt đậm, rất hợp làm sinh tố hoặc chiên. Để ở nhiệt độ phòng cho chín đều; chuối chín kỹ có thể cho vào ngăn mát để chậm chín.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 8, online_step_milli = 500
WHERE sku = 'CHUOI-NAM-MY';

UPDATE products SET
  slug = 'xoai-cat-hoa-loc',
  description = 'Xoài cát Hòa Lộc từ Tiền Giang, quả vàng ươm, thơm lừng, thịt mịn và ngọt đậm. Nên ăn khi quả đã chín vừa; để ngăn mát khi chín để kéo dài thời gian dùng.',
  published_online = 1, featured = 1, allow_preorder = 0, online_sort = 9, online_step_milli = 500
WHERE sku = 'XOAI-CAT-HL';

UPDATE products SET
  slug = 'sau-rieng-ri6',
  description = 'Sầu riêng Ri6 Tiền Giang có múi vàng dày, cơm béo, vị ngọt bùi và thơm đặc trưng. Hàng theo mùa, nhận đặt trước khi có hàng. Sầu riêng chín nên ăn ngay hoặc bảo quản múi trong ngăn đá.',
  published_online = 1, featured = 1, allow_preorder = 1, online_sort = 10, online_step_milli = 500
WHERE sku = 'SAU-RIENG-RI6';

UPDATE products SET
  slug = 'mang-cut',
  description = 'Măng cụt Bến Tre vỏ tím sẫm, múi trắng mềm, vị ngọt chua thanh mát. Hàng theo mùa, nhận đặt trước khi có hàng. Bảo quản trong ngăn mát, ăn trong vài ngày để giữ vị ngon.',
  published_online = 1, featured = 1, allow_preorder = 1, online_sort = 11, online_step_milli = 500
WHERE sku = 'MANG-CUT';

UPDATE products SET
  slug = 'thanh-long-ruot-do',
  description = 'Thanh long ruột đỏ Bình Thuận, vỏ hồng tươi, ruột đỏ thẫm nhiều hạt đen giòn, vị ngọt thanh. Ướp lạnh trước khi ăn ngon hơn. Bảo quản ngăn mát và dùng trong khoảng một tuần.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 12, online_step_milli = 500
WHERE sku = 'THANH-LONG-DO';

UPDATE products SET
  slug = 'dua-hau',
  description = 'Dưa hấu Long An ruột đỏ, mọng nước, vị ngọt mát và giòn. Nên ăn lạnh vào ngày mua. Dưa đã cắt cần bọc kín và để ngăn mát, dùng trong 1 đến 2 ngày.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 13, online_step_milli = 1000
WHERE sku = 'DUA-HAU';

UPDATE products SET
  slug = 'oi',
  description = 'Ổi Đồng Tháp giòn ngọt, vỏ xanh mỏng, ruột hồng hoặc trắng với nhiều vitamin C. Có thể ăn trực tiếp hoặc chấm muối ớt. Bảo quản nơi thoáng mát, ăn trong vài ngày.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 14, online_step_milli = 500
WHERE sku = 'OI';

UPDATE products SET
  slug = 'chom-chom',
  description = 'Chôm chôm Bến Tre vỏ đỏ có lông, cơm trắng trong, ngọt thanh và mọng nước. Nên ăn trong 1 đến 2 ngày kể từ khi mua. Bảo quản ngăn mát trong túi giấy hoặc hộp thoáng khí.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 15, online_step_milli = 500
WHERE sku = 'CHOM-CHOM';

UPDATE products SET
  slug = 'vu-sua-lo-ren',
  description = 'Vú sữa Lò Rèn Vĩnh Long có cơm trắng mịn, béo ngậy và thơm nhẹ, vị ngọt dịu như sữa. Nên ăn trong vài ngày và để ngăn mát nếu chưa dùng ngay.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 16, online_step_milli = 500
WHERE sku = 'VU-SUA-LO-REN';

UPDATE products SET
  slug = 'bo-034',
  description = 'Bơ 034 Đắk Lắk có cơm vàng bơ, béo mịn và ít xơ, rất hợp làm sinh tố hoặc sữa bơ. Để nhiệt độ phòng cho chín mềm, khi chín có thể bảo quản ngăn mát.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 17, online_step_milli = 500
WHERE sku = 'BO-034';

UPDATE products SET
  slug = 'vai-thieu-luc-ngan',
  description = 'Vải thiều Lục Ngạn Bắc Giang có cùi trắng trong, mọng nước, vị ngọt thanh và thơm nhẹ. Nên ăn lạnh trong ngày; bảo quản ngăn mát và dùng trong vài ngày.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 18, online_step_milli = 500
WHERE sku = 'VAI-THIEU';

UPDATE products SET
  slug = 'du-du',
  description = 'Đu đủ Đồng Nai ruột cam đỏ, mềm ngọt và giàu vitamin. Chọn quả vỏ vàng đều, mềm nhẹ khi ấn. Quả chín nên để ngăn mát và ăn trong một tuần.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 19, online_step_milli = 500
WHERE sku = 'DU-DU';

UPDATE products SET
  slug = 'chuoi-tieu',
  description = 'Chuối tiêu Đồng Tháp có cơm vàng mịn, vị ngọt thơm và dẻo nhẹ, dễ ăn cho cả gia đình. Để nhiệt độ phòng cho chín; chuối chín có thể cho vào ngăn mát để giữ độ tươi.',
  published_online = 1, featured = 0, allow_preorder = 0, online_sort = 20, online_step_milli = 500
WHERE sku = 'CHUOI-TIEU';

-- ===== Giá online (price_list_id = 2 "Giá online") =====
-- Bằng giá bảng chung (list 1) giảm ~3%, làm tròn tới 1.000đ. Hiệu lực từ 2026-01-01.
-- id = 200 + product_id để không trùng dòng giá có sẵn.
INSERT OR IGNORE INTO prices (id, price_list_id, product_id, unit_price, effective_from, effective_to, status, created_by, note)
SELECT 200 + p.id, 2, p.id, CAST(ROUND(pr.unit_price * 0.97 / 1000.0) * 1000 AS INTEGER),
       '2026-01-01T00:00:00.000Z', NULL, 'active', 1, 'Giá online demo (-3%)'
FROM products p
JOIN prices pr ON pr.product_id = p.id AND pr.price_list_id = 1 AND pr.status = 'active' AND pr.effective_to IS NULL
WHERE p.sku IN ('TAO-ENVY','NHO-XANH-UC','CHERRY-MY','KIWI-VANG','LE-HAN','CAM-MY','MIT-THAI','CHUOI-NAM-MY',
                'XOAI-CAT-HL','SAU-RIENG-RI6','MANG-CUT','THANH-LONG-DO','DUA-HAU','OI','CHOM-CHOM','VU-SUA-LO-REN',
                'BO-034','VAI-THIEU','DU-DU','CHUOI-TIEU');

-- ===== Bài viết website (M8-10) =====
-- Banner không nạp ở đợt này (cần ảnh trên R2).
INSERT OR IGNORE INTO cms_posts (id, slug, title, excerpt, body_md, cover_key, status, published_at, created_by, updated_at) VALUES
  (1, 'cach-chon-sau-rieng-ngon', 'Cách chọn sầu riêng ngon',
   'Mẹo nhìn vỏ, cuống và mùi để chọn được quả sầu riêng cơm dày, béo và ngọt.',
   '## Nhìn vỏ và gai

Sầu riêng ngon thường có gai to, đều và cách nhau rõ ràng. Gai hơi nâu, khô và đầu gai nứt nhẹ thường cho thấy quả đã chín lâu. Bạn nên chọn quả có gai tươi, vỏ không bị dập và không có vết đen bất thường.

## Nhìn cuống và tiếng gõ

Cuống còn tươi, xanh hoặc nâu nhạt là dấu hiệu quả mới hái. Cuống đã khô, quắt lại thường là quả để lâu. Khi gõ nhẹ vào vỏ, tiếng đục và chắc cho thấy cơm dày; tiếng quá rỗng có thể là quả non hoặc cơm lép.

## Ngửi mùi

Sầu riêng chín có mùi thơm nồng, dễ nhận ra từ khoảng cách gần. Mùi quá gắt, chua hoặc lên men là dấu hiệu quả đã quá chín. Nếu mua để ăn ngay, hãy ưu tiên quả có mùi thơm dịu, đều.

## Bảo quản

Sầu riêng nguyên quả nên để nơi thoáng mát vài ngày để ổn định. Múi đã tách nên cho vào hộp kín và cất trong ngăn đá để giữ vị béo ngọt lâu hơn.',
   NULL, 'published', '2026-11-01T00:00:00.000Z', 1, '2026-11-01T00:00:00.000Z'),
  (2, 'bao-quan-trai-cay-nhap-khau-trong-tu-lanh', 'Bảo quản trái cây nhập khẩu trong tủ lạnh',
   'Cách sắp xếp và bảo quản táo, nho, cherry và kiwi nhập khẩu để giữ độ tươi lâu hơn.',
   '## Vì sao cần bảo quản đúng cách

Trái cây nhập khẩu thường được thu hoạch và vận chuyển đường dài, nên thời gian dùng tốt có thể ngắn hơn bạn nghĩ. Bảo quản đúng cách giúp giữ độ giòn, hương vị và hạn chế hỏng sớm.

## Chia theo nhóm

Táo, nho, cherry và kiwi nên để ngăn mát tủ lạnh, nhiệt độ khoảng 4 đến 8 độ C. Không nên rửa trước khi cất vì nước đọng dễ làm trái nhanh hỏng. Hãy rửa ngay trước khi ăn.

## Tránh để chung

Táo và chuối phát ra khí ethylen, có thể làm kiwi và các loại quả khác chín nhanh và mềm hơn. Nên để các loại này trong ngăn riêng hoặc túi kín.

## Dùng khăn giấy và hộp thoáng

Cherry và nho nên để trong hộp có lót khăn giấy khô để thấm ẩm. Kiểm tra định kỳ và loại bỏ quả dập để tránh lây sang quả khác.

## Mẹo nhỏ

Kiwi chưa chín có thể để nhiệt độ phòng vài ngày; khi mềm nhẹ thì chuyển vào ngăn mát. Trái cây nào đã cắt, hãy bọc kín và dùng trong 1 đến 2 ngày.',
   NULL, 'published', '2026-11-01T00:00:00.000Z', 1, '2026-11-01T00:00:00.000Z');
