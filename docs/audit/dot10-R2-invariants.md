# Audit vòng 2: bất biến đối chiếu chéo toàn hệ thống

- Ngày: 28/11/2026
- Nhánh: `claude/audit2-invariants` (worktree `/home/user/wt-audit2-invariants`)
- Bộ test: `test/invariants-cross-module.test.ts`
- Kết quả: 12 test đạt, 1 test `it.fails` ghi nhận phát hiện R2-INV-01.
- Không sửa mã ứng dụng.

## Kịch bản "một ngày làm việc"

Mọi bước chạy qua API thật. SQL chỉ dùng để chèn dữ liệu gốc: sản phẩm, giá, nhà cung cấp, khách lẻ, khuyến mãi/voucher, quỹ COD, tham số, và dòng thẻ kho "tồn đầu" cho các lô có sẵn của `seedShop`.

Sau mỗi giai đoạn, `checkAll()` kiểm toàn bộ bất biến.

| # | Giai đoạn | Thao tác |
|---|---|---|
| 0 | Dữ liệu gốc | Kiểm bất biến ngay từ đầu. |
| 1 | Nhập hàng | 2 phiếu nhập có NCC (nhiều lô, giá vốn khác nhau, hạn dùng khác nhau) sinh hoá đơn mua. |
| 2 | Bán POS | Tiền mặt; QR qua SePay (tạo mã → webhook → thanh toán bằng `qrRequestId`); chia tiền mặt + chuyển khoản; ghi nợ khách lẻ; thu khác (phí giỏ quà); voucher; tặng điểm rồi đổi điểm. |
| 3 | Sau bán | Trả hàng nhập kho (thu ngân, có duyệt); trả không nhập kho; trả hàng nhanh; sửa hoá đơn có trả thêm; đổi hàng; huỷ đơn; thu nợ tại quầy; trả hàng đơn ghi nợ (trừ nợ trước, hoàn phần dư). |
| 4 | Đơn online | Web COD (xác nhận → soạn → đóng gói → giao → giao xong). Web chuyển khoản SePay khớp ngay. Chuyển khoản sai mã → khoản chờ → gán đơn → huỷ → hoàn. Tiền lạ → đã hoàn. Mã QR quầy bị thay → tiền về mã cũ → chờ hoàn. |
| 5 | Giao từ quầy | Trả trước tiền mặt + COD, giao xong. COD giao thất bại → nhập lại kho. Trả trước giao thất bại → hoàn tiền mặt. |
| 6 | B2B | Báo giá → gửi → chuyển đơn → soạn thiếu (có lý do) → giao → xác nhận giao thiếu + từ chối 1 kg → hoá đơn. Thu nợ một phần có phân bổ; thu trước chưa phân bổ. Khách lẻ trả dư (số dư có). Trả NCC một phần. |
| 7 | PO | Đơn sỉ thiếu hàng → `runPoCutoff` sinh PO nháp → duyệt → NCC xác nhận → nhận thiếu → đóng PO. |
| 8 | Kho | Kiểm kê lệch, hao hụt, xuất dùng nội bộ, chuyển kho 2 bước (kiểm cả lúc hàng đang đi đường). |
| 8b | Biên | Kiểm kê/hao hụt trên lô đang giữ hàng (bị chặn đúng). Trả hàng B2B sau hoá đơn. Huỷ đơn ghi nợ chưa thu. Đổi sang hàng rẻ hơn (hoàn chênh). Đổi điểm rồi trả hết (hoàn điểm). |
| 9 | Quỹ | Phiếu chi/thu thủ công; phiếu chi vượt ngưỡng chờ duyệt rồi duyệt; đảo phiếu; chuyển quỹ; đối soát COD 2 đơn (có phí) đưa quỹ chờ COD về 0; huỷ đơn có voucher. |
| 10 | Chốt ca | Chốt ca thu ngân có lệch và lý do. Quản lý huỷ đơn và trả hàng của ca đã chốt. Đơn giao từ quầy của ca đã chốt bị giao thất bại, chủ hoàn tiền từ ca của mình (B-N3). Chốt các ca còn lại. Doanh thu đủ 4 kênh. |

