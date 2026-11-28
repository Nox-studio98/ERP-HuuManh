# Audit R2 — lõi: PO, B2B, kho, bảng chấm công & lương (28/11/2026)

Worktree `/home/user/wt-audit2-core` (nhánh `claude/audit2-core`, = origin/main). Chỉ đọc mã + probe test, không sửa mã ứng dụng, không commit.
Probe: `test/probe-k-po.test.ts` (5 test), `test/probe-k-hr.test.ts` (3 test). Chạy `npx vitest run test/probe-k-po.test.ts test/probe-k-hr.test.ts`. **Cả 8 test đều đỏ**, tức lỗi đã tái hiện được (mỗi test khẳng định hành vi đúng).

Không có lỗi Nghiêm trọng. Có 4 lỗi Cao và 4 lỗi Trung bình đã kiểm chứng bằng test. Các lỗi đã sửa trong `docs/audit/*` không bị báo lại; không thấy hồi quy.

## Tóm tắt

| # | Mức | Mảng | Lỗi | Test |
|---|---|---|---|---|
| K-PO1 | Cao | PO | Phần thiếu được "coi như có hàng sắp về" nhưng không liên kết PO nào → hàng về không giữ cho SO, lần chốt sau đặt trùng | ✅ |
| K-B2B1 | Cao | B2B/PO | Giao thất bại rồi xác nhận lại khi đã đủ tồn → dòng thiếu cũ vẫn `open` → chặn giao phần đã giữ, chốt đêm đặt thêm | ✅ |
| K-HR1 | Cao | Chấm công | Quản lý tự chấm công thủ công / tự ghi phép có lương cho chính mình (mất kiểm soát "không tự duyệt") | ✅ |
| K-HR2 | Cao | Chấm công/lương | Quản lý (`hr.schedule`) tự ghi thưởng cho mình qua phạt/thưởng theo ca, không giới hạn (đến 10 tỷ/lần) | ✅ |
| K-PO2 | Trung bình | PO | Chấp nhận đề xuất NCC đẩy PO vượt `approval.po_vnd` mà không cần chủ duyệt | ✅ |
| K-PO3 | Trung bình | PO | PO chưa có giá (total = 0) qua ngưỡng duyệt; thủ kho tự nhập đơn giá khi nhận → hoá đơn mua tuỳ ý | ✅ |
| K-PO1b | Trung bình | PO | Kho có tồn tự do đủ phủ (nhập thường, đơn khác huỷ) nhưng SO vẫn "Chờ hàng", không giao được phần đó, chốt đêm vẫn đặt PO | ✅ |
| K-HR3 | Trung bình | Lương | Bậc công (`hr.workday_tiers`) tính cả giờ tăng ca → lương tháng trả hai lần phần làm thêm | ✅ |

---

## Chi tiết

### K-PO1 — Cao — Phần thiếu bị "che" bởi hàng sắp về nhưng không gắn PO nào
- **File:**
  - `src/worker/services/po.ts:206-215`: vòng `skip` coi các phần thiếu **đứng đầu** theo `need_by` là đã được phủ bởi `incoming`.
  - `src/worker/services/shortages.ts:148-153`: khi nhận hàng, `allocateReceivedToShortages` chỉ giữ cho phần thiếu **liên kết với chính dòng PO** (`l.po_line_id = ?`).
- **Kịch bản:**
  1. SO A giao ngày kia, thiếu 5 kg. Chốt tạo PO1, liên kết A. PO1 được gửi và NCC xác nhận.
  2. SO B tạo sau nhưng giao ngày mai (sớm hơn), thiếu 4 kg. Bấm "Tính lại": `incoming` = 5 nên "che" B (đứng đầu theo `need_by`); PO2 liên kết lại **A** 4 kg, B không gắn PO nào.
  3. Nhận đủ PO1 và PO2: A được giữ đủ, còn B **không được giữ gì** (reserved = 0, dòng thiếu vẫn `open` 4 kg) dù kho còn 4 kg tự do.
