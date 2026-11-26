# Đối chiếu KiotViet (bán lẻ) với mã nguồn ERP Hữu Mạnh — kiểm chứng 26/11/2026

Phương pháp: đọc `docs/KIOTVIET-DOI-CHIEU.md`, `docs/POS-KV.md`, `docs/HANDOFF.md`; grep route trong `src/worker/routes/*`, bảng trong `migrations/`, màn trong `src/web/screens`, website `src/shop`. POS-KV đợt A (tab hoá đơn, lưới ảnh + nhóm hàng, máy quét, người bán, sao chép, in lại/lọc thêm) = **đang làm** (nhánh `claude/pos-fe`, `claude/pos-be`).

Chú thích: ĐC = Đã có; MP = Một phần; CC = Chưa có.

> Phạm vi: các **module nghiệp vụ chính**. Phần chăm sóc khách hàng (ZNS, SMS, Zalo OA) **không làm** theo quyết định chủ dự án (26/11/2026). Tài liệu này bổ sung và đính chính `docs/KIOTVIET-DOI-CHIEU.md`; số thứ tự trong bảng xếp hạng (mục 3) không liên tục vì đã bỏ mục CSKH.

## 1. Bảng đối chiếu

### Hàng hoá
| Mục | KQ | Bằng chứng / thiếu |
|---|---|---|
| Danh mục, nhóm hàng, SKU, mã vạch | ĐC | `routes/products.ts` (`/products`, `/product-groups`, `/products/lookup`), bảng `products`, `product_groups`; màn `screens/Products.tsx` |
| Nhóm hàng phân cấp | CC | `product_groups` phẳng (không parent) |
| Thuộc tính / biến thể (size, màu) | CC | Không có bảng/route. Với trái cây ít cần: dùng SKU riêng hoặc đơn vị |
| Đơn vị quy đổi (thùng = 10 kg) | ĐC | bảng `product_units` (factor_milli, barcode riêng theo đơn vị), `normalizeUnits` trong products.ts |
| Bán theo cân | ĐC | `products.sell_by_weight`; mã vạch tem cân EAN-2 (khối lượng/tiền) CC (POS-KV đợt B8) |
| Combo / giỏ quà | ĐC | `routes/promo-bundles.ts` (`/bundles/:id/components`, `/assembly-orders` đóng giỏ trừ thành phần FEFO), `services/bundle-assembly.ts`, màn `d4/Bundles.tsx`; KM combo trong `promotions.ts` |
| Lô, hạn dùng, cách ly, truy vết | ĐC (vượt KiotViet) | `/stock/lots`, `/stock/lots/:lotCode/trace`, `/lots/:id/quarantine` |
| Gộp mã trùng | ĐC | `POST /products/:id/merge-into/:targetId` |
| Giá vốn bình quân/lô, tồn tối thiểu | ĐC | `min_stock_milli`, `/stock/alerts` |
| In tem mã vạch | MP | Có Code128 (`web/barcode128.ts`, `components/Barcode.tsx`) và mở nhãn từng sản phẩm trong Products.tsx (`label`). Thiếu: in hàng loạt, tem lô vừa nhập, chọn khổ tem/số lượng, tem cân |
| Nhập/xuất Excel hàng hoá | MP | Xuất CSV danh sách (ExportButton trong Products.tsx). **Nhập Excel hàng hoá CC** (chỉ có nhập sao kê ngân hàng, CSV Fresco, đối thủ) |
| Ảnh sản phẩm | MP | Có cho website (`cms.ts` `/products/:id/images`), POS lưới ảnh = đợt A (đang làm) |
| Ngừng kinh doanh | ĐC | cờ `active` |

### Thiết lập giá
| Bảng giá theo kênh (pos/online/b2b/all) + nhóm khách | ĐC | `routes/prices.ts` (`/price-lists`, `/prices/bulk`, `/prices/history`, `/approve`, `/suggested`, `/quote`), `Prices.tsx` |
|---|---|---|
| Đổi hàng loạt có hiệu lực, lịch sử, duyệt, cảnh báo dưới giá vốn | ĐC | như trên |
| Xem nhiều bảng giá cạnh nhau, nhập/xuất Excel bảng giá | CC | |
| Giá riêng theo khách | ĐC | `PUT /customers/:id/prices` (sỉ) |

