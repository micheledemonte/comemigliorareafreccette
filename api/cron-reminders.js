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
// L'orario lezione (datetime-local, SENZA fuso) è ora ITALIANA. Va convertito in epoch reale
// (DST-aware via Europe/Rome): interpretarlo come UTC sfasava il confronto con "now" di 1-2h,
// così le finestre 30m/15m scattavano 1-2h dopo la lezione → nessuna notifica.
function romeOffsetMinutes(utcMs) {
  const s = new Date(utcMs).toLocaleString('en-US', { timeZone: 'Europe/Rome', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  const asIfUtc = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  return Math.round((asIfUtc - utcMs) / 60000);
}
function lessonEpoch(dt) {
  const m = String(dt).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const naiveUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return naiveUtc - romeOffsetMinutes(naiveUtc) * 60000;
}
function fmtDateTime(dt) {
  const d = new Date(lessonEpoch(dt));
  return {
    data: d.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'Europe/Rome' }),
    ora:  d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }),
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
    // Lettura LEAN: db/users (profili) + per-utente db/userData/{uid}/__percorso, invece di tutto
    // db/userData (sessioni/statistiche di tutti → troppo pesante da scaricare a ogni run del cron).
    const usersSnap = await db.ref('db/users').once('value');
    const usersVal = usersSnap.val() || [];
    const users = Array.isArray(usersVal) ? usersVal.filter(Boolean) : Object.values(usersVal).filter(Boolean);
    const percMap = {};
    await Promise.all(users.filter(u => u && u.id).map(async (u) => {
      const ps = await db.ref('db/userData/' + u.id + '/__percorso').once('value');
      const p = ps.val();
      if (p && Array.isArray(p.lezioni)) percMap[u.id] = p;
    }));
    // DEBUG read-only: ?debug=1 → per ogni lezione futura, stato per-finestra senza scrivere/inviare.
    // ?force=<icsId>&w=<min>&uid=<uid> → invia SUBITO quella finestra (test delivery isolato, ignora orario/anti-doppione).
    if (req.query && (req.query.debug || req.query.force)) {
      if (req.query.force) {
        const fIcs = String(req.query.force), fW = Number(req.query.w) || 15, fUid = String(req.query.uid || '');
        let dt = null, uid = fUid;
        for (const u of Object.keys(percMap)) {
          for (const lez of (percMap[u].lezioni || [])) {
            if (lez && lez.icsId === fIcs) { dt = lez.dt; uid = uid || u; }
          }
        }
        const fmt = dt ? fmtDateTime(dt) : { data: '(test)', ora: '' };
        const tk = await tokensForUid(uid);
        const n = await sendToUid(uid, {
          title: LABEL[fW] || 'Promemoria allenamento',
          body: 'Allenamento ' + fmt.data + ' ore ' + fmt.ora,
          url: '/', tag: 'reminder_' + fIcs + '_' + fW,
        });
        return res.status(200).json({ force: true, uid, icsId: fIcs, w: fW, tokens: tk.length, sent: n });
      }
      const report = [];
      for (const uid of Object.keys(percMap)) {
        const tk = await tokensForUid(uid);
        for (const lez of (percMap[uid].lezioni || [])) {
          if (!lez || !lez.dt || !lez.icsId) continue;
          const lessonMs = lessonEpoch(lez.dt);
          if (isNaN(lessonMs)) continue;
          const minsTo = (lessonMs - now) / 60000;
          if (minsTo < -GRACE_MIN || minsTo > 1500) continue; // solo lezioni rilevanti a breve
          const sentSnap = await db.ref('db/reminderSent/' + lez.icsId).once('value');
          const sentVal = sentSnap.val() || {};
          const wins = WINDOWS.map(W => {
            const s = (now - (lessonMs - W * 60000)) / 60000;
            return { W, sinceTrigger: +s.toFixed(2), eligible: s >= 0 && s < GRACE_MIN, alreadySent: sentVal[W] === lez.dt, mark: sentVal[W] != null ? String(sentVal[W]) : null };
          });
          report.push({ uid, dt: lez.dt, icsId: lez.icsId, minutesToLesson: +minsTo.toFixed(2), tokens: tk.length, sentKeys: Object.keys(sentVal), windows: wins });
        }
      }
      return res.status(200).json({ debug: true, now, nowISO: new Date(now).toISOString(), lessons: report });
    }

    let checked = 0, sent = 0;
    const ops = [];

    for (const uid of Object.keys(percMap)) {
      const perc = percMap[uid];
      for (const lez of perc.lezioni) {
        if (!lez || !lez.dt || !lez.icsId) continue;
        const lessonMs = lessonEpoch(lez.dt);
        // Tieni la lezione idonea fino a GRACE_MIN dopo l'inizio: così la finestra da 15 min
        // (W < GRACE) non perde la sua coda di grazia e ha gli stessi ~20 min di cattura delle
        // altre. Con la vecchia guardia (lessonMs <= now) la coda dei 15 veniva tagliata a 15 min
        // → con cron a intervalli > 15 min la finestra 15 saltava mentre le altre (20 min) no.
        if (isNaN(lessonMs) || now >= lessonMs + GRACE_MIN * 60000) continue; // passata o invalida
        checked++;
        for (const W of WINDOWS) {
          const sinceTrigger = (now - (lessonMs - W * 60000)) / 60000; // minuti dal trigger
          if (sinceTrigger < 0 || sinceTrigger >= GRACE_MIN) continue;  // non scattata o ormai stale
          ops.push((async () => {
            // anti-doppione legato a (icsId, W, dt): invia solo se quella finestra non è già
            // stata inviata PER QUESTA data/ora. Memorizza lez.dt come marca. Se la lezione viene
            // spostata (dt cambia), la marca vecchia ≠ dt nuovo → la finestra si ri-arma e riparte.
            // (Bug precedente: marca = timestamp legata al solo icsId → spostando/riprovando una
            //  lezione la chiave restava settata e bloccava per sempre quella finestra, es. i 15 min.)
            const ref = db.ref('db/reminderSent/' + lez.icsId + '/' + W);
            const tx = await ref.transaction(cur => (cur === lez.dt ? undefined : lez.dt));
            if (!tx.committed) return; // già inviata per questa stessa data/ora
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
