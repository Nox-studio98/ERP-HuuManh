import { Fragment, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useAuth, loadMe, logout, useCan } from "./store";
import { navigate, onLink, usePath, useSearch } from "./router";
import { Toaster } from "./components/toast";
import { Badge, Button, EmptyState, Sheet, Spinner } from "./components/ui";
import { useQueue, syncQueue } from "./offline";
import { get } from "./api";
import { ROLES } from "./format";
import { PushToggle } from "./components/PushToggle";
import { ChangePasswordSheet, CommandPalette, NotificationBell, SearchButtons, ShiftIndicator, UserMenu, useCommandK, type CmdScreen } from "./components/shell";
import Login, { ChangePassword } from "./screens/Login";

const Dashboard = lazy(() => import("./screens/Dashboard"));
const Pos = lazy(() => import("./screens/Pos"));
const ShiftClose = lazy(() => import("./screens/ShiftClose"));
const ShiftHistory = lazy(() => import("./screens/ShiftHistory"));
const DailyReport = lazy(() => import("./screens/DailyReport"));
const Orders = lazy(() => import("./screens/Orders"));
const RetailCustomers = lazy(() => import("./screens/RetailCustomers"));
const Inventory = lazy(() => import("./screens/Inventory"));
const Products = lazy(() => import("./screens/Products"));
const Import = lazy(() => import("./screens/Import"));
const Prices = lazy(() => import("./screens/Prices"));
const Finance = lazy(() => import("./screens/Finance"));
const Sepay = lazy(() => import("./screens/Sepay"));
const Reports = lazy(() => import("./screens/Reports"));
const Approvals = lazy(() => import("./screens/Approvals"));
const Users = lazy(() => import("./screens/Users"));
const Settings = lazy(() => import("./screens/Settings"));
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
const OnlineOrders = lazy(() => import("./screens/online/OnlineOrders"));
const Website = lazy(() => import("./screens/online/Website"));
const Zones = lazy(() => import("./screens/online/Zones"));
const ShopAccounts = lazy(() => import("./screens/online/ShopAccounts"));
// Đợt 4 — nhân sự (agent HR), giá đối thủ / đặt hàng / khuyến mãi / giỏ quà / báo cáo tài chính (agent D4)
const HrMe = lazy(() => import("./screens/hr/Me"));
const HrEmployees = lazy(() => import("./screens/hr/Employees"));
const HrSchedule = lazy(() => import("./screens/hr/Schedule"));
const HrAttendance = lazy(() => import("./screens/hr/Attendance"));
const HrBoard = lazy(() => import("./screens/hr/Board"));
const HrTimesheets = lazy(() => import("./screens/hr/Timesheets"));
const HrPayroll = lazy(() => import("./screens/hr/Payroll"));
const HrQrDisplay = lazy(() => import("./screens/hr/QrDisplay"));
const HrStores = lazy(() => import("./screens/hr/Stores"));
const Competitors = lazy(() => import("./screens/d4/Competitors"));
const Purchasing = lazy(() => import("./screens/d4/Purchasing"));
const PurchaseOrders = lazy(() => import("./screens/d4/PurchaseOrders"));
const Promotions = lazy(() => import("./screens/d4/Promotions"));
const Bundles = lazy(() => import("./screens/d4/Bundles"));
const FinReports = lazy(() => import("./screens/d4/FinReports"));
const SalesReports = lazy(() => import("./screens/SalesReports"));
const HrCommission = lazy(() => import("./screens/hr/Commission"));

