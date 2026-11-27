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
## Đợt 8 — Nhập Excel hàng loạt, xuất dùng nội bộ, chuyển quỹ (migration `0035_import_internal_transfer.sql`)

### Nhập Excel/CSV hàng loạt — `routes/imports.ts`, `services/import-excel.ts`, `services/import-parse.ts`
Dùng khi go-live để nạp danh mục. Chỉ ba loại (`:kind` = `products` | `customers` | `suppliers`); **không đụng tồn kho** (tồn đầu kỳ nhập bằng phiếu nhập). Quyền theo từng loại = quyền tạo danh mục tương ứng. Màn hình: **Kho & hàng → Nhập Excel** (`/import`).

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /imports/:kind | `products.write` / `b2b.write` / `inventory.write` (products / customers / suppliers) | Mô tả cột: `{kind,title,notes,limits:{maxBytes,maxRows},columns:[{key,header,required,hint}]}`. Loại lạ → 404 `import_kind_not_found` |
| GET | /imports/:kind/template.xlsx · template.csv | như trên | File mẫu: xlsx 2 trang (Dữ liệu + Hướng dẫn), csv UTF-8 BOM. Có dòng ví dụ (mã `VD-...`) cần xoá trước khi tải lên |
| POST | /imports/:kind/preview | như trên | `multipart/form-data`, trường `file` (.xlsx hoặc .csv UTF-8; ≤ 2 MB, ≤ 1000 dòng dữ liệu; dấu phân cách csv `,` `;` hoặc tab tự nhận). **Không ghi gì.** Trả `{kind,filename,format,summary:{lines,create,exists,merged,error},ignoredColumns[],rows:[{line,status:'create'\|'exists'\|'merged'\|'error',key,label,errors[],warnings[],changes[],fields{}}]}`. `exists` = trùng mã với dữ liệu đang có (`changes` liệt kê chỗ khác biệt); `merged` = dòng khai thêm đơn vị quy đổi cho cùng mã hàng. Lỗi cấp file: 422 `missing_columns` / `file_too_large` / `too_many_rows` / `bad_encoding` / `bad_file` / `empty_file` / `file_required` |
| POST | /imports/:kind/commit | như trên | Cùng file + trường `mode` = `skip` (mặc định: dòng trùng mã giữ nguyên) \| `update` (cập nhật theo file). Phân tích lại rồi ghi **các dòng hợp lệ** trong **một `db.batch`** kèm audit `import.<kind>` (`after`: mode, fileHash, created, updated, skipped, errors); dòng lỗi bị bỏ qua. 201 `{kind,filename,mode,created,updated,skipped,errors}`. Không có gì để ghi → 422 `nothing_to_import`. Cùng nội dung file + cùng `mode` chỉ ghi được một lần (`onceStmt` `import.<kind>` theo SHA-256) → 409 `already_done`; mã bị người khác tạo chen giữa → 409 `duplicate` và không ghi gì |

Quy tắc theo loại:
- **products** — cột: Mã hàng*, Tên hàng*, Đơn vị chính*, Nhóm hàng (chưa có → tạo mới, giá trị 30% biên mục tiêu mặc định), Bán theo cân (Có/Không), Mã vạch (trống → sinh `HMP…`), Đơn vị quy đổi + Hệ số quy đổi (+ Mã vạch đơn vị quy đổi), Giá bán chung, Hạn dùng (ngày), Xuất xứ, Tồn tối thiểu. Dòng thứ hai cùng Mã hàng với Tên hàng để trống = thêm đơn vị quy đổi. Mã hàng so khớp không phân biệt hoa/thường; mã vạch trùng (trong DB hoặc trong file) → lỗi dòng. Hàng đã có: `update` đổi tên/nhóm/cân/mã vạch/xuất xứ/hạn dùng/tồn tối thiểu (chỉ cột có giá trị), upsert đơn vị quy đổi, `version+1`; **không đổi được đơn vị chính**. Giá bán chung ghi vào bảng giá `kind='base'`: người có `prices.approve` → giá `active` (đóng dòng cũ như `/prices/bulk`), người chỉ có `prices.write` → `pending` + `approvals price.activate`; người không có `prices.write` → cột giá bị bỏ qua (cảnh báo)
- **customers** — khách sỉ (`type='b2b'`). Cột: Mã khách (trống → `KH-xxxx` từ `doc_sequences`), Tên khách*, Nhóm khách* (tên hoặc mã), SĐT, Email, Mã số thuế, Địa chỉ giao hàng* (khách mới), Người nhận, SĐT người nhận, Hạn mức nợ, Hạn thanh toán (ngày), Ghi chú. Tạo kèm 1 liên hệ nhận hàng + 1 địa chỉ mặc định. Trùng theo Mã khách, hoặc theo SĐT khi để trống mã. Hạn mức/hạn thanh toán vượt `b2b.new_credit_limit_max_vnd` / `b2b.new_payment_terms_max_days` chỉ người có `b2b.credit_override` (chủ) đặt được; khách đã có: chỉ chủ đổi hai giá trị này qua `update`
- **suppliers** — cột: Mã NCC (trống → `NCC-YYYYMMDD-nnnn`), Tên nhà cung cấp*, SĐT, Địa chỉ, Mã số thuế, Hạn thanh toán (ngày). Trùng theo Mã NCC, hoặc theo tên khi để trống mã
- **Chống chèn công thức**: ô xlsx có `<f>` bị báo lỗi (không bao giờ tính công thức); ô chữ bắt đầu bằng `=`, `+`, `-`, `@`, tab, CR (trừ số/SĐT dạng `+84…`) bị báo lỗi dòng. File xuất/mẫu dùng chuỗi inline hoặc tiền tố `'`.

