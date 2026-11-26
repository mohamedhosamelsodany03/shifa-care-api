// Postgres persistence backend (v2.1.0) — the whole app document in one row.
//
// WHY one row, not relational tables: every route in src/routes.js reads
// and mutates `store.data.*` directly (an in-memory document), and the
// file store has the same shape. A relational migration would rewrite all
// 1,800 lines of routes.js and risk the escrow/anti-leakage logic. The
// document-in-Postgres approach changes ONLY durability: the same JSON
// document that lived in data.json now lives in one Postgres row, so it
// survives redeploys (data.json is wiped on every Railway redeploy).
// The in-memory model, the audit log, the atomic-write semantics and
// every route stay exactly as they are. A future relational migration can
// replace this backend without touching the routes.
//
// Toggle: DATABASE_URL. Unset = file store (current behaviour, local-dev
// fallback). Set = this backend. The Postgres SERVICE itself is created
// in Railway by the owner (New -> Database -> Postgres, then add a
// DATABASE_URL variable to the API service referencing it, e.g.
// ${{Postgres.DATABASE_URL}}); this code only reads the URL.
//
// COST (verified against Railway's pricing, Nov 2026): there is no
// separate database price — a Postgres service bills like any service:
// RAM $10/GB-month, CPU $20/vCPU-month, volume $0.15/GB-month, egress
// $0.05/GB. A small always-on Postgres (0.5 GB RAM, ~0.1 vCPU, 1 GB
// volume) is ~$5 + ~$2 + $0.15 ≈ $7.15/mo of usage. Hobby is $5/mo
// including $5 of usage, and the bill is max($5, total usage); the
// worked example for one small app + Postgres is ~$8.65/mo total.
// The trial (30 days, $5 one-time credit, ends ~22 Dec 2026) does NOT
// cover a permanent database — after the trial a Hobby subscription is
// required to run anything at all, Postgres or not. Enabling Postgres
// burns trial credit faster, so it is OFF until the owner adds
// DATABASE_URL deliberately. Nothing here spends anything by itself.
//
// Migration path: on FIRST boot with DATABASE_URL, if the Postgres row
// does not exist yet and a local data.json exists, the file is imported
// into Postgres once (logged), so no live data is lost in the switch.
// After that, Postgres is the source of truth and the file is ignored
// (writes go to Postgres only). To switch BACK to the file, remove
// DATABASE_URL — the server re-seeds from the file (or an empty seed if
// the file is stale); there is no automatic export back, by design.
const fs = require('fs');

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS shifa_state (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

class PgBackend {
  constructor(connectionString, { dataFile } = {}) {
    // Lazy require so the file-store path never loads `pg`.
    const { Pool } = require('pg');
    this.name = 'postgres';
    this.dataFile = dataFile || null;
    // Railway Postgres requires SSL; rejectUnauthorized:false is the
    // documented setting for Railway's managed certificates.
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 2, // tiny app — two connections are plenty
    });
    // Serial chain: every save waits for the previous one, so a burst of
    // mutations can never persist out of order (each save writes the
    // CURRENT in-memory document at execution time, via getData()).
    this._chain = Promise.resolve();
  }

  async load() {
    await this.pool.query(TABLE_SQL);
    const r = await this.pool.query('SELECT data FROM shifa_state WHERE id = 1');
    if (r.rows.length) {
      console.log('[pgstore] loaded app state from Postgres.');
      return r.rows[0].data;
    }
    // First boot with Postgres: import the local file once, if it exists.
    if (this.dataFile && fs.existsSync(this.dataFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        const bookings = data && data.bookings ? Object.keys(data.bookings).length : 0;
        const providers = data && data.providers ? Object.keys(data.providers).length : 0;
        await this.pool.query(
          'INSERT INTO shifa_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
          [data]
        );
        console.log(`[pgstore] migrated local data.json into Postgres (${providers} providers, ${bookings} bookings) — Postgres is now the source of truth.`);
        return data;
      } catch (e) {
        console.warn('[pgstore] local data.json could not be imported, seeding fresh:', e.message);
      }
    }
    return null; // caller seeds a fresh document (and saves it via save())
  }

  save(getData) {
    this._chain = this._chain
      .then(async () => {
        const data = typeof getData === 'function' ? getData() : getData;
        await this.pool.query(
          `INSERT INTO shifa_state (id, data, updated_at) VALUES (1, $1, now())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [data]
        );
      })
      .catch((e) => {
        // A failed save must never crash the API — the in-memory data is
        // still authoritative for this process; the error is loud in logs.
        console.error('[pgstore] save failed:', e.message);
      });
    return this._chain;
  }

  async close() {
    try { await this.pool.end(); } catch { /* ignore */ }
  }
}

module.exports = { PgBackend };
