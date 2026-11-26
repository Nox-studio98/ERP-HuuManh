import { useState } from "react";
import { ApiError, api, get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, useAsync } from "../../components/ui";
import { FilterBar, KpiRow, PageHeader } from "../../components/list";
import { toast } from "../../components/toast";
import { money } from "../../format";
import { useCan } from "../../store";
import { useCatalog } from "../d4/shared";
import { periodLabel, thisPeriod } from "./kit";

const SCOPE: Record<string, string> = { all: "Mọi mặt hàng", group: "Nhóm hàng", product: "Mặt hàng" };
const pctText = (bp: number) => `${(bp / 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 })}%`;
const effText = (r: any) => (r.effectiveFrom || r.effectiveTo ? `${r.effectiveFrom ?? "…"} → ${r.effectiveTo ?? "…"}` : "Không giới hạn");

export default function Commission() {
  const can = useCan();
  const [tab, setTab] = useState<"rules" | "preview">("rules");
  if (!can("hr.sensitive")) return <EmptyState title="Bạn không có quyền xem hoa hồng" />;
  return (
    <div className="stack" data-testid="commission">
      <PageHeader subtitle={tab === "rules" ? "Quy tắc tính thưởng doanh số theo mặt hàng, nhóm hàng và từng nhân viên" : "Hoa hồng từng người bán trong kỳ, đúng số sẽ vào bảng lương"} />
      <Segmented fit value={tab} onChange={setTab} options={[{ v: "rules", label: "Quy tắc" }, { v: "preview", label: "Xem trước hoa hồng" }]} />
      {tab === "rules" ? <Rules /> : <Preview />}
    </div>
  );
}

function Rules() {
  const can = useCan();
  const l = useAsync(() => get("/commission/rules").then((r) => items<any>(r)), []);
  const [edit, setEdit] = useState<any | "new" | null>(null);
  const rows = l.data ?? [];
  const activeN = rows.filter((r) => r.active).length;
  return (
    <div className="stack">
      <Banner tone="info">Khi kỳ lương có ít nhất một quy tắc đang áp dụng, thưởng doanh số của kỳ đó tính theo quy tắc (thay cho tỉ lệ cố định trong Cài đặt). Quy tắc cụ thể nhất được chọn: mặt hàng, rồi nhóm hàng, rồi mọi mặt hàng; trong cùng mức, quy tắc riêng cho nhân viên thắng quy tắc chung. Trả hàng được trừ lại cho người bán của đơn gốc. Đặt tỉ lệ 0% để loại một mặt hàng khỏi hoa hồng.</Banner>
      <FilterBar>
        <span className="muted small">{activeN} quy tắc đang áp dụng / {rows.length} quy tắc</span>
        {can("payroll.approve") && <Button size="sm" onClick={() => setEdit("new")} data-testid="rule-new">Thêm quy tắc</Button>}
      </FilterBar>
      {l.loading ? <Spinner /> : (
        <DataTable rows={rows} rowKey={(r) => r.id} onRowClick={can("payroll.approve") ? setEdit : undefined} rowClass={(r) => (r.active ? "" : "muted")}
          emptyState={<EmptyState title="Chưa có quy tắc hoa hồng" hint="Chưa có quy tắc nào nên lương vẫn tính thưởng doanh số theo tỉ lệ cố định (nếu có đặt trong Cài đặt)." action={can("payroll.approve") ? <Button onClick={() => setEdit("new")}>Thêm quy tắc đầu tiên</Button> : undefined} />}
          cols={[
            { key: "n", label: "Tên quy tắc", title: true, sort: (r) => r.name, render: (r) => <b>{r.name}</b> },
            { key: "s", label: "Áp dụng cho", sort: (r) => r.scope, render: (r) => (r.scope === "all" ? SCOPE.all : r.scope === "group" ? `Nhóm: ${r.productGroupName ?? r.productGroupId}` : `Hàng: ${r.productName ?? r.productId}`) },
            { key: "e", label: "Nhân viên", hideBelow: 1024, sort: (r) => r.employeeName ?? "", render: (r) => r.employeeName ?? "Mọi người" },
            { key: "r", label: "Tỉ lệ", num: true, sort: (r) => r.rateBp, render: (r) => <b>{pctText(r.rateBp)}</b> },
            { key: "f", label: "Hiệu lực", hideBelow: 1280, render: effText },
            { key: "a", label: "Trạng thái", render: (r) => <Badge tone={r.active ? "ok" : undefined}>{r.active ? "Đang áp dụng" : "Đã ngừng"}</Badge> },
          ]} />
      )}
      {edit && <RuleSheet rule={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); l.reload(); }} />}
    </div>
  );
}

