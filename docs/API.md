# Hợp đồng API — Đợt 1 (M1, M2, M3, M6)

Nguồn sự thật cho backend và frontend. Thay đổi hợp đồng phải sửa file này trước.

## Quy ước chung

- Base: `/api/v1` (cần đăng nhập). Auth: `/api/auth/*`.
- Web/PWA: cookie phiên `__Host-hm_session` (HttpOnly) + **mọi request ghi phải gửi header `X-Requested-With: hm-erp`**. Gửi kèm `X-Device-Id: <uuid lưu trong localStorage>`.
- Tiền: số nguyên VND. Số lượng: **`qtyMilli`** = số nguyên milli đơn vị chính (1 kg = 1000; 1,85 kg = 1850; 3 trái = 3000). Khi client nhập theo đơn vị khác (thùng, khay) gửi `{ unit, qty }` và server quy đổi bằng `product_units.factor_milli`.
- Thời gian: ISO-8601 UTC do server sinh. Tham số ngày lọc `day=YYYY-MM-DD` hiểu theo giờ VN.
- Lỗi: `{ error: { code, message, details? }, requestId }`. Mã thường gặp: `validation_error` (422), `insufficient_stock` (409), `constraint_violation` (409), `version_conflict` (409), `approval_required` (409, details.approvalId), `period_locked` (423), `forbidden` (403).
- Danh sách: `?q=&limit=50&cursor=` → `{ items: [...], nextCursor }`.
- Khoá lạc quan (EC-38): bản ghi có `version`; PUT phải gửi `version`, sai → 409 `version_conflict`.
- Mọi thay đổi quan trọng ghi `audit_log` **trong cùng D1 batch** (dùng `auditStmt`).

## Auth (đã làm)
| Method | Path | Ghi chú |
|---|---|---|
| POST | /api/auth/login | `{username,password,deviceId?}` → `{token,expiresAt,mustChangePassword}` + cookie |
| POST | /api/auth/logout | |
| GET | /api/auth/me | `{id,username,fullName,role,storeId,deviceId,permissions[]}` |
| POST | /api/auth/change-password | `{current,next}` |
| POST | /api/auth/bootstrap | header `X-Bootstrap-Token`, chỉ khi chưa có user |

## Danh mục — `routes/products.ts` (M2-01, M2-15)
| Method | Path | Quyền | Body / kết quả |
|---|---|---|---|
| GET | /products?q=&groupId=&active= | inventory.view | items kèm `units[]`, `availableMilli`, `price` (giá POS hiện hành, nếu có quyền prices.view_sell), `avgCost` chỉ khi prices.view_cost |
| GET | /products/:id | inventory.view | chi tiết + units + lots còn tồn |
| POST | /products/:id/merge-into/:targetId | products.write (chỉ owner/manager) | EC-22/B-20: `{reason}` gộp mã trùng. Điều kiện: cùng đơn vị chính, đơn vị trùng tên phải cùng hệ số (422 `units_incompatible`), đích chưa bị gộp và còn active (409 `target_invalid`). Chuyển lô (kéo theo reservations), giá (đã có giá active ở bảng giá đích → dòng nguồn `superseded`), `external_products`, dòng đơn mở (draft…awaiting_payment), dòng phiếu kho/báo giá nháp, promotion_items, bundle/matches/NCC; đơn vị quy đổi còn thiếu; nguồn `merged_into=target, active=0`. Lịch sử đơn/stock_moves giữ nguyên mã nguồn; thẻ kho & báo cáo nhập-xuất-tồn gộp nguồn vào đích; `GET /products` không trả mã đã gộp; `lookup` theo barcode mã nguồn trả về mã đích. Ghi `product_merges` + audit. |
| GET | /products/lookup?code= | inventory.view | tra theo barcode sản phẩm / barcode đơn vị / lot_code → `{product, unit, lot?}`; ghi `scan_events` (result ok/unknown/expired) |
| POST | /products | products.write | `{sku,name,groupId?,baseUnit,sellByWeight,origin?,shelfLifeDays?,minStockMilli?,barcode?,units:[{unit,factorMilli,barcode?}]}`; không có barcode → sinh `internalBarcode('P',id)` |
| PUT | /products/:id | products.write | như trên + `version` |
| GET | /product-groups, POST /product-groups | inventory.view / products.write | |
| GET/POST/PUT | /suppliers | inventory.view / inventory.write | |
| GET | /locations | inventory.view | |

