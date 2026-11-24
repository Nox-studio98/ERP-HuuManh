# Hợp đồng API — Đợt 2 (M4 B2B, M5 Công nợ, MISA, Excel, Fresco)

Áp dụng mọi quy ước của `docs/API.md`. Bổ sung:
- **Response JSON dùng camelCase** cho mọi endpoint mới (chuyển từ cột snake_case). Danh sách: `{ items, nextCursor }`.
- Ngày nghiệp vụ (`issueDate`, `dueDate`, `deliveryDate`, `validUntil`) là chuỗi `YYYY-MM-DD` theo giờ VN.
- Dịch vụ dùng chung (đã có, **không viết lại**):
  - `services/debt.ts`: `customerDebtStatus`, `checkCredit`, `supplierDebtStatus`, `INVOICE_OUTSTANDING_SQL`, `BILL_OUTSTANDING_SQL`, `addDays`.
  - `services/reservations.ts`: `planReservations`, `reserveStmts`, `releaseOrderStmts`, `consumeForDeliveryStmts`, `swapBadReservations`.
  - `services/outbox.ts`: `enqueueJobStmt` (trong batch), `kickJobs` (sau commit).
  - `services/approval-registry.ts`: `registerApprovalHandler(type, {perm, onApprove, onReject})` — gọi ở top-level file route của bạn. `/approvals/:id/decide` tự dùng.
  - `services/pricing.ts`: `resolvePrice(db, productId, {channel:'b2b', customerGroupId, customerId})` — đã hỗ trợ bảng giá riêng theo khách (`price_lists.customer_id`, kind='customer', priority cao nhất 100).
- Quyền mới (lib/rbac.ts): `b2b.view|write|approve|credit_override|deliver`, `debt.view|write|approve`, `invoices.issue`, `integrations.manage`. `b2b.credit_override` và `debt.approve` chỉ chủ cửa hàng.

## Mô hình công nợ (bắt buộc tuân theo)
- Phải thu = `invoices` kind `sale|replacement`. Hàng trả/giao thiếu sau khi xuất hoá đơn → **hoá đơn `adjustment`** (total âm) trỏ `original_invoice_id`; không xoá/sửa hoá đơn đã phát hành (trigger chặn).
- Thu tiền → `debt_payments` (direction in) + phiếu thu M6 (`cash_vouchers`, category `THU_NO_KH` hoặc mặc định `BAN_HANG`) cùng batch → `debt_allocations` gạch hoá đơn **cũ nhất trước** (theo `due_date`, `id`) trừ khi client chỉ định `allocations`. Phần thừa để nguyên chưa gạch (= số dư có, EC-24).
- Phải trả = `supplier_bills` sinh **tự động khi post phiếu nhập** (receipt) có `supplier_id`: total = Σ qty thực nhận × unit_cost (hàng từ chối không tính, EC-16); `due_date = issue_date + suppliers.payment_terms_days`; nếu phiếu không có `supplier_ref` → `is_provisional=1` (EC-30).
- Điều chỉnh (chiết khấu, xoá nợ, cấn trừ) → `debt_adjustments` + allocations. Xoá nợ/chiết khấu > `approval.writeoff_vnd` → approval type `debt_adjustment.post` (perm `debt.approve`).

