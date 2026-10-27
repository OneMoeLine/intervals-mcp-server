/** Pure, server-independent helpers: response projection, stream downsampling
 *  and the shared zod input fragments. Kept apart from index.ts, which
 *  self-starts on import, so they can be exercised directly. */
import { z } from "zod";

/** Compact default for activity records. The full object carries ~184 fields,
 *  half of them null for any given sport, at ~4.8 KB per activity. */
export const ACTIVITY_SUMMARY_FIELDS = [
  "id",
  "name",
  "type",
  "start_date_local",
  "race",
  "description",
  "tags",
  "distance",
  "moving_time",
  "elapsed_time",
  "total_elevation_gain",
  "average_speed",
  "max_speed",
  "pace",
  "gap",
  "average_heartrate",
  "max_heartrate",
  "average_cadence",
  "calories",
  "icu_training_load",
  "icu_atl",
  "icu_ctl",
  "icu_intensity",
  "trimp",
  "hr_load",
  "pace_load",
  "has_heartrate",
  "device_watts",
  "stream_types",
  "interval_summary",
];

/** Compact default for calendar events. Chiefly excludes workout_doc, the
 *  structured-workout blob that dominates an event's ~1.7 KB. */
export const EVENT_SUMMARY_FIELDS = [
  "id",
  "name",
  "category",
  "type",
  "start_date_local",
  "end_date_local",
  "description",
  "moving_time",
  "distance",
  "indoor",
  "icu_training_load",
  "icu_intensity",
  "paired_activity_id",
  "show_as_note",
];

/** Shared `fields` input. */
export const fieldsParam = (summary: string[], total: number) =>
  z
    .array(z.string())
    .optional()
    .describe(
      `Fields to return. Defaults to a compact ${summary.length}-field summary; ` +
        `the full record has ~${total} fields, many of them null. Pass ["*"] for everything.`
    );

/** Interval search returns whole activities; the match is in
 *  `interval_summary`, so the default keeps little else. */
export const INTERVAL_SEARCH_SUMMARY_FIELDS = [
  "id",
  "name",
  "type",
  "start_date_local",
  "distance",
  "moving_time",
  "icu_training_load",
  "icu_intensity",
  "interval_summary",
];

/** Per-lap records inside an activity's interval breakdown carry 84 fields. */
export const INTERVAL_SUMMARY_FIELDS = [
  "id",
  "type",
  "label",
  "group_id",
  "start_time",
  "end_time",
  "moving_time",
  "elapsed_time",
  "distance",
  "zone",
  "intensity",
  "average_watts",
  "weighted_average_watts",
  "max_watts",
  "training_load",
  "average_heartrate",
  "max_heartrate",
  "average_cadence",
  "average_speed",
  "gap",
  "total_elevation_gain",
  "average_gradient",
  "decoupling",
  "average_stride",
];

/** The athlete record is 162 fields, ~15 KB, of which `sportSettings` alone is
 *  ~10 KB and most of the rest is per-vendor sync configuration. */
export const ATHLETE_SUMMARY_FIELDS = [
  "id",
  "name",
  "firstname",
  "lastname",
  "sex",
  "city",
  "state",
  "country",
  "timezone",
  "locale",
  "measurement_preference",
  "weight",
  "icu_weight",
  "icu_resting_hr",
  "height",
  "bio",
  "plan",
  "icu_coach",
  "icu_tags",
  "training_plan_id",
  "training_availability",
];

/** Credential-shaped fields on the athlete record. The payload carries a slot
 *  for the account's own API key and a friend-invite token, either of which
 *  would end up in a model's context, a transcript or a log if it were ever
 *  returned. These are withheld even when the caller asks for everything.
 *  Note `icu_date_of_birth` and `email` are NOT here: they are personal but
 *  not credentials, so they are merely absent from the default field set and
 *  can still be requested explicitly. */
export const REDACTED_ATHLETE_FIELDS = [
  "icu_api_key",
  "icu_friend_invite_token",
];

export const REDACTION_MARKER = "[redacted by intervals-mcp-server]";