- **Hậu quả:**
  - B không giao được (`awaiting_stock`).
  - Lần chốt sau: `incoming` = 0, nên tạo PO thứ ba đặt thêm 4 kg (đặt trùng).
  - Đường thứ hai cùng hệ quả (đọc mã, chưa viết test): sửa dòng của đơn sỉ đã xác nhận gọi `deleteOrderShortagesStmts` (`routes/b2b.ts:157`). Lệnh này xoá cả `po_shortage_links`, đơn xác nhận lại sinh dòng thiếu mới **không liên kết** PO đã gửi → hàng về không giữ cho đơn.
- **Test:** `probe-k-po` › K-PO1 (reserved B = 0, kỳ vọng 4000).
- **Đề xuất:**
  - Khi gom, liên kết phần thiếu với PO đang chạy theo đúng thứ tự `need_by`: phân bổ `incoming` theo các link hiện có, phần thiếu chưa có link thì nhận phần dư.
  - Hoặc đơn giản hơn: nhận hàng xong thì giữ cho **mọi** phần thiếu mở của sản phẩm (theo `need_by`, rồi thời điểm tạo), không chỉ phần thiếu có link. Giới hạn bằng số vừa nhận cộng tồn tự do.
  - Khi sửa đơn: chuyển link sang dòng thiếu mới thay vì xoá.

### K-B2B1 — Cao — Dòng thiếu cũ không đóng khi xác nhận lại đơn giao thất bại
- **File:**
  - `src/worker/routes/b2b.ts:518-531` (`/deliveries/:id/fail`): nhả giữ hàng nhưng không đụng `so_shortages`.
  - `src/worker/services/b2b-orders.ts:250-269` (`confirmOrderFlow`): `shortageUpsertStmts` chỉ ghi các dòng **còn** thiếu, dòng nay đã đủ hàng không được đóng.
  - `src/worker/routes/b2b.ts:407-416`: chặn giao theo `qty − awaiting`.
- **Kịch bản:**
  1. Tồn 3 kg, SO 5 kg → giữ 3, thiếu 2.
  2. Soạn hàng, rồi giao thất bại.
  3. Nhập thêm 10 kg, xác nhận lại đơn: giữ **đủ 5 kg**, nhưng dòng thiếu 2 kg vẫn `open`.
- **Hậu quả:**
  - Chi tiết đơn báo `awaitingStock = true`, `shortMilli = 2000`.
  - Xác nhận giao 5 kg bị 409 `awaiting_stock`, chỉ giao được 3 kg.
  - Job chốt đêm vẫn đặt PO 2 kg (đơn `delivery_failed` vẫn nằm trong nguồn nhu cầu).
  - Nếu PO cũ về, hàng còn bị giữ thêm cho đơn vượt số đặt.
- **Test:** `probe-k-po` › K-B2B1.
- **Đề xuất:** trong `confirmOrderFlow` (và `online-ops` confirm), cùng batch: đóng (`filled`/`cancelled`) các dòng thiếu mở của đơn **không** có trong `short`. Hoặc gọi `closeOrderShortagesStmt` trước `shortageUpsertStmts`, vì upsert sẽ mở lại đúng dòng còn thiếu.

### K-HR1 — Cao — Tự chấm công / tự ghi phép cho chính mình
- **File:** `src/worker/routes/hr-board.ts:182` (`POST /attendance/manual`) chỉ có `requirePerm("hr.schedule")`, không gọi `assertNotSelf`. Các luồng duyệt cũ đều có kiểm này (`routes/hr.ts:47-57`, dùng ở 657, 944, 1004, 1224).
- **Kịch bản:** user vai trò `manager` có liên kết nhân viên tự gửi:
  - `targets:[{employeeId: <mình>, workDate}]`, `type:"work"`, `06:00–20:00` → 200, ghi punch `manual` `accepted`.
  - `type:"paid_leave"` → 200, tạo `leave_requests` `approved` do chính mình duyệt (bỏ qua cả số dư phép, chỉ gắn cờ `over_balance`).
