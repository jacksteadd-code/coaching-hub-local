// Automatic import folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server/app');
const watcher = require('../server/watcher');

const zlib = require('node:zlib');
function makeZip(entries) {
  const parts = [];
  const central = [];
  let off = 0;
  for (const [name, text] of entries) {
    const raw = Buffer.from(text);
    const data = zlib.deflateRawSync(raw);
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, n, data);
    central.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

const A = (id, name, preferred_name = null) => ({ id, name, preferred_name });
const roster = [A(1, 'Kieran Masters'), A(2, 'Kieran Boardman'), A(3, 'Gemma'), A(4, "Lewis O'Connor"), A(5, 'Ollie Marshall', 'Ollie')];

test('matches athletes by name in the file name', () => {
  assert.equal(watcher.matchAthlete('Kieran Masters workouts.csv', roster).athlete.id, 1);
  assert.equal(watcher.matchAthlete('kieran_boardman-2026-11.csv', roster).athlete.id, 2);
  assert.equal(watcher.matchAthlete('Gemma TP export.csv', roster).athlete.id, 3);
  assert.equal(watcher.matchAthlete('lewis o connor.csv', roster).athlete.id, 4);
  assert.equal(watcher.matchAthlete('ollie.csv', roster).athlete.id, 5);
  assert.match(watcher.matchAthlete('Kieran.csv', roster).error, /more than one/);
  // TrainingPeaks spellings
  const tp = [...roster, A(6, 'Bennett Chacutte'), A(7, 'Emma'), A(8, 'Junior')];
  assert.equal(watcher.matchAthlete('Bennett Chacatte TrainingPeaks 2026-11-03.zip', tp).athlete.id, 6);
  assert.equal(watcher.matchAthlete('lewis oconnor.csv', tp).athlete.id, 4);
  assert.equal(watcher.matchAthlete('LEWIS-O-CONNOR.csv', tp).athlete.id, 4);
  assert.equal(watcher.matchAthlete('Kieran Boardman TrainingPeaks 2026-11-03.csv', tp).athlete.id, 2);
  assert.equal(watcher.matchAthlete('Kieren Masters.csv', tp).athlete.id, 1, 'one letter off');
  assert.match(watcher.matchAthlete('Emmy.csv', tp).error, /No athlete/, 'short names must match exactly');
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
  assert.equal(info.folder, path.join(root, 'Coaching Hub Imports'));
  fs.mkdirSync(info.folder, { recursive: true });
  const csv = 'WorkoutDay,WorkoutType,Title,TimeTotalInHours,PlannedDuration,DistanceInMeters,TSS\n2026-10-13,Run,Easy run,0.75,0.75,8000,40\n2026-10-15,Bike,Endurance,1.5,1.5,40000,70\n';
  const old = new Date(Date.now() - 60000);
  for (const name of ['Gemma workouts.csv', 'unknown.csv']) {
    fs.writeFileSync(path.join(info.folder, name), csv);
    fs.utimesSync(path.join(info.folder, name), old, old);
  }
  // A TrainingPeaks-style zip with a metrics file and the workouts file.
  const csv2 = csv.replace('2026-10-13', '2026-10-17').replace('Easy run', 'Long run');
  fs.writeFileSync(path.join(info.folder, 'Gemma TrainingPeaks.zip'), makeZip([['metrics.csv', 'Timestamp,Type,Value\n2026-10-13,HRV,60\n'], ['workouts.csv', csv2]]));
  fs.utimesSync(path.join(info.folder, 'Gemma TrainingPeaks.zip'), old, old);
  const fresh = path.join(info.folder, 'Gemma still downloading.csv');
  fs.writeFileSync(fresh, csv);
  const { entries } = await req('POST', '/api/autoimport/run');
  assert.equal(entries.length, 3, 'the file still being written is left for next time');
  const ok = entries.find((e) => e.file === 'Gemma workouts.csv');
  assert.equal(ok.ok, true);
  assert.equal(ok.athlete_id, a.id);
  assert.equal(entries.find((e) => e.file === 'unknown.csv').ok, false);
  assert.equal(fs.readdirSync(path.join(info.folder, 'Imported')).length, 2);
  const added = entries.filter((e) => e.ok).reduce((n, e) => n + Number(e.message.match(/^(\d+) new/)[1]), 0);
  assert.equal(added, 3, 'the overlapping workout from the zip and the CSV is only added once');
  assert.equal(entries.find((e) => e.file === 'Gemma TrainingPeaks.zip').ok, true);
  assert.equal(fs.readdirSync(path.join(info.folder, 'Needs attention')).length, 1);
  assert.ok(fs.existsSync(fresh));
  const log = (await req('GET', '/api/autoimport')).log;
  assert.equal(log.length, 3);
});
