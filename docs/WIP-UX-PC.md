# Hoàn thiện giao diện máy tính (PC) cho ERP

Trạng thái ngày 25/11/2026: **bước 1, 2B, 2C đã xong** (2B + 2C gộp chung một PR). Tài liệu giữ lại để tra cứu cách chụp/rà ảnh và chạy E2E.

## Mục tiêu

ERP được làm theo hướng ưu tiên điện thoại, nên trên màn 1440–1920px trông như "bản điện thoại kéo giãn": nội dung bị bó 1200px, thẻ chỉ chiếm nửa màn hình, bộ lọc nghèo, không có Tổng quan.

Mục tiêu đợt này: mọi màn dùng tốt không gian trên PC, có bộ lọc, số liệu, phân trang, xuất file và khung chi tiết bên phải. Bản điện thoại (390px) phải giữ nguyên chất lượng.

Ảnh "trước khi sửa" của 37 màn ở 1440px được chụp lúc audit; cách chụp lại xem ở mục "Cách làm tiếp", bước 5.

## Bước 1 — ✅ XONG, đã gộp vào `main` (nhánh `ux-1`)

- **Khung ứng dụng** (`src/web/components/shell.tsx`):
  - thanh trên cùng: tiêu đề trang, cửa hàng, chỉ báo ca, tìm nhanh Ctrl+K, chuông thông báo, menu người dùng
  - menu trái thu gọn được theo nhóm, ghim mục, chế độ chỉ hiện biểu tượng
  - nội dung rộng tối đa 1600px, căn trái
- **Trang Tổng quan** `/dashboard` (`GET /dashboard`, có phân quyền theo từng khối): là trang vào đầu tiên của chủ, quản lý, kế toán.
- **Bộ thành phần danh sách** (`src/web/components/list.tsx`, hướng dẫn chi tiết ở **`docs/UI-KIT.md`**): `PageHeader`, `FilterBar`, `DateRangeFilter`, `SearchInput`, `FilterSelect`, `KpiRow`, `DataTable` (sắp xếp, phân trang, `emptyState`), `usePagedList`, `ExportButton` (CSV), `SplitLayout`/`DetailPanel`.
- **Màn Đơn hàng** làm lại hoàn toàn theo bộ thành phần, dùng làm **mẫu tham chiếu**. `GET /orders` nhận thêm các bộ lọc mới.
- **Màn "Của tôi"** cho chủ/admin không có hồ sơ nhân viên: hiện thẻ hướng dẫn, không còn báo lỗi đỏ.
- **Kiểm thử:** tsc sạch, vitest 642 test đạt, e2e smoke/b2b/hr/online đạt.
- **Ảnh chụp:** `docs/screenshots/ux1-*.png`.

## Bước 2B + 2C — ✅ XONG (gộp chung một PR từ nhánh `claude/gallant-franklin-12orwk`)

**Phạm vi 2B:** Bán hàng (POS), Chốt ca, Kho, Hàng hoá, Giá, Nhà cung cấp, Gợi ý đặt hàng, Giá đối thủ, Khuyến mãi, Giỏ quà, Khách sỉ, Báo giá, Đơn sỉ (+ Đơn lặp), Soạn & giao (3 cột trên PC), Đơn online, Website, Khu vực giao, Tài khoản khách.

**Phạm vi 2C:** Công nợ, Hoá đơn, Thu chi (tab Quỹ + phiếu gần đây), Ngân hàng, Báo cáo, Báo cáo tài chính, Xuất Excel, Duyệt, Nhân viên, Lịch ca, Chấm công, Bảng công, Lương, Cửa hàng, Của tôi, Người dùng, Cài đặt (2 cột), Tích hợp.

**Đã làm:**
- Rebase `ux-2b` rồi `ux-2c` lên `main`; xung đột `ui.tsx` (`Segmented` nhận cả `fit` và `className`), `app.css` (giữ cả hai khối).
- Backend: bộ lọc `q`/`from`/`to` + `summary` cho `/b2b/orders`, `/quotes`, `/online-orders`, `/stock-docs`, `/invoices`, `/vouchers`; `GET /shifts/last`. Kiểm khoảng ngày dùng chung `parseDayRange` (`lib/time.ts`, chỉ thêm hàm mới). Test: `test/ux2b-api.test.ts`, `test/ux2c-lists.test.ts`.
- Sửa lỗi có sẵn: `GET /debts/payments` lọc `from`/`to` theo ngày UTC → nay theo ngày VN (test `test/fix-debts-payments-vn-day.test.ts`).
- Thành phần dùng chung chỉ **thêm** prop tuỳ chọn (`PageHeader.compact`, `ExportButton.className`, `Segmented.fit/className`, `BarChart.maxBar/width`, `DataTable` cột `hideBelow: 1600`, `useMedia`). Chỉ báo ca trên thanh trên cập nhật ngay khi mở/chốt ca (sự kiện `hm:shift`).
- Chụp và **xem từng ảnh** ở 1920/1440/390 cho 46 màn + khung chi tiết; sửa bố cục (bảng bị cắt khi mở khung chi tiết, KPI bị bóp, tab xuống dòng, ô ngày/ô tìm bị cắt, tràn ngang 390px…). Rà chéo sau khi gộp hai đợt. Không màn nào tràn ngang ở 390px.
- Ảnh: `docs/screenshots/ux2b-*-{1440,390}.png`, `ux2c-*-{1440,390}.png`. Script: `e2e/ux2b-shots.mjs`, `e2e/ux2c-shots.mjs` (biến `BASE`, `SIZES`, `ONLY`, `OUT`).
- Kiểm thử: `tsc` sạch, toàn bộ `vitest` đạt, **10/10 bộ E2E đạt** trên DB mới (chỉ sửa selector do giao diện đổi cố ý, không giảm assert).

