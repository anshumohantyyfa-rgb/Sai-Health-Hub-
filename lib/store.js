'use strict';

/*
 * Persistent storage for Sai Health Hub check-ins.
 *
 * Driver order:
 *   1. SQLite through node:sqlite (Node 22.5+/24/26 — the deployed image runs Node 26)
 *   2. JSON file with atomic writes (older runtimes, such as the local Node 20 sandbox)
 *   3. In-memory (last resort; reported honestly by GET /api/storage)
 *
 * Every record is scoped to an anonymous client id, so one browser can never
 * read or delete another browser's history. All SQL uses bound parameters.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const SQLITE_FILE = path.join(DATA_DIR, 'checkins.db');
const JSON_FILE = path.join(DATA_DIR, 'checkins.json');
const STATE_JSON_FILE = path.join(DATA_DIR, 'state.json');
const MAX_PER_CLIENT = Number(process.env.MAX_CHECKINS_PER_CLIENT) || 500;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function rowToRecord(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    heightCm: row.height_cm,
    weightKg: row.weight_kg,
    bmi: row.bmi,
    categoryId: row.category_id,
    categoryLabel: row.category_label,
    note: row.note || '',
    lang: row.lang || 'en',
    createdAt: row.created_at
  };
}

function createSqliteStore() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (err) {
    return null;
  }
  if (typeof DatabaseSync !== 'function') {
    return null;
  }

  try {
    ensureDataDir();
    const db = new DatabaseSync(SQLITE_FILE);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(
      `CREATE TABLE IF NOT EXISTS checkins (
         id TEXT PRIMARY KEY,
         client_id TEXT NOT NULL,
         height_cm REAL NOT NULL,
         weight_kg REAL NOT NULL,
         bmi REAL NOT NULL,
         category_id TEXT NOT NULL,
         category_label TEXT NOT NULL,
         note TEXT NOT NULL DEFAULT '',
         lang TEXT NOT NULL DEFAULT 'en',
         created_at TEXT NOT NULL
       )`
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS checkins_client_idx ON checkins (client_id, created_at DESC)'
    );
    // Generic per-browser key/value store used by the app panels (see /api/state).
    db.exec(
      `CREATE TABLE IF NOT EXISTS app_state (
         client_id TEXT NOT NULL,
         key TEXT NOT NULL,
         value TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (client_id, key)
       )`
    );

    const insert = db.prepare(
      `INSERT INTO checkins
         (id, client_id, height_cm, weight_kg, bmi, category_id, category_label, note, lang, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const selectList = db.prepare(
      'SELECT * FROM checkins WHERE client_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
    );
    const selectOne = db.prepare('SELECT * FROM checkins WHERE id = ? AND client_id = ?');
    const deleteOne = db.prepare('DELETE FROM checkins WHERE id = ? AND client_id = ?');
    const countAll = db.prepare('SELECT COUNT(*) AS n FROM checkins');
    const countFor = db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE client_id = ?');
    const trim = db.prepare(
      `DELETE FROM checkins
        WHERE client_id = ?
          AND id NOT IN (
            SELECT id FROM checkins WHERE client_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
          )`
    );
    const stateSelect = db.prepare('SELECT key, value FROM app_state WHERE client_id = ?');
    const stateUpsert = db.prepare(
      `INSERT INTO app_state (client_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(client_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );

    return {
      kind: 'sqlite',
      location: SQLITE_FILE,
      add(record) {
        insert.run(
          record.id,
          record.clientId,
          record.heightCm,
          record.weightKg,
          record.bmi,
          record.categoryId,
          record.categoryLabel,
          record.note,
          record.lang,
          record.createdAt
        );
        // Keep the per-client history bounded.
        trim.run(record.clientId, record.clientId, MAX_PER_CLIENT);
        return record;
      },
      list(clientId, limit) {
        return selectList.all(clientId, limit).map(rowToRecord);
      },
      get(id, clientId) {
        const row = selectOne.get(id, clientId);
        return row ? rowToRecord(row) : null;
      },
      remove(id, clientId) {
        const info = deleteOne.run(id, clientId);
        return Number(info.changes) > 0;
      },
      total() {
        return Number(countAll.get().n);
      },
      countFor(clientId) {
        return Number(countFor.get(clientId).n);
      },
      stateAll(clientId) {
        const out = {};
        stateSelect.all(clientId).forEach((row) => {
          out[row.key] = row.value;
        });
        return out;
      },
      stateSet(clientId, key, value) {
        stateUpsert.run(clientId, key, value, new Date().toISOString());
        return true;
      },
      exportAll() {
        const checkinRows = db
          .prepare('SELECT * FROM checkins ORDER BY created_at DESC')
          .all()
          .map(rowToRecord);
        const stateRows = db
          .prepare('SELECT client_id, key, value, updated_at FROM app_state')
          .all()
          .map((row) => ({
            clientId: row.client_id,
            key: row.key,
            value: row.value,
            updatedAt: row.updated_at
          }));
        return { checkins: checkinRows, state: stateRows };
      },
      close() {
        try {
          db.close();
        } catch (err) {
          /* already closed */
        }
      }
    };
  } catch (err) {
    console.error('SQLite storage unavailable:', err.message);
    return null;
  }
}

