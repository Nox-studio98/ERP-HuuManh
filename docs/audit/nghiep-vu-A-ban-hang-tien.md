# Audit nghiệp vụ A — luồng đơn-đến-tiền (order-to-cash) và đồng bộ liên luồng

Phạm vi: POS (bán / huỷ / trả / chốt ca / đặt cọc), website + đơn online + mạng xã hội, B2B (báo giá → đơn → giữ tồn → giao → hoá đơn → điều chỉnh/trả → thu nợ), khuyến mãi / voucher / điểm, định giá theo bảng giá / nhóm / kênh, các cron.
Phương pháp: đọc mã (src/worker, src/shop/worker, src/web/offline.ts, migrations 0001–0013) đối chiếu tài liệu nghiệp vụ; 4 probe test tạm (đã xoá, repo sạch, `git status` trống). 
Chú thích: CONFIRMED = đã chạy probe hoặc đọc mã không còn nghi ngờ; PLAUSIBLE = suy luận từ mã, chưa chạy.

Tổng: 0 Nghiêm trọng · 5 Cao · 11 Trung bình · 13 Thấp (29 phát hiện).

---------------------------------------------------------------------

## (a) Bảng phát hiện

### Cao

| ID | Module | File:dòng | Mô tả | Kịch bản tái hiện | Đề xuất | Trạng thái |
|---|---|---|---|---|---|---|
| A-01 | M4/M5 trả hàng B2B sau khi đã thanh toán (EC-25) | src/worker/services/debt.ts:15-20, 48-51; src/worker/routes/debts.ts:57; src/worker/services/debt-ledger.ts:41; src/worker/routes/b2b.ts:493+ | Công nợ còn lại của hoá đơn = total + Σ hoá đơn điều chỉnh − Σ gạch; mọi nơi lọc `os > 0`. Khi trả hàng sau khi khách đã trả đủ/trả quá một phần, `os` âm bị bỏ → khoản "công nợ âm" (tiền khách được hoàn / trừ vào đơn sau) biến mất; không có số dư có, không có luồng hoàn tiền. Hàng đã nhập lại kho nhưng sổ nợ không ghi gì. | Probe 1: HĐ 500.000, thu 500.000 (khớp HĐ), trả 4 kg = −200.000. Kết quả `customerDebtStatus` = {balance:0, outstanding:0, unapplied:0}; `/debts/receivables` rỗng. Khách đáng được 200.000 nhưng không hiện ở đâu. | Tính `credit = Σ max(0, −os)` vào `unapplied` (số dư có) hoặc sinh `debt_adjustment` loại `refund_credit`; cho phép gạch số dư có vào HĐ mở khác; thêm luồng "hoàn tiền khách" tạo phiếu chi. | CONFIRMED |
| A-02 | M8/M1 đơn online trả trước + hàng cân (EC-03/EC-05) | src/worker/services/online-ops.ts:73-110 (pack, dòng 104), 146-153 (ship chỉ kiểm `payment_status`), 203-225 (deliver); online-payments.ts:53-96 | Đơn chuyển khoản/cổng thanh toán thu tiền trước theo tổng ước tính. `packOrder` đổi `total` theo cân thực (trong ngưỡng 10% tự chấp nhận, ngoài ngưỡng chờ khách) nhưng không đụng `paid_total`/`payments`. Ship/giao chỉ cần `payment_status='paid'` → đơn hoàn tất với `paid_total ≠ total`, không thu thêm, không hoàn phần dư. | Probe 2: Nho cân 2 kg × 150.000 = 300.000, chuyển khoản, mark-paid; pack 2,2 kg → total 330.000; ship + deliver → `status=completed, total=330000, paid_total=300000, payment_status=paid`. Thiếu 30.000 không ai biết; doanh thu ghi 330.000 nhưng tiền vào 300.000. (Ngược lại cân nhẹ hơn → khách trả dư không hoàn.) | Sau pack nếu `paid_total ≠ total`: đặt `payment_status='partially_paid'`/tạo chênh lệch; chênh dương → bắt buộc thu bù (hoặc đổi thành thu khi giao) trước khi ship; chênh âm → sinh dòng hoàn (refund payment) khi giao; thêm trạng thái hiển thị cho NV. | CONFIRMED |
| A-03 | M6/M5 đối soát COD/sàn (EC-31/34) | src/worker/routes/debts.ts:789 (`diff = received − (expected − fee)`) so với 864-865 (`mk("in", received)` rồi `mk("out", fee)`) | `received_amount` đã là tiền thực nhận SAU phí (công thức diff chứng minh điều này) nhưng khi xác nhận hệ thống vẫn lập phiếu chi phí `fee` từ chính quỹ ngân hàng → trừ phí hai lần ở quỹ. P&L đúng (phí là chi phí), số dư quỹ thực tế thấp hơn thực nhận đúng bằng tổng phí mọi đợt đối soát. Test hiện tại `sec-integrity-finance` / `debts.test` đã ngầm khẳng định hành vi sai này (nhận 980k + chi 20k). | Probe 2-D: đơn COD 170.000, đối soát received 160.000, fee 10.000 (diff 0). Quỹ ngân hàng từ 600.000 → 750.000 (+150.000) thay vì +160.000; vouchers: in 160.000, out 10.000, out 170.000 (chuyển khỏi quỹ chờ). | Phiếu thu vào quỹ thật phải = received + fee (tổng gộp, rồi chi phí fee) hoặc ghi phí bằng bút toán không đụng tiền (P&L-only). Sửa test cho khớp. | CONFIRMED |
| A-04 | M5/M6 xoá nợ, chiết khấu thanh toán, cọc bị mất (EC-29, M1-12) | src/worker/routes/reports.ts:54-66 (chi phí chỉ lấy `cash_vouchers` direction='out'); src/worker/routes/debts.ts:~380-420 (debt_adjustments); promo-preorders.ts:cancelStatements (forfeit) | P&L chỉ đọc doanh thu từ `orders` và chi phí từ phiếu chi. `debt_adjustments` (discount/write_off) không sinh phiếu và không được truy vấn ở đâu (grep toàn src/worker: chỉ debt.ts, debt-ledger.ts, debts.ts, b2b.ts). Cọc không hoàn (forfeited) là khoản thu không bao giờ thành doanh thu: phiếu thu cọc có `pnl_line='revenue'` nhưng P&L bỏ qua mọi phiếu thu `in`. | Xoá nợ 2.000.000 hoặc mất cọc 200.000 → `/reports/pnl` không đổi lợi nhuận; spec EC-29 yêu cầu "thể hiện trong báo cáo lãi lỗ". | Thêm dòng P&L `bad_debt/discount_given` từ `debt_adjustments` (status posted, theo kỳ) và dòng `other_income` từ cọc forfeited + phiếu thu `in` không phải `transfer`/thu bán hàng. | CONFIRMED (đọc mã + grep) |
| A-05 | M1/M8 trả hàng online sau khi giao (EC-01/EC-33) | src/worker/services/online-ops.ts:310-356 (returnToStock), 358-393 (cancelOrder); src/worker/routes/reports.ts:34 (chỉ `status='completed'`) | Trả hàng online chuyển đơn gốc sang `returned` thay vì tạo chứng từ trả `kind='return'` như POS/B2B. Đơn biến khỏi doanh thu/giá vốn của NGÀY ĐÃ GIAO (sửa số quá khứ, kể cả kỳ đã khoá), ngày trả không có "trả hàng", `returnsTotal`/báo cáo ngày không thấy. Không có kiểm tra khoá kỳ (chỉ POS void có). | Probe 4: đơn online hoàn tất 250.000 → return-to-stock: `/reports/pnl` salesTotal 250.000 → 0, returnsTotal 0, daily returnTotal 0. | Tạo order kind='return' (như b2b.ts:593) khi trả/huỷ sau hoàn tất, giữ đơn gốc 'completed'; thêm `assertPeriodOpen` cho huỷ/trả online. | CONFIRMED |

