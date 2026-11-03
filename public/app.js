import { api, esc, toast, attempt, dialog, confirmDialog, field, hrs, pct, cap, avatar, sampleBadge, statusBadge, sourceBadge, flagList, calc, ring, countdownParts, priDot, shortDate } from './ui.js';
import { renderAthlete, taskDialog } from './athlete.js';
import { renderPlanner, renderReview } from './planner.js';

const NAV = [
  ['overview', 'Overview', '#/', 'M3 12l9-8 9 8M5 10v10h14V10'],
  ['athletes', 'Athletes', '#/athletes', 'M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21c1-4 4-6 8-6s7 2 8 6'],
  ['review', 'Weekly Review', '#/review', 'M4 5h16v14H4zM8 3v4M16 3v4M4 10h16'],
  ['planner', 'Season Planner', '#/planner', 'M3 20h18M6 16v-5M10 16V8M14 16v-7M18 16V5'],
  ['races', 'Races', '#/races', 'M5 21V4h11l-2 4 2 4H5'],
  ['tests', 'Tests & Benchmarks', '#/tests', 'M4 18l5-6 4 3 7-9'],
  ['calendar', 'Calendar', '#/calendar', 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4'],
  ['tasks', 'Coaching Tasks', '#/tasks', 'M5 12l4 4 10-10'],
  ['settings', 'Settings', '#/settings', 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 1-2-2V3h-4v3L9 8 7 7 5 11l2 1v0l-2 1 2 4 2-1 2 2v3h4v-3l2-2 2 1 2-4z'],
];
const MOBILE = ['overview', 'athletes', 'review', 'tasks', 'settings'];

const icon = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

function renderNav(active, counts = {}) {
  document.getElementById('nav').innerHTML = `<div class="brand"><span></span>Coaching Hub</div>` + NAV.map(([k, l, h, d]) => `<a href="${h}" class="${k === active ? 'active' : ''}">${icon(d)}${l}${counts[k] ? `<span class="count">${counts[k]}</span>` : ''}</a>`).join('');
  document.getElementById('mnav').innerHTML = NAV.filter(([k]) => MOBILE.includes(k)).map(([k, l, h, d]) => `<a href="${h}" class="${k === active ? 'active' : ''}">${icon(d)}${{ review: 'Review', tasks: 'Tasks' }[k] || l.split(' ')[0]}</a>`).join('');
}

export const main = () => document.getElementById('main');

let navCounts = {};
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [page = 'overview', ...rest] = parts;
  renderNav(page, navCounts);
  window.scrollTo(0, 0);
  try {
    switch (page) {
      case 'overview': await renderOverview(); break;
      case 'athletes': rest[0] ? await renderAthlete(+rest[0], rest[1] || 'summary', rest.slice(2)) : await renderAthletes(); break;
      case 'review': await renderReview(rest[0], rest[1] ? +rest[1] : null); break;
      case 'planner': await renderPlanner(rest[0] ? +rest[0] : null); break;
      case 'races': await renderRaces(); break;
      case 'tests': await renderTests(); break;
      case 'calendar': await renderCalendar(); break;
      case 'tasks': await renderTasks(); break;
      case 'settings': await renderSettings(); break;
      case 'install': renderInstall(); break;
      default: main().innerHTML = '<div class="empty"><h2>Page not found</h2><a href="#/">Go to overview</a></div>';
    }
  } catch (e) {
    if (e.busy) return renderBusy(e.busy);
    console.error(e);
    main().innerHTML = `<div class="card notice danger"><b>Could not load this page.</b><br>${esc(e.message)}</div>`;
  }
  refreshCounts();
}
window.addEventListener('hashchange', route);
export const rerender = route;

async function refreshCounts() {
  try {
    const t = await api('GET', '/api/tasks?status=open');
    const today = calc.todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const c = { tasks: t.filter((x) => x.due_date && x.due_date < today).length };
    if (JSON.stringify(c) !== JSON.stringify(navCounts)) {
      navCounts = c;
      renderNav((location.hash.replace(/^#\/?/, '').split('/')[0]) || 'overview', navCounts);
    }
  } catch { /* counts are optional */ }
}

// ---------------- Overview ----------------
async function renderOverview() {
  const [o, ai] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/autoimport').catch(() => ({ log: [] }))]);
  const weekAgo = Date.now() - 7 * 864e5;
  const recentImports = (ai.log || []).filter((e) => Date.parse(e.at) > weekAgo);
  const failedImports = recentImports.filter((e) => !e.ok);
  if (!o.counts.active) {
    main().innerHTML = `<div class="page-head"><div><h1>Overview</h1><small>${esc(o.today)}</small></div></div>
      <div class="card empty"><h2>Welcome to Coaching Hub</h2><p>Add your first athlete to get started. Everything is saved on this Mac.</p>
      <div class="row" style="justify-content:center"><button class="primary" data-add>Add athlete</button><button data-sample>Load fictional sample athletes</button></div>
      <p><small>Sample athletes are clearly labelled and can be removed in Settings.</small></p></div>`;
    main().querySelector('[data-add]').onclick = addAthlete;
    main().querySelector('[data-sample]').onclick = () => attempt(() => api('POST', '/api/sample/load'), 'Sample athletes loaded').then(route);
    return;
  }
  const att = o.attention;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const todayLong = new Date(o.today + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const overdue = o.tasks.filter((t) => t.due_date && t.due_date < o.today).length;
  const revPct = o.review.total ? o.review.reviewed / o.review.total : 0;
  const high = (a) => a.flags.some((f) => f.severity === 'high');
  main().innerHTML = `
  <div class="page-head"><div><div class="eyebrow">${esc(todayLong)}</div><h1>${greet}</h1><small>${o.counts.active} active athletes${o.counts.sample ? ` · ${o.counts.sample} sample` : ''}</small></div>
    <div class="row"><button data-note>Quick note</button><button data-task>Add task</button><a class="btn primary" href="#/review">Start weekly review</a></div></div>
  <div class="tiles">
    <div class="tile ${att.length ? 'warn' : 'good'}"><div class="eyebrow">Need attention</div><div class="stat">${att.length}</div><div class="stat-label">${att.length === 1 ? 'athlete' : 'athletes'}</div></div>
    <a class="tile ring-tile" href="#/review">${ring(revPct, { size: 76, stroke: 8, label: `${o.review.reviewed}/${o.review.total}`, color: 'var(--accent)' })}<div><div class="eyebrow" style="margin-bottom:4px">Reviews</div><div class="stat-label" style="margin:0">week of ${esc(shortDate(o.review.week))}</div></div></a>
    <a class="tile" href="#/races"><div class="eyebrow">Races</div><div class="stat">${o.races.length}</div><div class="stat-label">in the next 8 weeks</div></a>
    <a class="tile ${overdue ? 'bad' : ''}" href="#/tasks"><div class="eyebrow">Overdue</div><div class="stat">${overdue}</div><div class="stat-label">${overdue === 1 ? 'task' : 'tasks'}</div></a>
  </div>
  ${recentImports.length ? `<div class="card" style="margin-bottom:20px${failedImports.length ? ';box-shadow:inset 0 0 0 2px var(--warn)' : ''}"><h2>Imports this week <small>${recentImports.length - failedImports.length} imported${failedImports.length ? `, ${failedImports.length} need attention` : ''}</small></h2>${importLogHTML(recentImports, 5)}</div>` : ''}
  <div class="grid g2">
    <div class="card" id="attention"><h2>Needs attention</h2>${att.length ? att.map((a) => `<div class="alert-row">${avatar(a)}<div class="what"><a href="#/athletes/${a.id}" style="color:inherit"><b>${esc(a.preferred_name || a.name)}${sampleBadge(a)}</b></a><span>${esc(a.flags[0]?.message || '')}</span>${a.flags.length ? `<details class="more"><summary>${a.flags.length === 1 ? 'What to do' : `See all ${a.flags.length}`}</summary><div class="flags-compact">${flagList(a.flags)}</div></details>` : ''}</div><span class="badge ${high(a) ? 'red' : 'amber'}">${a.flags.length}</span></div>`).join('') : '<p class="muted"><span class="ok-mark">✓</span> All clear. Every active athlete is up to date.</p>'}</div>
    <div class="grid" style="align-content:start">
      <div class="card"><h2>Coming up <a class="btn small" href="#/races">All races</a></h2>${o.races.length ? o.races.map((r) => { const c = countdownParts(r.countdown); return `<div class="race-row"><div class="count"><b>${c.n}</b><small class="muted">${c.u}</small></div><div class="grow"><b>${esc(r.name)}</b><br><small><a href="#/athletes/${r.athlete_id}/races">${esc(r.preferred_name || r.athlete_name)}</a> · ${esc(shortDate(r.date))}</small></div>${priDot(r.priority)}</div>`; }).join('') : '<p class="muted">No races in the next 8 weeks.</p>'}
      ${o.birthdays.length ? o.birthdays.map((b) => `<div class="race-row"><div class="count"><b>${b.inDays}</b><small class="muted">${b.inDays === 1 ? 'day' : 'days'}</small></div><div class="grow">🎂 <a href="#/athletes/${b.id}">${esc(b.name)}</a>'s birthday<br><small>${esc(shortDate(b.date))}</small></div></div>`).join('') : ''}</div>
      <div class="card"><h2>To do <a class="btn small" href="#/tasks">All tasks</a></h2>${o.tasks.length ? o.tasks.map(taskRow).join('') : '<p class="muted">Nothing due this week.</p>'}</div>
    </div>
  </div>
  <div class="section-title"><span>Last week <small class="muted">planned vs done</small></span><small class="muted">week of ${esc(shortDate(o.review.week))}</small></div>
  <div class="card"><div class="week-grid">
    ${o.compare.map((c) => `<div class="week-cell" data-go="#/review/${o.review.week}/${c.id}">${ring(c.last?.compliance ?? null, { size: 84, stroke: 8 })}<b>${esc(c.name)}</b><small class="muted">${c.last?.completedHours != null ? `${hrs(c.last.completedHours)} of ${hrs(c.last?.plannedHours)}` : 'No data'}</small></div>`).join('')}
  </div></div>`;
  wireCommon();
  main().querySelector('[data-note]').onclick = quickNote;
  main().querySelector('[data-task]').onclick = () => taskDialog({}).then((r) => r && route());
}

export function taskRow(t) {
  const today = calc.todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const overdue = !t.done && t.due_date && t.due_date < today;
  return `<div class="list-item"><input type="checkbox" data-done="${t.id}" ${t.done ? 'checked' : ''} aria-label="Mark done" style="margin-top:4px"><div class="grow"><span ${t.done ? 'style="text-decoration:line-through;color:var(--muted)"' : ''}>${esc(t.title)}</span> <span class="badge">${esc(t.kind)}</span><br><small>${t.athlete_id ? `<a href="#/athletes/${t.athlete_id}/notes">${esc(t.athlete_name || '')}</a> · ` : 'Business · '}${t.due_date ? `<span style="${overdue ? 'color:var(--danger);font-weight:600' : ''}">${overdue ? 'Overdue · ' : 'Due '}${esc(shortDate(t.due_date))}${t.due_time ? ' ' + esc(t.due_time) : ''}</span>` : 'No date'}${t.owner && t.owner !== 'Jack' ? ' · ' + esc(t.owner) : ''}</small></div><button class="small link" data-edit-task="${t.id}">Edit</button></div>`;
}

// Delegated handlers shared by several pages.
export function wireCommon(root = main()) {
  root.querySelectorAll('[data-go]').forEach((el) => (el.onclick = (e) => { if (!e.target.closest('a,button,input')) location.hash = el.dataset.go; }));
  root.querySelectorAll('[data-done]').forEach((el) => (el.onchange = () => attempt(() => api('PUT', `/api/tasks/${el.dataset.done}`, { done: el.checked }), el.checked ? 'Task done' : 'Task reopened').then(route)));
  root.querySelectorAll('[data-edit-task]').forEach((el) => (el.onclick = async () => {
    const all = await api('GET', '/api/tasks?status=all');
    const t = all.find((x) => x.id === +el.dataset.editTask);
    if (await taskDialog(t)) route();
  }));
}

async function quickNote() {
  const athletes = await api('GET', '/api/athletes');
  const r = await dialog({
    title: 'Quick note',
    body: field('Athlete', 'athlete_id', '', { type: 'select', opts: athletes.filter((a) => a.status !== 'former').map((a) => [a.id, a.name]) }) + field('Type', 'kind', 'note', { type: 'select', opts: [['note', 'Note'], ['check-in', 'Check-in'], ['call', 'Call notes'], ['interruption', 'Interruption (illness, injury, travel)'], ['follow-up', 'Follow-up']] }) + field('Note', 'body', '', { type: 'textarea', rows: 5 }) + field('Shareable with athlete', 'shareable', false, { type: 'checkbox', help: 'Private coach notes stay unticked.' }),
    validate: (d) => (!d.body.trim() ? 'Write a note first' : null),
  });
  if (!r) return;
  await attempt(() => api('POST', '/api/notes', { ...r.data, athlete_id: +r.data.athlete_id }), 'Note saved');
}

// ---------------- Athletes ----------------
let listState = { q: '', sport: '', status: 'active', phase: '', review: '', view: 'cards', sort: 'name', dir: 1 };
try { Object.assign(listState, JSON.parse(localStorage.getItem('athleteList') || '{}')); } catch { /* ignore */ }

export async function addAthlete() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const r = await dialog({
    title: 'Add athlete',
    body: `<div class="form-grid">${field('Full name', 'name')}${field('Preferred name', 'preferred_name')}${field('Main sport', 'sport', 'triathlon', { type: 'select', opts: [['triathlon', 'Triathlon'], ['run', 'Running'], ['bike', 'Cycling'], ['other', 'Other']] })}${field('Coaching start date', 'start_date', calc.todayIn(tz), { type: 'date' })}${field('Time zone', 'timezone', tz)}${field('Status', 'status', 'active', { type: 'select', opts: ['active', 'paused', 'former'] })}${field('Main goals', 'goals', '', { type: 'textarea', wide: true })}</div><small>You can fill in background, availability and health details on the profile next.</small>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add and open profile', value: 'save', primary: true }],
    validate: (d) => (!d.name.trim() ? 'Name is required' : null),
  });
  if (!r) return;
  const a = await attempt(() => api('POST', '/api/athletes', r.data), 'Athlete added');
  location.hash = `#/athletes/${a.id}/profile`;
}

async function renderAthletes() {
  const [list, settings] = await Promise.all([api('GET', '/api/athletes'), api('GET', '/api/settings')]);
  const phases = [...new Set(list.map((a) => a.phase).filter(Boolean))];
  const draw = () => {
    try { localStorage.setItem('athleteList', JSON.stringify(listState)); } catch { /* per-browser convenience only */ }
    const s = listState;
    let rows = list.filter((a) => (!s.q || `${a.name} ${a.preferred_name || ''} ${a.goals || ''}`.toLowerCase().includes(s.q.toLowerCase())) && (!s.sport || a.sport === s.sport) && (!s.status || a.status === s.status) && (!s.phase || a.phase === s.phase) && (!s.review || (s.review === 'flagged' ? a.flags.length : a.flags.some((f) => f.type === s.review))));
    const key = { name: (a) => a.name.toLowerCase(), start: (a) => a.start_date || '', race: (a) => a.nextRace?.date || '9999', flags: (a) => -a.flags.length, checkin: (a) => a.lastCheckin || '' }[s.sort];
    rows.sort((x, y) => (key(x) < key(y) ? -s.dir : key(x) > key(y) ? s.dir : 0));
    const th = (k, l) => `<th class="sortable" data-sort="${k}">${l}${s.sort === k ? (s.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
    const body = !list.length
      ? `<div class="card empty"><h2>No athletes yet</h2><p>Add an athlete, or load fictional sample athletes to explore.</p><div class="row" style="justify-content:center"><button class="primary" data-add>Add athlete</button><button data-sample>Load sample athletes</button></div></div>`
      : !rows.length
        ? `<div class="card empty"><h2>No athletes match these filters</h2><button data-clear>Clear filters</button></div>`
        : s.view === 'table'
          ? `<div class="card flush"><div class="table-wrap"><table><thead><tr>${th('name', 'Athlete')}<th>Sport / goal</th>${th('start', 'With you')}<th>Status</th>${th('race', 'Next priority race')}<th>Phase</th><th>Last week</th>${th('checkin', 'Last check-in')}<th class="hide-mobile">Last tests</th>${th('flags', 'Attention')}</tr></thead><tbody>${rows.map(rowHTML).join('')}</tbody></table></div></div>`
          : `<div class="cards">${rows.map(cardHTML).join('')}</div>`;
    main().innerHTML = `<div class="page-head"><div><h1>Athletes</h1><small>${list.filter((a) => a.status === 'active').length} active · ${list.length} total</small></div><button class="primary" data-add>Add athlete</button></div>
    <div class="toolbar">
      <input type="search" placeholder="Search name or goal" value="${esc(s.q)}" data-f="q">
      <select data-f="sport"><option value="">All sports</option>${['triathlon', 'run', 'bike', 'other'].map((x) => `<option ${s.sport === x ? 'selected' : ''} value="${x}">${cap(x)}</option>`).join('')}</select>
      <select data-f="status"><option value="">Any status</option>${['active', 'paused', 'former'].map((x) => `<option ${s.status === x ? 'selected' : ''} value="${x}">${cap(x)}</option>`).join('')}</select>
      <select data-f="phase"><option value="">Any phase</option>${phases.map((x) => `<option ${s.phase === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
      <select data-f="review"><option value="">Any review need</option>${[['flagged', 'Any flag'], ['checkin', 'Check-in due'], ['review', 'Plan review due'], ['test', 'Test due'], ['wellbeing', 'Wellbeing'], ['compliance', 'Low completion'], ['data', 'Missing data']].map(([v, l]) => `<option ${s.review === v ? 'selected' : ''} value="${v}">${l}</option>`).join('')}</select>
      <span class="seg"><button class="${s.view === 'table' ? 'on' : ''}" data-view="table">Table</button><button class="${s.view === 'cards' ? 'on' : ''}" data-view="cards">Cards</button></span>
      <select data-saved><option value="">Saved views…</option>${settings.saved_views.map((v, i) => `<option value="${i}">${esc(v.name)}</option>`).join('')}<option value="save">+ Save current view</option>${settings.saved_views.length ? '<option value="delete">− Delete a saved view</option>' : ''}</select>
    </div>${body}`;
    main().querySelectorAll('[data-f]').forEach((el) => (el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => {
      s[el.dataset.f] = el.value;
      const pos = el.selectionStart;
      draw();
      if (el.tagName === 'INPUT') { const n = main().querySelector('[data-f=q]'); n.focus(); n.setSelectionRange(pos, pos); }
    }));
    main().querySelectorAll('[data-view]').forEach((el) => (el.onclick = () => { s.view = el.dataset.view; draw(); }));
    main().querySelectorAll('[data-sort]').forEach((el) => (el.onclick = () => { s.dir = s.sort === el.dataset.sort ? -s.dir : 1; s.sort = el.dataset.sort; draw(); }));
    main().querySelectorAll('[data-add]').forEach((el) => (el.onclick = addAthlete));
    main().querySelector('[data-sample]')?.addEventListener('click', () => attempt(() => api('POST', '/api/sample/load'), 'Sample athletes loaded').then(route));
    main().querySelector('[data-clear]')?.addEventListener('click', () => { Object.assign(s, { q: '', sport: '', status: '', phase: '', review: '' }); draw(); });
    main().querySelector('[data-saved]').onchange = async (e) => {
      const v = e.target.value;
      if (v === 'save') {
        const r = await dialog({ title: 'Save view', body: field('Name', 'name', '') });
        if (r && r.data.name) { settings.saved_views.push({ name: r.data.name, filters: { ...s } }); await attempt(() => api('PUT', '/api/settings', { saved_views: settings.saved_views }), 'View saved'); }
      } else if (v === 'delete') {
        const r = await dialog({ title: 'Delete saved view', body: field('View', 'i', '', { type: 'select', opts: settings.saved_views.map((x, i) => [i, x.name]) }), buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'd', primary: true }] });
        if (r) { settings.saved_views.splice(+r.data.i, 1); await api('PUT', '/api/settings', { saved_views: settings.saved_views }); }
      } else if (v !== '') Object.assign(s, settings.saved_views[+v].filters);
      draw();
    };
    wireCommon();
  };
  draw();
}

function lastTests(a) {
  return ['swim', 'bike', 'run'].filter((d) => a.lastTest[d] || a.sport === 'triathlon' || a.sport === d).map((d) => `${d[0].toUpperCase()}: ${a.lastTest[d] ? a.lastTest[d].slice(2) : '—'}`).join('<br>');
}

function rowHTML(a) {
  const lw = a.lastWeek;
  return `<tr class="clickable" data-go="#/athletes/${a.id}"><td><div class="name-cell">${avatar(a)}<div><b>${esc(a.name)}</b>${sampleBadge(a)}${a.billing === 'free' ? ' <span class="badge">Free</span>' : ''}<br><small>${esc(a.preferred_name || '')}</small></div></div></td>
  <td>${esc(cap(a.sport))}<br><small>${esc((a.goals || '').slice(0, 60))}</small></td>
  <td>${a.coaching ? esc(a.coaching.label) : '—'}<br><small>since ${esc(a.start_date || '?')}</small></td>
  <td>${statusBadge(a.status)}</td>
  <td>${a.nextRace ? `<b>${esc(a.nextRace.name)}</b> <span class="badge">${a.nextRace.priority}</span><br><small>${esc(a.nextRace.countdown.label)}</small>` : '<small class="muted">None planned</small>'}</td>
  <td>${esc(a.phase || '—')}</td>
  <td>${lw && lw.completedHours != null ? `${hrs(lw.completedHours)}<br><small>of ${hrs(lw.plannedHours)} planned</small>` : sourceBadge('missing')}</td>
  <td>${esc(a.lastCheckin || '—')}</td>
  <td class="hide-mobile"><small>${lastTests(a)}</small></td>
  <td>${a.flags.length ? `<span class="badge ${a.flags.some((f) => f.severity === 'high') ? 'red' : 'amber'}" title="${esc(a.flags.map((f) => '• ' + f.message).join('\n'))}">${a.flags.length} flag${a.flags.length > 1 ? 's' : ''}</span><br><small>${esc(a.flags[0].message.slice(0, 70))}${a.flags[0].message.length > 70 ? '…' : ''}</small>` : '<span class="badge green">OK</span>'}</td></tr>`;
}

function cardHTML(a) {
  const lw = a.lastWeek;
  const has = lw && lw.completedHours != null;
  const c = a.nextRace ? countdownParts(a.nextRace.countdown) : null;
  const flags = a.flags.length;
  return `<div class="card ath-card" data-go="#/athletes/${a.id}">
  <div class="top">${avatar(a)}<div class="grow"><b>${esc(a.preferred_name || a.name)}</b>${sampleBadge(a)}<br><small>${esc(a.phase || cap(a.sport))}</small></div>${flags ? `<span class="badge ${a.flags.some((f) => f.severity === 'high') ? 'red' : 'amber'}" title="${esc(a.flags.map((f) => '• ' + f.message).join('\n'))}">${flags} ${flags === 1 ? 'flag' : 'flags'}</span>` : '<span class="ok-mark" title="Nothing flagged">✓</span>'}</div>
  <div class="mid">${ring(has ? lw.compliance : null, { size: 64, stroke: 7 })}<div class="grow"><div class="eyebrow" style="font-size:.68rem">Last week</div><b style="font-size:1.15rem">${has ? hrs(lw.completedHours) : 'No data'}</b><small class="muted">${has ? `of ${hrs(lw.plannedHours)} planned` : ''}</small></div>
    ${c ? `<div style="text-align:right"><div class="eyebrow" style="font-size:.68rem">${esc(a.nextRace.priority)} race</div><b style="font-size:1.6rem;letter-spacing:-.04em;line-height:1">${c.n}</b> <small class="muted">${c.u}</small></div>` : ''}</div>
  <div class="foot">${a.nextRace ? `<span>🏁 ${esc(a.nextRace.name)}</span>` : '<span>No race planned</span>'}${a.billing === 'free' ? '<span class="badge right">Free</span>' : ''}${a.status !== 'active' ? statusBadge(a.status) : ''}</div></div>`;
}

// ---------------- Races ----------------
async function renderRaces() {
  const races = await api('GET', '/api/races');
  const today = calc.todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const up = races.filter((r) => r.date >= today && r.status === 'planned');
  const past = races.filter((r) => !(r.date >= today && r.status === 'planned')).reverse();
  const tbl = (rs, isUp) => rs.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Race</th><th>Athlete</th><th>Pri.</th><th>Distance</th><th>${isUp ? 'Countdown' : 'Result'}</th></tr></thead><tbody>${rs.map((r) => `<tr class="clickable" data-go="#/athletes/${r.athlete_id}/races"><td>${esc(r.date)}</td><td><b>${esc(r.name)}</b><br><small>${esc(r.location || '')}</small></td><td>${esc(r.athlete_name)}${sampleBadge(r)}</td><td><span class="badge ${r.priority === 'A' ? 'red' : r.priority === 'B' ? 'amber' : ''}">${r.priority}</span></td><td>${esc(r.distance || r.sport || '')}</td><td>${isUp ? esc(calc.raceCountdown(r.date, today).label) : `${r.status !== 'completed' ? `<span class="badge">${esc(r.status)}</span> ` : ''}${esc(r.result || '')}`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="padding:0 16px 16px">None.</p>';
  main().innerHTML = `<div class="page-head"><div><h1>Races</h1><small>Add races from an athlete's Races tab.</small></div></div>
  <div class="card flush" style="margin-bottom:16px"><div style="padding:16px 16px 0"><h2>Upcoming</h2></div>${tbl(up, true)}</div>
  <div class="card flush"><div style="padding:16px 16px 0"><h2>Past and results</h2></div>${tbl(past, false)}</div>`;
  wireCommon();
}

// ---------------- Tests ----------------
async function renderTests() {
  const [athletes, tests] = await Promise.all([api('GET', '/api/athletes'), api('GET', '/api/tests')]);
  const active = athletes.filter((a) => a.status !== 'former');
  const full = await Promise.all(active.map((a) => api('GET', `/api/athletes/${a.id}`)));
  main().innerHTML = `<div class="page-head"><div><h1>Tests & Benchmarks</h1><small>Testing windows follow each athlete's own frequency and move away from priority races. Nothing is scheduled automatically.</small></div></div>
  <div class="card flush" style="margin-bottom:16px"><div class="table-wrap"><table><thead><tr><th>Athlete</th><th>Swim</th><th>Bike</th><th>Run</th><th>Current thresholds</th></tr></thead><tbody>
  ${full.map((f) => `<tr class="clickable" data-go="#/athletes/${f.athlete.id}/tests"><td><b>${esc(f.athlete.name)}</b>${sampleBadge(f.athlete)}</td>${['swim', 'bike', 'run'].map((d) => { const w = f.derived.testWindows[d]; return `<td>${f.derived.lastTest[d] ? `Last ${esc(f.derived.lastTest[d])}` : '<small>Never tested</small>'}<br><small><span class="badge ${w.status === 'overdue' ? 'red' : w.status === 'due' ? 'amber' : ''}">${esc(w.status)}</span> ${w.from ? esc(w.from) + ' → ' + esc(w.to) : ''}</small></td>`; }).join('')}<td><small>${Object.entries(f.thresholds).map(([k, v]) => `${esc(k)} ${v.value} ${esc(v.unit)} <span class="muted">from ${esc(v.from)}</span>`).join('<br>') || '—'}</small></td></tr>`).join('')}
  </tbody></table></div></div>
  <div class="card flush"><div style="padding:16px 16px 0"><h2>All test records</h2></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Athlete</th><th>Discipline</th><th>Test</th><th>Raw</th><th>Derived</th><th>Zones</th></tr></thead><tbody>
  ${tests.map((t) => `<tr class="clickable" data-go="#/athletes/${t.athlete_id}/tests"><td>${esc(t.date)}</td><td>${esc(t.athlete_name)}</td><td>${esc(cap(t.discipline))}</td><td>${esc(t.test_type)}</td><td>${esc(t.raw_summary || '')}</td><td>${t.derived_value != null ? `${esc(t.derived_metric)} ${t.derived_value} ${esc(t.derived_unit)}` : '—'}</td><td>${t.accepted ? `<span class="badge green">Accepted from ${esc(t.effective_from || t.date)}</span>` : '<span class="badge">Not used</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No tests recorded yet.</td></tr>'}
  </tbody></table></div></div>`;
  wireCommon();
}

// ---------------- Tasks ----------------
let taskFilter = 'open';
async function renderTasks() {
  const tasks = await api('GET', `/api/tasks?status=${taskFilter}`);
  const groups = {};
  const today = calc.todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const weekEnd = calc.addDays(calc.weekStart(today), 6);
  for (const t of tasks) {
    const g = t.done ? 'Done' : !t.due_date ? 'No date' : t.due_date < today ? 'Overdue' : t.due_date <= weekEnd ? 'This week' : 'Later';
    (groups[g] = groups[g] || []).push(t);
  }
  main().innerHTML = `<div class="page-head"><div><h1>Coaching Tasks</h1><small>Athlete and business tasks, check-ins, test and review reminders.</small></div><button class="primary" data-add>Add task</button></div>
  <div class="toolbar"><span class="seg">${['open', 'done', 'all'].map((f) => `<button data-tf="${f}" class="${taskFilter === f ? 'on' : ''}">${cap(f)}</button>`).join('')}</span></div>
  ${tasks.length ? ['Overdue', 'This week', 'Later', 'No date', 'Done'].filter((g) => groups[g]).map((g) => `<div class="card" style="margin-bottom:14px"><h2>${g} <small>${groups[g].length}</small></h2>${groups[g].map(taskRow).join('')}</div>`).join('') : `<div class="card empty"><h2>${taskFilter === 'open' ? 'All clear' : 'No tasks'}</h2><p>Add a task, or create one from an attention flag on an athlete's profile.</p></div>`}`;
  main().querySelector('[data-add]').onclick = () => taskDialog({}).then((r) => r && route());
  main().querySelectorAll('[data-tf]').forEach((b) => (b.onclick = () => { taskFilter = b.dataset.tf; route(); }));
  wireCommon();
}

// ---------------- Install as an app (own window and Dock icon) ----------------
let installPrompt = null;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (location.hash.startsWith('#/install')) renderInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (location.hash.startsWith('#/install')) renderInstall(true);
});

function renderInstall(justInstalled = false) {
  const box = (inner) => `<div class="card" style="max-width:600px;margin:40px auto">${inner}</div>`;
  if (justInstalled || standalone()) {
    main().innerHTML = box(`<h1>Coaching Hub is installed</h1>
      <p>It now has its own window and its own icon in the Dock.</p>
      <p><b>Last step:</b> right-click the Coaching Hub icon in your Dock, choose <b>Options</b>, then <b>Keep in Dock</b>. From now on, click that icon to open it.</p>
      <p><small>You can close this browser tab.</small></p>`);
    return;
  }
  main().innerHTML = box(`<h1>Make Coaching Hub an app</h1>
    <p>One click gives Coaching Hub its own window and its own icon in the Dock, like any other app.</p>
    ${installPrompt
      ? '<p><button class="primary" data-install style="font-size:16px;padding:10px 18px">Install Coaching Hub</button></p><p><small>Chrome asks you to confirm. Click Install.</small></p>'
      : '<p>Click the <b>install icon</b> at the right-hand end of the address bar (a little screen with a down arrow), then click <b>Install</b>.</p><p><small>Can\'t see it? Open Chrome\'s ⋮ menu → <b>Cast, save and share</b> → <b>Install page as app</b>.</small></p>'}
    <p style="margin-top:18px"><a href="#/">Skip for now</a></p>`);
  const b = main().querySelector('[data-install]');
  if (b) b.onclick = async () => {
    installPrompt.prompt();
    const r = await installPrompt.userChoice;
    if (r.outcome === 'accepted') renderInstall(true);
  };
}

// ---------------- Shared data in use on another Mac ----------------
function renderBusy(b) {
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(b.since)) / 60000));
  main().innerHTML = `<div class="card" style="max-width:560px;margin:40px auto"><h1>Coaching Hub is open on ${esc(b.name)}</h1>
    <p>Your data is shared between your Macs through iCloud Drive. To keep it safe, it can only be used on one Mac at a time. ${esc(b.name)} has been using it for about ${mins} minute${mins === 1 ? '' : 's'}.</p>
    <p><b>Close Coaching Hub on ${esc(b.name)}</b>, wait a minute for iCloud to catch up, then click Try again. It also lets go by itself 15 minutes after you last used it there.</p>
    <div class="row"><button class="primary" data-retry>Try again</button><button data-anyway>Open here anyway</button></div></div>`;
  main().querySelector('[data-retry]').onclick = () => route();
  main().querySelector('[data-anyway]').onclick = async () => {
    if (!(await confirmDialog('Open here anyway?', `Only do this if ${b.name} is switched off or you have finished there. Anything changed on ${b.name} in the last minute or two may not have reached iCloud yet.`, 'Open here', true))) return;
    await attempt(() => api('POST', '/api/location/open-anyway')).catch(() => {});
    route();
  };
}

// ---------------- Calendar ----------------
function googleCard(g) {
  const res = g.lastResult;
  const status = g.enabled
    ? `<span class="badge green">On</span> Syncing ${g.count} events to your <b>${esc(g.calendarName)}</b> Google calendar. It updates about 20 seconds after you change something, and every hour while Coaching Hub is open.`
    : g.url ? `<span class="badge amber">Connected, not switched on</span> Nothing has been sent to Google yet.` : `<span class="badge">Off</span> Nothing is sent to Google until you set this up and switch it on.`;
  const last = g.lastSync ? `<p><small>Last sync ${esc(new Date(g.lastSync).toLocaleString())}${res ? `: ${res.created} added, ${res.updated} updated, ${res.deleted} removed, ${res.unchanged} unchanged` : ''}.</small></p>` : '';
  const err = g.lastError ? `<div class="notice" style="border-color:var(--danger)"><b>Last sync failed:</b> ${esc(g.lastError)}</div>` : '';
  const steps = g.url ? '' : `<ol class="steps">
      <li><button type="button" data-gcopy>Copy the sync script</button></li>
      <li>Open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a>, signed in as the Google account Notion Calendar uses. Select everything in the editor, paste, then press <kbd>⌘S</kbd> to save.</li>
      <li>Click <b>Deploy</b> → <b>New deployment</b>. Click the cog next to "Select type" and choose <b>Web app</b>. Set <b>Execute as: Me</b> and <b>Who has access: Anyone</b>, then click <b>Deploy</b>.</li>
      <li>Google asks you to authorise it. Choose your account. If it says "Google hasn't verified this app", click <b>Advanced</b> → <b>Go to … (unsafe)</b>. It's your own script, so this is expected. Then click <b>Allow</b>.</li>
      <li>Copy the <b>Web app URL</b> and paste it here:
        <div class="row" style="margin-top:6px"><input id="gurl" class="mono" placeholder="https://script.google.com/macros/s/…/exec"><button class="primary" type="button" data-gconnect>Connect</button></div></li>
    </ol>
    <small>The script runs in your own Google account. It only writes to a calendar called "${esc(g.calendarName)}" (it creates it if needed), and only touches events Coaching Hub made. The link contains a private key, so keep it to yourself.</small>`;
  const actions = g.url ? `<div class="row" style="margin-top:8px">${g.enabled
    ? `<button class="primary" type="button" data-gsync>Sync now</button><button type="button" data-genable="0">Switch off</button>`
    : `<button class="primary" type="button" data-genable="1">Switch on and send ${g.count} events</button>`}<button type="button" class="link right" data-gdisconnect>Disconnect</button></div>
    <small>Check the event list below first. That is exactly what goes to Google. Workouts are never sent${g.skipped.length ? `, and repeating birthdays stay in the Apple feed only` : ''}.</small>` : '';
  return `<div class="card" style="margin-bottom:16px"><h2>Google Calendar sync <small>shows in Notion Calendar</small></h2>
    <p>${status}</p>${last}${err}${steps}${actions}</div>`;
}

function wireGoogle(g) {
  const m = main();
  const q = (sel) => m.querySelector(sel);
  if (q('[data-gcopy]')) q('[data-gcopy]').onclick = () => navigator.clipboard.writeText(g.script).then(() => toast('Script copied. Now open script.google.com'));
  if (q('[data-gconnect]')) q('[data-gconnect]').onclick = async () => {
    const r = await attempt(() => api('POST', '/api/gsync/connect', { url: q('#gurl').value }), 'Connected. Check the events below, then switch it on.').catch(() => null);
    if (r) route();
  };
  m.querySelectorAll('[data-genable]').forEach((b) => (b.onclick = async () => {
    const on = b.dataset.genable === '1';
    if (on && !(await confirmDialog('Switch on Google Calendar sync', `Send ${g.count} events to your "${g.calendarName}" Google calendar? You can switch it off at any time.`, 'Switch on'))) return;
    b.disabled = true;
    await attempt(() => api('POST', '/api/gsync/enable', { enabled: on }), on ? 'Google Calendar sync is on' : 'Google Calendar sync is off').catch(() => {});
    route();
  }));
  if (q('[data-gsync]')) q('[data-gsync]').onclick = async (e) => {
    e.target.disabled = true;
    await attempt(() => api('POST', '/api/gsync/sync'), 'Synced').catch(() => {});
    route();
  };
  if (q('[data-gdisconnect]')) q('[data-gdisconnect]').onclick = async () => {
    if (!(await confirmDialog('Disconnect Google Calendar sync', 'Events already in your Coaching calendar stay there until you delete that calendar in Google.', 'Disconnect'))) return;
    await attempt(() => api('POST', '/api/gsync/disconnect'), 'Disconnected');
    route();
  };
}

async function renderCalendar() {
  const [c, athletes, g] = await Promise.all([api('GET', '/api/calendar'), api('GET', '/api/athletes'), api('GET', '/api/gsync')]);
  const s = c.settings;
  const feed = `http://localhost:${location.port || c.port}/calendar.ics?key=${s.key}`;
  const byMonth = {};
  const today = calc.todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  for (const e of c.events.filter((e) => (e.endDate || e.date) >= today || e.rrule)) (byMonth[e.date.slice(0, 7)] = byMonth[e.date.slice(0, 7)] || []).push(e);
  const cats = [['races', 'Races'], ['calls', 'Coaching calls'], ['tests', 'Testing windows'], ['reviews', 'Plan reviews'], ['camps', 'Training camps'], ['travel', 'Athlete travel'], ['birthdays', 'Birthdays (private, all-day)']];
  main().innerHTML = `<div class="page-head"><div><h1>Calendar</h1><small>One-way: the app publishes a coaching calendar; it never reads or edits your other calendars.</small></div></div>
  ${googleCard(g)}
  <div class="grid g2">
    <div class="card"><h2>Subscribe from Apple Calendar</h2>
      <div class="notice"><b>Recommended (Apple Calendar on this Mac):</b> File → New Calendar Subscription, paste the link below, set Location to "On My Mac" or iCloud and Auto-refresh to every 15 minutes or hourly. It refreshes only while Coaching Hub is running on this Mac. Use the login item in the README to keep it running in the background.</div>
      <label>Subscription link (private, keep it to yourself)</label>
      <div class="row"><input readonly value="${esc(feed)}" class="mono" id="feed"><button data-copy>Copy</button></div>
      <p class="row"><a class="btn" href="${esc(feed)}&download=1">Download .ics file</a><small>One-off import for Google Calendar or Outlook. Re-importing updates events with the same IDs in most apps, but Google can create duplicates.</small></p>
      <details><summary>Other providers and limitations</summary><ul>
        <li><b>Google Calendar</b> cannot subscribe to a link on your Mac (it fetches from Google's servers). Use Google Calendar sync at the top of this page instead.</li>
        <li><b>Notion Calendar</b> shows calendars from your Google or iCloud account. Subscribe in that underlying account (Apple Calendar for iCloud), and it appears in Notion Calendar.</li>
        <li><b>Refresh:</b> calendar apps poll the link on their own schedule (Apple: as often as every 5 minutes; others hourly or slower).</li>
        <li><b>Event IDs</b> are stable per record (for example <span class="mono">race-12@coaching-hub.local</span>), so edits update existing events and deleted records disappear on the next refresh.</li>
        <li><b>Times</b> for calls are stored with the athlete's time zone and published in UTC, so daylight-saving changes are handled.</li></ul></details>
    </div>
    <div class="card"><h2>What to publish</h2><form id="calform">
      ${cats.map(([k, l]) => `<label class="check" style="display:flex;margin-bottom:6px"><input type="checkbox" name="categories.${k}" ${s.categories[k] ? 'checked' : ''}> ${l}</label>`).join('')}
      <div class="form-grid" style="margin-top:10px">${field('Athlete names in titles', 'names', s.names, { type: 'select', opts: [['initials', 'Initials only (M.O.)'], ['first', 'First name'], ['none', 'No name']] })}${field('Reminder (minutes before)', 'alarmMinutes', s.alarmMinutes ?? '', { type: 'number', help: 'Leave empty for no reminder' })}</div>
      ${field('Athletes', 'athletesMode', Array.isArray(s.athletes) ? 'some' : 'all', { type: 'select', opts: [['all', 'All active and paused athletes'], ['some', 'Only selected athletes']] })}
      <div id="athsel" style="${Array.isArray(s.athletes) ? '' : 'display:none'}">${athletes.filter((a) => !a.is_sample && a.status !== 'former').map((a) => `<label class="check"><input type="checkbox" name="ath.${a.id}" ${Array.isArray(s.athletes) && s.athletes.includes(a.id) ? 'checked' : ''}> ${esc(a.name)}</label>`).join('') || '<small>No real athletes yet. Sample athletes are never published.</small>'}</div>
      <button class="primary" type="submit" style="margin-top:8px">Save calendar settings</button></form>
      <small>Workouts are never published. Titles contain only the event type and the name format chosen above.</small>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Preview of published events <small>${c.events.length} events</small></h2>
  ${Object.keys(byMonth).length ? Object.entries(byMonth).map(([m, es]) => `<h3>${m}</h3>${es.map((e) => `<div class="list-item"><span class="badge">${esc(e.category)}</span><div class="grow">${esc(e.title)}<br><small>${esc(e.date)}${e.endDate && e.endDate !== e.date ? ' → ' + esc(e.endDate) : ''}${e.time ? ` ${esc(e.time)} (${esc(e.timeZone)})` : ' all day'}${e.rrule ? ' · yearly' : ''}</small></div><small class="mono hide-mobile">${esc(e.uid)}</small></div>`).join('')}`).join('') : '<p class="muted">Nothing to publish yet. Add races or tasks with type "call", "test", "review", "camp" or "travel".</p>'}</div>`;
  main().querySelector('[data-copy]').onclick = () => { navigator.clipboard.writeText(feed).then(() => toast('Link copied')); };
  wireGoogle(g);
  const form = main().querySelector('#calform');
  form.querySelector('[name=athletesMode]').onchange = (e) => (main().querySelector('#athsel').style.display = e.target.value === 'some' ? '' : 'none');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const categories = Object.fromEntries(cats.map(([k]) => [k, fd.has(`categories.${k}`)]));
    const ids = [...form.querySelectorAll('[name^="ath."]')].filter((x) => x.checked).map((x) => +x.name.slice(4));
    await attempt(() => api('PUT', '/api/settings', { calendar: { ...s, categories, names: fd.get('names'), alarmMinutes: fd.get('alarmMinutes') === '' ? null : +fd.get('alarmMinutes'), athletes: fd.get('athletesMode') === 'all' ? 'all' : ids } }), 'Calendar settings saved');
    route();
  };
}

// ---------------- Settings ----------------
async function renderSettings() {
  const [s, b, audit] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/backups'), api('GET', '/api/audit')]);
  const r = s.rules;
  main().innerHTML = `<div class="page-head"><div><h1>Settings</h1><small>Data folder: <span class="mono">${esc(s.dataDir)}</span></small></div></div>
  <div class="grid g2">
    <div class="card"><h2>Backup and restore</h2>
      <p>A backup is one <span class="mono">.chbackup</span> file containing the database and every attached file.</p>
      <div class="row"><a class="btn primary" href="/download/backup">Download backup now</a><button data-backup>Save backup to folder</button><button data-restore>Restore from backup…</button></div>
      <form id="bkform" style="margin-top:14px">
        ${field('Automatic daily backup (while the app is running)', 'autoDaily', s.backup.autoDaily, { type: 'checkbox' })}
        <div class="form-grid">${field('Keep this many backups', 'keep', s.backup.keep, { type: 'number', num: true })}${field('Also copy backups to folder', 'extraFolder', s.backup.extraFolder, { help: 'For example your iCloud Drive: ~/Library/Mobile Documents/com~apple~CloudDocs/Coaching Hub Backups' })}</div>
        <button type="submit">Save backup settings</button></form>
      <h3>Recent backups</h3>${b.local.slice(0, 6).map((x) => `<div class="list-item"><span class="grow mono">${esc(x.name)}</span><small>${(x.size / 1024).toFixed(0)} KB</small></div>`).join('') || '<p class="muted">None yet.</p>'}
      ${b.extraFolder ? `<small>${b.extra.length} backups in ${esc(b.extraFolder)}</small>` : ''}
    </div>
    <div class="card" id="updcard"><h2>App updates</h2><p class="muted">Loading…</p></div>
    <div class="card" id="aicard"><h2>Automatic import</h2><p class="muted">Loading…</p></div>
    <div class="card" id="loccard"><h2>Use on more than one Mac</h2><p class="muted">Loading…</p></div>
    <div class="card"><h2>Export</h2><p>Readable copies of your data for other tools. Use Backup to restore.</p>
      <div class="row"><a class="btn" href="/download/export.json">All data (JSON)</a><a class="btn" href="/download/activities.csv">All activities (CSV)</a></div>
      <h2 style="margin-top:20px">Sample data</h2><p>Fictional athletes for trying features. Always labelled, never published to your calendar.</p>
      <div class="row"><button data-sample-load>Load sample athletes</button><button class="danger" data-sample-remove>Remove all sample data</button></div>
    </div>
    <div class="card"><h2>Coaching rules <span class="badge blue">Coach-defined</span></h2><p><small>These are your rules, used by flags and suggestions. They are shown wherever they affect a result.</small></p>
      <form id="rules"><div class="form-grid">
        ${field('Max weekly-hours increase in suggestions (%)', 'maxWeeklyProgressionPct', r.maxWeeklyProgressionPct, { type: 'number', num: true })}
        ${field('Weeks of data needed for a baseline', 'minWeeksForBaseline', r.minWeeksForBaseline, { type: 'number', num: true })}
        ${field('Flag completion below (%)', 'complianceLowPct', r.complianceLowPct, { type: 'number', num: true })}
        ${field('Flag fatigue/soreness/stress at or above (1–5)', 'wellbeingHigh', r.wellbeingHigh, { type: 'number', num: true })}
        ${field('Flag motivation at or below (1–5)', 'motivationLow', r.motivationLow, { type: 'number', num: true })}
        ${field('Recovery guide after A race (days)', 'rgA', r.recoveryGuideDays.A, { type: 'number', num: true })}
        ${field('After B race (days)', 'rgB', r.recoveryGuideDays.B, { type: 'number', num: true })}
        ${field('After C race (days)', 'rgC', r.recoveryGuideDays.C, { type: 'number', num: true })}
      </div><button type="submit">Save rules</button></form></div>
    <div class="card"><h2>General</h2><form id="general">
      ${field('Your name', 'coach_name', s.coach_name)}${field('Your time zone', 'timezone', s.timezone)}
      ${field('Training phase names (one per line, in order)', 'phases', s.phases.join('\n'), { type: 'textarea', rows: 7 })}
      <button type="submit">Save</button></form></div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Change history</h2><div style="max-height:320px;overflow:auto">${audit.map((x) => `<div class="list-item"><small class="mono" style="min-width:130px">${esc(x.ts)}</small><div class="grow">${esc(x.summary)}${x.athlete_name ? ` <small>· ${esc(x.athlete_name)}</small>` : ''}</div></div>`).join('') || '<p class="muted">No changes yet.</p>'}</div></div>`;
  const m = main();
  m.querySelector('[data-backup]').onclick = async () => {
    const x = await attempt(() => api('POST', '/api/backups'));
    toast(`Saved ${x.name}${x.copiedTo ? (x.copiedTo.startsWith('failed') ? ' (copy ' + x.copiedTo + ')' : ' and copied') : ''}`, x.copiedTo?.startsWith('failed'));
    route();
  };
  m.querySelector('[data-restore]').onclick = restoreFlow;
  locationCard(m.querySelector('#loccard'));
  autoImportCard(m.querySelector('#aicard'));
  updatesCard(m.querySelector('#updcard'));
  m.querySelector('[data-sample-load]').onclick = () => attempt(() => api('POST', '/api/sample/load'), 'Sample athletes loaded').then(route);
  m.querySelector('[data-sample-remove]').onclick = async () => { if (await confirmDialog('Remove sample data', 'Delete all fictional sample athletes and their records? Real athletes are not affected.', 'Remove', true)) attempt(() => api('POST', '/api/sample/remove'), 'Sample data removed').then(route); };
  m.querySelector('#bkform').onsubmit = (e) => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); attempt(() => api('PUT', '/api/settings', { backup: { autoDaily: !!d.autoDaily, keep: Math.max(1, +d.keep || 14), extraFolder: (d.extraFolder || '').trim() } }), 'Backup settings saved'); };
  m.querySelector('#rules').onsubmit = (e) => {
    e.preventDefault();
    const d = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, Number(v)]));
    const rules = { maxWeeklyProgressionPct: d.maxWeeklyProgressionPct, minWeeksForBaseline: d.minWeeksForBaseline, complianceLowPct: d.complianceLowPct, wellbeingHigh: d.wellbeingHigh, motivationLow: d.motivationLow, recoveryGuideDays: { A: d.rgA, B: d.rgB, C: d.rgC } };
    attempt(() => api('PUT', '/api/settings', { rules }), 'Rules saved');
  };
  m.querySelector('#general').onsubmit = (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    attempt(() => api('PUT', '/api/settings', { coach_name: d.coach_name, timezone: d.timezone, phases: d.phases.split('\n').map((x) => x.trim()).filter(Boolean) }), 'Saved');
  };
}

