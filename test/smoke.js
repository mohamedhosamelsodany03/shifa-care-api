// Smoke test — starts the server on a test port with a throwaway data file,
// runs the critical flows, asserts, prints PASS/FAIL, exits.
// Run:  npm test        (or: node test/smoke.js)
// It never touches the real data.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// v2.1.1: correct answers come from the server catalog (the test knows
// the bank, not the API — the API never leaks 'correct' or red flags).
const { MCQ, ENGLISH_CHECK, LANGUAGE_TESTS, LANGUAGE_TEST_TOPICS } = require('../src/catalog');
const LANG_CORRECT = {}; for (const [lang, qs] of Object.entries(LANGUAGE_TESTS)) for (const q of qs) LANG_CORRECT[`${lang}:${q.id}`] = q.correct;
const CORRECT = Object.fromEntries(MCQ.map((q) => [q.id, q.correct]));
const RED_FLAG = Object.fromEntries(MCQ.filter((q) => q.redFlagOption).map((q) => [q.id, q.redFlagOption]));
const EN_CORRECT = Object.fromEntries(ENGLISH_CHECK.map((q) => [q.id, q.correct]));

// Test-only admin PIN: generated fresh on every run (never a fixed value).
// The server seeds NO default PIN, so the admin-login checks below need
// an explicit test PIN passed to the spawned server.
const TEST_ADMIN_PIN = crypto.randomInt(100000, 1000000).toString();

