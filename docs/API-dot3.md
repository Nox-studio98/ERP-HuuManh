# Hợp đồng API — Đợt 3 (M8 Website & app khách + xử lý đơn online ERP)

Quy ước như `docs/API.md` + `docs/API-dot2.md` (camelCase, `{items, nextCursor}`, tiền VND nguyên, số lượng `{unit, qty}` và trả kèm `qtyMilli`, ngày `YYYY-MM-DD` giờ VN).

## Kiến trúc
- **Shop Worker** `huu-manh-shop` (`wrangler.shop.jsonc`, `src/shop/worker/`) — công khai, origin riêng (vd `huumanh.vn`). Dùng chung D1/R2/Queue với ERP. **Không** import route ERP; được dùng lại `src/worker/services/*` và `src/worker/lib/{crypto,time,codes,money,errors}`.
- **ERP Worker** — thêm route quản lý đơn online, khu vực/khung giờ giao, CMS, ảnh sản phẩm.
- Dịch vụ dùng chung có sẵn (KHÔNG viết lại): `services/online-orders.ts` (`ONLINE_TRANSITIONS`, `CUSTOMER_LABEL`, `transitionStmts` — có chốt chặn đồng thời, `newTrackingToken`, `normalizeVi`), `services/reservations.ts`, `services/pricing.ts` (`resolvePrice` channel `online`), `services/stock.ts` (`availableQty`), `services/outbox.ts`, `services/b2b-orders.ts` (đặt sỉ từ web), `services/debt.ts`.
- Mọi thay đổi trạng thái đơn online đi qua `transitionStmts` trong cùng batch với tác động kho/tiền + audit (ERP) hoặc order_events (khách).

## Bảo mật Shop (bắt buộc)
- Phiên khách: cookie `__Host-hm_shop` HttpOnly Secure SameSite=Lax, token lưu SHA-256 ở `shop_sessions`, TTL 30 ngày, xoay vòng khi đăng nhập. Request ghi phải có header `X-Requested-With: hm-shop` (CSRF).
- Mật khẩu PBKDF2 (`lib/crypto`), ≥ 8 ký tự; khoá 15' sau 5 lần sai; phản hồi đăng nhập/quên mật khẩu không tiết lộ email có tồn tại.
- **Turnstile** bắt buộc ở đăng ký, đăng nhập, quên mật khẩu, đặt hàng khách vãng lai: header `X-Turnstile-Token`, xác minh `https://challenges.cloudflare.com/turnstile/v0/siteverify` với secret `TURNSTILE_SECRET`. Nếu secret chưa đặt và `APP_ENV=dev` → bỏ qua; production thiếu secret → 503.
- Rate limit theo IP bằng binding `RATE_LIMITER` (Workers Rate Limiting) nếu có: auth 10/phút, checkout 20/phút, còn lại 120/phút → 429.
- Giá, tồn, phí giao, tổng tiền **luôn tính lại ở server**; client chỉ gửi productId/unit/qty.
- Dữ liệu trả cho khách chỉ là của chính khách; tra cứu đơn khách vãng lai bằng `trackingToken` (không đoán được) + 4 số cuối SĐT.
- CSP như ERP; ảnh phục vụ qua `/img/<key>` từ R2 (chỉ prefix `products/`, `cms/`), cache 1 ngày.
- `link_url` của banner chỉ nhận đường dẫn bắt đầu `/` (chống open redirect). Nội dung bài viết là markdown, client render **không** cho HTML thô.

## Shop API — `src/shop/worker` (Agent A)
Base `/api`. Đơn vị giá hiển thị = đơn vị chính sản phẩm (`baseUnit`); `stepMilli` = `online_step_milli` ?? (kg: 500, khác: 1000).

