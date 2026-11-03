'use strict';
// Where the data lives, and a simple "one Mac at a time" guard for when the
// data folder is shared through iCloud Drive.
//
// The local folder (~/Library/Application Support/CoachingHub) always exists.
// If the data has been moved to iCloud Drive, a small location.json in the
// local folder points at it. Each Mac keeps its own pointer.
//
// While a Mac is using shared data it writes in-use.json in the shared folder
// and refreshes it every minute. Another Mac that sees a fresh in-use.json from
// a different computer shows a warning instead of opening the data. After 15
// minutes without use the app lets go of the data, so leaving the app running
// on one Mac doesn't lock the other one out.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dbm = require('./db');

const SHARED_NAME = 'Coaching Hub';
const STALE_MS = 3 * 60 * 1000;

function computerName() {
  const h = os.hostname().replace(/\.local$/, '');
  return h.replace(/-/g, ' ');
}

function pointerFile(localDir) {
  return path.join(localDir, 'location.json');
}

function readPointer(localDir) {
  try {
    const p = JSON.parse(fs.readFileSync(pointerFile(localDir), 'utf8'));
    return p && typeof p.dataDir === 'string' ? p.dataDir : null;
  } catch {
    return null;
  }
}

function writePointer(localDir, dir) {
  fs.mkdirSync(localDir, { recursive: true });
  if (!dir) fs.rmSync(pointerFile(localDir), { force: true });
  else fs.writeFileSync(pointerFile(localDir), JSON.stringify({ dataDir: dir, changed: new Date().toISOString() }, null, 2));
}

// The folder the app should use: env override, then pointer, then local.
function resolveDataDir(localDir = dbm.defaultDataDir()) {
  if (process.env.COACHING_HUB_DATA) return process.env.COACHING_HUB_DATA;
  return readPointer(localDir) || localDir;
}

function icloudRoot(home = os.homedir()) {
  return path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
}

function isShared(dir) {
  return /Mobile Documents|CloudDocs/.test(dir);
}

class Lock {
  constructor(dataDir, { id = `${os.hostname()}#${process.pid}`, name = computerName(), now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'in-use.json');
    this.id = id;
    this.name = name;
    this.now = now;
    this.held = false;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  // Someone else is using the data right now?
  other() {
    const l = this.read();
    if (!l || l.id === this.id) return null;
    if (this.now() - Date.parse(l.heartbeat) > STALE_MS) return null;
    return l;
  }

  acquire(force = false) {
    const o = this.other();
    if (o && !force) return { ok: false, other: o };
    const prev = this.read();
    const since = this.held && prev && prev.id === this.id ? prev.since : new Date(this.now()).toISOString();
    fs.writeFileSync(this.file, JSON.stringify({ id: this.id, name: this.name, since, heartbeat: new Date(this.now()).toISOString() }));
    this.held = true;
    return { ok: true, tookOver: o || null };
  }

  beat() {
    if (!this.held) return;
    const l = this.read();
    if (l && l.id !== this.id) {
      // Another Mac took over (they chose "open anyway"). Stop using the data.
      this.held = false;
      return false;
    }
    this.acquire(true);
    return true;
  }

  release() {
    if (!this.held) return;
    const l = this.read();
    if (l && l.id === this.id) fs.rmSync(this.file, { force: true });
    this.held = false;
  }
}

module.exports = { SHARED_NAME, STALE_MS, computerName, readPointer, writePointer, resolveDataDir, icloudRoot, isShared, Lock };
