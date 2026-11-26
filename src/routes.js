// All /api routes. Auth rule: ONLY bootstrap, otp/*, auth/login-phone,
// auth/refresh and admin/pin/verify are public. Everything else requires a valid JWT, and
// ownership / role checks happen server-side on every request.
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('./config');
const crypto = require('crypto');
const { store, sha256, saltedSha256, newId, nowIso, isNight } = require('./store');
const { makeCode, hashOtpCode, verifyOtpCode, getMockCode, pickProvider, normalizePhone } = require('./otp');
const { issueTokens, verifyRefreshToken, detectRefreshReuse, revokeRefreshToken, requireAuth, requireRole, requireAdmin, issueAdminToken } = require('./auth');
const { computePoints, isoWeekKey, currentWeekKey, touristCompatible, touristCompatibleFor, hasLanguageBadge, englishBlocked } = require('./points');
const cat = require('./catalog');
const { evaluateProviderDocuments } = require('./evaluate');
const notify = require('./notify');

const router = express.Router();

// v2.1.1 (audit #26): '__proto__' / 'constructor' / 'prototype' are never
// valid ids — reject them at the router level before any store lookup
// (a lookup like store.data.providers['__proto__'] returns
// Object.prototype, which is truthy and would be mutated otherwise).
router.param('id', (req, res, next, id) => {
  if (isReservedId(id)) return res.status(400).json({ error: 'validation_error', message: 'Invalid identifier.' });
  return next();
});
router.param('providerId', (req, res, next, id) => {
  if (isReservedId(id)) return res.status(400).json({ error: 'validation_error', message: 'Invalid identifier.' });
  return next();
});
router.param('reportId', (req, res, next, id) => {
  if (isReservedId(id)) return res.status(400).json({ error: 'validation_error', message: 'Invalid identifier.' });
  return next();
});

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
  if (isReservedId(req.params.id)) { res.status(400).json({ error: 'validation_error', message: 'Invalid identifier.' }); return null; }
  const b = store.data.bookings[req.params.id];
  if (!b) { res.status(404).json({ error: 'not_found', message: 'Booking not found.' }); return null; }
  return b;
}
function canSeeBooking(req, b) {
  if (req.user.role === 'admin') return true;
  if (req.user.role === 'patient' && b.patientPhone === req.user.phone) return true;
  if (req.user.role === 'provider' && b.providerId && req.user.providerId === b.providerId) return true;
  // v2.1.3 — a package's SUBSTITUTE provider also sees that package
  // (their 4 extra days live on it), but nothing else of it.
  if (req.user.role === 'provider' && b.kind === 'package' && b.substituteProviderId && req.user.providerId === b.substituteProviderId) return true;
  return false;
}
// Viewer-aware booking serializer: pass the request user so the
// serializer can mask PII for unassigned providers (see store.js).
function pubBooking(req, b, opts = {}) {
  const viewer = req.user ? { role: req.user.role, phone: req.user.phone, providerId: req.user.providerId } : null;
  return store.publicBooking(b, { ...opts, viewer });
}
// ---------------------------------------------------------------- v2.0.8 — Terms & Conditions + anti-circumvention
// Terms acceptance is enforced server-side: registration and booking
// creation require acceptedTerms=true with the CURRENT termsVersion.
// The client also gates first use behind the same version (see
// /api/me/terms), but the server check is what actually binds.
function termsAccepted(body) {
  return body && body.acceptedTerms === true && body.termsVersion === config.termsVersion;
}
function termsError(res) {
  return bad(res, 400, `You must read and accept the current Terms & Conditions (version ${config.termsVersion}) before continuing.`, { termsVersion: config.termsVersion });
}
function recordTermsAcceptance(phone) {
  const u = store.data.users[phone] || (store.data.users[phone] = { phone, createdAt: nowIso() });
  u.termsAcceptedVersion = config.termsVersion;
  u.termsAcceptedAt = nowIso();
}
// A suspended (or permanently banned) provider cannot take new work:
// radar, accept, vitals, completion and cash collection are all blocked.
function providerBlocked(p) {
  if (!p) return null;
  if (p.permanentBan) return 'This provider account is permanently banned. Contact admin.';
  if (p.suspended) return 'This provider account is suspended. Contact admin.';
  return null;
}
// --- v2.1.1 helpers --------------------------------------------------
// Reject prototype-pollution / reserved identifiers anywhere they are
// used as ids (audit #26).
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
function isReservedId(id) { return typeof id === 'string' && RESERVED_IDS.has(id); }
function rejectReservedId(req, res) {
  if (isReservedId(req.params.id) || isReservedId(req.params.providerId) || isReservedId(req.params.reportId)) {
    res.status(400).json({ error: 'validation_error', message: 'Invalid identifier.' });
    return true;
  }
  return false;
}
// HTML-escape for the insurance report (audit #13).
function escapeHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// v2.1.1 — EXPLICIT WRITTEN CONSENT for high-risk services (owner
// decision 26 Nov 2026, after legal review): the patient must give
// explicit written consent (consentGiven=true) before booking a
// high-risk service. Returns true when the request must be rejected
// (response already sent). Standard services are unaffected.
function requireHighRiskConsent(req, res, serviceCode) {
  if (!cat.isHighRiskService(serviceCode)) return false;
  if (req.body?.consentGiven === true) return false;
  res.status(400).json({ error: 'explicit_consent_required', message: 'هذه الخدمة عالية الخطورة وتتطلب موافقة كتابية صريحة من المريض قبل الحجز.' });
  return true;
}
// ---------------------------------------------------------------- v2.1.2 — languages, documents, receipts
// Language list (data-driven: admin can add languages; a language is
// testable only when a question bank exists for it in catalog.js).
function languageList() {
  return (store.data.languages || cat.DEFAULT_LANGUAGES).map((l) => ({
    ...l, testAvailable: !!cat.LANGUAGE_TESTS[l.code],
  }));
}
function findLanguage(code) {
  const c = String(code || '').toLowerCase();
  return (store.data.languages || []).find((l) => l.code === c) || null;
}
// Parse a base64 data URL (data:<mime>;base64,<payload>). Returns
// {mime, size, data} or {error}. Size is the DECODED byte count.
function parseDataUrl(raw, { allowedMimes, maxBytes, label }) {
  if (typeof raw !== 'string') return { error: `${label} must be a base64 data URL.` };
  const m = raw.match(/^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return { error: `${label} must be a base64 data URL (data:<type>;base64,...).` };
  const mime = m[1].toLowerCase();
  if (!allowedMimes.includes(mime)) return { error: `${label} must be one of: ${allowedMimes.join(', ')}.` };
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return { error: `${label} is not valid base64.` }; }
  if (!buf.length || buf.length > maxBytes) return { error: `${label} is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).` };
  return { mime, size: buf.length, data: raw };
}
// Receipt upload at booking creation (v2.1.2): online payment only
// (InstaPay / card). Cash bookings use a receipt at the visit, so a
// receipt image with cash is rejected, not silently ignored.
const RECEIPT_MAX_BYTES = 3 * 1024 * 1024; // 3 MB, JPEG/PNG only
const RECEIPT_MIMES = ['image/jpeg', 'image/png'];
function receiptFromBody(body, paymentMethod) {
  const raw = body?.receiptImage || body?.receipt;
  if (!raw) return { receipt: null, image: null };
  if (paymentMethod === 'cash_receipt') {
    return { error: 'Cash payments use a receipt at the visit — no receipt photo is needed at booking.' };
  }
  const parsed = parseDataUrl(raw, { allowedMimes: RECEIPT_MIMES, maxBytes: RECEIPT_MAX_BYTES, label: 'Receipt photo' });
  if (parsed.error) return { error: parsed.error };
  return {
    receipt: { uploadedAt: nowIso(), status: 'pending', reviewedAt: null, note: null },
    image: { mime: parsed.mime, size: parsed.size, data: parsed.data, uploadedAt: nowIso() },
  };
}
function attachReceipt(booking, parsed) {
  booking.receipt = parsed && parsed.receipt ? parsed.receipt : null;
  if (parsed && parsed.image) store.data.receiptImages[booking.id] = parsed.image;
  booking.receiptStatus = receiptStatusOf(booking);
}
function receiptPending(b) { return !!(b.receipt && b.receipt.status === 'pending'); }
// v2.1.6 (C6): an online payment (InstaPay / card) is one that is NOT
// cash-with-receipt. Cash bookings never need a receipt photo.
function isOnlinePayment(b) {
  return !!(b && b.paymentMethod && b.paymentMethod !== 'cash_receipt');
}
// v2.1.6 (C6): a booking is receipt-blocked when its receipt is under
// review OR when an online payment has NO receipt at all (the old code
// only blocked the "pending" case, so a booking created without a
// receipt slipped through the radar/accept gates). Cash is never blocked.
function receiptBlocked(b) {
  if (!b) return false;
  if (receiptPending(b)) return true;
  if (isOnlinePayment(b) && !b.receipt) return true;
  return false;
}
// v2.1.6 (C6): receipt status flag, kept in sync with b.receipt so the
// admin UI and the gates can tell "no receipt" from "under review".
// 'not_required' (cash) | 'missing' (online, no receipt) | 'pending' |
// 'approved' | 'rejected'.
function receiptStatusOf(b) {
  if (!isOnlinePayment(b)) return 'not_required';
  if (!b.receipt) return 'missing';
  return b.receipt.status || 'pending';
}
// v2.1.6 (C6): receipt is MANDATORY for online payment at booking
// creation — call after receiptFromBody in every creation path. Returns
// an error string when the receipt is missing (the caller sends 400),
// or null when the payment is cash or the receipt is present.
function receiptRequiredError(paymentMethod, parsed) {
  if (paymentMethod === 'cash_receipt') return null;
  if (!parsed || !parsed.receipt) return 'Online payment (InstaPay / card) requires a receipt photo — upload it at booking.';
  return null;
}
// Re-run the CV/certificate evaluation after anything that changes the
// inputs (document upload, admin credential verify).
function refreshCvEvaluation(p) {
  if (!p) return null;
  p.cvEvaluation = evaluateProviderDocuments(p);
  return p.cvEvaluation;
}
// Length caps (M11): name <=120, notes <=1000, address <=300,
// complaint <=1000, safety text <=1000.
function capStr(v, max) { return v == null ? v : String(v).slice(0, max); }
function validScheduledAt(v) {
  if (v == null || v === '') return true; // optional
  const d = new Date(v);
  return Number.isFinite(d.getTime());
}
// Recompute a provider's points + auto-promote (audit #17). Runs on
// interview submit, admin credential verify and booking release.
function recomputeProviderPoints(p, { auditTier = true } = {}) {
  if (!p) return null;
  const pts = computePoints(p, Object.values(store.data.bookings));
  p.points = pts;
  p.ratingAvg = pts.ratingAvg;
  p.casesByWeek = pts.casesByWeek;
  if (pts.tier !== p.tier) {
    const from = p.tier;
    p.tier = pts.tier;
    if (auditTier) store.audit('points.tier_changed', p.id, { from, to: pts.tier, points: pts.total });
  }
  return pts;
}
// Stay bonus (v2.1.1): 250 EGP, earned when 90 days since joining AND
// >=10 completed cases. Paid once, via a settlement record.
function stayBonusState(p) {
  const joined = p.joinedAt ? new Date(p.joinedAt).getTime() : Date.now();
  const days = Math.floor((Date.now() - joined) / (24 * 60 * 60 * 1000));
  const cases = (p.points && typeof p.points.totalCases === 'number')
    ? p.points.totalCases
    : Object.values(store.data.bookings).filter((b) => b.providerId === p.id && (b.status === 'released' || b.status === 'auto_released')).length;
  const earned = days >= cat.STAY_BONUS_DAYS && cases >= cat.STAY_BONUS_MIN_CASES;
  return {
    eligibleAt: new Date(joined + cat.STAY_BONUS_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    amountEgp: cat.STAY_BONUS_EGP, earned, paid: !!p.stayBonusPaid, daysSinceJoin: days,
  };
}
// v2.1.6 (C3): the volume bonus is paid ONCE per month — only the
// INCREASE over what was already paid this month is due. The paid
// amount is tracked on the provider record (volumeBonusPaid {month,
// amountEgp}); older records are recovered by summing this month's
// settlement records (self-heal for data written before v2.1.6).
function volumeBonusPaidThisMonth(p, key) {
  if (p.volumeBonusPaid && p.volumeBonusPaid.month === key) return p.volumeBonusPaid.amountEgp || 0;
  let sum = 0;
  for (const s of (store.data.settlements || [])) {
    if (s.providerId === p.id && (s.generatedAt || '').slice(0, 7) === key) sum += s.totals?.volumeBonusEgp || 0;
  }
  return sum;
}
function volumeBonusDue(p, key) {
  const vb = volumeBonusFor(p.id, key);
  if (vb.paused) return { ...vb, paidEgp: 0, dueEgp: 0 };
  const paid = volumeBonusPaidThisMonth(p, key);
  return { ...vb, paidEgp: paid, dueEgp: Math.max(0, (vb.bonusEgp || 0) - paid) };
}
// v2.1.6 (C4): a standard booking is settleable only once it is
// released, past its 24h complaint window (settleableAt), with no open
// complaint and no circumvention hold.
function isSettleableBooking(b, nowMs) {
  if (!['released', 'auto_released'].includes(b.status)) return false;
  if (b.complaintStatus === 'open' || b.circumventionHold) return false;
  if (b.settleableAt && nowMs < new Date(b.settleableAt).getTime()) return false;
  return true;
}
// v2.1.6 (C4): when a SETTLED booking is later refunded (complaint
// accepted after its settlement, or a confirmed circumvention report),
// the refunded shares become a reversing adjustment deducted from the
// provider's NEXT settlement record — money already "paid" on paper is
// clawed back instead of vanishing.
function createSettlementAdjustment(providerId, booking, reason) {
  if (!providerId || !booking) return null;
  const shares = booking.refundedShares || { providerShareEgp: booking.providerShareEgp || 0, appShareEgp: booking.appShareEgp || 0 };
  const adj = {
    id: newId('adj'), providerId, bookingId: booking.id, reason,
    providerShareEgp: shares.providerShareEgp || 0,
    appShareEgp: shares.appShareEgp || 0,
    cash: !!booking.cashCollectedByProvider,
    createdAt: nowIso(), appliedSettlementId: null,
  };
  store.data.settlementAdjustments = store.data.settlementAdjustments || [];
  store.data.settlementAdjustments.push(adj);
  store.audit('settlement.adjustment_created', providerId, { adjustmentId: adj.id, bookingId: booking.id, reason, providerShareEgp: adj.providerShareEgp, appShareEgp: adj.appShareEgp, cash: adj.cash });
  return adj;
}
// v2.1.6 (C7): a package day is releasable when the patient confirmed
// it, OR when vitals were recorded and 72h passed with no dispute
// (the provider's vitals are evidence the visit happened; the admin
// can also confirm a day on the patient's behalf). A day that is
// neither confirmed nor vitals-backed is NEVER releasable — its value
// stays in the refundable remainder.
function packageDayReleasable(d) {
  if (!d || d.released) return false;
  if (d.patientConfirmed) return true;
  if (d.vitals && d.loggedAt) {
    const loggedMs = new Date(d.loggedAt).getTime();
    if (Number.isFinite(loggedMs) && Date.now() - loggedMs >= config.packageDayAutoReleaseMs) return true;
  }
  return false;
}
// Weekly settlement records (audit #5): one per provider per ISO week.
// RECORDS ONLY — no money moves (that needs a bank account).
// v2.1.6 (C2/C3/C4): the record is a SNAPSHOT generated at the first
// sweep that finds activity in the week. A booking/bonus that becomes
// settleable AFTER the week's record was generated is settled in the
// FOLLOWING week's record (up to ~1 week lag) — it is never lost. The
// old code had a worse bug: it filtered by release week AND skipped
// when a record existed, so mid-week releases were NEVER recorded.
// Cash is split out (C2): a cash booking contributes ONLY its app share
// to providerOwesAppEgp — the provider already holds the cash, so the
// app never "owes" the provider's share. Non-cash contributes the
// provider share to appOwesProviderEgp. Amounts inside the 24h
// complaint window (or under an open complaint) sit in the
// complaint_hold bucket and are NOT payable from this record.
function generateSettlements() {
  const weekKey = currentWeekKey();
  const nowMs = Date.now();
  const made = [];
  for (const p of Object.values(store.data.providers)) {
    if (p.demo) continue;
    const key = monthKey();
    // Standard bookings: payable (settleable, never settled) vs held
    // (released but inside the complaint window / open complaint).
    // Payable has NO release-week filter — a booking released last week
    // that only just became settleable is paid now, not lost.
    const payable = [];
    const held = [];
    for (const b of Object.values(store.data.bookings)) {
      if (b.kind === 'package' || b.providerId !== p.id) continue;
      if (!['released', 'auto_released'].includes(b.status)) continue;
      if (b.settledWeekKey) continue; // settled in an earlier week
      if (isSettleableBooking(b, nowMs)) payable.push(b);
      else held.push(b);
    }
    // Package day releases: payable vs held, per release entry. A
    // weekly release is settleable at once (terms §12); a FINAL release
    // waits out the booking's 24h complaint window (rel.settleableAt).
    let packageDays = 0, packageProviderShare = 0, packageAppShare = 0, packageCashAppShare = 0;
    let packageHoldDays = 0, packageHoldEgp = 0;
    const payableRels = [];
    for (const b of Object.values(store.data.bookings)) {
      if (b.kind !== 'package') continue;
      for (const rel of (b.packageDayReleases || [])) {
        if (rel.providerId !== p.id || rel.settledWeekKey) continue;
        const relSettleable = (!rel.settleableAt || nowMs >= new Date(rel.settleableAt).getTime())
          && b.complaintStatus !== 'open' && !b.circumventionHold;
        if (relSettleable) payableRels.push({ booking: b, rel });
        else {
          packageHoldDays += rel.days;
          packageHoldEgp += b.cashCollectedByProvider ? (rel.appShareEgp || 0) : (rel.providerShareEgp || 0);
        }
      }
    }
    for (const { booking: b, rel } of payableRels) {
      packageDays += rel.days;
      if (b.cashCollectedByProvider) packageCashAppShare += rel.appShareEgp || 0;
      else { packageProviderShare += rel.providerShareEgp || 0; packageAppShare += rel.appShareEgp || 0; }
    }
    // Bonuses (C3: volume bonus pays only the monthly increase).
    const stay = stayBonusState(p);
    const stayDue = stay.earned && !stay.paid ? cat.STAY_BONUS_EGP : 0;
    const vbDue = volumeBonusDue(p, key);
    const bonusDue = p.permanentBan ? 0 : vbDue.dueEgp;
    // Reversing adjustments (C4) for refunds of already-settled bookings.
    const pendingAdj = (store.data.settlementAdjustments || []).filter((a) => a.providerId === p.id && !a.appliedSettlementId);
    // Totals (C2): cash contributes ONLY the app share, as a debt the
    // provider owes the app; the provider's cash share is never owed
    // by the app because the provider already holds the cash.
    let appOwes = 0, provOwes = 0;
    for (const b of payable) {
      if (b.cashCollectedByProvider) provOwes += b.appShareEgp || 0;
      else appOwes += b.providerShareEgp || 0;
    }
    appOwes += packageProviderShare + bonusDue + stayDue;
    provOwes += packageCashAppShare;
    // Hold bucket (C4): amounts not yet settleable, shown separately
    // and never paid from this record.
    let holdEgp = packageHoldEgp;
    const holdBookingIds = [];
    for (const b of held) {
      holdEgp += b.cashCollectedByProvider ? (b.appShareEgp || 0) : (b.providerShareEgp || 0);
      holdBookingIds.push(b.id);
    }
    // Apply reversing adjustments: a refunded provider share reduces
    // what the app owes; a refunded cash app-share reduces what the
    // provider owes. An excess nets to the other side (a debt).
    let adjProviderShare = 0, adjCashAppShare = 0;
    for (const a of pendingAdj) {
      if (a.cash) adjCashAppShare += a.appShareEgp || 0;
      else adjProviderShare += a.providerShareEgp || 0;
    }
    let appOwes2 = appOwes - adjProviderShare;
    let provOwes2 = provOwes - adjCashAppShare;
    if (appOwes2 < 0) { provOwes2 += -appOwes2; appOwes2 = 0; }
    if (provOwes2 < 0) { appOwes2 += -provOwes2; provOwes2 = 0; }
    const adjustmentsEgp = adjProviderShare + adjCashAppShare;
    const hasActivity = payable.length || held.length || packageDays || packageHoldDays || stayDue || bonusDue > 0 || pendingAdj.length;
    if (!hasActivity) continue;
    const exists = (store.data.settlements || []).some((x) => x.providerId === p.id && x.weekKey === weekKey);
    if (exists) continue;
    const totals = {
      appOwesProviderEgp: appOwes2, providerOwesAppEgp: provOwes2,
      volumeBonusEgp: bonusDue, volumeBonusMonth: key, volumeBonusPaidCumulative: (vbDue.paidEgp || 0) + bonusDue,
      stayBonusEgp: stayDue,
      releasedCases: payable.length,
      packageDays, packageProviderShareEgp: packageProviderShare, packageAppShareEgp: packageAppShare,
      packageCashAppShareEgp: packageCashAppShare,
      cashAppShareEgp: payable.filter((b) => b.cashCollectedByProvider).reduce((s, b) => s + (b.appShareEgp || 0), 0),
      complaintHoldEgp: holdEgp, complaintHoldBookingIds: holdBookingIds, packageHoldDays,
      adjustmentsEgp, adjustmentsApplied: pendingAdj.map((a) => a.id),
      payable: holdEgp === 0,
      settledBookingIds: payable.map((b) => b.id),
    };
    const rec = { id: newId('stl'), providerId: p.id, weekKey, generatedAt: nowIso(), totals };
    store.data.settlements.push(rec);
    // Mark what this record settled so a later week never pays it again.
    for (const b of payable) { b.settledWeekKey = weekKey; b.settledAt = nowIso(); }
    for (const { rel } of payableRels) { rel.settledWeekKey = weekKey; rel.settledAt = nowIso(); }
    for (const a of pendingAdj) a.appliedSettlementId = rec.id;
    if (bonusDue > 0) {
      p.volumeBonusPaid = { month: key, amountEgp: (vbDue.paidEgp || 0) + bonusDue };
      store.audit('bonus.paid', p.id, { settlementId: rec.id, month: key, amountEgp: bonusDue, cumulativeEgp: p.volumeBonusPaid.amountEgp });
    }
    if (stayDue > 0) {
      p.stayBonusPaid = true;
      store.audit('stay_bonus.paid', p.id, { settlementId: rec.id, amountEgp: stayDue });
    }
    made.push(rec);
  }
  return made;
}

// Phone numbers are forbidden inside in-app messages: the masked channel
// must never become a way to exchange personal numbers.
const PHONE_IN_MESSAGE_RE = /(?:\+?20[\s-]?|0)?1[0-9][\s-]?[0-9]{4}[\s-]?[0-9]{4}|\b\d{10,}\b/;
function containsPhoneNumber(text) {
  return PHONE_IN_MESSAGE_RE.test(String(text || ''));
}
// In-app messaging is open from acceptance until 24h after completion
// (patient confirmation / release). Before acceptance, or after the
// window, or on cancelled/refunded bookings, the thread is closed.
function messageWindowOpen(b) {
  if (!b) return false;
  if (['held', 'cancelled', 'refunded'].includes(b.status)) return false;
  if (b.status === 'accepted' || b.status === 'provider_confirmed') return true;
  const doneAt = b.patientConfirmedAt || b.releasedAt || b.providerConfirmedAt;
  if (!doneAt) return true; // accepted-family statuses without a timestamp yet
  return Date.now() - new Date(doneAt).getTime() <= 24 * 60 * 60 * 1000;
}
// Graduated-pattern heuristics for the admin circumvention report.
// (a) one-time clients: a patient who booked once with this provider and
// never booked again — a classic off-platform signal when it repeats.
// (b) cancellations after acceptance by the same provider.
// (c) circumvention reports filed against the provider.
// These are signals for a human admin, not automatic guilt.
function circumventionFlags() {
  const bookings = Object.values(store.data.bookings);
  const byProvider = {};
  for (const p of Object.values(store.data.providers)) {
    byProvider[p.id] = { providerId: p.id, name: p.name, phone: p.phone, tier: p.tier, suspended: !!p.suspended, permanentBan: !!p.permanentBan, warningCount: (p.warnings || []).length, oneTimeClients: 0, cancelledAfterAccept: 0, circumventionReports: 0, reasons: [] };
  }
  const patientBookings = {};
  for (const b of bookings) {
    if (!b.patientPhone) continue;
    (patientBookings[b.patientPhone] = patientBookings[b.patientPhone] || []).push(b);
  }
  for (const b of bookings) {
    const f = b.providerId && byProvider[b.providerId];
    if (!f) continue;
    if (b.status === 'cancelled' && b.acceptedAt) f.cancelledAfterAccept += 1;
  }
  for (const [phone, list] of Object.entries(patientBookings)) {
    if (list.length === 1 && list[0].providerId && byProvider[list[0].providerId]) {
      byProvider[list[0].providerId].oneTimeClients += 1;
    }
  }
  for (const r of store.data.circumventionReports || []) {
    const f = r.providerId && byProvider[r.providerId];
    if (f) f.circumventionReports += 1;
  }
  return Object.values(byProvider)
    .map((f) => {
      if (f.circumventionReports > 0) f.reasons.push(`${f.circumventionReports} circumvention report(s)`);
      if (f.oneTimeClients >= 3) f.reasons.push(`${f.oneTimeClients} one-time clients (booked once, never returned)`);
      if (f.cancelledAfterAccept >= 2) f.reasons.push(`${f.cancelledAfterAccept} cancellations after acceptance`);
      if (f.warningCount > 0) f.reasons.push(`${f.warningCount} warning(s) on file`);
      return f;
    })
    .filter((f) => f.reasons.length > 0 || f.suspended || f.permanentBan)
    .sort((a, b) => (b.circumventionReports - a.circumventionReports) || (b.oneTimeClients - a.oneTimeClients));
}
// v2.1.6 (C8): cheap anomaly flags for fake-visit farming — NO full
// anomaly engine in this build, just the high-value signals, computed
// live for the admin dashboard (like circumventionFlags). A flag is a
// REVIEW prompt, never an automatic ban.
//   - instantVisits: >=2 visits completed <20 min after acceptance
//     in the last 30 days (the 10-min hard floor at complete-provider
//     blocks the fastest ones; 10–20 min stays suspicious).
//   - newPatientBurst: >=5 DISTINCT patient phones whose FIRST booking
//     with this provider was in the last 7 days (a farm spins up new
//     patient numbers; a real provider's new patients trickle in).
//   - tooFastAttempts: >=2 rejected too-fast completion attempts
//     (audit 'booking.complete_too_fast') in the last 30 days.
function anomalyFlags() {
  const nowMs = Date.now();
  const out = [];
  const fastAttempts = {};
  for (const a of (store.data.audit || [])) {
    if (a.action === 'booking.complete_too_fast' && a.ts && nowMs - new Date(a.ts).getTime() <= 30 * 24 * 60 * 60 * 1000) {
      const pid = a.details?.providerId || a.actor;
      fastAttempts[pid] = (fastAttempts[pid] || 0) + 1;
    }
  }
  // First booking per (provider, patient phone) — a "new patient" is a
  // phone whose FIRST booking with this provider was in the last 7 days.
  const firstSeen = {};
  for (const b of Object.values(store.data.bookings)) {
    if (!b.providerId || !b.patientPhone || !b.createdAt) continue;
    const k = `${b.providerId}:${b.patientPhone}`;
    const t = new Date(b.createdAt).getTime();
    if (Number.isFinite(t) && (!firstSeen[k] || t < firstSeen[k])) firstSeen[k] = t;
  }
  for (const p of Object.values(store.data.providers)) {
    if (p.demo) continue;
    const reasons = [];
    let instantVisits = 0;
    const newPatients = new Set();
    for (const b of Object.values(store.data.bookings)) {
      if (b.providerId !== p.id || !b.acceptedAt) continue;
      const accMs = new Date(b.acceptedAt).getTime();
      if (b.providerConfirmedAt) {
        const durMs = new Date(b.providerConfirmedAt).getTime() - accMs;
        if (durMs >= 0 && durMs < 20 * 60 * 1000 && nowMs - accMs <= 30 * 24 * 60 * 60 * 1000) instantVisits += 1;
      }
    }
    for (const [k, t] of Object.entries(firstSeen)) {
      if (k.startsWith(`${p.id}:`) && nowMs - t <= 7 * 24 * 60 * 60 * 1000) newPatients.add(k.slice(p.id.length + 1));
    }
    if (instantVisits >= 2) reasons.push(`${instantVisits} visits completed <20 min after acceptance in 30 days`);
    if (newPatients.size >= 5) reasons.push(`${newPatients.size} new patient phones in 7 days`);
    const tooFast = fastAttempts[p.id] || fastAttempts[p.phone] || 0;
    if (tooFast >= 2) reasons.push(`${tooFast} too-fast completion attempts rejected in 30 days`);
    if (reasons.length) out.push({ providerId: p.id, name: p.name, phone: p.phone, tier: p.tier, instantVisits, newPatients7d: newPatients.size, tooFastAttempts: tooFast, reasons });
  }
  return out.sort((a, b) => (b.instantVisits + b.newPatients7d) - (a.instantVisits + a.newPatients7d));
}
// ---------------------------------------------------------------- v2.0.9 — reversed commissions + volume bonus + promo months + loyalty vouchers
// Owner decision 26 Nov 2026 ("da awwal iqtirah ba'akkidlak 'aleih"):
//   TIERS reversed: Starter 15% / Pro 12% / Elite 8% — the more a provider
//   develops, the LOWER their commission. The fixed Elite 1,200 EGP/month
//   bonus is ABOLISHED, replaced by the monthly volume bonus.
//   Volume bonus (cash, from the app, paid with the Thursday settlement):
//   30 completed cases/month -> 500 EGP, 60 -> 1,000, 100 -> 1,500
//   (highest tier reached ONLY, never cumulative). Titles continue even
//   when the cash bonus is paused.
//   Promo months (max 2 per calendar year, announced in advance): admin
//   may lower the commission or set it to 0% for a month. In a
//   0%-commission month the cash volume bonus PAUSES (titles continue).
//   Patient loyalty vouchers: after every 4 completed PAID visits the
//   patient auto-receives a 50 EGP voucher (60 days, min booking 300 EGP,
//   one per booking), fully funded by the app — the provider's share is
//   always computed on the FULL pre-discount price.
function monthKey(d = new Date()) { return d.toISOString().slice(0, 7); } // 'YYYY-MM'

// The live promo override: admin-set (store.data.promo) wins; otherwise
// the PROMO_COMMISSION_PCT env var; otherwise no promo (tier rates).
// An expired admin promo is inactive (the sweep clears it).
function activePromo() {
  const stored = store.data.promo;
  if (stored && stored.commissionPct != null) {
    if (!stored.until || new Date(stored.until).getTime() > Date.now()) {
      return { commissionPct: stored.commissionPct, until: stored.until || null, source: 'admin' };
    }
    return null; // expired — the sweep clears it
  }
  if (config.promoCommissionPct != null) {
    return { commissionPct: config.promoCommissionPct, until: null, source: 'env' };
  }
  return null;
}
function effectiveCommissionPct(tier) {
  const promo = activePromo();
  if (promo) return promo.commissionPct;
  if (typeof tier !== 'string' || !Object.hasOwn(cat.TIERS, tier)) return cat.TIERS.Starter.commission_pct;
  return cat.TIERS[tier].commission_pct;
}

// ---------------------------------------------------------------- v2.1.4 — launch-month shift offer
// (owner-approved 26 Nov 2026, «أيوه، اعتمدها كده»): while active,
// single-day shift12/shift24 bookings are offered at 500 / 850 but the
// provider is paid as if the price were 700 / 1,200
// (cat.LAUNCH_OFFER_REFERENCE). The app funds the difference as a launch
// cost. Default OFF — the admin enables it at launch
// (POST /api/admin/launch-offer). An expired setting is inactive (the
// sweep clears it), exactly like the promo-month override above.
function activeLaunchOffer() {
  const stored = store.data.launchOffer;
  if (!stored || stored.active !== true) return null;
  if (stored.until && new Date(stored.until).getTime() <= Date.now()) return null; // expired — the sweep clears it
  return { active: true, until: stored.until || null, setAt: stored.setAt || null };
}
// Reference total for a launch-offer shift booking: the amount actually
// paid, with the single-day base price replaced by its 700/1,200
// reference. The distance fee (if any) is unchanged, so with no distance
// fee the reference is exactly 700 / 1,200. Returns null for services
// the offer never covers (everything except shift12/shift24).
function launchOfferReferenceFor(booking) {
  const refBase = cat.LAUNCH_OFFER_REFERENCE[booking.serviceCode];
  if (refBase == null) return null;
  const base = cat.SERVICES[booking.serviceCode]?.price_egp;
  if (base == null) return null;
  return booking.amountEgp + (refBase - base);
}

// Completed cases in a calendar month for one provider: bookings that
// reached the released state (the same completion signal the Thursday
// settlement uses). Refunded bookings drop out (status becomes 'refunded').
function monthlyCases(providerId, key) {
  return Object.values(store.data.bookings).filter((b) =>
    b.providerId === providerId
    && (b.status === 'released' || b.status === 'auto_released')
    && b.releasedAt && b.releasedAt.slice(0, 7) === key
  ).length;
}
function volumeBonusFor(providerId, key) {
  const cases = monthlyCases(providerId, key);
  const promo = activePromo();
  const paused = !!promo && promo.commissionPct === 0;
  const reached = cat.VOLUME_BONUS_TIERS.filter((t) => cases >= t.minCases).sort((a, b) => b.minCases - a.minCases)[0] || null;
  const next = cat.VOLUME_BONUS_TIERS.filter((t) => cases < t.minCases).sort((a, b) => a.minCases - b.minCases)[0] || null;
  return {
    month: key, cases,
    bonusEgp: paused ? 0 : (reached ? reached.bonusEgp : 0),
    title: reached ? reached.title : null,
    titleEn: reached ? reached.titleEn : null,
    nextBonusAt: next ? next.minCases : null,
    nextBonusEgp: next ? next.bonusEgp : null,
    casesToNextBonus: next ? next.minCases - cases : null,
    paused,
    note: paused ? 'Cash volume bonus is paused during a 0%-commission promo month — titles still apply.' : null,
  };
}

// Loyalty vouchers -------------------------------------------------------
// Expire vouchers past their date (called by the sweep and on read).
function expireVouchers() {
  const now = Date.now();
  let changed = false;
  for (const v of store.data.vouchers || []) {
    if (v.status === 'active' && new Date(v.expiresAt).getTime() <= now) {
      v.status = 'expired'; changed = true;
    }
  }
  if (changed) store.save();
  return changed;
}
// Completed PAID visits for a patient = released bookings (refunded ones
// drop out by status).
function completedPaidVisits(patientPhone) {
  return Object.values(store.data.bookings).filter((b) =>
    b.patientPhone === patientPhone && (b.status === 'released' || b.status === 'auto_released')
  ).length;
}
// Every 4th completed paid visit issues one 50 EGP voucher.
function maybeIssueVouchers(patientPhone) {
  const completed = completedPaidVisits(patientPhone);
  const earned = Math.floor(completed / cat.VOUCHER_EVERY_N_VISITS);
  const issued = (store.data.vouchers || []).filter((v) => v.patientPhone === patientPhone).length;
  const toIssue = earned - issued;
  if (toIssue <= 0) return [];
  const now = new Date();
  const made = [];
  for (let i = 0; i < toIssue; i++) {
    const v = {
      id: newId('vou'), patientPhone, amountEgp: cat.VOUCHER_AMOUNT_EGP,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + cat.VOUCHER_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      minBookingEgp: cat.VOUCHER_MIN_BOOKING_EGP, status: 'active',
      sourceBookingId: null, usedBookingId: null, usedAt: null,
    };
    store.data.vouchers.push(v);
    made.push(v);
  }
  store.audit('voucher.issued', patientPhone, { count: made.length, completedPaidVisits: completed, voucherIds: made.map((v) => v.id) });
  return made;
}

// ------------------------------------------------------------------ v2.1.3
// Monthly packages (see src/catalog.js MONTHLY_PACKAGES). Money rule:
// the full month is paid upfront into escrow; the nurse is paid WEEKLY at
// Thursday settlement for COMPLETED days only. A completed day's share is
// released by settlePackageDays() (called from the sweep, before
// generateSettlements so the week's settlement records include it).
// The final release (releasePackageBooking) only releases the days that
// are still unreleased; earlier weekly releases are never re-counted.
// Commission is LOCKED at quote-accept time from the main provider's tier
// (promo override included) — the same lock applies to substitute days.
// Weekly-released days are NOT refundable after settlement (terms §12);
// only the UNRELEASED remainder is refunded on complaint/cancel.
function packageTypeOf(code) { return cat.MONTHLY_PACKAGES[code] || cat.TOURIST_PACKAGES[code] || null; }
function packageFamily(pkg) { return pkg && pkg.kind === 'tourist' ? 'tourist' : 'local'; }
// EGP per 1 unit of the booking currency (tourist packages settle in EGP;
// the ledger, wallet and refunds are all EGP — the foreign amount is
// carried alongside for display, exactly like tourist bookings).
function packageFxRate(currency) {
  if (currency === 'USD') return config.usdEgp;
  if (currency === 'EUR') return config.eurEgp;
  return 1;
}
// Level gate (owner rule 26 Nov 2026 — v2.1.3): nobody works above their
// qualification. Assistant packages: assistant / nurse / doctor (basic
// care — anyone qualified may do it). Technician: nurse / doctor only
// (an assistant NEVER takes medical work). Specialist: nurse at Pro+
// (the points system proves the experience) or any doctor. Physio
// specialists never take nursing packages (and vice versa).
function providerMeetsPackageLevel(p, level) {
  const type = p.providerType || p.role;
  if (type === 'physio') return false;
  if (level === 'assistant') return ['assistant', 'nurse', 'doctor'].includes(type);
  if (level === 'technician') return ['nurse', 'doctor'].includes(type);
  if (level === 'specialist') {
    if (type === 'doctor') return true;
    if (type !== 'nurse') return false;
    return ['Pro', 'Elite'].includes(p.tier);
  }
  return false;
}
function packageLevelName(level) {
  return { assistant: 'nursing assistant', technician: 'nursing technician', specialist: 'nursing specialist' }[level] || level;
}
// The +25% overtime premium is waived while the launch offer is on:
// admin setting (POST /api/admin/package-offer, unexpired) wins; env
// PACKAGE_OVERTIME_WAIVED is the fallback.
function packageOvertimePremiumWaived() {
  const off = store.data.packageOffer;
  if (off && off.overtimePremiumWaived === true) {
    if (!off.until || new Date(off.until).getTime() > Date.now()) return true;
  }
  return config.packageOvertimePremiumWaived === true;
}
// Package daily rate: final quoted BASE price ÷ 26 days (terms §12).
// The base price (not the total incl. extra days) prices the 26 regular
// days; extra days have their own daily rate on the booking.
function packageDailyRate(booking) {
  return Math.max(1, Math.round(((booking.basePackageEgp || booking.amountEgp || 0)) / cat.PACKAGE_DAYS));
}
function packageDayTotals(booking) {
  const rel = booking.packageDayReleases || [];
  return {
    providerShareEgp: rel.reduce((s, x) => s + (x.providerShareEgp || 0), 0),
    appShareEgp: rel.reduce((s, x) => s + (x.appShareEgp || 0), 0),
    days: rel.reduce((s, x) => s + (x.days || 0), 0),
  };
}
function packageUnreleasedDays(booking) {
  return (booking.daysLog || []).filter((d) => !d.released);
}
// Release ONE list of completed days for a provider at the booking's locked
// commission. Appends one packageDayReleases entry and marks the days
// released. Returns the entry or null.
function releasePackageDays(booking, days, providerId) {
  if (!days.length) return null;
  const pct = booking.commissionPct ?? cat.TIERS[store.data.providers[booking.providerId]?.tier || 'Starter'].commission_pct;
  let providerShareEgp = 0, appShareEgp = 0;
  for (const d of days) {
    const gross = d.rateEgp;
    const app = Math.round(gross * (pct / 100));
    providerShareEgp += gross - app;
    appShareEgp += app;
    d.released = true; d.releasedAt = nowIso(); d.weekKey = currentWeekKey();
  }
  const entry = { weekKey: currentWeekKey(), providerId, days: days.length, providerShareEgp, appShareEgp, releasedAt: nowIso(), final: false,
    // v2.1.6 (C4/C7): a WEEKLY release is settleable at once (terms
    // §12); a FINAL release waits out the booking's 24h complaint
    // window — releasePackageBooking sets settleableAt below.
    settleableAt: null, settledWeekKey: null, settledAt: null };
  booking.packageDayReleases = booking.packageDayReleases || [];
  booking.packageDayReleases.push(entry);
  booking.daysReleased = (booking.daysReleased || 0) + days.length;
  store.audit('package.days_released', providerId, { bookingId: booking.id, weekKey: entry.weekKey, days: days.length, providerShareEgp, appShareEgp });
  return entry;
}
// Weekly pass (called from the sweep before generateSettlements): for every
// running package booking, release any completed-but-unreleased days.
// Suspended / permanently-banned providers hold their own days (the
// substitute's days still release).
function settlePackageDays() {
  const released = [];
  for (const b of Object.values(store.data.bookings)) {
    if (b.kind !== 'package' || b.status !== 'accepted') continue;
    // v2.1.6 (C7): a package flagged for bulk-registration review
    // releases NOTHING until the admin clears it.
    if (b.packageReviewRequired) continue;
    const byProvider = {};
    // v2.1.6 (C7): only EVIDENCED days release — patient-confirmed,
    // or vitals-backed and 72h old (see packageDayReleasable). A
    // self-recorded day with no confirmation and no vitals stays
    // unreleased; its value stays in the refundable remainder.
    for (const d of packageUnreleasedDays(b)) {
      if (!packageDayReleasable(d)) continue;
      byProvider[d.providerId] = byProvider[d.providerId] || [];
      byProvider[d.providerId].push(d);
    }
    for (const [providerId, days] of Object.entries(byProvider)) {
      if (providerBlocked(store.data.providers[providerId])) continue;
      const entry = releasePackageDays(b, days, providerId);
      if (entry) released.push({ bookingId: b.id, providerId, days: entry.days, providerShareEgp: entry.providerShareEgp });
    }
  }
  if (released.length) store.save();
  return released;
}
// Final release of a package booking (after patient confirmation + review,
// or auto after 1h, or on complaint rejection). Releases any remaining
// unreleased days, then totals the booking's shares from the day releases.
// A package counts as ONE completed case for the main provider (points +
// volume bonus) — the same as a standard visit.
function releasePackageBooking(b, mode) {
  // v2.1.6 (C7): a package under bulk-registration review does NOT
  // final-release until the admin clears it; and only EVIDENCED days
  // release (confirmed, or vitals + 72h). Unconfirmed days stay
  // unreleased and their value stays refundable to the patient.
  if (b.packageReviewRequired) return;
  const byProvider = {};
  for (const d of packageUnreleasedDays(b)) {
    if (!packageDayReleasable(d)) continue;
    if (providerBlocked(store.data.providers[d.providerId])) continue; // hold: banned provider's days stay unreleased
    byProvider[d.providerId] = byProvider[d.providerId] || [];
    byProvider[d.providerId].push(d);
  }
  for (const [providerId, days] of Object.entries(byProvider)) {
    const entry = releasePackageDays(b, days, providerId);
    if (entry) {
      entry.final = true;
      // The final release waits out the booking's 24h complaint window.
      entry.settleableAt = b.settleableAt || b.complaintDeadline || null;
    }
  }
  const totals = packageDayTotals(b);
  b.providerShareEgp = totals.providerShareEgp;
  b.appShareEgp = totals.appShareEgp;
  const key = monthKey();
  const p = b.providerId ? store.data.providers[b.providerId] : null;
  const prevCases = p ? monthlyCases(p.id, key) : 0;
  b.status = mode === 'auto' ? 'auto_released' : 'released';
  b.releasedAt = nowIso();
  b.releaseMode = mode;
  b.settleableAt = b.complaintDeadline || null;
  if (p) {
    p.completedVisits = (p.completedVisits || 0) + 1;
    const wk = isoWeekKey(new Date(b.releasedAt || nowIso()));
    p.casesByWeek = p.casesByWeek || {};
    p.casesByWeek[wk] = (p.casesByWeek[wk] || 0) + 1;
    recomputeProviderPoints(p);
    const vb = volumeBonusFor(p.id, key);
    p.volumeBonus = { month: key, cases: vb.cases, bonusEgp: vb.bonusEgp, title: vb.title, paused: vb.paused };
    const prevTier = cat.VOLUME_BONUS_TIERS.filter((t) => prevCases >= t.minCases).sort((a, b) => b.minCases - a.minCases)[0] || null;
    const newTier = cat.VOLUME_BONUS_TIERS.filter((t) => vb.cases >= t.minCases).sort((a, b) => b.minCases - a.minCases)[0] || null;
    if (newTier && (!prevTier || newTier.minCases !== prevTier.minCases)) {
      store.audit('bonus.earned', p.id, { bookingId: b.id, month: key, cases: vb.cases, bonusEgp: vb.bonusEgp, title: vb.title, paused: vb.paused });
    }
  }
  store.audit('escrow.released', b.providerId || 'system', { bookingId: b.id, kind: 'package', mode, providerShareEgp: b.providerShareEgp, appShareEgp: b.appShareEgp });
  if (b.patientPhone) maybeIssueVouchers(b.patientPhone);
  store.save();
}
// Refundable remainder of a package (terms §12): what the patient actually
// paid minus the value of ALL days already released (weekly + final).
// Unworked extra days are included (they are never released).
function packageRefundRemaining(b) {
  const releasedGross = (b.packageDayReleases || []).reduce((s, x) => s + x.providerShareEgp + x.appShareEgp, 0);
  return Math.max(0, refundAmount(b) - releasedGross);
}
// Find one usable voucher for this patient/amount (does NOT mark it used —
// the caller marks it used only after the booking is created).
function findVoucher(patientPhone, amountEgp) {
  expireVouchers();
  if (amountEgp < cat.VOUCHER_MIN_BOOKING_EGP) return null;
  return (store.data.vouchers || []).find((x) =>
    x.patientPhone === patientPhone && x.status === 'active'
    && new Date(x.expiresAt).getTime() > Date.now()
    && amountEgp >= (x.minBookingEgp || cat.VOUCHER_MIN_BOOKING_EGP)) || null;
}
// What the patient actually paid (after any voucher discount) — this is
// the amount a refund returns, never more than the patient paid.
function refundAmount(b) {
  return b.amountPayableEgp != null ? b.amountPayableEgp : b.amountEgp;
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
// v2.1.1 (L4): rating average over ALL reviews on the provider's
// bookings (including the current visit) — the old incremental formula
// never counted the current visit.
function recomputeRatingAvg(p) {
  if (!p) return null;
  const rated = Object.values(store.data.bookings).filter((b) =>
    b.providerId === p.id && b.review && Number.isFinite(Number(b.review.rating))
    && !['cancelled', 'refunded'].includes(b.status));
  p.ratingAvg = rated.length
    ? Math.round((rated.reduce((sum, b) => sum + Number(b.review.rating), 0) / rated.length) * 10) / 10
    : null;
  return p.ratingAvg;
}

function releaseBooking(b, mode) {
  const total = b.amountEgp;
  const pct = b.commissionPct ?? 0;
  // v2.1.4 — launch-month shift offer (locked at accept time): the
  // provider's share is computed on the REFERENCE total (700/1,200 base
  // + distance fee), while the patient paid the offer price (500/850 +
  // distance fee). The app share = amount actually paid − provider share,
  // which goes NEGATIVE during the offer (e.g. Starter 12h: provider 595,
  // app −95) — that negative share IS the launch cost the app funds, so
  // it is NOT floored at 0 here (unlike the normal path below). A loyalty
  // voucher still comes out of the app's share on top, as usual. The
  // top-up (reference − paid) is recorded on the booking and audited as
  // 'launch_offer.topup' for the ledger / admin view.
  const offerRef = b.launchOffer && b.launchOffer.referenceEgp != null ? b.launchOffer.referenceEgp : null;
  if (offerRef != null) {
    const grossAppShare = Math.round(offerRef * (pct / 100));
    b.providerShareEgp = offerRef - grossAppShare;
    b.appShareEgp = total - b.providerShareEgp - (b.voucherDiscountEgp || 0);
    b.launchOfferTopupEgp = offerRef - total;
    store.audit('launch_offer.topup', b.providerId || 'system', { bookingId: b.id, serviceCode: b.serviceCode, referenceEgp: offerRef, amountEgp: total, commissionPct: pct, providerShareEgp: b.providerShareEgp, appShareEgp: b.appShareEgp, topupEgp: b.launchOfferTopupEgp, voucherDiscountEgp: b.voucherDiscountEgp || 0 });
  } else {
    const grossAppShare = Math.round(total * (pct / 100));
    // v2.0.9 — the app funds any loyalty-voucher discount in full: the
    // provider's share is computed on the FULL pre-discount price; the
    // discount comes out of the app's share (floored at 0 — any shortfall
    // is the app's cost of the voucher).
    b.appShareEgp = Math.max(0, grossAppShare - (b.voucherDiscountEgp || 0));
    b.providerShareEgp = total - grossAppShare;
  }
  // v2.1.1 (audit #18): language bonus — if the tourist booking's
  // language matches a VERIFIED language certificate the provider holds,
  // add $15/€15 at the booking FX rate to the provider's share (the app
  // funds it) and record it for the wallet ledger line.
  b.languageBonusEgp = 0;
  const p0 = b.providerId ? store.data.providers[b.providerId] : null;
  if (b.kind === 'tourist' && b.language && b.language !== 'en' && p0 && b.fxRate) {
    const hasCert = Array.isArray(p0.languageCertificates)
      && p0.languageCertificates.some((l) => l && l.verified === true && String(l.language).toLowerCase() === String(b.language).toLowerCase());
    if (hasCert) {
      b.languageBonusEgp = Math.round(cat.EXTRA_LANGUAGE_BONUS[b.currency.toLowerCase()] * b.fxRate);
      b.providerShareEgp += b.languageBonusEgp;
    }
  }
  const p = p0;
  // Volume-bonus threshold detection: count BEFORE this release, so the
  // crossing is detected (and audited) exactly once.
  const key = monthKey();
  const prevCases = p ? monthlyCases(p.id, key) : 0;
  b.status = mode === 'auto' ? 'auto_released' : 'released';
  b.releasedAt = nowIso();
  b.releaseMode = mode;
  // Final settlement only after the 24h complaint window (set at patient
  // confirmation) — see the two-stage escrow comment above.
  b.settleableAt = b.complaintDeadline || null;
  if (p) {
    p.completedVisits = (p.completedVisits || 0) + 1;
    // v2.1.1 (points system): track cases by ISO week on the record.
    const wk = isoWeekKey(new Date(b.releasedAt || nowIso()));
    p.casesByWeek = p.casesByWeek || {};
    p.casesByWeek[wk] = (p.casesByWeek[wk] || 0) + 1;
    // Points recompute + auto-promotion (interview/credential/release).
    recomputeProviderPoints(p);
    // Volume bonus snapshot on the provider record (the wallet recomputes
    // live from bookings; this is the audit trail / admin view).
    const vb = volumeBonusFor(p.id, key);
    p.volumeBonus = { month: key, cases: vb.cases, bonusEgp: vb.bonusEgp, title: vb.title, paused: vb.paused };
    const prevTier = cat.VOLUME_BONUS_TIERS.filter((t) => prevCases >= t.minCases).sort((a, b) => b.minCases - a.minCases)[0] || null;
    const newTier = cat.VOLUME_BONUS_TIERS.filter((t) => vb.cases >= t.minCases).sort((a, b) => b.minCases - a.minCases)[0] || null;
    if (newTier && (!prevTier || newTier.minCases !== prevTier.minCases)) {
      store.audit('bonus.earned', p.id, { bookingId: b.id, month: key, cases: vb.cases, bonusEgp: vb.bonusEgp, title: vb.title, paused: vb.paused });
    }
  }
  store.audit('escrow.released', b.providerId || 'system', { bookingId: b.id, mode, totalEgp: total, appShareEgp: b.appShareEgp, providerShareEgp: b.providerShareEgp, voucherDiscountEgp: b.voucherDiscountEgp || 0, launchOffer: offerRef != null, launchOfferTopupEgp: b.launchOfferTopupEgp || 0 });
  // Loyalty voucher: every 4th completed paid visit issues one.
  if (b.patientPhone) maybeIssueVouchers(b.patientPhone);
  store.save();
}
// v2.1.0 — notification helpers for the sweep (Africa/Cairo calendar:
// the business runs on Egyptian time, not UTC).
function cairoDateStr(d = new Date()) { return d.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }); } // 'YYYY-MM-DD'
function cairoWeekdayShort(d = new Date()) { return d.toLocaleDateString('en-US', { timeZone: 'Africa/Cairo', weekday: 'short' }); } // 'Thu'

