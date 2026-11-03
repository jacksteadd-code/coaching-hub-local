// Athlete update files (*.chathlete) dropped into the import folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server/app');
const athletefile = require('../server/athletefile');

test('fill only sets empty keys and recurses into objects', () => {
  const r = athletefile.fill({ a: 'keep', b: '', n: { x: 1 } }, { a: 'new', b: 'set', c: '', n: { x: 2, y: 3 }, z: 'z' });
  assert.deepEqual(r.out, { a: 'keep', b: 'set', n: { x: 1, y: 3 }, z: 'z' });
  assert.deepEqual(r.changed.sort(), ['b', 'n.y', 'z']);
});

test('parse rejects other files', () => {
  assert.throws(() => athletefile.parse('nope'), /not valid/);
  assert.throws(() => athletefile.parse('{"format":"x"}'), /not a Coaching Hub athlete/);
  assert.throws(() => athletefile.parse('{"format":"coaching-hub-athlete","version":9}'), /newer version/);
});

test('an athlete update file fills one athlete and leaves the others alone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coaching-hub-athfile-'));
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
  const sam = await req('POST', '/api/athletes', { name: 'Sam', email: 'sam@example.com', profile_json: { billing: 'paying', occupation: 'Teacher' } });
  const other = await req('POST', '/api/athletes', { name: 'Alex Rivers', goals: 'Marathon' });
  const folder = (await req('GET', '/api/autoimport')).folder;
  fs.mkdirSync(folder, { recursive: true });
  const file = {
    format: 'coaching-hub-athlete',
    version: 1,
    athlete: { name: 'Sam Taylor', email: 'other@example.com', start_date: '2025-01-06', goals: 'Sub 5 middle distance', profile: { occupation: 'Builder', family: 'Two kids', availability: { sun: 4 }, facilities: { pool: true } }, health: { injuries: 'Knee niggle, 2026-03' } },
    races: [{ name: 'Lakeside Middle', date: '2026-06-01', priority: 'A', status: 'completed', result: '5:12:00' }, { name: 'City Full', date: '2027-10-03', priority: 'A' }],
    tests: [{ discipline: 'bike', test_type: 'FTP 20 min', date: '2025-11-29', derived_metric: 'FTP', derived_value: 250, derived_unit: 'W' }],
    notes: [{ date: '2026-03-10', kind: 'note', body: 'Asked to slow easy runs down.' }],
    workouts_csv: 'WorkoutDay,WorkoutType,Title,TimeTotalInHours\n2026-10-13,Run,Easy run,0.75\n2026-10-15,Bike,Endurance,1.5\n',
  };
  const drop = (name) => {
    const p = path.join(folder, name);
    fs.writeFileSync(p, JSON.stringify(file));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(p, old, old);
  };
  drop('Sam Taylor.chathlete');
  let { entries } = await req('POST', '/api/autoimport/run');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ok, true, entries[0].message);
  assert.equal(entries[0].athlete, 'Sam Taylor');
  assert.match(entries[0].message, /2 races, 1 test, 1 note added.*workouts: 2 new/);

  const d = await req('GET', `/api/athletes/${sam.id}`);
  assert.equal(d.athlete.name, 'Sam Taylor', 'the name is extended with the surname');
  assert.equal(d.athlete.email, 'sam@example.com', 'existing values are kept');
  assert.equal(d.athlete.start_date, '2025-01-06');
  const prof = JSON.parse(d.athlete.profile_json);
  assert.equal(prof.occupation, 'Teacher');
  assert.equal(prof.billing, 'paying');
  assert.equal(prof.family, 'Two kids');
  assert.equal(prof.availability.sun, 4);
  assert.equal(JSON.parse(d.athlete.health_json).injuries, 'Knee niggle, 2026-03');
  assert.equal(d.races.length, 2);
  assert.equal(d.tests.length, 1);
  assert.equal(d.notes.length, 1);
  assert.equal(d.activities.length, 2);

  // The other athlete is untouched.
  const o = await req('GET', `/api/athletes/${other.id}`);
  assert.equal(o.athlete.goals, 'Marathon');
  assert.equal(o.races.length + o.tests.length + o.notes.length + o.activities.length, 0);

  // Applying the same file again changes nothing.
  drop('Sam Taylor again.chathlete');
  ({ entries } = await req('POST', '/api/autoimport/run'));
  assert.equal(entries[0].ok, true, entries[0].message);
  assert.match(entries[0].message, /0 profile fields filled in, 0 races, 0 tests, 0 notes added, 4 already there, workouts: 0 new/);
  const d2 = await req('GET', `/api/athletes/${sam.id}`);
  assert.equal(d2.races.length + d2.tests.length + d2.notes.length + d2.activities.length, 6);
  assert.equal(fs.readdirSync(path.join(folder, 'Imported')).length, 2);

  // A broken file goes to Needs attention.
  fs.writeFileSync(path.join(folder, 'Sam.chathlete'), '{not json');
  fs.utimesSync(path.join(folder, 'Sam.chathlete'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  ({ entries } = await req('POST', '/api/autoimport/run'));
  assert.equal(entries[0].ok, false);
  assert.equal(fs.readdirSync(path.join(folder, 'Needs attention')).length, 1);
});
