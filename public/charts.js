// Small dependency-free SVG charts so everything works offline.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SPORT_COLORS = { swim: 'var(--swim)', bike: 'var(--bike)', run: 'var(--run)', strength: 'var(--strength)', other: 'var(--other)' };

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Weekly hours: planned (outline) behind completed (stacked by sport).
// Weeks with no data show a hatched "no data" marker, never a zero bar.
export function weeklyHoursChart(weeks, { height = 240 } = {}) {
  const W = 820;
  const H = height;
  const pad = { l: 36, r: 8, t: 10, b: 28 };
  const max = niceMax(Math.max(1, ...weeks.map((w) => Math.max(w.completedHours || 0, w.plannedHours || 0))));
  const bw = (W - pad.l - pad.r) / weeks.length;
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly planned and completed hours"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--planned)" stroke-width="2"/></pattern></defs>`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--hair)" stroke-width="1"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${+v.toFixed(1)}</text>`;
  }
  weeks.forEach((w, i) => {
    const x = pad.l + i * bw + bw * 0.15;
    const bwi = bw * 0.7;
    const tip = `${w.week}: ${w.completedHours == null ? 'no data' : w.completedHours.toFixed(1) + ' h done'}${w.plannedHours != null ? `, ${w.plannedHours.toFixed(1)} h planned` : ''}${w.source && w.source !== 'missing' ? ` (${w.source})` : ''}`;
    s += `<g><title>${esc(tip)}</title>`;
    if (w.plannedHours != null) s += `<rect x="${x}" y="${y(w.plannedHours)}" width="${bwi}" height="${y(0) - y(w.plannedHours)}" fill="var(--planned)" opacity="0.45" rx="6"/>`;
    if (w.completedHours == null) {
      s += `<rect x="${x}" y="${y(max * 0.12)}" width="${bwi}" height="${y(0) - y(max * 0.12)}" fill="url(#hatch)" rx="6"/>`;
    } else {
      let acc = 0;
      const total = ['swim', 'bike', 'run', 'strength', 'other'].reduce((t, sp) => t + (w.completedBySport?.[sp] || 0), 0);
      const clip = `c${i}${Math.random().toString(36).slice(2, 7)}`;
      if (total) s += `<clipPath id="${clip}"><rect x="${x}" y="${y(total)}" width="${bwi}" height="${y(0) - y(total)}" rx="6"/></clipPath><g clip-path="url(#${clip})">`;
      for (const sp of ['swim', 'bike', 'run', 'strength', 'other']) {
        const v = w.completedBySport?.[sp];
        if (!v) continue;
        s += `<rect x="${x}" y="${y(acc + v)}" width="${bwi}" height="${y(acc) - y(acc + v) + 0.5}" fill="${SPORT_COLORS[sp]}"/>`;
        acc += v;
      }
      if (total) s += '</g>';
      if (!acc && w.completedHours === 0) s += `<rect x="${x}" y="${y(0) - 2}" width="${bwi}" height="2" fill="var(--muted)"/>`;
    }
    s += '</g>';
    if (weeks.length <= 14 || i % Math.ceil(weeks.length / 12) === 0) s += `<text x="${x + bwi / 2}" y="${H - 10}" text-anchor="middle">${w.week.slice(5).replace('-', '/')}</text>`;
  });
  return s + '</svg>';
}

export function chartLegend(extra = []) {
  const items = [['swim', 'Swim'], ['bike', 'Bike'], ['run', 'Run'], ['strength', 'Strength'], ['other', 'Other']].map(([k, l]) => `<span><i style="background:${SPORT_COLORS[k]}"></i>${l}</span>`);
  items.push('<span><i style="background:var(--planned);opacity:.6"></i>Planned</span>', '<span><i style="background:repeating-linear-gradient(45deg,var(--border),var(--border) 2px,transparent 2px,transparent 4px)"></i>No data</span>');
  return `<div class="legend">${items.concat(extra).join('')}</div>`;
}

// Simple line chart. series: [{ name, color, points: [{x: 'YYYY-MM-DD', y: number, label?}] }]
export function lineChart(series, { height = 200, yLabel = '', step = false, yMin } = {}) {
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return '<p class="muted">No data yet.</p>';
  const W = 820;
  const H = height;
  const pad = { l: 40, r: 12, t: 12, b: 26 };
  const xs = pts.map((p) => Date.parse(p.x));
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= 86400000 * 15; x1 += 86400000 * 15; }
  const ys = pts.map((p) => p.y);
  let lo = yMin ?? Math.min(...ys);
  let hi = Math.max(...ys);
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  lo -= span * 0.1;
  hi += span * 0.1;
  const X = (t) => pad.l + ((t - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)}">`;
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) / 3) * i;
    s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--hair)"/><text x="${pad.l - 6}" y="${Y(v) + 4}" text-anchor="end">${Math.round(v * 10) / 10}</text>`;
  }
  s += `<text x="${pad.l}" y="${H - 8}">${new Date(x0).toISOString().slice(0, 10)}</text><text x="${W - pad.r}" y="${H - 8}" text-anchor="end">${new Date(x1).toISOString().slice(0, 10)}</text>`;
  for (const se of series) {
    const p = [...se.points].sort((a, b) => (a.x < b.x ? -1 : 1));
    if (!p.length) continue;
    let d = '';
    p.forEach((q, i) => {
      const xx = X(Date.parse(q.x));
      const yy = Y(q.y);
      if (i === 0) d += `M${xx},${yy}`;
      else d += step ? `H${xx}V${yy}` : `L${xx},${yy}`;
    });
    if (step) d += `H${W - pad.r}`;
    s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="2"/>`;
    for (const q of p) s += `<circle cx="${X(Date.parse(q.x))}" cy="${Y(q.y)}" r="3.5" fill="${q.hollow ? 'var(--surface)' : se.color}" stroke="${se.color}" stroke-width="2"><title>${esc(q.label || `${q.x}: ${q.y}`)}</title></circle>`;
  }
  return s + '</svg>';
}