async function sweepAutoRelease() {
  const now = Date.now();
  const released = [];
  const overdue = [];
  let notificationsSent = 0;
  let changed = false;
  // v2.0.9 — expire loyalty vouchers past their date; clear an expired
  // admin promo so tier rates resume.
  expireVouchers();
  if (store.data.promo && store.data.promo.until && new Date(store.data.promo.until).getTime() <= now) {
    store.data.promo = null;
    store.audit('promo.expired', 'system', {});
    changed = true;
  }
  // v2.1.4 — an expired launch-month shift offer stops applying on its
  // own (already-accepted bookings keep the lock they took at accept).
  if (store.data.launchOffer && store.data.launchOffer.until && new Date(store.data.launchOffer.until).getTime() <= now) {
    store.data.launchOffer = null;
    store.audit('launch_offer.expired', 'system', {});
    changed = true;
  }
  for (const b of Object.values(store.data.bookings)) {
    if (b.status === 'patient_confirmed' && b.patientConfirmedAt && !b.review && !b.complaint) {
      // v2.0.8: a circumvention hold pauses auto-release just like a complaint.
      if (b.circumventionHold) continue;
      if (now - new Date(b.patientConfirmedAt).getTime() >= config.autoReleaseAfterMs) {
        if (b.kind === 'package') releasePackageBooking(b, 'auto'); else releaseBooking(b, 'auto');
        released.push(b.id);
      }
    }
    // 'reviewed' only persists when a complaint paused the release; once
    // the complaint is resolved as rejected, release it now.
    if (b.status === 'reviewed' && !b.complaint && !b.circumventionHold) {
      if (b.kind === 'package') releasePackageBooking(b, 'reviewed'); else releaseBooking(b, 'reviewed');
      released.push(b.id);
    }
    // v2.1.1 (audit #28): the 120-minute late-visit clock starts at the
    // FIRST on-site event (vitals / en-route / acceptance), not at
    // acceptance only.
    const onSiteAt = b.vitalsAt || b.enRouteAt || b.acceptedAt;
    if ((b.status === 'accepted' || b.status === 'provider_confirmed') && onSiteAt) {
      if (!b.overdue && now - new Date(onSiteAt).getTime() >= 120 * 60 * 1000) {
        b.overdue = true;
        overdue.push(b.id);
        store.audit('visit.overdue', 'system', { bookingId: b.id, minutes: 120 });
        changed = true;
      }
    }
    // v2.1.0 — 1-hour review reminder (SPEC §4: reminders within exactly
    // one hour, then auto-release): at ~50 minutes after patient
    // confirmation (10 minutes before auto-release), notify the patient
    // ONCE (critical) to review. Only while still unreviewed, with no
    // complaint and no circumvention hold. The SMS fallback (unread after
    // 10 more minutes) is handled by processSmsFallbacks below.
    if (b.status === 'patient_confirmed' && b.patientConfirmedAt && !b.review && !b.complaint && !b.circumventionHold && !b.reviewReminderSentAt) {
      const remindAfterMs = Math.max(0, config.autoReleaseAfterMs - 10 * 60 * 1000);
      if (now - new Date(b.patientConfirmedAt).getTime() >= remindAfterMs) {
        b.reviewReminderSentAt = nowIso();
        changed = true;
        try {
          await notify.notifyUser(b.patientPhone, {
            type: 'review_reminder', critical: true,
            titleAr: 'قيّم زيارتك', titleEn: 'Review your visit',
            bodyAr: 'قيّم زيارتك خلال الساعة ليتم تحويل المبلغ لمقدم الخدمة — افتح التطبيق للتقييم.',
            bodyEn: 'Please review your visit within the hour so the held amount is released to your provider.',
            data: { bookingId: b.id },
            validUntilMs: new Date(b.patientConfirmedAt).getTime() + config.autoReleaseAfterMs,
          });
          notificationsSent += 1;
        } catch (e) {
          console.error('[sweep] review reminder failed:', e.message);
        }
      }
    }
  }
  // v2.1.0 — Thursday settlement notifications (Africa/Cairo calendar).
  // Once per Thursday: notify every provider with released money or a
  // volume bonus to check their wallet. Demo providers are skipped —
  // they are not real people (and must never receive a real SMS).
  const todayCairo = cairoDateStr();
  if (cairoWeekdayShort() === 'Thu' && store.data.settlementNotifiedOn !== todayCairo) {
    store.data.settlementNotifiedOn = todayCairo;
    changed = true;
    for (const p of Object.values(store.data.providers)) {
      if (p.demo) continue;
      const hasReleased = Object.values(store.data.bookings).some((bk) => bk.providerId === p.id && ['released', 'auto_released'].includes(bk.status));
      const vb = volumeBonusFor(p.id, monthKey());
      if (!hasReleased && !(vb.bonusEgp > 0)) continue;
      try {
        await notify.notifyUser(p.phone, {
          type: 'settlement', critical: true,
          titleAr: 'تسوية الخميس', titleEn: 'Thursday settlement',
          bodyAr: 'تسوية يوم الخميس جاهزة — راجع محفظتك في التطبيق لمعرفة مستحقاتك.',
          bodyEn: 'Thursday settlement is ready — check your wallet in the app for your balance.',
          data: { settlementDate: todayCairo },
          validUntilMs: now + 12 * 60 * 60 * 1000,
        });
        notificationsSent += 1;
      } catch (e) {
        console.error('[sweep] settlement notify failed:', e.message);
      }
    }
  }
  // v2.1.0 — unread-critical SMS fallback pass: a critical notification
  // still unread 10 minutes after creation gets one SMS attempt.
  let fb = { attempted: 0, sent: 0 };
  try {
    fb = await notify.processSmsFallbacks();
  } catch (e) {
    console.error('[sweep] sms fallback pass failed:', e.message);
  }
  // v2.1.1 (audit #5): weekly settlement records (records only).
  // v2.1.3 — release completed package days FIRST, so the week's
  // settlement records include them (settlePackageDays is idempotent:
  // released days are marked and never re-released).
  const packageDaysReleased = settlePackageDays();
  if (packageDaysReleased.length) changed = true;
  const settlementsMade = generateSettlements();
  if (settlementsMade.length) changed = true;
  if (released.length || overdue.length || changed) store.save();
  return { released, overdue, notificationsSent, smsSent: fb.sent, smsFallbackAttempted: fb.attempted, settlementsGenerated: settlementsMade.length, packageDaysReleased: packageDaysReleased.length };
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
      // v2.1.0 — risk tier (owner refinement 26 Nov 2026): 'high' services
      // need a doctor's order to book and a verified nurse to accept.
      riskLevel: s.riskLevel || 'standard',
      category: s.category || 'nursing',
      requiresDoctorOrder: s.requiresDoctorOrder === true,
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
    // v2.1.1 (M1): tiers match the catalog exactly — 20–35 km is 350,
    // AT 35 km the fee is 500 (not 350).
    distanceTiers: [
      { maxKm: 6, fee: 0 }, { maxKm: 10, fee: 100 }, { maxKm: 20, fee: 200 },
      { maxKm: 34.99, fee: 350 }, { maxKm: 35, fee: 500 },
    ],
    volumeBonusTiers: cat.VOLUME_BONUS_TIERS,
    pointsTiers: cat.POINTS.tiers,
    fx: { usd: config.usdEgp, eur: config.eurEgp },
    mockMode: config.mockOtp,
    ambulance: '123',
    termsVersion: config.termsVersion,
    // v2.1.0 — capability flags (no secrets): the app uses these to pick
    // the login flow (SMS OTP when configured, phone-only fallback when
    // not) and to know whether push registration is meaningful.
    otp: { smsConfigured: config.smsConfigured(), whatsappConfigured: config.whatsapp.provider === 'meta' },
    push: { fcmConfigured: config.fcmConfigured() },
    persistence: store.persistence,
    // v2.1.0 — high-risk tier (owner refinement 26 Nov 2026).
    highRiskServices: cat.HIGH_RISK_SERVICES,
    highRiskChecklist: cat.HIGH_RISK_CHECKLIST,
    // v2.1.2 — languages + in-app language tests (owner decision 26 Nov
    // 2026): 7 seeded languages, testable only with a question bank.
    languages: languageList(),
    languageTest: { questionsPerTest: cat.LANGUAGE_TEST_QUESTIONS, passMin: cat.LANGUAGE_TEST_PASS_MIN, minutes: cat.LANGUAGE_TEST_MINUTES, retakeDays: cat.LANGUAGE_TEST_RETAKE_DAYS },
    // v2.1.3 — monthly packages (owner-approved 26 Nov 2026). Prices are
    // INDICATIVE ("starting from") — the final price is a written admin
    // quote after a case assessment (see /api/package-requests). Local
    // ladder: assistant / technician / specialist (elderly unchanged).
    // Tourist residence packages carry USD/EUR prices.
    packages: Object.values(cat.MONTHLY_PACKAGES).map((p) => ({
      code: p.code, level: p.level, shiftType: p.shiftType, shiftHours: p.shiftHours, dailyRateEgp: p.dailyRateEgp, days: p.days,
      name_en: p.name_en, name_ar: p.name_ar,
      priceEgp: p.priceEgp, originalEgp: p.originalEgp,
      price: p.priceEgp, original: p.originalEgp,
    })),
    touristPackages: Object.values(cat.TOURIST_PACKAGES).map((p) => ({
      code: p.code, level: p.level, shiftType: p.shiftType, shiftHours: p.shiftHours,
      dailyRateUsd: p.dailyRateUsd, dailyRateEur: p.dailyRateEur, days: p.days,
      name_en: p.name_en, name_ar: p.name_ar,
      priceUsd: p.priceUsd, originalUsd: p.originalUsd,
      priceEur: p.priceEur, originalEur: p.originalEur,
    })),
    packageConfig: {
      days: cat.PACKAGE_DAYS, offDays: cat.PACKAGE_OFF_DAYS,
      overtimePremiumPct: cat.PACKAGE_OVERTIME_PREMIUM_PCT,
      overtimePremiumWaived: packageOvertimePremiumWaived(),
      levels: cat.PACKAGE_LEVELS,
      conditions: cat.PACKAGE_CONDITIONS,
      needs: cat.PACKAGE_NEEDS,
    },
    // v2.0.9 — active promo-month override (commission %, no secrets).
    promo: (() => { const pr = activePromo(); return pr ? { active: true, commissionPct: pr.commissionPct, until: pr.until || null } : { active: false, commissionPct: null, until: null }; })(),
    // v2.1.4 — launch-month shift offer (owner-approved 26 Nov 2026):
    // single shifts at 500/850, provider paid on the 700/1,200
    // reference. Default OFF until the admin enables it at launch.
    launchOffer: (() => { const lo = activeLaunchOffer(); return lo ? { active: true, until: lo.until || null } : { active: false, until: null }; })(),
    // v2.1.7 — latest published APK for the in-app update checker.
    // Empty (code 0, no URL) until a release is published — the app
    // treats that as "no update available".
    latestApp: { ...config.latestApp },
    note: 'Prices are fixed and announced in advance. No bargaining inside the app.',
  });
});

// ---------------------------------------------------------------- Terms & Conditions (v2.0.8)
// Public: the current version + full text (Arabic binding, English
// summary). The app shows this screen with a scroll-to-bottom gate and
// a checkbox before registration or first booking.
router.get('/terms', (req, res) => {
  res.json({
    version: cat.TERMS_VERSION,
    updatedAt: cat.TERMS_UPDATED_AT,
    textAr: cat.TERMS_AR,
    textEn: cat.TERMS_EN,
    note: 'The Arabic text is the binding version.',
  });
});

// Per-user acceptance state. On login the app checks this: if the stored
// version is older than the current one, the app shows the Terms screen
// and blocks use until the user accepts.
router.get('/me/terms', requireAuth, (req, res) => {
  const u = store.data.users[req.user.phone] || {};
  const acceptedVersion = u.termsAcceptedVersion || null;
  res.json({
    currentVersion: config.termsVersion,
    acceptedVersion,
    acceptedAt: u.termsAcceptedAt || null,
    mustAccept: acceptedVersion !== config.termsVersion,
  });
});

router.post('/me/terms', requireAuth, (req, res) => {
  if (!termsAccepted(req.body)) return termsError(res);
  recordTermsAcceptance(req.user.phone);
  store.audit('terms.accepted', req.user.phone, { version: config.termsVersion, role: req.user.role });
  store.save();
  res.json({ ok: true, version: config.termsVersion, acceptedAt: nowIso() });
});

// ---------------------------------------------------------------- v2.0.9 — patient loyalty vouchers
// After every 4 completed paid visits the patient auto-receives a 50 EGP
// voucher (valid 60 days, min booking 300 EGP, one per booking), fully
// funded by the app. This endpoint exposes the patient's active vouchers
// and progress toward the next one.
router.get('/me/vouchers', requireAuth, (req, res) => {
  expireVouchers();
  const phone = req.user.phone;
  const list = (store.data.vouchers || []).filter((v) => v.patientPhone === phone);
  const completed = completedPaidVisits(phone);
  const pub = (v) => ({ id: v.id, amountEgp: v.amountEgp, issuedAt: v.issuedAt, expiresAt: v.expiresAt, minBookingEgp: v.minBookingEgp, status: v.status, usedBookingId: v.usedBookingId || null, usedAt: v.usedAt || null });
  res.json({
    vouchers: list.filter((v) => v.status === 'active').map(pub),
    used: list.filter((v) => v.status === 'used').map(pub),
    expiredCount: list.filter((v) => v.status === 'expired').length,
    completedPaidVisits: completed,
    visitsToNextVoucher: cat.VOUCHER_EVERY_N_VISITS - (completed % cat.VOUCHER_EVERY_N_VISITS),
    vouchersEarned: Math.floor(completed / cat.VOUCHER_EVERY_N_VISITS),
    voucherAmountEgp: cat.VOUCHER_AMOUNT_EGP,
    voucherValidDays: cat.VOUCHER_VALID_DAYS,
    voucherMinBookingEgp: cat.VOUCHER_MIN_BOOKING_EGP,
  });
});

// ---------------------------------------------------------------- v2.1.0 — notifications (in-app center + FCM push + SMS fallback)
// Delivery order (owner decision 26 Nov 2026 — keep the cost down):
// in-app notification (always, free) -> FCM push (free, when Firebase is
// configured and the user registered a device) -> SMS fallback (0.27
// EGP/message, Together SMS) for CRITICAL events only, when push could
// not reach the user (no device / FCM not configured / all sends failed,
// or still unread 10 minutes later — see the sweep). FCM registration
// tokens are stored server-side only and NEVER returned by any API.
router.post('/me/devices', requireAuth, (req, res) => {
  const token = String(req.body?.fcmToken || '');
  const platform = String(req.body?.platform || '').slice(0, 20) || null;
  try {
    const n = notify.registerDevice(req.user.phone, token, platform);
    res.json({ ok: true, devices: n });
  } catch (e) {
    return bad(res, 400, e.message);
  }
});

router.delete('/me/devices', requireAuth, (req, res) => {
  const removed = notify.unregisterDevice(req.user.phone, req.body?.fcmToken || '');
  res.json({ ok: true, removed });
});

router.get('/me/notifications', requireAuth, (req, res) => {
  const list = notify.notificationsFor(req.user.phone).slice().reverse().map(notify.publicNotification);
  res.json({ notifications: list, unreadCount: list.filter((n) => !n.readAt).length });
});

router.post('/me/notifications/read-all', requireAuth, (req, res) => {
  res.json({ ok: true, readCount: notify.markAllRead(req.user.phone) });
});

