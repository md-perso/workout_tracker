/* Workout Tracker — vanilla JS, offline-first.
 *
 * Editing your routine means editing routine.json. Nothing in this file needs
 * to change to add, remove, reorder or retarget an exercise.
 */
'use strict';

var APP_VERSION = '2.0.0';

var K = {
  SESSIONS:  'wt.sessions',
  OVERRIDES: 'wt.overrides',
  ORDER:     'wt.order',
  CREDS:     'wt.creds',
  DRAFT:     'wt.draft',
  SKIPS:     'wt.skips',
  DIRTY:     'wt.dirty',
  ROUTINE:   'wt.routineCache'
};

var state = {
  screen: 'home',
  routine: null,
  sessions: [],
  overrides: {},   /* { exId: { sets, targetReps, weightKg } } — edited targets */
  order: {},       /* { dayKey: [exId, ...] } — your exercise order per day */
  creds: { username: '', repo: '', branch: 'main', token: '' },
  draft: null,     /* { id, date, day, current: exId|null, entries: [] } */
  skips: {},        /* { 'YYYY-MM-DD': 'push-a' } — days deliberately not trained */
  dirty: false,     /* local store differs from the cloud for a non-session reason */
  sync: { busy: false, error: '' },
  history: { tab: 'sessions', expanded: null, exerciseId: '' },
  ui: { showToken: false, calOffset: 0, editTarget: null, routineDay: null }
};

/* ------------------------------------------------------------------ *
 * Storage — every write is guarded and failures are made visible.
 * ------------------------------------------------------------------ */

function readJSON(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    var val = JSON.parse(raw);
    return val === null || val === undefined ? fallback : val;
  } catch (err) {
    showBanner('Could not read saved data (' + key + '): ' + err.message +
               ' — existing data was left untouched.');
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    showBanner('SAVE FAILED (' + key + '): ' + err.message +
               ' — nothing was written. Export a backup from Settings before continuing.');
    return false;
  }
}

function saveSessions()  { return writeJSON(K.SESSIONS, state.sessions); }
function saveOverrides() { return writeJSON(K.OVERRIDES, state.overrides); }
function saveOrder()     { return writeJSON(K.ORDER, state.order); }
function saveCreds()     { return writeJSON(K.CREDS, state.creds); }
function saveSkips()     { return writeJSON(K.SKIPS, state.skips); }

/* Deleting a session or moving a target changes the store without creating a
   pending session, so flag it or the cloud copy silently keeps the old data. */
function markDirty() {
  state.dirty = true;
  writeJSON(K.DIRTY, true);
}

function clearDirty() {
  state.dirty = false;
  try { localStorage.removeItem(K.DIRTY); } catch (err) { /* nothing to clear */ }
}

function saveDraft() {
  if (state.draft) return writeJSON(K.DRAFT, state.draft);
  try { localStorage.removeItem(K.DRAFT); return true; }
  catch (err) { showBanner('Could not clear the in-progress session: ' + err.message); return false; }
}

/* ------------------------------------------------------------------ *
 * Banner
 * ------------------------------------------------------------------ */

function showBanner(message) {
  var el = document.getElementById('banner');
  el.innerHTML = esc(message) + ' <button type="button" data-act="dismiss-banner">Dismiss</button>';
  el.hidden = false;
}

function hideBanner() {
  var el = document.getElementById('banner');
  el.hidden = true;
  el.textContent = '';
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function isoDay(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function prettyDate(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function daysAgo(iso) {
  var then = new Date(isoDay(iso) + 'T00:00:00');
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var diff = Math.round((today - then) / 86400000);
  if (isNaN(diff)) return '';
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  return diff + ' days ago';
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ *
 * Routine + overrides
 * ------------------------------------------------------------------ */

function dayKeys() {
  return state.routine ? Object.keys(state.routine.days) : [];
}

/* 'push' | 'pull' — colours and the rotation fallback key off this. Old
   sessions logged as plain 'push' / 'pull' still resolve. */
function dayFamily(day) {
  var d = state.routine && state.routine.days[day];
  if (d && d.family) return d.family;
  return String(day).indexOf('pull') === 0 ? 'pull' : 'push';
}

/* Exercises for a day in the order you chose; anything not yet ordered keeps
   its routine.json position at the end. */
function dayExercises(day) {
  if (!state.routine || !state.routine.days[day]) return [];
  var seeds = state.routine.days[day].exercises;
  var order = state.order[day] || [];
  var rank = {};
  order.forEach(function (id, i) { rank[id] = i; });
  return seeds.map(function (ex, i) { return { ex: ex, i: i }; })
    .sort(function (a, b) {
      var ra = rank[a.ex.id] === undefined ? order.length + a.i : rank[a.ex.id];
      var rb = rank[b.ex.id] === undefined ? order.length + b.i : rank[b.ex.id];
      return ra - rb;
    })
    .map(function (p) { return effective(p.ex); });
}

/* Every distinct exercise; one shared across days appears once. */
function allExercises() {
  var out = [];
  var seen = {};
  dayKeys().forEach(function (d) {
    state.routine.days[d].exercises.forEach(function (ex) {
      if (seen[ex.id]) return;
      seen[ex.id] = true;
      out.push(effective(ex));
    });
  });
  return out;
}

function exerciseById(id) {
  var found = null;
  allExercises().forEach(function (ex) { if (ex.id === id) found = ex; });
  return found;
}

function exerciseName(id) {
  var ex = exerciseById(id);
  if (ex) return ex.name;
  var retired = state.routine && state.routine.retired;
  return (retired && retired[id]) || id;
}

/* routine.json stays the untouched seed; overrides layer on top. */
function effective(ex) {
  var o = state.overrides[ex.id];
  var merged = {
    id: ex.id, name: ex.name, sets: ex.sets, targetReps: ex.targetReps,
    weightKg: ex.weightKg, unit: ex.unit, measure: ex.measure === 'seconds' ? 'seconds' : 'reps',
    description: ex.description || '', technique: Array.isArray(ex.technique) ? ex.technique : [],
    overridden: false
  };
  if (o) {
    if (o.sets !== undefined && o.sets !== null)             { merged.sets       = o.sets;       merged.overridden = true; }
    if (o.targetReps !== undefined && o.targetReps !== null) { merged.targetReps = o.targetReps; merged.overridden = true; }
    if (o.weightKg !== undefined)                            { merged.weightKg   = o.weightKg;   merged.overridden = true; }
  }
  return merged;
}

function unitLabel(unit) {
  if (unit === 'perHand')    return 'per hand';
  if (unit === 'single')     return 'single DB';
  if (unit === 'bodyweight') return 'bodyweight';
  if (unit === 'pulley')     return 'pulley';
  if (unit === 'plate')      return 'plate';
  return unit || '';
}

function measureUnit(ex) { return ex.measure === 'seconds' ? 's' : 'reps'; }

function weightText(ex) {
  if (ex.weightKg === null || ex.weightKg === undefined) {
    return ex.unit === 'bodyweight' ? 'Bodyweight' : 'Pulley — log the stack';
  }
  return ex.weightKg + ' kg ' + unitLabel(ex.unit);
}

function targetText(ex) {
  return ex.sets + ' × ' + ex.targetReps + (ex.measure === 'seconds' ? ' s' : '');
}

/* Weight used on set i. Entries logged before per-set weights carry one
   weightKg for every set. */
function setWeight(entry, i) {
  if (Array.isArray(entry.weightsKg)) return num(entry.weightsKg[i]);
  return num(entry.weightKg);
}

function setWeights(entry) {
  var miss = entry.missed || [];
  return (entry.reps || []).map(function (r, i) { return miss[i] ? null : setWeight(entry, i); })
                           .filter(function (w) { return w !== null; });
}

function maxWeight(entry) {
  var ws = setWeights(entry);
  return ws.length ? Math.max.apply(null, ws) : num(entry.weightKg);
}

function minWeight(entry) {
  var ws = setWeights(entry);
  return ws.length ? Math.min.apply(null, ws) : num(entry.weightKg);
}

function uniformWeight(entry) {
  return maxWeight(entry) === minWeight(entry);
}

/* "8 · 8 · 7" — or "14×8 · 13×10" when the weight changed between sets. */
function repsList(entry, ex) {
  var miss = entry.missed || [];
  var mixed = !uniformWeight(entry);
  return (entry.reps || []).map(function (r, i) {
    if (miss[i]) return '✕';
    var rep = (r === null || r === undefined) ? '–' : String(r);
    var w = setWeight(entry, i);
    return (mixed && w !== null) ? w + '×' + rep : rep;
  }).join(' · ') + (ex && ex.measure === 'seconds' ? ' s' : '');
}

/* What a logged entry's weight reads as — a blank pulley entry is not bodyweight. */
function entryWeightText(entry) {
  var hi = maxWeight(entry), lo = minWeight(entry);
  if (hi !== null) return (lo !== hi ? lo + '–' + hi : hi) + ' kg';
  var ex = exerciseById(entry.exerciseId);
  if (ex && ex.unit === 'bodyweight') return 'bodyweight';
  if (ex && ex.unit === 'pulley') return 'pulley';
  return '—';
}

/* target reps parsing: a number, a "10-15" range, or "max" */
function repsTop(t) {
  if (typeof t === 'number') return t;
  var m = String(t).match(/^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/);
  if (!m) return null;
  return Number(m[2] !== undefined ? m[2] : m[1]);
}

function repsBottom(t) {
  if (typeof t === 'number') return t;
  var m = String(t).match(/^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/);
  if (!m) return null;
  return Number(m[1]);
}

/* Accepts "10", "8-12" or "max"; returns the normalised target or null. */
function parseTarget(raw) {
  var s = String(raw === null || raw === undefined ? '' : raw).trim().replace(/\s*[–—]\s*/g, '-');
  if (!s) return null;
  if (/^max$/i.test(s)) return 'max';
  var m = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) return Number(m[1]) <= Number(m[2]) ? m[1] + '-' + m[2] : null;
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

/* ------------------------------------------------------------------ *
 * Session history queries — the streak is always derived, never stored.
 * ------------------------------------------------------------------ */

function sessionsDesc() {
  return state.sessions.slice().sort(function (a, b) {
    return String(b.date).localeCompare(String(a.date));
  });
}

function sessionsAsc() { return sessionsDesc().reverse(); }

function entriesFor(exId) {
  var out = [];
  sessionsAsc().forEach(function (s) {
    (s.entries || []).forEach(function (e) {
      if (e.exerciseId === exId) out.push({ session: s, entry: e });
    });
  });
  return out;
}

function lastEntryFor(exId) {
  var list = sessionsDesc();
  for (var i = 0; i < list.length; i++) {
    var e = (list[i].entries || []).filter(function (x) { return x.exerciseId === exId; })[0];
    if (e) return { session: list[i], entry: e };
  }
  return null;
}

function lastSessionForDay(day) {
  var list = sessionsDesc();
  for (var i = 0; i < list.length; i++) if (list[i].day === day) return list[i];
  return null;
}

/* The entry for exId logged most recently before `session`. */
function entryBefore(exId, session) {
  var list = sessionsDesc();
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].date) >= String(session.date)) continue;
    var e = (list[i].entries || []).filter(function (x) { return x.exerciseId === exId; })[0];
    if (e) return { session: list[i], entry: e };
  }
  return null;
}

function totalReps(entry) {
  var miss = entry.missed || [];
  return (entry.reps || []).reduce(function (a, r, i) { return a + (miss[i] ? 0 : (num(r) || 0)); }, 0);
}