- **Hậu quả:** quản lý tự cộng giờ công, tăng ca (tự tính) và phép có lương cho mình. Đây là đúng lỗ hổng mà C-01, C-08 và `assertNotSelf` đã chặn ở luồng duyệt.
- **Test:** `probe-k-hr` › K-HR1 (200, kỳ vọng 403).
- **Đề xuất:**
  - Gọi `assertNotSelf(c, { employeeIds: [...targets.employeeId, substituteEmployeeId] })` cho `/attendance/manual`, `/schedule/:id/reassign` và `/attendance/incidents` (+ void). Chủ cửa hàng được miễn.
  - Cân nhắc xuất `assertNotSelf` ra `hr-common.ts` để dùng chung.

### K-HR2 — Cao — Tự ghi thưởng không giới hạn qua phạt/thưởng theo ca
- **File:** `src/worker/routes/hr-board.ts:439-470`. Có ba thiếu sót:
  - Không kiểm "không tự ghi cho mình".
  - `amountEach` do người ghi tự nhập (≤ 100 triệu) và `times` ≤ 100, nên một lần ghi có thể tới 10 tỷ.
  - Không có ngưỡng duyệt.
- **Phạm vi quyền:** khoản thưởng vào thẳng phiếu lương (`routes/payroll.ts:186-190`, `taxable: true`). Quản lý vốn **không** có `payroll.write`/`hr.sensitive`, nhưng `hr.schedule` cho phép ghi tiền thưởng.
- **Kịch bản:** quản lý ghi `attendance/incidents` loại thưởng cho chính mình, `times: 100`, `amountEach: 100_000_000` → 201.
- **Test:** `probe-k-hr` › K-HR2.
- **Đề xuất:**
  - Chặn tự ghi cho mình (như K-HR1).
  - Với người không có `payroll.write`: chỉ dùng `default_amount` của loại, hoặc giới hạn `amountEach` ≤ `default_amount`. Khoản vượt ngưỡng (tham số mới) cần duyệt.
  - Phiếu lương nên ghi rõ người ghi thưởng để chủ thấy khi duyệt.

### K-PO2 — Trung bình — Đề xuất NCC vượt ngưỡng duyệt
- **File:** `src/worker/services/po.ts:630-645` (`decideProposal` accept). Chỉ `approvePo` (`po.ts:469-473`) xét `approval.po_vnd`. `recomputeTotalStmt` có tính lại tổng nhưng không kiểm ngưỡng.
- **Kịch bản:**
  1. Quản lý duyệt PO 15 triệu → `sent`.
  2. NCC đề xuất SL ×3, giá 200.000 → 60 triệu.
  3. Quản lý (`purchasing.approve`, không có `approve_high`) chấp nhận → `confirmed`, total 60 triệu, không cần chủ.
- **Test:** `probe-k-po` › K-PO2 (200, total 60.000.000).
- **Đề xuất:** khi chấp nhận đề xuất, nếu tổng mới > ngưỡng và người duyệt không có `purchasing.approve_high` (và tổng tăng so với lúc duyệt) → tạo approval `purchase_order.approve` (hoặc 409 `owner_approval_required`). Áp dụng tương tự cho NCC `confirm` khi `confirmed_unit_cost` khác giá đặt.

### K-PO3 — Trung bình — PO không giá lọt ngưỡng, giá do người nhận tự nhập
- **File:**
  - `po.ts:76`: `lineValue` coi giá NULL là 0.
  - `po.ts:469-470`: ngưỡng so trên `po.total`.
  - `po.ts:695`: `l.unitCost ?? confirmed ?? unit_cost` — thủ kho (`purchasing.write` + `inventory.write`) tự nhập đơn giá khi nhận.
- **Kịch bản:**
  1. Tạo PO 1.000 kg cho mặt hàng chưa có lô (giá NULL) → total 0.
  2. Quản lý duyệt (không xét ngưỡng), NCC xác nhận.
  3. Thủ kho nhận với `unitCost` 90.000 → hoá đơn mua 90 triệu, công nợ phải trả tương ứng, không qua chủ.
  - Ngay cả khi PO có giá đã chốt, `unitCost` khi nhận vẫn ghi đè giá chốt mà không cần quyền nào thêm.
