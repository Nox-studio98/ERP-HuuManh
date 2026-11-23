# Kế hoạch SecOps — Hữu Mạnh ERP

Mục tiêu: bảo vệ **tiền** (đơn, thu chi, công nợ), **tồn kho**, **dữ liệu cá nhân** (khách hàng, lương nhân viên) và **tính liên tục** của quầy bán. Tuân thủ Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân.

## 1. Mô hình mối đe doạ (rút gọn)

| # | Mối đe doạ | Tác động | Biện pháp | Trạng thái |
|---|---|---|---|---|
| T1 | Nhân viên gian lận: huỷ đơn sau khi thu tiền, giảm giá trái phép, sửa tồn | Mất tiền/hàng | RBAC deny-by-default; void/giảm giá/dưới vốn cần duyệt; không có API sửa tồn; `audit_log` + `stock_moves` bất biến; báo cáo chênh lệch ca (EC-32) | ✅ Đợt 1 |
| T2 | Lộ/đoán mật khẩu, dò tài khoản | Chiếm quyền | PBKDF2-SHA256 100k vòng; khoá 15' sau 5 lần sai; phản hồi đồng thời gian cho user không tồn tại; mật khẩu ≥10 ký tự; đổi MK thu hồi phiên khác | ✅ |
| T3 | Đánh cắp phiên (XSS, mạng công cộng) | Chiếm quyền | Cookie `__Host-` HttpOnly Secure SameSite=Strict; token chỉ lưu SHA-256; CSP `default-src 'self'`, không script inline; HSTS preload | ✅ |
| T4 | CSRF | Thao tác giả mạo | SameSite=Strict + bắt buộc header `X-Requested-With` cho request ghi dùng cookie | ✅ |
| T5 | IDOR / leo thang quyền | Xem lương, PII, số liệu tài chính | `requirePerm` ở mọi route; che SĐT theo quyền; lương chỉ chủ + kế toán (Đợt 4) ; test phân quyền cho từng module | ✅ / Đợt 4 |
| T6 | SQL injection | Lộ/sửa dữ liệu | 100% prepared statement `.bind()`; zod validate đầu vào; tên bảng chỉ từ hằng số | ✅ |
| T7 | Chấm công hộ / giả GPS | Trả lương sai | Thiết bị đăng ký (`devices`), đổi máy cần duyệt; QR tại cửa hàng xoay vòng 30s ký HMAC; giờ máy chủ; chấm offline → chờ duyệt | Đợt 4 |
| T8 | Bot/DDoS/credential stuffing vào website khách | Gián đoạn, gian lận đơn | Cloudflare WAF Managed Rules, Rate Limiting `/api/auth/login` (10 req/phút/IP), Turnstile trên đăng ký/đặt hàng, Bot Fight Mode | Cấu hình khi deploy / Đợt 3 |
| T9 | Lộ secret (API MISA, cổng TT, token Cloudflare) | Xuất HĐ giả, mất tiền | `wrangler secret`, không commit `.dev.vars`; token Cloudflare scope tối thiểu, lưu GitHub Secrets; gitleaks trong CI; xoay vòng 90 ngày | Một phần |
| T10 | Webhook giả (cổng thanh toán, Fresco, sao kê ngân hàng) | Ghi nhận tiền chưa về (EC-05) | Xác thực chữ ký HMAC + timestamp ±5', idempotency key, đối chiếu sao kê trước khi giao | Đợt 2–3 |
| T11 | Mất dữ liệu / ransomware / lỗi người | Gián đoạn | D1 Time Travel 30 ngày; sao lưu NDJSON R2 hằng ngày (bỏ pass_hash); R2 bucket lock/versioning; diễn tập khôi phục hằng quý | ✅ cơ bản |
| T12 | Chuỗi cung ứng npm | Mã độc | lockfile, `npm audit` + Dependabot, gói tối thiểu, pin version | CI |
| T13 | Nhân viên nghỉ việc vẫn đăng nhập (EC-39) | Truy cập trái phép | Khoá tài khoản thu hồi ngay mọi phiên; giữ lịch sử | ✅ |

