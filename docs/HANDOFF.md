# Handoff — ERP Hữu Mạnh (cập nhật 24/11/2026)

Tài liệu bàn giao trạng thái dự án sau **Đợt 1–4 và audit toàn hệ thống**. Đọc kèm: `README.md` (cài đặt, lệnh), `docs/ARCHITECTURE.md`, `docs/SECOPS.md`, hợp đồng API `docs/API.md`, `docs/API-dot2.md`, `docs/API-dot3.md`, `docs/API-dot4.md`.

## 1. Tóm tắt nhanh

| Hạng mục | Trạng thái |
|---|---|
| Code Đợt 1–3 (M1, M2, M3, M4, M5, M6, M8) | ✅ Xong, đã merge vào `main` |
| Code Đợt 4 (M9 nhân sự–chấm công–lương, M7 giá đối thủ, M2-11, khuyến mãi/voucher/tích điểm, giỏ quà & đặt cọc, báo cáo tài chính bổ sung, đơn lặp tự động) | ✅ Xong (nhánh `dot-4` → PR vào `main`) |
| Audit bảo mật & toàn vẹn dữ liệu (3 mảng) | ✅ Xong — 36 phát hiện đã sửa, mỗi lỗi có test hồi quy (mục 2.5) |
| Kiểm thử | ✅ 507 unit/integration test (workerd + D1 thật), 6 kịch bản E2E Playwright đạt trên DB mới |
| CI (GitHub Actions) | ✅ typecheck, test, `npm audit`, gitleaks; job deploy demo/staging/production |
| D1 `huu-manh-erp` | ✅ Đã tạo (APAC), áp migration 0001–0004 + dữ liệu demo. **Migration 0005–0010 chưa áp** — job deploy sẽ tự áp |
| R2 `huu-manh-erp-files` | ✅ Đã tạo (CI demo tự tải font PDF) |
| **Deploy Worker ERP + Worker website** | ❌ **Chưa** — token Cloudflare lưu trong môi trường cloud bị sai định dạng (mục 4) |
| Secrets, tên miền, Cloudflare Access | ❌ Chưa |

## 2. Đã xong

### Đợt 1 — Nền tảng bán lẻ
- **M1 bán tại quầy** (PWA trên điện thoại): ca bán, mở/chốt ca có lý do lệch tiền (EC-32), bán theo cân & đơn vị có quy đổi, quét mã bằng camera, chia thanh toán (tiền mặt/QR/chuyển khoản/thẻ), trả hàng cộng lại **đúng lô** (EC-01), huỷ đơn có phân quyền, bán offline xếp hàng đồng bộ không trùng số (EC-04), in/chia sẻ hoá đơn.
- **M2 kho**: tồn theo lô + hạn dùng, xuất FEFO, nhập/hao hụt/kiểm kê/chuyển kho bằng quét mã, cảnh báo quét sai (M2-16), mã vạch nội bộ Code128, truy xuất lô (M2-19), cảnh báo tồn thấp/sắp hết hạn. **Không bán quá tồn kể cả hai người cùng bán (EC-02)** — bảo đảm bằng ràng buộc CHECK + batch nguyên tử, có test.
- **M3 giá**: bảng giá theo kênh/nhóm khách, đổi giá hàng loạt có thời điểm hiệu lực, lịch sử giá, duyệt giá, cảnh báo bán dưới giá vốn, giá đề xuất theo biên.
- **M6 thu chi**: quỹ, phiếu thu/chi theo danh mục, duyệt chi vượt ngưỡng, phiếu đảo, khoá sổ (chặn ở tầng DB — EC-33), đối soát ca, báo cáo lãi lỗ theo ngày/kênh/nhóm, xuất CSV.
- Nền tảng: đăng nhập (PBKDF2, khoá sau 5 lần sai), phân quyền theo mục 12 tài liệu, nhật ký thay đổi bất biến, sao lưu hằng ngày ra R2.