## Kho — `routes/inventory.ts` (M2)
Chứng từ `stock_docs` vòng đời: `draft → (pending_approval) → posted | cancelled`. Chỉ khi **post** mới tác động `lots` + `stock_moves` (một batch).

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /stock-docs?type=&status=&day= | inventory.view | |
| GET | /stock-docs/:id | inventory.view | kèm lines |
| POST | /stock-docs | inventory.write | `{type:'receipt'|'waste'|'adjust'|'count'|'transfer', locationId, toLocationId?, supplierId?, supplierRef?, vatAmount?, reason?, note?, lockLots?}` → draft. `lockLots` (chỉ `count`, EC-18): khoá lô tại vị trí — lô không được bán/giữ tồn/FEFO và phiếu huỷ/điều chỉnh/chuyển cùng vị trí bị 409 `count_in_progress` cho tới khi phiếu kiểm kê post/huỷ. `vatAmount` (receipt có NCC, VND nguyên ≥ 0, ≤ tổng phiếu khi ghi sổ, nếu vượt → 422 `vat_exceeds_total`) là VAT đầu vào, chuyển sang `supplier_bills.vat_amount` lúc post |
| POST | /stock-docs/:id/lines | inventory.write | receipt: `{productId,unit,qty,docQty?,unitCost,expiresAt?}` (unitCost theo đơn vị nhập → server đổi về đơn vị chính). waste/adjust/transfer: `{lotId,qty,unit,reason}`. count: `{lotId,countedQty,unit}` (server chụp `doc_qty` = tồn hệ thống LÚC ĐẾM, trả về `systemQtyMilli`). transfer: `{lotId,qty,unit}` — lô phải `active` (422 `lot_not_active` nếu cách ly/hết hạn) |
| POST | /stock-docs/:id/scan | inventory.write | `{code, qty?, unit?}` quét mã thêm dòng; cảnh báo M2-16 (unknown / expired / not_in_doc / duplicate) → 422 với code tương ứng, luôn ghi scan_events |
| DELETE | /stock-docs/:id/lines/:lineId | inventory.write | chỉ khi draft |
| POST | /stock-docs/:id/post | inventory.write | receipt: tạo `lots` (lot_code = internalBarcode('L',id)), moves `receipt`; chênh lệch doc vs thực lưu ở line. waste: trừ lô, nếu tổng hao hụt > `approval.waste_pct_bp` × lượng nhập của lô **hoặc** người tạo không có inventory.approve → chuyển `pending_approval` + tạo `approvals`. count (B-02): chênh lệch = số đếm − tồn hệ thống lúc đếm (không phải tồn lúc post) nên biến động hợp lệ giữa lúc đếm và lúc post không thành chênh lệch ảo; lô có biến động → response `warnings:[{code:'lot_moved_since_count',lotId,snapshotMilli,currentMilli,deltaMilli}]` (không chặn); nếu tồn lô đã giảm tới mức số đếm làm âm → 409 `count_stale`; người lập không có `inventory.approve` mà có chênh lệch → chờ duyệt (B-10); tạo moves `adjust` theo chênh; giá trị chênh > `approval.count_diff_vnd` → pending_approval. transfer (B-19/EC-21, 2 bước): post chỉ ghi `transfer_out` và đặt `transferStatus='in_transit'` — hàng đang đi đường, không nằm ở lô nào nên không bán được ở nguồn lẫn đích; lô mới ở đích chỉ tạo khi `/receive`. **Tự động chuyển phần giữ (B-03):** nếu waste/adjust/count/transfer vượt phần khả dụng (tồn − đã giữ) của lô nhưng còn trong tồn, hệ thống chuyển phần giữ của các đơn sang lô tốt khác theo FEFO rồi mới ghi; không chuyển được → 409 `insufficient_stock` với `details:{reservedQty, availableMilli, hint:'quarantine'}` (dùng `/lots/:id/quarantine`). |
| POST | /stock-docs/:id/receive | inventory.write | Nhận phiếu chuyển kho `in_transit`: `{reason?, lines?:[{lineId,qty,reason?}]}` (không gửi = nhận đủ; `qty` theo đơn vị của dòng). Tạo lô tại `to_location_id` giữ nguyên `received_at`, `expires_at`, `unit_cost` và `qty_in_milli` của lô nguồn (để % hao hụt tính theo lượng nhập gốc), moves `transfer_in`; nhận thiếu → move `waste` cho phần thiếu, bắt buộc lý do (422 `reason_required`), vượt `approval.count_diff_vnd` mà không có `inventory.approve` → 403 `approval_required`. 409 `already_received` nếu nhận lại. |
| POST | /lots/:id/quarantine | inventory.write | B-03/EC-15: `{reason}` (≥3 ký tự) đặt lô `status='quarantine'` (không bán/FEFO/POS/giữ tồn) rồi NGAY LẬP TỨC chuyển phần giữ cho đơn B2B/online sang lô tốt khác (FEFO, cùng cửa hàng). Phần không thay được: nhả giữ, `orders.reservation_short_milli/_at`, ghi `notifications` (cho `inventory.approve`), job push `notify.managers`, audit. Trả `{lot, swappedOrders[], shortOrders[{orderId,orderCode,orderLineId,lotCode,missingMilli}]}`. Sau đó waste/adjust/count phần không giữ của lô được phép. 409 nếu lô không `active`. |
| POST | /lots/:id/release-quarantine | inventory.approve | `{reason}` đưa lô về `active` |
| GET | /notifications?unread=1 | inventory.view | thông báo trong ứng dụng (chỉ những thông báo mà vai trò có quyền `audience_perm`); `{items,unread}` |
| POST | /notifications/:id/read | inventory.view | đánh dấu đã đọc |
| POST | /stock-docs/:id/cancel | inventory.write | chỉ draft/pending |
| GET | /stock/lots?productId=&status= | inventory.view | |
| GET | /stock/card?productId=&from=&to= | inventory.view | thẻ kho từ stock_moves (gồm lịch sử các mã đã gộp vào mã này — EC-22) |
| GET | /stock/alerts | inventory.view | `{lowStock:[...], expiringSoon:[... ≤2 ngày], expired:[...], quarantined:[...]}` (M2-09) |
| GET | /stock/lots/:lotCode/trace | inventory.view | M2-19: nhập từ ai, ngày nào, bán đơn nào |

