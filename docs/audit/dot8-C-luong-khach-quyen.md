# Audit C — Lương/hoa hồng, khách lẻ, phân quyền (PR #23, nhánh `claude/audit-c`, 27/11/2026)

Phạm vi: mã mới trong `git diff origin/main...HEAD`: các route pos-credit, pos-delivery, retail-customers, sales-reports, commission, shift-report, fund-transfers, imports, charge-types, orders meta, products `ids`, online-orders `source`; phần hoa hồng trong payroll/payroll-calc.
Cách làm: đọc mã, rồi viết test thăm dò `test/probe-c-perm.test.ts` trong worktree `/home/user/wt-audit-c` (không commit). 9 test đều chạy được và tái hiện đúng các hành vi nêu dưới đây. Chạy lại: `npx vitest run test/probe-c-perm.test.ts --silent=false --reporter=verbose`.

Kết luận chung: **không có lỗi Nghiêm trọng hoặc Cao.** Mọi route mới đều có `requirePerm` (hoặc middleware kiểm quyền tương đương) và validate bằng zod. Thu ngân không tự nâng được hạn mức và không tự duyệt được ghi nợ. Thu ngân xem ca của người khác thì nhận 404. Giá vốn chỉ trả khi có `prices.view_cost`. Còn lại **7 lỗi mức Trung bình và 4 lỗi mức Thấp**, chủ yếu là lộ thông tin cá nhân (PII) hoặc tạm ứng lương, và lỗ hổng trong luồng duyệt/hoa hồng.

---

## Trung bình

### C2-01. Thu ngân và thủ kho xem được đầy đủ SĐT và địa chỉ người nhận qua `GET /orders/:id`
- **File:** `src/worker/routes/pos.ts:272`, trong `getOrderFull`: `const { customer_phone, cost_total, ...rest } = o`. Biến `rest` vẫn giữ `receiver_phone` và `ship_address` của `orders.*`, không che. Danh sách `/orders` thì có che (dòng 722 và 731), nhưng chi tiết đơn thì không.
- **Kịch bản:** thu ngân tạo đơn giao từ quầy (B3), hoặc mở bất kỳ đơn online/social nào, rồi gọi `GET /orders/:id`. Kết quả trả `receiver_phone: "0987654321"` và địa chỉ đầy đủ. Vai trò `warehouse` (có `orders.view`, không có `customers.view_pii`) cũng thấy như vậy. `/pos/receipt/:id` không bị.
- **Tái hiện:** có (P1).
- **Ghi chú:** lỗi đã có từ trước với đơn online. PR #23 làm rộng thêm vì quầy giờ cũng tạo đơn có người nhận.
- **Sửa:** trong `getOrderFull`, áp `maskPhone(receiver_phone, role)` và che `ship_address`/`receiver_address` khi người gọi không có `customers.view_pii`.

### C2-02. `GET /pos/delivery-addresses` lộ địa chỉ của mọi khách, kể cả khách sỉ, cho thu ngân
- **File:** `src/worker/routes/pos-delivery.ts:192–203`.
- **Lỗi:** chỉ cần `pos.sell`. Gọi với `customerId` tuỳ ý là route trả `customers.address` và sổ `customer_addresses`, không giới hạn loại khách, không che. SĐT thì có che (`receiverPhone: null`), địa chỉ thì không. Trong khi đó `/retail-customers/:id` lại che địa chỉ là `***` với vai trò không có PII, nên hai chỗ đang xử lý không nhất quán.
- **Kịch bản:** thu ngân lần lượt thử `customerId` = 1, 2, 3… và thu được địa chỉ kho/nhà của khách sỉ.
- **Tái hiện:** có (P1b). Kết quả trả về "Số 7 Hẻm Bí Mật, Q10" của khách sỉ 9801.
- **Sửa:** chỉ trả địa chỉ khi khách là `retail` và đang được chọn ở quầy. Hoặc che địa chỉ khi thiếu `customers.view_pii`, và nhận địa chỉ đầy đủ qua một token gợi ý phía server thay vì trả về.