const I = (d: string) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;
type Nav = { path: string; label: string; icon: ReactNode; perms: string[]; el: ReactNode; hidden?: boolean; group?: string; pri?: number };
const G = { retail: "Bán lẻ", stock: "Kho & hàng", b2b: "Bán sỉ", fin: "Tài chính", admin: "Quản trị", online: "Bán online", hr: "Nhân sự" };
const NAV: Nav[] = [
  { path: "/dashboard", label: "Tổng quan", pri: 5, perms: ["reports.view"], icon: I("M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z"), el: <Dashboard /> },
  { path: "/pos", label: "Bán hàng", group: G.retail, pri: 1, perms: ["pos.sell"], icon: I("M3 4h2l2.4 11h10.2L20 7H6M9 20a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z"), el: <Pos /> },
  { path: "/orders", label: "Đơn hàng", group: G.retail, pri: 3, perms: ["orders.view"], icon: I("M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"), el: <Orders /> },
  { path: "/retail-customers", label: "Khách lẻ", group: G.retail, perms: ["b2b.view"], icon: I("M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0"), el: <RetailCustomers /> },
  { path: "/inventory", label: "Kho", group: G.stock, pri: 4, perms: ["inventory.view"], icon: I("M3 8l9-5 9 5v10l-9 5-9-5zM3 8l9 5 9-5M12 13v10"), el: <Inventory /> },
  { path: "/products", label: "Hàng hoá", group: G.stock, perms: ["inventory.view"], icon: I("M12 7c-4 0-7 3-7 7s3 7 7 7 7-3 7-7-3-7-7-7zM12 7c0-2 1-4 4-4"), el: <Products /> },
  { path: "/import", label: "Nhập Excel", group: G.stock, perms: ["products.write", "b2b.write", "inventory.write"], icon: I("M12 15V3M7 8l5-5 5 5M5 21h14M5 17v4M19 17v4"), el: <Import /> },
  { path: "/prices", label: "Giá", group: G.stock, perms: ["prices.view_sell"], icon: I("M20 12l-8 8-9-9V3h8zM7.5 7.5h.01"), el: <Prices /> },
  { path: "/suppliers", label: "Nhà cung cấp", group: G.stock, perms: ["inventory.view"], icon: I("M3 7h11v9H3zM14 10h4l3 3v3h-7zM7 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm10 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"), el: <Suppliers /> },
  { path: "/customers", label: "Khách sỉ", group: G.b2b, perms: ["b2b.view"], icon: I("M16 20v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1a3 3 0 00-2-2.8M16 4.2a3.5 3.5 0 010 6.6"), el: <Customers /> },
  { path: "/quotes", label: "Báo giá", group: G.b2b, perms: ["b2b.view"], icon: I("M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6"), el: <Quotes /> },
  { path: "/b2b-orders", label: "Đơn sỉ", group: G.b2b, perms: ["b2b.view"], icon: I("M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10"), el: <B2bOrders /> },
  { path: "/deliveries", label: "Soạn & giao", group: G.b2b, pri: 2, perms: ["b2b.deliver"], icon: I("M3 6h11v10H3zM14 9h4l3 3v4h-7zM7 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm10 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"), el: <Delivery /> },
  { path: "/online-orders", label: "Đơn online", group: G.online, perms: ["orders.online.manage"], icon: I("M3 4h2l2.4 11h10.2L20 7H6M9 20a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2zM13 3l3 3-3 3"), el: <OnlineOrders /> },
  { path: "/website", label: "Website", group: G.online, perms: ["products.write"], icon: I("M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"), el: <Website /> },
  { path: "/delivery-zones", label: "Khu vực giao", group: G.online, perms: ["orders.online.manage"], icon: I("M12 21s-7-6-7-11a7 7 0 0114 0c0 5-7 11-7 11zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"), el: <Zones /> },
  { path: "/shop-accounts", label: "Tài khoản khách", group: G.online, perms: ["customers.view_pii"], icon: I("M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0"), el: <ShopAccounts /> },
  { path: "/finance", label: "Thu chi", group: G.fin, perms: ["finance.view", "finance.shift_reconcile"], icon: I("M3 7h18v12H3zM3 11h18M16 15h2"), el: <Finance /> },
  { path: "/debts", label: "Công nợ", group: G.fin, perms: ["debt.view"], icon: I("M12 3v18M16.5 7.5C16 6 14.2 5 12 5S8 6.2 8 8c0 4.5 8 2.5 8 7 0 1.8-1.8 3-4 3s-4-1-4.5-2.5"), el: <Debts /> },
  { path: "/invoices", label: "Hoá đơn", group: G.fin, perms: ["debt.view"], icon: I("M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3"), el: <Invoices /> },
  { path: "/bank", label: "Ngân hàng", group: G.fin, perms: ["debt.view", "finance.write"], icon: I("M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18"), el: <Bank /> },
  { path: "/sepay", label: "Giao dịch SePay", group: G.fin, perms: ["finance.view"], icon: I("M12 3v12M8 11l4 4 4-4M4 19h16"), el: <Sepay /> },
  { path: "/exports", label: "Xuất Excel", group: G.fin, perms: ["reports.view"], icon: I("M12 3v12M7 10l5 5 5-5M5 21h14"), el: <Exports /> },
  { path: "/reports/daily", label: "Báo cáo cuối ngày", group: G.fin, perms: ["reports.view"], icon: I("M7 3h10v18H7zM10 8h4M10 12h4M10 16h2"), el: <DailyReport /> }, // đứng trước /reports (khớp tiền tố theo thứ tự)
  { path: "/reports", label: "Báo cáo", group: G.fin, perms: ["reports.view"], icon: I("M4 20V10M10 20V4M16 20v-8M22 20H2"), el: <Reports /> },
  { path: "/approvals", label: "Duyệt", group: G.admin, perms: ["approvals.decide"], icon: I("M5 12l4 4 10-10"), el: <Approvals /> },
  { path: "/integrations", label: "Tích hợp", group: G.admin, perms: ["integrations.manage"], icon: I("M9 7V3M15 7V3M7 7h10v5a5 5 0 01-10 0zM12 17v4"), el: <Integrations /> },
  { path: "/users", label: "Người dùng", group: G.admin, perms: ["users.manage"], icon: I("M16 20v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1a3 3 0 00-2-2.8"), el: <Users /> },
  { path: "/settings", label: "Cài đặt", group: G.admin, perms: ["settings.view"], icon: I("M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"), el: <Settings /> },
  // ===== Đợt 4 =====
  { path: "/promotions", label: "Khuyến mãi", group: G.retail, perms: ["prices.view_sell"], icon: I("M20 12l-8 8-9-9V3h8zM8 8h.01M15 9l-6 6"), el: <Promotions /> },
  { path: "/bundles", label: "Giỏ quà & đặt trước", group: G.retail, perms: ["pos.sell"], icon: I("M4 10h16v10H4zM2 7h20v3H2zM12 7v13M12 7c-2-4-6-3-6-1s3 1 6 1c3 0 6 1 6-1s-4-3-6 1"), el: <Bundles /> },
  { path: "/purchasing", label: "Gợi ý đặt hàng", group: G.stock, perms: ["purchasing.view"], icon: I("M3 5h18M6 5v14h12V5M9 9h6M9 13h6"), el: <Purchasing /> },
  { path: "/purchase-orders", label: "Đơn đặt NCC", group: G.stock, perms: ["purchasing.view"], icon: I("M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h4"), el: <PurchaseOrders /> },
  { path: "/competitors", label: "Giá đối thủ", group: G.stock, perms: ["competitors.view"], icon: I("M4 19h16M7 16V9M12 16V5M17 16v-4"), el: <Competitors /> },
  { path: "/sales-reports", label: "Báo cáo bán hàng", group: G.fin, perms: ["reports.view"], icon: I("M3 20h18M6 16v-5M11 16V6M16 16v-8M21 16v-3"), el: <SalesReports /> },
  { path: "/fin-reports", label: "Báo cáo tài chính", group: G.fin, perms: ["reports.view"], icon: I("M4 4h16v16H4zM8 15v-3M12 15V9M16 15v-5"), el: <FinReports /> },
  { path: "/me", label: "Chấm công", group: G.hr, pri: 2, perms: ["hr.self"], icon: I("M12 6v6l4 2M12 21a9 9 0 100-18 9 9 0 000 18z"), el: <HrMe /> },
  { path: "/hr/employees", label: "Nhân viên", group: G.hr, perms: ["hr.view"], icon: I("M16 20v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7z"), el: <HrEmployees /> },
  { path: "/hr/attendance", label: "Bảng chấm công", group: G.hr, perms: ["hr.view"], icon: I("M4 5h16v15H4zM4 9h16M8 3v4M16 3v4M8 13l2 2 4-4"), el: <HrBoard /> },
  { path: "/hr/schedule", label: "Lịch ca", perms: ["hr.view"], hidden: true, icon: I("M4 5h16v15H4zM4 9h16M8 3v4M16 3v4"), el: <HrSchedule /> },
  { path: "/hr/approvals", label: "Duyệt chấm công", perms: ["hr.schedule"], hidden: true, icon: I("M9 12l2 2 4-4M12 21a9 9 0 100-18 9 9 0 000 18z"), el: <HrAttendance /> },
  { path: "/hr/timesheets", label: "Bảng công", group: G.hr, perms: ["hr.view"], icon: I("M4 4h16v16H4zM4 10h16M10 4v16"), el: <HrTimesheets /> },
  { path: "/payroll", label: "Bảng lương", group: G.hr, perms: ["hr.sensitive"], icon: I("M3 7h18v10H3zM12 12a2 2 0 100-4 2 2 0 000 4zM6 12h.01M18 12h.01"), el: <HrPayroll /> },
  { path: "/hr/commission", label: "Hoa hồng bán hàng", group: G.hr, perms: ["hr.sensitive"], icon: I("M19 5L5 19M7.5 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm9 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"), el: <HrCommission /> },
  { path: "/hr/stores", label: "Cửa hàng", group: G.hr, perms: ["hr.manage", "users.manage"], icon: I("M12 21s-7-6-7-11a7 7 0 0114 0c0 5-7 11-7 11zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"), el: <HrStores /> },
  { path: "/hr/qr", label: "Mã QR chấm công", perms: ["hr.schedule"], hidden: true, icon: I("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2z"), el: <HrQrDisplay /> },
  { path: "/shift-history", label: "Lịch sử ca", group: G.retail, perms: ["pos.shift", "reports.view"], icon: I("M12 8v5l3 2M3 12a9 9 0 109-9M3 4v5h5"), el: <ShiftHistory /> },
  { path: "/shift-close", label: "Chốt ca", perms: ["pos.shift"], icon: I("M12 6v6l4 2M12 21a9 9 0 100-18 9 9 0 000 18z"), el: <ShiftClose />, hidden: true },
];

