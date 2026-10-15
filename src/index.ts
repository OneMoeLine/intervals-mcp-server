import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IntervalsClient } from "./api.js";

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

/** Validate dates up front so a malformed value fails with an actionable
 *  message instead of a confusing 422 from the API. */
const isoDate = (description: string) =>
  z
    .string()
    .regex(DATE_RE, "Must be a date in YYYY-MM-DD format")
    .describe(description);

const isoDateTime = (description: string) =>
  z
    .string()
    .regex(DATETIME_RE, "Must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS")
    .describe(description);

/** A 1-10 subjective wellness score. */
const score = (description: string) =>
  z.number().min(1).max(10).optional().describe(description);

/** Default samples per stream channel. A long ride is tens of thousands of
 *  samples across ~8 channels, which would otherwise exhaust the caller's
 *  context in a single tool call. */
const DEFAULT_STREAM_POINTS = 500;

/** Evenly spaced subsample that always keeps the first and last points. */
function decimate<T>(values: T[], maxPoints: number): T[] {
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
function downsampleStreams(data: unknown, maxPoints: number): unknown {
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

// ── Athlete ───────────────────────────────────────────────────────────────────

server.tool(
  "get_athlete",
  "Get the athlete profile including sport settings, fitness metrics, and account info.",
  {},
  async () => json(await client.get(`/athlete/${client.athleteId}`))
);

server.tool(
  "get_athlete_profile",
  "Get public profile info for the athlete (name, bio, location, etc.).",
  {},
  async () => json(await client.get(`/athlete/${client.athleteId}/profile`))
);

// ── Activities ────────────────────────────────────────────────────────────────

server.tool(
  "list_activities",
  "List activities for a date range. Returns summary data for each activity.",
  {
    oldest: isoDate("Start date in YYYY-MM-DD format (inclusive)"),
    newest: isoDate("End date in YYYY-MM-DD format (inclusive)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Maximum number of activities to return"),
  },
  async ({ oldest, newest, limit }) => {
    const params: Record<string, string> = { oldest, newest };
    if (limit !== undefined) params.limit = String(limit);
    return json(
      await client.get(`/athlete/${client.athleteId}/activities`, params)
    );
  }
);

server.tool(
  "get_activity",
  "Get detailed information about a specific activity by its ID.",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) => json(await client.get(`/activity/${activity_id}`))
);

server.tool(
  "search_activities",
  "Search for activities by name or tag.",
  {
    query: z.string().describe("Search query (name or tag)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Maximum number of results (the API returns 30 by default)"),
  },
  async ({ query, limit }) => {
    const params: Record<string, string> = { q: query };
    if (limit !== undefined) params.limit = String(limit);
    return json(
      await client.get(`/athlete/${client.athleteId}/activities/search`, params)
    );
  }
);

server.tool(
  "get_activity_intervals",
  "Get the lap/interval breakdown for an activity.",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) =>
    json(await client.get(`/activity/${activity_id}/intervals`))
);

server.tool(
  "get_activity_streams",
  "Get time-series data streams for an activity (power, HR, cadence, speed, altitude, GPS, etc.). " +
    "Streams are large, so each channel is downsampled to " +
    `${DEFAULT_STREAM_POINTS} evenly spaced points by default. ` +
    "Pass types to fetch only the channels you need, and raise max_points only when you " +
    "genuinely need finer resolution.",
  {
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
  async ({ activity_id, types, max_points }) => {
    const params: Record<string, string> = {};
    if (types && types.length > 0) params.types = types.join(",");
    const data = await client.get(`/activity/${activity_id}/streams`, params);
    return json(downsampleStreams(data, max_points ?? DEFAULT_STREAM_POINTS));
  }
);

server.tool(
  "get_activity_power_curve",
  "Get the mean maximal power curve for a specific activity.",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) =>
    json(await client.get(`/activity/${activity_id}/power-curve`))
);

