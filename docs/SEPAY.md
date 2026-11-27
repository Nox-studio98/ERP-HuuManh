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

### Sổ quỹ và khoản chờ xử lý (migration 0045)

**Nguyên tắc:** số dư quỹ ngân hàng luôn khớp tiền SePay báo về. Bất biến: *Σ tiền vào đúng tài khoản cửa hàng − Σ đã hoàn = mức tăng số dư quỹ ngân hàng* (test `test/sepay-ledger.test.ts` kiểm sau mỗi kịch bản).

| Tình huống | Ghi sổ |
|---|---|
| Khớp ngay đơn web `DH`, hoá đơn sỉ `HDS` | ghi thẳng chứng từ thật (`payments` / phiếu thu công nợ), **không** qua khoản chờ |
| Chưa khớp / chờ hoàn (sai tiền, mã lạ, không mã, đơn đã trả…), QR quầy đã nhận tiền | cùng batch với việc lưu sự kiện: **phiếu thu** vào quỹ ngân hàng, khoản mục `CK_CHO_XL` "Chuyển khoản chờ xử lý" (`pnl_line = transfer` → không vào lãi lỗ), `ref_type = sepay_event`, `ref_id` = id sự kiện. Ngày ghi = thời điểm giao dịch; kỳ đã khoá → ghi vào hôm nay, ghi chú nêu rõ; hôm nay cũng khoá → chỉ lưu sự kiện (xem "Dữ liệu cũ") |
| **Gán** đơn / hoá đơn | một batch: chứng từ thật + **phiếu chi** `CK_CHO_XL_RA` cùng quỹ → ròng quỹ không đổi lần hai, khoản chờ về 0 |
| QR quầy: thu ngân hoàn tất đơn bằng QR đã nhận | `payments` của đơn + phiếu chi khỏi khoản chờ trong cùng batch POS. QR hết ca / huỷ / không tạo đơn: tiền vẫn ở khoản chờ cho kế toán |
| **Đã hoàn** | phiếu chi hoàn tiền từ quỹ ngân hàng (ghi mã giao dịch hoàn nếu có + lý do); cần `finance.write`; kiểm khoá sổ |
| **Bỏ qua** | tiền đã nằm trong quỹ nên **bắt buộc chọn**: khoản mục thu thật (phiếu chi khỏi chờ + phiếu thu khoản mục đó — có thể vào lãi lỗ tuỳ khoản mục), hoặc `keepInHold` giữ ở "Chuyển khoản chờ xử lý" kèm lý do. Không chọn → 422 `category_required` |
| Không phải tiền vào tài khoản cửa hàng (sai tài khoản, tiền ra, SePay đang tắt, chưa cấu hình tài khoản) | không lập phiếu |

Chống ghi trùng: phiếu thu chờ đi cùng claim `received → unmatched` của sự kiện (`assertStmt`) và `onceStmt('sepay.hold_in', id)`; webhook gửi lại cùng `id` hoặc đối soát cron gặp lại giao dịch webhook đã có (nhận ra qua tài khoản + tiền + thời điểm + mã [+ tham chiếu]) không xử lý lại. Gán / Đã hoàn / Bỏ qua chạy sau claim có điều kiện trạng thái và chốt chặn `sepay.hold_state` (trạng thái phiếu chờ không đổi từ lúc đọc) → hai người cùng bấm thì người sau nhận 409.

**Nhập sao kê** (`POST /bank-transactions/import`): dòng trùng một giao dịch SePay đã ghi vào quỹ — cùng quỹ ngân hàng, cùng số tiền, cùng ngày VN, và mã tham chiếu khi cả hai có (khác hẳn thì không trùng) — được tự đánh dấu `matched` với `matched_type = sepay`, `sepay_event_id` (màn Ngân hàng hiện nhãn "Đã ghi qua SePay"); không tạo phiếu thu / thanh toán. Nhiều ứng viên → không tự quyết (`sepayCandidates` trong kết quả). Khớp tay (`/bank-transactions/:id/match`) và `online-orders/:id/mark-paid` bằng `bankTxnId` cho dòng có ứng viên SePay → 409 `already_recorded_by_sepay`; chọn đúng giao dịch SePay bằng `{ "sepayEventId": n }` (`GET /bank-transactions/:id/sepay-candidates` liệt kê). Lưu ý: nên nhập sao kê **sau** khi SePay đã báo giao dịch (thường là vậy); nếu sao kê được nhập và khớp đơn trước khi webhook về thì giao dịch SePay muộn sẽ thành "chờ hoàn" và vào khoản chờ — hãy "Bỏ qua" nó với lý do.

