// Verifies a Google sign-in token ("ID token") that the phone app obtained.
// Google's own tokeninfo endpoint checks the signature for us; we then check
// that the token was issued for OUR app, is not expired, and has a verified email.

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * @param {string[]} clientIds  OAuth client IDs this server accepts (GOOGLE_CLIENT_ID).
 * @param {typeof fetch} fetchImpl  Replaceable in tests.
 * @returns {(idToken: string) => Promise<{sub: string, email: string, name: string}>}
 */
export function googleVerifier(clientIds, fetchImpl = fetch) {
  const allowed = new Set(clientIds);
  return async function verify(idToken) {
    if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 4096) {
      throw new Error('bad token');
    }
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('Google rejected the token');
    const t = await res.json();
    if (!allowed.has(t.aud)) throw new Error('token is for another app');
    if (!ISSUERS.has(t.iss)) throw new Error('wrong issuer');
    if (Number(t.exp) * 1000 < Date.now()) throw new Error('token expired');
    if (String(t.email_verified) !== 'true' || !t.email || !t.sub) throw new Error('email not verified');
    return { sub: String(t.sub), email: String(t.email).toLowerCase(), name: String(t.name ?? '') };
  };
}