### Xuất dùng nội bộ — `routes/inventory.ts`
Loại chứng từ kho mới `stock_docs.type='internal_use'` (mã `XN-YYYYMMDD-nnnn`), dùng chung `/stock-docs*` (quyền `inventory.write`; xem/duyệt như phiếu khác):
- `POST /stock-docs {type:'internal_use', locationId, reason (bắt buộc ≥ 3 ký tự — lý do/mục đích), note?}` — thiếu lý do → 422 `validation_error` (`fields.reason`).
- `POST /stock-docs/:id/lines` cho `internal_use`: `{productId, qty, unit}` (hệ thống chọn lô **FEFO** tại vị trí của phiếu — bỏ lô hết hạn/cách ly/đang khoá kiểm kê/đã giữ cho đơn — và tạo một dòng cho mỗi lô; thiếu tồn → 409 `insufficient_stock`) **hoặc** `{lotId, qty, unit}` (chọn đích danh lô; lô hết hạn → 422 `lot_expired`). Quét tem lô (`/scan`) cũng dùng được.
- `POST /stock-docs/:id/post`: kiểm khoá sổ (`assertPeriodOpen` → 423 `period_locked`), ghi `stock_moves.move_type='internal_use'` (số âm, theo giá vốn lô; bảng bất biến chỉ INSERT) trong cùng batch với chốt chặn post/huỷ. Giá trị (giá vốn) > `approval.internal_use_vnd` (mặc định 500.000đ, nhóm "Ngưỡng duyệt" trong Cài đặt) **hoặc** người lập không có `inventory.approve` → `pending_approval` + `approvals` (`stock_doc.post`), duyệt ở `/approvals/:id/decide` như hao hụt.
- Báo cáo: `/reports/pnl` có `expenses.internalUse` ("Xuất dùng nội bộ", theo giá vốn lô, không trùng hao hụt/kiểm kê) và vào `totalExpenses`/`netProfit`; `/reports/pnl-by-channel` liệt kê ở `unallocated` ("Xuất dùng nội bộ"); `/reports/budget-vs-actual` cộng vào dòng `opex`; PDF/CSV lãi lỗ có dòng riêng. `/reports/inventory` và xuất `nhap-xuat-ton.xlsx` có cột riêng `internalUseMilli` ("Xuất dùng nội bộ"): Tồn đầu + Nhập − Bán + Trả − Hao hụt − Xuất dùng nội bộ + Lắp ráp + Điều chỉnh = Tồn cuối.

