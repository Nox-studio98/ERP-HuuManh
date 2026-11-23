import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useAuth, loadMe, logout, useCan } from "./store";
import { navigate, onLink, usePath } from "./router";
import { Toaster } from "./components/toast";
import { Badge, Button, Sheet, Spinner } from "./components/ui";
import { useQueue, syncQueue } from "./offline";
import { get } from "./api";
import { ROLES } from "./format";
import Login, { ChangePassword } from "./screens/Login";

const Pos = lazy(() => import("./screens/Pos"));
const ShiftClose = lazy(() => import("./screens/ShiftClose"));
const Orders = lazy(() => import("./screens/Orders"));
const Inventory = lazy(() => import("./screens/Inventory"));
const Products = lazy(() => import("./screens/Products"));
const Prices = lazy(() => import("./screens/Prices"));
const Finance = lazy(() => import("./screens/Finance"));
const Reports = lazy(() => import("./screens/Reports"));
const Approvals = lazy(() => import("./screens/Approvals"));
const Users = lazy(() => import("./screens/Users"));
const Customers = lazy(() => import("./screens/b2b/Customers"));
const Quotes = lazy(() => import("./screens/b2b/Quotes"));
const B2bOrders = lazy(() => import("./screens/b2b/B2bOrders"));
const Delivery = lazy(() => import("./screens/b2b/Delivery"));
const Invoices = lazy(() => import("./screens/b2b/Invoices"));
const Debts = lazy(() => import("./screens/b2b/Debts"));
const Bank = lazy(() => import("./screens/b2b/Bank"));
const Suppliers = lazy(() => import("./screens/b2b/Suppliers"));
const Integrations = lazy(() => import("./screens/b2b/Integrations"));
const Exports = lazy(() => import("./screens/b2b/Exports"));

