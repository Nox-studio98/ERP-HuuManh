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
| Khách nhiều chi nhánh | **Mỗi chi nhánh tự đặt trên cổng khách sỉ**; hệ thống tự sinh bảng tổng hợp hàng × chi nhánh cho văn phòng chuỗi (mục 9.7). Dán bảng Excel chỉ còn là cách dự phòng (mục 9.1–9.5) |

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

### 9.7 (TẠM DỪNG) Chi nhánh tự đặt trên cổng khách sỉ, bảng tổng hợp do hệ thống sinh

> **Tạm dừng 25/11/2026:** khách không muốn đổi quy trình (văn phòng tổng vẫn gom đơn các chi nhánh và gửi **ảnh** bảng mỗi ngày). Giữ lại làm phương án sau; hướng chính hiện tại là **9.8 đọc ảnh**.

Văn phòng chuỗi đang mất nhiều thời gian gom yêu cầu các chi nhánh vào file Excel. Đảo ngược luồng: **mỗi chi nhánh tự đặt**, bảng hàng × chi nhánh (đúng dạng file khách đang dùng) **do hệ thống tự sinh**. Ô dán Excel ở 9.1–9.5 giữ lại cho giai đoạn chuyển đổi.

```
Chi nhánh (điện thoại, cổng khách sỉ)              Văn phòng chuỗi (cổng khách sỉ)            Cửa hàng (ERP)
──────────────────────────────────────             ────────────────────────────────           ───────────────────
Mở "Đặt hàng ngày mai"                              Bảng tổng hợp tự cập nhật:
  danh sách món hay đặt, SL gợi ý sẵn                 hàng × chi nhánh + cột TỔNG
  +/− chỉnh, thêm món, ghi chú                         chi nhánh nào chưa đặt (đỏ)
Gửi trước giờ chốt (vd 22:00)  ───────────────►      sửa ô nếu cần, xuất Excel
21:00 chưa đặt → nhắc                                [nếu bật duyệt] Duyệt & gửi ─────►   12 đơn sỉ (mỗi chi nhánh 1),
                                                                                           1 khách, công nợ chung,
                                                                                           bill theo cơ sở, HĐ tổng hợp (9.6),
                                                                                           phần thiếu → PO 03:00
```

**Tài khoản và quyền (cổng khách sỉ đã có tài khoản gắn khách):**
- `shop_accounts` thêm `address_id` (NULL = cấp văn phòng, xem/đặt mọi chi nhánh) và vai trò trong chuỗi: `branch` (chỉ đặt cho địa chỉ của mình) / `office` (xem bảng tổng hợp, sửa, duyệt, xuất Excel).
- Văn phòng tự mời tài khoản chi nhánh (hoặc cửa hàng tạo hộ từ ERP). Mọi truy vấn lọc theo `customer_id` + `address_id` của phiên (test IDOR giữa chi nhánh và giữa các khách).
- Chi nhánh **không thấy công nợ, hoá đơn** của công ty; văn phòng thấy (như cổng khách sỉ hiện nay).

**Màn chi nhánh đặt hàng (ưu tiên điện thoại):**
- Danh sách **món hay đặt** của chi nhánh (đặt ≥ 2 lần trong 30 ngày), nhóm theo loại; ô tìm để thêm món khác trong bảng giá của khách.
- **Số lượng gợi ý** điền sẵn: trung bình 4 lần gần nhất **cùng thứ trong tuần** (làm tròn bước đặt, vd 0,5 kg); nút **Giống lần trước**; tuỳ chọn **Định mức − tồn** (chi nhánh khai định mức một lần, mỗi tối chỉ nhập "còn bao nhiêu").
- Bước +/− theo đơn vị (kg bước 0,5; gói/quả bước 1); ô số nhập tay được.
- Đồng hồ tới **giờ chốt** (`b2b.branch_cutoff_time`, mặc định 22:00); sau giờ chốt chỉ văn phòng sửa được (hoặc gọi cửa hàng).
- Gửi → đơn sỉ trạng thái `submitted` (nếu chuỗi bật duyệt) hoặc `new` (đi thẳng). Sửa lại được tới giờ chốt; dùng `clientUuid` chống gửi trùng.

**Bảng tổng hợp văn phòng chuỗi:**
- Lưới hàng × chi nhánh như file Excel của khách, cột **TỔNG** tự cộng, hàng tiêu đề ghi trạng thái mỗi chi nhánh: **Đã đặt (giờ)** / **Chưa đặt** / **Đã sửa bởi văn phòng**.
- Văn phòng sửa ô trực tiếp (ghi lại ai sửa), bấm **Nhắc chi nhánh chưa đặt**, **Xuất Excel** (đúng bố cục file cũ để lưu sổ).
- Tham số khách `b2b.chain_approval` (mặc định tắt): bật thì đơn chi nhánh chờ văn phòng **Duyệt & gửi** cả bảng; tới giờ chốt chưa duyệt → nhắc văn phòng (không tự gửi).
- Cùng dữ liệu đó là màn ERP "Đơn chuỗi theo ngày" cho cửa hàng soạn gộp theo sản phẩm rồi chia theo chi nhánh (9.3).

**Nhắc đặt hàng:** 21:00 (tham số) thông báo đẩy cho chi nhánh chưa đặt và văn phòng. Nhắc qua Zalo (ZNS/OA) cần tài khoản Zalo OA trả phí — để sau.

**Dữ liệu bổ sung:**
```sql
-- shop_accounts thêm: address_id INTEGER REFERENCES customer_addresses(id), chain_role TEXT CHECK (chain_role IN ('office','branch'))
CREATE TABLE branch_par_levels (           -- định mức theo chi nhánh (tuỳ chọn)
  address_id INTEGER NOT NULL REFERENCES customer_addresses(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  par_milli INTEGER NOT NULL CHECK (par_milli >= 0),
  PRIMARY KEY(address_id, product_id)
);
-- orders: trạng thái thêm 'submitted' (chờ văn phòng chuỗi duyệt) khi bật b2b.chain_approval
```

