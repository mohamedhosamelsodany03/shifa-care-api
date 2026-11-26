// Postgres backend unit test (v2.1.0) — no live Postgres needed.
// The `pg` module is replaced in the require cache with a fake Pool that
// behaves like one table (shifa_state, one row, id=1) in memory.
// Run:  node test/test-pgstore.js   (also part of npm run test:all)
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${extra}`); }
}

// --- fake pg ---------------------------------------------------------------
const fakeTable = {}; // id -> data (the single shifa_state row)
let poolCount = 0;
class FakePool {
  constructor(opts) {
    this.opts = opts;
    this.ended = false;
    poolCount++;
  }
  async query(sql, params) {
    if (this.ended) throw new Error('pool ended');
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE')) return { rows: [] };
    if (s.startsWith('SELECT data FROM shifa_state')) {
      return fakeTable[1] !== undefined ? { rows: [{ data: fakeTable[1] }] } : { rows: [] };
    }
    if (s.startsWith('INSERT INTO shifa_state')) {
      // Both the migrate-once insert and the upsert save carry the doc
      // as params[0]; the upsert is idempotent, the migrate insert is
      // DO NOTHING on conflict.
      const data = params && params[0];
      if (s.includes('ON CONFLICT (id) DO NOTHING')) {
        if (fakeTable[1] === undefined) fakeTable[1] = data;
      } else {
        fakeTable[1] = data;
      }
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${s.slice(0, 80)}`);
  }
  async end() { this.ended = true; }
}
// Install the fake BEFORE requiring pgstore (its constructor lazy-requires 'pg').
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool } };

const { PgBackend } = require('../src/pgstore');

async function main() {
  // 1. Fresh load: empty table, no data file -> null (caller seeds fresh).
  const b1 = new PgBackend('postgres://fake:5432/db', { dataFile: '/nonexistent/data.json' });
  check('Pool created with ssl rejectUnauthorized:false, max 2',
    b1.pool.opts.ssl && b1.pool.opts.ssl.rejectUnauthorized === false && b1.pool.opts.max === 2,
    JSON.stringify(b1.pool.opts));
  let doc = await b1.load();
  check('empty table + no file -> load() returns null', doc === null, JSON.stringify(doc));

  // 2. Save round-trip: save a doc, a new backend loads it back.
  const docA = { version: 1, providers: { p1: { id: 'p1' } }, bookings: {}, note: 'first' };
  await b1.save(() => docA);
  const b2 = new PgBackend('postgres://fake:5432/db');
  doc = await b2.load();
  check('saved doc loads back identical', doc && doc.note === 'first' && doc.providers.p1.id === 'p1', JSON.stringify(doc));

  // 3. Serialised saves: a burst of saves persists in order (last wins).
  const saves = [];
  for (let i = 0; i < 5; i++) saves.push(b2.save(() => ({ version: i + 2 })));
  await Promise.all(saves);
  const b3 = new PgBackend('postgres://fake:5432/db');
  doc = await b3.load();
  check('5 rapid saves persist in order, last wins (version 6)', doc && doc.version === 6, JSON.stringify(doc));

  // 4. A failed save never throws and never crashes the chain: the next
  // save still lands.
  const b4 = new PgBackend('postgres://fake:5432/db');
  const origQuery = b4.pool.query.bind(b4.pool);
  let failOnce = true;
  b4.pool.query = async (sql, params) => {
    if (failOnce && String(sql).includes('ON CONFLICT (id) DO UPDATE')) { failOnce = false; throw new Error('simulated db outage'); }
    return origQuery(sql, params);
  };
  let threw = false;
  try { await b4.save(() => ({ version: 99 })); } catch { threw = true; }
  check('failing save resolves instead of throwing', threw === false);
  await b4.save(() => ({ version: 100 }));
  const b5 = new PgBackend('postgres://fake:5432/db');
  doc = await b5.load();
  check('save after a failure still lands (version 100)', doc && doc.version === 100, JSON.stringify(doc));

  // 5. First-boot migration: empty table + existing data.json -> the file
  // is imported once and returned; a second backend then loads from PG.
  delete fakeTable[1];
  const tmpFile = path.join(__dirname, 'pgstore-migrate-data.json');
  const fileDoc = { version: 7, providers: { p9: { id: 'p9' } }, bookings: { b9: { id: 'b9' } } };
  fs.writeFileSync(tmpFile, JSON.stringify(fileDoc));
  try {
    const b6 = new PgBackend('postgres://fake:5432/db', { dataFile: tmpFile });
    doc = await b6.load();
    check('first boot migrates data.json into Postgres', doc && doc.version === 7 && doc.bookings.b9.id === 'b9', JSON.stringify(doc));
    const b7 = new PgBackend('postgres://fake:5432/db', { dataFile: tmpFile });
    doc = await b7.load();
    check('second boot loads from Postgres, not the file', doc && doc.version === 7, JSON.stringify(doc));
    // A later file edit must NOT overwrite Postgres (file is ignored now).
    fs.writeFileSync(tmpFile, JSON.stringify({ version: 999 }));
    const b8 = new PgBackend('postgres://fake:5432/db', { dataFile: tmpFile });
    doc = await b8.load();
    check('Postgres stays source of truth after migration (version 7, not 999)', doc && doc.version === 7, JSON.stringify(doc));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  // 6. close() ends the pool.
  const b9 = new PgBackend('postgres://fake:5432/db');
  await b9.close();
  check('close() ends the pool', b9.pool.ended === true);
  check('one Pool per backend instance', poolCount >= 9, `pools=${poolCount}`);

  console.log(`\npgstore: ${pass} passed, ${fail} failed${fail ? ` — ${failures.join('; ')}` : ''}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error('  FAIL uncaught:', e); process.exitCode = 1; });