/* Kilograms moved: Σ weight × reps over attempted sets. */
function tonnage(entry) {
  var miss = entry.missed || [];
  return (entry.reps || []).reduce(function (a, r, i) {
    var w = setWeight(entry, i);
    return a + (miss[i] || w === null ? 0 : w * (num(r) || 0));
  }, 0);
}

/* How two entries differ: { kind, delta } where kind is 'top' (heaviest set
   changed), 'tonnage' (same top weight, weights vary or differ per set),
   or 'reps' (no weights, or the same weight every set). */
function entryDelta(cur, prev) {
  var wc = maxWeight(cur), wp = maxWeight(prev);
  if (wc !== null && wp !== null) {
    if (wc !== wp) return { kind: 'top', delta: Math.round((wc - wp) * 100) / 100 };
    if (!uniformWeight(cur) || !uniformWeight(prev)) {
      return { kind: 'tonnage', delta: Math.round((tonnage(cur) - tonnage(prev)) * 100) / 100 };
    }
  }
  return { kind: 'reps', delta: totalReps(cur) - totalReps(prev) };
}

/* 'better' | 'same' | 'worse' — a heavier top set wins; at the same top
   weight more kilograms moved (or more reps / seconds) wins. */
function compareEntries(cur, prev) {
  var d = entryDelta(cur, prev).delta;
  return d > 0 ? 'better' : d < 0 ? 'worse' : 'same';
}

function compareText(cur, prev, ex) {
  var d = entryDelta(cur, prev);
  var sign = d.delta > 0 ? '+' : '';
  if (d.kind === 'top') return (d.delta > 0 ? 'Heavier top set: ' : 'Lighter top set: ') + sign + d.delta + ' kg';
  if (d.delta === 0) return 'Same as last time';
  var what = d.kind === 'tonnage' ? ' kg lifted' : ' ' + measureUnit(ex);
  return (d.delta > 0 ? 'Better than last time: ' : 'Below last time: ') + sign + d.delta + what;
}

/* "+2 reps" / "-2 kg" / "+24 kg lifted" / "same" — for tight rows. */
function compareShort(cur, prev, ex) {
  var d = entryDelta(cur, prev);
  if (d.delta === 0 && d.kind !== 'top') return 'same';
  var sign = d.delta > 0 ? '+' : '';
  if (d.kind === 'top') return sign + d.delta + ' kg';
  if (d.kind === 'tonnage') return sign + d.delta + ' kg lifted';
  return sign + d.delta + ' ' + measureUnit(ex);
}

/* "12 kg · 11 · 11 · 10", "14×8 · 13×10 · 13×10" when weights vary, and no
   weight at all for bodyweight work. */
function entrySummary(entry, ex) {
  if ((ex && ex.unit === 'bodyweight') || !uniformWeight(entry)) return repsList(entry, ex);
  return entryWeightText(entry) + ' · ' + repsList(entry, ex);
}

/* Your best ever on an exercise, by the same ordering as compareEntries. */
function bestEntryFor(exId) {
  var best = null;
  entriesFor(exId).forEach(function (r) {
    if (r.entry.outcome === 'fail') return;
    if (!best || compareEntries(r.entry, best.entry) === 'better') best = r;
  });
  return best;
}

function pendingCount() {
  return state.sessions.filter(function (s) { return !s.synced; }).length;
}

/* ------------------------------------------------------------------ *
 * The schedule: train, rest, train, rest — alternating days.
 * ------------------------------------------------------------------ */

function todayKey() { return isoDay(new Date().toISOString()); }