/** Replace credential-shaped fields with a marker, at any depth. A marker
 *  rather than a deletion, so it is visible that something was withheld on
 *  purpose. Every tool result passes through this, so a credential that turns
 *  up in an unexpected response is still withheld. */
export function redact(data: unknown, keys: string[]): unknown {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((r) => redact(r, keys));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    out[k] =
      keys.includes(k) && v !== null && v !== undefined
        ? REDACTION_MARKER
        : redact(v, keys);
  }
  return out;
}

/** Wellness records are 47 fields; this keeps the fitness model, the measured
 *  vitals and the subjective scores that `update_wellness` can write. */
export const WELLNESS_SUMMARY_FIELDS = [
  "id",
  "ctl",
  "atl",
  "rampRate",
  "weight",
  "restingHR",
  "hrv",
  "hrvSDNN",
  "avgSleepingHR",
  "sleepSecs",
  "sleepScore",
  "sleepQuality",
  "soreness",
  "fatigue",
  "stress",
  "mood",
  "motivation",
  "injury",
  "kcalConsumed",
  "steps",
  "vo2max",
  "readiness",
  "comments",
];

/** Curve records carry rank tables, power models and a map plot alongside the
 *  curve itself; `secs` and `values` are the curve. */
export const POWER_CURVE_SUMMARY_FIELDS = [
  "id",
  "label",
  "start_date_local",
  "end_date_local",
  "days",
  "secs",
  "values",
  "watts_per_kg",
  "moving_time",
  "training_load",
  "weight",
  "activity_id",
  "vo2max_5m",
];

/** HR curves are the same shape as power curves without the models, ranks and
 *  map plot; `secs` and `values` are the curve and the rest is provenance. */
export const HR_CURVE_SUMMARY_FIELDS = [
  "id",
  "label",
  "start_date_local",
  "end_date_local",
  "days",
  "secs",
  "values",
  "moving_time",
  "training_load",
  "activity_id",
];

/** Pace curves are indexed by distance rather than duration: `distance`
 *  (metres) against `values` (seconds taken). `type` earns its place in the
 *  default - it reads PACE or GAP, so a grade-adjusted response says so
 *  instead of looking like a plain one. `paceModels` is a couple of numbers
 *  (critical speed and D') rather than a table. */
export const PACE_CURVE_SUMMARY_FIELDS = [
  "id",
  "label",
  "type",
  "start_date_local",
  "end_date_local",
  "days",
  "distance",
  "values",
  "moving_time",
  "training_load",
  "activity_id",
  "paceModels",
];

/** Keys present across a set of records. The API returns a fixed key set, with
 *  nulls for metrics that do not apply, so this is the authoritative list. */
export function knownKeys(records: unknown[]): Set<string> {
  const known = new Set<string>();
  for (const record of records) {
    if (record && typeof record === "object") {
      for (const k of Object.keys(record)) known.add(k);
    }
  }
  return known;
}

/** A name matching no record is a typo rather than a missing value, so report
 *  it with the valid names instead of silently dropping it. */
