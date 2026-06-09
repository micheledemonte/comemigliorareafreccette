// ═══════════════════════════════════════════════════════════════
// API — /api/send-notifications.js
// Vercel Cron Function — gira ogni 30 minuti
// Legge gli appuntamenti da Firebase, confronta con l'ora corrente,
// invia notifiche push agli admin assegnati
// ═══════════════════════════════════════════════════════════════

import webpush from 'web-push';

// Configura VAPID (chiavi impostate su Vercel → Environment Variables)
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Finestre di notifica in millisecondi prima dell'appuntamento
const NOTIFY_WINDOWS = [
  { ms: 24 * 60 * 60 * 1000, label: 'tra 24 ore'       },
  { ms: 12 * 60 * 60 * 1000, label: 'tra 12 ore'       },
  { ms:       60 * 60 * 1000, label: 'tra 1 ora'        },
  { ms:       30 * 60 * 1000, label: 'tra 30 minuti'    },
];

// Tolleranza: la cron gira ogni 30 min, notifichiamo se siamo entro ±14 min dalla finestra
const TOLERANCE_MS = 14 * 60 * 1000;

export default async function handler(req, res) {
  // Sicurezza: Vercel invia un header Authorization per le cron
  // Per chiamate manuali (test), accetta anche una chiave ?secret=...
  const cronSecret   = req.headers['authorization'];
  const querySecret  = req.query?.secret;
  const expectedAuth = `Bearer ${process.env.CRON_SECRET || 'cmaf-cron'}`;

  if (cronSecret !== expectedAuth && querySecret !== (process.env.CRON_SECRET || 'cmaf-cron')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const firebaseUrl    = process.env.FIREBASE_DATABASE_URL;
  const firebaseSecret = process.env.FIREBASE_DATABASE_SECRET;

  if (!firebaseUrl || !firebaseSecret) {
    return res.status(500).json({ error: 'Firebase not configured' });
  }

  const now = Date.now();
  const results = { checked: 0, sent: 0, errors: [] };

  try {
    // 1. Leggi tutte le userData
    const userDataResp = await fetch(
      `${firebaseUrl}/userData.json?auth=${firebaseSecret}`
    );
    if (!userDataResp.ok) throw new Error('Cannot read userData');
    const userData = await userDataResp.json();
    if (!userData) return res.status(200).json({ ok: true, ...results });

    // 2. Leggi tutte le push subscriptions degli admin
    const subsResp = await fetch(
      `${firebaseUrl}/pushSubscriptions.json?auth=${firebaseSecret}`
    );
    const subscriptions = subsResp.ok ? await subsResp.json() : {};

    // 3. Leggi log notifiche già inviate (evita duplicati)
    const sentLogResp = await fetch(
      `${firebaseUrl}/notifSentLog.json?auth=${firebaseSecret}`
    );
    const sentLog = sentLogResp.ok ? await sentLogResp.json() : {};

    // 4. Scansiona tutti gli utenti e i loro percorsi lezione
    for (const [uid, data] of Object.entries(userData)) {
      if (!data?.__percorso) continue;
      const percorso = data.__percorso;
      if (!percorso.lezioni) continue;

      const userName = `${data.firstName || ''} ${data.lastName || ''}`.trim() || uid;

      percorso.lezioni.forEach((lezione, idx) => {
        if (!lezione.dt) return;
        if (!lezione.adminRef) return; // nessun admin assegnato → nessuna notifica

        const lessonMs = new Date(lezione.dt).getTime();
        if (isNaN(lessonMs)) return;
        if (lessonMs < now) return; // lezione già passata

        results.checked++;

        const adminRef = lezione.adminRef;
        const sub      = subscriptions?.[adminRef];
        if (!sub?.subscription) return; // admin non ha subscription push

        // Controlla ogni finestra di notifica
        NOTIFY_WINDOWS.forEach(async ({ ms, label }) => {
          const fireAt   = lessonMs - ms;
          const diff     = Math.abs(now - fireAt);

          if (diff > TOLERANCE_MS) return; // non è il momento giusto

          // Chiave univoca per questo invio — evita duplicati
          const logKey = `${uid}_${idx}_${ms}`;
          if (sentLog?.[logKey]) return; // già inviato

          const noteStr  = lezione.note ? ` · ${lezione.note}` : '';
          const timeStr  = new Date(lezione.dt).toLocaleTimeString('it-IT', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome'
          });
          const dateStr  = new Date(lezione.dt).toLocaleDateString('it-IT', {
            weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Rome'
          });

          const payload = JSON.stringify({
            title: `📅 Lezione ${label}`,
            body:  `${userName} — Lezione ${idx + 1} | ${dateStr} alle ${timeStr}${noteStr}`,
            tag:   logKey,
            icon:  '/icon-192.png',
            data:  { uid, idx, dt: lezione.dt },
          });

          try {
            await webpush.sendNotification(sub.subscription, payload);
            results.sent++;

            // Salva nel log per evitare re-invio
            await fetch(
              `${firebaseUrl}/notifSentLog/${logKey}.json?auth=${firebaseSecret}`,
              {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ sentAt: new Date().toISOString() }),
              }
            );
          } catch (pushErr) {
            results.errors.push({ logKey, error: pushErr.message });
            // Se la subscription è scaduta (410 Gone), rimuovila
            if (pushErr.statusCode === 410) {
              await fetch(
                `${firebaseUrl}/pushSubscriptions/${adminRef}.json?auth=${firebaseSecret}`,
                { method: 'DELETE' }
              );
            }
          }
        });
      });
    }

    return res.status(200).json({ ok: true, now: new Date().toISOString(), ...results });

  } catch (err) {
    console.error('send-notifications error:', err);
    return res.status(500).json({ error: err.message, ...results });
  }
}
