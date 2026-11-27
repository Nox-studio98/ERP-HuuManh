# Audit UX/UI — ERP Hữu Mạnh (27/11/2026)

Phạm vi: 61 màn trong NAV (kể cả màn ẩn `/hr/schedule`, `/hr/approvals`, `/hr/qr`, `/shift-close`) + màn đăng nhập, ở 1920×1080, 1440×900, 390×844 (dsf 2), cùng các hộp thoại chính. Tài khoản `chu`, DB dựng bằng smoke + b2b + pos-kv + pos-kv-b-delivery (`pos-kv-b` lỗi "Mở ca bán hàng" vì ca đã mở sẵn từ `pos-kv`, bỏ qua). Ảnh: `scratchpad/ux/` (tên `<màn>[--chi-tiet]-<size>.png`, `dlg-*.png`; log `ux/_log.json`). Script: `e2e/ux-audit-shots.mjs`, `ux-audit-2.mjs`, `ux-audit-3.mjs` (không commit).

Kết quả đo tự động: **không có trang nào tràn ngang** ở cả 3 cỡ (đã kiểm ~230 ảnh). Console/HTTP lỗi duy nhất: 401 khi đăng nhập (bình thường) và `404 /api/v1/me/attendance/today` ở màn Chấm công của chủ (UI đã xử lý bằng thẻ hướng dẫn, `silent`). Không thấy nút không nhãn. Không có lỗi JS.

Tổng quan: giao diện nhất quán, đẹp, không có lỗi hỏng chức năng ở góc nhìn bố cục. Không có phát hiện mức Cao. Các lỗi còn lại chủ yếu là định dạng ngày/số, chữ bị cắt ở dải lọc 390px, vài chỗ gãy dòng.

## Mức Trung bình

**T1. Ngày hiển thị sai quy ước (ISO yyyy-mm-dd) ở Báo cáo, Báo cáo bán hàng, Xuất Excel.**
- Màn: `/reports`, `/sales-reports`, `/exports` (cả 3 cỡ). Ảnh: `reports-390/1440`, `sales-reports-390`, `exports-1440/390`.
- Mô tả: phụ đề "2026-11-21 → 2026-11-27", nút "Xuất CSV theo ngày (2026-11-27)", thẻ "2026-10-29 → 2026-11-27", trong khi các màn khác dùng dd/mm/yyyy.
- Mã nghi ngờ: `src/web/screens/Reports.tsx:34`, `SalesReports.tsx:30`, `b2b/Exports.tsx:32` (và nút CSV theo ngày trong Reports.tsx). Đề xuất: dùng helper định dạng ngày hiện có (fmtDate) thay cho chuỗi `from`/`to` thô.

**T2. Dải lọc nhanh khoảng ngày bị cắt chữ ở 390px ("Tháng nà", "Tháng t", "Tuỳ …").**
- Màn: Đơn hàng, Đơn sỉ, Báo giá, Đơn online, Hoá đơn, Thu chi (tab Phiếu thu chi), Báo cáo, Báo cáo tài chính, Báo cáo bán hàng, Xuất Excel, Lịch sử ca (390). Ảnh: `orders-390`, `b2b-orders-390`, `quotes-390`, `exports-390`, `fin-reports-390`, `finance--chi-tiet-390`.
- Mô tả: `.daterange` cuộn ngang nhưng chip cuối bị cắt giữa chữ, trông như lỗi; không có gợi ý cuộn.
- Mã: `src/web/components/list.tsx` (`DateRangeFilter`) + `styles/app.css` `.daterange`. Đề xuất: cho xuống dòng (flex-wrap) ở <480px hoặc thêm mờ dần ở mép phải + `scroll-snap`; hoặc rút nhãn ("Tháng này" → "Tháng").

**T3. Thanh tab bị cắt cuối ở 390px.**
- Màn: Thu chi ("Đối s…"), Tích hợp ("Nhập đơ…"), Bảng lương ("Ch…" = Chi phí nhân sự), Khuyến mãi ("Tích …"), Giá đối thủ ("Nguồn & t…"), Khách sỉ chi tiết ("Giá…"). Ảnh: `finance-390`, `integrations-390`, `payroll-390`, `promotions-390`, `competitors-390`, `customers--chi-tiet-390`.
- Mã: `Segmented` trong `src/web/components/ui.tsx`. Đề xuất: cùng cách xử lý như T2 (wrap hoặc gợi ý cuộn); tối thiểu thêm fade mép phải.

