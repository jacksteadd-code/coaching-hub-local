'use strict';
// One-way sync from Coaching Hub to a dedicated "Coaching" Google calendar.
//
// How it works: Jack pastes a small Google Apps Script (below) into his own
// Google account and deploys it as a web app. Coaching Hub sends the list of
// events to that script, and the script creates, updates or removes events in
// the "Coaching" calendar only. Every event it writes is tagged with its
// Coaching Hub ID, and it never touches an event without that tag, so other
// calendars and hand-made events are left alone. Nothing leaves this Mac until
// sync is switched on in Settings → Calendar.

const crypto = require('node:crypto');
const { zonedToUtc } = require('./ics');
const calc = require('./calc');

const CALENDAR_NAME = 'Coaching';
const PAST_DAYS = 60;
const FUTURE_DAYS = 730;

function scriptSource(secret) {
  return `// Coaching Hub → Google Calendar (one-way).
// Paste this whole file into a new project at script.google.com, then
// Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
// It only ever writes to a calendar called "${CALENDAR_NAME}", and only to
// events that Coaching Hub created (they carry a hidden tag).
const SECRET = '${secret}';
const CALENDAR = '${CALENDAR_NAME}';

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ error: 'Bad request' }); }
  if (body.secret !== SECRET) return out({ error: 'Wrong secret. Copy the script from Coaching Hub again.' });
  const cal = CalendarApp.getCalendarsByName(CALENDAR)[0] || CalendarApp.createCalendar(CALENDAR);
  if (body.action === 'ping') return out({ ok: true, calendar: CALENDAR });
  const from = new Date(body.from), to = new Date(body.to);
  const existing = {};
  cal.getEvents(from, to).forEach(function (ev) {
    const uid = ev.getTag('chuid');
    if (!uid) return;
    (existing[uid] = existing[uid] || []).push(ev);
  });
  const r = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  const keep = {};
  body.events.forEach(function (x) {
    keep[x.uid] = true;
    const found = existing[x.uid] || [];
    if (found.length === 1 && found[0].getTag('chhash') === x.hash) { r.unchanged++; return; }
    found.forEach(function (ev) { ev.deleteEvent(); });
    const opts = { description: x.description || '' };
    const ev = x.allDay
      ? cal.createAllDayEvent(x.title, day(x.start), day(x.end), opts)
      : cal.createEvent(x.title, new Date(x.start), new Date(x.end), opts);
    ev.setTag('chuid', x.uid);
    ev.setTag('chhash', x.hash);
    ev.removeAllReminders();
    if (x.reminderMinutes != null) ev.addPopupReminder(x.reminderMinutes);
    if (found.length) r.updated++; else r.created++;
  });
  Object.keys(existing).forEach(function (uid) {
    if (keep[uid]) return;
    existing[uid].forEach(function (ev) { ev.deleteEvent(); r.deleted++; });
  });
  r.ok = true;
  return out(r);
}

function day(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
`;
}

// Turn Coaching Hub calendar events into the simple shape the script expects.
function toGoogleEvents(events, defaultTz) {
  const out = [];
  const skipped = [];
  for (const e of events) {
    if (e.rrule) { skipped.push(e.title); continue; } // repeating events (birthdays) stay in the .ics feed only
    let g;
    if (e.time) {
      const start = zonedToUtc(e.date, e.time, e.timeZone || defaultTz || 'UTC');
      const end = new Date(start.getTime() + (e.durationMin || 30) * 60000);
      g = { uid: e.uid, title: e.title, description: e.description || '', allDay: false, start: start.toISOString(), end: end.toISOString() };
    } else {
      g = { uid: e.uid, title: e.title, description: e.description || '', allDay: true, start: e.date, end: calc.addDays(e.endDate || e.date, 1) };
    }
    g.reminderMinutes = e.alarmMinutes == null || Number.isNaN(e.alarmMinutes) ? null : e.alarmMinutes;
    g.hash = crypto.createHash('sha1').update(JSON.stringify([g.title, g.description, g.allDay, g.start, g.end, g.reminderMinutes])).digest('hex').slice(0, 16);
    out.push(g);
  }
  return { events: out, skipped };
}

function validUrl(url, allowAny) {
  if (allowAny) return /^https?:\/\//.test(url || '');
  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url || '');
}

async function post(url, body, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow', signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw Object.assign(new Error(`Couldn't reach Google (${e.cause?.code || e.message}). Check the internet connection.`), { status: 502 });
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw Object.assign(new Error(/accounts\.google|ServiceLogin/.test(text) ? 'Google asked for a sign-in. In the deployment, set "Who has access" to "Anyone".' : `Google returned an unexpected page (HTTP ${res.status}). Check the web app link.`), { status: 502 });
  }
  if (data.error) throw Object.assign(new Error(data.error), { status: 502 });
  return data;
}

module.exports = { CALENDAR_NAME, PAST_DAYS, FUTURE_DAYS, scriptSource, toGoogleEvents, validUrl, post };
