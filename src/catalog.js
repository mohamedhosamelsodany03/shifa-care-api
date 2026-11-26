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
  // v2.1.0 — HIGH risk (owner correction 26 Nov 2026): cannula+IV fluids
  // joins the high-risk tier — doctor's order required, verified nurse
  // only, safety checklist before completion. (Plain cannula stays
  // standard risk.)
  cannula_iv: { code: 'cannula_iv', category: 'nursing', name_en: 'Cannula + IV fluids', name_ar: 'كانيولا + محاليل', price_egp: 350, riskLevel: 'high' },
  shift12: { code: 'shift12', category: 'nursing', name_en: '12-hour shift', name_ar: 'شيفت 12 ساعة', price_egp: 500 },
  shift24: { code: 'shift24', category: 'nursing', name_en: '24-hour shift', name_ar: 'شيفت 24 ساعة', price_egp: 850 },
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
  blood_draw: { code: 'blood_draw', category: 'nursing', name_en: 'Blood draw (phlebotomy)', name_ar: 'سحب عينة دم', price_egp: 200, riskLevel: 'standard' },
  injection: { code: 'injection', category: 'nursing', name_en: 'IM / IV injection', name_ar: 'حقن عضلي / وريدي', price_egp: 150, riskLevel: 'standard' },
  vitals_check: { code: 'vitals_check', category: 'nursing', name_en: 'Vital signs check', name_ar: 'قياس العلامات الحيوية', price_egp: 150, riskLevel: 'standard' },
  stoma_care: { code: 'stoma_care', category: 'nursing', name_en: 'Stoma care', name_ar: 'العناية بفتحة الإخراج (ستوما)', price_egp: 300, riskLevel: 'standard' },
  // --- v2.1.0 — owner additions 26 Nov 2026 (APPROVED, FINAL) -----------
  // CVP central-line dressing: HIGH risk, same gates as the rest of the
  // tier (doctor's order, verified nurse only, safety checklist).
  cvp_dressing: { code: 'cvp_dressing', category: 'nursing', name_en: 'CVP central-line dressing', name_ar: 'غيار قسطرة CVP (قسطرة وريدية مركزية)', price_egp: 300, riskLevel: 'high', requiresDoctorOrder: true },
  // Elderly care, 12-hour shift — its OWN service (the generic 12h shift
  // at 500 stays as-is). TWO condition-based prices, both owner-set
  // MINIMUMS ("لا يقل عن"): mobile patient 400, bedridden patient 500.
  // The patient picks the condition at booking (two catalog entries).
  elderly_shift_mobile: { code: 'elderly_shift_mobile', category: 'nursing', name_en: 'Elderly care — 12h shift (mobile patient)', name_ar: 'رعاية مسنين — شيفت 12 ساعة (حالة متحركة)', price_egp: 400, riskLevel: 'standard' },
  elderly_shift_bedridden: { code: 'elderly_shift_bedridden', category: 'nursing', name_en: 'Elderly care — 12h shift (bedridden patient)', name_ar: 'رعاية مسنين — شيفت 12 ساعة (حالة قعيدة / طريحة فراش)', price_egp: 500, riskLevel: 'standard' },
  // --- v2.1.1 — new nursing services (owner-approved 26 Nov 2026) -----
  enema: { code: 'enema', category: 'nursing', name_en: 'Enema', name_ar: 'حقنة شرجية', price_egp: 500, riskLevel: 'standard' },
  allergy_test: { code: 'allergy_test', category: 'nursing', name_en: 'Allergy test', name_ar: 'اختبار حساسية', price_egp: 250, riskLevel: 'standard' },
  // Iron IV infusion: HIGH risk (owner decision 26 Nov 2026) — doctor's
  // order required, verified nurse only, safety checklist.
  iron_infusion: { code: 'iron_infusion', category: 'nursing', name_en: 'Iron IV infusion', name_ar: 'حديد وريدي', price_egp: 400, riskLevel: 'high', requiresDoctorOrder: true },
  condom_catheter: { code: 'condom_catheter', category: 'nursing', name_en: 'Condom (external) catheter', name_ar: 'قسطرة خارجية (كوندوم)', price_egp: 300, riskLevel: 'standard' },
  culture_sample: { code: 'culture_sample', category: 'nursing', name_en: 'Culture sample', name_ar: 'عينة مزرعة', price_egp: 400, riskLevel: 'standard' },
  urine_catheter_sample: { code: 'urine_catheter_sample', category: 'nursing', name_en: 'Urine sample from catheter', name_ar: 'عينة بول من قسطرة', price_egp: 350, riskLevel: 'standard' },
  // --- v2.1.1 — physiotherapy services (owner-approved 26 Nov 2026) -----
  // Minimum 350 EGP for any physiotherapy-specialist service. Physio
  // services are visible ONLY to providerType 'physio' on the radar.
  physio_general: { code: 'physio_general', category: 'physio', name_en: 'General mobility rehabilitation', name_ar: 'تأهيل حركي عام', price_egp: 350, riskLevel: 'standard' },
  physio_stroke: { code: 'physio_stroke', category: 'physio', name_en: 'Post-stroke rehabilitation', name_ar: 'تأهيل ما بعد الجلطة', price_egp: 400, riskLevel: 'standard' },
  physio_postfracture: { code: 'physio_postfracture', category: 'physio', name_en: 'Post-fracture / post-surgery exercises', name_ar: 'تمارين ما بعد الكسور / العمليات', price_egp: 350, riskLevel: 'standard' },
  physio_chest: { code: 'physio_chest', category: 'physio', name_en: 'Chest physiotherapy', name_ar: 'علاج طبيعي للصدر', price_egp: 350, riskLevel: 'standard' },
  physio_balance: { code: 'physio_balance', category: 'physio', name_en: 'Balance & walking exercises', name_ar: 'تمارين توازن ومشي', price_egp: 350, riskLevel: 'standard' },
  physio_massage: { code: 'physio_massage', category: 'physio', name_en: 'Therapeutic massage', name_ar: 'تدليك علاجي', price_egp: 350, riskLevel: 'standard' },
  physio_stretching: { code: 'physio_stretching', category: 'physio', name_en: 'Stretching exercises', name_ar: 'تمارين شد وإطالة', price_egp: 350, riskLevel: 'standard' },
  physio_elderly: { code: 'physio_elderly', category: 'physio', name_en: 'Elderly rehabilitation', name_ar: 'تأهيل كبار السن', price_egp: 350, riskLevel: 'standard' },
  // NOTE (superseded v2.1.1): physiotherapy services were proposed 26 Nov
  // 2026 and APPROVED the same day — they are live above (physio_*).
};