### Trung bình

| ID | Module | File:dòng | Mô tả | Kịch bản | Đề xuất | Trạng thái |
|---|---|---|---|---|---|---|
| A-06 | POS huỷ đơn sau chốt ca (EC-32) | src/worker/routes/pos.ts:713-772, 119-137 | Void đơn thuộc ca đã chốt: `payments` chuyển `refunded`, kho/quỹ giảm nhưng tiền hoàn thực tế lấy từ két ca hiện tại không được ghi vào ca nào. Ca đang mở "dư" đúng số hoàn; ca cũ giữ `expected_cash` đã chốt. | Probe 3: bán 100.000 tiền mặt, chốt ca, mở ca mới (đầu ca 100.000), void đơn cũ; trả lại 100.000 cho khách → chốt ca mới lệch −100.000 (expected 100.000). | Khi void đơn của ca đã chốt, sinh phiếu chi/điều chỉnh gắn ca hiện tại (hoặc `cash_vouchers ref_type='void_refund'` cộng vào `expectedCash`). | CONFIRMED |
| A-07 | M1-12 huỷ đơn bán sau khi giao đặt trước | src/worker/routes/pos.ts:713-772 + promo-preorders.ts:fulfill | `/orders/:id/void` cho phép huỷ đơn đặt trước đã giao (channel='pos'); chỉ phần thanh toán còn lại (`payments`) bị `refunded`, phiếu thu cọc vẫn `posted` và `order_deposits.status='applied'`. Cọc không được hoàn, két/quỹ ghi dư. | Probe 3: đặt trước 500.000 cọc 200.000 tiền mặt, giao thu thêm 300.000, void: quỹ TM 500.000 → 200.000 (đáng ra 0); chốt ca expected 300.000 (đầu ca 100k + cọc 200k) dù đã trả khách 500.000. | Chặn void đơn có `order_deposits` hoặc sinh phiếu chi hoàn cọc; hướng dẫn dùng trả hàng (return) vốn xử lý đúng (payments âm = −total + cọc). | CONFIRMED |
| A-08 | M8/M1 dòng đơn online không mang giảm giá | src/shop/worker/routes/checkout.ts:224-231, 207-215 (orders.discount = promo+điểm, `order_lines.discount=0`); src/worker/services/salesreport.ts:34-43; reports.ts:83-103 | Chiết khấu/voucher/điểm chỉ ghi ở cấp đơn, `promo.lineDiscounts` không dùng. Báo cáo theo dòng (top sản phẩm, P&L groupBy channel/group/day, lãi gộp theo nhóm hàng) tính doanh thu online theo giá gốc, lệch với doanh thu tổng (o.total còn gồm phí ship). POS thì đúng (line_total đã trừ). | Probe 4: voucher 50.000 trên đơn 300.000 (free ship) → salesTotal +250.000 nhưng breakdown theo kênh online +300.000. | Ghi `order_lines.discount/line_total` đã phân bổ (đã có `lineShares`); phí ship báo riêng một dòng. | CONFIRMED |
| A-09 | M1/EC-04 bán offline | src/web/offline.ts:46-52, src/worker/routes/pos.ts:247-256,264-266 | Hàng đợi offline gửi lại payload y nguyên: server dùng GIÁ + khuyến mãi tại thời điểm đồng bộ, `completed_at` = lúc đồng bộ, gắn vào CA ĐANG MỞ lúc đó (hoặc lỗi `no_open_shift`), không có thời điểm bán gốc. Đơn đã bán thật mà bị `approval_required`/`payment_mismatch`/`insufficient_stock` khi đồng bộ vẫn bị giữ trong hàng đợi, ca có thể chốt trước khi đồng bộ nên tiền mặt lệch. Spec: không trùng số HĐ ✔ (clientUuid) nhưng mất ngày/ca chính xác. | Bán offline 23:50 đồng bộ sau 00:05 → doanh thu sang ngày sau; thay đổi giá trong lúc offline → payment_mismatch. | Gửi `soldAt`, `shiftId`, `priceSnapshot` (giá đã hiển thị) cùng payload; server chấp nhận giá snapshot nếu trong ngưỡng; chặn chốt ca khi còn hàng đợi (client + cảnh báo). | CONFIRMED (đọc mã) |
| A-10 | M4/EC-23 hạn mức nợ | src/worker/lib/rbac.ts (manager có `b2b.approve`); src/worker/routes/customers.ts:135-190 (tạo khách không giới hạn credit), 196-200 (đổi hạn mức cần `b2b.approve`) | Spec: chỉ CHỦ duyệt tay vượt hạn mức (`b2b.credit_override` chỉ owner). Nhưng quản lý (b2b.approve) tạo khách sỉ với hạn mức bất kỳ hoặc nâng hạn mức/hạn thanh toán rồi tạo đơn → né override của chủ, không có duyệt/ghi lý do. | Manager PUT /customers/:id {creditLimit: 1e10} → đơn lớn qua `checkCredit`. | Đổi hạn mức/hạn TT cần `b2b.credit_override` hoặc tạo approval cho chủ; tạo khách mới hạn mức > ngưỡng cần duyệt. | CONFIRMED (đọc mã) |
| A-11 | M6 số dư quỹ vs tiền thực | src/worker/routes/finance.ts:20-27 (payments chỉ tính khi `o.status='completed'`) | Số dư quỹ không gồm tiền đã nhận của đơn online trả trước đang `new/confirmed/preparing/shipping`, đơn chờ hoàn (`cancelled/returned` + paid), nhưng ngân hàng đã có tiền. Số dư quỹ ngân hàng thấp hơn sao kê trong suốt vòng đời đơn; ngược lại COD hoàn tất ngay vào quỹ chờ. | Đơn chuyển khoản 300.000 mark-paid → /funds ngân hàng không tăng cho đến khi giao xong. | Tính payments theo `status='confirmed'` bất kể đơn (đơn huỷ có dòng hoàn âm cân bằng); hoặc ghi nhận khoản "nhận trước" riêng. | CONFIRMED (đọc mã) |
| A-12 | M1-09/EC-01/EC-06 trả hàng online một phần | src/worker/services/online-ops.ts:310-356 (dòng 333-341: `wasteMilli = qty − restock`, `refundPlan(o.total)`) | Chỉ trả cả đơn: phần không trả về coi là hao hụt chứ không phải khách giữ, và hoàn toàn bộ `o.total` (kể cả phí ship). Không có trả một phần, đổi hàng online, chênh giá. POS có trả một phần đúng. | Khách trả 1 trong 3 loại hàng → NV phải chọn toàn đơn returned, hoàn 100%. | Hỗ trợ trả theo dòng/số lượng (tạo order kind='return' như POS), phí ship theo chính sách. | CONFIRMED (đọc mã) |
| A-13 | M1 EC-10 / đổi hàng | (không có mã) | Không có tách đơn con, không có thao tác đổi hàng (trả + bán + chênh giá) trong một chứng từ. | — | Bổ sung đơn con (parent_order_id) dùng chung thanh toán; màn "đổi hàng" ghép return+sale. | CONFIRMED (grep) |
| A-14 | M1/M6 hoàn tiền tự động bởi NV online + COD | src/worker/services/online-ops.ts:341-348, 372-390; routes/online-orders.ts:263-264 | `cancel` và `return-to-stock` (quyền `orders.online.manage`: online_staff) tự chèn dòng hoàn tiền âm vào quỹ ngân hàng/cod_clearing, trong khi endpoint `refund` riêng yêu cầu `finance.write` — tách quyền bị vô hiệu. Với COD đã giao rồi trả: dòng hoàn trừ vào `cod_clearing` dù tiền có thể đã được đối soát về ngân hàng (clearing âm, ngân hàng không giảm). | Probe 4: COD 250.000 completed → return: payments +250.000 và −250.000 cùng quỹ clearing; nếu đã settlement, clearing −250.000. | Chỉ ghi nhận hoàn thực tế khi kế toán xác nhận (`refund`); hoàn COD đã đối soát phải lấy quỹ ngân hàng. | CONFIRMED (cơ chế) / PLAUSIBLE (kịch bản đối soát trước) |
| A-15 | M3-02 giá theo nhóm khách trên website | src/shop/worker/lib/cart.ts:63 (`resolvePrice(... {channel:"online"})` không group); catalog.ts (cards không group cho retail); so với online-ops.ts:467 (đơn MXH có group) và pos.ts:284 | Khách bán lẻ đăng nhập thuộc nhóm "thân thiết" thấy/mua giá chung trên website, nhưng cùng khách đó mua tại quầy hoặc qua đơn MXH lại ra giá nhóm → không nhất quán giữa các kênh. | Bảng giá nhóm `than_thiet` kênh online → web bỏ qua. | Truyền `customerGroupId` của tài khoản vào `priceCart`/catalog khi đăng nhập (và so khớp `expectedUnitPrice`). | CONFIRMED (đọc mã) |
| A-16 | M1-09 trả hàng POS không giới hạn | src/worker/routes/pos.ts:583-709, rbac cashier có `pos.return` | Thu ngân tự trả/hoàn tiền mặt cho BẤT KỲ đơn nào (bất kể ngày, ca đã chốt, giá trị), `restock=false` cũng không cần duyệt. Spec: "Hủy hoặc sửa hóa đơn sau khi chốt ca chỉ quản lý được làm". Void thì đã chặn đúng, trả hàng thì không. | Cashier trả đơn của ca hôm qua, hoàn tiền mặt từ két hôm nay. | Đơn thuộc ca đã chốt hoặc quá N ngày/giá trị > ngưỡng → cần `approvals.decide`/approval; bắt lý do + ghi người duyệt. | CONFIRMED (đọc mã) |

