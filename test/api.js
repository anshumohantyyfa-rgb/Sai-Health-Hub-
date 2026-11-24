'use strict';

// Exercises the persistent check-in API against the real server: creation,
// validation, per-browser isolation, deletion, restart persistence and throttling.
// Run with: npm test
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 4322;
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
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DATA_DIR: dataDir,
      RATE_LIMIT_MAX: '1000'
    }, extraEnv || {}),
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

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie') || '';
  const match = /shh_cid=([a-f0-9]{48})/.exec(raw);
  return match ? `shh_cid=${match[1]}` : null;
}

async function postCheckin(cookie, payload) {
  const res = await fetch(`${BASE}/api/checkins`, {
    method: 'POST',
    headers: Object.assign(
      { 'content-type': 'application/json' },
      cookie ? { cookie } : {}
    ),
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
  let json = null;
  if (res.status !== 204) {
    try {
      json = await res.json();
    } catch (err) {
      json = null;
    }
  }
  return { res, json, cookie: cookieFrom(res) || cookie };
}

async function listCheckins(cookie) {
  const res = await fetch(`${BASE}/api/checkins`, {
    headers: cookie ? { cookie } : {}
  });
  const json = await res.json();
  return { res, json, cookie: cookieFrom(res) || cookie };
}

async function run(dataDir) {
  let child = await startServer(dataDir);

  try {
    // --- Empty history for a brand new browser, and a scoped identity cookie ---
    const first = await listCheckins(null);
    assert.strictEqual(first.res.status, 200, 'GET /api/checkins should return 200');
    assert.deepStrictEqual(first.json.items, [], 'a new browser starts with no check-ins');
    assert.ok(first.cookie, 'the server should issue an anonymous client cookie');
    const clientA = first.cookie;

    // --- Storage driver is a real persistent database where supported ---
    const storageRes = await fetch(`${BASE}/api/storage`);
    const storage = await storageRes.json();
    assert.ok(['sqlite', 'json', 'memory'].includes(storage.driver), 'storage driver should be known');
    assert.strictEqual(storage.durable, true, 'storage must be durable, not in-memory');

    // --- Create: the server recalculates BMI itself (170/70 => 24.2) ---
    const created = await postCheckin(clientA, { heightCm: 170, weightKg: 70 });
    assert.strictEqual(created.res.status, 201, 'a valid check-in should be created');
    assert.strictEqual(created.json.bmi, 24.2, 'stored BMI must be 24.2 for 170 cm / 70 kg');
    assert.strictEqual(created.json.category.id, 'healthy');
    assert.strictEqual(created.json.category.label, 'Healthy weight');
    assert.strictEqual(created.json.note, '');
    assert.strictEqual(created.json.lang, 'en');
    assert.ok(created.json.id, 'a record id should be returned');
    assert.ok(created.json.createdAt, 'a timestamp should be returned');

    // A client cannot dictate the stored BMI.
    const spoofed = await postCheckin(clientA, { heightCm: 180, weightKg: 95, bmi: 1 });
    assert.strictEqual(spoofed.res.status, 201);
    assert.strictEqual(spoofed.json.bmi, 29.3, 'server must ignore a client-supplied BMI');
    assert.strictEqual(spoofed.json.category.id, 'overweight');

    // Optional note and language are stored.
    const withNote = await postCheckin(clientA, {
      heightCm: 160,
      weightKg: 52,
      note: 'Morning check-in',
      lang: 'HI'
    });
    assert.strictEqual(withNote.res.status, 201);
    assert.strictEqual(withNote.json.note, 'Morning check-in');
    assert.strictEqual(withNote.json.lang, 'hi', 'language codes are normalised');

    // --- List: newest first, scoped to the caller ---
    const listed = await listCheckins(clientA);
    assert.strictEqual(listed.res.status, 200);
    assert.strictEqual(listed.json.total, 3, 'three check-ins should be stored');
    assert.strictEqual(listed.json.items.length, 3);
    assert.strictEqual(listed.json.items[0].id, withNote.json.id, 'newest check-in should be first');
    assert.strictEqual(listed.json.storage, storage.driver);

    // --- Isolation: another browser sees nothing and gets its own id ---
    const otherBrowser = await listCheckins(null);
    assert.deepStrictEqual(otherBrowser.json.items, [], 'a different browser must not see history');
    assert.notStrictEqual(otherBrowser.cookie, clientA, 'each browser gets its own identity');
    const clientB = otherBrowser.cookie;

    // --- Validation ---
    const badHeight = await postCheckin(clientA, { heightCm: 10, weightKg: 70 });
    assert.strictEqual(badHeight.res.status, 400, 'out-of-range height should be rejected');
    assert.ok(/height/i.test(badHeight.json.error), 'error should explain the height problem');

    const badWeight = await postCheckin(clientA, { heightCm: 170, weightKg: 5 });
    assert.strictEqual(badWeight.res.status, 400, 'out-of-range weight should be rejected');

    const missing = await postCheckin(clientA, { heightCm: 170 });
    assert.strictEqual(missing.res.status, 400, 'missing weight should be rejected');

    const notJson = await fetch(`${BASE}/api/checkins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: clientA },
      body: 'not-json{'
    });
    assert.strictEqual(notJson.status, 400, 'malformed JSON should be rejected');

    const wrongType = await fetch(`${BASE}/api/checkins`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie: clientA },
      body: '{"heightCm":170,"weightKg":70}'
    });
    assert.strictEqual(wrongType.status, 415, 'a non-JSON content type should be refused');

    const huge = await postCheckin(clientA, {
      heightCm: 170,
      weightKg: 70,
      note: 'x'.repeat(20 * 1024)
    });
    assert.strictEqual(huge.res.status, 413, 'an oversized body should be refused');

    const longNote = await postCheckin(clientA, {
      heightCm: 170,
      weightKg: 70,
      note: 'y'.repeat(201)
    });
    assert.strictEqual(longNote.res.status, 400, 'an over-long note should be refused');

    const badMethod = await fetch(`${BASE}/api/checkins`, {
      method: 'PUT',
      headers: { cookie: clientA }
    });
    assert.strictEqual(badMethod.status, 405, 'unsupported methods should return 405');

    // --- Deletion is scoped: another browser cannot remove your record ---
    const foreignDelete = await fetch(`${BASE}/api/checkins/${created.json.id}`, {
      method: 'DELETE',
      headers: { cookie: clientB }
    });
    assert.strictEqual(foreignDelete.status, 404, 'a foreign delete must not succeed');

    const ownDelete = await fetch(`${BASE}/api/checkins/${created.json.id}`, {
      method: 'DELETE',
      headers: { cookie: clientA }
    });
    assert.strictEqual(ownDelete.status, 204, 'the owner can delete their own check-in');

    const afterDelete = await listCheckins(clientA);
    assert.strictEqual(afterDelete.json.total, 2, 'deleted check-in should be gone');
    assert.ok(
      !afterDelete.json.items.some((item) => item.id === created.json.id),
      'deleted id must not be listed'
    );

    // --- Persistence: data survives a full server restart ---
    await stopServer(child);
    child = await startServer(dataDir);

    const afterRestart = await listCheckins(clientA);
    assert.strictEqual(afterRestart.res.status, 200);
    assert.strictEqual(afterRestart.json.total, 2, 'check-ins must survive a restart');
    assert.strictEqual(afterRestart.json.items[0].id, withNote.json.id, 'history order is preserved');
    assert.strictEqual(afterRestart.json.items[0].note, 'Morning check-in');
    assert.strictEqual(afterRestart.json.driver || afterRestart.json.storage, storage.driver);

    // A fresh browser is still isolated after the restart.
    const freshAfterRestart = await listCheckins(null);
    assert.deepStrictEqual(freshAfterRestart.json.items, []);
  } finally {
    await stopServer(child);
  }
}

async function runRateLimit(dataDir) {
  const child = await startServer(dataDir, { RATE_LIMIT_MAX: '3' });
  try {
    const first = await listCheckins(null);
    const cookie = first.cookie;

    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const attempt = await postCheckin(cookie, { heightCm: 170, weightKg: 70 });
      statuses.push(attempt.res.status);
    }
    assert.deepStrictEqual(
      statuses.slice(0, 3),
      [201, 201, 201],
      'the first three writes should succeed'
    );
    assert.strictEqual(statuses[3], 429, 'the fourth write within the window should be throttled');
  } finally {
    await stopServer(child);
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-api-'));
  const rateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-rate-'));

  try {
    await run(dataDir);
    await runRateLimit(rateDir);
    console.log('api test passed');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(rateDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('api test failed:', err.message);
  process.exit(1);
});
