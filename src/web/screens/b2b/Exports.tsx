import { useState } from "react";
import { get, items } from "../../api";
import { Banner, Card, Input, Select, useAsync } from "../../components/ui";
import { downloadHref, todayVN } from "../../format";

const FILES: { name: string; title: string; hint: string }[] = [
  { name: "so-ban-hang", title: "Sổ bán hàng", hint: "Doanh thu từng chứng từ trong kỳ" },
  { name: "so-quy", title: "Sổ quỹ", hint: "Thu chi tiền mặt / ngân hàng theo quỹ, có số dư" },
  { name: "cong-no-phai-thu", title: "Công nợ phải thu", hint: "Tuổi nợ theo khách hàng" },
  { name: "cong-no-phai-tra", title: "Công nợ phải trả", hint: "Tuổi nợ theo nhà cung cấp" },
  { name: "nhap-xuat-ton", title: "Nhập xuất tồn", hint: "Tồn đầu kỳ, nhập, bán, hao hụt, tồn cuối" },
  { name: "hoa-don-ban", title: "Hoá đơn bán", hint: "Hoá đơn và trạng thái hoá đơn điện tử" },
];
export default function Exports() {
  const [from, setFrom] = useState(todayVN(-29)), [to, setTo] = useState(todayVN()), [fund, setFund] = useState("");
  const funds = useAsync(() => get("/funds", undefined, { silent: true }).then((r) => items<any>(r)).catch(() => []), []);
  const qs = (n: string) => `?from=${from}&to=${to}${n === "so-quy" && fund ? `&fundId=${fund}` : ""}`;
  return (
    <div className="stack">
      <Banner tone="info">Tệp Excel (.xlsx) bám tinh thần sổ kế toán hộ kinh doanh; mẫu chính thức cần kế toán xác nhận.</Banner>
      <div className="grid2">
        <Input label="Từ ngày" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <Input label="Đến ngày" type="date" value={to} min={from} max={todayVN()} onChange={(e) => setTo(e.target.value)} />
      </div>
      {(funds.data ?? []).length > 0 && <Select label="Quỹ (cho sổ quỹ)" value={fund} onChange={(e) => setFund(e.target.value)}><option value="">Tất cả quỹ</option>{(funds.data ?? []).map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>}
      <div className="stack">
        {FILES.map((f) => (
          <Card key={f.name}>
            <div className="row between wrap">
              <div style={{ minWidth: 0 }}><b>{f.title}</b><div className="small muted">{f.hint}</div></div>
              <a className="btn soft" href={downloadHref(`/exports/${f.name}.xlsx${qs(f.name)}`)} download data-testid={`export-${f.name}`}>Tải Excel</a>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
