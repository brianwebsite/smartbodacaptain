# Smart Boda

A ride-hailing platform for boda boda captains in Uganda. Captains bring their own bikes and keep their own stage arrangements; Smart Boda provides the software.

This single repository holds everything:

| Folder | What it is |
| --- | --- |
| `backend/` | The server: accounts, trips, dispatch, fares, payments |
| `apps/passenger/` | Passenger mobile app (Flutter) |
| `apps/captain/` | Captain mobile app (Flutter, light build for low-end Android) |
| `admin/` | Admin dashboard (web) |
| `docs/` | Plan, stages and architecture notes |

## Status

Stage 0 (foundation). The first working piece is the fare calculation in `backend/src/fare.js`.

## Run the tests

Needs Node 20 or newer. No packages to install yet.

```
cd backend
npm test
```

## Rules for this repo

- Never commit passwords, API keys or the Google Maps key. Secrets live in GitHub Actions secrets and in server environment variables.
- Every change to fares, payments or captain matching needs a test.
- Stages and gates are listed in `docs/STAGES.md`. Nothing from the next stage is built until the gate before it is passed.