## M4 — `routes/customers.ts` (Agent A)
| Method | Path | Quyền | Body → Response |
|---|---|---|---|
| GET | /customers?type=b2b&q=&ownerUserId= | b2b.view | items: `{id, code, type, name, phone*, email*, taxCode, customerGroupId, groupName, creditLimit, paymentTermsDays, ownerUserId, ownerName, active, version, debt:{balance, overdueAmount}}` (* che theo quyền customers.view_pii) |
| GET | /customers/:id | b2b.view | trên + `contacts[]`, `addresses[]`, `debt: PartnerDebtStatus`, `priceListId` (bảng giá riêng nếu có) |
| POST | /customers | b2b.write | `{name, type:'b2b', taxCode?, phone?, email?, billingAddress?, customerGroupId, creditLimit, paymentTermsDays, ownerUserId?, contacts:[{name, phone?, email?, role?, isReceiver}], addresses:[{label, address, receiverContactIndex?, isDefault}]}` → bắt buộc ≥1 địa chỉ và ≥1 người nhận (M4 quy tắc); code tự sinh `KH-0001` |
| PUT | /customers/:id | b2b.write | + `version`; đổi `creditLimit`/`paymentTermsDays`/`customerGroupId` cần quyền b2b.approve, ghi audit before/after |
| POST/PUT | /customers/:id/contacts[/:cid], /customers/:id/addresses[/:aid] | b2b.write | |
| GET | /customers/:id/history | b2b.view | M4-09 `{orders[], invoices[], revenueByMonth:[{month, revenue}], debt}` |
| PUT | /customers/:id/prices | b2b.approve | giá riêng theo khách: tạo/ghi price_list kind customer + prices (giữ lịch sử như /prices/bulk) |

## M4 — `routes/quotes.ts` (Agent A)
| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /quotes?customerId=&status= | b2b.view | items `{id, code, customerId, customerName, status, validFrom, validUntil, subtotal, createdAt}`; trạng thái `sent` quá `validUntil` hiển thị/đặt `expired` |
| GET | /quotes/:id | b2b.view | + `lines:[{id, productId, productName, unit, qty, qtyMilli, listPrice, unitPrice, costAtQuote*, marginBp*}]` (* chỉ khi prices.view_cost) |
| POST | /quotes | b2b.write | `{customerId, validDays?, note?, lines:[{productId, unit, qty?, unitPrice?}]}` — listPrice = resolvePrice(b2b, nhóm khách, khách); unitPrice mặc định = listPrice. Giảm > `approval.quote_discount_bp` hoặc < giá vốn → status `pending_approval` + approval `quote.approve` (perm b2b.approve), trừ khi người tạo có b2b.approve. Ngược lại `draft`. |
| PUT | /quotes/:id | b2b.write | chỉ khi draft |
| POST | /quotes/:id/send | b2b.write | draft → sent; sinh PDF (gọi `renderQuotePdf` của Agent C nếu có, lưu R2 `quotes/<code>.pdf`, set pdf_key) |
| GET | /quotes/:id/pdf | b2b.view | stream PDF từ R2 (sinh lại nếu chưa có) |
| POST | /quotes/:id/extend | b2b.approve | EC-28 `{days, reason}` |
| POST | /quotes/:id/cancel | b2b.write | |
| POST | /quotes/:id/convert | b2b.write | → tạo đơn sỉ từ báo giá còn hiệu lực (xem POST /b2b/orders với quoteId). Hết hạn → 409 `quote_expired`. EC-12: nếu giá vốn hiện tại làm biên < 0 vẫn giữ giá báo nhưng trả `warnings:[{productId, marginBp}]` |

