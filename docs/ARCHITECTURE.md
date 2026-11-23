# Kiến trúc — Hữu Mạnh ERP trên Cloudflare

## 1. Tổng quan

```
 Điện thoại NV (PWA)    Máy tính quản lý    Website/App khách (Đợt 3)    Fresco / MISA (Đợt 2)
          │                    │                      │                          │
          └──────── HTTPS ─────┴──── Cloudflare edge (WAF, rate limit, Bot, TLS) ┘
                                         │
                        ┌────────────────┴────────────────┐
                        │  Worker "huu-manh-erp" (Hono)   │
                        │  /api/auth  /api/v1/*  + SPA    │
                        └──┬──────────┬──────────┬────────┘
                           │          │          │
                         D1 (SQLite)  R2       Cron Triggers ──► hết hạn lô, sao lưu R2, dọn phiên
                     (dữ liệu chính) (PDF, Excel, backup)
           Đợt 2+: Queues (MISA, push, email) · Durable Objects (kết nối thời gian thực, khoá kiểm kê)
           Đợt 4 : Browser Rendering / fetch có giới hạn tốc độ cho M7
```

| Thành phần | Dùng cho | Ghi chú |
|---|---|---|
| **Workers + Hono** | API + phục vụ SPA | 1 Worker, route `/api/*` chạy trước static assets |
| **D1** | CSDL chính | Một DB/cửa hàng-chuỗi; Time Travel 30 ngày để khôi phục điểm thời gian |
| **R2** | Hoá đơn PDF, file Excel, ảnh SP, sao lưu NDJSON hằng ngày | Bucket private, chỉ Worker đọc/ghi |
| **Workers Static Assets** | React PWA | SPA fallback |
| **Cron Triggers** | Đánh dấu lô hết hạn 0h VN, sao lưu, dọn phiên | `scheduled.ts` |
| **Queues** (Đợt 2) | Gửi HĐĐT MISA, nhắc nợ, push | Retry + DLQ, không chặn quầy |
| **Durable Objects** (Đợt 3) | Đẩy trạng thái đơn online realtime, khoá phiên kiểm kê (EC-18) | |
| **Cloudflare Access** | Bảo vệ staging và trang quản trị | Zero Trust, miễn phí ≤50 người |

## 2. Nguyên tắc dữ liệu (ánh xạ quy tắc nghiệp vụ)

| Quy tắc tài liệu | Cách hiện thực |
|---|---|
| Không bán quá tồn, kể cả 2 người cùng bán (EC-02) | Phân bổ FEFO đọc trước, ghi bằng **một D1 batch**; ràng buộc `CHECK (qty_reserved ≤ qty_on_hand, qty_on_hand ≥ 0)` trên `lots` làm batch thứ hai rollback. D1 ghi tuần tự nên không có race. Đã có test. |
| FEFO, lô hết hạn không bán (M2-04) | `allocateFefo` sắp theo `expires_at`, loại lô hết hạn/không bán được |
| Không sửa tồn trực tiếp | Không có API sửa `lots`; mọi thay đổi qua `stock_docs` → `stock_moves` (bất biến bằng trigger) |
| Đơn đã chốt giữ giá | `order_lines.unit_price` lưu giá tại thời điểm bán |
| Lịch sử giá | Mỗi lần đổi giá = dòng mới trong `prices` với `effective_from/to` |
| Hoá đơn không xoá/sửa (EC-09) | Chỉ đổi trạng thái + chứng từ điều chỉnh; `audit_log` append-only |
| Khoá sổ (EC-33) | Trigger chặn insert/update `cash_vouchers` trong kỳ đã khoá → HTTP 423 |
| Mất mạng tại quầy (EC-04) | PWA xếp hàng đơn trong IndexedDB; `orders.client_uuid UNIQUE` → đồng bộ lại không trùng số |
| Giờ chấm công theo máy chủ (M9-12) | Mọi timestamp sinh ở server (UTC), ngày/kỳ tính theo UTC+7 |
| Tiền VND không làm tròn | Số nguyên VND; số lượng số nguyên milli (1 kg = 1000) — không dùng float |
| Ghi nhật ký thay đổi quan trọng | `auditStmt` nằm **trong cùng batch** với thay đổi → không có thay đổi nào thiếu nhật ký |

## 3. Cấu trúc mã

```
migrations/            schema D1 (đánh số, chỉ thêm, không sửa file cũ)
seed/seed.sql          dữ liệu mẫu
src/worker/
  index.ts             app Hono, security headers, mount route, scheduled
  env.ts               kiểu Env, Role, SessionUser
  lib/                 auth, rbac, audit, crypto, codes, errors, money, time
  services/            stock (FEFO), pricing (chọn giá EC-13)
  routes/              products, inventory, prices, pos, finance, reports, admin, auth
src/web/               React PWA (mobile-first)
test/                  vitest + @cloudflare/vitest-pool-workers (chạy trong workerd thật, D1 thật)
docs/                  API.md (hợp đồng), ARCHITECTURE.md, SECOPS.md
```

## 4. Lộ trình kỹ thuật theo đợt

| Đợt | Module | Bổ sung hạ tầng |
|---|---|---|
| 1 (tuần 2–3) | M1 quầy, M2, M3 cơ bản, M6 thu chi | Workers, D1, R2, Cron — **đang làm trong repo này** |
| 2 (tuần 4–5) | M4 B2B, M5 công nợ, nhóm giá sỉ, MISA, Excel, Fresco | Queues (MISA/Fresco), bảng `receivables/payables`, `reservations`, PDF báo giá bằng Browser Rendering |
| 3 (tuần 5–8) | M8 website + app khách | Worker riêng `shop` (public) tách khỏi ERP; Turnstile chống bot; cổng thanh toán [Cần xác nhận]; Durable Object realtime; Web Push |
| 4 (tuần 8–9) | M9 nhân sự/lương/chấm công, M7 giá đối thủ | Chấm công GPS/QR xoay vòng ký HMAC; M7 crawler theo Cron + giới hạn tốc độ, tôn trọng robots.txt |

**Mở rộng nhiều cửa hàng:** schema đã có `store_id`/`locations`; khi > vài cửa hàng hoặc > 10 GB thì tách D1 theo cửa hàng hoặc chuyển dữ liệu báo cáo sang Analytics Engine/R2 SQL.

## 5. Điểm cần chủ cửa hàng xác nhận ảnh hưởng thiết kế

1. Giá vốn theo **lô** hay **bình quân** (đang mặc định theo lô — `settings.costing.method`).
2. Có cần bán offline không (đang bật).
3. Ngưỡng duyệt: giảm giá %, phiếu chi, chênh lệch kiểm kê (đang để tạm trong `settings`).
4. Loại mã vạch nội bộ: đang dùng **Code128** dạng `HML00000123`.
5. Cân điện tử có kết nối điện thoại không (Web Bluetooth/Web Serial chỉ chạy trên Android Chrome).
6. App khách: PWA hay App Store/Google Play (ảnh hưởng Đợt 3).
