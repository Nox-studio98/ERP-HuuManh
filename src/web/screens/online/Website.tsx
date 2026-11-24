import { useState } from "react";
import { PageHeader, SearchInput, FilterBar } from "../../components/list";
import { del, get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, EmptyState, Input, Segmented, Select, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../../components/ui";
import { toast } from "../../components/toast";
import { useCan } from "../../store";
import { Img, ImagePicker, Markdown, Toggle, ymdShow } from "./kit";
import { ProductOnline } from "./ProductOnline";

export default function Website() {
  const [tab, setTab] = useState<"banners" | "posts" | "products">("banners");
  const can = useCan();
  if (!can("products.write")) return <EmptyState title="Bạn không có quyền quản lý website" />;
  return (
    <div className="stack">
      <PageHeader subtitle="Nội dung hiển thị trên website bán hàng: banner trang chủ, bài viết và sản phẩm bán online" />
      <Segmented className="tabs-d" value={tab} onChange={setTab} options={[{ v: "banners", label: "Banner" }, { v: "posts", label: "Bài viết" }, { v: "products", label: "Sản phẩm online" }]} />
      {tab === "banners" ? <Banners /> : tab === "posts" ? <Posts /> : <OnlineProducts />}
    </div>
  );
}

function OnlineProducts() {
  const [q, setQ] = useState(""); const dq = q;
  const l = useAsync(() => get("/products", { q: dq, limit: 50 }).then((r) => items<any>(r)), [dq]);
  const [sel, setSel] = useState<any>(null);
  return (
    <div className="stack">
      <FilterBar dirty={!!q} onReset={() => setQ("")}><SearchInput value={q} onSearch={setQ} placeholder="Tên, SKU, mã vạch…" label="Tìm hàng hoá" /><span className="muted small">Chọn một mặt hàng để cấu hình ảnh, mô tả và hiển thị trên website.</span></FilterBar>
      {l.loading ? <Spinner /> : !(l.data ?? []).length ? <Card><EmptyState title="Không tìm thấy hàng hoá" action={q ? <Button variant="soft" onClick={() => setQ("")}>Xoá lọc</Button> : undefined} /></Card> : (
        <div className="cards-grid sm">{(l.data ?? []).map((p) => (
          <button key={p.id} className="dt-card" onClick={() => setSel(p)}>
            <div className="row between"><b>{p.name}</b><span className="small muted num">{p.sku}</span></div>
          </button>
        ))}</div>
      )}
      {sel && <Sheet open wide onClose={() => setSel(null)} title={`Bán online · ${sel.name}`}><ProductOnline productId={sel.id} /></Sheet>}
    </div>
  );
}

/* ---------------- banner ---------------- */
function Banners() {
  const l = useAsync(() => get("/cms/banners").then((r) => items<any>(r)), []);
  const [edit, setEdit] = useState<any>(null);
  return (
    <div className="stack">
      <div className="row between wrap"><span className="muted small">{(l.data ?? []).length} banner · hiển thị theo thứ tự ở trang chủ website</span><Button onClick={() => setEdit({})}>+ Thêm banner</Button></div>
      {l.loading ? <Spinner /> : !(l.data ?? []).length ? <Card><EmptyState title="Chưa có banner" hint="Banner hiển thị ở trang chủ website." action={<Button onClick={() => setEdit({})}>+ Thêm banner</Button>} /></Card> : (
        <div className="cards-grid" data-testid="banner-list">
          {l.data!.map((b) => (
            <button key={b.id} className="dt-card" onClick={() => setEdit(b)}>
              <div className="row"><Img src={b.imageUrl} size={64} /><div className="grow" style={{ minWidth: 0 }}><b>{b.title}</b><div className="small muted truncate">{b.linkUrl ?? "Không liên kết"}</div></div>{b.active ? <Badge tone="ok">Hiện</Badge> : <Badge>Ẩn</Badge>}</div>
            </button>
          ))}
        </div>
      )}
      {edit && <BannerForm b={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); l.reload(); }} />}
    </div>
  );
}
function BannerForm({ b, onClose, onSaved }: { b: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ title: b.title ?? "", imageKey: b.imageKey ?? "", imageUrl: b.imageUrl ?? "", linkUrl: b.linkUrl ?? "", sort: b.sort ?? 0, startsAt: (b.startsAt ?? "").slice(0, 10), endsAt: (b.endsAt ?? "").slice(0, 10), active: b.active ?? true });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    const body = { title: f.title.trim(), imageKey: f.imageKey, linkUrl: f.linkUrl.trim() || null, sort: Number(f.sort) || 0, startsAt: f.startsAt || null, endsAt: f.endsAt || null, active: f.active };
    try { if (b.id) await put(`/cms/banners/${b.id}`, body); else await post("/cms/banners", body); toast("Đã lưu banner", "ok"); onSaved(); } catch { /* toast */ } finally { setBusy(false); }
  };
  const remove = async () => { if (!confirm("Xoá banner này?")) return; try { await del(`/cms/banners/${b.id}`); toast("Đã xoá banner", "ok"); onSaved(); } catch { /* */ } };
  return (
    <Sheet open onClose={onClose} title={b.id ? "Sửa banner" : "Thêm banner"} footer={<>{b.id && <Button variant="danger" onClick={remove}>Xoá</Button>}<Button className="grow" loading={busy} disabled={!f.title.trim() || !f.imageKey} onClick={save}>Lưu banner</Button></>}>
      <div className="stack">
        <Input label="Tiêu đề" value={f.title} onChange={(e) => set("title", e.target.value)} />
        <div className="row"><Img src={f.imageUrl} size={96} alt="Ảnh banner" /><ImagePicker path="/cms/images" label="Tải ảnh banner" onUploaded={(r) => { set("imageKey", r.key); set("imageUrl", r.url); }} /></div>
        {!f.imageKey && <div className="hint">Cần tải ảnh (JPG/PNG/WebP ≤ 2 MB).</div>}
        <Input label="Liên kết (đường dẫn nội bộ, vd /p/tao-envy)" value={f.linkUrl} onChange={(e) => set("linkUrl", e.target.value)} />
        <div className="grid3"><Input label="Thứ tự" inputMode="numeric" value={String(f.sort)} onChange={(e) => set("sort", e.target.value.replace(/[^\d-]/g, ""))} /><Input label="Từ ngày" type="date" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} /><Input label="Đến ngày" type="date" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} /></div>
        <Toggle label="Đang hiển thị" checked={f.active} onChange={(v) => set("active", v)} />
      </div>
    </Sheet>
  );
}

