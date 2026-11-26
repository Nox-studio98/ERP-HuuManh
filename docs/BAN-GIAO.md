# Bàn giao công việc — ERP Hữu Mạnh (26/11/2026)

Tài liệu này dành cho **người/tài khoản tiếp nhận** (kể cả một phiên Claude Code mới). Đọc file này trước, rồi mới tới `CLAUDE.md` và `docs/HANDOFF.md` (trạng thái tổng thể dự án).

---

## 1. Trạng thái nhanh

| Hạng mục | Trạng thái | Ở đâu |
|---|---|---|
| `main` | Gồm mọi thứ tới PR #20 (chọn ngân hàng SePay) | `origin/main` |
| **Bảng chấm công dạng lưới (kiểu KiotViet)** | ✅ Xong, **CI xanh, chờ chủ dự án đồng ý gộp** | PR [#21](https://github.com/Nox-studio98/ERP-HuuManh/pull/21), nhánh `claude/hr-board` |
| Nhập nhanh đơn sỉ (Zalo + bảng nhiều chi nhánh + đọc ảnh) | ⏸ **Làm sau** — chỉ làm khi mọi phần khác đã sửa chuẩn; hiện có thiết kế + PoC, chưa code | nhánh `claude/zalo-order-design` (`docs/ZALO-ORDER.md`, `docs/concept-nhap-nhanh-don-si.html`, `tools/ocr-poc/`) — chưa có PR |
| Bán hàng tại quầy theo KiotViet | ⏸ **Tạm dừng** theo yêu cầu, chỉ có kế hoạch | `docs/POS-KV.md` (nhánh này) |
| Tài liệu bàn giao (file này, hướng dẫn Bảng chấm công, script E2E) | Nhánh `claude/pos-kv` | PR tài liệu |
| Bản demo | Chưa có PO/NCC, SePay, ngân hàng, Bảng chấm công — cần **tạo release** | xem mục 6 |

Kiểm thử ở thời điểm bàn giao (nhánh `claude/hr-board`): `tsc` sạch, **881 test vitest đạt**, E2E `hr`, `hr-swap`, `hr-board` (mới), `settings` đạt trên DB mới.

---

## 2. Việc tiếp theo (theo thứ tự ưu tiên)

### 2.1 Gộp PR #21 — Bảng chấm công
- Chờ chủ dự án nói "gộp". Không tự gộp.
- Sau khi gộp: tạo release `demo-YYYY-MM-DD` để đưa lên demo (mục 6). Kiểm tra trên demo: menu Nhân sự → **Bảng chấm công**.
- Tài liệu: `docs/API-attendance-board.md` (hợp đồng + quy tắc tính công), `docs/HUONG-DAN-BANG-CHAM-CONG.md` (hướng dẫn cho quản lý cửa hàng).
- Quyết định đã chốt: khi bật "tự tính làm thêm" mà có cả đơn tăng ca đã duyệt cùng ngày → lấy **số lớn hơn**, không cộng dồn (chủ dự án đồng ý 26/11).
- PR này cũng sửa `e2e/settings.mjs` (đếm 11 nhóm tham số). Trên `main` bộ này đang **hỏng sẵn** từ PR SePay (đếm 9 trong khi đã có 10).

### 2.2 Sửa chuẩn những gì đang có (ưu tiên trước mọi tính năng mới)
Theo yêu cầu chủ dự án: hoàn thiện và sửa chuẩn hệ thống hiện tại trước. Nguồn việc:
- Lỗi nghiệp vụ trung bình/thấp còn lại sau audit: `docs/audit/README.md` (mục Trạng thái sửa).
- `HANDOFF.md` mục 3.2 (giả định cần xác nhận: MISA, Fresco, email thật, push…) và mục 3.4 (tham số "Cần xác nhận").
- Chạy đủ **mọi bộ E2E** trên DB mới sau khi gộp #21 (trên `main` bộ `settings` đang hỏng sẵn, đã sửa trong #21) và rà ảnh các màn chính ở 1440/390.
- Đưa bản mới lên demo (mục 6) để chủ dự án/khách kiểm tra, ghi lại lỗi phát hiện.

### 2.2b Đối chiếu toàn bộ với KiotViet — danh sách việc nên cải thiện
`docs/KIOTVIET-DOI-CHIEU.md`: Kết ca (phiếu bàn giao in được, lịch sử ca, tổng kết theo hình thức thanh toán), **Khách lẻ** (chưa có màn quản lý trong ERP — khoảng trống lớn nhất), báo cáo cuối ngày, trả hàng nhanh, trả hàng NCC, xuất dùng nội bộ, hoa hồng, mẫu in… kèm thứ tự gợi ý. Làm **sau** mục 2.2.

### 2.3 Bán hàng tại quầy theo KiotViet — tạm dừng
Kế hoạch đầy đủ ở `docs/POS-KV.md` (đợt A: tab nhiều hoá đơn, lưới ảnh + nhóm hàng, **máy quét mã vạch tuỳ chọn**, người bán khác thu ngân, sao chép hoá đơn, lọc/in lại/chia sẻ; đợt B: bán nợ + QR thu nợ bán lẻ, sửa hoá đơn bằng chứng từ đảo, thu khác, …). Chỉ làm khi chủ dự án bảo làm tiếp. Số migration trong tài liệu là dự kiến — kiểm tra `migrations/` lúc làm.

### 2.4 SePay chạy thật (việc của chủ cửa hàng)
Đã tích hợp và thử trên **sandbox** (QR đơn web, thu nợ sỉ, QR tại quầy; chống trùng; sai tiền → danh sách chưa khớp/hoàn). Các bước chủ cửa hàng phải làm: `docs/SEPAY.md` (liên kết tài khoản, cấu trúc mã thanh toán DH/HDS/POS, webhook, secret `SEPAY_WEBHOOK_SECRET`, chuyển thử). Chưa làm: tự thêm `SEVQR` cho VietinBank cá nhân; xử lý tài khoản ảo (VA).

### 2.5 PO tự động + cổng nhà cung cấp — đã gộp (PR #19)
Chờ khách trả lời: `po.horizon_days` (đang 2), `approval.po_vnd` (đang 20.000.000), NCC có cần thông báo email/Zalo không.

### 2.6 Go-live
Theo `docs/GO-LIVE.md` và `docs/HANDOFF.md` mục 3.1. Production chưa có; dùng D1/R2 production mới, **không** nạp `seed/*.sql`.

### 2.7 (LÀM SAU) Nhập nhanh đơn sỉ — khách chuỗi gửi ảnh bảng hằng ngày
> **Chủ dự án (26/11/2026): làm sau, khi mọi thứ khác đã sửa chuẩn.** Không bắt đầu phần này trước. Lịch thử lại PoC tự động đã huỷ.

Đọc `docs/ZALO-ORDER.md` trên nhánh `claude/zalo-order-design`:
- Mục 1–8: dán tin nhắn Zalo ("Bún : 1,5kg / Đậu : 6 bìa …") vào màn Tạo đơn sỉ → tự nhận sản phẩm, đơn vị, số lượng; nút tạo nhanh sản phẩm chưa có.
- Mục 9.1–9.6: bảng hàng × chi nhánh → một đơn cho mỗi chi nhánh (địa chỉ giao), **công nợ và hoá đơn VAT theo công ty**, bill riêng từng cơ sở.
- Mục 9.7: chi nhánh tự đặt — **tạm dừng** (khách không đổi quy trình).
- **Mục 9.8 (hướng chính): đọc ảnh bằng Cloudflare Workers AI** — PoC đạt 99,6–100% ô đúng, 0 ô sai lọt, ~150 neuron/ảnh. Mã thử ở `tools/ocr-poc/` (README trong đó).
- Trang concept (mở bằng trình duyệt): `docs/concept-nhap-nhanh-don-si.html`.

Việc còn lại trước khi code:
1. Chủ dự án gom **5–10 ảnh thật** của khách → chạy `tools/ocr-poc/pipeline.py` (ảnh khách **không** đưa vào repo).
2. Chạy nốt 4 biến thể ảnh chưa thử (mục 9.8). Ngày 26/11 Workers AI báo hết 10.000 neuron ngay sau giờ đặt lại → khi làm tiếp, **kiểm tra dashboard Cloudflare → Workers AI** xem có gì khác đang dùng hạn mức.
3. Gửi khách các câu hỏi ở mục 11 của `ZALO-ORDER.md`.
4. Khi bắt tay code: thêm binding `AI` cho Worker ERP; màn thiết lập "mẫu bảng" theo khách (vạch cột); màn duyệt kết quả (tô dòng "cần xem"); giới hạn số ảnh/ngày.

---

## 3. Quyết định đã chốt trong đợt 25–26/11/2026
- Chấm công: một màn **Bảng chấm công** thay "Lịch ca" + "Duyệt chấm công" (hai màn cũ vẫn mở bằng đường dẫn `/hr/schedule`, `/hr/approvals`). Làm cả 4 nhóm tính năng nâng cao. Làm thêm tự tính + đơn tăng ca → lấy số lớn hơn.
- Máy quét mã vạch: **tuỳ chọn**, bật/tắt theo từng máy, không phụ thuộc (khi làm POS-KV).
- Đọc ảnh đơn hàng: **Cloudflare Workers AI, model Gemma 4** (`@cf/google/gemma-4-26b-a4b-it`), không dùng DeepSeek/Qwen API ngoài. Clairic quá đắt; DeepSeek V4.1/Inkling cần gói Workers Paid (chưa thử).
- Chi nhánh tự đặt trên cổng khách sỉ: tạm dừng.
- Nhập đơn từ ảnh / Zalo: **làm sau**, khi mọi phần khác đã sửa chuẩn (26/11).
- Bán hàng theo KiotViet: tạm dừng, đã ghi kế hoạch.
- Trước đó (xem `HANDOFF.md`, `SEPAY.md`, `PO-NCC.md`): SePay chỉ webhook, đúng số tiền, tiền về muộn → danh sách hoàn; mã đơn web `DH`+số; PO chốt đêm 03:00 + "Chốt ngay", quản lý duyệt; cổng NCC ở `/ncc` của website; quản lý xem được **tổng** lương trong báo cáo, lương từng người chỉ chủ + kế toán.

## 4. Câu hỏi đang chờ khách hàng
- `ZALO-ORDER.md` mục 11 (cách viết tin nhắn, tên gọi khác của hàng, danh sách chi nhánh ↔ địa chỉ, cách xuất hoá đơn công ty).
- PO: số ngày gom (`po.horizon_days`), ngưỡng chủ duyệt PO (`approval.po_vnd`), thông báo cho NCC.
- Các mục "Cần xác nhận" trong Cài đặt (`HANDOFF.md` mục 3.4), nay thêm nhóm **Chấm công** (chế độ theo ca/khung giờ, ân hạn về sớm, làm thêm tự động, quy đổi công, tự chấm công).

---

## 5. Chuyển sang tài khoản / phiên mới — cần thiết lập lại

Những thứ **không đi theo repo** (gắn với tài khoản/phiên cũ):

| Thứ | Cách làm lại |
|---|---|
| Quyền GitHub vào `Nox-studio98/ERP-HuuManh` | Kết nối GitHub + cài Claude GitHub App cho repo trên tài khoản mới |
| Môi trường cloud (mạng) | Tạo môi trường riêng cho repo, cho phép các host: `developer.sepay.vn`, `my.sepay.vn`, `cli-api.sepay.vn`, `cli-api-sandbox.sepay.vn`, `userapi-sandbox.sepay.vn`, `ssehub-sandbox.sepay.vn` (SePay), `vietqr.app` (danh sách mã BIN), `www.kiotviet.vn`, `cdn-kvweb.kiotviet.vn` (chỉ khi cần đọc lại hướng dẫn KiotViet). Gói npm mặc định đã được phép. |
| Token Cloudflare cho Workers AI (PoC đọc ảnh) | Tạo API token mới (quyền **Workers AI: Read/Edit**, giới hạn đúng account) và lưu làm *network secret* cho host `api.cloudflare.com` qua form bảo mật của phiên — **không dán vào chat, không đưa vào code**. Account ID lấy bằng `GET /client/v4/accounts`. |
| Token deploy (GitHub Actions) | Đã nằm trong GitHub Secrets của repo (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) — không cần làm lại |
| SePay CLI (sandbox) | `npx sepay-cli@0.1.9 login` (đăng nhập bằng mã thiết bị, phạm vi mặc định), rồi `sandbox init`. Dữ liệu sandbox cũ nằm ở tài khoản SePay của chủ dự án |
| `.dev.vars` (dev local) | Không có trong repo. Tạo file `.dev.vars` ở gốc repo với các biến dev, tối thiểu `BOOTSTRAP_TOKEN=<giá trị tuỳ ý cho dev>`; có thể thêm `ATTENDANCE_QR_SECRET`, `SEPAY_WEBHOOK_SECRET` (giá trị dev). |
| Trang concept trên claude.ai (artifact) | Riêng tư theo tài khoản cũ. Bản HTML đã lưu ở `docs/concept-nhap-nhanh-don-si.html` |
| Lịch hẹn của phiên cũ | Đã huỷ hết (không còn lịch tự chạy nào) |
| Tag/release demo | Phiên Claude Code cloud **không tạo được tag** (403) → người tạo trên GitHub |

Cài đặt lần đầu trong phiên mới:
```bash
npm ci --legacy-peer-deps
```
```bash
npx tsc --noEmit && npx vitest run
```

---

## 6. Deploy bản demo
GitHub → Releases → *Draft a new release* → tag mới `demo-YYYY-MM-DD` (vd `demo-2026-11-26`) từ `main` → Publish. Job `deploy-demo` tự áp migration, tải font, deploy ERP (`huumanh.noxelis.co`) và website (`huumanhfruit.noxelis.co`). Bản demo hiện **chưa** có các PR #18–#21.

---

## 7. Cách làm việc đã dùng (nên giữ)
- **Hợp đồng trước, code sau**: với tính năng lớn, viết `docs/API-*.md` + migration trước, rồi chia việc: một agent backend, một agent frontend chạy song song theo hợp đồng; người điều phối ghép, chạy test, xem ảnh.
- **Mỗi agent một `git worktree`**, người điều phối tạo worktree từ đúng commit (agent tự tạo hay lấy nhầm `main`). Liên kết `node_modules` từ checkout chính. Không dùng `git stash`.
- Agent: Sonnet thực thi, Opus điều phối. Agent có thể dừng giữa chừng vì **giới hạn 5 giờ** của tài khoản — gửi tin nhắn cho agent đó để chạy tiếp, không tạo agent mới.
- **E2E trên DB mới**: `npm run build` rồi `bash scripts/e2e-db.sh .wrangler/<thư mục> <cổng>` (dựng DB, chạy server, tạo tài khoản chủ), rồi `BASE=http://localhost:<cổng> PERSIST=.wrangler/<thư mục> SHOTS=0 node e2e/<bộ>.mjs`. Mỗi bộ một DB.
- Giao diện: chụp 1440 và 390 (thêm 1920 nếu đổi bố cục lớn) và **tự xem từng ảnh** trước khi coi là xong.
- Sau mỗi `git push`, kiểm tra `git ls-remote origin <nhánh>` khớp `git rev-parse HEAD` (từng có lần push im lặng không lên vì sai tên nhánh).
- Mở PR khi E2E xong; theo dõi CI; **chỉ gộp khi chủ dự án nói**.

## 8. Bẫy mới gặp (bổ sung cho `CLAUDE.md`)
- `wrangler dev -c dist/huu_manh_erp/wrangler.json` đọc `.dev.vars` **trong `dist/huu_manh_erp/`**, không phải gốc repo → thiếu thì `POST /api/auth/bootstrap` trả 404. `scripts/e2e-db.sh` đã tự chép.
- gitleaks báo nhầm mật khẩu giả trong test → đưa vào hằng số (`test/ncc-helpers.ts`) và thêm fingerprint vào `.gitleaksignore`.
- Workers AI: model có suy luận (Gemma 4, Qwen 3.8) mặc định suy nghĩ hết `max_tokens` → trả rỗng; truyền `reasoning_effort: "none"`. Mỗi ảnh bị co về ~440 token ảnh dù phóng to → phải **cắt dải**.
- Hạn mức Workers AI miễn phí tính chung cả account; một lần thử Clairic tốn ~1,3 triệu token (báo 0 neuron trong response nhưng vẫn trừ hạn mức).
- Thêm nhóm tham số mới trong `settings-registry.ts` → nhớ sửa số nhóm trong `e2e/settings.mjs`.
