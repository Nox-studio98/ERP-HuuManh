# Hợp đồng API — Đợt 4 (M9 Nhân sự–Lương, M7 Giá đối thủ, M2-11, Khuyến mãi–Tích điểm, Giỏ quà, Tài chính bổ sung)

Quy ước như các hợp đồng trước: base `/api/v1`, camelCase, `{items, nextCursor}`, tiền VND nguyên, số lượng `{unit, qty}` + `qtyMilli`, ngày `YYYY-MM-DD` / kỳ `YYYY-MM` giờ VN, mọi ghi nhiều dòng trong **một** `db.batch` kèm `auditStmt`, lỗi `{error:{code,message,details}}`.
Schema: `migrations/0005_dot4_hr_competitor_promo.sql`. Quyền mới trong `lib/rbac.ts` (xem bảng cuối). Vai trò mới **`staff`** chỉ có `hr.self`.

Dịch vụ dùng chung đã có (không viết lại): `services/stock.ts` (FEFO, moveStatements), `services/pricing.ts`, `services/reservations.ts`, `services/vouchers.ts`, `services/debt.ts`, `services/outbox.ts`, `services/approval-registry.ts`, `lib/time.ts` (`vnDate`, `vnPeriod`, `vnDayRangeUtc`), `lib/codes.ts` (`nextCode`).
Hook cron có sẵn (điền nội dung, KHÔNG sửa `scheduled.ts`): `services/hr-cron.ts` `hrAttendanceAlerts(env)` (*/30), `services/competitor-cron.ts` `runDueCompetitorCrawls(env)` (*/30), `services/recurring-cron.ts` `generateRecurringOrders(env)` (08:00 VN).

**Dữ liệu nhạy cảm (M9 quy tắc):** lương, CCCD, tài khoản ngân hàng, phiếu lương — chỉ `hr.sensitive` (chủ, kế toán) xem; NV chỉ xem của mình (`hr.self`). **Mọi lần xem và sửa** hồ sơ/lương của người khác ghi `audit_log` (action `hr.view_sensitive`, `hr.employee.update`, `payroll.view` …). Trường nhạy cảm bị loại khỏi response khi thiếu quyền (không chỉ che).

---
## A. Nhân sự & chấm công — `routes/hr.ts` (export `hrRoutes`)

