// iCalendar (RFC 5545) feed. Event UIDs are stable per record, so calendar
// apps update or remove events on refresh instead of duplicating them.
const { addDays } = require('./calc');

// Convert a wall-clock time in a time zone to a UTC Date, honouring DST.
function zonedToUtc(date, time, timeZone) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = (time || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess;
  // Two passes settle the offset, including on DST transition days.
  for (let i = 0; i < 2; i++) t = guess - offsetMs(new Date(t), timeZone);
  return new Date(t);
}

function offsetMs(instant, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function utcStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function esc(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Fold lines longer than 75 octets.
function fold(line) {
  const out = [];
  let buf = Buffer.from(line, 'utf8');
  while (buf.length > 75) {
    let cut = 75;
    while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
    out.push(buf.subarray(0, cut).toString('utf8'));
    buf = Buffer.concat([Buffer.from(' '), buf.subarray(cut)]);
  }
  out.push(buf.toString('utf8'));
  return out.join('\r\n');
}

function compact(date) {
  return date.replace(/-/g, '');
}

// events: { uid, title, date, endDate?, time?, durationMin?, timeZone?, description?, alarmMinutes?, private? }
function buildCalendar(events, { name = 'Coaching Hub', now = new Date() } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Coaching Hub//Local//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${utcStamp(now)}`, `SUMMARY:${esc(e.title)}`);
    if (e.time) {
      const start = zonedToUtc(e.date, e.time, e.timeZone || 'UTC');
      const end = new Date(start.getTime() + (e.durationMin || 30) * 60000);
      lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compact(e.date)}`, `DTEND;VALUE=DATE:${compact(addDays(e.endDate || e.date, 1))}`, 'TRANSP:TRANSPARENT');
    }
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.private) lines.push('CLASS:PRIVATE');
    if (e.sequence) lines.push(`SEQUENCE:${e.sequence}`);
    if (e.alarmMinutes != null) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${e.alarmMinutes}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildCalendar, zonedToUtc, utcStamp };
