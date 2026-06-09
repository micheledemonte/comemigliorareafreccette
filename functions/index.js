/**
 * Firebase Cloud Functions — Push Notifications per lezioni
 * Progetto: comemigliorareafreccette
 *
 * Funzionamento:
 * - Ogni 15 minuti scansiona tutti i percorsi utente su Firebase RTDB
 * - Per ogni lezione con appuntamento futuro e admin assegnato,
 *   invia notifiche push a 24h, 12h, 1h e 30min prima
 * - Salva in RTDB le notifiche già inviate per evitare duplicati
 *   (chiave: notifications_sent/{adminUid}/{uid}_{idx}_{offsetMs})
 */

const { onSchedule }      = require('firebase-functions/v2/scheduler');
const { onRequest }        = require('firebase-functions/v2/https');
const { initializeApp }    = require('firebase-admin/app');
const { getDatabase }      = require('firebase-admin/database');
const { getMessaging }     = require('firebase-admin/messaging');

initializeApp();

// ── Costanti ────────────────────────────────────────────────────────────────
const PROJECT_ID = 'comemigliorareafreccette';
const DB_URL     = 'https://comemigliorareafreccette-default-rtdb.europe-west1.firebasedatabase.app';

// Offset (millisecondi prima della lezione) → label
const OFFSETS = [
  { ms: 24 * 60 * 60 * 1000, label: 'tra 24 ore' },
  { ms: 12 * 60 * 60 * 1000, label: 'tra 12 ore' },
  {      60 * 60 * 1000,     label: 'tra 1 ora'   },
  {      30 * 60 * 1000,     label: 'tra 30 minuti'},
];

// ── Helper: leggi tutti gli utenti da RTDB ──────────────────────────────────
async function getAllUserData() {
  const db = getDatabase();
  const snap = await db.ref('userData').once('value');
  return snap.val() || {};
}

// ── Helper: invia notifica FCM a un token ───────────────────────────────────
async function sendPushNotification(token, title, body, data = {}) {
  const messaging = getMessaging();
  try {
    await messaging.send({
      token,
      notification: { title, body },
      data,
      webpush: {
        notification: {
          title,
          body,
          icon:  '/icon-192.png',
          badge: '/icon-192.png',
          requireInteraction: true,
          vibrate: [200, 100, 200],
        },
        fcmOptions: { link: 'https://comemigliorareafreccette.web.app' },
      },
    });
    return true;
  } catch (err) {
    console.error('FCM send error:', err.message);
    return false;
  }
}

// ── Funzione principale schedulata ─────────────────────────────────────────
exports.checkLessonReminders = onSchedule(
  {
    schedule:       'every 15 minutes',
    timeZone:       'Europe/Rome',
    region:         'europe-west1',
    memory:         '256MiB',
    timeoutSeconds: 60,
  },
  async (event) => {
    const db      = getDatabase();
    const now     = Date.now();
    const allData = await getAllUserData();

    // Raccoglie amminitratori con FCM token registrato
    const admins = {};
    for (const [uid, data] of Object.entries(allData)) {
      if (data.role === 'admin' && data.__fcmToken) {
        admins[uid] = { ...data, uid };
      }
    }

    if (Object.keys(admins).length === 0) {
      console.log('Nessun admin con FCM token registrato.');
      return;
    }

    // Raccoglie tutti gli appuntamenti
    for (const [studentUid, studentData] of Object.entries(allData)) {
      const percorso = studentData.__percorso;
      if (!percorso || !percorso.lezioni) continue;

      const studentName = `${studentData.firstName || ''} ${studentData.lastName || ''}`.trim() || studentUid;

      for (let idx = 0; idx < percorso.lezioni.length; idx++) {
        const lezione = percorso.lezioni[idx];
        if (!lezione.dt || !lezione.adminRef) continue;

        const adminUid = lezione.adminRef;
        const admin    = admins[adminUid];
        if (!admin) continue; // admin non ha token FCM

        const lessonMs = new Date(lezione.dt).getTime();
        if (isNaN(lessonMs)) continue;
        if (lessonMs < now) continue; // lezione già passata

        const noteStr = lezione.note ? ` · ${lezione.note}` : '';
        const lessonLabel = `Lezione ${idx + 1} — ${studentName}${noteStr}`;

        for (const { ms, label } of OFFSETS) {
          const fireAt = lessonMs - ms;
          // Notifica da inviare se siamo entro la finestra di 15 min dopo il momento target
          const windowMs = 15 * 60 * 1000;
          if (now < fireAt || now > fireAt + windowMs) continue;

          // Controlla se già inviata
          const sentKey   = `${studentUid}_${idx}_${ms}`;
          const sentPath  = `notifications_sent/${adminUid}/${sentKey.replace(/[.#$/[\]]/g, '_')}`;
          const sentSnap  = await db.ref(sentPath).once('value');
          if (sentSnap.val()) continue; // già inviata

          // Invia notifica
          const title = `📅 ${lessonLabel}`;
          const body  = `La lezione è ${label}`;
          console.log(`Invio notifica a admin ${adminUid}: ${title} — ${body}`);

          const ok = await sendPushNotification(admin.__fcmToken, title, body, {
            studentUid,
            lessonIdx: String(idx),
            lessonDt:  lezione.dt,
          });

          if (ok) {
            // Segna come inviata (TTL: mantieni 48h di storico)
            await db.ref(sentPath).set({
              sentAt:    new Date().toISOString(),
              lessonDt:  lezione.dt,
              adminUid,
              studentUid,
              lessonIdx: idx,
            });
          }
        }
      }
    }

    // Pulizia: rimuovi notifiche inviate più di 48h fa
    const cutoff = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const sentAllSnap = await db.ref('notifications_sent').once('value');
    const sentAll = sentAllSnap.val() || {};
    const deletes = [];
    for (const [adminUid, adminSent] of Object.entries(sentAll)) {
      for (const [key, val] of Object.entries(adminSent)) {
        if (val.sentAt && val.sentAt < cutoff) {
          deletes.push(db.ref(`notifications_sent/${adminUid}/${key}`).remove());
        }
      }
    }
    if (deletes.length) await Promise.all(deletes);

    console.log(`Ciclo completato. Notifiche inviate/verificate.`);
  }
);

// ── Endpoint HTTP per test manuale ──────────────────────────────────────────
exports.testPushNotification = onRequest(
  { region: 'europe-west1', cors: true },
  async (req, res) => {
    // Solo POST con token esplicito per sicurezza
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
    const { adminSecret, token, title, body } = req.body;
    // Controlla secret
    const db         = getDatabase();
    const secretSnap = await db.ref('__appConfig/adminSecret').once('value');
    if (!secretSnap.val() || secretSnap.val() !== adminSecret) {
      res.status(403).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    const ok = await sendPushNotification(token, title || 'Test notifica', body || 'Funziona!');
    res.json({ ok });
  }
);
