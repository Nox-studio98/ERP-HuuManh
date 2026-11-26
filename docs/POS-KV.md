# Bán hàng tại quầy — bổ sung theo đối chiếu KiotViet (đợt A)

> **Trạng thái (26/11/2026): TẠM DỪNG theo yêu cầu chủ dự án — chưa code.** Tài liệu này là kế hoạch đã chốt để làm sau. Khi làm tiếp: tạo nhánh từ `main` mới nhất, đánh số migration tiếp theo (kiểm tra `migrations/` lúc đó — `0032_pos_seller.sql` dưới đây chỉ là tên dự kiến), rồi làm A1–A6 kèm kiểm thử ở cuối tài liệu.

## Đối chiếu với KiotViet (tóm tắt)

**Đã có, tương đương:** tìm hàng theo tên/mã, quét camera (F4), phím tắt F2/F4/F9, bán theo cân, giảm giá dòng và cả đơn, khuyến mãi tự động, voucher, đổi điểm, thêm nhanh khách, thanh toán kết hợp (tiền mặt, chuyển khoản, QR SePay tự xác nhận, thẻ, ví), bán offline, mở/chốt ca, danh sách hoá đơn có lọc ngày/kênh/trạng thái/thu ngân/hình thức thanh toán, xuất file tổng quan, trả hàng, đổi hàng, huỷ đơn, xem thanh toán và phiếu in trong chi tiết đơn, QR thu nợ tự xác nhận cho hoá đơn sỉ.

**Còn thiếu — đợt A (ưu tiên, chi tiết bên dưới):** nhiều hoá đơn cùng lúc; chọn hàng theo ảnh + nhóm hàng; máy quét mã vạch USB/Bluetooth tuỳ chọn; người bán khác thu ngân (sửa người bán/ghi chú sau khi bán, sửa hàng loạt); sao chép hoá đơn; lọc thêm + in lại + chia sẻ hoá đơn.

**Còn thiếu — đợt B (làm sau, cần thiết kế riêng vì đụng công nợ / chứng từ):**
1. Bán nợ tại quầy cho khách lẻ có hạn mức; QR thu nợ trên hoá đơn bán lẻ (SePay); in mã QR lên hoá đơn để khách quét trả sau.
2. Sửa chi tiết hoá đơn đã lập: làm bằng chứng từ đảo + đơn mới (không sửa chứng từ cũ), chuyển phiếu thanh toán sang đơn mới.
3. Thu khác (phí đóng gói, phí giao…) cộng vào hoá đơn.
4. Bán giao hàng tại quầy (người nhận, địa chỉ, phí giao).
5. Xuất file chi tiết từng dòng hàng; chọn cột hiển thị trong danh sách hoá đơn.
6. Hoá đơn điện tử cho đơn bán lẻ (hiện chỉ có cho hoá đơn sỉ).
7. Nhập hoá đơn từ Excel.
8. Tem cân điện tử: đọc mã vạch có sẵn khối lượng/số tiền (EAN bắt đầu bằng 2) — cần biết loại cân của cửa hàng.

**Không cần:** Serial/IMEI (đã quản lý lô FEFO), nối thẳng hãng vận chuyển (Ahamove, KShip…), máy POS Android riêng (PWA chạy trên máy tính bảng/điện thoại).

---

Nguồn đối chiếu: hướng dẫn "Bán hàng" KiotViet (ngành bán lẻ). Chỉ học **luồng thao tác**, giao diện dùng bộ thành phần của dự án (`src/web/components`, `docs/UI-KIT.md`). Quy ước như `CLAUDE.md`: tiền nguyên VND, ghi nhiều dòng trong một `db.batch` + `auditStmt`, `requirePerm` + zod, `assertPeriodOpen` cho chứng từ có ngày, migration mới không sửa file cũ.

Đợt A gồm 6 việc. Đợt B (để sau, cần thiết kế riêng): bán nợ tại quầy + QR thu nợ hoá đơn bán lẻ + mã QR in trên hoá đơn; sửa chi tiết hoá đơn (chứng từ đảo + đơn mới); thu khác; bán giao hàng tại quầy; xuất file chi tiết dòng hàng; HĐĐT cho đơn bán lẻ; import Excel; mã vạch cân điện tử (EAN prefix 2x).

## A1. Nhiều hoá đơn cùng lúc (tab hoá đơn) — chỉ frontend
- Thanh tab trên khu giỏ hàng: "Hoá đơn 1", "Hoá đơn 2"… nút **+** thêm (tối đa 10), nút × đóng (hỏi xác nhận nếu giỏ có hàng). Mỗi tab có giỏ, khách, giảm giá đơn, ghi chú, người bán, `cartId` riêng.
- Lưu trong `localStorage` theo thiết bị (try/catch; hỏng thì vẫn chạy với 1 tab), tải lại trang không mất. Thanh toán xong tab đó trở về trống (giữ tab), hoặc đóng nếu có > 1 tab.
- Phím tắt: F3 thêm tab mới, Ctrl+1…9 chuyển tab (giữ F2/F4/F9 hiện có). 390px: tab cuộn ngang, nhãn ngắn ("HĐ 1").
- Bán offline (hàng đợi `offline.ts`) vẫn chạy đúng với từng tab.

