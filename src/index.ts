#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IntervalsClient } from "./api.js";
import {
  ACTIVITY_SUMMARY_FIELDS,
  ATHLETE_SUMMARY_FIELDS,
  DEFAULT_STREAM_POINTS,
  EVENT_SUMMARY_FIELDS,
  INTERVAL_SUMMARY_FIELDS,
  POWER_CURVE_SUMMARY_FIELDS,
  REDACTED_ATHLETE_FIELDS,
  WELLNESS_SUMMARY_FIELDS,
  downsampleStreams,
  fieldsParam,
  isoDate,
  isoDateTime,
  project,
  projectNested,
  redact,
  score,
} from "./transform.js";

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

/** Annotations for the twenty tools that only read. `openWorldHint` is true
 *  for every tool here: they all reach the Intervals.icu API, whose contents
 *  this server does not control. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

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
    inputSchema: {
      fields: fieldsParam(ATHLETE_SUMMARY_FIELDS, 162),
    },
    annotations: READ_ONLY,
  },
  async ({ fields }) => {
    const data = redact(
      await client.get(`/athlete/${client.athleteId}`),
      REDACTED_ATHLETE_FIELDS
    );
    return json(project(data, fields ?? ATHLETE_SUMMARY_FIELDS));
  }
);

server.registerTool(
  "get_athlete_profile",
  {
    title: "Get athlete public profile",
    description:
      "Get public profile info for the athlete (name, bio, location, etc.).",
    inputSchema: {},
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
    inputSchema: {
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
    },
    annotations: READ_ONLY,
  },
  async ({ oldest, newest, limit, fields }) => {
    const params: Record<string, string> = { oldest, newest };
    if (limit !== undefined) params.limit = String(limit);
    const data = await client.get(
      `/athlete/${client.athleteId}/activities`,
      params
    );
    return json(project(data, fields ?? ACTIVITY_SUMMARY_FIELDS));
  }
);

server.registerTool(
  "get_activity",
  {
    title: "Get activity",
    description:
      "Get detailed information about a specific activity by its ID. Returns a " +
      "compact summary by default; pass `fields` for other metrics.",
    inputSchema: {
      activity_id: z.string().describe("The activity ID"),
      fields: fieldsParam(ACTIVITY_SUMMARY_FIELDS, 184),
    },
    annotations: READ_ONLY,
  },
  async ({ activity_id, fields }) => {
    const data = await client.get(`/activity/${activity_id}`);
    return json(project(data, fields ?? ACTIVITY_SUMMARY_FIELDS));
  }
);

server.registerTool(
  "search_activities",
  {
    title: "Search activities",
    description: "Search for activities by name or tag.",
    inputSchema: {
      query: z.string().describe("Search query (name or tag)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum number of results (the API returns 30 by default)"),
    },
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
    inputSchema: {
      activity_id: z.string().describe("The activity ID"),
      fields: fieldsParam(INTERVAL_SUMMARY_FIELDS, 84),
    },
    annotations: READ_ONLY,
  },
  async ({ activity_id, fields }) => {
    const data = await client.get(`/activity/${activity_id}/intervals`);
    return json(
      projectNested(
        data,
        ["icu_intervals", "icu_groups"],
        fields ?? INTERVAL_SUMMARY_FIELDS
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
    inputSchema: {
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
    },
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
    inputSchema: {
      activity_id: z.string().describe("The activity ID"),
    },
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
    inputSchema: {
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
    },
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
    inputSchema: {
      activity_id: z.string().describe("The activity ID"),
    },
    annotations: READ_ONLY,
  },
  async ({ activity_id }) =>
    json(await client.get(`/activity/${activity_id}/weather-summary`))
);

// ── Power & Performance ───────────────────────────────────────────────────────

server.registerTool(
  "get_power_curves",
  {
    title: "Get power curves",
    description:
      "Get the athlete's best mean maximal power curves across activities of one " +
      "sport. `secs` and `values` on each curve are the curve itself. The bulk " +
      "`activities` lookup map is omitted unless you pass fields [\"*\"].",
    inputSchema: {
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
      fields: fieldsParam(POWER_CURVE_SUMMARY_FIELDS, 20),
    },
    annotations: READ_ONLY,
  },
  async ({ type, oldest, newest, curves, fields }) => {
    const params: Record<string, string> = { type };
    if (oldest) params.oldest = oldest;
    if (newest) params.newest = newest;
    if (curves) params.curves = curves;
    const data = await client.get(
      `/athlete/${client.athleteId}/power-curves`,
      params
    );
    if (fields?.includes("*")) return json(data);

    const trimmed = projectNested(
      data,
      ["list"],
      fields ?? POWER_CURVE_SUMMARY_FIELDS
    );
    // `activities` is a lookup map roughly as large as the curves themselves.
    if (trimmed && typeof trimmed === "object" && !Array.isArray(trimmed)) {
      const { activities, ...rest } = trimmed as Record<string, unknown>;
      return json(rest);
    }
    return json(trimmed);
  }
);

// ── Wellness ──────────────────────────────────────────────────────────────────

server.registerTool(
  "list_wellness",
  {
    title: "List wellness records",
    description:
      "List wellness records for a date range: fitness model (CTL/ATL), HRV, " +
      "resting HR, sleep, weight, mood and the other subjective scores.",
    inputSchema: {
      oldest: isoDate("Start date YYYY-MM-DD"),
      newest: isoDate("End date YYYY-MM-DD"),
      fields: fieldsParam(WELLNESS_SUMMARY_FIELDS, 47),
    },
    annotations: READ_ONLY,
  },
  async ({ oldest, newest, fields }) => {
    const data = await client.get(`/athlete/${client.athleteId}/wellness`, {
      oldest,
      newest,
    });
    return json(project(data, fields ?? WELLNESS_SUMMARY_FIELDS));
  }
);

server.registerTool(
  "get_wellness",
  {
    title: "Get wellness record",
    description: "Get the wellness record for a specific date.",
    inputSchema: {
      date: isoDate("Date in YYYY-MM-DD format"),
    },
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
    inputSchema: {
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
    },
    // Overwrites fields on the existing record for that date, so destructive;
    // the same call twice leaves the record in the same state, so idempotent.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ date, ...fields }) => {
    // Remove undefined fields
    const body = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    return json(
      await client.put(`/athlete/${client.athleteId}/wellness/${date}`, body)
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
    inputSchema: {
      oldest: isoDate("Start date YYYY-MM-DD"),
      newest: isoDate("End date YYYY-MM-DD"),
      fields: fieldsParam(EVENT_SUMMARY_FIELDS, 62),
    },
    annotations: READ_ONLY,
  },
  async ({ oldest, newest, fields }) => {
    const data = await client.get(`/athlete/${client.athleteId}/events`, {
      oldest,
      newest,
    });
    return json(project(data, fields ?? EVENT_SUMMARY_FIELDS));
  }
);

server.registerTool(
  "get_event",
  {
    title: "Get calendar event",
    description:
      "Get a specific calendar event by ID. Returns a compact summary by default - " +
      'pass fields ["*"] (or name workout_doc) to get the structured workout.',
    inputSchema: {
      event_id: z.string().describe("The event ID"),
      fields: fieldsParam(EVENT_SUMMARY_FIELDS, 62),
    },
    annotations: READ_ONLY,
  },
  async ({ event_id, fields }) => {
    const data = await client.get(
      `/athlete/${client.athleteId}/events/${event_id}`
    );
    return json(project(data, fields ?? EVENT_SUMMARY_FIELDS));
  }
);

server.registerTool(
  "create_event",
  {
    title: "Create calendar event",
    description:
      "Create an event on the athlete's training calendar (planned workout, race, note, etc.).",
    inputSchema: {
      start_date_local: isoDateTime(
        "Start date/time in ISO 8601 format e.g. 2024-06-01T08:00:00"
      ),
      category: z
        .enum([
          "WORKOUT",
          "RACE",
          "NOTE",
          "HOLIDAY",
          "TARGET",
          "SICK",
          "TRAVEL",
          "STRENGTH",
        ])
        .describe("Event category"),
      name: z.string().optional().describe("Event name/title"),
      description: z.string().optional().describe("Event notes or description"),
      type: z
        .string()
        .optional()
        .describe("Sport type e.g. Ride, Run, Swim, WeightTraining"),
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
    },
    // Only ever adds, so not destructive - but each call adds another entry,
    // so repeating it is not a no-op.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    start_date_local,
    category,
    name,
    description,
    type,
    moving_time,
    distance,
  }) => {
    const body: Record<string, unknown> = { start_date_local, category };
    if (name !== undefined) body.name = name;
    if (description !== undefined) body.description = description;
    if (type !== undefined) body.type = type;
    if (moving_time !== undefined) body.moving_time = moving_time;
    if (distance !== undefined) body.distance = distance;

    return json(await client.post(`/athlete/${client.athleteId}/events`, body));
  }
);

// ── Workouts Library ──────────────────────────────────────────────────────────

server.registerTool(
  "list_workouts",
  {
    title: "List workouts",
    description: "List all workouts in the athlete's workout library.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => json(await client.get(`/athlete/${client.athleteId}/workouts`))
);

server.registerTool(
  "get_workout",
  {
    title: "Get workout",
    description: "Get a specific workout from the library by ID.",
    inputSchema: {
      workout_id: z.string().describe("The workout ID"),
    },
    annotations: READ_ONLY,
  },
  async ({ workout_id }) =>
    json(await client.get(`/athlete/${client.athleteId}/workouts/${workout_id}`))
);

// ── Gear ─────────────────────────────────────────────────────────────────────

server.registerTool(
  "list_gear",
  {
    title: "List gear",
    description: "List all gear (bikes, shoes, etc.) for the athlete.",
    inputSchema: {},
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
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => json(await client.get(`/athlete/${client.athleteId}/routes`))
);

server.registerTool(
  "get_route",
  {
    title: "Get route",
    description: "Get a specific route by ID.",
    inputSchema: {
      route_id: z.string().describe("The route ID"),
    },
    annotations: READ_ONLY,
  },
  async ({ route_id }) =>
    json(await client.get(`/athlete/${client.athleteId}/routes/${route_id}`))
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