## 2. Kiểm soát đã có trong mã (Đợt 1 + Đợt 2)

- `src/worker/lib/auth.ts`, `routes/auth.ts`: phiên, khoá tài khoản, bootstrap chủ cửa hàng một lần bằng secret.
- `src/worker/lib/rbac.ts`: ma trận quyền theo mục 12 tài liệu nghiệp vụ.
- `src/worker/index.ts`: CSP, HSTS, X-Frame-Options (frame-ancestors none), Permissions-Policy (chỉ camera + vị trí cho chính app), giới hạn body 1 MB, `Cache-Control: no-store` cho API, lỗi không lộ stack/SQL kèm `requestId`.
- `migrations/0001_init.sql`: trigger bất biến cho `audit_log`, `stock_moves`; trigger khoá sổ; ràng buộc CHECK tồn kho.
- `scheduled.ts`: sao lưu hằng ngày ra R2.
- **Đợt 2:**
  - Webhook Fresco (`routes/webhooks.ts`): HMAC-SHA256 so sánh hằng thời gian, cửa sổ thời gian ±300s, chống phát lại qua `webhook_events(source,event_id)`, tắt mặc định (`fresco.enabled=0` → 404), giới hạn kích thước body.
  - Outbox (`integration_jobs`): không gọi API ngoài trong request; retry có backoff, sau 5 lần → `dead` + audit; lỗi lưu tối đa 500 ký tự và không chứa secret. Endpoint cài đặt tích hợp chỉ trả `misaConfigured: true/false`.
  - Hoá đơn đã phát hành không sửa/xoá (trigger DB, EC-09); điều chỉnh bằng hoá đơn `adjustment`.
  - Hạn mức nợ kiểm **trước** khi giữ hàng (EC-23); chỉ chủ (`b2b.credit_override`) duyệt vượt hạn mức; xoá nợ cần `debt.approve` (chỉ chủ).
  - Số dư đầu kỳ công nợ khoá vĩnh viễn sau khi nhập.
  - Xuất Excel ghi audit `export.<tên>` (phát hiện rò rỉ dữ liệu khách/công nợ).

## 3. Cấu hình Cloudflare khi deploy (checklist)

- [ ] Gắn tên miền riêng (vd `erp.huumanh.vn`), tắt `workers_dev` ở production.
- [ ] SSL/TLS: Full (strict), Min TLS 1.2, Always Use HTTPS, HSTS.
- [ ] WAF: bật Cloudflare Managed Ruleset + OWASP Core Ruleset.
- [ ] Rate limiting: `/api/auth/login` 10 req/phút/IP → block 10'; `/api/v1/*` 300 req/phút/IP.
- [ ] Cloudflare Access: bảo vệ toàn bộ staging; tuỳ chọn bảo vệ `/admin` production theo email chủ + kế toán.
- [ ] Geo: chỉ cho phép VN cho ERP nội bộ (ngoại lệ khi chủ đi nước ngoài qua Access).
- [ ] API token deploy: chỉ quyền Workers Scripts:Edit, D1:Edit, R2:Edit trên đúng account; IP filtering nếu dùng runner cố định.
- [ ] Bật Workers Logs/Observability; Logpush (gói trả phí) hoặc tail log về R2.
- [ ] Notifications: cảnh báo lỗi 5xx tăng, WAF events, thay đổi DNS, đăng nhập dashboard Cloudflare.
- [ ] Bật 2FA cho mọi tài khoản Cloudflare, GitHub, MISA, ngân hàng.

## 4. Pipeline DevSecOps (đề xuất `.github/workflows/ci.yml`)

