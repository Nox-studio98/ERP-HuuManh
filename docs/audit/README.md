# Audit nghiệp vụ & đồng bộ luồng (24/11/2026)

3 audit độc lập, chỉ đọc code, đối chiếu tài liệu nghiệp vụ; lỗi quan trọng được tái hiện bằng probe test.

- [A — Bán hàng → tiền](nghiep-vu-A-ban-hang-tien.md): POS, website/online, B2B, công nợ phải thu, KM/voucher/điểm, giá bán.
- [B — Kho, mua hàng, giá, tài chính](nghiep-vu-B-kho-mua-tai-chinh.md): nhập hàng, lô/FEFO, giá vốn, phải trả NCC, quỹ, khoá kỳ, báo cáo.
- [C — Nhân sự, lương, phân quyền](nghiep-vu-C-nhan-su-phan-quyen.md): chấm công, bảng công, lương, ma trận RBAC, EC-01..39.

## Đánh giá chung: ~7/10 — demo tốt, chưa sẵn sàng chạy thật

| Module | Điểm |
|---|---|
| M1 Bán hàng (POS) | 8 |
| M8 Website/online | 7 |
| M4 B2B | 8 |
| M3 Giá / M7 Giá đối thủ | 8 / 8 |
| Khuyến mãi / điểm | 7,5 |
| M5 Công nợ | 6,5 |
| M2 Kho | 6 |
| M6 Tài chính / báo cáo | 5,5–6 |
| M9 Nhân sự / lương | 6,5 |
| Phân quyền | 8,5 |
| Yêu cầu chung | 6,5 |

EC-01..39: 29 đạt, 7 một phần, 3 thiếu (EC-10, 21, 22); 5 quy tắc Critical đạt.
Khoảng 81 phát hiện sau khi gộp trùng: 1 nghiêm trọng, ~15 cao, ~35 trung bình, ~31 thấp.

## Kế hoạch sửa
1. ✅ **Đã sửa (PR nhóm 1, migration 0014–0015)** — **Tiền & báo cáo**: phí COD/sàn trừ 2 lần (A-03 = B-05); xoá nợ/chiết khấu/cọc không vào P&L (A-04 = C-13); trả hàng online & P&L; chênh lệch kiểm kê, VAT đầu vào; chi NCC bỏ qua ngưỡng duyệt (B-01); khoá sổ chưa chặn hết (B-08); số dư có khi trả hàng B2B (A-01); cân lại đơn trả trước (A-02).
2. ✅ **Đã sửa (PR nhóm 2–3, migration 0016)** — **Kho**: lô hỏng đang giữ chỗ (B-03, EC-15); kiểm kê dùng snapshot cũ (B-02); giao không kiểm hạn (B-04); EC-21/22.
3. ✅ **Đã sửa (PR nhóm 2–3, migration 0017)** — **Nhân sự**: chấm công offline (C-01); lương giờ trả tăng ca 2 lần (C-03); duyệt lương không kiểm dữ liệu mới (C-04); tạm ứng vượt lương (C-05); lộ lương qua xuất sổ quỹ (C-02); sao lưu thiếu (C-06); đặt toạ độ cửa hàng (C-07).

## Trạng thái sửa
- **Nhóm 1 — đã sửa** kèm test hồi quy (`test/fix1a-*.test.ts`, `test/fix1b-*.test.ts`):
  - A-03/B-05, B-13: đối soát COD/sàn — quỹ thật nhận đúng số thực nhận; phí & chênh lệch là chi phí/thu khác ghi từ quỹ chờ; quỹ chờ về 0; quỹ nhận phải là quỹ thật.
  - A-04/C-13, B-06: P&L có xoá nợ, chiết khấu thanh toán (khách & NCC), cọc không hoàn, chênh lệch kiểm kê.
  - B-07: nhập VAT đầu vào khi lập phiếu nhập / chốt hoá đơn mua.
  - B-01: chi công nợ vượt ngưỡng → chờ duyệt (không phiếu quỹ, không gạch nợ đến khi duyệt).
  - B-08: khoá sổ chặn chốt hoá đơn mua, thu/chi & gạch nợ, điều chỉnh công nợ, trả hàng B2B, huỷ/trả/hoàn đơn online; chỉ khoá được kỳ đã kết thúc.
  - A-01: khách dư có sau trả hàng — hiển thị, cấn vào hoá đơn sau (`return_credit`) hoặc hoàn tiền (qua duyệt).
  - A-02: đơn trả trước cân lại — thu thêm khi giao / hoàn lại; không hoàn tất khi chênh lệch chưa xử lý (hoặc được miễn có duyệt).
  - A-05: trả hàng online lập chứng từ trả ngày trả, đơn gốc giữ nguyên doanh thu ngày giao.
  - Còn lại nhỏ: ngân sách–thực tế chưa gồm chênh lệch kiểm kê; điều chỉnh công nợ ghi theo ngày tạo (chưa có ngày duyệt).
