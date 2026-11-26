# Bảng chấm công dạng lưới — hợp đồng API và thiết kế

> **Thay đổi so với bản đầu (backend đã làm xong, khớp mã nguồn):** không đổi hình dạng response nào; chỉ bổ sung/chốt chi tiết:
> - Mặc định `hr.unscheduled_punch` = `allow` (giữ cách chạy cũ), không phải `approve`. Chỉ áp dụng ở chế độ `shift`; `off` chỉ chặn lần **vào** (mã `422 no_shift`).
> - Nhóm cài đặt mới tên **"Chấm công"** (nằm sau "Nhân sự & lương"). Mỗi item trong `GET /settings` có thêm `format`: `"time"` (HH:MM, `allowEmpty` với giờ nghỉ), `"tiers"` (`hr.workday_tiers`), hoặc `null`; `type` vẫn là `text` cho các khoá này.
> - `hr.ot_auto` cùng đơn tăng ca đã duyệt: OT ngày = **số lớn hơn** của hai nguồn (không cộng dồn, tránh trả hai lần); cộng vào `overtimeMinutes` rồi làm tròn xuống.
> - Mỗi ngày trong bảng công có thêm `workUnitsX10` (null = chưa bật bậc công) và `autoShifts`; `totals.workUnitsX10`. Bảng `timesheet_days` có cột `work_units_x10` (NULL ở kỳ chốt trước khi bật bậc công → lương giữ cách cũ).
> - `POST /attendance/manual` `work`: chỉ thay các lần chấm **cùng loại** (vào/ra) với giờ được gửi; bỏ trống một giờ thì lần chấm loại kia giữ nguyên. Không cho chấm thời điểm chưa tới (`422 future_time`). Lỗi: `mixed_shifts`, `mixed_targets`, `time_required`, `leave_overlap` (đã có đơn nghỉ khác loại), `substitute_busy`. Response ô có thêm `substituteForEmployeeId`. Khi có người làm thay, `cells` gồm cả ô của người làm thay. `updated` = số ô thực sự thay đổi (0 khi lặp lại y hệt).
> - `POST /schedule/:id/reassign` trả `{id, employeeId, employeeName, workDate, shiftTemplateId, shiftName, startAt, endAt, status}`; chặn: `has_punches` (có lần chấm accepted/pending), `has_incidents`, `employee_busy`, `duplicate`.
> - `GET /attendance/cell` trả `corrections`, `incidents` (có `voided`), `history` (audit; thao tác chấm tay ghi `entity='attendance_cell'`, `entity_id=<key ô>`). Ô ngoài lịch chưa có dữ liệu được trả dạng ô trống thay vì 404.
> - `POST /attendance/incidents` trả `{id, employeeId, workDate, assignmentId, typeId, typeName, kind, times, note, voided, amountEach?, amount?}`; kỳ lương `approved/paid` → `409 payroll_locked` (cả khi huỷ; có trigger DB). Loại không hoạt động → `422 incident_type_inactive`. `defaultAmount` của loại chỉ trả cho người có `hr.sensitive`/`hr.schedule` (còn lại `null`).
> - Lương: phạt/thưởng chưa huỷ vào `penalties`/`bonus` (mỗi dòng một diễn giải); `inputs_hash` chỉ thêm phạt/thưởng khi có (hash các kỳ cũ không đổi). Bậc công chỉ áp dụng cho NV lương tháng và chỉ khi mọi ngày của kỳ đã chốt kèm `work_units_x10`.


Mục tiêu: màn **Bảng chấm công** kiểu KiotViet (lưới ca × ngày, ô tô màu theo trạng thái, bấm ô để chấm/sửa, chọn nhiều ô để chấm hàng loạt, phạt/thưởng theo ca) thay cho hai màn *Lịch ca* và *Duyệt chấm công*. Màn *Bảng công* (chốt kỳ theo tháng) giữ nguyên.

Quy ước như `docs/API-dot4.md`: base `/api/v1`, camelCase, tiền VND nguyên, ngày `YYYY-MM-DD` giờ VN, mọi ghi nhiều dòng trong **một** `db.batch` kèm `auditStmt`, kiểm tra-rồi-làm dùng `assertStmt`, kỳ công đã chốt → `assertPeriodsOpen` (409/423 như hiện có). Schema: `migrations/0031_attendance_board.sql`.