### Thấp

| ID | Module | File:dòng | Mô tả | Đề xuất | Trạng thái |
|---|---|---|---|---|---|
| A-17 | M2/M4 giữ tồn lô hết hạn | src/worker/services/reservations.ts:119-160 (consume không kiểm hạn/trạng thái lô); scheduled.ts (swap chỉ 08:00 và cứng `storeId=1`) | Lô hết hạn lúc 00:00 giữ `reserved` đến 08:00; giao/ship trong khoảng đó vẫn xuất lô quá hạn. Cron swap chỉ cửa hàng 1. | Kiểm `expires_at/status` trong consume (rơi về allocateFefo); swap cho mọi cửa hàng và ngay sau cron hết hạn. | PLAUSIBLE |
| A-18 | M8 khung giờ giao | src/shop/worker/lib/delivery.ts:58 (`status <> 'cancelled'`) vs online-ops.ts:~600 (`NOT IN ('cancelled','returned','draft')`); redeliverOrder (online-ops.ts:238) không kiểm sức chứa/cutoff | Hai cách đếm sức chứa khác nhau (web tính cả đơn đã trả); giao lại không kiểm sức chứa. | Một hàm đếm dùng chung; kiểm khi redeliver. | CONFIRMED |
| A-19 | M8 chốt cân | online-ops.ts:104 | Sau pack tổng = `max(0, subtotal − discount cố định) + ship cố định`: khuyến mãi % không tính lại, ngưỡng miễn phí ship không xét lại, voucher min_order không kiểm lại. | Tính lại bằng engine khuyến mãi sau pack hoặc ghi rõ chính sách. | CONFIRMED |
| A-20 | M8 hàng cân, khách không phản hồi | online-orders route + shop orders.ts:24-59 | `pending_customer` chỉ khách (token) giải quyết được; NV không có thao tác "khách đồng ý qua điện thoại"/ghi nhận có kiểm soát, chỉ có thể pack lại số khác hoặc huỷ. | Thêm `staff_override` kèm lý do + audit. | PLAUSIBLE |
| A-21 | M1-08 voucher POS | promotions engine (promotions.ts:233-257) | `per_customer_limit` không áp dụng khi POS bán không chọn khách (voucher `max_uses` NULL dùng vô hạn tại quầy). | Voucher có giới hạn/khách bắt buộc chọn khách ở POS. | PLAUSIBLE |
| A-22 | M3 EC-13 giá riêng theo khách ở POS/online | pricing.ts, pos.ts:284, customers.ts:365-370 | Bảng giá riêng của khách chỉ tạo ra kênh `b2b`; POS/online không truyền `customerId` → "giá riêng cho khách" chỉ cho B2B (Probe 2-C: bảng giá riêng kênh pos bị bỏ). | Nếu cần cho bán lẻ: truyền customerId và cho tạo bảng giá riêng kênh pos/all. | CONFIRMED (đọc mã + probe) |
| A-23 | M3-03 giá hẹn trước | prices.ts:163-171 | Khi đổi giá hàng loạt chỉ đóng dòng cũ có `effective_from < from`; dòng đã hẹn tương lai (active, `effective_from > from`) còn nguyên, đến hạn sẽ đè lên giá mới hơn. | Đóng/huỷ cả dòng hẹn tương lai cùng bảng giá/sản phẩm khi chèn. | PLAUSIBLE |
| A-24 | M8 khách vãng lai | checkout.ts:200-204 | Mỗi đơn khách không đăng nhập tạo một `customers` mới (cùng SĐT trùng lặp) → lịch sử/điểm không gộp, rác danh bạ. | Tìm theo SĐT trước khi tạo. | CONFIRMED |
| A-25 | M4/M5 VAT | b2b-orders.ts (order.total net) vs b2b-invoice.ts:48-54 (invoice.total gross) | Khi bật `invoice.vat_rate_bp>0`: hạn mức nợ kiểm theo tổng đơn chưa VAT, công nợ ghi theo HĐ có VAT; doanh thu = net. Mặc định 0% nên chưa lộ. | Thống nhất cơ sở tính (ví dụ credit theo gross). | PLAUSIBLE |
| A-26 | M8-04 cổng thanh toán | shop payments.ts:30-73 | Chỉ có cổng giả lập dev/demo; production chỉ chuyển khoản VietQR (theo `[Cần xác nhận]`). Webhook `gateway` ghi `payments.method='transfer'` còn markOrderPaid ghi 'ewallet' → không nhất quán báo cáo theo phương thức. | Thống nhất method; hiện thực adapter khi chọn cổng. | CONFIRMED |
| A-27 | M4 EC-26 | b2b.ts:368-472 | Giao thiếu → đơn `completed` ngay, phần còn lại không giao bổ sung được (phải tạo đơn mới). | Cho giữ phần còn lại ở trạng thái `partial` hoặc tạo đơn bổ sung. | CONFIRMED |
| A-28 | M1 EC-06 phí giao khi huỷ | online-ops.ts:371 | `keepFee` chỉ khi `preparing` và policy 'customer'; huỷ ở `confirmed` (đã soạn một phần) không thu. Huỷ không có bước kiểm độ tươi (restock toàn bộ lô đã xuất). | Làm rõ chính sách ([Cần xác nhận]). | CONFIRMED |
| A-29 | M1 phê duyệt giảm giá | pos.ts:360 | Quản lý/chủ bán dưới giá vốn hoặc giảm > ngưỡng KHÔNG cần lý do/phiếu duyệt (bỏ qua `requireApproval`), spec yêu cầu ghi lý do. | Bắt buộc nhập lý do + audit khi người có quyền tự duyệt. | CONFIRMED |