router.post('/me/notifications/:id/read', requireAuth, (req, res) => {
  const rec = notify.markRead(req.user.phone, req.params.id);
  if (!rec) return res.status(404).json({ error: 'not_found', message: 'Notification not found.' });
  res.json({ ok: true, notification: rec });
});

// ---------------------------------------------------------------- favorites (v2.1.1)
// Patients keep favourite providers; a booking can name a preferred
// provider (validated at creation) who sees preferredForYou on the radar.
router.post('/me/favorites', requireAuth, requireRole('patient'), (req, res) => {
  const providerId = String(req.body?.providerId || '');
  if (isReservedId(providerId)) return bad(res, 400, 'Invalid providerId.');
  const prov = store.data.providers[providerId];
  if (!prov || prov.status !== 'verified') return res.status(400).json({ error: 'validation_error', message: 'Favourite provider must exist and be verified.' });
  const favs = store.data.favorites[req.user.phone] || (store.data.favorites[req.user.phone] = []);
  if (!favs.includes(providerId)) favs.push(providerId);
  store.save();
  res.status(201).json({ ok: true, favorites: favs });
});
router.delete('/me/favorites/:providerId', requireAuth, requireRole('patient'), (req, res) => {
  const favs = store.data.favorites[req.user.phone] || [];
  store.data.favorites[req.user.phone] = favs.filter((x) => x !== req.params.providerId);
  store.save();
  res.json({ ok: true, favorites: store.data.favorites[req.user.phone] });
});
router.get('/me/favorites', requireAuth, requireRole('patient'), (req, res) => {
  const favs = store.data.favorites[req.user.phone] || [];
  const out = favs.map((id) => store.data.providers[id]).filter(Boolean).map((prov) => ({
    providerId: prov.id, name: prov.name, role: prov.role, tier: prov.tier,
    touristCompatible: touristCompatible(prov),
  }));
  res.json({ favorites: out });
});

// ---------------------------------------------------------------- medical-file interest (v2.1.1 — PLACEHOLDER ONLY)
// Revised item 10: a public, rate-limited interest counter for a future
// full medical file. NO file, NO Pro subscription, NO price, Postgres
// stays DISABLED. Stores only a count + deduped phones.
router.post('/medical-file-interest', (req, res) => {
  const phone = req.body?.phone ? normalizePhone(req.body.phone) : null;
  const rec = store.data.medicalFileInterest || (store.data.medicalFileInterest = { count: 0, phones: [], lastAt: null });
  let recorded = true;
  if (phone) {
    if (rec.phones.includes(phone)) recorded = false;
    else { rec.phones.push(phone); rec.count += 1; rec.lastAt = nowIso(); }
  } else {
    rec.count += 1; rec.lastAt = nowIso();
  }
  store.save();
  res.json({ ok: true, recorded });
});

// ---------------------------------------------------------------- v2.1.2 — languages + in-app language tests
// One separate MCQ test per language a provider claims. The general
// tourist badge needs interview passed + English test passed; a
// tourist booking in language X needs X's test passed. A certificate
// NEVER exempts anyone from a test (it still counts toward points and
// the $15/€15 bonus still needs a verified certificate — unchanged).
// Server-side question bank only (catalog.js LANGUAGE_TESTS); options
// are shuffled at start, like the interview bank. Pass >= 6/8, 15
// minutes, retake after 7 days.
router.get('/languages', (req, res) => {
  res.json({
    languages: languageList(),
    test: { questionsPerTest: cat.LANGUAGE_TEST_QUESTIONS, passMin: cat.LANGUAGE_TEST_PASS_MIN, minutes: cat.LANGUAGE_TEST_MINUTES, retakeDays: cat.LANGUAGE_TEST_RETAKE_DAYS },
  });
});

router.post('/admin/languages', requireAdmin, (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase();
  if (!/^[a-z]{2,5}$/.test(code)) return bad(res, 400, 'code must be a 2–5 letter language code (e.g. de, ru).');
  if (findLanguage(code)) return res.status(409).json({ error: 'conflict', message: 'Language already exists.' });
  const nameAr = String(req.body?.nameAr || '').trim().slice(0, 60);
  const nameEn = String(req.body?.nameEn || '').trim().slice(0, 60);
  const nativeName = String(req.body?.nativeName || nameEn).trim().slice(0, 60);
  if (!nameAr || !nameEn) return bad(res, 400, 'nameAr and nameEn are required.');
  const lang = { code, nameAr, nameEn, nativeName };
  store.data.languages.push(lang);
  store.audit('admin.language_added', 'admin', { code, nameEn, testAvailable: !!cat.LANGUAGE_TESTS[code] });
  store.save();
  res.status(201).json({ ...lang, testAvailable: !!cat.LANGUAGE_TESTS[code], note: cat.LANGUAGE_TESTS[code] ? undefined : 'No question bank for this language yet — tests stay unavailable until a bank is added.' });
});

function languageTestState(p, lang) {
  const rec = (p.languageTests && p.languageTests[lang]) || { attempts: [] };
  const last = rec.attempts[rec.attempts.length - 1] || null;
  const badge = (p.languageBadges && p.languageBadges[lang]) || null;
  return { badge: badge || null, attempts: rec.attempts.length, lastAttemptAt: last ? last.submittedAt : null, lastScore: last ? last.score : null, canRetakeAt: rec.canRetakeAt || null };
}

router.get('/me/language-badges', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  const langs = languageList();
  const tests = {};
  for (const l of langs) tests[l.code] = languageTestState(p, l.code);
  res.json({
    providerId: p.id,
    interviewStatus: p.interviewStatus,
    claimedLanguages: p.claimedLanguages || [],
    touristCompatible: touristCompatible(p),
    englishBlocked: englishBlocked(p),
    badges: p.languageBadges || {},
    tests,
    languages: langs,
    passMin: cat.LANGUAGE_TEST_PASS_MIN, questionsPerTest: cat.LANGUAGE_TEST_QUESTIONS,
  });
});

router.post('/me/language-tests/:lang/start', requireAuth, requireRole('provider'), (req, res) => {
  const lang = String(req.params.lang || '').toLowerCase();
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  if (!findLanguage(lang)) return res.status(404).json({ error: 'not_found', message: 'Unknown language code.' });
  const bank = cat.LANGUAGE_TESTS[lang];
  if (!bank) return res.status(409).json({ error: 'test_unavailable', message: 'No question bank for this language yet — the test cannot be taken.' });
  if (hasLanguageBadge(p, lang)) {
    return res.status(409).json({ error: 'already_passed', message: 'You already passed this language test — the badge is on your profile.' });
  }
  const rec = (p.languageTests && p.languageTests[lang]) || { attempts: [] };
  if (rec.canRetakeAt && new Date(rec.canRetakeAt).getTime() > Date.now()) {
    return res.status(409).json({ error: 'retake_blocked', message: 'Retake cooldown is still active.', canRetakeAt: rec.canRetakeAt });
  }
  const sessions = store.data.languageTestSessions || (store.data.languageTestSessions = {});
  const key = `${p.id}:${lang}`;
  const existing = sessions[key];
  if (existing && new Date(existing.deadlineAt).getTime() > Date.now()) {
    return res.status(409).json({ error: 'conflict', message: 'A language test attempt is already in progress.', deadlineAt: existing.deadlineAt });
  }
  // v2.1.6 (C5): the bank is 12 questions per language and each attempt
  // SAMPLES 8 of them at random — the old code published the whole bank,
  // so the compromised bank (all answers "a", in the public repo) made
  // the test trivially passable. The published options carry NO keys:
  // the client answers by POSITION (0-3) and the server scores the
  // position against the position it stored at start. A raw key letter
  // ("a"–"d") is rejected at submit — it can only come from someone
  // reading the bank, not from the app UI.
  const questions = shuffle([...bank]).slice(0, cat.LANGUAGE_TEST_QUESTIONS);
  const answerKey = {};
  const pub = questions.map((q) => {
    const opts = shuffle([...q.options]);
    answerKey[q.id] = opts.findIndex((o) => o.key === q.correct);
    return { id: q.id, topic: q.topic, text: q.text, options: opts.map((o) => ({ text: o.text })) };
  });
  const attemptId = newId('lt');
  const deadlineAt = new Date(Date.now() + cat.LANGUAGE_TEST_MINUTES * 60 * 1000).toISOString();
  sessions[key] = { attemptId, providerId: p.id, lang, startedAt: nowIso(), deadlineAt, answerKey, pub };
  store.audit('provider.language_test_started', req.user.phone, { providerId: p.id, lang, attemptId });
  store.save();
  res.json({ attemptId, lang, deadlineAt, minutes: cat.LANGUAGE_TEST_MINUTES, totalQuestions: cat.LANGUAGE_TEST_QUESTIONS, passMin: cat.LANGUAGE_TEST_PASS_MIN, questions: pub });
});

router.post('/me/language-tests/:lang/submit', requireAuth, requireRole('provider'), (req, res) => {
  const lang = String(req.params.lang || '').toLowerCase();
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  const sessions = store.data.languageTestSessions || {};
  const key = `${p.id}:${lang}`;
  const active = sessions[key];
  if (!active || (req.body?.attemptId && req.body.attemptId !== active.attemptId)) {
    return bad(res, 409, 'No active language test attempt. Start one first.');
  }
  if (new Date(active.deadlineAt).getTime() < Date.now()) {
    delete sessions[key];
    store.save();
    return res.status(410).json({ error: 'expired', message: 'The language test deadline passed (server time). Start a new attempt.' });
  }
  // v2.1.6 (C5): answers are POSITIONS (0-3) into the options the start
  // call published — scored against the position stored at start. A raw
  // key letter ("a"–"d"), a non-integer, an out-of-range index, or an
  // answer for a question that was not in this attempt is rejected with
  // 400 (it can only come from someone reading the bank, not the app).
  // A missing answer simply scores 0 for that question.
  const rawAnswers = req.body?.answers || {};
  const sampledIds = new Set((active.pub || []).map((q) => q.id));
  const answers = {};
  for (const [qid, v] of Object.entries(rawAnswers)) {
    if (!sampledIds.has(qid)) {
      return bad(res, 400, `Answer for question ${qid} is not part of this attempt.`, { questionId: qid });
    }
    const idx = Number(v);
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) {
      return bad(res, 400, 'Answers must be option positions (0-3) — key letters are not accepted.', { questionId: qid });
    }
    answers[qid] = idx;
  }
  let score = 0;
  for (const q of (active.pub || [])) {
    if (answers[q.id] != null && answers[q.id] === active.answerKey[q.id]) score += 1;
  }
  const total = cat.LANGUAGE_TEST_QUESTIONS;
  const passed = score >= cat.LANGUAGE_TEST_PASS_MIN;
  p.languageTests = p.languageTests || {};
  const rec = p.languageTests[lang] || (p.languageTests[lang] = { attempts: [] });
  const attempt = { attemptId: active.attemptId, startedAt: active.startedAt, submittedAt: nowIso(), score, total, passed, passMin: cat.LANGUAGE_TEST_PASS_MIN };
  rec.attempts.push(attempt);
  rec.canRetakeAt = passed ? null : new Date(Date.now() + cat.LANGUAGE_TEST_RETAKE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  if (passed) {
    p.languageBadges = p.languageBadges || {};
    p.languageBadges[lang] = { passed: true, score, total, passedAt: nowIso() };
  }
  delete sessions[key];
  store.audit('provider.language_test_submitted', req.user.phone, { providerId: p.id, lang, score, total, passed });
  store.save();
  res.json({
    ...attempt, lang, canRetakeAt: rec.canRetakeAt,
    touristCompatible: touristCompatible(p),
    badge: (p.languageBadges && p.languageBadges[lang]) || null,
    message: passed
      ? `Passed the ${lang.toUpperCase()} test (${score}/${total}) — the badge is on your profile.`
      : `Did not pass (${score}/${total}, need ${cat.LANGUAGE_TEST_PASS_MIN}/${total}). You may retake after 7 days.`,
  });
});

// ---------------------------------------------------------------- v2.1.2 — CV / certificate uploads + algorithmic evaluation
// Real file contents reach the server now (v2.1.1 was metadata-only):
// max 5 MB per file, max 10 files per provider, JPEG/PNG/PDF only,
// base64 data URLs in JSON (fits the existing file-store architecture).
// Files live in the same file store, so they reset on redeploy like all
// data — documented in BUILD-STATUS.md. Never collect card data here.
const DOC_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file
const DOC_MAX_FILES = 10;
const DOC_MIMES = ['image/jpeg', 'image/png', 'application/pdf'];
const DOC_KINDS = ['certificate', 'course', 'cv', 'licence', 'id', 'other'];

router.post('/me/documents', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  const kind = String(req.body?.kind || '').toLowerCase();
  if (!DOC_KINDS.includes(kind)) return bad(res, 400, `kind must be one of: ${DOC_KINDS.join(', ')}.`);
  const name = String(req.body?.name || '').trim().slice(0, 200);
  if (!name) return bad(res, 400, 'name required (file name).');
  if ((p.documents || []).length >= DOC_MAX_FILES) return res.status(409).json({ error: 'too_many_documents', message: `Maximum ${DOC_MAX_FILES} documents per provider.` });
  const parsed = parseDataUrl(req.body?.data, { allowedMimes: DOC_MIMES, maxBytes: DOC_MAX_BYTES, label: 'Document' });
  if (parsed.error) return bad(res, 400, parsed.error);
  const doc = { id: newId('doc'), kind, name, size: parsed.size, mime: parsed.mime, data: parsed.data, uploadedAt: nowIso() };
  p.documents = p.documents || [];
  p.documents.push(doc);
  // Also mirror certificate/course uploads into the metadata lists the
  // admin verifies (no double-count: points only count VERIFIED entries).
  if (kind === 'certificate' && !(p.certificates || []).some((c) => c.name === name)) {
    p.certificates = p.certificates || [];
    p.certificates.push({ name, verified: false });
  }
  if (kind === 'course' && !(p.courses || []).some((c) => c.name === name)) {
    p.courses = p.courses || [];
    p.courses.push({ name, verified: false });
  }
  refreshCvEvaluation(p);
  store.audit('provider.document_uploaded', req.user.phone, { providerId: p.id, docId: doc.id, kind, name, size: doc.size, cvScore: p.cvEvaluation ? p.cvEvaluation.total : null });
  store.save();
  res.status(201).json({
    document: { id: doc.id, kind: doc.kind, name: doc.name, size: doc.size, mime: doc.mime, uploadedAt: doc.uploadedAt },
    evaluation: p.cvEvaluation,
    note: 'The file is stored with your application for admin review. Points only change when the admin verifies a certificate or course.',
  });
});

router.get('/me/documents', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  res.json({
    documents: (p.documents || []).map((d) => ({ id: d.id, kind: d.kind, name: d.name, size: d.size, mime: d.mime, uploadedAt: d.uploadedAt })),
    evaluation: p.cvEvaluation || null,
    limits: { maxBytesPerFile: DOC_MAX_BYTES, maxFiles: DOC_MAX_FILES, allowedMimes: DOC_MIMES },
  });
});

// Admin reads one uploaded document WITH content (admin only).
router.get('/admin/providers/:id/documents/:docId', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const doc = (p.documents || []).find((d) => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
  store.audit('admin.document_read', 'admin', { providerId: p.id, docId: doc.id, kind: doc.kind });
  res.json({ id: doc.id, providerId: p.id, kind: doc.kind, name: doc.name, size: doc.size, mime: doc.mime, uploadedAt: doc.uploadedAt, data: doc.data });
});

// ---------------------------------------------------------------- v2.1.2 — admin review queue (applications)
// Each application shows the algorithmic score breakdown, interview
// score, points, and uploaded documents. The ADMIN (Mohamed) approves
// or rejects — the final decision is his; the recommendation is advisory.
function applicationView(p) {
  const pts = p.points || computePoints(p, Object.values(store.data.bookings));
  return {
    providerId: p.id, name: p.name, phone: p.phone, role: p.role, providerType: p.providerType || p.role,
    tier: p.tier, status: p.status, submittedAt: p.createdAt,
    rejectionReason: p.rejectionReason || null, rejectedAt: p.rejectedAt || null,
    interviewStatus: p.interviewStatus, interviewScore: p.interviewScore,
    points: pts,
    cvEvaluation: p.cvEvaluation || evaluateProviderDocuments(p),
    documents: (p.documents || []).map((d) => ({ id: d.id, kind: d.kind, name: d.name, size: d.size, mime: d.mime, uploadedAt: d.uploadedAt })),
    certificates: p.certificates || [], courses: p.courses || [],
    languageBadges: p.languageBadges || {}, claimedLanguages: p.claimedLanguages || [],
  };
}

router.get('/admin/applications', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'pending');
  let list = Object.values(store.data.providers);
  if (status !== 'all') list = list.filter((p) => p.status === status);
  list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json({ applications: list.map(applicationView), count: list.length, status });
});

router.post('/admin/applications/:id/approve', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  if (p.status === 'verified') return bad(res, 409, 'This application is already approved (provider verified).');
  p.status = 'verified';
  p.roleVerified = true;
  recomputeProviderPoints(p);
  refreshCvEvaluation(p);
  store.audit('admin.application_approved', 'admin', { providerId: p.id, cvScore: p.cvEvaluation ? p.cvEvaluation.total : null, recommendation: p.cvEvaluation ? p.cvEvaluation.recommendation : null });
  store.save();
  res.json(applicationView(p));
});

router.post('/admin/applications/:id/reject', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  if (p.status === 'verified') return bad(res, 409, 'A verified provider cannot be rejected here — use suspend instead.');
  const reason = String(req.body?.reason || '').slice(0, 500) || null;
  p.status = 'rejected';
  p.rejectionReason = reason;
  p.rejectedAt = nowIso();
  store.audit('admin.application_rejected', 'admin', { providerId: p.id, reason, cvScore: p.cvEvaluation ? p.cvEvaluation.total : null });
  store.save();
  res.json(applicationView(p));
});

// ---------------------------------------------------------------- v2.1.2 — receipt-photo payment confirmation
// For online payment (InstaPay / card) the patient uploads a receipt
// photo at booking (or right after, while the booking is still held).
// The booking stays pending until an admin reviews the receipt:
// acceptance is blocked while receipt.status is 'pending' (see the
// accept gate) and the radar hides it. Cash is unchanged (receipt at
// the visit). Never collect card data — receipt image only.
router.post('/bookings/:id/receipt', requireAuth, requireRole('patient'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.patientPhone !== req.user.phone) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (b.paymentMethod === 'cash_receipt') return bad(res, 400, 'Cash payments use a receipt at the visit — no receipt photo is needed for this booking.');
  if (b.status !== 'held') return bad(res, 409, `Receipt photos can only be uploaded while the booking is held (status is ${b.status}).`);
  if (b.receipt && b.receipt.status === 'pending') return res.status(409).json({ error: 'receipt_pending_review', message: 'A receipt photo is already under admin review for this booking.' });
  if (b.receipt && b.receipt.status === 'approved') return res.status(409).json({ error: 'receipt_already_approved', message: 'The receipt for this booking is already approved.' });
  const parsed = receiptFromBody({ receiptImage: req.body?.receiptImage || req.body?.data }, b.paymentMethod);
  if (parsed.error) return bad(res, 400, parsed.error);
  if (!parsed.receipt) return bad(res, 400, 'receiptImage (base64 data URL, JPEG/PNG, max 3 MB) is required.');
  attachReceipt(b, parsed);
  store.audit('booking.receipt_uploaded', req.user.phone, { bookingId: b.id });
  store.save();
  res.status(201).json({ ok: true, bookingId: b.id, receipt: b.receipt, note: 'Receipt uploaded — the booking stays pending until the admin reviews it.' });
});

router.get('/admin/bookings/:id/receipt', requireAdmin, (req, res) => {
  const b = store.data.bookings[req.params.id];
  if (!b) return res.status(404).json({ error: 'not_found', message: 'Booking not found.' });
  const img = store.data.receiptImages[b.id] || null;
  res.json({ bookingId: b.id, receipt: b.receipt || null, image: img ? img.data : null, mime: img ? img.mime : null, size: img ? img.size : null });
});

router.post('/admin/bookings/:id/receipt/approve', requireAdmin, (req, res) => {
  const b = store.data.bookings[req.params.id];
  if (!b) return res.status(404).json({ error: 'not_found', message: 'Booking not found.' });
  if (!b.receipt) return bad(res, 409, 'This booking has no receipt photo.');
  if (b.receipt.status === 'approved') return bad(res, 409, 'Receipt already approved.');
  b.receipt.status = 'approved';
  b.receipt.reviewedAt = nowIso();
  b.receipt.note = String(req.body?.note || '').slice(0, 500) || null;
  b.receiptStatus = 'approved'; // v2.1.6 (C6)
  // v2.1.3 — a package booking held for receipt review starts once the
  // receipt is approved (the month's escrow is then real).
  if (b.kind === 'package' && b.status === 'held') b.status = 'accepted';
  store.audit('admin.receipt_approved', 'admin', { bookingId: b.id });
  store.save();
  res.json({ ok: true, bookingId: b.id, receipt: b.receipt });
});

router.post('/admin/bookings/:id/receipt/reject', requireAdmin, (req, res) => {
  const b = store.data.bookings[req.params.id];
  if (!b) return res.status(404).json({ error: 'not_found', message: 'Booking not found.' });
  if (!b.receipt) return bad(res, 409, 'This booking has no receipt photo.');
  if (b.receipt.status === 'approved') return bad(res, 409, 'An approved receipt cannot be rejected — resolve it with the patient instead.');
  const note = String(req.body?.note || '').slice(0, 500);
  if (!note) return bad(res, 400, 'A rejection needs a short note for the patient (what is wrong with the receipt).');
  b.receipt.status = 'rejected';
  b.receipt.reviewedAt = nowIso();
  b.receipt.note = note;
  b.receiptStatus = 'rejected'; // v2.1.6 (C6)
  store.audit('admin.receipt_rejected', 'admin', { bookingId: b.id, note });
  store.save();
  res.json({ ok: true, bookingId: b.id, receipt: b.receipt, note: 'The patient can upload a new receipt photo while the booking is still held.' });
});

// ---------------------------------------------------------------- client reports (v2.1.7)
// Crash / unclean-exit / JS-error reports sent by the app itself (see
// web/app.js initSessionTracking). PUBLIC — the app may be logged out
// when it dies — and rate-limited to 10/hour per IP. Only allowlisted
// fields are stored, capped at 200 entries; tokens, PINs and passwords
// are never accepted or stored. Admin reads them via
// GET /api/admin/client-reports.
const CLIENT_REPORT_MAX = 200;
const CLIENT_REPORT_PER_HOUR = 10;
router.post('/client-report', (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const limits = store.data.clientReportLimits || (store.data.clientReportLimits = {});
  const rec = limits[ip] || { requests: [] };
  rec.requests = (rec.requests || []).filter((t) => t > hourAgo);
  if (rec.requests.length >= CLIENT_REPORT_PER_HOUR) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many client reports from this IP.' });
  }
  rec.requests.push(now);
  limits[ip] = rec;
  const b = req.body || {};
  const kind = b.kind;
  if (kind !== 'unclean_exit' && kind !== 'js_error') return bad(res, 400, 'kind must be unclean_exit or js_error.');
  if (kind === 'js_error' && (typeof b.message !== 'string' || !b.message.trim())) return bad(res, 400, 'message is required for js_error reports.');
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  const entry = {
    id: newId('crep'), kind,
    lastScreen: str(b.lastScreen, 200),
    lastHeartbeat: typeof b.lastHeartbeat === 'number' ? b.lastHeartbeat : null,
    // v2.1.8 — the last native step the client marked before it died
    // (e.g. "push:register"): set around native calls that a JS
    // try/catch cannot catch, so the next report pinpoints the kill.
    lastStep: str(b.lastStep, 100),
    message: str(b.message, 2000),
    stack: str(b.stack, 2000),
    screen: str(b.screen, 200),
    userAgent: str(b.userAgent, 300),
    appVersion: str(b.appVersion, 40),
    // A phone is attached ONLY when the app is logged in; it is a
    // diagnostic hint only, never trusted for identity (the endpoint is
    // public). Any other field in the body (token, pin, password, ...)
    // is dropped, never stored.
    phone: (typeof b.phone === 'string' && /^01[0-9]{9}$/.test(b.phone)) ? b.phone : null,
    createdAt: nowIso(),
  };
  const list = store.data.clientReports || (store.data.clientReports = []);
  list.push(entry);
  while (list.length > CLIENT_REPORT_MAX) list.shift();
  store.save();
  res.json({ ok: true, id: entry.id });
});
router.get('/admin/client-reports', requireAdmin, (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 100);
  res.json((store.data.clientReports || []).slice(-limit).reverse());
});