### Đợt 2 — B2B và công nợ
- **M4 khách sỉ**: hồ sơ nhiều địa chỉ/người liên hệ, báo giá 7 ngày (PDF tiếng Việt), đơn sỉ **kiểm hạn mức trước khi giữ hàng (EC-23)** — chỉ chủ duyệt vượt hạn mức, giữ tồn theo lô, soạn hàng bằng quét mã, giao hàng ghi số thực nhận, hoá đơn theo số thực giao (EC-26), trả hàng → hoá đơn điều chỉnh (EC-25), giá riêng theo khách, đơn lặp (tạo thủ công).
- **M5 công nợ**: phải thu/phải trả, tuổi nợ, thu tiền gạch hoá đơn cũ nhất trước, số dư có (EC-24), chiết khấu/xoá nợ có duyệt, cấn trừ khách–NCC, số dư đầu kỳ khoá một lần, sao kê, nhắc nợ, nhập sao kê ngân hàng tự khớp, đối soát COD/sàn, công nợ NCC sinh tự động từ phiếu nhập (hoá đơn đến muộn — EC-30).
- **Tích hợp**: hoá đơn điện tử qua hàng đợi (outbox, retry), xuất **Excel** 6 sổ, PDF, nhận đơn **Fresco** qua webhook HMAC hoặc CSV.

### Đợt 3 — Website và ứng dụng khách (M8)
- Worker riêng `huu-manh-shop` (công khai), PWA cài lên điện thoại.
- Danh mục, tìm kiếm, sản phẩm, giỏ hàng (server tính lại giá/phí), khung giờ giao 7 ngày (giới hạn số đơn, giờ chốt), COD / chuyển khoản **VietQR**, đặt trước, giá đổi → khách xác nhận (EC-11), theo dõi đơn bằng link + 4 số cuối SĐT, xác nhận lệch cân (EC-03), tài khoản, sổ địa chỉ, mua lại, xoá tài khoản (NĐ 13/2023), đặt sỉ cho khách sỉ đã liên kết.
- ERP: màn hình **Đơn online** gộp website/Fresco/mạng xã hội; state machine có chốt chặn đồng thời; cân & đóng gói; chặn giao khi chưa nhận tiền chuyển khoản (EC-05); tự huỷ đơn chuyển khoản quá 30 phút; quản lý website (sản phẩm online, ảnh, banner, bài viết, khu vực/khung giờ giao).
- Web Push (VAPID) và email qua outbox (đang dùng nhà cung cấp `fake`).

### Đợt 4 — Nhân sự, giá đối thủ, khuyến mãi, tài chính bổ sung
- **M9 nhân sự**: hồ sơ NV (dữ liệu nhạy cảm chỉ chủ + kế toán, mọi lần xem/sửa ghi nhật ký), hợp đồng, phụ cấp, nghỉ việc khoá tài khoản; **chấm công trên điện thoại** theo giờ máy chủ, xác thực GPS (bán kính cửa hàng + sai số) hoặc **mã QR xoay vòng 30s** (màn `/hr/qr` cho máy tính bảng tại quầy), thiết bị đăng ký (đổi máy cần duyệt), chấm offline → chờ duyệt; lịch ca tuần, đổi ca; quên chấm / nghỉ phép (số dư) / tăng ca có duyệt; **bảng công** tự tính (muộn, về sớm, thiếu giờ ra không đoán, ca qua đêm, ca gãy, ngày lễ) và chốt kỳ (khoá DB).
- **M9 lương**: lương tháng/giờ/ca, phụ cấp, tăng ca theo hệ số, thưởng/phạt, thưởng doanh số, BHXH (trần), TNCN luỹ tiến có giảm trừ, tạm ứng & khấu trừ; chủ duyệt; chi lương sinh phiếu chi M6; phiếu lương cho NV trên điện thoại; xuất Excel; báo cáo chi phí nhân sự. Vai trò mới `staff` (chỉ chấm công + phiếu lương).
- **M7 giá đối thủ**: nguồn web/sàn/nhập tay, thu thập theo lịch **tôn trọng robots.txt, giới hạn tốc độ, chặn URL nội bộ**, ghép sản phẩm có duyệt, chuẩn hoá đơn vị (kg/trái), so sánh min/TB, lịch sử, lọc giá bất thường, cảnh báo, **gợi ý giá đi qua luồng duyệt M3** (không tự đổi giá).
- **M2-11** gợi ý đặt hàng theo tốc độ bán + thời gian giao → tạo phiếu nhập nháp.
- **Khuyến mãi** (%, số tiền, đồng giá, combo, xả cuối ngày), **voucher** (sinh hàng loạt, giới hạn lượt/khách), **tích & đổi điểm** — áp ở POS và website; giỏ quà (đóng giỏ tiêu thụ thành phần FEFO) & **đặt cọc** đơn đặt trước tại quầy.
- **Tài chính**: dòng tiền, lãi lỗ theo kênh (phân bổ chi phí chung), tổng hợp GTGT, ngân sách & thực tế; đơn sỉ lặp tự sinh lúc 08:00.

