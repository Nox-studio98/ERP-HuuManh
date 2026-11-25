# Tích hợp SePay — xác nhận tiền chuyển khoản tự động

Chủ cửa hàng đã chốt: dùng **SePay Webhooks** cho tiền chuyển vào tài khoản của cửa hàng (không làm cổng thanh toán thẻ). Skill hướng dẫn nằm ở `.claude/skills/sepay`. Trạng thái: đã code + test (mock), **chưa chạy với SePay thật**.

Trang tài liệu SePay đã dùng: `developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook` (payload, phản hồi `success`), `…/xac-thuc#hmac-sha256` (header `X-SePay-Signature` = `sha256=<hex>` của `{X-SePay-Timestamp}.{raw body}`, `X-SePay-Timestamp` = Unix giây, chống replay ±5 phút), `…/cau-hinh-ma-thanh-toan` (tiền tố 2–5 ký tự, hậu tố 1–30; "Số nguyên" hoặc "Số và chữ"; trường `code` chỉ được điền khi nội dung khớp mẫu), `…/doi-soat-giao-dich` + `…/sepay-api/v2/giao-dich/danh-sach` (`GET /v2/transactions`, `since_id`, `transaction_date_sort=asc`, giới hạn 3 request/giây), `…/tien-ich-khac/tao-qr-code` (QR), `…/test-mode`.

## 1. Luồng

```
Khách chuyển khoản (nội dung bắt đầu bằng mã thanh toán)
  → ngân hàng → SePay → POST /api/integrations/sepay/webhook   (ERP Worker)
      1. đọc raw body, kiểm HMAC-SHA256 + timestamp; secret rỗng = từ chối tất cả
      2. lưu sự kiện theo `id` (UNIQUE, insert-ignore) vào sepay_events
      3. chỉ transferType = "in"; accountNumber phải là tài khoản cửa hàng (cấu hình)
      4. khớp bằng `code` SePay đã nhận diện (không tự tách mã từ nội dung)
      5. chuyển trạng thái CÓ ĐIỀU KIỆN trong MỘT db.batch (+ audit) → trả {"success": true|false}
```

**Vì sao đặt ở ERP Worker:** cả 3 luồng ghi vào cùng D1; phiếu thu / gạch nợ / khoá sổ / quỹ ngân hàng đều là logic của ERP (`createPayment`, `markOrderPaid`). Website chỉ hiển thị mã + QR và hỏi trạng thái đơn như cũ.

| Luồng | Mã thanh toán | Điều kiện xác nhận | Kết quả |
|---|---|---|---|
| Đơn website chuyển khoản | **mã đơn** `DH` + 12 chữ số (vd `DH202611250001` = DH + ngày VN + số thứ tự 4 số), không gạch | đơn đang chờ thanh toán, còn yêu cầu hiệu lực, **số tiền = tổng đơn** | đơn → "Mới" (đã thanh toán), ghi `payments` vào quỹ ngân hàng |
| Thu nợ khách sỉ | mã riêng của hoá đơn: tiền tố `HDS` + 8 chữ số (hiện ở Hoá đơn → chi tiết, kèm QR) | hoá đơn còn mở, **số tiền = số còn nợ** | tự lập phiếu thu (quỹ ngân hàng) + gạch nợ **đúng hoá đơn đó**; kiểm khoá sổ |
| QR tại quầy POS | mã riêng mỗi lần hiện QR: tiền tố `POS` + 8 chữ số | mã còn hạn (mặc định 15 phút), **số tiền = số tiền QR** | mã chuyển "đã nhận"; POS hỏi backend ~3 giây/lần, báo "Đã nhận" rồi cho hoàn tất đơn (đơn ghi `payments` method `qr`, ref = mã) |

Đơn website cũ (`DH-20261123-0001`) giữ mã cũ; chỉ đơn mới theo dạng mới. Tiền cho đơn cũ: dùng "Gán đơn" ở màn **Giao dịch SePay**.

### Quy tắc số tiền và tiền về sai
- **Đúng số tiền mới xác nhận.** Khác số tiền → `unmatched` (lý do "Sai số tiền"), trả `success:false`, không đổi đơn.
- Đơn đã huỷ / quá hạn / đã thanh toán rồi, hoá đơn đã trả, QR hết hạn / bị thay / đã dùng → **chờ hoàn** (`refund_pending`), `success:false`, không tự giao hàng.
- Mã lạ, không có mã, tài khoản khác, tiền ra, kỳ đã khoá sổ, SePay đang tắt → `unmatched`.
- Hai giao dịch khác nhau cho một đơn chạy song song: một cái thắng (chuyển trạng thái có điều kiện), cái còn lại `refund_pending`.
- Gửi lại cùng `id` (retry/replay): trả đúng phán quyết lần đầu, không xử lý lại.
- Không bao giờ khớp theo "số tiền + thời gian"; không tự regex nội dung chuyển khoản.

