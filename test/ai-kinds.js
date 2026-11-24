'use strict';

// Verifies the Phase 2 AI contracts that the Content Studio depends on:
//   - the Gemini request shape (path, key header, no key in the URL)
//   - the bilingual "English + Odia" brief actually reaching the model
//   - AI WhatsApp message and campaign-idea JSON contracts
//   - provider error mapping (429) and brand scrubbing
//
// The AI provider is a local stand-in that speaks the same HTTP contract as
// Gemini, so this test needs no API key and no billing. It proves the app's
// integration wiring; it does not prove Google's service is reachable.
//
// Run with: node test/ai-kinds.js
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FAKE_PORT = 4330;
const APP_PORT = 4331;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const FAKE_BASE = `http://127.0.0.1:${FAKE_PORT}`;
const TEST_KEY = 'test-key-not-a-real-credential';

const seen = { url: '', key: '', prompt: '' };

function creativeFor(prompt) {
  if (/FAIL429/.test(prompt)) return null;
  if (/ideas must be an array/.test(prompt)) {
    return {
      headline: 'Four campaigns for a healthier week',
      body: 'Practical themes for the Khordha community.',
      ideas: [
        { title: 'Morning walk club', format: 'Reel', why: 'Easy to start together.', caption: 'Walk with us this week.' },
        { title: 'Water bottle check', format: 'Story', why: 'Simple daily reminder.', caption: 'Keep water within reach.' },
        { title: 'Balanced breakfast', format: 'Carousel', why: 'Answers a common question.', caption: 'Three simple breakfast ideas.' },
        { title: 'Coach introduction', format: 'WhatsApp broadcast', why: 'Builds trust before a visit.', caption: 'Meet your coach this week.' }
      ]
    };
  }
  if (/whatsapp_message/.test(prompt)) {
    return {
      headline: 'A small habit for today',
      body: 'One consistent step beats a perfect plan.',
      cta: 'Reply to plan your first session',
      whatsapp_message: 'Hello! A small habit today: a ten minute walk after dinner. Would you like a simple weekly plan?'
    };
  }
  return { headline: 'Small habits, better days', body: 'Start with one step today.', cta: 'Talk to your coach' };
}

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    seen.url = req.url || '';
    seen.key = req.headers['x-goog-api-key'] || '';
    let prompt = '';
    try {
      const body = JSON.parse(raw);
      const parts = (body.contents && body.contents[0] && body.contents[0].parts) || [];
      prompt = parts.map((p) => p.text || '').join('');
    } catch {
      prompt = '';
    }
    seen.prompt = prompt;

    if (/FAIL429/.test(prompt)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Quota exceeded for this key.' } }));
      return;
    }
    const creative = creativeFor(prompt);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(creative) }] } }] }));
  });
});

function startApp() {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT),
      GEMINI_API_KEY: TEST_KEY,
      GEMINI_BASE_URL: FAKE_BASE,
      GEMINI_MODEL: 'gemini-2.0-flash',
      // Disable the keyless fallback so the provider-failure path is deterministic
      // and this test never depends on a public third-party endpoint.
      AI_KEYLESS_DISABLED: 'true'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitReady(child) {
  const deadline = Date.now() + 20000;
  let log = '';
  child.stdout.on('data', (c) => {
    log += c.toString();
  });
  child.stderr.on('data', (c) => {
    log += c.toString();
  });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited early:\n${log}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`app did not become ready:\n${log}`);
}

