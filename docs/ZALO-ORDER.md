# Thiết kế: Nhập nhanh đơn sỉ từ tin nhắn Zalo và bảng Excel nhiều chi nhánh

Trạng thái: **bản thiết kế chờ duyệt** (25/11/2026). Chưa có code. Giao diện concept tương tác: https://claude.ai/artifact/Wb176hDxDgJgP18X3XaLb2 (riêng tư, chủ dự án chia sẻ khi cần).

## 1. Bối cảnh

Khách sỉ (nhà hàng, quán ăn) nhắn danh sách hàng qua Zalo mỗi tối, đúng lúc cửa hàng nhập đơn (22:00–00:00). Tin nhắn có dạng ổn định, mỗi dòng một mặt hàng:

```
Bún : 1,5kg
Đậu : 6 bìa
Trứng gà : 40 quả
Hành ta bóc : 1kg
Xả : 1kg
Bạc hà : 3 lạng
Muống : 1 mớ
Táo : 2kg
```

Hiện nhân viên phải gõ lại từng dòng vào màn Tạo đơn sỉ: chậm, dễ sai số lượng (lạng → kg) và chọn nhầm sản phẩm.

**Mục tiêu:** nhân viên chọn khách, dán nguyên tin nhắn, hệ thống đọc thành các dòng đơn; nhân viên chỉ xử lý những dòng hệ thống chưa chắc, rồi tạo đơn. Lần sau với cùng khách, hệ thống nhớ cách khách gọi tên hàng nên gần như không phải chọn lại.

Quyết định đã chốt:

| Câu hỏi | Chốt |
|---|---|
| Đặt ở đâu | Màn **Tạo đơn sỉ** (đợt này). Có thể mở rộng sang đơn MXH / POS sau |
| Dòng không đọc được | **Quy tắc là mặc định**, không gửi dữ liệu ra ngoài. AI (Claude API) là tuỳ chọn bật sau, chỉ cho dòng quy tắc không đọc được (mục 8) |
| Sản phẩm chưa có | **Nút tạo nhanh** ngay trong bảng xem trước |
| Khách nhiều chi nhánh gửi bảng Excel | Dán bảng (hoặc tải file .xlsx) → **mỗi chi nhánh một đơn**, cùng một khách (mục 9) |

## 2. Luồng

```
Nhân viên chọn khách sỉ + ngày giao
        │
        ▼
Dán tin nhắn vào ô "Dán tin nhắn Zalo"  ──►  hệ thống đọc ngay (chưa ghi gì)
        │
        ▼
Bảng xem trước: mỗi dòng một trạng thái
  ✓ Khớp          — tự điền sản phẩm, số lượng, đơn vị, giá theo bảng giá của khách
  ? Cần chọn      — tên chung chung / gần giống nhiều sản phẩm → chọn trong 2–3 gợi ý
  + Chưa có SP    — không tìm thấy → "Tạo nhanh" hoặc "Bỏ dòng"
  ! Không đọc được — sai mẫu (không có số lượng…) → sửa tay ngay trên dòng
        │
        ▼
Nhân viên xử lý các dòng ?, +, !   (tick "Nhớ cho khách này" — mặc định bật)
        │
        ▼
"Tạo đơn (N dòng)"  ──►  luồng tạo đơn sỉ hiện có
        │                (kiểm hạn mức nợ, giữ hàng FEFO, phần thiếu → PO tự động lúc 03:00)
        ▼
Lưu tên gọi đã chọn vào "tên riêng của khách" cho lần sau
```

- Đọc tin nhắn **không ghi gì** vào CSDL. Chỉ khi bấm "Tạo đơn" mới đi qua API tạo đơn sỉ hiện có (giá tính lại ở server, kiểm hạn mức, giữ hàng, ghi phần thiếu).
- Dán lại tin nhắn khác thì bảng đọc lại từ đầu; dòng đã sửa tay sẽ mất (cảnh báo trước khi ghi đè).

## 3. Quy tắc đọc một dòng

### 3.1 Tách dòng
- Tách theo xuống dòng; bỏ dòng trống, dòng chỉ có chào hỏi ("Chị ơi", "Cảm ơn", "Mai giao sớm nhé") → đưa vào **ghi chú đơn** thay vì bỏ mất.
- Bỏ ký tự đầu dòng: `-`, `•`, `+`, số thứ tự `1.` `2)`, emoji.

