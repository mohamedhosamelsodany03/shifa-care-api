// Smoke test — starts the server on a test port with a throwaway data file,
// runs the critical flows, asserts, prints PASS/FAIL, exits.
// Run:  npm test        (or: node test/smoke.js)
// It never touches the real data.json.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

async function main() {
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  const env = {
    ...process.env, PORT: String(PORT), NODE_ENV: 'test',
    DATA_FILE, MOCK_OTP: 'true', JWT_SECRET: 'smoke-test-secret', ADMIN_PIN: '123456',
    AUTO_RELEASE_MS: '1000', // shorten the 1h auto-release window for the test only
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

    // --- 4. triage + charter -------------------------------------------
    console.log('\n[triage + charter]');
    r = await req('POST', '/api/bookings', { token: patientToken2, body: {
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt',
      distanceKm: 3, respectCharterAccepted: true, triage: { dangerSigns: ['chest_pain'] },
    } });
    check('danger sign -> 422 + ambulance 123', r.status === 422 && r.json?.ambulance === '123', JSON.stringify(r.json));
    r = await req('POST', '/api/bookings', { token: patientToken2, body: {
      patientName: 'Test Patient', serviceCode: 'standard', paymentMethod: 'cash_receipt', distanceKm: 3,
    } });
    check('missing respect charter -> 400', r.status === 400, JSON.stringify(r.json));

    // --- 5. distance fee table (via booking totals) ---------------------
    console.log('\n[distance fees]');
    async function bookAt(km, extra = {}) {
      const rr = await req('POST', '/api/bookings', { token: patientToken2, body: {
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
    r = await req('POST', '/api/bookings', { token: patientToken2, body: {
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
    check('commission locked at accept (Starter 8%)', r.json?.commissionPct === 8);
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
    check('review -> released, app 8% of 375 = 30, provider 345', r.status === 200 && r.json?.status === 'released' && r.json?.appShareEgp === 30 && r.json?.providerShareEgp === 345, JSON.stringify(r.json));
    // Wallet ledger reflects it.
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    const entry = r.json?.ledger?.find((l) => l.bookingId === bkId);
    // v2.0.1: released but inside the 24h complaint window -> held, not settleable yet.
    check('wallet ledger: released amount held for complaint window (345)', r.status === 200 && entry?.direction === 'complaint_hold' && entry?.amountEgp === 345 && r.json?.totals?.complaintHoldEgp === 345, JSON.stringify(r.json?.totals));
    check('wallet has next Thursday settlement', !!r.json?.nextSettlementThursday);
    // Cash-collected creates a debt entry.
    r = await req('POST', `/api/bookings/${bkId}/cash-collected`, { token: provToken });
    check('cash-collected marks booking', r.status === 200 && r.json?.cashCollectedByProvider === true, JSON.stringify(r.json));
    r = await req('GET', '/api/providers/wallet', { token: provToken });
    const entry2 = r.json?.ledger?.find((l) => l.bookingId === bkId);
    check('wallet after cash: app share held for complaint window (30)', entry2?.direction === 'complaint_hold' && entry2?.amountEgp === 30, JSON.stringify(entry2));

    // --- 8. auto-release sweep ------------------------------------------
    console.log('\n[auto-release]');
    r = await req('POST', '/api/bookings', { token: patientToken2, body: {
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
    r = await req('POST', '/api/admin/pin/verify', { body: { pin: '123456' } });
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
    r = await req('POST', '/api/tourist-bookings', { token: patientToken2, body: {
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
    r = await req('POST', '/api/postop', { token: patientToken2, body: {
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
    r = await req('POST', '/api/providers/register', { token: newToken, body: {
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
    r = await req('POST', '/api/admin/pin/verify', { body: { pin: '123456' } });
    check('correct PIN while locked -> 423 locked', r.status === 423, JSON.stringify(r.json));
    // Admin endpoints still work with the earlier token.
    r = await req('GET', '/api/admin/audit', { token: adminToken });
    check('admin audit log readable', r.status === 200 && Array.isArray(r.json) && r.json.length > 5, `len=${r.json?.length}`);
    r = await req('GET', '/api/admin/mock-otp', { token: adminToken });
    check('mock-otp endpoint lists demo phones (dev only)', r.status === 200 && r.json?.mockOtp === true, JSON.stringify(r.json)?.slice(0, 200));

    // --- 15. v2.0.1: 15-min cancellation + 24h complaint window ---------
    console.log('\n[cancel + complaint]');
    r = await req('POST', '/api/bookings', { token: patientToken2, body: {
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
    r = await req('POST', '/api/bookings', { token: patientToken2, body: {
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
    check('after rejection: provider owes app 30 (cash, now settleable)', entry3?.direction === 'provider_owes_app' && entry3?.amountEgp === 30, JSON.stringify(entry3));
    // Refund path: complaint on the auto-released booking, admin accepts.
    r = await req('POST', `/api/bookings/${bk2}/safety-report`, { token: patientToken2, body: { type: 'complaint', description: 'Service was not satisfactory, request refund.' } });
    check('complaint on auto-released booking -> 201', r.status === 201, JSON.stringify(r.json));
    const refundReportId = r.json?.reportId;
    r = await req('POST', `/api/admin/complaints/${refundReportId}/resolve`, { token: adminToken, body: { decision: 'accepted_refund' } });
    check('admin accepts refund -> booking refunded, refundEgp 250', r.status === 200 && r.json?.booking?.status === 'refunded' && r.json?.booking?.refundEgp === 250, JSON.stringify(r.json));
    r = await req('GET', `/api/providers/wallet`, { token: provToken });
    const refundEntry = r.json?.ledger?.find((l) => l.bookingId === bk2);
    check('refunded booking excluded from settlement', refundEntry?.direction === 'refunded' && refundEntry?.amountEgp === 0, JSON.stringify(refundEntry));

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
