'use strict';

// Starts the real server on an ephemeral port and asserts the app serves the
// migrated UI, its assets and its health endpoint. Run with: npm test
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const BmiCalc = require(path.join(__dirname, '..', 'public', 'bmi.js'));

const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;

function waitForServer(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.trim()) {
        clearTimeout(timer);
        reject(new Error(text));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
}

function checkBmiMath() {
  // The reported bug: defaults 170 cm / 70 kg must be 24.2, never 0.
  const defaults = BmiCalc.computeBmi(170, 70);
  assert.strictEqual(defaults.ok, true, 'default inputs should be valid');
  assert.strictEqual(defaults.rounded, 24.2, '170 cm / 70 kg must calculate BMI 24.2');
  assert.notStrictEqual(defaults.rounded, 0, 'BMI must never be 0 for valid defaults');
  assert.strictEqual(defaults.category.id, 'healthy');
  assert.strictEqual(defaults.category.label, 'Healthy weight');

  // Category boundaries: [bmi, expected category id]
  const boundaries = [
    [15, 'underweight'],
    [18.4, 'underweight'],
    [18.5, 'healthy'],
    [24.9, 'healthy'],
    [25, 'overweight'],
    [29.9, 'overweight'],
    [30, 'obesity-1'],
    [34.9, 'obesity-1'],
    [35, 'obesity-2'],
    [39.9, 'obesity-2'],
    [40, 'obesity-3'],
    [52, 'obesity-3']
  ];
  boundaries.forEach(([bmi, expected]) => {
    assert.strictEqual(
      BmiCalc.categoryFor(bmi).id,
      expected,
      `BMI ${bmi} should map to category ${expected}`
    );
  });

  // Invalid input is rejected instead of silently producing 0.
  assert.strictEqual(BmiCalc.computeBmi(NaN, 70).ok, false, 'NaN height should be rejected');
  assert.strictEqual(BmiCalc.computeBmi(170, NaN).ok, false, 'NaN weight should be rejected');
  assert.strictEqual(BmiCalc.computeBmi(10, 70).ok, false, 'out-of-range height should be rejected');
  assert.strictEqual(BmiCalc.computeBmi(170, 5).ok, false, 'out-of-range weight should be rejected');

  // Every category must explain itself.
  assert.strictEqual(BmiCalc.CATEGORIES.length, 6, 'six BMI categories expected');
  BmiCalc.CATEGORIES.forEach((category) => {
    assert.ok(category.label, `${category.id} needs a label`);
    assert.ok(category.range, `${category.id} needs a range label`);
    assert.ok(
      typeof category.summary === 'string' && category.summary.length > 40,
      `${category.id} needs a clear explanation`
    );
  });
}

// Every panel shipped by the v8 source must still be present after the migration.
const V8_PANELS = [
  'overview',
  'calendar',
  'content',
  'creator',
  'identity',
  'customers',
  'leads',
  'whatsapp',
  'businessdesk',
  'datahosting',
  'finalqa',
  'compliance',
  'metrics',
  'backup'
];

const PRESERVED_PANELS = ['checkin', 'bmi-guide', 'services'];

async function checkPageMarkup() {
  const res = await fetch(`${BASE}/`);
  assert.strictEqual(res.status, 200, 'GET / should return 200');
  const html = await res.text();

  // Branding requirements.
  assert.ok(html.includes('Sai Health Hub'), 'page should contain the exact business name');
  assert.ok(
    html.includes('Healthy Habits. Better Living..'),
    'page should contain the approved tagline verbatim'
  );
  assert.ok(!/wellness/i.test(html), 'page must not contain the word "Wellness" in any casing');

  // BMI defaults are pre-filled and pre-rendered, so 0 is never shown.
  assert.ok(html.includes('value="170"'), 'height input should default to 170');
  assert.ok(html.includes('value="70"'), 'weight input should default to 70');
  assert.ok(/id="bmi-value"[^>]*>24\.2</.test(html), 'page should render the 24.2 default result');
  assert.ok(
    /id="bmi-category"[^>]*>Healthy weight</.test(html),
    'page should render the default category'
  );
  assert.ok(html.includes('/bmi.js'), 'page should load the BMI module');

  // Migrated v8 panels: a section plus a matching navigation entry for each.
  V8_PANELS.forEach((id) => {
    assert.ok(html.includes(`id="${id}"`), `v8 panel ${id} should be present`);
    assert.ok(html.includes(`data-tab="${id}"`), `navigation should link to ${id}`);
  });

  // Preserved features from the previous release.
  PRESERVED_PANELS.forEach((id) => {
    assert.ok(html.includes(`id="${id}"`), `preserved panel ${id} should be present`);
    assert.ok(html.includes(`data-tab="${id}"`), `navigation should link to ${id}`);
  });

  assert.ok(html.includes('id="checkin-form"'), 'page should contain the check-in form');
  assert.ok(html.includes('id="reset"'), 'page should contain the reset button');

  // Bilingual support and the server-backed storage bridge.
  assert.ok(html.includes('setLanguage') || html.includes('/v8.js'), 'language switching should be loaded');
  assert.ok(html.includes('/v8-bridge.js'), 'page should load the storage bridge');
  assert.ok(html.includes('/panel-health.js'), 'page should load the health panel module');
}

