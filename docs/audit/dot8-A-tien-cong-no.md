# Audit mảng A — Tiền & công nợ (PR #23, nhánh `claude/audit-a`)

Phạm vi: bán nợ khách lẻ (B1), thu nợ tại quầy, QR `HDS`, thu khác (B2), chuyển quỹ, `cashFormula`, báo cáo cuối ngày/lãi lỗ/theo kênh/người bán/hoa hồng, `debt_adjustments.posted_at`, ngân sách – thực tế.
Phương pháp: đọc mã + test thăm dò trong worktree `/home/user/wt-audit-a` (không commit):
- `test/probe-a-1.test.ts` (PA-1…PA-4) — 4/4 đạt (đạt = lỗi được tái hiện).
- `test/probe-a-2.test.ts` (PA-5, PA-6) — 2/2 đạt.

Chạy: `npx vitest run test/probe-a-1.test.ts test/probe-a-2.test.ts`

Không có phát hiện mức Nghiêm trọng. Các điểm chính đã kiểm và **đúng**: dòng `payments(method='credit', fund_id NULL)` không làm sai số dư quỹ (`/funds`, `fund-transfers` BALANCE_OK_SQL, dòng tiền M6, sổ quỹ export, đối soát COD đều lọc theo `fund_id`); `cashFormula` chỉ cộng `method='cash'`; chốt chặn hạn mức hai quầy (`creditLimitGuard` đầu batch); trả hàng đơn ghi nợ trừ nợ trước (guard `order.return.debt`), trả đồng thời/huỷ + thu nợ đồng thời có assert; thu khác không vào KM/voucher/điểm (payableTotal = goodsTotal, reversal dùng giá trị hàng); lãi lỗ/theo kênh/cuối ngày cộng thu khác nhất quán (bán +charges_total, trả −charges_total đã hoàn); `posted_at` được ghi ở mọi chỗ INSERT/duyệt `debt_adjustments`, backfill ở 0032.

---

## Cao

### PA-6. Trả hàng hoàn "thu khác" không tính vào ngưỡng duyệt giá trị lớn → thu ngân hoàn tiền mặt lớn không cần duyệt
- File: `src/worker/routes/pos.ts:1028` (`returnApprovalReasons(db, orig, shift, prepared, linesTotal)`), ngưỡng ở `returnApprovalReasons` `pos.ts:~938` (`approval.pos_return_vnd`).
- Kịch bản: quản lý bán đơn hàng 100.000 + thu khác nhập tay 600.000, khách trả thẻ 700.000. Thu ngân trả toàn bộ, `refundCharges: true`, `refundMethod: "cash"` → 201, hoàn **700.000 tiền mặt** từ két, không cần duyệt. Đối chứng: đơn hàng hoá 700.000 trả cùng cách → 409 `approval_required`.
- Kết hợp với việc hoàn được bằng phương thức khác phương thức đã thu (thẻ → tiền mặt) và loại thu khác có `default_amount = 0` cho thu ngân tự nhập số tiền tuỳ ý (`services/order-charges.ts:30`), đây là đường rút tiền mặt khỏi két vượt kiểm soát.
- Test: `probe-a-2` › "PA-6 …" (đạt).
- Sửa: truyền `total` (hàng + thu khác hoàn) vào `returnApprovalReasons`; cân nhắc buộc `refundCharges` cần quyền `pos.other_charge` hoặc duyệt.

## Trung bình

### PA-1. Báo cáo thuế GTGT (`/reports/vat`) cộng hoá đơn ghi nợ POS vào doanh thu chịu thuế đầu ra
- File: `src/worker/routes/finance-extra.ts:104-127` (lọc `invoices WHERE status<>'cancelled' AND is_opening=0`, không lọc theo nguồn); hoá đơn tạo ở `services/pos-credit.ts:43-63`.
- Kịch bản: bán đơn POS 200.000 (tiền mặt 50.000 + ghi nợ 150.000) → `output.base` tăng 150.000 và `output.count` tăng 1 (thuế suất 0%). Huỷ đơn → thêm hoá đơn `adjustment` âm, count tăng tiếp. Chỉ phần ghi nợ bị tính, phần trả tiền không → số liệu vô nghĩa, trái với ghi chú "không gồm doanh thu bán lẻ POS". Export `hoa-don-ban` cũng lẫn các chứng từ nội bộ này.
- Test: `probe-a-1` › "PA-1 …" (đạt).
- Sửa: loại hoá đơn có `order_id` thuộc đơn `channel='pos'` (hoặc `einvoice_status='not_required' AND order_id IS NOT NULL`) khỏi `/reports/vat` và báo cáo hoá đơn bán; hoặc đánh dấu cột nguồn.