**Không phá vỡ:** nhật ký chấm công (`attendance_punches`) vẫn bất biến. "Sửa giờ" của quản lý = đánh dấu các lần chấm cũ của ca là `rejected` (note `replaced_by_manual`, decided_by) + thêm lần chấm mới method `manual` status `accepted`, cùng một batch, có audit. Mọi API cũ giữ nguyên.

---
## 1. Trạng thái ô (dùng chung backend/frontend)

Mỗi **ô** = một ca đã xếp (`shift_assignments` status `scheduled`) của một nhân viên trong một ngày, hoặc một **ô ngoài lịch** (có lần chấm nhưng không gắn ca nào).

| `status` | Nhãn (chú thích màu) | Điều kiện |
|---|---|---|
| `on_time` | Đúng giờ | có vào và ra, late = 0, early = 0 |
| `late_early` | Đi muộn / Về sớm | có vào và ra, late > 0 hoặc early > 0 (sau ân hạn) |
| `incomplete` | Chấm công thiếu | chỉ có vào hoặc chỉ có ra (ca đã kết thúc), hoặc có lần chấm đang chờ duyệt |
| `not_yet` | Chưa chấm công | không có lần chấm nào, ca đã bắt đầu |
| `leave` | Nghỉ làm | có đơn nghỉ đã duyệt phủ ngày đó (`leaveCode`, `leavePaid`) |
| `auto` | Đúng giờ (tự động) | `hr.auto_attendance=1`, ca đã kết thúc, không có lần chấm → tính đủ giờ theo lịch |
| `upcoming` | (chưa tới giờ) | ca chưa bắt đầu, chưa có lần chấm |
| `working` | Đang làm | có vào, chưa ra, ca chưa kết thúc |

Màu (token trong `app.css`, thêm mới nếu thiếu): on_time = xanh dương nhạt, late_early = tím, incomplete = đỏ, not_yet = cam, leave/upcoming = xám, auto = xanh dương nhạt có viền đứt, working = xanh lá.

## 2. API mới — `routes/hr.ts` (hoặc file mới `routes/hr-board.ts` gắn vào cùng router)

| Method | Path | Quyền | Request → Response |
|---|---|---|---|
| GET | /attendance/board?from=&to=&q=&storeId= | hr.view | Lưới. `from..to` ≤ 42 ngày. Response dưới đây. |
| GET | /attendance/cell?assignmentId= hoặc ?employeeId=&workDate= | hr.view | Chi tiết một ô: `{cell, punches:[{id, kind, at, method, status, note, createdByName, decidedByName, decidedAt}] (gồm cả rejected — "Lịch sử chấm công"), corrections:[...], incidents:[...], history:[{at, action, byName, detail}] (từ audit_log của ca/punch/incident)}` |
| POST | /attendance/manual | hr.schedule | Chấm công thủ công, **một hoặc nhiều ô cùng lúc** (xem 2.1) |
| POST | /schedule/:id/reassign | hr.schedule | Đổi ca trực tiếp (quản lý): `{employeeId, reason}` → đổi `employee_id` của ca (chỉ khi ca chưa có lần chấm accepted; NV mới không trùng ca cùng ngày) |
| GET | /attendance/incident-types?kind= | hr.view | `{items:[{id, kind, name, defaultAmount, active}]}` |
| POST | /attendance/incident-types | hr.manage | `{kind, name, defaultAmount}` |
| PUT | /attendance/incident-types/:id | hr.manage | `{name?, defaultAmount?, active?}` |
| POST | /attendance/incidents | hr.schedule | `{employeeId, workDate, assignmentId?, typeId, times, amountEach?, note?}` → amount = times × (amountEach ?? defaultAmount). Kỳ lương của work_date đã `approved/paid` → 409 `payroll_locked` |
| POST | /attendance/incidents/:id/void | hr.schedule | `{reason}` (≥ 3 ký tự) |
| GET | /attendance/incidents?from=&to=&employeeId=&kind= | hr.view | Danh sách (cho Xuất file "Tổng phạt vi phạm / thưởng") `{items:[{id, employeeId, employeeName, workDate, shiftName, kind, typeName, times, amountEach, amount, note, createdByName, createdAt, voided}], totals:{penalty, bonus}}` |

**Số tiền phạt/thưởng** là dữ liệu lương: `amount`, `amountEach`, `totals` chỉ trả khi người xem có `hr.sensitive` **hoặc** `hr.schedule` (quản lý ca cần thấy để ghi phạt). Người chỉ có `hr.view` thấy loại và số lần, không thấy tiền.