### Xác nhận ĐÚNG (đã kiểm, không có lỗi)
- EC-02: tồn khả dụng = on_hand − reserved; CHECK trên `lots` chặn bán đồng thời; POS retry 1 lần.
- Không trừ kho hai lần / rò rỉ: POS void và trả đúng lô (order_line_lots); online cancel ở mọi trạng thái nhả `reservations` hoặc nhập lại đúng lô đã xuất; giao lại (redeliver) không xuất kho lần hai.
- Voucher/điểm hoàn đúng một lần ở mọi đường huỷ (trigger 0007/0011 + idempotent theo sổ); POS return hoàn theo tỷ lệ.
- EC-05: đơn chuyển khoản không ship khi chưa `paid`; auto-cancel 5 phút nhả tồn; khớp sao kê chỉ khi duy nhất 1 đơn + đúng số tiền.
- EC-12/28/23/24: báo giá hết hạn bị chặn, hạn mức kiểm trước khi giữ tồn, gạch nợ FIFO + số dư có.
- Mốc ngày VN: `vnDayRangeUtc`, `vnPeriod`, `date(datetime(...,'+7 hours'))`, slotProblem (+07:00) nhất quán.

---------------------------------------------------------------------

## (b) Độ phủ spec

### M1 Bán hàng
| Mã | Mức | Ghi chú |
|---|---|---|
| M1-01 | Đạt | POS app + hoá đơn/receipt API |
| M1-02 | Đạt | quy đổi đơn vị qua `product_units`, qty_milli |
| M1-03 | Một phần | lookup mã vạch/lô có; kết nối cân điện tử chưa (spec [Cần xác nhận]) |
| M1-04 | Đạt | tiền mặt/CK/QR/thẻ/ví, thanh toán chia, thối chỉ tiền mặt; thẻ/QR dồn một quỹ ngân hàng |
| M1-05 | Đạt | online + social + fresco một danh sách |
| M1-06 | Đạt | confirm→prepare→pack→ship→deliver/fail/redeliver/return (xem A-02, A-05, A-12) |
| M1-07 | Đạt | khung giờ + cutoff + sức chứa, phí theo khu vực, hãng/mã vận đơn |
| M1-08 | Đạt | % / số tiền / giá cố định / combo / cuối ngày / voucher; chọn KM tốt nhất, chặn dưới vốn (A-21) |
| M1-09 | Một phần | POS trả một phần tốt; đổi hàng chưa có; online chỉ trả cả đơn (A-12, A-13, A-16) |
| M1-10 | Đạt | chốt ca bắt lý do chênh lệch; báo cáo ngày theo kênh (A-06, A-09) |
| M1-11 | Đạt | HĐĐT tự phát cho B2B, điều chỉnh khi trả |
| M1-12 | Một phần | cọc/giữ tồn/giao OK; huỷ có duyệt không hoàn cọc; lỗi void (A-07) và không vào P&L (A-04) |
| M1-13 | Đạt | tích điểm/đổi điểm, hoàn đúng khi huỷ/trả |