### 2.5 Audit (24/11/2026)
3 agent audit độc lập (phân quyền/IDOR, toàn vẹn tiền-kho khi đồng thời, bề mặt công khai) → 36 phát hiện, tất cả đã sửa kèm test hồi quy. Nổi bật:
- **Đồng thời (6 Critical)**: huỷ đơn / trả hàng / chi lương / hoàn tiền / thu nợ / đảo phiếu có thể bị nhân đôi khi bấm hai lần hoặc hai người cùng thao tác. Nguyên nhân chung: `UPDATE ... WHERE status='cũ'` khớp 0 dòng không làm batch thất bại. Sửa bằng chốt chặn dùng chung `services/guard.ts` (`assertStmt`, `onceStmt`) + ràng buộc DB (migration 0008: cấm gạch nợ vượt số còn nợ, đảo phiếu một lần, một ca mở/người…).
- **Phân quyền (High)**: kế toán từng tạo được tài khoản *chủ* và khoá được tài khoản chủ qua màn nhân sự; nhật ký & danh sách phiếu chi lộ lương cho quản lý; tự duyệt yêu cầu của chính mình; thu ngân dùng lại phiếu duyệt để bán giá 1đ; thu ngân thấy giá vốn — đã chặn.
- **Bề mặt công khai**: thêm Workers Rate Limiting (`RL_AUTH`, `RATE_LIMITER`), đăng nhập không lộ tài khoản tồn tại/bị khoá, giới hạn đơn COD chưa xác nhận theo SĐT + tự huỷ sau 72h, chống spam email, chống chèn công thức Excel, crawler đọc có giới hạn byte & chặn URL nội bộ, webhook ký cả timestamp.

### Bảo mật đã có (chi tiết `docs/SECOPS.md`)
CSP/HSTS cho cả API lẫn HTML, cookie `__Host-` + chống CSRF, rate limit/Turnstile cho website, webhook HMAC + chống phát lại, upload ảnh kiểm magic bytes, staging tách hẳn D1/R2/Queue khỏi production, CI có `npm audit` + gitleaks. Đã vá lỗ hổng zod (nâng lên 4.6.7).

## 3. Chưa xong

### 3.1 Hạ tầng / deploy (việc cần làm ngay)
1. **Deploy 2 Worker** (`huu-manh-erp`, `huu-manh-shop`) — cần API token (mục 4).
2. **Tạo Queues**: `huu-manh-erp-jobs`, `huu-manh-erp-jobs-dlq` (wrangler cần chúng tồn tại trước khi deploy ERP).
3. **Secrets**: `BOOTSTRAP_TOKEN` (tạo tài khoản chủ lần đầu rồi xoá), `ATTENDANCE_QR_SECRET` (mã QR chấm công), `TURNSTILE_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `VAPID_PRIVATE_KEY`; vars `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `SHOP_BASE_URL` (bắt buộc — link trong email); khi có: `MISA_*`, `FRESCO_WEBHOOK_SECRET`. Rate limiting (`RL_AUTH`, `RATE_LIMITER`) đã khai báo trong wrangler, không cần thao tác thêm.
4. **Font PDF** lên R2: `fonts/BeVietnamPro-Regular.ttf`, `fonts/BeVietnamPro-Bold.ttf`.
5. **Tên miền + bảo vệ**: gắn domain, Cloudflare Access cho ERP, WAF/rate limit theo checklist `docs/SECOPS.md` mục 3.
6. **Môi trường staging**: tạo D1 `huu-manh-erp-staging`, R2 `huu-manh-erp-files-staging`, queue `huu-manh-erp-jobs-staging` (+ `-dlq`), điền `database_id` staging vào hai file wrangler (đang là placeholder `0000…`).
7. Bật **GitHub Environments** `staging`/`production` (production cần Required reviewers).