### Chuyển tiền giữa các quỹ — `routes/fund-transfers.ts`
Một thao tác tạo **cặp phiếu liên kết** (phiếu chi quỹ nguồn + phiếu thu quỹ đích, `ref_type='fund_transfer'`) thuộc khoản mục `CHUYEN_QUY_RA` (910) / `CHUYEN_QUY_VAO` (911) có dòng P&L `transfer` → không vào lãi lỗ. Một `db.batch` kèm audit. Màn hình: **Thu chi → Chuyển quỹ**.

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /fund-transfers?fundId=&status=posted\|reversed&from=&to=&cursor=&limit= | finance.view | `{items:[{id,code (CQ-…),fromFundId,fromFundName,toFundId,toFundName,amount,note,period,status,createdAt,createdByName,reversedAt,reverseReason,outVoucherId,outVoucherCode,inVoucherId,inVoucherCode}],nextCursor}` |
| POST | /fund-transfers | finance.write | `{fromFundId,toFundId,amount,note?,idempotencyKey?}`. 422: `same_fund`, `fund_not_found`, `clearing_fund` (quỹ chờ đối soát COD/sàn/thẻ chuyển bằng luồng đối soát), `insufficient_fund` (số dư quỹ nguồn < số tiền — chốt chặn `assertStmt` nên bấm đồng thời hai lệnh vượt số dư chỉ một lệnh thành công, lệnh kia 409 `state_changed`); 423 `period_locked`. `idempotencyKey` (client sinh UUID mỗi lần mở form): gửi lại cùng khoá → 409 `already_done`, không tạo thêm. 201 trả phiếu chuyển |
| POST | /fund-transfers/:id/reverse | finance.write | `{reason ≥ 3}`: đảo **cả cặp** ở kỳ hiện tại (hai phiếu đảo `reverses_id`, tiền về quỹ nguồn, rút khỏi quỹ đích); đã đảo → 409 `already_reversed`; quỹ đích không đủ số dư để hoàn → 422 `insufficient_fund`; kỳ hiện tại đã khoá → 423. Đảo lẻ từng phiếu qua `/vouchers/:id/reverse` vẫn bị chặn (409 `managed_voucher`) |

## POS-KV đợt B — bán nợ khách lẻ (B1) và thu khác (B2) (`docs/POS-KV-B.md`)

Migration `0038_pos_credit.sql` (tham số), `0039_order_charges.sql` (`charge_types`, `order_charges`, `orders.charges_total`). Quyền mới: `pos.credit`, `pos.other_charge` (chủ, quản lý). Mã `HDS…` là mã thanh toán của hoá đơn nợ (cùng luồng SePay khách sỉ).

### Tham số (Cài đặt → Công nợ / Ngưỡng duyệt)
`pos.retail_credit_enabled` (mặc định 0 = tắt), `pos.retail_credit_default_limit` (0), `pos.retail_credit_default_terms_days` (7), `approval.pos_credit_vnd` (500.000). Khách lẻ tạo nhanh ở quầy nhận hạn mức/kỳ hạn mặc định; kỳ hạn riêng của khách = 0 thì dùng kỳ hạn mặc định.

### `POST /pos/orders` — thêm trường
- `charges?: [{ chargeTypeId?, name?, amount }]` (≤ 10). Loại có sẵn: phải còn hoạt động; số tiền khác mặc định (khi mặc định > 0) hoặc nhập tay (không `chargeTypeId`, cần `name`) cần quyền `pos.other_charge` (403 nếu thiếu). Tổng đơn = hàng − giảm giá − khuyến mãi/voucher/điểm + Σ charges; **thu khác không bị giảm giá, không tích điểm**. 422 `charge_type_not_found`, `charge_name_required`.
- `credit?: { amount }` — phần ghi nợ; phải bằng đúng `total − Σ payments` (`payments` có thể rỗng). Lỗi: 409 `credit_disabled` (đang tắt), 422 `credit_needs_customer` (không có khách lẻ có SĐT), 422 `credit_mismatch`, 422 `credit_offline_not_allowed` (đơn offline có `soldAt`), 409 `credit_limit_exceeded` (`details:{creditLimit, outstanding, available}`) khi khách có hạn mức 0 (chưa được bán nợ — quản lý phải đặt hạn mức trước, không có đường duyệt), 423 `period_locked`. **Vượt hạn mức (> 0)** (nợ đang mở + ghi nợ > `credit_limit`) → 409 `approval_required` (approval `order.credit`, kể cả quản lý/chủ; người duyệt cần `pos.credit`, chủ duyệt được chính mình, người khác không tự duyệt); duyệt xong gửi lại kèm `approvalId` thì `assertStmt` cho vượt, phiếu duyệt gắn băm giỏ + số ghi nợ + khách, dùng một lần (`onceStmt` + `ref_id`; dùng lại → 409 `approval_invalid`). Hai quầy ghi nợ đồng thời không có duyệt: `assertStmt` hạn mức đặt đầu batch → chỉ một đơn qua, đơn kia 409 `credit_limit_exceeded`. Ghi nợ > `approval.pos_credit_vnd` mà người bán không có `pos.credit`/`approvals.decide` → 409 `approval_required` (cùng approval `order.credit`).
- Ghi một batch: đơn hoàn tất như thường (kho FEFO), `payments` (phần đã thu) + 1 dòng `payments(method='credit', amount=ghi nợ, fund_id NULL)`, hoá đơn phải thu `invoices(kind='sale', order_id, customer_id, total=ghi nợ, issue_date=ngày bán VN, due_date=ngày bán+kỳ hạn, einvoice_status='not_required')`. `orders.paid_total` = tiền thực thu (không gồm nợ), `orders.charges_total` = Σ thu khác.
- Phản hồi đơn (`POST /pos/orders`, `GET /orders/:id`, `GET /pos/receipt/:id`) có thêm `charges:[{id,charge_type_id,name,amount,refunded_amount}]` (receipt: `[{name,amount}]`) và `credit: null | { invoiceId, invoiceCode, amount, outstanding, issueDate, dueDate, payCode, qrPayload }` — `payCode`/`qrPayload` (VietQR số tiền = còn nợ, nội dung = mã `HDS…`) chỉ có khi đã bật SePay (`sepay.enabled`, `sepay.flow_b2b`) và có tài khoản nhận tiền.

