# Bán hàng tại quầy — đợt B: bán nợ khách lẻ, thu khác, giao hàng tại quầy

Trạng thái (26/11/2026): **thiết kế đã chốt** (quyết định ở mục 5), đang làm. Đợt A đã xong (PR #23, `docs/POS-KV.md`).

Nguyên tắc: dùng lại cơ chế đang có, không làm sổ sách song song.
- Bán nợ khách lẻ → dùng **hoá đơn phải thu** (`invoices`), thu nợ (`debt_payments` + `debt_allocations`), tuổi nợ, sao kê, QR SePay mã `HDS` y như khách sỉ. Các route công nợ hiện không giới hạn khách sỉ.
- Giao hàng tại quầy → dùng **luồng đơn online do nhân viên tạo** (`createSocialOrder` trong `services/online-ops.ts`): soạn, đóng gói, giao, giao thất bại, trả hàng, COD, đối soát COD đều đã có.
- Thu khác → bảng dòng phí mới gắn vào đơn, cộng vào tổng đơn, báo cáo tách riêng.

Quy ước như `CLAUDE.md`: một `db.batch` + `auditStmt`; `assertStmt` cho kiểm tra hạn mức/số dư; `assertPeriodOpen`; `requirePerm` + zod; migration mới từ **0038**.

---

## B1. Bán nợ cho khách lẻ

### Luồng
1. Thu ngân gắn khách lẻ (bắt buộc có SĐT) → thanh toán. Ô **Ghi nợ** = phần còn thiếu (tổng − các khoản đã thu).
2. Máy chủ kiểm tra trong **cùng batch** lập đơn:
   - `pos.retail_credit_enabled = 1` (mặc định **tắt**).
   - Khách có `credit_limit > 0`; nợ đang mở + phần ghi nợ ≤ `credit_limit` → `assertStmt` (chống hai quầy cùng ghi nợ vượt hạn mức).
   - Phần ghi nợ > `approval.pos_credit_vnd` hoặc thu ngân không có quyền `pos.credit` → cần quản lý duyệt tại chỗ (dùng luồng phê duyệt POS hiện có như giảm giá vượt ngưỡng).
3. Đơn hoàn tất như thường (doanh thu ghi ngày bán, trừ kho FEFO). Cùng batch sinh **hoá đơn phải thu** `invoices(kind='sale', customer_id, order_id, total = phần ghi nợ, due_date = ngày bán + customers.payment_terms_days, einvoice_status='not_required')`. Phần đã thu ngay vẫn là `payments` như cũ (tiền mặt vào két ca).
4. Phiếu in có dòng **Còn nợ** và **mã QR thu nợ** (mã `HDS…` của hoá đơn, số tiền = còn nợ) để khách quét trả sau; SePay tự gạch nợ (luồng sẵn có).
5. Thu nợ tại quầy: nút **Thu nợ** trên POS (chọn khách → danh sách hoá đơn nợ → thu tiền mặt/QR) gọi `POST /debts/payments` hiện có, ghi vào **quỹ của ca** (tiền mặt) nên có trong tiền mặt dự kiến khi chốt ca (`cashFormula` thêm khoản thu nợ tiền mặt do người mở ca lập trong ca — giống cách tính cọc đặt trước).

### Trả hàng / huỷ đơn có ghi nợ
- **Trả hàng**: giá trị trả trừ vào nợ còn lại của hoá đơn trước (hoá đơn `adjustment` âm trỏ `original_invoice_id`, như A-01), phần vượt mới hoàn tiền. Một batch.
- **Huỷ đơn**: chỉ được khi hoá đơn chưa được thu đồng nào; sinh hoá đơn `adjustment` bằng toàn bộ (hoá đơn đã phát hành không sửa/xoá). Đã thu một phần → dùng Trả hàng.

### Dữ liệu / API
- Migration `0038_pos_credit.sql`: không cần bảng mới. Thêm tham số `pos.retail_credit_enabled` (0), `pos.retail_credit_default_limit` (0), `approval.pos_credit_vnd` (500.000), `pos.retail_credit_default_terms_days` (7) vào `settings` + `settings-registry.ts`; quyền `pos.credit` (owner, manager) trong `lib/rbac.ts`.
- `POST /pos/orders` nhận thêm `credit?: { amount }` (phải bằng đúng tổng − Σ payments; sai → 422 `credit_mismatch`; không có khách → 422 `credit_needs_customer`; vượt hạn mức → 409 `credit_limit_exceeded`).
- Màn **Khách lẻ**: đặt hạn mức + kỳ hạn (quyền `b2b.write`; vượt `b2b.new_credit_limit_max_vnd` cần chủ duyệt — luồng A-10), tab **Công nợ** (hoá đơn mở, đã thu, sao kê).
- Báo cáo cuối ngày: dòng "Công nợ" trong bảng hình thức thanh toán lấy từ phần ghi nợ (đang hiện 0).
- Đơn **offline** không được ghi nợ (không kiểm được hạn mức) — nút Ghi nợ ẩn khi mất mạng.

---

## B2. Thu khác trên hoá đơn

### Luồng
- Giỏ POS có nút **+ Thu khác**: chọn loại có sẵn (Phí đóng gói, Phí giao hàng, Phí giỏ quà… do chủ cấu hình) hoặc nhập tay (tên + số tiền, cần quyền `pos.other_charge`). Cộng vào **tổng đơn**, không áp khuyến mãi/voucher/điểm, không tích điểm.
- Báo cáo: tách dòng **Thu khác** trong doanh thu (như phí giao `shipping` của A-08), lãi lỗ theo kênh và báo cáo cuối ngày cộng đúng.
- Trả hàng: mặc định **không hoàn** thu khác; trả toàn bộ đơn thì hỏi "hoàn cả thu khác?" (cần lý do).

### Dữ liệu / API
- Migration `0039_order_charges.sql`: bảng `charge_types(id, code, name, default_amount, active, version)` (mẫu id ≥ 900) và `order_charges(id, order_id, charge_type_id NULL, name, amount > 0, refunded_amount DEFAULT 0, created_at)`; `orders.charges_total INTEGER NOT NULL DEFAULT 0`.
- `POST /pos/orders` nhận `charges?: [{ chargeTypeId?, name?, amount }]` (≤ 10). Máy chủ tính lại tổng = hàng − giảm giá + charges.
- `GET/POST/PATCH /charge-types` (quyền `settings.manage` để sửa, `pos.sell` để xem).

---

## B3. Bán giao hàng tại quầy

### Luồng
1. Trong giỏ POS bật **Giao hàng**: nhập người nhận, SĐT, địa chỉ (gợi ý từ sổ địa chỉ khách), khu vực giao (gợi ý phí theo khu vực), phí giao (sửa được → ghi vào `orders.shipping_fee` như đơn online, không dùng bảng thu khác), **người giao**: nhân viên cửa hàng (chọn trong danh sách) hoặc xe ngoài (tên hãng + mã vận đơn nhập tay, cột `carrier`/`carrier_tracking_no` sẵn có).
2. Thanh toán: khách có thể **trả trước tại quầy** (tiền mặt/QR/chuyển khoản — vào két ca như bán thường) và/hoặc **thu hộ COD** phần còn lại.
3. Máy chủ tạo **đơn online** qua `createSocialOrder` với `source='pos'`, ghi `orders.pos_shift_id` để biết ca tạo. Hàng đã cân và đóng gói tại quầy nên đơn **đi thẳng sang "Đang giao"** (`shipping`) — máy chủ chạy đúng các bước chuyển trạng thái sẵn có (xác nhận giữ hàng FEFO → đóng gói theo khối lượng thực → giao) trong MỘT batch, không viết đường tắt sửa trạng thái. Sau đó ở màn **Đơn online**: hoàn tất / giao thất bại / trả hàng như đơn thường.
4. Doanh thu ghi khi đơn **hoàn tất giao** (như đơn online), không ghi lúc bán tại quầy. Tiền trả trước tại quầy là `payments` của đơn (số dư quỹ đã gồm, theo A-11).
5. COD: người giao thu rồi nộp — dùng quỹ chờ đối soát COD và màn đối soát COD hiện có.

### Dữ liệu / API
- Migration `0040_pos_delivery.sql`: `orders.source TEXT` (NULL | 'pos'), `orders.pos_shift_id INTEGER REFERENCES shifts(id)`.
- `POST /pos/delivery-orders` (quyền `pos.sell`): `{ customerId?, receiver:{name, phone, address, zoneId?}, lines[], discount?, shippingFee, deliverer: {userId} | {carrier, trackingNo?}, prepay:[{method, amount}], cod }` (prepay + cod = tổng; sai → 422) → tạo đơn + đưa sang `shipping` trong một batch; trả mã đơn và link tra cứu.
- Danh sách đơn online lọc thêm `source=pos`; chi tiết đơn hiện người giao.
- Phiếu in giao hàng (80mm): người nhận, địa chỉ, khung giờ, số tiền thu hộ, mã đơn + mã vạch.

---

## 4. Kiểm thử bắt buộc
- `test/pos-credit.test.ts`: tắt/bật, không khách, vượt hạn mức, hai quầy cùng ghi nợ (chỉ một qua), duyệt quản lý, hoá đơn sinh đúng due_date, thu nợ tại quầy vào tiền mặt dự kiến của ca, trả hàng trừ nợ trước rồi mới hoàn tiền, huỷ đơn chưa thu, kỳ khoá 423, báo cáo cuối ngày dòng Công nợ, SePay `HDS` gạch đúng hoá đơn.
- `test/order-charges.test.ts`: tổng đơn, không áp KM/điểm, báo cáo tách dòng, trả hàng có/không hoàn thu khác.
- `test/pos-delivery.test.ts`: tạo đơn giao từ POS (giữ hàng, khung giờ đầy → 409), trả trước vào két ca, COD vào quỹ chờ đối soát, doanh thu chỉ ghi khi giao xong, giao thất bại → trả hàng.
- E2E `e2e/pos-kv-b.mjs` (1440 + 390): bán nợ + in QR, thu nợ tại quầy, thu khác, đơn giao từ POS đi hết luồng ở màn Đơn online.

## 5. Quyết định đã chốt (26/11/2026)
1. **Bán nợ khách lẻ**: thu ngân tự ghi nợ khi còn trong hạn mức; vượt `approval.pos_credit_vnd` (500.000đ/lần) hoặc vượt hạn mức → quản lý duyệt. Khách lẻ mới: hạn mức 0 (phải đặt riêng từng khách), kỳ hạn mặc định 7 ngày (`pos.retail_credit_default_terms_days`).
2. **Thu khác**: trả một phần → không hoàn phí; trả toàn bộ đơn → hỏi có hoàn phí không, bắt buộc lý do.
3. **Giao hàng tại quầy**: đóng gói tại quầy, đơn sang thẳng "Đang giao"; doanh thu ghi khi giao xong.
4. **Người giao**: nhân viên cửa hàng hoặc xe ngoài, ghi tay mã vận đơn; không nối API hãng vận chuyển.
