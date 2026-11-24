'use strict';

/*
 * Shared owner records for the business modules (customers, coaching check-ins,
 * leads, follow-ups, contacts, consultations, content).
 *
 * v8 stores these as whole arrays, so this module mirrors that shape: a
 * collection is read and written as one array. Writes are atomic (temp file +
 * rename) and validated, so a half-written file can never be served.
 *
 * This is the single server-side home for owner data. The browser keeps a copy
 * for instant rendering, but the server copy is authoritative, which is what
 * makes records survive a reload, another device, or a cleared browser.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'owner-records.json');

const COLLECTIONS = new Set([
  'customers',
  'checkins',
  'leads',
  'followups',
  'businessContacts',
  'consultations',
  'content',
  'consentEvents'
]);

const MAX_ITEMS = 2000;
const MAX_ITEM_BYTES = 8000;

function emptyState() {
  const out = {};
  COLLECTIONS.forEach((name) => {
    out[name] = [];
  });
  return out;
}

let cache = null;

function load() {
  if (cache) {
    return cache;
  }
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const state = emptyState();
    if (parsed && typeof parsed === 'object') {
      Object.keys(state).forEach((name) => {
        if (Array.isArray(parsed[name])) {
          state[name] = parsed[name];
        }
      });
    }
    cache = state;
  } catch (err) {
    cache = emptyState();
  }
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return true;
  } catch (err) {
    console.error('Could not persist owner records:', err.message);
    return false;
  }
}

function isKnownCollection(name) {
  return COLLECTIONS.has(name);
}

function list(collection) {
  if (!isKnownCollection(collection)) {
    return null;
  }
  return load()[collection].slice();
}

function validateItems(collection, items) {
  if (!Array.isArray(items)) {
    return 'Items must be an array.';
  }
  if (items.length > MAX_ITEMS) {
    return `A collection can hold at most ${MAX_ITEMS} records.`;
  }
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return 'Every record must be an object.';
    }
    if (Buffer.byteLength(JSON.stringify(item)) > MAX_ITEM_BYTES) {
      return 'A record is too large to store.';
    }
  }
  if (collection === 'customers') {
    for (const item of items) {
      if (typeof item.name !== 'string' || !item.name.trim()) {
        return 'Every customer needs a name.';
      }
    }
  }
  return null;
}

function replace(collection, items) {
  if (!isKnownCollection(collection)) {
    return { ok: false, error: 'Unknown collection.' };
  }
  const problem = validateItems(collection, items);
  if (problem) {
    return { ok: false, error: problem };
  }
  const state = load();
  state[collection] = items;
  const persisted = persist();
  return { ok: true, items: state[collection], persisted };
}

function withId(record) {
  const out = Object.assign({}, record);
  if (out.id === undefined || out.id === null || out.id === '') {
    out.id = crypto.randomUUID();
  }
  return out;
}

function create(collection, record) {
  const current = list(collection);
  if (!current) {
    return { ok: false, error: 'Unknown collection.' };
  }
  const item = withId(record);
  current.unshift(item);
  const result = replace(collection, current.slice(0, MAX_ITEMS));
  if (!result.ok) {
    return result;
  }
  return { ok: true, item, items: result.items };
}

function update(collection, id, patch) {
  const current = list(collection);
  if (!current) {
    return { ok: false, error: 'Unknown collection.' };
  }
  const index = current.findIndex((item) => String(item.id) === String(id));
  if (index === -1) {
    return { ok: false, error: 'Record not found.', status: 404 };
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'Patch must be an object.' };
  }
  current[index] = Object.assign({}, current[index], patch, { id: current[index].id });
  const result = replace(collection, current);
  if (!result.ok) {
    return result;
  }
  return { ok: true, item: current[index], items: result.items };
}

function remove(collection, id) {
  const current = list(collection);
  if (!current) {
    return { ok: false, error: 'Unknown collection.' };
  }
  const next = current.filter((item) => String(item.id) !== String(id));
  if (next.length === current.length) {
    return { ok: false, error: 'Record not found.', status: 404 };
  }
  const result = replace(collection, next);
  if (!result.ok) {
    return result;
  }
  return { ok: true, items: result.items };
}

function counts() {
  const state = load();
  const out = {};
  Object.keys(state).forEach((name) => {
    out[name] = state[name].length;
  });
  return out;
}

function driverInfo() {
  return { kind: 'json-file', location: FILE };
}

module.exports = {
  COLLECTIONS,
  isKnownCollection,
  list,
  replace,
  create,
  update,
  remove,
  counts,
  driverInfo
};
