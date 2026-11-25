import { useState } from "react";
import { get, items } from "../../api";
import { Card, useAsync } from "../../components/ui";
import { DateRangeFilter, FilterBar, FilterSelect, PageHeader, type DateRange } from "../../components/list";
import { downloadHref, todayVN } from "../../format";
import { useCan } from "../../store";

const FILES: { name: string; title: string; hint: string; pdf?: string }[] = [
  { name: "so-ban-hang", title: "Sổ bán hàng", hint: "Doanh thu từng chứng từ trong kỳ" },
  { name: "so-quy", title: "Sổ quỹ", hint: "Thu chi tiền mặt / ngân hàng theo quỹ, có số dư" },
  { name: "cong-no-phai-thu", title: "Công nợ phải thu", hint: "Tuổi nợ theo khách hàng", pdf: "receivable" },
  { name: "cong-no-phai-tra", title: "Công nợ phải trả", hint: "Tuổi nợ theo nhà cung cấp", pdf: "payable" },
  { name: "nhap-xuat-ton", title: "Nhập xuất tồn", hint: "Tồn đầu kỳ, nhập, bán, hao hụt, tồn cuối" },
  { name: "hoa-don-ban", title: "Hoá đơn bán", hint: "Hoá đơn và trạng thái hoá đơn điện tử" },
];
export default function Exports() {
  const can = useCan();
  const [range, setRange] = useState<DateRange>(() => ({ preset: "custom", from: todayVN(-29), to: todayVN() })), [fund, setFund] = useState("");
  const { from, to } = range;
  const funds = useAsync(() => get("/funds", undefined, { silent: true }).then((r) => items<any>(r)).catch(() => []), []);
  const qs = (n: string) => `?from=${from}&to=${to}${n === "so-quy" && fund ? `&fundId=${fund}` : ""}`;
  return (
    <div className="stack">
      <PageHeader subtitle="Tệp Excel (.xlsx) bám tinh thần sổ kế toán hộ kinh doanh; mẫu chính thức cần kế toán xác nhận." />
      <FilterBar advanced={(funds.data ?? []).length > 0 ? <FilterSelect label="Quỹ (cho sổ quỹ)" value={fund} onChange={setFund} options={(funds.data ?? []).map((f: any) => ({ v: String(f.id), label: f.name }))} allLabel="Tất cả quỹ" /> : undefined}>
        <DateRangeFilter value={range} onChange={setRange} />
      </FilterBar>
      <div className="card-grid">
        {FILES.map((f) => (
          <Card key={f.name} className="export-card">
            <div className="export-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" style={{ stroke: "currentColor", fill: "none", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }}><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M9 13l6 5M15 13l-6 5" /></svg></div>
            <div style={{ minWidth: 0, flex: 1 }}><b>{f.title}</b><div className="small muted">{f.hint}</div><div className="small muted" style={{ marginTop: 4 }}>{from === to ? from : `${from} → ${to}`}{f.name === "so-quy" && fund ? " · 1 quỹ" : ""}</div></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch", textAlign: "center" }}>
              <a className="btn soft" href={downloadHref(`/exports/${f.name}.xlsx${qs(f.name)}`)} download data-testid={`export-${f.name}`}>Tải Excel</a>
              {f.pdf && can("debt.view") && <a className="btn ghost" href={downloadHref(`/debts/aging.pdf?side=${f.pdf}&asOf=${to}`)} download data-testid={`export-${f.name}-pdf`}>Tải PDF</a>}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
