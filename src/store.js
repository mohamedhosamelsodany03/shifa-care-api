// Single JSON file store with atomic writes (write temp file + rename).
// No Postgres/SQLite in Phase 1 — keep it simple and testable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { HOTELS } = require('./catalog');

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}${Date.now().toString(36).slice(-4)}`;
}
function nowIso() { return new Date().toISOString(); }

function seed() {
  const demoProviders = [
    {
      id: 'prov_demo_starter', demo: true, phone: '01000000001', name: 'Demo Nurse — Starter (تجريبي)',
      role: 'nurse', tier: 'Starter', status: 'verified',
      nationalIdHash: sha256('00000000000001'), nationalIdLast4: '0001',
      licenseHash: sha256('DEMO-LIC-0001'), licenseLast4: '0001',
      certificates: [], extraLanguages: [], verifiedCertificates: 0,
      interviewStatus: 'passed', interviewScore: null, ratingAvg: 4.8, completedVisits: 12,
      createdAt: nowIso(),
    },
    {
      id: 'prov_demo_pro', demo: true, phone: '01000000002', name: 'Demo Nurse — Pro (تجريبي)',
      role: 'nurse', tier: 'Pro', status: 'verified',
      nationalIdHash: sha256('00000000000002'), nationalIdLast4: '0002',
      licenseHash: sha256('DEMO-LIC-0002'), licenseLast4: '0002',
      certificates: [], extraLanguages: [{ language: 'de', certified: true }],
      verifiedCertificates: 1,
      interviewStatus: 'passed', interviewScore: null, ratingAvg: 4.9, completedVisits: 47,
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
    hotels: HOTELS,
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.load();
  }
  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        // v2.0.8: collections added after the first seed — default them
        // on load so an older data.json never breaks the new routes.
        if (!this.data.messages) this.data.messages = {};
        if (!this.data.circumventionReports) this.data.circumventionReports = [];
        if (!this.data.vouchers) this.data.vouchers = [];
        if (!this.data.promoMonths) this.data.promoMonths = {};
        if (!('promo' in this.data)) this.data.promo = null;
        this.syncAdminPinFromEnv();
        return;
      }
    } catch (e) {
      console.warn('[store] could not read data file, reseeding:', e.message);
    }
    this.data = seed();
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
  // Atomic: write to temp file in same dir, then rename over the real file.
  save() {
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
      tier: p.tier, status: p.status, nationalIdLast4: p.nationalIdLast4,
      licenseLast4: p.licenseLast4, certificates: p.certificates || [],
      extraLanguages: p.extraLanguages || [], verifiedCertificates: p.verifiedCertificates || 0,
      interviewStatus: p.interviewStatus, interviewScore: p.interviewScore,
      ratingAvg: p.ratingAvg ?? null, completedVisits: p.completedVisits || 0,
      suspended: !!p.suspended, permanentBan: !!p.permanentBan,
      warningCount: (p.warnings || []).length,
      createdAt: p.createdAt,
    };
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
  radarBooking(b) {
    if (!b) return null;
    return {
      id: b.id, kind: b.kind, serviceCode: b.serviceCode, serviceName: b.serviceName,
      status: b.status, amountEgp: b.amountEgp, distanceKm: b.distanceKm,
      distanceBand: b.distanceBand, scheduledAt: b.scheduledAt,
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
      return this.radarBooking(b);
    }
    const out = { ...b, service: b.serviceCode, total: b.amountEgp };
    if (viewer && viewer.role === 'provider' && b.patientPhone !== viewer.phone) {
      delete out.alternateContact;
      delete out.insurer;
      delete out.policyNo;
    }
    if (includePaymentNumber) out.paymentNumber = config.paymentNumber;
    const now = Date.now();
    out.cancelDeadline = b.createdAt
      ? new Date(new Date(b.createdAt).getTime() + config.cancelWindowMs).toISOString()
      : null;
    out.canCancel = ['held', 'accepted'].includes(b.status)
      && !!out.cancelDeadline && now < new Date(out.cancelDeadline).getTime();
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
module.exports = { store, sha256, newId, nowIso };