## A2. Chọn hàng theo ảnh và nhóm hàng
- Công tắc kiểu hiển thị danh sách hàng: **Danh sách** (như hiện tại) | **Lưới ảnh**. Ghi nhớ theo thiết bị.
- Lưới ảnh: ảnh đầu tiên trong `products.images_json` (dùng cách tạo URL ảnh đang có ở màn Hàng hoá/website; không có ảnh → ô chữ cái đầu tên trên nền màu), tên, giá, tồn. Chạm là thêm vào giỏ (hàng bán theo cân → mở ô nhập khối lượng như hiện tại).
- Thanh lọc **nhóm hàng** (`product_groups`) dạng chip cuộn ngang, "Tất cả" mặc định. Nếu API danh sách hàng POS chưa trả `groupId`/ảnh thì bổ sung (chỉ thêm trường).

## A3. Máy quét mã vạch USB/Bluetooth — tuỳ chọn, không phụ thuộc
- Cài đặt theo thiết bị (menu ⚙ nhỏ trên màn POS, `localStorage`): **Dùng máy quét mã vạch** (bật/tắt, mặc định tắt) và **Sau khi quét**: Cộng 1 | Hỏi số lượng.
- Khi bật: lắng nghe phím toàn trang; chuỗi ≥ 4 ký tự gõ liên tiếp mỗi phím cách nhau < 35 ms và kết thúc bằng Enter = một lần quét (không cần focus ô tìm). Nếu con trỏ đang ở một ô nhập khác thì không chặn ô đó, trừ khi chuỗi có nhịp của máy quét (khi đó xoá phần vừa bị gõ vào ô và xử lý như quét).
- Tra mã: barcode của sản phẩm hoặc của đơn vị quy đổi (`product_units.barcode`, thêm đúng đơn vị đó). Không thấy → toast lỗi rõ "Không có hàng với mã …", không thêm gì. Hàng bán theo cân → mở ô nhập khối lượng.
- Không có máy quét: mọi cách cũ (gõ tìm, quét camera F4) giữ nguyên. Gõ tay bình thường không bị nhận nhầm.
- Có test đơn vị cho bộ phát hiện quét (hàm thuần: nhận chuỗi sự kiện {key, t} → các lần quét).

## A4. Người bán khác thu ngân
- Migration `0032_pos_seller.sql`: `orders.seller_id INTEGER REFERENCES users(id)` (NULL = người lập đơn), index `(seller_id, created_at)`.
- `GET /pos/sellers` (pos.sell): người dùng đang hoạt động có quyền `pos.sell` hoặc có hồ sơ nhân viên đang làm, `{items:[{id, name}]}` — không lộ thông tin khác.
- `POST /pos/orders` nhận `sellerId?` (phải nằm trong danh sách trên, sai → 422 `invalid_seller`). POS: ô chọn **Người bán** trong giỏ (mặc định người đăng nhập, nhớ theo tab).
- `PATCH /orders/:id/meta` `{sellerId?, note?, version?}` và `POST /orders/meta/bulk` `{ids:[≤100], sellerId?, note?}` — quyền mới **`orders.edit`** (owner, manager; thêm vào `lib/rbac.ts`). Chỉ đơn `kind='sale'`, không đổi tiền/hàng; kỳ của ngày đơn đã khoá → 423 như hiện có; audit `order.meta` (before/after). Một batch.
- `GET /orders` thêm lọc `sellerId`, trả `sellerId, sellerName`; tìm `q` khớp thêm **tên hàng** trong đơn. Thưởng doanh số (`routes/payroll.ts`) tính theo `COALESCE(seller_id, created_by)` (cả phần trừ hàng trả) — có test.
- Màn Đơn hàng: cột/lọc Người bán; chi tiết đơn có "Sửa thông tin" (người bán, ghi chú); danh sách có chế độ chọn nhiều → "Sửa người bán / ghi chú" (chỉ khi có `orders.edit`).

## A5. Sao chép hoá đơn
- Chi tiết đơn bán (POS) có nút **Sao chép**: mở `/pos` với một **tab mới** chứa đúng hàng, đơn vị, số lượng, khách của đơn cũ (giá lấy giá hiện hành, không chép giảm giá/khuyến mãi/thanh toán). Truyền qua `sessionStorage` (try/catch). Hàng đã ngừng bán → bỏ qua và báo.

## A6. Bộ lọc hoá đơn và in lại
- Lọc thêm: Người bán (A4), tên hàng trong đơn (qua `q`), ghi chú (qua `q`).
- Chi tiết đơn: nút **In lại** dùng `Receipt` hiện có (in trình duyệt) và **Chia sẻ** (Web Share API ảnh/văn bản hoá đơn nếu trình duyệt hỗ trợ, không thì sao chép văn bản) — để gửi Zalo.

## Kiểm thử bắt buộc
- vitest: `test/pos-seller.test.ts` (sellerId hợp lệ/không hợp lệ, meta đơn lẻ + hàng loạt, quyền, kỳ khoá, audit, thưởng doanh số theo người bán, lọc `sellerId`, `q` theo tên hàng), test đơn vị bộ phát hiện quét.
- E2E: thêm bộ `e2e/pos-kv.mjs` (PC 1440 + 390): mở 2 tab, bán ở tab 2 trong khi tab 1 giữ hàng; lưới ảnh + lọc nhóm; giả lập máy quét (gõ nhanh qua `keyboard.type` với delay 5 ms + Enter) khi bật và không thêm khi tắt; chọn người bán; sao chép đơn; sửa người bán hàng loạt. `e2e/smoke.mjs` và các bộ hiện có vẫn đạt. Ảnh `docs/screenshots/pos-kv-*.png`, tự xem lại.
