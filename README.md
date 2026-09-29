# Nugget SMP website

Next.js 16 website with Motion animations and licensed Monocraft pixel typography, a Netlify Function API with durable Supabase Postgres state, Razorpay Standard Checkout, and a matching Folia plugin bridge. Netlify serves the frontend and the `/api/*` function; Supabase keeps accounts, orders, verification codes and offline player statistics across deploys.

## Local development

**September 29 domain update:** Website `https://nuggetsmp.online` (Netlify alias `https://nuggetsmp.netlify.app`), game `play.nuggetsmp.online:25590`. Follow [GoDaddy / Netlify setup](deploy/GODADDY-NETLIFY.md) for the exact DNS records and Supabase/Netlify Function settings. Netlify forwards `/api/*` to `netlify/functions/api.mjs`; no separate `api.nuggetsmp.online` host is required. For local development override `PUBLIC_ORIGIN=http://127.0.0.1:5173` and clear `PUBLIC_ORIGIN_ALIASES` in your local `.env`.

Run `npm ci`, copy `.env.example` to `.env`, then use two terminals: `npm run dev:api` and `npm run dev`. Website: `http://127.0.0.1:5173`. The game bridge requires a generated shared secret; do not commit it. `npm test` covers the local SQLite API using an isolated database and mocked payment provider. To test the production database locally, set `DATABASE_URL` from Supabase in an ignored `.env.supabase.local` and open the store with `openPostgresStore`; never put it in the frontend or commit it. `npm run build` builds production assets. `npm start` serves the SQLite API and `out` locally; Netlify uses the Function wrapper instead.

## Netlify + Supabase deployment

1. In Netlify, connect this website folder (or upload the built `out` folder with the Function source through a repository deploy). Keep build command `npm run build`, publish directory `out`, and Node `24`; `netlify.toml` supplies these values.
2. In Netlify → Site configuration → Environment variables, add `DATABASE_URL` using the Supabase **transaction pooler** URL, `SUPABASE_DB_SCHEMA=nugget_web`, `PUBLIC_ORIGIN=https://nuggetsmp.online`, `PUBLIC_ORIGIN_ALIASES=https://nuggetsmp.netlify.app`, `MC_ADDRESS=play.nuggetsmp.online:25590`, and a new random `GAME_BRIDGE_SECRET` of at least 32 characters. Add `NUGGET_WEBSITE_SECRET` with the same value to the Folia process environment. Add `STAFF_JSON`, `OPERATOR_NAME`, and `SUPPORT_EMAIL` when ready.
3. `netlify/functions/api.mjs` creates the private schema and tables on its first request. The included Supabase CA certificate keeps the pooler connection verified. Do not add the database URL to `NEXT_PUBLIC_*`, the frontend bundle, Git, or the Minecraft plugin.
4. For purchases, add Razorpay test/live keys and webhook secret as Netlify environment variables. Set the `payment.captured` webhook to `https://nuggetsmp.online/api/webhooks/razorpay`. Checkout stays closed until the required operator/support and merchant fields are present. For the personal UPI option, set `UPI_MANUAL_REVIEW_ENABLED=true` only when you can reconcile bank credits manually.
5. Set GoDaddy DNS using [deploy/GODADDY-NETLIFY.md](deploy/GODADDY-NETLIFY.md), wait for the HTTPS certificate, then test `https://nuggetsmp.online/api/status`. It must return JSON. Set the Folia plugin website URL to `https://nuggetsmp.online` and restart the server.

## What is implemented

- Cryptographically random `xxxx-xxxx` codes, ten-minute expiry and a unique permanent hash registry so codes are never reissued while the database is retained. Cookies bind polling to the initiating browser. Proof comes only from signed requests sent by the game plugin. Five-second polling updates the account view without reloading the whole page.
- HTTP-only, SameSite cookies, server-side consent versions, rotating 30-day login sessions, same-origin POST checks, request limits and a timestamp/nonce HMAC game bridge. The bridge never exposes the shared secret to browser code.
- 60-second server snapshots and browser refresh. Missing/stale status displays no fabricated player count. A stale snapshot becomes delayed after 90 seconds. IP remains unset until configured.
- $0.99 / 7 days, $2.99 / 30 days, $4.99 / 90 days in USD. Server-side prices, unique provider receipts, account-bound welcome codes and one discounted order per account. A failed checkout retries the same order; the first discounted plan is reserved until completion. No stackable or transferable coupons.
- Captured-payment verification using Razorpay HMAC and server-fetched payment details; webhook duplicates are idempotent. A paid order remains queued until the plugin saves its LuckPerms grant and acknowledges delivery. Absolute expiry is recorded in the game database before applying the rank, so an acknowledgement failure or restart cannot extend the same purchase twice. New purchases extend existing time. Offline-player grants are supported. No administrative wildcard permissions are granted.
- Light/dark themes, essential cookie choice, terms/privacy routes, Lucide icons, local fonts and official Minecraft imagery with attribution.

## Operations and limitations

Supabase is the durable source of truth. Use Supabase project backups or `pg_dump` for the private schema, and preserve the game server `.nuggetsmp-data` directory as well. Netlify Functions may cold-start or run concurrently; the transaction pooler and Postgres transactions keep account linking, orders and delivery receipts consistent.

