# Audit R2 — Website bán hàng (`src/shop/worker`) + cổng NCC + phần ERP liên quan

Ngày 28/11/2026, nhánh `claude/audit2-shop` (mã = `main` sau PR #23). Chỉ đọc mã + probe test, không sửa mã ứng dụng.
Probe: `test/probe-s-shop.test.ts` (5 test, **cả 5 đều tái hiện được**; chạy `npx vitest run test/probe-s-shop.test.ts`). Không commit.

## Tóm tắt

| # | Mức | Phát hiện | Tái hiện |
|---|---|---|---|
| S-1 | **Cao** | Tài khoản đăng nhập (kể cả chưa xác minh email) đặt COD không giới hạn, không Turnstile, không bao giờ tự huỷ → giữ tồn và chiếm khung giờ vô hạn | P1 ✅ |
| S-2 | Trung bình | A-24: đơn khách vãng lai gắn vào hồ sơ cũ cùng SĐT → các thông báo trạng thái (kể cả link xác nhận cân lại) gửi tới **email của hồ sơ cũ**, không tới người mua | P2 ✅ |
| S-3 | Trung bình | NĐ13: xoá tài khoản đã liên kết khách sỉ không ẩn danh hồ sơ khách lẻ tạo lúc đăng ký (tên/SĐT/email còn nguyên, `active=1`) | P5 ✅ |
| S-4 | Thấp | Luồng huỷ ở shop (khách tự huỷ, từ chối cân lại) không dọn như `cancelOrder` của ERP: `so_shortages` còn `open`, `diff_status` còn `pending`, bỏ qua chính sách phí giao A-28 | P3, P4 ✅ |
| S-5 | Thấp | Rate limit checkout 120/phút (tài liệu ghi 20/phút); `limitBy` là mã chết | đọc cấu hình |
| S-6 | Thấp | Khoá `online.max_open_orders_per_phone`, `online.cod_unconfirmed_hours` không khai báo trong `settings-registry.ts` → không chỉnh được ở màn Cài đặt | đọc mã |

Không tìm thấy lỗi nghiêm trọng. Các mảng **đã rà và không thấy lỗi thật**: tính lại giá server-side + EC-11, voucher/điểm đồng thời (guard per-customer/per-phone, CHECK `used_count`, trigger điểm không âm, trigger 0007/0037 hoàn voucher/điểm khi huỷ), sức chứa khung giờ (`slotCapacityGuard` đầu batch, cùng cách đếm A-18), giờ chốt/ngày đã qua, đặt trước, idempotent `clientUuid`, mã `DH` + SePay (khớp theo `code`, so đúng số tiền intent, đơn huỷ/hết hạn → `refund_pending`, claim có điều kiện, khoản chờ), huỷ tự động 30 phút, IDOR đơn/địa chỉ/transfer (`shop_account_id`, token + 4 số), CSRF (header + SameSite), không mở CORS, lỗi 500 không lộ chi tiết, cổng sỉ (giá theo bảng b2b, không truyền giá/override từ client, clientUuid của khách khác → 409), cổng NCC (mọi truy vấn lọc `supplier_id` của phiên, `ownPo` 404 đồng nhất, lời mời băm + một lần + thu hồi, `version` + `assertStmt` cho phản hồi PO, không lộ SKU/ghi chú dòng/người lập/quỹ).

---

## S-1 (Cao) — COD của tài khoản đăng nhập không có trần, không tự huỷ

**Vị trí**
- `src/shop/worker/routes/checkout.ts:103` — Turnstile chỉ với khách vãng lai (`if (!account)`).
- `src/shop/worker/routes/checkout.ts:121` và `:206-209` — trần `online.max_open_orders_per_phone` (đơn `new/awaiting_payment` trong 24h) chỉ áp khi `!account`.
- `src/shop/worker/lib/cod-expiry.ts:20` — cron huỷ COD chưa xác nhận chỉ quét `shop_account_id IS NULL`.
- `src/shop/worker/lib/session.ts:40` — `emailVerified` được nạp nhưng không nơi nào kiểm (đăng nhập/checkout không cần xác minh email).

**Kịch bản**: bot đăng ký 1 tài khoản (chỉ cần qua Turnstile một lần, email bất kỳ không cần xác minh) → gọi `POST /api/checkout` COD liên tục (giới hạn chung 120/phút/IP, xem S-5), mỗi đơn giữ tồn FEFO và chiếm 1 chỗ khung giờ. Đơn ở `new` mãi mãi (cron 72h bỏ qua), tồn online về 0 và khung giờ đầy cho khách thật đến khi nhân viên huỷ tay từng đơn.

**Probe P1**: tài khoản chưa xác minh đặt 6 đơn COD 10 kg cùng SĐT (trần = 3) với `APP_ENV=production` → cả 6 đơn 201, `qty_reserved` tăng 60 kg; `cancelStaleCodOrders(now + 10 ngày)` không huỷ đơn nào.

**Đề xuất**: áp trần đơn mở cho mọi đơn COD (theo `shop_account_id` và theo SĐT), hoặc trần riêng cho tài khoản chưa xác minh email; cron COD áp cả tài khoản (có thể ngưỡng giờ dài hơn); cân nhắc bắt buộc xác minh email (hoặc Turnstile) trước đơn COD đầu tiên.

## S-2 (Trung bình) — Thông báo đơn khách vãng lai gửi nhầm người (A-24)

**Vị trí**
- `src/shop/worker/routes/checkout.ts:162-170` — khách vãng lai dùng lại `customers` loại retail đầu tiên có cùng SĐT người nhận (có thể là hồ sơ của **người khác**: số điện thoại tái cấp, người thân, hoặc hồ sơ tạo khi một tài khoản đăng ký). Email người mua (`b.email`) **không được lưu** vào đơn hay hồ sơ; chỉ đi trong payload của job đầu tiên (`:265`), và bị bỏ nếu mailguard chặn.
- `src/worker/services/notify.ts:50-52` — mọi thông báo sau (ERP xác nhận, soạn, giao, **cân lại `weight_pending`**, huỷ do cron) không có `payload.email` → rơi về `customers.email` của hồ sơ cũ.

**Kịch bản**: A từng mua với SĐT P và email a@…; B đặt đơn vãng lai giao tới SĐT P, nhập email b@…. B chỉ nhận email "đặt hàng thành công"; các email sau (kèm link `/track/<token>`) tới a@…. A biết 4 số cuối P nên mở được trang tra cứu (tên/địa chỉ người nhận, mặt hàng, tổng tiền) và có thể **từ chối cân lại → huỷ đơn của B** (`POST /orders/track/:token/weight-decision`). B không bao giờ nhận yêu cầu xác nhận khối lượng.

**Probe P2**: hồ sơ `KL-P2` (email `victim@old-owner.example`, SĐT P), khách vãng lai đặt với email `buyer@new-buyer.example` → `orders.customer_id` = hồ sơ cũ; `notifyOrderStatus(confirmed)` và `(weight_pending)` ghi audit gửi tới `vi***@old-owner.example`, không tới người mua.

**Đề xuất**: lưu email liên hệ của đơn (cột `orders.contact_email` hoặc tương đương) và ưu tiên nó trong `notifyOrderStatus`; với đơn vãng lai không dùng `customers.email` làm dự phòng (hoặc chỉ khi email trùng). Cân nhắc A-24 chỉ gắn hồ sơ khi tên + SĐT khớp, hoặc không gắn hồ sơ của tài khoản đã đăng ký.

## S-3 (Trung bình) — NĐ13: xoá tài khoản đã liên kết sỉ để lại PII

**Vị trí**
- `src/worker/routes/online-orders.ts` (`linkStmts`, ~dòng 462-470) — liên kết sỉ đổi `shop_accounts.customer_id` sang khách sỉ; hồ sơ khách lẻ `KL…` tạo lúc đăng ký (tên, SĐT, email) bị bỏ lại.
- `src/shop/worker/routes/me.ts:79-80` — `DELETE /me` chỉ ẩn danh `customers` khi `a.kind === "retail"` và theo `a.customerId` hiện tại (khách sỉ) → hồ sơ khách lẻ cũ không bao giờ được ẩn danh.

**Probe P5**: đăng ký (SĐT 0944777888) → ERP `POST /shop-accounts/:id/b2b-link` → `DELETE /api/me` (200) → hồ sơ khách lẻ vẫn `phone='0944777888'`, email gốc, `active=1`. Hồ sơ này còn được A-24 gắn vào đơn vãng lai sau (nối với S-2). Điểm tích ở hồ sơ khách lẻ cũng bị "mắc kẹt" (tài khoản sỉ không đổi điểm được).

**Đề xuất**: khi xoá, ẩn danh mọi hồ sơ retail từng gắn với tài khoản (lưu `retail_customer_id` lúc đăng ký, hoặc tra qua `orders.shop_account_id`/audit); hoặc khi liên kết sỉ thì ẩn danh/gộp hồ sơ khách lẻ.

## S-4 (Thấp) — Luồng huỷ phía shop không dọn trạng thái phụ như ERP

**Vị trí**: `src/shop/worker/routes/orders.ts:192-212` (khách tự huỷ) và `:157-167` (từ chối cân lại) so với `cancelOrder` trong `src/worker/services/online-ops.ts:676-698`.
- Không có `closeOrderShortagesStmt` → đơn đặt trước đã xác nhận còn phần thiếu (PO 4.1) bị khách huỷ, `so_shortages` vẫn `open` (các truy vấn PO đều lọc theo trạng thái đơn nên không giữ hàng nhầm, nhưng màn PO hiện nguồn sai trạng thái, dữ liệu lệch).
- Không đặt `diff_status='none', diff_amount=0` → đơn trả trước đang chờ hoàn chênh lệch cân, khách từ chối → đơn `cancelled` nhưng OrderView vẫn trả `diffKind: 'refund', diffAmount: -15000` (khách thấy "cửa hàng sẽ hoàn thêm" ngoài khoản hoàn toàn bộ).
- Không áp `cancelFeePolicy` (A-28): nếu chủ đặt `online.cancel_fee_before_prepare = customer`, khách tự huỷ vẫn được hoàn cả phí giao (`refund_due` = toàn bộ tiền đã thu).

**Probe P3, P4** tái hiện hai điểm đầu.
**Đề xuất**: tách phần dọn (`closeOrderShortagesStmt`, reset diff, `refund_due` theo `cancelFeePolicy`) thành hàm dùng chung cho mọi đường huỷ (shop, cron, weight-reject, ERP).

## S-5 (Thấp) — Rate limit checkout lệch tài liệu

`docs/API-dot3.md:16` ghi "checkout 20/phút"; `src/shop/worker/lib/ratelimit.ts:225` cho checkout dùng `RATE_LIMITER` = 120/60s (`wrangler.shop.jsonc:26,38,57`). `limitBy` (`ratelimit.ts:37`) không được gọi ở đâu. Làm S-1 nặng hơn. Đề xuất: binding riêng 20/phút cho checkout, hoặc gọi `limitBy` theo tài khoản/SĐT.

## S-6 (Thấp) — Tham số chưa khai báo registry

`online.max_open_orders_per_phone` (`checkout.ts:120`) và `online.cod_unconfirmed_hours` (`cod-expiry.ts:13`) đọc từ `settings` với giá trị mặc định nhưng không có trong `src/worker/services/settings-registry.ts` (trái quy ước CLAUDE.md; test `settings-ui` không bắt được vì khoá không có trong DB). Chủ không chỉnh được ở màn Cài đặt.

---

## Nghi ngờ (chưa đủ căn cứ là lỗi / cần chủ quyết định)

1. **NCC "Xác nhận" đổi được ngày giao một chiều**: `applySupplierResponse` confirm ghi `expected_date = COALESCE(?, expected_date)` (`src/worker/services/po.ts:583`) — NCC dời ngày giao (≤120 ngày) không qua bước cửa hàng chấp nhận như "Đề xuất sửa" (PO-NCC 4.4). Có test chủ ý (`ncc-orders.test.ts:110`) nên có vẻ là thiết kế; nên xác nhận với chủ.
2. **Từ chối cân lại ở trạng thái `preparing`** hoàn cả phí giao, trong khi A-28 quy định đã soạn → khách chịu. Có thể hợp lý (lỗi lệch cân do cửa hàng) — cần chốt.
3. **Ngưỡng miễn phí giao** tính trên tiền hàng trước giảm giá/voucher/điểm (`delivery.ts:31`, `cart.ts:427-431`, nhất quán với `pack-reprice.ts`). Voucher kéo số khách trả dưới ngưỡng vẫn miễn phí giao — quyết định kinh doanh.
4. **Voucher giới hạn theo khách**: đơn vãng lai gắn hồ sơ cũ (A-24) ghi `voucher_redemptions.customer_id = NULL` (`promo-checkout.ts:120`, vì `customerId` truyền vào là `account?.customerId`) → lượt dùng không được đếm vào giới hạn của khách đó khi họ đăng nhập (vẫn đếm theo SĐT người nhận).
5. **Xoá tài khoản khi còn khoản cần hoàn** (`refund_due > 0` ở đơn đã huỷ): `DELETE /me` chỉ chặn đơn chưa kết thúc; sau xoá cửa hàng mất email liên hệ để hoàn tiền (còn SĐT người nhận trên đơn).
6. **Turnstile** không kiểm `hostname`/`action` trong phản hồi siteverify (`turnstile.ts`) — token của site khác cùng secret không áp dụng, rủi ro thấp.

## Đã kiểm, không phải lỗi (ghi chú để khỏi rà lại)
- `/me/orders/:code/cancel` không gọi `reversalStatements`: điểm/voucher được trigger `orders_reverse_online_points` (0037) và `orders_release_vouchers` (0007) hoàn khi chuyển `cancelled`.
- Tra cứu đơn: token 24 byte + 4 số; replay checkout cần `clientUuid` ≥16 ký tự.
- SePay đến khi intent đã quá hạn nhưng cron chưa chạy → vẫn nhận (đúng ý: khách đã trả).
- Đặt sỉ từ shop: hạn mức (EC-23) qua `confirmOrderFlow` với user hệ thống vai trò manager (không có `b2b.credit_override`), guard tổng cam kết trong batch.