// High-risk services (owner refinement + correction 26 Nov 2026;
// PRICES APPROVED 26 Nov 2026 — FINAL): ALL catheter handling
// (insertion 400, removal 300, flush 300), Ryle (NG) tube insertion
// 400, drain removal 300, tracheostomy care 400, IV
// antibiotic/infusion therapy 400, NPWT dressing 600, cannula+IV fluids
// 350, CVP central-line dressing 300 (owner-set 26 Nov 2026). 'npwt' is
// not a SERVICES entry (it has its own booking endpoint) but is high-risk too.
// Rules (enforced server-side in routes.js): doctor's order REQUIRED to
// book; only verified nurses (or doctors) may accept — nursing
// assistants cannot; the provider must complete the safety checklist
// (HIGH_RISK_CHECKLIST) before finishing the visit. The owner stresses
// these need professionalism — the gates are server-side, and the app
// must show the requirements clearly to the patient at booking time.
const HIGH_RISK_SERVICES = ['catheter_insert', 'catheter_remove', 'catheter_flush', 'ryle_insert', 'drain_removal', 'npwt', 'trach_care', 'iv_infusion', 'cannula_iv', 'cvp_dressing', 'iron_infusion'];
function isHighRiskService(serviceCode) {
  if (!serviceCode) return false;
  if (HIGH_RISK_SERVICES.includes(serviceCode)) return true;
  return (SERVICES[serviceCode] && SERVICES[serviceCode].riskLevel === 'high') || false;
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
  return s.price_egp;
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
// FIXED set of 30 common questions (medical 6 / ethics 6 / safety 5 /
// communication 5 / resilience 4 / conduct 4) + 6 role-specific
// questions per role (assistant / nurse / doctor / physio): 2 medical +
// 1 ethics + 1 safety + 1 communication + 1 resilience each = 36 per
// attempt. Dimension totals: medical 8 / ethics 7 / safety 6 /
// communication 6 / resilience 5 / conduct 4. 10 of the 36 are
// RED-FLAG questions (redFlagOption): choosing the dangerous option
// fails the attempt instantly, whatever the score. `correct` and
// `redFlagOption` are NEVER sent to the client.
// NOTE: the 90-question rotating bank is Phase 2 — this is the fixed
// 36-question design from INTERVIEW-EXPANDED-PROPOSAL.md.
const INTERVIEW_DIMENSIONS = [
  { key: 'medical', nameAr: 'الكفاءة الطبية', nameEn: 'Medical competence', questions: 8, min: 5 },
  { key: 'ethics', nameAr: 'الأخلاقيات والاحترافية', nameEn: 'Ethics & professionalism', questions: 7, min: 5 },
  { key: 'safety', nameAr: 'السلامة والحكم العملي', nameEn: 'Safety & judgement', questions: 6, min: 4 },
  { key: 'communication', nameAr: 'التواصل', nameEn: 'Communication', questions: 6, min: null },
  { key: 'resilience', nameAr: 'الصلابة النفسية', nameEn: 'Resilience', questions: 5, min: null },
  { key: 'conduct', nameAr: 'الالتزام والسلوك المهني', nameEn: 'Conduct', questions: 4, min: null },
];
const INTERVIEW_COMMON = [{"id": "m1", "category": "medical", "text": "مريض فاقد للوعي ولا يتنفس بشكل طبيعي في بيته. ماذا تفعل أولًا؟", "options": [{"key": "a", "text": "أبدأ علاجه في البيت وأنتظر حتى يتحسن وحده."}, {"key": "b", "text": "أتصل بالإسعاف 123 فورًا، وأبدأ الإنعاش القلبي الرئوي إن كنت مدرّبًا عليه، وأبقيه في وضع آمن."}, {"key": "c", "text": "أعطيه ماءً وسكرًا وأتركه نائمًا."}, {"key": "d", "text": "أتصل بأسرته فقط وأنتظر وصولهم."}], "correct": "b", "redFlagOption": "a"}, {"id": "m2", "category": "medical", "text": "تقيس الضغط لمريض فتجد 180/110 والنبض 120. ماذا تفعل؟", "options": [{"key": "a", "text": "تسجلها فقط وتغادر."}, {"key": "b", "text": "تعيد القياس للتأكد، وتسأل عن الأعراض، وتبلغ الطبيب أو الإدارة فورًا حسب البروتوكول."}, {"key": "c", "text": "تعطي دواء ضغط من عندك."}, {"key": "d", "text": "تطمئن المريض بأن كل شيء طبيعي."}], "correct": "b"}, {"id": "m3", "category": "medical", "text": "أثناء محلول وريدي ظهر طفح جلدي وضيق نفس على المريض. ماذا تفعل؟", "options": [{"key": "a", "text": "تكمل الدواء حتى ينتهي المحلول."}, {"key": "b", "text": "توقف الدواء فورًا، وتقيّم مجرى الهواء والتنفس، وتطلب إسعافًا أو طبيبًا فورًا، وتوثق الحدث."}, {"key": "c", "text": "تعطي دواءً آخر من عندك لتهدئة الطفح."}, {"key": "d", "text": "تطلب من المريض الانتظار حتى يتحسن وحده."}], "correct": "b", "redFlagOption": "a"}, {"id": "m4", "category": "medical", "text": "ما أول إجراء عند نزيف خارجي شديد من جرح؟", "options": [{"key": "a", "text": "تنظيف الجرح أولًا."}, {"key": "b", "text": "الضغط المباشر على الجرح لوقف النزيف، وطلب المساعدة الطبية."}, {"key": "c", "text": "رفع المريض واقفًا."}, {"key": "d", "text": "وضع الثلج فقط."}], "correct": "b"}, {"id": "m5", "category": "medical", "text": "مريض سكري لديه جرح قدم، وتلاحظ رائحة كريهة وإفرازات. ما التصرف الصحيح؟", "options": [{"key": "a", "text": "تغطي الجرح فقط وتغادر."}, {"key": "b", "text": "تقيّم الجرح، وتوثق العلامات، وتبلغ الطبيب أو الإدارة فورًا، وتتبع بروتوكول الغيار المعتمد."}, {"key": "c", "text": "تضع مرهمًا من عندك دون توثيق."}, {"key": "d", "text": "تطلب من المريض الانتظار أسبوعًا."}], "correct": "b"}, {"id": "m6", "category": "medical", "text": "مريض يطلب منك تشخيص طفح جلدي لديه ووصف مضاد حيوي له. ماذا تفعل؟", "options": [{"key": "a", "text": "تشخّص الطفح وتصف له المضاد الحيوي بنفسك."}, {"key": "b", "text": "توضح له أن التشخيص ووصف الدواء خارج نطاق دورك، وتوثق ملاحظاتك وتحيله للطبيب أو الإدارة."}, {"key": "c", "text": "تعطيه أي دواء متوفر معك."}, {"key": "d", "text": "تتجاهل طلبه تمامًا دون شرح."}], "correct": "b", "redFlagOption": "a"}, {"id": "e1", "category": "ethics", "text": "بعد الزيارة، أسرة المريض تطلب منك صورة الجرح \"لترسلها لأقاربهم على واتساب\". ماذا تفعل؟", "options": [{"key": "a", "text": "ترسل الصورة لهم فورًا."}, {"key": "b", "text": "ترفض بأدب: صور المرضى سرية ولا تُرسَل إلا عبر تقرير التطبيق الرسمي وبموافقة المريض."}, {"key": "c", "text": "تنشر الصورة في مجموعة العمل أولًا."}, {"key": "d", "text": "ترسلها من هاتفك الشخصي دون توثيق."}], "correct": "b", "redFlagOption": "a"}, {"id": "e2", "category": "ethics", "text": "مريض يعرض عليك مالًا نقديًا \"خارج التطبيق\" مقابل أن تأتيه مباشرة دون حجز. ماذا تفعل؟", "options": [{"key": "a", "text": "تقبل المال وتذهب إليه مباشرة."}, {"key": "b", "text": "ترفض وتوضح أن كل الحجز والدفع عبر التطبيق لحماية الطرفين."}, {"key": "c", "text": "تقبل المال ولا تخبر أحدًا."}, {"key": "d", "text": "تطلب مبلغًا أكبر مقابل الزيارة."}], "correct": "b", "redFlagOption": "a"}, {"id": "e3", "category": "ethics", "text": "زميل يطلب منك توقيع تقرير زيارة لم تحضرها، أو تسجيل علامات حيوية لم تقسها. ماذا تفعل؟", "options": [{"key": "a", "text": "توقع، لأنها مجاملة بسيطة."}, {"key": "b", "text": "ترفض؛ التوقيع على ما لم تفعله أو تسجيل قياسات لم تقسها تزوير."}, {"key": "c", "text": "توقع وتكتب ملاحظة صغيرة."}, {"key": "d", "text": "تطلب منه مالًا مقابل التوقيع."}], "correct": "b", "redFlagOption": "a"}, {"id": "e4", "category": "ethics", "text": "مريض يطلب منك أن تخبر أسرته بتشخيصه دون علمه. ماذا تفعل؟", "options": [{"key": "a", "text": "تخبر الأسرة فورًا لأنهم يدفعون."}, {"key": "b", "text": "ترفض وتشرح للمريض حقه في الخصوصية، وتطلب موافقته أولًا."}, {"key": "c", "text": "تخبر الأسرة جزئيًا فقط."}, {"key": "d", "text": "تتجاهل الطلب ولا ترد."}], "correct": "b"}, {"id": "e5", "category": "ethics", "text": "وجدت محفظة مريض في بيته بعد الزيارة. ماذا تفعل؟", "options": [{"key": "a", "text": "تتركها مكانها وتبلغ المريض والإدارة فورًا."}, {"key": "b", "text": "تأخذها معك وتعيدها في الزيارة القادمة."}, {"key": "c", "text": "تفتحها لتعرف صاحبها."}, {"key": "d", "text": "لا تهتم، ليست مسؤوليتك."}], "correct": "a"}, {"id": "e6", "category": "ethics", "text": "مريض يعرض عليك مالًا إضافيًا مقابل أولوية في الحجز. ماذا تفعل؟", "options": [{"key": "a", "text": "تقبله، فهذا حقه."}, {"key": "b", "text": "ترفض بلطف وتشرح أن الحجز حسب النظام للجميع."}, {"key": "c", "text": "تقبله ولا تخبر أحدًا."}, {"key": "d", "text": "تطلب مبلغًا أكبر."}], "correct": "b"}, {"id": "s1", "category": "safety", "text": "وصلت بيت مريض ووجدت الباب مفتوحًا وأصوات شجار عنيف بالداخل. ماذا تفعل؟", "options": [{"key": "a", "text": "تدخل فورًا لتبدأ الزيارة كالمعتاد."}, {"key": "b", "text": "لا تدخل — تبتعد لمكان آمن، وتتصل بالإدارة، وتضغط SOS، وتتصل بالشرطة 122 إن لزم."}, {"key": "c", "text": "تدخل وتحاول فض الشجار بنفسك."}, {"key": "d", "text": "تنتظر أمام الباب حتى يهدأ الشجار ثم تدخل."}], "correct": "b", "redFlagOption": "a"}, {"id": "s2", "category": "safety", "text": "قبل غيار جرح ملتهب، ما أهم خطوة لمكافحة العدوى؟", "options": [{"key": "a", "text": "ارتداء أي ملابس متوفرة."}, {"key": "b", "text": "غسل اليدين واستخدام قفاز معقم وأدوات معقمة."}, {"key": "c", "text": "فتح النافذة فقط."}, {"key": "d", "text": "العمل بسرعة دون تجهيز."}], "correct": "b"}, {"id": "s3", "category": "safety", "text": "بعد الزيارة، أين تتخلص من الإبر والأدوات الحادة المستخدمة؟", "options": [{"key": "a", "text": "في سلة المهملات العادية بالبيت."}, {"key": "b", "text": "في حاوية مخصصة للأدوات الحادة، وتتبع بروتوكول التخلص الآمن."}, {"key": "c", "text": "تتركها في البيت للمريض."}, {"key": "d", "text": "ترميها في الشارع."}], "correct": "b"}, {"id": "s4", "category": "safety", "text": "لاحظت أن أدوات الغيار المتوفرة غير معقمة، والمريض ينتظرك. ماذا تفعل؟", "options": [{"key": "a", "text": "تستخدمها كما هي حتى لا يتأخر المريض."}, {"key": "b", "text": "لا تستخدمها — تستخدم أدوات معقمة من حقيبتك أو تؤجل الغيار وتبلغ الإدارة."}, {"key": "c", "text": "تستخدمها وتخبر المريض أنها نظيفة."}, {"key": "d", "text": "تغسلها بالماء فقط وتستخدمها."}], "correct": "b", "redFlagOption": "a"}, {"id": "s5", "category": "safety", "text": "بعد الزيارة، أين توثّق العلامات الحيوية وملاحظاتك؟", "options": [{"key": "a", "text": "في ورقة تتركها في البيت."}, {"key": "b", "text": "في تقرير الزيارة داخل التطبيق فورًا قبل المغادرة."}, {"key": "c", "text": "في رسالة واتساب لأحد أقاربك."}, {"key": "d", "text": "لا توثقها؛ يكفي أنك تذكرها."}], "correct": "b"}, {"id": "c1", "category": "communication", "text": "سائح ألماني لا يتكلم العربية ولا الإنجليزية جيدًا، ويشير إلى موضع ألم. ماذا تفعل؟", "options": [{"key": "a", "text": "تتركه وتغادر."}, {"key": "b", "text": "تستخدم لغة الإشارة والصور، وتتكلم إنجليزية بسيطة، وتطلب مساعدة الإدارة بمترجم إن لزم."}, {"key": "c", "text": "تتكلم معه بالعربية بصوت أعلى."}, {"key": "d", "text": "تطلب منه أن يكتب شكواه بالألمانية فقط."}], "correct": "b"}, {"id": "c2", "category": "communication", "text": "مريضة مسنّة قلقة وتبكي قبل الغيار. ما أول خطوة؟", "options": [{"key": "a", "text": "تبدأ الغيار فورًا لتوفير الوقت."}, {"key": "b", "text": "تهدئها، وتشرح لها الخطوات ببساطة، وتطلب إذنها قبل البدء."}, {"key": "c", "text": "تطلب من أسرتها إخراجها من الغرفة."}, {"key": "d", "text": "تتجاهل بكاءها."}], "correct": "b"}, {"id": "c3", "category": "communication", "text": "أسرة المريض تتحدث بلهجة وعادات مختلفة عنك وتسأل كثيرًا. كيف تتصرف؟", "options": [{"key": "a", "text": "تتعامل باحترام وتجيب بهدوء، وتتأقلم مع أسلوبهم دون أحكام."}, {"key": "b", "text": "تخبرهم أن أسلوبهم غريب."}, {"key": "c", "text": "ترفض الإجابة لأنها ليست من عملك."}, {"key": "d", "text": "تسخر من لهجتهم."}], "correct": "a"}, {"id": "c4", "category": "communication", "text": "مريض لا يفهم المصطلحات الطبية. كيف تشرح له؟", "options": [{"key": "a", "text": "تستخدم كلمات أبسط وأمثلة من حياته اليومية، وتتأكد من فهمه."}, {"key": "b", "text": "تكرر نفس المصطلحات بصوت أعلى."}, {"key": "c", "text": "تعطيه ورقة طبية إنجليزية وتتركه."}, {"key": "d", "text": "تطلب منه أن يبحث بنفسه."}], "correct": "a"}, {"id": "c5", "category": "communication", "text": "مريض من جنسية أو دين أو مستوى مادي مختلف يطلب رعاية منزلية. ماذا تفعل؟", "options": [{"key": "a", "text": "ترفض تقديم الرعاية بسبب جنسيته أو دينه أو مستواه المادي."}, {"key": "b", "text": "تقدم له نفس الرعاية باحترام كامل، دون أي تمييز."}, {"key": "c", "text": "تقدم له رعاية أقل لأنه مختلف عنك."}, {"key": "d", "text": "تطلب منه مالًا إضافيًا مقابل خدمته."}], "correct": "b", "redFlagOption": "a"}, {"id": "r1", "category": "resilience", "text": "مريض غاضب يرفع صوته عليك بسبب تأخير. ماذا تفعل؟", "options": [{"key": "a", "text": "ترفع صوتك عليه بالمثل."}, {"key": "b", "text": "تحافظ على هدوئك، وتستمع، وتعتذر عن التأخير، وتشرح الحل."}, {"key": "c", "text": "تترك البيت فورًا."}, {"key": "d", "text": "تهدده بإلغاء الخدمة."}], "correct": "b"}, {"id": "r2", "category": "resilience", "text": "وردية ليلية (22:00–06:00) واتصال طارئ وأنت متعب جدًا. ماذا تفعل؟", "options": [{"key": "a", "text": "تذهب مرهقًا وتقود السيارة وأنت نعسان."}, {"key": "b", "text": "تقيّم حالتك بصدق: إن كنت غير قادر على العمل بأمان تبلغ الإدارة فورًا ليجدوا بديلًا، ولا تقود مرهقًا."}, {"key": "c", "text": "تتجاهل الاتصال تمامًا."}, {"key": "d", "text": "تذهب دون إخبار أحد بحالتك."}], "correct": "b"}, {"id": "r3", "category": "resilience", "text": "بعد زيارة صعبة شعرت بالإحباط. ماذا تفعل؟", "options": [{"key": "a", "text": "تستقيل فورًا."}, {"key": "b", "text": "تراجع ما حدث وتتعلم منه وتطلب دعمًا من الإدارة أو زملائك."}, {"key": "c", "text": "تلوم المريض على كل شيء."}, {"key": "d", "text": "تتوقف عن توثيق الزيارات."}], "correct": "b"}, {"id": "r4", "category": "resilience", "text": "مريض يرفض إجراءً تمريضيًا ضروريًا بعد شرحه له. ماذا تفعل؟", "options": [{"key": "a", "text": "تنفذه بالقوة لمصلحته."}, {"key": "b", "text": "تحترم رفضه بعد التأكد من فهمه، وتوثق الرفض وتبلغ الطبيب أو الإدارة."}, {"key": "c", "text": "تتركه دون توثيق."}, {"key": "d", "text": "تهدده بوقف الخدمة."}], "correct": "b"}, {"id": "f1", "category": "conduct", "text": "تأخرت عن موعد زيارة منزلية. ما التصرف الصحيح؟", "options": [{"key": "a", "text": "تذهب متأخرًا دون إخبار أحد."}, {"key": "b", "text": "تتصل بالمريض وتعتذر وتبلغه بالوقت الجديد، وتبلغ الإدارة."}, {"key": "c", "text": "تلغي الزيارة دون إخبار."}, {"key": "d", "text": "تطلب من مريض آخر أن ينتظرك."}], "correct": "b"}, {"id": "f2", "category": "conduct", "text": "عميل يطلب رقم هاتفك الشخصي للتواصل المباشر خارج التطبيق. ماذا تفعل؟", "options": [{"key": "a", "text": "تعطيه رقمك الشخصي فورًا."}, {"key": "b", "text": "توجهه للتواصل عبر التطبيق فقط، وتوضح أن ذلك لحماية الطرفين."}, {"key": "c", "text": "تعطيه رقم زميلك."}, {"key": "d", "text": "توافق بشرط أن يدفع نقدًا."}], "correct": "b"}, {"id": "f3", "category": "conduct", "text": "أثناء الزيارة تدهورت حالة المريض فجأة وأنت وحدك معه. ماذا تفعل؟", "options": [{"key": "a", "text": "تتركه وحده وتغادر البيت."}, {"key": "b", "text": "تبقى معه، وتتصل بالإسعاف 123 فورًا، وتبلغ الإدارة، ولا تغادر حتى يصل المسعفون أو يستقر وضعه."}, {"key": "c", "text": "تغادر لإحضار المساعدة وتتركه دون إشراف."}, {"key": "d", "text": "تنتظر حتى يتحسن وحده."}], "correct": "b", "redFlagOption": "a"}, {"id": "f4", "category": "conduct", "text": "بعد انتهاء الزيارة، الأسرة تقدم لك طعامًا أو شرابًا. ماذا تفعل؟", "options": [{"key": "a", "text": "ترفض بطريقة مهينة."}, {"key": "b", "text": "تشكرهم بلطف، وتقبل أو تعتذر بذوق حسب الموقف، دون أن يؤثر ذلك على عملك."}, {"key": "c", "text": "تطلب المزيد."}, {"key": "d", "text": "تأكل وتتأخر عن زيارتك التالية."}], "correct": "b"}];
const INTERVIEW_ROLE_QUESTIONS = {"assistant": [{"id": "am1", "category": "medical", "text": "كمساعد تمريض، قست العلامات الحيوية لمريض فوجدت نبضه 130 وضغطه 160/100. ماذا تفعل؟", "options": [{"key": "a", "text": "تسجلها فقط وتغادر."}, {"key": "b", "text": "تسجلها بدقة وتبلغ الممرض أو الطبيب المسؤول فورًا، ولا تقرر علاجًا بنفسك."}, {"key": "c", "text": "تعطيه دواء ضغط من حقيبتك."}, {"key": "d", "text": "تطمئنه أن كل شيء طبيعي."}], "correct": "b"}, {"id": "am2", "category": "medical", "text": "مريض يطلب منك إعطاءه دواءً وريديًا. ماذا تفعل؟", "options": [{"key": "a", "text": "تعطيه الدواء فورًا."}, {"key": "b", "text": "ترفض بأدب: إعطاء الأدوية الوريدية خارج نطاق دورك، وتصعّد الأمر للممرض أو الطبيب."}, {"key": "c", "text": "تعطيه نصف الجرعة فقط."}, {"key": "d", "text": "تطلب من أسرته إعطاءه الدواء."}], "correct": "b"}, {"id": "ae1", "category": "ethics", "text": "مريض يسألك عن حالة مريض آخر تعرفه، ويضغط عليك للإجابة. ماذا تفعل؟", "options": [{"key": "a", "text": "تخبره بكل التفاصيل."}, {"key": "b", "text": "تعتذر بلطف وتشرح أن معلومات المرضى سرية، وتبقى ثابتًا رغم الضغط."}, {"key": "c", "text": "تخبره جزئيًا."}, {"key": "d", "text": "تخبره إذا كان قريبًا."}], "correct": "b"}, {"id": "as1", "category": "safety", "text": "قبل تجهيز أدوات غيار، ما أول خطوة؟", "options": [{"key": "a", "text": "تجهز الأدوات على أي سطح متوفر."}, {"key": "b", "text": "تغسل يديك، وتجهز سطحًا نظيفًا وأدوات معقمة، وتتأكد من سلامة الأدوات."}, {"key": "c", "text": "تطلب من المريض تجهيز الأدوات."}, {"key": "d", "text": "تبدأ الغيار دون تجهيز."}], "correct": "b"}, {"id": "ac1", "category": "communication", "text": "مريضة مسنّة لا تسمع جيدًا وتحتاج شرحًا قبل قياس الضغط. كيف تتصرف؟", "options": [{"key": "a", "text": "تصرخ في وجهها."}, {"key": "b", "text": "تتكلم بوضوح وببطء قريبًا منها، وتستخدم الإشارة، وتتأكد من فهمها."}, {"key": "c", "text": "تتجاهلها وتقيس الضغط دون شرح."}, {"key": "d", "text": "تطلب من أسرتها إخراجها."}], "correct": "b"}, {"id": "ar1", "category": "resilience", "text": "يومك طويل وفيه زيارات كثيرة متتالية وأنت مرهق. ماذا تفعل؟", "options": [{"key": "a", "text": "تتخطى توثيق الزيارات لتوفير الوقت."}, {"key": "b", "text": "تلتزم ببروتوكول كل زيارة وتوثيقها، وتبلغ الإدارة إن شعرت أنك لن تستطيع العمل بأمان."}, {"key": "c", "text": "تختصر الغيارات دون إخبار أحد."}, {"key": "d", "text": "تلغي باقي الزيارات دون إخبار."}], "correct": "b"}], "nurse": [{"id": "nm1", "category": "medical", "text": "في العناية بالجروح بالضغط السلبي (NPWT)، ما أهم نقطة؟", "options": [{"key": "a", "text": "تغيير الجهاز كل ساعة."}, {"key": "b", "text": "التأكد من إحكام الغلق، ومراقبة الإفرازات والضغط، وتوثيق كل تغيير حسب البروتوكول."}, {"key": "c", "text": "إيقاف الجهاز ليلًا دون إخبار."}, {"key": "d", "text": "استخدام أي ضماد متاح."}], "correct": "b"}, {"id": "nm2", "category": "medical", "text": "قبل تركيب كانيولا، ما أهم خطوة؟", "options": [{"key": "a", "text": "تركيبها مباشرة."}, {"key": "b", "text": "غسل اليدين، وتجهيز الأدوات المعقمة، واختيار الوريد المناسب، والتأكد من هوية المريض."}, {"key": "c", "text": "طلب المساعدة من الأسرة."}, {"key": "d", "text": "تركيبها بدون قفازات لتوفير الوقت."}], "correct": "b"}, {"id": "ne1", "category": "ethics", "text": "أثناء الزيارة، سمعت معلومة صحية حساسة عن المريض من أحد أقاربه. ماذا تفعل؟", "options": [{"key": "a", "text": "تنشرها في مجموعة العمل."}, {"key": "b", "text": "تحتفظ بها سرًا ولا تشاركها إلا مع الفريق الطبي المعني عند الحاجة."}, {"key": "c", "text": "تخبر الجيران للاطمئنان."}, {"key": "d", "text": "تسجلها في منشور عام."}], "correct": "b"}, {"id": "ns1", "category": "safety", "text": "قبل تركيب قسطرة بولية، ما أهم إجراء سلامة؟", "options": [{"key": "a", "text": "التركيب بسرعة دون تجهيز."}, {"key": "b", "text": "التأكد من أمر الطبيب المكتوب، والتعقيم الكامل، وتأكيد هوية المريض، ثم إكمال قائمة الأمان."}, {"key": "c", "text": "التركيب دون أمر طبيب."}, {"key": "d", "text": "طلب المساعدة من الأسرة للتركيب."}], "correct": "b"}, {"id": "nc1", "category": "communication", "text": "سائح يسألك بالإنجليزية: \"When will the nurse come?\" وأنت لا تفهم كل كلامه. ماذا تفعل؟", "options": [{"key": "a", "text": "تتجاهله وتغادر."}, {"key": "b", "text": "ترد بإنجليزية بسيطة واضحة، وتستخدم الإشارة، وتطلب مساعدة الإدارة إن لزم."}, {"key": "c", "text": "ترد بالعربية بصوت أعلى."}, {"key": "d", "text": "تقول \"لا أفهم\" وتتركه."}], "correct": "b"}, {"id": "nr1", "category": "resilience", "text": "تدهورت حالة مريض فجأة أثناء زيارتك (ضيق نفس شديد). ماذا تفعل أولًا؟", "options": [{"key": "a", "text": "تكمل الغيار أولًا."}, {"key": "b", "text": "توقف الإجراء، وتقيّم مجرى الهواء والتنفس، وتتصل بالإسعاف 123، وتبلغ الإدارة."}, {"key": "c", "text": "تطلب من الأسرة التصرف وحدها."}, {"key": "d", "text": "تغادر البيت فورًا."}], "correct": "b"}], "doctor": [{"id": "dm1", "category": "medical", "text": "مريض منزلي لديه ألم صدر شديد وضيق نفس. ما القرار الصحيح؟", "options": [{"key": "a", "text": "تعالجه في البيت وتطمئنه."}, {"key": "b", "text": "تحوّله فورًا للمستشفى بالإسعاف 123، فالرعاية المنزلية غير كافية هنا."}, {"key": "c", "text": "تصف له مسكنًا وتغادر."}, {"key": "d", "text": "تطلب منه الانتظار حتى الصباح."}], "correct": "b"}, {"id": "dm2", "category": "medical", "text": "سائح يطلب شهادة \"Fit to Fly\" قبل سفره. ماذا تفعل؟", "options": [{"key": "a", "text": "تصدرها فورًا دون فحص."}, {"key": "b", "text": "تفحصه وتقيّم حالته وفق معايير السفر الجوي، وتصدر الشهادة فقط إن كانت حالته تسمح بذلك."}, {"key": "c", "text": "ترفض دون فحص."}, {"key": "d", "text": "تصدرها مقابل مال إضافي."}], "correct": "b"}, {"id": "de1", "category": "ethics", "text": "مريض يطلب منك وصف دواء لا يحتاجه طبيًا. ماذا تفعل؟", "options": [{"key": "a", "text": "تصفه له لإرضائه."}, {"key": "b", "text": "ترفض بأدب وتشرح له لماذا لا يحتاجه، وتقترح البديل المناسب إن وجد."}, {"key": "c", "text": "تصفه بجرعة مضاعفة."}, {"key": "d", "text": "تتجاهل طلبه."}], "correct": "b"}, {"id": "ds1", "category": "safety", "text": "لاحظت أن حالة مريض منزلي تحتاج متابعة مستشفى وليس رعاية منزلية. ماذا تفعل؟", "options": [{"key": "a", "text": "تستمر في الزيارات المنزلية فقط."}, {"key": "b", "text": "توثق تقييمك وتحوّل المريض للمستشفى، وتبلغ الإدارة وأسرته بالسبب."}, {"key": "c", "text": "توقف الزيارات دون إخبار أحد."}, {"key": "d", "text": "تطلب من الأسرة البحث عن طبيب آخر."}], "correct": "b"}, {"id": "dc1", "category": "communication", "text": "كيف تشرح لمريض تشخيصه وخطة علاجه بلغة بسيطة؟", "options": [{"key": "a", "text": "تستخدم المصطلحات الطبية كما هي دون شرح."}, {"key": "b", "text": "تشرح بكلمات بسيطة وأمثلة يومية، وتتأكد من فهمه، وتجيب عن أسئلته بصبر."}, {"key": "c", "text": "تعطيه ورقة إنجليزية وتغادر."}, {"key": "d", "text": "تطلب منه البحث على الإنترنت."}], "correct": "b"}, {"id": "dr1", "category": "resilience", "text": "اتصال طارئ في منتصف الليل وأنت متعب بعد يوم طويل. ماذا تفعل؟", "options": [{"key": "a", "text": "تتجاهل الاتصال."}, {"key": "b", "text": "تقيّم حالتك بصدق: إن كنت قادرًا على العمل بأمان تستجيب، وإلا تبلغ الإدارة فورًا ليجدوا بديلًا."}, {"key": "c", "text": "تذهب وأنت غير قادر على التركيز دون إخبار أحد."}, {"key": "d", "text": "تطلب من المريض الانتظار حتى الصباح دون تقييم."}], "correct": "b"}], "physio": [{"id": "pm1", "category": "medical", "text": "مريض بعد جلطة يبدأ تأهيلًا حركيًا في البيت. ما أول خطوة؟", "options": [{"key": "a", "text": "تبدأ تمارين قوية فورًا."}, {"key": "b", "text": "تقيّم حالته وقدرته الحركية وخطر السقوط، وتضع خطة تمارين تدريجية آمنة."}, {"key": "c", "text": "تطلب منه المشي وحده دون إشراف."}, {"key": "d", "text": "تعطيه أدوية مسكنة."}], "correct": "b"}, {"id": "pm2", "category": "medical", "text": "مريض بعد كسر يشتكي ألمًا شديدًا أثناء التمرين. ماذا تفعل؟", "options": [{"key": "a", "text": "تستمر في التمرين رغم الألم."}, {"key": "b", "text": "توقف التمرين، وتقيّم الألم، وتعدّل الخطة أو تحيله للطبيب إن لزم."}, {"key": "c", "text": "تطلب منه تحمل الألم دون توقف."}, {"key": "d", "text": "تعطيه دواءً من عندك."}], "correct": "b"}, {"id": "pe1", "category": "ethics", "text": "مريض يطلب منك وصف دواء لألم عضلاته. ماذا تفعل؟", "options": [{"key": "a", "text": "تصف له الدواء بنفسك."}, {"key": "b", "text": "توضح أن وصف الأدوية خارج نطاق دورك، وتحيله للطبيب."}, {"key": "c", "text": "تعطيه دواءً من حقيبتك."}, {"key": "d", "text": "تتجاهل طلبه."}], "correct": "b"}, {"id": "ps1", "category": "safety", "text": "مريض مسنّ معرّض للسقوط أثناء تمارين التوازن والمشي. ماذا تفعل؟", "options": [{"key": "a", "text": "تتركه يتدرب وحده."}, {"key": "b", "text": "تؤمّن المكان، وتبقى قريبًا منه طوال التمرين، وتستخدم دعمًا مناسبًا، وتوقف التمرين عند أي خطر."}, {"key": "c", "text": "تطلب منه التدرب على الدرج."}, {"key": "d", "text": "تستمر رغم الدوار."}], "correct": "b"}, {"id": "pc1", "category": "communication", "text": "مريض مسنّ محبط لأن تحسنه بطيء. كيف تتعامل معه؟", "options": [{"key": "a", "text": "تخبره أنه لن يتحسن أبدًا."}, {"key": "b", "text": "تشجعه، وتشرح له التقدم التدريجي بأمثلة واضحة، وتضع أهدافًا صغيرة واقعية."}, {"key": "c", "text": "تتجاهل إحباطه."}, {"key": "d", "text": "تلغي جلساته."}], "correct": "b"}, {"id": "pr1", "category": "resilience", "text": "جلسات تأهيل طويلة وتقدم بطيء والأسرة تضغط عليك. ماذا تفعل؟", "options": [{"key": "a", "text": "تستسلم للضغط وتغيّر الخطة دون أساس."}, {"key": "b", "text": "تشرح للأسرة واقع التقدم بهدوء، وتلتزم بالخطة العلاجية، وتوثق كل جلسة."}, {"key": "c", "text": "تترك المريض دون إخبار."}, {"key": "d", "text": "تختصر الجلسات سرًا."}], "correct": "b"}]};
const MCQ = [{"id": "m1", "category": "medical", "text": "مريض فاقد للوعي ولا يتنفس بشكل طبيعي في بيته. ماذا تفعل أولًا؟", "options": [{"key": "a", "text": "أبدأ علاجه في البيت وأنتظر حتى يتحسن وحده."}, {"key": "b", "text": "أتصل بالإسعاف 123 فورًا، وأبدأ الإنعاش القلبي الرئوي إن كنت مدرّبًا عليه، وأبقيه في وضع آمن."}, {"key": "c", "text": "أعطيه ماءً وسكرًا وأتركه نائمًا."}, {"key": "d", "text": "أتصل بأسرته فقط وأنتظر وصولهم."}], "correct": "b", "redFlagOption": "a"}, {"id": "m2", "category": "medical", "text": "تقيس الضغط لمريض فتجد 180/110 والنبض 120. ماذا تفعل؟", "options": [{"key": "a", "text": "تسجلها فقط وتغادر."}, {"key": "b", "text": "تعيد القياس للتأكد، وتسأل عن الأعراض، وتبلغ الطبيب أو الإدارة فورًا حسب البروتوكول."}, {"key": "c", "text": "تعطي دواء ضغط من عندك."}, {"key": "d", "text": "تطمئن المريض بأن كل شيء طبيعي."}], "correct": "b"}, {"id": "m3", "category": "medical", "text": "أثناء محلول وريدي ظهر طفح جلدي وضيق نفس على المريض. ماذا تفعل؟", "options": [{"key": "a", "text": "تكمل الدواء حتى ينتهي المحلول."}, {"key": "b", "text": "توقف الدواء فورًا، وتقيّم مجرى الهواء والتنفس، وتطلب إسعافًا أو طبيبًا فورًا، وتوثق الحدث."}, {"key": "c", "text": "تعطي دواءً آخر من عندك لتهدئة الطفح."}, {"key": "d", "text": "تطلب من المريض الانتظار حتى يتحسن وحده."}], "correct": "b", "redFlagOption": "a"}, {"id": "m4", "category": "medical", "text": "ما أول إجراء عند نزيف خارجي شديد من جرح؟", "options": [{"key": "a", "text": "تنظيف الجرح أولًا."}, {"key": "b", "text": "الضغط المباشر على الجرح لوقف النزيف، وطلب المساعدة الطبية."}, {"key": "c", "text": "رفع المريض واقفًا."}, {"key": "d", "text": "وضع الثلج فقط."}], "correct": "b"}, {"id": "m5", "category": "medical", "text": "مريض سكري لديه جرح قدم، وتلاحظ رائحة كريهة وإفرازات. ما التصرف الصحيح؟", "options": [{"key": "a", "text": "تغطي الجرح فقط وتغادر."}, {"key": "b", "text": "تقيّم الجرح، وتوثق العلامات، وتبلغ الطبيب أو الإدارة فورًا، وتتبع بروتوكول الغيار المعتمد."}, {"key": "c", "text": "تضع مرهمًا من عندك دون توثيق."}, {"key": "d", "text": "تطلب من المريض الانتظار أسبوعًا."}], "correct": "b"}, {"id": "m6", "category": "medical", "text": "مريض يطلب منك تشخيص طفح جلدي لديه ووصف مضاد حيوي له. ماذا تفعل؟", "options": [{"key": "a", "text": "تشخّص الطفح وتصف له المضاد الحيوي بنفسك."}, {"key": "b", "text": "توضح له أن التشخيص ووصف الدواء خارج نطاق دورك، وتوثق ملاحظاتك وتحيله للطبيب أو الإدارة."}, {"key": "c", "text": "تعطيه أي دواء متوفر معك."}, {"key": "d", "text": "تتجاهل طلبه تمامًا دون شرح."}], "correct": "b", "redFlagOption": "a"}, {"id": "e1", "category": "ethics", "text": "بعد الزيارة، أسرة المريض تطلب منك صورة الجرح \"لترسلها لأقاربهم على واتساب\". ماذا تفعل؟", "options": [{"key": "a", "text": "ترسل الصورة لهم فورًا."}, {"key": "b", "text": "ترفض بأدب: صور المرضى سرية ولا تُرسَل إلا عبر تقرير التطبيق الرسمي وبموافقة المريض."}, {"key": "c", "text": "تنشر الصورة في مجموعة العمل أولًا."}, {"key": "d", "text": "ترسلها من هاتفك الشخصي دون توثيق."}], "correct": "b", "redFlagOption": "a"}, {"id": "e2", "category": "ethics", "text": "مريض يعرض عليك مالًا نقديًا \"خارج التطبيق\" مقابل أن تأتيه مباشرة دون حجز. ماذا تفعل؟", "options": [{"key": "a", "text": "تقبل المال وتذهب إليه مباشرة."}, {"key": "b", "text": "ترفض وتوضح أن كل الحجز والدفع عبر التطبيق لحماية الطرفين."}, {"key": "c", "text": "تقبل المال ولا تخبر أحدًا."}, {"key": "d", "text": "تطلب مبلغًا أكبر مقابل الزيارة."}], "correct": "b", "redFlagOption": "a"}, {"id": "e3", "category": "ethics", "text": "زميل يطلب منك توقيع تقرير زيارة لم تحضرها، أو تسجيل علامات حيوية لم تقسها. ماذا تفعل؟", "options": [{"key": "a", "text": "توقع، لأنها مجاملة بسيطة."}, {"key": "b", "text": "ترفض؛ التوقيع على ما لم تفعله أو تسجيل قياسات لم تقسها تزوير."}, {"key": "c", "text": "توقع وتكتب ملاحظة صغيرة."}, {"key": "d", "text": "تطلب منه مالًا مقابل التوقيع."}], "correct": "b", "redFlagOption": "a"}, {"id": "e4", "category": "ethics", "text": "مريض يطلب منك أن تخبر أسرته بتشخيصه دون علمه. ماذا تفعل؟", "options": [{"key": "a", "text": "تخبر الأسرة فورًا لأنهم يدفعون."}, {"key": "b", "text": "ترفض وتشرح للمريض حقه في الخصوصية، وتطلب موافقته أولًا."}, {"key": "c", "text": "تخبر الأسرة جزئيًا فقط."}, {"key": "d", "text": "تتجاهل الطلب ولا ترد."}], "correct": "b"}, {"id": "e5", "category": "ethics", "text": "وجدت محفظة مريض في بيته بعد الزيارة. ماذا تفعل؟", "options": [{"key": "a", "text": "تتركها مكانها وتبلغ المريض والإدارة فورًا."}, {"key": "b", "text": "تأخذها معك وتعيدها في الزيارة القادمة."}, {"key": "c", "text": "تفتحها لتعرف صاحبها."}, {"key": "d", "text": "لا تهتم، ليست مسؤوليتك."}], "correct": "a"}, {"id": "e6", "category": "ethics", "text": "مريض يعرض عليك مالًا إضافيًا مقابل أولوية في الحجز. ماذا تفعل؟", "options": [{"key": "a", "text": "تقبله، فهذا حقه."}, {"key": "b", "text": "ترفض بلطف وتشرح أن الحجز حسب النظام للجميع."}, {"key": "c", "text": "تقبله ولا تخبر أحدًا."}, {"key": "d", "text": "تطلب مبلغًا أكبر."}], "correct": "b"}, {"id": "s1", "category": "safety", "text": "وصلت بيت مريض ووجدت الباب مفتوحًا وأصوات شجار عنيف بالداخل. ماذا تفعل؟", "options": [{"key": "a", "text": "تدخل فورًا لتبدأ الزيارة كالمعتاد."}, {"key": "b", "text": "لا تدخل — تبتعد لمكان آمن، وتتصل بالإدارة، وتضغط SOS، وتتصل بالشرطة 122 إن لزم."}, {"key": "c", "text": "تدخل وتحاول فض الشجار بنفسك."}, {"key": "d", "text": "تنتظر أمام الباب حتى يهدأ الشجار ثم تدخل."}], "correct": "b", "redFlagOption": "a"}, {"id": "s2", "category": "safety", "text": "قبل غيار جرح ملتهب، ما أهم خطوة لمكافحة العدوى؟", "options": [{"key": "a", "text": "ارتداء أي ملابس متوفرة."}, {"key": "b", "text": "غسل اليدين واستخدام قفاز معقم وأدوات معقمة."}, {"key": "c", "text": "فتح النافذة فقط."}, {"key": "d", "text": "العمل بسرعة دون تجهيز."}], "correct": "b"}, {"id": "s3", "category": "safety", "text": "بعد الزيارة، أين تتخلص من الإبر والأدوات الحادة المستخدمة؟", "options": [{"key": "a", "text": "في سلة المهملات العادية بالبيت."}, {"key": "b", "text": "في حاوية مخصصة للأدوات الحادة، وتتبع بروتوكول التخلص الآمن."}, {"key": "c", "text": "تتركها في البيت للمريض."}, {"key": "d", "text": "ترميها في الشارع."}], "correct": "b"}, {"id": "s4", "category": "safety", "text": "لاحظت أن أدوات الغيار المتوفرة غير معقمة، والمريض ينتظرك. ماذا تفعل؟", "options": [{"key": "a", "text": "تستخدمها كما هي حتى لا يتأخر المريض."}, {"key": "b", "text": "لا تستخدمها — تستخدم أدوات معقمة من حقيبتك أو تؤجل الغيار وتبلغ الإدارة."}, {"key": "c", "text": "تستخدمها وتخبر المريض أنها نظيفة."}, {"key": "d", "text": "تغسلها بالماء فقط وتستخدمها."}], "correct": "b", "redFlagOption": "a"}, {"id": "s5", "category": "safety", "text": "بعد الزيارة، أين توثّق العلامات الحيوية وملاحظاتك؟", "options": [{"key": "a", "text": "في ورقة تتركها في البيت."}, {"key": "b", "text": "في تقرير الزيارة داخل التطبيق فورًا قبل المغادرة."}, {"key": "c", "text": "في رسالة واتساب لأحد أقاربك."}, {"key": "d", "text": "لا توثقها؛ يكفي أنك تذكرها."}], "correct": "b"}, {"id": "c1", "category": "communication", "text": "سائح ألماني لا يتكلم العربية ولا الإنجليزية جيدًا، ويشير إلى موضع ألم. ماذا تفعل؟", "options": [{"key": "a", "text": "تتركه وتغادر."}, {"key": "b", "text": "تستخدم لغة الإشارة والصور، وتتكلم إنجليزية بسيطة، وتطلب مساعدة الإدارة بمترجم إن لزم."}, {"key": "c", "text": "تتكلم معه بالعربية بصوت أعلى."}, {"key": "d", "text": "تطلب منه أن يكتب شكواه بالألمانية فقط."}], "correct": "b"}, {"id": "c2", "category": "communication", "text": "مريضة مسنّة قلقة وتبكي قبل الغيار. ما أول خطوة؟", "options": [{"key": "a", "text": "تبدأ الغيار فورًا لتوفير الوقت."}, {"key": "b", "text": "تهدئها، وتشرح لها الخطوات ببساطة، وتطلب إذنها قبل البدء."}, {"key": "c", "text": "تطلب من أسرتها إخراجها من الغرفة."}, {"key": "d", "text": "تتجاهل بكاءها."}], "correct": "b"}, {"id": "c3", "category": "communication", "text": "أسرة المريض تتحدث بلهجة وعادات مختلفة عنك وتسأل كثيرًا. كيف تتصرف؟", "options": [{"key": "a", "text": "تتعامل باحترام وتجيب بهدوء، وتتأقلم مع أسلوبهم دون أحكام."}, {"key": "b", "text": "تخبرهم أن أسلوبهم غريب."}, {"key": "c", "text": "ترفض الإجابة لأنها ليست من عملك."}, {"key": "d", "text": "تسخر من لهجتهم."}], "correct": "a"}, {"id": "c4", "category": "communication", "text": "مريض لا يفهم المصطلحات الطبية. كيف تشرح له؟", "options": [{"key": "a", "text": "تستخدم كلمات أبسط وأمثلة من حياته اليومية، وتتأكد من فهمه."}, {"key": "b", "text": "تكرر نفس المصطلحات بصوت أعلى."}, {"key": "c", "text": "تعطيه ورقة طبية إنجليزية وتتركه."}, {"key": "d", "text": "تطلب منه أن يبحث بنفسه."}], "correct": "a"}, {"id": "c5", "category": "communication", "text": "مريض من جنسية أو دين أو مستوى مادي مختلف يطلب رعاية منزلية. ماذا تفعل؟", "options": [{"key": "a", "text": "ترفض تقديم الرعاية بسبب جنسيته أو دينه أو مستواه المادي."}, {"key": "b", "text": "تقدم له نفس الرعاية باحترام كامل، دون أي تمييز."}, {"key": "c", "text": "تقدم له رعاية أقل لأنه مختلف عنك."}, {"key": "d", "text": "تطلب منه مالًا إضافيًا مقابل خدمته."}], "correct": "b", "redFlagOption": "a"}, {"id": "r1", "category": "resilience", "text": "مريض غاضب يرفع صوته عليك بسبب تأخير. ماذا تفعل؟", "options": [{"key": "a", "text": "ترفع صوتك عليه بالمثل."}, {"key": "b", "text": "تحافظ على هدوئك، وتستمع، وتعتذر عن التأخير، وتشرح الحل."}, {"key": "c", "text": "تترك البيت فورًا."}, {"key": "d", "text": "تهدده بإلغاء الخدمة."}], "correct": "b"}, {"id": "r2", "category": "resilience", "text": "وردية ليلية (22:00–06:00) واتصال طارئ وأنت متعب جدًا. ماذا تفعل؟", "options": [{"key": "a", "text": "تذهب مرهقًا وتقود السيارة وأنت نعسان."}, {"key": "b", "text": "تقيّم حالتك بصدق: إن كنت غير قادر على العمل بأمان تبلغ الإدارة فورًا ليجدوا بديلًا، ولا تقود مرهقًا."}, {"key": "c", "text": "تتجاهل الاتصال تمامًا."}, {"key": "d", "text": "تذهب دون إخبار أحد بحالتك."}], "correct": "b"}, {"id": "r3", "category": "resilience", "text": "بعد زيارة صعبة شعرت بالإحباط. ماذا تفعل؟", "options": [{"key": "a", "text": "تستقيل فورًا."}, {"key": "b", "text": "تراجع ما حدث وتتعلم منه وتطلب دعمًا من الإدارة أو زملائك."}, {"key": "c", "text": "تلوم المريض على كل شيء."}, {"key": "d", "text": "تتوقف عن توثيق الزيارات."}], "correct": "b"}, {"id": "r4", "category": "resilience", "text": "مريض يرفض إجراءً تمريضيًا ضروريًا بعد شرحه له. ماذا تفعل؟", "options": [{"key": "a", "text": "تنفذه بالقوة لمصلحته."}, {"key": "b", "text": "تحترم رفضه بعد التأكد من فهمه، وتوثق الرفض وتبلغ الطبيب أو الإدارة."}, {"key": "c", "text": "تتركه دون توثيق."}, {"key": "d", "text": "تهدده بوقف الخدمة."}], "correct": "b"}, {"id": "f1", "category": "conduct", "text": "تأخرت عن موعد زيارة منزلية. ما التصرف الصحيح؟", "options": [{"key": "a", "text": "تذهب متأخرًا دون إخبار أحد."}, {"key": "b", "text": "تتصل بالمريض وتعتذر وتبلغه بالوقت الجديد، وتبلغ الإدارة."}, {"key": "c", "text": "تلغي الزيارة دون إخبار."}, {"key": "d", "text": "تطلب من مريض آخر أن ينتظرك."}], "correct": "b"}, {"id": "f2", "category": "conduct", "text": "عميل يطلب رقم هاتفك الشخصي للتواصل المباشر خارج التطبيق. ماذا تفعل؟", "options": [{"key": "a", "text": "تعطيه رقمك الشخصي فورًا."}, {"key": "b", "text": "توجهه للتواصل عبر التطبيق فقط، وتوضح أن ذلك لحماية الطرفين."}, {"key": "c", "text": "تعطيه رقم زميلك."}, {"key": "d", "text": "توافق بشرط أن يدفع نقدًا."}], "correct": "b"}, {"id": "f3", "category": "conduct", "text": "أثناء الزيارة تدهورت حالة المريض فجأة وأنت وحدك معه. ماذا تفعل؟", "options": [{"key": "a", "text": "تتركه وحده وتغادر البيت."}, {"key": "b", "text": "تبقى معه، وتتصل بالإسعاف 123 فورًا، وتبلغ الإدارة، ولا تغادر حتى يصل المسعفون أو يستقر وضعه."}, {"key": "c", "text": "تغادر لإحضار المساعدة وتتركه دون إشراف."}, {"key": "d", "text": "تنتظر حتى يتحسن وحده."}], "correct": "b", "redFlagOption": "a"}, {"id": "f4", "category": "conduct", "text": "بعد انتهاء الزيارة، الأسرة تقدم لك طعامًا أو شرابًا. ماذا تفعل؟", "options": [{"key": "a", "text": "ترفض بطريقة مهينة."}, {"key": "b", "text": "تشكرهم بلطف، وتقبل أو تعتذر بذوق حسب الموقف، دون أن يؤثر ذلك على عملك."}, {"key": "c", "text": "تطلب المزيد."}, {"key": "d", "text": "تأكل وتتأخر عن زيارتك التالية."}], "correct": "b"}, {"id": "am1", "category": "medical", "text": "كمساعد تمريض، قست العلامات الحيوية لمريض فوجدت نبضه 130 وضغطه 160/100. ماذا تفعل؟", "options": [{"key": "a", "text": "تسجلها فقط وتغادر."}, {"key": "b", "text": "تسجلها بدقة وتبلغ الممرض أو الطبيب المسؤول فورًا، ولا تقرر علاجًا بنفسك."}, {"key": "c", "text": "تعطيه دواء ضغط من حقيبتك."}, {"key": "d", "text": "تطمئنه أن كل شيء طبيعي."}], "correct": "b"}, {"id": "am2", "category": "medical", "text": "مريض يطلب منك إعطاءه دواءً وريديًا. ماذا تفعل؟", "options": [{"key": "a", "text": "تعطيه الدواء فورًا."}, {"key": "b", "text": "ترفض بأدب: إعطاء الأدوية الوريدية خارج نطاق دورك، وتصعّد الأمر للممرض أو الطبيب."}, {"key": "c", "text": "تعطيه نصف الجرعة فقط."}, {"key": "d", "text": "تطلب من أسرته إعطاءه الدواء."}], "correct": "b"}, {"id": "ae1", "category": "ethics", "text": "مريض يسألك عن حالة مريض آخر تعرفه، ويضغط عليك للإجابة. ماذا تفعل؟", "options": [{"key": "a", "text": "تخبره بكل التفاصيل."}, {"key": "b", "text": "تعتذر بلطف وتشرح أن معلومات المرضى سرية، وتبقى ثابتًا رغم الضغط."}, {"key": "c", "text": "تخبره جزئيًا."}, {"key": "d", "text": "تخبره إذا كان قريبًا."}], "correct": "b"}, {"id": "as1", "category": "safety", "text": "قبل تجهيز أدوات غيار، ما أول خطوة؟", "options": [{"key": "a", "text": "تجهز الأدوات على أي سطح متوفر."}, {"key": "b", "text": "تغسل يديك، وتجهز سطحًا نظيفًا وأدوات معقمة، وتتأكد من سلامة الأدوات."}, {"key": "c", "text": "تطلب من المريض تجهيز الأدوات."}, {"key": "d", "text": "تبدأ الغيار دون تجهيز."}], "correct": "b"}, {"id": "ac1", "category": "communication", "text": "مريضة مسنّة لا تسمع جيدًا وتحتاج شرحًا قبل قياس الضغط. كيف تتصرف؟", "options": [{"key": "a", "text": "تصرخ في وجهها."}, {"key": "b", "text": "تتكلم بوضوح وببطء قريبًا منها، وتستخدم الإشارة، وتتأكد من فهمها."}, {"key": "c", "text": "تتجاهلها وتقيس الضغط دون شرح."}, {"key": "d", "text": "تطلب من أسرتها إخراجها."}], "correct": "b"}, {"id": "ar1", "category": "resilience", "text": "يومك طويل وفيه زيارات كثيرة متتالية وأنت مرهق. ماذا تفعل؟", "options": [{"key": "a", "text": "تتخطى توثيق الزيارات لتوفير الوقت."}, {"key": "b", "text": "تلتزم ببروتوكول كل زيارة وتوثيقها، وتبلغ الإدارة إن شعرت أنك لن تستطيع العمل بأمان."}, {"key": "c", "text": "تختصر الغيارات دون إخبار أحد."}, {"key": "d", "text": "تلغي باقي الزيارات دون إخبار."}], "correct": "b"}, {"id": "nm1", "category": "medical", "text": "في العناية بالجروح بالضغط السلبي (NPWT)، ما أهم نقطة؟", "options": [{"key": "a", "text": "تغيير الجهاز كل ساعة."}, {"key": "b", "text": "التأكد من إحكام الغلق، ومراقبة الإفرازات والضغط، وتوثيق كل تغيير حسب البروتوكول."}, {"key": "c", "text": "إيقاف الجهاز ليلًا دون إخبار."}, {"key": "d", "text": "استخدام أي ضماد متاح."}], "correct": "b"}, {"id": "nm2", "category": "medical", "text": "قبل تركيب كانيولا، ما أهم خطوة؟", "options": [{"key": "a", "text": "تركيبها مباشرة."}, {"key": "b", "text": "غسل اليدين، وتجهيز الأدوات المعقمة، واختيار الوريد المناسب، والتأكد من هوية المريض."}, {"key": "c", "text": "طلب المساعدة من الأسرة."}, {"key": "d", "text": "تركيبها بدون قفازات لتوفير الوقت."}], "correct": "b"}, {"id": "ne1", "category": "ethics", "text": "أثناء الزيارة، سمعت معلومة صحية حساسة عن المريض من أحد أقاربه. ماذا تفعل؟", "options": [{"key": "a", "text": "تنشرها في مجموعة العمل."}, {"key": "b", "text": "تحتفظ بها سرًا ولا تشاركها إلا مع الفريق الطبي المعني عند الحاجة."}, {"key": "c", "text": "تخبر الجيران للاطمئنان."}, {"key": "d", "text": "تسجلها في منشور عام."}], "correct": "b"}, {"id": "ns1", "category": "safety", "text": "قبل تركيب قسطرة بولية، ما أهم إجراء سلامة؟", "options": [{"key": "a", "text": "التركيب بسرعة دون تجهيز."}, {"key": "b", "text": "التأكد من أمر الطبيب المكتوب، والتعقيم الكامل، وتأكيد هوية المريض، ثم إكمال قائمة الأمان."}, {"key": "c", "text": "التركيب دون أمر طبيب."}, {"key": "d", "text": "طلب المساعدة من الأسرة للتركيب."}], "correct": "b"}, {"id": "nc1", "category": "communication", "text": "سائح يسألك بالإنجليزية: \"When will the nurse come?\" وأنت لا تفهم كل كلامه. ماذا تفعل؟", "options": [{"key": "a", "text": "تتجاهله وتغادر."}, {"key": "b", "text": "ترد بإنجليزية بسيطة واضحة، وتستخدم الإشارة، وتطلب مساعدة الإدارة إن لزم."}, {"key": "c", "text": "ترد بالعربية بصوت أعلى."}, {"key": "d", "text": "تقول \"لا أفهم\" وتتركه."}], "correct": "b"}, {"id": "nr1", "category": "resilience", "text": "تدهورت حالة مريض فجأة أثناء زيارتك (ضيق نفس شديد). ماذا تفعل أولًا؟", "options": [{"key": "a", "text": "تكمل الغيار أولًا."}, {"key": "b", "text": "توقف الإجراء، وتقيّم مجرى الهواء والتنفس، وتتصل بالإسعاف 123، وتبلغ الإدارة."}, {"key": "c", "text": "تطلب من الأسرة التصرف وحدها."}, {"key": "d", "text": "تغادر البيت فورًا."}], "correct": "b"}, {"id": "dm1", "category": "medical", "text": "مريض منزلي لديه ألم صدر شديد وضيق نفس. ما القرار الصحيح؟", "options": [{"key": "a", "text": "تعالجه في البيت وتطمئنه."}, {"key": "b", "text": "تحوّله فورًا للمستشفى بالإسعاف 123، فالرعاية المنزلية غير كافية هنا."}, {"key": "c", "text": "تصف له مسكنًا وتغادر."}, {"key": "d", "text": "تطلب منه الانتظار حتى الصباح."}], "correct": "b"}, {"id": "dm2", "category": "medical", "text": "سائح يطلب شهادة \"Fit to Fly\" قبل سفره. ماذا تفعل؟", "options": [{"key": "a", "text": "تصدرها فورًا دون فحص."}, {"key": "b", "text": "تفحصه وتقيّم حالته وفق معايير السفر الجوي، وتصدر الشهادة فقط إن كانت حالته تسمح بذلك."}, {"key": "c", "text": "ترفض دون فحص."}, {"key": "d", "text": "تصدرها مقابل مال إضافي."}], "correct": "b"}, {"id": "de1", "category": "ethics", "text": "مريض يطلب منك وصف دواء لا يحتاجه طبيًا. ماذا تفعل؟", "options": [{"key": "a", "text": "تصفه له لإرضائه."}, {"key": "b", "text": "ترفض بأدب وتشرح له لماذا لا يحتاجه، وتقترح البديل المناسب إن وجد."}, {"key": "c", "text": "تصفه بجرعة مضاعفة."}, {"key": "d", "text": "تتجاهل طلبه."}], "correct": "b"}, {"id": "ds1", "category": "safety", "text": "لاحظت أن حالة مريض منزلي تحتاج متابعة مستشفى وليس رعاية منزلية. ماذا تفعل؟", "options": [{"key": "a", "text": "تستمر في الزيارات المنزلية فقط."}, {"key": "b", "text": "توثق تقييمك وتحوّل المريض للمستشفى، وتبلغ الإدارة وأسرته بالسبب."}, {"key": "c", "text": "توقف الزيارات دون إخبار أحد."}, {"key": "d", "text": "تطلب من الأسرة البحث عن طبيب آخر."}], "correct": "b"}, {"id": "dc1", "category": "communication", "text": "كيف تشرح لمريض تشخيصه وخطة علاجه بلغة بسيطة؟", "options": [{"key": "a", "text": "تستخدم المصطلحات الطبية كما هي دون شرح."}, {"key": "b", "text": "تشرح بكلمات بسيطة وأمثلة يومية، وتتأكد من فهمه، وتجيب عن أسئلته بصبر."}, {"key": "c", "text": "تعطيه ورقة إنجليزية وتغادر."}, {"key": "d", "text": "تطلب منه البحث على الإنترنت."}], "correct": "b"}, {"id": "dr1", "category": "resilience", "text": "اتصال طارئ في منتصف الليل وأنت متعب بعد يوم طويل. ماذا تفعل؟", "options": [{"key": "a", "text": "تتجاهل الاتصال."}, {"key": "b", "text": "تقيّم حالتك بصدق: إن كنت قادرًا على العمل بأمان تستجيب، وإلا تبلغ الإدارة فورًا ليجدوا بديلًا."}, {"key": "c", "text": "تذهب وأنت غير قادر على التركيز دون إخبار أحد."}, {"key": "d", "text": "تطلب من المريض الانتظار حتى الصباح دون تقييم."}], "correct": "b"}, {"id": "pm1", "category": "medical", "text": "مريض بعد جلطة يبدأ تأهيلًا حركيًا في البيت. ما أول خطوة؟", "options": [{"key": "a", "text": "تبدأ تمارين قوية فورًا."}, {"key": "b", "text": "تقيّم حالته وقدرته الحركية وخطر السقوط، وتضع خطة تمارين تدريجية آمنة."}, {"key": "c", "text": "تطلب منه المشي وحده دون إشراف."}, {"key": "d", "text": "تعطيه أدوية مسكنة."}], "correct": "b"}, {"id": "pm2", "category": "medical", "text": "مريض بعد كسر يشتكي ألمًا شديدًا أثناء التمرين. ماذا تفعل؟", "options": [{"key": "a", "text": "تستمر في التمرين رغم الألم."}, {"key": "b", "text": "توقف التمرين، وتقيّم الألم، وتعدّل الخطة أو تحيله للطبيب إن لزم."}, {"key": "c", "text": "تطلب منه تحمل الألم دون توقف."}, {"key": "d", "text": "تعطيه دواءً من عندك."}], "correct": "b"}, {"id": "pe1", "category": "ethics", "text": "مريض يطلب منك وصف دواء لألم عضلاته. ماذا تفعل؟", "options": [{"key": "a", "text": "تصف له الدواء بنفسك."}, {"key": "b", "text": "توضح أن وصف الأدوية خارج نطاق دورك، وتحيله للطبيب."}, {"key": "c", "text": "تعطيه دواءً من حقيبتك."}, {"key": "d", "text": "تتجاهل طلبه."}], "correct": "b"}, {"id": "ps1", "category": "safety", "text": "مريض مسنّ معرّض للسقوط أثناء تمارين التوازن والمشي. ماذا تفعل؟", "options": [{"key": "a", "text": "تتركه يتدرب وحده."}, {"key": "b", "text": "تؤمّن المكان، وتبقى قريبًا منه طوال التمرين، وتستخدم دعمًا مناسبًا، وتوقف التمرين عند أي خطر."}, {"key": "c", "text": "تطلب منه التدرب على الدرج."}, {"key": "d", "text": "تستمر رغم الدوار."}], "correct": "b"}, {"id": "pc1", "category": "communication", "text": "مريض مسنّ محبط لأن تحسنه بطيء. كيف تتعامل معه؟", "options": [{"key": "a", "text": "تخبره أنه لن يتحسن أبدًا."}, {"key": "b", "text": "تشجعه، وتشرح له التقدم التدريجي بأمثلة واضحة، وتضع أهدافًا صغيرة واقعية."}, {"key": "c", "text": "تتجاهل إحباطه."}, {"key": "d", "text": "تلغي جلساته."}], "correct": "b"}, {"id": "pr1", "category": "resilience", "text": "جلسات تأهيل طويلة وتقدم بطيء والأسرة تضغط عليك. ماذا تفعل؟", "options": [{"key": "a", "text": "تستسلم للضغط وتغيّر الخطة دون أساس."}, {"key": "b", "text": "تشرح للأسرة واقع التقدم بهدوء، وتلتزم بالخطة العلاجية، وتوثق كل جلسة."}, {"key": "c", "text": "تترك المريض دون إخبار."}, {"key": "d", "text": "تختصر الجلسات سرًا."}], "correct": "b"}];
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
شفاء كير تطبيق مستقل للرعاية التمريضية المنزلية في مدينة القصير، محافظة البحر الأحمر. يربط التطبيق بين المرضى (أو أسرهم) ومقدمي رعاية صحية موثّقين (ممرض، مساعد تمريض، طبيب) لزيارات منزلية وفندقية. عقد تقديم الخدمة الطبية يكون بين المريض ومقدم الخدمة مباشرة؛ وشفاء كير وسيط تقني يربط بينهما ويتقاضى عمولته فقط، ولا يقدّم الخدمة الطبية بنفسه. التطبيق ليس مستشفى ولا عيادة، ولا يغني عن الإسعاف أو الطوارئ: في أي حالة طارئة اتصل بالإسعاف 123 فورًا.

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

باستخدامك التطبيق فأنت تقر بأنك قرأت هذه الشروط والأحكام وفهمتها ووافقت عليها بالكامل.`;

const TERMS_EN = `Terms & Conditions — Shifa Care (Version 1.0, 25 November 2026) — summary. The Arabic text is the binding version.

1) Shifa Care is an independent home-nursing platform in El Quseir, Red Sea, connecting patients with verified providers (nurse, nursing assistant, doctor). The medical service contract is between the patient and the provider directly; Shifa Care is a technical intermediary that connects them and takes its commission only, and does not itself provide the medical service. It is not a hospital or clinic. In any emergency call the ambulance on 123 immediately.
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
const LANGUAGE_TEST_TOPICS = ['greeting', 'symptoms', 'procedure', 'allergies', 'aftercare', 'emergency', 'payment'];
const LANGUAGE_TESTS = {
  "en": [
    {
      "id": "en1",
      "topic": "greeting",
      "text": "How do you greet a patient?",
      "options": [
        {
          "key": "a",
          "text": "Hello, I am your nurse."
        },
        {
          "key": "b",
          "text": "Go away."
        },
        {
          "key": "c",
          "text": "Be quiet."
        },
        {
          "key": "d",
          "text": "Pay me now."
        }
      ],
      "correct": "a"
    },
    {
      "id": "en2",
      "topic": "symptoms",
      "text": "The patient says: “I have a strong pain in my leg.” What does that mean?",
      "options": [
        {
          "key": "a",
          "text": "He has strong pain in his leg."
        },
        {
          "key": "b",
          "text": "He is very happy."
        },
        {
          "key": "c",
          "text": "He is hungry."
        },
        {
          "key": "d",
          "text": "He wants to sleep."
        }
      ],
      "correct": "a"
    },
    {
      "id": "en3",
      "topic": "procedure",
      "text": "How do you explain a dressing change?",
      "options": [
        {
          "key": "a",
          "text": "I will change your dressing now. It may hurt a little."
        },
        {
          "key": "b",
          "text": "I am going home now."
        },
        {
          "key": "c",
          "text": "You must pay right now."
        },
        {
          "key": "d",
          "text": "I do not know."
        }
      ],
      "correct": "a"
    },
    {
      "id": "en4",
      "topic": "allergies",
      "text": "How do you ask about allergies?",
      "options": [
        {
          "key": "a",
          "text": "Are you allergic to any medicines?"
        },
        {
          "key": "b",
          "text": "Do you like chocolate?"
        },
        {
          "key": "c",
          "text": "Where do you live?"
        },
        {
          "key": "d",
          "text": "How old are you?"
        }
      ],
      "correct": "a"
    },
    {
      "id": "en5",
      "topic": "aftercare",
      "text": "What do you say after a dressing change?",
      "options": [
        {
          "key": "a",
          "text": "Keep the dressing dry and call us if you have a fever."
        },
        {
          "key": "b",
          "text": "Go swimming."
        },
        {
          "key": "c",
          "text": "Do not eat anything more."
        },
        {
          "key": "d",
          "text": "Never sleep again."
        }
      ],
      "correct": "a"
    },
    {
      "id": "en6",
      "topic": "emergency",
      "text": "The patient suddenly cannot breathe. What do you say?",
      "options": [
        {
          "key": "a",
          "text": "Stay calm, I am calling an ambulance right now."
        },
        {
          "key": "b",
          "text": "Wait until tomorrow."
        },
        {
          "key": "c",
          "text": "Drink water and go."
        },
        {
          "key": "d",
          "text": "That is not important."
        }
      ],
      "correct": "a"
    },
    {
      "id": "en7",
      "topic": "payment",
      "text": "How do you confirm payment and consent?",
      "options": [
        {
          "key": "a",
          "text": "The treatment costs 30 euros. Do you agree?"
        },
        {
          "key": "b",
          "text": "I will take your money."
        },
        {
          "key": "c",
          "text": "Sign here without reading."
        },
        {
          "key": "d",
          "text": "Pay later, maybe."
        }
      ],
      "correct": "a"
    },
    {
      "id": "en8",
      "topic": "symptoms",
      "text": "The patient says: “I feel dizzy.” What does that mean?",
      "options": [
        {
          "key": "a",
          "text": "He feels dizzy."
        },
        {
          "key": "b",
          "text": "He is hungry."
        },
        {
          "key": "c",
          "text": "He is very tired."
        },
        {
          "key": "d",
          "text": "He is happy."
        }
      ],
      "correct": "a"
    }
  ],
  "de": [
    {
      "id": "de1",
      "topic": "greeting",
      "text": "Wie begrüßen Sie einen Patienten?",
      "options": [
        {
          "key": "a",
          "text": "Guten Tag, ich bin Ihre Krankenschwester / Ihr Krankenpfleger."
        },
        {
          "key": "b",
          "text": "Gehen Sie weg."
        },
        {
          "key": "c",
          "text": "Seien Sie still."
        },
        {
          "key": "d",
          "text": "Bezahlen Sie sofort."
        }
      ],
      "correct": "a"
    },
    {
      "id": "de2",
      "topic": "symptoms",
      "text": "Der Patient sagt: „Ich habe starke Schmerzen im Bein.“ Was bedeutet das?",
      "options": [
        {
          "key": "a",
          "text": "Er hat starke Schmerzen im Bein."
        },
        {
          "key": "b",
          "text": "Er ist sehr glücklich."
        },
        {
          "key": "c",
          "text": "Er hat Hunger."
        },
        {
          "key": "d",
          "text": "Er will schlafen."
        }
      ],
      "correct": "a"
    },
    {
      "id": "de3",
      "topic": "procedure",
      "text": "Wie erklären Sie einen Verbandswechsel?",
      "options": [
        {
          "key": "a",
          "text": "Ich wechsle jetzt Ihren Verband. Das kann kurz weh tun."
        },
        {
          "key": "b",
          "text": "Ich gehe jetzt nach Hause."
        },
        {
          "key": "c",
          "text": "Sie müssen sofort bezahlen."
        },
        {
          "key": "d",
          "text": "Ich weiß es nicht."
        }
      ],
      "correct": "a"
    },
    {
      "id": "de4",
      "topic": "allergies",
      "text": "Wie fragen Sie nach Allergien?",
      "options": [
        {
          "key": "a",
          "text": "Haben Sie Allergien gegen Medikamente?"
        },
        {
          "key": "b",
          "text": "Mögen Sie Schokolade?"
        },
        {
          "key": "c",
          "text": "Wo wohnen Sie?"
        },
        {
          "key": "d",
          "text": "Wie alt sind Sie?"
        }
      ],
      "correct": "a"
    },
    {
      "id": "de5",
      "topic": "aftercare",
      "text": "Was sagen Sie nach dem Verbandswechsel?",
      "options": [
        {
          "key": "a",
          "text": "Halten Sie den Verband trocken und rufen Sie uns bei Fieber an."
        },
        {
          "key": "b",
          "text": "Gehen Sie schwimmen."
        },
        {
          "key": "c",
          "text": "Essen Sie nichts mehr."
        },
        {
          "key": "d",
          "text": "Schlafen Sie nie wieder."
        }
      ],
      "correct": "a"
    },
    {
      "id": "de6",
      "topic": "emergency",
      "text": "Der Patient hat plötzlich Atemnot. Was sagen Sie?",
      "options": [
        {
          "key": "a",
          "text": "Bleiben Sie ruhig, ich rufe sofort den Notarzt."
        },
        {
          "key": "b",
          "text": "Warten Sie bis morgen."
        },
        {
          "key": "c",
          "text": "Trinken Sie Wasser und gehen Sie."
        },
        {
          "key": "d",
          "text": "Das ist nicht wichtig."
        }
      ],
      "correct": "a"
    },
    {
      "id": "de7",
      "topic": "payment",
      "text": "Wie bestätigen Sie die Zahlung und die Einwilligung?",
      "options": [
        {
          "key": "a",
          "text": "Die Behandlung kostet 30 Euro. Sind Sie einverstanden?"
        },
        {
          "key": "b",
          "text": "Ich nehme Ihr Geld."
        },
        {
          "key": "c",
          "text": "Unterschreiben Sie hier, ohne zu lesen."
        },
        {
          "key": "d",
          "text": "Bezahlen Sie später, vielleicht."
        }
      ],
      "correct": "a"
    },
    {
      "id": "de8",
      "topic": "symptoms",
      "text": "Der Patient sagt: „Mir ist schwindelig.“ Was bedeutet das?",
      "options": [
        {
          "key": "a",
          "text": "Ihm ist schwindlig."
        },
        {
          "key": "b",
          "text": "Er hat Hunger."
        },
        {
          "key": "c",
          "text": "Er ist sehr müde."
        },
        {
          "key": "d",
          "text": "Er freut sich."
        }
      ],
      "correct": "a"
    }
  ],
  "ru": [
    {
      "id": "ru1",
      "topic": "greeting",
      "text": "Как вы поздороваетесь с пациентом?",
      "options": [
        {
          "key": "a",
          "text": "Здравствуйте, я ваша медсестра / ваш медбрат."
        },
        {
          "key": "b",
          "text": "Уходите."
        },
        {
          "key": "c",
          "text": "Молчите."
        },
        {
          "key": "d",
          "text": "Платите сейчас."
        }
      ],
      "correct": "a"
    },
    {
      "id": "ru2",
      "topic": "symptoms",
      "text": "Пациент говорит: «У меня сильно болит нога». Что это значит?",
      "options": [
        {
          "key": "a",
          "text": "У него сильно болит нога."
        },
        {
          "key": "b",
          "text": "Он очень счастлив."
        },
        {
          "key": "c",
          "text": "Он хочет есть."
        },
        {
          "key": "d",
          "text": "Он хочет спать."
        }
      ],
      "correct": "a"
    },
    {
      "id": "ru3",
      "topic": "procedure",
      "text": "Как объяснить перевязку?",
      "options": [
        {
          "key": "a",
          "text": "Сейчас я сменю вам повязку. Это может немного болеть."
        },
        {
          "key": "b",
          "text": "Я сейчас ухожу домой."
        },
        {
          "key": "c",
          "text": "Платите немедленно."
        },
        {
          "key": "d",
          "text": "Я не знаю."
        }
      ],
      "correct": "a"
    },
    {
      "id": "ru4",
      "topic": "allergies",
      "text": "Как спросить об аллергии?",
      "options": [
        {
          "key": "a",
          "text": "У вас есть аллергия на лекарства?"
        },
        {
          "key": "b",
          "text": "Вы любите шоколад?"
        },
        {
          "key": "c",
          "text": "Где вы живёте?"
        },
        {
          "key": "d",
          "text": "Сколько вам лет?"
        }
      ],
      "correct": "a"
    },
    {
      "id": "ru5",
      "topic": "aftercare",
      "text": "Что сказать после перевязки?",
      "options": [
        {
          "key": "a",
          "text": "Держите повязку сухой и позвоните нам при температуре."
        },
        {
          "key": "b",
          "text": "Идите плавать."
        },
        {
          "key": "c",
          "text": "Больше ничего не ешьте."
        },
        {
          "key": "d",
          "text": "Больше не спите."
        }
      ],
      "correct": "a"
    },
    {
      "id": "ru6",
      "topic": "emergency",
      "text": "У пациента внезапно одышка. Что вы скажете?",
      "options": [
        {
          "key": "a",
          "text": "Спокойно, я сейчас вызову скорую помощь."
        },
        {
          "key": "b",
          "text": "Подождите до завтра."
        },
        {
          "key": "c",
          "text": "Выпейте воды и идите."
        },
        {
          "key": "d",
          "text": "Это неважно."
        }
      ],
      "correct": "a"
    },
    {
      "id": "ru7",
      "topic": "payment",
      "text": "Как подтвердить оплату и согласие?",
      "options": [
        {
          "key": "a",
          "text": "Лечение стоит 30 евро. Вы согласны?"
        },
        {
          "key": "b",
          "text": "Я заберу ваши деньги."
        },
        {
          "key": "c",
          "text": "Подпишите здесь, не читая."
        },
        {
          "key": "d",
          "text": "Заплатите потом, может быть."
        }
      ],
      "correct": "a"
    },
    {
      "id": "ru8",
      "topic": "symptoms",
      "text": "Пациент говорит: «У меня кружится голова». Что это значит?",
      "options": [
        {
          "key": "a",
          "text": "У него кружится голова."
        },
        {
          "key": "b",
          "text": "Он хочет есть."
        },
        {
          "key": "c",
          "text": "Он очень устал."
        },
        {
          "key": "d",
          "text": "Он радуется."
        }
      ],
      "correct": "a"
    }
  ],
  "pl": [
    {
      "id": "pl1",
      "topic": "greeting",
      "text": "Jak przywitasz pacjenta?",
      "options": [
        {
          "key": "a",
          "text": "Dzień dobry, jestem twoją pielęgniarką / twoim pielęgniarzem."
        },
        {
          "key": "b",
          "text": "Idź sobie."
        },
        {
          "key": "c",
          "text": "Bądź cicho."
        },
        {
          "key": "d",
          "text": "Zapłać teraz."
        }
      ],
      "correct": "a"
    },
    {
      "id": "pl2",
      "topic": "symptoms",
      "text": "Pacjent mówi: „Bardzo boli mnie noga”. Co to znaczy?",
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
          "text": "Jest głodny."
        },
        {
          "key": "d",
          "text": "Chce spać."
        }
      ],
      "correct": "a"
    },
    {
      "id": "pl3",
      "topic": "procedure",
      "text": "Jak wyjaśnisz zmianę opatrunku?",
      "options": [
        {
          "key": "a",
          "text": "Teraz zmienię opatrunek. To może chwilę boleć."
        },
        {
          "key": "b",
          "text": "Teraz idę do domu."
        },
        {
          "key": "c",
          "text": "Musisz zapłacić natychmiast."
        },
        {
          "key": "d",
          "text": "Nie wiem."
        }
      ],
      "correct": "a"
    },
    {
      "id": "pl4",
      "topic": "allergies",
      "text": "Jak zapytasz o alergie?",
      "options": [
        {
          "key": "a",
          "text": "Czy ma Pan/Pani alergię na leki?"
        },
        {
          "key": "b",
          "text": "Czy lubisz czekoladę?"
        },
        {
          "key": "c",
          "text": "Gdzie mieszkasz?"
        },
        {
          "key": "d",
          "text": "Ile masz lat?"
        }
      ],
      "correct": "a"
    },
    {
      "id": "pl5",
      "topic": "aftercare",
      "text": "Co powiesz po zmianie opatrunku?",
      "options": [
        {
          "key": "a",
          "text": "Trzymaj opatrunek suchy i zadzwoń do nas, jeśli masz gorączkę."
        },
        {
          "key": "b",
          "text": "Idź popływać."
        },
        {
          "key": "c",
          "text": "Nic więcej nie jedz."
        },
        {
          "key": "d",
          "text": "Nigdy więcej nie śpij."
        }
      ],
      "correct": "a"
    },
    {
      "id": "pl6",
      "topic": "emergency",
      "text": "Pacjent nagle ma duszności. Co powiesz?",
      "options": [
        {
          "key": "a",
          "text": "Proszę się uspokoić, wzywam natychmiast pogotowie."
        },
        {
          "key": "b",
          "text": "Poczekaj do jutra."
        },
        {
          "key": "c",
          "text": "Napij się wody i idź."
        },
        {
          "key": "d",
          "text": "To nieważne."
        }
      ],
      "correct": "a"
    },
    {
      "id": "pl7",
      "topic": "payment",
      "text": "Jak potwierdzisz płatność i zgodę?",
      "options": [
        {
          "key": "a",
          "text": "Leczenie kosztuje 30 euro. Czy się zgadzasz?"
        },
        {
          "key": "b",
          "text": "Wezmę twoje pieniądze."
        },
        {
          "key": "c",
          "text": "Podpisz tutaj bez czytania."
        },
        {
          "key": "d",
          "text": "Zapłać później, może."
        }
      ],
      "correct": "a"
    },
    {
      "id": "pl8",
      "topic": "symptoms",
      "text": "Pacjent mówi: „Kręci mi się w głowie”. Co to znaczy?",
      "options": [
        {
          "key": "a",
          "text": "Kręci mu się w głowie."
        },
        {
          "key": "b",
          "text": "Jest głodny."
        },
        {
          "key": "c",
          "text": "Jest bardzo zmęczony."
        },
        {
          "key": "d",
          "text": "Cieszy się."
        }
      ],
      "correct": "a"
    }
  ],
  "nl": [
    {
      "id": "nl1",
      "topic": "greeting",
      "text": "Hoe begroet u een patiënt?",
      "options": [
        {
          "key": "a",
          "text": "Goedendag, ik ben uw verpleegkundige."
        },
        {
          "key": "b",
          "text": "Ga weg."
        },
        {
          "key": "c",
          "text": "Wees stil."
        },
        {
          "key": "d",
          "text": "Betaal nu."
        }
      ],
      "correct": "a"
    },
    {
      "id": "nl2",
      "topic": "symptoms",
      "text": "De patiënt zegt: „Ik heb veel pijn in mijn been.” Wat betekent dat?",
      "options": [
        {
          "key": "a",
          "text": "Hij heeft veel pijn in zijn been."
        },
        {
          "key": "b",
          "text": "Hij is erg gelukkig."
        },
        {
          "key": "c",
          "text": "Hij heeft honger."
        },
        {
          "key": "d",
          "text": "Hij wil slapen."
        }
      ],
      "correct": "a"
    },
    {
      "id": "nl3",
      "topic": "procedure",
      "text": "Hoe legt u een verbandwissel uit?",
      "options": [
        {
          "key": "a",
          "text": "Ik ga nu uw verband verwisselen. Dat kan even pijn doen."
        },
        {
          "key": "b",
          "text": "Ik ga nu naar huis."
        },
        {
          "key": "c",
          "text": "U moet nu meteen betalen."
        },
        {
          "key": "d",
          "text": "Ik weet het niet."
        }
      ],
      "correct": "a"
    },
    {
      "id": "nl4",
      "topic": "allergies",
      "text": "Hoe vraagt u naar allergieën?",
      "options": [
        {
          "key": "a",
          "text": "Heeft u allergieën voor medicijnen?"
        },
        {
          "key": "b",
          "text": "Houdt u van chocolade?"
        },
        {
          "key": "c",
          "text": "Waar woont u?"
        },
        {
          "key": "d",
          "text": "Hoe oud bent u?"
        }
      ],
      "correct": "a"
    },
    {
      "id": "nl5",
      "topic": "aftercare",
      "text": "Wat zegt u na de verbandwissel?",
      "options": [
        {
          "key": "a",
          "text": "Houd het verband droog en bel ons bij koorts."
        },
        {
          "key": "b",
          "text": "Ga zwemmen."
        },
        {
          "key": "c",
          "text": "Eet niets meer."
        },
        {
          "key": "d",
          "text": "Slaap nooit meer."
        }
      ],
      "correct": "a"
    },
    {
      "id": "nl6",
      "topic": "emergency",
      "text": "De patiënt krijgt plotseling ademnood. Wat zegt u?",
      "options": [
        {
          "key": "a",
          "text": "Blijf rustig, ik bel meteen een ambulance."
        },
        {
          "key": "b",
          "text": "Wacht tot morgen."
        },
        {
          "key": "c",
          "text": "Drink water en ga."
        },
        {
          "key": "d",
          "text": "Dat is niet belangrijk."
        }
      ],
      "correct": "a"
    },
    {
      "id": "nl7",
      "topic": "payment",
      "text": "Hoe bevestigt u betaling en toestemming?",
      "options": [
        {
          "key": "a",
          "text": "De behandeling kost 30 euro. Gaat u akkoord?"
        },
        {
          "key": "b",
          "text": "Ik neem uw geld."
        },
        {
          "key": "c",
          "text": "Teken hier zonder te lezen."
        },
        {
          "key": "d",
          "text": "Betaal later, misschien."
        }
      ],
      "correct": "a"
    },
    {
      "id": "nl8",
      "topic": "symptoms",
      "text": "De patiënt zegt: „Ik ben duizelig.” Wat betekent dat?",
      "options": [
        {
          "key": "a",
          "text": "Hij is duizelig."
        },
        {
          "key": "b",
          "text": "Hij heeft honger."
        },
        {
          "key": "c",
          "text": "Hij is erg moe."
        },
        {
          "key": "d",
          "text": "Hij is blij."
        }
      ],
      "correct": "a"
    }
  ],
  "zh": [
    {
      "id": "zh1",
      "topic": "greeting",
      "text": "你怎么向病人问好？",
      "options": [
        {
          "key": "a",
          "text": "您好，我是您的护士。"
        },
        {
          "key": "b",
          "text": "走开。"
        },
        {
          "key": "c",
          "text": "安静。"
        },
        {
          "key": "d",
          "text": "马上付钱。"
        }
      ],
      "correct": "a"
    },
    {
      "id": "zh2",
      "topic": "symptoms",
      "text": "病人说：“我的腿很疼。”这是什么意思？",
      "options": [
        {
          "key": "a",
          "text": "他的腿很疼。"
        },
        {
          "key": "b",
          "text": "他很开心。"
        },
        {
          "key": "c",
          "text": "他饿了。"
        },
        {
          "key": "d",
          "text": "他想睡觉。"
        }
      ],
      "correct": "a"
    },
    {
      "id": "zh3",
      "topic": "procedure",
      "text": "你怎么解释换药？",
      "options": [
        {
          "key": "a",
          "text": "现在我要给您换药，可能会有点疼。"
        },
        {
          "key": "b",
          "text": "我现在回家。"
        },
        {
          "key": "c",
          "text": "你必须马上付钱。"
        },
        {
          "key": "d",
          "text": "我不知道。"
        }
      ],
      "correct": "a"
    },
    {
      "id": "zh4",
      "topic": "allergies",
      "text": "你怎么问过敏史？",
      "options": [
        {
          "key": "a",
          "text": "您对药物过敏吗？"
        },
        {
          "key": "b",
          "text": "你喜欢巧克力吗？"
        },
        {
          "key": "c",
          "text": "你住在哪里？"
        },
        {
          "key": "d",
          "text": "你多大了？"
        }
      ],
      "correct": "a"
    },
    {
      "id": "zh5",
      "topic": "aftercare",
      "text": "换药后你说什么？",
      "options": [
        {
          "key": "a",
          "text": "请保持敷料干燥，如果发烧请打电话给我们。"
        },
        {
          "key": "b",
          "text": "去游泳吧。"
        },
        {
          "key": "c",
          "text": "不要再吃东西。"
        },
        {
          "key": "d",
          "text": "再也不要睡觉。"
        }
      ],
      "correct": "a"
    },
    {
      "id": "zh6",
      "topic": "emergency",
      "text": "病人突然呼吸困难。你说什么？",
      "options": [
        {
          "key": "a",
          "text": "请冷静，我马上叫救护车。"
        },
        {
          "key": "b",
          "text": "等到明天吧。"
        },
        {
          "key": "c",
          "text": "喝点水然后走吧。"
        },
        {
          "key": "d",
          "text": "这不重要。"
        }
      ],
      "correct": "a"
    },
    {
      "id": "zh7",
      "topic": "payment",
      "text": "你怎么确认付款和同意？",
      "options": [
        {
          "key": "a",
          "text": "治疗费用是30欧元，您同意吗？"
        },
        {
          "key": "b",
          "text": "我拿走你的钱。"
        },
        {
          "key": "c",
          "text": "在这里签字，不要读。"
        },
        {
          "key": "d",
          "text": "以后再付，也许。"
        }
      ],
      "correct": "a"
    },
    {
      "id": "zh8",
      "topic": "symptoms",
      "text": "病人说：“我头晕。”这是什么意思？",
      "options": [
        {
          "key": "a",
          "text": "他头晕。"
        },
        {
          "key": "b",
          "text": "他饿了。"
        },
        {
          "key": "c",
          "text": "他很累。"
        },
        {
          "key": "d",
          "text": "他很高兴。"
        }
      ],
      "correct": "a"
    }
  ],
  "cs": [
    {
      "id": "cs1",
      "topic": "greeting",
      "text": "Jak pozdravíte pacienta?",
      "options": [
        {
          "key": "a",
          "text": "Dobrý den, jsem vaše zdravotní sestra / váš zdravotník."
        },
        {
          "key": "b",
          "text": "Jděte pryč."
        },
        {
          "key": "c",
          "text": "Buďte zticha."
        },
        {
          "key": "d",
          "text": "Zaplaťte hned."
        }
      ],
      "correct": "a"
    },
    {
      "id": "cs2",
      "topic": "symptoms",
      "text": "Pacient říká: „Moc mě bolí noha.” Co to znamená?",
      "options": [
        {
          "key": "a",
          "text": "Moc ho bolí noha."
        },
        {
          "key": "b",
          "text": "Je velmi šťastný."
        },
        {
          "key": "c",
          "text": "Má hlad."
        },
        {
          "key": "d",
          "text": "Chce spát."
        }
      ],
      "correct": "a"
    },
    {
      "id": "cs3",
      "topic": "procedure",
      "text": "Jak vysvětlíte převaz?",
      "options": [
        {
          "key": "a",
          "text": "Teď vám vyměním obvaz. Může to chvíli bolet."
        },
        {
          "key": "b",
          "text": "Teď jdu domů."
        },
        {
          "key": "c",
          "text": "Musíte zaplatit okamžitě."
        },
        {
          "key": "d",
          "text": "Nevím."
        }
      ],
      "correct": "a"
    },
    {
      "id": "cs4",
      "topic": "allergies",
      "text": "Jak se zeptáte na alergie?",
      "options": [
        {
          "key": "a",
          "text": "Máte alergii na nějaké léky?"
        },
        {
          "key": "b",
          "text": "Máte rád čokoládu?"
        },
        {
          "key": "c",
          "text": "Kde bydlíte?"
        },
        {
          "key": "d",
          "text": "Kolik je vám let?"
        }
      ],
      "correct": "a"
    },
    {
      "id": "cs5",
      "topic": "aftercare",
      "text": "Co řeknete po převazu?",
      "options": [
        {
          "key": "a",
          "text": "Udržujte obvaz v suchu a při horečce nám zavolejte."
        },
        {
          "key": "b",
          "text": "Jděte plavat."
        },
        {
          "key": "c",
          "text": "Nic víc nejezte."
        },
        {
          "key": "d",
          "text": "Už nikdy nespěte."
        }
      ],
      "correct": "a"
    },
    {
      "id": "cs6",
      "topic": "emergency",
      "text": "Pacient najednou nemůže dýchat. Co řeknete?",
      "options": [
        {
          "key": "a",
          "text": "Zůstaňte v klidu, hned volám sanitku."
        },
        {
          "key": "b",
          "text": "Počkejte do zítřka."
        },
        {
          "key": "c",
          "text": "Napijte se vody a jděte."
        },
        {
          "key": "d",
          "text": "To není důležité."
        }
      ],
      "correct": "a"
    },
    {
      "id": "cs7",
      "topic": "payment",
      "text": "Jak potvrdíte platbu a souhlas?",
      "options": [
        {
          "key": "a",
          "text": "Ošetření stojí 30 eur. Souhlasíte?"
        },
        {
          "key": "b",
          "text": "Vezmu si vaše peníze."
        },
        {
          "key": "c",
          "text": "Podepište zde, aniž byste četl."
        },
        {
          "key": "d",
          "text": "Zaplaťte později, možná."
        }
      ],
      "correct": "a"
    },
    {
      "id": "cs8",
      "topic": "symptoms",
      "text": "Pacient říká: „Točí se mi hlava.” Co to znamená?",
      "options": [
        {
          "key": "a",
          "text": "Točí se mu hlava."
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
  VOLUME_BONUS_TIERS, WEEKLY_DOUBLE_THRESHOLD, STAY_BONUS_EGP, STAY_BONUS_DAYS, STAY_BONUS_MIN_CASES, POINTS,
  INTERVIEW_DIMENSIONS, INTERVIEW_COMMON, INTERVIEW_ROLE_QUESTIONS,
  HOTELS, MCQ, ENGLISH_CHECK, DANGER_SIGNS,
  TERMS_VERSION, TERMS_UPDATED_AT, TERMS_AR, TERMS_EN,
  DEFAULT_LANGUAGES, LANGUAGE_TESTS, LANGUAGE_TEST_QUESTIONS, LANGUAGE_TEST_PASS_MIN,
  LANGUAGE_TEST_MINUTES, LANGUAGE_TEST_RETAKE_DAYS, LANGUAGE_TEST_TOPICS,
  distanceFee, servicePriceEgp,
};
