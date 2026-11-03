// SQLite storage using Node's built-in node:sqlite module (no npm packages).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

function defaultDataDir() {
  if (process.env.COACHING_HUB_DATA) return process.env.COACHING_HUB_DATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'CoachingHub');
  return path.join(os.homedir(), '.coaching-hub');
}

// Each migration runs once, in order. Never edit a migration that has
// shipped; add a new one instead.
const MIGRATIONS = [
  `
  CREATE TABLE athletes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    preferred_name TEXT,
    sport TEXT NOT NULL DEFAULT 'triathlon',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','former')),
    start_date TEXT,
    birthday TEXT,
    timezone TEXT,
    email TEXT,
    phone TEXT,
    goals TEXT,
    phase TEXT,
    photo_id INTEGER,
    checkin_days INTEGER DEFAULT 7,
    review_days INTEGER DEFAULT 28,
    test_days_json TEXT DEFAULT '{"swim":56,"bike":56,"run":56}',
    profile_json TEXT NOT NULL DEFAULT '{}',
    health_json TEXT NOT NULL DEFAULT '{}',
    last_review_date TEXT,
    is_sample INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE races (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    location TEXT, timezone TEXT, sport TEXT, distance TEXT,
    priority TEXT NOT NULL DEFAULT 'B' CHECK (priority IN ('A','B','C')),
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','DNS','DNF','cancelled')),
    goal TEXT, target TEXT, result TEXT, splits TEXT,
    course TEXT, travel TEXT, report TEXT, lessons TEXT, recovery TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tests (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    discipline TEXT NOT NULL CHECK (discipline IN ('swim','bike','run','hr','lab','other')),
    test_type TEXT NOT NULL,
    date TEXT NOT NULL,
    protocol TEXT,
    raw_json TEXT NOT NULL DEFAULT '{}',
    raw_summary TEXT,
    derived_metric TEXT, derived_value REAL, derived_unit TEXT, method TEXT,
    conditions TEXT, source TEXT,
    accepted INTEGER NOT NULL DEFAULT 0,
    effective_from TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE activities (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    sport TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','missed','modified','planned')),
    duration_min REAL, planned_min REAL,
    distance_km REAL,
    load REAL, load_type TEXT,
    rpe REAL,
    comments TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    source_ref TEXT,
    import_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX activities_dedupe ON activities(athlete_id, source_ref) WHERE source_ref IS NOT NULL;
  CREATE INDEX activities_date ON activities(athlete_id, date);
  CREATE TABLE weekly_logs (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    week_start TEXT NOT NULL,
    planned_json TEXT, completed_json TEXT,
    sessions_planned INTEGER, sessions_done INTEGER,
    sleep INTEGER, fatigue INTEGER, soreness INTEGER, stress INTEGER, motivation INTEGER,
    athlete_comments TEXT, missed_reasons TEXT, coach_notes TEXT, next_actions TEXT,
    brief TEXT,
    reviewed_at TEXT,
    UNIQUE (athlete_id, week_start)
  );
  CREATE TABLE plan_weeks (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    week_start TEXT NOT NULL,
    phase TEXT, hours_min REAL, hours_max REAL, sport_hours_json TEXT,
    focus TEXT, intensity TEXT, key_sessions TEXT, recovery TEXT, milestone TEXT, rationale TEXT,
    UNIQUE (athlete_id, week_start)
  );
  CREATE TABLE plan_versions (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    note TEXT,
    snapshot_json TEXT NOT NULL
  );
  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    origin TEXT NOT NULL CHECK (origin IN ('calculation','coach','ai')),
    title TEXT NOT NULL,
    body_json TEXT NOT NULL,
    changes_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','saved')),
    decided_at TEXT
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER REFERENCES athletes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'task',
    due_date TEXT, due_time TEXT, timezone TEXT,
    owner TEXT DEFAULT 'Jack',
    done INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'note',
    body TEXT NOT NULL,
    shareable INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER REFERENCES athletes(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime TEXT, size INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    filename TEXT, format TEXT,
    rows_total INTEGER, rows_added INTEGER, rows_duplicate INTEGER, rows_invalid INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    athlete_id INTEGER,
    entity TEXT, entity_id INTEGER, action TEXT, summary TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `,
];

// shared: the folder is synced by iCloud Drive. A single database file (no
// -wal/-shm side files) is safer there, because iCloud uploads files one by one.
function open(dataDir = defaultDataDir(), { shared = false } = {}) {
  fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  const file = path.join(dataDir, 'coaching-hub.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = ${shared ? 'DELETE' : 'WAL'};`);
  migrate(db);
  return { db, dataDir, file };
}

function migrate(db) {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, migrate, tx, defaultDataDir, SCHEMA_VERSION: MIGRATIONS.length };
