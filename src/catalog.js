// Server-side constants: services, prices, hotels, MCQ bank, pricing rules.
// NOTHING here is trusted from the client — all amounts are computed server-side.

// ---------------------------------------------------------------- services
// EGP prices (Phase 1, El Quseir). Keys are the only valid serviceCode values.
const SERVICES = {
  standard: { code: 'standard', category: 'nursing', name_en: 'Standard home visit', name_ar: 'زيارة منزلية قياسية', price_egp: 250 },
  dressing: { code: 'dressing', category: 'nursing', name_en: 'Wound dressing (single)', name_ar: 'غيار جرح واحد', price_egp: 275, requires_vitals: true, requires_wound_photo: true },
  package7: { code: 'package7', category: 'nursing', name_en: '7-dressing package', name_ar: 'باقة 7 غيارات', price_egp: 1640 },
  vip: { code: 'vip', category: 'nursing', name_en: 'Rapid / VIP visit (20–30 min)', name_ar: 'وصول سريع / VIP', price_egp: 350 },
  cannula: { code: 'cannula', category: 'nursing', name_en: 'Cannula only', name_ar: 'كانيولا فقط', price_egp: 250 },
  // v2.1.13 — owner decision 27 Nov 2026: cannula+IV fluids is STANDARD
  // risk (IV antibiotics and IV iron STAY high — anaphylaxis risk), price
  // 350 -> 250 (the 250 minimum). It is NOT a written-consent service
  // anymore, but it stays NURSE-ONLY: a nursing assistant may never accept
  // it (nurseOnly guard, enforced in routes.js radar + accept).
  cannula_iv: { code: 'cannula_iv', category: 'nursing', name_en: 'Cannula + IV fluids', name_ar: 'كانيولا + محاليل', price_egp: 250, riskLevel: 'standard', nurseOnly: true },
  // v2.1.4 (26 Nov 2026, owner decision — «سيبها: 500 / 850»): single-day
  // shift prices go BACK to 12h 500 / 24h 850 (they were 700 / 1,200 only
  // briefly in v2.1.3). The monthly-package ladder is priced off its OWN
  // daily rates (assistant 350/600, technician 550/950, specialist
  // 750/1,250) — NOT off these single-day prices.
  shift12: { code: 'shift12', category: 'nursing', name_en: '12-hour shift', name_ar: 'شيفت 12 ساعة', price_egp: 500 },
  shift24: { code: 'shift24', category: 'nursing', name_en: '24-hour shift', name_ar: 'شيفت 24 ساعة', price_egp: 850 },
  // v2.1.4 — LAUNCH-MONTH SHIFT OFFER (owner-approved 26 Nov 2026):
  // during the launch month, single shifts are offered at 500 / 850 but
  // the provider is paid as if the price were 700 / 1,200 (the reference
  // prices below). The app funds the difference as a launch cost.
  // Reference prices are the PRE-OFFER single-day prices, NOT the
  // package-ladder daily rates.
  postop: { code: 'postop', category: 'nursing', name_en: 'Post-operative care', name_ar: 'رعاية ما بعد العمليات', price_egp: 1400 },
  gp: { code: 'gp', category: 'nursing', name_en: 'GP home visit', name_ar: 'طبيب عام منزلي', price_egp: 500 },
  specialist: { code: 'specialist', category: 'nursing', name_en: 'Specialist home visit', name_ar: 'أخصائي منزلي', price_egp: 900 },
  video: { code: 'video', category: 'nursing', name_en: 'Video consultation', name_ar: 'استشارة فيديو', price_egp: 250 },
  // Nursing-assistant price depends on experience (years). Priced by band.
  assistant: { code: 'assistant', category: 'nursing', name_en: 'Nursing assistant visit', name_ar: 'زيارة مساعد تمريض', price_egp: null, experience_bands: [
    { min_years: 0, max_years: 1.99, price_egp: 165, label: '<2 years' },
    { min_years: 2, max_years: 4.99, price_egp: 205, label: '2–4 years' },
    { min_years: 5, max_years: 9.99, price_egp: 235, label: '5–9 years' },
    { min_years: 10, max_years: 99, price_egp: 260, label: '10+ years' },
  ]},
  // --- v2.1.0 — new nursing services (owner refinement 26 Nov 2026) -----
  // PRICES APPROVED BY THE OWNER 26 Nov 2026 («اعتمد يلا») — FINAL, not
  // proposed. Change only on a new owner decision.
  // High-risk services (riskLevel 'high'): doctor's order REQUIRED to
  // book, only verified NURSES (or doctors) may accept, and the provider
  // must complete the in-app safety checklist before finishing the visit.
  // Owner correction 26 Nov 2026: ALL catheter handling and ALL drain
  // handling are HIGH risk — not just insertion. The high-risk tier is:
  // catheter insertion 400, catheter removal 300, catheter flush 300,
  // Ryle insertion 400, drain removal 300 (owner-set price),
  // tracheostomy care 400, IV infusion therapy 400, NPWT dressing 600,
  // cannula+IV fluids 350.
  catheter_insert: { code: 'catheter_insert', category: 'nursing', name_en: 'Urinary catheter insertion', name_ar: 'تركيب قسطرة بولية', price_egp: 400, riskLevel: 'high' },
  catheter_remove: { code: 'catheter_remove', category: 'nursing', name_en: 'Urinary catheter removal', name_ar: 'إزالة قسطرة بولية', price_egp: 300, riskLevel: 'high' },
  catheter_flush: { code: 'catheter_flush', category: 'nursing', name_en: 'Catheter unblocking / flush', name_ar: 'تسليك / غسيل قسطرة', price_egp: 300, riskLevel: 'high' },
  // Suture removal is STANDARD risk, but keeps its own doctor-order gate
  // (owner scope 26 Nov 2026): no written order = no booking, and the
  // provider must confirm seeing the order before completing the visit.
  suture_removal: { code: 'suture_removal', category: 'nursing', name_en: 'Surgical suture removal', name_ar: 'فك غرز جراحية', price_egp: 250, riskLevel: 'standard', requiresDoctorOrder: true },
  ryle_insert: { code: 'ryle_insert', category: 'nursing', name_en: 'Ryle (NG) tube insertion', name_ar: 'تركيب أنبوبة رايل (أنفية معدية)', price_egp: 400, riskLevel: 'high' },
  trach_care: { code: 'trach_care', category: 'nursing', name_en: 'Tracheostomy care', name_ar: 'العناية بالقصطرة الرغامية (تراكيوستومي)', price_egp: 400, riskLevel: 'high' },
  iv_infusion: { code: 'iv_infusion', category: 'nursing', name_en: 'IV antibiotic / infusion therapy', name_ar: 'علاج وريدي (مضاد حيوي / محاليل)', price_egp: 400, riskLevel: 'high' },
  drain_removal: { code: 'drain_removal', category: 'nursing', name_en: 'Surgical drain removal', name_ar: 'إزالة درنقة جراحية', price_egp: 300, riskLevel: 'high' },
  blood_draw: { code: 'blood_draw', category: 'nursing', name_en: 'Blood draw (phlebotomy)', name_ar: 'سحب عينة دم', price_egp: 250, riskLevel: 'standard' },
  injection: { code: 'injection', category: 'nursing', name_en: 'IM / IV injection', name_ar: 'حقن عضلي / وريدي', price_egp: 250, riskLevel: 'standard' },
  vitals_check: { code: 'vitals_check', category: 'nursing', name_en: 'Vital signs check', name_ar: 'قياس العلامات الحيوية', price_egp: 250, riskLevel: 'standard' },
  stoma_care: { code: 'stoma_care', category: 'nursing', name_en: 'Stoma care', name_ar: 'العناية بفتحة الإخراج (ستوما)', price_egp: 300, riskLevel: 'standard' },
  // --- v2.1.0 — owner additions 26 Nov 2026 (APPROVED, FINAL) -----------
  // CVP central-line dressing: HIGH risk, same gates as the rest of the
  // tier (doctor's order, verified nurse only, safety checklist).
  cvp_dressing: { code: 'cvp_dressing', category: 'nursing', name_en: 'CVP central-line dressing', name_ar: 'غيار قسطرة CVP (قسطرة وريدية مركزية)', price_egp: 300, riskLevel: 'high', requiresDoctorOrder: true },
  // Elderly care, 12-hour shift — its OWN service. TWO condition-based
  // prices, both owner-set MINIMUMS ("لا يقل عن"): mobile patient 600,
  // bedridden patient 700 (raised in v2.1.3 from 400 / 500, owner-approved
  // 26 Nov 2026). The patient picks the condition at booking.
  elderly_shift_mobile: { code: 'elderly_shift_mobile', category: 'nursing', name_en: 'Elderly care — 12h shift (mobile patient)', name_ar: 'رعاية مسنين — شيفت 12 ساعة (حالة متحركة)', price_egp: 600, riskLevel: 'standard' },
  elderly_shift_bedridden: { code: 'elderly_shift_bedridden', category: 'nursing', name_en: 'Elderly care — 12h shift (bedridden patient)', name_ar: 'رعاية مسنين — شيفت 12 ساعة (حالة قعيدة / طريحة فراش)', price_egp: 700, riskLevel: 'standard' },
  // --- v2.1.1 — new nursing services (owner-approved 26 Nov 2026) -----
  enema: { code: 'enema', category: 'nursing', name_en: 'Enema', name_ar: 'حقنة شرجية', price_egp: 500, riskLevel: 'standard' },
  allergy_test: { code: 'allergy_test', category: 'nursing', name_en: 'Allergy test', name_ar: 'اختبار حساسية', price_egp: 250, riskLevel: 'standard' },
  // Iron IV infusion: HIGH risk (owner decision 26 Nov 2026) — doctor's
  // order required, verified nurse only, safety checklist.
  iron_infusion: { code: 'iron_infusion', category: 'nursing', name_en: 'Iron IV infusion', name_ar: 'حديد وريدي', price_egp: 400, riskLevel: 'high', requiresDoctorOrder: true },
  condom_catheter: { code: 'condom_catheter', category: 'nursing', name_en: 'Condom (external) catheter', name_ar: 'قسطرة خارجية (كوندوم)', price_egp: 300, riskLevel: 'standard' },
  culture_sample: { code: 'culture_sample', category: 'nursing', name_en: 'Culture sample', name_ar: 'عينة مزرعة', price_egp: 400, riskLevel: 'standard' },
  urine_catheter_sample: { code: 'urine_catheter_sample', category: 'nursing', name_en: 'Urine sample from catheter', name_ar: 'عينة بول من قسطرة', price_egp: 350, riskLevel: 'standard' },
  // --- v2.1.11 — ONE physiotherapy session (owner decision 27 Nov 2026) --
  // All physio sessions are now a single service only: «جلسة علاج طبيعي»,
  // flat 450 EGP — not less. The 8 separate services (350/400 EGP) are
  // gone; the session covers all of them — the includes note below the
  // name says what it covers, per the specialist's assessment of the
  // patient's condition. Visible ONLY to providerType 'physio' on the radar.
  physio_session: { code: 'physio_session', category: 'physio', name_en: 'Physiotherapy session', name_ar: 'جلسة علاج طبيعي', price_egp: 450, riskLevel: 'standard',
    includes_ar: 'تشمل الجلسة: تأهيل حركي عام، تأهيل ما بعد الجلطة، تمارين ما بعد الكسور والعمليات، علاج طبيعي للصدر، تمارين توازن ومشي، تدليك علاجي، تمارين شد وإطالة، تأهيل كبار السن — حسب حالة المريض وتقييم الأخصائي.',
    includes_en: 'Includes: general mobility rehabilitation, post-stroke rehabilitation, post-fracture/post-surgery exercises, chest physiotherapy, balance & walking exercises, therapeutic massage, stretching exercises, elderly rehabilitation — as needed for the patient’s condition, per the specialist’s assessment.' },
  // NOTE (superseded v2.1.11): the 8 separate physio services (physio_*,
  // 350/400 EGP, v2.1.1) were unified into the single physio_session
  // above by owner decision 27 Nov 2026 — old codes are no longer valid
  // serviceCodes (booking with one returns 400).
};

// v2.1.4 — LAUNCH-MONTH SHIFT OFFER (owner-approved 26 Nov 2026,
// «أيوه، اعتمدها كده»): during the launch month, single-day shifts are
// offered at 500 / 850 (the live SERVICES prices above), but the provider
// is paid as if the price were the reference below (700 / 1,200). The app
// funds the difference as a launch cost (see releaseBooking in routes.js:
// provider share is computed on the reference total, app share = amount
// actually paid − provider share, which goes NEGATIVE during the offer).
// Applies ONLY to single shift12/shift24 bookings accepted while the
// offer is active (locked at accept time) — packages, elderly shifts and
// all other services are unaffected. Default OFF; enabled by the admin
// at launch (POST /api/admin/launch-offer).
const LAUNCH_OFFER_REFERENCE = { shift12: 700, shift24: 1200 };