### M3 Giá
| Mã | Mức | Ghi chú |
|---|---|---|
| M3-01 | Đạt | channel pos/online/b2b/all |
| M3-02 | Một phần | POS/B2B/MXH dùng nhóm; website bỏ nhóm (A-15) |
| M3-03 | Đạt | hàng loạt + hiệu lực tương lai (A-23 edge) |
| M3-04 | Đạt | giữ lịch sử, `/prices/history` |
| M3-05 | Một phần | lịch sử giá nhập theo lô/NCC có; so sánh NCC ngoài phạm vi kiểm sâu |
| M3-06 | Một phần | POS chặn dưới vốn + duyệt; B2B chỉ cảnh báo biên; website không kiểm; hiển thị lãi gộp chỉ role xem vốn |
| M3-07 | Đạt | `/prices/suggested` |
| M3-08 | Đạt | khuyến mãi theo thời gian + khung giờ + end_of_day |
| M3-09 | Đạt | pending → approval price.activate |
| M3-10 | Đạt | `applyBulkPrices` dùng lại cho M7 |

### M4 B2B
| Mã | Mức | Ghi chú |
|---|---|---|
| M4-01 | Đạt | contact/địa chỉ/MST (không kiểm sâu) |
| M4-02 | Một phần | gán nhóm/hạn mức/hạn TT có; quản lý nâng hạn mức né chủ (A-10) |
| M4-03 | Đạt | báo giá + duyệt khi giảm sâu/dưới vốn + PDF + gia hạn có lý do |
| M4-04 | Đạt | convert chặn hết hạn/trùng, kiểm hạn mức + nợ quá hạn trước khi giữ tồn |
| M4-05 | Đạt | giữ FEFO, soạn quét lô, phiếu giao |
| M4-06 | Đạt | thực giao/từ chối có lý do (A-27 chưa giao bổ sung) |
| M4-07 | Đạt | HĐ theo số thực giao, due theo payment_terms |
| M4-08 | Đạt | đơn lặp cron + tay, idempotent |
| M4-09 | Đạt | `/customers/:id/history`, debt |
| M4-10 | Đạt | owner_user_id |
| M4-11 | Đạt | shop B2B: giá theo nhóm, không thể override/credit |

