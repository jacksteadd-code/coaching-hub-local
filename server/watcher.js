'use strict';
// Automatic import folder. Any .csv saved into the folder (for example a
// TrainingPeaks workouts export) is imported into the athlete whose name is in
// the file name, then moved into "Imported". Files that can't be matched or
// read are moved into "Needs attention" and listed in the app.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const importer = require('./importer');

const DONE = 'Imported';
const FAILED = 'Needs attention';
const SETTLE_MS = 5000; // ignore files that are still being written

function defaultFolder(home = os.homedir()) {
  return path.join(home, 'Documents', 'Coaching Hub Imports');
}

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// Pick the athlete whose name best matches the file name. Every word of the
// name must appear (or, failing that, the first name); the most specific wins.
// A tie is ambiguous.
function matchAthlete(filename, athletes) {
  const fw = new Set(words(path.basename(filename, path.extname(filename))));
  let best = [];
  let bestScore = 0;
  for (const a of athletes) {
    let score = 0;
    for (const n of [a.name, a.preferred_name]) {
      const w = words(n);
      if (w.length && w.every((x) => fw.has(x))) score = Math.max(score, 10 + w.length);
      else if (w.length && fw.has(w[0])) score = Math.max(score, 1); // first name only
    }
    if (score > bestScore) { best = [a]; bestScore = score; } else if (score && score === bestScore && !best.includes(a)) best.push(a);
  }
  if (best.length === 1) return { athlete: best[0] };
  if (best.length > 1) return { error: `The file name matches more than one athlete (${best.map((a) => a.name).join(', ')}). Add the surname to the file name.` };
  return { error: 'No athlete name found in the file name. Rename it to include the athlete\'s name, for example "Kieran Masters workouts.csv".' };
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

// Process every settled .csv in the folder. Returns the log entries written.
function processFolder(svc, folder, { now = Date.now() } = {}) {
  fs.mkdirSync(folder, { recursive: true });
  const files = fs.readdirSync(folder).filter((f) => /\.csv$/i.test(f) && !f.startsWith('.'));
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
        const csv = fs.readFileSync(file, 'utf8');
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

module.exports = { DONE, FAILED, defaultFolder, matchAthlete, processFolder, words };
