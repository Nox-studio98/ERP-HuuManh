import { useState } from "react";
import { get, post } from "../../api";
import { Badge, Banner, Button, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { ROLES } from "../../format";

/**
 * EC-39: màn chuyển việc đang làm cho người khác (khi nhân viên nghỉ việc / khoá tài khoản).
 * Mỗi nhóm việc chọn: để nguyên | chuyển cho một người | huỷ (chỉ chứng từ nháp). Thực hiện trong một giao dịch.
 */
export default function Handover({ userId, employeeId, onClose, onDone }: { userId?: number | null; employeeId?: number | null; onClose: () => void; onDone: () => void }) {
  const q = new URLSearchParams();
  if (userId) q.set("userId", String(userId));
  if (employeeId) q.set("employeeId", String(employeeId));
  const d = useAsync(() => get(`/handover?${q.toString()}`), [userId, employeeId]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const data = d.data;
  const groups: any[] = data?.groups ?? [];
  const chosen = groups.filter((g) => pick[g.key]);
  const setAll = (v: string) => setPick(Object.fromEntries(groups.filter((g) => g.kind === "user").map((g) => [g.key, v])));
  const submit = async () => {
    setBusy(true);
    try {
      const actions = chosen.map((g) => {
        const v = pick[g.key];
        if (v === "cancel") return { group: g.key, action: "cancel" };
        return g.kind === "employee" ? { group: g.key, action: "reassign", toEmployeeId: Number(v) } : { group: g.key, action: "reassign", toUserId: Number(v) };
      });
      await post("/handover", { userId: userId ?? undefined, employeeId: employeeId ?? undefined, reason: reason.trim(), actions });
      toast("Đã chuyển việc", "ok");
      onDone();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open portal wide onClose={onClose} title={`Chuyển việc đang làm${data?.name ? ` của ${data.name}` : ""}`}
      footer={<div className="row"><Button variant="ghost" onClick={onClose}>Đóng</Button><Button className="grow" loading={busy} disabled={!chosen.length || !reason.trim()} onClick={submit} data-testid="handover-submit">Chuyển {chosen.length ? `${chosen.length} nhóm việc` : "việc"}</Button></div>}>
      <div className="stack" data-testid="handover">
        {d.loading && <Spinner />}
        {data && (
          <>
            {data.openShifts > 0 && <Banner tone="danger">Còn <b>{data.openShifts}</b> ca bán hàng đang mở. Ca POS không chuyển được — hãy chốt ca (quản lý đóng thay) trước khi cho nghỉ việc / khoá.</Banner>}
            {!groups.length ? <Banner tone="info">Không còn việc nào cần chuyển. Có thể cho nghỉ việc / khoá tài khoản.</Banner> : (
              <>
                <Banner tone="info">Chọn người nhận cho từng nhóm (hoặc huỷ chứng từ nháp). Chứng từ đã ghi sổ và kỳ đã khoá không bị thay đổi.</Banner>
                {groups.some((g) => g.kind === "user") && (
                  <Select label="Chuyển tất cả (trừ ca) cho" value="" onChange={(e) => e.target.value && setAll(e.target.value)} data-testid="handover-all">
                    <option value="">— Chọn người nhận chung —</option>
                    {data.recipients.users.map((u: any) => <option key={u.id} value={u.id}>{u.fullName} ({ROLES[u.role] ?? u.role})</option>)}
                  </Select>
                )}
                {groups.map((g) => (
                  <div key={g.key} className="card flat" data-testid={`handover-${g.key}`}>
                    <div className="row between wrap">
                      <b>{g.label} <Badge>{g.count}</Badge></b>
                      <Button size="sm" variant="ghost" onClick={() => setOpen({ ...open, [g.key]: !open[g.key] })}>{open[g.key] ? "Ẩn" : "Xem"}</Button>
                    </div>
                    {open[g.key] && <div className="small muted" style={{ margin: "6px 0" }}>{g.items.map((i: any) => i.label).join(" · ")}{g.truncated ? " …" : ""}</div>}
                    <Select label="Xử lý" value={pick[g.key] ?? ""} onChange={(e) => setPick({ ...pick, [g.key]: e.target.value })}>
                      <option value="">Để nguyên (chưa chuyển)</option>
                      {g.cancel && <option value="cancel">{g.cancel}</option>}
                      {g.kind === "employee"
                        ? data.recipients.employees.map((x: any) => <option key={x.id} value={x.id}>Chuyển cho {x.fullName}</option>)
                        : data.recipients.users.map((x: any) => <option key={x.id} value={x.id}>Chuyển cho {x.fullName} ({ROLES[x.role] ?? x.role})</option>)}
                    </Select>
                  </div>
                ))}
                <TextArea label="Lý do bàn giao (ghi vào nhật ký)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
