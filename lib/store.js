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

    function persist() {
      const tmp = `${JSON_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 });
      fs.renameSync(tmp, JSON_FILE);
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
      close() {}
    };
  } catch (err) {
    console.error('JSON storage unavailable:', err.message);
    return null;
  }
}

function createMemoryStore() {
  let records = [];
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
    close() {}
  };
}

function createStore() {
  return createSqliteStore() || createJsonStore() || createMemoryStore();
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

module.exports = { createStore, newRecord, DATA_DIR };
