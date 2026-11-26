/* Bộ phát hiện máy quét mã vạch USB/Bluetooth (giả lập bàn phím) — hàm thuần, không đụng DOM.
   Một lần quét = chuỗi ≥ minLen ký tự in được, mỗi phím cách phím trước < maxGapMs, kết thúc bằng Enter.
   Người gõ tay (nhịp chậm) không bao giờ bị nhận nhầm. */
export type KeyEv = { key: string; t: number };
export type Scan = { code: string; /** chỉ số sự kiện đầu/cuối (Enter) trong dãy đưa vào, tính từ đầu luồng */ start: number; end: number };
export type ScanOpts = { minLen?: number; maxGapMs?: number };
export const SCAN_MIN_LEN = 4;
export const SCAN_MAX_GAP_MS = 35;

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "NumLock", "ScrollLock"]);

/** Dạng luồng: gọi push() cho từng keydown, nhận Scan khi gặp Enter kết thúc một lần quét. */
export function createScanDetector(opts: ScanOpts = {}) {
  const minLen = opts.minLen ?? SCAN_MIN_LEN, maxGap = opts.maxGapMs ?? SCAN_MAX_GAP_MS;
  let buf = "", lastT = 0, startIdx = 0, i = -1;
  const reset = () => { buf = ""; };
  return {
    push(ev: KeyEv): Scan | null {
      i++;
      const { key, t } = ev;
      if (MODIFIERS.has(key)) return null; // Shift/CapsLock… không làm đứt nhịp
      if (key === "Enter") {
        const ok = buf.length >= minLen && t - lastT < maxGap;
        const out = ok ? { code: buf, start: startIdx, end: i } : null;
        reset();
        return out;
      }
      if (key.length !== 1) { reset(); return null; } // phím điều khiển khác (Tab, mũi tên…) → bỏ chuỗi đang gom
      if (buf && t - lastT >= maxGap) reset(); // chậm → là người gõ, bắt đầu lại
      if (!buf) startIdx = i;
      buf += key;
      lastT = t;
      return null;
    },
    reset,
  };
}

/** Dạng hàm thuần: dãy sự kiện → các lần quét theo thứ tự. */
export function detectScans(events: KeyEv[], opts: ScanOpts = {}): Scan[] {
  const d = createScanDetector(opts);
  const out: Scan[] = [];
  for (const e of events) { const s = d.push(e); if (s) out.push(s); }
  return out;
}

export type ScannerSettings = { on: boolean; mode: "add" | "ask" };
const KEY = "hm_pos_scanner";
export function loadScannerSettings(): ScannerSettings {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return { on: j?.on === true, mode: j?.mode === "ask" ? "ask" : "add" };
  } catch { return { on: false, mode: "add" }; }
}
export function saveScannerSettings(s: ScannerSettings) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* chế độ riêng tư */ } }