Quy tắc bắt buộc: không có endpoint sửa tồn trực tiếp; lô `expired` chỉ được xuất qua waste.

**Giao hàng không lấy lô hỏng (B-04):** `consumeForDeliveryStmts` (giao B2B `/deliveries/:id/confirm`, ship đơn online, giao đơn đặt trước) trước khi xuất kho chạy lại swap cho các lô đang giữ của đơn mà đã hết hạn/không `active`; không thay được → 409 `lot_expired` với `details.lines[{orderLineId,productId,lotCode,missingMilli}]` (đơn được đánh dấu thiếu hàng + báo quản lý). Cron 08:00 chạy swap cho mọi cửa hàng. POS chỉ bán lô `active`, chưa hết hạn, không bị khoá kiểm kê.

## Giá — `routes/prices.ts` (M3)
| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /price-lists | prices.view_sell | |
| POST | /price-lists | prices.write | `{name,channel,customerGroupId?,kind,priority}` |
| GET | /prices?priceListId=&productId= | prices.view_sell | giá hiện hành theo list |
| GET | /prices/history?productId= | prices.view_sell | M3-04 giá bán theo thời gian; nếu có prices.view_cost thì kèm giá mua theo lô/NCC (M3-05) |
| POST | /prices/bulk | prices.write | M3-03 `{priceListId, effectiveFrom?, items:[{productId, unitPrice}], note?}`; mỗi item: dòng giá cũ đang hiệu lực được set `effective_to = effectiveFrom` khi dòng mới có hiệu lực (giữ lịch sử, không UPDATE giá cũ). Nếu người tạo không có prices.approve → status `pending` + approvals (M3-09). Giá mới < avgCost → cảnh báo `belowCost:[productId]` trong response. |
| POST | /prices/:id/approve, /prices/:id/reject | prices.approve | |
| GET | /prices/quote?productId=&channel=&customerGroupId= | prices.view_sell | dùng `resolvePrice` |
| GET | /prices/suggested?groupId= | prices.view_cost | M3-07 avgCost × (1 + target_margin_bp/10000) |