function createJsonStore() {
  try {
    ensureDataDir();
    let records = [];
    if (fs.existsSync(JSON_FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
        if (Array.isArray(parsed)) {
          records = parsed;
        }
      } catch (err) {
        records = [];
      }
    }

    let state = {};
    if (fs.existsSync(STATE_JSON_FILE)) {
      try {
        const parsedState = JSON.parse(fs.readFileSync(STATE_JSON_FILE, 'utf8'));
        if (parsedState && typeof parsedState === 'object' && !Array.isArray(parsedState)) {
          state = parsedState;
        }
      } catch (err) {
        state = {};
      }
    }

    function persist() {
      const tmp = `${JSON_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 });
      fs.renameSync(tmp, JSON_FILE);
    }

    function persistState() {
      const tmp = `${STATE_JSON_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, STATE_JSON_FILE);
    }

    return {
      kind: 'json',
      location: JSON_FILE,
      add(record) {
        records.push(record);
        const own = records.filter((item) => item.clientId === record.clientId);
        if (own.length > MAX_PER_CLIENT) {
          const drop = new Set(
            own.slice(0, own.length - MAX_PER_CLIENT).map((item) => item.id)
          );
          records = records.filter((item) => !drop.has(item.id));
        }
        persist();
        return record;
      },
      list(clientId, limit) {
        return records
          .filter((item) => item.clientId === clientId)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
          .slice(0, limit);
      },
      get(id, clientId) {
        return records.find((item) => item.id === id && item.clientId === clientId) || null;
      },
      remove(id, clientId) {
        const before = records.length;
        records = records.filter((item) => !(item.id === id && item.clientId === clientId));
        if (records.length !== before) {
          persist();
          return true;
        }
        return false;
      },
      total() {
        return records.length;
      },
      countFor(clientId) {
        return records.filter((item) => item.clientId === clientId).length;
      },
      stateAll(clientId) {
        return Object.assign({}, state[clientId] || {});
      },
      stateSet(clientId, key, value) {
        state[clientId] = state[clientId] || {};
        state[clientId][key] = value;
        persistState();
        return true;
      },
      exportAll() {
        const stateRows = [];
        Object.keys(state).forEach((clientId) => {
          Object.keys(state[clientId]).forEach((key) => {
            stateRows.push({ clientId, key, value: state[clientId][key] });
          });
        });
        return { checkins: records.map((item) => Object.assign({}, item)), state: stateRows };
      },
      close() {}
    };
  } catch (err) {
    console.error('JSON storage unavailable:', err.message);
    return null;
  }
}

function createMemoryStore() {
  let records = [];
  const state = new Map();
  return {
    kind: 'memory',
    location: null,
    add(record) {
      records.push(record);
      return record;
    },
    list(clientId, limit) {
      return records
        .filter((item) => item.clientId === clientId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, limit);
    },
    get(id, clientId) {
      return records.find((item) => item.id === id && item.clientId === clientId) || null;
    },
    remove(id, clientId) {
      const before = records.length;
      records = records.filter((item) => !(item.id === id && item.clientId === clientId));
      return records.length !== before;
    },
    total() {
      return records.length;
    },
    countFor(clientId) {
      return records.filter((item) => item.clientId === clientId).length;
    },
    stateAll(clientId) {
      return Object.assign({}, state.get(clientId) || {});
    },
    stateSet(clientId, key, value) {
      const own = state.get(clientId) || {};
      own[key] = value;
      state.set(clientId, own);
      return true;
    },
    exportAll() {
      const stateRows = [];
      state.forEach((own, clientId) => {
        Object.keys(own).forEach((key) => {
          stateRows.push({ clientId, key, value: own[key] });
        });
      });
      return { checkins: records.map((item) => Object.assign({}, item)), state: stateRows };
    },
    close() {}
  };
}

