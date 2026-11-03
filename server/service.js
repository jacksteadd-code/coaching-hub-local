// Data access and coaching logic on top of the database. The HTTP layer in
// app.js only parses requests and calls these functions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const calc = require('./calc');
const { tx } = require('./db');
const importer = require('./importer');
const ics = require('./ics');

const DEFAULT_SETTINGS = {
  coach_name: 'Jack',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London',
  units: 'metric',
  rules: { maxWeeklyProgressionPct: 10, minWeeksForBaseline: 4, complianceLowPct: 70, recoveryGuideDays: { A: 21, B: 10, C: 5 }, wellbeingHigh: 4, motivationLow: 2 },
  phases: ['Transition', 'General Preparation', 'Specific Preparation', 'Race Preparation', 'Taper', 'Race', 'Recovery'],
  calendar: { categories: { races: true, calls: true, tests: true, reviews: true, camps: true, travel: false, birthdays: false }, names: 'initials', alarmMinutes: 60, athletes: 'all', key: null },
  backup: { autoDaily: true, keep: 14, extraFolder: '' },
  autoImport: { enabled: true, folder: '', log: [] },
  updates: { auto: true, repo: 'jacksteadd-code/coaching-hub-local', branch: 'main', lastCheck: null, lastResult: null, lastError: null, lastUpdated: null, lastUpdatedVersion: null },
  gsync: { enabled: false, url: '', secret: null, lastSync: null, lastResult: null, lastError: null },
  saved_views: [],
};

const SEVERITY = { high: 3, medium: 2, low: 1 };

class Service {
  constructor({ db, dataDir }, { today } = {}) {
    this.db = db;
    this.dataDir = dataDir;
    this._today = today;
  }

  today() {
    return this._today || calc.todayIn(this.settings().timezone);
  }

