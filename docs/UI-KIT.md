# UI kit — màn hình danh sách chuẩn (desktop + mobile)

Dành cho agent áp dụng bộ kit vào các màn còn lại. **Mẫu tham chiếu: `src/web/screens/Orders.tsx`** (đọc file này trước, copy cấu trúc).
Giữ nguyên ngôn ngữ thị giác hiện có (xanh thương hiệu, `Card`, `Badge`, `Segmented`…). Mobile (390px) phải hoạt động như cũ.

## Khung ứng dụng (≥1024px) — `src/web/App.tsx`, `components/shell.tsx`
- Nội dung `.main` rộng tối đa 1600px, **căn trái** (không còn căn giữa 1200px).
- **Tiêu đề màn hình nằm ở thanh trên cùng** (lấy từ `label` trong `NAV`). Trong nội dung **không viết `<h1>`** — dùng `PageHeader` (phụ đề + nút bên phải).
- Thanh trên: tên cửa hàng, chỉ báo ca, tìm nhanh `Ctrl+K`, chuông thông báo (`GET /notifications`), menu người dùng (đổi mật khẩu, đăng xuất).
- Sidebar: nhóm gập được (nhớ trong `localStorage`: `hm_nav_closed`, `hm_nav_fav`, `hm_sb_collapsed`), ghim mục (ngôi sao), thu gọn còn icon.
- Thêm màn mới: thêm 1 dòng vào mảng `NAV` (path, label, group, perms, icon, el). Màn tự có mặt trong sidebar và Ctrl+K.
- Deep-link: `navigate("/orders?q=ABC")` / `?open=ID`; shell **remount** màn khi query đổi (key theo `location.search`), màn chỉ cần đọc `new URLSearchParams(location.search)` ở state khởi tạo. Đổi query không thêm lịch sử: `setQuery({ q: "x" })` (`router.ts`).

## Thành phần (`src/web/components/list.tsx`, `ui.tsx`)
| Component | Props chính | Ghi chú |
|---|---|---|
| `PageHeader` | `subtitle?`, `actions?`, `title?` | Không lặp tiêu đề của thanh trên; `title` chỉ cho màn con. |
| `FilterBar` | `children` (ngày + tìm kiếm), `advanced?` (các ô chọn), `dirty?`, `onReset?`, `activeCount?` | `advanced` gập sau nút "Bộ lọc" trên mobile, hiện sẵn trên desktop. |
| `DateRangeFilter` | `value: DateRange`, `onChange`, `presets?` | Preset Hôm nay / Hôm qua / 7 ngày / Tháng này / Tháng trước / Tuỳ chọn. `rangeOf("today")` tạo giá trị khởi tạo; `from`/`to` là `YYYY-MM-DD` giờ VN (gồm cả hai đầu). |
| `SearchInput` | `value`, `onSearch(v)`, `placeholder?`, `delay=350`, `label?` | Debounce nội bộ; Enter tìm ngay. |
| `FilterSelect` | `label`, `value`, `onChange`, `options:{v,label}[]`, `allLabel?` | Giá trị rỗng = "Tất cả". |
| `KpiRow` | `items: {label,value,sub?,tone?,delta?,onClick?}[]`, `cols?` | `deltaPct(cur, prev)` tính % so kỳ trước. |
| `DataTable` (ui.tsx) | cũ + `emptyState?`, `defaultSort?`, `selectedKey?`, `hasMore/loadingMore/onLoadMore?`, `pageSize?`, `footer?` | Tương thích ngược. Cột: `sort: (r)=>giá trị` ⇒ bấm tiêu đề để sắp xếp (client), `num` ⇒ căn phải + số tabular, `hideBelow: 1024\|1280\|1440` ⇒ ẩn cột khi hẹp (mobile vẫn dùng thẻ). Tiêu đề cột dính khi cuộn, hàng hover. |
| `usePagedList(path, query, deps)` | trả `{rows, loading, loadingMore, hasMore, loadMore, reload, extra, error}` | Dùng API `{items,nextCursor,...extra}`; `extra` = phần còn lại (vd. `summary`). Đổi `deps` ⇒ tải lại trang đầu. |
| `ExportButton` | `filename`, `rows`, `columns:{label,value}[]`, `disabled?` | Xuất CSV (UTF-8 BOM, mở Excel được, chống CSV-injection như server — `src/web/csv.ts`). Không có thư viện xlsx trong package.json nên chỉ CSV. Xuất số thật, không kèm "₫". |
| `EmptyState` (ui.tsx) | `title`, `hint?`, `action?` | `action` là ReactNode ⇒ đặt hàng nút (vd. "Bán hàng", "Xem hôm qua", "Xoá lọc"). |
| `SplitLayout` + `DetailPanel` | `<SplitLayout open panel={<DetailPanel title onClose>…</DetailPanel>}>danh sách</SplitLayout>` | ≥1280px: panel chi tiết bên phải, danh sách vẫn hiện; nhỏ hơn: `DetailPanel` tự rơi về `Sheet`. `useWide()` cho logic riêng. |

