import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { IntervalsClient, segment } from "./api.js";
import {
  ACTIVITY_SUMMARY_FIELDS,
  ATHLETE_SUMMARY_FIELDS,
  DATE_RE,
  DEFAULT_STREAM_POINTS,
  EVENT_CATEGORIES,
  EVENT_CATEGORY_HELP,
  WORKOUT_SUMMARY_FIELDS,
  EVENT_SUMMARY_FIELDS,
  FITNESS_FIELDS,
  FOLDER_SUMMARY_FIELDS,
  GEAR_TYPES,
  HISTOGRAM_METRICS,
  MESSAGE_SUMMARY_FIELDS,
  HR_CURVE_SUMMARY_FIELDS,
  INTERVAL_SEARCH_SUMMARY_FIELDS,
  INTERVAL_SUMMARY_FIELDS,
  PACE_RE,
  PACE_CURVE_SUMMARY_FIELDS,
  POWER_CURVE_SUMMARY_FIELDS,
  REDACTED_ATHLETE_FIELDS,
  WELLNESS_SUMMARY_FIELDS,
  activityId,
  gearId,
  compactBody,
  downsampleStreams,
  fieldsParam,
  fitnessSeries,
  paceToSpeed,
  pickFields,
  histogram,
  isoDate,
  isoDateTime,
  numericId,
  project,
  projectFields,
  projectNested,
  projectNestedFields,
  redact,
  score,
} from "./transform.js";
import { WORKOUT_SYNTAX } from "./workout-syntax.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wrap a payload as a tool result. Deliberately not pretty-printed: the
 *  indentation roughly doubles the token cost and nothing downstream reads it.
 *  Credential fields are withheld here, at the one boundary every result
 *  crosses, rather than trusting each handler to remember. */
function json(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(redact(data, REDACTED_ATHLETE_FIELDS)),
      },
    ],
  };
}

const schemas = new Map<string, z.ZodObject>();

/** A tool's input schema, built once per process and reused by every server
 *  after the first. The hosted Worker builds a server per request, and
 *  constructing the 45 zod schemas costs more CPU than the rest of a request
 *  put together. Keyed by tool name: no schema depends on the config. */
function schema<T extends z.ZodObject>(name: string, build: () => T): T {
  let cached = schemas.get(name) as T | undefined;
  if (!cached) {
    cached = withCompactJsonSchema(build());
    schemas.set(name, cached);
  }
  return cached;
}

/** Every tool's input schema is sent to the model on each session, so the
 *  boilerplate zod adds is dropped from the JSON Schema it advertises: the
 *  `$schema` URI (2020-12 is MCP's default anyway) and the +/-2^53 bounds an
 *  unbounded `.int()` carries. Validation still runs on the zod schema. */
function withCompactJsonSchema<T extends z.ZodObject>(zodSchema: T): T {
  const std = zodSchema["~standard"];
  const json = std.jsonSchema;
  Object.defineProperty(zodSchema, "~standard", {
    value: {
      ...std,
      jsonSchema: {
        input: (options: Parameters<typeof json.input>[0]) =>
          compactJsonSchema(json.input(options)),
        output: json.output,
      },
    },
    configurable: true,
  });
  return zodSchema;
}

function compactJsonSchema<T>(node: T): T {
  if (Array.isArray(node)) return node.map(compactJsonSchema) as T;
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    out[key] = compactJsonSchema(value);
  }
  return out as T;
}

/** Annotations for the tools that only read. `openWorldHint` is true for
 *  every tool in this file: they all reach the Intervals.icu API, whose
 *  contents this server does not control. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
/** A write that overwrites fields on an existing record: destructive in the
 *  MCP sense, and the same call twice leaves the record in the same state. */
const UPDATE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** A write that only ever adds. Not destructive - but each call adds another
 *  record, so repeating it is not a no-op. */
const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** A delete: destructive, and once it has happened, repeating it changes
 *  nothing further. */
const DELETE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** How much deleting this server is willing to do. The gate is here rather
 *  than in a tool argument because a model can set an argument itself:
 *
 *    safe (default) - delete tools are registered, but a calendar event that
 *                     has already happened is refused. Planning mistakes are
 *                     removable; training history is not.
 *    full           - any event can be deleted, past included.
 *    none           - the delete tools are not registered at all, so no
 *                     client can see or call them.
 *
 *  The library-workout delete is unconstrained in both safe and full: a
 *  workout template carries no history of its own. */
export const DELETE_MODES = ["safe", "full", "none"] as const;
export type DeleteMode = (typeof DELETE_MODES)[number];

/** Normalise a delete mode from config, or undefined if it names none of
 *  them. Unset means `safe`. */