/* ---------------- bài viết ---------------- */
function Posts() {
  const l = useAsync(() => get("/cms/posts").then((r) => items<any>(r)), []);
  const [edit, setEdit] = useState<any>(null);
  const open = async (p: any) => { if (!p.id) return setEdit({}); try { setEdit(await get(`/cms/posts/${p.id}`)); } catch { /* */ } };
  return (
    <div className="stack">
      <div className="row between wrap"><span className="muted small">{(l.data ?? []).length} bài viết</span><Button onClick={() => open({})}>+ Viết bài</Button></div>
      {l.loading ? <Spinner /> : !(l.data ?? []).length ? <Card><EmptyState title="Chưa có bài viết" hint="Viết bài giới thiệu, mẹo chọn trái cây, thông báo khuyến mãi…" action={<Button onClick={() => open({})}>+ Viết bài</Button>} /></Card> : (
        <div className="cards-grid" data-testid="post-list">
          {l.data!.map((p) => (
            <button key={p.id} className="dt-card" onClick={() => open(p)}>
              <div className="row"><Img src={p.coverUrl} size={56} /><div className="grow" style={{ minWidth: 0 }}><b>{p.title}</b><div className="small muted truncate">/{p.slug}{p.publishedAt ? ` · ${ymdShow(p.publishedAt)}` : ""}</div></div><Badge tone={p.status === "published" ? "ok" : "warn"}>{p.status === "published" ? "Đã đăng" : "Nháp"}</Badge></div>
            </button>
          ))}
        </div>
      )}
      {edit && <PostForm p={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); l.reload(); }} />}
    </div>
  );
}
function PostForm({ p, onClose, onSaved }: { p: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ title: p.title ?? "", slug: p.slug ?? "", excerpt: p.excerpt ?? "", bodyMd: p.bodyMd ?? "", coverKey: p.coverKey ?? "", coverUrl: p.coverUrl ?? "", status: p.status ?? "draft" });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    const body = { title: f.title.trim(), ...(f.slug.trim() ? { slug: f.slug.trim() } : {}), excerpt: f.excerpt.trim() || null, bodyMd: f.bodyMd, coverKey: f.coverKey || null, status: f.status };
    try { if (p.id) await put(`/cms/posts/${p.id}`, body); else await post("/cms/posts", body); toast("Đã lưu bài viết", "ok"); onSaved(); } catch { /* toast */ } finally { setBusy(false); }
  };
  const remove = async () => { if (!confirm("Xoá bài viết này?")) return; try { await del(`/cms/posts/${p.id}`); toast("Đã xoá bài viết", "ok"); onSaved(); } catch { /* */ } };
  return (
    <Sheet open wide onClose={onClose} title={p.id ? "Sửa bài viết" : "Viết bài"} footer={<>{p.id && <Button variant="danger" onClick={remove}>Xoá</Button>}<Button className="grow" loading={busy} disabled={!f.title.trim() || !f.bodyMd.trim()} onClick={save}>Lưu bài viết</Button></>}>
      <div className="stack">
        <Input label="Tiêu đề" value={f.title} onChange={(e) => set("title", e.target.value)} />
        <div className="grid2"><Input label="Slug (để trống: tự sinh)" value={f.slug} onChange={(e) => set("slug", e.target.value)} /><Select label="Trạng thái" value={f.status} onChange={(e) => set("status", e.target.value)}><option value="draft">Nháp</option><option value="published">Đăng công khai</option></Select></div>
        <Input label="Tóm tắt" value={f.excerpt} onChange={(e) => set("excerpt", e.target.value)} />
        <div className="row"><Img src={f.coverUrl} size={72} alt="Ảnh bìa" /><ImagePicker path="/cms/images" label="Tải ảnh bìa" onUploaded={(r) => { set("coverKey", r.key); set("coverUrl", r.url); }} />{f.coverKey && <Button variant="ghost" onClick={() => { set("coverKey", ""); set("coverUrl", ""); }}>Bỏ ảnh</Button>}</div>
        <div className="grid2 md-edit">
          <TextArea label="Nội dung (markdown)" rows={10} value={f.bodyMd} onChange={(e) => set("bodyMd", e.target.value)} />
          <div className="field"><span className="lbl">Xem trước</span><div className="card flat" style={{ minHeight: 160 }} data-testid="md-preview"><Markdown text={f.bodyMd} /></div></div>
        </div>
        <Banner tone="info">Hỗ trợ: # tiêu đề, - danh sách, **đậm**, *nghiêng*, [chữ](/đường-dẫn).</Banner>
      </div>
    </Sheet>
  );
}
