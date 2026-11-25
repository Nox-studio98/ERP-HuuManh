# Thiết kế: Đơn đặt hàng NCC (PO) tự động và Cổng nhà cung cấp

Trạng thái: **bản thiết kế chờ duyệt** (25/11/2026). Chưa có code.

## 1. Bối cảnh và mục tiêu

Cửa hàng nhập đơn mới (SO) vào **buổi tối**, thường **22:00–00:00**, có hôm muộn hơn; sau đó liên hệ nhà cung cấp (NCC) để đặt hàng. Hiện tại:

- Đơn sỉ thiếu hàng bị từ chối khi xác nhận (`409 insufficient_stock`) và nằm ở trạng thái `new`; không ai biết thiếu bao nhiêu.
- "Gợi ý đặt hàng" (M2-11) chỉ tạo **phiếu nhập kho nháp** theo tốc độ bán; không có chứng từ đặt hàng, NCC không xác nhận, không theo dõi giao thiếu/trễ.
- NCC không có chỗ xem đơn, xác nhận hay đối chiếu công nợ.

Mục tiêu:

1. SO thiếu hàng **không bị từ chối**: giữ phần có tồn, ghi phần thiếu chờ hàng về.
2. Sau giờ chốt đêm, hệ thống **gom phần thiếu thành PO nháp theo từng NCC**; quản lý duyệt rồi gửi.
3. **Cổng NCC** (`/ncc` trên website): NCC xem và xác nhận PO, xem công nợ và thanh toán.
4. Nhận hàng theo PO, tự giữ hàng cho các SO đang chờ.

Quyết định đã chốt với chủ dự án:

| Câu hỏi | Chốt |
|---|---|
| Khi nào tạo PO | Chốt đêm **03:00** (chỉnh được; có nút "Chốt ngay" khi nhập xong sớm), tạo **PO nháp**, quản lý duyệt rồi mới gửi |
| SO nào tính vào phần thiếu | Đơn sỉ (B2B) và đơn online/website |
| NCC làm gì trên cổng | Xem và xác nhận PO (đề xuất sửa số lượng/giá/ngày giao); xem công nợ, sao kê, thanh toán |
| Cổng đặt ở đâu | Worker website, trang `/ncc`, tài khoản NCC tách hẳn tài khoản khách |

Ngoài phạm vi đợt này: NCC khai phiếu giao trước, NCC gửi hoá đơn/bảng giá, cộng thêm tồn an toàn cho bán lẻ (gợi ý M2-11 vẫn dùng tay như cũ).

## 2. Luồng tổng thể

```
Tối (22:00–00:00, có khi muộn hơn)  Nhập SO (sỉ + online)
             └─ Xác nhận SO: giữ FEFO phần có tồn; phần thiếu → so_shortages (open)
03:00        Job chốt sổ (cron) — hoặc quản lý bấm "Chốt ngay"
             ├─ Gom thiếu theo sản phẩm (mọi SO còn thiếu, ngày giao ≤ chân trời đặt hàng)
             ├─ Trừ hàng sắp về: PO đã gửi/đã xác nhận còn chưa nhận
             ├─ Chọn NCC: NCC ưu tiên trong product_suppliers (rồi lead time ngắn nhất)
             ├─ Làm tròn theo đơn vị đặt, tối thiểu min_order
             └─ Tạo/cập nhật PO nháp cho từng NCC (một PO nháp mở / NCC / ngày chốt)
Sáng sớm     Quản lý mở màn "Đơn đặt NCC": xem nguồn thiếu, sửa, duyệt → gửi
             └─ PO sang 'sent'; thông báo NCC (cổng + email nếu có)
Cổng NCC     Xem PO → Xác nhận / Đề xuất sửa (SL, giá, ngày giao) / Từ chối
             └─ Đề xuất sửa → cửa hàng chấp nhận hoặc từ chối đề xuất
Nhận hàng    Thủ kho "Nhận hàng theo PO": SL thực nhận, lô, hạn dùng
             ├─ Phiếu nhập kho (stock_docs, posted) liên kết PO
             ├─ Hoá đơn mua (supplier_bills) theo SL thực nhận × giá đã chốt
             └─ Tự giữ hàng FEFO cho các SO đang thiếu (cũ trước), đóng so_shortages
Công nợ      NCC xem hoá đơn mua, đã trả, còn nợ, sao kê, phiếu trả hàng NCC
```

