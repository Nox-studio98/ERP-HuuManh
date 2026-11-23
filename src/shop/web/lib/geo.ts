import { createElement, useEffect, useState } from "react";
/**
 * Quận/huyện cho ô chọn khu vực giao: lấy từ GET /api/delivery/zones (khu vực cửa hàng cấu hình trong ERP).
 * DISTRICTS chỉ là dự phòng khi API lỗi; server vẫn quyết định vùng có hỗ trợ hay không (zone_unsupported).
 */
export const PROVINCE = "TP. Hồ Chí Minh";
export const DISTRICTS = [
  "Quận 1", "Quận 3", "Quận 4", "Quận 5", "Quận 6", "Quận 7", "Quận 8", "Quận 10", "Quận 11", "Quận 12",
  "Bình Thạnh", "Gò Vấp", "Phú Nhuận", "Tân Bình", "Tân Phú", "Bình Tân", "Thủ Đức", "Quận 2", "Quận 9",
  "Bình Chánh", "Hóc Môn", "Nhà Bè", "Củ Chi", "Cần Giờ",
];


let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;

function loadDistricts(): Promise<string[]> {
  if (cache) return Promise.resolve(cache);
  inflight ??= fetch("/api/delivery/zones", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((raw: unknown) => {
      const d = raw as { zones?: { districts?: string[] }[] };
      const list = [...new Set((d.zones ?? []).flatMap((z) => z.districts ?? []))];
      cache = list.length ? list : DISTRICTS;
      return cache;
    })
    .catch(() => DISTRICTS)
    .finally(() => { inflight = null; });
  return inflight;
}

export function useDistricts(): string[] {
  const [list, setList] = useState<string[]>(cache ?? DISTRICTS);
  useEffect(() => { let live = true; loadDistricts().then((l) => live && setList(l)); return () => { live = false; }; }, []);
  return list;
}

/** Các <option> quận/huyện — dùng trong <select>. */
export function DistrictOptions() {
  const list = useDistricts();
  return createElement("optgroup", { label: "Khu vực giao hàng" }, ...list.map((d) => createElement("option", { key: d, value: d }, d)));
}
