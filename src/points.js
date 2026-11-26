// Points system (owner-approved 26 Nov 2026, v2.1.1) — 0–100 points.
//   interview: total>=30 -> 20, 24–29 -> 15, manual-review admin pass -> 10
//   verified certificates: +5 each, max 20
//   verified courses: +5 each, max 15
//   completed cases: +1 per 10 cases, max 25 — a week with >=5 cases
//     counts DOUBLE (cases + extraWeekly, where extraWeekly = sum of case
//     counts of ISO weeks with >=5 cases)
//   client rating: average x4, max 20 — the average is computed over ALL
//     released bookings' reviews INCLUDING the current visit (L4 fix:
//     the old ratingAvg update never counted the current visit).
// Tiers: 0–39 Starter (15%), 40–69 Pro (12%), 70+ Elite (8%).
// Auto-promotion happens on interview submit, admin credential verify
// and booking release (see routes.js — recomputeProviderPoints).
const cat = require('./catalog');

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDay + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function currentWeekKey() { return isoWeekKey(new Date()); }

// Verified entries in an array that may hold objects {name, verified} or
// legacy plain strings (strings count via the provider's verifiedCertificates
// counter only when the array holds strings — see countVerified).
function countVerified(arr, legacyCount) {
  if (!Array.isArray(arr)) return 0;
  const objects = arr.filter((x) => x && typeof x === 'object');
  if (objects.length) return objects.filter((x) => x.verified === true).length;
  if (arr.length) return Math.min(legacyCount || 0, arr.length);
  return 0;
}

function computePoints(provider, bookings) {
  const P = cat.POINTS;
  const list = Array.isArray(bookings) ? bookings : [];
  const mine = list.filter((b) => b.providerId === provider.id);
  // v2.1.1 (complete-provider points contract): a case counts once the
  // provider COMPLETES the visit (provider_confirmed and later states),
  // not only once the escrow releases it — so completing a visit can
  // cross a cases-points / weekly-double threshold and the completion
  // response can report the points earned. Release does not count it
  // again (same booking, counted once). Cancelled/refunded never count.
  const COUNTED_STATUSES = ['released', 'auto_released', 'provider_confirmed', 'patient_confirmed', 'reviewed'];
  const released = mine.filter((b) => b.status === 'released' || b.status === 'auto_released');
  const counted = mine.filter((b) => COUNTED_STATUSES.includes(b.status));
  const totalCases = counted.length;

  // Cases by ISO week (release date, else completion date). Weekly-double:
  // weeks with >=5 cases add their count again (extraWeekly). Tracked on
  // the provider record as p.casesByWeek {'YYYY-Www': n} at release time;
  // recomputed here from bookings so a stale record can never drift.
  const casesByWeek = {};
  for (const b of counted) {
    const at = b.releasedAt || b.providerConfirmedAt || b.patientConfirmedAt;
    if (!at) continue;
    const k = isoWeekKey(new Date(at));
    casesByWeek[k] = (casesByWeek[k] || 0) + 1;
  }
  let extraWeekly = 0;
  for (const n of Object.values(casesByWeek)) if (n >= cat.WEEKLY_DOUBLE_THRESHOLD) extraWeekly += n;
  const weekKey = currentWeekKey();
  const weeklyCases = casesByWeek[weekKey] || 0;

  // Rating average over released bookings' reviews, INCLUDING the current
  // visit (a review exists on the booking before release completes).
  const rated = released.filter((b) => b.review && Number.isFinite(Number(b.review.rating)));
  const ratingAvg = rated.length
    ? Math.round((rated.reduce((s, b) => s + Number(b.review.rating), 0) / rated.length) * 10) / 10
    : null;

  const interview = Math.max(0, Math.min(P.interview.excellentPts, provider.interviewPoints || 0));
  const certificates = Math.min(P.certificateMax, countVerified(provider.certificates, provider.verifiedCertificates) * P.certificateEach);
  const courses = Math.min(P.courseMax, countVerified(provider.courses) * P.courseEach);
  const cases = Math.min(P.casesMax, Math.floor((totalCases + extraWeekly) / 10) * P.casesPer10);
  const rating = ratingAvg == null ? 0 : Math.min(P.ratingMax, Math.round(ratingAvg * P.ratingMultiplier * 10) / 10);
  const total = interview + certificates + courses + cases + rating;
  const tier = total >= 70 ? 'Elite' : total >= 40 ? 'Pro' : 'Starter';
  const nextTier = tier === 'Elite' ? null : tier === 'Pro' ? 'Elite' : 'Pro';
  const nextMin = tier === 'Elite' ? null : tier === 'Pro' ? 70 : 40;
  return {
    total, interview, certificates, courses, cases, rating,
    tier, nextTier, pointsToNextTier: nextMin == null ? null : Math.max(0, nextMin - total),
    weeklyDoubleActive: weeklyCases >= cat.WEEKLY_DOUBLE_THRESHOLD,
    weeklyCases, totalCases, extraWeekly, ratingAvg,
    casesByWeek,
  };
}

// Is the provider tourist-compatible? >=1 VERIFIED entry in
// p.languageCertificates (non-English languages need a certificate;
// English itself needs none — it is measured in the interview).
function touristCompatible(provider) {
  return Array.isArray(provider.languageCertificates)
    && provider.languageCertificates.some((l) => l && l.verified === true);
}
// English 0/3 in the interview blocks tourist radar (owner decision).
function englishBlocked(provider) {
  return provider.interviewEnglishCorrect === 0
    && provider.interviewEnglishTotal === 3;
}

module.exports = { computePoints, isoWeekKey, currentWeekKey, countVerified, touristCompatible, englishBlocked };
