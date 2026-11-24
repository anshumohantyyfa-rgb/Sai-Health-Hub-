'use strict';

// Starts the real server on an ephemeral port and asserts the app serves its UI
// and health endpoint. Run with: npm test
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

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

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, 10000);

    const pageRes = await fetch(`${BASE}/`);
    assert.strictEqual(pageRes.status, 200, 'GET / should return 200');
    const html = await pageRes.text();
    assert.ok(html.includes('Sai Health Hub'), 'page should contain the app title');
    assert.ok(html.includes('id="checkin-form"'), 'page should contain the check-in form');

    const cssRes = await fetch(`${BASE}/styles.css`);
    assert.strictEqual(cssRes.status, 200, 'GET /styles.css should return 200');

    const jsRes = await fetch(`${BASE}/app.js`);
    assert.strictEqual(jsRes.status, 200, 'GET /app.js should return 200');

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

    const versionedAsset = await fetch(`${BASE}/styles.css?v=2`);
    assert.strictEqual(versionedAsset.status, 200, 'a versioned asset request should return 200');

    const missingRes = await fetch(`${BASE}/does-not-exist`);
    assert.strictEqual(missingRes.status, 404, 'unknown paths should return 404');

    const postRes = await fetch(`${BASE}/`, { method: 'POST' });
    assert.strictEqual(postRes.status, 405, 'non-GET methods should return 405');

    console.log('smoke test passed');
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('smoke test failed:', err.message);
  process.exit(1);
});