## 9.8 Hướng chính: khách gửi ảnh bảng → đọc ảnh bằng Cloudflare Workers AI (PoC 25–26/11/2026)

Khách không dùng Google Sheets, không điền file mẫu; mỗi ngày gửi **ảnh chụp màn hình** bảng Excel (vd 817×309 px, 22 dòng hàng × 12 chi nhánh). OCR truyền thống đọc kém ở độ phân giải này; mô hình thị giác (vision LLM) đọc được. Chủ dự án chọn **Cloudflare Workers AI** (cùng tài khoản Cloudflare, gói miễn phí 10.000 neuron/ngày, không gửi dữ liệu ra bên thứ ba khác).

**Kết quả PoC trên 1 ảnh thật** (đáp án chuẩn chép tay, có dùng cột TỔNG để kiểm):

| Cách đọc | Ô đúng | Dòng tự khớp TỔNG |
|---|---|---|
| Gemma 4 (`@cf/google/gemma-4-26b-a4b-it`), nguyên ảnh | 69,6% | 4/22 |
| Qwen 3.8, nguyên ảnh | 57,3% | 5/22 |
| Llama 4 Scout, cắt 3 dải | 72,4% | 7/22 |
| Gemma 4, cắt **4 dải cột** (mỗi dải giữ cột Tên/ĐVT/TỔNG, phóng 3×) | 96,5–97,2% | 14/22 |
| **Gemma 4, 4 dải + mặt nạ ô xanh + bù bằng TỔNG** | **99,6–100%** | **21–22/22, 0 ô sai lọt** |
| Clairic / Clairic Flash (mô hình trích xuất của Cloudflare) | 88–94% | đắt ~25× (≈4.000 neuron/ảnh) |
| DeepSeek V4.1 Flash, Inkling 2 Small | chưa thử | chỉ có ở gói Workers Paid |
| Kimi K2.6 | — | Cloudflare ngừng 20/11/2026 |

**Quy trình đề xuất (đã chạy trong PoC, mã ở `tools/ocr-poc/`):**
1. Chuẩn hoá ảnh về khổ mẫu của khách (rộng 817 px). Mỗi khách có **mẫu bảng** lưu một lần: toạ độ cột (Tên/ĐVT/TỔNG, từng chi nhánh), dòng đầu, chiều cao dòng. Nhân viên kéo vạch cột trên ảnh đầu tiên (cần làm màn hình này).
2. Cắt 4 dải dọc, mỗi dải = cột trái (Tên/ĐVT/TỔNG) + 3 cột chi nhánh; phóng 3×; gửi song song tới Gemma 4 với `reasoning_effort: "none"` (bật suy luận thì hết token mà không trả lời), `temperature: 0`, yêu cầu trả JSON.
3. **Mặt nạ màu:** bảng của khách tô xanh mọi ô có số → đọc pixel để biết ô nào có giá trị (khớp 264/264 ô). Model đọc số ở ô trắng → bỏ (lệch cột); ô xanh mà model để trống → ô "chưa chắc".
4. **Bù bằng cột TỔNG:** dòng chỉ còn 1 ô chưa chắc → giá trị = TỔNG − các ô còn lại. Không đọc lại từng ô bằng AI (model đọc "1." thành 1,4/1,5).
5. Dòng nào vẫn không khớp TỔNG → đánh dấu **"cần xem"**, nhân viên sửa trên màn duyệt; không tự nhận.
6. Thử lại khi Workers AI trả 429 (hết tải) / 408 (quá giờ).

**Chi phí:** ~140–190 neuron/ảnh (≈ 50–60 ảnh/ngày miễn phí; vượt mức ≈ 0,002 USD/ảnh). ~30 giây/ảnh.

**Việc còn lại trước khi làm thật:**
- Thử thêm 5–10 ảnh thật (zoom khác, chụp bằng điện thoại, ngày thêm/bớt cột). Đã chuẩn bị 6 biến thể ảnh (JPEG Zalo, JPEG nén mạnh, to/nhỏ, mờ); 2 biến thể đầu: 96,6% và 99,2%, 0 ô sai lọt. 4 biến thể còn lại **chưa chạy** vì hết hạn mức ngày 26/11 — hạn mức báo hết ngay sau giờ đặt lại, nên kiểm tra mục Workers AI trên dashboard Cloudflare xem có thứ khác đang dùng.
- Gemma trả kết quả hơi khác giữa các lần chạy (16–22 dòng tự duyệt) — luôn để bước "cần xem".
- Giới hạn số ảnh/ngày và báo rõ khi hết hạn mức.
- Màn hình: thiết lập mẫu bảng theo khách; màn duyệt kết quả (tô dòng "cần xem"); tạo một đơn cho mỗi chi nhánh (9.2–9.6).

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
6. Mỗi chi nhánh có người phụ trách đặt hàng dùng điện thoại được không (bếp trưởng / quản lý)? Văn phòng có muốn **duyệt** trước khi gửi cửa hàng không?
7. Bill cơ sở có cần **giá** không (một số chuỗi chỉ muốn chi nhánh thấy số lượng, giá chỉ ở bảng kê gửi văn phòng)?
8. Công ty thanh toán gộp cho cả chuỗi hay từng cơ sở tự trả?
9. Giờ chốt nhận đơn của chuỗi (đề xuất 22:00) và giờ nhắc (21:00)?
10. Bếp có kiểm kho mỗi tối không (để dùng cách gợi ý "định mức − tồn")?
