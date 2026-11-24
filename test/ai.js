'use strict';

// Exercises the real AI generation path against a running server: provider
// chain, English and Odia output, regeneration, and the honest failure message
// when the provider is unreachable. No API key is required, because the app
// falls back to a free keyless model called server-side.
//
// The keyless tier allows one reply per cooldown window per IP, so this script
// waits out a reported cooldown instead of treating it as a failure.
// Run with: npm run test:ai
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 4324;
const BASE = `http://127.0.0.1:${PORT}`;
const DEAD_PORT = 4325;
const DEAD_BASE = `http://127.0.0.1:${DEAD_PORT}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer(base, env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(new URL(base).port) }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return child;
}

function waitForServer(child, base, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let log = '';
    const collect = (chunk) => {
      log += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const poll = async () => {
      if (child.exitCode !== null) {
        reject(new Error(`server exited before it was ready:\n${log}`));
        return;
      }
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        // still starting
      }
      if (Date.now() > deadline) {
        reject(new Error(`server did not become ready:\n${log}`));
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

async function generate(base, payload) {
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// Retries only when the provider reports its own cooldown window.
async function generateReady(base, payload, label) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    last = await generate(base, payload);
    if (last.status === 200) return last;
    const retryAfter = Number(last.json && last.json.retryAfter);
    if (last.status === 429 && Number.isFinite(retryAfter)) {
      const wait = (retryAfter + 3) * 1000;
      console.log(`${label}: free provider cooldown, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    return last;
  }
  return last;
}

// The route answers { ok, text, provider, model } and the v8 frontend parses
// `text` as JSON, so the test must read the same field the UI reads.
function parseCreative(label, payload) {
  assert.ok(payload && typeof payload.text === 'string' && payload.text.trim(), `${label}: the AI should return text`);
  assert.ok(payload.provider, `${label}: the answering provider should be reported`);
  const clean = payload.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let data = null;
  try {
    data = JSON.parse(clean);
  } catch {
    data = null;
  }
  assert.ok(
    data && typeof data === 'object',
    `${label}: the AI text should be parseable JSON (got: ${String(payload.text).slice(0, 140)})`
  );
  return data;
}

function assertCreative(label, body) {
  assert.ok(body && typeof body === 'object', `${label}: the AI should return structured JSON`);
  assert.ok(
    typeof body.headline === 'string' && body.headline.trim().length > 0,
    `${label}: headline should be filled in`
  );
  assert.ok(
    typeof body.body === 'string' && body.body.trim().length > 0,
    `${label}: body should be filled in`
  );
  assert.ok(
    typeof body.cta === 'string' && body.cta.trim().length > 0,
    `${label}: cta should be filled in`
  );
  assert.ok(!/^```/.test(JSON.stringify(body)), `${label}: no markdown fences should leak through`);
  // Brand rule: the prohibited word must never reach generated copy.
  assert.ok(
    !/wellness/i.test(JSON.stringify(body)),
    `${label}: generated copy must not contain the prohibited word (got: ${JSON.stringify(body).slice(0, 160)})`
  );
}

async function main() {
  const child = startServer(BASE, {});
  const dead = startServer(DEAD_BASE, {
    FREE_AI_URL: 'http://127.0.0.1:9/v1/chat/completions',
    AI_KEYLESS_DISABLED: 'false'
  });

  try {
    await waitForServer(child, BASE, 20000);

    // 1. The provider chain must report a usable service with no secret set.
    const status = await (await fetch(`${BASE}/api/ai/status`)).json();
    assert.strictEqual(status.configured, true, 'AI should be usable without a paid key');
    assert.ok(['gemini', 'pollinations'].includes(status.provider), 'a known provider is selected');
    assert.ok(status.model, 'the model name should be reported');
    console.log(`provider chain ready: ${status.provider} (${status.model})`);

    // 2. Real English generation.
    const en = await generateReady(
      BASE,
      {
        kind: 'poster',
        topic: 'Morning walks for busy professionals',
        brief: 'Warm, confident and family friendly. No medical claims.',
        language: 'en',
        channel: 'Instagram'
      },
      'English'
    );
    assert.strictEqual(en.status, 200, `English generation should succeed: ${JSON.stringify(en.json)}`);
    const enData = parseCreative('English', en.json);
    assertCreative('English', enData);
    assert.ok(/[A-Za-z]/.test(enData.headline), 'English headline should be Latin script');
    console.log(`English OK: ${enData.headline}`);

    // 3. Real Odia generation must come back in Odia script, not English.
    const or = await generateReady(
      BASE,
      {
        kind: 'poster',
        topic: 'ସକାଳର ଚାଲିବା ଅଭ୍ୟାସ',
        brief: 'ପରିବାର ପାଇଁ ଉଷ୍ମ ଏବଂ ସକାରାତ୍ମକ',
        language: 'or',
        channel: 'Instagram'
      },
      'Odia'
    );
    assert.strictEqual(or.status, 200, `Odia generation should succeed: ${JSON.stringify(or.json)}`);
    const orData = parseCreative('Odia', or.json);
    assertCreative('Odia', orData);
    const odiaText = [orData.headline, orData.body, orData.cta].join(' ');
    assert.ok(/[\u0B00-\u0B7F]/.test(odiaText), 'Odia output should contain Odia script characters');
    assert.ok(
      !/^[\x00-\x7F]*$/.test(odiaText),
      'Odia output should not be plain ASCII English'
    );
    console.log(`Odia OK: ${orData.headline}`);

    // 4. Regeneration produces a fresh result for the same brief.
    const again = await generateReady(
      BASE,
      {
        kind: 'poster',
        topic: 'Morning walks for busy professionals',
        brief: 'Warm, confident and family friendly. No medical claims.',
        language: 'en',
        channel: 'Instagram'
      },
      'Regeneration'
    );
    assert.strictEqual(again.status, 200, 'regeneration should succeed');
    const againData = parseCreative('Regeneration', again.json);
    assertCreative('Regeneration', againData);
    console.log(
      againData.headline === enData.headline
        ? 'Regeneration OK (same wording, fresh call)'
        : 'Regeneration OK (new wording)'
    );

    // 5. Guard rails.
    const wrongType = await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}'
    });
    assert.strictEqual(wrongType.status, 415, 'a non-JSON content type should be refused');

    const notAnObject = await generate(BASE, []);
    assert.strictEqual(notAnObject.status, 400, 'a non-object JSON body should be rejected');

    // 6. An unreachable provider must fail honestly, never fake content.
    await waitForServer(dead, DEAD_BASE, 20000);
    const failure = await generate(DEAD_BASE, { kind: 'poster', topic: 'Morning walks', brief: 'Short' });
    assert.strictEqual(failure.status, 502, 'an unreachable provider should return 502');
    assert.ok(failure.json && typeof failure.json.error === 'string', 'the failure should be explained');
    assert.ok(
      /unavailable|could not be reached|try again/i.test(failure.json.error),
      `the failure message should be actionable: ${failure.json.error}`
    );
    console.log(`honest failure OK: ${failure.json.error}`);

    console.log('ai test passed');
  } finally {
    for (const proc of [child, dead]) {
      if (proc.exitCode === null) proc.kill('SIGTERM');
    }
  }
}

main().catch((err) => {
  console.error(`ai test failed: ${err.message}`);
  process.exitCode = 1;
});
