// SMS text sender — Together SMS (Egypt), HTTPS GET API.
// Docs: https://sms.masrbokra.com/en/smspro-service-api.html
//   Endpoint (new): https://togethersms.com/sendsms.php
//   Legacy endpoint: https://sms.masrbokra.com/sendsms.php (until 30 Jun 2027)
//   Params: user, password, numbers (international digits, no +),
//           sender (approved Sender ID), message (UTF-8), lang (en/ar).
//   Send response (plain text): '1' or '1:<numbers>' = accepted (gateway
//   acceptance, NOT proof of handset delivery); '0' = general rejection;
//   'Invalid login' / 'Missing or Empty Field' / 'Insufficient Balance' /
//   'Invalid Sender' / 'Sender name is not activated' /
//   'Invalid Message Language'. HTTP 200 alone does NOT prove acceptance.
//   An unknown body or a timeout is an UNKNOWN outcome — the caller must
//   investigate before resending (no automatic retries: duplicates).
//
// STATUS (owner decision 26 Nov 2026): the owner will NOT pay the sender
// activation now (2,150 EGP + 14% VAT = 2,451 EGP one-time, + 1,000 free
// SMS after activation; then 0.27 EGP/message, min balance 1,000 units).
// This module is CODE-READY but DISABLED until SMS_PROVIDER=together +
// TOGETHER_SMS_USER + TOGETHER_SMS_PASSWORD + TOGETHER_SMS_SENDER are set
// in the host dashboard. Until then every send throws
// 'SMS provider not configured' and the caller falls back gracefully.
//
// SECURITY: the provider password travels in the request URL. The URL is
// NEVER logged (only phone + gateway result). Credentials come from env
// only — never from a file, a request body, or source control.
const config = require('./config');

function toInternational(phone0) {
  // normalizePhone() output is 01XXXXXXXXX; Together wants international
  // digits without '+' (e.g. 2010xxxxxxxx).
  const p = String(phone0 || '').replace(/[\s-]/g, '');
  if (/^01[0-9]{9}$/.test(p)) return '20' + p.slice(1);
  if (/^20[0-9]{11}$/.test(p)) return p;
  return null;
}

async function sendSmsText({ to, text, lang }) {
  const cfg = config.sms;
  if (cfg.provider !== 'together' || !cfg.user || !cfg.password || !cfg.sender) {
    throw new Error(
      'SMS provider not configured: set SMS_PROVIDER=together, TOGETHER_SMS_USER, TOGETHER_SMS_PASSWORD and TOGETHER_SMS_SENDER in the host dashboard (sender activation ~2,451 EGP one-time).'
    );
  }
  const numbers = toInternational(to);
  if (!numbers) throw new Error(`Invalid Egyptian phone number for SMS: ${to}`);
  const message = String(text || '');
  if (!message) throw new Error('SMS message text required.');
  // Arabic (Unicode) messages: 70 chars/part; English (GSM-7): 160/part.
  // lang 'ar' sends Unicode; 'en' sends GSM-7. Auto-detect Arabic script.
  const useLang = lang || (/[\u0600-\u06FF]/.test(message) ? 'ar' : 'en');
  const q = new URLSearchParams({
    user: cfg.user,
    password: cfg.password,
    numbers,
    sender: cfg.sender,
    message,
    lang: useLang,
  });
  const endpoint = cfg.endpoint || 'https://togethersms.com/sendsms.php';
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      // redirect: 'error' — the docs require no automatic redirects.
      res = await globalThis.fetch(`${endpoint}?${q.toString()}`, { redirect: 'error', signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // Timeout / network failure = UNKNOWN outcome (the gateway may
    // already have accepted it). Never auto-retry; surface as unknown.
    throw new Error(`SMS send outcome unknown (network/timeout): ${e && e.message}`);
  }
  const body = (await res.text()).trim();
  // Accept ONLY the documented acceptance shapes; anything else is a
  // rejection (or unknown) — HTTP 200 alone proves nothing.
  if (res.ok && (/^1$/.test(body) || /^1:[0-9,]+$/.test(body))) {
    console.log(`[Together SMS] accepted phone=${to} lang=${useLang} chars=${message.length}`);
    return { ok: true, provider: 'together-sms', accepted: body };
  }
  console.error(`[Together SMS] rejected phone=${to} http=${res.status} body=${body.slice(0, 120)}`);
  throw new Error(`SMS send rejected by gateway (${body.slice(0, 120) || `HTTP ${res.status}`}).`);
}

module.exports = { sendSmsText, toInternational };
