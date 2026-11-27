# Audit B — Kho, đơn hàng, POS (nhánh PR #23 + POS-KV đợt B), 27/11/2026

Phạm vi: `routes/pos-delivery.ts`, `services/online-ops.ts`, `routes/pos.ts` (người bán, meta, ghi nợ, thu khác, trả/đổi/huỷ), `src/web/offline.ts`, `Pos.tsx`, `PosDeliverySheet.tsx`, `routes/imports.ts` + `services/import-*.ts`, xuất dùng nội bộ (`routes/inventory.ts`, migration 0035).
Test thăm dò (worktree `/home/user/wt-audit-b`, KHÔNG commit):
- `test/probe-b-delivery.test.ts` (P1–P4, đều PASS = lỗi tái hiện được)
- `test/probe-b-import-inv.test.ts` (I1, V1, đều PASS = lỗi tái hiện được)

Chạy: `npx vitest run test/probe-b-delivery.test.ts test/probe-b-import-inv.test.ts --reporter=verbose`

---

## Phát hiện đã kiểm chứng

### B-N1 — Cao — Giao tại quầy: thử lại sau lỗi giữa chừng được báo "đã tạo đơn, đang giao" cho một đơn ĐÃ HUỶ
- File: `src/worker/routes/pos-delivery.ts:91-94` (và `:144-147`), `src/web/components/PosDeliverySheet.tsx:38,67-79`.
- Khi một bước sau lúc tạo nháp bị lỗi (xác nhận/soạn/đóng gói/giao, hoặc batch giữ hàng thua tranh chấp tồn), route tự `cancelOrder` → đơn `cancelled` nhưng vẫn giữ `client_uuid`. Sheet giữ nguyên `uid` (`useState(() => uuid())`) nên khi thu ngân bấm lại, máy chủ trả **200** `{status:"cancelled", created:false}`. UI không kiểm `status`/`created` → `setRes` + toast "Đã tạo đơn giao … — đang giao", in phiếu giao. Hàng giao đi mà không trừ kho, tiền trả trước thu tại quầy không có `payments`, không có COD.
- Tái hiện: P1 (trigger chặn INSERT payments lần đầu → đơn tự huỷ; gửi lại cùng body → 200, status `cancelled`, 0 payments).
- Sửa: ở route, gặp đơn `cancelled` theo `clientUuid` → 409 `order_cancelled` (hoặc giải phóng uuid như `retireStaleDraft` để tạo mới); UI tạo `uid` mới sau mỗi lỗi và chỉ coi là thành công khi `status==='shipping'`.

### B-N2 — Cao — Hoàn tiền đơn giao tại quầy nhiều hình thức: toàn bộ số hoàn ghi vào hình thức/quỹ của dòng thanh toán ĐẦU TIÊN
- File: `src/worker/services/online-payments.ts:136-166` (`paidNet`/`refundPlan` lấy `method, fund_id` của payment dương đầu tiên), dùng bởi `refundOrder` (`online-ops.ts`).
- Trước B3, đơn online chỉ có một dòng thu; B3 cho phép trả trước nhiều hình thức + COD.
- P2: trả trước 100k tiền mặt + 120k chuyển khoản, giao thất bại → trả hàng → kế toán bấm hoàn → một dòng `cash −200.000` vào quỹ tiền mặt (fund 1); quỹ ngân hàng vẫn giữ 120k. Tiền mặt dự kiến của ca giảm 200k dù chỉ nhận 100k tiền mặt.
- P3: trả trước 100k tiền mặt, COD 120k (vào quỹ chờ đối soát), giao xong rồi trả toàn bộ → hoàn `cash −220.000` từ két; 120k COD vẫn nằm ở `cod_clearing`.
- Hậu quả: số dư quỹ tiền mặt/ngân hàng/COD sai, chốt ca lệch, báo cáo hình thức thanh toán sai.
- Sửa: hoàn theo từng dòng thu (phân bổ ngược theo phương thức/quỹ, ví dụ ưu tiên COD/chuyển khoản trước tiền mặt) hoặc cho kế toán chọn quỹ/hình thức hoàn; có test cho đơn nhiều dòng thu.