### Nhập hàng / Trả hàng nhập / Kiểm kho / Xuất huỷ / Chuyển hàng / Xuất dùng nội bộ
| Nhập hàng | ĐC | `stock-docs` type `receipt` (nháp -> post), theo lô/HSD, công nợ NCC tự sinh (`/bills`), PO (`routes/purchase-orders.ts`), gợi ý nhập (`/purchasing/suggestions`), phân bổ chi phí nhập (`purchase_cost_adjustments`, mig 0020). Thiếu: sao chép phiếu, lịch sử thanh toán ngay trên phiếu, in tem lô |
|---|---|---|
| Trả hàng nhập (NCC) | ĐC (tài liệu sai, cần đính chính) | `routes/purchase-returns.ts` (`/purchase-returns` get/post/cancel) + UI trong `Inventory.tsx` (dòng 319, trả theo phiếu nhập/lô). Thiếu: trả nhanh không theo phiếu nhập (cần kiểm tra thêm) |
| Kiểm kho | ĐC | `stock-docs` type `count` (snapshot, `lockLots`, chênh lệch vào P&L, duyệt). Thiếu: gộp nhiều phiếu kiểm, sao chép phiếu, nhập kết quả kiểm từ Excel |
| Xuất huỷ | ĐC | type `waste` bắt buộc lý do; hỏng lô cách ly (EC-15) |
| Chuyển hàng | ĐC (tài liệu thiếu) | type `transfer` **đã hai bước**: `transfer_status='in_transit'` rồi `POST /stock-docs/:id/receive` (lô mới tại đích). Phạm vi hiện: giữa vị trí (`locations`); `stores` chỉ có 1 bảng thông tin nên nhiều chi nhánh đầy đủ (tồn riêng, quyền theo chi nhánh) = MP |
| Xuất dùng nội bộ | CC | DOC_TYPES = receipt/waste/adjust/count/transfer; không có loại `internal_use`. Có thể ghi tạm bằng `adjust`/`waste` với lý do, nhưng không vào chi phí đúng loại |
| Điều chỉnh tồn | ĐC | type `adjust` (bắt buộc lý do) |

### Đặt hàng
| Đặt hàng NCC (PO) | ĐC (vượt KiotViet) | PO tự động từ thiếu SO, duyệt, gửi, phản hồi NCC, cổng NCC (`supplier-portal.ts`, `src/shop/worker/routes/ncc*.ts`), PDF `/purchase-orders/:id/pdf` |
|---|---|---|
| Đặt hàng khách sỉ | ĐC | quotes + đơn sỉ (`quotes.ts`, `b2b.ts`), giữ hàng theo lô, đơn lặp |
| Đặt trước khách lẻ / đặt cọc | ĐC | `promo-preorders.ts` (`/pos/preorders`, fulfill, cancel), đặt trước online |
| Gộp phiếu đặt; đặt tại quầy ngoài giỏ quà | CC/MP | |

### Bán hàng, Trả hàng, Kết ca
| Bán hàng POS | ĐC | `routes/pos.ts` (`POST /pos/orders`), `Pos.tsx`: quét camera, F2/F4/F9, thanh toán kết hợp (cash/transfer/qr/card/ewallet), SePay QR, KM tự động, voucher, đổi điểm, offline, bán theo cân, giảm giá dòng/đơn |
|---|---|---|
| Nhiều hoá đơn cùng lúc (tab); lưới ảnh + nhóm hàng; máy quét USB; người bán; sao chép HĐ; lọc + in lại | **Đang làm** | POS-KV đợt A (A1–A6) |
| Danh sách hoá đơn + lọc | ĐC | `GET /orders` lọc ngày/kênh/trạng thái/ca/loại/thu ngân/phương thức/tìm kiếm, `/orders/cashiers` |
| Trả hàng theo hoá đơn, đổi hàng, huỷ | ĐC | `/orders/:id/return`, `/exchange`, `/void`; `Exchange.tsx` |
| Trả hàng nhanh không hoá đơn gốc | CC | đúng như tài liệu |
| Bán nợ lẻ, thu khác, giao hàng tại quầy, HĐĐT lẻ, nhập HĐ từ Excel | CC | POS-KV đợt B |
| Kết ca (mở/đóng, lệch có lý do) | ĐC | `/shifts/open`, `/shifts/:id/close`, `ShiftClose.tsx`, `/reconcile/shifts` |
| Lịch sử ca, phiếu bàn giao in | CC | chỉ có `/shifts/current`, `/shifts/last`; báo cáo ngày có danh sách ca nhưng không in |
| Tổng kết ca theo hình thức thanh toán | MP | chỉ tiền mặt |