### C2-03. Tạm ứng lương lộ cho quản lý (không có `hr.sensitive`) qua chi tiết ca
- **File:** `src/worker/services/shift-report.ts:141–152`. Các phiếu quỹ `created_by = người mở ca` trên quỹ của ca được liệt kê đủ `code`, `amount`, `note`, `category`. Chỉ `route shift-report.ts` dùng `reports.view` để thấy mọi ca.
- **Kịch bản:** chủ mở ca POS trên quỹ tiền mặt quầy, rồi lập tạm ứng 1.234.000đ từ quỹ đó (chuyện thường gặp ở cửa hàng nhỏ). Quản lý gọi `GET /shifts/:id/summary` thì thấy `{"amount":1234000,"category":"Lương","note":"Tạm ứng lương NV-T50: ốm"}`, tức có cả mã NV, số tiền và lý do. Trong khi đó quản lý gọi `GET /payroll/advances` thì nhận 403. Chi lương theo kỳ (`payroll_item`) cũng lọt vào đây nếu được chi từ quỹ của ca đang mở.
- **Tái hiện:** có (P2).
- **Sửa:** che phiếu `ref_type IN ('payroll_item','salary_advance')` khi người xem không có `hr.sensitive`, gộp thành "Chi lương (tổng)" như cách đã sửa C-02.

### C2-04. Phiếu duyệt "ghi nợ vượt ngưỡng" dùng được cho cả "vượt hạn mức nợ"
- **File:** `src/worker/routes/pos.ts:633–639`. `requireApproval` chọn type `order.credit` cho cả hai lý do `credit` và `credit_limit`. Khi dùng lại phiếu, hàm chỉ so `type`, `clientUuid`, `hash`, `requested_by`, không so `reasons`.
- **Kịch bản:** khách có hạn mức 1.000.000đ. Thu ngân ghi nợ 600.000đ, vượt ngưỡng 500k, chưa vượt hạn mức, nên phải xin duyệt và được quản lý duyệt (lý do `["credit"]`). Trước khi dùng phiếu, khách có thêm đơn nợ 500.000đ. Thu ngân gửi lại kèm `approvalId` thì nhận **201**. Tổng nợ thành 1.100.000đ, vượt hạn mức, dù người duyệt chưa từng thấy lý do "vượt hạn mức". Guard trong batch cũng cho qua vì `allowOver` là true.
- **Tái hiện:** có (P6).
- **Sửa:** lưu `reasons` trong payload và khi dùng lại phải yêu cầu reasons hiện tại ⊆ reasons đã duyệt. Hoặc tách type riêng `order.credit_limit`.

### C2-05. Hoa hồng và thưởng doanh số không bị thu hồi khi huỷ đơn POS của kỳ trước
- **File:** `src/worker/services/commission.ts:62–75` (chỉ lấy `status='completed'`), `src/worker/routes/payroll.ts:86–103` (thưởng cũ cũng vậy), `src/worker/routes/pos.ts:1347–1350`. Void chỉ chặn khi kỳ đã khoá sổ, không chặn khi kỳ lương đã duyệt.
- **Kịch bản:** đơn POS ngày 15/10 có hoa hồng 100.000đ, đã tính vào lương tháng 10 và đã duyệt. Ngày 05/11 quản lý huỷ đơn: đơn biến mất khỏi kỳ 10, kỳ 11 không có dòng trừ, người bán giữ nguyên hoa hồng. Trả hàng thì có trừ lại vào kỳ trả, nên void lại là đường né.
- **Tái hiện:** có (P5). Trạng thái huỷ được giả lập bằng UPDATE; điều kiện void theo kỳ khoá đã kiểm bằng đọc mã.
- **Sửa:** ghi phần trừ hoa hồng vào kỳ huỷ (đơn `cancelled` có `voided_at` trong kỳ thì trừ theo người bán gốc). Hoặc chặn void đơn thuộc kỳ lương đã tính/duyệt và hướng dẫn dùng Trả hàng.

### C2-06. Quản lý có `orders.edit` tự gán người bán của đơn đã hoàn tất cho chính mình, ảnh hưởng hoa hồng
- **File:** `src/worker/routes/pos.ts:777–817` (`metaStatements`, `/orders/:id/meta`, `/orders/meta/bulk`). Code chỉ kiểm khoá sổ theo `created_at`, không chặn `sellerId = chính người sửa`, không kiểm kỳ lương đã tính/duyệt, và bulk sửa được tới 100 đơn một lần.
- **Kịch bản:** quản lý gọi PATCH `sellerId = 2` (chính mình) trên đơn của thu ngân thì nhận 200 (P5b). Doanh thu chuyển sang quản lý, và nếu có quy tắc hoa hồng hay `hr.sales_bonus_bp` thì quản lý tăng được lương của mình mà không cần `hr.sensitive`. Nếu đổi sau khi lương kỳ đó đã chi thì người bán cũ giữ hoa hồng, còn phiếu trả hàng về sau lại trừ vào người bán mới.
- **Tái hiện:** có (P5b), phần đổi người bán.
- **Sửa:** cấm `sellerId = user.id` với vai trò không phải chủ, hoặc bắt buộc lý do và cần duyệt. Chặn đổi người bán khi kỳ lương chứa `completed_at` đã `calculated/approved/paid`.

