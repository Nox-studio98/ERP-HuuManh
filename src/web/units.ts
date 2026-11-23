import { get, items } from "./api";
import { useAsync } from "./components/ui";
import type { UnitInfo } from "./format";

/** Bản đồ id → hàng hoá (đơn vị, hệ số quy đổi) để hiển thị số lượng theo đúng đơn vị. */
export const loadUnitMap = () =>
  get("/products", { limit: 200 }, { silent: true }).then((r) => new Map<number, UnitInfo & { name: string }>(items<any>(r).map((p) => [p.id, p])));
export const useUnitMap = () => useAsync(() => loadUnitMap().catch(() => new Map<number, UnitInfo & { name: string }>()), []).data;
