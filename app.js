/* Workout Tracker — vanilla JS, offline-first.
 *
 * Editing your routine means editing routine.json. Nothing in this file needs
 * to change to add, remove, reorder or retarget an exercise.
 */
'use strict';

var APP_VERSION = '1.0.0';

var K = {
  SESSIONS:  'wt.sessions',
  OVERRIDES: 'wt.overrides',
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
  overrides: {},
  creds: { username: '', repo: '', branch: 'main', token: '' },
  draft: null,
  skips: {},        /* { 'YYYY-MM-DD': 'push' } — days deliberately not trained */
  dirty: false,     /* local store differs from the cloud for a non-session reason */
  sync: { busy: false, error: '' },
  history: { tab: 'sessions', expanded: null, exerciseId: '' },
  ui: { showToken: false, dismissedProgress: {}, calOffset: 0 }
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

function dayExercises(day) {
  if (!state.routine || !state.routine.days[day]) return [];
  return state.routine.days[day].exercises.map(effective);
}

function allExercises() {
  var out = [];
  dayKeys().forEach(function (d) {
    state.routine.days[d].exercises.forEach(function (ex) { out.push(effective(ex)); });
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
  return ex ? ex.name : id;
}

/* routine.json stays the untouched seed; overrides layer on top. */
function effective(ex) {
  var o = state.overrides[ex.id];
  var merged = {
    id: ex.id, name: ex.name, sets: ex.sets, targetReps: ex.targetReps,
    weightKg: ex.weightKg, unit: ex.unit, increment: ex.increment,
    notes: ex.notes, overridden: false
  };
  if (o) {
    if (o.targetReps !== undefined && o.targetReps !== null) { merged.targetReps = o.targetReps; merged.overridden = true; }
    if (o.weightKg !== undefined && o.weightKg !== null)     { merged.weightKg   = o.weightKg;   merged.overridden = true; }
  }
  return merged;
}

function unitLabel(unit) {
  if (unit === 'perHand')    return 'per hand';
  if (unit === 'single')     return 'single DB';
  if (unit === 'bodyweight') return 'bodyweight';
  if (unit === 'pulley')     return 'pulley';
  return unit || '';
}

function weightText(ex) {
  if (ex.weightKg === null || ex.weightKg === undefined) {
    return ex.unit === 'bodyweight' ? 'Bodyweight' : 'Pulley — log the stack';
  }
  return ex.weightKg + ' kg ' + unitLabel(ex.unit);
}

function targetText(ex) {
  return ex.sets + ' × ' + ex.targetReps;
}

/* What a logged entry's weight reads as — a blank pulley entry is not bodyweight. */
function entryWeightText(entry) {
  if (entry.weightKg !== null && entry.weightKg !== undefined) return entry.weightKg + ' kg';
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

function bumpReps(t) {
  if (typeof t === 'number') return t + 1;
  var s = String(t).trim();
  var range = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) return range[1] + '-' + (Number(range[2]) + 1);
  if (/^\d+$/.test(s)) return Number(s) + 1;
  return null; /* e.g. "max" — caller derives a number from history instead */
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

/* Consecutive successes since the last progression (or since the beginning). */
function streakFor(exId) {
  var o = state.overrides[exId];
  var since = o && o.progressedAt ? o.progressedAt : null;
  var list = sessionsDesc();
  var n = 0;
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (since && String(s.date) <= String(since)) break;
    var e = (s.entries || []).filter(function (x) { return x.exerciseId === exId; })[0];
    if (!e) continue;
    if (e.outcome === 'success') n++; else break;
  }
  return n;
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

/* The next day in the rotation after `day`. With two days this alternates. */
function nextDayAfter(day) {
  var keys = dayKeys();
  if (!keys.length) return day;
  var i = keys.indexOf(day);
  return keys[(i + 1) % keys.length];
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

  var ready = allExercises().filter(function (ex) { return streakFor(ex.id) >= 3; });

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
  dayKeys().forEach(function (day) {
    state.routine.days[day].exercises.forEach(function (seed) {
      var now = effective(seed);
      if (!now.overridden) return;
      var bits = [];
      if (now.weightKg !== seed.weightKg) bits.push(seed.weightKg + ' → ' + now.weightKg + ' kg');
      if (String(now.targetReps) !== String(seed.targetReps)) bits.push(seed.targetReps + ' → ' + now.targetReps + ' reps');
      if (bits.length) moved.push({ name: now.name, text: bits.join(' · ') });
    });
  });

  return {
    total: state.sessions.length,
    last30: last30,
    skipped30: skipped30,
    ready: ready,
    weeks: weeks,
    moved: moved
  };
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
        rows.push([isoDay(s.date), s.day, exerciseName(e.exerciseId), e.weightKg, i + 1,
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
  state.skips = (store && store.skips && typeof store.skips === 'object') ? store.skips : {};
  saveSessions();
  saveOverrides();
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
  state.draft = { id: uid(), date: new Date().toISOString(), day: day, index: 0, entries: [] };
  state.ui.dismissedProgress = {};
  saveDraft();
  state.screen = 'session';
  render();
}

function currentExercise() {
  if (!state.draft) return null;
  var list = dayExercises(state.draft.day);
  return list[state.draft.index] || null;
}

function draftEntryFor(exId) {
  if (!state.draft) return null;
  return state.draft.entries.filter(function (e) { return e.exerciseId === exId; })[0] || null;
}

/* The reps every set must reach to count as on target. A range is only "hit"
   at its top, which is also what a +reps progression grows — so graduating the
   range is what unlocks the next step. "max" has no number: attempting it is
   the target. */
function targetRepsForSuccess(ex) {
  return repsTop(ex.targetReps);
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
    return worst + ' short of target';
  }
  return 'On target';
}

function readSessionInputs(ex) {
  var reps = [];
  var missed = [];
  for (var i = 0; i < ex.sets; i++) {
    var el = document.getElementById('set-' + i);
    var btn = document.getElementById('miss-' + i);
    var isMissed = !!(btn && btn.getAttribute('aria-pressed') === 'true');
    missed.push(isMissed);
    reps.push(isMissed ? null : (el ? num(el.value) : null));
  }
  var wEl = document.getElementById('weight-input');
  return { reps: reps, missed: missed, weightKg: wEl ? num(wEl.value) : null };
}

function recordEntry() {
  var ex = currentExercise();
  if (!ex || !state.draft) return;
  var vals = readSessionInputs(ex);
  var entry = {
    exerciseId: ex.id,
    weightKg: vals.weightKg,
    reps: vals.reps,
    outcome: computeOutcome(ex, vals.reps, vals.missed)
  };
  /* Only carry the array when something was actually missed. */
  if (vals.missed.some(Boolean)) entry.missed = vals.missed;

  var idx = -1;
  state.draft.entries.forEach(function (e, i) { if (e.exerciseId === ex.id) idx = i; });
  if (idx >= 0) state.draft.entries[idx] = entry; else state.draft.entries.push(entry);

  var total = dayExercises(state.draft.day).length;
  if (state.draft.index >= total - 1) {
    finishSession();
  } else {
    state.draft.index += 1;
    saveDraft();
    window.scrollTo(0, 0);
    render();
  }
}

function finishSession() {
  var d = state.draft;
  if (!d) return;
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

function goBackExercise() {
  if (!state.draft || state.draft.index <= 0) return;
  state.draft.index -= 1;
  saveDraft();
  window.scrollTo(0, 0);
  render();
}

/* ------------------------------------------------------------------ *
 * Progression
 * ------------------------------------------------------------------ */

function canProgressWeight(ex) {
  return ex.increment !== null && ex.increment !== undefined;
}

function applyProgression(exId, kind) {
  var ex = exerciseById(exId);
  if (!ex) return;
  var o = state.overrides[exId] ? Object.assign({}, state.overrides[exId]) : {};

  if (kind === 'weight') {
    if (!canProgressWeight(ex)) return;
    var base = (ex.weightKg === null || ex.weightKg === undefined) ? 0 : ex.weightKg;
    o.weightKg = Math.round((base + ex.increment) * 100) / 100;
  } else {
    var bumped = bumpReps(ex.targetReps);
    if (bumped === null) {
      /* "max" has no number to bump — turn the best set so far into a goal. */
      var last = lastEntryFor(exId);
      var best = 0;
      if (last) (last.entry.reps || []).forEach(function (r) { if (num(r) !== null && r > best) best = r; });
      bumped = best + 1;
    }
    o.targetReps = bumped;
  }

  /* Reset the derived streak: only sessions after this point count again.
     During a session, anchor just before it started so today still counts. */
  var anchor = state.draft ? new Date(new Date(state.draft.date).getTime() - 1).toISOString()
                           : new Date().toISOString();
  o.progressedAt = anchor;

  state.overrides[exId] = o;
  saveOverrides();
  markDirty();
  state.ui.dismissedProgress[exId] = true;
  render();
}

function resetOverrides() {
  if (!confirm('Drop all progression overrides and fall back to routine.json targets?')) return;
  state.overrides = {};
  saveOverrides();
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
  var titles = { home: 'Workout', session: '', history: 'History', settings: 'Settings' };
  var title = titles[state.screen];
  if (state.screen === 'session' && state.draft) {
    title = (state.routine && state.routine.days[state.draft.day]
             ? state.routine.days[state.draft.day].name : state.draft.day).toUpperCase();
  }
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

/* Recomputes the verdict line from the live inputs. Touches only that one
   element — a full re-render mid-set would steal focus from the keypad. */
function updateVerdictHint() {
  var el = document.getElementById('verdict-hint');
  if (!el) return;
  var ex = currentExercise();
  if (!ex) return;
  var vals = readSessionInputs(ex);
  var outcome = computeOutcome(ex, vals.reps, vals.missed);
  el.className = 'verdict-hint is-' + outcome;
  el.textContent = outcomeLabel(outcome, ex, vals.reps, vals.missed);
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

    var cls = 'cal-cell is-' + c.kind + (c.day ? ' d-' + c.day : '') + (c.isToday ? ' is-today' : '');
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
    '<div class="stat"><span class="stat-num' + (st.ready.length ? ' is-hot' : '') + '">' + st.ready.length +
      '</span><span class="stat-label">Ready to progress</span></div>' +
    '</div>';

  var counts = st.weeks.map(function (w) { return w.count; });
  html += '<div class="chart-wrap"><div class="chart-title">Sessions per week</div>' +
          barChart(counts, st.weeks.map(function (w) { return w.label; })) + '</div>';

  if (st.ready.length) {
    html += '<div class="prog-block"><div class="chart-title">Due a bump</div>' +
      st.ready.slice(0, 5).map(function (ex) {
        return '<div class="prog-row"><span>' + esc(ex.name) + '</span>' +
               '<span class="prog-val">' + streakFor(ex.id) + ' in a row</span></div>';
      }).join('') + '</div>';
  }

  if (st.moved.length) {
    html += '<div class="prog-block"><div class="chart-title">Moved up since the start</div>' +
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
            esc(state.draft.day.toUpperCase()) + ' — ' +
            (state.draft.index + 1) + ' of ' + total + '</button>';
  }

  html += viewTodayCard(plan);

  html += dayKeys().map(function (day) {
    var last = lastSessionForDay(day);
    var sub = last ? 'Last done ' + prettyDate(last.date) + ' · ' + daysAgo(last.date)
                   : 'Not done yet';
    var isToday = (plan.status === 'train' && plan.day === day);
    return '<button class="day-btn' + (isToday ? ' is-today' : '') + '" data-day="' + esc(day) +
           '" data-act="start" type="button">' +
           '<span class="day-name">' + esc(state.routine.days[day].name.toUpperCase()) +
           (isToday ? '<span class="today-badge">Today</span>' : '') + '</span>' +
           '<span class="day-last">' + esc(sub) + '</span></button>';
  }).join('');

  html += viewCalendarCard();
  html += viewProgressCard();

  html += '<div class="linkrow">' +
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

  var idx = Math.min(state.draft.index, list.length - 1);
  var ex = list[idx];
  var last = lastEntryFor(ex.id);
  var recorded = draftEntryFor(ex.id);
  var isLast = idx >= list.length - 1;

  var html = '';

  /* progress */
  html += '<div>' +
          '<div class="progress-line"><span>' + (idx + 1) + ' of ' + list.length + '</span>' +
          '<span>' + esc(state.routine.days[state.draft.day].name) + '</span></div>' +
          '<div class="progress-bar"><i style="width:' + (((idx + 1) / list.length) * 100).toFixed(0) + '%"></i></div>' +
          '</div>';

  /* progression prompt */
  var streak = streakFor(ex.id);
  if (streak >= 3 && !state.ui.dismissedProgress[ex.id]) {
    html += '<div class="progress-prompt">' +
            '<h3>' + streak + ' in a row — time to progress</h3>' +
            '<p class="sub">' + esc(ex.name) + ' is at ' + esc(targetText(ex)) +
            (ex.weightKg !== null && ex.weightKg !== undefined ? ' @ ' + esc(ex.weightKg + ' kg') : '') + '.</p>' +
            '<div class="opts">' +
            '<button class="btn" data-act="progress" data-kind="reps" data-ex="' + esc(ex.id) + '" type="button">+ reps</button>' +
            (canProgressWeight(ex)
              ? '<button class="btn" data-act="progress" data-kind="weight" data-ex="' + esc(ex.id) +
                '" type="button">+ ' + esc(ex.increment) + ' kg</button>'
              : '') +
            '</div>' +
            '<button class="btn btn-ghost btn-small" style="margin-top:10px" data-act="progress-dismiss" data-ex="' +
              esc(ex.id) + '" type="button">Not yet</button>' +
            '</div>';
  }

  /* exercise header */
  html += '<div>' +
          '<div class="ex-name">' + esc(ex.name) + '</div>' +
          '<div class="ex-target">' + esc(targetText(ex)) + ' · ' + esc(weightText(ex)) +
          (ex.overridden ? ' <span class="tag tag-success">progressed</span>' : '') + '</div>' +
          (ex.notes ? '<div class="ex-notes">' + esc(ex.notes) + '</div>' : '') +
          '</div>';

  /* LAST TIME — the headline of this screen */
  if (last) {
    var lw = (last.entry.weightKg === null || last.entry.weightKg === undefined)
      ? esc(entryWeightText(last.entry))
      : last.entry.weightKg + '<span class="unit"> kg ' + esc(unitLabel(ex.unit)) + '</span>';
    var lmiss = last.entry.missed || [];
    var ltarget = targetRepsForSuccess(ex);
    html += '<div class="lasttime">' +
            '<div class="label">Last time</div>' +
            '<div class="weight">' + lw + '</div>' +
            '<div class="reps">' + (last.entry.reps || []).map(function (r, i) {
              if (lmiss[i]) return '<span class="rep-missed">✕</span>';
              if (r === null || r === undefined) return '–';
              var short = ltarget !== null && r < ltarget;
              return '<span class="' + (short ? 'rep-short' : '') + '">' + esc(r) + '</span>';
            }).join(' · ') +
            (ltarget !== null ? '<span class="rep-target">target ' + esc(ltarget) + '</span>' : '') +
            '</div>' +
            '<div class="meta">' + outcomeTag(last.entry.outcome) +
            '<span>' + esc(prettyDate(last.session.date)) + ' · ' + esc(daysAgo(last.session.date)) + '</span>' +
            (streak > 0 ? '<span>streak ' + streak + '</span>' : '') +
            '</div></div>';
  } else {
    html += '<div class="lasttime empty"><div class="label">Last time</div>' +
            '<div class="sub" style="margin-top:6px">First time logging this one.</div></div>';
  }

  /* inputs */
  var prefill = [];
  for (var i = 0; i < ex.sets; i++) {
    var v = '';
    if (recorded && recorded.reps && recorded.reps[i] !== null && recorded.reps[i] !== undefined) v = recorded.reps[i];
    else if (last && last.entry.reps && last.entry.reps[i] !== null && last.entry.reps[i] !== undefined) v = last.entry.reps[i];
    else { var t = repsTop(ex.targetReps); v = (t === null ? '' : t); }
    prefill.push(v);
  }

  var weightVal = '';
  if (recorded && recorded.weightKg !== null && recorded.weightKg !== undefined) weightVal = recorded.weightKg;
  else if (ex.weightKg !== null && ex.weightKg !== undefined) weightVal = ex.weightKg;
  else if (last && last.entry.weightKg !== null && last.entry.weightKg !== undefined) weightVal = last.entry.weightKg;

  var recMissed = (recorded && recorded.missed) || [];

  html += '<div class="card stack">';
  for (var j = 0; j < ex.sets; j++) {
    var miss = !!recMissed[j];
    html += '<div class="set-row' + (miss ? ' is-missed' : '') + '" id="row-' + j + '">' +
            '<label for="set-' + j + '">Set ' + (j + 1) + '</label>' +
            '<input id="set-' + j + '" type="number" inputmode="numeric" pattern="[0-9]*" step="1" min="0" ' +
            'enterkeyhint="next" autocomplete="off" value="' + esc(miss ? '' : prefill[j]) + '"' +
            (miss ? ' disabled' : '') + '>' +
            '<button class="miss-btn" id="miss-' + j + '" data-act="toggle-miss" data-set="' + j +
            '" type="button" aria-pressed="' + (miss ? 'true' : 'false') +
            '" title="Could not attempt this set" aria-label="Set ' + (j + 1) +
            ': could not attempt">✕</button>' +
            '</div>';
  }
  html += '<div class="set-row"><label for="weight-input">Kg</label>' +
          '<input id="weight-input" type="number" inputmode="decimal" step="0.5" min="0" ' +
          'enterkeyhint="done" autocomplete="off" value="' + esc(weightVal) + '"></div>';
  html += '</div>';

  html += '<div id="verdict-hint" class="verdict-hint"></div>';

  html += '<button class="btn btn-advance" data-act="advance" type="button">' +
          (isLast ? 'FINISH SESSION' : 'NEXT') + '</button>';

  if (isLast) html += '<p class="muted center">Saves the session and takes you home.</p>';
  else if (recorded) html += '<p class="muted center">Already logged as ' + esc(recorded.outcome) + ' — advancing overwrites it.</p>';
  else html += '<p class="muted center">Tap ✕ on any set you could not attempt.</p>';

  html += '<div class="linkrow">' +
          (idx > 0 ? '<button class="btn btn-ghost" data-act="prev-exercise" type="button">← Previous</button>' : '') +
          '<button class="btn btn-danger" data-act="abandon" type="button">Abandon</button>' +
          '</div>';

  return html;
}

/* ---------------- History ---------------- */

function sessionCardHtml(s) {
  var open = state.history.expanded === s.id;
  var wins = (s.entries || []).filter(function (e) { return e.outcome === 'success'; }).length;
  var out = '<div class="card"><button class="session-item" data-act="expand" data-id="' + esc(s.id) +
    '" type="button" style="background:none;border:0;padding:0;color:inherit">' +
    '<span class="top"><span class="date">' + esc(prettyDate(s.date)) + '</span>' +
    '<span class="day">' + esc(s.day) + '</span></span>' +
    '<div class="muted">' + (s.entries || []).length + ' exercises · ' + wins + ' success' +
    (s.synced ? '' : ' · pending sync') + ' · ' + (open ? 'tap to close' : 'tap to open') + '</div>' +
    '</button>';

  if (open) {
    out += '<div class="entry-list">' + (s.entries || []).map(function (e) {
      var miss = e.missed || [];
      return '<div class="entry">' +
        '<span class="ename">' + esc(exerciseName(e.exerciseId)) + '</span>' +
        outcomeTag(e.outcome) +
        '<span class="edetail">' + esc(entryWeightText(e)) + ' · ' +
          (e.reps || []).map(function (r, i) {
            if (miss[i]) return '✕';
            return (r === null || r === undefined) ? '–' : esc(r);
          }).join(' · ') +
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
      if (!seen[e.exerciseId]) { seen[e.exerciseId] = true; options.push({ id: e.exerciseId, name: e.exerciseId }); }
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
  var weights = rows.map(function (r) {
    var w = r.entry.weightKg;
    return (w === null || w === undefined) ? null : Number(w);
  });
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
        '<td>' + (weights[idx] === null ? '–' : esc(weights[idx])) + '</td>' +
        '<td>' + (r.entry.reps || []).map(function (x, xi) {
            if ((r.entry.missed || [])[xi]) return '✕';
            return (x === null || x === undefined) ? '–' : esc(x);
          }).join('·') + '</td>' +
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

  html += '<div class="card settings-group"><h2>Progression overrides</h2>';
  if (!ovrIds.length) {
    html += '<p class="sub">None — every target comes straight from routine.json.</p>';
  } else {
    html += ovrIds.map(function (id) {
      var o = state.overrides[id];
      var bits = [];
      if (o.targetReps !== undefined && o.targetReps !== null) bits.push('reps → ' + o.targetReps);
      if (o.weightKg !== undefined && o.weightKg !== null) bits.push(o.weightKg + ' kg');
      return '<div class="ovr-item"><span>' + esc(exerciseName(id)) + '</span><span>' + esc(bits.join(' · ')) + '</span></div>';
    }).join('');
    html += '<button class="btn btn-danger" style="margin-top:12px" data-act="reset-overrides" type="button">Reset overrides</button>';
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
  'resume': function () { state.screen = 'session'; render(); },
  'advance': function () { recordEntry(); },
  'toggle-miss': function (el) {
    var i = el.getAttribute('data-set');
    var pressed = el.getAttribute('aria-pressed') === 'true';
    el.setAttribute('aria-pressed', pressed ? 'false' : 'true');
    var input = document.getElementById('set-' + i);
    var row = document.getElementById('row-' + i);
    if (input) { input.disabled = !pressed; if (!pressed) input.value = ''; }
    if (row) row.className = 'set-row' + (!pressed ? ' is-missed' : '');
    updateVerdictHint();
  },
  'prev-exercise': function () { goBackExercise(); },
  'abandon': function () { abandonSession(); },
  'progress': function (el) { applyProgression(el.getAttribute('data-ex'), el.getAttribute('data-kind')); },
  'progress-dismiss': function (el) { state.ui.dismissedProgress[el.getAttribute('data-ex')] = true; render(); },
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
  if (state.screen === 'session' && /^set-\d+$/.test(ev.target.id || '')) updateVerdictHint();
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
  state.creds     = Object.assign({ username: '', repo: '', branch: 'main', token: '' }, readJSON(K.CREDS, {}));
  state.draft     = readJSON(K.DRAFT, null);
  state.skips     = readJSON(K.SKIPS, {});
  state.dirty     = !!readJSON(K.DIRTY, false);

  if (!Array.isArray(state.sessions)) state.sessions = [];
  if (!state.overrides || typeof state.overrides !== 'object') state.overrides = {};
  if (!state.skips || typeof state.skips !== 'object') state.skips = {};

  render();
  loadRoutine().then(function (routine) {
    state.routine = routine;
    if (state.draft && (!routine || !routine.days[state.draft.day])) state.draft = null;
    render();
    syncNow(false);
  });
  registerServiceWorker();
}

boot();