## 3. Mô hình dữ liệu (migration mới, đánh số tiếp theo)

### 3.1 Phần thiếu của SO

```sql
CREATE TABLE so_shortages (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id) UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),        -- còn thiếu (giảm dần khi được giữ)
  need_by TEXT,                                             -- ngày giao SO (YYYY-MM-DD giờ VN)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT
);
```

- Một dòng SO có tối đa một dòng thiếu (`UNIQUE order_line_id`). Huỷ/sửa SO → `cancelled`.
- SO có phần thiếu mang cờ hiển thị "Chờ hàng" (tính từ bảng này, không thêm trạng thái mới vào `orders`).

### 3.2 PO

```sql
CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                 -- PO-YYYYMMDD-0001
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  store_id INTEGER NOT NULL REFERENCES stores(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','pending_approval','sent','supplier_proposed','confirmed',
    'partially_received','received','rejected','cancelled','closed')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('nightly','manual')),
  cutoff_day TEXT,                           -- ngày chốt sinh ra PO nháp
  expected_date TEXT,                        -- ngày giao dự kiến (NCC xác nhận)
  total INTEGER NOT NULL DEFAULT 0,          -- theo giá đã chốt
  note TEXT, supplier_note TEXT,
  version INTEGER NOT NULL DEFAULT 1,        -- chống sửa đồng thời
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id), approved_at TEXT,
  sent_at TEXT, confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX uq_po_nightly_draft ON purchase_orders(supplier_id, cutoff_day)
  WHERE source = 'nightly' AND status = 'draft';

CREATE TABLE purchase_order_lines (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  order_unit TEXT NOT NULL,                  -- đơn vị đặt (thùng, kg…)
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),          -- SL đặt (đơn vị chính)
  unit_cost INTEGER,                         -- giá đặt / đơn vị chính (gợi ý từ giá nhập gần nhất)
  proposed_qty_milli INTEGER, proposed_unit_cost INTEGER,    -- NCC đề xuất
  confirmed_qty_milli INTEGER, confirmed_unit_cost INTEGER,  -- đã chốt hai bên
  received_milli INTEGER NOT NULL DEFAULT 0,
  UNIQUE(po_id, product_id)
);

CREATE TABLE po_shortage_links (             -- PO nào phủ phần thiếu nào (để giải thích + phân bổ khi nhận)
  po_line_id INTEGER NOT NULL REFERENCES purchase_order_lines(id),
  shortage_id INTEGER NOT NULL REFERENCES so_shortages(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  PRIMARY KEY(po_line_id, shortage_id)
);
```

- `stock_docs` thêm cột `po_id` (phiếu nhập theo PO); `supplier_bills` đã có `stock_doc_id` nên lần ra PO qua phiếu nhập.
- Lịch sử trạng thái PO ghi `audit_log` (bất biến) như các chứng từ khác.

### 3.3 Tài khoản NCC (cổng)

```sql
CREATE TABLE supplier_accounts (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  email TEXT UNIQUE, phone TEXT,
  full_name TEXT NOT NULL,
  pass_hash TEXT,                            -- PBKDF2 như tài khoản khác
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','locked')),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  invited_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE supplier_sessions ( ... );      -- như shop_sessions, cookie riêng `__Host-ncc`
```

- Cửa hàng **mời** NCC từ ERP (màn Nhà cung cấp → "Mời vào cổng"): tạo link đặt mật khẩu dùng một lần, hết hạn 72 giờ. Không có tự đăng ký.
- Một NCC có thể có nhiều tài khoản (nhân viên NCC). Mọi truy vấn cổng lọc theo `supplier_id` của phiên.