### 3.2 Tách tên và số lượng
Chấp nhận các dạng (không phân biệt hoa thường, có/không dấu cách):

| Dạng | Ví dụ |
|---|---|
| `Tên : SL đơn vị` | `Bún : 1,5kg` |
| `Tên SL đơn vị` | `Bún 1,5kg` |
| `Tên - SL đơn vị`, `Tên x SL` | `Trứng - 40 quả`, `Chanh x 2kg` |
| `SL đơn vị Tên` | `2kg táo` |
| Số lượng có phần thập phân | `1,5` `1.5` `1 rưỡi` (= 1,5) `nửa` (= 0,5) |

Ghi chú trong ngoặc giữ lại làm **ghi chú dòng**: `Táo : 2kg (loại to)`.

### 3.3 Đơn vị

| Khách viết | Hiểu là | Quy đổi |
|---|---|---|
| `kg`, `ký`, `kí`, `cân` | kg | 1 kg = 1000 milli |
| `lạng`, `lang` | lạng | **1 lạng = 0,1 kg** |
| `g`, `gr`, `gam` | gam | 1000 g = 1 kg |
| `quả`, `trái` | quả | theo đơn vị bán của sản phẩm |
| `bìa`, `mớ`, `bó`, `hộp`, `thùng`, `khay`, `túi`, `chục` | như viết | theo `product_units` của sản phẩm |
| (không ghi) | đơn vị chính của sản phẩm | |

- Đơn vị khối lượng (kg/lạng/g) quy về kg nếu sản phẩm bán theo kg.
- Đơn vị đếm (bìa, mớ, quả…) phải có trong `product_units` của sản phẩm; nếu chưa có → dòng **Cần chọn** với gợi ý "Thêm đơn vị 'mớ' cho Rau muống" (nhập 1 mớ = ? kg hoặc là đơn vị chính).
- `chục` = 10 đơn vị đếm (vd `2 chục trứng` = 20 quả).

### 3.4 Nhận ra sản phẩm (theo thứ tự)

1. **Tên riêng của khách** (bảng `customer_product_aliases`): đã từng chọn "Táo" → Táo Envy cho nhà hàng A → tự điền, trạng thái ✓.
2. **Tên gọi khác của sản phẩm** (bảng `product_aliases`, khai ở màn Hàng hoá): "muống", "rau muống" → Rau muống; "xả", "sả" → Sả cây.
3. **So gần đúng:** bỏ dấu, chữ thường, bỏ từ chung ("rau", "quả", "trái" ở đầu), so tiền tố và khoảng cách sửa chữ (Levenshtein ≤ 2 với tên ≥ 4 ký tự).
   - Một kết quả rõ ràng (điểm cao, cách xa kết quả thứ hai) → ✓ nhưng gắn nhãn nhỏ "đoán", để nhân viên liếc qua.
   - Nhiều kết quả gần nhau ("Táo" → Táo Envy, Táo Mỹ, Táo xanh) → ? Cần chọn, hiện 3 gợi ý đầu.
   - Không có → + Chưa có SP.

Chỉ xét sản phẩm **đang bán sỉ** (có giá trong bảng giá áp dụng cho khách, chưa gộp mã, còn hoạt động).

## 4. Tạo nhanh sản phẩm (dòng "Chưa có SP")

Ô nhỏ ngay trong bảng (không rời màn tạo đơn):
- Tên (điền sẵn từ tin nhắn, sửa được: "Xả" → "Sả cây"), nhóm hàng.
- Đơn vị chính (kg / quả / bìa / mớ…) và đơn vị phụ nếu cần (1 mớ ≈ 0,3 kg).
- Giá bán sỉ (ghi vào bảng giá sỉ hiện dùng cho khách). **Bắt buộc** — không tạo đơn với giá 0.
- Tên khách gọi ("Xả") lưu thành tên riêng của khách.

Quyền: `products.write` + `prices.write` (quản lý, chủ). Nhân viên không có quyền thì thấy nút "Gửi yêu cầu tạo SP" (dòng bị giữ lại, đơn tạo với các dòng còn lại).

