# Workout Tracker

A personal push/pull workout tracker. Plain HTML, CSS and vanilla JavaScript —
no framework, no build step, no npm, no CDN, no external dependencies. It is
served as a static site from GitHub Pages, saved to a phone home screen, and it
works with no network in the gym.

`localStorage` is the source of truth. A score is saved locally the instant
you tap LOCK IN; syncing to GitHub happens afterwards and can fail freely
without costing you data.

## Files

| File | What it is |
|---|---|
| `index.html` | App shell and meta tags |
| `style.css` | All styling |
| `app.js` | All behaviour |
| `routine.json` | **Your routine.** The only file you edit to change training |
| `manifest.webmanifest` | Home-screen / fullscreen install |
| `sw.js` | Service worker — offline app shell cache |
| `icon.svg` | App icon |
| `data/log.json`, `data/log.csv` | Written by the app when it syncs |

## Running it locally

The app fetches `routine.json`, so it needs to be served over HTTP —
double-clicking `index.html` (a `file://` URL) will not work.

```sh
cd workout_tracker
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

Service workers only run on `http://localhost` or HTTPS, so offline caching
works on localhost and on the live Pages site, but not over a LAN IP.

## Editing your routine

The seed routine lives in `routine.json`: four days — **Push A** (chest focus),
**Pull A** (lat focus), **Push B** (shoulder focus), **Pull B** (upper back
focus) — each with its exercises, a description and technique cues. Never edit
`app.js` to change a routine.

Targets and order can also be changed inside the app (see below); the file is
the seed those changes layer on top of.