## Bán hàng tại quầy — `routes/pos.ts` (M1)
| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /shifts/current | pos.shift | ca đang mở của user |
| POST | /shifts/open | pos.shift | `{openingCash}`; mỗi user 1 ca open |
| POST | /shifts/:id/close | pos.shift | `{countedCash, diffReason?}` → expected = opening + tiền mặt thu − tiền mặt hoàn; chênh ≠0 bắt buộc diffReason (EC-32). Trả báo cáo cuối ca M1-10: doanh thu theo kênh, theo hình thức TT, top 10 hàng bán chạy |
| POST | /pos/orders | pos.sell | **checkout 1 bước**: `{clientUuid, customerId?, lines:[{productId, unit, qty, unitPriceOverride?, discount?}], discount?, payments:[{method, amount, ref?}], note?}`. Server: resolvePrice(channel pos) → nếu override/discount vượt `approval.discount_pct_bp` hoặc giá < giá vốn lô (M3-06) và user không có approvals.decide → 409 `approval_required`. allocateFefo từng dòng; tổng payments phải = total (tiền mặt được phép > total, trả `change`). Một batch: update status/total, order_lines, order_line_lots, moveStatements(sale), payments, audit. Lỗi CHECK → retry phân bổ 1 lần rồi trả 409 insufficient_stock. `clientUuid` trùng → trả lại đơn cũ (idempotent, EC-04). Response: đơn đầy đủ + `change`. |
| GET | /orders?day=&channel=&status=&shiftId= | orders.view | |
| GET | /orders/:id | orders.view | kèm lines, lots, payments; PII khách theo quyền |
| POST | /orders/:id/return | pos.return | EC-01 `{lines:[{orderLineId, qty, unit, restock:boolean, reason}], refundMethod}` → tạo order kind=return (mã TH-), cộng lại đúng lô gốc qua order_line_lots (restock) hoặc ghi hao hụt; refund payment âm; không vượt số đã mua trừ đã trả |
| | *(Đợt fix 4a, A-16)* | | Thu ngân (không có `approvals.decide`) chỉ tự trả khi: đơn thuộc **ca đang mở** (hoặc cùng ngày VN của ca còn mở), tổng trả **< `approval.pos_return_vnd`** (mặc định 500.000, [Cần xác nhận]) và **`restock=true`**. Ngược lại → 409 `approval_required` `{approvalId, reasons:[other_shift|high_value|no_restock]}` (approval `order.return`, gắn băm đơn gốc + dòng/SL/phương thức hoàn, không tự duyệt, dùng một lần). Quản lý duyệt tại `/approvals/:id/decide` rồi thu ngân gọi lại kèm `approvalId` (body thêm `approvalId?`); mã sai/đã dùng → 409 `approval_invalid`. Quản lý/chủ trả thẳng. Hoàn tiền mặt luôn ghi vào ca đang mở của người trả (không mở ca → 409 `no_open_shift`) |
| POST | /orders/:id/void | pos.void | chỉ đơn trong ca đang mở; đơn của ca đã chốt chỉ manager; ghi void_reason, hoàn kho đúng lô, audit before/after. **Đợt fix 4a**: (A-06) đơn của ca đã chốt có tiền mặt → tiền hoàn lấy từ két **ca đang mở của người huỷ**: `orders.refund_shift_id` = ca đó, `expected_cash` của ca đó bị trừ; số liệu ca đã chốt giữ nguyên; không có ca mở → 409 `no_open_shift` (đơn chỉ thanh toán không tiền mặt thì không cần ca). Không sinh phiếu quỹ (payments chuyển `refunded` đã làm giảm quỹ, tránh trừ đôi). (A-07) đơn đặt trước đã giao (có `order_deposits`) → 409 `preorder_void_blocked`: dùng **Trả hàng** (hoàn đủ tổng gồm cả phần cọc) |
| GET | /pos/receipt/:id | orders.view | dữ liệu in hoá đơn (JSON; client render để in/chia sẻ) |

