'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BmiCalc = require('./public/bmi.js');
const { createStore, newRecord } = require('./lib/store.js');
const OwnerAuth = require('./lib/owner.js');
const OwnerRecords = require('./lib/owner-records.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_BODY_BYTES = 16 * 1024;
const NOTE_MAX = 200;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_LIST_LIMIT = 100;
const CLIENT_COOKIE = 'shh_cid';

// Generic per-browser app state (the migrated panels' 16 collections).
const MAX_STATE_BODY_BYTES = 512 * 1024;
const MAX_STATE_VALUE_BYTES = 400 * 1024;
const MAX_STATE_ITEMS = 2000;
const STATE_KEYS = new Set([
  'language',
  'plan',
  'content',
  'leads',
  'metrics',
  'creative',
  'customers',
  'checkins',
  'mediaRefs',
  'idDocs',
  'idReviews',
  'masterProfiles',
  'businessContacts',
  'followups',
  'consultations',
  'consentEvents',
  'qaChecks'
]);

// Optional AI integration (v8 Content Studio). Configured through Settings.
const AI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const AI_TIMEOUT_MS = 25000;
// Keyless free provider, used automatically when no Gemini key is configured.
// No secret and no billing are involved, and the call happens server-side only.
const FREE_AI_URL = process.env.FREE_AI_URL || 'https://text.pollinations.ai/openai';
const FREE_AI_MODEL = process.env.FREE_AI_MODEL || 'openai';
// The keyless tier answers once per cooldown window per IP and signals it with HTTP 402.
const FREE_AI_COOLDOWN_SECONDS = 45;
const AI_KEYLESS_DISABLED = String(process.env.AI_KEYLESS_DISABLED || '').toLowerCase() === 'true';
const CLIENT_ID_PATTERN = /^[a-f0-9]{48}$/;

const store = createStore();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers));
  res.end(body);
}

function sendJson(res, status, payload, headers) {
  const body = JSON.stringify(payload);
  res.writeHead(
    status,
    Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
      },
      headers
    )
  );
  res.end(body);
}

// Health endpoint. /healthz is the canonical path, but the hosting ingress reserves
// GET /healthz, so the same payload is also served on non-reserved aliases.
const HEALTH_PATHS = new Set(['/healthz', '/health', '/api/health']);

function pathnameOf(rawUrl) {
  try {
    const pathname = new URL(rawUrl, 'http://localhost').pathname.replace(/\/+$/, '');
    return pathname === '' ? '/' : pathname;
  } catch (err) {
    return '/';
  }
}

function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  // Prevent path traversal outside the public directory.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return null;
  }
  return target;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) {
    return cookies;
  }
  String(header)
    .split(';')
    .forEach((pair) => {
      const index = pair.indexOf('=');
      if (index > 0) {
        cookies[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
      }
    });
  return cookies;
}

/*
 * Anonymous per-browser identity. The cookie holds a random 192-bit value that is
 * only ever used as a storage key — never as a credential that reveals data, since
 * every read is still scoped to that key. HttpOnly keeps it away from page scripts.
 */
function clientIdFor(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const existing = cookies[CLIENT_COOKIE];
  if (existing && CLIENT_ID_PATTERN.test(existing)) {
    return existing;
  }
  const id = crypto.randomBytes(24).toString('hex');
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https')
    ? '; Secure'
    : '';
  res.setHeader(
    'Set-Cookie',
    `${CLIENT_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`
  );
  return id;
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject({ code: 'PAYLOAD_TOO_LARGE' });
        return;
      }
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject({ code: 'INVALID_JSON' });
      }
    });
    req.on('error', () => reject({ code: 'READ_ERROR' }));
  });
}

// Simple in-memory throttle so one client cannot hammer the write endpoints.
const rateBuckets = new Map();

