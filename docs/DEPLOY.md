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
