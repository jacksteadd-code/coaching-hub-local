import { api, esc, toast, attempt, dialog, confirmDialog, field, hrs, pct, cap, avatar, sampleBadge, statusBadge, sourceBadge, flagList, calc, SPORTS } from './ui.js';
import { weeklyHoursChart, chartLegend, lineChart } from './charts.js';
import { main, rerender, wireCommon, taskRow } from './app.js';

const TABS = [['summary', 'Summary'], ['profile', 'Profile'], ['training', 'Training'], ['races', 'Races'], ['tests', 'Tests'], ['plan', 'Plan'], ['notes', 'Notes & tasks'], ['files', 'Files'], ['ai', 'AI assist']];
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

export async function renderAthlete(id, tab, rest) {
  if (tab === 'plan') { location.hash = `#/planner/${id}`; return; }
  const d = await api('GET', `/api/athletes/${id}`);
  const a = d.athlete;
  const dv = d.derived;
  main().innerHTML = `
  <div class="row" style="margin-bottom:6px"><a href="#/athletes" class="muted">← Athletes</a></div>
  <div class="page-head" style="align-items:center"><div class="name-cell">${avatar(a, true)}<div><h1>${esc(a.name)}${sampleBadge(a)}</h1>
    <div class="row"><small>${esc(cap(a.sport))}</small>${statusBadge(a.status)}${dv.coaching ? `<small>Coached ${esc(dv.coaching.label)}</small>` : ''}${dv.phase ? `<span class="badge blue">${esc(dv.phase)}</span>` : ''}${dv.nextRace ? `<small>${esc(dv.nextRace.name)} (${dv.nextRace.priority}) in ${esc(dv.nextRace.countdown.label)}</small>` : ''}</div></div></div>
    <div class="row"><button data-qnote>Quick note</button><button data-qweek>Log this week</button></div></div>
  <nav class="tabs">${TABS.map(([k, l]) => `<a href="#/athletes/${id}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
  <div id="tab"></div>`;
  main().querySelector('[data-qnote]').onclick = () => noteDialog(id).then((r) => r && rerender());
  main().querySelector('[data-qweek]').onclick = () => (location.hash = `#/athletes/${id}/training/${calc.weekStart(dv.today)}`);
  const el = main().querySelector('#tab');
  const fn = { summary: tabSummary, profile: tabProfile, training: tabTraining, races: tabRaces, tests: tabTests, notes: tabNotes, files: tabFiles, ai: tabAI }[tab] || tabSummary;
  await fn(el, d, rest);
  wireCommon(el);
}