const I = (d: string) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;
type Nav = { path: string; label: string; icon: ReactNode; perms: string[]; el: ReactNode; hidden?: boolean; group?: string; pri?: number };
const G = { retail: "Bán lẻ", stock: "Kho & hàng", b2b: "Bán sỉ", fin: "Tài chính", admin: "Quản trị" };
const NAV: Nav[] = [
  { path: "/pos", label: "Bán hàng", group: G.retail, pri: 1, perms: ["pos.sell"], icon: I("M3 4h2l2.4 11h10.2L20 7H6M9 20a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z"), el: <Pos /> },
  { path: "/orders", label: "Đơn hàng", group: G.retail, pri: 3, perms: ["orders.view"], icon: I("M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"), el: <Orders /> },
  { path: "/inventory", label: "Kho", group: G.stock, pri: 4, perms: ["inventory.view"], icon: I("M3 8l9-5 9 5v10l-9 5-9-5zM3 8l9 5 9-5M12 13v10"), el: <Inventory /> },
  { path: "/products", label: "Hàng hoá", group: G.stock, perms: ["inventory.view"], icon: I("M12 7c-4 0-7 3-7 7s3 7 7 7 7-3 7-7-3-7-7-7zM12 7c0-2 1-4 4-4"), el: <Products /> },
  { path: "/prices", label: "Giá", group: G.stock, perms: ["prices.view_sell"], icon: I("M20 12l-8 8-9-9V3h8zM7.5 7.5h.01"), el: <Prices /> },
  { path: "/suppliers", label: "Nhà cung cấp", group: G.stock, perms: ["inventory.view"], icon: I("M3 7h11v9H3zM14 10h4l3 3v3h-7zM7 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm10 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"), el: <Suppliers /> },
  { path: "/customers", label: "Khách sỉ", group: G.b2b, perms: ["b2b.view"], icon: I("M16 20v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1a3 3 0 00-2-2.8M16 4.2a3.5 3.5 0 010 6.6"), el: <Customers /> },
  { path: "/quotes", label: "Báo giá", group: G.b2b, perms: ["b2b.view"], icon: I("M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6"), el: <Quotes /> },
  { path: "/b2b-orders", label: "Đơn sỉ", group: G.b2b, perms: ["b2b.view"], icon: I("M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10"), el: <B2bOrders /> },
  { path: "/deliveries", label: "Soạn & giao", group: G.b2b, pri: 2, perms: ["b2b.deliver"], icon: I("M3 6h11v10H3zM14 9h4l3 3v4h-7zM7 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm10 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"), el: <Delivery /> },
  { path: "/finance", label: "Thu chi", group: G.fin, perms: ["finance.view", "finance.shift_reconcile"], icon: I("M3 7h18v12H3zM3 11h18M16 15h2"), el: <Finance /> },
  { path: "/debts", label: "Công nợ", group: G.fin, perms: ["debt.view"], icon: I("M12 3v18M16.5 7.5C16 6 14.2 5 12 5S8 6.2 8 8c0 4.5 8 2.5 8 7 0 1.8-1.8 3-4 3s-4-1-4.5-2.5"), el: <Debts /> },
  { path: "/invoices", label: "Hoá đơn", group: G.fin, perms: ["debt.view"], icon: I("M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3"), el: <Invoices /> },
  { path: "/bank", label: "Ngân hàng", group: G.fin, perms: ["debt.view", "finance.write"], icon: I("M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18"), el: <Bank /> },
  { path: "/exports", label: "Xuất Excel", group: G.fin, perms: ["reports.view"], icon: I("M12 3v12M7 10l5 5 5-5M5 21h14"), el: <Exports /> },
  { path: "/reports", label: "Báo cáo", group: G.fin, perms: ["reports.view"], icon: I("M4 20V10M10 20V4M16 20v-8M22 20H2"), el: <Reports /> },
  { path: "/approvals", label: "Duyệt", group: G.admin, perms: ["approvals.decide"], icon: I("M5 12l4 4 10-10"), el: <Approvals /> },
  { path: "/integrations", label: "Tích hợp", group: G.admin, perms: ["integrations.manage"], icon: I("M9 7V3M15 7V3M7 7h10v5a5 5 0 01-10 0zM12 17v4"), el: <Integrations /> },
  { path: "/users", label: "Người dùng", group: G.admin, perms: ["users.manage"], icon: I("M16 20v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1a3 3 0 00-2-2.8"), el: <Users /> },
  { path: "/shift-close", label: "Chốt ca", perms: ["pos.shift"], icon: I("M12 6v6l4 2M12 21a9 9 0 100-18 9 9 0 000 18z"), el: <ShiftClose />, hidden: true },
];

export function SyncBadge() {
  const q = useQueue();
  if (!q.length) return null;
  return <button className="badge warn" style={{ border: 0, cursor: "pointer", minHeight: 32 }} onClick={() => syncQueue(true)} aria-label={`Chờ đồng bộ ${q.length} đơn, bấm để thử lại`}>Chờ đồng bộ ({q.length})</button>;
}