### Khách hàng (lẻ), Nhà cung cấp
| Khách lẻ: hồ sơ cơ bản | MP | bảng `customers.type='retail'` + `POST /pos/customers` (tên + SĐT tại POS); **không có màn quản lý khách lẻ** (menu chỉ Khách sỉ; `b2b/Customers.tsx`, `customers.ts` ép `type: 'b2b'`) |
|---|---|---|
| Khách lẻ: nhóm khách | MP | `customer_groups` + `/customer-groups` có nhưng chỉ để gắn bảng giá; không có nhóm tự động theo điều kiện |
| Khách lẻ: lịch sử mua, công nợ | CC cho lẻ | `/customers/:id/history`, tab công nợ chỉ khách sỉ |
| Khách lẻ: điểm | ĐC | `customers.points`, `/customers/:id/loyalty`, `/loyalty/adjust`, tab "Tích điểm" ở `d4/Promotions.tsx`, `services/loyalty-points.ts` |
| Ngày sinh khách, ghi chú, địa chỉ khách lẻ | CC | bảng `customers` không có cột ngày sinh/giới tính |
| Gộp khách trùng, ngừng hoạt động (lẻ), nhập/xuất Excel | CC | (cờ `active` có nhưng không có UI cho lẻ) |
| Tài khoản khách website | ĐC | `/shop-accounts`, `online/ShopAccounts.tsx`; `shop/worker/routes/auth.ts`, `me.ts` (sổ địa chỉ, mua lại, xoá tài khoản NĐ13) |
| Nhà cung cấp: hồ sơ, công nợ, thanh toán, chiết khấu, cổng NCC | ĐC | `/suppliers`, `/debts/payables`, `/suppliers/:id/bills`, `b2b/Suppliers.tsx`, cấn trừ khách-NCC |
| Nhóm NCC, nhập/xuất Excel NCC | CC | không có `supplier_group` |

### Sổ quỹ, Công nợ, Thu khác
| Sổ quỹ | ĐC | `finance.ts` (`/funds`, `/vouchers` + approve/reject/cancel/reverse, `/periods` khoá/mở), `Finance.tsx`, xuất `so-quy.xlsx` |
|---|---|---|
| Chuyển quỹ nội bộ (tiền mặt -> ngân hàng) | CC | grep không có route/loại chuyển quỹ (3 loại quỹ cash/bank/ewallet... chỉ ghi thu/chi riêng) |
| Công nợ phải thu/phải trả, tuổi nợ, thu gạch nợ, sao kê, nhắc nợ, đối soát | ĐC | `routes/debts.ts` đầy đủ, `b2b/Debts.tsx`, `Bank.tsx` |
| Thu khác (phiếu thu danh mục) trong sổ quỹ | ĐC | `/cash-categories`, phiếu thu; "thu khác trên hoá đơn bán" CC (đợt B3) |