```json
"push-a": {
  "name": "Push A",
  "family": "push",
  "focus": "Chest focus",
  "exercises": [
    {
      "id": "push-flat-db-bench",
      "name": "Flat DB bench press",
      "sets": 4,
      "targetReps": "6-10",
      "weightKg": 14,
      "unit": "perHand",
      "description": "The main chest builder of the week. ...",
      "technique": ["Feet flat and planted, shoulder blades pulled back.", "..."]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `family` | `"push"` or `"pull"` — colours on the calendar and the day buttons |
| `focus` | Short label shown on the day button and the session header |
| `id` | Stable, unique. **History is keyed on this** — change an id and that exercise loses its past. The same id in two days means the same exercise (Side plank is in Push A and Pull B), so LAST TIME carries across |
| `name` | Shown on screen |
| `sets` | How many inputs the session screen shows |
| `targetReps` | A number (`10`), a range (`"8-12"`), or `"max"` |
| `measure` | `"reps"` (default) or `"seconds"` for holds like the plank |
| `weightKg` | Target weight in kg, or `null` for bodyweight work. On a pulley this is the stack setting |
| `unit` | `"perHand"` \| `"single"` \| `"bodyweight"` \| `"pulley"` \| `"plate"` |
| `description` | What the exercise is, what it works, and the trainer's loading note |
| `technique` | A list of cues on how to do it properly, shown under **How to do it** |

The top-level `retired` map names exercises that are no longer in the routine
but still appear in history.

After editing the file, bump `CACHE_VERSION` in `sw.js` (see below) so phones
pick the change up.

Dumbbell weights are per hand unless `unit` is `"single"`. Pulley weights are
the number on the stack, in kg.

## A session

Tap a day. You get the **list** of that day's exercises in your order, with
what you did last time under each one.

- **Tap an exercise** to open it. Any order you like — the list is not a
  sequence.
- **▲▼** move an exercise up or down. The new order sticks for every future
  session of that day (**Routine → Back to routine.json order** undoes it).
- On the exercise screen: the target, **LAST TIME** (weight and every set, plus
  your **best** ever if it differs), **How to do it** (description and cues),
  then one row per set with a **reps** (or seconds) box and a **kg** box.
- Each box shows last time's number in **grey** (the target, if there is no
  last time). What you type sits on top in **white**. Reps must be typed; a kg
  box left blank keeps the grey value. Every set has its own kg, so
  `14 kg × 8, 13 kg × 10, 13 kg × 10` is a normal entry.
- **LOCK IN** records the score and returns you to the list. Opening a locked
  exercise again and locking in again overwrites it.
- **FINISH SESSION** saves. Anything not locked in is not logged; the app lists
  what you are leaving out and asks first.

### Beating last time

Every exercise screen shows two lines that update as you type:

- **vs last time** — *Better than last time: +2 reps*, *Same as last time*,
  *Heavier top set: +2 kg*, *Below last time: −3 reps*. A heavier top set wins;
  at the same top weight, more kilograms moved (weight × reps, summed over the
  sets — *+24 kg lifted*) wins, which is the same as more total reps when every
  set used the same weight. Bodyweight work and holds compare reps or seconds.
- the **verdict** against the target — see below.

There is no streak and no "3 in a row" rule. The aim is to beat or match the
last score every session; the home screen counts how many exercises you beat in
your most recent session.

### Choosing your targets

Tap **Edit target** on any exercise (in a session or on the **Routine** screen)
to set the **sets**, the **reps** or **seconds** (a number, a range like
`8-12`, or `max`), and the **kg**. Enter saves. The change applies from that
moment on — mid-session too.

Edits are stored as overrides layered on `routine.json`; the file stays the
untouched seed. Settings lists every edited target and can reset them all;
each editor also has a **Back to routine.json target** button.

### How a set is judged

You do not pick a verdict. The app works it out from the sets themselves and
shows it before you lock in.

Each set has a box and a **✕** button meaning *I could not even attempt this
set*. From those, the exercise gets one of three outcomes:

| Outcome | Meaning |
|---|---|
| **On target** (`success`) | Every set attempted, and every set at or above the target |
| **Short** (`short`) | Every set attempted, but at least one under target. Not a failure — you showed up and did the work |
| **Missed sets** (`fail`) | At least one set you could not attempt at all |

A range is hit at its **bottom**: `8-12` means every set needs at least 8. A
`"max"` target has no number to reach, so attempting the set is the target.
For a `seconds` exercise the boxes take seconds instead of reps.

Doing fewer reps than the target never moves the target. The next session's
boxes show what you actually did in grey, so you can see what you are chasing.

## The schedule

The app rotates **Push A, rest, Pull A, rest, Push B, rest, Pull B, rest …** —
one training day, one rest day, cycling through the four workouts in the order
they appear in `routine.json`.

The home screen opens with a card telling you where you are:

| Card | When | What it offers |
|---|---|---|
| **PULL A** (or any day) | 2+ days since your last session | The matching day button is badged **TODAY**. A **Can't today** button skips it |
| **Rest day** | You trained yesterday | Names the next workout and when it lands |
| **PUSH A done ✓** | You already trained today | Names the next workout and its weekday |
| **Skipped** | You tapped *Can't today* | An **Undo — I can train** button puts it back |

The recommendation is derived from your last *completed* session, so skipping a
day never consumes the workout you owe: skip a pull day and it is still that
pull day tomorrow. If you fall behind, the card shows how many days late you
are.

Nothing here is enforced. All four day buttons always work — the schedule is a
suggestion, and you can train whatever you like whenever you like.

Skipped days are stored, synced and exported alongside your sessions, and they
appear in History as dashed rows so a gap in training is explained rather than
mysterious.

### Abandoning a session

**Abandon** means the workout did not happen. Nothing is logged — not even the
exercises you had already locked in — and the day is recorded as a skipped day,
exactly as *Can't today* would. It shows on the calendar, and the workout is
still owed.

That is the difference worth keeping straight:

- **Abandon** — the whole session did not happen
- **Not locked in at FINISH** — that exercise was not done today
- **✕ on a set** — that one set could not be attempted
- **Fewer reps than target** — you did the set, just not all of it

## The calendar

The home screen carries a month calendar that shows the tracker and the logic in
one grid — what you actually did, and what the schedule says is coming.

| Cell | Meaning |
|---|---|
| Solid blue | A push session (A or B) you logged. Tap it to open that session in History |
| Solid green | A pull session you logged. Also tappable |
| Dashed blue / green outline | A **planned** session — the rotation projected forward |
| Dashed amber outline | A day you skipped |
| Plain | A rest day, or nothing |
| White ring | Today |

The projection runs off your last completed session, so it re-draws the moment
you log or delete one, or skip a day. Weeks start on Monday. The arrows step
month by month; **Back to this month** returns.

Past days are never projected — history is what happened, not what was meant to
happen.

## Progress overview

The home screen carries a **Progress** card:

- **Sessions**, **Last 30 days**, and **Beat last time** (how many exercises in
  your most recent session beat their previous score)
- **Sessions per week** — an inline bar chart of the last eight rolling weeks
- **Improved in …** — the exercises you beat in the most recent session, with
  by how much
- **Targets changed since the start** — every target that has been edited off
  its `routine.json` seed, shown as `seed → current`
- A count of days skipped in the last 30, when there are any

History shows the same *vs last time* comparison next to every logged exercise.

## Deleting sessions

Open History, tap a session to expand it, then **Delete this session**. It is
permanent and behind a confirm.

Because a delete changes the store without creating a *pending* session, the app
flags the store as changed — the header pill reads **Changes pending** — and
pushes the corrected log to the cloud on the next sync, so the deleted session
does not come back on a restore. The same applies to removing a skipped day,
editing a target and reordering exercises.

Deleting is retroactive everywhere: LAST TIME, best and the comparisons are
derived from history, so removing a session immediately recomputes them.

## Cloud sync

Sync commits two files into `data/` in this same repo, via the GitHub Contents
API:

- `data/log.json` — the full store (sessions, edited targets, exercise order, skipped days), pretty-printed
- `data/log.csv` — flat, one row per set: `date, day, exercise, weightKg, setNumber, reps, setStatus, outcome`
  (`weightKg` is that set's weight; `setStatus` is `done` or `missed`; `outcome` is the exercise's
  `success` / `short` / `fail`; for a `seconds` exercise the `reps` column holds seconds)

In `log.json` each entry carries `weightsKg` (one per set) alongside `weightKg`
(the heaviest set), so older readers keep working.

It fires on session save, on app load, on the browser's `online` event, and
whenever you tap the sync pill in the header. The pill reads **Synced**,
**N pending**, or **Offline**; a failed token shows **Auth failed**.

Sync never blocks a save. If it fails, the sessions simply stay marked
`synced: false` and go up on the next attempt.

### Creating the token

The repo is public and there is no token in the source. You supply one in
Settings and it is stored only in that browser's `localStorage`.

1. GitHub → your avatar → **Settings** → **Developer settings**
2. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
3. Name it something like `workout-tracker`
4. **Expiration** — set one. 90 days is reasonable; you will need to generate a
   new one and paste it into Settings when it lapses.
5. **Repository access** → *Only select repositories* → pick **this repo only**
6. **Permissions** → *Repository permissions* → **Contents: Read and write**.
   That is the only permission needed — leave everything else at *No access*.
7. Generate, copy the token, and paste it into the app under
   **Settings → GitHub sync**, along with your username, the repo name and the
   branch (`main`).
8. Tap **Save & sync now**.

If the token expires or is revoked, the app says
*"GitHub auth failed — check your token in Settings"* rather than failing
quietly.

If the pill reads **Repo not found**, the token is valid but GitHub cannot see
that repository. Check the repo name character for character, check the branch,
and check that the token lists this repo under *Repository access* — **a private
repo your token was not granted is reported as "not found", not "forbidden"**, so
a scoping mistake and a typo look identical from the outside.

### Private repositories

Syncing works fine with a private repo — the API only cares about the token, and
a private repo keeps your training log off the public internet.

**GitHub Pages is the catch.** On a free personal account, Pages only publishes
from a *public* repository; serving a site from a private repo needs a paid plan.
So either make the repo public to host the app, or keep it private and run the
app another way.

To revoke access, delete the token on GitHub and tap **Clear credentials** in
Settings.

## Restoring onto a new phone

**Settings → Pull from cloud** fetches `data/log.json` and, after a confirm,
replaces the local store. That is the restore path.

As a fallback there are **Export JSON**, **Export CSV** and **Import JSON**
(also behind a confirm) for local backup files.

## Enabling GitHub Pages

1. Push this folder to the repo root on the `main` branch.
2. Repo → **Settings** → **Pages**
3. **Source**: *Deploy from a branch*
4. **Branch**: `main`, folder `/ (root)` → **Save**
5. Wait for the deploy, then open `https://<username>.github.io/<repo>/`

On iPhone: open that URL in Safari → Share → **Add to Home Screen**. It then
opens fullscreen with no browser chrome. On Android, Chrome offers *Install app*.

Because the site is public, so is anything you sync to `data/`. Only your
training log goes there — no token, no personal data.

## Updating the app

The service worker caches the app shell so it opens offline. Cached files can
otherwise go stale on a phone that never sees a fresh copy.

**After changing `index.html`, `style.css`, `app.js` or `routine.json`, bump the
version constant at the top of `sw.js`:**

```js
var CACHE_VERSION = 'v7';   // -> 'v8'
```

The old cache is deleted on activation. Settings also has a **Check for app
update** button that asks the browser to re-check immediately.

## What it deliberately does not do

No accounts, no multi-user support, no rest timers, no 1RM estimates, no
calorie tracking, no automatic progression, and no external library or CDN of
any kind. The schedule suggests; it never locks a workout. Targets are yours to
set.