### C2-07. Thu ngân tự khai "chuyển khoản" để gạch nợ khách lẻ, không có bước xác nhận
- **File:** `src/worker/routes/pos-credit.ts:94–128`. `method: "transfer"` chỉ cần `pos.sell`; route ghi phiếu thu `posted` vào quỹ ngân hàng với `approved_by = thu ngân` và gạch nợ ngay.
- **Kịch bản:** thu ngân bán nợ 200.000đ, sau đó ghi "khách đã chuyển khoản 200.000đ", không có giao dịch thật. Hoá đơn hết nợ, quỹ ngân hàng sổ sách lệch so với sao kê, và chỉ phát hiện được khi đối soát ngân hàng. Kể cả khi đã bật SePay `flow.b2b` (mã HDS tự gạch), đường khai tay này vẫn mở.
- **Tái hiện:** có (P4): voucher `{status:'posted', fund_id:2, created_by:3, approved_by:3}`.
- **Ghi chú:** POS bán thường cũng không kiểm `transfer`. Riêng công nợ thì luồng gốc `/debts/payments` cần `debt.write`.
- **Sửa:** khi thu ngân (thiếu `debt.write`) chọn `transfer`, hoặc khi đã bật SePay, chỉ chấp nhận giao dịch SePay đã khớp, hoặc tạo phiếu `pending` để kế toán xác nhận. Tiền mặt giữ nguyên như hiện tại.

---

## Thấp

### C2-08. Báo cáo cuối ngày cho biết số tạm ứng/lương của từng người khi trong ngày chỉ có một phiếu
- **File:** `src/worker/services/shift-report.ts:59–80` (`cashFlow.byCategory`), `routes/reports.ts:242`. Có `reports.view` là xem được; khoản mục "Lương" có cả `count`.
- **Tái hiện:** có (P2): `{"category":"Lương","count":1,"amount":1234000}`.
- **Sửa:** với người không có `hr.sensitive`, gộp hoặc ẩn `count` của khoản mục `pnl_line='payroll'`, hoặc chỉ hiện tổng theo kỳ.

### C2-09. Gộp khách lẻ bỏ sót dữ liệu gắn với khách nguồn
- **File:** `src/worker/routes/retail-customers.ts:338–373`. Khi gộp, code chuyển orders, vouchers, voucher_redemptions và shop_accounts, nhưng **không** chuyển `customer_addresses`, `customer_contacts`, `price_lists.customer_id` (bảng giá riêng, A-22) và các approvals `customer.credit_change` đang chờ của khách nguồn.
- **Hậu quả:** khách đích mất địa chỉ giao và giá riêng; nếu sau đó duyệt phiếu chờ thì hạn mức lại được đặt cho hồ sơ nguồn đã ngừng.
- Phần hoá đơn nợ B1: merge chặn hẳn khi khách nguồn có **bất kỳ** hoá đơn nào (`has_b2b_documents`), kể cả hoá đơn đã trả hết. Cách này an toàn, nhưng khách lẻ từng mua nợ sẽ không bao giờ gộp được, và thông báo lỗi nói "hoá đơn/báo giá/đơn lặp" dễ gây hiểu nhầm.
- Trigger 0037 và `reversalStatements` (tra sổ điểm theo đơn) đều đúng sau khi gộp.
- **Kiểm chứng:** đọc mã.
- **Sửa:** chuyển thêm các bảng trên, huỷ approvals chờ của nguồn; cho gộp khi mọi hoá đơn nguồn đã hết nợ (hoặc chuyển cả hoá đơn kèm lý do).

### C2-10. Thưởng doanh số kiểu cũ (khi không có quy tắc) tính trên `orders.total`, gồm cả thu khác và phần ghi nợ chưa thu
- **File:** `src/worker/routes/payroll.ts:86–103`. Trong khi hoa hồng theo quy tắc dùng `line_total`, không gồm thu khác.
- **Hậu quả:** cùng một đơn nhưng tính ra hai cơ sở khác nhau tuỳ kỳ có quy tắc hay không. Phí đóng gói/giao hàng làm tăng thưởng. Nợ xấu (`write_off`) cũng không thu hồi thưởng.
- **Kiểm chứng:** đọc mã.
- **Sửa:** dùng `total - charges_total`, hoặc ghi rõ đây là quyết định đã chốt.

