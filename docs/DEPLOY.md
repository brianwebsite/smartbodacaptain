# Deploying the Smart Boda server

The server is one Node 22 process with a SQLite file. It needs no other software.

## What you need
- A small VPS (1 GB RAM is enough to start) with a fixed public IP. LivePay will need that IP whitelisted later.
- A domain name pointing at it (for example `api.yourdomain.com`). The phone apps need HTTPS on real devices.
- Docker installed on the VPS.

## Steps
1. Get the code: `git clone https://github.com/brianwebsite/smartbodacaptain && cd smartbodacaptain`
2. Build: `docker build -f backend/Dockerfile -t smartboda .`
3. Create a data folder: `mkdir -p /srv/smartboda-data && chown 1000:1000 /srv/smartboda-data`
4. Run (replace the values):

```
docker run -d --name smartboda --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v /srv/smartboda-data:/data \
  -e ADMIN_PHONE=0772XXXXXX -e ADMIN_PASSWORD='a-long-password-here' \
  -e GOOGLE_MAPS_API_KEY='your-key' -e TRUST_PROXY=1 \
  smartboda
```

5. HTTPS with Caddy (installs certificates by itself). In `/etc/caddy/Caddyfile`:

```
api.yourdomain.com {
    reverse_proxy 127.0.0.1:8080
}
```

6. Open `https://api.yourdomain.com/admin` and sign in with the admin phone and password. Approve captains there.

## Point the apps at the server
In GitHub: Settings > Secrets and variables > Actions > Variables > New variable `API_BASE_URL` = `https://api.yourdomain.com`. Re-run the "Android apps" workflow. Install the new APKs from the `android-latest` release.

## Backups
The whole database is one file: `/srv/smartboda-data/smartboda.db`. Copy it daily (`sqlite3 smartboda.db ".backup backup.db"`) to somewhere else.

## Without a Google key
The server still works but shows fares from straight-line distance and labels them "approximate". Add `GOOGLE_MAPS_API_KEY` (Routes API enabled) for real road distances.

## Free test server on Render (testing only)
Render's free plan has no permanent disk: data is wiped when the service restarts or sleeps. Use it only to test sign-in and trips, never for real captains.

1. Sign up at render.com with GitHub and allow it to read the `smartbodacaptain` repository.
2. New > Web Service > pick the repository. Runtime: **Docker**. Dockerfile path: `backend/Dockerfile`. Root directory: leave empty. Instance type: **Free**.
3. Environment variables: `ADMIN_PHONE`, `ADMIN_PASSWORD` (10+ characters), `TRUST_PROXY=1`. `GOOGLE_MAPS_API_KEY` is optional.
4. Deploy. Render gives you an address like `https://smartboda-xxxx.onrender.com`. Open `/health` on it to check.
5. Set the GitHub variable `API_BASE_URL` to that address and re-run the "Android apps" workflow.

## Google sign-in for passengers (optional)
1. console.cloud.google.com: create a project (free; no billing needed). APIs & Services > OAuth consent screen: set the app name and your email.
2. Credentials > Create credentials > OAuth client ID. Make **two**:
   - Type **Web application**. Copy its Client ID. This is `GOOGLE_CLIENT_ID` on the server.
   - Type **Android**, package name `ug.smartboda.passenger`, SHA-1 = the fingerprint of `android-debug/debug.keystore` (printed by `keytool -list -v -keystore android-debug/debug.keystore -storepass android`).
3. Set `GOOGLE_CLIENT_ID` on the server and restart it. The "Continue with Google" button appears by itself when the server has it.
4. While the consent screen is in "Testing", only the test users you list can sign in. Publish it when you are ready.

## If the admin cannot sign in
Open the server's log (on Render: your service > Logs) and find the lines starting with `Admin:`. They say exactly what the server saw, for example "ADMIN_PASSWORD must be at least 10 characters" or "the phone ... already belongs to a passenger account". Fix the setting and redeploy. The server repairs the admin account from `ADMIN_PHONE` and `ADMIN_PASSWORD` on every start, so changing the password there is how you reset it. Sign in on `/admin` with the same phone number and password, typed exactly as in the settings (no quote marks).

