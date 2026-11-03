// Fictional sample athletes for trying the app. Every row is marked
// is_sample = 1 and can be removed in Settings without touching real records.
const calc = require('./calc');

function seedSample(svc) {
  const today = svc.today();
  const wk = calc.weekStart(today);
  const athletes = [
    {
      a: { name: 'Maya Ortega', preferred_name: 'Maya', sport: 'triathlon', status: 'active', start_date: calc.addDays(today, -540), birthday: shiftBirthday(today, 5, 1988), timezone: 'Europe/London', goals: '70.3 under 5:15; run off the bike without fading', phase: 'Specific Preparation', checkin_days: 7, review_days: 28, last_review_date: calc.addDays(today, -35),
        profile_json: { occupation: 'Nurse', work_hours: '3 × 12 h shifts', shift_pattern: 'Rotating days/nights', family: 'Two children (7, 10)', comms_preference: 'WhatsApp voice notes', motivation: 'Proving she can after kids', difficulties: 'Early swims after night shifts', typical_weekly_hours: 9, max_weekly_hours: 11, availability: { mon: 1, tue: 1.5, wed: 0, thu: 1.5, fri: 1, sat: 3, sun: 2 }, facilities: { pool: true, gym: false, trainer: true, outdoor: true }, background: 'Ex-club swimmer, 4 years triathlon', training_age_years: 4, strengths: 'Swim', limiters: 'Run durability' },
        health_json: { injuries: 'Occasional left Achilles tightness after long runs (athlete-reported)', active_issue: false } },
      base: 8.5, consistency: 0.9, split: { swim: 0.22, bike: 0.48, run: 0.25, strength: 0.05 },
      races: [{ name: 'Lakeside 70.3', date: calc.addDays(wk, 7 * 9 + 6), priority: 'A', sport: 'triathlon', distance: '70.3', goal: 'Sub 5:15' }, { name: 'County Olympic', date: calc.addDays(wk, 7 * 4 + 6), priority: 'B', sport: 'triathlon', distance: 'Olympic' }, { name: 'Spring Sprint', date: calc.addDays(wk, -7 * 10 + 6), priority: 'C', sport: 'triathlon', distance: 'Sprint', status: 'completed', result: '1:12:40, 4th AG' }],
      tests: [{ discipline: 'bike', test_type: 'ftp_20min', date: calc.addDays(today, -75), raw_json: { avgPower: 228 }, raw_summary: '20 min avg 228 W', accepted: 1, source: 'TrainingPeaks file', protocol: '20-minute test after standard warm-up' }, { discipline: 'swim', test_type: 'css', date: calc.addDays(today, -40), raw_json: { t400: '6:10', t200: '2:55' }, raw_summary: '400 m 6:10, 200 m 2:55', accepted: 1, source: 'Coach on deck' }],
      wellbeing: { fatigue: 4, soreness: 3, stress: 4, motivation: 3, sleep: 2, comments: 'Night shifts this week, felt flat on Saturday ride.' },
    },
    {
      a: { name: 'Tom Becker', preferred_name: 'Tom', sport: 'run', status: 'active', start_date: calc.addDays(today, -120), birthday: '1979-03-14', timezone: 'Europe/Berlin', goals: 'Marathon under 3:10', phase: 'General Preparation', checkin_days: 14, review_days: 42,
        profile_json: { occupation: 'Software engineer', work_hours: '9–5, remote', family: 'Partner, no children', typical_weekly_hours: 6, max_weekly_hours: 8, facilities: { gym: true, outdoor: true }, background: '3 marathons, self-coached', training_age_years: 6 } },
      base: 5.5, consistency: 0.55, split: { run: 0.85, strength: 0.15 },
      races: [{ name: 'Harbour Marathon', date: calc.addDays(wk, 7 * 20 + 6), priority: 'A', sport: 'run', distance: 'Marathon', goal: 'Sub 3:10' }, { name: 'City Half', date: calc.addDays(wk, 7 * 21), priority: 'B', sport: 'run', distance: 'Half marathon' }],
      tests: [{ discipline: 'run', test_type: 'run_tt', date: calc.addDays(today, -100), raw_json: { time: '20:05', distanceKm: 5 }, raw_summary: '5 km in 20:05', accepted: 0, source: 'parkrun result' }],
      wellbeing: { fatigue: 2, soreness: 2, stress: 3, motivation: 2, comments: 'Work deadline, missed two runs.' },
      gaps: 2,
    },
    {
      a: { name: 'Priya Shah', preferred_name: 'Priya', sport: 'bike', status: 'active', start_date: calc.addDays(today, -20), timezone: 'America/New_York', goals: 'First gran fondo', phase: 'General Preparation', checkin_days: 7, review_days: 28,
        profile_json: { occupation: 'Teacher', typical_weekly_hours: 5, facilities: { trainer: true, outdoor: true }, background: 'New to structured training', training_age_years: 1 } },
      base: 4.5, consistency: 1, split: { bike: 1 }, weeksOfData: 2,
      races: [],
      tests: [],
    },
  ];

  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const s of athletes) {
    const a = svc.insert('athletes', { ...s.a, is_sample: 1 });
    for (const r of s.races) svc.insert('races', { status: 'planned', ...r, athlete_id: a.id });
    for (const t of s.tests) {
      const added = svc.addTest({ ...t, athlete_id: a.id });
      if (t.accepted) svc.update('tests', added.id, { effective_from: t.date });
    }
    const weeks = s.weeksOfData || 16;
    for (let i = weeks; i >= 1; i--) {
      const w = calc.addDays(wk, -7 * i);
      if (s.gaps && i <= 6 && i % 3 === 0) continue; // genuinely missing weeks
      const recovery = i % 4 === 0;
      const planned = s.base * (recovery ? 0.7 : 1 + (16 - i) * 0.01);
      const done = planned * (s.consistency - 0.1 + rnd() * 0.2);
      const plannedBy = {};
      for (const [sport, frac] of Object.entries(s.split)) {
        plannedBy[sport] = Math.round(planned * frac * 10) / 10;
        let left = done * frac * 60;
        let day = 0;
        while (left > 15 && day < 7) {
          const len = Math.min(left, sport === 'bike' && day === 5 ? 180 : 45 + rnd() * 60);
          svc.insert('activities', { athlete_id: a.id, date: calc.addDays(w, day + (sport === 'run' ? 1 : 0)), sport, duration_min: Math.round(len), distance_km: sport === 'run' ? Math.round(len / 5.3 * 10) / 10 : sport === 'bike' ? Math.round(len / 2.1) : sport === 'swim' ? Math.round(len / 2.2) / 10 : null, rpe: Math.round(3 + rnd() * 4), load: sport === 'bike' ? Math.round(len * 0.9) : null, load_type: sport === 'bike' ? 'TrainingPeaks TSS (bike)' : null, source: 'manual', title: `${sport} session` });
          left -= len;
          day += 2;
        }
      }
      svc.upsertWeek(a.id, w, { planned_json: plannedBy, sessions_planned: Object.keys(s.split).length * 3 });
    }
    if (s.wellbeing) {
      const w = calc.addDays(wk, -7);
      svc.upsertWeek(a.id, w, { fatigue: s.wellbeing.fatigue, soreness: s.wellbeing.soreness, stress: s.wellbeing.stress, motivation: s.wellbeing.motivation, sleep: s.wellbeing.sleep ?? null, athlete_comments: s.wellbeing.comments });
    }
    for (let i = 0; i < 6; i++) {
      const w = calc.addDays(wk, 7 * i);
      svc.db.prepare('INSERT INTO plan_weeks(athlete_id, week_start, phase, hours_min, hours_max, focus) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(a.id, w, s.a.phase, Math.round(s.base * 0.9), Math.round(s.base * 1.1), i === 3 ? 'Recovery and test' : 'Aerobic durability');
    }
    svc.insert('notes', { athlete_id: a.id, date: calc.addDays(today, -10), body: 'Sample note: talked through race-day nutrition plan.', kind: 'note' });
    svc.insert('tasks', { athlete_id: a.id, title: 'Check-in call', kind: 'call', due_date: calc.addDays(today, 2), due_time: '18:30', timezone: s.a.timezone });
  }
  svc.insert('tasks', { title: 'Sample: renew coaching insurance', kind: 'task', due_date: calc.addDays(today, -1) });
}

function shiftBirthday(today, inDays, year) {
  const d = calc.addDays(today, inDays);
  return `${year}${d.slice(4)}`;
}

function removeSample(svc) {
  const ids = svc.db.prepare('SELECT id FROM athletes WHERE is_sample = 1').all().map((r) => r.id);
  for (const id of ids) svc.remove('athletes', id);
  const n = ids.length;
  svc.db.prepare("DELETE FROM tasks WHERE athlete_id IS NULL AND title LIKE 'Sample:%'").run();
  svc.audit(null, 'sample', null, 'delete', `Removed ${n} sample athletes`);
  return { removed: n };
}

module.exports = { seedSample, removeSample };