## Thu chi & quỹ — `routes/finance.ts` (M6)
| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /funds | finance.view | kèm số dư = Σ payments confirmed (theo fund) + Σ vouchers in − out |
| GET | /cash-categories | finance.view | |
| GET | /vouchers?period=&fundId=&direction= | finance.view | |
| POST | /vouchers | finance.write | `{direction, fundId, categoryId, amount, counterparty?, note?, refType?, refId?}`; out > `approval.cash_out_vnd` và không có finance.approve → `pending_approval` + approvals |
| POST | /vouchers/:id/approve | finance.approve | |
| POST | /vouchers/:id/reverse | finance.write | tạo phiếu đảo (reverses_id) ở kỳ hiện tại — không sửa phiếu cũ (EC-33) |
| POST | /periods/:period/unlock | finance.lock_period (chỉ chủ) | Mở khoá sổ (C-16): body `{reason}` bắt buộc ≥ 5 ký tự (422 `fields.reason`); kỳ chưa khoá → 409 `not_locked`; audit `period.unlock` kèm `reason`, before/after. Chỉ đụng bảng `periods` — khoá bảng công (`timesheets`) và bảng lương (`payroll_periods`) độc lập. `GET /periods` trả thêm `locked_by_name`, `lockable`. |
| GET | /reconcile/shifts?day= | finance.shift_reconcile | M6-03 danh sách ca, expected vs counted |
| GET | /periods, POST /periods/:period/lock | finance.view / finance.lock_period | Khoá sổ (B-08): chỉ khoá được kỳ **đã kết thúc** (kỳ hiện tại/tương lai → 422 `period_not_ended`). Kỳ đã khoá → 423 `period_locked` cho: phiếu quỹ (trigger), chốt hoá đơn mua tạm (theo ngày hoá đơn), phiếu thu/chi công nợ + gạch nợ (theo `paidAt` và hôm nay), điều chỉnh công nợ, trả hàng B2B, huỷ/trả/hoàn tiền đơn online (lập ngày hôm nay). Phiếu chi chờ duyệt trong kỳ vừa khoá vẫn từ chối được. |