| Method | Path | Quyền | Request → Response |
|---|---|---|---|
| GET | /employees?status=&q= | hr.view | items `{id, code, fullName, position, storeId, status, hireDate, payType, userId, username, locationExempt}` (+ `baseSalary, hourlyRate, shiftRate, insuranceSalary, phone, email` chỉ khi hr.sensitive) |
| GET | /employees/:id | hr.view | trên + `contracts[]`, `allowances[]`, `leaveBalance:{year, entitledX10, usedX10, remainingX10}`; trường nhạy cảm (`idNumber, address, dob, bankName, bankAccount, dependents`) chỉ khi hr.sensitive → ghi audit `hr.view_sensitive` |
| POST | /employees | hr.manage | `{fullName, position, storeId, hireDate, payType, baseSalary?, hourlyRate?, shiftRate?, insuranceSalary?, dependents?, phone?, email?, idNumber?, dob?, address?, bankName?, bankAccount?, annualLeaveDays?, locationExempt?, createUser?:{username, role:'staff'|...}}` → tạo NV (code `NV-0001`), tuỳ chọn tạo tài khoản (mật khẩu tạm trả về **một lần**, must_change_password) |
| PUT | /employees/:id | hr.manage | + `version`; đổi lương/BH chỉ khi hr.sensitive |
| POST | /employees/:id/terminate | hr.manage | `{terminationDate, reason}` → status terminated, **khoá tài khoản + thu hồi phiên** (EC-39), huỷ các ca sau ngày nghỉ |
| POST/PUT | /employees/:id/contracts, /employees/:id/allowances[/:aid] | hr.manage (+hr.sensitive cho số tiền) | |
| GET/POST/PUT | /shift-templates | hr.view / hr.schedule | |
| GET | /schedule?from=&to=&employeeId= | hr.view | `{items:[{id, employeeId, employeeName, workDate, shiftTemplateId, shiftName, startAt, endAt, status}]}` |
| POST | /schedule/bulk | hr.schedule | M9-15 `{assignments:[{employeeId, workDate, shiftTemplateId}]}` — tính `start_at/end_at` UTC từ giờ VN (ca qua đêm: end ngày hôm sau); trùng → bỏ qua; NV đã nghỉ việc → 422 |
| DELETE | /schedule/:id | hr.schedule | status cancelled (không xoá) |
| POST | /schedule/swaps | hr.self | M9-22 `{fromAssignmentId, toEmployeeId, toAssignmentId?, reason}`; NV kia chấp nhận `POST /schedule/swaps/:id/accept` (hr.self), quản lý duyệt `POST /schedule/swaps/:id/decide {decision}` (hr.schedule) → đổi employee_id của các ca |
| **Chấm công (NV, điện thoại)** ||||
| GET | /me/attendance/today | hr.self | `{employee:{id, fullName}, shifts:[...hôm nay], punches:[{kind, serverAt, method, status}], canPunch:{in:boolean, out:boolean, reason?}, methods:['gps','qr'], store:{lat, lng, geofenceM}}` |
| POST | /me/attendance/punch | hr.self | M9-12/13 `{kind:'in'|'out', method:'gps'|'qr', lat?, lng?, accuracyM?, qrCode?, offline?:{clientAt}}` + header `X-Device-Id`. Quy tắc: **giờ = giờ máy chủ**; thiết bị phải là thiết bị đã đăng ký & được duyệt của NV (bảng `devices`), nếu chưa có thiết bị nào → tự đăng ký thiết bị đầu tiên; thiết bị khác → 403 `device_not_registered` + tạo `devices_registry_requests`. GPS: accuracy ≤ `hr.gps_max_accuracy_m` và khoảng cách (haversine) ≤ `stores.geofence_m`; QR: `qrCode` hợp lệ cho cửa sổ hiện tại hoặc liền trước (HMAC `ATTENDANCE_QR_SECRET`, xem dưới), mỗi cửa sổ dùng 1 lần (`qr_window` unique). NV `location_exempt=1` → method `exempt`. Ngoài vùng/QR sai → 422 `out_of_area`/`invalid_qr` (gợi ý gửi yêu cầu bổ sung). `offline` → status `pending` (chờ duyệt, ghi client_at). Chấm 'in' hai lần liên tiếp → 409 `already_in`. Gắn `assignment_id` ca gần nhất. Response `{punch:{id, kind, serverAt, method, status, distanceM}}` |
| GET | /attendance/qr?storeId= | hr.schedule | `{code, expiresAt, windowSeconds}` — hiển thị ở màn hình máy tính/tablet tại cửa hàng, tự làm mới; code = `storeId.window.base64url(HMAC-SHA256(secret, storeId|window))[0..16]`, window = floor(epoch/`hr.qr_window_seconds`) |
| POST | /me/attendance/corrections | hr.self | M9-17 `{workDate, type, kind?, requestedAt?, reason}` |
| GET | /attendance/corrections?status= | hr.schedule | |
| POST | /attendance/corrections/:id/decide | hr.schedule | `{decision, note?}` → approved: tạo punch method `manual` status accepted (created_by = người duyệt, correction_id) — mọi thay đổi có dấu vết |
| GET | /attendance/punches?employeeId=&from=&to=&status= | hr.view | nhật ký (M9-20); `POST /attendance/punches/:id/decide {decision}` cho punch pending (hr.schedule) |
| POST | /me/leave-requests | hr.self | M9-18 `{leaveTypeCode, fromDate, toDate, halfDay?, reason}` → tính `days_x10` (bỏ ngày lễ), vượt số dư (phép năm) → `over_balance=1` (vẫn tạo, quản lý phải duyệt ngoại lệ) |
| GET | /me/leave-requests, /leave-requests?status= | hr.self / hr.view | |
| POST | /leave-requests/:id/decide | hr.schedule | |
| POST | /me/overtime-requests, POST /overtime-requests (quản lý xác nhận sau) | hr.self / hr.schedule | M9-21 |
| POST | /overtime-requests/:id/decide | hr.schedule | |
| GET | /me/schedule?from=&to= | hr.self | lịch ca của mình |
| GET/POST/DELETE | /holidays | hr.view / hr.manage | |
| GET | /devices/requests, POST /devices/requests/:id/decide | hr.schedule | đổi điện thoại chấm công cần quản lý duyệt |
| **Bảng công** ||||
| GET | /timesheets/:period?employeeId= | hr.view | M9-16/19 tính "sống" từ punches nếu kỳ open, đọc snapshot nếu closed: `{period, status, employees:[{employeeId, name, days:[{workDate, scheduledMinutes, workedMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, missingPunch, leaveCode, holiday}], totals:{workedMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, missingDays, shiftsWorked, paidLeaveX10, workDays}}]}` |
| POST | /timesheets/:period/close | timesheet.close | chốt công: ghi snapshot `timesheet_days` + status closed. Còn punch pending / thiếu công chưa xử lý → 409 `unresolved_items` (details liệt kê), trừ khi `{force:true, reason}` |
| POST | /timesheets/adjustments | timesheet.close | sai sót kỳ đã chốt → dòng điều chỉnh vào kỳ sau |

**Quy tắc tính công (bắt buộc, có test):** ghép cặp in→out theo thứ tự thời gian trong ngày làm việc (ca qua đêm thuộc ngày bắt đầu); in không có out → `missing_punch` (KHÔNG đoán giờ ra); worked = Σ(out−in) − break của ca; late = max(0, in − start − `hr.late_grace_minutes`); early_leave = max(0, end − out); overtime chỉ tính phần **đã duyệt** trong `overtime_requests`, làm tròn xuống bội số `hr.rounding_minutes`, hệ số theo ngày thường/cuối tuần/lễ; ca gãy (2 ca/ngày) cộng tổng; NV nghỉ việc giữa tháng chỉ tính đến `termination_date`; chỉ punch `accepted`.

`hrAttendanceAlerts` (M9-23): ghi `audit_log` action `hr.alert` (và push cho người có hr.schedule nếu có subscription) khi: quá 15' sau giờ vào ca chưa chấm; 23:00 VN còn in chưa out; punch bất thường (nhiều thiết bị, khoảng cách lớn).

