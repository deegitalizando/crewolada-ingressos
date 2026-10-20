/* Service worker do painel admin: recebe as notificacoes push de venda. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  const titulo = d.titulo || 'Crewolada';
  event.waitUntil((async () => {
    await self.registration.showNotification(titulo, {
      body: d.corpo || '',
      icon: '/img/icon-192.png',   // logo da festa (colorida)
      badge: '/img/notif-badge.png', // silhueta da logo (barra de status do Android)
      tag: d.tag || 'crewolada',
      renotify: true,
      requireInteraction: false,
      vibrate: [200, 100, 200, 100, 400],
      data: { url: d.url || '/admin' },
    });
    // With the admin open on screen, the page plays the cash-register sound as well.
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    abertas.forEach((c) => c.postMessage({ type: 'venda', titulo, corpo: d.corpo || '' }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin';
  event.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abertas) {
      if ('focus' in c) { try { if (c.navigate) await c.navigate(url); } catch (e) {} return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