export function assertKnownFields(fields: string[], known: Set<string>): void {
  if (known.size === 0) return; // empty result set: nothing to validate against
  const unknown = fields.filter((f) => !known.has(f));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown field(s): ${unknown.join(", ")}. ` +
        `Valid fields are: ${[...known].sort().join(", ")}`
    );
  }
}

export function pickFields(record: unknown, fields: string[]): unknown {
  if (!record || typeof record !== "object") return record;
  const src = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in src) out[f] = src[f];
  }
  return out;
}

/** Project each record down to `fields`, preserving the array/object shape.
 *
 *  `validate` guards caller-supplied names only. A summary set is this
 *  server's own list and must never fail a call: the API omits keys per
 *  record rather than nulling them - a single event carries no
 *  `paired_activity_id` where the list of events does - so validating a
 *  default turns a perfectly good read into an error. */
export function project(
  data: unknown,
  fields: string[],
  validate = true
): unknown {
  if (fields.includes("*")) return data;
  const records = Array.isArray(data) ? data : [data];
  if (validate) assertKnownFields(fields, knownKeys(records));
  return Array.isArray(data)
    ? data.map((r) => pickFields(r, fields))
    : pickFields(data, fields);
}

/** The `fields` contract every trimming tool shares: the caller's names when
 *  they passed any, else the tool's summary set. Only the caller's names are
 *  checked for typos - see `project`. */
export function projectFields(
  data: unknown,
  fields: string[] | undefined,
  summary: string[]
): unknown {
  return fields ? project(data, fields) : project(data, summary, false);
}

/** `projectFields` for records nested under `keys`. */
export function projectNestedFields(
  data: unknown,
  keys: string[],
  fields: string[] | undefined,
  summary: string[]
): unknown {
  return fields
    ? projectNested(data, keys, fields)
    : projectNested(data, keys, summary, false);
}

/** Project the records inside named array fields, leaving the wrapper intact.
 *  Used where the bulk of a response is a nested list rather than the top-level
 *  object, as with an activity's interval breakdown. Field names are validated
 *  against the union of all targeted arrays so a name valid in one of them is
 *  not rejected because of another, and only when `validate` is set - see
 *  `project` for why a default field set is exempt. */
export function projectNested(
  data: unknown,
  keys: string[],
  fields: string[],
  validate = true
): unknown {
  if (fields.includes("*")) return data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const src = data as Record<string, unknown>;
  const targets = keys.filter((k) => Array.isArray(src[k]));
  if (targets.length === 0) return data;

  if (validate) {
    assertKnownFields(fields, knownKeys(targets.flatMap((k) => src[k] as unknown[])));
  }

  const out: Record<string, unknown> = { ...src };
  for (const k of targets) {
    out[k] = (src[k] as unknown[]).map((r) => pickFields(r, fields));
  }
  return out;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

/** Resource IDs are spliced into API paths, so each is held to its real
 *  format: a slash, dot, `%`, `?` or `#` could otherwise steer the request to a
 *  different endpoint. Activity IDs are Intervals.icu's own ("i12345678") or a
 *  bare number for some synced activities; events, workouts and routes are
 *  numeric. */
export const ACTIVITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const NUMERIC_ID_RE = /^\d{1,20}$/;

export const activityId = () =>
  z
    .string()
    .regex(ACTIVITY_ID_RE, "Must be an activity ID such as i12345678")
    .describe("The activity ID");

export const numericId = (description: string) =>
  z.string().regex(NUMERIC_ID_RE, "Must be a numeric ID").describe(description);

/** Validate dates up front so a malformed value fails with an actionable
 *  message instead of a confusing 422 from the API. */
export const isoDate = (description: string) =>
  z
    .string()
    .regex(DATE_RE, "Must be a date in YYYY-MM-DD format")
    .describe(description);

export const isoDateTime = (description: string) =>
  z
    .string()
    .regex(DATETIME_RE, "Must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS")
    .describe(description);

/** A 1-10 subjective wellness score. */
export const score = (description: string) =>
  z.number().min(1).max(10).optional().describe(description);

/** Default samples per stream channel. A long ride is tens of thousands of
 *  samples across ~8 channels, which would otherwise exhaust the caller's
 *  context in a single tool call. */
export const DEFAULT_STREAM_POINTS = 500;

/** Evenly spaced subsample that always keeps the first and last points. */
export function decimate<T>(values: T[], maxPoints: number): T[] {
  if (values.length <= maxPoints) return values;
  // Guard the single-point case: the step below would divide by zero.
  if (maxPoints <= 1) return values.slice(0, 1);
  const step = (values.length - 1) / (maxPoints - 1);
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(values[Math.round(i * step)]);
  }
  return out;
}

/** Intervals.icu returns streams as [{ type, data: [...] }, ...]. Decimate each
 *  channel and record that we did, so the caller knows the resolution it got. */
export function downsampleStreams(data: unknown, maxPoints: number): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((stream) => {
    if (stream === null || typeof stream !== "object") return stream;
    const channel = stream as Record<string, unknown>;
    if (!Array.isArray(channel.data)) return stream;
    const original = channel.data.length;
    if (original <= maxPoints) return stream;
    return {
      ...channel,
      data: decimate(channel.data, maxPoints),
      downsampled: { original_points: original, returned_points: maxPoints },
    };
  });
}

