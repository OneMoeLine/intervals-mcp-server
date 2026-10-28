# Roadmap: candidate tools

Notes from comparing this server against
[hhopke/intervals-icu-mcp](https://github.com/hhopke/intervals-icu-mcp) (70
tools, 4 resources, 9 prompts). That server is Python, covers close to the whole
Intervals.icu API surface, and gates destructive tools behind an
`INTERVALS_ICU_DELETE_MODE` env var.

This is a wish list, not a plan to reach 70 tools. The things worth keeping as we
grow: field projection (`fields`) on every fat payload, credential redaction,
stream downsampling, honest read/write annotations, and a test per tool. A tool
that returns 40 KB of JSON nobody asked for is worse than no tool.

Endpoints and field names below are checked against the Intervals.icu OpenAPI
spec, not guessed.

## Shipped

The first tier is done — 31 tools then, 22 read-only and 9 writers:

- **Structured workouts.** Steps go in `description` as Intervals.icu workout
  syntax, which the API parses server-side. Published as the
  `intervals-icu://workout-syntax` resource, because an unparseable description
  is kept as plain text with no load and nothing in the response says so.
- **`update_event`, `delete_event`.** Create-only is gone; corrections no longer
  leave duplicates on the calendar.
- **`get_fitness_chart`.** CTL, ATL and form (CTL - ATL, also called TSB) as a
  daily series from the wellness records, with future days flagged
  `projected` rather than passed off as measurements.
- **Workout library writes.** `create_workout`, `update_workout`,
  `delete_workout`, plus `list_folders` and `create_folder`.
- **`update_activity`.** Name, description, sport type, tags, race/commute
  flags, feel and RPE.
- **Destructive-write policy.** `INTERVALS_DELETE_MODE` is `safe` by default:
  delete tools are registered, but `delete_event` reads the event first and
  refuses anything dated before today. `full` lifts that, `none` unregisters the
  delete tools entirely. Server-side, because a model can set a tool argument
  itself.
- **A category fix found on the way.** `create_event` had been offering
  `RACE`, `TRAVEL` and `STRENGTH`, none of which the API accepts, while missing
  `RACE_A/B/C`, `PLAN`, `INJURED` and the four fitness-chart categories. The
  enum now matches the spec, and a test pins it.

Exercised against a live account on 2026-10-16. The reads were right first
time; the writes turned up four things the fake server could not have caught:

- `project()` validated the *default* field set against the keys a response
  happened to carry, so `get_event` failed outright — the single-event
  endpoint omits `paired_activity_id`, which the list endpoint returns — and
  `list_events` failed on any range whose events all lacked it. Defaults are
  no longer validated; a caller's own field names still are.
- The workout-syntax resource was wrong in six places, each of which fails
  silently: the parser drops the line and builds a shorter workout. Rewritten
  from round-trips against the live parser.
- `create_event` needs `type` for `SET_EFTP`, not only for the race
  categories, and `update_event` cannot change `category` once an event is
  `TARGET` or `PLAN` (422).

`INTERVALS_DELETE_MODE=full` is still fake-server-only on purpose: verifying it
live means deleting real history.

Since then, **`get_hr_curves` and `get_pace_curves`** — 33 tools now, 24
read-only and 9 writers. They register through the same helper as
`get_power_curves` rather than being copied from it: the three endpoints take
one request shape and return one wrapper, so only the path, the summary set
and pace's grade-adjustment flag differ. Two things the spec settled that
guessing would not have:

- Grade adjustment is a `gap` boolean on `/pace-curves`, not a separate
  endpoint, and the live API confirms it by flipping each curve's `type` from
  `PACE` to `GAP`. That is why `type` is in the pace summary set — a
  grade-adjusted answer identifies itself rather than having to be trusted.
- Pace curves are indexed by distance, not duration: `distance` in metres
  against `values` in seconds, where power and HR give `secs` against
  `values`. Each tool therefore has its own summary set rather than borrowing
  power's. Measured live on 2026-10-16: 3.3 KB against 10.8 KB for HR, 2.6 KB
  against 10.6 KB for pace.

`oldest` is carried on all three for symmetry with the other date-ranged
reads, but the spec does not list it and the live API ignores it — `curves`
("42d", "all") is what actually picks the window.

Then **`get_activity_histogram`** — 34 tools, 25 read-only. One tool with a
`metric` argument (`power`, `hr`, `pace`, `gap`) rather than four, since the
endpoints differ only by path. Each returns a bare array of buckets; the spec
documents more per bucket than `min`, `max` and `secs`, but none of the
histogram endpoints fill the rest in, so only those three are kept and empty
buckets are dropped. Checked live on 2026-10-24: pace and GAP bounds are
speeds in m/s (a run averaging 3.393 m/s peaks in the 3.32-3.41 bucket, and
`total_secs` matches its moving time), and power buckets are 25 W wide.

Then **`search_intervals`** — 35 tools, 26 read-only. Wraps
`/activities/interval-search`, which answers 422 unless `minSecs`, `maxSecs`,
`minIntensity` and `maxIntensity` are all sent, so the open ends go over the
wire as explicit wide defaults (0, 86400, 0, 999). It returns whole activity
records; the match itself is in `interval_summary`, so the default projection
keeps that plus a few identifying fields. The endpoint takes no date range.

