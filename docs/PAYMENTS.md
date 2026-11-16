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

## How Smart Boda gets paid (built and running now)

Captains own their vehicles and pay their own costs. Smart Boda takes a commission (default 15%, set in the admin Settings).

**Wallet trips (passenger pays from the Smart Boda wallet).** The fare is set aside when the ride is requested and moved when the trip ends. The captain's share goes to their wallet and Smart Boda's share stays with Smart Boda. If the captain owes commission from earlier cash trips, it is taken from this share first. Nothing can be skipped: the money moves only when the trip completes.

**Cash trips (passenger pays the captain).** Smart Boda never touches the cash, so the commission is recorded as a debt the captain owes (admin: Captains, "Owes"). Three protections stop a captain simply never paying or never completing:

1. **Debt limit.** Admin Settings, "Captain debt limit" (default UGX 50,000). A captain who owes more than that cannot go online or accept trips until the admin records a payment. This is the real protection: a captain who never pays stops earning, so the most Smart Boda can lose per captain is the limit.
2. **The phone completes the trip, not only the captain.** The captain app sends its location every 4 seconds during a trip. The server marks the trip "arrived" near the pickup, "started" after the captain drives away from the pickup, and "completed" once they sit at the drop-off after a real ride (at least 2 minutes). So a captain who forgets (or chooses not to) tap start or complete still creates the debt. Trips started this way are flagged "auto-started" in the admin Trips list.
3. **The passenger can see everything.** Every trip records who, where, when, the fare and the payment method. Passengers rate every trip, and captains rate passengers. The admin sees every cash trip and every commission owed.

**What can still go wrong with cash.** A captain who switches the app off during a trip, or a passenger and captain who agree to cheat together, will not be caught by software. Handle that with the debt limit, the ratings, and by suspending repeat offenders. Encourage wallet payments: they cannot be skipped.

**Best next step for collecting commission from cash trips.** Once LivePay collection works, let captains top up a "commission credit" (prepaid) instead of owing afterwards. This is how most boda apps avoid chasing debts.

## Penalties for cancelling (built and running now)
Only cancels after a captain accepted count. Cancelling while "finding a captain" is free.
- **Captains**: 2 cancels in 24 hours is a warning. 3 means they are treated as twice as far from every pickup, so they get fewer offers. 5 means no offers for 60 minutes.
- **Passengers**: 2 cancels in 24 hours is a warning. 4 means no new requests for 60 minutes.
The numbers are in `backend/src/behavior.js` and should be tuned after watching real use.

## Night fares
Fares rise by the percentage in admin Settings (default 5%) from 10 pm to 5 am Uganda time. The passenger sees "Night fare +5%" before requesting, and the trip records the percentage.

## Customer wallet top-up
Wallets work today. The admin can add money to a passenger's wallet (Users & wallets tab) after the passenger pays by MoMo to you. The in-app "Add money" button says "coming soon" until LivePay is connected; see the sections above for what is needed.