### Màn hình "Giao dịch SePay" (Thu chi → Giao dịch SePay, quyền `finance.view`; thao tác cần `finance.write`)
Danh sách chưa khớp / chờ hoàn / đã khớp / đã hoàn / bỏ qua / "QR quầy chưa tạo đơn". Thao tác: **Gán đơn** (đơn website phải đúng số tiền; hoá đơn sỉ nhận mọi số tiền, phần dư thành số dư có của khách như thu nợ thường), **Đã hoàn** (ghi nhận bạn đã hoàn tiền thủ công qua ngân hàng — hệ thống không chuyển tiền), **Bỏ qua**; mỗi thao tác bắt buộc ghi lý do và có audit.

### Đối soát (an toàn khi lỡ webhook)
Cron mỗi 30 phút gọi `GET {sepay.api_base}/transactions?since_id=<con trỏ>&transaction_date_sort=asc&transfer_type=in&per_page=100` với `SEPAY_API_KEY`; con trỏ lưu `sepay_state.api_cursor`. Chỉ chạy khi có secret và `sepay.enabled = 1`. Cùng logic khớp với webhook; giao dịch webhook đã xử lý được nhận ra (cùng tài khoản + số tiền + thời điểm + mã [+ mã tham chiếu]) và **không xử lý lại**. Cũng xử lý lại các sự kiện kẹt ở "đang xử lý". Có thể bấm tay: `POST /api/v1/sepay/reconcile` (cần `finance.write`).

## 2. Cấu trúc mã thanh toán cần tạo trên my.sepay.vn
**Công ty → Cấu hình chung → Cấu trúc mã thanh toán**, bật "Nhận diện mã thanh toán", tạo **3 mẫu** (mẫu đầu tiên là mặc định, không xoá được):

| Dùng cho | Tiền tố | Loại ký tự | Hậu tố tối thiểu | Hậu tố tối đa | Ví dụ |
|---|---|---|---|---|---|
| Đơn website | `DH` | Số nguyên | 12 | 12 | `DH202611250001` |
| Nợ khách sỉ | `HDS` | Số nguyên | 8 | 8 | `HDS40719265` |
| QR tại quầy | `POS` | Số nguyên | 8 | 8 | `POS05379875` |

Độ dài cố định (min = max) để SePay không cắt/thừa chữ số. Nếu đổi tiền tố trong **Cài đặt → Thanh toán SePay** thì phải đổi đúng mẫu trên SePay (và ngược lại). Mã luôn đứng **đầu** nội dung chuyển khoản. Thử mẫu ở **Test mode** trước (Cấu hình Test mode tách biệt với Live, phải tạo lại).

## 3. Tạo webhook
my.sepay.vn → **Webhooks → Thêm webhook** (form 4 bước):
- URL: `https://<tên-miền-ERP>/api/integrations/sepay/webhook` (HTTPS).
- Sự kiện: **Tiền vào**; chỉ chọn tài khoản ngân hàng của cửa hàng.
- Bảo mật: **HMAC-SHA256**, nhập/tạo Secret Key (chỉ hiện đầy đủ một lần) rồi đặt vào Worker (§4). Content-Type: `application/json`.
- Bật **Dùng để xác thực thanh toán** (`success` của ta thành kết quả "Thành công/Thất bại" ở Xác thực tự động).
- **Không bật** "Chỉ gửi khi có mã thanh toán" và "Lọc theo mã thanh toán" (bật thì giao dịch thiếu mã không về tới hệ thống, chỉ đối soát mới thấy).
- Sau go-live: bật **Tự động gửi lại khi server trả lỗi** và **Bật cảnh báo khi webhook gặp lỗi liên tiếp** (CLI không đặt được).

## 4. Biến môi trường / secret
| Tên | Nơi | Ghi chú |
|---|---|---|
| `SEPAY_WEBHOOK_SECRET` | secret ERP | `wrangler secret put SEPAY_WEBHOOK_SECRET`; rỗng = từ chối mọi webhook |
| `SEPAY_API_KEY` | secret ERP | API key v2 (my.sepay.vn → Cài đặt công ty → API Keys); thiếu = không đối soát. Không dùng key sandbox cho production |
| `.dev.vars` (local) | không commit | giá trị giả để thử, vd `SEPAY_WEBHOOK_SECRET=local-sepay-secret` |

Cài đặt (màn **Cài đặt → Thanh toán SePay**, bảng `settings`): `sepay.enabled` (mặc định **0**), `sepay.account_numbers` (trống = dùng "Số tài khoản nhận tiền" của website; nhiều số cách nhau dấu phẩy), `sepay.flow_web` / `sepay.flow_b2b` / `sepay.flow_pos`, `sepay.prefix_b2b` (`HDS`), `sepay.prefix_pos` (`POS`), `sepay.pos_qr_ttl_min` (15), `sepay.api_base` (production `https://userapi.sepay.vn/v2`, sandbox `https://userapi-sandbox.sepay.vn/v2`). Các mục có nhãn [Cần xác nhận] cần chủ cửa hàng chốt.

