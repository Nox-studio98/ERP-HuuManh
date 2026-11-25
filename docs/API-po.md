# Hợp đồng API — Đơn đặt NCC (PO) tự động từ phần thiếu SO

Thiết kế: `docs/PO-NCC.md`. Đợt này làm bước 1–3 (ERP). Cổng NCC `/ncc` đã làm (mục 8, 9).

Quy ước như các hợp đồng trước: base `/api/v1`, camelCase, `{items, nextCursor, ...}`, tiền VND nguyên, số lượng `qtyMilli` (1 kg = 1000, **đơn vị chính**), ngày `YYYY-MM-DD` giờ VN, lỗi `{error:{code,message,details}}`.
Schema: `migrations/0029_po_orders.sql`. Code: `services/shortages.ts`, `services/po.ts`, `services/po-pdf.ts`, `routes/purchase-orders.ts`.

## 1. Quyền

| Quyền | Vai trò | Dùng cho |
|---|---|---|
| `purchasing.view` (cũ) | chủ, quản lý, thủ kho | xem PO, phần thiếu, PDF |
| `purchasing.write` (mới) | chủ, quản lý, thủ kho | tạo/sửa PO nháp, **Chốt ngay / Tính lại**, nhận hàng (kèm `inventory.write`), huỷ PO nháp |
| `purchasing.approve` (mới) | chủ, quản lý | duyệt & gửi, ghi nhận phản hồi NCC, chấp nhận/từ chối đề xuất, đóng PO, huỷ PO đã gửi |
| `purchasing.approve_high` (mới) | chỉ chủ | duyệt PO vượt `approval.po_vnd` (qua luồng duyệt chung) |

Giá vốn: `unitCost`, `proposedUnitCost`, `confirmedUnitCost`, `lineTotal`, `total`, `bills`, `stockDocs[].totalAmount`, `summary.openValue` chỉ có khi người xem có `prices.view_cost`; PDF của người không có quyền không có đơn giá/thành tiền.

## 2. Tham số (Cài đặt, nhãn "Cần xác nhận" ở hai khoá cuối)

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `po.allow_short_confirm` | 1 | Cho xác nhận SO khi thiếu hàng (ghi phần thiếu). 0 = như cũ (409 `insufficient_stock` / `preorder_not_ready`) |
| `po.cutoff_time` | `03:00` | Giờ chốt đêm (giờ VN, HH:MM) |
| `po.horizon_days` | 2 | Chỉ gom phần thiếu của SO có ngày giao ≤ hôm nay + N ngày. **Cần xác nhận với khách** |
| `approval.po_vnd` | 20.000.000 | PO có tổng > mức này cần chủ duyệt. **Cần xác nhận với khách** |

## 3. Phần thiếu khi xác nhận SO (thay đổi API cũ)

- `POST /b2b/orders` (tự xác nhận), `POST /b2b/orders/:id/confirm`, `PUT /b2b/orders/:id` (đổi dòng rồi xác nhận lại): khi thiếu tồn và `po.allow_short_confirm = 1` thì **không còn 409**; giữ FEFO phần có tồn, ghi `so_shortages` trong cùng batch, đơn `confirmed`. Hạn mức nợ (EC-23) vẫn tính trên toàn bộ giá trị đơn (vượt → 409 `credit_blocked` như cũ, không giữ gì, không ghi thiếu).
- `POST /online-orders/:id/confirm`: chỉ đơn **đặt trước** (`preorderMilli > 0`) có **ngày giao sau hôm nay** (`slotDate > hôm nay`) được chờ hàng. Đơn giao trong ngày vẫn 409 `preorder_not_ready` như cũ.
- Hai người xác nhận đồng thời: ràng buộc CHECK của `lots` chặn giữ quá tồn (EC-02); người sau được tính lại một lần (giữ phần còn lại, ghi thiếu phần chênh).
- Chi tiết / danh sách đơn sỉ và đơn online có thêm: `awaitingStock`, `shortMilli`, `shortLines[{productName, qtyMilli, baseUnit}]` (danh sách), và theo dòng `shortMilli`, `poCode`, `poStatus`, `poExpectedDate` (chi tiết).
- **Chặn soạn/giao phần chưa có hàng:** đơn online còn thiếu → `prepare` và `ship` trả 409 `awaiting_stock`. Đơn sỉ: giao (`POST /deliveries/:id/confirm`) vượt phần đã giữ → 409 `awaiting_stock` (`details.deliverableMilli`); giao xong đóng phần thiếu (phần còn lại thành đơn bổ sung nếu bật A-27).
- Huỷ SO (`/b2b/orders/:id/cancel`, `/online-orders/:id/cancel`) đóng phần thiếu (`status = cancelled`). Sửa dòng đơn sỉ xoá và ghi lại phần thiếu. Đơn bị huỷ ở nơi khác (website, cron) được job chốt đêm dọn.

