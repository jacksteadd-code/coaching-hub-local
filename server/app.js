// HTTP layer: static files plus a small JSON API. Listens on 127.0.0.1 only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dbm = require('./db');
const { Service } = require('./service');
const bk = require('./backup');
const sample = require('./sample');
const gs = require('./gsync');
const calc = require('./calc');
const loc = require('./location');
const watcher = require('./watcher');
const updater = require('./updater');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function createApp({ dataDir: startDir, localDir, today, port = 4747, fetchImpl, allowAnySyncUrl = false, syncDelayMs = 20000, home, lockOptions = {}, idleMs = 15 * 60 * 1000, onQuit, onRestart, watchMs = 30000, appDir = updater.APP_DIR } = {}) {
  localDir = localDir || startDir || dbm.defaultDataDir();
  let dataDir = startDir || localDir;
  const state = { conn: null, lock: new loc.Lock(dataDir, lockOptions), lastUse: Date.now() };

  // Open the data, unless another Mac is using the shared copy right now.
  function ensureOpen(force = false) {
    if (state.conn) return;
    const shared = loc.isShared(dataDir);
    if (shared) {
      if (!fs.existsSync(path.join(dataDir, 'coaching-hub.sqlite'))) throw Object.assign(new Error('Your data in iCloud Drive isn\'t on this Mac yet. Check iCloud Drive is switched on and give it a minute to download, then try again.'), { status: 503 });
      const r = state.lock.acquire(force);
      if (!r.ok) throw Object.assign(new Error(`Coaching Hub is open on ${r.other.name}.`), { status: 423, busy: r.other });
      if (r.tookOver) console.log(`Took over the data from ${r.tookOver.name}`);
    }
    state.conn = dbm.open(dataDir, { shared });
  }
  function closeData() {
    if (state.conn) state.conn.db.close();
    state.conn = null;
    state.lock.release();
  }
  try { ensureOpen(); } catch (e) { if (e.status !== 423 && e.status !== 503) throw e; }
  const svc = () => { ensureOpen(); return new Service(state.conn, { today }); };
  // Background jobs (hourly backup, calendar sync) shouldn't keep the shared
  // data locked when nobody is using the app on this Mac.
  async function background(fn) {
    const wasOpen = !!state.conn;
    try {
      return await fn();
    } finally {
      if (loc.isShared(dataDir) && (!wasOpen || Date.now() - state.lastUse > idleMs)) closeData();
    }
  }
  const tick = setInterval(() => {
    if (!state.conn || !loc.isShared(dataDir)) return;
    if (!state.lock.beat()) { console.log('Another Mac took over the data. Closed it here.'); state.conn.db.close(); state.conn = null; return; }
    if (Date.now() - state.lastUse > idleMs) closeData();
  }, 60 * 1000);
  tick.unref?.();
  const routes = [];
  const on = (method, pattern, handler, raw = false) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, raw });

  // ----- athletes -----
  on('GET', '/api/overview', () => svc().overview());
  on('GET', '/api/athletes', () => svc().listAthletes());
  on('POST', '/api/athletes', ({ body }) => svc().insert('athletes', body));
  on('GET', '/api/athletes/:id', ({ p }) => svc().athleteFull(+p.id));
  on('PUT', '/api/athletes/:id', ({ p, body }) => svc().update('athletes', +p.id, body));
  on('DELETE', '/api/athletes/:id', ({ p }) => svc().remove('athletes', +p.id));

  // ----- simple records -----
  for (const t of ['races', 'tests', 'activities', 'notes', 'tasks']) {
    on('POST', `/api/${t}`, ({ body }) => (t === 'tests' ? svc().addTest(body) : svc().insert(t, body)));
    on('PUT', `/api/${t}/:id`, ({ p, body }) => svc().update(t, +p.id, body));
    on('DELETE', `/api/${t}/:id`, ({ p }) => svc().remove(t, +p.id));
  }
  on('GET', '/api/tasks', ({ q }) => svc().listTasks({ status: q.get('status') || 'open' }));
  on('GET', '/api/races', () => {
    const s = svc();
    return s.db.prepare("SELECT r.*, a.name AS athlete_name, a.is_sample FROM races r JOIN athletes a ON a.id = r.athlete_id ORDER BY r.date").all().map((r) => ({ ...r }));
  });
  on('GET', '/api/tests', () => svc().db.prepare('SELECT t.*, a.name AS athlete_name, a.is_sample FROM tests t JOIN athletes a ON a.id = t.athlete_id ORDER BY t.date DESC').all().map((r) => ({ ...r })));

  // ----- weekly -----
  on('GET', '/api/athletes/:id/weeks/:week', ({ p }) => svc().weekDetail(+p.id, p.week));
  on('PUT', '/api/athletes/:id/weeks/:week', ({ p, body }) => svc().upsertWeek(+p.id, p.week, body));
  on('GET', '/api/review/:week', ({ p }) => svc().reviewQueue(p.week));

  // ----- plan -----
  on('POST', '/api/athletes/:id/plan/preview', ({ p, body }) => svc().previewPlan(+p.id, body.weeks || []));
  on('PUT', '/api/athletes/:id/plan', ({ p, body }) => {
    if (!body.confirmed) throw Object.assign(new Error('Plan changes need explicit confirmation'), { status: 400 });
    return svc().applyPlan(+p.id, body.weeks || [], body.note, { deleteWeeks: body.deleteWeeks || [] });
  });
  on('POST', '/api/athletes/:id/plan/shift-preview', ({ p, body }) => svc().shiftPreview(+p.id, body.from, body.to, +body.n));
  on('GET', '/api/plan-versions/:id', ({ p }) => {
    const v = svc().get('plan_versions', +p.id);
    return { ...v, snapshot: JSON.parse(v.snapshot_json) };
  });
  on('POST', '/api/plan-versions/:id/restore', ({ p, body }) => {
    if (!body.confirmed) throw Object.assign(new Error('Restoring a version needs explicit confirmation'), { status: 400 });
    return svc().restoreVersion(+p.id);
  });
  on('POST', '/api/athletes/:id/recommend', ({ p, body }) => svc().recommend(+p.id, body.weeksAhead || 4));
  on('POST', '/api/athletes/:id/ai-suggestion', ({ p, body }) => svc().saveAiSuggestion(+p.id, body.text, body.title));
  on('POST', '/api/athletes/:id/ai-summary', ({ p, body }) => ({ text: svc().aiSummary(+p.id, body) }));
  on('POST', '/api/proposals/:id/:decision', ({ p, body }) => svc().decideProposal(+p.id, p.decision, body));

  // ----- import -----
  on('POST', '/api/athletes/:id/import/preview', ({ p, body }) => svc().importPreview(+p.id, body));
  on('POST', '/api/athletes/:id/import/commit', ({ p, body }) => svc().importCommit(+p.id, body));
  on('DELETE', '/api/imports/:id', ({ p }) => svc().undoImport(+p.id));

  // ----- attachments -----
  on('POST', '/api/athletes/:id/attachments', ({ p, req, raw }) => {
    const a = svc().saveAttachment(+p.id, decodeURIComponent(req.headers['x-filename'] || 'file'), req.headers['content-type'], raw);
    if (req.headers['x-photo'] === '1') svc().update('athletes', +p.id, { photo_id: a.id });
    return a;
  }, true);
  on('DELETE', '/api/attachments/:id', ({ p }) => svc().removeAttachment(+p.id));

  // ----- calendar -----
  on('GET', '/api/calendar', () => ({ events: svc().calendarEvents(), settings: svc().settings().calendar, port }));

  // ----- Google Calendar sync (one-way, opt-in) -----
  function gsettings() {
    const s = svc();
    const g = s.settings().gsync;
    if (!g.secret) {
      g.secret = require('node:crypto').randomBytes(18).toString('hex');
      s.saveSettings({ gsync: g }, false);
    }
    return g;
  }
  function gpayload() {
    const s = svc();
    const today = s.today();
    const { events, skipped } = gs.toGoogleEvents(s.calendarEvents(), s.settings().timezone);
    return { events, skipped, from: calc.addDays(today, -gs.PAST_DAYS) + 'T00:00:00Z', to: calc.addDays(today, gs.FUTURE_DAYS) + 'T00:00:00Z' };
  }
  let syncing = null;
  async function googleSync(reason = 'manual') {
    if (reason === 'hourly' || reason === 'auto') {
      if (state.lock.other()) return null;
      return background(() => googleSyncNow(reason));
    }
    return googleSyncNow(reason);
  }
  async function googleSyncNow(reason) {
    const g = gsettings();
    if (!g.enabled || !g.url) return null;
    if (syncing) return syncing;
    syncing = (async () => {
      const { events, from, to } = gpayload();
      try {
        const r = await gs.post(g.url, { secret: g.secret, action: 'sync', from, to, events }, fetchImpl);
        const now = new Date().toISOString();
        svc().saveSettings({ gsync: { ...gsettings(), lastSync: now, lastResult: { created: r.created, updated: r.updated, deleted: r.deleted, unchanged: r.unchanged, total: events.length }, lastError: null } }, false);
        if (r.created || r.updated || r.deleted) svc().audit(null, 'calendar', null, 'sync', `Google Calendar sync (${reason}): ${r.created} added, ${r.updated} updated, ${r.deleted} removed`);
        return r;
      } catch (e) {
        svc().saveSettings({ gsync: { ...gsettings(), lastError: e.message, lastErrorAt: new Date().toISOString() } }, false);
        throw e;
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }
  let syncTimer = null;
  function scheduleSync() {
    if (!svc().settings().gsync.enabled) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => googleSync('auto').catch((e) => console.error('Google Calendar sync failed:', e.message)), syncDelayMs);
    syncTimer.unref?.();
  }
  on('GET', '/api/gsync', () => {
    const g = gsettings();
    const { events, skipped } = gpayload();
    return { ...g, calendarName: gs.CALENDAR_NAME, script: gs.scriptSource(g.secret), count: events.length, skipped };
  });
  on('POST', '/api/gsync/connect', async ({ body }) => {
    const url = String(body.url || '').trim();
    if (!gs.validUrl(url, allowAnySyncUrl)) throw Object.assign(new Error('That doesn\'t look like a web app link. It should start with https://script.google.com/macros/s/ and end with /exec.'), { status: 400 });
    const g = gsettings();
    await gs.post(url, { secret: g.secret, action: 'ping' }, fetchImpl);
    svc().saveSettings({ gsync: { ...g, url, lastError: null } }, false);
    svc().audit(null, 'calendar', null, 'connect', 'Connected Google Calendar sync (not switched on yet)');
    return { ok: true };
  });
  on('POST', '/api/gsync/enable', async ({ body }) => {
    const g = gsettings();
    if (body.enabled && !g.url) throw Object.assign(new Error('Connect the web app link first'), { status: 400 });
    svc().saveSettings({ gsync: { ...g, enabled: !!body.enabled } }, false);
    svc().audit(null, 'calendar', null, 'update', body.enabled ? 'Switched Google Calendar sync on' : 'Switched Google Calendar sync off');
    return body.enabled ? { ok: true, result: await googleSync('switched on') } : { ok: true };
  });
  on('POST', '/api/gsync/sync', async () => {
    if (!gsettings().enabled) throw Object.assign(new Error('Google Calendar sync is off'), { status: 400 });
    return { ok: true, result: await googleSync('manual') };
  });
  on('POST', '/api/gsync/disconnect', () => {
    svc().saveSettings({ gsync: { ...gsettings(), enabled: false, url: '', lastSync: null, lastResult: null, lastError: null } }, false);
    svc().audit(null, 'calendar', null, 'update', 'Disconnected Google Calendar sync (events already in Google stay until you delete the Coaching calendar)');
    return { ok: true };
  });

  // ----- automatic app updates -----
  const saveUpdates = (patch) => svc().saveSettings({ updates: { ...svc().settings().updates, ...patch } }, false);
  async function checkAndInstall({ force = false, installNow = false } = {}) {
    const u = svc().settings().updates;
    const opts = { repo: u.repo, branch: u.branch, appDir, fetchImpl };
    let r;
    try {
      r = await updater.check(opts);
    } catch (e) {
      saveUpdates({ lastCheck: new Date().toISOString(), lastError: e.message });
      throw Object.assign(e, { status: 502 });
    }
    saveUpdates({ lastCheck: new Date().toISOString(), lastResult: r, lastError: null });
    if (!r.available) return { ...r, installed: false };
    if (!updater.inAppBundle(appDir) && !force) return { ...r, installed: false, note: 'Updates install only in the Mac app' };
    if (!installNow && Date.now() - state.lastUse < 10 * 60 * 1000) return { ...r, installed: false, note: 'Waiting until the app is not in use' };
    const v = await updater.install({ ...opts, expect: r.latest });
    saveUpdates({ lastUpdated: new Date().toISOString(), lastUpdatedVersion: v });
    svc().audit(null, 'settings', null, 'update', `Coaching Hub updated from ${r.current} to ${v}`);
    if (onRestart) setTimeout(onRestart, 500);
    return { ...r, installed: true, version: v, restarting: !!onRestart };
  }
  async function autoUpdate() {
    if (state.lock.other() && !state.conn) return null;
    return background(async () => {
      const u = svc().settings().updates;
      if (!u.auto || !updater.inAppBundle(appDir)) return null;
      const waiting = u.lastResult && u.lastResult.available;
      if (!waiting && u.lastCheck && Date.now() - Date.parse(u.lastCheck) < 20 * 3600 * 1000) return null;
      return checkAndInstall();
    });
  }
  on('GET', '/api/updates', () => ({ ...svc().settings().updates, version: updater.localVersion(appDir), inBundle: updater.inAppBundle(appDir) }));
  on('PUT', '/api/updates', ({ body }) => { saveUpdates({ auto: !!body.auto }); return { ok: true }; });
  on('POST', '/api/updates/check', async () => checkAndInstall({ installNow: true }));

  // ----- automatic import folder -----
  function importFolder() {
    const a = svc().settings().autoImport;
    return a.folder || watcher.defaultFolder(home);
  }
  let importing = false;
  let aiCache = null;
  async function autoImport() {
    if (importing) return [];
    // Don't open shared data (and lock out the other Mac) just to read a setting.
    let a = aiCache;
    if (state.conn || !loc.isShared(dataDir)) {
      try { a = aiCache = svc().settings().autoImport; } catch { return []; }
    }
    if (!a) return [];
    if (!a.enabled) return [];
    const folder = a.folder || watcher.defaultFolder(home);
    let has = false;
    try { fs.mkdirSync(folder, { recursive: true }); has = fs.readdirSync(folder).some((f) => /\.csv$/i.test(f) && !f.startsWith('.')); } catch { return []; }
    if (!has || state.lock.other()) return [];
    importing = true;
    try {
      return await background(() => {
        const entries = watcher.processFolder(svc(), folder);
        if (entries.length) {
          const cur = svc().settings().autoImport;
          svc().saveSettings({ autoImport: { ...cur, log: [...entries.reverse(), ...(cur.log || [])].slice(0, 40) } }, false);
          scheduleSync();
        }
        return entries;
      });
    } finally {
      importing = false;
    }
  }
  const watchTimer = watchMs ? setInterval(() => autoImport().catch((e) => console.error('Automatic import failed:', e.message)), watchMs) : null;
  watchTimer?.unref?.();
  on('GET', '/api/autoimport', () => {
    const a = svc().settings().autoImport;
    return { ...a, folder: importFolder(), defaultFolder: watcher.defaultFolder(home), isDefault: !a.folder };
  });
  on('PUT', '/api/autoimport', ({ body }) => {
    const cur = svc().settings().autoImport;
    const next = { ...cur, enabled: body.enabled ?? cur.enabled, folder: body.folder != null ? String(body.folder).trim() : cur.folder };
    svc().saveSettings({ autoImport: next });
    return next;
  });
  on('POST', '/api/autoimport/run', async () => ({ entries: await autoImport() }));
  on('POST', '/api/autoimport/open', () => {
    const folder = importFolder();
    fs.mkdirSync(folder, { recursive: true });
    if (process.platform === 'darwin') require('node:child_process').execFile('open', [folder], () => {});
    return { folder };
  });
  on('POST', '/api/autoimport/clear', () => {
    const cur = svc().settings().autoImport;
    svc().saveSettings({ autoImport: { ...cur, log: [] } }, false);
    return { ok: true };
  });

  // ----- where the data lives (this Mac or iCloud Drive) -----
  function locationInfo() {
    const root = loc.icloudRoot(home);
    const target = path.join(root, loc.SHARED_NAME);
    return {
      dataDir,
      localDir,
      shared: loc.isShared(dataDir),
      computer: state.lock.name,
      icloudAvailable: fs.existsSync(root),
      icloudDir: target,
      icloudHasData: fs.existsSync(path.join(target, 'coaching-hub.sqlite')),
      busy: loc.isShared(dataDir) && !state.conn ? state.lock.other() : null,
      open: !!state.conn,
    };
  }
  function switchTo(dir) {
    closeData();
    dataDir = dir;
    state.lock = new loc.Lock(dir, lockOptions);
    loc.writePointer(localDir, dir === localDir ? null : dir);
    ensureOpen();
  }
  async function copyDataTo(dir) {
    svc();
    const payload = bk.inspectBackup(await bk.createBackup(state.conn.db, dataDir));
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    bk.restoreFiles(payload, dir);
  }
  on('GET', '/api/location', () => locationInfo());
  on('POST', '/api/location/open-anyway', () => { ensureOpen(true); return locationInfo(); });
  on('POST', '/api/location/icloud', async ({ body }) => {
    const info = locationInfo();
    if (!info.icloudAvailable) throw Object.assign(new Error('iCloud Drive isn\'t switched on for this Mac. Turn it on in System Settings → your name → iCloud → iCloud Drive, then try again.'), { status: 400 });
    if (info.shared) throw Object.assign(new Error('Your data is already in iCloud Drive'), { status: 400 });
    const target = info.icloudDir;
    if (info.icloudHasData) {
      if (body.mode !== 'use') throw Object.assign(new Error('There is already Coaching Hub data in iCloud Drive, probably from your other Mac.'), { status: 409 });
      const other = new loc.Lock(target, lockOptions).other();
      if (other) throw Object.assign(new Error(`Coaching Hub is open on ${other.name}. Close it there first.`), { status: 423, busy: other });
      await writeBackup('before-switch');
      switchTo(target);
      svc().audit(null, 'settings', null, 'update', `Switched to the shared data in iCloud Drive on ${state.lock.name}`);
    } else {
      await writeBackup('before-move');
      await copyDataTo(target);
      switchTo(target);
      svc().audit(null, 'settings', null, 'update', `Moved data to iCloud Drive from ${state.lock.name}`);
    }
    return locationInfo();
  });
  on('POST', '/api/location/local', async () => {
    if (!loc.isShared(dataDir)) throw Object.assign(new Error('Your data is already only on this Mac'), { status: 400 });
    const old = fs.existsSync(path.join(localDir, 'coaching-hub.sqlite')) ? dbm.open(localDir) : null;
    if (old) {
      const buf = await bk.createBackup(old.db, localDir);
      old.db.close();
      fs.mkdirSync(path.join(localDir, 'backups'), { recursive: true });
      fs.writeFileSync(path.join(localDir, 'backups', bk.backupName('coaching-hub-before-move-back')), buf);
    }
    await copyDataTo(localDir);
    switchTo(localDir);
    svc().audit(null, 'settings', null, 'update', 'Copied data from iCloud Drive back to this Mac only');
    return locationInfo();
  });
  on('POST', '/api/quit', () => {
    if (!onQuit) throw Object.assign(new Error('Quit is only available in the Mac app'), { status: 400 });
    setTimeout(onQuit, 200);
    return { ok: true };
  });

  // ----- settings, audit, sample -----
  on('GET', '/api/settings', () => ({ ...svc().settings(), dataDir, schema: dbm.SCHEMA_VERSION }));
  on('PUT', '/api/settings', ({ body }) => svc().saveSettings(body));
  on('GET', '/api/audit', () => svc().auditLog());
  on('POST', '/api/sample/load', () => {
    const s = svc();
    if (s.db.prepare('SELECT COUNT(*) AS n FROM athletes WHERE is_sample = 1').get().n) throw Object.assign(new Error('Sample athletes are already loaded'), { status: 400 });
    sample.seedSample(s);
    return { ok: true };
  });
  on('POST', '/api/sample/remove', () => sample.removeSample(svc()));

  // ----- backup & restore -----
  on('GET', '/api/backups', () => {
    const s = svc().settings();
    return { local: bk.listBackups(path.join(dataDir, 'backups')), extraFolder: s.backup.extraFolder, extra: s.backup.extraFolder ? safeList(s.backup.extraFolder) : [] };
  });
  on('POST', '/api/backups', async () => {
    const r = await writeBackup('manual');
    svc().audit(null, 'backup', null, 'create', `Backup saved: ${r.name}`);
    return r;
  });
  on('POST', '/api/restore', async ({ raw }) => {
    const payload = bk.inspectBackup(raw);
    await writeBackup('before-restore');
    svc();
    state.conn.db.close();
    state.conn = null;
    try {
      const r = bk.restoreFiles(payload, dataDir);
      ensureOpen();
      svc().audit(null, 'backup', null, 'restore', `Restored backup from ${r.created_at} (${r.files} files)`);
      return r;
    } catch (e) {
      ensureOpen();
      throw e;
    }
  }, true);

  async function writeBackup(kind) {
    svc();
    const buf = await bk.createBackup(state.conn.db, dataDir);
    const name = bk.backupName(`coaching-hub-${kind}`);
    const dir = path.join(dataDir, 'backups');
    fs.writeFileSync(path.join(dir, name), buf);
    const s = svc().settings();
    bk.prune(dir, s.backup.keep || 14, `coaching-hub-${kind}`);
    let copied = null;
    if (s.backup.extraFolder) {
      try {
        fs.mkdirSync(s.backup.extraFolder, { recursive: true });
        fs.writeFileSync(path.join(s.backup.extraFolder, name), buf);
        bk.prune(s.backup.extraFolder, s.backup.keep || 14, `coaching-hub-${kind}`);
        copied = s.backup.extraFolder;
      } catch (e) {
        copied = `failed: ${e.message}`;
      }
    }
    return { name, size: buf.length, copiedTo: copied };
  }

  async function autoBackup() {
    if (state.lock.other()) return null;
    return background(() => autoBackupNow());
  }
  async function autoBackupNow() {
    const s = svc().settings();
    if (!s.backup.autoDaily) return null;
    const last = bk.listBackups(path.join(dataDir, 'backups')).find((b) => b.name.startsWith('coaching-hub-auto'));
    if (last && Date.now() - Date.parse(last.modified) < 20 * 3600 * 1000) return null;
    return writeBackup('auto');
  }

  function safeList(dir) {
    try { return bk.listBackups(dir); } catch { return []; }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Only accept requests addressed to this machine (blocks DNS rebinding),
    // and only accept writes from this app's own pages (blocks CSRF).
    const host = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return send(res, 403, { error: 'Forbidden host' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'Forbidden origin' });
      if (req.headers['x-coaching-hub'] !== '1') return send(res, 403, { error: 'Missing app header' });
    }
    try {
      if (url.pathname === '/calc.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
        return fs.createReadStream(path.join(__dirname, 'calc.js')).pipe(res);
      }
      if (url.pathname === '/calendar.ics') {
        const s = svc().settings();
        if (url.searchParams.get('key') !== s.calendar.key) return send(res, 403, { error: 'Wrong calendar key' });
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache', ...(url.searchParams.get('download') ? { 'Content-Disposition': 'attachment; filename="coaching-hub.ics"' } : {}) });
        return res.end(svc().calendarICS());
      }
      if (url.pathname === '/download/backup') {
        svc();
        const buf = await bk.createBackup(state.conn.db, dataDir);
        const name = bk.backupName();
        svc().audit(null, 'backup', null, 'create', `Backup downloaded: ${name}`);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` });
        return res.end(buf);
      }
      if (url.pathname === '/download/export.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="coaching-hub-export-${new Date().toISOString().slice(0, 10)}.json"` });
        return res.end(JSON.stringify(svc().exportAll(), null, 2));
      }
      if (url.pathname === '/download/activities.csv') {
        const id = url.searchParams.get('athlete');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="activities.csv"' });
        return res.end(svc().activitiesCSV(id ? +id : null));
      }
      const att = url.pathname.match(/^\/files\/(\d+)$/);
      if (att) {
        const a = svc().attachmentPath(+att[1]);
        res.writeHead(200, { 'Content-Type': a.mime || 'application/octet-stream', 'Content-Disposition': `${url.searchParams.get('download') ? 'attachment' : 'inline'}; filename="${a.filename}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" });
        return fs.createReadStream(a.path).pipe(res);
      }
      if (url.pathname.startsWith('/api/')) {
        if (!url.pathname.startsWith('/api/location') && url.pathname !== '/api/quit') state.lastUse = Date.now();
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          const raw = await readBody(req, 60 * 1024 * 1024);
          let body = {};
          if (!r.raw && raw.length) {
            try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
          }
          const out = await r.handler({ p: m.groups || {}, q: url.searchParams, body, raw, req });
          if (req.method !== 'GET' && !url.pathname.startsWith('/api/gsync')) scheduleSync();
          return send(res, 200, out);
        }
        return send(res, 404, { error: 'Not found' });
      }
      return serveStatic(url.pathname, res);
    } catch (e) {
      if (!e.status) console.error(e);
      return send(res, e.status || 500, { error: e.status ? e.message : `Something went wrong: ${e.message}`, ...(e.busy ? { busy: e.busy } : {}) });
    }
  }
  const server = http.createServer(handle);
  return { server, autoBackup, googleSync, state, closeData, autoImport, autoUpdate, checkAndInstall, close: () => { clearTimeout(syncTimer); clearInterval(tick); if (watchTimer) clearInterval(watchTimer); server.close(); closeData(); } };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('Upload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj ?? null));
}

function serveStatic(p, res) {
  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

module.exports = { createApp };
