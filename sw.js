// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER — Come Migliorare a Freccette
// Gestisce notifiche push anche con l'app chiusa
// ═══════════════════════════════════════════════════════════════

const SW_VERSION = 'cmaf-sw-v1';

// ── Install & Activate ──────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// ── Push received ───────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: '📅 Freccette', body: event.data.text() };
  }

  const title   = payload.title || '📅 Lezione imminente';
  const options = {
    body:    payload.body  || '',
    icon:    payload.icon  || '/icon-192.png',
    badge:   payload.badge || '/icon-192.png',
    tag:     payload.tag   || 'cmaf-lesson',
    data:    payload.data  || {},
    requireInteraction: true,           // rimane visibile finché non viene toccata
    vibrate: [200, 100, 200],
    actions: [
      { action: 'open',    title: 'Apri app' },
      { action: 'dismiss', title: 'Ignora'   },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification click ──────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  // Apri (o porta in primo piano) la finestra dell'app
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        for (const client of clients) {
          if ('focus' in client) {
            client.focus();
            return;
          }
        }
        // Nessuna finestra aperta: apri una nuova
        if (self.clients.openWindow) {
          return self.clients.openWindow('/');
        }
      })
  );
});
