# Audit nghiệp vụ B — Mua hàng → Kho → Giá vốn → Giá bán → Công nợ phải trả → Tài chính

Phạm vi: M2 Kho, M3 giá mua/giá bán, M5 phải trả NCC, M6 Tài chính, M7 Giá đối thủ, EC-15..EC-39 liên quan.
Phương pháp: đọc mã (src/worker/routes/{inventory,purchasing,prices,finance,finance-extra,debts,competitors,reports}.ts, services/{stock,reservations,debt,debt-ledger,finance-reports,pricing,vouchers}.ts, scheduled.ts, migrations 0001–0013) + probe test tạm (đã xoá). Không sửa repo.
Ghi chú xác minh: "CONFIRMED" = đã đọc mã và/hoặc chạy probe cho kết quả đúng như mô tả; "PLAUSIBLE" = suy ra từ mã, chưa chạy.

## (a) Bảng phát hiện

| ID | Mức | Module | File:dòng | Mô tả | Kịch bản | Đề xuất sửa | Trạng thái |
|----|-----|--------|-----------|-------|----------|-------------|-----------|
| B-01 | Cao | M5/M6 | src/worker/services/debt-ledger.ts:182 (voucherStmt luôn 'posted'); routes/debts.ts:224; so với routes/finance.ts:~83 (ngưỡng approval.cash_out_vnd) | Chi trả NCC qua `/debts/payments` (direction=out) tạo phiếu chi `posted` ngay, bỏ qua ngưỡng duyệt chi 5tr mà `/vouchers` áp dụng. Vai trò accountant (debt.write) tự chi mọi số tiền. Spec M6: "khoản chi vượt ngưỡng cần người duyệt". | Kế toán chi 60.000.000đ tiền mặt cho NCC → 201, phiếu `posted`, không có approval. Cùng số tiền qua `/vouchers` thì phải chờ duyệt. Probe P3: voucher status=posted, amount=60.000.000. | Áp cùng ngưỡng: nếu out > ngưỡng và user không có finance.approve → tạo debt_payment + voucher ở `pending_approval` (hoặc chặn), gạch nợ sau khi duyệt. | CONFIRMED |
| B-02 | Cao | M2 Kho (kiểm kê) | routes/inventory.ts:196 (snapshot doc_qty khi thêm dòng) vs :373-377 (tính diff theo tồn hiện tại khi post) | Phiếu kiểm kê lưu số đếm tại thời điểm T nhưng khi post tính chênh lệch so với tồn lúc post và ghi đè doc_qty. Mọi biến động kho giữa lúc đếm và lúc post (bán, hao hụt) biến thành chênh lệch ảo. Không khóa nhập/xuất lô đang kiểm kê (EC-18 yêu cầu khóa hoặc cảnh báo). | Lô 20kg, đếm đúng 20kg; sau đó hao hụt 1kg (tồn 19) rồi post phiếu kiểm kê → hệ thống cộng +1kg "thừa" (tồn về 20). Probe P1: on_hand sau post = 20000 (đúng phải 19000). Bán lẻ cùng lô giữa chừng cho kết quả tương tự, làm sai tồn, giá trị tồn và COGS. | Lưu `doc_qty_milli` lúc đếm và tính diff = counted − snapshot (cộng/trừ delta thay vì ghi đè về counted); hoặc chặn bán/xuất lô đang có phiếu kiểm kê mở; cảnh báo nếu tồn lô đổi sau snapshot. | CONFIRMED |
| B-03 | Nghiêm trọng | M2 (EC-15) | services/reservations.ts:168-195 (swapBadReservations); scheduled.ts:84-92 (chỉ cron 08:00); routes/inventory.ts:391-396 (chặn waste/adjust/count vượt `on_hand − reserved`) | EC-15 (Critical) thực hiện thiếu: (1) Lô hỏng giữa ngày đang được giữ cho đơn B2B/online KHÔNG thể ghi hao hụt, giảm điều chỉnh hay kiểm kê giảm, vì `out > on_hand − reserved` bị từ chối (409) hoặc CHECK reserved≤on_hand; không có chức năng "đánh dấu lô hỏng/quarantine" (status quarantine không bao giờ được set) nên swap không thể kích hoạt. (2) swap chỉ chạy 1 lần/ngày lúc 08:00 VN và cứng store 1, KHÔNG được gọi khi ghi hao hụt dù comment ghi "gọi khi ghi hao hụt một lô". (3) "Báo ngay" chỉ ghi sysAudit, không có thông báo/push cho người xử lý đơn. | Táo giữ 20kg cho đơn sỉ, kiểm tra thấy cả lô dập. Thủ kho lập phiếu hao hụt 5kg → 409 insufficient_stock; kiểm kê về 10kg → 409 constraint_violation (probe P2). Hàng hỏng vẫn nằm trong tồn và vẫn được giao. | Thêm thao tác "đánh dấu lô hỏng" (status=quarantine) gọi swapBadReservations ngay (chạy theo store của lô) rồi cho phép waste; gọi swap sau mỗi phiếu waste/adjust/count có lô đang giữ; gửi thông báo (push/email) khi thiếu hàng. | CONFIRMED |
| B-04 | Cao | M2/M4 giao hàng | services/reservations.ts:72-84 (activeReservations không lọc hạn/status), :119-165 (consumeForDeliveryStmts); b2b.ts:395; online-ops.ts:164 | Khi giao hàng, hệ thống tiêu thụ đúng các lô đã giữ mà không kiểm tra lô còn hạn/active. Lô hết hạn vẫn được xuất bán cho đến khi cron 08:00 đổi lô. Vi phạm quy tắc "Lô hết hạn không được bán". | Lô có hạn là timestamp trong ngày (shelf_life_days → hạn = giờ nhập + N ngày) hết hạn lúc 14:00; đơn sỉ giao lúc 15:00 → vẫn xuất lô đó, COGS ghi bình thường. Lô hạn 23:59 hôm trước vẫn giao được từ 00:00 đến 08:00. | Trong consumeForDelivery gọi kiểm tra isExpired/status; nếu hỏng thì tự swap sang lô khác (FEFO) hoặc chặn kèm báo thiếu. | CONFIRMED (đọc mã) |
| B-05 | Cao | M6-03 Đối soát COD/sàn | routes/debts.ts:824-866 (settlements/:id/confirm) | Số `received` (thực nhận, đã trừ phí theo công thức diff = received − (expected − fee)) được ghi phiếu thu vào quỹ thật, rồi phí `fee` lại ghi phiếu chi từ chính quỹ đó → phí bị trừ 2 lần khỏi quỹ thật. Quỹ ngân hàng trên hệ thống thấp hơn sao kê đúng bằng phí. | Đợt đối soát expected 1.000.000, fee 20.000, received 980.000 (ngân hàng thực nhận 980.000): hệ thống ghi in 980.000 + out 20.000 → số dư quỹ NH +960.000. Probe P5: balance = 960000. Quỹ chờ −1.000.000 → tổng tiền toàn hệ thống mất thêm 20.000 mỗi đợt; test hiện hành khẳng định sai hành vi này (sec-integrity-finance.test.ts:197-199). | Phiếu thu = received + fee (tổng gộp), phiếu chi phí = fee; hoặc chỉ ghi thu received và ghi phí vào chi phí qua chứng từ không đụng quỹ. Cập nhật test. | CONFIRMED |
| B-06 | Cao | M6-04 P&L / M2 | routes/reports.ts:54-72, services/finance-reports.ts:25-41 (shrinkage), routes/finance-extra.ts budget | Spec M6: "Hao hụt và chênh lệch kiểm kho ghi vào chi phí". P&L chỉ tính hao hụt `move_type='waste'` (và hàng trả không nhập kho); các move `adjust` (kiểm kê/điều chỉnh giảm) không vào P&L. Giá trị tồn giảm nhưng lãi lỗ không phản ánh; tăng (kiểm kê thừa) cũng không ghi nhận. | Kiểm kê mất 5kg×110.000 = 550.000: tồn kho giảm 550.000, P&L không đổi (probe P6: expenses chỉ có opex 20.000, stockValue 550.000). Báo cáo tồn kho và lãi lỗ không đối chiếu được. | Thêm khoản "chênh lệch kiểm kê" (±) vào shrinkage = Σ(−qty_delta × unit_cost) với move_type='adjust'; dùng chung ở reports.ts, finance-reports.ts, budget-vs-actual. | CONFIRMED |
| B-07 | Trung bình | M6-08 VAT | routes/finance-extra.ts:117 (đọc supplier_bills.vat_amount); không có nơi nào ghi cột này (migration 0005:591 thêm cột; debts.ts finalize không nhận VAT) | VAT đầu vào luôn = 0 vì không có luồng nhập thuế GTGT trên hóa đơn mua (phiếu nhập, finalize bill, số dư đầu kỳ). `payable` = VAT đầu ra. | Nhập hàng có hóa đơn VAT 10% 1.100.000: báo cáo VAT input.vat = 0 (probe P6). | Thêm `vatAmount` vào receipt header/finalize bill, lưu vào supplier_bills.vat_amount. | CONFIRMED |
| B-08 | Cao | M6-09 Khóa sổ / EC-33 | migrations/0001_init.sql:408-413 (chỉ trigger cash_vouchers); routes/pos.ts:~723 (void POS); routes/finance.ts:193-210 (lock không kiểm tra kỳ) | Khóa kỳ chỉ chặn `cash_vouchers` (và huỷ đơn POS). Không chặn: chốt hóa đơn mua tạm (`/bills/:id/finalize` đổi total, đổi VAT/AP của kỳ đã khóa), điều chỉnh công nợ (discount/write_off/offset — không tạo phiếu quỹ), gạch nợ, đảo/huỷ đơn B2B/online kỳ cũ. Có thể khóa cả kỳ hiện tại/tương lai: khi đó mọi phiếu thu/chi/thu nợ/đối soát trả 423 nhưng bán hàng, nhập kho vẫn chạy → số liệu trong kỳ "đã khóa" tiếp tục thay đổi. | Khóa kỳ hiện tại rồi finalize bill tạm → 200 (probe P4), nhập kho vẫn post, voucher bị 423. Chốt hóa đơn tháng 10 sau khi đã khóa tháng 10 → AP/VAT tháng 10 đổi. | Một hàm assertPeriodOpen dùng chung cho finalize bill, debt_adjustments, order void/cancel kênh khác, stock doc (theo ngày chứng từ); chặn khóa kỳ chưa kết thúc/ngoài thứ tự; phiếu chi pending duyệt sau khi khóa cần đường từ chối. | CONFIRMED |
| B-09 | Trung bình | M5 EC-30 / M2 | routes/debts.ts:187-205 (finalize) | Chốt hóa đơn tạm khác giá chốt chỉ đổi `supplier_bills.total`; `lots.unit_cost`, giá trị tồn và COGS giữ giá cũ; không ghi chênh lệch giá mua (purchase price variance) ở đâu ngoài audit. AP ≠ giá trị lô nhập. | Nhập 20kg×50.000 (bill 1.000.000); NCC xuất hóa đơn 900.000, finalize total=900.000: lô vẫn unit_cost 50.000 (probe P4). | Phân bổ chênh lệch vào unit_cost các lô còn tồn / ghi khoản chênh lệch giá mua vào P&L; lưu bản ghi chênh lệch có lý do. | CONFIRMED |
| B-10 | Trung bình | M2-05/M2-07 duyệt | routes/inventory.ts:368-381 (count không kiểm creatorCanApprove, không bắt lý do) so với :405,:411 | Spec: "mọi thay đổi tồn đi qua phiếu có lý do và người duyệt". Phiếu kiểm kê dưới ngưỡng 1.000.000 do thủ kho tự lập tự post, không có người duyệt, không lý do; chia nhỏ nhiều phiếu <1tr để né ngưỡng. Phiếu adjust thì có kiểm tra quyền duyệt. Ngưỡng tính theo từng phiếu, không cộng dồn theo lô/ngày. | Thủ kho kiểm kê lô giá trị 900.000 về 0, post ngay (inventory.write) — không ai duyệt. | Yêu cầu approver cho count có chênh lệch ≠ 0 (hoặc lũy kế/ngày), bắt buộc lý do dòng chênh. | CONFIRMED |
| B-11 | Trung bình | M6-04 P&L | routes/reports.ts:54-67; services/finance-reports.ts:12-21 | Công thức chi phí chỉ cộng phiếu `out` và trừ phiếu đảo của phiếu out; phiếu thu `in` (THU_KHAC, pnl_line 'other') không được tính vào lãi lỗ, còn phiếu ĐẢO một phiếu thu (direction out, reverses_id) lại bị cộng thành chi phí. | Thu khác 2.000.000 → P&L không tăng; đảo phiếu thu nhầm đó → chi phí +2.000.000, lợi nhuận giảm dù thu chưa từng được tính. | Tính "thu khác" (in, pnl_line other) vào doanh thu khác và xử lý đảo theo hướng gốc (reverses_id ⇒ dấu theo hướng phiếu gốc). | CONFIRMED (đọc mã) |
| B-12 | Trung bình | M2-02/M5-02/EC-16 | Không có route: huỷ hóa đơn mua / trả hàng NCC; supplier_bills.status 'cancelled' không được set ở đâu (grep); stock-docs/cancel chỉ cho draft/pending | Phiếu nhập đã post không có luồng đảo (trả hàng NCC, nhập nhầm): không có phiếu xuất trả NCC, không có debit note giảm công nợ phải trả; chỉ có waste + discount adjustment (không gắn nguồn). Hàng "từ chối nhận" chỉ xử lý được bằng cách xoá dòng trước khi post (mất dấu chênh lệch vì doc_qty biến mất). | Nhập nhầm 100kg → đã post; không đảo được bill, buộc xoá nợ bằng "discount" cần chủ duyệt và lệch kho. | Thêm phiếu "trả hàng NCC" (xuất kho theo lô + giảm bill/ghi giảm công nợ), và ghi nhận dòng từ chối (qty=0 + lý do) thay vì chặn 422. | CONFIRMED |
| B-13 | Trung bình | M6-03 / EC-31 | routes/debts.ts:838-862, 779-809 | (1) Dòng đối soát chỉ có `externalOrderId` (đơn sàn không map orderId) không sinh phiếu chuyển khỏi quỹ chờ → quỹ chờ không về 0 trong khi tiền thật đã vào. (2) `diff_amount` chỉ lưu trên settlement, không có bút toán/ P&L cho phần thiếu: doanh thu COD ghi theo đơn nhưng tiền không về đủ → lãi lỗ cao hơn thực tế. (3) Không kiểm tra quỹ đích là quỹ thật (có thể chọn quỹ chờ). | COD thiếu 10k đã có lý do → không ghi chi phí; doanh thu trên P&L vẫn đủ. | Ghi chênh lệch thành chi phí/ thu khác có danh mục riêng; map đơn bắt buộc hoặc truy đơn; validate loại quỹ. | PLAUSIBLE |
| B-14 | Thấp | M2-08 Báo cáo | routes/reports.ts:131-137; routes/exports.ts:148-152 | Báo cáo nhập-xuất-tồn không có cột cho `assemble_in/assemble_out` (lắp giỏ quà, bundle-assembly.ts:48-56) nên Tồn đầu + Nhập − Bán + ... ≠ Tồn cuối khi có lắp ráp. | Lắp 5 giỏ quà: tồn cuối đúng nhưng các cột thành phần không cân. | Thêm cột "lắp ráp (vào/ra)" hoặc gộp vào nhập/xuất. | CONFIRMED (đọc mã) |
| B-15 | Trung bình | M7 (EC-36/EC-37) | routes/competitors.ts:455-476 (comparison không lọc in_stock); services/competitor-crawler.ts:240-246 (outlier cần ≥3 giá tham chiếu) | Giá của quan sát "hết hàng" (in_stock=0) vẫn nằm trong min/avg thị trường và gợi ý giá (EC-36 yêu cầu loại giá hết hàng hiện giá cũ). Quan sát đầu tiên của mặt hàng mới (≤2 tham chiếu) không bao giờ bị đánh dấu bất thường nên đi thẳng vào so sánh. | Đối thủ để giá cũ 40.000 cho hàng hết → "market min" thấp, gợi ý hạ giá (chỉ chặn bởi giá sàn). | Lọc `in_stock = 0` khỏi comparison/suggestions (hoặc cho người duyệt); áp ngưỡng bất thường theo nhóm/giá bán của ta khi thiếu tham chiếu. | CONFIRMED (đọc mã) |
| B-16 | Trung bình | Sao lưu R2 | scheduled.ts:64-84 | Bản sao lưu R2 thiếu nhiều bảng sổ nghiệp vụ: supplier_bills, debt_payments, debt_allocations, debt_adjustments, invoices/invoice_lines, reservations, deliveries, bank_transactions, settlements, quotes, budgets, mọi bảng HR/lương, khuyến mãi, đối thủ... → "lớp sao lưu thứ hai" không khôi phục được công nợ. Mỗi bảng `SELECT *` nạp toàn bộ vào RAM (audit_log lớn sẽ vượt giới hạn Worker), vòng lặp không bọc try/catch từng bảng (một lỗi bỏ qua phần còn lại), không có retention (ghi chồng mỗi ngày) và không có công cụ restore. | Sau sự cố, khôi phục từ R2 mất toàn bộ công nợ phải thu/phải trả và hóa đơn. | Thêm các bảng còn thiếu (dùng sqlite_master để liệt kê), phân trang theo rowid, bọc từng bảng, xóa bản cũ >N ngày, tài liệu restore. | CONFIRMED |
| B-17 | Thấp | M5 danh sách thu/chi | routes/debts.ts:291-292 | Lọc `from/to` của /debts/payments dùng `substr(paid_at,1,10)` (ngày UTC) trong khi sao kê dùng vnDate → phiếu 00:00–07:00 VN rơi sang ngày trước; hai màn hình lệch nhau. | Chi NCC 03:00 sáng 25/11 VN hiện trong ngày 24/11. | Dùng vnDayRangeUtc. | CONFIRMED (đọc mã) |
| B-18 | Thấp | M2/M3 làm tròn | routes/inventory.ts:178 (unit_cost nguyên VND/đv chính), reports.ts:137-140 & finance-reports.ts:27 (chia số nguyên SQL cắt cụt) so với money.ts (Math.round) | Đơn giá lô lưu nguyên đồng/đơn vị chính nên quy đổi thùng→kg bị làm tròn (bill = round(qty×giá thùng), giá trị lô = unit_cost×qty): chênh vài chục đồng mỗi phiếu giữa AP và giá trị tồn; báo cáo SQL cắt cụt từng dòng, COGS ở code làm tròn từng lô → tổng lệch vài đồng. | 3 thùng×155.555đ (10kg/thùng): bill 466.665, giá trị lô 466.680. | Lưu giá vốn theo milli-đồng hoặc ghi chênh lệch làm tròn; thống nhất cách làm tròn. | CONFIRMED (đọc mã) |
| B-19 | Thấp | M2-10 / EC-21 | routes/inventory.ts:419-431 | Chuyển kho là tức thời (transfer_out + lô mới transfer_in), không có trạng thái "đang chuyển"; lô mới mang qty_in = số chuyển nên hao hụt % tính lại từ đầu; không kiểm tra `lot.status`. Hiện 1 cửa hàng nên rủi ro thấp. | Chuyển quầy → kho lạnh rồi mất hàng không thể ghi "đang chuyển". | Thêm transfer 2 bước (xuất/nhận) khi mở thêm cửa hàng. | CONFIRMED |
| B-20 | Trung bình | M2 EC-22 | products.merged_into chỉ được đọc (grep): không có route gộp sản phẩm | EC-22 (Cao) chưa có: không có thao tác gộp mã trùng có lưu vết, di chuyển lô/giá/lịch sử. | Hai mã "Táo Envy" trùng không gộp được. | Thêm endpoint merge (chuyển lots, product_units, prices, matches; set merged_into; audit). | CONFIRMED |
| B-21 | Trung bình | M6-08 VAT | routes/debts.ts:468 (invoices số dư đầu kỳ, subtotal=total, issue_date=hôm nay); finance-extra.ts:108-120 | Số dư đầu kỳ nhập dưới dạng `invoices`/`supplier_bills` bình thường nên bị cộng vào cơ sở tính VAT đầu ra/đầu vào của tháng nhập (khác nhau: base đầu ra gồm công nợ cũ, count tăng). Ngoài ra VAT đầu ra chỉ từ hóa đơn B2B, doanh thu POS/online không có trong báo cáo VAT nên không đối chiếu được với doanh thu P&L (VAT summary ≠ sales report). | Nhập 100tr số dư đầu kỳ khách → VAT output.base +100tr. | Loại hóa đơn có note 'Số dư đầu kỳ' (hoặc cờ is_opening) khỏi VAT; ghi rõ phạm vi báo cáo. | CONFIRMED (đọc mã) / phần retail PLAUSIBLE |
| B-22 | Thấp | M6 phiếu chờ duyệt | services/vouchers.ts:10-24; finance.ts:~97; trigger vouchers_locked_update | Phiếu chi `pending_approval` của kỳ đã khóa không thể duyệt (UPDATE bị trigger chặn 423) và không có đường huỷ/từ chối phiếu pending (status 'cancelled' có trong CHECK nhưng không có route), nên kẹt vĩnh viễn. | Tạo phiếu chi 8tr ngày 30, khóa sổ ngày 31, chủ duyệt → 423. | Cho từ chối/huỷ phiếu pending; duyệt phiếu cũ chuyển sang kỳ hiện tại. | PLAUSIBLE |
| B-23 | Thấp | M3-06 giá vốn tham chiếu | services/pricing.ts:42-52 | `currentAvgCost` bình quân mọi lô active ở mọi vị trí (kể cả khu hàng hỏng không bán được, phần đã giữ), dùng để cảnh báo bán dưới vốn, giá sàn gợi ý M7 và đổi giá hàng loạt. | Lô hỏng giá cao ở kho "HONG" làm giá vốn tham chiếu cao. | Lọc `locations.sellable = 1`. | PLAUSIBLE |
| B-24 | Thấp | M3-03 đổi giá | routes/prices.ts:218-228, 259-264 | Hai lần đổi giá hàng loạt có hẹn giờ ngược thứ tự (lần 2 hẹn sớm hơn lần 1): dòng hiệu lực ở tương lai của lần 1 không bị đóng nên sau thời điểm đó giá của lệnh cũ ghi đè lệnh mới; phê duyệt giá pending cũng không xử lý dòng tương lai. | Đặt 10/12 giá 60.000 rồi đặt 5/12 giá 55.000 → từ 10/12 vẫn là 60.000. | Khi chèn, đóng/huỷ mọi dòng active có effective_from > from trong cùng bảng giá/sản phẩm, hoặc cảnh báo. | PLAUSIBLE |