## M4 — `routes/b2b.ts` (Agent A) — đơn sỉ, giữ tồn, giao, hoá đơn
Trạng thái đơn sỉ dùng `orders.status`: `new` (chưa giữ) → `confirmed` (đã kiểm hạn mức + giữ tồn) → `preparing` (đang soạn) → `shipping` → `completed` (đã giao + xuất hoá đơn). Nhánh: `cancelled`, `delivery_failed`.

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /b2b/orders?status=&customerId=&deliveryDate= | b2b.view | items `{id, code, customerId, customerName, status, deliveryDate, total, addressLabel, createdAt, invoiceId}` |
| GET | /b2b/orders/:id | b2b.view | + `lines:[{id, productId, productName, unit, qty, qtyMilli, unitPrice, lineTotal, reservedMilli, deliveredMilli}]`, `deliveries[]`, `invoices[]`, `credit: PartnerDebtStatus` |
| POST | /b2b/orders | b2b.write | `{customerId, quoteId?, addressId, deliveryDate, note?, lines:[{productId, unit, qty, unitPrice?}], clientUuid}`. Giá: từ báo giá còn hiệu lực nếu có quoteId (dòng ngoài báo giá → 422), không thì resolvePrice. **Trình tự bắt buộc (EC-23):** `checkCredit(total)` TRƯỚC khi giữ hàng. Không đạt và không có `creditOverrideApprovalId` hợp lệ → tạo đơn status `new` + approval `order.credit_override` (perm `b2b.credit_override`) → 409 `credit_blocked` `details:{approvalId, reasons, status}`. Đạt → batch: lines + `reserveStmts` + status `confirmed`. Thiếu tồn → 409 insufficient_stock (đơn vẫn `new`, cho phép giữ lại sau). |
| POST | /b2b/orders/:id/confirm | b2b.write | đơn `new` → kiểm hạn mức lại (hoặc approval đã duyệt) + giữ tồn |
| PUT | /b2b/orders/:id | b2b.write | sửa khi `new`/`confirmed`: nhả giữ cũ, giữ lại; đổi địa chỉ sau khi `preparing` cần b2b.approve (EC-27) |
| POST | /b2b/orders/:id/cancel | b2b.write | `{reason}` nhả giữ tồn |
| POST | /b2b/orders/:id/pick | b2b.deliver | tạo phiếu giao (status picking), trả `deliveryId` + danh sách lô đã giữ để soạn |
| POST | /deliveries/:id/scan | b2b.deliver | `{code, qty?, unit?}` quét soạn hàng: mã phải thuộc đơn (not_in_doc), lô phải đang giữ cho đơn (wrong_lot cảnh báo), quét trùng lô theo cấu hình; ghi scan_events |
| POST | /deliveries/:id/ready | b2b.deliver | số soạn phải khớp đơn; lệch phải có `{reason}` (M2 quy tắc) |
| POST | /deliveries/:id/ship | b2b.deliver | `{shipper?}` → order shipping |
| POST | /deliveries/:id/confirm | b2b.deliver | **M4-06** `{receiverName, lines:[{orderLineId, deliveredQty, rejectedQty?, rejectReason?}]}` → batch: `consumeForDeliveryStmts` theo số **thực giao** (hàng từ chối không xuất kho, EC-26), `order_line_lots`, cost_amount, order `completed`, **tạo hoá đơn** theo số thực giao (M4-07) với `due_date = issue_date + paymentTermsDays`, `enqueueJobStmt('einvoice.issue', 'invoice', id)` nếu `einvoice.auto_issue_b2b=1`, audit. Thiếu giữ (shortByLine) → phân bổ thêm FEFO từ tồn tự do, không đủ → 409. |
| POST | /deliveries/:id/fail | b2b.deliver | `{reason}` → nhả giữ, order `delivery_failed`, cho phép tạo giao lại |
| POST | /b2b/orders/:id/returns | b2b.write | EC-25: `{lines:[{orderLineId, qty, unit, restock, reason}]}` sau khi đã xuất hoá đơn → cộng kho đúng lô gốc (restock) + **hoá đơn adjustment âm** + `einvoice.adjust` job |
| GET/POST/PUT | /b2b/recurring | b2b.write | M4-08 mẫu đơn lặp; `POST /b2b/recurring/:id/generate {deliveryDate}` tạo đơn (đi qua cùng luồng kiểm hạn mức) |
| GET | /invoices?customerId=&status=open&overdue=1 | debt.view | items `{id, code, kind, customerId, customerName, issueDate, dueDate, total, paid, outstanding, overdueDays, einvoiceStatus, einvoiceNo}` — dùng `INVOICE_OUTSTANDING_SQL` |
| GET | /invoices/:id | debt.view | + lines, allocations, adjustments |
| POST | /invoices/:id/einvoice | invoices.issue | phát hành / phát hành lại HĐĐT thủ công (enqueue) |
| GET | /invoices/:id/pdf | debt.view | bản thể hiện nội bộ (renderInvoicePdf của Agent C) |