server.tool(
  "get_activity_best_efforts",
  "Find best efforts (e.g. fastest 1km, peak 20-min power) within an activity.",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) =>
    json(await client.get(`/activity/${activity_id}/best-efforts`))
);

server.tool(
  "get_activity_weather",
  "Get the weather summary for an activity.",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) =>
    json(await client.get(`/activity/${activity_id}/weather-summary`))
);

// ── Power & Performance ───────────────────────────────────────────────────────

server.tool(
  "get_power_curves",
  "Get the athlete's best mean maximal power curves across all activities. Optionally filter by date range and sport type.",
  {
    oldest: isoDate("Start date YYYY-MM-DD").optional(),
    newest: isoDate("End date YYYY-MM-DD").optional(),
    type: z
      .string()
      .optional()
      .describe("Sport type filter e.g. Ride, Run, Swim (leave blank for all)"),
  },
  async ({ oldest, newest, type }) => {
    const params: Record<string, string> = {};
    if (oldest) params.oldest = oldest;
    if (newest) params.newest = newest;
    if (type) params.type = type;
    return json(
      await client.get(`/athlete/${client.athleteId}/power-curves`, params)
    );
  }
);

// ── Wellness ──────────────────────────────────────────────────────────────────

server.tool(
  "list_wellness",
  "List wellness records for a date range. Includes HRV, resting HR, sleep, weight, mood, etc.",
  {
    oldest: isoDate("Start date YYYY-MM-DD"),
    newest: isoDate("End date YYYY-MM-DD"),
  },
  async ({ oldest, newest }) =>
    json(
      await client.get(`/athlete/${client.athleteId}/wellness`, {
        oldest,
        newest,
      })
    )
);

server.tool(
  "get_wellness",
  "Get the wellness record for a specific date.",
  {
    date: isoDate("Date in YYYY-MM-DD format"),
  },
  async ({ date }) =>
    json(await client.get(`/athlete/${client.athleteId}/wellness/${date}`))
);

server.tool(
  "update_wellness",
  "Update the wellness record for a specific date. Only supply the fields you want to change.",
  {
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

server.tool(
  "list_events",
  "List events on the athlete's training calendar for a date range.",
  {
    oldest: isoDate("Start date YYYY-MM-DD"),
    newest: isoDate("End date YYYY-MM-DD"),
  },
  async ({ oldest, newest }) =>
    json(
      await client.get(`/athlete/${client.athleteId}/events`, { oldest, newest })
    )
);

server.tool(
  "get_event",
  "Get a specific calendar event by ID.",
  {
    event_id: z.string().describe("The event ID"),
  },
  async ({ event_id }) =>
    json(await client.get(`/athlete/${client.athleteId}/events/${event_id}`))
);

server.tool(
  "create_event",
  "Create an event on the athlete's training calendar (planned workout, race, note, etc.).",
  {
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

server.tool(
  "list_workouts",
  "List all workouts in the athlete's workout library.",
  {},
  async () => json(await client.get(`/athlete/${client.athleteId}/workouts`))
);

server.tool(
  "get_workout",
  "Get a specific workout from the library by ID.",
  {
    workout_id: z.string().describe("The workout ID"),
  },
  async ({ workout_id }) =>
    json(await client.get(`/athlete/${client.athleteId}/workouts/${workout_id}`))
);

// ── Gear ─────────────────────────────────────────────────────────────────────

server.tool(
  "list_gear",
  "List all gear (bikes, shoes, etc.) for the athlete.",
  {},
  async () => json(await client.get(`/athlete/${client.athleteId}/gear`))
);

// ── Routes ────────────────────────────────────────────────────────────────────

server.tool(
  "list_routes",
  "List saved routes for the athlete.",
  {},
  async () => json(await client.get(`/athlete/${client.athleteId}/routes`))
);

server.tool(
  "get_route",
  "Get a specific route by ID.",
  {
    route_id: z.string().describe("The route ID"),
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
