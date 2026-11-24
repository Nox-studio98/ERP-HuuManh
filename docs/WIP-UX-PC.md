# WIP — Hoàn thiện giao diện máy tính (PC) cho ERP

Trạng thái ngày 24/11/2026. Việc này đang **dở dang** và được bàn giao cho người khác làm tiếp.

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

## Bước 2B — ⏸ DỞ DANG, nhánh `ux-2b` (CHƯA gộp)

**Phạm vi:** Bán hàng (POS), Chốt ca, Kho, Hàng hoá, Giá, Nhà cung cấp, Gợi ý đặt hàng, Giá đối thủ, Khuyến mãi, Giỏ quà, Khách sỉ, Báo giá, Đơn sỉ (+ Đơn lặp), Soạn & giao (dạng 3 cột trên PC), Đơn online, Website, Khu vực giao, Tài khoản khách.

**Đã có:**
- Code đã sửa ở tất cả các màn trên.
- `tsc --noEmit` sạch.
- Ảnh 1440px trong `docs/screenshots/ux2b-*-1440.png`.

**Chưa làm / chưa kiểm:**
- [ ] Backend có sửa nhưng **chưa có test mới**: `routes/b2b.ts`, `inventory.ts`, `online-orders.ts`, `pos.ts`, `quotes.ts`, `services/http.ts` (thêm bộ lọc q/from/to/cursor). Cần viết `test/ux2b-*.test.ts`.
- [ ] Chưa chạy lại toàn bộ `vitest`.
- [ ] Chưa chạy lại e2e: smoke, b2b, online (đã sửa `e2e/online.mjs`), d4, shop, shop-b2b.
- [ ] Chưa chụp ảnh 1920px và 390px, chưa rà ảnh.
- [ ] Đã sửa thêm `components/list.tsx`, `ui.tsx` và `app.css`. Phải kiểm tra lại là chỉ **thêm**, không đổi hành vi cũ.

## Bước 2C — ⏸ DỞ DANG, nhánh `ux-2c` (CHƯA gộp)

**Phạm vi:** Công nợ, Hoá đơn, Thu chi (tab Quỹ thêm phiếu gần đây), Ngân hàng, Báo cáo (biểu đồ khi ít dữ liệu), Báo cáo tài chính, Xuất Excel, Duyệt, Nhân viên, Lịch ca, Chấm công, Bảng công, Lương, Cửa hàng, Của tôi, Người dùng, Cài đặt (2 cột), Tích hợp.

**Đã có:**
- Code đã sửa ở tất cả các màn trên.
- `tsc --noEmit` sạch.
- Test backend mới `test/ux2c-lists.test.ts`.
- Đã sửa e2e smoke, b2b, hr theo giao diện mới.

**Chưa làm / chưa kiểm:**
- [ ] Chưa chạy lại toàn bộ `vitest`.
- [ ] Chưa chạy lại e2e: smoke, b2b, hr, hr-swap, gaps2, settings.
- [ ] Chưa chụp ảnh 1920/1440/390 và chưa rà ảnh. Agent đang kiểm tra tràn ngang ở 390px thì bị dừng.
- [ ] Backend: `lib/time.ts`, `routes/b2b.ts`, `routes/finance.ts`. Cần xem lại diff `lib/time.ts` cẩn thận, vì file này dùng chung cho ranh giới ngày giờ VN.
- [ ] Đã sửa thêm `components/ui.tsx`, `charts.tsx` và `app.css`. Phải kiểm tra lại là chỉ **thêm**.

## Cách làm tiếp

1. Rebase nhánh lên `main` mới. Bước 1 đã nằm trong `main`.
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
   curl -X POST localhost:8797/api/auth/bootstrap -H 'content-type: application/json' -H 'x-bootstrap-token: local-dev-bootstrap' -d '{"username":"chu","password":"ChuCuaHang-2026","fullName":"Chủ cửa hàng"}'
   BASE=http://localhost:8797 SHOTS=0 PERSIST=$S node e2e/smoke.mjs     # rồi b2b.mjs trên cùng DB
   ```
   Các bộ khác: `hr`, `hr-swap`, `gaps2`, `online` (BASE + PERSIST); `shop`, `shop-b2b`, `d4` (ERP=… SHOP=… PERSIST=…; d4 mặc định cổng 8792/8793); `settings` tự dựng DB + server cổng 8798. Tất cả 10 bộ phải đạt.
5. Chụp ảnh mọi màn ở 1920×1080, 1440×900 và 390×844, rồi **xem từng ảnh**. Lỗi hay gặp: trang trống nửa màn, nút quá to, tiêu đề lệch, tràn ngang ở điện thoại.
6. Mở PR vào `main` và chờ CI xanh. Deploy demo bằng cách tạo tag `demo-YYYY-MM-DD` trên GitHub (Releases → Draft a new release).

## Nguyên tắc

- Chỉ **thêm** prop hoặc class vào bộ thành phần dùng chung, không đổi hành vi cũ.
- Không lộ giá vốn hay lương cho vai trò không có quyền.
- Giao diện hoàn toàn bằng tiếng Việt.
- Mọi API mới phải có `requirePerm` và test.
