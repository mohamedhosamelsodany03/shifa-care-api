// All /api routes. Auth rule: ONLY bootstrap, otp/*, auth/login-phone,
// auth/refresh and admin/pin/verify are public. Everything else requires a valid JWT, and
// ownership / role checks happen server-side on every request.
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { store, sha256, newId, nowIso } = require('./store');
const { makeCode, pickProvider, normalizePhone } = require('./otp');
const { issueTokens, verifyRefreshToken, revokeRefreshToken, requireAuth, requireRole, issueAdminToken } = require('./auth');
const cat = require('./catalog');

const router = express.Router();

const DEMO_OTP = '123456'; // dev only, demo phones only, mock mode only

function bad(res, status, message, extra = {}) {
  return res.status(status).json({ error: 'validation_error', message, ...extra });
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function nextThursday(from = new Date()) {
  const d = new Date(from);
  const day = d.getDay(); // 4 = Thursday
  let add = (4 - day + 7) % 7;
  if (add === 0) add = 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}
function loadBooking(req, res) {
  const b = store.data.bookings[req.params.id];
  if (!b) { res.status(404).json({ error: 'not_found', message: 'Booking not found.' }); return null; }
  return b;
}
function canSeeBooking(req, b) {
  if (req.user.role === 'admin') return true;
  if (req.user.role === 'patient' && b.patientPhone === req.user.phone) return true;
  if (req.user.role === 'provider' && b.providerId && req.user.providerId === b.providerId) return true;
  return false;
}
// ---------------------------------------------------------------- escrow
// v2.0.1 — TWO-STAGE ESCROW (settled decision, 24 Nov 2026):
//   Stage 1 (provisional release): the held amount is released to the
//     provider's wallet as soon as the client confirms completion AND
//     reviews, OR 1 hour after patient confirmation with no review and no
//     complaint (auto-release sweep). Status becomes released/auto_released.
//   Stage 2 (final settlement): the released amount is NOT payable in the
//     Thursday settlement until the 24-hour complaint window ends
//     (complaintDeadline = patientConfirmedAt + 24h) with no open complaint,
//     or until an open complaint is resolved by admin as REJECTED. While
//     inside the window the wallet shows direction 'complaint_hold'.
//     If admin accepts the complaint (accepted_refund) the booking becomes
//     'refunded' and the full amount returns to the patient; the provider
//     share is removed from the wallet.
//   Why two stages: the 1-hour auto-release rule (client confirmed, no
//   review) and the 24-hour complaint rule (client may still complain)
//   would otherwise contradict each other — the money "moves" at 1 hour
//   but only becomes spendable/settleable after 24 hours. Cash collected
//   by hand follows the same hold: the app share the provider owes is only
//   due at Thursday settlement once the window has closed or the complaint
//   was rejected.
//   Complaint FILING is only allowed inside the 24h window; an open
//   complaint pauses final settlement indefinitely until admin resolves it
//   (the window limits filing, not resolution time).
function releaseBooking(b, mode) {
  const total = b.amountEgp;
  const pct = b.commissionPct ?? 0;
  b.appShareEgp = Math.round(total * (pct / 100));
  b.providerShareEgp = total - b.appShareEgp;
  b.status = mode === 'auto' ? 'auto_released' : 'released';
  b.releasedAt = nowIso();
  b.releaseMode = mode;
  // Final settlement only after the 24h complaint window (set at patient
  // confirmation) — see the two-stage escrow comment above.
  b.settleableAt = b.complaintDeadline || null;
  const p = b.providerId ? store.data.providers[b.providerId] : null;
  if (p) p.completedVisits = (p.completedVisits || 0) + 1;
  store.audit('escrow.released', b.providerId || 'system', { bookingId: b.id, mode, totalEgp: total, appShareEgp: b.appShareEgp, providerShareEgp: b.providerShareEgp });
  store.save();
}
function sweepAutoRelease() {
  const now = Date.now();
  const released = [];
  const overdue = [];
  for (const b of Object.values(store.data.bookings)) {
    if (b.status === 'patient_confirmed' && b.patientConfirmedAt && !b.review && !b.complaint) {
      if (now - new Date(b.patientConfirmedAt).getTime() >= config.autoReleaseAfterMs) {
        releaseBooking(b, 'auto');
        released.push(b.id);
      }
    }
    // 'reviewed' only persists when a complaint paused the release; once
    // the complaint is resolved as rejected, release it now.
    if (b.status === 'reviewed' && !b.complaint) {
      releaseBooking(b, 'reviewed');
      released.push(b.id);
    }
    if ((b.status === 'accepted' || b.status === 'provider_confirmed') && b.acceptedAt) {
      if (!b.overdue && now - new Date(b.acceptedAt).getTime() >= 120 * 60 * 1000) {
        b.overdue = true;
        overdue.push(b.id);
        store.audit('visit.overdue', 'system', { bookingId: b.id, minutes: 120 });
      }
    }
  }
  if (released.length || overdue.length) store.save();
  return { released, overdue };
}

// ---------------------------------------------------------------- bootstrap
router.get('/bootstrap', (req, res) => {
  // PUBLIC, minimal: services + prices only. NO payment number, NO settings.
  // Shape matches the web frontend's FALLBACK contract:
  // services: [{id, price, name_en, name_ar}], tourist: [{id, usd, eur}],
  // distanceTiers: [{maxKm, fee}], mockMode, fx.
  const services = Object.values(cat.SERVICES)
    .filter((s) => s.price_egp != null)
    .map((s) => ({
      id: s.code, code: s.code, name_en: s.name_en, name_ar: s.name_ar,
      price: s.price_egp, price_egp: s.price_egp,
      experience_bands: s.experience_bands || undefined,
    }));
  const touristMap = { tourist_doctor: 'doctor', tourist_iv: 'iv', tourist_dressing: 'dressing', tourist_nurse: 'nurse' };
  const tourist = Object.values(cat.TOURIST_SERVICES).map((s) => ({
    id: touristMap[s.code] || s.code, code: s.code, name_en: s.name_en, name_ar: s.name_ar, usd: s.usd, eur: s.eur,
  }));
  tourist.push({ id: 'urgent', code: 'tourist_urgent', name_en: 'Urgent surcharge', name_ar: 'طلب مستعجل (إضافة)', usd: cat.TOURIST_URGENT_EXTRA.usd, eur: cat.TOURIST_URGENT_EXTRA.eur, extra: true });
  res.json({
    app: 'Shifa Care', city: 'El Quseir', currency: 'EGP',
    services,
    tourist_services: Object.values(cat.TOURIST_SERVICES),
    tourist,
    tourist_urgent_extra: cat.TOURIST_URGENT_EXTRA,
    distanceTiers: [
      { maxKm: 6, fee: 0 }, { maxKm: 10, fee: 100 }, { maxKm: 20, fee: 200 },
      { maxKm: 35, fee: 350 }, { maxKm: 35.01, fee: 500 },
    ],
    fx: { usd: config.usdEgp, eur: config.eurEgp },
    mockMode: config.mockOtp,
    ambulance: '123',
    note: 'Prices are fixed and announced in advance. No bargaining inside the app.',
  });
});

// ---------------------------------------------------------------- OTP
router.post('/otp/request', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const channel = req.body?.channel === 'sms' ? 'sms' : 'whatsapp'; // WhatsApp first
  if (!phone) return bad(res, 400, 'Valid Egyptian phone number required (01xxxxxxxxx).');
  const rec = store.data.otps[phone] || { requests: [] };
  const hourAgo = Date.now() - 60 * 60 * 1000;
  rec.requests = (rec.requests || []).filter((t) => t > hourAgo);
  if (rec.requests.length >= config.otpMaxRequestsPerHour) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many OTP requests for this number. Try again later.' });
  }
  const code = makeCode();
  rec.codeHash = sha256(code);
  rec.expiresAt = new Date(Date.now() + config.otpTtlMinutes * 60 * 1000).toISOString();
  rec.attempts = 0;
  rec.channel = channel;
  rec.requests.push(Date.now());
  store.data.otps[phone] = rec;
  // This handler is async: a synchronous throw here would reject the
  // promise, which Express 4 does not catch, and crash the whole process.
  // Persist defensively and fail closed with a 500 instead.
  try {
    store.save();
  } catch (e) {
    console.error('[error] otp/request save failed:', e && e.message);
    return res.status(500).json({ error: 'internal', message: 'Could not store OTP request.' });
  }
  try {
    const provider = pickProvider(channel);
    await provider.send({ phone, channel, code });
  } catch (e) {
    // A real provider failure must never look like a success.
    return res.status(502).json({ error: 'otp_provider_error', message: e.message });
  }
  // The code is NEVER returned in the response.
  res.json({ ok: true, channel, expires_in_seconds: config.otpTtlMinutes * 60, message: 'OTP sent.' });
});

