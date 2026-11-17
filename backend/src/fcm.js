// Push notifications through Firebase Cloud Messaging (free). Uses the HTTP v1 API and a
// service account key, with only Node's built-in modules.
//
// Setup: Firebase console > Project settings > Service accounts > Generate new private key.
// Put the whole JSON file's text in the server variable FIREBASE_SERVICE_ACCOUNT.

import { createSign } from 'node:crypto';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** Returns { send(token, {title, body, data}) } or null when push is not set up. */
export function fcmFromEnv(json, { fetchImpl = fetch, nowSec = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!json || !json.trim()) return null;
  let account;
  try {
    account = JSON.parse(json);
  } catch {
    console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON, so push notifications are off.');
    return null;
  }
  if (!account.client_email || !account.private_key || !account.project_id) {
    console.error('FIREBASE_SERVICE_ACCOUNT is missing client_email, private_key or project_id.');
    return null;
  }
  let cached = null; // { token, expiresAt }

  async function accessToken() {
    const t = nowSec();
    if (cached && cached.expiresAt - 60 > t) return cached.token;
    const header = b64url({ alg: 'RS256', typ: 'JWT' });
    const claims = b64url({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: t,
      exp: t + 3600,
    });
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.private_key, 'base64url');
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Google token answered ${res.status}`);
    const d = await res.json();
    cached = { token: d.access_token, expiresAt: t + Number(d.expires_in ?? 3600) };
    return cached.token;
  }

  return {
    projectId: account.project_id,
    /** Resolves 'sent', or 'unregistered' when the phone no longer has the app (drop that token). */
    async send(token, { title, body, data = {} }) {
      const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
            android: { priority: 'HIGH', ttl: '600s', notification: { sound: 'default' } },
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return 'sent';
      const d = await res.json().catch(() => ({}));
      const code = JSON.stringify(d);
      // Only a dead phone token is dropped. A bad message or a setup problem must not delete good tokens.
      if (res.status === 404 || (res.status === 400 && /registration token|UNREGISTERED/i.test(code))) {
        if (/UNREGISTERED|registration token/i.test(code)) return 'unregistered';
      }
      throw new Error(`FCM answered ${res.status}${d?.error?.message ? `: ${String(d.error.message).slice(0, 240)}` : ''}`);
    },
  };
}