- **Test:** `probe-k-po` › K-PO3 (bill 90.000.000).
- **Đề xuất:**
  - Không cho duyệt/gửi PO còn dòng chưa có giá (hoặc bắt buộc giá trước khi `approve`).
  - Khi nhận: chỉ cho `unitCost` khác giá chốt nếu người nhận có `purchasing.approve`. Nếu không thì ghi chênh lệch và để hoá đơn mua tạm tính chốt lại theo B-09, hoặc yêu cầu duyệt khi tổng vượt ngưỡng.

### K-PO1b — Trung bình — Tồn tự do không phủ phần thiếu
- **File:**
  - `po.ts:186-188`: nhu cầu = Σ thiếu − incoming, không trừ tồn khả dụng.
  - `shortages.ts`: chỉ nhận theo PO mới giữ hàng.
  - `b2b.ts:414-416`: chặn giao phần "chờ hàng" ngay cả khi tồn tự do có sẵn.
- **Kịch bản:** SO thiếu 5 kg, rồi hàng về 5 kg qua phiếu nhập thường (hoặc đơn khác huỷ, nhả 5 kg). Kết quả:
  - Đơn vẫn `awaitingStock = true`.
  - Giao phần đó bị 409.
  - "Chốt ngay" vẫn tạo PO 5 kg.
- **Lối thoát hiện có:** sửa dòng đơn để đơn về `new` rồi xác nhận lại. Nhưng làm vậy mất link PO (xem K-PO1).
- **Test:** `probe-k-po` › K-PO1b.
- **Đề xuất:**
  - Ở job chốt (và sau mỗi phiếu nhập thường / nhả giữ), chạy bước "giữ lại cho phần thiếu" từ tồn tự do theo `need_by` trước khi tính nhu cầu.
  - Hoặc thêm nút "Giữ lại hàng" trên đơn chờ hàng.
  - Tài liệu `PO-NCC.md` 4.2 nên nói rõ nhu cầu có trừ tồn khả dụng hay không.

### K-HR3 — Trung bình — Bậc công tính cả giờ tăng ca (trả hai lần)
- **File:**
  - `src/worker/services/hr-timesheet.ts:434`: `tierUnitsX10(r.workedMinutes, …)`, trong đó `workedMinutes` gồm cả phần chấm ngoài ca.
  - `src/worker/services/payroll-calc.ts:163-165`: lương tháng dùng Σ bậc công, còn tăng ca vẫn trả riêng ở `:210-223`.
  - So sánh: chế độ `proportional` trừ OT (`regular = worked − overtime`, `:156`) và lương giờ cũng trừ (C-03).
- **Kịch bản:**
  - Thiết lập: lương 26 triệu/26 ngày, ca 08–16, chấm 08–18, tăng ca đã duyệt 120 phút, bậc `240:5,480:10,600:15`.
  - Kết quả: ngày được 1,5 công (base 1.500.000) **và** tăng ca 2 giờ × 1,5 (375.000).
  - Đúng ra: 1 công + 375.000, hoặc 1,5 công và không trả OT.
- **Test:** `probe-k-hr` › K-HR3.
- **Đề xuất:** quy đổi bậc trên `max(0, worked − overtimeMinutes)` (giờ thường). Nếu chủ muốn "10 giờ = 1,5 công" thay cho OT thì phải bỏ OT ngày đó. Cần chủ chốt một trong hai, rồi ghi vào `API-attendance-board.md` mục 3.

---

