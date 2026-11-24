'use strict';

/*
 * Phase 1 persistence test.
 *
 * Proves, without any real Supabase account, that the Supabase driver:
 *   1. activates when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are present,
 *   2. sends the service-role key only as a server-side HTTP header,
 *   3. writes check-ins and app state through to the remote tables,
 *   4. re-hydrates those records in a NEW process (a simulated redeploy),
 *   5. falls back to local storage (and says so) when the remote is unreachable.
 *
 * The remote is a small PostgREST-compatible fake; it verifies our own driver
 * contract. It does not prove anything about a real Supabase project.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ROWS = { checkins: new Map(), app_state: new Map() };
let seenKey = null;
let seenAuth = null;

function send(res, status, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function parseQuery(url) {
  const out = {};
  new URL(url, 'http://localhost').searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function startFakePostgrest() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const query = parseQuery(req.url);
      const table = String(req.url).split('?')[0].replace('/rest/v1/', '');
      seenKey = req.headers.apikey || seenKey;
      seenAuth = req.headers.authorization || seenAuth;

      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        if (table === 'checkins') {
          if (req.method === 'GET') {
            const rows = Array.from(ROWS.checkins.values()).sort((a, b) =>
              a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
            );
            send(res, 200, rows);
            return;
          }
          if (req.method === 'POST') {
            JSON.parse(raw || '[]').forEach((row) => {
              ROWS.checkins.set(row.id, row);
            });
            send(res, 201);
            return;
          }
          if (req.method === 'DELETE') {
            const id = (query.id || '').replace(/^eq\./, '');
            const clientId = (query.client_id || '').replace(/^eq\./, '');
            const row = ROWS.checkins.get(id);
            if (row && (!clientId || row.client_id === clientId)) {
              ROWS.checkins.delete(id);
            }
            send(res, 204);
            return;
          }
        }

        if (table === 'app_state') {
          if (req.method === 'GET') {
            send(res, 200, Array.from(ROWS.app_state.values()));
            return;
          }
          if (req.method === 'POST') {
            JSON.parse(raw || '[]').forEach((row) => {
              ROWS.app_state.set(`${row.client_id}::${row.key}`, row);
            });
            send(res, 201);
            return;
          }
        }

        send(res, 404, { message: `unhandled ${req.method} ${req.url}` });
      });
    });
    // Ephemeral test fixture: let the OS pick a free port. No host pin, so the
    // production server's 0.0.0.0 bind is the only fixed listener in this repo.
    server.listen(0, () => resolve(server));
  });
}

function freshStoreModule() {
  delete require.cache[require.resolve('../lib/store.js')];
  return require('../lib/store.js');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-supabase-'));
  const server = await startFakePostgrest();
  const port = server.address().port;

  process.env.DATA_DIR = tmp;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

  // --- 1. driver activates and reports durability -------------------------
  let mod = freshStoreModule();
  let store = mod.createStore();
  await store.ready;
  assert.strictEqual(store.kind, 'supabase', 'Supabase driver should be active');
  let info = store.info();
  assert.strictEqual(info.survivesRedeploy, true, 'Supabase must report redeploy durability');
  assert.strictEqual(info.supabaseActive, true, 'Supabase should be active after hydration');
  assert.strictEqual(info.records, 0, 'fresh remote starts empty');

  // --- 2. key handling: server-side header only --------------------------
  assert.strictEqual(seenKey, 'test-service-role-key', 'apikey header must carry the service key');
  assert.strictEqual(
    seenAuth,
    'Bearer test-service-role-key',
    'Authorization header must carry the service key'
  );

  // --- 3. write-through ---------------------------------------------------
  const record = mod.newRecord({
    clientId: 'client-a',
    heightCm: 170,
    weightKg: 70,
    bmi: 24.2,
    categoryId: 'healthy',
    categoryLabel: 'Healthy weight',
    note: 'phase1',
    lang: 'en'
  });
  store.add(record);
  store.stateSet(
    'client-a',
    'customers',
    JSON.stringify([{ id: 'c1', name: 'Test Customer', birthday: '1990-04-02' }])
  );
  store.stateSet('client-a', 'followups', JSON.stringify([{ id: 'f1', due: '2026-12-01' }]));
  await store.flush();

  assert.strictEqual(ROWS.checkins.size, 1, 'check-in should reach the remote table');
  assert.strictEqual(ROWS.app_state.size, 2, 'both collections should reach the remote table');
  const remoteRow = Array.from(ROWS.checkins.values())[0];
  assert.strictEqual(remoteRow.bmi, 24.2, 'remote row keeps the computed BMI');
  assert.strictEqual(remoteRow.client_id, 'client-a', 'remote row keeps the client scope');

  // --- 4. simulated redeploy: new process, same remote --------------------
  mod = freshStoreModule();
  store = mod.createStore();
  await store.ready;
  assert.strictEqual(store.kind, 'supabase', 'second boot should also use Supabase');
  const reloaded = store.list('client-a', 10);
  assert.strictEqual(reloaded.length, 1, 'check-in must survive the restart');
  assert.strictEqual(reloaded[0].bmi, 24.2, 'reloaded check-in keeps its BMI');
  const state = store.stateAll('client-a');
  assert.ok(state.customers, 'customers collection must survive the restart');
  assert.strictEqual(
    JSON.parse(state.customers)[0].name,
    'Test Customer',
    'customer payload must be intact after restart'
  );
  assert.ok(state.followups, 'follow-ups collection must survive the restart');

  // --- 5. backup export covers everything ---------------------------------
  const exported = store.exportAll();
  assert.strictEqual(exported.checkins.length, 1, 'export must include check-ins');
  assert.ok(
    exported.state.some((row) => row.key === 'customers'),
    'export must include app state'
  );
  assert.strictEqual(store.info().survivesRedeploy, true, 'exporting does not change durability');

  // --- 6. unreachable remote falls back honestly --------------------------
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  mod = freshStoreModule();
  const fallback = mod.createStore();
  await fallback.ready;
  assert.notStrictEqual(fallback.kind, 'supabase', 'unreachable remote must not be reported as active');
  const fallbackInfo = fallback.info();
  assert.strictEqual(fallbackInfo.supabaseActive, false, 'fallback must report the remote as inactive');
  assert.ok(fallbackInfo.fallbackReason, 'fallback must explain why the remote was not used');
  assert.strictEqual(fallbackInfo.survivesRedeploy, false, 'local fallback must not claim durability');

  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Supabase store: PASS (activation, key handling, write-through, restart survival, export, fallback)');
}

main().catch((error) => {
  console.error('Supabase store: FAIL');
  console.error(error);
  process.exit(1);
});