async function checkAssets() {
  const assets = ['/v8.css', '/health.css', '/v8.js', '/v8-bridge.js', '/panel-health.js', '/bmi.js'];
  for (const asset of assets) {
    const res = await fetch(`${BASE}${asset}`);
    assert.strictEqual(res.status, 200, `GET ${asset} should return 200`);
    const body = await res.text();
    assert.ok(!/wellness/i.test(body), `${asset} must not contain the word "Wellness"`);
  }

  // The migrated stylesheet and script must still carry the v8 feature set.
  const v8Js = await (await fetch(`${BASE}/v8.js`)).text();
  ['setLanguage', 'renderPlan', 'renderLeads', 'generateWithAI', 'backupJSON'].forEach((symbol) => {
    assert.ok(v8Js.includes(symbol), `v8.js should still define ${symbol}`);
  });
}

async function checkHealthEndpoints() {
  const healthRes = await fetch(`${BASE}/healthz`);
  assert.strictEqual(healthRes.status, 200, 'GET /healthz should return 200');
  assert.deepStrictEqual(await healthRes.json(), { status: 'ok' });

  // The hosting ingress reserves GET /healthz, so the same payload must also be
  // reachable on these aliases, plus tolerant of trailing slashes and query strings.
  const healthSlash = await fetch(`${BASE}/healthz/`);
  assert.strictEqual(healthSlash.status, 200, 'GET /healthz/ should return 200');

  const apiHealth = await fetch(`${BASE}/api/health`);
  assert.strictEqual(apiHealth.status, 200, 'GET /api/health should return 200');
  assert.deepStrictEqual(await apiHealth.json(), { status: 'ok' });

  const plainHealth = await fetch(`${BASE}/health?check=1`);
  assert.strictEqual(plainHealth.status, 200, 'GET /health with a query should return 200');

  const aiStatus = await fetch(`${BASE}/api/ai/status`);
  assert.strictEqual(aiStatus.status, 200, 'GET /api/ai/status should return 200');
  const aiBody = await aiStatus.json();
  assert.strictEqual(typeof aiBody.configured, 'boolean', 'AI status should report configuration');

  const state = await fetch(`${BASE}/api/state`, { headers: { Accept: 'application/json' } });
  assert.strictEqual(state.status, 200, 'GET /api/state should return 200');
  const stateBody = await state.json();
  assert.strictEqual(stateBody.ok, true);
  assert.strictEqual(typeof stateBody.data, 'object', 'state should return a data object');
}

async function checkServerBehaviour() {
  const versionedAsset = await fetch(`${BASE}/v8.css?v=2`);
  assert.strictEqual(versionedAsset.status, 200, 'a versioned asset request should return 200');

  const missingRes = await fetch(`${BASE}/does-not-exist`);
  assert.strictEqual(missingRes.status, 404, 'unknown paths should return 404');

  const postRes = await fetch(`${BASE}/`, { method: 'POST' });
  assert.strictEqual(postRes.status, 405, 'non-GET methods should return 405');
}

async function main() {
  // Pure logic first: this needs no server.
  checkBmiMath();

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, 10000);

    await checkPageMarkup();
    await checkAssets();
    await checkHealthEndpoints();
    await checkServerBehaviour();

    console.log('smoke test passed');
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('smoke test failed:', err.message);
  process.exit(1);
});
