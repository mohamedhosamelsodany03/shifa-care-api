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

// --- WhatsApp provider — Meta WhatsApp Cloud API -------------------------
// Sends the OTP as an approved AUTHENTICATION template (copy-code button).
// Docs (checked 2026-11-24): POST
//   https://graph.facebook.com/{apiVersion}/{phone_number_id}/messages
//   Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
// Body:
//   { messaging_product: 'whatsapp', recipient_type: 'individual',
//     to: '<E.164, no +>', type: 'template',
//     template: { name, language: { code },
//       components: [
//         { type: 'body', parameters: [{ type: 'text', text: code }] },
//         { type: 'button', sub_type: 'url', index: '0',
//           parameters: [{ type: 'text', text: code }] } ] } }
// The code goes in twice (body + copy-code button) — that is Meta's format.
// The template body text itself is fixed by Meta; only the code parameter
// is supplied. Template name + language must match the APPROVED template
// in WhatsApp Manager exactly. No new dependencies: built-in fetch only.
// The code is NEVER logged. Only the message id / Meta error is logged.
function toE164WhatsApp(phone0) {
  // normalizePhone() output is 01XXXXXXXXX; WhatsApp wants E.164 w/o '+'.
  const p = normalizePhone(phone0);
  if (!p) return null;
  return '20' + p.slice(1);
}

const WhatsAppOtpProvider = {
  name: 'whatsapp-meta',
  async send({ phone, channel, code }) {
    const cfg = config.whatsapp;
    if (cfg.provider !== 'meta') {
      throw new Error(
        'WhatsApp OTP provider not configured: set WHATSAPP_PROVIDER=meta in production.'
      );
    }
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      throw new Error(
        'WhatsApp OTP not configured: WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required.'
      );
    }
    if (!cfg.templateName) {
      throw new Error('WhatsApp OTP not configured: WHATSAPP_TEMPLATE_NAME is required.');
    }
    const to = toE164WhatsApp(phone);
    if (!to) throw new Error(`Invalid Egyptian phone number for WhatsApp OTP: ${phone}`);
    const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: cfg.templateName,
        language: { code: cfg.templateLang || 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: code }],
          },
        ],
      },
    };
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        res = await globalThis.fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      throw new Error(`WhatsApp OTP send failed (network/timeout): ${e && e.message}`);
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const meta = data && data.error;
      const detail = meta
        ? `Meta error ${meta.code}${meta.error_subcode ? `/${meta.error_subcode}` : ''}: ${meta.message || 'unknown'}`
        : `HTTP ${res.status}`;
      console.error(`[WhatsApp OTP] send failed phone=${phone} ${detail}`);
      throw new Error(`WhatsApp OTP send failed (${detail}).`);
    }
    const messageId = data && data.messages && data.messages[0] && data.messages[0].id;
    console.log(`[WhatsApp OTP] sent phone=${phone} messageId=${messageId || 'unknown'}`);
    return { ok: true, provider: 'whatsapp-meta', messageId: messageId || null };
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
  // Meta WhatsApp provider, when explicitly configured, wins in any env
  // (so it can be tested against the real API from dev/test too).
  if (config.whatsapp.provider === 'meta' && channel === 'whatsapp') {
    return WhatsAppOtpProvider;
  }
  if (config.whatsapp.provider && config.whatsapp.provider !== 'meta') {
    throw new Error(
      `Unsupported WHATSAPP_PROVIDER "${config.whatsapp.provider}" (supported: 'meta').`
    );
  }
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

module.exports = { makeCode, pickProvider, normalizePhone, sha256, MockOtpProvider, WhatsAppOtpProvider, toE164WhatsApp };