Số liệu: Nghiêm trọng 1, Cao 6, Trung bình 10, Thấp 7 (tổng 24).

## (b) Độ phủ spec

### M2 Kho
| Mã | Kết quả | Ghi chú |
|----|---------|---------|
| M2-01 Danh mục, đơn vị quy đổi | Đạt | product_units.factor_milli, unitFactor dùng nhất quán (milli). Xem B-18 về làm tròn. |
| M2-02 Nhập kho theo phiếu | Một phần | Có NCC, SL, giá nhập, ngày; ghi doc_qty vs thực nhận. Hàng từ chối phải xoá dòng (zero_qty), không ghi lý do (B-12). |
| M2-03 Lô, hạn dùng | Đạt | lot_code HML…, expires_at (ngày → 23:59 VN), shelf_life. |
| M2-04 FEFO | Đạt | allocateFefo loại lô hết hạn/ không bán được; CHECK chặn bán đồng thời. Giao hàng lô giữ chỗ không kiểm hạn (B-04). |
| M2-05 Hao hụt + lý do + duyệt | Một phần | Có lý do, duyệt >5% (theo lô, cộng dồn); không ghi được cho lô đang giữ (B-03). |
| M2-06 Giữ chỗ | Một phần | reservations + CHECK; EC-15 xử lý thiếu (B-03). |
| M2-07 Kiểm kê, điều chỉnh | Một phần | Có phiếu count/adjust, ngưỡng 1tr; snapshot sai (B-02), không duyệt dưới ngưỡng (B-10). |
| M2-08 Báo cáo | Một phần | Thẻ kho, nhập-xuất-tồn, hao hụt; không cân khi lắp ráp (B-14); kiểm kê không vào P&L (B-06). |
| M2-09 Cảnh báo tồn tối thiểu/hết hạn | Đạt | /stock/alerts (hạn 2 ngày cố định; tồn tối thiểu không trừ phần giữ). |
| M2-10 Chuyển kho | Một phần | Có chuyển tức thời; không trạng thái đang chuyển (B-19). |
| M2-11 Gợi ý đặt hàng | Đạt | Tốc độ bán × (lead+cover) − tồn khả dụng, loại lô sắp hết hạn, làm tròn đơn vị đặt, to-receipt. Không có PO riêng (spec không yêu cầu). |
| M2-12 In tem | Đạt (không kiểm sâu) | Mã lô có sẵn; thuộc scope UI. |
| M2-13..M2-16 Quét mã, cảnh báo | Đạt | scan receipt/waste/adjust/transfer/count; ghi scan_events (người, thiết bị); unknown/not_in_doc/duplicate/expired. |
| M2-17 Kiểm kê quét | Đạt | scan count cộng dồn theo lô. |
| M2-18 App quét | Đạt (UI ngoài scope) | |
| M2-19 Truy xuất lô | Đạt | /stock/lots/:code/trace (nhập, di chuyển, đơn bán). |
| Quy tắc: không sửa tồn trực tiếp | Một phần | Mọi đổi tồn qua stock_moves; count dưới ngưỡng không có người duyệt (B-10). |
| Quy tắc: chênh lệch nhập ảnh hưởng công nợ | Đạt | bill = thực nhận × giá. |
| Quy tắc: hao hụt >5% báo quản lý | Đạt | approval.waste_pct_bp. |
| Quy tắc: lô hết hạn không bán | Một phần | POS đúng; giao hàng giữ chỗ chưa (B-04). |
| EC-15 | Thiếu/Một phần | B-03. |
| EC-16 | Một phần | Có chênh lệch ghi nhận + điều chỉnh bill; từ chối nhận/trả NCC thiếu (B-12). |
| EC-17 | Một phần | Có nhập tay qua dòng, scan_events; chưa cảnh báo nhập tay quá nhiều. |
| EC-18 | Thiếu | Không khóa/cảnh báo lô đang kiểm kê (B-02); chỉ chặn post trùng. |
| EC-19 | Một phần | doc_qty vs qty tạo chênh lệch/ lô; "ghi phần hụt là hao cân" chưa tự tạo hao hụt. |
| EC-20 | Một phần | Có ngưỡng chủ duyệt; không bắt xem lịch sử, ngưỡng theo phiếu (B-10). |
| EC-21 | Thiếu | B-19. |
| EC-22 | Thiếu | B-20. |