### B-N3 — Trung bình — Hoàn tiền mặt của đơn giao tại quầy sau khi ca tạo đơn đã chốt: không ca nào trừ tiền mặt dự kiến
- File: `src/worker/services/shift-report.ts:119-123` (khoản `delivery` tính theo `o.pos_shift_id`), `refundOrder` không ghi ca hoàn (không có tương đương `refund_shift_id` của A-06).
- P4: tạo đơn trả trước 220k tiền mặt → chốt ca → mở ca mới → giao thất bại, trả hàng, hoàn → dòng `cash −200.000` ở quỹ tiền mặt, tiền mặt dự kiến ca đang mở không đổi (0 → 0). Ca cũ đã chốt lưu `expected_cash` cố định nên khoản hoàn "biến mất" khỏi đối chiếu két.
- Sửa: ghi `refund_shift_id` (ca đang mở của người chi, bắt buộc có ca nếu hoàn tiền mặt) và tính vào `cashFormula` như A-06; hoặc buộc hoàn tiền mặt qua phiếu chi quỹ, không qua két.

### B-N4 — Trung bình — Nhập Excel hàng hoá: mã hàng khác hoa/thường được coi là "đã có" nhưng đơn vị quy đổi và giá KHÔNG được ghi (báo thành công)
- File: `src/worker/services/import-excel.ts:154,180,241` (so khớp `lc(sku)`), ghi bằng `WHERE sku = ?` với mã trong file (`:306-321`); `products.sku` UNIQUE phân biệt hoa thường (`0001_init.sql:122`).
- I1: có `PRB-TAO`; file ghi `prb-tao`, giá 150.000, dòng phụ "thùng ×10", mode update → xem trước báo "Giá bán: chưa có → 150.000", commit 201 `updated:1`; thực tế chỉ đổi tên (UPDATE theo id), không có đơn vị "thùng", không có giá.
- Rủi ro thêm (nhánh người có `prices.write` nhưng không `prices.approve`, hiện không vai mặc định nào rơi vào): `INSERT INTO approvals … ref_id = last_insert_rowid()` sau một INSERT…SELECT 0 dòng sẽ trỏ tới rowid của câu INSERT trước đó → yêu cầu duyệt giá trỏ sai bản ghi giá.
- Sửa: dùng `it.existing.sku` (mã trong DB) cho mọi câu `WHERE sku = ?` của hàng đã có (hoặc dùng `existing.id`); bỏ `last_insert_rowid()` → `INSERT … RETURNING` hoặc tham chiếu theo khoá.

### B-N5 — Trung bình — Xuất dùng nội bộ trừ được từ lô đang cách ly
- File: `src/worker/routes/inventory.ts:489-541` (`planPost` chỉ chặn `lot_not_active` cho `transfer`, không cho `internal_use`); đường quét mã `:338-339` cũng không chặn với `internal_use`.
- V1: thêm dòng từ lô → `POST /lots/:id/quarantine` → ghi sổ phiếu XN → 200 `posted`, lô `quarantine` bị trừ 1kg (hàng hỏng/nghi nhiễm dùng làm hàng mẫu/ăn thử).
- Sửa: chặn `lot.status !== 'active'` cho `internal_use` khi ghi sổ và khi quét (như transfer).

### B-N6 — Trung bình — Thưởng doanh số % (cách tính cũ, kỳ không có quy tắc hoa hồng) trừ cả hàng trả của đơn KHÔNG phải POS
- File: `src/worker/routes/payroll.ts:95-101`: truy vấn `returns` không lọc `so.channel='pos'`, trong khi `sales` chỉ tính `channel='pos'`. Với B3, đơn giao tại quầy (`channel='social'`, `created_by` = thu ngân) khi bị trả hàng sau giao sẽ trừ vào doanh số thưởng của thu ngân dù đơn đó chưa từng được cộng; tương tự đơn MXH do NV online tạo, đơn sỉ.
- Kiểm chứng: đọc SQL (chưa viết probe vì cần dựng bảng lương). `services/commission.ts:55` (quy tắc mới) lọc đúng kênh, chỉ đường cũ sai.
- Sửa: thêm `AND so.channel = 'pos'` vào truy vấn returns.

---

