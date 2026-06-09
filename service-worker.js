/**
 * service-worker.js — Come Migliorare a Freccette
 * Gestisce le notifiche push Web Push / FCM in background.
 * Da posizionare nella ROOT del sito (stessa cartella di index.html).
 *
 * Compatibile con Firebase Cloud Messaging (FCM) tramite il formato
 * standard Web Push con payload JSON.
 */

// ── Versione cache (aggiorna per invalidare) ─────────────────────────────────
const SW_VERSION = 'cmaf-sw-v1';

// ── Install / Activate (minimal — solo push, no cache offline) ───────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// ── Push handler ─────────────────────────────────────────────────────────────
self.addEventListener('push', function (event) {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { notification: { title: '📅 Lezione', body: event.data ? event.data.text() : '' } };
  }

  // FCM invia il payload in .notification oppure .data
  const notif = payload.notification || {};
  const data  = payload.data         || {};

  const title   = notif.title || data.title || '📅 Prossima lezione';
  const body    = notif.body  || data.body  || '';
  const icon    = notif.icon  || '/icon-192.png';
  const badge   = '/icon-192.png';
  const tag     = data.lessonDt ? `lesson-${data.studentUid}-${data.lessonIdx}` : 'cmaf-notif';
  const url     = 'https://comemigliorareafreccette.web.app';

  const options = {
    body,
    icon,
    badge,
    tag,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
    data: { url, ...data },
    actions: [
      { action: 'open',    title: '📅 Apri app' },
      { action: 'dismiss', title: '✕ Chiudi'    },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : 'https://comemigliorareafreccette.web.app';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Se l'app è già aperta, portala in primo piano
        for (const client of clients) {
          if (client.url.includes('comemigliorareafreccette') && 'focus' in client) {
            return client.focus();
          }
        }
        // Altrimenti apri una nuova finestra
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
  );
});

// ── Background sync (opzionale, future use) ──────────────────────────────────
self.addEventListener('sync', function (event) {
  // Placeholder per future funzionalità offline
});
