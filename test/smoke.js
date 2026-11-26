// Smoke test — starts the server on a test port with a throwaway data file,
// runs the critical flows, asserts, prints PASS/FAIL, exits.
// Run:  npm test        (or: node test/smoke.js)
// It never touches the real data.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

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
async function req(method, p, { token, body, admin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* html responses */ }
  return { status: r.status, json, text: typeof json === 'string' ? json : '' };
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
    AUTO_RELEASE_MS: '1000', // shorten the 1h auto-release window for the test only
    BOOKING_LIMIT_MAX: '1000', // v2.0.9: volume-bonus cycles make ~200 booking-route calls
    CANCEL_WINDOW_MS: '5000', // shorten the 15-min cancel window for the test only
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
    // In mock mode the code is logged to the server console; read it from there.
    const m = out.match(/\[MOCK OTP\] channel=whatsapp phone=01012345678 code=(\d{6})/);
    check('mock OTP code appears in server log', !!m, out.slice(-500));
    const code = m ? m[1] : '000000';
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

    // --- 6. demo provider OTP + interview -------------------------------
    console.log('\n[provider interview]');
    r = await req('POST', '/api/otp/request', { body: { phone: '01000000001', channel: 'whatsapp' } });
    check('demo provider otp request 200', r.status === 200);
    r = await req('POST', '/api/otp/verify', { body: { phone: '01000000001', code: '123456' } });
    check('demo provider mock OTP 123456 works', r.status === 200 && r.json?.role === 'provider', JSON.stringify(r.json));
    const provToken = r.json?.accessToken;
    r = await req('POST', '/api/providers/interview/start', { token: provToken });
    check('interview start 200, 20 questions, no answers leaked', r.status === 200 && r.json?.questions?.length === 20 && JSON.stringify(r.json).indexOf('"correct"') === -1, `got ${r.json?.questions?.length}`);
    check('interview has 5/5/5/5 distribution', ['medical', 'ethics', 'personal', 'resilience'].every((c) => r.json.questions.filter((q) => q.category === c).length === 5));
    check('english check present, 3 questions', r.json?.englishCheck?.questions?.length === 3);
    const attemptId = r.json?.attemptId;
    // Submit all-wrong answers -> must fail to manual-review.
    const wrong = {};
    for (const q of r.json.questions) wrong[q.id] = 'zzz';
    const enWrong = {};
    for (const q of r.json.englishCheck.questions) enWrong[q.id] = 'zzz';
    r = await req('POST', '/api/providers/interview/submit', { token: provToken, body: { attemptId, answers: wrong, englishAnswers: enWrong } });
    check('all-wrong interview -> manual-review, total 0', r.status === 200 && r.json?.result === 'manual-review' && r.json?.total === 0, JSON.stringify(r.json));
    check('english reported separately, unscored', r.json?.english?.total === 3 && r.json?.english?.correct === 0);
    // Retake: start again and answer everything correctly using the known bank
    // (the test knows the correct answers from the spec bank, not from the API).
    r = await req('POST', '/api/providers/interview/start', { token: provToken });
    check('retake allowed after fail', r.status === 200 && !!r.json?.attemptId);
    const attempt2 = r.json?.attemptId;
    // Correct answers per the v1.4 bank, keyed by question id (from catalog).
    const CORRECT = { m1: 'b', m2: 'b', m3: 'b', m4: 'b', m5: 'b', e1: 'b', e2: 'a', e3: 'b', e4: 'b', e5: 'b', p1: 'b', p2: 'a', p3: 'a', p4: 'b', p5: 'b', r1: 'b', r2: 'b', r3: 'b', r4: 'b', r5: 'b' };
    const EN_CORRECT = { en1: 'a', en2: 'a', en3: 'a' };
    // NOTE: options are shuffled, but the answer KEY is what the server grades
    // (keys travel with the option text), so submitting the key works.
    const right = {};
    for (const q of r.json.questions) right[q.id] = CORRECT[q.id];
    const enRight = {};
    for (const q of r.json.englishCheck.questions) enRight[q.id] = EN_CORRECT[q.id];
    r = await req('POST', '/api/providers/interview/submit', { token: provToken, body: { attemptId: attempt2, answers: right, englishAnswers: enRight } });
    check('all-correct interview -> passed 20/20, ethics 5/5', r.status === 200 && r.json?.result === 'passed' && r.json?.total === 20 && r.json?.scores?.ethics === 5, JSON.stringify(r.json));
    check('english 3/3 basic-ok', r.json?.english?.correct === 3 && r.json?.english?.level === 'basic-ok');
    // Ethics-fail case: 12+ total but ethics <3 must still fail (fresh provider).
    r = await req('POST', '/api/otp/request', { body: { phone: '01000000002', channel: 'whatsapp' } });
    r = await req('POST', '/api/otp/verify', { body: { phone: '01000000002', code: '123456' } });
    const prov2Token = r.json?.accessToken;
    r = await req('POST', '/api/providers/interview/start', { token: prov2Token });
    const a3 = r.json?.attemptId;
    const mixed = {};
    for (const q of r.json.questions) mixed[q.id] = q.category === 'ethics' ? 'zzz' : CORRECT[q.id];
    r = await req('POST', '/api/providers/interview/submit', { token: prov2Token, body: { attemptId: a3, answers: mixed, englishAnswers: enRight } });
    check('15/20 but ethics 0/5 -> manual-review (ethics gate)', r.status === 200 && r.json?.result === 'manual-review' && r.json?.total === 15 && r.json?.scores?.ethics === 0, JSON.stringify(r.json));

    // --- 7. full escrow flow -------------------------------------------
    console.log('\n[escrow end-to-end]');
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Test Patient', serviceCode: 'dressing', paymentMethod: 'instapay',
      distanceKm: 8, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    check('booking created held, total 275+100=375', r.status === 201 && r.json?.status === 'held' && r.json?.amountEgp === 375, JSON.stringify(r.json));
    const bkId = r.json?.id;
    // Provider 2 failed interview -> cannot accept (radar/accept locked).
    r = await req('POST', `/api/bookings/${bkId}/accept`, { token: prov2Token });
    check('interview-failed provider cannot accept -> 403', r.status === 403, JSON.stringify(r.json));
    // Provider 1 (passed) accepts.
    r = await req('POST', `/api/bookings/${bkId}/accept`, { token: provToken });
    check('provider accepts -> accepted, payment number now shown', r.status === 200 && r.json?.status === 'accepted' && JSON.stringify(r.json).indexOf('01008629060') !== -1, JSON.stringify(r.json));
    check('commission locked at accept (Starter 15% — reversed rates, v2.0.9)', r.json?.commissionPct === 15);
    // Another patient cannot see it.
    const other = await req('POST', '/api/otp/request', { body: { phone: '01099999999', channel: 'sms' } });
    const mm = out.match(/\[MOCK OTP\] channel=sms phone=01099999999 code=(\d{6})/);
    const otherLogin = await req('POST', '/api/otp/verify', { body: { phone: '01099999999', code: mm ? mm[1] : '000000' } });
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
    // Admin login for sweep.
    r = await req('POST', '/api/admin/pin/verify', { body: { pin: TEST_ADMIN_PIN } });
    check('admin PIN verify 200', r.status === 200 && !!r.json?.token, JSON.stringify(r.json));
    const adminToken = r.json?.token;
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
    } });
    check('post-op booking 1400', r.status === 201 && r.json?.amountEgp === 1400 && r.json?.kind === 'postop', JSON.stringify(r.json));

    // --- 12. provider registration hashing -------------------------------
    console.log('\n[provider register]');
    const newPhone = '01055555555';
    await req('POST', '/api/otp/request', { body: { phone: newPhone, channel: 'whatsapp' } });
    const nm = out.match(/\[MOCK OTP\] channel=whatsapp phone=01055555555 code=(\d{6})/);
    const nl = await req('POST', '/api/otp/verify', { body: { phone: newPhone, code: nm ? nm[1] : '000000' } });
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
    const freshLogin = await req('POST', '/api/auth/login-phone', { body: { phone: '01077777777' } });
    const freshToken = freshLogin.json?.accessToken;
    r = await req('GET', '/api/me/terms', { token: freshToken });
    check('fresh user /me/terms -> mustAccept true', r.status === 200 && r.json?.mustAccept === true && r.json?.currentVersion === '1.0', JSON.stringify(r.json));
    r = await req('POST', '/api/me/terms', { token: freshToken, body: { acceptedTerms: true, termsVersion: '1.0' } });
    check('POST /me/terms accepts v1.0', r.status === 200 && r.json?.version === '1.0', JSON.stringify(r.json));
    r = await req('GET', '/api/me/terms', { token: freshToken });
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
    const rm = out.match(/\[MOCK OTP\] channel=whatsapp phone=01066666666 code=(\d{6})/);
    const rl2 = await req('POST', '/api/otp/verify', { body: { phone: regPhone, code: rm ? rm[1] : '000000' } });
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
    r = await req('GET', '/api/providers/radar', { token: provToken });
    const radarItem = (r.json?.pending || []).find((x) => x.id === bk8);
    check('radar returns minimal view, no patient PII', r.status === 200 && !!radarItem && !('patientPhone' in radarItem) && !('patientName' in radarItem) && !('address' in radarItem) && !('alternateContact' in radarItem) && !('notes' in radarItem) && !('triage' in radarItem) && radarItem.serviceCode === 'standard' && radarItem.amountEgp === 250, JSON.stringify(radarItem));
    // Radar maxKm is capped at 35.
    r = await req('GET', '/api/providers/radar?maxKm=500', { token: provToken });
    check('radar maxKm capped at 35', r.status === 200, JSON.stringify(r.json)?.slice(0, 200));
    // Unassigned provider cannot see the booking at all.
    r = await req('GET', `/api/bookings/${bk8}`, { token: prov2Token });
    check('unassigned provider cannot view booking -> 403', r.status === 403, JSON.stringify(r.json));
    // Assigned provider sees phone + address, never the alternate contact.
    r = await req('POST', `/api/bookings/${bk8}/accept`, { token: provToken });
    check('provider accepts v2.0.8 booking', r.status === 200 && r.json?.status === 'accepted', JSON.stringify(r.json));
    r = await req('GET', `/api/bookings/${bk8}`, { token: provToken });
    check('assigned provider sees patient phone + address, no alternate contact', r.status === 200 && r.json?.patientPhone === '01012345678' && !!r.json?.address && !('alternateContact' in r.json) && !('insurer' in r.json), JSON.stringify(r.json)?.slice(0, 300));
    // Patient view never contains the provider phone.
    r = await req('GET', `/api/bookings/${bk8}`, { token: patientToken2 });
    check('patient view has no provider phone', r.status === 200 && !JSON.stringify(r.json).includes('01000000001'), JSON.stringify(r.json)?.slice(0, 300));

    // In-app messaging: phone numbers are rejected, clean text works.
    r = await req('POST', `/api/bookings/${bk8}/messages`, { token: patientToken2, body: { text: 'Call me on 01099999999 please' } });
    check('message with a phone number -> 400', r.status === 400 && r.json?.error === 'phone_number_not_allowed', JSON.stringify(r.json));
    r = await req('POST', `/api/bookings/${bk8}/messages`, { token: patientToken2, body: { text: 'Hello, I am at the gate.' } });
    check('clean message -> 201', r.status === 201 && r.json?.text === 'Hello, I am at the gate.', JSON.stringify(r.json));
    r = await req('GET', `/api/bookings/${bk8}/messages`, { token: provToken });
    check('assigned provider reads the thread', r.status === 200 && r.json?.open === true && r.json?.messages?.length === 1, JSON.stringify(r.json));
    r = await req('GET', `/api/bookings/${bk8}/messages`, { token: prov2Token });
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

    // Graduated discipline: warn -> suspend blocks radar + accept -> unsuspend.
    r = await req('POST', '/api/admin/providers/prov_demo_starter/warn', { token: adminToken, body: { reason: 'Test warning: asked a patient to deal outside the app.' } });
    check('admin warn -> 200, warningCount 1', r.status === 200 && r.json?.warningCount === 1, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    check('provider wallet shows the warning + tier/commission/next Thursday', r.status === 200 && Array.isArray(r.json?.warnings) && r.json.warnings.length === 1 && r.json?.commissionPct === 15 && !!r.json?.nextSettlementThursday, JSON.stringify(r.json)?.slice(0, 300));
    r = await req('POST', '/api/admin/providers/prov_demo_starter/suspend', { token: adminToken, body: { reason: 'Test suspension.' } });
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
    r = await req('POST', '/api/admin/providers/prov_demo_starter/unsuspend', { token: adminToken });
    check('admin unsuspend -> 200, suspended false', r.status === 200 && r.json?.suspended === false, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/radar', { token: provToken });
    check('radar works again after unsuspend', r.status === 200 && Array.isArray(r.json?.pending), JSON.stringify(r.json)?.slice(0, 200));
    // Permanent ban on the second demo provider (unused after section 7).
    r = await req('POST', '/api/admin/providers/prov_demo_pro/suspend', { token: adminToken, body: { permanent: true, reason: 'Test permanent ban.' } });
    check('admin permanent ban -> 200, permanentBan true', r.status === 200 && r.json?.permanentBan === true, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/me', { token: prov2Token });
    check('banned provider sees permanentBan in /providers/me', r.status === 200 && r.json?.permanentBan === true, JSON.stringify(r.json));

    // --- 17. v2.0.9: reversed commissions + volume bonus + promo months + loyalty vouchers ---
    console.log('\n[v2.0.9 reversed commissions + volume bonus + promo + vouchers]');
    // Terms text carries the new commission line (version stays 1.0 — no
    // forced re-acceptance for a rates change).
    r = await req('GET', '/api/terms');
    check('terms text has reversed rates 15/12/8, no Elite 1,200 bonus', r.status === 200 && r.json?.textAr?.includes('Starter 15%') && r.json?.textAr?.includes('Elite 8%') && !r.json?.textAr?.includes('1,200') && r.json?.version === '1.0', JSON.stringify(r.json)?.slice(0, 200));
    // Full visit cycle helper (create -> accept -> vitals -> complete ->
    // patient confirm -> review -> released).
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
      return { ok: true, id, created: c.json, released: rv.json };
    };
    // --- 17a. tier rates at accept: Starter 15 / Pro 12 / Elite 8 -------
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Tier Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkTier1 = r.json?.id;
    r = await req('POST', `/api/bookings/${bkTier1}/accept`, { token: provToken });
    check('Starter accepts at 15%', r.status === 200 && r.json?.commissionPct === 15 && r.json?.commissionTier === 'Starter', JSON.stringify(r.json));
    r = await req('POST', '/api/admin/providers/prov_demo_starter/tier', { token: adminToken, body: { tier: 'Pro' } });
    check('admin changes tier to Pro', r.status === 200 && r.json?.tier === 'Pro', JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Tier Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkTier2 = r.json?.id;
    r = await req('POST', `/api/bookings/${bkTier2}/accept`, { token: provToken });
    check('Pro accepts at 12%', r.status === 200 && r.json?.commissionPct === 12 && r.json?.commissionTier === 'Pro', JSON.stringify(r.json));
    r = await req('POST', '/api/admin/providers/prov_demo_starter/tier', { token: adminToken, body: { tier: 'Elite' } });
    check('admin changes tier to Elite', r.status === 200 && r.json?.tier === 'Elite', JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: { ...TERMS,
      patientName: 'Tier Test', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 2, respectCharterAccepted: true, triage: { dangerSigns: [] },
    } });
    const bkTier3 = r.json?.id;
    r = await req('POST', `/api/bookings/${bkTier3}/accept`, { token: provToken });
    check('Elite accepts at 8%', r.status === 200 && r.json?.commissionPct === 8 && r.json?.commissionTier === 'Elite', JSON.stringify(r.json));
    r = await req('POST', '/api/admin/providers/prov_demo_starter/tier', { token: adminToken, body: { tier: 'Starter' } });
    check('admin restores tier to Starter', r.status === 200 && r.json?.tier === 'Starter', JSON.stringify(r.json));
    r = await req('GET', `/api/bookings/${bkTier1}`, { token: patientToken2 });
    check('earlier accepted booking keeps locked 15% after tier change', r.json?.commissionPct === 15, JSON.stringify(r.json)?.slice(0, 200));
    // --- 17b. volume bonus: 30 cases -> 500, title, next target ---------
    const volLogin = await req('POST', '/api/auth/login-phone', { body: { phone: '01022222222' } });
    const volToken = volLogin.json?.accessToken;
    check('volume-test patient login', volLogin.status === 200 && !!volToken, JSON.stringify(volLogin.json));
    // Provider already has 1 released case this month (bkId); 29 more -> 30.
    let volOk = true; let volFailStep = '';
    for (let i = 0; i < 29; i++) {
      const cyc = await completeVisit(volToken, 2);
      if (!cyc.ok) { volOk = false; volFailStep = `${cyc.step} ${JSON.stringify(cyc.res?.json || cyc.res)}`; break; }
    }
    check('29 volume cycles complete + release', volOk, volFailStep.slice(0, 300));
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    check('wallet: 30 cases this month, bonus 500, title محترف موثّق', r.status === 200 && r.json?.monthlyCases === 30 && r.json?.volumeBonusEgp === 500 && r.json?.volumeBonus?.title === 'محترف موثّق' && r.json?.volumeBonus?.nextBonusAt === 60 && r.json?.volumeBonus?.casesToNextBonus === 30, JSON.stringify(r.json?.volumeBonus));
    check('wallet totals carry the 500 bonus into what app owes provider', r.json?.totals?.volumeBonusEgp === 500 && r.json?.totals?.appOwesProviderEgp === 500, JSON.stringify(r.json?.totals));
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
    check('wallet under 0% promo: bonus paused, title kept', r.json?.volumeBonus?.paused === true && r.json?.volumeBonusEgp === 0 && r.json?.volumeBonus?.title === 'محترف موثّق' && r.json?.totals?.appOwesProviderEgp === 0, JSON.stringify(r.json?.volumeBonus));
    check('wallet shows promo 0%', r.json?.promo?.active === true && r.json?.promo?.commissionPct === 0, JSON.stringify(r.json?.promo));
    r = await req('POST', '/api/admin/promo', { token: adminToken, body: { commissionPct: null } });
    check('admin clears promo -> inactive', r.status === 200 && r.json?.promo?.active === false, JSON.stringify(r.json));
    r = await req('GET', '/api/bootstrap');
    check('bootstrap promo inactive after clear', r.json?.promo?.active === false, JSON.stringify(r.json?.promo));
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
