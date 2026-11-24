# Hữu Mạnh ERP

Hệ thống quản lý cho chuỗi cửa hàng trái cây **Hữu Mạnh**: bán hàng tại quầy và online, kho lạnh và lô hàng, bảng giá, thu chi và quỹ.

## Phạm vi

Có 9 mô-đun (M1–M9). **Đợt 1** gồm M1, M2, M3, M6.

| Mã | Mô-đun | Đợt |
|---|---|---|
| M1 | Bán hàng tại quầy (ca, đơn, thanh toán, trả hàng, huỷ đơn) | 1 |
| M2 | Kho & danh mục hàng hoá (lô, FEFO, chứng từ nhập/xuất/hao hụt/kiểm kê, quét mã) | 1 |
| M3 | Giá (bảng giá, lịch sử giá, duyệt giá dưới vốn) | 1 |
| M4 | Khách hàng B2B (báo giá → đơn sỉ → giao → hoá đơn → thu tiền, hạn mức nợ) | 2 |
| M5 | Công nợ phải thu / phải trả, tuổi nợ, nhắc nợ | 2 |
| M6 | Tài chính: quỹ, thu chi, đối soát ca, khoá kỳ, báo cáo lãi lỗ | 1 |
| M7 | Theo dõi giá đối thủ (chỉ gợi ý cho M3) | 4 |
| M8 | Website và ứng dụng bán hàng cho khách | 3 |
| M9 | Nhân sự, chấm công, lương | 4 |

Chi tiết hợp đồng API: [docs/API.md](docs/API.md). Kiến trúc: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Bảo mật: [docs/SECOPS.md](docs/SECOPS.md).

## Công nghệ