// --- v2.1.3 — monthly packages (owner-approved 26 Nov 2026) -------------
// A package = 26 days of care + 4 nurse days off (the Egyptian working
// month: 26 days + 4 days off). PRICES ARE INDICATIVE ("يبدأ من") — the
// final price is a written admin quote after assessing the case (the
// patient submits a package request; admin sets the final price; the
// patient accepts or declines). The offer price is shown as "بدل" the
// normal price: 26 × daily rate. Care-level ladder (v2.1.3 refinement,
// owner-set prices 26 Nov 2026 — affordable for Quseir, ~12% package
// discount): assistant 12h 350 → 8,000 (بدل 9,100) / 24h 600 → 13,700
// (بدل 15,600); technician 12h 550 → 12,600 (بدل 14,300) / 24h 950 →
// 21,700 (بدل 24,700); specialist 12h 750 → 17,200 (بدل 19,500) / 24h
// 1,250 → 28,600 (بدل 32,500); elderly mobile 350 → 8,000 (بدل 9,100),
// bedridden 550 → 12,600 (بدل 14,300). Single-day (non-package) shifts
// are 12h 500 / 24h 850 (v2.1.4 — back from 700 / 1,200 in v2.1.3).
// package "starting from"): assistant $25/$45 → $575/$1,030 (€530/€950);
// technician $35/$60 → $800/$1,375 (€735/€1,265); specialist $45/$75 →
// $1,030/$1,720 (€950/€1,580).
// The distance fee is INCLUDED inside El Quseir. The normal tier
// commission (Starter 15% / Pro 12% / Elite 8%) applies to the final
// quoted package price. The full month is paid upfront into escrow and
// the nurse is paid WEEKLY at Thursday settlement for completed days.
// The 4 extra days are NOT included by default: (a) a substitute nurse
// covers them at the normal daily rate, or (b) the main nurse works them
// as overtime at +25% premium — the premium is waived during the launch
// offer month (flag below / admin setting).
// Cancellation: before the start date = full refund; after the start =
// refund of the remaining days at the package daily rate (final price ÷ 26).
const PACKAGE_DAYS = 26;
const PACKAGE_OFF_DAYS = 4;
const PACKAGE_OVERTIME_PREMIUM_PCT = 25;
// Care-level ladder (owner refinement 26 Nov 2026 — v2.1.3): the package
// request / assessment determines which level the case actually needs,
// and the admin confirms or RAISES the level in the written quote.
// Nobody works above their qualification (enforced in routes.js):
// assistant = basic care (bathing, feeding, movement, companionship,
// vitals); technician = standard nursing (dressings, injections,
// cannula, catheters); specialist = advanced / complex (NPWT, high-risk
// procedures). Owner-set ladder prices (26 Nov 2026 — supersedes the
// earlier ladder): affordable for Quseir — the lowest 12h residence
// shift (assistant) is 350, rising gradually by level; package ≈ 12%
// below 26 × daily. Single-day (non-package) shifts are 12h 500 /
// 24h 850 (v2.1.4 — back from 700 / 1,200 in v2.1.3). The "200 EGP below Cairo" rule was superseded in practice
// by this cheaper ladder (the whole ladder sits below the Cairo average:
// 12h 700–1,100, 24h 1,200–1,800).
// Elderly packages are REALIGNED to the ladder (never more than the
// matching level): mobile = assistant 12h (8,000 بدل 9,100), bedridden
// = technician 12h (12,600 بدل 14,300); level 'assistant' by default —
// the admin quotes a technician/specialist package instead when the
// case needs more.
const PACKAGE_LEVELS = ['assistant', 'technician', 'specialist'];
const MONTHLY_PACKAGES = {
  package_assistant_12: { code: 'package_assistant_12', level: 'assistant', shiftType: '12h', shiftHours: 12, dailyRateEgp: 350, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Monthly package — nursing assistant, 12-hour shifts (26 days)', name_ar: 'باقة شهرية — مساعد تمريض، شيفت 12 ساعة (26 يومًا)', priceEgp: 8000, originalEgp: 9100 },
  package_assistant_24: { code: 'package_assistant_24', level: 'assistant', shiftType: '24h', shiftHours: 24, dailyRateEgp: 600, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Monthly package — nursing assistant, 24-hour resident care (26 days)', name_ar: 'باقة شهرية — مساعد تمريض، شيفت 24 ساعة / مقيم (26 يومًا)', priceEgp: 13700, originalEgp: 15600 },
  package_technician_12: { code: 'package_technician_12', level: 'technician', shiftType: '12h', shiftHours: 12, dailyRateEgp: 550, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Monthly package — nursing technician, 12-hour shifts (26 days)', name_ar: 'باقة شهرية — فني تمريض، شيفت 12 ساعة (26 يومًا)', priceEgp: 12600, originalEgp: 14300 },
  package_technician_24: { code: 'package_technician_24', level: 'technician', shiftType: '24h', shiftHours: 24, dailyRateEgp: 950, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Monthly package — nursing technician, 24-hour resident care (26 days)', name_ar: 'باقة شهرية — فني تمريض، شيفت 24 ساعة / مقيم (26 يومًا)', priceEgp: 21700, originalEgp: 24700 },
  package_specialist_12: { code: 'package_specialist_12', level: 'specialist', shiftType: '12h', shiftHours: 12, dailyRateEgp: 750, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Monthly package — nursing specialist, 12-hour shifts (26 days)', name_ar: 'باقة شهرية — أخصائي تمريض، شيفت 12 ساعة (26 يومًا)', priceEgp: 17200, originalEgp: 19500 },
  package_specialist_24: { code: 'package_specialist_24', level: 'specialist', shiftType: '24h', shiftHours: 24, dailyRateEgp: 1250, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Monthly package — nursing specialist, 24-hour resident care (26 days)', name_ar: 'باقة شهرية — أخصائي تمريض، شيفت 24 ساعة / مقيم (26 يومًا)', priceEgp: 28600, originalEgp: 32500 },
  package_elderly_mobile: { code: 'package_elderly_mobile', level: 'assistant', shiftType: 'elderly_shift_mobile', shiftHours: 12, dailyRateEgp: 350, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Monthly package — elderly care 12h, mobile patient (26 days)', name_ar: 'باقة شهرية — رعاية مسنين 12 ساعة، حالة متحركة (26 يومًا)', priceEgp: 8000, originalEgp: 9100 },
  package_elderly_bedridden: { code: 'package_elderly_bedridden', level: 'technician', shiftType: 'elderly_shift_bedridden', shiftHours: 12, dailyRateEgp: 550, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Monthly package — elderly care 12h, bedridden patient (26 days)', name_ar: 'باقة شهرية — رعاية مسنين 12 ساعة، حالة قعيدة (26 يومًا)', priceEgp: 12600, originalEgp: 14300 },
};
// Tourist residence packages (owner refinement 26 Nov 2026 — v2.1.3;
// USD/EUR per day, 26-day package "starting from"). USD figures are the
// owner's exact numbers; EUR package prices are his exact figures too
// (EUR ≈ USD × 48/52 rounded to the nearest 5 gives 740 / 1,270 / 1,590
// for three of them — the owner's explicit 735 / 1,265 / 1,580 are used
// as given). Daily EUR rates are daily USD × 48/52 rounded to the
// nearest whole euro. Originals = 26 × daily rate, as for local
// packages. Same quote flow, same escrow, same extra-days logic.
const TOURIST_PACKAGES = {
  package_tourist_assistant_12: { code: 'package_tourist_assistant_12', kind: 'tourist', level: 'assistant', shiftType: '12h', shiftHours: 12, dailyRateUsd: 25, dailyRateEur: 23, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Tourist package — nursing assistant, 12-hour shifts (26 days)', name_ar: 'باقة سياحية — مساعد تمريض، شيفت 12 ساعة (26 يومًا)', priceUsd: 575, originalUsd: 650, priceEur: 530, originalEur: 598 },
  package_tourist_assistant_24: { code: 'package_tourist_assistant_24', kind: 'tourist', level: 'assistant', shiftType: '24h', shiftHours: 24, dailyRateUsd: 45, dailyRateEur: 42, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Tourist package — nursing assistant, 24-hour resident care (26 days)', name_ar: 'باقة سياحية — مساعد تمريض، شيفت 24 ساعة / مقيم (26 يومًا)', priceUsd: 1030, originalUsd: 1170, priceEur: 950, originalEur: 1092 },
  package_tourist_technician_12: { code: 'package_tourist_technician_12', kind: 'tourist', level: 'technician', shiftType: '12h', shiftHours: 12, dailyRateUsd: 35, dailyRateEur: 32, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Tourist package — nursing technician, 12-hour shifts (26 days)', name_ar: 'باقة سياحية — فني تمريض، شيفت 12 ساعة (26 يومًا)', priceUsd: 800, originalUsd: 910, priceEur: 735, originalEur: 832 },
  package_tourist_technician_24: { code: 'package_tourist_technician_24', kind: 'tourist', level: 'technician', shiftType: '24h', shiftHours: 24, dailyRateUsd: 60, dailyRateEur: 55, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Tourist package — nursing technician, 24-hour resident care (26 days)', name_ar: 'باقة سياحية — فني تمريض، شيفت 24 ساعة / مقيم (26 يومًا)', priceUsd: 1375, originalUsd: 1560, priceEur: 1265, originalEur: 1430 },
  package_tourist_specialist_12: { code: 'package_tourist_specialist_12', kind: 'tourist', level: 'specialist', shiftType: '12h', shiftHours: 12, dailyRateUsd: 45, dailyRateEur: 42, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Tourist package — nursing specialist, 12-hour shifts (26 days)', name_ar: 'باقة سياحية — أخصائي تمريض، شيفت 12 ساعة (26 يومًا)', priceUsd: 1030, originalUsd: 1170, priceEur: 950, originalEur: 1092 },
  package_tourist_specialist_24: { code: 'package_tourist_specialist_24', kind: 'tourist', level: 'specialist', shiftType: '24h', shiftHours: 24, dailyRateUsd: 75, dailyRateEur: 69, days: PACKAGE_DAYS, category: 'nursing', name_en: 'Tourist package — nursing specialist, 24-hour resident care (26 days)', name_ar: 'باقة سياحية — أخصائي تمريض، شيفت 24 ساعة / مقيم (26 يومًا)', priceUsd: 1720, originalUsd: 1950, priceEur: 1580, originalEur: 1794 },
};
// Daily rate of a package in the requested currency ('EGP' local;
// 'USD'/'EUR' tourist). Returns null for an unknown currency.
function packageDailyRateIn(pkg, currency) {
  if (!pkg) return null;
  if (currency === 'EGP') return pkg.dailyRateEgp ?? null;
  if (currency === 'USD') return pkg.dailyRateUsd ?? null;
  if (currency === 'EUR') return pkg.dailyRateEur ?? null;
  return null;
}
// Indicative package price in the requested currency:
// { price, original } or null.
function packagePriceIn(pkg, currency) {
  if (!pkg) return null;
  if (currency === 'EGP') return pkg.priceEgp != null ? { price: pkg.priceEgp, original: pkg.originalEgp } : null;
  if (currency === 'USD') return pkg.priceUsd != null ? { price: pkg.priceUsd, original: pkg.originalUsd } : null;
  if (currency === 'EUR') return pkg.priceEur != null ? { price: pkg.priceEur, original: pkg.originalEur } : null;
  return null;
}
// Per-day rate for the 4 extra days in the requested currency:
// 'substitute' = normal daily rate; 'overtime' = +25% (waived while the
// launch offer is on); 'none' = 0. The overtime rate is rounded to the
// NEAREST 5 (owner-set figures: assistant 440/750, technician 690/1,190,
// specialist 940/1,565 — 350×1.25 = 437.5 → 440, 550×1.25 = 687.5 → 690,
// 750×1.25 = 937.5 → 940, 950×1.25 = 1,187.5 → 1,190,
// 1,250×1.25 = 1,562.5 → 1,565).
function packageExtraDailyRate(pkg, option, premiumWaived, currency) {
  if (!pkg || option === 'none' || !option) return 0;
  const daily = packageDailyRateIn(pkg, currency || 'EGP');
  if (daily == null) return 0;
  if (option === 'substitute') return daily;
  if (option === 'overtime') return premiumWaived ? daily : Math.round(daily * (1 + PACKAGE_OVERTIME_PREMIUM_PCT / 100) / 5) * 5;
  return 0;
}
// Extra-days price for the 4 days off, in the requested currency.
// 'substitute' = normal daily rate × 4; 'overtime' = main nurse at +25%
// (waived while the launch offer is on) × 4; 'none' = 0. Currency
// defaults to EGP (local packages); pass 'USD'/'EUR' for tourist ones.
function packageExtraDaysPrice(pkg, option, premiumWaived, currency) {
  return packageExtraDailyRate(pkg, option, premiumWaived, currency || 'EGP') * PACKAGE_OFF_DAYS;
}
// Case-assessment checklists for the package request form (server-side
// enum — the client sends codes only; free text rides alongside).
const PACKAGE_CONDITIONS = [
  { code: 'diabetes', name_ar: 'سكري' },
  { code: 'pressure_ulcer', name_ar: 'قرحة فراش' },
  { code: 'post_stroke', name_ar: 'بعد جلطة' },
  { code: 'post_surgery', name_ar: 'بعد عملية جراحية' },
  { code: 'fracture', name_ar: 'كسر / إصابة' },
  { code: 'chronic', name_ar: 'مرض مزمن' },
  { code: 'elderly', name_ar: 'كبير سن' },
  { code: 'wound', name_ar: 'جرح / غيار' },
  { code: 'other', name_ar: 'أخرى' },
];
const PACKAGE_NEEDS = [
  { code: 'mobility', name_ar: 'مساعدة في الحركة' },
  { code: 'feeding', name_ar: 'تغذية / إطعام' },
  { code: 'wound_care', name_ar: 'غيار جرح' },
  { code: 'catheter', name_ar: 'قسطرة بولية' },
  { code: 'iv', name_ar: 'محاليل / علاج وريدي' },
  { code: 'physio', name_ar: 'علاج طبيعي' },
  { code: 'elderly_care', name_ar: 'رعاية مسنين' },
  { code: 'postop', name_ar: 'رعاية ما بعد العملية' },
  { code: 'diabetes', name_ar: 'متابعة سكري / ضغط' },
  { code: 'bedridden', name_ar: 'رعاية طريح فراش' },
  { code: 'other', name_ar: 'أخرى' },
];

// High-risk services (owner refinement + correction 26 Nov 2026, amended
// 27 Nov 2026: cannula+IV fluids LEFT the tier — STANDARD risk now, price
// 250; IV antibiotics and IV iron STAY high — anaphylaxis risk).
// PRICES APPROVED 26 Nov 2026 — FINAL): ALL catheter handling
// (insertion 400, removal 300, flush 300), Ryle (NG) tube insertion
// 400, drain removal 300, tracheostomy care 400, IV
// antibiotic/infusion therapy 400, NPWT dressing 600,
// CVP central-line dressing 300 (owner-set 26 Nov 2026). 'npwt' is
// not a SERVICES entry (it has its own booking endpoint) but is high-risk too.
// Rules (enforced server-side in routes.js): doctor's order REQUIRED to
// book; only verified nurses (or doctors) may accept — nursing
// assistants cannot; the provider must complete the safety checklist
// (HIGH_RISK_CHECKLIST) before finishing the visit. The owner stresses
// these need professionalism — the gates are server-side, and the app
// must show the requirements clearly to the patient at booking time.
const HIGH_RISK_SERVICES = ['catheter_insert', 'catheter_remove', 'catheter_flush', 'ryle_insert', 'drain_removal', 'npwt', 'trach_care', 'iv_infusion', 'cvp_dressing', 'iron_infusion'];
function isHighRiskService(serviceCode) {
  if (!serviceCode) return false;
  if (HIGH_RISK_SERVICES.includes(serviceCode)) return true;
  return (SERVICES[serviceCode] && SERVICES[serviceCode].riskLevel === 'high') || false;
}
// v2.1.13 — owner decision 27 Nov 2026: the minimum price of ANY flat
// service is 250 EGP. Enforced in servicePriceEgp below (flat prices
// only — the nursing-assistant experience bands 165/205/235/260 are a
// separate owner-approved band model and are NOT raised by this floor;
// flag to the owner if the bands should also rise to 250).
const MIN_SERVICE_PRICE_EGP = 250;
// Services a nursing assistant may NEVER accept, even at standard risk
// (owner safety rule 27 Nov 2026 — cannula insertion needs a qualified
// nurse/technician). Enforced in routes.js (radar filter + accept gate).
const NURSE_ONLY_SERVICES = ['cannula_iv'];
function isNurseOnlyService(serviceCode) {
  if (!serviceCode) return false;
  if (NURSE_ONLY_SERVICES.includes(serviceCode)) return true;
  return !!(SERVICES[serviceCode] && SERVICES[serviceCode].nurseOnly === true);
}
// In-app safety checklist the provider completes before finishing a
// high-risk visit (all four must be true at complete-provider time).
const HIGH_RISK_CHECKLIST = ['orderSeen', 'sterileTechnique', 'identityConfirmed', 'complicationCheck'];
const HIGH_RISK_CHECKLIST_LABELS = {
  orderSeen: 'I have seen the written doctor order',
  sterileTechnique: 'Sterile / clean technique followed',
  identityConfirmed: 'Patient identity confirmed',
  complicationCheck: 'Checked for complications / bleeding before leaving',
};

// Tourist services (hotel / foreign-currency). Urgent adds +$20 / +€15.
const TOURIST_SERVICES = {
  tourist_doctor: { code: 'tourist_doctor', name_en: 'Doctor visit to hotel room', name_ar: 'زيارة طبيب لغرفة الفندق', usd: 55, eur: 50 },
  tourist_iv: { code: 'tourist_iv', name_en: 'IV fluids / rehydration', name_ar: 'محاليل وريدية (إرواء)', usd: 75, eur: 65, riskLevel: 'standard' }, // v2.1.1 — explicitly STANDARD risk (owner decision 26 Nov 2026: tourist IV is NOT high-risk; only for language-qualified providers)
  tourist_dressing: { code: 'tourist_dressing', name_en: 'Wound dressing at hotel', name_ar: 'غيار جرح بالفندق', usd: 35, eur: 30 },
  tourist_nurse: { code: 'tourist_nurse', name_en: 'Nurse visit', name_ar: 'زيارة ممرض', usd: 30, eur: 25 },
};
const TOURIST_URGENT_EXTRA = { usd: 20, eur: 15 };
// Extra-language bonus per tourist visit in that language (certified only).
const EXTRA_LANGUAGE_BONUS = { usd: 15, eur: 15 };

// Commission: provider keeps the total, app takes % only.
// REVERSED (owner decision 26 Nov 2026 — "da awwal iqtirah ba'akkidlak
// 'aleih"): the more a provider develops, the LOWER their commission.
// Starter 15% / Pro 12% / Elite 8%. The old model (8/12/15) is abolished,
// and so is the fixed Elite monthly bonus of 1,200 EGP — replaced by the
// monthly volume bonus below (cash, paid with the Thursday settlement).
const TIERS = {
  Starter: { commission_pct: 15, monthly_bonus_egp: 0 },
  Pro: { commission_pct: 12, monthly_bonus_egp: 0 },
  Elite: { commission_pct: 8, monthly_bonus_egp: 0 },
};

// Monthly volume bonus (cash, from the app, paid with the Thursday
// settlement). Highest tier reached ONLY — never cumulative.
// Titles: 30 = "محترف موثّق", 60 = "الممرض الذهبي", 100 = "النجم المميز".
// v2.1.1 — thresholds lowered by owner delegation 26 Nov 2026:
// 15 cases -> 500, 30 -> 1,000, 60 -> 1,500 (highest only) + a weekly
// threshold: 5 cases in one ISO week = double points for that week.
const VOLUME_BONUS_TIERS = [
  { minCases: 15, bonusEgp: 500, title: 'محترف موثّق', titleEn: 'Verified Professional' },
  { minCases: 30, bonusEgp: 1000, title: 'الممرض الذهبي', titleEn: 'Golden Nurse' },
  { minCases: 60, bonusEgp: 1500, title: 'النجم المميز', titleEn: 'Star Performer' },
];
const WEEKLY_DOUBLE_THRESHOLD = 5; // cases in one ISO week -> weekly double points
const STAY_BONUS_EGP = 250; // 90-day stay bonus (see points.js)
const STAY_BONUS_DAYS = 90;
const STAY_BONUS_MIN_CASES = 10;

// Points system (owner-approved 26 Nov 2026, v2.1.1): 0–100 points.
// Interview up to 20, verified certificates +5 each (max 20), verified
// courses +5 each (max 15), completed cases +1 per 10 cases (max 25,
// weekly-double weeks count double), client rating average x4 (max 20).
// Tiers: 0–39 Starter (15%), 40–69 Pro (12%), 70+ Elite (8%).
const POINTS = {
  interview: { excellentMin: 30, excellentPts: 20, passPts: 15, manualReviewPts: 10 },
  certificateEach: 5, certificateMax: 20,
  courseEach: 5, courseMax: 15,
  casesPer10: 1, casesMax: 25,
  ratingMultiplier: 4, ratingMax: 20,
  tiers: [{ min: 0, tier: 'Starter' }, { min: 40, tier: 'Pro' }, { min: 70, tier: 'Elite' }],
};

// Patient loyalty vouchers (owner decision 26 Nov 2026): after every 4
// completed PAID visits, the patient auto-receives a 50 EGP voucher for
// the next visit. The app funds it in full — the provider's share is
// always computed on the FULL pre-discount price.
const VOUCHER_AMOUNT_EGP = 50;
const VOUCHER_MIN_BOOKING_EGP = 300;
const VOUCHER_VALID_DAYS = 60;
const VOUCHER_EVERY_N_VISITS = 4;

// ---------------------------------------------------------------- distance fee
// El Quseir bands (EGP), per SPEC §4. distance_km is a client-supplied
// ESTIMATE in v1 (no real GPS) or taken from the hotel record.
function distanceFee(distanceKm, transport) {
  const d = Number(distanceKm);
  if (!Number.isFinite(d) || d < 0) return { error: 'invalid_distance' };
  if (d > 35) return { contract_required: true, fee_egp: null, band: '>35km' };
  let fee;
  let band;
  if (d <= 6) { fee = 0; band = '0–6km'; }
  else if (d <= 10) { fee = 100; band = '6–10km'; }
  else if (d <= 20) { fee = 200; band = '10–20km'; }
  else if (d < 35) { fee = 350; band = '20–35km'; }
  else { fee = 500; band = '35km'; } // exactly 35km
  // Transport exception (SPEC §4): client provides transport.
  if (transport === 'roundtrip') fee = 0;
  else if (transport === 'oneway') fee = Math.round(fee * 0.5);
  return { contract_required: false, fee_egp: fee, band, transport: transport || 'none' };
}

function servicePriceEgp(serviceCode, opts = {}) {
  const s = SERVICES[serviceCode];
  if (!s) return null;
  if (serviceCode === 'assistant') {
    const years = Number(opts.experienceYears);
    if (!Number.isFinite(years) || years < 0) return null;
    const band = s.experience_bands.find((b) => years >= b.min_years && years <= b.max_years);
    return band ? band.price_egp : null;
  }
  // v2.1.13 price floor: no flat-priced service sells below 250 EGP.
  return Math.max(s.price_egp, MIN_SERVICE_PRICE_EGP);
}

// ---------------------------------------------------------------- hotels
// All 30 El Quseir properties from HOTELS-QUSEIR.md (24 Nov 2026).
// distance_km = midpoint of the published range; reference point = central
// El Quseir / Quseir Fort. rooms=null means "not published".
// contract_status: 'contracted' only for Mövenpick + Swissôtel (ex Radisson Blu).
const HOTELS = [
  { id: 'h01', name_en: 'Swissôtel Resort El Quseir', name_ar: 'سويس أوتيل القصير', zone: 'north', distance_km: 4, stars: 5, rooms: 250, contract_status: 'contracted', note: 'Formerly Radisson Blu — same property, do not double-count.' },
  { id: 'h02', name_en: 'Flamenco Beach & Resort', name_ar: 'فلامنكو بيتش آند ريزورت', zone: 'north', distance_km: 8, stars: 4, rooms: 295, contract_status: 'listed' },
  { id: 'h03', name_en: 'Silver Beach Boutique Hotel', name_ar: 'سيلفر بيتش بوتيك', zone: 'north', distance_km: 7, stars: 3, rooms: null, contract_status: 'listed' },
  { id: 'h04', name_en: 'Roots Red Sea', name_ar: 'روتس البحر الأحمر', zone: 'north', distance_km: 14, stars: null, rooms: 31, contract_status: 'listed', note: 'Eco dive resort, 31 units.' },
  { id: 'h05', name_en: 'Ecolodge Rocky Valley', name_ar: 'إيكولودج روكي فالي', zone: 'north', distance_km: 12.7, stars: null, rooms: null, contract_status: 'listed' },
  { id: 'h06', name_en: 'El Quseir Hotel', name_ar: 'فندق القصير', zone: 'centre', distance_km: 1, stars: 2.5, rooms: null, contract_status: 'listed', note: '138 Port Said St, city centre.' },
  { id: 'h07', name_en: 'Fanadir Holiday Resort', name_ar: 'فناذير هوليداي ريزورت', zone: 'centre', distance_km: 1.5, stars: null, rooms: null, contract_status: 'listed', note: 'Family bungalows, Al Gomhouria St.' },
  { id: 'h08', name_en: 'Sea Hug Resort', name_ar: 'سي هج ريزورت', zone: 'centre', distance_km: 1.5, stars: null, rooms: null, contract_status: 'listed' },
  { id: 'h09', name_en: 'Dolphin Continental Hotel', name_ar: 'دولفين كونتيننتال', zone: 'south', distance_km: 9.5, stars: 3, rooms: null, contract_status: 'listed', note: 'El Awina, 9–10 km south.' },
  { id: 'h10', name_en: 'Mövenpick Resort El Quseir', name_ar: 'موفنبيك القصير', zone: 'south', distance_km: 6, stars: 5, rooms: 250, contract_status: 'contracted', note: 'Old Quseir Bay.' },
  { id: 'h11', name_en: 'Rohanou Beach Resort & Ecolodge', name_ar: 'روهانو بيتش ريزورت', zone: 'south', distance_km: 10, stars: 4, rooms: 78, contract_status: 'listed' },
  { id: 'h12', name_en: 'Lazuli Hotel Marsa Alam', name_ar: 'لازولي مرسى علم', zone: 'south', distance_km: 15, stars: 5, rooms: 265, contract_status: 'listed' },
  { id: 'h13', name_en: 'Onatti Beach Resort', name_ar: 'أوناتي بيتش ريزورت', zone: 'south', distance_km: 16.5, stars: 4, rooms: 204, contract_status: 'listed' },
  { id: 'h14', name_en: 'Utopia Beach Club', name_ar: 'يوتوبيا بيتش كلوب', zone: 'south', distance_km: 21, stars: 4, rooms: 313, contract_status: 'listed' },
  { id: 'h15', name_en: 'Utopia Blue Resort', name_ar: 'يوتوبيا بلو ريزورت', zone: 'south', distance_km: 21, stars: 5, rooms: null, contract_status: 'listed', note: 'May be a sister section of the Utopia complex.' },
  { id: 'h16', name_en: 'Novotel Marsa Alam Beach Resort', name_ar: 'نوفوتيل مرسى علم', zone: 'south', distance_km: 20, stars: 5, rooms: 268, contract_status: 'listed' },
  { id: 'h17', name_en: 'Cinderella Beach Resort', name_ar: 'سندريلا بيتش ريزورت', zone: 'south', distance_km: 24, stars: 3.5, rooms: null, contract_status: 'listed' },
  { id: 'h18', name_en: 'Akassia Swiss Resort', name_ar: 'أكاسيا سويس ريزورت', zone: 'south', distance_km: 27.5, stars: 5, rooms: 444, contract_status: 'listed', note: 'Single complex incl. former Sentido/LTI Akassia.' },
  { id: 'h19', name_en: 'Mangrove Bay Resort', name_ar: 'مانجروف باي ريزورت', zone: 'south', distance_km: 29, stars: 3, rooms: 90, contract_status: 'listed' },
  { id: 'h20', name_en: 'Dreams Beach Resort Marsa Alam', name_ar: 'دريمز بيتش ريزورت', zone: 'south', distance_km: 32.5, stars: 4, rooms: null, contract_status: 'listed', note: 'Announced as opening soon (Oct 2026) — operating status unconfirmed.' },
  { id: 'h21', name_en: 'Life Resorts Coral Hills', name_ar: 'لايف ريزورتس كورال هيلز', zone: 'south', distance_km: 32.5, stars: 4, rooms: null, contract_status: 'listed', note: 'Life Resort / Coral Hills are the same complex.' },
  { id: 'h22', name_en: 'Diamond Beach by Pearl Resorts', name_ar: 'دايموند بيتش', zone: 'south', distance_km: 30, stars: null, rooms: null, contract_status: 'listed', note: 'Small lodge, distance approximate.' },
  { id: 'h23', name_en: 'Swisstouch Oriental Resort Marsa Alam', name_ar: 'سويس تاتش أورينتال', zone: 'south', distance_km: 35, stars: 4.5, rooms: null, contract_status: 'listed', note: 'Coraya Bay, km 35.' },
  { id: 'h24', name_en: 'Pickalbatros Sea World Resort – Marsa Alam', name_ar: 'بيك الباتروس سي وورلد', zone: 'south', distance_km: 37.5, stars: 5, rooms: 937, contract_status: 'listed', note: '35–40 km — beyond auto-pricing, special contract.' },
  { id: 'h25', name_en: 'Cleopatra Signature Resort Marsa Alam', name_ar: 'كليوباترا سيجنتشر', zone: 'south', distance_km: 43, stars: null, rooms: null, contract_status: 'listed', note: 'New hotel, 43 km — special contract only.' },
  { id: 'h26', name_en: 'Three Corners Sea Beach Resort', name_ar: 'ثري كورنرز سي بيتش', zone: 'south', distance_km: 62.5, stars: 4, rooms: 372, contract_status: 'listed', note: 'Coraya Bay, 60–65 km — southern boundary, special contract only.' },
  { id: 'h27', name_en: 'Steigenberger Coraya Beach (Adults Only)', name_ar: 'شتيجنبرجر كورايا بيتش', zone: 'border', distance_km: 67, stars: 5, rooms: null, contract_status: 'listed', note: 'Outside daily range (>1 hour).' },
  { id: 'h28', name_en: 'TUI MAGIC LIFE Kalawy', name_ar: 'توي ماجيك لايف كالاوي', zone: 'border', distance_km: 50, stars: 4, rooms: 537, contract_status: 'listed', note: 'Km 30 Safaga–Quseir road, 50 km north — too far for VIP 20–30 min promise.' },
  { id: 'h29', name_en: 'Coral Sun Beach', name_ar: 'كورال صن بيتش', zone: 'border', distance_km: 57.5, stars: null, rooms: null, contract_status: 'listed', note: 'Distance disputed between sources — needs field verification.' },
  { id: 'h30', name_en: 'SeaSoul Luxury Apartments / Sea View Apartments', name_ar: 'سي سول للشقق الفندقية', zone: 'centre', distance_km: 2, stars: null, rooms: null, contract_status: 'listed', note: 'Serviced apartments, not a conventional B2B hotel contract.' },
];

// v2.1.1 — expanded interview bank (owner-approved 26 Nov 2026):
// Bank of 54 common questions (medical 12 / ethics 11 / safety 9 /
// communication 9 / resilience 7 / conduct 6) + 9 role-specific
// questions per role (assistant / nurse / doctor / physio): 3 medical +
// 2 ethics + 2 safety + 1 communication + 1 resilience each = 90 in
// total. Each attempt SAMPLES 36 by dimension quota (medical 8 /
// ethics 7 / safety 6 / communication 6 / resilience 5 / conduct 4).
// 13 of the 90 are RED-FLAG questions (redFlagOption): choosing the
// dangerous option fails the attempt instantly, whatever the score.
// `correct` and `redFlagOption` are NEVER sent to the client.
// v2.1.13 (H15): the 90-question rotating bank IS Phase 2, shipped
// now — 54 common + 9 per role; each attempt samples a random 36 by
// dimension quota (medical 8 / ethics 7 / safety 6 / communication 6 /
// resilience 5 / conduct 4) from INTERVIEW-EXPANDED-PROPOSAL.md.
const INTERVIEW_DIMENSIONS = [
  { key: 'medical', nameAr: 'الكفاءة الطبية', nameEn: 'Medical competence', questions: 8, min: 5 },
  { key: 'ethics', nameAr: 'الأخلاقيات والاحترافية', nameEn: 'Ethics & professionalism', questions: 7, min: 5 },
  { key: 'safety', nameAr: 'السلامة والحكم العملي', nameEn: 'Safety & judgement', questions: 6, min: 4 },
  { key: 'communication', nameAr: 'التواصل', nameEn: 'Communication', questions: 6, min: null },
  { key: 'resilience', nameAr: 'الصلابة النفسية', nameEn: 'Resilience', questions: 5, min: null },
  { key: 'conduct', nameAr: 'الالتزام والسلوك المهني', nameEn: 'Conduct', questions: 4, min: null },
];
const INTERVIEW_COMMON = [{"id":"m1","category":"medical","text":"مريض فاقد للوعي ولا يتنفس بشكل طبيعي في بيته. ماذا تفعل أولًا؟","options":[{"key":"a","text":"أبدأ علاجه في البيت وأنتظر حتى يتحسن وحده."},{"key":"b","text":"أتصل بالإسعاف 123 فورًا، وأبدأ الإنعاش القلبي الرئوي إن كنت مدرّبًا عليه، وأبقيه في وضع آمن."},{"key":"c","text":"أعطيه ماءً وسكرًا وأتركه نائمًا."},{"key":"d","text":"أتصل بأسرته فقط وأنتظر وصولهم."}],"correct":"b","redFlagOption":"a"},{"id":"m2","category":"medical","text":"تقيس الضغط لمريض فتجد 180/110 والنبض 120. ماذا تفعل؟","options":[{"key":"a","text":"تسجلها فقط وتغادر."},{"key":"b","text":"تعيد القياس للتأكد، وتسأل عن الأعراض، وتبلغ الطبيب أو الإدارة فورًا حسب البروتوكول."},{"key":"c","text":"تعطي دواء ضغط من عندك."},{"key":"d","text":"تطمئن المريض بأن كل شيء طبيعي."}],"correct":"b"},{"id":"m3","category":"medical","text":"أثناء محلول وريدي ظهر طفح جلدي وضيق نفس على المريض. ماذا تفعل؟","options":[{"key":"a","text":"تكمل الدواء حتى ينتهي المحلول."},{"key":"b","text":"توقف الدواء فورًا، وتقيّم مجرى الهواء والتنفس، وتطلب إسعافًا أو طبيبًا فورًا، وتوثق الحدث."},{"key":"c","text":"تعطي دواءً آخر من عندك لتهدئة الطفح."},{"key":"d","text":"تطلب من المريض الانتظار حتى يتحسن وحده."}],"correct":"b","redFlagOption":"a"},{"id":"m4","category":"medical","text":"ما أول إجراء عند نزيف خارجي شديد من جرح؟","options":[{"key":"a","text":"تنظيف الجرح أولًا."},{"key":"b","text":"الضغط المباشر على الجرح لوقف النزيف، وطلب المساعدة الطبية."},{"key":"c","text":"رفع المريض واقفًا."},{"key":"d","text":"وضع الثلج فقط."}],"correct":"b"},{"id":"m5","category":"medical","text":"مريض سكري لديه جرح قدم، وتلاحظ رائحة كريهة وإفرازات. ما التصرف الصحيح؟","options":[{"key":"a","text":"تغطي الجرح فقط وتغادر."},{"key":"b","text":"تقيّم الجرح، وتوثق العلامات، وتبلغ الطبيب أو الإدارة فورًا، وتتبع بروتوكول الغيار المعتمد."},{"key":"c","text":"تضع مرهمًا من عندك دون توثيق."},{"key":"d","text":"تطلب من المريض الانتظار أسبوعًا."}],"correct":"b"},{"id":"m6","category":"medical","text":"مريض يطلب منك تشخيص طفح جلدي لديه ووصف مضاد حيوي له. ماذا تفعل؟","options":[{"key":"a","text":"تشخّص الطفح وتصف له المضاد الحيوي بنفسك."},{"key":"b","text":"توضح له أن التشخيص ووصف الدواء خارج نطاق دورك، وتوثق ملاحظاتك وتحيله للطبيب أو الإدارة."},{"key":"c","text":"تعطيه أي دواء متوفر معك."},{"key":"d","text":"تتجاهل طلبه تمامًا دون شرح."}],"correct":"b","redFlagOption":"a"},{"id":"e1","category":"ethics","text":"بعد الزيارة، أسرة المريض تطلب منك صورة الجرح \"لترسلها لأقاربهم على واتساب\". ماذا تفعل؟","options":[{"key":"a","text":"ترسل الصورة لهم فورًا."},{"key":"b","text":"ترفض بأدب: صور المرضى سرية ولا تُرسَل إلا عبر تقرير التطبيق الرسمي وبموافقة المريض."},{"key":"c","text":"تنشر الصورة في مجموعة العمل أولًا."},{"key":"d","text":"ترسلها من هاتفك الشخصي دون توثيق."}],"correct":"b","redFlagOption":"a"},{"id":"e2","category":"ethics","text":"مريض يعرض عليك مالًا نقديًا \"خارج التطبيق\" مقابل أن تأتيه مباشرة دون حجز. ماذا تفعل؟","options":[{"key":"a","text":"تقبل المال وتذهب إليه مباشرة."},{"key":"b","text":"ترفض وتوضح أن كل الحجز والدفع عبر التطبيق لحماية الطرفين."},{"key":"c","text":"تقبل المال ولا تخبر أحدًا."},{"key":"d","text":"تطلب مبلغًا أكبر مقابل الزيارة."}],"correct":"b","redFlagOption":"a"},{"id":"e3","category":"ethics","text":"زميل يطلب منك توقيع تقرير زيارة لم تحضرها، أو تسجيل علامات حيوية لم تقسها. ماذا تفعل؟","options":[{"key":"a","text":"توقع، لأنها مجاملة بسيطة."},{"key":"b","text":"ترفض؛ التوقيع على ما لم تفعله أو تسجيل قياسات لم تقسها تزوير."},{"key":"c","text":"توقع وتكتب ملاحظة صغيرة."},{"key":"d","text":"تطلب منه مالًا مقابل التوقيع."}],"correct":"b","redFlagOption":"a"},{"id":"e4","category":"ethics","text":"مريض يطلب منك أن تخبر أسرته بتشخيصه دون علمه. ماذا تفعل؟","options":[{"key":"a","text":"تخبر الأسرة فورًا لأنهم يدفعون."},{"key":"b","text":"ترفض وتشرح للمريض حقه في الخصوصية، وتطلب موافقته أولًا."},{"key":"c","text":"تخبر الأسرة جزئيًا فقط."},{"key":"d","text":"تتجاهل الطلب ولا ترد."}],"correct":"b"},{"id":"e5","category":"ethics","text":"وجدت محفظة مريض في بيته بعد الزيارة. ماذا تفعل؟","options":[{"key":"a","text":"تتركها مكانها وتبلغ المريض والإدارة فورًا."},{"key":"b","text":"تأخذها معك وتعيدها في الزيارة القادمة."},{"key":"c","text":"تفتحها لتعرف صاحبها."},{"key":"d","text":"لا تهتم، ليست مسؤوليتك."}],"correct":"a"},{"id":"e6","category":"ethics","text":"مريض يعرض عليك مالًا إضافيًا مقابل أولوية في الحجز. ماذا تفعل؟","options":[{"key":"a","text":"تقبله، فهذا حقه."},{"key":"b","text":"ترفض بلطف وتشرح أن الحجز حسب النظام للجميع."},{"key":"c","text":"تقبله ولا تخبر أحدًا."},{"key":"d","text":"تطلب مبلغًا أكبر."}],"correct":"b"},{"id":"s1","category":"safety","text":"وصلت بيت مريض ووجدت الباب مفتوحًا وأصوات شجار عنيف بالداخل. ماذا تفعل؟","options":[{"key":"a","text":"تدخل فورًا لتبدأ الزيارة كالمعتاد."},{"key":"b","text":"لا تدخل — تبتعد لمكان آمن، وتتصل بالإدارة، وتضغط SOS، وتتصل بالشرطة 122 إن لزم."},{"key":"c","text":"تدخل وتحاول فض الشجار بنفسك."},{"key":"d","text":"تنتظر أمام الباب حتى يهدأ الشجار ثم تدخل."}],"correct":"b","redFlagOption":"a"},{"id":"s2","category":"safety","text":"قبل غيار جرح ملتهب، ما أهم خطوة لمكافحة العدوى؟","options":[{"key":"a","text":"ارتداء أي ملابس متوفرة."},{"key":"b","text":"غسل اليدين واستخدام قفاز معقم وأدوات معقمة."},{"key":"c","text":"فتح النافذة فقط."},{"key":"d","text":"العمل بسرعة دون تجهيز."}],"correct":"b"},{"id":"s3","category":"safety","text":"بعد الزيارة، أين تتخلص من الإبر والأدوات الحادة المستخدمة؟","options":[{"key":"a","text":"في سلة المهملات العادية بالبيت."},{"key":"b","text":"في حاوية مخصصة للأدوات الحادة، وتتبع بروتوكول التخلص الآمن."},{"key":"c","text":"تتركها في البيت للمريض."},{"key":"d","text":"ترميها في الشارع."}],"correct":"b"},{"id":"s4","category":"safety","text":"لاحظت أن أدوات الغيار المتوفرة غير معقمة، والمريض ينتظرك. ماذا تفعل؟","options":[{"key":"a","text":"تستخدمها كما هي حتى لا يتأخر المريض."},{"key":"b","text":"لا تستخدمها — تستخدم أدوات معقمة من حقيبتك أو تؤجل الغيار وتبلغ الإدارة."},{"key":"c","text":"تستخدمها وتخبر المريض أنها نظيفة."},{"key":"d","text":"تغسلها بالماء فقط وتستخدمها."}],"correct":"b","redFlagOption":"a"},{"id":"s5","category":"safety","text":"بعد الزيارة، أين توثّق العلامات الحيوية وملاحظاتك؟","options":[{"key":"a","text":"في ورقة تتركها في البيت."},{"key":"b","text":"في تقرير الزيارة داخل التطبيق فورًا قبل المغادرة."},{"key":"c","text":"في رسالة واتساب لأحد أقاربك."},{"key":"d","text":"لا توثقها؛ يكفي أنك تذكرها."}],"correct":"b"},{"id":"c1","category":"communication","text":"سائح ألماني لا يتكلم العربية ولا الإنجليزية جيدًا، ويشير إلى موضع ألم. ماذا تفعل؟","options":[{"key":"a","text":"تتركه وتغادر."},{"key":"b","text":"تستخدم لغة الإشارة والصور، وتتكلم إنجليزية بسيطة، وتطلب مساعدة الإدارة بمترجم إن لزم."},{"key":"c","text":"تتكلم معه بالعربية بصوت أعلى."},{"key":"d","text":"تطلب منه أن يكتب شكواه بالألمانية فقط."}],"correct":"b"},{"id":"c2","category":"communication","text":"مريضة مسنّة قلقة وتبكي قبل الغيار. ما أول خطوة؟","options":[{"key":"a","text":"تبدأ الغيار فورًا لتوفير الوقت."},{"key":"b","text":"تهدئها، وتشرح لها الخطوات ببساطة، وتطلب إذنها قبل البدء."},{"key":"c","text":"تطلب من أسرتها إخراجها من الغرفة."},{"key":"d","text":"تتجاهل بكاءها."}],"correct":"b"},{"id":"c3","category":"communication","text":"أسرة المريض تتحدث بلهجة وعادات مختلفة عنك وتسأل كثيرًا. كيف تتصرف؟","options":[{"key":"a","text":"تتعامل باحترام وتجيب بهدوء، وتتأقلم مع أسلوبهم دون أحكام."},{"key":"b","text":"تخبرهم أن أسلوبهم غريب."},{"key":"c","text":"ترفض الإجابة لأنها ليست من عملك."},{"key":"d","text":"تسخر من لهجتهم."}],"correct":"a"},{"id":"c4","category":"communication","text":"مريض لا يفهم المصطلحات الطبية. كيف تشرح له؟","options":[{"key":"a","text":"تستخدم كلمات أبسط وأمثلة من حياته اليومية، وتتأكد من فهمه."},{"key":"b","text":"تكرر نفس المصطلحات بصوت أعلى."},{"key":"c","text":"تعطيه ورقة طبية إنجليزية وتتركه."},{"key":"d","text":"تطلب منه أن يبحث بنفسه."}],"correct":"a"},{"id":"c5","category":"communication","text":"مريض من جنسية أو دين أو مستوى مادي مختلف يطلب رعاية منزلية. ماذا تفعل؟","options":[{"key":"a","text":"ترفض تقديم الرعاية بسبب جنسيته أو دينه أو مستواه المادي."},{"key":"b","text":"تقدم له نفس الرعاية باحترام كامل، دون أي تمييز."},{"key":"c","text":"تقدم له رعاية أقل لأنه مختلف عنك."},{"key":"d","text":"تطلب منه مالًا إضافيًا مقابل خدمته."}],"correct":"b","redFlagOption":"a"},{"id":"r1","category":"resilience","text":"مريض غاضب يرفع صوته عليك بسبب تأخير. ماذا تفعل؟","options":[{"key":"a","text":"ترفع صوتك عليه بالمثل."},{"key":"b","text":"تحافظ على هدوئك، وتستمع، وتعتذر عن التأخير، وتشرح الحل."},{"key":"c","text":"تترك البيت فورًا."},{"key":"d","text":"تهدده بإلغاء الخدمة."}],"correct":"b"},{"id":"r2","category":"resilience","text":"وردية ليلية (22:00–06:00) واتصال طارئ وأنت متعب جدًا. ماذا تفعل؟","options":[{"key":"a","text":"تذهب مرهقًا وتقود السيارة وأنت نعسان."},{"key":"b","text":"تقيّم حالتك بصدق: إن كنت غير قادر على العمل بأمان تبلغ الإدارة فورًا ليجدوا بديلًا، ولا تقود مرهقًا."},{"key":"c","text":"تتجاهل الاتصال تمامًا."},{"key":"d","text":"تذهب دون إخبار أحد بحالتك."}],"correct":"b"},{"id":"r3","category":"resilience","text":"بعد زيارة صعبة شعرت بالإحباط. ماذا تفعل؟","options":[{"key":"a","text":"تستقيل فورًا."},{"key":"b","text":"تراجع ما حدث وتتعلم منه وتطلب دعمًا من الإدارة أو زملائك."},{"key":"c","text":"تلوم المريض على كل شيء."},{"key":"d","text":"تتوقف عن توثيق الزيارات."}],"correct":"b"},{"id":"r4","category":"resilience","text":"مريض يرفض إجراءً تمريضيًا ضروريًا بعد شرحه له. ماذا تفعل؟","options":[{"key":"a","text":"تنفذه بالقوة لمصلحته."},{"key":"b","text":"تحترم رفضه بعد التأكد من فهمه، وتوثق الرفض وتبلغ الطبيب أو الإدارة."},{"key":"c","text":"تتركه دون توثيق."},{"key":"d","text":"تهدده بوقف الخدمة."}],"correct":"b"},{"id":"f1","category":"conduct","text":"تأخرت عن موعد زيارة منزلية. ما التصرف الصحيح؟","options":[{"key":"a","text":"تذهب متأخرًا دون إخبار أحد."},{"key":"b","text":"تتصل بالمريض وتعتذر وتبلغه بالوقت الجديد، وتبلغ الإدارة."},{"key":"c","text":"تلغي الزيارة دون إخبار."},{"key":"d","text":"تطلب من مريض آخر أن ينتظرك."}],"correct":"b"},{"id":"f2","category":"conduct","text":"عميل يطلب رقم هاتفك الشخصي للتواصل المباشر خارج التطبيق. ماذا تفعل؟","options":[{"key":"a","text":"تعطيه رقمك الشخصي فورًا."},{"key":"b","text":"توجهه للتواصل عبر التطبيق فقط، وتوضح أن ذلك لحماية الطرفين."},{"key":"c","text":"تعطيه رقم زميلك."},{"key":"d","text":"توافق بشرط أن يدفع نقدًا."}],"correct":"b"},{"id":"f3","category":"conduct","text":"أثناء الزيارة تدهورت حالة المريض فجأة وأنت وحدك معه. ماذا تفعل؟","options":[{"key":"a","text":"تتركه وحده وتغادر البيت."},{"key":"b","text":"تبقى معه، وتتصل بالإسعاف 123 فورًا، وتبلغ الإدارة، ولا تغادر حتى يصل المسعفون أو يستقر وضعه."},{"key":"c","text":"تغادر لإحضار المساعدة وتتركه دون إشراف."},{"key":"d","text":"تنتظر حتى يتحسن وحده."}],"correct":"b","redFlagOption":"a"},{"id":"f4","category":"conduct","text":"بعد انتهاء الزيارة، الأسرة تقدم لك طعامًا أو شرابًا. ماذا تفعل؟","options":[{"key":"a","text":"ترفض بطريقة مهينة."},{"key":"b","text":"تشكرهم بلطف، وتقبل أو تعتذر بذوق حسب الموقف، دون أن يؤثر ذلك على عملك."},{"key":"c","text":"تطلب المزيد."},{"key":"d","text":"تأكل وتتأخر عن زيارتك التالية."}],"correct":"b"},{"id":"m7","category":"medical","text":"تقيس السكر لمريض سكري فتجده 45 ملغ/دل وهو واعٍ ويستطيع البلع. ماذا تفعل؟","options":[{"key":"a","text":"تعطيه جرعة أنسولين فورًا لخفض السكر أكثر."},{"key":"b","text":"تعطيه سكرًا سريعًا (عصير أو جلوكوز)، ثم تعيد القياس بعد 15 دقيقة وتبلغ الطبيب."},{"key":"c","text":"تتركه نائمًا حتى يستيقظ وحده."},{"key":"d","text":"تعطيه ماءً فقط وتغادر."}],"correct":"b","redFlagOption":"a"},{"id":"m8","category":"medical","text":"مريض بعد عملية جراحية يشتكي من ألم شديد مفاجئ في الساق مع تورم واحمرار. ماذا تفعل؟","options":[{"key":"a","text":"تقيّم الساق، ولا تدلكها، وتبلغ الطبيب فورًا لاحتمال جلطة وريدية، وتوثق ملاحظاتك."},{"key":"b","text":"تطلب منه المشي مسافة طويلة فورًا."},{"key":"c","text":"تعطيه مسكنًا من عندك وتغادر."},{"key":"d","text":"تدلك الساق بقوة لتحسين الدورة الدموية."}],"correct":"a"},{"id":"m9","category":"medical","text":"مريض مسنّ سقط في الحمام ولا يستطيع الوقوف ويشتكي من ألم في الفخذ. ماذا تفعل؟","options":[{"key":"a","text":"تتركه على الأرض وتغادر."},{"key":"b","text":"تعطيه مسكنًا وتنتظر ساعة."},{"key":"c","text":"تسحبه واقفًا فورًا حتى لا يتأخر عن موعده."},{"key":"d","text":"لا تحركه بعنف، وتقيّم وعيه والألم، وتطلب الإسعاف أو الطبيب فورًا لاحتمال كسر، وتوثق الحدث."}],"correct":"d"},{"id":"m10","category":"medical","text":"أثناء غيار جرح تلاحظ نزيفًا لا يتوقف بالضغط المباشر لمدة 10 دقائق. ماذا تفعل؟","options":[{"key":"a","text":"تطلب من المريض الضغط بنفسه وتذهب لزيارة أخرى."},{"key":"b","text":"تغطي الجرح وتغادر وتطلب من الأسرة الانتظار."},{"key":"c","text":"تستمر في الضغط المباشر، وتطلب مساعدة طبية عاجلة، وتوثق كمية النزيف والوقت."},{"key":"d","text":"تضع مرهمًا فوق النزيف."}],"correct":"c"},{"id":"m11","category":"medical","text":"مريض يأخذ أدوية سيولة وظهرت عليه كدمات كبيرة دون سبب واضح. ماذا تفعل؟","options":[{"key":"a","text":"توقف دواء السيولة بنفسك فورًا."},{"key":"b","text":"توثق الكدمات وأماكنها، وتبلغ الطبيب أو الإدارة فورًا، ولا توقف أي دواء من عندك."},{"key":"c","text":"تطمئنه بأن الكدمات طبيعية وتغادر."},{"key":"d","text":"تطلب منه التوقف عن الحركة تمامًا لأسبوع."}],"correct":"b"},{"id":"m12","category":"medical","text":"مريض يعاني من ضيق نفس شديد وصوت صفير مع زرقة في الشفاه. ماذا تفعل؟","options":[{"key":"a","text":"تجلسه في وضع مريح، وتتصل بالإسعاف 123 فورًا، وتعطي الأكسجين فقط إن كان موصوفًا ومتاحًا."},{"key":"b","text":"تعطيه ماءً باردًا وتطلب منه النوم على ظهره."},{"key":"c","text":"تغادر لتتصل بأسرته أولًا."},{"key":"d","text":"تنتظر حتى يتحسن وحده."}],"correct":"a"},{"id":"e7","category":"ethics","text":"مريض يطلب منك رقم هاتف ممرض آخر كان يزوره ليتواصل معه مباشرة خارج التطبيق. ماذا تفعل؟","options":[{"key":"a","text":"تعطيه رقمًا وهميًا."},{"key":"b","text":"تطلب منه مالًا مقابل الرقم."},{"key":"c","text":"تعطيه الرقم فورًا، فهو حقه."},{"key":"d","text":"ترفض بأدب وتوضح أن كل التواصل والحجز عبر التطبيق لحماية الطرفين."}],"correct":"d"},{"id":"e8","category":"ethics","text":"مريض يعرض عليك هدية مالية كبيرة بعد زيارة ناجحة. ماذا تفعل؟","options":[{"key":"a","text":"تطلب هدية أكبر."},{"key":"b","text":"تقبلها وتتفق معه على زيارات مباشرة خارج التطبيق."},{"key":"c","text":"تشكره وترفض بأدب، وتوضح أن أجرك عبر التطبيق فقط وأن قبول المال خارج التطبيق ممنوع."},{"key":"d","text":"تقبلها سرًا ولا تخبر أحدًا."}],"correct":"c","redFlagOption":"b"},{"id":"e9","category":"ethics","text":"تكتشف أن زميلًا يسجّل زيارات لم تتم ليحصل على أجرها. ماذا تفعل؟","options":[{"key":"a","text":"تسكت، فهذا ليس شأنك."},{"key":"b","text":"تبلغ الإدارة بالأدلة التي رأيتها، ولا تشارك في التسجيل الكاذب."},{"key":"c","text":"تطلب منه أن يسجل زيارات باسمك أيضًا."},{"key":"d","text":"تسجل زيارة كاذبة مثله."}],"correct":"b"},{"id":"e10","category":"ethics","text":"مريض يطلب منك عدم إخبار أسرته بمعلومة طبية مهمة تخص سلامته. ماذا تفعل؟","options":[{"key":"a","text":"تحترم خصوصيته، وتشرح له حدود ذلك، وتوثق طلبه، وتبلغ الطبيب أو الإدارة إن كانت سلامته في خطر."},{"key":"b","text":"تتجاهل المعلومة تمامًا ولا توثقها."},{"key":"c","text":"تخبر الجيران بالمعلومة."},{"key":"d","text":"تخبر أسرته فورًا دون إذنه."}],"correct":"a"},{"id":"e11","category":"ethics","text":"أسرة مريض تطلب منك البقاء لساعات إضافية دون حجز أو أجر. ماذا تفعل؟","options":[{"key":"a","text":"تغادر غاضبًا دون شرح."},{"key":"b","text":"تطلب مالًا نقديًا مقابل البقاء."},{"key":"c","text":"تبقى مجانًا كل مرة حتى لا تغضب الأسرة."},{"key":"d","text":"توضح بأدب أن أي وقت إضافي يحتاج حجزًا عبر التطبيق، وتعرض ترتيب ذلك مع الإدارة."}],"correct":"d"},{"id":"s6","category":"safety","text":"تدخل بيت مريض وتلاحظ وجود كلب شرس غير مقيد. ماذا تفعل؟","options":[{"key":"a","text":"تلغي الزيارة دون إخبار أحد."},{"key":"b","text":"تدخل فورًا وتتجاهل الكلب."},{"key":"c","text":"لا تدخل، وتطلب من الأسرة تقييد الكلب أو إبعاده أولًا، وتبلغ الإدارة إن تعذر ذلك."},{"key":"d","text":"تضرب الكلب لتبعده."}],"correct":"c"},{"id":"s7","category":"safety","text":"أثناء زيارة، انقطع التيار الكهربائي وجهاز المريض يعمل بالكهرباء. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهل الأمر وتكمل الزيارة كأن شيئًا لم يحدث."},{"key":"b","text":"تتبع بروتوكول الجهاز الاحتياطي، وتطمئن المريض، وتتصل بالإدارة أو الطبيب فورًا."},{"key":"c","text":"تحاول إصلاح الكهرباء بنفسك."},{"key":"d","text":"تفصل الجهاز وتغادر."}],"correct":"b"},{"id":"s8","category":"safety","text":"تلاحظ أن قارورة محلول وريدي انتهت صلاحيتها. ماذا تفعل؟","options":[{"key":"a","text":"لا تستخدمها إطلاقًا، وتستبدلها بقارورة صالحة، وتوثق الواقعة وتبلغ الإدارة."},{"key":"b","text":"تستخدم نصفها فقط."},{"key":"c","text":"تخفي تاريخ الصلاحية عن المريض وتستخدمها."},{"key":"d","text":"تستخدمها لأنها تبدو سليمة."}],"correct":"a","redFlagOption":"d"},{"id":"s9","category":"safety","text":"مريض يرفض غيار جرحه رغم شرحك لأهميته. ماذا تفعل؟","options":[{"key":"a","text":"تغادر دون توثيق."},{"key":"b","text":"تهدد المريض بأن الجرح سيتدهور."},{"key":"c","text":"تغير الجرح بالقوة رغم رفضه."},{"key":"d","text":"تحترم رفضه، وتشرح المخاطر بهدوء، وتوثق الرفض، وتبلغ الطبيب أو الإدارة."}],"correct":"d"},{"id":"c6","category":"communication","text":"مريض لا يتكلم العربية ولا الإنجليزية ويحتاج شرحًا بسيطًا للإجراء. ماذا تفعل؟","options":[{"key":"a","text":"تلغي الزيارة دون محاولة."},{"key":"b","text":"تتجاهل الشرح وتبدأ الإجراء فورًا."},{"key":"c","text":"تستخدم إيماءات بسيطة أو تطبيق ترجمة، وتتأكد من فهمه قبل البدء، وتوثق ذلك."},{"key":"d","text":"تتحدث معه بصوت عالٍ بالعربية."}],"correct":"c"},{"id":"c7","category":"communication","text":"أسرة مريض غاضبة وتصرخ في وجهك بسبب تأخرك. ماذا تفعل؟","options":[{"key":"a","text":"تصرخ في وجههم أيضًا."},{"key":"b","text":"تبقى هادئًا، وتعتذر عن التأخير، وتشرح السبب باختصار، وتهدئ الموقف قبل بدء العمل."},{"key":"c","text":"تغادر فورًا دون كلمة."},{"key":"d","text":"تتهمهم بالكذب."}],"correct":"b"},{"id":"c8","category":"communication","text":"مريض مسنّ ضعيف السمع لا يفهم تعليماتك. ماذا تفعل؟","options":[{"key":"a","text":"تتكلم ببطء ووجهك نحوه، وتكتب التعليمات المهمة، وتتأكد من فهمه."},{"key":"b","text":"تتجاهل التعليمات تمامًا."},{"key":"c","text":"تصرخ في أذنه."},{"key":"d","text":"تتحدث بسرعة وتغادر."}],"correct":"a"},{"id":"c9","category":"communication","text":"مريض يسألك عن تشخيص حالته وأنت غير مخوّل بالتشخيص. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهل سؤاله."},{"key":"b","text":"تخمن تشخيصًا من الإنترنت."},{"key":"c","text":"تشخّص حالته بنفسك لتطمئنه."},{"key":"d","text":"توضح أن التشخيص دور الطبيب، وتوثق ملاحظاتك، وتحيله للطبيب أو الإدارة."}],"correct":"d"},{"id":"r5","category":"resilience","text":"جدولك ممتلئ وطلب منك حجز إضافي عاجل في نهاية يوم طويل. ماذا تفعل؟","options":[{"key":"a","text":"تقبل الحجز وتذهب نائمًا."},{"key":"b","text":"تقبل كل حجز مهما كنت مرهقًا."},{"key":"c","text":"تقيّم قدرتك بصدق، وتنسق مع الإدارة لتغطية الحجز بأمان، ولا تقبل ما يعرّض المريض للخطر."},{"key":"d","text":"ترفض دون إخبار الإدارة."}],"correct":"c"},{"id":"r6","category":"resilience","text":"تعرضت لموقف محرج مع مريض وأثر فيك نفسيًا. ماذا تفعل؟","options":[{"key":"a","text":"تكتم الأمر وتستمر كأن شيئًا لم يحدث."},{"key":"b","text":"توثق ما حدث، وتتحدث مع الإدارة أو زميل دعم، وتعتني بنفسك قبل الزيارة التالية."},{"key":"c","text":"تصب غضبك على المريض التالي."},{"key":"d","text":"تترك العمل دون إخبار أحد."}],"correct":"b"},{"id":"r7","category":"resilience","text":"فقدت مريضًا كنت تتابعه رغم بذلك كل ما تستطيع. كيف تتعامل؟","options":[{"key":"a","text":"تراجع ما حدث بهدوء مع الإدارة، وتوثق، وتطلب الدعم، وتتعلم دون تحميل نفسك ما فوق طاقتك."},{"key":"b","text":"تخفي الوفاة عن الإدارة."},{"key":"c","text":"تتهم أسرة المريض."},{"key":"d","text":"تلوم نفسك وحدك وتتوقف عن العمل."}],"correct":"a"},{"id":"f5","category":"conduct","text":"تصل إلى بيت مريض وتكتشف أنك نسيت أداة مهمة في سيارتك. ماذا تفعل؟","options":[{"key":"a","text":"تتظاهر بأنك أكملت العمل."},{"key":"b","text":"تغادر دون إخبار المريض."},{"key":"c","text":"تستخدم أداة غير مناسبة من البيت."},{"key":"d","text":"تخبر المريض، وتجلب الأداة أو تعيد ترتيب الزيارة بأمان، ولا تبدأ بأدوات غير مناسبة."}],"correct":"d"},{"id":"f6","category":"conduct","text":"مريض يطلب منك خدمة خارج نطاق التمريض (مثل إصلاح جهاز منزلي). ماذا تفعل؟","options":[{"key":"a","text":"تكسر الجهاز أكثر."},{"key":"b","text":"تصلح الجهاز رغم أنك غير مختص."},{"key":"c","text":"ترفض بأدب، وتوضح أن دورك تمريضي فقط، وتبقى في نطاق عملك."},{"key":"d","text":"تطلب مالًا إضافيًا مقابل الإصلاح."}],"correct":"c"}];
const INTERVIEW_ROLE_QUESTIONS = {"assistant":[{"id":"am1","category":"medical","text":"كمساعد تمريض، قست العلامات الحيوية لمريض فوجدت نبضه 130 وضغطه 160/100. ماذا تفعل؟","options":[{"key":"a","text":"تسجلها فقط وتغادر."},{"key":"b","text":"تسجلها بدقة وتبلغ الممرض أو الطبيب المسؤول فورًا، ولا تقرر علاجًا بنفسك."},{"key":"c","text":"تعطيه دواء ضغط من حقيبتك."},{"key":"d","text":"تطمئنه أن كل شيء طبيعي."}],"correct":"b"},{"id":"am2","category":"medical","text":"مريض يطلب منك إعطاءه دواءً وريديًا. ماذا تفعل؟","options":[{"key":"a","text":"تعطيه الدواء فورًا."},{"key":"b","text":"ترفض بأدب: إعطاء الأدوية الوريدية خارج نطاق دورك، وتصعّد الأمر للممرض أو الطبيب."},{"key":"c","text":"تعطيه نصف الجرعة فقط."},{"key":"d","text":"تطلب من أسرته إعطاءه الدواء."}],"correct":"b"},{"id":"ae1","category":"ethics","text":"مريض يسألك عن حالة مريض آخر تعرفه، ويضغط عليك للإجابة. ماذا تفعل؟","options":[{"key":"a","text":"تخبره بكل التفاصيل."},{"key":"b","text":"تعتذر بلطف وتشرح أن معلومات المرضى سرية، وتبقى ثابتًا رغم الضغط."},{"key":"c","text":"تخبره جزئيًا."},{"key":"d","text":"تخبره إذا كان قريبًا."}],"correct":"b"},{"id":"as1","category":"safety","text":"قبل تجهيز أدوات غيار، ما أول خطوة؟","options":[{"key":"a","text":"تجهز الأدوات على أي سطح متوفر."},{"key":"b","text":"تغسل يديك، وتجهز سطحًا نظيفًا وأدوات معقمة، وتتأكد من سلامة الأدوات."},{"key":"c","text":"تطلب من المريض تجهيز الأدوات."},{"key":"d","text":"تبدأ الغيار دون تجهيز."}],"correct":"b"},{"id":"ac1","category":"communication","text":"مريضة مسنّة لا تسمع جيدًا وتحتاج شرحًا قبل قياس الضغط. كيف تتصرف؟","options":[{"key":"a","text":"تصرخ في وجهها."},{"key":"b","text":"تتكلم بوضوح وببطء قريبًا منها، وتستخدم الإشارة، وتتأكد من فهمها."},{"key":"c","text":"تتجاهلها وتقيس الضغط دون شرح."},{"key":"d","text":"تطلب من أسرتها إخراجها."}],"correct":"b"},{"id":"ar1","category":"resilience","text":"يومك طويل وفيه زيارات كثيرة متتالية وأنت مرهق. ماذا تفعل؟","options":[{"key":"a","text":"تتخطى توثيق الزيارات لتوفير الوقت."},{"key":"b","text":"تلتزم ببروتوكول كل زيارة وتوثيقها، وتبلغ الإدارة إن شعرت أنك لن تستطيع العمل بأمان."},{"key":"c","text":"تختصر الغيارات دون إخبار أحد."},{"key":"d","text":"تلغي باقي الزيارات دون إخبار."}],"correct":"b"},{"id":"am3","category":"medical","text":"كمساعد تمريض، لاحظت احمرارًا في جلد مريض طريح الفراش عند نقاط الضغط. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهله، فهو ليس من مهامك."},{"key":"b","text":"تبلغ الممرض المسؤول فورًا، وتساعد في تغيير وضع المريض حسب التعليمات، وتوثق الملاحظة."},{"key":"c","text":"تضع مرهمًا من عندك دون إخبار أحد."},{"key":"d","text":"تنتظر حتى يصبح جرحًا."}],"correct":"b"},{"id":"ae2","category":"ethics","text":"أسرة مريض تطلب منك كمساعد إعطاء حقنة للمريض لأن الممرض تأخر. ماذا تفعل؟","options":[{"key":"a","text":"ترفض بأدب: إعطاء الحقن خارج نطاق المساعد، وتتصل بالممرض أو الإدارة فورًا."},{"key":"b","text":"تعطي نصف الجرعة فقط."},{"key":"c","text":"تطلب من أحد أفراد الأسرة إعطاءها."},{"key":"d","text":"تعطي الحقنة بنفسك لتساعد الأسرة."}],"correct":"a"},{"id":"as2","category":"safety","text":"كمريض مساعد، وجدت مريضًا بعد عملية يحاول النهوض وحده من السرير. ماذا تفعل؟","options":[{"key":"a","text":"تسحبه من ذراعه بقوة إلى السرير."},{"key":"b","text":"تغادر الغرفة."},{"key":"c","text":"تتركه ينهض وحده."},{"key":"d","text":"تبقى قربه، وتمنعه بلطف من النهوض المفاجئ، وتطلب الممرض فورًا، ولا ترفعه وحدك بطريقة غير آمنة."}],"correct":"d"}],"nurse":[{"id":"nm1","category":"medical","text":"في العناية بالجروح بالضغط السلبي (NPWT)، ما أهم نقطة؟","options":[{"key":"a","text":"تغيير الجهاز كل ساعة."},{"key":"b","text":"التأكد من إحكام الغلق، ومراقبة الإفرازات والضغط، وتوثيق كل تغيير حسب البروتوكول."},{"key":"c","text":"إيقاف الجهاز ليلًا دون إخبار."},{"key":"d","text":"استخدام أي ضماد متاح."}],"correct":"b"},{"id":"nm2","category":"medical","text":"قبل تركيب كانيولا، ما أهم خطوة؟","options":[{"key":"a","text":"تركيبها مباشرة."},{"key":"b","text":"غسل اليدين، وتجهيز الأدوات المعقمة، واختيار الوريد المناسب، والتأكد من هوية المريض."},{"key":"c","text":"طلب المساعدة من الأسرة."},{"key":"d","text":"تركيبها بدون قفازات لتوفير الوقت."}],"correct":"b"},{"id":"ne1","category":"ethics","text":"أثناء الزيارة، سمعت معلومة صحية حساسة عن المريض من أحد أقاربه. ماذا تفعل؟","options":[{"key":"a","text":"تنشرها في مجموعة العمل."},{"key":"b","text":"تحتفظ بها سرًا ولا تشاركها إلا مع الفريق الطبي المعني عند الحاجة."},{"key":"c","text":"تخبر الجيران للاطمئنان."},{"key":"d","text":"تسجلها في منشور عام."}],"correct":"b"},{"id":"ns1","category":"safety","text":"قبل تركيب قسطرة بولية، ما أهم إجراء سلامة؟","options":[{"key":"a","text":"التركيب بسرعة دون تجهيز."},{"key":"b","text":"التأكد من أمر الطبيب المكتوب، والتعقيم الكامل، وتأكيد هوية المريض، ثم إكمال قائمة الأمان."},{"key":"c","text":"التركيب دون أمر طبيب."},{"key":"d","text":"طلب المساعدة من الأسرة للتركيب."}],"correct":"b"},{"id":"nc1","category":"communication","text":"سائح يسألك بالإنجليزية: \"When will the nurse come?\" وأنت لا تفهم كل كلامه. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهله وتغادر."},{"key":"b","text":"ترد بإنجليزية بسيطة واضحة، وتستخدم الإشارة، وتطلب مساعدة الإدارة إن لزم."},{"key":"c","text":"ترد بالعربية بصوت أعلى."},{"key":"d","text":"تقول \"لا أفهم\" وتتركه."}],"correct":"b"},{"id":"nr1","category":"resilience","text":"تدهورت حالة مريض فجأة أثناء زيارتك (ضيق نفس شديد). ماذا تفعل أولًا؟","options":[{"key":"a","text":"تكمل الغيار أولًا."},{"key":"b","text":"توقف الإجراء، وتقيّم مجرى الهواء والتنفس، وتتصل بالإسعاف 123، وتبلغ الإدارة."},{"key":"c","text":"تطلب من الأسرة التصرف وحدها."},{"key":"d","text":"تغادر البيت فورًا."}],"correct":"b"},{"id":"nm3","category":"medical","text":"كممرض، لاحظت تورمًا وألمًا في موضع الكانيولا أثناء محلول وريدي. ماذا تفعل؟","options":[{"key":"a","text":"تعطي مسكنًا وتغادر."},{"key":"b","text":"تكمل المحلول وتتجاهل التورم."},{"key":"c","text":"توقف المحلول فورًا، وتقيّم موضع الكانيولا، وتبلغ الطبيب، وتوثق الحدث."},{"key":"d","text":"تزيد سرعة المحلول."}],"correct":"c"},{"id":"ne2","category":"ethics","text":"مريض يعرض عليك ساعة ثمينة هدية مقابل «الاهتمام الخاص» به. ماذا تفعل؟","options":[{"key":"a","text":"تقبلها، فهي هدية شخصية."},{"key":"b","text":"ترفض بأدب، وتوضح أن كل المرضى يأخذون نفس الاهتمام، وأن الهدايا الثمينة مرفوضة."},{"key":"c","text":"تقبلها سرًا."},{"key":"d","text":"تطلب هدية أثمن."}],"correct":"b"},{"id":"ns2","category":"safety","text":"كممرض، شممت رائحة غاز من أسطوانة أكسجين في بيت مريض. ماذا تفعل؟","options":[{"key":"a","text":"تهوّي المكان، وتبتعد عن أي لهب، وتغلق صمام الأسطوانة إن أمكن بأمان، وتبلغ الإدارة فورًا."},{"key":"b","text":"تتجاهل الرائحة وتكمل الزيارة."},{"key":"c","text":"تنقل الأسطوانة بنفسك إلى الشارع."},{"key":"d","text":"تشعل عود ثقاب لترى مصدر التسرب."}],"correct":"a"}],"doctor":[{"id":"dm1","category":"medical","text":"مريض منزلي لديه ألم صدر شديد وضيق نفس. ما القرار الصحيح؟","options":[{"key":"a","text":"تعالجه في البيت وتطمئنه."},{"key":"b","text":"تحوّله فورًا للمستشفى بالإسعاف 123، فالرعاية المنزلية غير كافية هنا."},{"key":"c","text":"تصف له مسكنًا وتغادر."},{"key":"d","text":"تطلب منه الانتظار حتى الصباح."}],"correct":"b"},{"id":"dm2","category":"medical","text":"سائح يطلب شهادة \"Fit to Fly\" قبل سفره. ماذا تفعل؟","options":[{"key":"a","text":"تصدرها فورًا دون فحص."},{"key":"b","text":"تفحصه وتقيّم حالته وفق معايير السفر الجوي، وتصدر الشهادة فقط إن كانت حالته تسمح بذلك."},{"key":"c","text":"ترفض دون فحص."},{"key":"d","text":"تصدرها مقابل مال إضافي."}],"correct":"b"},{"id":"de1","category":"ethics","text":"مريض يطلب منك وصف دواء لا يحتاجه طبيًا. ماذا تفعل؟","options":[{"key":"a","text":"تصفه له لإرضائه."},{"key":"b","text":"ترفض بأدب وتشرح له لماذا لا يحتاجه، وتقترح البديل المناسب إن وجد."},{"key":"c","text":"تصفه بجرعة مضاعفة."},{"key":"d","text":"تتجاهل طلبه."}],"correct":"b"},{"id":"ds1","category":"safety","text":"لاحظت أن حالة مريض منزلي تحتاج متابعة مستشفى وليس رعاية منزلية. ماذا تفعل؟","options":[{"key":"a","text":"تستمر في الزيارات المنزلية فقط."},{"key":"b","text":"توثق تقييمك وتحوّل المريض للمستشفى، وتبلغ الإدارة وأسرته بالسبب."},{"key":"c","text":"توقف الزيارات دون إخبار أحد."},{"key":"d","text":"تطلب من الأسرة البحث عن طبيب آخر."}],"correct":"b"},{"id":"dc1","category":"communication","text":"كيف تشرح لمريض تشخيصه وخطة علاجه بلغة بسيطة؟","options":[{"key":"a","text":"تستخدم المصطلحات الطبية كما هي دون شرح."},{"key":"b","text":"تشرح بكلمات بسيطة وأمثلة يومية، وتتأكد من فهمه، وتجيب عن أسئلته بصبر."},{"key":"c","text":"تعطيه ورقة إنجليزية وتغادر."},{"key":"d","text":"تطلب منه البحث على الإنترنت."}],"correct":"b"},{"id":"dr1","category":"resilience","text":"اتصال طارئ في منتصف الليل وأنت متعب بعد يوم طويل. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهل الاتصال."},{"key":"b","text":"تقيّم حالتك بصدق: إن كنت قادرًا على العمل بأمان تستجيب، وإلا تبلغ الإدارة فورًا ليجدوا بديلًا."},{"key":"c","text":"تذهب وأنت غير قادر على التركيز دون إخبار أحد."},{"key":"d","text":"تطلب من المريض الانتظار حتى الصباح دون تقييم."}],"correct":"b"},{"id":"dm3","category":"medical","text":"كطبيب زيارة منزلية، مريض يشتكي ألم صدر شديد مع تعرق وضيق نفس. ماذا تفعل؟","options":[{"key":"a","text":"تطلب منه المشي قليلًا."},{"key":"b","text":"تغادر وتطلب منه الحضور للعيادة."},{"key":"c","text":"تعطيه مسكنًا وتطلب منه الانتظار حتى الغد."},{"key":"d","text":"تقيّم العلامات الحيوية، وتتصل بالإسعاف 123 فورًا لاحتمال جلطة قلبية، ولا تؤخر النقل."}],"correct":"d"},{"id":"de2","category":"ethics","text":"أسرة مريض تطلب منك إخفاء التشخيص عن المريض نفسه. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهل الأسرة والمريض معًا."},{"key":"b","text":"تخفي التشخيص فورًا دون نقاش."},{"key":"c","text":"تشرح حق المريض في معرفة حالته، وتناقش مع الأسرة والمريض معًا طريقة إبلاغ مناسبة."},{"key":"d","text":"تكذب على المريض بتشخيص آخر."}],"correct":"c"},{"id":"ds2","category":"safety","text":"كطبيب، وجدت دواء طوارئ منتهي الصلاحية في حقيبتك قبل زيارة. ماذا تفعل؟","options":[{"key":"a","text":"تستخدمه إن احتجته، فالانتهاء حديث."},{"key":"b","text":"لا تستخدمه إطلاقًا، وتستبدله بدواء صالح، وتوثق التخلص منه وتبلغ الإدارة."},{"key":"c","text":"تخفي تاريخ الصلاحية."},{"key":"d","text":"تعطيه للمريض ليحتفظ به."}],"correct":"b"}],"physio":[{"id":"pm1","category":"medical","text":"مريض بعد جلطة يبدأ تأهيلًا حركيًا في البيت. ما أول خطوة؟","options":[{"key":"a","text":"تبدأ تمارين قوية فورًا."},{"key":"b","text":"تقيّم حالته وقدرته الحركية وخطر السقوط، وتضع خطة تمارين تدريجية آمنة."},{"key":"c","text":"تطلب منه المشي وحده دون إشراف."},{"key":"d","text":"تعطيه أدوية مسكنة."}],"correct":"b"},{"id":"pm2","category":"medical","text":"مريض بعد كسر يشتكي ألمًا شديدًا أثناء التمرين. ماذا تفعل؟","options":[{"key":"a","text":"تستمر في التمرين رغم الألم."},{"key":"b","text":"توقف التمرين، وتقيّم الألم، وتعدّل الخطة أو تحيله للطبيب إن لزم."},{"key":"c","text":"تطلب منه تحمل الألم دون توقف."},{"key":"d","text":"تعطيه دواءً من عندك."}],"correct":"b"},{"id":"pe1","category":"ethics","text":"مريض يطلب منك وصف دواء لألم عضلاته. ماذا تفعل؟","options":[{"key":"a","text":"تصف له الدواء بنفسك."},{"key":"b","text":"توضح أن وصف الأدوية خارج نطاق دورك، وتحيله للطبيب."},{"key":"c","text":"تعطيه دواءً من حقيبتك."},{"key":"d","text":"تتجاهل طلبه."}],"correct":"b"},{"id":"ps1","category":"safety","text":"مريض مسنّ معرّض للسقوط أثناء تمارين التوازن والمشي. ماذا تفعل؟","options":[{"key":"a","text":"تتركه يتدرب وحده."},{"key":"b","text":"تؤمّن المكان، وتبقى قريبًا منه طوال التمرين، وتستخدم دعمًا مناسبًا، وتوقف التمرين عند أي خطر."},{"key":"c","text":"تطلب منه التدرب على الدرج."},{"key":"d","text":"تستمر رغم الدوار."}],"correct":"b"},{"id":"pc1","category":"communication","text":"مريض مسنّ محبط لأن تحسنه بطيء. كيف تتعامل معه؟","options":[{"key":"a","text":"تخبره أنه لن يتحسن أبدًا."},{"key":"b","text":"تشجعه، وتشرح له التقدم التدريجي بأمثلة واضحة، وتضع أهدافًا صغيرة واقعية."},{"key":"c","text":"تتجاهل إحباطه."},{"key":"d","text":"تلغي جلساته."}],"correct":"b"},{"id":"pr1","category":"resilience","text":"جلسات تأهيل طويلة وتقدم بطيء والأسرة تضغط عليك. ماذا تفعل؟","options":[{"key":"a","text":"تستسلم للضغط وتغيّر الخطة دون أساس."},{"key":"b","text":"تشرح للأسرة واقع التقدم بهدوء، وتلتزم بالخطة العلاجية، وتوثق كل جلسة."},{"key":"c","text":"تترك المريض دون إخبار."},{"key":"d","text":"تختصر الجلسات سرًا."}],"correct":"b"},{"id":"pm3","category":"medical","text":"كأخصائي علاج طبيعي، مريض يشتكي ألمًا حادًا مع تنميل أثناء تمرين. ماذا تفعل؟","options":[{"key":"a","text":"توقف التمرين فورًا، وتقيّم الألم والتنميل، وتوثق، وتحيله للطبيب إن استمر."},{"key":"b","text":"تزيد شدة التمرين."},{"key":"c","text":"تتجاهل الشكوى وتكمل الجلسة."},{"key":"d","text":"تطلب منه الاستمرار رغم الألم."}],"correct":"a"},{"id":"pe2","category":"ethics","text":"مريض يطلب منك جلسات إضافية خارج الخطة العلاجية مقابل دفع نقدي مباشر. ماذا تفعل؟","options":[{"key":"a","text":"توافق سرًا دون حجز."},{"key":"b","text":"تضاعف السعر وتوافق."},{"key":"c","text":"توافق وتأخذ المال مباشرة."},{"key":"d","text":"ترفض: أي جلسة إضافية تحتاج تقييم الطبيب وحجزًا عبر التطبيق."}],"correct":"d"},{"id":"ps2","category":"safety","text":"كأخصائي علاج طبيعي، لاحظت أرضية مبللة في منطقة التمارين قبل بدء الجلسة. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهل الأمر تمامًا."},{"key":"b","text":"تبدأ الجلسة فورًا رغم البلل."},{"key":"c","text":"توقف البدء، وتجفف المنطقة أو تنقل التمرين لمكان آمن، وتبلغ عن الخطر."},{"key":"d","text":"تطلب من المريض المشي على الأرض المبللة."}],"correct":"c"}]};
const MCQ = [{"id":"m1","category":"medical","text":"مريض فاقد للوعي ولا يتنفس بشكل طبيعي في بيته. ماذا تفعل أولًا؟","options":[{"key":"a","text":"أبدأ علاجه في البيت وأنتظر حتى يتحسن وحده."},{"key":"b","text":"أتصل بالإسعاف 123 فورًا، وأبدأ الإنعاش القلبي الرئوي إن كنت مدرّبًا عليه، وأبقيه في وضع آمن."},{"key":"c","text":"أعطيه ماءً وسكرًا وأتركه نائمًا."},{"key":"d","text":"أتصل بأسرته فقط وأنتظر وصولهم."}],"correct":"b","redFlagOption":"a"},{"id":"m2","category":"medical","text":"تقيس الضغط لمريض فتجد 180/110 والنبض 120. ماذا تفعل؟","options":[{"key":"a","text":"تسجلها فقط وتغادر."},{"key":"b","text":"تعيد القياس للتأكد، وتسأل عن الأعراض، وتبلغ الطبيب أو الإدارة فورًا حسب البروتوكول."},{"key":"c","text":"تعطي دواء ضغط من عندك."},{"key":"d","text":"تطمئن المريض بأن كل شيء طبيعي."}],"correct":"b"},{"id":"m3","category":"medical","text":"أثناء محلول وريدي ظهر طفح جلدي وضيق نفس على المريض. ماذا تفعل؟","options":[{"key":"a","text":"تكمل الدواء حتى ينتهي المحلول."},{"key":"b","text":"توقف الدواء فورًا، وتقيّم مجرى الهواء والتنفس، وتطلب إسعافًا أو طبيبًا فورًا، وتوثق الحدث."},{"key":"c","text":"تعطي دواءً آخر من عندك لتهدئة الطفح."},{"key":"d","text":"تطلب من المريض الانتظار حتى يتحسن وحده."}],"correct":"b","redFlagOption":"a"},{"id":"m4","category":"medical","text":"ما أول إجراء عند نزيف خارجي شديد من جرح؟","options":[{"key":"a","text":"تنظيف الجرح أولًا."},{"key":"b","text":"الضغط المباشر على الجرح لوقف النزيف، وطلب المساعدة الطبية."},{"key":"c","text":"رفع المريض واقفًا."},{"key":"d","text":"وضع الثلج فقط."}],"correct":"b"},{"id":"m5","category":"medical","text":"مريض سكري لديه جرح قدم، وتلاحظ رائحة كريهة وإفرازات. ما التصرف الصحيح؟","options":[{"key":"a","text":"تغطي الجرح فقط وتغادر."},{"key":"b","text":"تقيّم الجرح، وتوثق العلامات، وتبلغ الطبيب أو الإدارة فورًا، وتتبع بروتوكول الغيار المعتمد."},{"key":"c","text":"تضع مرهمًا من عندك دون توثيق."},{"key":"d","text":"تطلب من المريض الانتظار أسبوعًا."}],"correct":"b"},{"id":"m6","category":"medical","text":"مريض يطلب منك تشخيص طفح جلدي لديه ووصف مضاد حيوي له. ماذا تفعل؟","options":[{"key":"a","text":"تشخّص الطفح وتصف له المضاد الحيوي بنفسك."},{"key":"b","text":"توضح له أن التشخيص ووصف الدواء خارج نطاق دورك، وتوثق ملاحظاتك وتحيله للطبيب أو الإدارة."},{"key":"c","text":"تعطيه أي دواء متوفر معك."},{"key":"d","text":"تتجاهل طلبه تمامًا دون شرح."}],"correct":"b","redFlagOption":"a"},{"id":"e1","category":"ethics","text":"بعد الزيارة، أسرة المريض تطلب منك صورة الجرح \"لترسلها لأقاربهم على واتساب\". ماذا تفعل؟","options":[{"key":"a","text":"ترسل الصورة لهم فورًا."},{"key":"b","text":"ترفض بأدب: صور المرضى سرية ولا تُرسَل إلا عبر تقرير التطبيق الرسمي وبموافقة المريض."},{"key":"c","text":"تنشر الصورة في مجموعة العمل أولًا."},{"key":"d","text":"ترسلها من هاتفك الشخصي دون توثيق."}],"correct":"b","redFlagOption":"a"},{"id":"e2","category":"ethics","text":"مريض يعرض عليك مالًا نقديًا \"خارج التطبيق\" مقابل أن تأتيه مباشرة دون حجز. ماذا تفعل؟","options":[{"key":"a","text":"تقبل المال وتذهب إليه مباشرة."},{"key":"b","text":"ترفض وتوضح أن كل الحجز والدفع عبر التطبيق لحماية الطرفين."},{"key":"c","text":"تقبل المال ولا تخبر أحدًا."},{"key":"d","text":"تطلب مبلغًا أكبر مقابل الزيارة."}],"correct":"b","redFlagOption":"a"},{"id":"e3","category":"ethics","text":"زميل يطلب منك توقيع تقرير زيارة لم تحضرها، أو تسجيل علامات حيوية لم تقسها. ماذا تفعل؟","options":[{"key":"a","text":"توقع، لأنها مجاملة بسيطة."},{"key":"b","text":"ترفض؛ التوقيع على ما لم تفعله أو تسجيل قياسات لم تقسها تزوير."},{"key":"c","text":"توقع وتكتب ملاحظة صغيرة."},{"key":"d","text":"تطلب منه مالًا مقابل التوقيع."}],"correct":"b","redFlagOption":"a"},{"id":"e4","category":"ethics","text":"مريض يطلب منك أن تخبر أسرته بتشخيصه دون علمه. ماذا تفعل؟","options":[{"key":"a","text":"تخبر الأسرة فورًا لأنهم يدفعون."},{"key":"b","text":"ترفض وتشرح للمريض حقه في الخصوصية، وتطلب موافقته أولًا."},{"key":"c","text":"تخبر الأسرة جزئيًا فقط."},{"key":"d","text":"تتجاهل الطلب ولا ترد."}],"correct":"b"},{"id":"e5","category":"ethics","text":"وجدت محفظة مريض في بيته بعد الزيارة. ماذا تفعل؟","options":[{"key":"a","text":"تتركها مكانها وتبلغ المريض والإدارة فورًا."},{"key":"b","text":"تأخذها معك وتعيدها في الزيارة القادمة."},{"key":"c","text":"تفتحها لتعرف صاحبها."},{"key":"d","text":"لا تهتم، ليست مسؤوليتك."}],"correct":"a"},{"id":"e6","category":"ethics","text":"مريض يعرض عليك مالًا إضافيًا مقابل أولوية في الحجز. ماذا تفعل؟","options":[{"key":"a","text":"تقبله، فهذا حقه."},{"key":"b","text":"ترفض بلطف وتشرح أن الحجز حسب النظام للجميع."},{"key":"c","text":"تقبله ولا تخبر أحدًا."},{"key":"d","text":"تطلب مبلغًا أكبر."}],"correct":"b"},{"id":"s1","category":"safety","text":"وصلت بيت مريض ووجدت الباب مفتوحًا وأصوات شجار عنيف بالداخل. ماذا تفعل؟","options":[{"key":"a","text":"تدخل فورًا لتبدأ الزيارة كالمعتاد."},{"key":"b","text":"لا تدخل — تبتعد لمكان آمن، وتتصل بالإدارة، وتضغط SOS، وتتصل بالشرطة 122 إن لزم."},{"key":"c","text":"تدخل وتحاول فض الشجار بنفسك."},{"key":"d","text":"تنتظر أمام الباب حتى يهدأ الشجار ثم تدخل."}],"correct":"b","redFlagOption":"a"},{"id":"s2","category":"safety","text":"قبل غيار جرح ملتهب، ما أهم خطوة لمكافحة العدوى؟","options":[{"key":"a","text":"ارتداء أي ملابس متوفرة."},{"key":"b","text":"غسل اليدين واستخدام قفاز معقم وأدوات معقمة."},{"key":"c","text":"فتح النافذة فقط."},{"key":"d","text":"العمل بسرعة دون تجهيز."}],"correct":"b"},{"id":"s3","category":"safety","text":"بعد الزيارة، أين تتخلص من الإبر والأدوات الحادة المستخدمة؟","options":[{"key":"a","text":"في سلة المهملات العادية بالبيت."},{"key":"b","text":"في حاوية مخصصة للأدوات الحادة، وتتبع بروتوكول التخلص الآمن."},{"key":"c","text":"تتركها في البيت للمريض."},{"key":"d","text":"ترميها في الشارع."}],"correct":"b"},{"id":"s4","category":"safety","text":"لاحظت أن أدوات الغيار المتوفرة غير معقمة، والمريض ينتظرك. ماذا تفعل؟","options":[{"key":"a","text":"تستخدمها كما هي حتى لا يتأخر المريض."},{"key":"b","text":"لا تستخدمها — تستخدم أدوات معقمة من حقيبتك أو تؤجل الغيار وتبلغ الإدارة."},{"key":"c","text":"تستخدمها وتخبر المريض أنها نظيفة."},{"key":"d","text":"تغسلها بالماء فقط وتستخدمها."}],"correct":"b","redFlagOption":"a"},{"id":"s5","category":"safety","text":"بعد الزيارة، أين توثّق العلامات الحيوية وملاحظاتك؟","options":[{"key":"a","text":"في ورقة تتركها في البيت."},{"key":"b","text":"في تقرير الزيارة داخل التطبيق فورًا قبل المغادرة."},{"key":"c","text":"في رسالة واتساب لأحد أقاربك."},{"key":"d","text":"لا توثقها؛ يكفي أنك تذكرها."}],"correct":"b"},{"id":"c1","category":"communication","text":"سائح ألماني لا يتكلم العربية ولا الإنجليزية جيدًا، ويشير إلى موضع ألم. ماذا تفعل؟","options":[{"key":"a","text":"تتركه وتغادر."},{"key":"b","text":"تستخدم لغة الإشارة والصور، وتتكلم إنجليزية بسيطة، وتطلب مساعدة الإدارة بمترجم إن لزم."},{"key":"c","text":"تتكلم معه بالعربية بصوت أعلى."},{"key":"d","text":"تطلب منه أن يكتب شكواه بالألمانية فقط."}],"correct":"b"},{"id":"c2","category":"communication","text":"مريضة مسنّة قلقة وتبكي قبل الغيار. ما أول خطوة؟","options":[{"key":"a","text":"تبدأ الغيار فورًا لتوفير الوقت."},{"key":"b","text":"تهدئها، وتشرح لها الخطوات ببساطة، وتطلب إذنها قبل البدء."},{"key":"c","text":"تطلب من أسرتها إخراجها من الغرفة."},{"key":"d","text":"تتجاهل بكاءها."}],"correct":"b"},{"id":"c3","category":"communication","text":"أسرة المريض تتحدث بلهجة وعادات مختلفة عنك وتسأل كثيرًا. كيف تتصرف؟","options":[{"key":"a","text":"تتعامل باحترام وتجيب بهدوء، وتتأقلم مع أسلوبهم دون أحكام."},{"key":"b","text":"تخبرهم أن أسلوبهم غريب."},{"key":"c","text":"ترفض الإجابة لأنها ليست من عملك."},{"key":"d","text":"تسخر من لهجتهم."}],"correct":"a"},{"id":"c4","category":"communication","text":"مريض لا يفهم المصطلحات الطبية. كيف تشرح له؟","options":[{"key":"a","text":"تستخدم كلمات أبسط وأمثلة من حياته اليومية، وتتأكد من فهمه."},{"key":"b","text":"تكرر نفس المصطلحات بصوت أعلى."},{"key":"c","text":"تعطيه ورقة طبية إنجليزية وتتركه."},{"key":"d","text":"تطلب منه أن يبحث بنفسه."}],"correct":"a"},{"id":"c5","category":"communication","text":"مريض من جنسية أو دين أو مستوى مادي مختلف يطلب رعاية منزلية. ماذا تفعل؟","options":[{"key":"a","text":"ترفض تقديم الرعاية بسبب جنسيته أو دينه أو مستواه المادي."},{"key":"b","text":"تقدم له نفس الرعاية باحترام كامل، دون أي تمييز."},{"key":"c","text":"تقدم له رعاية أقل لأنه مختلف عنك."},{"key":"d","text":"تطلب منه مالًا إضافيًا مقابل خدمته."}],"correct":"b","redFlagOption":"a"},{"id":"r1","category":"resilience","text":"مريض غاضب يرفع صوته عليك بسبب تأخير. ماذا تفعل؟","options":[{"key":"a","text":"ترفع صوتك عليه بالمثل."},{"key":"b","text":"تحافظ على هدوئك، وتستمع، وتعتذر عن التأخير، وتشرح الحل."},{"key":"c","text":"تترك البيت فورًا."},{"key":"d","text":"تهدده بإلغاء الخدمة."}],"correct":"b"},{"id":"r2","category":"resilience","text":"وردية ليلية (22:00–06:00) واتصال طارئ وأنت متعب جدًا. ماذا تفعل؟","options":[{"key":"a","text":"تذهب مرهقًا وتقود السيارة وأنت نعسان."},{"key":"b","text":"تقيّم حالتك بصدق: إن كنت غير قادر على العمل بأمان تبلغ الإدارة فورًا ليجدوا بديلًا، ولا تقود مرهقًا."},{"key":"c","text":"تتجاهل الاتصال تمامًا."},{"key":"d","text":"تذهب دون إخبار أحد بحالتك."}],"correct":"b"},{"id":"r3","category":"resilience","text":"بعد زيارة صعبة شعرت بالإحباط. ماذا تفعل؟","options":[{"key":"a","text":"تستقيل فورًا."},{"key":"b","text":"تراجع ما حدث وتتعلم منه وتطلب دعمًا من الإدارة أو زملائك."},{"key":"c","text":"تلوم المريض على كل شيء."},{"key":"d","text":"تتوقف عن توثيق الزيارات."}],"correct":"b"},{"id":"r4","category":"resilience","text":"مريض يرفض إجراءً تمريضيًا ضروريًا بعد شرحه له. ماذا تفعل؟","options":[{"key":"a","text":"تنفذه بالقوة لمصلحته."},{"key":"b","text":"تحترم رفضه بعد التأكد من فهمه، وتوثق الرفض وتبلغ الطبيب أو الإدارة."},{"key":"c","text":"تتركه دون توثيق."},{"key":"d","text":"تهدده بوقف الخدمة."}],"correct":"b"},{"id":"f1","category":"conduct","text":"تأخرت عن موعد زيارة منزلية. ما التصرف الصحيح؟","options":[{"key":"a","text":"تذهب متأخرًا دون إخبار أحد."},{"key":"b","text":"تتصل بالمريض وتعتذر وتبلغه بالوقت الجديد، وتبلغ الإدارة."},{"key":"c","text":"تلغي الزيارة دون إخبار."},{"key":"d","text":"تطلب من مريض آخر أن ينتظرك."}],"correct":"b"},{"id":"f2","category":"conduct","text":"عميل يطلب رقم هاتفك الشخصي للتواصل المباشر خارج التطبيق. ماذا تفعل؟","options":[{"key":"a","text":"تعطيه رقمك الشخصي فورًا."},{"key":"b","text":"توجهه للتواصل عبر التطبيق فقط، وتوضح أن ذلك لحماية الطرفين."},{"key":"c","text":"تعطيه رقم زميلك."},{"key":"d","text":"توافق بشرط أن يدفع نقدًا."}],"correct":"b"},{"id":"f3","category":"conduct","text":"أثناء الزيارة تدهورت حالة المريض فجأة وأنت وحدك معه. ماذا تفعل؟","options":[{"key":"a","text":"تتركه وحده وتغادر البيت."},{"key":"b","text":"تبقى معه، وتتصل بالإسعاف 123 فورًا، وتبلغ الإدارة، ولا تغادر حتى يصل المسعفون أو يستقر وضعه."},{"key":"c","text":"تغادر لإحضار المساعدة وتتركه دون إشراف."},{"key":"d","text":"تنتظر حتى يتحسن وحده."}],"correct":"b","redFlagOption":"a"},{"id":"f4","category":"conduct","text":"بعد انتهاء الزيارة، الأسرة تقدم لك طعامًا أو شرابًا. ماذا تفعل؟","options":[{"key":"a","text":"ترفض بطريقة مهينة."},{"key":"b","text":"تشكرهم بلطف، وتقبل أو تعتذر بذوق حسب الموقف، دون أن يؤثر ذلك على عملك."},{"key":"c","text":"تطلب المزيد."},{"key":"d","text":"تأكل وتتأخر عن زيارتك التالية."}],"correct":"b"},{"id":"m7","category":"medical","text":"تقيس السكر لمريض سكري فتجده 45 ملغ/دل وهو واعٍ ويستطيع البلع. ماذا تفعل؟","options":[{"key":"a","text":"تعطيه جرعة أنسولين فورًا لخفض السكر أكثر."},{"key":"b","text":"تعطيه سكرًا سريعًا (عصير أو جلوكوز)، ثم تعيد القياس بعد 15 دقيقة وتبلغ الطبيب."},{"key":"c","text":"تتركه نائمًا حتى يستيقظ وحده."},{"key":"d","text":"تعطيه ماءً فقط وتغادر."}],"correct":"b","redFlagOption":"a"},{"id":"m8","category":"medical","text":"مريض بعد عملية جراحية يشتكي من ألم شديد مفاجئ في الساق مع تورم واحمرار. ماذا تفعل؟","options":[{"key":"a","text":"تقيّم الساق، ولا تدلكها، وتبلغ الطبيب فورًا لاحتمال جلطة وريدية، وتوثق ملاحظاتك."},{"key":"b","text":"تطلب منه المشي مسافة طويلة فورًا."},{"key":"c","text":"تعطيه مسكنًا من عندك وتغادر."},{"key":"d","text":"تدلك الساق بقوة لتحسين الدورة الدموية."}],"correct":"a"},{"id":"m9","category":"medical","text":"مريض مسنّ سقط في الحمام ولا يستطيع الوقوف ويشتكي من ألم في الفخذ. ماذا تفعل؟","options":[{"key":"a","text":"تتركه على الأرض وتغادر."},{"key":"b","text":"تعطيه مسكنًا وتنتظر ساعة."},{"key":"c","text":"تسحبه واقفًا فورًا حتى لا يتأخر عن موعده."},{"key":"d","text":"لا تحركه بعنف، وتقيّم وعيه والألم، وتطلب الإسعاف أو الطبيب فورًا لاحتمال كسر، وتوثق الحدث."}],"correct":"d"},{"id":"m10","category":"medical","text":"أثناء غيار جرح تلاحظ نزيفًا لا يتوقف بالضغط المباشر لمدة 10 دقائق. ماذا تفعل؟","options":[{"key":"a","text":"تطلب من المريض الضغط بنفسه وتذهب لزيارة أخرى."},{"key":"b","text":"تغطي الجرح وتغادر وتطلب من الأسرة الانتظار."},{"key":"c","text":"تستمر في الضغط المباشر، وتطلب مساعدة طبية عاجلة، وتوثق كمية النزيف والوقت."},{"key":"d","text":"تضع مرهمًا فوق النزيف."}],"correct":"c"},{"id":"m11","category":"medical","text":"مريض يأخذ أدوية سيولة وظهرت عليه كدمات كبيرة دون سبب واضح. ماذا تفعل؟","options":[{"key":"a","text":"توقف دواء السيولة بنفسك فورًا."},{"key":"b","text":"توثق الكدمات وأماكنها، وتبلغ الطبيب أو الإدارة فورًا، ولا توقف أي دواء من عندك."},{"key":"c","text":"تطمئنه بأن الكدمات طبيعية وتغادر."},{"key":"d","text":"تطلب منه التوقف عن الحركة تمامًا لأسبوع."}],"correct":"b"},{"id":"m12","category":"medical","text":"مريض يعاني من ضيق نفس شديد وصوت صفير مع زرقة في الشفاه. ماذا تفعل؟","options":[{"key":"a","text":"تجلسه في وضع مريح، وتتصل بالإسعاف 123 فورًا، وتعطي الأكسجين فقط إن كان موصوفًا ومتاحًا."},{"key":"b","text":"تعطيه ماءً باردًا وتطلب منه النوم على ظهره."},{"key":"c","text":"تغادر لتتصل بأسرته أولًا."},{"key":"d","text":"تنتظر حتى يتحسن وحده."}],"correct":"a"},{"id":"e7","category":"ethics","text":"مريض يطلب منك رقم هاتف ممرض آخر كان يزوره ليتواصل معه مباشرة خارج التطبيق. ماذا تفعل؟","options":[{"key":"a","text":"تعطيه رقمًا وهميًا."},{"key":"b","text":"تطلب منه مالًا مقابل الرقم."},{"key":"c","text":"تعطيه الرقم فورًا، فهو حقه."},{"key":"d","text":"ترفض بأدب وتوضح أن كل التواصل والحجز عبر التطبيق لحماية الطرفين."}],"correct":"d"},{"id":"e8","category":"ethics","text":"مريض يعرض عليك هدية مالية كبيرة بعد زيارة ناجحة. ماذا تفعل؟","options":[{"key":"a","text":"تطلب هدية أكبر."},{"key":"b","text":"تقبلها وتتفق معه على زيارات مباشرة خارج التطبيق."},{"key":"c","text":"تشكره وترفض بأدب، وتوضح أن أجرك عبر التطبيق فقط وأن قبول المال خارج التطبيق ممنوع."},{"key":"d","text":"تقبلها سرًا ولا تخبر أحدًا."}],"correct":"c","redFlagOption":"b"},{"id":"e9","category":"ethics","text":"تكتشف أن زميلًا يسجّل زيارات لم تتم ليحصل على أجرها. ماذا تفعل؟","options":[{"key":"a","text":"تسكت، فهذا ليس شأنك."},{"key":"b","text":"تبلغ الإدارة بالأدلة التي رأيتها، ولا تشارك في التسجيل الكاذب."},{"key":"c","text":"تطلب منه أن يسجل زيارات باسمك أيضًا."},{"key":"d","text":"تسجل زيارة كاذبة مثله."}],"correct":"b"},{"id":"e10","category":"ethics","text":"مريض يطلب منك عدم إخبار أسرته بمعلومة طبية مهمة تخص سلامته. ماذا تفعل؟","options":[{"key":"a","text":"تحترم خصوصيته، وتشرح له حدود ذلك، وتوثق طلبه، وتبلغ الطبيب أو الإدارة إن كانت سلامته في خطر."},{"key":"b","text":"تتجاهل المعلومة تمامًا ولا توثقها."},{"key":"c","text":"تخبر الجيران بالمعلومة."},{"key":"d","text":"تخبر أسرته فورًا دون إذنه."}],"correct":"a"},{"id":"e11","category":"ethics","text":"أسرة مريض تطلب منك البقاء لساعات إضافية دون حجز أو أجر. ماذا تفعل؟","options":[{"key":"a","text":"تغادر غاضبًا دون شرح."},{"key":"b","text":"تطلب مالًا نقديًا مقابل البقاء."},{"key":"c","text":"تبقى مجانًا كل مرة حتى لا تغضب الأسرة."},{"key":"d","text":"توضح بأدب أن أي وقت إضافي يحتاج حجزًا عبر التطبيق، وتعرض ترتيب ذلك مع الإدارة."}],"correct":"d"},{"id":"s6","category":"safety","text":"تدخل بيت مريض وتلاحظ وجود كلب شرس غير مقيد. ماذا تفعل؟","options":[{"key":"a","text":"تلغي الزيارة دون إخبار أحد."},{"key":"b","text":"تدخل فورًا وتتجاهل الكلب."},{"key":"c","text":"لا تدخل، وتطلب من الأسرة تقييد الكلب أو إبعاده أولًا، وتبلغ الإدارة إن تعذر ذلك."},{"key":"d","text":"تضرب الكلب لتبعده."}],"correct":"c"},{"id":"s7","category":"safety","text":"أثناء زيارة، انقطع التيار الكهربائي وجهاز المريض يعمل بالكهرباء. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهل الأمر وتكمل الزيارة كأن شيئًا لم يحدث."},{"key":"b","text":"تتبع بروتوكول الجهاز الاحتياطي، وتطمئن المريض، وتتصل بالإدارة أو الطبيب فورًا."},{"key":"c","text":"تحاول إصلاح الكهرباء بنفسك."},{"key":"d","text":"تفصل الجهاز وتغادر."}],"correct":"b"},{"id":"s8","category":"safety","text":"تلاحظ أن قارورة محلول وريدي انتهت صلاحيتها. ماذا تفعل؟","options":[{"key":"a","text":"لا تستخدمها إطلاقًا، وتستبدلها بقارورة صالحة، وتوثق الواقعة وتبلغ الإدارة."},{"key":"b","text":"تستخدم نصفها فقط."},{"key":"c","text":"تخفي تاريخ الصلاحية عن المريض وتستخدمها."},{"key":"d","text":"تستخدمها لأنها تبدو سليمة."}],"correct":"a","redFlagOption":"d"},{"id":"s9","category":"safety","text":"مريض يرفض غيار جرحه رغم شرحك لأهميته. ماذا تفعل؟","options":[{"key":"a","text":"تغادر دون توثيق."},{"key":"b","text":"تهدد المريض بأن الجرح سيتدهور."},{"key":"c","text":"تغير الجرح بالقوة رغم رفضه."},{"key":"d","text":"تحترم رفضه، وتشرح المخاطر بهدوء، وتوثق الرفض، وتبلغ الطبيب أو الإدارة."}],"correct":"d"},{"id":"c6","category":"communication","text":"مريض لا يتكلم العربية ولا الإنجليزية ويحتاج شرحًا بسيطًا للإجراء. ماذا تفعل؟","options":[{"key":"a","text":"تلغي الزيارة دون محاولة."},{"key":"b","text":"تتجاهل الشرح وتبدأ الإجراء فورًا."},{"key":"c","text":"تستخدم إيماءات بسيطة أو تطبيق ترجمة، وتتأكد من فهمه قبل البدء، وتوثق ذلك."},{"key":"d","text":"تتحدث معه بصوت عالٍ بالعربية."}],"correct":"c"},{"id":"c7","category":"communication","text":"أسرة مريض غاضبة وتصرخ في وجهك بسبب تأخرك. ماذا تفعل؟","options":[{"key":"a","text":"تصرخ في وجههم أيضًا."},{"key":"b","text":"تبقى هادئًا، وتعتذر عن التأخير، وتشرح السبب باختصار، وتهدئ الموقف قبل بدء العمل."},{"key":"c","text":"تغادر فورًا دون كلمة."},{"key":"d","text":"تتهمهم بالكذب."}],"correct":"b"},{"id":"c8","category":"communication","text":"مريض مسنّ ضعيف السمع لا يفهم تعليماتك. ماذا تفعل؟","options":[{"key":"a","text":"تتكلم ببطء ووجهك نحوه، وتكتب التعليمات المهمة، وتتأكد من فهمه."},{"key":"b","text":"تتجاهل التعليمات تمامًا."},{"key":"c","text":"تصرخ في أذنه."},{"key":"d","text":"تتحدث بسرعة وتغادر."}],"correct":"a"},{"id":"c9","category":"communication","text":"مريض يسألك عن تشخيص حالته وأنت غير مخوّل بالتشخيص. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهل سؤاله."},{"key":"b","text":"تخمن تشخيصًا من الإنترنت."},{"key":"c","text":"تشخّص حالته بنفسك لتطمئنه."},{"key":"d","text":"توضح أن التشخيص دور الطبيب، وتوثق ملاحظاتك، وتحيله للطبيب أو الإدارة."}],"correct":"d"},{"id":"r5","category":"resilience","text":"جدولك ممتلئ وطلب منك حجز إضافي عاجل في نهاية يوم طويل. ماذا تفعل؟","options":[{"key":"a","text":"تقبل الحجز وتذهب نائمًا."},{"key":"b","text":"تقبل كل حجز مهما كنت مرهقًا."},{"key":"c","text":"تقيّم قدرتك بصدق، وتنسق مع الإدارة لتغطية الحجز بأمان، ولا تقبل ما يعرّض المريض للخطر."},{"key":"d","text":"ترفض دون إخبار الإدارة."}],"correct":"c"},{"id":"r6","category":"resilience","text":"تعرضت لموقف محرج مع مريض وأثر فيك نفسيًا. ماذا تفعل؟","options":[{"key":"a","text":"تكتم الأمر وتستمر كأن شيئًا لم يحدث."},{"key":"b","text":"توثق ما حدث، وتتحدث مع الإدارة أو زميل دعم، وتعتني بنفسك قبل الزيارة التالية."},{"key":"c","text":"تصب غضبك على المريض التالي."},{"key":"d","text":"تترك العمل دون إخبار أحد."}],"correct":"b"},{"id":"r7","category":"resilience","text":"فقدت مريضًا كنت تتابعه رغم بذلك كل ما تستطيع. كيف تتعامل؟","options":[{"key":"a","text":"تراجع ما حدث بهدوء مع الإدارة، وتوثق، وتطلب الدعم، وتتعلم دون تحميل نفسك ما فوق طاقتك."},{"key":"b","text":"تخفي الوفاة عن الإدارة."},{"key":"c","text":"تتهم أسرة المريض."},{"key":"d","text":"تلوم نفسك وحدك وتتوقف عن العمل."}],"correct":"a"},{"id":"f5","category":"conduct","text":"تصل إلى بيت مريض وتكتشف أنك نسيت أداة مهمة في سيارتك. ماذا تفعل؟","options":[{"key":"a","text":"تتظاهر بأنك أكملت العمل."},{"key":"b","text":"تغادر دون إخبار المريض."},{"key":"c","text":"تستخدم أداة غير مناسبة من البيت."},{"key":"d","text":"تخبر المريض، وتجلب الأداة أو تعيد ترتيب الزيارة بأمان، ولا تبدأ بأدوات غير مناسبة."}],"correct":"d"},{"id":"f6","category":"conduct","text":"مريض يطلب منك خدمة خارج نطاق التمريض (مثل إصلاح جهاز منزلي). ماذا تفعل؟","options":[{"key":"a","text":"تكسر الجهاز أكثر."},{"key":"b","text":"تصلح الجهاز رغم أنك غير مختص."},{"key":"c","text":"ترفض بأدب، وتوضح أن دورك تمريضي فقط، وتبقى في نطاق عملك."},{"key":"d","text":"تطلب مالًا إضافيًا مقابل الإصلاح."}],"correct":"c"},{"id":"am1","category":"medical","text":"كمساعد تمريض، قست العلامات الحيوية لمريض فوجدت نبضه 130 وضغطه 160/100. ماذا تفعل؟","options":[{"key":"a","text":"تسجلها فقط وتغادر."},{"key":"b","text":"تسجلها بدقة وتبلغ الممرض أو الطبيب المسؤول فورًا، ولا تقرر علاجًا بنفسك."},{"key":"c","text":"تعطيه دواء ضغط من حقيبتك."},{"key":"d","text":"تطمئنه أن كل شيء طبيعي."}],"correct":"b"},{"id":"am2","category":"medical","text":"مريض يطلب منك إعطاءه دواءً وريديًا. ماذا تفعل؟","options":[{"key":"a","text":"تعطيه الدواء فورًا."},{"key":"b","text":"ترفض بأدب: إعطاء الأدوية الوريدية خارج نطاق دورك، وتصعّد الأمر للممرض أو الطبيب."},{"key":"c","text":"تعطيه نصف الجرعة فقط."},{"key":"d","text":"تطلب من أسرته إعطاءه الدواء."}],"correct":"b"},{"id":"ae1","category":"ethics","text":"مريض يسألك عن حالة مريض آخر تعرفه، ويضغط عليك للإجابة. ماذا تفعل؟","options":[{"key":"a","text":"تخبره بكل التفاصيل."},{"key":"b","text":"تعتذر بلطف وتشرح أن معلومات المرضى سرية، وتبقى ثابتًا رغم الضغط."},{"key":"c","text":"تخبره جزئيًا."},{"key":"d","text":"تخبره إذا كان قريبًا."}],"correct":"b"},{"id":"as1","category":"safety","text":"قبل تجهيز أدوات غيار، ما أول خطوة؟","options":[{"key":"a","text":"تجهز الأدوات على أي سطح متوفر."},{"key":"b","text":"تغسل يديك، وتجهز سطحًا نظيفًا وأدوات معقمة، وتتأكد من سلامة الأدوات."},{"key":"c","text":"تطلب من المريض تجهيز الأدوات."},{"key":"d","text":"تبدأ الغيار دون تجهيز."}],"correct":"b"},{"id":"ac1","category":"communication","text":"مريضة مسنّة لا تسمع جيدًا وتحتاج شرحًا قبل قياس الضغط. كيف تتصرف؟","options":[{"key":"a","text":"تصرخ في وجهها."},{"key":"b","text":"تتكلم بوضوح وببطء قريبًا منها، وتستخدم الإشارة، وتتأكد من فهمها."},{"key":"c","text":"تتجاهلها وتقيس الضغط دون شرح."},{"key":"d","text":"تطلب من أسرتها إخراجها."}],"correct":"b"},{"id":"ar1","category":"resilience","text":"يومك طويل وفيه زيارات كثيرة متتالية وأنت مرهق. ماذا تفعل؟","options":[{"key":"a","text":"تتخطى توثيق الزيارات لتوفير الوقت."},{"key":"b","text":"تلتزم ببروتوكول كل زيارة وتوثيقها، وتبلغ الإدارة إن شعرت أنك لن تستطيع العمل بأمان."},{"key":"c","text":"تختصر الغيارات دون إخبار أحد."},{"key":"d","text":"تلغي باقي الزيارات دون إخبار."}],"correct":"b"},{"id":"am3","category":"medical","text":"كمساعد تمريض، لاحظت احمرارًا في جلد مريض طريح الفراش عند نقاط الضغط. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهله، فهو ليس من مهامك."},{"key":"b","text":"تبلغ الممرض المسؤول فورًا، وتساعد في تغيير وضع المريض حسب التعليمات، وتوثق الملاحظة."},{"key":"c","text":"تضع مرهمًا من عندك دون إخبار أحد."},{"key":"d","text":"تنتظر حتى يصبح جرحًا."}],"correct":"b"},{"id":"ae2","category":"ethics","text":"أسرة مريض تطلب منك كمساعد إعطاء حقنة للمريض لأن الممرض تأخر. ماذا تفعل؟","options":[{"key":"a","text":"ترفض بأدب: إعطاء الحقن خارج نطاق المساعد، وتتصل بالممرض أو الإدارة فورًا."},{"key":"b","text":"تعطي نصف الجرعة فقط."},{"key":"c","text":"تطلب من أحد أفراد الأسرة إعطاءها."},{"key":"d","text":"تعطي الحقنة بنفسك لتساعد الأسرة."}],"correct":"a"},{"id":"as2","category":"safety","text":"كمريض مساعد، وجدت مريضًا بعد عملية يحاول النهوض وحده من السرير. ماذا تفعل؟","options":[{"key":"a","text":"تسحبه من ذراعه بقوة إلى السرير."},{"key":"b","text":"تغادر الغرفة."},{"key":"c","text":"تتركه ينهض وحده."},{"key":"d","text":"تبقى قربه، وتمنعه بلطف من النهوض المفاجئ، وتطلب الممرض فورًا، ولا ترفعه وحدك بطريقة غير آمنة."}],"correct":"d"},{"id":"nm1","category":"medical","text":"في العناية بالجروح بالضغط السلبي (NPWT)، ما أهم نقطة؟","options":[{"key":"a","text":"تغيير الجهاز كل ساعة."},{"key":"b","text":"التأكد من إحكام الغلق، ومراقبة الإفرازات والضغط، وتوثيق كل تغيير حسب البروتوكول."},{"key":"c","text":"إيقاف الجهاز ليلًا دون إخبار."},{"key":"d","text":"استخدام أي ضماد متاح."}],"correct":"b"},{"id":"nm2","category":"medical","text":"قبل تركيب كانيولا، ما أهم خطوة؟","options":[{"key":"a","text":"تركيبها مباشرة."},{"key":"b","text":"غسل اليدين، وتجهيز الأدوات المعقمة، واختيار الوريد المناسب، والتأكد من هوية المريض."},{"key":"c","text":"طلب المساعدة من الأسرة."},{"key":"d","text":"تركيبها بدون قفازات لتوفير الوقت."}],"correct":"b"},{"id":"ne1","category":"ethics","text":"أثناء الزيارة، سمعت معلومة صحية حساسة عن المريض من أحد أقاربه. ماذا تفعل؟","options":[{"key":"a","text":"تنشرها في مجموعة العمل."},{"key":"b","text":"تحتفظ بها سرًا ولا تشاركها إلا مع الفريق الطبي المعني عند الحاجة."},{"key":"c","text":"تخبر الجيران للاطمئنان."},{"key":"d","text":"تسجلها في منشور عام."}],"correct":"b"},{"id":"ns1","category":"safety","text":"قبل تركيب قسطرة بولية، ما أهم إجراء سلامة؟","options":[{"key":"a","text":"التركيب بسرعة دون تجهيز."},{"key":"b","text":"التأكد من أمر الطبيب المكتوب، والتعقيم الكامل، وتأكيد هوية المريض، ثم إكمال قائمة الأمان."},{"key":"c","text":"التركيب دون أمر طبيب."},{"key":"d","text":"طلب المساعدة من الأسرة للتركيب."}],"correct":"b"},{"id":"nc1","category":"communication","text":"سائح يسألك بالإنجليزية: \"When will the nurse come?\" وأنت لا تفهم كل كلامه. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهله وتغادر."},{"key":"b","text":"ترد بإنجليزية بسيطة واضحة، وتستخدم الإشارة، وتطلب مساعدة الإدارة إن لزم."},{"key":"c","text":"ترد بالعربية بصوت أعلى."},{"key":"d","text":"تقول \"لا أفهم\" وتتركه."}],"correct":"b"},{"id":"nr1","category":"resilience","text":"تدهورت حالة مريض فجأة أثناء زيارتك (ضيق نفس شديد). ماذا تفعل أولًا؟","options":[{"key":"a","text":"تكمل الغيار أولًا."},{"key":"b","text":"توقف الإجراء، وتقيّم مجرى الهواء والتنفس، وتتصل بالإسعاف 123، وتبلغ الإدارة."},{"key":"c","text":"تطلب من الأسرة التصرف وحدها."},{"key":"d","text":"تغادر البيت فورًا."}],"correct":"b"},{"id":"nm3","category":"medical","text":"كممرض، لاحظت تورمًا وألمًا في موضع الكانيولا أثناء محلول وريدي. ماذا تفعل؟","options":[{"key":"a","text":"تعطي مسكنًا وتغادر."},{"key":"b","text":"تكمل المحلول وتتجاهل التورم."},{"key":"c","text":"توقف المحلول فورًا، وتقيّم موضع الكانيولا، وتبلغ الطبيب، وتوثق الحدث."},{"key":"d","text":"تزيد سرعة المحلول."}],"correct":"c"},{"id":"ne2","category":"ethics","text":"مريض يعرض عليك ساعة ثمينة هدية مقابل «الاهتمام الخاص» به. ماذا تفعل؟","options":[{"key":"a","text":"تقبلها، فهي هدية شخصية."},{"key":"b","text":"ترفض بأدب، وتوضح أن كل المرضى يأخذون نفس الاهتمام، وأن الهدايا الثمينة مرفوضة."},{"key":"c","text":"تقبلها سرًا."},{"key":"d","text":"تطلب هدية أثمن."}],"correct":"b"},{"id":"ns2","category":"safety","text":"كممرض، شممت رائحة غاز من أسطوانة أكسجين في بيت مريض. ماذا تفعل؟","options":[{"key":"a","text":"تهوّي المكان، وتبتعد عن أي لهب، وتغلق صمام الأسطوانة إن أمكن بأمان، وتبلغ الإدارة فورًا."},{"key":"b","text":"تتجاهل الرائحة وتكمل الزيارة."},{"key":"c","text":"تنقل الأسطوانة بنفسك إلى الشارع."},{"key":"d","text":"تشعل عود ثقاب لترى مصدر التسرب."}],"correct":"a"},{"id":"dm1","category":"medical","text":"مريض منزلي لديه ألم صدر شديد وضيق نفس. ما القرار الصحيح؟","options":[{"key":"a","text":"تعالجه في البيت وتطمئنه."},{"key":"b","text":"تحوّله فورًا للمستشفى بالإسعاف 123، فالرعاية المنزلية غير كافية هنا."},{"key":"c","text":"تصف له مسكنًا وتغادر."},{"key":"d","text":"تطلب منه الانتظار حتى الصباح."}],"correct":"b"},{"id":"dm2","category":"medical","text":"سائح يطلب شهادة \"Fit to Fly\" قبل سفره. ماذا تفعل؟","options":[{"key":"a","text":"تصدرها فورًا دون فحص."},{"key":"b","text":"تفحصه وتقيّم حالته وفق معايير السفر الجوي، وتصدر الشهادة فقط إن كانت حالته تسمح بذلك."},{"key":"c","text":"ترفض دون فحص."},{"key":"d","text":"تصدرها مقابل مال إضافي."}],"correct":"b"},{"id":"de1","category":"ethics","text":"مريض يطلب منك وصف دواء لا يحتاجه طبيًا. ماذا تفعل؟","options":[{"key":"a","text":"تصفه له لإرضائه."},{"key":"b","text":"ترفض بأدب وتشرح له لماذا لا يحتاجه، وتقترح البديل المناسب إن وجد."},{"key":"c","text":"تصفه بجرعة مضاعفة."},{"key":"d","text":"تتجاهل طلبه."}],"correct":"b"},{"id":"ds1","category":"safety","text":"لاحظت أن حالة مريض منزلي تحتاج متابعة مستشفى وليس رعاية منزلية. ماذا تفعل؟","options":[{"key":"a","text":"تستمر في الزيارات المنزلية فقط."},{"key":"b","text":"توثق تقييمك وتحوّل المريض للمستشفى، وتبلغ الإدارة وأسرته بالسبب."},{"key":"c","text":"توقف الزيارات دون إخبار أحد."},{"key":"d","text":"تطلب من الأسرة البحث عن طبيب آخر."}],"correct":"b"},{"id":"dc1","category":"communication","text":"كيف تشرح لمريض تشخيصه وخطة علاجه بلغة بسيطة؟","options":[{"key":"a","text":"تستخدم المصطلحات الطبية كما هي دون شرح."},{"key":"b","text":"تشرح بكلمات بسيطة وأمثلة يومية، وتتأكد من فهمه، وتجيب عن أسئلته بصبر."},{"key":"c","text":"تعطيه ورقة إنجليزية وتغادر."},{"key":"d","text":"تطلب منه البحث على الإنترنت."}],"correct":"b"},{"id":"dr1","category":"resilience","text":"اتصال طارئ في منتصف الليل وأنت متعب بعد يوم طويل. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهل الاتصال."},{"key":"b","text":"تقيّم حالتك بصدق: إن كنت قادرًا على العمل بأمان تستجيب، وإلا تبلغ الإدارة فورًا ليجدوا بديلًا."},{"key":"c","text":"تذهب وأنت غير قادر على التركيز دون إخبار أحد."},{"key":"d","text":"تطلب من المريض الانتظار حتى الصباح دون تقييم."}],"correct":"b"},{"id":"dm3","category":"medical","text":"كطبيب زيارة منزلية، مريض يشتكي ألم صدر شديد مع تعرق وضيق نفس. ماذا تفعل؟","options":[{"key":"a","text":"تطلب منه المشي قليلًا."},{"key":"b","text":"تغادر وتطلب منه الحضور للعيادة."},{"key":"c","text":"تعطيه مسكنًا وتطلب منه الانتظار حتى الغد."},{"key":"d","text":"تقيّم العلامات الحيوية، وتتصل بالإسعاف 123 فورًا لاحتمال جلطة قلبية، ولا تؤخر النقل."}],"correct":"d"},{"id":"de2","category":"ethics","text":"أسرة مريض تطلب منك إخفاء التشخيص عن المريض نفسه. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهل الأسرة والمريض معًا."},{"key":"b","text":"تخفي التشخيص فورًا دون نقاش."},{"key":"c","text":"تشرح حق المريض في معرفة حالته، وتناقش مع الأسرة والمريض معًا طريقة إبلاغ مناسبة."},{"key":"d","text":"تكذب على المريض بتشخيص آخر."}],"correct":"c"},{"id":"ds2","category":"safety","text":"كطبيب، وجدت دواء طوارئ منتهي الصلاحية في حقيبتك قبل زيارة. ماذا تفعل؟","options":[{"key":"a","text":"تستخدمه إن احتجته، فالانتهاء حديث."},{"key":"b","text":"لا تستخدمه إطلاقًا، وتستبدله بدواء صالح، وتوثق التخلص منه وتبلغ الإدارة."},{"key":"c","text":"تخفي تاريخ الصلاحية."},{"key":"d","text":"تعطيه للمريض ليحتفظ به."}],"correct":"b"},{"id":"pm1","category":"medical","text":"مريض بعد جلطة يبدأ تأهيلًا حركيًا في البيت. ما أول خطوة؟","options":[{"key":"a","text":"تبدأ تمارين قوية فورًا."},{"key":"b","text":"تقيّم حالته وقدرته الحركية وخطر السقوط، وتضع خطة تمارين تدريجية آمنة."},{"key":"c","text":"تطلب منه المشي وحده دون إشراف."},{"key":"d","text":"تعطيه أدوية مسكنة."}],"correct":"b"},{"id":"pm2","category":"medical","text":"مريض بعد كسر يشتكي ألمًا شديدًا أثناء التمرين. ماذا تفعل؟","options":[{"key":"a","text":"تستمر في التمرين رغم الألم."},{"key":"b","text":"توقف التمرين، وتقيّم الألم، وتعدّل الخطة أو تحيله للطبيب إن لزم."},{"key":"c","text":"تطلب منه تحمل الألم دون توقف."},{"key":"d","text":"تعطيه دواءً من عندك."}],"correct":"b"},{"id":"pe1","category":"ethics","text":"مريض يطلب منك وصف دواء لألم عضلاته. ماذا تفعل؟","options":[{"key":"a","text":"تصف له الدواء بنفسك."},{"key":"b","text":"توضح أن وصف الأدوية خارج نطاق دورك، وتحيله للطبيب."},{"key":"c","text":"تعطيه دواءً من حقيبتك."},{"key":"d","text":"تتجاهل طلبه."}],"correct":"b"},{"id":"ps1","category":"safety","text":"مريض مسنّ معرّض للسقوط أثناء تمارين التوازن والمشي. ماذا تفعل؟","options":[{"key":"a","text":"تتركه يتدرب وحده."},{"key":"b","text":"تؤمّن المكان، وتبقى قريبًا منه طوال التمرين، وتستخدم دعمًا مناسبًا، وتوقف التمرين عند أي خطر."},{"key":"c","text":"تطلب منه التدرب على الدرج."},{"key":"d","text":"تستمر رغم الدوار."}],"correct":"b"},{"id":"pc1","category":"communication","text":"مريض مسنّ محبط لأن تحسنه بطيء. كيف تتعامل معه؟","options":[{"key":"a","text":"تخبره أنه لن يتحسن أبدًا."},{"key":"b","text":"تشجعه، وتشرح له التقدم التدريجي بأمثلة واضحة، وتضع أهدافًا صغيرة واقعية."},{"key":"c","text":"تتجاهل إحباطه."},{"key":"d","text":"تلغي جلساته."}],"correct":"b"},{"id":"pr1","category":"resilience","text":"جلسات تأهيل طويلة وتقدم بطيء والأسرة تضغط عليك. ماذا تفعل؟","options":[{"key":"a","text":"تستسلم للضغط وتغيّر الخطة دون أساس."},{"key":"b","text":"تشرح للأسرة واقع التقدم بهدوء، وتلتزم بالخطة العلاجية، وتوثق كل جلسة."},{"key":"c","text":"تترك المريض دون إخبار."},{"key":"d","text":"تختصر الجلسات سرًا."}],"correct":"b"},{"id":"pm3","category":"medical","text":"كأخصائي علاج طبيعي، مريض يشتكي ألمًا حادًا مع تنميل أثناء تمرين. ماذا تفعل؟","options":[{"key":"a","text":"توقف التمرين فورًا، وتقيّم الألم والتنميل، وتوثق، وتحيله للطبيب إن استمر."},{"key":"b","text":"تزيد شدة التمرين."},{"key":"c","text":"تتجاهل الشكوى وتكمل الجلسة."},{"key":"d","text":"تطلب منه الاستمرار رغم الألم."}],"correct":"a"},{"id":"pe2","category":"ethics","text":"مريض يطلب منك جلسات إضافية خارج الخطة العلاجية مقابل دفع نقدي مباشر. ماذا تفعل؟","options":[{"key":"a","text":"توافق سرًا دون حجز."},{"key":"b","text":"تضاعف السعر وتوافق."},{"key":"c","text":"توافق وتأخذ المال مباشرة."},{"key":"d","text":"ترفض: أي جلسة إضافية تحتاج تقييم الطبيب وحجزًا عبر التطبيق."}],"correct":"d"},{"id":"ps2","category":"safety","text":"كأخصائي علاج طبيعي، لاحظت أرضية مبللة في منطقة التمارين قبل بدء الجلسة. ماذا تفعل؟","options":[{"key":"a","text":"تتجاهل الأمر تمامًا."},{"key":"b","text":"تبدأ الجلسة فورًا رغم البلل."},{"key":"c","text":"توقف البدء، وتجفف المنطقة أو تنقل التمرين لمكان آمن، وتبلغ عن الخطر."},{"key":"d","text":"تطلب من المريض المشي على الأرض المبللة."}],"correct":"c"}];
// English check — 3 simple questions, UNSCORED, no certificate needed.
// Reported separately as english: { correct, total, level }.
const ENGLISH_CHECK = [
  { id: 'en1', text: 'A patient says: "I have pain here." What do you say first?', options: [
    { key: 'a', text: '"Can you show me where, and how strong is the pain from 1 to 10?"' },
    { key: 'b', text: '"Please wait outside."' },
    { key: 'c', text: '"I do not understand."' },
    { key: 'd', text: '"Take this medicine now."' }], correct: 'a' },
  { id: 'en2', text: 'How do you ask a patient about their medicine in English?', options: [
    { key: 'a', text: '"What medicine do you take every day?"' },
    { key: 'b', text: '"Why are you sick?"' },
    { key: 'c', text: '"Give me your money."' },
    { key: 'd', text: '"Go home now."' }], correct: 'a' },
  { id: 'en3', text: 'A tourist asks: "When will the nurse come?" A good answer is:', options: [
    { key: 'a', text: '"The nurse will come in about 30 minutes."' },
    { key: 'b', text: '"No."' },
    { key: 'c', text: '"I am busy."' },
    { key: 'd', text: '"Ask someone else."' }], correct: 'a' },
];