**T4. Ô nhập ngày/tháng dùng bản địa hoá của trình duyệt (mm/dd/yyyy, "November 2026", "11/27/2026, 08:35 AM").**
- Màn: Công nợ → Sao kê (`debts--chi-tiet`, `dlg-thu-no`), Đơn sỉ ("Ngày giao"), Đơn online, Giá ("Hiệu lực từ"), Bảng công, Bảng lương ("October 2026"), Báo cáo cuối ngày, Xuất Excel. Cùng màn đó danh sách lại hiển thị dd/mm/yyyy nên lệch (vd Khuyến mãi: ô nhập "12/01/2026", danh sách "01/12/2026").
- Lưu ý: do trình duyệt headless ở locale en-US; trên máy người dùng vi-VN sẽ ra dd/mm/yyyy. Vẫn nên đặt `lang="vi"` trên `<html>`/input hoặc dùng ô ngày tự dựng, vì "Kỳ lương: October 2026" (type=month) sẽ ra tiếng Anh nếu trình duyệt không phải vi.
- Mã: 45 chỗ `type="date|month|datetime-local"` trong `src/web`; `index.html` thiếu/không đúng `lang`? (kiểm tra). Đề xuất: `<html lang="vi">`, kiểm tra thủ công trên Chrome vi-VN.

**T5. Chốt ca ở 390px: KPI "Dự kiến trong két 4.721.750 ₫" bị gãy dòng, ký hiệu ₫ rơi xuống dòng 2.**
- Ảnh: `shift-close-390`. Mã: `src/web/screens/ShiftClose.tsx:52` (`.kpi .v`). Đề xuất: `white-space: nowrap` + giảm cỡ chữ (clamp) hoặc xếp KPI 1 cột.

**T6. "Tiền ra -0 ₫" (Ngân hàng) và "-500 ₫" có khoảng trắng sau dấu trừ.**
- Ảnh: `bank-390/1440` (thẻ Tiền ra: "-0 ₫" — giá trị 0 không nên có dấu âm), `shift-history-390/1440`, `reports_daily--chi-tiet-390` ("- 500 ₫").
- Mã: `src/web/screens/Bank.tsx` (hoặc `b2b/Bank.tsx`) tính `-Math.abs(x)` khi x=0; định dạng số âm trong `src/web/format.ts` `money`. Đề xuất: chuẩn hoá `-0` → `0`; dùng dấu "−" liền số.

**T7. Danh sách Người dùng hiện tài khoản hệ thống ("Hệ thống" = `system`, "Hệ thống (SePay)") và cho mở "Sửa system".**
- Ảnh: `users-1440`, `users--chi-tiet-1440/390`. Rủi ro thao tác nhầm (đổi vai trò/đặt lại mật khẩu tài khoản hệ thống); KPI "Tổng người dùng 6, Vai trò Chủ 2" làm số liệu nhiễu.
- Mã: `src/web/screens/Users.tsx` + lọc phía API `/users`. Đề xuất: ẩn hoặc khoá nút Sửa cho tài khoản hệ thống, nhãn "Tài khoản hệ thống".

**T8. Biểu đồ "Doanh thu thuần theo người bán": nhãn trục X dính nhau ở 1440 ("Chủ cửa hàngNgười bán b5g…Thu ngân E2E") và nhãn quá nhỏ ở 390.**
- Ảnh: `sales-reports-1440`, `sales-reports-390`, `reports-390` (cột và nhãn "6.215k" rất nhỏ). Mã: `src/web/components/charts.tsx` `BarChart`. Đề xuất: cắt/xuống dòng nhãn, tăng cỡ chữ nhãn tối thiểu 11px, giới hạn bề rộng nhãn theo cột.

## Mức Thấp

