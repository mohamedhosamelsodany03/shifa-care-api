// Firebase Cloud Messaging (push notifications) — HTTP v1 API, no SDK.
// Sends with a Google OAuth2 access token minted from the Firebase
// service account (RS256 JWT signed with the account's private key,
// using Node's built-in crypto — no firebase-admin dependency).
//
// Flow: build JWT (iss = client_email, scope =
// https://www.googleapis.com/auth/firebase.messaging, 1h) -> exchange at
// https://oauth2.googleapis.com/token (grant_type =
// urn:ietf:params:oauth:grant-type:jwt-bearer) -> POST
// https://fcm.googleapis.com/v1/projects/{projectId}/messages:send
//   { message: { token, notification: {title, body}, data: {...} } }
// The access token is cached in memory until shortly before expiry.
//
// Config (env only, Railway dashboard — NEVER commit):
//   FIREBASE_SERVICE_ACCOUNT_JSON  (the whole service-account JSON), OR
//   FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
//   (private key with literal \n sequences, as pasted in Railway).
// STATUS: no Firebase project exists yet (the parent agent creates it —
// it is free). Until the env vars are set, fcmConfigured() is false and
// every send throws 'FCM not configured'; notifications stay in-app
// only. The web app registers its device token via POST /api/me/devices
// only when the native push plugin is present (see web/app.js).
//
// SECURITY: the private key and access tokens are NEVER logged. Only the
// result (sent / failed + FCM error code) is logged. FCM registration
// tokens are stored server-side only and never returned by any API.
const crypto = require('crypto');
const config = require('./config');

let cachedToken = null; // { accessToken, expiresAtMs }

function serviceAccount() {
  const fb = config.firebase;
  if (fb.serviceAccountJson) {
    try {
      const j = JSON.parse(fb.serviceAccountJson);
      if (j.project_id && j.client_email && j.private_key) {
        return { projectId: j.project_id, clientEmail: j.client_email, privateKey: j.private_key };
      }
    } catch { /* fall through to the parts */ }
  }
  if (fb.projectId && fb.clientEmail && fb.privateKey) {
    return { projectId: fb.projectId, clientEmail: fb.clientEmail, privateKey: fb.privateKey.replace(/\\n/g, '\n') };
  }
  return null;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

async function accessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs > now + 60000) return cachedToken.accessToken;
  const sa = serviceAccount();
  if (!sa) throw new Error('FCM not configured: set FIREBASE_SERVICE_ACCOUNT_JSON (or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY) in the host dashboard.');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iat = Math.floor(now / 1000);
  const payload = b64url(JSON.stringify({
    iss: sa.clientEmail,
    sub: sa.clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    iat,
    exp: iat + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  let signature;
  try {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsigned);
    sign.end();
    signature = sign.sign(sa.privateKey, 'base64url');
  } catch (e) {
    throw new Error(`FCM service-account key unusable: ${e && e.message}`);
  }
  const jwt = `${unsigned}.${signature}`;
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      res = await globalThis.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    throw new Error(`FCM token exchange failed (network/timeout): ${e && e.message}`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || !data || !data.access_token) {
    throw new Error(`FCM token exchange failed (HTTP ${res.status}).`);
  }
  cachedToken = { accessToken: data.access_token, expiresAtMs: now + (Number(data.expires_in || 3600) * 1000) };
  return cachedToken.accessToken;
}

// Send one push to one FCM registration token.
// Returns {ok:true, messageId}. Throws on failure; err.code is the FCM
// error status when known (e.g. 'UNREGISTERED' — the token is dead and
// the caller should drop it).
async function sendPush({ token, title, body, data }) {
  const sa = serviceAccount();
  if (!sa) throw new Error('FCM not configured: set FIREBASE_SERVICE_ACCOUNT_JSON (or the FIREBASE_* parts) in the host dashboard.');
  if (!token) throw new Error('FCM token required.');
  const at = await accessToken();
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.projectId)}/messages:send`;
  const payload = {
    message: {
      token,
      notification: { title: String(title || 'Shifa Care'), body: String(body || '') },
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [String(k), String(v ?? '')])),
      android: { priority: 'HIGH' },
    },
  };
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      res = await globalThis.fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    throw new Error(`FCM send failed (network/timeout): ${e && e.message}`);
  }
  let out = null;
  try { out = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = out && out.error;
    const code = err && (err.status || err.details?.[0]?.reason);
    const e = new Error(`FCM send failed (${err ? `${err.status || ''} ${err.message || ''}`.trim() : `HTTP ${res.status}`}).`);
    e.code = code || null;
    e.httpStatus = res.status;
    throw e;
  }
  const messageId = out && out.name ? String(out.name).split('/').pop() : null;
  return { ok: true, provider: 'fcm', messageId };
}

module.exports = { sendPush, accessToken, serviceAccount };
