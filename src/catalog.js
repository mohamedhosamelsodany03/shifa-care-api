// Server-side constants: services, prices, hotels, MCQ bank, pricing rules.
// NOTHING here is trusted from the client — all amounts are computed server-side.

// ---------------------------------------------------------------- services
// EGP prices (Phase 1, El Quseir). Keys are the only valid serviceCode values.
const SERVICES = {
  standard: { code: 'standard', name_en: 'Standard home visit', name_ar: 'زيارة منزلية قياسية', price_egp: 250 },
  dressing: { code: 'dressing', name_en: 'Wound dressing (single)', name_ar: 'غيار جرح واحد', price_egp: 275, requires_vitals: true, requires_wound_photo: true },
  package7: { code: 'package7', name_en: '7-dressing package', name_ar: 'باقة 7 غيارات', price_egp: 1640 },
  vip: { code: 'vip', name_en: 'Rapid / VIP visit (20–30 min)', name_ar: 'وصول سريع / VIP', price_egp: 350 },
  cannula: { code: 'cannula', name_en: 'Cannula only', name_ar: 'كانيولا فقط', price_egp: 250 },
  cannula_iv: { code: 'cannula_iv', name_en: 'Cannula + IV fluids', name_ar: 'كانيولا + محاليل', price_egp: 350 },
  shift12: { code: 'shift12', name_en: '12-hour shift', name_ar: 'شيفت 12 ساعة', price_egp: 500 },
  shift24: { code: 'shift24', name_en: '24-hour shift', name_ar: 'شيفت 24 ساعة', price_egp: 850 },
  postop: { code: 'postop', name_en: 'Post-operative care', name_ar: 'رعاية ما بعد العمليات', price_egp: 1400 },
  gp: { code: 'gp', name_en: 'GP home visit', name_ar: 'طبيب عام منزلي', price_egp: 500 },
  specialist: { code: 'specialist', name_en: 'Specialist home visit', name_ar: 'أخصائي منزلي', price_egp: 900 },
  video: { code: 'video', name_en: 'Video consultation', name_ar: 'استشارة فيديو', price_egp: 250 },
  // Nursing-assistant price depends on experience (years). Priced by band.
  assistant: { code: 'assistant', name_en: 'Nursing assistant visit', name_ar: 'زيارة مساعد تمريض', price_egp: null, experience_bands: [
    { min_years: 0, max_years: 1.99, price_egp: 165, label: '<2 years' },
    { min_years: 2, max_years: 4.99, price_egp: 205, label: '2–4 years' },
    { min_years: 5, max_years: 9.99, price_egp: 235, label: '5–9 years' },
    { min_years: 10, max_years: 99, price_egp: 260, label: '10+ years' },
  ]},
};