router.post('/otp/verify', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  if (!phone || !/^\d{6}$/.test(code)) return bad(res, 400, 'Phone and 6-digit code required.');
  const rec = store.data.otps[phone];
  // Demo phones in mock/dev mode accept the documented demo code.
  const isDemo = config.mockOtp && (phone === '01000000001' || phone === '01000000002') && code === DEMO_OTP;
  if (!isDemo) {
    if (!rec) return res.status(401).json({ error: 'unauthorized', message: 'No OTP requested for this number.' });
    if (new Date(rec.expiresAt).getTime() < Date.now()) {
      delete store.data.otps[phone]; store.save();
      return res.status(401).json({ error: 'unauthorized', message: 'OTP expired. Request a new one.' });
    }
    if ((rec.attempts || 0) >= config.otpMaxAttempts) {
      delete store.data.otps[phone]; store.save();
      return res.status(401).json({ error: 'unauthorized', message: 'Too many wrong attempts. Request a new OTP.' });
    }
    if (rec.codeHash !== sha256(code)) {
      rec.attempts = (rec.attempts || 0) + 1;
      store.save();
      return res.status(401).json({ error: 'unauthorized', message: 'Wrong OTP code.' });
    }
  }
  delete store.data.otps[phone];
  if (!store.data.users[phone]) store.data.users[phone] = { phone, createdAt: nowIso() };
  const provider = store.getProviderByPhone(phone);
  const role = provider ? 'provider' : 'patient';
  const tokens = issueTokens({ phone, role, providerId: provider ? provider.id : null });
  store.audit('auth.otp_verified', phone, { role });
  store.save();
  // `token` is the field the web frontend reads (alias of accessToken).
  res.json({ ...tokens, token: tokens.accessToken, role, providerId: provider ? provider.id : null, phone });
});

// ---------------------------------------------------------------- phone-only login (fallback)
// OWNER DECISION 24 Nov 2026: Meta refused the WhatsApp OTP template 7
// times (template creation not permitted for this account) and the
// display-name edit is disabled, so OTP login cannot work yet. The owner
// explicitly authorized login by phone number alone — the v1.3 behaviour —
// until OTP is unblocked. SECURITY CAVEAT: phone-only login means anyone
// who knows a phone number can log in as that number's account. The OTP
// endpoints and the Meta WhatsApp provider in src/otp.js are KEPT intact
// so OTP can be re-enabled later without rebuilding the auth flow.
//   POST /api/auth/login-phone { phone, role? }
//   role=provider: only a phone already registered as a provider works
//     (unknown provider phone -> 403). role absent/patient: the phone is
//     a patient; a user record is created on first use (patients only).
//   Rate limit: same per-phone cap as OTP requests (5/hour) + an IP
//     limiter in app.js. Every login is audit-logged.
router.post('/auth/login-phone', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return bad(res, 400, 'Valid Egyptian phone number required (01xxxxxxxxx).');
  const provider = store.getProviderByPhone(phone);
  if (req.body?.role === 'provider' && !provider) {
    return res.status(403).json({ error: 'forbidden', message: 'This phone is not registered as a provider. Register as a provider first.' });
  }
  const logins = store.data.phoneLogins || (store.data.phoneLogins = {});
  const rec = logins[phone] || { requests: [] };
  const hourAgo = Date.now() - 60 * 60 * 1000;
  rec.requests = (rec.requests || []).filter((t) => t > hourAgo);
  if (rec.requests.length >= config.otpMaxRequestsPerHour) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many login attempts for this number. Try again later.' });
  }
  rec.requests.push(Date.now());
  logins[phone] = rec;
  if (!store.data.users[phone]) store.data.users[phone] = { phone, createdAt: nowIso() };
  const role = provider ? 'provider' : 'patient';
  const tokens = issueTokens({ phone, role, providerId: provider ? provider.id : null });
  store.audit('auth.phone_login', phone, { role, authMethod: 'phone-only-fallback' });
  store.save();
  // `token` is the field the web frontend reads (alias of accessToken).
  res.json({ ...tokens, token: tokens.accessToken, role, providerId: provider ? provider.id : null, phone, authMethod: 'phone-only' });
});

// ---------------------------------------------------------------- auth
router.post('/auth/refresh', (req, res) => {
  const rec = verifyRefreshToken(req.body?.refreshToken);
  if (!rec) return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired refresh token.' });
  const tokens = issueTokens({ phone: rec.phone, role: rec.role, providerId: rec.providerId });
  // Rotate: revoke the old refresh token.
  rec.revoked = true;
  store.save();
  res.json(tokens);
});

router.post('/auth/logout', requireAuth, (req, res) => {
  const ok = revokeRefreshToken(req.body?.refreshToken);
  store.audit('auth.logout', req.user.phone, {});
  res.json({ ok: true, refresh_revoked: ok });
});

// ---------------------------------------------------------------- bookings
// Normalizes the web frontend's field names to the server's canonical ones.
// Client-sent totals/fees are IGNORED — the server always recomputes prices.
const ASSISTANT_BAND_YEARS = { asst_lt2: 1, asst_2_4: 3.5, asst_5_9: 7, asst_10p: 12 };
function normalizeBookingBody(raw) {
  const b = { ...(raw || {}) };
  b.patientName = b.patientName || b.name;
  let svc = b.serviceCode || b.service;
  if (ASSISTANT_BAND_YEARS[svc] != null) { b.experienceYears = ASSISTANT_BAND_YEARS[svc]; svc = 'assistant'; }
  b.serviceCode = svc;
  b.distanceKm = b.distanceKm ?? b.km;
  if (b.hotelId == null && typeof b.hotel === 'string' && b.hotel) {
    const h = store.data.hotels.find((x) => x.name_en === b.hotel || x.name_ar === b.hotel || x.id === b.hotel);
    if (h) b.hotelId = h.id;
  }
  b.transport = b.transport || (b.transportProvided ? 'roundtrip' : 'none');
  if (b.paymentMethod === 'cash') b.paymentMethod = 'cash_receipt';
  b.respectCharterAccepted = b.respectCharterAccepted ?? b.charterAccepted ?? false;
  b.scheduledAt = b.scheduledAt || (b.date && b.time ? `${b.date}T${b.time}:00` : b.date || null);
  b.alternateContact = b.alternateContact || b.altContact || null;
  b.surgeryType = b.surgeryType || b.operation || null;
  b.dressingSchedule = b.dressingSchedule || b.schedule || null;
  b.licenseNo = b.licenseNo || b.licence || null;
  if (Array.isArray(b.certificates)) b.certificates = b.certificates.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean);
  return b;
}
function priceBooking({ serviceCode, experienceYears, distanceKm, hotelId, transport }) {
  const base = cat.servicePriceEgp(serviceCode, { experienceYears });
  if (base == null) return { error: 'Unknown service or missing experienceYears for assistant.' };
  let distance = distanceKm;
  let hotel = null;
  if (hotelId) {
    hotel = store.data.hotels.find((h) => h.id === hotelId);
    if (!hotel) return { error: 'Unknown hotel id.' };
    distance = hotel.distance_km;
  }
  if (distance == null) distance = 0; // no location given: assume city centre (0–6 km band, fee 0); the real distance is confirmed with the provider
  const fee = cat.distanceFee(distance, transport);
  if (fee.error) return { error: fee.error };
  if (fee.contract_required) {
    return { contract_required: true, distanceKm: distance, band: fee.band, message: 'Over 35 km: special contract only, no automatic pricing.' };
  }
  return { baseEgp: base, distanceFeeEgp: fee.fee_egp, totalEgp: base + fee.fee_egp, distanceKm: distance, band: fee.band, hotel };
}

