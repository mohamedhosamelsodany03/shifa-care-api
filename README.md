# Shifa Care API — Phase 1 Core (El Quseir only)

Home-healthcare backend: escrow bookings, OTP + JWT auth, provider MCQ
interview, admin PIN, hotels, NPWT calculator, insurance reports.
Built from `SPEC-2026-11-24.md`, `ARCHITECTURE.md`, `SECURITY-HARDENING.md`,
the v1.4 MCQ bank, and `HOTELS-QUSEIR.md`.

## Stack

- Node 24, Express, plain npm deps only: `express`, `jsonwebtoken`,
  `bcryptjs`, `cors`, `express-rate-limit`, `helmet`. No native deps.
- Persistence: a single JSON file (`data.json`, created on first start)
  with atomic writes (temp file + rename). No Postgres/SQLite in Phase 1.
- No invented API keys. No real OTP provider is wired yet (see below).

## Run

```bash
cd build/server
npm install
cp .env.example .env   # then set JWT_SECRET and ADMIN_PIN
npm start              # listens on $PORT (default 3000)
```

Dev / test:

```bash
npm test               # node test/smoke.js — starts server on port 3456,
                       # runs 78 assertions against a throwaway data file,
                       # stops the server, deletes the test data
```

Health check: `GET /health`.

## Auth model

- **Phone alone is never accepted.** Every endpoint except `bootstrap`,
  `otp/*`, `auth/refresh`, and `admin/pin/verify` requires a Bearer JWT.
- `POST /api/otp/request {phone, channel:"whatsapp"|"sms"}` — WhatsApp
  first, SMS fallback. OTP is 6 digits, 5 min expiry, max 5 attempts,
  max 5 requests/hour per phone. The code is **never** returned in a
  response.
- `POST /api/otp/verify {phone, code}` → access JWT (15 min) + refresh
  token (7 days, revocable, stored server-side, rotated on refresh).
- `POST /api/auth/refresh`, `POST /api/auth/logout`.
- OTP provider is a swappable interface (`src/otp.js`). **Meta WhatsApp
  Cloud API is implemented** (`WhatsAppOtpProvider`, provider `'meta'`):
  `POST https://graph.facebook.com/v21.0/{phone_number_id}/messages`,
  Bearer token, approved **authentication** template (`otp_code`, `en_US`,
  copy-code button), Egyptian numbers normalized to E.164 (`01…` → `20…`).
  In production with `WHATSAPP_PROVIDER` unset or the token/phone-number-id
  missing, OTP fails closed (`502 otp_provider_error`) — it never pretends
  a code was sent. MockOtpProvider is dev-only. Setup:
  `WHATSAPP-OTP-SETUP.md` in `workspace/shifa-care-rebuild/`.
  **Demo phones** (mock mode only): `01000000001` / `01000000002`,
  mock OTP `123456`, seeded as verified Starter / Pro nurses.

## Endpoints (all under `/api`, all JSON)