### M3 (giá mua / giá bán thuộc phạm vi)
| Mã | Kết quả | Ghi chú |
|----|---------|---------|
| M3-01/02 Bảng giá kênh, nhóm | Đạt | price_lists channel/group/priority, resolvePrice. |
| M3-03 Đổi giá hàng loạt + hiệu lực | Đạt (lưu ý B-24) | Không ghi đè lịch sử quá khứ. |
| M3-04 Lịch sử giá bán/mua | Đạt | /prices/history gồm purchases theo lô. |
| M3-05 Giá mua theo NCC/lô, so sánh NCC | Một phần | Có danh sách mua theo lô + NCC; chưa có endpoint so sánh/ xếp hạng giữa NCC (UI tự so). |
| M3-06 Lãi gộp, cảnh báo dưới vốn | Một phần | Cảnh báo ở bulk (belowCost) và POS; giá vốn tham chiếu lấy mọi vị trí (B-23). |
| M3-07 Giá đề xuất theo biên | Đạt | /prices/suggested, priceFloor. |
| M3-09 Duyệt đổi giá | Đạt | pending + approvals; tự duyệt bị chặn (trừ chủ). |
| M3-10 Gợi ý từ M7 | Đạt | price-suggestions/accept qua applyBulkPrices, không tự đổi giá. |
| Quy tắc: đơn chốt giữ giá | Đạt | order_lines.unit_price. |