export function importLogHTML(log, n = 8) {
  return (log || []).slice(0, n).map((e) => `<div class="list-item"><span class="badge ${e.ok ? 'green' : 'red'}">${e.ok ? 'Imported' : 'Needs attention'}</span><div class="grow">${esc(e.file)}${e.athlete ? ` → <a href="#/athletes/${e.athlete_id}/training">${esc(e.athlete)}</a>` : ''}<br><small>${esc(e.message)} · ${esc(new Date(e.at).toLocaleString())}</small></div></div>`).join('');
}

async function updatesCard(el) {
  let u;
  try {
    u = await api('GET', '/api/updates');
  } catch (e) {
    if (e.status !== 404) throw e;
    el.innerHTML = `<h2>App updates</h2><div class="notice">An older copy of Coaching Hub is still running in the background. Restart your Mac (Apple menu → Restart), then open Coaching Hub from Applications.</div>`;
    return;
  }
  const when = (x) => (x ? new Date(x).toLocaleString() : 'never');
  el.innerHTML = `<h2>App updates ${u.auto ? '<span class="badge green">Automatic</span>' : '<span class="badge">Manual</span>'}</h2>
    <p>You're on version <b>${esc(u.version)}</b>.${u.lastUpdated ? ` Last updated to ${esc(u.lastUpdatedVersion)} on ${esc(when(u.lastUpdated))}.` : ''}</p>
    <p>${u.auto ? 'Coaching Hub checks for a new version every few hours and installs it when you\'re not using it. Your athletes and settings are never touched by an update.' : 'Automatic updates are off.'}</p>
    <p><small>Last checked: ${esc(when(u.lastCheck))}${u.lastResult && u.lastResult.available ? ` · version ${esc(u.lastResult.latest)} is ready` : ''}</small></p>
    ${u.lastError ? `<div class="notice"><b>Last check failed:</b> ${esc(u.lastError)}</div>` : ''}
    ${u.inBundle ? '' : '<p><small>Updates install only in the Mac app (Coaching Hub in Applications).</small></p>'}
    <div class="row"><button class="primary" data-upcheck>Check for updates now</button><button data-uptoggle>${u.auto ? 'Turn off automatic updates' : 'Turn on automatic updates'}</button></div>`;
  el.querySelector('[data-upcheck]').onclick = async (e) => {
    e.target.disabled = true;
    const r = await attempt(() => api('POST', '/api/updates/check')).catch(() => null);
    if (r && r.installed) {
      toast(`Updated to ${r.version}. Restarting…`);
      setTimeout(() => location.reload(), 5000);
      return;
    }
    if (r) toast(r.available ? (r.note || `Version ${r.latest} is available`) : 'You have the latest version');
    updatesCard(el);
  };
  el.querySelector('[data-uptoggle]').onclick = async () => { await attempt(() => api('PUT', '/api/updates', { auto: !u.auto })).catch(() => {}); updatesCard(el); };
}