## B. Lương — `routes/payroll.ts` (export `payrollRoutes`)

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /payroll/periods | hr.sensitive | |
| POST | /payroll/periods/:period/calculate | payroll.write | Yêu cầu timesheet kỳ đã **closed** (409 `timesheet_open`). Tính cho mọi NV active trong kỳ → upsert `payroll_items` (chỉ khi status draft/calculated) → status calculated. Không ghi đè kỳ approved/paid (trigger). |
| GET | /payroll/periods/:period | hr.sensitive | `{period, status, totals:{gross, net, insuranceEmployee, insuranceEmployer, pit, cost}, items:[{employeeId, code, name, payType, workedMinutes, paidDaysX10, shifts, basePay, allowances, overtimePay, bonus, salesBonus, penalties, adjustments, gross, insuranceEmployee, taxableIncome, pit, advances, net}]}` — ghi audit `payroll.view` |
| POST | /payroll/periods/:period/approve | payroll.approve | M9-04 chủ duyệt & chốt kỳ lương |
| POST | /payroll/periods/:period/pay | payroll.write | M9-05 `{fundId}` chỉ khi approved → **phiếu chi M6** category `LUONG` (mỗi NV một phiếu hoặc một phiếu tổng + chi tiết — chọn mỗi NV một phiếu, counterparty = mã NV), đánh dấu tạm ứng đã khấu trừ, status paid. Kỳ M6 đã khoá → 423. |
| GET/POST | /payroll/entries?period= | payroll.write | thưởng/phạt/phụ cấp/điều chỉnh theo kỳ; kỳ đích phải chưa approved |
| GET/POST | /payroll/advances | payroll.write | M9-08 `{employeeId, amount, fundId, reason}` → phiếu chi M6 (category LUONG, note tạm ứng) + `deduct_period` = kỳ kế tiếp chưa tính |
| GET | /me/payslips, /me/payslips/:period | hr.self | M9-07 chỉ của mình và chỉ kỳ approved/paid; dòng diễn giải từ `detail_json` |
| GET | /payroll/reports/cost?from=&to= | hr.sensitive | M9-10 chi phí nhân sự theo tháng & theo vị trí |
| GET | /exports/bang-luong.xlsx?period= | payroll.write | dùng `services/xlsx.ts` |

**Công thức (cấu hình qua settings, có test):**
- monthly: `base_pay = round(base_salary × paid_days / hr.standard_workdays)`, paid_days = công + phép có lương + lễ nghỉ hưởng lương (tối đa standard_workdays). **C-14:** `hr.monthly_pay_mode` = `proportional` (mặc định, [Cần xác nhận]): công mỗi ngày = min(1, phút làm thường / phút ca theo lịch của ngày, mặc định 480), làm tròn 0,1 ngày — đi muộn/về sớm bị trừ theo giờ; `day_present` = kiểu cũ (≥1 phút công = 1 ngày). **C-09:** chỉ ngày lễ `paid_off=1` được cộng công khi không đi làm. **C-15:** phép chỉ tính ngày làm việc theo lịch — bỏ ngày lễ, ngày nghỉ hằng tuần (`hr.weekly_off_days`, vd `7` = Chủ nhật; mặc định rỗng [Cần xác nhận]) và ngày không có ca khi tuần đó NV đã được xếp lịch; áp dụng cho cả `days_x10` của đơn xin nghỉ và bảng công; hourly: `hourly_rate × worked_minutes/60`; shift: `shift_rate × shifts_worked`.
- overtime_pay = đơn giá giờ (monthly: base_salary / standard_workdays / 8) × giờ tăng ca × hệ số.
- allowances = Σ employee_allowances active + entries kind allowance; bonus/penalty/adjustment từ payroll_entries (adjustment có source_period); sales_bonus = doanh thu đơn POS hoàn tất do `orders.created_by` = user của NV trong kỳ × `hr.sales_bonus_bp` (M9-11).
- gross = base + allowances + overtime + bonus + sales_bonus − penalties + adjustments.
- BH NLĐ = min(insurance_salary, `hr.insurance_cap_vnd`) × `hr.insurance_employee_bp` (0 nếu insurance_salary = 0); BH DN tương tự `hr.insurance_employer_bp` (vào chi phí, không trừ lương).
- TNCN (nếu pit_enabled): taxable = max(0, gross − phụ cấp không chịu thuế − BH NLĐ − `hr.pit_family_deduction` − dependents × `hr.pit_dependent_deduction`); luỹ tiến theo `hr.pit_brackets_json`.
- net = gross − BH NLĐ − TNCN − tạm ứng khấu trừ kỳ này. Làm tròn từng khoản tới đồng.
- Mọi tham số [Cần xác nhận] — thể hiện rõ trong phiếu lương.

