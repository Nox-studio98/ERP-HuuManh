/* Mock dev-only: chỉ dùng khi import.meta.env.DEV && localStorage.mock === '1' */
const PERMS = ["pos.sell","pos.void","pos.return","pos.shift","orders.view","orders.online.manage","orders.edit","inventory.view","inventory.write","inventory.approve","products.write","prices.view_sell","prices.view_cost","prices.write","prices.approve","finance.view","finance.write","finance.approve","finance.shift_reconcile","finance.lock_period","reports.view","customers.view_pii","users.manage","audit.view","approvals.decide"];
const P = (id: number, sku: string, name: string, price: number, w = 1, stock = 42000, unit = "kg") => ({ id, sku, name, baseUnit: unit, sellByWeight: w, barcode: "893" + String(1000000 + id), active: 1, version: 1, availableMilli: stock, price, avgCost: Math.round(price * 0.7), minStockMilli: 10000, origin: "Việt Nam", units: [{ unit, factorMilli: 1000 }, ...(w ? [{ unit: "thung", factorMilli: 10000 }] : [])] });
const products = [P(1, "TAO-FUJI", "Táo Fuji Nhật", 125000), P(2, "NHO-DEN", "Nho đen không hạt Mỹ", 189000), P(3, "CAM-SANH", "Cam sành Vĩnh Long", 38000), P(4, "XOAI-CAT", "Xoài cát Hoà Lộc", 65000), P(5, "DUA-HAU", "Dưa hấu không hạt", 22000, 1, 120000), P(6, "CHERRY", "Cherry Mỹ hộp 500g", 295000, 0, 8000, "hop"), P(7, "SAURIENG", "Sầu riêng Ri6", 98000), P(8, "THANHLONG", "Thanh long ruột đỏ", 45000)];
const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const J = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
const routes: [RegExp, (u: URL, m: string, body: any) => any][] = [
  [/\/auth\/me$/, () => ({ id: 1, username: "chu", fullName: "Anh Mạnh", role: "owner", storeId: 1, permissions: PERMS })],
  [/\/auth\/login$/, () => ({ token: "x", mustChangePassword: false })],
  [/\/shifts\/current$/, () => ({ id: 12, status: "open", openedAt: new Date(Date.now() - 4 * 3600000).toISOString(), openingCash: 500000, expectedCash: 2350000 })],
  [/\/products\/lookup$/, (u) => { const c = u.searchParams.get("code"); const p = products.find((x) => x.barcode === c || x.sku === c); return p ? { product: p } : J({ error: { code: "not_found", message: "Không tìm thấy mã" } }, 404); }],
  [/\/products$/, (u) => { const q = (u.searchParams.get("q") ?? "").toLowerCase(); return { items: products.filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)), nextCursor: null }; }],
  [/\/stock\/alerts$/, () => ({ lowStock: [{ productId: 6, name: "Cherry Mỹ hộp 500g", availableMilli: 8000, minStockMilli: 10000, baseUnit: "hop" }, { productId: 2, name: "Nho đen không hạt Mỹ", availableMilli: 4500, minStockMilli: 10000, baseUnit: "kg" }], expiringSoon: [{ lotId: 3, lotCode: "L000123", productName: "Xoài cát Hoà Lộc", expiresAt: new Date(Date.now() + 86400000).toISOString(), remainingMilli: 12500 }], expired: [{ lotId: 1, lotCode: "L000098", productName: "Dưa hấu không hạt", expiresAt: new Date(Date.now() - 86400000).toISOString(), remainingMilli: 3200 }] })],
  [/\/stock-docs$/, () => ({ items: [{ id: 1, code: "PN-20261123-0001", type: "receipt", status: "posted", createdAt: new Date().toISOString(), totalAmount: 8450000 }, { id: 2, code: "HH-20261122-0002", type: "waste", status: "pending_approval", createdAt: new Date().toISOString(), totalAmount: 320000 }] })],
  [/\/approvals$/, () => ({ items: [{ id: 5, type: "waste", status: "pending", requestedBy: 2, requestedAt: new Date().toISOString(), reason: "Hao hụt vượt 5%" }] })],
  [/\/reports\/pnl$/, (u) => { const by = u.searchParams.get("groupBy"); const rows = by === "channel" ? [["pos", 9200000, 6400000], ["online", 3100000, 2150000], ["b2b", 5400000, 4100000]] : by === "group" ? [["Trái cây nhập", 8800000, 6100000], ["Trái cây nội", 6200000, 4300000], ["Hộp quà", 2700000, 2000000]] : [6, 5, 4, 3, 2, 1, 0].map((n, i) => [day(n), 2100000 + ((i * 370000) % 1500000), 1500000 + ((i * 250000) % 1000000)]); return { rows: rows.map(([l, r, c]: any) => ({ label: l, revenue: r, cogs: c, grossProfit: r - c })), totals: { expenses: 1800000 } }; }],
  [/\/reports\/inventory$/, () => ({ rows: products.map((p) => ({ productId: p.id, productName: p.name, openingMilli: 30000, inMilli: 40000, outMilli: 25000, wasteMilli: 1500, closingMilli: p.availableMilli, value: Math.round((p.availableMilli / 1000) * p.avgCost) })) })],
  [/\/orders$/, () => ({ items: [{ id: 1, code: "HD-20261123-0001", channel: "pos", kind: "sale", status: "completed", total: 312000, createdAt: new Date().toISOString() }, { id: 2, code: "HD-20261123-0002", channel: "pos", kind: "sale", status: "completed", total: 125000, createdAt: new Date().toISOString() }] })],
  [/\/funds$/, () => ({ items: [{ id: 1, name: "Tiền mặt quầy", balance: 3450000 }, { id: 2, name: "Ngân hàng", balance: 18200000 }] })],
  [/\/price-lists$/, () => ({ items: [{ id: 1, name: "Giá bán lẻ", channel: "pos", kind: "retail", priority: 10 }] })],
  [/\/locations$/, () => ({ items: [{ id: 1, name: "Quầy bán" }, { id: 2, name: "Kho lạnh" }] })],
  [/\/suppliers$/, () => ({ items: [{ id: 1, name: "Vựa Ba Tèo" }] })],
];
export function installMock() {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (!u.pathname.startsWith("/api/")) return real(input, init);
    await new Promise((r) => setTimeout(r, 80));
    const m = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    for (const [re, h] of routes) if (re.test(u.pathname)) { const r = h(u, m, body); return r instanceof Response ? r : J(r); }
    return J(m === "GET" ? { items: [] } : { ok: true, id: 1 });
  };
}