## 4. Quy tắc nghiệp vụ

### 4.1 Xác nhận SO khi thiếu hàng

- Đơn sỉ (`confirmOrderFlow`) và đơn online: giữ FEFO **phần có tồn**, ghi `so_shortages` phần còn lại, trong **một batch** (giữ nguyên ràng buộc chống bán quá tồn EC-02).
- Kiểm hạn mức nợ (EC-23) vẫn tính trên **toàn bộ** giá trị SO, không chỉ phần có hàng.
- Tham số `po.allow_short_confirm` (mặc định bật). Tắt → hành vi cũ (409).
- Đơn online: chỉ áp cho đơn **đặt trước giao ngày sau**; đơn giao trong ngày vẫn chặn thiếu như hiện tại (không hứa giao hàng không có).
- SO còn thiếu không cho soạn/giao phần thiếu; giao được phần đã giữ (giao một phần như A-27 nếu cần).

### 4.2 Job chốt đêm

- Chạy theo cron sau giờ chốt `po.cutoff_time` (mặc định `03:00` giờ VN; cron hiện có chạy mỗi 5 phút, job tự kiểm đã chạy cho ngày chốt chưa bằng `onceStmt`).
- **Ngày chốt** là ngày làm việc của buổi tối nhập đơn: chốt lúc 03:00 ngày 26 thuộc ngày chốt 25 (các đơn nhập tối 25 đến trước 03:00 sáng 26).
- **"Chốt ngay"** (quyền `purchasing.write`): chạy job cho ngày chốt hiện tại ngay lập tức; job 03:00 sau đó chỉ cập nhật PO nháp với đơn nhập thêm, không tạo trùng.
- Nhu cầu mỗi sản phẩm = Σ `so_shortages.qty_milli` (status `open`, `need_by` ≤ hôm nay + `po.horizon_days`, mặc định 2) − hàng sắp về (PO `sent/confirmed/supplier_proposed/partially_received`: SL chốt hoặc SL đặt − đã nhận) − phần đã nằm trong PO nháp khác.
- Chọn NCC: `product_suppliers.preferred = 1`, rồi lead time ngắn nhất. Sản phẩm **không có NCC** → ghi vào danh sách "Thiếu chưa có NCC" trên màn PO (không tự tạo).
- Làm tròn lên theo `order_unit` và `min_order_milli` (dùng lại logic M2-11).
- Giá gợi ý: giá nhập lô gần nhất của NCC đó (người không có `prices.view_cost` không thấy).
- Ghi `po_shortage_links` để màn PO hiện "PO này phủ SO nào".
- Chạy lại trong ngày (bấm tay "Tính lại") cập nhật PO **nháp**, không đụng PO đã gửi.

### 4.3 Duyệt và gửi PO

- Quyền mới: `purchasing.write` (tạo/sửa nháp), `purchasing.approve` (duyệt + gửi). Gợi ý: chủ, quản lý có `approve`; thủ kho có `write`.
- PO vượt `approval.po_vnd` (mặc định 20.000.000) mà người duyệt không có `purchasing.approve_high` → chờ chủ duyệt (luồng duyệt chung, có thông báo C-27).
- Gửi: `status = sent`, thông báo NCC trên cổng (và email nếu cấu hình). PO đã gửi chỉ sửa được bằng "Huỷ và tạo lại" hoặc qua đề xuất của NCC.

### 4.4 NCC xác nhận trên cổng

- **Xác nhận nguyên PO** → `confirmed`, `confirmed_* = qty/cost` đặt.
- **Đề xuất sửa** (SL, giá, ngày giao, ghi chú từng dòng) → `supplier_proposed`; cửa hàng **chấp nhận** (`confirmed` theo đề xuất, tính lại hàng sắp về) hoặc **từ chối đề xuất** (về `sent` kèm lý do).
- **Từ chối PO** (bắt buộc lý do) → `rejected`; phần thiếu được tính lại ở lần chạy sau hoặc bấm "Tính lại" chọn NCC khác.
- Mọi chuyển trạng thái dùng cập nhật có điều kiện (`WHERE status = ? AND version = ?`) + `auditStmt` trong một batch.