## C. Giá đối thủ (M7) + gợi ý đặt hàng (M2-11) — `routes/competitors.ts` (export `competitorRoutes`), `routes/purchasing.ts` (export `purchasingRoutes`)

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET/POST/PUT | /competitors, /competitors/:id/sources | competitors.view / competitors.write | M7-01 |
| POST | /competitor-sources/:id/run | competitors.write | chạy thu thập ngay (giới hạn trang) |
| GET | /competitor-sources/:id/runs | competitors.view | M7-07 |
| GET | /competitor-products?sourceId=&q=&unmatched=1 | competitors.view | |
| PUT | /competitor-products/:id | competitors.write | sửa quy cách chuẩn hoá `{packQtyMilli, packUnit}` (M7-04) |
| POST | /competitor-prices/manual | competitors.write | M7-06 `{competitorId, name, packText?, packQtyMilli, packUnit, price, inStock?, observedAt?, productId?}` (tạo source manual + product nếu cần) |
| POST | /competitor-prices/import | competitors.write | CSV `competitor,name,pack_qty,pack_unit,price,in_stock,observed_at,product_sku` |
| GET | /product-matches?status=suggested | competitors.view | M7-03 gợi ý ghép (độ giống tên sau normalizeVi + trigram, đơn vị tương thích) `{id, productId, productName, competitorProductId, competitorName, competitorProductName, packText, score}` |
| POST | /product-matches/suggest | competitors.write | sinh gợi ý cho SP chưa ghép |
| POST | /product-matches/:id/decide | competitors.write | `{decision:'approved'|'rejected'}`; POST /product-matches (ghép tay) |
| GET | /price-comparison?groupId=&onlyCheaper= | competitors.view | M7-05 `{items:[{productId, name, baseUnit, ourPrice, marketMin, marketAvg, diffMinBp, diffAvgBp, competitors:[{competitorName, unitPrice, inStock, promoText, observedAt}]}]}` — chỉ match approved, chỉ obs status ok/approved_outlier, quan sát mới nhất mỗi SP đối thủ ≤ 7 ngày; luôn kèm `observedAt` |
| GET | /competitor-prices/history?productId=&days= | competitors.view | M7-08 chuỗi thời gian |
| GET | /competitor-prices/outliers, POST /competitor-prices/:obsId/decide | competitors.write | EC-36 duyệt giá bất thường |
| GET | /price-alerts?acked=0, POST /price-alerts/:id/ack | competitors.view | M7-09 |
| GET | /price-suggestions?status=pending | competitors.view | M7-10 |
| POST | /price-suggestions/generate | competitors.write | đề xuất khi giá ta > marketAvg × (1+ngưỡng) hoặc < marketMin nhiều, **không dưới giá vốn + biên mục tiêu nhóm** |
| POST | /price-suggestions/:id/accept | prices.write | tạo giá qua **luồng M3 hiện có** (`/prices/bulk` logic: lịch sử giá, duyệt nếu thiếu prices.approve) — M7 KHÔNG tự đổi giá |
| POST | /price-suggestions/:id/dismiss | competitors.write | |
| GET | /purchasing/suggestions?supplierId= | purchasing.view | M2-11 `{items:[{productId, name, baseUnit, onHandMilli, reservedMilli, avgDailySalesMilli, daysCover, leadTimeDays, suggestedMilli, supplierId, supplierName, lastCost}]}` — tốc độ bán = Σ stock_moves sale trong `reorder.lookback_days`; đề xuất = max(0, tốc độ × (lead_time + `reorder.cover_days`) − (tồn khả dụng)) làm tròn lên đơn vị đặt; cảnh báo hàng sắp hết hạn không tính vào tồn |
| POST | /purchasing/suggestions/to-receipt | purchasing.view + inventory.write | tạo **phiếu nhập nháp** (stock_doc receipt draft) cho 1 NCC từ các dòng chọn |
| GET/PUT | /product-suppliers?productId= | inventory.view / products.write | |

**Thu thập (services/competitor-crawler.ts):** chỉ trang công khai; kiểm `robots.txt` (Disallow cho user-agent của ta hoặc `*`) trước khi chạy, cache 24h; tuân `min_delay_ms` giữa request, tối đa `max_pages`; User-Agent từ setting; không đăng nhập, không vượt captcha/chặn — gặp 403/429/captcha → status `blocked`, tăng `consecutive_failures`, cảnh báo `source_failed` (EC-35), giữ dữ liệu cũ; parser `jsonld` (schema.org Product/Offer) mặc định, `css` theo config (dùng HTMLRewriter), số trang không parse được sản phẩm nào → `layout_changed`. Quan sát lệch trung vị > `competitor.outlier_band_bp` → status outlier (không vào so sánh tới khi duyệt). Mạng thật KHÔNG được gọi trong test (mock fetch).

## D. Khuyến mãi, voucher, tích điểm, giỏ quà, đặt cọc, tài chính bổ sung, đơn lặp — `routes/promotions.ts` (export `promotionRoutes`), `routes/finance-extra.ts` (export `financeExtraRoutes`)

