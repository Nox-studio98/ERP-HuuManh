/** Thành phần thanh trên cùng (desktop + mobile): tìm nhanh Ctrl+K, chuông thông báo, menu người dùng, chỉ báo ca. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { get, post, items as asItems } from "../api";
import { navigate } from "../router";
import { changePassword, logout, useAuth, useCan } from "../store";
import { fmtDateTime, fmtTime, money, ROLES } from "../format";
import { Button, Input, Sheet } from "./ui";
import { PushToggle } from "./PushToggle";
import { toast } from "./toast";

const Ico = ({ d, size }: { d: string; size?: number }) => <svg viewBox="0 0 24 24" aria-hidden="true" width={size} height={size}><path d={d} /></svg>;
export const ICON_SEARCH = "M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.5-4.5";
const ICON_BELL = "M6 9a6 6 0 1112 0c0 6 2 7.5 2 7.5H4S6 15 6 9zM10 20a2 2 0 004 0";

export const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

/** Đóng popover khi bấm ra ngoài / Esc */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return { open, setOpen, ref };
}

/* ---------------- Chỉ báo ca đang mở (vai trò có POS) ---------------- */
export function ShiftIndicator({ path }: { path: string }) {
  const can = useCan();
  const [shift, setShift] = useState<{ openedAt: string } | null | undefined>();
  const on = can("pos.shift");
  useEffect(() => {
    if (!on) return;
    let live = true;
    get("/shifts/current", undefined, { silent: true }).then((r: any) => live && setShift(r.shift ?? null)).catch(() => {});
    return () => { live = false; };
  }, [on, path]);
  if (!on || shift === undefined) return null;
  return shift
    ? <button type="button" className="tb-shift badge ok" style={{ border: 0, cursor: "pointer" }} onClick={() => navigate("/shift-close")} title="Bấm để chốt ca">● Ca đang mở từ {fmtTime(shift.openedAt)}</button>
    : <button type="button" className="tb-shift badge warn" style={{ border: 0, cursor: "pointer" }} onClick={() => navigate("/pos")}>Chưa mở ca</button>;
}