### 4.5 Nhận hàng theo PO

- Màn Kho → "Nhận hàng theo PO": chọn PO đã xác nhận, nhập SL thực nhận, lô, hạn dùng, ghi chú dòng thiếu/hỏng.
- Ghi sổ trong **một batch**: phiếu nhập (`stock_docs` posted, `po_id`), lô mới, `stock_moves`, cập nhật `received_milli`, hoá đơn mua (dùng luồng EC-30 hiện có: giá đã chốt; chưa có hoá đơn NCC thì `is_provisional`), `assertPeriodOpen`.
- Sau ghi sổ: giữ hàng FEFO cho `so_shortages` liên kết (SO giao sớm trước), giảm `qty_milli`, đóng khi đủ; thông báo NV online / NV kinh doanh SO đã đủ hàng.
- Nhận đủ → `received`; nhận một phần → `partially_received`; quản lý có thể **đóng** PO thiếu (`closed`, phần thiếu quay về nhu cầu cho lần chạy sau).
- Hàng hỏng khi nhận dùng luồng **Trả hàng NCC** (B-12, đã có).

## 5. Cổng NCC (`/ncc` trên Worker website)

| Màn | Nội dung |
|---|---|
| Đăng nhập / đặt mật khẩu | Link mời, Turnstile, khoá sau 5 lần sai, rate limit như đăng nhập khách |
| Đơn đặt hàng | Danh sách PO đã gửi cho NCC này (lọc trạng thái, ngày), chi tiết dòng, nút Xác nhận / Đề xuất sửa / Từ chối, tải PDF PO |
| Công nợ | Còn phải thu từ cửa hàng (theo góc nhìn NCC), hoá đơn mua mở, quá hạn, sao kê theo khoảng ngày (hoá đơn, thanh toán, chiết khấu, trả hàng NCC) |
| Thanh toán | Các lần cửa hàng đã trả (ngày, số tiền, phương thức) — **không** hiện quỹ, tài khoản nội bộ hay người lập |
| Tài khoản | Đổi mật khẩu, danh sách người dùng của NCC (chỉ xem) |

Bảo mật:

- Phiên riêng (cookie `__Host-ncc`, CSRF như shop), không dùng chung phiên khách hay ERP.
- Mọi API `/api/ncc/*` lọc theo `supplier_id` của phiên; test IDOR cho từng route.
- Không lộ: giá bán, khách hàng/SO nguồn, tồn kho, giá của NCC khác, nhân viên cửa hàng.
- Audit mọi thao tác NCC (`actor = supplier_account:<id>`).

## 6. ERP — màn hình và API mới

| Màn | Mô tả |
|---|---|
| **Đơn đặt NCC** (mới, nhóm Kho & hàng) | Danh sách PO (bộ lọc, KPI: nháp chờ duyệt, chờ NCC xác nhận, NCC đề xuất sửa, trễ hẹn), chi tiết (dòng, SO nguồn, lịch sử), Duyệt/Gửi, Chấp nhận/Từ chối đề xuất, Huỷ, Đóng, "Tính lại từ phần thiếu", PDF PO |
| **Phần thiếu** (tab trong Đơn đặt NCC) | Thiếu theo sản phẩm → SO, đã có PO chưa, "Thiếu chưa có NCC" |
| Đơn sỉ / Đơn online | Nhãn "Chờ hàng X kg", liên kết PO dự kiến |
| Kho | "Nhận hàng theo PO" |
| Nhà cung cấp | Mời vào cổng, danh sách tài khoản NCC, khoá/mở |
| Gợi ý đặt hàng (M2-11) | Thêm nút "Tạo PO" thay cho "Tạo phiếu nhập nháp" |

API theo quy ước hiện có (`requirePerm` + zod, phân trang `items/nextCursor/summary`), chi tiết viết vào `docs/API-po.md` khi triển khai.