Then **`update_sport_settings`** — 36 tools, 10 writers. FTP, indoor FTP, W',
threshold and max HR, threshold pace and the three zone arrays, for the
settings group that contains a named sport type (the group is found by
reading `/sport-settings` first, so "Ride" and "GravelRide" land on the same
record). Threshold pace is taken as "3:56/km", "6:20/mi" or "1:45/100m" and
converted here: the API stores it as m/s for every sport, swimming included,
and quietly accepts a pace where the speed belongs. `recalcHrZones` defaults
to true only when `lthr` or `max_hr` changes and no explicit `hr_zones` are
given; an FTP or pace change leaves the HR zones alone. Deliberately left out:
`sport-settings/{id}/apply`, which re-scores past activities with the new
zones. That rewrites history, so it waits for a decision on how the delete
gate should cover it.

Then **`duplicate_events` and `apply_plan`** — 38 tools, 12 writers. Both
`CREATE`. `duplicate_events` posts `eventIds`, `numCopies` and
`weeksBetween` to `/duplicate-events` and trims the copies to the event
summary set, so a 12-week repeat does not come back with twelve
`workout_doc` blobs. `apply_plan` posts `folder_id` and `start_date_local`
to `/events/apply-plan`; with `create_folder` (type `PLAN`) and
`create_workout` (`day`) a whole block is now build-then-apply rather than
one `create_event` per session. The optional `extra_workouts` on apply-plan
is left out.

Then the rest of Tier 1 — 45 tools, 27 read-only and 18 writers:

- **`create_events`** posts an array to `/events/bulk`. Each entry is the
  same zod shape as `create_event` (now built by one shared function), so the
  category enum and date checks apply per entry, and the created events come
  back trimmed to the summary set.
- **`get_activity_messages` and `add_activity_message`** read and post
  activity comments (`/activity/{id}/messages`, body `{content}`). Posting is
  the only write here that another person reads, and there is no delete tool
  for it, so the description tells the model to show the exact text and get
  the user's go ahead first. Blank comments are refused by the schema.
- **Gear:** `create_gear`, `update_gear`, `add_gear_reminder`,
  `update_gear_reminder`. `type` is an enum of the 46 types the API takes.
  Retiring sets `retired` to today in the athlete's zone; un-retiring sends
  `""`, because the API ignores a null there. Reminder thresholds are taken
  in km and hours and sent as metres and seconds. The reminder PUT carries
  the `reset` and `snoozeDays` query parameters the spec requires, and
  `reset: true` is how a model marks the maintenance done. Gear delete is
  left out.

### Live check, 2026-10-28

Every Tier 1 writer was run once against the live account, and each change
was undone where a tool allows it:

- `update_sport_settings`: a partial PUT changes only the fields sent; the
  rest of the record (zones, other thresholds) is kept.
- `create_events`: works with full datetimes, but answered 422 to a
  date-only `start_date_local`, after creating the entries before the bad one.
  The bulk endpoint is not all-or-nothing. Bare dates are now sent as
  midnight, and the description says to check the range before retrying.
- `duplicate_events`: copies land a week apart at the same time of day.
- `apply_plan`: returns `{}`. A workout's `day` is an offset from
  `start_date`, so day 1 lands the day *after*. The `day` parameter on
  `create_workout`/`update_workout` was documented as 1-based and is now
  0-based to match.
- `get_activity_messages`/`add_activity_message`: post and read back fine.
  The post returns the whole chat record, not the message.
- Gear: create, add a reminder (3000 km stored as 3,000,000 m), edit and
  reset it (50 h stored as 180,000 s), and retire (dated in the athlete's
  zone) all work. There is no gear delete, so the test item stays, retired.
- `search_intervals`: an 8-25 minute search at 90-110% returned single
  efforts of that length at threshold pace, as expected.

Worth trimming later: `create_workout` and `list_workouts` return each
workout's full `workout_doc` with per-zone times, about 2 KB a workout.

## Tier 1 — next up

Tier 1 is done. Tier 2 below is next.

## Tier 2 — nice to have

1. **Annual training plan** — periodization targets and week notes.
2. **`get_upcoming_workouts`** — the next N planned sessions with their IDs.
   Possibly just better defaults on `list_events` rather than a new tool.
3. **`get_activities_around`** — the activities surrounding a given one, for
   "what was I doing the week of that breakthrough ride".
4. **Multi-athlete / coach support** — `list_athletes` with access levels, and
    an optional `athlete_id` on the read tools. The athlete is currently fixed
    by `INTERVALS_ATHLETE_ID`. This is an architectural change, not a tool:
    worth deciding before the tool count grows further.
5. **Athlete notes** read/write.
6. **Custom items** — custom charts, fields, zones, dashboard panels. Large API
    surface, narrow audience; upstream ships a schema resource to make it usable.
7. **File downloads** — original / FIT / GPX. Awkward over MCP (binary as
    base64 bloats context); only worth it if we return a resource link or write
    to a path rather than inlining bytes.
8. **Manual and route writes** — `bulk_create_manual_activities` (upsert by
    external ID) is how you backfill non-synced training.
9. **Event deletes beyond one at a time** — `events/bulk-delete` and the
    `others`/`notBefore` options on the single delete. Deliberately left out of
    the first pass: "delete the event I named" is easy to reason about, "delete
    everything added alongside it" is not.

## Beyond tools

- **More resources.** The workout-syntax one is in. Event categories went in as
  shared help text on the two event tools instead of a resource, which keeps it
  in front of the model without a second round trip — worth revisiting if the
  description grows. Custom-item schemas would only follow custom-item tools.
- **Prompts.** Upstream has nine (training analysis, recovery check, weekly
  planning, …). We have none. Cheap to add and they advertise what the server is
  for.
- **Output schemas.** No tool declares one, so a client cannot validate a result
  before handing it to a model.