### M5 Công nợ
| Mã | Mức | Ghi chú |
|---|---|---|
| M5-01 | Đạt | |
| M5-02 | Đạt | |
| M5-03 | Đạt | gạch cũ nhất/chỉ định, trigger chặn gạch vượt |
| M5-04 | Đạt | bucket cấu hình 30/60/90 |
| M5-05 | Đạt | chặn tại confirm (A-10) |
| M5-06 | Đạt | cron nhắc nợ (không kiểm sâu) |
| M5-07 | Đạt | sao kê CSV |
| M5-08 | Một phần | chiết khấu/xoá nợ/trừ trả hàng: trừ hàng trả mất khi đã thanh toán (A-01), không vào P&L (A-04) |
| M5-09 | Đạt | cấn trừ |

### M8 Website
| Mã | Mức | Ghi chú |
|---|---|---|
| M8-01 | Đạt | |
| M8-02 | Đạt | giỏ + địa chỉ + khung giờ + EC-11 price_changed |
| M8-03 | Đạt | tồn thật, hết hàng→preorder |
| M8-04 | Một phần | COD + VietQR; cổng chỉ giả lập (A-26) |
| M8-05 | Đạt | outbox email/push |
| M8-06 | Không kiểm | PWA ngoài phạm vi |
| M8-07 | Đạt | tài khoản, sổ địa chỉ, reorder |
| M8-08 | Đạt | preorder giữ chỗ khi hàng về, xác nhận chặn khi chưa đủ |
| M8-09 | Đạt | |
| M8-10 | Không kiểm | ngoài phạm vi |
| M8-11 | Đạt | voucher/điểm/KM chung engine (A-08) |

