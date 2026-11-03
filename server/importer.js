// CSV import: parsing, field mapping, validation, preview and dedupe keys.
const crypto = require('node:crypto');
const { parseDate, parseDuration } = require('./calc');

// RFC 4180 CSV parser (quoted fields, embedded commas, quotes and newlines).
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const delim = sniffDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], records: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const records = nonEmpty.slice(1).map((r, idx) => {
    const o = { __line: idx + 2 };
    headers.forEach((h, j) => { o[h] = (r[j] ?? '').trim(); });
    return o;
  });
  return { headers, records };
}

function sniffDelimiter(text) {
  const first = text.split('\n')[0];
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

// Known export layouts. TrainingPeaks "Export workouts" CSV column names.
const PRESETS = {
  trainingpeaks: {
    label: 'TrainingPeaks workouts export',
    detect: ['WorkoutDay', 'WorkoutType', 'TimeTotalInHours'],
    mapping: {
      date: 'WorkoutDay', dateFormat: 'YYYY-MM-DD',
      sport: 'WorkoutType', title: 'Title',
      duration: 'TimeTotalInHours', durationUnit: 'hours',
      planned: 'PlannedDuration', plannedUnit: 'hours',
      distance: 'DistanceInMeters', distanceUnit: 'm',
      load: 'TSS', loadLabel: 'TrainingPeaks TSS',
      rpe: 'Rpe', comments: 'AthleteComments',
    },
  },
  generic: {
    label: 'Other CSV (map columns yourself)',
    detect: [],
    mapping: { dateFormat: 'YYYY-MM-DD', durationUnit: 'minutes', plannedUnit: 'minutes', distanceUnit: 'km', loadLabel: 'Imported load' },
  },
};

function detectPreset(headers) {
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.detect.length && p.detect.every((h) => headers.includes(h))) return key;
  }
  return 'generic';
}

const SPORT_WORDS = {
  swim: ['swim', 'open water', 'pool'],
  bike: ['bike', 'cycling', 'ride', 'mtb', 'mtn bike', 'virtual ride', 'cyclo'],
  run: ['run', 'trail', 'treadmill', 'jog'],
  strength: ['strength', 'gym', 'weights', 'weight training'],
};

function normaliseSport(v) {
  const s = String(v || '').toLowerCase().trim();
  if (!s) return null;
  if (s === 'day off') return 'dayoff';
  for (const [sport, words] of Object.entries(SPORT_WORDS)) if (words.some((w) => s.includes(w))) return sport;
  return 'other';
}

function toISODate(v, format, timeZone) {
  v = String(v || '').trim();
  if (!v) return null;
  // Full timestamps with an offset are converted to the athlete's local date.
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && /(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  const datePart = v.split(/[ T]/)[0];
  let y, m, d;
  if (format === 'DD/MM/YYYY' || format === 'MM/DD/YYYY') {
    const p = datePart.split(/[/.-]/);
    if (p.length !== 3) return null;
    [d, m, y] = format === 'DD/MM/YYYY' ? p : [p[1], p[0], p[2]];
  } else {
    [y, m, d] = datePart.split('-');
  }
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return parseDate(s) ? s : null;
}

function toMinutes(v, unit) {
  if (v == null || String(v).trim() === '') return null;
  if (String(v).includes(':')) { const s = parseDuration(v); return s == null ? NaN : s / 60; }
  const n = Number(String(v).replace(',', '.'));
  if (Number.isNaN(n)) return NaN;
  return unit === 'hours' ? n * 60 : unit === 'seconds' ? n / 60 : n;
}

function toKm(v, unit) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (Number.isNaN(n)) return NaN;
  return unit === 'm' ? n / 1000 : unit === 'mi' ? n * 1.609344 : n;
}

function num(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isNaN(n) ? NaN : n;
}

