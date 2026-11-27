// Express app factory (kept separate from server.js so tests can start it
// on any port without side effects).
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { router } = require('./routes');
const { store } = require('./store');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // v2.1.1 (audit #14): behind Railway's proxy, req.ip must be the real
  // client IP — otherwise every user shares one rate-limit bucket and
  // audit IPs are wrong. Trust ONE proxy hop only.
  app.set('trust proxy', 1);

  // Compatibility rewrites: the web frontend uses a few legacy path names.
  // They are rewritten to the canonical server paths BEFORE rate limiters
  // and routing, so limits and auth apply exactly as for the canonical paths.
  app.use((req, res, next) => {
    const rewrites = [
      [/^\/api\/auth\/otp\/request$/, '/api/otp/request'],
      [/^\/api\/auth\/otp\/verify$/, '/api/otp/verify'],
      [/^\/api\/admin\/login$/, '/api/admin/pin/verify'],
      [/^\/api\/admin\/audit-log$/, '/api/admin/audit'],
      [/^\/api\/bookings\/([^/]+)\/patient-confirm$/, '/api/bookings/$1/confirm-patient'],
      [/^\/api\/bookings\/([^/]+)\/provider-complete$/, '/api/bookings/$1/complete-provider'],
    ];
    for (const [re, to] of rewrites) {
      if (re.test(req.url)) { req.url = req.url.replace(re, to); break; }
    }
    next();
  });

  app.use(helmet({
    // HSTS: HTTPS only in production.
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    contentSecurityPolicy: false, // JSON API only
  }));
  // v2.1.2: 10 MB — document uploads (max 5 MB/file) and receipt
  // photos (max 3 MB) are base64 data URLs in JSON, so the old 200 KB
  // limit would reject every upload. No other body grows: booking
  // payloads stay small and length caps still apply (routes.js M11).
  app.use(express.json({ limit: '10mb' }));

  // CORS (audit #9): '*' NO LONGER means any origin. A configured '*'
  // is treated as the app-origin set only (the Capacitor app origin is
  // https://localhost — androidScheme defaults to https — plus
  // http://localhost) and logs a boot warning. Allowed: the configured
  // list + https://localhost + http://localhost + capacitor://localhost
  // + ionic://localhost.
  // HOTFIX 2026-11-26: https://localhost was missing — every request
  // from the installed app got 403 at the CORS middleware (before any
  // handler/audit), so the app showed offline + "wrong PIN" and no
  // attempt ever appeared in the audit log, while curl/Chrome worked.
  const APP_ORIGINS = ['https://localhost', 'http://localhost', 'capacitor://localhost', 'ionic://localhost'];
  if (config.corsOrigins.includes('*')) {
    console.warn('[WARN] CORS_ORIGIN contains "*" — treated as the app-origin set only (http://localhost, capacitor://localhost, ionic://localhost), NOT any origin.');
  }
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // non-browser clients (curl, tests)
      if (config.corsOrigins.includes(origin) || APP_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error('CORS origin not allowed'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Monitor-Token'],
  }));

  // Rate limits.
  // v2.1.13 — the full suites make far more auth/interview calls from
  // one IP than any real user (dozens of logins/registrations/interviews
  // per run); in NODE_ENV=test only, raise the IP caps. Production
  // values are unchanged, and the per-phone caps in routes.js still
  // apply (those are what the tests assert).
  const TEST_ENV = process.env.NODE_ENV === 'test';
  const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many OTP requests from this IP.' } });
  // v2.1.0 — verify attempts are rate-limited per IP as well as per
  // phone (the per-phone 5-attempt cap lives in /otp/verify itself).
  const otpVerifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many OTP verification attempts from this IP.' } });
  const phoneLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: TEST_ENV ? 500 : 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many login attempts from this IP.' } });
  const pinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many PIN attempts from this IP.' } });
  // BOOKING_LIMIT_MAX is test-only (smoke/integration raise it so one
  // run's many booking calls don't trip the limiter); production default 60.
  const bookingLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.BOOKING_LIMIT_MAX) || 60, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many booking requests from this IP.' } });
  const genericLimiter = (max, msg) => rateLimit({ windowMs: 15 * 60 * 1000, max, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: msg } });
  app.use('/api/otp/request', otpLimiter);
  app.use('/api/otp/verify', otpVerifyLimiter);
  app.use('/api/auth/login-phone', phoneLoginLimiter);
  // v2.1.8 — password gate: the register + set-password endpoints get a
  // light per-IP limit (the per-phone caps live in routes.js). The admin
  // password-reset is behind the admin JWT already.
  app.use('/api/auth/register', genericLimiter(20, 'Too many registration attempts from this IP.'));
  app.use('/api/auth/set-password', genericLimiter(20, 'Too many password changes from this IP.'));
  app.use('/api/auth/refresh', genericLimiter(30, 'Too many token refresh attempts from this IP.'));
  app.use('/api/auth/logout', genericLimiter(30, 'Too many logout attempts from this IP.'));
  app.use('/api/admin/pin/verify', pinLimiter);
  app.use('/api/bookings', bookingLimiter);
  app.use('/api/tourist-bookings', bookingLimiter);
  app.use('/api/npwt/bookings', bookingLimiter);
  // v2.1.1 (audit #27): limiters for the remaining sensitive endpoints.
  app.use('/api/providers/register', genericLimiter(TEST_ENV ? 500 : 10, 'Too many provider registrations from this IP.'));
  app.use('/api/providers/interview', genericLimiter(TEST_ENV ? 500 : 30, 'Too many interview requests from this IP.'));
  app.use('/api/postop', genericLimiter(60, 'Too many post-op booking requests from this IP.'));
  app.use('/api/npwt/calculate', genericLimiter(60, 'Too many NPWT calculations from this IP.'));
  app.use('/api/monitor/summary', rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many monitor requests from this IP.' } }));
  app.use('/api/medical-file-interest', rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many interest submissions from this IP.' } }));
  app.use('/api/admin/export', genericLimiter(5, 'Too many export requests from this IP.'));
  // v2.1.2: language tests + document uploads. Receipt uploads ride
  // the existing /api/bookings limiter above (60/hour).
  app.use('/api/me/language-tests', genericLimiter(30, 'Too many language-test requests from this IP.'));
  app.use('/api/me/documents', genericLimiter(20, 'Too many document uploads from this IP.'));

  app.get('/health', (req, res) => res.json({ ok: true, app: 'shifa-care', version: '1.0.0', city: 'El Quseir' }));
  // v2.1.0 — Postgres mode loads the document asynchronously; no /api
  // request may run before the store is ready (file mode resolves
  // immediately). /health above stays ungated on purpose.
  app.use('/api', async (req, res, next) => {
    try { await store.ready; next(); } catch (e) { next(e); }
  });
  app.use('/api', router);

  // 404 + error handler — never leak stack traces in production.
  app.use((req, res) => res.status(404).json({ error: 'not_found', message: 'Route not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.message === 'CORS origin not allowed') {
      return res.status(403).json({ error: 'forbidden', message: 'CORS origin not allowed.' });
    }
    console.error('[error]', err && err.message);
    res.status(500).json({ error: 'internal', message: config.isProd ? 'Internal error.' : (err && err.message) });
  });
  return app;
}

module.exports = { createApp };