// ---------------------------------------------------------------- Terms & Conditions (v2.0.8)
// Canonical Arabic text also lives in ~/workspace/shifa-care-rebuild/
// TERMS-AND-CONDITIONS.md. The server is the source of truth for the
// current version: clients must send acceptedTerms=true with this
// version or registration / booking creation is rejected (400).
const TERMS_VERSION = '1.0';
const TERMS_UPDATED_AT = '2026-11-25';
const TERMS_AR = `الشروط والأحكام — شفاء كير (الإصدار 1.0، 25 نوفمبر 2026)

1) ما هو شفاء كير؟
شفاء كير تطبيق مستقل للرعاية الطبية المنزلية في مدينة القصير، محافظة البحر الأحمر. يربط التطبيق بين المرضى (أو أسرهم) ومقدمي رعاية صحية موثّقين (ممرض، مساعد تمريض، طبيب) لزيارات منزلية وفندقية. عقد تقديم الخدمة الطبية يكون بين المريض ومقدم الخدمة مباشرة؛ وشفاء كير وسيط تقني يربط بينهما ويتقاضى عمولته فقط، ولا يقدّم الخدمة الطبية بنفسه. التطبيق ليس مستشفى ولا عيادة، ولا يغني عن الإسعاف أو الطوارئ: في أي حالة طارئة اتصل بالإسعاف 123 فورًا.

2) الحساب والتسجيل
- التسجيل برقم هاتف مصري صحيح. أنت مسؤول عن حسابك وعن صحة بياناتك.
- مقدم الخدمة يقدّم بياناته الحقيقية (الاسم، الرقم القومي، رقم ترخيص مزاولة المهنة، الشهادات). أي بيانات مزوّرة تؤدي لإيقاف الحساب نهائيًا.
- التصنيف المهني (مساعد تمريض / ممرض / طبيب) يُحدَّد من الشهادات المرفوعة مع مراجعة بشرية من الإدارة، وليس من اختيارك وحدك.
- لا يجوز إنشاء أكثر من حساب واحد لنفس الشخص أو نفس رقم الهاتف.

3) منع الالتفاف — التعامل خارج التطبيق ممنوع
- جميع الحجوزات والدفع والتواصل تتم داخل التطبيق فقط.
- يُمنع على مقدم الخدمة والعميل: تبادل أرقام الهواتف الشخصية، أو الاتفاق على زيارات أو أسعار خارج التطبيق، أو دفع أي مبلغ نقدًا خارج التطبيق، أو طلب مال إضافي من العميل.
- التواصل داخل التطبيق فقط، ويُغلق بعد انتهاء الزيارة بـ 24 ساعة. أي رسالة تحوي رقم هاتف تُرفض تلقائيًا.
- مخالفة هذا البند تعرّض المخالف للعقوبات المتدرجة (البند 10)، حتى الحظر النهائي ومصادرة المستحقات المعلقة.

4) الأسعار والدفع المحفوظ
- الأسعار ثابتة ومعلنة في التطبيق، ولا مساومة عليها.
- العميل يدفع عند الحجز، ويبقى المبلغ محفوظًا في التطبيق (Escrow) ولا يصل لمقدم الخدمة إلا بعد إتمام الخدمة وتأكيد العميل والتقييم، أو بعد ساعة من التأكيد بلا تقييم ولا شكوى. المبلغ يبقى محجوزًا لنافذة الشكوى (24 ساعة) قبل الصرف النهائي.
- طرق الدفع الحالية: كاش بإيصال عند الزيارة، أو InstaPay. الحساب البنكي والبوابات الإلكترونية قادمة لاحقًا.
- رسوم المسافة: 0–6 كم بدون إضافة، 6–10 كم +100 جنيه، 10–20 كم +200، 20–35 كم +350، عند 35 كم +500، وأكثر من 35 كم تعاقد خاص فقط. إن وفّر العميل مواصلة ذهاب وعودة لمقدم الخدمة فلا رسم مسافة.
- التسوية الأسبوعية كل يوم خميس: يُعرض دفتر حساب يوضح ما للتطبيق وما لمقدم الخدمة، وحتى لو تحصّل مقدم الخدمة كاش بيده يظهر عليه ما للتطبيق ويدفعه في التسوية.
- عمولة التطبيق: يأخذ مقدم الخدمة الإجمالي، والتطبيق يأخذ نسبته فقط: Starter 15%، Pro 12%، Elite 8% (معكوسة: كلما تطوّر مقدم الخدمة قلّت عمولته) + بونص حجم شهري نقدي: 500 جنيه عند 15 حالة مكتملة، 1,000 جنيه عند 30 حالة، 1,500 جنيه عند 60 حالة (أعلى شريحة فقط، وليست تراكمية)، يُصرف مع التسوية الأسبوعية. وفي شهور العروض الترويجية (بحد أقصى شهرين في السنة، تُعلن مسبقًا) قد تُخفَّض العمولة أو تُلغى تمامًا (0%)، ويتوقف البونص النقدي مؤقتًا في شهور العمولة صفر بينما تستمر الألقاب. وقسائم ولاء المرضى: بعد كل 4 زيارات مكتملة مدفوعة يحصل المريض تلقائيًا على قسيمة خصم 50 جنيهًا لزيارته التالية (صالحة 60 يومًا، لحد أدنى للحجز 300 جنيه، قسيمة واحدة لكل حجز)، يموّلها التطبيق بالكامل، ويأخذ مقدم الخدمة سعره كاملًا (العمولة تُحسب على السعر الكامل قبل الخصم). نسب العمولات والبونص تفاصيل داخلية لا تظهر في إعلانات المرضى.

5) ميثاق الاحترام
- يعامل كل طرف الآخر باحترام كامل: لا إهانة لفظية أو تحرش أو تهديد، والالتزام بموعد الزيارة وتجهيز المكان.
- أسعار ثابتة بلا مساومة، ولغة محترمة، وتقييم مزدوج بعد الزيارة.
- مخالفة الميثاق تعني تحذيرًا ثم إيقاف الحساب.

6) الإلغاء والشكاوى والاسترداد
- الإلغاء مسموح فقط خلال 15 دقيقة من إنشاء الحجز، وبعدها لا يمكن الإلغاء. الإلغاء المبكر يسترد المبلغ المحفوظ كاملًا.
- نافذة الشكوى 24 ساعة فقط بعد إتمام الخدمة. بعد مراجعة الإدارة، الشكوى المقبولة تسترد المبلغ كاملًا للعميل.
- الشكوى المفتوحة توقف تحويل المبلغ لمقدم الخدمة حتى تحسمها الإدارة.

7) السلامة والخصوصية
- لا يجوز تصوير المريض أو نشر صوره أو بياناته الصحية خارج التطبيق بأي شكل. صور الجروح تُستخدم داخل التقرير الطبي فقط وبموافقة المريض.
- مقدم الخدمة ملتزم بإجراءات مكافحة العدوى والتعقيم، وبتوثيق العلامات الحيوية قبل إتمام أي زيارة.
- في الحالات الطارئة (فقدان وعي، نزيف لا يتوقف، ألم صدر، ضيق تنفس شديد، أعراض جلطة) لا يُحجز ولا يُعالج في البيت — يُتصل بالإسعاف 123 فورًا.
- زر SOS داخل التطبيق لتنبيه الإدارة في المواقف الخطرة أثناء الزيارة.

8) التقييم والدرجات
- بعد كل زيارة يقيّم كل طرف الآخر. التقييم يؤثر على الدرجة والفئة (Starter / Pro / Elite) وأولوية الإسناد.
- التقييم يسأل أيضًا: هل طلب مقدم الخدمة التعامل خارج التطبيق؟ الإجابة بنعم تُحال للإدارة فورًا وتوقف صرف مبلغ تلك الزيارة حتى المراجعة.
- كل شهادة دورة موثّقة تضيف 5 نقاط تحقق (بحد أقصى 15) وتمنح شارة «مدرب معتمد».

9) مسؤولية التطبيق
- شفاء كير وسيط تقني فقط: عقد الخدمة الطبية بين العميل ومقدم الخدمة مباشرة، والتطبيق لا يقدّم الخدمة الطبية بنفسه ولا يتحمل مسؤولية تقديمها؛ ويراجع المستندات والشهادات قدر المستطاع، لكن القرار الطبي النهائي لمقدم الخدمة المعالج.
- التطبيق غير مسؤول عن تأخر ناتج عن ظروف خارجة عن إرادته (طقس، طرق، إغلاقات).

10) العقوبات المتدرجة
- تحذير رسمي مسجّل على الحساب.
- إيقاف مؤقت: يُغلق الرادار وقبول الطلبات والمحفظة حتى ترفع الإدارة الإيقاف.
- حظر نهائي: إغلاق الحساب ومصادرة المستحقات المعلقة، عند تكرار المخالفة أو مخالفة جسيمة (تشارك بيانات مرضى، تزوير، تعامل خارج التطبيق، رفض رعاية بسبب جنسية أو دين أو مستوى مادي).
- للمخالف حق الاعتراض بمراسلة الإدارة من داخل التطبيق قبل مرور 7 أيام من العقوبة.

11) تغيير الشروط
- يجوز لشفاء كير تعديل هذه الشروط مع إشعار داخل التطبيق. استمرار استخدام التطبيق بعد التعديل يعني الموافقة عليه، ويُطلب منك تأكيد النسخة الجديدة قبل أي حجز أو تسجيل جديد.

12) الباقات الشهرية
- الباقة الشهرية = 26 يوم رعاية + 4 أيام إجازة للممرض (شهر العمل المصري: 26 يومًا + 4 أيام).
- الأسعار المعروضة للباقات «تبدأ من» وليست ثابتة: السعر النهائي بعرض سعر مكتوب من الإدارة بعد تقييم الحالة (ما يعاني منه المريض، التشخيص، العلاج، والاحتياجات). يقدّم العميل طلب باقة بتفاصيل الحالة، وتحدد الإدارة السعر النهائي، ويراه العميل ويقبل أو يرفض.
- سلم مستويات الرعاية: **مساعد تمريض** (رعاية أساسية: استحمام/إطعام/حركة/مرافقة/علامات حيوية) 12 ساعة 350 جنيه/يوم ← باقة 8,000 (بدل 9,100)، و24 ساعة 600 ← 13,700 (بدل 15,600)؛ **فني تمريض** (تمريض عادي: غيارات/حقن/كانيولا/قساطر) 12 ساعة 550 ← 12,600 (بدل 14,300)، و24 ساعة 950 ← 21,700 (بدل 24,700)؛ **أخصائي تمريض** (متقدم/معقد: NPWT وإجراءات عالية الخطورة) 12 ساعة 750 ← 17,200 (بدل 19,500)، و24 ساعة 1,250 ← 28,600 (بدل 32,500)؛ باقات المسنين 12 ساعة: متحرك 8,000 (بدل 9,100) و قعيد 12,600 (بدل 14,300) — وهذه الأسعار «تبدأ من» فقط: سعر باقة المسنين النهائي يعتمد على **علاج المسن وأدويته وحالته الصحية** إضافة إلى حركته والمستوى الذي يحتاجه، وتحدده الإدارة في عرض السعر المكتوب بعد تقييم الحالة. لذلك يلتقط نموذج طلب باقة المسنين العلاج/الأدوية والحالة الصحية صراحةً (إلزامي) إلى جانب الحركة والاحتياجات. تحدد الإدارة في عرض السعر المستوى الذي تستدعيه الحالة فعلًا، ولا يعمل أي مستوى فوق مؤهله أبدًا. شيفت اليوم الواحد (خارج الباقة) يبقى 12 ساعة 500 و24 ساعة 850 — اليوم المنفرد أغلى من اليوم داخل شهر مضمون.
- عرض شهر الإطلاق (لفترة محدودة يعلنها التطبيق مسبقًا): شيفت اليوم الواحد (12 ساعة / 24 ساعة) بسعر العرض 500 / 850 جنيهًا، ويحصل مقدم الخدمة على حصته كأن السعر المرجعي 700 (12 ساعة) / 1,200 (24 ساعة) بالجنيه المصري — والتطبيق يموّل الفرق كاملًا من حسابه كاستثمار إطلاق، فلا يتحمل الممرض أي خصم بسبب العرض. العرض على شيفتات اليوم الواحد فقط، ولا يشمل الباقات الشهرية أو أي خدمة أخرى.
- باقات إقامة السياح (بالدولار/يورو في اليوم، وباقة 26 يومًا «تبدأ من»): مساعد $25/$45 ← $575/$1,030 (€530/€950)؛ فني $35/$60 ← $800/$1,375 (€735/€1,265)؛ أخصائي $45/$75 ← $1,030/$1,720 (€950/€1,580) — (12 ساعة/24 ساعة).
- الأيام الأربعة الإضافية غير مشمولة افتراضيًا، ويضيفها العميل باختياره: ممرض بديل بالسعر اليومي العادي للمستوى، أو الممرض الأساسي إضافي بعلاوة 25% (تُعفى العلاوة في شهر عرض الإطلاق).
- رسم المسافة مضمّن في سعر الباقة داخل مدينة القصير.
- الدفع: الشهر كامل مقدمًا في الإسكرو، ويُصرف للممرض أسبوعيًا كل يوم خميس عن الأيام المكتملة فقط. الأيام المكتملة والمصروفة أسبوعيًا لا تُسترد بعد صرفها.
- الإلغاء: قبل بدء الباقة = استرداد كامل للمبلغ المدفوع؛ وبعد البدء = استرداد الأيام المتبقية بسعر اليوم في الباقة (سعر الباقة ÷ 26). والأيام الإضافية غير المنفَّذة تُسترد أيضًا.
- عمولة التطبيق على الباقات هي نفس النسب المعتادة (Starter 15%، Pro 12%، Elite 8%) من السعر النهائي للباقة.

باستخدامك التطبيق فأنت تقر بأنك قرأت هذه الشروط والأحكام وفهمتها ووافقت عليها بالكامل.`;