### 2.0 GET /attendance/board — response
```json
{
  "from": "2026-11-23", "to": "2026-11-29", "today": "2026-11-25",
  "mode": "shift",                       // hr.attendance_mode
  "shifts": [{"id": 1, "name": "Ca sáng", "startTime": "06:00", "endTime": "14:00", "active": true}],
  "employees": [{"id": 3, "code": "NV-0003", "name": "Lê Minh", "position": "Bán hàng"}],
  "cells": [{
    "key": "a:123",                       // a:<assignmentId> hoặc u:<employeeId>:<workDate> (ô ngoài lịch)
    "assignmentId": 123, "employeeId": 3, "workDate": "2026-11-25", "shiftId": 1,
    "startAt": "...Z", "endAt": "...Z",
    "inAt": "...Z", "outAt": null,        // giờ hiệu lực của lần vào đầu / ra cuối được chấp nhận
    "status": "working",
    "lateMinutes": 0, "earlyMinutes": 0, "otMinutes": 0, "workedMinutes": 0,
    "pending": 1,                         // số lần chấm / yêu cầu bổ sung đang chờ duyệt của ô
    "leaveCode": null, "leavePaid": null,
    "substituteForId": null,
    "incidents": {"penalty": 0, "bonus": 0},   // số lần; tiền chỉ khi có quyền (amountPenalty, amountBonus)
    "manual": false                       // có lần chấm thủ công
  }],
  "pendingTotal": 4,                      // tổng việc chờ duyệt (punch pending + reviewFlag + bổ sung công + nghỉ phép + tăng ca + thiết bị) → nút "Duyệt chấm công (4)"
  "periodsClosed": ["2026-10"]            // kỳ đã chốt trong khoảng → ô chỉ xem
}
```
Tính `status/late/early/worked/ot` **dùng lại** `computeEmployeeTimesheet` (`services/hr-timesheet.ts`) cho từng ca — không viết công thức thứ hai. Cần mở rộng hàm để trả kết quả theo từng ca (vd. thêm `perAssignment` vào kết quả), giữ nguyên tổng theo ngày.

Chế độ `window`: không có ca → mỗi NV mỗi ngày có lần chấm là một ô `u:` với giờ chuẩn = khung giờ; `shifts` trả một dòng ảo `{id: 0, name: "Khung giờ làm việc", startTime: hr.window_start, endTime: hr.window_end}`.

### 2.1 POST /attendance/manual
```json
{
  "targets": [{"assignmentId": 123}, {"employeeId": 4, "workDate": "2026-11-25"}],   // 1..50 ô; cùng ca nếu > 1 (như KiotViet)
  "type": "work" | "paid_leave" | "unpaid_leave",
  "inTime": "08:00", "outTime": "12:00",       // giờ VN; bỏ trống một trong hai = chỉ chấm vào/ra
  "applyLate": true, "applyEarly": true, "applyOt": true,   // tắt = không tính đi muộn / về sớm / làm thêm cho ô này (ghi vào punch note, timesheet tôn trọng)
  "substituteEmployeeId": 7,                    // chỉ khi type là nghỉ và 1 ô: tạo ca cho người làm thay (substitute_for_id)
  "note": "Quên mang điện thoại"                // bắt buộc ≥ 3 ký tự
}
```
- `work`: với mỗi ô, các lần chấm accepted/pending hiện có → `rejected` (note `replaced_by_manual`), thêm punch `manual` `accepted` cho vào/ra (giờ = workDate + inTime theo giờ VN; outTime < inTime → hôm sau), `assignment_id` = ca, `created_by`, note. Không thay đổi nếu giờ y hệt (idempotent).
- `paid_leave` / `unpaid_leave`: tạo `leave_requests` status `approved` (loại phép đầu tiên có `paid=1` / `paid=0`, `days_x10` = 10, decided_by = người làm), ca giữ nguyên (ô thành `leave`). Phép năm vượt số dư → vẫn ghi, `over_balance=1`.
- Một batch cho tất cả ô, `assertPeriodsOpen` mọi workDate, `auditStmt` action `attendance.manual` mỗi ô.
- Response `{updated: n, cells: [cell...]}` (ô sau khi cập nhật, cùng dạng board).

## 3. Thiết lập nâng cao (tham số mới — khai báo trong `settings-registry.ts`, nhóm "Chấm công")

