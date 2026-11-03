// Pure, deterministic calculations. No database or network access here so
// every function can be unit tested on its own. The browser loads this same
// file (served at /calc.js) so previews match what the server stores.

const DAY_MS = 86400000;

// ---- Dates (all dates are plain 'YYYY-MM-DD' strings, treated as calendar days) ----

function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t;
}

function fmtDate(t) {
  return new Date(t).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fmtDate(parseDate(s) + n * DAY_MS);
}

function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
}

// Monday of the week containing the date.
function weekStart(s) {
  const t = parseDate(s);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return fmtDate(t - dow * DAY_MS);
}

function todayIn(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts;
}

// Years, months and days between two dates, counted the way people do
// ("1 year 3 months"), e.g. coaching duration.
function durationParts(from, to) {
  if (!parseDate(from) || !parseDate(to) || from > to) return null;
  let [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  let months = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) months -= 1;
  const anchor = new Date(Date.UTC(y1, m1 - 1 + months, 1));
  const dim = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
  const anchorDay = fmtDate(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), Math.min(d1, dim)));
  return { years: Math.floor(months / 12), months: months % 12, days: daysBetween(anchorDay, to), totalDays: daysBetween(from, to) };
}

function coachingDuration(startDate, today) {
  const p = durationParts(startDate, today);
  if (!p) return null;
  const bits = [];
  if (p.years) bits.push(`${p.years} yr`);
  if (p.months) bits.push(`${p.months} mo`);
  if (!p.years && !p.months) bits.push(`${p.days} day${p.days === 1 ? '' : 's'}`);
  return { ...p, label: bits.join(' ') };
}

function raceCountdown(raceDate, today) {
  const days = daysBetween(today, raceDate);
  if (Number.isNaN(days)) return null;
  const weeks = days / 7;
  let label;
  if (days < 0) label = `${-days} days ago`;
  else if (days === 0) label = 'Race day';
  else if (days < 14) label = `${days} day${days === 1 ? '' : 's'}`;
  else label = `${Math.floor(weeks)} wk ${days % 7} d`;
  return { days, weeks: Math.floor(weeks), label };
}