**Engine (`services/promotions.ts`, dùng chung POS + website + đơn online):** `evaluatePromotions(db, {channel, customerId?, lines:[{productId, groupId, qtyMilli, unitPrice, lineTotal}], subtotal, voucherCode?, at})` → `{discounts:[{promotionId, voucherId?, amount, description}], total, rejected:[{code, reason}]}`. Quy tắc: chỉ promotions status active, trong thời gian & khung giờ (giờ VN), đúng kênh; percent (trần max_discount) / amount / fixed_price (giá trọn cho SP) / combo (đủ thành phần → giá combo) / end_of_day (giảm % trong khung giờ cho SP được chọn); voucher: active, còn lượt, đúng khách (nếu cá nhân), per_customer_limit; EC-08: không cộng dồn trừ khi `promo.allow_stacking=1` và KM stackable — mặc định chọn **một** khuyến mãi lợi nhất; **không bao giờ** đưa giá dòng dưới giá vốn hiện tại (`currentAvgCost`) → cắt giảm phần vượt và ghi lý do. Đổi điểm: `redeemPoints` ≤ `loyalty.max_redeem_bp` × tổng.

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET/POST/PUT | /promotions | prices.view_sell / promotions.write | tạo ở draft; `POST /promotions/:id/submit` → active nếu có promotions.approve, ngược lại pending_approval + approval `promotion.activate` (handler đăng ký) |
| POST | /promotions/:id/end | promotions.write | |
| GET/POST | /promotions/:id/vouchers | promotions.write | sinh hàng loạt `{count, prefix, maxUses, perCustomerLimit, customerId?}` — code ngẫu nhiên không đoán được |
| POST | /promotions/preview | pos.sell | xem trước giảm giá cho giỏ (POS / web dùng engine) |
| GET | /customers/:id/loyalty | b2b.view hoặc pos.sell | `{points, ledger[]}` |
| POST | /customers/:id/loyalty/adjust | loyalty.adjust | `{points, note}` |
| **Tích hợp checkout (sửa hẹp)** | | | `routes/pos.ts` `/pos/orders` thêm `voucherCode?`, `redeemPoints?`: áp engine **trong cùng batch** (order_discounts, voucher_redemptions + `UPDATE vouchers SET used_count=used_count+1` — CHECK chặn dùng quá lượt đồng thời; điểm: loyalty_ledger + `UPDATE customers SET points=points-?` — trigger chặn âm); tích điểm khi hoàn tất (`loyalty.enabled=1`, khách có customerId). Trả hàng/huỷ → hoàn điểm & voucher (reverse). Shop worker `src/shop/worker` checkout: nhận `voucherCode` + quote hiển thị giảm giá (cùng engine). **Giữ nguyên hành vi cũ khi không gửi voucher/điểm** (các test hiện có phải xanh). |
| **Tích điểm trên website** | | | Chỉ tài khoản shop **bán lẻ đăng nhập** (khách vãng lai / tài khoản sỉ: 422 `login_required` / `redeem_not_allowed`). `GET /api/me` trả thêm `points`, `pointValueVnd` khi `loyalty.enabled=1`. `POST /api/cart/quote` và `/api/checkout` nhận `redeemPoints?:int` (cùng `planPromotions`/`planRedeem` với POS: ≤ số dư, ≤ `loyalty.max_redeem_bp` × tiền hàng sau KM không gồm phí giao, không dưới giá vốn → 422 `redeem_too_high`, thiếu điểm 409 `points_insufficient`); quote trả `pointsRedeemed`, `pointsAmount` (+ `pointsMax`, `pointsBalance` cho UI). Checkout ghi `order_discounts`(points_redeemed) + `loyalty_ledger`(redeem) + `customers.points` trong **cùng batch** với đơn (trigger chặn âm → 409). **Tích điểm khi giao xong** (`deliverOrder`, cùng luật `loyalty.earn_per_vnd` trên `total − shipping_fee`), không tích lúc checkout. Huỷ/trả đơn online (mọi đường: NV, khách, từ chối lệch cân, quá hạn thanh toán, trả hàng): trigger `orders_reverse_online_points` (migration 0011) hoàn điểm đã đổi và thu hồi điểm đã tích (kẹp theo số dư), idempotent theo sổ. OrderView có `pointsRedeemed`, `pointsAmount`, `pointsEarned`, `pointsEarnable`. |
| GET/PUT | /bundles/:productId/components | products.write | M1-12 thành phần giỏ quà |
| POST | /assembly-orders | inventory.write | `{bundleProductId, qty, unit, extraCost?, expiresAt?}` → FEFO thành phần (moveStatements move_type `assemble_out`), tạo lô giỏ quà (`assemble_in`) giá vốn = Σ thành phần + extra_cost / số lượng; thiếu thành phần → 409 insufficient_stock |
| POST | /pos/preorders | pos.sell | M1-12 đặt trước tại quầy: `{customerId|customer:{name, phone}, pickupDate, lines, deposit:{amount, method}}` → order status `confirmed`, `is_preorder=1`, `pickup_date`, giữ tồn nếu có hàng (reservations), `order_deposits` + phiếu thu M6; cọc ≥ `deposit.min_bp` × tổng |
| POST | /pos/preorders/:id/fulfill | pos.sell | giao: tiêu thụ giữ tồn/FEFO, thanh toán phần còn lại, cọc → applied |
| POST | /pos/preorders/:id/cancel | pos.sell | `{refundDeposit:boolean, reason}` → refunded (phiếu chi) hoặc forfeited (thu khác) — duyệt nếu forfeited (approvals.decide) |
| GET | /reports/cash-flow?from=&to=&fundId= | reports.view | M6-07 `{opening, inflows:[{category, amount}], outflows:[...], closing, byFund:[...]}` từ payments + cash_vouchers + debt_payments |
| GET | /reports/pnl-by-channel?from=&to= | reports.view | M6-06 doanh thu/giá vốn/lãi gộp theo kênh + chi phí trực tiếp (cash_vouchers.channel) + chi phí chung phân bổ theo `cost_allocation_rules` (revenue_share hoặc fixed_bp) |
| GET/PUT | /cost-allocation-rules | finance.write | |
| GET | /reports/vat?period= | reports.view | M6-08 đầu ra (invoices vat_amount) / đầu vào (supplier_bills vat_amount) / phải nộp [Cần xác nhận hình thức kinh doanh] |
| GET/PUT | /budgets?period= | finance.view / finance.write | M6-10 |
| GET | /reports/budget-vs-actual?period= | reports.view | thực tế theo category/line vs ngân sách, chênh lệch % |
| — | `services/recurring-cron.ts` | — | M4-08 điền `generateRecurringOrders`: với mẫu active có weekday của **ngày mai**, `last_generated_for` ≠ ngày mai → tạo đơn qua `createB2bOrder` + `confirmOrderFlow` (ngữ cảnh user hệ thống, role manager, KHÔNG vượt hạn mức — bị chặn thì để đơn `new` + approval như bình thường), idempotent bằng clientUuid `recurring:<id>:<date>` |

## Bảng quyền Đợt 4 (lib/rbac.ts — đã có)
| Quyền | Chủ | Quản lý | Thu ngân | Thủ kho | Kế toán | NV online | NV (staff) |
|---|---|---|---|---|---|---|---|
| hr.self | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| hr.view / hr.schedule | ✓ | ✓ / ✓ | | | ✓ / – | | |
| hr.manage (tạo/sửa hồ sơ, hợp đồng, phụ cấp, nghỉ việc, loại phép, ngày lễ, cửa hàng) | ✓ | | | | – (C-21, thu hẹp) | | |
| hr.sensitive / payroll.write / timesheet.close (chốt công + điều chỉnh công) | ✓ | | | | ✓ | | |
| payroll.approve | ✓ | | | | | | |
| competitors.view / write | ✓ | ✓ | | | | | |
| purchasing.view | ✓ | ✓ | | ✓ | | | |
| promotions.write / approve, loyalty.adjust | ✓ | ✓ | | | | | |

## Bổ sung (gaps-2)