### M5 (phải trả NCC)
| Mã | Kết quả | Ghi chú |
|----|---------|---------|
| M5-02 Phải trả theo NCC/phiếu nhập | Đạt | supplier_bills sinh trong cùng batch với phiếu nhập. |
| M5-03 Chi và gạch nợ | Đạt (B-01) | Trigger chặn gạch vượt; idempotency; đảo phiếu có phiếu quỹ ngược. |
| M5-04 Tuổi nợ | Đạt | debt.aging_buckets; as-of dùng số còn nợ hiện tại (không tái tạo lịch sử). |
| M5-07 Sao kê | Đạt | NCC dùng bills + payments + adjustments. |
| M5-08 Điều chỉnh/chiết khấu/xóa nợ duyệt | Đạt | ngưỡng approval.writeoff_vnd (mặc định 0 → mọi khoản phải chủ duyệt). Không kiểm kỳ khóa (B-08). |
| M5-09 Cấn trừ | Đạt | offset khách↔NCC cùng đối tác. |
| Quy tắc: nợ chỉ sinh từ chứng từ, đầu kỳ khóa 1 lần | Đạt | opening_balances_lock (nhưng B-21). |
| EC-30 hóa đơn tạm | Một phần | Có is_provisional + finalize; không cập nhật giá vốn (B-09). |

