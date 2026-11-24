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
  // Admin PIN from env; default 123456 is a DEV placeholder — change it.
  adminPin: process.env.ADMIN_PIN || '123456',
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
  // WhatsApp OTP provider (TODO — not implemented, see src/otp.js).
  whatsapp: {
    provider: process.env.WHATSAPP_PROVIDER || '', // e.g. 'twilio' | 'meta'
    apiKey: process.env.WHATSAPP_API_KEY || '',
    sender: process.env.WHATSAPP_SENDER || '',
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
  throw new Error('ADMIN_PIN must be set in production');
}
if (!process.env.JWT_SECRET) {
  console.warn('[WARN] JWT_SECRET not set — using dev default. DO NOT use in production.');
}
if (!process.env.ADMIN_PIN) {
  console.warn('[WARN] ADMIN_PIN not set — using default 123456. Change it before launch.');
}

module.exports = config;