/** A pace as people write it: minutes:seconds per km, mile or 100 m. */
export const PACE_RE = /^\s*(\d{1,2}):([0-5]\d)\s*\/\s*(km|mi|100m)\s*$/i;

const PACE_UNIT_METRES: Record<string, number> = {
  km: 1000,
  mi: 1609.344,
  "100m": 100,
};

/** "3:56/km" to the speed in m/s that Intervals.icu stores as
 *  `threshold_pace` for every sport, swimming included. Sending a pace where
 *  a speed belongs is not rejected - it is stored as a nonsense threshold -
 *  so the conversion happens here rather than being left to the caller. */
export function paceToSpeed(pace: string): number {
  const m = PACE_RE.exec(pace);
  if (!m) throw new Error(`"${pace}" is not a pace like 3:56/km, 6:20/mi or 1:45/100m.`);
  const secs = Number(m[1]) * 60 + Number(m[2]);
  if (secs === 0) throw new Error("A pace of 0:00 is not a threshold.");
  return Number((PACE_UNIT_METRES[m[3].toLowerCase()] / secs).toFixed(4));
}

/** Gear types the API accepts: whole items, then components. */
export const GEAR_TYPES = [
  "Bike", "Shoes", "Wetsuit", "RowingMachine", "Skis", "Snowboard", "Boat",
  "Board", "Equipment", "Accessories", "Apparel", "Computer", "Light",
  "Battery", "Brake", "BrakePads", "Rotor", "Drivetrain", "BottomBracket",
  "Cassette", "Chain", "Chainrings", "Crankset", "Derailleur", "Pedals",
  "Lever", "Cable", "Frame", "Fork", "Handlebar", "Headset", "Saddle",
  "Seatpost", "Shock", "Stem", "Axel", "Hub", "Trainer", "Tube", "Tyre",
  "Wheel", "Wheelset", "PowerMeter", "Cleats", "CyclingShoes", "Paddle",
] as const;

/** Activity comments: who, when and what. */
export const MESSAGE_SUMMARY_FIELDS = [
  "id",
  "name",
  "type",
  "created",
  "content",
  "attachment_url",
];

/** The activity histograms, each at `/activity/{id}/{metric}-histogram`. */
export const HISTOGRAM_METRICS = ["power", "hr", "pace", "gap"] as const;

export interface HistogramBucket {
  min: number | null;
  max: number | null;
  secs: number;
}

/** Reduce a histogram response - a bare array of buckets - to the three
 *  fields the API actually fills in. The spec documents more per bucket, but
 *  none of the histogram endpoints populate them. Empty buckets go: every
 *  bucket carries its own bounds, so dropping one loses nothing but tokens. */
export function histogram(data: unknown): {
  total_secs: number;
  buckets: HistogramBucket[];
} {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const buckets: HistogramBucket[] = [];
  for (const raw of Array.isArray(data) ? data : []) {
    if (raw === null || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    const secs = num(b.secs) ?? 0;
    if (secs <= 0) continue;
    buckets.push({ min: num(b.min), max: num(b.max), secs });
  }
  buckets.sort((a, b) => (a.min ?? -Infinity) - (b.min ?? -Infinity));
  const total_secs = buckets.reduce((sum, b) => sum + b.secs, 0);
  return { total_secs, buckets };
}

/** Drop keys whose value is undefined, so a partial update sends only what the
 *  caller actually supplied. An explicit null is kept: it is how the API is
 *  told to clear a field, which is different from leaving it alone. */
export function compactBody(
  fields: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined)
  );
}

/** Calendar event categories, exactly as the API enumerates them. It validates
 *  this strictly and rejects anything else, so near-misses - "RACE" for
 *  RACE_A, "TRAVEL", "STRENGTH" - fail the call rather than degrading. */