function RuleSheet({ rule, onClose, onSaved }: { rule: any | null; onClose: () => void; onSaved: () => void }) {
  const cat = useCatalog();
  const emps = useAsync(() => get("/employees", { limit: 200 }, { silent: true }).then((r) => items<any>(r)).catch(() => []), []);
  const [f, setF] = useState({
    name: rule?.name ?? "", scope: rule?.scope ?? "all", groupId: String(rule?.productGroupId ?? ""), productId: String(rule?.productId ?? ""), employeeId: String(rule?.employeeId ?? ""),
    rate: rule ? rule.rateBp / 100 : 1, from: rule?.effectiveFrom ?? "", to: rule?.effectiveTo ?? "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    const body: any = {
      name: f.name.trim(), scope: f.scope, rateBp: Math.round(Number(f.rate) * 100),
      productGroupId: f.scope === "group" ? Number(f.groupId) || null : null, productId: f.scope === "product" ? Number(f.productId) || null : null,
      employeeId: f.employeeId ? Number(f.employeeId) : null, effectiveFrom: f.from || null, effectiveTo: f.to || null, ...extra,
    };
    try {
      if (rule) await api(`/commission/rules/${rule.id}`, { method: "PATCH", body: { ...body, version: rule.version }, silent: true });
      else await post("/commission/rules", body, { silent: true });
      toast(rule ? "Đã lưu quy tắc" : "Đã thêm quy tắc", "ok");
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError && e.code === "version_conflict" ? "Quy tắc vừa được người khác sửa, hãy mở lại." : (e as Error).message, "error");
    } finally { setBusy(false); }
  };
  const bad = !f.name.trim() || (f.scope === "group" && !f.groupId) || (f.scope === "product" && !f.productId) || !(Number(f.rate) >= 0 && Number(f.rate) <= 100);
  return (
    <Sheet open onClose={onClose} title={rule ? `Sửa quy tắc` : "Thêm quy tắc hoa hồng"}
      footer={<div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
        {rule ? <Button variant={rule.active ? "danger" : "soft"} loading={busy} onClick={() => save({ active: !rule.active })}>{rule.active ? "Ngừng áp dụng" : "Áp dụng lại"}</Button> : <span />}
        <Button loading={busy} disabled={bad} onClick={() => save()} data-testid="rule-save">Lưu</Button>
      </div>}>
      <div className="stack">
        <Input label="Tên quy tắc" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Ví dụ: Hoa hồng trái cây nhập khẩu" maxLength={120} />
        <Select label="Áp dụng cho" value={f.scope} onChange={(e) => set("scope", e.target.value)}>{Object.entries(SCOPE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        {f.scope === "group" && <Select label="Nhóm hàng" value={f.groupId} onChange={(e) => set("groupId", e.target.value)}><option value="">Chọn nhóm hàng</option>{cat.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}
        {f.scope === "product" && <Select label="Mặt hàng" value={f.productId} onChange={(e) => set("productId", e.target.value)}><option value="">Chọn mặt hàng</option>{cat.products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}</Select>}
        <Select label="Nhân viên" value={f.employeeId} onChange={(e) => set("employeeId", e.target.value)}><option value="">Mọi nhân viên</option>{(emps.data ?? []).map((e: any) => <option key={e.id} value={e.id}>{e.fullName}</option>)}</Select>
        <Input label="Tỉ lệ hoa hồng (% trên doanh thu thuần)" type="number" inputMode="decimal" min={0} max={100} step={0.1} value={f.rate} onChange={(e) => set("rate", e.target.value)} hint="Ví dụ 2 = 2%. Đặt 0 để loại mặt hàng này khỏi hoa hồng." />
        <div className="two-col"><Input label="Hiệu lực từ ngày" type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /><Input label="Đến ngày" type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></div>
        <div className="small muted">Để trống ngày = không giới hạn. Đổi quy tắc sau khi đã tính lương sẽ yêu cầu tính lại trước khi duyệt.</div>
      </div>
    </Sheet>
  );
}

function Preview() {
  const [period, setPeriod] = useState(thisPeriod());
  const r = useAsync(() => get("/commission/preview", { period }), [period]);
  const d = r.data, rows: any[] = d?.items ?? [];
  return (
    <div className="stack">
      <FilterBar><Input label="Kỳ lương (tháng)" type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} /></FilterBar>
      {r.loading ? <Spinner /> : !d ? null : !d.rulesActive ? (
        <Card><EmptyState title={`Kỳ ${periodLabel(period)} chưa có quy tắc hoa hồng nào`} hint={d.legacySalesBonusBp > 0 ? `Bảng lương kỳ này tính thưởng doanh số cố định ${pctText(d.legacySalesBonusBp)} trên doanh thu bán của mỗi người.` : "Bảng lương kỳ này không có thưởng doanh số."} /></Card>
      ) : (
        <>
          <KpiRow items={[
            { label: "Tổng hoa hồng", value: money(d.total), tone: "ok" },
            { label: "Người bán có doanh số", value: rows.length },
            { label: "Quy tắc đang áp dụng", value: d.rules.length },
          ]} />
          {!rows.length ? <Card><EmptyState title="Chưa có doanh số trong kỳ này" /></Card> : (
            <DataTable rows={rows} rowKey={(x) => x.userId} defaultSort={{ key: "c", dir: "desc" }}
              cols={[
                { key: "n", label: "Người bán", title: true, sort: (x) => x.userName, render: (x) => <><b>{x.employeeName ?? x.userName}</b>{!x.paid && <> <Badge tone="warn">Chưa có hồ sơ nhân viên</Badge></>}</> },
                { key: "r", label: "Doanh thu thuần", num: true, sort: (x) => x.revenue, render: (x) => money(x.revenue) },
                { key: "u", label: "Ngoài quy tắc", num: true, hideBelow: 1280, sort: (x) => x.uncoveredRevenue, render: (x) => (x.uncoveredRevenue ? money(x.uncoveredRevenue) : "—") },
                { key: "c", label: "Hoa hồng", num: true, sort: (x) => x.commission, render: (x) => <b>{money(x.commission)}</b> },
                { key: "p", label: "Diễn giải", hideBelow: 1024, render: (x) => <span className="small">{x.parts.map((p: any) => `${p.name}: ${money(p.revenue)} × ${pctText(p.rateBp)} = ${money(p.amount)}`).join(" · ") || "—"}</span> },
              ]} />
          )}
          <div className="small muted">Doanh thu "ngoài quy tắc" là phần không khớp quy tắc nào nên không có hoa hồng. Người chưa có hồ sơ nhân viên liên kết tài khoản sẽ không nhận hoa hồng trong bảng lương.</div>
        </>
      )}
    </div>
  );
}