### M6
| Mã | Kết quả | Ghi chú |
|----|---------|---------|
| M6-01 Quỹ | Một phần | funds + số dư = payments + phiếu (đảo tính 1 lần, khớp cash-flow); không có số dư đầu quỹ riêng. |
| M6-02 Phiếu thu chi theo danh mục | Đạt | Có người tạo, ngưỡng 5tr, pending→duyệt, đảo thay vì sửa. Chi NCC/COD bỏ qua ngưỡng (B-01). |
| M6-03 Đối soát (ca, ngân hàng, COD, sàn) | Một phần | Ca/ngân hàng tự match tốt; COD/sàn trừ phí kép (B-05), chênh lệch không ghi sổ (B-13). |
| M6-04 P&L ngày/tháng/kênh/nhóm hàng | Một phần | Doanh thu/COGS khớp giữa /reports/pnl và pnl-by-channel (cùng điều kiện completed_at); danh mục transfer đã loại. Thiếu kiểm kê (B-06), thu khác (B-11). |
| M6-05 Xuất Excel | Một phần | CSV + exports.ts (không đánh giá mẫu kế toán). |
| M6-06 Phân bổ chi phí theo kênh | Đạt | cost_allocation_rules, allocate(). |
| M6-07 Dòng tiền | Đạt | Loại quỹ chờ khỏi tổng, khớp /funds. |
| M6-08 VAT | Một phần | B-07, B-21. |
| M6-09 Khóa sổ | Một phần | B-08. |
| M6-10 Ngân sách | Đạt | budget-vs-actual (cùng nguồn voucherCosts/shrinkage nên kế thừa B-06/B-11). |
| Quy tắc: hao hụt/kiểm kê vào chi phí | Một phần | B-06. |
| EC-32 chốt ca lệch | Đạt (ngoài chi tiết) | diff_cash + diff_reason. |
| EC-33 sau khóa chỉ bút toán điều chỉnh | Một phần | Voucher đúng (đảo ghi kỳ hiện tại); các đường khác chưa (B-08). |
| EC-34 hoàn tiền sàn sau đối soát | Một phần | Không có luồng riêng; có thể dùng phiếu đảo/chi. |
| EC-24, EC-29, EC-31 | Đạt/Một phần | EC-24 (bank-transactions chờ đối chiếu) đạt; EC-29 đạt (chủ duyệt, lý do; báo cáo P&L chưa có dòng xoá nợ/chiết khấu — PLAUSIBLE); EC-31 một phần (B-13). |