export const EVENT_CATEGORIES = [
  "WORKOUT",
  "RACE_A",
  "RACE_B",
  "RACE_C",
  "NOTE",
  "PLAN",
  "HOLIDAY",
  "SICK",
  "INJURED",
  "TARGET",
  "SET_EFTP",
  "SET_FITNESS",
  "FITNESS_DAYS",
  "SEASON_START",
] as const;

/** What each category is for. Inlined into the two event-writing tools because
 *  picking the wrong one is the most likely way for a calendar write to go
 *  wrong, and a bare enum does not say which race letter means what. */
export const EVENT_CATEGORY_HELP =
  "WORKOUT = planned session (put workout syntax in `description`); " +
  "RACE_A/RACE_B/RACE_C = races by priority, A highest; " +
  "NOTE = calendar note; PLAN = training-plan phase block (needs end_date_local); " +
  "HOLIDAY/SICK/INJURED = time off, usually a date range; " +
  "TARGET = performance goal; SET_EFTP/SET_FITNESS/FITNESS_DAYS/SEASON_START = " +
  "fitness-chart adjustments on a date.";

/** The wellness fields the fitness chart is built from. CTL and ATL are the
 *  fitness model; the load pair is what fed them that day. */
export const FITNESS_FIELDS = [
  "id",
  "ctl",
  "atl",
  "rampRate",
  "ctlLoad",
  "atlLoad",
];

export interface FitnessPoint {
  date: string;
  ctl?: number;
  atl?: number;
  form?: number;
  ramp_rate?: number;
  ctl_load?: number;
  atl_load?: number;
  /** Set only on days after `today`, where CTL/ATL come from planned events
   *  rather than completed ones. Absent means measured. */
  projected?: true;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Shape wellness records into a performance-management chart: CTL (fitness),
 *  ATL (fatigue) and form, one point per day, ascending.
 *
 *  Form is CTL - ATL, computed here because the wellness record does not carry
 *  it. Days with no fitness data at all are dropped rather than zero-filled -
 *  a gap in the chart is missing data, and a zero would read as lost fitness.
 *  Future dates are returned when the athlete has planned events and has
 *  "include planned workouts in fitness" enabled upstream; they are flagged
 *  `projected` so a caller cannot mistake a plan for a measurement. */
export function fitnessSeries(
  data: unknown,
  today: string
): { count: number; series: FitnessPoint[]; summary: Record<string, unknown> } {
  const records = Array.isArray(data) ? data : [];
  const series: FitnessPoint[] = [];

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const r = record as Record<string, unknown>;
    const date = typeof r.id === "string" ? r.id : undefined;
    const ctl = num(r.ctl);
    const atl = num(r.atl);
    if (!date || (ctl === undefined && atl === undefined)) continue;

    const point: FitnessPoint = { date };
    if (ctl !== undefined) point.ctl = round1(ctl);
    if (atl !== undefined) point.atl = round1(atl);
    if (ctl !== undefined && atl !== undefined) point.form = round1(ctl - atl);
    const ramp = num(r.rampRate);
    if (ramp !== undefined) point.ramp_rate = round1(ramp);
    const ctlLoad = num(r.ctlLoad);
    if (ctlLoad !== undefined) point.ctl_load = round1(ctlLoad);
    const atlLoad = num(r.atlLoad);
    if (atlLoad !== undefined) point.atl_load = round1(atlLoad);
    if (date > today) point.projected = true;
    series.push(point);
  }

  series.sort((a, b) => a.date.localeCompare(b.date));

  const summary: Record<string, unknown> = {};
  if (series.length > 0) {
    summary.oldest = series[0];
    summary.newest = series[series.length - 1];
    const onToday = series.find((p) => p.date === today);
    if (onToday) summary.today = onToday;
  }

  return { count: series.length, series, summary };
}

/** Folder records carry their children, share tokens and owner alongside the
 *  handful of fields that identify the folder itself. */
export const FOLDER_SUMMARY_FIELDS = [
  "id",
  "name",
  "type",
  "description",
  "num_workouts",
  "duration_weeks",
  "start_date_local",
  "activity_types",
  "visibility",
];