const TERMS_EN = `Terms & Conditions — Shifa Care (Version 1.0, 25 November 2026) — summary. The Arabic text is the binding version.

1) Shifa Care is an independent home-medical platform in El Quseir, Red Sea, connecting patients with verified providers (nurse, nursing assistant, doctor). The medical service contract is between the patient and the provider directly; Shifa Care is a technical intermediary that connects them and takes its commission only, and does not itself provide the medical service. It is not a hospital or clinic. In any emergency call the ambulance on 123 immediately.
2) Register with a real Egyptian phone number and true data. Forged documents mean a permanent ban. Your professional category is set from your certificates with human review.
3) No circumvention: all bookings, payments and communication happen inside the app only. Exchanging personal phone numbers, agreeing visits or prices outside the app, or taking cash outside the app is forbidden. In-app chat closes 24 hours after the visit; messages containing phone numbers are rejected automatically.
4) Fixed published prices, no bargaining. Payment is held in escrow and released to the provider only after completion, patient confirmation and review (or one hour after confirmation with no review and no complaint), and stays held for the 24-hour complaint window before final payout. Weekly settlement every Thursday. App commission (reversed: the more a provider develops, the lower their commission): Starter 15%, Pro 12%, Elite 8% + monthly volume bonus: 500 EGP at 15 completed cases, 1,000 EGP at 30, 1,500 EGP at 60 (highest tier only), paid with the Thursday settlement. In promo months (max 2 per year, announced in advance) the commission may be reduced or set to 0%; cash volume bonuses pause in 0%-commission months while titles continue. Patient loyalty vouchers: after every 4 completed paid visits the patient automatically receives a 50 EGP voucher for the next visit (valid 60 days, minimum booking 300 EGP, one voucher per booking), fully funded by the app; the provider's share is always computed on the full pre-discount price.
5) Respect Charter: full respect both ways, no abuse or threats, keep appointments. Violations mean a warning, then suspension.
6) Cancellation only within 15 minutes of booking creation (full refund). Complaint window: 24 hours after completion; an accepted complaint is refunded in full.
7) Safety and privacy: never photograph or share patient data outside the app. Infection control and vital-signs documentation are mandatory. In emergencies call 123. SOS button alerts admin during dangerous visits.
8) Ratings affect tier and assignment priority. Reviews also ask whether the provider requested dealing outside the app — a "yes" goes to admin immediately and holds that visit's payout.
9) Shifa Care is a technical intermediary only: the medical service contract is between the patient and the provider directly, and the app does not itself provide the medical service; the treating provider holds final clinical responsibility.
10) Graduated penalties: recorded warning, temporary suspension (radar, acceptance and wallet closed), permanent ban with forfeiture of pending settlement for repeated or grave violations. You may appeal to admin within 7 days.
11) Terms may change with in-app notice; continued use means acceptance, and you will be asked to confirm a new version before any new booking or registration.
12) Monthly packages: a package = 26 days of care + 4 nurse days off (the Egyptian working month). Displayed package prices are indicative ("starting from") — the final price is a written admin quote after assessing the case (condition, diagnosis, treatment, needs); the patient submits a package request, admin sets the final price, and the patient accepts or declines. Care-level ladder: **nursing assistant** (basic care: bathing, feeding, movement, companionship, vitals) 12h 350 EGP/day → package 8,000 (instead of 9,100), 24h 600 → 13,700 (instead of 15,600); **nursing technician** (standard nursing: dressings, injections, cannula, catheters) 12h 550 → 12,600 (instead of 14,300), 24h 950 → 21,700 (instead of 24,700); **nursing specialist** (advanced/complex: NPWT and high-risk procedures) 12h 750 → 17,200 (instead of 19,500), 24h 1,250 → 28,600 (instead of 32,500); elderly 12h packages: mobile 8,000 (instead of 9,100), bedridden 12,600 (instead of 14,300) — these are "starting from" only: the final elderly package price depends on the **elderly person's treatment/medications and condition** in addition to mobility and the level needed, and the admin sets it in the written quote after assessing the case. The elderly package request form therefore captures treatment/medications and condition explicitly (required) alongside mobility and needs. The admin confirms the level the case actually needs in the quote, and no level ever works above its qualification. A single-day (non-package) shift stays 12h 500 / 24h 850 — a single day costs more than a day inside a guaranteed month. Launch-month offer (for a limited period announced in advance in the app): a single-day shift (12h / 24h) is offered at 500 / 850 EGP, and the provider still receives their share as if the price were 700 / 1,200 EGP — the app funds the full difference from its own account as a launch investment, so the provider loses nothing because of the offer. The offer covers single-day shifts only, not monthly packages or any other service. Tourist residence packages (per day in USD/EUR, 26-day package "starting from"): assistant $25/$45 → $575/$1,030 (€530/€950); technician $35/$60 → $800/$1,375 (€735/€1,265); specialist $45/$75 → $1,030/$1,720 (€950/€1,580) — (12h/24h). The 4 extra days are not included by default: a substitute nurse at the level's normal daily rate, or the main nurse as overtime at a +25% premium (premium waived in the launch-offer month). The distance fee is included inside El Quseir. Payment: the full month is paid upfront into escrow; the provider is paid weekly every Thursday for completed days only; completed days already settled are not refundable. Cancellation: before the package starts = full refund; after the start = refund of the remaining days at the package daily rate (package price ÷ 26); unworked extra days are refunded as well. The app commission on packages is the usual tier rate (Starter 15%, Pro 12%, Elite 8%) on the final package price.

By using the app you confirm you have read, understood and fully accepted these Terms & Conditions.`;