| Khoá | Kiểu | Ý nghĩa |
|---|---|---|
| `hr.attendance_mode` | enum `shift`/`window` | Theo ca làm việc / Theo khung giờ làm việc |
| `hr.window_start`, `hr.window_end` | giờ `HH:MM` | Khung giờ (chế độ window) |
| `hr.window_break_start`, `hr.window_break_end` | giờ hoặc trống | Nghỉ giữa giờ: trừ khỏi giờ làm; không tính muộn/sớm trong giờ nghỉ |
| `hr.early_grace_minutes` | int phút | Ân hạn về sớm (đối xứng `hr.late_grace_minutes`) |
| `hr.ot_auto` | bool | Bật: làm thêm tính tự động từ giờ chấm ngoài ca, không cần đơn tăng ca |
| `hr.ot_min_before_minutes`, `hr.ot_min_after_minutes` | int phút | Ngưỡng tối thiểu để tính làm thêm trước/sau ca (khi `hr.ot_auto`) |
| `hr.workday_tiers` | chuỗi `phút:công×10,...` hoặc trống | Quy đổi giờ làm trong ngày → số công (vd `240:5,480:10,600:15` = từ 4 giờ được 0,5 công, từ 8 giờ 1 công, từ 10 giờ 1,5 công; dưới mức đầu = 0). Trống = tắt (giữ cách tính hiện tại) |
| `hr.auto_attendance` | bool | Ca đã qua không có lần chấm → tính đủ giờ theo lịch (ô `auto`) |
| `hr.unscheduled_punch` | enum `off`/`approve`/`allow` | Chấm khi không có ca: không cho / cho nhưng chờ duyệt / ghi nhận ngay |

Tác động tính công (`computeEmployeeTimesheet`, có test cho từng quy tắc):
- `early = max(0, end − out − hr.early_grace_minutes)`.
- `hr.ot_auto=1`: ot ngày = Σ(phần trước ca nếu ≥ before) + Σ(phần sau ca nếu ≥ after), cộng với tăng ca đã duyệt, làm tròn xuống `hr.rounding_minutes`; giờ làm thêm **không** cộng vào worked (như hiện tại: worked tính trong ca? — giữ nguyên quy tắc hiện tại của worked, chỉ thêm ot).
- Punch có cờ `applyLate/applyEarly/applyOt = false` (lưu ở note dạng `flags:noLate,noEarly,noOt`) → bỏ phần tương ứng.
- `hr.auto_attendance=1`: ca `scheduled`, đã kết thúc, ngày ≤ hôm qua, không có punch nào (kể cả rejected) và không nghỉ phép → worked = giờ ca, shiftsWorked += 1, ngày đánh dấu `auto`.
- `hr.workday_tiers`: mỗi ngày thêm `workUnitsX10` theo tổng worked; tổng `workUnitsX10` trong totals. Lương tháng: khi tiers bật, `paidDaysX10` dùng Σ workUnitsX10 (+ phép, lễ) thay cho cách tính hiện tại, giới hạn bởi ngày công chuẩn — diễn giải rõ trong phiếu lương.
- Chế độ `window`: mỗi ngày coi như có một ca ảo [window_start, window_end] trừ nghỉ giữa giờ; lần chấm đầu ngày là vào, cuối ngày là ra; muộn/sớm theo khung, không tính phần trong giờ nghỉ.
- `hr.unscheduled_punch`: ở `POST /me/attendance/punch`, khi không tìm được ca gần nhất (`nearestAssignment` null) và mode `shift`: `off` → 422 `no_shift`; `approve` → status `pending`; `allow` → accepted như cũ.

## 4. Lương
`payroll-calc.ts`: cộng `attendance_incidents` chưa huỷ có `work_date` thuộc kỳ vào `penalties` / `bonus` (bonus chịu thuế), diễn giải từng dòng trong `detail_json` ("Phạt: Đi muộn không lý do × 2 = 40.000 (25/11)"). `inputs_hash` phải đổi khi incidents đổi.

## 5. Giao diện (frontend)
Route `/hr/attendance` → màn **Bảng chấm công** mới (`screens/hr/Board.tsx`). Menu: bỏ "Lịch ca" và "Duyệt chấm công" khỏi menu (route cũ vẫn chạy, `hidden: true`), thêm "Bảng chấm công" (perms `hr.view`). E2E cũ phải chạy được.

