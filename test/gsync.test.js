// Google Calendar sync: runs the real Apps Script source against a fake
// Google Calendar, wired to the app through a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createApp } = require('../server/app');
const gs = require('../server/gsync');

const TODAY = '2026-10-21';

// --- a tiny fake of the Apps Script calendar services ---
function fakeGoogle() {
  const calendars = [];
  let nextId = 1;
  const makeCal = (name) => {
    const cal = {
      name,
      events: [],
      getEvents(from, to) { return cal.events.filter((e) => !e.deleted && e.start < to && e.end > from); },
      createAllDayEvent(title, start, end, opts) { return add({ title, start, end, allDay: true, description: opts.description }); },
      createEvent(title, start, end, opts) { return add({ title, start, end, allDay: false, description: opts.description }); },
    };
    function add(o) {
      const ev = { id: nextId++, ...o, tags: {}, reminders: [] };
      ev.getTag = (k) => ev.tags[k] || null;
      ev.setTag = (k, v) => { ev.tags[k] = v; };
      ev.deleteEvent = () => { ev.deleted = true; };
      ev.removeAllReminders = () => { ev.reminders = []; };
      ev.addPopupReminder = (m) => ev.reminders.push(m);
      cal.events.push(ev);
      return ev;
    }
    calendars.push(cal);
    return cal;
  };
  const primary = makeCal('jack@example.com');
  primary.createEvent('Dentist', new Date('2026-10-25T09:00:00Z'), new Date('2026-10-25T10:00:00Z'), {});
  const sandbox = {
    CalendarApp: { getCalendarsByName: (n) => calendars.filter((c) => c.name === n), createCalendar: makeCal },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType: () => ({ text: t }) }) },
  };
  return { calendars, primary, sandbox, coaching: () => calendars.find((c) => c.name === 'Coaching') };
}

function fetchFor(google, script) {
  vm.createContext(google.sandbox);
  vm.runInContext(script, google.sandbox);
  return async (url, init) => {
    const out = google.sandbox.doPost({ postData: { contents: init.body } });
    return { status: 200, text: async () => out.text };
  };
}

let app, port, dataDir, google;
function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: `localhost:${port}`, 'x-coaching-hub': '1', ...(data ? { 'content-length': data.length } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const ok = async (...a) => { const r = await req(...a); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coaching-hub-gsync-'));
  google = fakeGoogle();
  let f = null;
  const fetchImpl = (url, init) => f(url, init);
  app = createApp({ dataDir, today: TODAY, fetchImpl, allowAnySyncUrl: true, syncDelayMs: 10 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', () => { port = app.server.address().port; r(); }));
  f = fetchFor(google, (await ok('GET', '/api/gsync')).script);
});
test.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('toGoogleEvents: all-day end is exclusive, timed events convert to UTC, repeating events skipped', () => {
  const { events, skipped } = gs.toGoogleEvents([
    { uid: 'a', title: 'Race', date: '2026-11-01' },
    { uid: 'b', title: 'Window', date: '2026-11-02', endDate: '2026-11-05' },
    { uid: 'c', title: 'Call', date: '2026-11-03', time: '18:30', timeZone: 'Europe/London', durationMin: 30, alarmMinutes: 60 },
    { uid: 'd', title: 'Birthday', date: '1990-01-01', rrule: 'FREQ=YEARLY' },
  ], 'Europe/London');
  assert.equal(events[0].end, '2026-11-02');
  assert.equal(events[1].end, '2026-11-06');
  assert.equal(events[2].start, '2026-11-03T18:30:00.000Z');
  assert.equal(events[2].end, '2026-11-03T19:00:00.000Z');
  assert.equal(events[2].reminderMinutes, 60);
  assert.deepEqual(skipped, ['Birthday']);
});

test('only accepts Apps Script web app links by default', () => {
  assert.ok(gs.validUrl('https://script.google.com/macros/s/AKfy-abc_123/exec'));
  assert.ok(!gs.validUrl('https://evil.example.com/exec'));
  assert.ok(!gs.validUrl('https://script.google.com/macros/s/abc/dev'));
});

test('nothing is sent until switched on; then create, update and delete only tagged events', async () => {
  const a = await ok('POST', '/api/athletes', { name: 'Real Person' });
  const race = await ok('POST', '/api/races', { athlete_id: a.id, name: 'City 10k', date: '2026-11-20', priority: 'A' });
  // A change before connecting must not sync.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(google.coaching(), undefined);

  await ok('POST', '/api/gsync/connect', { url: 'https://script.google.com/macros/s/test/exec' });
  assert.ok(google.coaching(), 'ping creates the Coaching calendar');
  assert.equal(google.coaching().events.length, 0, 'connecting sends no events');

  const on = await ok('POST', '/api/gsync/enable', { enabled: true });
  assert.ok(on.result.created >= 1);
  const live = () => google.coaching().events.filter((e) => !e.deleted);
  const raceEv = live().find((e) => e.tags.chuid === `race-${race.id}@coaching-hub.local`);
  assert.ok(raceEv);
  assert.equal(raceEv.title, 'A race: R.P. – City 10k');

  // Unchanged second sync touches nothing.
  const again = await ok('POST', '/api/gsync/sync');
  assert.equal(again.result.created + again.result.updated + again.result.deleted, 0);

  // Edit → update; a hand-made event in the Coaching calendar is left alone.
  google.coaching().createEvent('My own note', new Date('2026-11-21T09:00:00Z'), new Date('2026-11-21T10:00:00Z'), {});
  await ok('PUT', `/api/races/${race.id}`, { date: '2026-11-22' });
  await new Promise((r) => setTimeout(r, 60)); // auto-sync after a change
  const moved = live().find((e) => e.tags.chuid === `race-${race.id}@coaching-hub.local`);
  assert.equal(moved.start.getDate(), 22);

  await ok('DELETE', `/api/races/${race.id}`);
  const r = await ok('POST', '/api/gsync/sync');
  assert.ok(r.result.deleted >= 1);
  assert.ok(!live().some((e) => e.tags.chuid === `race-${race.id}@coaching-hub.local`));
  assert.ok(live().some((e) => e.title === 'My own note'), 'untagged events are never touched');
  assert.equal(google.primary.events.filter((e) => !e.deleted).length, 1, 'primary calendar untouched');
});

test('wrong secret is rejected and reported', async () => {
  const bad = fetchFor(fakeGoogle(), gs.scriptSource('other-secret'));
  await assert.rejects(gs.post('https://x', { secret: 'nope', action: 'ping' }, bad), /Wrong secret/);
});
