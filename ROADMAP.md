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

## Tier 1 — next up

1. **Histograms** — `/activity/{id}/power-histogram`, `hr-histogram`,
   `pace-histogram`, `gap-histogram`. Compact and well suited to an LLM: a
   histogram is a far cheaper read than a stream.
2. **`search_intervals`** — find comparable intervals across the whole history
   ("every 20-minute effort above 95% this year"). The best analysis-shaped tool
   upstream has that we lack.
3. **Sport settings writes** — FTP, FTHR, threshold pace, zones per sport, via
   `/athlete/{athleteId}/sport-settings`. Readable today only through
   `get_athlete fields:["sportSettings"]` and not writable, so "bump my FTP to
   265" is still a trip to the website. Note `sport-settings/{id}/apply`
   rewrites zones on *past* activities — that one is destructive and belongs
   behind the delete gate.
4. **Gear writes and maintenance reminders** — small, self-contained, and the
   kind of thing people actually want nagging about.
5. **Calendar bulk operations** — `events/bulk`, `duplicate-events` (copy a
   session N times with spacing), `events/apply-plan` (drop a folder onto the
   calendar from a date). Hand-building a 12-week block one `create_event` at a
   time burns context; `apply-plan` plus `create_folder` would make plans a
   two-call operation.
6. **Activity messages** — read and post comments on an activity. The coach
   feedback loop; also the only write path that talks to another human, so it
   deserves an explicit confirmation story.

## Tier 2 — nice to have

7. **Annual training plan** — periodization targets and week notes.
8. **`get_upcoming_workouts`** — the next N planned sessions with their IDs.
   Possibly just better defaults on `list_events` rather than a new tool.
9. **`get_activities_around`** — the activities surrounding a given one, for
   "what was I doing the week of that breakthrough ride".
10. **Multi-athlete / coach support** — `list_athletes` with access levels, and
    an optional `athlete_id` on the read tools. The athlete is currently fixed
    by `INTERVALS_ATHLETE_ID`. This is an architectural change, not a tool:
    worth deciding before the tool count grows further.
11. **Athlete notes** read/write.
12. **Custom items** — custom charts, fields, zones, dashboard panels. Large API
    surface, narrow audience; upstream ships a schema resource to make it usable.
13. **File downloads** — original / FIT / GPX. Awkward over MCP (binary as
    base64 bloats context); only worth it if we return a resource link or write
    to a path rather than inlining bytes.
14. **Manual and route writes** — `bulk_create_manual_activities` (upsert by
    external ID) is how you backfill non-synced training.
15. **Event deletes beyond one at a time** — `events/bulk-delete` and the
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
- **HTTP / SSE transport.** We are stdio-only. Upstream supports remote use and
  is appropriately loud that MCP has no built-in auth, so HTTP needs a tunnel or
  an authenticating proxy in front. Note `get_fitness_chart` compares dates
  against the host's local day, which stops being the athlete's day as soon as
  the server is not on their machine.
