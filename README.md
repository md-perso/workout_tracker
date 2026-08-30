# Workout Tracker

A personal push/pull workout tracker. Plain HTML, CSS and vanilla JavaScript —
no framework, no build step, no npm, no CDN, no external dependencies. It is
served as a static site from GitHub Pages, saved to a phone home screen, and it
works with no network in the gym.

`localStorage` is the source of truth. A session is saved locally the instant
you tap NEXT; syncing to GitHub happens afterwards and can fail freely without
costing you data.

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

Everything about your training lives in `routine.json`. Never edit `app.js` to
change a routine.

```json
{
  "id": "pull-sa-db-row",
  "name": "Single-arm DB row",
  "sets": 3,
  "targetReps": 10,
  "weightKg": 32,
  "unit": "single",
  "increment": 2,
  "notes": "Each side."
}
```

| Field | Meaning |
|---|---|
| `id` | Stable, unique. **History is keyed on this** — change an id and that exercise loses its past |
| `name` | Shown on screen |
| `sets` | How many rep inputs the session screen shows |
| `targetReps` | A number (`10`), a range (`"12-15"`), or `"max"` |
| `weightKg` | Target weight in kg, or `null` for bodyweight work. On a pulley this is the stack setting |
| `unit` | `"perHand"` \| `"single"` \| `"bodyweight"` \| `"pulley"` |
| `increment` | Kg added by a weight progression, or `null` to only ever add reps |
| `notes` | A short cue, shown under the exercise name |

To add, remove or reorder exercises, edit the `exercises` array of `push` or
`pull`. Order in the file is the order you do them in. After editing, bump
`CACHE_VERSION` in `sw.js` (see below) so phones pick the change up.

Dumbbell weights are per hand unless `unit` is `"single"`. Pulley weights are
the number on the stack, in kg; the seeded values are a starting guess, and the
app remembers whatever you actually log from the first session onward.

## Progression

### How a set is judged

You do not pick a verdict. The app works it out from the sets themselves, and
shows you what it will record before you tap NEXT.

Each set has a reps box and a **✕** button meaning *I could not even attempt
this set*. From those, the exercise gets one of three outcomes:

| Outcome | Meaning |
|---|---|
| **On target** (`success`) | Every set attempted, and every set at or above the target reps |
| **Short** (`short`) | Every set attempted, but at least one under target. Not a failure — you showed up and did the work |
| **Missed sets** (`fail`) | At least one set you could not attempt at all |

A **range is hit at its top**: `12-15` means every set needs 15 to count as on
target. That is deliberate — a `+ reps` progression grows the top of the range,
so graduating the range is what earns the next step. A `"max"` target has no
number to reach, so attempting the set is the target.

Doing fewer reps than the target **never moves your target**. `routine.json`
stays the goal, LAST TIME shows what you managed against it, and the next
session's boxes prefill with your actual reps so you can see what you are
chasing.

### The streak

The app derives a consecutive-success streak per exercise from your session
history — nothing is stored separately, so editing or importing history stays
consistent. Only an **on target** session increments the streak. Both *short*
and *missed sets* reset it to 0, so you only ever progress off three genuine
on-target sessions in a row.

At **3 consecutive successes** the session screen shows *"3 in a row — time to
progress"* with three choices:

- **+ reps** — adds 1 to the target (or to the top of a range: `12-15` → `12-16`).
  For a `"max"` exercise there is no number to bump, so it turns your best set
  from last time into a concrete goal (best `9` → target `10`).
- **+ weight** — adds that exercise's `increment` kg. Hidden when `increment`
  is `null`, so bodyweight exercises only ever gain reps.
- **Not yet** — dismisses the prompt for this session; it returns next time.

Progressing writes an **override** into `localStorage`, layered on top of
`routine.json`. `routine.json` stays the untouched seed. Settings lists every
active override and has a **Reset overrides** button to fall back to the file.

## The schedule

The app assumes **push, rest, pull, rest, push, rest …** — one training day, one
rest day, alternating between the two workouts.

The home screen opens with a card telling you where you are:

| Card | When | What it offers |
|---|---|---|
| **PULL** (or PUSH) | 2+ days since your last session | The matching day button is badged **TODAY**. A **Can't today** button skips it |
| **Rest day** | You trained yesterday | Names the next workout and when it lands |
| **PUSH done ✓** | You already trained today | Names the next workout and its weekday |
| **Skipped** | You tapped *Can't today* | An **Undo — I can train** button puts it back |

The recommendation is derived from your last *completed* session, so skipping a
day never consumes the workout you owe: skip a pull day and it is still pull
tomorrow. If you fall behind, the card shows how many days late you are.

Nothing here is enforced. Both PUSH and PULL buttons always work — the schedule
is a suggestion, and you can train whatever you like whenever you like.

Skipped days are stored, synced and exported alongside your sessions, and they
appear in History as dashed rows so a gap in training is explained rather than
mysterious.

### Abandoning a session

**Abandon** mid-session means the workout did not happen. Nothing is logged —
not even the sets you had already entered — and the day is recorded as a skipped
day, exactly as *Can't today* would. It shows on the calendar, and the workout is
still owed.

That is the difference worth keeping straight:

- **Abandon** — the whole session did not happen
- **✕ on a set** — that one set could not be attempted
- **Fewer reps than target** — you did the set, just not all of it

## The calendar

The home screen carries a month calendar that shows the tracker and the logic in
one grid — what you actually did, and what the schedule says is coming.

| Cell | Meaning |
|---|---|
| Solid blue | A push session you logged. Tap it to open that session in History |
| Solid green | A pull session you logged. Also tappable |
| Dashed blue / green outline | A **planned** session — the alternating schedule projected forward |
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

- **Sessions**, **Last 30 days**, and **Ready to progress** (how many exercises
  are sitting on a 3+ success streak)
- **Sessions per week** — an inline bar chart of the last eight rolling weeks
- **Due a bump** — the exercises at 3+ in a row, with their streak
- **Moved up since the start** — every target that has drifted off its
  `routine.json` seed, shown as `seed → current`
- A count of days skipped in the last 30, when there are any

## Deleting sessions

Open History, tap a session to expand it, then **Delete this session**. It is
permanent and behind a confirm.

Because a delete changes the store without creating a *pending* session, the app
flags the store as changed — the header pill reads **Changes pending** — and
pushes the corrected log to the cloud on the next sync, so the deleted session
does not come back on a restore. The same applies to removing a skipped day and
to progression changes.

Deleting is retroactive everywhere: success streaks are derived from history, so
removing a session immediately recomputes them.

## Cloud sync

Sync commits two files into `data/` in this same repo, via the GitHub Contents
API:

- `data/log.json` — the full store (sessions, overrides, skipped days), pretty-printed
- `data/log.csv` — flat, one row per set: `date, day, exercise, weightKg, setNumber, reps, setStatus, outcome`
  (`setStatus` is `done` or `missed`; `outcome` is the exercise's `success` / `short` / `fail`)

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
var CACHE_VERSION = 'v5';   // -> 'v6'
```

The old cache is deleted on activation. Settings also has a **Check for app
update** button that asks the browser to re-check immediately.

## What it deliberately does not do

No accounts, no multi-user support, no rest timers, no 1RM estimates, no
calorie tracking, and no external library or CDN of any kind. The schedule
suggests; it never locks a workout.