- **L1. Vùng chạm < 40px ở 390** (đo trong `_log.json` mục `small`): chip khoảng ngày cao 34px; nút ‹ › chuyển tuần/tháng 28–32×34–36px (Bảng chấm công, Lịch ca, Bảng công); nút ✕ khu vực giao 22×24; tab "×" đóng hoá đơn POS 34×40; checkbox 13–22px (Khuyến mãi, Mua sắm "Chỉ hàng cần đặt", Giá đối thủ, Cài đặt "Chỉ mục cần xác nhận", Nợ "Chỉ quá hạn" 20px); checkbox "Chọn đơn" 20px; liên kết "Xem đơn #5", "Mở bản đồ", tên khách 16px cao. Đề xuất: min-height 40px cho `.daterange button`, `.btn` icon; bọc checkbox trong `<label>` có padding.
- **L2. Thanh "Chọn nhiều" của Đơn hàng ở 390** bị thanh trên che một phần khi cuộn (nút "Sửa người bán / ghi chú" lấp ló dưới topbar). Ảnh: `dlg-chon-nhieu-390`, `dlg-sua-nguoi-ban-390`. Mã: Orders.tsx (`region "Chọn nhiều đơn"` sticky top cần `top` = chiều cao topbar).
- **L3. Nhãn trạng thái "Đã trả" (đỏ) trong Đơn hàng** dễ hiểu nhầm là "đã thanh toán" — Đơn online dùng "Đã trả hàng". Ảnh: `orders-1440`, `dlg-chon-nhieu-390`. Mã: Orders.tsx (map nhãn). Đề xuất: "Đã trả hàng".
- **L4. Bảng Đơn hàng 1440 bị gãy dòng** ở cột "Thu ngân/Người bán" ("Chủ cửa / hàng") và "Mạng xã / hội" làm mỗi hàng cao gấp đôi (`orders-1440`). Đề xuất: `white-space: nowrap` hoặc rút cột; ở 1920 không bị.
- **L5. Giá: ô "Giá mới" hiện số trần "159000"** không có dấu chấm ngăn cách, khác định dạng cột bên cạnh (`prices-390/1440/1920`). Mã: `src/web/screens/Prices.tsx`.
- **L6. Chữ kỹ thuật lộ ra giao diện:** Gợi ý đặt hàng cuối trang "Cài đặt: reorder.lookback_days, reorder.cover_days" (`purchasing-1440`, Purchasing.tsx:111); Tích hợp "notify.order_status / order 14" (`integrations-1440`); Giao dịch SePay "Chưa đặt secret SEPAY_WEBHOOK_SECRET" (Sepay.tsx:53). Đề xuất: dùng tên cài đặt tiếng Việt, nhãn loại tác vụ dịch ("Thông báo trạng thái đơn").
- **L7. Hoá đơn HDB-…0002 có "Hạn 13/10/2026" trước ngày phát hành 27/11/2026** ("trễ 45 ngày", `invoices-1440`, `invoices--chi-tiet-390`). Có thể do dữ liệu e2e, nên kiểm tra cách tính hạn thanh toán khi tạo hoá đơn từ đơn sỉ.
- **L8. Màn QR chấm công `/hr/qr`**: "Mã đổi sau 0 giây" (hiển thị 0 khi vừa hết hạn) và lộ chuỗi mã thô "1.59858125.4LYCW70r…" (`hr_qr-390`). Đề xuất: ẩn chuỗi thô, đếm ngược không xuống dưới 1.
- **L9. Giỏ POS ở 390 (`dlg-pos-gio-390`)** chật: bước số lượng, ô đơn vị "kg" xuống dòng riêng, ô "Giảm đ" lệch; nút "Thanh toán" bị thanh dưới che một phần cho đến khi cuộn. Mã: Pos.tsx (`.pos-cart`, dòng giỏ). Đề xuất: sticky footer có Thanh toán + padding-bottom bằng chiều cao tab bar.
- **L10. Hộp Thanh toán 390**: nút "Thẻ" rơi xuống dòng riêng (`dlg-pos-thanh-toan-390`) — dùng lưới 2×2. Hộp "Thu tiền" (Công nợ): ô Quỹ bị cắt "Tiền mặt tại cửa l…" (`dlg-thu-no-390`); nút "Chuyển hết" gãy 2 dòng (`dlg-chuyen-quy-390`). Đóng/hủy ở hộp thoại là ✕ nhỏ (đã đủ vùng chạm 40px).
- **L11. Sao kê công nợ trong bottom sheet 390** (`debts--chi-tiet-390`): bảng 4 cột bị cắt cột "Số dư" ("1.144.00"), phải cuộn ngang trong sheet mà không có gợi ý. Đề xuất: ẩn cột "Chứng từ" hoặc xếp thẻ.
- **L12. 1920px: nội dung giới hạn 1600px canh trái** nên chừa ~230px trống bên phải (mọi màn; đã chốt trong WIP-UX-PC). POS 1920: giỏ hàng hẹp, nửa dưới cột giỏ trống (`pos-1920`); Website ở 1440/1920 chỉ một thẻ rỗng (do chưa có banner). Chấp nhận được; cân nhắc cho cột giỏ POS giãn theo chiều cao.
- **L13. Trạng thái rỗng tốt nhưng lặp tiêu đề ở vài màn:** tiêu đề trên topbar + `PageHeader` (Bảng công, Lịch sử ca) trùng một phần; không nghiêm trọng.
- **L14. Mô tả địa chỉ "Cửa hàng: 12 Nguyễn Huệ, Quận 1"** ở chi tiết Đơn sỉ (`b2b-orders--chi-tiet-390`) dễ đọc thành "Cửa hàng: 12" (số nhà dính nhãn). Thêm dấu cách/chấm phân cách: "Địa chỉ: Cửa hàng · 12 Nguyễn Huệ…".
- **L15. Màn Chấm công (/me) của chủ** vẫn phát sinh `404 /me/attendance/today` (console đỏ) dù UI đúng. Đề xuất: API trả 200 `{employee:null}` hoặc client không log.

## Không lỗi / đạt
- Tiền định dạng "₫" nhất quán trong mọi màn; badge, nút chính xanh lục nhất quán; ngày trong bảng/danh sách dd/mm/yyyy (trừ T1).
- Không tràn ngang ở 390; khung chi tiết 1440 ẩn bớt cột đúng (Nhân viên, Công nợ, Đơn online) không cắt chữ.
- Chính tả tiếng Việt: không thấy thiếu dấu hay lỗi chính tả; chỉ có chữ Anh còn sót ở L6 và T4 (tháng tiếng Anh).
- Trạng thái rỗng đầy đủ, có hành động gợi ý.
- Chưa chụp được: các nhánh Ghi nợ/Giao hàng/Thu khác trong hộp thanh toán POS (không có lựa chọn riêng; chỉ có "+ Chia thanh toán" và nút "Giao hàng"/"Thu nợ" ở trang POS — chưa chụp riêng) và Giao hàng sheet; `pos-kv-b` không chạy lại được trên cùng DB.
