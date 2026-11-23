import { useState } from "react";
import { del, get, put } from "../../api";
import { Badge, Banner, Button, DecInput, Input, Spinner, TextArea, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { Img, ImagePicker, Markdown, Toggle } from "./kit";

/** Tab "Bán online" của hàng hoá: bật bán, slug, mô tả (markdown + xem trước), ảnh. */
export function ProductOnline({ productId }: { productId: number }) {
  const d = useAsync(() => get(`/products/${productId}/online`), [productId]);
  const [p, setP] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const cur = p ?? d.data;
  if (d.loading && !cur) return <Spinner />;
  if (!cur) return <Banner tone="danger">Không tải được cài đặt bán online.</Banner>;
  const form = f ?? { slug: cur.slug ?? "", description: cur.description ?? "", publishedOnline: cur.publishedOnline, featured: cur.featured, allowPreorder: cur.allowPreorder, onlineSort: cur.onlineSort ?? 0, step: cur.onlineStepMilli ? cur.onlineStepMilli / 1000 : ("" as number | "") };
  const set = (k: string, v: any) => setF({ ...form, [k]: v });
  const save = async () => {
    setBusy(true);
    try {
      const r = await put(`/products/${productId}/online`, { slug: form.slug.trim() || null, description: form.description, publishedOnline: form.publishedOnline, featured: form.featured, allowPreorder: form.allowPreorder, onlineSort: Number(form.onlineSort) || 0, onlineStepMilli: form.step === "" || !form.step ? null : Math.round(Number(form.step) * 1000) });
      setP(r); setF(null); toast("Đã lưu cài đặt bán online", "ok");
    } catch { /* toast */ } finally { setBusy(false); }
  };
  const imgOp = async (fn: () => Promise<any>) => { try { setP(await fn()); } catch { /* toast */ } };
  const images: { key: string; url: string }[] = cur.images ?? [];
  const move = (i: number, dir: -1 | 1) => {
    const order = images.map((_, k) => k); const j = i + dir;
    [order[i], order[j]] = [order[j], order[i]];
    imgOp(() => put(`/products/${productId}/images/order`, { order }));
  };
  return (
    <div className="stack" data-testid="product-online">
      {!cur.hasOnlinePrice && <Banner>Chưa có giá bán kênh online — khách sẽ không đặt được. Thêm giá ở mục Giá.</Banner>}
      <Toggle label="Hiển thị trên website (công khai)" checked={form.publishedOnline} onChange={(v) => set("publishedOnline", v)} />
      <div className="grid2"><Toggle label="Nổi bật trang chủ" checked={form.featured} onChange={(v) => set("featured", v)} /><Toggle label="Cho phép đặt trước" checked={form.allowPreorder} onChange={(v) => set("allowPreorder", v)} /></div>
      <Input label="Slug (đường dẫn)" value={form.slug} placeholder="để trống: tự sinh từ tên" onChange={(e) => set("slug", e.target.value)} hint="Chữ thường, số, dấu gạch ngang." />
      <div className="grid2">
        <DecInput label="Bước đặt (kg hoặc đơn vị)" value={form.step} onChange={(n) => set("step", n || "")} />
        <Input label="Thứ tự hiển thị" inputMode="numeric" value={String(form.onlineSort)} onChange={(e) => set("onlineSort", e.target.value.replace(/[^\d-]/g, ""))} />
      </div>
      <div className="grid2 md-edit">
        <TextArea label="Mô tả (markdown)" rows={8} value={form.description} onChange={(e) => set("description", e.target.value)} />
        <div className="field"><span className="lbl">Xem trước</span><div className="card flat" style={{ minHeight: 120 }} data-testid="md-preview"><Markdown text={form.description} /></div></div>
      </div>
      <Button loading={busy} onClick={save}>Lưu cài đặt bán online</Button>

      <h3>Ảnh sản phẩm ({images.length}/10)</h3>
      <div className="stack" data-testid="image-list">
        {images.map((im, i) => (
          <div key={im.key} className="row card flat" style={{ padding: 8 }}>
            <Img src={im.url} alt={`Ảnh ${i + 1}`} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="small truncate">{im.key.split("/").pop()}</div>
              {i === 0 && <Badge tone="ok">Ảnh đại diện</Badge>}
            </div>
            <Button size="sm" variant="ghost" disabled={i === 0} aria-label="Lên" onClick={() => move(i, -1)}>↑</Button>
            <Button size="sm" variant="ghost" disabled={i === images.length - 1} aria-label="Xuống" onClick={() => move(i, 1)}>↓</Button>
            <Button size="sm" variant="danger" aria-label={`Xoá ảnh ${i + 1}`} onClick={() => { if (confirm("Xoá ảnh này?")) imgOp(() => del(`/products/${productId}/images/${i}`)); }}>Xoá</Button>
          </div>
        ))}
        {images.length < 10 && <ImagePicker path={`/products/${productId}/images`} label="Tải ảnh lên" onUploaded={(r) => { setP(r); toast("Đã tải ảnh", "ok"); }} />}
        <div className="hint">JPG, PNG hoặc WebP, tối đa 2 MB.</div>
      </div>
    </div>
  );
}
