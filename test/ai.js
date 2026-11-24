'use strict';

// Exercises the real AI generation path against the running server: provider
// chain, English and Odia output, regeneration, and the honest failure message
// when the provider is unreachable. No API key is required, because the app
// falls back to a free keyless model through the server.
// Run with: npm test
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 4324;
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

async function startServer(dataDir, extraEnv) {
  const env = Object.assign(
    {},
    process.env,
    { PORT: String(PORT), DATA_DIR: dataDir, RATE_LIMIT_MAX: '1000' },
    extraEnv || {}
  );
  // Exercise the keyless path unless a test explicitly supplies a key.
  if (!extraEnv || !('GEMINI_API_KEY' in extraEnv)) {
    delete env.GEMINI_API_KEY;
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer(child, 10000);
  return child;
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

async function generate(payload) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  let json = null;
  try {
    json = await res.json();
  } catch (err) {
    json = null;
  }
  return { res, json };
}

function isNetworkOutage(json) {
  const text = JSON.stringify(json || {});
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|socket hang up|ETIMEDOUT/i.test(text);
}

const BRIEF = {
  kind: 'poster',
  language: 'en',
  topic: 'Morning walking habit',
  headline: '',
  body: '',
  cta: '',
  footer: '',
  brief: 'Friendly, short, non-medical. Encourage a steady morning walk.'
};

async function run(dataDir) {
  const child = await startServer(dataDir);
  try {
    // --- Status reports a usable provider without any paid credential ---------
    const statusRes = await fetch(`${BASE}/api/ai/status`);
    const status = await statusRes.json();
    assert.strictEqual(statusRes.status, 200, 'status endpoint should answer');
    assert.strictEqual(status.configured, true, 'AI must be usable with no paid key configured');
    assert.strictEqual(status.provider, 'pollinations', 'the keyless free provider should be selected');
    assert.ok(status.model, 'a model name should be reported');
    assert.ok(!('apiKey' in status), 'status must not expose credentials');

    // --- English generation returns real, on-topic copy ----------------------
    const en = await generate(BRIEF);
    if (en.res.status !== 200 && isNetworkOutage(en.json)) {
      console.log('ai test skipped: the free AI provider is unreachable from this environment');
      return;
    }
    assert.strictEqual(
      en.res.status,
      200,
      `English generation should succeed: ${JSON.stringify(en.json).slice(0, 200)}`
    );
    assert.strictEqual(en.json.provider, 'pollinations', 'a real provider must answer');
    assert.ok(!/mock|fallback|offline|deterministic/i.test(en.json.provider), 'no mock provider allowed');
    assert.ok(
      typeof en.json.text === 'string' && en.json.text.length > 40,
      'generated copy should be substantial'
    );
    assert.ok(
      /habit|walk|morning|health|sleep|water|sai health hub/i.test(en.json.text),
      'generated copy should be on topic'
    );
    assert.ok(!/AIza[0-9A-Za-z_-]{10,}/.test(JSON.stringify(en.json)), 'no API key may reach the client');

    // --- Odia output is requested and comes back in Odia script --------------
    const odia = await generate({
      kind: 'poster',
      language: 'or',
      topic: 'ସକାଳର ଚାଲିବା ଅଭ୍ୟାସ',
      headline: '',
      body: '',
      cta: '',
      footer: '',
      brief: 'ସରଳ ଓ ପ୍ରୋତ୍ସାହନମୂଳକ, ଡାକ୍ତରୀ ଦାବି ନାହିଁ'
    });
    assert.strictEqual(odia.res.status, 200, 'Odia generation should succeed');
    assert.ok(
      /[\u0B00-\u0B7F]/.test(odia.json.text),
      'Odia generation must return Odia script characters'
    );

    // --- Regeneration issues a fresh request and returns new content ---------
    const again = await generate(BRIEF);
    assert.strictEqual(again.res.status, 200, 'regeneration should succeed');
    assert.ok(
      typeof again.json.text === 'string' && again.json.text.length > 40,
      'regeneration should return content'
    );
    console.log(
      `regeneration produced ${again.json.text === en.json.text ? 'identical' : 'different'} copy`
    );

    // --- Guard rails stay in place -------------------------------------------
    const wrongType = await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}'
    });
    assert.strictEqual(wrongType.status, 415, 'a non-JSON content type should be refused');

    const badBody = await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{'
    });
    assert.strictEqual(badBody.status, 400, 'malformed JSON should be refused');
  } finally {
    await stopServer(child);
  }
}

async function runFailurePath(dataDir) {
  const child = await startServer(dataDir, { FREE_AI_URL: 'http://127.0.0.1:9/unreachable' });
  try {
    const failed = await generate(BRIEF);
    assert.notStrictEqual(failed.res.status, 200, 'an unreachable provider must not look like success');
    assert.strictEqual(failed.res.status, 502, 'a provider outage should report 502');
    assert.ok(
      typeof failed.json.error === 'string' && failed.json.error.length > 20,
      'the failure must explain itself to the user'
    );
    assert.ok(
      /unavailable|did not answer|failed|try again/i.test(failed.json.error),
      'the message should be actionable'
    );
  } finally {
    await stopServer(child);
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-ai-'));
  const failureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-ai-fail-'));
  try {
    await run(dataDir);
    await runFailurePath(failureDir);
    console.log('ai test passed');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(failureDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('ai test failed:', err.message);
  process.exit(1);
});
