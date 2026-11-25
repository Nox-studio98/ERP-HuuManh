import { useState } from "react";
import { addDaysYmd } from "./util";
import { fmtDate, money, todayVN } from "../../lib/format";
import { DOC_LABEL, downloadCsv, METHOD_LABEL, nccApi, type NccBill, type NccStatementLine } from "../../lib/ncc";
import { Link, usePageMeta } from "../../lib/router";
import { Empty, ErrorBox, Field, Icon, Loading, useAsync } from "../../ui";

/** Công nợ + sao kê, và lịch sử thanh toán — chỉ dữ liệu của chính nhà cung cấp, khớp sổ công nợ phải trả của cửa hàng. */

interface DebtRes { asOf: string; summary: { balance: number; outstanding: number; overdueAmount: number; overdueCount: number; prepaid: number }; bills: NccBill[] }
interface StRes { from: string; to: string; opening: number; lines: NccStatementLine[]; closing: number; totals: { debit: number; credit: number }; truncated: boolean }

export function NccDebtPage() {
  usePageMeta("Công nợ");
  const [all, setAll] = useState(false);
  const { data, error, loading, reload } = useAsync(() => nccApi<DebtRes>(`/debt${all ? "?state=all" : ""}`), [all]);
  const [from, setFrom] = useState(() => addDaysYmd(todayVN(), -30));
  const [to, setTo] = useState(() => todayVN());
  const [range, setRange] = useState({ from: addDaysYmd(todayVN(), -30), to: todayVN() });
  const st = useAsync(() => nccApi<StRes>(`/statement?from=${range.from}&to=${range.to}`), [range.from, range.to]);
  const s = data?.summary;
  return (
    <div className="ncc-page">
      <div className="ncc-head"><div><h1>Công nợ</h1><p className="muted">Số tiền Hữu Mạnh còn phải trả bạn, hoá đơn mua và sao kê theo khoảng ngày. Số liệu lấy trực tiếp từ sổ công nợ của cửa hàng.</p></div></div>
      {loading && !data ? <Loading /> : error || !data || !s ? <ErrorBox error={error} onRetry={reload} /> : (
        <>
          <dl className="ncc-kpis">
            <div className={s.balance > 0 ? "hot" : ""}><dt>Cửa hàng còn nợ bạn</dt><dd data-testid="debt-balance">{money(s.balance)}</dd></div>
            <div className={s.overdueAmount > 0 ? "bad" : ""}><dt>Quá hạn thanh toán</dt><dd>{money(s.overdueAmount)}</dd><small>{s.overdueCount} hoá đơn</small></div>
            <div><dt>Đã trả trước, chưa gạch nợ</dt><dd>{money(s.prepaid)}</dd></div>
            <div><dt>Hoá đơn còn nợ</dt><dd>{data.bills.filter((b) => b.outstanding > 0).length}</dd></div>
          </dl>

          <section className="card-box" aria-labelledby="h-bills">
            <div className="ncc-sec-head">
              <h2 id="h-bills">Hoá đơn mua</h2>
              <div className="chips" role="group" aria-label="Lọc hoá đơn">
                <button type="button" className={`chip ${!all ? "on" : ""}`} aria-pressed={!all} onClick={() => setAll(false)}>Còn nợ</button>
                <button type="button" className={`chip ${all ? "on" : ""}`} aria-pressed={all} onClick={() => setAll(true)}>Tất cả</button>
              </div>
            </div>
            {!data.bills.length ? <Empty title={all ? "Chưa có hoá đơn mua" : "Không còn hoá đơn nào chưa thanh toán"}><p>Hoá đơn mua được ghi khi cửa hàng nhận hàng của bạn.</p></Empty> : (
              <div className="table-wrap flat">
                <table className="qo rt" data-testid="ncc-bills">
                  <thead><tr><th>Mã hoá đơn</th><th>Số HĐ của bạn</th><th>Ngày</th><th>Hạn thanh toán</th><th className="r">Tổng</th><th className="r">Còn nợ</th><th>Tình trạng</th></tr></thead>
                  <tbody>
                    {data.bills.map((b) => (
                      <tr key={b.code}>
                        <th scope="row" data-label="Mã hoá đơn" className="mono"><span className="cv">{b.code}{b.poCode && <small className="n">Đơn {b.poCode}</small>}</span></th>
                        <td data-label="Số HĐ của bạn"><span className="cv">{b.supplierRef ?? <span className="muted">—</span>}{b.provisional && <span className="status warn ncc-late">Tạm tính</span>}</span></td>
                        <td data-label="Ngày">{fmtDate(b.issueDate)}</td>
                        <td data-label="Hạn thanh toán">{fmtDate(b.dueDate)}</td>
                        <td data-label="Tổng" className="r">{money(b.total)}</td>
                        <td data-label="Còn nợ" className="r"><strong>{money(b.outstanding)}</strong></td>
                        <td data-label="Tình trạng">{b.outstanding <= 0 ? <span className="status ok">Đã thanh toán</span> : b.overdueDays > 0 ? <span className="status bad">Quá hạn {b.overdueDays} ngày</span> : <span className="status">Trong hạn</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card-box" aria-labelledby="h-st">
            <h2 id="h-st">Sao kê công nợ</h2>
            <form className="ncc-filter-row" onSubmit={(e) => { e.preventDefault(); if (from && to && from <= to) setRange({ from, to }); }}>
              <Field id="st-from" label="Từ ngày">{(p) => <input {...p} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
              <Field id="st-to" label="Đến ngày">{(p) => <input {...p} type="date" value={to} min={from} max={todayVN()} onChange={(e) => setTo(e.target.value)} />}</Field>
              <div className="ncc-filter-btns">
                <button className="btn" type="submit">Xem sao kê</button>
                {st.data && <button type="button" className="btn ghost" onClick={() => downloadCsv(`sao-ke-${st.data!.from}_${st.data!.to}.csv`, [
                  ["Ngày", "Loại chứng từ", "Số chứng từ", "Cửa hàng nợ thêm", "Giảm nợ", "Số dư"],
                  ["", "Số dư đầu kỳ", "", "", "", st.data!.opening],
                  ...st.data!.lines.map((l) => [l.date, label(l), l.docCode, l.debit || "", l.credit || "", l.balance]),
                  ["", "Số dư cuối kỳ", "", st.data!.totals.debit, st.data!.totals.credit, st.data!.closing],
                ])}><Icon n="download" size={18} /> Tải CSV</button>}
              </div>
            </form>
            {st.loading && !st.data ? <Loading /> : st.error || !st.data ? <ErrorBox error={st.error} onRetry={st.reload} /> : (
              <div className="table-wrap flat">
                <table className="qo rt ncc-st" data-testid="ncc-statement">
                  <thead><tr><th>Ngày</th><th>Loại chứng từ</th><th>Số chứng từ</th><th className="r">Cửa hàng nợ thêm</th><th className="r">Giảm nợ</th><th className="r">Số dư</th></tr></thead>
                  <tbody>
                    <tr className="sum"><td colSpan={5} data-label="">Số dư đầu kỳ ({fmtDate(st.data.from)})</td><td className="r" data-label="Số dư"><strong>{money(st.data.opening)}</strong></td></tr>
                    {st.data.lines.map((l, i) => (
                      <tr key={i}>
                        <td data-label="Ngày">{fmtDate(l.date)}</td>
                        <td data-label="Loại chứng từ">{label(l)}</td>
                        <td data-label="Số chứng từ" className="mono">{l.docCode}</td>
                        <td data-label="Cửa hàng nợ thêm" className="r">{l.debit ? money(l.debit) : "—"}</td>
                        <td data-label="Giảm nợ" className="r">{l.credit ? money(l.credit) : "—"}</td>
                        <td data-label="Số dư" className="r">{money(l.balance)}</td>
                      </tr>
                    ))}
                    {!st.data.lines.length && <tr><td colSpan={6} className="muted center">Không có phát sinh trong khoảng này.</td></tr>}
                    <tr className="sum"><td colSpan={3} data-label="">Số dư cuối kỳ ({fmtDate(st.data.to)})</td><td className="r" data-label="Nợ thêm">{money(st.data.totals.debit)}</td><td className="r" data-label="Giảm nợ">{money(st.data.totals.credit)}</td><td className="r" data-label="Số dư"><strong>{money(st.data.closing)}</strong></td></tr>
                  </tbody>
                </table>
              </div>
            )}
            {st.data?.truncated && <p className="hint">Chỉ hiện 1.000 dòng gần nhất của khoảng này. Hãy thu hẹp khoảng ngày để xem đầy đủ.</p>}
          </section>
        </>
      )}
    </div>
  );
}

const label = (l: NccStatementLine) => (l.docType === "payment" && l.method ? `Thanh toán (${METHOD_LABEL[l.method]?.toLowerCase() ?? l.method})` : DOC_LABEL[l.docType] ?? l.docType);

/* ---------------------------------------------------------------- thanh toán */

interface Pay { code: string; paidAt: string; paidDate: string; amount: number; method: string; allocations: { billCode: string; amount: number }[] }
interface PayRes { items: Pay[]; nextCursor: string | null; summary: { count: number; amount: number } }

export function NccPaymentsPage() {
  usePageMeta("Thanh toán");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [extra, setExtra] = useState<Pay[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join("&");
  const { data, error, loading, reload } = useAsync(async () => {
    const r = await nccApi<PayRes>(`/payments?${qs}`);
    setExtra([]); setCursor(r.nextCursor);
    return r;
  }, [qs]);
  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try { const r = await nccApi<PayRes>(`/payments?${qs}${qs ? "&" : ""}cursor=${cursor}`); setExtra((e) => [...e, ...r.items]); setCursor(r.nextCursor); } finally { setMore(false); }
  };
  const rows = [...(data?.items ?? []), ...extra];
  return (
    <div className="ncc-page">
      <div className="ncc-head"><div><h1>Thanh toán</h1><p className="muted">Các lần Hữu Mạnh đã thanh toán cho bạn.</p></div></div>
      <dl className="ncc-kpis two">
        <div><dt>Số lần thanh toán{qs ? " (trong khoảng lọc)" : ""}</dt><dd>{data?.summary.count ?? "—"}</dd></div>
        <div><dt>Tổng đã thanh toán{qs ? " (trong khoảng lọc)" : ""}</dt><dd data-testid="pay-total">{data ? money(data.summary.amount) : "—"}</dd></div>
      </dl>
      <div className="ncc-filters">
        <div className="ncc-filter-row">
          <Field id="pf-from" label="Từ ngày">{(p) => <input {...p} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field id="pf-to" label="Đến ngày">{(p) => <input {...p} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />}</Field>
          {(from || to) && <button className="btn ghost sm ncc-reset" onClick={() => { setFrom(""); setTo(""); }}>Xoá lọc</button>}
        </div>
      </div>
      {loading && !data ? <Loading /> : error || !data ? <ErrorBox error={error} onRetry={reload} /> : !rows.length ? (
        <Empty title="Chưa có khoản thanh toán nào" art><p>{from || to ? "Không có khoản thanh toán trong khoảng ngày đã chọn." : "Khi cửa hàng thanh toán, từng khoản sẽ hiện ở đây."}</p><Link to="/ncc/cong-no" className="btn ghost">Xem công nợ</Link></Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="qo rt" data-testid="ncc-payments">
              <thead><tr><th>Ngày</th><th>Số phiếu</th><th>Phương thức</th><th className="r">Số tiền</th><th>Thanh toán cho hoá đơn</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.code}>
                    <td data-label="Ngày">{fmtDate(p.paidDate)}</td>
                    <td data-label="Số phiếu" className="mono">{p.code}</td>
                    <td data-label="Phương thức">{METHOD_LABEL[p.method] ?? p.method}</td>
                    <td data-label="Số tiền" className="r"><strong>{money(p.amount)}</strong></td>
                    <td data-label="Thanh toán cho hoá đơn">{p.allocations.length ? <ul className="ncc-allocs">{p.allocations.map((a) => <li key={a.billCode}><span className="mono">{a.billCode}</span> <span>{money(a.amount)}</span></li>)}</ul> : <span className="muted">Trả trước, chưa gạch vào hoá đơn</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor && <div className="center"><button className="btn ghost" onClick={loadMore} disabled={more}>{more ? "Đang tải…" : "Xem thêm"}</button></div>}
        </>
      )}
    </div>
  );
}