| Method | Path | Auth | Request → Response |
|---|---|---|---|
| GET | /api/home | — | `{banners:[{id,title,imageUrl,linkUrl}], featured: ProductCard[], groups:[{id,name}], posts:[{slug,title,excerpt,coverUrl,publishedAt}]}` |
| GET | /api/products?q=&groupId=&sort=popular|price_asc|price_desc|new&cursor= | — | items: **ProductCard** `{id, slug, name, origin, baseUnit, unitLabel, price, imageUrl, inStock, availableMilli (làm tròn xuống theo step, tối đa 99 đơn vị — không lộ tồn thật), allowPreorder, stepMilli, units:[{unit,factorMilli}]}`; chỉ sản phẩm `published_online=1` và có giá online hiệu lực |
| GET | /api/products/:slug | — | ProductCard + `{description, images:[url], groupName, related: ProductCard[]}` |
| POST | /api/cart/quote | — / khách | `{items:[{productId, unit, qty}], addressId?|district?, slotDate?, slotId?}` → `{lines:[{productId, name, unit, qty, qtyMilli, unitPrice, lineTotal, available:boolean, preorderMilli, sellByWeight}], subtotal, shippingFee, zone:{id,name}|null, total, estimated:boolean (có hàng cân), issues:[{productId, code:'out_of_stock'|'insufficient'|'unpublished'|'min_order'|'zone_unsupported', message}]}` |
| GET | /api/delivery/slots?date=&district= | — | `{zone, slots:[{id,label,startTime,endTime,available:boolean, reason?}]}` cho 7 ngày tới nếu không có date; khung hết chỗ/quá cutoff → available false |
| POST | /api/checkout | khách hoặc vãng lai (+Turnstile) | `{clientUuid, items:[{productId,unit,qty, expectedUnitPrice}], address:{receiverName, receiverPhone, addressLine, ward?, district, province} | {addressId}, slotDate, slotId, paymentMethod:'cod'|'transfer'|'gateway', note?, acceptPreorder?:boolean, email? (vãng lai)}` → **EC-11**: giá server khác `expectedUnitPrice` → 409 `price_changed` `details:{lines:[{productId, oldPrice, newPrice}]}`. Hết hàng: nếu sản phẩm cho preorder và `acceptPreorder` → `is_preorder=1`, `preorder_milli` phần thiếu; ngược lại 409 `insufficient_stock` `details:{productId, availableMilli}`. Khung giờ đầy → 409 `slot_full`. Tạo order `channel='online'`, code `DH`, `tracking_token`, `estimated_total`, `ordered_qty_milli`, giữ tồn phần có hàng (`planReservations/reserveStmts`), status: COD → `new`; transfer/gateway → `awaiting_payment` + `payment_intents`. Ghi `order_events`. Enqueue `notify.order_status` (email/push cho khách) và `notify.staff_new_order`. Idempotent theo clientUuid. Response 201 **OrderView** (dưới). |
| GET | /api/orders/track/:token?phone4= | — | OrderView (phone4 sai → 404) |
| GET | /api/me/orders, GET /api/me/orders/:code | khách | OrderView[] / OrderView |
| POST | /api/me/orders/:code/cancel | khách | chỉ khi `awaiting_payment|new|confirmed` (EC-06) → nhả giữ tồn; đã thanh toán → `payment_status` giữ nguyên, tạo ghi chú hoàn tiền cho ERP xử lý |
| POST | /api/orders/track/:token/weight-decision | — (token + phone4) | EC-03 `{accept:boolean}` khi `weight_adjust_status='pending_customer'` → accepted (đơn tiếp tục) / rejected (huỷ, nhả tồn) |
| POST | /api/me/orders/:code/reorder | khách | M8-07 trả `{items}` để đưa vào giỏ (giá hiện tại) |
| GET | /api/payments/:orderCode/transfer | token hoặc khách | `{bankBin, accountNo, accountName, amount, content, qrPayload (chuỗi EMVCo VietQR), expiresAt}` |
| POST | /api/payments/gateway/:provider/return, /webhook | — | khung cho cổng TT [Cần xác nhận]; `fake_gateway` cho dev: webhook HMAC `PAYMENT_WEBHOOK_SECRET` → intent succeeded → order `awaiting_payment → new`, `payment_status='paid'`, tạo `payments` (fund bank) |
| POST | /api/auth/register | Turnstile | `{fullName, email, phone, password, marketingOptIn?}` → tạo `customers` (type retail, group `le`) + `shop_accounts`; enqueue `notify.email` verify |
| POST | /api/auth/login, /logout, /forgot, /reset, /verify-email | Turnstile cho login/forgot | |
| GET/PUT | /api/me | khách | `{id, fullName, email, phone, kind, b2bStatus, customerGroup, marketingOptIn}` |
| DELETE | /api/me | khách | NĐ 13/2023: ẩn danh hoá tài khoản (giữ đơn/chứng từ, xoá tên/email/SĐT/địa chỉ trong shop_accounts, shop_addresses) |
| GET/POST/PUT/DELETE | /api/me/addresses | khách | sổ địa chỉ; server gán zone_id theo district |
| POST | /api/me/push-subscriptions | khách | `{endpoint, keys:{p256dh, auth}}`; GET /api/push/vapid-public-key |
| POST | /api/b2b/link-request | khách | M8-09 `{companyName, taxCode, note}` → `b2b_status='pending'` + approval `shop.b2b_link` để ERP gắn với khách sỉ có sẵn |
| GET | /api/b2b/catalog | khách sỉ đã duyệt | ProductCard với giá `resolvePrice(channel b2b, group, customerId)` + `creditStatus` |
| POST | /api/b2b/orders | khách sỉ đã duyệt | M8-09 đặt nhanh `{clientUuid, addressId (customer_addresses), deliveryDate, lines}` → dùng `createB2bOrder` + `confirmOrderFlow` (ngữ cảnh user hệ thống id 1); trả 409 `credit_blocked` như ERP; khách sỉ thấy đơn trong /api/me/orders |
| GET | /api/posts/:slug, /sitemap.xml, /robots.txt | — | |
| GET | /img/* | — | ảnh R2 |

**OrderView**: `{code, trackingToken, status, statusLabel, createdAt, slotDate, slotLabel, receiverName, receiverPhoneMasked, shipAddress, paymentMethod, paymentStatus, estimated:boolean, estimatedTotal, subtotal, shippingFee, discount, total, weightAdjustStatus, lines:[{productId, name, imageUrl, unit, orderedQty, qty, unitPrice, lineTotal, preorderMilli}], events:[{at, status, statusLabel, note}], canCancel, transfer?:{...như /payments/transfer} }` — **không** trả internal_note, giá vốn, lô.

## ERP — đơn online & website (Agent B)
| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | /online-orders?status=&slotDate=&channel=online|fresco|all&q= | orders.online.manage | M1-05 danh sách chung đơn online + Fresco (+ social nhập tay) `{id, code, channel, status, paymentMethod, paymentStatus, slotDate, slotLabel, receiverName, receiverPhone*, district, total, estimated, weightAdjustStatus, createdAt, isPreorder}` (*che theo customers.view_pii) + đếm theo trạng thái `counts` |
| GET | /online-orders/:id | orders.online.manage | chi tiết + lines (lô đang giữ) + events (cả internal_note) + payment_intents |
| POST | /online-orders | orders.online.manage | M1-05 nhập đơn từ mạng xã hội `channel='social'` cùng luồng checkout (giá online, giữ tồn) |
| POST | /online-orders/:id/confirm | orders.online.manage | new → confirmed; preorder: chỉ khi đã đủ hàng (thử giữ phần preorder) |
| POST | /online-orders/:id/prepare | orders.online.manage | confirmed → preparing |
| POST | /online-orders/:id/pack | orders.online.manage | **EC-03** `{lines:[{orderLineId, actualQty, unit}]}` cân thực: cập nhật qty_milli/line_total/total (giữ ordered_qty_milli); lệch tổng ≤ `online.weight_tolerance_bp` → `auto_accepted`; vượt → `pending_customer` + notify khách, chưa cho ship |
| POST | /online-orders/:id/ship | orders.online.manage | preparing → shipping; yêu cầu `weight_adjust_status ∉ {pending_customer, rejected}`; **EC-05**: transfer/gateway phải `payment_status='paid'`; tiêu thụ giữ tồn theo số thực cân (`consumeForDeliveryStmts`), order_line_lots, cost; `{carrier?, trackingNo?}` |
| POST | /online-orders/:id/deliver | orders.online.manage | shipping → completed; COD → payments method cod vào quỹ `cod_clearing` (đối soát bằng settlements Đợt 2); notify |
| POST | /online-orders/:id/fail | orders.online.manage | EC-07 shipping → delivery_failed `{reason}` |
| POST | /online-orders/:id/redeliver | orders.online.manage | delivery_failed → confirmed `{slotDate, slotId}` (hàng vẫn ở shipper/kho: ghi chú) |
| POST | /online-orders/:id/return-to-stock | orders.online.manage | `{lines:[{orderLineId, qty, unit, restock, reason}]}`. **delivery_failed** → `returned` (chưa có doanh thu) cộng lại đúng lô, restock=false → hao hụt, hoàn tiền. **completed** (A-05, đợt fix 1b) → đơn gốc GIỮ `completed`; tạo phiếu trả `orders.kind='return'` (`original_order_id`, ngày hôm nay, trừ doanh thu/giá vốn ở ngày trả qua `returnsTotal`), nhập lại đúng lô (restock) hoặc tính hao hụt (không restock), hoàn tiền vào `payments` âm của đơn gốc, đảo điểm tích/điểm đổi/voucher đúng một lần theo luỹ kế. Hỗ trợ trả từng phần (`lines` rỗng = trả hết phần còn lại); trả hết mọi dòng → phiếu cuối gồm cả phí giao. Response `result:{refund, returnOrder, returnTotal, fullyReturned}`; 409 `return_exceeds_sold`/`nothing_to_return`; kỳ hôm nay khoá → 423 |
| POST | /online-orders/:id/refund | finance.write | **Đợt fix 4a (A-14)**: hoàn tiền THỰC (payments âm cùng phương thức/quỹ gốc) cho nghĩa vụ `refundDue`. `cancel` / `return-to-stock` (orders.online.manage) và khách tự huỷ/cron chỉ ghi `orders.refund_due` (= tiền đã thu ròng, trừ phí giao nếu chính sách huỷ do khách chịu; COD chưa thu → 0), KHÔNG chạm quỹ; response `result:{refund:0, refundDue}`. `/refund` hoàn tối đa `refundDue` (guard `order.refund_due`, `order.refund`, trạng thái); `refundDue` về 0 → gọi lại 409 `nothing_to_refund`; hoàn đồng thời chỉ một lần. Hoạt động cả với đơn `completed` đã có phiếu trả. `GET /online-orders` & `/:id` thêm `refundDue` (list: `needsRefund = refundDue>0`). Migration 0019 |
| POST | /online-orders/:id/refund-diff | finance.write | A-02: đơn trả trước cân nhẹ hơn (`diffStatus='pending'`, `diffAmount<0`) → hoàn phần dư (payments âm cùng phương thức/quỹ gốc), `diffStatus='settled'` |
| POST | /online-orders/:id/waive-diff | finance.approve | A-02: miễn khoản chênh lệch `{reason}` (bắt buộc, audit `online_order.diff_waive`), `diffStatus='waived'` |
| POST | /online-orders/:id/cancel | orders.online.manage | `{reason}` EC-06 nhả giữ; nếu đã soạn: hàng về kho đúng lô; phí giao theo `online.cancel_fee_policy` |
| POST | /online-orders/:id/mark-paid | finance.write | EC-05 xác nhận tiền về thủ công (kèm bankTxnId) → `payments` + intent succeeded + awaiting_payment→new |
| — | khớp sao kê | — | mở rộng nhập sao kê (Đợt 2) để tự khớp nội dung chứa mã đơn `DH...` với payment_intents pending đúng số tiền |
| GET/POST/PUT | /delivery-zones, /delivery-slots | orders.online.manage (ghi: approvals.decide) | |
| GET/PUT | /products/:id/online | products.write | `{slug, description, publishedOnline, featured, allowPreorder, onlineSort, onlineStepMilli}`; slug tự sinh từ tên (normalizeVi) nếu trống |
| POST | /products/:id/images | products.write | upload multipart (jpg/png/webp, ≤ 2 MB, kiểm magic bytes) → R2 `products/<id>/<uuid>.<ext>`; DELETE /products/:id/images/:idx; PUT thứ tự |
| GET/POST/PUT/DELETE | /cms/banners, /cms/posts | products.write | ảnh upload như trên vào `cms/` |
| GET | /shop-accounts?q=&b2bStatus=pending | customers.view_pii | |
| POST | /shop-accounts/:id/b2b-link | b2b.approve | `{customerId}` gắn tài khoản với khách sỉ có sẵn → `b2b_status='approved'`, kind b2b (handler approval `shop.b2b_link`) |
| POST | /me/push-subscriptions | (đăng nhập ERP) | nhân viên nhận push "Đơn online mới" |

**Thông báo (jobs.ts)**: `notify.order_status` (email + push cho khách theo CUSTOMER_LABEL; nội dung không chứa dữ liệu nhạy cảm ngoài mã đơn và link tra cứu), `notify.staff_new_order` (push cho NV có orders.online.manage), `notify.email` (xác minh/đặt lại mật khẩu). Email provider theo `notify.email_provider`: `fake` (ghi audit) | `cloudflare` (binding `EMAIL` send_email). Web Push: VAPID (`VAPID_PUBLIC_KEY` var, `VAPID_PRIVATE_KEY` secret, JWK), mã hoá aes128gcm (RFC 8291) bằng WebCrypto; endpoint trả 404/410 → xoá subscription.

**Cron** (thêm vào `0 1 * * *` hoặc `*/5`): huỷ đơn `awaiting_payment` quá `online.hold_minutes_transfer` (nhả tồn, notify) — `*/5`.


## Đợt fix 1b — chênh lệch cân đơn trả trước (A-02) và trả hàng sau giao (A-05)

- `POST /online-orders/:id/pack`: với đơn `transfer`/`gateway` đã `paid`, `diffAmount = total_mới − paid_total`; `diffStatus` = `pending` (≠ 0) hoặc `none`. Response thêm `diffAmount`. Dương = **"Thu thêm"** (cho phép ship; `deliver` ghi phiếu `payments` method `cod` quỹ `cod_clearing` đúng phần chênh, `paid_total += chênh`, `diffStatus='settled'`); âm = **"Hoàn lại"** (`deliver` bị chặn 409 `diff_unsettled` tới khi `refund-diff` hoặc `waive-diff`).
- `GET /online-orders` (item) thêm `diffAmount` (chỉ khi pending), `diffStatus`. `GET /online-orders/:id` thêm `diffAmount`, `diffStatus`, `diffNote`, `diffKind` (`collect`|`refund`|null), `returns[]`, `returnedTotal`, `fullyReturned`.
- Shop `GET /api/me/orders/:code` / `GET /api/orders/track/:token`: thêm `diffAmount`, `diffKind` (`collect`|`refund`), `returnedTotal`.