Khi `sepay.enabled = 1` và `sepay.flow_pos = 1`, thanh toán "QR" ở POS **bắt buộc** có mã QR đã nhận tiền (không còn tự bấm xác nhận). Tắt `flow_pos` để quay lại cách cũ. Lúc mất mạng (đơn offline) không dùng được QR tự động.

Hiển thị: QR dựng ở máy khách từ chuỗi VietQR (EMVCo) do server tạo, nội dung = mã thanh toán (đứng đầu, ≤ 25 ký tự) — tương đương `vietqr.app/img?...&des=<mã>` nhưng không gọi dịch vụ ngoài.

## 5. Thử bằng Test mode (không dùng tiền thật)
1. my.sepay.vn → bật **Test mode**; tạo tài khoản ngân hàng test, **tạo lại 3 cấu trúc mã** ở Test mode.
2. Tạo webhook test trỏ tới bản demo/staging (không trỏ vào DB production), cùng secret.
3. Ở ERP bản thử: `sepay.enabled = 1`, `sepay.account_numbers` = số tài khoản test.
4. Đặt đơn website chuyển khoản → lấy mã `DH…` + số tiền → ở Test mode chọn **Mô phỏng giao dịch** (tiền vào, đúng tài khoản, nội dung `DH… chuyen khoan`, đúng số tiền). Kiểm tra: đơn chuyển sang "Mới/đã thanh toán"; **Lịch sử gửi** của webhook thấy 200 `{"success":true}`; nhãn "Xác thực tự động" = Thành công.
5. Thử sai số tiền, đơn đã huỷ, mã lạ, gửi lại (Gửi lại thủ công) và xem màn **Giao dịch SePay**.
6. Cùng cách cho hoá đơn sỉ (mã `HDS…` ở chi tiết hoá đơn) và QR POS (`POS…`).
Với dev local: `wrangler dev`, endpoint `http://localhost:<cổng>/api/integrations/sepay/webhook`; ký bằng script (`sha256=` + HMAC-SHA256 hex của `<timestamp>.<body>`).

## 6. Giám sát sau go-live
- Màn **Giao dịch SePay**: mỗi ngày xem "Chưa khớp" / "Chờ hoàn" (KPI trên đầu), xử lý và ghi lý do.
- my.sepay.vn → webhook → **Lịch sử gửi** và nhãn **Xác thực tự động** trong những ngày đầu (tìm "Thất bại" bất thường).
- Cảnh báo lỗi webhook liên tiếp đã bật (§3); đối soát cron chạy (`sepay_state.api_cursor` thay đổi theo thời gian).
- Audit: `sepay.matched` (qua `sepay.order_paid`, phiếu thu), `sepay.unmatched`, `sepay.refund_pending`, `sepay.assign`, `sepay.refunded`, `sepay.ignored`.
- Nghi lộ secret: tạo lại ở my.sepay.vn, `wrangler secret put`, rà `sepay_events` bất thường.

## 7. Các bước go-live (theo hướng dẫn SePay)
1. Liên kết **tài khoản ngân hàng thật** nhận tiền vào SePay; đặt `sepay.account_numbers` (hoặc "Số tài khoản nhận tiền" của website) đúng số đó. Ngân hàng yêu cầu VA (OCB, MSB, KienlongBank…) hoặc VietinBank cá nhân (`SEVQR`) cần xem lại cách tạo QR/nội dung trước khi bật.
2. Tạo 3 **cấu trúc mã thanh toán** ở Live (§2) — Test mode không tự chuyển sang Live.
3. ERP đã chạy ở tên miền HTTPS công khai; đã đặt `SEPAY_WEBHOOK_SECRET` (và `SEPAY_API_KEY` nếu muốn đối soát).
4. Trước khi tạo webhook live: xem các webhook live khác đang nhận cùng tài khoản (mỗi cái cũng nhận giao dịch của cửa hàng). Rồi tạo webhook như §3 và đọc lại cấu hình.
5. Bật `sepay.enabled = 1` ở Cài đặt.
6. Chuyển **một khoản nhỏ thật** end-to-end cho từng luồng (đơn website, hoá đơn sỉ, QR POS), rồi hoàn tiền thủ công và ghi "Đã hoàn" ở màn Giao dịch SePay.
7. Bật gửi lại khi lỗi + cảnh báo webhook lỗi liên tiếp (§3). Rồi mới thông báo cho khách.

## 8. Việc chủ cửa hàng phải làm trên my.sepay.vn
Tạo 3 cấu trúc mã (§2), liên kết tài khoản thật, tạo webhook HMAC (§3) và đưa secret cho người triển khai, tạo API key (nếu dùng đối soát), thử ở Test mode rồi chuyển thử một khoản nhỏ thật, bật cảnh báo lỗi.
