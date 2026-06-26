/* Service worker FCM — notifiche push in background (app chiusa).
   Deve stare nella ROOT del sito (scope "/"). Versione SDK allineata all'app: 10.12.0. */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBsGiCLANS9P01TbVSxm5YUXj2_pJz7NfA",
  authDomain: "comemigliorareafreccette.firebaseapp.com",
  projectId: "comemigliorareafreccette",
  messagingSenderId: "738419048923",
  appId: "1:738419048923:web:15ef4587943284ab96e7fe"
});

const messaging = firebase.messaging();

// Messaggi DATA-only inviati dal backend (Fase 2): qui decidiamo titolo/corpo/click.
messaging.onBackgroundMessage(function(payload){
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || d.title || 'Centro Darts Lab';
  const opts = {
    body: n.body || d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/' },
    tag: d.tag || undefined
  };
  self.registration.showNotification(title, opts);
});

// Click sulla notifica → porta in primo piano l'app (o la apre).
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for (const c of list){ if ('focus' in c){ try{ c.navigate(url); }catch(e){} return c.focus(); } }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
