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
- **Sửa thêm (PR giao diện PC 2B+2C, 25/11/2026)**: B-17 — lọc `from`/`to` của `/debts/payments` theo ngày VN (test `test/fix-debts-payments-vn-day.test.ts`).
- **Đợt sửa 5b (online & sỉ, migration 0022) — đã sửa** (`test/fix5b-*.test.ts`):
  - A-08: dòng đơn online mang giảm giá/voucher/điểm đã phân bổ; P&L theo kênh/ngày/nhóm có phí giao báo riêng (`shipping`) nên tổng breakdown = doanh thu.
  - A-11: số dư quỹ gồm tiền đơn online trả trước chưa hoàn tất và đơn huỷ/trả chờ hoàn (doanh thu vẫn ghi khi hoàn tất).
  - A-12: trả một phần theo dòng/số lượng đã có từ A-05 (phiếu `kind='return'`); thêm test hồi quy.
  - A-15: website dùng giá nhóm khách/bảng giá riêng của tài khoản đăng nhập (catalog, giỏ, checkout, mua lại).
  - A-17: cron 00:00 đổi lô giữ tồn xấu ngay sau khi đánh dấu hết hạn (giao đã kiểm hạn từ B-04).
  - A-18: một hàm đếm sức chứa khung giờ (`services/slots.ts`) cho web và ERP; giao lại kiểm ngày giao/giờ chốt/sức chứa.
  - A-19: sau cân tính lại khuyến mãi/voucher bằng engine và ngưỡng miễn phí giao (Cài đặt `online.pack_recalc_promo`, `online.pack_recalc_shipping`, [Cần xác nhận]).
  - A-20: `POST /online-orders/:id/weight-override` (nhân viên ghi nhận khách đồng ý qua điện thoại, bắt buộc lý do, audit).
  - A-24: khách vãng lai dùng lại hồ sơ khách bán lẻ cùng SĐT.
  - A-27: giao thiếu đơn sỉ → tạo đơn bổ sung `new` (tham số `backorder` khi xác nhận giao hoặc Cài đặt `b2b.backorder_on_short`, mặc định tắt).
- **Đợt sửa 5a (bán hàng & giá, migration 0021) — đã sửa** (`test/fix5a-sales.test.ts`):
  - A-09: đơn offline gửi `soldAt`/`shiftId`/giá đã hiển thị; ghi nhận theo giờ bán gốc (≤ `pos.offline_max_age_hours`), giữ giá snapshot nếu lệch ≤ `pos.offline_price_tolerance_bp`; chặn chốt ca khi còn đơn chờ đồng bộ. Ca gốc đã chốt thì đơn vào ca đang mở (audit ghi ca gốc).
  - A-10: đổi hạn mức/hạn thanh toán bắt buộc lý do; quản lý vượt `b2b.new_credit_limit_max_vnd` / `b2b.new_payment_terms_max_days` → yêu cầu chủ duyệt (`customer.credit_change`).
  - A-21: voucher không giới hạn lượt cần chọn khách ở POS (voucher có `max_uses` vẫn dùng ẩn danh — [Cần xác nhận]).
  - A-22 (tối thiểu): bảng giá riêng theo khách kênh pos/all; POS truyền khách khi bán.
  - A-23 / B-24: đổi giá hàng loạt / duyệt giá đóng các dòng giá hẹn tương lai cùng bảng giá + sản phẩm.
  - A-29: tự duyệt bán dưới giá vốn / giảm quá ngưỡng bắt buộc lý do, ghi audit.
  - C-30: bảng giá có `version`, sửa đồng thời → 409.
- **Đợt sửa 5c (kho, mua, tài chính, migration 0023) — đã sửa** (`test/fix5c-*.test.ts`):
  - B-12: trả hàng NCC theo lô của phiếu nhập (`/purchase-returns`), giảm công nợ phải trả (`return_credit`), huỷ hoá đơn mua khi trả hết và chưa thanh toán; duyệt theo `approval.purchase_return_vnd`.
  - B-15: giá đối thủ hết hàng không tính vào min/TB/gợi ý; ít dữ liệu thì so với giá bán của cửa hàng.
  - B-18 (một phần): báo cáo SQL làm tròn từng dòng như `money.ts`; lệch làm tròn thùng→kg giữa hoá đơn mua và giá trị lô được ghi nhận (`roundingDiff`), chưa đổi đơn giá lô sang milli-đồng.
  - B-21: số dư đầu kỳ (`is_opening`) không vào cơ sở tính VAT.
  - B-22: từ chối/huỷ phiếu chi chờ duyệt (kể cả kỳ đã khoá); duyệt phiếu kỳ khoá trả 423 rõ ràng.
  - C-23: đảo chi lương (`reverse-pay`) và huỷ tạm ứng chưa khấu trừ, có lý do + audit + kiểm khoá sổ.