- **Backend:** Cloudflare Workers + [Hono](https://hono.dev), validate bằng Zod.
- **Cơ sở dữ liệu:** Cloudflare D1 (SQLite). Schema đầu tiên: `migrations/0001_init.sql`.
- **Tệp đính kèm:** Cloudflare R2 (binding `FILES`).
- **Tác vụ định kỳ:** Cron Triggers (cấu hình trong `wrangler.jsonc`).
- **Giao diện:** React PWA, build bằng Vite, phục vụ qua Workers Static Assets (`dist/client`).

## Cấu trúc thư mục

```text
src/worker/     Mã Worker (Hono): routes/ (API theo mô-đun), services/ (nghiệp vụ: giá, kho, thu chi, báo cáo), lib/ (thời gian, RBAC, audit, tiền)
src/web/        React PWA: screens/, components/, styles/
src/worker/scheduled.ts  Xử lý Cron Triggers
migrations/     Schema D1 theo thứ tự (0001_init.sql, ...)
seed/           Dữ liệu demo master (không có dữ liệu người thật)
test/           Kiểm thử (vitest + @cloudflare/vitest-pool-workers)
docs/           API.md, ARCHITECTURE.md, SECOPS.md
wrangler.jsonc  Cấu hình Worker, D1, R2, cron, assets
```

## Quy ước dữ liệu

- **Tiền:** số nguyên VND, không có số lẻ.
- **Số lượng:** số nguyên *milli* của đơn vị chính. 1 kg = 1000, 1,85 kg = 1850, 3 trái = 3000. Đơn vị khác (thùng, khay) được quy đổi bằng `product_units.factor_milli`.
- **Thời gian:** lưu UTC ISO-8601, do máy chủ sinh (không tin giờ của client). Ngày, kỳ, báo cáo tính theo giờ Việt Nam (`Asia/Ho_Chi_Minh`, UTC+7).
- **Không xoá chứng từ:** `stock_moves` và `audit_log` là bất biến (trigger chặn UPDATE/DELETE). Sửa sai bằng chứng từ điều chỉnh hoặc phiếu đảo.

## Phát triển local

Chạy lần đầu hoặc sau khi clone:

```bash
npm install --legacy-peer-deps
```

Tạo schema trong D1 local:

```bash
npm run db:migrate:local
```

Nạp dữ liệu demo:

```bash
npx wrangler d1 execute huu-manh-erp --local --file=seed/seed.sql
```

Chạy ứng dụng (Vite + Worker):

```bash
npm run dev
```

Chạy kiểm thử:

```bash
npm test
```

## Thiết lập production lần đầu

Đăng nhập Cloudflare:

```bash
npx wrangler login
```

Tạo cơ sở dữ liệu D1. Sao chép `database_id` in ra và dán vào `wrangler.jsonc` (thay giá trị `00000000-...`):

```bash
npx wrangler d1 create huu-manh-erp
```

Tạo bucket R2 cho tệp đính kèm:

```bash
npx wrangler r2 bucket create huu-manh-erp-files
```

Áp dụng migration lên D1 production:

```bash
npm run db:migrate:remote
```

Nạp dữ liệu master (giá, sản phẩm, quỹ, danh mục thu chi):

```bash
npx wrangler d1 execute huu-manh-erp --remote --file=seed/seed.sql
```

Đặt token bootstrap (nhập giá trị khi được hỏi, không lưu vào repo):

```bash
npx wrangler secret put BOOTSTRAP_TOKEN
```

Build và triển khai:

```bash
npm run deploy
```

Tạo tài khoản chủ cửa hàng đầu tiên (chỉ hoạt động khi hệ thống chưa có user). Thay `<your-domain>` bằng địa chỉ Worker sau khi deploy và `<BOOTSTRAP_TOKEN>` bằng token vừa đặt; body JSON theo `docs/API.md`:

```bash
curl -X POST "https://<your-domain>/api/auth/bootstrap" -H "X-Bootstrap-Token: <BOOTSTRAP_TOKEN>" -H "Content-Type: application/json" -d '<JSON body theo docs/API.md>'
```

Sau khi tạo xong owner, xoá token bootstrap để endpoint không dùng lại được:

```bash
npx wrangler secret delete BOOTSTRAP_TOKEN
```

## Bổ sung khi lên Đợt 2 (B2B, công nợ, MISA, Fresco)

Tạo queue cho job tích hợp (hoá đơn điện tử, nhắc nợ):

```bash
npx wrangler queues create huu-manh-erp-jobs
```

```bash
npx wrangler queues create huu-manh-erp-jobs-dlq
```

Tải font tiếng Việt cho PDF báo giá / hoá đơn (font Be Vietnam Pro, giấy phép OFL):

```bash
npx wrangler r2 object put huu-manh-erp-files/fonts/BeVietnamPro-Regular.ttf --file=./BeVietnamPro-Regular.ttf --remote
```

```bash
npx wrangler r2 object put huu-manh-erp-files/fonts/BeVietnamPro-Bold.ttf --file=./BeVietnamPro-Bold.ttf --remote
```

Khi có tài khoản API MISA meInvoice (mặc định hệ thống dùng nhà cung cấp `fake`, số hoá đơn có tiền tố `TEST-`):

```bash
npx wrangler secret put MISA_APP_ID
```

```bash
npx wrangler secret put MISA_USERNAME
```

```bash
npx wrangler secret put MISA_PASSWORD
```

Sau đó đặt `MISA_TAX_CODE`, `MISA_BASE_URL` (vars) và đổi cài đặt `einvoice.provider` sang `misa` trong màn hình Tích hợp. **Ánh xạ trường dữ liệu MISA đang là giả định — phải đối chiếu tài liệu API MISA cấp cho cửa hàng trước khi bật.**

Sàn Fresco: khi sàn cung cấp webhook, đặt secret rồi bật `fresco.enabled`. Địa chỉ webhook: `https://<tên-miền>/api/integrations/fresco/webhook`. Nếu sàn chỉ cho xuất file, dùng màn hình nhập CSV.

```bash
npx wrangler secret put FRESCO_WEBHOOK_SECRET
```

## Bổ sung khi lên Đợt 3 (website & app khách)

Website là Worker riêng `huu-manh-shop` (`wrangler.shop.jsonc`), dùng chung D1/R2/Queue với ERP. Thay `database_id` trong `wrangler.shop.jsonc` giống `wrangler.jsonc`.

```bash
npm run build:shop
```

```bash
npx wrangler dev -c wrangler.shop.jsonc --port 8788
```

```bash
npm run deploy:shop
```

Secrets cho website (Turnstile chống bot, webhook thanh toán) và cho cả hai Worker (Web Push):

```bash
npx wrangler secret put TURNSTILE_SECRET -c wrangler.shop.jsonc
```

```bash
npx wrangler secret put PAYMENT_WEBHOOK_SECRET -c wrangler.shop.jsonc
```

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

- Site key Turnstile: đặt `VITE_TURNSTILE_SITE_KEY` khi build website (hoặc thẻ `<meta name="turnstile-site-key">`).
- Vars: `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `SHOP_BASE_URL` (link tra cứu đơn trong email/push).
- Trong ERP → Cài đặt: `payment.bank_account`, `payment.bank_account_name`, `payment.bank_bin` (VietQR), khu vực giao + khung giờ (màn hình "Khu vực giao"), bật sản phẩm bán online (Hàng hoá → tab "Bán online").
- Email: `notify.email_provider = cloudflare` cần thêm binding `send_email` tên `EMAIL` vào `wrangler.jsonc` (yêu cầu bật Email Service/Email Routing cho tên miền).
- Khuyến nghị: đặt ERP sau **Cloudflare Access** (chỉ nhân viên), website để công khai.
- Dữ liệu mẫu: `seed/seed-dot3.sql` (khu vực giao lấy TP.HCM làm ví dụ — [Cần xác nhận]).

## Sao lưu R2 và khôi phục

Cron 00:00 giờ VN (`0 17 * * *`) ghi toàn bộ bảng nghiệp vụ vào R2: `backups/YYYY-MM-DD/<bảng>.part-NNNN.ndjson.gz` và `manifest.json` (số dòng + sha256 từng phần; có manifest = bản sao lưu đủ). Giữ `settings.backup.retention_days` ngày (mặc định 30). Bản sao lưu không chứa `users.pass_hash` và `sessions`.

Khôi phục vào D1 (đã chạy `wrangler d1 migrations apply <db> --remote` để có lược đồ):

```bash
node scripts/restore-from-r2.mjs --day 2026-11-24 --db huu-manh-erp --remote --dry-run   # chỉ tải + kiểm checksum/số dòng, sinh SQL
node scripts/restore-from-r2.mjs --day 2026-11-24 --db huu-manh-erp --remote             # nạp thật (INSERT OR REPLACE theo thứ tự khoá ngoại)
node scripts/restore-from-r2.mjs --day 2026-11-24 --db huu-manh-erp --local              # dựng D1 local để thử
```

Tuỳ chọn: `--bucket`, `--env demo`, `--from-dir <thư mục đã tải>`, `--out`, `--max-file-mb`. Sau khôi phục phải đặt lại mật khẩu người dùng (bản sao lưu không có mật khẩu).

## Ghi chú

- `seed/seed.sql` chỉ chứa master data demo: cửa hàng, quỹ, danh mục, sản phẩm, bảng giá. Không có lô hàng, đơn hàng hay tài khoản người dùng thật. Tài khoản `system` (id 1) không đăng nhập được.
- Các mục đánh dấu **[Cần xác nhận]** là quy định cần chủ cửa hàng chốt, xem `migrations/0001_init.sql`.
