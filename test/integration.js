// Integration test for the WEB FRONTEND contract (frontend-shaped payloads
// and legacy path names). Starts the server on a throwaway port + data file.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3457;
const DATA = path.join(__dirname, '..', 'data-integration-test.json');
process.env.DATA_FILE = DATA;
process.env.MOCK_OTP = 'true';
process.env.PORT = String(PORT);
// Test-only admin PIN (mirrors smoke.js). Since the fail-closed fix
// (commit 24a2246), no PIN is seeded by default, so the admin-login
// checks below need an explicit test PIN. It is generated fresh on every
// run — never a fixed value.
const TEST_ADMIN_PIN = require('crypto').randomInt(100000, 1000000).toString();
process.env.ADMIN_PIN = TEST_ADMIN_PIN;
process.env.BOOKING_LIMIT_MAX = '500'; // v2.0.8: test run makes many booking calls
try { fs.unlinkSync(DATA); } catch (e) { /* ignore */ }

const { createApp } = require('../src/app');
const app = createApp();
const server = app.listen(PORT, async () => {
  let pass = 0, fail = 0;
  const results = [];
  function check(name, ok, extra) {
    if (ok) { pass++; results.push(`  PASS ${name}`); }
    else { fail++; results.push(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
  }
  // v2.0.8 — Terms acceptance is mandatory for booking creation.
  const TERMS = { acceptedTerms: true, termsVersion: '1.0' };
  async function call(method, p, body, token) {
    return new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } },
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch (e) { /* html */ } resolve({ status: res.statusCode, body: j, raw: b }); }); });
      req.on('error', (e) => resolve({ status: 0, body: {}, error: e.message }));
      if (data) req.write(data);
      req.end();
    });
  }
  try {
    // 1. bootstrap in FRONTEND shape
    let r = await call('GET', '/api/bootstrap');
    check('bootstrap services have id+price', r.status === 200 && Array.isArray(r.body.services) && r.body.services[0].id === 'standard' && r.body.services[0].price === 250, JSON.stringify(r.body).slice(0, 200));
    check('bootstrap tourist ids doctor/iv/dressing/nurse', Array.isArray(r.body.tourist) && r.body.tourist.some((t) => t.id === 'doctor' && t.usd === 55));
    check('bootstrap distanceTiers + mockMode', Array.isArray(r.body.distanceTiers) && r.body.mockMode === true);
    // v2.1.2 — languages + language-test info in bootstrap, /api/languages.
    check('bootstrap carries languages (7) + languageTest passMin 6', Array.isArray(r.body.languages) && r.body.languages.length === 7 && r.body.languageTest && r.body.languageTest.passMin === 6, JSON.stringify({ languages: (r.body.languages || []).length, languageTest: r.body.languageTest }));
    r = await call('GET', '/api/languages');
    check('GET /api/languages public -> 7 testable languages', r.status === 200 && Array.isArray(r.body.languages) && r.body.languages.length === 7 && r.body.languages.every((l) => l.testAvailable === true), JSON.stringify(r.body).slice(0, 200));
    r = await call('GET', '/api/terms');
    check('terms v1.0 carries the intermediary clause (AR + EN)', r.status === 200 && r.body.version === '1.0' && String(r.body.textAr || '').includes('وسيط تقني يربط بينهما') && String(r.body.textEn || '').includes('technical intermediary'), JSON.stringify({ version: r.body.version }));

    // 2. legacy OTP paths (frontend: /api/auth/otp/*), token alias
    r = await call('POST', '/api/auth/otp/request', { phone: '01012345678', channel: 'whatsapp' });
    check('legacy otp/request 200', r.status === 200, JSON.stringify(r.body));
    const mock = await call('GET', '/api/admin/mock-otp');
    // mock-otp needs admin auth; instead read code from server console is not possible — use demo phone flow below.
    r = await call('POST', '/api/auth/otp/request', { phone: '01000000001', channel: 'whatsapp' });
    check('demo phone otp request 200', r.status === 200);
    r = await call('POST', '/api/auth/otp/verify', { phone: '01000000001', code: '123456' });
    check('legacy otp/verify returns token alias', r.status === 200 && typeof r.body.token === 'string' && r.body.role === 'provider', JSON.stringify(r.body).slice(0, 200));
    const provToken = r.body.token;

    // 2b. phone-only login fallback (owner-authorized 24 Nov 2026: Meta OTP blocked)
    r = await call('POST', '/api/auth/login-phone', { phone: '01000000001', role: 'provider' });
    check('phone login demo provider -> 200 provider + token alias', r.status === 200 && typeof r.body.token === 'string' && r.body.role === 'provider' && r.body.providerId === 'prov_demo_starter', JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', '/api/auth/login-phone', { phone: '01012345678', role: 'provider' });
    check('unknown provider phone with role=provider -> 403', r.status === 403, JSON.stringify(r.body).slice(0, 150));
    r = await call('POST', '/api/auth/login-phone', { phone: '01099999999' });
    check('phone login new patient -> 200 patient', r.status === 200 && r.body.role === 'patient' && typeof r.body.token === 'string', JSON.stringify(r.body).slice(0, 150));
    const patTokenEarly = r.body.token; // bookings now require role patient
    const rlStatuses = [];
    for (let i = 0; i < 6; i++) {
      const rr = await call('POST', '/api/auth/login-phone', { phone: '01088888888' });
      rlStatuses.push(rr.status);
    }
    check('phone login rate limit: 5 ok then 429', rlStatuses.slice(0, 5).every((s) => s === 200) && rlStatuses[5] === 429, JSON.stringify(rlStatuses));

    // 3. patient OTP via legacy path
    await call('POST', '/api/auth/otp/request', { phone: '01099999999', channel: 'whatsapp' });
    // patient code is in mock log only; use the admin mock-otp endpoint after admin login below — instead verify demo patient flow via a fresh OTP request + reading data file
    const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    check('otp record stored hashed (no plaintext code in data)', !JSON.stringify(data.otps).includes('"code":'));

    // 4. admin login via legacy path + dashboard aggregate
    r = await call('POST', '/api/admin/login', { pin: TEST_ADMIN_PIN });
    check('legacy admin/login returns token', r.status === 200 && typeof r.body.token === 'string', JSON.stringify(r.body).slice(0, 150));
    const adminToken = r.body.token;
    r = await call('GET', '/api/admin/dashboard', null, adminToken);
    check('admin/dashboard aggregate', r.status === 200 && Array.isArray(r.body.providers) && Array.isArray(r.body.sosAlerts) && Array.isArray(r.body.auditLog), JSON.stringify(r.body).slice(0, 200));
    check('dashboard provider fields (licenceLast4, rating, visits)', r.body.providers[0] && 'licenceLast4' in r.body.providers[0] && 'rating' in r.body.providers[0]);
    r = await call('GET', '/api/admin/mock-otp?phone=01000000001', null, adminToken);
    check('mock-otp returns code for demo phone', r.status === 200 && r.body.code === '123456', JSON.stringify(r.body).slice(0, 200));

    // 5. interview v2.1.1: 36 questions (30 common + 6 role), new shape
    // {id, category, text, options:[{key, text}]}, dimensions + passRule,
    // no correct answers / red-flag markers leaked to the client.
    r = await call('GET', '/api/providers/interview/questions', null, provToken);
    check('GET interview/questions returns 36, 30min, dimensions, no leaks', r.status === 200 && Array.isArray(r.body.questions) && r.body.questions.length === 36 && r.body.minutes === 30 && Array.isArray(r.body.dimensions) && r.body.dimensions.length === 6 && r.body.passRule && !JSON.stringify(r.body).includes('correct') && !JSON.stringify(r.body).includes('redFlag'), JSON.stringify(r.body).slice(0, 300));
    check('interview dimensions total 8/7/6/6/5/4', r.body.dimensions && r.body.dimensions.find((d) => d.key === 'medical')?.questions === 8 && r.body.dimensions.find((d) => d.key === 'ethics')?.questions === 7 && r.body.dimensions.find((d) => d.key === 'safety')?.questions === 6, JSON.stringify(r.body.dimensions));
    // Answer correctly, using the server catalog (test-only): map each
    // returned question's correct option text to its shuffled index.
    const { MCQ, ENGLISH_CHECK } = require('../src/catalog');
    const answers = {};
    for (const q of r.body.questions) {
      const src = MCQ.find((x) => x.id === q.id);
      const correctText = src.options.find((o) => o.key === src.correct).text;
      answers[q.id] = q.options.findIndex((o) => o.text === correctText);
    }
    const enAnswers = {};
    for (const q of r.body.englishCheck.questions) {
      const src = ENGLISH_CHECK.find((x) => x.id === q.id);
      const correctText = src.options.find((o) => o.key === src.correct).text;
      enAnswers[q.id] = q.options.findIndex((o) => o.text === correctText);
    }
    r = await call('POST', '/api/providers/interview/submit', { answers, englishAnswers: enAnswers }, provToken);
    check('interview submit all-correct -> passed 36/36', r.status === 200 && r.body.status === 'passed' && r.body.total === 36 && typeof r.body.scores?.ethics === 'number', JSON.stringify(r.body).slice(0, 300));
    // Demo provider must be admin-verified before it can accept (v2.1.1
    // seed is pending/not_started; radar/accept require status=verified).
    r = await call('POST', '/api/admin/providers/prov_demo_starter/verify', { role: 'nurse' }, adminToken);
    check('admin verifies demo starter as nurse', r.status === 200 && r.body.status === 'verified', JSON.stringify(r.body).slice(0, 200));

    // 6. booking with FRONTEND-shaped payload (name/service/km/paymentMethod cash/charterAccepted)
    // v2.1.1: bookings require role 'patient' — the provider token is
    // rejected (403); the patient token from 2b is used.
    r = await call('POST', '/api/bookings', { ...TERMS,
      name: 'Test Patient', phone: '01099999999', service: 'standard', date: '2026-11-25', time: '10:00',
      address: 'Test St', km: 8, transportProvided: false, paymentMethod: 'cash', charterAccepted: true,
    }, provToken);
    check('provider-role booking -> 403 (patient role required)', r.status === 403, JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', '/api/bookings', { ...TERMS,
      name: 'Test Patient', phone: '01099999999', service: 'standard', date: '2026-11-25', time: '10:00',
      address: 'Test St', km: 8, transportProvided: false, paymentMethod: 'cash', charterAccepted: true,
    }, patTokenEarly);
    check('frontend-shaped booking 201, fee +100 at 8km', r.status === 201 && r.body.total === 350 && r.body.amountEgp === 350, JSON.stringify(r.body).slice(0, 300));
    check('v2.0.1 booking shows canCancel + arrival progress', r.body.canCancel === true && r.body.arrival && typeof r.body.arrival.progressPct === 'number', JSON.stringify(r.body).slice(0, 200));
    const bkId = r.body.id;
    check('booking has service/total aliases', r.body.service === 'standard' && r.body.total === 350);

    // assistant band mapping
    r = await call('POST', '/api/bookings', { ...TERMS,
      name: 'Test Patient', service: 'asst_5_9', km: 2, paymentMethod: 'instapay', charterAccepted: true,
    }, patTokenEarly);
    check('assistant band asst_5_9 -> 235 EGP', r.status === 201 && r.body.total === 235, JSON.stringify(r.body).slice(0, 200));

    // postop via /bookings with frontend postop payload: v2.1.1 — no
    // distanceKm and no hotel -> 400 distance_required (no silent 0 km).
    r = await call('POST', '/api/bookings', { ...TERMS, name: 'Postop', service: 'postop', operation: 'Appendectomy', paymentMethod: 'cash', charterAccepted: true }, patTokenEarly);
    check('postop via bookings without km -> 400 distance_required', r.status === 400 && r.body.error === 'distance_required', JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', '/api/bookings', { ...TERMS, name: 'Postop', service: 'postop', operation: 'Appendectomy', paymentMethod: 'cash', charterAccepted: true, distanceKm: 2 }, patTokenEarly);
    check('postop via bookings with km 2 -> 201, 1400', r.status === 201 && r.body.total === 1400, JSON.stringify(r.body).slice(0, 200));

    // 7. legacy confirm paths
    r = await call('POST', `/api/bookings/${bkId}/cancel`, {}, provToken);
    check('v2.0.1 cancel requires patient role -> 403 for provider', r.status === 403, `got ${r.status}`);
    r = await call('POST', `/api/bookings/${bkId}/accept`, {}, provToken);
    check('provider accept (interview passed + admin verified)', r.status === 200, JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', `/api/bookings/${bkId}/vitals`, { bpSystolic: 120, bpDiastolic: 80, pulse: 72, glucose: 110, oxygen: 98, temp: 36.6 }, provToken);
    check('vitals recorded', r.status === 200, JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', `/api/bookings/${bkId}/provider-complete`, {}, provToken);
    check('legacy provider-complete works', r.status === 200 && r.body.status === 'provider_confirmed', JSON.stringify(r.body).slice(0, 200));

    // patient confirm via legacy path needs a patient token for the booking phone; booking was created by provider token (phone 01000000001) so patientPhone = that phone; role is provider, confirm-patient requires role patient -> expect 403. Use a patient token instead: request OTP for 01055555555 and read the code from the mock provider console is not possible; instead verify the route exists by checking the 401/403 behaviour.
    r = await call('POST', `/api/bookings/${bkId}/patient-confirm`, {}, provToken);
    check('legacy patient-confirm route exists (403 for provider role)', r.status === 403, `got ${r.status}`);

    // 8. safety report with frontend {text}
    r = await call('POST', `/api/bookings/${bkId}/safety-report`, { text: 'test safety' }, provToken);
    check('safety-report accepts {text}', r.status === 201, JSON.stringify(r.body).slice(0, 200));

    // 9. phone-only access still rejected
    r = await call('GET', '/api/bookings/mine');
    check('bookings/mine without token -> 401', r.status === 401);

    // 10. v2.0.9: reversed commissions + volume bonus thresholds + voucher expiry
    // (in-process: seed released bookings / vouchers directly into the
    // shared store — the smoke test already drives the same logic over
    // HTTP end-to-end for the 30-case threshold.)
    const { store } = require('../src/store');
    const seedNow = new Date().toISOString();
    function seedReleased(n, prefix) {
      for (let i = 0; i < n; i++) {
        const id = `${prefix}${i}`;
        store.data.bookings[id] = {
          id, kind: 'standard', patientPhone: '01099999999', patientName: 'Seed Patient',
          serviceCode: 'standard', serviceName: 'Standard visit', status: 'released',
          amountEgp: 250, baseEgp: 250, distanceFeeEgp: 0,
          providerId: 'prov_demo_starter', commissionPct: 15,
          providerShareEgp: 212, appShareEgp: 38,
          releasedAt: seedNow, createdAt: seedNow, acceptedAt: seedNow,
          complaintDeadline: null, complaintStatus: null, circumventionHold: false,
          cashCollectedByProvider: false, voucherDiscountEgp: 0,
        };
      }
    }
    r = await call('GET', '/api/terms');
    check('terms v1.0 carries reversed rates 15/12/8, no 1,200 bonus', r.status === 200 && r.body.version === '1.0' && r.body.textAr.includes('Starter 15%') && r.body.textAr.includes('Elite 8%') && !r.body.textAr.includes('1,200 جنيه'), JSON.stringify(r.body).slice(0, 200));
    r = await call('GET', '/api/bootstrap');
    check('bootstrap has promo field, inactive', r.status === 200 && r.body.promo && r.body.promo.active === false, JSON.stringify(r.body.promo));
    // Volume bonus v2.1.1 thresholds 15/30/60 (highest only).
    // 30 cases -> 1,000, title Golden Nurse, next 60.
    seedReleased(30, 'seed30-');
    r = await call('GET', '/api/providers/wallet', null, provToken);
    check('30 cases -> bonus 1000, title الممرض الذهبي, next 60', r.status === 200 && r.body.monthlyCases === 30 && r.body.volumeBonusEgp === 1000 && r.body.volumeBonus.title === 'الممرض الذهبي' && r.body.volumeBonus.nextBonusAt === 60 && r.body.volumeBonus.casesToNextBonus === 30, JSON.stringify(r.body.volumeBonus));
    check('wallet totals: 30x212 + 1000 bonus = 7360 owed', r.body.totals.volumeBonusEgp === 1000 && r.body.totals.appOwesProviderEgp === 7360, JSON.stringify(r.body.totals));
    // 60 cases -> 1,500 (highest only), title Star, no next tier.
    seedReleased(30, 'seed60-');
    r = await call('GET', '/api/providers/wallet', null, provToken);
    check('60 cases -> bonus 1500, title النجم المميز, no next', r.status === 200 && r.body.monthlyCases === 60 && r.body.volumeBonusEgp === 1500 && r.body.volumeBonus.title === 'النجم المميز' && r.body.volumeBonus.nextBonusAt === null && r.body.volumeBonus.casesToNextBonus === null, JSON.stringify(r.body.volumeBonus));
    check('wallet totals: 60x212 + 1500 bonus = 14220 owed', r.body.totals.volumeBonusEgp === 1500 && r.body.totals.appOwesProviderEgp === 14220, JSON.stringify(r.body.totals));
    // 100 cases -> still 1,500 (highest only, NOT stacked), title Star.
    seedReleased(40, 'seed100-');
    r = await call('GET', '/api/providers/wallet', null, provToken);
    check('100 cases -> bonus 1500 (highest only), title النجم المميز, no next', r.status === 200 && r.body.monthlyCases === 100 && r.body.volumeBonusEgp === 1500 && r.body.volumeBonus.title === 'النجم المميز' && r.body.volumeBonus.nextBonusAt === null && r.body.volumeBonus.casesToNextBonus === null, JSON.stringify(r.body.volumeBonus));
    check('wallet totals: 100x212 + 1500 bonus = 22700 owed', r.body.totals.volumeBonusEgp === 1500 && r.body.totals.appOwesProviderEgp === 22700, JSON.stringify(r.body.totals));
    // Voucher expiry: an expired voucher is not listed as active and is
    // never applied at booking; an active one applies.
    const patToken = patTokenEarly;
    check('patient token (from 2b) reused for voucher checks', !!patToken);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    store.data.vouchers.push({ id: 'vou-expired', patientPhone: '01099999999', amountEgp: 50, issuedAt: past, expiresAt: past, minBookingEgp: 300, status: 'active', sourceBookingId: null, usedBookingId: null, usedAt: null });
    r = await call('GET', '/api/me/vouchers', null, patToken);
    check('expired voucher is expired on read, not active', r.status === 200 && r.body.vouchers.length === 0 && r.body.expiredCount === 1, JSON.stringify(r.body));
    r = await call('POST', '/api/bookings', { ...TERMS,
      patientName: 'Expiry Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 8, respectCharterAccepted: true, triage: { dangerSigns: [] },
    }, patToken);
    check('expired voucher never applies at booking', r.status === 201 && r.body.amountEgp === 350 && r.body.amountPayableEgp === 350 && r.body.voucherId == null, JSON.stringify(r.body).slice(0, 200));
    store.data.vouchers.push({ id: 'vou-active', patientPhone: '01099999999', amountEgp: 50, issuedAt: new Date().toISOString(), expiresAt: future, minBookingEgp: 300, status: 'active', sourceBookingId: null, usedBookingId: null, usedAt: null });
    r = await call('POST', '/api/bookings', { ...TERMS,
      patientName: 'Expiry Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 8, respectCharterAccepted: true, triage: { dangerSigns: [] },
    }, patToken);
    check('active voucher applies at booking (payable 300)', r.status === 201 && r.body.amountEgp === 350 && r.body.amountPayableEgp === 300 && r.body.voucherId === 'vou-active', JSON.stringify(r.body).slice(0, 200));

    // 11. v2.1.3: monthly packages — full lifecycle with a fast-forwarded
    // month (in-process store: the 26+4 days are logged by the test, then
    // the real HTTP endpoints complete / confirm / review / release).
    const pkgToday = new Date().toISOString().slice(0, 10);
    const pkgDay = (i) => new Date(new Date(pkgToday + 'T00:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10);
    r = await call('POST', '/api/package-requests', { ...TERMS,
      patientName: 'Package Patient', packageType: 'package_technician_12',
      condition: 'After hip surgery', conditionItems: ['post_surgery'],
      diagnosis: 'Post hip replacement', treatment: 'Painkillers',
      needs: ['mobility', 'wound_care'], startDate: pkgToday,
      address: 'Quseir, Corniche St 12', distanceKm: 3, notes: '',
    }, patTokenEarly);
    check('integration package request -> 201', r.status === 201 && !!r.body.id, JSON.stringify(r.body).slice(0, 200));
    const intPkr = r.body.id;
    r = await call('POST', `/api/admin/package-requests/${intPkr}/quote`, { finalPriceEgp: 12600, providerId: 'prov_demo_starter', extraDaysOption: 'overtime' }, adminToken);
    check('integration quote overtime -> total 15360', r.status === 200 && r.body.quote?.totalEgp === 15360, JSON.stringify(r.body.quote));
    r = await call('POST', `/api/package-requests/${intPkr}/accept`, { ...TERMS, paymentMethod: 'cash_receipt' }, patTokenEarly);
    check('integration accept cash -> 201, total 15360, commission locked from tier', r.status === 201 && typeof r.body.commissionPct === 'number' && r.body.amountEgp === 15360, JSON.stringify(r.body).slice(0, 300));
    const intPkg = r.body.id;
    // Expected shares, computed from the LOCKED commission (the demo
    // provider's tier drifts by §11 — points auto-promotion — so the
    // test never hardcodes 15%). Regular days: 25x485 + 475 remainder
    // day; extra days: 4x690.
    const pct1 = r.body.commissionPct;
    const dayApp1 = (rate) => Math.round(rate * pct1 / 100);
    const regApp1 = 25 * dayApp1(485) + dayApp1(475);
    const regProv1 = 25 * (485 - dayApp1(485)) + (475 - dayApp1(475));
    const expProv1 = regProv1 + 4 * (690 - dayApp1(690));
    const expApp1 = regApp1 + 4 * dayApp1(690);
    // Fast-forward: 26 regular days (25x485 + 475 remainder day) + 4
    // overtime extra days (4x690), all unreleased — as if the month ran.
    const intBk = store.data.bookings[intPkg];
    for (let i = 0; i < 26; i++) {
      intBk.daysLog.push({ date: pkgDay(i), type: 'regular', providerId: 'prov_demo_starter', rateEgp: i < 25 ? 485 : 475, loggedAt: seedNow, released: false, releasedAt: null, weekKey: null });
    }
    for (let i = 0; i < 4; i++) {
      intBk.daysLog.push({ date: pkgDay(26 + i), type: 'extra', providerId: 'prov_demo_starter', rateEgp: 690, loggedAt: seedNow, released: false, releasedAt: null, weekKey: null });
    }
    intBk.daysCompleted = 26;
    intBk.extraDaysCompleted = 4;
    store.save();
    r = await call('POST', `/api/bookings/${intPkg}/package-complete`, {}, provToken);
    check('package-complete with 26+4 days -> provider_confirmed, no partial refund', r.status === 200 && r.body.status === 'provider_confirmed' && (r.body.partialRefundEgp || 0) === 0, JSON.stringify(r.body).slice(0, 300));
    r = await call('POST', `/api/bookings/${intPkg}/confirm-patient`, {}, patTokenEarly);
    check('patient confirms package -> patient_confirmed', r.status === 200 && r.body.status === 'patient_confirmed', JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', `/api/bookings/${intPkg}/review`, { rating: 5, comment: 'Excellent month of care.', circumventionReported: false }, patTokenEarly);
    check('review releases the package -> released, shares match locked commission (exact)', r.status === 200 && r.body.status === 'released' && r.body.providerShareEgp === expProv1 && r.body.appShareEgp === expApp1, JSON.stringify({ status: r.body.status, providerShareEgp: r.body.providerShareEgp, appShareEgp: r.body.appShareEgp }));
    r = await call('GET', '/api/providers/wallet', null, provToken);
    const intLines = (r.body.ledger || []).filter((l) => l.bookingId === intPkg);
    check('wallet: final package-day line (30 days) held for the 24h complaint window', intLines.some((l) => l.kind === 'package-day' && l.days === 30 && l.finalRelease === true && l.direction === 'complaint_hold' && l.amountEgp === expApp1), JSON.stringify(intLines));
    // Sweep -> Thursday settlement record. NOTE: no settlement assertion
    // here — generateSettlements SKIPS demo providers by design, and
    // prov_demo_starter is a demo seed. The settlement inclusion of
    // package days is asserted in the smoke test (§23g) on the non-demo
    // substitute provider instead.
    r = await call('POST', '/api/jobs/sweep', {}, adminToken);
    check('sweep -> 200', r.status === 200, JSON.stringify(r.body).slice(0, 200));
    // Complaint on package 1, rejected -> the held final line becomes settleable.
    r = await call('POST', `/api/bookings/${intPkg}/safety-report`, { type: 'complaint', description: 'Checking the hold.' }, patTokenEarly);
    check('complaint on released package -> 201', r.status === 201 && !!r.body.reportId, JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', `/api/admin/complaints/${r.body.reportId}/resolve`, { decision: 'rejected' }, adminToken);
    check('complaint rejected -> complaintStatus rejected', r.status === 200 && r.body.booking?.complaintStatus === 'rejected', JSON.stringify(r.body).slice(0, 200));
    r = await call('GET', '/api/providers/wallet', null, provToken);
    const intLines2 = (r.body.ledger || []).filter((l) => l.bookingId === intPkg);
    check('after rejection: final package-day line provider_owes_app (cash, settleable)', intLines2.some((l) => l.kind === 'package-day' && l.direction === 'provider_owes_app' && l.amountEgp === expApp1), JSON.stringify(intLines2));
    // Complaint refund on a package with UNWORKED extra days: only the
    // unreleased remainder is refunded (terms §12).
    r = await call('POST', '/api/package-requests', { ...TERMS,
      patientName: 'Package Patient 2', packageType: 'package_technician_12',
      condition: 'Elderly care', conditionItems: ['elderly'],
      diagnosis: 'Old age, needs care', treatment: '—',
      needs: ['elderly_care'], startDate: pkgToday,
      address: 'Quseir, Corniche St 12', distanceKm: 3, notes: '',
    }, patTokenEarly);
    const intPkr2 = r.body.id;
    r = await call('POST', `/api/admin/package-requests/${intPkr2}/quote`, { finalPriceEgp: 12600, providerId: 'prov_demo_starter', extraDaysOption: 'overtime' }, adminToken);
    r = await call('POST', `/api/package-requests/${intPkr2}/accept`, { ...TERMS, paymentMethod: 'cash_receipt' }, patTokenEarly);
    const intPkg2 = r.body.id;
    const pct2 = r.body.commissionPct;
    const dayApp2 = (rate) => Math.round(rate * pct2 / 100);
    const regApp2 = 25 * dayApp2(485) + dayApp2(475);
    const regProv2 = 25 * (485 - dayApp2(485)) + (475 - dayApp2(475));
    const expProv2 = regProv2 + 2 * (690 - dayApp2(690)); // same 26 regular days, only 2 extra days worked
    const expApp2 = regApp2 + 2 * dayApp2(690);
    const intBk2 = store.data.bookings[intPkg2];
    for (let i = 0; i < 26; i++) {
      intBk2.daysLog.push({ date: pkgDay(i), type: 'regular', providerId: 'prov_demo_starter', rateEgp: i < 25 ? 485 : 475, loggedAt: seedNow, released: false, releasedAt: null, weekKey: null });
    }
    for (let i = 0; i < 2; i++) {
      intBk2.daysLog.push({ date: pkgDay(26 + i), type: 'extra', providerId: 'prov_demo_starter', rateEgp: 690, loggedAt: seedNow, released: false, releasedAt: null, weekKey: null });
    }
    intBk2.daysCompleted = 26;
    intBk2.extraDaysCompleted = 2;
    store.save();
    r = await call('POST', `/api/bookings/${intPkg2}/package-complete`, {}, provToken);
    check('package-complete with 2 unworked extra days -> partialRefund 1380', r.status === 200 && r.body.partialRefundEgp === 1380, JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', `/api/bookings/${intPkg2}/confirm-patient`, {}, patTokenEarly);
    r = await call('POST', `/api/bookings/${intPkg2}/review`, { rating: 4, comment: 'Good.', circumventionReported: false }, patTokenEarly);
    check('second package released: shares match locked commission (13980 released)', r.status === 200 && r.body.status === 'released' && r.body.providerShareEgp === expProv2 && r.body.appShareEgp === expApp2, JSON.stringify({ status: r.body.status, providerShareEgp: r.body.providerShareEgp, appShareEgp: r.body.appShareEgp }));
    r = await call('POST', `/api/bookings/${intPkg2}/safety-report`, { type: 'complaint', description: 'Two extra days were paid but never worked.' }, patTokenEarly);
    check('complaint filed on second package -> 201', r.status === 201 && !!r.body.reportId, JSON.stringify(r.body).slice(0, 200));
    const intComplaint2 = r.body.reportId;
    r = await call('POST', `/api/admin/complaints/${intComplaint2}/resolve`, { decision: 'accepted_refund' }, adminToken);
    check('complaint accepted -> refund 1380 only (unreleased remainder), released shares stay', r.status === 200 && r.body.booking?.refundEgp === 1380 && r.body.booking?.providerShareEgp === expProv2 && r.body.booking?.appShareEgp === expApp2, JSON.stringify(r.body.booking)?.slice(0, 300));
    // Tourist package full cycle (USD, technician 12h, no extra days).
    // The demo starter passed the interview but never took the in-app
    // English test, so it has no badge and is NOT tourist-compatible.
    r = await call('POST', '/api/package-requests', { ...TERMS,
      patientName: 'Tourist Patient', packageType: 'package_tourist_technician_12', currency: 'USD',
      condition: 'Post-surgery recovery', conditionItems: ['post_surgery'],
      diagnosis: 'Post hip replacement', treatment: 'Painkillers',
      needs: ['mobility', 'wound_care'], startDate: pkgToday,
      address: 'Movenpick Resort, El Quseir', distanceKm: 3, notes: '',
    }, patTokenEarly);
    check('integration tourist package request -> 201, USD, level technician', r.status === 201 && r.body.currency === 'USD' && r.body.level === 'technician', JSON.stringify(r.body).slice(0, 200));
    const intPkrT = r.body.id;
    r = await call('POST', `/api/admin/package-requests/${intPkrT}/quote`, { finalPrice: 800, providerId: 'prov_demo_starter', extraDaysOption: 'none' }, adminToken);
    check('tourist quote without the English badge -> 409 tourist gate', r.status === 409 && JSON.stringify(r.body).includes('tourist-compatible'), JSON.stringify(r.body).slice(0, 200));
    // Take the in-app English test (answers from the server catalog,
    // test-only — the API never leaks them) and pass 8/8.
    const { LANGUAGE_TESTS } = require('../src/catalog');
    const ltSt = await call('POST', '/api/me/language-tests/en/start', null, provToken);
    const ltAns = {};
    for (const q of ltSt.body.questions || []) ltAns[q.id] = LANGUAGE_TESTS.en.find((x) => x.id === q.id)?.correct;
    r = await call('POST', '/api/me/language-tests/en/submit', { attemptId: ltSt.body.attemptId, answers: ltAns }, provToken);
    check('English test all-correct -> passed 8/8, badge earned', r.status === 200 && r.body.passed === true && r.body.score === 8, JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', `/api/admin/package-requests/${intPkrT}/quote`, { finalPrice: 800, providerId: 'prov_demo_starter', extraDaysOption: 'none' }, adminToken);
    check('tourist quote after the badge -> 200, 800 USD = 38400 EGP', r.status === 200 && r.body.quote?.total === 800 && r.body.quote?.totalEgp === 38400 && r.body.quote?.currency === 'USD', JSON.stringify(r.body.quote));
    r = await call('POST', `/api/package-requests/${intPkrT}/accept`, { ...TERMS, paymentMethod: 'cash_receipt' }, patTokenEarly);
    check('accept tourist quote -> 201, USD, amountForeign 800, amountEgp 38400, dailyRate 31 / 1477', r.status === 201 && r.body.currency === 'USD' && r.body.amountForeign === 800 && r.body.amountEgp === 38400 && r.body.dailyRate === 31 && r.body.dailyRateEgp === 1477, JSON.stringify(r.body).slice(0, 300));
    const intPkgT = r.body.id;
    const pctT = r.body.commissionPct;
    const dayAppT = (rate) => Math.round(rate * pctT / 100);
    const expAppT = 25 * dayAppT(1477) + dayAppT(1475);
    const expProvT = 25 * (1477 - dayAppT(1477)) + (1475 - dayAppT(1475));
    // Fast-forward: 26 regular days (25x1477 + 1475 remainder day EGP;
    // 25x31 + 25 remainder day USD), all unreleased.
    const intBkT = store.data.bookings[intPkgT];
    for (let i = 0; i < 26; i++) {
      intBkT.daysLog.push({ date: pkgDay(i), type: 'regular', providerId: 'prov_demo_starter', rateEgp: i < 25 ? 1477 : 1475, rate: i < 25 ? 31 : 25, currency: 'USD', loggedAt: seedNow, released: false, releasedAt: null, weekKey: null });
    }
    intBkT.daysCompleted = 26;
    intBkT.extraDaysCompleted = 0;
    store.save();
    r = await call('POST', `/api/bookings/${intPkgT}/package-complete`, {}, provToken);
    check('tourist package-complete -> provider_confirmed, no partial refund', r.status === 200 && r.body.status === 'provider_confirmed' && (r.body.partialRefundEgp || 0) === 0, JSON.stringify(r.body).slice(0, 300));
    r = await call('POST', `/api/bookings/${intPkgT}/confirm-patient`, {}, patTokenEarly);
    r = await call('POST', `/api/bookings/${intPkgT}/review`, { rating: 5, comment: 'Great month.', circumventionReported: false }, patTokenEarly);
    check('tourist package released: shares match locked commission (38400 EGP)', r.status === 200 && r.body.status === 'released' && r.body.providerShareEgp === expProvT && r.body.appShareEgp === expAppT, JSON.stringify({ status: r.body.status, providerShareEgp: r.body.providerShareEgp, appShareEgp: r.body.appShareEgp }));
    r = await call('GET', '/api/providers/wallet', null, provToken);
    const intLinesT = (r.body.ledger || []).filter((l) => l.bookingId === intPkgT);
    check('wallet: tourist final package-day line (26 days) held for the 24h complaint window', intLinesT.some((l) => l.kind === 'package-day' && l.days === 26 && l.finalRelease === true && l.direction === 'complaint_hold' && l.amountEgp === expAppT), JSON.stringify(intLinesT));
  } catch (e) {
    fail++;
    results.push(`  FAIL exception: ${e && e.stack || e}`);
  }
  console.log(results.join('\n'));
  console.log(`\n==== INTEGRATION (frontend contract): ${pass} passed, ${fail} failed ====`);
  server.close(() => { try { fs.unlinkSync(DATA); } catch (e) { /* ignore */ } process.exit(fail ? 1 : 0); });
});