// ---------------------------------------------------------------- monitor (v2.1.1)
// READ-ONLY oversight summary for Muse (owner-approved 26 Nov 2026).
// Auth ONLY by header X-Monitor-Token exact match (timingSafeEqual when
// lengths match). Env unset -> 404 so the endpoint looks disabled.
// Wrong/missing token -> 401 generic. NO PII: no phones, names,
// addresses. Each access is audit-logged WITHOUT the token value.
router.get('/monitor/summary', (req, res) => {
  const configured = config.museMonitorToken;
  if (!configured) return res.status(404).json({ error: 'not_found', message: 'Route not found.' });
  const presented = req.headers['x-monitor-token'];
  let ok = false;
  if (typeof presented === 'string' && presented.length === configured.length) {
    try { ok = crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(configured)); } catch { ok = false; }
  }
  if (!ok) return res.status(401).json({ error: 'unauthorized', message: 'Invalid or missing monitor token.' });
  const today = new Date().toISOString().slice(0, 10);
  const bookings = Object.values(store.data.bookings);
  const todayBookings = bookings.filter((b) => (b.createdAt || '').slice(0, 10) === today);
  const byStatus = {};
  for (const b of todayBookings) byStatus[b.status] = (byStatus[b.status] || 0) + 1;
  const openComplaints = store.data.safetyReports.filter((r) => r.type === 'complaint' && r.status === 'open');
  const openSos = store.data.sos.filter((x) => x.status === 'open');
  const overdueVisits = bookings.filter((b) => b.overdue && ['accepted', 'provider_confirmed'].includes(b.status));
  const circumventionReports = (store.data.circumventionReports || []).filter((r) => r.status === 'open');
  // Settlement snapshot (ledger only — no money movement here).
  let appOwes = 0, provOwes = 0, pending = 0, hold = 0;
  for (const b of bookings) {
    if (!['released', 'auto_released'].includes(b.status)) continue;
    const holdOpen = b.complaintStatus === 'open' || b.circumventionHold;
    const windowOpen = b.complaintDeadline && Date.now() < new Date(b.complaintDeadline).getTime() && b.complaintStatus !== 'rejected';
    if (holdOpen || windowOpen) hold += b.providerShareEgp || 0;
    else if (b.cashCollectedByProvider) provOwes += b.appShareEgp || 0;
    else appOwes += b.providerShareEgp || 0;
  }
  for (const b of bookings) {
    if (['provider_confirmed', 'patient_confirmed', 'reviewed'].includes(b.status)) {
      if (b.kind === 'package') {
        // v2.1.3 — pending is only the UNRELEASED remainder (days already
        // released weekly are not pending anymore).
        const releasedProv = (b.packageDayReleases || []).reduce((s, x) => s + (x.providerShareEgp || 0), 0);
        pending += Math.max(0, (b.estimatedProviderShareEgp || 0) - releasedProv);
      } else pending += b.estimatedProviderShareEgp ?? b.providerShareEgp ?? 0;
    }
  }
  // v2.1.1 — repeat-booking rate (owner's launch metric, 26 Nov 2026):
  // share of patients with 2+ COMPLETED bookings, overall and last 30 days.
  // "Completed" = the visit happened (provider_confirmed or later) — a
  // cancelled/refunded/held booking never counts. Grouped by patient phone;
  // only counts + rates leave the server, never any phone or name.
  const COMPLETED = ['provider_confirmed', 'patient_confirmed', 'reviewed', 'released', 'auto_released'];
  const completedAt = (b) => b.releasedAt || b.patientConfirmedAt || b.providerConfirmedAt || b.createdAt || null;
  const repeatRate = (list) => {
    const perPatient = {};
    for (const b of list) {
      if (!COMPLETED.includes(b.status) || !b.patientPhone) continue;
      perPatient[b.patientPhone] = (perPatient[b.patientPhone] || 0) + 1;
    }
    const patients = Object.keys(perPatient).length;
    const repeat = Object.values(perPatient).filter((n) => n >= 2).length;
    return { patientsWithCompleted: patients, repeatPatients: repeat, rate: patients ? Math.round((repeat / patients) * 1000) / 1000 : 0 };
  };
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentCompleted = bookings.filter((b) => {
    const t = completedAt(b);
    return t && new Date(t).getTime() >= thirtyDaysAgo;
  });
  const repeatBookingRate = { overall: repeatRate(bookings), last30Days: repeatRate(recentCompleted) };
  // v2.1.2 — pending applications (no PII: provider id + scores only,
  // so the admin partner can read them and send Mohamed a
  // recommendation in chat) + receipts awaiting review.
  const pendingApplications = Object.values(store.data.providers)
    .filter((p) => p.status === 'pending')
    .map((p) => ({
      providerId: p.id, status: p.status,
      interviewStatus: p.interviewStatus,
      interviewScore: p.interviewScore ? p.interviewScore.total : null,
      pointsTotal: (p.points && p.points.total) || 0, tier: p.tier || 'Starter',
      cvScore: (p.cvEvaluation || evaluateProviderDocuments(p)).total,
      cvRecommendation: (p.cvEvaluation || evaluateProviderDocuments(p)).recommendation,
      documentsCount: (p.documents || []).length,
    }));
  const pendingReceipts = bookings
    .filter((b) => b.receipt && b.receipt.status === 'pending')
    .map((b) => ({ id: b.id }));
  // v2.1.3 — pending package requests + active packages (no PII: request
  // id + package type + status only, so the admin partner can read them
  // and send Mohamed a recommendation in chat).
  const pendingPackageRequests = (store.data.packageRequests || [])
    .filter((r) => r.status === 'submitted')
    .map((r) => ({ id: r.id, packageType: r.packageType, level: r.level || null, status: r.status }));
  const activePackages = bookings
    .filter((b) => b.kind === 'package' && ['accepted', 'provider_confirmed', 'patient_confirmed'].includes(b.status))
    .map((b) => ({ id: b.id, level: b.level || null, daysCompleted: b.daysCompleted || 0, extraDaysCompleted: b.extraDaysCompleted || 0 }));
  store.audit('monitor.access', 'monitor', { ip: req.ip });
  store.save();
  res.json({
    date: today,
    bookingsToday: { total: todayBookings.length, byStatus },
    openComplaints: { count: openComplaints.length, items: openComplaints.map((r) => ({ id: r.id, status: r.status })) },
    openSos: { count: openSos.length, items: openSos.map((x) => ({ id: x.id, bookingId: x.bookingId })) },
    overdueVisits: { count: overdueVisits.length, items: overdueVisits.map((b) => ({ id: b.id })) },
    circumventionReports: { count: circumventionReports.length, items: circumventionReports.map((r) => ({ id: r.id, bookingId: r.bookingId })) },
    settlement: { appOwesProviderEgp: appOwes, providerOwesAppEgp: provOwes, pendingEgp: pending, complaintHoldEgp: hold },
    repeatBookingRate,
    pendingApplications: { count: pendingApplications.length, items: pendingApplications },
    pendingReceipts: { count: pendingReceipts.length, items: pendingReceipts },
    pendingPackageRequests: { count: pendingPackageRequests.length, items: pendingPackageRequests },
    activePackages: { count: activePackages.length, items: activePackages },
    medicalFileInterestCount: (store.data.medicalFileInterest || {}).count || 0,
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
  // v2.1.1 (audit #15 / M18): bcrypt-hashed code, NEVER logged; a
  // re-request does NOT reset the attempt counter.
  rec.codeHashBcrypt = hashOtpCode(code);
  delete rec.codeHash;
  rec.expiresAt = new Date(Date.now() + config.otpTtlMinutes * 60 * 1000).toISOString();
  rec.attempts = rec.attempts || 0;
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
    store.audit('auth.otp_request_failed', phone, { channel });
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
  // v2.1.1 (audit #8): the demo-code bypass works ONLY when mockOtp is
  // true (dev/test). In production it never applies.
  const isDemo = config.mockOtp && (phone === '01000000001' || phone === '01000000002') && code === DEMO_OTP;
  if (!isDemo) {
    if (!rec) { store.audit('auth.otp_verify_failed', phone, { reason: 'no_otp' }); return res.status(401).json({ error: 'unauthorized', message: 'No OTP requested for this number.' }); }
    if (new Date(rec.expiresAt).getTime() < Date.now()) {
      delete store.data.otps[phone]; store.save();
      store.audit('auth.otp_verify_failed', phone, { reason: 'expired' });
      return res.status(401).json({ error: 'unauthorized', message: 'OTP expired. Request a new one.' });
    }
    if ((rec.attempts || 0) >= config.otpMaxAttempts) {
      delete store.data.otps[phone]; store.save();
      store.audit('auth.otp_verify_failed', phone, { reason: 'too_many_attempts' });
      return res.status(401).json({ error: 'unauthorized', message: 'Too many wrong attempts. Request a new OTP.' });
    }
    if (!verifyOtpCode(code, rec)) {
      rec.attempts = (rec.attempts || 0) + 1;
      store.save();
      store.audit('auth.otp_verify_failed', phone, { reason: 'wrong_code' });
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
//   v2.1.8 — password gate: { phone, password?, role? }. Accounts with
//     a passwordHash REQUIRE the matching password (wrong password ->
//     generic 401, never revealing which field is wrong; 5 failures in
//     15 minutes -> 429 lockout). Accounts without one (legacy, or a
//     brand-new phone) log in phone-only ONCE and the client forces
//     set-password immediately (response: requiresPassword: true); a
//     temp password from an admin reset forces it too
//     (requiresPasswordChange: true).

// ---------------------------------------------------------------- v2.1.8
// Password-gated login (owner decision 26 Nov 2026): phone-only login
// was the security review's C1 — anyone who knew a number could take
// over the account. Login is now phone + a password the user chooses
// themselves; the server stores ONLY a bcrypt hash (cost 10), never
// plaintext, never in logs or audit entries. Full OTP stays deferred
// until full launch, so the legacy phone-only path is kept ONLY as a
// one-time migration step: an account without a passwordHash logs in
// once and the client immediately forces set-password, after which
// password login is mandatory.
// Migration shape: user records carry passwordHash (string | undefined),
// passwordSetAt (ISO | undefined), mustChangePassword (bool).
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 128;
const PASSWORD_LOCKOUT_MAX = 5; // failed attempts in the window -> 429
const PASSWORD_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= PASSWORD_MIN_LENGTH && pw.length <= PASSWORD_MAX_LENGTH;
}
function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
function passwordMatches(pw, hash) {
  if (typeof pw !== 'string' || typeof hash !== 'string' || !hash) return false;
  try { return bcrypt.compareSync(pw, hash); } catch (e) { return false; }
}
function recentLoginFailures(phone) {
  const bucket = (store.data.loginFailures || {})[phone];
  if (!bucket || !Array.isArray(bucket.failures)) return [];
  const since = Date.now() - PASSWORD_LOCKOUT_WINDOW_MS;
  return bucket.failures.filter((t) => typeof t === 'number' && t > since);
}
function recordLoginFailure(phone) {
  const failures = store.data.loginFailures || (store.data.loginFailures = {});
  const bucket = failures[phone] || (failures[phone] = { failures: [] });
  bucket.failures = recentLoginFailures(phone);
  bucket.failures.push(Date.now());
  store.save();
}
function clearLoginFailures(phone) {
  if (store.data.loginFailures && store.data.loginFailures[phone]) {
    delete store.data.loginFailures[phone];
    store.save();
  }
}
// Revoke every live refresh token for a phone (used after an admin
// password reset so a stolen session cannot outlive the reset).
function revokeUserRefreshTokens(phone) {
  let revoked = 0;
  for (const rec of Object.values(store.data.refreshTokens || {})) {
    if (rec && rec.phone === phone && !rec.revoked) { rec.revoked = true; revoked++; }
  }
  if (revoked) store.save();
  return revoked;
}
// Temporary password for admin resets: 8 chars from an unambiguous
// alphabet (no 0/O/1/l/I) — the admin reads it to the user once; the
// user must choose their own password on next login.
function generateTempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(8)) out += chars[b % chars.length];
  return out;
}
// The authMethod + refresh TTL of the phone's most recent live refresh
// token — used when a route issues fresh tokens for an already
// authenticated phone (provider registration). Password and phone-only
// sessions keep the 24h refresh; OTP sessions keep the configured TTL.
function authMethodForPhone(phone) {
  let latest = null;
  for (const rec of Object.values(store.data.refreshTokens || {})) {
    if (rec && rec.phone === phone && !rec.revoked && (!latest || (rec.createdAt || 0) > (latest.createdAt || 0))) latest = rec;
  }
  if (!latest) return { refreshTtlDays: 1, authMethod: 'phone-only' };
  if (latest.authMethod === 'phone-only' || latest.authMethod === 'password') return { refreshTtlDays: 1, authMethod: latest.authMethod };
  return { refreshTtlDays: config.refreshTtlDays, authMethod: latest.authMethod || null };
}
// Per-phone attempt cap shared by login-phone and register (5/hour,
// same bucket as OTP requests). Returns true when the cap is hit.
// Register uses its OWN bucket (phoneRegisterLogins): a registration
// must not consume the login attempts of the same phone (or a fresh
// registration would eat the lockout test's 5 login attempts).
function phoneRateLimitExceeded(phone, bucketKey) {
  const key = bucketKey || 'phoneLogins';
  const logins = store.data[key] || (store.data[key] = {});
  const rec = logins[phone] || { requests: [] };
  const hourAgo = Date.now() - 60 * 60 * 1000;
  rec.requests = (rec.requests || []).filter((t) => t > hourAgo);
  if (rec.requests.length >= config.otpMaxRequestsPerHour) return true;
  rec.requests.push(Date.now());
  logins[phone] = rec;
  return false;
}
// New-device bookkeeping shared by login-phone and register (v2.1.6 C1
// interim): records the device on the user record and returns whether
// it is unseen. Audit + the new-device warning are the caller's job.
function recordDevice(userRec, req) {
  userRec.devices = userRec.devices || [];
  const rawDeviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim().slice(0, 128) : '';
  const deviceId = rawDeviceId || `ua:${sha256(req.headers['user-agent'] || 'unknown').slice(0, 12)}`;
  const known = userRec.devices.find((d) => d.id === deviceId);
  const isNewDevice = !known;
  if (known) known.lastSeenAt = nowIso();
  else userRec.devices.push({ id: deviceId, firstSeenAt: nowIso(), lastSeenAt: nowIso(), userAgent: String(req.headers['user-agent'] || '').slice(0, 200) });
  return { isNewDevice, deviceId };
}
// Best-effort in-app + push warning when a login comes from a device
// that is not the account's first — if it was not the owner, they can
// contact the admin. A failed notification never blocks login.
function warnNewDevice(phone, userRec, isNewDevice) {
  if (!isNewDevice || userRec.devices.length <= 1) return;
  notify.notifyUser(phone, {
    type: 'security', titleAr: 'دخول من جهاز جديد', titleEn: 'Login from a new device',
    bodyAr: 'تم الدخول إلى حسابك من جهاز لم نره من قبل. إذا لم يكن هذا أنت، تواصل مع إدارة التطبيق فورًا.',
    bodyEn: 'Your account was signed in from a device we have not seen before. If this was not you, contact the app admin right away.',
    data: { type: 'new_device' }, critical: false,
  }).catch(() => {});
}
router.post('/auth/login-phone', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return bad(res, 400, 'Valid Egyptian phone number required (01xxxxxxxxx).');
  // v2.1.0 — phone-only login is ONLY a fallback while no real OTP
  // provider is configured. Once ANY OTP provider is switched on (SMS
  // or WhatsApp — owner decision 26 Nov 2026: code-ready now,
  // activation later), phone-only login is disabled in production —
  // anyone who knows a number could otherwise enter as that account.
  // Dev/test are unaffected (mock OTP there).
  if (config.isProd && config.anyOtpConfigured()) {
    return res.status(410).json({ error: 'phone_login_disabled', message: 'Phone-only login is disabled now that OTP login is active. Request a login code instead.' });
  }
  const provider = store.getProviderByPhone(phone);
  if (req.body?.role === 'provider' && !provider) {
    return res.status(403).json({ error: 'forbidden', message: 'This phone is not registered as a provider. Register as a provider first.' });
  }
  // v2.1.8 — honour the requested role. A phone can be BOTH a patient
  // and a provider (a nurse booking care for a family member), so the
  // token role must be the role the user asked to log in as. The 403
  // above already rejects role=provider for a phone with no provider
  // record. (Previously the provider record forced a provider token
  // even for role=patient, so dual-role users could never use the
  // patient side — favourites, booking and complaint all 403'd.
  // Found by the v2.1.8 Playwright viewport test.)
  const role = req.body?.role === 'provider' ? 'provider' : 'patient';
  // v2.1.8 — lockout FIRST: a password account with 5 failed attempts
  // in 15 minutes is locked out (429 + audit) before the hourly cap is
  // consulted, so the lockout is observable and audited on its own
  // (both caps are 5, so the hourly cap would otherwise mask it).
  const existingUser = store.data.users[phone];
  if (existingUser && typeof existingUser.passwordHash === 'string' && existingUser.passwordHash && recentLoginFailures(phone).length >= PASSWORD_LOCKOUT_MAX) {
    store.audit('auth.login_locked_out', phone, { role });
    return res.status(429).json({ error: 'rate_limited', message: 'Too many failed login attempts for this number. Try again in 15 minutes.' });
  }
  if (phoneRateLimitExceeded(phone)) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many login attempts for this number. Try again later.' });
  }
  if (!store.data.users[phone]) store.data.users[phone] = { phone, createdAt: nowIso() };
  const userRec = store.data.users[phone];
  // v2.1.8 — password gate (see the helpers above). A password account
  // requires its password; a legacy account logs in phone-only ONCE
  // and the client forces set-password (requiresPassword: true).
  const hasPassword = typeof userRec.passwordHash === 'string' && !!userRec.passwordHash;
  let authMethod = 'phone-only';
  let requiresPassword = false;
  let requiresPasswordChange = false;
  if (hasPassword) {
    if (!passwordMatches(req.body?.password, userRec.passwordHash)) {
      // Generic 401 — never reveal whether the phone or the password
      // was wrong. No password value is logged or audited.
      recordLoginFailure(phone);
      store.audit('auth.login_wrong_password', phone, { role });
      return res.status(401).json({ error: 'unauthorized', message: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
    }
    clearLoginFailures(phone);
    authMethod = 'password';
    if (userRec.mustChangePassword) requiresPasswordChange = true;
  } else {
    requiresPassword = true;
  }
  // v2.1.6 (C1 interim): phone-only AND password logins get a SHORT
  // refresh token (24h instead of 7 days) — a stolen session from a
  // known phone number dies within a day.
  const tokens = issueTokens({ phone, role, providerId: provider ? provider.id : null }, undefined, { refreshTtlDays: 1, authMethod });
  // v2.1.6 (C1 interim): REAL new-device detection. The app sends a
  // persistent deviceId (web: localStorage; see web/app.js); when it is
  // absent the fingerprint falls back to a hash of the User-Agent.
  // A login from an unseen device alerts the user in-app and is
  // audited + listed in the admin dashboard. (The old check only
  // flagged the FIRST login ever — it compared the request count
  // after pushing the current request.)
  const { isNewDevice, deviceId } = recordDevice(userRec, req);
  store.audit(isNewDevice ? 'auth.phone_login_new_device' : 'auth.phone_login', phone, { role, authMethod: hasPassword ? 'password' : 'phone-only-fallback', newDevice: isNewDevice, deviceId: deviceId.slice(0, 24) });
  warnNewDevice(phone, userRec, isNewDevice);
  store.save();
  // `token` is the field the web frontend reads (alias of accessToken).
  res.json({ ...tokens, token: tokens.accessToken, role, providerId: provider ? provider.id : null, phone, authMethod, newDevice: isNewDevice, requiresPassword, requiresPasswordChange });
});

// ---------------------------------------------------------------- v2.1.8
// POST /api/auth/register { phone, password, terms, deviceId? } — a new
// user registers with a phone + a password OF THEIR OWN choosing (min 6
// chars). The server stores ONLY the bcrypt hash, never plaintext, and
// issues the same tokens as login (15-min access, 24h refresh). The
// terms scroll-to-accept is server-enforced, like provider registration.
// Registering an already-registered phone is a 409 (sign in instead).
router.post('/auth/register', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return bad(res, 400, 'Valid Egyptian phone number required (01xxxxxxxxx).');
  const password = req.body?.password;
  if (!validPassword(password)) return bad(res, 400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (!termsAccepted(req.body?.terms)) return termsError(res);
  if (store.data.users[phone]) return res.status(409).json({ error: 'conflict', message: 'This phone number is already registered. Sign in instead.' });
  if (phoneRateLimitExceeded(phone, 'phoneRegisterLogins')) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many registration attempts for this number. Try again later.' });
  }
  const userRec = { phone, createdAt: nowIso(), passwordHash: hashPassword(password), passwordSetAt: nowIso(), mustChangePassword: false, devices: [] };
  store.data.users[phone] = userRec;
  recordTermsAcceptance(phone);
  const tokens = issueTokens({ phone, role: 'patient', providerId: null }, undefined, { refreshTtlDays: 1, authMethod: 'password' });
  const { isNewDevice, deviceId } = recordDevice(userRec, req);
  store.audit('auth.registered', phone, { role: 'patient', authMethod: 'password', newDevice: isNewDevice, deviceId: deviceId.slice(0, 24) });
  warnNewDevice(phone, userRec, isNewDevice);
  store.save();
  res.status(201).json({ ...tokens, token: tokens.accessToken, role: 'patient', providerId: null, phone, authMethod: 'password', newDevice: isNewDevice, requiresPassword: false, requiresPasswordChange: false });
});

// POST /api/auth/set-password { password } — the logged-in user chooses
// (or changes) their own password. Used by the migration gate (legacy
// accounts on first login) and after an admin reset (temp password).
// The password value is never logged or audited — only the fact that a
// password was set, and whether it was a temp-password change.
router.post('/auth/set-password', requireAuth, (req, res) => {
  const password = req.body?.password;
  if (!validPassword(password)) return bad(res, 400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  const userRec = store.data.users[req.user.phone] || (store.data.users[req.user.phone] = { phone: req.user.phone, createdAt: nowIso() });
  const wasTemp = userRec.mustChangePassword === true;
  userRec.passwordHash = hashPassword(password);
  userRec.passwordSetAt = nowIso();
  userRec.mustChangePassword = false;
  store.audit('auth.password_set', req.user.phone, { via: wasTemp ? 'temp' : 'self' });
  store.save();
  res.json({ ok: true, requiresPassword: false, requiresPasswordChange: false });
});

// ---------------------------------------------------------------- auth
router.post('/auth/refresh', (req, res) => {
  const presented = req.body?.refreshToken;
  const rec = verifyRefreshToken(presented);
  if (!rec) {
    // v2.1.1 (M9): reuse of a revoked/unknown refresh token revokes the
    // whole family + audits 'auth.refresh_reuse'.
    const fam = detectRefreshReuse(presented);
    store.audit('auth.refresh_failed', typeof presented === 'string' ? 'unknown' : 'unknown', { reuseDetected: !!fam, familyId: fam || undefined });
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired refresh token.' });
  }
  // Rotate within the SAME family; revoke the old token.
  // v2.1.6 (C1 interim): a phone-only family keeps its short 24h
  // refresh lifetime on rotation; OTP families keep 7 days.
  // v2.1.8: password families keep 24h too — a password login is
  // stronger than phone-only, but the short refresh stays the policy
  // until OTP lands (same tokens as today: 15-min access, 24h refresh).
  const tokens = issueTokens({ phone: rec.phone, role: rec.role, providerId: rec.providerId }, rec.familyId,
    rec.authMethod === 'phone-only' || rec.authMethod === 'password' ? { refreshTtlDays: 1, authMethod: rec.authMethod } : { authMethod: rec.authMethod || null });
  rec.revoked = true;
  store.save();
  store.audit('auth.refresh_used', rec.phone, { familyId: rec.familyId });
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
  // v2.1.1 (audit #23): a missing distance is NOT silently 0 — the
  // client must send distanceKm or a hotelId (the web flow requires
  // km/hotel first). Callers map this to 400 'distance_required'.
  if (distance == null) return { error: 'distance_required' };
  const fee = cat.distanceFee(distance, transport);
  if (fee.error) return { error: fee.error };
  if (fee.contract_required) {
    return { contract_required: true, distanceKm: distance, band: fee.band, message: 'Over 35 km: special contract only, no automatic pricing.' };
  }
  return { baseEgp: base, distanceFeeEgp: fee.fee_egp, totalEgp: base + fee.fee_egp, distanceKm: distance, band: fee.band, hotel };
}

// v2.1.1 (M11/M13): shared booking-input validation. Returns an error
// response object when invalid, else null. Length caps: name <=120,
// notes <=1000, address <=300. scheduledAt must be a valid date.
// triage.dangerSigns must be an array; triage.level==='emergency'
// rejects the booking even with empty dangerSigns.
function validateBookingInput(b) {
  if (b.patientName && typeof b.patientName === 'string' && b.patientName.length > 120) return { status: 400, error: 'validation_error', message: 'patientName is too long (max 120 characters).' };
  if (b.notes && String(b.notes).length > 1000) return { status: 400, error: 'validation_error', message: 'notes are too long (max 1000 characters).' };
  if (b.address && String(b.address).length > 300) return { status: 400, error: 'validation_error', message: 'address is too long (max 300 characters).' };
  if (b.scheduledAt && !validScheduledAt(b.scheduledAt)) return { status: 400, error: 'validation_error', message: 'scheduledAt must be a valid date.' };
  if (b.triage && b.triage.dangerSigns !== undefined && !Array.isArray(b.triage.dangerSigns)) return { status: 400, error: 'validation_error', message: 'triage.dangerSigns must be an array.' };
  return null;
}
function validatePreferredProvider(b) {
  if (b.preferredProviderId == null || b.preferredProviderId === '') return null;
  if (isReservedId(String(b.preferredProviderId))) return { status: 400, error: 'validation_error', message: 'Invalid preferredProviderId.' };
  const pp = store.data.providers[b.preferredProviderId];
  if (!pp || pp.status !== 'verified') return { status: 400, error: 'validation_error', message: 'preferredProviderId must be a verified provider.' };
  return null;
}
function triageRejects(triage) {
  const t = triage || {};
  if (t.level === 'emergency' || t.danger === true || t.emergency === true) return true;
  const danger = Array.isArray(t.dangerSigns) ? t.dangerSigns.filter((x) => cat.DANGER_SIGNS.includes(x)) : [];
  return danger.length > 0;
}

router.post('/bookings', requireAuth, requireRole('patient'), (req, res) => {
  const b = normalizeBookingBody(req.body);
  if (b.respectCharterAccepted !== true) {
    return bad(res, 400, 'Respect charter must be accepted before booking (respectCharterAccepted=true).', { charter: 'Treat the healthcare provider with respect: no insults, harassment or threats; keep the appointment; prepare the place. Violations lead to warning then account suspension.' });
  }
  // v2.0.8 — Terms & Conditions are mandatory (same version for everyone).
  if (!termsAccepted(req.body)) return termsError(res);
  const vErr = validateBookingInput(b) || validatePreferredProvider(b);
  if (vErr) return res.status(vErr.status).json({ error: vErr.error, message: vErr.message });
  if (!b.patientName || typeof b.patientName !== 'string') return bad(res, 400, 'patientName required.');
  if (!b.serviceCode || !cat.SERVICES[b.serviceCode]) return bad(res, 400, 'Valid serviceCode required.');
  if (isReservedId(b.serviceCode)) return bad(res, 400, 'Valid serviceCode required.');
  if (!['cash_receipt', 'instapay'].includes(b.paymentMethod)) return bad(res, 400, 'paymentMethod must be cash_receipt or instapay.');
  // v2.1.1 — explicit written consent (owner decision 26 Nov 2026,
  // after legal review): a high-risk service may not be booked without
  // the patient's explicit written consent (consentGiven=true).
  if (requireHighRiskConsent(req, res, b.serviceCode)) return;
  // v2.1.0 — doctor's order gate (owner refinement 26 Nov 2026): HIGH-risk
  // services (catheter insertion, Ryle insertion, tracheostomy care, IV
  // infusion) AND suture removal require a written doctor order
  // (ordering doctor name + order number). No order = no booking (400).
  // The order is stored on the booking; for suture removal the provider
  // must also confirm seeing it before completing the visit.
  const doctorOrder = b.doctorOrder && typeof b.doctorOrder === 'object' ? b.doctorOrder : null;
  const orderOk = !!(doctorOrder && String(doctorOrder.doctorName || '').trim() && String(doctorOrder.orderNumber || '').trim());
  if ((cat.isHighRiskService(b.serviceCode) || b.serviceCode === 'suture_removal') && !orderOk) {
    return bad(res, 400, 'This service requires a written doctor order (ordering doctor name + order number). No order = no booking.');
  }
  // Emergency triage — ANY danger sign rejects the booking (M13: a
  // level of 'emergency' rejects even with an empty dangerSigns array).
  const triage = b.triage || {};
  const danger = Array.isArray(triage.dangerSigns) ? triage.dangerSigns.filter((x) => cat.DANGER_SIGNS.includes(x)) : [];
  if (triageRejects(triage)) {
    store.audit('booking.triage_rejected', req.user.phone, { danger });
    return res.status(422).json({
      error: 'emergency_triage',
      message: 'Danger sign detected. Do NOT book a home visit — call the ambulance now.',
      ambulance: '123', danger_signs: danger,
    });
  }
  const priced = priceBooking(b);
  if (priced.error === 'distance_required') return res.status(400).json({ error: 'distance_required', message: 'distanceKm or hotelId is required — the distance cannot be assumed to be 0.' });
  if (priced.error) return bad(res, 400, priced.error);
  if (priced.contract_required) {
    return res.status(422).json({ error: 'contract_required', ...priced });
  }
  // v2.1.2 — receipt photo for online payment (InstaPay): parsed and
  // validated here; cash bookings reject a receipt image (receipt at
  // the visit instead). The booking stays pending until the admin
  // reviews the receipt (see the accept gate).
  const receiptParsed = receiptFromBody(req.body, b.paymentMethod);
  if (receiptParsed.error) return bad(res, 400, receiptParsed.error);
  // v2.1.6 (C6): an online payment without a receipt is rejected here —
  // the receipt is the only proof the money exists.
  const receiptErr = receiptRequiredError(b.paymentMethod, receiptParsed);
  if (receiptErr) return bad(res, 400, receiptErr);
  const id = newId('bk');
  // v2.0.9 — auto-apply one loyalty voucher when the booking is >= 300 EGP.
  // The provider's share is computed on the FULL price at release; the
  // app funds the 50 EGP discount (see releaseBooking).
  const vou = findVoucher(req.user.phone, priced.totalEgp);
  const booking = {
    id, kind: 'standard', patientPhone: req.user.phone, patientName: capStr(b.patientName, 120),
    serviceCode: b.serviceCode, serviceName: cat.SERVICES[b.serviceCode].name_en,
    category: cat.SERVICES[b.serviceCode].category || 'nursing',
    riskLevel: cat.SERVICES[b.serviceCode].riskLevel || 'standard',
    preferredProviderId: b.preferredProviderId || null,
    night: isNight(b.scheduledAt),
    status: 'held', // escrow: money held in-app from booking
    amountEgp: priced.totalEgp, baseEgp: priced.baseEgp, distanceFeeEgp: priced.distanceFeeEgp,
    voucherId: vou ? vou.id : null, voucherDiscountEgp: vou ? vou.amountEgp : 0,
    amountPayableEgp: vou ? priced.totalEgp - vou.amountEgp : priced.totalEgp,
    distanceKm: priced.distanceKm, distanceBand: priced.band, distanceEstimate: true,
    transport: b.transport || 'none', hotelId: b.hotelId || null,
    currency: 'EGP', amountForeign: null, fxRate: null,
    paymentMethod: b.paymentMethod, respectCharterAccepted: true,
    termsAcceptedVersion: config.termsVersion, termsAcceptedAt: nowIso(),
    // v2.1.0 — doctor's order (required for high-risk services + suture
    // removal; recorded for catheter insertion and any other service that
    // sends one). doctorOrderSeenByProvider is set by the provider during
    // the visit (required before completing a suture-removal visit).
    doctorOrder: orderOk ? { doctorName: String(doctorOrder.doctorName).trim().slice(0, 120), orderNumber: String(doctorOrder.orderNumber).trim().slice(0, 80) } : null,
    doctorOrderConfirmed: b.doctorOrderConfirmed === true,
    doctorOrderSeenByProvider: false,
    // v2.1.1 — explicit written consent for high-risk services (stored
    // with the time it was given; null for standard services).
    consent: cat.isHighRiskService(b.serviceCode) ? { given: true, at: nowIso(), version: '1.0' } : null,
    triage: { dangerSigns: danger, notes: triage.notes ? capStr(triage.notes, 1000) : null },
    address: b.address ? capStr(b.address, 300) : null, scheduledAt: b.scheduledAt || null, notes: b.notes ? capStr(b.notes, 1000) : null,
    alternateContact: b.alternateContact || null, // admin-only if needed
    providerId: null, commissionPct: null, providerShareEgp: null, appShareEgp: null, estimatedProviderShareEgp: null, languageBonusEgp: 0,
    receipt: null,
    vitals: null, review: null, providerReview: null, complaint: false,
    circumventionHold: false, circumventionReportId: null,
    complaintStatus: null, complaintDeadline: null, complaintAt: null, complaintResolvedAt: null,
    settleableAt: null, cancelledAt: null, refundedAt: null, refundEgp: null,
    cashCollectedByProvider: false, overdue: false,
    createdAt: nowIso(), acceptedAt: null, providerConfirmedAt: null,
    patientConfirmedAt: null, reviewedAt: null, releasedAt: null, releaseMode: null,
  };
  attachReceipt(booking, receiptParsed);
  store.data.bookings[id] = booking;
  if (vou) { vou.status = 'used'; vou.usedAt = nowIso(); vou.usedBookingId = id; }
  store.audit('booking.created', req.user.phone, { bookingId: id, serviceCode: b.serviceCode, totalEgp: booking.amountEgp, voucherId: booking.voucherId, voucherDiscountEgp: booking.voucherDiscountEgp, receipt: booking.receipt ? booking.receipt.status : null });
  if (cat.isHighRiskService(b.serviceCode)) store.audit('booking.high_risk_consent', req.user.phone, { bookingId: id, serviceCode: b.serviceCode });
  recordTermsAcceptance(req.user.phone);
  store.save();
  // Payment number is shown only AFTER the booking is confirmed (accepted),
  // so it is NOT included here.
  res.status(201).json(pubBooking(req, booking));
});

router.get('/bookings/mine', requireAuth, (req, res) => {
  const all = Object.values(store.data.bookings);
  const mine = req.user.role === 'provider'
    ? all.filter((b) => b.providerId === req.user.providerId)
    : all.filter((b) => b.patientPhone === req.user.phone);
  mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(mine.map((b) => pubBooking(req, b, { includePaymentNumber: b.status !== 'held' && b.status !== 'cancelled' })));
});

router.get('/bookings/:id', requireAuth, (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (!canSeeBooking(req, b)) return res.status(403).json({ error: 'forbidden', message: 'This booking does not belong to you.' });
  res.json(pubBooking(req, b, { includePaymentNumber: b.status !== 'held' && b.status !== 'cancelled' }));
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
  // v2.1.3 — packages do NOT use the 15-minute window (terms §12):
  // cancel any time before the package completes. Before the start date
  // = full refund; after the start = refund of the remaining days at the
  // package daily rate (final price ÷ 26) + unworked extra days.
  if (b.kind === 'package') {
    const startMs = new Date(b.startDate + 'T00:00:00Z').getTime();
    const beforeStart = Date.now() < startMs;
    b.status = 'cancelled';
    b.cancelledAt = nowIso();
    if (beforeStart) {
      b.refundEgp = refundAmount(b);
    } else {
      // v2.1.3 — refund exactly what was NOT worked: what the patient
      // paid minus the logged days at their logged rates (the 26th day
      // absorbs the rounding remainder, so this is exact to the pound).
      const workedGross = (b.daysLog || []).reduce((s, d) => s + (d.rateEgp || 0), 0);
      b.refundEgp = Math.max(0, refundAmount(b) - workedGross);
    }
    b.refundedAt = nowIso();
    store.audit('booking.cancelled', req.user.phone, { bookingId: b.id, kind: 'package', refundEgp: b.refundEgp, beforeStart });
    store.save();
    res.json({ ...pubBooking(req, b, { includePaymentNumber: false }), note: beforeStart ? 'Cancelled before the package start date — the full held amount is refunded.' : 'Cancelled after the start — the remaining days are refunded at the package daily rate.' });
    return;
  }
  const deadline = new Date(b.createdAt).getTime() + config.cancelWindowMs;
  if (Date.now() > deadline) {
    return res.status(409).json({ error: 'cancel_window_closed', message: 'Cancellation is only allowed within 15 minutes of booking. The 15-minute window has passed.', cancelDeadline: new Date(deadline).toISOString() });
  }
  b.status = 'cancelled';
  b.cancelledAt = nowIso();
  b.refundEgp = refundAmount(b); // full refund of what the patient actually paid (after any voucher discount)
  b.refundedAt = nowIso();
  store.audit('booking.cancelled', req.user.phone, { bookingId: b.id, refundEgp: b.refundEgp, wasAccepted: !!b.providerId });
  store.save();
  res.json({ ...pubBooking(req, b, { includePaymentNumber: false }), note: 'Cancelled within the 15-minute window — the full held amount is refunded.' });
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
  res.json({ ...pubBooking(req, b, { includePaymentNumber: true }), note: 'If no review is submitted within 1 hour and there is no complaint, the held amount is released automatically (provisional). It becomes finally settleable only after the 24-hour complaint window ends with no open complaint.' });
});

router.post('/bookings/:id/review', requireAuth, requireRole('patient'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.patientPhone !== req.user.phone) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (b.status !== 'patient_confirmed') return bad(res, 409, `Cannot review while status is ${b.status}. Confirm receipt of the service first.`);
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return bad(res, 400, 'rating must be an integer 1–5.');
  // v2.0.8 — anti-circumvention question (required in the review form):
  // "Did the provider ask you to deal outside the app?" A "yes" creates
  // an admin circumvention report and HOLDS this booking's release for
  // manual review — exactly like an open complaint.
  const circumventionReported = req.body?.circumventionReported;
  if (circumventionReported !== undefined && typeof circumventionReported !== 'boolean') {
    return bad(res, 400, 'circumventionReported must be true or false.');
  }
  b.review = { rating, comment: String(req.body?.comment || '').slice(0, 1000), at: nowIso(), circumventionReported: circumventionReported === true };
  b.status = 'reviewed';
  b.reviewedAt = nowIso();
  if (circumventionReported === true) {
    const report = { id: newId('circ'), bookingId: b.id, providerId: b.providerId || null, patientPhone: b.patientPhone, type: 'circumvention', description: 'Patient reported in the review: the provider asked to deal outside the app.', at: nowIso(), status: 'open' };
    store.data.circumventionReports.push(report);
    b.circumventionHold = true;
    b.circumventionReportId = report.id;
    store.audit('circumvention.reported', req.user.phone, { bookingId: b.id, providerId: b.providerId, reportId: report.id });
  }
  const p = b.providerId ? store.data.providers[b.providerId] : null;
  if (p) {
    // v2.1.1 (L4): the average is recomputed over ALL reviews, INCLUDING
    // this visit — the old formula never counted the current visit.
    recomputeRatingAvg(p);
    recomputeProviderPoints(p);
  }
  store.audit('booking.reviewed', req.user.phone, { bookingId: b.id, rating, circumventionReported: circumventionReported === true });
  if (b.complaint || b.circumventionHold) {
    // v2.0.8: an open complaint OR a circumvention hold pauses the
    // release — status stays 'reviewed' until admin resolves it (the
    // sweep releases it once the hold is cleared).
    store.save();
    return res.json({ ...pubBooking(req, b, { includePaymentNumber: true }), note: b.circumventionHold ? 'Review recorded. The payout is held for admin review because you reported a request to deal outside the app.' : 'Review recorded. Release is paused while your complaint is under review.' });
  }
  if (b.kind === 'package') releasePackageBooking(b, 'reviewed'); // v2.1.3 — package final release is per-day, never a lump sum
  else releaseBooking(b, 'reviewed'); // review releases the held amount at once (provisional; final settlement after the 24h complaint window)
  res.json(pubBooking(req, b, { includePaymentNumber: true }));
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
  res.json(pubBooking(req, b, { includePaymentNumber: true }));
});

router.post('/bookings/:id/safety-report', requireAuth, (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (!canSeeBooking(req, b)) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  const type = req.body?.type || (req.body?.text ? 'safety' : null);
  if (!['complaint', 'safety', 'other'].includes(type)) return bad(res, 400, 'type must be complaint, safety or other.');
  // v2.1.1 (M11): a provider cannot file a complaint on their OWN
  // booking (it would pause their own payout release).
  if (type === 'complaint' && req.user.role === 'provider' && b.providerId === req.user.providerId) {
    return res.status(403).json({ error: 'forbidden', message: 'A provider cannot file a complaint on their own booking.' });
  }
  // v2.1.1 (M11): safety reports are capped at 5/day per booking.
  const dayKey = `${b.id}:${new Date().toISOString().slice(0, 10)}`;
  const daily = store.data.safetyDaily || (store.data.safetyDaily = {});
  if ((daily[dayKey] || 0) >= 5) return res.status(429).json({ error: 'rate_limited', message: 'Too many safety reports for this booking today (max 5).' });
  const desc = String(req.body?.description || req.body?.text || '').slice(0, 1000);
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
  daily[dayKey] = (daily[dayKey] || 0) + 1;
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
  // v2.1.1 (M11): SOS is capped at 5/day per booking.
  const sosDayKey = `${b.id}:${new Date().toISOString().slice(0, 10)}`;
  const sosDaily = store.data.sosDaily || (store.data.sosDaily = {});
  if ((sosDaily[sosDayKey] || 0) >= 5) return res.status(429).json({ error: 'rate_limited', message: 'Too many SOS alerts for this booking today (max 5).' });
  sosDaily[sosDayKey] = (sosDaily[sosDayKey] || 0) + 1;
  const alert = { id: newId('sos'), bookingId: b.id, phone: req.user.phone, role: req.user.role, at: nowIso(), status: 'open' };
  store.data.sos.push(alert);
  store.audit('sos.raised', req.user.phone, { bookingId: b.id });
  store.save();
  res.status(201).json({ ok: true, sosId: alert.id, message: 'SOS alert sent to admin immediately.' });
});

// ---------------------------------------------------------------- v2.0.8 — masked in-app messaging
// The ONLY contact channel between patient and provider. Numbers are
// never shown on either side; the thread opens at acceptance and closes
// 24h after completion. Any message containing a phone-number pattern
// is rejected — the channel must never become a way to exchange numbers.
router.get('/bookings/:id/messages', requireAuth, (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (!canSeeBooking(req, b)) return res.status(403).json({ error: 'forbidden', message: 'This booking does not belong to you.' });
  if (!messageWindowOpen(b)) {
    return res.json({ bookingId: b.id, open: false, messages: (store.data.messages[b.id] || []).map((m) => ({ id: m.id, senderRole: m.senderRole, text: m.text, at: m.at })), note: 'This conversation is closed. Contact admin from the booking screen if you need help.' });
  }
  const list = (store.data.messages[b.id] || []).map((m) => ({ id: m.id, senderRole: m.senderRole, text: m.text, at: m.at }));
  res.json({ bookingId: b.id, open: true, messages: list });
});

router.post('/bookings/:id/messages', requireAuth, (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (!canSeeBooking(req, b)) return res.status(403).json({ error: 'forbidden', message: 'This booking does not belong to you.' });
  if (!messageWindowOpen(b)) {
    return res.status(409).json({ error: 'closed', message: 'This conversation is closed. Contact admin from the booking screen if you need help.' });
  }
  const text = String(req.body?.text || '').trim();
  if (!text) return bad(res, 400, 'Message text required.');
  if (text.length > 1000) return bad(res, 400, 'Message is too long (max 1000 characters).');
  if (containsPhoneNumber(text)) {
    store.audit('messages.phone_blocked', req.user.phone, { bookingId: b.id });
    return res.status(400).json({ error: 'phone_number_not_allowed', message: 'Phone numbers cannot be shared here — contact stays inside the app only, to protect both sides.' });
  }
  const msg = { id: newId('msg'), bookingId: b.id, senderRole: req.user.role, senderPhone: req.user.phone, text, at: nowIso() };
  (store.data.messages[b.id] = store.data.messages[b.id] || []).push(msg);
  store.audit('messages.sent', req.user.phone, { bookingId: b.id, role: req.user.role });
  store.save();
  res.status(201).json({ id: msg.id, senderRole: msg.senderRole, text: msg.text, at: msg.at });
});

router.post('/bookings/:id/cash-collected', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.providerId !== req.user.providerId) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  const blockedCash = providerBlocked(store.data.providers[req.user.providerId]);
  if (blockedCash) return res.status(403).json({ error: 'forbidden', message: blockedCash });
  if (!['released', 'auto_released'].includes(b.status)) {
    return bad(res, 409, 'Cash can only be marked collected after the booking is released.');
  }
  b.cashCollectedByProvider = true;
  store.audit('booking.cash_collected', req.user.phone, { bookingId: b.id, appShareEgp: b.appShareEgp, note: 'Provider holds the cash — app share is now owed by the provider.' });
  store.save();
  res.json(pubBooking(req, b, { includePaymentNumber: true }));
});