router.post('/bookings', requireAuth, (req, res) => {
  const b = normalizeBookingBody(req.body);
  if (b.respectCharterAccepted !== true) {
    return bad(res, 400, 'Respect charter must be accepted before booking (respectCharterAccepted=true).', { charter: 'Treat the healthcare provider with respect: no insults, harassment or threats; keep the appointment; prepare the place. Violations lead to warning then account suspension.' });
  }
  if (!b.patientName || typeof b.patientName !== 'string') return bad(res, 400, 'patientName required.');
  if (!b.serviceCode || !cat.SERVICES[b.serviceCode]) return bad(res, 400, 'Valid serviceCode required.');
  if (!['cash_receipt', 'instapay'].includes(b.paymentMethod)) return bad(res, 400, 'paymentMethod must be cash_receipt or instapay.');
  // Emergency triage — ANY danger sign rejects the booking.
  const triage = b.triage || {};
  const danger = (triage.dangerSigns || []).filter((s) => cat.DANGER_SIGNS.includes(s));
  if (triage.danger === true || danger.length > 0 || triage.emergency === true) {
    store.audit('booking.triage_rejected', req.user.phone, { danger });
    return res.status(422).json({
      error: 'emergency_triage',
      message: 'Danger sign detected. Do NOT book a home visit — call the ambulance now.',
      ambulance: '123', danger_signs: danger,
    });
  }
  const priced = priceBooking(b);
  if (priced.error) return bad(res, 400, priced.error);
  if (priced.contract_required) {
    return res.status(422).json({ error: 'contract_required', ...priced });
  }
  const id = newId('bk');
  const booking = {
    id, kind: 'standard', patientPhone: req.user.phone, patientName: b.patientName,
    serviceCode: b.serviceCode, serviceName: cat.SERVICES[b.serviceCode].name_en,
    status: 'held', // escrow: money held in-app from booking
    amountEgp: priced.totalEgp, baseEgp: priced.baseEgp, distanceFeeEgp: priced.distanceFeeEgp,
    distanceKm: priced.distanceKm, distanceBand: priced.band, distanceEstimate: true,
    transport: b.transport || 'none', hotelId: b.hotelId || null,
    currency: 'EGP', amountForeign: null, fxRate: null,
    paymentMethod: b.paymentMethod, respectCharterAccepted: true,
    triage: { dangerSigns: danger, notes: triage.notes || null },
    address: b.address || null, scheduledAt: b.scheduledAt || null, notes: b.notes || null,
    alternateContact: b.alternateContact || null, // admin-only if needed
    providerId: null, commissionPct: null, providerShareEgp: null, appShareEgp: null,
    vitals: null, review: null, providerReview: null, complaint: false,
    complaintStatus: null, complaintDeadline: null, complaintAt: null, complaintResolvedAt: null,
    settleableAt: null, cancelledAt: null, refundedAt: null, refundEgp: null,
    cashCollectedByProvider: false, overdue: false,
    createdAt: nowIso(), acceptedAt: null, providerConfirmedAt: null,
    patientConfirmedAt: null, reviewedAt: null, releasedAt: null, releaseMode: null,
  };
  store.data.bookings[id] = booking;
  store.audit('booking.created', req.user.phone, { bookingId: id, serviceCode: b.serviceCode, totalEgp: booking.amountEgp });
  store.save();
  // Payment number is shown only AFTER the booking is confirmed (accepted),
  // so it is NOT included here.
  res.status(201).json(store.publicBooking(booking));
});

router.get('/bookings/mine', requireAuth, (req, res) => {
  const all = Object.values(store.data.bookings);
  const mine = req.user.role === 'provider'
    ? all.filter((b) => b.providerId === req.user.providerId)
    : all.filter((b) => b.patientPhone === req.user.phone);
  mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(mine.map((b) => store.publicBooking(b, { includePaymentNumber: b.status !== 'held' && b.status !== 'cancelled' })));
});

router.get('/bookings/:id', requireAuth, (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (!canSeeBooking(req, b)) return res.status(403).json({ error: 'forbidden', message: 'This booking does not belong to you.' });
  res.json(store.publicBooking(b, { includePaymentNumber: b.status !== 'held' && b.status !== 'cancelled' }));
});

// v2.0.1 — cancellation: the client may cancel ONLY within 15 minutes
// of BOOKING CREATION (config.cancelWindowMs) and only while the booking
// is 'held' or 'accepted'. After 15 minutes the server rejects the
// cancellation (409 cancel_window_closed). An early cancellation refunds
// the full held amount (refundEgp = amountEgp).
router.post('/bookings/:id/cancel', requireAuth, requireRole('patient'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.patientPhone !== req.user.phone) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (!['held', 'accepted'].includes(b.status)) {
    return bad(res, 409, `Cannot cancel while status is ${b.status}.`, { status: b.status });
  }
  const deadline = new Date(b.createdAt).getTime() + config.cancelWindowMs;
  if (Date.now() > deadline) {
    return res.status(409).json({ error: 'cancel_window_closed', message: 'Cancellation is only allowed within 15 minutes of booking. The 15-minute window has passed.', cancelDeadline: new Date(deadline).toISOString() });
  }
  b.status = 'cancelled';
  b.cancelledAt = nowIso();
  b.refundEgp = b.amountEgp; // full refund of the held amount
  b.refundedAt = nowIso();
  store.audit('booking.cancelled', req.user.phone, { bookingId: b.id, refundEgp: b.refundEgp, wasAccepted: !!b.providerId });
  store.save();
  res.json({ ...store.publicBooking(b, { includePaymentNumber: false }), note: 'Cancelled within the 15-minute window — the full held amount is refunded.' });
});

router.post('/bookings/:id/confirm-patient', requireAuth, requireRole('patient'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.patientPhone !== req.user.phone) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (b.status !== 'provider_confirmed') return bad(res, 409, `Cannot confirm patient side while status is ${b.status}. Provider must confirm completion first.`);
  b.status = 'patient_confirmed';
  b.patientConfirmedAt = nowIso();
  // v2.0.1: the 24-hour complaint window starts at service completion.
  b.complaintDeadline = new Date(new Date(b.patientConfirmedAt).getTime() + config.complaintWindowMs).toISOString();
  b.settleableAt = b.complaintDeadline;
  store.audit('booking.patient_confirmed', req.user.phone, { bookingId: b.id, complaintDeadline: b.complaintDeadline });
  store.save();
  res.json({ ...store.publicBooking(b, { includePaymentNumber: true }), note: 'If no review is submitted within 1 hour and there is no complaint, the held amount is released automatically (provisional). It becomes finally settleable only after the 24-hour complaint window ends with no open complaint.' });
});

router.post('/bookings/:id/review', requireAuth, requireRole('patient'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.patientPhone !== req.user.phone) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (b.status !== 'patient_confirmed') return bad(res, 409, `Cannot review while status is ${b.status}. Confirm receipt of the service first.`);
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return bad(res, 400, 'rating must be an integer 1–5.');
  b.review = { rating, comment: String(req.body?.comment || '').slice(0, 1000), at: nowIso() };
  b.status = 'reviewed';
  b.reviewedAt = nowIso();
  const p = b.providerId ? store.data.providers[b.providerId] : null;
  if (p) {
    const n = p.completedVisits || 0;
    p.ratingAvg = n > 0 ? Math.round(((p.ratingAvg || 5) * n + rating) / (n + 1) * 10) / 10 : rating;
  }
  store.audit('booking.reviewed', req.user.phone, { bookingId: b.id, rating });
  if (b.complaint) {
    // v2.0.1: an open complaint pauses the release — status stays
    // 'reviewed' until admin resolves the complaint (sweep releases it
    // if the complaint is rejected; a refund if it is accepted).
    store.save();
    return res.json({ ...store.publicBooking(b, { includePaymentNumber: true }), note: 'Review recorded. Release is paused while your complaint is under review.' });
  }
  releaseBooking(b, 'reviewed'); // review releases the held amount at once (provisional; final settlement after the 24h complaint window)
  res.json(store.publicBooking(b, { includePaymentNumber: true }));
});

router.post('/bookings/:id/rate-patient', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.providerId !== req.user.providerId) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (!['provider_confirmed', 'patient_confirmed', 'reviewed', 'released', 'auto_released'].includes(b.status)) {
    return bad(res, 409, `Cannot rate the patient while status is ${b.status}.`);
  }
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return bad(res, 400, 'rating must be an integer 1–5.');
  b.providerReview = { rating, comment: String(req.body?.comment || '').slice(0, 1000), at: nowIso() };
  store.audit('booking.patient_rated', req.user.phone, { bookingId: b.id, rating });
  store.save();
  res.json(store.publicBooking(b, { includePaymentNumber: true }));
});