### EC
| EC | Mức | Ghi chú |
|---|---|---|
| EC-01 | Một phần | POS đúng lô/hao hụt; đổi hàng/chênh giá và trả online một phần thiếu (A-12/13) |
| EC-02 | Đạt | |
| EC-03 | Một phần | pack theo cân, ngưỡng 10%, khách xác nhận; chênh tiền trả trước không xử lý (A-02), NV không override (A-20) |
| EC-04 | Một phần | idempotent clientUuid; mất ngày/ca/giá (A-09) |
| EC-05 | Đạt | |
| EC-06 | Một phần | nhả/nhập lại đúng lô; phí giao theo policy (A-28) |
| EC-07 | Đạt | fail → redeliver/return, hao hụt ghi waste |
| EC-08 | Đạt | (A-21) |
| EC-09 | Đạt | B2B: HĐ điều chỉnh, chỉ quản lý; POS không có HĐĐT |
| EC-10 | Thiếu | A-13 |
| EC-11 | Đạt | |
| EC-12 | Đạt | cảnh báo biên khi convert |
| EC-13 | Một phần | ưu tiên priority đúng; riêng-khách chỉ B2B (A-22) |
| EC-14 | Đạt | giá vốn theo lô FEFO |
| EC-23 | Đạt | chặn chuẩn; nhưng quản lý có đường né (A-10) |
| EC-24 | Đạt | |
| EC-25 | Một phần | HĐ điều chỉnh + nhập kho đúng; công nợ âm mất (A-01) |
| EC-26 | Một phần | A-27 |
| EC-27 | Đạt | đổi địa chỉ sau soạn cần b2b.approve |
| EC-28 | Đạt | |
| EC-29 | Một phần | duyệt có; không vào P&L (A-04) |
| EC-31 | Một phần | đối soát theo đơn có, nhưng phí trừ đôi (A-03); không có báo cáo "đơn COD chưa đối soát" |
| EC-32 | Một phần | bắt lý do chênh; không có "người chịu trách nhiệm" |
| EC-33 | Một phần | phiếu quỹ khoá kỳ; đơn online/B2B sửa quá khứ được (A-05) |
| EC-34 | Một phần | điều chỉnh âm qua diff đợt đối soát; không có dòng âm riêng |

