# Kế hoạch go-live — ERP Hữu Mạnh

Tài liệu từng bước đưa hệ thống vào chạy thật. Đọc kèm `docs/HANDOFF.md` (hiện trạng), `docs/SECOPS.md` (cấu hình bảo mật), `docs/audit/README.md` (lỗi còn tồn).

Ký hiệu: 👤 = chủ cửa hàng / người phụ trách dự án làm · 🤖 = đội kỹ thuật làm · ✅ = điều kiện để sang bước sau.

---

## Bước 0 — Điều kiện tiên quyết

| # | Việc | Ai | Ghi chú |
|---|---|---|---|
| 0.1 | API token Cloudflare đúng định dạng (quyền Workers Scripts:Edit, D1:Edit, R2:Edit, Queues:Edit, Account Settings:Read) — lưu vào GitHub Secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | 👤 | Hiện token đang lưu bị lỗi định dạng (chặn mọi bước deploy) |
| 0.2 | Chốt các tham số **[Cần xác nhận]** trên màn **Cài đặt → Tham số** (lọc "chỉ mục cần xác nhận") | 👤 | Ngưỡng duyệt, giá vốn, VAT, lương/tăng ca/BHXH, chấm công GPS/QR, tích điểm, phí giao khi huỷ… |
| 0.3 | Kế toán đối chiếu biểu thuế TNCN 2026 (5 bậc, giảm trừ 15,5/6,2 tr) | 👤 | Sửa được trên màn Cài đặt nếu khác |
| 0.4 | Tên miền cho ERP và website (vd `erp.<tenmien>`, `<tenmien>`) | 👤 | Bản demo dùng `*.workers.dev` |
| 0.5 | Tài khoản ngân hàng nhận tiền thật (VietQR), sao kê định dạng để đối soát | 👤 | Demo đang là `0000000000` giả |
| 0.6 | Quyết định tích hợp: MISA meInvoice (cần tài liệu API MISA cấp), Fresco, email. **SePay** (xác nhận chuyển khoản tự động): đã chốt dùng SePay Webhooks, làm theo `docs/SEPAY.md` §7 (tạo cấu trúc mã thanh toán, webhook HMAC, secret `SEPAY_WEBHOOK_SECRET` + `SEPAY_API_KEY`, chuyển thử một khoản nhỏ thật) | 👤 | Có thể go-live trước với HĐĐT `fake` + chuyển khoản VietQR (nhân viên xác nhận tay), bật SePay sau |

✅ Có token hợp lệ + tham số đã chốt.

## Bước 1 — Hạ tầng production (🤖, ~1 ngày)