| Method | Đường dẫn | Quyền | Ghi chú |
|---|---|---|---|
| PUT | `/price-lists/:id` | `prices.write` | Sửa tên/kênh/nhóm khách/loại/ưu tiên/`active`; không cho tắt bảng giá nền cuối cùng (409 `last_base_price_list`); audit `price_list.update`. |
| GET | `/debts/payments` | `debt.view` | Thêm lọc `direction`, `status`, `from`/`to` (YYYY-MM-DD); trả thêm `partnerName`. |
| GET | `/users/assignable` | `b2b.write` | `[{id, fullName}]` người dùng hoạt động vai trò owner/manager. |
| GET | `/leave-types` | `hr.view` hoặc `hr.self` | Mặc định chỉ loại đang dùng; `?all=1` (cần `hr.view`) gồm cả đã tắt. |
| POST | `/leave-types` | `hr.manage` | `{code, name, paid, usesBalance, active?}`, `code` duy nhất. Không có DELETE: tắt bằng `active=false`. |
| PUT | `/leave-types/:id` | `hr.manage` | Sửa `name/paid/usesBalance/active`. Loại đã tắt không xin nghỉ được. |

Migration `0012_leave_types_active.sql` thêm cột `leave_types.active`. `GET /b2b/recurring` trả thêm `productName` mỗi dòng.

## Sửa nhóm 3 — nhân sự / lương / sao lưu (migration `0017_fix3_hr_payroll.sql`)

| Chủ đề | Thay đổi |
|---|---|
| C-01 chấm công offline | `POST /me/attendance/punch` có `offline.clientAt`: nếu `clientAt ≤ giờ gửi (+5 phút lệch đồng hồ)` và `≥ giờ gửi − hr.offline_max_hours` (mặc định 48) → punch `method='offline'`, `status='accepted'`, `reviewFlag=true`, **giờ hiệu lực `effective_at = clientAt`** (tính công ngay, quản lý xem lại). Ngoài khoảng đó → `pending`, `effective_at = server_at`. `server_at`/`client_at`/`effective_at` bất biến (trigger). Bảng công, ghép ca đêm (work_date của ca), danh sách chờ chốt đều dùng `COALESCE(effective_at, server_at)`. Phản hồi thêm `effectiveAt`, `reviewFlag`. |
| | `GET /attendance/punches?reviewFlag=1` liệt kê chấm offline đã tính công chờ xem lại; `POST /attendance/punches/:id/decide`: `approved` bỏ cờ (vẫn accepted), `rejected` loại khỏi bảng công (cả với punch `pending`). |
| C-02 sổ quỹ | `GET /exports/so-quy.xlsx`: người không có `hr.sensitive` thấy phiếu lương/tạm ứng (ref_type `payroll_item`/`salary_advance`/`payroll` hoặc khoản mục `LUONG`) gộp thành 1 dòng "Chi lương (tổng)" mỗi ngày (số dư vẫn đúng). Các báo cáo khác (lãi lỗ, dòng tiền, ngân sách, báo cáo ngày) chỉ tổng theo khoản mục, không có dòng từng người; `/audit` đã che sẵn. |
| C-03 lương giờ | `basePay = đơn giá × phút thường` với phút thường = Σ max(0, phút làm − phút tăng ca đã duyệt của ngày) + phút điều chỉnh công; tăng ca vẫn trả `đơn giá × phút × hệ số` (phần miễn thuế = phần chênh, không đổi). Lương ca/tháng không đổi. |
| C-04 duyệt lương | `payroll_periods.inputs_hash` = SHA-256 của hồ sơ NV, bảng công, điều chỉnh công, phụ cấp, thưởng/phạt, tạm ứng, tham số `hr.*` (+ doanh số nếu có thưởng doanh số) lúc tính. `POST /payroll/periods/:p/approve` → **409 `payroll_stale`** nếu đầu vào đã đổi hoặc kỳ cũ chưa có hash; phải `calculate` lại. `GET /payroll/periods/:p` trả `stale`. `POST /payroll/entries` ở kỳ `calculated` trả thêm `requiresRecalculation: true`. Kỳ đã duyệt/chi vẫn 409 `payroll_locked` → ghi `adjustment` (kèm `sourcePeriod`) vào kỳ sau. |
| C-05 tạm ứng | Khấu trừ tạm ứng ≤ thực lĩnh trước tạm ứng (net ≥ 0). Phiếu lương có `advancesCarried` + dòng "Tạm ứng chuyển kỳ sau". `POST /payroll/periods/:p/pay`: phân bổ theo id tạm ứng; khoản trừ đủ → `deducted`; trừ một phần → tách dòng (dòng cũ giảm về phần đã trừ + `deducted`, dòng mới `paid` cho kỳ sau, `carried_from_id`); chưa trừ → chuyển `deduct_period` sang kỳ kế (kỳ chưa tính). Phản hồi có `advancesCarried`, `carriedTo`. Tất cả trong cùng một batch với `onceStmt`. |
| C-06 sao lưu | `services/backup.ts`: bảng lấy từ `sqlite_master` (trừ `sqlite_*`, `_cf_*`, `d1_*`, `state_guard`, `sessions`, bảng ảo), đọc theo rowid từng 1000 dòng, ghi `backups/YYYY-MM-DD/<bảng>.part-NNNN.ndjson.gz` (≤ 5000 dòng/phần) + `manifest.json` (số dòng, sha256 từng phần; ghi sau cùng). Bỏ `pass_hash`. Giữ `backup.retention_days` (mặc định 30) ngày. Khôi phục: `scripts/restore-from-r2.mjs` (xem README). |
| C-07 cửa hàng | `GET /stores`, `GET /stores/:id`, `PUT /stores/:id` `{name?, address?, lat?, lng?, geofenceM?}` (quyền `users.manage` hoặc `hr.manage`; lat −90..90, lng −180..180 phải đi cùng nhau, `geofenceM` 10..2000; audit `store.update`). UI: Nhân sự → Cửa hàng (nút "Lấy vị trí hiện tại"). |
| C-08 phép | `POST /leave-requests/:id/decide` (approved) tính lại số dư lúc duyệt (mọi đơn đã duyệt cùng năm): vượt → **409 `over_balance`** trừ khi `allowOverBalance: true` **kèm `exceptionReason`** (thiếu → 422 `exception_reason_required`); lưu `leave_requests.exception_reason`. Cờ `overBalance` lúc tạo đơn tính cả đơn đang chờ. Chốt chặn bằng `assertStmt` trong batch. |
| C-22 RBAC | `GET /bank-transactions` cần `debt.view` **và** `finance.view` (thủ kho không còn xem sao kê). |

