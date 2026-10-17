#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { IntervalsClient } from "./api.js";
import {
  ACTIVITY_SUMMARY_FIELDS,
  ATHLETE_SUMMARY_FIELDS,
  DEFAULT_STREAM_POINTS,
  EVENT_CATEGORIES,
  EVENT_CATEGORY_HELP,
  EVENT_SUMMARY_FIELDS,
  FITNESS_FIELDS,
  FOLDER_SUMMARY_FIELDS,
  HR_CURVE_SUMMARY_FIELDS,
  INTERVAL_SUMMARY_FIELDS,
  PACE_CURVE_SUMMARY_FIELDS,
  POWER_CURVE_SUMMARY_FIELDS,
  REDACTED_ATHLETE_FIELDS,
  WELLNESS_SUMMARY_FIELDS,
  compactBody,
  downsampleStreams,
  fieldsParam,
  fitnessSeries,
  isoDate,
  isoDateTime,
  project,
  projectFields,
  projectNested,
  projectNestedFields,
  redact,
  score,
} from "./transform.js";
import { WORKOUT_SYNTAX } from "./workout-syntax.js";

const API_KEY = process.env.INTERVALS_API_KEY;
const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID;

if (!API_KEY || !ATHLETE_ID) {
  console.error(
    "Missing required environment variables: INTERVALS_API_KEY, INTERVALS_ATHLETE_ID"
  );
  process.exit(1);
}