router.post('/bookings/:id/safety-report', requireAuth, (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (!canSeeBooking(req, b)) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  const type = req.body?.type || (req.body?.text ? 'safety' : null);
  if (!['complaint', 'safety', 'other'].includes(type)) return bad(res, 400, 'type must be complaint, safety or other.');
  const desc = String(req.body?.description || req.body?.text || '').slice(0, 2000);
  if (!desc) return bad(res, 400, 'description required.');
  // v2.0.1 — refund complaints: only within 24 hours after the service
  // was completed (patient confirmation). Before completion, or after the
  // window closed, a refund complaint is rejected; urgent safety issues
  // must be sent as type 'safety' instead.
  if (type === 'complaint') {
    if (b.complaintStatus === 'open') {
      return bad(res, 409, 'A complaint is already open for this booking. Wait for the admin review.');
    }
    if (!b.patientConfirmedAt) {
      return bad(res, 409, 'Refund complaints are only accepted within 24 hours after the service is completed. For an urgent safety issue, send type safety instead.');
    }
    const deadline = b.complaintDeadline
      ? new Date(b.complaintDeadline).getTime()
      : new Date(b.patientConfirmedAt).getTime() + config.complaintWindowMs;
    if (Date.now() > deadline) {
      return res.status(422).json({ error: 'complaint_window_closed', message: 'The 24-hour complaint window has closed. No refund can be requested for this booking.', complaintDeadline: new Date(deadline).toISOString() });
    }
  }
  const report = { id: newId('sr'), bookingId: b.id, reporterPhone: req.user.phone, reporterRole: req.user.role, type, description: desc, at: nowIso(), status: 'open' };
  store.data.safetyReports.push(report);
  if (type === 'complaint') {
    b.complaint = true; // blocks auto-release until admin reviews
    b.complaintStatus = 'open';
    b.complaintAt = nowIso();
    if (!b.complaintDeadline) b.complaintDeadline = new Date(new Date(b.patientConfirmedAt).getTime() + config.complaintWindowMs).toISOString();
    b.settleableAt = b.complaintDeadline;
  }
  store.audit('booking.safety_report', req.user.phone, { bookingId: b.id, type });
  store.save();
  res.status(201).json({ ok: true, reportId: report.id, complaintDeadline: b.complaintDeadline || null, note: type === 'complaint' ? 'Complaint recorded — automatic release is paused until admin review. You have 24 hours from service completion to complain; after admin review an accepted complaint is refunded in full.' : 'Report recorded for admin review.' });
});

router.post('/bookings/:id/sos', requireAuth, (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (!canSeeBooking(req, b)) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (!['accepted', 'provider_confirmed'].includes(b.status)) {
    return bad(res, 409, 'SOS is for active visits only.');
  }
  const alert = { id: newId('sos'), bookingId: b.id, phone: req.user.phone, role: req.user.role, at: nowIso(), status: 'open' };
  store.data.sos.push(alert);
  store.audit('sos.raised', req.user.phone, { bookingId: b.id });
  store.save();
  res.status(201).json({ ok: true, sosId: alert.id, message: 'SOS alert sent to admin immediately.' });
});

router.post('/bookings/:id/cash-collected', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.providerId !== req.user.providerId) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (!['released', 'auto_released'].includes(b.status)) {
    return bad(res, 409, 'Cash can only be marked collected after the booking is released.');
  }
  b.cashCollectedByProvider = true;
  store.audit('booking.cash_collected', req.user.phone, { bookingId: b.id, appShareEgp: b.appShareEgp, note: 'Provider holds the cash — app share is now owed by the provider.' });
  store.save();
  res.json(store.publicBooking(b, { includePaymentNumber: true }));
});

// Manual + scheduled escrow sweep (admin only via HTTP; interval calls it directly).
router.post('/jobs/sweep', requireAuth, requireRole('admin'), (req, res) => {
  const result = sweepAutoRelease();
  store.audit('jobs.sweep', req.user.phone, result);
  res.json({ ok: true, ...result });
});

module.exports = { router, sweepAutoRelease };

// ---------------------------------------------------------------- providers
router.post('/providers/register', requireAuth, (req, res) => {
  const b = normalizeBookingBody(req.body);
  if (store.getProviderByPhone(req.user.phone)) {
    return res.status(409).json({ error: 'conflict', message: 'This phone is already registered as a provider.' });
  }
  if (!b.name || typeof b.name !== 'string') return bad(res, 400, 'name required.');
  if (!['assistant', 'nurse', 'doctor'].includes(b.role)) return bad(res, 400, 'role must be assistant, nurse or doctor.');
  const nationalId = String(b.nationalId || '');
  const licenseNo = String(b.licenseNo || '');
  if (!/^\d{14}$/.test(nationalId)) return bad(res, 400, 'nationalId must be 14 digits.');
  if (!licenseNo || licenseNo.length < 4) return bad(res, 400, 'licenseNo required.');
  const certificates = Array.isArray(b.certificates) ? b.certificates.map(String).slice(0, 20) : [];
  const extraLanguages = Array.isArray(b.extraLanguages)
    ? b.extraLanguages.filter((l) => l && l.language).map((l) => ({ language: String(l.language).toLowerCase().slice(0, 5), certified: l.certified === true })).slice(0, 5)
    : [];
  const id = newId('prov');
  const p = {
    id, demo: false, phone: req.user.phone, name: b.name.trim().slice(0, 120), role: b.role,
    tier: 'Starter', status: 'pending',
    // Stored hashed; only last4 ever leaves the server.
    nationalIdHash: sha256(nationalId), nationalIdLast4: nationalId.slice(-4),
    licenseHash: sha256(licenseNo), licenseLast4: licenseNo.slice(-4),
    certificates, extraLanguages,
    verifiedCertificates: 0, // +5 points each (max 15) — set by admin certificate review
    interviewStatus: 'not_started', interviewScore: null,
    ratingAvg: null, completedVisits: 0, createdAt: nowIso(),
  };
  store.data.providers[id] = p;
  store.data.providersByPhone[req.user.phone] = id;
  store.audit('provider.registered', req.user.phone, { providerId: id, role: b.role });
  store.save();
  res.status(201).json({ ...store.publicProvider(p), next: 'Take the 20-question interview: POST /api/providers/interview/start' });
});

router.get('/providers/me', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  res.json(store.publicProvider(p));
});

router.get('/providers/radar', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  if (p.interviewStatus !== 'passed') {
    return res.status(403).json({ error: 'forbidden', message: 'Pass the interview first — radar is locked until interviewStatus=passed.' });
  }
  const maxKm = Number(req.query.maxKm) || 35;
  const held = Object.values(store.data.bookings)
    .filter((b) => b.status === 'held' && !b.providerId && (b.distanceKm ?? 99) <= maxKm)
    .sort((a, b) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99))
    .map((b) => store.publicBooking(b));
  res.json({ providerId: p.id, tier: p.tier, pending: held });
});

router.post('/bookings/:id/accept', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  const p = store.data.providers[req.user.providerId];
  if (!p || p.interviewStatus !== 'passed') {
    return res.status(403).json({ error: 'forbidden', message: 'Pass the interview first.' });
  }
  if (b.status !== 'held' || b.providerId) return bad(res, 409, `Booking cannot be accepted while status is ${b.status}.`);
  b.providerId = p.id;
  b.commissionPct = cat.TIERS[p.tier].commission_pct; // locked at accept time
  b.status = 'accepted';
  b.acceptedAt = nowIso();
  store.audit('booking.accepted', req.user.phone, { bookingId: b.id, providerId: p.id, commissionPct: b.commissionPct });
  store.save();
  res.json(store.publicBooking(b, { includePaymentNumber: true }));
});

router.post('/bookings/:id/vitals', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.providerId !== req.user.providerId) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (b.status !== 'accepted') return bad(res, 409, `Vitals are recorded during an accepted visit (status is ${b.status}).`);
  const v = req.body || {};
  const num = (k, min, max) => {
    const n = Number(v[k]);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  const vitals = {
    bpSystolic: num('bpSystolic', 50, 300), bpDiastolic: num('bpDiastolic', 30, 200),
    pulse: num('pulse', 20, 250), glucose: num('glucose', 20, 900),
    oxygen: num('oxygen', 50, 100), temp: num('temp', 30, 45),
  };
  const missing = Object.entries(vitals).filter(([, x]) => x == null).map(([k]) => k);
  if (missing.length) return bad(res, 400, `Mandatory vitals missing or out of range: ${missing.join(', ')}`, { required: ['bpSystolic', 'bpDiastolic', 'pulse', 'glucose', 'oxygen', 'temp'] });
  b.vitals = { ...vitals, at: nowIso(), notes: String(v.notes || '').slice(0, 500) };
  store.audit('booking.vitals', req.user.phone, { bookingId: b.id });
  store.save();
  res.json(store.publicBooking(b, { includePaymentNumber: true }));
});