## Báo cáo — `routes/reports.ts`
| GET | /reports/pnl?from=YYYY-MM-DD&to=&groupBy=day|channel|group | reports.view | Bổ sung: `expenses.badDebt` (xoá nợ khách hàng), `expenses.stockCount` (chênh lệch kiểm kê/điều chỉnh theo giá vốn lô, ± ), `revenueDeductions.paymentDiscount` (chiết khấu thanh toán phải thu), `otherIncome{forfeitedDeposits,payableDiscounts,settlementSurplus,otherReceipts,total}` (B-11: `otherReceipts` = phiếu thu của khoản mục có dòng P&L như THU_KHAC, phiếu đảo trừ lại đúng dòng; khoản mục `transfer` như SO_DU_DAU_KY (số dư quỹ đầu kỳ, id 907) không vào P&L), `expenses.purchaseVariance` (B-09, chênh lệch giá mua khi chốt hoá đơn NCC); `netProfit = lãi gộp − chiết khấu − chi phí + thu khác`; cùng quy tắc ở /reports/pnl-by-channel. | M6-04: doanh thu (orders sale − return), giá vốn (Σ cost_amount), lãi gộp; chi phí từ vouchers theo pnl_line (hao hụt từ phiếu waste quy ra tiền tính vào chi phí, không vào giá vốn) |
| GET | /reports/inventory?asOf= | reports.view | nhập–xuất–tồn theo mặt hàng (M2-08) + hao hụt |
| GET | /reports/daily?day= | reports.view | M1-10 |
| GET | /reports/export/:name.csv | reports.view | CSV UTF-8 BOM cho Excel (M6-05 tạm thời; mẫu kế toán [Cần xác nhận]) |

## Duyệt & người dùng — `routes/admin.ts`
| GET | /approvals?status=pending | approvals.decide | |
| POST | /approvals/:id/decide | approvals.decide | `{decision:'approved'|'rejected', note}`; áp dụng tác động tương ứng (post chứng từ kho, kích hoạt giá, post phiếu chi) |
| GET/POST/PUT | /users | users.manage | tạo user với mật khẩu tạm + must_change_password=1; PUT `active=0` → thu hồi mọi session (EC-39) |
| GET | /audit?entity=&entityId=&action=&userId=&from=&to=&cursor=&limit= | audit.view | `from` ≥, `to` <, ISO UTC; phân trang `nextCursor`. Vai trò không có `hr.sensitive` thấy `before_json`/`after_json` của hr/payroll/employee/salary_advance là `"***"` (che lương). |
| GET | /settings | settings.view (chủ + quản lý) | Trả `{groups:[{group, items:[{key,label,help,type,unit,min,max,options,value,note,needsConfirm,confirmed,confirmedAt,confirmedByName,pending}]}], unknown:[{key,value,note}], pendingCount, canWrite, items:[{key,value,note}]}`. Danh mục khoá/nhóm/kiểu/giới hạn ở `services/settings-registry.ts` (test bắt buộc mọi khoá trong migrations+seed có mặt). `type`: `vnd`, `bp` (basis point, hiển thị %), `int` (+`unit`), `bool` (0/1), `enum`, `multi` (CSV), `intlist`, `text`, `pit` (JSON biểu thuế `[[trần|null, bp],…]`). `needsConfirm` = ghi chú trong DB chứa "[Cần xác nhận"; `pending` = cần xác nhận mà chưa có dòng trong `settings_confirmations`. Khoá lạ chỉ liệt kê thô ở `unknown`; giá trị khoá tên giống bí mật (secret/token/password/api_key) luôn là `***`. Secret tích hợp nằm ở env Worker, không bao giờ trả ra. |
| PUT | /settings | settings.manage (chỉ chủ) | `{settings:{key:value}, confirm?:[key]}` — mỗi khoá kiểm theo registry; sai → 422 `validation_error` với `error.details.fields{key:thông báo}` và **không ghi gì**. Khoá lạ → 422. Ghi một batch: giá trị đổi + dòng `settings_confirmations` (khoá có trong `settings` hoặc `confirm` coi là chủ đã xác nhận) + audit `settings.update` (`before_json`/`after_json` là map theo khoá, chỉ khoá thực sự đổi) và `settings.confirm` cho khoá chỉ xác nhận. `einvoice.provider=misa` cần đã cấu hình MISA. Trả cùng dạng GET. |
| GET | /audit/facets | audit.view | danh sách `actions`, `entities`, `users` cho bộ lọc nhật ký |

