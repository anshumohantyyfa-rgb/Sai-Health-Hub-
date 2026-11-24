'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BmiCalc = require('./public/bmi.js');
const { createStore, newRecord } = require('./lib/store.js');

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
  if (!Array.isArray(value)) {
    return `The "${key}" collection must be an array.`;
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
  return {
    ok: true,
    configured: Boolean(process.env.GEMINI_API_KEY),
    provider: 'gemini',
    model: AI_MODEL
  };
}

function briefField(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function buildAiPrompt(body) {
  const parts = [
    'You are the creative assistant inside Sai Health Hub, a bilingual (English and Odia) health-habit coaching app for Khordha.',
    'Write factual, compliant, non-medical marketing copy. Never promise cures, guaranteed weight loss or medical outcomes.',
    'Return strict JSON only, with any of these keys: headline, body, cta, caption, hashtags, visual_direction, reel_script.'
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
  if (language) parts.push(`Language for the copy: ${language}.`);
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
    const text = parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();

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

async function handleGenerate(req, res) {
  const clientId = clientIdFor(req, res);

  if (isRateLimited(clientId)) {
    sendJson(res, 429, { error: 'Too many AI requests. Please wait a moment.' }, { 'Retry-After': '60' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
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
    const result = await callGemini(apiKey, buildAiPrompt(body));
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, err.status || 502, { error: err.publicMessage || 'AI generation failed.' });
  }
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
