const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../server/calc');
const { zonedToUtc, buildCalendar } = require('../server/ics');
const importer = require('../server/importer');

test('coaching duration counts calendar months and handles month ends and leap years', () => {
  assert.equal(calc.coachingDuration('2025-04-29', '2026-10-21').label, '1 yr 5 mo');
  assert.equal(calc.coachingDuration('2026-10-01', '2026-10-21').label, '20 days');
  assert.equal(calc.coachingDuration('2026-01-31', '2026-02-28').months, 0); // not a full month yet
  assert.equal(calc.coachingDuration('2026-01-31', '2026-03-01').months, 1);
  assert.equal(calc.coachingDuration('2024-02-29', '2025-02-28').years, 0);
  assert.equal(calc.coachingDuration('2024-02-29', '2025-03-01').years, 1);
  assert.equal(calc.coachingDuration('2026-10-22', '2026-10-21'), null); // future start
});

test('race countdown in days and weeks', () => {
  assert.deepEqual(calc.raceCountdown('2026-10-21', '2026-10-21'), { days: 0, weeks: 0, label: 'Race day' });
  assert.equal(calc.raceCountdown('2026-10-22', '2026-10-21').label, '1 day');
  assert.equal(calc.raceCountdown('2026-12-27', '2026-10-21').label, '9 wk 4 d');
  assert.equal(calc.raceCountdown('2026-10-11', '2026-10-21').label, '10 days ago');
  // Across the October DST change: still whole days
  assert.equal(calc.raceCountdown('2026-11-01', '2026-10-24').days, 8);
});

test('birthdays, including 29 February', () => {
  assert.deepEqual(calc.nextBirthday('1988-10-26', '2026-10-21'), { date: '2026-10-26', inDays: 5, age: 38 });
  assert.equal(calc.nextBirthday('1992-02-29', '2027-01-01').date, '2027-02-28');
  assert.equal(calc.nextBirthday('1992-02-29', '2028-01-01').date, '2028-02-29');
});

test('week start is Monday', () => {
  assert.equal(calc.weekStart('2026-10-21'), '2026-10-19');
  assert.equal(calc.weekStart('2026-10-25'), '2026-10-19'); // Sunday
  assert.equal(calc.weekStart('2026-10-26'), '2026-10-26');
});

test('unit conversions', () => {
  assert.ok(Math.abs(calc.convert(10, 'km', 'mi') - 6.21371) < 1e-4);
  assert.equal(calc.convert(1, 'mi', 'km'), 1.609344);
  assert.equal(calc.convert(400, 'm', 'km'), 0.4);
  assert.ok(Math.abs(calc.convert(70, 'kg', 'lb') - 154.3236) < 1e-3);
  assert.equal(calc.convert('', 'km', 'mi'), null);
  assert.throws(() => calc.convert(1, 'km', 'kg'));
  assert.equal(calc.parseDuration('1:02:03'), 3723);
  assert.equal(calc.formatDuration(3723), '1:02:03');
  assert.equal(calc.formatDuration(95), '1:35');
  assert.equal(Math.round(calc.pacePerKmToPerMile(300)), 483); // 5:00/km -> 8:03/mi
});

test('test derivations state their method', () => {
  const ftp = calc.deriveFromTest('ftp_20min', { avgPower: 250 });
  assert.equal(ftp.value, 238);
  assert.match(ftp.method, /95%/);
  const css = calc.deriveFromTest('css', { t400: '6:10', t200: '2:55' });
  assert.equal(css.value, 97.5);
  assert.equal(calc.deriveFromTest('css', { t400: '2:00', t200: '2:55' }), null); // invalid
  assert.equal(calc.deriveFromTest('ftp_20min', {}), null);
});

test('historical thresholds use the value effective on the session date', () => {
  const tests = [
    { id: 1, accepted: 1, derived_metric: 'FTP', derived_value: 200, date: '2026-01-10', effective_from: '2026-01-12' },
    { id: 2, accepted: 1, derived_metric: 'FTP', derived_value: 220, date: '2026-05-01', effective_from: '2026-05-04' },
    { id: 3, accepted: 0, derived_metric: 'FTP', derived_value: 260, date: '2026-08-01' }, // recorded, not accepted
  ];
  assert.equal(calc.thresholdOn(tests, 'FTP', '2026-01-11'), null);
  assert.equal(calc.thresholdOn(tests, 'FTP', '2026-03-01').derived_value, 200);
  assert.equal(calc.thresholdOn(tests, 'FTP', '2026-05-03').derived_value, 200); // test done but not yet effective
  assert.equal(calc.thresholdOn(tests, 'FTP', '2026-05-04').derived_value, 220);
  assert.equal(calc.thresholdOn(tests, 'FTP', '2026-10-01').derived_value, 220); // unaccepted 260 ignored
});

