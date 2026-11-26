// Environment-driven configuration. No secrets are hard-coded here except
// clearly-labelled DEV defaults that must be overridden in production.
const path = require('path');

function envInt(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

const config = {
  port: envInt('PORT', 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  // JWT secret: MUST be set via env in production. The dev default is
  // deliberately weak and the server logs a warning when it is used.
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-CHANGE-ME-in-production',
  jwtAccessTtl: '15m', // 15 minutes
  refreshTtlDays: 7,
  adminSessionTtl: '30m', // admin PIN session
  dataFile: process.env.DATA_FILE || path.join(__dirname, '..', 'data.json'),
  // Mock OTP is a DEV convenience only. Default ON in dev, OFF in production.
  mockOtp: process.env.MOCK_OTP
    ? process.env.MOCK_OTP === 'true'
    : process.env.NODE_ENV !== 'production',
  // Admin PIN from env; null when unset — the admin login is then DISABLED
  // (fail-closed: the seeded hash is random and unguessable) until a PIN is
  // set and the service restarts. Never fall back to a guessable default.
  adminPin: process.env.ADMIN_PIN || null,
  // Admin PIN lockout is PER-IP: 5 wrong guesses lock that IP for 15 min
  // (HTTP 423); the counter lives in data.json, so a redeploy clears it.
  adminPinMaxAttempts: 5,
  adminPinLockMinutes: 15,
  otpLength: 6,
  otpTtlMinutes: 5,
  otpMaxAttempts: 5,
  otpMaxRequestsPerHour: 5,
  // Payment number — shown ONLY after a booking is confirmed, never in bootstrap.
  paymentNumber: process.env.PAYMENT_NUMBER || '01008629060',
  // FX rates used only to show the EGP equivalent of tourist prices.
  // Override via env; treat as approximate until a live rate source exists.
  usdEgp: envInt('USD_EGP', 48),
  eurEgp: envInt('EUR_EGP', 52),
  corsOrigins: (process.env.CORS_ORIGIN ||
    'http://localhost:3000,http://localhost:5173,http://localhost:8080')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // WhatsApp OTP provider — Meta WhatsApp Cloud API (see src/otp.js).
  // provider: 'meta' (Cloud API) | '' (unset = no real provider).
  // WHATSAPP_API_KEY is kept as a legacy alias for the access token.
  whatsapp: {
    provider: process.env.WHATSAPP_PROVIDER || '', // 'meta'
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_API_KEY || '',
    apiKey: process.env.WHATSAPP_API_KEY || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    sender: process.env.WHATSAPP_SENDER || '01222771626',
    templateName: process.env.WHATSAPP_TEMPLATE_NAME || 'otp_code',
    templateLang: process.env.WHATSAPP_TEMPLATE_LANG || 'en_US',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  },
  sms: {
    // Together SMS (Egypt) — HTTPS GET API, docs at
    // https://sms.masrbokra.com/en/smspro-service-api.html
    // Endpoint: https://togethersms.com/sendsms.php (new; legacy
    // https://sms.masrbokra.com/sendsms.php until 30 Jun 2027).
    // Auth is user + password (NOT an API key) + an approved Sender ID.
    // Provider: 'together' | '' (unset = no real provider).
    // STATUS (owner decision 26 Nov 2026): the owner will NOT pay the
    // sender activation now (~2,451 EGP one-time incl. VAT), so this is
    // CODE-READY but DISABLED until the env vars below are set in
    // Railway. Until then OTP login runs on the mock provider in dev
    // and phone-only login stays the fallback in production.
    provider: process.env.SMS_PROVIDER || '',
    apiKey: process.env.SMS_API_KEY || '', // legacy alias — NOT used by Together
    user: process.env.TOGETHER_SMS_USER || '',
    password: process.env.TOGETHER_SMS_PASSWORD || '',
    sender: process.env.TOGETHER_SMS_SENDER || process.env.SMS_SENDER || '',
    endpoint: process.env.TOGETHER_SMS_ENDPOINT || 'https://togethersms.com/sendsms.php',
  },
  // Firebase Cloud Messaging (push notifications) — HTTP v1 API, no SDK.
  // The service-account JSON is supplied ONLY as an env var in Railway
  // (FIREBASE_SERVICE_ACCOUNT_JSON) or as its three parts below.
  // NEVER commit the JSON or the private key. No Firebase project exists
  // yet (parent agent creates it — it is free); until the env vars are
  // set, push is disabled and notifications stay in-app only.
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    // Private key with literal \n sequences (as pasted in Railway).
    privateKey: process.env.FIREBASE_PRIVATE_KEY || '',
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
  },
  // Postgres persistence (v2.1.0) — DATABASE_URL is the toggle.
  // Unset = the local data.json file store (current behaviour, dev
  // fallback). Set = the whole app document lives in one Postgres row
  // (table shifa_state) and survives redeploys. The Postgres SERVICE
  // itself is created in Railway by the owner (see BUILD-STATUS.md);
  // the code only reads the URL. Enabling it adds ~$5–7/mo of Railway
  // usage (Hobby: bill = max($5, total usage); app + small Postgres
  // ≈ $8.65/mo total) and burns trial credit faster — it is NOT
  // enabled here; the owner enables it by adding DATABASE_URL.
  databaseUrl: process.env.DATABASE_URL || '',
  sweepIntervalMs: envInt('SWEEP_INTERVAL_MS', 5 * 60 * 1000), // 5 min
  autoReleaseAfterMs: envInt('AUTO_RELEASE_MS', 60 * 60 * 1000), // 1 hour after patient confirmation
  // v2.0.1 — complaint window: 24h after service completion (patient
  // confirmation). A refund complaint can only be FILED inside this window;
  // an open complaint pauses final settlement until admin resolves it.
  complaintWindowMs: envInt('COMPLAINT_WINDOW_MS', 24 * 60 * 60 * 1000),
  // v2.0.1 — cancellation window: 15 minutes from BOOKING CREATION
  // (not 15 minutes before the scheduled time). After that the client
  // cannot cancel, and the server rejects the cancellation.
  cancelWindowMs: envInt('CANCEL_WINDOW_MS', 15 * 60 * 1000),
  // v2.1.1 — expanded interview (36 questions, 30 minutes).
  // Pass: total >= 24 AND medical >= 5 AND ethics >= 5 AND safety >= 4,
  // with no red-flag answer. Manual review: total 21–23, or a mandatory
  // minimum missed by exactly 1, or any dimension 0–1.
  interviewMinutes: 30,
  interviewPassTotal: 24,
  interviewPassMedical: 5,
  interviewPassEthics: 5,
  interviewPassSafety: 4,
  interviewManualReviewMin: 21,
  interviewMaxAttempts: 3,
  interviewRetakeDays: 7,
  interviewRedFlagRetakeDays: 14,
  // v2.1.2 — in-app language tests (one per claimed language, MCQ,
  // 8 questions, pass >= 6/8, 15 minutes, retake after 7 days). The
  // general tourist badge needs interview passed + English test passed.
  languageTestMinutes: 15,
  languageTestPassMin: 6,
  languageTestQuestions: 8,
  languageTestRetakeDays: 7,
  // v2.1.1 — Muse monitor token (read-only admin-oversight endpoint).
  // Set ONLY as an env var in the host dashboard; NEVER written to any
  // file, log or commit. Empty = the monitor endpoint looks disabled.
  museMonitorToken: process.env.MUSE_MONITOR_TOKEN || '',
  // v2.1.1 — separate admin JWT secret (falls back to the user JWT
  // secret when unset, so existing deployments keep working).
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'dev-secret-CHANGE-ME-in-production',
  // Promo-month commission override (owner decision 26 Nov 2026): when
  // set (e.g. PROMO_COMMISSION_PCT=0), it OVERRIDES the tier rate for
  // bookings accepted while it is active. Unset = tier rates apply.
  // Range 0–100; out-of-range values are ignored (treated as unset).
  promoCommissionPct: (() => {
    const v = envInt('PROMO_COMMISSION_PCT', null);
    if (v == null || v < 0 || v > 100) {
      if (process.env.PROMO_COMMISSION_PCT) console.warn('[WARN] PROMO_COMMISSION_PCT out of range 0–100 — ignored.');
      return null;
    }
    return v;
  })(),
  // v2.1.3 — monthly packages: waive the +25% overtime premium on the 4
  // extra days during the launch offer month (owner decision 26 Nov 2026).
  // Default OFF. The admin can also toggle it from the admin panel
  // (POST /api/admin/package-offer); the admin setting wins while it is
  // set and unexpired. Env is the fallback / initial value.
  packageOvertimePremiumWaived: process.env.PACKAGE_OVERTIME_WAIVED === 'true',
  // v2.1.6 (C8): a visit cannot be completed less than 10 minutes
  // after acceptance — instant accept→complete cycles are the signature
  // of fake-visit farming. Overridable by MIN_VISIT_MS (tests set 0).
  minVisitMs: envInt('MIN_VISIT_MS', 10 * 60 * 1000),
  // v2.1.6 (C7): a package day with vitals but no patient confirmation
  // becomes releasable after 72h of silence (no dispute). Patient
  // confirmation releases it at once; admin can confirm on the
  // patient's behalf. Overridable by PACKAGE_DAY_AUTO_RELEASE_MS.
  packageDayAutoReleaseMs: envInt('PACKAGE_DAY_AUTO_RELEASE_MS', 72 * 60 * 60 * 1000),
  // v2.0.8 — Terms & Conditions version. Registration and booking
  // creation require acceptedTerms=true AND termsVersion to match this
  // value; bumping it forces every user to re-accept (see /api/me/terms).
  termsVersion: '1.0',
};

// --- derived availability flags (env-only, no secrets) -----------------
// SMS (Together) is configured when provider='together' AND the account
// user + password + approved sender are all set.
config.smsConfigured = function () {
  return config.sms.provider === 'together'
    && !!config.sms.user && !!config.sms.password && !!config.sms.sender;
};
// WhatsApp (Meta) is configured when provider='meta' AND the access
// token + phone number id are both set.
config.whatsappConfigured = function () {
  return config.whatsapp.provider === 'meta'
    && !!config.whatsapp.accessToken && !!config.whatsapp.phoneNumberId;
};
// v2.1.6 (C1 interim): phone-only login is disabled in production when
// ANY real OTP provider is configured (SMS or WhatsApp), not SMS only.
config.anyOtpConfigured = function () {
  return config.smsConfigured() || config.whatsappConfigured();
};
// FCM is configured when a project id + service-account credentials exist.
config.fcmConfigured = function () {
  if (config.firebase.serviceAccountJson) {
    try { const j = JSON.parse(config.firebase.serviceAccountJson); return !!(j.project_id && j.client_email && j.private_key); } catch { return false; }
  }
  return !!(config.firebase.projectId && config.firebase.clientEmail && config.firebase.privateKey);
};
// Postgres is configured when DATABASE_URL is set.
config.postgresConfigured = function () { return !!config.databaseUrl; };

if (!process.env.JWT_SECRET && config.isProd) {
  throw new Error('JWT_SECRET must be set in production');
}
if (!process.env.ADMIN_PIN && config.isProd) {
  // Do NOT throw: the API must be able to boot before the owner picks a PIN.
  // Admin login stays disabled (seeded with a random hash) until ADMIN_PIN
  // is set in the host dashboard and the service restarts.
  console.warn('[WARN] ADMIN_PIN not set in production — admin login is DISABLED until a PIN is set.');
}
if (!process.env.JWT_SECRET) {
  console.warn('[WARN] JWT_SECRET not set — using dev default. DO NOT use in production.');
}
if (!process.env.ADMIN_PIN) {
  console.warn('[WARN] ADMIN_PIN not set — admin login disabled. Set ADMIN_PIN in the host dashboard before launch.');
}

module.exports = config;