## Đợt 6b — C-21, C-26, C-29
- **C-21**: kế toán (`accountant`) không còn `hr.manage`; chỉ xem hồ sơ (kể cả `hr.sensitive`), chốt/điều chỉnh công (`timesheet.close`, quyền mới) và làm bảng lương (`payroll.write`). Tạo/sửa hồ sơ, lương, hợp đồng, phụ cấp, nghỉ việc, loại phép, ngày lễ, cấu hình cửa hàng: chủ (`hr.manage`).
- **C-26**: nghỉ việc / khoá tài khoản còn kiểm thêm chứng từ nháp/chờ duyệt do người đó lập (`draftOrders`, `draftStockDocs`, `draftQuotes`, `draftPromotions`, `draftPurchaseReturns`, `draftSettlements`) → 409 `pending_requests`, đi tiếp với `force` (+ lý do với nghỉ việc).
- **C-29**: tham số `retention.gps_months` (12), `retention.employee_pii_months` (24), `retention.audit_years` (10), `backup.retention_days` (90); xem docs/SECOPS.md mục 11.

## Báo cáo bán hàng & hoa hồng

Quy ước: **người bán của đơn = `COALESCE(orders.seller_id, orders.created_by)`** (migrations/0033). Số liệu cùng điều kiện với `/reports/pnl`: đơn `completed`, khoảng ngày theo giờ VN, đơn trả (`kind='return'`) trừ ra và tính về người bán / khách của **đơn gốc**.

### Báo cáo bán hàng (`reports.view`)

Query chung: `from`, `to` (YYYY-MM-DD, gồm cả hai đầu, tối đa 366 ngày, mặc định hôm nay), `channel` (`pos|online|b2b|fresco|social`), `groupId` (nhóm hàng). Sai tham số → 422. Giá vốn / lãi gộp (`cogs`, `grossProfit`) **chỉ có trong phản hồi** khi vai trò có `prices.view_cost`.

| Route | Trả về |
|---|---|
| `GET /reports/sales/sellers` | `items[]`: `sellerId` (null = không rõ), `sellerName`, `saleCount`, `sales`, `returnCount`, `returns`, `revenue` (thuần), `avgOrder` (= sales / saleCount), [`cogs`, `grossProfit`]; `totals`; `basis`: `orders` (khớp `/reports/pnl` kể cả phí giao hàng) hoặc `lines` (khi lọc `groupId`: tính trên dòng hàng của nhóm, không gồm phí giao). |
| `GET /reports/sales/products` | `items[]` (tối đa 500, theo doanh thu): `productId`, `sku`, `name`, `baseUnit`, `groupName`, `qtyMilli` (thuần), `revenue`, [`cogs`, `grossProfit`]; `unsold[]`: hàng đang bán không có đơn bán nào trong kỳ (kèm `onHandMilli`); `totals`. Bán chạy / chậm = sắp xếp phía client. Tổng `items.revenue` + phí giao hàng = `revenue` của `/reports/pnl`. |
| `GET /reports/sales/customers` | `items[]` (top 500 theo doanh thu thuần): `customerId`, `code`, `name`, `type`, `phone` (che theo `customers.view_pii`), `orders`, `sales`, `returns`, `revenue`, `avgOrder`, `lastAt`; `walkIn`: khách lẻ không lưu thông tin; `totals`. |
| `GET /reports/sales/suppliers` | Cần thêm `prices.view_cost` (thiếu → 403). Theo phiếu nhập `posted` và phiếu trả NCC `posted` trong kỳ (`posted_at`): `items[]`: `supplierId`, `code`, `name`, `receiptCount`, `purchased`, `returnCount`, `returned`, `netPurchased`, `debt` (công nợ còn phải trả hiện tại, chỉ khi có `debt.view`); `totals`. Không đổi theo `channel` / `groupId`. |

Xuất CSV thực hiện phía giao diện (nút "Xuất CSV" của bộ UI kit) trên chính số liệu các route trên.

### Quy tắc hoa hồng (bảng `commission_rules`, migrations/0036)

Quyền: **xem** `hr.sensitive`; **tạo / sửa / ngừng** `payroll.approve` (chính sách lương, chủ cửa hàng). Không có xoá (trigger chặn `DELETE`): muốn bỏ quy tắc thì ngừng (`active=false`).