// ---------------- Summary ----------------
function tabSummary(el, d) {
  const a = d.athlete;
  const p = d.derived.profile;
  const h = d.derived.health;
  const dv = d.derived;
  const upcoming = d.races.filter((r) => r.date >= dv.today && r.status === 'planned');
  const avail = p.availability ? DAYS.map(([k, l]) => (p.availability[k] ? `${l} ${p.availability[k]}h` : null)).filter(Boolean).join(', ') : '';
  const kv = (pairs) => `<dl class="kv">${pairs.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') || '<dd class="muted">Not recorded yet. <a href="#/athletes/' + a.id + '/profile">Fill in profile</a></dd>'}</dl>`;
  const lw = dv.lastWeek;
  el.innerHTML = `<div class="grid g3">
    <div class="card"><h2>Attention</h2>${flagList(dv.flags)}${dv.flags.length ? `<button class="small" data-flag-task style="margin-top:8px">Create task from a flag</button>` : ''}</div>
    <div class="card"><h2>The person</h2>${kv([['Preferred name', esc(a.preferred_name)], ['Goals', esc(a.goals)], ['Work', esc([p.occupation, p.work_hours, p.shift_pattern].filter(Boolean).join(' · '))], ['Family', esc(p.family)], ['Communication', esc([p.comms_preference, a.checkin_days ? `check-in every ${a.checkin_days} days` : ''].filter(Boolean).join(' · '))], ['Motivation', esc(p.motivation)], ['Finds difficult', esc(p.difficulties)], ['Travel/holidays', esc(p.travel)], ['Birthday', dv.birthday ? `${esc(a.birthday.slice(5))} (in ${dv.birthday.inDays} days)` : ''], ['Local time zone', esc(a.timezone)]])}</div>
    <div class="card"><h2>Training context</h2>${kv([['Availability', p.typical_weekly_hours || p.max_weekly_hours ? `typical ${esc(p.typical_weekly_hours || '?')} h, max ${esc(p.max_weekly_hours || '?')} h / week` : ''], ['By day', esc(avail)], ['Facilities', esc(['pool', 'gym', 'trainer', 'outdoor'].filter((k) => p.facilities?.[k]).join(', '))], ['Constraints', esc(p.constraints)], ['Background', esc(p.background)], ['Strengths', esc(p.strengths)], ['Limiters', esc(p.limiters)], ['Health notes', h.injuries ? `${h.active_issue ? '<span class="badge red">Review</span> ' : ''}${esc(h.injuries)}` : ''], ['Healthcare guidance', esc(h.guidance)]])}</div>
  </div>
  <div class="grid g3" style="margin-top:16px">
    <div class="card"><h2>Last week <small>${esc(lw.week)}</small></h2><div class="row"><div><div class="stat">${hrs(lw.completedHours)}</div><div class="stat-label">of ${hrs(lw.plannedHours)} planned</div></div><div class="right">${sourceBadge(lw.source)}</div></div><a href="#/athletes/${a.id}/training/${lw.week}">Open week →</a></div>
    <div class="card"><h2>Current thresholds</h2>${Object.keys(d.thresholds).length ? `<dl class="kv">${Object.entries(d.thresholds).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${fmtThreshold(v)} <small>from ${esc(v.from)}</small></dd>`).join('')}</dl>` : '<p class="muted">No accepted test results yet.</p>'}<h3>Last tested</h3><small>${['swim', 'bike', 'run'].map((x) => `${cap(x)}: ${dv.lastTest[x] || 'never'} <span class="badge">${dv.testWindows[x].status}</span>`).join('<br>')}</small></div>
    <div class="card"><h2>Upcoming races</h2>${upcoming.length ? upcoming.map((r) => `<div class="list-item"><span class="badge ${r.priority === 'A' ? 'red' : r.priority === 'B' ? 'amber' : ''}">${r.priority}</span><div class="grow">${esc(r.name)}<br><small>${esc(r.date)} · ${esc(calc.raceCountdown(r.date, dv.today).label)}</small></div></div>`).join('') : '<p class="muted">No races planned.</p>'}${dv.conflicts.map((c) => `<div class="notice warn" style="margin-top:8px">${esc(c.message)}</div>`).join('')}</div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Training, last 12 weeks <a class="btn small" href="#/athletes/${a.id}/training">Details</a></h2>${chartLegend()}<div class="chart">${weeklyHoursChart(d.summaries.slice(-12))}</div></div>
  <div class="card timeline" style="margin-top:16px"><h2>History</h2>${timelineHTML(d.timeline.slice(0, 12))}</div>`;
  el.querySelector('[data-flag-task]')?.addEventListener('click', async () => {
    const r = await dialog({ title: 'Create task from flag', body: field('Flag', 'i', 0, { type: 'select', opts: dv.flags.map((f, i) => [i, f.message.slice(0, 110)]) }) + field('Due', 'due_date', calc.addDays(dv.today, 2), { type: 'date' }) });
    if (!r) return;
    const f = dv.flags[+r.data.i];
    const kind = { checkin: 'checkin', review: 'review', test: 'test', birthday: 'birthday' }[f.type] || 'follow-up';
    await attempt(() => api('POST', '/api/tasks', { athlete_id: a.id, title: f.action, kind, due_date: r.data.due_date, notes: f.message }), 'Task created');
    rerender();
  });
}

function fmtThreshold(v) {
  if (v.unit === 's/100m' || v.unit === 's/km') return `${calc.formatDuration(v.value)} ${v.unit.replace('s/', '/')}`;
  return `${v.value} ${esc(v.unit)}`;
}

export function timelineHTML(items) {
  const colors = { test: 'blue', race: 'red', plan: 'amber', interruption: 'red', import: '' };
  return items.length ? items.map((t) => `<div class="list-item"><small class="mono" style="min-width:86px">${esc(t.date)}</small><span class="badge ${colors[t.kind] || ''}">${esc(t.kind)}</span><div class="grow" style="white-space:pre-wrap">${esc(t.text)}${t.shareable ? ' <span class="badge green">shareable</span>' : ''}</div></div>`).join('') : '<p class="muted">Nothing yet. Notes, tests, results and plan changes appear here.</p>';
}

// ---------------- Profile ----------------
function tabProfile(el, d) {
  const a = d.athlete;
  const p = d.derived.profile;
  const h = d.derived.health;
  const td = JSON.parse(a.test_days_json || '{}');
  el.innerHTML = `<form id="pf">
  <div class="card" style="margin-bottom:16px"><h2>Personal</h2><div class="form-grid">
    ${field('Full name', 'name', a.name)}${field('Preferred name', 'preferred_name', a.preferred_name)}${field('Birthday', 'birthday', a.birthday, { type: 'date' })}${field('Time zone', 'timezone', a.timezone, { help: 'e.g. Europe/London' })}
    ${field('Email', 'email', a.email, { type: 'email' })}${field('Phone', 'phone', a.phone)}${field('Occupation', 'p.occupation', p.occupation)}${field('Working hours', 'p.work_hours', p.work_hours)}
    ${field('Shift pattern', 'p.shift_pattern', p.shift_pattern)}${field('Preferred communication', 'p.comms_preference', p.comms_preference)}
    ${field('Family commitments and responsibilities', 'p.family', p.family, { type: 'textarea' })}${field('Travel and holidays', 'p.travel', p.travel, { type: 'textarea' })}
    ${field('Motivation', 'p.motivation', p.motivation, { type: 'textarea' })}${field('Preferences', 'p.preferences', p.preferences, { type: 'textarea' })}${field('Finds difficult', 'p.difficulties', p.difficulties, { type: 'textarea' })}
  </div></div>
  <div class="card" style="margin-bottom:16px"><h2>Coaching</h2><div class="form-grid">
    ${field('Status', 'status', a.status, { type: 'select', opts: ['active', 'paused', 'former'] })}${field('Main sport', 'sport', a.sport, { type: 'select', opts: [['triathlon', 'Triathlon'], ['run', 'Running'], ['bike', 'Cycling'], ['other', 'Other']] })}${field('Coaching start date', 'start_date', a.start_date, { type: 'date' })}${field('Coaching basis', 'p.billing', p.billing || 'paying', { type: 'select', opts: [['paying', 'Paying'], ['free', 'Free (not paying)']] })}${field('Current phase (if no plan week)', 'phase', a.phase)}
    ${field('Goals', 'goals', a.goals, { type: 'textarea', wide: true })}${field('Coaching history', 'p.history', p.history, { type: 'textarea' })}${field('Training background and experience', 'p.background', p.background, { type: 'textarea' })}
    ${field('Training age (years)', 'p.training_age_years', p.training_age_years, { type: 'number' })}${field('Typical weekly hours', 'p.typical_weekly_hours', p.typical_weekly_hours, { type: 'number' })}${field('Max sustainable weekly hours', 'p.max_weekly_hours', p.max_weekly_hours, { type: 'number' })}
    <div class="field wide"><label>Available hours by weekday</label><div class="row">${DAYS.map(([k, l]) => `<div style="width:70px"><small>${l}</small><input type="number" step="0.25" min="0" name="p.availability.${k}" value="${esc(p.availability?.[k] ?? '')}"></div>`).join('')}</div></div>
    <div class="field wide"><label>Facilities</label>${['pool', 'gym', 'trainer', 'outdoor'].map((k) => `<label class="check"><input type="checkbox" name="p.facilities.${k}" ${p.facilities?.[k] ? 'checked' : ''}> ${k === 'trainer' ? 'Indoor trainer' : cap(k)}</label>`).join('')}</div>
    ${field('Equipment', 'p.equipment', p.equipment, { type: 'textarea' })}${field('Constraints', 'p.constraints', p.constraints, { type: 'textarea' })}${field('Strengths', 'p.strengths', p.strengths, { type: 'textarea' })}${field('Development needs / limiters', 'p.limiters', p.limiters, { type: 'textarea' })}
  </div></div>
  <div class="card" style="margin-bottom:16px"><h2>Health and wellbeing <span class="badge amber">Sensitive · optional</span></h2>
    <div class="notice">Record only what the athlete has told you and what is useful for coaching. The app does not interpret this or suggest treatment. Health notes are left out of AI summaries unless you tick them.</div><div class="form-grid">
    ${field('Athlete-reported injuries, illness, limitations', 'h.injuries', h.injuries, { type: 'textarea' })}${field('Guidance from their healthcare professional', 'h.guidance', h.guidance, { type: 'textarea' })}
    ${field('Nutrition considerations', 'h.nutrition', h.nutrition, { type: 'textarea' })}${field('Recovery and wellbeing (optional)', 'h.wellbeing', h.wellbeing, { type: 'textarea' })}
    ${field('Current issue needs my review', 'h.active_issue', h.active_issue, { type: 'checkbox', wide: true, help: 'Shows a flag on the overview and makes suggestions show a conservative option.' })}
  </div></div>
  <div class="card" style="margin-bottom:16px"><h2>Review and testing rhythm</h2><div class="form-grid">
    ${field('Check-in every (days)', 'checkin_days', a.checkin_days, { type: 'number', num: true })}${field('Plan review every (days)', 'review_days', a.review_days, { type: 'number', num: true })}${field('Last plan review', 'last_review_date', a.last_review_date, { type: 'date' })}
    ${['swim', 'bike', 'run'].map((x) => field(`${cap(x)} test every (days, blank = off)`, `td.${x}`, td[x] ?? '', { type: 'number' })).join('')}
  </div></div>
  <div class="row"><button class="primary" type="submit">Save profile</button><button type="button" class="danger right" data-del>Delete athlete…</button></div></form>`;
  const form = el.querySelector('#pf');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const o = formFields(form);
    const body = { ...o.top, profile_json: o.p, health_json: o.h, test_days_json: Object.fromEntries(Object.entries(o.td).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])) };
    await attempt(() => api('PUT', `/api/athletes/${a.id}`, body), 'Profile saved');
    rerender();
  };
  el.querySelector('[data-del]').onclick = async () => {
    const r = await dialog({ title: 'Delete athlete', body: `<div class="notice danger">This permanently deletes ${esc(a.name)} and all their races, tests, training, plans, notes and files. Download a backup first if you might need it. Consider setting status to "former" instead.</div>${field(`Type the athlete's name to confirm`, 'confirm', '')}`, buttons: [{ label: 'Cancel', value: null }, { label: 'Delete permanently', value: 'd', primary: true }], validate: (x) => (x.confirm.trim() !== a.name ? 'Name does not match' : null) });
    if (!r) return;
    await attempt(() => api('DELETE', `/api/athletes/${a.id}`), 'Athlete deleted');
    location.hash = '#/athletes';
  };
}

// Splits prefixed form names (p.x, h.x, td.x) into separate objects.
function formFields(form) {
  const out = { top: {}, p: {}, h: {}, td: {} };
  for (const el of form.querySelectorAll('[name]')) {
    const v = el.type === 'checkbox' ? el.checked : el.value;
    const parts = el.name.split('.');
    if (parts.length === 1) { out.top[el.name] = el.dataset.num !== undefined && v !== '' ? Number(v) : v; continue; }
    let o = out[parts[0]];
    for (const k of parts.slice(1, -1)) o = o[k] = o[k] || {};
    o[parts[parts.length - 1]] = v;
  }
  return out;
}

// ---------------- Training ----------------
let trendWeeks = 12;
async function tabTraining(el, d, rest) {
  const a = d.athlete;
  const week = rest[0] && calc.parseDate(rest[0]) ? calc.weekStart(rest[0]) : calc.weekStart(d.derived.today);
  const w = await api('GET', `/api/athletes/${a.id}/weeks/${week}`);
  const s = w.summary;
  const log = w.log || {};
  const planned = log.planned_json ? JSON.parse(log.planned_json) : {};
  const completed = log.completed_json ? JSON.parse(log.completed_json) : {};
  const sums = d.summaries;
  const series = sums.slice(-trendWeeks);
  const season = sums;
  const compareRow = (label, x) => `<tr><td>${label}</td><td>${hrs(x)}</td></tr>`;
  const loads = Object.entries(s.loads);
  const scale = (name, val) => `<div class="field"><label>${cap(name)} (1–5)</label><div class="scale" data-scale="${name}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="${val === n ? 'on' : ''}" data-v="${n}">${n}</button>`).join('')}<input type="hidden" name="${name}" value="${val ?? ''}"></div></div>`;
  el.innerHTML = `
  <div class="card" style="margin-bottom:16px"><h2>Trends <span class="seg">${[4, 8, 12, 26].map((n) => `<button class="${trendWeeks === n ? 'on' : ''}" data-tw="${n}">${n === 26 ? 'Season' : n + ' wk'}</button>`).join('')}</span></h2>${chartLegend()}<div class="chart">${weeklyHoursChart(series)}</div>
    <div class="grid g3" style="margin-top:10px">${trendStats(series, sums)}</div></div>
  <div class="row" style="margin-bottom:12px"><a class="btn small" href="#/athletes/${a.id}/training/${calc.addDays(week, -7)}">← Previous</a><h2 style="margin:0">Week of ${esc(week)}</h2><a class="btn small" href="#/athletes/${a.id}/training/${calc.addDays(week, 7)}">Next →</a>${sourceBadge(s.source)}<button class="right primary" data-import>Import CSV</button></div>
  <div class="grid g2">
    <div class="card"><h2>Summary</h2>
      <table><thead><tr><th></th><th>Planned</th><th>Completed</th><th>Distance</th></tr></thead><tbody>
      ${SPORTS.map((sp) => `<tr><td>${cap(sp)}</td><td>${hrs(s.plannedBySport?.[sp] ?? null)}</td><td>${s.source === 'missing' ? '—' : hrs(s.completedBySport[sp] ?? 0)}</td><td>${s.distanceBySport[sp] != null ? s.distanceBySport[sp].toFixed(1) + ' km' : '—'}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td><b>${hrs(s.plannedHours)}</b></td><td><b>${hrs(s.completedHours)}</b></td><td></td></tr></tbody></table>
      <dl class="kv" style="margin-top:12px"><dt>Sessions</dt><dd>${s.sessionsDone ?? '—'} done${s.plannedSessions != null ? ` of ${s.plannedSessions} planned` : ''}${s.missedSessions ? `, ${s.missedSessions} missed` : ''}</dd>
      <dt>Longest session</dt><dd>${s.longestMin != null ? calc.formatDuration(s.longestMin * 60) : '—'}</dd>
      <dt>Completion</dt><dd>${pct(s.compliance)}${s.plannedSource ? ` <small>(planned from ${esc(s.plannedSource)})</small>` : ''}</dd>
      <dt>Load <small>(kept separate by method)</small></dt><dd>${loads.length ? loads.map(([k, v]) => `${Math.round(v)} <small>${esc(k)}</small>`).join('<br>') : '—'}</dd></dl>
      <h3>Compared with</h3><table>${compareRow('Previous week', w.prev.completedHours)}${compareRow(`Own baseline (median of ${w.baseline.weeksUsed} weeks with data)`, w.baseline.hours)}${w.plan ? `<tr><td>Season plan target</td><td>${w.plan.hours_min ?? '?'}–${w.plan.hours_max ?? '?'} h ${w.plan.focus ? `<small>· ${esc(w.plan.focus)}</small>` : ''}</td></tr>` : ''}</table>
    </div>
    <div class="card"><h2>Weekly log</h2><form id="wk">
      <h3 style="margin-top:0">Planned hours by sport</h3><div class="row">${SPORTS.map((sp) => `<div style="width:80px"><small>${cap(sp)}</small><input type="number" step="0.25" min="0" name="planned.${sp}" value="${esc(planned[sp] ?? '')}"></div>`).join('')}</div>
      <h3>Completed hours by sport <small>(only if not entering sessions below)</small></h3><div class="row">${SPORTS.map((sp) => `<div style="width:80px"><small>${cap(sp)}</small><input type="number" step="0.25" min="0" name="completed.${sp}" value="${esc(completed[sp] ?? '')}"></div>`).join('')}</div>
      <small>Leave blank for unknown. Enter 0 only if the athlete genuinely did none.</small>
      <div class="form-grid" style="margin-top:10px">${field('Sessions planned', 'sessions_planned', log.sessions_planned, { type: 'number', num: true })}${field('Sessions done (if no session list)', 'sessions_done', log.sessions_done, { type: 'number', num: true })}</div>
      <h3>Athlete-reported wellbeing <small>(optional)</small></h3><div class="row" style="gap:14px">${['sleep', 'fatigue', 'soreness', 'stress', 'motivation'].map((k) => scale(k, log[k])).join('')}</div>
      ${field('Athlete comments', 'athlete_comments', log.athlete_comments, { type: 'textarea' })}${field('Missed or modified sessions and reasons', 'missed_reasons', log.missed_reasons, { type: 'textarea' })}
      ${field('Coach notes (private)', 'coach_notes', log.coach_notes, { type: 'textarea' })}${field('Next actions', 'next_actions', log.next_actions, { type: 'textarea' })}
      <button class="primary" type="submit">Save week</button></form></div>
  </div>
  <div class="card flush" style="margin-top:16px"><div style="padding:16px 16px 0"><h2>Sessions <button class="small" data-add-act>Add session</button></h2></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Sport</th><th>Session</th><th>Status</th><th>Duration</th><th>Planned</th><th>Distance</th><th>Load</th><th>RPE</th><th>Source</th><th></th></tr></thead><tbody>
  ${w.activities.map((x) => `<tr><td>${esc(x.date)}</td><td>${esc(cap(x.sport))}</td><td>${esc(x.title || '')}${x.comments ? `<br><small>${esc(x.comments)}</small>` : ''}</td><td>${x.status === 'completed' ? '' : `<span class="badge ${x.status === 'missed' ? 'red' : 'amber'}">${esc(x.status)}</span>`}</td><td>${x.duration_min != null ? calc.formatDuration(x.duration_min * 60) : '—'}</td><td>${x.planned_min != null ? calc.formatDuration(x.planned_min * 60) : '—'}</td><td>${x.distance_km != null ? x.distance_km.toFixed(2) + ' km' : '—'}</td><td>${x.load != null ? `${Math.round(x.load)} <small>${esc(x.load_type || '')}</small>` : '—'}</td><td>${x.rpe ?? '—'}</td><td><span class="badge">${esc(x.source)}</span></td><td><button class="small link" data-edit-act="${x.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="11" class="muted">No sessions recorded for this week.</td></tr>'}
  </tbody></table></div></div>
  ${d.imports.length ? `<div class="card" style="margin-top:16px"><h2>Imports</h2>${d.imports.slice(0, 8).map((i) => `<div class="list-item"><div class="grow">${esc(i.filename || 'CSV')} <small>${esc(i.created_at)} · ${i.rows_added} added · ${i.rows_duplicate} unchanged/updated · ${i.rows_invalid} invalid</small></div><button class="small danger" data-undo-imp="${i.id}">Undo</button></div>`).join('')}</div>` : ''}
  <div class="row" style="margin-top:12px"><a class="btn small" href="/download/activities.csv?athlete=${a.id}">Export sessions (CSV)</a></div>`;
  el.querySelectorAll('[data-tw]').forEach((b) => (b.onclick = () => { trendWeeks = +b.dataset.tw; rerender(); }));
  el.querySelectorAll('[data-scale]').forEach((sc) => sc.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    const inp = sc.querySelector('input');
    const on = b.classList.contains('on');
    sc.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    if (!on) b.classList.add('on');
    inp.value = on ? '' : b.dataset.v;
  })));
  el.querySelector('#wk').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { planned_json: {}, completed_json: {} };
    for (const inp of f.querySelectorAll('[name]')) {
      const [k, sp] = inp.name.split('.');
      if (sp) body[k === 'planned' ? 'planned_json' : 'completed_json'][sp] = inp.value;
      else body[k] = ['sleep', 'fatigue', 'soreness', 'stress', 'motivation', 'sessions_planned', 'sessions_done'].includes(k) ? (inp.value === '' ? null : Number(inp.value)) : inp.value;
    }
    await attempt(() => api('PUT', `/api/athletes/${a.id}/weeks/${week}`, body), 'Week saved');
    rerender();
  };
  el.querySelector('[data-add-act]').onclick = () => activityDialog(a.id, { date: week }).then((r) => r && rerender());
  el.querySelectorAll('[data-edit-act]').forEach((b) => (b.onclick = () => activityDialog(a.id, w.activities.find((x) => x.id === +b.dataset.editAct)).then((r) => r && rerender())));
  el.querySelector('[data-import]').onclick = () => importDialog(a).then((r) => r && rerender());
  el.querySelectorAll('[data-undo-imp]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog('Undo import', 'Remove the sessions this import added? Sessions it updated keep their new values.', 'Remove', true))) return;
    const r = await attempt(() => api('DELETE', `/api/imports/${b.dataset.undoImp}`));
    toast(`Removed ${r.removed} sessions`);
    rerender();
  }));
}