**Quyết định (25/11/2026):** quản lý (có `reports.view`, không có `hr.sensitive`) được xem **tổng** chi lương trong Báo cáo lãi lỗ, Dòng tiền, Lãi lỗ theo kênh — chủ dự án xác nhận là chấp nhận được. Lương từng người vẫn chỉ chủ + kế toán xem được (`/vouchers` ẩn phiếu lương, `/payroll/*` cần quyền riêng).

**Còn để lại (nhỏ):**
- (Đã xong đợt 6b) Gõ thẳng URL không có quyền (vd `/payroll` với quản lý) nay hiện "Bạn không có quyền xem trang này" (`NoAccess` trong `App.tsx`); chỉ spinner khi đang ở `/`.
- Website → Bài viết ở 1920px: lưới chỉ 2 thẻ nên nửa phải trống (do dữ liệu mẫu ít).
- `e2e/gaps2.mjs` cần tồn kho có sẵn: chạy `smoke.mjs` trước trên cùng DB.

## Cách làm tiếp

1. (Đã xong cho 2B/2C.) Rebase nhánh lên `main` mới. Bước 1 đã nằm trong `main`.
   ```bash
   git fetch origin && git checkout ux-2b && git rebase origin/main
   ```
   Làm tương tự với `ux-2c`. Hai nhánh cùng sửa `ui.tsx`, `app.css` và `routes/b2b.ts`. Nên gộp `ux-2b` trước, rồi rebase `ux-2c` lên và xử lý xung đột.
2. Cài đặt:
   ```bash
   npm ci --legacy-peer-deps
   ```
3. Kiểm tra: `npx tsc --noEmit`, `npx vitest run`, `npm run build` và `npm run build:shop`.
4. E2E (mỗi bộ trên DB mới; ví dụ thư mục `.wrangler/e1`):
   ```bash
   S=.wrangler/e1; rm -rf $S
   npx wrangler d1 migrations apply huu-manh-erp --local --persist-to $S
   for f in seed/seed.sql seed/seed-dot3.sql seed/seed-dot4.sql; do npx wrangler d1 execute huu-manh-erp --local --persist-to $S --file $f; done
   npx wrangler d1 execute huu-manh-erp --local --persist-to $S --command "UPDATE stores SET lat=10.7769,lng=106.7009,geofence_m=150 WHERE id=1"
   F=node_modules/@expo-google-fonts/be-vietnam-pro
   npx wrangler r2 object put huu-manh-erp-files/fonts/BeVietnamPro-Regular.ttf --local --persist-to $S --file $F/400Regular/BeVietnamPro_400Regular.ttf
   npx wrangler r2 object put huu-manh-erp-files/fonts/BeVietnamPro-Bold.ttf --local --persist-to $S --file $F/700Bold/BeVietnamPro_700Bold.ttf
   npm run build && npm run build:shop
   npx wrangler dev -c dist/huu_manh_erp/wrangler.json --port 8797 --persist-to $S &
   npx wrangler dev -c dist-shop/huu_manh_shop/wrangler.json --port 8795 --inspector-port 9795 --persist-to $S &   # chỉ khi chạy shop/shop-b2b/d4
   # BOOTSTRAP_TOKEN: lấy giá trị trong .dev.vars (chỉ dùng cho môi trường dev local)
   curl -X POST localhost:8797/api/auth/bootstrap -H 'content-type: application/json' -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" -d '{"username":"chu","password":"<mật khẩu dev>","fullName":"Chủ cửa hàng"}'
   BASE=http://localhost:8797 SHOTS=0 PERSIST=$S node e2e/smoke.mjs     # rồi b2b.mjs trên cùng DB
   ```
   Bộ `pos-kv` (POS kiểu KiotViet, PC 1440 + ĐT 390; chạy trên DB mới, chuẩn bị dữ liệu qua API): `BASE=http://localhost:8871 PERSIST=.wrangler/e-poskv SHOTS=1 node e2e/pos-kv.mjs` (dựng DB + server bằng `bash scripts/e2e-db.sh .wrangler/e-poskv 8871`).
   Các bộ khác: `hr`, `hr-swap`, `gaps2`, `online` (BASE + PERSIST); `shop`, `shop-b2b`, `d4` (ERP=… SHOP=… PERSIST=…; d4 mặc định cổng 8792/8793); `settings` tự dựng DB + server cổng 8798. Tất cả 10 bộ phải đạt.
5. Chụp ảnh mọi màn ở 1920×1080, 1440×900 và 390×844, rồi **xem từng ảnh**. Lỗi hay gặp: trang trống nửa màn, nút quá to, tiêu đề lệch, tràn ngang ở điện thoại.
6. Mở PR vào `main` và chờ CI xanh. Deploy demo bằng cách tạo tag `demo-YYYY-MM-DD` trên GitHub (Releases → Draft a new release).

## Nguyên tắc

- Chỉ **thêm** prop hoặc class vào bộ thành phần dùng chung, không đổi hành vi cũ.
- Không lộ giá vốn hay lương cho vai trò không có quyền.
- Giao diện hoàn toàn bằng tiếng Việt.
- Mọi API mới phải có `requirePerm` và test.

> **Lưu ý khi mở PR từ nhánh này:** commit WIP đầu tiên của nhánh có một bản cũ của tài liệu này chứa token bootstrap **dev local** trong lệnh mẫu, nên gitleaks sẽ báo (báo nhầm, không phải secret thật). Khi rebase lên `main`, hãy gộp (squash) các commit WIP thành một commit để loại bản cũ đó khỏi lịch sử.