// Manual + scheduled escrow sweep (admin only via HTTP; interval calls it directly).
// v2.1.0 — the sweep is async now (review reminder + settlement
// notifications + SMS fallback pass).
router.post('/jobs/sweep', requireAdmin, async (req, res) => {
  const result = await sweepAutoRelease();
  store.audit('jobs.sweep', req.user.phone, result);
  res.json({ ok: true, ...result });
});

// ------------------------------------------------------------------ v2.1.3
// Monthly packages — quote-based pricing (owner-approved 26 Nov 2026).
// Flow: patient submits a package request (case assessment) → admin
// reviews and sets the final price (written quote) + assigns the provider
// → patient accepts (full month paid upfront into escrow) or declines.
// Catalog prices are INDICATIVE ("starting from") — never the final
// price. No loyalty vouchers on packages (the "بدل" offer price is
// already the discount). The booking records the 4-extra-days option
// (none / substitute / overtime) and its price. The optional "first
// assessment visit" was deliberately NOT built: the patient can already
// book a standard visit themselves and mention the package in the notes;
// there is no admin-creates-booking path to build it on.
function normalizePackageRequest(raw) {
  const b = raw || {};
  return {
    packageType: String(b.packageType || '').trim(),
    // v2.1.3 refinement — the requested care level (assistant /
    // technician / specialist). Optional in the body: when omitted the
    // server derives it from the package; when given it must match the
    // package's level (the package IS the level choice in the form).
    level: String(b.level || '').trim() || null,
    // Currency of the quote: EGP for local packages; USD/EUR for
    // tourist residence packages (default USD).
    currency: String(b.currency || '').trim().toUpperCase() || null,
    patientName: String(b.patientName || '').trim(),
    condition: String(b.condition || '').trim(),
    conditionItems: Array.isArray(b.conditionItems) ? b.conditionItems.map((x) => String(x).trim()).filter(Boolean) : [],
    diagnosis: String(b.diagnosis || '').trim(),
    treatment: String(b.treatment || '').trim(),
    needs: Array.isArray(b.needs) ? b.needs.map((x) => String(x).trim()).filter(Boolean) : [],
    needsNote: String(b.needsNote || '').trim(),
    startDate: String(b.startDate || '').trim(),
    address: String(b.address || '').trim(),
    distanceKm: b.distanceKm != null ? Number(b.distanceKm) : null,
    notes: String(b.notes || '').trim(),
  };
}
function publicPackageRequest(r) { return r ? { ...r } : null; }

// Patient submits a package request (case assessment). Terms acceptance
// is required, like every booking.
router.post('/package-requests', requireAuth, requireRole('patient'), (req, res) => {
  if (!termsAccepted(req.body)) return termsError(res);
  const f = normalizePackageRequest(req.body);
  const pkg = packageTypeOf(f.packageType);
  if (!pkg) return bad(res, 400, 'packageType must be one of: ' + [...Object.keys(cat.MONTHLY_PACKAGES), ...Object.keys(cat.TOURIST_PACKAGES)].join(', '));
  const family = packageFamily(pkg);
  // Currency: local packages are EGP only; tourist packages are USD or
  // EUR (default USD when the client does not say).
  let currency = f.currency;
  if (family === 'local') {
    if (currency && currency !== 'EGP') return bad(res, 400, 'Local packages are priced in EGP only.');
    currency = 'EGP';
  } else {
    if (!currency) currency = 'USD';
    if (!['USD', 'EUR'].includes(currency)) return bad(res, 400, 'Tourist packages are priced in USD or EUR only.');
  }
  // Requested level: when the client sends one it must be a real level
  // AND match the package's level (the package select in the form is
  // the level choice — a mismatch is a client bug, not a quote).
  if (f.level && !cat.PACKAGE_LEVELS.includes(f.level)) return bad(res, 400, 'level must be assistant, technician or specialist.');
  if (f.level && f.level !== pkg.level) return bad(res, 400, `level ${f.level} does not match package ${f.packageType} (level ${pkg.level}).`);
  f.level = pkg.level;
  f.currency = currency;
  // Elderly packages (owner refinement 26 Nov 2026): the price is NOT
  // fixed by mobile/bedridden alone — it also depends on the elderly
  // person's TREATMENT and CONDITION. The request form must capture
  // treatment/medications explicitly (condition is already required
  // for every package); the admin sets the final price from treatment
  // + condition + mobility + level needed.
  if (f.packageType.startsWith('package_elderly_') && !f.treatment) return bad(res, 400, 'treatment (medications) is required for elderly packages — the final price depends on it.');
  if (!f.patientName || f.patientName.length > 120) return bad(res, 400, 'patientName required (max 120 characters).');
  if (!f.condition || f.condition.length > 500) return bad(res, 400, 'condition required (what the patient suffers from, max 500 characters).');
  const badCond = f.conditionItems.filter((c) => !cat.PACKAGE_CONDITIONS.some((x) => x.code === c));
  if (badCond.length) return bad(res, 400, 'Unknown condition item: ' + badCond.join(', '));
  if (f.diagnosis.length > 500) return bad(res, 400, 'diagnosis is too long (max 500 characters).');
  if (f.treatment.length > 500) return bad(res, 400, 'treatment is too long (max 500 characters).');
  const badNeed = f.needs.filter((n) => !cat.PACKAGE_NEEDS.some((x) => x.code === n));
  if (badNeed.length) return bad(res, 400, 'Unknown care need: ' + badNeed.join(', '));
  if (f.needsNote.length > 500) return bad(res, 400, 'needsNote is too long (max 500 characters).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startDate) || Number.isNaN(new Date(f.startDate + 'T00:00:00Z').getTime())) return bad(res, 400, 'startDate must be a valid YYYY-MM-DD date.');
  const startMs = new Date(f.startDate + 'T00:00:00Z').getTime();
  const todayMs = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  if (startMs < todayMs) return bad(res, 400, 'startDate cannot be in the past.');
  if (!f.address || f.address.length > 300) return bad(res, 400, 'address required (max 300 characters).');
  if (f.distanceKm != null && (!Number.isFinite(f.distanceKm) || f.distanceKm < 0 || f.distanceKm > 100)) return bad(res, 400, 'distanceKm must be 0–100.');
  if (f.notes.length > 1000) return bad(res, 400, 'notes are too long (max 1000 characters).');
  const r = {
    id: newId('pkr'), patientPhone: req.user.phone, ...f,
    status: 'submitted', quote: null, bookingId: null,
    createdAt: nowIso(), quotedAt: null, decidedAt: null,
  };
  store.data.packageRequests.push(r);
  store.audit('package.request_created', req.user.phone, { requestId: r.id, packageType: r.packageType, startDate: r.startDate });
  store.save();
  res.status(201).json(publicPackageRequest(r));
});

router.get('/package-requests/mine', requireAuth, requireRole('patient'), (req, res) => {
  const list = (store.data.packageRequests || []).filter((r) => r.patientPhone === req.user.phone).slice().reverse();
  res.json({ requests: list.map(publicPackageRequest) });
});

router.get('/admin/package-requests', requireAdmin, (req, res) => {
  const list = (store.data.packageRequests || []).slice().reverse();
  res.json({ requests: list.map(publicPackageRequest) });
});

// Admin sets the written quote: final price + provider (+ substitute for
// the 4 extra days) + which extra-days option. The provider must be
// verified AND interview-passed; a physio specialist cannot take a
// nursing package (and vice versa). v2.1.3 refinement: the admin may
// CONFIRM OR RAISE the care level in the quote (optional `packageType`
// override — same shift, same local/tourist family), and the provider
// must meet the FINAL package's level gate (assistant never takes
// medical work; specialist needs a Pro+ nurse or a doctor). Tourist
// packages additionally require a tourist-compatible provider.
router.post('/admin/package-requests/:id/quote', requireAdmin, (req, res) => {
  if (rejectReservedId(req, res)) return;
  const r = (store.data.packageRequests || []).find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found', message: 'Package request not found.' });
  if (r.status !== 'submitted') return bad(res, 409, `Cannot quote a request in status ${r.status}.`);
  const requestedPkg = packageTypeOf(r.packageType);
  if (!requestedPkg) return bad(res, 400, 'The requested package no longer exists.');
  const finalCode = String(req.body?.packageType || r.packageType);
  const pkg = packageTypeOf(finalCode);
  if (!pkg) return bad(res, 400, 'packageType must be a valid package code.');
  if (pkg.shiftHours !== requestedPkg.shiftHours) return bad(res, 400, 'The quoted package must have the same shift length as the requested package (12h or 24h).');
  if (packageFamily(pkg) !== packageFamily(requestedPkg)) return bad(res, 400, 'Cannot switch between local and tourist packages in a quote.');
  const currency = r.currency || 'EGP';
  const fx = packageFxRate(currency);
  // Final price in the booking currency. `finalPrice` is the field;
  // `finalPriceEgp` is accepted as a legacy alias (identical for EGP).
  const finalPrice = Number(req.body?.finalPrice ?? req.body?.finalPriceEgp);
  if (!Number.isInteger(finalPrice) || finalPrice <= 0) return bad(res, 400, 'finalPrice must be a positive integer in the package currency.');
  const finalPriceEgp = currency === 'EGP' ? finalPrice : Math.round(finalPrice * fx);
  const providerId = String(req.body?.providerId || '');
  const p = store.data.providers[providerId];
  if (!p) return bad(res, 400, 'providerId must be an existing provider.');
  const blocked = providerBlocked(p);
  if (blocked) return bad(res, 409, blocked);
  if (p.status !== 'verified') return bad(res, 409, 'The assigned provider must be verified first.');
  if (p.interviewStatus !== 'passed') return bad(res, 409, 'The assigned provider must have passed the acceptance interview.');
  const providerCategory = p.providerType === 'physio' ? 'physio' : 'nursing';
  if (pkg.category !== providerCategory) return bad(res, 409, 'The assigned provider type does not match this package type.');
  if (!providerMeetsPackageLevel(p, pkg.level)) return bad(res, 409, `The assigned provider does not meet the ${packageLevelName(pkg.level)} level for this package.`);
  if (packageFamily(pkg) === 'tourist' && !touristCompatible(p)) return bad(res, 409, 'The assigned provider is not tourist-compatible (interview + in-app English test).');
  const extraDaysOption = String(req.body?.extraDaysOption || 'none');
  if (!['none', 'substitute', 'overtime'].includes(extraDaysOption)) return bad(res, 400, 'extraDaysOption must be none, substitute or overtime.');
  let substituteProviderId = null;
  if (extraDaysOption === 'substitute') {
    substituteProviderId = String(req.body?.substituteProviderId || '');
    const sub = store.data.providers[substituteProviderId];
    if (!sub) return bad(res, 400, 'substituteProviderId is required when extraDaysOption is substitute.');
    const subBlocked = providerBlocked(sub);
    if (subBlocked) return bad(res, 409, subBlocked);
    if (sub.status !== 'verified' || sub.interviewStatus !== 'passed') return bad(res, 409, 'The substitute provider must be verified and have passed the interview.');
    if (substituteProviderId === providerId) return bad(res, 400, 'The substitute provider must be different from the main provider.');
    if (!providerMeetsPackageLevel(sub, pkg.level)) return bad(res, 409, `The substitute provider does not meet the ${packageLevelName(pkg.level)} level for this package.`);
    if (packageFamily(pkg) === 'tourist' && !touristCompatible(sub)) return bad(res, 409, 'The substitute provider is not tourist-compatible (interview + in-app English test).');
  }
  const waived = packageOvertimePremiumWaived();
  const extraDailyRate = cat.packageExtraDailyRate(pkg, extraDaysOption, waived, currency);
  const extraDaysPrice = extraDaysOption === 'none' ? 0 : extraDailyRate * cat.PACKAGE_OFF_DAYS;
  const extraDaysPriceEgp = Math.round(extraDaysPrice * fx);
  const total = finalPrice + extraDaysPrice;
  const totalEgp = finalPriceEgp + extraDaysPriceEgp;
  r.quote = {
    packageType: pkg.code, level: pkg.level, currency,
    finalPrice, finalPriceEgp,
    extraDays: { option: extraDaysOption, days: extraDaysOption === 'none' ? 0 : cat.PACKAGE_OFF_DAYS, dailyRate: extraDaysOption === 'none' ? 0 : extraDailyRate, dailyRateEgp: extraDaysOption === 'none' ? 0 : Math.round(extraDailyRate * fx), price: extraDaysPrice, priceEgp: extraDaysPriceEgp, premiumWaived: extraDaysOption === 'overtime' ? waived : false },
    total, totalEgp, providerId, substituteProviderId,
    note: String(req.body?.quoteNote || '').slice(0, 500), quotedAt: nowIso(),
  };
  r.status = 'quoted';
  r.quotedAt = nowIso();
  store.audit('package.quoted', 'admin', { requestId: r.id, packageType: pkg.code, level: pkg.level, currency, finalPrice, totalEgp, providerId, extraDaysOption });
  store.save();
  res.json(publicPackageRequest(r));
});

// Patient accepts the quote: a package booking is created and the full
// month is paid upfront into escrow. Cash = the provider collects the
// month's cash at the first visit (cashCollectedByProvider set now, so
// weekly day releases make the app share owed by the provider).
// InstaPay + receipt photo = held until the admin approves the receipt.
router.post('/package-requests/:id/accept', requireAuth, requireRole('patient'), (req, res) => {
  if (rejectReservedId(req, res)) return;
  const r = (store.data.packageRequests || []).find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found', message: 'Package request not found.' });
  if (r.patientPhone !== req.user.phone) return res.status(403).json({ error: 'forbidden', message: 'Not your package request.' });
  if (r.status !== 'quoted' || !r.quote) return bad(res, 409, `Cannot accept a request in status ${r.status}.`);
  if (!termsAccepted(req.body)) return termsError(res);
  const paymentMethod = String(req.body?.paymentMethod || '');
  if (!['cash_receipt', 'instapay'].includes(paymentMethod)) return bad(res, 400, 'paymentMethod must be cash_receipt or instapay.');
  const parsed = receiptFromBody(req.body, paymentMethod);
  if (parsed.error) return bad(res, 400, parsed.error);
  // v2.1.6 (C6): a package is NEVER created 'accepted' without an
  // approved receipt or explicitly recorded cash terms. Online payment
  // without a receipt is rejected here; cash records its terms below.
  const receiptErrPkg = receiptRequiredError(paymentMethod, parsed);
  if (receiptErrPkg) return bad(res, 400, receiptErrPkg);
  const p = store.data.providers[r.quote.providerId];
  if (!p) return bad(res, 409, 'The assigned provider no longer exists.');
  const blocked = providerBlocked(p);
  if (blocked) return bad(res, 409, blocked);
  // The quote's final package (the admin may have raised the level) and
  // its level gate are re-checked at accept — a tier change between
  // quote and accept must not let an unqualified provider through.
  const pkg = packageTypeOf(r.quote.packageType || r.packageType);
  if (!pkg) return bad(res, 409, 'The quoted package no longer exists.');
  if (!providerMeetsPackageLevel(p, pkg.level)) return bad(res, 409, `The assigned provider does not meet the ${packageLevelName(pkg.level)} level for this package.`);
  if (packageFamily(pkg) === 'tourist' && !touristCompatible(p)) return bad(res, 409, 'The assigned provider is not tourist-compatible (interview + in-app English test).');
  const pct = effectiveCommissionPct(p.tier);
  const currency = r.quote.currency || r.currency || 'EGP';
  const fx = packageFxRate(currency);
  const total = r.quote.total;
  const totalEgp = r.quote.totalEgp;
  const startDate = r.startDate;
  const endDate = new Date(new Date(startDate + 'T00:00:00Z').getTime() + (cat.PACKAGE_DAYS + cat.PACKAGE_OFF_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const b = {
    id: newId('bk'), kind: 'package', serviceCode: pkg.code, serviceName: pkg.name_en,
    category: pkg.category, riskLevel: 'standard',
    patientPhone: req.user.phone, patientName: r.patientName,
    providerId: r.quote.providerId, substituteProviderId: r.quote.substituteProviderId || null,
    packageRequestId: r.id, packageType: pkg.code, level: pkg.level,
    currency, fxRate: currency === 'EGP' ? null : fx,
    amountForeign: currency === 'EGP' ? null : total,
    amountEgp: totalEgp, amountPayableEgp: totalEgp,
    basePackageEgp: r.quote.finalPriceEgp, basePackage: r.quote.finalPrice,
    extraDays: r.quote.extraDays,
    dailyRateEgp: Math.max(1, Math.round(r.quote.finalPriceEgp / cat.PACKAGE_DAYS)),
    dailyRate: Math.max(1, Math.round(r.quote.finalPrice / cat.PACKAGE_DAYS)),
    startDate, endDate,
    daysLog: [], daysCompleted: 0, extraDaysCompleted: 0, daysReleased: 0, packageDayReleases: [],
    distanceKm: r.distanceKm, address: r.address,
    paymentMethod, status: parsed.receipt ? 'held' : 'accepted',
    commissionPct: pct, estimatedProviderShareEgp: Math.round(totalEgp * (1 - pct / 100)),
    cashCollectedByProvider: paymentMethod === 'cash_receipt',
    // v2.1.6 (C6): a cash package is 'accepted' ONLY with explicitly
    // recorded cash terms (the patient chose cash-with-receipt at the
    // first visit); an online package without a receipt never reaches
    // here (rejected above) and stays 'held' until admin approval.
    cashTerms: paymentMethod === 'cash_receipt' ? { method: 'cash_receipt', recordedAt: nowIso(), note: 'Cash with receipt, collected by the provider at the first visit; the full month is held in escrow until then.' } : null,
    receiptStatus: receiptStatusOf({ paymentMethod, receipt: parsed.receipt || null }),
    createdAt: nowIso(),
    vitals: null, review: null, providerReview: null, complaint: false,
    appShareEgp: null, providerShareEgp: null,
  };
  attachReceipt(b, parsed);
  store.data.bookings[b.id] = b;
  r.status = 'accepted';
  r.bookingId = b.id;
  r.decidedAt = nowIso();
  store.audit('package.accepted', req.user.phone, { requestId: r.id, bookingId: b.id, packageType: pkg.code, level: pkg.level, currency, totalEgp, paymentMethod, receiptPending: !!parsed.receipt });
  store.save();
  res.status(201).json(pubBooking(req, b, { includePaymentNumber: true }));
});

router.post('/package-requests/:id/decline', requireAuth, requireRole('patient'), (req, res) => {
  if (rejectReservedId(req, res)) return;
  const r = (store.data.packageRequests || []).find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found', message: 'Package request not found.' });
  if (r.patientPhone !== req.user.phone) return res.status(403).json({ error: 'forbidden', message: 'Not your package request.' });
  if (r.status !== 'quoted') return bad(res, 409, `Cannot decline a request in status ${r.status}.`);
  r.status = 'declined';
  r.decidedAt = nowIso();
  store.audit('package.declined', req.user.phone, { requestId: r.id });
  store.save();
  res.json(publicPackageRequest(r));
});

// Admin toggles the launch offer: waive the +25% overtime premium on the
// 4 extra days (owner decision 26 Nov 2026). Default OFF (env fallback).
// `until` is optional; an expired setting stops applying on its own.
router.post('/admin/package-offer', requireAdmin, (req, res) => {
  const waived = req.body?.overtimePremiumWaived;
  if (typeof waived !== 'boolean') return bad(res, 400, 'overtimePremiumWaived must be true or false.');
  const until = req.body?.until ? String(req.body.until) : null;
  if (until && Number.isNaN(new Date(until).getTime())) return bad(res, 400, 'until must be a valid date.');
  store.data.packageOffer = { overtimePremiumWaived: waived, until: until || null, setAt: nowIso() };
  store.audit('package.offer_set', 'admin', { overtimePremiumWaived: waived, until: until || null });
  store.save();
  res.json({ packageOffer: store.data.packageOffer });
});

// Provider logs one completed day of a package. Regular days: main
// provider only, max 26, inside [startDate, endDate], never a future day,
// one entry per date. Extra days: only when the quote chose an option —
// 'substitute' days by the substitute provider, 'overtime' days by the
// main provider, max 4. The day's share is released by the weekly sweep.
router.post('/bookings/:id/package-day', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.kind !== 'package') return bad(res, 400, 'This endpoint is for monthly package bookings only.');
  if (!canSeeBooking(req, b)) return res.status(403).json({ error: 'forbidden', message: 'Not your package booking.' });
  const blocked = providerBlocked(store.data.providers[req.user.providerId]);
  if (blocked) return res.status(403).json({ error: 'forbidden', message: blocked });
  if (b.status !== 'accepted') return bad(res, 409, `Cannot log days while status is ${b.status}.`);
  const date = String(req.body?.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date + 'T00:00:00Z').getTime())) return bad(res, 400, 'date must be a valid YYYY-MM-DD date.');
  const type = String(req.body?.type || 'regular');
  if (!['regular', 'extra'].includes(type)) return bad(res, 400, 'type must be regular or extra.');
  const startMs = new Date(b.startDate + 'T00:00:00Z').getTime();
  const endMs = new Date(b.endDate + 'T00:00:00Z').getTime();
  const dayMs = new Date(date + 'T00:00:00Z').getTime();
  if (dayMs < startMs || dayMs > endMs) return bad(res, 409, 'date is outside the package period.');
  const todayMs = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  if (dayMs > todayMs) return bad(res, 409, 'Cannot log a future day.');
  if ((b.daysLog || []).some((d) => d.date === date)) return bad(res, 409, 'This day is already logged.');
  const isSubstitute = b.substituteProviderId && req.user.providerId === b.substituteProviderId;
  if (type === 'regular') {
    if (isSubstitute) return bad(res, 403, 'The substitute provider logs extra days only.');
    if ((b.daysCompleted || 0) >= cat.PACKAGE_DAYS) return bad(res, 409, 'All 26 regular days are already logged.');
  } else {
    if (!b.extraDays || b.extraDays.option === 'none') return bad(res, 409, 'This package has no extra days.');
    if ((b.extraDaysCompleted || 0) >= cat.PACKAGE_OFF_DAYS) return bad(res, 409, 'All 4 extra days are already logged.');
    if (b.extraDays.option === 'substitute' && !isSubstitute) return bad(res, 403, 'Extra days on this package are covered by the substitute provider.');
    if (b.extraDays.option === 'overtime' && isSubstitute) return bad(res, 403, 'Overtime extra days are worked by the main provider.');
  }
  const rateEgp = type === 'regular'
    // v2.1.3 — the 26th regular day absorbs the rounding remainder so the
    // 26 days sum EXACTLY to the quoted base price (26 × round(12600/26)
    // = 12610, not 12600 — the last day is 475, not 485).
    ? ((b.daysCompleted || 0) + 1 >= cat.PACKAGE_DAYS ? (b.basePackageEgp || 0) - (cat.PACKAGE_DAYS - 1) * packageDailyRate(b) : packageDailyRate(b))
    : b.extraDays.dailyRateEgp;
  // v2.1.3 refinement — the same rate in the booking currency (for
  // display; the ledger always uses rateEgp). The 26th regular day
  // absorbs the foreign remainder too (base − 25 × daily rate).
  const rate = type === 'regular'
    ? ((b.daysCompleted || 0) + 1 >= cat.PACKAGE_DAYS ? (b.basePackage ?? b.basePackageEgp ?? 0) - (cat.PACKAGE_DAYS - 1) * (b.dailyRate ?? packageDailyRate(b)) : (b.dailyRate ?? packageDailyRate(b)))
    : (b.extraDays.dailyRate ?? b.extraDays.dailyRateEgp);
  // v2.1.6 (C7): a day carries its EVIDENCE — optional vitals recorded
  // at the visit (BP/pulse/temp/SpO2, same ranges as visit vitals) and
  // the patient's confirmation (default false). A day becomes releasable
  // only when the patient confirms it, or when vitals exist and 72h
  // pass with no dispute (see packageDayReleasable). The admin can
  // confirm a day on the patient's behalf.
  let vitals = null;
  if (req.body?.vitals && typeof req.body.vitals === 'object') {
    const v = req.body.vitals;
    const num = (k, min, max) => {
      const n = Number(v[k]);
      return Number.isFinite(n) && n >= min && n <= max ? n : null;
    };
    const parsedVitals = {
      bpSystolic: num('bpSystolic', 50, 300), bpDiastolic: num('bpDiastolic', 30, 200),
      pulse: num('pulse', 20, 250), temp: num('temp', 30, 45), oxygen: num('oxygen', 50, 100),
    };
    const given = ['bpSystolic', 'bpDiastolic', 'pulse', 'temp', 'oxygen'].filter((k) => v[k] !== undefined && v[k] !== null && v[k] !== '');
    if (given.length && given.some((k) => parsedVitals[k] == null)) {
      return bad(res, 400, `Day vitals out of range: ${given.filter((k) => parsedVitals[k] == null).join(', ')}`);
    }
    if (given.length) vitals = { ...parsedVitals, at: nowIso(), notes: String(v.notes || '').slice(0, 500) };
  }
  const entry = { date, type, providerId: req.user.providerId, rateEgp, rate, currency: b.currency || 'EGP', loggedAt: nowIso(), released: false, releasedAt: null, weekKey: null,
    vitals, patientConfirmed: false, patientConfirmedAt: null, confirmedBy: null };
  b.daysLog.push(entry);
  if (type === 'regular') b.daysCompleted = (b.daysCompleted || 0) + 1;
  else b.extraDaysCompleted = (b.extraDaysCompleted || 0) + 1;
  store.audit('package.day_logged', req.user.phone, { bookingId: b.id, date, type, rateEgp, vitals: !!vitals });
  // v2.1.6 (C7): bulk registration — more than 3 days logged in ONE
  // calendar day for this package forces an admin review before ANY
  // day of the package releases (a provider filling 26 days at once
  // must not be paid from a silent record).
  const todayStr = new Date().toISOString().slice(0, 10);
  const loggedToday = (b.daysLog || []).filter((d) => (d.loggedAt || '').slice(0, 10) === todayStr).length;
  if (loggedToday > 3 && !b.packageReviewRequired) {
    b.packageReviewRequired = true;
    b.packageReviewReason = `${loggedToday} days logged on ${todayStr} — bulk registration, admin review required before release.`;
    store.audit('package.bulk_days_flagged', req.user.phone, { bookingId: b.id, loggedToday, date: todayStr });
  }
  store.save();
  res.json(pubBooking(req, b, { includePaymentNumber: true }));
});

// v2.1.6 (C7): the patient confirms a logged package day (the visit
// happened). A confirmed day is releasable at the next weekly sweep.
// Only the patient who owns the booking can confirm; the date must be
// a logged, unreleased day, not in the future.
router.post('/bookings/:id/package-day/:date/confirm', requireAuth, requireRole('patient'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.kind !== 'package') return bad(res, 400, 'This endpoint is for monthly package bookings only.');
  if (b.patientPhone !== req.user.phone) return res.status(403).json({ error: 'forbidden', message: 'Not your package booking.' });
  const date = String(req.params.date || '').trim();
  const d = (b.daysLog || []).find((x) => x.date === date);
  if (!d) return res.status(404).json({ error: 'not_found', message: 'No logged day for this date.' });
  if (d.released) return bad(res, 409, 'This day is already released.');
  if (d.patientConfirmed) return bad(res, 409, 'This day is already confirmed.');
  d.patientConfirmed = true;
  d.patientConfirmedAt = nowIso();
  d.confirmedBy = 'patient';
  store.audit('package.day_confirmed', req.user.phone, { bookingId: b.id, date, by: 'patient' });
  store.save();
  res.json({ ok: true, bookingId: b.id, date, patientConfirmed: true });
});

// v2.1.6 (C7): the admin confirms a day on the patient's behalf (e.g.
// an elderly patient who called by phone, or a patient who cannot use
// the app). Audited with the admin as the actor.
router.post('/admin/bookings/:id/package-day/:date/confirm', requireAdmin, (req, res) => {
  const b = store.data.bookings[req.params.id];
  if (!b) return res.status(404).json({ error: 'not_found', message: 'Booking not found.' });
  if (b.kind !== 'package') return bad(res, 400, 'This endpoint is for monthly package bookings only.');
  const date = String(req.params.date || '').trim();
  const d = (b.daysLog || []).find((x) => x.date === date);
  if (!d) return res.status(404).json({ error: 'not_found', message: 'No logged day for this date.' });
  if (d.released) return bad(res, 409, 'This day is already released.');
  if (d.patientConfirmed) return bad(res, 409, 'This day is already confirmed.');
  d.patientConfirmed = true;
  d.patientConfirmedAt = nowIso();
  d.confirmedBy = 'admin';
  store.audit('package.day_confirmed', 'admin', { bookingId: b.id, date, by: 'admin' });
  store.save();
  res.json({ ok: true, bookingId: b.id, date, patientConfirmed: true, confirmedBy: 'admin' });
});

// v2.1.6 (C7): the admin clears the bulk-registration review flag
// after reviewing the package (the days then release normally).
router.post('/admin/bookings/:id/package-review/clear', requireAdmin, (req, res) => {
  const b = store.data.bookings[req.params.id];
  if (!b) return res.status(404).json({ error: 'not_found', message: 'Booking not found.' });
  if (b.kind !== 'package') return bad(res, 400, 'This endpoint is for monthly package bookings only.');
  if (!b.packageReviewRequired) return bad(res, 409, 'This package has no pending review.');
  b.packageReviewRequired = false;
  b.packageReviewClearedAt = nowIso();
  store.audit('package.review_cleared', 'admin', { bookingId: b.id, reason: b.packageReviewReason || null });
  store.save();
  res.json({ ok: true, bookingId: b.id, packageReviewRequired: false });
});

// Main provider completes the package: all 26 regular days logged, OR
// the 30-day period has ended. Unworked days (regular or extra) are
// refunded to the patient — recorded as partialRefundEgp for the admin
// to settle; they are never released to any provider.
router.post('/bookings/:id/package-complete', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.kind !== 'package') return bad(res, 400, 'This endpoint is for monthly package bookings only.');
  if (b.providerId !== req.user.providerId) return res.status(403).json({ error: 'forbidden', message: 'Only the main provider completes the package.' });
  const blocked = providerBlocked(store.data.providers[req.user.providerId]);
  if (blocked) return res.status(403).json({ error: 'forbidden', message: blocked });
  if (b.status !== 'accepted') return bad(res, 409, `Cannot complete while status is ${b.status}.`);
  const endMs = new Date(b.endDate + 'T00:00:00Z').getTime() + 24 * 60 * 60 * 1000 - 1;
  const allRegularDone = (b.daysCompleted || 0) >= cat.PACKAGE_DAYS;
  if (!allRegularDone && Date.now() <= endMs) {
    return bad(res, 409, `All ${cat.PACKAGE_DAYS} regular days must be logged before completing (logged: ${b.daysCompleted || 0}).`);
  }
  let partialRefundEgp = 0;
  const unworkedRegular = cat.PACKAGE_DAYS - (b.daysCompleted || 0);
  if (unworkedRegular > 0) partialRefundEgp += unworkedRegular * packageDailyRate(b);
  if (b.extraDays && b.extraDays.option !== 'none') {
    const unworkedExtra = cat.PACKAGE_OFF_DAYS - (b.extraDaysCompleted || 0);
    if (unworkedExtra > 0) partialRefundEgp += unworkedExtra * b.extraDays.dailyRateEgp;
  }
  if (partialRefundEgp > 0) b.partialRefundEgp = (b.partialRefundEgp || 0) + partialRefundEgp;
  b.status = 'provider_confirmed';
  b.providerConfirmedAt = nowIso();
  store.audit('package.completed', req.user.phone, { bookingId: b.id, daysCompleted: b.daysCompleted || 0, extraDaysCompleted: b.extraDaysCompleted || 0, partialRefundEgp });
  store.save();
  res.json({ ...pubBooking(req, b, { includePaymentNumber: true }), partialRefundEgp });
});

module.exports = { router, sweepAutoRelease };