Approval handlers Agent A đăng ký: `order.credit_override` (perm b2b.credit_override; onApprove: không tự giữ hàng — người tạo gọi /confirm kèm approval), `quote.approve` (perm b2b.approve; onApprove → status draft; onReject → cancelled).

## M5 — `routes/debts.ts` (Agent B)
| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /debts/receivables?q=&overdueOnly= | debt.view | M5-01 theo khách: `{customerId, customerName, outstanding, unapplied, balance, overdueAmount, oldestOverdueDays, creditLimit, buckets:{current, d1_30, d31_60, d61_90, over90}}` (mốc từ `debt.aging_buckets`) |
| GET | /debts/payables | debt.view | M5-02 theo NCC tương tự + bills |
| GET | /debts/aging?side=receivable|payable&asOf= | debt.view | M5-04 bảng tuổi nợ chi tiết theo hoá đơn |
| GET | /suppliers/:id/bills, GET /bills/:id | debt.view | |
| POST | /bills/:id/finalize | debt.write | EC-30 nhận hoá đơn NCC: `{supplierRef, total?, vatAmount?, reason?}` — `vatAmount` (VND nguyên, 0..total) là VAT đầu vào ghi vào `supplier_bills.vat_amount` (báo cáo VAT); audit có `vat` trước/sau; đổi total khi chênh giá chốt phải có reason, audit; bỏ is_provisional. **B-09:** chênh lệch (total mới − total cũ) được phân bổ theo thành tiền các dòng phiếu nhập (phần dư dồn dòng cuối); phần còn tồn của lô → đổi `lots.unit_cost` (thẻ kho `move_type='cost_adjust'`, qty 0), phần đã bán (và phần làm tròn) → ghi `purchase_cost_adjustments.cogs_amount`, vào P&L ngày chốt dòng `expenses.purchaseVariance` "Chênh lệch giá mua"; vẫn chịu khoá sổ kỳ (423) |
| POST | /debts/payments | debt.write | M5-03 `{direction:'in'|'out', partnerType, partnerId, fundId, amount, method:'cash'|'transfer', ref?, paidAt?, allocations?:[{invoiceId|billId, amount}], bankTxnId?}` → batch: debt_payments + cash_voucher (in/out, kỳ hiện tại; kỳ khoá → 423) + allocations (cũ nhất trước nếu không chỉ định; không vượt outstanding) + audit. Response `{payment, allocations[], unapplied}`. **Đợt fix 1b**: (B-01) `direction='out'` > `approval.cash_out_vnd` mà người lập không có `finance.approve` → phiếu `status='pending_approval'` (KHÔNG phiếu quỹ, KHÔNG gạch nợ, công nợ bỏ qua) + approval `debt_payment.post` (response thêm `approvalId`); duyệt (`/approvals/:id/decide`, cần `approvals.decide` + `finance.approve`, không tự duyệt) → một batch ghi phiếu chi `posted` + gạch nợ; từ chối → `rejected`. (A-01) `direction='out'` + `partnerType='customer'` = **hoàn tiền số dư có cho khách** (≤ `invoiceCredit`, không gạch hoá đơn; khoản mục `HOAN_KH`; vượt → 422 `refund_exceeds_credit`). (B-08) `paidAt`/hôm nay thuộc kỳ khoá → 423 |
| POST | /debts/payments/:id/allocate | debt.write | gạch phần dư chưa gạch vào hoá đơn cụ thể. 409 với phiếu chờ duyệt / phiếu hoàn tiền khách; kỳ khoá → 423 |
| POST | /debts/payments/:id/reverse | debt.write | đảo: xoá allocations? **Không** — tạo phiếu đảo M6 + đánh dấu `reversed`; allocations của payment bị loại khỏi tính toán (lọc `status='posted'` khi tính) |
| POST | /debts/adjustments | debt.write | M5-08 `{type:'discount'|'write_off'|'offset'|'return_credit', partnerType, partnerId, amount, reason, invoiceId?|billId?}`; write_off/discount > ngưỡng → pending + approval `debt_adjustment.post` (perm debt.approve). **offset** (M5-09): khách có `linked_supplier_id` → một adjustment phía khách + một phía NCC cùng số tiền, gạch hoá đơn hai bên. **`return_credit`** (A-01, chỉ khách): cấn số dư có do trả hàng sau thanh toán (`invoiceCredit`) vào hoá đơn còn nợ của chính khách (`invoiceId?`), ≤ số dư có (422 `credit_exceeds_balance`), ghi ngay không cần duyệt. Mọi loại: kỳ hiện tại khoá → 423 |
| POST | /debts/opening-balances | debt.write | nhập số dư đầu kỳ (CSV/JSON `[{partnerType, partnerCode, amount, dueDate}]`) → tạo invoice/bill kind sale với note 'Số dư đầu kỳ' |
| POST | /debts/opening-balances/lock | debt.approve | khoá vĩnh viễn (bảng opening_balances_lock) |
| GET | /debts/statements/:partnerType/:partnerId?from=&to= | debt.view | M5-07 sao kê: `{opening, lines:[{date, docType, docCode, debit, credit, balance}], closing}` + `?format=csv` |
| GET | /debts/reminders?days= | debt.view | M5-06 danh sách sắp đến hạn/quá hạn; `POST /debts/reminders/send {customerIds}` enqueue `debt.remind` |
| POST | /bank-transactions/import | debt.write | EC-24 CSV `date,amount,description,ref` → bỏ trùng theo (fund, ref); tự khớp nếu description chứa mã khách `KH-xxxx` hoặc mã hoá đơn → tạo payment; còn lại `unmatched` |
| GET | /bank-transactions?status=unmatched | debt.view | |
| POST | /bank-transactions/:id/match | debt.write | `{partnerType, partnerId, allocations?}` hoặc `{ignore:true, reason}` |
| GET/POST | /settlements, POST /settlements/:id/confirm | finance.write | M6-03 đối soát COD/sàn theo đợt: `{source, externalRef, fundId, lines:[{orderId|externalOrderId, expectedAmount, receivedAmount, feeAmount}]}`; diff ≠ 0 bắt buộc `diffReason`; confirm → phiếu thu M6 số thực nhận + phiếu chi phí sàn |

