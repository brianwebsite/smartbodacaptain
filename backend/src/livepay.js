// LivePay (livepay.me) mobile-money collection. Server side only: the API key and
// webhook secret never go to the apps. Contract taken from the owner's working
// MTVUG integration (collect-money, transaction-status, signed webhook).

import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE = 'https://livepay.me/api';

export function livepayClient({ apiKey, accountNumber, webhookSecret, enabled = false, fetchImpl = fetch } = {}) {
  if (!enabled || !apiKey || !accountNumber) return null;
  const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  return {
    hasWebhookSecret: Boolean(webhookSecret),

    /** Asks LivePay to send a mobile-money prompt. Resolves with LivePay's own reference. */
    async collect({ phone, amount, reference, description }) {
      const res = await fetchImpl(`${BASE}/collect-money`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ accountNumber, phoneNumber: phone, amount, currency: 'UGX', reference, description }),
        signal: AbortSignal.timeout(15000),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.success) {
        const err = new Error('LivePay refused the request');
        err.refused = true;
        throw err;
      }
      return { internalReference: d.internal_reference ?? null };
    },

    /** The truth about one payment, straight from LivePay. */
    async status(reference) {
      const q = new URLSearchParams({ accountNumber, currency: 'UGX', reference });
      const res = await fetchImpl(`${BASE}/transaction-status?${q}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`LivePay status answered ${res.status}`);
      return res.json();
    },

    /** Checks the x-webhook-signature header: "t=<unix>,v=<hex hmac>", valid for 5 minutes. */
    verifyWebhook({ signature, origin, body, nowSec }) {
      if (!webhookSecret) return false;
      const t = /t=(\d+)/.exec(signature ?? '')?.[1];
      const v = /v=([0-9a-f]{64})/.exec(signature ?? '')?.[1];
      if (!t || !v || Math.abs(nowSec - Number(t)) > 300) return false;
      const data = `${origin}/api/livepay-webhook${t}customer_reference${body.customer_reference}internal_reference${body.internal_reference}status${body.status}`;
      const expected = createHmac('sha256', webhookSecret).update(data).digest('hex');
      return timingSafeEqual(Buffer.from(expected), Buffer.from(v));
    },
  };
}

/** Does LivePay's answer prove this exact payment succeeded? */
export function isVerifiedSuccess(d, topup) {
  return (
    d?.success === true &&
    d.status === 'Success' &&
    d.customer_reference === topup.id &&
    Number(d.amount) === topup.amount &&
    d.currency === 'UGX' &&
    (!topup.internal_reference || d.internal_reference === topup.internal_reference)
  );
}

export const isFailedStatus = (d) => ['failed', 'cancelled', 'expired', 'rejected'].includes(String(d?.status ?? '').toLowerCase());