const client = new IntervalsClient(API_KEY, ATHLETE_ID);
const server = new McpServer({
  name: "intervals-icu",
  version: "1.0.0",
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wrap a payload as a tool result. Deliberately not pretty-printed: the
 *  indentation roughly doubles the token cost and nothing downstream reads it. */
function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
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
const DELETE_MODES = ["safe", "full", "none"] as const;
type DeleteMode = (typeof DELETE_MODES)[number];

const requestedDeleteMode = (
  process.env.INTERVALS_DELETE_MODE ?? "safe"
).toLowerCase();

if (!DELETE_MODES.includes(requestedDeleteMode as DeleteMode)) {
  console.error(
    `Invalid INTERVALS_DELETE_MODE: ${requestedDeleteMode}. ` +
      `Valid values are: ${DELETE_MODES.join(", ")}`
  );
  process.exit(1);
}

const DELETE_MODE = requestedDeleteMode as DeleteMode;

/** Today as YYYY-MM-DD in the host's local timezone, which is the athlete's
 *  own day whenever the server runs on their machine - the stdio case. Read
 *  per call rather than once at startup, so a long-running server does not
 *  keep yesterday's idea of "past". */
function localToday(): string {
  return new Date().toLocaleDateString("en-CA");
}

// ── Athlete ───────────────────────────────────────────────────────────────────

server.registerTool(
  "get_athlete",
  {
    title: "Get athlete",
    description:
      "Get the athlete profile: identity, physiology and account info. Returns a " +
      'compact subset by default - pass fields ["sportSettings"] for per-sport ' +
      'FTP, thresholds and zones (~10 KB), or ["*"] for everything including ' +
      "per-vendor sync configuration. Credential fields are always withheld, " +
      "and email and date of birth are available only on explicit request.",
    inputSchema: z.object({
      fields: fieldsParam(ATHLETE_SUMMARY_FIELDS, 162),
    }),
    annotations: READ_ONLY,
  },
  async ({ fields }) => {
    const data = redact(
      await client.get(`/athlete/${client.athleteId}`),
      REDACTED_ATHLETE_FIELDS
    );
    return json(projectFields(data, fields, ATHLETE_SUMMARY_FIELDS));
  }
);

server.registerTool(
  "get_athlete_profile",
  {
    title: "Get athlete public profile",
    description:
      "Get public profile info for the athlete (name, bio, location, etc.).",
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  },
  async () =>
    json(
      redact(
        await client.get(`/athlete/${client.athleteId}/profile`),
        REDACTED_ATHLETE_FIELDS
      )
    )
);

// ── Activities ────────────────────────────────────────────────────────────────

server.registerTool(
  "list_activities",
  {
    title: "List activities",
    description:
      "List activities for a date range. Returns a compact summary of each activity " +
      "by default; use `fields` to choose exactly what you need.",
    inputSchema: z.object({
      oldest: isoDate("Start date in YYYY-MM-DD format (inclusive)"),
      newest: isoDate("End date in YYYY-MM-DD format (inclusive)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of activities to return"),
      fields: fieldsParam(ACTIVITY_SUMMARY_FIELDS, 184),
    }),
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
      "Get detailed information about a specific activity by its ID. Returns a " +
      "compact summary by default; pass `fields` for other metrics.",
    inputSchema: z.object({
      activity_id: z.string().describe("The activity ID"),
      fields: fieldsParam(ACTIVITY_SUMMARY_FIELDS, 184),
    }),
    annotations: READ_ONLY,
  },
  async ({ activity_id, fields }) => {
    const data = await client.get(`/activity/${activity_id}`);
    return json(projectFields(data, fields, ACTIVITY_SUMMARY_FIELDS));
  }
);

server.registerTool(
  "search_activities",
  {
    title: "Search activities",
    description: "Search for activities by name or tag.",
    inputSchema: z.object({
      query: z.string().describe("Search query (name or tag)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum number of results (the API returns 30 by default)"),
    }),
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
      "Get the lap/interval breakdown for an activity. Each lap carries 84 fields, " +
      "so a compact subset is returned by default; `fields` applies to the " +
      "individual laps inside `icu_intervals` and `icu_groups`.",
    inputSchema: z.object({
      activity_id: z.string().describe("The activity ID"),
      fields: fieldsParam(INTERVAL_SUMMARY_FIELDS, 84),
    }),
    annotations: READ_ONLY,
  },
  async ({ activity_id, fields }) => {
    const data = await client.get(`/activity/${activity_id}/intervals`);
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
  "get_activity_streams",
  {
    title: "Get activity streams",
    description:
      "Get time-series data streams for an activity (power, HR, cadence, speed, altitude, GPS, etc.). " +
      "Streams are large, so each channel is downsampled to " +
      `${DEFAULT_STREAM_POINTS} evenly spaced points by default. ` +
      "Pass types to fetch only the channels you need, and raise max_points only when you " +
      "genuinely need finer resolution.",
    inputSchema: z.object({
      activity_id: z.string().describe("The activity ID"),
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
    }),
    annotations: READ_ONLY,
  },
  async ({ activity_id, types, max_points }) => {
    const params: Record<string, string> = {};
    if (types && types.length > 0) params.types = types.join(",");
    const data = await client.get(`/activity/${activity_id}/streams`, params);
    return json(downsampleStreams(data, max_points ?? DEFAULT_STREAM_POINTS));
  }
);

server.registerTool(
  "get_activity_power_curve",
  {
    title: "Get activity power curve",
    description: "Get the mean maximal power curve for a specific activity.",
    inputSchema: z.object({
      activity_id: z.string().describe("The activity ID"),
    }),
    annotations: READ_ONLY,
  },
  async ({ activity_id }) =>
    json(await client.get(`/activity/${activity_id}/power-curve`))
);

server.registerTool(
  "get_activity_best_efforts",
  {
    title: "Get activity best efforts",
    description:
      "Find best efforts within an activity - e.g. peak 5-min power, fastest 1km. " +
      "Requires a stream to measure and exactly one of duration or distance.",
    inputSchema: z.object({
      activity_id: z.string().describe("The activity ID"),
      stream: z
        .string()
        .describe(
          "Stream to measure, which must exist on the activity - see its " +
            '`stream_types`. e.g. watts, heartrate, velocity_smooth, distance. ' +
            'Note "pace" is NOT valid; use velocity_smooth.'
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
    }),
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
      await client.get(`/activity/${activity_id}/best-efforts`, params)
    );
  }
);

server.registerTool(
  "get_activity_weather",
  {
    title: "Get activity weather",
    description: "Get the weather summary for an activity.",
    inputSchema: z.object({
      activity_id: z.string().describe("The activity ID"),
    }),
    annotations: READ_ONLY,
  },
  async ({ activity_id }) =>
    json(await client.get(`/activity/${activity_id}/weather-summary`))
);

server.registerTool(
  "update_activity",
  {
    title: "Update activity",
    description:
      "Change the editable fields on a completed activity: its name, description, " +
      "sport type, tags and the subjective scores. Only supply what should change - " +
      "omitted fields are left alone. Recorded data (power, HR, GPS) is not " +
      "editable here.",
    inputSchema: z.object({
      activity_id: z.string().describe("The activity ID"),
      name: z.string().optional().describe("Activity title"),
      description: z.string().optional().describe("Activity notes"),
      type: z
        .string()
        .optional()
        .describe(
          "Sport type, which the API validates strictly e.g. Ride, VirtualRide, " +
            "GravelRide, Run, TrailRun, Swim, WeightTraining"
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
        .describe("Replaces the full tag list - include tags to keep"),
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
    }),
    annotations: UPDATE,
  },
  async ({ activity_id, ...fields }) =>
    json(await client.put(`/activity/${activity_id}`, compactBody(fields)))
);

// ── Power & Performance ───────────────────────────────────────────────────────

/** Power, HR and pace curves are one endpoint family: same request shape, same
 *  wrapper back - a `list` of curves plus an `activities` lookup map roughly as
 *  large as the curves themselves. Only the path, the summary set and pace's
 *  grade-adjustment flag differ, so all three tools register through here. */
function registerCurveTool({
  name,
  title,
  description,
  path,
  summary,
  total,
  extra,
}: {
  name: string;
  title: string;
  description: string;
  path: string;
  summary: string[];
  /** Field count of the untrimmed record, for the `fields` description. */
  total: number;
  /** Query parameters only this endpoint takes, slotted in before `fields`. */
  extra?: z.ZodRawShape;
}) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: z.object({
        type: z
          .string()
          .describe(
            "Sport type - REQUIRED, and exactly one (the API rejects a comma-separated " +
              "list). e.g. Ride, VirtualRide, GravelRide, Run, VirtualRun, Swim"
          ),
        oldest: isoDate("Start date YYYY-MM-DD").optional(),
        newest: isoDate("End date YYYY-MM-DD").optional(),
        curves: z
          .string()
          .optional()
          .describe(
            'Which curves to return, e.g. "42d" or "all". Invalid values are ' +
              "rejected by the API with the list of valid ones."
          ),
        ...extra,
        fields: fieldsParam(summary, total),
      }),
      annotations: READ_ONLY,
    },
    async ({ fields, ...rest }) => {
      // Everything that is not `fields` is a query parameter; a boolean goes
      // over the wire as "true"/"false".
      const params: Record<string, string> = Object.fromEntries(
        Object.entries(compactBody(rest)).map(([k, v]) => [k, String(v)])
      );
      const data = await client.get(
        `/athlete/${client.athleteId}${path}`,
        params
      );
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
}

registerCurveTool({
  name: "get_power_curves",
  title: "Get power curves",
  description:
    "Get the athlete's best mean maximal power curves across activities of one " +
    "sport. `secs` and `values` on each curve are the curve itself. The bulk " +
    "`activities` lookup map is omitted unless you pass fields [\"*\"].",
  path: "/power-curves",
  summary: POWER_CURVE_SUMMARY_FIELDS,
  total: 20,
});

registerCurveTool({
  name: "get_hr_curves",
  title: "Get HR curves",
  description:
    "Get the athlete's best mean maximal heart rate curves across activities of " +
    "one sport - the highest average HR held for each duration. `secs` and " +
    "`values` on each curve are the curve itself. The bulk `activities` lookup " +
    "map is omitted unless you pass fields [\"*\"].",
  path: "/hr-curves",
  summary: HR_CURVE_SUMMARY_FIELDS,
  total: 18,
});

registerCurveTool({
  name: "get_pace_curves",
  title: "Get pace curves",
  description:
    "Get the athlete's best pace curves across activities of one sport. Unlike " +
    "the power and HR curves these are indexed by distance, not duration: " +
    "`distance` (metres) against `values` (seconds taken) is the curve itself. " +
    "Pass gap: true for grade adjusted pace. The bulk `activities` lookup map " +
    "is omitted unless you pass fields [\"*\"].",
  path: "/pace-curves",
  summary: PACE_CURVE_SUMMARY_FIELDS,
  total: 20,
  extra: {
    gap: z
      .boolean()
      .optional()
      .describe(
        "Return grade adjusted pace (GAP) curves, which correct for climbing " +
          'and descending. Each curve\'s `type` reports which it is - "PACE" ' +
          'or "GAP" - so the answer says so rather than having to be trusted.'
      ),
  },
});

// ── Wellness ──────────────────────────────────────────────────────────────────

server.registerTool(
  "list_wellness",
  {
    title: "List wellness records",
    description:
      "List wellness records for a date range: fitness model (CTL/ATL), HRV, " +
      "resting HR, sleep, weight, mood and the other subjective scores.",
    inputSchema: z.object({
      oldest: isoDate("Start date YYYY-MM-DD"),
      newest: isoDate("End date YYYY-MM-DD"),
      fields: fieldsParam(WELLNESS_SUMMARY_FIELDS, 47),
    }),
    annotations: READ_ONLY,
  },
  async ({ oldest, newest, fields }) => {
    const data = await client.get(`/athlete/${client.athleteId}/wellness`, {
      oldest,
      newest,
    });
    return json(projectFields(data, fields, WELLNESS_SUMMARY_FIELDS));
  }
);

server.registerTool(
  "get_wellness",
  {
    title: "Get wellness record",
    description: "Get the wellness record for a specific date.",
    inputSchema: z.object({
      date: isoDate("Date in YYYY-MM-DD format"),
    }),
    annotations: READ_ONLY,
  },
  async ({ date }) =>
    json(await client.get(`/athlete/${client.athleteId}/wellness/${date}`))
);

server.registerTool(
  "update_wellness",
  {
    title: "Update wellness record",
    description:
      "Update the wellness record for a specific date. Only supply the fields you want to change.",
    inputSchema: z.object({
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
    }),
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
      "The performance management chart as a daily series: CTL (fitness), ATL " +
      "(fatigue) and form, which is CTL - ATL and is also called TSB. Use it for " +
      "fitness trend, freshness and taper questions. Days with no fitness data " +
      "are omitted rather than zero-filled. A `newest` in the future returns the " +
      "projection from planned calendar workouts, with each such point flagged " +
      "`projected: true` - those are a plan, not a measurement, and appear only " +
      "if the athlete has 'include planned workouts in fitness' enabled on " +
      "Intervals.icu.",
    inputSchema: z.object({
      oldest: isoDate("Start date YYYY-MM-DD (inclusive)"),
      newest: isoDate(
        "End date YYYY-MM-DD (inclusive). A future date returns projections."
      ),
    }),
    annotations: READ_ONLY,
  },
  async ({ oldest, newest }) => {
    const data = await client.get(`/athlete/${client.athleteId}/wellness`, {
      oldest,
      newest,
    });
    return json(
      fitnessSeries(project(data, FITNESS_FIELDS, false), localToday())
    );
  }
);

// ── Calendar Events ───────────────────────────────────────────────────────────

server.registerTool(
  "list_events",
  {
    title: "List calendar events",
    description:
      "List events on the athlete's training calendar for a date range. Returns a " +
      "compact summary of each event by default, omitting the structured-workout " +
      "document; pass `fields` to change that.",
    inputSchema: z.object({
      oldest: isoDate("Start date YYYY-MM-DD"),
      newest: isoDate("End date YYYY-MM-DD"),
      fields: fieldsParam(EVENT_SUMMARY_FIELDS, 62),
    }),
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
      "Get a specific calendar event by ID. Returns a compact summary by default - " +
      'pass fields ["*"] (or name workout_doc) to get the structured workout.',
    inputSchema: z.object({
      event_id: z.string().describe("The event ID"),
      fields: fieldsParam(EVENT_SUMMARY_FIELDS, 62),
    }),
    annotations: READ_ONLY,
  },
  async ({ event_id, fields }) => {
    const data = await client.get(
      `/athlete/${client.athleteId}/events/${event_id}`
    );
    return json(projectFields(data, fields, EVENT_SUMMARY_FIELDS));
  }
);

server.registerTool(
  "create_event",
  {
    title: "Create calendar event",
    description:
      "Create an event on the athlete's training calendar: a planned workout, a " +
      "race, a note, time off. For a structured workout, pass category WORKOUT " +
      "and put Intervals.icu workout syntax in `description` - Intervals.icu " +
      "parses it into steps with training load and zone targets. The syntax is " +
      "the `intervals-icu://workout-syntax` resource; a description it cannot " +
      "parse is silently kept as plain text with no load. " +
      EVENT_CATEGORY_HELP,
    inputSchema: z.object({
      start_date_local: isoDateTime(
        "Start date/time in ISO 8601 format e.g. 2024-06-01T08:00:00"
      ),
      category: z.enum(EVENT_CATEGORIES).describe("Event category"),
      name: z.string().optional().describe("Event name/title"),
      description: z
        .string()
        .optional()
        .describe(
          "Event notes, or workout syntax for a structured WORKOUT - see the " +
            "intervals-icu://workout-syntax resource"
        ),
      type: z
        .string()
        .optional()
        .describe(
          "Sport type, validated strictly by the API e.g. Ride, VirtualRide, " +
            "Run, Swim, WeightTraining. Required for the RACE categories and " +
            "for SET_EFTP, which sets the eFTP of one sport."
        ),
      end_date_local: isoDateTime(
        "End date/time for a ranged event - PLAN, HOLIDAY, SICK, INJURED"
      ).optional(),
      moving_time: z
        .number()
        .positive()
        .optional()
        .describe(
          "Planned duration in seconds. Omit for a workout whose steps already " +
            "set the duration."
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
        .describe("Which metric the workout's targets are expressed against"),
    }),
    annotations: CREATE,
  },
  async (fields) =>
    json(
      await client.post(
        `/athlete/${client.athleteId}/events`,
        compactBody(fields)
      )
    )
);

server.registerTool(
  "update_event",
  {
    title: "Update calendar event",
    description:
      "Change an existing calendar event. Only supply what should change - " +
      "omitted fields are left alone. Rewriting `description` on a WORKOUT " +
      "replaces its steps, so send the whole workout, not a fragment. " +
      "`category` is one-way for some kinds: once an event is TARGET or PLAN " +
      "the API refuses to change it again (422), so delete and recreate " +
      "instead. " +
      EVENT_CATEGORY_HELP,
    inputSchema: z.object({
      event_id: z.number().int().describe("The event ID"),
      name: z.string().optional().describe("Event name/title"),
      description: z
        .string()
        .optional()
        .describe(
          "Event notes, or workout syntax for a structured WORKOUT - see the " +
            "intervals-icu://workout-syntax resource"
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
        .describe("Which metric the workout's targets are expressed against"),
    }),
    annotations: UPDATE,
  },
  async ({ event_id, ...fields }) =>
    json(
      await client.put(
        `/athlete/${client.athleteId}/events/${event_id}`,
        compactBody(fields)
      )
    )
);

if (DELETE_MODE !== "none") {
  server.registerTool(
    "delete_event",
    {
      title: "Delete calendar event",
      description:
        "Delete one event from the training calendar, by ID. Deletes only the " +
        "event given: other events created in the same batch are left alone." +
        (DELETE_MODE === "safe"
          ? " This server runs in delete mode `safe`, so an event dated before " +
            "today is refused - planning mistakes are removable, training " +
            "history is not."
          : " This server runs in delete mode `full`, so past events can be " +
            "deleted too."),
      inputSchema: z.object({
        event_id: z.number().int().describe("The event ID"),
      }),
      annotations: DELETE,
    },
    async ({ event_id }) => {
      if (DELETE_MODE === "safe") {
        // Read before deleting, so "is this in the past" is answered by the
        // calendar rather than by whatever the caller believes.
        const existing = await client.get<{ start_date_local?: string }>(
          `/athlete/${client.athleteId}/events/${event_id}`
        );
        const date = existing?.start_date_local?.slice(0, 10);
        const today = localToday();
        if (date && date < today) {
          throw new Error(
            `Refusing to delete event ${event_id}: it is dated ${date}, before ` +
              `today (${today}), and INTERVALS_DELETE_MODE is "safe". Set ` +
              `INTERVALS_DELETE_MODE=full to allow deleting past events.`
          );
        }
      }
      return json(
        await client.delete(`/athlete/${client.athleteId}/events/${event_id}`)
      );
    }
  );
}

// ── Workouts Library ──────────────────────────────────────────────────────────

server.registerTool(
  "list_workouts",
  {
    title: "List workouts",
    description: "List all workouts in the athlete's workout library.",
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  },
  async () => json(await client.get(`/athlete/${client.athleteId}/workouts`))
);

server.registerTool(
  "get_workout",
  {
    title: "Get workout",
    description: "Get a specific workout from the library by ID.",
    inputSchema: z.object({
      workout_id: z.string().describe("The workout ID"),
    }),
    annotations: READ_ONLY,
  },
  async ({ workout_id }) =>
    json(await client.get(`/athlete/${client.athleteId}/workouts/${workout_id}`))
);

server.registerTool(
  "create_workout",
  {
    title: "Create library workout",
    description:
      "Save a reusable workout into a folder or training plan in the athlete's " +
      "library. Put Intervals.icu workout syntax in `description` to give it " +
      "steps - see the `intervals-icu://workout-syntax` resource. Needs a " +
      "folder: call list_folders, or create_folder first.",
    inputSchema: z.object({
      folder_id: z
        .number()
        .int()
        .describe("ID of the folder or plan to save into - see list_folders"),
      name: z.string().describe("Workout name"),
      description: z
        .string()
        .optional()
        .describe(
          "Workout syntax defining the steps - see the " +
            "intervals-icu://workout-syntax resource"
        ),
      type: z
        .string()
        .optional()
        .describe(
          "Sport type, validated strictly by the API e.g. Ride, VirtualRide, " +
            "Run, Swim, WeightTraining"
        ),
      moving_time: z
        .number()
        .positive()
        .optional()
        .describe(
          "Duration in seconds. Omit when the steps already set the duration."
        ),
      distance: z.number().positive().optional().describe("Distance in meters"),
      indoor: z.boolean().optional().describe("An indoor session"),
      target: z
        .enum(["AUTO", "POWER", "HR", "PACE"])
        .optional()
        .describe("Which metric the targets are expressed against"),
      day: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Day within a training plan, 1-based (plans only)"),
    }),
    annotations: CREATE,
  },
  async (fields) =>
    json(
      await client.post(
        `/athlete/${client.athleteId}/workouts`,
        compactBody(fields)
      )
    )
);

server.registerTool(
  "update_workout",
  {
    title: "Update library workout",
    description:
      "Change a workout in the library. Only supply what should change. " +
      "Rewriting `description` replaces the workout's steps, so send the whole " +
      "workout rather than a fragment.",
    inputSchema: z.object({
      workout_id: z.string().describe("The workout ID"),
      name: z.string().optional().describe("Workout name"),
      description: z
        .string()
        .optional()
        .describe(
          "Workout syntax defining the steps - see the " +
            "intervals-icu://workout-syntax resource"
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
        .describe("Which metric the targets are expressed against"),
      day: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Day within a training plan, 1-based (plans only)"),
    }),
    annotations: UPDATE,
  },
  async ({ workout_id, ...fields }) =>
    json(
      await client.put(
        `/athlete/${client.athleteId}/workouts/${workout_id}`,
        compactBody(fields)
      )
    )
);

if (DELETE_MODE !== "none") {
  server.registerTool(
    "delete_workout",
    {
      title: "Delete library workout",
      description:
        "Delete a workout from the athlete's library by ID. This removes the " +
        "template only - calendar events already created from it are not " +
        "touched. A workout template carries no training history, so this is " +
        "allowed in both `safe` and `full` delete modes.",
      inputSchema: z.object({
        workout_id: z.string().describe("The workout ID"),
      }),
      annotations: DELETE,
    },
    async ({ workout_id }) =>
      json(
        await client.delete(
          `/athlete/${client.athleteId}/workouts/${workout_id}`
        )
      )
  );
}

server.registerTool(
  "list_folders",
  {
    title: "List workout folders and plans",
    description:
      "List the folders and training plans in the athlete's workout library. " +
      "`type` distinguishes a plain FOLDER from a PLAN. Use this to find the " +
      "folder_id that create_workout needs.",
    inputSchema: z.object({
      fields: fieldsParam(FOLDER_SUMMARY_FIELDS, 24),
    }),
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
      "Create a folder for library workouts, or a training plan - a PLAN is a " +
      "folder whose workouts are laid out by day and can be applied to the " +
      "calendar as a block.",
    inputSchema: z.object({
      name: z.string().describe("Folder or plan name"),
      type: z
        .enum(["FOLDER", "PLAN"])
        .optional()
        .describe("FOLDER (default) or PLAN"),
      description: z.string().optional().describe("Folder description"),
    }),
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

// ── Gear ─────────────────────────────────────────────────────────────────────

server.registerTool(
  "list_gear",
  {
    title: "List gear",
    description: "List all gear (bikes, shoes, etc.) for the athlete.",
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  },
  async () => json(await client.get(`/athlete/${client.athleteId}/gear`))
);

// ── Routes ────────────────────────────────────────────────────────────────────

server.registerTool(
  "list_routes",
  {
    title: "List routes",
    description: "List saved routes for the athlete.",
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  },
  async () => json(await client.get(`/athlete/${client.athleteId}/routes`))
);

server.registerTool(
  "get_route",
  {
    title: "Get route",
    description: "Get a specific route by ID.",
    inputSchema: z.object({
      route_id: z.string().describe("The route ID"),
    }),
    annotations: READ_ONLY,
  },
  async ({ route_id }) =>
    json(await client.get(`/athlete/${client.athleteId}/routes/${route_id}`))
);

// ── Resources ─────────────────────────────────────────────────────────────────

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

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => {
    console.error("Intervals.icu MCP server running on stdio");
  })
  .catch((err) => {
    console.error("Failed to start Intervals.icu MCP server:", err);
    process.exit(1);
  });