### Trả hàng / huỷ / đổi đơn có ghi nợ hoặc thu khác
- `POST /orders/:id/return` — thêm `refundCharges?: boolean`, `chargesReason?: string`. Mặc định **không hoàn** thu khác. `refundCharges=true` chỉ hợp lệ khi lần trả này làm đơn được trả hết (422 `charges_refund_partial`) và có `chargesReason` (422 `charges_reason_required`); khi đó phiếu trả cộng phần thu khác chưa hoàn (`total` = hàng + thu khác, `charges_total` = phần hoàn) và `order_charges.refunded_amount` = `amount`.
- Đơn có hoá đơn nợ: giá trị trả trừ vào **còn nợ** của hoá đơn trước — hoá đơn `adjustment` âm trỏ `original_invoice_id` + dòng `payments(method='credit', amount âm)` trên phiếu trả; phần vượt mới hoàn tiền theo `refundMethod` (`orders.paid_total` của phiếu trả = tiền thực hoàn). Một batch (kèm `assertStmt` còn nợ đủ).
- `POST /orders/:id/void` — đơn có nợ: chỉ huỷ được khi hoá đơn chưa được thu đồng nào (409 `credit_already_paid` → dùng Trả hàng); sinh hoá đơn `adjustment` âm bằng toàn bộ nợ (hoá đơn đã phát hành không sửa/xoá).
- `POST /orders/:id/exchange` — đơn có ghi nợ: 409 `credit_order_no_exchange` (trả hàng rồi bán đơn mới).

### Thu nợ tại quầy — `routes/pos-credit.ts` (quyền `pos.sell`)
| Method | Path | Ghi chú |
|---|---|---|
| GET | /pos/credit-config | `{enabled, approvalVnd, canOverride}` — quầy biết có cho ghi nợ không và ngưỡng cần duyệt |
| GET | /pos/customers/:id/debts | Khách lẻ: `{customer:{id,code,name,phone*,creditLimit}, outstanding, unapplied, overdueAmount, available, invoices:[{id,code,orderCode,issueDate,dueDate,total,outstanding,overdueDays}]}` (chỉ hoá đơn còn nợ, cũ nhất trước) |
| POST | /pos/debt-payments | `{customerId, amount, method:'cash'\|'transfer', invoiceId?, ref?, idempotencyKey (≥ 8)}`. Gọi `createPayment` (phiếu thu M6 + `debt_payments` + gạch nợ + audit một batch). Tiền mặt vào quỹ của ca người thu (409 `no_open_shift` nếu chưa mở ca) và **cộng vào tiền mặt dự kiến của ca**; **`method:'transfer'` (tự khai) chỉ khi có `finance.write`** (thu ngân → 403; khách chuyển khoản thì quét QR `HDS`, SePay tự gạch), vào quỹ ngân hàng. Ca phải còn mở lúc ghi (409 `shift_closed`). 422 `amount_exceeds_debt`, `no_open_documents`, `allocation_invalid`; 409 `already_done` (trùng `idempotencyKey`); 423 `period_locked`. Không chọn `invoiceId` → gạch cũ nhất trước |
| POST | /pos/invoices/:id/pay-info | Mã `HDS…` + VietQR (số tiền = còn nợ hiện tại) của một hoá đơn nợ khách lẻ (không cần `debt.view`); POST vì lần đầu có thể phát hành mã. Chỉ hoá đơn khách lẻ đang còn nợ (khác → 404); `{available:false}` khi chưa bật SePay |

