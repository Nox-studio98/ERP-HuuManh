import { sysAuditStmt, type SysAuditEntry } from "../../../worker/services/sysaudit";
import { clientIp, type SCtx } from "./util";

export const nccActor = (accountId: number | string) => `supplier_account:${accountId}`;

/** Audit mọi thao tác của NCC trên cổng: user_id = NULL, actor = supplier_account:<id>, ip thật. Gộp vào cùng batch với thay đổi. */
export const nccAuditStmt = (c: SCtx, accountId: number, e: SysAuditEntry) =>
  sysAuditStmt(c.env.DB, { ...e, actor: nccActor(accountId), ip: clientIp(c) });
