# Zaiqa — Pakistani Food-Business Directory (reel design)

Zaiqa is a NEW brand on the complete FoodScope feature set — every function
identical, only the name, identity and design are new. The design comes from the
"Tap. Order. Eat." food-delivery reel by TechZoid I.T. Solutions
(https://www.facebook.com/reel/1370115531864102) — green-gradient header,
mint hero, circular categories, deal cards, delivery rail, restaurant
grid, map-first vendor page, bottom nav. My own implementation; no code,
images or data copied from the reel.

## What is the same as FoodScope
Everything functional, 1:1 — same API, same rules, same seed data:
public directory (search / category / city / sort), vendor detail (menu in PKR,
gallery, reviews, ratings), reviews with safety scan + flagging, customer and
manager registration with verification codes, manager OTP login, manager panel
(submit vendor, edit details, update requests, subscription payments with proof
upload, menu, gallery, certificates, staff), staff panel (menu only), Portal
Admin panel (approvals, payments, certificates, update requests, gallery,
review moderation, users, contacts, reports, audit log), CSRF + sessions +
rate limits + audit logging. Test suite: **242/242 pass** (`node test.js`).

## What changed
- New look: olive/sage-green gradient header with "Deliver to" city picker +
  bell, white search pill, pale-mint hero with scooter art + orange CTA,
  circular category icons, plan deal cards with Claim buttons, "Delivery available"
  horizontal rail, "Restaurants" grid with plan badges, floating
  top-rated card, bottom nav (Home / Saved / Plans / Manager / Profile).
- Vendor page is map-first, like the reel's live-tracking screen: Google Maps
  embed on top (from the vendor's address), then a detail sheet with a
  Listed → Approved → Subscribed → Delivery → Open progress bar, a status
  timeline, Message / Call buttons (real delivery phone), menu, gallery,
  reviews. New route `#/offers` shows the subscription plans as deal cards.
- The bell opens your account (or login) and shows an orange dot when the
  admin has pending vendors or the manager has pending payments/requests.
- Dropped from v1 (not core functions, no equivalent in the reel design):
  click sounds, voice tour button.
- NOT copied from the reel: its Kuala Lumpur restaurants, promo codes
  (FOODIE30/FREESHIP) and the sample McDonald's order — v2 keeps FoodScope's
  own Pakistani seed vendors and real subscription plans. Zaiqa has a
  WhatsApp ordering cart (Cash on Delivery, no commission) but no in-app
  checkout or live rider tracking, so there is no checkout or tracking
  screen — the map view is the vendor location map.
- Backend differences from v1 (only these): port **3011**, database file
  `zaiqa.sqlite`, cookies `zq_session`/`zq_csrf`, service name
  `zaiqa`, and the public vendor response now also carries
  `approved_at`, `subscription_expires_at`, `created_at` (used by the vendor
  timeline). The backend also adds the real-security rebuild on top of FoodScope v1: SMTP email OTP on register and every login, admin-created manager accounts, admin-published subscription plans, listing reports, saved vendors, opening hours with live open-now, halal/certificate badges, and per-vendor payment methods.

## Stack
Node.js 24+, native `node:http` + `node:sqlite` only — no external
dependencies, no `npm install` needed. Port **3011** (override with `PORT`).
SQLite file `zaiqa.sqlite` (WAL mode, foreign keys ON) — git-ignored.
Single-page frontend: `public/index.html` + `public/app.js` + `public/styles.css`.

## Run locally (exact steps)
```bat
cd zaiqa\app
node server.js
```
Or on Windows, double-click `START_ZAIQA_APP.bat`.

Then open **http://localhost:3011**

- Public directory: `#/` (hash routes: `#/`, `#/vendor/:id`, `#/offers`,
  `#/about`, `#/contact`, `#/privacy`, `#/terms`, `#/admin`, plus `#/login`,
  `#/register`, `#/manager`, `#/account`)
- Health check: `http://localhost:3011/api/health`

## Tests
```bat
node test.js
```
Runs the full HTTP end-to-end suite (242 checks) against a fresh temporary
copy of the app on port 3019, so the real `zaiqa.sqlite` is never
touched. A second boot at the end runs in production mode with no SMTP to
prove the fail-closed behaviour (register/login return 503, no code ever
leaks, no unverifiable account is created).

## Accounts — fresh start (no demo logins in code)
No demo accounts are seeded anywhere. The 7 listings (Peshawar, Karachi
Burns Road, Lahore, Islamabad + 2 pending, correctly hidden publicly) seed
**unclaimed** — no manager owns them until the admin assigns them.

- **Portal Admin:** created only from env vars `ADMIN_EMAIL` +
  `ADMIN_PASSWORD` (8+ characters) on boot. Set them in Railway →
  service → Variables. No owner exists without them.
- **Manager:** the Portal Admin creates the account from the Admin panel
  (name + email). A setup code is emailed to the manager's Gmail; they
  activate it on `#/register` (Manager setup form) with their own password.
  A manager sees and edits **only their own vendor** — never another
  manager's. The admin assigns an unclaimed listing to a manager by
  email from the Admin panel (one vendor per manager), or the manager
  submits their own vendor for approval. There is no public manager signup.
- **Customer:** register on the site the same way. A customer only ever
  sees their own saved vendors and reviews.
- **Staff:** created by a manager for their own vendor only; staff can
  only manage menu/availability for that one vendor.

## Real security — email OTP (no on-screen codes on live)
- **Codes go to Gmail, never to the screen.** Verification codes (register)
  and login codes (every login, every role — customer, manager, staff,
  owner) are sent by SMTP to the user's own Gmail. The code is never
  returned in an API response once email is configured.
- **SMTP:** zero-dependency client in `server.js` (`node:tls` to
  `smtp.gmail.com:465`, AUTH LOGIN; if port 465 is unreachable it falls back
  to STARTTLS on 587, and the failure log carries the socket error code,
  e.g. `socket_error:ECONNREFUSED`). Set `SMTP_USER` (Gmail address) +
  `SMTP_PASS` (16-char Gmail app password) in Railway → service →
  Variables. The app password is never written to any file, log, chat or
  API response. Optional: `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `PUBLIC_URL`.
- **Fail-closed:** if email is not configured on a production server,
  register / request-code / login return **503 "Email is not configured"**
  and no unverifiable account is created. If the send itself fails, the
  answer is 503 "could not be sent" — the code is never shown as a fallback.
- **Local dev only:** when no SMTP is configured AND `NODE_ENV` is not
  `production`, the code is returned in the response (`dev_code`) and shown
  on screen, so the app stays testable on a PC with no mailbox.
- **Phone registration** needs SMS, which is not connected — in production
  it is refused honestly ("register with your Gmail instead"). In local dev
  the code shows on screen.
- **Limits:** 5 codes per email per hour; 5 wrong guesses invalidates the
  code (request a new one); login OTP is rate-limited per account (5/hour).
  Codes expire after 15 minutes.
- **Plans are admin-published:** the `plans` table holds every plan
  (seeded Basic 30d/1500, Premium 90d/4500, Featured 90d/9000). Only
  published plans appear in `GET /api/plans` and can be bought; the admin
  creates/edits/publishes plans from the Admin panel. A vendor stays public
  only while its subscription is current.
- **Known limit:** the dev VM's egress proxy blocks direct TLS on ports
  465/587, so SMTP delivery cannot be tested from this machine — verify
  delivery on Railway after setting `SMTP_USER`/`SMTP_PASS` (register a
  fresh customer and check the Gmail inbox).