/*
 * Optional Supabase (PostgREST) driver — the free-tier durable option.
 *
 * Enabled only when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY exist in the
 * server environment. The service-role key stays inside this Node process: the
 * browser only ever talks to this server, never to Supabase directly.
 *
 * The app's store interface is synchronous, so this driver keeps an in-memory
 * mirror hydrated at boot and writes through to Supabase in the background.
 * Reads stay synchronous; durability comes from the remote table.
 */
function createSupabaseStore() {
  const rawUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!rawUrl || !serviceKey) return null;
  if (typeof fetch !== 'function') {
    console.error('Supabase configured but this runtime has no fetch; using local storage.');
    return null;
  }

  const status = {
    configured: true,
    connected: false,
    pending: 0,
    failed: 0,
    lastError: null,
    lastSyncAt: null,
    endpoint: rawUrl.replace(/^https?:\/\//, '').split('/')[0]
  };

  let checkins = [];
  let state = new Map();
  let queue = Promise.resolve();

  const baseHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };

  function api(pathAndQuery, options) {
    const settings = Object.assign({ method: 'GET' }, options || {});
    settings.headers = Object.assign({}, baseHeaders, settings.headers || {});
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      settings.signal = AbortSignal.timeout(8000);
    }
    return fetch(`${rawUrl}/rest/v1/${pathAndQuery}`, settings);
  }

  function enqueue(label, run) {
    status.pending += 1;
    queue = queue
      .then(run)
      .then((response) => {
        if (response && response.ok === false) throw new Error(`HTTP ${response.status}`);
        status.lastSyncAt = new Date().toISOString();
        status.lastError = null;
      })
      .catch((error) => {
        status.failed += 1;
        status.lastError = `${label}: ${error.message}`;
        console.error(`Supabase write failed (${label}): ${error.message}`);
      })
      .then(() => {
        status.pending = Math.max(0, status.pending - 1);
      });
    return queue;
  }

  async function hydrate() {
    try {
      const [checkinRes, stateRes] = await Promise.all([
        api('checkins?select=*&order=created_at.desc&limit=5000'),
        api('app_state?select=*&limit=5000')
      ]);
      if (!checkinRes.ok || !stateRes.ok) {
        throw new Error(`HTTP ${!checkinRes.ok ? checkinRes.status : stateRes.status}`);
      }
      const checkinRows = await checkinRes.json();
      const stateRows = await stateRes.json();
      checkins = (Array.isArray(checkinRows) ? checkinRows : []).map(rowToRecord);
      state = new Map();
      (Array.isArray(stateRows) ? stateRows : []).forEach((row) => {
        const own = state.get(row.client_id) || {};
        own[row.key] = row.value;
        state.set(row.client_id, own);
      });
      status.connected = true;
      status.lastSyncAt = new Date().toISOString();
      return true;
    } catch (error) {
      status.lastError = `hydrate: ${error.message}`;
      console.error('Supabase hydration failed:', error.message);
      return false;
    }
  }

  const store = {
    kind: 'supabase',
    location: status.endpoint,
    add(record) {
      checkins.unshift(record);
      const own = checkins.filter((item) => item.clientId === record.clientId);
      let dropped = [];
      if (own.length > MAX_PER_CLIENT) {
        dropped = own.slice(MAX_PER_CLIENT);
        const dropIds = new Set(dropped.map((item) => item.id));
        checkins = checkins.filter((item) => !dropIds.has(item.id));
      }
      enqueue('insert checkin', () =>
        api('checkins', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([
            {
              id: record.id,
              client_id: record.clientId,
              height_cm: record.heightCm,
              weight_kg: record.weightKg,
              bmi: record.bmi,
              category_id: record.categoryId,
              category_label: record.categoryLabel,
              note: record.note,
              lang: record.lang,
              created_at: record.createdAt
            }
          ])
        })
      );
      dropped.forEach((item) =>
        enqueue('trim checkin', () =>
          api(`checkins?id=eq.${encodeURIComponent(item.id)}`, { method: 'DELETE' })
        )
      );
      return record;
    },
    list(clientId, limit) {
      return checkins
        .filter((item) => item.clientId === clientId)
        .slice(0, limit);
    },
    get(id, clientId) {
      return checkins.find((item) => item.id === id && item.clientId === clientId) || null;
    },
    remove(id, clientId) {
      const before = checkins.length;
      checkins = checkins.filter((item) => !(item.id === id && item.clientId === clientId));
      if (checkins.length === before) return false;
      enqueue('delete checkin', () =>
        api(`checkins?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}`, {
          method: 'DELETE'
        })
      );
      return true;
    },
    total() {
      return checkins.length;
    },
    countFor(clientId) {
      return checkins.filter((item) => item.clientId === clientId).length;
    },
    stateAll(clientId) {
      return Object.assign({}, state.get(clientId) || {});
    },
    stateSet(clientId, key, value) {
      const own = state.get(clientId) || {};
      own[key] = value;
      state.set(clientId, own);
      enqueue('upsert state', () =>
        api('app_state?on_conflict=client_id,key', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([
            { client_id: clientId, key, value, updated_at: new Date().toISOString() }
          ])
        })
      );
      return true;
    },
    exportAll() {
      const stateRows = [];
      state.forEach((own, clientId) => {
        Object.keys(own).forEach((key) => {
          stateRows.push({ clientId, key, value: own[key] });
        });
      });
      return { checkins: checkins.map((item) => Object.assign({}, item)), state: stateRows };
    },
    flush() {
      return queue.catch(() => {});
    },
    info() {
      return {
        driver: 'supabase',
        durable: true,
        survivesRedeploy: true,
        remote: true,
        connected: status.connected,
        endpoint: status.endpoint,
        pending: status.pending,
        failed: status.failed,
        lastError: status.lastError,
        lastSyncAt: status.lastSyncAt,
        records: checkins.length
      };
    },
    close() {}
  };

  return { store, hydrate, status };
}