// ---------------------------------------------------------------- providers
router.post('/providers/register', requireAuth, (req, res) => {
  const b = normalizeBookingBody(req.body);
  if (store.getProviderByPhone(req.user.phone)) {
    return res.status(409).json({ error: 'conflict', message: 'This phone is already registered as a provider.' });
  }
  // v2.0.8 — Terms & Conditions (incl. the non-circumvention clause)
  // must be accepted with the current version before registration.
  if (!termsAccepted(req.body)) return termsError(res);
  if (!b.name || typeof b.name !== 'string') return bad(res, 400, 'name required.');
  if (b.name.length > 120) return bad(res, 400, 'name is too long (max 120 characters).');
  // v2.1.1: providerType is validated against an allowlist; role is
  // provisional until admin verification sets the verified role.
  const providerType = b.providerType || b.role;
  if (!['assistant', 'nurse', 'doctor', 'physio'].includes(providerType)) return bad(res, 400, 'providerType must be assistant, nurse, doctor or physio.');
  if (isReservedId(String(providerType))) return bad(res, 400, 'Invalid providerType.');
  const nationalId = String(b.nationalId || '');
  const licenseNo = String(b.licenseNo || '');
  if (!/^\d{14}$/.test(nationalId)) return bad(res, 400, 'nationalId must be 14 digits.');
  if (!licenseNo || licenseNo.length < 4) return bad(res, 400, 'licenseNo required.');
  // Certificates / courses are metadata at registration ({name,
  // verified:false} until admin verifies them). The REAL files are
  // uploaded after registration via POST /api/me/documents (v2.1.2)
  // and feed the algorithmic CV evaluation. A physio registration
  // REQUIRES >=1 certificate entry.
  const certificates = Array.isArray(b.certificates)
    ? b.certificates.map((c) => (typeof c === 'string' ? { name: String(c).slice(0, 200), verified: false } : { name: String(c.name || '').slice(0, 200), verified: false })).filter((c) => c.name).slice(0, 20)
    : [];
  const courses = Array.isArray(b.courses)
    ? b.courses.map((c) => (typeof c === 'string' ? { name: String(c).slice(0, 200), verified: false } : { name: String(c.name || '').slice(0, 200), verified: false })).filter((c) => c.name).slice(0, 20)
    : [];
  if (providerType === 'physio' && certificates.length < 1) {
    return res.status(400).json({ error: 'validation_error', message: 'Physiotherapy registration requires at least one certificate entry.' });
  }
  const extraLanguages = Array.isArray(b.extraLanguages)
    ? b.extraLanguages.filter((l) => l && l.language).map((l) => ({ language: String(l.language).toLowerCase().slice(0, 5), certified: l.certified === true })).slice(0, 5)
    : [];
  const claimedLanguages = [...new Set([
    ...(Array.isArray(b.claimedLanguages) ? b.claimedLanguages : []),
    ...(Array.isArray(b.extraLanguages) ? b.extraLanguages : []),
    ...(Array.isArray(b.languageCertificates) ? b.languageCertificates : []),
  ].map((l) => (typeof l === 'string' ? l : (l && l.language) || '')).filter(Boolean).map((l) => String(l).toLowerCase().slice(0, 10)))].slice(0, 7);
  const languageCertificates = Array.isArray(b.languageCertificates)
    ? b.languageCertificates.filter((l) => l && l.language).map((l) => ({ language: String(l.language).toLowerCase().slice(0, 10), certificateName: String(l.certificateName || l.name || '').slice(0, 200), verified: false })).slice(0, 5)
    : extraLanguages.filter((l) => l.certified).map((l) => ({ language: l.language, certificateName: '', verified: false }));
  const id = newId('prov');
  const p = {
    id, demo: false, phone: req.user.phone, name: b.name.trim().slice(0, 120), role: providerType, providerType,
    tier: 'Starter', status: 'pending',
    termsAcceptedVersion: config.termsVersion, termsAcceptedAt: nowIso(),
    warnings: [], suspended: false, suspendedUntil: null, suspendedReason: null, permanentBan: false,
    // v2.1.1 (M18): salted sha256; only last4 ever leaves the server.
    nationalIdHash: saltedSha256(nationalId), nationalIdLast4: nationalId.slice(-4),
    licenseHash: saltedSha256(licenseNo), licenseLast4: licenseNo.slice(-4),
    certificates, courses, languageCertificates, extraLanguages, claimedLanguages,
    languageBadges: {}, languageTests: {}, documents: [], cvEvaluation: null,
    verifiedCertificates: 0, // +5 points each (max 20) — set by admin certificate review
    interviewStatus: 'not_started', interviewScore: null, interviewPoints: 0,
    interviewEnglishCorrect: null, interviewEnglishTotal: null,
    ratingAvg: null, completedVisits: 0, casesByWeek: {},
    joinedAt: nowIso(), createdAt: nowIso(),
    redFlagCount: 0, redFlagApprovalRequired: false, redFlagRetakeAllowed: false, canRetakeAt: null,
    buddyId: null, stayBonusPaid: false,
  };
  store.data.providers[id] = p;
  store.data.providersByPhone[req.user.phone] = id;
  recordTermsAcceptance(req.user.phone);
  recomputeProviderPoints(p);
  refreshCvEvaluation(p);
  store.audit('provider.registered', req.user.phone, { providerId: id, role: providerType, providerType });
  store.save();
  // v2.1.8 — return fresh provider-role tokens with the response, so
  // the client switches to the provider role WITHOUT re-logging in
  // (re-login would need the password the client does not store).
  // The new tokens keep the phone's current authMethod + refresh TTL.
  const { refreshTtlDays, authMethod } = authMethodForPhone(req.user.phone);
  const tokens = issueTokens({ phone: req.user.phone, role: 'provider', providerId: id }, undefined, { refreshTtlDays, authMethod });
  res.status(201).json({ ...store.publicProvider(p, { self: true, points: p.points }), next: 'Take the 36-question interview: POST /api/providers/interview/start', tokens: { ...tokens, token: tokens.accessToken, role: 'provider', providerId: id, phone: req.user.phone, authMethod } });
});

router.get('/providers/me', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  res.json(store.publicProvider(p, { self: true, points: recomputeProviderPoints(p, { auditTier: false }) }));
});

router.get('/providers/radar', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  if (p.interviewStatus !== 'passed') {
    return res.status(403).json({ error: 'forbidden', message: 'Pass the interview first — radar is locked until interviewStatus=passed.' });
  }
  // v2.1.1 (audit #11): radar requires admin-verified status, not just
  // an interview pass.
  if (p.status !== 'verified') {
    return res.status(403).json({ error: 'forbidden', message: 'Admin document verification is required before radar access (status=verified).' });
  }
  // v2.0.8 — a suspended / banned provider sees no radar at all.
  const blocked = providerBlocked(p);
  if (blocked) return res.status(403).json({ error: 'forbidden', message: blocked });
  // v2.0.8 — maxKm is capped at 35 (the auto-pricing limit); the radar
  // returns MINIMAL items only (store.radarBooking): no patient phone,
  // name, address, contact, notes, triage or insurer data.
  const maxKm = Math.min(35, Number(req.query.maxKm) || 35);
  const nowMs = Date.now();
  const held = Object.values(store.data.bookings)
    .filter((b) => b.status === 'held' && !b.providerId && (b.distanceKm ?? 99) <= maxKm
      // v2.1.0 — high-risk tier: nursing assistants never see high-risk
      // bookings on the radar (they cannot accept them — enforced at
      // accept time too). Nurses and doctors see everything.
      && !(p.providerType === 'assistant' && cat.isHighRiskService(b.serviceCode))
      // v2.1.1 — physio-category services ONLY to providerType 'physio'.
      && !(b.category === 'physio' && p.providerType !== 'physio')
      // v2.1.2 — tourist bookings ONLY to providers who passed the
      // in-app test for THAT booking's language (interview passed +
      // test passed) and are not English-blocked. A certificate alone
      // no longer grants the badge (supersedes v2.1.1).
      && !(b.kind === 'tourist' && (!touristCompatibleFor(p, b.language) || englishBlocked(p)))
      // v2.1.2 — a booking whose receipt photo is still under admin
      // review cannot be accepted yet, so it stays off the radar too.
      // v2.1.6 (C6): an online booking with NO receipt at all is also
      // hidden (it cannot exist after the creation fix, but older data
      // and direct API calls must stay blocked).
      && !receiptBlocked(b)
      // v2.1.1 — Elite early access: bookings created <30 min ago are
      // visible ONLY to Elite providers; everyone else sees them after
      // 30 minutes.
      && !(nowMs - new Date(b.createdAt).getTime() < 30 * 60 * 1000 && p.tier !== 'Elite'))
    .sort((a, b) => {
      // Preferred bookings first, then nearest.
      const aPref = a.preferredProviderId === p.id ? 0 : 1;
      const bPref = b.preferredProviderId === p.id ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      return (a.distanceKm ?? 99) - (b.distanceKm ?? 99);
    })
    .map((b) => store.radarBooking(b, {
      eliteEarly: nowMs - new Date(b.createdAt).getTime() < 30 * 60 * 1000,
      preferredForYou: b.preferredProviderId === p.id,
    }));
  res.json({ providerId: p.id, tier: p.tier, pending: held });
});

router.post('/bookings/:id/accept', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (isReservedId(req.params.id)) return res.status(400).json({ error: 'validation_error', message: 'Invalid identifier.' });
  const p = store.data.providers[req.user.providerId];
  if (!p || p.interviewStatus !== 'passed') {
    return res.status(403).json({ error: 'forbidden', message: 'Pass the interview first.' });
  }
  // v2.1.1 (audit #11): accept requires admin-verified status.
  if (p.status !== 'verified') {
    return res.status(403).json({ error: 'forbidden', message: 'Admin document verification is required before accepting work (status=verified).' });
  }
  // v2.1.2 — defense in depth: tourist bookings need the in-app test
  // for this booking's language (interview passed + test passed) and a
  // non-blocked English check; physio services need a physio provider.
  if (b.kind === 'tourist' && (!touristCompatibleFor(p, b.language) || englishBlocked(p))) {
    return res.status(403).json({ error: 'forbidden', message: `Tourist bookings in ${b.language || 'en'} require the in-app ${(b.language || 'en').toUpperCase()} language test (interview passed + test passed).` });
  }
  // v2.1.2 — a receipt photo under admin review blocks acceptance
  // until the admin confirms or rejects it. v2.1.6 (C6): an online
  // booking with NO receipt at all is blocked the same way.
  if (receiptBlocked(b)) {
    const msg = receiptPending(b)
      ? 'This booking has a receipt photo under admin review — it cannot be accepted until the admin confirms or rejects the receipt.'
      : 'This booking has an online payment with no receipt photo — it cannot be accepted until the patient uploads a receipt.';
    return res.status(403).json({ error: 'receipt_pending_review', message: msg });
  }
  if (b.category === 'physio' && p.providerType !== 'physio') {
    return res.status(403).json({ error: 'forbidden', message: 'Physiotherapy services can only be accepted by a physiotherapy specialist.' });
  }
  // v2.0.8 — a suspended / banned provider cannot accept work.
  const blocked = providerBlocked(p);
  if (blocked) return res.status(403).json({ error: 'forbidden', message: blocked });
  // v2.1.0 — high-risk tier (owner refinement 26 Nov 2026): only VERIFIED
  // nurses (or doctors) may accept high-risk bookings. Nursing assistants
  // cannot — enforced here, and the radar hides these bookings from them.
  if (cat.isHighRiskService(b.serviceCode)) {
    if (p.role !== 'nurse' && p.role !== 'doctor') {
      return res.status(403).json({ error: 'forbidden', message: 'High-risk services can only be accepted by a verified nurse (or doctor). Nursing assistants cannot take these bookings.' });
    }
    if (p.status !== 'verified') {
      return res.status(403).json({ error: 'forbidden', message: 'High-risk services can only be accepted after admin document verification (status=verified).' });
    }
  }
  if (b.status !== 'held' || b.providerId) return bad(res, 409, `Booking cannot be accepted while status is ${b.status}.`);
  b.providerId = p.id;
  // v2.0.9 — commission is locked at accept time. An active promo month
  // overrides the tier rate (e.g. 0%); otherwise the REVERSED tier rates
  // apply (Starter 15% / Pro 12% / Elite 8%). Already-accepted bookings
  // keep the commissionPct they locked in.
  const promoNow = activePromo();
  b.commissionPct = promoNow ? promoNow.commissionPct : cat.TIERS[p.tier].commission_pct;
  b.promoCommissionPct = promoNow ? promoNow.commissionPct : null;
  b.commissionTier = p.tier;
  // v2.1.4 — launch-month shift offer is locked at accept time, exactly
  // like the commission: only single shift12/shift24 bookings accepted
  // while the offer is active get the 700/1,200 reference. Packages,
  // elderly shifts and every other service never get it. The reference
  // total = amount paid with the base price swapped for its reference
  // (distance fee unchanged). The ESTIMATED share uses the reference so
  // the wallet shows the topped-up pending amount before release.
  const offerNow = activeLaunchOffer();
  const offerRef = offerNow ? launchOfferReferenceFor(b) : null;
  if (offerRef != null) {
    b.launchOffer = { active: true, referenceEgp: offerRef, referenceBaseEgp: cat.LAUNCH_OFFER_REFERENCE[b.serviceCode], topupEgp: offerRef - b.amountEgp, setAt: offerNow.setAt || null };
  } else {
    b.launchOffer = null;
  }
  // v2.1.1 (audit M7): ESTIMATED provider share at accept time, so the
  // wallet shows a pending amount before release (release recomputes
  // exactly).
  b.estimatedProviderShareEgp = Math.round((offerRef != null ? offerRef : b.amountEgp) * (1 - b.commissionPct / 100));
  b.status = 'accepted';
  b.acceptedAt = nowIso();
  store.audit('booking.accepted', req.user.phone, { bookingId: b.id, providerId: p.id, commissionPct: b.commissionPct, promoApplied: !!promoNow, launchOfferApplied: offerRef != null, launchOfferReferenceEgp: offerRef });
  store.save();
  // v2.1.0 — notify the patient (critical: booking accepted). Fire and
  // forget — the in-app record is written synchronously inside notifyUser;
  // push/SMS delivery must never block the response.
  notify.notifyUser(b.patientPhone, {
    type: 'booking_accepted', critical: true,
    titleAr: 'تم قبول حجزك', titleEn: 'Your booking was accepted',
    bodyAr: 'قبل مقدم الخدمة حجزك، وهو في الطريق إليك. تابع وصوله من التطبيق.',
    bodyEn: 'Your booking was accepted — your provider is on the way. Track the visit in the app.',
    data: { bookingId: b.id },
    validUntilMs: Date.now() + 6 * 60 * 60 * 1000,
  }).catch((e) => console.error('[notify] booking.accepted:', e.message));
  res.json(pubBooking(req, b, { includePaymentNumber: true }));
});

// v2.1.0 — provider marks themselves en route (after acceptance, before
// the visit). The patient gets a critical notification (in-app + push,
// SMS fallback when push cannot reach them). Does not change escrow,
// status, or any window — it only stamps enRouteAt.
router.post('/bookings/:id/en-route', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.providerId !== req.user.providerId) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (b.status !== 'accepted') return bad(res, 409, `Cannot mark en route while status is ${b.status}.`);
  b.enRouteAt = nowIso();
  store.audit('booking.en_route', req.user.phone, { bookingId: b.id });
  store.save();
  notify.notifyUser(b.patientPhone, {
    type: 'provider_en_route', critical: true,
    titleAr: 'مقدم الخدمة في الطريق', titleEn: 'Your provider is on the way',
    bodyAr: 'مقدم الخدمة في الطريق إليك الآن. تابع وصوله من التطبيق.',
    bodyEn: 'Your provider is on the way to you now. Track their arrival in the app.',
    data: { bookingId: b.id },
    validUntilMs: Date.now() + 2 * 60 * 60 * 1000,
  }).catch((e) => console.error('[notify] booking.en_route:', e.message));
  res.json(pubBooking(req, b, { includePaymentNumber: true }));
});

router.post('/bookings/:id/vitals', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.providerId !== req.user.providerId) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  const blockedVitals = providerBlocked(store.data.providers[req.user.providerId]);
  if (blockedVitals) return res.status(403).json({ error: 'forbidden', message: blockedVitals });
  if (store.data.providers[req.user.providerId]?.status !== 'verified') return res.status(403).json({ error: 'forbidden', message: 'Admin document verification is required (status=verified).' });
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
  b.vitalsAt = nowIso(); // v2.1.1 (audit #28): first on-site event — the late-visit clock starts here
  // v2.1.0 — suture removal: the provider may confirm here that they
  // have seen the written doctor order (also accepted at completion).
  if (v.doctorOrderSeen === true) b.doctorOrderSeenByProvider = true;
  store.audit('booking.vitals', req.user.phone, { bookingId: b.id });
  store.save();
  res.json(pubBooking(req, b, { includePaymentNumber: true }));
});

router.post('/bookings/:id/complete-provider', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.providerId !== req.user.providerId) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  const blockedComplete = providerBlocked(store.data.providers[req.user.providerId]);
  if (blockedComplete) return res.status(403).json({ error: 'forbidden', message: blockedComplete });
  if (store.data.providers[req.user.providerId]?.status !== 'verified') return res.status(403).json({ error: 'forbidden', message: 'Admin document verification is required (status=verified).' });
  if (b.status !== 'accepted') return bad(res, 409, `Cannot confirm completion while status is ${b.status}.`);
  if (!b.vitals) return bad(res, 409, 'Mandatory vitals must be recorded before completing the visit.');
  // v2.1.6 (C8): a visit cannot be completed less than 10 minutes
  // after acceptance — instant accept→complete cycles are the signature
  // of fake-visit farming. The clock starts at acceptance (the provider
  // accepts when they arrive on site). Rejected attempts are audited so
  // repeated attempts flag the provider in the admin dashboard.
  if (b.acceptedAt && config.minVisitMs > 0) {
    const acceptMs = new Date(b.acceptedAt).getTime();
    if (Number.isFinite(acceptMs) && Date.now() - acceptMs < config.minVisitMs) {
      store.audit('booking.complete_too_fast', req.user.phone, { bookingId: b.id, providerId: req.user.providerId, acceptedAt: b.acceptedAt, minMinutes: Math.round(config.minVisitMs / 60000) });
      store.save();
      return bad(res, 409, `Visit too short: at least ${Math.round(config.minVisitMs / 60000)} minutes must pass between acceptance and completion.`, { minMinutes: Math.round(config.minVisitMs / 60000) });
    }
  }
  // v2.1.0 — suture removal: the provider must confirm seeing the written
  // doctor order before completing the visit (also accepted at vitals).
  if (b.serviceCode === 'suture_removal' && !b.doctorOrderSeenByProvider) {
    if (req.body?.doctorOrderSeen === true) b.doctorOrderSeenByProvider = true;
    else return bad(res, 409, 'Suture removal: confirm you have seen the written doctor order before completing the visit (send doctorOrderSeen=true).');
  }
  // v2.1.0 — high-risk tier: the in-app safety checklist must be
  // completed before finishing the visit. All four items are required.
  if (cat.isHighRiskService(b.serviceCode)) {
    const sc = req.body?.safetyChecklist || {};
    const missing = cat.HIGH_RISK_CHECKLIST.filter((k) => sc[k] !== true);
    if (missing.length) {
      return bad(res, 409, `High-risk service: complete the safety checklist before finishing the visit (missing: ${missing.join(', ')}).`, { required: cat.HIGH_RISK_CHECKLIST, missing });
    }
    b.safetyChecklist = { orderSeen: true, sterileTechnique: true, identityConfirmed: true, complicationCheck: true, at: nowIso() };
  }
  // v2.1.1 (web contract): the completion response carries the
  // provider's points — earned = change in total points caused by THIS
  // completion (usually 0; positive when a cases-points threshold or a
  // weekly-double threshold is crossed), total/tier = current values
  // after recompute. Points are computed BEFORE the status change so
  // the delta is honest.
  const prov = store.data.providers[req.user.providerId];
  const pointsBefore = prov ? computePoints(prov, Object.values(store.data.bookings)).total : 0;
  b.status = 'provider_confirmed';
  b.providerConfirmedAt = nowIso();
  let pointsAfter = pointsBefore;
  let tierAfter = prov ? prov.tier : null;
  if (prov) {
    const pts = recomputeProviderPoints(prov);
    pointsAfter = pts ? pts.total : pointsBefore;
    tierAfter = pts ? pts.tier : tierAfter;
  }
  const pointsEarned = Math.max(0, pointsAfter - pointsBefore);
  store.audit('booking.provider_confirmed', req.user.phone, { bookingId: b.id, note: 'Provider confirmed completion before leaving; patient confirmation is separate.', pointsEarned, pointsTotal: pointsAfter });
  store.save();
  res.json({ ...pubBooking(req, b, { includePaymentNumber: true }), points: { earned: pointsEarned, total: pointsAfter, tier: tierAfter } });
});

router.get('/providers/wallet', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  // v2.1.3 — a package's SUBSTITUTE provider also sees the package's
  // money (their 4 extra days live on it).
  const mine = Object.values(store.data.bookings).filter((b) => b.providerId === p.id || (b.kind === 'package' && b.substituteProviderId === p.id));
  const nowMs = Date.now();
  const ledger = [];
  // v2.1.3 — package bookings: the money moves per completed day, not as
  // one lump at release (a package's providerShareEgp is the aggregate of
  // ALL day releases, which may span several weeks). So a package gets
  // one ledger line per day-release (for THIS provider — the substitute's
  // days belong to the substitute's wallet) plus one "remaining" line for
  // the unreleased estimate (main provider only). Only the FINAL release's
  // line is held by an open complaint, like a normal booking; weekly
  // releases already settled are never held back (terms §12).
  for (const b of mine) {
    if (b.kind !== 'package') continue;
    for (const rel of (b.packageDayReleases || [])) {
      if (rel.providerId !== p.id) continue;
      const holdOpen = b.complaintStatus === 'open' && rel.final;
      const windowOpen = rel.final && b.complaintDeadline && nowMs < new Date(b.complaintDeadline).getTime() && b.complaintStatus !== 'rejected';
      let direction, amountEgp;
      if (holdOpen || windowOpen) {
        direction = 'complaint_hold';
        amountEgp = b.cashCollectedByProvider ? (rel.appShareEgp || 0) : (rel.providerShareEgp || 0);
      } else if (b.cashCollectedByProvider) { direction = 'provider_owes_app'; amountEgp = rel.appShareEgp || 0; }
      else { direction = 'app_owes_provider'; amountEgp = rel.providerShareEgp || 0; }
      if (p.permanentBan && ['app_owes_provider', 'complaint_hold'].includes(direction)) { direction = 'forfeited'; amountEgp = 0; }
      ledger.push({
        bookingId: b.id, service: b.serviceName, status: b.status, kind: 'package-day',
        days: rel.days, weekKey: rel.weekKey, finalRelease: !!rel.final,
        totalEgp: b.amountEgp, appShareEgp: rel.appShareEgp, providerShareEgp: rel.providerShareEgp,
        commissionPct: b.commissionPct, cashCollectedByProvider: b.cashCollectedByProvider,
        direction, amountEgp, releasedAt: rel.releasedAt || null,
        complaintStatus: b.complaintStatus || null, complaintDeadline: b.complaintDeadline || null,
        settleableAt: rel.final ? (b.settleableAt || b.complaintDeadline || null) : null, refundEgp: b.refundEgp || null,
      });
    }
    if (b.providerId === p.id && ['held', 'accepted', 'provider_confirmed', 'patient_confirmed', 'reviewed'].includes(b.status)) {
      const releasedProv = (b.packageDayReleases || []).reduce((s, x) => s + (x.providerShareEgp || 0), 0);
      const remaining = Math.max(0, (b.estimatedProviderShareEgp || 0) - releasedProv);
      let direction = b.circumventionHold ? 'complaint_hold' : 'pending';
      let amountEgp = remaining;
      if (p.permanentBan && ['pending', 'complaint_hold'].includes(direction)) { direction = 'forfeited'; amountEgp = 0; }
      ledger.push({
        bookingId: b.id, service: b.serviceName, status: b.status, kind: 'package-remaining',
        totalEgp: b.amountEgp, appShareEgp: b.appShareEgp, providerShareEgp: b.providerShareEgp,
        estimatedProviderShareEgp: b.estimatedProviderShareEgp ?? null,
        commissionPct: b.commissionPct, cashCollectedByProvider: b.cashCollectedByProvider,
        direction, amountEgp, releasedAt: b.releasedAt || null,
        complaintStatus: b.complaintStatus || null, complaintDeadline: b.complaintDeadline || null,
        settleableAt: b.settleableAt || b.complaintDeadline || null, refundEgp: b.refundEgp || null,
      });
    }
  }
  ledger.push(...mine.filter((b) => b.kind !== 'package').map((b) => {
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
      const holdOpen = b.complaintStatus === 'open' || b.circumventionHold;
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
    } else if (pending) {
      // v2.0.8 — a circumvention hold keeps the money in the hold bucket.
      // v2.1.1 (M7): pending lines show the ESTIMATED share computed at
      // accept time (release recomputes exactly).
      direction = b.circumventionHold ? 'complaint_hold' : 'pending';
      amountEgp = b.estimatedProviderShareEgp ?? b.providerShareEgp ?? 0;
    }
    if (p.permanentBan && ['app_owes_provider', 'complaint_hold', 'pending'].includes(direction)) {
      // v2.0.8 — a permanent ban forfeits pending settlement. Money the
      // provider already owes the app (cash collected) is NOT forgiven.
      direction = 'forfeited'; amountEgp = 0;
    }
    return {
      bookingId: b.id, service: b.serviceName, status: b.status,
      totalEgp: b.amountEgp, appShareEgp: b.appShareEgp, providerShareEgp: b.providerShareEgp,
      estimatedProviderShareEgp: b.estimatedProviderShareEgp ?? null,
      languageBonusEgp: b.languageBonusEgp || 0,
      commissionPct: b.commissionPct, cashCollectedByProvider: b.cashCollectedByProvider,
      direction, amountEgp, releasedAt: b.releasedAt || null,
      complaintStatus: b.complaintStatus || null, complaintDeadline: b.complaintDeadline || null,
      settleableAt: b.settleableAt || b.complaintDeadline || null, refundEgp: b.refundEgp || null,
    };
  }));
  const totals = {
    appOwesProviderEgp: ledger.filter((l) => l.direction === 'app_owes_provider').reduce((s, l) => s + l.amountEgp, 0),
    providerOwesAppEgp: ledger.filter((l) => l.direction === 'provider_owes_app').reduce((s, l) => s + l.amountEgp, 0),
    pendingEgp: ledger.filter((l) => l.direction === 'pending').reduce((s, l) => s + l.amountEgp, 0),
    complaintHoldEgp: ledger.filter((l) => l.direction === 'complaint_hold').reduce((s, l) => s + l.amountEgp, 0),
    forfeitedEgp: ledger.filter((l) => l.direction === 'forfeited').reduce((s, l) => s + (l.providerShareEgp || 0), 0),
  };
  // v2.0.9 — monthly volume bonus: paid with the Thursday settlement, so
  // it is added to what the app owes the provider for this month.
  // During a 0%-commission promo month the cash bonus is PAUSED (titles
  // still awarded) — volumeBonus.paused says so, with bonusEgp 0.
  // v2.1.6 (C3): the bonus is paid ONCE per month — the wallet shows
  // only the INCREASE still due (volumeBonusDue), never the full amount
  // again. `volumeBonus` (the full object) is kept for the title and
  // the next target; `volumeBonusPaidEgp` shows what was already paid.
  const volumeBonus = volumeBonusFor(p.id, monthKey());
  const vbDue = volumeBonusDue(p, monthKey());
  // A permanent ban forfeits pending settlement — including the bonus.
  if (p.permanentBan) { volumeBonus.bonusEgp = 0; volumeBonus.note = 'Volume bonus forfeited (permanent ban).'; vbDue.dueEgp = 0; }
  totals.volumeBonusEgp = vbDue.dueEgp;
  totals.appOwesProviderEgp += vbDue.dueEgp;
  const promoNow = activePromo();
  // v2.1.1 — points snapshot + 90-day stay bonus + buddy + days since join.
  const pts = recomputeProviderPoints(p, { auditTier: false });
  const stay = stayBonusState(p);
  const stayDue = stay.earned && !stay.paid ? cat.STAY_BONUS_EGP : 0;
  totals.stayBonusEgp = stayDue;
  if (stayDue > 0) totals.appOwesProviderEgp += stayDue;
  const buddy = p.buddyId ? store.data.providers[p.buddyId] : null;
  res.json({
    providerId: p.id, tier: p.tier, commissionPct: effectiveCommissionPct(p.tier),
    commissionPctTier: cat.TIERS[p.tier].commission_pct,
    points: pts,
    stayBonus: stay,
    buddy: buddy ? { id: buddy.id, name: buddy.name } : null,
    daysSinceJoin: stay.daysSinceJoin,
    promo: promoNow ? { active: true, commissionPct: promoNow.commissionPct, until: promoNow.until || null } : { active: false, commissionPct: null, until: null },
    monthlyCases: volumeBonus.cases, volumeBonusEgp: vbDue.dueEgp,
    volumeBonusPaidEgp: vbDue.paidEgp || 0,
    nextBonusAt: volumeBonus.nextBonusAt,
    volumeBonus,
    nextSettlementThursday: nextThursday(),
    // v2.0.8 — discipline state, so the provider sees warnings/suspension
    // in their own wallet screen (and why their radar is closed).
    suspended: !!p.suspended, permanentBan: !!p.permanentBan,
    warnings: p.warnings || [],
    note: 'Weekly settlement every Thursday (Uber-style ledger). If you collected cash by hand, the app share shows as "you owe the app" and is due on Thursday.',
    ledger, totals,
  });
});

// ---------------------------------------------------------------- interview (v2.1.1)
// Expanded interview (owner-approved 26 Nov 2026, INTERVIEW-EXPANDED-
// PROPOSAL.md): FIXED 30 common questions + 6 role-specific questions
// (assistant / nurse / doctor / physio) = 36 per attempt, 30 minutes.
// Dimensions: medical 8 / ethics 7 / safety 6 / communication 6 /
// resilience 5 / conduct 4. Pass: total >= 24 AND medical >= 5 AND
// ethics >= 5 AND safety >= 4 AND no red flag. Manual review: total
// 21–23, or a mandatory minimum missed by exactly 1, or any dimension
// 0–1. Fail: total < 21 or a minimum missed by > 1. Red flag: any of
// the 10 dangerous options -> instant fail ('red-flag') whatever the
// score. Retakes: normal fail -> +7 days, max 3 attempts then
// admin-only; red flag -> +14 days AND admin approval before a new
// attempt; 2nd red flag -> no retakes except by explicit admin decision.
// Interview points: total >= 30 -> 20, 24–29 -> 15, manual-review admin
// pass -> 10, else 0. English 0/3 -> englishBlocked (no tourist radar).
// The 90-question rotating bank is Phase 2 — this is the fixed 36.
function buildAttemptQuestions(providerType) {
  const role = (providerType === 'assistant' || providerType === 'nurse' || providerType === 'doctor' || providerType === 'physio') ? providerType : 'nurse';
  // Shuffle question order AND option order; keep the answer key +
  // red-flag markers server-side ONLY (never sent to the client).
  const questions = shuffle([...cat.INTERVIEW_COMMON, ...cat.INTERVIEW_ROLE_QUESTIONS[role]]);
  const answerKey = {};
  const redFlagKey = {};
  const pub = questions.map((q) => {
    const opts = shuffle(q.options);
    answerKey[q.id] = q.correct;
    if (q.redFlagOption) redFlagKey[q.id] = q.redFlagOption;
    return { id: q.id, category: q.category, text: q.text, options: opts };
  });
  const en = shuffle(cat.ENGLISH_CHECK);
  const enKey = {};
  const enPub = en.map((q) => {
    enKey[q.id] = q.correct;
    return { id: q.id, text: q.text, options: shuffle(q.options) };
  });
  return { pub, answerKey, redFlagKey, enPub, enKey, role };
}
function interviewPassRuleText() {
  return `Pass needs ${config.interviewPassTotal}/36 total AND medical >= ${config.interviewPassMedical}/8 AND ethics >= ${config.interviewPassEthics}/7 AND safety >= ${config.interviewPassSafety}/6, with no red-flag answer. Manual review: 21–23 total, or a mandatory minimum missed by exactly 1, or any dimension 0–1.`;
}
function interviewResponse(active) {
  return {
    attemptId: active.attemptId, deadlineAt: active.deadlineAt, minutes: config.interviewMinutes,
    totalQuestions: 36,
    dimensions: cat.INTERVIEW_DIMENSIONS.map((d) => ({ key: d.key, nameAr: d.nameAr, nameEn: d.nameEn, questions: d.questions, min: d.min })),
    passRule: interviewPassRuleText(),
    questions: active.pub, // NO answers, NO red-flag markers
    englishCheck: { note: 'Separate, unscored English check (3 simple questions). No certificate needed for English.', questions: active.enPub },
  };
}
function interviewCooldown(p) {
  // Returns {blocked, canRetakeAt, reason} from the provider record.
  if (p.redFlagCount >= 2 && !p.redFlagRetakeAllowed) {
    return { blocked: true, canRetakeAt: null, reason: 'Two red-flag failures — retakes need an explicit admin decision.' };
  }
  if (p.redFlagApprovalRequired && !p.redFlagRetakeAllowed) {
    return { blocked: true, canRetakeAt: p.canRetakeAt || null, reason: 'A red-flag failure needs admin approval before a new attempt.' };
  }
  if (p.canRetakeAt && new Date(p.canRetakeAt).getTime() > Date.now()) {
    return { blocked: true, canRetakeAt: p.canRetakeAt, reason: 'Retake cooldown is still active.' };
  }
  return { blocked: false, canRetakeAt: null, reason: null };
}

router.post('/providers/interview/start', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  const rec = store.data.interviews[p.id] || { attempts: [], active: null };
  if (rec.active && new Date(rec.active.deadlineAt).getTime() > Date.now()) {
    return res.status(409).json({ error: 'conflict', message: 'An interview attempt is already in progress.', deadlineAt: rec.active.deadlineAt });
  }
  const cd = interviewCooldown(p);
  if (cd.blocked) {
    return res.status(409).json({ error: 'retake_blocked', message: cd.reason, canRetakeAt: cd.canRetakeAt });
  }
  const attemptsUsed = (rec.attempts || []).length;
  if (attemptsUsed >= config.interviewMaxAttempts && p.interviewStatus !== 'passed') {
    return res.status(409).json({ error: 'attempts_exhausted', message: 'Maximum 3 interview attempts reached — further retakes need an admin decision.', attemptsUsed });
  }
  const { pub, answerKey, redFlagKey, enPub, enKey, role } = buildAttemptQuestions(p.providerType || p.role);
  const attemptId = newId('int');
  const deadlineAt = new Date(Date.now() + config.interviewMinutes * 60 * 1000).toISOString();
  rec.active = { attemptId, startedAt: nowIso(), deadlineAt, answerKey, redFlagKey, enKey, pub, enPub, role };
  store.data.interviews[p.id] = rec;
  store.audit('provider.interview_started', req.user.phone, { providerId: p.id, attemptId, role });
  store.save();
  res.json(interviewResponse(rec.active));
});