## 4. API Đơn đặt NCC

`items` bên dưới là `shapePo`: `{id, code, supplierId, supplierName, supplierCode, status, source ('nightly'|'manual'), cutoffDay, expectedDate, proposedExpectedDate, overdue, note, supplierNote, rejectReason, cancelReason, closeReason, approvalId, version, createdBy(Name), approvedBy(Name), approvedAt, sentAt, confirmedAt, closedAt, createdAt, total*}`.
Trạng thái: `draft → pending_approval → sent → (supplier_proposed) → confirmed → partially_received → received`; nhánh `rejected`, `cancelled`, `closed`.
Mọi chuyển trạng thái: `assertStmt` + `UPDATE ... WHERE status = ? AND version = ?` + audit trong **một** batch. Body có `version` (tuỳ chọn ở route staff) lệch → 409 `version_conflict`.

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | /purchase-orders?status=&supplierId=&q=&from=&to=&receivable=1&cursor=&limit= | purchasing.view | `status` nhận danh sách cách nhau dấu phẩy. Trả `{items:[shapePo+lineCount+sourceCount], nextCursor, counts:{theo trạng thái}, summary:{draft, pendingApproval, awaitingSupplier, supplierProposed, overdue, receivable, openValue*}}` |
| GET | /purchase-orders/shortages | purchasing.view | Tab "Phần thiếu": `{items:[{productId, name, baseUnit, totalMilli, coveredMilli, uncoveredMilli, supplier|null, noSupplier, lines:[{shortageId, orderId, orderCode, channel, customerName, needBy, qtyMilli, po:[{id,code,status}]}]}], noSupplier:[{productId,name,qtyMilli}], cutoff:{time, windowDay, autoDone}, summary}` |
| POST | /purchase-orders/cutoff-now | purchasing.write | **Chốt ngay**: chạy job cho ngày chốt hiện tại. Trả `{cutoffDay, mode, created[], updated[], cancelled[], noSupplier[], shortageCount}` |
| POST | /purchase-orders/recalculate | purchasing.write | **Tính lại**: như trên, chỉ cập nhật PO **nháp** của ngày chốt (không đụng PO đã gửi); PO nháp hết nhu cầu bị huỷ |
| POST | /purchase-orders | purchasing.write | Tạo PO nháp tay: `{supplierId, expectedDate?, note?, lines:[{productId, qty (theo đơn vị đặt), unit?, unitCost?, note?}]}`. Thiếu `unitCost` → lấy giá nhập lô gần nhất của NCC (nếu có) |
| GET | /purchase-orders/:id | purchasing.view | shapePo + `supplierPhone`, `lines[{id, productId, productName, sku, baseUnit, orderUnit, factor, qtyMilli, orderQty, proposedQtyMilli, confirmedQtyMilli, targetMilli, receivedMilli, remainingMilli, note, supplierNote, unitCost*, proposedUnitCost*, confirmedUnitCost*, lineTotal*, sources:[{shortageId, orderId, orderCode, channel, customerName, needBy, qtyMilli, shortageStatus, stillMissingMilli, sourceCancelled}]}]`, `stockDocs`, `bills*`, `sourceCancelled`, `history[{at, action, by, reason}]` (từ `audit_log`) |
| PUT | /purchase-orders/:id | purchasing.write | Chỉ PO `draft`: `{version?, expectedDate?, note?, lines?}` (lines thay toàn bộ: thêm/sửa/xoá) |
| POST | /purchase-orders/:id/approve | purchasing.approve | `{version?}`. Tổng ≤ `approval.po_vnd` hoặc người duyệt có `approve_high` → `sent` (kèm `result:"sent"`). Vượt ngưỡng → tạo `approvals` loại `purchase_order.approve` (trigger DB gửi thông báo duyệt C-27), PO `pending_approval`, `result:"pending_approval"`. Chủ duyệt qua `POST /approvals/:id/decide` (đồng ý → `sent`; từ chối → về `draft`) hoặc bấm duyệt trực tiếp trên PO |
| POST | /purchase-orders/:id/cancel | purchasing.write (PO đã gửi: purchasing.approve) | `{reason, version?}`; chỉ khi chưa nhận hàng |
| POST | /purchase-orders/:id/close | purchasing.approve | `{reason, version?}`; chỉ PO `partially_received`; phần chưa về quay lại nhu cầu cho lần chạy sau |
| POST | /purchase-orders/:id/supplier-response | purchasing.approve | Nhân viên **ghi nhận hộ** phản hồi NCC (điện thoại/Zalo). `{action:'confirm'|'propose'|'reject', version (bắt buộc), expectedDate?, note?, lines?:[{lineId|productId, qtyMilli?, unitCost?, note?}]}`. Chỉ khi `sent`. `confirm` → `confirmed` (chốt SL/giá = số đặt); `propose` → `supplier_proposed`; `reject` (bắt buộc `note`) → `rejected` |
| POST | /purchase-orders/:id/proposal/accept | purchasing.approve | `{version?, note?}` → `confirmed` theo đề xuất (SL, giá, ngày giao), tính lại tổng |
| POST | /purchase-orders/:id/proposal/reject | purchasing.approve | `{version?, reason}` → về `sent`, xoá đề xuất |
| POST | /purchase-orders/:id/receive | purchasing.write + inventory.write | Nhận hàng theo PO (mục 5). Trả 201 chi tiết PO + `result:{status, stockDoc:{id,code}, bill:{id,code,isProvisional}|null, filledShortages:[{orderId, orderCode, productId, productName, baseUnit, qtyMilli, done}]}` |
| GET | /purchase-orders/:id/pdf | purchasing.view | PDF đơn đặt hàng (font BeVietnamPro trên R2); không có đơn giá nếu thiếu `prices.view_cost` |