async function autoImportCard(el) {
  let a;
  try {
    a = await api('GET', '/api/autoimport');
  } catch (e) {
    if (e.status !== 404) throw e;
    el.innerHTML = `<h2>Automatic import</h2><div class="notice">An older copy of Coaching Hub is still running in the background. Restart your Mac, then open Coaching Hub from Applications.</div>`;
    return;
  }
  el.innerHTML = `<h2>Automatic import ${a.enabled ? '<span class="badge green">On</span>' : '<span class="badge">Off</span>'}</h2>
    <p>Save a TrainingPeaks workouts export (.zip or .csv) into this folder and it's imported within a minute. Put the athlete's name in the file name, for example <b>Kieran Masters.zip</b>. A first name is enough when only one athlete has it, and small spelling differences are fine. An athlete update file (<b>.chathlete</b>) saved here adds profile details, races, tests and notes to that athlete only, and never overwrites what is already there.</p>
    ${a.error ? `<div class="notice" style="border-color:var(--danger)"><b>Can't check the folder:</b> ${esc(a.error)}</div>` : ''}
    <p><small class="mono">${esc(a.folder)}</small></p>
    <div class="row"><button class="primary" data-aiopen>Open the folder</button><button data-airun>Check now</button><button data-aitoggle>${a.enabled ? 'Switch off' : 'Switch on'}</button></div>
    <p><small>Imported files move to "Imported". Files it can't match move to "Needs attention", so nothing is lost. Importing the same file twice doesn't create duplicates.</small></p>
    ${a.log && a.log.length ? `<h3>Recent</h3>${importLogHTML(a.log)}` : ''}`;
  const q = (x) => el.querySelector(x);
  q('[data-aiopen]').onclick = () => attempt(() => api('POST', '/api/autoimport/open'), 'Opened in Finder').catch(() => {});
  q('[data-airun]').onclick = async () => { const r = await attempt(() => api('POST', '/api/autoimport/run')).catch(() => null); if (r) { toast(r.entries.length ? `${r.entries.length} file(s) processed` : 'No new files'); autoImportCard(el); } };
  q('[data-aitoggle]').onclick = async () => { await attempt(() => api('PUT', '/api/autoimport', { enabled: !a.enabled })).catch(() => {}); autoImportCard(el); };
}

async function locationCard(el) {
  const l = await api('GET', '/api/location');
  const quit = `<p style="margin-top:14px"><button data-quit>Quit Coaching Hub</button> <small>Stops the app on this Mac. Open it again from Applications.</small></p>`;
  if (l.shared) {
    el.innerHTML = `<h2>Use on more than one Mac <span class="badge green">iCloud Drive</span></h2>
      <p>Your data is in iCloud Drive, so this Mac and your other Macs share the same athletes. Use it on one Mac at a time. If it's open on another Mac, you'll be asked to close it there first.</p>
      <p><small class="mono">${esc(l.dataDir)}</small></p>
      <div class="row"><button data-local>Keep data on this Mac only…</button></div>${quit}`;
  } else {
    el.innerHTML = `<h2>Use on more than one Mac</h2>
      <p>Right now your data is only on this Mac (${esc(l.computer)}).</p>
      ${!l.icloudAvailable ? '<div class="notice">iCloud Drive isn\'t switched on for this Mac. Turn it on in System Settings → your name → iCloud → iCloud Drive.</div>'
        : l.icloudHasData ? `<p>Your other Mac has already put Coaching Hub data in iCloud Drive.</p><div class="row"><button class="primary" data-use>Use the data from iCloud Drive</button></div><small>The data on this Mac is saved as a backup first, then this Mac switches to the shared data.</small>`
        : `<div class="row"><button class="primary" data-move>Move my data to iCloud Drive</button></div><small>Then, on your other Mac, open Settings and click "Use the data from iCloud Drive".</small>`}${quit}`;
  }
  const q = (x) => el.querySelector(x);
  const go = async (url, body, msg) => { const r = await attempt(() => api('POST', url, body), msg).catch(() => null); if (r) route(); };
  if (q('[data-move]')) q('[data-move]').onclick = async () => { if (await confirmDialog('Move to iCloud Drive', 'Copy your data into iCloud Drive and use it from there? A backup is saved first.', 'Move')) go('/api/location/icloud', {}, 'Your data is now in iCloud Drive'); };
  if (q('[data-use]')) q('[data-use]').onclick = async () => { if (await confirmDialog('Use the data from iCloud Drive', 'This Mac will switch to the shared data. What is on this Mac now is saved as a backup first.', 'Use iCloud data')) go('/api/location/icloud', { mode: 'use' }, 'Now using the shared data'); };
  if (q('[data-local]')) q('[data-local]').onclick = async () => { if (await confirmDialog('Keep data on this Mac only', 'Copy the shared data back to this Mac and stop using iCloud Drive here? Your other Mac keeps using iCloud Drive.', 'Copy back')) go('/api/location/local', {}, 'Your data is now on this Mac only'); };
  q('[data-quit]').onclick = async () => {
    const r = await api('POST', '/api/quit').catch((e) => { toast(e.message, true); return null; });
    if (r) document.body.innerHTML = '<div style="max-width:480px;margin:80px auto;font-family:system-ui;text-align:center"><h1>Coaching Hub has stopped</h1><p>You can close this tab. Open Coaching Hub again from Applications (the Dock icon only opens the window).</p></div>';
  };
}

async function restoreFlow() {
  const r = await dialog({
    title: 'Restore from backup',
    body: `<div class="notice warn">Restoring replaces all current data and files with the backup's contents. A safety backup of your current data is saved first.</div><input type="file" name="file" accept=".chbackup" data-noautofocus>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Restore', value: 'restore', primary: true }],
    validate: (_d, _v, el) => (!el.querySelector('[name=file]').files[0] ? 'Choose a backup file' : null),
    onOpen: (el) => { el.querySelector('[name=file]').dataset.keep = '1'; },
  });
  if (!r) return;
  const file = r.el.querySelector('[name=file]').files[0];
  const res = await attempt(() => api('POST', '/api/restore', file, { raw: true, headers: { 'content-type': 'application/octet-stream' } }));
  toast(`Restored backup from ${res.created_at.slice(0, 16).replace('T', ' ')} (${res.files} files)`);
  location.hash = '#/';
  route();
}

route();