- `GET /commission/rules` → `items[]`: `id`, `name`, `scope` (`all|group|product`), `productGroupId/Name`, `productId/Name`, `employeeId/Name` (null = mọi người), `rateBp` (0–10000, 0 = loại khỏi hoa hồng), `active`, `effectiveFrom`, `effectiveTo` (YYYY-MM-DD giờ VN, null = không giới hạn), `version`.
- `POST /commission/rules` `{ name, scope, productGroupId?, productId?, employeeId?, rateBp, effectiveFrom?, effectiveTo? }` → 201. `scope=group` bắt buộc `productGroupId`; `scope=product` bắt buộc `productId`; tham chiếu không tồn tại / ngày đảo → 422.
- `PATCH /commission/rules/:id` `{ version, ...trường cần đổi, active? }` → 200; `version` cũ → **409 `version_conflict`**. Mỗi lần sửa `version + 1`, có audit (`commission.rule.create|update|deactivate`).
- `GET /commission/preview?period=YYYY-MM` (`hr.sensitive`) → `{ period, rulesActive, legacySalesBonusBp, rules[], items[], total }`. `items[]`: `userId`, `userName`, `employeeId`, `employeeName`, `paid` (có hồ sơ nhân viên liên kết), `revenue`, `uncoveredRevenue` (phần không khớp quy tắc nào), `commission`, `parts[]` (`ruleId`, `name`, `rateBp`, `revenue`, `amount`). Dùng chung hàm với bảng lương nên khớp số khi tính lương.

**Cách tính** (`services/commission.ts`): doanh thu thuần dòng hàng (`order_lines.line_total`, đã gồm giảm giá phân bổ) của đơn **POS** hoàn tất trong kỳ, theo người bán; trả hàng trừ lại theo mặt hàng cho người bán của đơn gốc vào kỳ hoàn tất phiếu trả. Mỗi dòng (người bán × mặt hàng × ngày) chọn **một** quy tắc cụ thể nhất: phạm vi sản phẩm > nhóm > tất cả, rồi quy tắc riêng nhân viên > chung, hoà thì quy tắc tạo sau (id lớn hơn); quy tắc phải đang bật và ngày đơn nằm trong hiệu lực. Hoa hồng một quy tắc = `round(Σ doanh thu × rateBp / 10000)`; tổng của người bán tối thiểu 0.

**Tích hợp lương**: kỳ có ≥ 1 quy tắc đang bật giao với kỳ → `salesBonus` của phiếu lương = hoa hồng theo quy tắc (mỗi quy tắc một dòng "Hoa hồng: <tên>" trong `lines`, chịu thuế như thưởng doanh số), thay cho `hr.sales_bonus_bp`; dữ liệu quy tắc + doanh thu theo quy tắc được đưa vào `inputs_hash` nên đổi quy tắc / phát sinh đơn hoặc trả hàng sau khi tính → duyệt báo `409 payroll_stale`. Kỳ **không** có quy tắc nào: giữ nguyên cách tính cũ (`hr.sales_bonus_bp`) và `inputs_hash` không đổi.

### Chuyển việc đang làm khi nghỉ việc / khoá tài khoản (EC-39, `services/hr-handover.ts`)

Quyền: `hr.manage` (chủ). Từng nhóm còn đòi thêm quyền của nhóm đó (khách sỉ/báo giá/đơn/đơn lặp: `b2b.write`; phiếu kho/trả NCC: `inventory.write`; PO: `purchasing.write`; khuyến mãi: `promotions.write`; đối soát: `finance.write`; giao hàng: `orders.online.manage`) — cả với người thực hiện lẫn người nhận (người nhận không đủ quyền → 422 `invalid_recipient`). Không dùng được cho chính mình (403 `handover_self`). Ca POS đang mở **không** chuyển được: vẫn phải chốt ca (`open_shift` khi nghỉ/khoá).

- `GET /handover?userId=&employeeId=` (cần ít nhất một; tự ghép nhân viên ↔ tài khoản) → `{ name, userId, employeeId, openShifts, total, groups[], recipients: { users[], employees[] } }`. `groups[]`: `key`, `label`, `count`, `items[]` (`id`, `label`; tối đa 60, `truncated`), `kind` (`user` | `employee` cho nhóm `shifts`), `perm`, `cancel` (nhãn hành động huỷ/ngừng, `null` nếu nhóm còn chứng từ đã gửi duyệt hoặc không huỷ được).
- Nhóm (`key`): `customers` (khách sỉ phụ trách `owner_user_id`), `quotes`, `orders` (đơn nháp + đơn sỉ mới), `stock_docs`, `purchase_orders`, `purchase_returns`, `promotions`, `settlements`, `recurring_orders`, `approvals` (yêu cầu chờ duyệt do người này lập, đổi `requested_by`), `deliveries` (`deliverer_user_id` đơn đang giao), `shifts` (ca đã xếp từ hôm nay, trừ kỳ công đã chốt).
- `POST /handover` `{ userId?|employeeId?, reason, actions: [{ group, action: "reassign"|"cancel", toUserId?|toEmployeeId? }] }` → `{ done, remaining }`. Một `db.batch` gồm `assertStmt` (số dòng còn đúng + người nhận còn hoạt động; đổi giữa chừng → 409 `state_changed`) + UPDATE + **một** `auditStmt` `hr.handover` (đếm + id từng nhóm). `cancel` chỉ khi mọi dòng của nhóm là nháp (báo giá/phiếu kho/PO/trả NCC/khuyến mãi nháp → `cancelled`; đơn lặp → ngừng `active=0`; ca → `cancelled`); ngược lại 422 `cancel_not_allowed`. Ca chuyển cho nhân viên khác trùng ngày+ca → 409 `shift_conflict`. Không còn gì → 422 `nothing_to_hand_over`.
- `offboardingBlockers` (nghỉ việc / `PUT /users` khoá) nay đếm thêm PO nháp, khách sỉ phụ trách, đơn lặp, đơn sỉ mới, đơn đang giao → vẫn `pending_requests` (cần `force`) cho đến khi chuyển hết.
- Giao diện: nút "Chuyển việc" ở khung chi tiết Nhân viên, trong hộp "Cho nghỉ việc" (khi còn việc dở) và trong form Người dùng.