1. Tạo tài nguyên **production mới** (không dùng D1 demo): D1 `huu-manh-erp-prod`, R2 `huu-manh-erp-files-prod`, Queues `huu-manh-erp-jobs` + `-dlq`; điền `database_id`/`bucket_name` vào cấu hình gốc của `wrangler.jsonc` và `wrangler.shop.jsonc`.
2. Staging tương tự (`-staging`) để thử migration/khôi phục trước khi đụng production.
3. Secrets production: `BOOTSTRAP_TOKEN` (xoá sau khi tạo chủ), `ATTENDANCE_QR_SECRET`, `TURNSTILE_SECRET` + site key thật, `PAYMENT_WEBHOOK_SECRET`, `VAPID_PRIVATE_KEY`; vars `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `SHOP_BASE_URL`; khi có: `MISA_*`, `FRESCO_WEBHOOK_SECRET`.
4. Font PDF lên R2 production.
5. Gắn tên miền; **Cloudflare Access** cho ERP; WAF/rate limit theo `docs/SECOPS.md` mục 3.
6. GitHub Environments `staging`/`production` (production cần Required reviewers).
7. **Chạy thử khôi phục**: sao lưu staging → `scripts/restore-from-r2.mjs` khôi phục vào D1 trống → so số dòng với manifest.

✅ Deploy staging thành công, khôi phục thử khớp manifest.

## Bước 2 — Deploy production (🤖)

- Tạo tag `v1.0.0` → job `deploy-production`: áp migration 0001→mới nhất, deploy ERP + website.
- Tạo tài khoản chủ qua `POST /api/auth/bootstrap` rồi xoá `BOOTSTRAP_TOKEN`. Chủ đổi mật khẩu ngay.
- **Không** nạp `seed/*.sql` (dữ liệu mẫu).

## Bước 3 — Nạp dữ liệu thật (👤 + 🤖, 1–2 ngày)

| Thứ tự | Dữ liệu | Cách nạp |
|---|---|---|
| 1 | Cửa hàng, toạ độ + bán kính chấm công, vị trí kho (quầy, kho lạnh, khu hỏng) | Màn Cửa hàng / Kho |
| 2 | Tài khoản người dùng + vai trò (chủ, quản lý, thu ngân, kho, kế toán, NV online, nhân viên) | Màn Người dùng (mật khẩu tạm, bắt đổi lần đầu) |
| 3 | Nhân viên, hợp đồng, lương, người phụ thuộc, ca làm mẫu, lịch ca tuần đầu | Màn Nhân sự |
| 4 | Sản phẩm, đơn vị quy đổi, mã vạch, nhóm hàng | Màn Sản phẩm. Chưa có chức năng nhập Excel hàng loạt — nếu danh mục lớn, 🤖 nạp bằng script từ file Excel của cửa hàng |
| 5 | Nhà cung cấp, khách sỉ (hạn mức, hạn thanh toán), nhóm khách | Màn NCC / Khách hàng |
| 6 | Bảng giá (chung, sỉ, online, nhóm) | Màn Giá |
| 7 | **Tồn đầu kỳ**: kiểm kê thực tế → phiếu nhập đầu kỳ theo lô (hạn dùng, giá vốn) | Màn Kho |
| 8 | **Công nợ đầu kỳ** phải thu/phải trả → nhập số dư đầu kỳ rồi **khoá** | Công nợ → Đầu kỳ |
| 9 | Số dư quỹ đầu kỳ (tiền mặt, ngân hàng) | Phiếu thu khoản mục **Số dư quỹ đầu kỳ** (không tính vào lãi lỗ) |
| 10 | Website: sản phẩm bán online, ảnh, khu vực/khung giờ giao, banner | Màn Website |

✅ Tồn kho, công nợ, quỹ trên hệ thống khớp sổ sách hiện tại (kế toán ký xác nhận).

## Bước 4 — Kiểm tra trên production (🤖 + 👤, nửa ngày)

Một vòng thử với dữ liệu thật rồi huỷ/đảo: bán POS (tiền mặt + chuyển khoản), trả hàng, chốt ca; đơn website (COD + chuyển khoản); đơn sỉ → giao → hoá đơn → thu nợ; nhập hàng; chấm công GPS/QR bằng điện thoại nhân viên; in hoá đơn/báo giá PDF; xem báo cáo ngày. Kiểm tra quỹ, tồn, công nợ trở về đúng sau khi đảo.

## Bước 5 — Đào tạo (👤 tổ chức, 🤖 hướng dẫn, 1–2 ngày)

| Nhóm | Nội dung chính |
|---|---|
| Thu ngân | Mở/chốt ca, bán, cân, giảm giá & xin duyệt, khách quen/tích điểm, trả hàng, bán offline |
| Kho | Nhập theo lô, cách ly lô hỏng, hao hụt, kiểm kê, chuyển kho, giữ hàng cho đơn |
| NV online | Xử lý đơn web/MXH, cân & đóng gói, chênh cân, giao, huỷ/trả |
| Kế toán | Thu chi, đối soát ngân hàng/COD, công nợ, hoá đơn mua, khoá sổ, báo cáo, bảng công & lương |
| Quản lý / chủ | Duyệt, giá & khuyến mãi, giá đối thủ, Cài đặt, Nhật ký, báo cáo lãi lỗ |
| Nhân viên | Chấm công, xem lịch ca, xin nghỉ/đổi ca/tăng ca, phiếu lương |

## Bước 6 — Chạy song song (1–2 tuần)

Ghi đồng thời trên hệ thống mới và cách làm cũ. **Đối chiếu cuối mỗi ngày** (kế toán):
- Doanh thu theo kênh (POS, online, sỉ) — hệ thống vs sổ cũ.
- Tiền mặt két từng ca vs chốt ca; số dư ngân hàng vs sao kê; quỹ chờ đối soát COD về 0 sau mỗi đợt.
- Tồn kho 10–20 mặt hàng chính (đếm mẫu) vs hệ thống.
- Công nợ khách sỉ lớn vs sổ cũ.
- Chấm công: số người/giờ vs thực tế.
Mọi lệch ghi vào bảng theo dõi (ngày, mô tả, nguyên nhân, xử lý). Lỗi phần mềm → 🤖 sửa trong ngày (lỗi trung bình/thấp còn tồn ở `docs/audit/README.md` ưu tiên theo phát sinh thực tế).

## Bước 7 — Quyết định chuyển hẳn (Go / No-go)

Go khi **đủ cả**:
- 5 ngày liên tiếp đối chiếu không còn lệch chưa giải thích.
- Không còn lỗi nghiêm trọng/cao mở.
- Sao lưu R2 chạy hằng ngày + đã khôi phục thử thành công.
- Chủ cửa hàng + kế toán ký nghiệm thu.

Sau Go: dừng sổ cũ; khoá sổ kỳ trước trên hệ thống; tắt bản demo `*.workers.dev` hoặc tách hẳn.

## Kế hoạch lùi (rollback)

- Lỗi deploy: deploy lại phiên bản trước (`wrangler rollback` hoặc tag trước); migration chỉ thêm cột/bảng nên bản cũ vẫn chạy.
- Hỏng dữ liệu: khôi phục D1 bằng **Time Travel** của D1 (về thời điểm trước sự cố) hoặc bản R2 gần nhất qua `scripts/restore-from-r2.mjs`.
- Trong thời gian chạy song song: sổ cũ là nguồn chính, luôn có thể quay về.

## Sau go-live (tháng đầu)

- Hằng ngày: xem job lỗi (outbox/DLQ), cảnh báo chấm công, phiếu chờ duyệt.
- Hằng tuần: đối soát ngân hàng, kiểm kê luân phiên, xem Nhật ký thay đổi cài đặt/giá.
- Cuối tháng: chốt công → tính & duyệt lương → khoá sổ kỳ.
- Lịch SecOps định kỳ theo `docs/SECOPS.md` mục 8.