Mã lỗi riêng: `po_not_found` 404, `invalid_status` 409, `version_conflict` 409, `owner_approval_required` 409, `po_not_draft` 409, `empty_po` 422, `reason_required` 422, `over_receive` 422, `missing_cost` 422, `line_not_in_po` 422, `period_locked` 423 (nhận hàng vào kỳ đã khoá), `awaiting_stock` 409.

### Job chốt đêm (cron `*/5`, `services/po.ts: runPoCutoffIfDue`)
- **Ngày chốt** = ngày VN của (thời điểm − giờ chốt). Với 03:00: đơn nhập 25/11 22:00 → 26/11 02:59 thuộc ngày chốt 25/11. Cron sau 03:00 ngày 26 chốt ngày 25.
- Idempotent: chế độ `auto` giữ khoá `onceStmt('po.cutoff', ngày chốt)`; chạy lần hai → bỏ qua. Lỗi giữa chừng thì nhả khoá để cron sau thử lại. "Chốt ngay"/"Tính lại" không dùng khoá nhưng chỉ ghi vào PO nháp tự động của (NCC, ngày chốt) — chỉ mục duy nhất `uq_po_nightly_draft` bảo đảm không trùng — nên job 03:00 chạy sau chỉ cập nhật.
- Nhu cầu mỗi sản phẩm = Σ phần thiếu mở (đơn còn hiệu lực, ngày giao ≤ hôm nay + `po.horizon_days`) − hàng sắp về (PO `pending_approval/sent/supplier_proposed/confirmed/partially_received`: SL chốt hoặc SL đặt − đã nhận; cộng PO nháp **khác** ngày chốt này / PO tay).
- NCC: `product_suppliers.preferred` rồi lead time ngắn nhất. Không có NCC → `noSupplier`. Làm tròn: `roundOrderQty` (tối thiểu `min_order_milli`, làm tròn lên theo hệ số đơn vị đặt) — dùng chung với `GET /purchasing/suggestions`. Giá gợi ý: giá lô nhập gần nhất của NCC đó.
- `po_shortage_links`: phần thiếu đứng đầu (ngày giao sớm, tạo trước) được coi là đã có hàng sắp về, phần còn lại gắn với dòng PO.

## 5. Nhận hàng theo PO

