// Automatic import folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server/app');
const watcher = require('../server/watcher');

const A = (id, name, preferred_name = null) => ({ id, name, preferred_name });
const roster = [A(1, 'Kieran Masters'), A(2, 'Kieran Boardman'), A(3, 'Gemma'), A(4, "Lewis O'Connor"), A(5, 'Ollie Marshall', 'Ollie')];

test('matches athletes by name in the file name', () => {
  assert.equal(watcher.matchAthlete('Kieran Masters workouts.csv', roster).athlete.id, 1);
  assert.equal(watcher.matchAthlete('kieran_boardman-2026-11.csv', roster).athlete.id, 2);
  assert.equal(watcher.matchAthlete('Gemma TP export.csv', roster).athlete.id, 3);
  assert.equal(watcher.matchAthlete('lewis o connor.csv', roster).athlete.id, 4);
  assert.equal(watcher.matchAthlete('ollie.csv', roster).athlete.id, 5);
  assert.match(watcher.matchAthlete('Kieran.csv', roster).error, /more than one/);
  assert.match(watcher.matchAthlete('workouts.csv', roster).error, /No athlete name/);
});

test('imports dropped CSVs, moves them, and logs the result', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coaching-hub-watch-'));
  const app = createApp({ dataDir: path.join(root, 'data'), today: '2026-10-21', home: root, watchMs: 0 });
  t.after(() => { app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const req = (method, url, body) => new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: `localhost:${port}`, 'x-coaching-hub': '1', ...(data ? { 'content-length': data.length } : {}) } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString() || 'null')));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  const a = await req('POST', '/api/athletes', { name: 'Gemma' });
  const info = await req('GET', '/api/autoimport');
  assert.equal(info.folder, path.join(root, 'Documents', 'Coaching Hub Imports'));
  fs.mkdirSync(info.folder, { recursive: true });
  const csv = 'WorkoutDay,WorkoutType,Title,TimeTotalInHours,PlannedDuration,DistanceInMeters,TSS\n2026-10-13,Run,Easy run,0.75,0.75,8000,40\n2026-10-15,Bike,Endurance,1.5,1.5,40000,70\n';
  const old = new Date(Date.now() - 60000);
  for (const name of ['Gemma workouts.csv', 'unknown.csv']) {
    fs.writeFileSync(path.join(info.folder, name), csv);
    fs.utimesSync(path.join(info.folder, name), old, old);
  }
  const fresh = path.join(info.folder, 'Gemma still downloading.csv');
  fs.writeFileSync(fresh, csv);
  const { entries } = await req('POST', '/api/autoimport/run');
  assert.equal(entries.length, 2, 'the file still being written is left for next time');
  const ok = entries.find((e) => e.file === 'Gemma workouts.csv');
  assert.equal(ok.ok, true);
  assert.equal(ok.athlete_id, a.id);
  assert.match(ok.message, /^2 new/);
  assert.equal(entries.find((e) => e.file === 'unknown.csv').ok, false);
  assert.equal(fs.readdirSync(path.join(info.folder, 'Imported')).length, 1);
  assert.equal(fs.readdirSync(path.join(info.folder, 'Needs attention')).length, 1);
  assert.ok(fs.existsSync(fresh));
  const log = (await req('GET', '/api/autoimport')).log;
  assert.equal(log.length, 2);
});