## 5. Dữ liệu (migration mới)

```sql
-- Tên gọi khác của sản phẩm, dùng chung mọi khách (khai ở màn Hàng hoá)
CREATE TABLE product_aliases (
  product_id INTEGER NOT NULL REFERENCES products(id),
  alias_norm TEXT NOT NULL,             -- đã bỏ dấu, chữ thường, gộp khoảng trắng
  alias TEXT NOT NULL,                  -- như người dùng nhập
  PRIMARY KEY(alias_norm, product_id)
);

-- Cách một khách cụ thể gọi tên hàng (học từ lần chọn trước)
CREATE TABLE customer_product_aliases (
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  alias_norm TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  unit TEXT,                            -- đơn vị khách hay dùng với tên này (vd 'bìa')
  uses INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY(customer_id, alias_norm)
);
```

- Không lưu nội dung tin nhắn gốc vào CSDL (chỉ tên gọi đã chuẩn hoá). Ghi chú chào hỏi đưa vào `orders.note` như ghi chú thường.
- Gộp mã sản phẩm (EC-22, đã có) phải chuyển luôn alias sang mã đích.

## 6. API

| Route | Quyền | Mô tả |
|---|---|---|
| `POST /b2b/orders/parse-message` | `b2b.write` | Body: `customerId`, `text` (≤ 4.000 ký tự, ≤ 100 dòng). Trả từng dòng: `raw`, `status` (`ok`/`choose`/`missing`/`unparsed`/`note`), `qtyMilli`, `unit`, `productId`, `candidates[]` (≤ 3), `matchedBy` (`customer_alias`/`alias`/`fuzzy`), `unitPrice` theo bảng giá khách. **Chỉ đọc**, không ghi gì. |
| `POST /b2b/orders` (đã có) | `b2b.write` | Thêm trường tuỳ chọn `aliasesToRemember: [{ alias, productId, unit }]`; ghi `customer_product_aliases` trong cùng batch tạo đơn (kèm `auditStmt`). |
| `PUT /products/:id/aliases` | `products.write` | Khai tên gọi khác ở màn Hàng hoá. |
| `POST /products/quick` | `products.write` + `prices.write` | Tạo nhanh SP + đơn vị + giá sỉ trong một batch. |

Giá vốn **không** trả trong `parse-message` (người không có `prices.view_cost`). Việc đọc chạy ở server để dùng đúng danh mục, bảng giá của khách và tên riêng đã học.

## 7. Giao diện (màn Tạo đơn sỉ)

- Ô **"Dán tin nhắn Zalo"** ở đầu form dòng hàng (thu gọn được). Dán xong đọc ngay; nút "Đọc lại".
- **Bảng xem trước** (thay cho nhập từng dòng khi có tin nhắn): Dòng gốc (chữ nhỏ, xám) · Sản phẩm · SL + đơn vị · Đơn giá · Thành tiền · Trạng thái.
  - Dòng ✓ trắng; ? và ! nền vàng nhạt, sắp lên đầu bảng; + nền xám có nút "Tạo nhanh".
  - Bấm vào dòng ? → danh sách gợi ý + ô tìm sản phẩm; chọn xong dòng chuyển ✓ và hiện ô tick "Nhớ cho khách này".
- Thanh dưới: "**N dòng sẵn sàng · M dòng cần xử lý**", tổng tiền tạm tính, nút **Tạo đơn** (vô hiệu khi còn dòng ? hoặc ! chưa xử lý; dòng + có thể "Bỏ dòng").
- Điện thoại (390px): bảng thành danh sách thẻ; dòng cần xử lý nằm trên, nút Tạo đơn dính đáy.
- Phím tắt PC: `Ctrl+V` khi đang ở màn tạo đơn sỉ mở thẳng ô dán; `↑/↓` chuyển dòng, `Enter` chọn gợi ý đầu.

## 8. AI cho dòng khó (tuỳ chọn, tắt mặc định)

- Tham số `order_paste.ai_enabled` = 0. Bật lên (cần secret `ANTHROPIC_API_KEY`): chỉ những dòng **quy tắc không đọc được** mới gửi cho Claude, kèm danh sách tên sản phẩm (không gửi tên khách, SĐT, giá).
- Kết quả AI luôn ở trạng thái ? Cần chọn — nhân viên xác nhận, AI không tự tạo dòng đơn.
- Chi phí nhỏ (vài dòng mỗi đơn); có giới hạn số lần gọi/ngày.

