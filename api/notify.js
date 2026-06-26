// Invio notifiche push (FCM) — Fase 2.
// Riusa le stesse credenziali service account di api/delete-user.js (env Vercel
// FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY). Destinatari risolti SEMPRE lato server.
// Messaggi DATA-only → il service worker (firebase-messaging-sw.js) decide display/click.
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    databaseURL: 'https://comemigliorareafreccette-default-rtdb.europe-west1.firebasedatabase.app',
  });
}

const db = admin.database();

function sanitizeTokenKey(t) { return t.replace(/[.#$\[\]\/]/g, '_'); }

async function tokensForUid(uid) {
  const snap = await db.ref('db/fcmTokens/' + uid).once('value');
  const val = snap.val() || {};
  return Object.keys(val).map(k => (val[k] && val[k].token) || null).filter(Boolean);
}

async function allUsers() {
  const snap = await db.ref('db/users').once('value');
  const v = snap.val() || [];
  return Array.isArray(v) ? v.filter(Boolean) : Object.values(v).filter(Boolean);
}

async function pruneToken(uid, token) {
  try { await db.ref('db/fcmTokens/' + uid + '/' + sanitizeTokenKey(token)).remove(); } catch (e) {}
}

async function sendToUid(uid, data) {
  const tokens = await tokensForUid(uid);
  if (!tokens.length) return 0;
  const resp = await admin.messaging().sendEachForMulticast({ tokens, data });
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument') {
        pruneToken(uid, tokens[i]);
      }
    }
  });
  return resp.successCount;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { idToken, type } = body;
    if (!idToken || !type) return res.status(400).json({ error: 'Missing params' });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;
    const users = await allUsers();
    const caller = users.find(u => u.id === callerUid || u.firebaseUid === callerUid);

    if (type === 'new_request') {
      // Utente loggato invia una richiesta → notifica TUTTI gli admin (tranne se stesso).
      const admins = users.filter(u => u.role === 'admin' && u.id);
      const senderName = String(body.senderName || 'Un utente').slice(0, 60);
      const preview = String(body.preview || '').slice(0, 140);
      const data = {
        title: 'Nuova richiesta da ' + senderName,
        body: preview || 'Hai ricevuto una nuova richiesta.',
        url: '/',
        tag: 'req_' + callerUid,
      };
      let sent = 0;
      for (const a of admins) { if (a.id !== callerUid) sent += await sendToUid(a.id, data); }
      return res.status(200).json({ success: true, sent });
    }

    if (type === 'appointment') {
      // Solo un admin può notificare un appuntamento a un utente.
      if (!caller || caller.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
      const targetUid = body.targetUid;
      if (!targetUid) return res.status(400).json({ error: 'Missing targetUid' });
      const action = body.action === 'moved' ? 'spostato' : 'fissato';
      let when = '';
      try {
        if (body.dt) {
          when = new Date(body.dt).toLocaleString('it-IT', {
            weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
          });
        }
      } catch (e) {}
      const data = {
        title: 'Allenamento ' + action,
        body: when ? ('Il tuo allenamento è stato ' + action + ' per ' + when) : ('Il tuo allenamento è stato ' + action + '.'),
        url: '/',
        tag: 'appt_' + targetUid,
      };
      const sent = await sendToUid(targetUid, data);
      return res.status(200).json({ success: true, sent });
    }

    return res.status(400).json({ error: 'Unknown type' });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};
