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
    check('terms v1.0 carries reversed rates 15/12/8, no 1,200 bonus', r.status === 200 && r.body.version === '1.0' && r.body.textAr.includes('Starter 15%') && r.body.textAr.includes('Elite 8%') && !r.body.textAr.includes('1,200'), JSON.stringify(r.body).slice(0, 200));
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
  } catch (e) {
    fail++;
    results.push(`  FAIL exception: ${e && e.stack || e}`);
  }
  console.log(results.join('\n'));
  console.log(`\n==== INTEGRATION (frontend contract): ${pass} passed, ${fail} failed ====`);
  server.close(() => { try { fs.unlinkSync(DATA); } catch (e) { /* ignore */ } process.exit(fail ? 1 : 0); });
});