export function SyncBadge() {
  const q = useQueue();
  if (!q.length) return null;
  return <button className="badge warn" style={{ border: 0, cursor: "pointer", minHeight: 32 }} onClick={() => syncQueue(true)} aria-label={`Chờ đồng bộ ${q.length} đơn, bấm để thử lại`}>Chờ đồng bộ ({q.length})</button>;
}

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* bộ nhớ bị chặn */ } };
const lsJson = <T,>(k: string, d: T): T => { try { return JSON.parse(lsGet(k) ?? "") as T; } catch { return d; } };
const CHEV = "M6 9l6 6 6-6";
const STAR = "M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.3l1.1-6.2L3 9.7l6.2-.9z";

/** Gõ thẳng URL không có quyền (hoặc không tồn tại): quyền đã tải xong nên báo rõ thay vì quay mãi. */
function NoAccess({ path }: { path: string }) {
  const known = NAV.some((n) => path === n.path || path.startsWith(n.path + "/"));
  return (
    <EmptyState
      title={known ? "Bạn không có quyền xem trang này" : "Không tìm thấy trang này"}
      hint={known ? "Liên hệ chủ cửa hàng nếu bạn cần truy cập." : undefined}
      action={<Button onClick={() => navigate("/", true)}>Về trang chính</Button>}
    />
  );
}