export function parseDeleteMode(
  value: string | undefined
): DeleteMode | undefined {
  const mode = (value ?? "safe").toLowerCase();
  return DELETE_MODES.includes(mode as DeleteMode)
    ? (mode as DeleteMode)
    : undefined;
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Today as YYYY-MM-DD in the athlete's timezone. Without one, the host's
 *  local zone stands in, which is the athlete's own day whenever the server
 *  runs on their machine - the stdio case. A hosted server runs in UTC and
 *  must be told. Read per call rather than once at startup, so a
 *  long-running server does not keep yesterday's idea of "past". */
export function localToday(timeZone?: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

export interface ServerConfig {
  apiKey: string;
  athleteId: string;
  deleteMode: DeleteMode;
  /** IANA zone used for "today"; the host's zone when unset. */
  timeZone?: string;
  /** API root override, for tests against a fake server. */
  baseUrl?: string;
}

/** Build a server bound to one athlete's account. The stdio entry point calls
 *  this once; the hosted Worker calls it per request, with the signed-in
 *  user's credentials. */
export function createServer(config: ServerConfig): McpServer {
  const client = new IntervalsClient(config.apiKey, config.athleteId, {
    baseUrl: config.baseUrl,
  });
  const server = new McpServer({
    name: "intervals-icu",
    version: "1.0.0",
  });
  const DELETE_MODE = config.deleteMode;

  /** An event's date as the calendar has it, YYYY-MM-DD. Safe mode's history
   *  checks hang on this, so an event whose date cannot be read fails closed
   *  rather than being treated as not-past. */
  async function storedEventDate(eventId: number): Promise<string> {
    const existing = await client.get<{ start_date_local?: string }>(
      `/athlete/${client.athleteId}/events/${segment(eventId)}`
    );
    const date = existing?.start_date_local?.slice(0, 10);
    if (!date || !DATE_RE.test(date)) {
      throw new Error(
        `Could not read the date of event ${eventId}, so delete mode "safe" ` +
          `cannot tell whether it is in the past. Nothing was changed.`
      );
    }
    return date;
  }

  // ── Athlete ────────────────────────────────────────────────────────────────

  server.registerTool(
    "get_athlete",
    {
      title: "Get athlete",
      description:
        "The athlete's identity, physiology and account info. fields " +
        '["sportSettings"] adds per-sport FTP, thresholds and zones (~10 KB). ' +
        "Includes the public profile (name, bio, location). Credentials are " +
        "always withheld; email and date of birth only when named in fields.",
      inputSchema: schema("get_athlete", () =>
        z.object({
          fields: fieldsParam(ATHLETE_SUMMARY_FIELDS, 162),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ fields }) => {
      const data = await client.get(`/athlete/${client.athleteId}`);
      return json(projectFields(data, fields, ATHLETE_SUMMARY_FIELDS));
    }
  );

  server.registerTool(
    "update_sport_settings",
    {
      title: "Update sport settings",
      description:
        "Change one sport's thresholds and zones. Only supply what should " +
        "change. Settings are shared by a group of sport types (Ride covers " +
        "VirtualRide and GravelRide), so any type in the group updates them " +
        "all. Affects how future activities are scored, not past ones. " +
        "Returns the changed fields before and after.",
      inputSchema: schema("update_sport_settings", () =>
        z.object({
          sport: z
            .string()
            .describe("A sport type in the group to update, e.g. Ride, Run, Swim"),
          ftp: z.number().int().positive().optional().describe("FTP in watts"),
          indoor_ftp: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Indoor FTP in watts, where it differs from outdoor"),
          w_prime: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("W' (anaerobic work capacity) in joules"),
          lthr: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Threshold HR in bpm"),
          max_hr: z.number().int().positive().optional().describe("Max HR in bpm"),
          threshold_pace: z
            .string()
            .regex(PACE_RE)
            .optional()
            .describe(
              'Threshold pace, e.g. "3:56/km", "6:20/mi" or "1:45/100m"'
            ),
          power_zones: z
            .array(z.number())
            .optional()
            .describe(
              "Zone upper bounds as % of FTP, ascending, last 999"
            ),
          hr_zones: z
            .array(z.number())
            .optional()
            .describe(
              "Zone upper bounds in bpm, ascending, last = max HR"
            ),
          pace_zones: z
            .array(z.number())
            .optional()
            .describe(
              "Zone upper bounds as % of threshold pace, ascending, last 999"
            ),
          recalc_hr_zones: z
            .boolean()
            .optional()
            .describe(
              "Recalculate HR zones from the new lthr/max_hr. Default: true when " +
              "either changes without hr_zones"
            ),
        })
      ),
      annotations: UPDATE,
    },
    async ({ sport, threshold_pace, recalc_hr_zones, ...rest }) => {
      const changes: Record<string, unknown> = compactBody(rest);
      if (threshold_pace !== undefined) {
        changes.threshold_pace = paceToSpeed(threshold_pace);
      }
      if (Object.keys(changes).length === 0) {
        throw new Error("Nothing to change: supply at least one setting.");
      }

      const all = await client.get<Array<{ id?: number; types?: string[] }>>(
        `/athlete/${client.athleteId}/sport-settings`
      );
      const wanted = sport.toLowerCase();
      const current = (Array.isArray(all) ? all : []).find((s) =>
        s.types?.some((t) => t.toLowerCase() === wanted)
      );
      if (current?.id === undefined) {
        const known = (Array.isArray(all) ? all : [])
          .map((s) => s.types?.join("/"))
          .filter(Boolean)
          .join(", ");
        throw new Error(
          `No sport settings cover "${sport}". The athlete has: ${known || "none"}.`
        );
      }

      // Recalculating rewrites the athlete's HR zones, so it is only the default
      // when the change is one the zones are derived from.
      const recalc =
        recalc_hr_zones ??
        (rest.hr_zones === undefined &&
          (rest.lthr !== undefined || rest.max_hr !== undefined));
      const updated = await client.request<Record<string, unknown>>(
        "PUT",
        `/athlete/${client.athleteId}/sport-settings/${current.id}`,
        { recalcHrZones: String(recalc) },
        changes
      );
      const keys = Object.keys(changes);
      if (recalc && !keys.includes("hr_zones")) keys.push("hr_zones");
      return json({
        id: current.id,
        types: current.types,
        before: pickFields(current, keys),
        after: pickFields(updated, keys),
      });
    }
  );

  // ── Activities ─────────────────────────────────────────────────────────────

  server.registerTool(
    "list_activities",
    {
      title: "List activities",
      description:
        "List activities in a date range.",
      inputSchema: schema("list_activities", () =>
        z.object({
          oldest: isoDate("Start date YYYY-MM-DD"),
          newest: isoDate("End date YYYY-MM-DD"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("Maximum number of activities to return"),
          fields: fieldsParam(ACTIVITY_SUMMARY_FIELDS, 184),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ oldest, newest, limit, fields }) => {
      const params: Record<string, string> = { oldest, newest };
      if (limit !== undefined) params.limit = String(limit);
      const data = await client.get(
        `/athlete/${client.athleteId}/activities`,
        params
      );
      return json(projectFields(data, fields, ACTIVITY_SUMMARY_FIELDS));
    }
  );

  server.registerTool(
    "get_activity",
    {
      title: "Get activity",
      description:
        "Get one activity by ID.",
      inputSchema: schema("get_activity", () =>
        z.object({
          activity_id: activityId(),
          fields: fieldsParam(ACTIVITY_SUMMARY_FIELDS, 184),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ activity_id, fields }) => {
      const data = await client.get(`/activity/${segment(activity_id)}`);
      return json(projectFields(data, fields, ACTIVITY_SUMMARY_FIELDS));
    }
  );

  server.registerTool(
    "search_activities",
    {
      title: "Search activities",
      description: "Search for activities by name or tag.",
      inputSchema: schema("search_activities", () =>
        z.object({
          query: z.string().describe("Search query (name or tag)"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Maximum number of results (the API returns 30 by default)"),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const params: Record<string, string> = { q: query };
      if (limit !== undefined) params.limit = String(limit);
      return json(
        await client.get(`/athlete/${client.athleteId}/activities/search`, params)
      );
    }
  );

  server.registerTool(
    "get_activity_intervals",
    {
      title: "Get activity intervals",
      description:
        "An activity's laps/intervals. `fields` applies to each lap in " +
        "`icu_intervals` and `icu_groups`.",
      inputSchema: schema("get_activity_intervals", () =>
        z.object({
          activity_id: activityId(),
          fields: fieldsParam(INTERVAL_SUMMARY_FIELDS, 84),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ activity_id, fields }) => {
      const data = await client.get(`/activity/${segment(activity_id)}/intervals`);
      return json(
        projectNestedFields(
          data,
          ["icu_intervals", "icu_groups"],
          fields,
          INTERVAL_SUMMARY_FIELDS
        )
      );
    }
  );

  server.registerTool(
    "search_intervals",
    {
      title: "Search intervals",
      description:
        "Find activities, newest first across all history, with intervals of " +
        "a given length and intensity, e.g. 15-25 min at 90-105% of threshold " +
        "(FTP, threshold HR or pace, by the interval's target). Each has an " +
        "`interval_summary` like \"2x 8m 162w\". No date filter.",
      inputSchema: schema("search_intervals", () =>
        z.object({
          min_secs: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Shortest interval to match, in seconds (default 0)"),
          max_secs: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Longest interval to match, in seconds (default 86400)"),
          min_intensity: z
            .number()
            .min(0)
            .optional()
            .describe("Lowest intensity, % of threshold e.g. 90 (default 0)"),
          max_intensity: z
            .number()
            .min(0)
            .optional()
            .describe("Highest intensity, % of threshold e.g. 105 (default 999)"),
          type: z
            .enum(["AUTO", "POWER", "HR", "PACE"])
            .optional()
            .describe(
              "What the interval targeted - not the sport. Omit to match any."
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Maximum number of activities to return (default 30)"),
          fields: fieldsParam(INTERVAL_SEARCH_SUMMARY_FIELDS, 184),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({
      min_secs = 0,
      max_secs = 86_400,
      min_intensity = 0,
      max_intensity = 999,
      type,
      limit = 30,
      fields,
    }) => {
      if (min_secs > max_secs || min_intensity > max_intensity) {
        throw new Error("Each minimum must be no greater than its maximum.");
      }
      // The API answers 422 unless all four bounds are sent, so the open ends
      // go over the wire as explicit wide defaults.
      const params: Record<string, string> = {
        minSecs: String(min_secs),
        maxSecs: String(max_secs),
        minIntensity: String(min_intensity),
        maxIntensity: String(max_intensity),
        limit: String(limit),
      };
      if (type) params.type = type;
      const data = await client.get(
        `/athlete/${client.athleteId}/activities/interval-search`,
        params
      );
      return json(projectFields(data, fields, INTERVAL_SEARCH_SUMMARY_FIELDS));
    }
  );

  server.registerTool(
    "get_activity_streams",
    {
      title: "Get activity streams",
      description:
        "An activity's time series (power, HR, cadence, speed, altitude, GPS...), " +
        `each channel downsampled to ${DEFAULT_STREAM_POINTS} points by default. ` +
        "Ask only for the types you need.",
      inputSchema: schema("get_activity_streams", () =>
        z.object({
          activity_id: activityId(),
          types: z
            .array(z.string())
            .optional()
            .describe(
              'Channels to return, e.g. ["watts","heartrate","cadence"]. Omit for all channels (much larger).'
            ),
          max_points: z
            .number()
            .int()
            .min(1)
            .max(10000)
            .optional()
            .describe(
              `Downsample each channel to at most this many points (default ${DEFAULT_STREAM_POINTS})`
            ),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ activity_id, types, max_points }) => {
      const params: Record<string, string> = {};
      if (types && types.length > 0) params.types = types.join(",");
      const data = await client.get(`/activity/${segment(activity_id)}/streams`, params);
      return json(downsampleStreams(data, max_points ?? DEFAULT_STREAM_POINTS));
    }
  );

  server.registerTool(
    "get_activity_power_curve",
    {
      title: "Get activity power curve",
      description: "Get the mean maximal power curve for a specific activity.",
      inputSchema: schema("get_activity_power_curve", () =>
        z.object({
          activity_id: activityId(),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ activity_id }) =>
      json(await client.get(`/activity/${segment(activity_id)}/power-curve`))
  );

  server.registerTool(
    "get_activity_best_efforts",
    {
      title: "Get activity best efforts",
      description:
        "Best efforts within an activity, e.g. peak 5-min power, fastest 1 " +
        "km. Give exactly one of duration or distance.",
      inputSchema: schema("get_activity_best_efforts", () =>
        z.object({
          activity_id: activityId(),
          stream: z
            .string()
            .describe(
              "Stream on the activity (see its `stream_types`), e.g. watts, " +
              "heartrate, velocity_smooth. For pace use velocity_smooth."
            ),
          duration: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Effort length in seconds, e.g. 300 for peak 5-minute"),
          distance: z
            .number()
            .positive()
            .optional()
            .describe("Effort length in meters, e.g. 1000 for fastest 1km"),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ activity_id, stream, duration, distance }) => {
      // The raw-shape registration API takes no object-level zod refinement, so
      // the either/or rule is enforced here rather than in the schema.
      if ((duration === undefined) === (distance === undefined)) {
        throw new Error(
          "Provide exactly one of duration (seconds) or distance (meters)."
        );
      }
      const params: Record<string, string> = { stream };
      if (duration !== undefined) params.duration = String(duration);
      if (distance !== undefined) params.distance = String(distance);
      return json(
        await client.get(`/activity/${segment(activity_id)}/best-efforts`, params)
      );
    }
  );

  server.registerTool(
    "get_activity_weather",
    {
      title: "Get activity weather",
      description: "Get the weather summary for an activity.",
      inputSchema: schema("get_activity_weather", () =>
        z.object({
          activity_id: activityId(),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ activity_id }) =>
      json(await client.get(`/activity/${segment(activity_id)}/weather-summary`))
  );

  server.registerTool(
    "get_activity_histogram",
    {
      title: "Get activity histogram",
      description:
        "Time in each power, HR, pace or GAP band for one activity, as {min, " +
        "max, secs} buckets. Much cheaper than streams for \"how long above " +
        "300 W\". Watts, bpm, and m/s for pace and gap; empty buckets omitted.",
      inputSchema: schema("get_activity_histogram", () =>
        z.object({
          activity_id: activityId(),
          metric: z
            .enum(HISTOGRAM_METRICS)
            .describe(
              "What to bucket by: power, hr, pace, or gap (grade adjusted pace)"
            ),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ activity_id, metric }) => {
      const data = await client.get<unknown>(
        `/activity/${segment(activity_id)}/${metric}-histogram`
      );
      return json({ metric, ...histogram(data) });
    }
  );

  server.registerTool(
    "get_activity_messages",
    {
      title: "Get activity comments",
      description:
        "Comments on an activity (coach feedback, own notes), oldest first.",
      inputSchema: schema("get_activity_messages", () =>
        z.object({
          activity_id: activityId(),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ activity_id }) =>
      json(
        project(
          await client.get(`/activity/${segment(activity_id)}/messages`),
          MESSAGE_SUMMARY_FIELDS,
          false
        )
      )
  );

  server.registerTool(
    "add_activity_message",
    {
      title: "Comment on activity",
      description:
        "Post a comment on an activity, as the athlete. Anyone who can see " +
        "the activity, a coach included, sees it, and it cannot be deleted " +
        "here: show the user the exact text and get their go-ahead first.",
      inputSchema: schema("add_activity_message", () =>
        z.object({
          activity_id: activityId(),
          content: z
            .string()
            .trim()
            .min(1)
            .max(4000)
            .describe("The comment text"),
        })
      ),
      annotations: CREATE,
    },
    async ({ activity_id, content }) => {
      // The API answers with the whole chat record; the new message's ID is
      // the part worth keeping.
      const posted = await client.post<{ id?: number }>(
        `/activity/${segment(activity_id)}/messages`,
        { content }
      );
      return json({ id: posted?.id, activity_id, content });
    }
  );

  server.registerTool(
    "update_activity",
    {
      title: "Update activity",
      description:
        "Edit a completed activity's name, notes, type, flags, tags or " +
        "subjective scores. Only supply what should change.",
      inputSchema: schema("update_activity", () =>
        z.object({
          activity_id: activityId(),
          name: z.string().optional().describe("Activity title"),
          description: z.string().optional().describe("Activity notes"),
          type: z
            .string()
            .optional()
            .describe(
              "Sport type, e.g. Ride, VirtualRide, Run, Swim"
            ),
          sub_type: z
            .enum(["NONE", "COMMUTE", "WARMUP", "COOLDOWN", "RACE"])
            .optional()
            .describe("Activity sub-type"),
          race: z.boolean().optional().describe("Mark the activity as a race"),
          trainer: z.boolean().optional().describe("Recorded indoors on a trainer"),
          commute: z.boolean().optional().describe("Mark the activity as a commute"),
          tags: z
            .array(z.string())
            .optional()
            .describe("Replaces the whole tag list"),
          feel: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe("How it felt, 1 (terrible) to 5 (great)"),
          icu_rpe: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe("Rate of perceived exertion, 1-10"),
        })
      ),
      annotations: UPDATE,
    },
    async ({ activity_id, ...fields }) =>
      json(await client.put(`/activity/${segment(activity_id)}`, compactBody(fields)))
  );

  // ── Power & Performance ────────────────────────────────────────────────────

  /** Power, HR and pace curves are one endpoint family: same request shape, same
   *  wrapper back - a `list` of curves plus an `activities` lookup map roughly as
   *  large as the curves themselves. Only the path, the summary set and pace's
   *  grade-adjustment flag differ, so one tool serves all three. */
  const CURVES = {
    power: { path: "/power-curves", summary: POWER_CURVE_SUMMARY_FIELDS },
    hr: { path: "/hr-curves", summary: HR_CURVE_SUMMARY_FIELDS },
    pace: { path: "/pace-curves", summary: PACE_CURVE_SUMMARY_FIELDS },
  } as const;

  server.registerTool(
    "get_curves",
    {
      title: "Get best-effort curves",
      description:
        "Best efforts across one sport's activities. power: best watts held " +
        "for each duration; hr: highest average HR for each duration (both " +
        "`secs` against `values`). pace: best times by distance, `distance` " +
        "(m) against `values` (s).",
      inputSchema: schema("get_curves", () =>
        z.object({
          metric: z.enum(["power", "hr", "pace"]).describe("Which curve"),
          type: z.string().describe("Exactly one sport type, e.g. Ride, Run, Swim"),
          oldest: isoDate("Start date YYYY-MM-DD").optional(),
          newest: isoDate("End date YYYY-MM-DD").optional(),
          curves: z.string().optional().describe('Which curves, e.g. "42d" or "all"'),
          gap: z
            .boolean()
            .optional()
            .describe(
              "pace only: grade adjusted pace; each curve's `type` says PACE or GAP"
            ),
          fields: z
            .array(z.string())
            .optional()
            .describe('Fields per curve (default: a summary; ["*"] for all)'),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ metric, fields, ...rest }) => {
      if (rest.gap !== undefined && metric !== "pace") {
        throw new Error("gap applies only to metric pace.");
      }
      const { path, summary } = CURVES[metric];
      // Everything else is a query parameter; a boolean goes over the wire as
      // "true"/"false".
      const params: Record<string, string> = Object.fromEntries(
        Object.entries(compactBody(rest)).map(([k, v]) => [k, String(v)])
      );
      const data = await client.get(`/athlete/${client.athleteId}${path}`, params);
      if (fields?.includes("*")) return json(data);

      const trimmed = projectNestedFields(data, ["list"], fields, summary);
      // `activities` is a lookup map roughly as large as the curves themselves.
      if (trimmed && typeof trimmed === "object" && !Array.isArray(trimmed)) {
        const { activities, ...kept } = trimmed as Record<string, unknown>;
        return json(kept);
      }
      return json(trimmed);
    }
  );

  // ── Wellness ───────────────────────────────────────────────────────────────

  server.registerTool(
    "list_wellness",
    {
      title: "List wellness records",
      description:
        "Wellness records in a date range: CTL/ATL, HRV, resting HR, sleep, " +
        "weight, subjective scores. For one day, give only oldest.",
      inputSchema: schema("list_wellness", () =>
        z.object({
          oldest: isoDate("Start date YYYY-MM-DD"),
          newest: isoDate("End date YYYY-MM-DD (default: oldest)").optional(),
          fields: fieldsParam(WELLNESS_SUMMARY_FIELDS, 47),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ oldest, newest = oldest, fields }) => {
      const data = await client.get(`/athlete/${client.athleteId}/wellness`, {
        oldest,
        newest,
      });
      return json(projectFields(data, fields, WELLNESS_SUMMARY_FIELDS));
    }
  );

  server.registerTool(
    "update_wellness",
    {
      title: "Update wellness record",
      description:
        "Update the wellness record for a date. Only supply what should " +
        "change.",
      inputSchema: schema("update_wellness", () =>
        z.object({
          date: isoDate("Date in YYYY-MM-DD format"),
          weight: z.number().positive().optional().describe("Body weight in kg"),
          restingHR: z
            .number()
            .positive()
            .optional()
            .describe("Resting heart rate (bpm)"),
          hrv: z.number().positive().optional().describe("HRV score"),
          hrvSDNN: z.number().positive().optional().describe("HRV SDNN (ms)"),
          sleepSecs: z
            .number()
            .nonnegative()
            .optional()
            .describe("Sleep duration in seconds"),
          sleepScore: z.number().optional().describe("Sleep quality score"),
          sleepTq: z.number().optional().describe("Sleep time in bed quality"),
          mood: score("Mood score (1-10)"),
          fatigue: score("Fatigue score (1-10)"),
          stress: score("Stress score (1-10)"),
          soreness: score("Soreness score (1-10)"),
          injury: score("Injury score (1-10)"),
          kcalConsumed: z
            .number()
            .nonnegative()
            .optional()
            .describe("Calories consumed"),
          notes: z.string().optional().describe("Free text notes"),
        })
      ),
      annotations: UPDATE,
    },
    async ({ date, ...fields }) =>
      json(
        await client.put(
          `/athlete/${client.athleteId}/wellness/${date}`,
          compactBody(fields)
        )
      )
  );

  server.registerTool(
    "get_fitness_chart",
    {
      title: "Get fitness chart (CTL/ATL/form)",
      description:
        "Daily CTL (fitness), ATL (fatigue) and form (CTL - ATL, aka TSB), " +
        "for trend, freshness and taper questions. Days without data are " +
        "omitted. A future `newest` adds projections from planned workouts, " +
        "flagged `projected: true` (only if the athlete enabled planned " +
        "workouts in fitness).",
      inputSchema: schema("get_fitness_chart", () =>
        z.object({
          oldest: isoDate("Start date YYYY-MM-DD (inclusive)"),
          newest: isoDate(
            "End date YYYY-MM-DD; a future date adds projections"
          ),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ oldest, newest }) => {
      const data = await client.get(`/athlete/${client.athleteId}/wellness`, {
        oldest,
        newest,
      });
      return json(
        fitnessSeries(
          project(data, FITNESS_FIELDS, false),
          localToday(config.timeZone)
        )
      );
    }
  );

  // ── Calendar Events ────────────────────────────────────────────────────────

  server.registerTool(
    "list_events",
    {
      title: "List calendar events",
      description:
        "List calendar events in a date range (without the structured " +
        "workout_doc unless asked for in fields).",
      inputSchema: schema("list_events", () =>
        z.object({
          oldest: isoDate("Start date YYYY-MM-DD"),
          newest: isoDate("End date YYYY-MM-DD"),
          fields: fieldsParam(EVENT_SUMMARY_FIELDS, 62),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ oldest, newest, fields }) => {
      const data = await client.get(`/athlete/${client.athleteId}/events`, {
        oldest,
        newest,
      });
      return json(projectFields(data, fields, EVENT_SUMMARY_FIELDS));
    }
  );

  server.registerTool(
    "get_event",
    {
      title: "Get calendar event",
      description:
        "Get one calendar event by ID. Name workout_doc in fields for the " +
        "structured workout.",
      inputSchema: schema("get_event", () =>
        z.object({
          event_id: numericId("The event ID"),
          fields: fieldsParam(EVENT_SUMMARY_FIELDS, 62),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ event_id, fields }) => {
      const data = await client.get(
        `/athlete/${client.athleteId}/events/${segment(event_id)}`
      );
      return json(projectFields(data, fields, EVENT_SUMMARY_FIELDS));
    }
  );

  /** The bulk endpoint answers 422 to a date-only start, so a bare date is
   *  sent as midnight, which is what the single-event endpoint makes of it. */
  const withStartTime = <T extends { start_date_local: string }>(e: T): T =>
    e.start_date_local.length === 10
      ? { ...e, start_date_local: `${e.start_date_local}T00:00:00` }
      : e;

  /** The fields of one new calendar event: an entry of create_events. */
  const newEventShape = () => ({
    start_date_local: isoDateTime(
      "Start, e.g. 2024-06-01 or 2024-06-01T08:00:00"
    ),
    category: z.enum(EVENT_CATEGORIES).describe("Event category"),
    name: z.string().optional().describe("Event name/title"),
    description: z
      .string()
      .optional()
      .describe(
        "Notes, or workout syntax for a WORKOUT (see " +
        "intervals-icu://workout-syntax)"
      ),
    type: z
      .string()
      .optional()
      .describe(
        "Sport type, e.g. Ride, Run, Swim. Required for RACE_* and SET_EFTP"
      ),
    end_date_local: isoDateTime(
      "End, for PLAN, HOLIDAY, SICK, INJURED"
    ).optional(),
    moving_time: z
      .number()
      .positive()
      .optional()
      .describe(
        "Planned duration in seconds, if the steps don't set it"
      ),
    distance: z
      .number()
      .positive()
      .optional()
      .describe("Planned distance in meters"),
    indoor: z.boolean().optional().describe("Planned as an indoor session"),
    target: z
      .enum(["AUTO", "POWER", "HR", "PACE"])
      .optional()
      .describe("Metric the targets use"),
  });

  server.registerTool(
    "create_events",
    {
      title: "Create calendar events",
      description:
        "Create calendar events - one, or a week of sessions in one call: " +
        "planned workouts, races, notes, time off. For a structured WORKOUT " +
        "put workout syntax (intervals-icu://workout-syntax) in `description`; " +
        "text it cannot parse is kept as plain notes with no load. Not " +
        "all-or-nothing: after an error, entries before the bad one may exist, " +
        "so list_events before retrying. " +
        EVENT_CATEGORY_HELP,
      inputSchema: schema("create_events", () =>
        z.object({
          events: z
            .array(z.object(newEventShape()))
            .min(1)
            .max(100)
            .describe("The events to create"),
        })
      ),
      annotations: CREATE,
    },
    async ({ events }) => {
      const created = await client.post(
        `/athlete/${client.athleteId}/events/bulk`,
        events.map((e) => compactBody(withStartTime(e)))
      );
      return json(project(created, EVENT_SUMMARY_FIELDS, false));
    }
  );

  server.registerTool(
    "update_event",
    {
      title: "Update calendar event",
      description:
        "Change a calendar event. Only supply what should change; a new WORKOUT " +
        "`description` replaces all its steps. TARGET and PLAN events cannot change " +
        "category again: delete and recreate instead." +
        (DELETE_MODE === "safe"
          ? " A past event cannot be moved to today or later (delete mode `safe`)."
          : ""),
      inputSchema: schema("update_event", () =>
        z.object({
          event_id: z.number().int().describe("The event ID"),
          name: z.string().optional().describe("Event name/title"),
          description: z
            .string()
            .optional()
            .describe(
              "Notes, or workout syntax for a WORKOUT (see " +
              "intervals-icu://workout-syntax)"
            ),
          category: z.enum(EVENT_CATEGORIES).optional().describe("Event category"),
          type: z.string().optional().describe("Sport type e.g. Ride, Run, Swim"),
          start_date_local: isoDateTime("Start date/time in ISO 8601 format").optional(),
          end_date_local: isoDateTime("End date/time for a ranged event").optional(),
          moving_time: z
            .number()
            .positive()
            .optional()
            .describe("Planned duration in seconds"),
          distance: z
            .number()
            .positive()
            .optional()
            .describe("Planned distance in meters"),
          indoor: z.boolean().optional().describe("Planned as an indoor session"),
          target: z
            .enum(["AUTO", "POWER", "HR", "PACE"])
            .optional()
            .describe("Metric the targets use"),
        })
      ),
      annotations: UPDATE,
    },
    async ({ event_id, ...fields }) => {
      if (DELETE_MODE === "safe" && fields.start_date_local !== undefined) {
        // Otherwise a past event could be moved to the future and then
        // deleted, which is exactly what safe mode exists to prevent.
        const date = await storedEventDate(event_id);
        const today = localToday(config.timeZone);
        if (date < today && fields.start_date_local.slice(0, 10) >= today) {
          throw new Error(
            `Refusing to move event ${event_id} from ${date} to ` +
              `${fields.start_date_local.slice(0, 10)}: in delete mode "safe" a ` +
              `past event cannot be rescheduled to today or later, since that ` +
              `would make it deletable. Move it to another past date instead.`
          );
        }
      }
      return json(
        await client.put(
          `/athlete/${client.athleteId}/events/${segment(event_id)}`,
          compactBody(fields)
        )
      );
    }
  );

  server.registerTool(
    "duplicate_events",
    {
      title: "Duplicate calendar events",
      description:
        "Copy calendar events forward by whole weeks, keeping weekday and " +
        "time, e.g. repeat this week's key sessions for four weeks.",
      inputSchema: schema("duplicate_events", () =>
        z.object({
          event_ids: z
            .array(z.number().int())
            .min(1)
            .describe("IDs of the events to copy"),
          num_copies: z
            .number()
            .int()
            .min(1)
            .max(52)
            .optional()
            .describe("How many copies of each event (default 1)"),
          weeks_between: z
            .number()
            .int()
            .min(1)
            .max(52)
            .optional()
            .describe("Weeks between one copy and the next (default 1)"),
        })
      ),
      annotations: CREATE,
    },
    async ({ event_ids, num_copies = 1, weeks_between = 1 }) => {
      const created = await client.post(
        `/athlete/${client.athleteId}/duplicate-events`,
        { eventIds: event_ids, numCopies: num_copies, weeksBetween: weeks_between }
      );
      return json(project(created, EVENT_SUMMARY_FIELDS, false));
    }
  );

  server.registerTool(
    "apply_plan",
    {
      title: "Apply training plan",
      description:
        "Put every workout in a plan (a PLAN folder) onto the calendar: day 0 " +
        "lands on start_date, day 3 three days later. Can add dozens of " +
        "events, so confirm the plan and date with the user first.",
      inputSchema: schema("apply_plan", () =>
        z.object({
          folder_id: z.number().int().describe("ID of the plan (a PLAN folder)"),
          start_date: isoDate("Date that plan day 0 lands on, YYYY-MM-DD"),
        })
      ),
      annotations: CREATE,
    },
    async ({ folder_id, start_date }) =>
      json(
        await client.post(`/athlete/${client.athleteId}/events/apply-plan`, {
          folder_id,
          start_date_local: `${start_date}T00:00:00`,
        })
      )
  );

  if (DELETE_MODE !== "none") {
    server.registerTool(
      "delete_event",
      {
        title: "Delete calendar event",
        description:
          "Delete one calendar event by ID." +
          (DELETE_MODE === "safe"
            ? " Events dated before today are refused (delete mode `safe`)."
            : " Past events can be deleted too (delete mode `full`)."),
        inputSchema: schema("delete_event", () =>
          z.object({
            event_id: z.number().int().describe("The event ID"),
          })
        ),
        annotations: DELETE,
      },
      async ({ event_id }) => {
        if (DELETE_MODE === "safe") {
          // Read before deleting, so "is this in the past" is answered by the
          // calendar rather than by whatever the caller believes.
          const date = await storedEventDate(event_id);
          const today = localToday(config.timeZone);
          if (date < today) {
            throw new Error(
              `Refusing to delete event ${event_id}: it is dated ${date}, before ` +
                `today (${today}), and the delete mode is "safe". Set ` +
                `INTERVALS_DELETE_MODE=full, or on a hosted server sign in ` +
                `again with delete mode "full", to allow deleting past events.`
            );
          }
        }
        return json(
          await client.delete(`/athlete/${client.athleteId}/events/${segment(event_id)}`)
        );
      }
    );
  }

  // ── Workouts Library ───────────────────────────────────────────────────────

  server.registerTool(
    "list_workouts",
    {
      title: "List workouts",
      description: "List all workouts in the athlete's workout library.",
      inputSchema: schema("list_workouts", () =>
        z.object({ fields: fieldsParam(WORKOUT_SUMMARY_FIELDS, 28) })
      ),
      annotations: READ_ONLY,
    },
    async ({ fields }) =>
      json(
        projectFields(
          await client.get(`/athlete/${client.athleteId}/workouts`),
          fields,
          WORKOUT_SUMMARY_FIELDS
        )
      )
  );

  server.registerTool(
    "get_workout",
    {
      title: "Get workout",
      description:
        "Get one library workout by ID. Name workout_doc in fields for the " +
        "parsed steps.",
      inputSchema: schema("get_workout", () =>
        z.object({
          workout_id: numericId("The workout ID"),
          fields: fieldsParam(WORKOUT_SUMMARY_FIELDS, 28),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ workout_id, fields }) =>
      json(
        projectFields(
          await client.get(
            `/athlete/${client.athleteId}/workouts/${segment(workout_id)}`
          ),
          fields,
          WORKOUT_SUMMARY_FIELDS
        )
      )
  );

  server.registerTool(
    "create_workout",
    {
      title: "Create library workout",
      description:
        "Save a reusable workout into a library folder or plan. Steps go in " +
        "`description` as workout syntax (see " +
        "intervals-icu://workout-syntax).",
      inputSchema: schema("create_workout", () =>
        z.object({
          folder_id: z
            .number()
            .int()
            .describe("Folder or plan ID, from list_folders"),
          name: z.string().describe("Workout name"),
          description: z
            .string()
            .optional()
            .describe(
              "Workout syntax for the steps"
            ),
          type: z
            .string()
            .optional()
            .describe(
              "Sport type, e.g. Ride, Run, Swim"
            ),
          moving_time: z
            .number()
            .positive()
            .optional()
            .describe(
              "Duration in seconds, if the steps don't set it"
            ),
          distance: z.number().positive().optional().describe("Distance in meters"),
          indoor: z.boolean().optional().describe("An indoor session"),
          target: z
            .enum(["AUTO", "POWER", "HR", "PACE"])
            .optional()
            .describe("Metric the targets use"),
          day: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "Plan day from 0 (day 0 = apply_plan's start_date)"
            ),
        })
      ),
      annotations: CREATE,
    },
    async (fields) =>
      json(
        project(
          await client.post(
            `/athlete/${client.athleteId}/workouts`,
            compactBody(fields)
          ),
          WORKOUT_SUMMARY_FIELDS,
          false
        )
      )
  );

  server.registerTool(
    "update_workout",
    {
      title: "Update library workout",
      description:
        "Change a library workout. Only supply what should change; a new " +
        "`description` replaces all the steps.",
      inputSchema: schema("update_workout", () =>
        z.object({
          workout_id: numericId("The workout ID"),
          name: z.string().optional().describe("Workout name"),
          description: z
            .string()
            .optional()
            .describe(
              "Workout syntax for the steps"
            ),
          type: z.string().optional().describe("Sport type e.g. Ride, Run, Swim"),
          folder_id: z
            .number()
            .int()
            .optional()
            .describe("Move the workout to this folder or plan"),
          moving_time: z
            .number()
            .positive()
            .optional()
            .describe("Duration in seconds"),
          distance: z.number().positive().optional().describe("Distance in meters"),
          indoor: z.boolean().optional().describe("An indoor session"),
          target: z
            .enum(["AUTO", "POWER", "HR", "PACE"])
            .optional()
            .describe("Metric the targets use"),
          day: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "Plan day from 0 (day 0 = apply_plan's start_date)"
            ),
        })
      ),
      annotations: UPDATE,
    },
    async ({ workout_id, ...fields }) =>
      json(
        project(
          await client.put(
            `/athlete/${client.athleteId}/workouts/${segment(workout_id)}`,
            compactBody(fields)
          ),
          WORKOUT_SUMMARY_FIELDS,
          false
        )
      )
  );

  if (DELETE_MODE !== "none") {
    server.registerTool(
      "delete_workout",
      {
        title: "Delete library workout",
        description:
          "Delete a library workout by ID. Calendar events made from it are " +
          "kept.",
        inputSchema: schema("delete_workout", () =>
          z.object({
            workout_id: numericId("The workout ID"),
          })
        ),
        annotations: DELETE,
      },
      async ({ workout_id }) =>
        json(
          await client.delete(
            `/athlete/${client.athleteId}/workouts/${segment(workout_id)}`
          )
        )
    );
  }

  server.registerTool(
    "list_folders",
    {
      title: "List workout folders and plans",
      description:
        "List library folders and training plans (`type` FOLDER or PLAN).",
      inputSchema: schema("list_folders", () =>
        z.object({
          fields: fieldsParam(FOLDER_SUMMARY_FIELDS, 24),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ fields }) => {
      const data = await client.get(`/athlete/${client.athleteId}/folders`);
      return json(projectFields(data, fields, FOLDER_SUMMARY_FIELDS));
    }
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create workout folder or plan",
      description:
        "Create a library folder, or a PLAN: a folder whose workouts are laid " +
        "out by day and applied to the calendar with apply_plan.",
      inputSchema: schema("create_folder", () =>
        z.object({
          name: z.string().describe("Folder or plan name"),
          type: z
            .enum(["FOLDER", "PLAN"])
            .optional()
            .describe("FOLDER (default) or PLAN"),
          description: z.string().optional().describe("Folder description"),
        })
      ),
      annotations: CREATE,
    },
    async (fields) =>
      json(
        await client.post(
          `/athlete/${client.athleteId}/folders`,
          compactBody(fields)
        )
      )
  );

  // ── Gear ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_gear",
    {
      title: "List gear",
      description: "List all gear (bikes, shoes, etc.) for the athlete.",
      inputSchema: schema("list_gear", () => z.object({})),
      annotations: READ_ONLY,
    },
    async () => json(await client.get(`/athlete/${client.athleteId}/gear`))
  );

  server.registerTool(
    "create_gear",
    {
      title: "Create gear",
      description:
        "Add a bike, shoes or a component to the athlete's gear.",
      inputSchema: schema("create_gear", () =>
        z.object({
          name: z.string().min(1).describe("Gear name, e.g. Tarmac SL7"),
          type: z
            .enum(GEAR_TYPES)
            .describe("Gear type, e.g. Bike, Shoes, Chain, Cassette, Tyre"),
        })
      ),
      annotations: CREATE,
    },
    async (fields) =>
      json(await client.post(`/athlete/${client.athleteId}/gear`, fields))
  );

  server.registerTool(
    "update_gear",
    {
      title: "Update gear",
      description:
        "Rename gear, change its type, or retire / un-retire it. Only supply " +
        "what should change.",
      inputSchema: schema("update_gear", () =>
        z.object({
          gear_id: gearId(),
          name: z.string().min(1).optional().describe("New name"),
          type: z.enum(GEAR_TYPES).optional().describe("New gear type"),
          retired: z
            .boolean()
            .optional()
            .describe("true retires it as of today, false un-retires it"),
        })
      ),
      annotations: UPDATE,
    },
    async ({ gear_id, retired, ...rest }) => {
      const body: Record<string, unknown> = compactBody(rest);
      // The API ignores a null `retired`; an empty string is what clears it.
      if (retired !== undefined) {
        body.retired = retired ? localToday(config.timeZone) : "";
      }
      if (Object.keys(body).length === 0) {
        throw new Error("Nothing to change: supply name, type or retired.");
      }
      return json(
        await client.put(`/athlete/${client.athleteId}/gear/${segment(gear_id)}`, body)
      );
    }
  );

  /** A reminder's thresholds, in the units people use; the API wants metres
   *  and seconds. */
  const reminderBody = (fields: {
    name?: string;
    every_km?: number;
    every_hours?: number;
  }) =>
    compactBody({
      name: fields.name,
      distance:
        fields.every_km === undefined ? undefined : Math.round(fields.every_km * 1000),
      time:
        fields.every_hours === undefined
          ? undefined
          : Math.round(fields.every_hours * 3600),
    });

  server.registerTool(
    "set_gear_reminder",
    {
      title: "Add or change a gear reminder",
      description:
        "Add a maintenance reminder to gear, e.g. \"Replace chain\" every 3000 " +
        "km or \"Service fork\" every 50 hours. With reminder_id (from " +
        "list_gear), change that reminder instead, or reset it once the " +
        "maintenance is done; only supply what should change.",
      inputSchema: schema("set_gear_reminder", () =>
        z.object({
          gear_id: gearId(),
          reminder_id: z
            .number()
            .int()
            .optional()
            .describe("The reminder to change; omit to add a new one"),
          name: z
            .string()
            .min(1)
            .optional()
            .describe("What to do, e.g. Replace chain (needed for a new one)"),
          every_km: z.number().positive().optional().describe("Due every N km"),
          every_hours: z
            .number()
            .positive()
            .optional()
            .describe("Due every N hours of use"),
          reset: z
            .boolean()
            .optional()
            .describe("Maintenance done: restart the count from now"),
        })
      ),
      // Adds a record without reminder_id and overwrites one with it, so it
      // is neither idempotent nor safe from overwriting.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ gear_id, reminder_id, reset, ...fields }) => {
      const body = reminderBody(fields);
      const gearPath = `/athlete/${client.athleteId}/gear/${segment(gear_id)}/reminder`;

      if (reminder_id === undefined) {
        if (reset !== undefined) {
          throw new Error("reset needs the reminder_id of an existing reminder.");
        }
        if (fields.name === undefined) {
          throw new Error("A new reminder needs a name.");
        }
        if (fields.every_km === undefined && fields.every_hours === undefined) {
          throw new Error("Give the reminder every_km, every_hours, or both.");
        }
        return json(await client.post(gearPath, body));
      }

      if (Object.keys(body).length === 0 && !reset) {
        throw new Error(
          "Nothing to change: supply name, every_km, every_hours or reset."
        );
      }
      // The spec makes `reset` and `snoozeDays` required on this PUT, so an
      // ordinary edit says explicitly that it does neither.
      return json(
        await client.request(
          "PUT",
          `${gearPath}/${segment(reminder_id)}`,
          { reset: String(reset ?? false), snoozeDays: "0" },
          body
        )
      );
    }
  );

  // ── Routes ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_routes",
    {
      title: "List routes",
      description: "List saved routes for the athlete.",
      inputSchema: schema("list_routes", () => z.object({})),
      annotations: READ_ONLY,
    },
    async () => json(await client.get(`/athlete/${client.athleteId}/routes`))
  );

  server.registerTool(
    "get_route",
    {
      title: "Get route",
      description: "Get a specific route by ID.",
      inputSchema: schema("get_route", () =>
        z.object({
          route_id: numericId("The route ID"),
        })
      ),
      annotations: READ_ONLY,
    },
    async ({ route_id }) =>
      json(await client.get(`/athlete/${client.athleteId}/routes/${segment(route_id)}`))
  );

  // ── Resources ──────────────────────────────────────────────────────────────

  server.registerResource(
    "workout-syntax",
    "intervals-icu://workout-syntax",
    {
      title: "Intervals.icu workout syntax",
      description:
        "How to write structured workout steps for the `description` field of a " +
        "WORKOUT event or a library workout: sections, repeats, step lengths and " +
        "power/HR/pace targets, with the silent-failure cases called out. Read " +
        "this before writing a workout.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: WORKOUT_SYNTAX }],
    })
  );

  return server;
}