### Hoa hồng, Tích điểm, Khuyến mãi, Voucher
| Hoa hồng nhân viên | MP | chỉ `salesBonusBp` % doanh số chung trong `payroll-calc.ts`; không có bảng hoa hồng theo nhóm hàng/sản phẩm/người bán; cần "người bán" (A4 đang làm) |
|---|---|---|
| Tích/đổi điểm | ĐC | `loyalty.*` trong settings (mặc định tắt), POS + website, sổ điểm bất biến. Thiếu: điểm theo từng hàng hoá, nhóm khách theo điểm |
| Khuyến mãi (%, tiền, đồng giá, combo, xả cuối ngày) + duyệt + tính thử | ĐC | `routes/promotions.ts`, `d4/Promotions.tsx` |
| Voucher sinh hàng loạt | ĐC | `/promotions/:id/vouchers`; giới hạn lượt/khách |
| Khuyến mãi theo sinh nhật/nhóm khách | CC | |

### Mẫu in
| Hoá đơn POS | MP | `components/Receipt.tsx` cố định (tên cửa hàng cứng "HỮU MẠNH"), in/chia sẻ |
|---|---|---|
| PDF báo giá, hoá đơn sỉ, PO, lãi lỗ, tuổi nợ | ĐC | `services/pdf.ts`, `po-pdf.ts`, `report-pdf.ts` |
| Tuỳ chỉnh mẫu (logo, chân trang, 58/80mm, A4), chọn khi in lại | CC | |

### Báo cáo
| Cuối ngày | MP | **API có** `GET /reports/daily` (`reports.ts:193`: tổng bán, phiếu thu/chi, ca, đơn huỷ) nhưng **không có màn hình** (không tham chiếu từ `src/web`), không in |
|---|---|---|
| Bán hàng (lãi lỗ theo ngày/kênh/nhóm) | ĐC | `/reports/pnl`, `.pdf`, `Reports.tsx`; `/reports/pnl-by-channel` |
| Sổ bán hàng, hoá đơn bán, công nợ, nhập-xuất-tồn | ĐC | xuất Excel `routes/exports.ts`: so-ban-hang, so-quy, cong-no-phai-thu/tra, nhap-xuat-ton, hoa-don-ban |
| Hàng hoá: tồn kho, xuất nhập tồn | ĐC | `/reports/inventory`, tab Tồn kho; thẻ kho `/stock/card` |
| Hàng hoá: bán chạy/chậm, hàng lâu không bán, lợi nhuận theo mặt hàng | CC | không có báo cáo theo SKU |
| Khách hàng (top mua, tần suất, lẻ/sỉ) | CC | |
| NCC (mua theo NCC, nợ) | MP | chỉ công nợ + sao kê NCC; không báo cáo mua hàng theo NCC |
| Nhân viên (doanh số theo người bán/thu ngân) | CC | có lọc `cashierId` trong danh sách đơn; chưa có báo cáo; chi phí nhân sự `payroll` có |
| Tài chính | ĐC | `finance-extra.ts`: cash-flow, GTGT, ngân sách vs thực tế, phân bổ chi phí; `d4/FinReports.tsx` |
| Dashboard | ĐC | `routes/dashboard.ts`, `Dashboard.tsx` |

### Thiết lập, phân quyền, nhân sự
| Thiết lập cửa hàng/chi nhánh | MP | bảng `stores` (1 cửa hàng + toạ độ chấm công, `hr/Stores.tsx`), `Settings.tsx` + `settings-registry.ts`; chưa nhiều chi nhánh thực sự (tồn/giá/ca theo chi nhánh), chưa cấu hình thông tin in hoá đơn (tên, địa chỉ, SĐT) |
|---|---|---|
| Phân quyền theo vai trò | ĐC | `lib/rbac.ts` (owner, manager, cashier, warehouse, accountant, staff, admin...), `requirePerm`; `Users.tsx`, mặc định từ chối, ẩn giá vốn/lương |
| Nhật ký hệ thống | ĐC | `audit_log` bất biến, `sysaudit.ts` |
| Nhân viên, chấm công, lương, BHXH, TNCN | ĐC (vượt KiotViet) | `hr.ts`, `hr-board.ts`, `payroll.ts`, `screens/hr/*` |