`POST /purchase-orders/:id/receive` body `{version?, locationId?, supplierRef?, vatAmount?, note?, lines:[{poLineId, qtyMilli, expiresAt?, unitCost?}]}`.
- PO phải `confirmed` hoặc `partially_received`; `assertPeriodOpen` (kỳ khoá → 423, không ghi gì).
- **Một batch**: `assertStmt` (trạng thái + version + `received_milli` từng dòng — hai người nhận trùng thì một người 409) → `stock_docs` (`receipt`, `posted`, `po_id`) + `stock_doc_post_guard` + dòng phiếu → lô (HML...) + `stock_moves` + `received_milli` → `supplier_bills` (tổng theo giá đã chốt, `is_provisional = 1` nếu không có `supplierRef`, hạn theo `payment_terms_days` của NCC) → trạng thái PO (`partially_received` / `received`) → audit.
- Số nhận ≤ phần còn lại (`over_receive`). Giá: `unitCost` trong body, không thì giá chốt, không thì giá đặt; không có giá nào → `missing_cost`.
- **Sau batch**: giữ FEFO cho `so_shortages` liên kết với dòng PO theo `need_by` rồi thời điểm tạo (mỗi phần thiếu một batch riêng, tự kiểm tra lại), giảm `qtyMilli`, `filled` khi đủ; khi đơn hết phần thiếu → thông báo (`notifications.kind = 'so_filled'`, audience `b2b.write` hoặc `orders.online.manage` + job `notify.managers`). Đơn đã huỷ không được giữ hàng; hàng thành tồn bán lẻ.
- Hàng hỏng khi nhận: ghi sổ đúng số hàng tốt, phần hỏng dùng "Trả hàng NCC" (B-12).

## 6. Hàm dịch vụ cho cổng NCC (đợt sau)

```ts
applySupplierResponse(db, poId, { action: 'confirm'|'propose'|'reject', lines?, expectedDate?, note?, version }, actor: PoActor)
// actor: { type: 'supplier', userId: null, id: <supplier_account_id> } → audit ghi actor "supplier_account:<id>"
```
Cổng chỉ cần kiểm tra `po.supplier_id` thuộc phiên rồi gọi hàm này; version lệch → 409 `version_conflict`; chỉ nhận khi PO `sent`. Cửa hàng xử lý đề xuất bằng `decideProposal` (route `proposal/accept|reject`). Đợt cổng NCC bổ sung: `supplier_accounts`, `supplier_sessions`, route `/api/ncc/*`, thông báo cho NCC.

## 7. Kiểm thử

`test/po-shortage.test.ts` (xác nhận thiếu, đồng thời, hạn mức, huỷ/sửa SO, online), `test/po-orders.test.ts` (job, ngày chốt, trừ hàng sắp về, làm tròn, duyệt/ngưỡng/thông báo, phản hồi NCC, phân quyền, PDF), `test/po-receive.test.ts` (nguyên tử, khoá sổ, thứ tự phân bổ, nhận một phần, đóng PO). E2E: `e2e/po.mjs`.

## 8. Cổng NCC — route mời (ERP, `/api/v1`, quyền `purchasing.approve`: chủ, quản lý)

Code: `routes/supplier-portal.ts`, migration `0030_ncc_portal.sql`. Link mời: `<SHOP_BASE_URL>/ncc/dat-mat-khau#<id>.<bí mật>` (phần `#` không gửi lên máy chủ). Token **chỉ trả một lần** trong response; DB chỉ lưu SHA-256; audit không ghi token. Hạn `ncc.invite_ttl_hours` (72). Chưa có email thật nên cửa hàng sao chép link gửi Zalo/email.

| Method | Path | Mô tả |
|---|---|---|
| GET | /suppliers/:id/portal | `{enabled, shopConfigured, items:[{id, fullName, email, phone, status ('invited'\|'active'\|'locked'), hasPassword, lastLoginAt, failedLogins, invitedByName, pendingInvite:{id, expiresAt, expired}\|null}]}` |
| POST | /suppliers/:id/portal/invites | `{fullName, email, phone?}` → 201 `{account, invite:{id, path, link\|null, expiresAt, ttlHours}}`. Email trùng toàn hệ thống → 409 `email_taken` |
| POST | /suppliers/:id/portal/accounts/:accId/invite | Gửi lại link (chưa đặt mật khẩu) hoặc cấp link đặt lại mật khẩu; link cũ chưa dùng bị thu hồi. Tài khoản khoá → 409 |
| POST | /suppliers/:id/portal/accounts/:accId/revoke-invite | Thu hồi lời mời còn hiệu lực |
| POST | /suppliers/:id/portal/accounts/:accId/lock `{reason?}` / unlock | Khoá thu hồi mọi phiên + lời mời ngay |