Payments require merchant credentials, international-payment eligibility and provider capture/webhook configuration. Actual Razorpay checkout, live Minecraft client login and production VPS networking still require an owner-run test once these exist. Refunds/disputes need staff review and corresponding rank adjustment; automatic refund clawback is not implemented. When an order grant is reserved but LuckPerms saving is repeatedly unavailable, its fixed expiry is retained on retry; review unusually delayed deliveries manually. Payment data never originates from a browser success redirect alone.

To test the website on the Desktop server, start the local API with SQLite as before, or run the Postgres adapter with the ignored `.env.supabase.local`. Use `website.url: 'http://127.0.0.1:8787'` for local plugin testing, set matching bridge secrets, and restart. The hosted plugin should use `https://nuggetsmp.online`.

## Sources

- [Razorpay Standard Checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/), [webhook verification](https://razorpay.com/docs/webhooks/validate-test/), [receipt lookup](https://razorpay.com/docs/api/orders/fetch-all/), [India international payments](https://razorpay.com/docs/payments/international-payments/). No-monthly-subscription setup does not mean fee-free transactions; merchant approval and processing fees apply.
- [Ateex VPS](https://ateex.cloud/vps/), [Lucide](https://lucide.dev/), [Minecraft usage guidelines](https://www.minecraft.net/en-us/usage-guidelines).
- Hero and secondary images: [official Xbox Wire Minecraft Vibrant Visuals article](https://news.xbox.com/en-us/2025/03/25/minecraft-vibrant-visuals/), © Mojang/Microsoft. They show Minecraft, not the actual Nugget SMP map. No image-specific commercial license was provided; confirm permission before a public commercial launch. The private preview uses the requested official imagery with attribution.

Public operator, support email, staff roster, game IP and payment keys were intentionally left configurable at the owner's request. Never put secrets in `.openai/hosting.json`, a `NEXT_PUBLIC_` variable or source control.

## Personal UPI checkout

The custom QR checkout requests payment to `9766391181@fam`. Every attempt has a new cryptographic reference and QR. Server timestamps enforce 180 seconds; a page reload resumes the original attempt. Regeneration cancels the earlier website attempt. The reference FX rate comes from Frankfurter USD/INR, is shown before payment and is locked for that attempt. Stale or unavailable rates prevent checkout.

A personal UPI URI cannot receive bank webhooks, guarantee merchant eligibility, universally accept international cards, or invalidate a saved QR at the bank. UPI therefore remains disabled until you set `UPI_MANUAL_REVIEW_ENABLED=true` and supply operator/support details. Only enable it if your account permits these receipts and staff can reconcile bank credits. This is a custom checkout, not a payment processor.

After independently matching the **actual bank credit**, exact amount and checkout reference, run on the website host:

```sh
npm run reconcile:upi -- ATTEMPT_ID BANK_REFERENCE AMOUNT_PAISE RECEIVED_ISO --bank-credit-verified
```

This audited local command queues the same durable rank delivery used by Razorpay. Do not run it based only on screenshots, customer claims or an unverified transaction ID. Late/cancelled attempts are blocked unless you review the credit and explicitly add `--accept-late`; duplicate credits for already-paid orders require refund review. No browser endpoint can self-confirm payment. Receipts and order grants are idempotent across restarts.

The separate international/card option uses Razorpay after merchant approval. Its settlement destination is configured with the provider; it cannot be forced to the personal Fam UPI address by this website. Merchant-issued QR APIs would be needed for automatic UPI confirmation and bank-enforced QR closure.

Font: [Monocraft by Idrees Hassan](https://github.com/IdreesInc/Monocraft), SIL Open Font License; license bundled in `public/fonts`. This is a Minecraft-inspired font, not a claim to own Mojang’s font.

## Player stats and current staff (September 27)

- `/stats/` searches online and offline players. Profiles include the native Nugget economy balances, seven-day ledger totals and ranked arena ratings for all eight kits. The game signs a telemetry batch every five seconds; offline profiles rotate in pages of 40. Online profiles refresh on every batch (up to 200 online players).
- The Staff navigation opens a keyboard-accessible animated overlay, with Owner/Crown, Admin/Shield Check and Mod/Shield filters. Minecraft faces come from CraftHead. The plugin reads persisted LuckPerms users, including offline users, and publishes a complete current roster. Revoked roles disappear on the next roster refresh (normally within 15 seconds). Roster data older than 30 seconds is hidden. An empty or disconnected server never gets a fabricated team.
- `/moderation/` uses the same stats view. A verified website session and an online owner/admin/mod permission snapshot no older than 15 seconds are both required for read-only inventory and punishment inspection. Inspection reads are audited. Public roster membership does not grant dashboard access.
- `GET /api/staff`, `/api/stats?q=prefix&page=0`, `/api/stats/:uuid`; protected `/api/moderation/me` and `/api/moderation/:uuid/{inventory|punishments}`. Only the existing signed bridge can write telemetry. No SQL or Minecraft administration port is exposed to browsers.
- Rebuild the frontend with `npm run build`, restart the Node service and restart Minecraft with the matching plugin JAR. The static private preview can show the design but needs the self-hosted Node service for live data.