Agent B cũng sửa **duy nhất** đoạn post phiếu nhập trong `routes/inventory.ts` để thêm `supplier_bills` vào cùng batch, và đăng ký handler `debt_adjustment.post`.

## Tích hợp & xuất file — Agent C
`services/jobs.ts`: `processJob(env, jobId)` (khoá job bằng `UPDATE ... SET status='running' WHERE id=? AND status IN ('queued','failed')` rồi kiểm `meta.changes`), retry backoff 1m·5m·30m·2h·12h, sau 5 lần → `dead` + audit; `sweepJobs(env)` cho cron `*/5`. Queue consumer `queue(batch, env)` export trong `index.ts`.

`services/einvoice/`: interface `EInvoiceProvider { issue(inv), adjust(inv, original), cancel(inv, reason) }` → `{ einvoiceNo, series, lookupCode }`. `FakeProvider` (dev/test, sinh số giả có tiền tố `TEST-`), `MisaProvider` (meInvoice API: lấy token bằng app id + MST + user/pass từ secrets, gọi phát hành; **URL và schema payload cấu hình được, đánh dấu [Cần xác nhận với tài liệu MISA cấp cho cửa hàng]**; không log mật khẩu/token). Chọn theo setting `einvoice.provider`. Job `einvoice.issue` cập nhật `invoices.einvoice_*`; lỗi → `einvoice_status='failed'` + `einvoice_error`.

