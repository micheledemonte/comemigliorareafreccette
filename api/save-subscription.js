// ═══════════════════════════════════════════════════════════════
// API — /api/save-subscription.js
// Salva la push subscription di un admin su Firebase
// Chiamato dal browser quando l'admin accetta le notifiche
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { subscription, adminUid, adminName } = req.body;

  if (!subscription || !adminUid) {
    return res.status(400).json({ error: 'Missing subscription or adminUid' });
  }

  try {
    // Salva su Firebase Realtime Database via REST API
    // (non serve SDK — usiamo la REST API pubblica con auth token)
    const firebaseUrl = process.env.FIREBASE_DATABASE_URL;
    const firebaseSecret = process.env.FIREBASE_DATABASE_SECRET;

    if (!firebaseUrl || !firebaseSecret) {
      return res.status(500).json({ error: 'Firebase not configured' });
    }

    const path = `pushSubscriptions/${adminUid}`;
    const url  = `${firebaseUrl}/${path}.json?auth=${firebaseSecret}`;

    const payload = {
      subscription,
      adminUid,
      adminName: adminName || '',
      updatedAt: new Date().toISOString(),
    };

    const response = await fetch(url, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: 'Firebase write failed', detail: text });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('save-subscription error:', err);
    return res.status(500).json({ error: err.message });
  }
}
