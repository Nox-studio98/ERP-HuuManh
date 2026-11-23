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

const I = (d: string) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;
type Nav = { path: string; label: string; icon: ReactNode; perms: string[]; el: ReactNode; hidden?: boolean };
const NAV: Nav[] = [
  { path: "/pos", label: "Bán hàng", perms: ["pos.sell"], icon: I("M3 4h2l2.4 11h10.2L20 7H6M9 20a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z"), el: <Pos /> },
  { path: "/orders", label: "Đơn hàng", perms: ["orders.view"], icon: I("M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"), el: <Orders /> },
  { path: "/inventory", label: "Kho", perms: ["inventory.view"], icon: I("M3 8l9-5 9 5v10l-9 5-9-5zM3 8l9 5 9-5M12 13v10"), el: <Inventory /> },
  { path: "/products", label: "Hàng hoá", perms: ["inventory.view"], icon: I("M12 7c-4 0-7 3-7 7s3 7 7 7 7-3 7-7-3-7-7-7zM12 7c0-2 1-4 4-4"), el: <Products /> },
  { path: "/prices", label: "Giá", perms: ["prices.view_sell"], icon: I("M20 12l-8 8-9-9V3h8zM7.5 7.5h.01"), el: <Prices /> },
  { path: "/finance", label: "Thu chi", perms: ["finance.view", "finance.shift_reconcile"], icon: I("M3 7h18v12H3zM3 11h18M16 15h2"), el: <Finance /> },
  { path: "/reports", label: "Báo cáo", perms: ["reports.view"], icon: I("M4 20V10M10 20V4M16 20v-8M22 20H2"), el: <Reports /> },
  { path: "/approvals", label: "Duyệt", perms: ["approvals.decide"], icon: I("M5 12l4 4 10-10"), el: <Approvals /> },
  { path: "/users", label: "Người dùng", perms: ["users.manage"], icon: I("M16 20v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1a3 3 0 00-2-2.8"), el: <Users /> },
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
  const mobileMain = visible.slice(0, 4), mobileMore = visible.slice(4);
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
        {visible.map(link)}
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
          {mobileMore.map((n) => (
            <a key={n.path} href={n.path} className="btn ghost" style={{ justifyContent: "flex-start", gap: 12 }} onClick={(e) => { onLink(e, n.path); setMore(false); }}>
              <span style={{ width: 22, display: "inline-flex" }} className="navico">{n.icon}</span>{n.label}
              {n.path === "/approvals" && pending > 0 && <Badge tone="warn">{pending}</Badge>}
            </a>
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
