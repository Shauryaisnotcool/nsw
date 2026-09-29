# nuggetsmp.online — GoDaddy, Netlify and game data

## DNS findings, checked September 29, 2026

Authoritative nameservers are **ns29.domaincontrol.com** and **ns30.domaincontrol.com** (GoDaddy). The root `nuggetsmp.online` has no A record; `www` has no CNAME. This is missing configuration, not just a propagation delay. `play.nuggetsmp.online` already points to `140.245.25.229`, and `_minecraft._tcp.play` already advertises port **25590** (priority 5, weight 0).

## Fix the website while keeping DNS at GoDaddy

GoDaddy → Domain Portfolio → nuggetsmp.online → DNS → DNS Records → Add New Record:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | `75.2.60.5` | 600 seconds, or the shortest offered |
| CNAME | `www` | `nuggetsmp.netlify.app` | 600 seconds, or the shortest offered |

Keep the existing GoDaddy nameservers. Remove only conflicting website A/AAAA/CNAME or parking/forwarding records for `@` and `www`, if present. Keep `play`, its SRV record, and any email/TXT records. Do not enter `https://`, a path or a port in an A/CNAME value.

Netlify → the `nuggetsmp` site → Domain management → Production domains:

1. Add `nuggetsmp.online` and `www.nuggetsmp.online`; choose `nuggetsmp.online` as the primary domain.
2. Use **external DNS**. An unused Netlify DNS zone may keep saying it is waiting for nameserver propagation because the domain is intentionally using GoDaddy. Do not wait for that zone to become authoritative and do not copy Netlify nameservers into ordinary NS records.
3. Once DNS resolves, use HTTPS → Verify DNS configuration / provision the certificate. Netlify manages renewal.
4. The primary domain should be HTTPS. Leave Netlify's normal HTTP-to-HTTPS behavior enabled. Test `/api/status` on both domain aliases after the backend is connected; bridge POSTs must not be redirected.

Netlify documents this A record for its standard network. If this site's domain setup panel explicitly gives a different target, use that site's instructions. DNS caches can retain old/negative answers until their TTL expires.

The Minecraft address is **play.nuggetsmp.online:25590**. Java clients can normally omit the port because the existing SRV record supplies it. The website uses the explicit port to work even when a client does not resolve SRV. Do not point the Minecraft subdomain at Netlify.

Sources: [Netlify external DNS](https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/), [GoDaddy A records](https://www.godaddy.com/help/add-or-edit-an-a-record-42546), [Netlify HTTPS troubleshooting](https://docs.netlify.com/manage/domains/troubleshooting/troubleshoot-ssl-and-https/).

## Deploy the updated frontend

For a connected source repository: base directory = this website folder, build command = `npm run build`, publish directory = `out`, Node version = **24**. `netlify.toml` supplies these settings and packages `netlify/functions/api.mjs`. The frontend and API deploy together; Supabase is the durable database.

For a manual upload: use a connected repository deploy for this project because Netlify must build the Function source as well as the frontend. A static-only upload of `out` can show the design, but it cannot run `/api/*` or connect the Folia bridge. Never upload `.env`, `.env.supabase.local`, player databases or secrets.

## Supabase and Netlify Function setup

The API now runs inside Netlify Functions and stores state in Supabase Postgres. There is no separate `api.nuggetsmp.online` DNS record or Java backend to maintain. Until the environment variables below are set on the deployed Netlify site, pages and animations work but login, live stats, staff syncing and checkout stay unavailable.

The prepared request path is:

```text
Browser / Folia plugin
    → https://nuggetsmp.online/api/…
    → Netlify proxy (same path and request body)
    → Netlify Function `api`
    → Supabase transaction pooler + private `nugget_web` schema
```

`https://nuggetsmp.netlify.app/api/…` uses the same proxy and database. Netlify's rule returns 200 internally (a proxy), not a browser redirect. It preserves the signed bridge path. Do not add a catch-all `/api/* → /index.html` rule.

1. In Supabase, keep the database password private and use the transaction pooler URL (port `6543`) in Netlify as `DATABASE_URL`. The Function supplies the included CA certificate and verifies TLS. Set `SUPABASE_DB_SCHEMA=nugget_web`.
2. In Netlify → Site configuration → Environment variables, set:

```dotenv
NODE_ENV=production
PUBLIC_ORIGIN=https://nuggetsmp.online
PUBLIC_ORIGIN_ALIASES=https://nuggetsmp.netlify.app
MC_ADDRESS=play.nuggetsmp.online:25590
GAME_BRIDGE_SECRET=GENERATE_A_NEW_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS
DATABASE_URL=YOUR_SUPABASE_TRANSACTION_POOLER_URL
SUPABASE_DB_SCHEMA=nugget_web
```

Do not commit this file or put `DATABASE_URL` in the frontend. The Function creates the schema and tables on its first request. Set real operator/support and payment-provider settings before enabling checkout. If migrating existing SQLite data, use a reviewed one-time migration rather than running both stores for the same account.

The backend accepts browser POSTs only from the exact two allowed origins. Cookies stay HTTP-only, Secure and host-only. Each hostname has its own browser login cookie, but both point to the same Minecraft accounts and purchases. Prefer the custom domain for visitors. No wildcard CORS is needed because `/api` stays on the website's own origin.

### Folia plugin connection

The existing plugin already sends signed heartbeat, player statistics, staff and verification data and polls rank delivery. No gameplay rebuild is needed just to change its endpoint.

On the **hosted Minecraft server**, merge into `plugins/NuggetSMP/config.yml`:

```yaml
website:
  enabled: true
  url: 'https://nuggetsmp.online'
  secret-env: NUGGET_WEBSITE_SECRET
```

Set `NUGGET_WEBSITE_SECRET` in the Minecraft process environment to exactly the backend's `GAME_BRIDGE_SECRET`, then fully restart Folia. Use one endpoint, not two simultaneous senders. `https://nuggetsmp.netlify.app` is also supported if its `/api` path proxies directly; prefer the primary custom domain. The plugin deliberately does not follow redirects with signed requests. Never put a shared secret in a public JavaScript bundle or `NEXT_PUBLIC_*` setting.

Use the primary domain in the plugin. While the Netlify environment variables are incomplete, keep `website.enabled: false` on the live host to avoid failed background requests; enable it after the checks below pass. Desktop's URL is prepared; its existing enable flag is preserved.

### Acceptance checks

- `dig +short nuggetsmp.online A` → `75.2.60.5`.
- `dig +short www.nuggetsmp.online CNAME` → Netlify hostname.
- Both site URLs have a valid HTTPS certificate and the updated game address.
- `curl -i https://nuggetsmp.online/api/status` → **JSON**, `Cache-Control: no-store`, not HTML. Until a fresh signed heartbeat arrives, count must be unknown/stale, not fabricated. A first request may take a few seconds while the Function opens the Supabase pool.
- On a fresh browser, request a login code; run `/verify <code>` with your account. The website links within its five-second poll interval.
- Confirm player/staff data, then restart the backend and verify the same saved profile remains.

Proxy documentation: [Netlify rewrites and proxies](https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/).
