// OTP providers — swappable interface.
//
// Phase 1 ships ONLY MockOtpProvider: it logs the code to the console and
// stores it server-side (hashed). It NEVER pretends a real message was sent.
// Real providers are stubs below, clearly marked TODO, gated by env vars.
//
// Channel order per spec: WhatsApp first, SMS as fallback.
const config = require('./config');
const { sha256 } = require('./store');

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// --- Mock provider (dev only) -------------------------------------------
const MockOtpProvider = {
  name: 'mock',
  async send({ phone, channel, code }) {
    console.log(`[MOCK OTP] channel=${channel} phone=${phone} code=${code} (dev only — no real message sent)`);
    return { ok: true, provider: 'mock', messageId: `mock-${Date.now()}` };
  },
};

// --- WhatsApp provider — TODO --------------------------------------------
// TODO: wire a real WhatsApp provider (Twilio / Meta WhatsApp Business API).
// Required env: WHATSAPP_PROVIDER, WHATSAPP_API_KEY, WHATSAPP_SENDER.
// Until then this throws so a missing provider can never look like a send.
const WhatsAppOtpProvider = {
  name: 'whatsapp',
  async send() {
    throw new Error(
      'WhatsApp OTP provider not configured (TODO). Set WHATSAPP_PROVIDER / WHATSAPP_API_KEY / WHATSAPP_SENDER and implement src/otp.js WhatsAppOtpProvider.'
    );
  },
};

// --- SMS provider — TODO (fallback channel) -------------------------------
const SmsOtpProvider = {
  name: 'sms',
  async send() {
    throw new Error(
      'SMS OTP provider not configured (TODO). Set SMS_PROVIDER / SMS_API_KEY / SMS_SENDER and implement src/otp.js SmsOtpProvider.'
    );
  },
};

function pickProvider(channel) {
  // In production with a real provider configured, WhatsApp first, SMS fallback.
  if (config.isProd) {
    if (channel === 'whatsapp' && config.whatsapp.provider) return WhatsAppOtpProvider;
    if (channel === 'sms' && config.sms.provider) return SmsOtpProvider;
    throw new Error(`OTP channel "${channel}" has no configured provider in production`);
  }
  // Dev: mock provider for both channels.
  return MockOtpProvider;
}

function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.replace(/[\s-]/g, '');
  if (p.startsWith('+20')) p = '0' + p.slice(3);
  if (p.startsWith('0020')) p = '0' + p.slice(4);
  if (!/^01[0-9]{9}$/.test(p)) return null;
  return p;
}

module.exports = { makeCode, pickProvider, normalizePhone, sha256, MockOtpProvider };
