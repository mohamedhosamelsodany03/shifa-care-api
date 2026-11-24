// Focused test for the Meta WhatsApp Cloud API OTP provider (src/otp.js).
// fetch is STUBBED — no real network call, no real Meta credentials.
// Run: node test/test-otp-meta.js
process.env.NODE_ENV = 'test';
process.env.WHATSAPP_PROVIDER = 'meta';
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token-PLACEHOLDER';
process.env.WHATSAPP_PHONE_NUMBER_ID = '999888777';
process.env.WHATSAPP_SENDER = '01222771626';
process.env.WHATSAPP_TEMPLATE_NAME = 'otp_code';
process.env.WHATSAPP_TEMPLATE_LANG = 'en_US';
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_PIN = '123456';

const realFetch = globalThis.fetch;
let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${extra}`); }
}

async function main() {
  const otp = require('../src/otp');

  // --- 1. E.164 normalization -----------------------------------------
  check('01 number -> 20 + rest (no +)', otp.toE164WhatsApp('01008629060') === '201008629060');
  check('sender number normalizes', otp.toE164WhatsApp('01222771626') === '201222771626');
  check('+20 number normalizes', otp.toE164WhatsApp('+201012345678') === '201012345678');
  check('invalid number -> null', otp.toE164WhatsApp('123') === null);

  // --- 2. success path (stubbed fetch) ----------------------------------
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.TEST123' }] }) };
  };
  let r = await otp.WhatsAppOtpProvider.send({ phone: '01012345678', channel: 'whatsapp', code: '123456' });
  check('send returns ok + messageId', r.ok === true && r.messageId === 'wamid.TEST123', JSON.stringify(r));
  check('endpoint is graph.facebook.com v21.0 + phone_number_id',
    captured.url === 'https://graph.facebook.com/v21.0/999888777/messages', captured.url);
  check('Bearer token header set', captured.opts.headers.Authorization === 'Bearer test-token-PLACEHOLDER');
  check('messaging_product whatsapp, recipient individual',
    captured.body.messaging_product === 'whatsapp' && captured.body.recipient_type === 'individual');
  check('to is E.164 without +', captured.body.to === '201012345678', captured.body.to);
  check('type template, name otp_code, lang en_US',
    captured.body.type === 'template' && captured.body.template.name === 'otp_code' && captured.body.template.language.code === 'en_US');
  const bodyComp = captured.body.template.components.find((c) => c.type === 'body');
  check('body param carries the code', bodyComp?.parameters?.[0]?.text === '123456');
  const btnComp = captured.body.template.components.find((c) => c.type === 'button');
  check('button sub_type url, index 0, code repeated',
    btnComp?.sub_type === 'url' && btnComp?.index === '0' && btnComp?.parameters?.[0]?.text === '123456');
  check('pickProvider returns Meta provider when WHATSAPP_PROVIDER=meta',
    otp.pickProvider('whatsapp') === otp.WhatsAppOtpProvider);

  // --- 3. Meta 4xx error path -------------------------------------------
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { code: 190, error_subcode: 460, message: 'Invalid OAuth access token.' } }),
  });
  let threw = null;
  try {
    await otp.WhatsAppOtpProvider.send({ phone: '01012345678', channel: 'whatsapp', code: '123456' });
  } catch (e) { threw = e; }
  check('Meta 400 -> throws naming code 190 + message',
    !!threw && /190/.test(threw.message) && /Invalid OAuth access token/.test(threw.message),
    threw ? threw.message : 'no throw');

  // Template-not-found error path.
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { code: 132000, message: 'Template does not exist.' } }),
  });
  threw = null;
  try {
    await otp.WhatsAppOtpProvider.send({ phone: '01012345678', channel: 'whatsapp', code: '123456' });
  } catch (e) { threw = e; }
  check('Meta template error -> throws naming code 132000',
    !!threw && /132000/.test(threw.message), threw ? threw.message : 'no throw');

  // --- 4. fail-closed: missing token -------------------------------------
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/otp')];
  process.env.WHATSAPP_ACCESS_TOKEN = '';
  const otpNoToken = require('../src/otp');
  threw = null;
  try {
    await otpNoToken.WhatsAppOtpProvider.send({ phone: '01012345678', channel: 'whatsapp', code: '123456' });
  } catch (e) { threw = e; }
  check('missing access token -> throws before any fetch',
    !!threw && /WHATSAPP_ACCESS_TOKEN/.test(threw.message), threw ? threw.message : 'no throw');

  console.log(`\n==== OTP META: ${pass} passed, ${fail} failed ====`);
  if (failures.length) console.log('Failures:', failures.join(' | '));
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch((e) => { console.log('  FAIL uncaught:', e); process.exitCode = 1; })
  .finally(() => { globalThis.fetch = realFetch; });
