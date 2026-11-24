# CLAUDE.md — ERP Hữu Mạnh

Hệ thống ERP cho cửa hàng trái cây Hữu Mạnh gồm 9 module M1–M9. Có hai Worker:
- **ERP** (`huu-manh-erp`): API Hono trong `src/worker` và PWA React trong `src/web`.
- **Website bán hàng** (`huu-manh-shop`): API trong `src/shop/worker`, giao diện trong `src/shop/web`.

Nền tảng: Cloudflare Workers, D1 (SQLite), R2, Queues, Cron. Giao diện và tài liệu viết bằng **tiếng Việt**. Trả lời người dùng bằng tiếng Việt.

## Đọc trước khi làm

1. `docs/HANDOFF.md`: trạng thái dự án, việc còn lại, cách deploy.
2. `docs/WIP-UX-PC.md`: **việc đang dở** (giao diện PC, nhánh `ux-2b` và `ux-2c`).
3. `docs/UI-KIT.md`: bộ thành phần giao diện dùng chung (danh sách, bộ lọc, khung chi tiết).
4. `docs/GO-LIVE.md`: kế hoạch go-live.
5. `docs/audit/README.md`: lỗi nghiệp vụ còn tồn sau audit.
6. Hợp đồng API trong `docs/API*.md`. Tài liệu bảo mật trong `docs/SECOPS.md`.

## Plugin và skill nên cài (Claude Code)

Cài trong claude.ai → Settings → Plugins (Anthropic Directory). Với Claude Code CLI thì dùng lệnh `/plugin`.

| Plugin | Dùng khi | Skill chính |
|---|---|---|
| **Cloudflare** (Cloudflare, Anthropic Directory) | Mọi việc với Workers, D1, R2, Queues, wrangler, deploy | `wrangler`, `workers-best-practices`, `workers-development`, `cloudflare-email-service` (email thật), `turnstile-spin` (Turnstile thật), `web-perf` |
| **UI Design Review** (UXKIN) | Đợt hoàn thiện giao diện PC đang dở: rà màn hình trên điện thoại và máy tính, liệt kê việc cần sửa | `ui-review`, `ui-polish`, `ui-compare` |
| **Design** (Anthropic), tuỳ chọn | Rà khả năng tiếp cận (accessibility), câu chữ UI | `accessibility-review`, `ux-copy`, `design-critique` |

Skill có sẵn trong Claude Code, không cần cài:
- `/code-review`: rà diff trước khi mở PR.
- `/security-review`: bắt buộc khi đụng tới auth, quyền, tiền, webhook hoặc upload.
- `run`: chạy app để xem thay đổi thật.

Phần Cloudflare MCP chỉ cần nếu muốn thao tác tài nguyên Cloudflare trực tiếp. Deploy chạy qua GitHub Actions bằng token trong GitHub Secrets, không cần MCP.

## Lệnh thường dùng

```bash
npm ci --legacy-peer-deps          # cài (vitest 4.1.12 cần --legacy-peer-deps)
npx tsc --noEmit                   # kiểm tra kiểu
npx vitest run                     # ~640 test, chạy trên workerd + D1 thật
npm run build && npm run build:shop
```

E2E (Playwright, 10 bộ, mỗi bộ cần một DB mới): xem lệnh đầy đủ ở `docs/WIP-UX-PC.md` mục "Cách làm tiếp".

## Quy ước bắt buộc

- **Tiền:** số nguyên VND. **Số lượng:** số nguyên "milli" của đơn vị chính (1 kg = 1000). **Thời gian:** lưu UTC, còn ngày/kỳ tính theo giờ VN (UTC+7), dùng helper trong `src/worker/lib/time.ts`.
- **Ghi dữ liệu:** mọi thao tác ghi nhiều dòng phải nằm trong **một** `db.batch([...])` kèm `auditStmt`.
  - Thao tác kiểu "kiểm tra rồi làm" có ảnh hưởng tới tiền hoặc kho: đặt `assertStmt(...)` ở đầu batch.
  - Thao tác chỉ được làm một lần: dùng `onceStmt(...)` (xem `src/worker/services/guard.ts`).
  - Lý do: một `UPDATE` khớp 0 dòng **không** làm batch thất bại.
- **Bảng bất biến:** `audit_log`, `stock_moves`, `attendance_punches`, `loyalty_ledger`, `purchase_cost_adjustments`. Hoá đơn đã phát hành, kỳ đã khoá và lương đã duyệt cũng không được sửa. Muốn sửa thì tạo chứng từ đảo hoặc điều chỉnh.
- **Phân quyền:** mặc định từ chối. Mọi route mới phải có `requirePerm(...)` và validate bằng zod. Không bao giờ lộ giá vốn hoặc lương cho vai trò không có quyền.
- **Khoá sổ:** dùng `assertPeriodOpen` trong `src/worker/services/period.ts` cho mọi chứng từ có ngày.
- **Migration:**
  - Thêm file mới `migrations/NNNN_*.sql`, đánh số tiếp theo; không sửa file cũ.
  - Khi `INSERT` danh mục có id cố định, dùng id ≥ 900 để không trùng seed.
- **Tham số mới:** khi thêm khoá vào bảng `settings` thì phải khai báo trong `src/worker/services/settings-registry.ts`, nếu không test `settings-ui` sẽ báo thiếu.
- **Giao diện:**
  - Dùng bộ thành phần trong `src/web/components` (xem `docs/UI-KIT.md`).
  - Thiết kế phải đẹp ở cả 390px và 1440–1920px.
  - Chụp ảnh và **tự xem lại** trước khi coi là xong.
- **Bí mật:** không đưa token hay mật khẩu vào code, tài liệu hoặc commit. CI chạy gitleaks. Trong lệnh mẫu, dùng biến môi trường như `$BOOTSTRAP_TOKEN`.

## Bẫy đã gặp

- `@cloudflare/vite-plugin` chọn môi trường **lúc build** (`CLOUDFLARE_ENV=demo npm run build`). Tham số `wrangler deploy --env` bị bỏ qua.
- `wrangler dev` phục vụ bản **đã build**. Sửa code xong phải chạy `npm run build` trước khi khởi động lại.
- E2E: mỗi bộ chạy trên DB mới. Bộ b2b cần font BeVietnamPro trên R2 local (để in PDF). Bộ hr cần toạ độ cửa hàng.
- Không dùng `git stash` khi có agent khác làm việc song song. Dùng `git worktree` cho mỗi nhánh.

## Git, PR, deploy

- Làm trên nhánh riêng, mở PR vào `main` và chờ CI xanh (typecheck, vitest, `npm audit`, gitleaks) rồi mới gộp.
- **Bản demo** (`huumanh.noxelis.co`, `huumanhfruit.noxelis.co`): deploy bằng cách **tạo tag `demo-YYYY-MM-DD` trên GitHub** (Releases → Draft a new release). Phiên Claude Code trên cloud không tạo tag được, nên bước này do người làm.
- **Production:** chưa có. Làm theo `docs/GO-LIVE.md`, dùng D1/R2 production mới và **không** nạp `seed/*.sql`.
- Có thể chia việc cho agent con: Opus điều phối, Sonnet thực thi theo hướng dẫn, Haiku làm việc ít suy luận (seed, README).
