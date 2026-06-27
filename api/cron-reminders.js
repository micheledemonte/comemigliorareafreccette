// Promemoria allenamenti (FCM) — Fase 3. Invocato dalla GitHub Action ogni ~5 min.
// Per ogni lezione futura con data (db/userData/{uid}/__percorso.lezioni[].dt) manda un
// push all'utente alle finestre [24h,12h,2h,1h,30m,15m] prima. Ogni finestra parte UNA sola
// volta: stato anti-doppione su db/reminderSent/{icsId}/{minuti} via transaction.
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

const WINDOWS = [1440, 720, 120, 60, 30, 15]; // minuti prima della lezione
const GRACE_MIN = 20;                          // tolleranza dopo il trigger (jitter del cron)
const LABEL = {
  1440: 'Tra 24 ore', 720: 'Tra 12 ore', 120: 'Tra 2 ore',
  60: 'Tra 1 ora', 30: 'Tra 30 minuti', 15: 'Tra 15 minuti',
};

function sanitizeTokenKey(t) { return t.replace(/[.#$\[\]\/]/g, '_'); }
function toUtcIso(dt) { return dt.length === 16 ? dt + ':00Z' : (dt.length === 19 ? dt + 'Z' : dt); }
function fmtDateTime(dt) {
  const d = new Date(toUtcIso(dt));
  return {
    data: d.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }),
    ora:  d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
  };
}

async function tokensForUid(uid) {
  const snap = await db.ref('db/fcmTokens/' + uid).once('value');
  const val = snap.val() || {};
  return Object.keys(val).map(k => (val[k] && val[k].token) || null).filter(Boolean);
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
  // Protezione opzionale: se CRON_SECRET è impostato su Vercel, richiedi la chiave.
  if (process.env.CRON_SECRET) {
    const key = (req.query && req.query.key) || (req.headers.authorization || '').replace('Bearer ', '');
    if (key !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const now = Date.now();
    const udSnap = await db.ref('db/userData').once('value');
    const ud = udSnap.val() || {};
    let checked = 0, sent = 0;
    const ops = [];

    for (const uid of Object.keys(ud)) {
      const perc = ud[uid] && ud[uid].__percorso;
      if (!perc || !Array.isArray(perc.lezioni)) continue;
      for (const lez of perc.lezioni) {
        if (!lez || !lez.dt || !lez.icsId) continue;
        const lessonMs = new Date(toUtcIso(lez.dt)).getTime();
        if (isNaN(lessonMs) || lessonMs <= now) continue; // lezione passata o invalida
        checked++;
        for (const W of WINDOWS) {
          const sinceTrigger = (now - (lessonMs - W * 60000)) / 60000; // minuti dal trigger
          if (sinceTrigger < 0 || sinceTrigger >= GRACE_MIN) continue;  // non scattata o ormai stale
          ops.push((async () => {
            // anti-doppione: scrive solo se la finestra non è già stata inviata
            const ref = db.ref('db/reminderSent/' + lez.icsId + '/' + W);
            const tx = await ref.transaction(cur => (cur === null ? now : undefined));
            if (!tx.committed) return; // già inviata da un altro run
            const { data, ora } = fmtDateTime(lez.dt);
            const n = await sendToUid(uid, {
              title: LABEL[W] || 'Promemoria allenamento',
              body: 'Allenamento ' + data + ' ore ' + ora,
              url: '/',
              tag: 'reminder_' + lez.icsId + '_' + W,
            });
            sent += n;
          })());
        }
      }
    }

    await Promise.all(ops);
    return res.status(200).json({ ok: true, now, checked, sent });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