test('missing data is null, genuine zero is zero', () => {
  const missing = calc.summariseWeek('2026-10-12', [], null);
  assert.equal(missing.source, 'missing');
  assert.equal(missing.completedHours, null);
  assert.equal(missing.compliance, null);
  const zero = calc.summariseWeek('2026-10-12', [], { completed_json: JSON.stringify({ run: 0 }), planned_json: JSON.stringify({ run: 4 }) });
  assert.equal(zero.source, 'weekly summary');
  assert.equal(zero.completedHours, 0);
  assert.equal(zero.compliance, 0);
  const blankFields = calc.summariseWeek('2026-10-12', [], { completed_json: JSON.stringify({}), planned_json: JSON.stringify({ run: 4 }) });
  assert.equal(blankFields.completedHours, null);
  // Baseline skips missing weeks instead of averaging in zeros
  const b = calc.baseline([{ week: 'a', completedHours: 8 }, { week: 'b', completedHours: null }, { week: 'c', completedHours: 10 }], 8);
  assert.equal(b.hours, 9);
  assert.equal(b.weeksUsed, 2);
});

test('loads from different methods are kept separate', () => {
  const s = calc.summariseWeek('2026-10-12', [
    { date: '2026-10-13', sport: 'bike', duration_min: 60, load: 70, load_type: 'TrainingPeaks TSS (bike)', source: 'manual', status: 'completed', rpe: 5 },
    { date: '2026-10-14', sport: 'run', duration_min: 60, load: 65, load_type: 'TrainingPeaks TSS (run)', source: 'manual', status: 'completed' },
  ], null);
  assert.deepEqual(Object.keys(s.loads).sort(), ['Session RPE (RPE × min)', 'TrainingPeaks TSS (bike)', 'TrainingPeaks TSS (run)']);
  assert.equal(s.loads['Session RPE (RPE × min)'], 300);
});

test('recommendation refuses to guess with insufficient data', () => {
  const summaries = [{ week: '2026-10-05', completedHours: 5, source: 'manual' }, { week: '2026-10-12', completedHours: 5, source: 'manual' }];
  const r = calc.recommendWeeklyHours({ summaries, profile: {}, rules: { minWeeksForBaseline: 4 }, upcomingRaces: [], healthFlags: [], today: '2026-10-21' });
  assert.equal(r.kind, 'insufficient');
  assert.ok(r.missing.some((m) => /at least 4/.test(m)));
  assert.ok(r.missing.some((m) => /weekly hours/.test(m)));
});