### PA-5. Đảo phiếu thu nợ tại quầy không trừ khỏi tiền mặt dự kiến của ca
- File: `src/worker/services/shift-report.ts:103-111` (`cashFormula`, lọc `v.created_by = s.user_id`); phiếu đảo do `routes/debts.ts:347-368` lập với `created_by` = người đảo (cần `debt.write`, thu ngân không có).
- Kịch bản: thu ngân thu nợ 120.000 tiền mặt, quản lý đảo phiếu (`POST /debts/payments/:id/reverse`) và trả lại tiền khách → `cashFormula.debtCollected` vẫn 120.000; chốt ca báo thiếu 120.000. Chú thích "Phiếu đảo tự trừ ngược" chỉ đúng khi chính thu ngân đảo, điều không bao giờ xảy ra.
- Test: `probe-a-2` › "PA-5 …" (đạt).
- Sửa: tính phiếu đảo theo phiếu gốc (`reverses_id` trỏ phiếu do người mở ca lập trong ca), không theo `created_by` của phiếu đảo; tương tự cho `order_deposit`.

### PA-2. Phiếu duyệt vượt hạn mức không gắn với dư nợ lúc duyệt → dư nợ vượt nhiều hơn mức đã duyệt
- File: `src/worker/routes/pos.ts:419,477-483,534-536`; `services/pos-credit.ts:35-41` (`allowOver` chỉ kiểm `credit_limit > 0`).
- Kịch bản: hạn mức 100.000, dư nợ 0, xin duyệt ghi nợ 150.000 (vượt 50.000) → quản lý duyệt. Trước khi dùng phiếu, thu ngân bán thêm một đơn nợ 100.000 (trong hạn mức) → dùng phiếu vẫn qua; dư nợ 250.000 (vượt 150.000). Payload duyệt không có dư nợ/hạn mức nên người duyệt không biết mức vượt.
- Test: `probe-a-1` › "PA-2 …" (đạt).
- Sửa: lưu `outstanding` lúc xin duyệt vào payload/hash; guard khi `allowOver` = `OPEN_DEBT + amount <= outstanding_lúc_duyệt + amount` (hoặc ≤ hạn mức + phần vượt đã duyệt).

## Thấp

### PA-3. `/reconcile/shifts` (màn Tài chính → đối soát ca) tính tiền dự kiến ca đang mở bằng công thức cũ
- File: `src/worker/routes/finance.ts:196-220` (`computed_expected` = đầu ca + tiền mặt bán), dùng ở `src/web/screens/Finance.tsx:254`.
- Kịch bản: ca đang mở có thu nợ tiền mặt 120.000 → `expected_cash` ở danh sách nhỏ hơn `/shifts/:id/summary` đúng 120.000 (cũng thiếu cọc, hoàn tiền huỷ đơn, trả trước đơn giao, trừ tiền hoàn trả hàng). Trái với tuyên bố "công thức chỉ còn một chỗ".
- Test: `probe-a-1` › "PA-3 …" (đạt).
- Sửa: gọi `cashFormula` cho ca đang mở.

### PA-4. Dòng tiền M6 (`/reports/cash-flow`) đếm chuyển quỹ vào tổng thu và tổng chi
- File: `src/worker/services/finance-reports.ts:241-251` (không loại khoản mục `pnl_line='transfer'`, khác `shift-report.ts cashFlow`).
- Kịch bản: chuyển 1.000.000 tiền mặt → ngân hàng → `totalInflow` và `totalOutflow` cùng +1.000.000 (số dư cuối đúng). Báo cáo cuối ngày thì đã loại.
- Test: `probe-a-1` › "PA-4 …" (đạt).
- Sửa: tách dòng "Chuyển quỹ nội bộ" khỏi `inflows/outflows`, không cộng vào tổng.