function decorateLocal(local) {
  if (!local.info) {
    local.info = () => ({
      driver: local.kind,
      durable: local.kind !== 'memory',
      survivesRedeploy: false,
      remote: false,
      records: local.total()
    });
  }
  if (!local.exportAll) {
    local.exportAll = () => ({ checkins: [], state: [] });
  }
  if (!local.flush) {
    local.flush = () => Promise.resolve();
  }
  local.ready = Promise.resolve(local);
  return local;
}

function createStore() {
  const remote = createSupabaseStore();
  if (!remote) {
    return decorateLocal(createSqliteStore() || createJsonStore() || createMemoryStore());
  }

  const fallback = decorateLocal(createSqliteStore() || createJsonStore() || createMemoryStore());
  let active = fallback;
  let mode = 'pending';

  const ready = remote.hydrate().then((ok) => {
    if (ok) {
      active = remote.store;
      mode = 'remote';
      if (fallback.close) fallback.close();
      console.log(`Supabase persistence active (${remote.store.location}).`);
    } else {
      mode = 'local-fallback';
      console.error('Supabase unreachable at boot; using the local store for this run.');
    }
    return active;
  });

  const proxy = {
    ready,
    add: (record) => active.add(record),
    list: (clientId, limit) => active.list(clientId, limit),
    get: (id, clientId) => active.get(id, clientId),
    remove: (id, clientId) => active.remove(id, clientId),
    total: () => active.total(),
    countFor: (clientId) => active.countFor(clientId),
    stateAll: (clientId) => active.stateAll(clientId),
    stateSet: (clientId, key, value) => active.stateSet(clientId, key, value),
    exportAll: () => active.exportAll(),
    flush: () => active.flush(),
    info() {
      const base = active.info();
      return Object.assign({}, base, {
        supabaseConfigured: true,
        supabaseActive: mode === 'remote',
        fallbackReason: mode === 'local-fallback' ? remote.status.lastError : null
      });
    },
    close() {
      if (fallback.close) fallback.close();
    }
  };
  Object.defineProperty(proxy, 'kind', { get: () => active.kind, enumerable: true });
  Object.defineProperty(proxy, 'location', { get: () => active.location, enumerable: true });
  return proxy;
}

function newRecord(input) {
  return {
    id: crypto.randomUUID(),
    clientId: input.clientId,
    heightCm: input.heightCm,
    weightKg: input.weightKg,
    bmi: input.bmi,
    categoryId: input.categoryId,
    categoryLabel: input.categoryLabel,
    note: input.note || '',
    lang: input.lang || 'en',
    createdAt: new Date().toISOString()
  };
}

module.exports = { createStore, createSupabaseStore, newRecord, DATA_DIR };
