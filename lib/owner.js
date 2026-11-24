'use strict';

/*
 * Owner authentication for the Sai Health Hub console.
 *
 * The owner password is never stored in plain text and never shipped to the
 * browser. Two sources are supported, in priority order:
 *   1. OWNER_PASSWORD environment variable (recommended for deployments).
 *   2. A first-run password that the owner creates in the UI, stored as a
 *      scrypt hash with a random salt in data/owner.json (mode 0600).
 *
 * Sessions are opaque random tokens held server-side with an expiry, and the
 * browser only receives an HttpOnly cookie, so page scripts cannot read it.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const OWNER_FILE = path.join(DATA_DIR, 'owner.json');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const envPassword = typeof process.env.OWNER_PASSWORD === 'string' ? process.env.OWNER_PASSWORD : '';
const envRecord = envPassword
  ? hashPassword(envPassword)
  : null;

const sessions = new Map();
const attempts = new Map();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  return { salt: useSalt, hash: crypto.scryptSync(password, useSalt, 64).toString('hex') };
}

function verifyPassword(password, record) {
  if (!record || typeof record.salt !== 'string' || typeof record.hash !== 'string') {
    return false;
  }
  try {
    const actual = crypto.scryptSync(password, record.salt, 64);
    const expected = Buffer.from(record.hash, 'hex');
    if (actual.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(actual, expected);
  } catch (err) {
    return false;
  }
}

function readStoredRecord() {
  try {
    const raw = fs.readFileSync(OWNER_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.salt === 'string' && typeof parsed.hash === 'string') {
      return parsed;
    }
    return null;
  } catch (err) {
    return null;
  }
}

function writeStoredRecord(record) {
  ensureDataDir();
  const tmp = `${OWNER_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, OWNER_FILE);
}

function passwordSource() {
  if (envRecord) {
    return 'environment';
  }
  return readStoredRecord() ? 'stored' : 'none';
}

function passwordConfigured() {
  return passwordSource() !== 'none';
}

function activeRecord() {
  return envRecord || readStoredRecord();
}

/** Create the first-run password. Refused once a password already exists. */
function setInitialPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Choose a password with at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (passwordConfigured()) {
    return { ok: false, error: 'An owner password is already configured.' };
  }
  writeStoredRecord(Object.assign(hashPassword(password), { createdAt: new Date().toISOString() }));
  return { ok: true };
}

function rateLimited(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function noteFailure(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearFailures(ip) {
  attempts.delete(String(ip || 'unknown'));
}

function checkPassword(password) {
  if (typeof password !== 'string' || !password) {
    return false;
  }
  return verifyPassword(password, activeRecord());
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function validSession(token) {
  if (typeof token !== 'string' || !token) {
    return false;
  }
  const session = sessions.get(token);
  if (!session) {
    return false;
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  if (typeof token === 'string') {
    sessions.delete(token);
  }
}

function sessionTtlSeconds() {
  return Math.floor(SESSION_TTL_MS / 1000);
}

module.exports = {
  SESSION_TTL_MS,
  MIN_PASSWORD_LENGTH,
  passwordConfigured,
  passwordSource,
  setInitialPassword,
  checkPassword,
  createSession,
  validSession,
  destroySession,
  sessionTtlSeconds,
  rateLimited,
  noteFailure,
  clearFailures
};
