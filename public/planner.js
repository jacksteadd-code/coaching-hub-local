import { api, esc, toast, attempt, dialog, confirmDialog, field, hrs, pct, cap, sampleBadge, sourceBadge, calc, SPORTS, PHASE_COLORS } from './ui.js';
import { main, rerender } from './app.js';

const FIELDS = [['phase', 'Phase'], ['hours_min', 'Min h'], ['hours_max', 'Max h'], ['focus', 'Training focus'], ['intensity', 'Intensity balance'], ['key_sessions', 'Key-session objectives'], ['recovery', 'Recovery emphasis'], ['milestone', 'Test / review milestone'], ['rationale', 'Coach rationale']];
const LABEL = Object.fromEntries(FIELDS);

let planState = null; // { athleteId, rows: Map, dirty: Set, sel: [from,to] | null, show }

export async function renderPlanner(athleteId) {
  const [athletes, settings] = await Promise.all([api('GET', '/api/athletes'), api('GET', '/api/settings')]);
  const usable = athletes.filter((a) => a.status !== 'former');
  if (!usable.length) {
    main().innerHTML = `<div class="page-head"><h1>Season Planner</h1></div><div class="card empty"><h2>No athletes yet</h2><p>Add an athlete first, then build their season here.</p><a class="btn primary" href="#/athletes">Go to athletes</a></div>`;
    return;
  }
  if (!athleteId) { location.replace(`#/planner/${usable[0].id}`); return; }
  const d = await api('GET', `/api/athletes/${athleteId}`);
  if (!planState || planState.athleteId !== athleteId) planState = { athleteId, rows: new Map(d.plan.map((w) => [w.week_start, { ...w }])), dirty: new Set(), deleted: new Set(), sel: null, show: 'upcoming' };
  const st = planState;
  const today = d.derived.today;
  const thisWeek = calc.weekStart(today);
  const phases = settings.phases;
  const phaseColor = (p) => (p ? PHASE_COLORS[Math.max(0, phases.indexOf(p)) % PHASE_COLORS.length] : 'var(--surface-2)');
  const raceWeeks = new Map();
  for (const r of d.races.filter((x) => x.status !== 'cancelled')) {
    const w = calc.weekStart(r.date);
    if (!raceWeeks.has(w) || r.priority < raceWeeks.get(w).priority) raceWeeks.set(w, r);
  }
  const allWeeks = [...st.rows.keys()].filter((w) => !st.deleted.has(w));
  const lastRace = d.races.map((r) => r.date).sort().pop();
  const start = calc.addDays(thisWeek, -8 * 7);
  let end = [calc.addDays(thisWeek, 40 * 7), ...allWeeks, lastRace ? calc.addDays(calc.weekStart(lastRace), 28) : null].filter(Boolean).sort().pop();
  const weeks = [];
  for (let w = start; w <= end; w = calc.addDays(w, 7)) weeks.push(w);
  const maxH = Math.max(1, ...allWeeks.map((w) => +st.rows.get(w).hours_max || +st.rows.get(w).hours_min || 0), ...d.summaries.map((s) => s.completedHours || 0));
  const inSel = (w) => st.sel && w >= st.sel[0] && w <= st.sel[1];
  const pending = d.proposals.filter((p) => p.status === 'pending' && p.origin === 'calculation');
  const a = d.athlete;

  const rowsToShow = st.show === 'selected' && st.sel ? weeks.filter(inSel) : st.show === 'all' ? weeks.filter((w) => st.rows.has(w) && !st.deleted.has(w)) : weeks.filter((w) => w >= thisWeek && w <= calc.addDays(thisWeek, 16 * 7));

  main().innerHTML = `
  <div class="page-head"><div><h1>Season Planner</h1><small>Edits stay as a draft until you review and apply them. Every applied change saves the previous version.</small></div>
    <div class="row"><select data-ath style="width:auto">${usable.map((x) => `<option value="${x.id}" ${x.id === athleteId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <button data-reviewed>Mark plan reviewed</button><button class="primary" data-suggest>Suggest weekly hours</button></div></div>
  <div class="row" style="margin-bottom:12px"><a href="#/athletes/${a.id}">${esc(a.name)}</a>${sampleBadge(a)}<small>Last plan review: ${esc(a.last_review_date || 'never')} · Typical ${esc(d.derived.profile.typical_weekly_hours || '?')} h, max ${esc(d.derived.profile.max_weekly_hours || '?')} h/week</small></div>
  ${pending.map((p) => proposalCard(p)).join('')}
  <div class="card" style="margin-bottom:16px"><h2>Season view <small>click a week, shift-click to select a range, drag the selection to move it</small></h2>
    <div class="legend" style="margin-bottom:8px">${phases.map((p) => `<span><i style="background:${phaseColor(p)}"></i>${esc(p)}</span>`).join('')}<span><i style="background:var(--muted);opacity:.45"></i>Planned hours (light = min)</span><span><b style="color:var(--danger)">A/B/C</b> race</span><span>● completed hours</span></div>
    <div class="season"><div class="season-strip">${weeks.map((w) => {
      const r = st.rows.has(w) && !st.deleted.has(w) ? st.rows.get(w) : null;
      const race = raceWeeks.get(w);
      const done = d.summaries.find((s) => s.week === w)?.completedHours;
      const hmax = r ? +r.hours_max || +r.hours_min || 0 : 0;
      const hmin = r ? +r.hours_min || 0 : 0;
      return `<div class="wk ${inSel(w) ? 'sel' : ''} ${w === thisWeek ? 'now' : ''}" data-w="${w}" draggable="${inSel(w) ? 'true' : 'false'}" title="${esc(`${w}${r ? `\n${r.phase || 'No phase'} · ${r.hours_min ?? '?'}–${r.hours_max ?? '?'} h${r.focus ? '\n' + r.focus : ''}` : '\nNo plan'}${race ? `\n${race.priority} race: ${race.name}` : ''}${done != null ? `\nCompleted ${done.toFixed(1)} h` : ''}`)}">
        <div class="race">${race ? race.priority : ''}</div>
        <div style="height:110px;display:flex;align-items:flex-end;position:relative">${done != null ? `<span style="position:absolute;left:50%;bottom:${(done / maxH) * 104}px;transform:translateX(-50%);font-size:9px;color:var(--text)">●</span>` : ''}<div class="bar" style="width:100%;height:${(hmax / maxH) * 104}px">${hmin ? `<div class="lo" style="height:${(hmin / hmax) * 100}%"></div>` : ''}</div></div>
        <div class="ph" style="background:${phaseColor(r?.phase)}">${esc(r?.phase || '')}</div>
        <div class="lbl">${(weeks.indexOf(w) % 4 === 0 || w === thisWeek) ? w.slice(5).replace('-', '/') : ''}</div></div>`;
    }).join('')}</div></div>
    <div class="row" style="margin-top:10px">${st.sel ? `<b>Selected ${st.sel[0]}${st.sel[1] !== st.sel[0] ? ' → ' + st.sel[1] : ''}</b>
      <select data-setphase style="width:auto"><option value="">Set phase…</option>${phases.map((p) => `<option>${esc(p)}</option>`).join('')}<option value="__clear">(clear phase)</option></select>
      <button class="small" data-sethours>Set hours…</button><button class="small" data-move>Move by weeks…</button><button class="small" data-remove>Remove weeks</button><button class="small link" data-clearsel>Clear selection</button>` : '<small>Select weeks to set phases, hours or move a block.</small>'}
      <button class="small right" data-addweeks>Add weeks…</button></div>
  </div>
  ${st.dirty.size || st.deleted.size ? `<div class="notice warn row"><b>${st.dirty.size + st.deleted.size} unsaved week change${st.dirty.size + st.deleted.size > 1 ? 's' : ''}.</b><button class="primary small" data-review-changes>Review and apply…</button><button class="small" data-discard>Discard</button></div>` : ''}
  <div class="card flush" style="margin-bottom:16px"><div style="padding:16px 16px 0"><h2>Weekly detail <span class="seg">${[['upcoming', 'Next 16 weeks'], ['all', 'All planned'], ['selected', 'Selected']].map(([k, l]) => `<button class="${st.show === k ? 'on' : ''}" data-show="${k}">${l}</button>`).join('')}</span></h2></div>
    <div class="table-wrap"><table class="plan-table"><thead><tr><th>Week</th><th>Phase</th><th>Hours</th><th>By sport (h)</th><th>Focus</th><th>Intensity</th><th>Key sessions</th><th>Recovery</th><th>Milestone</th><th>Rationale</th><th>Done</th></tr></thead><tbody>
    ${rowsToShow.map((w) => {
      const r = st.rows.has(w) && !st.deleted.has(w) ? st.rows.get(w) : {};
      const sh = r.sport_hours_json ? (typeof r.sport_hours_json === 'string' ? JSON.parse(r.sport_hours_json) : r.sport_hours_json) : {};
      const race = raceWeeks.get(w);
      const s = d.summaries.find((x) => x.week === w);
      const inp = (f, wd = 120) => `<input data-f="${f}" value="${esc(r[f] ?? '')}" style="min-width:${wd}px">`;
      return `<tr data-row="${w}" class="${st.dirty.has(w) ? 'dirty' : ''} ${w === thisWeek ? 'now' : ''}"><td style="white-space:nowrap"><b>${w}</b>${race ? `<br><span class="badge red">${race.priority}: ${esc(race.name.slice(0, 18))}</span>` : ''}</td>
      <td><select data-f="phase" style="min-width:130px"><option value=""></option>${phases.map((p) => `<option ${r.phase === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}${r.phase && !phases.includes(r.phase) ? `<option selected>${esc(r.phase)}</option>` : ''}</select></td>
      <td style="white-space:nowrap"><input data-f="hours_min" type="number" step="0.5" min="0" value="${esc(r.hours_min ?? '')}" style="width:58px"> – <input data-f="hours_max" type="number" step="0.5" min="0" value="${esc(r.hours_max ?? '')}" style="width:58px"></td>
      <td style="white-space:nowrap">${['swim', 'bike', 'run', 'strength'].map((sp) => `<input data-sport="${sp}" type="number" step="0.25" min="0" placeholder="${{ swim: 'Sw', bike: 'Bk', run: 'Rn', strength: 'St' }[sp]}" title="${cap(sp)}" value="${esc(sh[sp] ?? '')}" style="width:48px">`).join(' ')}</td>
      <td>${inp('focus', 140)}</td><td>${inp('intensity', 110)}</td><td>${inp('key_sessions', 160)}</td><td>${inp('recovery', 110)}</td><td>${inp('milestone', 110)}</td><td>${inp('rationale', 160)}</td>
      <td style="white-space:nowrap">${s && w < thisWeek ? `${hrs(s.completedHours)}` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="11" class="muted">No weeks to show. Use "Add weeks…" or select weeks in the season view.</td></tr>'}
    </tbody></table></div></div>
  <div class="grid g2">
    <div class="card"><h2>Plan versions</h2>${d.versions.length ? d.versions.slice(0, 15).map((v) => `<div class="list-item"><small class="mono" style="min-width:130px">${esc(v.created_at)}</small><div class="grow">${esc(v.note || '')}<br><small>Saved before this change</small></div><button class="small" data-ver="${v.id}">View / restore</button></div>`).join('') : '<p class="muted">No changes yet.</p>'}</div>
    <div class="card"><h2>Past suggestions</h2>${d.proposals.filter((p) => p.status !== 'pending').slice(0, 10).map((p) => `<div class="list-item"><span class="badge ${p.origin === 'ai' ? 'amber' : 'blue'}">${p.origin === 'ai' ? 'AI' : 'Calculation'}</span><div class="grow">${esc(p.title)}<br><small>${esc(p.status === 'saved' ? 'kept as note' : p.status)} ${esc(p.decided_at || '')}</small></div></div>`).join('') || '<p class="muted">None.</p>'}</div>
  </div>`;
  wirePlanner(d, settings, weeks);
}

function proposalCard(p) {
  const b = JSON.parse(p.body_json);
  const weeks = p.changes_json ? JSON.parse(p.changes_json) : [];
  return `<div class="card" style="margin-bottom:16px;border-color:var(--accent)"><h2><span>Suggestion: ${esc(p.title)}</span><span class="badge blue">Calculation + your rules · not AI</span></h2>
  <div class="grid g2"><div>
    <h3 style="margin-top:0">1. Suggested action</h3><p>Set weekly hours to <b>${b.action.hours_min}–${b.action.hours_max} h</b> for ${weeks.map((w) => w.week_start).join(', ')}.</p>
    <h3>2. Athlete data used</h3><ul>${b.dataUsed.map((x) => `<li><small>${esc(x)}</small></li>`).join('')}</ul>
    <h3>3. Reasoning</h3><ul>${b.reasoning.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
  <div><h3 style="margin-top:0">4. Uncertainty and missing information</h3>${b.uncertainty.length || b.flags.length ? `<ul>${[...b.flags, ...b.uncertainty].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">None identified from the recorded data. Check anything not recorded in the app.</p>'}
    <h3>5. Conservative alternative</h3><p><b>${b.conservative.lo}–${b.conservative.hi} h</b>. ${esc(b.conservative.note)}</p>
    <p><small>${esc(b.basis)} Does not predict injury and does not model a taper.</small></p>
    <div class="row"><button class="primary" data-prop="${p.id}" data-mode="apply">Review and apply…</button><button data-prop="${p.id}" data-mode="conservative">Use conservative…</button><button data-prop="${p.id}" data-mode="edit">Edit in planner</button><button class="danger" data-prop="${p.id}" data-mode="reject">Reject</button></div></div></div></div>`;
}

function wirePlanner(d, settings, weeks) {
  const st = planState;
  const m = main();
  const a = d.athlete;
  const markDirty = (w) => {
    if (!st.rows.has(w)) st.rows.set(w, { week_start: w });
    st.deleted.delete(w);
    st.dirty.add(w);
  };
  m.querySelector('[data-ath]').onchange = (e) => { planState = null; location.hash = `#/planner/${e.target.value}`; };
  m.querySelector('[data-reviewed]').onclick = async () => { await attempt(() => api('PUT', `/api/athletes/${a.id}`, { last_review_date: d.derived.today }), 'Plan marked as reviewed today'); rerender(); };
  m.querySelector('[data-suggest]').onclick = async () => {
    const r = await attempt(() => api('POST', `/api/athletes/${a.id}/recommend`, { weeksAhead: 4 }));
    if (r.kind === 'insufficient') {
      await dialog({ title: r.title, body: `<p>The app will not guess a baseline. To make a suggestion it needs:</p><ul>${r.missing.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${r.dataUsed.length ? `<p><small>Weeks with data so far: ${r.dataUsed.map(esc).join(', ')}</small></p>` : ''}`, buttons: [{ label: 'OK', value: null }] });
    } else rerender();
  };
  // Season strip selection and drag-to-move
  m.querySelectorAll('.wk').forEach((el) => {
    el.onclick = (e) => {
      const w = el.dataset.w;
      if (e.shiftKey && st.sel) st.sel = [w < st.sel[0] ? w : st.sel[0], w > st.sel[0] ? w : st.sel[0]];
      else st.sel = st.sel && st.sel[0] === w && st.sel[1] === w ? null : [w, w];
      if (st.sel) st.show = 'selected';
      rerender();
    };
    el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', el.dataset.w); };
    el.ondragover = (e) => { e.preventDefault(); el.classList.add('drop'); };
    el.ondragleave = () => el.classList.remove('drop');
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      const from = e.dataTransfer.getData('text/plain');
      const n = calc.daysBetween(from, el.dataset.w) / 7;
      if (n) moveBlock(n);
    };
  });
  const sel = () => weeks.filter((w) => st.sel && w >= st.sel[0] && w <= st.sel[1]);
  m.querySelector('[data-setphase]')?.addEventListener('change', (e) => {
    for (const w of sel()) { markDirty(w); st.rows.get(w).phase = e.target.value === '__clear' ? null : e.target.value; }
    rerender();
  });
  m.querySelector('[data-sethours]')?.addEventListener('click', async () => {
    const r = await dialog({ title: 'Set hours for selected weeks', body: `<div class="form-grid">${field('Minimum hours', 'min', '', { type: 'number' })}${field('Maximum hours', 'max', '', { type: 'number' })}</div><small>Applies to ${sel().length} weeks in the draft.</small>` });
    if (!r) return;
    for (const w of sel()) { markDirty(w); if (r.data.min !== '') st.rows.get(w).hours_min = +r.data.min; if (r.data.max !== '') st.rows.get(w).hours_max = +r.data.max; }
    rerender();
  });
  m.querySelector('[data-remove]')?.addEventListener('click', () => {
    for (const w of sel()) if (st.rows.has(w)) { st.deleted.add(w); st.dirty.delete(w); }
    rerender();
  });
  m.querySelector('[data-clearsel]')?.addEventListener('click', () => { st.sel = null; st.show = 'upcoming'; rerender(); });
  m.querySelector('[data-move]')?.addEventListener('click', async () => {
    const r = await dialog({ title: 'Move selected block', body: field('Move by weeks (negative = earlier)', 'n', 1, { type: 'number' }), buttons: [{ label: 'Cancel', value: null }, { label: 'Preview', value: 'p', primary: true }] });
    if (r && +r.data.n) moveBlock(Math.round(+r.data.n));
  });
  async function moveBlock(n) {
    if (st.dirty.size || st.deleted.size) return toast('Apply or discard your draft changes before moving a block', true);
    const pv = await attempt(() => api('POST', `/api/athletes/${a.id}/plan/shift-preview`, { from: st.sel[0], to: st.sel[1], n }));
    const r = await dialog({
      title: `Move ${st.sel[0]} → ${st.sel[1]} by ${n > 0 ? '+' : ''}${n} week${Math.abs(n) > 1 ? 's' : ''}`,
      wide: true,
      body: `${pv.warnings.map((w) => `<div class="notice warn">${esc(w)}</div>`).join('')}${pv.overwritten.length ? `<div class="notice warn">These existing weeks will be overwritten: ${pv.overwritten.join(', ')}</div>` : ''}${pv.vacated.length ? `<p>Weeks left empty: ${pv.vacated.join(', ')}</p>` : ''}${diffTable(pv.changes)}${field('Note for version history', 'note', `Moved block ${st.sel[0]}–${st.sel[1]} by ${n} weeks`)}`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Apply move', value: 'ok', primary: true }],
    });
    if (!r) return;
    await attempt(() => api('PUT', `/api/athletes/${a.id}/plan`, { weeks: pv.weeks, deleteWeeks: pv.vacated, note: r.data.note, confirmed: true }), 'Block moved');
    planState = null;
    rerender();
  }
  m.querySelector('[data-addweeks]').onclick = async () => {
    const from = st.sel ? st.sel[0] : calc.weekStart(d.derived.today);
    const r = await dialog({ title: 'Add plan weeks', body: `<div class="form-grid">${field('From week', 'from', from, { type: 'date' })}${field('To week', 'to', st.sel ? st.sel[1] : calc.addDays(from, 7 * 3), { type: 'date' })}${field('Phase', 'phase', '', { type: 'select', opts: ['', ...settings.phases] })}${field('Min hours', 'min', '', { type: 'number' })}${field('Max hours', 'max', '', { type: 'number' })}${field('Focus', 'focus', '')}</div><small>Dates snap to Mondays. Existing weeks keep values you leave blank.</small>` });
    if (!r) return;
    for (let w = calc.weekStart(r.data.from); w <= calc.weekStart(r.data.to); w = calc.addDays(w, 7)) {
      markDirty(w);
      const row = st.rows.get(w);
      if (r.data.phase) row.phase = r.data.phase;
      if (r.data.min !== '') row.hours_min = +r.data.min;
      if (r.data.max !== '') row.hours_max = +r.data.max;
      if (r.data.focus) row.focus = r.data.focus;
    }
    st.show = 'all';
    rerender();
  };
  m.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => { st.show = b.dataset.show; rerender(); }));
  // Inline edits update the draft without re-rendering (keeps focus)
  m.querySelectorAll('tr[data-row]').forEach((tr) => {
    const w = tr.dataset.row;
    tr.querySelectorAll('[data-f]').forEach((inp) => (inp.onchange = () => {
      markDirty(w);
      const v = inp.value;
      st.rows.get(w)[inp.dataset.f] = v === '' ? null : inp.type === 'number' ? +v : v;
      tr.classList.add('dirty');
      showDirtyBar();
    }));
    tr.querySelectorAll('[data-sport]').forEach((inp) => (inp.onchange = () => {
      markDirty(w);
      const row = st.rows.get(w);
      const sh = row.sport_hours_json ? (typeof row.sport_hours_json === 'string' ? JSON.parse(row.sport_hours_json) : { ...row.sport_hours_json }) : {};
      if (inp.value === '') delete sh[inp.dataset.sport]; else sh[inp.dataset.sport] = +inp.value;
      row.sport_hours_json = Object.keys(sh).length ? JSON.stringify(sh) : null;
      tr.classList.add('dirty');
      showDirtyBar();
    }));
  });
  function showDirtyBar() {
    if (!m.querySelector('[data-review-changes]')) rerender();
  }
  m.querySelector('[data-discard]')?.addEventListener('click', async () => { if (await confirmDialog('Discard draft', 'Discard all unsaved plan edits?', 'Discard', true)) { planState = null; rerender(); } });
  m.querySelector('[data-review-changes]')?.addEventListener('click', async () => {
    const weeksOut = [...st.dirty].sort().map((w) => st.rows.get(w));
    const changes = await api('POST', `/api/athletes/${a.id}/plan/preview`, { weeks: weeksOut });
    const r = await dialog({
      title: 'Review plan changes',
      wide: true,
      body: `${diffTable(changes)}${st.deleted.size ? `<div class="notice warn">Weeks removed from the plan: ${[...st.deleted].sort().join(', ')}</div>` : ''}${field('Note for version history', 'note', 'Edited in season planner')}<small>The current plan is saved as a version first, so you can restore it.</small>`,
      buttons: [{ label: 'Keep editing', value: null }, { label: 'Apply changes', value: 'ok', primary: true }],
    });
    if (!r) return;
    await attempt(() => api('PUT', `/api/athletes/${a.id}/plan`, { weeks: weeksOut, deleteWeeks: [...st.deleted], note: r.data.note, confirmed: true }), 'Plan updated');
    planState = null;
    rerender();
  });
  m.querySelectorAll('[data-prop]').forEach((b) => (b.onclick = async () => {
    const p = d.proposals.find((x) => x.id === +b.dataset.prop);
    const body = JSON.parse(p.body_json);
    let weeksIn = JSON.parse(p.changes_json || '[]');
    if (b.dataset.mode === 'reject') {
      if (await confirmDialog('Reject suggestion', 'Reject this suggestion? It stays in the history.', 'Reject')) { await attempt(() => api('POST', `/api/proposals/${p.id}/reject`, {}), 'Rejected'); rerender(); }
      return;
    }
    if (b.dataset.mode === 'conservative') weeksIn = weeksIn.map((w) => ({ ...w, hours_min: body.conservative.lo, hours_max: body.conservative.hi, rationale: 'Conservative option: ' + body.conservative.note }));
    if (b.dataset.mode === 'edit') {
      for (const w of weeksIn) { markDirty(w.week_start); Object.assign(st.rows.get(w.week_start), w); }
      st.show = 'upcoming';
      await api('POST', `/api/proposals/${p.id}/keep`, {});
      toast('Loaded into the draft. Review and apply when ready.');
      rerender();
      return;
    }
    const changes = await api('POST', `/api/athletes/${a.id}/plan/preview`, { weeks: weeksIn });
    const r = await dialog({ title: 'Apply suggestion', wide: true, body: `${diffTable(changes)}${field('Note for version history', 'note', `Approved: ${p.title}${b.dataset.mode === 'conservative' ? ' (conservative option)' : ''}`)}`, buttons: [{ label: 'Cancel', value: null }, { label: 'Approve and apply', value: 'ok', primary: true }] });
    if (!r) return;
    await attempt(() => api('POST', `/api/proposals/${p.id}/apply`, { weeks: weeksIn, note: r.data.note }), 'Suggestion applied');
    planState = null;
    rerender();
  }));
  m.querySelectorAll('[data-ver]').forEach((b) => (b.onclick = async () => {
    const v = await api('GET', `/api/plan-versions/${b.dataset.ver}`);
    const r = await dialog({
      title: `Plan before change on ${v.created_at}`,
      wide: true,
      body: `<p><small>${esc(v.note || '')}</small></p><div class="table-wrap" style="max-height:400px;overflow:auto"><table><thead><tr><th>Week</th><th>Phase</th><th>Hours</th><th>Focus</th></tr></thead><tbody>${v.snapshot.map((w) => `<tr><td>${w.week_start}</td><td>${esc(w.phase || '')}</td><td>${w.hours_min ?? ''}–${w.hours_max ?? ''}</td><td>${esc(w.focus || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Empty plan</td></tr>'}</tbody></table></div>`,
      buttons: [{ label: 'Close', value: null }, { label: 'Restore this version', value: 'r', primary: true }],
    });
    if (!r) return;
    if (!(await confirmDialog('Restore plan version', 'Replace the current plan with this version? The current plan is saved as a version first.', 'Restore'))) return;
    await attempt(() => api('POST', `/api/plan-versions/${v.id}/restore`, { confirmed: true }), 'Version restored');
    planState = null;
    rerender();
  }));
}

function diffTable(changes) {
  if (!changes.length) return '<p class="muted">No differences from the current plan.</p>';
  return `<div class="table-wrap" style="max-height:380px;overflow:auto"><table class="diff"><thead><tr><th>Week</th><th>Field</th><th>Current</th><th>Proposed</th></tr></thead><tbody>${changes.flatMap((c) => c.fields.map((f, i) => `<tr><td>${i === 0 ? `${c.week_start}${c.isNew ? ' <span class="badge green">new</span>' : ''}` : ''}</td><td>${esc(LABEL[f.field] || f.field)}</td><td class="from">${esc(f.from ?? '—')}</td><td class="to">${esc(f.to ?? '—')}</td></tr>`)).join('')}</tbody></table></div>`;
}

// ---------------- Weekly review ----------------
export async function renderReview(week, athleteId) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = calc.todayIn(tz);
  week = week && calc.parseDate(week) ? calc.weekStart(week) : calc.addDays(calc.weekStart(today), -7);
  const queue = await api('GET', `/api/review/${week}`);
  if (!queue.length) {
    main().innerHTML = `<div class="page-head"><h1>Weekly Review</h1></div><div class="card empty"><h2>No active athletes</h2><a class="btn primary" href="#/athletes">Add an athlete</a></div>`;
    return;
  }
  const current = athleteId || (queue.find((q) => !q.reviewed_at) || queue[0]).id;
  const w = await api('GET', `/api/athletes/${current}/weeks/${week}`);
  const s = w.summary;
  const done = queue.filter((q) => q.reviewed_at).length;
  const wb = w.log ? ['sleep', 'fatigue', 'soreness', 'stress', 'motivation'].filter((k) => w.log[k] != null) : [];
  main().innerHTML = `<div class="page-head"><div><h1>Weekly Review</h1><small>${done} of ${queue.length} reviewed</small></div>
    <div class="row"><a class="btn small" href="#/review/${calc.addDays(week, -7)}">← Previous week</a><b>Week of ${week}</b><a class="btn small" href="#/review/${calc.addDays(week, 7)}">Next week →</a></div></div>
  <div class="grid" style="grid-template-columns:minmax(0,260px) minmax(0,1fr)" id="rv">
    <div class="card flush" style="align-self:start">${queue.map((q) => `<a href="#/review/${week}/${q.id}" class="list-item" style="padding:10px 14px;${q.id === current ? 'background:var(--accent-soft);' : ''}color:var(--text);text-decoration:none"><span>${q.reviewed_at ? '✅' : '○'}</span><div class="grow"><b>${esc(q.name)}</b>${q.is_sample ? ' <small>(sample)</small>' : ''}<br><small>${q.summary.completedHours != null ? `${hrs(q.summary.completedHours)} / ${hrs(q.summary.plannedHours)}` : 'No data'}${q.flags ? ` · ${q.flags} flag${q.flags > 1 ? 's' : ''}` : ''}</small></div></a>`).join('')}</div>
    <div>
      <div class="card" style="margin-bottom:16px"><h2><a href="#/athletes/${current}/training/${week}">${esc(w.athlete.preferred_name || w.athlete.name)}</a>${sourceBadge(s.source)}</h2>
        <div class="grid g4"><div><div class="stat">${hrs(s.completedHours)}</div><div class="stat-label">completed</div></div><div><div class="stat">${hrs(s.plannedHours)}</div><div class="stat-label">planned${s.plannedSource ? ` (${esc(s.plannedSource)})` : ''}</div></div><div><div class="stat">${hrs(w.prev.completedHours)}</div><div class="stat-label">previous week</div></div><div><div class="stat">${hrs(w.baseline.hours)}</div><div class="stat-label">own baseline (${w.baseline.weeksUsed} wk)</div></div></div>
        <div class="row" style="margin-top:10px">${SPORTS.filter((sp) => s.completedBySport[sp] || s.plannedBySport?.[sp]).map((sp) => `<span class="badge">${cap(sp)} ${hrs(s.completedBySport[sp] ?? (s.source === 'missing' ? null : 0))} / ${hrs(s.plannedBySport?.[sp] ?? null)}</span>`).join('')}${s.missedSessions ? `<span class="badge red">${s.missedSessions} missed</span>` : ''}</div>
        ${wb.length ? `<p><b>Wellbeing:</b> ${wb.map((k) => `${k} ${w.log[k]}/5`).join(' · ')}</p>` : ''}${w.log?.athlete_comments ? `<p><b>Athlete:</b> ${esc(w.log.athlete_comments)}</p>` : ''}${w.log?.missed_reasons ? `<p><b>Missed/modified:</b> ${esc(w.log.missed_reasons)}</p>` : ''}
        ${s.source === 'missing' ? `<div class="notice">No training recorded for this week. <a href="#/athletes/${current}/training/${week}">Enter or import it</a>, or note why in the brief.</div>` : ''}
      </div>
      <div class="card"><h2>Coaching brief <small>${w.log?.brief ? 'saved' : 'draft from data – edit freely'}</small></h2>
        <form id="brief"><textarea name="brief" rows="14">${esc(w.brief)}</textarea>
        <div class="form-grid" style="margin-top:8px">${field('Coach notes (private)', 'coach_notes', w.log?.coach_notes || '', { type: 'textarea' })}${field('Next actions', 'next_actions', w.log?.next_actions || '', { type: 'textarea' })}</div>
        <div class="row"><button type="submit" name="act" value="save">Save</button><button type="button" data-msg>Draft athlete message</button><button type="button" data-redraft class="link">Rebuild draft from data</button>
        <button type="submit" class="primary right" name="act" value="done">${w.log?.reviewed_at ? 'Reviewed ✓ – save' : 'Mark reviewed and next'}</button></div></form></div>
    </div></div>`;
  if (matchMedia('(max-width: 760px)').matches) main().querySelector('#rv').style.gridTemplateColumns = '1fr';
  const f = main().querySelector('#brief');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const act = e.submitter?.value;
    const body = { brief: f.brief.value, coach_notes: f.coach_notes.value, next_actions: f.next_actions.value };
    if (act === 'done' && !w.log?.reviewed_at) body.reviewed_at = new Date().toISOString();
    await attempt(() => api('PUT', `/api/athletes/${current}/weeks/${week}`, body), act === 'done' ? 'Review complete' : 'Saved');
    if (act === 'done') {
      const next = queue.find((q) => !q.reviewed_at && q.id !== current);
      location.hash = next ? `#/review/${week}/${next.id}` : `#/review/${week}`;
      if (!next) rerender();
    } else rerender();
  };
  main().querySelector('[data-redraft]').onclick = async () => {
    if (!(await confirmDialog('Rebuild draft', 'Replace the text with a fresh draft from the data? Unsaved edits are lost.', 'Rebuild'))) return;
    await api('PUT', `/api/athletes/${current}/weeks/${week}`, { brief: null });
    rerender();
  };
  main().querySelector('[data-msg]').onclick = async () => {
    const name = (w.athlete.preferred_name || w.athlete.name).split(' ')[0];
    const nextFocus = (f.brief.value.match(/Suggested focus next week: (.*)/) || [])[1] || '';
    const text = `Hi ${name},\n\nThanks for last week. You completed ${s.completedHours != null ? s.completedHours.toFixed(1) + ' hours' : 'your sessions'}${s.plannedHours ? ` of the ${s.plannedHours.toFixed(1)} planned` : ''}.\n\n[What went well]\n\n[What to adjust]\n\nNext week: ${nextFocus.startsWith('(') ? '[focus]' : nextFocus}\n\nAny questions, just shout.\n\nJack`;
    const r = await dialog({ title: 'Draft message (not sent)', body: `<div class="notice">Edit and copy this into your usual messaging app. The app never sends messages.</div><textarea id="msg" rows="14">${esc(text)}</textarea>`, buttons: [{ label: 'Close', value: null }, { label: 'Copy', value: 'c', primary: true }] });
    if (r) navigator.clipboard.writeText(r.el.querySelector('#msg').value).then(() => toast('Copied'), () => toast('Could not copy; select the text and copy it instead', true));
  };
}
