// Shifa Care API — Phase 1 core (El Quseir only). Entry point.
const config = require('./src/config');
const { createApp } = require('./src/app');
const { sweepAutoRelease } = require('./src/routes');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[shifa-care] listening on port ${config.port} (env=${config.nodeEnv}, mockOtp=${config.mockOtp})`);
  console.log('[shifa-care] data file:', config.dataFile);
});

// In-process escrow sweep: auto-release patient-confirmed bookings after
// 1 hour with no review and no complaint; flag visits open >120 minutes.
const timer = setInterval(() => {
  try {
    const r = sweepAutoRelease();
    if (r.released.length || r.overdue.length) console.log('[sweep]', JSON.stringify(r));
  } catch (e) {
    console.error('[sweep] error:', e.message);
  }
}, config.sweepIntervalMs);
timer.unref();

function shutdown() {
  clearInterval(timer);
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server };