function dayDiff(fromKey, toKey) {
  var a = new Date(fromKey + 'T00:00:00');
  var b = new Date(toKey + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/* The next day in the rotation after `day`: push-a, pull-a, push-b, pull-b.
   A day that is no longer in routine.json (an old plain 'push') hands over to
   the first day of the other family, so the push/pull rhythm is kept. */
function nextDayAfter(day) {
  var keys = dayKeys();
  if (!keys.length) return day;
  var i = keys.indexOf(day);
  if (i >= 0) return keys[(i + 1) % keys.length];
  var fam = dayFamily(day);
  for (var k = 0; k < keys.length; k++) if (dayFamily(keys[k]) !== fam) return keys[k];
  return keys[0];
}

function shiftDayKey(key, n) {
  var d = new Date(key + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDay(d.toISOString());
}

/* status: 'train' | 'rest' | 'done' | 'skipped' */
function scheduleToday() {
  var today = todayKey();
  var last = sessionsDesc()[0];

  if (!last) {
    var first = dayKeys()[0];
    if (state.skips[today]) return { status: 'skipped', day: first, nextIn: 1 };
    return { status: 'train', day: first, overdue: 0 };
  }

  var since = dayDiff(isoDay(last.date), today);
  var next = nextDayAfter(last.day);

  if (since <= 0) return { status: 'done', day: last.day, next: next, nextIn: 2 };
  if (since === 1) return { status: 'rest', day: next, nextIn: 1 };
  if (state.skips[today]) return { status: 'skipped', day: next, nextIn: 1 };
  return { status: 'train', day: next, overdue: since - 2 };
}

/* The schedule projected forward: train, rest, train, rest, alternating. */
function projectedPlan(horizonDays) {
  var out = {};
  var plan = scheduleToday();
  var today = todayKey();
  var date, day;

  if (plan.status === 'train') { date = today; day = plan.day; }
  else if (plan.status === 'done') { date = shiftDayKey(today, 2); day = plan.next; }
  else { date = shiftDayKey(today, 1); day = plan.day; }   /* rest or skipped */

  var limit = shiftDayKey(today, horizonDays);
  var guard = 0;
  while (date <= limit && guard++ < 400) {
    out[date] = day;
    date = shiftDayKey(date, 2);
    day = nextDayAfter(day);
  }
  return out;
}

/* One month of cells: what happened in the past, what is planned ahead. */
function calendarMonth(offset) {
  var now = new Date();
  var base = new Date(now.getFullYear(), now.getMonth() + (offset || 0), 1);
  var year = base.getFullYear();
  var month = base.getMonth();

  var done = {};
  state.sessions.forEach(function (s) { done[isoDay(s.date)] = s; });
  var planned = projectedPlan(180);
  var today = todayKey();

  var lead = (base.getDay() + 6) % 7;                    /* Monday-first */
  var total = new Date(year, month + 1, 0).getDate();

  var cells = [];
  var i;
  for (i = 0; i < lead; i++) cells.push(null);

  for (var d = 1; d <= total; d++) {
    var key = year + '-' + pad2(month + 1) + '-' + pad2(d);
    var cell = { key: key, num: d, isToday: key === today };
    if (done[key]) { cell.kind = 'done'; cell.day = done[key].day; cell.id = done[key].id; }
    else if (state.skips[key]) { cell.kind = 'skip'; cell.day = state.skips[key]; }
    else if (planned[key]) { cell.kind = 'plan'; cell.day = planned[key]; }
    else { cell.kind = 'rest'; }
    cells.push(cell);
  }
  while (cells.length % 7) cells.push(null);

  return {
    label: base.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    cells: cells
  };
}

function skipToday() {
  var plan = scheduleToday();
  state.skips[todayKey()] = plan.day;
  saveSkips();
  markDirty();
  render();
  syncNow(false);
}

function unskipToday() {
  delete state.skips[todayKey()];
  saveSkips();
  markDirty();
  render();
  syncNow(false);
}

function deleteSession(id) {
  var s = state.sessions.filter(function (x) { return x.id === id; })[0];
  if (!s) return;
  if (!confirm('Permanently delete the ' + s.day.toUpperCase() + ' session from ' +
               prettyDate(s.date) + '?\n\nThis removes it here and from the cloud on the next sync.')) return;
  state.sessions = state.sessions.filter(function (x) { return x.id !== id; });
  if (!saveSessions()) { state.sessions.push(s); return; }
  if (state.history.expanded === id) state.history.expanded = null;
  markDirty();
  render();
  syncNow(false);
}

function deleteSkip(key) {
  if (!confirm('Remove the skipped day ' + key + '?')) return;
  delete state.skips[key];
  saveSkips();
  markDirty();
  render();
  syncNow(false);
}

/* ------------------------------------------------------------------ *
 * Progress overview
 * ------------------------------------------------------------------ */

function progressStats() {
  var today = todayKey();
  var cutoff = shiftDayKey(today, -29);

  var last30 = state.sessions.filter(function (s) { return isoDay(s.date) >= cutoff; }).length;
  var skipped30 = Object.keys(state.skips).filter(function (k) { return k >= cutoff; }).length;

  /* In the most recent session, how many exercises beat their previous entry. */
  var latest = sessionsDesc()[0];
  var improved = [];
  if (latest) {
    (latest.entries || []).forEach(function (e) {
      var prev = entryBefore(e.exerciseId, latest);
      if (prev && compareEntries(e, prev.entry) === 'better') improved.push(e.exerciseId);
    });
  }

  /* Rolling 7-day buckets, oldest first, ending today. */
  var weeks = [];
  for (var w = 7; w >= 0; w--) {
    var end = shiftDayKey(today, -7 * w);
    var start = shiftDayKey(end, -6);
    weeks.push({
      label: start.slice(5).replace('-', '/'),
      count: state.sessions.filter(function (s) {
        var d = isoDay(s.date);
        return d >= start && d <= end;
      }).length
    });
  }

  /* Everything that has moved off its routine.json seed. */
  var moved = [];
  var seen = {};
  dayKeys().forEach(function (day) {
    state.routine.days[day].exercises.forEach(function (seed) {
      if (seen[seed.id]) return;
      seen[seed.id] = true;
      var text = overrideText(seed);
      if (text) moved.push({ name: seed.name, text: text });
    });
  });

  return {
    total: state.sessions.length,
    last30: last30,
    skipped30: skipped30,
    improved: improved,
    latest: latest,
    weeks: weeks,
    moved: moved
  };
}

/* "14 → 16 kg · 8-10 → 8-12 reps" against the routine.json seed, or ''. */
function overrideText(seed) {
  var now = effective(seed);
  if (!now.overridden) return '';
  var bits = [];
  var unit = measureUnit(now);
  if (now.sets !== seed.sets) bits.push(seed.sets + ' → ' + now.sets + ' sets');
  if (String(now.targetReps) !== String(seed.targetReps)) bits.push(seed.targetReps + ' → ' + now.targetReps + ' ' + unit);
  if (now.weightKg !== seed.weightKg) {
    bits.push((seed.weightKg === null ? '—' : seed.weightKg) + ' → ' + (now.weightKg === null ? '—' : now.weightKg) + ' kg');
  }
  return bits.join(' · ');
}

/* ------------------------------------------------------------------ *
 * Store shape used for cloud sync, export and import
 * ------------------------------------------------------------------ */

function buildStore() {
  return {
    app: 'workout-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: sessionsAsc(),
    overrides: state.overrides,
    order: state.order,
    skips: state.skips
  };
}

function csvCell(v) {
  var s = (v === null || v === undefined) ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCSV() {
  var rows = [['date', 'day', 'exercise', 'weightKg', 'setNumber', 'reps', 'setStatus', 'outcome']];
  sessionsAsc().forEach(function (s) {
    (s.entries || []).forEach(function (e) {
      var reps = e.reps || [];
      var missed = e.missed || [];
      if (!reps.length) {
        rows.push([isoDay(s.date), s.day, exerciseName(e.exerciseId), e.weightKg, '', '', '', e.outcome]);
      }
      reps.forEach(function (r, i) {
        rows.push([isoDay(s.date), s.day, exerciseName(e.exerciseId), setWeight(e, i), i + 1,
                   missed[i] ? '' : r, missed[i] ? 'missed' : 'done', e.outcome]);
      });
    });
  });
  return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * GitHub Contents API
 * ------------------------------------------------------------------ */

function b64encodeUtf8(str) {
  var bytes = new TextEncoder().encode(str);
  var bin = '';
  var CHUNK = 0x8000;
  for (var i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decodeUtf8(b64) {
  var bin = atob(String(b64).replace(/\s/g, ''));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function credsReady() {
  var c = state.creds;
  return !!(c.username && c.repo && c.token);
}

function ghUrl(path) {
  var c = state.creds;
  return 'https://api.github.com/repos/' + encodeURIComponent(c.username) + '/' +
         encodeURIComponent(c.repo) + '/contents/' + path;
}

function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + state.creds.token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function ghError(res, body) {
  var err = new Error((body && body.message) || ('GitHub returned ' + res.status));
  err.status = res.status;
  return err;
}

/* Returns { sha, text } or null when the file does not exist yet. */
function ghGetFile(path) {
  var branch = state.creds.branch || 'main';
  var url = ghUrl(path) + '?ref=' + encodeURIComponent(branch) + '&t=' + Date.now();
  return fetch(url, { headers: ghHeaders(), cache: 'no-store' }).then(function (res) {
    if (res.status === 404) return null;
    return res.json().then(function (body) {
      if (!res.ok) throw ghError(res, body);
      return { sha: body.sha, text: body.content ? b64decodeUtf8(body.content) : '' };
    });
  });
}

function ghPutFile(path, text, sha, message) {
  var payload = {
    message: message,
    content: b64encodeUtf8(text),
    branch: state.creds.branch || 'main'
  };
  if (sha) payload.sha = sha;
  return fetch(ghUrl(path), {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
    body: JSON.stringify(payload)
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (body) {
      if (!res.ok) throw ghError(res, body);
      return body;
    });
  });
}

/* GET for the sha, PUT; on a sha conflict re-GET and retry exactly once. */
function ghUpsert(path, text, message) {
  return ghGetFile(path).then(function (existing) {
    return ghPutFile(path, text, existing ? existing.sha : null, message);
  }).catch(function (err) {
    if (err.status === 409 || err.status === 422) {
      return ghGetFile(path).then(function (again) {
        return ghPutFile(path, text, again ? again.sha : null, message);
      });
    }
    throw err;
  });
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

function syncNow(userInitiated) {
  if (state.sync.busy) return Promise.resolve();

  if (!credsReady()) {
    if (userInitiated) showBanner('No GitHub credentials yet — add them in Settings to sync.');
    renderTopbar();
    return Promise.resolve();
  }
  if (!navigator.onLine) {
    if (userInitiated) showBanner('Offline — your sessions are saved locally and will sync later.');
    renderTopbar();
    return Promise.resolve();
  }
  if (!pendingCount() && !state.dirty && !userInitiated) { renderTopbar(); return Promise.resolve(); }

  var pushed = state.sessions.filter(function (s) { return !s.synced; }).map(function (s) { return s.id; });
  var stamp = new Date().toISOString();

  state.sync.busy = true;
  state.sync.error = '';
  renderTopbar();

  return ghUpsert('data/log.json', JSON.stringify(buildStore(), null, 2),
                  'workout log ' + stamp)
    .then(function () {
      return ghUpsert('data/log.csv', buildCSV(), 'workout log csv ' + stamp);
    })
    .then(function () {
      /* Only mark what we actually pushed; anything logged mid-sync stays pending. */
      var ids = {};
      pushed.forEach(function (id) { ids[id] = true; });
      state.sessions.forEach(function (s) { if (ids[s.id]) s.synced = true; });
      saveSessions();
      clearDirty();
      state.sync.error = '';
    })
    .catch(function (err) {
      if (err.status === 401 || err.status === 403) {
        state.sync.error = 'auth';
        showBanner('GitHub auth failed — check your token in Settings.');
      } else if (err.status === 404) {
        /* GitHub reports a repo the token cannot see as "not found" rather than
           "forbidden", so a bare 404 here is nearly always a config problem. */
        state.sync.error = 'notfound';
        showBanner('GitHub cannot see ' + state.creds.username + '/' + state.creds.repo +
                   ' on branch "' + (state.creds.branch || 'main') + '". Check three things in ' +
                   'Settings: the repo name is exactly right, the branch exists, and your ' +
                   'fine-grained token lists this repo under "Repository access" — a private ' +
                   'repo the token was not granted also reports as not found.');
      } else {
        state.sync.error = 'net';
        if (userInitiated) showBanner('Sync failed: ' + err.message + ' — sessions stay saved locally.');
      }
    })
    .then(function () {
      state.sync.busy = false;
      renderTopbar();
      if (state.screen === 'settings') render();
    });
}

function pullFromCloud() {
  if (!credsReady()) { showBanner('Add GitHub credentials in Settings first.'); return; }
  ghGetFile('data/log.json').then(function (file) {
    if (!file) { showBanner('No data/log.json in that repo yet — nothing to pull.'); return; }
    var store;
    try { store = JSON.parse(file.text); }
    catch (err) { showBanner('data/log.json could not be parsed: ' + err.message); return; }
    var sessions = (store && store.sessions) || [];
    var ok = confirm('Replace everything on this device with the cloud copy?\n\n' +
                     sessions.length + ' sessions in the cloud, ' + state.sessions.length + ' on this device.\n' +
                     'This cannot be undone.');
    if (!ok) return;
    applyStore(store, true);
    showBanner('Pulled ' + state.sessions.length + ' sessions from the cloud.');
    render();
  }).catch(function (err) {
    if (err.status === 401 || err.status === 403) showBanner('GitHub auth failed — check your token in Settings.');
    else showBanner('Could not pull from the cloud: ' + err.message);
  });
}

/* markSynced: true after a cloud pull, false after a local file import. */
function applyStore(store, markSynced) {
  var sessions = (store && Array.isArray(store.sessions)) ? store.sessions : [];
  sessions = sessions.filter(function (s) { return s && s.id && s.date; });
  sessions.forEach(function (s) {
    s.synced = !!markSynced;
    if (!Array.isArray(s.entries)) s.entries = [];
  });
  state.sessions = sessions;
  state.overrides = (store && store.overrides && typeof store.overrides === 'object') ? store.overrides : {};
  state.order = (store && store.order && typeof store.order === 'object') ? store.order : {};
  state.skips = (store && store.skips && typeof store.skips === 'object') ? store.skips : {};
  saveSessions();
  saveOverrides();
  saveOrder();
  saveSkips();
  if (markSynced) clearDirty(); else markDirty();
  if (!markSynced) syncNow(false);
}

/* ------------------------------------------------------------------ *
 * Session flow
 * ------------------------------------------------------------------ */

function startSession(day) {
  if (state.draft && state.draft.entries.length &&
      !confirm('An unfinished ' + state.draft.day.toUpperCase() + ' session is still open. Discard it and start a new one?')) {
    return;
  }
  state.draft = { id: uid(), date: new Date().toISOString(), day: day, current: null, entries: [] };
  state.ui.editTarget = null;
  saveDraft();
  state.screen = 'session';
  window.scrollTo(0, 0);
  render();
}

function currentExercise() {
  if (!state.draft || !state.draft.current) return null;
  return dayExercises(state.draft.day).filter(function (ex) { return ex.id === state.draft.current; })[0] || null;
}

function draftEntryFor(exId) {
  if (!state.draft) return null;
  return state.draft.entries.filter(function (e) { return e.exerciseId === exId; })[0] || null;
}

function openExercise(exId) {
  if (!state.draft) return;
  state.draft.current = exId;
  state.ui.editTarget = null;
  saveDraft();
  window.scrollTo(0, 0);
  render();
}

function closeExercise() {
  if (!state.draft) return;
  state.draft.current = null;
  state.ui.editTarget = null;
  saveDraft();
  window.scrollTo(0, 0);
  render();
}


/* The reps every set must reach to count as on target: the bottom of a range.
   Whether you did better than last time is a separate line. "max" has no
   number: attempting it is the target. */
function targetRepsForSuccess(ex) {
  return repsBottom(ex.targetReps);
}

/* success = every set attempted and on target
   short   = every set attempted, at least one under target (not a failure)
   fail    = at least one set you could not even attempt */
function computeOutcome(ex, reps, missed) {
  var i;
  for (i = 0; i < ex.sets; i++) if (missed[i]) return 'fail';

  var target = targetRepsForSuccess(ex);
  if (target === null) return 'success';

  for (i = 0; i < ex.sets; i++) {
    if (reps[i] === null || reps[i] === undefined || reps[i] < target) return 'short';
  }
  return 'success';
}

function outcomeLabel(outcome, ex, reps, missed) {
  if (outcome === 'fail') {
    var n = (missed || []).filter(Boolean).length;
    return n + ' set' + (n === 1 ? '' : 's') + ' not attempted';
  }
  if (outcome === 'short') {
    var target = targetRepsForSuccess(ex);
    var worst = 0;
    for (var i = 0; i < ex.sets; i++) {
      var r = (reps[i] === null || reps[i] === undefined) ? 0 : reps[i];
      if (target - r > worst) worst = target - r;
    }
    return worst + ' ' + measureUnit(ex) + ' short of target';
  }
  return 'On target';
}

/* Reps must be typed; a kg box left blank means the grey baseline it shows. */
function readSessionInputs(ex) {
  var reps = [];
  var missed = [];
  var weights = [];
  var hasWeight = ex.unit !== 'bodyweight';
  for (var i = 0; i < ex.sets; i++) {
    var el = document.getElementById('set-' + i);
    var wEl = document.getElementById('w-' + i);
    var btn = document.getElementById('miss-' + i);
    var isMissed = !!(btn && btn.getAttribute('aria-pressed') === 'true');
    missed.push(isMissed);
    reps.push(isMissed ? null : (el ? num(el.value) : null));
    var w = null;
    if (hasWeight && wEl) w = wEl.value.trim() === '' ? num(wEl.getAttribute('data-base')) : num(wEl.value);
    weights.push(isMissed ? null : w);
  }
  var present = weights.filter(function (w) { return w !== null; });
  return {
    reps: reps, missed: missed,
    weightsKg: hasWeight ? weights : null,
    weightKg: present.length ? Math.max.apply(null, present) : null
  };
}

/* The first attempted set with no reps typed, or -1. */
function firstBlankSet(vals) {
  for (var i = 0; i < vals.reps.length; i++) {
    if (!vals.missed[i] && vals.reps[i] === null) return i;
  }
  return -1;
}

/* Lock in: the score for this exercise is recorded in the draft and the list
   comes back so you can pick whatever is next. */
function lockEntry() {
  var ex = currentExercise();
  if (!ex || !state.draft) return;
  var vals = readSessionInputs(ex);
  var blank = firstBlankSet(vals);
  if (blank >= 0) {
    showBanner('Set ' + (blank + 1) + ' has no ' + measureUnit(ex) + ' yet — type what you did, or tap ✕ if you could not attempt it.');
    var el = document.getElementById('set-' + blank);
    if (el) el.focus();
    return;
  }
  var entry = {
    exerciseId: ex.id,
    weightKg: vals.weightKg,
    reps: vals.reps,
    outcome: computeOutcome(ex, vals.reps, vals.missed)
  };
  if (vals.weightsKg) entry.weightsKg = vals.weightsKg;
  /* Only carry the array when something was actually missed. */
  if (vals.missed.some(Boolean)) entry.missed = vals.missed;

  var idx = -1;
  state.draft.entries.forEach(function (e, i) { if (e.exerciseId === ex.id) idx = i; });
  if (idx >= 0) state.draft.entries[idx] = entry; else state.draft.entries.push(entry);

  state.draft.current = null;
  state.ui.editTarget = null;
  saveDraft();
  window.scrollTo(0, 0);
  render();
}

function finishSession() {
  var d = state.draft;
  if (!d) return;
  if (!d.entries.length) {
    showBanner('Nothing is locked in yet — lock in at least one exercise, or Abandon.');
    return;
  }
  var pending = dayExercises(d.day).filter(function (ex) { return !draftEntryFor(ex.id); });
  if (pending.length && !confirm(pending.length + ' exercise' + (pending.length === 1 ? ' is' : 's are') +
      ' not locked in and will not be logged:\n\n' +
      pending.map(function (ex) { return '• ' + ex.name; }).join('\n') + '\n\nFinish anyway?')) return;

  var order = {};
  dayExercises(d.day).forEach(function (ex, i) { order[ex.id] = i; });
  var entries = d.entries.slice().sort(function (a, b) {
    return (order[a.exerciseId] === undefined ? 99 : order[a.exerciseId]) -
           (order[b.exerciseId] === undefined ? 99 : order[b.exerciseId]);
  });

  var session = { id: d.id, date: d.date, day: d.day, synced: false, entries: entries };
  state.sessions.push(session);

  if (!saveSessions()) {
    /* The write failed and was reported. Keep the draft so nothing is lost. */
    state.sessions = state.sessions.filter(function (s) { return s.id !== session.id; });
    return;
  }
  state.draft = null;
  saveDraft();
  state.screen = 'home';
  window.scrollTo(0, 0);
  render();
  syncNow(false);
}

/* Abandoning means the session did not happen. Nothing is logged, and the day
   is marked as skipped so the calendar shows it rather than swallowing it. */
function abandonSession() {
  if (!state.draft) return;
  var day = state.draft.day;
  var key = isoDay(state.draft.date);
  if (!confirm('Abandon this ' + day.toUpperCase() + ' session?\n\n' +
               'Nothing is logged. ' + prettyDate(key + 'T12:00:00') +
               ' is recorded as a skipped day, and the workout is still owed.')) return;

  state.skips[key] = day;
  saveSkips();
  state.draft = null;
  saveDraft();
  markDirty();
  state.screen = 'home';
  window.scrollTo(0, 0);
  render();
  syncNow(false);
}

/* ------------------------------------------------------------------ *
 * Targets and order — yours to set, session by session
 * ------------------------------------------------------------------ */

/* Reads the inline target editor for exId and stores it as an override. */
function saveTarget(exId) {
  var ex = exerciseById(exId);
  if (!ex) return;
  var setsEl = document.getElementById('tgt-sets-' + exId);
  var repsEl = document.getElementById('tgt-reps-' + exId);
  var wEl = document.getElementById('tgt-weight-' + exId);

  var sets = num(setsEl && setsEl.value);
  if (sets === null || sets < 1 || sets > 12 || sets !== Math.floor(sets)) {
    showBanner('Sets must be a whole number from 1 to 12.'); return;
  }
  var target = parseTarget(repsEl && repsEl.value);
  if (target === null) {
    showBanner('Target must be a number (10), a range (8-12) or "max".'); return;
  }
  var weight = null;
  if (wEl) {
    weight = wEl.value.trim() === '' ? null : num(wEl.value);
    if (wEl.value.trim() !== '' && (weight === null || weight < 0)) { showBanner('Weight must be a number of kg.'); return; }
  }

  state.overrides[exId] = { sets: sets, targetReps: target, weightKg: weight };
  saveOverrides();
  markDirty();
  state.ui.editTarget = null;
  render();
  syncNow(false);
}

function resetTarget(exId) {
  delete state.overrides[exId];
  saveOverrides();
  markDirty();
  state.ui.editTarget = null;
  render();
  syncNow(false);
}

function resetOverrides() {
  if (!confirm('Drop every edited target and fall back to routine.json?')) return;
  state.overrides = {};
  saveOverrides();
  markDirty();
  render();
  syncNow(false);
}

/* Moves exId one step up or down within `day`; the new order sticks. */
function moveExercise(day, exId, dir) {
  var ids = dayExercises(day).map(function (ex) { return ex.id; });
  var i = ids.indexOf(exId);
  var j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  ids[i] = ids[j];
  ids[j] = exId;
  state.order[day] = ids;
  saveOrder();
  markDirty();
  render();
  syncNow(false);
}

function resetOrder(day) {
  delete state.order[day];
  saveOrder();
  markDirty();
  render();
  syncNow(false);
}

/* ------------------------------------------------------------------ *
 * Charts — one measure per chart, never two scales on one axis.
 * ------------------------------------------------------------------ */

function sparkline(values, labels, color) {
  var W = 320, H = 96, L = 34, R = 8, T = 12, B = 20;
  var pts = values.map(function (v, i) { return { v: v, i: i }; })
                  .filter(function (p) { return p.v !== null && p.v !== undefined && isFinite(p.v); });
  if (!pts.length) return '<p class="muted">No numbers logged yet.</p>';

  var vals = pts.map(function (p) { return p.v; });
  var min = Math.min.apply(null, vals);
  var max = Math.max.apply(null, vals);
  var span = (max - min) || 1;
  var pad = (max === min) ? 1 : span * 0.15;
  var lo = min - pad, hi = max + pad;

  var n = values.length;
  var x = function (i) { return n <= 1 ? (L + (W - L - R) / 2) : L + (i / (n - 1)) * (W - L - R); };
  var y = function (v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); };

  var line = pts.map(function (p) { return x(p.i).toFixed(1) + ',' + y(p.v).toFixed(1); }).join(' ');
  var dots = pts.map(function (p) {
    return '<circle cx="' + x(p.i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) +
           '" r="4" fill="' + color + '" stroke="var(--surface-1)" stroke-width="2"><title>' +
           esc(labels[p.i] + ': ' + p.v) + '</title></circle>';
  }).join('');

  var first = pts[0], last = pts[pts.length - 1];
  var endLabel = '';
  if (pts.length > 1) {
    endLabel = '<text x="' + (x(last.i) - 6).toFixed(1) + '" y="' + (y(last.v) - 10).toFixed(1) +
               '" text-anchor="end" fill="var(--text-primary)" font-size="12" font-weight="700">' +
               esc(last.v) + '</text>';
  }

  /* One gridline when everything is flat, two when there is a spread. */
  var levels = (max === min) ? [max] : [max, min];
  var axis = levels.map(function (v) {
    return '<line x1="' + L + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(v).toFixed(1) +
           '" stroke="var(--line)" stroke-width="1"/>' +
           '<text x="' + (L - 6) + '" y="' + (y(v) + 4).toFixed(1) +
           '" text-anchor="end" fill="var(--text-muted)" font-size="11">' + esc(v) + '</text>';
  }).join('');

  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" preserveAspectRatio="xMidYMid meet" ' +
         'aria-label="' + esc(labels[first.i] + ' to ' + labels[last.i] + ', ' + first.v + ' to ' + last.v) + '">' +
         axis +
         (pts.length > 1 ? '<polyline points="' + line + '" fill="none" stroke="' + color +
            '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : '') +
         dots + endLabel +
         '<text x="' + L + '" y="' + (H - 4) + '" fill="var(--text-muted)" font-size="11">' + esc(labels[0]) + '</text>' +
         '<text x="' + (W - R) + '" y="' + (H - 4) + '" text-anchor="end" fill="var(--text-muted)" font-size="11">' + esc(labels[n - 1]) + '</text>' +
         '</svg>';
}

function barChart(values, labels) {
  var W = 320, H = 92, T = 14, B = 20, GAP = 6;
  var n = values.length;
  if (!n) return '';
  var max = Math.max.apply(null, values.concat([1]));
  var slot = W / n;
  var bw = Math.max(6, slot - GAP);

  var bars = values.map(function (v, i) {
    var x = i * slot + (slot - bw) / 2;
    var full = H - T - B;
    var h = v === 0 ? 2 : Math.max(4, (v / max) * full);
    var y = T + (full - h);
    var isLast = i === n - 1;
    return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
           '" height="' + h.toFixed(1) + '" rx="3" fill="' +
           (v === 0 ? 'var(--line)' : (isLast ? 'var(--accent)' : 'var(--accent-dim)')) + '">' +
           '<title>' + esc(labels[i] + ': ' + v + ' session' + (v === 1 ? '' : 's')) + '</title></rect>' +
           (v > 0 ? '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) +
             '" text-anchor="middle" fill="var(--text-' + (isLast ? 'primary' : 'muted') +
             ')" font-size="11" font-weight="' + (isLast ? '700' : '400') + '">' + v + '</text>' : '');
  }).join('');

  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" preserveAspectRatio="xMidYMid meet" ' +
    'aria-label="Sessions per week for the last ' + n + ' weeks: ' + esc(values.join(', ')) + '">' +
    '<line x1="0" y1="' + (H - B) + '" x2="' + W + '" y2="' + (H - B) + '" stroke="var(--line)" stroke-width="1"/>' +
    bars +
    '<text x="0" y="' + (H - 4) + '" fill="var(--text-muted)" font-size="11">' + esc(labels[0]) + '</text>' +
    '<text x="' + W + '" y="' + (H - 4) + '" text-anchor="end" fill="var(--text-muted)" font-size="11">this week</text>' +
    '</svg>';
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderTopbar() {
  var titles = { home: 'Workout', session: '', history: 'History', settings: 'Settings', routine: 'Routine' };
  var title = titles[state.screen];
  if (state.screen === 'session' && state.draft) title = dayName(state.draft.day).toUpperCase();
  document.getElementById('topbarTitle').textContent = title || 'Workout';

  var back = document.getElementById('topbarBack');
  back.hidden = (state.screen === 'home' || state.screen === 'session');

  var pill = document.getElementById('syncPill');
  var pend = pendingCount();
  var label, st;
  if (state.sync.busy)              { label = 'Syncing…'; st = 'pending'; }
  else if (state.sync.error === 'auth') { label = 'Auth failed'; st = 'error'; }
  else if (state.sync.error === 'notfound') { label = 'Repo not found'; st = 'error'; }
  else if (!navigator.onLine)       { label = 'Offline'; st = 'offline'; }
  else if (state.sync.error)        { label = pend ? pend + ' pending' : 'Sync error'; st = 'error'; }
  else if (pend > 0)                { label = pend + ' pending'; st = 'pending'; }
  else if (state.dirty)             { label = 'Changes pending'; st = 'pending'; }
  else                              { label = 'Synced'; st = 'synced'; }
  pill.textContent = label;
  pill.setAttribute('data-state', st);
  pill.setAttribute('title', 'Tap to sync now');
}

function render() {
  renderTopbar();
  var app = document.getElementById('app');
  var html = '';
  if (!state.routine)                 html = viewLoading();
  else if (state.screen === 'session') html = viewSession();
  else if (state.screen === 'history') html = viewHistory();
  else if (state.screen === 'settings') html = viewSettings();
  else if (state.screen === 'routine') html = viewRoutine();
  else                                 html = viewHome();
  app.innerHTML = html;
  afterRender();
}

function afterRender() {
  if (state.screen === 'history' && state.history.tab === 'exercise') {
    var sel = document.getElementById('ex-select');
    if (sel) sel.value = state.history.exerciseId;
  }
  if (state.screen === 'session') updateVerdictHint();
}

/* Recomputes the verdict and vs-last-time lines from the live inputs. Touches
   only those elements — a full re-render mid-set would steal focus from the keypad. */
function updateVerdictHint() {
  var el = document.getElementById('verdict-hint');
  if (!el) return;
  var ex = currentExercise();
  if (!ex) return;
  var vals = readSessionInputs(ex);
  var cmp = document.getElementById('compare-hint');
  var blank = firstBlankSet(vals);
  if (blank >= 0) {
    el.className = 'verdict-hint';
    el.textContent = 'Fill in set ' + (blank + 1);
    if (cmp) cmp.hidden = true;
    return;
  }
  var outcome = computeOutcome(ex, vals.reps, vals.missed);
  el.className = 'verdict-hint is-' + outcome;
  el.textContent = outcomeLabel(outcome, ex, vals.reps, vals.missed);

  if (!cmp) return;
  var last = lastEntryFor(ex.id);
  if (!last) { cmp.hidden = true; return; }
  var cur = { weightKg: vals.weightKg, weightsKg: vals.weightsKg, reps: vals.reps, missed: vals.missed };
  cmp.hidden = false;
  cmp.className = 'compare-hint is-' + compareEntries(cur, last.entry);
  cmp.textContent = compareText(cur, last.entry, ex);
}

function viewLoading() {
  return '<div class="card center"><p>Loading routine…</p>' +
         '<p class="muted">If this sticks, routine.json could not be read.</p></div>';
}

/* ---------------- Home ---------------- */

function dayName(day) {
  return (state.routine && state.routine.days[day]) ? state.routine.days[day].name : day;
}

/* "tomorrow", "Tue" — how to refer to a day n days out. */
function whenText(n) {
  if (n <= 0) return 'today';
  if (n === 1) return 'tomorrow';
  var d = new Date();
  d.setDate(d.getDate() + n);
  return 'on ' + d.toLocaleDateString(undefined, { weekday: 'long' });
}

function viewTodayCard(plan) {
  var name = dayName(plan.day).toUpperCase();

  if (plan.status === 'done') {
    return '<div class="today-card is-done">' +
      '<div class="today-label">Today</div>' +
      '<div class="today-head">' + esc(dayName(plan.day).toUpperCase()) + ' done ✓</div>' +
      '<div class="today-sub">Rest tomorrow · ' + esc(dayName(plan.next).toUpperCase()) + ' ' +
        esc(whenText(plan.nextIn)) + '</div></div>';
  }

  if (plan.status === 'rest') {
    return '<div class="today-card is-rest">' +
      '<div class="today-label">Today</div>' +
      '<div class="today-head">Rest day</div>' +
      '<div class="today-sub">' + esc(name) + ' ' + esc(whenText(plan.nextIn)) + '</div></div>';
  }

  if (plan.status === 'skipped') {
    return '<div class="today-card is-skipped">' +
      '<div class="today-label">Today</div>' +
      '<div class="today-head">Skipped</div>' +
      '<div class="today-sub">' + esc(name) + ' ' + esc(whenText(plan.nextIn)) + ' instead</div>' +
      '<button class="btn btn-ghost btn-small today-action" data-act="unskip" type="button">Undo — I can train</button>' +
      '</div>';
  }

  var overdue = plan.overdue > 0
    ? '<span class="today-flag">' + plan.overdue + ' day' + (plan.overdue === 1 ? '' : 's') + ' late</span>'
    : '';
  return '<div class="today-card is-train">' +
    '<div class="today-label">Today ' + overdue + '</div>' +
    '<div class="today-head">' + esc(name) + '</div>' +
    '<div class="today-sub">Tap ' + esc(name) + ' below to start.</div>' +
    '<button class="btn btn-ghost btn-small today-action" data-act="skip" type="button">Can\'t today</button>' +
    '</div>';
}

function viewCalendarCard() {
  var m = calendarMonth(state.ui.calOffset);
  var dows = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  var html = '<div class="card">' +
    '<div class="cal-head">' +
    '<button class="cal-nav" data-act="cal-prev" type="button" aria-label="Previous month">&#8249;</button>' +
    '<div class="cal-month">' + esc(m.label) + '</div>' +
    '<button class="cal-nav" data-act="cal-next" type="button" aria-label="Next month">&#8250;</button>' +
    '</div>';

  html += '<div class="cal-grid cal-dow">' +
    dows.map(function (d, i) { return '<div class="cal-dowcell" aria-hidden="true">' + d + '</div>'; }).join('') +
    '</div>';

  html += '<div class="cal-grid">' + m.cells.map(function (c) {
    if (!c) return '<div class="cal-cell is-blank"></div>';

    var cls = 'cal-cell is-' + c.kind + (c.day ? ' d-' + dayFamily(c.day) : '') + (c.isToday ? ' is-today' : '');
    var title = c.kind === 'done' ? dayName(c.day) + ' done'
              : c.kind === 'skip' ? dayName(c.day) + ' skipped'
              : c.kind === 'plan' ? dayName(c.day) + ' planned'
              : 'Rest';
    var label = esc(prettyDate(c.key + 'T12:00:00')) + ' — ' + esc(title);

    if (c.kind === 'done') {
      return '<button class="' + cls + '" data-act="cal-day" data-id="' + esc(c.id) +
             '" type="button" title="' + label + '" aria-label="' + label + '">' + c.num + '</button>';
    }
    return '<div class="' + cls + '" title="' + label + '" aria-label="' + label + '">' + c.num + '</div>';
  }).join('') + '</div>';

  html += '<div class="cal-legend">' +
    '<span class="leg"><i class="sw is-done d-push"></i>Push</span>' +
    '<span class="leg"><i class="sw is-done d-pull"></i>Pull</span>' +
    '<span class="leg"><i class="sw is-plan"></i>Planned</span>' +
    '<span class="leg"><i class="sw is-skip"></i>Skipped</span>' +
    '</div>';

  if (state.ui.calOffset !== 0) {
    html += '<button class="btn btn-ghost btn-small" style="margin-top:12px" data-act="cal-today" type="button">Back to this month</button>';
  }

  return html + '</div>';
}

function viewProgressCard() {
  var st = progressStats();

  if (!st.total) {
    return '<div class="card"><div class="card-title">Progress</div>' +
      '<p class="sub">Log your first session and this fills in.</p></div>';
  }

  var html = '<div class="card"><div class="card-title">Progress</div>';

  html += '<div class="stats">' +
    '<div class="stat"><span class="stat-num">' + st.total + '</span><span class="stat-label">Sessions</span></div>' +
    '<div class="stat"><span class="stat-num">' + st.last30 + '</span><span class="stat-label">Last 30 days</span></div>' +
    '<div class="stat"><span class="stat-num' + (st.improved.length ? ' is-up' : '') + '">' + st.improved.length +
      '</span><span class="stat-label">Beat last time</span></div>' +
    '</div>';

  var counts = st.weeks.map(function (w) { return w.count; });
  html += '<div class="chart-wrap"><div class="chart-title">Sessions per week</div>' +
          barChart(counts, st.weeks.map(function (w) { return w.label; })) + '</div>';

  if (st.improved.length) {
    html += '<div class="prog-block"><div class="chart-title">Improved in ' + esc(dayName(st.latest.day)) +
      ' · ' + esc(prettyDate(st.latest.date)) + '</div>' +
      st.improved.map(function (id) {
        var e = (st.latest.entries || []).filter(function (x) { return x.exerciseId === id; })[0];
        var prev = entryBefore(id, st.latest);
        return '<div class="prog-row"><span>' + esc(exerciseName(id)) + '</span>' +
               '<span class="prog-val is-up">' + esc(compareShort(e, prev.entry, exerciseById(id) || {})) + '</span></div>';
      }).join('') + '</div>';
  }

  if (st.moved.length) {
    html += '<div class="prog-block"><div class="chart-title">Targets changed since the start</div>' +
      st.moved.map(function (m) {
        return '<div class="prog-row"><span>' + esc(m.name) + '</span>' +
               '<span class="prog-val is-up">' + esc(m.text) + '</span></div>';
      }).join('') + '</div>';
  }

  if (st.skipped30) {
    html += '<p class="muted" style="margin:12px 0 0">' + st.skipped30 +
            ' day' + (st.skipped30 === 1 ? '' : 's') + ' skipped in the last 30.</p>';
  }

  return html + '</div>';
}

function viewHome() {
  var html = '';
  var plan = scheduleToday();

  if (state.draft && state.draft.entries.length) {
    var total = dayExercises(state.draft.day).length;
    html += '<button class="btn btn-primary" data-act="resume">Resume ' +
            esc(dayName(state.draft.day).toUpperCase()) + ' — ' +
            state.draft.entries.length + ' of ' + total + ' locked in</button>';
  }

  html += viewTodayCard(plan);

  html += '<div class="day-grid">' + dayKeys().map(function (day) {
    var d = state.routine.days[day];
    var last = lastSessionForDay(day);
    var sub = last ? 'Last ' + prettyDate(last.date) + ' · ' + daysAgo(last.date) : 'Not done yet';
    var isToday = (plan.status === 'train' && plan.day === day);
    return '<button class="day-btn' + (isToday ? ' is-today' : '') + '" data-day="' + esc(day) +
           '" data-family="' + esc(dayFamily(day)) + '" data-act="start" type="button">' +
           '<span class="day-name">' + esc(d.name.toUpperCase()) +
           (isToday ? '<span class="today-badge">Today</span>' : '') + '</span>' +
           (d.focus ? '<span class="day-focus">' + esc(d.focus) + '</span>' : '') +
           '<span class="day-last">' + esc(sub) + '</span></button>';
  }).join('') + '</div>';

  html += viewCalendarCard();
  html += viewProgressCard();

  html += '<div class="linkrow">' +
          '<button class="btn" data-act="go" data-screen="routine" type="button">Routine</button>' +
          '<button class="btn" data-act="go" data-screen="history" type="button">History</button>' +
          '<button class="btn" data-act="go" data-screen="settings" type="button">Settings</button>' +
          '</div>';

  return html;
}

/* ---------------- Session ---------------- */

function viewSession() {
  if (!state.draft) { state.screen = 'home'; return viewHome(); }
  var list = dayExercises(state.draft.day);
  if (!list.length) return '<div class="card">This day has no exercises in routine.json.</div>';
  return currentExercise() ? viewSessionExercise() : viewSessionList(list);
}

/* The day's exercises in your order. Open any of them; lock in a score;
   finish when you are done. */
function viewSessionList(list) {
  var day = state.draft.day;
  var done = state.draft.entries.length;
  var html = '';

  html += '<div>' +
          '<div class="progress-line"><span>' + done + ' of ' + list.length + ' locked in</span>' +
          '<span>' + esc(state.routine.days[day].focus || dayName(day)) + '</span></div>' +
          '<div class="progress-bar"><i style="width:' + ((done / list.length) * 100).toFixed(0) + '%"></i></div>' +
          '</div>';

  html += '<div class="ex-list">' + list.map(function (ex, i) {
    var rec = draftEntryFor(ex.id);
    var last = lastEntryFor(ex.id);
    var status;
    if (rec) {
      status = '<span class="ex-row-score">' + esc(entrySummary(rec, ex)) + '</span>' +
               (last ? '<span class="ex-row-cmp is-' + compareEntries(rec, last.entry) + '">' +
                       esc(compareText(rec, last.entry, ex)) + '</span>' : '');
    } else if (last) {
      status = '<span class="ex-row-last">Last: ' + esc(entrySummary(last.entry, ex)) + '</span>';
    } else {
      status = '<span class="ex-row-last">First time</span>';
    }
    return '<div class="ex-row' + (rec ? ' is-locked' : '') + '">' +
      '<div class="ex-row-move">' +
      '<button class="move-btn" data-act="move-ex" data-day="' + esc(day) + '" data-ex="' + esc(ex.id) + '" data-dir="-1" type="button"' +
        (i === 0 ? ' disabled' : '') + ' aria-label="Move up">&#9650;</button>' +
      '<button class="move-btn" data-act="move-ex" data-day="' + esc(day) + '" data-ex="' + esc(ex.id) + '" data-dir="1" type="button"' +
        (i === list.length - 1 ? ' disabled' : '') + ' aria-label="Move down">&#9660;</button>' +
      '</div>' +
      '<button class="ex-row-main" data-act="open-exercise" data-ex="' + esc(ex.id) + '" type="button">' +
      '<span class="ex-row-name">' + (rec ? '<span class="lock">✓</span>' : '') + esc(ex.name) + '</span>' +
      '<span class="ex-row-target">' + esc(targetText(ex)) + ' · ' + esc(weightText(ex)) + '</span>' +
      status +
      '</button></div>';
  }).join('') + '</div>';

  html += '<button class="btn btn-advance" data-act="finish" type="button">FINISH SESSION</button>';
  html += '<p class="muted center">' + (done < list.length
    ? 'Tap an exercise to log it. ▲▼ changes the order for every session.'
    : 'Everything is locked in. Finish saves the session.') + '</p>';

  html += '<div class="linkrow">' +
          '<button class="btn btn-danger" data-act="abandon" type="button">Abandon</button>' +
          '</div>';
  return html;
}

/* Inline editor for sets, target reps (or seconds) and weight. */
function targetEditorHtml(ex) {
  var id = esc(ex.id);
  var seconds = ex.measure === 'seconds';
  var hasWeight = ex.unit !== 'bodyweight';
  return '<div class="card target-editor">' +
    '<div class="card-title">Edit target</div>' +
    '<div class="target-fields">' +
    '<div><label class="field-label" for="tgt-sets-' + id + '">Sets</label>' +
    '<input id="tgt-sets-' + id + '" type="number" inputmode="numeric" min="1" max="12" step="1" value="' + esc(ex.sets) + '"></div>' +
    '<div><label class="field-label" for="tgt-reps-' + id + '">' + (seconds ? 'Seconds' : 'Reps') + '</label>' +
    '<input id="tgt-reps-' + id + '" type="text" inputmode="numeric" autocomplete="off" value="' + esc(ex.targetReps) +
    '" placeholder="' + (seconds ? '30' : '8-12') + '"></div>' +
    (hasWeight
      ? '<div><label class="field-label" for="tgt-weight-' + id + '">Kg ' + esc(unitLabel(ex.unit)) + '</label>' +
        '<input id="tgt-weight-' + id + '" type="number" inputmode="decimal" min="0" step="0.5" value="' +
        esc(ex.weightKg === null || ex.weightKg === undefined ? '' : ex.weightKg) + '"></div>'
      : '') +
    '</div>' +
    '<div class="hint">' + (seconds ? 'A number of seconds per set.' : 'A number (10), a range (8-12) or max.') + '</div>' +
    '<div class="row" style="margin-top:12px">' +
    '<button class="btn btn-primary btn-small" data-act="save-target" data-ex="' + id + '" type="button">Save</button>' +
    '<button class="btn btn-ghost btn-small" data-act="cancel-target" type="button">Cancel</button>' +
    '</div>' +
    (ex.overridden
      ? '<button class="btn btn-ghost btn-small" style="margin-top:8px" data-act="reset-target" data-ex="' + id +
        '" type="button">Back to routine.json target</button>'
      : '') +
    '</div>';
}

function exerciseHeaderHtml(ex, showEdit) {
  return '<div>' +
    '<div class="ex-name">' + esc(ex.name) + '</div>' +
    '<div class="ex-target">' + esc(targetText(ex)) + ' · ' + esc(weightText(ex)) +
    (ex.overridden ? ' <span class="tag tag-success">edited</span>' : '') +
    (showEdit && state.ui.editTarget !== ex.id
      ? ' <button class="link-btn" data-act="edit-target" data-ex="' + esc(ex.id) + '" type="button">Edit target</button>'
      : '') +
    '</div></div>' +
    (state.ui.editTarget === ex.id ? targetEditorHtml(ex) : '');
}

function exerciseInfoHtml(ex) {
  if (!ex.description && !ex.technique.length) return '';
  return '<details class="ex-info" open>' +
    '<summary>How to do it</summary>' +
    (ex.description ? '<p class="sub">' + esc(ex.description) + '</p>' : '') +
    (ex.technique.length
      ? '<ul class="ex-cues">' + ex.technique.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>'
      : '') +
    '</details>';
}

function lastTimeHtml(ex) {
  var last = lastEntryFor(ex.id);
  if (!last) {
    return '<div class="lasttime empty"><div class="label">Last time</div>' +
           '<div class="sub" style="margin-top:6px">First time logging this one — set the bar.</div></div>';
  }
  var hi = maxWeight(last.entry);
  var mixed = !uniformWeight(last.entry);
  var lw = hi === null
    ? esc(entryWeightText(last.entry))
    : esc(mixed ? minWeight(last.entry) + '–' + hi : hi) + '<span class="unit"> kg ' + esc(unitLabel(ex.unit)) + '</span>';
  var lmiss = last.entry.missed || [];
  var ltarget = targetRepsForSuccess(ex);
  var html = '<div class="lasttime">' +
    '<div class="label">Last time · ' + esc(prettyDate(last.session.date)) + ' · ' + esc(daysAgo(last.session.date)) + '</div>' +
    '<div class="weight">' + lw + '</div>' +
    '<div class="reps">' + (last.entry.reps || []).map(function (r, i) {
      if (lmiss[i]) return '<span class="rep rep-missed">✕</span>';
      if (r === null || r === undefined) return '<span class="rep">–</span>';
      var short = ltarget !== null && r < ltarget;
      var w = setWeight(last.entry, i);
      return '<span class="rep' + (short ? ' rep-short' : '') + '">' +
             (mixed && w !== null ? '<span class="unit">' + esc(w) + '×</span>' : '') + esc(r) + '</span>';
    }).join('<span class="unit">·</span>') + (ex.measure === 'seconds' ? '<span class="unit">s</span>' : '') +
    (ltarget !== null ? '<span class="rep-target">target ' + esc(ex.targetReps) + '</span>' : '') +
    '</div>' +
    '<div class="meta">' + outcomeTag(last.entry.outcome) + '<span>Beat it or match it.</span></div>';

  var best = bestEntryFor(ex.id);
  if (best && best.session.id !== last.session.id) {
    html += '<div class="best">Best · ' + esc(prettyDate(best.session.date)) + ' · ' + esc(entrySummary(best.entry, ex)) + '</div>';
  }
  return html + '</div>';
}

function viewSessionExercise() {
  var ex = currentExercise();
  var list = dayExercises(state.draft.day);
  var pos = list.map(function (x) { return x.id; }).indexOf(ex.id);
  var last = lastEntryFor(ex.id);
  var recorded = draftEntryFor(ex.id);
  var html = '';

  html += '<div>' +
          '<div class="progress-line"><span>' + (pos + 1) + ' of ' + list.length + '</span>' +
          '<span>' + state.draft.entries.length + ' locked in</span></div>' +
          '<div class="progress-bar"><i style="width:' + ((state.draft.entries.length / list.length) * 100).toFixed(0) + '%"></i></div>' +
          '</div>';

  html += exerciseHeaderHtml(ex, true);
  html += lastTimeHtml(ex);
  html += exerciseInfoHtml(ex);

  /* Inputs. The grey baseline in each box is last time (or the target); what
     you type sits on top in white. Something already locked in shows in white. */
  var hasWeight = ex.unit !== 'bodyweight';
  var recMissed = (recorded && recorded.missed) || [];
  var unit = measureUnit(ex);
  var topTarget = repsTop(ex.targetReps);

  var rowCls = hasWeight ? '' : ' no-weight';
  html += '<div class="card stack">' +
    '<div class="set-head' + rowCls + '"><span>Set</span><span>' + esc(unit) + '</span>' +
    (hasWeight ? '<span>kg ' + esc(unitLabel(ex.unit)) + '</span>' : '') + '<span></span></div>';

  for (var j = 0; j < ex.sets; j++) {
    var miss = !!recMissed[j];
    var lastReps = last && last.entry.reps ? num(last.entry.reps[j]) : null;
    var baseReps = lastReps !== null ? lastReps : (topTarget === null ? '' : topTarget);
    var recReps = recorded && !miss ? num(recorded.reps[j]) : null;

    var lastW = last ? setWeight(last.entry, j) : null;
    var baseW = lastW !== null ? lastW : (ex.weightKg === null || ex.weightKg === undefined ? '' : ex.weightKg);
    var recW = recorded && !miss ? setWeight(recorded, j) : null;

    html += '<div class="set-row' + rowCls + (miss ? ' is-missed' : '') + '" id="row-' + j + '">' +
            '<label for="set-' + j + '">' + (j + 1) + '</label>' +
            '<input id="set-' + j + '" type="number" inputmode="numeric" pattern="[0-9]*" step="1" min="0" ' +
            'enterkeyhint="next" autocomplete="off" placeholder="' + esc(baseReps) + '" value="' +
            esc(recReps === null ? '' : recReps) + '"' + (miss ? ' disabled' : '') + '>' +
            (hasWeight
              ? '<input id="w-' + j + '" type="number" inputmode="decimal" step="0.5" min="0" ' +
                'enterkeyhint="next" autocomplete="off" placeholder="' + esc(baseW) + '" data-base="' + esc(baseW) +
                '" value="' + esc(recW === null ? '' : recW) + '"' + (miss ? ' disabled' : '') + '>'
              : '') +
            '<button class="miss-btn" id="miss-' + j + '" data-act="toggle-miss" data-set="' + j +
            '" type="button" aria-pressed="' + (miss ? 'true' : 'false') +
            '" title="Could not attempt this set" aria-label="Set ' + (j + 1) +
            ': could not attempt">✕</button>' +
            '</div>';
  }
  html += '<p class="hint" style="margin:0">Grey is ' + (last ? 'last time' : 'the target') +
          '. Type your ' + esc(unit) + ' over it' + (hasWeight ? '; leave a kg box blank to keep the grey value' : '') + '.</p>';
  html += '</div>';

  html += '<div id="compare-hint" class="compare-hint" hidden></div>';
  html += '<div id="verdict-hint" class="verdict-hint"></div>';

  html += '<button class="btn btn-advance" data-act="lock" type="button">' + (recorded ? 'LOCK IN AGAIN' : 'LOCK IN') + '</button>';
  html += '<p class="muted center">' + (recorded
    ? 'Already locked in as ' + esc(outcomeWord(recorded.outcome)) + ' — locking in again overwrites it.'
    : 'Locks the score and returns to the list. Tap ✕ on any set you could not attempt.') + '</p>';

  html += '<div class="linkrow">' +
          '<button class="btn btn-ghost" data-act="close-exercise" type="button">← Back to list</button>' +
          '</div>';
  return html;
}

function outcomeWord(outcome) {
  return outcome === 'success' ? 'on target' : outcome === 'short' ? 'short' : 'missed sets';
}

/* ---------------- Routine ---------------- */

function viewRoutine() {
  var html = '<p class="sub">Tap a day to see its exercises. ▲▼ sets the order you do them in; ' +
             'Edit target sets the sets, reps or seconds, and weight. Everything here also shows up in a session.</p>';

  html += dayKeys().map(function (day) {
    var d = state.routine.days[day];
    var open = state.ui.routineDay === day;
    var list = dayExercises(day);
    var out = '<div class="card">' +
      '<button class="session-item" data-act="routine-day" data-day="' + esc(day) + '" type="button" ' +
      'style="background:none;border:0;padding:0;color:inherit">' +
      '<span class="top"><span class="date fam-' + esc(dayFamily(day)) + '">' + esc(d.name) + '</span>' +
      '<span class="day">' + esc(d.focus || '') + '</span></span>' +
      '<div class="muted">' + list.length + ' exercises · ' + (open ? 'tap to close' : 'tap to open') + '</div>' +
      '</button>';

    if (open) {
      out += '<div class="entry-list">' + list.map(function (ex, i) {
        var editing = state.ui.editTarget === ex.id;
        return '<div class="ex-row">' +
          '<div class="ex-row-move">' +
          '<button class="move-btn" data-act="move-ex" data-day="' + esc(day) + '" data-ex="' + esc(ex.id) + '" data-dir="-1" type="button"' +
            (i === 0 ? ' disabled' : '') + ' aria-label="Move up">&#9650;</button>' +
          '<button class="move-btn" data-act="move-ex" data-day="' + esc(day) + '" data-ex="' + esc(ex.id) + '" data-dir="1" type="button"' +
            (i === list.length - 1 ? ' disabled' : '') + ' aria-label="Move down">&#9660;</button>' +
          '</div>' +
          '<div class="ex-row-main">' +
          '<span class="ex-row-name">' + esc(ex.name) + (ex.overridden ? ' <span class="tag tag-success">edited</span>' : '') + '</span>' +
          '<span class="ex-row-target">' + esc(targetText(ex)) + ' · ' + esc(weightText(ex)) + '</span>' +
          (editing ? '' : '<button class="link-btn" data-act="edit-target" data-ex="' + esc(ex.id) + '" type="button">Edit target</button>') +
          (editing ? targetEditorHtml(ex) : '') +
          '</div></div>';
      }).join('') + '</div>';
      if (state.order[day]) {
        out += '<button class="btn btn-ghost btn-small" style="margin-top:12px" data-act="reset-order" data-day="' + esc(day) +
               '" type="button">Back to routine.json order</button>';
      }
    }
    return out + '</div>';
  }).join('');

  return html;
}

/* ---------------- History ---------------- */

function sessionCardHtml(s) {
  var open = state.history.expanded === s.id;
  var wins = (s.entries || []).filter(function (e) { return e.outcome === 'success'; }).length;
  var out = '<div class="card"><button class="session-item" data-act="expand" data-id="' + esc(s.id) +
    '" type="button" style="background:none;border:0;padding:0;color:inherit">' +
    '<span class="top"><span class="date">' + esc(prettyDate(s.date)) + '</span>' +
    '<span class="day fam-' + esc(dayFamily(s.day)) + '">' + esc(dayName(s.day)) + '</span></span>' +
    '<div class="muted">' + (s.entries || []).length + ' exercises · ' + wins + ' success' +
    (s.synced ? '' : ' · pending sync') + ' · ' + (open ? 'tap to close' : 'tap to open') + '</div>' +
    '</button>';

  if (open) {
    out += '<div class="entry-list">' + (s.entries || []).map(function (e) {
      var prev = entryBefore(e.exerciseId, s);
      var ex = exerciseById(e.exerciseId) || {};
      return '<div class="entry">' +
        '<span class="ename">' + esc(exerciseName(e.exerciseId)) + '</span>' +
        outcomeTag(e.outcome) +
        '<span class="edetail">' + esc(entrySummary(e, ex)) +
        (prev ? ' <span class="ex-row-cmp is-' + compareEntries(e, prev.entry) + '">' + esc(compareText(e, prev.entry, ex)) + '</span>' : '') +
        '</span></div>';
    }).join('') + '</div>' +
    '<button class="btn btn-danger btn-small" style="margin-top:12px" data-act="delete-session" data-id="' +
      esc(s.id) + '" type="button">Delete this session</button>';
  }
  return out + '</div>';
}

function skipCardHtml(key) {
  return '<div class="card skip-row">' +
    '<div><div class="date">' + esc(prettyDate(key + 'T12:00:00')) + '</div>' +
    '<div class="muted">Skipped ' + esc(String(state.skips[key]).toUpperCase()) + '</div></div>' +
    '<button class="btn btn-ghost btn-small" data-act="delete-skip" data-key="' + esc(key) +
    '" type="button">Remove</button></div>';
}

function viewHistory() {
  var html = '<div class="tabs">' +
    '<button class="btn" data-act="hist-tab" data-tab="sessions" aria-pressed="' + (state.history.tab === 'sessions') + '" type="button">Sessions</button>' +
    '<button class="btn" data-act="hist-tab" data-tab="exercise" aria-pressed="' + (state.history.tab === 'exercise') + '" type="button">By exercise</button>' +
    '</div>';

  if (state.history.tab === 'exercise') return html + viewHistoryExercise();

  /* Sessions and skipped days share one timeline, newest first, so a gap in
     training is explained rather than mysterious. */
  var rows = state.sessions.map(function (s) {
    return { key: isoDay(s.date), sort: String(s.date), kind: 'session', session: s };
  });
  Object.keys(state.skips).forEach(function (k) {
    rows.push({ key: k, sort: k + 'T23:59:59', kind: 'skip' });
  });

  if (!rows.length) return html + '<p class="empty-note">No sessions logged yet.</p>';

  rows.sort(function (a, b) { return b.sort.localeCompare(a.sort); });

  return html + rows.map(function (r) {
    return r.kind === 'skip' ? skipCardHtml(r.key) : sessionCardHtml(r.session);
  }).join('');
}

function viewHistoryExercise() {
  var seen = {};
  var options = allExercises().map(function (ex) { seen[ex.id] = true; return ex; });
  /* include anything in history that is no longer in routine.json */
  state.sessions.forEach(function (s) {
    (s.entries || []).forEach(function (e) {
      if (!seen[e.exerciseId]) { seen[e.exerciseId] = true; options.push({ id: e.exerciseId, name: exerciseName(e.exerciseId) }); }
    });
  });

  if (!options.length) return '<p class="empty-note">Nothing to show yet.</p>';
  if (!state.history.exerciseId) state.history.exerciseId = options[0].id;

  var html = '<div class="card"><label class="field-label" for="ex-select">Exercise</label>' +
    '<select id="ex-select" data-act="pick-exercise">' +
    options.map(function (ex) {
      return '<option value="' + esc(ex.id) + '"' + (ex.id === state.history.exerciseId ? ' selected' : '') + '>' +
             esc(ex.name) + '</option>';
    }).join('') + '</select></div>';

  var rows = entriesFor(state.history.exerciseId);
  if (!rows.length) return html + '<p class="empty-note">No sessions with this exercise yet.</p>';

  var labels = rows.map(function (r) { return isoDay(r.session.date).slice(5); });
  var weights = rows.map(function (r) { return maxWeight(r.entry); });
  var totals = rows.map(function (r) {
    return (r.entry.reps || []).reduce(function (a, b) { return a + (num(b) || 0); }, 0);
  });

  html += '<div class="card">' +
    '<div class="chart-wrap"><div class="chart-title">Weight (kg)</div>' + sparkline(weights, labels, 'var(--accent)') + '</div>' +
    '<div class="chart-wrap"><div class="chart-title">Total reps</div>' + sparkline(totals, labels, 'var(--reps)') + '</div>' +
    '</div>';

  html += '<div class="card"><table class="hist-table">' +
    '<thead><tr><th>Date</th><th>Kg</th><th>Reps</th><th>Total</th><th></th></tr></thead><tbody>' +
    rows.slice().reverse().map(function (r, i) {
      var idx = rows.length - 1 - i;
      return '<tr><td>' + esc(isoDay(r.session.date)) + '</td>' +
        '<td>' + (weights[idx] === null ? '–' : esc(entryWeightText(r.entry).replace(' kg', ''))) + '</td>' +
        '<td>' + esc(repsList(r.entry, null).split(' · ').join('·')) + '</td>' +
        '<td>' + esc(totals[idx]) + '</td>' +
        '<td>' + outcomeTag(r.entry.outcome) + '</td></tr>';
    }).join('') + '</tbody></table></div>';

  return html;
}

/* ---------------- Settings ---------------- */

function viewSettings() {
  var c = state.creds;
  var ovrIds = Object.keys(state.overrides);

  var html = '';

  html += '<div class="card settings-group"><h2>GitHub sync</h2>' +
    '<div class="field"><label class="field-label" for="cred-username">Username</label>' +
    '<input id="cred-username" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" ' +
    'data-cred="username" value="' + esc(c.username) + '" placeholder="your-github-username"></div>' +

    '<div class="field"><label class="field-label" for="cred-repo">Repository</label>' +
    '<input id="cred-repo" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" ' +
    'data-cred="repo" value="' + esc(c.repo) + '" placeholder="workout-tracker"></div>' +

    '<div class="field"><label class="field-label" for="cred-branch">Branch</label>' +
    '<input id="cred-branch" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" ' +
    'data-cred="branch" value="' + esc(c.branch || 'main') + '" placeholder="main"></div>' +

    '<div class="field"><label class="field-label" for="cred-token">Personal access token</label>' +
    '<input id="cred-token" type="' + (state.ui.showToken ? 'text' : 'password') + '" autocapitalize="none" ' +
    'autocorrect="off" spellcheck="false" data-cred="token" value="' + esc(c.token) + '" placeholder="github_pat_…">' +
    '<div class="hint">' + (c.token ? 'Stored on this device: ' + esc(maskToken(c.token)) : 'No token stored.') +
    '</div>' +
    '<div class="hint">Fine-grained token, this repo only, Contents: read and write.</div></div>' +

    '<div class="row" style="margin-bottom:12px">' +
    '<button class="btn btn-small" data-act="toggle-token" type="button">' + (state.ui.showToken ? 'Hide' : 'Show') + ' token</button>' +
    '<button class="btn btn-small btn-danger" data-act="clear-creds" type="button">Clear credentials</button>' +
    '</div>' +
    '<button class="btn btn-primary" data-act="save-creds" type="button">Save &amp; sync now</button>' +
    '</div>';

  var pend = pendingCount();
  html += '<div class="card settings-group"><h2>Sync</h2>' +
    '<p class="sub">' + state.sessions.length + ' sessions stored · ' +
    (pend ? pend + ' waiting to upload' : 'all uploaded') +
    (state.sync.error === 'auth' ? ' · <strong>auth failed</strong>' : '') +
    (state.sync.error === 'notfound' ? ' · <strong>repo not found</strong>' : '') + '</p>' +
    '<div class="stack" style="margin-top:12px">' +
    '<button class="btn" data-act="sync" type="button">Sync now</button>' +
    '<button class="btn btn-danger" data-act="pull-cloud" type="button">Pull from cloud (replaces local)</button>' +
    '</div>' +
    '<div class="hint">Writes data/log.json and data/log.csv into the repo above.</div></div>';

  html += '<div class="card settings-group"><h2>Backup</h2><div class="stack">' +
    '<button class="btn" data-act="export-json" type="button">Export JSON</button>' +
    '<button class="btn" data-act="export-csv" type="button">Export CSV</button>' +
    '<button class="btn btn-danger" data-act="import-json" type="button">Import JSON (replaces local)</button>' +
    '<input id="import-file" class="hidden-file" type="file" accept="application/json,.json">' +
    '</div></div>';

  html += '<div class="card settings-group"><h2>Edited targets</h2>';
  if (!ovrIds.length) {
    html += '<p class="sub">None — every target comes straight from routine.json.</p>';
  } else {
    html += ovrIds.map(function (id) {
      var ex = exerciseById(id);
      var o = state.overrides[id];
      var text = ex ? targetText(ex) + ' · ' + weightText(ex)
                    : (o.sets + ' × ' + o.targetReps + (o.weightKg === null ? '' : ' · ' + o.weightKg + ' kg'));
      return '<div class="ovr-item"><span>' + esc(exerciseName(id)) + '</span><span>' + esc(text) + '</span></div>';
    }).join('');
    html += '<button class="btn btn-danger" style="margin-top:12px" data-act="reset-overrides" type="button">Reset all targets</button>';
  }
  html += '</div>';

  html += '<div class="card settings-group"><h2>About</h2>' +
    '<p class="sub">Version ' + esc(APP_VERSION) + '. Routine loaded from routine.json' +
    (state.routine ? ' (' + allExercises().length + ' exercises).' : '.') + '</p>' +
    '<button class="btn btn-small" style="margin-top:12px" data-act="update-sw" type="button">Check for app update</button>' +
    '</div>';

  return html;
}

function outcomeTag(outcome) {
  var map = {
    success: ['success', 'On target'],
    short:   ['short',   'Short'],
    fail:    ['fail',    'Missed sets']
  };
  var m = map[outcome] || map.success;
  return '<span class="tag tag-' + m[0] + '">' + m[1] + '</span>';
}

function maskToken(t) {
  if (!t) return '';
  if (t.length <= 8) return '•'.repeat(t.length);
  return t.slice(0, 4) + '•'.repeat(Math.min(12, t.length - 8)) + t.slice(-4);
}

/* ------------------------------------------------------------------ *
 * Export / import
 * ------------------------------------------------------------------ */

function download(filename, text, mime) {
  try {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  } catch (err) {
    showBanner('Could not create the download: ' + err.message);
  }
}

function stampName(ext) {
  return 'workout-log-' + isoDay(new Date().toISOString()) + '.' + ext;
}

function handleImportFile(file) {
  var reader = new FileReader();
  reader.onload = function () {
    var store;
    try { store = JSON.parse(reader.result); }
    catch (err) { showBanner('That file is not valid JSON: ' + err.message); return; }
    var count = (store && Array.isArray(store.sessions)) ? store.sessions.length : 0;
    if (!count && !confirm('That file contains no sessions. Replace local data anyway?')) return;
    if (count && !confirm('Replace all local data with ' + count + ' sessions from this file?\nThis cannot be undone.')) return;
    applyStore(store, false);
    showBanner('Imported ' + state.sessions.length + ' sessions.');
    render();
  };
  reader.onerror = function () { showBanner('Could not read that file.'); };
  reader.readAsText(file);
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

var actions = {
  'dismiss-banner': function () { hideBanner(); },
  'go': function (el) { state.screen = el.getAttribute('data-screen'); window.scrollTo(0, 0); render(); },
  'start': function (el) { startSession(el.getAttribute('data-day')); },
  'resume': function () { state.screen = 'session'; window.scrollTo(0, 0); render(); },
  'open-exercise': function (el) { openExercise(el.getAttribute('data-ex')); },
  'close-exercise': function () { closeExercise(); },
  'lock': function () { lockEntry(); },
  'finish': function () { finishSession(); },
  'edit-target': function (el) { state.ui.editTarget = el.getAttribute('data-ex'); render(); },
  'cancel-target': function () { state.ui.editTarget = null; render(); },
  'save-target': function (el) { saveTarget(el.getAttribute('data-ex')); },
  'reset-target': function (el) { resetTarget(el.getAttribute('data-ex')); },
  'move-ex': function (el) {
    moveExercise(el.getAttribute('data-day'), el.getAttribute('data-ex'), Number(el.getAttribute('data-dir')));
  },
  'reset-order': function (el) { resetOrder(el.getAttribute('data-day')); },
  'routine-day': function (el) {
    var day = el.getAttribute('data-day');
    state.ui.routineDay = state.ui.routineDay === day ? null : day;
    state.ui.editTarget = null;
    render();
  },
  'toggle-miss': function (el) {
    var i = el.getAttribute('data-set');
    var pressed = el.getAttribute('aria-pressed') === 'true';
    el.setAttribute('aria-pressed', pressed ? 'false' : 'true');
    var input = document.getElementById('set-' + i);
    var wInput = document.getElementById('w-' + i);
    var row = document.getElementById('row-' + i);
    if (input) { input.disabled = !pressed; if (!pressed) input.value = ''; }
    if (wInput) { wInput.disabled = !pressed; if (!pressed) wInput.value = ''; }
    if (row) row.className = 'set-row' + (wInput ? '' : ' no-weight') + (!pressed ? ' is-missed' : '');
    updateVerdictHint();
  },
  'abandon': function () { abandonSession(); },
  'hist-tab': function (el) { state.history.tab = el.getAttribute('data-tab'); render(); },
  'expand': function (el) {
    var id = el.getAttribute('data-id');
    state.history.expanded = state.history.expanded === id ? null : id;
    render();
  },
  'toggle-token': function () { state.ui.showToken = !state.ui.showToken; render(); },
  'save-creds': function () { collectCreds(); saveCreds(); syncNow(true); render(); },
  'clear-creds': function () {
    if (!confirm('Remove the stored GitHub username, repo and token from this device?')) return;
    state.creds = { username: '', repo: '', branch: 'main', token: '' };
    saveCreds();
    render();
  },
  'sync': function () { collectCreds(); saveCreds(); syncNow(true); },
  'pull-cloud': function () { collectCreds(); saveCreds(); pullFromCloud(); },
  'export-json': function () { download(stampName('json'), JSON.stringify(buildStore(), null, 2), 'application/json'); },
  'export-csv': function () { download(stampName('csv'), buildCSV(), 'text/csv'); },
  'import-json': function () { var f = document.getElementById('import-file'); if (f) f.click(); },
  'reset-overrides': function () { resetOverrides(); },
  'skip': function () { skipToday(); },
  'cal-prev': function () { state.ui.calOffset -= 1; render(); },
  'cal-next': function () { state.ui.calOffset += 1; render(); },
  'cal-today': function () { state.ui.calOffset = 0; render(); },
  'cal-day': function (el) {
    state.history.tab = 'sessions';
    state.history.expanded = el.getAttribute('data-id');
    state.screen = 'history';
    window.scrollTo(0, 0);
    render();
  },
  'unskip': function () { unskipToday(); },
  'delete-session': function (el) { deleteSession(el.getAttribute('data-id')); },
  'delete-skip': function (el) { deleteSkip(el.getAttribute('data-key')); },
  'update-sw': function () { updateServiceWorker(); }
};

function collectCreds() {
  ['username', 'repo', 'branch', 'token'].forEach(function (k) {
    var el = document.querySelector('[data-cred="' + k + '"]');
    if (el) state.creds[k] = el.value.trim();
  });
  if (!state.creds.branch) state.creds.branch = 'main';
}

document.addEventListener('click', function (ev) {
  var el = ev.target.closest('[data-act]');
  if (!el) return;
  var fn = actions[el.getAttribute('data-act')];
  if (fn) { ev.preventDefault(); fn(el); }
});

document.addEventListener('input', function (ev) {
  var id = ev.target.id || '';
  if (state.screen === 'session' && /^(set|w)-\d+$/.test(id)) updateVerdictHint();
});

/* Enter in a target editor saves it. */
document.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Enter') return;
  var m = /^tgt-(?:sets|reps|weight)-(.+)$/.exec(ev.target.id || '');
  if (m) { ev.preventDefault(); saveTarget(m[1]); }
});

document.addEventListener('change', function (ev) {
  var t = ev.target;
  if (t.id === 'ex-select') { state.history.exerciseId = t.value; render(); return; }
  if (t.id === 'import-file' && t.files && t.files[0]) { handleImportFile(t.files[0]); t.value = ''; return; }
  if (t.hasAttribute && t.hasAttribute('data-cred')) { collectCreds(); saveCreds(); }
});

document.getElementById('syncPill').addEventListener('click', function () { syncNow(true); });

document.getElementById('topbarBack').addEventListener('click', function () {
  state.screen = 'home';
  window.scrollTo(0, 0);
  render();
});

window.addEventListener('online', function () { renderTopbar(); syncNow(false); });
window.addEventListener('offline', function () { renderTopbar(); });

/* Don't lose typed reps if the tab is backgrounded mid-set. */
window.addEventListener('pagehide', function () {
  if (state.screen === 'session' && state.draft) saveDraft();
});

/* ------------------------------------------------------------------ *
 * Service worker
 * ------------------------------------------------------------------ */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(function (err) {
    console.warn('Service worker registration failed:', err);
  });
}

function updateServiceWorker() {
  if (!('serviceWorker' in navigator)) { showBanner('This browser has no service worker support.'); return; }
  navigator.serviceWorker.getRegistration().then(function (reg) {
    if (!reg) { showBanner('No service worker registered.'); return; }
    return reg.update().then(function () {
      showBanner('Checked for an update. Close and reopen the app to load a new version.');
    });
  }).catch(function (err) { showBanner('Update check failed: ' + err.message); });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function loadRoutine() {
  return fetch('routine.json', { cache: 'no-cache' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (json) {
      if (!json || !json.days) throw new Error('routine.json has no "days"');
      writeJSON(K.ROUTINE, json);
      return json;
    })
    .catch(function (err) {
      var cached = readJSON(K.ROUTINE, null);
      if (cached && cached.days) {
        showBanner('Using the last cached routine — routine.json could not be loaded (' + err.message + ').');
        return cached;
      }
      showBanner('routine.json could not be loaded: ' + err.message +
                 '. Serve this folder over http:// rather than opening the file directly.');
      return null;
    });
}

function boot() {
  state.sessions  = readJSON(K.SESSIONS, []);
  state.overrides = readJSON(K.OVERRIDES, {});
  state.order     = readJSON(K.ORDER, {});
  state.creds     = Object.assign({ username: '', repo: '', branch: 'main', token: '' }, readJSON(K.CREDS, {}));
  state.draft     = readJSON(K.DRAFT, null);
  state.skips     = readJSON(K.SKIPS, {});
  state.dirty     = !!readJSON(K.DIRTY, false);

  if (!Array.isArray(state.sessions)) state.sessions = [];
  if (!state.overrides || typeof state.overrides !== 'object') state.overrides = {};
  if (!state.order || typeof state.order !== 'object') state.order = {};
  if (!state.skips || typeof state.skips !== 'object') state.skips = {};

  /* Overrides written by the old streak progression carried no sets. */
  Object.keys(state.overrides).forEach(function (id) {
    var o = state.overrides[id];
    if (!o || typeof o !== 'object') { delete state.overrides[id]; return; }
    delete o.progressedAt;
  });

  render();
  loadRoutine().then(function (routine) {
    state.routine = routine;
    if (state.draft && (!routine || !routine.days[state.draft.day])) state.draft = null;
    if (state.draft && state.draft.current === undefined) { state.draft.current = null; delete state.draft.index; }
    if (state.draft && !Array.isArray(state.draft.entries)) state.draft.entries = [];
    render();
    syncNow(false);
  });
  registerServiceWorker();
}

boot();