`cashFormula` (tiền mặt dự kiến của ca) thêm `debtCollected` = Σ phiếu thu công nợ khách hàng ở quỹ của ca do người mở ca lập trong ca (phiếu đảo trừ ngược): `expected = đầu ca + thu tiền mặt − hoàn + cọc + debtCollected − hoàn huỷ`. `GET /shifts/:id/summary` → `cashFormula.debtCollected`, `sales.otherCharges`.

### Khách lẻ — hạn mức và công nợ (`routes/retail-customers.ts`)
- `GET /retail-customers`, `/retail-customers/:id` — thêm `creditLimit`, `paymentTermsDays`; chi tiết có `debt: null | {outstanding, balance, unapplied, overdueAmount, oldestOverdueDays, available, invoices[], payments[]}` (chỉ khi có quyền `debt.view`).
- `PUT /retail-customers/:id/credit` (`b2b.write` + `b2b.approve`) `{version, creditLimit?, paymentTermsDays?, reason ≥ 3}`. Luồng A-10: chủ (`b2b.credit_override`) đặt tuỳ ý; quản lý chỉ tới `b2b.new_credit_limit_max_vnd` / `b2b.new_payment_terms_max_days` hoặc hạ xuống, phần vượt → approval `customer.credit_change` gửi chủ (phản hồi `creditApprovalPending:true`). 409 `version_conflict`.

### Loại thu khác — `routes/pos-credit.ts`
| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /charge-types?all=1 | `pos.sell` (`all=1` chỉ có tác dụng với `settings.manage`) | `{items:[{id,code,name,defaultAmount,active,version}]}` — mặc định chỉ loại đang dùng. Có sẵn: Phí đóng gói 5.000, Phí giao hàng 20.000, Phí giỏ quà 30.000 (id 901–903) |
| POST | /charge-types | `settings.manage` | `{code (A–Z,0–9,_ ; tự viết hoa), name, defaultAmount≥0}` → 201; 409 `code_duplicate` |
| PATCH | /charge-types/:id | `settings.manage` | `{version, name?, defaultAmount?, active?}`; 409 `version_conflict` |

### Báo cáo
- `GET /reports/daily`, `GET /shifts/:id/summary` → `otherCharges` (thu khác ròng sau hoàn, đã nằm trong doanh thu). `byPayment` có dòng `credit` ("Công nợ"): `sold` = phần ghi nợ, `refunded` = phần trả hàng đã trừ vào nợ; giao diện không cộng dòng này vào "Tổng thu tiền".
- `GET /reports/pnl` → `otherCharges`; với `groupBy=group` có thêm dòng `{key:"Thu khác", revenue, cogs:0}`, với `groupBy=day|channel` mỗi dòng có `otherCharges` (cộng vào `revenue`) để tổng breakdown = doanh thu.

