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
| POST | /timesheets/:period/close | hr.manage | chốt công: ghi snapshot `timesheet_days` + status closed. Còn punch pending / thiếu công chưa xử lý → 409 `unresolved_items` (details liệt kê), trừ khi `{force:true, reason}` |
| POST | /timesheets/adjustments | hr.manage | sai sót kỳ đã chốt → dòng điều chỉnh vào kỳ sau |

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
- monthly: `base_pay = round(base_salary × paid_days / hr.standard_workdays)`, paid_days = ngày có công + phép có lương + lễ nghỉ hưởng lương (tối đa standard_workdays); hourly: `hourly_rate × worked_minutes/60`; shift: `shift_rate × shifts_worked`.
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
| hr.manage / hr.sensitive / payroll.write | ✓ | | | | ✓ | | |
| payroll.approve | ✓ | | | | | | |
| competitors.view / write | ✓ | ✓ | | | | | |
| purchasing.view | ✓ | ✓ | | ✓ | | | |
| promotions.write / approve, loyalty.adjust | ✓ | ✓ | | | | | |
