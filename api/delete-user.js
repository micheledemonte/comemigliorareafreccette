const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://comemigliorareafreccette.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, idToken } = req.body;
  if (!email || !idToken) return res.status(400).json({ error: 'Missing params' });

  try {
    await admin.auth().verifyIdToken(idToken);
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().deleteUser(user.uid);
    res.status(200).json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