## Mẫu một màn danh sách
```tsx
export default function Foo() {
  const [range, setRange] = useState<DateRange>(() => rangeOf("today"));
  const [q, setQ] = useState(""), [status, setStatus] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const list = usePagedList<Row>("/foo", { from: range.from, to: range.to, q, status, limit: 50 }, [range.from, range.to, q, status]);
  const sum = list.extra?.summary;
  return (
    <div className="stack">
      <PageHeader subtitle="…" actions={<ExportButton filename="foo" rows={list.rows} columns={[{ label: "Mã", value: (r) => r.code }]} />} />
      <FilterBar dirty={!!(q || status)} onReset={() => { setQ(""); setStatus(""); }}
        advanced={<FilterSelect label="Trạng thái" value={status} onChange={setStatus} options={…} />}>
        <DateRangeFilter value={range} onChange={setRange} />
        <SearchInput value={q} onSearch={setQ} placeholder="Mã, tên…" />
      </FilterBar>
      <KpiRow items={[{ label: "Số phiếu", value: sum?.count ?? "—" }]} />
      <SplitLayout open={sel != null} panel={sel != null ? <DetailPanel title="Phiếu #…" onClose={() => setSel(null)}>…</DetailPanel> : null}>
        <DataTable rows={list.rows} rowKey={(r) => r.id} onRowClick={(r) => setSel(r.id)} selectedKey={sel}
          hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
          emptyState={<EmptyState title="Chưa có …" action={<Button>…</Button>} />}
          cols={[{ key: "code", label: "Mã", title: true, sort: (r) => r.code, render: (r) => <b className="nw">{r.code}</b> },
                 { key: "total", label: "Tổng", num: true, sort: (r) => r.total, render: (r) => money(r.total) }]} />
      </SplitLayout>
    </div>
  );
}
```
Quy tắc: bộ lọc nặng/tổng hợp tính **ở server** trên toàn bộ kết quả (như `summary` của `GET /orders`), không tính từ trang đang tải; sắp xếp client chỉ áp lên các dòng đã tải. Tiền: `money()`; ngày giờ: `format.ts` (giờ VN). Phản hồi API được `camelize` tự động.

## Backend
- `GET /orders`: `from`/`to` (YYYY-MM-DD giờ VN, tối đa 366 ngày; `day` cũ vẫn dùng được), `channel`, `status`, `kind` (`return`), `cashierId`, `method`, `q` (mã đơn / tên khách / người nhận; **SĐT chỉ tìm được khi có `customers.view_pii`**), `cursor`, `limit`. Trả `items` (có `customerName`, `customerPhone` đã che, `cashierName`, `methods[]`), `nextCursor`, `summary`. `GET /orders/cashiers` cho ô lọc thu ngân.
- `GET /dashboard`: một lần gọi cho "Tổng quan"; mỗi khối chỉ có khi vai trò có quyền (giá vốn/lãi gộp cần `prices.view_cost` **và** `reports.view`; không bao giờ có lương).
- `GET /me/*` của tài khoản không có hồ sơ nhân viên: `404 employee_not_linked` (UI hiện thẻ giải thích thay vì lỗi mạng).
- `GET /api/auth/me` có thêm `storeName`.

## Việc còn lại cho các màn khác (gợi ý thứ tự)
Đơn sỉ, Đơn online, Khách sỉ, Hoá đơn, Công nợ, Thu chi, Kho/Chứng từ, Hàng hoá, Nhân viên, Bảng công… Mỗi màn: thay tiêu đề trong nội dung bằng `PageHeader`, thêm `FilterBar` + `KpiRow` nếu có số tổng, nâng `DataTable` (sort/hideBelow/phân trang), đổi `Sheet` chi tiết sang `DetailPanel`, thêm `ExportButton`, `emptyState` có nút. Cập nhật e2e chỉ khi giao diện cố ý đổi.
