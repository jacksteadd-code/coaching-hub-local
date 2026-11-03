'use strict';
// Athlete update files (*.chathlete). A JSON file that adds to one athlete's
// page without touching anyone else: profile and health fields, races, tests,
// notes and, optionally, a TrainingPeaks workouts CSV. Saved into the import
// folder, it is matched to the athlete by file name like a workouts export.
//
// Nothing is ever cleared or overwritten. A field is only filled in when it is
// empty, except the name, which may be extended ("Sam" -> "Sam Taylor").
// Races, tests and notes already on the page are skipped, so applying the
// same file twice changes nothing.
//
// {
//   "format": "coaching-hub-athlete", "version": 1,
//   "athlete": { "name", "start_date", "goals", ..., "profile": {...}, "health": {...} },
//   "races": [{ "name", "date", ... }], "tests": [{ "discipline", "test_type", "date", ... }],
//   "notes": [{ "date", "kind", "body" }], "workouts_csv": "..."
// }

const { tx } = require('./db');

const FORMAT = 'coaching-hub-athlete';
const TOP = ['name', 'preferred_name', 'sport', 'start_date', 'birthday', 'timezone', 'email', 'phone', 'goals', 'phase', 'checkin_days', 'review_days'];

const empty = (v) => v == null || v === '' || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function parse(text) {
  let p;
  try { p = JSON.parse(String(text).replace(/^﻿/, '')); } catch { throw new Error('the file is not valid athlete update JSON'); }
  if (!p || p.format !== FORMAT) throw new Error('this is not a Coaching Hub athlete update file');
  if (p.version > 1) throw new Error('this file was made for a newer version of the app. Update the app first.');
  return p;
}

// Fill empty keys of cur from add, recursing into plain objects.
// Returns the merged object and the list of keys that changed.
function fill(cur, add, prefix = '') {
  const out = { ...(cur || {}) };
  const changed = [];
  for (const [k, v] of Object.entries(add || {})) {
    if (empty(v)) continue;
    if (typeof v === 'object' && !Array.isArray(v) && (out[k] == null || typeof out[k] === 'object')) {
      const r = fill(out[k], v, `${prefix}${k}.`);
      out[k] = r.out;
      changed.push(...r.changed);
    } else if (empty(out[k])) {
      out[k] = v;
      changed.push(prefix + k);
    }
  }
  return { out, changed };
}

// Apply everything except the workouts CSV (the caller imports that, because
// the CSV import runs its own transaction).
function apply(svc, athleteId, p) {
  return tx(svc.db, () => {
    const a = svc.get('athletes', athleteId);
    const src = p.athlete || {};
    const patch = {};
    const changed = [];
    for (const f of TOP) {
      const v = src[f];
      if (empty(v)) continue;
      if (f === 'name') {
        const have = words(a.name);
        const next = words(v);
        if (norm(v) !== norm(a.name) && have.every((w) => next.includes(w))) { patch.name = v; changed.push('name'); }
        continue;
      }
      if (empty(a[f])) { patch[f] = v; changed.push(f); }
    }
    const prof = fill(JSON.parse(a.profile_json || '{}'), src.profile);
    const health = fill(JSON.parse(a.health_json || '{}'), src.health);
    if (prof.changed.length) patch.profile_json = prof.out;
    if (health.changed.length) patch.health_json = health.out;
    changed.push(...prof.changed.map((k) => 'profile.' + k), ...health.changed.map((k) => 'health.' + k));
    if (Object.keys(patch).length) svc.update('athletes', athleteId, patch);

    const res = { fields: changed.length, races: 0, tests: 0, notes: 0, skipped: 0 };
    const races = svc.db.prepare('SELECT name, date FROM races WHERE athlete_id = ?').all(athleteId);
    for (const r of p.races || []) {
      if (races.some((x) => x.date === r.date && norm(x.name) === norm(r.name))) { res.skipped++; continue; }
      svc.insert('races', { ...r, athlete_id: athleteId });
      races.push(r);
      res.races++;
    }
    const tests = svc.db.prepare('SELECT discipline, test_type, date FROM tests WHERE athlete_id = ?').all(athleteId);
    for (const t of p.tests || []) {
      if (tests.some((x) => x.date === t.date && x.discipline === t.discipline && norm(x.test_type) === norm(t.test_type))) { res.skipped++; continue; }
      svc.addTest({ ...t, athlete_id: athleteId });
      tests.push(t);
      res.tests++;
    }
    const notes = svc.db.prepare('SELECT date, body FROM notes WHERE athlete_id = ?').all(athleteId);
    for (const n of p.notes || []) {
      const date = n.date || svc.today();
      if (notes.some((x) => x.date === date && norm(x.body) === norm(n.body))) { res.skipped++; continue; }
      svc.insert('notes', { ...n, date, athlete_id: athleteId });
      notes.push({ date, body: n.body });
      res.notes++;
    }
    return res;
  });
}

function summary(r, w) {
  const parts = [`${r.fields} profile field${r.fields === 1 ? '' : 's'} filled in`, `${r.races} race${r.races === 1 ? '' : 's'}`, `${r.tests} test${r.tests === 1 ? '' : 's'}`, `${r.notes} note${r.notes === 1 ? '' : 's'} added`];
  if (r.skipped) parts.push(`${r.skipped} already there`);
  if (w) parts.push(`workouts: ${w.added} new, ${w.updated} updated, ${w.unchanged} already in`);
  return parts.join(', ');
}

module.exports = { FORMAT, parse, fill, apply, summary };
