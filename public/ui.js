// Shared UI helpers.
export const calc = globalThis.calc;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(method, url, body, { raw = false, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'x-coaching-hub': '1', ...(raw ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body == null ? undefined : raw ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `Request failed (${res.status})`), { status: res.status, busy: data && data.busy, data });
  return data;
}

let toastTimer;
export function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isError ? 6000 : 2600);
}

// Runs an async action and reports errors as a toast.
export async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

// Modal dialog. `body` is HTML; `onOpen(el)` wires behaviour. Resolves with
// the clicked button's value and the form's data, or null when cancelled.
export function dialog({ title, body, buttons = [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }], onOpen, wide = false, validate }) {
  const d = document.getElementById('dlg');
  d.style.width = wide ? 'min(1000px, calc(100vw - 24px))' : '';
  d.innerHTML = `<form method="dialog" novalidate><div class="dlg-head"><h2 style="margin:0">${esc(title)}</h2><button type="button" class="small" data-x aria-label="Close">✕</button></div><div class="dlg-body">${body}</div><div class="dlg-foot">${buttons.map((b, i) => `<button type="submit" value="${i}" class="${b.primary ? 'primary' : b.danger ? 'danger' : ''}" ${b.left ? 'style="margin-right:auto"' : ''}>${esc(b.label)}</button>`).join('')}</div></form>`;
  return new Promise((resolve) => {
    const form = d.querySelector('form');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    d.querySelector('[data-x]').onclick = () => finish(null);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = buttons[+e.submitter?.value];
      if (!b || b.value == null) return finish(null);
      const data = formToObject(form);
      if (validate && b.primary) {
        const err = await validate(data, b.value, d);
        if (err) return toast(err, true);
      }
      finish({ action: b.value, data, el: d });
    });
    d.addEventListener('cancel', () => finish(null), { once: true });
    d.showModal();
    if (onOpen) onOpen(d);
    const first = d.querySelector('.dlg-body input:not([type=hidden]), .dlg-body textarea, .dlg-body select');
    if (first && !first.dataset.noautofocus) first.focus();
  });
}

export async function confirmDialog(title, message, label = 'Confirm', danger = false) {
  const r = await dialog({ title, body: `<p>${message}</p>`, buttons: [{ label: 'Cancel', value: null }, { label, value: 'ok', primary: !danger, danger }] });
  return !!r;
}

// Collects named fields; dotted names build nested objects; checkboxes are booleans.
export function formToObject(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.disabled) continue;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'radio') { if (!el.checked) continue; v = el.value; }
    else v = el.value;
    if (el.dataset.num !== undefined && v !== '') v = Number(v);
    const parts = el.name.split('.');
    let o = out;
    for (const p of parts.slice(0, -1)) o = o[p] = o[p] || {};
    o[parts[parts.length - 1]] = v;
  }
  return out;
}

export function field(label, name, value = '', { type = 'text', wide = false, opts, help, num = false, attrs = '', rows } = {}) {
  let input;
  if (type === 'select') input = `<select name="${name}" ${attrs}>${opts.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
  else if (type === 'textarea') input = `<textarea name="${name}" ${rows ? `rows="${rows}"` : ''} ${attrs}>${esc(value)}</textarea>`;
  else if (type === 'checkbox') return `<div class="field ${wide ? 'wide' : ''}"><label class="check"><input type="checkbox" name="${name}" ${value ? 'checked' : ''} ${attrs}> ${esc(label)}</label>${help ? `<small>${help}</small>` : ''}</div>`;
  else input = `<input type="${type}" name="${name}" value="${esc(value)}" ${num ? 'data-num' : ''} ${type === 'number' ? 'step="any"' : ''} ${attrs}>`;
  return `<div class="field ${wide ? 'wide' : ''}"><label>${esc(label)}</label>${input}${help ? `<small>${help}</small>` : ''}</div>`;
}

export const hrs = (h) => (h == null ? '—' : `${h.toFixed(1)} h`);
export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
export const initials = (n) => (n || '?').split(/\s+/).filter((p) => p && p[0] !== '(').slice(0, 2).map((p) => p[0].toUpperCase()).join('');

export function avatar(a, lg = false) {
  return `<span class="avatar ${lg ? 'lg' : ''}">${a.photo_id ? `<img src="/files/${a.photo_id}" alt="">` : esc(initials(a.preferred_name || a.name))}</span>`;
}

export function sampleBadge(a) {
  return a.is_sample ? ' <span class="badge sample" title="Fictional sample data, kept separate from real athletes">Sample</span>' : '';
}

export function statusBadge(s) {
  return `<span class="badge ${s === 'active' ? 'green' : s === 'paused' ? 'amber' : ''}">${esc(cap(s))}</span>`;
}

export function sourceBadge(source) {
  if (!source || source === 'missing') return '<span class="badge" title="No training recorded. Treated as missing data, not zero.">No data</span>';
  return `<span class="badge ${source === 'imported' ? 'blue' : ''}">${esc(source === 'manual' ? 'Manual' : source === 'imported' ? 'Imported' : cap(source))}</span>`;
}

export function flagList(flags, max = 99) {
  if (!flags.length) return '<p class="muted">Nothing flagged.</p>';
  return flags.slice(0, max).map((f) => `<div class="flag"><span class="dot ${f.severity}"></span><div class="grow">${esc(f.message)}<br><small>${esc(f.action)}</small></div></div>`).join('') + (flags.length > max ? `<small>+${flags.length - max} more</small>` : '');
}

export const SPORTS = ['swim', 'bike', 'run', 'strength', 'other'];
export const PHASE_COLORS = ['#94a3b8', '#60a5fa', '#2563eb', '#7c3aed', '#f59e0b', '#dc2626', '#10b981', '#0ea5e9', '#a3a3a3'];

// Activity-style completion ring. `value` is 0..1 (or null for no data).
export function ring(value, { size = 64, stroke = 7, label, color } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  const col = color || (value == null ? 'var(--planned)' : value < 0.7 ? 'var(--warn)' : 'var(--ok)');
  const text = label ?? (value == null ? '—' : `${Math.round(value * 100)}%`);
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-label="${esc(text)}"><circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>${v ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${(c * v).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''}<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-size="${Math.round(size * 0.24)}">${esc(text)}</text></svg>`;
}

// Big countdown for a race: number + unit.
export function countdownParts(cd) {
  if (!cd) return { n: '—', u: '' };
  if (cd.days === 0) return { n: '0', u: 'race day' };
  if (cd.days < 0) return { n: String(-cd.days), u: 'days ago' };
  if (cd.days < 21) return { n: String(cd.days), u: cd.days === 1 ? 'day' : 'days' };
  return { n: String(cd.weeks), u: 'weeks' };
}

export const priDot = (p) => `<span class="pri ${esc(p)}" title="${esc(p)} race">${esc(p)}</span>`;

// "2026-11-08" -> "8 Nov"
export function shortDate(iso, withYear = false) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00Z');
  if (Number.isNaN(+d)) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}
