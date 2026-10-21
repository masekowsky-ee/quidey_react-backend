# Putting Quidey online safely

The code protects itself (validation, rate limits, revocable logins, no error details).
These are the parts that depend on how the server is set up. Go through them once before
going live, and again when the setup changes.

## 1. Database

- **The app must not use `postgres`.** Create the limited role once (it can read and write
  Quidey's data, but can't drop tables, create roles or read other databases):

  ```sh
  psql -U postgres -d quidey -f schema.sql
  psql -U postgres -d quidey -v app_password='<long random password>' -f scripts/db-app-role.sql
  ```

  Then in the server's `.env`: `DB_USER=quidey_app` and that password.
  Migrations keep running as `postgres` (`psql -U postgres -d quidey -f migrations/00X_….sql`);
  tables they create are granted to `quidey_app` automatically.
- **Only reachable from the server itself.** In `postgresql.conf`:
  `listen_addresses = 'localhost'` (on the dev machine it is currently `*`).
  In `pg_hba.conf`, only `host … 127.0.0.1/32 scram-sha-256` and `::1/128` lines; no `0.0.0.0/0`.
  Restart PostgreSQL afterwards. Don't open port 5432 in the firewall.
- A long random password for `postgres` too, different from the app's.
- Backups: `pg_dump -U postgres -Fc quidey > quidey-$(date +%F).dump` on a schedule, stored
  somewhere other than the server, and try restoring one once.

## 2. The Node server

- `.env` from `.env.example`, readable only by the user that runs the server (`chmod 600 .env`).
- `NODE_ENV=production`.
- `JWT_SECRET`: a new random value for production (not the dev one), at least 32 characters:
  `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`.
- `CORS_ORIGINS=https://quidey.com` (exactly the site's origin, no trailing slash).
- Run it as a normal user (not root), under a process manager that restarts it
  (systemd service or pm2), and keep `npm audit` / updates in mind now and then.

## 3. HTTPS and the proxy

- The API only over HTTPS, e.g. `https://api.quidey.com`, with Caddy or nginx in front of Node
  (Caddy gets certificates automatically). Node itself listens on localhost only; the firewall
  only opens 80/443 (and SSH).
- **`TRUST_PROXY` must match the setup:**
  - behind exactly one proxy (Caddy/nginx on the same machine): `TRUST_PROXY=1`
  - Cloudflare in front of that proxy: `TRUST_PROXY=2`
  - clients connect to Node directly: leave it **empty**.
  Wrong in one direction, all users share one rate limit (and one attacker can block logins for
  everybody); wrong in the other, attackers can fake their IP and dodge the limits.
  Check: sign in with a wrong password 11 times from your phone's mobile network; your
  laptop on Wi-Fi must still be able to sign in.
- **Live connection (Socket.IO on `/socket.io/`, same port as the API):** the proxy must pass
  WebSocket upgrades through. Caddy's `reverse_proxy` does that by itself; nginx needs, in the
  location for the API:
  `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`
  and a `proxy_read_timeout` above 60 s. Cloudflare passes WebSockets on its own. The socket uses
  `CORS_ORIGINS` like the API. Without upgrades it still works (long polling), just slower.
  Run a single Node process: with several (pm2 cluster) the live events need the Socket.IO
  Redis adapter and sticky sessions (and the account cache in index.js would no longer hear
  about changes made by the other processes).
- **Compression:** let the proxy gzip/brotli the JSON answers (Caddy: `encode zstd gzip`;
  nginx: `gzip on; gzip_types application/json;`), Node doesn't do it itself.
- **Account cache:** pro/admin changes and sign-outs made in the app count at once. Changes made
  with `npm run pro` or psql take up to 15 s (`ACCOUNT_CACHE_MS`), because they bypass the server.
- **Migrations:** run `migrations/015_performance_indexes.sql` once on a database created before
  it (the indexes make the everyday queries fast as the tables grow).

## 4. The frontend (Cloudflare)

- Build with the API's address: `.env.production.local` with
  `VITE_API_URL=https://api.quidey.com`, then `npm run build`.
  The build writes `dist/_headers` with the security headers; its Content-Security-Policy
  only allows calls to that API address, so the build must use the real one.
- After deploying, check the headers once: `curl -sI https://quidey.com | grep -i -E "content-security|strict-transport|x-frame"`.
  If something on the page stops working, the browser console names the CSP rule that blocked it.

## 5. After going live

- Sign in as admin, look at the admin panel's log now and then.
- If a login token may have leaked: "Sign out everywhere" in the profile (or change the
  password). If `JWT_SECRET` may have leaked: set a new one and restart — everybody is signed out.
- Watch the server logs for `Something went wrong` errors; the details are only logged there.