function nextBirthday(birthday, today) {
  if (!parseDate(birthday)) return null;
  const [, m, d] = birthday.split('-').map(Number);
  const y = Number(today.slice(0, 4));
  for (const yy of [y, y + 1]) {
    // 29 Feb birthdays fall on 28 Feb in non-leap years
    const dim = new Date(Date.UTC(yy, m, 0)).getUTCDate();
    const s = `${yy}-${String(m).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
    if (s >= today) return { date: s, inDays: daysBetween(today, s), age: yy - Number(birthday.slice(0, 4)) };
  }
  return null;
}

// ---- Units ----

const UNITS = {
  km: { mi: 0.621371192, m: 1000 },
  mi: { km: 1.609344 },
  m: { km: 0.001, yd: 1.0936133 },
  yd: { m: 0.9144 },
  kg: { lb: 2.20462262 },
  lb: { kg: 0.45359237 },
};

function convert(value, from, to) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return null;
  if (from === to) return Number(value);
  const f = UNITS[from] && UNITS[from][to];
  if (!f) throw new Error(`No conversion from ${from} to ${to}`);
  return Number(value) * f;
}

// Pace helpers. Seconds are the storage unit for all paces.
function parseDuration(s) {
  // Accepts 'h:mm:ss', 'mm:ss' or plain seconds
  if (s == null || s === '') return null;
  if (typeof s === 'number') return s;
  const parts = String(s).trim().split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function formatDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function pacePerKmToPerMile(secPerKm) {
  return secPerKm * 1.609344;
}

function per100mToPer100yd(secPer100m) {
  return secPer100m * 0.9144;
}

// ---- Test derivations (method is returned with the value so it is always shown) ----

function deriveFromTest(type, raw) {
  switch (type) {
    case 'ftp_20min': {
      const w = Number(raw.avgPower);
      if (!w) return null;
      return { value: Math.round(w * 0.95), unit: 'W', metric: 'FTP', method: '95% of 20-minute average power (Allen & Coggan convention). Estimate only.' };
    }
    case 'ftp_ramp': {
      const w = Number(raw.bestMinutePower);
      if (!w) return null;
      return { value: Math.round(w * 0.75), unit: 'W', metric: 'FTP', method: '75% of best 1-minute power in a ramp test. Estimate only; varies between athletes.' };
    }
    case 'css': {
      const t400 = parseDuration(raw.t400);
      const t200 = parseDuration(raw.t200);
      if (!t400 || !t200 || t400 <= t200) return null;
      const per100 = (t400 - t200) / 2;
      return { value: Math.round(per100 * 10) / 10, unit: 's/100m', metric: 'CSS', display: formatDuration(per100) + ' /100m', method: 'Critical swim speed = (T400 − T200) / 2 per 100 m.' };
    }
    case 'run_tt': {
      const sec = parseDuration(raw.time);
      const km = Number(raw.distanceKm);
      if (!sec || !km) return null;
      const pace = sec / km;
      return { value: Math.round(pace), unit: 's/km', metric: 'Time-trial pace', display: formatDuration(pace) + ' /km', method: `Average pace over ${km} km. Threshold pace is not derived automatically; set it yourself if you accept this as threshold.` };
    }
    case 'lthr_run_30min': {
      const hr = Number(raw.last20AvgHr);
      if (!hr) return null;
      return { value: Math.round(hr), unit: 'bpm', metric: 'Run LTHR', method: 'Average heart rate over the final 20 minutes of a 30-minute solo effort (Friel field test).' };
    }
    default:
      return null;
  }
}

// Thresholds that applied on a given date: the most recent accepted value
// whose effective date is on or before that date. Old sessions are therefore
// never reinterpreted with today's thresholds.
function thresholdOn(tests, metric, date) {
  const candidates = tests
    .filter((t) => t.accepted && t.derived_metric === metric && (t.effective_from || t.date) <= date)
    .sort((a, b) => ((a.effective_from || a.date) < (b.effective_from || b.date) ? 1 : -1));
  return candidates[0] || null;
}

// Coggan-style power zones from an FTP value, labelled as a convention.
function powerZones(ftp) {
  const bands = [['Z1 Recovery', 0, 0.55], ['Z2 Endurance', 0.56, 0.75], ['Z3 Tempo', 0.76, 0.9], ['Z4 Threshold', 0.91, 1.05], ['Z5 VO2max', 1.06, 1.2], ['Z6 Anaerobic', 1.21, null]];
  return bands.map(([name, lo, hi]) => ({ name, low: Math.round(ftp * lo), high: hi == null ? null : Math.round(ftp * hi) }));
}

// ---- Weekly training ----

const SPORTS = ['swim', 'bike', 'run', 'strength', 'other'];

// Combine activities and a manual weekly log into one week summary.
// Activity data wins over manual totals for completed volume. A sport with
// no data is null (missing), never 0.
function summariseWeek(week, activities, log) {
  const completed = {};
  const distance = {};
  const loads = {};
  let sessionsDone = 0;
  let longest = 0;
  let rpeLoad = 0;
  let rpeKnown = 0;
  let source = 'missing';
  const acts = activities.filter((a) => weekStart(a.date) === week && a.status !== 'planned');
  if (acts.length) {
    source = acts.every((a) => a.source === 'manual') ? 'manual' : 'imported';
    for (const a of acts) {
      if (a.status === 'missed') continue;
      const s = SPORTS.includes(a.sport) ? a.sport : 'other';
      const hrs = (a.duration_min || 0) / 60;
      completed[s] = (completed[s] || 0) + hrs;
      if (a.distance_km != null) distance[s] = (distance[s] || 0) + a.distance_km;
      if (a.load != null && a.load_type) {
        const key = a.load_type;
        loads[key] = (loads[key] || 0) + a.load;
      }
      if (a.rpe != null && a.duration_min) {
        rpeLoad += a.rpe * a.duration_min;
        rpeKnown += 1;
      }
      longest = Math.max(longest, a.duration_min || 0);
      sessionsDone += 1;
    }
  } else if (log && log.completed_json) {
    const manual = JSON.parse(log.completed_json);
    const keys = Object.keys(manual).filter((k) => manual[k] !== null && manual[k] !== '');
    if (keys.length) {
      source = 'weekly summary';
      for (const k of keys) completed[k] = Number(manual[k]);
    }
  }
  if (log && log.sessions_done != null && !acts.length) sessionsDone = log.sessions_done;
  let planned = log && log.planned_json ? JSON.parse(log.planned_json) : null;
  let plannedSource = planned ? 'weekly plan entry' : null;
  if (!planned) {
    const withPlan = activities.filter((a) => weekStart(a.date) === week && a.planned_min != null);
    if (withPlan.length) {
      planned = {};
      for (const a of withPlan) {
        const s = SPORTS.includes(a.sport) ? a.sport : 'other';
        planned[s] = (planned[s] || 0) + a.planned_min / 60;
      }
      plannedSource = 'planned workouts (import)';
    }
  }
  const plannedTotal = planned ? Object.values(planned).reduce((a, b) => a + (Number(b) || 0), 0) : null;
  const total = source === 'missing' ? null : Object.values(completed).reduce((a, b) => a + b, 0);
  if (rpeKnown) loads['Session RPE (RPE × min)'] = rpeLoad;
  return {
    week,
    source,
    completedBySport: completed,
    completedHours: total,
    plannedBySport: planned,
    plannedHours: plannedTotal,
    plannedSource,
    plannedSessions: log && log.sessions_planned != null ? log.sessions_planned : (plannedSource === 'planned workouts (import)' ? activities.filter((a) => weekStart(a.date) === week && a.planned_min != null).length : null),
    missedSessions: acts.filter((a) => a.status === 'missed').length,
    sessionsDone: source === 'missing' ? null : sessionsDone,
    longestMin: acts.length ? longest : null,
    distanceBySport: distance,
    loads,
    compliance: total != null && plannedTotal ? total / plannedTotal : null,
    wellbeing: log ? pick(log, ['sleep', 'fatigue', 'soreness', 'stress', 'motivation']) : {},
  };
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] != null) r[k] = o[k];
  return r;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Baseline from the athlete's own weeks that have data. Missing weeks are
// excluded, not treated as zero.
function baseline(summaries, n) {
  const withData = summaries.filter((s) => s.completedHours != null).slice(-n);
  return { hours: median(withData.map((s) => s.completedHours)), weeksUsed: withData.length, weeksRequested: n, weeks: withData.map((s) => s.week) };
}

// ---- Race scheduling checks (explanations, not blanket rules) ----

function raceConflicts(races, recoveryGuideDays = { A: 21, B: 10, C: 5 }) {
  const out = [];
  const sorted = races.filter((r) => r.status !== 'cancelled').sort((a, b) => (a.date < b.date ? -1 : 1));
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const gap = daysBetween(a.date, b.date);
    const guide = recoveryGuideDays[a.priority] || 7;
    if (gap === 0) out.push({ races: [a.id, b.id], severity: 'high', message: `${a.name} and ${b.name} are on the same day.` });
    else if (gap < guide && (a.priority === 'A' || b.priority === 'A')) {
      out.push({ races: [a.id, b.id], severity: 'medium', message: `${gap} day${gap === 1 ? '' : 's'} between ${a.name} (${a.priority}) and ${b.name} (${b.priority}). Your recovery guide after ${a.priority === 'A' ? 'an' : 'a'} ${a.priority} race is ${guide} days. Check this is intended, for example if one is a training race.` });
    }
  }
  return out;
}

// ---- Recommendations ----

// Weekly-hours recommendation for upcoming weeks. Returns either an
// explicit "insufficient data" result or a proposal with all inputs listed.
function recommendWeeklyHours({ summaries, profile, rules, upcomingRaces, healthFlags, today, weeksAhead = 4 }) {
  const minWeeks = rules.minWeeksForBaseline || 4;
  const recent = summaries.filter((s) => s.week >= addDays(weekStart(today), -56) && s.week < weekStart(today));
  const base = baseline(recent, 8);
  const missing = [];
  if (base.weeksUsed < minWeeks) missing.push(`Completed training for at least ${minWeeks} of the last 8 weeks (have ${base.weeksUsed}).`);
  const maxAvail = Number(profile.max_weekly_hours) || null;
  const typical = Number(profile.typical_weekly_hours) || null;
  if (!maxAvail && !typical) missing.push('Typical or maximum sustainable weekly hours in the athlete profile.');
  if (base.weeksUsed < minWeeks) {
    return { kind: 'insufficient', title: 'Not enough data to recommend weekly hours', missing, dataUsed: base.weeks.map((w) => `Week of ${w}`) };
  }
  const longer = baseline(summaries.filter((s) => s.week < weekStart(today)), 26);
  const progression = (rules.maxWeeklyProgressionPct ?? 10) / 100;
  const cap = maxAvail || typical * 1.15;
  const lo = Math.min(base.hours, cap);
  const hiRaw = base.hours * (1 + progression);
  const hi = cap ? Math.min(hiRaw, cap) : hiRaw;
  const reasons = [
    `Recent baseline: median ${base.hours.toFixed(1)} h/week across ${base.weeksUsed} weeks with data (${base.weeks[0]} to ${base.weeks[base.weeks.length - 1]}). Missing weeks are excluded, not counted as zero.`,
    `Coach rule: upper end limited to +${Math.round(progression * 100)}% of baseline (Settings → Coaching rules).`,
  ];
  if (longer.hours != null) reasons.push(`Longer-term (up to 26 weeks) median: ${longer.hours.toFixed(1)} h/week over ${longer.weeksUsed} weeks.`);
  if (cap) reasons.push(`Availability: ${maxAvail ? `max sustainable ${maxAvail} h` : `typical ${typical} h (max not recorded, so capped at typical +15%)`}.`);
  const uncertainty = [...missing];
  if (base.weeksUsed < 6) uncertainty.push('Baseline uses fewer than 6 weeks, so it may not represent normal training.');
  const flags = [];
  if (healthFlags.length) flags.push(...healthFlags.map((h) => `Athlete-reported: ${h}. Review before increasing load.`));
  const nextRace = upcomingRaces.find((r) => r.date >= today);
  if (nextRace) {
    const d = daysBetween(today, nextRace.date);
    reasons.push(`Next race: ${nextRace.name} (${nextRace.priority}) on ${nextRace.date}, ${Math.floor(d / 7)} weeks away.`);
    if (d <= 21) uncertainty.push('Race within 3 weeks: taper and race-week structure are your call; this range does not model a taper.');
  }
  const conservative = { lo: Math.round(lo * 0.9 * 2) / 2, hi: Math.round(lo * 2) / 2 };
  const weeks = [];
  for (let i = 1; i <= weeksAhead; i++) weeks.push(addDays(weekStart(today), 7 * i));
  return {
    kind: 'proposal',
    title: `Weekly hours ${round1(lo)}–${round1(hi)} h for the next ${weeksAhead} weeks`,
    action: { hours_min: round1(lo), hours_max: round1(hi), weeks },
    conservative: { ...conservative, note: 'Hold at or slightly below recent baseline' + (flags.length ? ' while athlete-reported issues are reviewed.' : '.') },
    dataUsed: base.weeks.map((w) => `Week of ${w}: ${recent.find((s) => s.week === w).completedHours.toFixed(1)} h (${recent.find((s) => s.week === w).source})`),
    reasoning: reasons,
    uncertainty,
    flags,
    basis: 'Deterministic calculation + coach-defined rule. Not AI-generated.',
  };
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

// Effect of a proposed plan change: rows that differ between current and proposed.
function diffPlanWeeks(current, proposed) {
  const byWeek = new Map(current.map((w) => [w.week_start, w]));
  const fields = ['phase', 'hours_min', 'hours_max', 'focus', 'intensity', 'key_sessions', 'recovery', 'milestone', 'rationale'];
  const changes = [];
  for (const p of proposed) {
    const c = byWeek.get(p.week_start) || {};
    const fieldChanges = fields.filter((f) => p[f] !== undefined && String(p[f] ?? '') !== String(c[f] ?? '')).map((f) => ({ field: f, from: c[f] ?? null, to: p[f] }));
    if (fieldChanges.length) changes.push({ week_start: p.week_start, isNew: !byWeek.has(p.week_start), fields: fieldChanges });
  }
  return changes;
}

// Shift a block of plan weeks (and optionally a race) by n weeks. Returns
// the proposed weeks; nothing is saved here.
function shiftWeeks(weeks, fromWeek, toWeek, n) {
  const shifted = [];
  for (const w of weeks) {
    if (w.week_start >= fromWeek && w.week_start <= toWeek) shifted.push({ ...w, week_start: addDays(w.week_start, 7 * n) });
  }
  return shifted;
}

const api = {
  parseDate, fmtDate, addDays, daysBetween, weekStart, todayIn, durationParts, coachingDuration, raceCountdown, nextBirthday,
  convert, parseDuration, formatDuration, pacePerKmToPerMile, per100mToPer100yd,
  deriveFromTest, thresholdOn, powerZones,
  SPORTS, summariseWeek, baseline, median, raceConflicts, recommendWeeklyHours, diffPlanWeeks, shiftWeeks,
};

if (typeof module !== 'undefined') module.exports = api;
else globalThis.calc = api;
