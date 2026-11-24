const prefijo = 'acme-app-';
const nombre = prefijo + 'v1';
self.addEventListener('install', (evento) => {
  evento.waitUntil((async () => {
    const html = await fetch('/', { cache: 'reload' });
    if (!html.ok) throw new Error('No se pudo instalar la aplicación');
    const recursos = [...(await html.clone().text()).matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
      .map((coincidencia) => coincidencia[1]);
    const cache = await caches.open(nombre);
    await cache.addAll([...recursos, '/manifest.webmanifest', '/acme-192.png', '/acme-512.png']);
    await cache.put('/', html);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    for (const clave of await caches.keys()) {
      if (clave.startsWith(prefijo) && clave !== nombre) await caches.delete(clave);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (evento) => {
  const url = new URL(evento.request.url);
  if (evento.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (evento.request.mode === 'navigate') {
    evento.respondWith(fetch(evento.request).catch(async () => (await caches.match('/')) ?? Response.error()));
  } else {
    evento.respondWith(caches.match(evento.request).then(respuesta => respuesta ?? fetch(evento.request)));
  }
});