## Báo cáo cuối ngày & lịch sử ca — `routes/reports.ts`, `routes/shift-report.ts`
Chỉ đọc, không thêm quyền mới. Tiền số nguyên VND; ngày theo giờ VN (`YYYY-MM-DD`). Không trả giá vốn/lãi gộp trừ `GET /reports/daily` khi người xem có `prices.view_cost` (khoá `cogs`, `grossProfit`).

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | /reports/daily?day= | reports.view | Giữ nguyên các khoá cũ (`saleCount`, `saleTotal`, `returnCount`, `returnTotal`, `revenue`, `byChannel`, `byMethod`, `topProducts`, `vouchers`, `shifts`, `voided`). **Bổ sung:** `byPayment[{method,sold,refunded,net,kind}]` (method: cash, transfer, qr, card, ewallet, points, voucher, credit; thêm cod/marketplace khi có; luôn đủ 8 hình thức chính kể cả 0; `kind:"discount"` cho `points`/`voucher` = giảm trừ không thu tiền, `sold` = giá trị giảm; `refunded` = tiền hoàn trên phiếu trả); `returns{count,total,byMethod[{method,amount}]}`; `cancelled{count,total}` (huỷ đơn theo thời điểm huỷ trong audit `order.void`); `cashFlow{in,out,byCategory[{direction,category,count,amount}]}` (phiếu thu/chi đã ghi sổ trong ngày, ròng: phiếu đảo trừ vào chiều của phiếu gốc); `shifts[]` thêm `opened_at`, `closed_at`; `cogs`, `grossProfit` chỉ khi có `prices.view_cost`. `day` sai → 422. |
| GET | /shifts/history?from=&to=&userId=&status=open\|closed&limit=&cursor= | `pos.shift` hoặc `reports.view` | Lịch sử ca, mới nhất trước, `{items,nextCursor}` (`cursor` = id ca cuối trang trước, `limit` 1–200, mặc định 50). Thu ngân (không có `reports.view`) chỉ thấy ca của mình, `userId` bị bỏ qua; chủ/quản lý/kế toán thấy mọi ca. `from`/`to` lọc theo giờ mở ca (gồm cả hai đầu). Mỗi dòng: `id, cashierId, cashierName, status, openedAt, closedAt, openingCash, expectedCash, countedCash, diffCash, diffReason, saleCount, saleTotal, returnTotal, revenue`. Tham số sai → 422; vai trò khác (thủ kho, nhân viên…) → 403. |
| GET | /shifts/:id/summary | `pos.shift` hoặc `reports.view` | Chi tiết ca (đang mở hoặc đã chốt) — dữ liệu cho phiếu bàn giao: `shift{id,status,cashierId,cashierName,storeName,openedAt,closedAt,openingCash,expectedCash,countedCash,diffCash,diffReason}` (ca đang mở: `expectedCash` tính tại thời điểm xem), `sales{saleCount,saleTotal,returnCount,returnTotal,revenue}`, `byChannel[]`, `byPayment[]` (như trên), `cashFormula{opening,cashSold,cashRefunded,deposits,voidRefunds,expected}` (cùng công thức `/shifts/:id/close`: đầu ca + thu mặt − hoàn mặt ± cọc − hoàn mặt khi huỷ đơn), `vouchers{in,out,items[{code,direction,amount,category,note,createdAt,inExpected}]}` (phiếu quỹ do người mở ca lập trên quỹ của ca; chỉ `inExpected:true` = cọc đặt trước được tính vào két), `returns[{code,total,completedAt,methods[]}]`, `voided{count,total}` (huỷ đơn có hoàn tiền từ két ca này). Thu ngân xem ca người khác → 404. |