// GET questions: re-serve the active attempt's shuffled questions, or
// start a new attempt (same cooldown / attempt-cap rules as start).
router.get('/providers/interview/questions', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  const rec = store.data.interviews[p.id] || { attempts: [], active: null };
  let active = rec.active;
  if (!active || new Date(active.deadlineAt).getTime() <= Date.now()) {
    if (active) { rec.active = null; }
    const cd = interviewCooldown(p);
    if (cd.blocked) {
      return res.status(409).json({ error: 'retake_blocked', message: cd.reason, canRetakeAt: cd.canRetakeAt });
    }
    const attemptsUsed = (rec.attempts || []).length;
    if (attemptsUsed >= config.interviewMaxAttempts && p.interviewStatus !== 'passed') {
      return res.status(409).json({ error: 'attempts_exhausted', message: 'Maximum 3 interview attempts reached — further retakes need an admin decision.', attemptsUsed });
    }
    const { pub, answerKey, redFlagKey, enPub, enKey, role } = buildAttemptQuestions(p.providerType || p.role);
    active = {
      attemptId: newId('int'), startedAt: nowIso(),
      deadlineAt: new Date(Date.now() + config.interviewMinutes * 60 * 1000).toISOString(),
      answerKey, redFlagKey, enKey, pub, enPub, role,
    };
    rec.active = active;
    store.data.interviews[p.id] = rec;
    store.audit('provider.interview_started', req.user.phone, { providerId: p.id, attemptId: active.attemptId, role });
    store.save();
  }
  res.json(interviewResponse(active));
});

