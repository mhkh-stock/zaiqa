# Zaiqa — Pakistani Food-Business Directory (reel design)

Zaiqa is a NEW brand on the complete FoodScope feature set — every function
identical, only the name, identity and design are new. The design comes from the
"Tap. Order. Eat." food-delivery reel by TechZoid I.T. Solutions
(https://www.facebook.com/reel/1370115531864102) — green-gradient header,
mint hero, circular categories, deal cards, fast-delivery rail, restaurant
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
rate limits + audit logging. Test suite: **124/124 pass** (`node test.js`).

## What changed (design only)
- New look: olive/sage-green gradient header with "Deliver to" city picker +
  bell, white search pill, pale-mint hero with scooter art + orange CTA,
  circular category icons, plan deal cards with Claim buttons, "Fast delivery"
  horizontal rail, "Restaurants near you" grid with plan badges, floating
  top-rated card, bottom nav (Home / Search / Offers / Manager / Profile).
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
  own Pakistani seed vendors and real subscription plans. Zaiqa has no
  ordering, cart or live rider tracking, so there is no checkout or tracking
  screen — the map view is the vendor location map.
- Backend differences from v1 (only these): port **3011**, database file
  `zaiqa.sqlite`, cookies `zq_session`/`zq_csrf`, service name
  `zaiqa`, and the public vendor response now also carries
  `approved_at`, `subscription_expires_at`, `created_at` (used by the vendor
  timeline). Everything else is byte-identical to FoodScope's server.js.

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
Runs the full HTTP end-to-end suite (124 checks) against a fresh temporary
copy of the app on port 3019, so the real `zaiqa.sqlite` is never
touched.

## Portal Admin login (demo — CHANGE AFTER FIRST LOGIN)
- Name: **M. Hashir**
- Email: **mhkh3200@gmail.com**
- Role: owner (Portal Admin)

Seeded manager accounts exist for testing (e.g. `chapli.house.peshawar@gmail.com`);
seeded customer accounts exist too. Credentials are set at seed time — change
them after first login. Seeded vendors include approved listings in Peshawar,
Karachi (Burns Road), Lahore and Islamabad, plus two pending listings that
correctly do **not** appear publicly.

## Required manager account (fresh-DB verified)
- Name: **M. Hashir**
- Email: **mhkhan943223@gmail.com**
- Role: manager, verified, with **no vendor yet** — so this account can submit
  a vendor end-to-end (submit → payment → menu → admin approval → public).
  Change its password after first login.

## Verification codes — development mode only
**No real SMTP/SMS delivery is implemented or claimed.** In development mode
(`NODE_ENV` not set to `production`), the 6-digit verification code — and the
manager login OTP — are returned in the API response and shown on screen.