| Route | Notes |
|---|---|
| `GET /bootstrap` | Public, minimal: services + prices only. No payment number, no internal settings. |
| `POST /otp/request`, `POST /otp/verify` | See above. |
| `POST /auth/refresh`, `POST /auth/logout` | Refresh rotation + revocation. |
| `POST /bookings` | Requires `respectCharterAccepted=true`. Emergency triage: any danger sign → 422 + ambulance **123**, no booking. Amount = service price + distance fee, computed server-side. |
| `GET /bookings/mine`, `GET /bookings/:id` | Ownership-checked. |
| `POST /bookings/:id/confirm-patient` | Patient side, separate from provider confirmation. |
| `POST /bookings/:id/review` | Rating 1–5 + comment; releases escrow immediately. |
| `POST /bookings/:id/rate-patient` | Provider rates the patient (dual rating). |
| `POST /bookings/:id/safety-report` | `complaint` blocks auto-release until admin review. |
| `POST /bookings/:id/sos` | Active visits only; lands in the admin SOS tab. |
| `POST /bookings/:id/cash-collected` | Provider took cash by hand → app share becomes a debt. |
| `POST /providers/register` | `nationalId`/`licenseNo` stored SHA-256 hashed; only last4 ever returned. |
| `POST /providers/interview/start` | 20 shuffled questions, **no answers**, 20-min server deadline. |
| `POST /providers/interview/submit` | Server-side grading. Pass ≥12/20 **and** ≥3/5 ethics, else `manual-review` + retake allowed. English check: 3 simple questions, reported separately, unscored, no certificate needed. |
| `GET /providers/me`, `GET /providers/radar` | Radar locked until interview passed. |
| `POST /bookings/:id/accept` | Locks commission % at accept time. |
| `POST /bookings/:id/vitals` | BP, pulse, glucose, oxygen, temp — all mandatory before completion. |
| `POST /bookings/:id/complete-provider` | Provider confirms before leaving. |
| `GET /providers/wallet` | Per-booking ledger (app share vs provider share), next-Thursday settlement, cash-collected debt entries. Monthly volume bonus (500/1,000/1,500 EGP at 30/60/100 completed cases) + active promo. |
| `GET /me/vouchers` | Patient loyalty vouchers: 50 EGP after every 4 completed paid visits (60 days, min booking 300 EGP, one per booking), auto-applied at booking. |
| `POST /admin/promo` | Promo months (admin PIN): set/clear the live commission override (0–100%, null clears). Max 2 promo months per calendar year; 0% pauses the cash volume bonus (titles continue). |
| `POST /jobs/sweep` | Admin. Auto-releases patient-confirmed bookings after 1 h with no review/complaint; flags visits open >120 min. Also runs on a 5-min in-process interval. |
| `GET /hotels`, `GET /hotels/:id` | All 30 Quseir hotels. `contracted` only for Mövenpick + Swissôtel (ex Radisson Blu). |
| `POST /tourist-bookings` | USD/EUR pricing, urgent surcharge, hotel distance, language bonus (+$15/€15, only if the assigned provider is certified in that language). |
| `GET /bookings/:id/insurance-report?lang=en\|de` | Stamped electronic report, JSON or `?format=html` printable page. Phase 1 only — tourist submits to insurer; **no direct billing**. |
| `POST /npwt/calculate` | Rental 750/week or 1000/15 d, visit 600, kit 250–350, 5 dressings/14 d; canister separate only when full; written doctor order required. |
| `POST /postop` | Post-operative care plan booking (1,400 EGP + distance). |
| `POST /admin/pin/verify` | bcrypt-hashed PIN (env `ADMIN_PIN` — set a strong 6-digit PIN in the host dashboard; no default is seeded), 5 attempts then 15-min lock, audit-logged, 30-min admin JWT. |
| `GET /admin/providers`, `POST /admin/providers/:id/tier`, `POST /admin/providers/:id/verify` | Tier Starter 15% / Pro 12% / Elite 8% (reversed: the more a provider develops, the lower their commission). |
| `GET /admin/sos`, `GET /admin/audit` | SOS + overdue visits + safety reports; audit log. |
| `GET /admin/mock-otp` | Dev only, gated by `MOCK_OTP=true` (default OFF in production). |

## Escrow state machine

```
held → accepted → provider_confirmed → patient_confirmed → reviewed → released
                                  └→ patient_confirmed ──(1 h, no review, no complaint)──→ auto_released
```

Provider confirm and patient confirm are separate endpoints. A review
releases the held amount at once; otherwise the sweep auto-releases after
exactly 1 hour. Commission: provider keeps the total, the app takes only
its % (Starter 15% / Pro 12% / Elite 8% — reversed), computed server-side.

## Distance fee (El Quseir, server-side)

| Distance | Fee |
|---|---|
| 0–6 km | 0 |
| 6–10 km | +100 EGP |
| 10–20 km | +200 EGP |
| 20–35 km | +350 EGP |
| exactly 35 km | +500 EGP |
| >35 km | special contract only (auto-pricing rejected, 422) |

Client transport: round-trip provided → fee 0; one-way → 50% of the band
fee. Distance is a client-supplied **estimate** in v1 (no real GPS), or
taken from the hotel record when `hotelId` is given.

## Prices (EGP, server-side constants)

standard 250 · dressing 275 · package7 1640 · vip 350 · cannula 250 ·
cannula+iv 350 · shift12 500 · shift24 850 · postop 1400 · gp 500 ·
specialist 900 · video 250 · assistant <2y 165 / 2–4y 205 / 5–9y 235 /
10y+ 260. Tourist: doctor $55/€50 · IV $75/€65 · dressing $35/€30 ·
nurse $30/€25 · urgent +$20/€15.

**The payment number (01008629060) is shown only after a booking is
confirmed (accepted) — never in `/bootstrap` and never on a `held` booking.**

## Security notes