## Kết quả từng bất biến

| # | Bất biến | Kết quả |
|---|---|---|
| 1 | Số dư `/funds` = Σ phiếu đã ghi + Σ payments xác nhận theo `FUND_ORDER_OK`, viết lại độc lập trong test. Số này = số cuối kỳ của `/reports/cash-flow` (từng quỹ, toàn kỳ và hôm nay). Thêm: đầu + thu − chi = cuối. Thêm: không có payment xác nhận nằm ngoài số dư quỹ. | ĐẠT |
| 2 | Tồn lô = Σ `stock_moves`. Giữ hàng: 0 ≤ `qty_reserved` ≤ `qty_on_hand`, và `qty_reserved` = Σ giữ hàng `active`. Các cột `/reports/inventory` cân. Tồn báo cáo = Σ tồn lô. Σ giá trị tồn = Σ (lô × giá vốn). | ĐẠT |
| 3 | Phải thu từng khách: balance = Σ hoá đơn (kể cả điều chỉnh) − Σ thu + Σ hoàn − Σ điều chỉnh. Cột "còn nợ" = Σ hoá đơn − Σ phân bổ. Tuổi nợ = tổng còn nợ. Phải trả NCC tương tự. | ĐẠT |
| 4 | Doanh thu `/reports/pnl` = theo kênh = theo người bán (+ thu khác) = báo cáo cuối ngày = SQL độc lập. Giá vốn bằng nhau ở cả 4 báo cáo. Cost dòng = Σ lô × giá vốn lô. `orders.cost_total` = Σ dòng. Giá vốn + phần trả không nhập kho = giá trị xuất kho thực (đơn, phiếu giao, trả B2B). Tổng đơn hoàn tất = Σ thanh toán + ghi nợ. Đơn sỉ = hoá đơn. | ĐẠT |
| 5 | Dự kiến tiền mặt của ca (số đã chốt, hoặc công thức hiện hành nếu ca đang mở) = đầu ca + sổ tiền mặt của ca. Sổ này lấy theo `shift_id`/`pos_shift_id`/`refund_shift_id` cộng phiếu cọc và thu nợ trong khoảng ca. | ĐẠT |
| 5b | Quỹ tiền mặt = Σ (dự kiến − đầu ca) của mọi ca + phiếu ngoài công thức ca + thu chi ngoài ca. | ĐẠT |
| 5c | Phiếu bàn giao của ca **đã chốt** (`/shifts/:id/summary` → `cashFormula`) vẫn bằng số đã chốt sau khi huỷ đơn ở ca khác. | **SAI → R2-INV-01** |
| 6 | Điểm = Σ sổ điểm, không âm. Đơn đã huỷ có Σ điểm = 0. `used_count` = số lượt dùng `used`. Không còn lượt dùng trên đơn huỷ. | ĐẠT |
| 7 | Khoản chờ (`/sepay/hold`) = Σ CK_CHO_XL − Σ CK_CHO_XL_RA = Σ sự kiện còn treo (số tiền và số lượng). Mỗi bước SePay: quỹ ngân hàng tăng đúng tiền báo về − hoàn. Đã kiểm 6 bước: QR quầy, khớp ngay, gán, hoàn đơn, tiền lạ đã hoàn, QR bị thay. | ĐẠT |
| 8 | Audit lấy mẫu trên đơn ERP, phiếu kho, phiếu thu chi thủ công/đảo, phiếu thu nợ, chuyển quỹ, đối soát, PO, báo giá, ca, phiếu giao, sự kiện SePay. Mọi chứng từ đều có dòng audit. | ĐẠT (xem ghi chú L-2) |

Bộ kiểm có tác dụng thật. Thử làm hỏng dữ liệu một lần (rồi xoá phần thử) thì các bất biến bắt được: lệch lô, cost dòng, đổi kênh đơn, payment lạ trong ca, điểm, `used_count`, khoản chờ, chứng từ thiếu audit.

## Phát hiện

### R2-INV-01: Trung bình, ca đã chốt bị tính lại hồi tố