### 3.2 Chức năng còn thiếu / giả định cần xác nhận
| Mục | Hiện trạng |
|---|---|
| MISA meInvoice | Đã có adapter nhưng **endpoint và tên trường là giả định**, mới test bằng mock. Cần tài liệu API MISA cấp cho cửa hàng. Đang dùng provider `fake` (số `TEST-…`). |
| Fresco | Định dạng webhook/CSV là giả định (`src/worker/services/fresco.ts`), mặc định tắt. |
| Cổng thanh toán online | Mới có khung + cổng giả để test; chờ chọn cổng. |
| Email thật | Cần bật Cloudflare Email Service + binding `EMAIL`; hiện ghi log (`fake`). |
| Duyệt báo giá giảm sâu | Luồng có nhưng hiện không ai phải qua (quản lý có sẵn quyền duyệt); cần vai trò "nhân viên kinh doanh" nếu cửa hàng muốn. |
| Push / email / đặt sỉ trên web | Có code + unit test, **chưa E2E** (thiếu khoá VAPID, tài khoản sỉ đã duyệt). |
| Ứng dụng khách | PWA; nếu cần App Store/Google Play phải bọc thêm (Capacitor). |
| SEO website | SPA, chỉ có title/meta theo trang + sitemap; chưa render phía server. |

### 3.3 Còn lại sau Đợt 4
- **Không còn đợt phát triển** theo tài liệu nghiệp vụ. Tiếp theo là **tuần 10**: đào tạo, chạy song song, nghiệm thu, go-live.
- **Biểu thuế TNCN mặc định** (`hr.pit_brackets_json`, 7 bậc) đi kèm mức giảm trừ 15,5 tr/6,2 tr — **phải đối chiếu luật thuế TNCN hiện hành** (đã có thay đổi về số bậc) trước khi trả lương thật; tất cả là tham số cấu hình.
- Máy chấm công vân tay / khuôn mặt (M9-24, Could) — chưa làm (cần thiết bị, [Cần xác nhận]).
- Đổi ca: NV gửi/nhận được, nhưng chưa có kịch bản E2E đầy đủ; hợp đồng lao động thêm được nhưng chưa sửa trên giao diện; loại nghỉ phép cố định 3 loại.
- Website chưa tích/đổi điểm (chỉ POS); voucher/điểm chưa in trên hoá đơn điện tử.
- Rủi ro còn lại có chủ đích (ghi trong báo cáo audit): kiểm hạn mức khi xác nhận đơn sỉ đồng thời trả 409 để thử lại (ưu tiên chặn); quỹ chờ đối soát chỉ rút phần tiền đã ghi vào quỹ đó.

### 3.4 Điểm [Cần xác nhận] với chủ cửa hàng (ảnh hưởng cấu hình)
Giá vốn theo lô hay bình quân · ngưỡng duyệt (giảm giá, phiếu chi, kiểm kê, xoá nợ) · mốc tuổi nợ · thuế GTGT / hình thức kinh doanh · loại mã vạch · cân điện tử nối điện thoại · thành phố & khu vực giao (đang ví dụ TP.HCM) · số tài khoản nhận tiền VietQR · ngưỡng lệch cân (10%) · ai chịu phí giao khi khách huỷ · mẫu sổ Excel kế toán · danh sách đối thủ & tần suất thu thập · cách tính lương (tháng/giờ/ca), ngày công chuẩn, hệ số tăng ca, quy định phép & đi muộn · cách xác thực chấm công (GPS, QR hay cả hai) · có đóng BHXH cho NV không · bật tích điểm & tỉ lệ đổi điểm · cho cộng dồn khuyến mãi không · % đặt cọc giỏ quà.

## 4. Cách deploy (khi có API token)

Token Cloudflare cần quyền: *Workers Scripts:Edit, D1:Edit, Workers R2 Storage:Edit, Queues:Edit, Account Settings:Read* (giới hạn đúng account).

**Cách A — GitHub Actions (khuyến nghị):** thêm `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` vào *Settings → Secrets and variables → Actions*, biến `PROD_URL`; tạo queues (một lần) rồi tạo tag `v0.3.0` → job `deploy-production` chạy migrations + deploy cả hai Worker.

**Cách B — từ máy:**

```bash
npx wrangler login
```

```bash
npx wrangler queues create huu-manh-erp-jobs
```

```bash
npx wrangler queues create huu-manh-erp-jobs-dlq
```

```bash
npm run deploy
```

```bash
npm run deploy:shop
```

Sau deploy lần đầu: `wrangler secret put BOOTSTRAP_TOKEN` → gọi `POST /api/auth/bootstrap` (header `X-Bootstrap-Token`) để tạo tài khoản chủ → `wrangler secret delete BOOTSTRAP_TOKEN`.