- **Đợt sửa 5d (nhân sự, migration 0024) — đã sửa** (`test/fix5d-hr.test.ts`):
  - C-10: chốt bảng công chỉ kỳ đã kết thúc và theo thứ tự (hoặc `force` + lý do); chấm vào kỳ đã chốt → 409.
  - C-11: danh sách cảnh báo chấm công (`/attendance/alerts`, tab "Cảnh báo"), đánh dấu đã xem.
  - C-12: tạm ứng giới hạn luỹ kế `hr.advance_max_bp` (mặc định 50% lương), cấm tự tạm ứng (trừ chủ).
  - C-18: lịch sử lương theo ngày hiệu lực (`employee_salary_history`, chỉ `hr.sensitive` xem); tính lương theo mức đúng từng ngày.
  - C-19: phụ trội giờ làm trong ca ngày lễ/cuối tuần (`hr.holiday_premium_bp`, `hr.weekend_premium_bp`, mặc định 0).
  - C-20: chấm offline vẫn kiểm GPS/QR khi có; thiếu thì chờ duyệt + cảnh báo.
  - C-24: phụ cấp cố định/bảo hiểm theo tỉ lệ ngày làm khi vào/nghỉ giữa tháng (`hr.prorate_fixed_pay`, mặc định bật); `adjustMinutes.work` áp cho lương ca.
  - C-25: punch chờ duyệt của kỳ đã chốt từ chối được (có lý do).
  - C-26: cho nghỉ việc/khoá tài khoản chặn khi còn ca POS mở, cảnh báo/chặn khi còn yêu cầu chờ.
  - C-31: duyệt đổi ca kiểm ca đã bắt đầu, nghỉ phép đã duyệt, trùng ca.
- **Đợt sửa 6a (đổi hàng, phí giao khi huỷ, migration 0025) — đã sửa** (`test/fix6a-*.test.ts`):
  - A-13: `POST /orders/:id/exchange` — Đổi hàng tại quầy: phiếu trả (`kind='return'`, nhập lại đúng lô) + đơn bán mới (`exchange_of_order_id`, `exchange_return_order_id`) trong MỘT batch, phần chênh lệch đi qua két ca đang mở; cùng quy tắc quyền/ngưỡng duyệt của trả hàng POS (A-16). Giao diện: nút "Đổi hàng" ở chi tiết đơn POS. **Ngoài phạm vi: "tách đơn con"** (chia một đơn thành nhiều đơn con dùng chung thanh toán) và khuyến mãi/voucher/đổi điểm cho dòng hàng mới.
  - A-28: phí giao khi huỷ đơn online theo giai đoạn (chủ đã chốt): chưa soạn → miễn phí; đã soạn/đóng gói → khách chịu; giao thất bại rồi trả hàng → khách chịu. Cài đặt `online.cancel_fee_before_prepare` / `online.cancel_fee_preparing` / `online.cancel_fee_shipping` (khoá cũ `online.cancel_fee_policy` không còn dùng).
  - A-25: **quyết định của chủ — hạn mức nợ giữ theo tổng đơn CHƯA VAT** (không đổi logic, chỉ ghi chú trong `checkCredit`), dù công nợ ghi theo hoá đơn có VAT khi `invoice.vat_rate_bp > 0`.
  - A-27 (giao diện): màn Soạn & giao hiện ô "Tạo đơn bổ sung cho phần thiếu" khi giao thiếu (mặc định theo `b2b.backorder_on_short`).
- **Còn tồn sau đợt 5** (cần quyết định nghiệp vụ hoặc là tính năng mới): A-13 (tách đơn/đổi hàng), A-25 (cơ sở VAT cho hạn mức), A-26 (cổng thanh toán), A-28 (phí giao khi huỷ), C-21 (quyền `hr.manage` của kế toán), C-27 (thông báo người duyệt), C-28 (PDF báo cáo/phiếu lương), C-29 (chính sách lưu giữ dữ liệu). Phần còn lại nhỏ: B-18 (đơn giá lô milli-đồng), phép có lương cho NV giờ/ca (C-24), đơn nháp khi cho nghỉ việc (C-26), giao diện chọn đơn bổ sung khi giao thiếu (A-27).