const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_FILE = path.join(__dirname, 'smoke-data.json');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${extra}`); }
}
async function req(method, p, { token, body, admin, origin, monitorToken, xff } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  if (monitorToken) headers['X-Monitor-Token'] = monitorToken;
  // v2.1.8 (§29): the login-phone IP bucket is exhausted by the earlier
  // sections (~23 calls vs 20/15min), so §29 auth tests use a distinct
  // X-Forwarded-For per group (the server trusts 1 proxy hop).
  if (xff) headers['X-Forwarded-For'] = xff;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* html responses */ }
  return { status: r.status, json, text: typeof json === 'string' ? json : '', acao: r.headers.get('access-control-allow-origin') };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// v2.0.8 — registration + every booking creation must accept the current
// Terms & Conditions (acceptedTerms=true, termsVersion='1.0').
const TERMS = { acceptedTerms: true, termsVersion: '1.0' };

async function main() {
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  const env = {
    ...process.env, PORT: String(PORT), NODE_ENV: 'test',
    DATA_FILE, MOCK_OTP: 'true', JWT_SECRET: 'smoke-test-secret', ADMIN_PIN: TEST_ADMIN_PIN,
    MUSE_MONITOR_TOKEN: 'monitor-test-token', // test-only monitor token for §21
    AUTO_RELEASE_MS: '1000', // shorten the 1h auto-release window for the test only
    BOOKING_LIMIT_MAX: '1000', // v2.0.9: volume-bonus cycles make ~200 booking-route calls
    CANCEL_WINDOW_MS: '5000', // shorten the 15-min cancel window for the test only
    MIN_VISIT_MS: '0', // v2.1.6 (C8): disable the 10-min accept->complete floor — the test completes visits in seconds; the floor is tested in §27 with a dedicated flow
    SWEEP_INTERVAL_MS: '3600000', // v2.1.6: the interval sweep never fires during tests — all sweeps are explicit via /api/jobs/sweep
    // v2.1.7 (§28): the spawned server announces an update, so the
    // bootstrap latestApp shape is exercised (defaults are checked
    // in-process with a fresh config require instead).
    LATEST_APP_CODE: '22',
    LATEST_APP_VERSION: '2.1.8',
    LATEST_APP_APK_URL: 'https://example.com/shifa-care-v2.1.8.apk',
    LATEST_APP_FORCE: 'true',
  };
  const child = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const stop = () => { try { child.kill('SIGTERM'); } catch {} };

  try {
    // wait for server
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(BASE + '/health'); if (r.ok) { up = true; break; } } catch {}
      await sleep(250);
    }
    check('server starts and /health is ok', up);
    if (!up) { console.log(out); process.exitCode = 1; stop(); return; }
    // v2.1.1: admin login FIRST — OTP codes are never logged (audit #15),
    // so tests read them from the admin-only mock-otp endpoint.
    let adminToken = null;
    {
      const ar = await req('POST', '/api/admin/pin/verify', { body: { pin: TEST_ADMIN_PIN } });
      check('admin PIN verify early (for mock-otp reads)', ar.status === 200 && !!ar.json?.token, JSON.stringify(ar.json));
      adminToken = ar.json?.token;
    }
    // Mock-OTP code reader (admin-only, mock mode only).
    async function mockCode(phone) {
      const cr = await req('GET', `/api/admin/mock-otp?phone=${phone}`, { token: adminToken });
      return cr.json?.code || null;
    }
    // Register a fresh provider + return a provider-role token.
    async function registerProvider(phone, role, extra = {}) {
      await req('POST', '/api/otp/request', { body: { phone, channel: 'whatsapp' } });
      const code = await mockCode(phone);
      const v = await req('POST', '/api/otp/verify', { body: { phone, code } });
      const tok = v.json?.accessToken;
      const reg = await req('POST', '/api/providers/register', { token: tok, body: { ...TERMS,
        name: `Test ${role}`, providerType: role, role, nationalId: '12345678901234', licenseNo: 'LIC-TEST1',
        certificates: extra.certificates || [],
      } });
      const login = await req('POST', '/api/auth/login-phone', { body: { phone, role: 'provider' } });
      // v2.1.2: the run makes ~23 login-phone calls against the 20/15min
      // IP limiter, so a late registration's re-login can 429 — fall
      // back to the registration response for the id (the OTP token
      // still works for the admin-side checks that only need the id).
      return { token: login.json?.accessToken || tok, providerId: login.json?.providerId || reg.json?.id, reg, regStatus: reg.status };
    }
    // Answer an interview attempt in a given mode.
    async function answerInterview(token, mode) {
      const st = await req('POST', '/api/providers/interview/start', { token });
      if (st.status !== 200) return { start: st, submit: null };
      const answers = {};
      for (const q of st.json.questions) {
        if (mode === 'all-correct') answers[q.id] = CORRECT[q.id];
        else if (mode === 'all-wrong') answers[q.id] = 'zzz';
        else if (mode === 'ethics-wrong') answers[q.id] = q.category === 'ethics' ? 'zzz' : CORRECT[q.id];
        else if (mode === 'manual-review') answers[q.id] = ['communication', 'resilience', 'conduct'].includes(q.category) ? 'zzz' : CORRECT[q.id];
        else if (mode === 'red-flag') answers[q.id] = q.id === 'm1' ? RED_FLAG[q.id] : CORRECT[q.id];
      }
      const enAnswers = {};
      for (const q of st.json.englishCheck.questions) enAnswers[q.id] = EN_CORRECT[q.id];
      const sub = await req('POST', '/api/providers/interview/submit', { token, body: { attemptId: st.json.attemptId, answers, englishAnswers: enAnswers } });
      return { start: st, submit: sub };
    }
    // v2.1.2 — answer a language test in a given mode (the TEST knows
    // the bank, not the API — the API never leaks keys). v2.1.6 (C5):
    // answers are POSITIONS (0-3) into the published options, computed
    // by matching the correct option TEXT — never a key letter.
    async function answerLanguageTest(token, lang, mode) {
      const st = await req('POST', `/api/me/language-tests/${lang}/start`, { token });
      if (st.status !== 200) return { start: st, submit: null };
      const answers = {};
      for (const q of st.json.questions) {
        const bankQ = LANGUAGE_TESTS[lang].find((x) => x.id === q.id);
        const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
        const correctIdx = q.options.findIndex((o) => o.text === correctText);
        answers[q.id] = mode === 'all-correct' ? correctIdx : (correctIdx + 1) % q.options.length;
      }
      const sub = await req('POST', `/api/me/language-tests/${lang}/submit`, { token, body: { attemptId: st.json.attemptId, answers } });
      return { start: st, submit: sub };
    }
    // v2.1.2 fixtures: tiny valid receipt / document data URLs.
    const RECEIPT_JPEG = 'data:image/jpeg;base64,' + Buffer.from('fake-receipt-jpeg-bytes').toString('base64');
    const DOC_PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-fake').toString('base64');
    const DOC_TEXT = 'data:text/plain;base64,' + Buffer.from('not-allowed').toString('base64');

    // --- 1. bootstrap is public, minimal -------------------------------
    console.log('\n[bootstrap]');
    let r = await req('GET', '/api/bootstrap');
    check('bootstrap 200', r.status === 200, JSON.stringify(r.json));
    check('bootstrap has services + prices', Array.isArray(r.json?.services) && r.json.services.length >= 12);
    check('bootstrap has NO payment number', JSON.stringify(r.json).indexOf('01008629060') === -1);
    check('bootstrap standard price is 250', r.json.services.find((s) => s.code === 'standard')?.price_egp === 250);
    check('bootstrap dressing price is 275', r.json.services.find((s) => s.code === 'dressing')?.price_egp === 275);

    // --- 2. phone-only access fails ------------------------------------
    console.log('\n[phone-only auth]');
    r = await req('GET', '/api/bookings/mine');
    check('no token -> 401', r.status === 401);
    r = await req('POST', '/api/bookings', { body: { phone: '01012345678', serviceCode: 'standard' } });
    check('phone in body, no token -> 401', r.status === 401);
    r = await req('GET', '/api/hotels', { token: 'Bearer bogus.token.here' });
    check('bogus token -> 401', r.status === 401);

    // --- 3. OTP flow ----------------------------------------------------
    console.log('\n[otp]');
    const patientPhone = '01012345678';
    r = await req('POST', '/api/otp/request', { body: { phone: patientPhone, channel: 'whatsapp' } });
    check('otp request 200', r.status === 200, JSON.stringify(r.json));
    check('otp response never contains the code', !/^\d{6}$/.test(JSON.stringify(r.json)) || JSON.stringify(r.json).indexOf('123456') === -1);
    r = await req('POST', '/api/otp/verify', { body: { phone: patientPhone, code: '000000' } });
    check('wrong OTP -> 401', r.status === 401);
    // v2.1.1: the code is NEVER logged — read it from the admin-only
    // mock-otp endpoint (mock mode only).
    const code = await mockCode(patientPhone);
    check('mock OTP code readable via admin mock-otp endpoint', !!code && /^\d{6}$/.test(code));
    r = await req('POST', '/api/otp/verify', { body: { phone: patientPhone, code } });
    check('correct OTP -> 200 with access+refresh', r.status === 200 && !!r.json?.accessToken && !!r.json?.refreshToken, JSON.stringify(r.json));
    const patientToken = r.json?.accessToken;
    const refreshToken = r.json?.refreshToken;
    r = await req('POST', '/api/auth/refresh', { body: { refreshToken } });
    check('refresh token rotates to new access token', r.status === 200 && !!r.json?.accessToken, JSON.stringify(r.json));
    const patientToken2 = r.json?.accessToken;

    // --- 3b. phone-only login fallback (owner-authorized 24 Nov 2026:
    // Meta WhatsApp OTP blocked) --------------------------------------
    console.log('\n[phone-only login fallback]');
    r = await req('POST', '/api/auth/login-phone', { body: { phone: '01000000001', role: 'provider' } });
    check('phone login demo provider -> 200 provider + token alias', r.status === 200 && r.json?.role === 'provider' && typeof r.json?.token === 'string' && r.json?.providerId === 'prov_demo_starter', JSON.stringify(r.json));
    const phoneProvToken = r.json?.accessToken;
    r = await req('GET', '/api/providers/me', { token: phoneProvToken });
    check('phone-login provider token opens /providers/me', r.status === 200 && r.json?.phone === '01000000001', JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { body: { phone: '01012345678', role: 'provider' } });
    check('unknown provider phone with role=provider -> 403', r.status === 403, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { body: { phone: '01077777777' } });
    check('new patient phone -> 200 patient + token', r.status === 200 && r.json?.role === 'patient' && !!r.json?.accessToken, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { body: { phone: '123' } });
    check('invalid phone -> 400', r.status === 400, JSON.stringify(r.json));
    // per-phone rate limit: same 5/hour cap as OTP requests
    const rlPhone = '01088888888';
    let rlStatuses = [];
    for (let i = 0; i < 6; i++) {
      const rr = await req('POST', '/api/auth/login-phone', { body: { phone: rlPhone } });
      rlStatuses.push(rr.status);
    }
    check('phone login rate limit: 5 ok then 429', rlStatuses.slice(0, 5).every((s) => s === 200) && rlStatuses[5] === 429, JSON.stringify(rlStatuses));

    // --- 4. triage + charter -------------------------------------------
    console.log('\n[triage + charter]');
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 3, respectCharterAccepted: true, triage: { dangerSigns: ['chest_pain'] },
    } });
    check('danger sign -> 422 + ambulance 123', r.status === 422 && r.json?.ambulance === '123', JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt', distanceKm: 3,
    } });
    check('missing respect charter -> 400', r.status === 400, JSON.stringify(r.json));

    // --- 5. distance fee table (via booking totals) ---------------------
    console.log('\n[distance fees]');
    async function bookAt(km, extra = {}) {
      const rr = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
        patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
        distanceKm: km, respectCharterAccepted: true, triage: { dangerSigns: [] }, ...extra,
      } });
      return rr;
    }
    const feeCases = [
      [3, 250], [6, 250], [7, 350], [10, 350], [15, 450], [20, 450], [30, 600], [35, 750],
    ];
    for (const [km, expected] of feeCases) {
      const rr = await bookAt(km);
      check(`distance ${km}km -> total ${expected} EGP`, rr.status === 201 && rr.json?.amountEgp === expected, JSON.stringify(rr.json));
    }
    let rr = await bookAt(40);
    check('distance 40km -> 422 contract_required', rr.status === 422 && rr.json?.error === 'contract_required', JSON.stringify(rr.json));
    rr = await bookAt(30, { transport: 'roundtrip' });
    check('roundtrip transport -> fee 0 (total 250)', rr.status === 201 && rr.json?.amountEgp === 250, JSON.stringify(rr.json));
    rr = await bookAt(30, { transport: 'oneway' });
    check('one-way transport -> 50% fee (total 425)', rr.status === 201 && rr.json?.amountEgp === 425, JSON.stringify(rr.json));
    // payment number must NOT appear before confirmation
    check('unconfirmed booking hides payment number', JSON.stringify(rr.json).indexOf('01008629060') === -1);

    // --- 6. demo provider OTP + interview (v2.1.1: 36 questions) -------
    console.log('\n[provider interview]');
    r = await req('POST', '/api/otp/request', { body: { phone: '01000000001', channel: 'whatsapp' } });
    check('demo provider otp request 200', r.status === 200);
    r = await req('POST', '/api/otp/verify', { body: { phone: '01000000001', code: '123456' } });
    check('demo provider mock OTP 123456 works', r.status === 200 && r.json?.role === 'provider', JSON.stringify(r.json));
    const prov1Token = r.json?.accessToken;
    // Demo providers seed PENDING / not_started (audit #8) — the interview
    // is what moves them forward.
    r = await req('GET', '/api/providers/me', { token: prov1Token });
    check('demo provider seeds pending + interview not_started', r.status === 200 && r.json?.status === 'pending' && r.json?.interviewStatus === 'not_started', JSON.stringify(r.json));
    r = await req('POST', '/api/providers/interview/start', { token: prov1Token });
    check('interview start 200, 36 questions, 30 min, no answers/red-flags leaked', r.status === 200 && r.json?.questions?.length === 36 && r.json?.minutes === 30 && r.json?.totalQuestions === 36 && JSON.stringify(r.json).indexOf('"correct"') === -1 && JSON.stringify(r.json).indexOf('redFlag') === -1, `got ${r.json?.questions?.length}`);
    check('interview distribution medical 8 / ethics 7 / safety 6 / comm 6 / resilience 5 / conduct 4',
      ['medical', 'ethics', 'safety', 'communication', 'resilience', 'conduct'].every((c) => r.json.questions.filter((q) => q.category === c).length === { medical: 8, ethics: 7, safety: 6, communication: 6, resilience: 5, conduct: 4 }[c]));
    check('interview dimensions carry minima (medical 5, ethics 5, safety 4)', Array.isArray(r.json?.dimensions) && r.json.dimensions.find((d) => d.key === 'medical')?.min === 5 && r.json.dimensions.find((d) => d.key === 'ethics')?.min === 5 && r.json.dimensions.find((d) => d.key === 'safety')?.min === 4);
    check('english check present, 3 questions', r.json?.englishCheck?.questions?.length === 3);
    // All-wrong -> FAILED (total 0 < 21), retake blocked for 7 days.
    const wrong = {};
    for (const q of r.json.questions) wrong[q.id] = 'zzz';
    const enWrong = {};
    for (const q of r.json.englishCheck.questions) enWrong[q.id] = 'zzz';
    const attemptId = r.json?.attemptId;
    r = await req('POST', '/api/providers/interview/submit', { token: prov1Token, body: { attemptId, answers: wrong, englishAnswers: enWrong } });
    check('all-wrong interview -> failed, total 0, 7-day cooldown', r.status === 200 && r.json?.status === 'failed' && r.json?.total === 0 && !!r.json?.canRetakeAt && r.json?.attemptsLeft === 2, JSON.stringify(r.json));
    check('english reported separately, unscored', r.json?.english?.total === 3 && r.json?.english?.correct === 0);
    r = await req('POST', '/api/providers/interview/start', { token: prov1Token });
    check('retake during 7-day cooldown -> 409 retake_blocked', r.status === 409 && r.json?.error === 'retake_blocked' && !!r.json?.canRetakeAt, JSON.stringify(r.json));
    // Demo provider 2: all-correct -> passed 36/36, interview points 20.
    r = await req('POST', '/api/otp/request', { body: { phone: '01000000002', channel: 'whatsapp' } });
    r = await req('POST', '/api/otp/verify', { body: { phone: '01000000002', code: '123456' } });
    const provToken = r.json?.accessToken;
    const passed = await answerInterview(provToken, 'all-correct');
    check('all-correct interview -> passed 36/36, medical 8 ethics 7 safety 6', passed.submit?.status === 200 && passed.submit?.json?.status === 'passed' && passed.submit?.json?.total === 36 && passed.submit?.json?.scores?.medical === 8 && passed.submit?.json?.scores?.ethics === 7 && passed.submit?.json?.scores?.safety === 6, JSON.stringify(passed.submit?.json));
    check('english 3/3 basic-ok', passed.submit?.json?.english?.correct === 3 && passed.submit?.json?.english?.level === 'basic-ok');
    r = await req('GET', '/api/providers/me', { token: provToken });
    check('interview points 20 on the provider record (36/36)', r.json?.points?.interview === 20 && r.json?.interviewStatus === 'passed', JSON.stringify(r.json?.points));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/verify', { token: adminToken, body: { role: 'nurse' } });
    check('admin verifies demo provider 2 (role nurse) -> verified', r.status === 200 && r.json?.status === 'verified' && r.json?.role === 'nurse', JSON.stringify(r.json));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Starter' } });
    check('admin sets main provider tier Starter', r.status === 200 && r.json?.tier === 'Starter', JSON.stringify(r.json));
    // Ethics-fail: 29/36 but ethics 0/7 -> FAILED (mandatory minimum).
    const ethicsProv = await registerProvider('01014141414', 'nurse');
    check('ethics-fail provider registered', ethicsProv.regStatus === 201, JSON.stringify(ethicsProv.reg));
    const ethicsFail = await answerInterview(ethicsProv.token, 'ethics-wrong');
    check('29/36 but ethics 0/7 -> failed (mandatory minimum)', ethicsFail.submit?.status === 200 && ethicsFail.submit?.json?.status === 'failed' && ethicsFail.submit?.json?.total === 29 && ethicsFail.submit?.json?.scores?.ethics === 0, JSON.stringify(ethicsFail.submit?.json));
    // Manual review: 21/36 (non-mandatory dims wrong) -> admin pass.
    const manualProv = await registerProvider('01015151515', 'nurse');
    check('manual-review provider registered', manualProv.regStatus === 201, JSON.stringify(manualProv.reg));
    const manual = await answerInterview(manualProv.token, 'manual-review');
    check('21/36 -> manual-review', manual.submit?.status === 200 && manual.submit?.json?.status === 'manual-review' && manual.submit?.json?.total === 21, JSON.stringify(manual.submit?.json));
    r = await req('POST', `/api/admin/providers/${manualProv.providerId}/interview`, { token: adminToken, body: { decision: 'pass' } });
    check('admin passes manual-review interview -> passed, points 10', r.status === 200 && r.json?.interviewStatus === 'passed' && r.json?.points?.interview === 10, JSON.stringify(r.json));
    // Red flag: correct everywhere except the unconscious-patient question
    // (treat at home instead of calling 123) -> instant 'red-flag' fail.
    const redProv = await registerProvider('01016161616', 'nurse');
    check('red-flag provider registered', redProv.regStatus === 201, JSON.stringify(redProv.reg));
    const red = await answerInterview(redProv.token, 'red-flag');
    check('red-flag answer -> instant red-flag fail at 35/36', red.submit?.status === 200 && red.submit?.json?.status === 'red-flag' && red.submit?.json?.redFlag === true && red.submit?.json?.total === 35 && !!red.submit?.json?.canRetakeAt, JSON.stringify(red.submit?.json));
    r = await req('POST', '/api/providers/interview/start', { token: redProv.token });
    check('red-flag retake needs admin approval -> 409', r.status === 409 && r.json?.error === 'retake_blocked', JSON.stringify(r.json));
    r = await req('POST', `/api/admin/providers/${redProv.providerId}/interview`, { token: adminToken, body: { decision: 'allow-retake' } });
    check('admin allow-retake clears the gate -> 200', r.status === 200, JSON.stringify(r.json));
    r = await req('POST', '/api/providers/interview/start', { token: redProv.token });
    check('retake allowed after admin approval -> 200', r.status === 200 && !!r.json?.attemptId, JSON.stringify(r.json));

    // --- 7. full escrow flow -------------------------------------------
    console.log('\n[escrow end-to-end]');
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Test Patient', serviceCode: 'dressing', paymentMethod: 'instapay',
      distanceKm: 8, respectCharterAccepted: true, triage: { dangerSigns: [] },
      receiptImage: RECEIPT_JPEG, // v2.1.6 (C6): online payment requires a receipt at creation
    } });
    check('booking created held, total 275+100=375', r.status === 201 && r.json?.status === 'held' && r.json?.amountEgp === 375, JSON.stringify(r.json));
    const bkId = r.json?.id;
    // v2.1.6 (C6): the receipt must be approved before the provider can accept.
    r = await req('POST', `/api/admin/bookings/${bkId}/receipt/approve`, { token: adminToken, body: {} });
    check('escrow booking receipt approved before accept', r.status === 200 && r.json?.receipt?.status === 'approved', JSON.stringify(r.json)?.slice(0, 200));
    // Provider 1 failed interview -> cannot accept (radar/accept locked).
    r = await req('POST', `/api/bookings/${bkId}/accept`, { token: prov1Token });
    check('interview-failed provider cannot accept -> 403', r.status === 403, JSON.stringify(r.json));
    // Provider 1 (passed) accepts.
    r = await req('POST', `/api/bookings/${bkId}/accept`, { token: provToken });
    check('provider accepts -> accepted, payment number now shown', r.status === 200 && r.json?.status === 'accepted' && JSON.stringify(r.json).indexOf('01008629060') !== -1, JSON.stringify(r.json));
    check('commission locked at accept (Starter 15% — reversed rates, v2.0.9)', r.json?.commissionPct === 15);
    // Another patient cannot see it.
    const other = await req('POST', '/api/otp/request', { body: { phone: '01099999999', channel: 'sms' } });
    const mm = await mockCode('01099999999');
    const otherLogin = await req('POST', '/api/otp/verify', { body: { phone: '01099999999', code: mm || '000000' } });
    const otherToken = otherLogin.json?.accessToken;
    r = await req('GET', `/api/bookings/${bkId}`, { token: otherToken });
    check('other patient cannot view booking -> 403', r.status === 403, JSON.stringify(r.json));
    // Provider cannot complete before vitals.
    r = await req('POST', `/api/bookings/${bkId}/complete-provider`, { token: provToken });
    check('complete without vitals -> 409', r.status === 409, JSON.stringify(r.json));
    // Vitals: incomplete -> 400, complete -> 200.
    r = await req('POST', `/api/bookings/${bkId}/vitals`, { token: provToken, body: { bpSystolic: 120, pulse: 80 } });
    check('incomplete vitals -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkId}/vitals`, { token: provToken, body: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, glucose: 110, oxygen: 98, temp: 36.6 } });
    check('full vitals recorded', r.status === 200 && !!r.json?.vitals, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkId}/complete-provider`, { token: provToken });
    check('provider confirms -> provider_confirmed', r.status === 200 && r.json?.status === 'provider_confirmed', JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkId}/review`, { token: patientToken2, body: { rating: 5, comment: 'Great' } });
    check('review before patient confirm -> 409', r.status === 409, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkId}/confirm-patient`, { token: patientToken2 });
    check('patient confirms -> patient_confirmed', r.status === 200 && r.json?.status === 'patient_confirmed', JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkId}/review`, { token: patientToken2, body: { rating: 5, comment: 'Great, professional nurse.' } });
    check('review -> released, app 15% of 375 = 56, provider 319', r.status === 200 && r.json?.status === 'released' && r.json?.appShareEgp === 56 && r.json?.providerShareEgp === 319, JSON.stringify(r.json));
    // Wallet ledger reflects it.
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    const entry = r.json?.ledger?.find((l) => l.bookingId === bkId);
    // v2.0.1: released but inside the 24h complaint window -> held, not settleable yet.
    check('wallet ledger: released amount held for complaint window (319)', r.status === 200 && entry?.direction === 'complaint_hold' && entry?.amountEgp === 319 && r.json?.totals?.complaintHoldEgp === 319, JSON.stringify(r.json?.totals));
    check('wallet has next Thursday settlement', !!r.json?.nextSettlementThursday);
    // Cash-collected creates a debt entry.
    r = await req('POST', `/api/bookings/${bkId}/cash-collected`, { token: provToken });
    check('cash-collected marks booking', r.status === 200 && r.json?.cashCollectedByProvider === true, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    const entry2 = r.json?.ledger?.find((l) => l.bookingId === bkId);
    check('wallet after cash: app share held for complaint window (56)', entry2?.direction === 'complaint_hold' && entry2?.amountEgp === 56, JSON.stringify(entry2));

    // --- 8. auto-release sweep ------------------------------------------
    console.log('\n[auto-release]');
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bk2 = r.json?.id;
    await req('POST', `/api/bookings/${bk2}/accept`, { token: provToken });
    await req('POST', `/api/bookings/${bk2}/vitals`, { token: provToken, body: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, glucose: 110, oxygen: 98, temp: 36.6 } });
    await req('POST', `/api/bookings/${bk2}/complete-provider`, { token: provToken });
    await req('POST', `/api/bookings/${bk2}/confirm-patient`, { token: patientToken2 });
    // Auto-release window is 1000 ms in this test (AUTO_RELEASE_MS env).
    await sleep(1500);
    // Admin token was obtained at startup (mock-otp reads need it); refresh it here.
    r = await req('POST', '/api/admin/pin/verify', { body: { pin: TEST_ADMIN_PIN } });
    check('admin PIN verify 200', r.status === 200 && !!r.json?.token, JSON.stringify(r.json));
    adminToken = r.json?.token;
    r = await req('POST', '/api/jobs/sweep', { token: adminToken });
    check('sweep auto-releases 1h-old patient-confirmed booking', r.status === 200 && (r.json?.released || []).includes(bk2), JSON.stringify(r.json));
    r = await req('GET', `/api/bookings/${bk2}`, { token: patientToken2 });
    check('booking now auto_released', r.json?.status === 'auto_released', JSON.stringify(r.json));

    // --- 9. hotels -------------------------------------------------------
    console.log('\n[hotels]');
    r = await req('GET', '/api/hotels', { token: patientToken2 });
    check('30 hotels listed', r.status === 200 && r.json?.count === 30, `count=${r.json?.count}`);
    const mov = r.json?.hotels?.find((h) => h.name_en.includes('Mövenpick'));
    const swiss = r.json?.hotels?.find((h) => h.name_en.includes('Swissôtel'));
    check('Mövenpick contracted', mov?.contract_status === 'contracted' && mov?.distance_km === 6);
    check('Swissôtel contracted (ex Radisson)', swiss?.contract_status === 'contracted');
    check('other hotels listed, not contracted', r.json.hotels.filter((h) => h.contract_status === 'contracted').length === 2);
    r = await req('GET', '/api/hotels/h10', { token: patientToken2 });
    check('hotel by id h10 = Mövenpick', r.status === 200 && r.json?.name_en.includes('Mövenpick'));

    // --- 10. tourist booking + insurance report -------------------------
    console.log('\n[tourist]');
    r = await req('POST', '/api/tourist-bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Tourist Test', serviceCode: 'tourist_doctor', currency: 'usd', hotelId: 'h10',
      urgent: false, paymentMethod: 'cash_receipt', respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('tourist doctor booking $55 at Mövenpick (6km, no fee)', r.status === 201 && r.json?.amountForeign === 55 && r.json?.currency === 'USD', JSON.stringify(r.json));
    const tbId = r.json?.id;
    r = await req('GET', `/api/bookings/${tbId}/insurance-report?lang=de`, { token: patientToken2 });
    check('insurance report DE has stamp + invoice', r.status === 200 && !!r.json?.stamp && !!r.json?.invoice && r.json?.language === 'de', JSON.stringify(r.json)?.slice(0, 300));
    check('insurance report says no direct billing', JSON.stringify(r.json).indexOf('No direct billing') !== -1 || JSON.stringify(r.json).indexOf('Keine Direktabrechnung') !== -1);

    // --- 11. NPWT + post-op ---------------------------------------------
    console.log('\n[npwt + postop]');
    r = await req('POST', '/api/npwt/calculate', { token: patientToken2, body: { days: 14, kitPrice: 300 } });
    check('NPWT 14d: 5 dressings, total 5500', r.status === 200 && r.json?.dressings === 5 && r.json?.totalEgp === 5500, JSON.stringify(r.json));
    check('NPWT requires doctor order', r.json?.requiresDoctorOrder === true && !!r.json?.warning);
    r = await req('POST', '/api/postop', { token: patientToken2, body: { ...TERMS,
      patientName: 'Test Patient', surgeryType: 'Appendectomy', paymentMethod: 'instapay',
      distanceKm: 3, respectCharterAccepted: true,
      receiptImage: RECEIPT_JPEG, // v2.1.6 (C6): online payment requires a receipt at creation
    } });
    check('post-op booking 1400', r.status === 201 && r.json?.amountEgp === 1400 && r.json?.kind === 'postop', JSON.stringify(r.json));

    // --- 12. provider registration hashing -------------------------------
    console.log('\n[provider register]');
    const newPhone = '01055555555';
    await req('POST', '/api/otp/request', { body: { phone: newPhone, channel: 'whatsapp' } });
    const nm = await mockCode(newPhone);
    const nl = await req('POST', '/api/otp/verify', { body: { phone: newPhone, code: nm || '000000' } });
    const newToken = nl.json?.accessToken;
    r = await req('POST', '/api/providers/register', { token: newToken, body: { ...TERMS,
      name: 'New Nurse', role: 'nurse', nationalId: '12345678901234', licenseNo: 'LIC-98765',
      certificates: ['BLS'], extraLanguages: [{ language: 'de', certified: true }],
    } });
    check('provider registered, nationalId/license never returned full', r.status === 201 && r.json?.nationalIdLast4 === '1234' && !JSON.stringify(r.json).includes('12345678901234') && !JSON.stringify(r.json).includes('LIC-98765'), JSON.stringify(r.json));
    check('new provider starts Starter', r.json?.tier === 'Starter');

    // --- 13. admin PIN lockout -------------------------------------------
    console.log('\n[admin pin lockout]');
    for (let i = 0; i < 5; i++) {
      r = await req('POST', '/api/admin/pin/verify', { body: { pin: '000000' } });
    }
    check('5 wrong PINs -> 401 then locked (423 or 401)', r.status === 401 || r.status === 423, `status=${r.status}`);
    r = await req('POST', '/api/admin/pin/verify', { body: { pin: TEST_ADMIN_PIN } });
    check('correct PIN while locked -> 423 locked', r.status === 423, JSON.stringify(r.json));
    // Admin endpoints still work with the earlier token.
    r = await req('GET', '/api/admin/audit', { token: adminToken });
    check('admin audit log readable', r.status === 200 && Array.isArray(r.json) && r.json.length > 5, `len=${r.json?.length}`);
    r = await req('GET', '/api/admin/mock-otp', { token: adminToken });
    check('mock-otp endpoint lists demo phones (dev only)', r.status === 200 && r.json?.mockOtp === true, JSON.stringify(r.json)?.slice(0, 200));

    // --- 15. v2.0.1: 15-min cancellation + 24h complaint window ---------
    console.log('\n[cancel + complaint]');
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkC = r.json?.id;
    check('cancel test booking shows canCancel + cancelDeadline', r.status === 201 && r.json?.canCancel === true && !!r.json?.cancelDeadline, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkC}/accept`, { token: provToken });
    check('cancel test booking accepted', r.status === 200 && r.json?.status === 'accepted');
    r = await req('POST', `/api/bookings/${bkC}/cancel`, { token: patientToken2 });
    check('cancel within window -> cancelled, full refund 250', r.status === 200 && r.json?.status === 'cancelled' && r.json?.refundEgp === 250, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkC}/cancel`, { token: patientToken2 });
    check('cancel again -> 409', r.status === 409, JSON.stringify(r.json));
    r = await req('GET', `/api/providers/wallet`, { token: provToken });
    const cancelEntry = r.json?.ledger?.find((l) => l.bookingId === bkC);
    check('cancelled booking excluded from settlement', cancelEntry?.direction === 'cancelled' && cancelEntry?.amountEgp === 0, JSON.stringify(cancelEntry));
    // Too late: create, wait out the 5s test window, cancel must be refused.
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkLate = r.json?.id;
    await sleep(6000);
    r = await req('POST', `/api/bookings/${bkLate}/cancel`, { token: patientToken2 });
    check('cancel after window -> 409 cancel_window_closed', r.status === 409 && r.json?.error === 'cancel_window_closed', JSON.stringify(r.json));
    // Complaint on the released booking (bkId): file, duplicate refused,
    // admin rejects -> the held app share becomes settleable at once.
    r = await req('POST', `/api/bookings/${bkId}/safety-report`, { token: patientToken2, body: { type: 'complaint', description: 'Visit was late, please review.' } });
    check('complaint filed within 24h window -> 201 with deadline', r.status === 201 && !!r.json?.complaintDeadline, JSON.stringify(r.json));
    const complaintReportId = r.json?.reportId;
    r = await req('GET', `/api/bookings/${bkId}`, { token: patientToken2 });
    check('booking shows complaintStatus open + deadline', r.json?.complaintStatus === 'open' && !!r.json?.complaintDeadline, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkId}/safety-report`, { token: patientToken2, body: { type: 'complaint', description: 'Second complaint.' } });
    check('second open complaint -> 409', r.status === 409, JSON.stringify(r.json));
    r = await req('POST', `/api/admin/complaints/${complaintReportId}/resolve`, { token: adminToken, body: { decision: 'rejected' } });
    check('admin rejects complaint -> booking complaintStatus rejected', r.status === 200 && r.json?.booking?.complaintStatus === 'rejected', JSON.stringify(r.json));
    r = await req('GET', `/api/providers/wallet`, { token: provToken });
    const entry3 = r.json?.ledger?.find((l) => l.bookingId === bkId);
    check('after rejection: provider owes app 56 (cash, now settleable)', entry3?.direction === 'provider_owes_app' && entry3?.amountEgp === 56, JSON.stringify(entry3));
    // Refund path: complaint on the auto-released booking, admin accepts.
    r = await req('POST', `/api/bookings/${bk2}/safety-report`, { token: patientToken2, body: { type: 'complaint', description: 'Service was not satisfactory, request refund.' } });
    check('complaint on auto-released booking -> 201', r.status === 201, JSON.stringify(r.json));
    const refundReportId = r.json?.reportId;
    r = await req('POST', `/api/admin/complaints/${refundReportId}/resolve`, { token: adminToken, body: { decision: 'accepted_refund' } });
    check('admin accepts refund -> booking refunded, refundEgp 250', r.status === 200 && r.json?.booking?.status === 'refunded' && r.json?.booking?.refundEgp === 250, JSON.stringify(r.json));
    r = await req('GET', `/api/providers/wallet`, { token: provToken });
    const refundEntry = r.json?.ledger?.find((l) => l.bookingId === bk2);
    check('refunded booking excluded from settlement', refundEntry?.direction === 'refunded' && refundEntry?.amountEgp === 0, JSON.stringify(refundEntry));

    // --- 16. v2.0.8: Terms & Conditions + anti-circumvention -----------
    console.log('\n[terms + anti-circumvention]');
    // Terms text is public; Arabic is the binding version.
    r = await req('GET', '/api/terms');
    check('GET /api/terms -> v1.0 with Arabic text', r.status === 200 && r.json?.version === '1.0' && typeof r.json?.textAr === 'string' && r.json.textAr.includes('منع الالتفاف'), JSON.stringify(r.json)?.slice(0, 200));
    // A fresh user has not accepted -> mustAccept true; accept -> false.
    const loLogin = await req('POST', '/api/auth/login-phone', { body: { phone: '01077777777' } });
    const loToken = loLogin.json?.accessToken;
    r = await req('GET', '/api/me/terms', { token: loToken });
    check('fresh user /me/terms -> mustAccept true', r.status === 200 && r.json?.mustAccept === true && r.json?.currentVersion === '1.0', JSON.stringify(r.json));
    r = await req('POST', '/api/me/terms', { token: loToken, body: { acceptedTerms: true, termsVersion: '1.0' } });
    check('POST /me/terms accepts v1.0', r.status === 200 && r.json?.version === '1.0', JSON.stringify(r.json));
    r = await req('GET', '/api/me/terms', { token: loToken });
    check('after accept /me/terms -> mustAccept false', r.status === 200 && r.json?.mustAccept === false, JSON.stringify(r.json));
    // Booking without terms -> 400; with a stale version -> 400.
    r = await req('POST', '/api/bookings', { token: patientToken2, body: {
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('booking without acceptedTerms -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { acceptedTerms: true, termsVersion: '0.9',
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('booking with stale termsVersion -> 400', r.status === 400, JSON.stringify(r.json));
    // Registration without terms -> 400.
    const regPhone = '01066666666';
    await req('POST', '/api/otp/request', { body: { phone: regPhone, channel: 'whatsapp' } });
    const rm = await mockCode(regPhone);
    const rl2 = await req('POST', '/api/otp/verify', { body: { phone: regPhone, code: rm || '000000' } });
    const regToken = rl2.json?.accessToken;
    r = await req('POST', '/api/providers/register', { token: regToken, body: {
      name: 'No Terms Nurse', role: 'nurse', nationalId: '12345678901234', licenseNo: 'LIC-11111',
    } });
    check('register without acceptedTerms -> 400', r.status === 400, JSON.stringify(r.json));

    // Radar is minimal: no patient PII at all.
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Radar Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 3, respectCharterAccepted: true, triage: { dangerSigns: [] },
      address: '123 Secret Street', notes: 'secret note', alternateContact: '01099999999',
    } });
    check('v2.0.8 booking created', r.status === 201, JSON.stringify(r.json));
    const bk8 = r.json?.id;
    // v2.1.1: bookings <30 min old are Elite-only on the radar.
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Elite' } });
    check('main provider temporarily Elite for the radar check', r.status === 200 && r.json?.tier === 'Elite', JSON.stringify(r.json));
    r = await req('GET', '/api/providers/radar', { token: provToken });
    const radarItem = (r.json?.pending || []).find((x) => x.id === bk8);
    check('radar returns minimal view, no patient PII', r.status === 200 && !!radarItem && !('patientPhone' in radarItem) && !('patientName' in radarItem) && !('address' in radarItem) && !('alternateContact' in radarItem) && !('notes' in radarItem) && !('triage' in radarItem) && radarItem.serviceCode === 'standard' && radarItem.amountEgp === 250 && radarItem.eliteEarly === true && radarItem.category === 'nursing' && radarItem.riskLevel === 'standard', JSON.stringify(radarItem));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Starter' } });
    check('main provider back to Starter after the radar check', r.status === 200 && r.json?.tier === 'Starter', JSON.stringify(r.json));
    // Radar maxKm is capped at 35.
    r = await req('GET', '/api/providers/radar?maxKm=500', { token: provToken });
    check('radar maxKm capped at 35', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    // Unassigned provider cannot see the booking at all.
    r = await req('GET', `/api/bookings/${bk8}`, { token: prov1Token });
    check('unassigned provider cannot view booking -> 403', r.status === 403, JSON.stringify(r.json));
    // Assigned provider sees phone + address, never the alternate contact.
    r = await req('POST', `/api/bookings/${bk8}/accept`, { token: provToken });
    check('provider accepts v2.0.8 booking', r.status === 200 && r.json?.status === 'accepted', JSON.stringify(r.json));
    r = await req('GET', `/api/bookings/${bk8}`, { token: provToken });
    check('assigned provider sees patient phone + address, no alternate contact', r.status === 200 && r.json?.patientPhone === '01012345678' && !!r.json?.address && !('alternateContact' in r.json) && !('insurer' in r.json), JSON.stringify(r.json)?.slice(0, 300));
    // Patient view never contains the provider phone.
    r = await req('GET', `/api/bookings/${bk8}`, { token: patientToken2 });
    check('patient view has no provider phone', r.status === 200 && !JSON.stringify(r.json).includes('01000000002'), JSON.stringify(r.json)?.slice(0, 300));

    // In-app messaging: phone numbers are rejected, clean text works.
    r = await req('POST', `/api/bookings/${bk8}/messages`, { token: patientToken2, body: { text: 'Call me on 01099999999 please' } });
    check('message with a phone number -> 400', r.status === 400 && r.json?.error === 'phone_number_not_allowed', JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bk8}/messages`, { token: patientToken2, body: { text: 'Hello, I am at the gate.' } });
    check('clean message -> 201', r.status === 201 && r.json?.text === 'Hello, I am at the gate.', JSON.stringify(r.json));
    r = await req('GET', `/api/bookings/${bk8}/messages`, { token: provToken });
    check('assigned provider reads the thread', r.status === 200 && r.json?.open === true && r.json?.messages?.length === 1, JSON.stringify(r.json));
    r = await req('GET', `/api/bookings/${bk8}/messages`, { token: prov1Token });
    check('unassigned provider cannot read messages -> 403', r.status === 403, JSON.stringify(r.json));

    // Review with circumvention=yes -> admin flag + release held.
    await req('POST', `/api/bookings/${bk8}/vitals`, { token: provToken, body: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, glucose: 110, oxygen: 98, temp: 36.6 } });
    await req('POST', `/api/bookings/${bk8}/complete-provider`, { token: provToken });
    await req('POST', `/api/bookings/${bk8}/confirm-patient`, { token: patientToken2 });
    r = await req('POST', `/api/bookings/${bk8}/review`, { token: patientToken2, body: { rating: 2, comment: 'Asked to deal outside the app.', circumventionReported: true } });
    check('review with circumvention=yes -> held, not released', r.status === 200 && r.json?.status === 'reviewed' && r.json?.circumventionHold === true && r.json?.releasedAt == null, JSON.stringify(r.json));
    r = await req('GET', '/api/admin/circumvention', { token: adminToken });
    const circReport = (r.json?.reports || []).find((x) => x.bookingId === bk8);
    check('admin circumvention list shows the report', r.status === 200 && !!circReport && circReport.status === 'open' && Array.isArray(r.json?.flags), JSON.stringify(r.json)?.slice(0, 300));
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('admin dashboard carries circumvention reports + flags', r.status === 200 && Array.isArray(r.json?.circumventionReports) && r.json.circumventionReports.some((x) => x.bookingId === bk8) && Array.isArray(r.json?.circumventionFlags), JSON.stringify(r.json)?.slice(0, 300));
    // Sweep must NOT auto-release a circumvention-held booking.
    await req('POST', '/api/jobs/sweep', { token: adminToken });
    r = await req('GET', `/api/bookings/${bk8}`, { token: patientToken2 });
    check('sweep leaves circumvention-held booking unreleased', r.json?.status === 'reviewed' && r.json?.circumventionHold === true, JSON.stringify(r.json)?.slice(0, 200));
    // Admin confirms -> patient refunded in full.
    r = await req('POST', `/api/admin/circumvention/${circReport.id}/resolve`, { token: adminToken, body: { decision: 'confirmed' } });
    check('admin confirms circumvention -> booking refunded', r.status === 200 && r.json?.booking?.status === 'refunded' && r.json?.booking?.refundEgp === 250, JSON.stringify(r.json));

    // Full visit cycle helper (create -> accept -> vitals -> complete ->
    // patient confirm -> review -> released). Moved up from §17 so §16
    // can use it for the rating-points cycles below.
    const completeVisit = async (patientTok, km) => {
      const c = await req('POST', '/api/bookings', { token: patientTok, body: { ...TERMS,
        patientName: 'Cycle Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
        distanceKm: km, respectCharterAccepted: true, triage: { dangerSigns: [] },
      } });
      if (c.status !== 201) return { ok: false, step: 'create', res: c };
      const id = c.json.id;
      const a = await req('POST', `/api/bookings/${id}/accept`, { token: provToken });
      if (a.status !== 200) return { ok: false, step: 'accept', res: a };
      const v = await req('POST', `/api/bookings/${id}/vitals`, { token: provToken, body: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, glucose: 110, oxygen: 98, temp: 36.6 } });
      if (v.status !== 200) return { ok: false, step: 'vitals', res: v };
      const cp = await req('POST', `/api/bookings/${id}/complete-provider`, { token: provToken });
      if (cp.status !== 200) return { ok: false, step: 'complete-provider', res: cp };
      const cf = await req('POST', `/api/bookings/${id}/confirm-patient`, { token: patientTok });
      if (cf.status !== 200) return { ok: false, step: 'confirm-patient', res: cf };
      const rv = await req('POST', `/api/bookings/${id}/review`, { token: patientTok, body: { rating: 5, comment: 'Good.' } });
      if (rv.status !== 200 || rv.json?.status !== 'released') return { ok: false, step: 'review', res: rv };
      return { ok: true, id, created: c.json, complete: cp.json, released: rv.json };
    };
    // v2.1.6 (C8): rating points count only with >=5 rated visits — so
    // the provider needs 4 more 5-star rated visits here (bkId is the
    // 1st) before the wallet check below can expect Pro (interview 20
    // + rating 20 = 40). These 4 also count toward §17b's monthly cases
    // (5 released before §17b, 29 more -> 34).
    let ratingOk = true; let ratingFailStep = '';
    for (let i = 0; i < 4; i++) {
      const cyc = await completeVisit(patientToken2, 2);
      if (!cyc.ok) { ratingOk = false; ratingFailStep = `${cyc.step} ${JSON.stringify(cyc.res?.json || cyc.res)}`; break; }
    }
    check('4 rating cycles complete (5 rated visits total)', ratingOk, ratingFailStep.slice(0, 300));

    // Graduated discipline: warn -> suspend blocks radar + accept -> unsuspend.
    r = await req('POST', '/api/admin/providers/prov_demo_pro/warn', { token: adminToken, body: { reason: 'Test warning: asked a patient to deal outside the app.' } });
    check('admin warn -> 200, warningCount 1', r.status === 200 && r.json?.warningCount === 1, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    // v2.1.1: points auto-promoted the main provider to Pro (interview 20
    // + rating 20 = 40 points) — wallet commission follows the points tier.
    check('provider wallet shows the warning + tier/commission/next Thursday', r.status === 200 && Array.isArray(r.json?.warnings) && r.json.warnings.length === 1 && r.json?.tier === 'Pro' && r.json?.commissionPct === 12 && !!r.json?.nextSettlementThursday, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/suspend', { token: adminToken, body: { reason: 'Test suspension.' } });
    check('admin suspend -> 200, suspended true', r.status === 200 && r.json?.suspended === true, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/radar', { token: provToken });
    check('suspended provider radar -> 403', r.status === 403, JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Suspend Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkSusp = r.json?.id;
    r = await req('POST', `/api/bookings/${bkSusp}/accept`, { token: provToken });
    check('suspended provider accept -> 403', r.status === 403, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/unsuspend', { token: adminToken });
    check('admin unsuspend -> 200, suspended false', r.status === 200 && r.json?.suspended === false, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/radar', { token: provToken });
    check('radar works again after unsuspend', r.status === 200 && Array.isArray(r.json?.pending), JSON.stringify(r.json)?.slice(0, 200));
    // Permanent ban on the FAILED demo provider (unused after section 7).
    r = await req('POST', '/api/admin/providers/prov_demo_starter/suspend', { token: adminToken, body: { permanent: true, reason: 'Test permanent ban.' } });
    check('admin permanent ban -> 200, permanentBan true', r.status === 200 && r.json?.permanentBan === true, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/me', { token: prov1Token });
    check('banned provider sees permanentBan in /providers/me', r.status === 200 && r.json?.permanentBan === true, JSON.stringify(r.json));

    // --- 17. v2.0.9: reversed commissions + volume bonus + promo months + loyalty vouchers ---
    console.log('\n[v2.0.9 reversed commissions + volume bonus + promo + vouchers]');
    // Terms text carries the new commission line (version stays 1.0 — no
    // forced re-acceptance for a rates change).
    r = await req('GET', '/api/terms');
    check('terms text has reversed rates 15/12/8, no Elite 1,200 bonus', r.status === 200 && r.json?.textAr?.includes('Starter 15%') && r.json?.textAr?.includes('Elite 8%') && !r.json?.textAr?.includes('1,200 جنيه') && r.json?.version === '1.0', JSON.stringify(r.json)?.slice(0, 200));
    // --- 17a. tier rates at accept: Starter 15 / Pro 12 / Elite 8 -------
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Starter' } });
    check('main provider reset to Starter for tier-rate checks', r.status === 200 && r.json?.tier === 'Starter', JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Tier Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkTier1 = r.json?.id;
    r = await req('POST', `/api/bookings/${bkTier1}/accept`, { token: provToken });
    check('Starter accepts at 15%', r.status === 200 && r.json?.commissionPct === 15 && r.json?.commissionTier === 'Starter', JSON.stringify(r.json));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Pro' } });
    check('admin changes tier to Pro', r.status === 200 && r.json?.tier === 'Pro', JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Tier Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkTier2 = r.json?.id;
    r = await req('POST', `/api/bookings/${bkTier2}/accept`, { token: provToken });
    check('Pro accepts at 12%', r.status === 200 && r.json?.commissionPct === 12 && r.json?.commissionTier === 'Pro', JSON.stringify(r.json));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Elite' } });
    check('admin changes tier to Elite', r.status === 200 && r.json?.tier === 'Elite', JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Tier Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkTier3 = r.json?.id;
    r = await req('POST', `/api/bookings/${bkTier3}/accept`, { token: provToken });
    check('Elite accepts at 8%', r.status === 200 && r.json?.commissionPct === 8 && r.json?.commissionTier === 'Elite', JSON.stringify(r.json));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Starter' } });
    check('admin restores tier to Starter', r.status === 200 && r.json?.tier === 'Starter', JSON.stringify(r.json));
    r = await req('GET', `/api/bookings/${bkTier1}`, { token: patientToken2 });
    check('earlier accepted booking keeps locked 15% after tier change', r.json?.commissionPct === 15, JSON.stringify(r.json)?.slice(0, 200));
    // --- 17b. volume bonus: 30 cases -> 500, title, next target ---------
    const volLogin = await req('POST', '/api/auth/login-phone', { body: { phone: '01022222222' } });
    const volToken = volLogin.json?.accessToken;
    check('volume-test patient login', volLogin.status === 200 && !!volToken, JSON.stringify(volLogin.json));
    // Provider already has 5 released cases this month (bkId + 4 rating
    // cycles from §16); 29 more -> 34 (still the 30-case bonus tier).
    let volOk = true; let volFailStep = '';
    let volPointsSeen = true; let volEarnedPositive = false;
    for (let i = 0; i < 29; i++) {
      const cyc = await completeVisit(volToken, 2);
      if (!cyc.ok) { volOk = false; volFailStep = `${cyc.step} ${JSON.stringify(cyc.res?.json || cyc.res)}`; break; }
      // v2.1.1 contract: every completion returns points {earned,total,tier}.
      const pts = cyc.complete?.points;
      if (!pts || typeof pts.earned !== 'number' || typeof pts.total !== 'number' || typeof pts.tier !== 'string') volPointsSeen = false;
      if (pts && pts.earned >= 1) volEarnedPositive = true;
    }
    check('29 volume cycles complete + release', volOk, volFailStep.slice(0, 300));
    check('every complete-provider response carries points {earned,total,tier}', volPointsSeen, 'a cycle completion lacked a valid points payload');
    check('a completion crossed a cases/weekly-double threshold (earned>=1)', volEarnedPositive, 'no completion in 29 cycles earned points');
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    check('wallet: 34 cases this month, bonus 1000 (new 15/30/60 thresholds), title الممرض الذهبي', r.status === 200 && r.json?.monthlyCases === 34 && r.json?.volumeBonusEgp === 1000 && r.json?.volumeBonus?.title === 'الممرض الذهبي' && r.json?.volumeBonus?.nextBonusAt === 60 && r.json?.volumeBonus?.casesToNextBonus === 26, JSON.stringify(r.json?.volumeBonus));
    check('wallet totals carry the 1000 bonus into what app owes provider', r.json?.totals?.volumeBonusEgp === 1000 && r.json?.totals?.appOwesProviderEgp === 1000, JSON.stringify(r.json?.totals));
    r = await req('GET', '/api/me/vouchers', { token: volToken });
    check('volume patient earned vouchers (29 visits -> 7, next after 3 more)', r.status === 200 && r.json?.vouchers?.length === 7 && r.json?.completedPaidVisits === 29 && r.json?.visitsToNextVoucher === 3, JSON.stringify(r.json)?.slice(0, 300));
    // --- 17c. promo months ------------------------------------------------
    r = await req('POST', '/api/admin/promo', { token: adminToken, body: { commissionPct: 101 } });
    check('promo 101% -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/promo', { token: adminToken, body: { commissionPct: -1 } });
    check('promo -1% -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/promo', { token: adminToken, body: { commissionPct: 0, until: new Date(Date.now() - 1000).toISOString() } });
    check('promo with past until -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/promo', { token: patientToken2, body: { commissionPct: 0 } });
    check('promo by non-admin -> 403', r.status === 403, JSON.stringify(r.json));
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    r = await req('POST', '/api/admin/promo', { token: adminToken, body: { commissionPct: 0, until: tomorrow } });
    check('admin sets 0% promo -> 200 active', r.status === 200 && r.json?.promo?.active === true && r.json?.promo?.commissionPct === 0, JSON.stringify(r.json));
    r = await req('GET', '/api/bootstrap');
    check('bootstrap shows promo active 0%', r.json?.promo?.active === true && r.json?.promo?.commissionPct === 0, JSON.stringify(r.json?.promo));
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('admin dashboard shows promo active 0%', r.json?.promo?.active === true && r.json?.promo?.commissionPct === 0, JSON.stringify(r.json?.promo)?.slice(0, 200));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Promo Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkPromo = r.json?.id;
    r = await req('POST', `/api/bookings/${bkPromo}/accept`, { token: provToken });
    check('accept under 0% promo locks commissionPct 0', r.status === 200 && r.json?.commissionPct === 0 && r.json?.promoCommissionPct === 0, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    check('wallet under 0% promo: bonus paused, title kept', r.json?.volumeBonus?.paused === true && r.json?.volumeBonusEgp === 0 && r.json?.volumeBonus?.title === 'الممرض الذهبي' && r.json?.totals?.appOwesProviderEgp === 0, JSON.stringify(r.json?.volumeBonus));
    check('wallet shows promo 0%', r.json?.promo?.active === true && r.json?.promo?.commissionPct === 0, JSON.stringify(r.json?.promo));
    r = await req('POST', '/api/admin/promo', { token: adminToken, body: { commissionPct: null } });
    check('admin clears promo -> inactive', r.status === 200 && r.json?.promo?.active === false, JSON.stringify(r.json));
    r = await req('GET', '/api/bootstrap');
    check('bootstrap promo inactive after clear', r.json?.promo?.active === false, JSON.stringify(r.json?.promo));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Starter' } });
    check('main provider reset to Starter after promo', r.status === 200 && r.json?.tier === 'Starter', JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Post Promo', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkPostPromo = r.json?.id;
    r = await req('POST', `/api/bookings/${bkPostPromo}/accept`, { token: provToken });
    check('accept after promo cleared locks Starter 15% again', r.status === 200 && r.json?.commissionPct === 15, JSON.stringify(r.json));
    // Promo-month cap (max 2 per calendar year): this year already used 1
    // month (the 0% promo above). A 5% promo until +40d covers Nov+Dec
    // 2026 and Jan 2027 — 2026 then uses 2, 2027 uses 1 — allowed.
    const in40d = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
    r = await req('POST', '/api/admin/promo', { token: adminToken, body: { commissionPct: 5, until: in40d } });
    check('promo to +40d fits the 2-per-year cap -> 200', r.status === 200 && r.json?.promo?.active === true && r.json?.promo?.commissionPct === 5, JSON.stringify(r.json));
    // But a promo until +100d would make 2027 use 3 months (Jan+Feb+Mar).
    const in100d = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
    r = await req('POST', '/api/admin/promo', { token: adminToken, body: { commissionPct: 5, until: in100d } });
    check('promo that would make a year use 3 months -> 409 cap', r.status === 409 && r.json?.error === 'promo_months_exceeded', JSON.stringify(r.json));
    r = await req('POST', '/api/admin/promo', { token: adminToken, body: { commissionPct: null } });
    check('admin clears the cap-test promo -> inactive', r.status === 200 && r.json?.promo?.active === false, JSON.stringify(r.json));
    // --- 17d. patient loyalty vouchers ------------------------------------
    const vouLogin = await req('POST', '/api/auth/login-phone', { body: { phone: '01033333333' } });
    const vouToken = vouLogin.json?.accessToken;
    check('voucher-test patient login', vouLogin.status === 200 && !!vouToken, JSON.stringify(vouLogin.json));
    r = await req('GET', '/api/me/vouchers', { token: vouToken });
    check('new patient has no vouchers, 4 visits to first', r.status === 200 && r.json?.vouchers?.length === 0 && r.json?.completedPaidVisits === 0 && r.json?.visitsToNextVoucher === 4, JSON.stringify(r.json));
    let vouOk = true; let vouFailStep = '';
    for (let i = 0; i < 4; i++) {
      const cyc = await completeVisit(vouToken, 8); // 250 + 100 = 350 (>= 300 min)
      if (!cyc.ok) { vouOk = false; vouFailStep = cyc.step; break; }
    }
    check('4 voucher cycles complete + release', vouOk, vouFailStep);
    r = await req('GET', '/api/me/vouchers', { token: vouToken });
    const vou1 = r.json?.vouchers?.[0];
    const expDays = vou1 ? (new Date(vou1.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000) : -1;
    check('4 completions -> 1 active 50 EGP voucher, 60-day expiry, min 300', r.status === 200 && r.json?.vouchers?.length === 1 && vou1?.amountEgp === 50 && vou1?.minBookingEgp === 300 && expDays > 59 && expDays < 61 && r.json?.completedPaidVisits === 4 && r.json?.visitsToNextVoucher === 4, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', '/api/bookings', { token: vouToken, body: { ...TERMS,
      patientName: 'Voucher Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('250 booking does not apply the voucher (min 300)', r.status === 201 && r.json?.amountEgp === 250 && r.json?.amountPayableEgp === 250 && r.json?.voucherId == null, JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: vouToken, body: { ...TERMS,
      patientName: 'Voucher Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 8, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkVou = r.json?.id;
    check('350 booking auto-applies voucher: payable 300, discount 50', r.status === 201 && r.json?.amountEgp === 350 && r.json?.amountPayableEgp === 300 && r.json?.voucherDiscountEgp === 50 && !!r.json?.voucherId, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Starter' } });
    check('main provider reset to Starter before the voucher visit accept', r.status === 200 && r.json?.tier === 'Starter', JSON.stringify(r.json));
    await req('POST', `/api/bookings/${bkVou}/accept`, { token: provToken });
    await req('POST', `/api/bookings/${bkVou}/vitals`, { token: provToken, body: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, glucose: 110, oxygen: 98, temp: 36.6 } });
    await req('POST', `/api/bookings/${bkVou}/complete-provider`, { token: provToken });
    await req('POST', `/api/bookings/${bkVou}/confirm-patient`, { token: vouToken });
    r = await req('POST', `/api/bookings/${bkVou}/review`, { token: vouToken, body: { rating: 5, comment: 'Used my voucher.' } });
    check('voucher visit released: provider 297 on full price, app 3', r.status === 200 && r.json?.status === 'released' && r.json?.providerShareEgp === 297 && r.json?.appShareEgp === 3, JSON.stringify(r.json));
    r = await req('GET', '/api/me/vouchers', { token: vouToken });
    check('voucher now used, none active', r.status === 200 && r.json?.vouchers?.length === 0 && r.json?.used?.length === 1 && r.json?.used?.[0]?.usedBookingId === bkVou, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', '/api/bookings', { token: vouToken, body: { ...TERMS,
      patientName: 'Voucher Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 8, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('no voucher left -> 350 booking pays in full', r.status === 201 && r.json?.amountPayableEgp === 350 && r.json?.voucherId == null, JSON.stringify(r.json));
    let vouOk2 = true;
    for (let i = 0; i < 3; i++) {
      const cyc = await completeVisit(vouToken, 8);
      if (!cyc.ok) { vouOk2 = false; break; }
    }
    check('3 more cycles -> 8 completed visits', vouOk2);
    r = await req('GET', '/api/me/vouchers', { token: vouToken });
    check('8 completions -> second voucher issued', r.status === 200 && r.json?.vouchers?.length === 1 && r.json?.completedPaidVisits === 8, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/tourist-bookings', { token: vouToken, body: { ...TERMS,
      patientName: 'Tourist Voucher', serviceCode: 'tourist_doctor', currency: 'usd', hotelId: 'h10',
      urgent: false, paymentMethod: 'cash_receipt', respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('tourist booking applies voucher in USD: 55 - 1.04 = 53.96', r.status === 201 && r.json?.amountForeign === 53.96 && r.json?.voucherDiscountEgp === 50 && r.json?.voucherDiscountForeign === 1.04 && r.json?.amountPayableEgp === 2590, JSON.stringify(r.json));

    // --- 18. v2.1.0: notifications + Postgres flags + SMS OTP gate +
    // NPWT booking + new services / high-risk tier + doctors directory --
    console.log('\n[v2.1.0 notifications + high-risk + doctors + npwt booking]');
    // --- 18a. bootstrap flags + new services ---------------------------
    r = await req('GET', '/api/bootstrap');
    check('bootstrap has 41 priced services (27 v2.1.0 + 14 v2.1.1)', r.json?.services?.length === 41, `got ${r.json?.services?.length}`);
    const svc = (code) => r.json.services.find((s) => s.code === code);
    check('catheter_insert 400 high-risk', svc('catheter_insert')?.price_egp === 400 && svc('catheter_insert')?.riskLevel === 'high', JSON.stringify(svc('catheter_insert')));
    check('catheter_remove 300 high-risk', svc('catheter_remove')?.price_egp === 300 && svc('catheter_remove')?.riskLevel === 'high');
    check('catheter_flush 300 high-risk', svc('catheter_flush')?.price_egp === 300 && svc('catheter_flush')?.riskLevel === 'high');
    check('ryle_insert 400 high-risk', svc('ryle_insert')?.price_egp === 400 && svc('ryle_insert')?.riskLevel === 'high');
    check('drain_removal 300 high-risk (owner-set)', svc('drain_removal')?.price_egp === 300 && svc('drain_removal')?.riskLevel === 'high');
    check('trach_care 400 high-risk', svc('trach_care')?.price_egp === 400 && svc('trach_care')?.riskLevel === 'high');
    check('iv_infusion 400 high-risk', svc('iv_infusion')?.price_egp === 400 && svc('iv_infusion')?.riskLevel === 'high');
    check('cannula_iv 350 now high-risk', svc('cannula_iv')?.price_egp === 350 && svc('cannula_iv')?.riskLevel === 'high');
    check('suture_removal 250 standard + requiresDoctorOrder', svc('suture_removal')?.price_egp === 250 && svc('suture_removal')?.riskLevel === 'standard' && svc('suture_removal')?.requiresDoctorOrder === true);
    check('standard new services priced', svc('blood_draw')?.price_egp === 200 && svc('injection')?.price_egp === 150 && svc('vitals_check')?.price_egp === 150 && svc('stoma_care')?.price_egp === 300);
    check('cvp_dressing 300 high-risk (owner-set 26 Nov)', svc('cvp_dressing')?.price_egp === 300 && svc('cvp_dressing')?.riskLevel === 'high' && svc('cvp_dressing')?.requiresDoctorOrder === true);
    // v2.1.4 (owner-approved 26 Nov 2026, «سيبها: 500 / 850»): single-day
    // shift prices go BACK to 12h 500 / 24h 850 (they were 700 / 1,200
    // only in v2.1.3). The residence ladder and elderly floors are untouched.
    check('elderly shift mobile 600 / bedridden 700 (owner-set minimums, v2.1.3)', svc('elderly_shift_mobile')?.price_egp === 600 && svc('elderly_shift_mobile')?.riskLevel === 'standard' && svc('elderly_shift_bedridden')?.price_egp === 700 && svc('elderly_shift_bedridden')?.riskLevel === 'standard');
    check('12h shift 500 / 24h shift 850 (v2.1.4 — back from 700 / 1,200)', svc('shift12')?.price_egp === 500 && svc('shift24')?.price_egp === 850);
    check('bootstrap highRiskServices has 11 incl npwt + cannula_iv + cvp + iron', Array.isArray(r.json?.highRiskServices) && r.json.highRiskServices.length === 11 && r.json.highRiskServices.includes('npwt') && r.json.highRiskServices.includes('cannula_iv') && r.json.highRiskServices.includes('cvp_dressing') && r.json.highRiskServices.includes('iron_infusion'), JSON.stringify(r.json?.highRiskServices));
    check('bootstrap highRiskChecklist has 4 items', Array.isArray(r.json?.highRiskChecklist) && r.json.highRiskChecklist.length === 4 && r.json.highRiskChecklist.includes('sterileTechnique'), JSON.stringify(r.json?.highRiskChecklist));
    check('bootstrap otp/push/persistence flags (all off in test)', r.json?.otp?.smsConfigured === false && r.json?.otp?.whatsappConfigured === false && r.json?.push?.fcmConfigured === false && r.json?.persistence === 'file', JSON.stringify({ otp: r.json?.otp, push: r.json?.push, persistence: r.json?.persistence }));
    // --- 18b. doctor-order gate + high-risk accept + checklist --------
    const order = { doctorName: 'Dr. Ahmed', orderNumber: 'ORD-123' };
    const bookSvc = async (serviceCode, extra = {}) => req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Risk Test', serviceCode, paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] }, ...extra,
    } });
    r = await bookSvc('suture_removal');
    check('suture removal without doctor order -> 400', r.status === 400, JSON.stringify(r.json));
    r = await bookSvc('suture_removal', { doctorOrder: order });
    check('suture removal with order -> 201, 250 EGP', r.status === 201 && r.json?.amountEgp === 250 && r.json?.doctorOrder?.doctorName === 'Dr. Ahmed', JSON.stringify(r.json));
    const bkSuture = r.json?.id;
    r = await bookSvc('catheter_insert');
    check('catheter insertion without doctor order -> 400', r.status === 400, JSON.stringify(r.json));
    r = await bookSvc('catheter_insert', { doctorOrder: order, consentGiven: true });
    check('catheter insertion with order + consent -> 201, 400 EGP', r.status === 201 && r.json?.amountEgp === 400, JSON.stringify(r.json));
    const bkCath = r.json?.id;
    // Register a nursing ASSISTANT, pass the interview, then prove the
    // high-risk gates: radar hides it, accept refuses it (role gate fires
    // before the verified-status gate).
    const asstPhone = '01044444444';
    const asstOtpReq = await req('POST', '/api/otp/request', { body: { phone: asstPhone, channel: 'whatsapp' } });
    check('assistant otp request 200', asstOtpReq.status === 200, JSON.stringify(asstOtpReq.json));
    const am = await mockCode(asstPhone);
    const al = await req('POST', '/api/otp/verify', { body: { phone: asstPhone, code: am || '000000' } });
    check('assistant otp verify 200', al.status === 200 && !!al.json?.accessToken, JSON.stringify(al.json)?.slice(0, 150));
    const asstToken = al.json?.accessToken;
    r = await req('POST', '/api/providers/register', { token: asstToken, body: { ...TERMS,
      name: 'Test Assistant', role: 'assistant', nationalId: '12345678901234', licenseNo: 'LIC-ASST1',
    } });
    check('assistant registered', r.status === 201 && r.json?.role === 'assistant', JSON.stringify(r.json));
    const asstProviderId = r.json?.id;
    // The OTP token was issued BEFORE registration (role=patient), so
    // re-login as provider to get a provider-role token for the interview.
    r = await req('POST', '/api/auth/login-phone', { body: { phone: asstPhone, role: 'provider' } });
    check('assistant re-login as provider -> 200', r.status === 200 && r.json?.role === 'provider' && !!r.json?.accessToken, JSON.stringify(r.json)?.slice(0, 200));
    const asstProvToken = r.json?.accessToken;
    const asstInterview = await answerInterview(asstProvToken, 'all-correct');
    check('assistant passes interview 36/36', asstInterview.submit?.status === 200 && asstInterview.submit?.json?.status === 'passed' && asstInterview.submit?.json?.total === 36, JSON.stringify(asstInterview.submit?.json));
    r = await req('POST', `/api/admin/providers/${asstProviderId}/verify`, { token: adminToken, body: { role: 'assistant' } });
    check('admin verifies assistant -> verified', r.status === 200 && r.json?.status === 'verified', JSON.stringify(r.json));
    // v2.1.1 Elite early access: the assistant must be Elite to see the
    // fresh standard booking on the radar at all.
    r = await req('POST', `/api/admin/providers/${asstProviderId}/tier`, { token: adminToken, body: { tier: 'Elite' } });
    check('assistant temporarily Elite for the radar check', r.status === 200 && r.json?.tier === 'Elite', JSON.stringify(r.json));
    r = await req('GET', '/api/providers/radar', { token: asstProvToken });
    const radarCodes = (r.json?.pending || []).map((b) => b.serviceCode);
    check('assistant radar hides high-risk, shows standard', r.status === 200 && !radarCodes.includes('catheter_insert') && radarCodes.includes('standard'), JSON.stringify(radarCodes));
    r = await req('POST', `/api/bookings/${bkCath}/accept`, { token: asstProvToken });
    check('assistant cannot accept high-risk -> 403 nurse-only', r.status === 403 && JSON.stringify(r.json).includes('Nursing assistants cannot'), JSON.stringify(r.json));
    // Main provider tier may have auto-promoted via points; reset Starter.
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Starter' } });
    check('main provider reset to Starter before high-risk accepts', r.status === 200 && r.json?.tier === 'Starter', JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkCath}/accept`, { token: provToken });
    check('verified nurse accepts high-risk -> 200, 15%', r.status === 200 && r.json?.status === 'accepted' && r.json?.commissionPct === 15, JSON.stringify(r.json));
    // --- 18b. suture/catheter completion + points contract --------------
    const vitalsBody = { bpSystolic: 120, bpDiastolic: 80, pulse: 78, glucose: 110, oxygen: 98, temp: 36.6 };
    r = await req('POST', `/api/bookings/${bkSuture}/accept`, { token: provToken });
    check('verified nurse accepts suture removal -> 200', r.status === 200 && r.json?.status === 'accepted', JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkSuture}/vitals`, { token: provToken, body: vitalsBody });
    check('suture vitals recorded', r.status === 200, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkSuture}/complete-provider`, { token: provToken });
    check('suture complete without doctorOrderSeen -> 409', r.status === 409, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkSuture}/complete-provider`, { token: provToken, body: { doctorOrderSeen: true } });
    check('suture complete with doctorOrderSeen -> 200 + points payload', r.status === 200 && r.json?.status === 'provider_confirmed' && r.json?.points && typeof r.json.points.earned === 'number' && typeof r.json.points.total === 'number' && typeof r.json.points.tier === 'string', JSON.stringify(r.json)?.slice(0, 300));
    const suturePts = r.json?.points;
    r = await req('GET', '/api/providers/me', { token: provToken });
    check('completion points match provider record (total + tier)', r.status === 200 && suturePts && r.json?.points?.total === suturePts.total && r.json?.points?.tier === suturePts.tier, JSON.stringify(r.json?.points));
    r = await req('POST', `/api/bookings/${bkCath}/vitals`, { token: provToken, body: vitalsBody });
    check('catheter vitals recorded', r.status === 200, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkCath}/complete-provider`, { token: provToken });
    check('high-risk complete without checklist -> 409', r.status === 409, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkCath}/complete-provider`, { token: provToken, body: { safetyChecklist: { orderSeen: true, sterileTechnique: true, identityConfirmed: true, complicationCheck: true } } });
    check('high-risk complete with full checklist -> 200 + points payload', r.status === 200 && r.json?.status === 'provider_confirmed' && r.json?.points && typeof r.json.points.earned === 'number' && typeof r.json.points.total === 'number', JSON.stringify(r.json)?.slice(0, 300));
    // --- 18c. NPWT booking endpoint ------------------------------------
    const npwtBody = { ...TERMS, patientName: 'NPWT Test', paymentMethod: 'cash_receipt',
      days: 14, kitPrice: 300, distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
      consentGiven: true }; // v2.1.1: NPWT is high-risk — explicit consent required
    r = await req('POST', '/api/npwt/bookings', { token: patientToken2, body: npwtBody });
    check('NPWT booking without order/checklist -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/npwt/bookings', { token: patientToken2, body: { ...npwtBody, doctorOrder: order } });
    check('NPWT booking without checklist -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/npwt/bookings', { token: patientToken2, body: { ...npwtBody, doctorOrder: order,
      safetyChecklist: { foamCountConfirmed: true, bleedingChecked: true, canisterChecked: true, woundPhotoConfirmed: true } } });
    check('NPWT booking complete -> 201, 5500 EGP, kind npwt', r.status === 201 && r.json?.amountEgp === 5500 && r.json?.kind === 'npwt' && r.json?.serviceCode === 'npwt', JSON.stringify(r.json));
    const bkNpwt = r.json?.id;
    r = await req('POST', `/api/bookings/${bkNpwt}/accept`, { token: provToken });
    check('verified nurse accepts NPWT -> 200', r.status === 200 && r.json?.status === 'accepted', JSON.stringify(r.json));
    await req('POST', `/api/bookings/${bkNpwt}/vitals`, { token: provToken, body: vitalsBody });
    r = await req('POST', `/api/bookings/${bkNpwt}/complete-provider`, { token: provToken, body: { safetyChecklist: { orderSeen: true, sterileTechnique: true, identityConfirmed: true, complicationCheck: true } } });
    check('NPWT complete with checklist -> 200', r.status === 200 && r.json?.status === 'provider_confirmed', JSON.stringify(r.json));
    // --- 18d. doctors directory + referral ------------------------------
    r = await req('GET', '/api/admin/doctors', { token: adminToken });
    check('doctors directory starts EMPTY (no fake doctors)', r.status === 200 && r.json?.count === 0 && Array.isArray(r.json?.doctors), JSON.stringify(r.json));
    r = await req('POST', '/api/admin/doctors', { token: adminToken, body: { name: 'Dr. Test', specialty: 'جراحة عامة', phone: '123' } });
    check('doctor with bad phone -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/doctors', { token: adminToken, body: { name: 'Dr. Test', specialty: 'جراحة عامة', phone: '01011112222', clinic: 'عيادة القصير', workingHours: '9-5' } });
    check('admin adds doctor -> 201 with phone', r.status === 201 && !!r.json?.id && r.json?.phone === '01011112222', JSON.stringify(r.json));
    const docId = r.json?.id;
    r = await req('GET', '/api/providers/doctors', { token: provToken });
    check('provider sees doctor WITH phone', r.status === 200 && r.json?.count === 1 && r.json?.doctors?.[0]?.phone === '01011112222', JSON.stringify(r.json));
    r = await req('GET', '/api/providers/doctors?specialty=جراحة', { token: provToken });
    check('provider specialty filter matches', r.status === 200 && r.json?.count === 1, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/doctors?specialty=قلب', { token: provToken });
    check('provider specialty filter excludes', r.status === 200 && r.json?.count === 0, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/doctors', { token: patientToken2 });
    check('patient CANNOT list doctors -> 403', r.status === 403, JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bkCath}/refer-doctor`, { token: provToken, body: { doctorId: docId, note: 'Needs surgical review.' } });
    check('provider refers booking to doctor -> 201', r.status === 201 && r.json?.referral?.doctorName === 'Dr. Test' && r.json?.referral?.phone === '01011112222', JSON.stringify(r.json));
    r = await req('GET', `/api/bookings/${bkCath}`, { token: patientToken2 });
    check('patient sees referral but NOT the doctor phone (anti-leakage)', r.status === 200 && Array.isArray(r.json?.referrals) && r.json.referrals.length === 1 && JSON.stringify(r.json).indexOf('01011112222') === -1, JSON.stringify(r.json?.referrals));
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('admin dashboard includes doctors + doctorsCount 1', r.status === 200 && r.json?.doctorsCount === 1 && Array.isArray(r.json?.doctors), JSON.stringify(r.json?.doctorsCount));
    r = await req('PUT', `/api/admin/doctors/${docId}`, { token: adminToken, body: { workingHours: '10-6' } });
    check('admin updates doctor hours -> 200', r.status === 200 && r.json?.workingHours === '10-6', JSON.stringify(r.json));
    r = await req('DELETE', `/api/admin/doctors/${docId}`, { token: adminToken });
    check('admin deletes doctor -> 200', r.status === 200 && r.json?.deletedId === docId, JSON.stringify(r.json));
    r = await req('GET', '/api/admin/doctors', { token: adminToken });
    check('directory empty again after delete', r.status === 200 && r.json?.count === 0, JSON.stringify(r.json));
    // --- 18e. notifications: devices, en-route, review reminder --------
    r = await req('POST', '/api/me/devices', { token: patientToken2, body: { fcmToken: 'short' } });
    check('device token too short -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/me/devices', { token: patientToken2, body: { fcmToken: 'fcm-test-token-aaaaaaaaaa', platform: 'android' } });
    check('device registered -> devices 1', r.status === 200 && r.json?.devices === 1, JSON.stringify(r.json));
    r = await req('POST', '/api/me/devices', { token: patientToken2, body: { fcmToken: 'fcm-test-token-aaaaaaaaaa', platform: 'android' } });
    check('same device token deduped -> still 1', r.status === 200 && r.json?.devices === 1, JSON.stringify(r.json));
    r = await req('POST', '/api/me/devices', { token: patientToken2, body: { fcmToken: 'fcm-test-token-bbbbbbbbbb', platform: 'android' } });
    check('second device -> 2', r.status === 200 && r.json?.devices === 2, JSON.stringify(r.json));
    r = await req('DELETE', '/api/me/devices', { token: patientToken2, body: { fcmToken: 'fcm-test-token-aaaaaaaaaa' } });
    check('device unregistered -> removed 1', r.status === 200 && r.json?.removed === 1, JSON.stringify(r.json));
    r = await req('GET', '/api/me/notifications', { token: patientToken2 });
    check('notifications list readable (in-app centre works with no FCM)', r.status === 200 && Array.isArray(r.json?.notifications) && typeof r.json?.unreadCount === 'number', JSON.stringify(r.json)?.slice(0, 200));
    // En-route: fresh standard booking, accept, en-route.
    r = await bookSvc('standard');
    const bkRoute = r.json?.id;
    await req('POST', `/api/bookings/${bkRoute}/accept`, { token: provToken });
    r = await req('POST', `/api/bookings/${bkRoute}/en-route`, { token: provToken });
    check('en-route -> 200 with enRouteAt, status still accepted', r.status === 200 && !!r.json?.enRouteAt && r.json?.status === 'accepted', JSON.stringify(r.json));
    r = await req('GET', '/api/me/notifications', { token: patientToken2 });
    const enRouteNotif = (r.json?.notifications || []).find((n) => n.type === 'provider_en_route');
    check('patient got provider_en_route notification (unread)', !!enRouteNotif && !enRouteNotif.readAt, JSON.stringify(enRouteNotif));
    r = await req('POST', `/api/me/notifications/${enRouteNotif.id}/read`, { token: patientToken2 });
    check('mark one notification read -> 200', r.status === 200 && !!r.json?.notification?.readAt, JSON.stringify(r.json));
    r = await req('POST', '/api/me/notifications/read-all', { token: patientToken2 });
    check('mark all read -> readCount > 0', r.status === 200 && r.json?.readCount > 0, JSON.stringify(r.json));
    r = await req('GET', '/api/me/notifications', { token: patientToken2 });
    check('unreadCount 0 after read-all', r.json?.unreadCount === 0, JSON.stringify(r.json?.unreadCount));
    // Review reminder: confirm a visit, sweep IMMEDIATELY (auto-release
    // is 1000 ms in this test, reminder threshold is max(0, 1000-10min)=0,
    // so the reminder fires on this sweep while the release does not).
    r = await bookSvc('standard');
    const bkRem = r.json?.id;
    await req('POST', `/api/bookings/${bkRem}/accept`, { token: provToken });
    await req('POST', `/api/bookings/${bkRem}/vitals`, { token: provToken, body: vitalsBody });
    await req('POST', `/api/bookings/${bkRem}/complete-provider`, { token: provToken });
    await req('POST', `/api/bookings/${bkRem}/confirm-patient`, { token: patientToken2 });
    r = await req('POST', '/api/jobs/sweep', { token: adminToken });
    check('sweep runs (reminder pass included)', r.status === 200 && typeof r.json?.notificationsSent === 'number', JSON.stringify(r.json));
    r = await req('GET', '/api/me/notifications', { token: patientToken2 });
    const remNotif = (r.json?.notifications || []).find((n) => n.type === 'review_reminder' && n.data?.bookingId === bkRem);
    check('patient got review_reminder for the confirmed visit', !!remNotif, JSON.stringify((r.json?.notifications || []).map((n) => n.type)));
    r = await req('POST', `/api/bookings/${bkRem}/review`, { token: patientToken2, body: { rating: 5, comment: 'Reviewed after reminder.' } });
    check('review after reminder releases the visit', r.status === 200 && r.json?.status === 'released', JSON.stringify(r.json));
    // --- 18f. admin persistence endpoint --------------------------------
    r = await req('GET', '/api/admin/persistence', { token: adminToken });
    check('persistence endpoint: file store, postgres off in test', r.status === 200 && r.json?.persistence === 'file' && r.json?.postgresConfigured === false, JSON.stringify(r.json));

    // --- 21. v2.1.1 coverage: new services, physio + tourist gating, ----
    //     favorites, medical-file interest, monitor, CORS, refresh reuse,
    //     points/credentials, stay bonus/buddy, settlements/export,
    //     triage emergency, SOS cap --------------------------------------
    console.log('\n[v2.1.1 coverage]');
    const bookStd = async (serviceCode, extra = {}) => req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Coverage Patient', serviceCode, paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] }, ...extra,
    } });
    // 21a. six new nursing services (priced) + iron high-risk gate.
    r = await bookStd('enema');
    check('new service enema -> 201, 500 EGP', r.status === 201 && r.json?.amountEgp === 500, JSON.stringify(r.json)?.slice(0, 200));
    r = await bookStd('allergy_test');
    check('new service allergy_test -> 201, 250 EGP', r.status === 201 && r.json?.amountEgp === 250, JSON.stringify(r.json)?.slice(0, 200));
    r = await bookStd('condom_catheter');
    check('new service condom_catheter -> 201, 300 EGP', r.status === 201 && r.json?.amountEgp === 300, JSON.stringify(r.json)?.slice(0, 200));
    r = await bookStd('culture_sample');
    check('new service culture_sample -> 201, 400 EGP', r.status === 201 && r.json?.amountEgp === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await bookStd('urine_catheter_sample');
    check('new service urine_catheter_sample -> 201, 350 EGP', r.status === 201 && r.json?.amountEgp === 350, JSON.stringify(r.json)?.slice(0, 200));
    r = await bookStd('iron_infusion');
    check('iron_infusion without doctor order -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await bookStd('iron_infusion', { doctorOrder: order, consentGiven: true });
    check('iron_infusion with order + consent -> 201, 400 EGP', r.status === 201 && r.json?.amountEgp === 400, JSON.stringify(r.json)?.slice(0, 200));
    // 21b. triage level emergency rejects even with empty dangerSigns.
    r = await bookStd('standard', { triage: { level: 'emergency', dangerSigns: [] } });
    check('triage level emergency -> 422 emergency_triage', r.status === 422 && r.json?.error === 'emergency_triage', JSON.stringify(r.json)?.slice(0, 200));
    // 21c. physio: registration requires a certificate; then full flow.
    const physNoCert = await registerProvider('01017171717', 'physio');
    check('physio registration without certificate -> 400', physNoCert.regStatus === 400, JSON.stringify(physNoCert.reg)?.slice(0, 200));
    const phys = await registerProvider('01017171717', 'physio', { certificates: [{ name: 'BSc Physiotherapy' }] });
    check('physio registration with certificate -> 201', phys.regStatus === 201, JSON.stringify(phys.reg)?.slice(0, 200));
    const physInterview = await answerInterview(phys.token, 'all-correct');
    check('physio passes interview 36/36', physInterview.submit?.status === 200 && physInterview.submit?.json?.status === 'passed' && physInterview.submit?.json?.total === 36, JSON.stringify(physInterview.submit?.json));
    r = await req('POST', `/api/admin/providers/${phys.providerId}/verify`, { token: adminToken, body: { role: 'physio' } });
    check('admin verifies physio', r.status === 200 && r.json?.status === 'verified', JSON.stringify(r.json)?.slice(0, 200));
    // Main provider Elite first, so radar exclusion below is the physio
    // gate only (not the Elite early-access gate).
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Elite' } });
    check('main provider Elite for radar-gate checks', r.status === 200 && r.json?.tier === 'Elite', JSON.stringify(r.json));
    r = await bookStd('physio_general');
    check('physio_general booking -> 201, 350 EGP, category physio', r.status === 201 && r.json?.amountEgp === 350 && r.json?.category === 'physio', JSON.stringify(r.json)?.slice(0, 200));
    const bkPhysio = r.json?.id;
    r = await req('GET', '/api/providers/radar', { token: provToken });
    check('nurse radar hides physio-category booking', r.status === 200 && !(r.json?.pending || []).some((b) => b.id === bkPhysio), JSON.stringify((r.json?.pending || []).map((b) => b.serviceCode)));
    r = await req('POST', `/api/bookings/${bkPhysio}/accept`, { token: provToken });
    check('nurse cannot accept physio service -> 403', r.status === 403, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/providers/${phys.providerId}/tier`, { token: adminToken, body: { tier: 'Elite' } });
    check('physio temporarily Elite for radar', r.status === 200 && r.json?.tier === 'Elite', JSON.stringify(r.json));
    r = await req('GET', '/api/providers/radar', { token: phys.token });
    check('physio radar shows physio booking', r.status === 200 && (r.json?.pending || []).some((b) => b.id === bkPhysio), JSON.stringify((r.json?.pending || []).map((b) => b.serviceCode)));
    r = await req('POST', `/api/bookings/${bkPhysio}/accept`, { token: phys.token });
    check('physio accepts physio booking -> 200', r.status === 200 && r.json?.status === 'accepted', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkPhysio}/vitals`, { token: phys.token, body: vitalsBody });
    check('physio vitals recorded', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkPhysio}/complete-provider`, { token: phys.token });
    check('physio complete-provider -> 200 + points', r.status === 200 && r.json?.status === 'provider_confirmed' && r.json?.points, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/bookings/${bkPhysio}/confirm-patient`, { token: patientToken2 });
    check('physio patient confirm -> 200', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkPhysio}/review`, { token: patientToken2, body: { rating: 5, comment: 'Good.' } });
    check('physio review releases visit', r.status === 200 && r.json?.status === 'released', JSON.stringify(r.json)?.slice(0, 200));
    // 21d. v2.1.2 tourist badge gating (TEST-based, supersedes the
    // v2.1.1 certificate rule) + language bonus on release.
    r = await req('POST', '/api/tourist-bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Tourist Test', serviceCode: 'tourist_iv', language: 'de', currency: 'eur',
      paymentMethod: 'cash_receipt', distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('tourist booking (de, eur) -> 201, kind tourist', r.status === 201 && r.json?.kind === 'tourist' && r.json?.language === 'de', JSON.stringify(r.json)?.slice(0, 300));
    const bkTourist = r.json?.id;
    const fxEur = r.json?.fxRate;
    r = await req('GET', '/api/providers/radar', { token: provToken });
    check('tourist booking hidden from non-compatible provider radar', r.status === 200 && !(r.json?.pending || []).some((b) => b.id === bkTourist), JSON.stringify((r.json?.pending || []).map((b) => b.id)));
    r = await req('POST', `/api/bookings/${bkTourist}/accept`, { token: provToken });
    check('non-compatible provider cannot accept tourist booking -> 403', r.status === 403, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/credentials', { token: adminToken, body: { kind: 'language', name: 'Goethe B2', language: 'de', verified: true } });
    check('admin adds verified German certificate -> 201', r.status === 201, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/providers/me', { token: provToken });
    check('v2.1.2: verified certificate ALONE does not grant the tourist badge', r.status === 200 && r.json?.touristCompatible === false, JSON.stringify({ touristCompatible: r.json?.touristCompatible }));
    // English test (all correct, 8/8) -> general badge.
    const enTest = await answerLanguageTest(provToken, 'en', 'all-correct');
    check('English test all-correct -> 200, passed 8/8', enTest.submit?.status === 200 && enTest.submit?.json?.passed === true && enTest.submit?.json?.score === 8, JSON.stringify(enTest.submit?.json));
    r = await req('GET', '/api/providers/me', { token: provToken });
    check('provider is touristCompatible after passing English test', r.status === 200 && r.json?.touristCompatible === true && (r.json?.languageBadges?.en?.passed === true), JSON.stringify({ touristCompatible: r.json?.touristCompatible, badges: r.json?.languageBadges }));
    // German booking still needs the GERMAN test, not just English.
    r = await req('GET', '/api/providers/radar', { token: provToken });
    check('German tourist booking still hidden without German badge', r.status === 200 && !(r.json?.pending || []).some((b) => b.id === bkTourist), JSON.stringify((r.json?.pending || []).map((b) => b.id)));
    r = await req('POST', `/api/bookings/${bkTourist}/accept`, { token: provToken });
    check('German tourist booking cannot be accepted without German badge -> 403', r.status === 403, JSON.stringify(r.json)?.slice(0, 200));
    const deTest = await answerLanguageTest(provToken, 'de', 'all-correct');
    check('German test all-correct -> 200, passed 8/8', deTest.submit?.status === 200 && deTest.submit?.json?.passed === true && deTest.submit?.json?.score === 8, JSON.stringify(deTest.submit?.json));
    // The credential add recomputed points and demoted the manual Elite
    // tier back to Pro — re-apply Elite so the radar check below tests
    // the tourist gate only, not the Elite early-access gate.
    r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Elite' } });
    check('main provider Elite again for tourist radar check', r.status === 200 && r.json?.tier === 'Elite', JSON.stringify(r.json));
    r = await req('GET', '/api/providers/radar', { token: provToken });
    check('tourist booking visible to German-badge provider radar', r.status === 200 && (r.json?.pending || []).some((b) => b.id === bkTourist), JSON.stringify((r.json?.pending || []).map((b) => b.id)));
    r = await req('POST', `/api/bookings/${bkTourist}/accept`, { token: provToken });
    check('German-badge provider accepts tourist booking -> 200', r.status === 200 && r.json?.status === 'accepted', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkTourist}/vitals`, { token: provToken, body: vitalsBody });
    check('tourist vitals recorded', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkTourist}/complete-provider`, { token: provToken });
    check('tourist complete-provider -> 200 + points payload', r.status === 200 && r.json?.status === 'provider_confirmed' && r.json?.points && typeof r.json.points.earned === 'number', JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/bookings/${bkTourist}/confirm-patient`, { token: patientToken2 });
    check('tourist patient confirm -> 200', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkTourist}/review`, { token: patientToken2, body: { rating: 5, comment: 'Great.' } });
    check('tourist review releases visit', r.status === 200 && r.json?.status === 'released', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    const tourLine = (r.json?.ledger || []).find((l) => l.bookingId === bkTourist);
    check('language bonus 15 EUR at booking FX in wallet ledger (cert rule UNCHANGED)', !!tourLine && tourLine.languageBonusEgp === Math.round(15 * fxEur), JSON.stringify(tourLine));
    // 21e. favorites (patient role; provider must exist + verified).
    r = await req('POST', '/api/me/favorites', { token: patientToken2, body: { providerId: 'prov_demo_starter' } });
    check('favorite unverified provider -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/me/favorites', { token: patientToken2, body: { providerId: 'prov_demo_pro' } });
    check('favorite verified provider -> 201', r.status === 201, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/me/favorites', { token: patientToken2 });
    check('favorites list shows provider with tier + touristCompatible', r.status === 200 && (r.json?.favorites || []).some((f) => f.providerId === 'prov_demo_pro' && f.touristCompatible === true), JSON.stringify(r.json?.favorites));
    r = await req('DELETE', '/api/me/favorites/prov_demo_pro', { token: patientToken2 });
    check('unfavorite -> 200', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/me/favorites', { token: patientToken2 });
    check('favorites empty after delete', r.status === 200 && (r.json?.favorites || []).length === 0, JSON.stringify(r.json?.favorites));
    // 21f. medical-file interest (placeholder) + dashboard count.
    r = await req('POST', '/api/medical-file-interest', { body: { phone: '01012345678' } });
    check('medical-file interest first call -> recorded true', r.status === 200 && r.json?.ok === true && r.json?.recorded === true, JSON.stringify(r.json));
    r = await req('POST', '/api/medical-file-interest', { body: { phone: '01012345678' } });
    check('medical-file interest repeat phone -> recorded false', r.status === 200 && r.json?.recorded === false, JSON.stringify(r.json));
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('dashboard carries medicalFileInterestCount 1', r.status === 200 && r.json?.medicalFileInterestCount === 1, JSON.stringify({ medicalFileInterestCount: r.json?.medicalFileInterestCount }));
    // 21g. monitor endpoint (token set in spawn env).
    r = await req('GET', '/api/monitor/summary');
    check('monitor without token -> 401', r.status === 401, JSON.stringify(r.json));
    r = await req('GET', '/api/monitor/summary', { monitorToken: 'wrong-token' });
    check('monitor with wrong token -> 401', r.status === 401, JSON.stringify(r.json));
    r = await req('GET', '/api/monitor/summary', { monitorToken: 'monitor-test-token' });
    check('monitor with correct token -> 200, read-only shape, no PII', r.status === 200 && r.json?.bookingsToday && r.json?.settlement && r.json?.medicalFileInterestCount === 1 && !JSON.stringify(r.json).includes('010') && !JSON.stringify(r.json).includes('Test '), JSON.stringify(r.json)?.slice(0, 300));
    // v2.1.1 — repeat-booking rate (owner's launch metric): overall + last
    // 30 days, counts + rate 0..1, no PII. The run completed many bookings
    // for the same patient phone, so overall repeatPatients must be >= 1.
    const rbr = r.json?.repeatBookingRate;
    check('monitor repeat-booking rate shape (overall + last30Days)', !!rbr && typeof rbr.overall?.rate === 'number' && rbr.overall.rate >= 0 && rbr.overall.rate <= 1 && Number.isInteger(rbr.overall.patientsWithCompleted) && Number.isInteger(rbr.overall.repeatPatients) && typeof rbr.last30Days?.rate === 'number' && rbr.last30Days.rate >= 0 && rbr.last30Days.rate <= 1, JSON.stringify(rbr));
    check('monitor repeat-booking rate: repeat patients exist', rbr?.overall?.repeatPatients >= 1 && rbr?.overall?.patientsWithCompleted >= 1, JSON.stringify(rbr));
    // Monitor looks disabled (404) when MUSE_MONITOR_TOKEN is unset:
    // second server, same code, no token in env.
    const DATA2 = path.join(__dirname, 'smoke-data-2.json');
    if (fs.existsSync(DATA2)) fs.unlinkSync(DATA2);
    const env2 = { ...process.env, PORT: '3458', NODE_ENV: 'test', DATA_FILE: DATA2, MOCK_OTP: 'true',
      JWT_SECRET: 'smoke-test-secret', ADMIN_PIN: TEST_ADMIN_PIN, AUTO_RELEASE_MS: '1000',
      BOOKING_LIMIT_MAX: '1000', CANCEL_WINDOW_MS: '5000' };
    const child2 = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
    let up2 = false;
    for (let i = 0; i < 40; i++) { try { const rr = await fetch('http://127.0.0.1:3458/health'); if (rr.ok) { up2 = true; break; } } catch {} await sleep(250); }
    check('second server (no monitor token) starts', up2);
    if (up2) {
      const rr = await fetch('http://127.0.0.1:3458/api/monitor/summary');
      check('monitor unset -> 404 not_found', rr.status === 404, `got ${rr.status}`);
    }
    try { child2.kill('SIGTERM'); } catch {}
    await sleep(500);
    if (fs.existsSync(DATA2)) fs.unlinkSync(DATA2);
    // 21h. CORS: app origins allowed, evil origin rejected.
    r = await req('GET', '/api/bootstrap', { origin: 'http://localhost' });
    check('CORS localhost origin allowed', r.status === 200 && r.acao === 'http://localhost', JSON.stringify(r.acao));
    r = await req('GET', '/api/bootstrap', { origin: 'https://evil.example' });
    check('CORS evil origin rejected (403)', r.status === 403, JSON.stringify(r.json)?.slice(0, 150));
    // 21i. refresh reuse detection (M9): rotate, replay old -> 401,
    // then the rotated token is dead too (whole family revoked).
    const rl = await req('POST', '/api/auth/login-phone', { body: { phone: '01012345678' } });
    const rt1 = rl.json?.refreshToken;
    check('fresh login for refresh-reuse test', rl.status === 200 && !!rt1, JSON.stringify(rl.json)?.slice(0, 150));
    r = await req('POST', '/api/auth/refresh', { body: { refreshToken: rt1 } });
    check('refresh rotates to a new refresh token', r.status === 200 && !!r.json?.refreshToken && r.json.refreshToken !== rt1, JSON.stringify(r.json)?.slice(0, 150));
    const rt2 = r.json?.refreshToken;
    r = await req('POST', '/api/auth/refresh', { body: { refreshToken: rt1 } });
    check('replay of rotated refresh token -> 401 (reuse)', r.status === 401, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/refresh', { body: { refreshToken: rt2 } });
    check('rotated token rejected after reuse (family revoked)', r.status === 401, JSON.stringify(r.json));
    // 21j. points snapshot + admin credentials (+5 each, verified only).
    r = await req('GET', '/api/providers/me', { token: provToken });
    check('provider me exposes points snapshot', r.status === 200 && typeof r.json?.points?.total === 'number' && typeof r.json?.points?.tier === 'string' && 'nextTier' in (r.json?.points || {}) && typeof r.json?.points?.weeklyDoubleActive === 'boolean', JSON.stringify(r.json?.points));
    const ptsBefore = r.json?.points?.total;
    r = await req('POST', '/api/admin/providers/prov_demo_pro/credentials', { token: adminToken, body: { kind: 'certificate', name: 'BLS', verified: true } });
    check('admin adds verified certificate -> 201, +5 points', r.status === 201 && r.json?.points?.certificates === 5, JSON.stringify(r.json?.points));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/credentials', { token: adminToken, body: { kind: 'course', name: 'Wound Care', verified: false } });
    check('admin adds unverified course -> 201, no points yet', r.status === 201 && r.json?.points?.courses === 0, JSON.stringify(r.json?.points));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/credentials/0/verify?kind=course', { token: adminToken, body: { verified: true } });
    check('admin verifies course -> +5 points, total +10 overall', r.status === 200 && r.json?.points?.courses === 5 && r.json?.points?.total === ptsBefore + 10, JSON.stringify(r.json?.points));
    // 21k. stay bonus (not yet earned) + buddy (Elite only).
    r = await req('POST', '/api/admin/providers/prov_demo_pro/buddy', { token: adminToken, body: { buddyProviderId: 'prov_demo_starter' } });
    check('buddy must be Elite -> 400 for Starter', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/admin/providers/prov_demo_pro/buddy', { token: adminToken, body: { buddyProviderId: asstProviderId } });
    check('Elite assistant assigned as buddy -> 200', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    check('wallet shows buddy + stay bonus 250 not yet earned', r.status === 200 && r.json?.buddy?.id === asstProviderId && !!r.json?.buddy?.name && r.json?.stayBonus?.amountEgp === 250 && r.json?.stayBonus?.earned === false && r.json?.stayBonus?.paid === false && typeof r.json?.daysSinceJoin === 'number', JSON.stringify({ buddy: r.json?.buddy, stayBonus: r.json?.stayBonus, daysSinceJoin: r.json?.daysSinceJoin }));
    // 21l. settlements + export (backup mitigation).
    r = await req('POST', '/api/jobs/sweep', { token: adminToken });
    check('sweep runs for settlements', r.status === 200 && typeof r.json?.settlementsGenerated === 'number', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/admin/settlements', { token: adminToken });
    check('admin settlements list has this-week records', r.status === 200 && Array.isArray(r.json?.settlements) && r.json.settlements.length >= 1 && r.json.settlements.every((x) => x.providerId && x.weekKey), JSON.stringify(r.json?.settlements?.slice(0, 1)));
    r = await req('GET', `/api/admin/settlements?providerId=${phys.providerId}`, { token: adminToken });
    check('settlements filter by provider (physio)', r.status === 200 && (r.json?.settlements || []).every((x) => x.providerId === phys.providerId) && r.json.count >= 1, JSON.stringify({ count: r.json?.count }));
    r = await req('GET', '/api/admin/export', { token: adminToken });
    check('admin export returns full data.json', r.status === 200 && r.json?.providers && r.json?.bookings && r.json?.providers['prov_demo_pro'], JSON.stringify(Object.keys(r.json || {})));
    // 21n. explicit written consent for high-risk services (v2.1.1).
    r = await bookStd('catheter_insert', { doctorOrder: order });
    check('high-risk booking WITHOUT consentGiven -> 400 explicit_consent_required', r.status === 400 && r.json?.error === 'explicit_consent_required', JSON.stringify(r.json)?.slice(0, 200));
    r = await bookStd('catheter_insert', { doctorOrder: order, consentGiven: true });
    check('high-risk booking WITH consentGiven -> 201, consent stored', r.status === 201 && r.json?.consent?.given === true && r.json?.consent?.version === '1.0' && !!r.json?.consent?.at, JSON.stringify(r.json?.consent));
    r = await bookStd('standard');
    check('standard booking without consent -> 201, no consent object', r.status === 201 && r.json?.consent == null, JSON.stringify(r.json?.consent));
    r = await req('POST', '/api/npwt/bookings', { token: patientToken2, body: { ...npwtBody, consentGiven: false, doctorOrder: order,
      safetyChecklist: { foamCountConfirmed: true, bleedingChecked: true, canisterChecked: true, woundPhotoConfirmed: true } } });
    check('NPWT booking WITHOUT consent -> 400 explicit_consent_required', r.status === 400 && r.json?.error === 'explicit_consent_required', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/npwt/bookings', { token: patientToken2, body: { ...npwtBody, doctorOrder: order,
      safetyChecklist: { foamCountConfirmed: true, bleedingChecked: true, canisterChecked: true, woundPhotoConfirmed: true } } });
    check('NPWT booking WITH consent -> 201, consent stored', r.status === 201 && r.json?.consent?.given === true && r.json?.consent?.version === '1.0', JSON.stringify(r.json?.consent));

    // 21m. SOS cap: 5/day per booking, 6th -> 429.
    r = await bookStd('standard');
    check('SOS test booking created', r.status === 201, JSON.stringify(r.json)?.slice(0, 200));
    const bkSos = r.json?.id;
    r = await req('POST', `/api/bookings/${bkSos}/accept`, { token: provToken });
    check('SOS test booking accepted', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    let sosOk = 0;
    for (let i = 0; i < 5; i++) { const sr = await req('POST', `/api/bookings/${bkSos}/sos`, { token: provToken }); if (sr.status === 201) sosOk++; }
    check('5 SOS alerts accepted in one day', sosOk === 5, `got ${sosOk}`);
    r = await req('POST', `/api/bookings/${bkSos}/sos`, { token: provToken });
    check('6th SOS same day -> 429', r.status === 429, JSON.stringify(r.json)?.slice(0, 200));

    // --- 22. v2.1.2 coverage: language tests, documents + evaluation, ---
    //     applications queue, receipt-photo confirmation, terms clause --
    console.log('\n[v2.1.2 coverage]');
    // 22a. languages list (public) + bootstrap.
    r = await req('GET', '/api/languages');
    check('GET /api/languages public -> 7 seeded languages, all testable', r.status === 200 && Array.isArray(r.json?.languages) && r.json.languages.length === 7 && r.json.languages.every((l) => l.testAvailable === true) && r.json?.test?.passMin === 6 && r.json?.test?.questionsPerTest === 8, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('GET', '/api/bootstrap');
    check('bootstrap carries languages (7) + languageTest passMin 6', r.status === 200 && Array.isArray(r.json?.languages) && r.json.languages.length === 7 && r.json?.languageTest?.passMin === 6, JSON.stringify({ languages: (r.json?.languages || []).length, languageTest: r.json?.languageTest }));
    // 22b. language-test rules (physio provider: interview passed, no badges yet).
    r = await req('POST', '/api/me/language-tests/xx/start', { token: phys.token });
    check('language test unknown code -> 404', r.status === 404, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/me/language-tests/ru/submit', { token: phys.token, body: { answers: {} } });
    check('language test submit without start -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/me/language-tests/en/start', { token: phys.token });
    check('language test start -> 200, 8 questions, 15 min, no answers leaked', r.status === 200 && Array.isArray(r.json?.questions) && r.json.questions.length === 8 && r.json?.minutes === 15 && !JSON.stringify(r.json).includes('"correct"'), JSON.stringify(r.json)?.slice(0, 300));
    const ltAttempt = r.json?.attemptId;
    // v2.1.6 (C5): wrong answers are VALID positions (the wrong option),
    // not raw letters — raw letters are rejected with 400 (tested in §27).
    const ltWrong = {};
    for (const q of r.json?.questions || []) {
      const bankQ = LANGUAGE_TESTS.en.find((x) => x.id === q.id);
      const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
      const correctIdx = q.options.findIndex((o) => o.text === correctText);
      ltWrong[q.id] = (correctIdx + 1) % q.options.length;
    }
    r = await req('POST', '/api/me/language-tests/en/submit', { token: phys.token, body: { attemptId: ltAttempt, answers: ltWrong } });
    check('language test all-wrong -> 200, failed 0/8, retake in 7 days', r.status === 200 && r.json?.passed === false && r.json?.score === 0 && !!r.json?.canRetakeAt, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', '/api/me/language-tests/en/start', { token: phys.token });
    check('language test immediate retake -> 409 retake_blocked', r.status === 409 && r.json?.error === 'retake_blocked' && !!r.json?.canRetakeAt, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/me/language-badges', { token: phys.token });
    check('language badges show failed attempt (1 attempt, lastScore 0, no badge)', r.status === 200 && r.json?.tests?.en?.attempts === 1 && r.json?.tests?.en?.lastScore === 0 && !r.json?.badges?.en, JSON.stringify(r.json?.tests?.en));
    r = await req('POST', '/api/me/language-tests/en/start', { token: provToken });
    check('already-passed English test cannot be retaken -> 409 already_passed', r.status === 409 && r.json?.error === 'already_passed', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/admin/languages', { token: adminToken, body: { code: 'sw', nameAr: 'السواحيلية', nameEn: 'Swahili', nativeName: 'Kiswahili' } });
    check('admin adds a language -> 201, testAvailable false (no bank yet)', r.status === 201 && r.json?.code === 'sw' && r.json?.testAvailable === false, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/admin/languages', { token: adminToken, body: { code: 'sw', nameAr: 'x', nameEn: 'y' } });
    check('duplicate language -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/languages');
    check('languages list now 8 (sw added, untestable)', r.status === 200 && r.json?.languages?.length === 8 && r.json.languages.find((l) => l.code === 'sw')?.testAvailable === false, JSON.stringify((r.json?.languages || []).map((l) => l.code)));
    r = await req('POST', '/api/me/language-tests/sw/start', { token: phys.token });
    check('language without a bank -> 409 test_unavailable', r.status === 409 && r.json?.error === 'test_unavailable', JSON.stringify(r.json)?.slice(0, 200));
    // 22c. documents + algorithmic evaluation (physio provider).
    r = await req('POST', '/api/me/documents', { token: phys.token, body: { kind: 'cv', name: 'my-cv.pdf', data: DOC_PDF } });
    check('upload CV pdf -> 201 with evaluation breakdown + recommendation', r.status === 201 && !!r.json?.evaluation && typeof r.json.evaluation.total === 'number' && !!r.json.evaluation.breakdown?.licence && !!r.json.evaluation.recommendation, JSON.stringify(r.json?.evaluation)?.slice(0, 300));
    const cvDocId = r.json?.document?.id;
    r = await req('GET', '/api/me/documents', { token: phys.token });
    check('my documents list -> 1 doc, metadata only (no file content)', r.status === 200 && (r.json?.documents || []).length === 1 && !JSON.stringify(r.json?.documents).includes('data:application'), JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', '/api/me/documents', { token: phys.token, body: { kind: 'certificate', name: 'note.txt', data: DOC_TEXT } });
    check('document wrong mime (text/plain) -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    const bigDoc = 'data:application/pdf;base64,' + Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    r = await req('POST', '/api/me/documents', { token: phys.token, body: { kind: 'certificate', name: 'big.pdf', data: bigDoc } });
    check('document over 5 MB -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    for (let i = 0; i < 9; i++) {
      await req('POST', '/api/me/documents', { token: phys.token, body: { kind: 'other', name: `filler-${i}.pdf`, data: DOC_PDF } });
    }
    r = await req('POST', '/api/me/documents', { token: phys.token, body: { kind: 'other', name: 'eleventh.pdf', data: DOC_PDF } });
    check('11th document -> 409 too_many_documents', r.status === 409 && r.json?.error === 'too_many_documents', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', `/api/admin/providers/${phys.providerId}/documents/${cvDocId}`, { token: adminToken });
    check('admin reads document WITH content -> 200, data URL present', r.status === 200 && typeof r.json?.data === 'string' && r.json.data.startsWith('data:application/pdf'), JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', `/api/admin/providers/${phys.providerId}/documents/doc_nope`, { token: adminToken });
    check('admin reads unknown document -> 404', r.status === 404, JSON.stringify(r.json)?.slice(0, 200));
    // 22d. admin review queue: approve + reject, monitor sees no PII.
    const appA = await registerProvider('01018181818', 'nurse', { certificates: [{ name: 'BLS' }] });
    check('application provider A registers -> 201 pending', appA.regStatus === 201, JSON.stringify(appA.reg)?.slice(0, 200));
    r = await req('GET', '/api/admin/applications', { token: adminToken });
    check('applications queue lists A with evaluation + interview + points', r.status === 200 && (r.json?.applications || []).some((a) => a.providerId === appA.providerId && !!a.cvEvaluation && typeof a.cvEvaluation.total === 'number' && !!a.cvEvaluation.recommendation && a.points), JSON.stringify((r.json?.applications || []).map((a) => a.providerId)));
    r = await req('GET', '/api/monitor/summary', { monitorToken: 'monitor-test-token' });
    const pendApp = (r.json?.pendingApplications?.items || []).find((a) => a.providerId === appA.providerId);
    check('monitor pendingApplications has A with scores, no PII', r.status === 200 && !!pendApp && typeof pendApp.cvScore === 'number' && !('phone' in pendApp) && !('name' in pendApp) && !JSON.stringify(pendApp).includes('01018181818'), JSON.stringify(pendApp));
    r = await req('POST', `/api/admin/applications/${appA.providerId}/approve`, { token: adminToken });
    check('admin approves application A -> 200 verified', r.status === 200 && r.json?.status === 'verified', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/applications/${appA.providerId}/approve`, { token: adminToken });
    check('approving an already-verified application -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    const appB = await registerProvider('01019191919', 'nurse', { certificates: [{ name: 'BLS' }] });
    check('application provider B registers -> 201 pending', appB.regStatus === 201, JSON.stringify(appB.reg)?.slice(0, 200));
    r = await req('POST', `/api/admin/applications/${appB.providerId}/reject`, { token: adminToken, body: { reason: 'Documents unclear.' } });
    check('admin rejects application B -> 200 rejected with reason', r.status === 200 && r.json?.status === 'rejected' && r.json?.rejectionReason === 'Documents unclear.', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/admin/applications?status=rejected', { token: adminToken });
    check('rejected applications list contains B', r.status === 200 && (r.json?.applications || []).some((a) => a.providerId === appB.providerId), JSON.stringify((r.json?.applications || []).map((a) => a.providerId)));
    // 22e. receipt-photo payment confirmation.
    const bookReceipt = async (paymentMethod, extra = {}) => req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Receipt Patient', serviceCode: 'standard', paymentMethod,
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] }, ...extra,
    } });
    r = await bookReceipt('cash_receipt', { receiptImage: RECEIPT_JPEG });
    check('cash booking with receipt photo -> 400 (receipt at the visit)', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await bookReceipt('instapay', { receiptImage: DOC_TEXT });
    check('instapay booking with non-image receipt -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    const bigReceipt = 'data:image/jpeg;base64,' + Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64');
    r = await bookReceipt('instapay', { receiptImage: bigReceipt });
    check('instapay booking with receipt over 3 MB -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await bookReceipt('instapay', { receiptImage: RECEIPT_JPEG });
    check('instapay booking with receipt -> 201, receipt pending', r.status === 201 && r.json?.receipt?.status === 'pending', JSON.stringify(r.json?.receipt));
    const bkReceipt = r.json?.id;
    r = await req('GET', '/api/providers/radar', { token: provToken });
    check('receipt-pending booking hidden from radar', r.status === 200 && !(r.json?.pending || []).some((b) => b.id === bkReceipt), JSON.stringify((r.json?.pending || []).map((b) => b.id)));
    r = await req('POST', `/api/bookings/${bkReceipt}/accept`, { token: provToken });
    check('receipt-pending booking cannot be accepted -> 403 receipt_pending_review', r.status === 403 && r.json?.error === 'receipt_pending_review', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', `/api/bookings/${bkReceipt}`, { token: patientToken2 });
    check('patient sees receipt status pending in booking details', r.status === 200 && r.json?.receipt?.status === 'pending', JSON.stringify(r.json?.receipt));
    r = await req('GET', `/api/admin/bookings/${bkReceipt}/receipt`, { token: adminToken });
    check('admin reads receipt image -> 200, data URL present', r.status === 200 && typeof r.json?.image === 'string' && r.json.image.startsWith('data:image/jpeg'), JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/bookings/${bkReceipt}/receipt/approve`, { token: adminToken, body: {} });
    check('admin approves receipt -> 200 approved', r.status === 200 && r.json?.receipt?.status === 'approved' && !!r.json?.receipt?.reviewedAt, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkReceipt}/accept`, { token: provToken });
    check('receipt-approved booking accepts -> 200', r.status === 200 && r.json?.status === 'accepted', JSON.stringify(r.json)?.slice(0, 200));
    // Second receipt booking: reject (note required), re-upload, approve.
    r = await bookReceipt('instapay', { receiptImage: RECEIPT_JPEG });
    check('second instapay booking with receipt -> 201 pending', r.status === 201 && r.json?.receipt?.status === 'pending', JSON.stringify(r.json?.receipt));
    const bkReceipt2 = r.json?.id;
    r = await req('GET', '/api/monitor/summary', { monitorToken: 'monitor-test-token' });
    check('monitor pendingReceipts counts the open receipt', r.status === 200 && (r.json?.pendingReceipts?.count || 0) >= 1 && (r.json?.pendingReceipts?.items || []).some((x) => x.id === bkReceipt2), JSON.stringify(r.json?.pendingReceipts));
    r = await req('POST', `/api/admin/bookings/${bkReceipt2}/receipt/reject`, { token: adminToken, body: {} });
    check('receipt reject without a note -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/bookings/${bkReceipt2}/receipt/reject`, { token: adminToken, body: { note: 'Blurry photo — please re-upload.' } });
    check('receipt reject with note -> 200 rejected', r.status === 200 && r.json?.receipt?.status === 'rejected' && r.json?.receipt?.note === 'Blurry photo — please re-upload.', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkReceipt2}/receipt`, { token: patientToken2, body: { receiptImage: RECEIPT_JPEG } });
    check('patient re-uploads receipt after rejection -> 201 pending again', r.status === 201 && r.json?.receipt?.status === 'pending', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkReceipt2}/receipt`, { token: patientToken2, body: { receiptImage: RECEIPT_JPEG } });
    check('receipt re-upload while one is pending -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/bookings/${bkReceipt2}/receipt/approve`, { token: adminToken, body: {} });
    check('admin approves re-uploaded receipt -> 200', r.status === 200 && r.json?.receipt?.status === 'approved', JSON.stringify(r.json)?.slice(0, 200));
    // Receipt upload endpoint on a cash booking -> 400.
    r = await bookReceipt('cash_receipt');
    check('cash booking (no receipt) -> 201, receipt null', r.status === 201 && r.json?.receipt === null, JSON.stringify(r.json?.receipt));
    const bkCash = r.json?.id;
    r = await req('POST', `/api/bookings/${bkCash}/receipt`, { token: patientToken2, body: { receiptImage: RECEIPT_JPEG } });
    check('receipt upload on a cash booking -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    // 22f. terms: intermediary clause in both languages, version stays 1.0.
    r = await req('GET', '/api/terms');
    check('terms v1.0 carries the intermediary clause (AR + EN)', r.status === 200 && r.json?.version === '1.0' && String(r.json?.textAr || '').includes('وسيط تقني يربط بينهما') && String(r.json?.textEn || '').includes('technical intermediary'), JSON.stringify({ version: r.json?.version }));

    // --- 23. v2.1.3 coverage: monthly packages + shift prices ----------
    console.log('\n[v2.1.3 coverage]');
    const TODAY = new Date().toISOString().slice(0, 10);
    // 23a. bootstrap: 8 local packages (care-level ladder) + packageConfig.
    r = await req('GET', '/api/bootstrap');
    const pkgs = r.json?.packages || [];
    const pkgByCode = (c) => pkgs.find((p) => p.code === c);
    check('bootstrap carries 8 monthly packages (ladder) with exact owner prices', pkgs.length === 8 && pkgByCode('package_assistant_12')?.priceEgp === 8000 && pkgByCode('package_assistant_12')?.originalEgp === 9100 && pkgByCode('package_assistant_24')?.priceEgp === 13700 && pkgByCode('package_assistant_24')?.originalEgp === 15600 && pkgByCode('package_technician_12')?.priceEgp === 12600 && pkgByCode('package_technician_12')?.originalEgp === 14300 && pkgByCode('package_technician_24')?.priceEgp === 21700 && pkgByCode('package_technician_24')?.originalEgp === 24700 && pkgByCode('package_specialist_12')?.priceEgp === 17200 && pkgByCode('package_specialist_12')?.originalEgp === 19500 && pkgByCode('package_specialist_24')?.priceEgp === 28600 && pkgByCode('package_specialist_24')?.originalEgp === 32500 && pkgByCode('package_elderly_mobile')?.priceEgp === 8000 && pkgByCode('package_elderly_mobile')?.originalEgp === 9100 && pkgByCode('package_elderly_bedridden')?.priceEgp === 12600 && pkgByCode('package_elderly_bedridden')?.originalEgp === 14300, JSON.stringify(pkgs));
    check('bootstrap packages carry levels (assistant/technician/specialist) + daily rates', pkgByCode('package_assistant_12')?.level === 'assistant' && pkgByCode('package_assistant_12')?.dailyRateEgp === 350 && pkgByCode('package_technician_12')?.level === 'technician' && pkgByCode('package_technician_12')?.dailyRateEgp === 550 && pkgByCode('package_specialist_24')?.level === 'specialist' && pkgByCode('package_specialist_24')?.dailyRateEgp === 1250 && pkgByCode('package_elderly_mobile')?.level === 'assistant' && pkgByCode('package_elderly_bedridden')?.level === 'technician', JSON.stringify(pkgs.map((p) => ({ code: p.code, level: p.level, daily: p.dailyRateEgp }))));
    check('bootstrap has NO old package codes/prices (package12/16,000/28,000 deleted)', !pkgs.some((p) => p.code === 'package12' || p.code === 'package24') && !pkgs.some((p) => p.priceEgp === 16000 || p.priceEgp === 28000), JSON.stringify(pkgs.map((p) => p.code)));
    check('bootstrap packageConfig: 26+4 days, +25% overtime, premium NOT waived by default', r.json?.packageConfig?.days === 26 && r.json?.packageConfig?.offDays === 4 && r.json?.packageConfig?.overtimePremiumPct === 25 && r.json?.packageConfig?.overtimePremiumWaived === false && Array.isArray(r.json?.packageConfig?.conditions) && r.json?.packageConfig?.conditions.length >= 9 && Array.isArray(r.json?.packageConfig?.needs) && r.json?.packageConfig?.needs.length >= 10, JSON.stringify(r.json?.packageConfig));
    // 23b. request validation.
    const pkgReq = async (body) => req('POST', '/api/package-requests', { token: patientToken2, body: { ...TERMS, patientName: 'Package Patient', packageType: 'package_technician_12', condition: 'After hip surgery, needs daily care', conditionItems: ['post_surgery'], diagnosis: 'Post hip replacement', treatment: 'Painkillers + antibiotics', needs: ['mobility', 'wound_care'], startDate: TODAY, address: 'Quseir, Corniche St 12', distanceKm: 3, notes: '', ...body } });
    r = await pkgReq({ packageType: 'nope' });
    check('package request unknown type -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await pkgReq({ condition: '' });
    check('package request without condition -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await pkgReq({ startDate: '2020-01-05' });
    check('package request past start date -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await pkgReq({ needs: ['teleport'] });
    check('package request unknown need -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/package-requests', { token: patientToken2, body: { patientName: 'X', packageType: 'package_technician_12', condition: 'x', startDate: TODAY, address: 'Quseir' } });
    check('package request without terms -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    // 23c. request A (overtime) -> quote -> accept (cash).
    // NOTE: no new provider registrations here — the suite already hit
    // the per-IP registration rate limit by §22. Reuse providers from
    // §6: ethicsProv (registered, interview failed, NOT verified) for
    // the unverified-quote check, manualProv (interview passed by admin)
    // as the substitute (verified below, no new registration needed).
    // The demo provider's tier drifts by §23 (points auto-promotion),
    // so commission expectations are computed from the LOCKED commission
    // the accept response itself reports — never hardcoded to 15%.
    r = await pkgReq({});
    check('package request A created -> 201 submitted', r.status === 201 && r.json?.status === 'submitted' && !!r.json?.id, JSON.stringify(r.json)?.slice(0, 300));
    const pkrA = r.json?.id;
    r = await req('GET', '/api/package-requests/mine', { token: patientToken2 });
    check('my package requests lists A', r.status === 200 && (r.json?.requests || []).some((x) => x.id === pkrA), JSON.stringify((r.json?.requests || []).map((x) => x.id)));
    r = await req('GET', '/api/admin/package-requests', { token: adminToken });
    check('admin package-requests queue lists A', r.status === 200 && (r.json?.requests || []).some((x) => x.id === pkrA), JSON.stringify((r.json?.requests || []).map((x) => x.id)));
    // Quote validation: unverified provider -> 409; bad price -> 400.
    r = await req('POST', `/api/admin/package-requests/${pkrA}/quote`, { token: adminToken, body: { finalPriceEgp: 12600, providerId: ethicsProv.providerId } });
    check('quote with unverified provider -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/package-requests/${pkrA}/quote`, { token: adminToken, body: { finalPriceEgp: -5, providerId: 'prov_demo_pro' } });
    check('quote with bad price -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/package-requests/${pkrA}/quote`, { token: adminToken, body: { finalPriceEgp: 12600, providerId: 'prov_demo_pro', extraDaysOption: 'substitute' } });
    check('quote substitute without substituteProviderId -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    // Quote A: verified demo provider, overtime extra days.
    // Technician 12h: base 12,600; overtime 550 × 1.25 = 687.5 → 690
    // (nearest 5) → 4 × 690 = 2,760 → total 15,360.
    r = await req('POST', `/api/admin/package-requests/${pkrA}/quote`, { token: adminToken, body: { finalPriceEgp: 12600, providerId: 'prov_demo_pro', extraDaysOption: 'overtime', quoteNote: 'Standard case.' } });
    check('quote A -> 200 quoted, total 12600 + 4x690 overtime = 15360', r.status === 200 && r.json?.status === 'quoted' && r.json?.quote?.finalPriceEgp === 12600 && r.json?.quote?.totalEgp === 15360 && r.json?.quote?.extraDays?.option === 'overtime' && r.json?.quote?.extraDays?.dailyRateEgp === 690 && r.json?.quote?.extraDays?.priceEgp === 2760 && r.json?.quote?.level === 'technician', JSON.stringify(r.json?.quote));
    r = await req('POST', `/api/package-requests/${pkrA}/accept`, { token: patientToken2, body: { ...TERMS, paymentMethod: 'card' } });
    check('accept with bad payment method -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/package-requests/${pkrA}/accept`, { token: patientToken2, body: { ...TERMS, paymentMethod: 'cash_receipt' } });
    const pctA = r.json?.commissionPct;
    const estA = Math.round(15360 * (1 - pctA / 100));
    check('accept A cash -> 201 accepted package booking, commission locked, total 15360, est share matches', r.status === 201 && r.json?.kind === 'package' && r.json?.status === 'accepted' && r.json?.amountEgp === 15360 && typeof pctA === 'number' && r.json?.estimatedProviderShareEgp === estA && r.json?.canCancel === true && r.json?.daysCompleted === 0 && r.json?.level === 'technician', JSON.stringify(r.json)?.slice(0, 400));
    const pkgA = r.json?.id;
    // 23d. request B (substitute) — manualProv (interview passed by
    // admin in §6) becomes the substitute via the admin verify endpoint.
    r = await req('POST', `/api/admin/providers/${manualProv.providerId}/verify`, { token: adminToken, body: { role: 'nurse' } });
    check('admin verifies manual-review provider (substitute) -> verified', r.status === 200 && r.json?.status === 'verified', JSON.stringify(r.json)?.slice(0, 200));
    r = await pkgReq({ packageType: 'package_technician_24' });
    check('package request B created -> 201', r.status === 201 && !!r.json?.id, JSON.stringify(r.json)?.slice(0, 200));
    const pkrB = r.json?.id;
    r = await req('POST', `/api/admin/package-requests/${pkrB}/quote`, { token: adminToken, body: { finalPriceEgp: 21700, providerId: 'prov_demo_pro', extraDaysOption: 'substitute', substituteProviderId: manualProv.providerId } });
    check('quote B substitute -> total 21700 + 4x950 = 25500', r.status === 200 && r.json?.quote?.totalEgp === 25500 && r.json?.quote?.extraDays?.option === 'substitute' && r.json?.quote?.extraDays?.dailyRateEgp === 950 && r.json?.quote?.substituteProviderId === manualProv.providerId && r.json?.quote?.level === 'technician', JSON.stringify(r.json?.quote));
    r = await req('POST', `/api/package-requests/${pkrB}/accept`, { token: patientToken2, body: { ...TERMS, paymentMethod: 'cash_receipt' } });
    const pctB = r.json?.commissionPct;
    const estB = Math.round(25500 * (1 - pctB / 100));
    check('accept B cash -> 201, est share matches locked commission', r.status === 201 && r.json?.status === 'accepted' && r.json?.estimatedProviderShareEgp === estB, JSON.stringify(r.json)?.slice(0, 300));
    const pkgB = r.json?.id;
    // 23e. day logging rules (only TODAY is loggable — future days are rejected).
    r = await req('POST', `/api/bookings/${pkgA}/package-day`, { token: provToken, body: { date: '2030-01-05', type: 'regular' } });
    check('package day in the future -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${pkgA}/package-day`, { token: provToken, body: { date: TODAY, type: 'regular' } });
    check('main logs regular day today -> 200, rate 485 (12600/26)', r.status === 200 && r.json?.daysCompleted === 1 && (r.json?.daysLog || [])[0]?.rateEgp === 485, JSON.stringify(r.json?.daysLog));
    r = await req('POST', `/api/bookings/${pkgA}/package-day`, { token: provToken, body: { date: TODAY, type: 'regular' } });
    check('same day twice -> 409 duplicate', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${pkgB}/package-day`, { token: provToken, body: { date: TODAY, type: 'extra' } });
    check('main cannot log substitute extra days -> 403', r.status === 403, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${pkgB}/package-day`, { token: manualProv.token, body: { date: TODAY, type: 'regular' } });
    check('substitute cannot log regular days -> 403', r.status === 403, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${pkgB}/package-day`, { token: manualProv.token, body: { date: TODAY, type: 'extra' } });
    check('substitute logs extra day today -> 200, rate 950', r.status === 200 && r.json?.extraDaysCompleted === 1 && (r.json?.daysLog || [])[0]?.rateEgp === 950, JSON.stringify(r.json?.daysLog));
    r = await req('POST', `/api/bookings/${pkgB}/package-day`, { token: provToken, body: { date: TODAY, type: 'regular' } });
    check('main cannot log a day already logged (same date) -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    // 23f. monitor: pending request F + active packages A/B.
    r = await pkgReq({ packageType: 'package_elderly_mobile' });
    check('package request F created (stays submitted)', r.status === 201 && !!r.json?.id, JSON.stringify(r.json)?.slice(0, 200));
    const pkrF = r.json?.id;
    r = await req('GET', '/api/monitor/summary', { monitorToken: 'monitor-test-token' });
    check('monitor pendingPackageRequests has F, no PII', r.status === 200 && (r.json?.pendingPackageRequests?.count || 0) >= 1 && (r.json?.pendingPackageRequests?.items || []).some((x) => x.id === pkrF && x.packageType === 'package_elderly_mobile') && !JSON.stringify(r.json?.pendingPackageRequests).includes('010'), JSON.stringify(r.json?.pendingPackageRequests));
    check('monitor activePackages has A + B', r.status === 200 && (r.json?.activePackages?.count || 0) >= 2 && (r.json?.activePackages?.items || []).some((x) => x.id === pkgA) && (r.json?.activePackages?.items || []).some((x) => x.id === pkgB), JSON.stringify(r.json?.activePackages));
    // 23g. weekly sweep releases the logged days; wallets show them.
    // v2.1.6 (C7): a day releases only with EVIDENCE — the patient
    // confirms both days here (pkgA regular + pkgB extra) before the sweep.
    r = await req('POST', `/api/bookings/${pkgA}/package-day/${TODAY}/confirm`, { token: patientToken2 });
    check('patient confirms package A day -> 200', r.status === 200 && r.json?.patientConfirmed === true, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${pkgB}/package-day/${TODAY}/confirm`, { token: patientToken2 });
    check('patient confirms package B extra day -> 200', r.status === 200 && r.json?.patientConfirmed === true, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/jobs/sweep', { token: adminToken });
    check('sweep runs -> 200, 2 package days released', r.status === 200 && r.json?.packageDaysReleased === 2, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    const pkgALines = (r.json?.ledger || []).filter((l) => l.bookingId === pkgA);
    const appDayA = Math.round(485 * pctA / 100), provDayA = 485 - appDayA;
    check('main wallet: package A day line provider_owes_app (cash, locked % of 485)', r.status === 200 && pkgALines.some((l) => l.kind === 'package-day' && l.direction === 'provider_owes_app' && l.amountEgp === appDayA && l.days === 1), JSON.stringify(pkgALines));
    check('main wallet: package A remaining pending = est share - released provider share', pkgALines.some((l) => l.kind === 'package-remaining' && l.direction === 'pending' && l.amountEgp === estA - provDayA), JSON.stringify(pkgALines));
    r = await req('GET', '/api/providers/wallet', { token: manualProv.token });
    const pkgBLines = (r.json?.ledger || []).filter((l) => l.bookingId === pkgB);
    const appDayB = Math.round(950 * pctB / 100);
    check('sub wallet: package B extra day line provider_owes_app (cash, locked % of 950)', r.status === 200 && pkgBLines.some((l) => l.kind === 'package-day' && l.direction === 'provider_owes_app' && l.amountEgp === appDayB && l.days === 1), JSON.stringify(pkgBLines));
    // Thursday settlement record includes the package day (manualProv is
    // a REAL provider, not a demo seed — generateSettlements skips demos).
    r = await req('GET', `/api/admin/settlements?providerId=${manualProv.providerId}`, { token: adminToken });
    const stlB = (r.json?.settlements || [])[0];
    check('settlement record for substitute: packageDays 1, cash day app share only (C2 — provider holds the cash, owes the app share)', !!stlB && stlB.totals.packageDays === 1 && stlB.totals.packageProviderShareEgp === 0 && stlB.totals.packageCashAppShareEgp === appDayB && stlB.totals.providerOwesAppEgp === appDayB && stlB.totals.appOwesProviderEgp === 0, JSON.stringify(stlB?.totals));
    // 23h. package-complete guard (days incomplete, period not ended).
    r = await req('POST', `/api/bookings/${pkgA}/package-complete`, { token: provToken });
    check('package-complete with 1/26 days -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    // 23i. cancel after start: refund = paid - worked days at logged rates.
    r = await req('POST', `/api/bookings/${pkgA}/cancel`, { token: patientToken2 });
    check('cancel A after start -> refund 15360 - 485 = 14875', r.status === 200 && r.json?.status === 'cancelled' && r.json?.refundEgp === 14875, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/bookings/${pkgB}/cancel`, { token: patientToken2 });
    check('cancel B after start -> refund 25500 - 950 = 24550', r.status === 200 && r.json?.status === 'cancelled' && r.json?.refundEgp === 24550, JSON.stringify(r.json)?.slice(0, 300));
    // 23j. package C (future start, instapay + receipt) -> held -> approved -> accepted -> full refund cancel.
    r = await pkgReq({ packageType: 'package_elderly_mobile', startDate: '2030-01-05' });
    check('package request C created (future start)', r.status === 201 && !!r.json?.id, JSON.stringify(r.json)?.slice(0, 200));
    const pkrC = r.json?.id;
    r = await req('POST', `/api/admin/package-requests/${pkrC}/quote`, { token: adminToken, body: { finalPriceEgp: 8000, providerId: 'prov_demo_pro', extraDaysOption: 'none' } });
    check('quote C option none -> total 8000', r.status === 200 && r.json?.quote?.totalEgp === 8000 && r.json?.quote?.extraDays?.option === 'none', JSON.stringify(r.json?.quote));
    r = await req('POST', `/api/package-requests/${pkrC}/accept`, { token: patientToken2, body: { ...TERMS, paymentMethod: 'instapay', receiptImage: RECEIPT_JPEG } });
    check('accept C instapay+receipt -> 201 held', r.status === 201 && r.json?.status === 'held' && r.json?.receipt?.status === 'pending', JSON.stringify(r.json)?.slice(0, 300));
    const pkgC = r.json?.id;
    r = await req('POST', `/api/bookings/${pkgC}/package-day`, { token: provToken, body: { date: TODAY, type: 'regular' } });
    check('held package cannot log days -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/bookings/${pkgC}/receipt/approve`, { token: adminToken, body: {} });
    check('admin approves C receipt -> 200', r.status === 200 && r.json?.receipt?.status === 'approved', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', `/api/bookings/${pkgC}`, { token: patientToken2 });
    check('receipt approval activates the held package -> accepted', r.status === 200 && r.json?.status === 'accepted', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${pkgC}/cancel`, { token: patientToken2 });
    check('cancel C before start -> full refund 8000', r.status === 200 && r.json?.status === 'cancelled' && r.json?.refundEgp === 8000, JSON.stringify(r.json)?.slice(0, 300));
    // 23k. decline flow.
    r = await pkgReq({ packageType: 'package_elderly_bedridden' });
    check('package request D created', r.status === 201 && !!r.json?.id, JSON.stringify(r.json)?.slice(0, 200));
    const pkrD = r.json?.id;
    r = await req('POST', `/api/admin/package-requests/${pkrD}/quote`, { token: adminToken, body: { finalPriceEgp: 12600, providerId: 'prov_demo_pro', extraDaysOption: 'none' } });
    check('quote D -> quoted', r.status === 200 && r.json?.status === 'quoted', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/package-requests/${pkrD}/decline`, { token: patientToken2 });
    check('patient declines D -> declined', r.status === 200 && r.json?.status === 'declined', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/package-requests/${pkrD}/accept`, { token: patientToken2, body: { ...TERMS, paymentMethod: 'cash_receipt' } });
    check('accept a declined request -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    // 23l. launch offer: waive the overtime premium, quote F, un-waive.
    r = await req('POST', '/api/admin/package-offer', { token: adminToken, body: { overtimePremiumWaived: true } });
    check('admin sets package offer (premium waived) -> 200', r.status === 200 && r.json?.packageOffer?.overtimePremiumWaived === true, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/bootstrap');
    check('bootstrap packageConfig shows premium waived', r.json?.packageConfig?.overtimePremiumWaived === true, JSON.stringify(r.json?.packageConfig));
    r = await req('POST', `/api/admin/package-requests/${pkrF}/quote`, { token: adminToken, body: { finalPriceEgp: 8000, providerId: 'prov_demo_pro', extraDaysOption: 'overtime' } });
    check('quote F with premium waived -> extra day 350 (not 440), total 9400', r.status === 200 && r.json?.quote?.extraDays?.dailyRateEgp === 350 && r.json?.quote?.extraDays?.premiumWaived === true && r.json?.quote?.totalEgp === 9400, JSON.stringify(r.json?.quote));
    r = await req('POST', '/api/admin/package-offer', { token: adminToken, body: { overtimePremiumWaived: false } });
    check('admin clears package offer -> 200', r.status === 200 && r.json?.packageOffer?.overtimePremiumWaived === false, JSON.stringify(r.json)?.slice(0, 200));
    // 23m. terms §12 package clause (AR + EN), version stays 1.0.
    r = await req('GET', '/api/terms');
    check('terms v1.0 carries the monthly-packages clause (AR + EN) with the ladder + elderly treatment rule', r.status === 200 && r.json?.version === '1.0' && String(r.json?.textAr || '').includes('الباقات الشهرية') && String(r.json?.textAr || '').includes('26 يوم رعاية') && String(r.json?.textAr || '').includes('مساعد تمريض') && String(r.json?.textAr || '').includes('أخصائي تمريض') && String(r.json?.textAr || '').includes('8,000') && String(r.json?.textAr || '').includes('علاج المسن') && String(r.json?.textEn || '').includes('Monthly packages') && String(r.json?.textEn || '').includes('nursing assistant') && String(r.json?.textEn || '').includes('treatment/medications'), JSON.stringify({ version: r.json?.version }));
    check('terms carry NO old package prices (16,000 / 28,000 deleted)', r.status === 200 && !String(r.json?.textAr || '').includes('16,000') && !String(r.json?.textAr || '').includes('28,000') && !String(r.json?.textEn || '').includes('16,000') && !String(r.json?.textEn || '').includes('28,000'), JSON.stringify({ version: r.json?.version }));
    // 23n. admin dashboard carries package requests + bookings + offer.
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('admin dashboard has packageRequests (A–F) + packageBookings (A–C) + packageOffer', r.status === 200 && Array.isArray(r.json?.packageRequests) && (r.json?.packageRequests || []).some((x) => x.id === pkrA) && Array.isArray(r.json?.packageBookings) && (r.json?.packageBookings || []).some((x) => x.id === pkgA) && 'packageOffer' in r.json, JSON.stringify({ requests: (r.json?.packageRequests || []).length, bookings: (r.json?.packageBookings || []).length }));

    // --- 24. care-level ladder + tourist residence + elderly rule -------
  console.log('\n[§24 ladder/tourist/elderly]');
  // 24a. bootstrap: 8 local + 6 tourist packages, exact prices, levels, shiftHours.
  r = await req('GET', '/api/bootstrap');
  const bsPkgs = r.json?.packages || [];
  const bsTPkgs = r.json?.touristPackages || [];
  const pkg24ByCode = (list, code) => (list || []).find((p) => p.code === code);
  check('bootstrap packages: 8 local, exact new ladder prices + levels + shiftHours', bsPkgs.length === 8
    && pkg24ByCode(bsPkgs, 'package_assistant_12')?.priceEgp === 8000 && pkg24ByCode(bsPkgs, 'package_assistant_12')?.originalEgp === 9100 && pkg24ByCode(bsPkgs, 'package_assistant_12')?.dailyRateEgp === 350 && pkg24ByCode(bsPkgs, 'package_assistant_12')?.shiftHours === 12 && pkg24ByCode(bsPkgs, 'package_assistant_12')?.level === 'assistant'
    && pkg24ByCode(bsPkgs, 'package_assistant_24')?.priceEgp === 13700 && pkg24ByCode(bsPkgs, 'package_assistant_24')?.dailyRateEgp === 600
    && pkg24ByCode(bsPkgs, 'package_technician_12')?.priceEgp === 12600 && pkg24ByCode(bsPkgs, 'package_technician_12')?.dailyRateEgp === 550
    && pkg24ByCode(bsPkgs, 'package_technician_24')?.priceEgp === 21700 && pkg24ByCode(bsPkgs, 'package_technician_24')?.dailyRateEgp === 950
    && pkg24ByCode(bsPkgs, 'package_specialist_12')?.priceEgp === 17200 && pkg24ByCode(bsPkgs, 'package_specialist_12')?.dailyRateEgp === 750
    && pkg24ByCode(bsPkgs, 'package_specialist_24')?.priceEgp === 28600 && pkg24ByCode(bsPkgs, 'package_specialist_24')?.dailyRateEgp === 1250 && pkg24ByCode(bsPkgs, 'package_specialist_24')?.shiftHours === 24
    && pkg24ByCode(bsPkgs, 'package_elderly_mobile')?.priceEgp === 8000 && pkg24ByCode(bsPkgs, 'package_elderly_mobile')?.level === 'assistant'
    && pkg24ByCode(bsPkgs, 'package_elderly_bedridden')?.priceEgp === 12600 && pkg24ByCode(bsPkgs, 'package_elderly_bedridden')?.level === 'technician', JSON.stringify(bsPkgs.map((p) => `${p.code}:${p.priceEgp}/${p.originalEgp}/${p.level}`)));
  check('bootstrap touristPackages: 6, exact USD/EUR prices + levels', bsTPkgs.length === 6
    && pkg24ByCode(bsTPkgs, 'package_tourist_assistant_12')?.priceUsd === 575 && pkg24ByCode(bsTPkgs, 'package_tourist_assistant_12')?.priceEur === 530 && pkg24ByCode(bsTPkgs, 'package_tourist_assistant_12')?.dailyRateUsd === 25
    && pkg24ByCode(bsTPkgs, 'package_tourist_assistant_24')?.priceUsd === 1030 && pkg24ByCode(bsTPkgs, 'package_tourist_assistant_24')?.priceEur === 950 && pkg24ByCode(bsTPkgs, 'package_tourist_assistant_24')?.dailyRateUsd === 45
    && pkg24ByCode(bsTPkgs, 'package_tourist_technician_12')?.priceUsd === 800 && pkg24ByCode(bsTPkgs, 'package_tourist_technician_12')?.priceEur === 735 && pkg24ByCode(bsTPkgs, 'package_tourist_technician_12')?.dailyRateUsd === 35
    && pkg24ByCode(bsTPkgs, 'package_tourist_technician_24')?.priceUsd === 1375 && pkg24ByCode(bsTPkgs, 'package_tourist_technician_24')?.priceEur === 1265 && pkg24ByCode(bsTPkgs, 'package_tourist_technician_24')?.dailyRateUsd === 60
    && pkg24ByCode(bsTPkgs, 'package_tourist_specialist_12')?.priceUsd === 1030 && pkg24ByCode(bsTPkgs, 'package_tourist_specialist_12')?.priceEur === 950
    && pkg24ByCode(bsTPkgs, 'package_tourist_specialist_24')?.priceUsd === 1720 && pkg24ByCode(bsTPkgs, 'package_tourist_specialist_24')?.priceEur === 1580 && pkg24ByCode(bsTPkgs, 'package_tourist_specialist_24')?.dailyRateUsd === 75, JSON.stringify(bsTPkgs.map((p) => `${p.code}:${p.priceUsd}/${p.priceEur}`)));
  check('bootstrap packageConfig lists the 3 levels', Array.isArray(r.json?.packageConfig?.levels) && r.json.packageConfig.levels.join(',') === 'assistant,technician,specialist', JSON.stringify(r.json?.packageConfig));
  check('bootstrap has NO old package prices anywhere', !JSON.stringify(r.json).includes('16000') && !JSON.stringify(r.json).includes('28000'), JSON.stringify(bsPkgs.map((p) => p.priceEgp)));
  // 24b. request validation: level / currency / elderly treatment.
  r = await pkgReq({ packageType: 'package_assistant_12', level: 'technician' });
  check('request level mismatch -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
  r = await pkgReq({ packageType: 'package_assistant_12', level: 'nurse' });
  check('request unknown level -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
  r = await pkgReq({ packageType: 'package_technician_12', currency: 'USD' });
  check('request local package with USD -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
  r = await pkgReq({ packageType: 'package_tourist_technician_12', currency: 'EGP' });
  check('request tourist package with EGP -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
  r = await pkgReq({ packageType: 'package_tourist_technician_12' });
  check('request tourist package without currency -> 201, defaults USD, level technician', r.status === 201 && r.json?.currency === 'USD' && r.json?.level === 'technician', JSON.stringify(r.json)?.slice(0, 200));
  const pkrT0 = r.json?.id;
  r = await pkgReq({ packageType: 'package_elderly_mobile', treatment: '' });
  check('elderly request without treatment -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
  r = await pkgReq({ packageType: 'package_elderly_mobile' });
  check('elderly request with treatment -> 201, level assistant', r.status === 201 && r.json?.level === 'assistant', JSON.stringify(r.json)?.slice(0, 200));
  const pkrE = r.json?.id;
  // 24c. level gates in the quote.
  r = await pkgReq({ packageType: 'package_assistant_12' });
  const pkrAsst = r.json?.id;
  r = await req('POST', `/api/admin/package-requests/${pkrAsst}/quote`, { token: adminToken, body: { finalPriceEgp: 8000, providerId: asstProviderId, extraDaysOption: 'none' } });
  check('quote assistant package with the assistant -> 200, level assistant', r.status === 200 && r.json?.quote?.level === 'assistant' && r.json?.quote?.totalEgp === 8000, JSON.stringify(r.json?.quote));
  r = await pkgReq({ packageType: 'package_technician_12' });
  const pkrTech = r.json?.id;
  r = await req('POST', `/api/admin/package-requests/${pkrTech}/quote`, { token: adminToken, body: { finalPriceEgp: 12600, providerId: asstProviderId, extraDaysOption: 'none' } });
  check('quote technician package with the assistant -> 409 level gate', r.status === 409 && JSON.stringify(r.json).includes('nursing technician'), JSON.stringify(r.json)?.slice(0, 200));
  r = await req('POST', `/api/admin/providers/${manualProv.providerId}/tier`, { token: adminToken, body: { tier: 'Starter' } });
  check('manual provider set Starter for the specialist gate', r.status === 200 && r.json?.tier === 'Starter', JSON.stringify(r.json));
  r = await pkgReq({ packageType: 'package_specialist_12' });
  const pkrSpec = r.json?.id;
  r = await req('POST', `/api/admin/package-requests/${pkrSpec}/quote`, { token: adminToken, body: { finalPriceEgp: 17200, providerId: manualProv.providerId, extraDaysOption: 'none' } });
  check('quote specialist package with a Starter nurse -> 409 specialist gate', r.status === 409 && JSON.stringify(r.json).includes('nursing specialist'), JSON.stringify(r.json)?.slice(0, 200));
  r = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier: 'Pro' } });
  check('main provider set Pro for the specialist quote', r.status === 200 && r.json?.tier === 'Pro', JSON.stringify(r.json));
  r = await req('POST', `/api/admin/package-requests/${pkrSpec}/quote`, { token: adminToken, body: { finalPriceEgp: 17200, providerId: 'prov_demo_pro', extraDaysOption: 'none' } });
  check('quote specialist package with a Pro nurse -> 200, level specialist', r.status === 200 && r.json?.quote?.level === 'specialist' && r.json?.quote?.totalEgp === 17200, JSON.stringify(r.json?.quote));
  // 24d. admin raises the level in the quote (assistant -> technician).
  r = await pkgReq({ packageType: 'package_assistant_12' });
  const pkrRaise = r.json?.id;
  r = await req('POST', `/api/admin/package-requests/${pkrRaise}/quote`, { token: adminToken, body: { packageType: 'package_technician_12', finalPriceEgp: 12600, providerId: 'prov_demo_pro', extraDaysOption: 'none' } });
  check('admin raises assistant request to technician in the quote -> 200, level technician', r.status === 200 && r.json?.quote?.packageType === 'package_technician_12' && r.json?.quote?.level === 'technician' && r.json?.quote?.totalEgp === 12600, JSON.stringify(r.json?.quote));
  r = await req('POST', `/api/package-requests/${pkrRaise}/accept`, { token: patientToken2, body: { ...TERMS, paymentMethod: 'cash_receipt' } });
  check('accept raised quote -> booking level technician, dailyRateEgp 485', r.status === 201 && r.json?.level === 'technician' && r.json?.packageType === 'package_technician_12' && r.json?.dailyRateEgp === 485, JSON.stringify(r.json)?.slice(0, 300));
  r = await pkgReq({ packageType: 'package_assistant_12' });
  const pkrShift = r.json?.id;
  r = await req('POST', `/api/admin/package-requests/${pkrShift}/quote`, { token: adminToken, body: { packageType: 'package_technician_24', finalPriceEgp: 21700, providerId: 'prov_demo_pro', extraDaysOption: 'none' } });
  check('quote override to a 24h package for a 12h request -> 400 shift mismatch', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
  r = await req('POST', `/api/admin/package-requests/${pkrShift}/quote`, { token: adminToken, body: { packageType: 'package_tourist_technician_12', finalPriceEgp: 800, providerId: 'prov_demo_pro', extraDaysOption: 'none' } });
  check('quote override to a tourist package for a local request -> 400 family mismatch', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
  r = await req('POST', `/api/admin/package-requests/${pkrE}/quote`, { token: adminToken, body: { packageType: 'package_technician_12', finalPriceEgp: 12600, providerId: 'prov_demo_pro', extraDaysOption: 'none' } });
  check('elderly mobile request raised to technician in the quote -> 200', r.status === 200 && r.json?.quote?.level === 'technician' && r.json?.quote?.packageType === 'package_technician_12', JSON.stringify(r.json?.quote));
  // 24e. tourist package full flow (USD, technician 12h, overtime).
  r = await req('POST', `/api/admin/package-requests/${pkrT0}/quote`, { token: adminToken, body: { finalPrice: 800, providerId: 'prov_demo_pro', extraDaysOption: 'overtime' } });
  check('tourist quote overtime -> 800 + 4x45 = 980 USD, 47040 EGP, extra 45/day', r.status === 200 && r.json?.quote?.total === 980 && r.json?.quote?.totalEgp === 47040 && r.json?.quote?.currency === 'USD' && r.json?.quote?.extraDays?.dailyRate === 45 && r.json?.quote?.extraDays?.dailyRateEgp === 2160, JSON.stringify(r.json?.quote));
  r = await req('POST', `/api/package-requests/${pkrT0}/accept`, { token: patientToken2, body: { ...TERMS, paymentMethod: 'cash_receipt' } });
  check('accept tourist quote -> booking USD, amountForeign 980, amountEgp 47040, dailyRate 31 / 1477', r.status === 201 && r.json?.currency === 'USD' && r.json?.amountForeign === 980 && r.json?.amountEgp === 47040 && r.json?.dailyRate === 31 && r.json?.dailyRateEgp === 1477, JSON.stringify(r.json)?.slice(0, 300));
  const pkgT = r.json?.id;
  r = await req('POST', `/api/bookings/${pkgT}/package-day`, { token: provToken, body: { date: TODAY, type: 'regular' } });
  check('tourist package regular day -> 200, rate 31 USD / 1477 EGP', r.status === 200 && r.json?.daysCompleted === 1 && (r.json?.daysLog || [])[0]?.rate === 31 && (r.json?.daysLog || [])[0]?.rateEgp === 1477, JSON.stringify(r.json?.daysLog));
  // 24f. tourist gate: the assistant never took the in-app English test,
  // so quoting a tourist package with them must fail the tourist gate
  // (the level gate passes: assistant level accepts an assistant).
  r = await pkgReq({ packageType: 'package_tourist_assistant_12' });
  const pkrTAsst = r.json?.id;
  r = await req('POST', `/api/admin/package-requests/${pkrTAsst}/quote`, { token: adminToken, body: { finalPrice: 575, providerId: asstProviderId, extraDaysOption: 'none' } });
  check('quote tourist package with a provider without the English badge -> 409 tourist gate', r.status === 409 && JSON.stringify(r.json).includes('tourist-compatible'), JSON.stringify(r.json)?.slice(0, 200));
  // 24g. per-level overtime (daily x 1.25, rounded to nearest 5) via quotes.
  const overtimeCases = [
    ['package_assistant_12', 8000, asstProviderId, 440],
    ['package_assistant_24', 13700, 'prov_demo_pro', 750],
    ['package_technician_24', 21700, 'prov_demo_pro', 1190],
    ['package_specialist_12', 17200, 'prov_demo_pro', 940],
    ['package_specialist_24', 28600, 'prov_demo_pro', 1565],
  ];
  for (const [code, price, provId, ot] of overtimeCases) {
    r = await pkgReq({ packageType: code });
    const qid = r.json?.id;
    const q = await req('POST', `/api/admin/package-requests/${qid}/quote`, { token: adminToken, body: { finalPriceEgp: price, providerId: provId, extraDaysOption: 'overtime' } });
    check(`overtime ${code} -> ${ot}/day, total ${price + 4 * ot}`, q.status === 200 && q.json?.quote?.extraDays?.dailyRateEgp === ot && q.json?.quote?.totalEgp === price + 4 * ot, JSON.stringify(q.json?.quote));
  }

    // --- 25. v2.1.4: single-day shifts back to 500/850 + launch-month shift offer ---
    console.log('\n[v2.1.4 shift prices 500/850 + launch-month offer]');
    // The offer defaults OFF; the terms carry the offer clause (v1.0).
    r = await req('GET', '/api/bootstrap');
    check('bootstrap launchOffer defaults inactive', r.json?.launchOffer?.active === false, JSON.stringify(r.json?.launchOffer));
    r = await req('GET', '/api/terms');
    check('terms v1.0 has launch-offer clause + 500/850 shift prices, no 700 shift price', r.status === 200 && r.json?.version === '1.0' && r.json?.textAr?.includes('عرض شهر الإطلاق') && r.json?.textAr?.includes('12 ساعة 500') && !r.json?.textAr?.includes('12 ساعة 700') && r.json?.textEn?.includes('Launch-month offer'), JSON.stringify(r.json)?.slice(0, 200));
    // Admin endpoint: auth + validation.
    r = await req('POST', '/api/admin/launch-offer', { token: patientToken2, body: { active: true } });
    check('launch-offer by non-admin -> 403', r.status === 403, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/launch-offer', { token: adminToken, body: { active: 'yes' } });
    check('launch-offer active non-boolean -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/launch-offer', { token: adminToken, body: { active: true, until: new Date(Date.now() - 1000).toISOString() } });
    check('launch-offer past until -> 400', r.status === 400, JSON.stringify(r.json));
    // Reuse the §3b new-patient token (phone 01077777777): that patient
    // has 0 completed visits, so the loyalty-voucher timing is
    // deterministic — a voucher is issued after the 4th and 8th completed
    // visits and auto-applies to the NEXT booking (50 EGP off the app
    // share). A fresh login here would trip the IP login limiter (the
    // suite already exercises it in §3b). The main provider's tier is
    // set right before each cycle (§17a pattern — the review recomputes
    // points and may re-derive it).
    const offerToken = loToken;
    const setTier = async (tier) => { const rr = await req('POST', '/api/admin/providers/prov_demo_pro/tier', { token: adminToken, body: { tier } }); return rr.status === 200 && rr.json?.tier === tier; };
    const completeShift = async (serviceCode, km) => {
      const c = await req('POST', '/api/bookings', { token: offerToken, body: { ...TERMS,
        patientName: 'Shift Patient', serviceCode, paymentMethod: 'cash_receipt',
        distanceKm: km, respectCharterAccepted: true, triage: { dangerSigns: [] },
      } });
      if (c.status !== 201) return { ok: false, step: 'create', res: c };
      const id = c.json.id;
      const a = await req('POST', `/api/bookings/${id}/accept`, { token: provToken });
      if (a.status !== 200) return { ok: false, step: 'accept', res: a };
      const v = await req('POST', `/api/bookings/${id}/vitals`, { token: provToken, body: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, glucose: 110, oxygen: 98, temp: 36.6 } });
      if (v.status !== 200) return { ok: false, step: 'vitals', res: v };
      const cp = await req('POST', `/api/bookings/${id}/complete-provider`, { token: provToken });
      if (cp.status !== 200) return { ok: false, step: 'complete-provider', res: cp };
      const cf = await req('POST', `/api/bookings/${id}/confirm-patient`, { token: offerToken });
      if (cf.status !== 200) return { ok: false, step: 'confirm-patient', res: cf };
      const rv = await req('POST', `/api/bookings/${id}/review`, { token: offerToken, body: { rating: 5, comment: 'Good shift.' } });
      if (rv.status !== 200 || rv.json?.status !== 'released') return { ok: false, step: 'review', res: rv };
      return { ok: true, id, created: c.json, accepted: a.json, released: rv.json };
    };
    // Offer OFF: normal shares — Starter 12h provider 425, app 75.
    check('main provider set to Starter (offer OFF baseline)', await setTier('Starter'));
    const off12 = await completeShift('shift12', 2);
    check('offer OFF: 12h shift cycle completes', off12.ok, JSON.stringify(off12.res?.json || off12)?.slice(0, 300));
    check('offer OFF: 12h shift total 500, provider 425, app 75, no offer lock, no voucher yet', off12.ok && off12.created?.amountEgp === 500 && off12.released?.providerShareEgp === 425 && off12.released?.appShareEgp === 75 && (off12.released?.launchOffer == null) && (off12.released?.voucherDiscountEgp || 0) === 0, JSON.stringify(off12.released)?.slice(0, 300));
    // Turn the offer ON (until tomorrow).
    const offerUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    r = await req('POST', '/api/admin/launch-offer', { token: adminToken, body: { active: true, until: offerUntil } });
    check('admin sets launch offer ON -> 200 active', r.status === 200 && r.json?.launchOffer?.active === true, JSON.stringify(r.json));
    r = await req('GET', '/api/bootstrap');
    check('bootstrap shows launchOffer active', r.json?.launchOffer?.active === true, JSON.stringify(r.json?.launchOffer));
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('admin dashboard shows launchOffer active', r.json?.launchOffer?.active === true, JSON.stringify(r.json?.launchOffer)?.slice(0, 200));
    // Offer ON: Starter 12h — patient pays 500, provider 595 (on 700),
    // app -95, top-up 200. Accept locks the reference + estimated share.
    check('main provider set to Starter (offer ON 12h)', await setTier('Starter'));
    const on12 = await completeShift('shift12', 2);
    check('offer ON: 12h shift cycle completes', on12.ok, JSON.stringify(on12.res?.json || on12)?.slice(0, 300));
    check('offer ON: 12h shift patient pays 500, provider 595, app -95, top-up 200', on12.ok && on12.created?.amountEgp === 500 && on12.released?.providerShareEgp === 595 && on12.released?.appShareEgp === -95 && on12.released?.launchOfferTopupEgp === 200 && on12.released?.launchOffer?.referenceEgp === 700, JSON.stringify(on12.released)?.slice(0, 300));
    check('offer ON: accept locks launchOffer reference 700 + estimated share 595', on12.ok && on12.accepted?.launchOffer?.referenceEgp === 700 && on12.accepted?.estimatedProviderShareEgp === 595, JSON.stringify(on12.accepted)?.slice(0, 300));
    // Offer ON: Starter 24h — patient pays 850, provider 1,020 (on 1,200),
    // app -170, top-up 350.
    check('main provider set to Starter (offer ON 24h)', await setTier('Starter'));
    const on24 = await completeShift('shift24', 2);
    check('offer ON: 24h shift cycle completes', on24.ok, JSON.stringify(on24.res?.json || on24)?.slice(0, 300));
    check('offer ON: 24h shift patient pays 850, provider 1020, app -170, top-up 350', on24.ok && on24.created?.amountEgp === 850 && on24.released?.providerShareEgp === 1020 && on24.released?.appShareEgp === -170 && on24.released?.launchOfferTopupEgp === 350 && on24.released?.launchOffer?.referenceEgp === 1200, JSON.stringify(on24.released)?.slice(0, 300));
    // Offer ON: Pro 12h — provider 616 (700 x 0.88), app -116.
    check('main provider set to Pro (offer ON 12h)', await setTier('Pro'));
    const onPro = await completeShift('shift12', 2);
    check('offer ON: Pro 12h provider 616, app -116', onPro.ok && onPro.released?.providerShareEgp === 616 && onPro.released?.appShareEgp === -116 && onPro.released?.launchOffer?.referenceEgp === 700, JSON.stringify(onPro.released)?.slice(0, 300));
    // Offer ON: Elite 12h — provider 644 (700 x 0.92); this is the
    // patient's 5th completed visit, so the voucher earned after the 4th
    // auto-applies: app share -144 - 50 = -194, discount recorded.
    check('main provider set to Elite (offer ON 12h)', await setTier('Elite'));
    const onElite = await completeShift('shift12', 2);
    check('offer ON: Elite 12h provider 644, voucher composes (app -194, discount 50)', onElite.ok && onElite.released?.providerShareEgp === 644 && onElite.released?.appShareEgp === -194 && onElite.released?.voucherDiscountEgp === 50 && onElite.released?.launchOffer?.referenceEgp === 700, JSON.stringify(onElite.released)?.slice(0, 300));
    // Offer ON: a NON-shift service is untouched (standard visit 250).
    check('main provider set to Elite (offer ON standard visit)', await setTier('Elite'));
    const onStd = await completeVisit(offerToken, 2);
    check('offer ON: standard visit unaffected (250, provider 230 at Elite 8%, app 20, no offer lock)', onStd.ok && onStd.created?.amountEgp === 250 && onStd.released?.providerShareEgp === 230 && onStd.released?.appShareEgp === 20 && (onStd.released?.launchOffer == null), JSON.stringify(onStd.released)?.slice(0, 300));
    // Offer ON: an elderly shift is untouched (mobile 600).
    check('main provider set to Elite (offer ON elderly shift)', await setTier('Elite'));
    const onEld = await completeShift('elderly_shift_mobile', 2);
    check('offer ON: elderly shift unaffected (600, provider 552 at Elite 8%, app 48, no offer lock)', onEld.ok && onEld.created?.amountEgp === 600 && onEld.released?.providerShareEgp === 552 && onEld.released?.appShareEgp === 48 && (onEld.released?.launchOffer == null), JSON.stringify(onEld.released)?.slice(0, 300));
    // Turn the offer OFF again: new shifts go back to normal shares.
    r = await req('POST', '/api/admin/launch-offer', { token: adminToken, body: { active: false } });
    check('admin clears launch offer -> inactive', r.status === 200 && r.json?.launchOffer?.active === false, JSON.stringify(r.json));
    r = await req('GET', '/api/bootstrap');
    check('bootstrap launchOffer inactive after clear', r.json?.launchOffer?.active === false, JSON.stringify(r.json?.launchOffer));
    check('main provider restored to Starter after launch-offer checks', await setTier('Starter'));
    const offAgain = await completeShift('shift12', 2);
    check('offer OFF again: 12h shift provider 425, app 75', offAgain.ok && offAgain.released?.providerShareEgp === 425 && offAgain.released?.appShareEgp === 75 && (offAgain.released?.launchOffer == null), JSON.stringify(offAgain.released)?.slice(0, 300));
    // Expired offer stops applying: set a 1.5-second offer, wait it out —
    // bootstrap must show inactive and the next shift takes normal shares.
    // (This is the patient's 9th completed visit, so the voucher earned
    // after the 8th applies: app share 75 - 50 = 25.)
    r = await req('POST', '/api/admin/launch-offer', { token: adminToken, body: { active: true, until: new Date(Date.now() + 1500).toISOString() } });
    check('admin sets 1.5s launch offer -> 200 active', r.status === 200 && r.json?.launchOffer?.active === true, JSON.stringify(r.json));
    await sleep(2000);
    r = await req('GET', '/api/bootstrap');
    check('expired launch offer stops applying (bootstrap inactive)', r.json?.launchOffer?.active === false, JSON.stringify(r.json?.launchOffer));
    check('main provider set to Starter (after expiry)', await setTier('Starter'));
    const afterExpiry = await completeShift('shift12', 2);
    check('after expiry: 12h shift provider 425, app 25 (75 - voucher 50), no offer lock', afterExpiry.ok && afterExpiry.released?.providerShareEgp === 425 && afterExpiry.released?.appShareEgp === 25 && afterExpiry.released?.voucherDiscountEgp === 50 && (afterExpiry.released?.launchOffer == null), JSON.stringify(afterExpiry.released)?.slice(0, 300));

    // --- §26. admin broadcast (v2.1.5) ----------------------------------
    // One message to every user: in-app record + FCM push, never SMS
    // (non-critical). The test env has no Firebase vars, so every push
    // lands as 'not_configured' — assert that, not 'sent'.
    console.log('\n[§26 admin broadcast]');
    const bcTitle = 'رسالة تجريبية من الإدارة';
    const bcBody = 'هذه رسالة بث تجريبية من شفاء كير.';
    r = await req('POST', '/api/admin/broadcast', { token: patientToken2, body: { title: bcTitle, body: bcBody } });
    check('broadcast non-admin -> 403', r.status === 403, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/broadcast', { token: adminToken, body: { body: bcBody } });
    check('broadcast missing title -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/broadcast', { token: adminToken, body: { title: bcTitle } });
    check('broadcast missing body -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/broadcast', { token: adminToken, body: { title: 'x'.repeat(101), body: bcBody } });
    check('broadcast title too long (101) -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/broadcast', { token: adminToken, body: { title: bcTitle, body: 'y'.repeat(501) } });
    check('broadcast body too long (501) -> 400', r.status === 400, JSON.stringify(r.json));
    // Dry run: counts only, nothing sent / stored / audited.
    const auditBefore = await req('GET', '/api/admin/audit', { token: adminToken });
    const hadBcAuditBefore = Array.isArray(auditBefore.json) && auditBefore.json.some((a) => a.action === 'admin.broadcast');
    r = await req('POST', '/api/admin/broadcast', { token: adminToken, body: { title: bcTitle, body: bcBody, dryRun: true } });
    check('broadcast dry-run -> 200 with devices/users counts', r.status === 200 && r.json?.dryRun === true && typeof r.json?.devices === 'number' && typeof r.json?.users === 'number' && r.json.users >= 1, JSON.stringify(r.json));
    const dryDevices = r.json?.devices, dryUsers = r.json?.users;
    check('broadcast dry-run returns no phone numbers or tokens', !JSON.stringify(r.json).includes('01012345678') && !JSON.stringify(r.json).toLowerCase().includes('fcm'), JSON.stringify(r.json));
    r = await req('GET', '/api/me/notifications', { token: patientToken2 });
    check('broadcast dry-run stores NO notification', Array.isArray(r.json?.notifications) && !r.json.notifications.some((n) => n.type === 'broadcast'));
    r = await req('GET', '/api/admin/audit', { token: adminToken });
    check('broadcast dry-run writes NO audit entry', Array.isArray(r.json) && !r.json.some((a) => a.action === 'admin.broadcast') && !hadBcAuditBefore);
    // Dashboard carries the same audience counts.
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('dashboard has broadcastDevices/broadcastUsers matching dry-run', r.status === 200 && r.json?.broadcastDevices === dryDevices && r.json?.broadcastUsers >= 1, JSON.stringify({ broadcastDevices: r.json?.broadcastDevices, broadcastUsers: r.json?.broadcastUsers }));
    // Real broadcast: every user gets an in-app 'broadcast' record;
    // pushStatus is 'not_configured' (no Firebase in the test env), so
    // sent is 0 and failed equals the audience size. No SMS ever fires.
    r = await req('POST', '/api/admin/broadcast', { token: adminToken, body: { title: bcTitle, body: bcBody } });
    check('broadcast real send -> 200 with sent/failed counts', r.status === 200 && r.json?.dryRun === false && typeof r.json?.sent === 'number' && typeof r.json?.failed === 'number' && r.json.sent + r.json.failed === r.json.users && r.json.users === dryUsers && r.json.devices === dryDevices, JSON.stringify(r.json));
    check('broadcast with no FCM configured: sent 0, failed = users', r.json?.sent === 0 && r.json?.failed === dryUsers, JSON.stringify(r.json));
    check('broadcast real send returns no phone numbers or tokens', !JSON.stringify(r.json).includes('01012345678') && !JSON.stringify(r.json).toLowerCase().includes('fcm'), JSON.stringify(r.json));
    r = await req('GET', '/api/me/notifications', { token: patientToken2 });
    const bcNotif = Array.isArray(r.json?.notifications) ? r.json.notifications.find((n) => n.type === 'broadcast') : null;
    check('broadcast visible in-app for test user (type broadcast)', !!bcNotif, JSON.stringify(r.json?.notifications?.slice(0, 3)));
    check('broadcast notification carries title/body, pushStatus not_configured, not critical', !!bcNotif && bcNotif.titleAr === bcTitle && bcNotif.bodyAr === bcBody && bcNotif.pushStatus === 'not_configured' && bcNotif.critical === false, JSON.stringify(bcNotif));
    r = await req('GET', '/api/admin/audit', { token: adminToken });
    const bcAudit = Array.isArray(r.json) ? r.json.find((a) => a.action === 'admin.broadcast') : null;
    check('broadcast writes an admin.broadcast audit entry', !!bcAudit && bcAudit.details?.users === dryUsers && bcAudit.details?.sent === 0 && bcAudit.details?.failed === dryUsers, JSON.stringify(bcAudit));

  // --- 27. v2.1.6: critical security fixes (C1-C8) --------------------
  console.log('\n[v2.1.6 security fixes]');
  // 27a. C5 — language bank rotated + position scoring.
  {
    let distOk = true;
    for (const [lang, qs] of Object.entries(LANGUAGE_TESTS)) {
      const dist = { a: 0, b: 0, c: 0, d: 0 };
      const ids = new Set();
      for (const q of qs) { dist[q.correct]++; ids.add(q.id); }
      if (qs.length !== 12 || ids.size !== 12 || dist.a !== 3 || dist.b !== 3 || dist.c !== 3 || dist.d !== 3) distOk = false;
      if (!qs.every((q) => LANGUAGE_TEST_TOPICS.includes(q.topic))) distOk = false;
    }
    check('C5 bank: 12 questions/language, correct keys exactly 3/3/3/3, topics match the constant', distOk, JSON.stringify(Object.keys(LANGUAGE_TESTS)));
    // prov1 (failed interview) can still take a language test — use them
    // so the main providers' badges are untouched.
    r = await req('POST', '/api/me/language-tests/ru/start', { token: prov1Token });
    check('C5 start publishes exactly 8 of 12, options carry NO keys and no correct field', r.status === 200 && Array.isArray(r.json?.questions) && r.json.questions.length === 8 && r.json.questions.every((q) => Array.isArray(q.options) && q.options.length === 4 && q.options.every((o) => !('key' in o) && !('correct' in o))), JSON.stringify(r.json?.questions?.length));
    const c5Attempt = r.json?.attemptId;
    const c5Qs = r.json?.questions || [];
    const c5RawLetters = {};
    for (const q of c5Qs) c5RawLetters[q.id] = 'a';
    r = await req('POST', '/api/me/language-tests/ru/submit', { token: prov1Token, body: { attemptId: c5Attempt, answers: c5RawLetters } });
    check('C5 raw key letters rejected -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    const c5OutOfRange = {};
    for (const q of c5Qs) c5OutOfRange[q.id] = 4;
    r = await req('POST', '/api/me/language-tests/ru/submit', { token: prov1Token, body: { attemptId: c5Attempt, answers: c5OutOfRange } });
    check('C5 out-of-range position rejected -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/me/language-tests/ru/submit', { token: prov1Token, body: { attemptId: c5Attempt, answers: { nope_question: 0 } } });
    check('C5 answer for a question outside this attempt rejected -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    const c5Correct = {};
    for (const q of c5Qs) {
      const bankQ = LANGUAGE_TESTS.ru.find((x) => x.id === q.id);
      const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
      c5Correct[q.id] = q.options.findIndex((o) => o.text === correctText);
    }
    r = await req('POST', '/api/me/language-tests/ru/submit', { token: prov1Token, body: { attemptId: c5Attempt, answers: c5Correct } });
    check('C5 all-correct by position -> 200, passed 8/8', r.status === 200 && r.json?.passed === true && r.json?.score === 8 && r.json?.total === 8, JSON.stringify(r.json));
  }
  // 27b. C6 — receipt mandatory for online payment at creation.
  {
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'No Receipt', serviceCode: 'standard', paymentMethod: 'instapay',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('C6 instapay booking without receipt -> 400', r.status === 400 && /receipt/i.test(r.json?.message || ''), JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/tourist-bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Tourist No Receipt', serviceCode: 'tourist_iv', language: 'de', currency: 'eur',
      paymentMethod: 'card', distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('C6 card tourist booking without receipt -> 400', r.status === 400 && /receipt/i.test(r.json?.message || ''), JSON.stringify(r.json)?.slice(0, 200));
    // Package accept (instapay) without a receipt -> 400. pkrF is still
    // 'quoted' from §23l (finalPrice 8000, prov_demo_pro) — it was never
    // accepted, so no re-quote is possible or needed.
    r = await req('POST', `/api/package-requests/${pkrF}/accept`, { token: patientToken2, body: { ...TERMS, paymentMethod: 'instapay' } });
    check('C6 package accept instapay without receipt -> 400', r.status === 400 && /receipt/i.test(r.json?.message || ''), JSON.stringify(r.json)?.slice(0, 200));
  }

  // 27c. C2/C3/C4 — settlement math on a mixed cash/non-cash week.
  // redProv (red-flag interview, retake already allowed by admin in §6)
  // is the fresh provider: no released bookings, no settlement record.
  {
    await req('POST', '/api/otp/request', { body: { phone: '01016161616', channel: 'whatsapp' } });
    const redCode = await mockCode('01016161616');
    const redLogin = await req('POST', '/api/otp/verify', { body: { phone: '01016161616', code: redCode || '000000' } });
    const redToken = redLogin.json?.accessToken;
    check('C2 redProv fresh login via OTP', redLogin.status === 200 && !!redToken, JSON.stringify(redLogin.json)?.slice(0, 200));
    // The retake attempt was already STARTED at line 307 (the §6 check
    // that the retake is unblocked) and never submitted — so complete
    // THAT attempt here (re-serve its questions, submit all-correct).
    // Starting a fresh attempt would 409 ("already in progress").
    const redQ = await req('GET', '/api/providers/interview/questions', { token: redToken });
    const redAnswers = {};
    for (const q of redQ.json?.questions || []) redAnswers[q.id] = CORRECT[q.id];
    const redEn = {};
    for (const q of redQ.json?.englishCheck?.questions || []) redEn[q.id] = EN_CORRECT[q.id];
    const redRetake = await req('POST', '/api/providers/interview/submit', { token: redToken, body: { attemptId: redQ.json?.attemptId, answers: redAnswers, englishAnswers: redEn } });
    check('C2 redProv retakes interview all-correct -> passed', redRetake.status === 200 && redRetake.json?.status === 'passed', JSON.stringify(redRetake.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/providers/${redProv.providerId}/verify`, { token: adminToken, body: { role: 'nurse' } });
    check('C2 admin verifies redProv -> verified', r.status === 200 && r.json?.status === 'verified', JSON.stringify(r.json)?.slice(0, 200));
    // Parameterised visit cycle (provider token + payment method).
    const cycleAs = async (provTok, patientTok, km, pay) => {
      const extra = pay === 'instapay' ? { receiptImage: RECEIPT_JPEG } : {};
      const c = await req('POST', '/api/bookings', { token: patientTok, body: { ...TERMS,
        patientName: 'Settle Patient', serviceCode: 'standard', paymentMethod: pay,
        distanceKm: km, respectCharterAccepted: true, triage: { dangerSigns: [] }, ...extra,
      } });
      if (c.status !== 201) return { ok: false, step: 'create', res: c };
      const id = c.json.id;
      if (pay === 'instapay') {
        const ap = await req('POST', `/api/admin/bookings/${id}/receipt/approve`, { token: adminToken, body: {} });
        if (ap.status !== 200) return { ok: false, step: 'receipt-approve', res: ap };
      }
      const a = await req('POST', `/api/bookings/${id}/accept`, { token: provTok });
      if (a.status !== 200) return { ok: false, step: 'accept', res: a };
      const v = await req('POST', `/api/bookings/${id}/vitals`, { token: provTok, body: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, glucose: 110, oxygen: 98, temp: 36.6 } });
      if (v.status !== 200) return { ok: false, step: 'vitals', res: v };
      const cp = await req('POST', `/api/bookings/${id}/complete-provider`, { token: provTok });
      if (cp.status !== 200) return { ok: false, step: 'complete-provider', res: cp };
      const cf = await req('POST', `/api/bookings/${id}/confirm-patient`, { token: patientTok });
      if (cf.status !== 200) return { ok: false, step: 'confirm-patient', res: cf };
      const rv = await req('POST', `/api/bookings/${id}/review`, { token: patientTok, body: { rating: 5, comment: 'Good.' } });
      if (rv.status !== 200 || rv.json?.status !== 'released') return { ok: false, step: 'review', res: rv };
      if (pay === 'cash_receipt') {
        // The provider collected the cash by hand and marks it — this
        // sets cashCollectedByProvider, which is what the settlement
        // (C2) keys the cash/non-cash split on. Without this call the
        // booking looks like a non-cash booking to the ledger.
        const cc = await req('POST', `/api/bookings/${id}/cash-collected`, { token: provTok });
        if (cc.status !== 200) return { ok: false, step: 'cash-collected', res: cc };
      }
      return { ok: true, id, released: rv.json };
    };
    const rejectComplaint = async (bookingId) => {
      const sr = await req('POST', `/api/bookings/${bookingId}/safety-report`, { token: patientToken2, body: { type: 'complaint', description: 'Settlement test complaint.' } });
      if (sr.status !== 201) return { ok: false, step: 'complaint', res: sr };
      const rr = await req('POST', `/api/admin/complaints/${sr.json?.reportId}/resolve`, { token: adminToken, body: { decision: 'rejected' } });
      if (rr.status !== 200) return { ok: false, step: 'resolve', res: rr };
      return { ok: true };
    };
    // 14 cash cycles + 1 instapay cycle = 15 cases -> 500 bonus.
    const settleShares = { cash: [], instapay: null };
    let settleOk = true; let settleFailStep = '';
    for (let i = 0; i < 14; i++) {
      const cyc = await cycleAs(redToken, patientToken2, 2, 'cash_receipt');
      if (!cyc.ok) { settleOk = false; settleFailStep = `cash ${i} ${cyc.step} ${JSON.stringify(cyc.res?.json || cyc.res)}`; break; }
      settleShares.cash.push({ id: cyc.id, providerShareEgp: cyc.released.providerShareEgp, appShareEgp: cyc.released.appShareEgp });
    }
    if (settleOk) {
      const cyc = await cycleAs(redToken, patientToken2, 2, 'instapay');
      if (!cyc.ok) { settleOk = false; settleFailStep = `instapay ${cyc.step} ${JSON.stringify(cyc.res?.json || cyc.res)}`; }
      else settleShares.instapay = { id: cyc.id, providerShareEgp: cyc.released.providerShareEgp, appShareEgp: cyc.released.appShareEgp };
    }
    check('C2 15 settle cycles complete (14 cash + 1 instapay)', settleOk, settleFailStep.slice(0, 300));
    // C3 — wallet shows the bonus as DUE (500) before any settlement.
    r = await req('GET', '/api/providers/wallet', { token: redToken });
    check('C3 wallet before settlement: 15 cases, bonus due 500, paid 0', r.status === 200 && r.json?.monthlyCases === 15 && r.json?.volumeBonusEgp === 500 && r.json?.volumeBonusPaidEgp === 0, JSON.stringify({ monthlyCases: r.json?.monthlyCases, volumeBonusEgp: r.json?.volumeBonusEgp, volumeBonusPaidEgp: r.json?.volumeBonusPaidEgp }));
    // C4 — make 1 instapay + 1 cash booking settleable at once (complaint
    // rejected sets settleableAt = now); the other 13 cash bookings stay
    // inside the 24h window (hold bucket).
    const cashSettle = settleShares.cash[0];
    let rcOk = true;
    if (settleShares.instapay) { const rc = await rejectComplaint(settleShares.instapay.id); if (!rc.ok) rcOk = false; }
    if (cashSettle) { const rc = await rejectComplaint(cashSettle.id); if (!rc.ok) rcOk = false; }
    check('C4 complaint-rejected makes 2 bookings settleable at once', rcOk);
    r = await req('POST', '/api/jobs/sweep', { token: adminToken });
    check('C4 sweep runs', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', `/api/admin/settlements?providerId=${redProv.providerId}`, { token: adminToken });
    const stl = (r.json?.settlements || [])[0];
    const expAppOwes = (settleShares.instapay?.providerShareEgp || 0) + 500; // non-cash provider share + bonus
    const expProvOwes = cashSettle?.appShareEgp || 0; // cash contributes ONLY the app share
    const expHold = settleShares.cash.slice(1).reduce((s, x) => s + (x.appShareEgp || 0), 0); // 13 held cash bookings: app share each
    check('C2/C4 settlement: cash never owed by the app, non-cash + bonus owed, rest held',
      !!stl && stl.totals.appOwesProviderEgp === expAppOwes && stl.totals.providerOwesAppEgp === expProvOwes
      && stl.totals.complaintHoldEgp === expHold && stl.totals.releasedCases === 2
      && stl.totals.volumeBonusEgp === 500 && stl.totals.volumeBonusPaidCumulative === 500
      && stl.totals.payable === false, JSON.stringify(stl?.totals));
    // C3 — after the settlement the wallet shows the bonus as PAID (due 0).
    r = await req('GET', '/api/providers/wallet', { token: redToken });
    check('C3 wallet after settlement: bonus due 0, paid 500 (paid once)', r.status === 200 && r.json?.volumeBonusEgp === 0 && r.json?.volumeBonusPaidEgp === 500, JSON.stringify({ volumeBonusEgp: r.json?.volumeBonusEgp, volumeBonusPaidEgp: r.json?.volumeBonusPaidEgp }));
    // A second sweep must NOT create a second record (no double-pay).
    await req('POST', '/api/jobs/sweep', { token: adminToken });
    r = await req('GET', `/api/admin/settlements?providerId=${redProv.providerId}`, { token: adminToken });
    check('C3 second sweep creates no second settlement record', r.status === 200 && (r.json?.settlements || []).length === 1, JSON.stringify({ count: (r.json?.settlements || []).length }));
    // C4 — refunding a SETTLED booking creates a reversing adjustment.
    if (settleShares.instapay) {
      const sr = await req('POST', `/api/bookings/${settleShares.instapay.id}/safety-report`, { token: patientToken2, body: { type: 'complaint', description: 'Refund the settled visit.' } });
      const repId = sr.json?.reportId;
      r = await req('POST', `/api/admin/complaints/${repId}/resolve`, { token: adminToken, body: { decision: 'accepted_refund' } });
      check('C4 settled booking refunded via complaint', r.status === 200 && r.json?.booking?.status === 'refunded', JSON.stringify(r.json?.booking)?.slice(0, 200));
      r = await req('GET', '/api/admin/audit', { token: adminToken });
      const adjAudit = Array.isArray(r.json) ? r.json.find((a) => a.action === 'settlement.adjustment_created' && a.details?.bookingId === settleShares.instapay.id) : null;
      check('C4 reversing adjustment created + audited for the settled refund', !!adjAudit && adjAudit.details?.providerShareEgp === settleShares.instapay.providerShareEgp, JSON.stringify(adjAudit?.details));
    }
  }

  // 27d. C7 — package days need evidence before they release.
  {
    const mkPkg = async () => {
      const q = await pkgReq({ packageType: 'package_technician_12' });
      if (q.status !== 201) return { ok: false, step: 'request', res: q };
      const pkr = q.json?.id;
      const qt = await req('POST', `/api/admin/package-requests/${pkr}/quote`, { token: adminToken, body: { finalPriceEgp: 12600, providerId: 'prov_demo_pro', extraDaysOption: 'none' } });
      if (qt.status !== 200) return { ok: false, step: 'quote', res: qt };
      const ac = await req('POST', `/api/package-requests/${pkr}/accept`, { token: patientToken2, body: { ...TERMS, paymentMethod: 'cash_receipt' } });
      if (ac.status !== 201) return { ok: false, step: 'accept', res: ac };
      return { ok: true, id: ac.json?.id };
    };
    const pkgD = await mkPkg();
    check('C7 package D created (cash)', pkgD.ok, JSON.stringify(pkgD.res?.json || pkgD.res)?.slice(0, 200));
    if (pkgD.ok) {
      r = await req('POST', `/api/bookings/${pkgD.id}/package-day`, { token: provToken, body: { date: TODAY, type: 'regular' } });
      check('C7 day logged without vitals/confirmation -> 200, unconfirmed', r.status === 200 && (r.json?.daysLog || [])[0]?.patientConfirmed === false, JSON.stringify(r.json?.daysLog)?.slice(0, 200));
      r = await req('POST', '/api/jobs/sweep', { token: adminToken });
      r = await req('GET', `/api/bookings/${pkgD.id}`, { token: patientToken2 });
      check('C7 unconfirmed day does NOT release on sweep', r.status === 200 && (r.json?.daysLog || [])[0]?.released === false, JSON.stringify(r.json?.daysLog)?.slice(0, 200));
      r = await req('POST', `/api/bookings/${pkgD.id}/package-day/${TODAY}/confirm`, { token: patientToken2 });
      check('C7 patient confirms the day -> 200', r.status === 200 && r.json?.patientConfirmed === true, JSON.stringify(r.json)?.slice(0, 200));
    }
    const pkgE = await mkPkg();
    check('C7 package E created (cash)', pkgE.ok, JSON.stringify(pkgE.res?.json || pkgE.res)?.slice(0, 200));
    if (pkgE.ok) {
      r = await req('POST', `/api/bookings/${pkgE.id}/package-day`, { token: provToken, body: { date: TODAY, type: 'regular', vitals: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, temp: 36.6, oxygen: 98 } } });
      check('C7 day logged with vitals -> 200, vitals stored', r.status === 200 && !!(r.json?.daysLog || [])[0]?.vitals && (r.json?.daysLog || [])[0]?.vitals?.pulse === 78, JSON.stringify(r.json?.daysLog)?.slice(0, 200));
      r = await req('POST', `/api/bookings/${pkgE.id}/package-day/${TODAY}/confirm`, { token: provToken });
      check('C7 patient cannot confirm a day (patient role only) -> 403', r.status === 403, JSON.stringify(r.json)?.slice(0, 200));
      r = await req('POST', `/api/admin/bookings/${pkgE.id}/package-day/${TODAY}/confirm`, { token: adminToken });
      check('C7 admin confirms a day on the patient behalf -> 200', r.status === 200 && r.json?.patientConfirmed === true && r.json?.confirmedBy === 'admin', JSON.stringify(r.json)?.slice(0, 200));
    }
    r = await req('POST', '/api/jobs/sweep', { token: adminToken });
    if (pkgD.ok) {
      r = await req('GET', `/api/bookings/${pkgD.id}`, { token: patientToken2 });
      check('C7 patient-confirmed day releases on sweep', (r.json?.daysLog || [])[0]?.released === true && (r.json?.daysLog || [])[0]?.confirmedBy === 'patient', JSON.stringify(r.json?.daysLog)?.slice(0, 200));
    }
    if (pkgE.ok) {
      r = await req('GET', `/api/bookings/${pkgE.id}`, { token: patientToken2 });
      check('C7 admin-confirmed day releases on sweep', (r.json?.daysLog || [])[0]?.released === true && (r.json?.daysLog || [])[0]?.confirmedBy === 'admin', JSON.stringify(r.json?.daysLog)?.slice(0, 200));
    }
    // Dashboard lists the review queue (empty here — no bulk flag fired).
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('C7/C8 dashboard carries anomalyFlags + packageReviewRequired + newDeviceLogins', r.status === 200 && Array.isArray(r.json?.anomalyFlags) && Array.isArray(r.json?.packageReviewRequired) && Array.isArray(r.json?.newDeviceLogins), JSON.stringify({ anomalyFlags: (r.json?.anomalyFlags || []).length, packageReviewRequired: (r.json?.packageReviewRequired || []).length, newDeviceLogins: (r.json?.newDeviceLogins || []).length }));
  }
  // 27e. C8 rating floor + C1 new-device alert.
  {
    // phys has exactly 1 rated visit (bkPhysio, 5 stars) -> rating
    // points must be 0 (needs >=5 rated visits), average still shown.
    r = await req('GET', '/api/providers/wallet', { token: phys.token });
    check('C8 rating points are 0 with <5 rated visits (average still 5.0)', r.status === 200 && r.json?.points?.rating === 0 && r.json?.points?.ratedCount === 1 && r.json?.points?.ratingAvg === 5, JSON.stringify(r.json?.points));
    // C1 (smoke): the dashboard exposes the new-device login list (the
    // live newDevice true/false behaviour is tested in integration.js,
    // because the smoke suite has already used all 20 IP login attempts
    // by this point and any further login-phone call would 429).
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('C1 dashboard exposes newDeviceLogins (new-device logins are audited)', r.status === 200 && Array.isArray(r.json?.newDeviceLogins) && (r.json?.newDeviceLogins || []).some((x) => x.phone === '01077777777'), JSON.stringify(r.json?.newDeviceLogins?.slice(0, 2)));
  }

  // --- §28. v2.1.7: crash/session/registration fixes + in-app dialogs + update checker ---
  // (owner QA 26 Nov 2026: the app was being killed from any screen, every
  // kill logged the user out, provider registration bounced, no visible
  // patient login, no bell before login, and prompt() was the kill cause.)
  console.log('\n[§28 v2.1.7]');
  // 28a. Client-report endpoint: validation, sanitisation, rate limit, admin list.
  {
    // Invalid kind -> 400.
    r = await req('POST', '/api/client-report', { body: { kind: 'bogus' } });
    check('§28 client-report rejects an unknown kind -> 400', r.status === 400, JSON.stringify(r.json));
    // js_error without a message -> 400.
    r = await req('POST', '/api/client-report', { body: { kind: 'js_error' } });
    check('§28 client-report js_error without message -> 400', r.status === 400, JSON.stringify(r.json));
    // Valid unclean_exit -> 200 with an id.
    r = await req('POST', '/api/client-report', { body: { kind: 'unclean_exit', lastScreen: '#/patient', lastHeartbeat: Date.now() - 5000, userAgent: 'smoke-test', appVersion: '2.1.7 (21)' } });
    check('§28 client-report unclean_exit accepted -> 200 + id', r.status === 200 && typeof r.json?.id === 'string', JSON.stringify(r.json));
    // Valid js_error -> 200.
    r = await req('POST', '/api/client-report', { body: { kind: 'js_error', message: 'TypeError: x is null', stack: 'at foo (app.js:1)', screen: '#/provider', appVersion: '2.1.7 (21)' } });
    check('§28 client-report js_error accepted -> 200 + id', r.status === 200 && typeof r.json?.id === 'string', JSON.stringify(r.json));
    // Oversized message is truncated to 2000 chars, not rejected.
    const big = 'x'.repeat(5000);
    r = await req('POST', '/api/client-report', { body: { kind: 'js_error', message: big, screen: '#/' } });
    check('§28 client-report oversized message truncated, still 200', r.status === 200, JSON.stringify(r.json)?.slice(0, 100));
    // Secret-looking extra fields are dropped, never stored.
    r = await req('POST', '/api/client-report', { body: { kind: 'js_error', message: 'boom', token: 'SECRET-TOKEN', pin: '123456', password: 'hunter2', shifa_token: 'SECRET' } });
    check('§28 client-report with token/pin fields still 200', r.status === 200, JSON.stringify(r.json)?.slice(0, 100));
    // Admin list is admin-only and shows the stored reports, newest first.
    r = await req('GET', '/api/admin/client-reports');
    check('§28 admin client-reports without auth -> 401', r.status === 401, JSON.stringify(r.json)?.slice(0, 100));
    r = await req('GET', '/api/admin/client-reports', { token: adminToken });
    const reports = Array.isArray(r.json) ? r.json : [];
    check('§28 admin client-reports lists 4 stored reports, newest first', r.status === 200 && reports.length === 4 && reports[0]?.kind === 'js_error', JSON.stringify(reports.map((x) => x.kind)));
    const withSecrets = reports.find((x) => x.message === 'boom');
    check('§28 stored report has no token/pin/password fields', !!withSecrets && !('token' in withSecrets) && !('pin' in withSecrets) && !('password' in withSecrets) && !('shifa_token' in withSecrets), JSON.stringify(withSecrets));
    const bigStored = reports.find((x) => (x.message || '').length === 2000);
    check('§28 stored oversized message is exactly 2000 chars', !!bigStored, JSON.stringify({ storedLens: reports.map((x) => (x.message || '').length) }));
    // Rate limit: 10/hour per IP. 6 requests above (2 invalid + 4 valid)
    // + 4 more valid = 10 -> all 200; the 11th -> 429.
    let okCount = 0;
    for (let i = 0; i < 4; i++) {
      const rr = await req('POST', '/api/client-report', { body: { kind: 'unclean_exit', lastScreen: '#/' } });
      if (rr.status === 200) okCount++;
    }
    check('§28 rate limit: 4 more reports fill the 10/hour bucket (all 200)', okCount === 4, String(okCount));
    r = await req('POST', '/api/client-report', { body: { kind: 'unclean_exit', lastScreen: '#/' } });
    check('§28 rate limit: 11th report in the hour -> 429', r.status === 429, JSON.stringify(r.json)?.slice(0, 100));
  }
  // 28b. Update checker — server side.
  {
    r = await req('GET', '/api/bootstrap');
    check('§28 bootstrap latestApp reflects the release env (code 22 / 2.1.8 / forced)', r.status === 200 && r.json?.latestApp?.code === 22 && r.json?.latestApp?.version === '2.1.8' && r.json?.latestApp?.apkUrl === 'https://example.com/shifa-care-v2.1.8.apk' && r.json?.latestApp?.force === true, JSON.stringify(r.json?.latestApp));
    // Config defaults (fresh require, env unset): no update available.
    const cfgPath = require.resolve('../src/config');
    delete require.cache[cfgPath];
    delete process.env.LATEST_APP_CODE; delete process.env.LATEST_APP_VERSION; delete process.env.LATEST_APP_APK_URL; delete process.env.LATEST_APP_FORCE;
    const freshCfg = require('../src/config');
    check('§28 latestApp defaults to no update (code 0, empty URL, force false)', freshCfg.latestApp.code === 0 && freshCfg.latestApp.version === '' && freshCfg.latestApp.apkUrl === '' && freshCfg.latestApp.force === false, JSON.stringify(freshCfg.latestApp));
  }
  // 28c. Client logic (web/app.js) — the helpers block is extracted
  // verbatim from the shipped file and driven with a minimal DOM/storage
  // shim, so the REAL code is tested, not a copy.
  {
    const vm = require('vm');
    const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    const BEGIN = '/* v2.1.7 — testable helpers (BEGIN';
    const END = '/* v2.1.7 — testable helpers (END) */';
    const bi = appJs.indexOf(BEGIN);
    const ei = appJs.indexOf(END, bi);
    check('§28 v2.1.7 helpers block is extractable from web/app.js', bi !== -1 && ei !== -1 && ei > bi, `${bi}/${ei}`);
    if (bi !== -1 && ei !== -1) {
      const code = appJs.slice(bi, ei);
      // Minimal DOM + storage shim — just enough for the helpers.
      const makeStore = () => {
        const m = new Map();
        return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _map: m };
      };
      const localStore = makeStore();
      const sessionStore = makeStore();
      const fetchCalls = [];
      const openedUrls = [];
      const listeners = {};
      function makeEl(tag) {
        const el = {
          tagName: (tag || 'div').toUpperCase(), children: [], _id: '', className: '',
          _html: '', value: '', onclick: null, _listeners: {}, _byId: {},
          set id(v) { this._id = v; },
          get id() { return this._id; },
          set innerHTML(h) {
            this._html = h; this._byId = {}; this.children = [];
            const re = /<(\w+)[^>]*\sid="([^"]+)"/g;
            let m;
            while ((m = re.exec(h))) {
              const child = makeEl(m[1]);
              child.id = m[2];
              if (m[1] === 'textarea') child.value = (h.match(new RegExp('id="' + m[2] + '"[^>]*>([^<]*)')) || [])[1] || '';
              this._byId[m[2]] = child;
              this.children.push(child);
            }
          },
          get innerHTML() { return this._html; },
          appendChild(c) { c._parent = this; this.children.push(c); return c; },
          remove() { this._removed = true; if (this._parent) { const i = this._parent.children.indexOf(this); if (i !== -1) this._parent.children.splice(i, 1); } },
          querySelector(sel) { if (typeof sel === 'string' && sel[0] === '#') return this._byId[sel.slice(1)] || null; return null; },
          addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
          focus() {},
        };
        return el;
      }
      const bodyEl = makeEl('body');
      const fakeDocument = {
        body: bodyEl,
        visibilityState: 'visible',
        createElement: (tag) => makeEl(tag),
        getElementById: (id) => {
          const walk = (el) => {
            if (el.id === id && !el._removed) return el;
            for (const c of el.children) { const r = walk(c); if (r) return r; }
            return null;
          };
          return walk(bodyEl);
        },
        addEventListener: (type, fn) => { (listeners['document:' + type] = listeners['document:' + type] || []).push(fn); },
      };
      const fakeWindow = {
        addEventListener: (type, fn) => { (listeners['window:' + type] = listeners['window:' + type] || []).push(fn); },
        open: (url) => { openedUrls.push(url); },
        ShifaUpdater: null,
      };
      const ctx = vm.createContext({
        console,
        localStorage: localStore,
        sessionStorage: sessionStore,
        document: fakeDocument,
        window: fakeWindow,
        navigator: { userAgent: 'smoke-test-agent' },
        location: { hash: '#/patient' },
        fetch: (url, opts) => { fetchCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null }); return Promise.resolve({ ok: true }); },
        setInterval: (fn) => { (ctx.__intervals = ctx.__intervals || []).push(fn); return 1; },
        setTimeout: (fn) => 1,
        Date,
        JSON,
        Promise,
        store: { phone: '01012345678', bootstrap: null },
        LANG: 'ar',
        API_BASE: 'http://127.0.0.1:3456',
        t: (k) => k,
        esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        $: () => null,
        toast: () => {},
      });
      vm.runInContext(code, ctx);
      const run = (snippet) => { ctx.__out = undefined; vm.runInContext(snippet, ctx); return ctx.__out; };
      // Token migration: sessionStorage -> localStorage, never overwrites.
      vm.runInContext('sessionStorage.setItem("shifa_token", "tok-1"); sessionStorage.setItem("shifa_refresh", "ref-1"); sessionStorage.setItem("shifa_role", "patient"); sessionStorage.setItem("shifa_phone", "01012345678"); localStorage.setItem("shifa_role", "provider");', ctx);
      vm.runInContext('migrateSessionTokens();', ctx);
      check('§28 migrateSessionTokens copies session tokens to localStorage', localStore.getItem('shifa_token') === 'tok-1' && localStore.getItem('shifa_refresh') === 'ref-1' && localStore.getItem('shifa_phone') === '01012345678', JSON.stringify([...localStore._map.entries()]));
      check('§28 migrateSessionTokens never overwrites a localStorage value', localStore.getItem('shifa_role') === 'provider', localStore.getItem('shifa_role'));
      // Last-screen restore: safe routes restore, login/PIN/terms go home.
      const rs = (hash, admin) => run(`__out = resolveRestoreScreen(${JSON.stringify(hash)}, ${admin});`);
      check('§28 restore: patient screen restores', rs('#/patient', false) === '#/patient', String(rs('#/patient', false)));
      check('§28 restore: login screen goes home', rs('#/login?role=patient', false) === '#/', String(rs('#/login?role=patient', false)));
      check('§28 restore: admin without token goes home', rs('#/admin', false) === '#/', String(rs('#/admin', false)));
      check('§28 restore: admin with token restores', rs('#/admin', true) === '#/admin', String(rs('#/admin', true)));
      check('§28 restore: terms goes home', rs('#/terms', false) === '#/', String(rs('#/terms', false)));
      check('§28 restore: empty goes home', rs(null, false) === '#/', String(rs(null, false)));
      // Update decision: only a newer code WITH a URL is an update.
      const ua = (obj) => run(`__out = updateAvailable(${JSON.stringify(obj)});`);
      check('§28 update: no latestApp -> no update', ua(null) === false);
      check('§28 update: code 0 / empty URL -> no update', ua({ code: 0, apkUrl: '' }) === false);
      check('§28 update: same code -> no update', ua({ code: 21, apkUrl: 'https://x/app.apk' }) === false);
      check('§28 update: newer code + URL -> update', ua({ code: 24, apkUrl: 'https://x/app.apk' }) === true);
      check('§28 update: newer code but no URL -> no update', ua({ code: 24, apkUrl: '' }) === false);
      const dc = (obj) => run(`__out = updateDialogConfig(${JSON.stringify(obj)});`);
      check('§28 update dialog: optional update can be postponed', dc({ code: 22, version: '2.1.8', apkUrl: 'https://x', force: false }).hideCancel === false);
      check('§28 update dialog: forced update cannot be postponed', dc({ code: 22, version: '2.1.8', apkUrl: 'https://x', force: true }).hideCancel === true);
      // In-app dialogs: open / submit / cancel (the native prompt()/confirm()
      // these replace were killing the app process on the test phones).
      vm.runInContext('__p = showInputDialog({title: "Why?"}); __p.then((v) => { __resolved = v; });', ctx);
      check('§28 input dialog opens an overlay', !!fakeDocument.getElementById('appDialogOverlay'), 'overlay missing');
      {
        const overlay = fakeDocument.getElementById('appDialogOverlay');
        const input = overlay.querySelector('#appDialogInput');
        input.value = 'my complaint text';
        overlay.querySelector('#appDialogOk').onclick();
      }
      await sleep(10);
      check('§28 input dialog submit resolves with the typed value', ctx.__resolved === 'my complaint text', String(ctx.__resolved));
      check('§28 input dialog is removed after submit', !fakeDocument.getElementById('appDialogOverlay'), 'overlay still there');
      vm.runInContext('__resolved = undefined; __p = showInputDialog({title: "Why?"}); __p.then((v) => { __resolved = v; });', ctx);
      fakeDocument.getElementById('appDialogOverlay').querySelector('#appDialogCancel').onclick();
      await sleep(10);
      check('§28 input dialog cancel resolves null', ctx.__resolved === null, String(ctx.__resolved));
      vm.runInContext('__resolved = undefined; __p = showInputDialog({title: "Why?"}); __p.then((v) => { __resolved = v; });', ctx);
      {
        const overlay = fakeDocument.getElementById('appDialogOverlay');
        (overlay._listeners.click || []).forEach((fn) => fn({ target: overlay }));
      }
      await sleep(10);
      check('§28 input dialog background tap resolves null', ctx.__resolved === null, String(ctx.__resolved));
      vm.runInContext('__resolved = undefined; __p = showConfirmDialog({title: "Sure?"}); __p.then((v) => { __resolved = v; });', ctx);
      fakeDocument.getElementById('appDialogOverlay').querySelector('#appDialogOk').onclick();
      await sleep(10);
      check('§28 confirm dialog confirm resolves true', ctx.__resolved === true, String(ctx.__resolved));
      vm.runInContext('__resolved = undefined; __p = showConfirmDialog({title: "Sure?"}); __p.then((v) => { __resolved = v; });', ctx);
      fakeDocument.getElementById('appDialogOverlay').querySelector('#appDialogCancel').onclick();
      await sleep(10);
      check('§28 confirm dialog cancel resolves false', ctx.__resolved === false, String(ctx.__resolved));
      vm.runInContext('__resolved = undefined; __p = showConfirmDialog({title: "Must", hideCancel: true}); __p.then((v) => { __resolved = v; });', ctx);
      {
        const overlay = fakeDocument.getElementById('appDialogOverlay');
        check('§28 forced confirm dialog has no cancel button', overlay.querySelector('#appDialogCancel') === null, 'cancel present');
        (overlay._listeners.click || []).forEach((fn) => fn({ target: overlay }));
      }
      await sleep(10);
      check('§28 forced confirm dialog background tap does not resolve', ctx.__resolved === undefined, String(ctx.__resolved));
      vm.runInContext('__p = showInputDialog({title: "Why?"}); __p.then((v) => { __resolved = v; }); __resolved = undefined;', ctx);
      vm.runInContext('closeAppDialog();', ctx);
      await sleep(10);
      check('§28 closeAppDialog resolves a pending dialog as cancelled', ctx.__resolved === null, String(ctx.__resolved));
      // Death detector: heartbeat without a clean flag reports on boot;
      // a clean exit stays silent; JS errors are reported as js_error.
      vm.runInContext('localStorage.setItem("shifa_heartbeat", JSON.stringify({ts: 1234567890, screen: "#/patient"}));', ctx);
      fetchCalls.length = 0;
      vm.runInContext('initSessionTracking();', ctx);
      await sleep(10);
      check('§28 death detector reports an unclean exit on boot', fetchCalls.length === 1 && fetchCalls[0].body && fetchCalls[0].body.kind === 'unclean_exit' && fetchCalls[0].body.lastScreen === '#/patient' && fetchCalls[0].body.lastHeartbeat === 1234567890 && fetchCalls[0].body.phone === '01012345678', JSON.stringify(fetchCalls));
      check('§28 error listener is registered', (listeners['window:error'] || []).length === 1, String((listeners['window:error'] || []).length));
      (listeners['window:error'] || [])[0]({ message: 'boom', error: { stack: 'at x' } });
      await sleep(10);
      check('§28 JS error is reported as js_error', fetchCalls.length === 2 && fetchCalls[1].body.kind === 'js_error' && fetchCalls[1].body.message === 'boom', JSON.stringify(fetchCalls));
      vm.runInContext('__intervals[0]();', ctx);
      check('§28 heartbeat writes the current screen to localStorage', (() => { try { const h = JSON.parse(localStore.getItem('shifa_heartbeat') || 'null'); return h && typeof h.ts === 'number' && h.screen === '#/patient'; } catch { return false; } })(), localStore.getItem('shifa_heartbeat'));
      vm.runInContext('localStorage.setItem("shifa_heartbeat", JSON.stringify({ts: 1234567890, screen: "#/patient"})); localStorage.setItem("shifa_clean_exit", "1"); initSessionTracking();', ctx);
      await sleep(10);
      check('§28 death detector stays silent after a clean exit', fetchCalls.length === 2, JSON.stringify(fetchCalls));
      // Update install: native bridge when present, browser fallback when not.
      const bridgeCalls = [];
      fakeWindow.ShifaUpdater = {
        canRequestInstalls: () => true,
        downloadAndInstall: (u) => { bridgeCalls.push(u); },
        openUnknownSourcesSettings: () => { bridgeCalls.push('settings'); },
      };
      vm.runInContext('startAppUpdate({code: 22, version: "2.1.8", apkUrl: "https://example.com/app.apk", force: false});', ctx);
      check('§28 startAppUpdate uses the native bridge when present', bridgeCalls.length === 1 && bridgeCalls[0] === 'https://example.com/app.apk', JSON.stringify(bridgeCalls));
      fakeWindow.ShifaUpdater.canRequestInstalls = () => false;
      bridgeCalls.length = 0;
      openedUrls.length = 0;
      vm.runInContext('startAppUpdate({code: 22, version: "2.1.8", apkUrl: "https://example.com/app.apk", force: false});', ctx);
      await sleep(10);
      check('§28 startAppUpdate without install permission shows the settings dialog, no download', bridgeCalls.length === 0 && !!fakeDocument.getElementById('appDialogOverlay'), JSON.stringify(bridgeCalls));
      vm.runInContext('closeAppDialog();', ctx);
      fakeWindow.ShifaUpdater = null;
      vm.runInContext('startAppUpdate({code: 22, version: "2.1.8", apkUrl: "https://example.com/app.apk", force: false});', ctx);
      check('§28 startAppUpdate without a bridge opens the APK URL in the browser', openedUrls.length === 1 && openedUrls[0] === 'https://example.com/app.apk', JSON.stringify(openedUrls));
    }
  }
  // 28d. Static contract checks on the shipped web app.
  {
    const webJs = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    const noComments = webJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    check('§28 no native prompt() calls remain in web/app.js', !/\bprompt\s*\(/.test(noComments), 'prompt( found');
    check('§28 no native confirm() calls remain in web/app.js', !/\bconfirm\s*\(/.test(noComments), 'confirm( found');
    check('§28 tokens are stored in localStorage, never written to sessionStorage', webJs.includes('localStorage.setItem("shifa_token"') && !webJs.includes('sessionStorage.setItem("shifa_token"'), 'token storage');
    check('§28 no sessionStorage token reads except the one-time migration fallback', (webJs.match(/sessionStorage\.getItem\("shifa_(token|refresh|role|phone|admin_token)"\)/g) || []).length === 5, 'unexpected sessionStorage token reads');
    check('§28 provider registration never sends users to provider login', !webJs.includes("navigate('#/login?role=provider')"), 'role=provider nav found');
    check('§28 login entries go to patient login', webJs.includes("navigate('#/login?role=patient')"), 'no patient login entry');
    check('§28 registration failures show the server message verbatim', webJs.includes('err.serverMessage || apiErrorMessage(err)'), 'serverMessage not shown');
    check('§28 home screen has a visible patient login button', webJs.includes('btn-primary btn-block" onclick="navigate(\'#/login?role=patient\')" style="margin-top:10px">🔐'), 'no home login button');
    check('§28 notification bell is always visible (not only after login)', webJs.includes('class="bell-btn"') && !webJs.includes('store.token ? `<button class="bell-btn"'), 'bell still gated on token');
    check('§28 terms page shows a prominent scroll-to-accept hint', webJs.includes('termsScrollMust') && webJs.includes('termsScrollHintBox'), 'no prominent terms hint');
    check('§28 last-screen restore is wired (save on navigate, restore at boot)', webJs.includes('saveLastScreen(hash)') && webJs.includes('restoreLastScreen'), 'last-screen restore not wired');
    check('§28 update checker runs after bootstrap on launch', webJs.includes('await loadBootstrap(); checkForAppUpdate();'), 'update check not wired');
    check('§28 version header is v2.1.9 code 23', webJs.includes('v2.1.9, code 23'), 'header not bumped');
  }

  // --- §29. v2.1.8: password-gated login + push de-automation + responsive layout ---
  console.log('\n[§29 v2.1.8]');
  // 29a. Registration validation + bcrypt.
  {
    const xff = '10.29.1.1';
    r = await req('POST', '/api/auth/register', { xff, body: { phone: '01029100001', password: 'short', terms: TERMS } });
    check('§29 register with a <6-char password -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/register', { xff, body: { phone: '123', password: 'secret1', terms: TERMS } });
    check('§29 register with an invalid phone -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/register', { xff, body: { phone: '01029100001', password: 'secret1', terms: { acceptedTerms: false, termsVersion: '1.0' } } });
    check('§29 register without terms acceptance -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/register', { xff, body: { phone: '01029100001', password: 'secret1', terms: TERMS } });
    check('§29 register valid -> 201 + password tokens, no password gate', r.status === 201 && !!r.json?.token && !!r.json?.refreshToken && r.json?.authMethod === 'password' && r.json?.requiresPassword === false, JSON.stringify(r.json));
    const regToken = r.json?.token;
    r = await req('POST', '/api/auth/register', { xff, body: { phone: '01029100001', password: 'other12', terms: TERMS } });
    check('§29 re-registering the same phone -> 409', r.status === 409, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: '01029100001', password: 'secret1' } });
    check('§29 login with the right password -> 200 + authMethod password', r.status === 200 && r.json?.authMethod === 'password' && r.json?.requiresPassword === false, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: '01029100001', password: 'wrongpw' } });
    check('§29 login with the wrong password -> generic 401 (never reveals which field)', r.status === 401 && r.json?.message === 'رقم الهاتف أو كلمة المرور غير صحيحة', JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: '01029100001' } });
    check('§29 login with no password on a password account -> 401', r.status === 401, JSON.stringify(r.json));
    // The stored record holds ONLY a bcrypt hash (cost 10) — and the
    // plaintext password appears nowhere in the data file or the audit.
    const dataText = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(dataText);
    const rec = data.users && data.users['01029100001'];
    check('§29 stored password is a bcrypt hash (cost 10), never plaintext', !!rec?.passwordHash && typeof rec.passwordHash === 'string' && /^\$2[ab]\$10\$/.test(rec.passwordHash) && rec.passwordHash !== 'secret1', String(rec?.passwordHash || '').slice(0, 12));
    check('§29 plaintext password appears nowhere in the data file', !dataText.includes('secret1'), 'secret1 found in data file');
    check('§29 wrong-password audit exists, without a password value', (data.audit || []).some((a) => a.action === 'auth.login_wrong_password' && a.actor === '01029100001') && !dataText.includes('wrongpw'), 'audit missing or leaks password');
    void regToken;
  }
  // 29b. Rate-limit lockout: 5 failures in 15 minutes lock the phone.
  {
    const xff = '10.29.2.2';
    r = await req('POST', '/api/auth/register', { xff: '10.29.2.1', body: { phone: '01029100002', password: 'lockme1', terms: TERMS } });
    check('§29 lockout setup: register -> 201', r.status === 201, JSON.stringify(r.json));
    let fails = 0;
    for (let i = 0; i < 5; i++) {
      r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: '01029100002', password: 'badpass' } });
      if (r.status === 401) fails++;
    }
    check('§29 5 wrong passwords -> 5x generic 401', fails === 5, String(fails));
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: '01029100002', password: 'lockme1' } });
    check('§29 6th attempt (even with the RIGHT password) -> 429 lockout', r.status === 429, JSON.stringify(r.json));
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    check('§29 lockout is audited (auth.login_locked_out)', (data.audit || []).some((a) => a.action === 'auth.login_locked_out' && a.actor === '01029100002'), 'no lockout audit');
  }
  // 29c. Migration: a legacy phone-only account logs in once, sets a
  // password, and after that password login is mandatory.
  {
    const xff = '10.29.3.1';
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: '01029100003' } });
    check('§29 legacy account logs in phone-only once -> 200 + requiresPassword', r.status === 200 && r.json?.requiresPassword === true && r.json?.authMethod === 'phone-only', JSON.stringify(r.json));
    const legacyToken = r.json?.token;
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: '01029100003', password: 'anything' } });
    check('§29 legacy account ignores a sent password, still requires one', r.status === 200 && r.json?.requiresPassword === true, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/set-password', { token: legacyToken, body: { password: 'short' } });
    check('§29 set-password rejects <6 chars -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/set-password', { token: legacyToken, body: { password: 'legacy1' } });
    check('§29 legacy account sets its own password -> 200', r.status === 200 && r.json?.requiresPassword === false, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: '01029100003', password: 'legacy1' } });
    check('§29 after migration, password login works -> 200, no gate', r.status === 200 && r.json?.requiresPassword === false && r.json?.authMethod === 'password', JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: '01029100003' } });
    check('§29 after migration, phone-only login is refused -> 401', r.status === 401, JSON.stringify(r.json));
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    check('§29 password_set is audited', (data.audit || []).some((a) => a.action === 'auth.password_set' && a.actor === '01029100003'), 'no password_set audit');
  }
  // 29d. Admin password reset (no OTP exists): temp password, sessions
  // revoked, old password dead, temp login forces a new password.
  {
    const xffReg = '10.29.4.1', xffLogin = '10.29.4.2';
    r = await req('POST', '/api/auth/register', { xff: xffReg, body: { phone: '01029100004', password: 'resetme', terms: TERMS } });
    check('§29 reset setup: register -> 201', r.status === 201, JSON.stringify(r.json));
    const oldRefresh = r.json?.refreshToken;
    r = await req('POST', '/api/admin/password-reset', { token: adminToken, body: { phone: '01029100009' } });
    check('§29 reset for an unknown phone -> 404', r.status === 404, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/password-reset', { token: adminToken, body: { phone: '01029100004' } });
    check('§29 admin reset -> 200 + 8-char temp password + hadPassword', r.status === 200 && typeof r.json?.tempPassword === 'string' && r.json.tempPassword.length === 8 && r.json?.hadPassword === true && (r.json?.sessionsRevoked || 0) >= 1, JSON.stringify({ ...r.json, tempPassword: r.json?.tempPassword ? '<hidden>' : null }));
    const tempPassword = r.json?.tempPassword;
    r = await req('POST', '/api/auth/refresh', { body: { refreshToken: oldRefresh } });
    check('§29 reset revokes the old session (refresh -> 401)', r.status === 401, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { xff: xffLogin, body: { phone: '01029100004', password: 'resetme' } });
    check('§29 old password is dead after reset -> 401', r.status === 401, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { xff: xffLogin, body: { phone: '01029100004', password: tempPassword } });
    check('§29 temp password logs in -> 200 + must change it', r.status === 200 && r.json?.requiresPasswordChange === true, JSON.stringify(r.json));
    const tempToken = r.json?.token;
    r = await req('POST', '/api/auth/set-password', { token: tempToken, body: { password: 'newpass1' } });
    check('§29 temp login sets a new own password -> 200', r.status === 200, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { xff: xffLogin, body: { phone: '01029100004', password: 'newpass1' } });
    check('§29 new password works, no more gate -> 200', r.status === 200 && r.json?.requiresPasswordChange === false && r.json?.requiresPassword === false, JSON.stringify(r.json));
    const dataText = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(dataText);
    check('§29 reset is audited (admin.password_reset, phone only)', (data.audit || []).some((a) => a.action === 'admin.password_reset' && a.actor === 'admin' && a.details?.phone === '01029100004'), 'no reset audit');
    check('§29 temp password value appears nowhere in the data file', !dataText.includes(tempPassword), 'temp password leaked into data file');
  }
  // 29e. Push de-automation + death-step markers (the 2.1.7 login kill).
  {
    const webJs = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    const noComments = webJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    check('§29 no automatic push registration remains (registerPushToken is gone)', !noComments.includes('registerPushToken'), 'registerPushToken still present');
    const clStart = webJs.indexOf('async function completeLogin');
    const clEnd = webJs.indexOf('\n}\n', clStart);
    const clBody = clStart !== -1 && clEnd !== -1 ? webJs.slice(clStart, clEnd) : '';
    check('§29 completeLogin shows only the DOM explain card, no native push', clBody.includes('maybeShowPushExplainCard();') && !clBody.includes('getPushPlugin') && !clBody.includes('PushNotifications') && !clBody.includes('registerPushToken'), 'completeLogin still touches push');
    check('§29 getPushPlugin is called only from requestPushPermission', (webJs.match(/getPushPlugin\(\)/g) || []).length === 2, `getPushPlugin() occurrences: ${(webJs.match(/getPushPlugin\(\)/g) || []).length}`);
    check('§29 no silent permission check on the login path (checkPermissions gone)', !noComments.includes('checkPermissions'), 'checkPermissions still present');
    check('§29 native push.register() lives only in requestPushPermission', (webJs.match(/push\.register\(\)/g) || []).length === 1 && webJs.includes('async function requestPushPermission()'), 'push.register() outside requestPushPermission');
    check('§29 explicit-tap entry points exist (card Allow + notifications button)', webJs.includes('await requestPushPermission();') && webJs.includes('requestPushPermission();'), 'explicit-tap entry missing');
    check('§29 death-step markers wrap every native push call', webJs.includes('setDeathStep("push:requestPermissions")') && webJs.includes('setDeathStep("push:register")') && webJs.includes('setDeathStep("push:addListener")') && webJs.includes('clearDeathStep()'), 'step markers missing');
    const ruStart = webJs.indexOf('async function refreshUnreadCount');
    const ruEnd = webJs.indexOf('\n}\n', ruStart);
    const ruBody = ruStart !== -1 && ruEnd !== -1 ? webJs.slice(ruStart, ruEnd) : '';
    const vnStart = webJs.indexOf('function viewNotifications');
    const vnEnd = webJs.indexOf('\n}\n', vnStart);
    const vnBody = vnStart !== -1 && vnEnd !== -1 ? webJs.slice(vnStart, vnEnd) : '';
    check('§29 in-app notification centre never touches native push', ruBody.includes('api("/api/me/notifications")') && !ruBody.includes('getPushPlugin') && !ruBody.includes('push.register(') && !ruBody.includes('push.requestPermissions(') && !vnBody.includes('getPushPlugin') && !vnBody.includes('push.register(') && !vnBody.includes('push.requestPermissions(') && !vnBody.includes('push.checkPermissions(') && !vnBody.includes('push.addListener('), 'centre depends on push');
    check('§29 first-launch gate: home without a token opens the login gate', webJs.includes('html = store.token ? viewHome() : viewLogin("patient")'), 'home gate missing');
    check('§29 boot forces the login gate when logged out, set-password when gated', webJs.includes('history.replaceState(null, "", "#/login?role=patient")') && webJs.includes('history.replaceState(null, "", "#/set-password")'), 'boot gate missing');
    check('§29 set-password route exists and is token-guarded', webJs.includes('path === "set-password"') && webJs.includes('store.token ? viewSetPassword() : viewLogin("patient")'), 'set-password route missing');
    check('§29 admin passwords tab exists (reset UI)', webJs.includes('"passwords"') && webJs.includes('resetUserPassword') && webJs.includes('/api/admin/password-reset'), 'passwords tab missing');
    check('§29 forgot-password link points at the support WhatsApp', webJs.includes('toggleForgotPassword()') && webJs.includes('wa.me/201008629060'), 'forgot-password link missing');
    // Death-step helpers (v2.1.8 block, extracted verbatim) + the
    // unclean_exit report carrying lastStep (v2.1.7 block, §28 style).
    const vm = require('vm');
    const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    const BEGIN8 = '/* v2.1.8 — testable helpers (BEGIN';
    const END8 = '/* v2.1.8 — testable helpers (END) */';
    const bi8 = appJs.indexOf(BEGIN8);
    const ei8 = appJs.indexOf(END8, bi8);
    check('§29 v2.1.8 helpers block is extractable from web/app.js', bi8 !== -1 && ei8 !== -1 && ei8 > bi8, `${bi8}/${ei8}`);
    if (bi8 !== -1 && ei8 !== -1) {
      const code8 = appJs.slice(bi8, ei8);
      const m8 = new Map();
      const ls8 = { getItem: (k) => (m8.has(k) ? m8.get(k) : null), setItem: (k, v) => m8.set(k, String(v)), removeItem: (k) => m8.delete(k) };
      const ctx8 = vm.createContext({ localStorage: ls8, console });
      vm.runInContext(code8, ctx8);
      vm.runInContext('setDeathStep("push:register");', ctx8);
      check('§29 setDeathStep persists the step in localStorage', ls8.getItem('shifa_death_step') === 'push:register', String(ls8.getItem('shifa_death_step')));
      const step = vm.runInContext('getDeathStep();', ctx8);
      check('§29 getDeathStep reads the step back', step === 'push:register', String(step));
      vm.runInContext('clearDeathStep();', ctx8);
      check('§29 clearDeathStep removes the step', ls8.getItem('shifa_death_step') === null, String(ls8.getItem('shifa_death_step')));
      check('§29 getDeathStep is null when no step is set', vm.runInContext('getDeathStep();', ctx8) === null, '');
    }
    // The unclean_exit report carries the step that survived the kill.
    // (The §28a client-report bucket is full on the default IP, so this
    // report uses a distinct X-Forwarded-For.)
    r = await req('POST', '/api/client-report', { xff: '10.29.9.9', body: { kind: 'unclean_exit', lastScreen: '#/login', lastHeartbeat: 1234567890, lastStep: 'push:register', screen: '#/login', appVersion: '2.1.8 (22)' } });
    check('§29 client-report accepts lastStep -> 200', r.status === 200 && typeof r.json?.id === 'string', JSON.stringify(r.json));
    r = await req('GET', '/api/admin/client-reports', { token: adminToken });
    const withStep = (r.json || []).find((x) => x.lastStep === 'push:register');
    check('§29 stored unclean_exit report keeps lastStep', !!withStep && withStep.appVersion === '2.1.8 (22)', JSON.stringify(withStep));
  }
  // 29f. Version header + responsive layout (360–430px audit).
  {
    const webJs = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    check('§29 version header is v2.1.9 code 23', webJs.includes('v2.1.9, code 23'), 'header not bumped');
    check('§29 APP_VERSION_CODE is 23 / NAME is 2.1.9', webJs.includes('const APP_VERSION_CODE = 23;') && webJs.includes('const APP_VERSION_NAME = "2.1.9";'), 'version constants not bumped');
    check('§29 footer shows the installed version in-app', webJs.includes('v${APP_VERSION_NAME} (${APP_VERSION_CODE})'), 'footer has no version');
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'style.css'), 'utf8');
    check('§29 CSS: no horizontal page scroll (overflow-x clip safety net)', css.includes('overflow-x: clip'), 'no overflow-x guard');
    check('§29 CSS: topbar compacts at <=520px (smaller logo, tagline hidden)', css.includes('.topbar .brand small { display: none; }') && css.includes('.topbar .logo { width: 36px;'), 'topbar not compacted');
    check('§29 CSS: OTP boxes shrink at <=400px (fit a 360px card)', css.includes('.otp-box input { width: 40px; height: 48px;'), 'OTP boxes not shrunk');
    check('§29 CSS: role/service grids use two columns on phones', css.includes('minmax(150px, 1fr)') && css.includes('minmax(160px, 1fr)'), 'grids still single-column');
    check('§29 CSS: long tables scroll inside themselves', css.includes('table.tbl') && css.includes('display: block; overflow-x: auto;'), 'tables can overflow');
  }

  // 29g. Dual-role login (v2.1.8 fix found by the Playwright viewport
  // test): a phone that is BOTH a patient and a provider must get the
  // token role it asked for. Before the fix, login-phone ignored the
  // requested role and forced 'provider' whenever a provider record
  // existed, so a nurse booking care for a family member got a
  // provider token and every patient call (favourites, booking,
  // complaint) 403'd.
  {
    const xff = '10.29.9.5';
    const dualPhone = '01029100005';
    r = await req('POST', '/api/auth/register', { xff, body: { phone: dualPhone, password: 'dualpass1', terms: { acceptedTerms: true, termsVersion: '1.0' } } });
    check('§29 dual-role setup: patient registration -> 201', r.status === 201, JSON.stringify(r.json));
    const dualPatientToken = r.json?.accessToken;
    r = await req('POST', '/api/providers/register', { xff, token: dualPatientToken, body: { ...TERMS, name: 'Dual Role Nurse', providerType: 'nurse', role: 'nurse', nationalId: '12345678901234', licenseNo: 'LIC-DUAL1', certificates: [] } });
    check('§29 dual-role setup: same phone registers as a provider -> 201', r.status === 201, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: dualPhone, password: 'dualpass1', role: 'patient' } });
    check('§29 dual-role login as patient returns a PATIENT token', r.status === 200 && r.json?.role === 'patient', JSON.stringify(r.json)?.slice(0, 200));
    const dualAsPatient = r.json?.accessToken;
    r = await req('GET', '/api/me/favorites', { token: dualAsPatient });
    check('§29 dual-role patient token can call patient endpoints (favourites 200)', r.status === 200, JSON.stringify(r.json)?.slice(0, 120));
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: dualPhone, password: 'dualpass1', role: 'provider' } });
    check('§29 dual-role login as provider returns a PROVIDER token', r.status === 200 && r.json?.role === 'provider' && typeof r.json?.providerId === 'string', JSON.stringify(r.json)?.slice(0, 200));
    const dualAsProvider = r.json?.accessToken;
    r = await req('GET', '/api/providers/me', { token: dualAsProvider });
    check('§29 dual-role provider token can call provider endpoints (me 200)', r.status === 200 && r.json?.phone === dualPhone, JSON.stringify(r.json)?.slice(0, 120));
    r = await req('POST', '/api/auth/login-phone', { xff, body: { phone: dualPhone, password: 'dualpass1' } });
    check('§29 dual-role login with no role defaults to patient', r.status === 200 && r.json?.role === 'patient', JSON.stringify(r.json)?.slice(0, 200));
  }

  // 29h. Client error-status fix (v2.1.8, found by the Playwright
  // viewport test): api()'s generic failure path threw the server text
  // with no .status, so `e.message === "404"` in resetUserPassword
  // and `e.message === "409"` in registerAccount never matched and the
  // admin/patient saw the raw English server message instead of the
  // Arabic one. The generic path now attaches .status + .serverMessage
  // while keeping e.message as the server text (the chat handler and
  // apiErrorMessage rely on that).
  {
    const webJs = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    check('§29 api() generic failure carries .status + .serverMessage', webJs.includes('e.status = res.status;') && webJs.includes('e.serverMessage = data.message;'), 'generic throw has no status');
    check('§29 resetUserPassword branches on e.status === 404', webJs.includes('e.status === 404 || e.message === "404"'), 'reset 404 check missing');
    check('§29 registerAccount branches on e.status === 409', webJs.includes('e.status === 409 || e.message === "409"'), 'register 409 check missing');
  }

  // --- §30. v2.1.9: in-app option sheets + safe-area topbar + native-dialog audit ---
  console.log('\n[§30 v2.1.9]');
  {
    const webJs = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'style.css'), 'utf8');
    // 30a. Native-dialog audit (the v2.1.8 complaint-dropdown kill):
    // ZERO <select> elements may remain — the last one (#tqComplaint)
    // was replaced by the owner-approved in-app complaint sheet.
    const selectEls = (webJs.match(/<select\s/g) || []).length;
    check('§30 zero <select> elements remain in the app', selectEls === 0, `found ${selectEls}`);
    check('§30 no native prompt() anywhere', !webJs.includes('prompt('), 'prompt( present');
    check('§30 no native confirm() anywhere', !webJs.includes('confirm('), 'confirm( present');
    check('§30 no native date inputs', !webJs.includes('type="date"'), 'type="date" present');
    check('§30 no native time inputs', !webJs.includes('type="time"'), 'type="time" present');
    // 30a2. The complaint sheet itself (owner-approved 26 Nov 2026):
    // 12 large tappable rows + an "other" row that reveals free text.
    check('§30 complaintOptions lists all 12 complaints incl. other', webJs.includes('function complaintOptions()') && ['"chest"', '"breath"', '"fever"', '"wound"', '"abdominal"', '"dizzy"', '"pain"', '"catheter"', '"iv"', '"postop"', '"vomit"', '"other"'].every((v) => webJs.includes(v)), 'complaint list incomplete');
    check('§30 complaint sheet uses large rows + no search box', webJs.includes('large: true, searchable: false'), 'complaint sheet flags missing');
    check('§30 other-complaint free-text field exists (maxlength 200)', webJs.includes('id="tqComplaintOther"') && webJs.includes('maxlength="200"'), 'other text field missing');
    check('§30 onTriageComplaintSelect toggles the free-text field', webJs.includes('window.onTriageComplaintSelect') && webJs.includes('tqComplaintOtherWrap'), 'other toggle missing');
    check('§30 triageComplaintValue returns the typed text for other', webJs.includes('function triageComplaintValue()') && webJs.includes('c.value === "other"'), 'complaint value helper missing');
    check('§30 readTriageAnswers uses triageComplaintValue', webJs.includes('complaint: triageComplaintValue()'), 'triage still reads the raw select value');
    check('§30 complaint i18n exists in both languages', webJs.includes('tq1_chest: "ألم في الصدر"') && webJs.includes('tq1_chest: "Chest pain"') && webJs.includes('tq1_other_text'), 'complaint i18n missing');
    // 30b. The sheet component itself is present and wired.
    check('§30 appSelectField + openAppSelect + setAppSelectValue exist', webJs.includes('function appSelectField') && webJs.includes('window.openAppSelect') && webJs.includes('function setAppSelectValue'), 'sheet component missing');
    check('§30 hotel sheets use the shared 30-hotel list', webJs.includes('hotelOptionsList()') && (webJs.match(/hotelOptionsList\(\)/g) || []).length >= 4, 'hotel sheets missing');
    check('§30 sheet search strings exist (ar + en)', webJs.includes('sheetSearch') && webJs.includes('sheetNoResults'), 'sheet i18n missing');
    check('§30 date/time normalizers are wired into every submit', webJs.includes('normalizeAllDateTimeFields()') && (webJs.match(/normalizeAllDateTimeFields\(\);/g) || []).length >= 7, 'submit normalization missing');
    check('§30 pickService keeps the sheet label in sync', webJs.includes('setAppSelectValue("bkService", id)'), 'pickService still sets the raw select value');
    // 30c. File inputs: the 9 receipt/certificate uploads remain — the
    // system chooser is a full activity, not a WebView popup, and there
    // is no in-app replacement without the Capacitor Camera plugin.
    const fileIds = ['bkReceipt', 'trackReceipt', 'tuReceipt', 'npReceipt', 'poReceipt', 'prCerts', 'docFile'];
    check('§30 all 9 file inputs are the known receipt/certificate uploads', fileIds.every((id) => webJs.includes(`id="${id}"`)) && (webJs.match(/type="file"/g) || []).length === 9, `file inputs: ${(webJs.match(/type="file"/g) || []).length}`);
    // 30d. Safe-area topbar + sheet styles in CSS.
    check('§30 CSS: topbar respects the Android safe area', css.includes('env(safe-area-inset-top'), 'no safe-area rule');
    check('§30 CSS: option-sheet field + list styles exist', css.includes('.app-select') && css.includes('.opt-item') && css.includes('.opt-search'), 'sheet styles missing');
    check('§30 CSS: large complaint rows exist', css.includes('.opt-list.opt-large .opt-item'), 'large-row styles missing');
    // 30e. Version header.
    check('§30 version header is v2.1.9 code 23', webJs.includes('v2.1.9, code 23') && webJs.includes('const APP_VERSION_CODE = 23;') && webJs.includes('const APP_VERSION_NAME = "2.1.9";'), 'header not bumped');
    // 30g. The v2.1.9 interview SyntaxError (found by the zero-defect
    // tap-through): three radios embedded JSON.stringify (double
    // quotes) inside a DOUBLE-quoted inline handler — the attribute
    // ended early, the handler compiled to `ivAnswer(` and every tap
    // threw "Unexpected end of input" with no stack, recording no
    // answer. The fix is single-quoted handler attributes. This check
    // fails the build if the pattern ever returns.
    check('§30 no JSON.stringify inside a double-quoted inline handler', !/on\w+="[^"]*JSON\.stringify/.test(webJs), 'inline handler embeds JSON.stringify in double quotes');
    check('§30 interview + language-test handlers use single-quoted attributes', webJs.includes("onchange='ivAnswer(") && webJs.includes("onchange='ivEnglish(") && webJs.includes("onchange='ltAnswer("), 'handler quotes reverted');
    const vm = require('vm');
    const BEGIN9 = '/* v2.1.9 — testable helpers (BEGIN';
    const END9 = '/* v2.1.9 — testable helpers (END) */';
    const bi9 = webJs.indexOf(BEGIN9);
    const ei9 = webJs.indexOf(END9, bi9);
    check('§30 v2.1.9 helpers block is extractable from web/app.js', bi9 !== -1 && ei9 !== -1 && ei9 > bi9, `${bi9}/${ei9}`);
    if (bi9 !== -1 && ei9 !== -1) {
      const ctx9 = vm.createContext({ console });
      vm.runInContext(webJs.slice(bi9, ei9), ctx9);
      const d = (x) => vm.runInContext(`normalizeDateValue(${JSON.stringify(x)});`, ctx9);
      const tt = (x) => vm.runInContext(`normalizeTimeValue(${JSON.stringify(x)});`, ctx9);
      check('§30 normalizeDateValue keeps ISO dates', d('2026-11-26') === '2026-11-26', d('2026-11-26'));
      check('§30 normalizeDateValue pads single digits', d('2026-1-5') === '2026-01-05', d('2026-1-5'));
      check('§30 normalizeDateValue accepts DD/MM/YYYY', d('26/11/2026') === '2026-11-26', d('26/11/2026'));
      check('§30 normalizeDateValue accepts DD-MM-YY', d('26-11-26') === '2026-11-26', d('26-11-26'));
      check('§30 normalizeDateValue rejects Feb 30', d('2026-02-30') === '', d('2026-02-30'));
      check('§30 normalizeDateValue rejects month 13', d('2026-13-01') === '', d('2026-13-01'));
      check('§30 normalizeDateValue rejects garbage', d('hello') === '' && d('') === '', d('hello'));
      check('§30 normalizeTimeValue keeps HH:MM', tt('10:00') === '10:00', tt('10:00'));
      check('§30 normalizeTimeValue pads single-digit hour', tt('9:05') === '09:05', tt('9:05'));
      check('§30 normalizeTimeValue accepts 4-digit HHMM', tt('1000') === '10:00', tt('1000'));
      check('§30 normalizeTimeValue rejects hour 25', tt('25:00') === '', tt('25:00'));
      check('§30 normalizeTimeValue rejects garbage', tt('noon') === '' && tt('') === '', tt('noon'));
    }
  }

  // --- 14. logout / refresh revocation ---------------------------------
    console.log('\n[logout]');
    r = await req('POST', '/api/auth/logout', { token: patientToken2, body: { refreshToken } });
    check('logout 200', r.status === 200, JSON.stringify(r.json));
    r = await req('POST', '/api/auth/refresh', { body: { refreshToken } });
    check('revoked refresh token rejected', r.status === 401, JSON.stringify(r.json));
  } catch (e) {
    fail++;
    failures.push(`uncaught: ${e.message}`);
    console.log('  FAIL uncaught exception:', e);
  } finally {
    stop();
    await sleep(500);
    if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  }

  console.log(`\n==== SMOKE: ${pass} passed, ${fail} failed ====`);
  if (failures.length) console.log('Failures:', failures.join(' | '));
  process.exitCode = fail ? 1 : 0;
}

main();
