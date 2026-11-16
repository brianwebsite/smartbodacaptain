// Sends email through Brevo's web API (free plan: a few hundred emails a day).
// Setup: create a Brevo account, verify one sender address, make an API key,
// then set BREVO_API_KEY and MAIL_FROM (the verified sender address) on the server.

/** Returns {send} or null when email is not set up. */
export function brevoMailer({ apiKey, from, fromName = 'Smart Boda', fetchImpl = fetch } = {}) {
  if (!apiKey || !from) return null;
  return {
    async send({ to, subject, text }) {
      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: fromName, email: from },
          to: [{ email: to }],
          subject,
          textContent: text,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`email provider answered ${res.status}`);
    },
  };
}