## 9. Khách nhiều chi nhánh: bảng Excel

### 9.1 Cách khách đang làm
Chuỗi nhà hàng gửi một bảng Excel mỗi tối: **hàng** = nguyên vật liệu, **cột** = chi nhánh, ô = số lượng chi nhánh đó cần; ô trống = không đặt.

| TÊN NVL | ĐVT GỌI HÀNG | TỔNG SL | Xã Đàn | Láng Hạ | Nguyễn Khang | … | Linh Đàm | Kho Đức Thượng |
|---|---|---|---|---|---|---|---|---|
| Bắp cải tím | kg | 4.5 | 0.5 | | 1.5 | … | 1. | |
| Bắp cải trắng | kg | 30. | 3. | 1. | 3. | … | 4. | |
| Củ cải trắng | kg | 140.5 | | | | … | | 140. |
| Nấm kim châm | gói | 5. | | | 1. | … | | |

Đặc điểm cần xử lý:
- Số kiểu Excel: `30.` = 30, `1.` = 1, `0.5` hoặc `0,5` = 0,5 (dấu thập phân có thể là chấm hoặc phẩy tuỳ máy khách).
- Cột **TỔNG SL** do khách tự cộng: dùng để **đối chiếu**, không dùng để tạo đơn.
- Có cột là **kho trung tâm** (Kho Đức Thượng) chứ không phải chi nhánh bán: vẫn là một địa chỉ giao.
- Đơn vị ở cột ĐVT (kg, gói…): áp cho cả hàng.

### 9.2 Luồng
```
Chọn khách sỉ (chuỗi) + ngày giao
        │
        ▼
Dán bảng (copy vùng ô từ Excel / Google Sheets) hoặc tải file .xlsx
        │
        ▼
Ghép cột → địa chỉ giao của khách      (nhớ cho lần sau; cột lạ → chọn địa chỉ hoặc "Bỏ cột")
Ghép hàng → sản phẩm                    (cùng cơ chế tên riêng của khách, mục 3.4)
        │
        ▼
Bảng xem trước dạng lưới (giống file khách) + cảnh báo:
  • TỔNG SL lệch với tổng các chi nhánh → tô đỏ ô TỔNG, hiện số đúng
  • Hàng chưa khớp SP / cột chưa ghép địa chỉ → phải xử lý trước khi tạo
        │
        ▼
"Tạo 12 đơn" → mỗi chi nhánh có hàng ≠ 0 thành một đơn sỉ (cùng khách, địa chỉ chi nhánh, cùng ngày giao)
             → tạo trong một lô: kiểm hạn mức nợ trên TỔNG các đơn; nếu vượt → cả lô chờ chủ duyệt
             → phần thiếu từng đơn đi vào PO tự động như đơn thường
```

### 9.3 Quy tắc
- **Ghép cột với địa chỉ:** so tên cột với nhãn địa chỉ (`customer_addresses.label`) sau khi bỏ dấu; khớp sẵn thì tự điền; lưu ánh xạ cột → địa chỉ cho khách (`customer_column_map`) để tháng sau khách thêm/bớt cột vẫn đúng. Cột chưa có địa chỉ → nút "Thêm chi nhánh" (tạo địa chỉ mới cho khách, cần `customers.write`).
- **Mỗi chi nhánh một đơn** (không gộp): giao hàng, ký nhận, hoá đơn theo từng địa chỉ như hiện có; công nợ vẫn tính chung một khách. Đơn trong cùng lô mang chung `import_batch_id` để xem/huỷ cả lô.
- **Hạn mức nợ (EC-23):** kiểm trên tổng cả lô, tránh trường hợp từng đơn nhỏ lọt qua mà tổng vượt.
- **Chống tạo trùng:** lô có `client_uuid`; dán lại cùng bảng cho cùng khách + ngày giao → cảnh báo "Đã có lô đơn ngày này" (cho xem / thêm vào / tạo mới).
- **Soạn hàng:** màn Soạn & giao lọc theo lô để soạn gộp theo sản phẩm (tổng mỗi mặt hàng), rồi chia theo chi nhánh — đúng cột TỔNG SL khách đang dùng.

