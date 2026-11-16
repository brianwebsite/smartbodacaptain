# Architecture

One backend serves three clients. Start as a single codebase; split later only if traffic demands it.

```
Passenger app ─┐
Captain app  ──┼──> Backend ──> Database (PostgreSQL + PostGIS, Redis for live positions)
Admin web ─────┘       │
                       ├──> Maps (Google Maps Platform)
                       ├──> Mobile money (MTN, Airtel) - Stage 3
                       └──> SMS and push (Firebase)
```

## Backend modules
- Accounts and sign-in (phone codes, captain documents)
- Trips and dispatch (match a request to nearby captains)
- Live location
- Pricing and commission (`backend/src/fare.js`)
- Payments
- Notifications

## Decisions
- Captains own the bikes and pay their own stage costs. Smart Boda earns a commission per trip (15% to start) or a weekly subscription; to be decided in the pilot.
- Fare calculation runs on our own server. Google is only asked for distance and time.
- Money is stored as whole Uganda shillings (integers). No decimals.
- Hosting region must be chosen with Uganda's data-protection rules in mind (PDPO).