/* ---------------- Chuông thông báo ---------------- */
type Notif = { id: number; kind: string; title: string; body?: string; refType?: string; refId?: number | string; createdAt: string; readAt?: string | null };
export function NotificationBell({ path }: { path: string }) {
  const can = useCan();
  const on = can("inventory.view");
  const [list, setList] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const pop = usePopover();
  const load = useCallback(() => {
    get("/notifications", undefined, { silent: true }).then((r: any) => { setList(asItems<Notif>(r)); setUnread(r.unread ?? 0); }).catch(() => {});
  }, []);
  useEffect(() => { if (!on) return; load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [on, load, path]);
  if (!on) return null;
  const go = async (n: Notif) => {
    pop.setOpen(false);
    if (!n.readAt) { post(`/notifications/${n.id}/read`, {}, { silent: true }).then(load).catch(() => {}); }
    if (n.refType === "order" && n.refId) navigate(`/orders?open=${n.refId}`);
    else if (n.refType === "lot" || n.kind.startsWith("stock") || n.kind.includes("expir")) navigate("/inventory");
  };
  const readAll = async () => { await Promise.all(list.filter((n) => !n.readAt).map((n) => post(`/notifications/${n.id}/read`, {}, { silent: true }).catch(() => {}))); load(); };
  return (
    <div className="pop-wrap" ref={pop.ref}>
      <button type="button" className="tb-btn" aria-label={unread ? `Thông báo, ${unread} chưa đọc` : "Thông báo"} aria-expanded={pop.open} onClick={() => { pop.setOpen(!pop.open); if (!pop.open) load(); }}>
        <Ico d={ICON_BELL} />{unread > 0 && <span className="dot">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {pop.open && (
        <div className="pop notif" role="dialog" aria-label="Thông báo">
          <div className="notif-head"><span>Thông báo</span>{unread > 0 && <Button size="sm" variant="ghost" onClick={readAll}>Đánh dấu đã đọc</Button>}</div>
          <div className="notif-list">
            {!list.length && <div className="empty small" style={{ padding: 24 }}>Chưa có thông báo nào.</div>}
            {list.slice(0, 30).map((n) => (
              <button key={n.id} type="button" className={"notif-item" + (n.readAt ? "" : " unread")} onClick={() => go(n)}>
                <div className="t">{n.title}</div>{n.body && <div className="b">{n.body}</div>}<div className="b">{fmtDateTime(n.createdAt)}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Menu người dùng ---------------- */
export function UserMenu() {
  const { user } = useAuth();
  const pop = usePopover();
  const [pw, setPw] = useState(false);
  if (!user) return null;
  const initials = user.fullName.trim().split(/\s+/).slice(-1)[0]?.[0]?.toUpperCase() ?? "?";
  return (
    <div className="pop-wrap tb-userwrap" ref={pop.ref}>
      <button type="button" className="tb-user" aria-haspopup="menu" aria-expanded={pop.open} onClick={() => pop.setOpen(!pop.open)}>
        <span className="avatar" aria-hidden="true">{initials}</span><span className="tb-user-name small">{user.fullName}</span>
      </button>
      {pop.open && (
        <div className="pop" role="menu">
          <div style={{ padding: "8px 12px" }}><b>{user.fullName}</b><div className="small muted">{ROLES[user.role] ?? user.role} · @{user.username}</div></div>
          <hr />
          <button role="menuitem" className="pop-item" onClick={() => { pop.setOpen(false); setPw(true); }}>Đổi mật khẩu</button>
          <div style={{ padding: "4px 8px" }}><PushToggle /></div>
          <hr />
          <button role="menuitem" className="pop-item" style={{ color: "var(--danger)" }} onClick={logout}>Đăng xuất</button>
        </div>
      )}
      {pw && <ChangePasswordSheet onClose={() => setPw(false)} />}
    </div>
  );
}

export function ChangePasswordSheet({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState(""), [n1, setN1] = useState(""), [n2, setN2] = useState(""), [busy, setBusy] = useState(false);
  const err = n1 && n1.length < 10 ? "Mật khẩu mới tối thiểu 10 ký tự" : n2 && n1 !== n2 ? "Mật khẩu nhập lại chưa khớp" : "";
  const submit = async () => {
    if (err) return; setBusy(true);
    try { await changePassword(cur, n1); toast("Đã đổi mật khẩu", "ok"); onClose(); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Đổi mật khẩu" footer={<Button block loading={busy} disabled={!cur || !n1 || !n2 || !!err} onClick={submit}>Đổi mật khẩu</Button>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Input label="Mật khẩu hiện tại" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
        <Input label="Mật khẩu mới" type="password" value={n1} onChange={(e) => setN1(e.target.value)} autoComplete="new-password" />
        <Input label="Nhập lại mật khẩu mới" type="password" value={n2} onChange={(e) => setN2(e.target.value)} autoComplete="new-password" error={err} />
      </form>
    </Sheet>
  );
}

/* ---------------- Tìm nhanh Ctrl+K ---------------- */
export type CmdScreen = { path: string; label: string; group?: string; icon: ReactNode };
type Hit = { id: string; group: string; label: string; sub?: string; icon?: ReactNode; to: string };

export function useCommandK() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); } };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);
  return { open, setOpen };
}

export function SearchButtons({ onOpen }: { onOpen: () => void }) {
  return (
    <>
      <button type="button" className="tb-search-wide" onClick={onOpen} aria-label="Tìm nhanh (Ctrl+K)"><Ico d={ICON_SEARCH} /><span>Tìm màn hình, đơn, khách, hàng…</span><kbd>Ctrl K</kbd></button>
      <button type="button" className="tb-btn tb-search-narrow" onClick={onOpen} aria-label="Tìm nhanh"><Ico d={ICON_SEARCH} /></button>
    </>
  );
}

export function CommandPalette({ screens, onClose }: { screens: CmdScreen[]; onClose: () => void }) {
  const can = useCan();
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const nq = norm(q.trim());

  const local: Hit[] = screens.filter((s) => !nq || norm(s.label).includes(nq) || norm(s.group ?? "").includes(nq)).slice(0, nq ? 8 : 60)
    .map((s) => ({ id: "s" + s.path, group: "Màn hình", label: s.label, sub: s.group, icon: s.icon, to: s.path }));

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setRemote([]); return; }
    let live = true;
    const timer = setTimeout(async () => {
      setBusy(true);
      const hits: Hit[] = [];
      const jobs: Promise<void>[] = [];
      if (can("orders.view")) jobs.push(get("/orders", { q: t, limit: 5 }, { silent: true }).then((r: any) => { for (const o of asItems<any>(r)) hits.push({ id: "o" + o.id, group: "Đơn hàng", label: o.code, sub: [o.customerName, money(o.total)].filter(Boolean).join(" · "), to: `/orders?open=${o.id}` }); }).catch(() => {}));
      if (can("b2b.view")) jobs.push(get("/customers", { q: t, limit: 5 }, { silent: true }).then((r: any) => { for (const c of asItems<any>(r)) hits.push({ id: "c" + c.id, group: "Khách hàng", label: c.name, sub: c.code, to: `/customers/${c.id}` }); }).catch(() => {}));
      if (can("inventory.view")) jobs.push(get("/products", { q: t, limit: 5, active: 1 }, { silent: true }).then((r: any) => { for (const p of asItems<any>(r)) hits.push({ id: "p" + p.id, group: "Hàng hoá", label: p.name, sub: p.sku, to: `/products?q=${encodeURIComponent(p.sku ?? p.name)}` }); }).catch(() => {}));
      await Promise.all(jobs);
      if (live) { setRemote(hits); setBusy(false); }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [q]); // eslint-disable-line

  const all = [...local, ...remote];
  useEffect(() => { setIdx(0); }, [q, remote.length]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [idx]);
  const pick = (h?: Hit) => { if (!h) return; onClose(); navigate(h.to); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(all.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(all[idx]); }
    else if (e.key === "Escape") onClose();
  };
  const groups = [...new Set(all.map((h) => h.group))];
  return (
    <div className="cmdk-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Tìm nhanh" onKeyDown={onKey}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Gõ tên màn hình, mã đơn, tên khách, hàng hoá…" aria-label="Tìm nhanh" role="combobox" aria-expanded="true" aria-controls="cmdk-list" />
        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
          {groups.map((g) => (
            <div key={g}>
              <div className="cmdk-group">{g}</div>
              {all.filter((h) => h.group === g).map((h) => {
                const i = all.indexOf(h);
                return (
                  <button key={h.id} type="button" role="option" aria-selected={i === idx} className="cmdk-item" onMouseMove={() => setIdx(i)} onClick={() => pick(h)}>
                    {h.icon}<span className="cmdk-lbl">{h.label}</span>{h.sub && <span className="sub truncate">{h.sub}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {!all.length && <div className="empty small">{busy ? "Đang tìm…" : "Không tìm thấy kết quả."}</div>}
          {busy && all.length > 0 && <div className="small muted" style={{ padding: "6px 12px" }}>Đang tìm thêm…</div>}
        </div>
        <div className="cmdk-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> chọn</span><span><kbd>Enter</kbd> mở</span><span><kbd>Esc</kbd> đóng</span></div>
      </div>
    </div>
  );
}