router.post('/bookings/:id/complete-provider', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.providerId !== req.user.providerId) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (b.status !== 'accepted') return bad(res, 409, `Cannot confirm completion while status is ${b.status}.`);
  if (!b.vitals) return bad(res, 409, 'Mandatory vitals must be recorded before completing the visit.');
  b.status = 'provider_confirmed';
  b.providerConfirmedAt = nowIso();
  store.audit('booking.provider_confirmed', req.user.phone, { bookingId: b.id, note: 'Provider confirmed completion before leaving; patient confirmation is separate.' });
  store.save();
  res.json(store.publicBooking(b, { includePaymentNumber: true }));
});

router.get('/providers/wallet', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  const mine = Object.values(store.data.bookings).filter((b) => b.providerId === p.id);
  const nowMs = Date.now();
  const ledger = mine.map((b) => {
    // v2.0.1 two-stage settlement: a released booking is only finally
    // settleable after the 24h complaint window ends with no open
    // complaint, or after an open complaint is rejected by admin.
    const released = ['released', 'auto_released'].includes(b.status);
    const pending = ['provider_confirmed', 'patient_confirmed', 'reviewed'].includes(b.status);
    let direction = 'pending';
    let amountEgp = 0;
    if (b.status === 'cancelled' || b.status === 'refunded') {
      direction = b.status; amountEgp = 0; // full refund — nothing to settle
    } else if (released) {
      const holdOpen = b.complaintStatus === 'open';
      // The window holds the money only while no complaint was resolved:
      // a REJECTED complaint makes the amount settleable at once, even
      // though the 24h deadline itself is still in the future.
      const windowOpen = b.complaintDeadline && nowMs < new Date(b.complaintDeadline).getTime() && b.complaintStatus !== 'rejected';
      if (holdOpen || windowOpen) {
        // Provisionally released, but held for the complaint window.
        direction = 'complaint_hold';
        amountEgp = b.cashCollectedByProvider ? (b.appShareEgp || 0) : (b.providerShareEgp || 0);
      } else if (b.cashCollectedByProvider) { direction = 'provider_owes_app'; amountEgp = b.appShareEgp || 0; }
      else { direction = 'app_owes_provider'; amountEgp = b.providerShareEgp || 0; }
    } else if (pending) { direction = 'pending'; amountEgp = b.providerShareEgp || 0; }
    return {
      bookingId: b.id, service: b.serviceName, status: b.status,
      totalEgp: b.amountEgp, appShareEgp: b.appShareEgp, providerShareEgp: b.providerShareEgp,
      commissionPct: b.commissionPct, cashCollectedByProvider: b.cashCollectedByProvider,
      direction, amountEgp, releasedAt: b.releasedAt || null,
      complaintStatus: b.complaintStatus || null, complaintDeadline: b.complaintDeadline || null,
      settleableAt: b.settleableAt || b.complaintDeadline || null, refundEgp: b.refundEgp || null,
    };
  });
  const totals = {
    appOwesProviderEgp: ledger.filter((l) => l.direction === 'app_owes_provider').reduce((s, l) => s + l.amountEgp, 0),
    providerOwesAppEgp: ledger.filter((l) => l.direction === 'provider_owes_app').reduce((s, l) => s + l.amountEgp, 0),
    pendingEgp: ledger.filter((l) => l.direction === 'pending').reduce((s, l) => s + l.amountEgp, 0),
    complaintHoldEgp: ledger.filter((l) => l.direction === 'complaint_hold').reduce((s, l) => s + l.amountEgp, 0),
  };
  res.json({
    providerId: p.id, tier: p.tier, commissionPct: cat.TIERS[p.tier].commission_pct,
    nextSettlementThursday: nextThursday(),
    note: 'Weekly settlement every Thursday (Uber-style ledger). If you collected cash by hand, the app share shows as "you owe the app" and is due on Thursday.',
    ledger, totals,
  });
});

// ---------------------------------------------------------------- interview
function buildAttemptQuestions() {
  // Shuffle question order AND option order; keep the answer key server-side.
  const questions = shuffle(cat.MCQ);
  const answerKey = {};
  const pub = questions.map((q) => {
    const opts = shuffle(q.options);
    answerKey[q.id] = q.correct;
    return { id: q.id, category: q.category, text: q.text, options: opts };
  });
  const en = shuffle(cat.ENGLISH_CHECK);
  const enKey = {};
  const enPub = en.map((q) => {
    enKey[q.id] = q.correct;
    return { id: q.id, text: q.text, options: shuffle(q.options) };
  });
  return { pub, answerKey, enPub, enKey };
}

router.post('/providers/interview/start', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  const rec = store.data.interviews[p.id] || { attempts: [], active: null };
  if (rec.active && new Date(rec.active.deadlineAt).getTime() > Date.now()) {
    return res.status(409).json({ error: 'conflict', message: 'An interview attempt is already in progress.', deadlineAt: rec.active.deadlineAt });
  }
  const { pub, answerKey, enPub, enKey } = buildAttemptQuestions();
  const attemptId = newId('int');
  const deadlineAt = new Date(Date.now() + config.interviewMinutes * 60 * 1000).toISOString();
  // pub/enPub are stored server-side so GET /questions can re-serve the same
  // shuffled attempt, and submit can map option indexes back to keys.
  rec.active = { attemptId, startedAt: nowIso(), deadlineAt, answerKey, enKey, pub, enPub };
  store.data.interviews[p.id] = rec;
  store.save();
  res.json({
    attemptId, deadlineAt, minutes: config.interviewMinutes, totalQuestions: 20,
    distribution: { medical: 5, ethics: 5, personal: 5, resilience: 5 },
    passRule: `Pass needs ${config.interviewPassTotal}/20 total AND at least ${config.interviewPassEthics}/5 in ethics.`,
    questions: pub, // NO answers included
    englishCheck: { note: 'Separate, unscored English check (3 simple questions). No certificate needed for English.', questions: enPub },
  });
});

// Compatibility: the web frontend GETs the questions (frontend shape:
// {id, cat, q:{ar,en}, opts:{ar:[...], en:[...]}}). If an attempt is already
// active, re-serve its shuffled questions; otherwise start a new attempt.
function translateQuestions(pub) {
  return pub.map((q) => ({
    id: q.id, cat: q.category,
    q: { ar: q.text, en: q.text },
    opts: { ar: q.options.map((o) => o.text), en: q.options.map((o) => o.text) },
  }));
}
router.get('/providers/interview/questions', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  const rec = store.data.interviews[p.id] || { attempts: [], active: null };
  let active = rec.active;
  if (!active || new Date(active.deadlineAt).getTime() <= Date.now()) {
    if (active) { rec.active = null; }
    const { pub, answerKey, enPub, enKey } = buildAttemptQuestions();
    active = {
      attemptId: newId('int'), startedAt: nowIso(),
      deadlineAt: new Date(Date.now() + config.interviewMinutes * 60 * 1000).toISOString(),
      answerKey, enKey, pub, enPub,
    };
    rec.active = active;
    store.data.interviews[p.id] = rec;
    store.save();
  }
  res.json({
    attemptId: active.attemptId, deadlineAt: active.deadlineAt, minutes: config.interviewMinutes,
    totalQuestions: 20, distribution: { medical: 5, ethics: 5, personal: 5, resilience: 5 },
    passRule: `Pass needs ${config.interviewPassTotal}/20 total AND at least ${config.interviewPassEthics}/5 in ethics.`,
    questions: translateQuestions(active.pub),
    englishCheck: { note: 'Separate, unscored English check (3 simple questions). No certificate needed for English.', questions: translateQuestions(active.enPub.map((q) => ({ ...q, category: 'english' }))) },
  });
});

