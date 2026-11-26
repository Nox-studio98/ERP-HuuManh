# Đối chiếu ERP Hữu Mạnh với KiotViet (bán lẻ) — 26/11/2026

Nguồn: hướng dẫn sử dụng KiotViet ngành bán lẻ (lộ trình 6 bước: hàng hoá → nhập hàng → bán hàng → trả hàng → công nợ → báo cáo, cùng các mục Kết ca, Khách hàng, Nhóm khách, Sổ quỹ, Trả hàng, Nhập hàng, Trả hàng nhập, Kiểm kho, Xuất huỷ, Nhà cung cấp, Báo cáo, Thiết lập giá, Đặt hàng, Hoa hồng, Tích điểm, Thu khác, Mẫu in, Chuyển hàng, Xuất dùng nội bộ).
Chỉ học **nghiệp vụ và luồng thao tác**; giao diện làm bằng bộ thành phần của dự án. Đã đối chiếu riêng: Chấm công (đã làm, PR #21) và Bán hàng (`docs/POS-KV.md`, tạm dừng).

> **Mức độ:** đây là đối chiếu sơ bộ (đọc kỹ Kết ca và Khách hàng; các mục khác theo tiêu đề tính năng). Đợt đối chiếu chi tiết từng trang so với mã nguồn đã **tạm dừng** ngày 26/11 theo yêu cầu — khi làm tiếp, đọc lại hướng dẫn KiotViet tại `kiotviet.vn/huong-dan-su-dung-kiotviet/retail-…` và kiểm chứng từng mục trong mã trước khi làm.
>
> **Thứ tự theo yêu cầu chủ dự án:** sửa chuẩn phần đang có trước (`BAN-GIAO.md` mục 2.2), sau đó mới chọn việc trong danh sách này. Các mục ghi "cần kiểm tra" là chưa chắc mình đã có hay chưa — đọc mã trước khi làm.

## 1. Kết ca (mở ca / đóng ca)

**Đã có:** mở ca với tiền đầu ca (gợi ý số kiểm đếm ca trước); một ca mở mỗi người; đơn bán tự gắn ca; đóng ca: hệ thống tự tính tiền mặt dự kiến (tiền mặt bán + phiếu thu/chi tiền mặt của quỹ ca + hoàn tiền huỷ đơn), kiểm đếm, **chênh lệch bắt buộc lý do**, ca đóng không mở lại (audit); bán offline vẫn chạy, đồng bộ đúng ca; màn đối soát ca cho kế toán (`/reconcile/shifts`).

**Còn thiếu:**
1. **Phiếu bàn giao ca** in được (máy in nhiệt / A4) và **in lại** từ lịch sử. Nội dung như KiotViet: thông tin chung (mã ca, người, giờ mở/đóng, tiền đầu ca, tiền bàn giao, chênh lệch, ghi chú) + **bán hàng theo từng hình thức** (tiền mặt, chuyển khoản, QR, thẻ, ví, điểm, voucher, công nợ) + phiếu thu, phiếu chi, trả hàng trong ca theo hình thức + công thức tiền mặt cuối ca.
2. **Lịch sử ca** cho thu ngân (ca của mình) và quản lý (mọi ca của cửa hàng), xem chi tiết giao dịch từng ca. Hiện thu ngân chỉ thấy ca gần nhất.
3. Bảng tổng kết khi đóng ca hiện mới có tiền mặt; nên hiện đủ các hình thức như mục 1 để thu ngân đối chiếu máy POS thẻ / sao kê chuyển khoản.
4. (Tuỳ chọn) Ô đếm tiền theo **mệnh giá** (500k, 200k, … ) tự cộng ra số kiểm đếm — KiotViet không có, nhưng hợp với quầy tiền mặt nhiều.
5. (Tuỳ chọn) Cho phép sửa giờ mở ca (KiotViet có tuỳ chọn); mình đang dùng giờ máy chủ — **giữ nguyên** là an toàn hơn.
6. Cảnh báo ca mở quá lâu / quên đóng ca (KiotViet không tự đóng; mình có thể nhắc quản lý qua cảnh báo như chấm công).

## 2. Khách hàng (khách lẻ)

**Đã có:** khách sỉ đầy đủ (hồ sơ, nhiều địa chỉ/người liên hệ, hạn mức, kỳ hạn, giá riêng, người phụ trách, lịch sử, công nợ, cấn trừ với NCC); khách lẻ được tạo nhanh tại POS (tên + SĐT) để **tích điểm**; tài khoản khách website (`/shop-accounts`); điểm + sổ điểm bất biến; nhóm khách gắn bảng giá.

**Còn thiếu (khoảng trống lớn nhất so với KiotViet):**
1. **Màn quản lý khách lẻ** trong ERP: hiện menu chỉ có "Khách sỉ". Cần danh sách khách lẻ (tìm tên/SĐT/mã, lọc nhóm, tổng mua, lần mua cuối, điểm), thêm/sửa, **ngừng hoạt động**, **gộp khách trùng SĐT**. Xoá: chỉ ẩn danh hoá (đã có quy trình xoá tài khoản theo NĐ 13/2023 cho website), không xoá lịch sử.
2. **Chi tiết khách lẻ**: lịch sử mua / trả / đơn online, sổ điểm (cộng/trừ/điều chỉnh có lý do), công nợ (khi làm bán nợ — POS-KV đợt B).
3. **Xem nhanh lịch sử mua của khách ngay trên POS** (khi đã chọn khách).
4. **Nhóm khách tự động theo điều kiện** (tổng mua, số lần mua, điểm, công nợ, thời gian giao dịch) với cập nhật tự động; giảm giá mặc định theo nhóm (cần kiểm tra trùng với bảng giá theo nhóm đang có).
5. **Phân tích khách**: khách từ ngày, lần cuối mua, ngày/khung giờ hay mua, tổng mua/trả, tỉ lệ trả, top sản phẩm.
6. **Cảnh báo công nợ khách** (số tiền + số ngày nợ, chặn hoặc chỉ cảnh báo) — khách sỉ đã có hạn mức; khi có bán nợ lẻ thì áp dụng chung. Tiện ích "khách nợ vượt hạn mức" trên Tổng quan (cần kiểm tra Tổng quan hiện có).
7. **Ngày sinh** khách + nhắc sinh nhật (chăm sóc khách); trường SĐT/email đã có, cần quyền `customers.view_pii` như hiện tại.
8. **Nhập / xuất Excel** danh sách khách.

## 3. Các mục khác

| Mục KiotViet | Mình hiện có | Còn thiếu / nên làm |
|---|---|---|
| **Trả hàng** | Trả theo hoá đơn, cộng lại đúng lô, đổi hàng, hoá đơn điều chỉnh cho sỉ | **Trả hàng nhanh không cần hoá đơn gốc** (cần quy tắc giá trả + quyền duyệt); xử lý đơn giao bị hoàn về |
| **Nhập hàng** | Phiếu nhập (nháp → ghi sổ), theo lô/hạn, công nợ NCC tự sinh, chi phí nhập phân bổ (cần kiểm tra), từ PO | Sao chép phiếu nhập; **in tem mã vạch cho lô vừa nhập** (đã có Code128 nội bộ — cần kiểm tra in hàng loạt); lịch sử thanh toán trên phiếu nhập |
| **Trả hàng nhập (trả NCC)** | Cần kiểm tra (kho có `issue`/`waste`, chưa thấy chứng từ trả NCC riêng) | Phiếu trả hàng NCC theo phiếu nhập hoặc nhanh, giảm công nợ NCC, trừ đúng lô |
| **Kiểm kho** | Kiểm kê theo snapshot, chênh lệch vào P&L, duyệt | Gộp nhiều phiếu kiểm tạm; sao chép phiếu |
| **Xuất huỷ / Xuất dùng nội bộ** | Hao hụt (waste) có lý do | **Xuất dùng nội bộ** (hàng dùng cho cửa hàng, quà biếu) tách khỏi hao hụt, vào chi phí đúng loại |
| **Chuyển hàng** | Chuyển kho giữa vị trí | Hai bước gửi → nhận ở chi nhánh nhận (khi có nhiều cửa hàng) |
| **Nhà cung cấp** | Hồ sơ, công nợ, thanh toán, chiết khấu, cổng NCC, PO | Nhóm NCC; ngừng hoạt động; nhập/xuất Excel |
| **Sổ quỹ** | Phiếu thu/chi theo danh mục, duyệt, đảo phiếu, khoá sổ, nhiều quỹ | **Chuyển quỹ nội bộ** (tiền mặt → ngân hàng) nếu chưa có — cần kiểm tra |
| **Báo cáo** | Lãi lỗ ngày/kênh/nhóm, dòng tiền, GTGT, ngân sách, chi phí nhân sự | **Báo cáo cuối ngày** (một trang: bán, thu chi, trả, theo thu ngân — in được); báo cáo khách hàng; báo cáo NCC; báo cáo hàng hoá (bán chạy/chậm, xuất nhập tồn theo kỳ — cần kiểm tra) |
| **Thiết lập giá** | Bảng giá theo kênh/nhóm, đổi hàng loạt có hiệu lực, lịch sử, duyệt, cảnh báo dưới giá vốn | Xem/so sánh nhiều bảng giá cạnh nhau; xuất Excel bảng giá |
| **Đặt hàng (khách đặt trước)** | Đơn sỉ, đặt trước online, giỏ quà đặt cọc | Gộp phiếu đặt; đặt hàng tại quầy cho khách lẻ (ngoài giỏ quà) |
| **Hoa hồng** | Thưởng doanh số % chung | **Bảng hoa hồng** theo nhóm hàng / sản phẩm / người bán (cần POS-KV A4: người bán) |
| **Tích điểm** | Tích/đổi điểm POS + web, sổ điểm, hoàn điểm khi trả | Điểm riêng theo hàng hoá; điều chỉnh điểm thủ công có lý do (cần kiểm tra); nhóm khách theo điểm |
| **Thu khác** | — | Đã ghi trong POS-KV đợt B |
| **Mẫu in** | Hoá đơn POS cố định (`Receipt`), PDF báo giá/hoá đơn sỉ | Tuỳ chỉnh mẫu in (logo, chân trang, khổ 58/80 mm, A4), chọn mẫu khi in lại |

## 4. Gợi ý thứ tự (sau khi đã sửa chuẩn phần hiện có)
1. **Kết ca:** phiếu bàn giao in được + lịch sử ca + tổng kết theo hình thức thanh toán (việc nhỏ, dùng hằng ngày).
2. **Khách lẻ:** màn danh sách + chi tiết + lịch sử mua + gộp trùng + xem lịch sử trên POS.
3. **Báo cáo cuối ngày** in được.
4. Trả hàng nhanh không hoá đơn; trả hàng NCC; xuất dùng nội bộ.
5. Nhóm khách tự động, phân tích khách, sinh nhật; hoa hồng theo người bán (sau POS-KV A4).
6. Mẫu in tuỳ chỉnh; nhập/xuất Excel khách và NCC.
