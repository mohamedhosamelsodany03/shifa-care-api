// v2.1.2 — algorithmic evaluation of a provider's certificates + CV
// (owner decision 26 Nov 2026). The provider uploads real files
// (POST /api/me/documents); this evaluates what the files SAY and
// presents a score breakdown for the admin review queue. It does NOT
// change points by itself and does NOT double-count: verified
// certificates/courses already feed the points system through admin
// verification — the algorithm's job is to evaluate, present, and
// pre-fill what the admin verifies. The ADMIN (Mohamed) makes the
// final approve/reject decision; the recommendation here is advisory.
//
// Scoring (total /100):
//   licence            20 — licence on file (mandatory at registration)
//   syndicate          15 — evidence of syndicate membership in an
//                             uploaded document name (نقابة / syndicate)
//   experience         20 — CV on file (10) + completed cases (10 if
//                             >=10, 5 if 1–9, 0 if none)
//   courses            15 — verified courses, +5 each (mirrors points)
//   specializations    15 — certificate/course/document names matching
//                             service areas (wound/NPWT, catheter,
//                             physio, emergency, IV, elderly), +5 each
//                             matched area (max 3)
//   documents          15 — at least one uploaded document (5) + a CV
//                             file (5) + >=3 documents (5)
// Recommendation: >= 60 + interview passed -> 'approve'; 40–59 or
// interview manual-review -> 'review'; < 40 or interview failed ->
// 'reject'. A missing licence is impossible (registration requires it)
// but is still guarded: no licence -> 'reject'.
const cat = require('./catalog');

const SPECIALIZATION_KEYWORDS = [
  { area: 'wound', label: 'Wound care / dressings', serviceCodes: ['dressing', 'package7'], re: /wound|dress|غيار|جرح/i },
  { area: 'npwt', label: 'NPWT / vacuum dressing', serviceCodes: ['npwt'], re: /npwt|vacuum|فاكيوم|negative pressure/i },
  { area: 'catheter', label: 'Catheter care', serviceCodes: ['catheter_insert', 'catheter_remove', 'catheter_flush'], re: /catheter|قسطرة/i },
  { area: 'physio', label: 'Physiotherapy', serviceCodes: ['physio_general', 'physio_stroke'], re: /physio|physiotherapy|علاج طبيعي/i },
  { area: 'emergency', label: 'Emergency / triage', serviceCodes: ['standard', 'vip'], re: /emergency|triage|طوارئ|فرز|BLS|ACLS|ATLS/i },
  { area: 'iv', label: 'IV therapy / infusions', serviceCodes: ['cannula_iv', 'iv_infusion'], re: /\biv\b|infusion|كانيولا|محاليل|وريد/i },
  { area: 'elderly', label: 'Elderly care', serviceCodes: ['elderly_shift_mobile', 'elderly_shift_bedridden'], re: /elderly|geriatr|مسنين|كبار السن/i },
];

function docNames(p) {
  const names = [];
  for (const c of p.certificates || []) if (c && c.name) names.push(String(c.name));
  for (const c of p.courses || []) if (c && c.name) names.push(String(c.name));
  for (const d of p.documents || []) if (d && d.name) names.push(String(d.name));
  return names;
}

function evaluateProviderDocuments(p) {
  const names = docNames(p);
  const joined = names.join(' | ');
  const verifiedCourses = (p.courses || []).filter((c) => c && c.verified === true).length;
  const verifiedCerts = (p.certificates || []).filter((c) => c && c.verified === true).length;
  const docs = Array.isArray(p.documents) ? p.documents : [];
  const hasCv = docs.some((d) => d.kind === 'cv') || /(\bcv\b|سيرة|السيرة الذاتية)/i.test(joined);
  const hasLicence = !!(p.licenseHash || p.licenseLast4);
  const syndicate = /نقابة|syndicate/i.test(joined);

  const matched = SPECIALIZATION_KEYWORDS.filter((s) => s.re.test(joined));

  const cases = p.completedVisits || 0;
  const experiencePts = (hasCv ? 10 : 0) + (cases >= 10 ? 10 : cases >= 1 ? 5 : 0);
  const documentsPts = (docs.length >= 1 ? 5 : 0) + (hasCv ? 5 : 0) + (docs.length >= 3 ? 5 : 0);

  const breakdown = {
    licence: { points: hasLicence ? 20 : 0, max: 20, note: hasLicence ? 'Licence on file (registration).' : 'No licence on file — registration requires one.' },
    syndicate: { points: syndicate ? 15 : 0, max: 15, note: syndicate ? 'Syndicate membership evidence found in an uploaded document name.' : 'No syndicate membership evidence in uploaded documents.' },
    experience: { points: experiencePts, max: 20, note: `CV on file: ${hasCv ? 'yes' : 'no'}; completed visits: ${cases}. Years of experience are confirmed by the admin from the CV.` },
    courses: { points: Math.min(15, verifiedCourses * 5), max: 15, note: `${verifiedCourses} verified course(s) (+5 each, max 15 — mirrors the points system).` },
    specializations: { points: Math.min(15, matched.length * 5), max: 15, note: matched.length ? `Matched areas: ${matched.map((m) => m.label).join(', ')}.` : 'No specialization keywords matched in certificate / course / document names.' },
    documents: { points: documentsPts, max: 15, note: `${docs.length} uploaded document(s)${hasCv ? ' including a CV' : ' (no CV file yet)'}.` },
  };
  const total = Object.values(breakdown).reduce((s, c) => s + c.points, 0);
  const interview = p.interviewStatus || 'not_started';
  let recommendation;
  let recommendationNote;
  if (!hasLicence || interview === 'failed' || total < 40) {
    recommendation = 'reject';
    recommendationNote = !hasLicence ? 'No licence on file.' : interview === 'failed' ? 'Interview failed.' : 'Evaluation score below 40/100.';
  } else if (total >= 60 && interview === 'passed') {
    recommendation = 'approve';
    recommendationNote = 'Score 60+ and interview passed — documents support approval.';
  } else {
    recommendation = 'review';
    recommendationNote = interview === 'manual-review' ? 'Interview is in manual review — admin decides.' : 'Score 40–59 — admin review needed before a decision.';
  }
  return {
    total, max: 100, breakdown,
    matchedSpecializations: matched.map((m) => ({ area: m.area, label: m.label, serviceCodes: m.serviceCodes })),
    verifiedCertificates: verifiedCerts, verifiedCourses,
    documentsCount: docs.length, hasCv,
    interviewStatus: interview,
    recommendation, recommendationNote,
    evaluatedAt: new Date().toISOString(),
  };
}

module.exports = { evaluateProviderDocuments, SPECIALIZATION_KEYWORDS };