## Nghi ngờ / rủi ro nhỏ (chưa viết test, hoặc cần xác nhận nghiệp vụ)
1. **Thấp — bậc công + phép cùng ngày không giới hạn 1 ngày:** `payroll-calc.ts:165` dùng `tierWorkX10 + leaveX10` mà không cắt theo từng ngày (chế độ proportional có `Math.min(10, …)`). Ngày nghỉ phép cả ngày mà vẫn có chấm công thì được tính > 1 ngày; chỉ bị chặn bởi trần ngày chuẩn của cả kỳ.
2. **Thấp — chấm phép hàng loạt bỏ qua số dư:** `hr-board.ts:322-324` tính `over_balance` cho từng ô từ số dư đọc trước batch. Chọn nhiều ngày phép năm của cùng một NV thì ô nào cũng thấy còn phép, nên cờ `over_balance` không bật cho phần vượt.
3. **Thấp — tạm ứng: kiểm giới hạn luỹ kế rồi mới ghi, không nằm trong cùng batch** (`payroll.ts:598-620`). Hai yêu cầu đồng thời có thể cùng lọt `hr.advance_max_bp`. Nên đặt `assertStmt` tổng tạm ứng ở đầu batch.
4. **Thấp — `approvalRejectStmts` (`po.ts:510-515`) không có `assertStmt`:** PO không còn `pending_approval` thì `UPDATE` khớp 0 dòng nhưng approval vẫn bị đánh dấu từ chối và ghi audit "approval_rejected". Đây đúng là bẫy ghi trong CLAUDE.md.
5. **Cần xác nhận — "Tính lại" / job 03:00 ghi đè PO nháp tự động đã được người lập sửa tay** (`po.ts:236-243` xoá và ghi lại các dòng). Giá đã điền tay bị thay bằng giá lô gần nhất, hoặc NULL. Nên giữ `unit_cost` hoặc dòng đã sửa, hoặc ít nhất cảnh báo.
6. **Thấp — cron đơn lặp:** `recurring-cron.ts:54` đánh dấu `last_generated_for` sau `createB2bOrder`. Nếu tạo đơn lỗi giữa chừng, lần chạy sau dựa vào `clientUuid` để không tạo trùng. Đã đọc nhưng chưa tái hiện được lỗi; ghi lại để rà khi có cron chạy nhiều lần.

## Đã rà và không thấy lỗi mới
- Chốt đêm chạy đồng thời / chạy hai lần: `onceStmt` (auto), index duy nhất `uq_po_nightly_draft` kèm thử lại, khớp ngày chốt giữa "Chốt ngay" và 03:00.
- Nhận PO đồng thời: assert version + `received_milli`. Khoá sổ. Nhận vượt bị 422. Huỷ PO khi đã nhận một phần bị chặn, phải dùng đóng PO.
- Hạn mức nợ đồng thời khi xác nhận đơn sỉ (assert tổng cam kết). EC-23 tính trên toàn đơn.
- Phạt/thưởng: khoá kỳ lương `approved/paid` có cả trigger DB. `payroll_stale` gồm phạt/thưởng. Đảo chi lương.
- `computeEmployeeTimesheet` vẫn là công thức duy nhất (board, live, snapshot). Ca qua đêm thuộc ngày vào. NV vào/nghỉ giữa tháng (`inRange`).
- Mảng kho lõi (FEFO, cách ly, kiểm kê, chuyển kho, gộp mã, giỏ quà, B-09) chỉ rà phần giao với PO: phiếu nhập theo PO tạo lô và hoá đơn mua cùng dạng phiếu nhập thường, nên B-09 vẫn áp dụng được. Chưa rà sâu lại từng luồng kho vì các luồng này không đổi kể từ đợt 8.

---

## Kho lõi (bổ sung theo yêu cầu điều phối)

Probe: `test/probe-k-kho.test.ts` (4 test). Chạy `npx vitest run test/probe-k-kho.test.ts`. Cả 4 đều đỏ, tức lỗi tái hiện được.