### Nhập kết quả kiểm kho từ Excel/CSV — `routes/imports.ts`, `services/import-count.ts` (quyền `inventory.write`)
Vào MỘT phiếu kiểm kê **nháp** (`type=count`, `status=draft`; khác → 422 `not_count_doc` / 409 `doc_not_draft`). Chỉ ghi dòng đếm vào `stock_doc_lines`, **không ghi sổ** — ghi sổ/duyệt chênh lệch vẫn theo luồng kiểm kê hiện có (B-02, B-10).
| Method | Path | Ghi chú |
|---|---|---|
| GET | /stock-docs/:id/count-import | Mô tả cột + giới hạn (2MB, 1000 dòng) |
| GET | /stock-docs/:id/count-import/template.xlsx \| template.csv | Mẫu = danh sách lô còn tồn tại vị trí của phiếu (Mã lô, Mã hàng, Tên hàng, Đơn vị, Tồn hệ thống, Số đếm để trống) |
| POST | /stock-docs/:id/count-import/preview | multipart `file` (.xlsx/.csv). Không ghi gì. → `{docId, docCode, filename, format, summary:{lines, ok, skip, error, withDiff, warned}, ignoredColumns, rows:[{line, status:'ok'\|'error'\|'skip', lotCode, productName, sku, unit, baseUnit, systemQty, countedQty, diffQty, errors[], warnings[]}]}` |
| POST | /stock-docs/:id/count-import/commit | multipart `file` → 201 `{docId, docCode, filename, added, overwritten, skipped, errors}`; chỉ ghi các dòng hợp lệ trong một `db.batch` (kèm `assertStmt` phiếu còn nháp + tồn lô đúng như lúc xem trước, audit `import.count`). 422 `nothing_to_import` nếu không có dòng hợp lệ; 409 `state_changed` nếu phiếu/tồn lô vừa đổi (xem trước lại) |

Cột: `Mã lô` (hoặc `Mã hàng`/mã vạch), `Đơn vị` (trống = đơn vị chính), `Số đếm` (trống = chưa đếm, bỏ qua). Quy tắc khớp **an toàn, không đoán**: có mã lô → đúng lô (phải thuộc vị trí của phiếu; kèm mã hàng thì phải cùng mặt hàng); chỉ có mã hàng → dùng lô duy nhất còn tồn tại vị trí, **nhiều lô → lỗi yêu cầu mã lô** (không phân bổ FEFO vì kiểm kê là đếm thực tế từng lô). Lỗi dòng: lô lạ/khác vị trí/đã đóng, mặt hàng lạ, đơn vị lạ, số sai, lô trùng trong file, ô công thức (`= + - @`). Cảnh báo (không chặn): lô cách ly, lô hết hạn, lô đã có dòng đếm (sẽ bị ghi đè), số đếm thấp hơn phần đang giữ cho đơn. `systemQty`/`diffQty` theo đơn vị của dòng; `doc_qty_milli` lưu = tồn lúc xem trước (mốc "tồn lúc đếm"). Không trả giá vốn.

### Đơn giao từ quầy có giảm giá tay — `routes/pos-delivery.ts` (quyền `pos.sell`)
- `POST /pos/delivery-quote` `{customerId?, lines:[{productId, unit, qty, discount?}], discount?}` → `{subtotal, discount, net}` (`subtotal` = tiền hàng theo giá online trước giảm; `net = subtotal − discount`).
- `POST /pos/delivery-orders` nhận thêm `lines[].discount` (VND, giảm dòng), `discount` (VND, giảm cả đơn — chia cho các dòng theo tỷ lệ như POS), `approvalId?`, `overrideReason?`. Tổng đơn = `subtotal − discount + shippingFee`; `Σ prepay + cod` phải bằng tổng này (422 `payment_mismatch`); giảm lớn hơn giá trị đơn → 422 `discount_too_large`.
- Lưu trên đơn online (`channel='social'`, `source='pos'`): `orders.discount` = tổng giảm tay, `order_lines.discount`/`line_total` theo dòng (A-08). Đóng gói/kiểm cân không tính lại khuyến mãi cho kênh này nên giảm giá tay được giữ nguyên; doanh thu khi **giao xong** = tổng sau giảm.
- Ngưỡng duyệt như POS (A-29): giảm vượt `approval.discount_pct_bp` (% so với giá bảng giá, mặc định 10%) hoặc dòng có giảm mà thành tiền dưới giá vốn → thu ngân nhận 409 `approval_required` `{approvalId, reasons:['discount'\|'below_cost']}` (loại duyệt `order.discount`/`order.below_cost`, cùng màn Duyệt); sau khi quản lý duyệt, gửi lại **cùng `clientUuid` và cùng giỏ** kèm `approvalId` (phiếu gắn với băm giỏ, dùng một lần: ghi `approvals.ref_id` trong batch "Đang giao"; sai → 409 `approval_invalid`). Người có `approvals.decide` tự duyệt nhưng phải gửi `overrideReason` (≥ 3 ký tự; thiếu → 422 `override_reason_required`), ghi audit `order.self_approve`. Không trả giá vốn cho client.