### 9.4 Dữ liệu và API bổ sung
```sql
CREATE TABLE customer_column_map (     -- cột trong bảng của khách → địa chỉ giao
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  column_norm TEXT NOT NULL,
  address_id INTEGER REFERENCES customer_addresses(id),   -- NULL = bỏ cột này
  PRIMARY KEY(customer_id, column_norm)
);
-- orders thêm cột import_batch_id TEXT (đơn tạo cùng lô)
```

| Route | Quyền | Mô tả |
|---|---|---|
| `POST /b2b/orders/parse-sheet` | `b2b.write` | Body: `customerId`, `tsv` (dán từ Excel) hoặc file .xlsx (≤ 200 hàng × 40 cột). Trả lưới đã đọc: hàng (khớp SP như mục 3.4), cột (khớp địa chỉ), ô số lượng, cảnh báo lệch TỔNG. Chỉ đọc. |
| `POST /b2b/orders/batch` | `b2b.write` | Tạo nhiều đơn trong một lô (một `db.batch` / chốt chặn hạn mức trên tổng), kèm `aliasesToRemember`, `columnsToRemember`, `clientUuid`. |

### 9.5 Giao diện
- Màn Tạo đơn sỉ có hai thẻ: **Tin nhắn Zalo** và **Bảng nhiều chi nhánh**.
- Lưới xem trước giống file khách (hàng × chi nhánh), cột đầu và hàng tiêu đề dính khi cuộn; ô TỔNG lệch tô đỏ; hàng/cột chưa ghép tô vàng.
- Thanh dưới: "12 chi nhánh · 30 mặt hàng · 2 việc cần xử lý" + nút **Tạo 12 đơn**.
- Điện thoại: xem theo từng chi nhánh (chọn chi nhánh → danh sách hàng), vì lưới 12 cột không vừa 390px.

### 9.6 Công nợ và hoá đơn theo công ty, bill theo từng cơ sở

Yêu cầu của khách chuỗi: **công nợ và hoá đơn GTGT tính cho một công ty** (một mã số thuế), nhưng **bill giao hàng tách riêng từng cơ sở** để từng chi nhánh ký nhận, đối chiếu.

Hiện trạng: mỗi `invoices` gắn với **một** đơn / một lần giao (`order_id`, `delivery_id`) và hoá đơn điện tử xuất theo từng bản ghi đó. Đề xuất tách hai lớp:

| Lớp | Là gì | Theo | Ghi chú |
|---|---|---|---|
| **Bill cơ sở** | Chứng từ bán hàng nội bộ có giá, in kèm phiếu giao, chi nhánh ký nhận | Mỗi lần giao cho một địa chỉ | Chính là `invoices` hiện có (theo SL thực giao, EC-26). **Công nợ, tuổi nợ, gạch nợ, trả hàng vẫn tính theo bill** như hiện nay → xem được nợ từng cơ sở và tổng công ty |
| **Hoá đơn GTGT tổng hợp** | Một hoá đơn điện tử gộp nhiều bill | Một công ty (`customers`: tên, MST, `billing_address`) | Mới. Không phát sinh công nợ riêng (công nợ đã nằm ở các bill) |

```sql
CREATE TABLE einvoice_batches (           -- hoá đơn GTGT tổng hợp cho một công ty
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,              -- HDT-YYYYMMDD-0001
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  period_from TEXT NOT NULL, period_to TEXT NOT NULL,   -- ngày VN
  subtotal INTEGER NOT NULL, vat INTEGER NOT NULL, total INTEGER NOT NULL,
  einvoice_status TEXT NOT NULL DEFAULT 'pending',      -- như luồng HĐĐT hiện có (outbox, retry)
  einvoice_no TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE einvoice_batch_items (       -- bill nào nằm trong hoá đơn tổng hợp nào (mỗi bill chỉ một lần)
  batch_id INTEGER NOT NULL REFERENCES einvoice_batches(id),
  invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id)
);
-- customers thêm: einvoice_mode TEXT DEFAULT 'per_delivery' CHECK (einvoice_mode IN ('per_delivery','daily','periodic'))
```