### Bán online, Giao hàng, HĐĐT
| Website bán hàng + PWA | ĐC | `src/shop` (catalog, cart, checkout COD/VietQR, đặt trước, tài khoản, theo dõi đơn, khung giờ giao); ERP `online-orders.ts`, `cms.ts` |
|---|---|---|
| Sàn TMĐT (Shopee/Lazada/TikTok Shop) | CC | chỉ có kênh `fresco`/`social` (nhập webhook/CSV, định dạng giả định) và `marketplace_clearing` để đối soát; không đồng bộ đơn/tồn/giá sàn |
| Mạng xã hội (Zalo/Facebook) | MP | kênh `social` nhập tay trong Đơn online |
| Giao hàng: khu vực, khung giờ, phí, phiếu giao sỉ | ĐC | `/delivery-zones`, `/delivery-slots`, `b2b/Delivery.tsx` |
| Giao hàng: hãng vận chuyển (GHN, GHTK, ViettelPost...) | MP | chỉ nhập tay `carrier` + `carrierTrackingNo` ở `OnlineOrders.tsx`; không tích hợp tạo vận đơn/phí/COD đối soát tự động |
| Thanh toán chuyển khoản SePay | ĐC (chưa chạy thật) | `sepay.ts`, `Sepay.tsx` |
| HĐĐT | MP | `services/einvoice/` (fake + MISA giả định) chỉ cho hoá đơn **sỉ** (`b2b-invoice.ts`); lẻ/online CC; MISA chưa test thật |

## 2. Đính chính so với `docs/KIOTVIET-DOI-CHIEU.md`
1. Mục "Trả hàng nhập": tài liệu ghi "cần kiểm tra, chưa thấy" -> **đã có** `routes/purchase-returns.ts` + UI `Inventory.tsx`.
2. Mục "Chuyển hàng": tài liệu ghi thiếu hai bước gửi/nhận -> **đã có** `in_transit` + `receive` ở cấp vị trí; chỉ thiếu phần nhiều chi nhánh.
3. "Báo cáo cuối ngày" thiếu: API đã có (`/reports/daily`), chỉ thiếu màn hình + in.
4. "Phân bổ chi phí nhập" đã có (`purchase_cost_adjustments`); "điều chỉnh điểm thủ công" đã có (`/customers/:id/loyalty/adjust`, tab Tích điểm).
5. Chuyển quỹ nội bộ: xác nhận **chưa có**.

## 3. Khoảng trống lớn xếp theo ảnh hưởng (cửa hàng trái cây lẻ + sỉ)

