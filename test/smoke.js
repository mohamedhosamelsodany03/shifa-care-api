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
    // v2.1.13 (H17/M19): the national ID must be a valid Egyptian ID
    // (first digit 3, birthdate 2003-04-19, governorate 01) UNIQUE per
    // phone, the licence unique per phone, and the server terms record
    // must exist first (POST /api/me/terms with the OTP token).
    async function registerProvider(phone, role, extra = {}) {
      await req('POST', '/api/otp/request', { body: { phone, channel: 'whatsapp' } });
      const code = await mockCode(phone);
      const v = await req('POST', '/api/otp/verify', { body: { phone, code } });
      const tok = v.json?.accessToken;
      await req('POST', '/api/me/terms', { token: tok, body: { acceptedTerms: true, termsVersion: '1.0' } });
      const nationalId = `303041901${phone.slice(-4)}1`;
      const reg = await req('POST', '/api/providers/register', { token: tok, body: { ...TERMS,
        name: `Test ${role}`, providerType: role, role, nationalId, licenseNo: `LIC-${phone.slice(-4)}`,
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
    // v2.1.13 (H15): answers are POSITIONS (0-3) into the published
    // options, computed by matching the correct option TEXT — never a
    // key letter (the server rejects key letters with 400). The bank is
    // 90 questions and each attempt samples 36, so the correct position
    // is found per question from the bank text. In 'red-flag' mode EVERY
    // sampled red-flag question is answered with its red-flag option
    // (at least one is sampled in practice — 13 red flags in the bank).
    async function answerInterview(token, mode) {
      const st = await req('POST', '/api/providers/interview/start', { token });
      if (st.status !== 200) return { start: st, submit: null };
      const answers = {};
      // v2.1.13 (H15): a deliberately-wrong answer must NEVER be the
      // red-flag option — otherwise the attempt ends 'red-flag' instead
      // of the intended 'failed'/'manual-review' (the red-flag position
      // is shuffled per attempt, so picking (correct+1)%4 blindly is a
      // ~1-in-3 coin flip per red-flag question).
      const wrongIdxFor = (q) => {
        const bankQ = MCQ.find((x) => x.id === q.id);
        const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
        const correctIdx = q.options.findIndex((o) => o.text === correctText);
        const rfText = bankQ?.redFlagOption ? bankQ.options.find((o) => o.key === bankQ.redFlagOption)?.text : null;
        const rfIdx = rfText != null ? q.options.findIndex((o) => o.text === rfText) : -1;
        for (let d = 1; d <= 3; d++) {
          const cand = (correctIdx + d) % q.options.length;
          if (cand !== rfIdx) return cand;
        }
        return (correctIdx + 1) % q.options.length;
      };
      for (const q of st.json.questions) {
        const bankQ = MCQ.find((x) => x.id === q.id);
        const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
        const correctIdx = q.options.findIndex((o) => o.text === correctText);
        const wrongIdx = wrongIdxFor(q);
        if (mode === 'all-correct') answers[q.id] = correctIdx;
        else if (mode === 'all-wrong') answers[q.id] = wrongIdx;
        else if (mode === 'ethics-wrong') answers[q.id] = q.category === 'ethics' ? wrongIdx : correctIdx;
        else if (mode === 'manual-review') answers[q.id] = ['communication', 'resilience', 'conduct'].includes(q.category) ? wrongIdx : correctIdx;
        else if (mode === 'red-flag') {
          const rfText = bankQ?.redFlagOption ? bankQ.options.find((o) => o.key === bankQ.redFlagOption)?.text : null;
          answers[q.id] = rfText != null ? q.options.findIndex((o) => o.text === rfText) : correctIdx;
        }
      }
      const enAnswers = {};
      for (const q of st.json.englishCheck.questions) {
        const bankQ = ENGLISH_CHECK.find((x) => x.id === q.id);
        const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
        enAnswers[q.id] = q.options.findIndex((o) => o.text === correctText);
      }
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
    // v2.1.13 (H15): answers must be valid positions (0-3) — the old
    // 'zzz' placeholder is now rejected with 400, so a deliberately
    // wrong answer is a real wrong POSITION (never the red-flag
    // option, or the attempt would end 'red-flag' instead of 'failed').
    const wrong = {};
    for (const q of r.json.questions) {
      const bankQ = MCQ.find((x) => x.id === q.id);
      const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
      const correctIdx = q.options.findIndex((o) => o.text === correctText);
      const rfText = bankQ?.redFlagOption ? bankQ.options.find((o) => o.key === bankQ.redFlagOption)?.text : null;
      const rfIdx = rfText != null ? q.options.findIndex((o) => o.text === rfText) : -1;
      let w = (correctIdx + 1) % q.options.length;
      if (w === rfIdx) w = (correctIdx + 2) % q.options.length;
      wrong[q.id] = w;
    }
    const enWrong = {};
    for (const q of r.json.englishCheck.questions) {
      const bankQ = ENGLISH_CHECK.find((x) => x.id === q.id);
      const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
      const correctIdx = q.options.findIndex((o) => o.text === correctText);
      enWrong[q.id] = (correctIdx + 1) % q.options.length;
    }
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
    // Red flag: correct everywhere except the red-flag options
    // (e.g. treating an unconscious patient at home instead of calling
    // 123) -> instant 'red-flag' fail. The total is 36 minus however
    // many red-flag questions the sampled 36 contained (v2.1.13 H15).
    const redProv = await registerProvider('01016161616', 'nurse');
    check('red-flag provider registered', redProv.regStatus === 201, JSON.stringify(redProv.reg));
    const red = await answerInterview(redProv.token, 'red-flag');
    check('red-flag answer -> instant red-flag fail', red.submit?.status === 200 && red.submit?.json?.status === 'red-flag' && red.submit?.json?.redFlag === true && (red.submit?.json?.redFlagQuestions || []).length >= 1 && red.submit?.json?.total < 36 && !!red.submit?.json?.canRetakeAt, JSON.stringify(red.submit?.json));
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
    r = await req('POST', `/api/bookings/${bkId}/review`, { token: patientToken2, body: { rating: 5, comment: 'Great, professional nurse.', circumventionReported: false } });
    // v2.1.13 (M33): commission on the SERVICE base only (275), not the
    // total — app 15% of 275 = 41, provider 375 − 41 = 334 (distance
    // fee 100 is pass-through, kept in full by the provider).
    check('review -> released, app 15% of 275 = 41, provider 334', r.status === 200 && r.json?.status === 'released' && r.json?.appShareEgp === 41 && r.json?.providerShareEgp === 334, JSON.stringify(r.json));
    // Wallet ledger reflects it.
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    const entry = r.json?.ledger?.find((l) => l.bookingId === bkId);
    // v2.0.1: released but inside the 24h complaint window -> held, not settleable yet.
    check('wallet ledger: released amount held for complaint window (334)', r.status === 200 && entry?.direction === 'complaint_hold' && entry?.amountEgp === 334 && r.json?.totals?.complaintHoldEgp === 334, JSON.stringify(r.json?.totals));
    check('wallet has next Thursday settlement', !!r.json?.nextSettlementThursday);
    // v2.1.13 (B1): cash-collected is a MANUAL override for cash
    // bookings only — this booking is instapay, so it must refuse.
    r = await req('POST', `/api/bookings/${bkId}/cash-collected`, { token: provToken });
    check('cash-collected on an instapay booking -> 400 (B1 guard)', r.status === 400, JSON.stringify(r.json));

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
    // v2.1.13 (M19): the server terms record must exist before registering.
    await req('POST', '/api/me/terms', { token: newToken, body: { acceptedTerms: true, termsVersion: '1.0' } });
    r = await req('POST', '/api/providers/register', { token: newToken, body: { ...TERMS,
      name: 'New Nurse', role: 'nurse', nationalId: '30304190155551', licenseNo: 'LIC-98765',
      certificates: ['BLS'], extraLanguages: [{ language: 'de', certified: true }],
    } });
    check('provider registered, nationalId/license never returned full', r.status === 201 && r.json?.nationalIdLast4 === '5551' && !JSON.stringify(r.json).includes('30304190155551') && !JSON.stringify(r.json).includes('LIC-98765'), JSON.stringify(r.json));
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
    // Too late: create, accept, wait out the 5s test window, cancel must be refused.
    // v2.1.13 (B4): a PENDING (held) booking cancels at any time — the
    // window applies only once a provider has accepted. So first prove
    // the held booking cancels after the window, then an accepted one.
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkLate = r.json?.id;
    await sleep(6000);
    r = await req('POST', `/api/bookings/${bkLate}/cancel`, { token: patientToken2 });
    check('v2.1.13 (B4): held booking cancels any time, even after the window', r.status === 200 && r.json?.status === 'cancelled' && r.json?.refundEgp === 250, JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkLate2 = r.json?.id;
    await req('POST', `/api/bookings/${bkLate2}/accept`, { token: provToken });
    await sleep(6000);
    r = await req('POST', `/api/bookings/${bkLate2}/cancel`, { token: patientToken2 });
    check('cancel after window (accepted) -> 409 cancel_window_closed', r.status === 409 && r.json?.error === 'cancel_window_closed', JSON.stringify(r.json));
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
    // v2.1.13 (B1/M33): this booking is instapay (cash-collected no
    // longer applies to it), so after rejection the app owes the
    // provider the service-based share 334.
    check('after rejection: app owes provider 334 (instapay, now settleable)', entry3?.direction === 'app_owes_provider' && entry3?.amountEgp === 334, JSON.stringify(entry3));
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
      name: 'No Terms Nurse', role: 'nurse', nationalId: '30304190166661', licenseNo: 'LIC-11111',
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
      const rv = await req('POST', `/api/bookings/${id}/review`, { token: patientTok, body: { rating: 5, comment: 'Good.', circumventionReported: false } });
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
    // v2.1.13 (B1/M33): bkId's complaint was REJECTED at §15, so its
    // instapay provider share (334) is settleable at once and is owed
    // on top of the bonus — appOwes is 334 + 1000, not 1000 alone.
    check('wallet totals carry the 1000 bonus into what app owes provider', r.json?.totals?.volumeBonusEgp === 1000 && r.json?.totals?.appOwesProviderEgp === 1334, JSON.stringify(r.json?.totals));
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
    // v2.1.13 (B1/M33): the bonus is paused (0), but bkId's settleable
    // instapay share (334, complaint rejected at §15) is still owed.
    check('wallet under 0% promo: bonus paused, title kept', r.json?.volumeBonus?.paused === true && r.json?.volumeBonusEgp === 0 && r.json?.volumeBonus?.title === 'الممرض الذهبي' && r.json?.totals?.appOwesProviderEgp === 334, JSON.stringify(r.json?.volumeBonus));
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
    r = await req('POST', `/api/bookings/${bkVou}/review`, { token: vouToken, body: { rating: 5, comment: 'Used my voucher.', circumventionReported: false } });
    // v2.1.13 (M33): commission on the SERVICE base only (250) — gross
    // app 38, voucher 50 funded by the app, so app 0 and provider
    // 350 − 38 = 312 (the provider is paid on the full pre-discount price).
    check('voucher visit released: provider 312 on full price, app 0', r.status === 200 && r.json?.status === 'released' && r.json?.providerShareEgp === 312 && r.json?.appShareEgp === 0, JSON.stringify(r.json));
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
    check('bootstrap has 34 priced services (41 − 7: the 8 physio services unified into one 450 EGP session, v2.1.11)', r.json?.services?.length === 34, `got ${r.json?.services?.length}`);
    const svc = (code) => r.json.services.find((s) => s.code === code);
    check('catheter_insert 400 high-risk', svc('catheter_insert')?.price_egp === 400 && svc('catheter_insert')?.riskLevel === 'high', JSON.stringify(svc('catheter_insert')));
    check('catheter_remove 300 high-risk', svc('catheter_remove')?.price_egp === 300 && svc('catheter_remove')?.riskLevel === 'high');
    check('catheter_flush 300 high-risk', svc('catheter_flush')?.price_egp === 300 && svc('catheter_flush')?.riskLevel === 'high');
    check('ryle_insert 400 high-risk', svc('ryle_insert')?.price_egp === 400 && svc('ryle_insert')?.riskLevel === 'high');
    check('drain_removal 300 high-risk (owner-set)', svc('drain_removal')?.price_egp === 300 && svc('drain_removal')?.riskLevel === 'high');
    check('trach_care 400 high-risk', svc('trach_care')?.price_egp === 400 && svc('trach_care')?.riskLevel === 'high');
    check('iv_infusion 400 high-risk', svc('iv_infusion')?.price_egp === 400 && svc('iv_infusion')?.riskLevel === 'high');
    check('cannula_iv 250 standard nurse-only (v2.1.13: no longer high-risk)', svc('cannula_iv')?.price_egp === 250 && svc('cannula_iv')?.riskLevel === 'standard' && svc('cannula_iv')?.nurseOnly === true);
    check('suture_removal 250 standard + requiresDoctorOrder', svc('suture_removal')?.price_egp === 250 && svc('suture_removal')?.riskLevel === 'standard' && svc('suture_removal')?.requiresDoctorOrder === true);
    check('standard new services priced (v2.1.13 floor 250)', svc('blood_draw')?.price_egp === 250 && svc('injection')?.price_egp === 250 && svc('vitals_check')?.price_egp === 250 && svc('stoma_care')?.price_egp === 300);
    check('cvp_dressing 300 high-risk (owner-set 26 Nov)', svc('cvp_dressing')?.price_egp === 300 && svc('cvp_dressing')?.riskLevel === 'high' && svc('cvp_dressing')?.requiresDoctorOrder === true);
    // v2.1.4 (owner-approved 26 Nov 2026, «سيبها: 500 / 850»): single-day
    // shift prices go BACK to 12h 500 / 24h 850 (they were 700 / 1,200
    // only in v2.1.3). The residence ladder and elderly floors are untouched.
    check('elderly shift mobile 600 / bedridden 700 (owner-set minimums, v2.1.3)', svc('elderly_shift_mobile')?.price_egp === 600 && svc('elderly_shift_mobile')?.riskLevel === 'standard' && svc('elderly_shift_bedridden')?.price_egp === 700 && svc('elderly_shift_bedridden')?.riskLevel === 'standard');
    check('12h shift 500 / 24h shift 850 (v2.1.4 — back from 700 / 1,200)', svc('shift12')?.price_egp === 500 && svc('shift24')?.price_egp === 850);
    check('bootstrap highRiskServices has 10 incl npwt + cvp + iron (cannula_iv removed, v2.1.13)', Array.isArray(r.json?.highRiskServices) && r.json.highRiskServices.length === 10 && r.json.highRiskServices.includes('npwt') && !r.json.highRiskServices.includes('cannula_iv') && r.json.highRiskServices.includes('cvp_dressing') && r.json.highRiskServices.includes('iron_infusion'), JSON.stringify(r.json?.highRiskServices));
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
    // v2.1.13 (M19): the server terms record must exist before registering.
    await req('POST', '/api/me/terms', { token: asstToken, body: { acceptedTerms: true, termsVersion: '1.0' } });
    r = await req('POST', '/api/providers/register', { token: asstToken, body: { ...TERMS,
      name: 'Test Assistant', role: 'assistant', nationalId: '30304190144441', licenseNo: 'LIC-ASST1',
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
    r = await req('POST', `/api/bookings/${bkRem}/review`, { token: patientToken2, body: { rating: 5, comment: 'Reviewed after reminder.', circumventionReported: false } });
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
    r = await bookStd('physio_session');
    check('physio_session booking -> 201, 450 EGP, category physio', r.status === 201 && r.json?.amountEgp === 450 && r.json?.category === 'physio', JSON.stringify(r.json)?.slice(0, 200));
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
    r = await req('POST', `/api/bookings/${bkPhysio}/review`, { token: patientToken2, body: { rating: 5, comment: 'Good.', circumventionReported: false } });
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
    r = await req('POST', `/api/bookings/${bkTourist}/review`, { token: patientToken2, body: { rating: 5, comment: 'Great.', circumventionReported: false } });
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
    // v2.1.13 (H14): approval requires a PASSED interview first.
    const appAInterview = await answerInterview(appA.token, 'all-correct');
    check('application provider A passes interview before approval', appAInterview.submit?.status === 200 && appAInterview.submit?.json?.status === 'passed', JSON.stringify(appAInterview.submit?.json)?.slice(0, 200));
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
    r = await pkgReq({ condition: '', conditionItems: [] });
    check('package request without condition and without items -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    // v2.1.13 (H7): conditionItems alone (no free-text condition) is
    // enough — the server synthesises the condition from the items.
    r = await pkgReq({ condition: '' });
    check('package request with conditionItems but no condition text -> 201 synthesised', r.status === 201 && typeof r.json?.condition === 'string' && r.json.condition.length > 0, JSON.stringify(r.json)?.slice(0, 300));
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
      const rv = await req('POST', `/api/bookings/${id}/review`, { token: offerToken, body: { rating: 5, comment: 'Good shift.', circumventionReported: false } });
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
    check('dashboard has broadcastDevices/broadcastUsers/broadcastAccounts matching dry-run', r.status === 200 && r.json?.broadcastDevices === dryDevices && r.json?.broadcastUsers === dryUsers && typeof r.json?.broadcastAccounts === 'number' && r.json.broadcastAccounts >= 1, JSON.stringify({ broadcastDevices: r.json?.broadcastDevices, broadcastUsers: r.json?.broadcastUsers, broadcastAccounts: r.json?.broadcastAccounts }));
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
    // v2.1.13 (H15): answers are POSITIONS (0-3) into the published
    // options, computed by matching the correct option TEXT.
    const redAnswers = {};
    for (const q of redQ.json?.questions || []) {
      const bankQ = MCQ.find((x) => x.id === q.id);
      const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
      redAnswers[q.id] = q.options.findIndex((o) => o.text === correctText);
    }
    const redEn = {};
    for (const q of redQ.json?.englishCheck?.questions || []) {
      const bankQ = ENGLISH_CHECK.find((x) => x.id === q.id);
      const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
      redEn[q.id] = q.options.findIndex((o) => o.text === correctText);
    }
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
      const rv = await req('POST', `/api/bookings/${id}/review`, { token: patientTok, body: { rating: 5, comment: 'Good.', circumventionReported: false } });
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
      check('§28 update: same code -> no update', ua({ code: 27, apkUrl: 'https://x/app.apk' }) === false);
      check('§28 update: newer code + URL -> update', ua({ code: 28, apkUrl: 'https://x/app.apk' }) === true);
      check('§28 update: newer code but no URL -> no update', ua({ code: 28, apkUrl: '' }) === false);
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
    check('§28 version header is v2.1.13 code 27', webJs.includes('v2.1.13, code 27'), 'header not bumped');
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
    const clStart = webJs.indexOf('async function completeLogin');
    const clEnd = webJs.indexOf('\n}\n', clStart);
    const clBody = clStart !== -1 && clEnd !== -1 ? webJs.slice(clStart, clEnd) : '';
    // v2.1.10: registerPushToken is back — but ONLY as the register half
    // of the explicit-tap flow (called from requestPushPermission) and of
    // the notifications-screen Settings fallback (syncPushRegistration,
    // only when the permission is already granted). It must NEVER run
    // from the login path: that was the 2.1.7 login kill.
    check('§29 no automatic push registration on the login path (registerPushToken only via tap/sync)', noComments.includes('async function registerPushToken(push, opts)') && !clBody.includes('registerPushToken'), 'registerPushToken on the login path');
    check('§29 completeLogin shows only the DOM explain card, no native push', clBody.includes('maybeShowPushExplainCard();') && !clBody.includes('getPushPlugin') && !clBody.includes('PushNotifications') && !clBody.includes('registerPushToken'), 'completeLogin still touches push');
    check('§29 getPushPlugin is called only from requestPushPermission + syncPushRegistration', (webJs.match(/getPushPlugin\(\)/g) || []).length === 3, `getPushPlugin() occurrences: ${(webJs.match(/getPushPlugin\(\)/g) || []).length}`);
    check('§29 no silent permission check on the login path (checkPermissions only via tap/sync)', !clBody.includes('checkPermissions'), 'checkPermissions on the login path');
    check('§29 native push.register() lives only in registerPushToken (tap/sync call it)', (webJs.match(/push\.register\(\)/g) || []).length === 1 && webJs.includes('async function registerPushToken(push, opts)'), 'push.register() outside registerPushToken');
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
    check('§29 version header is v2.1.13 code 27', webJs.includes('v2.1.13, code 27'), 'header not bumped');
    check('§29 APP_VERSION_CODE is 27 / NAME is 2.1.13', webJs.includes('const APP_VERSION_CODE = 27;') && webJs.includes('const APP_VERSION_NAME = "2.1.13";'), 'version constants not bumped');
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
    r = await req('POST', '/api/providers/register', { xff, token: dualPatientToken, body: { ...TERMS, name: 'Dual Role Nurse', providerType: 'nurse', role: 'nurse', nationalId: '30304190100051', licenseNo: 'LIC-DUAL1', certificates: [] } });
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
    const fileIds = ['bkReceipt', 'tuReceipt', 'npReceipt', 'poReceipt', 'prCerts', 'docFile'];
    // trackReceipt is dynamic (trackReceipt_<bookingId>, one input per
    // booking in the list) — match the prefix, not a literal id.
    check('§30 all 9 file inputs are the known receipt/certificate uploads', fileIds.every((id) => webJs.includes(`id="${id}"`)) && webJs.includes('trackReceipt_') && (webJs.match(/type="file"/g) || []).length === 9, `file inputs: ${(webJs.match(/type="file"/g) || []).length}`);
    // 30d. Safe-area topbar + sheet styles in CSS.
    check('§30 CSS: topbar respects the Android safe area', css.includes('env(safe-area-inset-top'), 'no safe-area rule');
    check('§30 CSS: option-sheet field + list styles exist', css.includes('.app-select') && css.includes('.opt-item') && css.includes('.opt-search'), 'sheet styles missing');
    check('§30 CSS: large complaint rows exist', css.includes('.opt-list.opt-large .opt-item'), 'large-row styles missing');
    // 30e. Version header.
    check('§30 version header is v2.1.13 code 27', webJs.includes('v2.1.13, code 27') && webJs.includes('const APP_VERSION_CODE = 27;') && webJs.includes('const APP_VERSION_NAME = "2.1.13";'), 'header not bumped');
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

  // --- §31. v2.1.10: push crash fix (main-thread permission request) + broadcast counts ---
  console.log('\n[§31 v2.1.10]');
  {
    const webJs = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    // 31a. Native patch: the stock PushNotifications plugin is patched
    // in node_modules (see build/BUILD-STATUS.md §v2.1.10) — the permission
    // request runs on the main thread and both native entry points guard
    // against uncaught throwables. If a future npm reinstall wipes the
    // patch, these checks fail the suite instead of shipping it silently.
    const pluginPath = path.join(__dirname, '..', '..', 'android', 'node_modules', '@capacitor', 'push-notifications', 'android', 'src', 'main', 'java', 'com', 'capacitorjs', 'plugins', 'pushnotifications', 'PushNotificationsPlugin.java');
    const pluginJava = fs.readFileSync(pluginPath, 'utf8');
    check('§31 plugin requestPermissions runs on the main thread', pluginJava.includes('executeOnMainThread') && pluginJava.includes('requestPermissionForAlias(PUSH_NOTIFICATIONS, call, "permissionsCallback")'), 'main-thread patch missing');
    check('§31 plugin requestPermissions guards uncaught throwables', pluginJava.includes('ShifaCare main-thread permission request failed'), 'requestPermissions guard marker missing');
    check('§31 plugin register guards uncaught throwables', pluginJava.includes('ShifaCare push registration failed'), 'register guard marker missing');
    check('§31 plugin register null-safe on token error', pluginJava.includes('ex != null ? ex.getLocalizedMessage() : "token fetch failed"'), 'null-safe sendError missing');
    // 31b. JS: checkPermissions FIRST (pure read, no dialog) — the native
    // dialog runs only when the status is "prompt"; granted goes straight
    // to register(); denied shows the Settings hint.
    const reqFn = webJs.slice(webJs.indexOf('async function requestPushPermission()'), webJs.indexOf('async function registerPushToken'));
    check('§31 requestPushPermission checks permission before asking', reqFn.includes('push.checkPermissions()') && reqFn.indexOf('push.checkPermissions()') < reqFn.indexOf('push.requestPermissions()'), 'check-first order wrong');
    check('§31 requestPushPermission skips the dialog when already granted', reqFn.includes('perm.receive === "granted"') && reqFn.includes('await registerPushToken(push)'), 'granted fast-path missing');
    check('§31 requestPushPermission shows Settings hint when denied', reqFn.includes('perm.receive === "denied"') && reqFn.includes('showPushDeniedHint()'), 'denied hint missing');
    check('§31 requestPushPermission returns early when already registered', reqFn.includes('pushRegistered()'), 'already-registered early return missing');
    check('§31 registerPushToken + syncPushRegistration exist', webJs.includes('async function registerPushToken(push, opts)') && webJs.includes('async function syncPushRegistration()'), 'push helpers missing');
    check('§31 syncPushRegistration runs from the notifications screen only', webJs.slice(webJs.indexOf('async function loadNotifications()'), webJs.indexOf('\n}\n', webJs.indexOf('async function loadNotifications()'))).includes('syncPushRegistration();'), 'sync not wired to loadNotifications');
    check('§31 syncPushRegistration never runs from login', !webJs.slice(webJs.indexOf('async function completeLogin'), webJs.indexOf('async function completeLogin') + 2500).includes('syncPushRegistration') && !webJs.slice(webJs.indexOf('async function afterPasswordSet'), webJs.indexOf('async function afterPasswordSet') + 800).includes('syncPushRegistration'), 'sync leaked into the login path');
    // v2.1.12: the one-liner became a try/catch with a visible failure
    // path — the mark + toast still happen only after the POST succeeds,
    // in that order, inside the registration listener.
    const regListener31 = webJs.slice(webJs.indexOf('push.addListener("registration"'), webJs.indexOf('push.addListener("registrationError"'));
    check('§31 registration listener marks + confirms only on server success', regListener31.indexOf('await api("/api/me/devices"') !== -1 && regListener31.indexOf('markPushRegistered();') > regListener31.indexOf('await api("/api/me/devices"') && regListener31.indexOf('toast(t("pushEnabled"));') > regListener31.indexOf('markPushRegistered();'), 'registration confirm missing');
    check('§31 pushRegistered flag key exists', webJs.includes('shifa_push_registered') && webJs.includes('function pushRegistered()') && webJs.includes('function markPushRegistered()'), 'push flag missing');
    check('§31 pushEnabled i18n exists in both languages', webJs.includes('pushEnabled: "تم تفعيل إشعارات الهاتف."') && webJs.includes('pushEnabled: "Phone notifications enabled."'), 'pushEnabled i18n missing');
    // 31c. Broadcast tab: accounts + devices + true audience, labelled.
    check('§31 broadcast tab shows accounts/devices/audience', webJs.includes('broadcastAccounts') && webJs.includes('broadcastAudience') && webJs.includes('d.broadcastAccounts'), 'broadcast tab labels missing');
    check('§31 broadcast i18n exists in both languages', webJs.includes('broadcastAccounts: "حسابات مسجلة"') && webJs.includes('broadcastAccounts: "Registered accounts"') && webJs.includes('broadcastAudience: "جمهور البث"') && webJs.includes('broadcastAudience: "Broadcast audience"'), 'broadcast i18n missing');
    // 31d. Version bump.
    check('§31 app.js header + APP_VERSION_NAME are 2.1.13 / code 27', webJs.includes('v2.1.13, code 27') && webJs.includes('const APP_VERSION_NAME = "2.1.13"'), 'version not bumped');
    // 31e. Dashboard counts: the true audience equals the dry-run users
    // count, and it always includes the registered accounts (the v2.1.9
    // 0/0 bug: broadcastUsers counted only phones with an FCM device, so
    // the tab showed 0 even when accounts existed).
    const dry31 = await req('POST', '/api/admin/broadcast', { token: adminToken, body: { title: 'x', body: 'y', dryRun: true } });
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('§31 dashboard broadcastUsers equals the true audience (dry-run users)', r.status === 200 && dry31.json?.users >= 1 && r.json?.broadcastUsers === dry31.json?.users && r.json?.broadcastDevices === dry31.json?.devices, JSON.stringify({ broadcastUsers: r.json?.broadcastUsers, broadcastAccounts: r.json?.broadcastAccounts, broadcastDevices: r.json?.broadcastDevices, dryUsers: dry31.json?.users }));
    check('§31 dashboard audience always includes the registered accounts', r.status === 200 && typeof r.json?.broadcastAccounts === 'number' && r.json.broadcastAccounts >= 2 && r.json.broadcastUsers >= r.json.broadcastAccounts, JSON.stringify({ broadcastUsers: r.json?.broadcastUsers, broadcastAccounts: r.json?.broadcastAccounts }));
    // 31f. Password show/hide (eye) toggle (owner request, v2.1.10):
    // every password field in the app has an in-app eye button that flips
    // the input type between password and text ONLY — no login/register
    // logic touched, nothing stored, nothing logged.
    const css31 = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'style.css'), 'utf8');
    const pwIds = ['loginPassword', 'loginPasswordConfirm', 'setPassword', 'setPasswordConfirm', 'adminPinInput'];
    check('§31 every password field is wrapped with an eye button (6 fields)', (webJs.match(/type="password"/g) || []).length === 6 && (webJs.match(/class="pw-wrap/g) || []).length === 6, `password inputs: ${(webJs.match(/type="password"/g) || []).length}, wraps: ${(webJs.match(/class="pw-wrap/g) || []).length}`);
    check('§31 pwEye is wired for every password field id', pwIds.every((id) => webJs.includes(`pwEye("${id}")`)), 'a password field has no eye button');
    check('§31 togglePw + pwEye helpers exist', webJs.includes('window.togglePw = function (inputId, btn)') && webJs.includes('function pwEye(id)'), 'eye helpers missing');
    check('§31 togglePw only flips the type, never stores or logs the password', webJs.slice(webJs.indexOf('window.togglePw'), webJs.indexOf('function pwEye')).includes('el.type = show ? "text" : "password"') && !/localStorage|sessionStorage|console\.log|api\(/.test(webJs.slice(webJs.indexOf('window.togglePw'), webJs.indexOf('function pwEye'))), 'togglePw touches storage/logs');
    check('§31 eye button is type=button with an aria-label (never submits)', webJs.includes('type="button" class="pw-eye"') && webJs.includes('aria-label="${t("pwShow")}"'), 'eye button markup wrong');
    check('§31 pwShow/pwHide i18n exists in both languages', webJs.includes('pwShow: "إظهار كلمة المرور"') && webJs.includes('pwHide: "إخفاء كلمة المرور"') && webJs.includes('pwShow: "Show password"') && webJs.includes('pwHide: "Hide password"'), 'eye i18n missing');
    check('§31 CSS: .pw-wrap + .pw-eye styles exist', css31.includes('.pw-wrap') && css31.includes('.pw-eye') && css31.includes('padding-inline-end: 44px'), 'eye styles missing');
    // Functional: run the extracted toggle block in a vm with a fake
    // input + button and flip it both ways.
    const vm31 = require('vm');
    const BEGIN31 = '/* v2.1.10 — password show/hide (eye) toggle (BEGIN';
    const END31 = '/* v2.1.10 — password show/hide (eye) toggle (END) */';
    const bi31 = webJs.indexOf(BEGIN31);
    const ei31 = webJs.indexOf(END31, bi31);
    check('§31 eye-toggle block is extractable from web/app.js', bi31 !== -1 && ei31 !== -1 && ei31 > bi31, `${bi31}/${ei31}`);
    if (bi31 !== -1 && ei31 !== -1) {
      const eyeBlock31 = webJs.slice(bi31, ei31);
      check('§31 eye toggle is pure inline SVG — no emoji anywhere in the toggle', eyeBlock31.includes('PW_EYE_SVG') && eyeBlock31.includes('data-icon="eye"') && eyeBlock31.includes('data-icon="eye-off"') && !eyeBlock31.includes('👁') && !eyeBlock31.includes('🙈'), 'emoji still in eye toggle');
      const fakeInput = { type: 'password' };
      const fakeBtn = { innerHTML: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      const ctx31 = { document: { getElementById: (id) => (id === 'pw1' ? fakeInput : null) }, fakeBtn, console };
      ctx31.window = ctx31;
      vm31.createContext(ctx31);
      vm31.runInContext('function t(k){ return k; }', ctx31);
      vm31.runInContext(webJs.slice(bi31, ei31), ctx31);
      vm31.runInContext('togglePw("pw1", fakeBtn);', ctx31);
      check('§31 togglePw flips password -> text and swaps to the eye-off SVG (accent state on)', fakeInput.type === 'text' && fakeBtn.innerHTML.includes('data-icon="eye-off"') && fakeBtn.attrs['data-visible'] === '1' && fakeBtn.attrs['aria-label'] === 'pwHide', `${fakeInput.type}/${String(fakeBtn.innerHTML).slice(0, 60)}`);
      vm31.runInContext('togglePw("pw1", fakeBtn);', ctx31);
      check('§31 togglePw flips text -> password and swaps back to the eye SVG (accent state off)', fakeInput.type === 'password' && fakeBtn.innerHTML.includes('data-icon="eye"') && !fakeBtn.innerHTML.includes('eye-off') && fakeBtn.attrs['data-visible'] === '0' && fakeBtn.attrs['aria-label'] === 'pwShow', `${fakeInput.type}/${String(fakeBtn.innerHTML).slice(0, 60)}`);
      const eyeHtml = vm31.runInContext('pwEye("loginPassword");', ctx31);
      check('§31 pwEye renders an SVG eye button wired to its field', typeof eyeHtml === 'string' && eyeHtml.includes('class="pw-eye"') && eyeHtml.includes("togglePw('loginPassword'") && eyeHtml.includes('<svg') && eyeHtml.includes('data-icon="eye"') && !eyeHtml.includes('👁') && !eyeHtml.includes('🙈'), String(eyeHtml).slice(0, 120));
      vm31.runInContext('togglePw("missing-id", fakeBtn);', ctx31);
      check('§31 togglePw with an unknown id does nothing (no throw)', fakeInput.type === 'password', fakeInput.type);
    }
    check('§31 CSS: .pw-eye is a 40px touch target, muted by default, accent when visible', css31.includes('min-width: 40px') && css31.includes('min-height: 40px') && css31.includes('.pw-eye svg') && css31.includes('.pw-eye[data-visible="1"]'), 'eye touch-target/accent styles missing');
  }

  // --- §32. v2.1.10 (follow-up): login persists — password sessions get
  // a 30-day refresh; legacy phone-only sessions stay at 24h; the admin
  // session is 12h. (Owner report 26 Nov 2026 ~23:32: every app exit
  // forced a fresh login, because the 15-min access token died and the
  // 24h refresh record died with the next deploy's data.json wipe.)
  console.log('\n[§32 v2.1.10]');
  {
    const jwtPayload = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
    const refreshRec = (tok) => {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return (d.refreshTokens || {})[String(tok).split('.')[0]] || null;
    };
    const daysOut = (rec) => rec ? (new Date(rec.expiresAt).getTime() - Date.now()) / 86400000 : -1;
    const routesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes.js'), 'utf8');
    // 32a. Register with a password -> 201; the refresh record lives ~30 days.
    const xff32 = '10.32.1.1';
    r = await req('POST', '/api/auth/register', { xff: xff32, body: { phone: '01029200001', password: 'persist1', terms: TERMS } });
    check('§32 register with a password -> 201 + refresh token', r.status === 201 && !!r.json?.refreshToken && r.json?.authMethod === 'password', JSON.stringify(r.json));
    const regRec = refreshRec(r.json?.refreshToken);
    check('§32 register refresh record expires ~30 days out (not 24h)', !!regRec && regRec.authMethod === 'password' && daysOut(regRec) > 29 && daysOut(regRec) < 31, `daysOut=${daysOut(regRec).toFixed(2)}`);
    // 32b. Password login -> 200; refresh ~30 days; access token still 15 min.
    r = await req('POST', '/api/auth/login-phone', { xff: xff32, body: { phone: '01029200001', password: 'persist1' } });
    check('§32 password login -> 200 + authMethod password', r.status === 200 && r.json?.authMethod === 'password', JSON.stringify(r.json));
    const loginRec = refreshRec(r.json?.refreshToken);
    check('§32 password-login refresh record expires ~30 days out', !!loginRec && daysOut(loginRec) > 29 && daysOut(loginRec) < 31, `daysOut=${daysOut(loginRec).toFixed(2)}`);
    const accessPayload = jwtPayload(r.json?.token);
    check('§32 access token still lives 15 minutes (exp - iat = 900s)', (accessPayload.exp - accessPayload.iat) === 900, `exp-iat=${accessPayload.exp - accessPayload.iat}`);
    // 32c. Refresh flow: the refresh token works after the (short) access
    // token lifetime, rotation keeps the 30-day TTL, and the old token
    // is revoked (rotation + reuse detection untouched).
    const oldRefresh = r.json?.refreshToken;
    r = await req('POST', '/api/auth/refresh', { body: { refreshToken: oldRefresh } });
    check('§32 refresh with the password refresh token -> 200 + new tokens', r.status === 200 && !!r.json?.accessToken && !!r.json?.refreshToken, JSON.stringify(r.json));
    const rotatedRec = refreshRec(r.json?.refreshToken);
    check('§32 rotated refresh record still expires ~30 days out', !!rotatedRec && daysOut(rotatedRec) > 29 && daysOut(rotatedRec) < 31, `daysOut=${daysOut(rotatedRec).toFixed(2)}`);
    const oldRec = refreshRec(oldRefresh);
    check('§32 the pre-rotation refresh record is revoked', !!oldRec && oldRec.revoked === true, JSON.stringify(oldRec)?.slice(0, 120));
    // 32d. Legacy phone-only session (no password set yet) stays at 24h.
    r = await req('POST', '/api/auth/login-phone', { xff: '10.32.2.1', body: { phone: '01029200002' } });
    check('§32 legacy phone-only login -> 200 + requiresPassword', r.status === 200 && r.json?.requiresPassword === true && r.json?.authMethod === 'phone-only', JSON.stringify(r.json));
    const legacyRec = refreshRec(r.json?.refreshToken);
    check('§32 legacy phone-only refresh record expires ~24h out', !!legacyRec && legacyRec.authMethod === 'phone-only' && daysOut(legacyRec) > 0.9 && daysOut(legacyRec) < 1.1, `daysOut=${daysOut(legacyRec).toFixed(2)}`);
    // 32e. Admin session: 12h (was 30m — unusable for an owner who lives
    // in the admin panel). Decoded from the live admin token; the config
    // value is checked statically too.
    const adminPayload = jwtPayload(adminToken);
    check('§32 admin token lives ~12h (exp - iat = 43200s)', (adminPayload.exp - adminPayload.iat) === 43200, `exp-iat=${adminPayload.exp - adminPayload.iat}`);
    check('§32 config.adminSessionTtl is 12h', require('../src/config').adminSessionTtl === '12h', String(require('../src/config').adminSessionTtl));
    // 32f. Static: the password paths carry 30 days in the source.
    check('§32 login-phone gives password sessions 30 days', routesSrc.includes("refreshTtlDays: authMethod === 'password' ? 30 : 1"), 'login-phone TTL wrong');
    check('§32 register gives password sessions 30 days', routesSrc.includes("refreshTtlDays: 30, authMethod: 'password'"), 'register TTL wrong');
    check('§32 authMethodForPhone gives password sessions 30 days', routesSrc.includes("if (latest.authMethod === 'password') return { refreshTtlDays: 30, authMethod: 'password' };"), 'authMethodForPhone TTL wrong');
    check('§32 rotation keeps 30 days for password families', routesSrc.includes("rec.authMethod === 'password' ? { refreshTtlDays: 30, authMethod: rec.authMethod }"), 'rotation TTL wrong');
  }

  // --- §33. v2.1.11: ONE physiotherapy session (owner decision 27 Nov
  // 2026) — all physio sessions are a single service «جلسة علاج طبيعي»,
  // flat 450 EGP, with an includes note under the name. The 8 separate
  // physio_* services (350/400 EGP) are gone; old codes are invalid.
  console.log('\n[§33 v2.1.11]');
  {
    // 33a. Bootstrap: exactly one physio service, 450 EGP, includes note.
    r = await req('GET', '/api/bootstrap');
    const physioSvcs = (r.json?.services || []).filter((s) => s.category === 'physio');
    check('§33 bootstrap has exactly ONE physio service', physioSvcs.length === 1, `got ${physioSvcs.length}: ${JSON.stringify(physioSvcs.map((s) => s.code))}`);
    const ps = physioSvcs[0] || {};
    check('§33 physio_session is 450 EGP, standard risk, Arabic name', ps.code === 'physio_session' && ps.price_egp === 450 && ps.price === 450 && ps.riskLevel === 'standard' && ps.name_ar === 'جلسة علاج طبيعي', JSON.stringify(ps));
    check('§33 includes_ar names all 8 areas', typeof ps.includes_ar === 'string' && ps.includes_ar.includes('تأهيل حركي عام') && ps.includes_ar.includes('تأهيل ما بعد الجلطة') && ps.includes_ar.includes('تمارين ما بعد الكسور والعمليات') && ps.includes_ar.includes('علاج طبيعي للصدر') && ps.includes_ar.includes('تمارين توازن ومشي') && ps.includes_ar.includes('تدليك علاجي') && ps.includes_ar.includes('تمارين شد وإطالة') && ps.includes_ar.includes('تأهيل كبار السن'), String(ps.includes_ar)?.slice(0, 200));
    check('§33 includes_en present (post-stroke, therapeutic massage)', typeof ps.includes_en === 'string' && ps.includes_en.includes('post-stroke') && ps.includes_en.includes('therapeutic massage') && ps.includes_en.includes('elderly rehabilitation'), String(ps.includes_en)?.slice(0, 200));
    // 33b. Old physio codes are no longer valid serviceCodes.
    for (const old of ['physio_general', 'physio_stroke', 'physio_postfracture', 'physio_chest', 'physio_balance', 'physio_massage', 'physio_stretching', 'physio_elderly']) {
      r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS, patientName: 'Coverage Patient', serviceCode: old, paymentMethod: 'cash_receipt', distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] } } });
      check(`§33 old code ${old} booking -> 400 (invalid serviceCode)`, r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    }
    // 33c. Static: the shipped web app carries the single session and
    // renders its includes note under the name everywhere it is listed.
    const webJs33 = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    const noComments33 = webJs33.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const oldCodes = ['physio_general', 'physio_stroke', 'physio_postfracture', 'physio_chest', 'physio_balance', 'physio_massage', 'physio_stretching', 'physio_elderly'];
    check('§33 no old physio_* codes remain in web/app.js', !oldCodes.some((c) => noComments33.includes(c)), oldCodes.filter((c) => noComments33.includes(c)).join(', '));
    check('§33 FALLBACK has physio_session at 450 with includes fields', webJs33.includes('id: "physio_session"') && webJs33.includes('price: 450, category: "physio"') && webJs33.includes('includes_ar: "تشمل الجلسة:'), 'FALLBACK physio entry wrong');
    check('§33 i18n has svc_physio_session in both languages', webJs33.includes('svc_physio_session: "جلسة علاج طبيعي"') && webJs33.includes('svc_physio_session: "Physiotherapy session"'), 'name key missing');
    check('§33 serviceIncludes helper reads bootstrap/FALLBACK fields', webJs33.includes('function serviceIncludes(id)') && webJs33.includes('s.includes_ar') && webJs33.includes('s.includes_en'), 'helper missing');
    check('§33 service cards render the includes note under the name', webJs33.includes('${serviceIncludes(s.id) ? `<div class="note">${esc(serviceIncludes(s.id))}</div>` : ""}'), 'card note missing');
    check('§33 booking form shows the note under the service picker', webJs33.includes('id="bkServiceIncludes"') && webJs33.includes('updateServiceIncludesNote()'), 'booking note missing');
    check('§33 radar rows render the includes note', webJs33.includes('${serviceIncludes(b.serviceCode || b.service || "") ? `<div class="note">${esc(serviceIncludes(b.serviceCode || b.service || ""))}</div>` : ""}'), 'radar note missing');
    // 33d. Static: the catalog + evaluation map the physio area to the
    // single session, and no old code survives server-side either.
    const catSrc33 = fs.readFileSync(path.join(__dirname, '..', 'src', 'catalog.js'), 'utf8');
    const evalSrc33 = fs.readFileSync(path.join(__dirname, '..', 'src', 'evaluate.js'), 'utf8');
    check('§33 catalog has physio_session at 450, no old codes', catSrc33.includes("physio_session: { code: 'physio_session'") && catSrc33.includes('price_egp: 450') && !oldCodes.some((c) => catSrc33.replace(/\/\/.*$/gm, '').includes(c)), 'catalog wrong');
    check('§33 evaluate.js physio area maps to physio_session', evalSrc33.includes("serviceCodes: ['physio_session']"), 'evaluate mapping wrong');
  }

  // --- §34. v2.1.12: no native text-selection toolbar (owner report 27 Nov
  // 2026) — double-tapping the broadcast message to select it exits the
  // app: the WebView's floating text-selection ActionMode kills the
  // process on the owner's Android 16 phones (same class as prompt(),
  // <select>, FCM). Verified in desktop Chromium before building: neither
  // user-select:none nor selectstart prevention stops a textarea's
  // double-tap word selection — so the web guards shrink the trigger
  // surface (no selection on plain text, no context menu, double-tap
  // selections collapse at once) and the REAL fix is the MainActivity
  // guard that aborts floating action modes before their toolbar window
  // is created. The broadcast form gets an in-app clear button instead
  // of select-and-delete.
  console.log('\n[§34 v2.1.12]');
  {
    // 34a. Static: CSS never lets a selection start.
    const css34 = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'style.css'), 'utf8');
    check('§34 CSS: body + descendants are user-select none', css34.includes('body, body * { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }'), 'body rule missing');
    check('§34 CSS: input/textarea explicitly user-select none', /input,\s*textarea\s*\{[^}]*user-select:\s*none/.test(css34), 'input/textarea rule missing');
    check('§34 CSS: -webkit-touch-callout none present', css34.includes('-webkit-touch-callout: none'), 'touch-callout missing');
    // 34b. Static: the web guards exist and are wired at boot.
    const webJs34 = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    check('§34 collapseFieldSelection + initSelectionGuards exist', webJs34.includes('function collapseFieldSelection(el)') && webJs34.includes('function initSelectionGuards()'), 'guard helpers missing');
    check('§34 guards run at boot', webJs34.includes('initSelectionGuards();'), 'guards not wired at boot');
    check('§34 contextmenu is preventDefaulted', webJs34.includes('document.addEventListener("contextmenu", (e) => { e.preventDefault(); })'), 'contextmenu not suppressed');
    check('§34 dblclick collapses field selections', webJs34.includes('document.addEventListener("dblclick"') && webJs34.includes('collapseFieldSelection(t)'), 'dblclick collapse missing');
    check('§34 broadcast form has an in-app clear button', webJs34.includes('onclick="clearBroadcastForm()"') && webJs34.includes('t("broadcastClear")'), 'clear button missing');
    check('§34 broadcastClear i18n exists in both languages', webJs34.includes('broadcastClear: "مسح الرسالة"') && webJs34.includes('broadcastClear: "Clear message"'), 'clear i18n missing');
    check('§34 broadcast title/body text and flow unchanged', webJs34.includes('id="bcTitle"') && webJs34.includes('id="bcBody"') && webJs34.includes('window.sendBroadcast = async function (dryRun)'), 'broadcast form/flow changed');
    check('§34 version header is v2.1.13 code 27', webJs34.includes('v2.1.13, code 27') && webJs34.includes('const APP_VERSION_CODE = 27;') && webJs34.includes('const APP_VERSION_NAME = "2.1.13";'), 'version not bumped');
    // 34c. Static: the native guard exists in MainActivity.
    const main34 = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'android', 'app', 'src', 'main', 'java', 'com', 'shifacare', 'elquseir', 'MainActivity.java'), 'utf8');
    check('§34 MainActivity aborts floating action modes at creation', main34.includes('public ActionMode onWindowStartingActionMode(ActionMode.Callback callback, int type)') && main34.includes('if (type == ActionMode.TYPE_FLOATING)') && main34.includes('return null;'), 'onWindowStartingActionMode guard missing');
    check('§34 MainActivity finishes any floating mode that starts', main34.includes('public void onActionModeStarted(ActionMode mode)') && main34.includes('mode.finish()'), 'onActionModeStarted guard missing');
    check('§34 native guard log markers exist (build §9 asserts them in the dex)', main34.includes('ShifaCare floating action mode suppressed') && main34.includes('ShifaCare floating action mode finished'), 'guard markers missing');
    check('§34 native guard never rethrows (guarded try/catch)', main34.includes('Floating action-mode guard failed') && main34.includes('Could not finish floating action mode'), 'guard try/catch missing');
    // 34d. Functional: run the extracted guard block in a vm with fake
    // DOM stubs — collapse a word selection, suppress a context menu,
    // and clear the broadcast draft.
    const vm34 = require('vm');
    const BEGIN34 = '/* v2.1.12 — selection guards (BEGIN) */';
    const END34 = '/* v2.1.12 — selection guards (END) */';
    const bi34 = webJs34.indexOf(BEGIN34);
    const ei34 = webJs34.indexOf(END34, bi34);
    check('§34 selection-guard block is extractable from web/app.js', bi34 !== -1 && ei34 !== -1 && ei34 > bi34, `${bi34}/${ei34}`);
    if (bi34 !== -1 && ei34 !== -1) {
      const handlers = {};
      const ctx34 = {
        document: { addEventListener: (type, fn) => { handlers[type] = fn; } },
        console,
      };
      ctx34.window = ctx34;
      vm34.createContext(ctx34);
      vm34.runInContext(webJs34.slice(bi34, ei34), ctx34);
      vm34.runInContext('initSelectionGuards();', ctx34);
      check('§34 initSelectionGuards registers contextmenu + dblclick listeners', typeof handlers.contextmenu === 'function' && typeof handlers.dblclick === 'function', Object.keys(handlers).join(','));
      // A double-tapped word selection (start 17, end 22) collapses to the caret.
      const calls = [];
      const fakeField = { tagName: 'TEXTAREA', selectionStart: 17, selectionEnd: 22, setSelectionRange(a, b) { calls.push([a, b]); this.selectionStart = a; this.selectionEnd = b; } };
      vm34.runInContext('__field = undefined;', ctx34);
      ctx34.__field = fakeField;
      vm34.runInContext('collapseFieldSelection(__field);', ctx34);
      check('§34 collapseFieldSelection collapses a word selection to the caret', fakeField.selectionStart === 17 && fakeField.selectionEnd === 17 && calls.length === 1 && calls[0][0] === 17 && calls[0][1] === 17, JSON.stringify(calls));
      // The dblclick listener collapses selections only inside fields:
      // a div target must not throw and must not touch any selection.
      const fakeDiv = { tagName: 'DIV', setSelectionRange() { throw new Error('must not be called on a div'); } };
      ctx34.__div = fakeDiv;
      ctx34.__dbl = handlers.dblclick;
      let dblErr = null;
      try { vm34.runInContext('__dbl({target: __div});', ctx34); } catch (e) { dblErr = e; }
      check('§34 dblclick listener ignores non-field targets (no throw)', dblErr === null, String(dblErr));
      // And the same listener collapses a real field selection.
      ctx34.__field2 = fakeField;
      vm34.runInContext('__dbl({target: __field2});', ctx34);
      check('§34 dblclick listener collapses a field selection via the event', fakeField.selectionStart === 17 && fakeField.selectionEnd === 17, `${fakeField.selectionStart}/${fakeField.selectionEnd}`);
      // Contextmenu is preventDefaulted.
      let prevented = false;
      const fakeEv = { preventDefault() { prevented = true; } };
      ctx34.__ev = fakeEv;
      // Invoke the registered contextmenu handler directly via the ctx.
      ctx34.__handler = handlers.contextmenu;
      vm34.runInContext('__handler(__ev);', ctx34);
      check('§34 contextmenu handler preventDefaults the event', prevented === true, String(prevented));
      // collapseFieldSelection tolerates a field without a selection API.
      ctx34.__bad = { tagName: 'TEXTAREA' };
      let badErr = null;
      try { vm34.runInContext('collapseFieldSelection(__bad);', ctx34); } catch (e) { badErr = e; }
      check('§34 collapseFieldSelection tolerates a field with no selection API', badErr === null, String(badErr));
    }
    // 34e. Functional: clearBroadcastForm clears title + body and refocuses body.
    const BEGIN34B = '/* v2.1.12 — broadcast clear (BEGIN) */';
    const END34B = '/* v2.1.12 — broadcast clear (END) */';
    const bi34b = webJs34.indexOf(BEGIN34B);
    const ei34b = webJs34.indexOf(END34B, bi34b);
    check('§34 broadcast-clear block is extractable from web/app.js', bi34b !== -1 && ei34b !== -1 && ei34b > bi34b, `${bi34b}/${ei34b}`);
    if (bi34b !== -1 && ei34b !== -1) {
      const fakeTitle = { value: 'شكرًا يا شهد' };
      const fakeBody = { value: 'أنتِ أول واحدة تجرّب التطبيق', focused: false, focus() { this.focused = true; } };
      const ctx34b = {
        document: { getElementById: (id) => (id === 'bcTitle' ? fakeTitle : id === 'bcBody' ? fakeBody : null) },
        console,
      };
      ctx34b.window = ctx34b;
      vm34.createContext(ctx34b);
      vm34.runInContext(webJs34.slice(bi34b, ei34b), ctx34b);
      vm34.runInContext('clearBroadcastForm();', ctx34b);
      check('§34 clearBroadcastForm empties title + body and focuses the body', fakeTitle.value === '' && fakeBody.value === '' && fakeBody.focused === true, `${fakeTitle.value}/${fakeBody.value}/${fakeBody.focused}`);
      // Missing fields: no throw.
      const ctx34c = { document: { getElementById: () => null }, console };
      ctx34c.window = ctx34c;
      vm34.createContext(ctx34c);
      vm34.runInContext(webJs34.slice(bi34b, ei34b), ctx34c);
      let clearErr = null;
      try { vm34.runInContext('clearBroadcastForm();', ctx34c); } catch (e) { clearErr = e; }
      check('§34 clearBroadcastForm with missing fields does not throw', clearErr === null, String(clearErr));
    }
  }

  // --- §35. v2.1.12: push registration hardening -----------------------
  // Owner report 27 Nov 2026: the admin broadcast tab showed 0 devices
  // while the server logs showed no push failure at all — there was
  // simply no token to send to, and the app never said so. The fix:
  // listeners attach BEFORE register() (documented Capacitor pattern),
  // a registration that never completes shows a visible error within
  // 10s instead of silence, and the notifications screen shows whether
  // THIS device is registered (server count, not the local flag alone —
  // the flag can outlive a deploy wipe).
  console.log('\n[§35 v2.1.12]');
  {
    const webJs35 = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    // 35a. GET /api/me/devices: the honest per-user device count.
    const xff35 = '10.35.1.1';
    const reg35 = await req('POST', '/api/auth/register', { xff: xff35, body: { phone: '01029300001', password: 'pushreg1', terms: TERMS } });
    const tok35 = reg35.json?.token;
    check('§35 register for the push-device checks', reg35.status === 201 && !!tok35, JSON.stringify(reg35.json)?.slice(0, 120));
    if (tok35) {
      const noAuth35 = await req('GET', '/api/me/devices');
      check('§35 GET /api/me/devices without a token is 401', noAuth35.status === 401, String(noAuth35.status));
      const d0 = await req('GET', '/api/me/devices', { token: tok35 });
      check('§35 GET /api/me/devices starts at 0 devices', d0.status === 200 && d0.json?.devices === 0, JSON.stringify(d0.json));
      const short35 = await req('POST', '/api/me/devices', { token: tok35, body: { fcmToken: 'short', platform: 'android' } });
      check('§35 POST /api/me/devices rejects a too-short token (400)', short35.status === 400, String(short35.status));
      const p1 = await req('POST', '/api/me/devices', { token: tok35, body: { fcmToken: 'mock-fcm-token-viewport-test', platform: 'android' } });
      check('§35 POST /api/me/devices registers one device', p1.status === 200 && p1.json?.devices === 1, JSON.stringify(p1.json));
      const d1 = await req('GET', '/api/me/devices', { token: tok35 });
      check('§35 GET /api/me/devices reads back 1 device', d1.status === 200 && d1.json?.devices === 1, JSON.stringify(d1.json));
      const p2 = await req('POST', '/api/me/devices', { token: tok35, body: { fcmToken: 'mock-fcm-token-viewport-test', platform: 'android' } });
      check('§35 re-registering the same token stays at 1 device (dedup)', p2.status === 200 && p2.json?.devices === 1, JSON.stringify(p2.json));
      const del35 = await req('DELETE', '/api/me/devices', { token: tok35, body: { fcmToken: 'mock-fcm-token-viewport-test' } });
      check('§35 DELETE /api/me/devices removes the device', del35.status === 200 && del35.json?.removed === 1, JSON.stringify(del35.json));
      const d2 = await req('GET', '/api/me/devices', { token: tok35 });
      check('§35 GET /api/me/devices reads back 0 after delete', d2.status === 200 && d2.json?.devices === 0, JSON.stringify(d2.json));
    }
    // 35b. Static: listeners-first order + the 10s timeout arm + the
    // visible status box + the failure paths that used to be silent.
    const regFnIdx = webJs35.indexOf('async function registerPushToken(push, opts)');
    const regFnEnd = webJs35.indexOf('\n}\n', regFnIdx);
    const regFnBody = regFnIdx === -1 ? '' : webJs35.slice(regFnIdx, regFnEnd === -1 ? regFnIdx + 3000 : regFnEnd);
    check('§35 registerPushToken attaches listeners BEFORE register()', regFnBody.indexOf('attachPushListeners(push)') !== -1 && regFnBody.indexOf('push.register()') !== -1 && regFnBody.indexOf('attachPushListeners(push)') < regFnBody.indexOf('push.register()'), 'listeners-first order broken');
    check('§35 registerPushToken arms the 10s timeout', regFnBody.includes('setTimeout(onPushRegTimeout, PUSH_REG_TIMEOUT_MS)') && webJs35.includes('const PUSH_REG_TIMEOUT_MS = 10000'), 'timeout arm missing');
    check('§35 register() failure surfaces a visible error (was a silent return)', regFnBody.includes('setPushRegError(t("pushRegFailed"))') && regFnBody.includes('toast(t("pushRegFailed"))'), 'register failure still silent');
    const routesSrc35 = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes.js'), 'utf8');
    check('§35 GET /api/me/devices endpoint exists (count only)', routesSrc35.includes("router.get('/me/devices'"), 'GET /api/me/devices missing');
    check('§35 notifications screen renders the per-device status box', webJs35.includes('id="pushStatusBox"') && webJs35.includes('pushStatusHTML()'), 'pushStatusBox missing');
    check('§35 loadNotifications checks the server count and clears a stale flag', webJs35.includes('api("/api/me/devices")') && webJs35.includes('if (d.devices === 0 && pushRegistered()) clearPushRegistered()'), 'stale-flag repair missing');
    check('§35 requestPushPermission verifies the flag against the server', webJs35.slice(webJs35.indexOf('async function requestPushPermission'), webJs35.indexOf('async function registerPushToken')).includes('api("/api/me/devices")'), 'flag verification missing');
    check('§35 registrationError listener is visible now (was silent)', webJs35.includes('push.addListener("registrationError"') && !webJs35.slice(webJs35.indexOf('push.addListener("registrationError"'), webJs35.indexOf('push.addListener("registrationError"') + 400).includes('silent: in-app centre still works'), 'registrationError still silent');
    check('§35 pushReg i18n exists in both languages', webJs35.includes('pushRegOn: "إشعارات الهاتف مفعّلة على هذا الجهاز ✓"') && webJs35.includes('pushRegOff: "إشعارات الهاتف غير مفعّلة على هذا الجهاز"') && webJs35.includes('pushRegTimeout: "تعذّر تفعيل إشعارات الهاتف') && webJs35.includes('pushRegOn: "Phone notifications are ON for this device ✓"') && webJs35.includes('pushRegTimeout: "Could not enable phone notifications'), 'pushReg i18n missing');
    // 35c. Functional: run the extracted §35 state block in a vm with
    // a fake localStorage/store/toast and drive every state.
    const vm35 = require('vm');
    const BEGIN35 = '/* v2.1.12 — push registration state (BEGIN';
    const END35 = '/* v2.1.12 — push registration state (END) */';
    const bi35 = webJs35.indexOf(BEGIN35);
    const ei35 = webJs35.indexOf(END35, bi35);
    check('§35 push-registration state block is extractable from web/app.js', bi35 !== -1 && ei35 !== -1 && ei35 > bi35, `${bi35}/${ei35}`);
    if (bi35 !== -1 && ei35 !== -1) {
      const ls35 = { _m: {}, getItem(k) { return Object.hasOwn(this._m, k) ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
      const toasts35 = [];
      const box35 = { innerHTML: '' };
      const ctx35 = {
        localStorage: ls35,
        store: { pushDevices: null, pushRegError: null },
        PUSH_REGISTERED_KEY: 'shifa_push_registered',
        document: { getElementById: (id) => (id === 'pushStatusBox' ? box35 : null) },
        console,
      };
      ctx35.pushRegistered = function () { try { return ls35.getItem('shifa_push_registered') === '1'; } catch (e) { return false; } };
      ctx35.window = ctx35;
      vm35.createContext(ctx35);
      vm35.runInContext('function t(k){ return k; } function esc(s){ return String(s == null ? "" : s); }', ctx35);
      ctx35.toast = (m) => { toasts35.push(m); };
      vm35.runInContext(webJs35.slice(bi35, ei35), ctx35);
      check('§35 initial state is off (no flag, no server count)', vm35.runInContext('pushRegState();', ctx35) === 'off' && vm35.runInContext('pushStatusHTML();', ctx35).includes('pushRegOff'), String(vm35.runInContext('pushRegState();', ctx35)));
      vm35.runInContext('pushRegPending = true;', ctx35);
      check('§35 pending state shows while waiting for the token', vm35.runInContext('pushRegState();', ctx35) === 'pending' && vm35.runInContext('pushStatusHTML();', ctx35).includes('pushRegPending'), String(vm35.runInContext('pushRegState();', ctx35)));
      const fired35 = vm35.runInContext('onPushRegTimeout();', ctx35);
      check('§35 the 10s timeout fires while pending (visible error + toast)', fired35 === true && ctx35.store.pushRegError === 'pushRegTimeout' && toasts35.includes('pushRegTimeout') && vm35.runInContext('pushRegState();', ctx35) === 'error', `fired=${fired35} err=${ctx35.store.pushRegError}`);
      const firedAgain35 = vm35.runInContext('onPushRegTimeout();', ctx35);
      check('§35 the timeout does nothing once the wait is over', firedAgain35 === false, String(firedAgain35));
      vm35.runInContext('clearPushRegError(); localStorage.setItem("shifa_push_registered", "1"); store.pushDevices = 1;', ctx35);
      check('§35 flag + server device = on', vm35.runInContext('pushRegState();', ctx35) === 'on' && vm35.runInContext('pushStatusHTML();', ctx35).includes('pushRegOn'), String(vm35.runInContext('pushRegState();', ctx35)));
      vm35.runInContext('store.pushDevices = 0;', ctx35);
      check('§35 flag with ZERO server devices = off (stale flag is not trusted)', vm35.runInContext('pushRegState();', ctx35) === 'off', String(vm35.runInContext('pushRegState();', ctx35)));
      vm35.runInContext('clearPushRegistered();', ctx35);
      check('§35 clearPushRegistered removes the flag', ls35.getItem('shifa_push_registered') === null, String(ls35.getItem('shifa_push_registered')));
      vm35.runInContext('refreshPushStatusUI();', ctx35);
      check('§35 refreshPushStatusUI writes the status into #pushStatusBox', box35.innerHTML.includes('pushRegOff'), box35.innerHTML.slice(0, 80));
      ctx35.document.getElementById = () => null;
      const uiErr35 = (() => { try { vm35.runInContext('refreshPushStatusUI();', ctx35); return null; } catch (e) { return e; } })();
      check('§35 refreshPushStatusUI with no status box does not throw', uiErr35 === null, String(uiErr35));
    }
  }

  // --- §36. v2.1.12: the sweep must actually complete -----------------
  // Live fault (Railway logs, 27 Nov 2026 02:27–03:17): '[sweep] error:
  // Cannot read properties of undefined (reading 'length')' every 5
  // minutes, 11 times — so auto-release, review reminders and settlement
  // notifications silently never ran. Local reproduction: the sweep is
  // clean on a fresh store, with 2 users, in production mode, and across
  // the whole suite with the interval on — the exact undefined read
  // lives in production-only data state, so this section pins (a) the
  // sweep succeeds on a fresh store and on a PARTIAL store (an empty {}
  // data file, which before the fix made even admin PIN verify 500 with
  // "reading 'push'"), and (b) the sweep failure now logs the STACK so
  // the next occurrence names the exact line in the Railway logs.
  console.log('\n[§36 v2.1.12]');
  {
    const serverJs36 = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('§36 sweep failure logs the stack (not just the message)', serverJs36.includes("console.error('[sweep] error:', e && e.stack ? e.stack : e.message)"), 'stack logging missing');
    const storeJs36 = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');
    check('§36 applyDefaults backfills the core collections', storeJs36.includes("if (!this.data.users || typeof this.data.users !== 'object') this.data.users = {};") && storeJs36.includes("if (!Array.isArray(this.data.audit)) this.data.audit = [];") && storeJs36.includes("if (!this.data.bookings || typeof this.data.bookings !== 'object') this.data.bookings = {};"), 'core backfills missing');
    check('§36 load() reseeds a data file that parses to a non-object', storeJs36.includes("if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))"), 'non-object guard missing');
    const routesJs36 = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes.js'), 'utf8');
    check('§36 sweepAutoRelease re-applies store defaults first', routesJs36.slice(routesJs36.indexOf('async function sweepAutoRelease()'), routesJs36.indexOf('async function sweepAutoRelease()') + 600).includes('store.applyDefaults();'), 'sweep self-heal missing');
    // Throwaway servers: one with a fresh (missing) data file, one with
    // a partial ({}) data file. Each must verify admin, run the sweep
    // explicitly, and return the full result shape without throwing.
    const { spawn: spawn36 } = require('child_process');
    async function sweepOnStore36(dataFile, label) {
      if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
      if (label === 'partial') fs.writeFileSync(dataFile, '{}\n', 'utf8');
      const env36 = { ...process.env, PORT: '3457', NODE_ENV: 'test', DATA_FILE: dataFile, MOCK_OTP: 'true', JWT_SECRET: 'smoke-test-secret', ADMIN_PIN: TEST_ADMIN_PIN, SWEEP_INTERVAL_MS: '3600000' };
      const child36 = spawn36('node', [path.join(__dirname, '..', 'server.js')], { env: env36, stdio: ['ignore', 'pipe', 'pipe'] });
      let out36 = '';
      child36.stdout.on('data', (d) => { out36 += d; });
      child36.stderr.on('data', (d) => { out36 += d; });
      try {
        let up36 = false;
        for (let i = 0; i < 40; i++) {
          await sleep(250);
          try { const hr = await fetch('http://127.0.0.1:3457/health'); if (hr.status === 200) { up36 = true; break; } } catch {}
        }
        check(`§36 ${label} store: throwaway server starts`, up36, out36.slice(0, 300));
        if (!up36) return;
        const ar36 = await fetch('http://127.0.0.1:3457/api/admin/pin/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: TEST_ADMIN_PIN }) });
        const aj36 = await ar36.json().catch(() => null);
        check(`§36 ${label} store: admin PIN verify works`, ar36.status === 200 && !!aj36?.token, `status=${ar36.status}`);
        if (!aj36?.token) return;
        const sw36 = await fetch('http://127.0.0.1:3457/api/jobs/sweep', { method: 'POST', headers: { Authorization: 'Bearer ' + aj36.token } });
        const sj36 = await sw36.json().catch(() => null);
        check(`§36 ${label} store: sweep completes (200, full result shape)`, sw36.status === 200 && sj36?.ok === true && Array.isArray(sj36?.released) && Array.isArray(sj36?.overdue) && typeof sj36?.settlementsGenerated === 'number', `status=${sw36.status} body=${JSON.stringify(sj36)?.slice(0, 200)}`);
        check(`§36 ${label} store: sweep logged no error`, !out36.includes('[sweep] error:'), out36.slice(0, 300));
        if (label === 'partial') {
          const after36 = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
          check('§36 partial store: core collections backfilled on disk', typeof after36.users === 'object' && typeof after36.bookings === 'object' && Array.isArray(after36.audit) && Array.isArray(after36.settlements) && typeof after36.providers === 'object', `keys=${Object.keys(after36).slice(0, 12).join(',')}`);
        }
      } finally {
        try { child36.kill('SIGTERM'); } catch {}
        await sleep(400);
        if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
      }
    }
    await sweepOnStore36(path.join(__dirname, 'sweep-fresh-data.json'), 'fresh');
    await sweepOnStore36(path.join(__dirname, 'sweep-partial-data.json'), 'partial');
  }

  // --- §37. v2.1.13: audit-fix regression checks ----------------------
  // One block per fix family, all against the live server. B3's live
  // regression already exists in §23i (cancel after start refunds
  // total − released days only); the review-day guard is pinned
  // statically below. The 24h sweep auto-cancel for rejected receipts
  // (B4) cannot be aged in-test — it is covered by the accept-403
  // below plus the sweep code path.
  console.log('\n[§37 v2.1.13]');
  {
    const XFF37A = '10.37.0.1';
    const XFF37B = '10.37.0.2';
    const XFF37C = '10.37.0.3';
    const XFF37D = '10.37.0.4';
    // Fresh patient (fresh XFF bucket — the main IP's login/OTP buckets
    // are exhausted by the earlier sections).
    await req('POST', '/api/otp/request', { xff: XFF37A, body: { phone: '01037373738', channel: 'whatsapp' } });
    const code37 = await mockCode('01037373738');
    const v37 = await req('POST', '/api/otp/verify', { xff: XFF37A, body: { phone: '01037373738', code: code37 } });
    const p37 = v37.json?.accessToken;
    check('§37 fresh patient logs in (OTP, fresh XFF bucket)', v37.status === 200 && !!p37, JSON.stringify(v37.json)?.slice(0, 200));
    // Full visit cycle with appA (Starter, 15%) as the provider.
    const cycle37 = async (patientTok, km, extraBody = {}) => {
      const c = await req('POST', '/api/bookings', { token: patientTok, body: { ...TERMS,
        patientName: 'Cycle37', serviceCode: 'standard', paymentMethod: 'cash_receipt',
        distanceKm: km, respectCharterAccepted: true, triage: { dangerSigns: [] }, ...extraBody,
      } });
      if (c.status !== 201) return { ok: false, step: 'create', res: c };
      const id = c.json.id;
      const a = await req('POST', `/api/bookings/${id}/accept`, { token: appA.token });
      if (a.status !== 200) return { ok: false, step: 'accept', res: a };
      const v = await req('POST', `/api/bookings/${id}/vitals`, { token: appA.token, body: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, glucose: 110, oxygen: 98, temp: 36.6 } });
      if (v.status !== 200) return { ok: false, step: 'vitals', res: v };
      const cp = await req('POST', `/api/bookings/${id}/complete-provider`, { token: appA.token });
      if (cp.status !== 200) return { ok: false, step: 'complete-provider', res: cp };
      const cf = await req('POST', `/api/bookings/${id}/confirm-patient`, { token: patientTok });
      if (cf.status !== 200) return { ok: false, step: 'confirm-patient', res: cf };
      const rv = await req('POST', `/api/bookings/${id}/review`, { token: patientTok, body: { rating: 5, comment: 'Good.', circumventionReported: false } });
      if (rv.status !== 200 || rv.json?.status !== 'released') return { ok: false, step: 'review', res: rv };
      return { ok: true, id, created: c.json, accept: a.json, released: rv.json };
    };
    const complain37 = async (bookingId, decision) => {
      const sr = await req('POST', `/api/bookings/${bookingId}/safety-report`, { token: p37, body: { type: 'complaint', description: '§37 test complaint.' } });
      if (sr.status !== 201) return { ok: false, step: 'complaint', res: sr };
      const rr = await req('POST', `/api/admin/complaints/${sr.json?.reportId}/resolve`, { token: adminToken, body: { decision } });
      return { ok: rr.status === 200, step: 'resolve', res: rr, reportId: sr.json?.reportId };
    };
    const walletEntry37 = async (bookingId) => {
      const w = await req('GET', '/api/providers/wallet', { token: appA.token });
      return (w.json?.ledger || []).find((l) => l.bookingId === bookingId);
    };
    const audit37 = async () => {
      const a = await req('GET', '/api/admin/audit?limit=200', { token: adminToken });
      return Array.isArray(a.json) ? a.json : [];
    };

    // 37a. H15: 90-question bank, 36 sampled per attempt, answers are
    // positions only — key letters / out-of-range / unknown ids 400.
    check('§37 interview bank is 90 questions', MCQ.length === 90, `MCQ=${MCQ.length}`);
    const st37 = await req('POST', '/api/providers/interview/start', { token: provToken });
    check('§37 interview start returns 36 sampled questions', st37.status === 200 && Array.isArray(st37.json?.questions) && st37.json.questions.length === 36, JSON.stringify(st37.json)?.slice(0, 200));
    const qs37 = st37.json?.questions || [];
    const dims37 = {};
    for (const q of qs37) dims37[q.category] = (dims37[q.category] || 0) + 1;
    check('§37 sampled questions cover the 6 dimensions by quota (8/7/6/6/5/4)', dims37.medical === 8 && dims37.ethics === 7 && dims37.safety === 6 && dims37.communication === 6 && dims37.resilience === 5 && dims37.conduct === 4, JSON.stringify(dims37));
    check('§37 sampled ids are all in the 90-question bank', qs37.every((q) => MCQ.some((x) => x.id === q.id)), JSON.stringify(qs37.map((q) => q.id).slice(0, 5)));
    check('§37 published options carry text only (no key/correct/red-flag)', qs37.every((q) => Array.isArray(q.options) && q.options.length === 4 && q.options.every((o) => typeof o.text === 'string' && !('key' in o) && !('correct' in o))), JSON.stringify(qs37[0]?.options));
    const correctPos37 = {};
    for (const q of qs37) {
      const bankQ = MCQ.find((x) => x.id === q.id);
      const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
      correctPos37[q.id] = q.options.findIndex((o) => o.text === correctText);
    }
    const enPos37 = {};
    for (const q of (st37.json?.englishCheck?.questions || [])) {
      const bankQ = ENGLISH_CHECK.find((x) => x.id === q.id);
      const correctText = bankQ?.options.find((o) => o.key === bankQ.correct)?.text;
      enPos37[q.id] = q.options.findIndex((o) => o.text === correctText);
    }
    const attempt37 = st37.json?.attemptId;
    r = await req('POST', '/api/providers/interview/submit', { token: provToken, body: { attemptId: attempt37, answers: { ...correctPos37, [qs37[0].id]: 'a' }, englishAnswers: enPos37 } });
    check('§37 interview answer as a key letter -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/providers/interview/submit', { token: provToken, body: { attemptId: attempt37, answers: { ...correctPos37, [qs37[1].id]: 4 }, englishAnswers: enPos37 } });
    check('§37 interview answer out of range (4) -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/providers/interview/submit', { token: provToken, body: { attemptId: attempt37, answers: { ...correctPos37, nope_qid: 0 }, englishAnswers: enPos37 } });
    check('§37 interview answer for a question outside this attempt -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', '/api/providers/interview/submit', { token: provToken, body: { attemptId: attempt37, answers: correctPos37, englishAnswers: enPos37 } });
    check('§37 the same attempt still submits all-correct -> passed 36/36 (400s did not consume it)', r.status === 200 && r.json?.status === 'passed' && r.json?.total === 36 && r.json?.scores?.medical === 8 && r.json?.scores?.ethics === 7 && r.json?.scores?.safety === 6, JSON.stringify(r.json)?.slice(0, 300));

    // 37b. M16: manual-review blocks start/fetch until an admin decides.
    const register37 = async (phone, role) => {
      await req('POST', '/api/otp/request', { xff: XFF37B, body: { phone, channel: 'whatsapp' } });
      const code = await mockCode(phone);
      const v = await req('POST', '/api/otp/verify', { xff: XFF37B, body: { phone, code } });
      const tok = v.json?.accessToken;
      await req('POST', '/api/me/terms', { xff: XFF37B, token: tok, body: { acceptedTerms: true, termsVersion: '1.0' } });
      const nationalId = `303041901${phone.slice(-4)}1`;
      const reg = await req('POST', '/api/providers/register', { xff: XFF37B, token: tok, body: { ...TERMS,
        name: `Test ${role}`, providerType: role, role, nationalId, licenseNo: `LIC-${phone.slice(-4)}`, certificates: [],
      } });
      const login = await req('POST', '/api/auth/login-phone', { xff: XFF37B, body: { phone, role: 'provider' } });
      return { token: login.json?.accessToken || tok, providerId: login.json?.providerId || reg.json?.id, reg, regStatus: reg.status };
    };
    const mr37 = await register37('01037373737', 'nurse');
    check('§37 manual-review provider registered', mr37.regStatus === 201, JSON.stringify(mr37.reg));
    const mrInterview = await answerInterview(mr37.token, 'manual-review');
    check('§37 21/36 -> manual-review', mrInterview.submit?.status === 200 && mrInterview.submit?.json?.status === 'manual-review' && mrInterview.submit?.json?.total === 21, JSON.stringify(mrInterview.submit?.json));
    r = await req('POST', '/api/providers/interview/start', { token: mr37.token });
    check('§37 interview start while manual-review -> 409', r.status === 409 && String(JSON.stringify(r.json)).includes('manual_review'), JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/providers/interview/questions', { token: mr37.token });
    check('§37 interview questions fetch while manual-review -> 409', r.status === 409 && String(JSON.stringify(r.json)).includes('manual_review'), JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/providers/${mr37.providerId}/interview`, { token: adminToken, body: { decision: 'pass' } });
    check('§37 admin passes manual-review interview -> passed, points 10', r.status === 200 && r.json?.interviewStatus === 'passed' && r.json?.points?.interview === 10, JSON.stringify(r.json)?.slice(0, 300));
    const mrPass = await answerInterview(mr37.token, 'all-correct');
    check('§37 after the admin pass the provider can retake and pass 36/36', mrPass.submit?.status === 200 && mrPass.submit?.json?.status === 'passed' && mrPass.submit?.json?.total === 36, JSON.stringify(mrPass.submit?.json));

    // 37c. H17/H16: national-ID validation + uniqueness, re-registration
    // after rejection keeps the interview record; admin reopen path.
    const rereg37 = async (nationalId, licenseNo) => req('POST', '/api/providers/register', { token: appB.token, body: { ...TERMS,
      name: 'Test nurse', providerType: 'nurse', role: 'nurse', nationalId, licenseNo, certificates: [{ name: 'BLS' }],
    } });
    r = await rereg37('10304190119191', 'LIC-1919');
    check('§37 re-register with a national ID starting with 1 -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await rereg37('30313010119191', 'LIC-1919');
    check('§37 re-register with an impossible birth month (13) -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await rereg37('30304190118181', 'LIC-1919');
    check('§37 re-register with appA\'s national ID -> 409 duplicate', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await rereg37('30304190119192', 'LIC-1818');
    check('§37 re-register with appA\'s licence number -> 409 duplicate', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await rereg37('30304190119192', 'LIC-1919');
    check('§37 re-register with a valid unique ID -> 200 pending, interview record kept (not_started)', r.status === 200 && r.json?.status === 'pending' && r.json?.interviewStatus === 'not_started', JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/admin/applications/${appB.providerId}/reject`, { token: adminToken, body: { reason: '§37 test reject' } });
    check('§37 admin rejects appB again -> rejected', r.status === 200 && r.json?.status === 'rejected', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/applications/${appB.providerId}/reopen`, { token: adminToken, body: {} });
    check('§37 admin reopens a rejected application -> pending', r.status === 200 && r.json?.status === 'pending', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/applications/${appB.providerId}/reopen`, { token: adminToken, body: {} });
    check('§37 reopening a non-rejected application -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));

    // 37d. B1/B2/M30 + cash-voucher net: 4 cycles earn a voucher, then
    // #1 (cash 250, complaint rejected -> provider owes the 38 app
    // share), #2 (cash 350 with the voucher, complaint refunded ->
    // adjustment 300 = what the patient actually paid, voucher
    // restored), #3 (cash 350 with the restored voucher, complaint
    // rejected -> the APP owes the provider 20: voucher 50 minus gross
    // app share 30), #4 + #5 (8th PAID visit -> second voucher earned).
    // NOTE (approved points system): appA auto-upgrades Starter -> Pro
    // at the 5th rated visit (interview 20 + rating 20 = 40 points), so
    // #1 locks Starter 15% but #2/#3 lock Pro 12% (gross app share on
    // the 250 service base is 30, not 38). And a REFUNDED visit is not
    // a paid visit (completedPaidVisits counts released bookings only),
    // so #2's refund means the 8th paid visit is #5, not #4.
    let cycles37Ok = true; let cycles37Fail = '';
    for (let i = 0; i < 4; i++) {
      const cyc = await cycle37(p37, 2);
      if (!cyc.ok) { cycles37Ok = false; cycles37Fail = `${cyc.step} ${JSON.stringify(cyc.res?.json || cyc.res)}`; break; }
      if (i === 0) {
        check('§37 cash booking is flagged cash at creation (B1)', cyc.created?.cashCollectedByProvider === true && cyc.created?.amountEgp === 250 && cyc.created?.amountPayableEgp === 250, JSON.stringify(cyc.created)?.slice(0, 300));
        check('§37 accept locks Starter 15%, estimated share 212 (250 − 38)', cyc.accept?.commissionPct === 15 && cyc.accept?.estimatedProviderShareEgp === 212, JSON.stringify(cyc.accept)?.slice(0, 300));
        check('§37 cycle release: provider 212, app 38', cyc.released?.providerShareEgp === 212 && cyc.released?.appShareEgp === 38, JSON.stringify(cyc.released)?.slice(0, 300));
      }
    }
    check('§37 4 voucher-earning cycles complete', cycles37Ok, cycles37Fail.slice(0, 300));
    r = await req('GET', '/api/me/vouchers', { token: p37 });
    const voucher37 = (r.json?.vouchers || [])[0];
    check('§37 after 4 paid visits the patient holds one 50 EGP voucher', r.status === 200 && (r.json?.vouchers || []).length === 1 && voucher37?.amountEgp === 50 && r.json?.completedPaidVisits === 4 && r.json?.vouchersEarned === 1, JSON.stringify(r.json)?.slice(0, 300));
    const c1 = await cycle37(p37, 2);
    check('§37 #1 cash 250 cycle completes', c1.ok, c1.ok ? '' : `${c1.step} ${JSON.stringify(c1.res?.json || c1.res)}`.slice(0, 300));
    const rc1 = await complain37(c1.id, 'rejected');
    check('§37 #1 complaint rejected -> settleable at once', rc1.ok && rc1.res?.json?.booking?.complaintStatus === 'rejected', JSON.stringify(rc1.res?.json)?.slice(0, 300));
    const w1 = await walletEntry37(c1.id);
    check('§37 #1 wallet: provider owes the app 38 (cash app share)', w1?.direction === 'provider_owes_app' && w1?.amountEgp === 38, JSON.stringify(w1));
    const c2 = await cycle37(p37, 8);
    check('§37 #2 cash 350 cycle completes, voucher applied (payable 300)', c2.ok && c2.created?.amountEgp === 350 && c2.created?.amountPayableEgp === 300 && c2.created?.voucherDiscountEgp === 50, JSON.stringify(c2.created)?.slice(0, 300));
    check('§37 #2 release: provider 320 on the full price, app 0 (voucher eats the 30)', c2.released?.providerShareEgp === 320 && c2.released?.appShareEgp === 0, JSON.stringify(c2.released)?.slice(0, 300));
    const rc2 = await complain37(c2.id, 'accepted_refund');
    check('§37 #2 complaint accepted -> refunded 300 (what the patient paid)', rc2.ok && rc2.res?.json?.booking?.status === 'refunded' && rc2.res?.json?.booking?.refundEgp === 300, JSON.stringify(rc2.res?.json)?.slice(0, 300));
    const adj37 = (await audit37()).find((a) => a.action === 'settlement.adjustment_created' && a.details?.bookingId === c2.id);
    check('§37 #2 reversing adjustment: refund 300 (not 350), cash, provider 320 / app 0', !!adj37 && adj37.details?.refundEgp === 300 && adj37.details?.cash === true && adj37.details?.providerShareEgp === 320 && adj37.details?.appShareEgp === 0, JSON.stringify(adj37?.details));
    r = await req('GET', '/api/me/vouchers', { token: p37 });
    check('§37 #2 refund restores the voucher to active (M30)', r.status === 200 && (r.json?.vouchers || []).length === 1 && (r.json?.vouchers || [])[0]?.id === voucher37?.id && (r.json?.vouchers || [])[0]?.usedBookingId == null, JSON.stringify(r.json)?.slice(0, 300));
    const w2 = await walletEntry37(c2.id);
    check('§37 #2 wallet: refunded, nothing to settle', w2?.direction === 'refunded' && w2?.amountEgp === 0, JSON.stringify(w2));
    const c3 = await cycle37(p37, 8);
    check('§37 #3 cash 350 cycle completes with the restored voucher (payable 300)', c3.ok && c3.created?.amountPayableEgp === 300 && c3.created?.voucherDiscountEgp === 50, JSON.stringify(c3.created)?.slice(0, 300));
    const rc3 = await complain37(c3.id, 'rejected');
    check('§37 #3 complaint rejected -> settleable at once', rc3.ok && rc3.res?.json?.booking?.complaintStatus === 'rejected', JSON.stringify(rc3.res?.json)?.slice(0, 300));
    const w3 = await walletEntry37(c3.id);
    check('§37 #3 wallet: the APP owes the provider 20 (voucher 50 − gross app share 30)', w3?.direction === 'app_owes_provider' && w3?.amountEgp === 20, JSON.stringify(w3));
    const c4 = await cycle37(p37, 2);
    check('§37 #4 cash 250 cycle completes (7th paid visit — #2 was refunded)', c4.ok, c4.ok ? '' : `${c4.step} ${JSON.stringify(c4.res?.json || c4.res)}`.slice(0, 300));
    const c5 = await cycle37(p37, 2);
    check('§37 #5 cash 250 cycle completes (8th paid visit)', c5.ok, c5.ok ? '' : `${c5.step} ${JSON.stringify(c5.res?.json || c5.res)}`.slice(0, 300));
    r = await req('GET', '/api/me/vouchers', { token: p37 });
    check('§37 after 8 paid visits a second voucher is earned', r.status === 200 && (r.json?.vouchers || []).length === 1 && r.json?.completedPaidVisits === 8 && r.json?.vouchersEarned === 2, JSON.stringify(r.json)?.slice(0, 300));

    // 37e. H9: broadcast counters split (delivered / pushSent / pushFailed).
    r = await req('POST', '/api/admin/broadcast', { token: adminToken, body: { title: '§37 dry run', body: 'test', dryRun: true } });
    check('§37 broadcast dry-run reports the audience with zero counters', r.status === 200 && r.json?.dryRun === true && r.json?.users > 0 && r.json?.delivered === 0 && r.json?.pushSent === 0 && r.json?.pushFailed === 0 && r.json?.sent === 0 && r.json?.failed === 0, JSON.stringify(r.json)?.slice(0, 300));
    const bcUsers = r.json?.users;
    r = await req('POST', '/api/admin/broadcast', { token: adminToken, body: { title: '§37 test broadcast', body: 'v2.1.13 regression check — please ignore.' } });
    check('§37 broadcast live: delivered = audience, pushSent 0 (no FCM), pushFailed = delivered, sent 0, failed = audience', r.status === 200 && r.json?.users === bcUsers && r.json?.delivered === bcUsers && r.json?.pushSent === 0 && r.json?.pushFailed === bcUsers && r.json?.sent === 0 && r.json?.failed === bcUsers, JSON.stringify(r.json)?.slice(0, 300));

    // 37f. B5/H8/H10: SOS + safety report + provider application reach
    // the admin's in-app notifications; M24: SOS resolve + open filter.
    r = await req('POST', '/api/bookings', { token: p37, body: { ...TERMS,
      patientName: 'SOS37', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('§37 SOS test booking created', r.status === 201, JSON.stringify(r.json)?.slice(0, 200));
    const bkSos37 = r.json?.id;
    r = await req('POST', `/api/bookings/${bkSos37}/accept`, { token: appA.token });
    check('§37 SOS test booking accepted by appA', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkSos37}/sos`, { token: appA.token });
    check('§37 SOS raised -> 201', r.status === 201 && !!r.json?.sosId, JSON.stringify(r.json)?.slice(0, 200));
    const sosId37 = r.json?.sosId;
    r = await req('POST', `/api/bookings/${bkSos37}/safety-report`, { token: p37, body: { type: 'safety', description: '§37 safety test report.' } });
    check('§37 safety report filed -> 201', r.status === 201 && !!r.json?.reportId, JSON.stringify(r.json)?.slice(0, 200));
    const srId37 = r.json?.reportId;
    const adminLogin37 = await req('POST', '/api/auth/login-phone', { xff: XFF37C, body: { phone: '01008629060' } });
    const adminPhoneTok37 = adminLogin37.json?.accessToken;
    check('§37 admin phone logs in (fresh XFF bucket)', adminLogin37.status === 200 && !!adminPhoneTok37, JSON.stringify(adminLogin37.json)?.slice(0, 200));
    r = await req('GET', '/api/me/notifications', { token: adminPhoneTok37 });
    const ntf37 = r.json?.notifications || [];
    check('§37 admin inbox has the SOS notification (bookingId + sosId)', ntf37.some((n) => n.type === 'sos' && n.data?.bookingId === bkSos37 && n.data?.sosId === sosId37), JSON.stringify(ntf37.filter((n) => n.type === 'sos').slice(0, 2)));
    check('§37 admin inbox has the safety-report notification (bookingId + reportId)', ntf37.some((n) => n.type === 'safety_report' && n.data?.bookingId === bkSos37 && n.data?.reportId === srId37), JSON.stringify(ntf37.filter((n) => n.type === 'safety_report').slice(0, 2)));
    check('§37 admin inbox has the provider-application notification for appA (§22d registration)', ntf37.some((n) => n.type === 'provider_application' && n.data?.providerId === appA.providerId), JSON.stringify(ntf37.filter((n) => n.type === 'provider_application').slice(0, 2)));
    r = await req('POST', `/api/admin/sos/${sosId37}/resolve`, { token: adminToken, body: {} });
    check('§37 admin resolves the SOS -> resolved', r.status === 200 && r.json?.sos?.status === 'resolved' && !!r.json?.sos?.resolvedAt, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/admin/sos/${sosId37}/resolve`, { token: adminToken, body: {} });
    check('§37 resolving an already-resolved SOS -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', '/api/admin/sos?open=true', { token: adminToken });
    check('§37 open SOS list no longer contains the resolved alert', r.status === 200 && !(r.json?.sos || []).some((s) => s.id === sosId37), JSON.stringify((r.json?.sos || []).map((s) => s.id).slice(0, 5)));
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('§37 dashboard SOS list defaults to open (resolved alert hidden)', r.status === 200 && !(r.json?.sosAlerts || []).some((s) => s.id === sosId37), JSON.stringify((r.json?.sosAlerts || []).map((s) => s.id).slice(0, 5)));
    r = await req('GET', '/api/admin/dashboard?sos=all', { token: adminToken });
    check('§37 dashboard ?sos=all shows the resolved alert', r.status === 200 && (r.json?.sosAlerts || []).some((s) => s.id === sosId37), JSON.stringify((r.json?.sosAlerts || []).map((s) => s.id).slice(0, 5)));

    // 37g. B4: a rejected receipt blocks acceptance.
    r = await req('POST', '/api/bookings', { token: p37, body: { ...TERMS,
      patientName: 'Receipt37', serviceCode: 'standard', paymentMethod: 'instapay',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] }, receiptImage: RECEIPT_JPEG,
    } });
    check('§37 instapay booking with receipt created (pending)', r.status === 201 && r.json?.receipt?.status === 'pending', JSON.stringify(r.json)?.slice(0, 300));
    const bkRec37 = r.json?.id;
    r = await req('POST', `/api/admin/bookings/${bkRec37}/receipt/reject`, { token: adminToken, body: { note: '§37 test rejection — blurry photo.' } });
    check('§37 admin rejects the receipt -> rejected', r.status === 200 && r.json?.receipt?.status === 'rejected', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkRec37}/accept`, { token: appA.token });
    check('§37 accept with a rejected receipt -> 403 naming the rejection', r.status === 403 && String(JSON.stringify(r.json)).includes('rejected'), JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/bookings/${bkRec37}/cancel`, { token: p37 });
    check('§37 patient cancels the held booking with the rejected receipt -> 200', r.status === 200 && r.json?.status === 'cancelled', JSON.stringify(r.json)?.slice(0, 200));

    // 37h. M3: past scheduled dates rejected; useVoucher=false.
    r = await req('POST', '/api/bookings', { token: p37, body: { ...TERMS,
      name: 'Past37', phone: '01037373738', service: 'standard', date: '2020-01-01', time: '10:00',
      address: 'Test St', km: 2, transportProvided: false, paymentMethod: 'cash', charterAccepted: true,
    } });
    check('§37 booking scheduled in the past -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', '/api/bookings', { token: p37, body: { ...TERMS,
      patientName: 'NoVoucher37', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 8, respectCharterAccepted: true, triage: { dangerSigns: [] }, useVoucher: false,
    } });
    check('§37 useVoucher=false: 350 booking pays the full 350, no discount', r.status === 201 && r.json?.amountEgp === 350 && r.json?.amountPayableEgp === 350 && (r.json?.voucherDiscountEgp || 0) === 0, JSON.stringify(r.json)?.slice(0, 300));
    const bkNv37 = r.json?.id;
    r = await req('GET', '/api/me/vouchers', { token: p37 });
    check('§37 useVoucher=false leaves the voucher active for later', (r.json?.vouchers || []).length === 1, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkNv37}/cancel`, { token: p37 });
    check('§37 the useVoucher=false booking cancels while held -> 200', r.status === 200 && r.json?.status === 'cancelled', JSON.stringify(r.json)?.slice(0, 200));

    // 37i. L17: NPWT split; M33: distance is a pass-through (dressing
    // 275 + fee 100 = 375, commission 12% of 275 = 33 — appA is Pro by
    // now, see §37d — provider 342).
    // M25/B2 gate: admin-cancel of a pre-visit CASH booking refunds 0
    // and creates no reversing adjustment (no cash was collected yet).
    r = await req('POST', '/api/npwt/calculate', { token: p37, body: { days: 14, kitPrice: 300 } });
    check('§37 NPWT 14d split: total 5500 = service 3000 + equipment 2500', r.status === 200 && r.json?.totalEgp === 5500 && r.json?.serviceEgp === 3000 && r.json?.equipmentEgp === 2500, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', '/api/bookings', { token: p37, body: { ...TERMS,
      patientName: 'Dress37', serviceCode: 'dressing', paymentMethod: 'cash_receipt',
      distanceKm: 8, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('§37 dressing booking at 8km created (275 + 100 fee = 375)', r.status === 201 && r.json?.amountEgp === 375, JSON.stringify(r.json)?.slice(0, 300));
    const bkDr37 = r.json?.id;
    r = await req('POST', `/api/bookings/${bkDr37}/accept`, { token: appA.token });
    check('§37 dressing accept: commission on the 275 service only -> provider 342', r.status === 200 && r.json?.commissionPct === 12 && r.json?.estimatedProviderShareEgp === 342, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/admin/bookings/${bkDr37}/cancel`, { token: adminToken, body: { reason: '§37 test cancel' } });
    check('§37 admin cancels a pre-visit cash booking -> refund 0 (nothing was paid)', r.status === 200 && r.json?.status === 'cancelled' && r.json?.refundEgp === 0, JSON.stringify(r.json)?.slice(0, 300));
    const adjDr37 = (await audit37()).find((a) => a.action === 'settlement.adjustment_created' && a.details?.bookingId === bkDr37);
    check('§37 no reversing adjustment for a pre-visit cash admin-cancel', !adjDr37, JSON.stringify(adjDr37?.details || null));

    // 37j. M27: the review requires circumventionReported (boolean).
    r = await req('POST', '/api/bookings', { token: p37, body: { ...TERMS,
      patientName: 'Circ37', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkCirc37 = r.json?.id;
    await req('POST', `/api/bookings/${bkCirc37}/accept`, { token: provToken });
    await req('POST', `/api/bookings/${bkCirc37}/vitals`, { token: provToken, body: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, glucose: 110, oxygen: 98, temp: 36.6 } });
    await req('POST', `/api/bookings/${bkCirc37}/complete-provider`, { token: provToken });
    await req('POST', `/api/bookings/${bkCirc37}/confirm-patient`, { token: p37 });
    r = await req('POST', `/api/bookings/${bkCirc37}/review`, { token: p37, body: { rating: 5, comment: 'Good.' } });
    check('§37 review without circumventionReported -> 400', r.status === 400, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkCirc37}/review`, { token: p37, body: { rating: 5, comment: 'Good.', circumventionReported: false } });
    check('§37 review with circumventionReported=false -> 200 released', r.status === 200 && r.json?.status === 'released', JSON.stringify(r.json)?.slice(0, 200));

    // 37k. M28: phone numbers are filtered after normalisation
    // (Arabic-Indic digits, spaced digits); admin can read the chat.
    r = await req('POST', '/api/bookings', { token: p37, body: { ...TERMS,
      patientName: 'Msg37', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkMsg37 = r.json?.id;
    await req('POST', `/api/bookings/${bkMsg37}/accept`, { token: appA.token });
    r = await req('POST', `/api/bookings/${bkMsg37}/messages`, { token: p37, body: { text: 'تواصل معي على ٠١٠٠٨٦٢٩٠٦٠' } });
    check('§37 message with Arabic-Indic digits phone -> 400 phone_number_not_allowed', r.status === 400 && r.json?.error === 'phone_number_not_allowed', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkMsg37}/messages`, { token: p37, body: { text: 'call me on 0100 862 9060' } });
    check('§37 message with spaced digits phone -> 400', r.status === 400 && r.json?.error === 'phone_number_not_allowed', JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/bookings/${bkMsg37}/messages`, { token: p37, body: { text: 'مرحبا، متى تصل؟' } });
    check('§37 clean message -> 201', r.status === 201, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', `/api/admin/bookings/${bkMsg37}/messages`, { token: adminToken });
    check('§37 admin reads the booking chat (1 clean message, blocked ones absent)', r.status === 200 && r.json?.count === 1 && (r.json?.messages || [])[0]?.text === 'مرحبا، متى تصل؟', JSON.stringify(r.json)?.slice(0, 300));

    // 37l. M25: suspend reports the stranded active bookings; admin
    // cancel refunds + 409 on repeat. M23: an expired suspension is
    // cleared on the next login (permanent bans stay).
    r = await req('POST', `/api/admin/bookings/${bkSos37}/cancel`, { token: adminToken, body: { reason: '§37 test cancel' } });
    check('§37 admin cancels the SOS booking (pre-visit cash) -> refund 0', r.status === 200 && r.json?.status === 'cancelled' && r.json?.refundEgp === 0, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/admin/providers/${appA.providerId}/suspend`, { token: adminToken, body: { reason: '§37 test suspension.' } });
    check('§37 suspend reports 1 active booking (the accepted message booking)', r.status === 200 && r.json?.suspended === true && r.json?.activeBookings === 1, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/admin/providers/${appA.providerId}/unsuspend`, { token: adminToken, body: {} });
    check('§37 unsuspend -> 200', r.status === 200 && r.json?.suspended === false, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/bookings/${bkMsg37}/cancel`, { token: adminToken, body: { reason: '§37 test cancel' } });
    check('§37 admin cancels the message booking (pre-visit cash) -> refund 0', r.status === 200 && r.json?.status === 'cancelled' && r.json?.refundEgp === 0, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/admin/bookings/${bkMsg37}/cancel`, { token: adminToken, body: { reason: '§37 test cancel again' } });
    check('§37 admin cancels an already-cancelled booking -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('POST', `/api/admin/providers/${appA.providerId}/suspend`, { token: adminToken, body: { reason: '§37 expired suspension.', until: new Date(Date.now() - 60 * 60 * 1000).toISOString() } });
    check('§37 suspend with an already-past until -> 200 suspended (for now)', r.status === 200 && r.json?.suspended === true, JSON.stringify(r.json)?.slice(0, 200));
    const appALogin37 = await req('POST', '/api/auth/login-phone', { xff: XFF37D, body: { phone: '01018181818', role: 'provider' } });
    check('§37 provider logs in after the suspension expired -> 200', appALogin37.status === 200 && !!appALogin37.json?.accessToken, JSON.stringify(appALogin37.json)?.slice(0, 200));
    r = await req('GET', '/api/admin/providers', { token: adminToken });
    const appARec37 = (r.json || []).find((p) => p.id === appA.providerId);
    check('§37 expired suspension is cleared on login (suspended false)', !!appARec37 && appARec37.suspended === false, JSON.stringify(appARec37)?.slice(0, 300));
    const suspAudit37 = (await audit37()).find((a) => a.action === 'admin.suspension_expired' && a.details?.providerId === appA.providerId);
    check('§37 the expiry is audited (admin.suspension_expired)', !!suspAudit37, JSON.stringify(suspAudit37?.details || null));

    // 37m. B1/B2 settlement: one record for appA — provider owes 38
    // (#1) + 300 (#2 refund) = 338, app owes 20 (#3 voucher net),
    // 2 settleable cases, 6 held (4 × 38 at 15% + #4/#5 × 30 at 12%)
    // = 212, no bonus. M31/L19:
    // mark-paid sets the paid fields (and only there do bonus flags
    // move — verified on redProv's 500-bonus settlement).
    r = await req('POST', '/api/jobs/sweep', { token: adminToken });
    check('§37 sweep runs', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('GET', `/api/admin/settlements?providerId=${appA.providerId}`, { token: adminToken });
    const stl37 = (r.json?.settlements || [])[0];
    check('§37 settlement for appA: provider owes 338, app owes 20, 2 cases, hold 212, no bonus, unpaid',
      !!stl37 && stl37.totals.providerOwesAppEgp === 338 && stl37.totals.appOwesProviderEgp === 20
      && stl37.totals.releasedCases === 2 && stl37.totals.complaintHoldEgp === 212
      && stl37.totals.volumeBonusEgp === 0 && stl37.totals.cashAppShareEgp === 38
      && stl37.paid === false && stl37.paidAt == null, JSON.stringify(stl37?.totals));
    await req('POST', '/api/jobs/sweep', { token: adminToken });
    r = await req('GET', `/api/admin/settlements?providerId=${appA.providerId}`, { token: adminToken });
    check('§37 second sweep creates no second settlement for appA (no double-pay)', r.status === 200 && (r.json?.settlements || []).length === 1, JSON.stringify({ count: (r.json?.settlements || []).length }));
    r = await req('POST', `/api/admin/settlements/${stl37.id}/mark-paid`, { token: adminToken, body: { paidRef: '§37-test' } });
    check('§37 mark-paid -> 200 with paidAt/paidBy/paidRef', r.status === 200 && !!r.json?.paidAt && r.json?.paidBy === 'admin' && r.json?.paidRef === '§37-test', JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', `/api/admin/settlements/${stl37.id}/mark-paid`, { token: adminToken, body: { paidRef: '§37-test-again' } });
    check('§37 marking an already-paid settlement -> 409', r.status === 409, JSON.stringify(r.json)?.slice(0, 200));
    r = await req('GET', `/api/admin/settlements?providerId=${appA.providerId}`, { token: adminToken });
    check('§37 settlement list exposes paid=true after mark-paid', (r.json?.settlements || [])[0]?.paid === true && !!(r.json?.settlements || [])[0]?.paidAt, JSON.stringify((r.json?.settlements || [])[0])?.slice(0, 300));
    r = await req('GET', `/api/admin/settlements?providerId=${redProv.providerId}`, { token: adminToken });
    const stlRed37 = (r.json?.settlements || [])[0];
    const redBonus37 = stlRed37?.totals?.volumeBonusEgp;
    r = await req('POST', `/api/admin/settlements/${stlRed37.id}/mark-paid`, { token: adminToken, body: { paidRef: '§37-redprov' } });
    check('§37 redProv bonus settlement marks paid', r.status === 200 && !!r.json?.paidAt, JSON.stringify(r.json)?.slice(0, 300));
    const mpAudit37 = (await audit37()).find((a) => a.action === 'settlement.marked_paid' && a.details?.providerId === redProv.providerId);
    check('§37 mark-paid audit carries the bonus amounts (volume bonus moves only here, L19)', !!mpAudit37 && mpAudit37.details?.volumeBonusEgp === redBonus37 && redBonus37 === 500, JSON.stringify(mpAudit37?.details));

    // 37n. Static pins: M32 env-promo cap (~62 days from first sight,
    // exposed in the dashboard), B3 review-day guard, L1 device pruning.
    const routesJs37 = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes.js'), 'utf8');
    check('§37 M32: env promo capped in code (~62 days from first sight)', routesJs37.includes('promoEnvMaxDays') && routesJs37.includes('envPromoStartedAt') && routesJs37.includes("source: 'env'"), 'env promo cap missing');
    r = await req('GET', '/api/admin/dashboard', { token: adminToken });
    check('§37 dashboard exposes the promo state (inactive, no env promo configured)', r.status === 200 && r.json?.promo?.active === false && r.json?.promo?.commissionPct === null && r.json?.promo?.until === null, JSON.stringify(r.json?.promo));
    const refundFn37 = routesJs37.slice(routesJs37.indexOf('function packageRefundRemaining'), routesJs37.indexOf('function packageRefundRemaining') + 900);
    check('§37 B3: packageRefundRemaining skips days under packageReviewRequired', refundFn37.includes('packageReviewRequired'), refundFn37.slice(0, 200));
    const notifyJs37 = fs.readFileSync(path.join(__dirname, '..', 'src', 'notify.js'), 'utf8');
    check('§37 L1: devices store lastSentAt and prune after 60 days without a send', notifyJs37.includes('lastSentAt') && notifyJs37.includes('DEVICE_INACTIVE_MS') && notifyJs37.includes('activeDeviceCount'), 'device activity tracking missing');
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