Migrations production đã được áp và ghi vào bảng `d1_migrations`, nên `wrangler d1 migrations apply huu-manh-erp --remote` sẽ báo "No migrations to apply" — đúng như mong đợi.

## 5. Tài nguyên Cloudflare đã tạo

| Tài nguyên | Tên | Ghi chú |
|---|---|---|
| D1 | `huu-manh-erp` (`01557b74-7189-49a6-adf5-9591ec6bb3ba`) | APAC; migration 0001–0004; dữ liệu tham chiếu: 1 cửa hàng, 3 vị trí, 5 quỹ, 10 danh mục thu chi, 4 nhóm khách, 4 bảng giá, 4 nhóm hàng, user `system` (không đăng nhập được). **Chưa có sản phẩm, NCC, tài khoản người dùng.** |
| R2 | `huu-manh-erp-files` | Trống (cần upload font PDF). |

Không có tài nguyên nào khác trong account bị thay đổi.

## 6. Ghi chú kỹ thuật cho người tiếp quản
- Toàn bộ quy ước dữ liệu: tiền = số nguyên VND; số lượng = số nguyên *milli* của đơn vị chính (1 kg = 1000); thời gian lưu UTC, tính ngày theo giờ VN.
- Mọi thay đổi trạng thái/kho/tiền đi trong **một D1 batch** kèm `auditStmt`; `stock_moves`, `audit_log`, hoá đơn đã phát hành là bất biến (trigger DB).
- Vite plugin chọn môi trường **lúc build** (`CLOUDFLARE_ENV=staging npm run build`), `wrangler deploy --env` bị bỏ qua với bản build ERP.
- Dữ liệu dev local (`.wrangler/state`) dùng chung cho cả hai Worker; các kịch bản E2E tạo dữ liệu thật trong DB local.
- Chạy kiểm thử: `npx vitest run` · `npx tsc --noEmit` · E2E cần `wrangler dev` ERP (:8787) và shop (:8788): `node e2e/smoke.mjs`, `e2e/b2b.mjs`, `e2e/online.mjs`, `e2e/shop.mjs`.

## 7. Bản demo trên `*.workers.dev` (gửi khách xem)

- Môi trường `demo` trong `wrangler.jsonc` / `wrangler.shop.jsonc`: Worker `huu-manh-erp-demo` (ERP) và `huu-manh-shop-demo` (website), dùng D1 `huu-manh-erp` + R2 `huu-manh-erp-files`, **không dùng Queues** (chạy được trên gói Workers miễn phí; cron `*/5` tự xử lý job).
- Deploy: thêm `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` vào GitHub Secrets rồi đẩy tag `demo-*` (vd `demo-2026-11-24`) → job `deploy-demo` (migrations → font PDF lên R2 → deploy ERP → deploy website).
- Dữ liệu demo đã nạp vào D1: 29 sản phẩm (20 bán online), 5 NCC minh hoạ, giá chung/sỉ/online, tồn kho qua phiếu `PN-DEMO-0001` (hạn dùng 21 ngày kể từ 24/11/2026 — sau đó lô sẽ hết hạn, cần nhập thêm), 3 khu vực giao (TP.HCM, ví dụ), 4 khung giờ, 2 bài viết, tài khoản ngân hàng VietQR **giả** (`0000000000`).
- Tài khoản: `chu` (chủ cửa hàng) — mật khẩu được giao riêng cho chủ dự án, **đổi ngay sau khi nhận**.
- Turnstile dùng **khoá thử nghiệm công khai** của Cloudflare (luôn cho qua) — chỉ cho demo.
- Trước khi go-live thật: xoá dữ liệu demo hoặc tạo D1 mới; đặt Turnstile thật, tài khoản ngân hàng thật; chuyển sang môi trường production (có Queues).

**⚠️ Quan trọng về dữ liệu:** D1 `huu-manh-erp` hiện là **database demo** (dữ liệu mẫu, tài khoản ngân hàng giả) và được dùng chung cho môi trường `demo` lẫn cấu hình gốc (production) trong hai file wrangler. Trước khi chạy thật: tạo D1 + R2 production mới, đổi `database_id`/`bucket_name` ở cấu hình gốc, áp migration, KHÔNG nạp `seed/*.sql`, nhập danh mục thật; để `demo` tiếp tục trỏ DB demo (hoặc xoá). Bản demo công khai trên `*.workers.dev` với Turnstile thử nghiệm luôn cho qua — đừng nhập dữ liệu thật vào đó.
