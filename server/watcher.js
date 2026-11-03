'use strict';
// Automatic import folder. Any .csv or .zip saved into the folder (for example
// a TrainingPeaks workouts export) is imported into the athlete whose name is
// in the file name, then moved into "Imported". Files that can't be matched or
// read are moved into "Needs attention" and listed in the app. A .chathlete
// file (see athletefile.js) adds profile details, races, tests and notes.
//
// The folder lives directly in the home folder, not in Documents, Desktop or
// Downloads: macOS blocks background programs from those folders unless they
// are given permission, which would make the import silently do nothing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const importer = require('./importer');
const athletefile = require('./athletefile');

const DONE = 'Imported';
const FAILED = 'Needs attention';
const SETTLE_MS = 5000; // ignore files that are still being written
const zlib = require('node:zlib');
const FILE_RE = /\.(csv|zip|chathlete)$/i;

function defaultFolder(home = os.homedir()) {
  return path.join(home, 'Coaching Hub Imports');
}

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// Small spelling differences are allowed (TrainingPeaks may spell a name
// slightly differently): one letter off for names of 5+ letters, two for 9+.
function close(a, b) {
  if (a === b) return 2;
  const n = Math.min(a.length, b.length);
  const max = n >= 9 ? 2 : n >= 5 ? 1 : 0;
  if (!max || Math.abs(a.length - b.length) > max) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= max ? 1 : 0;
}

// Words in the file name, plus each pair of neighbours joined ("o connor" ->
// "oconnor"), so names typed with or without a space or apostrophe match.
function fileWords(filename) {
  const w = words(path.basename(filename, path.extname(filename)));
  const out = new Set(w);
  for (let i = 0; i < w.length - 1; i++) out.add(w[i] + w[i + 1]);
  return [...out];
}

// How well one name matches: every word must match, exactly (2) or nearly (1).
function nameScore(nameWords, fw) {
  let total = 0;
  for (const x of nameWords) {
    const best = Math.max(0, ...fw.map((y) => close(x, y)));
    if (!best) return 0;
    total += best;
  }
  return total;
}

// Pick the athlete whose name best matches the file name. A full-name match
// beats a first-name-only match, and exact letters beat near misses. A tie is
// ambiguous.
function matchAthlete(filename, athletes) {
  const fw = fileWords(filename);
  let best = [];
  let bestScore = 0;
  for (const a of athletes) {
    let score = 0;
    for (const n of [a.name, a.preferred_name]) {
      const w = words(n);
      if (!w.length) continue;
      const full = nameScore(w, fw);
      if (full) score = Math.max(score, 100 + w.length * 10 + full);
      else if (w.length > 1 && fw.includes(w[0])) score = Math.max(score, 1); // first name only
    }
    if (score > bestScore) { best = [a]; bestScore = score; } else if (score && score === bestScore && !best.includes(a)) best.push(a);
  }
  if (best.length === 1) return { athlete: best[0] };
  if (best.length > 1) return { error: `The file name matches more than one athlete (${best.map((a) => a.name).join(', ')}). Add the surname to the file name.` };
  return { error: 'No athlete name found in the file name. Rename it to include the athlete\'s name, for example "Kieran Masters workouts.csv".' };
}

// Read the CSV files inside a .zip (TrainingPeaks exports come zipped).
function zipCsvs(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a valid zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip file');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.csv$/i.test(name) || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.push({ name, text: data.toString('utf8') });
    else if (method === 8) out.push({ name, text: zlib.inflateRawSync(data).toString('utf8') });
  }
  return out;
}

// The workouts CSV from a file: the file itself, or the best CSV in a zip
// (a TrainingPeaks zip can also hold a metrics file).
function readWorkoutsCsv(file) {
  if (!/\.zip$/i.test(file)) return fs.readFileSync(file, 'utf8');
  const csvs = zipCsvs(fs.readFileSync(file));
  if (!csvs.length) throw new Error('the zip has no CSV file in it');
  const tp = csvs.find((c) => importer.detectPreset(importer.parseCSV(c.text).headers) === 'trainingpeaks');
  return (tp || csvs.find((c) => /workout/i.test(c.name)) || csvs[0]).text;
}

// Exports don't always include every column (comments, RPE...). Leave out the
// optional ones that are missing rather than refusing the whole file.
const REQUIRED = ['date', 'sport'];
function optionalColumns(csv) {
  const { headers } = importer.parseCSV(csv);
  const preset = importer.PRESETS[importer.detectPreset(headers)];
  const out = {};
  for (const [k, v] of Object.entries(preset.mapping)) {
    if (typeof v === 'string' && /^[a-z]+$/.test(k) && !k.endsWith('Unit') && !k.endsWith('Format') && !k.endsWith('Label') && !REQUIRED.includes(k) && !headers.includes(v)) out[k] = '';
  }
  return out;
}

function moveTo(folder, sub, file) {
  const dir = path.join(folder, sub);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const target = path.join(dir, `${stamp} ${path.basename(file)}`);
  fs.renameSync(file, target);
  return target;
}

// Process every settled .csv, .zip and .chathlete file in the folder. Returns the log entries written.
function processFolder(svc, folder, { now = Date.now() } = {}) {
  fs.mkdirSync(folder, { recursive: true });
  const files = fs.readdirSync(folder).filter((f) => FILE_RE.test(f) && !f.startsWith('.'));
  const entries = [];
  if (!files.length) return entries;
  const athletes = svc.athleteRows(false).filter((a) => a.status !== 'former');
  for (const f of files) {
    const file = path.join(folder, f);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile() || now - st.mtimeMs < SETTLE_MS) continue;
    const entry = { at: new Date(now).toISOString(), file: f };
    const m = matchAthlete(f, athletes);
    if (m.error) {
      entry.ok = false;
      entry.message = m.error;
    } else {
      entry.athlete = m.athlete.name;
      entry.athlete_id = m.athlete.id;
      try {
        if (/\.chathlete$/i.test(f)) {
          const p = athletefile.parse(fs.readFileSync(file, 'utf8'));
          const r = athletefile.apply(svc, m.athlete.id, p);
          let w = null;
          if (p.workouts_csv) {
            w = svc.importCommit(m.athlete.id, { csv: p.workouts_csv, filename: f, mapping: optionalColumns(p.workouts_csv) });
            entry.import_id = w.importId;
          }
          entry.ok = true;
          entry.athlete = svc.get('athletes', m.athlete.id).name;
          entry.message = `Athlete update: ${athletefile.summary(r, w)}`;
          try { moveTo(folder, DONE, file); } catch (e) { entry.message += ` (couldn't move the file: ${e.message})`; }
          entries.push(entry);
          continue;
        }
        const csv = readWorkoutsCsv(file);
        const r = svc.importCommit(m.athlete.id, { csv, filename: f, mapping: optionalColumns(csv) });
        entry.ok = true;
        entry.message = `${r.added} new, ${r.updated} updated, ${r.unchanged} already in, ${r.invalid} skipped`;
        entry.import_id = r.importId;
      } catch (e) {
        entry.ok = false;
        entry.message = `Couldn't read the file: ${e.message}`;
      }
    }
    try { moveTo(folder, entry.ok ? DONE : FAILED, file); } catch (e) { entry.message += ` (couldn't move the file: ${e.message})`; }
    entries.push(entry);
  }
  return entries;
}

module.exports = { DONE, FAILED, FILE_RE, defaultFolder, matchAthlete, processFolder, words, zipCsvs, readWorkoutsCsv };