Mọi route kiểm tài khoản thuộc đúng NCC trên đường dẫn (khác NCC → 404). Khi NCC phản hồi PO trên cổng: dòng `notifications` (kind `po_supplier_confirm|propose|reject`, `audience_perm = purchasing.approve`, url `/purchase-orders?open=ID`) + job `notify.managers`, **cùng batch** với đổi trạng thái; audit `actor = supplier_account:<id>` + IP (cột mới `audit_log.actor`).

## 9. Cổng NCC — `/api/ncc/*` (Worker website)

Phiên riêng: cookie `__Host-ncc` (HttpOnly, Secure, SameSite=Strict), bảng `supplier_sessions`, 7 ngày, **không nhận Bearer**; request ghi bắt buộc header `X-Requested-With: hm-shop` (kể cả khi có Authorization); NCC ngừng giao dịch / tài khoản khoá / `ncc.portal_enabled = 0` → phiên bị từ chối (503 `ncc_disabled` hoặc 401). Mọi truy vấn lọc theo `supplier_id` **của phiên**; không route nào nhận supplier id từ client. PO chỉ hiện khi `sent_at` có giá trị và không còn `draft/pending_approval`; PO của NCC khác, nháp và id không tồn tại đều trả cùng `404 po_not_found`.

| Method | Path | Mô tả |
|---|---|---|
| POST | /auth/login | `{email, password}` + Turnstile, nhóm `RL_AUTH`. Sai mật khẩu / không tồn tại / chưa đặt mật khẩu / bị khoá / bị khoá tạm: cùng `401 invalid_credentials`. Khoá tạm 5 lần sai trong 15' theo (tài khoản + IP) như đăng nhập khách |
| POST | /auth/invite | `{token}` → `{fullName, email, supplierName, expiresAt, firstTime}`; sai/hết hạn/đã dùng/thu hồi: `400 invalid_token` đồng nhất |
| POST | /auth/accept | `{token, password ≥10}` + Turnstile: đặt mật khẩu (dùng một lần, `assertStmt` chống hai request đồng thời), thu hồi phiên cũ, đăng nhập luôn |
| POST | /auth/logout | |
| GET | /me · POST /me/password | `{currentPassword, newPassword}`: thu hồi phiên khác |
| GET | /users | Người dùng cùng NCC (chỉ xem): `id, fullName, email, phone, status, lastLoginAt, isMe` |
| GET | /orders?status=&from=&to=&q=&cursor=&limit= | `{items:[{id, code, status, sentAt, expectedDate, proposedExpectedDate, overdue, total, version, awaitingYou, lineCount}], nextCursor, counts, summary:{awaitingYou, proposed, confirmed, overdue, openValue}}` |
| GET | /orders/:id | Chi tiết: dòng (tên hàng, SL, giá PO của chính NCC, đề xuất, đã chốt, đã nhận), `note` (ghi chú in trên PDF), `storeReply`, `bills`, `history` (nhãn cố định; lý do chỉ với hành động của NCC / lời đáp đề xuất). **Không** có SKU, ghi chú dòng nội bộ, SO/khách nguồn, người lập/duyệt, lý do huỷ/đóng nội bộ |
| POST | /orders/:id/respond | `{action:'confirm'\|'propose'\|'reject', version, expectedDate?, note?, lines?:[{lineId, qtyMilli?, unitCost?, note?}]}` → gọi `applySupplierResponse`. 409 `version_conflict` / `invalid_status`, 422 `reason_required` / `line_not_in_po` / `invalid_date` |
| GET | /orders/:id/pdf | PDF PO của mình (có đơn giá); audit `ncc.po_pdf` |
| GET | /debt?state=open\|all | `{summary:{balance, outstanding, overdueAmount, overdueCount, prepaid}, bills:[{code, supplierRef, provisional, issueDate, dueDate, total, outstanding, poCode, overdueDays}]}` (dùng `supplierDebtStatus` của ERP) |
| GET | /statement?from=&to= | Sao kê (`services/supplier-statement.ts`): hoá đơn, thanh toán, chiết khấu, xoá nợ, trả hàng, cấn trừ; `opening/closing/totals`; ≤366 ngày, ≤1000 dòng |
| GET | /payments?from=&to=&cursor= | Thanh toán đã ghi sổ: `code, paidAt, paidDate, amount, method, allocations[{billCode, amount}]`; **không** có quỹ, người lập, ghi chú, tham chiếu |

Test: `test/ncc-auth.test.ts`, `ncc-orders.test.ts`, `ncc-idor.test.ts`, `ncc-debt.test.ts`; E2E `e2e/ncc.mjs`.
