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
| POST | /stock-docs | inventory.write | `{type:'receipt'|'waste'|'adjust'|'count'|'transfer', locationId, toLocationId?, supplierId?, supplierRef?, reason?, note?}` → draft |
| POST | /stock-docs/:id/lines | inventory.write | receipt: `{productId,unit,qty,docQty?,unitCost,expiresAt?}` (unitCost theo đơn vị nhập → server đổi về đơn vị chính). waste/adjust/transfer: `{lotId,qty,unit,reason}`. count: `{lotId,countedQty,unit}` (server điền doc_qty = tồn hệ thống) |
| POST | /stock-docs/:id/scan | inventory.write | `{code, qty?, unit?}` quét mã thêm dòng; cảnh báo M2-16 (unknown / expired / not_in_doc / duplicate) → 422 với code tương ứng, luôn ghi scan_events |
| DELETE | /stock-docs/:id/lines/:lineId | inventory.write | chỉ khi draft |
| POST | /stock-docs/:id/post | inventory.write | receipt: tạo `lots` (lot_code = internalBarcode('L',id)), moves `receipt`; chênh lệch doc vs thực lưu ở line. waste: trừ lô, nếu tổng hao hụt > `approval.waste_pct_bp` × lượng nhập của lô **hoặc** người tạo không có inventory.approve → chuyển `pending_approval` + tạo `approvals`. count: tạo moves `adjust` theo chênh; giá trị chênh > `approval.count_diff_vnd` → pending_approval. transfer: moves transfer_out/transfer_in giữ nguyên unit_cost (tạo lô mới ở vị trí đích cùng expires_at). |
| POST | /stock-docs/:id/cancel | inventory.write | chỉ draft/pending |
| GET | /stock/lots?productId=&status= | inventory.view | |
| GET | /stock/card?productId=&from=&to= | inventory.view | thẻ kho từ stock_moves |
| GET | /stock/alerts | inventory.view | `{lowStock:[...], expiringSoon:[... ≤2 ngày], expired:[...]}` (M2-09) |
| GET | /stock/lots/:lotCode/trace | inventory.view | M2-19: nhập từ ai, ngày nào, bán đơn nào |

Quy tắc bắt buộc: không có endpoint sửa tồn trực tiếp; lô `expired` chỉ được xuất qua waste.

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
| POST | /orders/:id/void | pos.void | chỉ đơn trong ca đang mở; đơn của ca đã chốt chỉ manager; ghi void_reason, hoàn kho đúng lô, audit before/after |
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
| GET | /reconcile/shifts?day= | finance.shift_reconcile | M6-03 danh sách ca, expected vs counted |
| GET | /periods, POST /periods/:period/lock | finance.view / finance.lock_period | |

## Báo cáo — `routes/reports.ts`
| GET | /reports/pnl?from=YYYY-MM-DD&to=&groupBy=day|channel|group | reports.view | M6-04: doanh thu (orders sale − return), giá vốn (Σ cost_amount), lãi gộp; chi phí từ vouchers theo pnl_line (hao hụt từ phiếu waste quy ra tiền tính vào chi phí, không vào giá vốn) |
| GET | /reports/inventory?asOf= | reports.view | nhập–xuất–tồn theo mặt hàng (M2-08) + hao hụt |
| GET | /reports/daily?day= | reports.view | M1-10 |
| GET | /reports/export/:name.csv | reports.view | CSV UTF-8 BOM cho Excel (M6-05 tạm thời; mẫu kế toán [Cần xác nhận]) |

## Duyệt & người dùng — `routes/admin.ts`
| GET | /approvals?status=pending | approvals.decide | |
| POST | /approvals/:id/decide | approvals.decide | `{decision:'approved'|'rejected', note}`; áp dụng tác động tương ứng (post chứng từ kho, kích hoạt giá, post phiếu chi) |
| GET/POST/PUT | /users | users.manage | tạo user với mật khẩu tạm + must_change_password=1; PUT `active=0` → thu hồi mọi session (EC-39) |
| GET | /audit?entity=&entityId=&from= | audit.view | |
| GET/PUT | /settings | users.manage | |