| # | Khoảng trống | Ảnh hưởng | Khối lượng | Phụ thuộc |
|---|---|---|---|---|
| 1 | Màn quản lý **khách lẻ** (danh sách, chi tiết, lịch sử mua/điểm, ngày sinh, gộp trùng, ngừng) | Cao | Vừa (cần migration thêm cột ngày sinh/ghi chú; route `customers.ts` đang ép b2b) | không |
| 2 | **Báo cáo cuối ngày** (màn + in) + tổng kết ca theo hình thức thanh toán + lịch sử ca/phiếu bàn giao ca | Cao (dùng hằng ngày) | Nhỏ (API daily sẵn) -> vừa (lịch sử ca, in) | không |
| 4 | **Báo cáo hàng hoá/khách/nhân viên/NCC**: bán chạy-chậm, lãi theo SKU, top khách, doanh số theo người bán, mua theo NCC | Cao (quyết định nhập hàng, hao hụt hàng tươi) | Vừa (SQL + màn; người bán phụ thuộc POS-KV A4 đang làm) | A4 cho báo cáo nhân viên |
| 5 | **Hoá đơn điện tử** cho bán lẻ/online (yêu cầu pháp lý hộ kinh doanh) | Cao (pháp lý, khi go-live) | Lớn (dòng chiết khấu, KM, gộp cuối ngày; MISA thật) | **Tài liệu API/tài khoản MISA (hoặc nhà cung cấp khác)**, xác nhận hình thức kinh doanh |
| 6 | **Bán nợ lẻ + thu khác + giao hàng tại quầy + QR thu nợ lẻ** (POS-KV đợt B) | Trung bình-Cao (khách quen mua nợ) | Lớn (đụng công nợ/chứng từ) | SePay thật cho QR |
| 7 | **Nhập Excel**: hàng hoá, khách, NCC, kết quả kiểm kho (hiện chỉ xuất); khi go-live cần nạp dữ liệu từ KiotViet/sổ cũ | Trung bình-Cao (lúc chuyển đổi) | Vừa (parser `xlsx.ts` mới có phần xuất) | không |
| 8 | **Xuất dùng nội bộ** + chuyển quỹ nội bộ (tiền mặt -> ngân hàng) | Trung bình | Nhỏ-vừa mỗi mục (thêm loại phiếu + chi phí/P&L; cặp phiếu thu-chi liên kết, khoá kỳ) | không |
| 9 | Trả hàng nhanh không hoá đơn gốc (có duyệt) | Trung bình | Vừa | quy tắc giá trả |
| 10 | Đánh giá đơn hàng (website), nhóm khách tự động + sinh nhật/hạng thành viên | Trung bình | Vừa | #1 |
| 11 | Mẫu in tuỳ chỉnh (thông tin cửa hàng, logo, 58/80mm, A4, tem mã vạch hàng loạt/tem lô, tem cân) | Trung bình (tem lô tiện kho; tem cân cần biết loại cân) | Vừa | loại máy in/cân |
| 12 | Tích hợp vận chuyển (GHN/GHTK/ViettelPost: tạo vận đơn, phí, COD) | Trung bình (nếu giao liên tỉnh; hiện giao nội thành theo khung giờ) | Lớn | hợp đồng + API key hãng |
| 13 | Hoa hồng theo nhóm hàng/sản phẩm/người bán | Thấp-Trung bình | Vừa | POS-KV A4 (đang làm) |
| 14 | Sàn TMĐT (Shopee/TikTok Shop/Lazada): đồng bộ đơn, tồn, giá | Thấp-Trung bình (chỉ nếu bán trên sàn; trái cây tươi ít) | Rất lớn | **Tài khoản bán hàng + duyệt API từng sàn** |
| 15 | Nhiều chi nhánh thực sự (tồn/giá/ca/quyền theo chi nhánh) | Thấp (hiện 1 cửa hàng) | Lớn | quyết định mở thêm điểm bán |
| 16 | Thuộc tính/biến thể, nhóm hàng phân cấp, nhóm NCC, sao chép phiếu, gộp phiếu kiểm | Thấp | Nhỏ mỗi mục | không |

Gợi ý thứ tự làm: 2 (nhanh, thắng sớm) -> 1 -> 4 -> 7 -> 8 -> 5 (xin tài khoản/tài liệu MISA ngay vì chờ bên ngoài) -> 6.

## 4. Bổ sung

| Mục | KQ | Bằng chứng / thiếu |
|---|---|---|
| Chi phí nhập hàng / điều chỉnh giá vốn | ĐC | `purchase_cost_adjustments` (mig 0020), `debts.ts` finalize hoá đơn NCC điều chỉnh giá vốn lô (`stock_moves.move_type='cost_adjust'`) |
| Hoá đơn đầu vào / VAT đầu vào | ĐC/MP | `stock_docs.vat_amount` trên phiếu nhập (inventory.ts), `/reports/vat` (finance-extra.ts) tổng hợp GTGT; thiếu: nhập hoá đơn đầu vào điện tử (XML) |
| Kho / vị trí | ĐC | bảng `locations` (quầy, kho lạnh), tồn theo lô-vị trí; nhiều kho độc lập theo chi nhánh = MP |
| Thuế - Kế toán HKD (sổ S2a/S2b/S3a...) | MP | có xuất Excel sổ bán hàng, sổ quỹ, công nợ, nhập-xuất-tồn, GTGT, tham số hình thức kinh doanh (cần xác nhận); chưa có bộ sổ kế toán HKD theo mẫu TT152/2025 và tờ khai |
| Tuỳ chọn hiển thị / mẫu in thông tin cửa hàng | CC | `Receipt.tsx` cứng tên cửa hàng |

Hạng mục này không đổi bảng xếp hạng mục 3; thêm vào: **Sổ kế toán HKD + kê khai thuế (Trung bình-Cao, khối lượng vừa, phụ thuộc xác nhận hình thức kinh doanh với kế toán)**.
