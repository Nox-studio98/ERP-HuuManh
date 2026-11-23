/* Service worker cửa hàng Hữu Mạnh.
 * - App shell (index.html + file băm trong /assets/): cache khi dùng lần đầu, mở lại được khi mất mạng.
 * - Ảnh /img/: stale-while-revalidate (giới hạn số ảnh).
 * - KHÔNG BAO GIỜ cache /api/* (giá, tồn, đơn hàng luôn lấy mới từ server).
 * - Web Push: hiển thị thông báo trạng thái đơn; bấm vào mở đúng trang theo dõi. */
const VERSION = "v1";
const SHELL = `hm-shop-shell-${VERSION}`;
const IMG = `hm-shop-img-${VERSION}`;
const MAX_IMG = 150;
const PRECACHE = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith("hm-shop-") && k !== SHELL && k !== IMG).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/sitemap.xml" || url.pathname === "/robots.txt") return; // không cache

  if (url.pathname.startsWith("/img/")) {
    e.respondWith(
      caches.open(IMG).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req).then((r) => {
          if (r.ok) { cache.put(req, r.clone()).then(() => trim(cache, MAX_IMG)); }
          return r;
        }).catch(() => hit);
        return hit || net;
      }),
    );
    return;
  }

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put("/", copy)); }
        return r;
      }).catch(() => caches.match("/").then((r) => r || new Response("Bạn đang ngoại tuyến. Vui lòng kết nối mạng và thử lại.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }))),
    );
    return;
  }

  // file tĩnh (băm tên trong /assets/, icon, manifest): cache trước, cập nhật ngầm
  e.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req).then((r) => { if (r.ok) cache.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }),
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Hữu Mạnh", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "Hữu Mạnh", {
      body: d.body || "", tag: d.tag || undefined, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const raw = (e.notification.data && e.notification.data.url) || "/";
  const url = new URL(raw, location.origin);
  const target = url.origin === location.origin ? url.pathname + url.search : "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if (c.url.startsWith(location.origin) && "focus" in c) { c.navigate(target); return c.focus(); }
      return self.clients.openWindow(target);
    }),
  );
});