router.post('/providers/interview/submit', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  const rec = store.data.interviews[p.id];
  // The frontend does not send attemptId — the single active attempt per
  // provider is authoritative. An explicit attemptId, if sent, must match.
  const active = rec?.active;
  if (!active || (req.body?.attemptId && req.body.attemptId !== active.attemptId)) {
    return bad(res, 409, 'No active interview attempt. Start one first.');
  }
  if (new Date(active.deadlineAt).getTime() < Date.now()) {
    rec.active = null;
    rec.attempts.push({ attemptId: active.attemptId, startedAt: active.startedAt, submittedAt: nowIso(), result: 'expired', scores: null, total: 0 });
    store.save();
    return res.status(410).json({ error: 'expired', message: 'The 20-minute interview deadline passed (server time). Start a new attempt.' });
  }
  // The frontend sends option INDEXES (0–3); map them back to option keys
  // using the stored shuffled order. Accept key strings too.
  const mapAnswers = (raw, pub) => {
    const out = {};
    for (const [qid, v] of Object.entries(raw || {})) {
      const q = (pub || []).find((x) => x.id === qid);
      if (!q) { out[qid] = v; continue; }
      const idx = Number(v);
      out[qid] = Number.isInteger(idx) && q.options[idx] ? q.options[idx].key : v;
    }
    return out;
  };
  const answers = mapAnswers(req.body?.answers, active.pub);
  const enAnswers = mapAnswers(req.body?.englishAnswers || req.body?.english, active.enPub);
  const scores = { medical: 0, ethics: 0, personal: 0, resilience: 0 };
  for (const q of cat.MCQ) {
    if (answers[q.id] === active.answerKey[q.id]) scores[q.category] += 1;
  }
  const total = scores.medical + scores.ethics + scores.personal + scores.resilience;
  let enCorrect = 0;
  for (const q of cat.ENGLISH_CHECK) {
    if (enAnswers[q.id] === active.enKey[q.id]) enCorrect += 1;
  }
  const passed = total >= config.interviewPassTotal && scores.ethics >= config.interviewPassEthics;
  const attempt = {
    attemptId: active.attemptId, startedAt: active.startedAt, submittedAt: nowIso(),
    scores, total, ethics: scores.ethics, passed, result: passed ? 'passed' : 'manual-review',
    english: { correct: enCorrect, total: 3, level: enCorrect >= 2 ? 'basic-ok' : 'needs-support', note: 'Unscored — reported separately; no certificate needed for English.' },
  };
  rec.attempts.push(attempt);
  rec.active = null;
  p.interviewStatus = passed ? 'passed' : 'manual-review';
  p.interviewScore = { scores, total };
  store.audit('provider.interview_submitted', req.user.phone, { providerId: p.id, total, scores, passed });
  store.save();
  res.json({
    ...attempt,
    message: passed
      ? 'Passed. Awaiting admin document verification before activation.'
      : 'Did not meet the pass rule — referred to manual review. A retake is allowed.',
  });
});

// ---------------------------------------------------------------- hotels
router.get('/hotels', requireAuth, (req, res) => {
  const zone = req.query.zone;
  const list = zone ? store.data.hotels.filter((h) => h.zone === zone) : store.data.hotels;
  res.json({ count: list.length, hotels: list });
});

router.get('/hotels/:id', requireAuth, (req, res) => {
  const h = store.data.hotels.find((x) => x.id === req.params.id);
  if (!h) return res.status(404).json({ error: 'not_found', message: 'Hotel not found.' });
  res.json(h);
});

// ---------------------------------------------------------------- tourist bookings
router.post('/tourist-bookings', requireAuth, (req, res) => {
  const b = normalizeBookingBody(req.body);
  if (b.respectCharterAccepted !== true) return bad(res, 400, 'Respect charter must be accepted (respectCharterAccepted=true).');
  const svc = cat.TOURIST_SERVICES[b.serviceCode];
  if (!svc) return bad(res, 400, 'Valid tourist serviceCode required (tourist_doctor, tourist_iv, tourist_dressing, tourist_nurse).');
  const currency = (b.currency || 'usd').toLowerCase();
  if (!['usd', 'eur'].includes(currency)) return bad(res, 400, 'currency must be usd or eur.');
  if (!['cash_receipt', 'instapay', 'card'].includes(b.paymentMethod)) return bad(res, 400, 'paymentMethod must be cash_receipt, instapay or card.');
  if (!b.patientName) return bad(res, 400, 'patientName required.');
  const triage = b.triage || {};
  const danger = (triage.dangerSigns || []).filter((s) => cat.DANGER_SIGNS.includes(s));
  if (triage.danger === true || danger.length > 0) {
    return res.status(422).json({ error: 'emergency_triage', message: 'Danger sign detected — call the ambulance now.', ambulance: '123', danger_signs: danger });
  }
  let distanceKm = b.distanceKm;
  let hotel = null;
  if (b.hotelId) {
    hotel = store.data.hotels.find((h) => h.id === b.hotelId);
    if (!hotel) return bad(res, 400, 'Unknown hotel id.');
    distanceKm = hotel.distance_km;
  }
  if (distanceKm == null) return bad(res, 400, 'distanceKm or hotelId required.');
  const fee = cat.distanceFee(distanceKm, b.transport);
  if (fee.error) return bad(res, 400, fee.error);
  if (fee.contract_required) {
    return res.status(422).json({ error: 'contract_required', distanceKm, message: 'Over 35 km: special contract only, no automatic pricing.' });
  }
  const fx = currency === 'usd' ? config.usdEgp : config.eurEgp;
  const base = svc[currency];
  const urgent = b.urgent === true ? cat.TOURIST_URGENT_EXTRA[currency] : 0;
  const distanceForeign = Math.round((fee.fee_egp / fx) * 100) / 100;
  const amountForeign = Math.round((base + urgent + distanceForeign) * 100) / 100;
  const amountEgp = Math.round(amountForeign * fx);
  const language = b.language ? String(b.language).toLowerCase() : 'en';
  const id = newId('bk');
  const booking = {
    id, kind: 'tourist', patientPhone: req.user.phone, patientName: b.patientName,
    serviceCode: b.serviceCode, serviceName: svc.name_en, status: 'held',
    amountEgp, baseEgp: Math.round(base * fx), distanceFeeEgp: fee.fee_egp,
    distanceKm, distanceBand: fee.band, distanceEstimate: true,
    transport: b.transport || 'none', hotelId: b.hotelId || null,
    currency: currency.toUpperCase(), amountForeign, fxRate: fx, fxNote: 'Approximate rate — override via USD_EGP / EUR_EGP env.',
    urgent: b.urgent === true, language,
    languageBonus: language !== 'en'
      ? { amount: cat.EXTRA_LANGUAGE_BONUS[currency], currency: currency.toUpperCase(), appliesIf: 'Assigned provider holds a certificate for this language (non-English only). Added at release, not at booking.' }
      : null,
    paymentMethod: b.paymentMethod, respectCharterAccepted: true,
    triage: { dangerSigns: danger, notes: triage.notes || null },
    insurer: b.insurer || null, policyNo: b.policyNo || null, passportNo: b.passportNo ? `****${String(b.passportNo).slice(-4)}` : null,
    nationality: b.nationality || null, diagnosis: b.diagnosis || null,
    address: b.address || null, scheduledAt: b.scheduledAt || null, notes: b.notes || null,
    providerId: null, commissionPct: null, providerShareEgp: null, appShareEgp: null,
    vitals: null, review: null, providerReview: null, complaint: false,
    complaintStatus: null, complaintDeadline: null, complaintAt: null, complaintResolvedAt: null,
    settleableAt: null, cancelledAt: null, refundedAt: null, refundEgp: null,
    cashCollectedByProvider: false, overdue: false,
    createdAt: nowIso(), acceptedAt: null, providerConfirmedAt: null,
    patientConfirmedAt: null, reviewedAt: null, releasedAt: null, releaseMode: null,
  };
  store.data.bookings[id] = booking;
  store.audit('tourist_booking.created', req.user.phone, { bookingId: id, serviceCode: b.serviceCode, amountForeign, currency });
  store.save();
  res.status(201).json(store.publicBooking(booking));
});