// v2.1.2 — supported languages for tourist work (owner decision 26 Nov
// 2026): English, German, Russian, Polish, Dutch, Chinese, Czech — the
// languages of the tourist groups visiting Egypt. Data-driven: the admin
// can add more languages (stored in data.languages, GET /api/languages);
// a language only becomes testable once a question bank exists for it
// (LANGUAGE_TESTS below). A certificate NEVER exempts anyone from a test.
const DEFAULT_LANGUAGES = [
  { code: 'en', nameAr: 'الإنجليزية', nameEn: 'English', nativeName: 'English' },
  { code: 'de', nameAr: 'الألمانية', nameEn: 'German', nativeName: 'Deutsch' },
  { code: 'ru', nameAr: 'الروسية', nameEn: 'Russian', nativeName: 'Русский' },
  { code: 'pl', nameAr: 'البولندية', nameEn: 'Polish', nativeName: 'Polski' },
  { code: 'nl', nameAr: 'الهولندية', nameEn: 'Dutch', nativeName: 'Nederlands' },
  { code: 'zh', nameAr: 'الصينية', nameEn: 'Chinese', nativeName: '中文' },
  { code: 'cs', nameAr: 'التشيكية', nameEn: 'Czech', nativeName: 'Čeština' },
];
// v2.1.2 — in-app language tests (owner decision 26 Nov 2026): one
// separate MCQ test per language a provider claims. ONLY the basic
// interactions needed for medical service delivery — NOT general
// fluency. 8 questions per language, one per topic: greeting,
// symptoms/pain, explaining the procedure, allergies/medications,
// aftercare, emergency phrases, payment/consent (+ a second
// symptoms question). Pass: >= 6/8. Questions are written IN the target
// language; `correct` is NEVER sent to the client (the server shuffles
// options at start, like the interview bank). A certificate never
// exempts anyone from a test. Retake: allowed after 7 days.
const LANGUAGE_TEST_QUESTIONS = 8;
const LANGUAGE_TEST_PASS_MIN = 6;
const LANGUAGE_TEST_MINUTES = 15;
const LANGUAGE_TEST_RETAKE_DAYS = 7;
// v2.1.6 — topics must match the rotated bank (medication + postcare
// replaced the old 'aftercare'; the bank is the authority).
const LANGUAGE_TEST_TOPICS = ['greeting', 'symptoms', 'procedure', 'allergies', 'medication', 'postcare', 'emergency', 'payment'];
const LANGUAGE_TESTS = {
  "en": [
    {
      "id": "en1",
      "topic": "greeting",
      "text": "A patient arrives at the door. What do you say first?",
      "options": [
        {
          "key": "a",
          "text": "Good morning, please come in."
        },
        {
          "key": "b",
          "text": "Leave your bag outside and wait."
        },
        {
          "key": "c",
          "text": "I am very busy today."
        },
        {
          "key": "d",
          "text": "Why did you come here?"
        }
      ],
      "correct": "a"
    },
    {
      "id": "en2",
      "topic": "symptoms",
      "text": "The patient says: “My head hurts a lot.” What is the problem?",
      "options": [
        {
          "key": "a",
          "text": "His stomach hurts."
        },
        {
          "key": "b",
          "text": "He has a bad headache."
        },
        {
          "key": "c",
          "text": "He cannot sleep at all."
        },
        {
          "key": "d",
          "text": "His leg is broken."
        }
      ],
      "correct": "b"
    },
    {
      "id": "en3",
      "topic": "procedure",
      "text": "Before you change a dressing, what do you tell the patient?",
      "options": [
        {
          "key": "a",
          "text": "Close your eyes and sleep."
        },
        {
          "key": "b",
          "text": "You must pay first."
        },
        {
          "key": "c",
          "text": "This may hurt a little, please stay still."
        },
        {
          "key": "d",
          "text": "Go home now."
        }
      ],
      "correct": "c"
    },
    {
      "id": "en4",
      "topic": "allergies",
      "text": "What should you ask before you give a new medicine?",
      "options": [
        {
          "key": "a",
          "text": "Do you like the colour?"
        },
        {
          "key": "b",
          "text": "Where do you live?"
        },
        {
          "key": "c",
          "text": "What is your job?"
        },
        {
          "key": "d",
          "text": "Are you allergic to any medicine?"
        }
      ],
      "correct": "d"
    },
    {
      "id": "en5",
      "topic": "medication",
      "text": "The patient asks: “How many tablets do I take?” What do you answer?",
      "options": [
        {
          "key": "a",
          "text": "Take one tablet after breakfast."
        },
        {
          "key": "b",
          "text": "Take all the tablets now."
        },
        {
          "key": "c",
          "text": "Stop taking them today."
        },
        {
          "key": "d",
          "text": "Give the tablets to someone else."
        }
      ],
      "correct": "a"
    },
    {
      "id": "en6",
      "topic": "postcare",
      "text": "After the visit, what do you tell the patient about the wound?",
      "options": [
        {
          "key": "a",
          "text": "Wash it with dirty water."
        },
        {
          "key": "b",
          "text": "Keep it clean and dry, and call us if it gets worse."
        },
        {
          "key": "c",
          "text": "Touch it with your hands often."
        },
        {
          "key": "d",
          "text": "Cover it with a wet cloth."
        }
      ],
      "correct": "b"
    },
    {
      "id": "en7",
      "topic": "emergency",
      "text": "The patient suddenly cannot breathe. What do you say first?",
      "options": [
        {
          "key": "a",
          "text": "Please wait outside."
        },
        {
          "key": "b",
          "text": "Drink some water and rest."
        },
        {
          "key": "c",
          "text": "Stay calm, I am calling an ambulance now."
        },
        {
          "key": "d",
          "text": "Come back tomorrow."
        }
      ],
      "correct": "c"
    },
    {
      "id": "en8",
      "topic": "payment",
      "text": "The visit costs 300 pounds. How do you confirm the payment?",
      "options": [
        {
          "key": "a",
          "text": "Pay me later, maybe."
        },
        {
          "key": "b",
          "text": "The price is a secret."
        },
        {
          "key": "c",
          "text": "You do not need to pay."
        },
        {
          "key": "d",
          "text": "The visit is 300 pounds, please pay now."
        }
      ],
      "correct": "d"
    },
    {
      "id": "en9",
      "topic": "greeting",
      "text": "How do you introduce yourself to a new patient?",
      "options": [
        {
          "key": "a",
          "text": "Hello, my name is Sara, I am your nurse."
        },
        {
          "key": "b",
          "text": "I do not like new patients."
        },
        {
          "key": "c",
          "text": "Hurry up, please."
        },
        {
          "key": "d",
          "text": "I am going home now."
        }
      ],
      "correct": "a"
    },
    {
      "id": "en10",
      "topic": "symptoms",
      "text": "The patient says: “I feel sick and I want to vomit.” What does that mean?",
      "options": [
        {
          "key": "a",
          "text": "He is very hungry."
        },
        {
          "key": "b",
          "text": "He feels nauseous and may vomit."
        },
        {
          "key": "c",
          "text": "He has a broken arm."
        },
        {
          "key": "d",
          "text": "He wants to go for a walk."
        }
      ],
      "correct": "b"
    },
    {
      "id": "en11",
      "topic": "procedure",
      "text": "You need to take a blood sample. What do you explain?",
      "options": [
        {
          "key": "a",
          "text": "You must run fast first."
        },
        {
          "key": "b",
          "text": "Do not eat for a week."
        },
        {
          "key": "c",
          "text": "I will take a small blood sample from your arm."
        },
        {
          "key": "d",
          "text": "The test is not important."
        }
      ],
      "correct": "c"
    },
    {
      "id": "en12",
      "topic": "medication",
      "text": "The patient says: “I forgot my morning medicine.” What do you tell him?",
      "options": [
        {
          "key": "a",
          "text": "Take three doses at once."
        },
        {
          "key": "b",
          "text": "Never take it again."
        },
        {
          "key": "c",
          "text": "Give it to your friend."
        },
        {
          "key": "d",
          "text": "Take it now, and do not double the next dose."
        }
      ],
      "correct": "d"
    }
  ],
  "de": [
    {
      "id": "de1",
      "topic": "greeting",
      "text": "Ein Patient kommt an die Tür. Was sagen Sie zuerst?",
      "options": [
        {
          "key": "a",
          "text": "Gehen Sie weg."
        },
        {
          "key": "b",
          "text": "Guten Morgen, bitte kommen Sie herein."
        },
        {
          "key": "c",
          "text": "Ich habe keine Zeit."
        },
        {
          "key": "d",
          "text": "Warum sind Sie hier?"
        }
      ],
      "correct": "b"
    },
    {
      "id": "de2",
      "topic": "symptoms",
      "text": "Der Patient sagt: „Mein Bauch tut sehr weh.“ Was bedeutet das?",
      "options": [
        {
          "key": "a",
          "text": "Er hat Hunger."
        },
        {
          "key": "b",
          "text": "Er ist sehr müde."
        },
        {
          "key": "c",
          "text": "Er hat starke Bauchschmerzen."
        },
        {
          "key": "d",
          "text": "Er freut sich."
        }
      ],
      "correct": "c"
    },
    {
      "id": "de3",
      "topic": "procedure",
      "text": "Bevor Sie einen Verband wechseln, was sagen Sie dem Patienten?",
      "options": [
        {
          "key": "a",
          "text": "Schlafen Sie jetzt."
        },
        {
          "key": "b",
          "text": "Bezahlen Sie zuerst."
        },
        {
          "key": "c",
          "text": "Gehen Sie nach Hause."
        },
        {
          "key": "d",
          "text": "Das kann ein bisschen wehtun, bitte bleiben Sie ruhig liegen."
        }
      ],
      "correct": "d"
    },
    {
      "id": "de4",
      "topic": "allergies",
      "text": "Was fragen Sie, bevor Sie ein neues Medikament geben?",
      "options": [
        {
          "key": "a",
          "text": "Sind Sie gegen ein Medikament allergisch?"
        },
        {
          "key": "b",
          "text": "Wo wohnen Sie?"
        },
        {
          "key": "c",
          "text": "Was ist Ihr Beruf?"
        },
        {
          "key": "d",
          "text": "Mögen Sie die Farbe?"
        }
      ],
      "correct": "a"
    },
    {
      "id": "de5",
      "topic": "medication",
      "text": "Der Patient fragt: „Wie viele Tabletten nehme ich?“ Was antworten Sie?",
      "options": [
        {
          "key": "a",
          "text": "Nehmen Sie alle Tabletten jetzt."
        },
        {
          "key": "b",
          "text": "Nehmen Sie eine Tablette nach dem Frühstück."
        },
        {
          "key": "c",
          "text": "Nehmen Sie keine Tabletten mehr."
        },
        {
          "key": "d",
          "text": "Geben Sie die Tabletten jemand anderem."
        }
      ],
      "correct": "b"
    },
    {
      "id": "de6",
      "topic": "postcare",
      "text": "Nach dem Besuch, was sagen Sie dem Patienten über die Wunde?",
      "options": [
        {
          "key": "a",
          "text": "Waschen Sie sie mit schmutzigem Wasser."
        },
        {
          "key": "b",
          "text": "Berühren Sie sie oft mit den Händen."
        },
        {
          "key": "c",
          "text": "Halten Sie sie sauber und trocken, und rufen Sie uns, wenn sie schlimmer wird."
        },
        {
          "key": "d",
          "text": "Decken Sie sie mit einem nassen Tuch ab."
        }
      ],
      "correct": "c"
    },
    {
      "id": "de7",
      "topic": "emergency",
      "text": "Der Patient kann plötzlich nicht atmen. Was sagen Sie zuerst?",
      "options": [
        {
          "key": "a",
          "text": "Bitte warten Sie draußen."
        },
        {
          "key": "b",
          "text": "Trinken Sie Wasser und ruhen Sie sich aus."
        },
        {
          "key": "c",
          "text": "Kommen Sie morgen wieder."
        },
        {
          "key": "d",
          "text": "Bleiben Sie ruhig, ich rufe jetzt einen Krankenwagen."
        }
      ],
      "correct": "d"
    },
    {
      "id": "de8",
      "topic": "payment",
      "text": "Der Besuch kostet 300 Pfund. Wie bestätigen Sie die Zahlung?",
      "options": [
        {
          "key": "a",
          "text": "Der Besuch kostet 300 Pfund, bitte zahlen Sie jetzt."
        },
        {
          "key": "b",
          "text": "Bezahlen Sie später, vielleicht."
        },
        {
          "key": "c",
          "text": "Der Preis ist ein Geheimnis."
        },
        {
          "key": "d",
          "text": "Sie müssen nicht zahlen."
        }
      ],
      "correct": "a"
    },
    {
      "id": "de9",
      "topic": "greeting",
      "text": "Wie stellen Sie sich einem neuen Patienten vor?",
      "options": [
        {
          "key": "a",
          "text": "Ich mag keine neuen Patienten."
        },
        {
          "key": "b",
          "text": "Hallo, ich heiße Sara, ich bin Ihre Krankenschwester."
        },
        {
          "key": "c",
          "text": "Beeilen Sie sich, bitte."
        },
        {
          "key": "d",
          "text": "Ich gehe jetzt nach Hause."
        }
      ],
      "correct": "b"
    },
    {
      "id": "de10",
      "topic": "symptoms",
      "text": "Der Patient sagt: „Mir ist übel und ich muss mich übergeben.“ Was bedeutet das?",
      "options": [
        {
          "key": "a",
          "text": "Er hat einen gebrochenen Arm."
        },
        {
          "key": "b",
          "text": "Er hat großen Hunger."
        },
        {
          "key": "c",
          "text": "Ihm ist übel und er muss sich vielleicht übergeben."
        },
        {
          "key": "d",
          "text": "Er möchte spazieren gehen."
        }
      ],
      "correct": "c"
    },
    {
      "id": "de11",
      "topic": "procedure",
      "text": "Sie müssen eine Blutprobe nehmen. Was erklären Sie?",
      "options": [
        {
          "key": "a",
          "text": "Sie müssen zuerst schnell laufen."
        },
        {
          "key": "b",
          "text": "Essen Sie eine Woche lang nichts."
        },
        {
          "key": "c",
          "text": "Der Test ist nicht wichtig."
        },
        {
          "key": "d",
          "text": "Ich nehme eine kleine Blutprobe aus Ihrem Arm."
        }
      ],
      "correct": "d"
    },
    {
      "id": "de12",
      "topic": "medication",
      "text": "Der Patient sagt: „Ich habe mein Medikament am Morgen vergessen.“ Was sagen Sie ihm?",
      "options": [
        {
          "key": "a",
          "text": "Nehmen Sie es jetzt, und verdoppeln Sie die nächste Dosis nicht."
        },
        {
          "key": "b",
          "text": "Nehmen Sie drei Dosen auf einmal."
        },
        {
          "key": "c",
          "text": "Nehmen Sie es nie wieder."
        },
        {
          "key": "d",
          "text": "Geben Sie es Ihrem Freund."
        }
      ],
      "correct": "a"
    }
  ],
  "ru": [
    {
      "id": "ru1",
      "topic": "greeting",
      "text": "Пациент пришёл к двери. Что вы скажете сначала?",
      "options": [
        {
          "key": "a",
          "text": "Уходите."
        },
        {
          "key": "b",
          "text": "У меня нет времени."
        },
        {
          "key": "c",
          "text": "Доброе утро, пожалуйста, проходите."
        },
        {
          "key": "d",
          "text": "Зачем вы пришли?"
        }
      ],
      "correct": "c"
    },
    {
      "id": "ru2",
      "topic": "symptoms",
      "text": "Пациент говорит: «У меня сильно болит голова». Что это значит?",
      "options": [
        {
          "key": "a",
          "text": "У него болит живот."
        },
        {
          "key": "b",
          "text": "Он очень голоден."
        },
        {
          "key": "c",
          "text": "Он хочет спать."
        },
        {
          "key": "d",
          "text": "У него сильная головная боль."
        }
      ],
      "correct": "d"
    },
    {
      "id": "ru3",
      "topic": "procedure",
      "text": "Перед сменой повязки что вы скажете пациенту?",
      "options": [
        {
          "key": "a",
          "text": "Это может немного болеть, пожалуйста, лежите спокойно."
        },
        {
          "key": "b",
          "text": "Закройте глаза и спите."
        },
        {
          "key": "c",
          "text": "Сначала заплатите."
        },
        {
          "key": "d",
          "text": "Идите домой."
        }
      ],
      "correct": "a"
    },
    {
      "id": "ru4",
      "topic": "allergies",
      "text": "Что вы спросите, прежде чем дать новое лекарство?",
      "options": [
        {
          "key": "a",
          "text": "Где вы живёте?"
        },
        {
          "key": "b",
          "text": "Есть ли у вас аллергия на лекарства?"
        },
        {
          "key": "c",
          "text": "Какая у вас работа?"
        },
        {
          "key": "d",
          "text": "Вам нравится этот цвет?"
        }
      ],
      "correct": "b"
    },
    {
      "id": "ru5",
      "topic": "medication",
      "text": "Пациент спрашивает: «Сколько таблеток мне принимать?» Что вы ответите?",
      "options": [
        {
          "key": "a",
          "text": "Примите все таблетки сразу."
        },
        {
          "key": "b",
          "text": "Больше не принимайте их."
        },
        {
          "key": "c",
          "text": "Принимайте одну таблетку после завтрака."
        },
        {
          "key": "d",
          "text": "Отдайте таблетки другому человеку."
        }
      ],
      "correct": "c"
    },
    {
      "id": "ru6",
      "topic": "postcare",
      "text": "После визита что вы скажете пациенту о ране?",
      "options": [
        {
          "key": "a",
          "text": "Мойте её грязной водой."
        },
        {
          "key": "b",
          "text": "Трогайте её руками почаще."
        },
        {
          "key": "c",
          "text": "Накройте её мокрой тканью."
        },
        {
          "key": "d",
          "text": "Держите её чистой и сухой и позвоните нам, если станет хуже."
        }
      ],
      "correct": "d"
    },
    {
      "id": "ru7",
      "topic": "emergency",
      "text": "Пациент вдруг не может дышать. Что вы скажете сначала?",
      "options": [
        {
          "key": "a",
          "text": "Сохраняйте спокойствие, я сейчас вызываю скорую помощь."
        },
        {
          "key": "b",
          "text": "Подождите снаружи."
        },
        {
          "key": "c",
          "text": "Выпейте воды и отдохните."
        },
        {
          "key": "d",
          "text": "Приходите завтра."
        }
      ],
      "correct": "a"
    },
    {
      "id": "ru8",
      "topic": "payment",
      "text": "Визит стоит 300 фунтов. Как вы подтвердите оплату?",
      "options": [
        {
          "key": "a",
          "text": "Заплатите позже, может быть."
        },
        {
          "key": "b",
          "text": "Визит стоит 300 фунтов, пожалуйста, заплатите сейчас."
        },
        {
          "key": "c",
          "text": "Цена — это секрет."
        },
        {
          "key": "d",
          "text": "Вам не нужно платить."
        }
      ],
      "correct": "b"
    },
    {
      "id": "ru9",
      "topic": "greeting",
      "text": "Как вы представитесь новому пациенту?",
      "options": [
        {
          "key": "a",
          "text": "Я не люблю новых пациентов."
        },
        {
          "key": "b",
          "text": "Поторопитесь, пожалуйста."
        },
        {
          "key": "c",
          "text": "Здравствуйте, меня зовут Сара, я ваша медсестра."
        },
        {
          "key": "d",
          "text": "Я сейчас ухожу домой."
        }
      ],
      "correct": "c"
    },
    {
      "id": "ru10",
      "topic": "symptoms",
      "text": "Пациент говорит: «Меня тошнит». Что это значит?",
      "options": [
        {
          "key": "a",
          "text": "Он очень голоден."
        },
        {
          "key": "b",
          "text": "У него сломана рука."
        },
        {
          "key": "c",
          "text": "Он хочет гулять."
        },
        {
          "key": "d",
          "text": "Его тошнит, и его может вырвать."
        }
      ],
      "correct": "d"
    },
    {
      "id": "ru11",
      "topic": "procedure",
      "text": "Вам нужно взять анализ крови. Что вы объясните?",
      "options": [
        {
          "key": "a",
          "text": "Я возьму немного крови из вашей руки."
        },
        {
          "key": "b",
          "text": "Сначала быстро побегайте."
        },
        {
          "key": "c",
          "text": "Не ешьте целую неделю."
        },
        {
          "key": "d",
          "text": "Этот анализ не важен."
        }
      ],
      "correct": "a"
    },
    {
      "id": "ru12",
      "topic": "medication",
      "text": "Пациент говорит: «Я забыл принять утреннее лекарство». Что вы ему скажете?",
      "options": [
        {
          "key": "a",
          "text": "Примите три дозы сразу."
        },
        {
          "key": "b",
          "text": "Примите его сейчас и не удваивайте следующую дозу."
        },
        {
          "key": "c",
          "text": "Больше никогда его не принимайте."
        },
        {
          "key": "d",
          "text": "Отдайте его другу."
        }
      ],
      "correct": "b"
    }
  ],
  "pl": [
    {
      "id": "pl1",
      "topic": "greeting",
      "text": "Pacjent stoi w drzwiach. Co mówisz najpierw?",
      "options": [
        {
          "key": "a",
          "text": "Idź sobie."
        },
        {
          "key": "b",
          "text": "Nie mam czasu."
        },
        {
          "key": "c",
          "text": "Po co tu przyszedłeś?"
        },
        {
          "key": "d",
          "text": "Dzień dobry, proszę wejść."
        }
      ],
      "correct": "d"
    },
    {
      "id": "pl2",
      "topic": "symptoms",
      "text": "Pacjent mówi: „Bardzo boli mnie noga“. Co to znaczy?",
      "options": [
        {
          "key": "a",
          "text": "Bardzo boli go noga."
        },
        {
          "key": "b",
          "text": "Jest bardzo szczęśliwy."
        },
        {
          "key": "c",
          "text": "Jest bardzo głodny."
        },
        {
          "key": "d",
          "text": "Chce iść na spacer."
        }
      ],
      "correct": "a"
    },
    {
      "id": "pl3",
      "topic": "procedure",
      "text": "Zanim zmienisz opatrunek, co mówisz pacjentowi?",
      "options": [
        {
          "key": "a",
          "text": "Zamknij oczy i śpij."
        },
        {
          "key": "b",
          "text": "To może trochę boleć, proszę leżeć spokojnie."
        },
        {
          "key": "c",
          "text": "Zapłać najpierw."
        },
        {
          "key": "d",
          "text": "Idź do domu."
        }
      ],
      "correct": "b"
    },
    {
      "id": "pl4",
      "topic": "allergies",
      "text": "O co pytasz, zanim podasz nowy lek?",
      "options": [
        {
          "key": "a",
          "text": "Gdzie mieszkasz?"
        },
        {
          "key": "b",
          "text": "Jaki jest twój zawód?"
        },
        {
          "key": "c",
          "text": "Czy masz uczulenie na jakieś leki?"
        },
        {
          "key": "d",
          "text": "Czy podoba ci się ten kolor?"
        }
      ],
      "correct": "c"
    },
    {
      "id": "pl5",
      "topic": "medication",
      "text": "Pacjent pyta: „Ile tabletek mam brać?“ Co odpowiadasz?",
      "options": [
        {
          "key": "a",
          "text": "Weź wszystkie tabletki naraz."
        },
        {
          "key": "b",
          "text": "Nie bierz ich więcej."
        },
        {
          "key": "c",
          "text": "Daj tabletki komuś innemu."
        },
        {
          "key": "d",
          "text": "Bierz jedną tabletkę po śniadaniu."
        }
      ],
      "correct": "d"
    },
    {
      "id": "pl6",
      "topic": "postcare",
      "text": "Po wizycie, co mówisz pacjentowi o ranie?",
      "options": [
        {
          "key": "a",
          "text": "Trzymaj ją czystą i suchą, i zadzwoń do nas, jeśli będzie gorzej."
        },
        {
          "key": "b",
          "text": "Myj ją brudną wodą."
        },
        {
          "key": "c",
          "text": "Dotykaj jej często rękami."
        },
        {
          "key": "d",
          "text": "Przykryj ją mokrą szmatką."
        }
      ],
      "correct": "a"
    },
    {
      "id": "pl7",
      "topic": "emergency",
      "text": "Pacjent nagle nie może oddychać. Co mówisz najpierw?",
      "options": [
        {
          "key": "a",
          "text": "Proszę poczekać na zewnątrz."
        },
        {
          "key": "b",
          "text": "Zachowaj spokój, dzwonię teraz po karetkę."
        },
        {
          "key": "c",
          "text": "Napij się wody i odpocznij."
        },
        {
          "key": "d",
          "text": "Przyjdź jutro."
        }
      ],
      "correct": "b"
    },
    {
      "id": "pl8",
      "topic": "payment",
      "text": "Wizyta kosztuje 300 funtów. Jak potwierdzasz płatność?",
      "options": [
        {
          "key": "a",
          "text": "Zapłać później, może."
        },
        {
          "key": "b",
          "text": "Cena to tajemnica."
        },
        {
          "key": "c",
          "text": "Wizyta kosztuje 300 funtów, proszę zapłacić teraz."
        },
        {
          "key": "d",
          "text": "Nie musisz płacić."
        }
      ],
      "correct": "c"
    },
    {
      "id": "pl9",
      "topic": "greeting",
      "text": "Jak przedstawiasz się nowemu pacjentowi?",
      "options": [
        {
          "key": "a",
          "text": "Nie lubię nowych pacjentów."
        },
        {
          "key": "b",
          "text": "Pospiesz się, proszę."
        },
        {
          "key": "c",
          "text": "Idę teraz do domu."
        },
        {
          "key": "d",
          "text": "Dzień dobry, nazywam się Sara, jestem twoją pielęgniarką."
        }
      ],
      "correct": "d"
    },
    {
      "id": "pl10",
      "topic": "symptoms",
      "text": "Pacjent mówi: „Jest mi niedobrze i chce mi się wymiotować“. Co to znaczy?",
      "options": [
        {
          "key": "a",
          "text": "Jest mu niedobrze i może zwymiotować."
        },
        {
          "key": "b",
          "text": "Jest bardzo głodny."
        },
        {
          "key": "c",
          "text": "Ma złamaną rękę."
        },
        {
          "key": "d",
          "text": "Chce iść na spacer."
        }
      ],
      "correct": "a"
    },
    {
      "id": "pl11",
      "topic": "procedure",
      "text": "Musisz pobrać próbkę krwi. Co wyjaśniasz?",
      "options": [
        {
          "key": "a",
          "text": "Musisz najpierw szybko pobiegać."
        },
        {
          "key": "b",
          "text": "Pobiorę małą próbkę krwi z twojej ręki."
        },
        {
          "key": "c",
          "text": "Nie jedz przez tydzień."
        },
        {
          "key": "d",
          "text": "To badanie nie jest ważne."
        }
      ],
      "correct": "b"
    },
    {
      "id": "pl12",
      "topic": "medication",
      "text": "Pacjent mówi: „Zapomniałem porannego leku“. Co mu mówisz?",
      "options": [
        {
          "key": "a",
          "text": "Weź trzy dawki naraz."
        },
        {
          "key": "b",
          "text": "Nigdy więcej go nie bierz."
        },
        {
          "key": "c",
          "text": "Weź go teraz i nie podwajaj następnej dawki."
        },
        {
          "key": "d",
          "text": "Daj go przyjacielowi."
        }
      ],
      "correct": "c"
    }
  ],
  "nl": [
    {
      "id": "nl1",
      "topic": "greeting",
      "text": "Een patiënt staat aan de deur. Wat zegt u eerst?",
      "options": [
        {
          "key": "a",
          "text": "Goedemorgen, kom alstublieft binnen."
        },
        {
          "key": "b",
          "text": "Ga weg."
        },
        {
          "key": "c",
          "text": "Ik heb geen tijd."
        },
        {
          "key": "d",
          "text": "Waarom bent u hier?"
        }
      ],
      "correct": "a"
    },
    {
      "id": "nl2",
      "topic": "symptoms",
      "text": "De patiënt zegt: „Mijn buik doet erg pijn.“ Wat betekent dat?",
      "options": [
        {
          "key": "a",
          "text": "Hij heeft honger."
        },
        {
          "key": "b",
          "text": "Hij is erg moe."
        },
        {
          "key": "c",
          "text": "Hij heeft erge buikpijn."
        },
        {
          "key": "d",
          "text": "Hij is blij."
        }
      ],
      "correct": "c"
    },
    {
      "id": "nl3",
      "topic": "procedure",
      "text": "Voordat u een verband verwisselt, wat zegt u tegen de patiënt?",
      "options": [
        {
          "key": "a",
          "text": "Sluit uw ogen en slaap."
        },
        {
          "key": "b",
          "text": "Dit kan een beetje pijn doen, blijf alstublieft stil liggen."
        },
        {
          "key": "c",
          "text": "Betaal eerst."
        },
        {
          "key": "d",
          "text": "Ga naar huis."
        }
      ],
      "correct": "b"
    },
    {
      "id": "nl4",
      "topic": "allergies",
      "text": "Wat vraagt u voordat u een nieuw medicijn geeft?",
      "options": [
        {
          "key": "a",
          "text": "Waar woont u?"
        },
        {
          "key": "b",
          "text": "Wat is uw beroep?"
        },
        {
          "key": "c",
          "text": "Vindt u deze kleur mooi?"
        },
        {
          "key": "d",
          "text": "Bent u allergisch voor een medicijn?"
        }
      ],
      "correct": "d"
    },
    {
      "id": "nl5",
      "topic": "medication",
      "text": "De patiënt vraagt: „Hoeveel tabletten moet ik nemen?“ Wat antwoordt u?",
      "options": [
        {
          "key": "a",
          "text": "Neem één tablet na het ontbijt."
        },
        {
          "key": "b",
          "text": "Neem alle tabletten nu."
        },
        {
          "key": "c",
          "text": "Stop ermee vandaag."
        },
        {
          "key": "d",
          "text": "Geef de tabletten aan iemand anders."
        }
      ],
      "correct": "a"
    },
    {
      "id": "nl6",
      "topic": "postcare",
      "text": "Na het bezoek, wat zegt u tegen de patiënt over de wond?",
      "options": [
        {
          "key": "a",
          "text": "Was de wond met vuil water."
        },
        {
          "key": "b",
          "text": "Raak de wond vaak aan met uw handen."
        },
        {
          "key": "c",
          "text": "Houd de wond schoon en droog, en bel ons als het erger wordt."
        },
        {
          "key": "d",
          "text": "Bedek de wond met een natte doek."
        }
      ],
      "correct": "c"
    },
    {
      "id": "nl7",
      "topic": "emergency",
      "text": "De patiënt kan plotseling niet ademen. Wat zegt u eerst?",
      "options": [
        {
          "key": "a",
          "text": "Wacht alstublieft buiten."
        },
        {
          "key": "b",
          "text": "Blijf kalm, ik bel nu een ambulance."
        },
        {
          "key": "c",
          "text": "Drink wat water en rust uit."
        },
        {
          "key": "d",
          "text": "Kom morgen terug."
        }
      ],
      "correct": "b"
    },
    {
      "id": "nl8",
      "topic": "payment",
      "text": "Het bezoek kost 300 pond. Hoe bevestigt u de betaling?",
      "options": [
        {
          "key": "a",
          "text": "Betaal later, misschien."
        },
        {
          "key": "b",
          "text": "De prijs is geheim."
        },
        {
          "key": "c",
          "text": "U hoeft niet te betalen."
        },
        {
          "key": "d",
          "text": "Het bezoek kost 300 pond, betaal alstublieft nu."
        }
      ],
      "correct": "d"
    },
    {
      "id": "nl9",
      "topic": "greeting",
      "text": "Hoe stelt u zich voor aan een nieuwe patiënt?",
      "options": [
        {
          "key": "a",
          "text": "Hallo, mijn naam is Sara, ik ben uw verpleegkundige."
        },
        {
          "key": "b",
          "text": "Ik houd niet van nieuwe patiënten."
        },
        {
          "key": "c",
          "text": "Schiet alstublieft op."
        },
        {
          "key": "d",
          "text": "Ik ga nu naar huis."
        }
      ],
      "correct": "a"
    },
    {
      "id": "nl10",
      "topic": "symptoms",
      "text": "De patiënt zegt: „Ik voel me misselijk en ik moet overgeven.“ Wat betekent dat?",
      "options": [
        {
          "key": "a",
          "text": "Hij heeft een gebroken arm."
        },
        {
          "key": "b",
          "text": "Hij heeft erg veel honger."
        },
        {
          "key": "c",
          "text": "Hij voelt zich misselijk en moet misschien overgeven."
        },
        {
          "key": "d",
          "text": "Hij wil een wandeling maken."
        }
      ],
      "correct": "c"
    },
    {
      "id": "nl11",
      "topic": "procedure",
      "text": "U moet een bloedmonster nemen. Wat legt u uit?",
      "options": [
        {
          "key": "a",
          "text": "U moet eerst hard rennen."
        },
        {
          "key": "b",
          "text": "Ik neem een klein bloedmonster uit uw arm."
        },
        {
          "key": "c",
          "text": "Eet een week lang niets."
        },
        {
          "key": "d",
          "text": "De test is niet belangrijk."
        }
      ],
      "correct": "b"
    },
    {
      "id": "nl12",
      "topic": "medication",
      "text": "De patiënt zegt: „Ik ben mijn ochtendmedicijn vergeten.“ Wat zegt u tegen hem?",
      "options": [
        {
          "key": "a",
          "text": "Neem drie doses tegelijk."
        },
        {
          "key": "b",
          "text": "Neem het nooit meer."
        },
        {
          "key": "c",
          "text": "Geef het aan uw vriend."
        },
        {
          "key": "d",
          "text": "Neem het nu, en verdubbel de volgende dosis niet."
        }
      ],
      "correct": "d"
    }
  ],
  "zh": [
    {
      "id": "zh1",
      "topic": "greeting",
      "text": "病人到了门口，你先说什么？",
      "options": [
        {
          "key": "a",
          "text": "走开。"
        },
        {
          "key": "b",
          "text": "早上好，请进来。"
        },
        {
          "key": "c",
          "text": "我今天很忙。"
        },
        {
          "key": "d",
          "text": "你为什么来这里？"
        }
      ],
      "correct": "b"
    },
    {
      "id": "zh2",
      "topic": "symptoms",
      "text": "病人说：“我的肚子很疼。”这是什么意思？",
      "options": [
        {
          "key": "a",
          "text": "他很饿。"
        },
        {
          "key": "b",
          "text": "他很累。"
        },
        {
          "key": "c",
          "text": "他很高兴。"
        },
        {
          "key": "d",
          "text": "他的肚子很疼。"
        }
      ],
      "correct": "d"
    },
    {
      "id": "zh3",
      "topic": "procedure",
      "text": "换药之前，你对病人说什么？",
      "options": [
        {
          "key": "a",
          "text": "可能会有一点疼，请不要动。"
        },
        {
          "key": "b",
          "text": "闭上眼睛睡觉。"
        },
        {
          "key": "c",
          "text": "请先付钱。"
        },
        {
          "key": "d",
          "text": "现在回家吧。"
        }
      ],
      "correct": "a"
    },
    {
      "id": "zh4",
      "topic": "allergies",
      "text": "给新药之前，你应该问什么？",
      "options": [
        {
          "key": "a",
          "text": "你住在哪里？"
        },
        {
          "key": "b",
          "text": "你的工作是什么？"
        },
        {
          "key": "c",
          "text": "你对什么药过敏吗？"
        },
        {
          "key": "d",
          "text": "你喜欢这个颜色吗？"
        }
      ],
      "correct": "c"
    },
    {
      "id": "zh5",
      "topic": "medication",
      "text": "病人问：“我应该吃几片药？”你怎么回答？",
      "options": [
        {
          "key": "a",
          "text": "现在把所有的药都吃掉。"
        },
        {
          "key": "b",
          "text": "早饭后吃一片药。"
        },
        {
          "key": "c",
          "text": "今天不要吃药。"
        },
        {
          "key": "d",
          "text": "把药给别人。"
        }
      ],
      "correct": "b"
    },
    {
      "id": "zh6",
      "topic": "postcare",
      "text": "看完病人以后，你对伤口说什么？",
      "options": [
        {
          "key": "a",
          "text": "用脏水洗伤口。"
        },
        {
          "key": "b",
          "text": "经常用手摸伤口。"
        },
        {
          "key": "c",
          "text": "用湿布盖住伤口。"
        },
        {
          "key": "d",
          "text": "保持伤口干净干燥，如果变严重请打电话给我们。"
        }
      ],
      "correct": "d"
    },
    {
      "id": "zh7",
      "topic": "emergency",
      "text": "病人突然不能呼吸了，你先说什么？",
      "options": [
        {
          "key": "a",
          "text": "请不要着急，我现在叫救护车。"
        },
        {
          "key": "b",
          "text": "请在外面等。"
        },
        {
          "key": "c",
          "text": "喝点水，休息一下。"
        },
        {
          "key": "d",
          "text": "明天再来。"
        }
      ],
      "correct": "a"
    },
    {
      "id": "zh8",
      "topic": "payment",
      "text": "这次看病要300镑，你怎么确认付款？",
      "options": [
        {
          "key": "a",
          "text": "以后再付吧。"
        },
        {
          "key": "b",
          "text": "价格是秘密。"
        },
        {
          "key": "c",
          "text": "这次看病是300镑，请现在付款。"
        },
        {
          "key": "d",
          "text": "你不用付钱。"
        }
      ],
      "correct": "c"
    },
    {
      "id": "zh9",
      "topic": "greeting",
      "text": "你怎么向新病人介绍自己？",
      "options": [
        {
          "key": "a",
          "text": "我不喜欢新病人。"
        },
        {
          "key": "b",
          "text": "你好，我叫莎拉，我是你的护士。"
        },
        {
          "key": "c",
          "text": "请快一点。"
        },
        {
          "key": "d",
          "text": "我现在要回家了。"
        }
      ],
      "correct": "b"
    },
    {
      "id": "zh10",
      "topic": "symptoms",
      "text": "病人说：“我想吐。”这是什么意思？",
      "options": [
        {
          "key": "a",
          "text": "他很饿。"
        },
        {
          "key": "b",
          "text": "他的手臂断了。"
        },
        {
          "key": "c",
          "text": "他想去散步。"
        },
        {
          "key": "d",
          "text": "他觉得恶心，可能会吐。"
        }
      ],
      "correct": "d"
    },
    {
      "id": "zh11",
      "topic": "procedure",
      "text": "你需要抽血，你怎么解释？",
      "options": [
        {
          "key": "a",
          "text": "我会从你的手臂抽一点血。"
        },
        {
          "key": "b",
          "text": "你先快跑一下。"
        },
        {
          "key": "c",
          "text": "一个星期不要吃东西。"
        },
        {
          "key": "d",
          "text": "这个检查不重要。"
        }
      ],
      "correct": "a"
    },
    {
      "id": "zh12",
      "topic": "medication",
      "text": "病人说：“我忘了吃早上的药。”你对他说什么？",
      "options": [
        {
          "key": "a",
          "text": "一次吃三份药。"
        },
        {
          "key": "b",
          "text": "以后再也不要吃。"
        },
        {
          "key": "c",
          "text": "现在吃药，下一次不要吃双倍。"
        },
        {
          "key": "d",
          "text": "把药给你的朋友。"
        }
      ],
      "correct": "c"
    }
  ],
  "cs": [
    {
      "id": "cs1",
      "topic": "greeting",
      "text": "Pacient stojí u dveří. Co řeknete nejdřív?",
      "options": [
        {
          "key": "a",
          "text": "Jděte pryč."
        },
        {
          "key": "b",
          "text": "Nemám čas."
        },
        {
          "key": "c",
          "text": "Dobré ráno, prosím, pojďte dál."
        },
        {
          "key": "d",
          "text": "Proč jste tady?"
        }
      ],
      "correct": "c"
    },
    {
      "id": "cs2",
      "topic": "symptoms",
      "text": "Pacient říká: „Hodně mě bolí břicho.“ Co to znamená?",
      "options": [
        {
          "key": "a",
          "text": "Hodně ho bolí břicho."
        },
        {
          "key": "b",
          "text": "Má hlad."
        },
        {
          "key": "c",
          "text": "Je velmi unavený."
        },
        {
          "key": "d",
          "text": "Těší se."
        }
      ],
      "correct": "a"
    },
    {
      "id": "cs3",
      "topic": "procedure",
      "text": "Než vyměníte obvaz, co řeknete pacientovi?",
      "options": [
        {
          "key": "a",
          "text": "Zavřete oči a spěte."
        },
        {
          "key": "b",
          "text": "Zaplaťte nejdřív."
        },
        {
          "key": "c",
          "text": "Jděte domů."
        },
        {
          "key": "d",
          "text": "Může to trochu bolet, prosím, ležte klidně."
        }
      ],
      "correct": "d"
    },
    {
      "id": "cs4",
      "topic": "allergies",
      "text": "Na co se zeptáte, než dáte nový lék?",
      "options": [
        {
          "key": "a",
          "text": "Kde bydlíte?"
        },
        {
          "key": "b",
          "text": "Máte alergii na nějaký lék?"
        },
        {
          "key": "c",
          "text": "Jaké je vaše povolání?"
        },
        {
          "key": "d",
          "text": "Líbí se vám tato barva?"
        }
      ],
      "correct": "b"
    },
    {
      "id": "cs5",
      "topic": "medication",
      "text": "Pacient se ptá: „Kolik tablet mám brát?“ Co odpovíte?",
      "options": [
        {
          "key": "a",
          "text": "Vezměte všechny tablety najednou."
        },
        {
          "key": "b",
          "text": "Už je neberte."
        },
        {
          "key": "c",
          "text": "Vezměte jednu tabletu po snídani."
        },
        {
          "key": "d",
          "text": "Dejte tablety někomu jinému."
        }
      ],
      "correct": "c"
    },
    {
      "id": "cs6",
      "topic": "postcare",
      "text": "Po návštěvě, co řeknete pacientovi o ráně?",
      "options": [
        {
          "key": "a",
          "text": "Udržujte ji čistou a suchou a zavolejte nám, když se zhorší."
        },
        {
          "key": "b",
          "text": "Myjte ji špinavou vodou."
        },
        {
          "key": "c",
          "text": "Často se jí dotýkejte rukama."
        },
        {
          "key": "d",
          "text": "Přikryjte ji mokrým hadrem."
        }
      ],
      "correct": "a"
    },
    {
      "id": "cs7",
      "topic": "emergency",
      "text": "Pacient najednou nemůže dýchat. Co řeknete nejdřív?",
      "options": [
        {
          "key": "a",
          "text": "Počkejte prosím venku."
        },
        {
          "key": "b",
          "text": "Napijte se vody a odpočiňte si."
        },
        {
          "key": "c",
          "text": "Přijďte zítra."
        },
        {
          "key": "d",
          "text": "Zůstaňte klidný, teď volám záchranku."
        }
      ],
      "correct": "d"
    },
    {
      "id": "cs8",
      "topic": "procedure",
      "text": "Musíte odebrat vzorek krve. Co vysvětlíte?",
      "options": [
        {
          "key": "a",
          "text": "Musíte nejdřív rychle běžet."
        },
        {
          "key": "b",
          "text": "Odeberu malý vzorek krve z vaší paže."
        },
        {
          "key": "c",
          "text": "Nejezte celý týden."
        },
        {
          "key": "d",
          "text": "Test není důležitý."
        }
      ],
      "correct": "b"
    },
    {
      "id": "cs9",
      "topic": "greeting",
      "text": "Jak se představíte novému pacientovi?",
      "options": [
        {
          "key": "a",
          "text": "Nemám rád nové pacienty."
        },
        {
          "key": "b",
          "text": "Pospěšte si, prosím."
        },
        {
          "key": "c",
          "text": "Dobrý den, jmenuji se Sara, jsem vaše sestra."
        },
        {
          "key": "d",
          "text": "Teď jdu domů."
        }
      ],
      "correct": "c"
    },
    {
      "id": "cs10",
      "topic": "symptoms",
      "text": "Pacient říká: „Je mi špatně a chci zvracet.“ Co to znamená?",
      "options": [
        {
          "key": "a",
          "text": "Je mu špatně a možná bude zvracet."
        },
        {
          "key": "b",
          "text": "Má velký hlad."
        },
        {
          "key": "c",
          "text": "Má zlomenou ruku."
        },
        {
          "key": "d",
          "text": "Chce jít na procházku."
        }
      ],
      "correct": "a"
    },
    {
      "id": "cs11",
      "topic": "payment",
      "text": "Návštěva stojí 300 liber. Jak potvrdíte platbu?",
      "options": [
        {
          "key": "a",
          "text": "Zaplaťte později, možná."
        },
        {
          "key": "b",
          "text": "Cena je tajemství."
        },
        {
          "key": "c",
          "text": "Nemusíte platit."
        },
        {
          "key": "d",
          "text": "Návštěva stojí 300 liber, prosím, zaplaťte teď."
        }
      ],
      "correct": "d"
    },
    {
      "id": "cs12",
      "topic": "medication",
      "text": "Pacient říká: „Zapomněl jsem ranní lék.“ Co mu řeknete?",
      "options": [
        {
          "key": "a",
          "text": "Vezměte tři dávky najednou."
        },
        {
          "key": "b",
          "text": "Vezměte ho teď a další dávku nezdvojujte."
        },
        {
          "key": "c",
          "text": "Už ho nikdy neberte."
        },
        {
          "key": "d",
          "text": "Dejte ho kamarádovi."
        }
      ],
      "correct": "b"
    }
  ]
};