  // ---------- settings & audit ----------
  settings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const s = structuredClone(DEFAULT_SETTINGS);
    for (const r of rows) {
      const v = JSON.parse(r.value);
      s[r.key] = v && typeof v === 'object' && !Array.isArray(v) && s[r.key] && typeof s[r.key] === 'object' ? { ...s[r.key], ...v } : v;
    }
    if (!s.calendar.key) {
      s.calendar.key = crypto.randomBytes(12).toString('hex');
      this.saveSettings({ calendar: s.calendar }, false);
    }
    return s;
  }

  saveSettings(patch, audit = true) {
    const st = this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      st.run(k, JSON.stringify(v));
    }
    if (audit) this.audit(null, 'settings', null, 'update', `Changed settings: ${Object.keys(patch).join(', ')}`);
    return this.settings();
  }

  audit(athleteId, entity, entityId, action, summary) {
    this.db.prepare('INSERT INTO audit_log(athlete_id, entity, entity_id, action, summary) VALUES (?,?,?,?,?)').run(athleteId ?? null, entity, entityId ?? null, action, summary);
  }

  auditLog(limit = 200) {
    return this.db.prepare('SELECT a.*, at.name AS athlete_name FROM audit_log a LEFT JOIN athletes at ON at.id = a.athlete_id ORDER BY a.id DESC LIMIT ?').all(limit);
  }

  // ---------- generic CRUD ----------
  static FIELDS = {
    athletes: ['name', 'preferred_name', 'sport', 'status', 'start_date', 'birthday', 'timezone', 'email', 'phone', 'goals', 'phase', 'photo_id', 'checkin_days', 'review_days', 'test_days_json', 'profile_json', 'health_json', 'last_review_date', 'is_sample'],
    races: ['athlete_id', 'name', 'date', 'location', 'timezone', 'sport', 'distance', 'priority', 'status', 'goal', 'target', 'result', 'splits', 'course', 'travel', 'report', 'lessons', 'recovery'],
    tests: ['athlete_id', 'discipline', 'test_type', 'date', 'protocol', 'raw_json', 'raw_summary', 'derived_metric', 'derived_value', 'derived_unit', 'method', 'conditions', 'source', 'accepted', 'effective_from', 'notes'],
    activities: ['athlete_id', 'date', 'sport', 'title', 'status', 'duration_min', 'planned_min', 'distance_km', 'load', 'load_type', 'rpe', 'comments', 'source', 'source_ref', 'import_id'],
    notes: ['athlete_id', 'date', 'kind', 'body', 'shareable'],
    tasks: ['athlete_id', 'title', 'kind', 'due_date', 'due_time', 'timezone', 'owner', 'done', 'notes'],
  };

  validate(table, row, isNew) {
    const req = { athletes: ['name'], races: ['athlete_id', 'name', 'date'], tests: ['athlete_id', 'discipline', 'test_type', 'date'], activities: ['athlete_id', 'date', 'sport'], notes: ['athlete_id', 'body'], tasks: ['title'] }[table];
    const errors = [];
    if (isNew) for (const f of req) if (row[f] == null || row[f] === '') errors.push(`${f} is required`);
    for (const f of ['date', 'start_date', 'birthday', 'due_date', 'effective_from', 'last_review_date']) {
      if (row[f] && !calc.parseDate(row[f])) errors.push(`${f} must be a valid date (YYYY-MM-DD)`);
    }
    if (row.timezone) {
      try { new Intl.DateTimeFormat('en', { timeZone: row.timezone }); } catch { errors.push(`Unknown time zone "${row.timezone}"`); }
    }
    for (const f of ['duration_min', 'planned_min', 'distance_km', 'load', 'rpe', 'derived_value', 'checkin_days', 'review_days']) {
      if (row[f] != null && row[f] !== '' && (Number.isNaN(Number(row[f])) || Number(row[f]) < 0)) errors.push(`${f} must be a non-negative number`);
    }
    if (row.rpe != null && row.rpe !== '' && Number(row.rpe) > 10) errors.push('rpe must be 0–10');
    if (errors.length) {
      const e = new Error(errors.join('; '));
      e.status = 400;
      throw e;
    }
  }

  clean(table, body) {
    const row = {};
    for (const f of Service.FIELDS[table]) {
      if (!(f in body)) continue;
      let v = body[f];
      if (v === '') v = null;
      if (f.endsWith('_json') && v != null && typeof v !== 'string') v = JSON.stringify(v);
      if (typeof v === 'boolean') v = v ? 1 : 0;
      row[f] = v;
    }
    return row;
  }

  insert(table, body) {
    const row = this.clean(table, body);
    if (table === 'notes' && !row.date) row.date = this.today();
    this.validate(table, row, true);
    const keys = Object.keys(row);
    const r = this.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
    const id = Number(r.lastInsertRowid);
    this.audit(row.athlete_id ?? (table === 'athletes' ? id : null), table, id, 'create', `Added ${table.slice(0, -1)}${row.name || row.title ? ': ' + (row.name || row.title) : ''}`);
    return this.get(table, id);
  }

  update(table, id, body) {
    const row = this.clean(table, body);
    delete row.athlete_id;
    this.validate(table, row, false);
    const keys = Object.keys(row);
    if (!keys.length) return this.get(table, id);
    if (table === 'athletes') keys.push('updated_at'), (row.updated_at = new Date().toISOString());
    const r = this.db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => row[k]), id);
    if (!r.changes) throw notFound();
    const cur = this.get(table, id);
    if (table === 'tests' && 'accepted' in row) this.audit(cur.athlete_id, 'tests', id, 'update', `${row.accepted ? 'Accepted' : 'Un-accepted'} ${cur.derived_metric || cur.test_type} ${cur.derived_value ?? ''} for zones from ${cur.effective_from || cur.date}`);
    else if (table !== 'tasks') this.audit(table === 'athletes' ? id : cur.athlete_id, table, id, 'update', `Edited ${table.slice(0, -1)}${cur.name || cur.title ? ': ' + (cur.name || cur.title) : ''}`);
    return cur;
  }

  remove(table, id) {
    const cur = this.get(table, id);
    if (table === 'athletes') {
      const files = this.db.prepare('SELECT stored_name FROM attachments WHERE athlete_id = ?').all(id);
      for (const f of files) fs.rmSync(path.join(this.dataDir, 'attachments', f.stored_name), { force: true });
    }
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    this.audit(table === 'athletes' ? null : cur.athlete_id, table, id, 'delete', `Deleted ${table.slice(0, -1)}${cur.name || cur.title ? ': ' + (cur.name || cur.title) : ''}`);
    return { ok: true };
  }

  get(table, id) {
    const r = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!r) throw notFound();
    return { ...r };
  }

  // ---------- tests ----------
  addTest(body) {
    const raw = typeof body.raw_json === 'string' ? JSON.parse(body.raw_json || '{}') : body.raw_json || {};
    const d = calc.deriveFromTest(body.test_type, raw);
    const derived = d ? { derived_metric: d.metric, derived_value: d.value, derived_unit: d.unit, method: d.method } : {};
    return this.insert('tests', { ...body, raw_json: raw, ...derived, ...pickDefined(body, ['derived_metric', 'derived_value', 'derived_unit', 'method']) });
  }

  // ---------- athletes ----------
  athleteRows(includeSample = true) {
    return this.db.prepare(`SELECT * FROM athletes ${includeSample ? '' : 'WHERE is_sample = 0'} ORDER BY status = 'former', name COLLATE NOCASE`).all().map((r) => ({ ...r }));
  }

  load(athleteId) {
    const q = (sql) => this.db.prepare(sql).all(athleteId).map((r) => ({ ...r }));
    return {
      athlete: this.get('athletes', athleteId),
      races: q('SELECT * FROM races WHERE athlete_id = ? ORDER BY date'),
      tests: q('SELECT * FROM tests WHERE athlete_id = ? ORDER BY date DESC, id DESC'),
      activities: q('SELECT * FROM activities WHERE athlete_id = ? ORDER BY date, id'),
      logs: q('SELECT * FROM weekly_logs WHERE athlete_id = ? ORDER BY week_start'),
      notes: q('SELECT * FROM notes WHERE athlete_id = ? ORDER BY date DESC, id DESC'),
      tasks: q('SELECT * FROM tasks WHERE athlete_id = ? ORDER BY done, due_date IS NULL, due_date'),
      plan: q('SELECT * FROM plan_weeks WHERE athlete_id = ? ORDER BY week_start'),
      proposals: q('SELECT * FROM proposals WHERE athlete_id = ? ORDER BY id DESC'),
      versions: q('SELECT id, created_at, note FROM plan_versions WHERE athlete_id = ? ORDER BY id DESC'),
      attachments: q('SELECT * FROM attachments WHERE athlete_id = ? ORDER BY id DESC'),
      imports: q('SELECT * FROM imports WHERE athlete_id = ? ORDER BY id DESC'),
    };
  }

  summaries(data, weeks = 26, endWeek) {
    const end = endWeek || calc.weekStart(this.today());
    const logsByWeek = new Map(data.logs.map((l) => [l.week_start, l]));
    const out = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const w = calc.addDays(end, -7 * i);
      out.push(calc.summariseWeek(w, data.activities, logsByWeek.get(w)));
    }
    return out;
  }

  derive(data, settings = this.settings()) {
    const a = data.athlete;
    const today = this.today();
    const profile = JSON.parse(a.profile_json || '{}');
    const health = JSON.parse(a.health_json || '{}');
    const sums = this.summaries(data, 26);
    const lastCompleteWeek = sums[sums.length - 2];
    const thisWeek = sums[sums.length - 1];
    const upcoming = data.races.filter((r) => r.date >= today && r.status === 'planned');
    const prio = { A: 0, B: 1, C: 2 };
    const nextPriority = [...upcoming].sort((x, y) => prio[x.priority] - prio[y.priority] || (x.date < y.date ? -1 : 1))[0] || null;
    const lastCheckin = [...data.logs].reverse().find((l) => l.athlete_comments || l.fatigue != null || l.motivation != null);
    const lastTest = {};
    for (const d of ['swim', 'bike', 'run']) {
      const t = data.tests.find((x) => x.discipline === d);
      lastTest[d] = t ? t.date : null;
    }
    const testDays = JSON.parse(a.test_days_json || '{}');
    const planNow = data.plan.find((p) => p.week_start === calc.weekStart(today));
    return {
      today,
      profile,
      health,
      coaching: a.start_date ? calc.coachingDuration(a.start_date, today) : null,
      nextRace: nextPriority ? { ...nextPriority, countdown: calc.raceCountdown(nextPriority.date, today) } : null,
      phase: planNow?.phase || a.phase || null,
      thisWeek,
      lastWeek: lastCompleteWeek,
      lastCheckin: lastCheckin ? lastCheckin.week_start : null,
      lastTest,
      testWindows: Object.fromEntries(['swim', 'bike', 'run'].map((d) => [d, this.testWindow(d, lastTest[d], testDays[d], data.races, today)])),
      birthday: a.birthday ? calc.nextBirthday(a.birthday, today) : null,
      flags: this.flags(data, sums, settings, { profile, health, lastCheckin, lastTest, testDays, today }),
      conflicts: calc.raceConflicts(data.races.filter((r) => r.status === 'planned'), settings.rules.recoveryGuideDays),
    };
  }

  // Proposed window for the next test: due date from the athlete's own
  // frequency, moved away from priority races rather than inserted blindly.
  testWindow(discipline, last, everyDays, races, today) {
    if (!everyDays) return { status: 'off', message: 'No testing frequency set' };
    if (!last) return { status: 'never', message: `No ${discipline} test recorded`, from: today, to: calc.addDays(today, 14) };
    let from = calc.addDays(last, everyDays);
    const notes = [];
    const clash = races.find((r) => r.status === 'planned' && r.priority !== 'C' && Math.abs(calc.daysBetween(from, r.date)) <= 10);
    if (clash) {
      from = calc.addDays(clash.date, 10);
      notes.push(`moved after ${clash.name} (${clash.priority} race on ${clash.date})`);
    }
    const to = calc.addDays(from, 14);
    const status = to < today ? 'overdue' : from <= today ? 'due' : 'later';
    return { status, from, to, message: `Window ${from} to ${to}${notes.length ? ', ' + notes.join('; ') : ''}` };
  }

  flags(data, sums, settings, ctx) {
    const a = data.athlete;
    const f = [];
    if (a.status !== 'active') return f;
    const { today, health, lastCheckin } = ctx;
    const rules = settings.rules;
    // Check-in overdue
    if (a.checkin_days) {
      const due = lastCheckin ? calc.addDays(lastCheckin.week_start, 6 + a.checkin_days) : null;
      if (!lastCheckin) f.push({ type: 'checkin', severity: 'medium', message: 'No check-in recorded yet (athlete comments or wellbeing scores).', action: 'Record a check-in in Weekly training.' });
      else if (due < today) f.push({ type: 'checkin', severity: 'medium', message: `Last check-in was for the week of ${lastCheckin.week_start}; agreed frequency is every ${a.checkin_days} days.`, action: 'Schedule or record a check-in.' });
    }
    // Plan review
    if (a.review_days) {
      if (!a.last_review_date) f.push({ type: 'review', severity: 'low', message: 'No plan review recorded.', action: 'Review the season plan and mark it reviewed.' });
      else if (calc.addDays(a.last_review_date, a.review_days) < today) f.push({ type: 'review', severity: 'medium', message: `Plan last reviewed ${a.last_review_date}; agreed every ${a.review_days} days.`, action: 'Review the season plan.' });
    }
    // Compliance, only on weeks with data and a plan
    const recent = sums.slice(-3, -1);
    const low = recent.filter((s) => s.compliance != null && s.compliance * 100 < rules.complianceLowPct);
    if (low.length === 2) f.push({ type: 'compliance', severity: 'medium', message: `Completed ${low.map((s) => Math.round(s.compliance * 100) + '%').join(' and ')} of planned hours in the weeks of ${low.map((s) => s.week).join(' and ')} (threshold ${rules.complianceLowPct}%).`, action: 'Check reasons for missed sessions and whether the plan fits their availability.' });
    const missingWeeks = recent.filter((s) => s.source === 'missing');
    if (missingWeeks.length) f.push({ type: 'data', severity: 'low', message: `No training data for the week${missingWeeks.length > 1 ? 's' : ''} of ${missingWeeks.map((s) => s.week).join(', ')}. This is missing data, not zero training.`, action: 'Import or enter the training.' });
    // Wellbeing (athlete-reported)
    const lastLog = [...data.logs].reverse().find((l) => l.week_start >= calc.addDays(calc.weekStart(today), -14));
    if (lastLog) {
      const hi = ['fatigue', 'soreness', 'stress'].filter((k) => lastLog[k] != null && lastLog[k] >= rules.wellbeingHigh);
      if (hi.length) f.push({ type: 'wellbeing', severity: 'medium', message: `Reported high ${hi.join(', ')} (${hi.map((k) => lastLog[k] + '/5').join(', ')}) in the week of ${lastLog.week_start}.`, action: 'Discuss with the athlete before progressing load.' });
      if (lastLog.motivation != null && lastLog.motivation <= rules.motivationLow) f.push({ type: 'wellbeing', severity: 'medium', message: `Reported motivation ${lastLog.motivation}/5 in the week of ${lastLog.week_start}.`, action: 'Check in on motivation and context.' });
    }
    if (health.active_issue) f.push({ type: 'health', severity: 'high', message: `Athlete-reported issue marked for review${health.injuries ? ': ' + truncate(health.injuries, 80) : ''}.`, action: 'Review with the athlete; follow any guidance from their healthcare professional.' });
    // Tests
    for (const d of ['swim', 'bike', 'run']) {
      if (a.sport !== 'triathlon' && !(a.sport === 'run' && d === 'run') && !(a.sport === 'bike' && d === 'bike')) continue;
      const w = this.testWindow(d, ctx.lastTest[d], ctx.testDays[d], data.races, today);
      if (w.status === 'overdue' || w.status === 'due') f.push({ type: 'test', severity: 'low', message: `${cap(d)} test ${w.status}: ${w.message}.`, action: 'Plan a test if training and fatigue allow.' });
    }
    // Races
    for (const c of calc.raceConflicts(data.races.filter((r) => r.status === 'planned' && r.date >= today), rules.recoveryGuideDays)) f.push({ type: 'race', severity: c.severity, message: c.message, action: 'Confirm race priorities.' });
    const soon = data.races.filter((r) => r.status === 'planned' && r.date >= today && calc.daysBetween(today, r.date) <= 14);
    for (const r of soon) f.push({ type: 'race', severity: r.priority === 'A' ? 'medium' : 'low', message: `${r.name} (${r.priority}) in ${calc.daysBetween(today, r.date)} days.`, action: 'Confirm race plan, logistics and taper.' });
    const pastNoResult = data.races.filter((r) => r.status === 'planned' && r.date < today);
    for (const r of pastNoResult) f.push({ type: 'race', severity: 'low', message: `${r.name} on ${r.date} has no result recorded.`, action: 'Record the result or DNS/DNF.' });
    // Tasks
    const overdue = data.tasks.filter((t) => !t.done && t.due_date && t.due_date < today);
    if (overdue.length) f.push({ type: 'task', severity: 'medium', message: `${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}: ${overdue.slice(0, 2).map((t) => t.title).join('; ')}.`, action: 'Complete or reschedule.' });
    const pending = data.proposals.filter((p) => p.status === 'pending');
    if (pending.length) f.push({ type: 'proposal', severity: 'low', message: `${pending.length} plan suggestion${pending.length > 1 ? 's' : ''} waiting for your review.`, action: 'Approve, edit or reject.' });
    // Birthday
    if (a.birthday) {
      const b = calc.nextBirthday(a.birthday, today);
      if (b && b.inDays <= 7) f.push({ type: 'birthday', severity: 'low', message: b.inDays === 0 ? 'Birthday today.' : `Birthday in ${b.inDays} day${b.inDays > 1 ? 's' : ''} (${b.date}).`, action: 'Send a message.' });
    }
    return f.sort((x, y) => SEVERITY[y.severity] - SEVERITY[x.severity]);
  }

  listAthletes() {
    const settings = this.settings();
    return this.athleteRows().map((a) => {
      const data = this.load(a.id);
      const d = this.derive(data, settings);
      return {
        ...a,
        profile_json: undefined,
        health_json: undefined,
        coaching: d.coaching,
        nextRace: d.nextRace,
        phase: d.phase,
        lastWeek: pickWeek(d.lastWeek),
        thisWeek: pickWeek(d.thisWeek),
        lastCheckin: d.lastCheckin,
        lastTest: d.lastTest,
        flags: d.flags,
        mainGoal: a.goals,
        billing: JSON.parse(a.profile_json || '{}').billing || 'paying',
      };
    });
  }

  athleteFull(id) {
    const data = this.load(id);
    const d = this.derive(data);
    const today = this.today();
    const thresholds = {};
    for (const m of ['FTP', 'CSS', 'Run LTHR', 'Threshold pace']) {
      const t = calc.thresholdOn(data.tests, m, today);
      if (t) thresholds[m] = { value: t.derived_value, unit: t.derived_unit, from: t.effective_from || t.date, testId: t.id };
    }
    return {
      ...data,
      activities: data.activities.slice(-400),
      derived: d,
      thresholds,
      zones: thresholds.FTP ? calc.powerZones(thresholds.FTP.value) : null,
      summaries: this.summaries(data, 26),
      timeline: this.timeline(data),
    };
  }

  timeline(data) {
    const items = [];
    for (const n of data.notes) items.push({ date: n.date, kind: n.kind, text: n.body, id: n.id, ref: 'note', shareable: !!n.shareable });
    for (const t of data.tests) items.push({ date: t.date, kind: 'test', text: `${cap(t.discipline)} test: ${t.test_type}${t.derived_value != null ? ` → ${t.derived_metric} ${fmtValue(t.derived_value, t.derived_unit)}` : ''}${t.accepted ? ' (accepted for zones)' : ''}`, id: t.id, ref: 'test' });
    for (const r of data.races) if (r.status !== 'planned') items.push({ date: r.date, kind: 'race', text: `${r.name}: ${r.status}${r.result ? ' – ' + r.result : ''}`, id: r.id, ref: 'race' });
    for (const v of data.versions) items.push({ date: v.created_at.slice(0, 10), kind: 'plan', text: `Plan change: ${v.note || 'edited'}`, id: v.id, ref: 'version' });
    for (const p of data.proposals) if (p.decided_at) items.push({ date: p.decided_at.slice(0, 10), kind: 'plan', text: `Suggestion ${p.status}: ${p.title}`, id: p.id, ref: 'proposal' });
    for (const i of data.imports) items.push({ date: i.created_at.slice(0, 10), kind: 'import', text: `Imported ${i.filename || 'CSV'}: ${i.rows_added} added, ${i.rows_duplicate} unchanged/updated, ${i.rows_invalid} invalid`, id: i.id, ref: 'import' });
    return items.sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  // ---------- overview ----------
  overview() {
    const settings = this.settings();
    const today = this.today();
    const athletes = this.listAthletes().filter((a) => a.status === 'active');
    const attention = athletes
      .map((a) => ({ id: a.id, name: a.preferred_name || a.name, photo_id: a.photo_id, is_sample: a.is_sample, flags: a.flags, score: a.flags.reduce((s, f) => s + SEVERITY[f.severity], 0) }))
      .filter((a) => a.flags.length)
      .sort((x, y) => y.score - x.score);
    const horizon = calc.addDays(today, 56);
    const races = this.db.prepare(`SELECT r.*, a.name AS athlete_name, a.preferred_name FROM races r JOIN athletes a ON a.id = r.athlete_id WHERE r.status = 'planned' AND r.date >= ? AND r.date <= ? AND a.status = 'active' ORDER BY r.date`).all(today, horizon).map((r) => ({ ...r, countdown: calc.raceCountdown(r.date, today) }));
    const weekEnd = calc.addDays(calc.weekStart(today), 6);
    const tasks = this.db.prepare(`SELECT t.*, a.name AS athlete_name FROM tasks t LEFT JOIN athletes a ON a.id = t.athlete_id WHERE t.done = 0 AND (t.due_date IS NULL OR t.due_date <= ?) ORDER BY t.due_date IS NULL, t.due_date LIMIT 30`).all(weekEnd).map((t) => ({ ...t }));
    const week = calc.addDays(calc.weekStart(today), -7);
    const reviewed = this.db.prepare('SELECT COUNT(*) AS n FROM weekly_logs l JOIN athletes a ON a.id = l.athlete_id WHERE l.week_start = ? AND l.reviewed_at IS NOT NULL AND a.status = ?').get(week, 'active').n;
    const compare = athletes.map((a) => ({ id: a.id, name: a.preferred_name || a.name, photo_id: a.photo_id, is_sample: a.is_sample, last: a.lastWeek, phase: a.phase }));
    const birthdays = athletes.filter((a) => a.birthday).map((a) => ({ id: a.id, name: a.preferred_name || a.name, ...calc.nextBirthday(a.birthday, today) })).filter((b) => b.inDays <= 14).sort((x, y) => x.inDays - y.inDays);
    return { today, weekEnd, attention, races, tasks, review: { week, reviewed, total: athletes.length }, compare, birthdays, counts: { active: athletes.length, sample: athletes.filter((a) => a.is_sample).length } };
  }

  // ---------- weekly logs & review ----------
  upsertWeek(athleteId, week, body) {
    if (calc.weekStart(week) !== week) throw badRequest('Week must start on a Monday');
    const fields = ['planned_json', 'completed_json', 'sessions_planned', 'sessions_done', 'sleep', 'fatigue', 'soreness', 'stress', 'motivation', 'athlete_comments', 'missed_reasons', 'coach_notes', 'next_actions', 'brief', 'reviewed_at'];
    const row = {};
    for (const f of fields) if (f in body) {
      let v = body[f];
      if (v === '') v = null;
      if (f.endsWith('_json') && v != null && typeof v !== 'string') {
        const cleaned = {};
        for (const [k, x] of Object.entries(v)) if (x !== '' && x != null) {
          if (Number.isNaN(Number(x)) || Number(x) < 0) throw badRequest(`${k} hours must be a non-negative number`);
          cleaned[k] = Number(x);
        }
        v = Object.keys(cleaned).length ? JSON.stringify(cleaned) : null;
      }
      if (['sleep', 'fatigue', 'soreness', 'stress', 'motivation'].includes(f) && v != null && !(v >= 1 && v <= 5)) throw badRequest(`${f} must be 1–5`);
      row[f] = v;
    }
    this.db.prepare('INSERT INTO weekly_logs(athlete_id, week_start) VALUES (?, ?) ON CONFLICT DO NOTHING').run(athleteId, week);
    const keys = Object.keys(row);
    if (keys.length) this.db.prepare(`UPDATE weekly_logs SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE athlete_id = ? AND week_start = ?`).run(...keys.map((k) => row[k]), athleteId, week);
    return { ...this.db.prepare('SELECT * FROM weekly_logs WHERE athlete_id = ? AND week_start = ?').get(athleteId, week) };
  }

  weekDetail(athleteId, week) {
    const data = this.load(athleteId);
    const log = data.logs.find((l) => l.week_start === week) || null;
    const summary = calc.summariseWeek(week, data.activities, log);
    const prev = calc.summariseWeek(calc.addDays(week, -7), data.activities, data.logs.find((l) => l.week_start === calc.addDays(week, -7)));
    const before = this.summaries(data, 9, calc.addDays(week, -7));
    const base = calc.baseline(before, 8);
    const plan = data.plan.find((p) => p.week_start === week) || null;
    const nextPlan = data.plan.find((p) => p.week_start === calc.addDays(week, 7)) || null;
    const activities = data.activities.filter((a) => calc.weekStart(a.date) === week);
    return { athlete: pickAthlete(data.athlete), week, log, summary, prev, baseline: base, plan, nextPlan, activities, openTasks: data.tasks.filter((t) => !t.done), brief: log?.brief || this.draftBrief(data, week, summary, prev, base, plan, nextPlan) };
  }

  // Deterministic first draft; the coach edits it.
  draftBrief(data, week, s, prev, base, plan, nextPlan) {
    const a = data.athlete;
    const h = (x) => (x == null ? 'no data' : `${x.toFixed(1)} h`);
    const lines = [];
    lines.push(`WEEKLY REVIEW – ${a.preferred_name || a.name} – week of ${week}`);
    lines.push('');
    lines.push(`Planned: ${s.plannedHours != null ? s.plannedHours.toFixed(1) + ' h' : plan ? `${plan.hours_min ?? '?'}–${plan.hours_max ?? '?'} h (season plan)` : 'no plan recorded'}${plan?.focus ? `; focus: ${plan.focus}` : ''}`);
    lines.push(`Happened: ${h(s.completedHours)}${s.source !== 'missing' ? ` (${s.source})` : ''}${s.sessionsDone != null ? `, ${s.sessionsDone} sessions` : ''}${s.missedSessions ? `, ${s.missedSessions} missed` : ''}`);
    lines.push(`Trend: last week ${h(prev.completedHours)}; own baseline ${base.hours != null ? base.hours.toFixed(1) + ' h (median of ' + base.weeksUsed + ' weeks with data)' : 'not enough data'}`);
    const log = data.logs.find((l) => l.week_start === week);
    const wb = log ? ['sleep', 'fatigue', 'soreness', 'stress', 'motivation'].filter((k) => log[k] != null).map((k) => `${k} ${log[k]}/5`) : [];
    lines.push(`Athlete feedback: ${[log?.athlete_comments, wb.join(', ')].filter(Boolean).join(' | ') || 'none recorded'}`);
    if (log?.missed_reasons) lines.push(`Missed/modified: ${log.missed_reasons}`);
    const d = this.derive(data);
    const discuss = d.flags.filter((f) => ['wellbeing', 'health', 'compliance', 'race'].includes(f.type)).map((f) => '- ' + f.message);
    lines.push('To discuss:');
    lines.push(...(discuss.length ? discuss : ['- (add)']));
    lines.push(`Suggested focus next week: ${nextPlan ? `${nextPlan.focus || nextPlan.phase || ''} ${nextPlan.hours_min != null ? `(${nextPlan.hours_min}–${nextPlan.hours_max} h)` : ''}`.trim() : '(no plan week yet – add in Season planner)'}`);
    const open = data.tasks.filter((t) => !t.done);
    lines.push(`Outstanding tasks: ${open.length ? open.map((t) => t.title + (t.due_date ? ` (due ${t.due_date})` : '')).join('; ') : 'none'}`);
    return lines.join('\n');
  }

  reviewQueue(week) {
    return this.athleteRows().filter((a) => a.status === 'active').map((a) => {
      const data = this.load(a.id);
      const log = data.logs.find((l) => l.week_start === week);
      const s = calc.summariseWeek(week, data.activities, log);
      return { id: a.id, name: a.preferred_name || a.name, is_sample: a.is_sample, summary: pickWeek(s), reviewed_at: log?.reviewed_at || null, hasComments: !!log?.athlete_comments, flags: this.derive(data).flags.length };
    }).sort((x, y) => (!!x.reviewed_at - !!y.reviewed_at) || y.flags - x.flags);
  }

  // ---------- plan ----------
  planSnapshot(athleteId) {
    return this.db.prepare('SELECT week_start, phase, hours_min, hours_max, sport_hours_json, focus, intensity, key_sessions, recovery, milestone, rationale FROM plan_weeks WHERE athlete_id = ? ORDER BY week_start').all(athleteId).map((r) => ({ ...r }));
  }

  previewPlan(athleteId, weeks) {
    return calc.diffPlanWeeks(this.planSnapshot(athleteId), weeks);
  }

  // Applies coach-entered plan weeks and records a version. Only called from
  // an explicit coach action (save in the planner or approve a suggestion).
  applyPlan(athleteId, weeks, note, { deleteWeeks = [] } = {}) {
    const fields = ['phase', 'hours_min', 'hours_max', 'sport_hours_json', 'focus', 'intensity', 'key_sessions', 'recovery', 'milestone', 'rationale'];
    for (const w of weeks) {
      if (calc.weekStart(w.week_start) !== w.week_start) throw badRequest(`${w.week_start} is not a Monday`);
      if (w.hours_min != null && w.hours_max != null && w.hours_min !== '' && w.hours_max !== '' && Number(w.hours_min) > Number(w.hours_max)) throw badRequest(`Week ${w.week_start}: minimum hours above maximum`);
    }
    return tx(this.db, () => {
      const before = this.planSnapshot(athleteId);
      for (const w of deleteWeeks) this.db.prepare('DELETE FROM plan_weeks WHERE athlete_id = ? AND week_start = ?').run(athleteId, w);
      for (const w of weeks) {
        this.db.prepare('INSERT INTO plan_weeks(athlete_id, week_start) VALUES (?, ?) ON CONFLICT DO NOTHING').run(athleteId, w.week_start);
        const keys = fields.filter((f) => f in w);
        if (keys.length) this.db.prepare(`UPDATE plan_weeks SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE athlete_id = ? AND week_start = ?`).run(...keys.map((k) => (w[k] === '' ? null : typeof w[k] === 'object' && w[k] ? JSON.stringify(w[k]) : w[k])), athleteId, w.week_start);
      }
      const v = this.db.prepare('INSERT INTO plan_versions(athlete_id, note, snapshot_json) VALUES (?, ?, ?)').run(athleteId, note || 'Plan edited', JSON.stringify(before));
      this.audit(athleteId, 'plan', Number(v.lastInsertRowid), 'update', `Plan changed: ${note || 'edited'} (${weeks.length} week${weeks.length === 1 ? '' : 's'}${deleteWeeks.length ? `, ${deleteWeeks.length} removed` : ''}). Previous version saved.`);
      return this.planSnapshot(athleteId);
    });
  }

  restoreVersion(versionId) {
    const v = this.get('plan_versions', versionId);
    const snapshot = JSON.parse(v.snapshot_json);
    const current = this.planSnapshot(v.athlete_id).map((w) => w.week_start);
    const keep = new Set(snapshot.map((w) => w.week_start));
    return this.applyPlan(v.athlete_id, snapshot, `Restored version from ${v.created_at}`, { deleteWeeks: current.filter((w) => !keep.has(w)) });
  }

  shiftPreview(athleteId, from, to, n) {
    const current = this.planSnapshot(athleteId);
    const moved = calc.shiftWeeks(current, from, to, n);
    const vacated = current.filter((w) => w.week_start >= from && w.week_start <= to).map((w) => w.week_start).filter((w) => !moved.some((m) => m.week_start === w));
    const overwritten = moved.filter((m) => current.some((c) => c.week_start === m.week_start && !(c.week_start >= from && c.week_start <= to))).map((m) => m.week_start);
    const races = this.load(athleteId).races.filter((r) => r.status === 'planned');
    const raceNotes = [];
    for (const m of moved) {
      if (/race|taper/i.test(m.phase || '')) {
        const r = races.find((x) => calc.weekStart(x.date) === m.week_start);
        if (!r && /race/i.test(m.phase || '')) raceNotes.push(`${m.phase} week would land on ${m.week_start}, which has no race.`);
      }
    }
    return { weeks: moved, vacated, overwritten, changes: calc.diffPlanWeeks(current, moved), warnings: raceNotes };
  }

  // ---------- recommendations / proposals ----------
  recommend(athleteId, weeksAhead = 4) {
    const data = this.load(athleteId);
    const settings = this.settings();
    const profile = JSON.parse(data.athlete.profile_json || '{}');
    const health = JSON.parse(data.athlete.health_json || '{}');
    const healthFlags = [];
    if (health.active_issue) healthFlags.push(health.injuries ? truncate(health.injuries, 100) : 'issue marked for review');
    const recentInterruptions = data.notes.filter((n) => n.kind === 'interruption' && n.date >= calc.addDays(this.today(), -42));
    for (const n of recentInterruptions) healthFlags.push(`interruption ${n.date}: ${truncate(n.body, 80)}`);
    const rec = calc.recommendWeeklyHours({ summaries: this.summaries(data, 30), profile, rules: settings.rules, upcomingRaces: data.races.filter((r) => r.status === 'planned'), healthFlags, today: this.today(), weeksAhead });
    if (rec.kind === 'insufficient') return rec;
    const weeks = rec.action.weeks.map((w) => ({ week_start: w, hours_min: rec.action.hours_min, hours_max: rec.action.hours_max, rationale: 'Weekly-hours range from recent baseline (see suggestion).' }));
    const changes = this.previewPlan(athleteId, weeks);
    const r = this.db.prepare('INSERT INTO proposals(athlete_id, origin, title, body_json, changes_json) VALUES (?, ?, ?, ?, ?)').run(athleteId, 'calculation', rec.title, JSON.stringify(rec), JSON.stringify(weeks));
    this.audit(athleteId, 'proposal', Number(r.lastInsertRowid), 'create', `Suggestion created: ${rec.title}`);
    return { ...rec, id: Number(r.lastInsertRowid), changes };
  }

  saveAiSuggestion(athleteId, text, title) {
    if (!text || !text.trim()) throw badRequest('Paste the AI response first');
    const body = { kind: 'ai', text: text.trim(), basis: 'AI-generated text pasted by the coach. Not verified; nothing is applied automatically.' };
    const r = this.db.prepare('INSERT INTO proposals(athlete_id, origin, title, body_json) VALUES (?, ?, ?, ?)').run(athleteId, 'ai', title || 'AI suggestion', JSON.stringify(body));
    this.audit(athleteId, 'proposal', Number(r.lastInsertRowid), 'create', 'AI suggestion saved for review');
    return this.get('proposals', Number(r.lastInsertRowid));
  }

  decideProposal(id, decision, { weeks, note } = {}) {
    const p = this.get('proposals', id);
    if (p.status !== 'pending') throw badRequest(`Already ${p.status}`);
    if (decision === 'apply') {
      const toApply = weeks || (p.changes_json ? JSON.parse(p.changes_json) : null);
      if (toApply && toApply.length) this.applyPlan(p.athlete_id, toApply, note || `Approved suggestion: ${p.title}`);
      this.db.prepare("UPDATE proposals SET status = ?, decided_at = datetime('now') WHERE id = ?").run(toApply && toApply.length ? 'applied' : 'saved', id);
    } else if (decision === 'reject') {
      this.db.prepare("UPDATE proposals SET status = 'rejected', decided_at = datetime('now') WHERE id = ?").run(id);
    } else if (decision === 'keep') {
      this.db.prepare("UPDATE proposals SET status = 'saved', decided_at = datetime('now') WHERE id = ?").run(id);
    } else throw badRequest('Unknown decision');
    this.audit(p.athlete_id, 'proposal', id, decision, `Suggestion ${decision === 'apply' ? 'approved' : decision === 'keep' ? 'kept as note' : 'rejected'}: ${p.title}`);
    return this.get('proposals', id);
  }

  // Concise athlete summary to paste into an AI assistant. Sections the coach
  // does not tick are left out; health is off by default.
  aiSummary(athleteId, { include = ['goals', 'availability', 'training', 'races', 'tests', 'plan'], anonymise = true } = {}) {
    const data = this.load(athleteId);
    const d = this.derive(data);
    const a = data.athlete;
    const p = d.profile;
    const name = anonymise ? 'the athlete' : a.preferred_name || a.name;
    const L = [];
    L.push(`Coaching context for ${name}. Please suggest options with reasoning, uncertainty and a conservative alternative, using ranges. Do not diagnose or prescribe rehabilitation. I will review and decide.`);
    L.push('');
    L.push(`Sport: ${a.sport}. Status: ${a.status}. Coached for: ${d.coaching?.label || 'unknown'}. Current phase: ${d.phase || 'not set'}.`);
    if (a.birthday && !anonymise) L.push(`Age: ${d.birthday?.age - 1 + (d.birthday?.inDays === 0 ? 1 : 0)}`);
    if (include.includes('goals')) L.push(`Goals: ${a.goals || 'not recorded'}`, `Training background: ${p.background || 'not recorded'}; training age: ${p.training_age_years || '?'} years.`, `Strengths/limiters: ${p.strengths || '?'} / ${p.limiters || '?'}`);
    if (include.includes('availability')) {
      const days = p.availability ? Object.entries(p.availability).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k} ${v} h`).join(', ') : '';
      L.push(`Availability: typical ${p.typical_weekly_hours || '?'} h/week, max sustainable ${p.max_weekly_hours || '?'} h/week${days ? `; by day: ${days}` : ''}. Facilities: ${['pool', 'gym', 'trainer', 'outdoor'].filter((k) => p.facilities?.[k]).join(', ') || 'not recorded'}. Constraints: ${p.constraints || 'none recorded'}.`);
    }
    if (include.includes('training')) {
      L.push('', 'Completed training, last 12 weeks (h/week; "no data" means missing, not zero):');
      for (const s of this.summaries(data, 13).slice(0, 12)) {
        const by = Object.entries(s.completedBySport).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');
        L.push(`- ${s.week}: ${s.completedHours == null ? 'no data' : s.completedHours.toFixed(1) + ' h' + (by ? ` (${by})` : '')}${s.plannedHours != null ? `, planned ${s.plannedHours.toFixed(1)} h` : ''}`);
      }
    }
    if (include.includes('races')) {
      L.push('', 'Races:');
      for (const r of data.races.filter((x) => x.date >= calc.addDays(d.today, -180))) L.push(`- ${r.date} ${r.name} (${r.priority}, ${r.distance || r.sport || ''}) ${r.status}${r.result ? ': ' + r.result : ''}${r.goal ? '; goal: ' + r.goal : ''}`);
    }
    if (include.includes('tests')) {
      L.push('', 'Tests (most recent first):');
      for (const t of data.tests.slice(0, 8)) L.push(`- ${t.date} ${t.discipline} ${t.test_type}: ${t.raw_summary || ''}${t.derived_value != null ? ` → ${t.derived_metric} ${fmtValue(t.derived_value, t.derived_unit)}` : ''}${t.accepted ? ' (accepted)' : ''}`);
    }
    if (include.includes('plan')) {
      const upcoming = data.plan.filter((w) => w.week_start >= calc.weekStart(d.today)).slice(0, 8);
      if (upcoming.length) {
        L.push('', 'Current plan, next weeks:');
        for (const w of upcoming) L.push(`- ${w.week_start}: ${w.phase || ''} ${w.hours_min ?? '?'}–${w.hours_max ?? '?'} h${w.focus ? '; ' + w.focus : ''}`);
      }
    }
    if (include.includes('health')) {
      const h = d.health;
      L.push('', `Athlete-reported health notes (do not diagnose): ${h.injuries || 'none'}; healthcare guidance: ${h.guidance || 'none'}.`);
    }
    if (include.includes('wellbeing')) {
      const recent = data.logs.slice(-4).map((l) => `${l.week_start}: ${['sleep', 'fatigue', 'soreness', 'stress', 'motivation'].filter((k) => l[k] != null).map((k) => `${k} ${l[k]}/5`).join(', ')}`).filter((x) => !x.endsWith(': '));
      if (recent.length) L.push('', 'Wellbeing scores (1–5):', ...recent.map((x) => '- ' + x));
    }
    return L.join('\n');
  }

  // ---------- import ----------
  importPreview(athleteId, { csv, preset, mapping }) {
    const { headers, records } = importer.parseCSV(csv || '');
    if (!headers.length) throw badRequest('The file is empty or not a CSV');
    const presetKey = preset || importer.detectPreset(headers);
    const map = { ...importer.PRESETS[presetKey].mapping, ...(mapping || {}) };
    const a = this.get('athletes', athleteId);
    const candidates = importer.mapRecords(records, map, { timeZone: a.timezone || this.settings().timezone });
    const existing = this.db.prepare('SELECT * FROM activities WHERE athlete_id = ? AND source_ref IS NOT NULL').all(athleteId);
    const manual = this.db.prepare("SELECT * FROM activities WHERE athlete_id = ? AND source = 'manual'").all(athleteId);
    importer.classify(candidates, new Map(existing.map((e) => [e.source_ref, e])), manual);
    const counts = {};
    for (const c of candidates) counts[c.result] = (counts[c.result] || 0) + 1;
    const missingCols = ['date', 'sport', 'duration', 'planned', 'distance', 'load', 'rpe', 'comments', 'title'].filter((k) => map[k] && !headers.includes(map[k]));
    return { headers, preset: presetKey, presets: Object.fromEntries(Object.entries(importer.PRESETS).map(([k, p]) => [k, p.label])), mapping: map, missingCols, counts, rows: candidates, total: records.length };
  }

  importCommit(athleteId, { csv, preset, mapping, filename }) {
    const prev = this.importPreview(athleteId, { csv, preset, mapping });
    if (prev.missingCols.length) throw badRequest(`Mapped columns not in file: ${prev.missingCols.join(', ')}`);
    return tx(this.db, () => {
      const imp = this.db.prepare('INSERT INTO imports(athlete_id, filename, format, rows_total) VALUES (?, ?, ?, ?)').run(athleteId, filename || null, prev.preset, prev.total);
      const importId = Number(imp.lastInsertRowid);
      let added = 0;
      let updated = 0;
      const fields = ['date', 'sport', 'title', 'status', 'duration_min', 'planned_min', 'distance_km', 'load', 'load_type', 'rpe', 'comments'];
      for (const c of prev.rows) {
        if (c.result === 'new') {
          const a = { ...c.activity, athlete_id: athleteId, source: prev.preset === 'trainingpeaks' ? 'TrainingPeaks CSV' : 'CSV', import_id: importId };
          const keys = Object.keys(a);
          this.db.prepare(`INSERT INTO activities (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => a[k]));
          added++;
        } else if (c.result === 'update') {
          this.db.prepare(`UPDATE activities SET ${fields.map((f) => f + ' = ?').join(', ')} WHERE id = ?`).run(...fields.map((f) => c.activity[f]), c.existingId);
          updated++;
        }
      }
      const invalid = prev.counts.invalid || 0;
      this.db.prepare('UPDATE imports SET rows_added = ?, rows_duplicate = ?, rows_invalid = ? WHERE id = ?').run(added, (prev.counts.unchanged || 0) + updated, invalid, importId);
      this.audit(athleteId, 'import', importId, 'create', `Imported ${filename || 'CSV'}: ${added} new, ${updated} updated, ${prev.counts.unchanged || 0} unchanged, ${invalid} invalid`);
      return { importId, added, updated, unchanged: prev.counts.unchanged || 0, invalid, errors: prev.rows.filter((r) => r.result === 'invalid').map((r) => ({ line: r.line, errors: r.errors })) };
    });
  }

  undoImport(importId) {
    const imp = this.get('imports', importId);
    const n = this.db.prepare('DELETE FROM activities WHERE import_id = ?').run(importId).changes;
    this.db.prepare('DELETE FROM imports WHERE id = ?').run(importId);
    this.audit(imp.athlete_id, 'import', importId, 'delete', `Removed import ${imp.filename || ''} (${n} activities)`);
    return { removed: n };
  }

  // ---------- calendar ----------
  calendarEvents() {
    const s = this.settings().calendar;
    const today = this.today();
    const from = calc.addDays(today, -60);
    const name = (a) => (s.names === 'none' ? 'Athlete' : s.names === 'first' ? (a.preferred_name || a.name).split(' ')[0] : initials(a.preferred_name || a.name));
    let athletes = this.athleteRows(false).filter((a) => a.status !== 'former');
    if (Array.isArray(s.athletes)) athletes = athletes.filter((a) => s.athletes.includes(a.id));
    const ev = [];
    const alarm = s.alarmMinutes === '' || s.alarmMinutes == null ? null : Number(s.alarmMinutes);
    for (const a of athletes) {
      const data = this.load(a.id);
      const n = name(a);
      if (s.categories.races) for (const r of data.races) if (r.date >= from && r.status !== 'cancelled') ev.push({ uid: `race-${r.id}@coaching-hub.local`, category: 'races', title: `${r.priority} race: ${n} – ${r.name}${r.status === 'DNS' ? ' (DNS)' : ''}`, date: r.date, description: [r.distance, r.location].filter(Boolean).join(', '), alarmMinutes: alarm });
      if (s.categories.camps || s.categories.travel) for (const r of data.races) if (s.categories.travel && r.travel && /\d{4}-\d{2}-\d{2}/.test(r.travel)) {
        const dates = r.travel.match(/\d{4}-\d{2}-\d{2}/g);
        ev.push({ uid: `travel-${r.id}@coaching-hub.local`, category: 'travel', title: `Travel: ${n} – ${r.name}`, date: dates[0], endDate: dates[1] && dates[1] >= dates[0] ? dates[1] : dates[0] });
      }
      for (const t of data.tasks) {
        if (t.done || !t.due_date || t.due_date < from) continue;
        const cat = t.kind === 'call' ? 'calls' : t.kind === 'test' ? 'tests' : t.kind === 'review' ? 'reviews' : t.kind === 'camp' ? 'camps' : t.kind === 'travel' ? 'travel' : null;
        if (!cat || !s.categories[cat]) continue;
        ev.push({ uid: `task-${t.id}@coaching-hub.local`, category: cat, title: `${cap(t.kind)}: ${n}${t.kind === 'call' ? '' : ' – ' + t.title}`, date: t.due_date, time: t.due_time || null, timeZone: t.timezone || this.settings().timezone, durationMin: 30, alarmMinutes: alarm });
      }
      if (s.categories.tests) {
        const d = this.derive(data);
        for (const [disc, w] of Object.entries(d.testWindows)) if (w.from && w.status !== 'off') ev.push({ uid: `testwindow-${a.id}-${disc}@coaching-hub.local`, category: 'tests', title: `Test window: ${n} – ${disc}`, date: w.from, endDate: w.to });
      }
      if (s.categories.reviews && a.review_days) {
        const due = a.last_review_date ? calc.addDays(a.last_review_date, a.review_days) : today;
        ev.push({ uid: `review-${a.id}@coaching-hub.local`, category: 'reviews', title: `Plan review: ${n}`, date: due < today ? today : due });
      }
      if (s.categories.birthdays && a.birthday) {
        ev.push({ uid: `birthday-${a.id}@coaching-hub.local`, category: 'birthdays', title: `Birthday: ${n}`, date: a.birthday, rrule: 'FREQ=YEARLY', private: true });
      }
    }
    return ev.sort((x, y) => (x.date < y.date ? -1 : 1));
  }

  calendarICS() {
    return ics.buildCalendar(this.calendarEvents(), { name: 'Coaching Hub' });
  }

  // ---------- attachments ----------
  saveAttachment(athleteId, filename, mime, buf) {
    if (athleteId) this.get('athletes', athleteId);
    const safe = (filename || 'file').replace(/[^\w.\- ]+/g, '_').slice(-80);
    const stored = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`;
    fs.writeFileSync(path.join(this.dataDir, 'attachments', stored), buf);
    const r = this.db.prepare('INSERT INTO attachments(athlete_id, filename, stored_name, mime, size) VALUES (?, ?, ?, ?, ?)').run(athleteId || null, safe, stored, mime || 'application/octet-stream', buf.length);
    this.audit(athleteId, 'attachment', Number(r.lastInsertRowid), 'create', `Attached ${safe}`);
    return this.get('attachments', Number(r.lastInsertRowid));
  }

  attachmentPath(id) {
    const a = this.get('attachments', id);
    return { ...a, path: path.join(this.dataDir, 'attachments', a.stored_name) };
  }

  removeAttachment(id) {
    const a = this.attachmentPath(id);
    fs.rmSync(a.path, { force: true });
    this.db.prepare('UPDATE athletes SET photo_id = NULL WHERE photo_id = ?').run(id);
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    this.audit(a.athlete_id, 'attachment', id, 'delete', `Deleted file ${a.filename}`);
    return { ok: true };
  }

  // ---------- tasks ----------
  listTasks({ status = 'open' } = {}) {
    const where = status === 'open' ? 'WHERE t.done = 0' : status === 'done' ? 'WHERE t.done = 1' : '';
    return this.db.prepare(`SELECT t.*, a.name AS athlete_name FROM tasks t LEFT JOIN athletes a ON a.id = t.athlete_id ${where} ORDER BY t.done, t.due_date IS NULL, t.due_date, t.id`).all().map((r) => ({ ...r }));
  }

  // ---------- export ----------
  exportAll() {
    const tables = ['athletes', 'races', 'tests', 'activities', 'weekly_logs', 'plan_weeks', 'plan_versions', 'proposals', 'tasks', 'notes', 'attachments', 'imports', 'audit_log', 'settings'];
    const out = { app: 'Coaching Hub', exported_at: new Date().toISOString(), note: 'Attachments are listed by name; use Backup to include the files themselves.' };
    for (const t of tables) out[t] = this.db.prepare(`SELECT * FROM ${t}`).all().map((r) => ({ ...r }));
    return out;
  }

  activitiesCSV(athleteId) {
    const rows = this.db.prepare(`SELECT a.name AS athlete, x.date, x.sport, x.title, x.status, x.duration_min, x.planned_min, x.distance_km, x.load, x.load_type, x.rpe, x.source, x.comments FROM activities x JOIN athletes a ON a.id = x.athlete_id ${athleteId ? 'WHERE x.athlete_id = ?' : ''} ORDER BY a.name, x.date`).all(...(athleteId ? [athleteId] : []));
    const cols = ['athlete', 'date', 'sport', 'title', 'status', 'duration_min', 'planned_min', 'distance_km', 'load', 'load_type', 'rpe', 'source', 'comments'];
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n') + '\n';
  }
}

function fmtValue(v, unit) {
  return unit === 's/100m' || unit === 's/km' ? `${calc.formatDuration(v)} ${unit.slice(1)}` : `${v} ${unit || ''}`.trim();
}
function pickWeek(s) {
  if (!s) return null;
  return { week: s.week, source: s.source, completedHours: s.completedHours, plannedHours: s.plannedHours, compliance: s.compliance, completedBySport: s.completedBySport };
}
function pickAthlete(a) {
  return { id: a.id, name: a.name, preferred_name: a.preferred_name, sport: a.sport, timezone: a.timezone, is_sample: a.is_sample };
}
function pickDefined(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] != null && o[k] !== '') r[k] = o[k];
  return r;
}
function initials(n) {
  return n.split(/\s+/).filter(Boolean).map((p) => p[0].toUpperCase() + '.').join('');
}
function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function notFound() {
  const e = new Error('Not found');
  e.status = 404;
  return e;
}
function badRequest(m) {
  const e = new Error(m);
  e.status = 400;
  return e;
}

module.exports = { Service, DEFAULT_SETTINGS, initials };