// Turn CSV records into candidate activities, with errors and warnings per row.
function mapRecords(records, mapping, { timeZone } = {}) {
  const out = [];
  const seen = new Map();
  for (const r of records) {
    const errors = [];
    const warnings = [];
    const date = toISODate(r[mapping.date], mapping.dateFormat, timeZone);
    if (!date) errors.push(`Date "${r[mapping.date] ?? ''}" is not a valid ${mapping.dateFormat} date`);
    const sport = mapping.sport ? normaliseSport(r[mapping.sport]) : mapping.fixedSport || null;
    if (!sport) errors.push('No sport');
    if (sport === 'dayoff') { out.push({ line: r.__line, skip: 'Day off entry', errors: [], warnings: [] }); continue; }
    const duration = mapping.duration ? toMinutes(r[mapping.duration], mapping.durationUnit) : null;
    const planned = mapping.planned ? toMinutes(r[mapping.planned], mapping.plannedUnit) : null;
    const distance = mapping.distance ? toKm(r[mapping.distance], mapping.distanceUnit) : null;
    const load = mapping.load ? num(r[mapping.load]) : null;
    const rpe = mapping.rpe ? num(r[mapping.rpe]) : null;
    for (const [k, v] of Object.entries({ duration, planned, distance, load, rpe })) if (Number.isNaN(v)) errors.push(`${k} is not a number`);
    if (duration != null && (duration < 0 || duration > 24 * 60)) errors.push('Duration outside 0–24 h');
    if (rpe != null && !Number.isNaN(rpe) && (rpe < 0 || rpe > 10)) warnings.push('RPE outside 0–10, ignored');
    if (duration == null && planned == null) errors.push('No completed or planned duration');
    const title = mapping.title ? r[mapping.title] || null : null;
    let status = 'completed';
    if (!duration && planned) status = 'planned';
    // Identity of a row across re-exports: the same date, sport and title,
    // plus its position among identical rows. Values are not part of the key,
    // so a later export with updated numbers updates the row instead of duplicating it.
    const base = `${date}|${sport}|${(title || '').toLowerCase()}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const sourceRef = 'csv:' + crypto.createHash('sha1').update(`${base}|${n}`).digest('hex').slice(0, 16);
    out.push({
      line: r.__line,
      errors,
      warnings,
      activity: errors.length ? null : {
        date, sport, title, status,
        duration_min: duration == null ? null : Math.round(duration * 10) / 10,
        planned_min: planned == null ? null : Math.round(planned * 10) / 10,
        distance_km: distance == null ? null : Math.round(distance * 1000) / 1000,
        load: load == null ? null : load,
        load_type: load == null ? null : `${mapping.loadLabel || 'Imported load'} (${sport})`,
        rpe: rpe == null || rpe < 0 || rpe > 10 ? null : rpe,
        comments: mapping.comments ? r[mapping.comments] || null : null,
        source_ref: sourceRef,
      },
    });
  }
  return out;
}

// Compare candidates with stored rows: new, update, unchanged, possible manual duplicate.
function classify(candidates, existingByRef, manualActivities) {
  const fields = ['date', 'sport', 'title', 'status', 'duration_min', 'planned_min', 'distance_km', 'load', 'rpe', 'comments'];
  for (const c of candidates) {
    if (!c.activity) { c.result = c.skip ? 'skipped' : 'invalid'; continue; }
    const ex = existingByRef.get(c.activity.source_ref);
    if (!ex) {
      c.result = 'new';
      const near = manualActivities.find((m) => m.date === c.activity.date && m.sport === c.activity.sport && Math.abs((m.duration_min || 0) - (c.activity.duration_min || 0)) <= 10);
      if (near) c.warnings.push(`Similar manual entry already on ${near.date} (${near.sport}, ${near.duration_min} min). Check it is not the same session.`);
    } else {
      const changed = fields.filter((f) => String(ex[f] ?? '') !== String(c.activity[f] ?? ''));
      c.result = changed.length ? 'update' : 'unchanged';
      c.changed = changed;
      c.existingId = ex.id;
    }
  }
  return candidates;
}

module.exports = { parseCSV, PRESETS, detectPreset, mapRecords, classify, normaliseSport, toISODate };