// Insurance report — Phase 1: stamped ELECTRONIC report only (EN/DE).
// The tourist submits it to their insurer themselves. No direct billing.
router.get('/bookings/:id/insurance-report', requireAuth, (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (!canSeeBooking(req, b)) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  const lang = (req.query.lang || 'en').toLowerCase();
  if (!['en', 'de'].includes(lang)) return bad(res, 400, 'lang must be en or de (Phase 1).');
  const p = b.providerId ? store.data.providers[b.providerId] : null;
  const cur = b.currency || 'EGP';
  const items = [
    { item: b.serviceName, amount: b.amountForeign ?? b.baseEgp, currency: cur },
    { item: lang === 'de' ? 'Entfernungspauschale' : 'Distance fee', amount: b.currency === 'EGP' ? b.distanceFeeEgp : Math.round((b.distanceFeeEgp / (b.fxRate || 1)) * 100) / 100, currency: cur },
  ];
  if (b.urgent) items.push({ item: lang === 'de' ? 'Dringlichkeitszuschlag' : 'Urgent surcharge', amount: cat.TOURIST_URGENT_EXTRA[cur.toLowerCase()] || 0, currency: cur });
  const report = {
    reportId: `INS-${b.id}`,
    language: lang,
    issuedAt: nowIso(),
    patient: { name: b.patientName, nationality: b.nationality || null, passport: b.passportNo || null, insurer: b.insurer || null, policyNo: b.policyNo || null },
    diagnosis: b.diagnosis || (lang === 'de' ? 'Siehe Behandlungsnotizen' : 'See treatment notes'),
    procedures: [{ service: b.serviceName, at: b.providerConfirmedAt || b.createdAt }],
    vitals: b.vitals || null,
    invoice: { items, total: b.amountForeign ?? b.amountEgp, currency: cur, totalEgp: b.amountEgp },
    provider: p ? { name: p.name, role: p.role, license: `****${p.licenseLast4}`, licenseVerified: p.status === 'verified' } : null,
    stamp: {
      text: lang === 'de' ? 'Elektronisch gestempelt — Shifa Care, El Quseir' : 'Electronically stamped — Shifa Care, El Quseir',
      signature: p ? `${p.name} (provider signature on file)` : 'pending provider assignment',
      note: lang === 'de'
        ? 'Phase 1: Nur elektronischer Bericht. Der Gast reicht ihn selbst bei seiner Versicherung ein. Keine Direktabrechnung.'
        : 'Phase 1: stamped electronic report only. The tourist submits it to their insurer themselves. No direct billing.',
    },
  };
  if (req.query.format === 'html' || (req.headers.accept || '').includes('text/html')) {
    const t = lang === 'de'
      ? { title: 'Medizinischer Bericht / Rechnung', patient: 'Patient', diagnosis: 'Diagnose', procedures: 'Behandlungen', vitals: 'Vitalzeichen', invoice: 'Rechnung', total: 'Gesamt', provider: 'Behandler', stamp: 'Stempel / Unterschrift' }
      : { title: 'Medical Report / Invoice', patient: 'Patient', diagnosis: 'Diagnosis', procedures: 'Procedures', vitals: 'Vital signs', invoice: 'Invoice', total: 'Total', provider: 'Provider', stamp: 'Stamp / Signature' };
    const html = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><title>${t.title} ${report.reportId}</title><style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 16px;color:#111}h1{font-size:22px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left}.stamp{border:2px solid #333;padding:16px;margin-top:24px;text-align:center}</style></head><body><h1>Shifa Care — ${t.title}</h1><p>${report.reportId} · ${report.issuedAt}</p><h2>${t.patient}</h2><p>${report.patient.name}${report.patient.nationality ? ` · ${report.patient.nationality}` : ''}${report.patient.passport ? ` · Passport ${report.patient.passport}` : ''}</p><h2>${t.diagnosis}</h2><p>${report.diagnosis}</p><h2>${t.procedures}</h2><ul>${report.procedures.map((x) => `<li>${x.service}</li>`).join('')}</ul><h2>${t.vitals}</h2><p>${report.vitals ? JSON.stringify(report.vitals) : '—'}</p><h2>${t.invoice}</h2><table><tr><th>Item</th><th>Amount</th></tr>${report.invoice.items.map((i) => `<tr><td>${i.item}</td><td>${i.amount} ${i.currency}</td></tr>`).join('')}<tr><td><b>${t.total}</b></td><td><b>${report.invoice.total} ${report.invoice.currency} (${report.invoice.totalEgp} EGP)</b></td></tr></table><h2>${t.provider}</h2><p>${report.provider ? `${report.provider.name} (${report.provider.role}) — Licence ****${p.licenseLast4}` : '—'}</p><div class="stamp"><b>${report.stamp.text}</b><br>${report.stamp.signature}<br><small>${report.stamp.note}</small></div></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }
  res.json(report);
});

// ---------------------------------------------------------------- NPWT
router.post('/npwt/calculate', requireAuth, (req, res) => {
  const days = Number(req.body?.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) return bad(res, 400, 'days must be an integer 1–90.');
  let kitPrice = req.body?.kitPrice == null ? 300 : Number(req.body.kitPrice);
  if (!Number.isFinite(kitPrice) || kitPrice < 250 || kitPrice > 350) return bad(res, 400, 'kitPrice must be 250–350 EGP (invoice price).');
  // Dressing every 3 days; 5 dressings in a 14-day course.
  const dressings = Math.ceil(days / 3);
  const visitCost = dressings * 600; // specialist dressing visit
  const kitCost = dressings * kitPrice; // kit (foam + dressing + tubes) per dressing
  let rental;
  if (days <= 7) rental = 750;
  else if (days <= 15) rental = 1000;
  else rental = 1000 + 750 * Math.ceil((days - 15) / 7);
  const canisterFull = req.body?.canisterFull === true;
  const canisterPrice = canisterFull ? Number(req.body?.canisterPrice || 0) : 0;
  if (canisterFull && (!Number.isFinite(canisterPrice) || canisterPrice < 0)) return bad(res, 400, 'canisterPrice must be a non-negative number when canisterFull=true.');
  const total = rental + visitCost + kitCost + canisterPrice;
  res.json({
    days, dressings, schedule: 'Dressing every 3 days',
    breakdown: {
      deviceRentalEgp: rental, rentalRule: days <= 7 ? '750/week' : days <= 15 ? '1000/15 days' : '1000/15 days + 750 per extra week',
      visitsEgp: visitCost, visitUnitEgp: 600, visits: dressings,
      kitsEgp: kitCost, kitUnitEgp: kitPrice, kits: dressings,
      canisterEgp: canisterPrice, canisterNote: canisterFull ? 'Canister replaced because full — charged separately.' : 'Canister changed separately ONLY when full.',
    },
    totalEgp: total,
    reference: 'A single full dressing ≈ 1,100 EGP; a full 14-day course (5 dressings) ≈ 5,250–6,250 EGP.',
    requiresDoctorOrder: true,
    doctorOrderProvided: req.body?.doctorOrderProvided === true,
    warning: req.body?.doctorOrderProvided === true ? null : 'A written doctor order (doctor name + order number) is required before starting NPWT, plus the safety checklist (foam count in/out, bleeding check, canister status) and a wound photo at every visit. Real NPWT device with true negative pressure only.',
  });
});

// ---------------------------------------------------------------- post-op
router.post('/postop', requireAuth, (req, res) => {
  const b = normalizeBookingBody(req.body);
  if (b.respectCharterAccepted !== true) return bad(res, 400, 'Respect charter must be accepted (respectCharterAccepted=true).');
  if (!b.patientName) return bad(res, 400, 'patientName required.');
  if (!b.surgeryType) return bad(res, 400, 'surgeryType required.');
  if (!['cash_receipt', 'instapay'].includes(b.paymentMethod)) return bad(res, 400, 'paymentMethod must be cash_receipt or instapay.');
  const priced = priceBooking({ serviceCode: 'postop', distanceKm: b.distanceKm, hotelId: b.hotelId, transport: b.transport });
  if (priced.error) return bad(res, 400, priced.error);
  if (priced.contract_required) return res.status(422).json({ error: 'contract_required', ...priced });
  const id = newId('bk');
  const booking = {
    id, kind: 'postop', patientPhone: req.user.phone, patientName: b.patientName,
    serviceCode: 'postop', serviceName: cat.SERVICES.postop.name_en, status: 'held',
    amountEgp: priced.totalEgp, baseEgp: priced.baseEgp, distanceFeeEgp: priced.distanceFeeEgp,
    distanceKm: priced.distanceKm, distanceBand: priced.band, distanceEstimate: true,
    transport: b.transport || 'none', hotelId: b.hotelId || null,
    currency: 'EGP', amountForeign: null, fxRate: null,
    paymentMethod: b.paymentMethod, respectCharterAccepted: true,
    triage: { dangerSigns: [], notes: null },
    surgeryType: b.surgeryType, surgeonInstructions: b.surgeonInstructions || null,
    dressingSchedule: b.dressingSchedule || null, drainNotes: b.drainNotes || null,
    address: b.address || null, scheduledAt: b.scheduledAt || null, notes: b.notes || null,
    providerId: null, commissionPct: null, providerShareEgp: null, appShareEgp: null,
    vitals: null, review: null, providerReview: null, complaint: false,
    complaintStatus: null, complaintDeadline: null, complaintAt: null, complaintResolvedAt: null,
    settleableAt: null, cancelledAt: null, refundedAt: null, refundEgp: null,
    cashCollectedByProvider: false, overdue: false,
    createdAt: nowIso(), acceptedAt: null, providerConfirmedAt: null,
    patientConfirmedAt: null, reviewedAt: null, releasedAt: null, releaseMode: null,
  };
  store.data.bookings[id] = booking;
  store.audit('postop.created', req.user.phone, { bookingId: id, surgeryType: b.surgeryType, totalEgp: booking.amountEgp });
  store.save();
  res.status(201).json(store.publicBooking(booking));
});

// ---------------------------------------------------------------- admin
router.post('/admin/pin/verify', (req, res) => {
  const pin = String(req.body?.pin || '');
  const rec = store.data.adminPin;
  if (rec.lockedUntil && new Date(rec.lockedUntil).getTime() > Date.now()) {
    return res.status(423).json({ error: 'locked', message: 'Admin PIN locked after 5 failed attempts. Try again later.', lockedUntil: rec.lockedUntil });
  }
  if (!/^\d{6,}$/.test(pin) || !bcrypt.compareSync(pin, rec.hash)) {
    rec.failures = (rec.failures || 0) + 1;
    if (rec.failures >= config.adminPinMaxAttempts) {
      rec.lockedUntil = new Date(Date.now() + config.adminPinLockMinutes * 60 * 1000).toISOString();
      rec.failures = 0;
      store.audit('admin.pin_locked', req.ip, { attempts: config.adminPinMaxAttempts }, req.ip);
    } else {
      store.audit('admin.pin_failed', req.ip, { failures: rec.failures }, req.ip);
    }
    store.save();
    return res.status(401).json({ error: 'unauthorized', message: 'Wrong admin PIN.', attemptsLeft: Math.max(0, config.adminPinMaxAttempts - (rec.failures || 0)) });
  }
  rec.failures = 0;
  rec.lockedUntil = null;
  store.save();
  store.audit('admin.pin_verified', 'admin', {}, req.ip);
  res.json({ ok: true, token: issueAdminToken(), expiresInSeconds: 30 * 60, role: 'admin' });
});

router.get('/admin/dashboard', requireAuth, requireRole('admin'), (req, res) => {
  // Aggregate view the web frontend expects, with its field names.
  const providers = Object.values(store.data.providers).map((p) => {
    const pub = store.publicProvider(p);
    return { ...pub, licenceLast4: pub.licenseLast4, rating: pub.ratingAvg, visits: pub.completedVisits };
  });
  const sosAlerts = store.data.sos.slice().reverse().map((s) => ({ ...s, createdAt: s.at }));
  const overdue = Object.values(store.data.bookings)
    .filter((b) => b.overdue && ['accepted', 'provider_confirmed'].includes(b.status))
    .map((b) => ({ id: b.id, service: b.serviceName, startedAt: b.acceptedAt, providerId: b.providerId }));
  const bookings = Object.values(store.data.bookings).slice(-100).reverse().map((b) => ({
    id: b.id, service: b.serviceCode, serviceName: b.serviceName, total: b.amountEgp, status: b.status, createdAt: b.createdAt,
  }));
  const auditLog = store.data.audit.slice(-100).reverse().map((a) => ({
    createdAt: a.ts, action: a.action, actor: a.actor, detail: JSON.stringify(a.details || {}),
  }));
  res.json({ providers, sosAlerts, lateVisits: overdue, bookings, auditLog });
});

router.get('/admin/providers', requireAuth, requireRole('admin'), (req, res) => {
  res.json(Object.values(store.data.providers).map((p) => store.publicProvider(p)));
});

router.post('/admin/providers/:id/tier', requireAuth, requireRole('admin'), (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const tier = req.body?.tier;
  if (!cat.TIERS[tier]) return bad(res, 400, 'tier must be Starter, Pro or Elite.');
  const old = p.tier;
  p.tier = tier;
  store.audit('admin.tier_changed', 'admin', { providerId: p.id, from: old, to: tier });
  store.save();
  res.json(store.publicProvider(p));
});

router.post('/admin/providers/:id/verify', requireAuth, requireRole('admin'), (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const verifiedCertificates = Number(req.body?.verifiedCertificates);
  if (Number.isFinite(verifiedCertificates)) {
    p.verifiedCertificates = Math.max(0, Math.min(3, Math.floor(verifiedCertificates))); // +5 pts each, max 15
  }
  p.status = 'verified';
  store.audit('admin.provider_verified', 'admin', { providerId: p.id, verifiedCertificates: p.verifiedCertificates });
  store.save();
  res.json(store.publicProvider(p));
});

// v2.0.1 — admin resolves a complaint. Accepted => full refund to the
// patient (booking becomes 'refunded', provider/app shares removed from
// the wallet; a cash refund is deducted from the provider's settleable
// balance at Thursday settlement). Rejected => the held amount becomes
// finally settleable at once (and a paused 'reviewed' release proceeds).
router.post('/admin/complaints/:reportId/resolve', requireAuth, requireRole('admin'), (req, res) => {
  const report = store.data.safetyReports.find((r) => r.id === req.params.reportId);
  if (!report) return res.status(404).json({ error: 'not_found', message: 'Complaint report not found.' });
  if (report.type !== 'complaint') return bad(res, 400, 'Only complaint reports can be resolved here.');
  if (report.status !== 'open') return bad(res, 409, `Complaint already ${report.status}.`);
  const decision = req.body?.decision;
  if (!['accepted_refund', 'rejected'].includes(decision)) {
    return bad(res, 400, 'decision must be accepted_refund or rejected.');
  }
  const b = store.data.bookings[report.bookingId];
  if (!b) return res.status(404).json({ error: 'not_found', message: 'Booking for this complaint not found.' });
  report.status = decision === 'accepted_refund' ? 'resolved_refunded' : 'resolved_rejected';
  report.resolvedAt = nowIso();
  report.resolution = decision;
  if (decision === 'accepted_refund') {
    b.complaintStatus = 'accepted_refund';
    b.complaintResolvedAt = nowIso();
    b.complaint = false;
    b.refundEgp = b.amountEgp; // full refund to the patient
    b.refundedAt = nowIso();
    b.refundedShares = { appShareEgp: b.appShareEgp || 0, providerShareEgp: b.providerShareEgp || 0 };
    b.appShareEgp = 0;
    b.providerShareEgp = 0;
    b.status = 'refunded';
    store.audit('complaint.resolved_refund', 'admin', { bookingId: b.id, reportId: report.id, refundEgp: b.refundEgp });
  } else {
    b.complaintStatus = 'rejected';
    b.complaintResolvedAt = nowIso();
    b.complaint = false;
    b.settleableAt = nowIso(); // finally settleable at once
    store.audit('complaint.resolved_rejected', 'admin', { bookingId: b.id, reportId: report.id });
    // If the release was paused in 'reviewed' by this complaint, release now.
    if (b.status === 'reviewed') releaseBooking(b, 'reviewed');
    else if (b.status === 'patient_confirmed' && b.patientConfirmedAt
      && Date.now() - new Date(b.patientConfirmedAt).getTime() >= config.autoReleaseAfterMs) {
      releaseBooking(b, 'auto');
    }
  }
  store.save();
  res.json({ ok: true, report, booking: store.publicBooking(b, { includePaymentNumber: false }) });
});

router.get('/admin/sos', requireAuth, requireRole('admin'), (req, res) => {
  const open = req.query.open === 'true';
  const list = open ? store.data.sos.filter((s) => s.status === 'open') : store.data.sos;
  const overdue = Object.values(store.data.bookings)
    .filter((b) => b.overdue && ['accepted', 'provider_confirmed'].includes(b.status))
    .map((b) => ({ bookingId: b.id, providerId: b.providerId, acceptedAt: b.acceptedAt, note: 'Visit open >120 minutes without closure.' }));
  res.json({ sos: list.slice().reverse(), overdue, safetyReports: store.data.safetyReports.slice().reverse() });
});

router.get('/admin/audit', requireAuth, requireRole('admin'), (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 100);
  res.json(store.data.audit.slice(-limit).reverse());
});

// Dev only: shows last OTP codes for testing. Gated by MOCK_OTP=true.
// Default OFF in production — never enable there.
router.get('/admin/mock-otp', requireAuth, requireRole('admin'), (req, res) => {
  if (!config.mockOtp) {
    return res.status(404).json({ error: 'not_found', message: 'Mock OTP endpoint is disabled (MOCK_OTP is not true).' });
  }
  const codes = Object.entries(store.data.otps).map(([phone, r]) => ({
    phone, channel: r.channel, expiresAt: r.expiresAt, attempts: r.attempts,
    note: 'DEV ONLY — in mock mode the code is also logged to the server console.',
  }));
  const qPhone = normalizePhone(req.query.phone || '');
  const demo = [{ phone: '01000000001', code: DEMO_OTP }, { phone: '01000000002', code: DEMO_OTP }];
  res.json({
    mockOtp: true,
    demoPhones: demo,
    // The web frontend reads `code` for the requested phone (demo phones only).
    code: qPhone ? (demo.find((d) => d.phone === qPhone) || {}).code || null : null,
    otp: qPhone ? (demo.find((d) => d.phone === qPhone) || {}).code || null : null,
    pending: codes,
  });
});

module.exports = { router, sweepAutoRelease };