## Forgot-password emails (optional)
Passengers who signed up with an email can reset their password with a 6-digit code sent to that email. This needs an email sender. The free plan of Brevo (brevo.com) is enough for a pilot:
1. Create a Brevo account and verify one sender address (an address you can receive mail at).
2. In Brevo, make an API key (SMTP & API, API keys).
3. Set two environment variables on the server: `BREVO_API_KEY` (the key) and `MAIL_FROM` (the verified sender address). Restart.
The log line `Password reset email: on` confirms it. Without these, the app tells people to contact support, and you can reset any password yourself in the admin dashboard (Users & wallets, Reset password).

## Server settings summary
| Variable | What it does |
|---|---|
| `ADMIN_PHONE`, `ADMIN_PASSWORD` | The admin login (password at least 10 characters) |
| `GOOGLE_CLIENT_ID` | Turns on "Continue with Google" |
| `BREVO_API_KEY`, `MAIL_FROM` | Turns on forgot-password emails |
| `DB_PATH` | Where the database file lives |
| `TRUST_PROXY=1` | Behind Render or another proxy, so rate limits see the real visitor |

## Mobile money top-ups with LivePay
Passengers add money to their wallet through LivePay (3% collection fee, which Smart Boda absorbs: the wallet is credited the full amount). Set these on the server (Render: Environment), never in the apps or on GitHub:
| Variable | Value |
|---|---|
| `LIVEPAY_ENABLED` | `true` (the admin Overview page shows which of these five the server can see) |
| `LIVEPAY_API_KEY` | your LivePay API key |
| `LIVEPAY_ACCOUNT_NUMBER` | your LivePay account number |
| `LIVEPAY_WEBHOOK_SECRET` | the webhook secret from LivePay |
| `PUBLIC_URL` | the server's public address, for example `https://smartbodacaptain.onrender.com` (used to check webhook signatures) |

In LivePay, set the webhook URL to `PUBLIC_URL/api/livepay-webhook`. The log line `LivePay top-ups: on` confirms it. Money is added only after the server asks LivePay for the payment and the reference, amount and currency match, and never twice. The webhook is only a nudge; if it is missing, the app's own status check settles the payment.
LivePay may require a fixed server IP to be whitelisted. Render's free plan has no fixed IP, so if LivePay refuses requests, that is why: move to a server with a fixed address.


## Keep accounts and sign-ins across redeploys (free)
Render's free plan wipes the disk on every deploy, which deletes all accounts and sign-ins. The server can copy its database to free S3-compatible storage and restore it at start-up.

1. Cloudflare dashboard > R2 > create a bucket (for example `smartboda-db`). R2 has a free allowance; it asks for a card but does not charge within it.
2. R2 > Manage API tokens > create a token with **Object Read & Write** for that bucket. Copy the Access Key ID, the Secret Access Key and the S3 endpoint (`https://<account>.r2.cloudflarestorage.com`).
3. In Render > Environment add:

| Name | Value |
|---|---|
| `BACKUP_S3_ENDPOINT` | the endpoint above |
| `BACKUP_S3_BUCKET` | the bucket name |
| `BACKUP_S3_KEY_ID` | Access Key ID |
| `BACKUP_S3_SECRET` | Secret Access Key |
| `BACKUP_S3_REGION` | `auto` for R2 (Backblaze B2: its region, for example `us-west-004`) |

4. Redeploy. The log says `Database backup: nothing-to-restore` the first time and `restored` after later deploys.

The database is copied every 30 seconds when something changed, and once more when Render stops the server. A crash can lose up to 30 seconds of changes. If the stored copy exists but cannot be read, the server refuses to start instead of replacing it with an empty database. A paid Render disk with `DB_PATH=/var/data/smartboda.db` is the simpler, safer option when you can afford it.