`routes/integrations.ts`:
| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /integrations/jobs?status= | integrations.manage | |
| POST | /integrations/jobs/:id/retry | integrations.manage | |
| POST | /api/integrations/fresco/webhook | *(không cần đăng nhập — mount ngoài /api/v1)* | xác thực `X-Fresco-Signature: sha256=<hex HMAC(body)>` + `X-Fresco-Timestamp` ±300s bằng `FRESCO_WEBHOOK_SECRET`; idempotent qua `webhook_events(source,event_id)`; `fresco.enabled=0` → 404. Tạo đơn `channel='fresco'`, `external_source/external_id`, map SKU qua `external_products` (SKU lạ → đơn `new` kèm cảnh báo, không giữ tồn), giữ tồn bằng `planReservations/reserveStmts` → `confirmed`. **[Cần xác nhận định dạng thật của Fresco]** — hiện thực theo payload giả định ghi trong code. |
| POST | /fresco/orders/import | orders.online.manage | CSV xuất từ sàn (cột giả định: order_id, created_at, sku, qty, unit_price, shipping_fee, buyer_name) — cùng luồng tạo đơn |
| GET/PUT | /fresco/products | integrations.manage | map SKU sàn ↔ sản phẩm |
| GET/PUT | /integrations/settings | integrations.manage | bật/tắt Fresco, chọn provider HĐĐT (không trả secret) |

`services/xlsx.ts`: writer XLSX tối thiểu (zip bằng `fflate`, SheetML, kiểu số/ngày/chuỗi, header in đậm, độ rộng cột) — **M6-05**. `routes/exports.ts`:
| GET | /exports/:name.xlsx?from=&to= | reports.view | `so-ban-hang`, `so-quy` (theo quỹ), `cong-no-phai-thu`, `cong-no-phai-tra`, `nhap-xuat-ton`, `hoa-don-ban`. Định dạng cột bám mẫu sổ kế toán thông dụng (Thông tư 88/2021 cho hộ kinh doanh) **[Cần xác nhận mẫu kế toán đang dùng]**. Ghi audit `export.<name>`. |

`services/pdf.ts`: `renderQuotePdf(env, quoteId)`, `renderInvoicePdf(env, invoiceId)`, `renderStatementPdf(...)` → Uint8Array, dùng `pdf-lib` + `@pdf-lib/fontkit` với font Unicode tiếng Việt (Be Vietnam Pro / Noto Sans) lấy từ R2 `fonts/` hoặc bundle; nếu không có font → 501 `pdf_font_missing` kèm hướng dẫn upload.

Cron thêm: `*/5` → `sweepJobs`; hằng ngày `0 1 * * *` (08:00 VN) → `swapBadReservations` (EC-15), sinh đơn lặp ngày mai (M4-08), enqueue nhắc nợ (M5-06) theo `remind.days_before_due`.


## Đợt fix 1b — công nợ âm (A-01), duyệt chi (B-01), khoá sổ (B-08)

- `customerDebtStatus` / `GET /customers/:id` (`debt`) / `GET /debts/receivables`: thêm `invoiceCredit` (số dư có từ hoá đơn còn nợ âm sau trả hàng, chưa cấn/chưa hoàn) và `credit` = max(0, −balance) — UI hiển thị **"Khách dư có"**. `balance = outstanding − unapplied − invoiceCredit` (âm = khách dư có). `outstanding`/aging chỉ tính phần còn nợ **dương**. `totals` thêm `invoiceCredit`, `credit`.
- Sao kê khách: phiếu hoàn tiền dư có (`docType: customer_refund`) ghi bên phát sinh tăng; `return_credit` hiển thị nhưng không phát sinh (chỉ chuyển số dư có sang hoá đơn khác).
- `GET /debts/payments?status=` thêm `pending_approval` | `rejected`. Approval mới `debt_payment.post` (ref_id = id phiếu, payload `{code, partnerType, partnerId, partnerName, amount, fundId}`).