## Đã kiểm, không thấy lỗi
- Migration 0035 dựng lại `stock_docs`: so cấu trúc sau 0034 và sau 0040 bằng sqlite (python): cột, kiểu, mặc định, NOT NULL, FK, chỉ mục `idx_stock_docs_po` + UNIQUE `code` giống hệt; không có trigger/view trên `stock_docs` bị mất; `foreign_key_check` sạch. Chỉ khác CHECK `type` thêm `internal_use`.
- Xuất dùng nội bộ: lý do bắt buộc, FEFO, ngưỡng `approval.internal_use_vnd`, người lập không có `inventory.approve` luôn chờ duyệt, không tự duyệt (`admin.ts:69`), khoá sổ, P&L `internalUse` + cột riêng NXT (test có sẵn).
- Giao tại quầy: đúng tổng (prepay+COD), giữ hàng/xuất đúng lô FEFO, COD chỉ thu `total − paid_total`, doanh thu khi hoàn tất, khoá sổ, quyền; lỗi giữa chừng tự huỷ không để lại giữ hàng/tiền (test sẵn). `repriceAfterPack` chỉ chạy cho `channel='online'` nên không gây `total_changed` cho đơn `social`.
- Ghi nợ POS: guard hạn mức đầu batch, phiếu duyệt vượt hạn mức dùng một lần (`onceStmt`), trả hàng trừ nợ trước, huỷ chỉ khi chưa thu, đổi hàng bị chặn với đơn nợ.
- Thu khác: không áp KM/điểm (đảo điểm theo tổng trừ `charges_total`), chỉ hoàn khi trả toàn bộ + lý do, guard số còn hoàn.
- Nhập Excel: chống công thức (xlsx `<f>` + ký tự đầu), giới hạn 2MB / 25MB giải nén / 1000 dòng / 40 cột, `onceStmt` theo hash+mode, quyền theo loại, hạn mức khách sỉ mới theo ngưỡng A-10, khách đã có chỉ chủ đổi hạn mức.
- `PATCH /orders/:id/meta`: version theo đếm audit + `assertStmt`, kiểm khoá sổ, chỉ đơn bán, người bán hợp lệ.

## Nghi ngờ, chưa kiểm chứng
1. **POS mở ở 2 cửa sổ trình duyệt** (Trung bình nếu đúng): `Pos.tsx` đọc `hm_pos_tabs` từ localStorage một lần khi tải module, không nghe sự kiện `storage`. Hai cửa sổ cùng khôi phục một `cartId`; cửa sổ A bán xong, cửa sổ B bán giỏ KHÁC với cùng `cartId` → `/pos/orders` trả 200 đơn của A (idempotent không so nội dung) → B báo "Thanh toán thành công", hàng của B không được ghi. Chưa chạy trên trình duyệt. Gợi ý: so băm nội dung giỏ khi trùng `clientUuid` (409 nếu khác) và/hoặc nghe `storage` / khoá theo cửa sổ (sessionStorage).
2. Thưởng doanh số cũ (`payroll.ts` `SUM(total)`) cộng cả `charges_total` (thu khác: phí đóng gói/giao) và phần ghi nợ chưa thu — cần chủ xác nhận có tính thưởng trên thu khác không.
3. Sửa người bán (`orders.edit`) không bị chặn khi kỳ lương đã duyệt (chỉ chặn khoá sổ) → báo cáo hoa hồng/người bán lệch phiếu lương đã duyệt. Cần quyết định nghiệp vụ.
4. Tóm tắt ca (`shiftSummary.byPayment`, lọc `o.shift_id`) không hiện tiền trả trước của đơn giao tại quầy (đơn có `pos_shift_id`, `shift_id` NULL) trong khi `cashFormula` có tính → phiếu bàn giao: bảng hình thức thanh toán không khớp tiền mặt dự kiến. Chưa viết probe.
5. Thiết kế `POS-KV-B.md` nhắc "khung giờ đầy → 409" và "khung giờ" trên phiếu giao, nhưng `/pos/delivery-orders` không nhận slot nên không kiểm sức chứa khung giờ; đơn giao tại quầy không chiếm chỗ khung giờ của web. Có thể là chủ ý (giao ngay).
6. `GET /pos/deliverers` trả mọi tài khoản đang hoạt động (cả kế toán, chủ) cho thu ngân chọn người giao. Lộ danh sách tên tài khoản, mức Thấp.