**Màn Giao dịch SePay:** ô KPI "Chuyển khoản chờ xử lý (trong quỹ)" (bấm để xem từng phiếu thu/chi của khoản chờ: `GET /sepay/hold`), cột "Sổ quỹ" cho từng giao dịch. **Gán / Đã hoàn / Bỏ qua** cập nhật sổ như bảng trên.

**Dữ liệu cũ (trước 0045):** migration **không** lập phiếu hồi tố. Sự kiện `unmatched` / `refund_pending` (và QR quầy đã nhận nhưng chưa tạo đơn) có từ trước chưa có phiếu chờ nên số dư quỹ đang thiếu khoản đó; màn Giao dịch SePay hiện banner đỏ + nút **"Ghi các giao dịch chờ cũ vào sổ"** (`GET/POST /sepay/ledger/backfill`, quyền `finance.write`): xem trước (số giao dịch + tổng tiền), bấm ghi thì mỗi sự kiện một batch (`onceStmt` + audit `sepay.ledger_backfill`); số xem trước phải khớp lúc ghi (409 `preview_changed`). Cũng dùng được cho giao dịch lưu lúc kỳ hiện tại đang khoá sổ. Sự kiện cũ chưa có phiếu mà được Gán / Đã hoàn thì **không** lập phiếu chi (tiền chưa từng vào quỹ). Sự kiện cũ đã "Bỏ qua" / "Đã hoàn" không được hồi tố (tiền đã ra khỏi tài khoản hoặc kế toán đã tự xử lý): nếu còn lệch, lập phiếu thu tay.

## 1b. Ngân hàng nhận tiền (Cài đặt → Online/website)

Chọn ở ô **Ngân hàng nhận tiền**: danh sách chỉ gồm 12 ngân hàng SePay hỗ trợ webhook (nguồn và ngày lấy ghi trong `src/worker/lib/vn-banks.ts`). Mã BIN dùng tạo VietQR lấy tự động, không gõ tay.

- Phải **trùng ngân hàng của tài khoản đã liên kết trên SePay**. Nếu lệch, QR khách quét chuyển sang ngân hàng khác; màn **Giao dịch SePay** báo đỏ khi giao dịch SePay gần nhất đến từ ngân hàng khác ngân hàng đã chọn.
- Ngân hàng **chỉ nhận qua VA khi kết nối API không có SMS** (Vietcombank, MSB, OCB, KienlongBank; BIDV cá nhân/hộ kinh doanh; VietinBank doanh nghiệp dùng MAP — riêng MAP thì kể cả có SMS; VPBank NEO tuỳ cách liên kết): ô **Số tài khoản nhận tiền** phải là **số VA**, nếu không SePay sẽ không báo về giao dịch. Tài khoản **có kết nối SMS** (chỉ SMS hoặc API + SMS) ở các ngân hàng này nhận cả giao dịch vào số tài khoản chính (tài liệu SePay: `sepay-webhooks/tai-khoan-ngan-hang`). Trong ô chọn, các ngân hàng này ghi "API: chỉ qua VA".
- VietinBank cá nhân / hộ kinh doanh: nội dung chuyển khoản phải có `SEVQR` (QR hiện chưa tự thêm `SEVQR` — xem bước 1 của phần go-live bên dưới).

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
- Audit: `sepay.matched` (qua `sepay.order_paid`, phiếu thu), `sepay.unmatched`, `sepay.refund_pending`, `sepay.assign`, `sepay.refunded`, `sepay.ignored`, `sepay.ledger_backfill`, `bank.sepay_link_auto` / `bank.sepay_link_manual`.
- Đối chiếu sổ: số dư "Chuyển khoản chờ xử lý" phải bằng tổng các giao dịch còn ở "Cần xử lý" (+ QR quầy chưa tạo đơn + các khoản "Bỏ qua" giữ ở khoản chờ).
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
