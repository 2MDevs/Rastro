/* RASTRO — service worker: deixa o app instalável e abre a última versão das telas sem internet.
   Dados (API) nunca ficam guardados aqui: os pontos GPS sem internet ficam na fila do modo campo. */
const CACHE = 'rastro-shell-v2';
// Mapa gratuito (OpenFreeMap): blocos do mapa guardados no aparelho para abrir rápido nas próximas vezes
const MAP_CACHE = 'rastro-mapa-v1';
const MAP_MAX_ENTRIES = 4000;
const KEEP = [CACHE, MAP_CACHE];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/favicon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'tiles.openfreemap.org') { event.respondWith(mapResource(req, url)); return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/basemap/')) return;

  // Telas: sempre tenta a versão nova; sem internet, abre a última guardada
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('/', copy));
        return res;
      }).catch(() => caches.match('/'))
    );
    return;
  }
  // Arquivos com hash no nome (/assets) e fontes do mapa: guarda depois do primeiro uso
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/map-assets/') || url.pathname.startsWith('/brand/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
});

/* Mapa: os blocos têm a versão no endereço (não mudam), então vêm direto do aparelho quando já foram baixados.
   O estilo e o índice do mapa abrem na hora a partir do aparelho e são atualizados em segundo plano. */
let mapWrites = 0;
async function mapResource(req, url) {
  const cache = await caches.open(MAP_CACHE);
  const hit = await cache.match(req);
  const isVersioned = /\.(pbf|png|json)$/.test(url.pathname) && !url.pathname.startsWith('/styles/') && url.pathname.split('/').length > 3;
  const network = fetch(req).then((res) => {
    if (res.ok) {
      cache.put(req, res.clone());
      if (++mapWrites % 200 === 0) trimMapCache(cache);
    }
    return res;
  });
  if (hit) {
    if (!isVersioned) network.catch(() => {}); // atualiza estilo/índice em segundo plano
    return hit;
  }
  return network;
}
async function trimMapCache(cache) {
  try {
    const keys = await cache.keys();
    const extra = keys.length - MAP_MAX_ENTRIES;
    for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
  } catch (e) { /* ok */ }
}