function Shell() {
  const { user } = useAuth();
  const can = useCan();
  const path = usePath();
  const [more, setMore] = useState(false);
  const [pending, setPending] = useState(0);
  const nav = NAV.filter((n) => can(...n.perms));
  const visible = nav.filter((n) => !n.hidden);
  const cur = nav.find((n) => path === n.path || path.startsWith(n.path + "/"));
  const canApprove = can("approvals.decide");
  useEffect(() => {
    if (!canApprove) return;
    get("/approvals", { status: "pending" }, { silent: true }).then((r: any) => setPending((r.items ?? r ?? []).length)).catch(() => {});
  }, [canApprove, path]);
  useEffect(() => { if (!cur && nav.length && (path === "/" || path === "")) navigate(nav[0].path, true); }, [cur, path, nav.length]); // eslint-disable-line
  useEffect(() => { document.title = (cur ? cur.label + " · " : "") + "Hữu Mạnh ERP"; }, [cur]);
  // Thanh dưới: 4 mục ưu tiên + "Thêm" = 5 nút; phần còn lại nằm trong menu Thêm (gom nhóm)
  const mobileMain = [...visible].sort((a, b) => (a.pri ?? 99) - (b.pri ?? 99)).slice(0, 4), mobileMore = visible.filter((n) => !mobileMain.includes(n));
  const groups = (list: Nav[]) => [...new Set(list.map((n) => n.group ?? ""))].map((g) => ({ g, items: list.filter((n) => (n.group ?? "") === g) }));
  const link = (n: Nav) => (
    <a key={n.path} href={n.path} className={cur === n ? "active" : ""} aria-current={cur === n ? "page" : undefined} onClick={(e) => { onLink(e, n.path); setMore(false); }}>
      {n.icon}<span>{n.label}</span>
      {n.path === "/approvals" && pending > 0 && <span className="dot" aria-label={`${pending} chờ duyệt`}>{pending}</span>}
    </a>
  );
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Điều hướng chính">
        <div className="brand"><img src="/icon.svg" alt="" /> Hữu Mạnh</div>
        {groups(visible).map(({ g, items }) => (
          <div key={g} className="navgroup">
            {g && <div className="navgroup-h">{g}</div>}
            {items.map(link)}
          </div>
        ))}
        <div className="foot stack">
          <div className="small muted">{user?.fullName} · {ROLES[user?.role ?? ""] ?? user?.role}</div>
          <Button variant="ghost" size="sm" onClick={logout}>Đăng xuất</Button>
        </div>
      </nav>
      <header className="topbar">
        <h1>{cur?.label ?? "Hữu Mạnh"}</h1>
        <SyncBadge />
        {pending > 0 && <Badge tone="warn">{pending} chờ duyệt</Badge>}
      </header>
      <main className="main" id="main">
        <Suspense fallback={<Spinner />}>{cur ? cur.el : nav.length ? <Spinner /> : <div className="empty">Tài khoản chưa được cấp quyền truy cập.</div>}</Suspense>
      </main>
      <nav className="tabbar" aria-label="Điều hướng nhanh">
        {mobileMain.map(link)}
        {mobileMore.length > 0 && (
          <button onClick={() => setMore(true)} aria-haspopup="dialog">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" /></svg><span>Thêm</span>
            {pending > 0 && <span className="dot">{pending}</span>}
          </button>
        )}
      </nav>
      <Sheet open={more} onClose={() => setMore(false)} title="Menu">
        <div className="stack">
          {groups(mobileMore).map(({ g, items }) => (
            <div key={g} className="stack" style={{ gap: 4 }}>
              {g && <div className="navgroup-h">{g}</div>}
              {items.map((n) => (
                <a key={n.path} href={n.path} className="btn ghost" style={{ justifyContent: "flex-start", gap: 12 }} onClick={(e) => { onLink(e, n.path); setMore(false); }}>
                  <span style={{ width: 22, display: "inline-flex" }} className="navico">{n.icon}</span>{n.label}
                  {n.path === "/approvals" && pending > 0 && <Badge tone="warn">{pending}</Badge>}
                </a>
              ))}
            </div>
          ))}
          {can("pos.shift") && <a href="/shift-close" className="btn ghost" style={{ justifyContent: "flex-start" }} onClick={(e) => { onLink(e, "/shift-close"); setMore(false); }}>Chốt ca</a>}
          <div className="small muted">{user?.fullName} · {ROLES[user?.role ?? ""] ?? user?.role}</div>
          <Button variant="danger" onClick={logout}>Đăng xuất</Button>
        </div>
      </Sheet>
    </div>
  );
}

export function App() {
  const a = useAuth();
  useEffect(() => { loadMe(); }, []);
  return (
    <>
      {a.status === "loading" ? <div className="auth"><Spinner /></div> : a.status === "out" ? <Login /> : a.mustChange ? <ChangePassword /> : <Shell />}
      <Toaster />
    </>
  );
}
