// Single JSON file store with atomic writes (write temp file + rename).
// No Postgres/SQLite in Phase 1 — keep it simple and testable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { HOTELS, DEFAULT_LANGUAGES } = require('./catalog');
const { touristCompatible } = require('./points');

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}
// v2.1.1 (M18): salted sha256 for low-entropy identifiers (national ID /
// licence). NEW records store `s:<salt>$<hash>`; old plain-sha256 hashes
// still verify as a fallback so existing records keep working.
function saltedSha256(v) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `s:${salt}$${sha256(`${salt}:${v}`)}`;
}
function matchesSaltedHash(v, stored) {
  if (!stored) return false;
  if (stored.startsWith('s:')) {
    const rest = stored.slice(2);
    const i = rest.indexOf('$');
    if (i < 0) return false;
    const salt = rest.slice(0, i);
    const hash = rest.slice(i + 1);
    return sha256(`${salt}:${v}`) === hash;
  }
  return sha256(v) === stored; // legacy unsalted fallback
}
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}${Date.now().toString(36).slice(-4)}`;
}
function nowIso() { return new Date().toISOString(); }

// Night flag (SPEC §5): 22:00–06:00 local (scheduled time).
function isNight(scheduledAt) {
  if (!scheduledAt) return false;
  const d = new Date(scheduledAt);
  if (!Number.isFinite(d.getTime())) return false;
  const h = d.getHours();
  return h >= 22 || h < 6;
}
function seed() {
  const demoProviders = [
    // v2.1.1 (audit #8): demo providers are seeded PENDING with the
    // interview NOT STARTED — never verified/passed. The DEMO_OTP bypass
    // (routes.js) only works when mockOtp is true, and these accounts
    // cannot take work until they pass the interview + admin verification.
    {
      id: 'prov_demo_starter', demo: true, phone: '01000000001', name: 'Demo Nurse — Starter (تجريبي)',
      role: 'nurse', providerType: 'nurse', tier: 'Starter', status: 'pending',
      nationalIdHash: sha256('00000000000001'), nationalIdLast4: '0001',
      licenseHash: sha256('DEMO-LIC-0001'), licenseLast4: '0001',
      certificates: [], courses: [], languageCertificates: [], extraLanguages: [], verifiedCertificates: 0,
      interviewStatus: 'not_started', interviewScore: null, interviewPoints: 0,
      ratingAvg: null, completedVisits: 0, casesByWeek: {},
      joinedAt: nowIso(),
      createdAt: nowIso(),
    },
    {
      id: 'prov_demo_pro', demo: true, phone: '01000000002', name: 'Demo Nurse — Pro (تجريبي)',
      role: 'nurse', providerType: 'nurse', tier: 'Pro', status: 'pending',
      nationalIdHash: sha256('00000000000002'), nationalIdLast4: '0002',
      licenseHash: sha256('DEMO-LIC-0002'), licenseLast4: '0002',
      certificates: [], courses: [], languageCertificates: [{ language: 'de', certificateName: 'Demo German certificate', verified: false }], extraLanguages: [{ language: 'de', certified: true }],
      verifiedCertificates: 0,
      interviewStatus: 'not_started', interviewScore: null, interviewPoints: 0,
      ratingAvg: null, completedVisits: 0, casesByWeek: {},
      joinedAt: nowIso(),
      createdAt: nowIso(),
    },
  ];
  return {
    version: 1,
    createdAt: nowIso(),
    users: {}, // phone -> { phone, createdAt }
    providers: Object.fromEntries(demoProviders.map((p) => [p.id, p])),
    providersByPhone: { '01000000001': 'prov_demo_starter', '01000000002': 'prov_demo_pro' },
    bookings: {},
    interviews: {}, // providerId -> { attempts: [...] }
    otps: {}, // phone -> { codeHash, expiresAt, attempts, requests: [ts...] }
    phoneLogins: {}, // phone -> { requests: [ts...] } (phone-only login fallback rate limit)
    refreshTokens: {}, // id -> { id, phone, hash, expiresAt, revoked }
    audit: [], // capped at 2000
    sos: [],
    safetyReports: [],
    // v2.0.8 — anti-circumvention: per-booking in-app message threads
    // (bookingId -> [{id, senderRole, text, at}]; no phone numbers stored)
    // and circumvention reports from patient reviews / admin flags.
    messages: {},
    circumventionReports: [],
    // v2.0.9 — reversed commissions + volume bonus + promo months +
    // patient loyalty vouchers (owner decision 26 Nov 2026).
    vouchers: [], // {id, patientPhone, amountEgp, issuedAt, expiresAt, minBookingEgp, status, sourceBookingId, usedBookingId, usedAt}
    promo: null, // {commissionPct, until, setAt, setBy} — live admin override; null = tier rates
    promoMonths: {}, // 'YYYY-MM' -> true — promo months used (max 2 per calendar year)
    // v2.1.4 — launch-month shift offer (owner-approved 26 Nov 2026):
    // {active, until, setAt, setBy}; null = off. When active, single
    // shift12/shift24 bookings pay the provider on the 700/1,200
    // reference price while the patient pays 500/850 (see catalog.js
    // LAUNCH_OFFER_REFERENCE + releaseBooking in routes.js).
    launchOffer: null,
    // v2.1.0 — notifications (in-app center + FCM push + SMS fallback)
    // and the Quseir doctors directory (seeded EMPTY on purpose — the
    // admin adds real doctors with their consent; no fake doctors).
    devices: {}, // phone -> [{token, tokenHash, platform, updatedAt}] — FCM tokens; NEVER returned by any API
    notifications: {}, // phone -> [{id, type, titleAr/titleEn, bodyAr/bodyEn, data, createdAt, validUntil, readAt, pushStatus, smsStatus, critical}]
    // v2.1.7 — client crash / unclean-exit / JS-error reports (see
    // POST /api/client-report) + their per-IP rate-limit buckets.
    clientReports: [], // capped at 200, newest last; tokens/PINs never stored
    clientReportLimits: {}, // ip -> {requests: [ts...]} (10/hour)
    doctors: [], // {id, name, specialty, phone, clinic, address, workingHours, notes, active, createdAt}
    settlementNotifiedOn: null, // 'YYYY-MM-DD' (Africa/Cairo) of the last Thursday-settlement notification pass
    // v2.1.1 — weekly settlement records (audit #5): one per provider per
    // week. Records only — money movement itself needs a bank account.
    settlements: [], // {id, providerId, weekKey, generatedAt, totals{...}}
    // v2.1.1 — medical-file interest (PLACEHOLDER ONLY): count + deduped
    // phones. No medical file, no Pro subscription, no price.
    medicalFileInterest: { count: 0, phones: [], lastAt: null },
    // v2.1.1 — per-IP admin PIN lockout (audit #16).
    adminPinAttempts: {}, // ip -> {failures, lockedUntil}
    // v2.1.1 — patient favourites (patientPhone -> [providerId]).
    favorites: {},
    // v2.1.1 — SOS / safety-report daily counters per booking (M11).
    sosDaily: {}, // 'bookingId:YYYY-MM-DD' -> count
    safetyDaily: {},
    adminPin: {
      // No PIN configured => hash a random value so NO pin can ever match.
      // Admin login is disabled until ADMIN_PIN is set and the service restarts.
      hash: bcrypt.hashSync(
        config.adminPin || crypto.randomBytes(32).toString('hex'),
        10
      ),
      failures: 0,
      lockedUntil: null,
    },
    // v2.1.2 — language list (data-driven; admin can add more),
    // receipt images (bookingId -> {mime, size, data}), and active
    // language-test sessions (providerId:lang -> session). Receipt and
    // document files live in this same file store, so they reset on
    // redeploy like all data — documented in BUILD-STATUS.md.
    languages: DEFAULT_LANGUAGES.map((l) => ({ ...l })),
    receiptImages: {},
    languageTestSessions: {},
    hotels: HOTELS,
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
    // v2.1.0 — persistence backend. File mode loads SYNCHRONOUSLY here
    // (unchanged behaviour: store.data is populated at require time).
    // Postgres mode loads asynchronously; store.ready resolves when the
    // document is loaded (server.js awaits it before listening, and
    // app.js gates /api on it) — store.data is null until then.
    this.backend = null; // PgBackend when DATABASE_URL is set, else null (file)
    this.persistence = 'file';
    this.postgresError = null;
    if (config.postgresConfigured()) {
      this.ready = this._initPostgres();
    } else {
      this.ready = Promise.resolve();
      this.load();
    }
  }
  async _initPostgres() {
    try {
      const { PgBackend } = require('./pgstore');
      const backend = new PgBackend(config.databaseUrl, { dataFile: this.file });
      const data = await backend.load();
      this.backend = backend;
      this.persistence = 'postgres';
      if (data) {
        this.data = data;
        this.applyDefaults();
        this.syncAdminPinFromEnv();
      } else {
        this.data = seed();
        this.applyDefaults();
        this.save();
      }
      console.log('[store] persistence=postgres (DATABASE_URL set).');
    } catch (e) {
      // Availability first: if Postgres cannot be reached, fall back to
      // the file store and say so loudly — the API must stay up, and the
      // failure is visible in logs + the admin persistence endpoint.
      console.error('[store] Postgres init failed, falling back to file store:', e.message);
      this.postgresError = e.message;
      this.backend = null;
      this.persistence = 'file';
      this.load();
    }
  }
  // Collections added after the first seed — default them on load so an
  // older document (file or Postgres row) never breaks the new routes.
  applyDefaults() {
    if (!this.data.messages) this.data.messages = {};
    if (!this.data.circumventionReports) this.data.circumventionReports = [];
    if (!this.data.vouchers) this.data.vouchers = [];
    if (!this.data.promoMonths) this.data.promoMonths = {};
    if (!('promo' in this.data)) this.data.promo = null;
    if (!('launchOffer' in this.data)) this.data.launchOffer = null;
    if (!this.data.devices) this.data.devices = {};
    if (!this.data.notifications) this.data.notifications = {};
    // v2.1.7 — client reports + rate-limit buckets.
    if (!Array.isArray(this.data.clientReports)) this.data.clientReports = [];
    if (!this.data.clientReportLimits) this.data.clientReportLimits = {};
    if (!this.data.doctors) this.data.doctors = [];
    if (!('settlementNotifiedOn' in this.data)) this.data.settlementNotifiedOn = null;
    if (!Array.isArray(this.data.settlements)) this.data.settlements = [];
    // v2.1.6 (C4): reversing settlement adjustments — when a settled
    // booking is refunded (complaint accepted after settlement, or a
    // confirmed circumvention), the refunded shares are recorded here
    // and deducted from the provider's NEXT settlement record.
    // {id, providerId, bookingId, reason, providerShareEgp, appShareEgp,
    //  cash, createdAt, appliedSettlementId}
    if (!Array.isArray(this.data.settlementAdjustments)) this.data.settlementAdjustments = [];
    if (!this.data.medicalFileInterest) this.data.medicalFileInterest = { count: 0, phones: [], lastAt: null };
    if (!this.data.adminPinAttempts) this.data.adminPinAttempts = {};
    if (!this.data.favorites) this.data.favorites = {};
    if (!this.data.sosDaily) this.data.sosDaily = {};
    if (!this.data.safetyDaily) this.data.safetyDaily = {};
    // v2.1.2 — languages, receipt images, language-test sessions.
    if (!Array.isArray(this.data.languages) || !this.data.languages.length) {
      this.data.languages = DEFAULT_LANGUAGES.map((l) => ({ ...l }));
    }
    if (!this.data.receiptImages) this.data.receiptImages = {};
    if (!this.data.languageTestSessions) this.data.languageTestSessions = {};
    // v2.1.3 — monthly package requests + admin launch offer.
    if (!Array.isArray(this.data.packageRequests)) this.data.packageRequests = [];
    if (!('packageOffer' in this.data)) this.data.packageOffer = null;
    // v2.1.1 provider backfill: providerType = role, joinedAt = createdAt,
    // languageCertificates from legacy extraLanguages, empty courses.
    for (const p of Object.values(this.data.providers || {})) {
      if (!p.providerType) p.providerType = (p.role === 'assistant' || p.role === 'nurse' || p.role === 'doctor' || p.role === 'physio') ? p.role : 'nurse';
      if (!p.joinedAt) p.joinedAt = p.createdAt || nowIso();
      if (!Array.isArray(p.courses)) p.courses = [];
      if (!Array.isArray(p.languageCertificates)) {
        p.languageCertificates = Array.isArray(p.extraLanguages)
          ? p.extraLanguages.filter((l) => l && l.language).map((l) => ({ language: String(l.language).toLowerCase(), certificateName: '', verified: l.certified === true }))
          : [];
      }
      if (!p.casesByWeek) p.casesByWeek = {};
      if (p.interviewPoints == null) p.interviewPoints = 0;
      // v2.1.2 — language badges + tests, uploaded documents, CV
      // evaluation, claimed languages. Backfilled from the legacy
      // extraLanguages / languageCertificates lists.
      if (!p.languageBadges || typeof p.languageBadges !== 'object') p.languageBadges = {};
      if (!p.languageTests || typeof p.languageTests !== 'object') p.languageTests = {};
      if (!Array.isArray(p.documents)) p.documents = [];
      if (!('cvEvaluation' in p)) p.cvEvaluation = null;
      if (!Array.isArray(p.claimedLanguages)) {
        const langs = new Set();
        for (const l of p.extraLanguages || []) if (l && l.language) langs.add(String(l.language).toLowerCase());
        for (const l of p.languageCertificates || []) if (l && l.language) langs.add(String(l.language).toLowerCase());
        p.claimedLanguages = [...langs];
      }
    }
  }
  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.applyDefaults();
        this.syncAdminPinFromEnv();
        return;
      }
    } catch (e) {
      console.warn('[store] could not read data file, reseeding:', e.message);
    }
    this.data = seed();
    this.applyDefaults();
    this.save();
  }
  // ADMIN_PIN env var is the source of truth: re-hash it on every boot when
  // it is set and does not match the stored hash. Without this, changing the
  // PIN in the host dashboard never takes effect, because data.json (seeded
  // once, with a random hash when no PIN was set at seed time) is loaded
  // as-is on every restart and redeploy. (Fix deployed 2026-11-25.)
  syncAdminPinFromEnv() {
    if (!config.adminPin) return;
    if (!this.data.adminPin) this.data.adminPin = { hash: '', failures: 0, lockedUntil: null };
    let matches = false;
    try { matches = bcrypt.compareSync(config.adminPin, this.data.adminPin.hash); } catch (e) { matches = false; }
    if (!matches) {
      this.data.adminPin.hash = bcrypt.hashSync(config.adminPin, 10);
      this.data.adminPin.failures = 0;
      this.data.adminPin.lockedUntil = null;
      this.save();
      console.log('[store] admin PIN synced from ADMIN_PIN env var.');
    }
  }
  // Save the current in-memory document.
  // File mode: atomic write (temp file + rename), synchronous as before.
  // Postgres mode: serialised async upsert of the whole document — the
  // backend captures the CURRENT data at execution time, so a burst of
  // saves can never persist out of order. Failures are logged by the
  // backend and never throw here (the in-memory data stays authoritative
  // for this process).
  save() {
    if (this.backend) {
      this.backend.save(() => this.data);
      return;
    }
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
  audit(action, actor, details, ip) {
    this.data.audit.push({ ts: nowIso(), action, actor: actor || 'system', details: details || {}, ip: ip || null });
    if (this.data.audit.length > 2000) this.data.audit = this.data.audit.slice(-2000);
    this.save();
  }
  getProviderByPhone(phone) {
    const id = this.data.providersByPhone[phone];
    return id ? this.data.providers[id] || null : null;
  }
  // Public-safe provider view.
  // v2.0.8 — anti-circumvention: the provider's PHONE is never exposed
  // patient-side. It is included only for admin views (opts.admin) and
  // for the provider themself (opts.self). All contact goes through the
  // in-app message thread; there is no other channel in the product.
  // Also surfaces suspension state + warning count (needed by the
  // provider wallet and the admin dashboard).
  publicProvider(p, opts = {}) {
    if (!p) return null;
    const out = {
      id: p.id, demo: !!p.demo, name: p.name, role: p.role,
      providerType: p.providerType || p.role,
      tier: p.tier, status: p.status, nationalIdLast4: p.nationalIdLast4,
      licenseLast4: p.licenseLast4, certificates: p.certificates || [],
      courses: p.courses || [], languageCertificates: p.languageCertificates || [],
      extraLanguages: p.extraLanguages || [], verifiedCertificates: p.verifiedCertificates || 0,
      interviewStatus: p.interviewStatus, interviewScore: p.interviewScore,
      interviewPoints: p.interviewPoints || 0,
      ratingAvg: p.ratingAvg ?? null, completedVisits: p.completedVisits || 0,
      suspended: !!p.suspended, permanentBan: !!p.permanentBan,
      warningCount: (p.warnings || []).length,
      createdAt: p.createdAt, joinedAt: p.joinedAt || p.createdAt,
      buddyId: p.buddyId || null,
      // v2.1.2 — tourist badge (in-app English test + interview passed)
      // and per-language badges. Computed here from the record; points
      // are attached by the caller when available (opts.points).
      touristCompatible: touristCompatible(p),
      englishBlocked: p.interviewEnglishCorrect === 0 && p.interviewEnglishTotal === 3,
      languageBadges: p.languageBadges || {},
      claimedLanguages: p.claimedLanguages || [],
      // Uploaded documents: metadata only in the public view (name /
      // kind / size — never the file content; the admin reads content
      // via GET /api/admin/providers/:id/documents/:docId).
      documents: (p.documents || []).map((d) => ({ id: d.id, kind: d.kind, name: d.name, size: d.size, mime: d.mime, uploadedAt: d.uploadedAt })),
    };
    if (opts.admin || opts.self) out.cvEvaluation = p.cvEvaluation || null;
    if (opts.points) out.points = opts.points;
    else if (p.points) out.points = p.points;
    if (opts.admin || opts.self) out.phone = p.phone;
    if (opts.admin) out.warnings = p.warnings || [];
    if (opts.admin) out.volumeBonus = p.volumeBonus || null; // v2.0.9 snapshot (wallet recomputes live)
    return out;
  }
  // v2.0.8 — minimal radar item. The radar shows ONLY what a provider
  // needs to decide whether to accept: service, area band, scheduled
  // window and amount. NO patient identity, phone, address, contact,
  // notes, triage, insurer, passport or diagnosis — those are revealed
  // to the ASSIGNED provider only (see publicBooking below).
  radarBooking(b, opts = {}) {
    if (!b) return null;
    const night = isNight(b.scheduledAt);
    return {
      id: b.id, kind: b.kind, serviceCode: b.serviceCode, serviceName: b.serviceName,
      category: b.category || 'nursing', riskLevel: b.riskLevel || 'standard',
      status: b.status, amountEgp: b.amountEgp, distanceKm: b.distanceKm,
      distanceBand: b.distanceBand, scheduledAt: b.scheduledAt, night,
      eliteEarly: !!opts.eliteEarly, preferredForYou: !!opts.preferredForYou,
      createdAt: b.createdAt,
    };
  }
  // Public-safe booking view. Payment number is added ONLY after confirmation.
  // `service`/`total` are aliases the web frontend reads.
  // v2.0.1 — computed, read-only fields:
  //   arrival: provider-approach progress (0–100%) + ETA, from the booking's
  //     distance and acceptedAt. No live GPS in Phase 1: progress is an
  //     estimate (30 km/h average + 5 min prep), capped at 95% until the
  //     provider confirms arrival (provider_confirmed => 100%).
  //   canCancel / cancelDeadline: 15-minute cancellation window from creation.
  //   complaintDeadline / complaintStatus / settleableAt: 24-hour complaint
  //     window (see routes.js — two-stage escrow, documented there).
  publicBooking(b, { includePaymentNumber = false, viewer = null } = {}) {
    if (!b) return null;
    // v2.0.8 — viewer-aware masking (anti-circumvention).
    // A provider who is NOT assigned to this booking sees only the
    // minimal radar view (defense in depth — canSeeBooking already
    // blocks them, but the serializer must never leak PII by itself).
    // Exception: the booking's own patient (who may hold a provider
    // role) always sees their own full booking.
    // The ASSIGNED provider sees the patient phone + address (needed
    // for the visit) but NEVER the alternate contact, insurer or policy
    // number — those are admin-only. Patients see their own booking.
    if (viewer && viewer.role === 'provider' && b.providerId !== viewer.providerId && b.patientPhone !== viewer.phone) {
      // v2.1.3 — a package's SUBSTITUTE provider is also assigned to it
      // (their 4 extra days live on it), so they see the full booking.
      if (!(b.kind === 'package' && b.substituteProviderId === viewer.providerId)) {
        return this.radarBooking(b);
      }
    }
    const out = { ...b, service: b.serviceCode, total: b.amountEgp, night: isNight(b.scheduledAt) };
    if (viewer && viewer.role === 'provider' && b.patientPhone !== viewer.phone) {
      delete out.alternateContact;
      delete out.insurer;
      delete out.policyNo;
    }
    // v2.1.0 — doctor referrals: the doctor's phone is visible to the
    // ASSIGNED provider and admin only — never to the patient
    // (anti-leakage: patients never see doctors' numbers, same rule as
    // provider numbers). The referral itself (name/specialty/time) stays.
    if (Array.isArray(out.referrals) && viewer && viewer.role === 'patient') {
      out.referrals = out.referrals.map((r) => {
        const copy = { ...r };
        delete copy.phone;
        return copy;
      });
    }
    if (includePaymentNumber) out.paymentNumber = config.paymentNumber;
    const now = Date.now();
    out.cancelDeadline = b.createdAt
      ? new Date(new Date(b.createdAt).getTime() + config.cancelWindowMs).toISOString()
      : null;
    out.canCancel = ['held', 'accepted'].includes(b.status)
      && !!out.cancelDeadline && now < new Date(out.cancelDeadline).getTime();
    // v2.1.3 — packages do NOT use the 15-minute window (terms §12):
    // cancel any time before the package completes; the deadline shown is
    // the start date (full refund before it, remaining-days refund after).
    if (b.kind === 'package') {
      out.cancelDeadline = b.startDate ? new Date(b.startDate + 'T00:00:00Z').toISOString() : null;
      out.canCancel = ['held', 'accepted'].includes(b.status);
    }
    out.complaintDeadline = b.complaintDeadline || null;
    out.complaintStatus = b.complaintStatus || null;
    out.settleableAt = b.settleableAt || b.complaintDeadline || null;
    // Arrival progress.
    const km = b.distanceKm ?? 0;
    const etaMin = Math.max(5, Math.ceil((km / 30) * 60) + 5); // 30 km/h + 5 min prep
    let progress = 0, state = 'waiting_assignment', remainingKm = km, etaRemainingMin = etaMin;
    if (['accepted'].includes(b.status) && b.acceptedAt) {
      const elapsedMin = Math.max(0, (now - new Date(b.acceptedAt).getTime()) / 60000);
      progress = Math.min(95, Math.round((elapsedMin / etaMin) * 100));
      state = 'en_route';
      remainingKm = Math.max(0, Math.round(km * (1 - progress / 100) * 10) / 10);
      etaRemainingMin = Math.max(0, Math.ceil(etaMin - elapsedMin));
    } else if (['provider_confirmed', 'patient_confirmed', 'reviewed', 'released', 'auto_released', 'refunded'].includes(b.status)) {
      progress = 100; state = 'arrived'; remainingKm = 0; etaRemainingMin = 0;
    } else if (b.status === 'cancelled') {
      progress = 0; state = 'cancelled'; remainingKm = km; etaRemainingMin = 0;
    }
    out.arrival = { state, progressPct: progress, remainingKm, etaMinutes: etaRemainingMin, totalEtaMinutes: etaMin, distanceKm: km };
    return out;
  }
}

const store = new Store(config.dataFile);
module.exports = { store, sha256, saltedSha256, matchesSaltedHash, newId, nowIso, isNight };