**PC (≥ 1024px)**
- Thanh công cụ: Tìm nhân viên · `Theo tuần | Theo tháng` · ‹ Tuần 48 — 23/11–29/11 › · nút Hôm nay · `Xem theo ca | Xem theo nhân viên` · **Chọn** (bật chế độ chọn nhiều) · **Duyệt chấm công (n)** (Sheet chứa các tab duyệt hiện có của `Attendance.tsx`, tái sử dụng component) · **Xếp lịch** (Sheet xếp ca hàng loạt, tái sử dụng từ `Schedule.tsx`, có "Lặp lại hằng tuần" + chọn nhiều NV) · Xuất file (bảng công tuần/tháng, tổng phạt/thưởng).
- Lưới *Xem theo ca*: cột trái "Ca làm việc" (tên + giờ, nút + thêm ca mẫu), 7 cột ngày (Thứ hai 23 …), ngày hôm nay tô nhấn. Mỗi ô ca–ngày chứa các **thẻ nhân viên** (tên; dòng 2 giờ vào–ra hoặc "-- --"; dòng 3 nhãn trạng thái màu nếu không phải đúng giờ/sắp tới; biểu tượng nhỏ khi có phạt/thưởng, chờ duyệt, chấm thủ công). Bấm vùng trống của ô ca–ngày → thêm NV vào ca ngày đó (chọn NV).
- *Xem theo nhân viên*: dòng = NV, cột = ngày; thẻ = ca.
- *Theo tháng*: lưới NV × ngày (cột hẹp), ô là chấm tròn màu theo trạng thái (nhiều ca → nhiều chấm), bấm mở chi tiết.
- Chú thích màu cố định ở đáy: Đúng giờ · Đi muộn / Về sớm · Chấm công thiếu · Chưa chấm công · Nghỉ làm.
- Chế độ **Chọn**: chỉ chọn được thẻ cùng một ca; thanh nổi "Đã chọn n · Chỉnh sửa chấm công · Huỷ".
- **Sheet chi tiết ô** (tiêu đề: tên NV · mã · nhãn trạng thái; Thời gian; Ca làm việc; Ghi chú) với 4 tab:
  1. *Chấm công*: radio Đi làm / Nghỉ phép hưởng lương / Nghỉ không lương; Vào ☐ giờ, Ra ☐ giờ (gợi ý giờ ca); công tắc Áp dụng đi muộn / về sớm / làm thêm; nghỉ → chọn "Nhân viên làm thay"; số liệu muộn/sớm/làm thêm/giờ làm; nút **Huỷ ca**, **Đổi ca** (chọn NV khác), Lưu.
  2. *Lịch sử chấm công*: bảng thời gian · trạng thái · hình thức (GPS/QR/thủ công/offline) · người · nội dung (gồm lần bị thay thế). Lần chấm chờ duyệt có nút Duyệt / Từ chối ngay tại đây.
  3. *Phạt vi phạm*: danh sách + "Thêm vi phạm" (loại, số lần, mức áp dụng; + thêm loại vi phạm), huỷ có lý do.
  4. *Thưởng*: tương tự.
- Kỳ đã chốt: ô chỉ xem, có ghi chú "Kỳ đã chốt — dùng điều chỉnh công".

**Điện thoại (390px)**: thanh chọn ngày dạng dải 7 ngày cuộn ngang (tuần), dưới là danh sách theo ca → thẻ NV (cùng màu/nhãn); "Theo tháng" hiện dạng lịch tháng với chấm màu; Sheet chi tiết toàn màn; chú thích màu thu gọn thành một dòng cuộn ngang. Không có cuộn ngang toàn trang.

**Thiết lập**: các tham số mới hiện trong Cài đặt → nhóm "Chấm công" (registry). `hr.workday_tiers` có ô nhập riêng dạng bảng mức (Từ … giờ → … công, + Thêm mức) nếu registry hỗ trợ kiểu tuỳ biến; tối thiểu là chuỗi có hướng dẫn và kiểm tra hợp lệ.

## 6. Test bắt buộc
Backend (vitest, `test/hr-board*.test.ts`): trạng thái ô cho từng trường hợp ở mục 1; board phân quyền tiền phạt; manual work (thay thế punch, idempotent, kỳ đã chốt → lỗi, batch nhiều ô, audit); manual nghỉ + người làm thay; reassign; incidents (tạo, huỷ, bất biến, kỳ lương đã duyệt → 409, cộng vào lương); từng quy tắc mục 3; `hr.unscheduled_punch` 3 giá trị; settings-ui test vẫn xanh.
E2E: bộ mới `e2e/hr-board.mjs` (PC 1440 + 390): mở bảng, chấm thủ công một ô, chấm hàng loạt 2 ô, ghi phạt, chụp ảnh vào `docs/screenshots/hr-board-*.png`. `e2e/hr.mjs`, `e2e/hr-swap.mjs` vẫn chạy.