test('recommendation lists data used, uses ranges, respects availability and gives a conservative option', () => {
  const summaries = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'].map((w, i) => ({ week: w, completedHours: [8, 9, null, 8.5, 9, 8][i], source: 'imported' }));
  const r = calc.recommendWeeklyHours({ summaries, profile: { max_weekly_hours: 9 }, rules: { maxWeeklyProgressionPct: 10, minWeeksForBaseline: 4 }, upcomingRaces: [], healthFlags: ['Achilles tightness'], today: '2026-10-21' });
  assert.equal(r.kind, 'proposal');
  assert.equal(r.action.hours_min, 8.5);
  assert.equal(r.action.hours_max, 9); // capped by availability
  assert.equal(r.dataUsed.length, 5); // missing week excluded
  assert.ok(r.conservative.hi <= r.action.hours_min);
  assert.ok(r.flags[0].includes('Achilles'));
  assert.deepEqual(r.action.weeks, ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
});

test('race conflicts explain the gap and the guide used', () => {
  const c = calc.raceConflicts([
    { id: 1, name: 'Marathon', date: '2026-04-12', priority: 'A', status: 'planned' },
    { id: 2, name: 'Half', date: '2026-04-19', priority: 'B', status: 'planned' },
    { id: 3, name: 'Parkrun', date: '2026-06-01', priority: 'C', status: 'planned' },
  ]);
  assert.equal(c.length, 1);
  assert.match(c[0].message, /7 days between Marathon \(A\) and Half \(B\)/);
});

test('plan diff only reports changed fields', () => {
  const d = calc.diffPlanWeeks([{ week_start: '2026-10-19', hours_min: 8, hours_max: 9, phase: 'Base' }], [{ week_start: '2026-10-19', hours_min: 8, hours_max: 10 }, { week_start: '2026-10-26', phase: 'Base' }]);
  assert.equal(d.length, 2);
  assert.deepEqual(d[0].fields, [{ field: 'hours_max', from: 9, to: 10 }]);
  assert.equal(d[1].isNew, true);
});

test('calendar times respect daylight saving', () => {
  // 18:30 London: GMT in January, BST in July
  assert.equal(zonedToUtc('2026-01-15', '18:30', 'Europe/London').toISOString(), '2026-01-15T18:30:00.000Z');
  assert.equal(zonedToUtc('2026-07-15', '18:30', 'Europe/London').toISOString(), '2026-07-15T17:30:00.000Z');
  // Day of the spring change (29 March 2026) and the autumn change (25 October 2026)
  assert.equal(zonedToUtc('2026-03-29', '18:30', 'Europe/London').toISOString(), '2026-03-29T17:30:00.000Z');
  assert.equal(zonedToUtc('2026-10-25', '18:30', 'Europe/London').toISOString(), '2026-10-25T18:30:00.000Z');
  assert.equal(zonedToUtc('2026-11-01', '09:00', 'America/New_York').toISOString(), '2026-11-01T14:00:00.000Z');
  assert.equal(zonedToUtc('2026-10-31', '09:00', 'America/New_York').toISOString(), '2026-10-31T13:00:00.000Z');
});

test('ICS output: stable UIDs, all-day races, escaping and line folding', () => {
  const ics = buildCalendar([{ uid: 'race-1@coaching-hub.local', title: 'A race: M.O. – Lakeside, 70.3; long name '.repeat(3), date: '2026-12-27' }, { uid: 'task-2@coaching-hub.local', title: 'Call: M.O.', date: '2026-07-15', time: '18:30', timeZone: 'Europe/London', durationMin: 30, alarmMinutes: 60 }], { now: new Date('2026-10-21T00:00:00Z') });
  assert.match(ics, /UID:race-1@coaching-hub.local/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261227\r\nDTEND;VALUE=DATE:20261228/);
  assert.match(ics, /DTSTART:20260715T173000Z\r\nDTEND:20260715T180000Z/);
  assert.match(ics, /TRIGGER:-PT60M/);
  assert.match(ics, /Lakeside\\, 70.3\\;/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
});

test('CSV parser handles quotes, commas, newlines and BOM', () => {
  const { headers, records } = importer.parseCSV('﻿a,b,c\n1,"x, y","multi\nline"\n2,"say ""hi""",\n');
  assert.deepEqual(headers, ['a', 'b', 'c']);
  assert.equal(records[0].b, 'x, y');
  assert.equal(records[0].c, 'multi\nline');
  assert.equal(records[1].b, 'say "hi"');
  assert.equal(importer.parseCSV('a;b\n1;2').records[0].b, '2');
});

test('import mapping: units, time zones, validation', () => {
  const recs = [
    { __line: 2, d: '2026-10-13T23:30:00Z', s: 'Ride', t: '90', km: '45', rpe: '6' },
    { __line: 3, d: 'not a date', s: 'Run', t: '30' },
    { __line: 4, d: '2026-10-14T06:00:00Z', s: 'Run', t: 'abc' },
  ];
  const out = importer.mapRecords(recs, { date: 'd', sport: 's', duration: 't', durationUnit: 'minutes', distance: 'km', distanceUnit: 'mi', rpe: 'rpe', dateFormat: 'YYYY-MM-DD' }, { timeZone: 'Europe/Berlin' });
  assert.equal(out[0].activity.date, '2026-10-14'); // 23:30Z is 01:30 next day in Berlin
  assert.equal(out[0].activity.sport, 'bike');
  assert.equal(out[0].activity.distance_km, 72.42);
  assert.ok(out[1].errors[0].includes('not a valid'));
  assert.ok(out[2].errors.some((e) => e.includes('duration')));
  const uk = importer.toISODate('03/04/2026', 'DD/MM/YYYY');
  assert.equal(uk, '2026-04-03');
  assert.equal(importer.toISODate('31/02/2026', 'DD/MM/YYYY'), null);
});