function trendStats(series, all) {
  const withData = series.filter((s) => s.completedHours != null);
  const planned = series.filter((s) => s.plannedHours != null && s.completedHours != null);
  const avg = withData.length ? withData.reduce((x, s) => x + s.completedHours, 0) / withData.length : null;
  const comp = planned.length ? planned.reduce((x, s) => x + s.completedHours, 0) / planned.reduce((x, s) => x + s.plannedHours, 0) : null;
  const base = calc.baseline(all.slice(0, -1), 8);
  return `<div><div class="stat">${hrs(avg)}</div><div class="stat-label">average per week with data (${withData.length}/${series.length} weeks have data)</div></div>
  <div><div class="stat">${pct(comp)}</div><div class="stat-label">of planned hours completed (weeks with both plan and data)</div></div>
  <div><div class="stat">${hrs(base.hours)}</div><div class="stat-label">own baseline: median of last ${base.weeksUsed} weeks with data</div></div>`;
}

export async function activityDialog(athleteId, x = {}) {
  const r = await dialog({
    title: x.id ? 'Edit session' : 'Add session',
    body: `<div class="form-grid">${field('Date', 'date', x.date || '', { type: 'date' })}${field('Sport', 'sport', x.sport || 'run', { type: 'select', opts: SPORTS.map((s) => [s, cap(s)]) })}${field('Status', 'status', x.status || 'completed', { type: 'select', opts: [['completed', 'Completed'], ['modified', 'Modified'], ['missed', 'Missed'], ['planned', 'Planned (not done yet)']] })}${field('Title', 'title', x.title || '')}
    ${field('Duration (h:mm or minutes)', 'duration', x.duration_min != null ? calc.formatDuration(x.duration_min * 60).replace(/:\d\d$/, '') : '', { help: 'e.g. 1:15 or 75' })}${field('Planned duration (h:mm or minutes)', 'planned', x.planned_min != null ? calc.formatDuration(x.planned_min * 60).replace(/:\d\d$/, '') : '')}
    ${field('Distance (km)', 'distance_km', x.distance_km ?? '', { type: 'number' })}${field('Session RPE (0–10)', 'rpe', x.rpe ?? '', { type: 'number' })}
    ${field('Load value', 'load', x.load ?? '', { type: 'number' })}${field('Load method', 'load_type', x.load_type || '', { help: 'e.g. TrainingPeaks TSS (bike), rTSS, hrTSS' })}
    ${field('Comments', 'comments', x.comments || '', { type: 'textarea', wide: true })}</div>`,
    buttons: [...(x.id ? [{ label: 'Delete', value: 'delete', danger: true, left: true }] : []), { label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
  });
  if (!r) return null;
  if (r.action === 'delete') return attempt(() => api('DELETE', `/api/activities/${x.id}`), 'Session deleted');
  const toMin = (v) => (!v ? null : v.includes(':') ? v.split(':').map(Number).reduce((a, b) => a * 60 + b, 0) : Number(v));
  const body = { ...r.data, athlete_id: athleteId, duration_min: toMin(r.data.duration), planned_min: toMin(r.data.planned) };
  delete body.duration;
  delete body.planned;
  return attempt(() => (x.id ? api('PUT', `/api/activities/${x.id}`, body) : api('POST', '/api/activities', { ...body, source: 'manual' })), 'Session saved');
}

async function importDialog(a) {
  let csv = null;
  let filename = null;
  let preview = null;
  const mapFields = [['date', 'Date'], ['sport', 'Sport'], ['title', 'Title'], ['duration', 'Completed duration'], ['planned', 'Planned duration'], ['distance', 'Distance'], ['load', 'Load'], ['rpe', 'RPE'], ['comments', 'Comments']];
  const r = await dialog({
    title: `Import training for ${a.preferred_name || a.name}`,
    wide: true,
    body: `<div class="notice">Supports the TrainingPeaks workouts export (Calendar → Export → Workouts CSV) and other CSV files. You'll see a preview before anything is saved. Re-importing the same file updates matching rows instead of duplicating them.</div>
      <input type="file" accept=".csv,text/csv" data-file data-noautofocus><div id="imp" style="margin-top:12px"></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import', value: 'import', primary: true }],
    validate: () => (!preview ? 'Choose a file first' : !(preview.counts.new || preview.counts.update) ? 'Nothing new to import' : preview.missingCols.length ? 'Fix the column mapping first' : null),
    onOpen: (dlg) => {
      const box = dlg.querySelector('#imp');
      const refresh = async (mapping, preset) => {
        try {
          preview = await api('POST', `/api/athletes/${a.id}/import/preview`, { csv, preset, mapping });
        } catch (e) { box.innerHTML = `<div class="notice danger">${esc(e.message)}</div>`; preview = null; return; }
        const p = preview;
        const opt = (k) => `<select data-map="${k}"><option value="">— not in file —</option>${p.headers.map((h) => `<option ${p.mapping[k] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`;
        const unit = (k, opts) => `<select data-map="${k}">${opts.map((o) => `<option ${p.mapping[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
        box.innerHTML = `<div class="row"><b>Format:</b><select data-preset style="width:auto">${Object.entries(p.presets).map(([k, l]) => `<option value="${k}" ${p.preset === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><small>${p.total} rows in file</small></div>
        <details ${p.preset === 'generic' || p.missingCols.length ? 'open' : ''} style="margin:10px 0"><summary>Column mapping and units</summary><div class="form-grid" style="margin-top:8px">${mapFields.map(([k, l]) => `<div class="field"><label>${l}</label>${opt(k)}</div>`).join('')}
          <div class="field"><label>Date format</label>${unit('dateFormat', ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'])}</div><div class="field"><label>Duration unit</label>${unit('durationUnit', ['hours', 'minutes', 'seconds'])}</div><div class="field"><label>Planned unit</label>${unit('plannedUnit', ['hours', 'minutes', 'seconds'])}</div><div class="field"><label>Distance unit</label>${unit('distanceUnit', ['m', 'km', 'mi'])}</div>
          <div class="field"><label>Load method label</label><input data-map="loadLabel" value="${esc(p.mapping.loadLabel || '')}"></div></div>
          <small>Dates with a time and offset are converted to the athlete's time zone (${esc(a.timezone || 'your time zone')}). Load is stored per sport with its method, never combined across methods.</small></details>
        ${p.missingCols.length ? `<div class="notice danger">Mapped columns not found: ${p.missingCols.map(esc).join(', ')}</div>` : ''}
        <div class="row"><span class="badge green">${p.counts.new || 0} new</span><span class="badge blue">${p.counts.update || 0} updated</span><span class="badge">${p.counts.unchanged || 0} already imported</span><span class="badge red">${p.counts.invalid || 0} with errors</span><span class="badge">${p.counts.skipped || 0} skipped</span></div>
        <div class="table-wrap" style="max-height:300px;overflow:auto;margin-top:8px"><table><thead><tr><th>Line</th><th>Result</th><th>Date</th><th>Sport</th><th>Title</th><th>Done</th><th>Planned</th><th>km</th><th>Notes</th></tr></thead><tbody>
        ${p.rows.slice(0, 300).map((x) => `<tr><td>${x.line}</td><td><span class="badge ${x.result === 'new' ? 'green' : x.result === 'update' ? 'blue' : x.result === 'invalid' ? 'red' : ''}">${x.result}</span></td><td>${esc(x.activity?.date || '')}</td><td>${esc(x.activity?.sport || '')}</td><td>${esc(x.activity?.title || '')}</td><td>${x.activity?.duration_min != null ? Math.round(x.activity.duration_min) + ' min' : ''}</td><td>${x.activity?.planned_min != null ? Math.round(x.activity.planned_min) + ' min' : ''}</td><td>${x.activity?.distance_km ?? ''}</td><td><small>${esc([...x.errors, ...x.warnings, x.skip || '', x.changed ? 'changed: ' + x.changed.join(', ') : ''].filter(Boolean).join('; '))}</small></td></tr>`).join('')}</tbody></table></div>`;
        box.querySelector('[data-preset]').onchange = (e) => refresh(null, e.target.value);
        box.querySelectorAll('[data-map]').forEach((s) => (s.onchange = () => {
          const m = { ...preview.mapping };
          box.querySelectorAll('[data-map]').forEach((x) => (m[x.dataset.map] = x.value || undefined));
          refresh(m, preview.preset);
        }));
      };
      dlg.querySelector('[data-file]').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        filename = f.name;
        csv = await f.text();
        refresh();
      };
    },
  });
  if (!r) return null;
  const res = await attempt(() => api('POST', `/api/athletes/${a.id}/import/commit`, { csv, preset: preview.preset, mapping: preview.mapping, filename }));
  toast(`Imported: ${res.added} new, ${res.updated} updated, ${res.unchanged} unchanged${res.invalid ? `, ${res.invalid} rows with errors skipped` : ''}`);
  return res;
}

// ---------------- Races ----------------
function tabRaces(el, d) {
  const a = d.athlete;
  const today = d.derived.today;
  const up = d.races.filter((r) => r.date >= today && r.status === 'planned');
  const past = d.races.filter((r) => !(r.date >= today && r.status === 'planned')).reverse();
  const item = (r) => `<div class="list-item"><span class="badge ${r.priority === 'A' ? 'red' : r.priority === 'B' ? 'amber' : ''}">${r.priority}</span><div class="grow"><b>${esc(r.name)}</b> <small>${esc(r.date)}${r.location ? ' · ' + esc(r.location) : ''}${r.distance ? ' · ' + esc(r.distance) : ''}</small><br>
    ${r.status === 'planned' ? `<small>${esc(calc.raceCountdown(r.date, today).label)}${r.goal ? ' · Goal: ' + esc(r.goal) : ''}${r.target ? ' · Target: ' + esc(r.target) : ''}</small>` : `<span class="badge ${r.status === 'completed' ? 'green' : ''}">${esc(r.status)}</span> ${esc(r.result || '')}${r.lessons ? `<br><small>Lessons: ${esc(r.lessons)}</small>` : ''}`}</div><button class="small" data-edit-race="${r.id}">Edit</button></div>`;
  el.innerHTML = `${d.derived.conflicts.map((c) => `<div class="notice warn">${esc(c.message)}</div>`).join('')}
  <div class="grid g2"><div class="card"><h2>Upcoming <button class="small primary" data-add-race>Add race</button></h2>${up.map(item).join('') || '<p class="muted">No upcoming races.</p>'}</div>
  <div class="card"><h2>Past results</h2>${past.map(item).join('') || '<p class="muted">No past races.</p>'}</div></div>`;
  el.querySelector('[data-add-race]').onclick = () => raceDialog(a, {}).then((r) => r && rerender());
  el.querySelectorAll('[data-edit-race]').forEach((b) => (b.onclick = () => raceDialog(a, d.races.find((r) => r.id === +b.dataset.editRace)).then((r) => r && rerender())));
}

async function raceDialog(a, r) {
  const res = await dialog({
    title: r.id ? 'Edit race' : 'Add race',
    wide: true,
    body: `<div class="form-grid">${field('Race name', 'name', r.name)}${field('Date', 'date', r.date, { type: 'date' })}${field('Location', 'location', r.location)}${field('Race time zone', 'timezone', r.timezone || a.timezone)}
    ${field('Sport', 'sport', r.sport || a.sport, { type: 'select', opts: ['triathlon', 'run', 'bike', 'duathlon', 'swim', 'other'] })}${field('Distance', 'distance', r.distance, { help: 'e.g. 70.3, Olympic, Marathon, 160 km' })}${field('Priority', 'priority', r.priority || 'B', { type: 'select', opts: [['A', 'A – main goal'], ['B', 'B – important'], ['C', 'C – training race']] })}${field('Status', 'status', r.status || 'planned', { type: 'select', opts: ['planned', 'completed', 'DNS', 'DNF', 'cancelled'] })}
    ${field('Goal', 'goal', r.goal)}${field('Target', 'target', r.target)}${field('Actual result', 'result', r.result)}${field('Splits and metrics', 'splits', r.splits, { type: 'textarea' })}
    ${field('Course, terrain and expected conditions', 'course', r.course, { type: 'textarea', help: 'Only what you know about this course.' })}${field('Travel dates and logistics', 'travel', r.travel, { type: 'textarea', help: 'Dates as YYYY-MM-DD can appear on your calendar if travel is enabled.' })}
    ${field('Race report', 'report', r.report, { type: 'textarea' })}${field('Lessons learned', 'lessons', r.lessons, { type: 'textarea' })}${field('Recovery notes', 'recovery', r.recovery, { type: 'textarea' })}</div>`,
    buttons: [...(r.id ? [{ label: 'Delete', value: 'delete', danger: true, left: true }] : []), { label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
    validate: (x) => (!x.name || !x.date ? 'Name and date are required' : null),
  });
  if (!res) return null;
  if (res.action === 'delete') return (await confirmDialog('Delete race', `Delete ${esc(r.name)}?`, 'Delete', true)) && attempt(() => api('DELETE', `/api/races/${r.id}`), 'Race deleted');
  return attempt(() => (r.id ? api('PUT', `/api/races/${r.id}`, res.data) : api('POST', '/api/races', { ...res.data, athlete_id: a.id })), 'Race saved');
}

// ---------------- Tests ----------------
const TEST_TYPES = {
  bike: [['ftp_20min', '20-min FTP test', [['avgPower', '20-min average power (W)']]], ['ftp_ramp', 'Ramp test', [['bestMinutePower', 'Best 1-min power (W)']]], ['power_duration', 'Power-duration benchmark', []], ['other', 'Other', []]],
  swim: [['css', 'CSS test (400/200)', [['t400', '400 m time (m:ss)'], ['t200', '200 m time (m:ss)']]], ['swim_tt', 'Swim time trial', []], ['other', 'Other', []]],
  run: [['run_tt', 'Run time trial', [['distanceKm', 'Distance (km)'], ['time', 'Time (h:mm:ss or mm:ss)']]], ['lthr_run_30min', '30-min LTHR test', [['last20AvgHr', 'Avg HR, last 20 min (bpm)']]], ['race_benchmark', 'Race benchmark', []], ['other', 'Other', []]],
  hr: [['hr_thresholds', 'Heart-rate thresholds', []]],
  lab: [['lab', 'Lab / lactate test', []]],
  other: [['other', 'Other', []]],
};

function tabTests(el, d) {
  const a = d.athlete;
  const dv = d.derived;
  const byDisc = (x) => d.tests.filter((t) => t.discipline === x);
  const ftp = d.tests.filter((t) => t.derived_metric === 'FTP');
  el.innerHTML = `<div class="grid g3">${['swim', 'bike', 'run'].map((x) => { const w = dv.testWindows[x]; return `<div class="card"><h2>${cap(x)}</h2><dl class="kv"><dt>Last test</dt><dd>${esc(dv.lastTest[x] || 'Never')}</dd><dt>Next window</dt><dd><span class="badge ${w.status === 'overdue' ? 'red' : w.status === 'due' ? 'amber' : ''}">${esc(w.status)}</span> ${esc(w.message)}</dd></dl></div>`; }).join('')}</div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Thresholds in use</h2>${Object.keys(d.thresholds).length ? `<dl class="kv">${Object.entries(d.thresholds).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${fmtThreshold(v)} <small>effective from ${esc(v.from)}</small></dd>`).join('')}</dl>` : '<p class="muted">Accept a test result to set training zones.</p>'}
      ${d.zones ? `<h3>Power zones from FTP <small>(Coggan convention)</small></h3><table>${d.zones.map((z) => `<tr><td>${esc(z.name)}</td><td>${z.low}–${z.high ?? '+'} W</td></tr>`).join('')}</table>` : ''}
      <p><small>Earlier sessions keep the thresholds that applied on their date. Changing a threshold never reinterprets history.</small></p></div>
    <div class="card"><h2>FTP history</h2><div class="chart">${lineChart([{ name: 'FTP', color: 'var(--bike)', points: ftp.map((t) => ({ x: t.date, y: t.derived_value, hollow: !t.accepted, label: `${t.date}: ${t.derived_value} W${t.accepted ? ' (accepted from ' + (t.effective_from || t.date) + ')' : ' (not accepted)'}` })) }], { yLabel: 'FTP (W)' })}</div><small>Filled points are accepted for zones; hollow points are recorded but not used.</small></div>
  </div>
  <div class="card flush" style="margin-top:16px"><div style="padding:16px 16px 0"><h2>Test history <button class="small primary" data-add-test>Add test</button></h2></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Discipline</th><th>Test & protocol</th><th>Raw result</th><th>Derived</th><th>Conditions / source</th><th>Zones</th><th></th></tr></thead><tbody>
  ${d.tests.map((t) => `<tr><td>${esc(t.date)}</td><td>${esc(cap(t.discipline))}</td><td>${esc(t.test_type)}${t.protocol ? `<br><small>${esc(t.protocol)}</small>` : ''}</td><td>${esc(t.raw_summary || '')}</td><td>${t.derived_value != null ? `${esc(t.derived_metric)} ${t.derived_unit === 's/100m' || t.derived_unit === 's/km' ? calc.formatDuration(t.derived_value) + ' ' + t.derived_unit.slice(2) : t.derived_value + ' ' + esc(t.derived_unit)}<br><small>${esc(t.method || '')}</small>` : '—'}</td><td><small>${esc([t.conditions, t.source].filter(Boolean).join(' · '))}</small></td><td>${t.accepted ? `<span class="badge green">Used from ${esc(t.effective_from || t.date)}</span>` : '<span class="badge">Not used</span>'}</td><td><button class="small" data-edit-test="${t.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No tests yet.</td></tr>'}
  </tbody></table></div></div>`;
  el.querySelector('[data-add-test]').onclick = () => testDialog(a, {}).then((r) => r && rerender());
  el.querySelectorAll('[data-edit-test]').forEach((b) => (b.onclick = () => testDialog(a, d.tests.find((t) => t.id === +b.dataset.editTest)).then((r) => r && rerender())));
}

async function testDialog(a, t) {
  const raw = t.raw_json ? JSON.parse(t.raw_json) : {};
  const disc = t.discipline || (a.sport === 'run' ? 'run' : 'bike');
  const defaultDate = t.date || calc.todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const res = await dialog({
    title: t.id ? 'Edit test' : 'Add test',
    wide: true,
    body: `<div class="form-grid">${field('Date', 'date', defaultDate, { type: 'date' })}${field('Discipline', 'discipline', disc, { type: 'select', opts: Object.keys(TEST_TYPES).map((k) => [k, k === 'hr' ? 'Heart rate' : k === 'lab' ? 'Lab / lactate' : cap(k)]) })}<div class="field"><label>Test</label><select name="test_type"></select></div>${field('Protocol', 'protocol', t.protocol)}</div>
    <div id="rawf" class="form-grid"></div><div id="derived" class="notice" style="display:none"></div>
    <div class="form-grid">${field('Raw result summary', 'raw_summary', t.raw_summary, { help: 'How you would describe the raw result' })}${field('Derived metric (if entering manually)', 'derived_metric', t.derived_metric, { help: 'e.g. FTP, CSS, Run LTHR, Threshold pace' })}${field('Derived value', 'derived_value', t.derived_value ?? '', { type: 'number' })}${field('Unit', 'derived_unit', t.derived_unit, { help: 'W, s/100m, s/km, bpm' })}
    ${field('Calculation method', 'method', t.method, { wide: true })}${field('Conditions, fatigue and context', 'conditions', t.conditions, { type: 'textarea' })}${field('Source', 'source', t.source, { help: 'e.g. TrainingPeaks file, lab report, race result' })}${field('Notes and validity', 'notes', t.notes, { type: 'textarea' })}
    ${field('Accept for setting training zones', 'accepted', t.accepted, { type: 'checkbox' })}${field('Effective from', 'effective_from', t.effective_from || defaultDate, { type: 'date', help: 'Sessions before this date keep earlier thresholds.' })}</div>`,
    buttons: [...(t.id ? [{ label: 'Delete', value: 'delete', danger: true, left: true }] : []), { label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
    onOpen: (dlg) => {
      const discSel = dlg.querySelector('[name=discipline]');
      const typeSel = dlg.querySelector('[name=test_type]');
      const rawBox = dlg.querySelector('#rawf');
      const out = dlg.querySelector('#derived');
      const fillTypes = () => { typeSel.innerHTML = TEST_TYPES[discSel.value].map(([k, l]) => `<option value="${k}" ${t.test_type === k ? 'selected' : ''}>${l}</option>`).join(''); fillRaw(); };
      const fillRaw = () => {
        const spec = TEST_TYPES[discSel.value].find(([k]) => k === typeSel.value)?.[2] || [];
        rawBox.innerHTML = spec.map(([k, l]) => `<div class="field"><label>${l}</label><input name="raw.${k}" value="${esc(raw[k] ?? '')}"></div>`).join('');
        rawBox.querySelectorAll('input').forEach((i) => (i.oninput = derive));
        derive();
      };
      const derive = () => {
        const r = {};
        rawBox.querySelectorAll('input').forEach((i) => (r[i.name.slice(4)] = i.value));
        const x = calc.deriveFromTest(typeSel.value, r);
        out.style.display = x ? '' : 'none';
        if (x) {
          out.innerHTML = `<b>${esc(x.metric)}: ${esc(x.display || x.value + ' ' + x.unit)}</b><br><small>${esc(x.method)} Deterministic calculation.</small>`;
          dlg.querySelector('[name=derived_metric]').value = x.metric;
          dlg.querySelector('[name=derived_value]').value = x.value;
          dlg.querySelector('[name=derived_unit]').value = x.unit;
          dlg.querySelector('[name=method]').value = x.method;
          const sum = dlg.querySelector('[name=raw_summary]');
          if (!sum.dataset.touched) sum.value = Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ');
        }
      };
      dlg.querySelector('[name=raw_summary]').oninput = (e) => (e.target.dataset.touched = '1');
      // Effective date follows the test date until edited by hand
      const eff = dlg.querySelector('[name=effective_from]');
      eff.oninput = () => (eff.dataset.touched = '1');
      dlg.querySelector('[name=date]').addEventListener('input', (e) => { if (!eff.dataset.touched && !t.effective_from) eff.value = e.target.value; });
      discSel.onchange = fillTypes;
      typeSel.onchange = fillRaw;
      fillTypes();
    },
    validate: (x) => (x.accepted && !x.effective_from ? 'Set the effective-from date' : x.accepted && x.derived_value === '' ? 'An accepted test needs a derived value' : null),
  });
  if (!res) return null;
  if (res.action === 'delete') return (await confirmDialog('Delete test', 'Delete this test record?', 'Delete', true)) && attempt(() => api('DELETE', `/api/tests/${t.id}`), 'Test deleted');
  const { raw: rawVals = {}, ...body } = res.data;
  body.raw_json = rawVals;
  body.derived_value = body.derived_value === '' ? null : Number(body.derived_value);
  return attempt(() => (t.id ? api('PUT', `/api/tests/${t.id}`, body) : api('POST', '/api/tests', { ...body, athlete_id: a.id })), 'Test saved');
}

// ---------------- Notes & tasks ----------------
export async function noteDialog(athleteId, n = {}) {
  const r = await dialog({
    title: n.id ? 'Edit note' : 'Add note',
    body: `<div class="form-grid">${field('Date', 'date', n.date || calc.todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone), { type: 'date' })}${field('Type', 'kind', n.kind || 'note', { type: 'select', opts: [['note', 'Note'], ['check-in', 'Check-in'], ['call', 'Call notes'], ['interruption', 'Interruption (illness, injury, travel, life)'], ['follow-up', 'Follow-up']] })}</div>${field('Note', 'body', n.body || '', { type: 'textarea', rows: 6 })}${field('Shareable with athlete', 'shareable', n.shareable, { type: 'checkbox', help: 'Leave unticked for private coach notes.' })}`,
    buttons: [...(n.id ? [{ label: 'Delete', value: 'delete', danger: true, left: true }] : []), { label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
    validate: (x) => (!x.body.trim() ? 'Write a note first' : null),
  });
  if (!r) return null;
  if (r.action === 'delete') return attempt(() => api('DELETE', `/api/notes/${n.id}`), 'Note deleted');
  return attempt(() => (n.id ? api('PUT', `/api/notes/${n.id}`, r.data) : api('POST', '/api/notes', { ...r.data, athlete_id: athleteId })), 'Note saved');
}

export async function taskDialog(t = {}, athleteId) {
  const athletes = await api('GET', '/api/athletes');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const r = await dialog({
    title: t.id ? 'Edit task' : 'Add task',
    body: `${field('Task', 'title', t.title || '')}<div class="form-grid">${field('Athlete', 'athlete_id', t.athlete_id ?? athleteId ?? '', { type: 'select', opts: [['', 'Business-wide (no athlete)'], ...athletes.map((a) => [a.id, a.name])] })}${field('Type', 'kind', t.kind || 'task', { type: 'select', opts: [['task', 'Task'], ['call', 'Coaching call'], ['checkin', 'Check-in reminder'], ['test', 'Test reminder'], ['review', 'Plan review'], ['birthday', 'Birthday reminder'], ['follow-up', 'Follow-up'], ['goal', 'Goal expiry'], ['camp', 'Training camp'], ['travel', 'Athlete travel']] })}
    ${field('Due date', 'due_date', t.due_date || '', { type: 'date' })}${field('Time (optional)', 'due_time', t.due_time || '', { type: 'time' })}${field('Time zone', 'timezone', t.timezone || tz)}${field('Owner', 'owner', t.owner || 'Jack')}</div>${field('Notes', 'notes', t.notes || '', { type: 'textarea' })}${t.id ? field('Done', 'done', t.done, { type: 'checkbox' }) : ''}`,
    buttons: [...(t.id ? [{ label: 'Delete', value: 'delete', danger: true, left: true }] : []), { label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
    validate: (x) => (!x.title.trim() ? 'Task needs a title' : null),
  });
  if (!r) return null;
  if (r.action === 'delete') return attempt(() => api('DELETE', `/api/tasks/${t.id}`), 'Task deleted');
  const body = { ...r.data, athlete_id: r.data.athlete_id ? +r.data.athlete_id : null };
  return attempt(() => (t.id ? api('PUT', `/api/tasks/${t.id}`, body) : api('POST', '/api/tasks', body)), 'Task saved');
}

function tabNotes(el, d) {
  const a = d.athlete;
  el.innerHTML = `<div class="grid g2">
    <div class="card"><h2>Quick note</h2><form id="qn"><textarea name="body" rows="3" placeholder="What happened? Typed notes are saved with today's date."></textarea>
      <div class="row" style="margin-top:8px"><select name="kind" style="width:auto"><option value="note">Note</option><option value="check-in">Check-in</option><option value="call">Call notes</option><option value="interruption">Interruption</option><option value="follow-up">Follow-up</option></select><label class="check"><input type="checkbox" name="shareable"> Shareable</label><button class="primary right" type="submit">Save note</button></div></form></div>
    <div class="card"><h2>Tasks and reminders <button class="small primary" data-add-task>Add task</button></h2>${d.tasks.length ? d.tasks.map((t) => taskRow({ ...t, athlete_name: a.name })).join('') : '<p class="muted">No tasks.</p>'}</div>
  </div>
  <div class="card timeline" style="margin-top:16px"><h2>Athlete history <small>notes, tests, results, plan changes and interruptions</small></h2>${timelineHTML(d.timeline).replace(/<div class="list-item">/g, '<div class="list-item">')}
  </div>`;
  const notesById = new Map(d.notes.map((n) => [n.id, n]));
  el.querySelectorAll('.timeline .list-item').forEach((row, i) => {
    const t = d.timeline[i];
    if (t && t.ref === 'note') {
      const b = document.createElement('button');
      b.className = 'small link';
      b.textContent = 'Edit';
      b.onclick = () => noteDialog(a.id, notesById.get(t.id)).then((r) => r && rerender());
      row.appendChild(b);
    }
  });
  el.querySelector('#qn').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.body.value.trim()) return toast('Write a note first', true);
    await attempt(() => api('POST', '/api/notes', { athlete_id: a.id, body: f.body.value, kind: f.kind.value, shareable: f.shareable.checked }), 'Note saved');
    rerender();
  };
  el.querySelector('[data-add-task]').onclick = () => taskDialog({}, a.id).then((r) => r && rerender());
}

// ---------------- Files ----------------
function tabFiles(el, d) {
  const a = d.athlete;
  el.innerHTML = `<div class="card"><h2>Files <small>stored in your data folder and included in backups</small></h2>
    <div class="row"><input type="file" data-up multiple style="max-width:360px"><button data-photo>Upload profile photo…</button></div>
    <div style="margin-top:12px">${d.attachments.map((f) => `<div class="list-item"><div class="grow"><a href="/files/${f.id}" target="_blank" rel="noopener">${esc(f.filename)}</a> <small>${(f.size / 1024).toFixed(0)} KB · ${esc(f.created_at)}</small>${a.photo_id === f.id ? ' <span class="badge blue">Profile photo</span>' : ''}</div><a class="btn small" href="/files/${f.id}?download=1">Download</a><button class="small danger" data-del-file="${f.id}">Delete</button></div>`).join('') || '<p class="muted">No files yet. Attach lab reports, race photos or documents.</p>'}</div></div>`;
  const upload = async (file, photo = false) => api('POST', `/api/athletes/${a.id}/attachments`, file, { raw: true, headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-photo': photo ? '1' : '0' } });
  el.querySelector('[data-up]').onchange = async (e) => {
    for (const f of e.target.files) await attempt(() => upload(f));
    toast('Uploaded');
    rerender();
  };
  el.querySelector('[data-photo]').onclick = () => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = 'image/*';
    i.onchange = async () => { if (i.files[0]) { await attempt(() => upload(i.files[0], true), 'Photo updated'); rerender(); } };
    i.click();
  };
  el.querySelectorAll('[data-del-file]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog('Delete file', 'Delete this file permanently?', 'Delete', true))) return;
    await attempt(() => api('DELETE', `/api/attachments/${b.dataset.delFile}`), 'File deleted');
    rerender();
  }));
}

// ---------------- AI assist ----------------
function tabAI(el, d) {
  const a = d.athlete;
  const ai = d.proposals.filter((p) => p.origin === 'ai');
  const sections = [['goals', 'Goals and background', true], ['availability', 'Availability and constraints', true], ['training', 'Last 12 weeks of training', true], ['races', 'Races', true], ['tests', 'Tests', true], ['plan', 'Current plan', true], ['wellbeing', 'Wellbeing scores', false], ['health', 'Health notes (sensitive)', false]];
  el.innerHTML = `<div class="grid g2">
    <div class="card"><h2>1. Export a summary</h2><p><small>Nothing is sent anywhere by the app. You copy the text and paste it into ChatGPT or Claude yourself. Tick only what is needed.</small></p>
      <form id="aif">${sections.map(([k, l, on]) => `<label class="check" style="display:flex;margin-bottom:4px"><input type="checkbox" name="${k}" ${on ? 'checked' : ''}> ${l}</label>`).join('')}
      <label class="check" style="display:flex;margin-top:8px"><input type="checkbox" name="anonymise" checked> Leave out the athlete's name and age</label>
      <button type="submit" class="primary" style="margin-top:10px">Build summary</button></form>
      <textarea id="aiout" rows="14" class="mono" style="margin-top:12px" readonly placeholder="Summary appears here"></textarea>
      <button data-copy style="margin-top:8px">Copy to clipboard</button></div>
    <div class="card"><h2>2. Save the response for review</h2><p><small>Paste what the AI suggested. It is saved as an <b>AI-generated suggestion</b>, separate from calculations and your own rules, and nothing in the plan changes until you edit the plan yourself.</small></p>
      <form id="aisave">${field('Title', 'title', 'AI suggestion ' + calc.todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone))}${field('AI response', 'text', '', { type: 'textarea', rows: 10 })}<button class="primary" type="submit">Save for review</button></form>
      <h3>Saved AI suggestions</h3>${ai.map((p) => { const b = JSON.parse(p.body_json); return `<details class="list-item" style="display:block" ${p.status === 'pending' ? 'open' : ''}><summary><b>${esc(p.title)}</b> <span class="badge ${p.status === 'pending' ? 'amber' : p.status === 'rejected' ? '' : 'green'}">${p.status === 'saved' ? 'kept' : p.status}</span> <small>${esc(p.created_at)}</small></summary><pre class="brief" style="margin:8px 0">${esc(b.text)}</pre><small>${esc(b.basis)}</small>${p.status === 'pending' ? `<div class="row" style="margin-top:8px"><button class="small" data-dec="keep" data-id="${p.id}">Keep as reviewed note</button><button class="small" data-dec="reject" data-id="${p.id}">Reject</button><a class="btn small" href="#/planner/${a.id}">Open planner to make changes</a></div>` : ''}</details>`; }).join('') || '<p class="muted">None yet.</p>'}
    </div></div>`;
  el.querySelector('#aif').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const include = sections.map(([k]) => k).filter((k) => f[k].checked);
    const r = await attempt(() => api('POST', `/api/athletes/${a.id}/ai-summary`, { include, anonymise: f.anonymise.checked }));
    el.querySelector('#aiout').value = r.text;
  };
  el.querySelector('[data-copy]').onclick = () => { const t = el.querySelector('#aiout').value; if (!t) return toast('Build the summary first', true); navigator.clipboard.writeText(t).then(() => toast('Copied')); };
  el.querySelector('#aisave').onsubmit = async (e) => {
    e.preventDefault();
    await attempt(() => api('POST', `/api/athletes/${a.id}/ai-suggestion`, { title: e.target.elements.title.value, text: e.target.elements.text.value }), 'Saved for review');
    rerender();
  };
  el.querySelectorAll('[data-dec]').forEach((b) => (b.onclick = async () => { await attempt(() => api('POST', `/api/proposals/${b.dataset.id}/${b.dataset.dec}`, {}), 'Updated'); rerender(); }));
}
