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

// ── Athlete ───────────────────────────────────────────────────────────────────

server.tool(
  "get_athlete",
  "Get the athlete profile including sport settings, fitness metrics, and account info.",
  {},
  async () => {
    const data = await client.get(`/athlete/${client.athleteId}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_athlete_profile",
  "Get public profile info for the athlete (name, bio, location, etc.).",
  {},
  async () => {
    const data = await client.get(`/athlete/${client.athleteId}/profile`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Activities ────────────────────────────────────────────────────────────────

server.tool(
  "list_activities",
  "List activities for a date range. Returns summary data for each activity.",
  {
    oldest: z
      .string()
      .describe("Start date in YYYY-MM-DD format (inclusive)"),
    newest: z
      .string()
      .describe("End date in YYYY-MM-DD format (inclusive)"),
  },
  async ({ oldest, newest }) => {
    const data = await client.get(`/athlete/${client.athleteId}/activities`, {
      oldest,
      newest,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_activity",
  "Get detailed information about a specific activity by its ID.",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) => {
    const data = await client.get(`/activity/${activity_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "search_activities",
  "Search for activities by name or tag.",
  {
    query: z.string().describe("Search query (name or tag)"),
    max: z
      .number()
      .optional()
      .describe("Maximum number of results (default 20)"),
  },
  async ({ query, max }) => {
    const params: Record<string, string> = { query };
    if (max !== undefined) params.max = String(max);
    const data = await client.get(
      `/athlete/${client.athleteId}/activities/search`,
      params
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_activity_intervals",
  "Get the lap/interval breakdown for an activity.",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) => {
    const data = await client.get(`/activity/${activity_id}/intervals`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_activity_streams",
  "Get time-series data streams for an activity (power, HR, cadence, speed, altitude, GPS, etc.).",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) => {
    const data = await client.get(`/activity/${activity_id}/streams`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_activity_power_curve",
  "Get the mean maximal power curve for a specific activity.",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) => {
    const data = await client.get(`/activity/${activity_id}/power-curve`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_activity_best_efforts",
  "Find best efforts (e.g. fastest 1km, peak 20-min power) within an activity.",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) => {
    const data = await client.get(`/activity/${activity_id}/best-efforts`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_activity_weather",
  "Get the weather summary for an activity.",
  {
    activity_id: z.string().describe("The activity ID"),
  },
  async ({ activity_id }) => {
    const data = await client.get(`/activity/${activity_id}/weather-summary`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Power & Performance ───────────────────────────────────────────────────────

server.tool(
  "get_power_curves",
  "Get the athlete's best mean maximal power curves across all activities. Optionally filter by date range and sport type.",
  {
    oldest: z.string().optional().describe("Start date YYYY-MM-DD"),
    newest: z.string().optional().describe("End date YYYY-MM-DD"),
    type: z
      .string()
      .optional()
      .describe(
        "Sport type filter e.g. Ride, Run, Swim (leave blank for all)"
      ),
  },
  async ({ oldest, newest, type }) => {
    const params: Record<string, string> = {};
    if (oldest) params.oldest = oldest;
    if (newest) params.newest = newest;
    if (type) params.type = type;
    const data = await client.get(
      `/athlete/${client.athleteId}/power-curves`,
      params
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Wellness ──────────────────────────────────────────────────────────────────

server.tool(
  "list_wellness",
  "List wellness records for a date range. Includes HRV, resting HR, sleep, weight, mood, etc.",
  {
    oldest: z.string().describe("Start date YYYY-MM-DD"),
    newest: z.string().describe("End date YYYY-MM-DD"),
  },
  async ({ oldest, newest }) => {
    const data = await client.get(`/athlete/${client.athleteId}/wellness`, {
      oldest,
      newest,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_wellness",
  "Get the wellness record for a specific date.",
  {
    date: z.string().describe("Date in YYYY-MM-DD format"),
  },
  async ({ date }) => {
    const data = await client.get(
      `/athlete/${client.athleteId}/wellness/${date}`
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update_wellness",
  "Update the wellness record for a specific date. Only supply the fields you want to change.",
  {
    date: z.string().describe("Date in YYYY-MM-DD format"),
    weight: z.number().optional().describe("Body weight in kg"),
    restingHR: z.number().optional().describe("Resting heart rate (bpm)"),
    hrv: z.number().optional().describe("HRV score"),
    hrvSDNN: z.number().optional().describe("HRV SDNN (ms)"),
    sleepSecs: z.number().optional().describe("Sleep duration in seconds"),
    sleepScore: z.number().optional().describe("Sleep quality score"),
    sleepTq: z.number().optional().describe("Sleep time in bed quality"),
    mood: z.number().optional().describe("Mood score (1-10)"),
    fatigue: z.number().optional().describe("Fatigue score (1-10)"),
    stress: z.number().optional().describe("Stress score (1-10)"),
    soreness: z.number().optional().describe("Soreness score (1-10)"),
    injury: z.number().optional().describe("Injury score (1-10)"),
    kcalConsumed: z.number().optional().describe("Calories consumed"),
    notes: z.string().optional().describe("Free text notes"),
  },
  async ({ date, ...fields }) => {
    // Remove undefined fields
    const body = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    const data = await client.put(
      `/athlete/${client.athleteId}/wellness/${date}`,
      body
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Calendar Events ───────────────────────────────────────────────────────────

server.tool(
  "list_events",
  "List events on the athlete's training calendar for a date range.",
  {
    oldest: z.string().describe("Start date YYYY-MM-DD"),
    newest: z.string().describe("End date YYYY-MM-DD"),
  },
  async ({ oldest, newest }) => {
    const data = await client.get(`/athlete/${client.athleteId}/events`, {
      oldest,
      newest,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_event",
  "Get a specific calendar event by ID.",
  {
    event_id: z.string().describe("The event ID"),
  },
  async ({ event_id }) => {
    const data = await client.get(
      `/athlete/${client.athleteId}/events/${event_id}`
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create_event",
  "Create an event on the athlete's training calendar (planned workout, race, note, etc.).",
  {
    start_date_local: z
      .string()
      .describe("Start date/time in ISO 8601 format e.g. 2024-06-01T08:00:00"),
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
      .optional()
      .describe("Planned duration in seconds"),
    distance: z.number().optional().describe("Planned distance in meters"),
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

    const data = await client.post(
      `/athlete/${client.athleteId}/events`,
      body
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Workouts Library ──────────────────────────────────────────────────────────

server.tool(
  "list_workouts",
  "List all workouts in the athlete's workout library.",
  {},
  async () => {
    const data = await client.get(`/athlete/${client.athleteId}/workouts`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_workout",
  "Get a specific workout from the library by ID.",
  {
    workout_id: z.string().describe("The workout ID"),
  },
  async ({ workout_id }) => {
    const data = await client.get(
      `/athlete/${client.athleteId}/workouts/${workout_id}`
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Gear ─────────────────────────────────────────────────────────────────────

server.tool(
  "list_gear",
  "List all gear (bikes, shoes, etc.) for the athlete.",
  {},
  async () => {
    const data = await client.get(`/athlete/${client.athleteId}/gear`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Routes ────────────────────────────────────────────────────────────────────

server.tool(
  "list_routes",
  "List saved routes for the athlete.",
  {},
  async () => {
    const data = await client.get(`/athlete/${client.athleteId}/routes`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_route",
  "Get a specific route by ID.",
  {
    route_id: z.string().describe("The route ID"),
  },
  async ({ route_id }) => {
    const data = await client.get(
      `/athlete/${client.athleteId}/routes/${route_id}`
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("Intervals.icu MCP server running on stdio");
});