- `per_delivery` (mặc định, như hiện nay): mỗi bill tự xuất HĐĐT.
- `daily`: cuối ngày (hoặc bấm tay) gộp mọi bill đã giao trong ngày của công ty thành **một** HĐĐT; dòng hàng **cộng theo sản phẩm + đơn giá** (không liệt kê từng cơ sở), kèm bảng kê bill theo cơ sở đính kèm (PDF).
- `periodic` (tuần / nửa tháng / tháng): như `daily` nhưng theo kỳ — **cần kế toán xác nhận** cách lập này phù hợp quy định về thời điểm lập hoá đơn đối với hàng giao nhiều lần.
- Bill đã vào HĐĐT tổng hợp thì không sửa/huỷ trực tiếp được; trả hàng / giảm giá sau đó đi bằng **hoá đơn điều chỉnh** cho HĐĐT tổng hợp (như luồng EC-25 hiện có, mở rộng cho batch).
- **Thu tiền:** công ty trả một lần cho nhiều cơ sở → phiếu thu theo khách, gạch các bill cũ nhất trước như hiện nay; có tuỳ chọn gạch theo HĐĐT tổng hợp (chọn một HĐ → gạch đúng các bill trong đó).
- **Sao kê / đối chiếu công nợ** cho công ty: nhóm theo cơ sở, tổng cuối cùng một số dư; xuất PDF/Excel.
- **Bill in cho cơ sở:** tên + địa chỉ chi nhánh, danh sách hàng thực giao, đơn giá, thành tiền, chữ ký nhận; ghi "Hoá đơn GTGT xuất tổng cho [Tên công ty] — MST …" để chi nhánh không đòi hoá đơn riêng.

## 10. Kiểm thử dự kiến

- Bộ tin nhắn mẫu thật (ẩn danh) → kết quả mong đợi từng dòng: định dạng số (1,5 / 1.5 / rưỡi / nửa), đơn vị (lạng, chục), ghi chú trong ngoặc, dòng chào hỏi.
- Học tên riêng: lần 1 "Táo" cần chọn → tạo đơn có `aliasesToRemember` → lần 2 tự khớp; khách khác không bị ảnh hưởng.
- Phân quyền: thu ngân không gọi được; parse không lộ giá vốn; tạo nhanh SP cần đủ quyền.
- Giới hạn: > 100 dòng / > 4.000 ký tự → 422.
- E2E: dán tin nhắn mẫu ở mục 1 → xử lý 3 dòng → tạo đơn → đơn có đúng 15 dòng, số lượng đúng (Bạc hà 0,3 kg).

## 11. Câu hỏi cho khách hàng

1. Danh mục hiện tại chủ yếu là trái cây. Cửa hàng có bán sỉ rau, đậu, trứng, gia vị, bún không? Nếu có, cần nạp danh mục các mặt hàng này (và đơn vị bìa, mớ, bó) trước khi dùng.
2. "1 mớ" rau muống, "1 bìa" đậu: bán theo đơn vị đếm hay cân rồi tính theo kg?
3. Khách có hay nhắn kèm yêu cầu (giờ giao, loại hàng) trong cùng tin nhắn không? Có cần đọc ngày giao từ tin nhắn ("mai giao 6h") không?
4. Khách chuỗi: hoá đơn GTGT tổng hợp **theo ngày** hay **theo kỳ** (tuần / tháng)? Theo kỳ cần kế toán của cửa hàng xác nhận cách lập phù hợp quy định thời điểm lập hoá đơn.
5. Kho Đức Thượng là kho trung tâm của khách: giao về kho rồi khách tự chia, hay cửa hàng chia sẵn theo chi nhánh?
6. Khách có thể gửi thẳng file .xlsx qua Zalo không, hay chỉ ảnh chụp màn hình? (Ảnh thì cần nhận dạng chữ — phức tạp hơn, đề xuất làm sau.)
7. Bill cơ sở có cần **giá** không (một số chuỗi chỉ muốn chi nhánh thấy số lượng, giá chỉ ở bảng kê gửi văn phòng)?
8. Công ty thanh toán gộp cho cả chuỗi hay từng cơ sở tự trả?