// Tourist services (hotel / foreign-currency). Urgent adds +$20 / +€15.
const TOURIST_SERVICES = {
  tourist_doctor: { code: 'tourist_doctor', name_en: 'Doctor visit to hotel room', name_ar: 'زيارة طبيب لغرفة الفندق', usd: 55, eur: 50 },
  tourist_iv: { code: 'tourist_iv', name_en: 'IV fluids / rehydration', name_ar: 'محاليل وريدية (إرواء)', usd: 75, eur: 65 },
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
const VOLUME_BONUS_TIERS = [
  { minCases: 30, bonusEgp: 500, title: 'محترف موثّق', titleEn: 'Verified Professional' },
  { minCases: 60, bonusEgp: 1000, title: 'الممرض الذهبي', titleEn: 'Golden Nurse' },
  { minCases: 100, bonusEgp: 1500, title: 'النجم المميز', titleEn: 'Star Performer' },
];

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

// ---------------------------------------------------------------- MCQ bank
// Reused from shifa-care-v1.4-plan.md (20 questions), regrouped to the final
// distribution: 5 medical / 5 ethics / 5 personal / 5 psychological resilience.
// `correct` is the key of the right option — NEVER sent to the client.
const MCQ = [
  // --- medical (5) ---
  { id: 'm1', category: 'medical', text: 'قبل تركيب كانيولا، ما أهم خطوة؟', options: [
    { key: 'a', text: 'تركيبها مباشرة.' },
    { key: 'b', text: 'غسل اليدين، وتجهيز الأدوات المعقمة، واختيار الوريد المناسب، والتأكد من هوية المريض.' },
    { key: 'c', text: 'طلب المساعدة من الأسرة.' },
    { key: 'd', text: 'تركيبها بدون قفازات لتوفير الوقت.' }], correct: 'b' },
  { id: 'm2', category: 'medical', text: 'مريض سكري لديه جرح قدم، وتلاحظ رائحة كريهة وإفرازات. ما التصرف الصحيح؟', options: [
    { key: 'a', text: 'تغطي الجرح فقط وتغادر.' },
    { key: 'b', text: 'تقيّم الجرح، وتوثق العلامات، وتبلغ الطبيب/الإدارة فورًا، وتتبع بروتوكول الغيار المعتمد.' },
    { key: 'c', text: 'تضع مرهمًا من عندك دون توثيق.' },
    { key: 'd', text: 'تطلب من المريض الانتظار أسبوعًا.' }], correct: 'b' },
  { id: 'm3', category: 'medical', text: 'أثناء قياس العلامات الحيوية، وجدت ضغط 180/110 ونبض 120. ماذا تفعل؟', options: [
    { key: 'a', text: 'تسجلها فقط وتغادر.' },
    { key: 'b', text: 'تعيد القياس للتأكد، وتسأل عن الأعراض، وتبلغ الطبيب/الإدارة فورًا حسب البروتوكول.' },
    { key: 'c', text: 'تعطي دواء ضغط من عندك.' },
    { key: 'd', text: 'تطمئن المريض بأن كل شيء طبيعي.' }], correct: 'b' },
  { id: 'm4', category: 'medical', text: 'ما أول إجراء عند نزيف خارجي شديد من جرح؟', options: [
    { key: 'a', text: 'تنظيف الجرح أولًا.' },
    { key: 'b', text: 'الضغط المباشر على الجرح لوقف النزيف، وطلب المساعدة الطبية.' },
    { key: 'c', text: 'رفع المريض واقفًا.' },
    { key: 'd', text: 'وضع الثلج فقط.' }], correct: 'b' },
  { id: 'm5', category: 'medical', text: 'في العناية بالجروح بالضغط السلبي (NPWT)، ما أهم نقطة؟', options: [
    { key: 'a', text: 'تغيير الجهاز كل ساعة.' },
    { key: 'b', text: 'التأكد من إحكام الغلق، ومراقبة الإفرازات والضغط، وتوثيق كل تغيير حسب البروتوكول.' },
    { key: 'c', text: 'إيقاف الجهاز ليلًا دون إخبار.' },
    { key: 'd', text: 'استخدام أي ضماد متاح.' }], correct: 'b' },
  // --- ethics (5) ---
  { id: 'e1', category: 'ethics', text: 'مريض يطلب منك أن تخبر أسرته بتشخيصه دون علمه. ماذا تفعل؟', options: [
    { key: 'a', text: 'أخبر الأسرة فورًا لأنهم يدفعون.' },
    { key: 'b', text: 'أرفض وأشرح للمريض حقه في الخصوصية، وأطلب موافقته أولًا.' },
    { key: 'c', text: 'أخبر الأسرة جزئيًا فقط.' },
    { key: 'd', text: 'أتجاهل الطلب ولا أرد.' }], correct: 'b' },
  { id: 'e2', category: 'ethics', text: 'وجدت محفظة مريض في بيته بعد الزيارة. ماذا تفعل؟', options: [
    { key: 'a', text: 'أتركها مكانها وأبلغ المريض والإدارة فورًا.' },
    { key: 'b', text: 'آخذها معي وأعيدها في الزيارة القادمة.' },
    { key: 'c', text: 'أفتحها لأعرف صاحبها.' },
    { key: 'd', text: 'لا أهتم، ليست مسؤوليتي.' }], correct: 'a' },
  { id: 'e3', category: 'ethics', text: 'زميل يطلب منك توقيع تقرير زيارة لم تحضرها. ماذا تفعل؟', options: [
    { key: 'a', text: 'أوقع، لأنها مجاملة بسيطة.' },
    { key: 'b', text: 'أرفض، لأن التوقيع على ما لم تفعله تزوير.' },
    { key: 'c', text: 'أوقع وأكتب ملاحظة صغيرة.' },
    { key: 'd', text: 'أطلب منه مالًا مقابل التوقيع.' }], correct: 'b' },
  { id: 'e4', category: 'ethics', text: 'مريض يعرض عليك مالًا إضافيًا مقابل أولوية في الحجز. ماذا تفعل؟', options: [
    { key: 'a', text: 'أقبله، فهذا حقه.' },
    { key: 'b', text: 'أرفض بلطف وأشرح أن الحجز حسب النظام للجميع.' },
    { key: 'c', text: 'أقبله ولا أخبر أحدًا.' },
    { key: 'd', text: 'أطلب مبلغًا أكبر.' }], correct: 'b' },
  { id: 'e5', category: 'ethics', text: 'أثناء الزيارة، سمعت معلومة صحية حساسة عن المريض من أحد أقاربه. ماذا تفعل؟', options: [
    { key: 'a', text: 'أنشرها في مجموعة العمل.' },
    { key: 'b', text: 'أحتفظ بها سرًا ولا أشاركها إلا مع الفريق الطبي المعني عند الحاجة.' },
    { key: 'c', text: 'أخبر الجيران للاطمئنان.' },
    { key: 'd', text: 'أسجلها في منشور عام.' }], correct: 'b' },
  // --- personal / communication (5) ---
  { id: 'p1', category: 'personal', text: 'مريضة مسنّة قلقة وتبكي قبل الغيار. ما أول خطوة؟', options: [
    { key: 'a', text: 'أبدأ الغيار فورًا لتوفير الوقت.' },
    { key: 'b', text: 'أهدئها، أشرح لها الخطوات ببساطة، وأطلب إذنها قبل البدء.' },
    { key: 'c', text: 'أطلب من أسرتها إخراجها من الغرفة.' },
    { key: 'd', text: 'أتجاهل بكاءها.' }], correct: 'b' },
  { id: 'p2', category: 'personal', text: 'أسرة المريض تتحدث بلهجة وعادات مختلفة عنك، وتسألك أسئلة كثيرة. كيف تتصرف؟', options: [
    { key: 'a', text: 'أتعامل باحترام وأجيب بهدوء، وأتأقلم مع أسلوبهم دون أحكام.' },
    { key: 'b', text: 'أخبرهم أن أسلوبهم غريب.' },
    { key: 'c', text: 'أرفض الإجابة لأنها ليست من عملي.' },
    { key: 'd', text: 'أسخر من لهجتهم.' }], correct: 'a' },
  { id: 'p3', category: 'personal', text: 'مريض لا يفهم المصطلحات الطبية. كيف تشرح له؟', options: [
    { key: 'a', text: 'تستخدم كلمات أبسط وأمثلة من حياته اليومية، وتتأكد من فهمه.' },
    { key: 'b', text: 'تكرر نفس المصطلحات بصوت أعلى.' },
    { key: 'c', text: 'تعطيه ورقة طبية إنجليزية وتتركه.' },
    { key: 'd', text: 'تطلب منه أن يبحث بنفسه.' }], correct: 'a' },
  { id: 'p4', category: 'personal', text: 'أثناء الزيارة، لاحظت أن البيت بسيط جدًا ولا يوجد به تجهيزات. ماذا تفعل؟', options: [
    { key: 'a', text: 'تعلق على فقر البيت.' },
    { key: 'b', text: 'تتعامل باحترام، وتتكيف مع المتاح، وتستخدم أدواتك بأمان دون إحراج الأسرة.' },
    { key: 'c', text: 'ترفض العمل في هذا البيت.' },
    { key: 'd', text: 'تطلب تجهيزات فاخرة قبل البدء.' }], correct: 'b' },
  { id: 'p5', category: 'personal', text: 'بعد انتهاء الزيارة، الأسرة تقدم لك طعامًا أو شرابًا. ماذا تفعل؟', options: [
    { key: 'a', text: 'ترفض بطريقة مهينة.' },
    { key: 'b', text: 'تشكرهم بلطف، وتقبل أو تعتذر بذوق حسب الموقف، دون أن يؤثر ذلك على عملك.' },
    { key: 'c', text: 'تطلب المزيد.' },
    { key: 'd', text: 'تأكل وتتأخر عن زيارتك التالية.' }], correct: 'b' },
  // --- psychological resilience (5) ---
  { id: 'r1', category: 'resilience', text: 'تأخرت عن موعد زيارة منزلية. ما التصرف الصحيح؟', options: [
    { key: 'a', text: 'أذهب متأخرًا دون إخبار أحد.' },
    { key: 'b', text: 'أتصل بالمريض وأعتذر وأبلغه بالوقت الجديد، وأبلغ الإدارة.' },
    { key: 'c', text: 'ألغي الزيارة دون إخبار.' },
    { key: 'd', text: 'أطلب من مريض آخر أن ينتظرك.' }], correct: 'b' },
  { id: 'r2', category: 'resilience', text: 'مريض يرفض إجراءً تمريضيًا ضروريًا بعد شرحه له. ماذا تفعل؟', options: [
    { key: 'a', text: 'أنفذه بالقوة لمصلحته.' },
    { key: 'b', text: 'أحترم رفضه بعد التأكد من فهمه، وأوثق الرفض وأبلغ الطبيب/الإدارة.' },
    { key: 'c', text: 'أتركه دون توثيق.' },
    { key: 'd', text: 'أهدده بوقف الخدمة.' }], correct: 'b' },
  { id: 'r3', category: 'resilience', text: 'مريض غاضب يرفع صوته عليك بسبب تأخير. ماذا تفعل؟', options: [
    { key: 'a', text: 'ترفع صوتك عليه بالمثل.' },
    { key: 'b', text: 'تحافظ على هدوئك، وتستمع، وتعتذر عن التأخير، وتشرح الحل.' },
    { key: 'c', text: 'تترك البيت فورًا.' },
    { key: 'd', text: 'تهدده بإلغاء الخدمة.' }], correct: 'b' },
  { id: 'r4', category: 'resilience', text: 'مريض يسألك عن حالة مريض آخر تعرفه، ويضغط عليك للإجابة. ماذا تفعل؟', options: [
    { key: 'a', text: 'تخبره بكل التفاصيل.' },
    { key: 'b', text: 'تعتذر بلطف وتشرح أن معلومات المرضى سرية، وتبقى ثابتًا رغم الضغط.' },
    { key: 'c', text: 'تخبره جزئيًا.' },
    { key: 'd', text: 'تخبره إذا كان قريبًا.' }], correct: 'b' },
  { id: 'r5', category: 'resilience', text: 'بعد إعطاء دواء وريدي، ظهر طفح جلدي وضيق نفس على المريض. ماذا تفعل؟', options: [
    { key: 'a', text: 'تكمل الدواء.' },
    { key: 'b', text: 'توقف الدواء فورًا، وتقيّم مجرى الهواء والتنفس، وتطلب إسعافًا/طبيبًا فورًا، وتوثق الحدث.' },
    { key: 'c', text: 'تعطي دواءً آخر من عندك.' },
    { key: 'd', text: 'تطلب من المريض الانتظار حتى يتحسن وحده.' }], correct: 'b' },
];

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
شفاء كير تطبيق مستقل للرعاية التمريضية المنزلية في مدينة القصير، محافظة البحر الأحمر. يربط التطبيق بين المرضى (أو أسرهم) ومقدمي رعاية صحية موثّقين (ممرض، مساعد تمريض، طبيب) لزيارات منزلية وفندقية. التطبيق ليس مستشفى ولا عيادة، ولا يغني عن الإسعاف أو الطوارئ: في أي حالة طارئة اتصل بالإسعاف 123 فورًا.

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
- عمولة التطبيق: يأخذ مقدم الخدمة الإجمالي، والتطبيق يأخذ نسبته فقط: Starter 15%، Pro 12%، Elite 8% (معكوسة: كلما تطوّر مقدم الخدمة قلّت عمولته) + بونص حجم شهري نقدي: 500 جنيه عند 30 حالة مكتملة، 1,000 جنيه عند 60 حالة، 1,500 جنيه عند 100 حالة (أعلى شريحة فقط، وليست تراكمية)، يُصرف مع التسوية الأسبوعية. وفي شهور العروض الترويجية (بحد أقصى شهرين في السنة، تُعلن مسبقًا) قد تُخفَّض العمولة أو تُلغى تمامًا (0%)، ويتوقف البونص النقدي مؤقتًا في شهور العمولة صفر بينما تستمر الألقاب. وقسائم ولاء المرضى: بعد كل 4 زيارات مكتملة مدفوعة يحصل المريض تلقائيًا على قسيمة خصم 50 جنيهًا لزيارته التالية (صالحة 60 يومًا، لحد أدنى للحجز 300 جنيه، قسيمة واحدة لكل حجز)، يموّلها التطبيق بالكامل، ويأخذ مقدم الخدمة سعره كاملًا (العمولة تُحسب على السعر الكامل قبل الخصم). نسب العمولات والبونص تفاصيل داخلية لا تظهر في إعلانات المرضى.

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
- شفاء كير وسيط تقني بين العميل ومقدم الخدمة، ويراجع المستندات والشهادات قدر المستطاع، لكن القرار الطبي النهائي لمقدم الخدمة المعالج.
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

1) Shifa Care is an independent home-nursing platform in El Quseir, Red Sea, connecting patients with verified providers (nurse, nursing assistant, doctor). It is not a hospital or clinic. In any emergency call the ambulance on 123 immediately.
2) Register with a real Egyptian phone number and true data. Forged documents mean a permanent ban. Your professional category is set from your certificates with human review.
3) No circumvention: all bookings, payments and communication happen inside the app only. Exchanging personal phone numbers, agreeing visits or prices outside the app, or taking cash outside the app is forbidden. In-app chat closes 24 hours after the visit; messages containing phone numbers are rejected automatically.
4) Fixed published prices, no bargaining. Payment is held in escrow and released to the provider only after completion, patient confirmation and review (or one hour after confirmation with no review and no complaint), and stays held for the 24-hour complaint window before final payout. Weekly settlement every Thursday. App commission (reversed: the more a provider develops, the lower their commission): Starter 15%, Pro 12%, Elite 8% + monthly volume bonus: 500 EGP at 30 completed cases, 1,000 EGP at 60, 1,500 EGP at 100 (highest tier only), paid with the Thursday settlement. In promo months (max 2 per year, announced in advance) the commission may be reduced or set to 0%; cash volume bonuses pause in 0%-commission months while titles continue. Patient loyalty vouchers: after every 4 completed paid visits the patient automatically receives a 50 EGP voucher for the next visit (valid 60 days, minimum booking 300 EGP, one voucher per booking), fully funded by the app; the provider's share is always computed on the full pre-discount price.
5) Respect Charter: full respect both ways, no abuse or threats, keep appointments. Violations mean a warning, then suspension.
6) Cancellation only within 15 minutes of booking creation (full refund). Complaint window: 24 hours after completion; an accepted complaint is refunded in full.
7) Safety and privacy: never photograph or share patient data outside the app. Infection control and vital-signs documentation are mandatory. In emergencies call 123. SOS button alerts admin during dangerous visits.
8) Ratings affect tier and assignment priority. Reviews also ask whether the provider requested dealing outside the app — a "yes" goes to admin immediately and holds that visit's payout.
9) Shifa Care is a technical intermediary; the treating provider holds final clinical responsibility.
10) Graduated penalties: recorded warning, temporary suspension (radar, acceptance and wallet closed), permanent ban with forfeiture of pending settlement for repeated or grave violations. You may appeal to admin within 7 days.
11) Terms may change with in-app notice; continued use means acceptance, and you will be asked to confirm a new version before any new booking or registration.

By using the app you confirm you have read, understood and fully accepted these Terms & Conditions.`;

// Emergency triage danger signs — ANY one rejects a home-visit booking.
const DANGER_SIGNS = [
  'chest_pain', 'breathlessness', 'unconscious', 'severe_bleeding',
  'stroke_signs', 'seizure', 'severe_allergy', 'suicide_risk',
];

module.exports = {
  SERVICES, TOURIST_SERVICES, TOURIST_URGENT_EXTRA, EXTRA_LANGUAGE_BONUS,
  TIERS, VOLUME_BONUS_TIERS, VOUCHER_AMOUNT_EGP, VOUCHER_MIN_BOOKING_EGP,
  VOUCHER_VALID_DAYS, VOUCHER_EVERY_N_VISITS,
  HOTELS, MCQ, ENGLISH_CHECK, DANGER_SIGNS,
  TERMS_VERSION, TERMS_UPDATED_AT, TERMS_AR, TERMS_EN,
  distanceFee, servicePriceEgp,
};