| # | Mức | Lỗi | Test |
|---|---|---|---|
| K-KHO1 | Trung bình | Chốt hoá đơn mua khác giá (B-09) sau khi đã chuyển kho: phần đang nằm ở kho đích bị tính là "đã bán", vào giá vốn; lô đích giữ giá cũ | ✅ |
| K-KHO2 | Trung bình | Cách ly lô / hết hạn đang giữ cho đơn sỉ, không có lô thay: nhả giữ nhưng không ghi phần thiếu → đơn không "Chờ hàng", chốt đêm không đặt, đến lúc giao mới 409 | ✅ |
| K-KHO3 | Trung bình | Gộp mã trùng (EC-22) không chuyển PO đang chạy / phần thiếu → nhận PO tạo lô vào mã nguồn đã gộp (ngừng kinh doanh) | ✅ |
| K-KHO4 | Thấp | Lắp giỏ quà không kiểm khoá sổ: phiếu ghi được vào kỳ đã khoá | ✅ |

### K-KHO1 — Trung bình — B-09 bỏ sót lô đã chuyển kho
- **File:** `src/worker/routes/debts.ts:247-290` chỉ lấy lô theo `stock_doc_lines.lot_id` của phiếu nhập. Chuyển kho 2 bước (`routes/inventory.ts:641-712`) tạo **lô mới** ở vị trí đích (cùng `receipt_doc_id`), lô này không nằm trong `stock_doc_lines`. Phần đã chuyển làm `on_hand` của lô nguồn giảm, nên bị coi là đã bán.
- **Kịch bản:**
  1. Nhập 10 kg giá 10.000, chuyển 6 kg sang vị trí 2 và nhận đủ.
  2. Chốt hoá đơn tổng 120.000 (+20.000).
  3. Kết quả: lô nguồn (4 kg) lên 12.000; lô đích (6 kg) vẫn 10.000; `purchase_cost_adjustments.cogs_amount` = 12.000 vào "Chênh lệch giá mua" (giá vốn) dù chưa bán gì.
- **Hậu quả:** lãi lỗ kỳ chốt bị trừ oan; tồn kho định giá thấp; khi bán lô đích thì giá vốn thấp hơn thực tế (lệch kéo sang kỳ sau). Trả hàng NCC theo lô đích sau đó cũng dùng giá cũ.
- **Đề xuất:** phân bổ phần chênh lệch cho mọi lô có `receipt_doc_id` = phiếu nhập (gồm các lô sinh ra do chuyển kho, theo `on_hand` hiện tại), hoặc lần theo `stock_doc_lines.received_lot_id` của phiếu chuyển. Chỉ phần thực sự đã xuất bán / hao hụt mới vào giá vốn.

### K-KHO2 — Trung bình — Đổi lô giữ (EC-15/A-17) không nối với phần thiếu PO
- **File:** `src/worker/services/reservations.ts:208-234` (`swapBadReservations`): phần không thay được chỉ ghi `orders.reservation_short_milli` và thông báo, không ghi `so_shortages`. Hàm này dùng cho cả cách ly lô và cron hết hạn 00:00 (`scheduled.ts:61-66`).
- **Kịch bản:**
  1. Đơn sỉ 5 kg giữ trên lô duy nhất, cách ly lô.
  2. Kết quả: giữ = 0, `so_shortages` rỗng; chi tiết đơn `awaitingStock = false`; "Chốt ngay" không tạo dòng PO nào.
  3. Lúc xác nhận giao, `consumeForDeliveryStmts` thiếu → `allocateFefo` 409 `insufficient_stock`.
- **Hậu quả:** PO tự động (đợt mới) không biết đơn cần hàng; đơn hiện "sẵn sàng" mà không giao được.
- **Đề xuất:** khi `missingMilli > 0` cho đơn có `allow_short_confirm` (sỉ / online đặt trước), upsert `so_shortages` cho `order_line_id` (cộng vào `qty_milli`, `need_by` = ngày giao) trong cùng batch.

### K-KHO3 — Trung bình — Gộp mã bỏ sót PO, phần thiếu và đơn `delivery_failed`
- **File:** `src/worker/routes/products.ts:220-250` không cập nhật các thứ sau:
  - `purchase_order_lines` (PO nháp / đang chạy);
  - `so_shortages.product_id`;
  - `order_lines` của đơn `delivery_failed`: không nằm trong `openStatuses`, trong khi lô đã chuyển sang mã đích nên xác nhận lại sẽ tìm tồn của mã nguồn.