### C2-11. `/retail-customers` trả `birthday` và `note` không che với vai trò không có PII (thủ kho, online_staff…)
- **File:** `src/worker/routes/retail-customers.ts:31–41`. SĐT, email, địa chỉ đều đã che, chỉ hai trường này thì không.
- **Kiểm chứng:** đọc mã. Test P1b xác nhận được trường có mặt, nhưng dữ liệu thử để null.
- **Sửa:** che `birthday` (chỉ giữ MM-DD nếu cần cho khuyến mãi sinh nhật) và `note` khi thiếu `customers.view_pii`.

---

## Đã kiểm, không thấy lỗi
- **Quyền của các route mới:**
  - pos-credit (`pos.sell` / `settings.manage`), retail-customers (`b2b.view` / `b2b.write` / `b2b.write+b2b.approve`), sales-reports (`reports.view`; NCC cần thêm `prices.view_cost`).
  - commission: xem cần `hr.sensitive`, sửa cần `payroll.approve`.
  - shift-report (`pos.shift`|`reports.view`): thu ngân chỉ xem ca của mình, ca người khác trả 404.
  - fund-transfers (`finance.view` / `finance.write`), imports (quyền theo loại; key lạ như `constructor` → 403), charge-types, orders meta (`orders.edit`), products `ids`, online-orders `source` (`orders.online.manage`).
- **Hạn mức và duyệt:** thu ngân gọi PUT `/retail-customers/:id/credit` nhận 403. Quản lý tự duyệt `order.credit` của chính mình nhận 403 `self_approval` (P3). Đổi hạn mức khách lẻ dùng lại A-10: quản lý đặt tới 50 triệu (ngưỡng của khách sỉ) không cần duyệt (P3b); việc này đúng thiết kế, nhưng nên cân nhắc ngưỡng riêng cho khách lẻ.
- **Giá vốn:** chi tiết đơn, phiếu in, báo cáo bán hàng (sellers/products) và báo cáo ngày chỉ trả cogs khi có `prices.view_cost`. Import giá chỉ áp dụng khi có `prices.write`, chưa có `prices.approve` thì tạo yêu cầu duyệt. Import khách sỉ: người không phải chủ không đổi được hạn mức của khách đã có; khách mới phải ≤ ngưỡng.
- **Hoa hồng:**
  - `inputs_hash` có hashData của quy tắc (kể cả version) và doanh thu theo người bán, nên đổi quy tắc/đơn sau khi tính thì báo `payroll_stale`. Kỳ đã duyệt không tính lại được (`payroll_locked`).
  - Trả hàng trừ cho người bán của đơn gốc; tổng âm thì tính bằng 0.
  - `COALESCE(seller_id, created_by)` dùng nhất quán ở payroll, commission và sales-reports.
- **Phép có lương:** NV lương giờ được tính theo giờ ca đã xếp (không có ca thì 8 giờ), NV lương ca được 1 ca mỗi ngày phép. Đúng như mô tả.
- **Báo cáo bán hàng theo người bán** (không lọc nhóm) dùng `orders.total`, cùng điều kiện với `/reports/pnl` nên khớp doanh thu (gồm thu khác, ghi nợ, phí giao). Theo hàng hoá hoặc theo nhóm thì dùng `line_total`, không gồm thu khác/phí giao; đây là bản chất của báo cáo, nên ghi chú trên giao diện. Xuất dùng nội bộ không phải đơn nên không vào báo cáo bán hàng; P&L tính là chi phí riêng.

## Nghi ngờ, chưa kiểm chứng
- **Đơn giao từ quầy** (`channel='social'`, `source='pos'`) không vào hoa hồng/thưởng và không có người bán (`seller_id`). Người bán tại quầy mất doanh số khi khách chọn giao hàng. Đây là giả định "chỉ tính đơn tại quầy" đang chờ chủ xác nhận, nhưng có thể chưa ai nghĩ tới trường hợp B3.
- **Bán nợ** được tính hoa hồng ngay khi bán. Nếu sau này xoá nợ khó đòi thì không thu hồi hoa hồng; cần chủ quyết định.
- `/pos/deliverers` liệt kê tên mọi user đang hoạt động cho thu ngân. `/pos/customers/:id/debts` cho thu ngân dò tên và số nợ của khách lẻ theo id (SĐT có che). Rủi ro thấp, chưa đánh giá kỹ.
- **Đổi hàng (A-13):** đơn bán mới mang người lập là thu ngân đổi hàng, còn phiếu trả trừ vào người bán gốc. Doanh số có thể bị dời người, chưa thử.