function isRateLimited(key) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    if (rateBuckets.size > 5000) {
      for (const [entryKey, entry] of rateBuckets) {
        if (entry.resetAt <= now) {
          rateBuckets.delete(entryKey);
        }
      }
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

function sanitizeNote(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (cleaned.length > NOTE_MAX) {
    return null;
  }
  return cleaned;
}

function sanitizeLang(value) {
  if (typeof value === 'string' && /^[a-z]{2}(-[a-z]{2,4})?$/i.test(value)) {
    return value.toLowerCase();
  }
  return 'en';
}

function toPublic(record) {
  return {
    id: record.id,
    heightCm: record.heightCm,
    weightKg: record.weightKg,
    bmi: record.bmi,
    category: { id: record.categoryId, label: record.categoryLabel },
    note: record.note,
    lang: record.lang,
    createdAt: record.createdAt
  };
}

function parseLimit(rawUrl) {
  let requested = NaN;
  try {
    requested = Number(new URL(rawUrl, 'http://localhost').searchParams.get('limit'));
  } catch (err) {
    requested = NaN;
  }
  if (!Number.isFinite(requested) || requested <= 0) {
    return 20;
  }
  return Math.min(Math.floor(requested), MAX_LIST_LIMIT);
}

async function handleCreateCheckin(req, res) {
  const clientId = clientIdFor(req, res);

  if (isRateLimited(clientId)) {
    sendJson(res, 429, { error: 'Too many check-ins. Please wait a moment.' }, { 'Retry-After': '60' });
    return;
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (err) {
    const code = err && err.code;
    if (code === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, { error: 'Request body is too large.' });
    } else if (code === 'INVALID_JSON') {
      sendJson(res, 400, { error: 'Request body must be valid JSON.' });
    } else {
      sendJson(res, 400, { error: 'Could not read the request body.' });
    }
    return;
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Request body must be a JSON object.' });
    return;
  }

  const heightCm = Number(body.heightCm);
  const weightKg = Number(body.weightKg);

  // Server-side validation and calculation: the client can never dictate a BMI.
  const result = BmiCalc.computeBmi(heightCm, weightKg);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error });
    return;
  }

  const note = sanitizeNote(body.note);
  if (note === null) {
    sendJson(res, 400, { error: `Note must be ${NOTE_MAX} characters or fewer.` });
    return;
  }

  const record = store.add(
    newRecord({
      clientId,
      heightCm,
      weightKg,
      bmi: result.rounded,
      categoryId: result.category.id,
      categoryLabel: result.category.label,
      note,
      lang: sanitizeLang(body.lang)
    })
  );

  sendJson(res, 201, toPublic(record));
}

function handleListCheckins(req, res) {
  const clientId = clientIdFor(req, res);
  const limit = parseLimit(req.url || '/');
  sendJson(res, 200, {
    items: store.list(clientId, limit).map(toPublic),
    total: store.countFor(clientId),
    storage: store.kind
  });
}

function handleDeleteCheckin(req, res, id) {
  const clientId = clientIdFor(req, res);
  if (isRateLimited(clientId)) {
    sendJson(res, 429, { error: 'Too many requests. Please wait a moment.' }, { 'Retry-After': '60' });
    return;
  }
  const removed = store.remove(id, clientId);
  if (!removed) {
    sendJson(res, 404, { error: 'Check-in not found.' });
    return;
  }
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function handleStorageInfo(req, res) {
  sendJson(res, 200, {
    driver: store.kind,
    durable: store.kind !== 'memory',
    records: store.total()
  });
}

function handleGetState(req, res) {
  const clientId = clientIdFor(req, res);
  const raw = store.stateAll(clientId);
  const data = {};
  Object.keys(raw).forEach((key) => {
    try {
      data[key] = JSON.parse(raw[key]);
    } catch (err) {
      data[key] = raw[key];
    }
  });
  sendJson(res, 200, { ok: true, data, keys: Object.keys(data), storage: store.kind });
}

function validateStateValue(key, value) {
  if (key === 'language') {
    if (typeof value !== 'string' || !/^[a-z]{2}$/.test(value)) {
      return 'Language must be a two-letter code.';
    }
    return null;
  }
  // v8 stores most collections as arrays but a few as a single object
  // (for example the active creative brief), so both shapes are valid.
  const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!Array.isArray(value) && !isPlainObject) {
    return `The "${key}" collection must be an array or an object.`;
  }
  if (value.length > MAX_STATE_ITEMS) {
    return `The "${key}" collection holds too many items.`;
  }
  const supported = value.every(
    (item) =>
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean' ||
      (typeof item === 'object' && !Array.isArray(item))
  );
  if (!supported) {
    return `The "${key}" collection contains an unsupported item.`;
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (err) {
    return `The "${key}" collection is not valid JSON.`;
  }
  if (encoded.length > MAX_STATE_VALUE_BYTES) {
    return `The "${key}" collection is too large to store.`;
  }
  return null;
}

async function handlePutState(req, res) {
  const clientId = clientIdFor(req, res);

  if (isRateLimited(clientId)) {
    sendJson(res, 429, { error: 'Too many saves. Please wait a moment.' }, { 'Retry-After': '60' });
    return;
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, MAX_STATE_BODY_BYTES);
  } catch (err) {
    const code = err && err.code;
    if (code === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, { error: 'Request body is too large.' });
    } else if (code === 'INVALID_JSON') {
      sendJson(res, 400, { error: 'Request body must be valid JSON.' });
    } else {
      sendJson(res, 400, { error: 'Could not read the request body.' });
    }
    return;
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Request body must be a JSON object.' });
    return;
  }

  const key = typeof body.key === 'string' ? body.key : '';
  if (!STATE_KEYS.has(key)) {
    sendJson(res, 400, { error: 'Unknown data collection.' });
    return;
  }

  const problem = validateStateValue(key, body.value);
  if (problem) {
    sendJson(res, 400, { error: problem });
    return;
  }

  store.stateSet(clientId, key, JSON.stringify(body.value));
  sendJson(res, 200, { ok: true, key });
}