1. `npm ci` → `tsc --noEmit` → `vitest run` (gồm test phân quyền và EC Critical).
2. `npm audit --audit-level=high`, gitleaks (quét secret), Semgrep ruleset `p/typescript` + rule tuỳ chỉnh: cấm nối chuỗi vào `prepare()`, bắt buộc `requirePerm` trên route mới.
3. Deploy staging tự động khi merge `main` (`wrangler deploy --env staging` + `d1 migrations apply --env staging --remote`).
4. Production chỉ khi tạo tag `v*` + duyệt thủ công (GitHub Environments) → migrations → deploy → smoke test `/api/health`. Rollback: `wrangler rollback` + D1 Time Travel.

## 5. Giám sát & phát hiện (SecOps vận hành)

| Tín hiệu | Nguồn | Ngưỡng cảnh báo |
|---|---|---|
| Đăng nhập sai liên tục, tài khoản bị khoá | `audit_log` action `auth.login_failed` | >20/giờ toàn hệ thống |
| Huỷ đơn / trả hàng bất thường theo nhân viên | `orders.voided_by`, kind=return | >3 lần/ca hoặc > 2σ so với trung bình |
| Chênh lệch tiền mặt cuối ca | `shifts.diff_cash` | ≠0 lặp lại 3 ca liên tiếp cùng người |
| Hao hụt vượt 5% | `stock_docs` waste | theo quy tắc nghiệp vụ |
| Bán dưới giá vốn được duyệt | `approvals` type order.below_cost | báo cáo tuần cho chủ |
| Truy cập dữ liệu lương / PII | `audit_log` (Đợt 4) | mọi lần xem ngoài giờ |
| 5xx, độ trễ quầy > 2s | Workers Observability | p95 > 2s trong 5' |

Đề xuất: Cron hằng ngày tổng hợp các tín hiệu trên thành "Báo cáo an ninh & gian lận" gửi chủ cửa hàng qua email (Cloudflare Email Service) — Đợt 2.

## 6. Ứng phó sự cố (runbook rút gọn)

1. **Phát hiện** → ghi nhận thời điểm, `requestId`, tài khoản liên quan.
2. **Cô lập**: khoá user (`PUT /users/:id active=0` thu hồi phiên ngay), xoay secret bị lộ (`wrangler secret put`), bật "Under Attack Mode" nếu bị DDoS.
3. **Điều tra**: `audit_log`, `stock_moves`, `scan_events`, Workers Logs theo `requestId`.
4. **Khôi phục**: `wrangler d1 time-travel restore` về trước sự cố (thử trên bản sao trước), hoặc nạp lại từ R2 backup.
5. **Thông báo**: nếu lộ dữ liệu cá nhân → báo Bộ Công an (A05) trong 72 giờ theo NĐ 13/2023, thông báo người bị ảnh hưởng.
6. **Rút kinh nghiệm**: bổ sung test/quy tắc phát hiện.

## 7. Bảo vệ dữ liệu cá nhân (NĐ 13/2023)

- Thu thập tối thiểu; thông báo rõ cho nhân viên về vị trí chỉ ghi lúc chấm công (đã có trong tài liệu nghiệp vụ).
- PII khách và lương: chỉ vai trò có quyền; mọi lần xem/sửa lương ghi nhật ký.
- Lưu trữ: dữ liệu tại Cloudflare (D1 có thể chọn location hint `apac`); ghi trong hợp đồng/điều khoản.
- Quyền của chủ thể: xuất/xoá dữ liệu khách theo yêu cầu (ẩn danh hoá, giữ chứng từ kế toán theo luật 10 năm).

## 8. Lịch SecOps định kỳ

| Tần suất | Việc |
|---|---|
| Hằng ngày | Sao lưu R2 (tự động); xem báo cáo gian lận |
| Hằng tuần | Duyệt cảnh báo WAF, `npm audit`, review approvals dưới vốn |
| Hằng tháng | Rà soát tài khoản & quyền (ai nghỉ việc, ai đổi vai trò) |
| Hằng quý | Diễn tập khôi phục từ backup; xoay vòng token/secret; pentest nhẹ (OWASP ASVS L1) |
| Trước mỗi đợt go-live | Security review diff, kiểm thử phân quyền, quét DAST (OWASP ZAP) trên staging |