function Shell() {
  const { user } = useAuth();
  const can = useCan();
  const path = usePath();
  const search = useSearch();
  const [more, setMore] = useState(false);
  const [pw, setPw] = useState(false);
  const [pending, setPending] = useState(0);
  const [collapsed, setCollapsed] = useState(() => lsGet("hm_sb_collapsed") === "1");
  const [closedGroups, setClosedGroups] = useState<string[]>(() => lsJson<string[]>("hm_nav_closed", []));
  const [favs, setFavs] = useState<string[]>(() => lsJson<string[]>("hm_nav_fav", []));
  const k = useCommandK();
  const nav = NAV.filter((n) => can(...n.perms));
  const visible = nav.filter((n) => !n.hidden);
  const cur = nav.find((n) => path === n.path || path.startsWith(n.path + "/"));
  const canApprove = can("approvals.decide");
  useEffect(() => {
    if (!canApprove) return;
    get("/approvals", { status: "pending" }, { silent: true }).then((r: any) => setPending((r.items ?? r ?? []).length)).catch(() => {});
  }, [canApprove, path]);
  // Trang đích mặc định: chủ/quản lý/kế toán (có báo cáo) vào Tổng quan; thu ngân vào Bán hàng; nhân viên vào Của tôi
  useEffect(() => {
    if (!cur && nav.length && (path === "/" || path === "")) navigate(nav.find((n) => n.path === "/dashboard")?.path ?? nav[0].path, true);
  }, [cur, path, nav.length]); // eslint-disable-line
  useEffect(() => { document.title = (cur ? cur.label + " · " : "") + "Hữu Mạnh ERP"; }, [cur]);
  const setColl = (v: boolean) => { setCollapsed(v); lsSet("hm_sb_collapsed", v ? "1" : "0"); };
  const toggleGroup = (g: string) => setClosedGroups((c) => { const n = c.includes(g) ? c.filter((x) => x !== g) : [...c, g]; lsSet("hm_nav_closed", JSON.stringify(n)); return n; });
  const toggleFav = (p: string) => setFavs((c) => { const n = c.includes(p) ? c.filter((x) => x !== p) : [...c, p]; lsSet("hm_nav_fav", JSON.stringify(n)); return n; });
  // Thanh dưới: 4 mục ưu tiên + "Thêm" = 5 nút; phần còn lại nằm trong menu Thêm (gom nhóm)
  const mobileMain = [...visible].sort((a, b) => (a.pri ?? 99) - (b.pri ?? 99)).slice(0, 4), mobileMore = visible.filter((n) => !mobileMain.includes(n));
  const groups = (list: Nav[]) => [...new Set(list.map((n) => n.group ?? ""))].map((g) => ({ g, items: list.filter((n) => (n.group ?? "") === g) }));
  const badge = (n: Nav) => n.path === "/approvals" && pending > 0 && <span className="dot" aria-label={`${pending} chờ duyệt`}>{pending}</span>;
  const link = (n: Nav) => (
    <a key={n.path} href={n.path} className={cur === n ? "active" : ""} aria-current={cur === n ? "page" : undefined} title={collapsed ? n.label : undefined} onClick={(e) => { onLink(e, n.path); setMore(false); }}>
      {n.icon}<span>{n.label}</span>{badge(n)}
    </a>
  );
  const sideItem = (n: Nav) => (
    <div className="navitem" key={n.path}>
      {link(n)}
      <button type="button" className={"pin" + (favs.includes(n.path) ? " on" : "")} aria-label={favs.includes(n.path) ? `Bỏ ghim ${n.label}` : `Ghim ${n.label} lên đầu`} aria-pressed={favs.includes(n.path)} onClick={() => toggleFav(n.path)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={STAR} /></svg>
      </button>
    </div>
  );
  const favItems = favs.map((p) => visible.find((n) => n.path === p)).filter(Boolean) as Nav[];
  const sideGroup = (g: string, items: Nav[], label: string) => {
    const closed = !collapsed && closedGroups.includes(g);
    const shown = closed ? items.filter((n) => n === cur) : items; // nhóm gập vẫn hiện mục đang mở
    return (
      <div key={g || "_"} className="navgroup">
        {label && (
          <button type="button" className="navgroup-h btn-h" aria-expanded={!closed} onClick={() => toggleGroup(g)}>
            <span>{label}</span>
            <svg className="chev" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: closed ? "rotate(-90deg)" : undefined }}><path d={CHEV} /></svg>
          </button>
        )}
        {shown.map(sideItem)}
      </div>
    );
  };
  const screens: CmdScreen[] = nav.map((n) => ({ path: n.path, label: n.label, group: n.group, icon: n.icon }));
  return (
    <div className={"shell" + (collapsed ? " sb-collapsed" : "")}>
      <nav className={"sidebar" + (collapsed ? " collapsed" : "")} aria-label="Điều hướng chính">
        <div className="brand">
          <img src="/icon.svg" alt="" /><span className="brand-name">Hữu Mạnh</span>
          <button type="button" className="sidebar-toggle" onClick={() => setColl(!collapsed)} aria-label={collapsed ? "Mở rộng thanh bên" : "Thu gọn thanh bên"} title={collapsed ? "Mở rộng" : "Thu gọn"}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={collapsed ? "M13 6l6 6-6 6M5 6l6 6-6 6" : "M11 6l-6 6 6 6M19 6l-6 6 6 6"} /></svg>
          </button>
        </div>
        {favItems.length > 0 && sideGroup("__fav", favItems, "Ghim")}
        {groups(visible).map(({ g, items }) => sideGroup(g, items, g))}
      </nav>
      <header className="topbar">
        <h1>{cur?.label ?? "Hữu Mạnh"}</h1>
        <span className="tb-store" title="Cửa hàng">{user?.storeName ?? ""}</span>
        <ShiftIndicator path={path} />
        <SyncBadge />
        {pending > 0 && <Badge tone="warn">{pending} chờ duyệt</Badge>}
        <span className="grow tb-spacer" />
        <div className="tb-right">
          <SearchButtons onOpen={() => k.setOpen(true)} />
          <NotificationBell path={path} />
          <UserMenu />
        </div>
      </header>
      <main className="main" id="main">
        <Suspense fallback={<Spinner />}>{cur ? <Fragment key={cur.path + search}>{cur.el}</Fragment> : !nav.length ? <div className="empty">Tài khoản chưa được cấp quyền truy cập.</div> : path === "/" || path === "" ? <Spinner /> : <NoAccess path={path} />}</Suspense>
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
      {k.open && <CommandPalette screens={screens} onClose={() => k.setOpen(false)} />}
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
          <PushToggle />
          <Button variant="ghost" onClick={() => { setMore(false); setPw(true); }}>Đổi mật khẩu</Button>
          <Button variant="danger" onClick={logout}>Đăng xuất</Button>
        </div>
      </Sheet>
      {pw && <ChangePasswordSheet onClose={() => setPw(false)} />}
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