async function generate(payload) {
  const res = await fetch(`${BASE}/api/generate`, {
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

function parseCreative(label, json) {
  assert.ok(json && typeof json.text === 'string' && json.text.trim(), `${label}: expected text back`);
  const clean = json.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let data = null;
  try {
    data = JSON.parse(clean);
  } catch {
    data = null;
  }
  assert.ok(data && typeof data === 'object', `${label}: expected parseable JSON, got ${String(json.text).slice(0, 140)}`);
  return data;
}

async function main() {
  await new Promise((resolve) => fake.listen(FAKE_PORT, '0.0.0.0', resolve));
  const app = startApp();
  try {
    await waitReady(app);

    // 1. The configured provider is reported honestly.
    const status = await (await fetch(`${BASE}/api/ai/status`)).json();
    assert.strictEqual(status.provider, 'gemini', 'the configured provider should be gemini');
    assert.strictEqual(status.configured, true, 'a configured key means AI is usable');

    // 2. "English + Odia" must reach the model as a bilingual instruction,
    //    not as the literal string "mix".
    const mixed = await generate({ kind: 'poster', language: 'mix', topic: 'Morning walks' });
    assert.strictEqual(mixed.status, 200, `bilingual request should succeed: ${JSON.stringify(mixed.json)}`);
    assert.ok(/bilingual/i.test(seen.prompt), 'the bilingual instruction should reach the model');
    assert.ok(/English/.test(seen.prompt) && /Odia/.test(seen.prompt), 'both languages should be named');
    assert.ok(!/Write every value in mix/i.test(seen.prompt), 'the literal placeholder "mix" must never be sent');
    console.log('bilingual prompt OK');

    // 3. The key travels in a header, never in the URL, and the path is right.
    assert.strictEqual(seen.key, TEST_KEY, 'the API key should be sent as the x-goog-api-key header');
    assert.ok(!seen.url.includes(TEST_KEY), 'the API key must never appear in the request URL');
    assert.ok(
      /\/v1beta\/models\/.+:generateContent/.test(seen.url),
      `the request path should be the Gemini generateContent path, got ${seen.url}`
    );
    console.log('Gemini request shape OK');

    // 4. AI WhatsApp message contract.
    const wa = await generate({ kind: 'whatsapp', language: 'en', topic: 'Hydration reminder' });
    assert.strictEqual(wa.status, 200, 'WhatsApp generation should succeed');
    const waData = parseCreative('WhatsApp', wa.json);
    assert.ok(
      typeof waData.whatsapp_message === 'string' && waData.whatsapp_message.trim().length > 20,
      'the AI should return a usable WhatsApp message'
    );
    console.log(`WhatsApp message OK (${waData.whatsapp_message.length} chars)`);

    // 5. Campaign ideas contract: four structured, usable ideas.
    const ideas = await generate({ kind: 'ideas', language: 'en', topic: 'Community session' });
    assert.strictEqual(ideas.status, 200, 'idea generation should succeed');
    const ideaData = parseCreative('Ideas', ideas.json);
    assert.ok(Array.isArray(ideaData.ideas) && ideaData.ideas.length === 4, 'four campaign ideas should come back');
    for (const [i, idea] of ideaData.ideas.entries()) {
      assert.ok(typeof idea.title === 'string' && idea.title.trim(), `idea ${i + 1} needs a title`);
      assert.ok(typeof idea.format === 'string' && idea.format.trim(), `idea ${i + 1} needs a format`);
    }
    console.log('campaign ideas OK');

    // 6. Brand rule holds for the new outputs too.
    assert.ok(
      !/wellness/i.test(JSON.stringify([waData, ideaData])),
      'generated copy must never contain the prohibited word'
    );

    // 7. Provider failures are reported, never replaced with fake content.
    const limited = await generate({ kind: 'poster', brief: 'FAIL429', language: 'en' });
    assert.ok(
      limited.status >= 400 && limited.status < 600,
      `a provider quota error should surface as an error, got ${limited.status}`
    );
    // The user-facing message stays actionable while the provider's own reason is
    // carried in attempts, so a quota problem is diagnosable without leaking keys.
    const reason = [limited.json && limited.json.error]
      .concat((limited.json && limited.json.attempts) || [])
      .join(' ');
    assert.ok(
      /quota|exceeded/i.test(reason),
      `the provider reason should be surfaced to the owner: ${reason}`
    );
    assert.ok(!limited.json.text, 'a failed generation must never return fabricated content');
    console.log('provider error mapping OK');

    console.log('ai kinds test passed');
  } finally {
    if (app.exitCode === null) app.kill('SIGTERM');
    await new Promise((r) => fake.close(r));
  }
}

main().catch((err) => {
  console.error(`ai kinds test failed: ${err.message}`);
  process.exitCode = 1;
});