- **Kịch bản:**
  1. Thu ngân bán 100.000đ tiền mặt rồi chốt ca: `expected_cash` = X.
  2. Quản lý (có ca đang mở) huỷ đơn đó (A-06: tiền hoàn lấy từ két ca quản lý, `refund_shift_id` = ca quản lý).
  3. `GET /shifts/{ca thu ngân}/summary` trả `shift.expectedCash` = X (số đã lưu), nhưng `cashFormula.expected` = X − 100.000. `cashSold`, `sales`, `byPayment` cũng giảm.
  4. Hệ quả: phiếu bàn giao in lại có công thức (đầu ca + bán tiền mặt − hoàn …) không cộng ra số dự kiến và số đã đếm lúc chốt. Comment A-06 trong code ghi "số liệu ca đã chốt giữ nguyên", nhưng điều này không đúng với phiếu bàn giao.
- **Nghi ngờ:**
  - `src/worker/services/shift-report.ts:145-151`: `cashFormula` chỉ cộng đơn `o.status='completed'` của ca. Đơn bị huỷ sau khi chốt rơi khỏi ca gốc, dù tiền đã nằm trong két lúc chốt.
  - `src/worker/services/shift-report.ts:168-183,219-229`: `shiftSummary` luôn tính lại `salesSummary`/`paymentBreakdown`/`cashFormula` cả với ca đã chốt.
  - `src/worker/routes/pos.ts:1325-1338`, `:1381`: luồng void gắn `refund_shift_id`.
- **Gợi ý sửa:** với ca đã chốt, `cashFormula` cộng lại payment `status='refunded'` của đơn có `refund_shift_id` ≠ ca này. Hoặc lưu bản chụp công thức lúc chốt (`shifts.formula_json`) và in lại từ bản chụp.
- **Test:** `it.fails("10b. [R2-INV-01] …")`. Bỏ `.fails` khi đã sửa.

### Ghi chú mức thấp (không làm sai bất biến, không đánh `it.fails`)

- **L-1. Ghi sổ và audit tách thành hai lệnh:**
  - `POST /vouchers` (`src/worker/routes/finance.ts:118-136`): `INSERT cash_vouchers` chạy `.run()` riêng, sau đó mới batch audit + approval.
  - `POST /vouchers/:id/reverse` (`finance.ts:182-194`): batch tạo phiếu đảo không có `auditStmt`, audit chạy `.run()` sau đó.
  - `POST /shifts/open` (`pos.ts:128-136`): cũng tách như trên.
  - Trái quy ước CLAUDE.md "một `db.batch` kèm `auditStmt`". Nếu lệnh thứ hai lỗi, sẽ có phiếu không có audit, hoặc phiếu chờ duyệt không có approval.
- **L-2. Audit phiếu đảo, phiếu nhập từ PO và phiếu trả B2B không tra được theo id của chính chứng từ:** audit nằm trên chứng từ gốc (`voucher.reverse` trên phiếu gốc, `po.receive` trên PO, `b2b_order.return` trên đơn gốc), mã chứng từ mới chỉ có trong `after_json`. Màn audit lọc theo chứng từ mới sẽ không thấy gì.
- **L-3. Lệch tiền khi chốt ca không vào sổ quỹ:** chốt ca thiếu 10.000đ thì `diff_cash` = −10.000 nhưng số dư quỹ tiền mặt vẫn theo số dự kiến. Tiền đầu ca cũng không phải phiếu thu, nên số dư quỹ không khớp tiền thật trong két. Đây là thiết kế hiện hành (EC-32 chỉ ghi lý do), nên cân nhắc thêm phiếu điều chỉnh chênh lệch ca.
- **L-4. Quỹ âm (đã biết, C-23):** phiếu chi 6 triệu được duyệt làm quỹ ngân hàng âm 5,6 triệu. Phiếu thu chi không kiểm số dư, trong khi chuyển quỹ có kiểm.

## Lệnh đã chạy

- `npx vitest run test/invariants-cross-module.test.ts`: 12 đạt, 1 expected fail.
- `npx vitest run` (toàn bộ): 129 file, 1125 đạt + 1 expected fail, exit 0.