### M7
| Mã | Kết quả | Ghi chú |
|----|---------|---------|
| M7-01 Cấu hình đối thủ/nguồn | Đạt | competitors, competitor_sources, SSRF check (isPublicHttpUrl). |
| M7-02 Thu thập theo lịch | Đạt | cron */30, robots.txt (cache 24h), rate limit, min_delay. |
| M7-03 Ghép SP, người duyệt | Đạt | product_matches status approved. |
| M7-04 Chuẩn hóa đơn vị | Đạt | unitPriceOf/unitsCompatible. |
| M7-05 Bảng so sánh | Một phần | Có min/avg/diff% + thời điểm quan sát; bao gồm hàng hết (B-15). |
| M7-06 Nhập thủ công/import | Đạt | kind manual. |
| M7-07 Giám sát lỗi | Đạt | consecutive_failures, alert source_failed. |
| M7-08 Lịch sử giá | Đạt | competitor_price_obs. |
| M7-09 Cảnh báo | Đạt | big_change, competitor_cheaper, outlier. |
| M7-10 Gợi ý sang M3 | Đạt | Chỉ gợi ý; chặn giá dưới giá sàn khi accept; đi qua duyệt giá. |
| EC-35, EC-36, EC-37, EC-38 | Đạt/Một phần | EC-36 một phần (B-15); EC-38 (xung đột sửa đồng thời bảng giá) chưa kiểm tra sâu — bảng giá append-only nên ít rủi ro. |

