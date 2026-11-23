import { useEffect, useState } from "react";
import { api, errMsg, type Card, type Home } from "../lib/api";
import { Link, navigate, useQuery, usePageMeta } from "../lib/router";
import { Empty, ErrorBox, Icon, Loading, ProductCard, useAsync } from "../ui";

const SORTS = [
  { v: "popular", t: "Nổi bật" },
  { v: "new", t: "Mới nhất" },
  { v: "price_asc", t: "Giá thấp → cao" },
  { v: "price_desc", t: "Giá cao → thấp" },
];

export function Catalog() {
  const qs = useQuery();
  const q = qs.get("q") ?? "";
  const groupId = qs.get("groupId") ?? "";
  const sort = qs.get("sort") ?? "popular";
  const [inStock, setInStock] = useState(false);
  const groups = useAsync(() => api<Home>("/home").then((h) => h.groups), []);
  const gName = groups.data?.find((g) => String(g.id) === groupId)?.name;
  usePageMeta(q ? `Tìm “${q}”` : gName ?? "Tất cả trái cây", q ? `Kết quả tìm kiếm “${q}” tại Hữu Mạnh` : `Mua ${gName ?? "trái cây"} tươi tại Hữu Mạnh, giao tận nhà.`);

  const [items, setItems] = useState<Card[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: unknown; more: boolean }>({ loading: true, error: null, more: false });
  const url = (cursor?: string) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (groupId) p.set("groupId", groupId);
    if (sort !== "popular") p.set("sort", sort);
    if (cursor) p.set("cursor", cursor);
    return "/products" + (p.size ? "?" + p : "");
  };
  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null, more: false });
    api<{ items: Card[]; nextCursor: string | null }>(url()).then(
      (r) => { if (live) { setItems(r.items); setNext(r.nextCursor); setState({ loading: false, error: null, more: false }); } },
      (e) => live && setState({ loading: false, error: e, more: false }),
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, groupId, sort]);
  const more = async () => {
    if (!next) return;
    setState((s) => ({ ...s, more: true }));
    try {
      const r = await api<{ items: Card[]; nextCursor: string | null }>(url(next));
      setItems((a) => [...a, ...r.items]);
      setNext(r.nextCursor);
      setState((s) => ({ ...s, more: false }));
    } catch (e) { setState((s) => ({ ...s, more: false, error: e })); }
  };
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(location.search);
    if (v) p.set(k, v); else p.delete(k);
    navigate(`/san-pham${p.size ? "?" + p : ""}`, true);
  };
  const shown = inStock ? items.filter((p) => p.inStock) : items;
  return (
    <div className="wrap page">
      <nav className="crumbs" aria-label="Đường dẫn"><Link to="/">Trang chủ</Link><span aria-hidden="true">/</span><span>Sản phẩm</span></nav>
      <h1>{q ? <>Kết quả cho “{q}”</> : gName ?? "Tất cả trái cây"}</h1>

      <div className="filters" role="group" aria-label="Bộ lọc">
        <div className="chips scroll">
          <button className={`chip ${!groupId ? "on" : ""}`} onClick={() => set("groupId", "")} aria-pressed={!groupId}>Tất cả</button>
          {groups.data?.map((g) => <button key={g.id} className={`chip ${String(g.id) === groupId ? "on" : ""}`} onClick={() => set("groupId", String(g.id))} aria-pressed={String(g.id) === groupId}>{g.name}</button>)}
        </div>
        <div className="filter-row">
          <label className="sel"><Icon n="filter" size={16} /><span className="sr-only">Sắp xếp</span>
            <select value={sort} onChange={(e) => set("sort", e.target.value === "popular" ? "" : e.target.value)} aria-label="Sắp xếp">
              {SORTS.map((s) => <option key={s.v} value={s.v}>{s.t}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} /> Chỉ hiện còn hàng</label>
        </div>
      </div>

      {state.loading ? <Loading /> : state.error && !items.length ? <ErrorBox error={state.error} onRetry={() => set("", "")} /> : shown.length === 0 ? (
        <Empty title={q ? `Không tìm thấy “${q}”` : "Chưa có sản phẩm phù hợp"} art>
          <p>Thử từ khoá khác hoặc xem tất cả trái cây.</p>
          <Link to="/san-pham" className="btn">Xem tất cả</Link>
        </Empty>
      ) : (
        <>
          <p className="muted count-line" role="status">{shown.length} sản phẩm{next ? "+" : ""}</p>
          <div className="grid">{shown.map((p, i) => <ProductCard key={p.id} p={p} eager={i < 4} />)}</div>
          {typeof state.error === "object" && state.error && <p className="hint err" role="alert">{errMsg(state.error)}</p>}
          {next && <div className="center"><button className="btn ghost" onClick={more} disabled={state.more}>{state.more ? "Đang tải…" : "Xem thêm"}</button></div>}
        </>
      )}
    </div>
  );
}