- **Nhóm 2 — Kho, đã sửa** (`test/fix2-*.test.ts`):
  - B-03 (EC-15): cách ly lô hỏng (`POST /lots/:id/quarantine`) → đổi ngay hàng giữ cho đơn sang lô tốt theo FEFO; phần thiếu nhả giữ, gắn cờ đơn, thông báo quản lý; hao hụt/điều chỉnh/kiểm kê/chuyển tự đổi lô giữ trước khi ghi.
  - B-02 (EC-18): kiểm kê tính chênh lệch theo tồn lúc đếm, cảnh báo lô biến động, tuỳ chọn khoá lô khi kiểm. B-10: kiểm kê lệch do người không có quyền duyệt → chờ duyệt.
  - B-04: giao hàng không lấy lô hết hạn / cách ly (tự đổi lô hoặc 409 `lot_expired`).
  - B-20 (EC-22): gộp mã sản phẩm trùng có lưu vết (lô, giá, ánh xạ sàn, đơn đang mở, KM, giỏ quà, đơn sỉ lặp); báo cáo & file xuất tồn gộp vào mã đích.
  - B-19 (EC-21): chuyển kho 2 bước (đang đi đường → nhận), nhận thiếu ghi hao hụt có lý do.
  - B-14: nhập-xuất-tồn có cột lắp/tháo giỏ quà, các cột luôn cân. B-23: giá vốn tham chiếu chỉ tính lô bán được.
- **Nhóm 3 — Nhân sự, đã sửa** (`test/fix3-*.test.ts`):
  - C-01: chấm offline tính theo giờ bấm (trong 48h), tính công ngay + cờ "chờ xem lại"; quản lý xác nhận/từ chối.
  - C-02: file sổ quỹ gộp chi lương/tạm ứng thành "Chi lương (tổng)" với người không có quyền xem lương. C-22: sao kê ngân hàng cần `finance.view`.
  - C-03: lương giờ không trả giờ tăng ca 2 lần. C-04: duyệt lương báo `payroll_stale` khi dữ liệu đổi sau lần tính.
  - C-05: tạm ứng vượt lương chuyển phần còn lại sang kỳ sau, lương không âm.
  - C-06: sao lưu R2 đủ mọi bảng, đọc theo trang, có manifest + thời hạn lưu; script khôi phục `scripts/restore-from-r2.mjs` (chưa thử với D1/R2 thật).
  - C-07: màn "Cửa hàng" đặt toạ độ + bán kính chấm GPS. C-08: duyệt phép kiểm lại số dư lúc duyệt; vượt cần lý do ngoại lệ.
- **Chưa sửa có chủ đích**: C-21 (kế toán có `hr.manage` — tài liệu API ghi là chủ ý, cần chủ cửa hàng xác nhận); lý do riêng từng dòng kiểm kê (tài liệu nghiệp vụ không yêu cầu; EC-20 đã có duyệt chênh lệch lớn); EC-10 (tách đơn con/đổi hàng — chức năng mới, mức Trung bình); các phát hiện Trung bình/Thấp khác ngoài 3 nhóm.
- **Đợt sửa 4 (trước go-live) — đã sửa**:
  - A-06: huỷ đơn POS của ca đã chốt → tiền hoàn ghi vào ca đang mở, chỉ quản lý được huỷ.
  - A-07: chặn huỷ đơn đặt trước đã giao (dùng Trả hàng, hoàn đủ cả cọc).
  - A-14: huỷ/trả online chỉ tạo nghĩa vụ hoàn; chi tiền hoàn cần quyền tài chính.
  - A-16: thu ngân chỉ tự trả hàng của ca đang mở, dưới ngưỡng `approval.pos_return_vnd`, có nhập lại kho; ngoài ra cần duyệt.
  - B-09: chốt hoá đơn mua khác giá → điều chỉnh giá vốn lô còn tồn, phần đã bán vào "Chênh lệch giá mua".
  - B-11: lãi lỗ tính phiếu thu khác; phiếu đảo bù đúng dòng gốc.
  - C-09 (lễ không lương), C-14 (lương tháng theo giờ làm thực tế — chọn được trong Cài đặt), C-15 (ngày phép chỉ tính ngày làm việc).
  - C-16, C-17: màn **Cài đặt** (tham số theo nhóm, nhãn "Cần xác nhận", khoá/mở khoá sổ có lý do, nhật ký thay đổi).
  - Thêm khoản mục **Số dư quỹ đầu kỳ** (không tính vào lãi lỗ) để nhập số dư khi go-live.
- **Còn tồn sau đợt 4**: 45 lỗi trung bình/thấp còn lại trong danh sách — xử lý theo phát sinh trong tuần chạy song song.
