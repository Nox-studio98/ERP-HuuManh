# Hữu Mạnh ERP

Hệ thống quản lý cho chuỗi cửa hàng trái cây **Hữu Mạnh**: bán hàng tại quầy và online, kho lạnh và lô hàng, bảng giá, thu chi và quỹ.

## Phạm vi

Có 9 mô-đun (M1–M9). **Đợt 1** gồm M1, M2, M3, M6.

| Mã | Mô-đun | Đợt |
|---|---|---|
| M1 | Bán hàng tại quầy (ca, đơn, thanh toán, trả hàng, huỷ đơn) | 1 |
| M2 | Kho & danh mục hàng hoá (lô, FEFO, chứng từ nhập/xuất/hao hụt/kiểm kê, quét mã) | 1 |
| M3 | Giá (bảng giá, lịch sử giá, duyệt giá dưới vốn) | 1 |
| M4 | Khách hàng (mở rộng: nhóm, công nợ, điểm) | 2 (bản tối thiểu có trong Đợt 1) |
| M5 | [Cần xác nhận tên và phạm vi] | 2 |
| M6 | Quỹ & thu chi (phiếu thu/chi, đối soát ca, khoá kỳ, báo cáo lãi lỗ) | 1 |
| M7 | [Cần xác nhận tên và phạm vi] | 2 |
| M8 | [Cần xác nhận tên và phạm vi] (quy tắc và yêu cầu chung) | 2 |
| M9 | [Cần xác nhận tên và phạm vi] (liên quan đến giờ máy chủ, xem M9-12 trong tài liệu yêu cầu) | 2 |

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

## Ghi chú

- `seed/seed.sql` chỉ chứa master data demo: cửa hàng, quỹ, danh mục, sản phẩm, bảng giá. Không có lô hàng, đơn hàng hay tài khoản người dùng thật. Tài khoản `system` (id 1) không đăng nhập được.
- Các mục đánh dấu **[Cần xác nhận]** là quy định cần chủ cửa hàng chốt, xem `migrations/0001_init.sql`.