// Emergency triage danger signs — ANY one rejects a home-visit booking.
const DANGER_SIGNS = [
  'chest_pain', 'breathlessness', 'unconscious', 'severe_bleeding',
  'stroke_signs', 'seizure', 'severe_allergy', 'suicide_risk',
];

module.exports = {
  SERVICES, TOURIST_SERVICES, TOURIST_URGENT_EXTRA, EXTRA_LANGUAGE_BONUS,
  TIERS, VOLUME_BONUS_TIERS, VOUCHER_AMOUNT_EGP, VOUCHER_MIN_BOOKING_EGP,
  VOUCHER_VALID_DAYS, VOUCHER_EVERY_N_VISITS,
  HIGH_RISK_SERVICES, HIGH_RISK_CHECKLIST, HIGH_RISK_CHECKLIST_LABELS, isHighRiskService,
  MIN_SERVICE_PRICE_EGP, NURSE_ONLY_SERVICES, isNurseOnlyService,
  VOLUME_BONUS_TIERS, WEEKLY_DOUBLE_THRESHOLD, STAY_BONUS_EGP, STAY_BONUS_DAYS, STAY_BONUS_MIN_CASES, POINTS,
  INTERVIEW_DIMENSIONS, INTERVIEW_COMMON, INTERVIEW_ROLE_QUESTIONS,
  HOTELS, MCQ, ENGLISH_CHECK, DANGER_SIGNS,
  TERMS_VERSION, TERMS_UPDATED_AT, TERMS_AR, TERMS_EN,
  DEFAULT_LANGUAGES, LANGUAGE_TESTS, LANGUAGE_TEST_QUESTIONS, LANGUAGE_TEST_PASS_MIN,
  LANGUAGE_TEST_MINUTES, LANGUAGE_TEST_RETAKE_DAYS, LANGUAGE_TEST_TOPICS,
  MONTHLY_PACKAGES, TOURIST_PACKAGES, PACKAGE_LEVELS, PACKAGE_DAYS, PACKAGE_OFF_DAYS, PACKAGE_OVERTIME_PREMIUM_PCT,
  LAUNCH_OFFER_REFERENCE,
  packageExtraDaysPrice, packageExtraDailyRate, packageDailyRateIn, packagePriceIn, PACKAGE_CONDITIONS, PACKAGE_NEEDS,
  distanceFee, servicePriceEgp,
};
