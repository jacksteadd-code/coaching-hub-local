// End-to-end tests against the real HTTP server and a temporary data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server/app');

const TODAY = '2026-10-21';
let app;
let port;
let dataDir;

function start() {
  app = createApp({ dataDir, today: TODAY });
  return new Promise((r) => app.server.listen(0, '127.0.0.1', () => { port = app.server.address().port; r(); }));
}

function req(method, url, body, { headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : raw ? body : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: `localhost:${port}`, 'x-coaching-hub': '1', ...(data ? { 'content-length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, buf, text: buf.toString() });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const ok = async (...a) => {
  const r = await req(...a);
  assert.equal(r.status, 200, `${a[0]} ${a[1]} -> ${r.status} ${r.text}`);
  return r.body;
};

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coaching-hub-test-'));
  await start();
});
test.after(() => {
  app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let A;
let B;

test('add athletes and validate input', async () => {
  A = await ok('POST', '/api/athletes', { name: 'Alex Real', start_date: '2025-10-21', timezone: 'Europe/London', profile_json: { typical_weekly_hours: 8, max_weekly_hours: 10 } });
  B = await ok('POST', '/api/athletes', { name: 'Bea Real', start_date: '2026-09-01' });
  assert.equal((await req('POST', '/api/athletes', { name: '' })).status, 400);
  assert.equal((await req('POST', '/api/athletes', { name: 'X', timezone: 'Mars/Base' })).status, 400);
  assert.equal((await req('POST', '/api/races', { athlete_id: A.id, name: 'R', date: '2026-02-30' })).status, 400);
  const full = await ok('GET', `/api/athletes/${A.id}`);
  assert.equal(full.derived.coaching.label, '1 yr');
});

test('only this machine and this app can make changes', async () => {
  const wrongHost = await req('GET', '/api/athletes', null, { headers: { host: 'evil.example' } });
  assert.equal(wrongHost.status, 403);
  const crossSite = await req('POST', '/api/athletes', { name: 'X' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  const noHeader = await req('POST', '/api/athletes', { name: 'X' }, { headers: { 'x-coaching-hub': '' } });
  assert.equal(noHeader.status, 403);
});

test('athlete records are isolated from each other', async () => {
  await ok('POST', '/api/races', { athlete_id: A.id, name: 'Alex A race', date: '2026-12-06', priority: 'A' });
  await ok('POST', '/api/notes', { athlete_id: A.id, body: 'Private note about Alex' });
  const b = await ok('GET', `/api/athletes/${B.id}`);
  assert.equal(b.races.length, 0);
  assert.equal(b.notes.length, 0);
  // Moving a record to another athlete is not possible via update
  const race = (await ok('GET', `/api/athletes/${A.id}`)).races[0];
  await ok('PUT', `/api/races/${race.id}`, { athlete_id: B.id, name: 'Renamed' });
  assert.equal((await ok('GET', `/api/athletes/${B.id}`)).races.length, 0);
  assert.equal((await ok('GET', `/api/athletes/${A.id}`)).races[0].name, 'Renamed');
});

test('race countdown on the athlete record', async () => {
  const a = await ok('GET', `/api/athletes/${A.id}`);
  assert.equal(a.derived.nextRace.countdown.days, 46);
  assert.equal(a.derived.nextRace.countdown.label, '6 wk 4 d');
});

const TP_HEADER = 'Title,WorkoutType,WorkoutDescription,PlannedDuration,PlannedDistanceInMeters,WorkoutDay,CoachComments,DistanceInMeters,PowerAverage,TimeTotalInHours,TSS,Rpe,AthleteComments';
const tpRows = (weekStart, scale = 1) => [
  `Easy run,Run,,0.75,,${weekStart},,8000,,${0.8 * scale},45,4,felt good`,
  `Long ride,Bike,,3,,${addDays(weekStart, 5)},,90000,180,${3 * scale},160,6,`,
  `Swim CSS,Swim,,1,,${addDays(weekStart, 2)},,2500,,1,55,,`,
  `Day off,Day Off,,,,${addDays(weekStart, 6)},,,,,,,`,
];
function addDays(s, n) { return require('../server/calc').addDays(s, n); }

test('TrainingPeaks import: preview, dedupe, safe re-import and undo', async () => {
  const weeks = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'];
  const csv = [TP_HEADER, ...weeks.flatMap((w) => tpRows(w)), 'Broken,Run,,,,2026-13-01,,,,1,,,'].join('\n');
  const pv = await ok('POST', `/api/athletes/${A.id}/import/preview`, { csv });
  assert.equal(pv.preset, 'trainingpeaks');
  assert.equal(pv.counts.new, 18);
  assert.equal(pv.counts.invalid, 1);
  assert.equal(pv.counts.skipped, 6);
  // Preview saved nothing
  assert.equal((await ok('GET', `/api/athletes/${A.id}`)).activities.length, 0);
  const c1 = await ok('POST', `/api/athletes/${A.id}/import/commit`, { csv, filename: 'workouts.csv' });
  assert.deepEqual([c1.added, c1.updated, c1.invalid], [18, 0, 1]);
  // Same file again: nothing duplicated
  const c2 = await ok('POST', `/api/athletes/${A.id}/import/commit`, { csv, filename: 'workouts.csv' });
  assert.deepEqual([c2.added, c2.updated, c2.unchanged], [0, 0, 18]);
  // Later export with a corrected duration updates the existing row
  const csv3 = [TP_HEADER, ...tpRows('2026-10-12', 1.25)].join('\n');
  const c3 = await ok('POST', `/api/athletes/${A.id}/import/commit`, { csv: csv3, filename: 'later.csv' });
  assert.equal(c3.added, 0);
  assert.equal(c3.updated, 2);
  const a = await ok('GET', `/api/athletes/${A.id}`);
  assert.equal(a.activities.length, 18);
  const ride = a.activities.find((x) => x.date === '2026-10-17' && x.sport === 'bike');
  assert.equal(ride.duration_min, 225);
  assert.equal(ride.distance_km, 90);
  assert.equal(ride.load_type, 'TrainingPeaks TSS (bike)');
  assert.equal(ride.source, 'TrainingPeaks CSV');
  // Other athlete untouched
  assert.equal((await ok('GET', `/api/athletes/${B.id}`)).activities.length, 0);
  // Undo removes only rows an import added, never rows that existed before it
  assert.equal((await ok('DELETE', `/api/imports/${c3.importId}`)).removed, 0);
  assert.equal((await ok('GET', `/api/athletes/${A.id}`)).activities.length, 18);
  const extra = await ok('POST', `/api/athletes/${A.id}/import/commit`, { csv: [TP_HEADER, 'Extra run,Run,,,,2026-10-13,,5000,,0.5,,,'].join('\n') });
  assert.equal(extra.added, 1);
  assert.equal((await ok('DELETE', `/api/imports/${extra.importId}`)).removed, 1);
});

test('weekly log: missing vs zero, wellbeing validation', async () => {
  const empty = await ok('GET', `/api/athletes/${B.id}/weeks/2026-10-12`);
  assert.equal(empty.summary.source, 'missing');
  assert.equal(empty.summary.completedHours, null);
  await ok('PUT', `/api/athletes/${B.id}/weeks/2026-10-12`, { planned_json: { run: 4 }, completed_json: { run: 0, bike: '' } });
  const zero = await ok('GET', `/api/athletes/${B.id}/weeks/2026-10-12`);
  assert.equal(zero.summary.completedHours, 0);
  assert.equal(zero.summary.compliance, 0);
  assert.equal((await req('PUT', `/api/athletes/${B.id}/weeks/2026-10-12`, { fatigue: 9 })).status, 400);
  assert.equal((await req('PUT', `/api/athletes/${B.id}/weeks/2026-10-13`, {})).status, 400); // not a Monday
  // Missing week is flagged as missing data, not low compliance
  const flags = (await ok('GET', `/api/athletes/${B.id}`)).derived.flags.map((f) => f.type);
  assert.ok(flags.includes('data'));
  assert.ok(!flags.includes('compliance'));
});

test('tests: derived values and accepted thresholds with effective dates', async () => {
  const t1 = await ok('POST', '/api/tests', { athlete_id: A.id, discipline: 'bike', test_type: 'ftp_20min', date: '2026-03-01', raw_json: { avgPower: 240 }, accepted: true, effective_from: '2026-03-02' });
  assert.equal(t1.derived_value, 228);
  await ok('POST', '/api/tests', { athlete_id: A.id, discipline: 'bike', test_type: 'ftp_20min', date: '2026-09-01', raw_json: { avgPower: 260 }, accepted: true, effective_from: '2026-09-02' });
  await ok('POST', '/api/tests', { athlete_id: A.id, discipline: 'bike', test_type: 'ftp_20min', date: '2026-10-01', raw_json: { avgPower: 300 } }); // not accepted
  const a = await ok('GET', `/api/athletes/${A.id}`);
  assert.equal(a.thresholds.FTP.value, 247);
  assert.equal(a.thresholds.FTP.from, '2026-09-02');
  assert.equal(a.zones[1].name, 'Z2 Endurance');
});

test('recommendations: insufficient data, then a pending proposal that changes nothing until approved', async () => {
  const none = await ok('POST', `/api/athletes/${B.id}/recommend`, {});
  assert.equal(none.kind, 'insufficient');
  const before = (await ok('GET', `/api/athletes/${A.id}`)).plan;
  const rec = await ok('POST', `/api/athletes/${A.id}/recommend`, {});
  assert.equal(rec.kind, 'proposal');
  assert.ok(rec.dataUsed.length >= 4);
  assert.ok(rec.reasoning.length && rec.conservative);
  const after = await ok('GET', `/api/athletes/${A.id}`);
  assert.deepEqual(after.plan, before); // nothing applied
  assert.equal(after.proposals[0].status, 'pending');
  // Plan writes need explicit confirmation
  assert.equal((await req('PUT', `/api/athletes/${A.id}/plan`, { weeks: [{ week_start: '2026-10-26', hours_min: 20 }] })).status, 400);
  // Approve applies it and stores the previous version
  await ok('POST', `/api/proposals/${rec.id}/apply`, {});
  const applied = await ok('GET', `/api/athletes/${A.id}`);
  assert.equal(applied.plan.length, 4);
  assert.equal(applied.proposals[0].status, 'applied');
  assert.equal(applied.versions.length, 1);
  // Cannot approve twice
  assert.equal((await req('POST', `/api/proposals/${rec.id}/apply`, {})).status, 400);
});

test('plan edits, block move preview and version restore', async () => {
  await ok('PUT', `/api/athletes/${A.id}/plan`, { weeks: [{ week_start: '2026-11-30', phase: 'Taper', hours_min: 5, hours_max: 6 }], note: 'Taper week', confirmed: true });
  assert.equal((await req('PUT', `/api/athletes/${A.id}/plan`, { weeks: [{ week_start: '2026-11-30', hours_min: 9, hours_max: 6 }], confirmed: true })).status, 400);
  const pv = await ok('POST', `/api/athletes/${A.id}/plan/shift-preview`, { from: '2026-11-30', to: '2026-11-30', n: 1 });
  assert.equal(pv.weeks[0].week_start, '2026-12-07');
  assert.deepEqual(pv.vacated, ['2026-11-30']);
  const planBefore = (await ok('GET', `/api/athletes/${A.id}`)).plan;
  assert.ok(planBefore.some((w) => w.week_start === '2026-11-30')); // preview did not move anything
  await ok('PUT', `/api/athletes/${A.id}/plan`, { weeks: pv.weeks, deleteWeeks: pv.vacated, note: 'move', confirmed: true });
  const moved = await ok('GET', `/api/athletes/${A.id}`);
  assert.ok(moved.plan.some((w) => w.week_start === '2026-12-07' && w.phase === 'Taper'));
  assert.ok(!moved.plan.some((w) => w.week_start === '2026-11-30'));
  // Restore the version saved before the move
  const v = moved.versions[0];
  assert.equal((await req('POST', `/api/plan-versions/${v.id}/restore`, {})).status, 400);
  await ok('POST', `/api/plan-versions/${v.id}/restore`, { confirmed: true });
  const restored = await ok('GET', `/api/athletes/${A.id}`);
  assert.ok(restored.plan.some((w) => w.week_start === '2026-11-30' && w.phase === 'Taper'));
  assert.ok(!restored.plan.some((w) => w.week_start === '2026-12-07'));
});

test('AI suggestions are stored for review and the summary leaves out health by default', async () => {
  await ok('PUT', `/api/athletes/${A.id}`, { health_json: { injuries: 'SECRET-HEALTH-NOTE', active_issue: true } });
  const s1 = await ok('POST', `/api/athletes/${A.id}/ai-summary`, {});
  assert.ok(!s1.text.includes('SECRET-HEALTH-NOTE'));
  assert.ok(!s1.text.includes('Alex'));
  const s2 = await ok('POST', `/api/athletes/${A.id}/ai-summary`, { include: ['health'], anonymise: false });
  assert.ok(s2.text.includes('SECRET-HEALTH-NOTE'));
  const planBefore = (await ok('GET', `/api/athletes/${A.id}`)).plan;
  const p = await ok('POST', `/api/athletes/${A.id}/ai-suggestion`, { text: 'Increase to 15 h/week' });
  assert.equal(p.origin, 'ai');
  assert.equal(p.status, 'pending');
  await ok('POST', `/api/proposals/${p.id}/keep`, {});
  assert.deepEqual((await ok('GET', `/api/athletes/${A.id}`)).plan, planBefore);
  // Health flag makes the next suggestion carry a review flag
  const rec = await ok('POST', `/api/athletes/${A.id}/recommend`, {});
  assert.ok(rec.flags.some((f) => f.includes('SECRET-HEALTH-NOTE')));
});

test('calendar feed: key required, stable IDs, updates and deletions', async () => {
  const s = await ok('GET', '/api/settings');
  assert.equal((await req('GET', '/calendar.ics?key=wrong')).status, 403);
  const task = await ok('POST', '/api/tasks', { athlete_id: A.id, title: 'Call', kind: 'call', due_date: '2026-10-26', due_time: '18:30', timezone: 'Europe/London' });
  const f1 = (await req('GET', `/calendar.ics?key=${s.calendar.key}`)).text;
  assert.match(f1, new RegExp(`UID:task-${task.id}@coaching-hub.local\\r\\n`));
  assert.match(f1, /DTSTART:20261026T183000Z/); // after the clocks go back: GMT
  assert.match(f1, /SUMMARY:Call: A.R./); // initials only
  assert.ok(!f1.includes('Alex'));
  await ok('PUT', `/api/tasks/${task.id}`, { due_date: '2026-10-23' });
  const f2 = (await req('GET', `/calendar.ics?key=${s.calendar.key}`)).text;
  assert.equal((f2.match(new RegExp(`UID:task-${task.id}@`, 'g')) || []).length, 1);
  assert.match(f2, /DTSTART:20261023T173000Z/); // before the change: BST
  await ok('DELETE', `/api/tasks/${task.id}`);
  const f3 = (await req('GET', `/calendar.ics?key=${s.calendar.key}`)).text;
  assert.ok(!f3.includes(`task-${task.id}@`));
  assert.ok(!f3.includes('Birthday')); // birthdays off by default
});

test('backup and restore round trip including attachments; data survives restart', async () => {
  const att = await ok('POST', `/api/athletes/${A.id}/attachments`, Buffer.from('lab report pdf bytes'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-filename': encodeURIComponent('lab report.pdf') } });
  const backup = await req('GET', '/download/backup');
  assert.equal(backup.status, 200);
  // Change data after the backup
  await ok('POST', '/api/athletes', { name: 'Added After Backup' });
  await ok('DELETE', `/api/attachments/${att.id}`);
  const restored = await ok('POST', '/api/restore', backup.buf, { raw: true, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(restored.files, 1);
  const names = (await ok('GET', '/api/athletes')).map((a) => a.name);
  assert.ok(!names.includes('Added After Backup'));
  const file = await req('GET', `/files/${att.id}`);
  assert.equal(file.text, 'lab report pdf bytes');
  assert.ok(fs.readdirSync(path.join(dataDir, 'backups')).some((f) => f.startsWith('coaching-hub-before-restore')));
  assert.equal((await req('POST', '/api/restore', Buffer.from('not a backup'), { raw: true })).status, 400);
  // Restart the app on the same data folder: everything is still there
  app.close();
  await start();
  const again = await ok('GET', `/api/athletes/${A.id}`);
  assert.equal(again.activities.length, 18);
  assert.equal(again.attachments.length, 1);
});

test('sample data stays separate and is removable', async () => {
  await ok('POST', '/api/sample/load');
  const all = await ok('GET', '/api/athletes');
  assert.equal(all.filter((a) => a.is_sample).length, 3);
  const s = await ok('GET', '/api/settings');
  const ics = (await req('GET', `/calendar.ics?key=${s.calendar.key}`)).text;
  assert.ok(!ics.includes('M.O.')); // sample athletes never published
  await ok('POST', '/api/sample/remove');
  const left = await ok('GET', '/api/athletes');
  assert.equal(left.filter((a) => a.is_sample).length, 0);
  assert.ok(left.some((a) => a.name === 'Alex Real'));
});

test('deleting an athlete removes their records and files only', async () => {
  const files = fs.readdirSync(path.join(dataDir, 'attachments')).length;
  await ok('DELETE', `/api/athletes/${A.id}`);
  assert.equal((await req('GET', `/api/athletes/${A.id}`)).status, 404);
  assert.equal(fs.readdirSync(path.join(dataDir, 'attachments')).length, files - 1);
  assert.equal((await ok('GET', `/api/athletes/${B.id}`)).athlete.name, 'Bea Real');
});
