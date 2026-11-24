'use strict';

// Round-trip tests for the generic app-state endpoint that replaces v8's
// browser-only storage, plus the AI status/generate contracts.
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4321;
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

// A minimal cookie jar so two "browsers" can be told apart.
function newClient() {
  let cookie = '';
  return async function request(pathname, options) {
    const headers = Object.assign({}, (options && options.headers) || {});
    if (cookie) {
      headers.cookie = cookie;
    }
    const response = await fetch(BASE + pathname, Object.assign({}, options, { headers }));
    const setCookie =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (setCookie.length) {
      cookie = setCookie.map((value) => value.split(';')[0]).join('; ');
    }
    return response;
  };
}

function put(request, body, raw) {
  return request('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: raw || JSON.stringify(body)
  });
}

async function checkStateRoundTrip() {
  const alice = newClient();

  const empty = await alice('/api/state', { headers: { Accept: 'application/json' } });
  assert.strictEqual(empty.status, 200, 'GET /api/state should return 200');
  const emptyBody = await empty.json();
  assert.strictEqual(emptyBody.ok, true);
  assert.deepStrictEqual(emptyBody.data, {}, 'a new browser should start with no server data');

  // The v8 collections are stored per browser, not globally.
  const plan = [
    { id: 1, day: 1, topic: 'Morning walk', done: true },
    { id: 2, day: 2, topic: 'Hydration check', done: false }
  ];
  const saved = await put(alice, { key: 'plan', value: plan });
  assert.strictEqual(saved.status, 200, 'PUT /api/state should accept a collection');
  assert.deepStrictEqual(await saved.json(), { ok: true, key: 'plan' });

  const reloaded = await (await alice('/api/state', { headers: { Accept: 'application/json' } })).json();
  assert.deepStrictEqual(reloaded.data.plan, plan, 'saved items must come back unchanged');

  // Language is stored as a scalar, matching v8's shh_language value.
  const langSaved = await put(alice, { key: 'language', value: 'or' });
  assert.strictEqual(langSaved.status, 200, 'PUT language should be accepted');
  const afterLang = await (await alice('/api/state', { headers: { Accept: 'application/json' } })).json();
  assert.strictEqual(afterLang.data.language, 'or', 'language should persist');

  // A second browser must not see the first browser's data.
  const bob = newClient();
  const bobState = await (await bob('/api/state', { headers: { Accept: 'application/json' } })).json();
  assert.strictEqual(bobState.data.plan, undefined, 'state must be scoped per browser');

  // Validation: unknown collections, wrong shapes and oversized payloads.
  const unknown = await put(alice, { key: 'passwords', value: [] });
  assert.strictEqual(unknown.status, 400, 'unknown collections should be rejected');

  const wrongShape = await put(alice, { key: 'leads', value: 'not-an-array' });
  assert.strictEqual(wrongShape.status, 400, 'collections must be arrays');

  // v8 stores a few collections as one object (for example the active creative
  // brief). Those used to throw inside the validator and came back as 400.
  const objectShape = await put(alice, {
    key: 'creative',
    value: { headline: 'Small habits. Better days.', cta: 'Start today', lang: 'en' }
  });
  assert.strictEqual(objectShape.status, 200, 'object-shaped collections should be accepted');
  const afterObject = await (
    await alice('/api/state', { headers: { Accept: 'application/json' } })
  ).json();
  assert.strictEqual(
    afterObject.data.creative.headline,
    'Small habits. Better days.',
    'object state should persist'
  );
  const primitiveShape = await put(alice, { key: 'creative', value: 42 });
  assert.strictEqual(primitiveShape.status, 400, 'primitives should still be rejected');

  const tooMany = await put(alice, { key: 'leads', value: new Array(2001).fill({ id: 1 }) });
  assert.strictEqual(tooMany.status, 400, 'oversized collections should be rejected');

  const hugeItem = await put(alice, { key: 'leads', value: [{ note: 'x'.repeat(500 * 1024) }] });
  assert.strictEqual(hugeItem.status, 400, 'a single oversized record should be rejected');

  const badJson = await put(alice, null, '{not json');
  assert.strictEqual(badJson.status, 400, 'malformed JSON should be rejected');

  const badLanguage = await put(alice, { key: 'language', value: 'english' });
  assert.strictEqual(badLanguage.status, 400, 'language must be a two-letter code');

  const wrongMethod = await alice('/api/state', { method: 'DELETE' });
  assert.strictEqual(wrongMethod.status, 405, 'DELETE /api/state should not be allowed');

  // Stored data must survive being overwritten by a later save of the same key.
  const updated = await put(alice, { key: 'plan', value: [plan[0]] });
  assert.strictEqual(updated.status, 200);
  const finalState = await (await alice('/api/state', { headers: { Accept: 'application/json' } })).json();
  assert.strictEqual(finalState.data.plan.length, 1, 'saving again should replace the collection');
}

async function checkAiContracts() {
  const client = newClient();

  const status = await client('/api/ai/status', { headers: { Accept: 'application/json' } });
  assert.strictEqual(status.status, 200, 'GET /api/ai/status should return 200');
  const statusBody = await status.json();
  assert.strictEqual(statusBody.ok, true);
  assert.strictEqual(typeof statusBody.configured, 'boolean', 'configured must be a boolean');
  assert.strictEqual(
    statusBody.configured,
    true,
    'AI must be usable without a paid key, via the keyless free provider'
  );
  assert.ok(
    ['gemini', 'pollinations'].includes(statusBody.provider),
    'a known AI provider should be selected'
  );
  assert.strictEqual(typeof statusBody.keyless, 'boolean', 'keyless support must be reported');
  assert.ok(statusBody.model, 'the model name should be reported');

  const health = await client('/api/health', { headers: { Accept: 'application/json' } });
  assert.deepStrictEqual(
    await health.json(),
    { status: 'ok' },
    '/api/health stays a plain health probe'
  );

  const notAllowed = await client('/api/generate', { method: 'GET' });
  assert.strictEqual(notAllowed.status, 405, 'GET /api/generate should not be allowed');

  // Guard rails that do not depend on the external provider being reachable.
  // Real generation (and the honest 502 when the provider is down) is covered by
  // test/ai.js, which exercises the provider chain end to end.
  const wrongType = await client('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Accept: 'application/json' },
    body: JSON.stringify({ kind: 'poster', topic: 'Morning walks', brief: 'Short and warm' })
  });
  assert.strictEqual(wrongType.status, 415, 'a non-JSON content type should be refused');
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, 10000);
    await checkStateRoundTrip();
    await checkAiContracts();
    console.log('state test passed');
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('state test failed:', err.message);
  process.exit(1);
});