## (c) Điểm theo module (1–10)

- M2 Kho: 6/10. Lõi lô/FEFO/CHECK/ghi sổ bằng batch + post guard chắc chắn, nhưng kiểm kê dùng snapshot sai (B-02), lô đang giữ chỗ không thể ghi hao hụt (B-03) và giao hàng không kiểm hạn (B-04); EC-18/21/22 thiếu.
- M3 Giá bán & giá mua: 8/10. Lịch sử giá, duyệt, hiệu lực tương lai, giá sàn M7 đúng; thiếu so sánh NCC tường minh và vài edge nhỏ (B-23, B-24).
- M5 Phải trả NCC: 6.5/10. Mô hình bill/allocation/aging chặt (trigger chống gạch vượt, idempotency); nhưng chi NCC lách ngưỡng duyệt (B-01), chốt bill không đổi giá vốn (B-09), không có trả hàng/huỷ bill (B-12), VAT đầu vào trống (B-07).
- M6 Tài chính: 5.5/10. Quỹ/dòng tiền/ P&L theo kênh khớp nhau và loại transfer đúng; nhưng đối soát COD trừ phí kép (B-05), kiểm kê/thu khác không vào P&L (B-06, B-11), khóa sổ chỉ chặn phiếu quỹ (B-08), sao lưu R2 thiếu sổ công nợ (B-16).
- M7 Giá đối thủ: 8/10. Thu thập tuân thủ robots/SSRF, ghép có duyệt, outlier, cảnh báo, gợi ý đi qua M3 đúng nguyên tắc "chỉ gợi ý"; điểm trừ: giá hết hàng và outlier cần ≥3 tham chiếu (B-15).

## Phụ lục — kiểm chứng đã chạy
- P1 (B-02): on_hand sau post kiểm kê = 20000 thay vì 19000.
- P2 (B-03): waste lô giữ chỗ → 409 insufficient_stock; count thấp hơn reserved → 409 constraint_violation.
- P3 (B-01): chi NCC 60.000.000đ qua /debts/payments → 201, voucher posted.
- P4 (B-08, B-09): sau khóa kỳ hiện tại, finalize bill → 200; nhập kho post vẫn OK; lô unit_cost không đổi sau finalize giảm giá.
- P5 (B-05): quỹ NH sau đối soát (received 980.000, fee 20.000) = 960.000.
- P6 (B-06, B-07): kiểm kê mất 5kg×110.000 không xuất hiện trong P&L; VAT input vat = 0 dù có hóa đơn nhập.
- Đã xóa mọi bản sao test/zz-auditB-*.test.ts khỏi repo; không thay đổi file nào khác (test/zz-auditC-probe*.test.ts là của agent khác).