- **Kịch bản:**
  1. SO thiếu 4 kg mã A, PO cho A được NCC xác nhận.
  2. Gộp A vào B.
  3. Nhận PO: lô mới `product_id` = A (đã `merged_into`, `active = 0`). Phần thiếu vẫn mang mã A, giữ trên lô A, trong khi dòng đơn đã là B.
  4. Lần chốt sau: phần thiếu / nhu cầu mã A không còn NCC (đã chuyển `product_suppliers`) → rơi vào "Thiếu chưa có NCC".
- **Đề xuất:**
  - Trong batch gộp, cập nhật thêm `purchase_order_lines` (PO chưa `received/closed/cancelled`; xử lý trùng `UNIQUE(po_id, product_id)` bằng cộng dồn hoặc chặn gộp) và `so_shortages` (đang mở).
  - Thêm `delivery_failed` vào `openStatuses`.
  - Hoặc chặn gộp khi mã nguồn còn PO đang chạy.

### K-KHO4 — Thấp — Lắp giỏ quà bỏ qua khoá sổ
- **File:** `src/worker/routes/promo-bundles.ts:107-162` không gọi `assertPeriodOpen`, trái quy ước CLAUDE.md "mọi chứng từ có ngày".
- **Kịch bản:** khoá kỳ hiện tại, gửi `POST /assembly-orders` → 201 `posted`. Thẻ kho `assemble_out/in` và giá vốn lô giỏ ghi vào kỳ khoá.
- **Phụ:** `expiresAt` do người dùng nhập không bị giới hạn ≤ hạn sớm nhất của thành phần.
- **Đề xuất:** gọi `assertPeriodOpen(db, new Date(), "lệnh đóng giỏ quà")` và chặn `expiresAt` > `plan.earliestExpiry`. Chức năng **tháo giỏ** không có trong mã (chỉ có lắp).

### Nghi ngờ (kho)
- **Trả hàng NCC một phần** (`purchase-returns.ts`): chỉ giảm công nợ phần tiền hàng, không giảm `vat_amount` của hoá đơn → VAT đầu vào khai thừa với phần đã trả. Khi trả toàn bộ thì hoá đơn bị huỷ nên đúng. Cần kế toán xác nhận cách hạch toán.
- Lô sinh ra do chuyển kho copy `qty_in_milli` của **cả** lô nguồn (`inventory.ts:684`). Cố ý để tính % hao hụt, nhưng làm lệch điều kiện "trả đủ" (`full`) của trả hàng NCC và phần `qty_in` dùng trong B-09.

### Đã rà, không thấy lỗi mới (kho)
- FEFO (`allocateFefoPartial`): loại lô hết hạn / cách ly / bị khoá kiểm kê; gộp theo sản phẩm; CHECK chặn bán đồng thời.
- Cách ly: assert + đổi lô ngay; nhả cách ly cần `inventory.approve`.
- Kiểm kê:
  - snapshot `doc_qty_milli`, `count_stale`, cảnh báo lô biến động;
  - giá trị chênh lệch theo trị tuyệt đối;
  - người lập không có quyền thì chờ duyệt; duyệt tính lại;
  - nhập Excel có assert snapshot từng lô.
- Chuyển kho 2 bước: `onceStmt` + assert khi nhận, nhận thiếu ghi hao hụt có lý do, ngưỡng.
- Hao hụt / điều chỉnh / xuất dùng nội bộ: kiểm lô khoá kiểm kê, lô `active` (B-N5 đã sửa), ngưỡng duyệt, khoá sổ.
- Trả hàng NCC: đúng lô của phiếu nhập, assert tồn khả dụng, huỷ hoá đơn khi trả hết và chưa trả tiền, ngưỡng duyệt hai cấp.
- Đồng thời: post / huỷ phiếu kho có `stock_doc_post_guard` + assert trạng thái; đổi lô giữ có assert từng reservation.