### PA-7. Doanh thu dùng cho thưởng/hoa hồng không nhất quán với thu khác (đọc mã, chưa viết test)
- Hoa hồng theo quy tắc dùng `line_total` (không gồm thu khác) — `services/commission.ts:47-58`; thưởng doanh số cũ dùng `SUM(orders.total)` (gồm thu khác, trả hàng trừ cả phí đã hoàn) — `routes/payroll.ts:89,98`; báo cáo người bán dùng `o.total` — `routes/sales-reports.ts:47`. Cùng một đơn: báo cáo người bán ≠ cơ sở hoa hồng; khi không có quy tắc, phí đóng gói/giỏ quà/phí giao vẫn được tính thưởng %.
- Sửa: chốt một định nghĩa (khuyến nghị loại `charges_total` khỏi cơ sở thưởng: `total - charges_total`) và ghi rõ trên màn báo cáo.

### PA-8. Ngân sách – thực tế thiếu khoản xoá nợ / chênh lệch giá mua so với lãi lỗ (đọc mã)
- File: `routes/finance-extra.ts:190-207` chỉ lấy `stockCount`, `internalUse` từ `pnlAdjustments`; `/reports/pnl` còn có `badDebt`, `purchaseVariance`, `paymentDiscount` (giảm trừ doanh thu). Tổng thực tế của ngân sách lệch với lãi lỗ cùng kỳ.
- Sửa: cộng `badDebt` (+`purchaseVariance`) vào dòng `other` (hoặc dòng riêng), trừ `paymentDiscount` khỏi `revenue`.

---

## Nghi ngờ, chưa kiểm chứng
1. **Chốt ca đồng thời với bán/thu nợ** (`pos.ts:142-175`, checkout `pos.ts:513-597`, `pos-credit.ts` thu nợ): batch bán hàng không có `assertStmt` "ca còn mở" (đổi hàng và đơn giao có). Đơn hoặc phiếu thu nợ ghi ngay sau khi tính `expected` (hoặc sau `closed_at`) rơi ra ngoài mọi ca → két lệch. Lỗi cũ, nhưng B1 thêm một đường nữa (phiếu thu nợ có `created_at > closed_at` không thuộc ca nào). Chốt ca cũng không có `assertStmt`/`onceStmt` (bấm 2 lần ghi 2 audit).
2. **Hoàn tiền đơn giao từ quầy (B3)**: `refundPlan` (`services/online-payments.ts:150-165`) ghi dòng âm vào quỹ của khoản trả trước đầu tiên (quỹ két ca), đơn có `pos_shift_id` → `cashFormula.delivery` trừ vào ca của thu ngân, kể cả khi người hoàn là kế toán lấy tiền nơi khác; nếu ca đã chốt thì số đã chốt không đổi.
3. **Gộp khách lẻ** (`retail-customers.ts:338-341`): kiểm "khách nguồn có hoá đơn" đọc trước batch, không có trong `assertStmt` → đơn ghi nợ đồng thời có thể để lại hoá đơn nợ trên hồ sơ đã gộp (ẩn khỏi hạn mức của khách đích).
4. **Hoá đơn không bao giờ đổi `status` khỏi 'open'** → `creditInvoiceOf` luôn thấy hoá đơn của đơn ghi nợ kể cả đã thu đủ → đơn ghi nợ đã trả hết vẫn bị chặn Đổi hàng (`pos.ts:1123`). Bất tiện nghiệp vụ.
5. **QR HDS trên phiếu in** cố định số tiền = còn nợ lúc in; sau khi trả một phần/trả hàng, khách quét mã cũ → `amount_mismatch`, vào danh sách chưa khớp (đúng thiết kế SePay nhưng dễ gây phàn nàn).
6. `GET /pos/invoices/:id/pay-info` (quyền `pos.sell`) trả mã/số còn nợ của mọi hoá đơn khách lẻ theo id, và ghi `pay_codes` trong một GET. Rủi ro thấp.
7. `requireApproval` chọn loại phiếu theo lý do đầu tiên: giỏ vừa giảm giá vượt ngưỡng vừa vượt hạn mức → loại `order.discount` (không phải `order.credit`/quyền `pos.credit`). Hiện tại cùng nhóm người duyệt nên chưa khai thác được.
