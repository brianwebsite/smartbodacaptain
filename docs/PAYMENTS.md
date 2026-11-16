# Payments with LivePay

Status: **research only. No LivePay code is written yet.** The official docs (docs.livepay.me) could not be opened from the build environment, so nothing below should be treated as final.

## What is confirmed
From livepay.me (checked 2026-11-16):
- Uganda-focused. Mobile money (MTN MoMo and Airtel Money) plus payment links, airtime and bill payments.
- Collection fee shown: **3%** for UGX 500 to UGX 5,000,000. No monthly or setup fees. No payout fee was shown for Uganda.
- REST API with SDKs, webhooks and a sandbox are mentioned. Docs link: https://docs.livepay.me
- Operated by LIVETRADERX LTD, working with licensed payment operators.

## What a third-party SDK suggests (unofficial, verify against the real docs)
From the README of github.com/codrone/livepay:
- `POST /collect-money` with `phoneNumber`, `amount`, `currency`, `reference`, `description` and an `Idempotency-Key` header.
- `GET /transaction-status` by reference.
- `POST /send-money` for payouts, same fields.
- `GET /check-balance`, `POST /validate-number`.
- Webhooks signed in an `x-webhook-signature` header with a 300 second replay window. Events such as `payment.success` and `payment.failed`.
- Auth by API key and merchant account number.
- **The gateway requires a fixed server IP address to be whitelisted; wildcards are not allowed.** The server must be hosted somewhere with a fixed outgoing IP.

## Needed from the owner before any LivePay code is written
1. The official API documentation pages, pasted or saved as files: authentication, base URL, collect, status, payout, webhook format and signature method, phone number format, sandbox, error codes.
2. A LivePay merchant account with API key, account number and webhook secret, stored as server secrets and never committed.
3. LivePay's payout fee and limits, and written confirmation that paying captains out of Smart Boda's balance is allowed on the account.
4. A fixed outgoing IP for the server, to give to LivePay for whitelisting.

## Design decisions to settle
- **Money flow.** If passengers pay Smart Boda and Smart Boda pays captains out, Smart Boda is holding customer money. That may need a Bank of Uganda payment licence. Ask a lawyer before building payouts. The simplest start is **cash trips only**, with commission collected from captains separately.
- **Margin.** A 3% collection fee is a fifth of a 15% commission, and any payout fee comes on top. Prices and commission must account for it.
- **Idempotency.** Every payment request carries a unique key so a retry can never charge twice.
- **Confirmation.** A payment counts only when the signed webhook arrives or the status check says success, never on the app's word.
- All amounts are whole UGX integers.
