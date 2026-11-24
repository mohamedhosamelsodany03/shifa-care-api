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
    provider: process.env.SMS_PROVIDER || '',
    apiKey: process.env.SMS_API_KEY || '',
    sender: process.env.SMS_SENDER || '',
  },
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
  interviewMinutes: 20,
  interviewPassTotal: 12,
  interviewPassEthics: 3,
};

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
