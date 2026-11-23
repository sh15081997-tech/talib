const CACHE = 'talib-202611232057';
const FILES = ['./', './index.html', './manifest.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const isPage = req => req.mode === 'navigate' || /\/(index\.html)?$/.test(new URL(req.url).pathname);
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (isPage(req)) {
    const net = fetch(req.url, { cache: 'no-store', credentials: 'same-origin' }).then(r => {
      if (r && r.ok) { const copy = r.clone(); return { r, done: caches.open(CACHE).then(c => c.put('./index.html', copy)) }; }
      return { r, done: null };
    });
    e.waitUntil(net.then(x => x.done).catch(() => {}));
    e.respondWith(Promise.race([net.then(x => x.r), new Promise(res => setTimeout(res, 4000, null))])
      .catch(() => null)
      .then(r => r || caches.match('./index.html').then(hit => hit || net.then(x => x.r))));
    return;
  }
  e.respondWith(caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true }).then(hit => hit ||
    fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); return r; }))));
});