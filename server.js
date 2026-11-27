// Shifa Care API — Phase 1 core (El Quseir only). Entry point.
const config = require('./src/config');
const { createApp } = require('./src/app');
const { sweepAutoRelease } = require('./src/routes');
const { store } = require('./src/store');

const app = createApp();
let server = null;

// v2.1.0 — Postgres mode loads the document asynchronously; the server
// must not accept requests until the store is ready (file mode resolves
// immediately, so this costs nothing there). /api is additionally gated
// on store.ready inside app.js, so direct createApp() users are safe too.
store.ready.then(() => {
  console.log(`[shifa-care] persistence=${store.persistence}${store.postgresError ? ` (postgres error: ${store.postgresError}; file fallback active)` : ''}`);
  server = app.listen(config.port, () => {
    console.log(`[shifa-care] listening on port ${config.port} (env=${config.nodeEnv}, mockOtp=${config.mockOtp})`);
    console.log('[shifa-care] data file:', config.dataFile);
  });

  // In-process escrow sweep: auto-release patient-confirmed bookings after
  // 1 hour with no review and no complaint; flag visits open >120 minutes.
  // v2.1.0: also sends the 1-hour review reminder, the Thursday
  // settlement notifications, and the unread-critical SMS fallbacks.
  // The sweep is async now — handle its promise; a rejection must never
  // kill the process (the interval keeps running).
  // v2.1.12: log the STACK, not just the message. A bare message
  // ("Cannot read properties of undefined (reading 'length')") fired
  // every 5 minutes on the live server for 50 minutes with no way to
  // tell which line threw — the sweep's transitive closure reads no
  // unguarded .length on any store a fresh seed can produce, so the
  // fault lives in production-only data state. The stack names the
  // exact line on the next occurrence.
  const timer = setInterval(() => {
    sweepAutoRelease()
      .then((r) => {
        if (r.released.length || r.overdue.length || (r.notificationsSent || 0) > 0 || (r.smsSent || 0) > 0) console.log('[sweep]', JSON.stringify(r));
      })
      .catch((e) => console.error('[sweep] error:', e && e.stack ? e.stack : e.message));
  }, config.sweepIntervalMs);
  timer.unref();

  function shutdown() {
    clearInterval(timer);
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
});

module.exports = { app, get server() { return server; } };