---------------------------------------------------------------------

## (c) Điểm theo module (1–10)

| Module | Điểm | Lý do |
|---|---|---|
| POS (bán/void/trả/chốt ca) | 8 | Idempotent, FEFO, CHECK chống bán đồng thời, trả/ void đúng lô và điểm/voucher, duyệt dưới giá vốn/giảm sâu có hash giỏ. Trừ điểm: void sau chốt ca và void đơn đặt trước làm lệch tiền ca (A-06/07), trả hàng không giới hạn (A-16), offline mất ngày/ca (A-09). |
| Website + đơn online | 7 | Máy trạng thái chặt có guard đồng thời, giữ/nhả tồn đúng ở mọi đường huỷ, auto-cancel cron, khớp sao kê an toàn. Trừ điểm: tổng đơn trả trước lệch sau cân (A-02), trả hàng xoá doanh thu quá khứ (A-05), dòng không mang giảm giá (A-08), không có trả một phần (A-12). |
| B2B (báo giá → giao → HĐ) | 8 | Quy trình đủ và đồng bộ: giá giữ theo báo giá, kiểm hạn mức trước giữ tồn, hoá đơn theo thực giao, HĐ điều chỉnh + nhập kho đúng lô, chốt chặn đồng thời. Trừ điểm: quản lý né override (A-10), không giao bổ sung (A-27), VAT lệch cơ sở (A-25). |
| Công nợ / thu tiền | 6.5 | Gạch FIFO, số dư có, trigger chống gạch vượt, đảo phiếu tốt. Nhưng công nợ âm do trả hàng sau thanh toán bị mất (A-01) và xoá nợ/chiết khấu không phản ánh vào lãi lỗ (A-04). |
| Khuyến mãi / voucher / điểm / giá | 7.5 | Engine dùng chung, sàn giá vốn, một KM tốt nhất, hoàn lượt/điểm idempotent bằng trigger. Trừ điểm: giá nhóm bỏ sót trên website (A-15), voucher POS ẩn danh (A-21), giá hẹn tương lai (A-23). |
| Đồng bộ liên luồng (quỹ / báo cáo) | 6 | Kho và tồn khớp rất tốt; tiền/quỹ/báo cáo có nhiều chỗ lệch: phí đối soát trừ đôi (A-03), số dư quỹ chỉ tính đơn hoàn tất (A-11), P&L bỏ qua thu khác/xoá nợ (A-04), online return sửa quá khứ (A-05). |