function aiStatus() {
  const gemini = Boolean(process.env.GEMINI_API_KEY);
  const keyless = !AI_KEYLESS_DISABLED;
  return {
    ok: true,
    configured: gemini || keyless,
    provider: gemini ? 'gemini' : keyless ? 'pollinations' : 'none',
    model: gemini ? AI_MODEL : keyless ? FREE_AI_MODEL : null,
    gemini,
    keyless
  };
}

function briefField(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function buildAiPrompt(body) {
  const parts = [
    'You are the creative assistant inside Sai Health Hub, a bilingual (English and Odia) health-habit coaching app for Khordha.',
    'Write factual, compliant, non-medical marketing copy. Never promise cures, guaranteed weight loss or medical outcomes.',
    'Reply with ONE JSON object and nothing else: no markdown fences, no commentary before or after it.',
    'Use double quotes for every string value. Allowed keys: headline, body, cta, caption, hashtags, visual_direction, reel_script.',
    'Always include headline, body and cta. Stay factual and non-medical: no cures, no guaranteed weight loss, no before/after promises, no invented testimonials.'
  ];
  const kind = briefField(body.kind, 40);
  const language = briefField(body.language, 10);
  const topic = briefField(body.topic, 200);
  const headline = briefField(body.headline, 400);
  const message = briefField(body.body, 1200);
  const cta = briefField(body.cta, 200);
  const footer = briefField(body.footer, 200);
  const brief = briefField(body.brief, 1200);

  if (kind) parts.push(`Format requested: ${kind}.`);
  const languageName =
    { en: 'English', or: 'Odia written in Odia script (\u0b13\u0b21\u0b3c\u0b3f\u0b06)', hi: 'Hindi written in Devanagari script' }[
      language
    ] || (language || '');
  if (languageName) {
    parts.push(`Write every value in ${languageName}. Keep the JSON keys themselves in English.`);
  }
  if (topic) parts.push(`Topic: ${topic}.`);
  if (headline) parts.push(`Current headline: ${headline}.`);
  if (message) parts.push(`Current message: ${message}.`);
  if (cta) parts.push(`Current call to action: ${cta}.`);
  if (footer) parts.push(`Footer text: ${footer}.`);
  if (brief) parts.push(`Creative brief: ${brief}.`);
  return parts.join('\n');
}

async function callGemini(apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(AI_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1400 }
        }),
        signal: controller.signal
      }
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        payload && payload.error && payload.error.message
          ? String(payload.error.message).slice(0, 300)
          : `Gemini returned ${response.status}.`;
      const failure = new Error(detail);
      failure.status = response.status === 429 ? 429 : 502;
      failure.publicMessage = detail;
      throw failure;
    }

    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const parts =
      candidates[0] && candidates[0].content && Array.isArray(candidates[0].content.parts)
        ? candidates[0].content.parts
        : [];
    const text = normalizeAiText(
      parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
    );

    if (!text) {
      const failure = new Error('empty response');
      failure.status = 502;
      failure.publicMessage = 'The AI returned an empty response. Try again.';
      throw failure;
    }

    return { ok: true, text, provider: 'gemini', model: AI_MODEL };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const failure = new Error('timeout');
      failure.status = 504;
      failure.publicMessage = 'The AI request timed out. Try a shorter brief.';
      throw failure;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAiText(raw) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const candidate = text.slice(start, end + 1);
      try {
        JSON.parse(candidate);
        text = candidate;
      } catch (_) {
        /* the model answered in prose: return it unchanged */
      }
    }
  }
  return text;
}

