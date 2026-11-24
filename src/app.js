// Express app factory (kept separate from server.js so tests can start it
// on any port without side effects).
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { router } = require('./routes');

function createApp() {
  const app = express();
  app.disable('x-powered-by');

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
  app.use(express.json({ limit: '200kb' }));

  // CORS allowlist only — never '*'.
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // non-browser clients (curl, tests)
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS origin not allowed'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // Rate limits.
  const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many OTP requests from this IP.' } });
  const phoneLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many login attempts from this IP.' } });
  const pinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many PIN attempts from this IP.' } });
  const bookingLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many booking requests from this IP.' } });
  app.use('/api/otp/request', otpLimiter);
  app.use('/api/auth/login-phone', phoneLoginLimiter);
  app.use('/api/admin/pin/verify', pinLimiter);
  app.use('/api/bookings', bookingLimiter);
  app.use('/api/tourist-bookings', bookingLimiter);

  app.get('/health', (req, res) => res.json({ ok: true, app: 'shifa-care', version: '1.0.0', city: 'El Quseir' }));
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
