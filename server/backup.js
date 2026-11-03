// Single-file backups: the SQLite database plus every attachment, gzipped.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { backup, DatabaseSync } = require('node:sqlite');
const { SCHEMA_VERSION } = require('./db');

const FORMAT = 'coaching-hub-backup';

async function createBackup(db, dataDir) {
  const tmp = path.join(dataDir, `.backup-${process.pid}-${Date.now()}.sqlite`);
  try {
    await backup(db, tmp);
    const attDir = path.join(dataDir, 'attachments');
    const files = fs.existsSync(attDir) ? fs.readdirSync(attDir).filter((f) => fs.statSync(path.join(attDir, f)).isFile()) : [];
    const payload = {
      format: FORMAT,
      version: 1,
      schema: SCHEMA_VERSION,
      created_at: new Date().toISOString(),
      db: fs.readFileSync(tmp).toString('base64'),
      files: files.map((name) => ({ name, data: fs.readFileSync(path.join(attDir, name)).toString('base64') })),
    };
    return zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function backupName(prefix = 'coaching-hub') {
  return `${prefix}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.chbackup`;
}

// Check a backup without touching live data.
function inspectBackup(buf) {
  let payload;
  try {
    payload = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  } catch {
    throw Object.assign(new Error('This is not a Coaching Hub backup file'), { status: 400 });
  }
  if (payload.format !== FORMAT) throw Object.assign(new Error('This is not a Coaching Hub backup file'), { status: 400 });
  if (payload.schema > SCHEMA_VERSION) throw Object.assign(new Error('This backup was made by a newer version of the app. Update the app first.'), { status: 400 });
  return payload;
}

// Replace live data with a backup. The caller must close the database first
// and reopen it afterwards. A safety copy of the current data is written to
// backups/ before anything is replaced.
function restoreFiles(payload, dataDir) {
  const tmp = path.join(dataDir, '.restore.sqlite');
  fs.writeFileSync(tmp, Buffer.from(payload.db, 'base64'));
  const check = new DatabaseSync(tmp);
  try {
    const ok = check.prepare('PRAGMA integrity_check').get();
    if (Object.values(ok)[0] !== 'ok') throw Object.assign(new Error('Backup database failed its integrity check'), { status: 400 });
    check.prepare('SELECT COUNT(*) FROM athletes').get();
  } finally {
    check.close();
  }
  const dbFile = path.join(dataDir, 'coaching-hub.sqlite');
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  fs.renameSync(tmp, dbFile);
  const attDir = path.join(dataDir, 'attachments');
  const old = attDir + '.old';
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(attDir)) fs.renameSync(attDir, old);
  fs.mkdirSync(attDir, { recursive: true });
  for (const f of payload.files) {
    const name = path.basename(f.name);
    fs.writeFileSync(path.join(attDir, name), Buffer.from(f.data, 'base64'));
  }
  fs.rmSync(old, { recursive: true, force: true });
  return { files: payload.files.length, created_at: payload.created_at };
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.chbackup')).map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { name: f, size: st.size, modified: st.mtime.toISOString() };
  }).sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

function prune(dir, keep, prefix) {
  const list = listBackups(dir).filter((b) => b.name.startsWith(prefix));
  for (const b of list.slice(keep)) fs.rmSync(path.join(dir, b.name), { force: true });
}

module.exports = { createBackup, backupName, inspectBackup, restoreFiles, listBackups, prune };