## 7. Tham số Cài đặt mới (khai báo registry, nhãn "Cần xác nhận")

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `po.allow_short_confirm` | 1 | Cho xác nhận SO thiếu hàng (ghi phần thiếu) |
| `po.cutoff_time` | `03:00` | Giờ chốt đêm (giờ VN); đơn nhập trước giờ này thuộc ngày chốt hôm trước |
| `po.horizon_days` | 2 | Gom thiếu của SO giao trong N ngày tới |
| `po.auto_send` | 0 | (Để sau) tự gửi PO nhỏ không cần duyệt |
| `approval.po_vnd` | 20.000.000 | PO vượt ngưỡng cần chủ duyệt |
| `ncc.invite_ttl_hours` | 72 | Hạn link mời NCC |

## 8. Rủi ro và cách xử lý

| Rủi ro | Xử lý |
|---|---|
| Đặt trùng (job chạy hai lần, hai người bấm "Tính lại") | `onceStmt` theo ngày chốt; unique index PO nháp/NCC/ngày; trừ hàng sắp về khi tính |
| Hàng về được giữ cho SO sai thứ tự | Phân bổ theo `need_by` rồi thời điểm tạo SO; ghi lại bằng `po_shortage_links` |
| SO bị huỷ sau khi đã đặt PO | Đóng phần thiếu; PO vẫn giữ (hàng về thành tồn bán lẻ); màn PO cảnh báo "nguồn đã huỷ" |
| NCC sửa giá cao | Đề xuất giá phải được cửa hàng chấp nhận; giá chốt khác giá nhập gần nhất > `po.price_alert_bp` thì cảnh báo |
| Lộ dữ liệu giữa các NCC | Lọc theo `supplier_id` ở mọi truy vấn + test IDOR; cổng tách phiên |
| Hàng tươi giao trễ | KPI "trễ hẹn" theo `expected_date`; đóng PO và đặt NCC khác |

## 9. Kế hoạch triển khai (sau khi đợt sửa lỗi hiện tại đã gộp)

| Bước | Nội dung | Kiểm thử |
|---|---|---|
| 1 | Migration + phần thiếu khi xác nhận SO (sỉ + online đặt trước) | vitest: giữ một phần, chống bán quá tồn đồng thời, hạn mức nợ, huỷ SO |
| 2 | PO: CRUD nháp, job chốt đêm, duyệt/gửi, màn "Đơn đặt NCC" + "Phần thiếu" | vitest job (idempotent, trừ hàng sắp về, làm tròn), phân quyền, giá vốn ẩn |
| 3 | Nhận hàng theo PO + tự giữ hàng cho SO chờ + hoá đơn mua | vitest nguyên tử, khoá sổ, phân bổ thứ tự |
| 4 | Cổng NCC `/ncc`: mời, đăng nhập, PO (xác nhận/đề xuất/từ chối), công nợ, sao kê, thanh toán | vitest IDOR, CSRF, rate limit; E2E `e2e/ncc.mjs` |
| 5 | Tài liệu `docs/API-po.md`, ảnh 1440/390, cập nhật HANDOFF/GO-LIVE | 10 bộ E2E cũ + bộ mới |

Ước lượng: 2 đợt agent (bước 1–3 phía ERP; bước 4–5 cổng NCC), mỗi đợt một PR.

## 10. Câu hỏi còn mở (có mặc định, chủ dự án xác nhận khi duyệt)

1. ~~Giờ chốt~~ — đã chốt 03:00 (25/11/2026). Gom thiếu cho SO giao trong 2 ngày tới — đúng với nhịp nhập hàng chưa?
2. Ngưỡng PO cần chủ duyệt: 20 triệu?
3. Đơn online giao trong ngày vẫn chặn thiếu hàng (chỉ đơn đặt trước mới chờ hàng) — đồng ý?
4. NCC có cần nhận email/Zalo khi có PO mới không, hay chỉ xem trên cổng?