router.post('/providers/interview/submit', requireAuth, requireRole('provider'), (req, res) => {
  const p = store.data.providers[req.user.providerId];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider record not found.' });
  const rec = store.data.interviews[p.id];
  // The frontend does not always send attemptId — the single active
  // attempt per provider is authoritative. An explicit attemptId, if
  // sent, must match.
  const active = rec?.active;
  if (!active || (req.body?.attemptId && req.body.attemptId !== active.attemptId)) {
    return bad(res, 409, 'No active interview attempt. Start one first.');
  }
  if (new Date(active.deadlineAt).getTime() < Date.now()) {
    rec.active = null;
    rec.attempts.push({ attemptId: active.attemptId, startedAt: active.startedAt, submittedAt: nowIso(), result: 'expired', scores: null, total: 0 });
    store.save();
    return res.status(410).json({ error: 'expired', message: 'The 30-minute interview deadline passed (server time). Start a new attempt.' });
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
  const scores = { medical: 0, ethics: 0, safety: 0, communication: 0, resilience: 0, conduct: 0 };
  let redFlag = false;
  const redFlagQuestions = [];
  for (const q of [...cat.INTERVIEW_COMMON, ...(cat.INTERVIEW_ROLE_QUESTIONS[active.role] || [])]) {
    const a = answers[q.id];
    if (a === active.answerKey[q.id]) scores[q.category] += 1;
    if (active.redFlagKey[q.id] && a === active.redFlagKey[q.id]) {
      redFlag = true;
      redFlagQuestions.push(q.id);
    }
  }
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  let enCorrect = 0;
  for (const q of cat.ENGLISH_CHECK) {
    if (enAnswers[q.id] === active.enKey[q.id]) enCorrect += 1;
  }
  const english = { correct: enCorrect, total: 3, level: enCorrect >= 2 ? 'basic-ok' : enCorrect === 1 ? 'basic-weak' : 'needs-support', note: 'Unscored — reported separately; no certificate needed for English.' };
  // Pass / manual-review / fail (all three mandatory minima matter).
  const mins = [
    { key: 'medical', need: config.interviewPassMedical },
    { key: 'ethics', need: config.interviewPassEthics },
    { key: 'safety', need: config.interviewPassSafety },
  ];
  const missedBy = mins.map((m) => ({ key: m.key, miss: m.need - scores[m.key] }));
  const anyDimLow = Object.values(scores).some((v) => v <= 1);
  let status;
  if (redFlag) status = 'red-flag';
  else if (total >= config.interviewPassTotal && missedBy.every((m) => m.miss <= 0)) status = 'passed';
  // Fail wins over manual review: total < 21, or a mandatory minimum
  // missed by MORE than 1.
  else if (total < config.interviewManualReviewMin || missedBy.some((m) => m.miss > 1)) status = 'failed';
  else if ((total >= config.interviewManualReviewMin && total <= config.interviewPassTotal - 1)
    || missedBy.some((m) => m.miss === 1) || anyDimLow) status = 'manual-review';
  else status = 'failed';
  // Interview points (into the points system): >=30 -> 20, 24–29 -> 15,
  // manual-review admin pass -> 10 (set by the admin decision endpoint),
  // else 0.
  let interviewPoints = 0;
  if (status === 'passed') interviewPoints = total >= cat.POINTS.interview.excellentMin ? cat.POINTS.interview.excellentPts : cat.POINTS.interview.passPts;
  const attemptsLeft = Math.max(0, config.interviewMaxAttempts - ((rec.attempts || []).length + 1));
  let canRetakeAt = null;
  if (status === 'red-flag') {
    p.redFlagCount = (p.redFlagCount || 0) + 1;
    p.redFlagApprovalRequired = true;
    p.redFlagRetakeAllowed = false;
    canRetakeAt = new Date(Date.now() + config.interviewRedFlagRetakeDays * 24 * 60 * 60 * 1000).toISOString();
    p.canRetakeAt = canRetakeAt;
    p.interviewStatus = 'failed';
  } else if (status === 'failed') {
    canRetakeAt = new Date(Date.now() + config.interviewRetakeDays * 24 * 60 * 60 * 1000).toISOString();
    p.canRetakeAt = canRetakeAt;
    p.interviewStatus = 'failed';
  } else if (status === 'manual-review') {
    p.interviewStatus = 'manual-review';
    p.canRetakeAt = null;
  } else {
    p.interviewStatus = 'passed';
    p.canRetakeAt = null;
  }
  p.interviewPoints = interviewPoints;
  p.interviewScore = { scores, total };
  p.interviewEnglishCorrect = enCorrect;
  p.interviewEnglishTotal = 3;
  const attempt = {
    attemptId: active.attemptId, startedAt: active.startedAt, submittedAt: nowIso(),
    scores, total, passed: status === 'passed', status, redFlag, redFlagQuestions: redFlag ? redFlagQuestions : [],
    canRetakeAt, attemptsLeft,
    english,
  };
  rec.attempts.push(attempt);
  rec.active = null;
  recomputeProviderPoints(p);
  store.audit('provider.interview_submitted', req.user.phone, { providerId: p.id, total, scores, status, redFlag, attemptsLeft });
  store.save();
  const message = status === 'passed'
    ? 'Passed. Awaiting admin document verification before activation.'
    : status === 'red-flag'
      ? 'An answer conflicts with patient safety — instant fail. A retake needs admin approval after 14 days.'
      : status === 'manual-review'
        ? 'Referred to manual review. Admin will decide: pass, fail, or allow a retake.'
        : 'Did not meet the pass rule. You may retake after 7 days.';
  // Back-compat aliases for the old response shape (result / ethics).
  res.json({ ...attempt, result: status, ethics: scores.ethics, message });
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

// ---------------------------------------------------------------- v2.1.0 — Quseir doctors directory
// Seeded EMPTY on purpose — no fake doctors. The admin adds real doctors
// with their consent (name, specialty, phone, clinic/address, working
// hours, notes, active/inactive). Provider-side READ ONLY. Patients NEVER
// see doctors' numbers (anti-leakage: same rule as provider numbers) —
// there is NO patient-facing doctors endpoint at all. Referrals are
// audit-logged on the booking, with a snapshot of the doctor (so a later
// edit/delete never rewrites history).
function publicDoctor(d, { includePhone = false } = {}) {
  const out = {
    id: d.id, name: d.name, specialty: d.specialty,
    clinic: d.clinic || null, address: d.address || null,
    workingHours: d.workingHours || null, notes: d.notes || null,
    active: d.active !== false, createdAt: d.createdAt,
  };
  if (includePhone) out.phone = d.phone;
  return out;
}
function validateDoctorBody(body, { partial = false } = {}) {
  const v = {};
  if (body?.name !== undefined || !partial) {
    const name = String(body?.name || '').trim().slice(0, 120);
    if (!name) return { error: 'name required.' };
    v.name = name;
  }
  if (body?.specialty !== undefined || !partial) {
    const specialty = String(body?.specialty || '').trim().slice(0, 80);
    if (!specialty) return { error: 'specialty required.' };
    v.specialty = specialty;
  }
  if (body?.phone !== undefined || !partial) {
    const phone = normalizePhone(body?.phone);
    if (!phone) return { error: 'Valid Egyptian phone number required (01xxxxxxxxx).' };
    v.phone = phone;
  }
  if (body?.clinic !== undefined) v.clinic = String(body.clinic || '').slice(0, 200);
  if (body?.address !== undefined) v.address = String(body.address || '').slice(0, 300);
  if (body?.workingHours !== undefined) v.workingHours = String(body.workingHours || '').slice(0, 300);
  if (body?.notes !== undefined) v.notes = String(body.notes || '').slice(0, 1000);
  if (body?.active !== undefined) v.active = body.active !== false;
  return { value: v };
}

router.get('/admin/doctors', requireAdmin, (req, res) => {
  const list = (store.data.doctors || []).map((d) => publicDoctor(d, { includePhone: true }));
  res.json({ doctors: list, count: list.length });
});

router.post('/admin/doctors', requireAdmin, (req, res) => {
  const checked = validateDoctorBody(req.body);
  if (checked.error) return bad(res, 400, checked.error);
  const d = { id: newId('doc'), ...checked.value, active: checked.value.active !== false, createdAt: nowIso() };
  store.data.doctors.push(d);
  store.audit('admin.doctor_added', 'admin', { doctorId: d.id, name: d.name, specialty: d.specialty });
  store.save();
  res.status(201).json(publicDoctor(d, { includePhone: true }));
});

router.get('/admin/doctors/:id', requireAdmin, (req, res) => {
  const d = (store.data.doctors || []).find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found', message: 'Doctor not found.' });
  res.json(publicDoctor(d, { includePhone: true }));
});

router.put('/admin/doctors/:id', requireAdmin, (req, res) => {
  const d = (store.data.doctors || []).find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found', message: 'Doctor not found.' });
  const checked = validateDoctorBody(req.body, { partial: true });
  if (checked.error) return bad(res, 400, checked.error);
  Object.assign(d, checked.value);
  store.audit('admin.doctor_updated', 'admin', { doctorId: d.id, fields: Object.keys(checked.value) });
  store.save();
  res.json(publicDoctor(d, { includePhone: true }));
});

router.delete('/admin/doctors/:id', requireAdmin, (req, res) => {
  const list = store.data.doctors || [];
  const i = list.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not_found', message: 'Doctor not found.' });
  const [d] = list.splice(i, 1);
  // Referrals already recorded keep their snapshot (name/specialty/phone
  // stored on the referral), so deleting a doctor never rewrites history.
  store.audit('admin.doctor_deleted', 'admin', { doctorId: d.id, name: d.name });
  store.save();
  res.json({ ok: true, deletedId: d.id });
});

// Provider-side read only: ACTIVE doctors, phone included (the provider
// needs to call). ?specialty= filters (case-insensitive substring).
// Patients get 403 here — there is no patient-facing doctors endpoint.
router.get('/providers/doctors', requireAuth, requireRole('provider'), (req, res) => {
  const q = String(req.query.specialty || '').trim().toLowerCase();
  let list = (store.data.doctors || []).filter((d) => d.active !== false);
  if (q) list = list.filter((d) => String(d.specialty || '').toLowerCase().includes(q));
  list = list.map((d) => publicDoctor(d, { includePhone: true }));
  res.json({ doctors: list, count: list.length });
});

// "إحالة لطبيب" — the assigned provider refers a booking to a doctor.
// The referral (with a doctor snapshot) is stored on the booking and
// audit-logged. The doctor's phone is visible to the assigned provider
// and admin only — publicBooking strips it for patient viewers.
router.post('/bookings/:id/refer-doctor', requireAuth, requireRole('provider'), (req, res) => {
  const b = loadBooking(req, res);
  if (!b) return;
  if (b.providerId !== req.user.providerId) return res.status(403).json({ error: 'forbidden', message: 'Not your booking.' });
  if (!['accepted', 'provider_confirmed', 'patient_confirmed', 'reviewed'].includes(b.status)) {
    return bad(res, 409, `Cannot refer a doctor while status is ${b.status}.`);
  }
  const doctorId = String(req.body?.doctorId || '');
  const d = (store.data.doctors || []).find((x) => x.id === doctorId);
  if (!d) return res.status(404).json({ error: 'not_found', message: 'Doctor not found.' });
  if (d.active === false) return res.status(409).json({ error: 'doctor_inactive', message: 'This doctor is inactive.' });
  const referral = {
    id: newId('ref'), doctorId: d.id, doctorName: d.name, specialty: d.specialty,
    phone: d.phone, clinic: d.clinic || null,
    note: String(req.body?.note || '').slice(0, 500) || null,
    at: nowIso(), by: req.user.phone,
  };
  b.referrals = b.referrals || [];
  b.referrals.push(referral);
  store.audit('booking.doctor_referred', req.user.phone, { bookingId: b.id, doctorId: d.id, doctorName: d.name, specialty: d.specialty });
  store.save();
  res.status(201).json({ ok: true, referral, booking: pubBooking(req, b, { includePaymentNumber: true }) });
});

// ---------------------------------------------------------------- tourist bookings
router.post('/tourist-bookings', requireAuth, requireRole('patient'), (req, res) => {
  const b = normalizeBookingBody(req.body);
  if (b.respectCharterAccepted !== true) return bad(res, 400, 'Respect charter must be accepted (respectCharterAccepted=true).');
  // v2.0.8 — Terms & Conditions are mandatory for every booking type.
  if (!termsAccepted(req.body)) return termsError(res);
  const vErrT = validateBookingInput(b) || validatePreferredProvider(b);
  if (vErrT) return res.status(vErrT.status).json({ error: vErrT.error, message: vErrT.message });
  const svc = cat.TOURIST_SERVICES[b.serviceCode];
  if (!svc) return bad(res, 400, 'Valid tourist serviceCode required (tourist_doctor, tourist_iv, tourist_dressing, tourist_nurse).');
  if (isReservedId(b.serviceCode)) return bad(res, 400, 'Valid tourist serviceCode required.');
  const currency = (b.currency || 'usd').toLowerCase();
  if (!['usd', 'eur'].includes(currency)) return bad(res, 400, 'currency must be usd or eur.');
  if (!['cash_receipt', 'instapay', 'card'].includes(b.paymentMethod)) return bad(res, 400, 'paymentMethod must be cash_receipt, instapay or card.');
  if (!b.patientName) return bad(res, 400, 'patientName required.');
  const triage = b.triage || {};
  const danger = Array.isArray(triage.dangerSigns) ? triage.dangerSigns.filter((x) => cat.DANGER_SIGNS.includes(x)) : [];
  if (triageRejects(triage)) {
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
  // v2.1.2 — receipt photo for online payment (InstaPay / card); cash
  // bookings reject a receipt image (receipt at the visit instead).
  const receiptParsedTourist = receiptFromBody(req.body, b.paymentMethod);
  if (receiptParsedTourist.error) return bad(res, 400, receiptParsedTourist.error);
  // v2.1.6 (C6): online payment without a receipt is rejected here.
  const receiptErrTourist = receiptRequiredError(b.paymentMethod, receiptParsedTourist);
  if (receiptErrTourist) return bad(res, 400, receiptErrTourist);
  const id = newId('bk');
  // v2.0.9 — loyalty voucher (50 EGP, converted at this booking's fx rate).
  // Provider share is computed on the FULL pre-discount price at release.
  const vou = findVoucher(req.user.phone, amountEgp);
  const voucherDiscountForeign = vou ? Math.round((vou.amountEgp / fx) * 100) / 100 : 0;
  const booking = {
    id, kind: 'tourist', patientPhone: req.user.phone, patientName: capStr(b.patientName, 120),
    serviceCode: b.serviceCode, serviceName: svc.name_en, status: 'held',
    category: 'nursing', riskLevel: svc.riskLevel || 'standard',
    preferredProviderId: b.preferredProviderId || null,
    night: isNight(b.scheduledAt),
    amountEgp, baseEgp: Math.round(base * fx), distanceFeeEgp: fee.fee_egp,
    voucherId: vou ? vou.id : null, voucherDiscountEgp: vou ? vou.amountEgp : 0,
    voucherDiscountForeign, amountPayableEgp: vou ? amountEgp - vou.amountEgp : amountEgp,
    distanceKm, distanceBand: fee.band, distanceEstimate: true,
    transport: b.transport || 'none', hotelId: b.hotelId || null,
    currency: currency.toUpperCase(),
    // amountForeign is what the patient actually pays (after any voucher).
    amountForeign: Math.round((amountForeign - voucherDiscountForeign) * 100) / 100,
    fxRate: fx, fxNote: 'Approximate rate — override via USD_EGP / EUR_EGP env.',
    urgent: b.urgent === true, language,
    languageBonus: language !== 'en'
      ? { amount: cat.EXTRA_LANGUAGE_BONUS[currency], currency: currency.toUpperCase(), appliesIf: 'Assigned provider holds a certificate for this language (non-English only). Added at release, not at booking.' }
      : null,
    paymentMethod: b.paymentMethod, respectCharterAccepted: true,
    termsAcceptedVersion: config.termsVersion, termsAcceptedAt: nowIso(),
    triage: { dangerSigns: danger, notes: triage.notes || null },
    insurer: b.insurer || null, policyNo: b.policyNo || null, passportNo: b.passportNo ? `****${String(b.passportNo).slice(-4)}` : null,
    nationality: b.nationality || null, diagnosis: b.diagnosis || null,
    address: b.address || null, scheduledAt: b.scheduledAt || null, notes: b.notes || null,
    providerId: null, commissionPct: null, providerShareEgp: null, appShareEgp: null, estimatedProviderShareEgp: null, languageBonusEgp: 0,
    receipt: null,
    vitals: null, review: null, providerReview: null, complaint: false,
    circumventionHold: false, circumventionReportId: null,
    complaintStatus: null, complaintDeadline: null, complaintAt: null, complaintResolvedAt: null,
    settleableAt: null, cancelledAt: null, refundedAt: null, refundEgp: null,
    cashCollectedByProvider: false, overdue: false,
    createdAt: nowIso(), acceptedAt: null, providerConfirmedAt: null,
    patientConfirmedAt: null, reviewedAt: null, releasedAt: null, releaseMode: null,
  };
  attachReceipt(booking, receiptParsedTourist);
  store.data.bookings[id] = booking;
  if (vou) { vou.status = 'used'; vou.usedAt = nowIso(); vou.usedBookingId = id; }
  store.audit('tourist_booking.created', req.user.phone, { bookingId: id, serviceCode: b.serviceCode, amountForeign: booking.amountForeign, currency, voucherId: booking.voucherId, voucherDiscountEgp: booking.voucherDiscountEgp });
  recordTermsAcceptance(req.user.phone);
  store.save();
  res.status(201).json(pubBooking(req, booking));
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
  // v2.0.9 — loyalty-voucher discount (funded by the app; the provider's
  // share was computed on the full pre-discount price).
  if (b.voucherDiscountForeign) items.push({ item: lang === 'de' ? 'Treuegutschein' : 'Loyalty voucher discount', amount: -b.voucherDiscountForeign, currency: cur });
  else if (b.voucherDiscountEgp) items.push({ item: lang === 'de' ? 'Treuegutschein' : 'Loyalty voucher discount', amount: -b.voucherDiscountEgp, currency: cur });
  // v2.1.1 (M4): procedures/medications lines from booking data when
  // present (procedures[] / medications[] on the booking, or the single
  // service as a fallback). No placeholder diagnosis text is invented
  // beyond the neutral "see treatment notes" fallback already used.
  const procedures = Array.isArray(b.procedures) && b.procedures.length
    ? b.procedures.map((x) => ({ service: String(typeof x === 'string' ? x : x.service || x.name || '').slice(0, 200), at: (x && x.at) || b.providerConfirmedAt || b.createdAt }))
    : [{ service: b.serviceName, at: b.providerConfirmedAt || b.createdAt }];
  const medications = Array.isArray(b.medications)
    ? b.medications.map((x) => String(typeof x === 'string' ? x : x.name || '').slice(0, 200)).filter(Boolean)
    : (b.medicationNotes ? [String(b.medicationNotes).slice(0, 500)] : []);
  const report = {
    reportId: `INS-${b.id}`,
    language: lang,
    issuedAt: nowIso(),
    patient: { name: b.patientName, nationality: b.nationality || null, passport: b.passportNo || null, insurer: b.insurer || null, policyNo: b.policyNo || null },
    diagnosis: b.diagnosis || (lang === 'de' ? 'Siehe Behandlungsnotizen' : 'See treatment notes'),
    procedures,
    medications,
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
    // v2.1.1 (audit #13 / L2): EVERY interpolated field is HTML-escaped,
    // and the HTML is served with a strict CSP + nosniff.
    const esc = escapeHtml;
    const medsHtml = report.medications.length ? `<h2>${lang === 'de' ? 'Medikamente' : 'Medications'}</h2><ul>${report.medications.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '';
    const html = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(t.title)} ${esc(report.reportId)}</title></head><body><h1>Shifa Care — ${esc(t.title)}</h1><p>${esc(report.reportId)} · ${esc(report.issuedAt)}</p><h2>${esc(t.patient)}</h2><p>${esc(report.patient.name)}${report.patient.nationality ? ` · ${esc(report.patient.nationality)}` : ''}${report.patient.passport ? ` · Passport ${esc(report.patient.passport)}` : ''}</p><h2>${esc(t.diagnosis)}</h2><p>${esc(report.diagnosis)}</p><h2>${esc(t.procedures)}</h2><ul>${report.procedures.map((x) => `<li>${esc(x.service)}</li>`).join('')}</ul>${medsHtml}<h2>${esc(t.vitals)}</h2><p>${report.vitals ? esc(JSON.stringify(report.vitals)) : '—'}</p><h2>${esc(t.invoice)}</h2><table><tr><th>Item</th><th>Amount</th></tr>${report.invoice.items.map((i) => `<tr><td>${esc(i.item)}</td><td>${esc(i.amount)} ${esc(i.currency)}</td></tr>`).join('')}<tr><td><b>${esc(t.total)}</b></td><td><b>${esc(report.invoice.total)} ${esc(report.invoice.currency)} (${esc(report.invoice.totalEgp)} EGP)</b></td></tr></table><h2>${esc(t.provider)}</h2><p>${report.provider ? `${esc(report.provider.name)} (${esc(report.provider.role)}) — Licence ****${esc(p.licenseLast4)}` : '—'}</p><div><b>${esc(report.stamp.text)}</b><br>${esc(report.stamp.signature)}<br><small>${esc(report.stamp.note)}</small></div></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(html);
  }
  res.json(report);
});

// ---------------------------------------------------------------- NPWT
// Shared calculator (SPEC §3 + §5): real NPWT device with true negative
// pressure ONLY. Dressing every 3 days; 5 dressings in a 14-day course.
// Device rental 750/week or 1,000/15 days; specialist dressing visit 600;
// kit (foam + dressing + tubes) 250–350 at invoice price, per dressing.
// Canister changed separately ONLY when full.
function calculateNpwt(body) {
  const days = Number(body?.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) return { error: 'days must be an integer 1–90.' };
  const kitPrice = body?.kitPrice == null ? 300 : Number(body.kitPrice);
  if (!Number.isFinite(kitPrice) || kitPrice < 250 || kitPrice > 350) return { error: 'kitPrice must be 250–350 EGP (invoice price).' };
  const dressings = Math.ceil(days / 3);
  const visitCost = dressings * 600; // specialist dressing visit
  const kitCost = dressings * kitPrice; // kit per dressing
  let rental;
  if (days <= 7) rental = 750;
  else if (days <= 15) rental = 1000;
  else rental = 1000 + 750 * Math.ceil((days - 15) / 7);
  const canisterFull = body?.canisterFull === true;
  const canisterPrice = canisterFull ? Number(body?.canisterPrice || 0) : 0;
  if (canisterFull && (!Number.isFinite(canisterPrice) || canisterPrice < 0)) return { error: 'canisterPrice must be a non-negative number when canisterFull=true.' };
  return {
    days, dressings, schedule: 'Dressing every 3 days',
    breakdown: {
      deviceRentalEgp: rental, rentalRule: days <= 7 ? '750/week' : days <= 15 ? '1000/15 days' : '1000/15 days + 750 per extra week',
      visitsEgp: visitCost, visitUnitEgp: 600, visits: dressings,
      kitsEgp: kitCost, kitUnitEgp: kitPrice, kits: dressings,
      canisterEgp: canisterPrice, canisterNote: canisterFull ? 'Canister replaced because full — charged separately.' : 'Canister changed separately ONLY when full.',
    },
    totalEgp: rental + visitCost + kitCost + canisterPrice,
  };
}

router.post('/npwt/calculate', requireAuth, (req, res) => {
  const calc = calculateNpwt(req.body);
  if (calc.error) return bad(res, 400, calc.error);
  res.json({
    ...calc,
    reference: 'A single full dressing ≈ 1,100 EGP; a full 14-day course (5 dressings) ≈ 5,250–6,250 EGP.',
    requiresDoctorOrder: true,
    doctorOrderProvided: req.body?.doctorOrderProvided === true,
    warning: req.body?.doctorOrderProvided === true ? null : 'A written doctor order (doctor name + order number) is required before starting NPWT, plus the safety checklist (foam count in/out, bleeding check, canister status) and a wound photo at every visit. Real NPWT device with true negative pressure only.',
  });
});

// v2.1.0 — real NPWT booking (was calculator-only in the app).
// HIGH-risk service: a written doctor order is REQUIRED (doctor name +
// order number), and the NPWT safety checklist must be attested at
// booking (foam count in/out, bleeding check, canister status, wound
// photo to be provided at the first visit). The provider must ALSO
// complete the generic high-risk safety checklist before finishing the
// visit (see complete-provider) — the booking-time checklist is the
// NPWT-specific one, not a substitute.
// Pricing = NPWT total (calculator above) + the standard distance fee.
// The loyalty voucher applies like any other booking (amount >= 300).
router.post('/npwt/bookings', requireAuth, (req, res) => {
  const b = normalizeBookingBody(req.body);
  const vErrN = validateBookingInput(b) || validatePreferredProvider(b);
  if (vErrN) return res.status(vErrN.status).json({ error: vErrN.error, message: vErrN.message });
  if (b.respectCharterAccepted !== true) return bad(res, 400, 'Respect charter must be accepted (respectCharterAccepted=true).');
  // v2.0.8 — Terms & Conditions are mandatory for every booking type.
  if (!termsAccepted(req.body)) return termsError(res);
  if (!b.patientName || typeof b.patientName !== 'string') return bad(res, 400, 'patientName required.');
  if (!['cash_receipt', 'instapay'].includes(b.paymentMethod)) return bad(res, 400, 'paymentMethod must be cash_receipt or instapay.');
  const calc = calculateNpwt(req.body);
  if (calc.error) return bad(res, 400, calc.error);
  // v2.1.1 — explicit written consent (NPWT is high-risk; same gate,
  // same consentGiven field as POST /bookings).
  if (requireHighRiskConsent(req, res, 'npwt')) return;
  // Doctor's order — REQUIRED (high-risk gate, same as suture removal).
  const doctorOrder = b.doctorOrder && typeof b.doctorOrder === 'object' ? b.doctorOrder : null;
  if (!doctorOrder || !String(doctorOrder.doctorName || '').trim() || !String(doctorOrder.orderNumber || '').trim()) {
    return bad(res, 400, 'NPWT requires a written doctor order (ordering doctor name + order number). No order = no booking.');
  }
  // NPWT safety checklist — all four attestations required at booking.
  const sc = req.body?.safetyChecklist || {};
  const npwtChecklist = ['foamCountConfirmed', 'bleedingChecked', 'canisterChecked', 'woundPhotoConfirmed'];
  const missing = npwtChecklist.filter((k) => sc[k] !== true);
  if (missing.length) {
    return bad(res, 400, `NPWT safety checklist incomplete (missing: ${missing.join(', ')}). Foam count in/out, bleeding check, canister status and a wound photo at the first visit are all required.`, { required: npwtChecklist, missing });
  }
  const triage = b.triage || {};
  const danger = Array.isArray(triage.dangerSigns) ? triage.dangerSigns.filter((x) => cat.DANGER_SIGNS.includes(x)) : [];
  if (triageRejects(triage)) {
    store.audit('booking.triage_rejected', req.user.phone, { danger });
    return res.status(422).json({
      error: 'emergency_triage',
      message: 'Danger sign detected. Do NOT book a home visit — call the ambulance now.',
      ambulance: '123', danger_signs: danger,
    });
  }
  const priced = priceBooking({ serviceCode: 'standard', distanceKm: b.distanceKm, hotelId: b.hotelId, transport: b.transport });
  if (priced.error === 'distance_required') return res.status(400).json({ error: 'distance_required', message: 'distanceKm or hotelId is required — the distance cannot be assumed to be 0.' });
  if (priced.error) return bad(res, 400, priced.error);
  if (priced.contract_required) return res.status(422).json({ error: 'contract_required', ...priced });
  // priceBooking with 'standard' prices the DISTANCE FEE only here (its
  // base is discarded): NPWT total + distance fee.
  const distanceFeeEgp = priced.distanceFeeEgp;
  const totalEgp = calc.totalEgp + distanceFeeEgp;
  // v2.1.2 — receipt photo for online payment (InstaPay); cash rejects it.
  const receiptParsedNpwt = receiptFromBody(req.body, b.paymentMethod);
  if (receiptParsedNpwt.error) return bad(res, 400, receiptParsedNpwt.error);
  // v2.1.6 (C6): online payment without a receipt is rejected here.
  const receiptErrNpwt = receiptRequiredError(b.paymentMethod, receiptParsedNpwt);
  if (receiptErrNpwt) return bad(res, 400, receiptErrNpwt);
  const id = newId('bk');
  const vou = findVoucher(req.user.phone, totalEgp);
  const booking = {
    id, kind: 'npwt', patientPhone: req.user.phone, patientName: capStr(b.patientName, 120),
    serviceCode: 'npwt', serviceName: 'NPWT — vacuum-assisted closure (real device only)', status: 'held',
    category: 'nursing', riskLevel: 'high',
    preferredProviderId: b.preferredProviderId || null,
    night: isNight(b.scheduledAt),
    amountEgp: totalEgp, baseEgp: calc.totalEgp, distanceFeeEgp,
    voucherId: vou ? vou.id : null, voucherDiscountEgp: vou ? vou.amountEgp : 0,
    amountPayableEgp: vou ? totalEgp - vou.amountEgp : totalEgp,
    distanceKm: priced.distanceKm, distanceBand: priced.band, distanceEstimate: true,
    transport: b.transport || 'none', hotelId: b.hotelId || null,
    currency: 'EGP', amountForeign: null, fxRate: null,
    paymentMethod: b.paymentMethod, respectCharterAccepted: true,
    termsAcceptedVersion: config.termsVersion, termsAcceptedAt: nowIso(),
    doctorOrder: { doctorName: String(doctorOrder.doctorName).trim().slice(0, 120), orderNumber: String(doctorOrder.orderNumber).trim().slice(0, 80) },
    doctorOrderConfirmed: true, doctorOrderSeenByProvider: false,
    // v2.1.1 — explicit written consent (NPWT is high-risk).
    consent: { given: true, at: nowIso(), version: '1.0' },
    npwt: {
      days: calc.days, dressings: calc.dressings,
      doctorOrder: { doctorName: String(doctorOrder.doctorName).trim().slice(0, 120), orderNumber: String(doctorOrder.orderNumber).trim().slice(0, 80) },
      safetyChecklist: { foamCountConfirmed: true, bleedingChecked: true, canisterChecked: true, woundPhotoConfirmed: true },
      breakdown: calc.breakdown,
    },
    triage: { dangerSigns: danger, notes: triage.notes || null },
    address: b.address || null, scheduledAt: b.scheduledAt || null, notes: b.notes || null,
    alternateContact: b.alternateContact || null,
    providerId: null, commissionPct: null, providerShareEgp: null, appShareEgp: null,
    vitals: null, review: null, providerReview: null, complaint: false,
    circumventionHold: false, circumventionReportId: null,
    complaintStatus: null, complaintDeadline: null, complaintAt: null, complaintResolvedAt: null,
    settleableAt: null, cancelledAt: null, refundedAt: null, refundEgp: null,
    cashCollectedByProvider: false, overdue: false,
    createdAt: nowIso(), acceptedAt: null, providerConfirmedAt: null,
    patientConfirmedAt: null, reviewedAt: null, releasedAt: null, releaseMode: null,
  };
  attachReceipt(booking, receiptParsedNpwt);
  store.data.bookings[id] = booking;
  if (vou) { vou.status = 'used'; vou.usedAt = nowIso(); vou.usedBookingId = id; }
  store.audit('npwt_booking.created', req.user.phone, { bookingId: id, days: calc.days, dressings: calc.dressings, totalEgp, voucherId: booking.voucherId, voucherDiscountEgp: booking.voucherDiscountEgp });
  store.audit('booking.high_risk_consent', req.user.phone, { bookingId: id, serviceCode: 'npwt' });
  recordTermsAcceptance(req.user.phone);
  store.save();
  res.status(201).json(pubBooking(req, booking));
});

// ---------------------------------------------------------------- post-op
router.post('/postop', requireAuth, requireRole('patient'), (req, res) => {
  const b = normalizeBookingBody(req.body);
  const vErrP = validateBookingInput(b) || validatePreferredProvider(b);
  if (vErrP) return res.status(vErrP.status).json({ error: vErrP.error, message: vErrP.message });
  if (b.respectCharterAccepted !== true) return bad(res, 400, 'Respect charter must be accepted (respectCharterAccepted=true).');
  // v2.0.8 — Terms & Conditions are mandatory for every booking type.
  if (!termsAccepted(req.body)) return termsError(res);
  if (!b.patientName) return bad(res, 400, 'patientName required.');
  if (!b.surgeryType) return bad(res, 400, 'surgeryType required.');
  if (!['cash_receipt', 'instapay'].includes(b.paymentMethod)) return bad(res, 400, 'paymentMethod must be cash_receipt or instapay.');
  const priced = priceBooking({ serviceCode: 'postop', distanceKm: b.distanceKm, hotelId: b.hotelId, transport: b.transport });
  if (priced.error === 'distance_required') return res.status(400).json({ error: 'distance_required', message: 'distanceKm or hotelId is required — the distance cannot be assumed to be 0.' });
  if (priced.error) return bad(res, 400, priced.error);
  if (priced.contract_required) return res.status(422).json({ error: 'contract_required', ...priced });
  // v2.1.2 — receipt photo for online payment (InstaPay); cash rejects it.
  const receiptParsedPostop = receiptFromBody(req.body, b.paymentMethod);
  if (receiptParsedPostop.error) return bad(res, 400, receiptParsedPostop.error);
  // v2.1.6 (C6): online payment without a receipt is rejected here.
  const receiptErrPostop = receiptRequiredError(b.paymentMethod, receiptParsedPostop);
  if (receiptErrPostop) return bad(res, 400, receiptErrPostop);
  const id = newId('bk');
  // v2.0.9 — loyalty voucher (same rule as standard bookings).
  const vou = findVoucher(req.user.phone, priced.totalEgp);
  const booking = {
    id, kind: 'postop', patientPhone: req.user.phone, patientName: capStr(b.patientName, 120),
    serviceCode: 'postop', serviceName: cat.SERVICES.postop.name_en, status: 'held',
    category: 'nursing', riskLevel: 'standard',
    preferredProviderId: b.preferredProviderId || null,
    night: isNight(b.scheduledAt),
    amountEgp: priced.totalEgp, baseEgp: priced.baseEgp, distanceFeeEgp: priced.distanceFeeEgp,
    voucherId: vou ? vou.id : null, voucherDiscountEgp: vou ? vou.amountEgp : 0,
    amountPayableEgp: vou ? priced.totalEgp - vou.amountEgp : priced.totalEgp,
    distanceKm: priced.distanceKm, distanceBand: priced.band, distanceEstimate: true,
    transport: b.transport || 'none', hotelId: b.hotelId || null,
    currency: 'EGP', amountForeign: null, fxRate: null,
    paymentMethod: b.paymentMethod, respectCharterAccepted: true,
    termsAcceptedVersion: config.termsVersion, termsAcceptedAt: nowIso(),
    triage: { dangerSigns: [], notes: null },
    surgeryType: b.surgeryType, surgeonInstructions: b.surgeonInstructions || null,
    dressingSchedule: b.dressingSchedule || null, drainNotes: b.drainNotes || null,
    address: b.address || null, scheduledAt: b.scheduledAt || null, notes: b.notes || null,
    providerId: null, commissionPct: null, providerShareEgp: null, appShareEgp: null,
    vitals: null, review: null, providerReview: null, complaint: false,
    circumventionHold: false, circumventionReportId: null,
    complaintStatus: null, complaintDeadline: null, complaintAt: null, complaintResolvedAt: null,
    settleableAt: null, cancelledAt: null, refundedAt: null, refundEgp: null,
    cashCollectedByProvider: false, overdue: false,
    createdAt: nowIso(), acceptedAt: null, providerConfirmedAt: null,
    patientConfirmedAt: null, reviewedAt: null, releasedAt: null, releaseMode: null,
  };
  attachReceipt(booking, receiptParsedPostop);
  store.data.bookings[id] = booking;
  if (vou) { vou.status = 'used'; vou.usedAt = nowIso(); vou.usedBookingId = id; }
  store.audit('postop.created', req.user.phone, { bookingId: id, surgeryType: b.surgeryType, totalEgp: booking.amountEgp, voucherId: booking.voucherId, voucherDiscountEgp: booking.voucherDiscountEgp });
  recordTermsAcceptance(req.user.phone);
  store.save();
  res.status(201).json(pubBooking(req, booking));
});

// ---------------------------------------------------------------- admin
router.post('/admin/pin/verify', (req, res) => {
  const pin = String(req.body?.pin || '');
  const rec = store.data.adminPin;
  // v2.1.1 (audit #16): lockout is PER-IP (a global lockout let any IP
  // lock out the real admin). Errors are generic — no attemptsLeft or
  // lockedUntil in responses (M12).
  const ip = req.ip || 'unknown';
  const attempts = store.data.adminPinAttempts || (store.data.adminPinAttempts = {});
  const ipRec = attempts[ip] || (attempts[ip] = { failures: 0, lockedUntil: null });
  if (ipRec.lockedUntil && new Date(ipRec.lockedUntil).getTime() > Date.now()) {
    return res.status(423).json({ error: 'locked', message: 'Admin PIN is temporarily locked. Try again later.' });
  }
  if (!/^\d{6,}$/.test(pin) || !bcrypt.compareSync(pin, rec.hash)) {
    ipRec.failures = (ipRec.failures || 0) + 1;
    if (ipRec.failures >= config.adminPinMaxAttempts) {
      ipRec.lockedUntil = new Date(Date.now() + config.adminPinLockMinutes * 60 * 1000).toISOString();
      ipRec.failures = 0;
      store.audit('admin.pin_locked', ip, { attempts: config.adminPinMaxAttempts }, ip);
    } else {
      store.audit('admin.pin_failed', ip, { failures: ipRec.failures }, ip);
    }
    store.save();
    return res.status(401).json({ error: 'unauthorized', message: 'Wrong admin PIN.' });
  }
  ipRec.failures = 0;
  ipRec.lockedUntil = null;
  store.save();
  store.audit('admin.pin_verified', 'admin', {}, ip);
  res.json({ ok: true, token: issueAdminToken(), expiresInSeconds: 30 * 60, role: 'admin' });
});

router.get('/admin/dashboard', requireAdmin, (req, res) => {
  // Aggregate view the web frontend expects, with its field names.
  const providers = Object.values(store.data.providers).map((p) => {
    const pub = store.publicProvider(p, { admin: true });
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
  // v2.0.8 — circumvention reports ("تقرير التفاف") + pattern flags,
  // shown in the admin dashboard next to SOS / complaints.
  const circumventionReports = (store.data.circumventionReports || []).slice().reverse().map((r) => ({ ...r, createdAt: r.at }));
  // v2.0.9 — active promo-month override + promo months used this year.
  const promoNow = activePromo();
  // v2.1.0 — Quseir doctors directory (admin sees phone numbers; the
  // provider list is read-only and patient-side never sees them).
  const doctors = (store.data.doctors || []).map((d) => publicDoctor(d, { includePhone: true }));
  res.json({ providers, sosAlerts, lateVisits: overdue, bookings, auditLog, circumventionReports, circumventionFlags: circumventionFlags(),
    promo: promoNow ? { active: true, commissionPct: promoNow.commissionPct, until: promoNow.until || null, source: promoNow.source } : { active: false, commissionPct: null, until: null },
    promoMonthsUsed: store.data.promoMonths || {},
    // v2.1.4 — launch-month shift offer state (default OFF until launch).
    launchOffer: (() => { const lo = activeLaunchOffer(); return lo ? { active: true, until: lo.until || null, setAt: lo.setAt || null } : { active: false, until: null }; })(),
    doctors, doctorsCount: doctors.length,
    medicalFileInterestCount: (store.data.medicalFileInterest || {}).count || 0,
    settlementsCount: (store.data.settlements || []).length,
    // v2.1.2 — review queue + receipts awaiting review.
    pendingApplicationsCount: Object.values(store.data.providers).filter((p) => p.status === 'pending').length,
    pendingReceipts: Object.values(store.data.bookings).filter((b) => b.receipt && b.receipt.status === 'pending').map((b) => ({ id: b.id, status: b.status, serviceName: b.serviceName, amountEgp: b.amountEgp, createdAt: b.createdAt })),
    // v2.1.3 — monthly package requests (admin queue) + package bookings
    // + the launch-offer flag state. Requests carry the patient phone
    // (admin-only endpoint — the admin needs it to contact the patient).
    packageRequests: (store.data.packageRequests || []).slice().reverse(),
    packageBookings: Object.values(store.data.bookings).filter((b) => b.kind === 'package').slice().reverse().map((b) => ({
      id: b.id, packageType: b.packageType, level: b.level || null, currency: b.currency || 'EGP', status: b.status, total: b.amountEgp,
      amountForeign: b.amountForeign || null, totalEgp: b.amountEgp,
      startDate: b.startDate, endDate: b.endDate, daysCompleted: b.daysCompleted || 0,
      extraDaysCompleted: b.extraDaysCompleted || 0, providerId: b.providerId,
      substituteProviderId: b.substituteProviderId || null, createdAt: b.createdAt,
    })),
    packageOffer: store.data.packageOffer || null,
    packageOvertimePremiumWaived: packageOvertimePremiumWaived(),
    // v2.1.5 — broadcast audience: total registered FCM tokens, and how
    // many distinct phones have at least one device. No tokens or phone
    // numbers are ever returned.
    // v2.1.10 — broadcastUsers used to count ONLY phones with a registered
    // FCM device, so the tab showed 0/0 even when user accounts existed
    // (the send audience is accounts + devices). It now counts the true
    // audience — distinct phones with an account OR a device — the same
    // number the broadcast dry-run reports as `users`. broadcastAccounts
    // is the registered-account count, shown separately so the tab labels
    // all three numbers honestly.
    broadcastDevices: Object.values(store.data.devices || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0),
    broadcastAccounts: Object.keys(store.data.users || {}).length,
    broadcastUsers: new Set([...Object.keys(store.data.users || {}), ...Object.keys(store.data.devices || {})]).size,
    // v2.1.6 — C8 anomaly flags (fake-visit farming signals) + C7
    // package bulk-review queue + C1 new-device logins. Phones are
    // shown here (admin-only endpoint) so the admin can act on them.
    anomalyFlags: anomalyFlags(),
    packageReviewRequired: Object.values(store.data.bookings).filter((b) => b.kind === 'package' && b.packageReviewRequired).map((b) => ({
      id: b.id, providerId: b.providerId, status: b.status, reason: b.packageReviewReason || null,
      daysLogged: (b.daysLog || []).length, daysConfirmed: (b.daysLog || []).filter((d) => d.patientConfirmed).length,
      createdAt: b.createdAt,
    })),
    newDeviceLogins: (store.data.audit || []).filter((a) => a.action === 'auth.phone_login_new_device').slice(-20).reverse().map((a) => ({
      phone: a.actor, at: a.ts, deviceId: a.details?.deviceId || null, role: a.details?.role || null,
    })),
  });
});

// v2.1.5 — admin broadcast: one message to every user (in-app record +
// FCM push, never SMS — the notification is non-critical). dryRun=true
// only counts the audience: it sends nothing, stores nothing and
// audits nothing. FCM tokens and phone numbers are never returned.
router.post('/admin/broadcast', requireAdmin, async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!title || !body) return bad(res, 400, 'title and body are required.');
  if (title.length > 100) return bad(res, 400, 'title must be at most 100 characters.');
  if (body.length > 500) return bad(res, 400, 'body must be at most 500 characters.');
  const users = store.data.users || {};
  const devices = store.data.devices || {};
  const phones = new Set([...Object.keys(users), ...Object.keys(devices)]);
  const deviceCount = Object.values(devices).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  if (req.body?.dryRun === true) {
    return res.json({ ok: true, dryRun: true, devices: deviceCount, users: phones.size });
  }
  let sent = 0, failed = 0;
  for (const phone of phones) {
    const rec = await notify.notifyUser(phone, {
      type: 'broadcast', titleAr: title, titleEn: title, bodyAr: body, bodyEn: body,
      data: { type: 'broadcast' }, critical: false,
    });
    if (rec.pushStatus === 'sent') sent += 1; else failed += 1;
  }
  store.audit('admin.broadcast', 'admin', { title, devices: deviceCount, users: phones.size, sent, failed });
  res.json({ ok: true, dryRun: false, devices: deviceCount, users: phones.size, sent, failed });
});

// ---------------------------------------------------------------- v2.1.8
// POST /api/admin/password-reset { phone } — admin-only reset for users
// who forgot their password (no OTP channel exists yet, so there is no
// self-service reset). The admin tells the user the temporary password
// once (by phone/WhatsApp); the user MUST choose their own password on
// next login (mustChangePassword) and all of the account's live
// sessions are revoked. The temp password is returned ONLY in this one
// response — it is NEVER stored (only its bcrypt hash) and NEVER
// appears in the audit log (audit: admin.password_reset, phone only).
router.post('/admin/password-reset', requireAdmin, (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return bad(res, 400, 'Valid Egyptian phone number required (01xxxxxxxxx).');
  const userRec = store.data.users[phone];
  if (!userRec) return res.status(404).json({ error: 'not_found', message: 'No account with this phone number.' });
  const hadPassword = typeof userRec.passwordHash === 'string' && !!userRec.passwordHash;
  const tempPassword = generateTempPassword();
  userRec.passwordHash = hashPassword(tempPassword);
  userRec.passwordSetAt = nowIso();
  userRec.mustChangePassword = true;
  const sessionsRevoked = revokeUserRefreshTokens(phone);
  store.audit('admin.password_reset', 'admin', { phone, hadPassword, sessionsRevoked });
  store.save();
  res.json({ ok: true, phone, tempPassword, hadPassword, sessionsRevoked, mustChangePassword: true });
});

// v2.1.0 — persistence status (admin only): which backend holds the data
// and whether the Postgres fallback is active. No URLs or secrets here.
router.get('/admin/persistence', requireAdmin, (req, res) => {
  res.json({
    persistence: store.persistence,
    postgresConfigured: config.postgresConfigured(),
    postgresError: store.postgresError || null,
    note: store.persistence === 'postgres'
      ? 'Data lives in Postgres and survives redeploys.'
      : 'Data lives in the local data.json file and is WIPED on every redeploy. Add a Postgres service in Railway + DATABASE_URL to make it persistent.',
  });
});

router.get('/admin/settlements', requireAdmin, (req, res) => {
  const list = (store.data.settlements || []).slice().reverse();
  const providerId = req.query.providerId;
  res.json({ settlements: providerId ? list.filter((x) => x.providerId === providerId) : list, count: list.length });
});

// v2.1.1 (audit #4): full data.json download for backup (admin JWT,
// rate-limited in app.js). Postgres stays disabled — this is the
// backup mitigation for the file store.
router.get('/admin/export', requireAdmin, (req, res) => {
  store.audit('admin.export', 'admin', {});
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="shifa-care-data.json"');
  res.send(JSON.stringify(store.data, null, 2));
});

router.get('/admin/providers', requireAdmin, (req, res) => {
  res.json(Object.values(store.data.providers).map((p) => store.publicProvider(p, { admin: true })));
});

router.post('/admin/providers/:id/tier', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const tier = req.body?.tier;
  if (typeof tier !== 'string' || !Object.hasOwn(cat.TIERS, tier)) return bad(res, 400, 'tier must be Starter, Pro or Elite.');
  const old = p.tier;
  p.tier = tier;
  store.audit('admin.tier_changed', 'admin', { providerId: p.id, from: old, to: tier });
  store.save();
  res.json(store.publicProvider(p, { admin: true }));
});

router.post('/admin/providers/:id/verify', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  if (isReservedId(req.params.id)) return res.status(400).json({ error: 'validation_error', message: 'Invalid identifier.' });
  const verifiedCertificates = Number(req.body?.verifiedCertificates);
  if (Number.isFinite(verifiedCertificates)) {
    p.verifiedCertificates = Math.max(0, Math.min(3, Math.floor(verifiedCertificates))); // +5 pts each, max 15
  }
  // v2.1.1 (audit #29): the admin sets the VERIFIED role — the role is
  // no longer purely self-selected at registration.
  if (req.body?.role) {
    if (!['assistant', 'nurse', 'doctor', 'physio'].includes(req.body.role)) return bad(res, 400, 'role must be assistant, nurse, doctor or physio.');
    p.role = req.body.role;
    p.providerType = req.body.role;
  }
  if (req.body?.providerType) {
    if (!['assistant', 'nurse', 'doctor', 'physio'].includes(req.body.providerType)) return bad(res, 400, 'providerType must be assistant, nurse, doctor or physio.');
    p.providerType = req.body.providerType;
    p.role = req.body.providerType;
  }
  p.status = 'verified';
  p.roleVerified = true;
  recomputeProviderPoints(p);
  refreshCvEvaluation(p);
  store.audit('admin.provider_verified', 'admin', { providerId: p.id, verifiedCertificates: p.verifiedCertificates, role: p.role });
  store.save();
  res.json(store.publicProvider(p, { admin: true, points: p.points }));
});

// v2.1.1 — admin interview decision (manual-review pass/fail, or allow a
// retake after a red-flag / exhausted attempts).
router.post('/admin/providers/:id/interview', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const decision = req.body?.decision;
  if (!['pass', 'fail', 'allow-retake'].includes(decision)) return bad(res, 400, "decision must be pass, fail or allow-retake.");
  if (decision === 'pass') {
    if (p.interviewStatus !== 'manual-review') return bad(res, 409, 'Only a manual-review interview can be passed by admin.');
    p.interviewStatus = 'passed';
    p.interviewPoints = cat.POINTS.interview.manualReviewPts; // 10
    p.canRetakeAt = null;
    recomputeProviderPoints(p);
    store.audit('admin.interview_passed', 'admin', { providerId: p.id, interviewPoints: p.interviewPoints });
  } else if (decision === 'fail') {
    p.interviewStatus = 'failed';
    p.interviewPoints = 0;
    p.canRetakeAt = new Date(Date.now() + config.interviewRetakeDays * 24 * 60 * 60 * 1000).toISOString();
    store.audit('admin.interview_failed', 'admin', { providerId: p.id });
  } else {
    // allow-retake: clears the cooldown AND the red-flag approval gate.
    p.canRetakeAt = null;
    p.redFlagApprovalRequired = false;
    p.redFlagRetakeAllowed = true;
    store.audit('admin.interview_retake_allowed', 'admin', { providerId: p.id });
  }
  store.save();
  res.json(store.publicProvider(p, { admin: true, points: p.points }));
});

// v2.1.1 — admin credentials: append a certificate / course / language
// entry (unverified until verified below), and verify one by index.
router.post('/admin/providers/:id/credentials', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const kind = req.body?.kind;
  if (!['certificate', 'course', 'language'].includes(kind)) return bad(res, 400, "kind must be certificate, course or language.");
  const name = String(req.body?.name || '').trim().slice(0, 200);
  if (!name) return bad(res, 400, 'name required.');
  const verified = req.body?.verified === true;
  if (kind === 'certificate') {
    p.certificates = p.certificates || [];
    p.certificates.push({ name, verified });
  } else if (kind === 'course') {
    p.courses = p.courses || [];
    p.courses.push({ name, verified });
  } else {
    const language = String(req.body?.language || '').trim().toLowerCase().slice(0, 10);
    if (!language) return bad(res, 400, 'language required for a language certificate.');
    p.languageCertificates = p.languageCertificates || [];
    p.languageCertificates.push({ language, certificateName: name, verified });
  }
  recomputeProviderPoints(p);
  refreshCvEvaluation(p);
  store.audit('admin.credential_added', 'admin', { providerId: p.id, kind, name, verified });
  store.save();
  res.status(201).json(store.publicProvider(p, { admin: true, points: p.points }));
});

router.post('/admin/providers/:id/credentials/:index/verify', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const idx = Number(req.params.index);
  if (!Number.isInteger(idx) || idx < 0) return bad(res, 400, 'index must be a non-negative integer.');
  // The kind is inferred from the index across the three arrays in
  // order: certificates, then courses, then languageCertificates — OR
  // pass ?kind=certificate|course|language to target one array.
  const kind = req.query.kind || req.body?.kind;
  let arr;
  if (kind === 'certificate') arr = p.certificates || [];
  else if (kind === 'course') arr = p.courses || [];
  else if (kind === 'language') arr = p.languageCertificates || [];
  else arr = [...(p.certificates || []), ...(p.courses || []), ...(p.languageCertificates || [])];
  const entry = arr[idx];
  if (!entry) return res.status(404).json({ error: 'not_found', message: 'Credential not found at that index.' });
  entry.verified = req.body?.verified !== false;
  recomputeProviderPoints(p);
  refreshCvEvaluation(p);
  store.audit('admin.credential_verified', 'admin', { providerId: p.id, kind: kind || 'any', index: idx, verified: entry.verified });
  store.save();
  res.json(store.publicProvider(p, { admin: true, points: p.points }));
});

// v2.1.1 — buddy: a new provider is paired with an ELITE provider
// (90-day program: the buddy supports the newcomer; the stay bonus is
// the retention reward).
router.post('/admin/providers/:id/buddy', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const buddyId = String(req.body?.buddyProviderId || '');
  if (isReservedId(buddyId)) return bad(res, 400, 'Invalid buddyProviderId.');
  const buddy = store.data.providers[buddyId];
  if (!buddy) return res.status(404).json({ error: 'not_found', message: 'Buddy provider not found.' });
  if (buddy.tier !== 'Elite') return bad(res, 400, 'The buddy must be an Elite provider.');
  if (buddyId === p.id) return bad(res, 400, 'A provider cannot be their own buddy.');
  p.buddyId = buddyId;
  store.audit('admin.buddy_assigned', 'admin', { providerId: p.id, buddyProviderId: buddyId });
  store.save();
  res.json(store.publicProvider(p, { admin: true }));
});

// ---------------------------------------------------------------- v2.0.9 — promo months (admin)
// Promo months (owner decision 26 Nov 2026): at most 2 months per
// calendar year, announced in advance; the admin may lower the app
// commission for new bookings or set it to 0% for a month. The override
// applies ONLY to bookings accepted while it is active — already-accepted
// bookings keep their locked commissionPct. While a 0% promo is active,
// the cash volume bonus is PAUSED (titles still awarded).
// Set:  POST /api/admin/promo { commissionPct: 0–100, until?: ISO date }
// Clear: POST /api/admin/promo { commissionPct: null }
router.post('/admin/promo', requireAdmin, (req, res) => {
  const pct = req.body?.commissionPct;
  // Clear the live override — tier rates resume immediately.
  if (pct === null || pct === undefined) {
    const was = store.data.promo;
    store.data.promo = null;
    store.audit('admin.promo_cleared', 'admin', { was: was ? { commissionPct: was.commissionPct, until: was.until } : null });
    store.save();
    return res.json({ ok: true, promo: { active: false, commissionPct: null, until: null } });
  }
  const n = Number(pct);
  if (!Number.isInteger(n) || n < 0 || n > 100) return bad(res, 400, 'commissionPct must be an integer 0–100, or null to clear the promo.');
  let until = null;
  if (req.body?.until != null) {
    const t = new Date(req.body.until).getTime();
    if (!Number.isFinite(t) || t <= Date.now()) return bad(res, 400, 'until must be a future ISO date.');
    until = new Date(t).toISOString();
  }
  // Promo-month cap (SPEC §4): at most 2 promo months per calendar year.
  const start = new Date();
  const end = until ? new Date(until) : start;
  const covered = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cur <= last) {
    covered.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  const used = store.data.promoMonths || {};
  for (const y of [...new Set(covered.map((m) => m.slice(0, 4)))]) {
    const already = Object.keys(used).filter((m) => m.startsWith(y + '-')).length;
    const fresh = covered.filter((m) => m.startsWith(y + '-') && !used[m]).length;
    if (already + fresh > 2) {
      return res.status(409).json({ error: 'promo_months_exceeded', message: `Promo months are capped at 2 per calendar year (year ${y} already uses ${already}).`, year: y, usedMonths: already });
    }
  }
  for (const m of covered) used[m] = true;
  store.data.promoMonths = used;
  store.data.promo = { commissionPct: n, until, setAt: nowIso(), setBy: 'admin' };
  store.audit('admin.promo_set', 'admin', { commissionPct: n, until, monthsCovered: covered });
  store.save();
  res.json({ ok: true, promo: { active: true, commissionPct: n, until, monthsCovered: covered } });
});

// ---------------------------------------------------------------- v2.1.4 — launch-month shift offer
// (owner-approved 26 Nov 2026, «أيوه، اعتمدها كده»): while active, single
// shift12/shift24 bookings are offered at 500 / 850 but the provider is
// paid on the 700 / 1,200 reference — the app funds the difference.
// Default OFF (no launch date is set yet — the owner enables it at
// launch). Applies ONLY to shifts accepted while active; packages,
// elderly shifts and all other services are unaffected. `until` is
// optional; an expired offer stops applying on its own (sweep).
router.post('/admin/launch-offer', requireAdmin, (req, res) => {
  const active = req.body?.active;
  if (typeof active !== 'boolean') return bad(res, 400, 'active must be true or false.');
  if (active === false) {
    const was = store.data.launchOffer;
    store.data.launchOffer = null;
    store.audit('admin.launch_offer_cleared', 'admin', { was: was ? { active: was.active, until: was.until || null } : null });
    store.save();
    return res.json({ ok: true, launchOffer: { active: false, until: null } });
  }
  let until = null;
  if (req.body?.until != null) {
    const t = new Date(req.body.until).getTime();
    if (!Number.isFinite(t) || t <= Date.now()) return bad(res, 400, 'until must be a future ISO date.');
    until = new Date(t).toISOString();
  }
  store.data.launchOffer = { active: true, until, setAt: nowIso(), setBy: 'admin' };
  store.audit('admin.launch_offer_set', 'admin', { active: true, until });
  store.save();
  res.json({ ok: true, launchOffer: { active: true, until } });
});

// ---------------------------------------------------------------- v2.0.8 — graduated discipline (warn / suspend / unsuspend)
// Warning → temporary suspension (radar + accept + wallet actions
// blocked) → permanent ban + forfeiture of pending settlement.
// Warnings are visible to the provider in their own wallet screen.
router.post('/admin/providers/:id/warn', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const reason = String(req.body?.reason || 'Violation of the Terms & Conditions (non-circumvention / respect charter).').slice(0, 500);
  p.warnings = p.warnings || [];
  p.warnings.push({ at: nowIso(), reason, by: 'admin' });
  store.audit('admin.provider_warned', 'admin', { providerId: p.id, reason, warningCount: p.warnings.length });
  store.save();
  res.json(store.publicProvider(p, { admin: true }));
});

router.post('/admin/providers/:id/suspend', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const permanent = req.body?.permanent === true;
  const reason = String(req.body?.reason || (permanent ? 'Permanent ban: repeated or grave violation of the Terms & Conditions.' : 'Temporary suspension by admin.')).slice(0, 500);
  p.suspended = true;
  p.suspendedReason = reason;
  p.suspendedUntil = permanent ? null : (req.body?.until || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
  p.permanentBan = permanent;
  store.audit(permanent ? 'admin.provider_banned' : 'admin.provider_suspended', 'admin', { providerId: p.id, reason, until: p.suspendedUntil });
  store.save();
  res.json(store.publicProvider(p, { admin: true }));
});

router.post('/admin/providers/:id/unsuspend', requireAdmin, (req, res) => {
  const p = store.data.providers[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  p.suspended = false;
  p.suspendedUntil = null;
  p.suspendedReason = null;
  p.permanentBan = false;
  store.audit('admin.provider_unsuspended', 'admin', { providerId: p.id });
  store.save();
  res.json(store.publicProvider(p, { admin: true }));
});

// Circumvention reports (from patient reviews) + computed pattern flags.
router.get('/admin/circumvention', requireAdmin, (req, res) => {
  const openOnly = req.query.open !== 'false';
  const list = (store.data.circumventionReports || []).slice().reverse();
  res.json({
    reports: openOnly ? list.filter((r) => r.status === 'open') : list,
    flags: circumventionFlags(),
  });
});

// Resolve a circumvention report. Confirmed => the patient is refunded
// in full (the visit was taken off-platform) and the provider's pending
// settlement for it is forfeited. Rejected => the held release proceeds.
router.post('/admin/circumvention/:reportId/resolve', requireAdmin, (req, res) => {
  const report = (store.data.circumventionReports || []).find((r) => r.id === req.params.reportId);
  if (!report) return res.status(404).json({ error: 'not_found', message: 'Circumvention report not found.' });
  if (report.status !== 'open') return bad(res, 409, `Circumvention report already ${report.status}.`);
  const decision = req.body?.decision;
  if (!['confirmed', 'rejected'].includes(decision)) {
    return bad(res, 400, 'decision must be confirmed or rejected.');
  }
  const b = store.data.bookings[report.bookingId];
  report.status = decision === 'confirmed' ? 'resolved_confirmed' : 'resolved_rejected';
  report.resolvedAt = nowIso();
  report.resolution = decision;
  if (b && b.circumventionReportId === report.id) {
    b.circumventionHold = false;
    if (decision === 'confirmed') {
      b.refundEgp = refundAmount(b); // what the patient actually paid (after any voucher discount)
      b.refundedAt = nowIso();
      b.refundedShares = { appShareEgp: b.appShareEgp || 0, providerShareEgp: b.providerShareEgp || 0 };
      b.appShareEgp = 0;
      b.providerShareEgp = 0;
      b.status = 'refunded';
      // v2.1.6 (C4): if this booking was already settled, the refunded
      // shares become a reversing adjustment on the next settlement —
      // the money recorded as "paid" is clawed back, not lost.
      if (b.settledWeekKey) createSettlementAdjustment(b.providerId, b, 'circumvention_confirmed');
      store.audit('circumvention.resolved_confirmed', 'admin', { bookingId: b.id, reportId: report.id, refundEgp: b.refundEgp });
    } else {
      store.audit('circumvention.resolved_rejected', 'admin', { bookingId: b.id, reportId: report.id });
      if (b.status === 'reviewed') releaseBooking(b, 'reviewed');
    }
  } else {
    store.audit(decision === 'confirmed' ? 'circumvention.resolved_confirmed' : 'circumvention.resolved_rejected', 'admin', { reportId: report.id, bookingId: report.bookingId });
  }
  store.save();
  res.json({ ok: true, report, booking: b ? pubBooking(req, b, { includePaymentNumber: false }) : null });
});

// v2.0.1 — admin resolves a complaint. Accepted => full refund to the
// patient (booking becomes 'refunded', provider/app shares removed from
// the wallet; a cash refund is deducted from the provider's settleable
// balance at Thursday settlement). Rejected => the held amount becomes
// finally settleable at once (and a paused 'reviewed' release proceeds).
router.post('/admin/complaints/:reportId/resolve', requireAdmin, (req, res) => {
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
    if (b.kind === 'package') {
      // v2.1.3 — only the UNRELEASED remainder is refunded (terms §12):
      // days already released weekly stay with the provider/app.
      const releasedTotals = packageDayTotals(b);
      b.refundEgp = packageRefundRemaining(b);
      b.refundedShares = { appShareEgp: releasedTotals.appShareEgp, providerShareEgp: releasedTotals.providerShareEgp };
      b.appShareEgp = releasedTotals.appShareEgp;
      b.providerShareEgp = releasedTotals.providerShareEgp;
    } else {
      b.refundEgp = refundAmount(b); // full refund of what the patient actually paid (after any voucher discount)
      b.refundedShares = { appShareEgp: b.appShareEgp || 0, providerShareEgp: b.providerShareEgp || 0 };
      b.appShareEgp = 0;
      b.providerShareEgp = 0;
      // v2.1.6 (C4): if this booking was already settled, the refunded
      // shares become a reversing adjustment on the next settlement.
      if (b.settledWeekKey) createSettlementAdjustment(b.providerId, b, 'complaint_accepted_refund');
    }
    b.refundedAt = nowIso();
    b.status = 'refunded';
    store.audit('complaint.resolved_refund', 'admin', { bookingId: b.id, reportId: report.id, refundEgp: b.refundEgp });
  } else {
    b.complaintStatus = 'rejected';
    b.complaintResolvedAt = nowIso();
    b.complaint = false;
    b.settleableAt = nowIso(); // finally settleable at once
    store.audit('complaint.resolved_rejected', 'admin', { bookingId: b.id, reportId: report.id });
    // If the release was paused in 'reviewed' by this complaint, release now —
    // unless a circumvention hold is still open on the same booking (v2.0.8).
    if (b.status === 'reviewed' && !b.circumventionHold) {
      if (b.kind === 'package') releasePackageBooking(b, 'reviewed'); else releaseBooking(b, 'reviewed');
    } else if (b.status === 'patient_confirmed' && !b.circumventionHold && b.patientConfirmedAt
      && Date.now() - new Date(b.patientConfirmedAt).getTime() >= config.autoReleaseAfterMs) {
      if (b.kind === 'package') releasePackageBooking(b, 'auto'); else releaseBooking(b, 'auto');
    }
  }
  store.save();
  res.json({ ok: true, report, booking: pubBooking(req, b, { includePaymentNumber: false }) });
});

router.get('/admin/sos', requireAdmin, (req, res) => {
  const open = req.query.open === 'true';
  const list = open ? store.data.sos.filter((s) => s.status === 'open') : store.data.sos;
  const overdue = Object.values(store.data.bookings)
    .filter((b) => b.overdue && ['accepted', 'provider_confirmed'].includes(b.status))
    .map((b) => ({ bookingId: b.id, providerId: b.providerId, acceptedAt: b.acceptedAt, note: 'Visit open >120 minutes without closure.' }));
  res.json({ sos: list.slice().reverse(), overdue, safetyReports: store.data.safetyReports.slice().reverse() });
});

router.get('/admin/audit', requireAdmin, (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 100);
  res.json(store.data.audit.slice(-limit).reverse());
});

// Dev only: shows last OTP codes for testing. Gated by MOCK_OTP=true.
// Default OFF in production — never enable there.
router.get('/admin/mock-otp', requireAdmin, (req, res) => {
  if (!config.mockOtp) {
    return res.status(404).json({ error: 'not_found', message: 'Mock OTP endpoint is disabled (MOCK_OTP is not true).' });
  }
  // v2.1.1: pending codes are returned here (admin-only, mock mode
  // only) because OTP codes are NEVER logged anywhere (audit #15).
  // Tests read the code from this endpoint after an admin login.
  const codes = Object.entries(store.data.otps).map(([phone, r]) => ({
    phone, channel: r.channel, expiresAt: r.expiresAt, attempts: r.attempts,
    note: 'DEV ONLY — mock mode; the code is available to admin here, never in logs.',
  }));
  const qPhone = normalizePhone(req.query.phone || '');
  const demo = [{ phone: '01000000001', code: DEMO_OTP }, { phone: '01000000002', code: DEMO_OTP }];
  // v2.1.1: in mock mode the admin-only endpoint returns the pending code
  // for the queried phone (from process memory — never logged, never in
  // data.json). Demo phones use the documented demo code.
  const pendingCode = qPhone ? getMockCode(qPhone) : null;
  const demoCode = qPhone ? (demo.find((d) => d.phone === qPhone) || {}).code || null : null;
  res.json({
    mockOtp: true,
    demoPhones: demo,
    code: demoCode || pendingCode || null,
    otp: demoCode || pendingCode || null,
    pending: codes.map((c) => ({ ...c, code: getMockCode(c.phone) })),
  });
});

module.exports = { router, sweepAutoRelease };
