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
  "icu_date_of_birth",
  "height",
  "bio",
  "plan",
  "icu_coach",
  "icu_tags",
  "training_plan_id",
  "training_availability",
];

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

/** Project each record down to `fields`, preserving the array/object shape. */
export function project(data: unknown, fields: string[]): unknown {
  if (fields.includes("*")) return data;
  const records = Array.isArray(data) ? data : [data];
  assertKnownFields(fields, knownKeys(records));
  return Array.isArray(data)
    ? data.map((r) => pickFields(r, fields))
    : pickFields(data, fields);
}

/** Project the records inside named array fields, leaving the wrapper intact.
 *  Used where the bulk of a response is a nested list rather than the top-level
 *  object, as with an activity's interval breakdown. Field names are validated
 *  against the union of all targeted arrays so a name valid in one of them is
 *  not rejected because of another. */
export function projectNested(
  data: unknown,
  keys: string[],
  fields: string[]
): unknown {
  if (fields.includes("*")) return data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const src = data as Record<string, unknown>;
  const targets = keys.filter((k) => Array.isArray(src[k]));
  if (targets.length === 0) return data;

  const all = targets.flatMap((k) => src[k] as unknown[]);
  assertKnownFields(fields, knownKeys(all));

  const out: Record<string, unknown> = { ...src };
  for (const k of targets) {
    out[k] = (src[k] as unknown[]).map((r) => pickFields(r, fields));
  }
  return out;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

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