async function callPollinations(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch(FREE_AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model: FREE_AI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a precise bilingual marketing copywriter for a health-habit coaching business. You answer with a single strict JSON object and nothing else.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.85,
        max_tokens: 1400,
        private: true,
        referrer: 'sai-health-hub'
      }),
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const rawDetail =
        payload && payload.error
          ? typeof payload.error === 'string'
            ? payload.error
            : payload.error.message
          : '';
      const failure = new Error(String(rawDetail || `free provider ${response.status}`).slice(0, 200));
      if (response.status === 402 || response.status === 429) {
        const retryAfter = freeRetryAfter(payload, rawDetail);
        failure.status = 429;
        failure.retryAfter = retryAfter;
        failure.publicMessage =
          `The free AI service allows one generation every ${FREE_AI_COOLDOWN_SECONDS} seconds. ` +
          `Try again in ${retryAfter}s, or add a free GEMINI_API_KEY in Settings for a higher limit.`;
      } else {
        failure.status = 502;
        failure.publicMessage = `The free AI service did not answer correctly (HTTP ${response.status}). Your brief is unchanged, so try again in a moment.`;
      }
      throw failure;
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const message = choices[0] && choices[0].message ? choices[0].message : {};
    const text = normalizeAiText(message.content);
    if (!text) {
      const failure = new Error('empty response');
      failure.status = 502;
      failure.publicMessage = 'The AI returned an empty response. Press Generate to try again.';
      throw failure;
    }

    return {
      ok: true,
      text,
      provider: 'pollinations',
      model: (payload && typeof payload.model === 'string' && payload.model) || FREE_AI_MODEL,
      keyless: true
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const failure = new Error('timeout');
      failure.status = 504;
      failure.publicMessage = 'The AI request timed out. Try a shorter brief, or press Generate again.';
      throw failure;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function freeRetryAfter(payload, detail) {
  const candidates = [
    payload && payload.retryAfter,
    payload && payload.error && payload.error.retryAfter,
    payload && payload.error && payload.error.details && payload.error.details.retryAfter
  ];
  for (const value of candidates) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 120);
  }
  const match = /retry after\s+(\d+)\s*s/i.exec(String(detail || ''));
  if (match) return Math.min(Number(match[1]), 120);
  return FREE_AI_COOLDOWN_SECONDS;
}

async function generateAiText(apiKey, prompt) {
  const attempts = [];
  if (apiKey) {
    try {
      return await callGemini(apiKey, prompt);
    } catch (err) {
      attempts.push(`gemini: ${err.publicMessage || err.message}`);
    }
  }

  if (!AI_KEYLESS_DISABLED) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await callPollinations(prompt);
      } catch (err) {
        lastError = err;
        // A short cooldown is worth waiting out; a long one is reported instead.
        const waitable =
          err && err.status === 429 && Number.isFinite(err.retryAfter) && err.retryAfter <= 12;
        if (!waitable || attempt === 1) break;
        await new Promise((resolve) => setTimeout(resolve, err.retryAfter * 1000));
      }
    }
    if (lastError) {
      attempts.push(`free: ${lastError.publicMessage || lastError.message}`);
      if (lastError.status === 429) {
        lastError.attempts = attempts;
        throw lastError;
      }
    }
  }
  const failure = new Error('every AI provider failed');
  failure.status = 502;
  failure.attempts = attempts;
  failure.publicMessage =
    'The AI service is unavailable right now, so no content was generated and nothing was posted. ' +
    'Your brief is still in the form, so press Generate again in a moment.' +
    (apiKey ? '' : ' Adding GEMINI_API_KEY in Settings gives this app a dedicated quota.');
  throw failure;
}

async function handleGenerate(req, res) {
  const clientId = clientIdFor(req, res);

  if (isRateLimited(clientId)) {
    sendJson(res, 429, { error: 'Too many AI requests. Please wait a moment.' }, { 'Retry-After': '60' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && AI_KEYLESS_DISABLED) {
    sendJson(res, 503, {
      error:
        'AI text generation is not configured yet. Add GEMINI_API_KEY to this app\u2019s environment to enable it.',
      configured: false
    });
    return;
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES * 4);
  } catch (err) {
    const code = err && err.code;
    if (code === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, { error: 'Request body is too large.' });
    } else {
      sendJson(res, 400, { error: 'Request body must be valid JSON.' });
    }
    return;
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Request body must be a JSON object.' });
    return;
  }

  try {
    const result = await generateAiText(apiKey, buildAiPrompt(body));
    sendJson(res, 200, result);
  } catch (err) {
    const failure = {
      error: err.publicMessage || 'AI generation failed. Please try again in a moment.'
    };
    if (Number.isFinite(err.retryAfter)) failure.retryAfter = err.retryAfter;
    if (Array.isArray(err.attempts) && err.attempts.length) failure.attempts = err.attempts;
    sendJson(
      res,
      err.status || 502,
      failure,
      Number.isFinite(err.retryAfter) ? { 'Retry-After': String(err.retryAfter) } : undefined
    );
  }
}

/* ---------------------------------------------------------- owner console */

const OWNER_COOKIE = 'shh_owner';
const OWNER_BODY_LIMIT = 64 * 1024;
const NO_STORE = { 'Cache-Control': 'no-store' };
const DAY_MS = 24 * 60 * 60 * 1000;

function requestIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function ownerToken(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[OWNER_COOKIE] || '';
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ? '; Secure' : '';
  return `${OWNER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function ownerSessionPayload(req, token) {
  return {
    authenticated: OwnerAuth.validSession(token || ownerToken(req)),
    passwordConfigured: OwnerAuth.passwordConfigured(),
    source: OwnerAuth.passwordSource(),
    sessionTtlSeconds: OwnerAuth.sessionTtlSeconds()
  };
}

function requireOwner(req, res) {
  if (OwnerAuth.validSession(ownerToken(req))) {
    return true;
  }
  sendJson(res, 401, { error: 'Owner sign-in required.', authenticated: false }, NO_STORE);
  return false;
}

async function readOwnerBody(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    const err = new Error('Content-Type must be application/json.');
    err.status = 415;
    throw err;
  }
  return readJsonBody(req, OWNER_BODY_LIMIT);
}

function handleOwnerSession(req, res) {
  sendJson(res, 200, ownerSessionPayload(req), NO_STORE);
}

async function handleOwnerSetup(req, res) {
  let body;
  try {
    body = await readOwnerBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message }, NO_STORE);
    return;
  }
  if (OwnerAuth.passwordConfigured()) {
    sendJson(res, 409, { error: 'An owner password is already configured. Sign in instead.' }, NO_STORE);
    return;
  }
  const result = OwnerAuth.setInitialPassword(body && body.password);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error }, NO_STORE);
    return;
  }
  const token = OwnerAuth.createSession();
  sendJson(
    res,
    200,
    { ok: true, session: ownerSessionPayload(req) },
    Object.assign({ 'Set-Cookie': sessionCookie(req, token, OwnerAuth.sessionTtlSeconds()) }, NO_STORE)
  );
}

async function handleOwnerLogin(req, res) {
  const ip = requestIp(req);
  if (OwnerAuth.rateLimited(ip)) {
    sendJson(res, 429, { error: 'Too many sign-in attempts. Try again in a few minutes.' }, NO_STORE);
    return;
  }
  let body;
  try {
    body = await readOwnerBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message }, NO_STORE);
    return;
  }
  if (!OwnerAuth.passwordConfigured()) {
    sendJson(res, 409, { error: 'No owner password is configured yet. Create one first.', setupRequired: true }, NO_STORE);
    return;
  }
  if (!OwnerAuth.checkPassword(body && body.password)) {
    OwnerAuth.noteFailure(ip);
    sendJson(res, 401, { error: 'That password is not correct.' }, NO_STORE);
    return;
  }
  OwnerAuth.clearFailures(ip);
  const token = OwnerAuth.createSession();
  sendJson(
    res,
    200,
    { ok: true, session: ownerSessionPayload(req, token) },
    Object.assign({ 'Set-Cookie': sessionCookie(req, token, OwnerAuth.sessionTtlSeconds()) }, NO_STORE)
  );
}

function handleOwnerLogout(req, res) {
  OwnerAuth.destroySession(ownerToken(req));
  sendJson(res, 200, { ok: true }, Object.assign({ 'Set-Cookie': sessionCookie(req, '', 0) }, NO_STORE));
}

const OWNER_COLLECTION_RE = /^\/api\/owner\/records\/([A-Za-z]+)$/;
const OWNER_ITEM_RE = /^\/api\/owner\/records\/([A-Za-z]+)\/([A-Za-z0-9_-]{1,64})$/;

async function handleOwnerCollection(req, res, collection, method) {
  if (!OwnerRecords.isKnownCollection(collection)) {
    sendJson(res, 404, { error: 'Unknown collection.' }, NO_STORE);
    return;
  }
  if (method === 'GET') {
    sendJson(res, 200, { items: OwnerRecords.list(collection) || [] }, NO_STORE);
    return;
  }
  let body;
  try {
    body = await readOwnerBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message }, NO_STORE);
    return;
  }
  if (method === 'PUT') {
    const result = OwnerRecords.replace(collection, body && body.items);
    sendJson(res, result.ok ? 200 : 400, result.ok ? { ok: true, items: result.items } : { error: result.error }, NO_STORE);
    return;
  }
  if (method === 'POST') {
    const result = OwnerRecords.create(collection, body && body.record);
    sendJson(
      res,
      result.ok ? 200 : 400,
      result.ok ? { ok: true, item: result.item, items: result.items } : { error: result.error },
      NO_STORE
    );
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed.' }, NO_STORE);
}

async function handleOwnerItem(req, res, collection, id, method) {
  if (!OwnerRecords.isKnownCollection(collection)) {
    sendJson(res, 404, { error: 'Unknown collection.' }, NO_STORE);
    return;
  }
  if (method === 'DELETE') {
    const result = OwnerRecords.remove(collection, id);
    sendJson(res, result.ok ? 200 : result.status || 400, result.ok ? { ok: true, items: result.items } : { error: result.error }, NO_STORE);
    return;
  }
  if (method === 'PATCH') {
    let body;
    try {
      body = await readOwnerBody(req);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message }, NO_STORE);
      return;
    }
    const result = OwnerRecords.update(collection, id, body && body.patch);
    sendJson(
      res,
      result.ok ? 200 : result.status || 400,
      result.ok ? { ok: true, item: result.item, items: result.items } : { error: result.error },
      NO_STORE
    );
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed.' }, NO_STORE);
}

function dayGap(fromIso, toDate) {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) {
    return null;
  }
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate());
  return Math.round((b - a) / DAY_MS);
}

function firstWord(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function computeReminders() {
  const today = new Date();
  const customers = OwnerRecords.list('customers') || [];
  const checkins = OwnerRecords.list('checkins') || [];
  const leads = OwnerRecords.list('leads') || [];
  const followups = OwnerRecords.list('followups') || [];
  const items = [];

  const customerById = (id) => customers.find((c) => String(c.id) === String(id)) || null;

  followups.forEach((f) => {
    if (String(f.status || '') === 'Completed' || !f.dueAt) {
      return;
    }
    const gap = dayGap(f.dueAt, today);
    if (gap === null || gap < -3) {
      return;
    }
    const customer = customerById(f.customerId);
    items.push({
      type: 'followup',
      id: String(f.id),
      followupId: String(f.id),
      customerId: customer ? String(customer.id) : '',
      name: customer ? customer.name : f.name || 'Follow-up',
      contact: (customer && customer.contact) || f.contact || '',
      consent: Boolean(customer ? customer.consent : f.consent),
      reason: f.reason || f.note || 'Scheduled follow-up',
      daysOverdue: gap
    });
  });

  customers.forEach((c) => {
    if (!c.consent) {
      return;
    }
    const own = checkins
      .filter((k) => String(k.customerId) === String(c.id))
      .map((k) => k.date || k.createdAt)
      .filter(Boolean)
      .sort();
    const last = own.length ? own[own.length - 1] : null;
    const gap = last ? dayGap(last, today) : null;
    if (gap === null) {
      items.push({
        type: 'customer',
        id: String(c.id),
        customerId: String(c.id),
        name: c.name,
        contact: c.contact || '',
        consent: true,
        reason: 'No check-in recorded yet',
        daysOverdue: 0
      });
      return;
    }
    if (gap >= 14) {
      items.push({
        type: 'customer',
        id: String(c.id),
        customerId: String(c.id),
        name: c.name,
        contact: c.contact || '',
        consent: true,
        reason: `Last check-in was ${gap} days ago`,
        daysOverdue: gap - 14
      });
    }
  });

  leads.forEach((l) => {
    const status = String(l.status || 'New');
    if (status === 'Customer' || status === 'Not proceeding') {
      return;
    }
    const gap = l.date ? dayGap(l.date, today) : null;
    if (gap === null || gap < 3) {
      return;
    }
    items.push({
      type: 'lead',
      id: String(l.id),
      name: l.name || 'Lead',
      contact: l.contact || '',
      consent: String(l.consent || '') === 'Yes',
      reason: `Lead is ${status} after ${gap} days`,
      daysOverdue: gap - 3
    });
  });

  items.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return items;
}

function handleOwnerReminders(req, res) {
  const items = computeReminders();
  sendJson(res, 200, { ok: true, items, generatedAt: new Date().toISOString() }, NO_STORE);
}

function handleOwnerSummary(req, res) {
  const counts = OwnerRecords.counts();
  const leads = OwnerRecords.list('leads') || [];
  const reminders = computeReminders();
  sendJson(
    res,
    200,
    {
      counts,
      openLeads: leads.filter((l) => !['Customer', 'Not proceeding'].includes(String(l.status || 'New'))).length,
      remindersDue: reminders.filter((r) => r.daysOverdue >= 0).length,
      storageKind: OwnerRecords.driverInfo().kind,
      bmiCheckins: 0
    },
    NO_STORE
  );
}

function whatsappLink(contact, text) {
  const digits = String(contact || '').replace(/[^0-9]/g, '');
  if (digits.length < 8) {
    return '';
  }
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function templateDraft(name, language, purpose) {
  const first = firstWord(name) || (language === 'or' ? 'ଗ୍ରାହକ' : 'there');
  const topic = String(purpose || '').trim();
  if (language === 'or') {
    return (
      `ନମସ୍କାର ${first}, ସାଇ ହେଲ୍ଥ ହବ୍ ରୁ ଜଣାଉଛୁ। ` +
      (topic ? `ଆପଣଙ୍କ ${topic} ବିଷୟରେ ଆମେ ମନେ ପକାଉଛୁ। ` : 'ଆପଣଙ୍କ ସ୍ୱାସ୍ଥ୍ୟ ଲକ୍ଷ୍ୟ ବିଷୟରେ ଆମେ ମନେ ପକାଉଛୁ। ') +
      'ଆପଣଙ୍କ ପାଇଁ ଉପଯୁକ୍ତ ସମୟ କହିଲେ ଆମେ ଆଗାମୀ ପଦକ୍ଷେପ ବିଷୟରେ କଥା ହେବୁ। ଧନ୍ୟବାଦ। ସାଇ ହେଲ୍ଥ ହବ୍ — Healthy Habits. Better Living..'
    );
  }
  return (
    `Hello ${first}, this is Sai Health Hub. ` +
    (topic ? `We are following up about ${topic}. ` : 'We are following up on your health goals. ') +
    'Reply with a time that suits you and we will share the next practical step. Thank you. Sai Health Hub — Healthy Habits. Better Living..'
  );
}

function buildDraftPrompt(name, language, purpose) {
  const target = language === 'or' ? 'Odia (ଓଡ଼ିଆ script, not transliteration)' : 'English';
  return [
    'Write one short WhatsApp follow-up message for a health coaching customer.',
    `Customer first name: ${name}.`,
    `Language: ${target}. Reply only in that language.`,
    `Purpose: ${purpose || 'a friendly follow-up about their health goals'}.`,
    'Rules: 2 to 3 sentences, warm and professional, no medical claims, no diagnosis, no promised results,',
    'one clear next step, no emojis, no hashtags, no markdown, no quotation marks.',
    'Sign off as Sai Health Hub. Return only the message text.'
  ].join(' ');
}

async function handleOwnerDraft(req, res) {
  let body;
  try {
    body = await readOwnerBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message }, NO_STORE);
    return;
  }

  const kind = String((body && body.kind) || 'customer');
  const id = String((body && body.id) || '');
  const language = body && body.language === 'or' ? 'or' : 'en';
  const purpose = body && typeof body.purpose === 'string' ? body.purpose.slice(0, 160) : '';

  let name = '';
  let contact = '';
  let consent = false;
  let customerId = '';

  if (kind === 'lead') {
    const lead = (OwnerRecords.list('leads') || []).find((l) => String(l.id) === id);
    if (!lead) {
      sendJson(res, 404, { error: 'Lead not found.' }, NO_STORE);
      return;
    }
    name = lead.name || 'Lead';
    contact = lead.contact || '';
    consent = String(lead.consent || '') === 'Yes';
  } else if (kind === 'followup') {
    const followup = (OwnerRecords.list('followups') || []).find((f) => String(f.id) === id);
    if (!followup) {
      sendJson(res, 404, { error: 'Follow-up not found.' }, NO_STORE);
      return;
    }
    const customer = (OwnerRecords.list('customers') || []).find((c) => String(c.id) === String(followup.customerId));
    name = (customer && customer.name) || followup.name || 'Customer';
    contact = (customer && customer.contact) || followup.contact || '';
    consent = Boolean(customer ? customer.consent : followup.consent);
    customerId = customer ? String(customer.id) : '';
  } else {
    const customer = (OwnerRecords.list('customers') || []).find((c) => String(c.id) === id);
    if (!customer) {
      sendJson(res, 404, { error: 'Customer not found.' }, NO_STORE);
      return;
    }
    name = customer.name || 'Customer';
    contact = customer.contact || '';
    consent = Boolean(customer.consent);
    customerId = String(customer.id);
  }

  if (!consent) {
    sendJson(res, 403, { error: 'No recorded follow-up consent for this person, so no message was drafted.' }, NO_STORE);
    return;
  }

  let text = '';
  let source = 'template';
  let aiError = '';
  try {
    const raw = await generateAiText(process.env.GEMINI_API_KEY, buildDraftPrompt(firstWord(name), language, purpose));
    const cleaned = normalizeAiText(raw);
    if (cleaned) {
      text = cleaned;
      source = 'ai';
    }
  } catch (err) {
    aiError = (err && (err.publicMessage || err.message)) || 'AI unavailable';
  }

  if (!text) {
    text = templateDraft(name, language, purpose);
    source = 'template';
  }

  sendJson(
    res,
    200,
    {
      ok: true,
      text,
      source,
      language,
      name,
      contact,
      customerId,
      waLink: whatsappLink(contact, text),
      delivery: 'manual',
      aiError,
      note:
        'This app generates the message only. Sending happens in WhatsApp via the wa.me link; automatic delivery needs a WhatsApp Business API integration.'
    },
    NO_STORE
  );
}

const server = http.createServer((req, res) => {
  const pathname = pathnameOf(req.url || '/');
  const method = req.method || 'GET';

  try {
    if (HEALTH_PATHS.has(pathname)) {
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
        return;
      }
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (pathname === '/api/checkins') {
      if (method === 'GET') {
        handleListCheckins(req, res);
        return;
      }
      if (method === 'POST') {
        handleCreateCheckin(req, res).catch(() => {
          sendJson(res, 500, { error: 'Could not save this check-in.' });
        });
        return;
      }
      send(res, 405, 'Method Not Allowed', { Allow: 'GET, POST' });
      return;
    }

    const deleteMatch = /^\/api\/checkins\/([A-Za-z0-9-]{1,64})$/.exec(pathname);
    if (deleteMatch) {
      if (method === 'DELETE') {
        handleDeleteCheckin(req, res, deleteMatch[1]);
        return;
      }
      send(res, 405, 'Method Not Allowed', { Allow: 'DELETE' });
      return;
    }

    if (pathname === '/api/storage') {
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
        return;
      }
      handleStorageInfo(req, res);
      return;
    }

    if (pathname === '/api/state') {
      if (method === 'GET' || method === 'HEAD') {
        handleGetState(req, res);
        return;
      }
      if (method === 'PUT' || method === 'POST') {
        handlePutState(req, res).catch(() => {
          sendJson(res, 500, { error: 'Could not save this change.' });
        });
        return;
      }
      send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD, PUT, POST' });
      return;
    }

    if (pathname === '/api/owner/session') {
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
        return;
      }
      handleOwnerSession(req, res);
      return;
    }

    if (pathname === '/api/owner/setup') {
      if (method !== 'POST') {
        send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
        return;
      }
      handleOwnerSetup(req, res).catch(() => {
        sendJson(res, 500, { error: 'Could not create the owner password.' }, NO_STORE);
      });
      return;
    }

    if (pathname === '/api/owner/login') {
      if (method !== 'POST') {
        send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
        return;
      }
      handleOwnerLogin(req, res).catch(() => {
        sendJson(res, 500, { error: 'Could not sign in.' }, NO_STORE);
      });
      return;
    }

    if (pathname === '/api/owner/logout') {
      if (method !== 'POST') {
        send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
        return;
      }
      handleOwnerLogout(req, res);
      return;
    }

    if (pathname === '/api/owner/summary') {
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
        return;
      }
      if (!requireOwner(req, res)) return;
      handleOwnerSummary(req, res);
      return;
    }

    if (pathname === '/api/owner/reminders') {
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
        return;
      }
      if (!requireOwner(req, res)) return;
      handleOwnerReminders(req, res);
      return;
    }

    if (pathname === '/api/owner/whatsapp/draft') {
      if (method !== 'POST') {
        send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
        return;
      }
      if (!requireOwner(req, res)) return;
      handleOwnerDraft(req, res).catch(() => {
        sendJson(res, 500, { error: 'Could not prepare a WhatsApp draft.' }, NO_STORE);
      });
      return;
    }

    const ownerItemMatch = OWNER_ITEM_RE.exec(pathname);
    if (ownerItemMatch) {
      if (!requireOwner(req, res)) return;
      if (method !== 'PATCH' && method !== 'DELETE') {
        send(res, 405, 'Method Not Allowed', { Allow: 'PATCH, DELETE' });
        return;
      }
      handleOwnerItem(req, res, ownerItemMatch[1], ownerItemMatch[2], method).catch(() => {
        sendJson(res, 500, { error: 'Could not update this record.' }, NO_STORE);
      });
      return;
    }

    const ownerCollectionMatch = OWNER_COLLECTION_RE.exec(pathname);
    if (ownerCollectionMatch) {
      if (!requireOwner(req, res)) return;
      if (!['GET', 'PUT', 'POST', 'HEAD'].includes(method)) {
        send(res, 405, 'Method Not Allowed', { Allow: 'GET, PUT, POST' });
        return;
      }
      handleOwnerCollection(req, res, ownerCollectionMatch[1], method === 'HEAD' ? 'GET' : method).catch(() => {
        sendJson(res, 500, { error: 'Could not reach the record store.' }, NO_STORE);
      });
      return;
    }

    if (pathname === '/api/ai/status') {
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
        return;
      }
      sendJson(res, 200, aiStatus());
      return;
    }

    if (pathname === '/api/generate') {
      if (method !== 'POST') {
        send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
        return;
      }
      handleGenerate(req, res).catch(() => {
        sendJson(res, 500, { error: 'AI generation failed.' });
      });
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return;
    }

    const filePath = resolveFile(pathname);
    if (!filePath) {
      send(res, 400, 'Bad Request');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT' || err.code === 'EISDIR') {
          send(res, 404, 'Not Found');
        } else {
          send(res, 500, 'Internal Server Error');
        }
        return;
      }
      const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=300'
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(data);
      }
    });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal Server Error' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Sai Health Hub listening on http://${HOST}:${PORT}`);
  console.log(`Check-in storage driver: ${store.kind}`);
});

function shutdown() {
  store.close();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
