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

**Cash trips (passenger pays the captain) use prepaid commission credit.** Smart Boda never touches the cash. Instead the rider keeps a credit balance with Smart Boda:

1. The rider tops up credit (for example UGX 10,000). This is *unused rider credit*, a liability, not revenue.
2. A cash trip is only offered to a rider whose free credit covers that trip's commission. When the rider accepts, the commission (for example UGX 500 on a UGX 5,000 trip) is reserved. Two requests cannot reserve the same credit.
3. When the trip completes the reservation becomes company commission revenue, exactly once. Credit goes from 10,000 to 9,500. The rider keeps the UGX 5,000 cash; there is no extra withdrawable balance.
4. If the trip is cancelled or expires, the reservation is released exactly once.
5. If free credit is too low, the rider sees how much more is needed. The wallet and top-up stay available. Trips paid in the app still work.

There is no rider debt. An accepted trip always finishes, because its commission is already reserved.

**Digital (wallet) trips.** The passenger pays from the Smart Boda wallet. At completion the ledger posts: fare out of the passenger wallet, commission to company revenue, the rest to "payable to rider". Payouts are manual and audited for now (admin records the payout after sending the money).

**Ledger.** Every movement is a balanced double-entry journal with a unique reference; entries are never edited or deleted (database triggers block it); corrections are linked reversals. Admin overview shows revenue, unused credit, reserved credit, rider payables and passenger wallets separately.

**Protections.** The phone completes the trip by location, so forgetting to tap does not avoid the commission. Credit is only added after LivePay confirms (signed webhook plus status check). Admin balance changes need a written reason and are recorded with the admin's id.

**What software cannot stop.** A rider and passenger who agree to cheat, or a rider who switches the app off and takes the passenger privately, are not seen. Controls: receipts, trip sharing, support in the app, ratings, and reviewing riders with many cancellations.

## Penalties for cancelling (built and running now)
Only cancels after a captain accepted count. Cancelling while "finding a captain" is free.
- **Captains**: 2 cancels in 24 hours is a warning. 3 means they are treated as twice as far from every pickup, so they get fewer offers. 5 means no offers for 60 minutes.
- **Passengers**: 2 cancels in 24 hours is a warning. 4 means no new requests for 60 minutes.
The numbers are in `backend/src/behavior.js` and should be tuned after watching real use.

## Night fares
Fares rise by the percentage in admin Settings (default 5%) from 10 pm to 5 am Uganda time. The passenger sees "Night fare +5%" before requesting, and the trip records the percentage.

## Customer wallet top-up
Wallets work today. The admin can add money to a passenger's wallet (Users & wallets tab) after the passenger pays by MoMo to you. The in-app "Add money" button says "coming soon" until LivePay is connected; see the sections above for what is needed.