Giao diện: màn `/reports/daily` (Báo cáo cuối ngày; in A4/80mm, xuất CSV), `/shift-history` (Lịch sử ca + in lại phiếu bàn giao); màn Chốt ca hiện bán theo hình thức thanh toán trước khi chốt.

## Khách lẻ — `routes/retail-customers.ts`
Chỉ khách `type='retail'`; không lẫn khách sỉ (route `/customers` vẫn chỉ là khách sỉ, không đổi). Khách đã gộp (`merged_into`) không xuất hiện trong danh sách. Màn: `screens/RetailCustomers.tsx` (menu "Khách lẻ", nhóm Bán lẻ). Quyền xem = `b2b.view`; sửa / ngừng / gộp / gán nhóm = `b2b.write` (chủ, quản lý). Không có quyền `customers.view_pii` thì SĐT/email/địa chỉ bị che (`090****222`, `***`) và **không tìm được theo SĐT**. Sửa/ngừng/gộp đều kiểm `version` (lệch → 409 `version_conflict`; đồng thời trong batch → 409 `state_changed`).
| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /retail-customers?q=&customerGroupId=&hasPoints=1\|0&purchased=0\|1&lastFrom=&lastTo=&status=active\|inactive\|all&cursor=&limit= | b2b.view | `q` khớp tên/mã (+ SĐT nếu có `customers.view_pii`); `lastFrom`/`lastTo` = ngày mua gần nhất (YYYY-MM-DD giờ VN); `status` mặc định `active`. Trả `{items:[{id,code,name,phone,email,birthday,gender,address,note,customerGroupId,groupName,points,active,version,createdAt,spend,ordersCount,lastPurchaseAt}], nextCursor, summary:{count,totalSpend,totalPoints}}`. `spend` = đơn bán hoàn tất trừ phiếu trả hoàn tất, mọi kênh. |
| GET | /retail-customers/:id | b2b.view | Thông tin + `loyalty:{enabled,pointValueVnd,ledger[200 gần nhất]}`, `orders[100 gần nhất, mọi kênh]`, `shopAccounts[]` (email/SĐT che nếu thiếu quyền), `mergedFrom[]`. Khách sỉ → 404 `customer_not_found`. |
| PATCH | /retail-customers/:id | b2b.write | `{version, name?, phone?, email?, birthday? (YYYY-MM-DD hoặc MM-DD), gender? (male\|female\|other), address?, note?, customerGroupId?}` (null để xoá). SĐT trùng khách lẻ đang hoạt động khác → 409 `phone_duplicate` (dùng Gộp). Audit `retail_customer.update` (before/after). |
| POST | /retail-customers/:id/active | b2b.write | `{active, version, reason?}`. Ngừng: không còn hiện khi tìm ở POS; lịch sử và điểm giữ nguyên. Audit `retail_customer.deactivate/activate`. |
| POST | /retail-customers/assign-group | b2b.write | `{ids[1..200], customerGroupId}` → `{updated}`. |
| POST | /retail-customers/:id/merge | b2b.write | `{targetId, version, targetVersion, reason(≥3)}` gộp khách `:id` (nguồn) vào `targetId` (đích, phải đang hoạt động). Một batch: chuyển `orders`, `vouchers`, `voucher_redemptions`, `shop_accounts` sang đích; điểm chuyển bằng 2 dòng sổ điểm `adjust` (−nguồn, +đích; **không sửa/xoá dòng cũ**); điền trường còn trống của đích (SĐT, email, ngày sinh, giới tính, địa chỉ); nguồn `active=0`, `merged_into=đích`; audit `retail_customer.merge`. Trả `{target, ordersMoved, pointsMoved}`. Lỗi: 422 `merge_same`, `target_inactive`, `has_b2b_documents` (nguồn có hoá đơn/báo giá/đơn lặp), 409 `customer_merged`, `version_conflict`. Không hoàn tác được. |
