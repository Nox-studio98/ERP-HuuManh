# Audit nghiệp vụ C — M9 Nhân sự/lương/chấm công, RBAC, yêu cầu chung, EC-01..39

Phạm vi: `/home/user/erp-huumanh` (main, ngày audit 24/11/2026). Chỉ đọc; probe test tạm đã xoá.
Chú thích: CONFIRMED = đã chạy probe hoặc đọc code chắc chắn; PLAUSIBLE = suy luận từ code, chưa chạy.

---------------------------------------------------------------------------------------------------

## (a) Bảng phát hiện

| ID | Mức | Module | File:dòng | Mô tả | Kịch bản | Đề xuất sửa | Trạng thái |
|---|---|---|---|---|---|---|---|
| C-01 | Cao | M9 chấm công | `src/worker/routes/hr.ts:673,690` (+`services/hr-timesheet.ts` dùng `serverAt`) | Chấm công offline lưu `client_at` nhưng mọi tính công dùng `server_at` = thời điểm GỬI LÊN. Quản lý duyệt chỉ đổi status, trigger `punches_immutable` cấm sửa `server_at`. | NV mất mạng ở kho lạnh: vào 08:00, ra 17:00 (hàng đợi `Me.tsx`), có mạng 17:05 -> hai punch có server_at cách nhau ~14 ms. Probe: client nói 480 phút, bảng công ra **0 phút** (ngày không bị đánh dấu thiếu công). Lương giờ/ca/ngày công bị sai đúng tình huống mà spec 11.1 nêu. | Với `method='offline'` dùng `client_at` làm giờ hiệu lực (kẹp: ≤ server_at, ≥ server_at−16h, hiển thị chênh lệch cho người duyệt) trong `computeEmployeeTimesheet`/`nearestAssignment`; hoặc cho người duyệt chỉnh giờ có lý do. | CONFIRMED (probe2) |
| C-02 | Cao | RBAC/M9 lương | `src/worker/routes/exports.ts:56-65` (builder `so-quy`, guard `reports.view` tại `:187`) | `/exports/so-quy.xlsx` liệt kê toàn bộ phiếu chi của quỹ, không lọc `LUONG`/`payroll_item`/`salary_advance` như `GET /vouchers` (`finance.ts:52`). Cột diễn giải = `counterparty` = mã NV. | Quản lý (có `reports.view`, không có `hr.sensitive`) tải sổ quỹ -> thấy "NV-0001 chi 9.250.000" từng người, cả tạm ứng. Probe: file chứa "NV-T9401". Vi phạm quy tắc 11 "lương từng người chỉ chủ & kế toán xem" (lần audit trước chỉ vá `/vouchers` và `/audit`). | Thêm điều kiện loại ref_type payroll/salary_advance + category LUONG khi role thiếu `hr.sensitive` (gộp thành 1 dòng "Chi lương (tổng hợp)"); rà `reports/daily`, `cash-flow` theo cùng nguyên tắc. | CONFIRMED (probe1) |
| C-03 | Cao | M9 lương | `src/worker/services/payroll-calc.ts:138,147-166` | NV lương giờ: `basePay = rate × workedMinutes` (workedMinutes = out−in, đã gồm giờ làm thêm), rồi cộng thêm tăng ca = `rate × OTminutes × hệ số` (tính đủ hệ số, không phải phần chênh). Giờ tăng ca bị trả hai lần. | Ca 8h, ở lại 10h, OT duyệt 2h ×1,5, đơn giá 30.000: đúng = 8×30k + 2×30k×1,5 = 330.000; hệ thống = 300.000 + 90.000 = **390.000** (+60.000 mỗi 2h OT). Probe unit. | Trừ OT khỏi `workedMinutes` khi tính base cho `hourly`, hoặc OT chỉ cộng phần chênh (hệ số−1). Cần chốt với chủ cách tính (spec: [Cần xác nhận]). | CONFIRMED (probe1) |
| C-04 | Cao | M9 lương | `src/worker/routes/payroll.ts:205-221 (approve), 303-320 (entries), 345-380 (advances)` | Duyệt lương không kiểm dữ liệu đầu vào có đổi sau lần tính cuối. `POST /payroll/entries` chỉ chặn kỳ `approved/paid`, nên thưởng/phạt thêm khi kỳ đang `calculated` vẫn nhận 201, nhưng phiếu lương không có khoản đó; sau duyệt kỳ khoá -> khoản bị bỏ rơi vĩnh viễn. Cùng cơ chế với thay đổi hồ sơ NV, phụ cấp, tạm ứng được duyệt phiếu chi muộn. | Probe: tính lương -> thêm phạt 50.000 (201) -> chủ duyệt (200) -> phiếu lương `penalties=0`; khoản phạt không được áp ở đâu. | Lưu `calculated_at`; `approve` từ chối (409 `stale_calculation`) nếu có `payroll_entries/allowances/employees/salary_advances` mới hơn `calculated_at`, hoặc tự tính lại trước khi duyệt; hoặc chặn thêm entries khi kỳ `calculated` (bắt tính lại). | CONFIRMED (probe1) |
| C-05 | Trung bình | M9 lương/tạm ứng | `payroll-calc.ts:221`, `payroll.ts:250,267` | `net = gross − BH − TNCN − tạm ứng` không chặn âm; `pay` bỏ qua NV có net ≤ 0 và không đánh dấu tạm ứng đã trừ; tạm ứng chỉ khấu trừ đúng `deduct_period`, không chuyển kỳ sau. | Probe: lương 200.000, tạm ứng 500.000 -> net **−300.000**, `pay` trả `vouchers: []`, tạm ứng vẫn `paid`, không kỳ nào thu lại 300.000. Test hiện có (`sec-integrity-finance.test.ts:23`) coi "giữ lại" là đúng nhưng không có cơ chế mang sang kỳ sau. | Giới hạn khấu trừ ≤ net dương; phần dư tự sinh dòng "công nợ tạm ứng" mang sang kỳ kế (đổi `deduct_period`). | CONFIRMED (probe1) |
| C-06 | Cao | Yêu cầu chung: sao lưu | `src/worker/scheduled.ts:64-70, 72-81` | Sao lưu R2 hằng ngày chỉ gồm 27 bảng (đợt 1). Thiếu toàn bộ M9 (employees, attendance_*, timesheets*, payroll_*, salary_advances, leave_*), M4/M5 (invoices, supplier_bills, debt_*, deliveries, quotes, bank_transactions), khuyến mãi/điểm, shop_accounts, đơn lặp... Mỗi bảng `SELECT *` nạp hết RAM một lần (audit_log, stock_moves lớn dần); không có dọn bản cũ; không có công cụ khôi phục từ R2 như SECOPS mô tả ("nạp lại từ R2 backup"). | D1 Time Travel 30 ngày là lớp duy nhất đủ dữ liệu; sau 30 ngày hoặc khi D1 hỏng, bảng lương, hoá đơn, công nợ không có bản sao ngoài. Backup có thể vượt giới hạn bộ nhớ Worker khi bảng lớn và không có cảnh báo lỗi. | Dùng danh sách bảng tự sinh từ `sqlite_master` (trừ bảng tạm); phân trang theo id + ghi nhiều object; thêm lifecycle R2 (giữ N ngày), manifest + checksum, endpoint/script restore; cảnh báo khi cron backup lỗi. | CONFIRMED (đọc code) |
| C-07 | Trung bình | M9-13 cấu hình | `migrations/0005` (stores.lat/lng/geofence_m); không có route/UI nào ghi | Không có API/màn hình đặt toạ độ + bán kính cửa hàng (`UPDATE stores` chỉ có trong test). Seed không có lat/lng. Chấm GPS trả `store_not_geolocated`; QR cần `ATTENDANCE_QR_SECRET`. | Go-live: nhân viên không chấm được bằng GPS cho đến khi dev sửa SQL tay. | Thêm `GET/PUT /stores/:id` (users.manage hoặc hr.manage) + form trong màn Nhân viên/Cài đặt, kèm nút "lấy vị trí hiện tại". | CONFIRMED (grep) |
| C-08 | Trung bình | M9-18 phép | `hr.ts:956-963` (tạo đơn), `hr-common.ts:110-124` (leaveBalance) | Số dư phép chỉ trừ đơn đã `approved`; cờ `over_balance` chốt lúc tạo đơn và không tính lại khi duyệt. Hai đơn `pending` đều "đủ phép" nên duyệt cả hai vẫn vượt. | NV có 12 ngày, gửi 10 ngày (1–10/2) và 10 ngày (15–24/2): cả hai `overBalance=false`, quản lý duyệt cả hai -> dùng 20/12 ngày, không cần ngoại lệ (probe2). Spec: "không vượt số ngày còn lại trừ ngoại lệ do quản lý duyệt". | Tính số dư gồm đơn `pending` cùng năm khi tạo; và kiểm lại + yêu cầu `allowOverBalance` ngay lúc duyệt. | CONFIRMED (probe2) |
| C-09 | Trung bình | M9 lương/ngày lễ | `payroll-calc.ts:120,128`; `payroll.ts:123`; `hr-timesheet.ts:191-192` | Cờ `holidays.paid_off=0` (lễ không hưởng lương) bị bỏ qua: bảng công đặt `holiday=true` cho mọi ngày lễ (chỉ `note` mang paid_off) nhưng lương chỉ nhận `holiday` nên mọi ngày lễ đều được trả công. | Ngày lễ do cửa hàng khai báo `paidOff:false`: NV lương tháng không đi làm vẫn được 1 ngày công (probe unit: 100.000 với lương 2,6tr). | Truyền `paidOff` vào `TimesheetDayInput` (hoặc đọc `note`) và chỉ cộng `holidayOff` khi paid_off. | CONFIRMED (code + probe unit) |
| C-10 | Trung bình | M9-19 chốt công | `hr.ts:1104-1126` | Chốt bảng công không kiểm kỳ đã kết thúc và không bắt buộc chốt kỳ trước. Chấm công vẫn nhận vào kỳ đã chốt (không `assertPeriodsOpen`) nhưng bị bỏ qua. | Probe: chốt `2027-06` (tương lai) -> 200 (rows 0), chốt tháng hiện tại giữa kỳ -> 200; sau đó NV chấm vào -> 201 nhưng không vào bảng công/lương, không báo gì. Kỳ tương lai chốt xong chặn lịch ca/phép/OT/ngày lễ của kỳ đó. | Chặn chốt khi `period >= tháng hiện tại` (trừ cờ force có lý do), yêu cầu kỳ trước đã chốt; punch vào kỳ đã chốt trả 409 hoặc gắn cờ pending. | CONFIRMED (probe2) |
| C-11 | Trung bình | M9-23 cảnh báo | `hr-cron.ts:13-37`, `scheduled.ts:38` | Cảnh báo (chưa vào ca, quên ra ca, đa thiết bị, chấm xa) chỉ ghi `audit_log action='hr.alert'` và Web Push. Không có API/màn hình danh sách cảnh báo (và không có màn xem nhật ký); push cần VAPID (HANDOFF: chưa cấu hình). | Chưa cấu hình push hoặc quản lý tắt thông báo -> cảnh báo không ai thấy. | Thêm `GET /attendance/alerts` + thẻ cảnh báo trong màn "Duyệt chấm công"; nút xác nhận đã xử lý. | CONFIRMED (grep UI) |
| C-12 | Trung bình | M9-08 tạm ứng/SoD | `payroll.ts:345-380` | Tạm ứng ≤ ngưỡng 5tr/phiếu được chi ngay bởi kế toán; không giới hạn luỹ kế theo NV/kỳ, không giới hạn theo lương, không chặn tạm ứng cho chính mình. | Kế toán tạo nhiều phiếu 4.999.000 cho chính mình -> không cần duyệt; nếu vượt lương thì rơi vào C-05 (công ty mất). | Ngưỡng luỹ kế theo NV/tháng + ≤ x% lương; tạm ứng cho chính mình cần chủ duyệt. | CONFIRMED (đọc code) |
| C-13 | Cao | M5/M6 – EC-29 | `debts.ts:324-390`; `routes/reports.ts:40-80`, `services/finance-reports.ts` | Xoá nợ/chiết khấu thanh toán (`debt_adjustments`) chỉ gạch công nợ, không sinh phiếu chi/dòng chi phí; không bảng báo cáo lãi lỗ nào tham chiếu `debt_adjustments`. EC-29 yêu cầu "thể hiện trong báo cáo lãi lỗ". | Chủ duyệt xoá nợ 20 triệu: công nợ giảm, lãi lỗ tháng đó không đổi -> lợi nhuận bị thổi phồng. | Thêm dòng P&L "Xoá nợ/chiết khấu thanh toán" từ `debt_adjustments(status='posted', type in discount/write_off)` (khách; NCC thì là thu nhập). | CONFIRMED (grep) |
| C-14 | Trung bình | M9 lương tháng | `payroll-calc.ts:117-135` | Lương tháng tính theo "số ngày có ≥1 phút công" ×(base/26). Đi muộn, về sớm, thiếu giờ tính ở bảng công nhưng không ảnh hưởng lương (trừ khi nhập phạt tay). Một ca 30 phút = 1 ngày công. | NV vào 08:00 ra 08:30 vẫn đủ 1 ngày lương. | Chốt quy tắc với chủ (tối thiểu giờ/ngày, quy đổi theo giờ, trừ muộn); cấu hình `hr.min_minutes_per_day`, `hr.late_deduct_*`. | CONFIRMED (đọc code) – quy tắc cần xác nhận |
| C-15 | Trung bình | M9 phép/lịch | `hr.ts:951-956`; `hr-timesheet.ts:176-185` | Số ngày phép = số ngày lịch trừ ngày lễ, kể cả thứ Bảy/Chủ nhật/ngày nghỉ tuần (code ghi chú cố ý "không bỏ Chủ nhật"). Ngày nghỉ phép có lương cộng vào `leavePaidX10` cả ngày không có ca. | Nghỉ phép năm T2–CN = 7 ngày trừ phép (probe2: 70 ×10); lương tháng cộng 7 công phép. | Chỉ đếm ngày có ca xếp (hoặc loại ngày nghỉ tuần theo cấu hình). | CONFIRMED (probe2) |
| C-16 | Trung bình | Yêu cầu chung / M6-EC-33 | `finance.ts:193-208` | Khoá sổ cho phép khoá bất kỳ YYYY-MM (kể cả tháng hiện tại/tương lai), không có mở khoá, không kiểm kỳ trước đã khoá. Phạm vi khoá = phiếu thu/chi + huỷ đơn; chốt công/lương là cơ chế riêng không gắn với khoá sổ. Không có màn hình khoá sổ. | Chủ lỡ khoá tháng hiện tại -> mọi phiếu chi (kể cả chi lương, thu nợ) trả 423 cho đến hết tháng; không hoàn tác được. | Chỉ cho khoá kỳ đã kết thúc; thêm "mở khoá có lý do + duyệt" hoặc xác nhận 2 bước; UI khoá sổ. | CONFIRMED (đọc code) |
| C-17 | Trung bình | Yêu cầu chung / UI quản trị | `src/web` (không có màn) | Không có UI cho: nhật ký thay đổi (`GET /audit`), cài đặt hệ thống (`/settings`: ngưỡng duyệt, tham số hr.*, TNCN), khoá sổ, cấu hình cửa hàng. Chủ chỉ làm được bằng API/DB. | Yêu cầu "mọi thay đổi quan trọng ghi lại ai/lúc nào/trước-sau" có ghi nhưng không xem được trên app. | Thêm màn Nhật ký (lọc theo thực thể/người/ngày), Cài đặt, Khoá sổ. | CONFIRMED (grep) |
| C-18 | Trung bình | M9 hồ sơ/audit | `hr.ts:56-63,222-262` | Audit sửa hồ sơ chỉ ghi TÊN trường nhạy cảm đã đổi, không ghi giá trị trước/sau (cố ý). Không có lịch sử lương theo ngày hiệu lực; kế toán (hr.manage+hr.sensitive) sửa lương/ngân hàng của chính mình không bị chặn SoD (assertNotSelf chỉ áp cho luồng duyệt). Spec 12 yêu cầu "trước và sau khi sửa". | Kế toán tự tăng `baseSalary` của mình; nhật ký chỉ thấy `changed:["baseSalary"]`, không thể biết đã tăng từ đâu lên đâu; chỉ lộ nếu chủ đối chiếu bảng lương. | Ghi before/after cho trường lương nhưng ẩn qua `hr.sensitive` khi đọc (đã có cơ chế `***`); chặn sửa hồ sơ/lương của chính mình (chỉ chủ); bảng `employee_salary_history`. | CONFIRMED (đọc code) |
| C-19 | Trung bình | M9 lương/ngày lễ | `hr-timesheet.ts:195-215`, `payroll-calc.ts:147-166` | Hệ số ngày lễ/cuối tuần chỉ áp cho phút TĂNG CA đã đăng ký. NV tháng/ca đi làm đúng ca vào ngày lễ nhận 1 công thường, không có phụ trội. Spec 11.1: "ngày lễ: hệ số công riêng" [Cần xác nhận]. | Ca ngày 2/9 làm đủ 8h không ai tạo OT -> trả như ngày thường. | Cấu hình phụ trội cho giờ làm trong ngày lễ (tự phát sinh OT hoặc cộng hệ số), hoặc ghi rõ quy ước + cảnh báo khi chốt công. | PLAUSIBLE (chờ quy tắc cửa hàng) |
| C-20 | Trung bình | M9-13 chấm offline | `hr.ts:690-695` | Nhánh `offline` bỏ qua toàn bộ xác thực nơi chấm (GPS/QR/độ chính xác). Client tự khai `offline:{clientAt}` là qua; `distance_m` = null nên cảnh báo `far_punch` không bật. Chỉ còn khâu duyệt thủ công. | NV ở nhà gọi API với `offline` -> punch `pending`; người duyệt thấy `distanceM: null`, không có dữ kiện địa điểm. Probe: kết quả 201, `method:"offline"`, `distanceM:null`. | Bắt buộc gửi lat/lng + chấp nhận `accuracy`; từ chối `clientAt` cũ hơn 24h; hiển thị khoảng cách + cảnh báo khi duyệt; giới hạn số lần offline/tuần. | CONFIRMED (probe2) |
| C-21 | Thấp | RBAC (M9) | `lib/rbac.ts:50-52` (accountant `hr.manage`) | Spec: kế toán "Xem, Tạo bảng lương". Triển khai cho cả `hr.manage`: tạo/sửa hồ sơ, hợp đồng, cho nghỉ việc/khoá tài khoản nhân viên (trừ owner/manager/accountant), tạo user `staff`, sửa ngày lễ/loại phép, chốt công. | Rộng hơn spec; kết hợp C-18 tăng rủi ro nội bộ. | Tách `hr.manage` (hồ sơ) khỏi `timesheet.close`; chủ xác nhận có muốn kế toán quản lý hồ sơ. | CONFIRMED |
| C-22 | Thấp | RBAC (M6) | `debts.ts:700` | `GET /bank-transactions` dùng `debt.view` nên Thủ kho (M5 "Xem", M6 "Không") xem được sao kê ngân hàng (số tiền, người chuyển, nội dung). Menu "Ngân hàng" hiển thị cho thủ kho. | Thủ kho thấy giao dịch tài khoản. | Đổi sang `finance.view` hoặc thêm quyền `bank.view`. | CONFIRMED (đọc code) |
| C-23 | Thấp | M9 lương/sổ quỹ | `payroll.ts:232-278`, `finance.ts:133` | Chi lương/tạm ứng là phiếu "do module khác quản lý" nên không đảo được ở M6, mà M9 không có chức năng huỷ/đảo chi lương hoặc tạm ứng. Chọn nhầm quỹ là không sửa được. Không kiểm số dư quỹ (cả hệ thống không có kiểm tra quỹ âm). | Chi lương nhầm quỹ ngân hàng -> chỉ sửa được bằng phiếu thu/chi tay lệch ref. | Thêm `POST /payroll/periods/:p/reverse` (chủ duyệt, tạo phiếu đảo + mở điều chỉnh) và cảnh báo quỹ âm. | CONFIRMED |
| C-24 | Thấp | M9 lương | `payroll.ts:133`; `payroll-calc.ts:93-100,184` | Phụ cấp cố định và bảo hiểm tính đủ tháng kể cả NV vào/nghỉ giữa tháng hoặc 0 ngày công. Phút điều chỉnh công (`adjustMinutes.work`) không có tác dụng với NV `shift` (lương theo ca chỉ nhân `shifts`; probe: lương ca không đổi khi +480 phút). Phép có lương không được trả cho NV `hourly/shift`. | Điều chỉnh công kỳ sau cho NV trả theo ca là vô hiệu (im lặng). | Prorate phụ cấp theo ngày công; với `shift` chuyển phút điều chỉnh thành ca (480'=1 ca) hoặc từ chối tạo adjustment; quy ước phép có lương. | CONFIRMED (probe unit) |
| C-25 | Thấp | M9 chốt công | `hr.ts:838-856` | Punch `pending` của kỳ đã chốt cưỡng chế không thể duyệt hoặc từ chối (cả hai nhánh gọi `assertPeriodsOpen`), tồn tại vĩnh viễn ở danh sách chờ. | Sau `force close`, mục chờ không dọn được. | Cho phép `rejected` trong kỳ đã chốt (kèm lý do). | CONFIRMED (đọc code) |
| C-26 | Thấp | EC-39 | `hr.ts:~300 (terminate)`, `admin.ts:144` | Khoá tài khoản/cho nghỉ việc không kiểm tra ca POS đang mở, đơn nháp, yêu cầu duyệt đang chờ của người đó; không có chức năng chuyển việc đang làm cho người khác (EC-39). | Thu ngân bị khoá khi còn ca mở -> ca không đóng được, tiền mặt không đối soát. | Chặn khoá khi còn ca mở (hoặc cho quản lý đóng thay có lý do) + màn chuyển việc. | PLAUSIBLE |
| C-27 | Thấp | Yêu cầu chung: thông báo | `grep sendWebPush` | Chỉ có thông báo cho khách (trạng thái đơn) và cảnh báo chấm công. Không thông báo cho người duyệt (phiếu chi, giảm giá, hạn mức nợ, nghỉ phép, đổi ca, quên chấm công) hay cho nhân viên khi đơn của họ được duyệt/từ chối. | Phải mở màn hình Duyệt mới biết có việc. | Push/in-app cho người có quyền duyệt tương ứng. | CONFIRMED |
| C-28 | Thấp | Yêu cầu chung: xuất báo cáo | `exports.ts` (chỉ xlsx), PDF chỉ cho báo giá/hoá đơn | "Xuất Excel và PDF" – báo cáo (lãi lỗ, công nợ, bảng lương, phiếu lương) chỉ có Excel; phiếu lương không có PDF. | | PDF cho báo cáo chính/phiếu lương (đã có dịch vụ `pdf.ts`). | CONFIRMED |
| C-29 | Thấp | Yêu cầu chung: lưu giữ dữ liệu | `punches_*` trigger bất biến, audit append-only, không job dọn | Không có chính sách lưu giữ/xoá: vị trí GPS của NV, CCCD/ngân hàng NV đã nghỉ, audit_log, bản backup R2 tăng vô hạn. (Khách shop có xoá tài khoản theo NĐ13, NV thì không.) | | Chính sách (vd 2 năm sau nghỉ việc), job ẩn danh hoá lat/lng cũ, lifecycle R2. | PLAUSIBLE |
| C-30 | Thấp | EC-38 | `prices.ts:40` (PUT price-lists) | Phát hiện xung đột sửa đồng thời (`version`) có ở khách, sản phẩm, báo giá, hồ sơ NV nhưng không có ở bảng giá. | Hai người sửa bảng giá, lần lưu sau ghi đè im lặng. | Thêm cột `version` + 409. | CONFIRMED |
| C-31 | Thấp | M9-14/15 lịch ca | `hr.ts:590-` (swap decide) | Duyệt đổi ca không kiểm tra người nhận ca có đơn nghỉ phép đã duyệt/ca trùng giờ khác ngày đó, và không kiểm tra ca đã bắt đầu tại thời điểm duyệt. | Đổi sang NV đang nghỉ phép. | Kiểm tra xung đột lúc duyệt. | PLAUSIBLE |

Ghi chú các điểm đã kiểm tra và ĐẠT (không phải lỗi): chấm công theo giờ server; thiết bị đăng ký + duyệt đổi máy; QR xoay 30s, một lần/NV; nhật ký punch bất biến (trigger); sửa công chỉ qua yêu cầu + duyệt, người duyệt ≠ người yêu cầu; giờ VN cho ca qua đêm (tính cho ngày bắt đầu, `shiftWindow`/`dateOfIn`); thiếu giờ ra -> `missingPunch`, không đoán; chốt công kèm snapshot + trigger khoá; lương chỉ tính khi công đã chốt; chi lương một lần (`onceStmt`+`assertStmt`), phiếu chi đúng quỹ/khoản LUONG (`pnl_line=payroll`) xuất hiện trong P&L/dòng tiền; tạm ứng trừ đúng một lần (`status=deducted`); phiếu lương cá nhân chỉ khi kỳ đã duyệt; thưởng doanh số dùng `orders.total` (kind sale − trả hàng, completed, theo ngày VN) cùng nguồn báo cáo bán hàng (khác biệt hợp lý: giới hạn kênh `pos`, theo người tạo đơn); TNCN 2026 (5 bậc 5/10/20/30/35%, giảm trừ 15,5tr/6,2tr, miễn phần chênh OT) và BH 10,5%/21,5% trần 46,8tr đúng.

---------------------------------------------------------------------------------------------------

## (b) Độ phủ yêu cầu M9 (M9-01..24)

| Mã | Ưu tiên | Đánh giá | Triển khai / ghi chú |
|---|---|---|---|
| M9-01 hồ sơ NV | Must | Đạt | `hr.ts` employees/contracts/allowances; ẩn trường lương theo `hr.sensitive`; audit xem/sửa (C-18 về giá trị trước/sau) |
| M9-02 chấm công/phép/muộn/tăng ca | Must | Đạt (có lỗi C-01, C-08, C-15) | `hr.ts`, `hr-timesheet.ts` |
| M9-03 tính lương | Must | Một phần | `payroll-calc.ts`; lỗi C-03, C-09, C-14, C-19, C-24 |
| M9-04 chủ duyệt/chốt kỳ lương | Must | Đạt (C-04 dữ liệu lỗi thời) | `payroll.ts` approve (chỉ `payroll.approve` = owner), trigger khoá `payroll_items` |
| M9-05 chi lương -> thu chi | Must | Đạt | `payroll.ts:/pay`, phiếu `LUONG`, một lần, vào P&L/dòng tiền (C-23 không đảo được) |
| M9-06 lịch làm việc, đổi ca | Should | Đạt | `schedule/bulk`, `schedule/swaps`; e2e `hr-swap.mjs` |
| M9-07 phiếu lương tự xem | Should | Đạt | `/me/payslips`, `Me.tsx` |
| M9-08 tạm ứng, khấu trừ | Should | Một phần | C-05, C-12 |
| M9-09 BH + TNCN | Should | Đạt | cấu hình `hr.*`, migration 0013; thiếu sàn lương vùng |
| M9-10 báo cáo chi phí NS | Should | Đạt | `/payroll/reports/cost` theo tháng/vị trí |
| M9-11 thưởng doanh số | Could | Đạt | `hr.sales_bonus_bp` (mặc định tắt) |
| M9-12 chấm giờ server | Must | Đạt | `hr.ts:673` (offline: C-01) |
| M9-13 xác thực nơi chấm | Must | Một phần | GPS+QR có, nhưng thiếu cấu hình toạ độ (C-07), offline bỏ qua (C-20) |
| M9-14 ca làm | Must | Đạt | `shift_templates` (SANG/CHIEU/TOI, qua đêm) |
| M9-15 xếp ca tuần/xem lịch | Must | Đạt | `/schedule`, `/me/schedule` |
| M9-16 tự tính công | Must | Đạt | `computeEmployeeTimesheet` (muộn, về sớm, OT, ca gãy, lễ) |
| M9-17 quên chấm công | Must | Đạt | `/me/attendance/corrections` + decide |
| M9-18 nghỉ phép | Must | Một phần | loại nghỉ cấu hình được, số dư; C-08, C-15 |
| M9-19 bảng công tháng/chốt | Must | Đạt (C-10, C-25) | `/timesheets/:period/close` |
| M9-20 nhật ký chấm công | Must | Đạt | bảng punch bất biến + audit; API `/attendance/punches` |
| M9-21 tăng ca | Should | Đạt | đăng ký trước / xác nhận sau, hệ số cấu hình |
| M9-22 đổi ca | Should | Đạt (C-31) | |
| M9-23 cảnh báo | Should | Một phần | cron có, không xem được (C-11) |
| M9-24 vân tay/khuôn mặt | Could | Chưa làm (chủ định) | HANDOFF |

Quy tắc nghiệp vụ M9: lương chỉ chủ+kế toán xem: Đạt trừ C-02; kỳ lương chốt chỉ điều chỉnh ở kỳ sau (`payroll_entries.adjustment` + `timesheet_adjustments`): Đạt; sửa công cần duyệt: Đạt; ghi nhật ký xem/sửa dữ liệu nhạy cảm: Đạt (C-18); NV nghỉ giữa tháng chỉ tính đến ngày cuối: Đạt (C-24 phụ cấp); ca gãy: Đạt; ca qua đêm theo ngày bắt đầu: Đạt; NV giao hàng không ràng buộc vị trí (`location_exempt`): Đạt; mất mạng: Có nhưng sai tính công (C-01); đổi điện thoại cần duyệt: Đạt; hai người cùng sửa công: giữ cả hai lần trong nhật ký: Đạt (mỗi yêu cầu là một dòng audit).

Đồng bộ chéo: bảng công <- punch/phép/OT/lễ: đúng (`computeTimesheetLive`), trừ phép không theo ca (C-15), lễ paid_off (C-09); lương <- công đã chốt: đúng (409 `timesheet_open`); tạm ứng trừ một lần: đúng (trừ C-05); chi lương một lần: đúng; ranh giới ngày VN: đúng (`vnDate`, `vnDayRangeUtc`, ca qua đêm).

---------------------------------------------------------------------------------------------------

## (c) Ma trận phân quyền (mục 12) — spec vs triển khai

Chú giải: X = Xem, T = Tạo/sửa, D = Duyệt. "OK" = khớp; "+" = triển khai nhiều hơn spec; "−" = ít hơn spec.

| Module | Chủ | Quản lý | Thu ngân | Thủ kho | Kế toán | NV online/giao |
|---|---|---|---|---|---|---|
| M1 Bán hàng | OK (ALL) | OK: pos.sell/void/return/shift, orders.view | OK: pos.sell, return, shift, orders.view (T) | OK: orders.view (X) | OK: orders.view (X) | OK: orders.online.manage + orders.view |
| M2 Kho | OK | OK (inventory.view/write/approve, products.write) | OK: inventory.view (X) | OK: inventory.view/write (T); không products.write | OK: inventory.view (X) | OK: inventory.view (X) |
| M3 Giá | OK | OK: prices.view_sell/view_cost/write/approve | OK: view_sell | OK: view_cost (không có view_sell – hợp lý) | OK: view_sell+view_cost (X) | OK: view_sell |
| M4 B2B | OK | OK: b2b.view/write/approve/deliver | OK: không có | OK: b2b.view+deliver | OK: b2b.view (X) | OK: b2b.view (X) |
| M5 Công nợ | OK (debt.approve) | OK: debt.view/write (không approve) | OK: không có | OK: debt.view (X) | OK: debt.view/write (T) | OK: không có |
| M6 Tài chính | OK | OK: finance.view, shift_reconcile (X) | OK: chỉ finance.shift_reconcile | OK: không có (nhưng "+" C-22: xem sao kê ngân hàng qua debt.view) | OK: finance.view/write; không approve/lock | OK: không có |
| M7 Giá đối thủ | OK | OK: competitors.view/write | OK: không có | OK: không có | OK: không có | OK: không có |
| M8 Web/app | OK | OK: products.write (cms), orders.online.manage | OK: không có | X: chỉ qua `/orders` (orders.view); không có `/online-orders` (orders.online.manage) | X: tương tự | OK: orders.online.manage |
| M9 Nhân sự | OK | Xem chấm công: hr.self/view/schedule. "+" so với chữ "Xem chấm công": còn xếp ca, duyệt phép/OT/quên chấm/đổi ca/thiết bị (hợp lý theo quy tắc 11.1) | OK: hr.self (phiếu lương của mình) | OK: hr.self | Xem, Tạo bảng lương: hr.view/manage/sensitive + payroll.write. "+" hr.manage rộng hơn (C-21) | OK: hr.self |
| Vai trò `staff` (ngoài spec) | – | – | – | – | – | hr.self duy nhất (hợp lý) |

Không thấy trường hợp THIẾU quyền gây chặn nghiệp vụ. Danh sách lệch/quá rộng:
1. C-02 (Cao): Quản lý xem lương từng người qua `/exports/so-quy.xlsx` (reports.view không lọc LUONG).
2. C-21 (Thấp): Kế toán `hr.manage` rộng hơn "tạo bảng lương".
3. C-22 (Thấp): Thủ kho xem sao kê ngân hàng (`debt.view`) trong khi M6 = Không; menu `/bank` hiển thị theo `debt.view`.
4. Thấp: `GET /approvals` (Quản lý/Chủ) hiển thị reason của yêu cầu duyệt tạm ứng có số tiền (không kèm tên NV) — chấp nhận được.
5. Thấp: Quản lý có `audit.view`: spec không nêu; nội dung HR/lương đã được che `***` (đúng); các audit khác (giá vốn, nợ) xem được.
6. Thấp: Quản lý nhập tăng ca "đã duyệt ngay" cho bất kỳ NV với `multiplierBp` tới ×5 (hr.ts:1023) — không có hạn mức.
Mọi route /api/v1 đều có `requirePerm` (hoặc đăng nhập tối thiểu cho `/leave-types`, push, `/customers/:id/loyalty`); không route nghiệp vụ nào quên guard (đã rà 303 route).

Menu `src/web/App.tsx`: perms dùng "any-of" khớp API; không thấy mục hiển thị cho vai trò không dùng được, ngoại trừ: (i) `/bank` hiển thị cho thủ kho (C-22); (ii) `/finance` hiển thị cho thu ngân (chỉ có `shift_reconcile`) nhưng API `/funds`, `/vouchers` yêu cầu `finance.view` -> màn hình có thể báo lỗi 403 (mức nhỏ). Thiếu mục menu: Nhật ký, Cài đặt, Khoá sổ (C-17).

---------------------------------------------------------------------------------------------------

## (d) EC-01..EC-39

| EC | Mức spec | Đánh giá | Triển khai (file) | Test chứng minh |
|---|---|---|---|---|
| EC-01 | Cao | Đạt | `routes/pos.ts:565-710` trả theo lô gốc, restock/discard | `pos.test.ts` "returns to the original lot", "returns without restock"; `sec-integrity-pos` |
| EC-02 | Critical | Đạt | `services/stock.ts`, `reservations.ts` (CHECK trên lots) | `foundation.test.ts`, `pos.test.ts` "rejects insufficient stock" |
| EC-03 | Cao | Đạt | `services/online-ops.ts` (pack, ngưỡng lệch cân 10%) | `online-erp.test.ts` "pack over tolerance..." |
| EC-04 | Cao | Đạt | `src/web/offline.ts`, `pos.ts:254` idempotent `clientUuid` | `pos.test.ts` "is idempotent on clientUuid" (không có e2e offline) |
| EC-05 | Cao | Đạt | `online-payments.ts`, chặn giao khi chưa thu, cron huỷ quá hạn | `online-erp.test.ts` "EC-05", "scheduled: expired awaiting_payment" |
| EC-06 | Cao | Đạt | `online-ops.ts` cancel, `reservations.ts` | `online-erp.test.ts` EC-06 |
| EC-07 | Cao | Đạt | `online-orders.ts` delivery_failed -> redeliver/returned | `online-erp.test.ts` "fail -> redeliver", "return-to-stock" |
| EC-08 | Trung bình | Đạt | `services/promotions.ts` | `promo-engine.test.ts`, `promo-shop.test.ts` |
| EC-09 | Critical | Đạt (HĐ sỉ) | trigger `invoices_issued_immutable/no_delete` (migration 0003); trả hàng -> HĐ điều chỉnh `b2b.ts:491` | `b2b.test.ts` "return after invoicing creates a negative adjustment invoice", `einvoice.test.ts` |
| EC-10 | Trung bình | Thiếu | không có tách đơn con | – |
| EC-11 | Cao | Đạt | `shop/worker/routes/checkout.ts` | `shop-checkout.test.ts`, `e2e/shop.mjs` |
| EC-12 | Cao | Đạt | `routes/quotes.ts` giữ giá báo, cảnh báo biên | `quotes.test.ts` |
| EC-13 | Cao | Đạt | `services/pricing.ts` ưu tiên | `customers.test.ts`, `prices.test.ts` |
| EC-14 | Trung bình | Đạt (không test riêng) | giá vốn theo lô `order_line_lots`, lãi gộp theo lô | gián tiếp `reports.test.ts` |
| EC-15 | Critical | Đạt | `reservations.ts` `swapBadReservations` + cron 08:00 | `reservations.test.ts` |
| EC-16 | Cao | Đạt | `inventory.ts:55-60` doc_qty vs qty; bill loại hàng từ chối | `inventory.test.ts` "records doc vs actual variance", `payables.test.ts` "excluding rejected goods" |
| EC-17 | Cao | Một phần | quét sai/hết hạn/trùng có cảnh báo + log; nhập tay lý do, cảnh báo nhập tay nhiều: không có | `inventory.test.ts` "scan returns unknown_code..." |
| EC-18 | Cao | Một phần | chặn post trùng (`guard.ts`); không khoá nhập/xuất lô khi kiểm kê đang mở | `inventory.test.ts` "double post guard" |
| EC-19 | Trung bình | Một phần | nhập theo thực nhận + lý do `hao_can` ở dòng phiếu; không có chỉnh quy đổi theo lô | `inventory.test.ts` receipt variance |
| EC-20 | Cao | Đạt | `inventory.ts:369-410` ngưỡng `approval.count_diff_vnd` -> duyệt (quản lý/chủ) | `inventory.test.ts` "count diff above threshold waits for approval" |
| EC-21 | Trung bình | Thiếu (chưa áp dụng, 1 cửa hàng) | chuyển kho tức thời giữa vị trí, không trạng thái "đang chuyển" | `inventory.test.ts` transfer (tức thời) |
| EC-22 | Cao | Thiếu | chỉ có cột `products.merged_into`, không có chức năng/route gộp | – |
| EC-23 | Critical | Đạt | `services/debt.ts:100`, `b2b-orders.ts:202`; chỉ chủ duyệt | `b2b.test.ts` (2 test hạn mức/quá hạn) |
| EC-24 | Cao | Đạt | gạch cũ nhất trước, số dư có, sao kê chờ đối chiếu | `debts.test.ts` "allocates oldest-first", "bank transactions" |
| EC-25 | Cao | Đạt | `b2b.ts:491` | `b2b.test.ts` "return after invoicing" |
| EC-26 | Cao | Đạt | `b2b.ts:368-470` | `b2b.test.ts` "partial delivery with a rejection" |
| EC-27 | Trung bình | Đạt (không test riêng) | `b2b.ts:128` đổi địa chỉ sau soạn cần `b2b.approve`; nhiều địa chỉ | – |
| EC-28 | Trung bình | Đạt | `quotes.ts:263` extend (b2b.approve), 409 quote_expired | `quotes.test.ts` |
| EC-29 | Cao | Một phần | chủ duyệt + lý do (`debts.ts:324`); KHÔNG vào lãi lỗ (C-13) | `debts.test.ts` "write-off above threshold is pending; owner approves" |
| EC-30 | Trung bình | Đạt | phiếu nhập tạm -> bill tạm, finalize cần lý do khi lệch giá | `payables.test.ts`, `e2e/b2b.mjs` |
| EC-31 | Cao | Đạt | `debts.ts:763-860` settlements đối soát COD, lệch cần lý do | `debts.test.ts` "settlements", `sec-integrity-finance` "COD clearing" |
| EC-32 | Cao | Đạt | `pos.ts:139` đóng ca lệch cần lý do | `pos.test.ts` "closes the shift: diff requires reason" |
| EC-33 | Critical | Đạt (chỉ khoá sổ quỹ; C-16) | trigger `vouchers_locked_*`, `errors.ts` 423, đảo phiếu ở kỳ hiện tại | `finance.test.ts` "locked period blocks new vouchers", `debts.test.ts:93`, `sec-integrity-pos` |
| EC-34 | Trung bình | Một phần | không có luồng riêng cho hoàn tiền sàn; làm bằng phiếu đảo/điều chỉnh kỳ hiện tại | `finance.test.ts` reverse |
| EC-35 | Cao | Đạt | `competitor-crawler.ts` trạng thái nguồn/blocked/layout_changed | `competitor-crawl.test.ts` |
| EC-36 | Cao | Đạt | lọc outlier, duyệt mới đưa vào so sánh | `competitor-crawl.test.ts` |
| EC-37 | Cao | Đạt | `competitor-matcher.ts` chỉ `suggested`, duyệt từng cặp | `competitor-api.test.ts` |
| EC-38 | Trung bình | Một phần | `version`+409: khách, sản phẩm, báo giá, hồ sơ NV; bảng giá không (C-30) | `customers.test.ts`, `products.test.ts` |
| EC-39 | Cao | Một phần | khoá tài khoản + thu hồi phiên + vai trò đọc từ DB mỗi request; huỷ ca tương lai; chưa chuyển việc đang làm (C-26) | `admin.test.ts` "deactivating a user revokes their sessions (EC-39)", `hr-api.test.ts` |

Tổng: Đạt 29 (EC-14, EC-27 chưa có test riêng; EC-04 chưa có e2e offline), Một phần 7 (EC-17, 18, 19, 29, 34, 38, 39), Thiếu 3 (EC-10, 21, 22). Cả 5 quy tắc Critical (EC-02, 09, 15, 23, 33) đều Đạt.

---------------------------------------------------------------------------------------------------

## (e) Điểm số (thang 10)

- **M9 Nhân sự/lương/chấm công: 6,5/10.** Điểm cộng: toàn bộ luồng Must có thật; ràng buộc DB (punch bất biến, khoá công/lương, chi lương một lần), SoD khi duyệt, giờ VN và ca qua đêm đúng, TNCN/BH 2026 đúng, test dày (hr-*, payroll-*, e2e). Điểm trừ: chấm offline cho công 0 phút (C-01), lương giờ trả OT hai lần (C-03), duyệt lương trên dữ liệu cũ (C-04), tạm ứng vượt lương mất tiền (C-05), phép/ngày lễ sai quy tắc (C-08, C-09, C-15), thiếu cấu hình cửa hàng để chấm GPS (C-07), cảnh báo không hiển thị (C-11). Nhiều điểm là quy tắc [Cần xác nhận], nhưng C-01/03/04 là lỗi chắc chắn.
- **RBAC: 8,5/10.** Deny-by-default, mọi route có guard, ma trận khớp mục 12 gần như hoàn toàn, ẩn giá vốn/PII/lương nhất quán, SoD, vai trò đọc từ DB mỗi request. Trừ điểm vì rò lương qua sổ quỹ xuất Excel (C-02) và vài quyền hơi rộng (C-21, C-22).
- **Yêu cầu chung: 6,5/10.** Audit ghi đầy đủ và bất biến, VN/VND/giờ VN, PWA, Excel; có khoá sổ quỹ, duyệt tập trung, Time Travel. Trừ điểm: sao lưu R2 thiếu nhiều bảng, không dọn, không restore (C-06); thiếu UI nhật ký/cài đặt/khoá sổ (C-16, C-17); thiếu thông báo cho người duyệt (C-27); PDF báo cáo, chính sách lưu giữ dữ liệu; EC-22/EC-10 chưa làm; xoá nợ không vào lãi lỗ (C-13).