- Helmet (incl. HSTS in production), CORS allowlist only
  (`CORS_ORIGIN`, default localhost), rate limits on OTP / PIN / bookings,
  input validation on every endpoint, audit log for admin + financial
  actions, no secrets in responses, no `/api/admin/pin/set` without the
  current PIN (there is deliberately no PIN-change endpoint in Phase 1 —
  change the PIN via the `ADMIN_PIN` env var and restart).
- `MOCK_OTP` defaults ON in dev, OFF in production. Never enable mock OTP
  in production.

## Deploy (Railway, free tier)

```bash
# Set env vars in the Railway dashboard (see WHATSAPP-OTP-SETUP.md for the
# WhatsApp OTP vars — WHATSAPP_PROVIDER=meta, WHATSAPP_ACCESS_TOKEN,
# WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE_NAME):
#   NODE_ENV=production, MOCK_OTP=false, JWT_SECRET (generated),
#   ADMIN_PIN (set manually — the admin must know it),
#   CORS_ORIGIN=<your frontend origin>
```

Free tier sleeps when idle; the first request after idle can take
~30–60 s to wake. `data.json` lives on the instance disk — for real
production, move the store to persistent disk / a database before launch
(v2.1.0 adds Postgres support behind `DATABASE_URL`; see below).

## v2.1.0 additions

- **Notifications:** FCM push (HTTP v1, no SDK) + in-app notification
  centre (`GET /api/me/notifications`, mark read / read-all) + device
  registration (`POST/DELETE /api/me/devices`, max 5/user). SMS fallback
  only for critical events (booking accepted, provider en route, 1-hour
  review reminder, Thursday settlement) and only when push failed or no
  device is registered. FCM needs a Firebase project (not created yet —
  free; see BUILD-STATUS.md). SMS fallback needs Together SMS
  credentials (owner decision 26 Nov 2026: NOT paying the ~2,451 EGP
  sender activation now; code is ready and disabled behind env vars).
- **Postgres persistence:** set `DATABASE_URL` and the whole app
  document lives in one Postgres row (`shifa_state`, JSONB) and survives
  redeploys; first boot imports `data.json` once. Unset = file store
  (local dev default). Cost: app + small Postgres ≈ $8.65/mo total on
  Railway Hobby; enabling it burns trial credit faster — do NOT set it
  until the owner agrees.
- **SMS OTP login (Together SMS):** `SmsOtpProvider` in `src/otp.js`
  (provider `'together'`, `SMS_PROVIDER=together`). Code-ready, disabled
  until the account is activated. Phone-only login stays the fallback
  when the SMS provider is unconfigured (known weakness: anyone who
  knows a phone number can enter as that account) and is disabled in
  production (410 `phone_login_disabled`) once SMS is configured.
- **NPWT bookings:** `POST /api/npwt/bookings` (doctor order + 4-item
  safety checklist + terms/charter + payment; price from
  `/npwt/calculate` + distance fee; vouchers apply).
- **New services + high-risk tier:** 12 new catalog services; HIGH
  risk = all catheter handling, Ryle insertion, drain removal,
  tracheostomy care, IV infusion therapy, NPWT dressing, cannula+IV
  fluids. High-risk bookings require a doctor's order, only verified
  nurses/doctors may accept, and a 4-item safety checklist is required
  before completion. Prices APPROVED by the owner 26 Nov 2026 (see
  `src/catalog.js`); suture removal (250) also requires a doctor's order.
- **Quseir doctors directory:** admin CRUD (`/api/admin/doctors`),
  provider read (`GET /api/providers/doctors`, phone included),
  patients NEVER see doctors' numbers; refer-a-doctor action on a
  booking (`POST /api/bookings/:id/refer-doctor`, audit-logged).
  Directory is seeded EMPTY — admin adds real doctors with consent.
- **Commissions (v2.0.9, live):** reversed — Starter 15% / Pro 12% /
  Elite 8%, volume bonuses 500/1,000/1,500 EGP at 30/60/100 cases,
  promo months (max 2/year), patient loyalty vouchers (50 EGP after
  every 4 completed paid visits, app-funded).

## What is NOT in Phase 1 (per spec, deferred)

- Hurghada (cities/zones, German/Russian tourist paths, card payments).
- Direct billing with insurers (insurance reports are stamped PDFs/HTML
  for the tourist to submit).
- Real WhatsApp OTP provider (Meta Cloud API, `src/otp.js` — implemented
  but Meta has refused the `otp_code` template 7 times; see
  WHATSAPP-OTP-SETUP.md).
- Shifa Bag, Takaful fund, hotel B2B contracts, advanced NPWT.
- PIN change endpoint (use the env var).
